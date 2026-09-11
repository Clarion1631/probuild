/**
 * Global identity census for a POSITIVE reviewed exact-pair Expense.
 *
 * WHY. The retired-receipt lineage reserves a Purchase unit only when its
 * Expense is a retired ZERO row (`isRetiredZeroReceiptExpense`). A reviewed
 * exact pair names a positive, receipted Expense, so that loader discovers
 * nothing about it: a canonical bank line in another account already linked to
 * the same Purchase, a QBO observation of that Purchase linked to some other
 * line, a second Expense carrying the same receipt document, or a live intake
 * claiming the Purchase under a different Expense — none of it lives inside the
 * same-cents component the planner loads, and none of it is date-bounded.
 * Admitting the pair on component evidence alone would let one physical receipt
 * answer twice. The pair therefore earns its edge only from THIS census.
 *
 * WHAT. Every alias of the pair's Expense is queried by EXACT identity, across
 * all accounts, states and dates:
 *   BankLine.id (the named target) | BankLine.qbTxnId | BankLine.probuildExpenseId
 *   BankLineObservation(QBO_REGISTER).sourceLineId
 *   Expense.id | Expense.qbPurchaseId | Expense.receiptUrl | Expense.sourceFileId
 *   ReceiptIntake.qbPurchaseId | .postVoidQbPurchaseId | .expenseId
 * A pair is eligible only when every row that came back is its own. Any other
 * claimant is a CONFLICT: the pair edge is withheld AND both unit aliases are
 * reserved, so the disputed receipt answers nobody — the same conservative
 * semantics the lineage applies to a disputed retired unit. Nothing here
 * changes the retired-zero rule, binds a line, or calls QBO.
 *
 * SOURCE-FILE GROUPS ARE CONSERVATIVE. Two Expenses may legitimately share a
 * source file when an AI split produced separate groups — but only two KNOWN,
 * UNEQUAL group indices prove that. A null group on either side (a pre-column
 * backfill) says nothing about which page the row came from, so the same file
 * with an unknown group is treated as the same physical receipt.
 *
 * THE CENSUS IS NOT THE ONLY DEFENSE on the target's own link state: the
 * planner predicate (`reviewedReceiptPairMatches`) independently refuses a
 * target whose `qbTxnId`/`probuildExpenseId` name anything but the pair's own
 * identities, so a target relinked to unrelated ids is rejected even if no
 * census row ever mentioned it. The target row is still queried here so its
 * link state is part of the fingerprinted snapshot.
 *
 * PURE CORE, INJECTED I/O, like retired-receipt-lineage: `buildReviewedPairCensus`
 * is the only place the rule lives; `loadReviewedPairCensus` runs the bounded
 * queries against an injected client (the pool, a transaction, or a test fake),
 * so batch planning, the planned component version, the locked in-transaction
 * re-read and recomputeCodesFor all see the same snapshot shape and fingerprint.
 * A query past its cap THROWS; a truncated census claiming completeness is
 * exactly the wrong answer. The snapshot carries receipt URLs: internal data.
 */
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { DEAD_INTAKE_STATES } from "./receipt-requests";

/** Rows any one census query may return before the load refuses. */
export const REVIEWED_PAIR_CENSUS_CAP = 200;

const QBO_REGISTER_SOURCE = "QBO_REGISTER";

export class ReviewedPairCensusOverflowError extends Error {
    constructor(readonly query: string, readonly cap: number) {
        super(`reviewed-pair census query "${query}" exceeded ${cap} rows; refusing to decide from a truncated census`);
        this.name = "ReviewedPairCensusOverflowError";
    }
}

// ── Row shapes ─────────────────────────────────────────────────────────────

/** The identities one pair claims. Derived from the resolved pair fact, never typed by hand in production. */
export interface PairCensusKey {
    expenseId: string;
    targetBankLineId: string;
    qbPurchaseId: string;
    receiptUrl: string | null;
    sourceFileId: string | null;
    sourceGroupIndex: number | null;
}
export interface PairCensusLineRow {
    id: string;
    account: string | null;
    state: string | null;
    qbTxnId: string | null;
    probuildExpenseId: string | null;
}
export interface PairCensusObservationRow {
    id: string;
    bankLineId: string | null;
    source: string;
    sourceDocumentId: string | null;
    sourceLineId: string;
    account: string | null;
    amountCents: number;
}
export interface PairCensusExpenseRow {
    id: string;
    qbPurchaseId: string | null;
    receiptUrl: string | null;
    sourceFileId: string | null;
    sourceGroupIndex: number | null;
    status: string | null;
    /** Decimal STRING form — cent-exactness rule. */
    amount: string;
}
export interface PairCensusIntakeRow {
    id: string;
    state: string;
    stateReason: string | null;
    expenseId: string | null;
    qbPurchaseId: string | null;
    postVoidQbPurchaseId: string | null;
}
export interface PairCensusRows {
    keys: readonly PairCensusKey[];
    lines: readonly PairCensusLineRow[];
    observations: readonly PairCensusObservationRow[];
    expenses: readonly PairCensusExpenseRow[];
    intakes: readonly PairCensusIntakeRow[];
}

export type PairCensusConflict =
    | "target-link-mismatch"
    | "canonical-link-elsewhere"
    | "observation-linked-elsewhere"
    | "duplicate-observation-claim"
    | "expense-missing"
    | "expense-ambiguous"
    | "expense-drift"
    | "purchase-alias-reuse"
    | "receipt-url-reuse"
    | "source-group-reuse"
    | "intake-alias-reuse"
    | "purchase-post-void";

/** Everything the census read for one pair, plus what it decided. Serializable. */
export interface PairCensusEntry {
    key: PairCensusKey;
    lines: PairCensusLineRow[];
    observations: PairCensusObservationRow[];
    expenses: PairCensusExpenseRow[];
    intakes: PairCensusIntakeRow[];
    conflicts: PairCensusConflict[];
    eligible: boolean;
}
export interface ReviewedPairCensusSnapshot {
    /** Sorted by key.expenseId. */
    pairs: PairCensusEntry[];
}
/** What the planner consumes: which pinned Expenses may carry their pair edge, and which units are disputed. */
export interface ReviewedPairCensusEvidence {
    eligible: string[];
    reservedUnits: string[];
}
export interface ReviewedPairCensus {
    snapshot: ReviewedPairCensusSnapshot;
    evidence: ReviewedPairCensusEvidence;
}

// ── Normalization (fixed key order, so JSON.stringify is a stable serialization) ──

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
function byId<T extends { id: string }>(a: T, b: T): number {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function normalizeKey(k: PairCensusKey): PairCensusKey {
    return {
        expenseId: k.expenseId, targetBankLineId: k.targetBankLineId, qbPurchaseId: k.qbPurchaseId,
        receiptUrl: k.receiptUrl ?? null, sourceFileId: k.sourceFileId ?? null, sourceGroupIndex: k.sourceGroupIndex ?? null,
    };
}
function normalizeLine(r: PairCensusLineRow): PairCensusLineRow {
    return { id: r.id, account: r.account ?? null, state: r.state ?? null, qbTxnId: r.qbTxnId ?? null, probuildExpenseId: r.probuildExpenseId ?? null };
}
function normalizeObservation(r: PairCensusObservationRow): PairCensusObservationRow {
    return {
        id: r.id, bankLineId: r.bankLineId ?? null, source: r.source, sourceDocumentId: r.sourceDocumentId ?? null,
        sourceLineId: r.sourceLineId, account: r.account ?? null, amountCents: r.amountCents,
    };
}
function normalizeExpense(r: PairCensusExpenseRow): PairCensusExpenseRow {
    return {
        id: r.id, qbPurchaseId: r.qbPurchaseId ?? null, receiptUrl: r.receiptUrl ?? null, sourceFileId: r.sourceFileId ?? null,
        sourceGroupIndex: r.sourceGroupIndex ?? null, status: r.status ?? null, amount: r.amount,
    };
}
function normalizeIntake(r: PairCensusIntakeRow): PairCensusIntakeRow {
    return {
        id: r.id, state: r.state, stateReason: r.stateReason ?? null, expenseId: r.expenseId ?? null,
        qbPurchaseId: r.qbPurchaseId ?? null, postVoidQbPurchaseId: r.postVoidQbPurchaseId ?? null,
    };
}

/** Dedupe by Expense id, sorted, so planned and locked builds see one key order. */
function uniqueKeys(keys: readonly PairCensusKey[]): PairCensusKey[] {
    const byExpense = new Map<string, PairCensusKey>();
    for (const k of keys) if (!byExpense.has(k.expenseId)) byExpense.set(k.expenseId, normalizeKey(k));
    return [...byExpense.values()].sort((a, b) => (a.expenseId < b.expenseId ? -1 : a.expenseId > b.expenseId ? 1 : 0));
}

// ── The rule ───────────────────────────────────────────────────────────────

/**
 * PURE. Decide every pair from the rows in hand, and record everything read.
 *
 * Each pair's entry is decided from its OWN rows only — the rows carrying one
 * of its identities — so a subset of the snapshot equals a fresh load of that
 * subset, which is what lets the planned component version and the locked
 * re-read agree.
 */
export function buildReviewedPairCensus(rows: PairCensusRows): ReviewedPairCensus {
    const keys = uniqueKeys(rows.keys);
    const lines = rows.lines.map(normalizeLine);
    const observations = rows.observations.map(normalizeObservation);
    const expenses = rows.expenses.map(normalizeExpense);
    const intakes = rows.intakes.map(normalizeIntake);

    const pairs: PairCensusEntry[] = keys.map(key => {
        const own = {
            lines: lines.filter(l => l.id === key.targetBankLineId || l.qbTxnId === key.qbPurchaseId || l.probuildExpenseId === key.expenseId).sort(byId),
            observations: observations.filter(o => o.source === QBO_REGISTER_SOURCE && o.sourceLineId === key.qbPurchaseId).sort(byId),
            expenses: expenses.filter(e => e.id === key.expenseId
                || e.qbPurchaseId === key.qbPurchaseId
                || (key.receiptUrl !== null && e.receiptUrl === key.receiptUrl)
                || (key.sourceFileId !== null && e.sourceFileId === key.sourceFileId)).sort(byId),
            intakes: intakes.filter(i => i.qbPurchaseId === key.qbPurchaseId || i.postVoidQbPurchaseId === key.qbPurchaseId || i.expenseId === key.expenseId).sort(byId),
        };
        const conflicts = new Set<PairCensusConflict>();

        // Canonical bank links, any account, any state: only the named target
        // may carry the pair's identities, and then only its own. The target's
        // absence is not decided here (the planner has no line to judge then);
        // its presence with foreign links is.
        for (const l of own.lines) {
            if (l.id !== key.targetBankLineId) conflicts.add("canonical-link-elsewhere");
            else if ((l.qbTxnId !== null && l.qbTxnId !== key.qbPurchaseId) || (l.probuildExpenseId !== null && l.probuildExpenseId !== key.expenseId)) conflicts.add("target-link-mismatch");
        }
        // QBO register observations of the Purchase: at most one anywhere, and
        // linked to nothing or to the named target.
        if (own.observations.some(o => o.bankLineId !== null && o.bankLineId !== key.targetBankLineId)) conflicts.add("observation-linked-elsewhere");
        if (own.observations.length > 1) conflicts.add("duplicate-observation-claim");
        // The pinned Expense must exist, once, still carrying the pinned identities;
        // no other Expense may share its Purchase, its receipt, or its source page.
        const self = own.expenses.filter(e => e.id === key.expenseId);
        if (self.length === 0) conflicts.add("expense-missing");
        if (self.length > 1) conflicts.add("expense-ambiguous");
        if (self.length === 1 && (self[0].qbPurchaseId !== key.qbPurchaseId || self[0].receiptUrl !== key.receiptUrl
            || self[0].sourceFileId !== key.sourceFileId || self[0].sourceGroupIndex !== key.sourceGroupIndex)) conflicts.add("expense-drift");
        for (const e of own.expenses) {
            if (e.id === key.expenseId) continue;
            if (e.qbPurchaseId === key.qbPurchaseId) conflicts.add("purchase-alias-reuse");
            if (key.receiptUrl !== null && e.receiptUrl === key.receiptUrl) conflicts.add("receipt-url-reuse");
            // The same source file is the same physical receipt unless BOTH group
            // indices are known and differ: an unknown group on either side cannot
            // prove a separate page, so it is a conflict, not a split.
            if (key.sourceFileId !== null && e.sourceFileId === key.sourceFileId
                && (key.sourceGroupIndex === null || e.sourceGroupIndex === null || e.sourceGroupIndex === key.sourceGroupIndex)) conflicts.add("source-group-reuse");
        }
        // Intake aliases: a post-void record of the Purchase is disqualifying in any
        // state; a LIVE intake may claim the Purchase or the Expense only as this
        // Expense's own booked intake (both aliases agreeing). Dead-state rows are
        // recorded (they move the fingerprint) but are not capacity.
        for (const i of own.intakes) {
            if (i.postVoidQbPurchaseId === key.qbPurchaseId) conflicts.add("purchase-post-void");
            if (DEAD_INTAKE_STATES.has(i.state)) continue;
            const claimsExpense = i.expenseId === key.expenseId;
            const claimsPurchase = i.qbPurchaseId === key.qbPurchaseId;
            if ((claimsExpense && !claimsPurchase) || (claimsPurchase && !claimsExpense)) conflicts.add("intake-alias-reuse");
        }
        const sorted = [...conflicts].sort();
        return { key, ...own, conflicts: sorted, eligible: sorted.length === 0 };
    });

    const reservedUnits = [...new Set(pairs.filter(p => !p.eligible).flatMap(p => [`expense:${p.key.expenseId}`, `purchase:${p.key.qbPurchaseId}`]))].sort();
    return {
        snapshot: { pairs },
        evidence: { eligible: pairs.filter(p => p.eligible).map(p => p.key.expenseId), reservedUnits },
    };
}

/** The entries for `expenseIds` only — a planned component's share of a batch-wide load. */
export function subsetPairCensus(snapshot: ReviewedPairCensusSnapshot, expenseIds: readonly string[]): ReviewedPairCensusSnapshot {
    const wanted = new Set(expenseIds);
    return { pairs: snapshot.pairs.filter(p => wanted.has(p.key.expenseId)) };
}

/** A stable, order-independent digest of EVERY field the census read. Cryptographic: it gates receipt suppression. */
export function pairCensusFingerprint(snapshot: ReviewedPairCensusSnapshot): string {
    const pairs = [...snapshot.pairs].sort((a, b) => a.key.expenseId.localeCompare(b.key.expenseId));
    return createHash("sha256").update(JSON.stringify({ pairs })).digest("hex");
}

/**
 * Census keys from planner-shaped Expense rows that resolved a pair fact. The
 * identities come from the fact (pinned and already compared to the row), and
 * only for the row the fact names, so a fact can never be censused on behalf of
 * a different Expense.
 */
export function reviewedPairCensusKeys(expenses: ReadonlyArray<{
    id: string;
    reviewedPairFact?: { targetBankLineId: string; expenseId: string; qbPurchaseId: string; receiptUrl: string; sourceFileId: string | null; sourceGroupIndex: number | null } | null;
}>): PairCensusKey[] {
    return uniqueKeys(expenses.flatMap(e => {
        const f = e.reviewedPairFact;
        if (!f || f.expenseId !== e.id) return [];
        return [{ expenseId: f.expenseId, targetBankLineId: f.targetBankLineId, qbPurchaseId: f.qbPurchaseId, receiptUrl: f.receiptUrl, sourceFileId: f.sourceFileId, sourceGroupIndex: f.sourceGroupIndex }];
    }));
}

// ── Bounded loading through an injected client ─────────────────────────────

export interface PairCensusModel {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<unknown[]>;
}
export interface PairCensusDb {
    bankLine: PairCensusModel;
    bankLineObservation: PairCensusModel;
    expense: PairCensusModel;
    receiptIntake: PairCensusModel;
}
/** The Prisma shape this accepts. Type only — no runtime client is imported here. */
export type PairCensusTransactionClient = Pick<Prisma.TransactionClient, "bankLine" | "bankLineObservation" | "expense" | "receiptIntake">;

const LINE_SELECT = { id: true, account: true, state: true, qbTxnId: true, probuildExpenseId: true } as const satisfies Prisma.BankLineSelect;
const OBSERVATION_SELECT = { id: true, bankLineId: true, source: true, sourceDocumentId: true, sourceLineId: true, account: true, amountCents: true } as const satisfies Prisma.BankLineObservationSelect;
const EXPENSE_SELECT = { id: true, qbPurchaseId: true, receiptUrl: true, sourceFileId: true, sourceGroupIndex: true, status: true, amount: true } as const satisfies Prisma.ExpenseSelect;
const INTAKE_SELECT = { id: true, state: true, stateReason: true, expenseId: true, qbPurchaseId: true, postVoidQbPurchaseId: true } as const satisfies Prisma.ReceiptIntakeSelect;

function readLine(row: unknown): PairCensusLineRow {
    const r = row as Record<string, unknown>;
    return normalizeLine({ id: String(r.id), account: str(r.account), state: str(r.state), qbTxnId: str(r.qbTxnId), probuildExpenseId: str(r.probuildExpenseId) });
}
function readObservation(row: unknown): PairCensusObservationRow {
    const r = row as Record<string, unknown>;
    return normalizeObservation({
        id: String(r.id), bankLineId: str(r.bankLineId), source: String(r.source), sourceDocumentId: str(r.sourceDocumentId),
        sourceLineId: String(r.sourceLineId), account: str(r.account), amountCents: Number(r.amountCents),
    });
}
function readExpense(row: unknown): PairCensusExpenseRow {
    const r = row as Record<string, unknown>;
    return normalizeExpense({
        id: String(r.id), qbPurchaseId: str(r.qbPurchaseId), receiptUrl: str(r.receiptUrl), sourceFileId: str(r.sourceFileId),
        sourceGroupIndex: int(r.sourceGroupIndex), status: str(r.status), amount: str(r.amount) ?? "",
    });
}
function readIntake(row: unknown): PairCensusIntakeRow {
    const r = row as Record<string, unknown>;
    return normalizeIntake({
        id: String(r.id), state: String(r.state), stateReason: str(r.stateReason), expenseId: str(r.expenseId),
        qbPurchaseId: str(r.qbPurchaseId), postVoidQbPurchaseId: str(r.postVoidQbPurchaseId),
    });
}

/**
 * Load and decide the census for `keys`. Every alias is queried by exact
 * identity with no account, state or date filter, in one batched read per
 * model; every query takes `cap + 1` and THROWS on overflow.
 */
export async function loadReviewedPairCensus(
    db: PairCensusDb,
    keys: readonly PairCensusKey[],
    options: { cap?: number; checkBudget?: () => void } = {},
): Promise<ReviewedPairCensus> {
    const cap = options.cap ?? REVIEWED_PAIR_CENSUS_CAP;
    const unique = uniqueKeys(keys);
    if (unique.length === 0) return buildReviewedPairCensus({ keys: [], lines: [], observations: [], expenses: [], intakes: [] });
    if (unique.length > cap) throw new ReviewedPairCensusOverflowError("pair keys", cap);
    const bounded = async (query: string, fetch: () => Promise<unknown[]>): Promise<unknown[]> => {
        options.checkBudget?.();
        const rows = await fetch();
        options.checkBudget?.();
        if (rows.length > cap) throw new ReviewedPairCensusOverflowError(query, cap);
        return rows;
    };
    const targetIds = [...new Set(unique.map(k => k.targetBankLineId))].sort();
    const purchaseIds = [...new Set(unique.map(k => k.qbPurchaseId))].sort();
    const expenseIds = [...new Set(unique.map(k => k.expenseId))].sort();
    const receiptUrls = [...new Set(unique.flatMap(k => (k.receiptUrl ? [k.receiptUrl] : [])))].sort();
    const sourceFileIds = [...new Set(unique.flatMap(k => (k.sourceFileId ? [k.sourceFileId] : [])))].sort();

    const lines = (await bounded("bankLine.links", () => db.bankLine.findMany({
        where: { OR: [{ id: { in: targetIds } }, { qbTxnId: { in: purchaseIds } }, { probuildExpenseId: { in: expenseIds } }] },
        select: LINE_SELECT, take: cap + 1,
    }))).map(readLine);
    const observations = (await bounded("bankLineObservation.claims", () => db.bankLineObservation.findMany({
        where: { source: QBO_REGISTER_SOURCE, sourceLineId: { in: purchaseIds } },
        select: OBSERVATION_SELECT, take: cap + 1,
    }))).map(readObservation);
    const expenses = (await bounded("expense.aliases", () => db.expense.findMany({
        where: {
            OR: [
                { id: { in: expenseIds } },
                { qbPurchaseId: { in: purchaseIds } },
                ...(receiptUrls.length ? [{ receiptUrl: { in: receiptUrls } }] : []),
                ...(sourceFileIds.length ? [{ sourceFileId: { in: sourceFileIds } }] : []),
            ],
        },
        select: EXPENSE_SELECT, take: cap + 1,
    }))).map(readExpense);
    const intakes = (await bounded("receiptIntake.aliases", () => db.receiptIntake.findMany({
        where: { OR: [{ qbPurchaseId: { in: purchaseIds } }, { postVoidQbPurchaseId: { in: purchaseIds } }, { expenseId: { in: expenseIds } }] },
        select: INTAKE_SELECT, take: cap + 1,
    }))).map(readIntake);

    return buildReviewedPairCensus({ keys: unique, lines, observations, expenses, intakes });
}
