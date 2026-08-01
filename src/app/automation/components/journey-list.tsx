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
    /** True when reconstructed from QBO history rather than observed live. */
    backfilled: boolean;
    /** Full Drive fileId — powers the "Open in Drive" link. */
    driveFileId: string | null;
    /** QBO purchase id — powers the QBO deep link. */
    qbPurchaseId: string | null;
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

type FilterKey = "all" | "booked" | "needs-attention" | "in-flight";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

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
    "ai-review": "AI review",
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

function StateChip({ state }: { state: SerializedJourney["finalState"] }) {
    const style = FINAL_STATE_STYLE[state];
    return (
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${style.bg} ${style.text}`}>
            <span className={style.pulse ? "animate-pulse" : ""}>{style.icon}</span>
            {style.label}
        </span>
    );
}

/** True once a booked-api receipt has gone longer than the 4h sync cadence
 * (plus a buffer) without landing in ProBuild — worth a human look. */
function isStaleBookedApi(journey: SerializedJourney): boolean {
    if (journey.finalState !== "booked-api" || journey.synced) return false;
    return Date.now() - new Date(journey.lastSeen).getTime() >= FIVE_HOURS_MS;
}

/**
 * Exception-first verdict: one owner-readable sentence per row. An audit
 * event proves what happened at booking time — this line summarizes that,
 * not a live QuickBooks re-check (that's what "Verify in QuickBooks" is for).
 */
function journeyVerdict(journey: SerializedJourney, suggestion: FixSuggestion | null): { text: string; attention: boolean } {
    if (journey.finalState === "booked-api") {
        if (journey.synced) return { text: "Booked and in job costs", attention: false };
        if (isStaleBookedApi(journey)) {
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

const FILTERS: { key: FilterKey; label: string; test: (j: SerializedJourney) => boolean }[] = [
    { key: "all", label: "All", test: () => true },
    { key: "booked", label: "Booked", test: (j) => j.finalState === "booked-api" || j.finalState === "booked-email" },
    {
        key: "needs-attention",
        label: "Needs attention",
        test: (j) => j.finalState === "parked" || j.finalState === "quarantined" || j.finalState === "error" || isStaleBookedApi(j),
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

// ── Validation station ──────────────────────────────────────────────────────

interface VerifyBookingEvidence {
    amountCents: number | null;
    taxCents: number | null;
    vendor: string | null;
    projectName: string | null;
    bookedAt: string;
    attachment: string | null;
}

interface VerifyLiveState {
    amountCents: number | null;
    taxCents: number | null;
    vendor: string | null;
    projectName: string | null;
    txnDate: string | null;
    markerIntact: boolean | null;
}

interface VerifyVerdict {
    field: string;
    state: "verified" | "needs-attention" | "unknown";
    note?: string;
}

interface VerifySuccess {
    ok: true;
    verifiedAt: string;
    deleted: boolean;
    booking: VerifyBookingEvidence;
    live: VerifyLiveState | null;
    verdicts: VerifyVerdict[];
}

interface VerifyFailure {
    ok: false;
    reason: string;
}

type VerifyResponse = VerifySuccess | VerifyFailure;

// ── AI review ────────────────────────────────────────────────────────────

interface AiReviewRead {
    vendor: string | null;
    total: number | null;
    tax: number | null;
    date: string | null;
    legible: boolean;
    notes: string | null;
}

interface AiReviewVerdict {
    field: "total" | "tax" | "vendor";
    state: "agree" | "flag" | "unknown";
    note?: string;
}

interface AiReviewModelResult {
    model: string;
    read: AiReviewRead;
    verdicts: AiReviewVerdict[];
}

interface AiReviewSuccess {
    ok: true;
    reviewedAt: string;
    anyFlag: boolean;
    /** Fail-closed ruling from the server; anyFlag alone can't express "couldn't tell". */
    outcome?: "agree" | "mismatch" | "inconclusive";
    models: AiReviewModelResult[];
}

interface AiReviewFailure {
    ok: false;
    reason: string;
}

type AiReviewResponse = AiReviewSuccess | AiReviewFailure;

/** Raw model read, shown in muted text under the per-field chips. */
function aiReadLine(read: AiReviewRead): string {
    const vendor = read.vendor ?? "—";
    const total = read.total != null ? formatCurrency(read.total) : "—";
    const tax = read.tax != null ? formatCurrency(read.tax) : "—";
    const date = read.date ?? "—";
    return `read: ${vendor} · ${total} · tax ${tax} · ${date}`;
}

function AiFieldChip({ field, verdict }: { field: AiReviewVerdict["field"]; verdict: AiReviewVerdict | undefined }) {
    const label = field.charAt(0).toUpperCase() + field.slice(1);
    const state = verdict?.state ?? "unknown";
    if (state === "flag") {
        return (
            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
                {label} <span className="font-bold">!</span>
                {verdict?.note ? ` ${verdict.note}` : ""}
            </span>
        );
    }
    if (state === "agree") {
        return (
            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700">
                {label} <span className="font-bold">✓</span>
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500" title={verdict?.note}>
            {label} <span className="font-bold">?</span>
        </span>
    );
}

function money(cents: number | null | undefined): string {
    return cents != null ? formatCurrency(cents / 100) : "—";
}

/** Renders the booking-time attachment evidence carried on `booking.attachment`
 * ("attached" | "skipped" | "failed:<reason>"). Returns null for no evidence. */
function attachmentLine(attachment: string | null): { text: string; className: string } | null {
    if (attachment == null) return null;
    if (attachment === "attached") {
        return { text: "Attachment at booking: attached ✓", className: "text-teal-700" };
    }
    if (attachment === "skipped") {
        return { text: "Attachment at booking: skipped", className: "text-hui-textMuted" };
    }
    if (attachment.startsWith("failed:")) {
        return { text: `Attachment at booking: failed: ${attachment.slice("failed:".length)}`, className: "text-red-700" };
    }
    return { text: `Attachment at booking: ${attachment}`, className: "text-hui-textMuted" };
}

function VerdictIcon({ state, note }: { state: VerifyVerdict["state"]; note?: string }) {
    if (state === "verified") {
        return (
            <span className="text-teal-700" title={note || "Verified against QuickBooks right now"}>
                ✓
            </span>
        );
    }
    if (state === "needs-attention") {
        return (
            <span className="text-red-700 font-bold" title={note || "Needs attention"}>
                !
            </span>
        );
    }
    return (
        <span className="text-slate-400" title={note || "Not enough data to compare"}>
            ?
        </span>
    );
}

function ReceiptPreview({ journey }: { journey: SerializedJourney }) {
    const url = journey.synced?.receiptUrl ?? null;
    const isPdf = url ? /\.pdf(\?|#|$)/i.test(url) : false;
    const hasDrive = Boolean(journey.driveFileId);
    const hasProject = Boolean(journey.synced?.projectId);

    return (
        <div className="space-y-2">
            {url ? (
                isPdf ? (
                    <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 border border-hui-border rounded-lg p-6 text-sm font-medium text-hui-textMain hover:bg-slate-50 transition"
                    >
                        Open receipt PDF
                    </a>
                ) : (
                    <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block border border-hui-border rounded-lg overflow-hidden hover:opacity-90 transition"
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={journey.fileName || "Receipt"} className="w-full h-auto object-contain max-h-80" />
                    </a>
                )
            ) : !hasDrive ? (
                <p className="text-xs text-hui-textMuted italic">No stored copy yet — appears after the next sync.</p>
            ) : null}
            {(hasDrive || hasProject) && (
                <div className="flex items-center gap-3 flex-wrap">
                    {hasDrive && (
                        <a
                            href={`https://drive.google.com/file/d/${journey.driveFileId}/view`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-medium text-hui-primary hover:underline"
                        >
                            Open in Drive
                        </a>
                    )}
                    {hasProject && (
                        <a href={`/projects/${journey.synced!.projectId}`} className="text-xs font-medium text-hui-primary hover:underline">
                            Open project
                        </a>
                    )}
                </div>
            )}
        </div>
    );
}

function ValidationPanel({ journey }: { journey: SerializedJourney }) {
    const [verifying, setVerifying] = useState(false);
    const [result, setResult] = useState<VerifySuccess | null>(null);
    const [aiReviewing, setAiReviewing] = useState(false);
    const [aiResult, setAiResult] = useState<AiReviewSuccess | null>(null);

    async function handleVerify() {
        setVerifying(true);
        setResult(null);
        try {
            const res = await fetch("/api/automation/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ docNumber: journey.docNumber }),
            });
            const data: VerifyResponse | null = await res.json().catch(() => null);
            if (res.ok && data && data.ok) {
                setResult(data);
            } else {
                const reason = data && !data.ok ? data.reason : undefined;
                toast.error(`Couldn't verify: ${reason || `HTTP ${res.status}`}`);
            }
        } catch {
            toast.error("Couldn't verify: network error");
        } finally {
            setVerifying(false);
        }
    }

    async function handleAiReview() {
        setAiReviewing(true);
        setAiResult(null);
        try {
            const res = await fetch("/api/automation/ai-review", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ docNumber: journey.docNumber }),
            });
            const data: AiReviewResponse | null = await res.json().catch(() => null);
            if (res.ok && data && data.ok) {
                setAiResult(data);
            } else {
                const reason = data && !data.ok ? data.reason : undefined;
                if (reason === "no-stored-copy") {
                    toast.error("Receipt copy not stored yet — AI review is available after the next sync.");
                } else {
                    toast.error(reason || `HTTP ${res.status}`);
                }
            }
        } catch {
            toast.error("Couldn't run AI review: network error");
        } finally {
            setAiReviewing(false);
        }
    }

    const showLive = Boolean(result && !result.deleted && result.live);
    const verdictFor = (field: string) => result?.verdicts.find((v) => v.field === field);
    const markerVerdict = verdictFor("marker");

    // "Booked (at booking time)" reflects the audit trail by default; once a
    // Verify has run, it shows the booking evidence the verify call itself
    // re-derived from that same audit event (see /api/automation/verify).
    const bookingSource = result?.booking ?? null;
    const bookedVendor = bookingSource ? bookingSource.vendor : journey.vendor;
    const bookedAmount = bookingSource ? bookingSource.amountCents : journey.amountCents;
    const bookedTax = bookingSource ? bookingSource.taxCents : journey.taxCents;
    const bookedProject = bookingSource ? bookingSource.projectName : journey.projectName;

    // Backfilled journeys were reconstructed from QBO history — there was no
    // live OCR extraction step, so that column would be misleading.
    const extractedVendor = journey.backfilled ? "Not recorded" : journey.vendor ?? "—";
    const extractedAmount = journey.backfilled ? "Not recorded" : money(journey.amountCents);
    const extractedTax = journey.backfilled ? "Not recorded" : money(journey.taxCents);
    const extractedProject = journey.backfilled ? "Not recorded" : journey.projectName ?? "—";

    const rows: { label: string; extracted: string; booked: string; inProBuild: string; liveText: string; liveVerdict?: VerifyVerdict }[] = [
        {
            label: "Vendor",
            extracted: extractedVendor,
            booked: bookedVendor ?? "—",
            inProBuild: journey.synced?.vendor ?? "—",
            liveText: showLive ? result!.live!.vendor ?? "—" : "—",
            liveVerdict: verdictFor("vendor"),
        },
        {
            label: "Amount",
            extracted: extractedAmount,
            booked: money(bookedAmount),
            inProBuild: money(journey.synced?.amountCents ?? null),
            liveText: showLive ? money(result!.live!.amountCents) : "—",
            liveVerdict: verdictFor("amount"),
        },
        {
            label: "Sales tax",
            extracted: extractedTax,
            booked: money(bookedTax),
            inProBuild: "—",
            liveText: showLive ? money(result!.live!.taxCents) : "—",
            liveVerdict: verdictFor("tax"),
        },
        {
            label: "Project",
            extracted: extractedProject,
            booked: bookedProject ?? "—",
            inProBuild: journey.synced?.projectName ?? "—",
            liveText: showLive ? result!.live!.projectName ?? "—" : "—",
            liveVerdict: verdictFor("project"),
        },
    ];

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ReceiptPreview journey={journey} />

            <div>
                {result?.deleted && (
                    <div className="mb-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                        This purchase no longer exists in QuickBooks
                    </div>
                )}

                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-hui-border">
                                <th className="text-left py-1.5 pr-2 font-semibold text-hui-textMuted uppercase tracking-wider">Field</th>
                                <th className="text-left py-1.5 px-2 font-semibold text-hui-textMuted uppercase tracking-wider">Extracted</th>
                                <th className="text-left py-1.5 px-2 font-semibold text-hui-textMuted uppercase tracking-wider">Booked (at booking time)</th>
                                <th className="text-left py-1.5 px-2 font-semibold text-hui-textMuted uppercase tracking-wider">In ProBuild</th>
                                {showLive && (
                                    <th className="text-left py-1.5 pl-2 font-semibold text-hui-textMuted uppercase tracking-wider">In QuickBooks (live)</th>
                                )}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {rows.map((row) => (
                                <tr key={row.label}>
                                    <td className="py-1.5 pr-2 font-medium text-hui-textMain whitespace-nowrap">{row.label}</td>
                                    <td className="py-1.5 px-2 text-hui-textMuted">{row.extracted}</td>
                                    <td className="py-1.5 px-2 text-hui-textMuted">{row.booked}</td>
                                    <td className="py-1.5 px-2 text-hui-textMuted">{row.inProBuild}</td>
                                    {showLive && (
                                        <td className="py-1.5 pl-2 text-hui-textMuted">
                                            <span className="inline-flex items-center gap-1.5">
                                                {row.liveVerdict && <VerdictIcon state={row.liveVerdict.state} note={row.liveVerdict.note} />}
                                                {row.liveText}
                                            </span>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {markerVerdict && markerVerdict.state === "needs-attention" && (
                    <p className="text-xs text-red-700 mt-2">⚠ {markerVerdict.note}</p>
                )}

                {result && result.booking.attachment != null && (
                    <p className={`text-xs mt-2 ${attachmentLine(result.booking.attachment)!.className}`}>
                        {attachmentLine(result.booking.attachment)!.text}
                    </p>
                )}

                <div className="flex items-center gap-3 mt-3 flex-wrap">
                    {journey.qbPurchaseId ? (
                        <button
                            type="button"
                            onClick={handleVerify}
                            disabled={verifying}
                            className="hui-btn hui-btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 disabled:opacity-50"
                        >
                            {verifying ? (
                                <>
                                    <svg className="animate-spin w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    Verifying…
                                </>
                            ) : (
                                "Verify in QuickBooks"
                            )}
                        </button>
                    ) : journey.finalState === "booked-email" ? (
                        <p className="text-xs text-hui-textMuted">
                            Booked by hand via the email path — nothing to auto-verify. Check it in QuickBooks directly.
                        </p>
                    ) : null}

                    {journey.synced?.receiptUrl && (
                        <button
                            type="button"
                            onClick={handleAiReview}
                            disabled={aiReviewing}
                            className="hui-btn hui-btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 disabled:opacity-50"
                        >
                            {aiReviewing ? (
                                <>
                                    <svg className="animate-spin w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    Reviewing…
                                </>
                            ) : (
                                "AI review"
                            )}
                        </button>
                    )}

                    {result && (
                        <span
                            className="text-xs text-hui-textMuted"
                            title={new Date(result.verifiedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                        >
                            Verified {formatRelativeTime(new Date(result.verifiedAt))}
                        </span>
                    )}
                </div>

                {aiResult && (
                    <div className="mt-3 space-y-2">
                        <p className={`text-xs font-medium ${
                            aiResult.outcome === "inconclusive"
                                ? "text-amber-700"
                                : aiResult.anyFlag ? "text-red-700" : "text-teal-700"
                        }`}>
                            {aiResult.outcome === "inconclusive"
                                ? "⚠ Couldn't reach a confident verdict — check this one manually against the receipt image"
                                : aiResult.anyFlag
                                    ? "⚠ A model disagrees with what was booked — check the flagged fields"
                                    : `${aiResult.models.length === 1 ? "Model agrees" : "Both models agree"} with what was booked ✓`}
                        </p>
                        {aiResult.models.map((m) => (
                            <div key={m.model} className="border border-hui-border rounded-lg p-2.5">
                                <p className="text-xs font-semibold text-hui-textMain mb-1">{m.model}</p>
                                {m.read.legible === false ? (
                                    <p className="text-xs text-hui-textMuted italic">Model couldn't read this receipt confidently</p>
                                ) : (
                                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                                        {(["total", "tax", "vendor"] as const).map((field) => (
                                            <AiFieldChip key={field} field={field} verdict={m.verdicts.find((v) => v.field === field)} />
                                        ))}
                                    </div>
                                )}
                                <p className="text-xs text-hui-textMuted">{aiReadLine(m.read)}</p>
                                {m.read.notes != null && <p className="text-xs text-hui-textMuted italic mt-0.5">{m.read.notes}</p>}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
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

function JourneyRow({ journey, suggestion }: { journey: SerializedJourney; suggestion: FixSuggestion | null }) {
    const [isOpen, setIsOpen] = useState(false);

    const primaryLabel = journey.fileName || journey.vendor || journey.docNumber;
    const subParts = [
        journey.vendor,
        journey.projectName,
        journey.amountCents != null ? formatCurrency(journey.amountCents / 100) : null,
    ].filter(Boolean);

    const showPendingSync = journey.finalState === "booked-api" && journey.syncedExpenseId === null;
    const verdict = journeyVerdict(journey, suggestion);

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
                    <p className={`text-xs truncate mt-0.5 ${verdict.attention ? "text-red-700 font-medium" : "text-hui-textMuted"}`}>
                        {verdict.text}
                        {journey.backfilled && (
                            <span className="ml-1.5 inline-block align-middle text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">
                                Imported history
                            </span>
                        )}
                    </p>
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
                    <ValidationPanel journey={journey} />

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

                    {journey.qbPurchaseId && <QbPurchaseLink qbPurchaseId={journey.qbPurchaseId} />}
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
