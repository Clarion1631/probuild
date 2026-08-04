import { formatRelativeTime } from "./format";

/**
 * Sync-run summary + history, unchanged from the old `/automation` page
 * (Unified Money Register plan §5 step 7 — "pipeline health ... displaced
 * from the old page, unchanged"). Split out of page.tsx so both the
 * "Last sync" summary line (pipeline status card) and the full sync-runs
 * table can share the same parsing/formatting without duplicating it.
 */

interface SkippedSampleItem {
    qbPurchaseId: string;
    reason: string;
}

export interface SyncCounts {
    imported?: number;
    updated?: number;
    skipped?: number;
    deactivated?: number;
    skippedByReason?: Record<string, number>;
    skippedSample?: SkippedSampleItem[];
}

function parseSkippedByReason(value: unknown): Record<string, number> | undefined {
    if (!value || typeof value !== "object") return undefined;
    const entries = Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number"
    );
    return entries.length ? Object.fromEntries(entries) : undefined;
}

function parseSkippedSample(value: unknown): SkippedSampleItem[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((item): item is SkippedSampleItem => {
        if (!item || typeof item !== "object") return false;
        const obj = item as Record<string, unknown>;
        return typeof obj.qbPurchaseId === "string" && typeof obj.reason === "string";
    });
    return items.length ? items : undefined;
}

export function parseSyncCounts(detail: string | null): SyncCounts | null {
    if (!detail) return null;
    try {
        const parsed: unknown = JSON.parse(detail);
        if (!parsed || typeof parsed !== "object") return null;
        const obj = parsed as Record<string, unknown>;
        return {
            imported: typeof obj.imported === "number" ? obj.imported : undefined,
            updated: typeof obj.updated === "number" ? obj.updated : undefined,
            skipped: typeof obj.skipped === "number" ? obj.skipped : undefined,
            deactivated: typeof obj.deactivated === "number" ? obj.deactivated : undefined,
            skippedByReason: parseSkippedByReason(obj.skippedByReason),
            skippedSample: parseSkippedSample(obj.skippedSample),
        };
    } catch {
        return null;
    }
}

export function describeSource(source: string | null): string {
    if (!source) return "unknown";
    return source.startsWith("manual:") ? "manual" : source;
}

function formatCounts(counts: SyncCounts): string {
    const parts: string[] = [];
    if (counts.imported) parts.push(`${counts.imported} imported`);
    if (counts.updated) parts.push(`${counts.updated} updated`);
    if (counts.skipped) parts.push(`${counts.skipped} skipped`);
    if (counts.deactivated) parts.push(`${counts.deactivated} deactivated`);
    return parts.length ? parts.join(", ") : "no changes";
}

const SKIP_REASON_LABELS: Record<string, string> = {
    "no-active-project": "no matching active project in ProBuild",
    "missing-customer": "no job on the transaction (overhead)",
    "equity-draw": "owner draw",
    "mixed-customer-allocation": "job and non-job lines mixed",
    "multiple-customers": "split across multiple jobs",
    "invalid-amount": "zero or invalid amount",
    "overhead-project-unavailable": "overhead project unavailable",
    "ambiguous-project": "matches more than one project",
    "no-estimate": "project has no estimate to cost against",
    "missing-purchase-id": "QuickBooks row missing its id",
    "missing-sync-token": "QuickBooks row missing its sync token",
    "invalid-transaction-date": "invalid transaction date",
};

function describeSkipReason(reason: string): string {
    return SKIP_REASON_LABELS[reason] ?? reason;
}

export function formatSkippedBreakdown(byReason: Record<string, number>): string {
    return Object.entries(byReason)
        .sort(([, a], [, b]) => b - a)
        .map(([reason, count]) => `${count} × ${describeSkipReason(reason)}`)
        .join(" · ");
}

export function SyncStatusPill({ status }: { status: string }) {
    const style =
        status === "error"
            ? { bg: "bg-red-100", text: "text-red-700", label: "Error" }
            : { bg: "bg-teal-100", text: "text-teal-700", label: "Synced" };
    return (
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${style.bg} ${style.text}`}>
            {style.label}
        </span>
    );
}

export interface LastSync {
    at: Date;
    status: string;
    source: string | null;
    detail: string | null;
}

/** The "Last sync ... N imported, M skipped" summary line + skip breakdown,
 * unchanged from the old page's pipeline status card. */
export function LastSyncSummary({ lastSync }: { lastSync: LastSync | null }) {
    if (!lastSync) {
        return <p className="text-xs text-hui-textMuted">No sync has run yet.</p>;
    }
    const counts = parseSyncCounts(lastSync.detail);
    return (
        <>
            <p className="text-xs text-hui-textMuted" title={lastSync.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}>
                {formatRelativeTime(lastSync.at)} · {lastSync.status} · {describeSource(lastSync.source)}
                {counts && (
                    <>
                        {" · "}
                        {formatCounts(counts)}
                    </>
                )}
            </p>
            {counts?.skipped && counts.skippedByReason && (
                <p
                    className="text-xs text-hui-textMuted mt-0.5"
                    title={[
                        counts.skippedSample?.length
                            ? `QBO purchases: ${counts.skippedSample.map((s) => s.qbPurchaseId).join(", ")}`
                            : null,
                        "Skipped means QuickBooks kept it, but it wasn't matched to a ProBuild job — loans, overhead, and owner draws are supposed to be skipped.",
                    ].filter(Boolean).join(". ")}
                >
                    Skipped: {formatSkippedBreakdown(counts.skippedByReason)}
                </p>
            )}
        </>
    );
}

export interface SyncRunEvent {
    id: string;
    createdAt: Date;
    status: string;
    source: string | null;
    reason: string | null;
    detail: string | null;
}

/** The collapsed-by-default sync-runs history table, unchanged from the old page. */
export function SyncRunsTable({ runs }: { runs: SyncRunEvent[] }) {
    return (
        <details className="hui-card group">
            <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between text-base font-semibold text-hui-textMain select-none">
                Sync runs
                <span className="text-xs font-normal text-hui-textMuted group-open:hidden">Show</span>
                <span className="text-xs font-normal text-hui-textMuted hidden group-open:inline">Hide</span>
            </summary>
            <div className="border-t border-hui-border overflow-hidden">
                {runs.length === 0 ? (
                    <p className="text-sm text-hui-textMuted px-5 py-6">No sync runs recorded yet.</p>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-hui-border bg-slate-50">
                                <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider w-32">When</th>
                                <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Status + source</th>
                                <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Counts</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {runs.map((e) => {
                                const counts = parseSyncCounts(e.detail);
                                return (
                                    <tr key={e.id} className="hover:bg-slate-50 transition">
                                        <td className="px-4 py-3 text-hui-textMuted whitespace-nowrap" title={e.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}>
                                            {formatRelativeTime(e.createdAt)}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMain">
                                            <div className="flex items-center gap-2">
                                                <SyncStatusPill status={e.status} />
                                                <span className="text-xs text-hui-textMuted">{describeSource(e.source)}</span>
                                            </div>
                                            {e.status === "error" && e.reason && (
                                                <p className="text-xs text-hui-textMuted mt-1">{e.reason}</p>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted">
                                            <div>{counts ? formatCounts(counts) : "—"}</div>
                                            {counts?.skipped && counts.skippedByReason && (
                                                <p className="text-xs text-hui-textMuted mt-0.5">
                                                    {formatSkippedBreakdown(counts.skippedByReason)}
                                                </p>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </details>
    );
}
