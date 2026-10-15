"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ChangeOrderEstimateOption } from "@/lib/change-order-estimate-options";

export default function NewChangeOrderButton({
    projectId,
    options,
    defaultEstimateId,
    defaultOpen = false,
}: {
    projectId: string;
    options: ChangeOrderEstimateOption[];
    defaultEstimateId: string | null;
    defaultOpen?: boolean;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(defaultOpen);
    const [selectedId, setSelectedId] = useState<string | null>(defaultEstimateId);
    const [pending, setPending] = useState(false);
    // State updates land on the next render, so a fast double click could pass a
    // state-only check twice and create two change orders. The ref blocks it at once.
    const inFlight = useRef(false);

    const handleCreate = async () => {
        if (inFlight.current || !selectedId) return;
        inFlight.current = true;
        setPending(true);
        try {
            const { createChangeOrder } = await import("@/lib/actions");
            const res = await createChangeOrder(projectId, selectedId);
            toast.success("Change order drafted");
            router.push(`/projects/${projectId}/change-orders/${res.id}`);
        } catch (e: any) {
            toast.error(e?.message || "Failed to create change order");
            inFlight.current = false;
            setPending(false);
        }
    };

    return (
        <>
            <button type="button" className="hui-btn hui-btn-primary" onClick={() => setOpen(true)}>
                New change order
            </button>

            {open && (
                <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-lg w-full border border-hui-border overflow-hidden">
                        <div className="px-6 py-4 border-b border-hui-border">
                            <h2 className="text-lg font-bold text-hui-textMain">New change order</h2>
                            <p className="text-sm text-slate-500 mt-1">
                                Pick the estimate this change order adds to. Its billing goes onto that estimate&apos;s newest invoice, and it uses that estimate&apos;s tax rate.
                            </p>
                        </div>
                        <div className="p-6 space-y-2 text-sm max-h-[60vh] overflow-y-auto">
                            {options.length === 0 ? (
                                <p className="text-hui-textMuted">
                                    This project has no estimates yet. Create an estimate first, then add change orders to it.
                                </p>
                            ) : (
                                options.map((opt) => {
                                    const selected = opt.id === selectedId;
                                    return (
                                        <label
                                            key={opt.id}
                                            className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition ${
                                                selected ? "border-hui-primary bg-slate-50" : "border-hui-border hover:bg-slate-50"
                                            }`}
                                        >
                                            <input
                                                type="radio"
                                                name="change-order-estimate"
                                                className="mt-1"
                                                checked={selected}
                                                disabled={pending}
                                                onChange={() => setSelectedId(opt.id)}
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="font-medium text-hui-textMain truncate">
                                                        {opt.code} {opt.title}
                                                    </span>
                                                    {opt.invoiceCode ? (
                                                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 whitespace-nowrap">
                                                            Invoice {opt.invoiceCode}
                                                        </span>
                                                    ) : (
                                                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800 whitespace-nowrap">
                                                            No invoice
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-xs text-hui-textMuted mt-0.5">{opt.status}</p>
                                                {opt.billsToProjectFallback && opt.billsToInvoiceCode && (
                                                    <p className="text-xs text-hui-textMuted mt-1">
                                                        Bills onto the project&apos;s newest invoice, {opt.billsToInvoiceCode}
                                                    </p>
                                                )}
                                                {opt.billsToInvoiceCode === null && (
                                                    <p className="text-xs text-amber-700 mt-1">
                                                        This project has no invoice yet. Create one before billing.
                                                    </p>
                                                )}
                                            </div>
                                        </label>
                                    );
                                })
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3">
                            <button type="button" className="hui-btn hui-btn-secondary disabled:opacity-50" disabled={pending} onClick={() => setOpen(false)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="hui-btn hui-btn-primary disabled:opacity-50"
                                disabled={pending || !selectedId || options.length === 0}
                                onClick={handleCreate}
                            >
                                {pending ? "Creating…" : "Create change order"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
