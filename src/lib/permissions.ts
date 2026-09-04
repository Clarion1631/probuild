import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { cookies } from "next/headers";
import { authOptions, getSessionOrDev } from "@/lib/auth";

// The pure rules live in access-rules.ts (no Prisma / next-auth / next-headers
// imports) so they can be unit-tested for real. Re-exported here so every
// existing `from "./permissions"` import keeps working unchanged.
export {
    ADMIN_ROLES,
    isAdminOrManager,
    canResolveAmbiguousCreate,
    hasPermission,
    accessibleProjectIds,
    canAccessProject,
    canAccessJobScope,
    canAccessEstimate,
    canCreateContractFor,
    canAccessContract,
    contractScopeWhere,
    estimateScopeWhere,
    estimateTotalsAreComplete,
    canWriteDocumentTemplateType,
    ESTIMATOR_WRITABLE_TEMPLATE_TYPES,
} from "./access-rules";
export type { PermissionKey, ProjectScopedUser, EstimateOwner } from "./access-rules";

import { hasPermission, type PermissionKey } from "./access-rules";

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

/**
 * getCurrentUserWithPermissions plus the development ADMIN fallback that the
 * project/lead layouts and every server action already honour. Lives here
 * rather than in actions.ts because actions.ts is a "use server" module, where
 * exporting it would publish another endpoint; the copy in actions.ts
 * (currentStaffUserOrNull) delegates to this one so the two cannot drift.
 *
 * Server components that scope a query themselves should use THIS, not the
 * bare getCurrentUserWithPermissions — otherwise sessionless local development
 * silently renders an empty list while every surrounding gate lets the dev
 * ADMIN through. Production is unaffected: canUseDevAuthFallback returns false
 * outside NODE_ENV=development.
 */
/**
 * THE staff gate: an active staff session, or throw.
 *
 * It lives here rather than in actions.ts because actions.ts is a
 * `"use server"` module — every export of that file is a REGISTERED SERVER
 * ACTION with its own public id. Exporting a gate helper from there so the
 * other action modules could import it would have created one more remotely
 * dispatchable endpoint, which is the exact class of hole round 49 exists to
 * close. This file is imported normally and exports nothing dispatchable.
 */
export async function assertActiveStaff(): Promise<any> {
    const user = await currentStaffUserOrNull();
    if (!user) throw new Error("Unauthorized");
    return user;
}

export async function currentStaffUserOrNull(): Promise<any | null> {
    const user = await getCurrentUserWithPermissions();
    if (user) return user;

    if (await canUseDevAuthFallback()) {
        const devSession = await getSessionOrDev();
        if ((devSession?.user as { role?: string } | undefined)?.role) return devSession.user;
    }
    return null;
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
