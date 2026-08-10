/**
 * Pure access rules — no imports, no database, no session.
 *
 * These used to live in permissions.ts, which pulls in Prisma, next-auth and
 * next/headers. That made the rules impossible to test behaviourally: a spec
 * could only grep their source for tokens, which passes just as happily against
 * a gutted implementation. Everything here is a plain function of its arguments,
 * so e2e/estimate-scope-rules.spec.ts can import it and check the actual
 * decisions against a truth table.
 *
 * permissions.ts re-exports all of these, so existing callers are unchanged.
 */

export type PermissionKey =
    // Administrative
    | "manageTeamMembers" | "manageSubs" | "manageVendors"
    | "companySettings" | "costCodesCategories"
    // Project screens
    | "schedules" | "estimates" | "invoices" | "contracts"
    | "roomDesigner" | "changeOrders" | "financialReports"
    | "timeClock" | "dailyLogs" | "files" | "takeoffs"
    // Leads
    | "createLead" | "clientCommunication" | "leadAccess";

export const ADMIN_ROLES = ["ADMIN", "MANAGER"];

export function isAdminOrManager(user: { role: string }): boolean {
    return ADMIN_ROLES.includes(user.role);
}

// Default permissions by role (used when no UserPermission record exists)
function getDefaultPermission(role: string, key: PermissionKey): boolean {
    const defaults: Record<string, PermissionKey[]> = {
        FIELD_CREW: ["schedules", "roomDesigner", "timeClock", "dailyLogs", "files", "costCodesCategories"],
        FINANCE: ["estimates", "invoices", "financialReports", "timeClock", "changeOrders", "costCodesCategories"],
        EMPLOYEE: ["schedules", "roomDesigner", "timeClock", "dailyLogs", "files", "costCodesCategories"],
    };

    return (defaults[role] || defaults.EMPLOYEE)?.includes(key) ?? false;
}

// Check if user has a specific permission
export function hasPermission(
    user: { role: string; permissions?: any | null },
    key: PermissionKey
): boolean {
    // Admins and Managers always have full access
    if (ADMIN_ROLES.includes(user.role)) return true;

    // If no permissions record, use defaults based on role
    if (!user.permissions) {
        return getDefaultPermission(user.role, key);
    }

    return !!user.permissions[key];
}

export type ProjectScopedUser = {
    role: string;
    permissions?: any | null;
    projectAccess?: { projectId: string }[];
    assignedProjects?: { id: string }[];
};

/**
 * The set form of canAccessProject: every project id this user may reach, or
 * "ALL" for the roles that pass unconditionally. Exists so a list query can be
 * filtered by exactly the same rule that canAccessProject() applies to a single
 * id — a second hand-rolled predicate is how a list and its detail page drift
 * apart. Invariant: canAccessProject(u, p) === (ids === "ALL" || ids.includes(p)).
 */
export function accessibleProjectIds(user: ProjectScopedUser): string[] | "ALL" {
    if (ADMIN_ROLES.includes(user.role)) return "ALL";
    return Array.from(new Set([
        ...(user.projectAccess ?? []).map(pa => pa.projectId),
        ...(user.assignedProjects ?? []).map(p => p.id),
    ]));
}

// Check if user can access a specific project
export function canAccessProject(user: ProjectScopedUser, projectId: string): boolean {
    const ids = accessibleProjectIds(user);
    return ids === "ALL" || ids.includes(projectId);
}

/** What an estimate hangs off. Both columns are optional in the schema. */
export type EstimateOwner = { projectId?: string | null; leadId?: string | null };

/**
 * THE estimate scope rule. Both the assertion (assertEstimateScope in
 * actions.ts) and the list filter (estimateScopeWhere below) are defined in
 * terms of this one function, so they cannot answer differently.
 *
 * FINANCE is deliberately NOT exempt the way assertFinancialProjectScope
 * exempts it for company-wide reports — an estimate is a per-job document.
 */
export function canAccessEstimate(user: ProjectScopedUser, scope: EstimateOwner): boolean {
    // Fail CLOSED on an ownerless estimate. "No project and no lead" means there
    // is nothing to check access against, so nobody passes — not even an admin.
    if (!scope.projectId && !scope.leadId) return false;
    // Project ownership wins: a converted estimate carries BOTH ids, and
    // `leadAccess` must not rescue an estimate on a job the user can't reach.
    if (scope.projectId) return canAccessProject(user, scope.projectId);
    return hasPermission(user, "leadAccess");
}

/** Matches no estimate at all. Used where the caller has no accessible scope. */
const MATCHES_NO_ESTIMATE = { id: { in: [] as string[] } };

/** Any estimate attached to something — the filter form of the ownerless check. */
const ATTACHED_TO_AN_OWNER = { OR: [{ projectId: { not: null } }, { leadId: { not: null } }] };

/**
 * The Prisma where-fragment form of canAccessEstimate: the same decision asked
 * of a whole table at once. Every branch mirrors a branch of canAccessEstimate,
 * including the ownerless one — an unattached estimate is filtered out for
 * every role, because canAccessEstimate rejects it for every role.
 *
 * Safe to drop into a top-level `where`, a nested relation `where`, or an
 * `AND: [...]` alongside an id.
 */
export function estimateScopeWhere(user: ProjectScopedUser | null | undefined): any {
    if (!user?.role) return MATCHES_NO_ESTIMATE;

    const projectIds = accessibleProjectIds(user);
    if (projectIds === "ALL") return ATTACHED_TO_AN_OWNER;

    const branches: any[] = [];
    if (projectIds.length > 0) branches.push({ projectId: { in: projectIds } });
    // Mirrors "if (scope.projectId) ... else leadAccess": the lead branch is
    // only reached when there is no project, hence `projectId: null` here.
    if (hasPermission(user, "leadAccess")) branches.push({ projectId: null, leadId: { not: null } });
    if (branches.length === 0) return MATCHES_NO_ESTIMATE;
    return { OR: branches };
}

/**
 * Which document-template TYPES a caller may write.
 *
 * Document templates hold the terms, contract, lien-release, warranty and
 * disclaimer language snapshotted onto client-facing documents when they are
 * sent. `companySettings` owns the whole library. `estimates` is also accepted
 * for writes, but only for the types an estimator's own screens author (the
 * estimate editor's "save as template" and the /estimates Terms & Conditions
 * tab) — /company/templates offers a full type selector, so an unscoped
 * `estimates` grant would let an estimates-only user, which is the FINANCE
 * default, rewrite contract and lien-release language.
 */
export const ESTIMATOR_WRITABLE_TEMPLATE_TYPES = ["terms", "overview", "notes"] as const;

export function canWriteDocumentTemplateType(
    user: { role: string; permissions?: any | null },
    type: string | null | undefined
): boolean {
    if (hasPermission(user, "companySettings")) return true;
    if (!hasPermission(user, "estimates")) return false;
    return !!type && (ESTIMATOR_WRITABLE_TEMPLATE_TYPES as readonly string[]).includes(type);
}
