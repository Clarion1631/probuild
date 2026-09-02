// Who may write a MANUAL time entry, and for whom.
//
// Two holes this closes, both live before Phase 5 review round 14:
//
//  1. The project timeclock actions checked only "can you see this project".
//     `userId` came straight from the request body, so any FIELD_CREW member
//     could post hours — priced from the target's stored rates — against ANY
//     colleague, on any project they could open. Hours are money and job cost;
//     writing them for somebody else is an office act.
//
//  2. deleteTimeEntry had a bare session check and nothing else. Any signed-in
//     account could delete ANY time entry in the system by id, including one on
//     a project they cannot see. It also read the row only to find the project
//     for revalidatePath — the authorization never used it.
//
// The rule: crew write their own hours on projects they can access. Office
// roles (ADMIN / MANAGER / FINANCE) write anyone's. Deletes authorize against
// the row as STORED — its owner and its project — never against ids the caller
// supplied.

import { canAccessProject, canUseDevAuthFallback, getCurrentUserWithPermissions, hasPermission } from "./permissions";
import { prisma } from "./prisma";

/** Roles that may record hours on somebody else's behalf. */
export const OFFICE_TIME_ROLES = ["ADMIN", "MANAGER", "FINANCE"] as const;

export type ManualEntryActor = { id: string; role: string; permissions?: unknown };

export function isOfficeTimeRole(role: string | null | undefined): boolean {
    return !!role && (OFFICE_TIME_ROLES as readonly string[]).includes(role);
}

/** May this actor record hours for `targetUserId`? Their own always; anyone else's only from the office. */
export function canWriteHoursFor(actor: { id: string; role: string }, targetUserId: string): boolean {
    if (actor.id === targetUserId) return true;
    return isOfficeTimeRole(actor.role);
}

/**
 * Gate a manual create/update: the caller must hold `timeClock`, be able to
 * reach the project, and be allowed to write for this person.
 *
 * Returns the actor so callers can apply the $0-rate acknowledgement rule to
 * the same identity, rather than re-reading the session and possibly getting a
 * different answer.
 */
export async function assertManualEntryWrite(
    projectId: string,
    targetUserId: string
): Promise<ManualEntryActor | null> {
    const user = await getCurrentUserWithPermissions();
    // The development fallback stays, exactly as the previous guard had it.
    if (!user && (await canUseDevAuthFallback())) return null;
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    if (user.role !== "FINANCE" && !canAccessProject(user, projectId)) throw new Error("Forbidden");
    if (!targetUserId) throw new Error("A team member is required");
    if (!canWriteHoursFor(user, targetUserId)) {
        throw new Error("You can only record your own hours. Ask a manager to enter time for someone else.");
    }
    return user as ManualEntryActor;
}

/**
 * Gate a manual delete against the STORED row.
 *
 * Everything is authorized from what the database says the row is — its owner
 * and its project — because the caller supplies only an id, and an id proves
 * nothing about what it points at.
 */
export async function assertManualEntryDelete(entryId: string) {
    const user = await getCurrentUserWithPermissions();
    const entry = await prisma.timeEntry.findUnique({
        where: { id: entryId },
        select: {
            id: true, userId: true, projectId: true, startTime: true, endTime: true,
            durationHours: true, laborCost: true, invoiceId: true, invoicedAt: true,
        },
    });
    if (!entry) throw new Error("Not found");

    if (!user && (await canUseDevAuthFallback())) return { entry, actor: null };
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    if (user.role !== "FINANCE" && !canAccessProject(user, entry.projectId)) throw new Error("Forbidden");
    if (!canWriteHoursFor(user, entry.userId)) {
        throw new Error("You can only delete your own time entries.");
    }
    return { entry, actor: user as ManualEntryActor };
}

/** Coded refusal so a client can recognise this case rather than string-matching. */
export const LEGACY_UNIT_ENTRY_CODE = "legacy-unit-entry";

/**
 * A legacy "unit" entry: zero hours carrying a hand-typed cost.
 *
 * The flat-cost entry mode was retired when caller-supplied costs were removed
 * (a server action's arguments are an HTTP body). Rows created by it still
 * exist, and there is no honest way to edit one: the new paths price from
 * hours x stored rate, and these have no hours. Silently repricing one to $0 —
 * which is what "just edit it" would do — destroys a real recorded cost.
 *
 * They are read-only until somebody converts them deliberately.
 */
export function isLegacyUnitEntry(entry: { durationHours: number | null; laborCost: unknown }): boolean {
    const hours = entry.durationHours;
    const hasHours = typeof hours === "number" && Number.isFinite(hours) && hours > 0;
    const cost = entry.laborCost == null ? null : Number(entry.laborCost);
    return !hasHours && cost != null && Number.isFinite(cost) && cost !== 0;
}

export function assertNotLegacyUnitEntry(entry: { durationHours: number | null; laborCost: unknown }): void {
    if (isLegacyUnitEntry(entry)) {
        const error = new Error(
            "This is a legacy flat-cost entry. Editing it would reprice it from hours it does not have — delete it and re-enter the time, or ask Justin to convert it."
        );
        (error as Error & { code?: string }).code = LEGACY_UNIT_ENTRY_CODE;
        throw error;
    }
}

/** Coded refusal for "these hours are already on an invoice". */
export const BILLED_ENTRY_CODE = "billed-entry";

export function isBilledEntry(entry: { invoiceId: string | null; invoicedAt: Date | null }): boolean {
    return !!entry.invoiceId || !!entry.invoicedAt;
}

/**
 * Billed hours are not editable or deletable.
 *
 * Every manual path re-checks this INSIDE its transaction as well (an
 * updateMany/deleteMany with the billing columns in the WHERE): a read taken
 * before the transaction is stale the moment a concurrent invoice run claims
 * the row. This assertion is the one that produces a readable error.
 */
export function assertNotBilledEntry(entry: { invoiceId: string | null; invoicedAt: Date | null }): void {
    if (isBilledEntry(entry)) {
        const error = new Error("Billed time entries cannot be edited or deleted.");
        (error as Error & { code?: string }).code = BILLED_ENTRY_CODE;
        throw error;
    }
}

/** Coded refusal for "this row came from the clock, not from a form". */
export const CLOCK_GENERATED_ENTRY_CODE = "clock-generated-entry";

/**
 * A clock-generated row: one with a real endTime.
 *
 * The manual actions take `durationHours` straight from a form and write it as
 * the paid hours. On a clocked shift that is a lie the rest of the system then
 * believes: startTime/endTime still span the original punch, but durationHours
 * no longer derives from them, so shiftHours, the WA meal deduction and
 * mealOutcome all describe a shift that no longer exists — and the next
 * settlement of that day would silently overwrite the typed number anyway.
 *
 * Clocked time is edited through PATCH /api/time-entries/[id], which moves the
 * punch itself and re-settles the day. These actions refuse it.
 */
export function isClockGeneratedEntry(entry: { endTime: Date | null }): boolean {
    return entry.endTime instanceof Date && !Number.isNaN(entry.endTime.getTime());
}

export function assertNotClockGeneratedEntry(entry: { endTime: Date | null }): void {
    if (isClockGeneratedEntry(entry)) {
        const error = new Error(
            "This entry came from the time clock. Edit the punch itself on the time-entries screen so the shift hours and meal break stay consistent."
        );
        (error as Error & { code?: string }).code = CLOCK_GENERATED_ENTRY_CODE;
        throw error;
    }
}

/**
 * Every row, or none.
 *
 * Runs the SAME three refusals the singular delete does — ownership/project,
 * clocked-row, billed — one row at a time, so the error names the reason
 * instead of the batch quietly shrinking. The bulk path used to FILTER on these
 * conditions and report success for whatever survived, which meant a FIELD_CREW
 * member could select a colleague's clocked punch and be told the whole
 * selection was deleted.
 *
 * Lives here rather than in time-expense-actions.ts because that file is
 * "use server": a bare export there is a live POST endpoint, not a helper.
 */
export function assertBulkDeletable(
    actor: { id: string; role: string; permissions?: unknown },
    entries: Array<{
        projectId: string;
        userId: string;
        endTime: Date | null;
        invoiceId: string | null;
        invoicedAt: Date | null;
    }>,
    canAccess: (actor: { id: string; role: string; permissions?: unknown }, projectId: string) => boolean
): void {
    for (const entry of entries) {
        if (actor.role !== "FINANCE" && !canAccess(actor, entry.projectId)) throw new Error("Forbidden");
        if (!canWriteHoursFor(actor, entry.userId)) {
            throw new Error("You can only delete your own time entries.");
        }
        assertNotClockGeneratedEntry(entry);
        assertNotBilledEntry(entry);
    }
}

/** Hours a human typed. Rejected before anything is priced from them. */
export function assertUsableDuration(durationHours: unknown): number {
    const hours = Number(durationHours);
    if (!Number.isFinite(hours) || hours <= 0) {
        throw new Error("Hours must be a number greater than zero");
    }
    return hours;
}
