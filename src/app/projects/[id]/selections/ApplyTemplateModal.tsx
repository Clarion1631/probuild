"use client";

// "Apply template" picker (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
// Codex review round 1, BLOCKER: applyDecisionTemplate had no UI call site
// at all — this is the missing flow. Radix Dialog (house pattern), same
// Dialog.Trigger-owns-the-button shape as AiSortReviewModal/
// LinkScheduleReviewModal, except the fetch (listActiveDecisionTemplatesForApply,
// a server action, not a route — nothing to wait on before deciding whether
// to open) runs AFTER the dialog opens, so this one just opens immediately
// and shows a loading state.

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { listActiveDecisionTemplatesForApply, applyDecisionTemplate } from "@/lib/actions";
import { LayoutTemplate } from "lucide-react";

type TemplateOption = {
    id: string;
    name: string;
    description: string | null;
    items: { id: string; name: string }[];
};

export default function ApplyTemplateModal({
    projectId,
    onApplied,
}: {
    projectId: string;
    onApplied: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [templates, setTemplates] = useState<TemplateOption[]>([]);
    const [selectedId, setSelectedId] = useState<string>("");
    const [applying, setApplying] = useState(false);

    function handleOpenChange(next: boolean) {
        if (applying) return;
        setOpen(next);
        if (!next) return;

        // Reset on EVERY open, not just the first (Codex review round 2,
        // NEW 1) — without this, reopening after a successful apply left the
        // previous session's `templates`/`selectedId` in state during the
        // new fetch's loading window, so Confirm was clickable against a
        // stale list (e.g. re-applying a template that was archived or
        // edited in between) until the fresh data happened to land.
        setTemplates([]);
        setSelectedId("");
        setLoading(true);
        setLoadError(null);
        listActiveDecisionTemplatesForApply()
            .then((data: TemplateOption[]) => {
                setTemplates(data);
                setSelectedId(data[0]?.id ?? "");
            })
            .catch((e: any) => setLoadError(e?.message || "Couldn't load templates."))
            .finally(() => setLoading(false));
    }

    async function handleApply() {
        if (!selectedId) return;
        setApplying(true);
        try {
            const result = await applyDecisionTemplate(projectId, selectedId);
            const parts = [`${result.created} created`];
            if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped (already exist)`);
            toast.success(parts.join(", "));
            onApplied();
            setOpen(false);
        } catch (e: any) {
            toast.error(e?.message || "Couldn't apply that template.");
        } finally {
            setApplying(false);
        }
    }

    return (
        <Dialog.Root open={open} onOpenChange={handleOpenChange}>
            <Dialog.Trigger asChild>
                <button
                    data-testid="apply-template-button"
                    className="hui-btn hui-btn-accent text-sm flex items-center gap-1.5"
                >
                    <LayoutTemplate className="w-4 h-4" />
                    Apply template
                </button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
                <Dialog.Content
                    data-testid="apply-template-modal"
                    className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl max-w-lg w-[calc(100vw-2rem)] max-h-[85vh] flex flex-col focus:outline-none"
                    onEscapeKeyDown={(e) => { if (applying) e.preventDefault(); }}
                    onPointerDownOutside={(e) => { if (applying) e.preventDefault(); }}
                >
                    <div className="px-6 py-4 border-b border-hui-border">
                        <Dialog.Title className="text-lg font-bold text-hui-textMain">Apply a template</Dialog.Title>
                        <Dialog.Description className="text-xs text-hui-textMuted mt-0.5">
                            Creates one decision per item. Items matching an existing decision on this project are skipped, never duplicated.
                        </Dialog.Description>
                    </div>

                    <div className="overflow-y-auto p-6">
                        {loading ? (
                            <p className="text-sm text-hui-textMuted text-center py-8">Loading templates…</p>
                        ) : loadError ? (
                            <p className="text-sm text-red-600 text-center py-8">{loadError}</p>
                        ) : templates.length === 0 ? (
                            <p className="text-sm text-hui-textMuted text-center py-8">No active templates yet — create one under Templates &gt; Selection Templates.</p>
                        ) : (
                            <div className="space-y-2">
                                {templates.map((t) => (
                                    <label
                                        key={t.id}
                                        data-testid={`apply-template-option-${t.id}`}
                                        className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition ${selectedId === t.id ? "border-hui-primary bg-hui-primary/5" : "border-slate-200 hover:bg-slate-50"}`}
                                    >
                                        <input
                                            type="radio"
                                            name="apply-template-select"
                                            className="mt-1"
                                            checked={selectedId === t.id}
                                            onChange={() => setSelectedId(t.id)}
                                            disabled={applying}
                                        />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-semibold text-hui-textMain">{t.name}</p>
                                            {t.description && <p className="text-xs text-hui-textMuted mt-0.5">{t.description}</p>}
                                            <p data-testid={`apply-template-items-${t.id}`} className="text-xs text-hui-textMuted mt-1">
                                                {t.items.map((i) => i.name).join(", ")}
                                            </p>
                                        </div>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                        <Dialog.Close asChild>
                            <button data-testid="apply-template-cancel" disabled={applying} className="hui-btn hui-btn-secondary">Cancel</button>
                        </Dialog.Close>
                        <button
                            data-testid="apply-template-confirm"
                            onClick={handleApply}
                            // Explicitly gated on loading/loadError (Codex
                            // review round 2, NEW 1), not just derived from
                            // templates.length — defends against Confirm
                            // ever being clickable mid-fetch or after a
                            // failed load, independent of what `templates`
                            // happens to hold at that moment.
                            disabled={applying || loading || !!loadError || !selectedId || templates.length === 0}
                            className="hui-btn hui-btn-green disabled:opacity-50"
                        >
                            {applying ? "Applying…" : "Apply"}
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
