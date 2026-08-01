// setDecisionOrderInfo (Phase 4 — Selection Order Tracking + Delivery Risk,
// docs/superpowers/plans/2026-07-31-selection-order-tracking.md). Plain
// module, importable directly by e2e specs/the verifier — same DI seam as
// decision-link-actions-core.ts (Phase 3's sibling action), PLUS injectable
// find/write per this plan's explicit spec (Codex review round 1, nit c —
// the sibling file only injects actor/revalidate, but this plan calls for
// find/write too, so the seam/E2E/verifier can exercise the CAS logic
// without a live Prisma call).
import { prisma } from "./prisma";
import { getCurrentUserWithPermissions, canAccessProject } from "./permissions";
import { revalidatePath } from "next/cache";
import { companyTodayAsUtcMidnight } from "./decision-due-date";
import { utcMidnight } from "./date-utils";

export type OrderActor = {
    role: string;
    projectAccess?: { projectId: string }[];
    assignedProjects?: { id: string }[];
} | null;

export type FindDecisionResult = { id: string; projectId: string } | null;
export type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> };
export type UpdateManyResult = { count: number };

export type OrderActionDependencies = {
    getActor?: () => Promise<OrderActor>;
    find?: (decisionId: string) => Promise<FindDecisionResult>;
    write?: (args: UpdateManyArgs) => Promise<UpdateManyResult>;
    revalidate?: (projectId: string) => void;
};

async function defaultGetActor(): Promise<OrderActor> {
    return getCurrentUserWithPermissions();
}

async function defaultFind(decisionId: string): Promise<FindDecisionResult> {
    return prisma.decision.findFirst({
        where: { id: decisionId, deletedAt: null },
        select: { id: true, projectId: true },
    });
}

async function defaultWrite(args: UpdateManyArgs): Promise<UpdateManyResult> {
    return prisma.decision.updateMany(args as Parameters<typeof prisma.decision.updateMany>[0]);
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
 * Any other starting status (e.g. Open) rejects as a CAS conflict — this is
 * the ONLY writer for these three columns; no other action path touches
 * them (see the Decision model comment in schema.prisma, and the
 * deleteDecision defense-in-depth reset).
 *
 * `expectedOrderedAt`/`expectedOrderedBy`/`expectedExpectedArrivalAt` (Codex
 * review round 1, issue 3; round 2, R3 residual) — the THREE order fields
 * the CLIENT last saw and is editing from (all null for a fresh "Decided"
 * -> "Ordered" transition, since a Decided row's order fields are always
 * null). All three are included in the CAS where-clause below, not just
 * orderedAt — comparing orderedAt alone let two forms seeded from the SAME
 * order date last-write-win on orderedBy/expectedArrivalAt (e.g. two staff
 * editing the same Ordered row concurrently, one changing who ordered it,
 * the other changing the ETA, both seeded from the same orderedAt). A
 * stale popover (any of the three fields changed since it was seeded) now
 * fails the CAS instead of silently overwriting what it never actually saw.
 */
export type DecisionOrderInput =
    | {
          kind: "ordered";
          orderedAt: Date;
          orderedBy: OrderedByValue;
          expectedArrivalAt: Date | null;
          expectedOrderedAt: Date | null;
          expectedOrderedBy: OrderedByValue | null;
          expectedExpectedArrivalAt: Date | null;
      }
    | { kind: "received" }
    | { kind: "clear" };

/**
 * Expected failures (bad input, or the CAS not matching current state)
 * RETURN this instead of throwing (Codex review round 1, issue 1) — Next.js
 * redacts thrown Server Action error messages in production builds (see
 * actions.ts's deleteInvoice for the precedent this follows), so a thrown
 * Error here would degrade to a generic message on the popover in prod.
 * Only genuine auth failures (no actor / no project access) and "decision
 * not found" still throw — those aren't actionable feedback a user retries
 * their way out of.
 */
export type DecisionOrderErrorCode = "VALIDATION" | "CAS_CONFLICT";

export type DecisionOrderResult =
    | { ok: true }
    | { ok: false; code: DecisionOrderErrorCode; message: string };

// Sanity bounds (plan: "both within 2020-01-01..+5 years") — not a business
// rule, just a guard against fat-fingered years.
const SANITY_MIN_DATE = new Date("2020-01-01T00:00:00.000Z");

/**
 * Exact company-today + 5 years (Codex review round 1, issue 8) — the prior
 * version anchored to Dec 31 of (currentYear + 5), which accepted up to ~5
 * extra months beyond a true 5-year window depending on when in the year
 * it's called.
 */
function sanityMaxDate(today: Date): Date {
    return new Date(Date.UTC(today.getUTCFullYear() + 5, today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999));
}

function dateOutOfSanityRange(d: Date, today: Date): boolean {
    if (Number.isNaN(d.getTime())) return true;
    return d.getTime() < SANITY_MIN_DATE.getTime() || d.getTime() > sanityMaxDate(today).getTime();
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
): Promise<DecisionOrderResult> {
    const actor = await (deps.getActor ?? defaultGetActor)();
    if (!actor) throw new Error("Forbidden");

    const decision = await (deps.find ?? defaultFind)(decisionId);
    if (!decision) throw new Error("Decision not found");
    if (!canAccessProject(actor, decision.projectId)) throw new Error("Forbidden");

    const write = deps.write ?? defaultWrite;

    switch (input.kind) {
        case "ordered": {
            if (input.orderedBy !== "TEAM" && input.orderedBy !== "CLIENT") {
                return { ok: false, code: "VALIDATION", message: "Who ordered it must be GTR team or Client." };
            }

            // Server-side UTC-midnight normalization (Codex review round 1,
            // issue 7) — never trust the caller to have already anchored
            // these to midnight; normalize here, unconditionally, before any
            // validation or write.
            const orderedAt = utcMidnight(input.orderedAt);
            const expectedArrivalAt = input.expectedArrivalAt ? utcMidnight(input.expectedArrivalAt) : null;
            const expectedOrderedAt = input.expectedOrderedAt ? utcMidnight(input.expectedOrderedAt) : null;
            const expectedOrderedBy = input.expectedOrderedBy ?? null;
            const expectedExpectedArrivalAt = input.expectedExpectedArrivalAt ? utcMidnight(input.expectedExpectedArrivalAt) : null;

            // Company-local "today" (decision-due-date.ts's
            // companyTodayAsUtcMidnight): a raw UTC `new Date()` has already
            // rolled to tomorrow for most of the Pacific evening, which
            // would wrongly reject a same-day order placed at 5pm as "in the
            // future". Computed once and reused for both the future-date
            // check and the sanity bound below.
            const today = companyTodayAsUtcMidnight(new Date());

            if (dateOutOfSanityRange(orderedAt, today)) {
                return { ok: false, code: "VALIDATION", message: "Order date is outside the allowed range (2020 through 5 years from now)." };
            }

            const maxOrderedAt = new Date(today.getTime() + 24 * 60 * 60 * 1000); // today + 1 day tolerance
            if (orderedAt.getTime() > maxOrderedAt.getTime()) {
                return { ok: false, code: "VALIDATION", message: "Order date can't be more than a day in the future." };
            }

            if (expectedArrivalAt) {
                if (dateOutOfSanityRange(expectedArrivalAt, today)) {
                    return { ok: false, code: "VALIDATION", message: "Expected arrival date is outside the allowed range (2020 through 5 years from now)." };
                }
                if (expectedArrivalAt.getTime() < orderedAt.getTime()) {
                    return { ok: false, code: "VALIDATION", message: "Expected arrival can't be before the order date." };
                }
            }

            // CAS: status must be Decided (or already Ordered, for edits),
            // AND ALL THREE of the row's current order fields must match
            // what the client's form was seeded from (field-level CAS,
            // issue 3; round 2 R3 — orderedAt alone wasn't enough, see the
            // DecisionOrderInput comment above). Prisma's equality where
            // clause is null-safe: `orderedBy: null` matches IS NULL, same
            // as the Date fields. Catches a stale popover racing a
            // concurrent clear/re-order/edit that a status-only (or
            // orderedAt-only) CAS would miss.
            const updated = await write({
                where: {
                    id: decisionId,
                    deletedAt: null,
                    status: { in: ["Decided", "Ordered"] },
                    orderedAt: expectedOrderedAt,
                    orderedBy: expectedOrderedBy,
                    expectedArrivalAt: expectedExpectedArrivalAt,
                },
                data: { status: "Ordered", orderedAt, orderedBy: input.orderedBy, expectedArrivalAt },
            });
            if (updated.count === 0) {
                return { ok: false, code: "CAS_CONFLICT", message: "This decision's order info just changed — refresh and try again." };
            }
            break;
        }
        case "received": {
            const updated = await write({
                where: { id: decisionId, deletedAt: null, status: "Ordered" },
                data: { status: "Received" },
            });
            if (updated.count === 0) {
                return { ok: false, code: "CAS_CONFLICT", message: "This decision has to be Ordered before it can be marked received — refresh and try again." };
            }
            break;
        }
        case "clear": {
            const updated = await write({
                where: { id: decisionId, deletedAt: null, status: { in: ["Ordered", "Received"] } },
                data: { status: "Decided", orderedAt: null, orderedBy: null, expectedArrivalAt: null },
            });
            if (updated.count === 0) {
                return { ok: false, code: "CAS_CONFLICT", message: "Nothing to clear — this decision isn't Ordered or Received." };
            }
            break;
        }
        default: {
            // Exhaustive switch (Codex review round 1, issue 6) — every
            // known DecisionOrderInput["kind"] is handled above, so this
            // typechecks `input` as `never`. Reachable only if a malformed
            // payload (stale client bundle, hand-crafted call) sends an
            // unrecognized kind — must NOT silently fall through to the
            // clear branch.
            const _exhaustive: never = input;
            void _exhaustive;
            return { ok: false, code: "VALIDATION", message: "Unrecognized order action." };
        }
    }

    (deps.revalidate ?? defaultRevalidate)(decision.projectId);
    return { ok: true };
}
