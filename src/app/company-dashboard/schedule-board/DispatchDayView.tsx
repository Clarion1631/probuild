"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateScheduleTask } from "@/lib/actions";
import type { DashboardProjectRow, DashboardTaskRow } from "@/lib/schedule-core";
import { buildDispatchDayCollisions, buildDispatchDayJobGroups, chipLabelsForRow, getRosterNotOnJobToday, wouldCollide } from "./dispatch-day-rows";
import { DispatchAssignPopover, type DispatchAssignChoice } from "./DispatchAssignPopover";
import { DispatchAddFromEstimatePopover } from "./DispatchAddFromEstimatePopover";
import type { DispatchTaskBankItem } from "./DispatchTaskBank";
import type { DispatchTaskCreationDefaults } from "./DispatchView";

interface RosterMember {
    id: string;
    // Already disambiguated by DispatchView (disambiguateMemberNames) when a
    // collision exists — "Justin Adkins (jadkins@…)" — so this component
    // never needs to know about collisions itself.
    name: string;
    email: string;
}

interface DispatchDayViewProps {
    // The rendered job list — In Progress projects only (owner rule: Day
    // mode is for staffing today's active work, not the whole pipeline).
    // Every one of these gets a group, even with nothing active today.
    dayProjects: DashboardProjectRow[];
    // The FULL pipeline set (every stage) — used only for "who's busy
    // today" (getRosterNotOnJobToday) and cross-project collision detection,
    // both of which must see a double-booking against a job that isn't
    // itself In Progress yet.
    allProjects: DashboardProjectRow[];
    dayKey: string;
    roster: RosterMember[];
    crewDrafts: Readonly<Record<string, { addUserIds: string[]; removeUserIds: string[] }>>;
    memberNamesById: ReadonlyMap<string, string>;
    // Hover-title fallback for chips whose visible text is just a first name
    // (findConflictOtherProject/drafted labels take priority) — see the
    // person-chip title logic below.
    memberEmailsById: ReadonlyMap<string, string>;
    canEdit: boolean;
    // Set by the Week exception flags' "jump to Day" drill-down (see
    // DispatchView.focusProject) — the matching job group gets an amber
    // focus ring and is the scroll target.
    highlightedProjectId: string | null;
    onActivate: (taskId: string) => void;
    onCreateTask: (defaults: DispatchTaskCreationDefaults) => void;
    onDraftCrewAdd: (taskId: string, userId: string) => boolean;
    onDraftCrewRemove: (taskId: string, userId: string) => void;
    onCrewPointerDown: (event: ReactPointerEvent<HTMLElement>, member: { id: string; name: string }) => void;
    onCrewKeyboardActivate: (event: ReactKeyboardEvent<HTMLElement>, member: { id: string; name: string }) => void;
    // Day-list notes save straight to the DB (see saveNote below) — these
    // let ScheduleBoard track the in-flight/settled revision so a Review
    // opened right after doesn't stale-fail against a not-yet-refreshed
    // expectedUpdatedAt.
    onNoteSaveStart: (taskId: string) => void;
    onNoteSaveSettled: (taskId: string, result: { updatedAt: string } | null) => void;
}

function taskGlyph(task: DashboardTaskRow): string {
    if (task.type === "milestone") return "◆ ";
    if (task.type === "appointment") return `\u{1F550}${task.scheduledTime ? ` ${task.scheduledTime} ` : " "}`;
    return "";
}

interface AssignTarget {
    taskId: string;
    taskName: string;
    projectId: string;
}

interface AddEstimateTarget {
    projectId: string;
}

/**
 * Dispatch's Day mode: a plain list, one row per task active today, grouped
 * by job. Tasks pull from the job's estimate (what crew clock in as, what
 * the job costs against) — this is the reduced "what's expected, who's on
 * it, one note" view the Week grid deliberately doesn't try to be.
 */
export function DispatchDayView({
    dayProjects,
    allProjects,
    dayKey,
    roster,
    crewDrafts,
    memberNamesById,
    memberEmailsById,
    canEdit,
    highlightedProjectId,
    onActivate,
    onCreateTask,
    onDraftCrewAdd,
    onDraftCrewRemove,
    onCrewPointerDown,
    onCrewKeyboardActivate,
    onNoteSaveStart,
    onNoteSaveSettled,
}: DispatchDayViewProps) {
    const router = useRouter();
    const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
    const assignAnchorRef = useRef<HTMLElement | null>(null);
    const [addEstimateTarget, setAddEstimateTarget] = useState<AddEstimateTarget | null>(null);
    const addEstimateAnchorRef = useRef<HTMLElement | null>(null);
    const [editingNoteTaskId, setEditingNoteTaskId] = useState<string | null>(null);
    const [noteDraft, setNoteDraft] = useState("");
    // Per-task, not a single value — two different rows' notes can be
    // saving at once, but a SECOND edit on the SAME row must wait for its
    // own in-flight save to settle (see startNoteEdit's guard) rather than
    // racing it, or an out-of-order response could leave a stale value
    // displayed after a newer one already lost.
    const [savingNoteTaskIds, setSavingNoteTaskIds] = useState<ReadonlySet<string>>(new Set());
    const [noteOverrides, setNoteOverrides] = useState<Record<string, string | null>>({});
    // The updatedAt a note override was saved at — once the canonical task's
    // own updatedAt (from allProjects, server-refreshed) reaches or passes
    // this, the override is redundant (our write already landed there) or
    // stale (someone else's edit landed after ours), so it's dropped either
    // way rather than keep masking canonical doneWhen forever.
    const [noteOverrideRevisions, setNoteOverrideRevisions] = useState<Record<string, string>>({});

    // Draft-aware collision scan over EVERY project/task (not just the
    // rendered In Progress list, and not just today) — feeds the row-level
    // red name, so two drafted adds double-booking someone shows up live,
    // before either is saved, the same derivation the Review dialog uses.
    const dispatchDayCollisions = useMemo(
        () => buildDispatchDayCollisions(allProjects, crewDrafts),
        [allProjects, crewDrafts],
    );
    const jobGroups = buildDispatchDayJobGroups(dayProjects, dayKey, crewDrafts, dispatchDayCollisions, memberNamesById);
    const notOnJobToday = getRosterNotOnJobToday(roster, allProjects, dayKey, crewDrafts);
    const taskById = new Map(allProjects.flatMap(project => project.tasks.map(task => [task.id, task] as const)));

    // Drop a note override as soon as the canonical task's own updatedAt (the
    // server-refreshed allProjects prop) reaches or passes the revision our
    // save landed at — whether that's our own write finally showing up
    // canonically, or a LATER canonical edit (someone else's, or ours from a
    // different tab) that must win rather than stay masked by a stale
    // override forever.
    useEffect(() => {
        setNoteOverrides(prevOverrides => {
            const overrideIds = Object.keys(prevOverrides);
            if (overrideIds.length === 0) return prevOverrides;
            let changed = false;
            const nextOverrides = { ...prevOverrides };
            for (const taskId of overrideIds) {
                // No recorded revision yet means the save is still in flight
                // (the optimistic override is set before the save resolves) —
                // leave it alone until saveNote records where it landed.
                const savedRevision = noteOverrideRevisions[taskId];
                if (!savedRevision) continue;
                const canonicalUpdatedAt = taskById.get(taskId)?.updatedAt;
                if (!canonicalUpdatedAt || canonicalUpdatedAt >= savedRevision) {
                    delete nextOverrides[taskId];
                    changed = true;
                }
            }
            return changed ? nextOverrides : prevOverrides;
        });
        setNoteOverrideRevisions(prevRevisions => {
            const revisionIds = Object.keys(prevRevisions);
            if (revisionIds.length === 0) return prevRevisions;
            let changed = false;
            const nextRevisions = { ...prevRevisions };
            for (const taskId of revisionIds) {
                const canonicalUpdatedAt = taskById.get(taskId)?.updatedAt;
                if (!canonicalUpdatedAt || canonicalUpdatedAt >= prevRevisions[taskId]) {
                    delete nextRevisions[taskId];
                    changed = true;
                }
            }
            return changed ? nextRevisions : prevRevisions;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allProjects]);

    function openAssign(event: ReactMouseEvent<HTMLElement>, taskId: string, taskName: string, projectId: string) {
        assignAnchorRef.current = event.currentTarget as HTMLElement;
        setAssignTarget({ taskId, taskName, projectId });
    }

    function assignChoicesFor(target: AssignTarget): DispatchAssignChoice[] {
        const draft = crewDrafts[target.taskId];
        const removeSet = new Set(draft?.removeUserIds ?? []);
        const task = taskById.get(target.taskId);
        const onTaskIds = new Set([
            ...(task?.assignments.filter(a => a.status === "ACTIVATED" && !removeSet.has(a.userId)).map(a => a.userId) ?? []),
            ...(draft?.addUserIds ?? []),
        ]);
        return roster
            .filter(member => !onTaskIds.has(member.id))
            .map(member => ({
                id: member.id,
                name: member.name,
                email: member.email,
                // Hypothetical, not just "already conflicted" — someone on
                // exactly one other job today still needs the warning, since
                // adding them here is what WOULD create the collision.
                conflictTitle: wouldCollide(member.id, { id: target.taskId, projectId: target.projectId }, allProjects, crewDrafts),
            }));
    }

    function startNoteEdit(taskId: string, currentValue: string | null) {
        // A save already in flight for THIS row must settle first — starting
        // a second edit now would let its save race the first and an
        // out-of-order response could overwrite the newer value with the
        // older one.
        if (savingNoteTaskIds.has(taskId)) return;
        setEditingNoteTaskId(taskId);
        setNoteDraft((noteOverrides[taskId] ?? currentValue) ?? "");
    }

    async function saveNote(taskId: string) {
        const value = noteDraft.trim();
        setEditingNoteTaskId(null);
        setSavingNoteTaskIds(current => new Set(current).add(taskId));
        setNoteOverrides(prev => ({ ...prev, [taskId]: value || null }));
        onNoteSaveStart(taskId);
        try {
            const saved = await updateScheduleTask(taskId, { doneWhen: value || null });
            const savedUpdatedAt = saved.updatedAt.toISOString();
            onNoteSaveSettled(taskId, { updatedAt: savedUpdatedAt });
            setNoteOverrideRevisions(prev => ({ ...prev, [taskId]: savedUpdatedAt }));
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : "Could not save the note");
            onNoteSaveSettled(taskId, null);
            setNoteOverrides(prev => {
                const next = { ...prev };
                delete next[taskId];
                return next;
            });
        } finally {
            setSavingNoteTaskIds(current => {
                if (!current.has(taskId)) return current;
                const next = new Set(current);
                next.delete(taskId);
                return next;
            });
        }
    }

    function scheduleEstimateItem(projectId: string, item: DispatchTaskBankItem) {
        onCreateTask({
            defaultProjectId: projectId,
            lockProject: true,
            defaultStartDate: dayKey,
            defaultName: item.name,
            defaultEstimatedHours: item.estimatedHours,
            estimateItemId: item.estimateItemId,
        });
    }

    return (
        <div className="space-y-4 p-4">
            {jobGroups.length === 0 ? (
                <div className="rounded-lg border border-dashed border-hui-border px-4 py-10 text-center">
                    <p className="text-sm font-semibold text-hui-textMain">No jobs on dispatch today</p>
                    <p className="mt-1 text-xs text-hui-textMuted">Add a task or move work onto today to build the run.</p>
                </div>
            ) : jobGroups.map(group => {
                const isHighlighted = highlightedProjectId === group.projectId;
                const isAddEstimateOpen = addEstimateTarget?.projectId === group.projectId;
                return (
                <div
                    key={group.projectId}
                    id={`dispatch-project-${group.projectId}`}
                    className={`hui-card overflow-hidden transition ${isHighlighted ? "ring-2 ring-amber-400" : ""}`}
                >
                    <div className="flex items-center justify-between gap-3 border-b border-hui-border px-4 py-2.5">
                        <Link href={`/projects/${group.projectId}`} className="truncate text-sm font-bold text-hui-textMain hover:text-hui-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                            {group.projectName}
                        </Link>
                        {canEdit && (
                            <button
                                type="button"
                                aria-haspopup="dialog"
                                aria-expanded={isAddEstimateOpen}
                                onClick={event => { addEstimateAnchorRef.current = event.currentTarget; setAddEstimateTarget({ projectId: group.projectId }); }}
                                className="hui-btn hui-btn-secondary shrink-0 text-xs"
                            >
                                Add from estimate
                            </button>
                        )}
                    </div>
                    {group.rows.length === 0 ? (
                        <p className="px-4 py-4 text-xs text-hui-textMuted">Nothing planned this day.</p>
                    ) : (
                    <div className="overflow-x-auto">
                    <table className="w-full table-fixed border-collapse">
                        <colgroup>
                            <col style={{ width: 92 }} />
                            <col />
                            <col style={{ width: 220 }} />
                            <col style={{ width: 220 }} />
                        </colgroup>
                        <thead>
                            <tr className="border-b border-hui-border bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                <th scope="col" className="px-4 py-1.5 text-left">Code</th>
                                <th scope="col" className="px-2 py-1.5 text-left">Task</th>
                                <th scope="col" className="px-2 py-1.5 text-left">Who</th>
                                <th scope="col" className="px-2 py-1.5 text-left">Note</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                        {group.rows.map(row => {
                            const task = taskById.get(row.taskId);
                            const noteValue = noteOverrides[row.taskId] !== undefined ? noteOverrides[row.taskId] : row.doneWhen;
                            const isEditingNote = editingNoteTaskId === row.taskId;
                            const isSavingNote = savingNoteTaskIds.has(row.taskId);
                            const isAssignOpen = assignTarget?.taskId === row.taskId;
                            const chipLabels = chipLabelsForRow(row.people, memberEmailsById);
                            return (
                                <tr
                                    key={row.taskId}
                                    // A non-dispatchable row (milestone,
                                    // appointment, phase parent) has no time
                                    // card to receive a crew chip drop onto —
                                    // omit the marker entirely so it's not a
                                    // resolveCrewDrop target (see DispatchView).
                                    data-dispatch-task-id={row.dispatchable ? row.taskId : undefined}
                                    className="min-h-10"
                                >
                                    <td className="px-4 py-2 align-middle">
                                        <div className="flex items-center gap-1.5">
                                            <span className="font-mono text-[11px] font-semibold tabular-nums text-slate-500">{row.costCode ?? "—"}</span>
                                            {!row.isCosted && (
                                                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400" title="Not linked to an estimate item">
                                                    not costed
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="min-w-0 px-2 py-2 align-middle">
                                        <button
                                            type="button"
                                            onClick={() => onActivate(row.taskId)}
                                            className="block w-full min-w-0 truncate text-left text-sm text-hui-textMain hover:text-hui-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                                            title="Open task details"
                                        >
                                            {task ? taskGlyph(task) : ""}{row.taskName}
                                        </button>
                                    </td>
                                    <td className="px-2 py-2 align-middle">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            {row.people.map(person => (
                                                <span key={person.id} className="group relative inline-flex">
                                                    <button
                                                        type="button"
                                                        data-dispatch-crew-chip="true"
                                                        data-dispatch-user-id={person.id}
                                                        onPointerDown={event => onCrewPointerDown(event, { id: person.id, name: person.name })}
                                                        onKeyDown={event => onCrewKeyboardActivate(event, { id: person.id, name: person.name })}
                                                        className={`touch-none rounded px-1 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${
                                                            person.conflicted
                                                                ? "text-red-600"
                                                                : person.state === "drafted"
                                                                    ? "rounded-full border border-dashed border-indigo-400 bg-indigo-50 text-indigo-600"
                                                                    : "text-hui-textMain"
                                                        }`}
                                                        aria-label={person.name}
                                                        title={[
                                                            person.name,
                                                            person.conflictTitle ?? (person.state === "drafted" ? "Drafted assignment" : memberEmailsById.get(person.id) ?? null),
                                                        ].filter(Boolean).join(" — ")}
                                                    >
                                                        {person.lead ? "★" : ""}{chipLabels.get(person.id) ?? person.name}
                                                    </button>
                                                    {canEdit && (
                                                        <button
                                                            type="button"
                                                            onPointerDown={event => event.stopPropagation()}
                                                            onClick={() => onDraftCrewRemove(row.taskId, person.id)}
                                                            className="absolute -right-1.5 -top-1.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-700 text-[9px] font-bold leading-none text-white opacity-0 pointer-events-none shadow transition hover:bg-red-600 focus:opacity-100 focus:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto"
                                                            aria-label={`Remove ${person.name} from ${row.taskName}`}
                                                        >
                                                            {"×"}
                                                        </button>
                                                    )}
                                                </span>
                                            ))}
                                            {row.dispatchable && canEdit && (
                                                <button
                                                    type="button"
                                                    aria-haspopup="dialog"
                                                    aria-expanded={isAssignOpen}
                                                    onClick={event => openAssign(event, row.taskId, row.taskName, group.projectId)}
                                                    className="rounded px-1 text-xs font-semibold text-hui-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                                                >
                                                    + Assign
                                                </button>
                                            )}
                                            {!row.dispatchable && (
                                                <span
                                                    className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400"
                                                    title={row.notDispatchableReason ?? "Not dispatchable"}
                                                >
                                                    not dispatchable
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="min-w-0 px-2 py-2 align-middle">
                                        {isEditingNote ? (
                                            <input
                                                autoFocus
                                                type="text"
                                                value={noteDraft}
                                                aria-label={`Note for ${row.taskName}`}
                                                onChange={event => setNoteDraft(event.target.value)}
                                                onBlur={() => void saveNote(row.taskId)}
                                                onKeyDown={event => {
                                                    if (event.key === "Enter") { event.currentTarget.blur(); }
                                                    else if (event.key === "Escape") { setEditingNoteTaskId(null); }
                                                }}
                                                className="hui-input h-7 w-full text-xs"
                                                placeholder="Note for the crew..."
                                            />
                                        ) : (
                                            <button
                                                type="button"
                                                disabled={!canEdit || isSavingNote}
                                                onClick={() => startNoteEdit(row.taskId, row.doneWhen)}
                                                className={`block w-full truncate text-left text-xs ${noteValue ? "text-hui-textMuted" : "text-slate-300"} ${canEdit ? "hover:text-hui-textMain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary" : ""}`}
                                            >
                                                {isSavingNote ? "Saving..." : noteValue || (canEdit ? "+ Note" : "")}
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                        </tbody>
                    </table>
                    </div>
                    )}
                </div>
                );
            })}

            {notOnJobToday.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 px-1 py-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Not on a job today:</span>
                    {notOnJobToday.map(member => (
                        <button
                            key={member.id}
                            type="button"
                            data-dispatch-crew-chip="true"
                            data-dispatch-user-id={member.id}
                            onPointerDown={event => onCrewPointerDown(event, member)}
                            onKeyDown={event => onCrewKeyboardActivate(event, member)}
                            className="touch-none rounded px-1 text-xs text-slate-400 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                            title={`${member.name} has no task assignment today. Drag onto a task or press Enter.${member.email ? ` (${member.email})` : ""}`}
                        >
                            {member.name}
                        </button>
                    ))}
                </div>
            )}

            <DispatchAssignPopover
                open={Boolean(assignTarget)}
                taskName={assignTarget?.taskName ?? ""}
                choices={assignTarget ? assignChoicesFor(assignTarget) : []}
                anchorRef={assignAnchorRef}
                onAssign={userId => { if (assignTarget) onDraftCrewAdd(assignTarget.taskId, userId); }}
                onClose={() => setAssignTarget(null)}
            />
            <DispatchAddFromEstimatePopover
                open={Boolean(addEstimateTarget)}
                projectId={addEstimateTarget?.projectId ?? ""}
                anchorRef={addEstimateAnchorRef}
                canSchedule={canEdit}
                onSchedule={item => { if (addEstimateTarget) scheduleEstimateItem(addEstimateTarget.projectId, item); }}
                onOtherTask={() => { if (addEstimateTarget) onCreateTask({ defaultProjectId: addEstimateTarget.projectId, lockProject: true, defaultStartDate: dayKey }); }}
                onClose={() => setAddEstimateTarget(null)}
            />
        </div>
    );
}
