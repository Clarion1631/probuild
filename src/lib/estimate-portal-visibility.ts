import type { Prisma } from "@prisma/client";

/**
 * The single answer to "may a portal CLIENT see this estimate?".
 *
 * Every client-facing estimate read composes this — the portal detail route, the
 * numeric-number lookup, markEstimateViewed, the portal project list, and the
 * client-message attachment picker. One predicate, one place, so the detail route
 * can never expose something the list hides (the 2026-08-13 review found exactly
 * that divergence: the list filtered Draft out, the detail route filtered nothing).
 *
 * It is deliberately FAIL-CLOSED. The first version of this gate asked
 * `status != 'Draft'`, which is worthless here: `Estimate.status` is free text
 * whose column default is "Sent", so an estimate created and never touched again
 * already claims to be Sent. Prod carried 13 such rows — status "Sent", no
 * sentAt, no invoice, never viewed by anyone. A negative status check let all of
 * them through.
 *
 * So sharing must be POSITIVELY evidenced by one of:
 *   - `sentAt` — the contractor emailed it (sendEstimateToClient stamps this).
 *   - `approvedAt` — the client already signed it.
 *   - an invoice exists — signing auto-creates one, so they are well past it.
 *   - a status that only a post-send transition can produce.
 *
 * "Sent", "Viewed", "Draft" and "Archived" are NOT evidence on their own —
 * "Sent"/"Viewed" must be corroborated by `sentAt`, and a new status added later
 * defaults to hidden rather than exposed.
 *
 * `privacy: "Private"` overrides everything. It is the contractor saying "not for
 * the client", and the portal list has always honoured it.
 */

/** Statuses no code path can reach without the estimate having gone to the client. */
export const POST_SEND_ESTIMATE_STATUSES = [
    "Approved",
    "Invoiced",
    "Partially Paid",
    "Paid",
] as const;

export function portalVisibleEstimateWhere(): Prisma.EstimateWhereInput {
    return {
        privacy: { not: "Private" },
        OR: [
            { sentAt: { not: null } },
            { approvedAt: { not: null } },
            { invoices: { some: {} } },
            { status: { in: [...POST_SEND_ESTIMATE_STATUSES] } },
        ],
    };
}

// There is deliberately no in-memory twin of this predicate. An earlier version
// shipped one and it was already out of lockstep: SQL's three-valued logic makes
// `privacy <> 'Private'` false for a NULL privacy, so the query hides such a row
// while a JavaScript `!== "Private"` check would have shown it. Two copies of an
// authorization rule that disagree on an edge case is how this gate got written
// twice in the first place. Every call site composes the where-clause above.
