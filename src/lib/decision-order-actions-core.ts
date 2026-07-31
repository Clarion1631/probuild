// setDecisionOrderInfo (Phase 4 — Selection Order Tracking + Delivery Risk,
// docs/superpowers/plans/2026-07-31-selection-order-tracking.md). Plain
// module, importable directly by e2e specs/the verifier — same DI seam as
// decision-link-actions-core.ts (Phase 3's sibling action).
import { prisma } from "./prisma";
import { getCurrentUserWithPermissions, canAccessProject } from "./permissions";
import { revalidatePath } from "next/cache";
import { companyTodayAsUtcMidnight } from "./decision-due-date";

export type OrderActor = {
    role: string;
    projectAccess?: { projectId: string }[];
    assignedProjects?: { id: string }[];
} | null;

export type OrderActionDependencies = {
    getActor?: () => Promise<OrderActor>;
    revalidate?: (projectId: string) => void;
};

async function defaultGetActor(): Promise<OrderActor> {
    return getCurrentUserWithPermissions();
}

function defaultRevalidate(projectId: string): void {
    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);
}

export type OrderedByValue = "TEAM" | "CLIENT";

/**
 * Union input for the one canonical order-tracking writer — the CAS
 * transition matrix (plan §"Status transitions + order info"):
 *   ordered:  Decided | Ordered  -> Ordered  (marking again edits the fields)
 *   received: Ordered            -> Received
 *   clear:    Ordered | Received -> Decided  (undo path, fields cleared)
 * Any other starting status (e.g. Open) rejects with a "count 0" error —
 * this is the ONLY writer for these three columns; no other action path
 * touches them (see the Decision model comment in schema.prisma).
 */
export type DecisionOrderInput =
    | { kind: "ordered"; orderedAt: Date; orderedBy: OrderedByValue; expectedArrivalAt: Date | null }
    | { kind: "received" }
    | { kind: "clear" };

// Sanity bounds (plan: "both within 2020-01-01..+5 years") — not a business
// rule, just a guard against fat-fingered years.
const SANITY_MIN_DATE = new Date("2020-01-01T00:00:00.000Z");

function sanityMaxDate(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear() + 5, 11, 31, 23, 59, 59, 999));
}

function assertSaneDate(d: Date, label: string): void {
    if (Number.isNaN(d.getTime())) throw new Error(`${label} is not a valid date.`);
    if (d.getTime() < SANITY_MIN_DATE.getTime() || d.getTime() > sanityMaxDate().getTime()) {
        throw new Error(`${label} is outside the allowed range (2020 through 5 years from now).`);
    }
}

/**
 * Staff + canAccessProject — any project staff, same bar as
 * linkDecisionToSchedule (NOT ADMIN/MANAGER-only). Actor resolved BEFORE any
 * lookup (house rule — Codex review round 1, issue 11 precedent on the
 * sibling decision-link-actions-core.ts): an unauthenticated caller is
 * rejected before the decision table is ever queried, so it can never learn
 * whether a decisionId exists.
 */
export async function setDecisionOrderInfo(
    decisionId: string,
    input: DecisionOrderInput,
    deps: OrderActionDependencies = {},
): Promise<{ success: true }> {
    const actor = await (deps.getActor ?? defaultGetActor)();
    if (!actor) throw new Error("Forbidden");

    const decision = await prisma.decision.findFirst({
        where: { id: decisionId, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (!decision) throw new Error("Decision not found");
    if (!canAccessProject(actor, decision.projectId)) throw new Error("Forbidden");

    if (input.kind === "ordered") {
        if (input.orderedBy !== "TEAM" && input.orderedBy !== "CLIENT") {
            throw new Error("orderedBy must be TEAM or CLIENT");
        }
        assertSaneDate(input.orderedAt, "Order date");

        // Company-local "today" (decision-due-date.ts's
        // companyTodayAsUtcMidnight): a raw UTC `new Date()` has already
        // rolled to tomorrow for most of the Pacific evening, which would
        // wrongly reject a same-day order placed at 5pm as "in the future".
        const today = companyTodayAsUtcMidnight(new Date());
        const maxOrderedAt = new Date(today.getTime() + 24 * 60 * 60 * 1000); // today + 1 day tolerance
        if (input.orderedAt.getTime() > maxOrderedAt.getTime()) {
            throw new Error("Order date can't be more than a day in the future.");
        }

        if (input.expectedArrivalAt) {
            assertSaneDate(input.expectedArrivalAt, "Expected arrival date");
            if (input.expectedArrivalAt.getTime() < input.orderedAt.getTime()) {
                throw new Error("Expected arrival can't be before the order date.");
            }
        }

        // CAS: only a Decided (or already Ordered, for edits) decision can
        // be marked ordered.
        const updated = await prisma.decision.updateMany({
            where: { id: decisionId, deletedAt: null, status: { in: ["Decided", "Ordered"] } },
            data: {
                status: "Ordered",
                orderedAt: input.orderedAt,
                orderedBy: input.orderedBy,
                expectedArrivalAt: input.expectedArrivalAt,
            },
        });
        if (updated.count === 0) {
            throw new Error("This decision has to be Decided before it can be marked ordered — refresh and try again.");
        }
    } else if (input.kind === "received") {
        const updated = await prisma.decision.updateMany({
            where: { id: decisionId, deletedAt: null, status: "Ordered" },
            data: { status: "Received" },
        });
        if (updated.count === 0) {
            throw new Error("This decision has to be Ordered before it can be marked received — refresh and try again.");
        }
    } else {
        // clear — undo path, CAS from Ordered/Received back to Decided.
        const updated = await prisma.decision.updateMany({
            where: { id: decisionId, deletedAt: null, status: { in: ["Ordered", "Received"] } },
            data: { status: "Decided", orderedAt: null, orderedBy: null, expectedArrivalAt: null },
        });
        if (updated.count === 0) {
            throw new Error("Nothing to clear — this decision isn't Ordered or Received.");
        }
    }

    (deps.revalidate ?? defaultRevalidate)(decision.projectId);
    return { success: true };
}
