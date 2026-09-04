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

/**
 * Who may resolve a QuickBooks invoice create whose outcome is unknown.
 *
 * Deliberately NARROWER than the `invoices` permission: the decision is "did
 * QuickBooks already bill this client?", and getting it wrong either bills them
 * twice or leaves money uncollected. ADMIN and FINANCE only — a MANAGER with
 * full invoice access still does not get this one.
 */
export function canResolveAmbiguousCreate(user: { role: string }): boolean {
    return user.role === "ADMIN" || user.role === "FINANCE";
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
 * The horizontal job-scope rule: given a job's owner (a project or a lead) and
 * a user, does this user's access reach that job? Extracted out of
 * canAccessEstimate because it is not really an estimate rule — it is the
 * ownership check every per-job document (estimates, contracts) is gated by,
 * and canCreateContractFor below needs the exact same decision.
 *
 * Fail CLOSED on an ownerless scope. "No project and no lead" means there is
 * nothing to check access against, so nobody passes — not even an admin.
 * Project ownership wins when both are present: a converted estimate carries
 * BOTH ids, and `leadAccess` must not rescue a document on a job the user
 * can't otherwise reach.
 */
export function canAccessJobScope(user: ProjectScopedUser, scope: EstimateOwner): boolean {
    if (!scope.projectId && !scope.leadId) return false;
    if (scope.projectId) return canAccessProject(user, scope.projectId);
    return hasPermission(user, "leadAccess");
}

/**
 * THE estimate scope rule. Both the assertion (assertEstimateScope in
 * actions.ts) and the list filter (estimateScopeWhere below) are defined in
 * terms of this one function, so they cannot answer differently.
 *
 * FINANCE is deliberately NOT exempt the way assertFinancialProjectScope
 * exempts it for company-wide reports — an estimate is a per-job document.
 * (The ownership decision itself is canAccessJobScope; this is that name kept
 * stable for the estimate call sites that already depend on it.)
 */
export function canAccessEstimate(user: ProjectScopedUser, scope: EstimateOwner): boolean {
    return canAccessJobScope(user, scope);
}

/**
 * Whether this user may create a contract on the given job.
 *
 * Gated on the `contracts` permission, not `estimates` — authoring a binding
 * contract is a distinct capability from estimating a job. Using `estimates`
 * here would both over-grant (FINANCE's role default is `estimates`, not
 * `contracts`) and mislabel the gate: someone who can only estimate a job
 * should not thereby be able to generate its contract.
 */
export function canCreateContractFor(user: ProjectScopedUser, scope: EstimateOwner): boolean {
    return canAccessContract(user, scope);
}

/**
 * Whether this user may read or write an EXISTING contract on the given job.
 *
 * Identical rule to canCreateContractFor by design — reading a contract exposes
 * its legal body, the approval IP/user-agent audit trail, the signature storage
 * paths and the portal `accessToken` that by itself authorizes a client to view
 * AND SIGN the document. That is at least as sensitive as authoring one, so the
 * two share a single decision rather than drifting into "read is looser".
 * Separate NAME so the contract-read call sites read honestly and so the truth
 * table in e2e/financial-action-auth.spec.ts pins both meanings independently.
 */
export function canAccessContract(user: ProjectScopedUser, scope: EstimateOwner): boolean {
    return hasPermission(user, "contracts") && canAccessJobScope(user, scope);
}

/** Matches no contract at all. Used where the caller has no accessible scope. */
const MATCHES_NO_CONTRACT = { id: { in: [] as string[] } };

/**
 * The Prisma where-fragment form of canAccessContract: the same decision asked
 * of the whole Contract table at once, so the list and the detail page cannot
 * answer differently. Every branch mirrors a branch of canAccessContract,
 * including the ownerless one — a contract attached to neither a project nor a
 * lead is filtered out for every role, because canAccessContract rejects it for
 * every role.
 *
 * Unlike estimateScopeWhere this ALSO encodes the vertical permission: a caller
 * without `contracts` matches nothing at all. Safe to drop into a top-level
 * `where` or an `AND: [...]` alongside caller-supplied filters.
 */
export function contractScopeWhere(user: ProjectScopedUser | null | undefined): any {
    if (!user?.role) return MATCHES_NO_CONTRACT;
    if (!hasPermission(user, "contracts")) return MATCHES_NO_CONTRACT;

    const projectIds = accessibleProjectIds(user);
    if (projectIds === "ALL") return ATTACHED_TO_AN_OWNER;

    const branches: any[] = [];
    if (projectIds.length > 0) branches.push({ projectId: { in: projectIds } });
    // Mirrors "if (scope.projectId) ... else leadAccess": the lead branch is
    // only reached when there is no project, hence `projectId: null` here.
    if (hasPermission(user, "leadAccess")) branches.push({ projectId: null, leadId: { not: null } });
    if (branches.length === 0) return MATCHES_NO_CONTRACT;
    return { OR: branches };
}

/**
 * The completeness companion to estimateScopeWhere: given the owners an
 * aggregate was computed over, would the scope filter have dropped any of them?
 *
 * Estimate reads are scoped per caller, but the pages that sum them are not
 * necessarily scoped the same way (the project LIST is company-wide), so a
 * "Total Revenue" card can otherwise sit a partial number under a label that
 * claims completeness. Readers ask this and label themselves honestly instead.
 *
 * Takes OWNERS, not project ids. A bare id list cannot express the difference
 * between "lead-owned" and "attached to nothing", so a null in it would have to
 * mean both — and those two answer differently (leadAccess vs fail-closed).
 * Asking canAccessEstimate per owner makes the invariant hold by construction:
 * complete === "the filter admits every one of these".
 *
 * Deliberately CONSERVATIVE about WHAT the caller passes: a page names the
 * owners its aggregate could have drawn from, not the rows that actually
 * existed. So an inaccessible project holding no matching row still reads as
 * partial. It under-claims, never over-claims — a hedged label on a complete
 * number misleads nobody, the reverse is the bug this exists to prevent.
 */
export function estimateTotalsAreComplete(
    user: ProjectScopedUser | null | undefined,
    owners: readonly EstimateOwner[]
): boolean {
    // No user means the scope filter matched nothing at all, so any non-empty
    // total is partial by definition — and an empty one is not worth claiming.
    if (!user?.role) return false;
    return owners.every(owner => canAccessEstimate(user, owner));
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
