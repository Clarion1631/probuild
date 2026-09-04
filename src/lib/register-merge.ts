import { resolveExpenseProjectLabel } from "@/lib/expense-attribution";
import type { BankRegisterRow } from "./qbo-bank-register";
import { isPurchaseType, isMoneyInType } from "./register-types";

/**
 * Pure merge/status layer for the unified money register
 * (docs/UNIFIED-REGISTER-PLAN.md §1, §2).
 *
 * PURITY IS A HARD REQUIREMENT: no Prisma calls, no fetch, no I/O of any
 * kind. Every input is already-fetched data; every output is derived only
 * from those inputs. This is what makes the status matrix unit-testable in
 * isolation and reviewable as pure money-math.
 *
 * Callers own scoping/auth (see qbo-bank-register.ts's AUTH CONTRACT) and own
 * fetching `expenses` / `receiptEvents` / `classifications` for the rendered
 * window before calling in here.
 *
 * `isPurchaseType` / `isMoneyInType` come from `register-types.ts`, a pure
 * leaf module shared with `qbo-bank-register.ts` (owned by a parallel
 * workstream) so the two never drift — see that module for details. Only
 * that pure leaf module is imported here; `qbo-bank-register.ts` itself is
 * never imported for a value (only its `BankRegisterRow` type, above), which
 * would drag in Prisma/QBO and break this module's purity.
 */

// ── Inputs ──────────────────────────────────────────────────────────────────

export type PurchaseClassification = "job-cost" | "overhead" | "owner-draw" | "unknown";

/** QboPurchaseClassification row (plan §4 schema; §5 step 3 populates it). */
export interface RegisterMergeClassification {
    qbPurchaseId: string;
    classification: PurchaseClassification;
    reason: string | null;
}

/** A Prisma Decimal instance duck-types to this — has its own `toString()`
 * that renders the exact decimal value (no exponential notation). */
export interface DecimalLike {
    toString(): string;
}

/** Minimal Expense projection needed for the job-cost / amount edges. */
export interface RegisterMergeExpense {
    qbPurchaseId: string | null;
    /** Phase 3: the denormalized job. Optional so older callers still typecheck. */
    projectId?: string | null;
    project?: { id?: string | null; name: string | null } | null;
    /** Prisma Decimal arrives as a Decimal-like object, not a plain string —
     * accept the real shape, plus a plain string for tests and any
     * already-serialized callers. */
    amount: string | DecimalLike;
    receiptUrl: string | null;
    estimate: { project: { id: string; name: string } | null } | null;
}

/**
 * AutomationEvent projection needed for the receipt edge + orphan
 * classification. `qbPurchaseId` / `driveFileId` are the typed columns being
 * added in the parallel §1 rollout — treat as possibly-null on every row,
 * including rows created after this module ships (backfill runs in batches).
 */
export interface RegisterMergeReceiptEvent {
    kind: string;
    status: string;
    qbPurchaseId: string | null;
    driveFileId: string | null;
    /** 21-char Drive fileId prefix — legacy correlation key, collision-prone (qbo-receipt-push.ts:474-490). */
    docNumber: string | null;
    fileName: string | null;
    vendor: string | null;
    amountCents: number | null;
    reason: string | null;
    createdAt: Date | string;
}

// ── Edges (plan §1) ─────────────────────────────────────────────────────────

export type ReceiptEdge = "pass" | "unknown";
export type JobCostEdge = "pass" | "fail";
/** "indeterminate" = a job-cost match exists but the Expense amount could not
 * be parsed into exact cents (see `decimalToCents`) — never treated as a
 * pass, never silently reported as a mismatch. */
export type AmountEdge = "pass" | "fail" | "n/a" | "indeterminate";

export interface RegisterEdges {
    receipt: ReceiptEdge;
    /** True when the ONLY receipt evidence found was a docNumber-prefix fallback match — never upgrades to "pass". */
    receiptUnconfirmed: boolean;
    jobCost: JobCostEdge;
    amount: AmountEdge;
}

const RECEIPT_PASS_STATUSES = new Set(["created", "already-exists"]);

/**
 * Receipt edge: matched primarily by the typed `qbPurchaseId` column.
 * Absence of a match is NEVER "fail" — logAutomationEvent swallows insert
 * failures (automation-events.ts:61), so a missing event proves nothing.
 *
 * Legacy events written before the typed-column dual-write carry
 * `qbPurchaseId: null`. For those we may fall back to comparing the 21-char
 * docNumber prefix against the row's QBO DocNumber, but two different Drive
 * fileIds can share that prefix (qbo-receipt-push.ts:474-490,
 * automation-events.ts:280-308) — so a prefix hit is only ever "possible"
 * provenance and must stay "unknown", flagged `receiptUnconfirmed`.
 */
function computeReceiptEdge(
    row: BankRegisterRow,
    receiptEvents: RegisterMergeReceiptEvent[],
): { result: ReceiptEdge; unconfirmed: boolean } {
    if (!row.qbTxnId) return { result: "unknown", unconfirmed: false };

    const directHit = receiptEvents.some(e =>
        e.kind === "receipt-push" &&
        RECEIPT_PASS_STATUSES.has(e.status) &&
        e.qbPurchaseId !== null &&
        e.qbPurchaseId === row.qbTxnId
    );
    if (directHit) return { result: "pass", unconfirmed: false };

    if (row.docNum) {
        const prefixHit = receiptEvents.some(e =>
            e.kind === "receipt-push" &&
            RECEIPT_PASS_STATUSES.has(e.status) &&
            e.driveFileId === null &&
            e.docNumber !== null &&
            e.docNumber === row.docNum
        );
        if (prefixHit) return { result: "unknown", unconfirmed: true };
    }

    return { result: "unknown", unconfirmed: false };
}

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a Prisma Decimal-like money value into exact integer cents WITHOUT
 * ever going through a lossy float multiply. `Math.round(Number(x) * 100)`
 * is float-lossy — e.g. `Math.round(10.075 * 100) === 1007`, not the
 * mathematically-correct 1008, because `10.075 * 100` is not representable
 * exactly as a double. This parses the decimal STRING form directly: split
 * on the decimal point, take the integer and fractional parts as digit
 * strings, and combine them with BigInt arithmetic — no float multiplication
 * anywhere in the path.
 *
 * Fails closed (returns `null`) rather than ever risk a silent wrong number:
 * - more than 2 fractional digits (a fractional-cent value — money never has
 *   sub-cent precision at this layer; if this Prisma Decimal(10,2) ever
 *   somehow carries one, that is itself worth surfacing, not rounding away)
 * - not a finite, parseable plain-decimal value (NaN/Infinity, scientific
 *   notation, garbage strings)
 * - magnitude exceeds `Number.MAX_SAFE_INTEGER` cents
 *
 * Callers MUST treat `null` as indeterminate, never as a match or a
 * mismatch — see `AmountEdge`'s `"indeterminate"` value.
 */
export function decimalToCents(value: string | DecimalLike): number | null {
    // `number` is not an accepted input (see the TS signature above), but an
    // untyped/JS caller could still pass one — do NOT convert it. By the
    // time this function runs, JS has already lost precision on the number
    // literal (e.g. 1.99999999999999999 is rounded to 2 at parse time), so
    // there is no exact value left to recover here. Treat it as
    // indeterminate rather than laundering already-lost float precision into
    // "exact" cents.
    if (typeof value === "number") return null;

    let str: string;
    if (typeof value === "string") {
        str = value.trim();
    } else {
        try {
            str = String(value).trim();
        } catch {
            return null; // Decimal-like .toString() threw — indeterminate, not a crash.
        }
    }

    const match = DECIMAL_PATTERN.exec(str);
    if (!match) return null;

    const [, sign, intPart, fracPart = ""] = match;
    if (fracPart.length > 2) return null; // fractional cents — fail closed, never round away

    const paddedFrac = fracPart.padEnd(2, "0");
    const magnitude = BigInt(intPart) * BigInt(100) + BigInt(paddedFrac);
    const cents = sign === "-" ? -magnitude : magnitude;

    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (cents > maxSafe || cents < -maxSafe) return null;

    return Number(cents);
}

/**
 * Job-cost + amount edges. Job-cost is a straight existence check on
 * `Expense.qbPurchaseId` (@unique). Amount is only meaningful once a match
 * exists — cent-exact against the *negated* row amount, since ProBuild
 * expenses are stored positive and the register's purchase-type rows are
 * negative (money out). An unparseable expense amount never resolves to
 * "pass" or "fail" — see `decimalToCents`.
 */
function computeJobCostAndAmountEdge(
    row: BankRegisterRow,
    expenseByPurchaseId: Map<string, RegisterMergeExpense>,
): { jobCost: JobCostEdge; amount: AmountEdge; expense: RegisterMergeExpense | null } {
    const expense = row.qbTxnId ? expenseByPurchaseId.get(row.qbTxnId) ?? null : null;
    if (!expense) return { jobCost: "fail", amount: "n/a", expense: null };
    const expenseCents = decimalToCents(expense.amount);
    if (expenseCents === null) {
        return { jobCost: "pass", amount: "indeterminate", expense };
    }
    const amount: AmountEdge = expenseCents === -row.amountCents ? "pass" : "fail";
    return { jobCost: "pass", amount, expense };
}

// ── Status matrix (plan §2) ──────────────────────────────────────────────────

/**
 * - `documented` — STRICT: classification job-cost, receipt/jobCost/amount all "pass".
 * - `job-cost-matched` — classification job-cost, jobCost+amount "pass", receipt "unknown"
 *   (no receipt-push audit record — e.g. a paper receipt keyed straight into QuickBooks,
 *   which will never get an AutomationEvent). Kept in the denominator, excluded from
 *   `documented` and from the actionable needs-review queue; counted separately as
 *   `counts.receiptProvenanceUnverified`.
 * - `needs-review` — a real outflow that needs a human look: any unresolved edge, an
 *   unclassified purchase, a classification conflict (overhead/owner-draw that matches a
 *   job-costed expense), or an amount that couldn't be parsed.
 * - `not-applicable` — expected non-job spend or a non-purchase type that isn't spend.
 * - `unclassifiable` — zero-amount or unjoinable (null qbTxnId); not spend, excluded from the denominator.
 */
export type RegisterStatus = "documented" | "job-cost-matched" | "needs-review" | "not-applicable" | "unclassifiable";

export interface MergedRegisterRow extends BankRegisterRow {
    isPurchaseType: boolean;
    status: RegisterStatus;
    /** Short human-readable reason for the status, for the drill-down / row tooltip. */
    label: string;
    /** Only present for purchase-like rows with a non-null qbTxnId (plan §1 scope). */
    edges: RegisterEdges | null;
    classification: PurchaseClassification | null;
    classificationReason: string | null;
    /** True for status "not-applicable" rows that are overhead/owner-draw spend — counted as "expected non-job spend", not hidden. */
    expectedNonJobSpend: boolean;
    projectId: string | null;
    projectName: string | null;
    receiptUrl: string | null;
}

export interface RegisterMergeCounts {
    documented: number;
    /** Rows with status "job-cost-matched" — see that status's doc comment. Kept out of `documented` (strict: receipt+jobCost+amount all "pass") and out of `needsReview`; counted here instead so the UI can show/filter it as its own number. */
    receiptProvenanceUnverified: number;
    needsReview: number;
    notApplicable: number;
    unclassifiable: number;
    /** Subset of not-applicable: overhead/owner-draw classified spend. */
    expectedNonJobSpend: number;
    /** Subset of needs-review: purchase-like, non-null id, amount<0, no classification record (or explicitly "unknown"). */
    unknownClassification: number;
    /** Purchase-like, non-null id, amount<0, excluding overhead/owner-draw — EXCEPT when overhead/owner-draw contradicts a job-costed match ("classification conflict", counted in needsReview, not here). Denominator for "N of M job-costable spend rows". Includes "job-cost-matched" rows. */
    denominator: number;
}

export interface RegisterMergeResult {
    rows: MergedRegisterRow[];
    counts: RegisterMergeCounts;
}

/**
 * Merge a fetched bank register with ProBuild expenses, receipt-push audit
 * events, and purchase classifications into per-row statuses + roll-up
 * counts. Implements docs/UNIFIED-REGISTER-PLAN.md §2's status matrix
 * EXACTLY, row by row, in the order given there. The default for anything
 * not explicitly covered by the matrix is "needs-review" (surfacing a real
 * outflow), never a silent "not-applicable" — see the plan's framing for why
 * a prior catch-all design was rejected.
 */
export function mergeRegister(
    rows: BankRegisterRow[],
    expenses: RegisterMergeExpense[],
    receiptEvents: RegisterMergeReceiptEvent[],
    classifications: RegisterMergeClassification[],
): RegisterMergeResult {
    const expenseByPurchaseId = new Map<string, RegisterMergeExpense>();
    for (const e of expenses) {
        if (e.qbPurchaseId) expenseByPurchaseId.set(e.qbPurchaseId, e);
    }
    const classificationByPurchaseId = new Map(classifications.map(c => [c.qbPurchaseId, c]));

    const counts: RegisterMergeCounts = {
        documented: 0,
        receiptProvenanceUnverified: 0,
        needsReview: 0,
        notApplicable: 0,
        unclassifiable: 0,
        expectedNonJobSpend: 0,
        unknownClassification: 0,
        denominator: 0,
    };

    const merged: MergedRegisterRow[] = rows.map(row => {
        const isPurchaseTypeRow = isPurchaseType(row.qbType);

        let status: RegisterStatus;
        let label: string;
        let edges: RegisterEdges | null = null;
        let classification: PurchaseClassification | null = null;
        let classificationReason: string | null = null;
        let expectedNonJobSpend = false;
        let projectId: string | null = null;
        let projectName: string | null = null;
        let receiptUrl: string | null = null;
        let inDenominator = false;

        if (isPurchaseTypeRow && row.qbTxnId) {
            // Edges are in scope for every purchase-like row with an id
            // (plan §1), independent of amount sign or classification, so the
            // UI can render the 3 pips even on rows the matrix routes
            // elsewhere below (zero-amount, reversal, overhead, ...).
            const receiptResult = computeReceiptEdge(row, receiptEvents);
            const jc = computeJobCostAndAmountEdge(row, expenseByPurchaseId);
            edges = {
                receipt: receiptResult.result,
                receiptUnconfirmed: receiptResult.unconfirmed,
                jobCost: jc.jobCost,
                amount: jc.amount,
            };
            if (jc.expense) {
                // Resolved, not read off the estimate — a re-attributed expense
                // must be shown under the job it is actually on.
                ({ projectId, projectName } = resolveExpenseProjectLabel(jc.expense));
                receiptUrl = jc.expense.receiptUrl ?? null;
            }

            if (row.amountCents === 0) {
                status = "unclassifiable";
                label = "Zero-amount entry — not spend, excluded from denominator.";
            } else if (row.amountCents > 0) {
                status = "needs-review";
                label = "Money came back on a purchase-type entry (refund or reversal).";
            } else {
                // amountCents < 0 — classification decides before edges do:
                // overhead/owner-draw spend is expected to fail job-cost/receipt
                // edges (it's not meant to be job-costed) and must not be
                // dragged into needs-review because of that.
                const record = classificationByPurchaseId.get(row.qbTxnId);
                classification = record?.classification ?? "unknown";
                classificationReason = record?.reason ?? null;

                if (classification === "overhead" || classification === "owner-draw") {
                    if (edges.jobCost === "pass") {
                        // A matched Expense CONTRADICTS "non-job spend" — this
                        // is not the expected shape for overhead/owner-draw,
                        // it's a classification conflict that needs a human
                        // to resolve which side is wrong. Must not silently
                        // fall out of the denominator the way ordinary
                        // overhead does.
                        status = "needs-review";
                        label = classification === "overhead"
                            ? "Classification conflict — classified overhead but matches a job-costed expense."
                            : "Classification conflict — classified owner draw but matches a job-costed expense.";
                        inDenominator = true;
                    } else {
                        status = "not-applicable";
                        label = classification === "overhead"
                            ? "Overhead spend — expected non-job cost."
                            : "Owner draw — expected non-job cost.";
                        expectedNonJobSpend = true;
                    }
                } else if (classification === "unknown") {
                    status = "needs-review";
                    label = "Unclassified purchase — never auto-documented, never hidden.";
                    inDenominator = true;
                    counts.unknownClassification += 1;
                } else {
                    // classification === "job-cost"
                    inDenominator = true;
                    const allPass = edges.receipt === "pass" && edges.jobCost === "pass" && edges.amount === "pass";
                    const jobCostAndAmountConfirmedNoReceiptRecord =
                        edges.receipt === "unknown" && edges.jobCost === "pass" && edges.amount === "pass";
                    if (allPass) {
                        status = "documented";
                        label = "Documented — receipt, job cost, and amount all confirmed.";
                    } else if (edges.jobCost === "pass" && edges.amount === "indeterminate") {
                        // Never let an unparseable amount become a silent
                        // "fail" or, worse, a "pass" — see decimalToCents.
                        status = "needs-review";
                        label = "Needs review — expense amount could not be parsed as an exact cent value.";
                    } else if (jobCostAndAmountConfirmedNoReceiptRecord) {
                        // Job cost + amount both confirmed but no receipt-push
                        // audit record — expected for expenses keyed straight
                        // into QuickBooks with a paper receipt, which never
                        // pass through ProBuild's receipt-push pipeline and so
                        // will NEVER get an AutomationEvent. Keep it out of
                        // the actionable needs-review queue permanently, but
                        // don't count it as fully "documented" either — track
                        // it as its own visible number (plan follow-up).
                        status = "job-cost-matched";
                        label = "Job cost and amount confirmed — no receipt-push audit record (likely a paper receipt entered directly in QuickBooks).";
                    } else {
                        status = "needs-review";
                        const missing: string[] = [];
                        if (edges.receipt !== "pass") missing.push("receipt");
                        if (edges.jobCost !== "pass") missing.push("job cost");
                        if (edges.jobCost === "pass" && edges.amount !== "pass") missing.push("amount match");
                        label = `Needs review — ${missing.join(", ")} unresolved.`;
                    }
                }
            }
        } else if (isPurchaseTypeRow) {
            // null qbTxnId: the GL report didn't link this row to an entity —
            // can't join to Expense or an audit event at all.
            status = "unclassifiable";
            label = "No QuickBooks transaction id on this row — cannot join or alert.";
        } else if (isMoneyInType(row.qbType)) {
            if (row.amountCents > 0) {
                status = "not-applicable";
                label = "Money in.";
            } else if (row.amountCents < 0) {
                status = "needs-review";
                label = "Sign/type conflict — a money-in type posted as an outflow.";
            } else {
                // Not in the plan's matrix (only >0/<0 are listed for known
                // money-in types); treated the same as every other
                // zero-dollar row — no money moved, nothing to review.
                status = "unclassifiable";
                label = "Zero-amount entry — not spend.";
            }
        } else if (row.qbType === "Transfer") {
            status = "not-applicable";
            label = "Transfer.";
        } else if (row.qbType === "Journal Entry") {
            status = "not-applicable";
            label = "Journal entry.";
        } else if (/tax payment/i.test(row.qbType)) {
            status = "not-applicable";
            label = "Tax payment.";
        } else if (/bill payment/i.test(row.qbType)) {
            status = "not-applicable";
            label = "Bill payment.";
        } else {
            // Refund Receipt, or any unrecognized "other" type. Sign decides,
            // never the label alone (mirrors qbo-bank-register.ts:292-295).
            if (row.amountCents < 0) {
                status = "needs-review";
                label = row.qbType === "Refund Receipt"
                    ? "Refund receipt — unrecognized outflow."
                    : "Unrecognized transaction type posted as an outflow.";
            } else if (row.amountCents > 0) {
                status = "not-applicable";
                label = "Money in.";
            } else {
                // Not in the plan's matrix; see the money-in zero-dollar note above.
                status = "unclassifiable";
                label = "Zero-amount entry — not spend.";
            }
        }

        switch (status) {
            case "documented": counts.documented += 1; break;
            case "job-cost-matched": counts.receiptProvenanceUnverified += 1; break;
            case "needs-review": counts.needsReview += 1; break;
            case "not-applicable": counts.notApplicable += 1; break;
            case "unclassifiable": counts.unclassifiable += 1; break;
        }
        if (expectedNonJobSpend) counts.expectedNonJobSpend += 1;
        if (inDenominator) counts.denominator += 1;

        return {
            ...row,
            isPurchaseType: isPurchaseTypeRow,
            status,
            label,
            edges,
            classification,
            classificationReason,
            expectedNonJobSpend,
            projectId,
            projectName,
            receiptUrl,
        };
    });

    return { rows: merged, counts };
}

// ── Orphan receipts — three-valued (plan §1) ────────────────────────────────

export type OrphanClassification = "reconciled" | "exception" | "unknown";

/** Status values (from receipt-stage / receipt-push events) that represent a terminal, actionable failure to book. */
const EXCEPTION_STATUSES = new Set(["parked", "quarantined", "error", "emailed"]);

export interface OrphanReceipt {
    /** driveFileId when known, else the 21-char docNumber prefix. */
    key: string;
    /** True when grouped only via the docNumber-prefix fallback (no driveFileId ever observed) — collision-prone, never promoted to "exception". */
    unconfirmed: boolean;
    classification: OrphanClassification;
    finalStatus: string | null;
    fileName: string | null;
    vendor: string | null;
    amountCents: number | null;
    reason: string | null;
    qbPurchaseId: string | null;
    lastSeen: string;
}

/**
 * Group receipt-push/receipt-stage events into per-receipt journeys and
 * classify each as reconciled / exception / unknown. `unknown` (no audit
 * evidence either way) is NEVER counted as orphaned — only `exception`
 * belongs in an actionable list (plan §1).
 *
 * Grouping key is the full `driveFileId` when any event in the journey has
 * one. Legacy events without a `driveFileId` group by the 21-char
 * `docNumber` prefix instead, but that grouping is collision-prone
 * (qbo-receipt-push.ts:474-490) so it is flagged `unconfirmed` and can only
 * ever resolve to "reconciled" (via a qbPurchaseId hit) or "unknown" — never
 * "exception", which requires the FULL id per the plan.
 */
export function classifyOrphanReceipts(
    receiptEvents: RegisterMergeReceiptEvent[],
    rows: BankRegisterRow[],
): OrphanReceipt[] {
    const registerPurchaseIds = new Set(
        rows
            .filter(r => isPurchaseType(r.qbType) && r.qbTxnId)
            .map(r => r.qbTxnId as string)
    );

    interface Group {
        key: string;
        unconfirmed: boolean;
        events: RegisterMergeReceiptEvent[];
    }
    const groups = new Map<string, Group>();

    for (const e of receiptEvents) {
        let key: string;
        let unconfirmed: boolean;
        if (e.driveFileId) {
            key = `id:${e.driveFileId}`;
            unconfirmed = false;
        } else if (e.docNumber) {
            key = `prefix:${e.docNumber}`;
            unconfirmed = true;
        } else {
            // No correlation key at all on this event — nothing to attach it to.
            continue;
        }
        let group = groups.get(key);
        if (!group) {
            group = { key, unconfirmed, events: [] };
            groups.set(key, group);
        }
        group.events.push(e);
    }

    const results: OrphanReceipt[] = [];
    for (const group of groups.values()) {
        const sorted = [...group.events].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        const last = sorted[sorted.length - 1];

        // Latest non-null value per field wins, same convention as
        // automation-events.ts's receiptJourneys() grouping.
        let qbPurchaseId: string | null = null;
        let fileName: string | null = null;
        let vendor: string | null = null;
        let amountCents: number | null = null;
        for (const e of sorted) {
            if (e.qbPurchaseId !== null) qbPurchaseId = e.qbPurchaseId;
            if (e.fileName !== null) fileName = e.fileName;
            if (e.vendor !== null) vendor = e.vendor;
            if (e.amountCents !== null) amountCents = e.amountCents;
        }

        let classification: OrphanClassification;
        if (qbPurchaseId && registerPurchaseIds.has(qbPurchaseId)) {
            classification = "reconciled";
        } else if (!group.unconfirmed && EXCEPTION_STATUSES.has(last.status)) {
            classification = "exception";
        } else {
            classification = "unknown";
        }

        results.push({
            key: group.key,
            unconfirmed: group.unconfirmed,
            classification,
            finalStatus: last.status,
            fileName,
            vendor,
            amountCents,
            reason: last.reason,
            qbPurchaseId,
            lastSeen: new Date(last.createdAt).toISOString(),
        });
    }

    return results;
}

/** The actionable orphan list (plan §1): exceptions only, newest first. */
export function actionableOrphanReceipts(orphans: OrphanReceipt[]): OrphanReceipt[] {
    return orphans
        .filter(o => o.classification === "exception")
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}
