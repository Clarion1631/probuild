import type { ReactNode } from "react";
import { formatCurrency } from "@/lib/utils";
import type { AutomationDayBucket } from "@/lib/automation-events";
import IntakeChart from "./intake-chart";
import PipelineControls from "./pipeline-controls";
import { StatCard } from "./shared/stat-card";
import { SavedHoursStrip } from "./shared/saved-hours-strip";
import { LastSyncSummary, SyncRunsTable, type LastSync, type SyncRunEvent } from "./sync-runs";

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

/**
 * Everything displaced from the old `/automation` page, unchanged (Unified
 * Money Register plan §3/§5 step 7): the four pipeline metrics, the intake
 * chart, the sync-runs table, and the pause/resume controls. Register-level
 * concerns (money in/out, documentation status, orphan receipts) live on the
 * page itself now — this is purely "is the automation pipeline healthy",
 * collapsed by default since the register is the page's spine.
 */
export function PipelineHealth({
    pushedThisMonth,
    handsFreeRate30d,
    amountCentsThisMonth,
    taxCentsThisMonth,
    lastSync,
    buckets,
    hoursSavedLabel,
    onARoll,
    pushEnabled,
    syncCronEnabled,
    receiptPushPaused,
    qboSyncPaused,
    isAdmin,
    syncRuns,
    now,
}: {
    pushedThisMonth: number;
    handsFreeRate30d: number | null;
    amountCentsThisMonth: number;
    taxCentsThisMonth: number;
    lastSync: LastSync | null;
    buckets: AutomationDayBucket[];
    hoursSavedLabel: string;
    onARoll: boolean;
    pushEnabled: boolean;
    syncCronEnabled: boolean;
    receiptPushPaused: boolean;
    qboSyncPaused: boolean;
    isAdmin: boolean;
    syncRuns: SyncRunEvent[];
    /** Single timestamp captured once, server-side — see `formatRelativeTime`'s
     * doc comment (components/format.ts). */
    now: number;
}) {
    const chartEmpty = buckets.every((b) => b.created === 0 && b.fallback === 0 && b.error === 0);

    return (
        <details className="hui-card group">
            <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between text-base font-semibold text-hui-textMain select-none">
                Pipeline health
                <span className="text-xs font-normal text-hui-textMuted group-open:hidden">Show</span>
                <span className="text-xs font-normal text-hui-textMuted hidden group-open:inline">Hide</span>
            </summary>
            <div className="border-t border-hui-border p-5 space-y-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard label="Receipts booked this month" value={String(pushedThisMonth)} />
                    <StatCard
                        label="Hands-free rate (last 30 days)"
                        value={handsFreeRate30d === null ? "—" : `${Math.round(handsFreeRate30d * 100)}%`}
                        sub="Booked automatically, or emailed when that wasn't possible"
                    />
                    <StatCard label="Booked this month" value={formatCurrency(amountCentsThisMonth / 100)} />
                    <StatCard
                        label="Sales tax captured"
                        value={formatCurrency(taxCentsThisMonth / 100)}
                        sub="Reclaimable — reseller permit"
                    />
                </div>

                <ChartPanel
                    title="Receipts processed — last 30 days"
                    subtitle="Booked automatically, emailed instead, or ran into an error."
                    isEmpty={chartEmpty}
                >
                    <IntakeChart data={buckets} />
                </ChartPanel>

                <SavedHoursStrip hoursSavedLabel={hoursSavedLabel} onARoll={onARoll} />

                <div className="hui-card p-5">
                    <h3 className="text-base font-semibold text-hui-textMain mb-4">Pipeline status</h3>
                    <div className="space-y-3">
                        <PipelineControls
                            pushEnabled={pushEnabled}
                            syncCronEnabled={syncCronEnabled}
                            receiptPushPaused={receiptPushPaused}
                            qboSyncPaused={qboSyncPaused}
                            isAdmin={isAdmin}
                        />
                        <div className="flex items-center justify-between py-2">
                            <div>
                                <p className="text-sm font-medium text-hui-textMain">Last sync</p>
                                <LastSyncSummary lastSync={lastSync} now={now} />
                            </div>
                        </div>
                    </div>
                    <p className="text-xs text-hui-textMuted mt-4 pt-3 border-t border-hui-border">
                        Receipt scan runs every 10 minutes in Google Drive.
                    </p>
                </div>

                <SyncRunsTable runs={syncRuns} now={now} />
            </div>
        </details>
    );
}
