"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteEstimate } from "@/lib/actions";
import { toast } from "sonner";

export default function DeleteEstimateButton({ estimateId, estimateTitle, status }: { estimateId: string; estimateTitle: string; status: string }) {
    const [showConfirm, setShowConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const router = useRouter();

    const isProtected = ["Approved", "Invoiced", "Partially Paid"].includes(status);

    async function handleDelete() {
        setIsDeleting(true);
        try {
            const result = await deleteEstimate(estimateId);
            if (!result.success) {
                toast.error(result.error || "Failed to delete estimate");
                return;
            }
            toast.success("Estimate deleted");
            setShowConfirm(false);
            window.location.reload();
        } catch {
            toast.error("Failed to delete estimate");
        } finally {
            setIsDeleting(false);
        }
    }

    if (isProtected) return null;

    return (
        <>
            <button
                title="Delete estimate"
                onClick={() => setShowConfirm(true)}
                className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1.5 transition opacity-0 group-hover:opacity-100"
            >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                </svg>
            </button>

            {showConfirm && (
                <div
                    className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4"
                    onClick={() => !isDeleting && setShowConfirm(false)}
                >
                    <div
                        className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-hui-border"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-6">
                            <div className="flex items-start gap-4">
                                <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                                    <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                                    </svg>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-base font-bold text-hui-textMain">Delete estimate?</h3>
                                    <p className="text-sm text-hui-textMuted mt-1">
                                        <span className="font-medium text-slate-700 truncate block">{estimateTitle}</span>
                                        This cannot be undone. All line items and payment schedules will be permanently removed.
                                    </p>
                                </div>
                            </div>
                        </div>
                        <div className="px-6 pb-6 flex justify-end gap-3">
                            <button
                                onClick={() => setShowConfirm(false)}
                                disabled={isDeleting}
                                className="hui-btn hui-btn-secondary"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDelete}
                                disabled={isDeleting}
                                className="hui-btn bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 flex items-center gap-2"
                            >
                                {isDeleting ? (
                                    <>
                                        <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                        Deleting…
                                    </>
                                ) : "Delete"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
