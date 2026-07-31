"use client";

// Per-decision due-date edit popover (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md): link
// fields (schedule task + lead time) available to any staff with project
// access, plus an ADMIN/MANAGER-only manual override date input that always
// wins over derivation. Radix Dialog (house pattern), styled compact.

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { linkDecisionToSchedule, setDecisionDueDateOverride } from "@/lib/actions";
import { Pencil } from "lucide-react";

export type ProjectScheduleTaskOption = { id: string; name: string; startDate: string };

const LEAVE_UNLINKED = "";

function toDateInputValue(iso: string | null): string {
    if (!iso) return "";
    return iso.slice(0, 10); // ISO date -> yyyy-mm-dd for <input type="date">
}

export default function DecisionDueDateEditPopover({
    decisionId,
    decisionName,
    scheduleTaskId,
    leadTimeDays,
    dueDate,
    linkState,
    tasks,
    isAdminOrManager,
    onSaved,
}: {
    decisionId: string;
    decisionName: string;
    scheduleTaskId: string | null;
    leadTimeDays: number | null;
    dueDate: string | null; // raw manual override, ISO or null
    linkState: "linked" | "dangling" | "none";
    tasks: ProjectScheduleTaskOption[];
    isAdminOrManager: boolean;
    onSaved: () => void;
}) {
    const [open, setOpen] = useState(false);
    // A dangling scheduleTaskId isn't one of `tasks`'s options — seeding the
    // select to that dead id would silently desync the visible "Not linked"
    // selection from the real state, so "Save link" with no changes made
    // would resend the stale (deleted) task id (Codex review round 1, issue
    // 7). Seed to "not linked" instead; the notice below explains why.
    const [taskId, setTaskId] = useState(linkState === "linked" ? (scheduleTaskId ?? LEAVE_UNLINKED) : LEAVE_UNLINKED);
    const [leadTimeDraft, setLeadTimeDraft] = useState(leadTimeDays !== null ? String(leadTimeDays) : "0");
    const [overrideDraft, setOverrideDraft] = useState(toDateInputValue(dueDate));
    const [savingLink, setSavingLink] = useState(false);
    const [savingOverride, setSavingOverride] = useState(false);

    function handleOpenChange(next: boolean) {
        if (next) {
            // Re-seed from current props each time the popover opens.
            setTaskId(linkState === "linked" ? (scheduleTaskId ?? LEAVE_UNLINKED) : LEAVE_UNLINKED);
            setLeadTimeDraft(leadTimeDays !== null ? String(leadTimeDays) : "0");
            setOverrideDraft(toDateInputValue(dueDate));
        }
        setOpen(next);
    }

    async function handleSaveLink() {
        setSavingLink(true);
        try {
            if (taskId === LEAVE_UNLINKED) {
                await linkDecisionToSchedule(decisionId, null, null);
            } else {
                const days = Number(leadTimeDraft);
                await linkDecisionToSchedule(decisionId, taskId, Number.isFinite(days) ? days : 0);
            }
            toast.success("Schedule link updated.");
            onSaved();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't update the schedule link.");
        } finally {
            setSavingLink(false);
        }
    }

    async function handleSaveOverride() {
        setSavingOverride(true);
        try {
            await setDecisionDueDateOverride(decisionId, overrideDraft ? new Date(`${overrideDraft}T00:00:00.000Z`) : null);
            toast.success(overrideDraft ? "Manual due date set." : "Manual due date cleared.");
            onSaved();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't update the due date override.");
        } finally {
            setSavingOverride(false);
        }
    }

    return (
        <Dialog.Root open={open} onOpenChange={handleOpenChange}>
            <Dialog.Trigger asChild>
                <button
                    data-testid={`edit-due-date-${decisionId}`}
                    title="Edit schedule link / due date"
                    aria-label={`Edit due date for ${decisionName}`}
                    className="text-slate-400 hover:text-hui-textMain transition"
                >
                    <Pencil className="w-3 h-3" />
                </button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
                <Dialog.Content
                    data-testid={`due-date-popover-${decisionId}`}
                    className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl max-w-sm w-[calc(100vw-2rem)] focus:outline-none"
                >
                    <div className="px-5 py-4 border-b border-hui-border">
                        <Dialog.Title className="text-sm font-bold text-hui-textMain">Due date — {decisionName}</Dialog.Title>
                    </div>

                    <div className="p-5 space-y-4">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Schedule link</label>
                            {linkState === "dangling" && (
                                <p data-testid={`due-date-dangling-notice-${decisionId}`} className="text-xs text-amber-700 mt-1">
                                    Not linked (task removed) — the schedule task this was linked to no longer exists.
                                </p>
                            )}
                            <div className="flex items-center gap-2 mt-1">
                                <select
                                    data-testid={`due-date-task-select-${decisionId}`}
                                    className="hui-input text-sm py-1"
                                    value={taskId}
                                    onChange={(e) => setTaskId(e.target.value)}
                                    disabled={savingLink}
                                >
                                    <option value={LEAVE_UNLINKED}>Not linked</option>
                                    {tasks.map((t) => (
                                        <option key={t.id} value={t.id}>{t.name}</option>
                                    ))}
                                </select>
                                {taskId !== LEAVE_UNLINKED && (
                                    <input
                                        type="number"
                                        min={0}
                                        max={365}
                                        data-testid={`due-date-lead-time-${decisionId}`}
                                        className="hui-input text-sm py-1 w-20"
                                        value={leadTimeDraft}
                                        onChange={(e) => setLeadTimeDraft(e.target.value)}
                                        disabled={savingLink}
                                        aria-label="Lead time in days"
                                    />
                                )}
                            </div>
                            <button
                                data-testid={`due-date-save-link-${decisionId}`}
                                onClick={handleSaveLink}
                                disabled={savingLink}
                                className="hui-btn hui-btn-secondary text-xs py-1 px-2 mt-2 disabled:opacity-50"
                            >
                                {savingLink ? "Saving…" : "Save link"}
                            </button>
                        </div>

                        {isAdminOrManager && (
                            <div className="pt-3 border-t border-hui-border">
                                <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Manual override (always wins)</label>
                                <div className="flex items-center gap-2 mt-1">
                                    <input
                                        type="date"
                                        data-testid={`due-date-override-input-${decisionId}`}
                                        className="hui-input text-sm py-1"
                                        value={overrideDraft}
                                        onChange={(e) => setOverrideDraft(e.target.value)}
                                        disabled={savingOverride}
                                    />
                                </div>
                                <button
                                    data-testid={`due-date-save-override-${decisionId}`}
                                    onClick={handleSaveOverride}
                                    disabled={savingOverride}
                                    className="hui-btn hui-btn-secondary text-xs py-1 px-2 mt-2 disabled:opacity-50"
                                >
                                    {savingOverride ? "Saving…" : overrideDraft ? "Set override" : "Clear override"}
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="px-5 py-3 border-t border-hui-border flex justify-end bg-slate-50 rounded-b-xl">
                        <Dialog.Close asChild>
                            <button data-testid={`due-date-close-${decisionId}`} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">Close</button>
                        </Dialog.Close>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
