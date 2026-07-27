"use client";

import { useState } from "react";
import { toast } from "sonner";
import { createTimeEntry } from "@/lib/time-expense-actions";
import { formatCurrency } from "@/lib/utils";
function todayInTimeZone(timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}
interface Props {
    projectId: string;
    teamMembers: { id: string; name: string | null; email: string; hourlyRate?: any; burdenRate?: any }[];
    costCodes: { id: string; name: string; code: string }[];
    currentUserId: string;
    companyTimeZone: string;
    changeOrders: { id: string; code: string; title: string }[];
    onClose: () => void;
}

export default function NewTimeEntryModal({ projectId, teamMembers, costCodes, currentUserId, companyTimeZone, changeOrders, onClose }: Props) {
    const [saving, setSaving] = useState(false);
    const [userId, setUserId] = useState(currentUserId);
    const [costCodeId, setCostCodeId] = useState("");
    const [date, setDate] = useState(() => todayInTimeZone(companyTimeZone));
    const [hours, setHours] = useState("");
    const [isBillable, setIsBillable] = useState(false);
    const [isTaxable, setIsTaxable] = useState(false);
    const [notes, setNotes] = useState("");
    const [changeOrderId, setChangeOrderId] = useState("");

    const selectedMember = teamMembers.find(m => m.id === userId);
    const storedRate = selectedMember?.hourlyRate ? Number(selectedMember.hourlyRate) : 0;
    const storedBurdenRate = selectedMember?.burdenRate ? Number(selectedMember.burdenRate) : 0;
    const hoursValue = parseFloat(hours) || 0;
    const laborPreview = hoursValue * storedRate;
    const burdenPreview = hoursValue * storedBurdenRate;

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
                isBillable,
                isTaxable,
                notes,
                changeOrderId: changeOrderId || null,
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
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Stored rate ($/hr)</label>
                            <input type="text" value={formatCurrency(storedRate)} readOnly className="hui-input w-full text-sm bg-slate-50" />
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
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Change order</label>
                        <select value={changeOrderId} onChange={e => setChangeOrderId(e.target.value)} className="hui-input w-full text-sm">
                            <option value="">Project time (no change order)</option>
                            {changeOrders.map(co => <option key={co.id} value={co.id}>{co.code} — {co.title}</option>)}
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

                    {hoursValue > 0 && (
                        <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-600">
                            <span className="font-medium">{hours}h</span> = labor <span className="font-medium">{formatCurrency(laborPreview)}</span> + burden <span className="font-medium">{formatCurrency(burdenPreview)}</span>
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
