// DB side of the "everyone with the dispatch switch on, on every In Progress
// job" rule. The decision itself is pure and lives in crew-auto-assign.ts;
// this file only does the Prisma reads/writes and the fail-soft guarding.
//
// Every export here is:
//   - IDEMPOTENT — it diffs against the project's current crew and connects
//     only the missing ids. `connect` on a many-to-many is itself tolerant of
//     an already-present link, so even a lost race just re-writes the same row.
//   - FAIL-SOFT — errors are caught, logged and swallowed. These run as hooks
//     off a project save / user activation / dispatch-switch toggle, and an
//     auto-assign failure must never fail the save the user actually asked
//     for. Same contract as autoAssignPhasesForEstimate in
//     auto-assign-phases.ts.
//
// Call sites deliberately `void`/`after()` these — never `await` them inside a
// transaction.

import { prisma } from "@/lib/prisma";
import {
    autoAssignStatusWhere,
    crewIdsToConnect,
    isAutoAssignProjectStatus,
    shouldAutoAssignUser,
    shouldRevokeAutoLink,
} from "@/lib/crew-auto-assign";

const LOG = "[crew-auto-assign]";

/**
 * Every user who could possibly qualify — pre-filtered in SQL to the same
 * shape as `isDispatchable` (dispatch-roster.ts) for efficiency; the pure
 * rule in crew-auto-assign.ts is still the source of truth and is re-applied
 * below.
 */
async function loadCandidateUsers() {
    return prisma.user.findMany({
        where: { showOnDispatch: true, status: "ACTIVATED", role: { not: "FINANCE" } },
        select: { id: true, role: true, status: true, showOnDispatch: true },
    });
}

/**
 * Revoke stage for one project: for every ProjectCrewAutoLink row on it where
 * the pair has gone stale — the user is no longer eligible, or `projectEligible`
 * is false (the project itself left the auto-assign statuses) — and the user
 * holds no TaskAssignment on the project, disconnect from Project.crew and
 * delete the auto-link row. Manual connections (no auto-link row) are never
 * touched. Returns the ids revoked — [] is the normal steady state.
 */
async function revokeStaleAutoLinksForProject(projectId: string, projectEligible: boolean): Promise<string[]> {
    const links = await prisma.projectCrewAutoLink.findMany({
        where: { projectId },
        select: {
            userId: true,
            user: { select: { id: true, role: true, status: true, showOnDispatch: true } },
        },
    });
    if (links.length === 0) return [];

    const userIds = links.map((l) => l.userId);
    const withAssignment = await prisma.taskAssignment.findMany({
        where: { userId: { in: userIds }, task: { projectId } },
        select: { userId: true },
        distinct: ["userId"],
    });
    const assignedIds = new Set(withAssignment.map((a) => a.userId));

    const toRevoke = links
        .filter((link) =>
            shouldRevokeAutoLink({
                hasAutoLink: true,
                userEligible: shouldAutoAssignUser(link.user),
                projectEligible,
                hasTaskAssignment: assignedIds.has(link.userId),
            }),
        )
        .map((link) => link.userId);
    if (toRevoke.length === 0) return [];

    await prisma.$transaction([
        prisma.project.update({
            where: { id: projectId },
            data: { crew: { disconnect: toRevoke.map((id) => ({ id })) } },
        }),
        prisma.projectCrewAutoLink.deleteMany({
            where: { projectId, userId: { in: toRevoke } },
        }),
    ]);
    return toRevoke;
}

/**
 * Ensure every eligible user is on this project's crew, if (and only if) the
 * project is "In Progress" — and revoke any now-stale auto-connections
 * (users the sync itself connected who are no longer eligible, or who lost
 * eligibility while the project was still "In Progress") otherwise. Returns
 * the ids actually connected — [] when there was nothing to do, which is the
 * normal steady state. Revocations happen as a side effect (logged by the
 * fail-soft wrapper below) since most callers only care about connects.
 */
export async function syncCrewForProject(projectId: string): Promise<string[]> {
    if (!projectId) return [];
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, status: true, crew: { select: { id: true } } },
    });
    if (!project) return [];

    const projectEligible = isAutoAssignProjectStatus(project.status);
    if (!projectEligible) {
        // The project left the auto-assign statuses — nothing new to connect,
        // but any stale auto-connections on it should unwind.
        const revoked = await revokeStaleAutoLinksForProject(project.id, false);
        if (revoked.length > 0) {
            console.log(`${LOG} revoked ${revoked.length} stale auto-link(s) from project`, projectId);
        }
        return [];
    }

    const users = await loadCandidateUsers();
    const toConnect = crewIdsToConnect(users, project.crew.map((c) => c.id));
    if (toConnect.length > 0) {
        await prisma.$transaction([
            prisma.project.update({
                where: { id: project.id },
                data: { crew: { connect: toConnect.map((id) => ({ id })) } },
            }),
            prisma.projectCrewAutoLink.createMany({
                data: toConnect.map((userId) => ({ projectId: project.id, userId })),
                skipDuplicates: true,
            }),
        ]);
    }

    // Users already on the crew may have gone stale since they were connected
    // (e.g. showOnDispatch flipped off without a project-status write to
    // catch it) — sweep those too.
    const revoked = await revokeStaleAutoLinksForProject(project.id, true);
    if (revoked.length > 0) {
        console.log(`${LOG} revoked ${revoked.length} stale auto-link(s) from project`, projectId);
    }

    return toConnect;
}

/**
 * Fail-soft wrapper for the project hook. Use this from server actions/routes.
 * Never throws, never rejects.
 */
export async function autoAssignCrewForProject(projectId: string): Promise<void> {
    try {
        const connected = await syncCrewForProject(projectId);
        if (connected.length > 0) {
            console.log(`${LOG} connected ${connected.length} user(s) to project`, projectId);
        }
    } catch (e) {
        console.error(`${LOG} failed for project`, projectId, e instanceof Error ? e.message : e);
    }
}

/**
 * Convenience for the status-write call sites: only does the (cheap) work when
 * the value just written is "In Progress". Saves a DB round trip on the far
 * more common non-In-Progress edits.
 */
export async function autoAssignCrewOnStatusChange(
    projectId: string,
    newStatus: string | null | undefined,
): Promise<void> {
    // Always goes through autoAssignCrewForProject → syncCrewForProject, which
    // branches on the current status itself: connects when it's an
    // auto-assign status, revokes stale auto-links when it isn't. `newStatus`
    // is accepted (and ignored beyond this) for compatibility with existing
    // call sites — the authoritative read inside syncCrewForProject is what
    // actually decides.
    void newStatus;
    await autoAssignCrewForProject(projectId);
}

/**
 * Revoke stage for one user: for every ProjectCrewAutoLink row this user
 * holds, on a project where they now lack any TaskAssignment, disconnect
 * from that project's crew and delete the auto-link row. Manual connections
 * (no auto-link row) are never touched. Returns the project ids revoked.
 */
async function revokeStaleAutoLinksForUser(userId: string): Promise<string[]> {
    const links = await prisma.projectCrewAutoLink.findMany({
        where: { userId },
        select: { projectId: true },
    });
    if (links.length === 0) return [];

    const projectIds = links.map((l) => l.projectId);
    const withAssignment = await prisma.taskAssignment.findMany({
        where: { userId, task: { projectId: { in: projectIds } } },
        select: { task: { select: { projectId: true } } },
    });
    const assignedProjectIds = new Set(withAssignment.map((a) => a.task.projectId).filter((id): id is string => !!id));

    const toRevoke = projectIds.filter((id) => !assignedProjectIds.has(id));
    if (toRevoke.length === 0) return [];

    await prisma.$transaction([
        prisma.user.update({
            where: { id: userId },
            data: { assignedProjects: { disconnect: toRevoke.map((id) => ({ id })) } },
        }),
        prisma.projectCrewAutoLink.deleteMany({
            where: { userId, projectId: { in: toRevoke } },
        }),
    ]);
    return toRevoke;
}

/**
 * The other direction: a user's eligibility may just have changed — the Team
 * page toggled `showOnDispatch`, or a role/status change made them eligible
 * or ineligible. If they're eligible, put them on every project that is
 * currently "In Progress" (recording provenance via ProjectCrewAutoLink). If
 * they're not, revoke any of the sync's own connections that have gone
 * stale (see revokeStaleAutoLinksForUser) — a connection the user still
 * needs for a real TaskAssignment, or one that was made by hand, is left
 * alone either way.
 */
export async function syncProjectsForUser(userId: string): Promise<string[]> {
    if (!userId) return [];
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            role: true,
            status: true,
            showOnDispatch: true,
            assignedProjects: { select: { id: true } },
        },
    });
    if (!user) return [];

    if (!shouldAutoAssignUser(user)) {
        const revoked = await revokeStaleAutoLinksForUser(userId);
        if (revoked.length > 0) {
            console.log(`${LOG} revoked user ${userId} from ${revoked.length} stale auto-linked project(s)`);
        }
        return [];
    }

    const already = new Set(user.assignedProjects.map((p) => p.id));
    const inProgress = await prisma.project.findMany({
        where: autoAssignStatusWhere,
        select: { id: true },
    });
    const toConnect = inProgress.map((p) => p.id).filter((id) => !already.has(id));
    if (toConnect.length > 0) {
        await prisma.$transaction([
            prisma.user.update({
                where: { id: user.id },
                data: { assignedProjects: { connect: toConnect.map((id) => ({ id })) } },
            }),
            prisma.projectCrewAutoLink.createMany({
                data: toConnect.map((projectId) => ({ projectId, userId: user.id })),
                skipDuplicates: true,
            }),
        ]);
    }
    return toConnect;
}

/** Fail-soft wrapper for the user hook. Never throws. */
export async function autoAssignProjectsForUser(userId: string): Promise<void> {
    try {
        const connected = await syncProjectsForUser(userId);
        if (connected.length > 0) {
            console.log(`${LOG} connected user ${userId} to ${connected.length} in-progress project(s)`);
        }
    } catch (e) {
        console.error(`${LOG} failed for user`, userId, e instanceof Error ? e.message : e);
    }
}

/**
 * Same as above but skips the DB read entirely unless the write that just
 * happened could plausibly have changed the user's eligibility (role,
 * status, and/or showOnDispatch touched, or we don't know). Callers pass
 * what they wrote. Falls through to the authoritative read — inside
 * syncProjectsForUser — for both directions: a write that could make someone
 * eligible (connects) and one that could make them ineligible (revokes any
 * now-stale auto-links). Only a write that provably couldn't move
 * eligibility either way skips the DB round trip.
 */
export async function autoAssignProjectsOnUserChange(
    userId: string,
    changed: { role?: unknown; status?: unknown; showOnDispatch?: unknown } = {},
): Promise<void> {
    const touchedRole = changed.role !== undefined;
    const touchedStatus = changed.status !== undefined;
    const touchedShowOnDispatch = changed.showOnDispatch !== undefined;
    if (!touchedRole && !touchedStatus && !touchedShowOnDispatch) return;
    await autoAssignProjectsForUser(userId);
}
