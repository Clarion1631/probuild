"use client";

import { useState } from "react";

interface BackfillDetail {
    sessionId: string;
    type: "invoice" | "estimate" | "unknown";
    id: string;
    action: "synced" | "skipped" | "no_metadata" | "not_found";
    clientName?: string;
    docCode?: string;
    milestoneName?: string;
    amount?: number;
    paymentDate?: string;
    paymentMethod?: string;
}

interface BackfillError {
    sessionId: string;
    message: string;
}

interface BackfillResult {
    processed: number;
    skipped: number;
    errors: BackfillError[];
    details: BackfillDetail[];
}

const ACTION_LABEL: Record<string, string> = {
    synced: "Will sync",
    skipped: "Already paid",
    not_found: "Not found",
    no_metadata: "No metadata",
};

const ACTION_COLOR: Record<string, string> = {
    synced: "text-green-700 bg-green-50",
    skipped: "text-slate-500 bg-slate-100",
    not_found: "text-amber-700 bg-amber-50",
    no_metadata: "text-slate-400 bg-slate-50",
};

function toLocalDate(d: Date) {
    return d.toISOString().slice(0, 10);
}

function formatCurrency(n?: number) {
    if (n == null) return "—";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso?: string) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatMethod(m?: string) {
    if (!m || m === "unknown") return "—";
    if (m === "ach") return "ACH";
    if (m === "card") return "Card";
    return m;
}

export default function StripeBackfillPage() {
    const today = toLocalDate(new Date());
    const oneYearAgo = toLocalDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));

    const [startDate, setStartDate] = useState(oneYearAgo);
    const [endDate, setEndDate] = useState(today);
    const [dryRun, setDryRun] = useState(true);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<BackfillResult | null>(null);
    const [apiError, setApiError] = useState<string | null>(null);

    async function handleRun() {
        setLoading(true);
        setResult(null);
        setApiError(null);
        try {
            const res = await fetch("/api/admin/stripe-backfill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ startDate, endDate, dryRun }),
            });
            const data = await res.json();
            if (!res.ok) {
                setApiError(data.error ?? "Unknown error");
                // Show partial results if the API returned them alongside the error
                if (data.details) setResult(data);
            } else {
                setResult(data);
            }
        } catch (err: any) {
            setApiError(err.message);
        } finally {
            setLoading(false);
        }
    }

    const visibleDetails = result?.details.filter(d => d.action !== "no_metadata") ?? [];
    const noMetadataCount = result?.details.filter(d => d.action === "no_metadata").length ?? 0;

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-8">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Stripe Payment Sync</h1>
                <p className="text-hui-textMuted text-sm mt-1">
                    Backfill historical Stripe payments that were processed before the webhook was wired up,
                    or missed due to webhook delivery failures. Run a dry run first to preview changes.
                </p>
            </div>

            {/* Controls */}
            <div className="hui-card p-6 space-y-5">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs font-medium text-hui-textMuted mb-1.5">Start Date</label>
                        <input
                            type="date"
                            value={startDate}
                            onChange={e => setStartDate(e.target.value)}
                            className="hui-input w-full"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-hui-textMuted mb-1.5">End Date</label>
                        <input
                            type="date"
                            value={endDate}
                            onChange={e => setEndDate(e.target.value)}
                            className="hui-input w-full"
                        />
                    </div>
                </div>

                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={dryRun}
                        onChange={e => setDryRun(e.target.checked)}
                        className="w-4 h-4 rounded border-hui-border accent-hui-primary"
                    />
                    <span className="text-sm text-hui-textMain font-medium">Dry run</span>
                    <span className="text-xs text-hui-textMuted">(preview only — no DB changes)</span>
                </label>

                {!dryRun && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                        Live mode will write to the database. Only run after confirming the dry-run output looks correct.
                    </div>
                )}

                <button
                    onClick={handleRun}
                    disabled={loading}
                    className="hui-btn hui-btn-primary disabled:opacity-50"
                >
                    {loading ? "Running…" : dryRun ? "Preview (Dry Run)" : "Run Backfill"}
                </button>
            </div>

            {/* API error */}
            {apiError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3">
                    {apiError}
                </div>
            )}

            {/* Results */}
            {result && (
                <div className="space-y-5">
                    {/* Summary */}
                    <div className="grid grid-cols-3 gap-4">
                        <div className="hui-card p-4 text-center">
                            <div className="text-2xl font-bold text-green-700">{result.processed}</div>
                            <div className="text-xs text-hui-textMuted mt-1">{dryRun ? "Would sync" : "Synced"}</div>
                        </div>
                        <div className="hui-card p-4 text-center">
                            <div className="text-2xl font-bold text-slate-500">{result.skipped}</div>
                            <div className="text-xs text-hui-textMuted mt-1">Already paid</div>
                        </div>
                        <div className="hui-card p-4 text-center">
                            <div className="text-2xl font-bold text-red-600">{result.errors.length}</div>
                            <div className="text-xs text-hui-textMuted mt-1">Errors</div>
                        </div>
                    </div>

                    {/* Errors */}
                    {result.errors.length > 0 && (
                        <div className="hui-card p-4 space-y-2">
                            <h3 className="text-sm font-semibold text-red-700">Errors</h3>
                            {result.errors.map((e, i) => (
                                <div key={i} className="text-xs text-red-600 font-mono break-all">
                                    {e.sessionId}: {e.message}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Detail table */}
                    {visibleDetails.length > 0 && (
                        <div className="hui-card overflow-hidden">
                            <table className="w-full text-sm">
                                <thead className="bg-slate-50 border-b border-hui-border">
                                    <tr>
                                        <th className="text-left px-4 py-3 font-medium text-hui-textMuted">Client</th>
                                        <th className="text-left px-4 py-3 font-medium text-hui-textMuted">Document</th>
                                        <th className="text-left px-4 py-3 font-medium text-hui-textMuted">Milestone</th>
                                        <th className="text-right px-4 py-3 font-medium text-hui-textMuted">Amount</th>
                                        <th className="text-left px-4 py-3 font-medium text-hui-textMuted">Date</th>
                                        <th className="text-left px-4 py-3 font-medium text-hui-textMuted">Method</th>
                                        <th className="text-left px-4 py-3 font-medium text-hui-textMuted">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hui-border">
                                    {visibleDetails.map((d, i) => (
                                        <tr key={i} className="hover:bg-slate-50">
                                            <td className="px-4 py-3 font-medium text-hui-textMain">
                                                {d.clientName ?? <span className="text-hui-textMuted italic">Unknown</span>}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted">
                                                <span className="capitalize text-xs font-medium text-hui-textMuted mr-1">{d.type}</span>
                                                {d.docCode ?? "—"}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted">{d.milestoneName ?? "—"}</td>
                                            <td className="px-4 py-3 text-right font-medium text-hui-textMain tabular-nums">
                                                {formatCurrency(d.amount)}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted whitespace-nowrap">
                                                {formatDate(d.paymentDate)}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted">
                                                {formatMethod(d.paymentMethod)}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${ACTION_COLOR[d.action] ?? ""}`}>
                                                    {ACTION_LABEL[d.action] ?? d.action}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {noMetadataCount > 0 && (
                                <p className="text-xs text-hui-textMuted px-4 py-2 border-t border-hui-border">
                                    {noMetadataCount} Stripe session{noMetadataCount !== 1 ? "s" : ""} had no ProBuild metadata and were skipped.
                                </p>
                            )}
                        </div>
                    )}

                    {visibleDetails.length === 0 && result.errors.length === 0 && (
                        <p className="text-sm text-hui-textMuted text-center py-4">
                            No Stripe checkout sessions found in this date range.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
