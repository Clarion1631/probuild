"use client";

import { useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { FixSuggestion } from "@/lib/automation-suggestions";
import { formatRelativeTime } from "./format";

/** Same shape as `JourneyStep` in @/lib/automation-events, but with `at`
 * serialized to an ISO string — Dates don't survive server → client props. */
export interface SerializedJourneyStep {
    at: string;
    stage: string;
    status: string;
    reason: string | null;
    detail: string | null;
}

/** Same shape as `ReceiptJourney`, with all Date fields serialized to ISO
 * strings for the trip across the server/client boundary. */
export interface SerializedJourney {
    docNumber: string;
    fileName: string | null;
    vendor: string | null;
    projectName: string | null;
    amountCents: number | null;
    taxCents: number | null;
    firstSeen: string;
    lastSeen: string;
    steps: SerializedJourneyStep[];
    finalState: "booked-api" | "booked-email" | "parked" | "quarantined" | "error" | "in-flight";
    finalReason: string | null;
    syncedExpenseId: string | null;
    syncedProjectName: string | null;
}

type FilterKey = "all" | "booked" | "needs-attention" | "in-flight";

const FINAL_STATE_STYLE: Record<
    SerializedJourney["finalState"],
    { icon: string; label: string; bg: string; text: string; pulse?: boolean }
> = {
    "booked-api": { icon: "✓", label: "Booked", bg: "bg-teal-100", text: "text-teal-700" },
    "booked-email": { icon: "✉", label: "Booked via email", bg: "bg-amber-100", text: "text-amber-700" },
    parked: { icon: "⏸", label: "Needs review", bg: "bg-amber-100", text: "text-amber-700" },
    quarantined: { icon: "⧉", label: "Duplicate", bg: "bg-slate-100", text: "text-slate-600" },
    error: { icon: "✗", label: "Error", bg: "bg-red-100", text: "text-red-700" },
    "in-flight": { icon: "●", label: "In flight", bg: "bg-blue-100", text: "text-blue-700", pulse: true },
};

const STAGE_LABEL: Record<string, string> = {
    read: "AI read",
    dedupe: "Duplicate check",
    "email-book": "Booked via email",
    push: "Pushed to QuickBooks",
    synced: "Synced to ProBuild job costs",
};

function humanizeStage(stage: string): string {
    if (STAGE_LABEL[stage]) return STAGE_LABEL[stage];
    return stage
        .split(/[-_]/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ");
}

function StepIcon({ status }: { status: string }) {
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
    if (status === "error") {
        return (
            <span className="w-5 h-5 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-xs shrink-0">
                ✗
            </span>
        );
    }
    return (
        <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs shrink-0">
            →
        </span>
    );
}

function StateChip({ state }: { state: SerializedJourney["finalState"] }) {
    const style = FINAL_STATE_STYLE[state];
    return (
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${style.bg} ${style.text}`}>
            <span className={style.pulse ? "animate-pulse" : ""}>{style.icon}</span>
            {style.label}
        </span>
    );
}

const FILTERS: { key: FilterKey; label: string; test: (j: SerializedJourney) => boolean }[] = [
    { key: "all", label: "All", test: () => true },
    { key: "booked", label: "Booked", test: (j) => j.finalState === "booked-api" || j.finalState === "booked-email" },
    {
        key: "needs-attention",
        label: "Needs attention",
        test: (j) => j.finalState === "parked" || j.finalState === "quarantined" || j.finalState === "error",
    },
    { key: "in-flight", label: "In flight", test: (j) => j.finalState === "in-flight" },
];

function EmptyState() {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                <svg className="w-7 h-7 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
            </div>
            <h3 className="text-base font-semibold text-hui-textMain">No receipts tracked yet</h3>
            <p className="text-sm text-hui-textMuted mt-1 max-w-md">
                The journey log starts filling as new receipts process.
            </p>
        </div>
    );
}

function SuggestionCard({ suggestion }: { suggestion: FixSuggestion }) {
    async function copyPrompt() {
        try {
            await navigator.clipboard.writeText(suggestion.aiPrompt);
            toast.success("Prompt copied — paste it to Claude");
        } catch {
            toast.error("Couldn't copy — select and copy manually");
        }
    }

    return (
        <div className="hui-card p-4 bg-slate-50">
            <h4 className="text-sm font-semibold text-hui-textMain mb-2">Why it stopped + how to fix</h4>
            <p className="text-sm text-hui-textMain">{suggestion.diagnosis}</p>
            {suggestion.manualFix && (
                <p className="text-sm text-hui-textMuted mt-2">
                    <span className="font-medium text-hui-textMain">Quick fix: </span>
                    {suggestion.manualFix}
                </p>
            )}
            <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Prompt for Claude</span>
                    <button onClick={copyPrompt} className="hui-btn hui-btn-secondary text-xs px-2 py-1">
                        Copy
                    </button>
                </div>
                <pre className="text-xs bg-white border border-hui-border rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                    {suggestion.aiPrompt}
                </pre>
            </div>
        </div>
    );
}

function JourneyRow({ journey, suggestion }: { journey: SerializedJourney; suggestion: FixSuggestion | null }) {
    const [isOpen, setIsOpen] = useState(false);

    const primaryLabel = journey.fileName || journey.vendor || journey.docNumber;
    const subParts = [
        journey.vendor,
        journey.projectName,
        journey.amountCents != null ? formatCurrency(journey.amountCents / 100) : null,
    ].filter(Boolean);

    const showPendingSync = journey.finalState === "booked-api" && journey.syncedExpenseId === null;

    return (
        <div className="border-b border-hui-border last:border-b-0">
            <button
                type="button"
                onClick={() => setIsOpen((v) => !v)}
                aria-expanded={isOpen}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition"
            >
                <StateChip state={journey.finalState} />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-hui-textMain truncate">{primaryLabel}</p>
                    {subParts.length > 0 && (
                        <p className="text-xs text-hui-textMuted truncate">{subParts.join(" · ")}</p>
                    )}
                </div>
                <span
                    className="text-xs text-hui-textMuted whitespace-nowrap shrink-0"
                    title={new Date(journey.lastSeen).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                >
                    {formatRelativeTime(new Date(journey.lastSeen))}
                </span>
            </button>

            {isOpen && (
                <div className="px-4 pb-4 space-y-4">
                    <div className="space-y-2 pl-1">
                        {journey.steps.map((step, i) => (
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
                                    title={new Date(step.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
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

                    {suggestion && <SuggestionCard suggestion={suggestion} />}
                </div>
            )}
        </div>
    );
}

export default function JourneyList({
    journeys,
    suggestions,
}: {
    journeys: SerializedJourney[];
    suggestions: Record<string, FixSuggestion | null>;
}) {
    const [filter, setFilter] = useState<FilterKey>("all");

    const filtered = journeys.filter((j) => FILTERS.find((f) => f.key === filter)!.test(j));

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
                {FILTERS.map((f) => {
                    const count = journeys.filter(f.test).length;
                    const active = filter === f.key;
                    return (
                        <button
                            key={f.key}
                            type="button"
                            onClick={() => setFilter(f.key)}
                            className={`text-xs font-semibold px-3 py-1 rounded-full transition-colors ${
                                active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                            }`}
                        >
                            {f.label} ({count})
                        </button>
                    );
                })}
            </div>

            {filtered.length === 0 ? (
                <div className="hui-card">
                    <EmptyState />
                </div>
            ) : (
                <div className="hui-card overflow-hidden">
                    {filtered.map((j) => (
                        <JourneyRow key={j.docNumber} journey={j} suggestion={suggestions[j.docNumber] ?? null} />
                    ))}
                </div>
            )}
        </div>
    );
}
