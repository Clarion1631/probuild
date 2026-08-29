/**
 * Shared rule for who counts as "crew" on the Dispatch board (Available
 * bench, Week grid rows, staffing dots, solid/outlined chips). FIELD_CREW is
 * always dispatchable; MANAGER and ADMIN are included because the owner's
 * managers (e.g. Richard, CJ) also work in the field and must show up as
 * staffing a task when they're assigned to one. FINANCE is never
 * dispatchable — bookkeeper accounts must never be offered as job crew.
 */
export const DISPATCHABLE_ROLES = ["FIELD_CREW", "MANAGER", "ADMIN"] as const;

export function isDispatchable(member: { role: string; status?: string | null }): boolean {
    return (DISPATCHABLE_ROLES as readonly string[]).includes(member.role)
        && (member.status === undefined || member.status === "ACTIVATED");
}
