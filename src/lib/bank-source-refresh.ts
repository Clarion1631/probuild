import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizePayee } from "@/lib/bank-ledger";
import { BANK_REGISTER_ACCOUNT, registerRowToIngestLine } from "@/lib/bank-register-pull";
import { bumpBankLedgerEpoch } from "@/lib/bank-ledger-epoch";
import { lockReceiptEvidence } from "@/lib/receipt-evidence-lock";
import { lockQboExpense } from "@/lib/qbo-expense-sync";
import { lockExpense } from "@/lib/expense-lock";
import { lockBankLineIdentity } from "@/lib/bank-reconcile-guard";
import { lockAttributionParents } from "@/lib/phase-invariant";
import { projectPurchase, type PurchaseProjection } from "@/app/api/integrations/bank-ledger/conflict-diagnostic/route";
import type { BankRegisterResult, BankRegisterRow } from "@/lib/qbo-bank-register";

/**
 * QBO SOURCE REFRESH — date/descriptor of ONE stored QBO_REGISTER observation
 * brought up to what QuickBooks says NOW, dry-run first.
 *
 * The nightly pull refuses (409) a qbTxnId whose content changed, which is
 * right for money and wrong forever for a date QuickBooks corrected or a
 * descriptor a historical adapter wrote as "<Vendor> Expense". This is the
 * explicit, reviewed path for exactly those two fields, and nothing else:
 *
 *   - money, check number and account must be UNCHANGED; stored clearance is
 *     preserved and CAS-checked, while the ordinary pull refreshes it;
 *   - the observation must be the sole, UNLINKED row for the id with NO
 *     canonical BankLine by qbTxnId and NO ReceiptIntake by either purchase id;
 *     at most ONE Expense may carry the qbPurchaseId, and only when it provably
 *     matches the authenticated Purchase (exact id, gross cents, date, SyncToken,
 *     vendor name) — it is read under its advisory lock and NEVER mutated;
 *     the ONE exception to the gross-cents match is a RETIRED Expense: literal
 *     zero amount, the importer's exact "Removed in QBO (no-active-project)"
 *     marker, Reviewed, full tax classification retired, on a job whose status
 *     is literally "Closed Complete" with its estimate/item attribution intact
 *     (project/estimate/item rows read and matched by id). That case is
 *     descriptor-only (the stored date must already equal the Purchase
 *     TxnDate), is flagged with `retired-expense-zero-preserved`, and the
 *     applier share-locks Project -> Estimate -> EstimateItem before the bank
 *     and Expense locks, refusing if the parent tuple moved meanwhile;
 *   - the live register row must be a single Expense whose Purchase entity
 *     (read directly, id + bank AccountRef verified) agrees with it on date,
 *     amount and vendor name.
 *
 * Descriptor acceptance is EXPLICIT REVIEWED SOURCE-VERSION ACCEPTANCE, basis
 * `reviewed-current-source`. Where the old descriptor is the legacy
 * "<Vendor> Expense" shape the response warns that field history is missing:
 * probuild keeps no per-field revision history, so the old vendor id is NOT
 * proven, only that the current source names the same vendor.
 *
 * Apply requires the digest a successful dry-run returned; the digest covers
 * the policy version, the id, the full old snapshot, the direct Purchase
 * projection with SyncToken and MetaData timestamps (source version fields),
 * the converter outputs and the DB evidence, and deliberately EXCLUDES only
 * the request's fetchedAt. Every DB
 * read is redone under the fence before writing; the body's dates/money/
 * version are never trusted. Unchanged current state is a noop, with no audit,
 * even when a stale token is supplied.
 */

export const SOURCE_REFRESH_POLICY_VERSION = "qbo-source-refresh/2";
export const SOURCE_REFRESH_ACCOUNT = BANK_REGISTER_ACCOUNT;
export const SOURCE_REFRESH_SOURCE = "QBO_REGISTER";
export const SOURCE_REFRESH_BASIS = "reviewed-current-source";
export const SOURCE_REFRESH_AUDIT_ACTION = "QBO_SOURCE_REFRESH";
export const HISTORY_MISSING_WARNING = "historical-field-history-missing";
/** Warning carried by a plan whose single Expense is a retired zero row, preserved as-is. */
export const RETIRED_EXPENSE_WARNING = "retired-expense-zero-preserved";
/** The importer's exact retirement marker (deactivateQboExpense, reason `no-active-project`). */
export const RETIRED_EXPENSE_DESCRIPTION = "[QuickBooks import] Removed in QBO (no-active-project)";
export const RETIRED_EXPENSE_STATUS = "Reviewed";
/** Literal project status required; `isActive` or "not In Progress" are NOT accepted. */
export const RETIRED_PROJECT_STATUS = "Closed Complete";
export const RETIREMENT_RACE_REASON = "retirement-attribution-race";
export const MAX_REFRESH_ITEMS = 3;
export const MAX_REFRESH_BODY_BYTES = 8 * 1024;
/** Overall wall clock for one request; register (<=30s) plus three Purchase reads (10s each) fits under maxDuration 120. */
export const REFRESH_OVERALL_DEADLINE_MS = 90_000;
/** No external call happens while locks are held, so the apply transaction is short. */
export const REFRESH_TX_TIMEOUT_MS = 15_000;
const EVIDENCE_TAKE = 2;
const QB_TXN_ID = /^\d{1,20}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DECIMAL_AMOUNT = /^(\d{1,15})(?:\.(\d{1,2}))?$/;
/** Literal zero only: "0", "0.0" or "0.00". Anything else is not a retired amount. */
const ZERO_AMOUNT = /^0(?:\.00?)?$/;

/** A real calendar day: Date.parse accepts Feb 30, so round-trip through UTC and compare. */
export function isCalendarDay(day: string): boolean {
    if (!YMD.test(day)) return false;
    const ms = Date.parse(`${day}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** ISO-8601 timestamp with explicit zone whose calendar part round-trips. */
export function isIsoTimestamp(value: string): boolean {
    const match = ISO_TS.exec(value);
    return match !== null && isCalendarDay(match[1]) && !Number.isNaN(Date.parse(value));
}

/** Strict decimal string → positive safe integer cents. Rejects blank, sign, exponent, garbage and sub-cent precision. */
export function parseDecimalCents(amount: string): number | null {
    const match = DECIMAL_AMOUNT.exec(amount);
    if (!match) return null;
    const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export interface ObservationSnapshot {
    id: string;
    postedDate: string;
    rawDescriptor: string;
    amountCents: number;
    checkNumber: string | null;
    createdAt: string;
    clearedStatus: string | null;
    bankLineId: string | null;
}
export interface CanonicalLineEvidence { id: string; account: string; postedDate: string; amountCents: number; state: string; sourceOfRecord: string; probuildExpenseId: string | null }
/**
 * Retirement and attribution facts of an Expense, read with the evidence. Every
 * field is a literal DB value (Decimals as strings) so the digest and audit
 * carry exactly what was proven. Absent on old fixtures: a positive Expense
 * never needs it, a ZERO Expense without it is always rejected.
 */
export interface ExpenseRetirementEvidence {
    description: string | null;
    status: string | null;
    taxAmount: string | null;
    taxSource: string | null;
    installedAtCustomer: boolean | null;
    taxDeductibleBase: string | null;
    taxDeductibleBaseSource: string | null;
    taxAtSource: boolean;
    needsTaxReview: boolean;
    projectId: string | null;
    estimateId: string | null;
    itemId: string | null;
    project: { id: string; status: string | null } | null;
    estimate: { id: string; projectId: string | null } | null;
    item: { id: string; estimateId: string | null } | null;
}
export interface ExpenseEvidence { id: string; qbPurchaseId: string | null; date: string | null; amount: string; qbSyncToken: string | null; vendor: string | null; retirement?: ExpenseRetirementEvidence }

/** Only a LITERAL zero ("0", "0.0", "0.00") is a candidate for the retired-Expense exception. */
export function isRetiredZeroAmount(amount: string): boolean {
    return ZERO_AMOUNT.test(amount);
}

/**
 * PURE. Why a zero Expense is NOT a provably retired one, or null when it is.
 * Requires the importer's exact marker, Reviewed, the full retired tax tuple,
 * an explicit project that exists with the literal "Closed Complete" status,
 * and any named estimate/item to exist and chain back to that same project.
 */
export function retiredExpenseRejection(expense: ExpenseEvidence): string | null {
    const r = expense.retirement;
    if (r === undefined || r === null) return "expense-retirement-metadata-missing";
    if (r.description !== RETIRED_EXPENSE_DESCRIPTION) return "expense-retirement-marker-mismatch";
    if (r.status !== RETIRED_EXPENSE_STATUS) return "expense-retirement-status-mismatch";
    const taxRetired = r.taxAmount === null && r.taxSource === null && r.installedAtCustomer === null
        && r.taxDeductibleBase === null && r.taxDeductibleBaseSource === null && r.taxAtSource === false && r.needsTaxReview === false;
    if (!taxRetired) return "expense-retirement-tax-not-retired";
    if (r.projectId === null || r.projectId === "") return "expense-retirement-project-missing";
    if (r.project === null || r.project.id !== r.projectId) return "expense-retirement-project-missing";
    if (r.project.status !== RETIRED_PROJECT_STATUS) return "expense-retirement-project-active";
    if (r.estimateId !== null) {
        if (r.estimate === null || r.estimate.id !== r.estimateId) return "expense-retirement-estimate-missing";
        if (r.estimate.projectId !== r.projectId) return "expense-retirement-estimate-project-mismatch";
    } else if (r.estimate !== null) {
        return "expense-retirement-estimate-inconsistent";
    }
    if (r.itemId !== null) {
        if (r.item === null || r.item.id !== r.itemId) return "expense-retirement-item-missing";
        if (r.item.estimateId !== r.estimateId) return "expense-retirement-item-estimate-mismatch";
    } else if (r.item !== null) {
        return "expense-retirement-item-inconsistent";
    }
    return null;
}

function cloneRetirement(r: ExpenseRetirementEvidence): ExpenseRetirementEvidence {
    return { ...r, project: r.project ? { ...r.project } : null, estimate: r.estimate ? { ...r.estimate } : null, item: r.item ? { ...r.item } : null };
}
export interface IntakeEvidence { id: string; state: string; expenseId: string | null }
export interface RefreshEvidence {
    observations: ObservationSnapshot[];
    bankLines: CanonicalLineEvidence[];
    expenses: ExpenseEvidence[];
    intakes: IntakeEvidence[];
}

export interface RefreshTarget { postedDate: string; rawDescriptor: string }

export interface PurchaseDigestFields {
    Id: string;
    TxnDate: string | null;
    TotalAmt: number | null;
    EntityRef: { name: string | null; value: string | null } | null;
    AccountRef: { name: string | null; value: string | null } | null;
    DocNumber: string | null;
    PrivateNote: string | null;
    SyncToken: string | null;
    CreateTime: string;
    LastUpdatedTime: string;
}

export interface RefreshPlan {
    qbTxnId: string;
    old: ObservationSnapshot;
    next: RefreshTarget;
    basis: typeof SOURCE_REFRESH_BASIS;
    warnings: string[];
    digest: string;
    purchase: PurchaseDigestFields;
    purchaseLastUpdated: string;
    /** Full allowlisted DB evidence the digest covers; preserved verbatim in the audit as before/after proof. */
    localEvidence: EvidenceSummary;
    registerRow: { date: string; qbType: string; name: string | null; memo: string | null; docNum: string | null; amountCents: number; clearedStatus: string | null };
}

/** Bounded, allowlisted snapshots of the local evidence a reviewer needs (no notes, no files, no extra PII). */
export type EvidenceSummary = RefreshEvidence & {
    sourcePurchase?: PurchaseProjection;
    sourceRegister?: BankRegisterRow;
};

export type PlanOutcome =
    | { status: "blocked"; reason: string; evidence: EvidenceSummary }
    | { status: "noop"; reason: string; evidence: EvidenceSummary }
    | { status: "eligible"; plan: RefreshPlan; evidence: EvidenceSummary };

export type RefreshItemResult = { qbTxnId: string } & (
    | { status: "blocked"; reason: string; evidence?: EvidenceSummary }
    | { status: "noop"; reason: string }
    | { status: "eligible"; plan: RefreshPlan; evidence: EvidenceSummary }
    | { status: "applied"; plan: RefreshPlan; auditAction: string }
    | { status: "not-attempted"; reason: "deadline" }
    | { status: "failed"; reason: "item-failed" }
);

export type RefreshMode = "dry-run" | "apply";
export interface RefreshItemRequest { qbTxnId: string; expectedDigest: string | null }

export function summarizeEvidence(evidence: RefreshEvidence): EvidenceSummary {
    return {
        observations: evidence.observations.map(o => ({ id: o.id, postedDate: o.postedDate, rawDescriptor: o.rawDescriptor, amountCents: o.amountCents, checkNumber: o.checkNumber, createdAt: o.createdAt, clearedStatus: o.clearedStatus, bankLineId: o.bankLineId })),
        bankLines: evidence.bankLines.map(l => ({ id: l.id, account: l.account, postedDate: l.postedDate, amountCents: l.amountCents, state: l.state, sourceOfRecord: l.sourceOfRecord, probuildExpenseId: l.probuildExpenseId })),
        expenses: evidence.expenses.map(e => ({ id: e.id, qbPurchaseId: e.qbPurchaseId, date: e.date, amount: e.amount, qbSyncToken: e.qbSyncToken, vendor: e.vendor, ...(e.retirement === undefined ? {} : { retirement: cloneRetirement(e.retirement) }) })),
        intakes: evidence.intakes.map(i => ({ id: i.id, state: i.state, expenseId: i.expenseId })),
    };
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
        const source = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(source).sort().map(key => [key, canonical(source[key])]));
    }
    return value;
}

export function computeRefreshDigest(input: unknown): string {
    return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

/** TotalAmt → positive safe integer cents, or null when it is not exactly representable. */
export function toSafeCents(total: number | null): number | null {
    if (total === null || !Number.isFinite(total) || total <= 0) return null;
    const cents = Math.round(total * 100);
    if (!Number.isSafeInteger(cents) || Math.abs(total * 100 - cents) > 1e-6) return null;
    return cents;
}

export type RegisterPick = { ok: true; row: BankRegisterRow } | { ok: false; reason: string };

/** Exactly one Expense row for the id from a fresh, probe-verified register. Check is unsupported in this minimal class. */
export function pickRegisterRow(register: BankRegisterResult, qbTxnId: string): RegisterPick {
    if (register.stale) return { ok: false, reason: "register-stale" };
    if (!register.clearedProbeOk) return { ok: false, reason: "register-probe-failed" };
    const rows = register.rows.filter(row => row.qbTxnId === qbTxnId);
    if (rows.length === 0) return { ok: false, reason: "register-row-missing" };
    if (rows.length > 1) return { ok: false, reason: "register-row-split" };
    if (rows[0].qbType !== "Expense") return { ok: false, reason: "unsupported-type" };
    return { ok: true, row: rows[0] };
}

export interface PlanInput {
    qbTxnId: string;
    evidence: RefreshEvidence;
    register: BankRegisterResult;
    /** Raw Purchase from the direct GET, or null when it could not be read. */
    purchaseRaw: unknown;
}

/** PURE. Every acceptance rule in one place, in the order the failures are cheapest to explain. */
export function planSourceRefresh(input: PlanInput): PlanOutcome {
    const { qbTxnId, evidence, register } = input;
    const summary = summarizeEvidence(evidence);
    const blocked = (reason: string): PlanOutcome => ({ status: "blocked", reason, evidence: summary });

    const picked = pickRegisterRow(register, qbTxnId);
    if (!picked.ok) return blocked(picked.reason);
    const row = picked.row;

    if (evidence.observations.length === 0) return blocked("observation-missing");
    if (evidence.observations.length > 1) return blocked("observation-duplicate");
    const old = evidence.observations[0];
    if (old.bankLineId !== null) return blocked("observation-linked");
    if (evidence.bankLines.length > 0) return blocked("canonical-line-exists");
    if (evidence.expenses.length > 1) return blocked("expense-multiple");
    if (evidence.intakes.length > 0) return blocked("receipt-intake-linked");

    if (input.purchaseRaw === null || input.purchaseRaw === undefined || typeof input.purchaseRaw !== "object") return blocked("purchase-unavailable");
    // Projection drops Credit and status; refuse a credit or a deleted Purchase before it is projected away.
    const raw = input.purchaseRaw as Record<string, unknown>;
    if (raw.Credit === true) return blocked("purchase-is-credit");
    if (typeof raw.status === "string" && raw.status.toLowerCase() === "deleted") return blocked("purchase-deleted");
    const projected = projectPurchase(input.purchaseRaw, qbTxnId, register.accountId);
    if (projected.status !== "ok") return blocked(projected.status === "mismatch" ? "purchase-identity-mismatch" : "purchase-unavailable");
    const purchase = projected.purchase;
    summary.sourcePurchase = purchase;
    summary.sourceRegister = row;
    if (!purchase.SyncToken || !purchase.MetaData?.CreateTime || !purchase.MetaData?.LastUpdatedTime) return blocked("purchase-metadata-missing");
    if (!isIsoTimestamp(purchase.MetaData.CreateTime) || !isIsoTimestamp(purchase.MetaData.LastUpdatedTime)) return blocked("timestamp-invalid");

    if (!isCalendarDay(row.date)) return blocked("register-date-invalid");
    if (purchase.TxnDate !== row.date) return blocked("purchase-date-mismatch");
    if ((purchase.DocNumber ?? "").trim() !== (row.docNum ?? "").trim()) return blocked("purchase-doc-number-mismatch");
    // This narrow class requires the GL descriptor source to agree with the
    // directly-read version; line-description alternatives remain review holds.
    if ((purchase.PrivateNote ?? "").trim() !== (row.memo ?? "").trim()) return blocked("purchase-memo-mismatch");

    const cents = toSafeCents(purchase.TotalAmt);
    if (cents === null) return blocked("purchase-amount-invalid");
    if (row.amountCents !== -cents) return blocked("purchase-amount-mismatch");
    if (old.amountCents !== row.amountCents) return blocked("amount-changed");
    if (old.checkNumber !== null) return blocked("check-number-unsupported");

    const line = registerRowToIngestLine(row);
    if (!line) return blocked("register-descriptor-empty");
    if (line.rawDescriptor.length > 500) return blocked("register-descriptor-too-long");
    if (line.checkNumber !== null) return blocked("check-number-changed");

    const vendor = (purchase.EntityRef?.name ?? "").trim();
    if (vendor === "") return blocked("purchase-entity-missing");
    if ((row.name ?? "").trim() !== vendor) return blocked("gl-entity-mismatch");

    // Exactly one Expense is permitted, and only when it provably IS the current authenticated Purchase. Never mutated.
    // A literal-zero RETIRED Expense is the one exception to the cents match; every other check still applies.
    let retiredExpenseZero = false;
    const expense = evidence.expenses[0] ?? null;
    if (expense !== null) {
        if (expense.qbPurchaseId !== qbTxnId) return blocked("expense-purchase-id-mismatch");
        if (expense.date === null) return blocked("expense-date-missing");
        if (expense.date !== purchase.TxnDate) return blocked("expense-date-mismatch");
        retiredExpenseZero = isRetiredZeroAmount(expense.amount);
        if (!retiredExpenseZero) {
            const expenseCents = parseDecimalCents(expense.amount);
            if (expenseCents === null) return blocked("expense-amount-malformed");
            if (expenseCents !== cents) return blocked("expense-amount-mismatch");
        }
        if (expense.qbSyncToken === null) return blocked("expense-sync-token-missing");
        if (expense.qbSyncToken !== purchase.SyncToken) return blocked("expense-sync-token-stale");
        if (expense.vendor === null || expense.vendor.trim() === "") return blocked("expense-vendor-missing");
        if (expense.vendor.trim() !== vendor) return blocked("expense-vendor-mismatch");
        if (retiredExpenseZero) {
            const rejection = retiredExpenseRejection(expense);
            if (rejection !== null) return blocked(rejection);
        }
    }

    const oldPayee = normalizePayee(old.rawDescriptor);
    const newPayee = normalizePayee(line.rawDescriptor);
    const samePayee = oldPayee !== "" && oldPayee === newPayee;
    const legacyExact = old.rawDescriptor === `${vendor} Expense`;
    const legacyNormalized = oldPayee !== "" && oldPayee === normalizePayee(vendor);
    if (!samePayee && !legacyExact && !legacyNormalized) return blocked("descriptor-unsupported");
    const warnings: string[] = [];
    if (!samePayee) warnings.push(HISTORY_MISSING_WARNING);
    if (retiredExpenseZero) warnings.push(RETIRED_EXPENSE_WARNING);

    const next: RefreshTarget = { postedDate: line.postedDate, rawDescriptor: line.rawDescriptor };
    if (next.postedDate === old.postedDate && next.rawDescriptor === old.rawDescriptor) {
        return { status: "noop", reason: "unchanged", evidence: summary };
    }
    if (next.postedDate !== old.postedDate) {
        // The retired exception is descriptor-only: the stored date must already be the Purchase TxnDate.
        if (retiredExpenseZero) return blocked("retired-expense-date-change");
        const lastUpdated = Date.parse(purchase.MetaData.LastUpdatedTime);
        const createdAt = Date.parse(old.createdAt);
        if (Number.isNaN(createdAt)) return blocked("timestamp-invalid");
        if (lastUpdated < createdAt) return blocked("source-update-precedes-observation");
    }

    const purchaseFields: PurchaseDigestFields = {
        Id: purchase.Id,
        TxnDate: purchase.TxnDate,
        TotalAmt: purchase.TotalAmt,
        EntityRef: purchase.EntityRef,
        AccountRef: purchase.AccountRef,
        DocNumber: purchase.DocNumber,
        PrivateNote: purchase.PrivateNote,
        SyncToken: purchase.SyncToken,
        CreateTime: purchase.MetaData.CreateTime,
        LastUpdatedTime: purchase.MetaData.LastUpdatedTime,
    };
    const digest = computeRefreshDigest({
        policyVersion: SOURCE_REFRESH_POLICY_VERSION,
        qbTxnId,
        old,
        purchase: purchaseFields,
        register: { accountId: register.accountId, row },
        next,
        evidence: { bankLines: evidence.bankLines, expenses: evidence.expenses, intakes: evidence.intakes },
    });
    return {
        status: "eligible",
        evidence: summary,
        plan: {
            qbTxnId,
            old,
            next,
            basis: SOURCE_REFRESH_BASIS,
            warnings,
            digest,
            purchase: purchaseFields,
            purchaseLastUpdated: purchase.MetaData.LastUpdatedTime,
            localEvidence: summary,
            registerRow: { date: row.date, qbType: row.qbType, name: row.name, memo: row.memo, docNum: row.docNum, amountCents: row.amountCents, clearedStatus: row.clearedStatus ?? null },
        },
    };
}

/** Body read with the cap enforced on Content-Length AND on the stream, before any allocation past 8KB. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; reason: "body-too-large" | "missing-body" }> {
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return { ok: false, reason: "body-too-large" };
    if (!request.body) return { ok: false, reason: "missing-body" };
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, reason: "body-too-large" };
        }
        chunks.push(value);
    }
    return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

export type ParsedRefreshBody = { ok: true; mode: RefreshMode; items: RefreshItemRequest[] } | { ok: false; reason: string; field?: string };

export function parseRefreshBody(text: string): ParsedRefreshBody {
    if (!text.trim()) return { ok: false, reason: "missing-body" };
    let value: unknown;
    try { value = JSON.parse(text); } catch { return { ok: false, reason: "invalid-json" }; }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid-body" };
    const body = value as Record<string, unknown>;
    const unknown = Object.keys(body).find(key => key !== "mode" && key !== "items");
    if (unknown) return { ok: false, reason: "unknown-field", field: unknown };
    const mode: RefreshMode = body.mode === undefined ? "dry-run" : body.mode === "apply" ? "apply" : body.mode === "dry-run" ? "dry-run" : "apply";
    if (body.mode !== undefined && body.mode !== "apply" && body.mode !== "dry-run") return { ok: false, reason: "invalid-mode" };
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_REFRESH_ITEMS) return { ok: false, reason: "invalid-items" };
    const items: RefreshItemRequest[] = [];
    const seen = new Set<string>();
    for (const raw of body.items) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalid-item" };
        const item = raw as Record<string, unknown>;
        const bad = Object.keys(item).find(key => key !== "qbTxnId" && key !== "expectedDigest");
        if (bad) return { ok: false, reason: "unknown-field", field: bad };
        if (typeof item.qbTxnId !== "string" || !QB_TXN_ID.test(item.qbTxnId)) return { ok: false, reason: "invalid-qb-txn-id" };
        if (seen.has(item.qbTxnId)) return { ok: false, reason: "duplicate-qb-txn-id" };
        seen.add(item.qbTxnId);
        let expectedDigest: string | null = null;
        if (item.expectedDigest !== undefined) {
            if (typeof item.expectedDigest !== "string" || !DIGEST.test(item.expectedDigest)) return { ok: false, reason: "invalid-digest" };
            expectedDigest = item.expectedDigest;
        }
        if (mode === "apply" && expectedDigest === null) return { ok: false, reason: "missing-digest" };
        items.push({ qbTxnId: item.qbTxnId, expectedDigest });
    }
    return { ok: true, mode, items };
}

/** What the apply body may do under the fence: DB evidence only, no external calls. */
export interface RefreshApplyContext {
    readEvidence(): Promise<RefreshEvidence>;
    bumpEpoch(): Promise<void>;
    /** CAS on the FULL old content (clearance included); returns the matched row count. */
    updateObservation(old: ObservationSnapshot, next: RefreshTarget): Promise<number>;
    appendAudit(entityId: string, snapshot: Record<string, unknown>): Promise<void>;
}

/** Thrown inside the apply body to roll the transaction back and surface `result` instead. */
export class SourceRefreshRollback extends Error {
    constructor(public readonly result: RefreshItemResult) {
        super("source-refresh-rollback");
    }
}

export interface BankSourceRefreshDependencies {
    authorize(request: Request): boolean;
    readRegister(): Promise<BankRegisterResult>;
    readPurchase(qbTxnId: string): Promise<unknown>;
    /** Read-only, outside any transaction: the dry-run's evidence. */
    readEvidence(qbTxnId: string): Promise<RefreshEvidence>;
    /** Runs `body` in one transaction after taking the locks in order; returns the body's result or a rollback's result. */
    apply(qbTxnId: string, body: (ctx: RefreshApplyContext) => Promise<RefreshItemResult>, budgetMs?: number): Promise<RefreshItemResult>;
    now?: () => number;
}

function json(body: unknown, status: number): Response {
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function buildAuditSnapshot(plan: RefreshPlan, fetchedAt: string): Record<string, unknown> {
    return JSON.parse(JSON.stringify({
        policyVersion: SOURCE_REFRESH_POLICY_VERSION,
        basis: plan.basis,
        qbTxnId: plan.qbTxnId,
        account: SOURCE_REFRESH_ACCOUNT,
        source: SOURCE_REFRESH_SOURCE,
        old: plan.old,
        new: plan.next,
        sourceRegisterRow: plan.registerRow,
        sourcePurchase: plan.purchase,
        localEvidence: plan.localEvidence,
        warnings: plan.warnings,
        fetchedAt,
        digest: plan.digest,
    })) as Record<string, unknown>;
}

function toItem(qbTxnId: string, outcome: PlanOutcome): RefreshItemResult {
    if (outcome.status === "eligible") return { qbTxnId, status: "eligible", plan: outcome.plan, evidence: outcome.evidence };
    if (outcome.status === "noop") return { qbTxnId, status: "noop", reason: outcome.reason };
    return { qbTxnId, status: "blocked", reason: outcome.reason, evidence: outcome.evidence };
}

export function createBankSourceRefreshHandlers(deps: BankSourceRefreshDependencies) {
    const now = deps.now ?? (() => Date.now());

    async function processItem(item: RefreshItemRequest, mode: RefreshMode, register: BankRegisterResult, deadlineAt: number = Number.POSITIVE_INFINITY): Promise<RefreshItemResult> {
        const { qbTxnId } = item;
        const picked = pickRegisterRow(register, qbTxnId);
        let purchaseRaw: unknown = null;
        let purchaseFailed = false;
        if (picked.ok) {
            try { purchaseRaw = await deps.readPurchase(qbTxnId); } catch (error) {
                console.error("source refresh purchase read failed", error instanceof Error ? error.name : "UnknownError");
                purchaseFailed = true;
            }
        }
        // The Purchase read is the last external call; past the deadline nothing is applied.
        if (now() >= deadlineAt) return { qbTxnId, status: "not-attempted", reason: "deadline" };
        const plan = (evidence: RefreshEvidence): PlanOutcome =>
            purchaseFailed ? { status: "blocked", reason: "purchase-read-failed", evidence: summarizeEvidence(evidence) } : planSourceRefresh({ qbTxnId, evidence, register, purchaseRaw });

        if (mode === "dry-run") return toItem(qbTxnId, plan(await deps.readEvidence(qbTxnId)));
        if (!picked.ok) return { qbTxnId, status: "blocked", reason: picked.reason };

        // Source already fetched; nothing external happens past this point.
        return deps.apply(qbTxnId, async ctx => {
            const outcome = plan(await ctx.readEvidence());
            if (now() >= deadlineAt) return { qbTxnId, status: "not-attempted", reason: "deadline" };
            if (outcome.status !== "eligible") return toItem(qbTxnId, outcome);
            if (outcome.plan.digest !== item.expectedDigest) return { qbTxnId, status: "blocked", reason: "digest-mismatch", evidence: outcome.evidence };
            await ctx.bumpEpoch();
            if (now() >= deadlineAt) throw new SourceRefreshRollback({ qbTxnId, status: "not-attempted", reason: "deadline" });
            const count = await ctx.updateObservation(outcome.plan.old, outcome.plan.next);
            if (count !== 1) throw new SourceRefreshRollback({ qbTxnId, status: "blocked", reason: "cas-conflict", evidence: outcome.evidence });
            await ctx.appendAudit(outcome.plan.old.id, buildAuditSnapshot(outcome.plan, register.fetchedAt));
            return { qbTxnId, status: "applied", plan: outcome.plan, auditAction: SOURCE_REFRESH_AUDIT_ACTION };
        }, Math.max(1, Math.min(REFRESH_TX_TIMEOUT_MS, deadlineAt - now())));
    }

    async function POST(request: Request): Promise<Response> {
        if (!deps.authorize(request)) return json({ ok: false, reason: "unauthorized" }, 401);
        const raw = await readBoundedBody(request, MAX_REFRESH_BODY_BYTES);
        if (!raw.ok) return json({ ok: false, reason: raw.reason }, raw.reason === "body-too-large" ? 413 : 400);
        const parsed = parseRefreshBody(raw.text);
        if (!parsed.ok) return json({ ok: false, reason: parsed.reason, ...(parsed.field ? { field: parsed.field } : {}) }, 400);

        const deadlineAt = now() + REFRESH_OVERALL_DEADLINE_MS;
        let register: BankRegisterResult;
        try { register = await deps.readRegister(); } catch (error) {
            console.error("source refresh register read failed", error instanceof Error ? error.name : "UnknownError");
            return json({ ok: false, reason: "upstream-unavailable" }, 503);
        }

        const results: RefreshItemResult[] = [];
        for (const item of parsed.items) {
            if (now() >= deadlineAt) { results.push({ qbTxnId: item.qbTxnId, status: "not-attempted", reason: "deadline" }); continue; }
            try { results.push(await processItem(item, parsed.mode, register, deadlineAt)); } catch (error) {
                console.error("source refresh item failed", error instanceof Error ? error.name : "UnknownError");
                results.push({ qbTxnId: item.qbTxnId, status: "failed", reason: "item-failed" });
            }
        }
        return json({
            ok: true,
            mode: parsed.mode,
            account: SOURCE_REFRESH_ACCOUNT,
            source: SOURCE_REFRESH_SOURCE,
            policyVersion: SOURCE_REFRESH_POLICY_VERSION,
            fetchedAt: register.fetchedAt,
            results,
        }, 200);
    }

    return { POST, processItem };
}

// ---------------------------------------------------------------------------
// Prisma adapters
// ---------------------------------------------------------------------------

export type RefreshDbClient = Pick<Prisma.TransactionClient, "bankLineObservation" | "bankLine" | "expense" | "receiptIntake" | "auditLog" | "$executeRaw" | "$queryRaw" | "$queryRawUnsafe">;

function ymd(value: Date | string | null): string | null {
    if (value === null) return null;
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
function iso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : String(value);
}
function asDate(day: string): Date {
    return new Date(`${day}T00:00:00Z`);
}
function text(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
}
function flag(value: unknown): boolean | null {
    return value === null || value === undefined ? null : Boolean(value);
}

/** Bounded, independent evidence reads; the scoping lives here so no caller can widen it. */
export async function readRefreshEvidence(db: RefreshDbClient, qbTxnId: string): Promise<RefreshEvidence> {
    const observations = await db.bankLineObservation.findMany({
        where: { source: SOURCE_REFRESH_SOURCE, account: SOURCE_REFRESH_ACCOUNT, sourceDocumentId: SOURCE_REFRESH_SOURCE, sourceLineId: qbTxnId },
        orderBy: { id: "asc" },
        take: EVIDENCE_TAKE,
        select: { id: true, postedDate: true, rawDescriptor: true, amountCents: true, checkNumber: true, createdAt: true, clearedStatus: true, bankLineId: true },
    });
    const bankLines = await db.bankLine.findMany({
        where: { qbTxnId },
        orderBy: { id: "asc" },
        take: EVIDENCE_TAKE,
        select: { id: true, account: true, postedDate: true, amountCents: true, state: true, sourceOfRecord: true, probuildExpenseId: true },
    });
    const expenses = await db.expense.findMany({
        where: { qbPurchaseId: qbTxnId },
        orderBy: { id: "asc" },
        take: EVIDENCE_TAKE,
        select: {
            id: true, qbPurchaseId: true, date: true, amount: true, qbSyncToken: true, vendor: true,
            description: true, status: true,
            taxAmount: true, taxSource: true, installedAtCustomer: true, taxDeductibleBase: true, taxDeductibleBaseSource: true, taxAtSource: true, needsTaxReview: true,
            projectId: true, estimateId: true, itemId: true,
            project: { select: { id: true, status: true } },
            estimate: { select: { id: true, projectId: true } },
            item: { select: { id: true, estimateId: true } },
        },
    });
    const intakes = await db.receiptIntake.findMany({
        where: { OR: [{ qbPurchaseId: qbTxnId }, { postVoidQbPurchaseId: qbTxnId }] },
        take: EVIDENCE_TAKE,
        select: { id: true, state: true, expenseId: true },
    });
    return {
        observations: observations.map(o => ({
            id: o.id,
            postedDate: ymd(o.postedDate) ?? "",
            rawDescriptor: o.rawDescriptor ?? "",
            amountCents: o.amountCents,
            checkNumber: o.checkNumber ?? null,
            createdAt: iso(o.createdAt),
            clearedStatus: o.clearedStatus === null || o.clearedStatus === undefined ? null : String(o.clearedStatus),
            bankLineId: o.bankLineId ?? null,
        })),
        bankLines: bankLines.map(l => ({ id: l.id, account: l.account, postedDate: ymd(l.postedDate) ?? "", amountCents: l.amountCents, state: String(l.state), sourceOfRecord: String(l.sourceOfRecord), probuildExpenseId: l.probuildExpenseId ?? null })),
        expenses: expenses.map(e => ({
            id: e.id, qbPurchaseId: e.qbPurchaseId ?? null, date: ymd(e.date), amount: String(e.amount), qbSyncToken: e.qbSyncToken ?? null, vendor: e.vendor ?? null,
            retirement: {
                description: text(e.description), status: text(e.status),
                taxAmount: text(e.taxAmount), taxSource: text(e.taxSource), installedAtCustomer: flag(e.installedAtCustomer),
                taxDeductibleBase: text(e.taxDeductibleBase), taxDeductibleBaseSource: text(e.taxDeductibleBaseSource),
                taxAtSource: e.taxAtSource === true, needsTaxReview: e.needsTaxReview === true,
                projectId: e.projectId ?? null, estimateId: e.estimateId ?? null, itemId: e.itemId ?? null,
                project: e.project ? { id: e.project.id, status: text(e.project.status) } : null,
                estimate: e.estimate ? { id: e.estimate.id, projectId: e.estimate.projectId ?? null } : null,
                item: e.item ? { id: e.item.id, estimateId: e.item.estimateId ?? null } : null,
            },
        })),
        intakes: intakes.map(i => ({ id: i.id, state: String(i.state), expenseId: i.expenseId ?? null })),
    };
}

export function createApplyContext(tx: RefreshDbClient, qbTxnId: string): RefreshApplyContext {
    return {
        readEvidence: () => readRefreshEvidence(tx, qbTxnId),
        bumpEpoch: () => bumpBankLedgerEpoch(tx),
        updateObservation: async (old, next) => {
            const result = await tx.bankLineObservation.updateMany({
                where: {
                    id: old.id,
                    source: SOURCE_REFRESH_SOURCE,
                    account: SOURCE_REFRESH_ACCOUNT,
                    sourceDocumentId: SOURCE_REFRESH_SOURCE,
                    sourceLineId: qbTxnId,
                    bankLineId: null,
                    postedDate: asDate(old.postedDate),
                    amountCents: old.amountCents,
                    rawDescriptor: old.rawDescriptor,
                    checkNumber: old.checkNumber,
                    clearedStatus: old.clearedStatus as never,
                    createdAt: new Date(old.createdAt),
                },
                data: { postedDate: asDate(next.postedDate), rawDescriptor: next.rawDescriptor },
            });
            return result.count;
        },
        appendAudit: async (entityId, snapshot) => {
            await tx.auditLog.create({
                data: {
                    entity: "BankLineObservation",
                    entityId,
                    action: SOURCE_REFRESH_AUDIT_ACTION,
                    actorId: null,
                    snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
                },
            });
        },
    };
}

/** Bounded peek at the attribution parents every Expense carrying the id references, plus the identity tuple to re-check under the locks. */
async function peekAttributionParents(tx: RefreshDbClient, qbTxnId: string): Promise<{ projectIds: string[]; estimateIds: string[]; itemIds: string[]; identity: string }> {
    const rows = await tx.expense.findMany({
        where: { qbPurchaseId: qbTxnId },
        orderBy: { id: "asc" },
        take: EVIDENCE_TAKE,
        select: { id: true, projectId: true, estimateId: true, itemId: true, estimate: { select: { projectId: true } } },
    });
    const identity = rows.map(r => ({ id: r.id, projectId: r.projectId ?? null, estimateId: r.estimateId ?? null, itemId: r.itemId ?? null, estimateProjectId: r.estimate?.projectId ?? null }));
    const ids = (values: (string | null)[]): string[] => [...new Set(values.filter((v): v is string => v !== null && v !== ""))].sort();
    return {
        projectIds: ids(identity.flatMap(t => [t.projectId, t.estimateProjectId])),
        estimateIds: ids(identity.map(t => t.estimateId)),
        itemIds: ids(identity.map(t => t.itemId)),
        identity: JSON.stringify(identity),
    };
}

/**
 * One transaction per item. Lock order: receipt-evidence (outermost) →
 * per-Purchase QBO lock → attribution parents (Project → Estimate → EstimateItem,
 * sorted ids from a bounded peek, via the canonical lockAttributionParents) →
 * bank-line identity lock → advisory lock on each existing Expense (sorted ids,
 * at most EVIDENCE_TAKE) → parent identity reread (blocked
 * `retirement-attribution-race` if it moved, no writes) → evidence read → row
 * CAS. A SourceRefreshRollback thrown by the body rolls everything back (epoch
 * bump included) and becomes the item's result.
 */
export function createRefreshApplier(client: Pick<PrismaClient, "$transaction">): BankSourceRefreshDependencies["apply"] {
    return async (qbTxnId, body, budgetMs = REFRESH_TX_TIMEOUT_MS) => {
        try {
            return await client.$transaction(async tx => {
                await lockReceiptEvidence(tx);
                await lockQboExpense(tx, qbTxnId);
                // Project -> Estimate -> EstimateItem is the global attribution order; it goes BEFORE the bank and Expense locks.
                const peek = await peekAttributionParents(tx, qbTxnId);
                await lockAttributionParents(tx, { projectIds: peek.projectIds, estimateIds: peek.estimateIds, itemIds: peek.itemIds });
                await lockBankLineIdentity(tx);
                const expenseIds = (await tx.expense.findMany({ where: { qbPurchaseId: qbTxnId }, orderBy: { id: "asc" }, take: EVIDENCE_TAKE, select: { id: true } }))
                    .map(e => e.id).sort();
                for (const id of expenseIds) await lockExpense(tx, id);
                // A parent named now but not at the peek is unlocked; refuse rather than reach for it out of order.
                const reread = await peekAttributionParents(tx, qbTxnId);
                if (reread.identity !== peek.identity) return { qbTxnId, status: "blocked", reason: RETIREMENT_RACE_REASON } as RefreshItemResult;
                return body(createApplyContext(tx, qbTxnId));
            }, { timeout: Math.max(1, Math.floor(Math.min(REFRESH_TX_TIMEOUT_MS, budgetMs))), maxWait: Math.max(1, Math.floor(Math.min(2000, budgetMs))) });
        } catch (error) {
            if (error instanceof SourceRefreshRollback) return error.result;
            throw error;
        }
    };
}
