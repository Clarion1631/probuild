import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUserWithPermissions, hasPermission, isAdminOrManager } from "@/lib/permissions";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { fetchBankRegister, type BankRegisterRow } from "@/lib/qbo-bank-register";
import { isPurchaseType } from "@/lib/register-types";
import {
    mergeRegister,
    classifyOrphanReceipts,
    actionableOrphanReceipts,
    type MergedRegisterRow,
    type OrphanReceipt,
} from "@/lib/register-merge";
import {
    automationSummary,
    receiptDailyBuckets,
    recentAutomationEvents,
    receiptJourneys,
    type ReceiptJourney,
} from "@/lib/automation-events";
import { suggestFix, type FixSuggestion } from "@/lib/automation-suggestions";
import { pauseStates } from "@/lib/automation-settings";
import {
    fetchRegisterMergeInputs,
    orphanProjectNames,
    drilldownExpenseByPurchaseId,
    type RawExpense,
} from "./register-data";
import { formatRelativeTime, friendlyType } from "./components/format";
import { StatCard } from "./components/shared/stat-card";
import SyncNowButton from "./components/sync-now-button";
import CopyIdButton from "./components/copy-id-button";
import { DocumentationPips } from "./components/register/documentation-pips";
import { OrphanReceipts } from "./components/register/orphan-receipts";
import { JourneySection } from "./components/register/journey-section";
import type { SerializedJourney } from "./components/journey-list";
import { PipelineHealth } from "./components/pipeline-health";
import { ExpandableRow } from "./components/register/expandable-row";
import { LinksCell } from "./components/register/links-cell";
import { RowDrilldown } from "./components/register/row-drilldown";
import { matchReceiptJourney, type ReceiptJourneyMatch } from "./components/register/match-receipt-journey";
import { toSerializedJourney } from "./components/register/serialize-journey";

export const dynamic = "force-dynamic";

// ── Filters (plan §3 — "shared across the whole page") ─────────────────────

type RangeKey = "30" | "60" | "90";
type TypeFilter = "all" | "in" | "out";

function parseFilters(sp: Record<string, string | string[] | undefined>) {
    const range: RangeKey = sp.range === "60" || sp.range === "90" ? sp.range : "30";
    const type: TypeFilter = sp.type === "in" || sp.type === "out" ? sp.type : "all";
    const reviewOnly = sp.review === "1";
    // Deep link for the future Chat card's link button (plan §3/§5 step 9):
    // ?focus=<qbTxnId> expands that row and scrolls it into view on load.
    const focus = typeof sp.focus === "string" && sp.focus ? sp.focus : null;
    return { range, type, reviewOnly, focus };
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
    return (
        <a
            href={href}
            className={`inline-flex items-center px-3 py-1 text-xs font-medium rounded-full transition ${
                active ? "bg-hui-primary text-white" : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
            }`}
        >
            {children}
        </a>
    );
}

// ── Register table helpers ──────────────────────────────────────────────────

/** One row's worth of what the table renders — built either from a fully
 * merged register row, or (when the merge inputs couldn't be fetched, see
 * `mergeUnavailable` below) straight from the raw bank register row with an
 * honest "unavailable" note instead of pips. Keeps the table's JSX single-path
 * regardless of which source produced the row. */
interface DisplayRow {
    key: string;
    date: string;
    qbType: string;
    docNum: string | null;
    name: string | null;
    amountCents: number;
    isPurchase: boolean;
    qbTxnId: string | null;
    projectId: string | null;
    projectName: string | null;
    receiptUrl: string | null;
    documentation: ReactNode;
    needsReview: boolean;
    /** Present only when the merge succeeded — powers the row drill-down
     * (plan §3/§5 step 9). Null on the degraded raw-register fallback path,
     * where there's no edge/status data to drill into. */
    drilldown: { row: MergedRegisterRow; expense: RawExpense | null; journeyMatch: ReceiptJourneyMatch | null } | null;
}

function sinceMsForRangeDays(days: number): number {
    return Date.now() - days * 86_400_000;
}

function ConnectionErrorCard({ title, message }: { title: string; message: string }) {
    return (
        <div className="hui-card p-8 text-center">
            <h2 className="text-base font-semibold text-hui-textMain">{title}</h2>
            <p className="text-sm text-hui-textMuted mt-1">{message}</p>
        </div>
    );
}

export default async function AutomationPage(props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await getCurrentUserWithPermissions();
    if (!user) redirect("/login");
    if (!hasPermission(user, "financialReports")) redirect("/projects");

    const isAdmin = isAdminOrManager(user);
    const sp = await props.searchParams;
    const { range, type, reviewOnly, focus } = parseFilters(sp);

    function filterHref(overrides: { range?: string; type?: string; review?: string }) {
        const params = new URLSearchParams();
        const nextRange = overrides.range ?? range;
        const nextType = overrides.type ?? type;
        const nextReview = overrides.review ?? (reviewOnly ? "1" : "0");
        if (nextRange !== "30") params.set("range", nextRange);
        if (nextType !== "all") params.set("type", nextType);
        if (nextReview === "1") params.set("review", "1");
        const qs = params.toString();
        return qs ? `/automation?${qs}` : "/automation";
    }

    const pushEnabled = process.env.QBO_RECEIPT_PUSH_ENABLED === "true";
    const syncCronEnabled = process.env.QBO_EXPENSE_SYNC_CRON_ENABLED !== "false";

    const endDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const rangeDays = Number(range);
    const startDateObj = new Date(`${endDate}T00:00:00Z`);
    // Both endpoints inclusive in the GL report — "30d" means 30 dates.
    startDateObj.setUTCDate(startDateObj.getUTCDate() - (rangeDays - 1));
    const startDate = startDateObj.toISOString().slice(0, 10);

    let registerRows: BankRegisterRow[] | null = null;
    let fetchedAt = "";
    let stale = false;
    let errorCard: ReactNode = null;

    try {
        // Tokens are fetched lazily INSIDE fetchBankRegister — only on a
        // cache miss — because getFreshQBTokens refreshes OAuth every call.
        const register = await fetchBankRegister(getFreshQBTokens, startDate, endDate);
        registerRows = register.rows;
        fetchedAt = register.fetchedAt;
        stale = register.stale;
    } catch (error) {
        if (error instanceof QBNotConnectedError) {
            errorCard = <ConnectionErrorCard title="QuickBooks isn't connected" message="Connect QuickBooks to see the register." />;
        } else {
            errorCard = (
                <ConnectionErrorCard
                    title="Couldn't load the register"
                    message="Couldn't load the register from QuickBooks — try again in a minute."
                />
            );
        }
    }

    if (!registerRows) {
        return (
            <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Automation</h1>
                </div>
                {errorCard}
            </div>
        );
    }

    // Merge inputs (job-cost expenses, receipt-push audit events, purchase
    // classifications) are a separate fetch from the register itself, and
    // can fail independently of it (e.g. the dev DB gap on
    // AutomationEvent.qbPurchaseId/driveFileId ahead of that migration —
    // see register-data.ts). Degrade to the raw register with an honest
    // "documentation status unavailable" note rather than losing the whole
    // page over it. Only data (no JSX) is computed inside the try — JSX
    // construction is lazy, so building elements inside a try/catch can't
    // actually catch their render errors and is left for after this block.
    let mergeUnavailable = false;
    let documented = 0, receiptProvenanceUnverified = 0, needsReview = 0, expectedNonJobSpend = 0, unknownClassification = 0, denominator = 0;
    let mergedRows: MergedRegisterRow[] | null = null;
    let actionableOrphans: OrphanReceipt[] = [];
    let orphanProjectNameMap = new Map<string, string>();
    let receiptJourneyList: ReceiptJourney[] = [];
    let expenseByPurchaseId = new Map<string, RawExpense>();

    try {
        const mergeInputs = await fetchRegisterMergeInputs(registerRows, sinceMsForRangeDays(rangeDays));
        const merged = mergeRegister(registerRows, mergeInputs.expenses, mergeInputs.receiptEvents, mergeInputs.classifications);
        const orphans = classifyOrphanReceipts(mergeInputs.receiptEvents, registerRows);
        // Row drill-down inputs (plan §3/§5 step 9): same known dev-DB gap as
        // mergeInputs above (AutomationEvent.qbPurchaseId/driveFileId), so
        // fetched in the same try/catch — both degrade together.
        receiptJourneyList = await receiptJourneys(rangeDays, 200);
        expenseByPurchaseId = drilldownExpenseByPurchaseId(mergeInputs.rawExpenses);

        mergedRows = merged.rows;
        documented = merged.counts.documented;
        receiptProvenanceUnverified = merged.counts.receiptProvenanceUnverified;
        needsReview = merged.counts.needsReview;
        expectedNonJobSpend = merged.counts.expectedNonJobSpend;
        unknownClassification = merged.counts.unknownClassification;
        denominator = merged.counts.denominator;
        actionableOrphans = actionableOrphanReceipts(orphans);
        orphanProjectNameMap = orphanProjectNames(mergeInputs.rawReceiptEvents);
    } catch (error) {
        console.error("register merge inputs failed", error instanceof Error ? error.message : "UnknownError");
        mergeUnavailable = true;
    }

    const orphanCount = actionableOrphans.length;
    const orphanSection: ReactNode = mergeUnavailable ? (
        <div className="hui-card p-5 text-sm text-hui-textMuted">
            Orphan receipts unavailable right now — documentation data couldn&apos;t be loaded.
        </div>
    ) : (
        <OrphanReceipts orphans={actionableOrphans} projectNames={orphanProjectNameMap} />
    );

    // Receipt journey list (plan §3) — reuses the same receiptJourneyList
    // fetched above for row drill-down, and the same toSerializedJourney used
    // by row-drilldown.tsx, so driveFileId/qbPurchaseId/keyConfirmed carry
    // through identically in both places.
    const serializedJourneys: SerializedJourney[] = receiptJourneyList.map(toSerializedJourney);
    const journeySuggestions: Record<string, FixSuggestion | null> = {};
    for (const j of receiptJourneyList) {
        const suggestion = suggestFix(j);
        if (suggestion) journeySuggestions[j.docNumber] = suggestion;
    }
    const journeySection: ReactNode = mergeUnavailable ? (
        <div className="hui-card p-5 text-sm text-hui-textMuted">
            Receipt pipeline view unavailable right now — documentation data couldn&apos;t be loaded.
        </div>
    ) : (
        <JourneySection journeys={serializedJourneys} suggestions={journeySuggestions} />
    );

    const displayRows: DisplayRow[] = mergedRows
        ? mergedRows.map((r, i) => ({
            key: `${r.qbTxnId ?? "row"}-${i}`,
            date: r.date,
            qbType: r.qbType,
            docNum: r.docNum,
            name: r.name,
            amountCents: r.amountCents,
            isPurchase: r.isPurchaseType,
            qbTxnId: r.qbTxnId,
            projectId: r.projectId,
            projectName: r.projectName,
            receiptUrl: r.receiptUrl,
            documentation: <DocumentationPips row={r} />,
            needsReview: r.status === "needs-review",
            drilldown: {
                row: r,
                expense: r.qbTxnId ? expenseByPurchaseId.get(r.qbTxnId) ?? null : null,
                journeyMatch: r.edges ? matchReceiptJourney(r, receiptJourneyList) : null,
            },
        }))
        : registerRows.map((r, i) => ({
            key: `${r.qbTxnId ?? "row"}-${i}`,
            date: r.date,
            qbType: r.qbType,
            docNum: r.docNum,
            name: r.name,
            amountCents: r.amountCents,
            isPurchase: isPurchaseType(r.qbType),
            qbTxnId: r.qbTxnId,
            projectId: null,
            projectName: null,
            receiptUrl: null,
            documentation: <span className="text-xs text-hui-textMuted italic">Documentation status unavailable</span>,
            needsReview: false,
            drilldown: null,
        }));

    const moneyInCents = registerRows.filter((r) => r.amountCents > 0).reduce((sum, r) => sum + r.amountCents, 0);
    const moneyOutCents = registerRows.filter((r) => r.amountCents < 0).reduce((sum, r) => sum + Math.abs(r.amountCents), 0);

    const filteredRows = displayRows.filter((row) => {
        if (reviewOnly && !row.needsReview) return false;
        if (type === "in") return row.amountCents > 0;
        if (type === "out") return row.amountCents < 0;
        return true;
    });

    // Pipeline health inputs — independent of the register/merge above, so a
    // register or merge failure doesn't need to take this section down too.
    const [summary, buckets, events, pauses] = await Promise.all([
        automationSummary(),
        receiptDailyBuckets(30),
        recentAutomationEvents(50),
        pauseStates(),
    ]);
    const minutesSaved = summary.pushedThisMonth * 4;
    const hoursSavedRaw = Math.round((minutesSaved / 60) * 2) / 2;
    const hoursSavedLabel = Number.isInteger(hoursSavedRaw) ? String(hoursSavedRaw) : hoursSavedRaw.toFixed(1);
    const onARoll = summary.handsFreeRate30d !== null && summary.handsFreeRate30d >= 0.8;
    const syncRuns = events.filter((e) => e.kind === "qbo-sync").slice(0, 15);

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Automation</h1>
                    <p className="text-sm text-hui-textMuted mt-1 max-w-3xl">
                        QuickBooks WTB account register — posted QuickBooks entries affecting account 154, fetched at{" "}
                        <span title={new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}>
                            {formatRelativeTime(new Date(fetchedAt))}
                        </span>
                        . This view cannot see bank transactions that are pending, excluded, or missing from QuickBooks.
                        Bank-side completeness requires the monthly WTB CSV compare.
                    </p>
                    {stale && (
                        <div className="mt-2 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            QuickBooks didn&apos;t answer just now — showing the last successful fetch.
                        </div>
                    )}
                    {mergeUnavailable && (
                        <div className="mt-2 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            Documentation status (receipt / job cost / amount) couldn&apos;t be loaded right now — the register
                            itself below is still current.
                        </div>
                    )}
                    <div className="flex gap-3 mt-2">
                        <a href="/automation/guide" target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-hui-primary hover:underline">
                            How this pipeline works ↗
                        </a>
                        <a href={filterHref({})} className="text-xs font-medium text-hui-primary hover:underline">
                            Refresh ↻
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
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <StatCard label="Money in" value={formatCurrency(moneyInCents / 100)} valueClassName="text-teal-700" />
                <StatCard label="Money out" value={formatCurrency(moneyOutCents / 100)} />
                <StatCard
                    label="Documented"
                    value={mergeUnavailable ? "—" : `${documented} of ${denominator} job-costable spend rows`}
                />
                <StatCard label="Needs review" value={mergeUnavailable ? "—" : String(needsReview)} />
                <StatCard label="Orphan exceptions" value={mergeUnavailable ? "—" : String(orphanCount)} />
            </div>

            {/* Secondary counts — nothing hides, plan §2 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard
                    label="Expected non-job spend"
                    value={mergeUnavailable ? "—" : String(expectedNonJobSpend)}
                    sub="Overhead / owner draw — excluded from the denominator on purpose"
                />
                <StatCard
                    label="Receipt provenance unverified"
                    value={mergeUnavailable ? "—" : String(receiptProvenanceUnverified)}
                    sub="Job cost + amount confirmed, no receipt-push audit record"
                />
                <StatCard
                    label="Unknown classification"
                    value={mergeUnavailable ? "—" : String(unknownClassification)}
                    sub="Never auto-documented, never hidden"
                />
            </div>

            {/* Filters — shared across the register table */}
            <div className="flex gap-2 flex-wrap items-center">
                <FilterChip href={filterHref({ range: "30" })} active={range === "30"}>30d</FilterChip>
                <FilterChip href={filterHref({ range: "60" })} active={range === "60"}>60d</FilterChip>
                <FilterChip href={filterHref({ range: "90" })} active={range === "90"}>90d</FilterChip>
                <span className="w-px h-4 bg-slate-300 mx-1" />
                <FilterChip href={filterHref({ type: "all" })} active={type === "all"}>All</FilterChip>
                <FilterChip href={filterHref({ type: "in" })} active={type === "in"}>Money in</FilterChip>
                <FilterChip href={filterHref({ type: "out" })} active={type === "out"}>Money out</FilterChip>
                <span className="w-px h-4 bg-slate-300 mx-1" />
                <FilterChip href={filterHref({ review: reviewOnly ? "0" : "1" })} active={reviewOnly}>
                    Needs review only
                </FilterChip>
            </div>

            {/* Register table */}
            <div className="hui-card overflow-hidden">
                {filteredRows.length === 0 ? (
                    <p className="text-sm text-hui-textMuted py-8 text-center">Nothing here for this range.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-hui-border bg-slate-50">
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Date</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Type</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Doc/Check #</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Payee</th>
                                    <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Amount</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Documentation</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Links</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {filteredRows.map((row) => {
                                    const summary = (
                                        <>
                                            <td className="px-4 py-3 text-hui-textMain whitespace-nowrap">
                                                {row.drilldown && (
                                                    <span className="inline-block w-3 text-hui-textMuted select-none" aria-hidden="true">
                                                        ▸
                                                    </span>
                                                )}
                                                {row.date}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMain">
                                                <span title={row.qbType}>{friendlyType(row.qbType, row.docNum)}</span>
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted">{row.docNum ?? "—"}</td>
                                            <td className="px-4 py-3 text-hui-textMain">
                                                {row.name ?? "—"}
                                                {row.projectName && (
                                                    <p className="text-xs text-hui-textMuted">{row.projectName}</p>
                                                )}
                                            </td>
                                            <td
                                                className={`px-4 py-3 text-right font-medium tabular-nums ${
                                                    row.amountCents > 0 ? "text-teal-700" : "text-hui-textMain"
                                                }`}
                                            >
                                                {row.amountCents > 0 ? "+" : "-"}
                                                {formatCurrency(Math.abs(row.amountCents) / 100)}
                                            </td>
                                            <td className="px-4 py-3">{row.documentation}</td>
                                            <LinksCell>
                                                <div className="flex gap-2 items-center flex-wrap text-xs">
                                                    {row.isPurchase && row.qbTxnId && (
                                                        <a
                                                            href={`https://qbo.intuit.com/app/expense?txnId=${encodeURIComponent(row.qbTxnId)}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            title="Best-effort link — if it doesn't open the purchase, use the copied ID to search in QuickBooks"
                                                            className="font-medium text-hui-primary hover:underline"
                                                        >
                                                            QuickBooks ↗
                                                        </a>
                                                    )}
                                                    {row.qbTxnId && <CopyIdButton value={row.qbTxnId} label="QuickBooks ID" />}
                                                    {row.receiptUrl && (
                                                        <a
                                                            href={row.receiptUrl}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="font-medium text-hui-primary hover:underline"
                                                        >
                                                            Receipt ↗
                                                        </a>
                                                    )}
                                                    {row.projectId && (
                                                        <a href={`/projects/${row.projectId}`} className="font-medium text-hui-primary hover:underline">
                                                            Project ↗
                                                        </a>
                                                    )}
                                                </div>
                                            </LinksCell>
                                        </>
                                    );

                                    if (!row.drilldown) {
                                        return (
                                            <tr key={row.key} className="hover:bg-slate-50 transition">
                                                {summary}
                                            </tr>
                                        );
                                    }

                                    return (
                                        <ExpandableRow
                                            key={row.key}
                                            qbTxnId={row.qbTxnId}
                                            focusTxnId={focus}
                                            columnCount={7}
                                            summary={summary}
                                        >
                                            <RowDrilldown
                                                row={row.drilldown.row}
                                                expense={row.drilldown.expense}
                                                journeyMatch={row.drilldown.journeyMatch}
                                            />
                                        </ExpandableRow>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
            <p className="text-xs text-hui-textMuted -mt-3">
                {filteredRows.length} entries · {startDate} to {endDate}
            </p>

            {/* Orphan receipts */}
            {orphanSection}

            {/* Receipt pipeline — journey list, Verify in QuickBooks + AI review (plan §3) */}
            {journeySection}

            {/* Pipeline health — collapsible, plan §5 step 7 */}
            <PipelineHealth
                pushedThisMonth={summary.pushedThisMonth}
                handsFreeRate30d={summary.handsFreeRate30d}
                amountCentsThisMonth={summary.amountCentsThisMonth}
                taxCentsThisMonth={summary.taxCentsThisMonth}
                lastSync={summary.lastSync}
                buckets={buckets}
                hoursSavedLabel={hoursSavedLabel}
                onARoll={onARoll}
                pushEnabled={pushEnabled}
                syncCronEnabled={syncCronEnabled}
                receiptPushPaused={pauses.receiptPushPaused}
                qboSyncPaused={pauses.qboSyncPaused}
                isAdmin={isAdmin}
                syncRuns={syncRuns}
            />
        </div>
    );
}
