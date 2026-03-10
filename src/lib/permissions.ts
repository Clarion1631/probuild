import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

export type PermissionKey =
    // Administrative
    | "manageTeamMembers" | "manageSubs" | "manageVendors"
    | "companySettings" | "costCodesCategories"
    // Project screens
    | "schedules" | "estimates" | "invoices" | "contracts"
    | "floorPlans" | "changeOrders" | "financialReports"
    | "timeClock" | "dailyLogs" | "files" | "takeoffs"
    // Leads
    | "createLead" | "clientCommunication" | "leadAccess";

const ADMIN_ROLES = ["ADMIN", "MANAGER"];

// Server-side: get current user with permissions
export async function getCurrentUserWithPermissions() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        include: {
            permissions: true,
            projectAccess: { select: { projectId: true } },
        },
    });

    return user;
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

// Check if user can access a specific project
export function canAccessProject(
    user: { role: string; projectAccess?: { projectId: string }[] },
    projectId: string
): boolean {
    // Admins and Managers see all projects
    if (ADMIN_ROLES.includes(user.role)) return true;

    // Check project access list
    if (!user.projectAccess) return false;
    return user.projectAccess.some(pa => pa.projectId === projectId);
}

// Default permissions by role (used when no UserPermission record exists)
function getDefaultPermission(role: string, key: PermissionKey): boolean {
    const defaults: Record<string, PermissionKey[]> = {
        FIELD_CREW: ["schedules", "floorPlans", "timeClock", "dailyLogs", "files", "costCodesCategories"],
        FINANCE: ["estimates", "invoices", "financialReports", "timeClock", "changeOrders", "costCodesCategories"],
        EMPLOYEE: ["schedules", "floorPlans", "timeClock", "dailyLogs", "files", "costCodesCategories"],
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
            { key: "floorPlans", label: "3D Floor Plans" },
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
