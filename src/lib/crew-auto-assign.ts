// Pure rules for "who gets auto-assigned to an In Progress project".
//
// WHY THIS EXISTS: Justin's rule is now "everyone with the dispatch-board
// switch on" — exactly `isDispatchable` in dispatch-roster.ts (showOnDispatch
// true, ACTIVATED, not FINANCE; managers/admins included). Rather than
// sprinkle that predicate across the project-status write path and the user
// role/status/showOnDispatch write paths, the whole decision lives here as a
// pure function with no Prisma / next-auth / next/headers imports, so it can
// be unit-tested for real (same split as access-rules.ts vs permissions.ts).
//
// The DB side — reading users, connecting them to projects, fail-soft error
// handling — lives in crew-auto-assign-sync.ts. This file never touches IO.
//
// WHICH RELATION: this drives `Project.crew` (Prisma relation
// "CrewAssignments", the User[] <-> Project[] join). That is the relation the
// field-facing surfaces already read as "who is on this job" — mobile auth
// (mobile-auth.ts `crew: { some: { id: user.id } }`), the dispatch board
// (DispatchView/DispatchJobCard), client messaging access, and manager job
// crew. `ProjectAccess` is the separate, narrower per-user page-visibility
// grant maintained by the Team Access screen; auto-assigning there would
// silently rewrite an admin-curated ACL. We only widen crew. (Note
// `accessibleProjectIds` in access-rules.ts unions both, so a crew connect
// already grants read access without us touching ProjectAccess.)

import { isDispatchable } from "./dispatch-roster";
import { canonicalProjectStatus, LEGACY_PROJECT_STATUS_MAP } from "./project-status";

/** The one project status that gets automatic crew assignment. */
export const AUTO_ASSIGN_PROJECT_STATUS = "In Progress";

/**
 * Every raw `Project.status` value that counts as "In Progress" for
 * auto-assign purposes: the canonical value itself, plus every legacy value
 * (e.g. "Open", "Active") that `canonicalProjectStatus` maps onto it. Derived
 * from LEGACY_PROJECT_STATUS_MAP so it can't drift from `isAutoAssignProjectStatus`
 * below — a raw Prisma `where: { status: ... }` query needs this list (or the
 * `autoAssignStatusWhere` helper) instead of the bare AUTO_ASSIGN_PROJECT_STATUS
 * constant, or it silently misses legacy-status projects. See
 * crew-auto-assign-sync.ts (syncProjectsForUser) and
 * scripts/sync-crew-to-in-progress.mjs (which mirrors this list in plain JS —
 * see the comment there — since scripts/*.mjs can't import TS).
 */
export const AUTO_ASSIGN_STATUS_VALUES: string[] = [
    AUTO_ASSIGN_PROJECT_STATUS,
    ...Object.entries(LEGACY_PROJECT_STATUS_MAP)
        .filter(([, canonical]) => canonical === AUTO_ASSIGN_PROJECT_STATUS)
        .map(([legacy]) => legacy),
];

/** Prisma `where` fragment selecting every project that counts as In Progress for auto-assign. */
export const autoAssignStatusWhere = { status: { in: AUTO_ASSIGN_STATUS_VALUES } } as const;

export type AutoAssignUser = {
    id: string;
    role: string;
    status?: string | null;
    showOnDispatch: boolean;
};

/**
 * Would this user be auto-assigned to an In Progress project? Exactly the
 * dispatch-roster switch (`isDispatchable`) — no role- or name-specific
 * carve-outs.
 */
export function shouldAutoAssignUser(user: AutoAssignUser): boolean {
    return isDispatchable(user);
}

/** Filter a user set down to those who should be auto-assigned. */
export function selectAutoAssignUsers<T extends AutoAssignUser>(users: T[]): T[] {
    return users.filter((u) => shouldAutoAssignUser(u));
}

/**
 * Does this project status get automatic crew assignment? Legacy inbound
 * values ("Open", "Active" — see LEGACY_PROJECT_STATUS_MAP) canonicalize to
 * "In Progress" and count.
 */
export function isAutoAssignProjectStatus(status: string | null | undefined): boolean {
    if (!status) return false;
    return canonicalProjectStatus(String(status)) === AUTO_ASSIGN_PROJECT_STATUS;
}

/**
 * The ids that still need connecting: everyone eligible, minus whoever is
 * already on the crew. Returning [] is the idempotency guarantee — a second
 * run has nothing to write.
 */
export function crewIdsToConnect(users: AutoAssignUser[], existingCrewIds: Iterable<string>): string[] {
    const existing = new Set(existingCrewIds);
    const ids = selectAutoAssignUsers(users)
        .map((u) => u.id)
        .filter((id) => !!id && !existing.has(id));
    return [...new Set(ids)];
}
