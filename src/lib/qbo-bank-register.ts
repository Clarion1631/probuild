import { qbFetch, type QBTokens } from "@/lib/quickbooks";
import { prisma } from "@/lib/prisma";
import { isPurchaseType, isMoneyInType, type ClearedStatus } from "@/lib/register-types";

/**
 * QuickBooks bank-account REGISTER for the Command Center's Bank page.
 *
 * Source: the QBO GeneralLedger REPORT filtered to the WTB checking account —
 * NOT per-entity queries. QBO's query language cannot filter Purchase/Deposit/
 * Transfer by account (and has no OR), while the GL report returns every
 * posted line touching the account regardless of entity type: spiking July
 * 2026 produced Expense/Journal Entry/Deposit/Payment/Sales Tax Payment rows,
 * several of which an entity allowlist would have missed.
 *
 * HONESTY CONTRACT (from Codex plan review): this is a register of what
 * QuickBooks has POSTED to the account. It cannot see WTB transactions that
 * are pending, excluded, unmatched, or absent from QuickBooks. The UI must say
 * so — no "true north" claims.
 *
 * BANK CLEARANCE, AND HOW IT IS ACTUALLY OBTAINED (Codex PR #443, raised three
 * rounds running). The GL report does not prove clearance, and QuickBooks will
 * not put clearance on it: `cleared` is a FILTER, never a returnable column,
 * and only the TransactionList report accepts it. So it is asked for the only
 * way it can be — three filtered TransactionList calls over the same account
 * and window, whose transaction ids are joined back onto the GL rows.
 * Verified against the live realm on 2026-09-02:
 *
 *   window 2026-07-01..2026-07-10, account 154
 *     GL rows 78 (76 distinct txn ids)
 *     cleared=Reconciled 85 rows, cleared=Cleared 0, cleared=Uncleared 5
 *     GL rows in NEITHER bucket: 1 — id 6557, a Journal Entry
 *   window 2026-08-20..2026-09-02 (not yet reconciled)
 *     cleared=Reconciled 0, cleared=Uncleared 55
 *
 * Two things that matters for. The id spaces MATCH — TransactionList carries
 * the transaction id on the same `txn_type` cell the GL does — so the join is
 * an identity join, not a heuristic. And a manually entered Journal Entry is
 * classified by NEITHER filter, so it comes back "Unknown": the honest answer,
 * and the one that keeps exactly the reviewer's fake-bank-truth case out of the
 * canonical ledger.
 *
 * A failed clearance probe is NOT a failed fetch: the rows still render, every
 * one of them reads "Unknown", and `clearedProbeOk` says why. Minting is
 * positive-evidence-only (`isClearedForMint`), so an outage stops new canonical
 * lines instead of inventing them.
 */

export interface BankRegisterRow {
    /** YYYY-MM-DD transaction date as reported by the GL. */
    date: string;
    /** GL "Transaction Type" label, e.g. "Expense", "Deposit", "Payment". */
    qbType: string;
    /** QBO transaction id (null on rows the GL doesn't link, e.g. balances). */
    qbTxnId: string | null;
    docNum: string | null;
    name: string | null;
    /** GL memo/description — usually the original POS descriptor, card tail included. */
    memo: string | null;
    /** Signed integer cents: deposits +, money out −. */
    amountCents: number;
    /**
     * What QuickBooks says about this row's bank clearance. "Unknown" whenever
     * the row carries no txn id, QuickBooks classified it as neither, or the
     * clearance probe could not run — see `clearedProbeOk`.
     */
    clearedStatus: ClearedStatus;
}

export interface BankRegisterResult {
    rows: BankRegisterRow[];
    fetchedAt: string;
    /** True when QBO errored and this is the previous successful fetch. */
    stale: boolean;
    /**
     * False when the clearance probe failed, so every `clearedStatus` on these
     * rows is "Unknown" because we could not ask — never because QuickBooks
     * answered. Anything gating a write on clearance must read this: absence of
     * a cleared flag only means something when the question was actually put.
     */
    clearedProbeOk: boolean;
    accountId: string;
    startDate: string;
    endDate: string;
}

const CACHE_TTL_MS = 120_000;
const registerCache = new Map<string, { result: BankRegisterResult; at: number }>();

export function bankAccountId(): string {
    return process.env.QBO_RECEIPT_BANK_ACCOUNT_ID || "154";
}

interface GlColData { value?: unknown; id?: unknown }
interface GlRow { ColData?: GlColData[]; Rows?: { Row?: GlRow[] }; Header?: unknown; Summary?: unknown }
interface GlReport {
    Columns?: { Column?: Array<{ ColType?: string; MetaData?: Array<{ Name?: string; Value?: string }> }> };
    Rows?: { Row?: GlRow[] };
}

function str(v: unknown): string | null {
    if (typeof v !== "string" && typeof v !== "number") return null;
    const s = String(v).trim();
    return s || null;
}

/** Column order comes from the report's own Columns block, never assumed. */
function columnIndexMap(report: GlReport): Map<string, number> {
    const map = new Map<string, number>();
    const cols = report.Columns?.Column ?? [];
    cols.forEach((col, i) => {
        for (const meta of col.MetaData ?? []) {
            if (meta.Name === "ColKey" && meta.Value) map.set(meta.Value, i);
        }
    });
    return map;
}

function walkGlRows(rows: GlRow[], idx: Map<string, number>, out: BankRegisterRow[]): void {
    for (const row of rows) {
        if (row.ColData) {
            const at = (key: string) => row.ColData![idx.get(key) ?? -1] as GlColData | undefined;
            const dateCell = at("tx_date");
            const typeCell = at("txn_type");
            const amountCell = at("subt_nat_amount");
            const date = str(dateCell?.value);
            const qbType = str(typeCell?.value);
            // str() → null for blank cells; Number(null) would be 0, which
            // must not render as a fake $0.00 row (Codex r1).
            const amountStr = str(amountCell?.value);
            const amountRaw = amountStr === null ? Number.NaN : Number(amountStr);
            // Beginning-balance / summary lines carry no txn type — skip them.
            if (date && qbType && Number.isFinite(amountRaw)) {
                out.push({
                    date,
                    qbType,
                    qbTxnId: str(typeCell?.id),
                    docNum: str(at("doc_num")?.value),
                    name: str(at("name")?.value),
                    memo: str(at("memo")?.value),
                    amountCents: Math.round(amountRaw * 100),
                    // Filled in by the clearance join below; "Unknown" until
                    // QuickBooks positively says otherwise.
                    clearedStatus: "Unknown",
                });
            }
        }
        if (row.Rows?.Row) walkGlRows(row.Rows.Row, idx, out);
    }
}

/**
 * Collect the transaction ids QuickBooks puts in one `cleared` bucket.
 *
 * TransactionList, not GeneralLedger, because `cleared` is only accepted
 * there; and one call per bucket, because it is a filter and cannot be
 * projected as a column. The id sits on the `txn_type` cell exactly as it does
 * on the GL report, which is what lets the caller join the two by identity.
 */
async function fetchClearedBucket(
    tokens: QBTokens,
    accountId: string,
    startDate: string,
    endDate: string,
    bucket: Exclude<ClearedStatus, "Unknown">,
): Promise<Set<string>> {
    const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
        account: accountId,
        cleared: bucket,
    });
    const res = await qbFetch(`/reports/TransactionList?${params}`, tokens);
    if (!res.ok) throw new Error(`TransactionList(${bucket}) ${res.status}`);
    const report = (await res.json()) as GlReport;
    const idx = columnIndexMap(report);
    const typeCol = idx.get("txn_type");
    // Without that column there are no ids to read, and an empty set would read
    // as "nothing is cleared" — which silently stops every mint. That is a
    // probe FAILURE, not an answer.
    if (typeCol === undefined) throw new Error(`TransactionList(${bucket}) missing txn_type column`);
    const ids = new Set<string>();
    const walk = (rows: GlRow[]): void => {
        for (const row of rows) {
            const id = str((row.ColData?.[typeCol] as GlColData | undefined)?.id);
            if (id) ids.add(id);
            if (row.Rows?.Row) walk(row.Rows.Row);
        }
    };
    walk(report.Rows?.Row ?? []);
    return ids;
}

/**
 * The clearance answer for one window, as txn id -> status.
 *
 * ALL THREE buckets are asked for, not just the cleared ones, so a row
 * QuickBooks classifies as neither (a manually entered journal) stays
 * "Unknown" rather than being mislabelled "Uncleared". Applied in ascending
 * order of authority, so Reconciled outranks Cleared outranks Uncleared if a
 * row ever comes back in two.
 */
async function fetchClearedStatuses(
    tokens: QBTokens,
    accountId: string,
    startDate: string,
    endDate: string,
): Promise<Map<string, ClearedStatus>> {
    const order: Array<Exclude<ClearedStatus, "Unknown">> = ["Uncleared", "Cleared", "Reconciled"];
    const buckets = await Promise.all(order.map(bucket => fetchClearedBucket(tokens, accountId, startDate, endDate, bucket)));
    const map = new Map<string, ClearedStatus>();
    order.forEach((bucket, i) => { for (const id of buckets[i]) map.set(id, bucket); });
    return map;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;
const FAILURE_COOLDOWN_MS = 30_000;
const inFlight = new Map<string, Promise<BankRegisterResult>>();
let lastFailureAt = 0;

/**
 * Fetch the register for a date range (inclusive, YYYY-MM-DD). One report
 * call per fetch; results cached ~2 minutes per account+range so page renders
 * never fan out into QBO, and a QBO failure serves the last good fetch marked
 * stale instead of a blank page. Concurrent misses coalesce onto one request,
 * and a failure sets a 30s cooldown so an outage can't turn every render into
 * a retry. `getTokens` is only invoked on a cache MISS — the token helper
 * refreshes OAuth on every call, so cache hits must not touch Intuit at all
 * (single-realm app; the cache key doesn't need the realm).
 */
export async function fetchBankRegister(
    getTokens: () => Promise<QBTokens>,
    startDate: string,
    endDate: string,
): Promise<BankRegisterResult> {
    // Regex + calendar round-trip: "2026-02-30" normalizes under Date.parse
    // and must not slip through as a valid date (Codex r2).
    const validYmd = (s: string) => {
        if (!ISO_DATE.test(s)) return false;
        const t = Date.parse(`${s}T00:00:00Z`);
        return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
    };
    if (!validYmd(startDate) || !validYmd(endDate) || startDate > endDate) {
        throw new Error("invalid date range");
    }
    // Both endpoints inclusive: spanDays + 1 dates in the window.
    const spanDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000;
    if (spanDays + 1 > MAX_RANGE_DAYS) throw new Error("date range too large");

    const accountId = bankAccountId();
    const cacheKey = `${accountId}:${startDate}:${endDate}`;
    const cached = registerCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
    if (Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
        // Outage cooldown applies with OR without a cached copy — a cold
        // cache must not turn every render into a QBO retry (Codex r2).
        if (cached) return { ...cached.result, stale: true };
        throw new Error("QBO recently failed — cooling down");
    }

    const running = inFlight.get(cacheKey);
    if (running) return running;

    const request = (async (): Promise<BankRegisterResult> => {
        try {
            const tokens = await getTokens();
            const params = new URLSearchParams({
                start_date: startDate,
                end_date: endDate,
                account: accountId,
                columns: "tx_date,txn_type,doc_num,name,memo,subt_nat_amount",
            });
            const res = await qbFetch(`/reports/GeneralLedger?${params}`, tokens);
            if (!res.ok) throw new Error(`GL report ${res.status}`);
            const report = (await res.json()) as GlReport;
            const idx = columnIndexMap(report);
            // Without these three keys the walker can't identify rows at all —
            // treat as an error rather than rendering an empty "all clear" page.
            if (!idx.has("tx_date") || !idx.has("txn_type") || !idx.has("subt_nat_amount")) {
                throw new Error("GL report missing expected columns");
            }
            const rows: BankRegisterRow[] = [];
            walkGlRows(report.Rows?.Row ?? [], idx, rows);
            rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

            // THE CLEARANCE JOIN, allowed to fail on its own. The register is
            // still the register without it; what changes is that nothing may
            // be minted from these rows, which `clearedProbeOk: false` is what
            // says. Folding this into the outer catch would have thrown the
            // whole fetch away over a secondary question.
            let clearedProbeOk = true;
            try {
                const statuses = await fetchClearedStatuses(tokens, accountId, startDate, endDate);
                for (const row of rows) {
                    const status = row.qbTxnId ? statuses.get(row.qbTxnId) : undefined;
                    if (status) row.clearedStatus = status;
                }
            } catch (error) {
                clearedProbeOk = false;
                console.error("bank register clearance probe failed", error instanceof Error ? error.message : "UnknownError");
            }

            const result: BankRegisterResult = {
                rows,
                fetchedAt: new Date().toISOString(),
                stale: false,
                clearedProbeOk,
                accountId,
                startDate,
                endDate,
            };
            registerCache.set(cacheKey, { result, at: Date.now() });
            return result;
        } catch (error) {
            lastFailureAt = Date.now();
            console.error("bank register fetch failed", error instanceof Error ? error.message : "UnknownError");
            if (cached) return { ...cached.result, stale: true };
            throw error;
        } finally {
            inFlight.delete(cacheKey);
        }
    })();
    inFlight.set(cacheKey, request);
    return request;
}

// ── Verdicts ────────────────────────────────────────────────────────────────

export type BankRowVerdict =
    | { kind: "linked"; projectId: string | null; projectName: string | null; amountMatches: boolean; expenseAmountCents: number; receiptUrl: string | null }
    | { kind: "review"; note: string }
    | { kind: "money-in" }
    | { kind: "transfer" }
    | { kind: "journal" }
    | { kind: "tax-payment" }
    | { kind: "bill-payment" }
    | { kind: "other" };

export interface BankRegisterRowWithVerdict extends BankRegisterRow {
    isPurchase: boolean;
    verdict: BankRowVerdict;
}

/**
 * Cross-reference register rows against ProBuild job costing. Deliberately
 * conservative language: an unlinked purchase row is "review", never
 * "missing" — the email-booked path creates expenses without qbPurchaseId,
 * overhead/owner-draw spend is EXPECTED to stay out of job costs, and the
 * 4-hour sync may simply not have run yet.
 *
 * AUTH CONTRACT: reads expenses with no row-level scoping — the CALLER must
 * have already enforced the financialReports permission (the /automation/bank
 * page does). Do not reuse from client-reachable code without that gate.
 */
export async function attachVerdicts(rows: BankRegisterRow[]): Promise<BankRegisterRowWithVerdict[]> {
    const purchaseIds = rows
        .filter(r => isPurchaseType(r.qbType) && r.qbTxnId)
        .map(r => r.qbTxnId as string);

    const expenses = purchaseIds.length
        ? await prisma.expense.findMany({
            where: { qbPurchaseId: { in: purchaseIds } },
            select: {
                qbPurchaseId: true,
                amount: true,
                receiptUrl: true,
                estimate: { select: { project: { select: { id: true, name: true } } } },
            },
        })
        : [];
    const byPurchaseId = new Map(expenses.map(e => [e.qbPurchaseId, e]));

    return rows.map(row => {
        const isPurchase = isPurchaseType(row.qbType);
        let verdict: BankRowVerdict;
        if (isPurchase && row.amountCents > 0) {
            // A POSITIVE purchase-type posting is a reversal/credit, not
            // spend — it must never green-check against a positive ProBuild
            // expense amount (Codex r1 blocker: direction matters).
            verdict = {
                kind: "review",
                note: "Money came BACK on a purchase-type entry (refund or reversal) — check it in QuickBooks.",
            };
        } else if (isPurchase) {
            const expense = row.qbTxnId ? byPurchaseId.get(row.qbTxnId) : undefined;
            if (expense) {
                const expenseAmountCents = Math.round(Number(expense.amount) * 100);
                verdict = {
                    kind: "linked",
                    projectId: expense.estimate?.project?.id ?? null,
                    projectName: expense.estimate?.project?.name ?? null,
                    amountMatches: expenseAmountCents === -row.amountCents,
                    expenseAmountCents,
                    receiptUrl: expense.receiptUrl ?? null,
                };
            } else {
                // No per-row timestamps in the GL report, so no "awaiting
                // sync" guess (Codex r1: a global sync-recency heuristic
                // mislabels rows). One honest message covers every cause.
                verdict = {
                    kind: "review",
                    note: "No ProBuild link for this QuickBooks purchase — could be overhead, an owner draw, not job-coded, or simply not synced yet. Open it in QuickBooks to check.",
                };
            }
        } else if (isMoneyInType(row.qbType) && row.amountCents > 0) {
            verdict = { kind: "money-in" };
        } else if (row.qbType === "Transfer") {
            verdict = { kind: "transfer" };
        } else if (row.qbType === "Journal Entry") {
            verdict = { kind: "journal" };
        } else if (/tax payment/i.test(row.qbType)) {
            verdict = { kind: "tax-payment" };
        } else if (/bill payment/i.test(row.qbType)) {
            verdict = { kind: "bill-payment" };
        } else {
            // Includes Refund Receipts (money OUT to a customer) and any
            // money-in type that posted negative — sign decides, not the label.
            verdict = { kind: "other" };
        }
        return { ...row, isPurchase, verdict };
    });
}
