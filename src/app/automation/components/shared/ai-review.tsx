"use client";

import { useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

export interface AiReviewRead {
    vendor: string | null;
    total: number | null;
    tax: number | null;
    date: string | null;
    legible: boolean;
    notes: string | null;
}

export interface AiReviewVerdict {
    field: "total" | "tax" | "vendor";
    state: "agree" | "flag" | "unknown";
    note?: string;
}

export interface AiReviewModelResult {
    model: string;
    read: AiReviewRead;
    verdicts: AiReviewVerdict[];
}

export interface AiReviewSuccess {
    ok: true;
    reviewedAt: string;
    anyFlag: boolean;
    /** Fail-closed ruling from the server; anyFlag alone can't express "couldn't tell". */
    outcome?: "agree" | "mismatch" | "inconclusive";
    models: AiReviewModelResult[];
    /** True when the receipt evidence was matched via the bare docNumber
     * prefix (no full driveFileId on record) — never present this review as
     * tied to a confirmed receipt when set. */
    unconfirmedMatch?: boolean;
}

export interface AiReviewFailure {
    ok: false;
    reason: string;
}

export type AiReviewResponse = AiReviewSuccess | AiReviewFailure;

/** Raw model read, shown in muted text under the per-field chips. */
export function aiReadLine(read: AiReviewRead): string {
    const vendor = read.vendor ?? "—";
    const total = read.total != null ? formatCurrency(read.total) : "—";
    const tax = read.tax != null ? formatCurrency(read.tax) : "—";
    const date = read.date ?? "—";
    return `read: ${vendor} · ${total} · tax ${tax} · ${date}`;
}

export function AiFieldChip({
    field,
    verdict,
    unconfirmed,
}: {
    field: AiReviewVerdict["field"];
    verdict: AiReviewVerdict | undefined;
    /** True when the receipt match itself is unconfirmed (possible prefix
     * collision) — a green "agree" checkmark here would read as confirmation
     * of the WRONG receipt's data, so it must downgrade to the same neutral
     * "?" chip as an unknown verdict. Flags stay red either way: a
     * disagreement is worth surfacing regardless of match confidence.
     * REQUIRED (A4) — an omitted prop must never silently default to
     * "confirmed" and let a guess render green. */
    unconfirmed: boolean;
}) {
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
    if (state === "agree" && !unconfirmed) {
        return (
            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700">
                {label} <span className="font-bold">✓</span>
            </span>
        );
    }
    return (
        <span
            className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500"
            title={state === "agree" && unconfirmed ? "Match unconfirmed — see warning above" : verdict?.note}
        >
            {label} <span className="font-bold">?</span>
        </span>
    );
}

export interface AiReviewIdentifiers {
    docNumber: string;
    /** Full Drive fileId, when known — sent so the server can resolve the
     * exact push event instead of falling back to the collision-prone
     * `docNumber` prefix. */
    driveFileId: string | null;
    qbPurchaseId: string | null;
}

/** Owns the "AI review" button's request state for one receipt: fires
 * `/api/automation/ai-review`, surfaces toasts on failure, exposes the
 * result for the caller to render. Extracted so any page embedding the
 * receipt validation panel gets the same AI review behavior, not a
 * reimplementation. */
export function useAiReview(ids: AiReviewIdentifiers) {
    const [aiReviewing, setAiReviewing] = useState(false);
    const [aiResult, setAiResult] = useState<AiReviewSuccess | null>(null);

    async function runAiReview() {
        setAiReviewing(true);
        setAiResult(null);
        try {
            const res = await fetch("/api/automation/ai-review", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    docNumber: ids.docNumber,
                    driveFileId: ids.driveFileId,
                    qbPurchaseId: ids.qbPurchaseId,
                }),
            });
            const data: AiReviewResponse | null = await res.json().catch(() => null);
            if (res.ok && data && data.ok) {
                setAiResult(data);
            } else {
                const reason = data && !data.ok ? data.reason : undefined;
                if (reason === "no-stored-copy") {
                    toast.error("Receipt copy not stored yet — AI review is available after the next sync.");
                } else if (reason === "ambiguous-match") {
                    toast.error("Can't tell which receipt this is — more than one shares the same ID. Check it by hand in QuickBooks.");
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

    return { aiReviewing, aiResult, runAiReview };
}
