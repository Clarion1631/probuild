"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateMonthlyOverhead } from "@/lib/actions";

export default function OverheadEditor({ monthlyOverhead, canEdit }: { monthlyOverhead: number; canEdit: boolean }) {
    const router = useRouter();
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(String(monthlyOverhead || ""));
    const [saving, setSaving] = useState(false);

    async function save() {
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0) {
            toast.error("Enter a valid monthly overhead amount");
            return;
        }
        setSaving(true);
        try {
            const res = await updateMonthlyOverhead(num);
            if (res.success) {
                toast.success("Monthly overhead updated");
                setEditing(false);
                router.refresh();
            } else {
                toast.error(res.error || "Failed to save");
            }
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="hui-card p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
                <p className="text-sm font-semibold text-hui-textMain">Monthly overhead</p>
                <p className="text-xs text-hui-textMuted">Rent, insurance, salaries not on jobs, vehicles, software — everything it costs to keep the doors open for a month.</p>
            </div>
            {editing ? (
                <div className="flex items-center gap-2">
                    <span className="text-sm text-hui-textMuted">$</span>
                    <input
                        type="number"
                        min="0"
                        step="100"
                        autoFocus
                        value={value}
                        onChange={e => setValue(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
                        className="hui-input w-32 py-1.5 text-sm"
                        placeholder="e.g. 12000"
                    />
                    <button onClick={save} disabled={saving} className="hui-btn hui-btn-primary py-1.5 px-3 text-xs disabled:opacity-50">
                        {saving ? "Saving…" : "Save"}
                    </button>
                    <button onClick={() => setEditing(false)} className="text-xs text-hui-textMuted hover:text-hui-textMain">Cancel</button>
                </div>
            ) : (
                <div className="flex items-center gap-3">
                    <span className="text-xl font-bold text-hui-textMain">
                        {monthlyOverhead.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}<span className="text-sm font-normal text-hui-textMuted">/mo</span>
                    </span>
                    {canEdit && (
                        <button onClick={() => setEditing(true)} className="hui-btn hui-btn-secondary py-1.5 px-3 text-xs">
                            {monthlyOverhead > 0 ? "Edit" : "Set overhead"}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
