// Who may delete a time entry outright (owner decision 2026-08-30):
//   - MANAGER / ADMIN: any entry (unchanged from before).
//   - the entry's OWNER: only while it is still TODAY's entry (company day, judged by
//     the un-editable createdAt — startTime is PATCH-able) and only if nothing
//     downstream references it yet (invoice, QuickBooks time activity). Older or
//     downstream-linked entries need a manager, who leaves their name on the action.
//
// Pure — no I/O — so the route's fast pre-check and the in-transaction re-check in
// src/lib/wa-breaks-db.ts (deleteEntryAndSettleInTx) run the SAME rule, and the rule
// is unit-tested in tests/time-entry-delete-policy.test.ts.
import { toCompanyDayKey } from "@/lib/company-day";

export type DeleteActor = { id: string; role: string };

export type DeleteVictim = {
    userId: string;
    createdAt: Date;
    invoiceId: string | null;
    invoicedAt: Date | null;
    qbTimeActivityId: string | null;
    qbSyncedAt: Date | null;
};

// CLAIM_LOST: the conditional delete removed nothing, yet the row as re-read still
// passes the policy (it changed and changed back, or a concurrent writer is mid-flight).
// Reported honestly as a conflict rather than guessing a reason.
// SIBLING_LOCKED: deleting re-plans the worker's whole day (meal deduction moves, paid
// hours/costs are rewritten on the remaining entries). If ANOTHER entry of that day is
// already invoiced or synced, an owner delete would silently rewrite billed history —
// refuse; a manager handles it.
export type DeleteRefusalCode = "NOT_OWNER" | "NOT_TODAY" | "LOCKED_DOWNSTREAM" | "SIBLING_LOCKED" | "CLAIM_LOST";

export const DELETE_REFUSAL_MESSAGES: Record<DeleteRefusalCode, string> = {
    NOT_OWNER: "You can only delete your own time entries — ask a manager to remove this one",
    NOT_TODAY: "Only today's entries can be deleted here — ask a manager to remove this one",
    LOCKED_DOWNSTREAM: "This entry is already invoiced or synced to QuickBooks — ask a manager to remove it",
    SIBLING_LOCKED: "Another entry from this day is already invoiced or synced — ask a manager to remove this one",
    CLAIM_LOST: "This entry changed while it was being deleted — refresh and try again",
};

export function isPrivilegedDeleter(role: string): boolean {
    return role === "MANAGER" || role === "ADMIN";
}

/**
 * Roles with ANY delete path. The route refuses everyone else before it looks the
 * entry up, so a FINANCE/unknown caller cannot use 404-vs-403 to probe which ids exist.
 */
export function canAttemptDelete(role: string): boolean {
    return isPrivilegedDeleter(role) || role === OWNER_DELETE_ROLE;
}

/** True when an invoice or QuickBooks already references the entry. */
export function isLockedDownstream(victim: Pick<DeleteVictim, "invoiceId" | "invoicedAt" | "qbTimeActivityId" | "qbSyncedAt">): boolean {
    return (
        victim.invoiceId != null
        || victim.invoicedAt != null
        || victim.qbTimeActivityId != null
        || victim.qbSyncedAt != null
    );
}

export type DeleteCheck = { ok: true } | { ok: false; code: DeleteRefusalCode };

/** The one non-privileged role that may take the owner path. Any other (FINANCE, unknown) fails closed. */
export const OWNER_DELETE_ROLE = "FIELD_CREW";

export function checkDeleteAllowed(actor: DeleteActor, victim: DeleteVictim, now: Date = new Date()): DeleteCheck {
    if (isPrivilegedDeleter(actor.role)) return { ok: true };
    // Fail closed (Codex): a role that is neither privileged nor FIELD_CREW — FINANCE
    // today, anything added later — gets no owner-delete by default.
    if (actor.role !== OWNER_DELETE_ROLE) return { ok: false, code: "NOT_OWNER" };
    if (victim.userId !== actor.id) return { ok: false, code: "NOT_OWNER" };
    if (toCompanyDayKey(victim.createdAt) !== toCompanyDayKey(now)) return { ok: false, code: "NOT_TODAY" };
    if (isLockedDownstream(victim)) return { ok: false, code: "LOCKED_DOWNSTREAM" };
    return { ok: true };
}

/** Thrown inside the delete transaction when the owner's claim is refused — the transaction rolls back, nothing is deleted. */
export class DeleteRefusedError extends Error {
    readonly code: DeleteRefusalCode;
    constructor(code: DeleteRefusalCode) {
        super(DELETE_REFUSAL_MESSAGES[code]);
        this.name = "DeleteRefusedError";
        this.code = code;
    }
}

const REFUSAL_CODES: ReadonlySet<string> = new Set<DeleteRefusalCode>(["NOT_OWNER", "NOT_TODAY", "LOCKED_DOWNSTREAM", "SIBLING_LOCKED", "CLAIM_LOST"]);

/**
 * Duck-typed check — NOT `instanceof`. Source files import this module through the
 * `@/lib/...` alias while tests import it relatively; under tsx in CI those resolve to
 * two module instances with two class identities, and `instanceof` failed every
 * `catch` (Codex gate, PR #436). name + code is stable across module copies.
 */
export function isDeleteRefusedError(error: unknown): error is DeleteRefusedError {
    if (error instanceof DeleteRefusedError) return true;
    if (typeof error !== "object" || error === null) return false;
    const e = error as { name?: unknown; code?: unknown };
    return e.name === "DeleteRefusedError" && typeof e.code === "string" && REFUSAL_CODES.has(e.code);
}
