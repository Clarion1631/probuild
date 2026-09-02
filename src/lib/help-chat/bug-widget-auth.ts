// Who may file a bug report / feature request from the help widget.
//
// Phase 5 G5: this used to be ADMIN-only and session-only, which meant the
// people who actually hit the bugs — the crew, on their phones — had no way to
// report one. Any ACTIVATED staff account can now file, from the web or from
// the app's Bearer token.
//
// Pure (no prisma, no next-auth) so the whole matrix can be tested directly:
// the routes hand it whatever authenticateMobileOrSession returned.

export const BUG_WIDGET_ROLES = ["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE"] as const;

export type BugWidgetActor = { role: string; status: string } | null | undefined;

export type BugWidgetAuthResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * PENDING is refused as well as DISABLED: a PENDING row is an invitation that
 * was never accepted, so it is not yet a staff member. The check is positive
 * (`status === "ACTIVATED"`), never `status !== "DISABLED"` — a negative check
 * would let every future status value through by default.
 */
export function authorizeBugWidgetUser(user: BugWidgetActor): BugWidgetAuthResult {
    if (!user) return { ok: false, status: 401, error: "Unauthorized" };
    if (user.status !== "ACTIVATED") return { ok: false, status: 403, error: "Account is not active" };
    if (!(BUG_WIDGET_ROLES as readonly string[]).includes(user.role)) {
        return { ok: false, status: 403, error: "Staff access required" };
    }
    return { ok: true };
}
