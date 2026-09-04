// Who may file a bug report / feature request from the help widget.
//
// Phase 5 G5: this used to be ADMIN-only and session-only, which meant the
// people who actually hit the bugs — the crew, on their phones — had no way to
// report one. Any ACTIVATED staff account can now file, from the web or from
// the app's Bearer token.
//
// Pure (no prisma, no next-auth) so the whole matrix can be tested directly:
// the routes hand it whatever authenticateMobileOrSession returned.

// EMPLOYEE is a LEGACY role value — absent from ROLE_LABELS/ROLES in
// src/lib/permissions.ts (so nothing creates one now) but still a live branch in
// access-rules.ts and schedule-core.ts, so rows can carry it. Someone stuck on
// an old account must still be able to report the bug that is blocking them.
export const BUG_WIDGET_ROLES = ["ADMIN", "MANAGER", "FIELD_CREW", "EMPLOYEE", "FINANCE"] as const;

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

/**
 * Whether this caller may trigger the "agent-task" pipeline: GitHub Actions
 * watches for that label and hands the issue to Phantom, which then acts on
 * the repo unattended. Every ACTIVATED role above can FILE a bug report — that
 * is the whole point of G5 — but filing one must not, by itself, let ordinary
 * crew kick off an automated agent against the codebase. Only ADMIN/MANAGER
 * can.
 */
export function canTriggerBugWidgetAgent(user: BugWidgetActor): boolean {
    return !!user && (user.role === "ADMIN" || user.role === "MANAGER");
}

/**
 * The labels /api/help-chat/bug-fix files the GitHub issue under. Everyone
 * else's report still becomes a real issue — just routed to a human via
 * needs-triage instead of straight to the agent.
 */
export function bugFixIssueLabels(user: BugWidgetActor): string[] {
    return canTriggerBugWidgetAgent(user) ? ["bug-fix", "agent-task"] : ["bug-fix", "needs-triage"];
}
