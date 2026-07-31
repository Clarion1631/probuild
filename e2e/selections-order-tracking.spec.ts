import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
// Imported from the plain core modules, NOT src/lib/actions.ts — actions.ts
// is a "use server" file that transitively imports "server-only", which is
// not resolvable outside a Next.js build context (see
// e2e/selections-templates-due-dates.spec.ts's identical comment).
import { setDecisionOrderInfo } from "../src/lib/decision-order-actions-core";

const prisma = new PrismaClient();
const run = `selection-order-tracking-${process.pid}-${Date.now()}`;
const ids = {
    client: `${run}-client`,
    project: `${run}-project`,
    admin: `${run}-admin`,
} as const;

// Direct core-module calls run in a bare Node process, not a live Next.js
// request — the real (default) revalidate would throw ("static generation
// store missing"), same as every other Phase 3 core-module e2e spec.
const NOOP_REVALIDATE = () => {};
const clientEmail = `${run}@example.com`;

function makeDecision(name: string, status: string) {
    return prisma.decision.create({
        data: { id: `${run}-${name}`, projectId: ids.project, name, status },
    });
}

test.describe.serial("Selection order tracking + delivery risk", () => {
    test.beforeAll(async () => {
        await prisma.client.create({ data: { id: ids.client, name: "Order Tracking Client", initials: "OT", email: clientEmail } });
        await prisma.project.create({
            data: { id: ids.project, name: "Order Tracking Project", clientId: ids.client, status: "In Progress" },
        });
        await prisma.portalVisibility.create({
            data: { projectId: ids.project, isPortalEnabled: true, showSelections: true },
        });
        await prisma.user.create({
            data: { id: ids.admin, email: `${run}-admin@example.com`, name: "Order Tracking Admin", role: "ADMIN", status: "ACTIVATED" },
        });
    });

    test.afterAll(async () => {
        await prisma.decision.deleteMany({ where: { projectId: ids.project } });
        await prisma.project.deleteMany({ where: { id: ids.project } });
        await prisma.client.deleteMany({ where: { id: ids.client } });
        await prisma.user.deleteMany({ where: { id: ids.admin } });
        await prisma.$disconnect();
    });

    // ── Case 1: full ordered -> edit ETA -> received -> clear lifecycle,
    //    plus the CAS guard against ordering an Open decision ─────────────

    test("marking a Decided decision ordered sets status + fields; editing the ETA persists; marking received retains fields; clearing returns to Decided with fields null", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case1-lifecycle", "Decided");

        const orderedAt = new Date("2026-08-01T00:00:00.000Z");
        const firstEta = new Date("2026-08-15T00:00:00.000Z");
        await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt, orderedBy: "TEAM", expectedArrivalAt: firstEta },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );

        let updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.status).toBe("Ordered");
        expect(updated.orderedAt?.toISOString()).toBe(orderedAt.toISOString());
        expect(updated.orderedBy).toBe("TEAM");
        expect(updated.expectedArrivalAt?.toISOString()).toBe(firstEta.toISOString());

        // Edit ETA — CAS also admits Ordered -> Ordered (re-marking to edit).
        const revisedEta = new Date("2026-08-20T00:00:00.000Z");
        await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt, orderedBy: "CLIENT", expectedArrivalAt: revisedEta },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.status).toBe("Ordered");
        expect(updated.orderedBy).toBe("CLIENT");
        expect(updated.expectedArrivalAt?.toISOString()).toBe(revisedEta.toISOString());

        // Mark received — order fields are KEPT for history.
        await setDecisionOrderInfo(decision.id, { kind: "received" }, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.status).toBe("Received");
        expect(updated.orderedAt?.toISOString()).toBe(orderedAt.toISOString());
        expect(updated.expectedArrivalAt?.toISOString()).toBe(revisedEta.toISOString());

        // Clear — undo path, CAS from Ordered/Received back to Decided, all
        // three fields nulled.
        await setDecisionOrderInfo(decision.id, { kind: "clear" }, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.status).toBe("Decided");
        expect(updated.orderedAt).toBeNull();
        expect(updated.orderedBy).toBeNull();
        expect(updated.expectedArrivalAt).toBeNull();
    });

    test("CAS: marking an Open decision ordered is rejected", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case1-open-reject", "Open");

        await expect(
            setDecisionOrderInfo(
                decision.id,
                { kind: "ordered", orderedAt: new Date(), orderedBy: "TEAM", expectedArrivalAt: null },
                { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
            ),
        ).rejects.toThrow();

        const unchanged = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(unchanged.status).toBe("Open");
        expect(unchanged.orderedAt).toBeNull();
    });

    // ── Case 5: validation — ETA before order date; far-future date ────────

    test("an expected arrival before the order date is rejected", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case5-eta-before-order", "Decided");

        const orderedAt = new Date("2026-08-10T00:00:00.000Z");
        const etaBeforeOrder = new Date("2026-08-05T00:00:00.000Z");
        await expect(
            setDecisionOrderInfo(
                decision.id,
                { kind: "ordered", orderedAt, orderedBy: "TEAM", expectedArrivalAt: etaBeforeOrder },
                { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
            ),
        ).rejects.toThrow();

        const unchanged = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(unchanged.status).toBe("Decided");
    });

    test("a far-future expected arrival is rejected (sanity bound)", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case5-far-future", "Decided");

        const today = new Date();
        const orderedAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
        const farFutureEta = new Date("2099-01-01T00:00:00.000Z");
        await expect(
            setDecisionOrderInfo(
                decision.id,
                { kind: "ordered", orderedAt, orderedBy: "TEAM", expectedArrivalAt: farFutureEta },
                { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
            ),
        ).rejects.toThrow();

        const unchanged = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(unchanged.status).toBe("Decided");
    });
});
