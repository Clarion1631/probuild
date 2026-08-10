import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { cookies } from "next/headers";
import { authOptions } from "@/lib/auth";

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

const ADMIN_ROLES = ["ADMIN", "MANAGER"];

/** ADMIN_ROLES above is module-private — this is the exported check for
 * callers outside permissions.ts (e.g. decision-template-crud-core.ts's
 * "GTR admin" CRUD/override gate) instead of duplicating the role list. */
export function isAdminOrManager(user: { role: string }): boolean {
    return ADMIN_ROLES.includes(user.role);
}

/** Typed marker for the "Unauthorized" errors thrown by the portal access
 * assertions in actions.ts, so callers can detect an auth failure with
 * `instanceof` instead of the fragile `e.message === "Unauthorized"` string
 * match. Message stays exactly "Unauthorized" so any pre-existing string
 * matcher still works — this is additive, not a replacement. Lives here
 * (rather than actions.ts) because actions.ts is a "use server" file and may
 * only export async functions. */
export class PortalAuthError extends Error {
    constructor() {
        super("Unauthorized");
        this.name = "PortalAuthError";
    }
}

// Server-side: get current user with permissions
export async function getCurrentUserWithPermissions() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;

    return getUserWithPermissionsByEmail(session.user.email);
}

export async function canUseDevAuthFallback() {
    if (process.env.NODE_ENV !== "development") return false;
    try {
        const cookieStore = await cookies();
        return !cookieStore.getAll().some(({ name }) =>
            name === "next-auth.session-token"
            || name.startsWith("next-auth.session-token.")
            || name === "__Secure-next-auth.session-token"
            || name.startsWith("__Secure-next-auth.session-token.")
        );
    } catch {
        return false;
    }
}

export async function getUserWithPermissionsByEmail(email: string) {
    const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        include: {
            permissions: true,
            projectAccess: { select: { projectId: true } },
            assignedProjects: { select: { id: true } },
        },
    });

    return user?.status === "DISABLED" ? null : user;
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

// All permission keys (single source of truth)
export const ALL_PERMISSION_KEYS: PermissionKey[] = [
    // Administrative
    "manageTeamMembers", "manageSubs", "manageVendors",
    "companySettings", "costCodesCategories",
    // Project screens
    "schedules", "estimates", "invoices", "contracts",
    "roomDesigner", "changeOrders", "financialReports",
    "timeClock", "dailyLogs", "files", "takeoffs",
    // Leads
    "createLead", "clientCommunication", "leadAccess",
];

// Build a flat permissions object using the same logic as hasPermission()
// Used by the API route to send consistent permissions to the client
export function getEffectivePermissions(
    user: { role: string; permissions?: any | null }
): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const key of ALL_PERMISSION_KEYS) {
        result[key] = hasPermission(user, key);
    }
    return result;
}

type ProjectScopedUser = { role: string; projectAccess?: { projectId: string }[]; assignedProjects?: { id: string }[] };

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

// Default permissions by role (used when no UserPermission record exists)
function getDefaultPermission(role: string, key: PermissionKey): boolean {
    const defaults: Record<string, PermissionKey[]> = {
        FIELD_CREW: ["schedules", "roomDesigner", "timeClock", "dailyLogs", "files", "costCodesCategories"],
        FINANCE: ["estimates", "invoices", "financialReports", "timeClock", "changeOrders", "costCodesCategories"],
        EMPLOYEE: ["schedules", "roomDesigner", "timeClock", "dailyLogs", "files", "costCodesCategories"],
    };

    return (defaults[role] || defaults.EMPLOYEE)?.includes(key) ?? false;
}

// Ensure a user has a permissions record (create with defaults if missing)
export async function ensurePermissions(userId: string) {
    const existing = await prisma.userPermission.findUnique({ where: { userId } });
    if (existing) return existing;

    return prisma.userPermission.create({ data: { userId } });
}

// Role display labels
export const ROLE_LABELS: Record<string, string> = {
    ADMIN: "Admin",
    MANAGER: "Manager",
    FIELD_CREW: "Field Crew",
    FINANCE: "Finance",
};

export const ROLES = Object.keys(ROLE_LABELS);

export const STATUS_LABELS: Record<string, string> = {
    PENDING: "Pending",
    ACTIVATED: "Activated",
    DISABLED: "Disabled",
};

// Permission group labels for the UI
export const PERMISSION_GROUPS = {
    administrative: {
        label: "Administrative Permissions",
        keys: [
            { key: "manageTeamMembers", label: "Manage Team Members" },
            { key: "manageSubs", label: "Manage Subcontractors" },
            { key: "manageVendors", label: "Manage Vendors" },
            { key: "companySettings", label: "Company Settings" },
            { key: "costCodesCategories", label: "Cost Codes & Categories" },
        ],
    },
    projects: {
        label: "Project Permissions",
        keys: [
            { key: "schedules", label: "Schedules" },
            { key: "estimates", label: "Estimates" },
            { key: "invoices", label: "Invoices" },
            { key: "contracts", label: "Contracts" },
            { key: "roomDesigner", label: "Room Designer" },
            { key: "changeOrders", label: "Change Orders" },
            { key: "financialReports", label: "Financial Reports" },
            { key: "timeClock", label: "Time, Expenses, and Rates" },
            { key: "dailyLogs", label: "Daily Logs" },
            { key: "files", label: "Files & Photos" },
            { key: "takeoffs", label: "Takeoffs" },
        ],
    },
    leads: {
        label: "Lead Permissions",
        keys: [
            { key: "createLead", label: "Create Lead" },
            { key: "clientCommunication", label: "Client Communication" },
            { key: "leadAccess", label: "Lead Access" },
        ],
    },
};
