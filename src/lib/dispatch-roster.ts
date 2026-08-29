/**
 * Shared rule for who counts as "crew" on the Dispatch board (Available
 * bench, Week grid rows, staffing dots, solid/outlined chips). Membership is
 * a per-user switch the owner controls on the Team page
 * (User.showOnDispatch) — NOT derived from role. FINANCE is guarded off
 * regardless of the flag: bookkeeper accounts must never be offered as job
 * crew, and the Team page never even offers them the switch (belt and
 * braces).
 */
export function isDispatchable(member: { role: string; status?: string | null; showOnDispatch: boolean }): boolean {
    return member.showOnDispatch === true
        && member.role !== "FINANCE"
        && (member.status === undefined || member.status === "ACTIVATED");
}
