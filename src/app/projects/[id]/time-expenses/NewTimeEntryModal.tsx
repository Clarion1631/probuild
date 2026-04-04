"use client";

import { useState } from "react";
import { toast } from "sonner";
import { createTimeEntry } from "@/lib/time-expense-actions";

interface Props {
    projectId: string;
    teamMembers: { id: string; name: string | null; email: string; hourlyRate?: any }[];
    costCodes: { id: string; name: string; code: string }[];
    currentUserId: string;
    onClose: () => void;
}

export default function NewTimeEntryModal({ projectId, teamMembers, costCodes, currentUserId, onClose }: Props) {
    const [saving, setSaving] = useState(false);
    const [userId, setUserId] = useState(currentUserId);
    const [costCodeId, setCostCodeId] = useState("");
    const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
    const [hours, setHours] = useState("");
    const [rate, setRate] = useState("");
    const [isBillable, setIsBillable] = useState(true);
    const [isTaxable, setIsTaxable] = useState(false);
    const [notes, setNotes] = useState("");

    const selectedMember = teamMembers.find(m => m.id === userId);
    const autoRate = selectedMember?.hourlyRate ? Number(selectedMember.hourlyRate) : 0;
    const effectiveRate = rate ? parseFloat(rate) : autoRate;
    const totalCost = (parseFloat(hours) || 0) * effectiveRate;

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!hours || parseFloat(hours) <= 0) {
            toast.error("Enter valid hours");
            return;
        }
        setSaving(true);
        try {
            await createTimeEntry({
                projectId,
                userId,
                costCodeId: costCodeId || null,
                date,
                durationHours: parseFloat(hours),
                laborCost: totalCost,
                isBillable,
                isTaxable,
                notes,
            });
            toast.success("Time entry added");
            onClose();
        } catch (err: any) {
            toast.error(err.message || "Failed to add time entry");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6">
                <div className="flex items-center justify-between mb-5">
                    <h3 className="text-lg font-bold text-hui-textMain">New Time Entry</h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Team Member</label>
                            <select value={userId} onChange={e => setUserId(e.target.value)} className="hui-input w-full text-sm">
                                {teamMembers.map(m => (
                                    <option key={m.id} value={m.id}>{m.name || m.email}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Date</label>
                            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Hours</label>
                            <input type="number" step="0.25" min="0" value={hours} onChange={e => setHours(e.target.value)} className="hui-input w-full text-sm" placeholder="0.00" />
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Rate ($/hr)</label>
                            <input type="number" step="0.01" min="0" value={rate} onChange={e => setRate(e.target.value)} className="hui-input w-full text-sm" placeholder={autoRate > 0 ? `Auto: $${autoRate}` : "0.00"} />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Cost Code</label>
                        <select value={costCodeId} onChange={e => setCostCodeId(e.target.value)} className="hui-input w-full text-sm">
                            <option value="">None</option>
                            {costCodes.map(cc => (
                                <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Notes</label>
                        <textarea value={notes} onChange={e => setNotes(e.target.value)} className="hui-input w-full text-sm" rows={2} placeholder="Optional notes..." />
                    </div>

                    <div className="flex items-center gap-6">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={isBillable} onChange={e => setIsBillable(e.target.checked)} className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary" />
                            <span className="text-sm text-slate-700">Billable</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={isTaxable} onChange={e => setIsTaxable(e.target.checked)} className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary" />
                            <span className="text-sm text-slate-700">Taxable</span>
                        </label>
                    </div>

                    {(parseFloat(hours) || 0) > 0 && (
                        <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-600">
                            <span className="font-medium">{hours}h</span> x <span className="font-medium">${effectiveRate.toFixed(2)}/hr</span> = <span className="font-bold text-hui-textMain">${totalCost.toFixed(2)}</span>
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                        <button type="button" onClick={onClose} className="hui-btn hui-btn-secondary text-sm px-4 py-2">Cancel</button>
                        <button type="submit" disabled={saving} className="hui-btn hui-btn-green text-sm px-4 py-2">
                            {saving ? "Saving..." : "Add Entry"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
