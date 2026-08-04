import { prisma } from "@/lib/prisma";
import { isPurchaseType } from "@/lib/register-types";
import type { BankRegisterRow } from "@/lib/qbo-bank-register";
import type {
    RegisterMergeExpense,
    RegisterMergeReceiptEvent,
    RegisterMergeClassification,
    PurchaseClassification,
} from "@/lib/register-merge";

/**
 * Prisma-fetching glue for the merged register page (Unified Money Register
 * plan §5 step 6). `register-merge.ts` stays pure (no I/O) so it can be
 * unit-tested and Codex-reviewed as isolated money math — this module is the
 * caller-owned fetch layer the plan says callers must provide (see that
 * file's header comment).
 *
 * KNOWN ISSUE (2026-08-03, not this module's bug): the dev database is
 * missing `AutomationEvent.qbPurchaseId` / `driveFileId` — the migration
 * hasn't run yet. The `automationEvent.findMany` select below will 500 with
 * a Prisma P2022 until it does. That's expected in dev right now.
 */

const RECEIPT_EVENT_SELECT = {
    kind: true,
    status: true,
    qbPurchaseId: true,
    driveFileId: true,
    docNumber: true,
    fileName: true,
    vendor: true,
    amountCents: true,
    reason: true,
    createdAt: true,
    projectName: true,
} as const;

export type RawReceiptEvent = Awaited<ReturnType<typeof fetchRawReceiptEvents>>[number];

/** Narrow an unconstrained DB string to the typed union, failing closed to
 * "unknown" rather than trusting the CHECK constraint at the TS layer — an
 * "unknown" classification is exactly the safe default the matrix wants
 * (plan §2: never documented, never hidden). */
function asClassification(value: string): PurchaseClassification {
    return value === "job-cost" || value === "overhead" || value === "owner-draw" ? value : "unknown";
}

function fetchRawReceiptEvents(sinceMs: number) {
    return prisma.automationEvent.findMany({
        where: {
            kind: { in: ["receipt-push", "receipt-stage"] },
            createdAt: { gte: new Date(sinceMs) },
        },
        select: RECEIPT_EVENT_SELECT,
        // DESC + cap keeps the newest events when over the cap, same
        // convention as automation-events.ts's receiptJourneys() (display
        // cap, not a table-size bound — plan §1).
        orderBy: { createdAt: "desc" },
        take: 5000,
    });
}

/** Extra Expense projection fields the drill-down (plan §3/§5 step 9) wants
 * beyond what `RegisterMergeExpense` exposes — that type is deliberately
 * minimal (only what the pure edge/status math needs), so the richer
 * display-only fields (vendor, date, estimate identity) are selected here
 * instead of widening register-merge.ts's contract. Same "select more,
 * expose separately" convention as `RawReceiptEvent`/`rawReceiptEvents`
 * above. */
const DRILLDOWN_EXPENSE_SELECT = {
    qbPurchaseId: true,
    amount: true,
    vendor: true,
    date: true,
    receiptUrl: true,
    estimate: {
        select: {
            id: true,
            code: true,
            title: true,
            project: { select: { id: true, name: true } },
        },
    },
} as const;

export type RawExpense = Awaited<ReturnType<typeof fetchRawExpenses>>[number];

function fetchRawExpenses(purchaseIds: string[]) {
    return purchaseIds.length
        ? prisma.expense.findMany({
            where: { qbPurchaseId: { in: purchaseIds } },
            select: DRILLDOWN_EXPENSE_SELECT,
        })
        : Promise.resolve([]);
}

export interface RegisterMergeInputs {
    expenses: RegisterMergeExpense[];
    receiptEvents: RegisterMergeReceiptEvent[];
    classifications: RegisterMergeClassification[];
    /** Same rows as `receiptEvents`, carrying `projectName` too — register-merge.ts's
     * types deliberately omit it (out of scope for pure edge/status math). Kept
     * separately for `orphanProjectNames` below, display-only. */
    rawReceiptEvents: RawReceiptEvent[];
    /** Same rows as `expenses`, carrying vendor/date/estimate identity too —
     * kept separately for the row drill-down's ProBuild job cost block
     * (`drilldownExpenseByPurchaseId` below), display-only. */
    rawExpenses: RawExpense[];
}

/**
 * Fetch everything `mergeRegister()` needs beyond the already-fetched bank
 * register rows: job-cost expenses and purchase classifications keyed by the
 * register's own purchase ids, plus receipt-push/receipt-stage audit events
 * over a trailing window anchored to `sinceMs` (the selected range, in
 * calendar days from now — event `createdAt` is a UTC timestamp so this is a
 * reasonable, not exact, alignment with the GL report's Pacific-time date
 * window).
 */
export async function fetchRegisterMergeInputs(
    rows: BankRegisterRow[],
    sinceMs: number,
): Promise<RegisterMergeInputs> {
    const purchaseIds = rows
        .filter(r => isPurchaseType(r.qbType) && r.qbTxnId)
        .map(r => r.qbTxnId as string);

    const [rawExpenses, rawReceiptEvents, classificationRows] = await Promise.all([
        // Widened select (vendor/date/estimate identity) reused as-is for
        // `mergeRegister()`'s narrower `RegisterMergeExpense` shape — extra
        // fields on the object are harmless to a caller that only reads the
        // subset it declares, so one query serves both the pure merge and
        // the drill-down's richer display needs (see `RawExpense` above).
        fetchRawExpenses(purchaseIds),
        fetchRawReceiptEvents(sinceMs),
        purchaseIds.length
            ? prisma.qboPurchaseClassification.findMany({
                where: { qbPurchaseId: { in: purchaseIds } },
                select: { qbPurchaseId: true, classification: true, reason: true },
            })
            : Promise.resolve([]),
    ]);

    return {
        expenses: rawExpenses,
        receiptEvents: rawReceiptEvents,
        classifications: classificationRows.map(c => ({
            qbPurchaseId: c.qbPurchaseId,
            classification: asClassification(c.classification),
            reason: c.reason,
        })),
        rawReceiptEvents,
        rawExpenses,
    };
}

/**
 * Display-only Expense lookup for the row drill-down's ProBuild job cost
 * block (plan §3/§5 step 9), keyed by `qbPurchaseId` — the same key
 * `mergeRegister()` joins on. Carries the fields that module's
 * `RegisterMergeExpense` deliberately omits (vendor, date, estimate
 * code/title/id) so the drill-down can show "which estimate" and link to it
 * without widening the pure module's contract.
 */
export function drilldownExpenseByPurchaseId(rawExpenses: RawExpense[]): Map<string, RawExpense> {
    const map = new Map<string, RawExpense>();
    for (const e of rawExpenses) {
        if (e.qbPurchaseId) map.set(e.qbPurchaseId, e);
    }
    return map;
}

/**
 * Display-only project-name lookup for orphan receipts, keyed by the exact
 * same grouping key `classifyOrphanReceipts` uses (`id:${driveFileId}` or
 * `prefix:${docNumber}` — register-merge.ts:539-545). `OrphanReceipt` itself
 * carries no `projectName` (register-merge.ts is pure edge/status math and
 * doesn't fetch or expose it), but the orphan list UI wants to show which
 * job a quarantined/parked receipt was headed for, so this re-derives it
 * from the same raw events already fetched above rather than modifying that
 * module. "Latest non-null wins" mirrors classifyOrphanReceipts' own
 * per-field merge convention (register-merge.ts:570-575).
 */
export function orphanProjectNames(rawEvents: RawReceiptEvent[]): Map<string, string> {
    const sorted = [...rawEvents].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const map = new Map<string, string>();
    for (const e of sorted) {
        const key = e.driveFileId ? `id:${e.driveFileId}` : e.docNumber ? `prefix:${e.docNumber}` : null;
        if (key && e.projectName) map.set(key, e.projectName);
    }
    return map;
}
