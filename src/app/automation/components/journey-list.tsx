"use client";

import { useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { FixSuggestion } from "@/lib/automation-suggestions";
import { formatRelativeTime } from "./format";
import { StateChip, FINAL_STATE_STYLE } from "./shared/state-chip";
import { StepTimeline } from "./shared/step-timeline";
import { isStaleBookedApi } from "./shared/stale-detection";
import { type FilterKey, FILTERS, ReceiptFilterBar } from "./shared/receipt-filters";
import { SuggestionCard } from "./shared/suggestion-card";
import { ValidationPanel } from "./shared/validation-panel";

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
    /** True when reconstructed from QBO history rather than observed live. */
    backfilled: boolean;
    /** Full Drive fileId — powers the "Open in Drive" link. */
    driveFileId: string | null;
    /** QBO purchase id — powers the QBO deep link. */
    qbPurchaseId: string | null;
    /** False when this journey was grouped by the bare docNumber prefix
     * (no full driveFileId on record) — a prefix collision with a
     * different receipt is possible, so never present it as confirmed. */
    keyConfirmed: boolean;
    /** What actually landed in ProBuild after the 4h sync. */
    synced: {
        expenseId: string;
        projectId: string | null;
        projectName: string | null;
        amountCents: number | null;
        vendor: string | null;
        receiptUrl: string | null;
        syncedAt: string;
    } | null;
}

/** Stable per-journey key — mirrors `journeyKey()` in `@/lib/automation-events`
 * (the server-side equivalent operating on `Date` instead of the serialized
 * ISO string here). Trust order: full driveFileId, then full qbPurchaseId,
 * then a composite of the bare docNumber prefix + firstSeen. N4: this used
 * to skip the qbPurchaseId tier and fall straight to docNumber+firstSeen —
 * two QBO-only journeys sharing a prefix AND a firstSeen instant could
 * collide onto the same key. Used for both the React list key and the
 * fix-suggestion lookup below. */
function journeyKey(j: Pick<SerializedJourney, "driveFileId" | "qbPurchaseId" | "docNumber" | "firstSeen">): string {
    return j.driveFileId ?? (j.qbPurchaseId ? `qb:${j.qbPurchaseId}` : `${j.docNumber}:${j.firstSeen}`);
}

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
                This list fills in as new receipts come through.
            </p>
        </div>
    );
}

/**
 * Exception-first verdict: one owner-readable sentence per row. An audit
 * event proves what happened at booking time — this line summarizes that,
 * not a live QuickBooks re-check (that's what "Verify in QuickBooks" is for).
 */
function journeyVerdict(journey: SerializedJourney, suggestion: FixSuggestion | null, nowMs: number): { text: string; attention: boolean } {
    if (journey.finalState === "booked-api") {
        if (journey.synced) return { text: "Booked and in job costs", attention: false };
        if (isStaleBookedApi(journey, nowMs)) {
            return { text: "Booked but not yet in ProBuild — worth a look", attention: true };
        }
        return { text: "Booked — waiting for the next sync (runs every 4 hours)", attention: false };
    }
    if (journey.finalState === "booked-email") {
        return { text: "Booked via email (not hands-free)", attention: false };
    }
    const attention = journey.finalState === "parked" || journey.finalState === "quarantined" || journey.finalState === "error";
    return {
        text: suggestion?.diagnosis ?? journey.finalReason ?? FINAL_STATE_STYLE[journey.finalState].label,
        attention,
    };
}

function QbPurchaseLink({ qbPurchaseId }: { qbPurchaseId: string }) {
    async function copyId() {
        try {
            await navigator.clipboard.writeText(qbPurchaseId);
            toast.success("QuickBooks purchase ID copied");
        } catch {
            toast.error("Couldn't copy — select and copy manually");
        }
    }

    return (
        <div
            className="flex items-center gap-2 text-xs text-hui-textMuted flex-wrap"
            title="The QuickBooks link is best-effort — if it doesn't open the purchase, use the copied ID to search in QuickBooks instead."
        >
            <a
                href={`https://qbo.intuit.com/app/expense?txnId=${qbPurchaseId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-hui-primary hover:underline"
            >
                QuickBooks purchase #{qbPurchaseId}
            </a>
            <button type="button" onClick={copyId} className="hui-btn hui-btn-secondary text-xs px-2 py-0.5">
                Copy ID
            </button>
        </div>
    );
}

function JourneyRow({ journey, suggestion, now }: { journey: SerializedJourney; suggestion: FixSuggestion | null; now: number }) {
    const [isOpen, setIsOpen] = useState(false);

    const primaryLabel = journey.fileName || journey.vendor || journey.docNumber;
    const subParts = [
        journey.vendor,
        journey.projectName,
        journey.amountCents != null ? formatCurrency(journey.amountCents / 100) : null,
    ].filter(Boolean);

    const showPendingSync = journey.finalState === "booked-api" && journey.syncedExpenseId === null;
    const verdict = journeyVerdict(journey, suggestion, now);
    // The dedupe stage records "duplicate-of:<driveFileId>" (or the
    // possible-duplicate variant) — surface it as a link to the ORIGINAL so
    // a reviewer can eyeball both without hand-searching Drive.
    const duplicateOfFileId = journey.finalReason?.match(/^(?:possible-)?duplicate-of:([\w-]+)$/)?.[1] ?? null;

    return (
        <div className="border-b border-hui-border last:border-b-0">
            <button
                type="button"
                onClick={() => setIsOpen((v) => !v)}
                aria-expanded={isOpen}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition"
            >
                <StateChip state={journey.finalState} unconfirmed={!journey.keyConfirmed} />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-hui-textMain truncate">{primaryLabel}</p>
                    {subParts.length > 0 && (
                        <p className="text-xs text-hui-textMuted truncate">{subParts.join(" · ")}</p>
                    )}
                    <p className={`text-xs truncate mt-0.5 ${verdict.attention ? "text-red-700 font-medium" : "text-hui-textMuted"}`}>
                        {verdict.text}
                        {journey.backfilled && (
                            <span className="ml-1.5 inline-block align-middle text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">
                                Imported history
                            </span>
                        )}
                        {!journey.keyConfirmed && (
                            <span
                                className="ml-1.5 inline-block align-middle text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700"
                                title="Two different files can share this same ID, so this might be a different receipt than the one shown."
                            >
                                Unconfirmed match
                            </span>
                        )}
                    </p>
                </div>
                <span
                    className="text-xs text-hui-textMuted whitespace-nowrap shrink-0"
                    title={new Date(journey.lastSeen).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" })}
                >
                    {formatRelativeTime(new Date(journey.lastSeen), now)}
                </span>
            </button>

            {isOpen && (
                <div className="px-4 pb-4 space-y-4">
                    <ValidationPanel journey={journey} now={now} />

                    <StepTimeline steps={journey.steps} showPendingSync={showPendingSync} unconfirmed={!journey.keyConfirmed} now={now} />

                    {suggestion && <SuggestionCard suggestion={suggestion} />}

                    {duplicateOfFileId && (
                        <a
                            href={`https://drive.google.com/file/d/${encodeURIComponent(duplicateOfFileId)}/view`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-medium text-hui-primary hover:underline"
                        >
                            Open the original it duplicates (Drive) ↗
                        </a>
                    )}

                    {journey.qbPurchaseId && <QbPurchaseLink qbPurchaseId={journey.qbPurchaseId} />}
                </div>
            )}
        </div>
    );
}

/** "2026-08" bucket for a journey, from firstSeen (when the receipt entered
 * the pipeline — stable, unlike lastSeen which moves on every later step) in
 * the company's timezone. en-CA gives ISO-style YYYY-MM-DD to slice. */
function monthKey(iso: string): string {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }).slice(0, 7);
}

function monthLabel(key: string): string {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export default function JourneyList({
    journeys,
    suggestions,
    now,
}: {
    journeys: SerializedJourney[];
    suggestions: Record<string, FixSuggestion | null>;
    /** A single timestamp captured once on the server and threaded through
     * both the SSR and hydration render passes — see `isStaleBookedApi`'s
     * doc comment for why this can't be `Date.now()` called in here. */
    now: number;
}) {
    const [filter, setFilter] = useState<FilterKey>("all");
    const [month, setMonth] = useState<string>("all");
    const [search, setSearch] = useState<string>("");

    const months = [...new Set(journeys.map((j) => monthKey(j.firstSeen)))].sort().reverse();

    // Month + search narrow the dataset first; the status chips (and their
    // counts) then operate on that scope, so the numbers always add up.
    const query = search.trim().toLowerCase();
    const scoped = journeys.filter(
        (j) =>
            (month === "all" || monthKey(j.firstSeen) === month) &&
            (query === "" ||
                (j.vendor ?? "").toLowerCase().includes(query) ||
                (j.projectName ?? "").toLowerCase().includes(query) ||
                (j.fileName ?? "").toLowerCase().includes(query)),
    );
    const filtered = scoped.filter((j) => FILTERS.find((f) => f.key === filter)!.test(j, now));

    return (
        <div className="space-y-3">
            <ReceiptFilterBar journeys={scoped} filter={filter} onFilterChange={setFilter} now={now} />
            <div className="flex flex-wrap items-center gap-2">
                <select
                    value={month}
                    onChange={(e) => setMonth(e.target.value)}
                    aria-label="Filter by received month"
                    className="text-xs font-medium text-hui-textMain bg-white border border-hui-border rounded-lg px-2 py-1.5"
                >
                    <option value="all">All months</option>
                    {months.map((m) => (
                        <option key={m} value={m}>
                            {monthLabel(m)}
                        </option>
                    ))}
                </select>
                <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search vendor, project, or file…"
                    aria-label="Search receipts by vendor, project, or file name"
                    className="text-xs text-hui-textMain bg-white border border-hui-border rounded-lg px-2.5 py-1.5 w-56 max-w-full"
                />
                {(month !== "all" || search !== "") && (
                    <button
                        type="button"
                        onClick={() => {
                            setMonth("all");
                            setSearch("");
                        }}
                        className="text-xs font-medium text-hui-primary hover:underline"
                    >
                        Clear filters
                    </button>
                )}
            </div>

            {filtered.length === 0 ? (
                <div className="hui-card">
                    <EmptyState />
                </div>
            ) : (
                <div className="hui-card overflow-hidden">
                    {filtered.map((j) => (
                        // Never key on the bare docNumber alone — it's a 21-char Drive
                        // fileId prefix that two different receipts can share, which
                        // would collide two unrelated rows onto one React key. Also
                        // keys the fix-suggestion lookup (`journeyKey` above) for the
                        // same reason — a truncated docNumber key would let two
                        // journeys sharing that prefix overwrite each other's entry.
                        <JourneyRow
                            key={journeyKey(j)}
                            journey={j}
                            suggestion={suggestions[journeyKey(j)] ?? null}
                            now={now}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
