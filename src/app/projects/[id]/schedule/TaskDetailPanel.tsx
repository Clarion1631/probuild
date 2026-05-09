"use client";

import { useState } from "react";
import type { Task, PunchItem, Comment, TeamMember, Subcontractor, EstimateItemSummary } from "./schedule-types";
import { STATUS_OPTIONS, getInitials, formatCurrency } from "./schedule-utils";

const ESTIMATE_LINK_STOPWORDS = new Set(["and", "or", "the", "a", "to", "of", "with", "for", "in", "on", "at", "&"]);
function tokenizeForMatch(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !ESTIMATE_LINK_STOPWORDS.has(t));
}

export type TaskDetailPanelProps = {
    task: Task;
    onClose: () => void;
    panelTab: "details" | "punch" | "conversation";
    setPanelTab: (tab: "details" | "punch" | "conversation") => void;
    onStatusChange: (taskId: string, status: string) => void;
    onNameChange: (taskId: string, name: string) => void;
    onDateChange: (taskId: string, field: "startDate" | "endDate", value: string) => void;
    onEstimatedHoursChange: (taskId: string, hours: number) => void;
    onDelete: (taskId: string) => void;
    estimateItems: EstimateItemSummary[];
    onLinkEstimateItem: (taskId: string, item: EstimateItemSummary) => void;
    onUnlinkEstimateItem: (taskId: string) => void;
    onFetchEstimateItems: () => void;
    teamMembers: TeamMember[];
    subcontractors: Subcontractor[];
    onAssign: (userId: string) => void;
    onUnassign: (userId: string) => void;
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
};

export default function TaskDetailPanel({
    task, onClose, panelTab, setPanelTab,
    onStatusChange, onNameChange, onDateChange, onEstimatedHoursChange, onDelete,
    estimateItems, onLinkEstimateItem, onUnlinkEstimateItem, onFetchEstimateItems,
    teamMembers, subcontractors, onAssign, onUnassign, onAssignSub, onUnassignSub,
    punchItems, onAddPunch, onTogglePunch, onDeletePunch, onAiPunchlist, isAiPunching,
    comments, onAddComment,
    showCriticalPath, criticalPathIds,
}: TaskDetailPanelProps) {
    const [showAssignMenu, setShowAssignMenu] = useState(false);
    const [showEstimateLinkMenu, setShowEstimateLinkMenu] = useState(false);
    const [estimateQuery, setEstimateQuery] = useState("");
    const [newPunchName, setNewPunchName] = useState("");
    const [newComment, setNewComment] = useState("");
    const [nameDraft, setNameDraft] = useState(task.name);
    const [nameDirty, setNameDirty] = useState(false);

    function handleNameSave() {
        const next = nameDraft.trim();
        if (!nameDirty || !next || next === task.name) { setNameDirty(false); setNameDraft(task.name); return; }
        onNameChange(task.id, next);
        setNameDirty(false);
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
        <div className="w-96 shrink-0 bg-white border-l border-hui-border flex flex-col z-10 shadow-lg animate-in slide-in-from-right-5">
            {/* Panel Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-hui-border bg-slate-50">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    {task.type === "milestone" && (
                        <div className="w-3 h-3 rotate-45 shrink-0" style={{ backgroundColor: task.color }} />
                    )}
                    <h3 className="text-sm font-bold text-hui-textMain truncate">{task.name}</h3>
                </div>
                <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1 rounded-md hover:bg-slate-100 transition">
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
            <div className="flex-1 overflow-y-auto p-4">
                {panelTab === "details" && (
                    <div className="space-y-5">
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Task Name</label>
                            <input
                                type="text"
                                value={nameDirty ? nameDraft : task.name}
                                onChange={e => { setNameDraft(e.target.value); setNameDirty(true); }}
                                onBlur={handleNameSave}
                                onKeyDown={e => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } else if (e.key === "Escape") { setNameDraft(task.name); setNameDirty(false); (e.target as HTMLInputElement).blur(); } }}
                                className="hui-input text-sm mt-1 w-full"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Status</label>
                            <select value={task.status} onChange={e => onStatusChange(task.id, e.target.value)} className="hui-input text-sm mt-1 w-full">
                                {STATUS_OPTIONS.map(s => (<option key={s} value={s}>{s}</option>))}
                            </select>
                        </div>
                        {task.type === "milestone" ? (
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Date</label>
                                <input type="date" value={task.startDate} onChange={e => onDateChange(task.id, "startDate", e.target.value)} className="hui-input text-sm mt-1 w-full" />
                            </div>
                        ) : (
                            <>
                                <div className="grid grid-cols-2 gap-3">
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Start</label><input type="date" value={task.startDate} onChange={e => onDateChange(task.id, "startDate", e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">End</label><input type="date" value={task.endDate} onChange={e => onDateChange(task.id, "endDate", e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>
                                </div>
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Estimated Hours</label>
                                    <input type="number" value={task.estimatedHours ?? ""} onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onEstimatedHoursChange(task.id, v); }} className="hui-input text-sm mt-1 w-full" placeholder="e.g. 40" />
                                </div>
                            </>
                        )}
                        {/* Estimate Item Link */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Estimate Link</label>
                                {task.estimateItem ? (
                                    <button onClick={() => onUnlinkEstimateItem(task.id)} className="text-[10px] text-red-500 hover:text-red-700 font-semibold transition">Remove</button>
                                ) : (
                                    <div className="relative">
                                        <button onClick={handleShowEstimateLink} className="text-[10px] text-indigo-600 font-semibold hover:text-indigo-800 transition">+ Link</button>
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
                                            const renderItem = (item: EstimateItemSummary, keyPrefix = "") => (
                                                <button
                                                    key={`${keyPrefix}${item.id}`}
                                                    onClick={() => { onLinkEstimateItem(task.id, item); setShowEstimateLinkMenu(false); setEstimateQuery(""); }}
                                                    className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-xs"
                                                >
                                                    <div className="font-medium truncate">{item.name}</div>
                                                    <div className="text-slate-400">{item.type} · {formatCurrency(item.total)}</div>
                                                </button>
                                            );
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
                                                <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 w-72 max-h-72 flex flex-col animate-in fade-in">
                                                    <div className="p-2 border-b border-hui-border" onClick={e => e.stopPropagation()}>
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
                                                            <div className="px-3 py-2 text-xs text-slate-400">No estimate line items found.<br /><span className="text-slate-300">Add items to an estimate first.</span></div>
                                                        ) : query ? (
                                                            filtered.length === 0 ? (
                                                                <div className="px-3 py-2 text-xs text-slate-400">No items match &ldquo;{query}&rdquo;</div>
                                                            ) : (
                                                                filtered.map(item => renderItem(item))
                                                            )
                                                        ) : (
                                                            <>
                                                                {suggested.length > 0 && (
                                                                    <div>
                                                                        <div className="px-3 py-1.5 text-[10px] font-bold text-indigo-500 uppercase tracking-wider bg-indigo-50 sticky top-0">Suggested</div>
                                                                        {suggested.map(item => renderItem(item, "sug-"))}
                                                                    </div>
                                                                )}
                                                                {sections.map(([sectionName, sectionItems]) => (
                                                                    <div key={sectionName || "__ungrouped"}>
                                                                        {sectionName && <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50 sticky top-0">{sectionName}</div>}
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
                                <div className="bg-blue-50 rounded-lg px-3 py-2 border border-blue-100">
                                    <div className="text-xs font-semibold text-blue-800 truncate">{task.estimateItem.name}</div>
                                    <div className="flex items-center gap-3 mt-1">
                                        <span className="text-[10px] text-blue-600 capitalize">{task.estimateItem.type}</span>
                                        <span className="text-[10px] font-semibold text-blue-700">{formatCurrency(task.estimateItem.total)} budget</span>
                                        {task.estimatedHours && <span className="text-[10px] text-blue-500">{task.estimatedHours}h est.</span>}
                                    </div>
                                </div>
                            ) : (
                                <p className="text-xs text-slate-400 italic">Not linked to an estimate item</p>
                            )}
                        </div>
                        {/* Critical Path indicator */}
                        {showCriticalPath && criticalPathIds.has(task.id) && (
                            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center gap-2">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                                <span className="text-xs font-semibold text-red-700">On critical path</span>
                            </div>
                        )}
                        {/* Assigned Members */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned</label>
                                <div className="relative">
                                    <button onClick={() => setShowAssignMenu(!showAssignMenu)} className="text-[10px] text-indigo-600 font-semibold hover:text-indigo-800 transition">+ Add</button>
                                    {showAssignMenu && (
                                        <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[220px] py-1 animate-in fade-in max-h-60 overflow-y-auto">
                                            <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50">Team Members</div>
                                            {teamMembers.filter(m => !(task.assignments || []).some(a => a.userId === m.id)).map(m => (
                                                <button key={m.id} onClick={() => { onAssign(m.id); setShowAssignMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition flex items-center gap-2 text-xs">
                                                    <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-bold flex items-center justify-center shrink-0">{getInitials(m.name, m.email)}</div>
                                                    <span className="truncate">{m.name || m.email}</span>
                                                </button>
                                            ))}
                                            <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50 mt-1 border-t border-hui-border">Subcontractors</div>
                                            {subcontractors.filter(s => !(task.subAssignments || []).some(a => a.subcontractorId === s.id)).map(s => (
                                                <button key={s.id} onClick={() => { onAssignSub(s.id); setShowAssignMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition flex items-center gap-2 text-xs">
                                                    <div className="w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-[9px] font-bold flex items-center justify-center shrink-0">{s.companyName.substring(0,2).toUpperCase()}</div>
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
                                    <div key={a.userId} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                                        <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold flex items-center justify-center shrink-0">{getInitials(a.user.name, a.user.email)}</div>
                                        <span className="text-xs font-medium text-hui-textMain flex-1 truncate">{a.user.name || a.user.email}</span>
                                        <button onClick={() => onUnassign(a.userId)} className="text-slate-300 hover:text-red-500 transition shrink-0">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                ))}
                                {(task.subAssignments || []).map(a => (
                                    <div key={a.subcontractorId} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2 border-l-2 border-purple-400">
                                        <div className="w-7 h-7 rounded-full bg-purple-100 text-purple-700 text-[10px] font-bold flex items-center justify-center shrink-0">{a.subcontractor.companyName.substring(0, 2).toUpperCase()}</div>
                                        <span className="text-xs font-medium text-hui-textMain flex-1 truncate">{a.subcontractor.companyName} <span className="text-purple-600/70 ml-1 text-[10px]">(Sub)</span></span>
                                        <button onClick={() => onUnassignSub(a.subcontractorId)} className="text-slate-300 hover:text-red-500 transition shrink-0">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                ))}
                                {(task.assignments || []).length === 0 && (task.subAssignments || []).length === 0 && <p className="text-xs text-slate-400 italic">No one assigned</p>}
                            </div>
                        </div>
                        {/* Delete */}
                        <div className="pt-3 border-t border-hui-border">
                            <button onClick={() => { if (confirm("Delete this task?")) onDelete(task.id); }} className="text-xs text-red-500 hover:text-red-700 font-semibold transition">Delete Task</button>
                        </div>
                    </div>
                )}

                {panelTab === "punch" && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2">
                            <button onClick={onAiPunchlist} disabled={isAiPunching} className={`text-xs flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-medium transition border ${isAiPunching ? "bg-purple-100 text-purple-700 border-purple-300 animate-pulse" : "bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100"}`}>
                                ✨ {isAiPunching ? "Generating..." : "AI Punchlist"}
                            </button>
                            <span className="text-[10px] text-slate-400">{punchItems.filter(p => p.completed).length}/{punchItems.length} done</span>
                        </div>
                        {punchItems.map(item => (
                            <div key={item.id} className="flex items-start gap-2 group">
                                <button onClick={() => onTogglePunch(item.id)} className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center transition shrink-0 ${item.completed ? "bg-green-500 border-green-500 text-white" : "border-slate-300 hover:border-green-400"}`}>
                                    {item.completed && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>}
                                </button>
                                <span className={`text-xs flex-1 ${item.completed ? "line-through text-slate-400" : "text-hui-textMain"}`}>{item.name}</span>
                                <button onClick={() => onDeletePunch(item.id)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition">
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                </button>
                            </div>
                        ))}
                        <div className="flex gap-2 mt-2">
                            <input value={newPunchName} onChange={e => setNewPunchName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAddPunchLocal(); }} className="hui-input text-xs flex-1" placeholder="Add punch item..." />
                            <button onClick={handleAddPunchLocal} className="hui-btn hui-btn-primary text-xs px-2">+</button>
                        </div>
                    </div>
                )}

                {panelTab === "conversation" && (
                    <div className="space-y-3">
                        {comments.length === 0 && <p className="text-xs text-slate-400 italic text-center py-4">No comments yet</p>}
                        {comments.map(c => (
                            <div key={c.id} className="flex gap-2">
                                <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-[8px] font-bold flex items-center justify-center shrink-0 mt-0.5">{getInitials(c.user.name, c.user.email)}</div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2"><span className="text-xs font-semibold text-hui-textMain">{c.user.name || c.user.email}</span><span className="text-[9px] text-slate-400">{new Date(c.createdAt).toLocaleDateString()}</span></div>
                                    <p className="text-xs text-hui-textMuted mt-0.5">{c.text}</p>
                                </div>
                            </div>
                        ))}
                        <div className="flex gap-2 mt-3 pt-3 border-t border-hui-border">
                            <input value={newComment} onChange={e => setNewComment(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAddCommentLocal(); }} className="hui-input text-xs flex-1" placeholder="Add a comment..." />
                            <button onClick={handleAddCommentLocal} className="hui-btn hui-btn-primary text-xs px-3">Send</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
