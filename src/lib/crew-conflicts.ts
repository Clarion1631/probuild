// Pure crew-conflict derivation (PB-pipeline-003, R2 fix).
//
// Conflicts must come ONLY from TaskAssignment windows — a person assigned to
// tasks on two different projects whose [start, end) windows overlap on a
// day. Project-level crew membership (Project.crew) is never itself a
// scheduling window: the auto-crew rule puts every dispatchable user on every
// In Progress project, so treating membership as a full-project window would
// manufacture a conflict for the entire roster any time two active projects'
// date ranges overlap. That signal stays purely informational — the "soft"
// dot in availability.ts — and must never feed this function.
import type { CrewConflict, CrewConflictPair } from "./schedule-core";

export interface CrewConflictAssignment {
    userId: string;
    userName: string;
    taskId: string;
    taskName: string;
    taskStart: Date;
    taskEnd: Date;
    projectId: string;
    projectName: string;
}

// Half-open [start, end) overlap, intersected with the visible range.
function overlaps(aS: Date, aE: Date, bS: Date, bE: Date, from: Date, to: Date): [Date, Date] | null {
    const s = aS > bS ? aS : bS;
    const e = aE < bE ? aE : bE;
    if (s >= e) return null;
    if (e <= from || s >= to) return null;
    return [s, e];
}

/**
 * Derives crew double-bookings for [from, to) from TaskAssignment windows
 * only. Two assignments for the same user on DIFFERENT projects whose task
 * windows overlap within the range produce a conflict pair.
 */
export function deriveCrewConflicts(
    assignments: CrewConflictAssignment[],
    from: Date,
    to: Date,
): CrewConflict[] {
    const byUser = new Map<string, CrewConflict>();
    const pushPair = (userId: string, name: string, pair: CrewConflictPair) => {
        let entry = byUser.get(userId);
        if (!entry) {
            entry = { userId, name, pairs: [] };
            byUser.set(userId, entry);
        }
        const key = [pair.projectA.id, pair.projectB.id].sort().join("|");
        if (entry.pairs.some(p => [p.projectA.id, p.projectB.id].sort().join("|") === key)) return;
        entry.pairs.push(pair);
    };

    const byUserAssignments = new Map<string, { name: string; windows: CrewConflictAssignment[] }>();
    for (const a of assignments) {
        let entry = byUserAssignments.get(a.userId);
        if (!entry) {
            entry = { name: a.userName, windows: [] };
            byUserAssignments.set(a.userId, entry);
        }
        entry.windows.push(a);
    }

    for (const [userId, { name, windows }] of byUserAssignments) {
        for (let i = 0; i < windows.length; i++) {
            for (let j = i + 1; j < windows.length; j++) {
                const a = windows[i];
                const b = windows[j];
                if (a.projectId === b.projectId) continue;
                const o = overlaps(a.taskStart, a.taskEnd, b.taskStart, b.taskEnd, from, to);
                if (!o) continue;
                pushPair(userId, name, {
                    projectA: { id: a.projectId, name: a.projectName },
                    projectB: { id: b.projectId, name: b.projectName },
                    overlapStart: o[0].toISOString(),
                    overlapEnd: o[1].toISOString(),
                    taskA: { id: a.taskId, name: a.taskName, startDate: a.taskStart.toISOString(), endDate: a.taskEnd.toISOString() },
                    taskB: { id: b.taskId, name: b.taskName, startDate: b.taskStart.toISOString(), endDate: b.taskEnd.toISOString() },
                });
            }
        }
    }

    return [...byUser.values()];
}
