import type { SerializedJourneyStep } from "../journey-list";
import { formatRelativeTime } from "../format";

const STAGE_LABEL: Record<string, string> = {
    read: "AI read",
    dedupe: "Duplicate check",
    "email-book": "Booked via email",
    push: "Pushed to QuickBooks",
    synced: "Synced to ProBuild job costs",
    "ai-review": "AI review",
};

export function humanizeStage(stage: string): string {
    if (STAGE_LABEL[stage]) return STAGE_LABEL[stage];
    return stage
        .split(/[-_]/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ");
}

export function StepIcon({ status }: { status: string }) {
    if (status === "ok") {
        return (
            <span className="w-5 h-5 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-xs shrink-0">
                ✓
            </span>
        );
    }
    if (status === "parked" || status === "quarantined") {
        return (
            <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs shrink-0">
                ⏸
            </span>
        );
    }
    if (status === "error" || status === "mismatch") {
        return (
            <span className="w-5 h-5 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-xs shrink-0">
                ✗
            </span>
        );
    }
    if (status === "inconclusive") {
        return (
            <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs shrink-0">
                ?
            </span>
        );
    }
    return (
        <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs shrink-0">
            →
        </span>
    );
}

/** The intake→read→dedupe→push→synced row list for a single receipt journey,
 * plus the optional "waiting for the 4-hour sync" placeholder row. */
export function StepTimeline({
    steps,
    showPendingSync,
}: {
    steps: SerializedJourneyStep[];
    showPendingSync: boolean;
}) {
    return (
        <div className="space-y-2 pl-1">
            {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-3">
                    <StepIcon status={step.status} />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm text-hui-textMain">
                            <span className="font-medium">{humanizeStage(step.stage)}</span>
                            {" — "}
                            {step.status}
                            {step.reason ? ` — ${step.reason}` : ""}
                        </p>
                    </div>
                    <span
                        className="text-xs text-hui-textMuted whitespace-nowrap shrink-0"
                        title={new Date(step.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" })}
                    >
                        {formatRelativeTime(new Date(step.at))}
                    </span>
                </div>
            ))}
            {showPendingSync && (
                <div className="flex items-start gap-3 opacity-50">
                    <span className="w-5 h-5 rounded-full bg-slate-200 flex items-center justify-center text-xs shrink-0">
                        ○
                    </span>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm text-hui-textMain">Waiting for the 4-hour sync</p>
                    </div>
                    <span className="text-xs text-hui-textMuted whitespace-nowrap shrink-0">pending</span>
                </div>
            )}
        </div>
    );
}
