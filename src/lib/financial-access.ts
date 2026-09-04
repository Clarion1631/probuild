// WHO MAY ACT ON MONEY: payroll, pay rates, and the integrations that carry
// money and hours out of this system.
//
// THE HOLE (round 15, finding 1 — a P0). Every gate on this surface asked the
// same two-part question:
//
//     user.role === "ADMIN" || hasPermission(user, "financialReports")
//
// which authorizes ANY role that carries the permission. `financialReports` is
// in ASSIGNABLE_PERMISSIONS, so an admin can grant it — and nothing stopped it
// being granted to a portal CLIENT. A customer with that one checkbox could
// then read the whole company's pay rates, download the Gusto export, mutate
// rates through the payroll actions, and reconfigure the Gusto and QuickBooks
// integrations, including their OAuth credentials.
//
// Round 8 fixed the same class of bug for the SUBJECT of a payroll record ("a
// customer cannot be given a pay rate") and round 14 for a Gusto MAPPING KEY.
// This is the VIEWER half, and it was the one that mattered most.
//
// The answer is one predicate, in one file, and every gate on the surface
// composes it: a payroll actor must be STAFF (an allowlist of roles, not
// `!== "CLIENT"`) AND carry the authority. Both halves, always.

import { hasPermission } from "./access-rules";
import { isPayrollEligibleRole } from "./payroll-config";

/** The permission that confers financial authority. Named once. */
export const FINANCIAL_PERMISSION = "financialReports" as const;

/**
 * THE decision, over an already-resolved permission answer.
 *
 * Split out from `canActOnFinancials` below because the Gusto export endpoint
 * is a dependency-injected handler: its `authenticate` returns the permission
 * verdict rather than a user row, so it cannot call the row-shaped version. It
 * calls this, which IS the row-shaped version's body — one rule, two entry
 * points, no chance of the endpoint and the panel disagreeing.
 */
export function canActOnFinancialsResolved(
    role: string | null | undefined,
    hasFinancialPermission: boolean,
    status?: string | null
): boolean {
    // STAFF FIRST. A CLIENT holding the permission fails here, which is the
    // whole point: the permission grants authority WITHIN the company, it does
    // not make a customer an employee.
    if (!isPayrollEligibleRole(role)) return false;
    // ...and the account has to be LIVE. getUserWithPermissionsByEmail drops a
    // DISABLED user, so nothing on this surface ever asked about status again —
    // which left PENDING, the status every create in this app produces and the
    // one an admin revoking access by resetting somebody produces too, holding
    // every financial capability it had (round 17, P1).
    //
    // POSITIVE, and `undefined` passes: the DI'd export handler resolves a
    // verdict rather than a row and has no status to give, so the two entry
    // points below supply it and a caller that genuinely cannot is not silently
    // downgraded. Every real caller supplies it.
    if (status !== undefined && status !== null && status !== "ACTIVATED") return false;
    return role === "ADMIN" || hasFinancialPermission;
}

/** THE decision, over a user row with its permissions loaded. */
export function canActOnFinancials(
    user: { role: string; status?: string | null; permissions?: unknown } | null | undefined
): boolean {
    if (!user) return false;
    return canActOnFinancialsResolved(
        user.role,
        hasPermission(user as never, FINANCIAL_PERMISSION),
        // A row always has one. `?? "ACTIVATED"` is NOT a default for the real
        // thing — Prisma's User.status is non-null — it is for the hand-built
        // objects a few callers pass (`{ role, permissions }` for a pay-visibility
        // decision), which have already been through a gate that dropped
        // non-live accounts.
        user.status ?? "ACTIVATED"
    );
}

/**
 * The session-reading gate, for a route handler.
 *
 *   const gate = await requireFinancialStaff();
 *   if ("response" in gate) return gate.response;
 *
 * 401 for no session, 403 for a session that may not act — the same two
 * answers every one of these endpoints already gave.
 */
export async function requireFinancialStaff(): Promise<
    { viewer: { id: string; role: string } } | { response: Response }
> {
    const { NextResponse } = await import("next/server");
    const { getCurrentUserWithPermissions } = await import("./permissions");
    const user = await getCurrentUserWithPermissions();
    if (!user) {
        return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    if (!canActOnFinancials(user)) {
        return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { viewer: { id: user.id, role: user.role } };
}

/** True when this viewer may see or change anything on this surface. For server components. */
export async function canAccessFinancials(): Promise<boolean> {
    const { getCurrentUserWithPermissions } = await import("./permissions");
    return canActOnFinancials(await getCurrentUserWithPermissions());
}
