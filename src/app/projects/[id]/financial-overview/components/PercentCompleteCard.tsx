"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateProjectPercentComplete, resetProjectPercentCompleteToAuto } from "@/lib/actions";

export interface PercentCompleteCardProps {
    projectId: string;
    /** The EFFECTIVE value — auto or manual. Null when the job cannot be measured yet. */
    percentComplete: number | null;
    source: "AUTO" | "MANUAL" | null;
    /**
     * Already formatted, on the SERVER, in the company time zone.
     *
     * Formatting here instead would use the VIEWER's browser zone, which the
     * server cannot know at render time — so an evening Pacific override showed
     * one date in the server HTML and another after hydration, and a different
     * one again to a colleague in another zone.
     */
    asOfLabel: string | null;
    /** Latest machine estimate, shown alongside a manual value so the gap is visible. */
    auto: number | null;
    needsReview: boolean;
    /** Who saved the manual value, when there is one. */
    editorName: string | null;
    /** ADMIN/MANAGER only — everyone else gets the same card, read-only. */
    canEdit: boolean;
}

/**
 * Percent complete for one job: the number earned revenue and earned margin are
 * derived from.
 *
 * The value is READ here and written by an explicit save. Nothing on this card
 * recomputes the automatic estimate — that is the nightly cron's job, and the
 * per-project variance load it needs must never run on a page render.
 *
 * Money-path-inert: no client-visible effect, no notification, no invoice.
 */
export default function PercentCompleteCard(props: PercentCompleteCardProps) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [draft, setDraft] = useState(props.percentComplete === null ? "" : String(props.percentComplete));

    const asOfLabel = props.asOfLabel;
    const sourceLabel = props.source === "MANUAL" ? "Manual" : props.source === "AUTO" ? "Auto" : null;

    function save() {
        startTransition(async () => {
            try {
                await updateProjectPercentComplete(props.projectId, draft);
                toast.success("Percent complete saved");
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not save percent complete");
            }
        });
    }

    function useAuto() {
        startTransition(async () => {
            try {
                const result = await resetProjectPercentCompleteToAuto(props.projectId);
                setDraft(result.percentComplete === null ? "" : String(result.percentComplete));
                toast.success("Back on the automatic estimate");
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not reset percent complete");
            }
        });
    }

    return (
        <div className="hui-card p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Percent Complete</p>
                    <p className="text-3xl font-bold mt-1 text-hui-textMain">
                        {props.percentComplete === null ? "—" : `${props.percentComplete}%`}
                    </p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                        {sourceLabel && (
                            <span className="text-[10px] font-semibold uppercase tracking-wider bg-slate-100 text-hui-textMuted px-2 py-0.5 rounded-full">
                                {sourceLabel}
                            </span>
                        )}
                        <span className="text-xs text-hui-textMuted">
                            {props.source === "MANUAL"
                                ? `Set by ${props.editorName ?? "a team member"}${asOfLabel ? ` on ${asOfLabel}` : ""}`
                                : props.percentComplete === null
                                    ? "No estimate yet — the job needs a cost-coded estimate and a schedule"
                                    : `Calculated${asOfLabel ? ` on ${asOfLabel}` : ""} from phase budgets and schedule progress`}
                        </span>
                    </div>
                    {props.source === "MANUAL" && props.auto !== null && (
                        <p className="text-xs text-hui-textMuted mt-1">Automatic estimate right now: {props.auto}%</p>
                    )}
                    {props.needsReview && (
                        <p className="mt-2 inline-block text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                            The automatic estimate has moved more than 5 points since this was set — worth a review.
                        </p>
                    )}
                </div>

                {props.canEdit && (
                    // Deliberately always visible: a hover-revealed control is
                    // invisible on devices where :hover never fires (CLAUDE.md).
                    <div className="flex items-end gap-2">
                        <label className="text-xs text-hui-textMuted">
                            <span className="block mb-1">Set %</span>
                            <input
                                type="number"
                                min={0}
                                max={100}
                                step={0.5}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                disabled={pending}
                                aria-label="Percent complete"
                                className="hui-input w-24"
                            />
                        </label>
                        <button type="button" onClick={save} disabled={pending} className="hui-btn hui-btn-primary">
                            Save
                        </button>
                        <button type="button" onClick={useAuto} disabled={pending} className="hui-btn hui-btn-secondary">
                            Use auto
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
