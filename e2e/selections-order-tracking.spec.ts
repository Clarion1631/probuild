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
    taskRisk: `${run}-task-risk`,
    taskShift: `${run}-task-shift`,
} as const;

// Fixed reference date for the linked schedule task used by the risk tests
// below — a stable "D" so ETA-relative-to-D wording assertions never depend
// on when the suite happens to run.
const RISK_TASK_START = new Date("2026-09-01T00:00:00.000Z");
const SHIFT_TASK_START = new Date("2026-09-01T00:00:00.000Z");

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
        await prisma.scheduleTask.create({
            data: { id: ids.taskRisk, projectId: ids.project, name: "Risk Reference Task", startDate: RISK_TASK_START, endDate: new Date("2026-09-05T00:00:00.000Z") },
        });
        await prisma.scheduleTask.create({
            data: { id: ids.taskShift, projectId: ids.project, name: "Shift Reference Task", startDate: SHIFT_TASK_START, endDate: new Date("2026-09-05T00:00:00.000Z") },
        });
    });

    test.afterAll(async () => {
        await prisma.selectionProposal.deleteMany({ where: { projectId: ids.project } });
        await prisma.decision.deleteMany({ where: { projectId: ids.project } });
        await prisma.scheduleTask.deleteMany({ where: { projectId: ids.project } });
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

    // ── UI: the "Mark ordered" popover end to end (Decided -> Ordered ->
    //    edit ETA -> Received -> clear/undo back to Decided) ───────────────

    test("UI: Mark ordered popover marks a Decided decision Ordered; editing the ETA, marking received, and clearing all work from the popover", async ({ page }) => {
        const decision = await makeDecision("ui-order-flow", "Decided");
        const card = page.locator(`#decision-${decision.id}`);

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(card).toBeVisible();

        // Decided -> Ordered
        await card.getByTestId(`mark-ordered-trigger-${decision.id}`).click();
        const popover = page.getByTestId(`order-popover-${decision.id}`);
        await expect(popover).toBeVisible();
        await popover.getByTestId(`order-eta-input-${decision.id}`).fill("2026-08-20");
        await popover.getByTestId(`order-save-${decision.id}`).click();
        await expect(popover).not.toBeVisible();
        await expect(card.getByTestId(`order-status-line-${decision.id}`)).toContainText("Ordered");
        await expect(card.getByTestId(`order-status-line-${decision.id}`)).toContainText("Aug 20");

        // Edit the ETA via the edit-order trigger (Ordered state).
        await card.getByTestId(`edit-order-trigger-${decision.id}`).click();
        await expect(popover).toBeVisible();
        await popover.getByTestId(`order-eta-input-${decision.id}`).fill("2026-08-25");
        await popover.getByTestId(`order-save-${decision.id}`).click();
        await expect(popover).not.toBeVisible();
        await expect(card.getByTestId(`order-status-line-${decision.id}`)).toContainText("Aug 25");

        // Mark received.
        await card.getByTestId(`edit-order-trigger-${decision.id}`).click();
        await popover.getByTestId(`mark-received-${decision.id}`).click();
        await expect(popover).not.toBeVisible();
        await expect(card.getByTestId(`order-status-line-${decision.id}`)).toContainText("Received");

        // Clear/undo — back to Decided, fields nulled, "Mark ordered" trigger
        // reappears.
        await card.getByTestId(`edit-order-trigger-${decision.id}`).click();
        await popover.getByTestId(`order-clear-${decision.id}`).click();
        await expect(popover).not.toBeVisible();
        await expect(card.getByTestId(`mark-ordered-trigger-${decision.id}`)).toBeVisible();
        await expect(card.getByTestId(`order-status-line-${decision.id}`)).toHaveCount(0);

        const finalRow = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(finalRow.status).toBe("Decided");
        expect(finalRow.orderedAt).toBeNull();
        expect(finalRow.expectedArrivalAt).toBeNull();
    });

    // ── Case 2: risk badges + banner (fixture decisions linked to
    //    ids.taskRisk, startDate RISK_TASK_START = 2026-09-01) ─────────────

    async function markOrderedLinkedToRiskTask(name: string, expectedArrivalAt: Date) {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision(name, "Decided");
        await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: new Date("2026-08-01T00:00:00.000Z"), orderedBy: "TEAM", expectedArrivalAt },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        await prisma.decision.update({ where: { id: decision.id }, data: { scheduleTaskId: ids.taskRisk } });
        return decision;
    }

    test("risk: ETA 2 days after the linked task's start shows a red badge with 'after' wording, and the banner lists it", async ({ page }) => {
        const decision = await markOrderedLinkedToRiskTask("case2-late", new Date("2026-09-03T00:00:00.000Z")); // D+2

        await page.goto(`/projects/${ids.project}/selections`);
        const badge = page.getByTestId(`risk-badge-${decision.id}`);
        await expect(badge).toBeVisible();
        await expect(badge).toContainText("2 days after");

        const banner = page.getByTestId("order-risk-banner");
        await expect(banner).toBeVisible();
        await expect(page.getByTestId(`order-risk-banner-item-${decision.id}`)).toBeVisible();
    });

    test("risk: ETA 2 days before the linked task's start shows an amber tight badge", async ({ page }) => {
        const decision = await markOrderedLinkedToRiskTask("case2-tight", new Date("2026-08-30T00:00:00.000Z")); // D-2

        await page.goto(`/projects/${ids.project}/selections`);
        const badge = page.getByTestId(`risk-badge-${decision.id}`);
        await expect(badge).toBeVisible();
        await expect(badge).toContainText("2 days before");
        await expect(page.getByTestId(`order-risk-banner-item-${decision.id}`)).toBeVisible();
    });

    test("risk: ETA 10 days before the linked task's start shows no badge and no banner entry", async ({ page }) => {
        const decision = await markOrderedLinkedToRiskTask("case2-clear", new Date("2026-08-22T00:00:00.000Z")); // D-10

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toHaveCount(0);
        await expect(page.getByTestId(`order-risk-banner-item-${decision.id}`)).toHaveCount(0);
    });

    test("risk: an unlinked decision falls back to its effectiveDueDate (manual override) as the reference", async ({ page }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case2-unlinked-fallback", "Decided");
        // Manual due-date override IS the effectiveDueDate when there's no
        // schedule link — set directly (equivalent to setDecisionDueDateOverride).
        await prisma.decision.update({ where: { id: decision.id }, data: { dueDate: new Date("2026-09-01T00:00:00.000Z") } });
        await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: new Date("2026-08-01T00:00:00.000Z"), orderedBy: "TEAM", expectedArrivalAt: new Date("2026-09-04T00:00:00.000Z") }, // dueDate + 3
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );

        await page.goto(`/projects/${ids.project}/selections`);
        const badge = page.getByTestId(`risk-badge-${decision.id}`);
        await expect(badge).toBeVisible();
        await expect(badge).toContainText("3 days after");
    });

    test("risk: marking a decision Received clears its badge and removes it from the banner", async ({ page }) => {
        const decision = await markOrderedLinkedToRiskTask("case2-then-received", new Date("2026-09-05T00:00:00.000Z")); // D+4, late

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toBeVisible();

        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        await setDecisionOrderInfo(decision.id, { kind: "received" }, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toHaveCount(0);
        await expect(page.getByTestId(`order-risk-banner-item-${decision.id}`)).toHaveCount(0);
    });

    // ── Case 3: schedule shift moves risk (derivation is live, no stale
    //    storage) ────────────────────────────────────────────────────────

    test("schedule shift: pushing the linked task's startDate later turns a red badge into no-risk on reload", async ({ page }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case3-shift", "Decided");
        await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: new Date("2026-08-01T00:00:00.000Z"), orderedBy: "TEAM", expectedArrivalAt: new Date("2026-09-03T00:00:00.000Z") }, // SHIFT_TASK_START + 2
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        await prisma.decision.update({ where: { id: decision.id }, data: { scheduleTaskId: ids.taskShift } });

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toBeVisible();

        // Push the task's startDate 30 days later, directly in the DB —
        // proves the risk is derived live on read, never cached on the
        // decision row.
        await prisma.scheduleTask.update({
            where: { id: ids.taskShift },
            data: { startDate: new Date("2026-10-01T00:00:00.000Z") },
        });

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`risk-badge-${decision.id}`)).toHaveCount(0);
    });

    // ── Case 6 (regression guard): widened Approved Items filter keeps an
    //    Ordered decision listed, not just Decided ────────────────────────

    test("Approved Items keeps an Ordered decision listed (regression guard for the widened status filter)", async ({ page }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await makeDecision("case6-approved-items", "Decided");
        const candidate = await prisma.selectionProposal.create({
            data: { id: `${run}-case6-candidate`, projectId: ids.project, decisionId: decision.id, name: "Case 6 Chosen Faucet", status: "Chosen" },
        });
        await prisma.decision.update({ where: { id: decision.id }, data: { chosenItemId: candidate.id } });
        await setDecisionOrderInfo(
            decision.id,
            { kind: "ordered", orderedAt: new Date("2026-08-01T00:00:00.000Z"), orderedBy: "TEAM", expectedArrivalAt: null },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );

        await page.goto(`/projects/${ids.project}/selections`);
        await expect(page.getByTestId(`approved-item-${candidate.id}`)).toBeVisible();
    });
});
