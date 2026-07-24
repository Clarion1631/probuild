"use client";

import { useEffect, useState } from "react";
import type { Task, PunchItem, Comment, TeamMember, Subcontractor, EstimateItemSummary } from "./schedule-types";
import { STATUS_OPTIONS, getInitials, formatCurrency } from "./schedule-utils";
import DependencyPicker from "./DependencyPicker";
import ColorPicker from "./ColorPicker";

const ESTIMATE_LINK_STOPWORDS = new Set(["and", "or", "the", "a", "to", "of", "with", "for", "in", "on", "at", "&"]);
function tokenizeForMatch(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !ESTIMATE_LINK_STOPWORDS.has(t));
}

const SECTION_LABEL = "text-xs font-semibold text-hui-textMuted uppercase tracking-wider";

export type TaskDetailPanelProps = {
    task: Task;
    onClose: () => void;
    panelTab: "details" | "punch" | "conversation";
    setPanelTab: (tab: "details" | "punch" | "conversation") => void;
    onStatusChange: (taskId: string, status: string, blockedReason?: string) => void;
    onNameChange: (taskId: string, name: string) => void;
    onDoneWhenChange: (taskId: string, doneWhen: string | null) => void;
    onDateChange: (taskId: string, field: "startDate" | "endDate", value: string) => void;
    onEstimatedHoursChange: (taskId: string, hours: number) => void;
    onColorChange: (taskId: string, color: string) => void;
    onDelete: (taskId: string) => void;
    estimateItems: EstimateItemSummary[];
    onLinkEstimateItem: (taskId: string, item: EstimateItemSummary) => void;
    onUnlinkEstimateItem: (taskId: string) => void;
    onFetchEstimateItems: () => void;
    teamMembers: TeamMember[];
    subcontractors: Subcontractor[];
    onAssign: (userId: string) => void;
    onUnassign: (userId: string) => void;
    onSetLead: (userId: string | null) => void;
    onAssignSub: (subId: string) => void;
    onUnassignSub: (subId: string) => void;
    punchItems: PunchItem[];
    onAddPunch: (name: string) => void;
    onTogglePunch: (id: string) => void;
    onDeletePunch: (id: string) => void;
    onAiPunchlist: () => void;
    isAiPunching: boolean;
    comments: Comment[];
    onAddComment: (text: string) => void;
    showCriticalPath: boolean;
    criticalPathIds: Set<string>;
    allTasks: Task[];
    onLinkPredecessor: (predecessorId: string) => void;
    onUnlinkPredecessor: (predecessorId: string) => void;
    onSelectTask?: (taskId: string) => void;
    onAppointmentChange: (taskId: string, data: { scheduledTime?: string | null; confirmationStatus?: "planned" | "requested" | "confirmed" | null }) => void;
    datesReadOnly?: boolean;
    dateReadOnlyNote?: string;
    crewReadOnly?: boolean;
    crewReadOnlyNote?: string;
    embedded?: boolean;
};

export default function TaskDetailPanel({
    task, onClose, panelTab, setPanelTab,
    onStatusChange, onNameChange, onDoneWhenChange, onDateChange, onEstimatedHoursChange, onColorChange, onDelete,
    estimateItems, onLinkEstimateItem, onUnlinkEstimateItem, onFetchEstimateItems,
    teamMembers, subcontractors, onAssign, onUnassign, onSetLead, onAssignSub, onUnassignSub,
    punchItems, onAddPunch, onTogglePunch, onDeletePunch, onAiPunchlist, isAiPunching,
    comments, onAddComment,
    showCriticalPath, criticalPathIds,
    allTasks, onLinkPredecessor, onUnlinkPredecessor, onSelectTask, onAppointmentChange,
    datesReadOnly = false, dateReadOnlyNote,
    crewReadOnly = false, crewReadOnlyNote,
    embedded = false,
}: TaskDetailPanelProps) {
    const [showAssignMenu, setShowAssignMenu] = useState(false);
    const [showEstimateLinkMenu, setShowEstimateLinkMenu] = useState(false);
    const [estimateQuery, setEstimateQuery] = useState("");
    const [showPredecessorMenu, setShowPredecessorMenu] = useState(false);
    const [showColorPicker, setShowColorPicker] = useState(false);
    const [newPunchName, setNewPunchName] = useState("");
    const [newComment, setNewComment] = useState("");
    const [nameDraft, setNameDraft] = useState(task.name);
    const [nameDirty, setNameDirty] = useState(false);
    const [statusDraft, setStatusDraft] = useState(task.status);
    const [blockedReasonDraft, setBlockedReasonDraft] = useState(task.blockedReason ?? "");
    const [blockedReasonError, setBlockedReasonError] = useState(false);
    const [doneWhenDraft, setDoneWhenDraft] = useState(task.doneWhen ?? "");
    const [scheduledTimeDraft, setScheduledTimeDraft] = useState(task.scheduledTime ?? "");

    useEffect(() => {
        setNameDraft(task.name);
        setNameDirty(false);
        setStatusDraft(task.status);
        setBlockedReasonDraft(task.blockedReason ?? "");
        setBlockedReasonError(false);
        setDoneWhenDraft(task.doneWhen ?? "");
        setScheduledTimeDraft(task.scheduledTime ?? "");
    }, [task.id, task.name, task.status, task.blockedReason, task.doneWhen, task.scheduledTime]);

    const taskMap = new Map(allTasks.map(t => [t.id, t] as const));
    const predecessors = task.dependencies
        .map(d => ({ depId: d.id, predId: d.predecessorId, task: taskMap.get(d.predecessorId) }))
        .filter(p => p.task);
    const successors = task.dependents
        .map(d => ({ depId: d.id, succId: d.dependentId, task: taskMap.get(d.dependentId) }))
        .filter(s => s.task);

    const hasTeam = (task.assignments || []).length > 0 || (task.subAssignments || []).length > 0;
    const hasDeps = predecessors.length > 0 || successors.length > 0;
    const isCritical = showCriticalPath && criticalPathIds.has(task.id);

    function handleNameSave() {
        const next = nameDraft.trim();
        if (!nameDirty || !next || next === task.name) { setNameDirty(false); setNameDraft(task.name); return; }
        onNameChange(task.id, next);
        setNameDirty(false);
    }

    function handleDoneWhenSave() {
        const next = doneWhenDraft.trim() || null;
        if (next === task.doneWhen) return;
        onDoneWhenChange(task.id, next);
    }

    function handleStatusSelect(status: string) {
        setStatusDraft(status);
        setBlockedReasonError(false);
        if (status === "Blocked") return;
        setBlockedReasonDraft("");
        onStatusChange(task.id, status);
    }

    function commitBlockedReason() {
        const reason = blockedReasonDraft.trim();
        if (!reason) {
            setBlockedReasonError(true);
            return;
        }
        if (task.status === "Blocked" && reason === task.blockedReason) return;
        setBlockedReasonError(false);
        onStatusChange(task.id, "Blocked", reason);
    }

    function handleScheduledTimeSave() {
        const next = scheduledTimeDraft || null;
        if (next === task.scheduledTime) return;
        onAppointmentChange(task.id, { scheduledTime: next });
    }

    function handleAddPunchLocal() {
        if (!newPunchName.trim()) return;
        onAddPunch(newPunchName.trim());
        setNewPunchName("");
    }
    function handleAddCommentLocal() {
        if (!newComment.trim()) return;
        onAddComment(newComment.trim());
        setNewComment("");
    }
    function handleShowEstimateLink() {
        setShowEstimateLinkMenu(v => {
            const next = !v;
            if (!next) setEstimateQuery("");
            else onFetchEstimateItems();
            return next;
        });
    }

    return (
        <div className={`${embedded ? "w-full h-full" : "w-[480px]"} shrink-0 bg-white border-l border-hui-border flex flex-col z-10 shadow-lg animate-in slide-in-from-right-5`}>
            {/* Panel Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-hui-border bg-slate-50">
                <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    <div className="relative shrink-0">
                        <button
                            type="button"
                            onClick={() => setShowColorPicker(v => !v)}
                            title="Change color"
                            className="block hover:scale-110 transition"
                            aria-label="Change task color"
                        >
                            {(() => {
                                const isWhite = task.color?.toLowerCase() === "#ffffff";
                                const ringClass = isWhite ? "ring-slate-500" : "ring-slate-300";
                                return task.type === "milestone" ? (
                                    <div className={`w-4 h-4 rotate-45 border border-white shadow-sm ring-1 ${ringClass}`} style={{ backgroundColor: task.color }} />
                                ) : (
                                    <div className={`w-4 h-4 rounded-full border border-white shadow-sm ring-1 ${ringClass}`} style={{ backgroundColor: task.color }} />
                                );
                            })()}
                        </button>
                        {showColorPicker && (
                            <ColorPicker
                                selected={task.color}
                                onPick={c => onColorChange(task.id, c)}
                                onClose={() => setShowColorPicker(false)}
                                className="absolute left-0 top-7 z-50 min-w-[200px]"
                            />
                        )}
                    </div>
                    <h3 className="text-sm font-bold text-hui-textMain truncate">{task.name}</h3>
                </div>
                <button onClick={onClose} aria-label="Close task details" className="text-slate-400 hover:text-slate-700 p-1.5 rounded-md hover:bg-slate-100 transition">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-hui-border bg-white">
                {(["details", "punch", "conversation"] as const).map(tab => (
                    <button key={tab} onClick={() => setPanelTab(tab)} className={`flex-1 py-2.5 text-xs font-semibold uppercase tracking-wider transition ${panelTab === tab ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-400 hover:text-slate-600"}`}>
                        {tab === "punch" ? "Punch List" : tab === "conversation" ? "Comments" : "Details"}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
                {panelTab === "details" && (
                    <div className="space-y-1">
                        {/* Core — always open */}
                        <details open className="group">
                            <summary className="flex items-center gap-2 cursor-pointer select-none py-2 list-none [&::-webkit-details-marker]:hidden">
                                <svg className="w-3.5 h-3.5 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                                <span className={SECTION_LABEL}>Core</span>
                            </summary>
                            <div className="space-y-4 pb-4 pl-5.5">
                                <div>
                                    <label className={SECTION_LABEL}>Task Name</label>
                                    <input
                                        type="text"
                                        value={nameDirty ? nameDraft : task.name}
                                        onChange={e => { setNameDraft(e.target.value); setNameDirty(true); }}
                                        onBlur={handleNameSave}
                                        onKeyDown={e => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } else if (e.key === "Escape") { setNameDraft(task.name); setNameDirty(false); (e.target as HTMLInputElement).blur(); } }}
                                        className="hui-input text-sm mt-1.5 w-full"
                                    />
                                </div>
                                <div>
                                    <label className={SECTION_LABEL}>Done when</label>
                                    <input
                                        type="text"
                                        value={doneWhenDraft}
                                        onChange={e => setDoneWhenDraft(e.target.value)}
                                        onBlur={handleDoneWhenSave}
                                        onKeyDown={e => {
                                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                            if (e.key === "Escape") { setDoneWhenDraft(task.doneWhen ?? ""); (e.target as HTMLInputElement).blur(); }
                                        }}
                                        className="hui-input text-sm mt-1.5 w-full"
                                        placeholder="The field result that marks this done"
                                    />
                                </div>
                                <div>
                                    <label className={SECTION_LABEL}>Status</label>
                                    <select value={statusDraft} onChange={e => handleStatusSelect(e.target.value)} className="hui-input text-sm mt-1.5 w-full">
                                        {STATUS_OPTIONS.map(s => (<option key={s} value={s}>{s}</option>))}
                                    </select>
                                    {statusDraft === "Blocked" && (
                                        <div className="mt-2">
                                            <label className={SECTION_LABEL}>Blocked reason</label>
                                            <input
                                                type="text"
                                                list={`blocked-reason-categories-${task.id}`}
                                                value={blockedReasonDraft}
                                                onChange={e => { setBlockedReasonDraft(e.target.value); setBlockedReasonError(false); }}
                                                onBlur={commitBlockedReason}
                                                onKeyDown={e => {
                                                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                                    if (e.key === "Escape") { e.preventDefault(); setBlockedReasonDraft(task.blockedReason ?? ""); setStatusDraft(task.status); setBlockedReasonError(false); }
                                                }}
                                                className={`hui-input text-sm mt-1.5 w-full ${blockedReasonError ? "border-red-400 focus:border-red-500 focus:ring-red-200" : ""}`}
                                                placeholder="Choose a category or enter a reason"
                                                aria-invalid={blockedReasonError}
                                                autoFocus={task.status !== "Blocked"}
                                            />
                                            <datalist id={`blocked-reason-categories-${task.id}`}>
                                                {[
                                                    "Materials",
                                                    "Inspection",
                                                    "Predecessor",
                                                    "Client decision",
                                                    "Site condition",
                                                    "Subcontractor",
                                                    "Other",
                                                ].map(reason => <option key={reason} value={reason} />)}
                                            </datalist>
                                            <p className={`mt-1 text-xs ${blockedReasonError ? "text-red-600" : "text-slate-400"}`}>
                                                {blockedReasonError ? "A reason is required before this task can be blocked." : "Required. You can add free text after a category."}
                                            </p>
                                        </div>
                                    )}
                                </div>
                                {task.type === "milestone" ? (
                                    <div>
                                        <label className={SECTION_LABEL}>Date</label>
                                        <input type="date" value={task.startDate} disabled={datesReadOnly} onChange={e => onDateChange(task.id, "startDate", e.target.value)} className="hui-input text-sm mt-1.5 w-full disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed" />
                                    </div>
                                ) : (
                                    <>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div><label className={SECTION_LABEL}>Start</label><input type="date" value={task.startDate} disabled={datesReadOnly} onChange={e => onDateChange(task.id, "startDate", e.target.value)} className="hui-input text-sm mt-1.5 w-full disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed" /></div>
                                            <div><label className={SECTION_LABEL}>End</label><input type="date" value={task.endDate} disabled={datesReadOnly} onChange={e => onDateChange(task.id, "endDate", e.target.value)} className="hui-input text-sm mt-1.5 w-full disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed" /></div>
                                        </div>
                                        {task.type === "appointment" && (
                                            <div className="grid grid-cols-2 gap-3">
                                                <div>
                                                    <label className={SECTION_LABEL}>Time (Los Angeles)</label>
                                                    <input
                                                        type="time"
                                                        value={scheduledTimeDraft}
                                                        onChange={e => setScheduledTimeDraft(e.target.value)}
                                                        onBlur={handleScheduledTimeSave}
                                                        className="hui-input text-sm mt-1.5 w-full"
                                                    />
                                                </div>
                                                <div>
                                                    <label className={SECTION_LABEL}>Confirmation</label>
                                                    <select
                                                        value={task.confirmationStatus ?? "planned"}
                                                        onChange={e => onAppointmentChange(task.id, { confirmationStatus: e.target.value as "planned" | "requested" | "confirmed" })}
                                                        className="hui-input text-sm mt-1.5 w-full capitalize"
                                                    >
                                                        <option value="planned">Planned</option>
                                                        <option value="requested">Requested</option>
                                                        <option value="confirmed">Confirmed</option>
                                                    </select>
                                                </div>
                                            </div>
                                        )}
                                        <div>
                                            <label className={SECTION_LABEL}>Estimated Hours</label>
                                            <input type="number" value={task.estimatedHours ?? ""} onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onEstimatedHoursChange(task.id, v); }} className="hui-input text-sm mt-1.5 w-full" placeholder="e.g. 40" />
                                        </div>
                                    </>
                                )}
                                {datesReadOnly && dateReadOnlyNote && (
                                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">{dateReadOnlyNote}</p>
                                )}
                            </div>
                        </details>

                        <div className="border-t border-slate-100" />

                        {/* Budget — open if estimate linked */}
                        <details open={!!task.estimateItem} className="group">
                            <summary className="flex items-center gap-2 cursor-pointer select-none py-2 list-none [&::-webkit-details-marker]:hidden">
                                <svg className="w-3.5 h-3.5 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                                <span className={SECTION_LABEL}>Budget</span>
                                {task.estimateItem && <span className="text-xs text-blue-500 bg-blue-50 rounded px-1.5 py-0.5 font-semibold ml-1">$</span>}
                            </summary>
                            <div className="pb-4 pl-5.5">
                                <div className="flex items-center justify-between mb-2">
                                    <label className={SECTION_LABEL}>Estimate Link</label>
                                    {task.estimateItem ? (
                                        <button onClick={() => onUnlinkEstimateItem(task.id)} className="text-xs text-red-500 hover:text-red-700 font-semibold transition">Remove</button>
                                    ) : (
                                        <div className="relative">
                                            <button onClick={handleShowEstimateLink} className="text-xs text-indigo-600 font-semibold hover:text-indigo-800 transition">+ Link</button>
                                            {showEstimateLinkMenu && (() => {
                                                const taskTokens = tokenizeForMatch(task.name);
                                                const query = estimateQuery.trim().toLowerCase();
                                                const suggested = query ? [] : estimateItems
                                                    .map(item => {
                                                        const itemTokens = new Set(tokenizeForMatch(item.name + " " + (item.parent?.name ?? "")));
                                                        const score = taskTokens.reduce((n, t) => n + (itemTokens.has(t) ? 1 : 0), 0);
                                                        return { item, score };
                                                    })
                                                    .filter(x => x.score > 0)
                                                    .sort((a, b) => b.score - a.score)
                                                    .slice(0, 5)
                                                    .map(x => x.item);
                                                const filtered = query ? estimateItems.filter(item =>
                                                    item.name.toLowerCase().includes(query) ||
                                                    (item.parent?.name ?? "").toLowerCase().includes(query)
                                                ) : [];
                                                const renderItem = (item: EstimateItemSummary, keyPrefix = "") => {
                                                    const isTaken = !!(item.linkedTaskId && item.linkedTaskId !== task.id);
                                                    return (
                                                        <button
                                                            key={`${keyPrefix}${item.id}`}
                                                            onClick={() => { if (!isTaken) { onLinkEstimateItem(task.id, item); setShowEstimateLinkMenu(false); setEstimateQuery(""); } }}
                                                            disabled={isTaken}
                                                            className={`w-full text-left px-3 py-2 transition text-xs ${isTaken ? "opacity-50 cursor-not-allowed bg-slate-50" : "hover:bg-slate-50"}`}
                                                        >
                                                            <div className="font-medium truncate">{item.name}</div>
                                                            <div className="text-slate-400">
                                                                {item.type} · {formatCurrency(item.total)}
                                                                {isTaken && <span className="ml-2 text-amber-600 font-semibold">Linked to: {item.linkedTaskName}</span>}
                                                            </div>
                                                        </button>
                                                    );
                                                };
                                                const grouped = new Map<string, EstimateItemSummary[]>();
                                                for (const item of estimateItems) {
                                                    const key = item.parent?.name ?? "";
                                                    if (!grouped.has(key)) grouped.set(key, []);
                                                    grouped.get(key)!.push(item);
                                                }
                                                const sections = Array.from(grouped.entries()).sort((a, b) => {
                                                    if (a[0] === "") return -1;
                                                    if (b[0] === "") return 1;
                                                    return a[0].localeCompare(b[0]);
                                                });
                                                return (
                                                    <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 w-80 max-h-72 flex flex-col animate-in fade-in">
                                                        <div className="p-2.5 border-b border-hui-border" onClick={e => e.stopPropagation()}>
                                                            <input
                                                                type="text"
                                                                value={estimateQuery}
                                                                onChange={e => setEstimateQuery(e.target.value)}
                                                                placeholder="Search items..."
                                                                autoFocus
                                                                className="hui-input text-xs w-full"
                                                            />
                                                        </div>
                                                        <div className="flex-1 overflow-y-auto py-1">
                                                            {estimateItems.length === 0 ? (
                                                                <div className="px-3 py-3 text-xs text-slate-400">No estimate line items found.<br /><span className="text-slate-300">Add items to an estimate first.</span></div>
                                                            ) : query ? (
                                                                filtered.length === 0 ? (
                                                                    <div className="px-3 py-3 text-xs text-slate-400">No items match &ldquo;{query}&rdquo;</div>
                                                                ) : (
                                                                    filtered.map(item => renderItem(item))
                                                                )
                                                            ) : (
                                                                <>
                                                                    {suggested.length > 0 && (
                                                                        <div>
                                                                            <div className="px-3 py-2 text-xs font-semibold text-indigo-500 uppercase tracking-wider bg-indigo-50 sticky top-0">Suggested</div>
                                                                            {suggested.map(item => renderItem(item, "sug-"))}
                                                                        </div>
                                                                    )}
                                                                    {sections.map(([sectionName, sectionItems]) => (
                                                                        <div key={sectionName || "__ungrouped"}>
                                                                            {sectionName && <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider bg-slate-50 sticky top-0">{sectionName}</div>}
                                                                            {sectionItems.map(item => renderItem(item))}
                                                                        </div>
                                                                    ))}
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    )}
                                </div>
                                {task.estimateItem ? (
                                    <div className="bg-blue-50 rounded-lg px-3.5 py-2.5 border border-blue-100">
                                        <div className="text-sm font-semibold text-blue-800 truncate">{task.estimateItem.name}</div>
                                        <div className="flex items-center gap-3 mt-1.5">
                                            <span className="text-xs text-blue-600 capitalize">{task.estimateItem.type}</span>
                                            <span className="text-xs font-semibold text-blue-700">{formatCurrency(task.estimateItem.total)} budget</span>
                                            {task.estimatedHours && <span className="text-xs text-blue-500">{task.estimatedHours}h est.</span>}
                                        </div>
                                    </div>
                                ) : (
                                    <p className="text-xs text-slate-400 italic">Not linked to an estimate item</p>
                                )}
                            </div>
                        </details>

                        <div className="border-t border-slate-100" />

                        {/* Dependencies — open if any exist */}
                        <details open={hasDeps || isCritical} className="group">
                            <summary className="flex items-center gap-2 cursor-pointer select-none py-2 list-none [&::-webkit-details-marker]:hidden">
                                <svg className="w-3.5 h-3.5 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                                <span className={SECTION_LABEL}>Dependencies</span>
                                {hasDeps && <span className="text-xs text-slate-400 ml-1">({predecessors.length + successors.length})</span>}
                                {isCritical && (
                                    <span className="ml-1 text-xs text-red-600 bg-red-50 rounded px-1.5 py-0.5 font-semibold flex items-center gap-1">
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                                        Critical
                                    </span>
                                )}
                            </summary>
                            <div className="pb-4 pl-5.5 space-y-3">
                                <div>
                                    <div className="flex items-center justify-between mb-2">
                                        <label className={SECTION_LABEL}>Predecessors</label>
                                        <div className="relative">
                                            <button onClick={() => setShowPredecessorMenu(v => !v)} className="text-xs text-indigo-600 font-semibold hover:text-indigo-800 transition">+ Add</button>
                                            {showPredecessorMenu && (
                                                <DependencyPicker
                                                    task={task}
                                                    allTasks={allTasks}
                                                    onPick={(predId) => onLinkPredecessor(predId)}
                                                    onClose={() => setShowPredecessorMenu(false)}
                                                />
                                            )}
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        {predecessors.length === 0 ? (
                                            <p className="text-xs text-slate-400 italic">No predecessors</p>
                                        ) : (
                                            predecessors.map(p => (
                                                <div key={p.depId} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2.5 group/dep">
                                                    {p.task!.type === "milestone" ? (
                                                        <div className="w-2.5 h-2.5 rotate-45 shrink-0" style={{ backgroundColor: p.task!.color }} />
                                                    ) : (
                                                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: p.task!.color }} />
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => onSelectTask?.(p.predId)}
                                                        className="text-xs font-medium text-hui-textMain flex-1 truncate text-left hover:text-indigo-600 transition cursor-pointer"
                                                        title="Open this task"
                                                    >
                                                        {p.task!.name}
                                                    </button>
                                                    <span className="text-xs text-slate-400 font-semibold uppercase tracking-wide" title="Finish-to-Start">FS</span>
                                                    <button onClick={() => onUnlinkPredecessor(p.predId)} className="text-slate-300 hover:text-red-500 transition shrink-0" title="Remove dependency">
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                    </button>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                                {successors.length > 0 && (
                                    <div>
                                        <label className={SECTION_LABEL}>Successors</label>
                                        <div className="space-y-1 mt-1.5">
                                            {successors.map(s => (
                                                <button
                                                    key={s.depId}
                                                    type="button"
                                                    onClick={() => onSelectTask?.(s.succId)}
                                                    className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500 hover:bg-slate-50 rounded-lg transition w-full text-left"
                                                    title="Open this task"
                                                >
                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-300 shrink-0"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                                                    {s.task!.type === "milestone" ? (
                                                        <div className="w-2 h-2 rotate-45 shrink-0" style={{ backgroundColor: s.task!.color }} />
                                                    ) : (
                                                        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.task!.color }} />
                                                    )}
                                                    <span className="truncate">{s.task!.name}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </details>

                        <div className="border-t border-slate-100" />

                        {/* Team — open if anyone assigned */}
                        <details open={hasTeam} className="group">
                            <summary className="flex items-center gap-2 cursor-pointer select-none py-2 list-none [&::-webkit-details-marker]:hidden">
                                <svg className="w-3.5 h-3.5 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                                <span className={SECTION_LABEL}>Team</span>
                                {hasTeam && <span className="text-xs text-slate-400 ml-1">({(task.assignments || []).length + (task.subAssignments || []).length})</span>}
                            </summary>
                            <div className="pb-4 pl-5.5">
                                {crewReadOnly && crewReadOnlyNote && (
                                    <p className="mb-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-800">
                                        {crewReadOnlyNote}
                                    </p>
                                )}
                                <div className="flex items-center justify-between mb-2">
                                    <label className={SECTION_LABEL}>Assigned</label>
                                    <div className="relative">
                                        <button disabled={crewReadOnly} onClick={() => setShowAssignMenu(!showAssignMenu)} className="text-xs text-indigo-600 font-semibold hover:text-indigo-800 transition disabled:cursor-not-allowed disabled:text-slate-300">+ Add</button>
                                        {showAssignMenu && !crewReadOnly && (
                                            <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[240px] py-1 animate-in fade-in max-h-60 overflow-y-auto">
                                                <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider bg-slate-50">Team Members</div>
                                                {teamMembers.filter(m => !(task.assignments || []).some(a => a.userId === m.id)).map(m => (
                                                    <button key={m.id} onClick={() => { onAssign(m.id); setShowAssignMenu(false); }} className="w-full text-left px-3 py-2.5 hover:bg-slate-50 transition flex items-center gap-2 text-xs">
                                                        <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center shrink-0">{getInitials(m.name, m.email)}</div>
                                                        <span className="truncate">{m.name || m.email}</span>
                                                    </button>
                                                ))}
                                                <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider bg-slate-50 mt-1 border-t border-hui-border">Subcontractors</div>
                                                {subcontractors.filter(s => !(task.subAssignments || []).some(a => a.subcontractorId === s.id)).map(s => (
                                                    <button key={s.id} onClick={() => { onAssignSub(s.id); setShowAssignMenu(false); }} className="w-full text-left px-3 py-2.5 hover:bg-slate-50 transition flex items-center gap-2 text-xs">
                                                        <div className="w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-xs font-bold flex items-center justify-center shrink-0">{s.companyName.substring(0,2).toUpperCase()}</div>
                                                        <span className="truncate flex-1">{s.companyName}</span>
                                                    </button>
                                                ))}
                                                {teamMembers.length === 0 && subcontractors.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">No options found</div>}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    {(task.assignments || []).map(a => (
                                        <div key={a.userId} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2.5">
                                            <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center shrink-0">{getInitials(a.user.name, a.user.email)}</div>
                                            <span className="text-xs font-medium text-hui-textMain flex-1 truncate">{a.user.name || a.user.email}</span>
                                            <button
                                                type="button"
                                                disabled={crewReadOnly}
                                                onClick={() => onSetLead(a.role === "lead" ? null : a.userId)}
                                                aria-label={a.role === "lead" ? `Remove ${a.user.name || a.user.email} as lead` : `Set ${a.user.name || a.user.email} as lead`}
                                                aria-pressed={a.role === "lead"}
                                                title={a.role === "lead" ? "Task lead — click to remove" : "Make task lead"}
                                                className={`shrink-0 rounded p-1 transition disabled:cursor-not-allowed disabled:opacity-40 ${a.role === "lead" ? "text-amber-500 bg-amber-50" : "text-slate-300 hover:text-amber-500 hover:bg-amber-50"}`}
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill={a.role === "lead" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8"><path d="m12 2.75 2.84 5.75 6.35.92-4.6 4.48 1.09 6.32L12 17.24l-5.68 2.98 1.09-6.32-4.6-4.48 6.35-.92L12 2.75Z" /></svg>
                                            </button>
                                            <button disabled={crewReadOnly} onClick={() => onUnassign(a.userId)} className="text-slate-300 hover:text-red-500 transition shrink-0 disabled:cursor-not-allowed disabled:opacity-40" aria-label={`Remove ${a.user.name || a.user.email} from task`}>
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                    {(task.subAssignments || []).map(a => (
                                        <div key={a.subcontractorId} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2.5 border-l-2 border-purple-400">
                                            <div className="w-7 h-7 rounded-full bg-purple-100 text-purple-700 text-xs font-bold flex items-center justify-center shrink-0">{a.subcontractor.companyName.substring(0, 2).toUpperCase()}</div>
                                            <span className="text-xs font-medium text-hui-textMain flex-1 truncate">{a.subcontractor.companyName} <span className="text-purple-600/70 ml-1 text-xs">(Sub)</span></span>
                                            <button onClick={() => onUnassignSub(a.subcontractorId)} className="text-slate-300 hover:text-red-500 transition shrink-0">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                    {!hasTeam && <p className="text-xs text-slate-400 italic">No one assigned</p>}
                                </div>
                            </div>
                        </details>

                        <div className="border-t border-slate-100" />

                        {/* Danger Zone — always collapsed */}
                        <details className="group">
                            <summary className="flex items-center gap-2 cursor-pointer select-none py-2 list-none [&::-webkit-details-marker]:hidden">
                                <svg className="w-3.5 h-3.5 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                                <span className={`${SECTION_LABEL} text-red-400`}>Danger Zone</span>
                            </summary>
                            <div className="pb-4 pl-5.5 pt-2">
                                <button onClick={() => { if (confirm("Delete this task?")) onDelete(task.id); }} className="text-xs text-red-500 hover:text-red-700 font-semibold transition flex items-center gap-1.5">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                                    Delete Task
                                </button>
                            </div>
                        </details>
                    </div>
                )}

                {panelTab === "punch" && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2">
                            <button onClick={onAiPunchlist} disabled={isAiPunching} className={`text-xs flex items-center gap-1 px-3 py-2 rounded-lg font-medium transition border ${isAiPunching ? "bg-purple-100 text-purple-700 border-purple-300 animate-pulse" : "bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100"}`}>
                                ✨ {isAiPunching ? "Generating..." : "AI Punchlist"}
                            </button>
                            <span className="text-xs text-slate-400">{punchItems.filter(p => p.completed).length}/{punchItems.length} done</span>
                        </div>
                        {punchItems.map(item => (
                            <div key={item.id} className="flex items-start gap-2.5 group py-0.5">
                                <button onClick={() => onTogglePunch(item.id)} className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center transition shrink-0 ${item.completed ? "bg-green-500 border-green-500 text-white" : "border-slate-300 hover:border-green-400"}`}>
                                    {item.completed && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>}
                                </button>
                                <span className={`text-sm flex-1 ${item.completed ? "line-through text-slate-400" : "text-hui-textMain"}`}>{item.name}</span>
                                <button onClick={() => onDeletePunch(item.id)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition p-0.5">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                </button>
                            </div>
                        ))}
                        <div className="flex gap-2 mt-3">
                            <input value={newPunchName} onChange={e => setNewPunchName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAddPunchLocal(); }} className="hui-input text-sm flex-1" placeholder="Add punch item..." />
                            <button onClick={handleAddPunchLocal} className="hui-btn hui-btn-primary text-xs px-3">+</button>
                        </div>
                    </div>
                )}

                {panelTab === "conversation" && (
                    <div className="space-y-4">
                        {comments.length === 0 && <p className="text-xs text-slate-400 italic text-center py-6">No comments yet</p>}
                        {comments.map(c => {
                            const authorName = c.user?.name || c.user?.email || c.subcontractorName || "Unknown";
                            const initialsName = c.user?.name ?? c.subcontractorName ?? null;
                            const initialsEmail = c.user?.email ?? "";
                            const photos = c.photos ?? [];
                            return (
                                <div key={c.id} className="flex gap-2.5">
                                    <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{getInitials(initialsName, initialsEmail)}</div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2"><span className="text-xs font-semibold text-hui-textMain">{authorName}</span><span className="text-xs text-slate-400">{new Date(c.createdAt).toLocaleDateString()}</span></div>
                                        <p className="text-sm text-hui-textMuted mt-0.5 leading-relaxed">{c.text}</p>
                                        {photos.length > 0 && (
                                            <div className="mt-2 flex gap-2 flex-wrap">
                                                {photos.map(p => (
                                                    <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="block">
                                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                                        <img src={p.url} alt="" className="w-20 h-20 object-cover rounded-lg border border-hui-border hover:opacity-90 transition" />
                                                    </a>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                        <div className="flex gap-2 mt-3 pt-3 border-t border-hui-border">
                            <input value={newComment} onChange={e => setNewComment(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAddCommentLocal(); }} className="hui-input text-sm flex-1" placeholder="Add a comment..." />
                            <button onClick={handleAddCommentLocal} className="hui-btn hui-btn-primary text-xs px-4">Send</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
