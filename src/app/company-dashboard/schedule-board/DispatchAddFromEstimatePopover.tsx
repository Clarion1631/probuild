"use client";

import { useEffect, useState, type RefObject } from "react";
import { getTaskBank, type TaskBankResult } from "@/lib/actions";
import { FloatingPopover, type FloatingPopoverAnchorPoint } from "./FloatingPopover";
import type { DispatchTaskBankItem } from "./DispatchTaskBank";

interface DispatchAddFromEstimatePopoverProps {
    open: boolean;
    projectId: string;
    anchorRef: RefObject<HTMLElement | null>;
    anchorPoint?: FloatingPopoverAnchorPoint | null;
    canSchedule: boolean;
    onSchedule: (item: DispatchTaskBankItem) => void;
    onOtherTask: () => void;
    onClose: () => void;
}

/**
 * Per-job "Add from estimate" popover — the Day mode's task-creation path.
 * Tasks should pull from the job's estimate by default (that's what crew
 * clock in as and what the job costs against); free-text ("Other task…")
 * stays available but is the clearly-secondary option.
 */
export function DispatchAddFromEstimatePopover({
    open,
    projectId,
    anchorRef,
    anchorPoint,
    canSchedule,
    onSchedule,
    onOtherTask,
    onClose,
}: DispatchAddFromEstimatePopoverProps) {
    const [result, setResult] = useState<TaskBankResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        getTaskBank(projectId)
            .then(next => { if (!cancelled) setResult(next); })
            .catch((cause: unknown) => {
                if (cancelled) return;
                setResult(null);
                setError(cause instanceof Error ? cause.message : "Could not load the task bank");
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open, projectId]);

    return (
        <FloatingPopover open={open} anchorRef={anchorRef} anchorPoint={anchorPoint} onClose={onClose} width={300} titleId="dispatch-add-estimate-popover-title">
            <div>
                <p id="dispatch-add-estimate-popover-title" className="text-xs font-semibold text-hui-textMain">Add from estimate</p>
                <p className="mt-0.5 text-[11px] text-hui-textMuted">Unscheduled contract scope for this job.</p>
                <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
                    {loading ? (
                        <p className="rounded border border-dashed border-hui-border px-3 py-4 text-center text-xs text-hui-textMuted">Loading...</p>
                    ) : error ? (
                        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
                    ) : !result?.estimate ? (
                        <p className="rounded border border-dashed border-hui-border px-3 py-4 text-center text-xs text-hui-textMuted">No contract estimate for this project.</p>
                    ) : result.items.length === 0 ? (
                        <p className="rounded border border-green-200 bg-green-50 px-3 py-3 text-center text-xs font-medium text-green-700">All contract items are scheduled.</p>
                    ) : result.items.map(item => (
                        <button
                            key={item.estimateItemId}
                            type="button"
                            disabled={!canSchedule}
                            onClick={() => { onSchedule(item); onClose(); }}
                            className="block w-full rounded-md px-2.5 py-2 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <span className="block text-xs font-semibold text-hui-textMain">{item.name}</span>
                            {item.estimatedHours != null && <span className="mt-0.5 block text-[10px] text-hui-textMuted">{item.estimatedHours} estimated hours</span>}
                        </button>
                    ))}
                </div>
                {canSchedule && (
                    <button
                        type="button"
                        onClick={() => { onOtherTask(); onClose(); }}
                        className="mt-2 block w-full rounded-md border-t border-hui-border px-2.5 pt-3 text-left text-xs font-medium text-hui-textMuted transition hover:text-hui-textMain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                    >
                        Other task...
                    </button>
                )}
            </div>
        </FloatingPopover>
    );
}
