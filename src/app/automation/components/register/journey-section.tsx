import type { FixSuggestion } from "@/lib/automation-suggestions";
import JourneyList, { type SerializedJourney } from "../journey-list";

/**
 * The receipt pipeline's own view (Unified Money Register plan §3) — every
 * receipt the automation has processed, including ones that never became a
 * register row above (parked, quarantined, errored, still in flight). The
 * register table is the spine (every dollar QuickBooks posted); this section
 * is where "Verify in QuickBooks" (live re-check) and "AI review" live —
 * `JourneyList` was built for this page but never wired back in after the
 * register rebuild, silently dropping both features. Collapsible like the
 * sections around it, but default OPEN: these are working features the
 * bookkeeper uses today and shouldn't hide behind a click.
 */
export function JourneySection({
    journeys,
    suggestions,
    now,
    truncated,
}: {
    journeys: SerializedJourney[];
    suggestions: Record<string, FixSuggestion | null>;
    now: number;
    /** True when the underlying journey fetch had to cap its event query —
     * see `JourneyList`'s doc comment for what this suppresses. */
    truncated: boolean;
}) {
    return (
        <details className="hui-card group" open>
            <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between text-base font-semibold text-hui-textMain select-none">
                <span>
                    Receipt pipeline {journeys.length > 0 && <span className="text-hui-textMuted font-normal">({journeys.length})</span>}
                </span>
                <span className="text-xs font-normal text-hui-textMuted group-open:hidden">Show</span>
                <span className="text-xs font-normal text-hui-textMuted hidden group-open:inline">Hide</span>
            </summary>
            <div className="border-t border-hui-border p-5 space-y-4">
                <p className="text-xs text-hui-textMuted -mt-1">
                    Every receipt the automation processed, including ones that never became a register row above.
                    Verify a receipt live against QuickBooks or run an AI review from here.
                </p>
                <JourneyList journeys={journeys} suggestions={suggestions} now={now} truncated={truncated} />
            </div>
        </details>
    );
}
