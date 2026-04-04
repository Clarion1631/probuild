"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createTimeEntry, updateTimeEntry, deleteTimeEntry } from "./actions";

type UserBasic = { id: string; name: string | null; email: string; hourlyRate?: number };
type CostCodeBasic = { id: string; name: string; code: string };

type TimeEntryDetailed = {
    id: string;
    userId: string;
    projectId: string;
    costCodeId: string | null;
    startTime: Date;
    endTime: Date | null;
    durationHours: number | null;
    laborCost: number | null;
    isBillable: boolean;
    isTaxable: boolean;
    costRate: number | null;
    description: string | null;
    user: { id: string; name: string | null; email: string };
    costCode: CostCodeBasic | null;
};

interface TimeClockClientProps {
    project: { id: string; name: string };
    initialEntries: any[];
    costCodes: CostCodeBasic[];
    teamMembers: UserBasic[];
    currentUser: { id: string; role: string; name: string };
}

type SortKey = "date" | "user" | "costCode" | "hours" | "cost";
type SortDir = "asc" | "desc";

// Icon components
const ClockIcon = () => (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
);
const PlusIcon = () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
);
const PencilIcon = () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
    </svg>
);
const TrashIcon = () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
);
const SortIcon = ({ active, dir }: { active: boolean; dir: SortDir }) => (
    <svg className={`w-3.5 h-3.5 ml-1 inline-block transition ${active ? "text-hui-primary" : "text-slate-300"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
        {dir === "asc" ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7l4-4 4 4M8 17l4 4 4-4" />
        ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7l4-4 4 4M8 17l4 4 4-4" />
        )}
    </svg>
);
const CalendarIcon = () => (
    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
    </svg>
);
const UserIcon = () => (
    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
    </svg>
);

function formatHours(h: number | null): string {
    if (h === null || h === undefined) return "0h";
    if (h === 0) return "Unit";
    return `${parseFloat(h.toFixed(2))}h`;
}

export default function TimeClockClient({
    project,
    initialEntries,
    costCodes,
    teamMembers,
    currentUser
}: TimeClockClientProps) {
    const router = useRouter();
    const [entries] = useState<TimeEntryDetailed[]>(initialEntries);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Sort state
    const [sortKey, setSortKey] = useState<SortKey>("date");
    const [sortDir, setSortDir] = useState<SortDir>("desc");

    // Filter state
    const [filterUser, setFilterUser] = useState("");
    const [filterCostCode, setFilterCostCode] = useState("");

    // Form State
    const [editId, setEditId] = useState<string | null>(null);
    const [selectedUserId, setSelectedUserId] = useState(currentUser.id);
    const [selectedCostCodeId, setSelectedCostCodeId] = useState("");
    const [entryType, setEntryType] = useState<"hourly" | "unit">("hourly");
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [hours, setHours] = useState("");
    const [manualCost, setManualCost] = useState("");
    const [isBillable, setIsBillable] = useState(true);
    const [isTaxable, setIsTaxable] = useState(true);
    const [costRate, setCostRate] = useState("");
    const [description, setDescription] = useState("");

    const isAdminOrManager = currentUser.role === "ADMIN" || currentUser.role === "MANAGER";

    const handleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir(d => d === "asc" ? "desc" : "asc");
        } else {
            setSortKey(key);
            setSortDir("asc");
        }
    };

    const sortedEntries = useMemo(() => {
        let filtered = [...entries];
        if (filterUser) filtered = filtered.filter(e => e.userId === filterUser);
        if (filterCostCode) filtered = filtered.filter(e => e.costCodeId === filterCostCode);

        return filtered.sort((a, b) => {
            let cmp = 0;
            switch (sortKey) {
                case "date":
                    cmp = new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
                    break;
                case "user":
                    cmp = (a.user.name || a.user.email).localeCompare(b.user.name || b.user.email);
                    break;
                case "costCode":
                    cmp = (a.costCode?.code || "zzz").localeCompare(b.costCode?.code || "zzz");
                    break;
                case "hours":
                    cmp = (a.durationHours || 0) - (b.durationHours || 0);
                    break;
                case "cost":
                    cmp = (a.laborCost || 0) - (b.laborCost || 0);
                    break;
            }
            return sortDir === "asc" ? cmp : -cmp;
        });
    }, [entries, sortKey, sortDir, filterUser, filterCostCode]);

    // Totals
    const totalHours = useMemo(() => sortedEntries.reduce((s, e) => s + (e.durationHours || 0), 0), [sortedEntries]);
    const totalCost = useMemo(() => sortedEntries.reduce((s, e) => s + (e.laborCost || 0), 0), [sortedEntries]);
    const totalBillable = useMemo(() => sortedEntries.filter(e => e.isBillable).reduce((s, e) => s + (e.laborCost || 0), 0), [sortedEntries]);
    const totalNonBillable = useMemo(() => sortedEntries.filter(e => !e.isBillable).reduce((s, e) => s + (e.laborCost || 0), 0), [sortedEntries]);

    const openModal = (entry?: TimeEntryDetailed) => {
        if (entry) {
            setEditId(entry.id);
            setSelectedUserId(entry.userId);
            setSelectedCostCodeId(entry.costCodeId || "");
            const d = new Date(entry.startTime);
            setDate(d.toISOString().split('T')[0]);
            setIsBillable(entry.isBillable ?? true);
            setIsTaxable(entry.isTaxable ?? true);
            setCostRate(entry.costRate != null ? entry.costRate.toString() : "");
            setDescription(entry.description || "");
            if (entry.durationHours === 0 && entry.laborCost !== null) {
                setEntryType("unit");
                setManualCost(entry.laborCost.toString());
                setHours("");
            } else {
                setEntryType("hourly");
                setHours(entry.durationHours != null ? parseFloat(entry.durationHours.toFixed(2)).toString() : "");
                setManualCost("");
            }
        } else {
            setEditId(null);
            setSelectedUserId(currentUser.id);
            setSelectedCostCodeId("");
            setEntryType("hourly");
            setDate(new Date().toISOString().split('T')[0]);
            setHours("");
            setManualCost("");
            setIsBillable(true);
            setIsTaxable(true);
            setDescription("");
            // Auto-fill cost rate from current user's hourly rate
            const me = teamMembers.find(u => u.id === currentUser.id);
            setCostRate(me?.hourlyRate ? me.hourlyRate.toString() : "");
        }
        setIsModalOpen(true);
    };

    const closeModal = () => setIsModalOpen(false);

    // Live cost preview: costRate × hours (or manual cost for unit entries)
    const computedCost = useMemo(() => {
        if (entryType === "hourly") {
            const h = parseFloat(hours) || 0;
            const rate = parseFloat(costRate) || 0;
            return h * rate;
        }
        return parseFloat(manualCost) || 0;
    }, [entryType, hours, costRate, manualCost]);

    const handleSubmit = async (e: React.FormEvent, logAnother = false) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            let duration = 0;
            let cost = 0;
            if (entryType === "hourly") {
                duration = parseFloat(hours) || 0;
                const rate = parseFloat(costRate) || 0;
                cost = duration * rate;
            } else {
                duration = 0;
                cost = parseFloat(manualCost) || 0;
            }
            const payload = {
                projectId: project.id,
                userId: selectedUserId,
                costCodeId: selectedCostCodeId || null,
                date,
                durationHours: duration,
                laborCost: cost,
                isBillable,
                isTaxable,
                costRate: costRate ? parseFloat(costRate) : null,
                description: description.trim() || undefined,
            };
            if (editId) {
                await updateTimeEntry(editId, payload);
                toast.success("Time entry updated");
            } else {
                await createTimeEntry(payload);
                toast.success("Time entry added");
            }
            router.refresh();
            if (logAnother) {
                // Reset form for next entry but keep user, date, cost code
                setEditId(null);
                setHours("");
                setManualCost("");
                setDescription("");
                toast.success("Entry saved — log another");
            } else {
                closeModal();
            }
        } catch (error: any) {
            toast.error(error.message || "Something went wrong");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Delete this time entry?")) return;
        try {
            await deleteTimeEntry(id);
            toast.success("Deleted successfully");
            router.refresh();
        } catch (error: any) {
            toast.error(error.message || "Failed to delete");
        }
    };

    const ThSortable = ({ label, sortK, className = "" }: { label: string; sortK: SortKey; className?: string }) => (
        <th
            className={`px-5 py-3.5 font-semibold cursor-pointer select-none hover:text-hui-primary transition group ${className}`}
            onClick={() => handleSort(sortK)}
        >
            <span className="inline-flex items-center gap-1">
                {label}
                <span className={`transition ${sortKey === sortK ? "opacity-100" : "opacity-0 group-hover:opacity-50"}`}>
                    {sortKey === sortK && sortDir === "asc" ? "↑" : "↓"}
                </span>
            </span>
        </th>
    );

    return (
        <div className="w-full max-w-6xl mx-auto pb-20">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
                        <ClockIcon />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-hui-textMain">Time Clock</h1>
                        <p className="text-sm text-hui-textLight">Manage time and labor costs for {project.name}</p>
                    </div>
                </div>
                <button
                    onClick={() => openModal()}
                    className="hui-btn-primary px-5 py-2.5 flex items-center gap-2 rounded-lg shadow-md hover:shadow-lg transition-all"
                >
                    <PlusIcon />
                    Add Time Entry
                </button>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div className="bg-white rounded-xl p-4 border border-hui-border shadow-sm flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
                        <ClockIcon />
                    </div>
                    <div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Total Duration</p>
                        <p className="text-xl font-bold text-hui-textMain">{parseFloat(totalHours.toFixed(2))}h</p>
                    </div>
                </div>
                <div className="bg-white rounded-xl p-4 border border-hui-border shadow-sm flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Total Billable</p>
                        <p className="text-xl font-bold text-emerald-600">${totalBillable.toFixed(2)}</p>
                    </div>
                </div>
                <div className="bg-white rounded-xl p-4 border border-hui-border shadow-sm flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center text-amber-600">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Total Cost</p>
                        <p className="text-xl font-bold text-hui-textMain">${totalCost.toFixed(2)}</p>
                    </div>
                </div>
                <div className="bg-white rounded-xl p-4 border border-hui-border shadow-sm flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                    </div>
                    <div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Non-Billable</p>
                        <p className="text-xl font-bold text-slate-500">${totalNonBillable.toFixed(2)}</p>
                    </div>
                </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-3 mb-4">
                <select
                    className="hui-input text-sm py-1.5 px-3 rounded-lg min-w-[160px]"
                    value={filterUser}
                    onChange={e => setFilterUser(e.target.value)}
                >
                    <option value="">All Team Members</option>
                    {teamMembers.map(m => (
                        <option key={m.id} value={m.id}>{m.name || m.email}</option>
                    ))}
                </select>
                <select
                    className="hui-input text-sm py-1.5 px-3 rounded-lg min-w-[160px]"
                    value={filterCostCode}
                    onChange={e => setFilterCostCode(e.target.value)}
                >
                    <option value="">All Cost Codes</option>
                    {costCodes.map(cc => (
                        <option key={cc.id} value={cc.id}>{cc.code} - {cc.name}</option>
                    ))}
                </select>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                <table className="w-full text-left text-sm text-hui-textMain">
                    <thead className="bg-slate-50 border-b border-hui-border text-[11px] uppercase text-hui-textMuted tracking-wider">
                        <tr>
                            <ThSortable label="Date" sortK="date" />
                            <ThSortable label="Team Member" sortK="user" />
                            <ThSortable label="Cost Code" sortK="costCode" />
                            <ThSortable label="Hours" sortK="hours" className="text-right" />
                            <ThSortable label="Cost" sortK="cost" className="text-right" />
                            <th className="px-5 py-3.5 font-semibold text-center">Billable</th>
                            <th className="px-5 py-3.5 font-semibold text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {sortedEntries.length === 0 ? (
                            <tr>
                                <td colSpan={7} className="px-6 py-12 text-center">
                                    <div className="flex flex-col items-center gap-2">
                                        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-300">
                                            <ClockIcon />
                                        </div>
                                        <p className="text-hui-textLight font-medium">No time entries found</p>
                                        <p className="text-xs text-slate-400">Click &ldquo;Add Time Entry&rdquo; to get started</p>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            sortedEntries.map((entry) => (
                                <tr key={entry.id} className="hover:bg-slate-50/80 transition group">
                                    <td className="px-5 py-3.5 whitespace-nowrap">
                                        <div className="flex items-center gap-2">
                                            <CalendarIcon />
                                            <span className="font-medium">{new Date(entry.startTime).toLocaleDateString()}</span>
                                        </div>
                                    </td>
                                    <td className="px-5 py-3.5">
                                        <div className="flex items-center gap-2.5">
                                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                                                {(entry.user.name || entry.user.email).charAt(0).toUpperCase()}
                                            </div>
                                            <span className="font-medium">{entry.user.name || entry.user.email}</span>
                                        </div>
                                    </td>
                                    <td className="px-5 py-3.5">
                                        {entry.costCode ? (
                                            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
                                                {entry.costCode.code} – {entry.costCode.name}
                                            </span>
                                        ) : (
                                            <span className="text-slate-400 italic text-xs">Unassigned</span>
                                        )}
                                    </td>
                                    <td className="px-5 py-3.5 text-right font-semibold tabular-nums">
                                        {entry.durationHours === 0
                                            ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium border border-amber-100">Unit</span>
                                            : formatHours(entry.durationHours)
                                        }
                                    </td>
                                    <td className="px-5 py-3.5 text-right font-semibold tabular-nums">
                                        ${(entry.laborCost || 0).toFixed(2)}
                                    </td>
                                    <td className="px-5 py-3.5 text-center">
                                        <div className="flex flex-wrap items-center justify-center gap-1">
                                            {entry.isBillable ? (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-100">Billable</span>
                                            ) : (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">Non-billable</span>
                                            )}
                                            {entry.isTaxable && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100">Taxable</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-5 py-3.5 text-right">
                                        {(isAdminOrManager || entry.userId === currentUser.id) && (
                                            <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition">
                                                <button
                                                    onClick={() => openModal(entry)}
                                                    className="p-1.5 rounded-lg text-slate-400 hover:text-hui-primary hover:bg-blue-50 transition"
                                                    title="Edit"
                                                >
                                                    <PencilIcon />
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(entry.id)}
                                                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition"
                                                    title="Delete"
                                                >
                                                    <TrashIcon />
                                                </button>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                    {sortedEntries.length > 0 && (
                        <tfoot className="bg-slate-50 border-t border-hui-border">
                            <tr className="text-sm font-bold text-hui-textMain">
                                <td className="px-5 py-3" colSpan={3}>Totals</td>
                                <td className="px-5 py-3 text-right tabular-nums">{parseFloat(totalHours.toFixed(2))}h</td>
                                <td className="px-5 py-3 text-right tabular-nums">${totalCost.toFixed(2)}</td>
                                <td></td>
                                <td></td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>

            {/* Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white">
                                <ClockIcon />
                            </div>
                            <div className="flex-1">
                                <h3 className="text-base font-bold text-hui-textMain">
                                    {editId ? "Edit Time Entry" : "New Time Entry"}
                                </h3>
                            </div>
                            <button onClick={closeModal} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="p-6 space-y-4">
                            {isAdminOrManager && (
                                <div>
                                    <label className="flex items-center gap-1.5 text-sm font-semibold text-hui-textMain mb-1.5">
                                        <UserIcon /> Team Member
                                    </label>
                                    <select className="hui-input w-full" value={selectedUserId} onChange={(e) => {
                                        setSelectedUserId(e.target.value);
                                        const member = teamMembers.find(u => u.id === e.target.value);
                                        if (member?.hourlyRate) setCostRate(member.hourlyRate.toString());
                                    }} required>
                                        {teamMembers.map(m => (
                                            <option key={m.id} value={m.id}>{m.name || m.email}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            <div>
                                <label className="flex items-center gap-1.5 text-sm font-semibold text-hui-textMain mb-1.5">
                                    <CalendarIcon /> Date
                                </label>
                                <input type="date" className="hui-input w-full" value={date} onChange={(e) => setDate(e.target.value)} required />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Cost Code / Phase</label>
                                <select className="hui-input w-full" value={selectedCostCodeId} onChange={(e) => setSelectedCostCodeId(e.target.value)}>
                                    <option value="">— Unassigned —</option>
                                    {costCodes.map(cc => (
                                        <option key={cc.id} value={cc.id}>{cc.code} - {cc.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="pt-3 border-t border-slate-100">
                                <label className="block text-sm font-semibold text-hui-textMain mb-2">Entry Type</label>
                                <div className="grid grid-cols-2 gap-2 mb-4">
                                    <button
                                        type="button"
                                        onClick={() => setEntryType("hourly")}
                                        className={`py-2 px-3 rounded-lg text-sm font-medium border transition ${entryType === "hourly" ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"}`}
                                    >
                                        ⏱ Hourly
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setEntryType("unit")}
                                        className={`py-2 px-3 rounded-lg text-sm font-medium border transition ${entryType === "unit" ? "bg-amber-50 border-amber-300 text-amber-700" : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"}`}
                                    >
                                        📦 Unit / Fixed
                                    </button>
                                </div>
                                {entryType === "hourly" ? (
                                    <div>
                                        <label className="block text-sm font-semibold text-hui-textMain mb-1">Hours Worked</label>
                                        <input type="number" step="0.25" min="0" className="hui-input w-full" value={hours} onChange={(e) => setHours(e.target.value)} required={entryType === "hourly"} placeholder="e.g. 8" />
                                    </div>
                                ) : (
                                    <div>
                                        <label className="block text-sm font-semibold text-hui-textMain mb-1">Total Labor Cost ($)</label>
                                        <input type="number" step="0.01" min="0" className="hui-input w-full" value={manualCost} onChange={(e) => setManualCost(e.target.value)} required={entryType === "unit"} placeholder="e.g. 150.00" />
                                        <p className="text-xs text-slate-400 mt-1">For piece-rate or unit-based pay</p>
                                    </div>
                                )}
                            </div>
                            {/* Cost Rate + Live Preview */}
                            <div>
                                <label className="block text-sm font-semibold text-hui-textMain mb-1">Cost Rate ($/hr)</label>
                                <input type="number" step="0.01" min="0" className="hui-input w-full" value={costRate} onChange={(e) => setCostRate(e.target.value)} placeholder="Auto-filled from employee record" />
                                <p className="text-xs text-slate-400 mt-1">Employee&apos;s cost rate — auto-filled from profile</p>
                            </div>
                            {/* Live Cost Preview */}
                            {(entryType === "hourly" && parseFloat(hours) > 0 && parseFloat(costRate) > 0) && (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 text-sm">
                                    <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    <span className="text-blue-700">
                                        {parseFloat(hours)}h &times; ${parseFloat(costRate).toFixed(2)}/hr = <strong>${computedCost.toFixed(2)}</strong>
                                    </span>
                                </div>
                            )}

                            {/* Billable & Taxable Toggles */}
                            <div className="space-y-3 pt-1">
                                <div className="flex items-center justify-between py-1">
                                    <div>
                                        <label className="text-sm font-semibold text-hui-textMain">Billable</label>
                                        <p className="text-xs text-slate-400">Include in client invoicing</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setIsBillable(!isBillable)}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isBillable ? "bg-emerald-500" : "bg-slate-300"}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${isBillable ? "translate-x-6" : "translate-x-1"}`} />
                                    </button>
                                </div>
                                <div className="flex items-center justify-between py-1">
                                    <div>
                                        <label className="text-sm font-semibold text-hui-textMain">Taxable</label>
                                        <p className="text-xs text-slate-400">Subject to sales tax</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setIsTaxable(!isTaxable)}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isTaxable ? "bg-blue-500" : "bg-slate-300"}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${isTaxable ? "translate-x-6" : "translate-x-1"}`} />
                                    </button>
                                </div>
                            </div>

                            {/* Description */}
                            <div>
                                <label className="block text-sm font-semibold text-hui-textMain mb-1">Description</label>
                                <textarea className="hui-input w-full" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was done..." />
                            </div>

                            <div className="pt-4 flex gap-3 justify-end">
                                <button type="button" onClick={closeModal} className="hui-btn-secondary px-4 py-2 rounded-lg" disabled={isSubmitting}>Cancel</button>
                                {!editId && (
                                    <button
                                        type="button"
                                        onClick={(e) => handleSubmit(e as any, true)}
                                        className="px-4 py-2 rounded-lg text-sm font-medium border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100 transition"
                                        disabled={isSubmitting}
                                    >
                                        {isSubmitting ? "Saving..." : "Save & Log Another"}
                                    </button>
                                )}
                                <button type="submit" className="hui-btn-primary px-5 py-2 rounded-lg" disabled={isSubmitting}>
                                    {isSubmitting ? "Saving..." : "Save Entry"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
