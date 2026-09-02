import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { formatCurrency } from "@/lib/utils";
import { prisma } from "@/lib/prisma";
import { getCurrentUserWithPermissions, hasPermission, isAdminOrManager } from "@/lib/permissions";
import { toDepositReviewItem, type DepositReviewItem } from "@/lib/deposit-review";
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
    receiptJourneysForKeys,
    journeyKey,
    type ReceiptJourney,
    type AutomationSummary,
    type AutomationDayBucket,
} from "@/lib/automation-events";
import { suggestFix, type FixSuggestion } from "@/lib/automation-suggestions";
import { pauseStates } from "@/lib/automation-settings";
import {
    fetchRegisterMergeInputs,
    orphanProjectNames,
    drilldownExpenseByPurchaseId,
    reviewIssueByPurchaseId,
    type RawExpense,
    type OpenReviewIssue,
} from "./register-data";
import { applyRegisterFilters } from "./register-filters";
import { amountSign, formatRelativeTime, friendlyType } from "./components/format";
import { StatCard } from "./components/shared/stat-card";
import SyncNowButton from "./components/sync-now-button";
import CopyIdButton from "./components/copy-id-button";
import { DocumentationPips, DocumentationLegend } from "./components/register/documentation-pips";
import { OrphanReceipts } from "./components/register/orphan-receipts";
import { JourneySection } from "./components/register/journey-section";
import type { SerializedJourney } from "./components/journey-list";
import { PipelineHealth } from "./components/pipeline-health";
import { DepositReviewPanel } from "./components/deposit-review";
import { ExpandableRow } from "./components/register/expandable-row";
import { LinksCell } from "./components/register/links-cell";
import { RowDrilldown } from "./components/register/row-drilldown";
import { matchReceiptJourney, type ReceiptJourneyMatch, type ReceiptJourneyIndex } from "./components/register/match-receipt-journey";
import { toSerializedJourney } from "./components/register/serialize-journey";
import { fetchCheckImagePanelData, type CheckImagePanelRow } from "./check-images-data";
import { CheckImagesPanel } from "./components/check-images-panel";
import { fetchReceiptQueue, fetchJobOptions } from "./receipts-data";
import { parseReceiptFilters } from "./receipts-filters";
import { ReceiptsTab } from "./components/receipts/receipts-tab";

export const dynamic = "force-dynamic";

// ── Filters (plan §3 — "shared across the whole page") ─────────────────────

type RangeKey = "30" | "60" | "90";
type TypeFilter = "all" | "in" | "out";
type TabKey = "register" | "receipts";

function parseFilters(sp: Record<string, string | string[] | undefined>) {
    const range: RangeKey = sp.range === "60" || sp.range === "90" ? sp.range : "30";
    const type: TypeFilter = sp.type === "in" || sp.type === "out" ? sp.type : "all";
    const reviewOnly = sp.review === "1";
    // Deep link for the future Chat card's link button (plan §3/§5 step 9):
    // ?focus=<qbTxnId> expands that row and scrolls it into view on load.
    const focus = typeof sp.focus === "string" && sp.focus ? sp.focus : null;
    // ?tab=receipts swaps the register for the receipt queue (Phase 2 §2).
    // Anything unrecognized falls back to the register.
    const tab: TabKey = sp.tab === "receipts" ? "receipts" : "register";
    return { range, type, reviewOnly, focus, tab };
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
    return (
        <a
            href={href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center px-4 py-1.5 text-sm font-semibold rounded-lg transition ${
                active ? "bg-hui-primary text-white" : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
            }`}
        >
            {children}
        </a>
    );
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
    drilldown: {
        row: MergedRegisterRow;
        expense: RawExpense | null;
        journeyMatch: ReceiptJourneyMatch | null;
        reviewIssue: OpenReviewIssue | null;
    } | null;
}

function sinceMsForRangeDays(days: number): number {
    return Date.now() - days * 86_400_000;
}

/** B3: a promise that never settles (a hung query) is not a rejection — an
 * ordinary try/catch around it blocks the whole page forever waiting. Races
 * it against a timeout so a stuck pipeline-health fetch degrades the same
 * way an outright failure does, instead of holding the register (the data
 * the user actually came for) hostage. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        }),
    ]);
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
    const { range, type, reviewOnly, focus, tab } = parseFilters(sp);

    // Receipts tab (Phase 2 §2). Rendered as its own branch so none of the
    // register's QBO/merge/journey fetches run for it — and so the register's
    // JSX below is untouched when tab=register.
    if (tab === "receipts") {
        return <ReceiptsTabBranch sp={sp} />;
    }
    // Captured ONCE, server-side, and threaded through every component that
    // needs "now" (stale-receipt detection) — calling Date.now() again
    // inside a client component would read a different clock value on
    // hydration than SSR did, risking a hydration mismatch right at a
    // threshold boundary. This IS the fix for that: an async Server
    // Component runs once per request (no client re-render to be impure
    // against), so capturing a single stable timestamp here is exactly what
    // prevents descendant client components from each calling Date.now()
    // independently during SSR vs. hydration.
    const nowMs = Date.now();

    // Incoming-check exceptions must remain visible when QBO is down. This
    // is a deliberately read-only panel; it exposes no retry or payment-write
    // control, and a failed panel query degrades honestly instead of blocking
    // the rest of Automation.
    let depositReviews: DepositReviewItem[] = [];
    let depositReviewUnavailable = false;
    if (isAdmin) {
        try {
            const deposits = await prisma.depositIngest.findMany({
                where: { status: { not: "applied" } },
                orderBy: { updatedAt: "desc" },
                take: 25,
                select: {
                    id: true, status: true, extracted: true, paymentScheduleId: true,
                    qbPaymentId: true, officeTaskId: true, attempts: true, lastError: true,
                    createdAt: true, updatedAt: true,
                },
            });
            depositReviews = deposits.map(toDepositReviewItem);
        } catch (error) {
            depositReviewUnavailable = true;
            console.error("deposit review fetch failed", error instanceof Error ? error.name : "UnknownError");
        }
    }

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
                {isAdmin && <DepositReviewPanel items={depositReviews} unavailable={depositReviewUnavailable} />}
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
    let journeyIndex: ReceiptJourneyIndex = { byQbPurchaseId: new Map(), byDocNumber: new Map(), truncated: false };
    let expenseByPurchaseId = new Map<string, RawExpense>();
    let reviewIssueMap = new Map<string, OpenReviewIssue>();
    // Receipt journey PIPELINE LIST (plan §3) — a separate, display-capped
    // fetch from the row drill-down's targeted lookup above; this one is a
    // genuine "browse the most recent receipts" list, so a display cap is
    // the right shape for it (see `receiptJourneys` in automation-events.ts).
    let pipelineJourneyList: ReceiptJourney[] = [];
    // Findings 6/7: true when either journey fetch above had to cap its
    // underlying event query — drill-downs/the pipeline list may be built
    // from partial history. Surfaced as the page's existing degraded-data
    // warning style, and threaded to JourneySection to suppress
    // suggestion-cards/"stuck" conclusions that assume complete history.
    let journeyIndexTruncated = false;
    let pipelineJourneysTruncated = false;

    try {
        const mergeInputs = await fetchRegisterMergeInputs(registerRows, sinceMsForRangeDays(rangeDays));
        const merged = mergeRegister(registerRows, mergeInputs.expenses, mergeInputs.receiptEvents, mergeInputs.classifications);
        const orphans = classifyOrphanReceipts(mergeInputs.receiptEvents, registerRows);
        // Row drill-down journeys (plan §3/§5 step 9): N2 fix — instead of
        // matching every row against a bulk, count-capped journey list (an
        // R × J scan on the page that carries the money register, and one
        // whose cap could silently drop a genuinely-matching older journey),
        // fetch ONLY the journeys for the identifiers THIS register's rows
        // actually carry, pre-indexed for an O(1) lookup per row below.
        expenseByPurchaseId = drilldownExpenseByPurchaseId(mergeInputs.rawExpenses);
        reviewIssueMap = reviewIssueByPurchaseId(mergeInputs.openReviewIssues);

        // Commit the merge results BEFORE the journey fetches below: journeys
        // are ancillary drill-down/pipeline display data, and their failure
        // must not throw away a register merge that already succeeded (it
        // previously flipped the page-wide `mergeUnavailable` degrade AND
        // made this page disagree with the CSV export's filter semantics).
        mergedRows = merged.rows;
        documented = merged.counts.documented;
        receiptProvenanceUnverified = merged.counts.receiptProvenanceUnverified;
        needsReview = merged.counts.needsReview;
        expectedNonJobSpend = merged.counts.expectedNonJobSpend;
        unknownClassification = merged.counts.unknownClassification;
        denominator = merged.counts.denominator;
        actionableOrphans = actionableOrphanReceipts(orphans);
        orphanProjectNameMap = orphanProjectNames(mergeInputs.rawReceiptEvents);

        try {
            const [journeyIndexResult, pipelineResult] = await Promise.all([
                receiptJourneysForKeys(
                    merged.rows.filter((r) => r.edges).map((r) => ({ qbPurchaseId: r.qbTxnId, docNumber: r.docNum })),
                    rangeDays,
                ),
                receiptJourneys(rangeDays, 200),
            ]);
            journeyIndex = journeyIndexResult;
            journeyIndexTruncated = journeyIndexResult.truncated;
            pipelineJourneyList = pipelineResult.journeys;
            pipelineJourneysTruncated = pipelineResult.truncated;
        } catch (journeyError) {
            // Drill-downs/pipeline list degrade to empty; the register itself
            // (rows, counts, filters) stays fully live.
            console.error("journey fetch failed", journeyError instanceof Error ? journeyError.message : "UnknownError");
        }
    } catch (error) {
        console.error("register merge inputs failed", error instanceof Error ? error.message : "UnknownError");
        mergeUnavailable = true;
    }

    const orphanCount = actionableOrphans.length;
    // True when essentially every job-costable row hasn't been sorted into a
    // job cost or overhead yet (e.g. classification data hasn't been
    // populated at all). Repeating "Not categorized yet" on every one of
    // ~141 rows is noise once it's page-wide — say it once in a banner above
    // the table instead (DocumentationPips.suppressUnclassifiedNote hides
    // the per-row repeat when this is true), same status, no logic change.
    const mostRowsUncategorized = !mergeUnavailable && denominator > 0 && unknownClassification / denominator >= 0.9;
    const orphanSection: ReactNode = mergeUnavailable ? (
        <div className="hui-card p-5 text-sm text-hui-textMuted">
            Can&apos;t show receipts that never reached the bank right now — that data couldn&apos;t be loaded.
        </div>
    ) : (
        <OrphanReceipts orphans={actionableOrphans} projectNames={orphanProjectNameMap} />
    );

    // Reuses the same toSerializedJourney used by row-drilldown.tsx, so
    // driveFileId/qbPurchaseId/keyConfirmed carry through identically in
    // both places.
    const pipelineJourneys = pipelineJourneyList;
    const serializedJourneys: SerializedJourney[] = pipelineJourneys.map(toSerializedJourney);
    // Keyed by the full driveFileId (falling back to a docNumber+firstSeen
    // composite) — NEVER the bare docNumber alone, which is a 21-char Drive
    // fileId prefix two different receipts can share; keying by it would let
    // one journey's suggestion silently overwrite another's.
    const journeySuggestions: Record<string, FixSuggestion | null> = {};
    for (const j of pipelineJourneys) {
        const suggestion = suggestFix(j);
        if (suggestion) journeySuggestions[journeyKey(j)] = suggestion;
    }
    const journeySection: ReactNode = mergeUnavailable ? (
        <div className="hui-card p-5 text-sm text-hui-textMuted">
            Receipt pipeline view unavailable right now — documentation data couldn&apos;t be loaded.
        </div>
    ) : (
        <JourneySection
            journeys={serializedJourneys}
            suggestions={journeySuggestions}
            now={nowMs}
            truncated={pipelineJourneysTruncated}
        />
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
            documentation: <DocumentationPips row={r} suppressUnclassifiedNote={mostRowsUncategorized} />,
            needsReview: r.status === "needs-review",
            drilldown: {
                row: r,
                expense: r.qbTxnId ? expenseByPurchaseId.get(r.qbTxnId) ?? null : null,
                journeyMatch: r.edges ? matchReceiptJourney(r, journeyIndex) : null,
                reviewIssue: r.qbTxnId ? reviewIssueMap.get(r.qbTxnId) ?? null : null,
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

    const filteredRows = applyRegisterFilters(displayRows, { type, reviewOnly, mergeUnavailable });

    // ?focus=<qbTxnId> (plan §3/§5 step 9 deep link) named a row that exists
    // on this page but the current type/review filters hid it — say so
    // rather than silently rendering as if that row never existed.
    const focusHiddenByFilters =
        focus !== null && displayRows.some((r) => r.qbTxnId === focus) && !filteredRows.some((r) => r.qbTxnId === focus);

    // Pipeline health inputs — independent of the register/merge above, so a
    // register or merge failure doesn't need to take this section down too.
    // Isolated behind its own try/catch (mirrors `mergeUnavailable` above):
    // these ran inside the SAME Promise.all as the register/merge fetch
    // before, so one ancillary failure here (e.g. `recentAutomationEvents`)
    // rejected the whole page and hid the register the user actually came
    // for.
    let pipelineHealthUnavailable = false;
    let summary: AutomationSummary = {
        pushedThisMonth: 0,
        fallbackThisMonth: 0,
        amountCentsThisMonth: 0,
        taxCentsThisMonth: 0,
        lastSync: null,
        handsFreeRate30d: null,
    };
    let buckets: AutomationDayBucket[] = [];
    let events: Awaited<ReturnType<typeof recentAutomationEvents>> = [];
    // Fail closed: an unknown pause state disables the manual sync button
    // rather than presenting it as available.
    let pauses = { receiptPushPaused: true, qboSyncPaused: true };
    try {
        // B3: 15s timeout so a hung query can't hold the register hostage
        // (a promise that never settles isn't a rejection an ordinary catch
        // would see), and the resolved shape is validated HERE, inside the
        // protected block — consuming it unguarded outside the try (as
        // before) meant a malformed result would throw past the catch and
        // crash the render instead of degrading gracefully.
        const [summaryResult, bucketsResult, eventsResult, pausesResult] = await withTimeout(
            Promise.all([
                automationSummary(),
                receiptDailyBuckets(30),
                recentAutomationEvents(50),
                pauseStates(),
            ]),
            15_000,
        );
        const shapeOk =
            summaryResult && typeof summaryResult === "object" &&
            Array.isArray(bucketsResult) &&
            Array.isArray(eventsResult) &&
            pausesResult && typeof pausesResult.receiptPushPaused === "boolean" && typeof pausesResult.qboSyncPaused === "boolean";
        if (!shapeOk) {
            throw new Error("pipeline health inputs malformed");
        }
        summary = summaryResult;
        buckets = bucketsResult;
        events = eventsResult;
        pauses = pausesResult;
    } catch (error) {
        console.error("pipeline health inputs failed", error instanceof Error ? error.message : "UnknownError");
        pipelineHealthUnavailable = true;
    }

    // Check images panel (check-payer pipeline worklist) — independent of the
    // register/merge/pipeline-health fetches above, so it fails alone: an
    // error here degrades to an honest "unavailable" card, never the page.
    let checkImagesUnavailable = false;
    let checkImageRows: CheckImagePanelRow[] = [];
    let checkImageTotal = 0;
    try {
        const checkImages = await withTimeout(fetchCheckImagePanelData(), 15_000);
        checkImageRows = checkImages.rows;
        checkImageTotal = checkImages.totalImages;
    } catch (error) {
        console.error("check image panel fetch failed", error instanceof Error ? error.message : "UnknownError");
        checkImagesUnavailable = true;
    }
    const checkImagesSection: ReactNode = checkImagesUnavailable ? (
        <div className="hui-card p-5 text-sm text-hui-textMuted">
            Check images unavailable right now — the register above is still current.
        </div>
    ) : (
        <CheckImagesPanel rows={checkImageRows} totalImages={checkImageTotal} />
    );
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
                    <div className="flex gap-2 mt-3 mb-2">
                        <TabLink href="/automation" active>Register</TabLink>
                        <TabLink href="/automation?tab=receipts" active={false}>Receipts</TabLink>
                    </div>
                    <p className="text-sm text-hui-textMuted mt-1 max-w-3xl">
                        QuickBooks WTB account register — posted QuickBooks entries affecting account 154, fetched at{" "}
                        <span title={new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}>
                            {formatRelativeTime(new Date(fetchedAt), nowMs)}
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
                    {journeyIndexTruncated && (
                        <div className="mt-2 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            Receipt journey history is incomplete for this range — some row drill-downs below may show
                            partial results.
                        </div>
                    )}
                    <div className="flex gap-3 mt-2">
                        <a href="/automation/guide" target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-hui-primary hover:underline">
                            How this pipeline works ↗
                        </a>
                        <a href="/automation/guide#running-it" target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-hui-primary hover:underline">
                            How to run this ↗
                        </a>
                        <a href={filterHref({})} className="text-xs font-medium text-hui-primary hover:underline">
                            Refresh ↻
                        </a>
                        <a
                            href={`/api/automation/export?range=${range}&type=${type}${reviewOnly ? "&review=1" : ""}`}
                            className="text-xs font-medium text-hui-primary hover:underline"
                        >
                            Download CSV ⤓
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
                    value={mergeUnavailable ? "—" : `${documented} of ${denominator} job purchases fully documented`}
                />
                <StatCard label="Needs review" value={mergeUnavailable ? "—" : String(needsReview)} />
                <StatCard label="Receipts stuck outside the bank" value={mergeUnavailable ? "—" : String(orphanCount)} />
            </div>

            {isAdmin && <DepositReviewPanel items={depositReviews} unavailable={depositReviewUnavailable} />}

            {/* Secondary counts — nothing hides, plan §2 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard
                    label="Overhead and owner draws"
                    value={mergeUnavailable ? "—" : String(expectedNonJobSpend)}
                    sub="No job cost expected here on purpose"
                />
                <StatCard
                    label="Receipt not traced"
                    value={mergeUnavailable ? "—" : String(receiptProvenanceUnverified)}
                    sub="Job cost and amount match, but we can't find the receipt in the automation records"
                />
                <StatCard
                    label="Not categorized yet"
                    value={mergeUnavailable ? "—" : String(unknownClassification)}
                    sub="We don't know if these are job costs or overhead"
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
            {reviewOnly && mergeUnavailable && (
                <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 -mt-2">
                    Review status is unavailable right now, so &quot;Needs review only&quot; isn&apos;t applied — showing every
                    row instead of hiding all of them.
                </p>
            )}
            {focusHiddenByFilters && (
                <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 -mt-2">
                    The row you followed a link to is hidden by the current filters —{" "}
                    <a href={filterHref({ type: "all", review: "0" })} className="underline">
                        clear filters
                    </a>{" "}
                    to see it.
                </p>
            )}

            {mostRowsUncategorized && (
                <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    Most of these purchases haven&apos;t been sorted into a job cost or overhead yet, so most rows below
                    will say &quot;Not categorized yet.&quot; That&apos;s expected until that gets set up — it doesn&apos;t
                    mean anything is wrong with these entries.
                </p>
            )}

            <DocumentationLegend />

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
                                                {amountSign(row.amountCents)}
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
                                                reviewIssue={row.drilldown.reviewIssue}
                                                now={nowMs}
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

            {/* Check images — check-payer pipeline worklist (human confirm) */}
            {checkImagesSection}

            {/* Receipt pipeline — journey list, Verify in QuickBooks + AI review (plan §3) */}
            {journeySection}

            {/* Pipeline health — collapsible, plan §5 step 7 */}
            {pipelineHealthUnavailable ? (
                <div className="hui-card p-5 text-sm text-hui-textMuted">
                    Pipeline health unavailable right now — the register above is still current.
                </div>
            ) : (
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
                    now={nowMs}
                />
            )}
        </div>
    );
}

/**
 * The Receipts queue branch of /automation.
 *
 * Auth is already enforced by the caller (the same `financialReports` gate the
 * register runs behind) — this is a private helper of that component, never a
 * route of its own.
 *
 * Degrades honestly, exactly like the register's own sections: a failed load
 * renders an "unavailable" card instead of hitting the route error boundary.
 */
async function ReceiptsTabBranch({ sp }: { sp: Record<string, string | string[] | undefined> }) {
    const filters = parseReceiptFilters(sp);

    function receiptFilterHref(overrides: { group?: string; owner?: string }) {
        const params = new URLSearchParams();
        params.set("tab", "receipts");
        const nextGroup = overrides.group ?? filters.group ?? "";
        const nextOwner = overrides.owner ?? filters.owner ?? "";
        if (nextGroup) params.set("group", nextGroup);
        if (nextOwner) params.set("owner", nextOwner);
        if (filters.projectId) params.set("projectId", filters.projectId);
        return `/automation?${params.toString()}`;
    }

    // Only DATA is computed inside the try — JSX construction is lazy, so
    // building elements in here couldn't catch their render errors anyway
    // (the same convention the register half of this file follows).
    let queue: Awaited<ReturnType<typeof fetchReceiptQueue>> | null = null;
    let jobs: Awaited<ReturnType<typeof fetchJobOptions>> = [];
    try {
        [queue, jobs] = await Promise.all([fetchReceiptQueue(filters), fetchJobOptions()]);
    } catch (error) {
        console.error("receipt queue fetch failed", error instanceof Error ? error.message : "UnknownError");
    }

    const body: ReactNode = queue
        ? <ReceiptsTab queue={queue} filters={filters} jobs={jobs} filterHref={receiptFilterHref} />
        : (
            <div className="hui-card p-5 text-sm text-hui-textMuted">
                The receipt queue couldn&apos;t be loaded right now — the register is still available.
            </div>
        );

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-xl font-bold text-hui-textMain">Automation</h1>
                <p className="text-sm text-hui-textMuted mt-1 max-w-3xl">
                    Every receipt in flight, and every bank charge still missing one. Setting a job here hands the receipt
                    back to the pipeline — nothing on this page writes to QuickBooks directly.
                </p>
                <div className="flex gap-2 mt-3">
                    <TabLink href="/automation" active={false}>Register</TabLink>
                    <TabLink href="/automation?tab=receipts" active>Receipts</TabLink>
                </div>
            </div>
            {body}
        </div>
    );
}
