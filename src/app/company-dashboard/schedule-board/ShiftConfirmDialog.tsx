"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import type { ProjectDropIntent } from "./useBarLayout";

export type ProjectMoveChoice = "marker-only" | "not-started-tasks";

interface ShiftConfirmDialogProps {
    intent: ProjectDropIntent | null;
    isPending: boolean;
    onChoice: (_choice: ProjectMoveChoice) => void;
    onCancel: () => void;
}

export function ShiftConfirmDialog({ intent, isPending, onChoice, onCancel }: ShiftConfirmDialogProps) {
    const magnitude = Math.abs(intent?.deltaDays ?? 0);
    const direction = (intent?.deltaDays ?? 0) < 0 ? "earlier" : "later";

    return (
        <Dialog.Root open={Boolean(intent)} onOpenChange={open => { if (!open && !isPending) onCancel(); }}>
            <Dialog.Portal>
                <Dialog.Overlay asChild>
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }} className="fixed inset-0 z-[70] bg-black/45" />
                </Dialog.Overlay>
                <Dialog.Content asChild>
                <motion.div
                    data-motion-scope="dialog-enter"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.18 }}
                    className="fixed left-1/2 top-1/2 z-[71] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-hui-border bg-white p-5 shadow-2xl focus:outline-none"
                >
                    <Dialog.Title className="text-base font-semibold text-hui-textMain">Move In Progress project</Dialog.Title>
                    <Dialog.Description className="mt-2 text-sm text-hui-textMuted">
                        {intent ? `${intent.project.name} is previewed ${magnitude} day${magnitude === 1 ? "" : "s"} ${direction}. Choose one edit; these actions are intentionally not combined.` : "Choose how to move this project."}
                    </Dialog.Description>
                    <div className="mt-5 space-y-2">
                        <button
                            type="button"
                            disabled={isPending}
                            onClick={() => onChoice("marker-only")}
                            className="hui-btn hui-btn-primary w-full justify-center text-sm disabled:cursor-wait disabled:opacity-60"
                        >
                            Move start marker only
                        </button>
                        <button
                            type="button"
                            disabled={isPending}
                            onClick={() => onChoice("not-started-tasks")}
                            className="hui-btn hui-btn-secondary w-full justify-center text-sm disabled:cursor-wait disabled:opacity-60"
                        >
                            Move the start marker AND shift all Not Started tasks by {magnitude} day{magnitude === 1 ? "" : "s"} {direction}
                        </button>
                    </div>
                    <div className="mt-4 flex justify-end">
                        <Dialog.Close asChild>
                            <button type="button" disabled={isPending} className="rounded-md px-3 py-2 text-sm font-semibold text-hui-textMuted hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-wait disabled:opacity-60">
                                Cancel
                            </button>
                        </Dialog.Close>
                    </div>
                </motion.div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
