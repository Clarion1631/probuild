"use client";

import { useState } from "react";

interface BackfillDetail {
    sessionId: string;
    type: "invoice" | "estimate" | "unknown";
    id: string;
    action: "synced" | "skipped" | "no_metadata" | "not_found";
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
    synced: "Synced",
    skipped: "Already paid",
    not_found: "Not found in DB",
    no_metadata: "No ProBuild metadata",
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

    return (
        <div className="max-w-3xl mx-auto py-8 px-6 space-y-8">
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
                            <table className="w-full text-xs">
                                <thead className="bg-slate-50 border-b border-hui-border">
                                    <tr>
                                        <th className="text-left px-4 py-2.5 font-medium text-hui-textMuted">Session ID</th>
                                        <th className="text-left px-4 py-2.5 font-medium text-hui-textMuted">Type</th>
                                        <th className="text-left px-4 py-2.5 font-medium text-hui-textMuted">Schedule ID</th>
                                        <th className="text-left px-4 py-2.5 font-medium text-hui-textMuted">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hui-border">
                                    {visibleDetails.map((d, i) => (
                                        <tr key={i} className="hover:bg-slate-50">
                                            <td className="px-4 py-2 font-mono text-slate-500 truncate max-w-[160px]">{d.sessionId}</td>
                                            <td className="px-4 py-2 capitalize text-hui-textMain">{d.type}</td>
                                            <td className="px-4 py-2 font-mono text-slate-500 truncate max-w-[160px]">{d.id}</td>
                                            <td className="px-4 py-2">
                                                <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${ACTION_COLOR[d.action] ?? ""}`}>
                                                    {ACTION_LABEL[d.action] ?? d.action}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {result.details.filter(d => d.action === "no_metadata").length > 0 && (
                                <p className="text-xs text-hui-textMuted px-4 py-2 border-t border-hui-border">
                                    {result.details.filter(d => d.action === "no_metadata").length} Stripe sessions had no ProBuild metadata and were skipped.
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
