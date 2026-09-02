import { qbFetch, type QBTokens } from "@/lib/quickbooks";
import { prisma } from "@/lib/prisma";
import { resolveExpenseProjectLabel } from "@/lib/expense-attribution";
import { isPurchaseType, isMoneyInType } from "@/lib/register-types";

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
 * are pending, excluded, unmatched, or absent from QuickBooks, and it does
 * not prove bank clearance. The UI must say so — no "true north" claims.
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
    /** Signed integer cents: deposits +, money out −. */
    amountCents: number;
}

export interface BankRegisterResult {
    rows: BankRegisterRow[];
    fetchedAt: string;
    /** True when QBO errored and this is the previous successful fetch. */
    stale: boolean;
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
                    amountCents: Math.round(amountRaw * 100),
                });
            }
        }
        if (row.Rows?.Row) walkGlRows(row.Rows.Row, idx, out);
    }
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
                columns: "tx_date,txn_type,doc_num,name,subt_nat_amount",
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
            const result: BankRegisterResult = {
                rows,
                fetchedAt: new Date().toISOString(),
                stale: false,
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
                // BOTH sides — the register labels a row by the job the money is
            // actually on, not by the estimate it was booked against.
            projectId: true,
            project: { select: { id: true, name: true } },
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
                const label = resolveExpenseProjectLabel(expense);
                verdict = {
                    kind: "linked",
                    // Resolved, not read off the estimate — see
                    // resolveExpenseProjectLabel.
                    projectId: label.projectId,
                    projectName: label.projectName,
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
