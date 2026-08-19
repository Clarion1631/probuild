// DB side of the "all field crew + CJ on every In Progress job" rule.
// The decision itself is pure and lives in crew-auto-assign.ts; this file only
// does the Prisma reads/writes and the fail-soft guarding.
//
// Every export here is:
//   - IDEMPOTENT — it diffs against the project's current crew and connects
//     only the missing ids. `connect` on a many-to-many is itself tolerant of
//     an already-present link, so even a lost race just re-writes the same row.
//   - FAIL-SOFT — errors are caught, logged and swallowed. These run as hooks
//     off a project save / user activation, and an auto-assign failure must
//     never fail the save the user actually asked for. Same contract as
//     autoAssignPhasesForEstimate in auto-assign-phases.ts.
//
// Call sites deliberately `void`/`after()` these — never `await` them inside a
// transaction.

import { prisma } from "@/lib/prisma";
import {
    AUTO_ASSIGN_PROJECT_STATUS,
    AUTO_ASSIGN_ROLE,
    AUTO_ASSIGN_USER_STATUS,
    crewIdsToConnect,
    isAutoAssignProjectStatus,
    parseAlwaysAssignKeys,
    shouldAutoAssignUser,
    type AutoAssignOptions,
} from "@/lib/crew-auto-assign";

const LOG = "[crew-auto-assign]";

function options(): AutoAssignOptions {
    return { alwaysAssignKeys: parseAlwaysAssignKeys(process.env.CREW_AUTO_ASSIGN_ALWAYS) };
}

/**
 * Every ACTIVATED user who could possibly qualify. Deliberately NOT filtered
 * to FIELD_CREW in SQL — the always-assign names (CJ) are MANAGER/ADMIN, and
 * the pure rule owns which of these actually qualify.
 */
async function loadCandidateUsers() {
    return prisma.user.findMany({
        where: { status: AUTO_ASSIGN_USER_STATUS },
        select: { id: true, name: true, email: true, role: true, status: true },
    });
}

/**
 * Ensure every eligible user is on this project's crew, if (and only if) the
 * project is "In Progress". Returns the ids actually connected — [] when there
 * was nothing to do, which is the normal steady state.
 */
export async function syncCrewForProject(projectId: string): Promise<string[]> {
    if (!projectId) return [];
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, status: true, crew: { select: { id: true } } },
    });
    if (!project) return [];
    if (!isAutoAssignProjectStatus(project.status)) return [];

    const users = await loadCandidateUsers();
    const toConnect = crewIdsToConnect(users, project.crew.map((c) => c.id), options());
    if (toConnect.length === 0) return [];

    await prisma.project.update({
        where: { id: project.id },
        data: { crew: { connect: toConnect.map((id) => ({ id })) } },
    });
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
    if (!isAutoAssignProjectStatus(newStatus)) return;
    await autoAssignCrewForProject(projectId);
}

/**
 * The other direction: a user just became (or may have just become) an
 * ACTIVATED FIELD_CREW member — or is CJ — so put them on every project that
 * is currently "In Progress".
 */
export async function syncProjectsForUser(userId: string): Promise<string[]> {
    if (!userId) return [];
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            status: true,
            assignedProjects: { select: { id: true } },
        },
    });
    if (!user) return [];
    if (!shouldAutoAssignUser(user, options())) return [];

    const already = new Set(user.assignedProjects.map((p) => p.id));
    const inProgress = await prisma.project.findMany({
        where: { status: AUTO_ASSIGN_PROJECT_STATUS },
        select: { id: true },
    });
    const toConnect = inProgress.map((p) => p.id).filter((id) => !already.has(id));
    if (toConnect.length === 0) return [];

    await prisma.user.update({
        where: { id: user.id },
        data: { assignedProjects: { connect: toConnect.map((id) => ({ id })) } },
    });
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
 * happened could plausibly have made the user eligible (role and/or status
 * touched, or we don't know). Callers pass what they wrote.
 */
export async function autoAssignProjectsOnUserChange(
    userId: string,
    changed: { role?: unknown; status?: unknown } = {},
): Promise<void> {
    const touchedRole = changed.role !== undefined;
    const touchedStatus = changed.status !== undefined;
    if (!touchedRole && !touchedStatus) return;
    // Cheap pre-filter: a write that sets a non-ACTIVATED status can never make
    // someone eligible. Anything else falls through to the authoritative read.
    if (touchedStatus && typeof changed.status === "string" && changed.status !== AUTO_ASSIGN_USER_STATUS) {
        return;
    }
    await autoAssignProjectsForUser(userId);
}

export { AUTO_ASSIGN_PROJECT_STATUS, AUTO_ASSIGN_ROLE, AUTO_ASSIGN_USER_STATUS };
