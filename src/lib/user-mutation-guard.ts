// Who may change WHAT about a user account.
//
// Every user-mutating surface had its own idea of this, and three of them had
// none at all. /api/users/[id] let any MANAGER write an arbitrary `role` and
// `status` and upsert an arbitrary permission set; /api/users accepted an
// arbitrary role on create and on PATCH. So a manager could promote themselves
// to ADMIN, grant themselves every permission, or disable and demote the real
// admins — which nullifies every authorization boundary above it, including the
// payroll one this branch is built on (round 9, finding 1).
//
// The mobile manager endpoint already had the right rules. They live here now,
// once, and every writer calls this.

import { ADMIN_ROLES } from "./access-rules";

/** The roles a User row may hold. Same set the schema documents and the manager endpoint validated. */
export const USER_ROLES = ["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE", "CLIENT"] as const;

/** Roles an admin screen may ASSIGN. CLIENT is created by the portal invite flow, never chosen in the team editor. */
export const ASSIGNABLE_USER_ROLES = ["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE"] as const;

export const USER_STATUSES = ["PENDING", "ACTIVATED", "DISABLED"] as const;

/** Every permission key the team editor may write. Mirrors the UserPermission columns. */
export const ASSIGNABLE_PERMISSIONS = [
    "manageTeamMembers", "manageSubs", "manageVendors", "companySettings",
    "costCodesCategories", "schedules", "estimates", "invoices", "contracts",
    "roomDesigner", "changeOrders", "financialReports", "timeClock",
    "dailyLogs", "files", "takeoffs", "autoGrantNewProjects",
] as const;

/**
 * The permissions that confer AUTHORITY rather than access to a document.
 *
 * Only an ADMIN may grant or revoke these:
 *   financialReports  — the gate on payroll, pay rates and the Gusto export;
 *   manageTeamMembers — user management, i.e. the ability to grant the rest;
 *   companySettings   — org configuration, including the integration
 *                       credentials the money rails authenticate with.
 *
 * Deliberately NOT every permission. A manager granting a crew member
 * `schedules` or `files` is delegating something they already hold and is
 * ordinary work; a manager granting anybody the three above is changing who can
 * change the company.
 */
export const PRIVILEGED_PERMISSIONS = ["financialReports", "manageTeamMembers", "companySettings"] as const;

export type UserMutationActor = { id: string; role: string };
export type UserMutationTarget = { id: string; role: string };

export type UserMutationChanges = {
    role?: unknown;
    status?: unknown;
    /** The sanitized permission patch, or null/undefined when the request does not touch permissions. */
    permissions?: Record<string, unknown> | null;
};

export type UserMutationVerdict =
    | { ok: true }
    | { ok: false; status: 400 | 403; error: string };

const has = (list: readonly string[], value: unknown) => typeof value === "string" && list.includes(value);

/**
 * THE decision. Pure, so every route and action can share it and it can be
 * tested exhaustively without a database.
 *
 * `target` is the row being written, re-read by the caller — never the values
 * from the request body, which is what the caller is trying to change.
 *
 * Order matters: shape (400) before authority (403), so a caller is told their
 * enum is wrong rather than that they are forbidden from sending nonsense.
 */
export function checkUserMutation(input: {
    actor: UserMutationActor;
    target: UserMutationTarget;
    changes: UserMutationChanges;
}): UserMutationVerdict {
    const { actor, target, changes } = input;
    const wantsRole = changes.role !== undefined;
    const wantsStatus = changes.status !== undefined;
    const permissionKeys = changes.permissions ? Object.keys(changes.permissions) : [];

    // ---- shape ------------------------------------------------------------
    if (wantsRole && !has(ASSIGNABLE_USER_ROLES, changes.role)) {
        return { ok: false, status: 400, error: `Invalid role: ${String(changes.role)}` };
    }
    if (wantsStatus && !has(USER_STATUSES, changes.status)) {
        return { ok: false, status: 400, error: `Invalid status: ${String(changes.status)}` };
    }
    for (const key of permissionKeys) {
        if (!(ASSIGNABLE_PERMISSIONS as readonly string[]).includes(key)) {
            return { ok: false, status: 400, error: `Unknown permission: ${key}` };
        }
    }

    // ---- authority --------------------------------------------------------
    if (!ADMIN_ROLES.includes(actor.role)) {
        return { ok: false, status: 403, error: "Only managers and admins can change a team member." };
    }
    if (actor.role === "ADMIN") return { ok: true };

    // Everything below is a MANAGER.
    if (target.role === "ADMIN") {
        return { ok: false, status: 403, error: "Only an admin can modify an admin account." };
    }
    if (wantsRole) {
        return { ok: false, status: 403, error: "Only an admin can change a team member's role." };
    }
    if (target.id === actor.id) {
        if (wantsStatus) {
            return { ok: false, status: 403, error: "You cannot change your own status." };
        }
        if (permissionKeys.length > 0) {
            return { ok: false, status: 403, error: "You cannot change your own permissions." };
        }
    }
    const privileged = permissionKeys.filter((key) =>
        (PRIVILEGED_PERMISSIONS as readonly string[]).includes(key)
    );
    if (privileged.length > 0) {
        return {
            ok: false,
            status: 403,
            error: `Only an admin can grant or revoke ${privileged.join(", ")}.`,
        };
    }
    return { ok: true };
}

/**
 * The same decision for a CREATE, where there is no target row yet.
 *
 * A create cannot demote anybody, so the only question is whether the caller may
 * mint the role they asked for. Status is not a parameter: every create path
 * starts a row at PENDING.
 */
export function checkUserCreate(input: { actor: UserMutationActor; role: unknown }): UserMutationVerdict {
    if (input.role !== undefined && !has(ASSIGNABLE_USER_ROLES, input.role)) {
        return { ok: false, status: 400, error: `Invalid role: ${String(input.role)}` };
    }
    if (!ADMIN_ROLES.includes(input.actor.role)) {
        return { ok: false, status: 403, error: "Only managers and admins can add a team member." };
    }
    if (input.role === "ADMIN" && input.actor.role !== "ADMIN") {
        return { ok: false, status: 403, error: "Only an admin can create an admin account." };
    }
    return { ok: true };
}
