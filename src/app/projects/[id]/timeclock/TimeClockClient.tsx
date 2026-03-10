"use client";

import { useState } from "react";
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

export default function TimeClockClient({
    project,
    initialEntries,
    costCodes,
    teamMembers,
    currentUser
}: TimeClockClientProps) {
    const router = useRouter();
    const [entries, setEntries] = useState<TimeEntryDetailed[]>(initialEntries);
    const [isModalOpen, setIsModalOpen] = useState(false);
    
    const [isSubmitting, setIsSubmitting] = useState(false);
    
    // Form State
    const [editId, setEditId] = useState<string | null>(null);
    const [selectedUserId, setSelectedUserId] = useState(currentUser.id);
    const [selectedCostCodeId, setSelectedCostCodeId] = useState("");
    const [entryType, setEntryType] = useState<"hourly" | "unit">("hourly");
    
    // Hourly
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [hours, setHours] = useState("");
    
    // Unit
    const [manualCost, setManualCost] = useState("");

    const isAdminOrManager = currentUser.role === "ADMIN" || currentUser.role === "MANAGER";

    const openModal = (entry?: TimeEntryDetailed) => {
        if (entry) {
            setEditId(entry.id);
            setSelectedUserId(entry.userId);
            setSelectedCostCodeId(entry.costCodeId || "");
            const d = new Date(entry.startTime);
            setDate(d.toISOString().split('T')[0]);
            
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
        }
        setIsModalOpen(true);
    };

    const closeModal = () => setIsModalOpen(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const selectedUser = teamMembers.find(u => u.id === selectedUserId);
            let duration = 0;
            let cost = 0;

            if (entryType === "hourly") {
                duration = parseFloat(hours) || 0;
                cost = duration * (selectedUser?.hourlyRate || 0);
            } else {
                duration = 0; // Unit based doesn't track specific hours usually, or we just put 0 to indicate unit
                cost = parseFloat(manualCost) || 0;
            }

            const payload = {
                projectId: project.id,
                userId: selectedUserId,
                costCodeId: selectedCostCodeId || null,
                date,
                durationHours: duration,
                laborCost: cost
            };

            if (editId) {
                await updateTimeEntry(editId, payload);
                toast.success("Time entry updated");
            } else {
                await createTimeEntry(payload);
                toast.success("Time entry added");
            }
            
            router.refresh();
            closeModal();
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
    }

    return (
        <div className="w-full max-w-5xl mx-auto pb-20">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Time Clock</h1>
                    <p className="text-sm text-hui-textLight">Manage time and labor costs for {project.name}</p>
                </div>
                <button 
                    onClick={() => openModal()}
                    className="hui-btn-primary px-4 py-2"
                >
                    + Add Time Entry
                </button>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                <table className="w-full text-left text-sm text-hui-textMain">
                    <thead className="bg-hui-background border-b border-hui-border text-xs uppercase text-hui-textMuted tracking-wider">
                        <tr>
                            <th className="px-6 py-4 font-semibold">Date</th>
                            <th className="px-6 py-4 font-semibold">Team Member</th>
                            <th className="px-6 py-4 font-semibold">Cost Code</th>
                            <th className="px-6 py-4 font-semibold">Hours</th>
                            <th className="px-6 py-4 font-semibold">Cost</th>
                            <th className="px-6 py-4 font-semibold text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hui-border">
                        {entries.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-6 py-8 text-center text-hui-textLight">
                                    No time entries found for this project.
                                </td>
                            </tr>
                        ) : (
                            entries.map((entry) => (
                                <tr key={entry.id} className="hover:bg-slate-50 transition">
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        {new Date(entry.startTime).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-4">
                                        {entry.user.name || entry.user.email}
                                    </td>
                                    <td className="px-6 py-4">
                                        {entry.costCode ? `${entry.costCode.code} - ${entry.costCode.name}` : <span className="text-slate-400 italic">Unassigned</span>}
                                    </td>
                                    <td className="px-6 py-4 font-medium">
                                        {entry.durationHours === 0 ? <span className="text-slate-400">Unit-based</span> : `${parseFloat((entry.durationHours ?? 0).toFixed(2))}h`}
                                    </td>
                                    <td className="px-6 py-4">
                                        ${(entry.laborCost || 0).toFixed(2)}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        {(isAdminOrManager || entry.userId === currentUser.id) && (
                                            <div className="flex justify-end gap-3">
                                                 <button
                                                    onClick={() => openModal(entry)}
                                                    className="text-hui-textLight hover:text-hui-primary transition"
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(entry.id)}
                                                    className="text-hui-textLight hover:text-red-500 transition"
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {isModalOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                            <h3 className="text-lg font-bold text-hui-textMain">
                                {editId ? "Edit Time Entry" : "Add Time Entry"}
                            </h3>
                            <button onClick={closeModal} className="text-slate-400 hover:text-slate-600">
                                &times;
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="p-6 space-y-4">
                            
                            {isAdminOrManager && (
                                <div>
                                    <label className="block text-sm font-semibold text-hui-textMain mb-1">Team Member</label>
                                    <select 
                                        className="hui-input w-full"
                                        value={selectedUserId}
                                        onChange={(e) => setSelectedUserId(e.target.value)}
                                        required
                                    >
                                        {teamMembers.map(m => (
                                            <option key={m.id} value={m.id}>{m.name || m.email}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            <div>
                                <label className="block text-sm font-semibold text-hui-textMain mb-1">Date</label>
                                <input 
                                    type="date"
                                    className="hui-input w-full"
                                    value={date}
                                    onChange={(e) => setDate(e.target.value)}
                                    required
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-semibold text-hui-textMain mb-1">Cost Code / Phase</label>
                                <select 
                                    className="hui-input w-full"
                                    value={selectedCostCodeId}
                                    onChange={(e) => setSelectedCostCodeId(e.target.value)}
                                >
                                    <option value="">-- Unassigned --</option>
                                    {costCodes.map(cc => (
                                        <option key={cc.id} value={cc.id}>{cc.code} - {cc.name}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="pt-2 border-t border-slate-100">
                                <label className="block text-sm font-semibold text-hui-textMain mb-2">Entry Type</label>
                                <div className="flex gap-4 mb-4">
                                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                                        <input 
                                            type="radio" 
                                            name="type" 
                                            checked={entryType === "hourly"} 
                                            onChange={() => setEntryType("hourly")} 
                                        />
                                        Hourly
                                    </label>
                                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                                        <input 
                                            type="radio" 
                                            name="type" 
                                            checked={entryType === "unit"} 
                                            onChange={() => setEntryType("unit")} 
                                        />
                                        Unit-based (Fixed Cost)
                                    </label>
                                </div>

                                {entryType === "hourly" ? (
                                    <div>
                                        <label className="block text-sm font-semibold text-hui-textMain mb-1">Hours Worked</label>
                                        <input 
                                            type="number"
                                            step="0.25"
                                            min="0"
                                            className="hui-input w-full"
                                            value={hours}
                                            onChange={(e) => setHours(e.target.value)}
                                            required={entryType === "hourly"}
                                            placeholder="e.g. 8"
                                        />
                                    </div>
                                ) : (
                                    <div>
                                        <label className="block text-sm font-semibold text-hui-textMain mb-1">Total Labor Cost ($)</label>
                                        <input 
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            className="hui-input w-full"
                                            value={manualCost}
                                            onChange={(e) => setManualCost(e.target.value)}
                                            required={entryType === "unit"}
                                            placeholder="e.g. 150.00"
                                        />
                                        <p className="text-xs text-slate-500 mt-1">Useful for piece-rate or unit-based pay.</p>
                                    </div>
                                )}
                            </div>

                            <div className="pt-4 flex gap-3 justify-end">
                                <button 
                                    type="button" 
                                    onClick={closeModal}
                                    className="hui-btn-secondary px-4 py-2"
                                    disabled={isSubmitting}
                                >
                                    Cancel
                                </button>
                                <button 
                                    type="submit" 
                                    className="hui-btn-primary px-4 py-2"
                                    disabled={isSubmitting}
                                >
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
