import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUserWithPermissions, hasPermission, isAdminOrManager } from "@/lib/permissions";
import {
    automationSummary,
    receiptDailyBuckets,
    recentAutomationEvents,
    receiptJourneys,
    type ReceiptJourney,
} from "@/lib/automation-events";
import { suggestFix, type FixSuggestion } from "@/lib/automation-suggestions";
import { pauseStates } from "@/lib/automation-settings";
import IntakeChart from "./components/intake-chart";
import SyncNowButton from "./components/sync-now-button";
import PipelineControls from "./components/pipeline-controls";
import JourneyList, { type SerializedJourney } from "./components/journey-list";
import { formatRelativeTime } from "./components/format";

export const dynamic = "force-dynamic";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="hui-card p-5">
            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-bold text-hui-textMain mt-1">{value}</p>
            {sub && <p className="text-xs text-hui-textMuted mt-1">{sub}</p>}
        </div>
    );
}

function ChartPanel({ title, subtitle, isEmpty, children }: { title: string; subtitle: string; isEmpty: boolean; children: ReactNode }) {
    return (
        <div className="hui-card p-5">
            <h2 className="text-base font-semibold text-hui-textMain mb-1">{title}</h2>
            <p className="text-xs text-hui-textMuted mb-3">{subtitle}</p>
            {isEmpty ? (
                <div className="flex items-center justify-center text-sm text-hui-textMuted" style={{ height: 280 }}>
                    No receipts processed in this window yet.
                </div>
            ) : (
                children
            )}
        </div>
    );
}

// ── Sync runs section helpers (adapted from the old activity-feed.tsx) ─────

interface SkippedSampleItem {
    qbPurchaseId: string;
    reason: string;
}

interface SyncCounts {
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

function parseSyncCounts(detail: string | null): SyncCounts | null {
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

function describeSource(source: string | null): string {
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

function formatSkippedBreakdown(byReason: Record<string, number>): string {
    return Object.entries(byReason)
        .sort(([, a], [, b]) => b - a)
        .map(([reason, count]) => `${count} × ${describeSkipReason(reason)}`)
        .join(" · ");
}

function SyncStatusPill({ status }: { status: string }) {
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

// ── Journey serialization ───────────────────────────────────────────────────

function serializeJourney(j: ReceiptJourney): SerializedJourney {
    return {
        docNumber: j.docNumber,
        fileName: j.fileName,
        vendor: j.vendor,
        projectName: j.projectName,
        amountCents: j.amountCents,
        taxCents: j.taxCents,
        firstSeen: j.firstSeen.toISOString(),
        lastSeen: j.lastSeen.toISOString(),
        steps: j.steps.map((s) => ({
            at: s.at.toISOString(),
            stage: s.stage,
            status: s.status,
            reason: s.reason,
            detail: s.detail,
        })),
        finalState: j.finalState,
        finalReason: j.finalReason,
        syncedExpenseId: j.syncedExpenseId,
        syncedProjectName: j.syncedProjectName,
        backfilled: j.backfilled,
        driveFileId: j.driveFileId,
        qbPurchaseId: j.qbPurchaseId,
        synced: j.synced
            ? {
                  expenseId: j.synced.expenseId,
                  projectId: j.synced.projectId,
                  projectName: j.synced.projectName,
                  amountCents: j.synced.amountCents,
                  vendor: j.synced.vendor,
                  receiptUrl: j.synced.receiptUrl,
                  syncedAt: j.synced.syncedAt.toISOString(),
              }
            : null,
    };
}

export default async function AutomationPage() {
    const user = await getCurrentUserWithPermissions();
    if (!user) redirect("/login");
    if (!hasPermission(user, "financialReports")) redirect("/projects");

    const isAdmin = isAdminOrManager(user);

    const pushEnabled = process.env.QBO_RECEIPT_PUSH_ENABLED === "true";
    const syncCronEnabled = process.env.QBO_EXPENSE_SYNC_CRON_ENABLED !== "false";

    const [summary, buckets, events, journeys, pauses] = await Promise.all([
        automationSummary(),
        receiptDailyBuckets(30),
        recentAutomationEvents(50),
        receiptJourneys(30, 100),
        pauseStates(),
    ]);

    const chartEmpty = buckets.every((b) => b.created === 0 && b.fallback === 0 && b.error === 0);

    // "≈4 minutes of manual entry" per receipt is a rough, admittedly-fuzzy
    // stand-in for the real number (vendor lookup + line items + payment
    // method + filing) — rounded to the nearest half hour so it reads as an
    // estimate, not a stopwatch reading.
    const minutesSaved = summary.pushedThisMonth * 4;
    const hoursSavedRaw = Math.round((minutesSaved / 60) * 2) / 2;
    const hoursSavedLabel = Number.isInteger(hoursSavedRaw) ? String(hoursSavedRaw) : hoursSavedRaw.toFixed(1);
    const onARoll = summary.handsFreeRate30d !== null && summary.handsFreeRate30d >= 0.8;

    const lastSyncCounts = summary.lastSync ? parseSyncCounts(summary.lastSync.detail) : null;

    const serializedJourneys = journeys.map(serializeJourney);
    const suggestions: Record<string, FixSuggestion | null> = {};
    for (const j of journeys) {
        const suggestion = suggestFix(j);
        if (suggestion) suggestions[j.docNumber] = suggestion;
    }

    const syncRuns = events.filter((e) => e.kind === "qbo-sync").slice(0, 15);

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Automation</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Receipts in, books done — the pipeline watching itself.
                    </p>
                    <div className="flex gap-3">
                        <a href="/automation/guide" target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-hui-primary hover:underline">
                            How this pipeline works ↗
                        </a>
                        <a href="/automation/bank" className="text-xs font-medium text-hui-primary hover:underline">
                            Bank register →
                        </a>
                    </div>
                </div>
                {isAdmin && (
                    <SyncNowButton
                        disabled={pauses.qboSyncPaused}
                        disabledTitle="Sync is paused — resume it first"
                    />
                )}
            </div>

            {/* Stat tiles */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Receipts booked this month" value={String(summary.pushedThisMonth)} />
                <StatCard
                    label="Hands-free rate (30d)"
                    value={summary.handsFreeRate30d === null ? "—" : `${Math.round(summary.handsFreeRate30d * 100)}%`}
                    sub="Booked automatically vs. emailed as fallback"
                />
                <StatCard label="Booked this month" value={formatCurrency(summary.amountCentsThisMonth / 100)} />
                <StatCard
                    label="Sales tax captured"
                    value={formatCurrency(summary.taxCentsThisMonth / 100)}
                    sub="Reclaimable — reseller permit"
                />
            </div>

            {/* Receipts — per-receipt journey drill-down */}
            <div>
                <h2 className="text-base font-semibold text-hui-textMain mb-3">Receipts</h2>
                <JourneyList journeys={serializedJourneys} suggestions={suggestions} />
            </div>

            {/* Intake chart */}
            <ChartPanel
                title="Receipts processed — last 30 days"
                subtitle="Booked automatically vs. email fallback vs. errors."
                isEmpty={chartEmpty}
            >
                <IntakeChart data={buckets} />
            </ChartPanel>

            {/* Gamified strip */}
            <div className="hui-card p-5">
                <p className="text-sm text-hui-textMain">
                    <span className="font-semibold">≈ {hoursSavedLabel} hrs</span> of data entry saved this month
                </p>
                {onARoll && (
                    <p className="text-sm text-hui-textMain mt-1">🔥 The robots are on a roll</p>
                )}
            </div>

            {/* Status card */}
            <div className="hui-card p-5">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Pipeline status</h2>
                <div className="space-y-3">
                    <PipelineControls
                        pushEnabled={pushEnabled}
                        syncCronEnabled={syncCronEnabled}
                        receiptPushPaused={pauses.receiptPushPaused}
                        qboSyncPaused={pauses.qboSyncPaused}
                        isAdmin={isAdmin}
                    />
                    <div className="flex items-center justify-between py-2">
                        <div>
                            <p className="text-sm font-medium text-hui-textMain">Last sync</p>
                            {summary.lastSync ? (
                                <>
                                    <p className="text-xs text-hui-textMuted" title={summary.lastSync.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}>
                                        {formatRelativeTime(summary.lastSync.at)} · {summary.lastSync.status} · {describeSource(summary.lastSync.source)}
                                        {lastSyncCounts && (
                                            <>
                                                {" · "}
                                                {[
                                                    lastSyncCounts.imported ? `${lastSyncCounts.imported} imported` : null,
                                                    lastSyncCounts.updated ? `${lastSyncCounts.updated} updated` : null,
                                                    lastSyncCounts.skipped ? `${lastSyncCounts.skipped} skipped` : null,
                                                    lastSyncCounts.deactivated ? `${lastSyncCounts.deactivated} deactivated` : null,
                                                ].filter(Boolean).join(", ") || "no changes"}
                                            </>
                                        )}
                                    </p>
                                    {lastSyncCounts?.skipped && lastSyncCounts.skippedByReason && (
                                        <p
                                            className="text-xs text-hui-textMuted mt-0.5"
                                            title={[
                                                lastSyncCounts.skippedSample?.length
                                                    ? `QBO purchases: ${lastSyncCounts.skippedSample.map((s) => s.qbPurchaseId).join(", ")}`
                                                    : null,
                                                "Skipped means QuickBooks kept it but it didn't map to a ProBuild job — loans, overhead, and owner draws are supposed to be skipped.",
                                            ].filter(Boolean).join(". ")}
                                        >
                                            Skipped: {formatSkippedBreakdown(lastSyncCounts.skippedByReason)}
                                        </p>
                                    )}
                                </>
                            ) : (
                                <p className="text-xs text-hui-textMuted">No sync has run yet.</p>
                            )}
                        </div>
                    </div>
                </div>
                <p className="text-xs text-hui-textMuted mt-4 pt-3 border-t border-hui-border">
                    Receipt scan runs every 10 minutes in Google Drive.
                </p>
            </div>

            {/* Sync runs — collapsed by default */}
            <details className="hui-card group">
                <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between text-base font-semibold text-hui-textMain select-none">
                    Sync runs
                    <span className="text-xs font-normal text-hui-textMuted group-open:hidden">Show</span>
                    <span className="text-xs font-normal text-hui-textMuted hidden group-open:inline">Hide</span>
                </summary>
                <div className="border-t border-hui-border overflow-hidden">
                    {syncRuns.length === 0 ? (
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
                                {syncRuns.map((e) => {
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
        </div>
    );
}
