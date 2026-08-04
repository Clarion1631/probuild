"use client";

import { useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { SerializedJourney } from "../journey-list";
import { formatRelativeTime } from "../format";
import { AiFieldChip, aiReadLine, useAiReview } from "./ai-review";

// ── Validation station ──────────────────────────────────────────────────────

export interface VerifyBookingEvidence {
    amountCents: number | null;
    taxCents: number | null;
    vendor: string | null;
    projectName: string | null;
    bookedAt: string;
    attachment: string | null;
}

export interface VerifyLiveState {
    amountCents: number | null;
    taxCents: number | null;
    vendor: string | null;
    projectName: string | null;
    txnDate: string | null;
    markerIntact: boolean | null;
}

export interface VerifyVerdict {
    field: string;
    state: "verified" | "needs-attention" | "unknown";
    note?: string;
}

export interface VerifySuccess {
    ok: true;
    verifiedAt: string;
    deleted: boolean;
    booking: VerifyBookingEvidence;
    live: VerifyLiveState | null;
    verdicts: VerifyVerdict[];
    /** True when the booking evidence was matched via the bare docNumber
     * prefix (no full driveFileId/qbPurchaseId on record) — never present
     * this as a confirmed match. */
    unconfirmedMatch?: boolean;
}

export interface VerifyFailure {
    ok: false;
    reason: string;
}

export type VerifyResponse = VerifySuccess | VerifyFailure;

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

/** The per-receipt drill-down: extracted vs. booked vs. in-ProBuild vs. live
 * QuickBooks comparison table, the "Verify in QuickBooks" live-check action,
 * and the on-demand AI review. Extracted so the merged register page reuses
 * this exact panel instead of reimplementing it. */
export function ValidationPanel({ journey }: { journey: SerializedJourney }) {
    const [verifying, setVerifying] = useState(false);
    const [result, setResult] = useState<VerifySuccess | null>(null);
    const { aiReviewing, aiResult, runAiReview } = useAiReview({
        docNumber: journey.docNumber,
        driveFileId: journey.driveFileId,
        qbPurchaseId: journey.qbPurchaseId,
    });

    // True whenever any evidence for this receipt came from the bare
    // 21-char docNumber prefix rather than a confirmed full driveFileId/
    // qbPurchaseId — two different Drive fileIds can share that prefix
    // (qbo-receipt-push.ts:477-481), so this panel may be showing the wrong
    // receipt's data. Never present confirmed/agreement language when true.
    const matchUnconfirmed = !journey.keyConfirmed || Boolean(result?.unconfirmedMatch) || Boolean(aiResult?.unconfirmedMatch);

    async function handleVerify() {
        setVerifying(true);
        setResult(null);
        try {
            const res = await fetch("/api/automation/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    docNumber: journey.docNumber,
                    driveFileId: journey.driveFileId,
                    qbPurchaseId: journey.qbPurchaseId,
                }),
            });
            const data: VerifyResponse | null = await res.json().catch(() => null);
            if (res.ok && data && data.ok) {
                setResult(data);
            } else {
                const reason = data && !data.ok ? data.reason : undefined;
                if (reason === "ambiguous-match") {
                    toast.error("Can't tell which receipt this is — more than one shares the same id prefix. Check it manually in QuickBooks.");
                } else {
                    toast.error(`Couldn't verify: ${reason || `HTTP ${res.status}`}`);
                }
            }
        } catch {
            toast.error("Couldn't verify: network error");
        } finally {
            setVerifying(false);
        }
    }

    const showLive = Boolean(result && !result.deleted && result.live);
    const verdictFor = (field: string) => {
        const v = result?.verdicts.find((v) => v.field === field);
        // Never show a confirmed "verified" checkmark against unconfirmed
        // receipt evidence — downgrade to the neutral "unknown" display.
        if (v && v.state === "verified" && matchUnconfirmed) {
            return { ...v, state: "unknown" as const, note: "Match unconfirmed — see warning above" };
        }
        return v;
    };
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
                {matchUnconfirmed && (
                    <div className="mb-2 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        Possible prefix collision — unconfirmed. Two different Drive files can share this
                        identifier, so this may not be the receipt this row is showing.
                    </div>
                )}

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
                            onClick={runAiReview}
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
                                : aiResult.anyFlag
                                    ? "text-red-700"
                                    // Never present "agree" as confirmed when the receipt
                                    // match itself is unconfirmed — a collision means this
                                    // review may have read the WRONG receipt.
                                    : matchUnconfirmed ? "text-amber-700" : "text-teal-700"
                        }`}>
                            {aiResult.outcome === "inconclusive"
                                ? "⚠ Couldn't reach a confident verdict — check this one manually against the receipt image"
                                : aiResult.anyFlag
                                    ? "⚠ A model disagrees with what was booked — check the flagged fields"
                                    : matchUnconfirmed
                                        ? "⚠ Model read matches the booked values, but the receipt match itself is unconfirmed — verify manually"
                                        : `${aiResult.models.length === 1 ? "Model agrees" : "Both models agree"} with what was booked ✓`}
                        </p>
                        {aiResult.models.map((m) => (
                            <div key={m.model} className="border border-hui-border rounded-lg p-2.5">
                                <p className="text-xs font-semibold text-hui-textMain mb-1">{m.model}</p>
                                {m.read.legible === false ? (
                                    <p className="text-xs text-hui-textMuted italic">Model couldn&apos;t read this receipt confidently</p>
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
