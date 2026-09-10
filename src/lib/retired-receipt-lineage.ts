/**
 * Exact-lineage receipt recognition for RETIRED ZERO Expenses.
 *
 * WHY. The QBO import retires an Expense whose purchase has no active project
 * ("Removed in QBO (no-active-project)"): the amount is zeroed, the tax tuple
 * cleared, the status set to Reviewed — and the receipt it carried stays on
 * the row. The missing-receipt matcher folds evidence by amount, date and
 * payee, so a zero-amount Expense can never answer a real debit; worse, it
 * HIDES the ReceiptIntake it unit-folds with (dedupe keeps the Expense first).
 * The receipt exists, and the chase opens anyway.
 *
 * WHAT. This module proves, by EXACT ids only, that a retired zero Expense is
 * the receipt for one specific canonical bank line:
 *
 *   BankLine.id ← BankLineObservation.bankLineId (source QBO_REGISTER,
 *   sourceDocumentId QBO_REGISTER) → sourceLineId (exact numeric Purchase id,
 *   no "#n" split suffix) → Expense.qbPurchaseId
 *
 * with the observation agreeing with the canonical line on account and cents
 * (negative integer), the line's qbTxnId null or the same id, that observation
 * the SOLE eligible one on the line, that source id claimed by NO other
 * observation anywhere (any account, any line), and exactly one Expense for the
 * id — retired, literal zero, receipt-bearing, full retirement tax tuple.
 *
 * WHAT IT DOES NOT DO. It never restores an amount, never touches BankLine
 * state or links, never calls QBO, never asks about projects (a receipt stays
 * a receipt when the project reopens). Anything short of exact proof fails
 * closed: the retired unit cannot grant an uncertain receipt match.
 *
 * PURE CORE, INJECTED I/O. `buildRetiredReceiptLineage` is pure and is the only
 * place the rule lives; `loadRetiredReceiptLineage` runs the bounded queries
 * against an injected client (a transaction, the pool, or a test fake) so every
 * consumer — batch planning, the planned component version, the locked
 * in-transaction re-read, and recomputeCodesFor — sees the same snapshot shape
 * and the same fingerprint. A query that overflows its cap THROWS; a truncated
 * snapshot claiming to be complete is exactly the wrong answer.
 *
 * The snapshot is INTERNAL DATA: it carries receipt URLs and must never be
 * handed to a UI.
 */
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
export { lockBankLineIdentity } from "./bank-reconcile-guard";
export { BANK_LINE_IDENTITY_LOCK } from "./bank-line-mint";

/** The exact marker the QBO import writes on an Expense it retired. */
export const RETIREMENT_MARKER = "[QuickBooks import] Removed in QBO (no-active-project)";

/** The status a retired Expense carries. */
export const RETIRED_EXPENSE_STATUS = "Reviewed";

/** The one observation source (and document) that can vouch for a line here. */
export const QBO_REGISTER_SOURCE = "QBO_REGISTER";

/** A QBO Purchase id, exactly: digits only. `123#1` is a split line, not a purchase. */
export const EXACT_PURCHASE_ID = /^[0-9]+$/;

/** Rows any one lineage query may return before the load refuses. */
export const LINEAGE_QUERY_CAP = 5_000;

/** Raised when a lineage query overflowed its cap. Never swallowed, never truncated. */
export class LineageQueryOverflowError extends Error {
    constructor(readonly query: string, readonly cap: number) {
        super(`retired-receipt lineage query "${query}" exceeded ${cap} rows; refusing to plan from a truncated snapshot`);
        this.name = "LineageQueryOverflowError";
    }
}

// ── Row shapes (plain, caller- or loader-supplied) ────────────────────────

export interface LineageBankLineRow {
    id: string;
    account: string | null;
    /** Signed canonical cents. */
    amountCents: number;
    qbTxnId: string | null;
}

export interface LineageObservationRow {
    id: string;
    bankLineId: string | null;
    source: string;
    sourceDocumentId: string | null;
    sourceLineId: string;
    account: string | null;
    /** Signed observation cents. */
    amountCents: number;
}

export interface LineageExpenseRow {
    id: string;
    qbPurchaseId: string | null;
    /** Decimal STRING form — cent-exactness rule. */
    amount: string;
    /** The actual URL, not a boolean: a changed receipt is a changed fact. */
    receiptUrl: string | null;
    status: string | null;
    description: string | null;
    taxAmount: string | null;
    taxSource: string | null;
    installedAtCustomer: boolean | null;
    taxDeductibleBase: string | null;
    taxDeductibleBaseSource: string | null;
    taxAtSource: boolean | null;
    needsTaxReview: boolean | null;
}

export interface LineageRows {
    lineIds: readonly string[];
    lines: readonly LineageBankLineRow[];
    /** Observations LINKED to the lines (any source; eligibility is decided here). */
    observations: readonly LineageObservationRow[];
    /** Every QBO_REGISTER observation anywhere carrying one of the candidate source ids. */
    claims: readonly LineageObservationRow[];
    /** Every Expense carrying one of the candidate source ids, whatever its date. */
    expenses: readonly LineageExpenseRow[];
    /** Purchase units present in ordinary date-window evidence, even if their bound line is elsewhere. */
    candidatePurchaseIds?: readonly string[];
}

export type LineageVerdict =
    | "bound"
    | "no-eligible-observation"
    | "multiple-observations"
    | "duplicate-claim"
    | "no-canonical-line"
    | "observation-mismatch"
    | "qb-txn-mismatch"
    | "no-expense"
    | "multiple-expenses"
    | "expense-not-retired-receipt"
    | "conflicting-binding";

/** Everything the rule read for one line, plus what it decided. Serializable. */
export interface LineLineageSnapshot {
    lineId: string;
    canonical: LineageBankLineRow | null;
    observations: LineageObservationRow[];
    claims: LineageObservationRow[];
    expenses: LineageExpenseRow[];
    verdict: LineageVerdict;
    boundUnit: string | null;
    reservedUnits: string[];
}

export interface RetiredReceiptLineageSnapshot {
    /** Sorted by lineId. */
    lines: LineLineageSnapshot[];
    units?: Array<{ unit: string; claims: LineageObservationRow[]; expenses: LineageExpenseRow[]; reserved: boolean }>;
}

/** One exactly-bound receipt: this unit answers this line and no other. */
export interface BoundReceiptEvidence {
    /** `purchase:<id>` — the same unit key evidenceUnitKey mints. */
    unit: string;
    bankLineId: string;
    /** POSITIVE: the absolute observation cents. */
    amountCents: number;
    expenseId: string;
    qbPurchaseId: string;
    observationId: string;
}

export interface BoundReceiptLineage {
    bound: BoundReceiptEvidence[];
    /**
     * Purchase units whose lineage is ambiguous or conflicting. The matcher
     * removes them from ordinary evidence and binds them to nothing: a unit in
     * dispute answers no line until a human or a later import settles it.
     */
    reservedUnits: string[];
}

export interface RetiredReceiptLineage {
    snapshot: RetiredReceiptLineageSnapshot;
    evidence: BoundReceiptLineage;
}

// ── The rule ─────────────────────────────────────────────────────────────

export function isEligibleObservation(o: LineageObservationRow): boolean {
    return o.source === QBO_REGISTER_SOURCE
        && o.sourceDocumentId === QBO_REGISTER_SOURCE
        && EXACT_PURCHASE_ID.test(o.sourceLineId);
}

/** A literal, plain-decimal zero. Nothing else — not "", not "-0.00", not "0e0". */
export function isLiteralZeroAmount(amount: string): boolean {
    return /^0+(?:\.0+)?$/.test(amount.trim());
}

/**
 * Retired, zero, receipt-bearing, full retirement tuple. All of it; a partial
 * retirement is not a retirement.
 */
export function isRetiredZeroReceiptExpense(e: LineageExpenseRow): boolean {
    return e.status === RETIRED_EXPENSE_STATUS
        && typeof e.description === "string" && e.description === RETIREMENT_MARKER
        && isLiteralZeroAmount(e.amount)
        && typeof e.receiptUrl === "string" && e.receiptUrl.trim() !== ""
        && e.taxAmount === null
        && e.taxSource === null
        && e.installedAtCustomer === null
        && e.taxDeductibleBase === null
        && e.taxDeductibleBaseSource === null
        && e.taxAtSource === false
        && e.needsTaxReview === false;
}

function unitOf(purchaseId: string): string {
    return `purchase:${purchaseId}`;
}

function byId<T extends { id: string }>(a: T, b: T): number {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Fixed key order, so JSON.stringify is a stable serialization.
function normalizeLine(r: LineageBankLineRow): LineageBankLineRow {
    return { id: r.id, account: r.account ?? null, amountCents: r.amountCents, qbTxnId: r.qbTxnId ?? null };
}
function normalizeObservation(r: LineageObservationRow): LineageObservationRow {
    return {
        id: r.id, bankLineId: r.bankLineId ?? null, source: r.source, sourceDocumentId: r.sourceDocumentId ?? null,
        sourceLineId: r.sourceLineId, account: r.account ?? null, amountCents: r.amountCents,
    };
}
function normalizeExpense(r: LineageExpenseRow): LineageExpenseRow {
    return {
        id: r.id, qbPurchaseId: r.qbPurchaseId ?? null, amount: r.amount, receiptUrl: r.receiptUrl ?? null,
        status: r.status ?? null, description: r.description ?? null, taxAmount: r.taxAmount ?? null,
        taxSource: r.taxSource ?? null, installedAtCustomer: r.installedAtCustomer ?? null,
        taxDeductibleBase: r.taxDeductibleBase ?? null, taxDeductibleBaseSource: r.taxDeductibleBaseSource ?? null,
        taxAtSource: r.taxAtSource ?? null, needsTaxReview: r.needsTaxReview ?? null,
    };
}

/**
 * PURE. Decide every line from the rows in hand, and record everything read.
 *
 * Each line's entry is decided from its OWN rows only — its observations, the
 * global claims on its source ids, the Expenses for those ids — so a subset of
 * the snapshot equals a fresh load of that subset, which is what lets the
 * planned component version and the locked re-read agree.
 */
export function buildRetiredReceiptLineage(rows: LineageRows): RetiredReceiptLineage {
    const lineIds = [...new Set(rows.lineIds)].sort();
    const lines = rows.lines.map(normalizeLine);
    const observations = rows.observations.map(normalizeObservation);
    const claims = rows.claims.map(normalizeObservation);
    const expenses = rows.expenses.map(normalizeExpense);

    const entries: LineLineageSnapshot[] = lineIds.map(lineId => {
        const canonical = lines.find(l => l.id === lineId) ?? null;
        const own = observations.filter(o => o.bankLineId === lineId).sort(byId);
        const eligible = own.filter(isEligibleObservation);
        const sourceIds = [...new Set(eligible.map(o => o.sourceLineId))].sort();
        const ownClaims = claims.filter(c => sourceIds.includes(c.sourceLineId)).sort(byId);
        const ownExpenses = expenses
            .filter(e => e.qbPurchaseId !== null && sourceIds.includes(e.qbPurchaseId))
            .sort(byId);
        const units = sourceIds.map(unitOf);
        const base = { lineId, canonical, observations: own, claims: ownClaims, expenses: ownExpenses };
        const fail = (verdict: LineageVerdict, reservedUnits: string[]): LineLineageSnapshot =>
            ({ ...base, verdict, boundUnit: null, reservedUnits: reservedUnits.filter(unit => ownExpenses.some(e => e.qbPurchaseId !== null && unitOf(e.qbPurchaseId) === unit && isRetiredZeroReceiptExpense(e))) });

        // Sole eligible observation on the line.
        if (eligible.length === 0) return fail("no-eligible-observation", []);
        if (eligible.length > 1) return fail("multiple-observations", units);
        const obs = eligible[0];
        const unit = unitOf(obs.sourceLineId);
        // Unique global claim on that source id — any other observation, on any
        // account or line, makes the id disputed.
        if (ownClaims.length !== 1 || ownClaims[0].id !== obs.id) return fail("duplicate-claim", [unit]);
        if (!canonical) return fail("no-canonical-line", [unit]);
        // Same account, same negative integer cents, observation == canonical.
        if (!Number.isInteger(obs.amountCents) || obs.amountCents >= 0
            || obs.amountCents !== canonical.amountCents
            || obs.account === null || obs.account !== canonical.account) {
            return fail("observation-mismatch", [unit]);
        }
        if (canonical.qbTxnId !== null && canonical.qbTxnId !== obs.sourceLineId) return fail("qb-txn-mismatch", [unit]);
        // Exactly one Expense for the id, and it must be the retired receipt.
        const matching = ownExpenses.filter(e => e.qbPurchaseId === obs.sourceLineId);
        if (matching.length === 0) return fail("no-expense", []);
        if (matching.length > 1) return fail("multiple-expenses", [unit]);
        if (!isRetiredZeroReceiptExpense(matching[0])) return fail("expense-not-retired-receipt", []);
        return { ...base, verdict: "bound", boundUnit: unit, reservedUnits: [] };
    });

    // Belt and braces: the global-claim check above already forbids one unit
    // binding two lines, but if it ever did, NEITHER line may have it.
    const holders = new Map<string, number>();
    for (const entry of entries) {
        if (entry.boundUnit) holders.set(entry.boundUnit, (holders.get(entry.boundUnit) ?? 0) + 1);
    }
    for (const entry of entries) {
        if (entry.boundUnit && (holders.get(entry.boundUnit) ?? 0) > 1) {
            entry.reservedUnits = [entry.boundUnit];
            entry.verdict = "conflicting-binding";
            entry.boundUnit = null;
        }
    }

    const bound: BoundReceiptEvidence[] = entries
        .filter(entry => entry.boundUnit !== null)
        .map(entry => {
            const obs = entry.observations.filter(isEligibleObservation)[0];
            const expense = entry.expenses.find(e => e.qbPurchaseId === obs.sourceLineId) as LineageExpenseRow;
            return {
                unit: entry.boundUnit as string,
                bankLineId: entry.lineId,
                amountCents: Math.abs(obs.amountCents),
                expenseId: expense.id,
                qbPurchaseId: obs.sourceLineId,
                observationId: obs.id,
            };
        });
    const units = [...new Set(rows.candidatePurchaseIds ?? [])].sort().map(id => {
        const unitExpenses = expenses.filter(e => e.qbPurchaseId === id).sort(byId);
        return { unit: unitOf(id), claims: claims.filter(c => c.sourceLineId === id).sort(byId), expenses: unitExpenses,
            reserved: unitExpenses.some(isRetiredZeroReceiptExpense) };
    });
    const boundUnits = new Set(bound.map(b => b.unit));
    const reservedUnits = [...new Set([...entries.flatMap(entry => entry.reservedUnits),
        ...units.filter(u => u.reserved && !boundUnits.has(u.unit)).map(u => u.unit),
        ...expenses.filter(isRetiredZeroReceiptExpense).filter(e => e.qbPurchaseId && (boundUnits.has(unitOf(e.qbPurchaseId)) || units.some(u => u.unit === unitOf(e.qbPurchaseId!) && u.reserved) || entries.some(entry => entry.reservedUnits.includes(unitOf(e.qbPurchaseId!))))).map(e => `expense:${e.id}`)])].sort();
    return { snapshot: { lines: entries, units }, evidence: { bound, reservedUnits } };
}

/** The entries for `lineIds` only — a planned component's share of a batch-wide load. */
export function subsetLineage(snapshot: RetiredReceiptLineageSnapshot, lineIds: readonly string[], candidatePurchaseIds: readonly string[] = [], candidateExpenseIds: readonly string[] = []): RetiredReceiptLineageSnapshot {
    const wanted = new Set(lineIds);
    return { lines: snapshot.lines.filter(entry => wanted.has(entry.lineId)), units: (snapshot.units ?? []).filter(u => candidatePurchaseIds.some(id => unitOf(id) === u.unit) || u.expenses.some(e => candidateExpenseIds.includes(e.id))) };
}

/**
 * A stable, order-independent digest of EVERY field the rule read. Cryptographic
 * because this snapshot gates receipt suppression.
 */
export function lineageFingerprint(snapshot: RetiredReceiptLineageSnapshot): string {
    return createHash("sha256").update(JSON.stringify({
        lines: [...snapshot.lines].sort((a, b) => a.lineId.localeCompare(b.lineId)),
        units: [...(snapshot.units ?? [])].sort((a, b) => a.unit.localeCompare(b.unit)),
    })).digest("hex");
}

// ── Bounded loading through an injected client ────────────────────────────

/** A model delegate: a Prisma delegate, a transaction's, or a test fake. */
export interface LineageModel {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<unknown[]>;
}

export interface LineageDb {
    bankLine: LineageModel;
    bankLineObservation: LineageModel;
    expense: LineageModel;
}

/** The Prisma shape this accepts. Type only — no runtime client is imported here. */
export type LineageTransactionClient = Pick<Prisma.TransactionClient, "bankLine" | "bankLineObservation" | "expense">;

const OBSERVATION_SELECT = {
    id: true, bankLineId: true, source: true, sourceDocumentId: true,
    sourceLineId: true, account: true, amountCents: true,
} as const satisfies Prisma.BankLineObservationSelect;

const EXPENSE_SELECT = {
    id: true, qbPurchaseId: true, amount: true, receiptUrl: true, status: true, description: true,
    taxAmount: true, taxSource: true, installedAtCustomer: true, taxDeductibleBase: true,
    taxDeductibleBaseSource: true, taxAtSource: true, needsTaxReview: true,
} as const satisfies Prisma.ExpenseSelect;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function readLine(row: unknown): LineageBankLineRow {
    const r = row as Record<string, unknown>;
    return normalizeLine({ id: String(r.id), account: str(r.account), amountCents: Number(r.amountCents), qbTxnId: str(r.qbTxnId) });
}
function readObservation(row: unknown): LineageObservationRow {
    const r = row as Record<string, unknown>;
    return normalizeObservation({
        id: String(r.id), bankLineId: str(r.bankLineId), source: String(r.source), sourceDocumentId: str(r.sourceDocumentId),
        sourceLineId: String(r.sourceLineId), account: str(r.account), amountCents: Number(r.amountCents),
    });
}
function readExpense(row: unknown): LineageExpenseRow {
    const r = row as Record<string, unknown>;
    return normalizeExpense({
        id: String(r.id), qbPurchaseId: str(r.qbPurchaseId), amount: str(r.amount) ?? "", receiptUrl: str(r.receiptUrl),
        status: str(r.status), description: str(r.description), taxAmount: str(r.taxAmount), taxSource: str(r.taxSource),
        installedAtCustomer: bool(r.installedAtCustomer), taxDeductibleBase: str(r.taxDeductibleBase),
        taxDeductibleBaseSource: str(r.taxDeductibleBaseSource), taxAtSource: bool(r.taxAtSource), needsTaxReview: bool(r.needsTaxReview),
    });
}

/**
 * Load and decide the lineage for `lineIds`. Queries by ID, never by date, so a
 * retired Expense outside any evidence window still reaches its bound line.
 * Every query takes `cap + 1` and THROWS on overflow.
 */
export async function loadRetiredReceiptLineage(
    db: LineageDb,
    lineIds: readonly string[],
    options: { cap?: number; candidatePurchaseIds?: readonly string[]; candidateExpenseIds?: readonly string[] } = {},
): Promise<RetiredReceiptLineage> {
    const cap = options.cap ?? LINEAGE_QUERY_CAP;
    const ids = [...new Set(lineIds)].sort();
    let candidatePurchaseIds = [...new Set(options.candidatePurchaseIds ?? [])].filter(id => EXACT_PURCHASE_ID.test(id)).sort();
    if (candidatePurchaseIds.length > cap) throw new LineageQueryOverflowError("candidate purchase ids", cap);
    if (ids.length === 0) return buildRetiredReceiptLineage({ lineIds: [], lines: [], observations: [], claims: [], expenses: [] });
    if (ids.length > cap) throw new LineageQueryOverflowError("bankLine ids", cap);
    const bounded = async (query: string, fetch: () => Promise<unknown[]>): Promise<unknown[]> => {
        const rows = await fetch();
        if (rows.length > cap) throw new LineageQueryOverflowError(query, cap);
        return rows;
    };

    const candidateExpenseIds = [...new Set(options.candidateExpenseIds ?? [])].sort();
    if (candidateExpenseIds.length > cap) throw new LineageQueryOverflowError("candidate expense ids", cap);
    const aliasExpenses = candidateExpenseIds.length === 0 ? [] : (await bounded("expense.aliases", () => db.expense.findMany({ where: { id: { in: candidateExpenseIds } }, select: EXPENSE_SELECT, take: cap + 1 }))).map(readExpense);
    candidatePurchaseIds = [...new Set([...candidatePurchaseIds, ...aliasExpenses.flatMap(e => e.qbPurchaseId && EXACT_PURCHASE_ID.test(e.qbPurchaseId) ? [e.qbPurchaseId] : [])])].sort();
    const lines = (await bounded("bankLine", () => db.bankLine.findMany({
        where: { id: { in: ids } },
        select: { id: true, account: true, amountCents: true, qbTxnId: true } satisfies Prisma.BankLineSelect,
        take: cap + 1,
    }))).map(readLine);
    const observations = (await bounded("bankLineObservation.linked", () => db.bankLineObservation.findMany({
        where: { bankLineId: { in: ids } },
        select: OBSERVATION_SELECT,
        take: cap + 1,
    }))).map(readObservation);
    const sourceIds = [...new Set([...observations.filter(isEligibleObservation).map(o => o.sourceLineId), ...candidatePurchaseIds])].sort();
    if (sourceIds.length > cap) throw new LineageQueryOverflowError("source ids", cap);
    // ACROSS ALL ACCOUNTS AND LINES: no bankLineId filter, on purpose.
    const claims = sourceIds.length === 0 ? [] : (await bounded("bankLineObservation.claims", () => db.bankLineObservation.findMany({
        where: { source: QBO_REGISTER_SOURCE, sourceLineId: { in: sourceIds } },
        select: OBSERVATION_SELECT,
        take: cap + 1,
    }))).map(readObservation);
    // By purchase id, whatever the Expense's date.
    const expenses = sourceIds.length === 0 ? [] : (await bounded("expense", () => db.expense.findMany({
        where: { qbPurchaseId: { in: sourceIds } },
        select: EXPENSE_SELECT,
        take: cap + 1,
    }))).map(readExpense);

    return buildRetiredReceiptLineage({ lineIds: ids, lines, observations, claims, expenses, candidatePurchaseIds });
}


/** Exact purchase ids visible in ordinary evidence; used to reserve units whose bound line is outside this component. */
export function lineagePurchaseIds(...groups: ReadonlyArray<ReadonlyArray<{ qbPurchaseId?: string | null }>>): string[] {
    return [...new Set(groups.flatMap(rows => rows.flatMap(r => r.qbPurchaseId && EXACT_PURCHASE_ID.test(r.qbPurchaseId) ? [r.qbPurchaseId] : [])))].sort();
}

/** Exact Expense aliases from intake evidence, including intakes without a QBO id. */
export function lineageExpenseIds(rows: ReadonlyArray<{ expenseId?: string | null }>): string[] {
    return [...new Set(rows.flatMap(r => r.expenseId ? [r.expenseId] : []))].sort();
}
