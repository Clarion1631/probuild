"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import type { PublishDispatchSuccess } from "@/lib/dispatch-publication";

interface DispatchReviewDialogProps {
    result: PublishDispatchSuccess | null;
    published: boolean;
    isPending: boolean;
    conflictTargetIds: ReadonlySet<string>;
    onConfirm: () => void;
    onClose: () => void;
}

function changeLabel(kind: string): string {
    if (kind === "PROJECT_START") return "Project";
    if (kind === "TASK_CREW") return "Crew";
    return "Dates";
}

export function DispatchReviewDialog({
    result,
    published,
    isPending,
    conflictTargetIds,
    onConfirm,
    onClose,
}: DispatchReviewDialogProps) {
    const changeCount = result?.changes.length ?? 0;
    const deliveryCount = result?.deliveryCount ?? 0;

    return (
        <Dialog.Root open={Boolean(result)} onOpenChange={open => { if (!open && !isPending) onClose(); }}>
            <Dialog.Portal>
                <Dialog.Overlay asChild>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.16 }}
                        className="fixed inset-0 z-[80] bg-slate-950/50"
                    />
                </Dialog.Overlay>
                <Dialog.Content asChild>
                    <motion.div
                        data-motion-scope="dialog-enter"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.18 }}
                        className="fixed left-1/2 top-1/2 z-[81] flex max-h-[min(88vh,46rem)] w-[min(94vw,42rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-hui-border bg-white shadow-2xl focus:outline-none"
                    >
                        {published ? (
                            <div className="p-6">
                                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-lg font-bold text-green-700" aria-hidden="true">✓</div>
                                <Dialog.Title className="mt-4 text-lg font-semibold text-hui-textMain">
                                    Dispatch recorded — delivery pending
                                </Dialog.Title>
                                <Dialog.Description className="mt-2 text-sm leading-6 text-hui-textMuted">
                                    The schedule and audit record committed together. {deliveryCount} delivery {deliveryCount === 1 ? "row is" : "rows are"} queued for the later chat drainer.
                                </Dialog.Description>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="hui-btn hui-btn-primary mt-6 w-full justify-center"
                                >
                                    Close
                                </button>
                            </div>
                        ) : (
                            <>
                                <div className="border-b border-hui-border bg-slate-50 px-5 py-4">
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <Dialog.Title className="text-lg font-semibold text-hui-textMain">Review dispatch</Dialog.Title>
                                            <Dialog.Description className="mt-1 text-sm text-hui-textMuted">
                                                One atomic schedule update. Nothing is queued unless every row is still current.
                                            </Dialog.Description>
                                        </div>
                                        <div className="shrink-0 rounded-md border border-slate-200 bg-white px-3 py-2 text-right">
                                            <div className="text-lg font-semibold tabular-nums text-hui-textMain">{changeCount}</div>
                                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">changes</div>
                                        </div>
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                                        <span className="rounded-full bg-indigo-100 px-2.5 py-1 font-semibold text-indigo-700">
                                            {deliveryCount} pending {deliveryCount === 1 ? "delivery" : "deliveries"}
                                        </span>
                                        <span className="rounded-full bg-slate-200 px-2.5 py-1 font-semibold text-slate-700">
                                            All-or-nothing
                                        </span>
                                    </div>
                                </div>

                                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                                    <div className="space-y-2" role="list" aria-label="Dispatch changes">
                                        {result?.changes.map((change, index) => {
                                            const conflicted = conflictTargetIds.has(change.targetId);
                                            return (
                                                <div
                                                    key={`${change.kind}-${change.targetId}`}
                                                    role="listitem"
                                                    className={`grid grid-cols-[auto_1fr] gap-3 rounded-lg border px-3 py-3 ${conflicted ? "border-amber-300 bg-amber-50" : "border-hui-border bg-white"}`}
                                                >
                                                    <span className="mt-0.5 inline-flex h-6 min-w-14 items-center justify-center rounded bg-slate-100 px-2 text-[10px] font-bold uppercase tracking-wide text-slate-600">
                                                        {changeLabel(change.kind)}
                                                    </span>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium leading-5 text-hui-textMain">{change.summary}</p>
                                                        {conflicted && (
                                                            <p className="mt-1 text-xs font-medium text-amber-800">Changed since the previous review — check this line again.</p>
                                                        )}
                                                        <p className="mt-1 text-[10px] tabular-nums text-slate-400">Change {index + 1} of {changeCount}</p>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="flex flex-col-reverse gap-2 border-t border-hui-border bg-white px-5 py-4 sm:flex-row sm:justify-end">
                                    <button
                                        type="button"
                                        disabled={isPending}
                                        onClick={onClose}
                                        className="hui-btn hui-btn-secondary justify-center disabled:cursor-wait disabled:opacity-60"
                                    >
                                        Keep editing
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isPending}
                                        onClick={onConfirm}
                                        className="hui-btn hui-btn-green justify-center disabled:cursor-wait disabled:opacity-60"
                                    >
                                        {isPending ? "Queueing dispatch..." : "Confirm & queue dispatch"}
                                    </button>
                                </div>
                            </>
                        )}
                    </motion.div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
