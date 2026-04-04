"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { createRetainer } from "@/lib/actions";
import Link from "next/link";
import { toast } from "sonner";

export default function NewRetainerPage() {
    const router = useRouter();
    const params = useParams();
    const projectId = params.id as string;

    const [amount, setAmount] = useState("");
    const [notes, setNotes] = useState("");
    const [dueDate, setDueDate] = useState("");
    const [saving, setSaving] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!amount || parseFloat(amount) <= 0) {
            toast.error("Amount must be greater than 0");
            return;
        }

        setSaving(true);
        try {
            await createRetainer(projectId, {
                totalAmount: parseFloat(amount),
                notes: notes || undefined,
                dueDate: dueDate || undefined,
            });
            toast.success("Retainer created");
            router.push(`/projects/${projectId}/retainers`);
        } catch (err) {
            toast.error("Failed to create retainer");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex-1 flex flex-col items-stretch h-full overflow-hidden">
            <div className="flex-none p-6 pb-4 border-b border-hui-border bg-white flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">New Retainer</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Create a new retainer or upfront payment request.</p>
                </div>
                <Link href={`/projects/${projectId}/retainers`} className="hui-btn hui-btn-secondary">
                    Cancel
                </Link>
            </div>

            <div className="flex-1 overflow-y-auto p-6 bg-hui-background">
                <form onSubmit={handleSubmit} className="hui-card p-6 max-w-lg space-y-5">
                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Amount *</label>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-hui-textMuted">$</span>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                className="hui-input pl-7 w-full"
                                placeholder="0.00"
                                required
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Due Date</label>
                        <input
                            type="date"
                            value={dueDate}
                            onChange={(e) => setDueDate(e.target.value)}
                            className="hui-input w-full"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Notes</label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            className="hui-input w-full"
                            rows={4}
                            placeholder="Optional notes about this retainer..."
                        />
                    </div>

                    <div className="flex gap-3 pt-2">
                        <button type="submit" disabled={saving} className="hui-btn hui-btn-primary">
                            {saving ? "Creating..." : "Create Retainer"}
                        </button>
                        <Link href={`/projects/${projectId}/retainers`} className="hui-btn hui-btn-secondary">
                            Cancel
                        </Link>
                    </div>
                </form>
            </div>
        </div>
    );
}
