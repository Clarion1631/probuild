import type { QBTokens } from "./quickbooks";
import { getQBPurchaseChangesSince, getQBPurchasesSince } from "./quickbooks";
import { findBestProjectNameMatches } from "./project-match";
import { prisma } from "./prisma";
import { getFreshQBTokens } from "./quickbooks-payments";
import { after } from "next/server";
import { suggestCode } from "./expense-cost-suggest";
import {
    HUMAN_COST_CODE_SOURCES,
    notHumanCodedExpenseWhere,
    resolveExpenseProjectId,
} from "./expense-attribution";
import { isOverheadProject } from "./overhead-project";
import { dateOnlyInTimeZone } from "./tz-date";
import { resolveCompanyTimeZone } from "./company-timezone";
import { isCostCodeAllowedForProject } from "./project-phases";
import { lockExpense } from "./expense-lock";
import { prismaPhaseDataSource } from "./project-phases-db";
// Shared with the register merge layer (register-merge.ts, Unified Money
// Register plan §4) so the classification values this module WRITES can
// never drift from the values that module READS.
import type { PurchaseClassification } from "./register-merge";

export interface QboPurchaseLineDetail {
    description: string | null;
    amount: number | null;
    account: string | null;
}

export interface QboPurchaseForImport {
    qbPurchaseId: string;
    syncToken: string;
    txnDate: string | null;
    total: number;
    vendor: string | null;
    customerName: string | null;
    customerId: string | null;
    accountName: string | null;
    memo: string | null;
    /** Expense line detail so imports carry "what was bought", not just a total. */
    lines?: QboPurchaseLineDetail[];
    /** True when every monetary line is an equity/distribution account — an owner draw, not a business expense. */
    isEquityDraw?: boolean;
}

export type QboPurchaseNormalizationSkipReason =
    | "missing-purchase-id"
    | "missing-sync-token"
    | "invalid-amount"
    | "invalid-transaction-date"
    | "multiple-customers"
    | "mixed-customer-allocation";

export type QboPurchaseRemovalReason =
    | "credit-card-refund"
    | "deleted"
    | "voided";

export interface QboPurchaseRemoval {
    qbPurchaseId: string;
    qbSyncToken: string | null;
    reason: QboPurchaseRemovalReason;
}

export type QboPurchaseNormalizationResult =
    | { kind: "purchase"; purchase: QboPurchaseForImport }
    | ({ kind: "removed" } & QboPurchaseRemoval)
    | {
        kind: "ineligible";
        qbPurchaseId: string;
        qbSyncToken: string;
        reason: "multiple-customers" | "mixed-customer-allocation";
    }
    | {
        kind: "skipped";
        qbPurchaseId: string;
        reason: QboPurchaseNormalizationSkipReason;
    };

export interface QboPurchaseReadResult {
    purchases: QboPurchaseForImport[];
    removed: QboPurchaseRemoval[];
    deactivations: Array<{
        qbPurchaseId: string;
        qbSyncToken: string;
        reason: "multiple-customers" | "mixed-customer-allocation";
    }>;
    skipped: Array<{ qbPurchaseId: string; reason: QboPurchaseNormalizationSkipReason }>;
}

type QboReference = {
    value?: unknown;
    name?: unknown;
};

type QboPurchaseLine = {
    Amount?: unknown;
    Description?: unknown;
    AccountBasedExpenseLineDetail?: { CustomerRef?: QboReference; AccountRef?: QboReference };
    ItemBasedExpenseLineDetail?: { CustomerRef?: QboReference };
};

type RawQboPurchase = {
    Id?: unknown;
    SyncToken?: unknown;
    TxnDate?: unknown;
    TotalAmt?: unknown;
    EntityRef?: QboReference;
    AccountRef?: QboReference;
    CustomerRef?: QboReference;
    PrivateNote?: unknown;
    Line?: unknown;
    Credit?: unknown;
    status?: unknown;
};

function optionalString(value: unknown): string | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function customerReferenceKey(reference: QboReference): string | null {
    const id = optionalString(reference.value);
    const name = optionalString(reference.name);
    if (!id && !name) return null;
    return id ? `id:${id}` : `name:${name!.toLowerCase()}`;
}

/**
 * Hand-entered purchases (QBO receipt inbox → Marge) job-code the expense
 * lines but leave the "Reimbursable Sales Tax Paid" split line uncoded — QBO's
 * categorize flow doesn't carry the customer onto the tax line. That line
 * belongs to the same job as the rest of the purchase, so it must not trip the
 * mixed-customer-allocation check (our own API-pushed purchases job-code the
 * tax line explicitly; this only matters for manual entries). Matched by the
 * configured account id first, name as a fallback — same name-based precedent
 * as the equity-draw check in normalizeQboPurchase.
 */
function isReimbursableTaxLine(line: QboPurchaseLine): boolean {
    const accountRef = line.AccountBasedExpenseLineDetail?.AccountRef;
    if (!accountRef) return false;
    const configuredId = optionalString(process.env.QBO_RECEIPT_TAX_ACCOUNT_ID);
    const id = optionalString(accountRef.value);
    // When both ids are known, the id DECIDES — a mismatch must never fall
    // through to name matching (Codex: "Non-Reimbursable Sales Tax" etc.
    // would otherwise suppress the mixed-allocation guard).
    if (configuredId && id) return id === configuredId;
    const name = optionalString(accountRef.name);
    return !!name && name.toLowerCase() === "reimbursable sales tax paid";
}

function collectCustomerReferences(purchase: RawQboPurchase): {
    references: QboReference[];
    hasAssignedExpenseLine: boolean;
    hasUnassignedExpenseLine: boolean;
} {
    const references: QboReference[] = [];
    if (purchase.CustomerRef) references.push(purchase.CustomerRef);
    let hasAssignedExpenseLine = false;
    let hasUnassignedExpenseLine = false;

    if (Array.isArray(purchase.Line)) {
        for (const rawLine of purchase.Line) {
            if (!rawLine || typeof rawLine !== "object") continue;
            const line = rawLine as QboPurchaseLine;
            const isExpenseLine = Boolean(
                line.AccountBasedExpenseLineDetail ||
                line.ItemBasedExpenseLineDetail,
            );
            if (!isExpenseLine) continue;
            const reference =
                line.AccountBasedExpenseLineDetail?.CustomerRef ??
                line.ItemBasedExpenseLineDetail?.CustomerRef;
            if (reference && customerReferenceKey(reference)) {
                references.push(reference);
                hasAssignedExpenseLine = true;
            } else {
                const amount = Number(line.Amount);
                // Missing amounts are treated conservatively as monetary
                // lines. The tax-line exception demands an ACTUAL positive
                // number — coercions (true→1, "1"→1) stay conservative, so a
                // malformed tax line can never earn the exception.
                const taxException =
                    typeof line.Amount === "number" &&
                    Number.isFinite(line.Amount) &&
                    line.Amount > 0 &&
                    isReimbursableTaxLine(line);
                if ((!Number.isFinite(amount) || amount > 0) && !taxException) {
                    hasUnassignedExpenseLine = true;
                }
            }
        }
    }

    const unique = new Map<string, QboReference>();
    for (const reference of references) {
        const key = customerReferenceKey(reference);
        if (key && !unique.has(key)) unique.set(key, reference);
    }
    return {
        references: [...unique.values()],
        hasAssignedExpenseLine,
        hasUnassignedExpenseLine,
    };
}

function validQboTransactionDate(value: string | null): value is string {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Convert an untrusted QBO Purchase row into the stable import contract.
 * Invalid rows are explicit results so scheduled runs can report every skip.
 */
export function normalizeQboPurchase(raw: unknown): QboPurchaseNormalizationResult {
    const purchase =
        raw && typeof raw === "object"
            ? raw as RawQboPurchase
            : {};
    const qbPurchaseId = optionalString(purchase.Id);
    if (!qbPurchaseId) {
        return {
            kind: "skipped",
            qbPurchaseId: "(missing)",
            reason: "missing-purchase-id",
        };
    }

    const syncToken = optionalString(purchase.SyncToken);
    if (optionalString(purchase.status)?.toLowerCase() === "deleted") {
        return {
            kind: "removed",
            qbPurchaseId,
            qbSyncToken: syncToken,
            reason: "deleted",
        };
    }
    if (purchase.Credit === true) {
        return {
            kind: "removed",
            qbPurchaseId,
            qbSyncToken: syncToken,
            reason: "credit-card-refund",
        };
    }

    const total = Number(purchase.TotalAmt);
    if (
        purchase.TotalAmt !== null &&
        purchase.TotalAmt !== undefined &&
        Number.isFinite(total) &&
        total === 0
    ) {
        return {
            kind: "removed",
            qbPurchaseId,
            qbSyncToken: syncToken,
            reason: "voided",
        };
    }
    if (!syncToken) {
        return { kind: "skipped", qbPurchaseId, reason: "missing-sync-token" };
    }

    if (!Number.isFinite(total) || total <= 0) {
        return { kind: "skipped", qbPurchaseId, reason: "invalid-amount" };
    }

    const txnDate = optionalString(purchase.TxnDate);
    if (!validQboTransactionDate(txnDate)) {
        return { kind: "skipped", qbPurchaseId, reason: "invalid-transaction-date" };
    }

    const customerAllocation = collectCustomerReferences(purchase);
    if (
        customerAllocation.hasAssignedExpenseLine &&
        customerAllocation.hasUnassignedExpenseLine
    ) {
        return {
            kind: "ineligible",
            qbPurchaseId,
            qbSyncToken: syncToken,
            reason: "mixed-customer-allocation",
        };
    }
    if (customerAllocation.references.length > 1) {
        return {
            kind: "ineligible",
            qbPurchaseId,
            qbSyncToken: syncToken,
            reason: "multiple-customers",
        };
    }
    const customerReference = customerAllocation.references[0];

    const lineDetails: QboPurchaseLineDetail[] = [];
    let monetaryLineCount = 0;
    let equityLineCount = 0;
    if (Array.isArray(purchase.Line)) {
        for (const rawLine of purchase.Line) {
            if (!rawLine || typeof rawLine !== "object") continue;
            const line = rawLine as QboPurchaseLine;
            if (!line.AccountBasedExpenseLineDetail && !line.ItemBasedExpenseLineDetail) continue;
            const amount = Number(line.Amount);
            const account = optionalString(line.AccountBasedExpenseLineDetail?.AccountRef?.name);
            lineDetails.push({
                description: optionalString(line.Description),
                amount: Number.isFinite(amount) ? amount : null,
                account,
            });
            if (Number.isFinite(amount) && amount !== 0) {
                monetaryLineCount += 1;
                // Name-based on purpose: GTR's draws all live under
                // "Shareholders' equity:Distributions". A false positive only
                // produces a visible equity-draw skip, never a wrong import.
                if (account && /\bequity\b|\bdistributions?\b|owner'?s?\s+draw/i.test(account)) {
                    equityLineCount += 1;
                }
            }
        }
    }

    return {
        kind: "purchase",
        purchase: {
            qbPurchaseId,
            syncToken,
            txnDate,
            total,
            vendor: optionalString(purchase.EntityRef?.name),
            customerName: optionalString(customerReference?.name),
            customerId: optionalString(customerReference?.value),
            accountName: optionalString(purchase.AccountRef?.name),
            memo: optionalString(purchase.PrivateNote),
            lines: lineDetails,
            isEquityDraw: monetaryLineCount > 0 && equityLineCount === monetaryLineCount,
        },
    };
}

export async function readQboPurchasesForImport(
    tokens: QBTokens,
    since: Date,
    until?: Date,
): Promise<QboPurchaseReadResult> {
    const rows = await getQBPurchasesSince(tokens, since, until);
    return normalizeQboPurchaseRows(rows);
}

export async function readQboPurchaseChangesForImport(
    tokens: QBTokens,
    since: Date,
): Promise<QboPurchaseReadResult> {
    const rows = await getQBPurchaseChangesSince(tokens, since);
    return normalizeQboPurchaseRows(rows);
}

function normalizeQboPurchaseRows(rows: unknown[]): QboPurchaseReadResult {
    const result: QboPurchaseReadResult = {
        purchases: [],
        removed: [],
        deactivations: [],
        skipped: [],
    };

    for (const row of rows) {
        const normalized = normalizeQboPurchase(row);
        if (normalized.kind === "purchase") {
            result.purchases.push(normalized.purchase);
        } else if (normalized.kind === "removed") {
            result.removed.push({
                qbPurchaseId: normalized.qbPurchaseId,
                qbSyncToken: normalized.qbSyncToken,
                reason: normalized.reason,
            });
        } else if (normalized.kind === "ineligible") {
            result.deactivations.push({
                qbPurchaseId: normalized.qbPurchaseId,
                qbSyncToken: normalized.qbSyncToken,
                reason: normalized.reason,
            });
            result.skipped.push({
                qbPurchaseId: normalized.qbPurchaseId,
                reason: normalized.reason,
            });
        } else {
            result.skipped.push({
                qbPurchaseId: normalized.qbPurchaseId,
                reason: normalized.reason,
            });
        }
    }

    return result;
}

/**
 * Public stable reader requested by the import contract. Operational callers
 * that need skip details use readQboPurchasesForImport.
 */
export async function listQboPurchasesForImport(
    tokens: QBTokens,
    since: Date,
): Promise<QboPurchaseForImport[]> {
    return (await readQboPurchasesForImport(tokens, since)).purchases;
}

export interface QboExpenseProjectCandidate {
    id: string;
    name: string;
    status: string;
    qbCustomerId?: string | null;
    estimates: Array<{ id: string; createdAt: Date }>;
}

export type ActiveProjectMatch =
    | { kind: "matched"; projectId: string; estimateId: string }
    | {
        kind: "skipped";
        reason:
            | "missing-customer"
            | "no-active-project"
            | "ambiguous-project"
            | "no-estimate";
    };

function matchCandidateEstimate(project: QboExpenseProjectCandidate): ActiveProjectMatch {
    const latestEstimate = [...project.estimates]
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    if (!latestEstimate) return { kind: "skipped", reason: "no-estimate" };
    return {
        kind: "matched",
        projectId: project.id,
        estimateId: latestEstimate.id,
    };
}

/**
 * Resolve a Purchase to one and only one currently in-progress ProBuild job.
 * Closed, waiting, substantially complete, ambiguous, and estimate-less jobs
 * are all explicit skips; a financial import never guesses.
 */
export function findActiveProjectForQboPurchase(
    input: Pick<QboPurchaseForImport, "customerId" | "customerName">,
    projects: QboExpenseProjectCandidate[],
): ActiveProjectMatch {
    if (!input.customerId && !input.customerName) {
        return { kind: "skipped", reason: "missing-customer" };
    }

    const activeProjects = projects.filter(project => project.status === "In Progress");
    if (activeProjects.length === 0) {
        return { kind: "skipped", reason: "no-active-project" };
    }

    // Word-overlap scoring ties on prefix collisions ("Shop" vs "Shop Shed"
    // under one client); an exact name match is unambiguous and wins the tie.
    const exactNameTiebreak = (candidates: QboExpenseProjectCandidate[]) => {
        if (!input.customerName) return null;
        const label = input.customerName.trim().toLowerCase();
        const exact = candidates.filter(
            project => project.name.trim().toLowerCase() === label,
        );
        return exact.length === 1 ? exact[0] : null;
    };

    if (input.customerId) {
        const idMatches = activeProjects.filter(
            project => project.qbCustomerId === input.customerId,
        );
        if (idMatches.length === 1) return matchCandidateEstimate(idMatches[0]);
        if (idMatches.length > 1 && !input.customerName) {
            return { kind: "skipped", reason: "ambiguous-project" };
        }
        if (idMatches.length > 1 && input.customerName) {
            const nameMatches = findBestProjectNameMatches(input.customerName, idMatches);
            if (nameMatches.length === 1) return matchCandidateEstimate(nameMatches[0]);
            const exact = exactNameTiebreak(nameMatches.length ? nameMatches : idMatches);
            if (exact) return matchCandidateEstimate(exact);
            return { kind: "skipped", reason: "ambiguous-project" };
        }
    }

    if (!input.customerName) {
        return { kind: "skipped", reason: "no-active-project" };
    }
    const nameMatches = findBestProjectNameMatches(input.customerName, activeProjects);
    if (nameMatches.length === 0) {
        return { kind: "skipped", reason: "no-active-project" };
    }
    if (nameMatches.length > 1) {
        const exact = exactNameTiebreak(nameMatches);
        if (exact) return matchCandidateEstimate(exact);
        return { kind: "skipped", reason: "ambiguous-project" };
    }
    return matchCandidateEstimate(nameMatches[0]);
}

export interface QboExpenseWrite {
    qbPurchaseId: string;
    qbSyncToken: string;
    qbSyncedAt: Date;
    estimateId: string;
    /**
     * Phase 3: the job this purchase belongs to — the match's project, or the
     * overhead bucket. The sync always KNEW this (it is how `estimateId` was
     * chosen); it just used to drop it on the floor.
     *
     * On UPDATE it is only ever written when the existing row's is NULL. A
     * bookkeeper who re-attributed an imported expense by hand must survive the
     * next re-sync — same posture as the deliberate `receiptUrl` omission.
     */
    projectId: string | null;
    amount: number;
    vendor: string | null;
    date: Date | null;
    description: string;
    status: "Reviewed";
}

type ExpenseTransaction = {
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
    expense: {
        findUnique(args: {
            where: { qbPurchaseId: string };
            select: Record<string, boolean>;
        }): Promise<{
            id: string;
            qbSyncToken: string | null;
            estimateId: string;
            projectId?: string | null;
            updatedAt?: Date;
            taxAmount?: unknown;
            taxAtSource?: boolean;
            installedAtCustomer?: boolean | null;
            taxDeductibleBase?: unknown;
            needsTaxReview?: boolean;
            amount: unknown;
            vendor: string | null;
            date: Date | null;
            description: string | null;
            status: string;
        } | null>;
        create(args: {
            data: QboExpenseWrite;
        }): Promise<unknown>;
        update(args: {
            where: { id: string };
            data: QboExpenseUpdateData | QboExpenseRetirementData;
        }): Promise<unknown>;
        /**
         * Two guarded writes go through here, and both put their guarantee in
         * the PREDICATE rather than in a value read earlier in the transaction:
         * the attribution fill (`projectId: null`) and a COMPARE-AND-SET on the
         * tax values a plan was computed from. The tax PATCH can commit between
         * this transaction's read and its write, and a bookkeeper's answer must
         * not be overwritten by a plan made before it existed.
         */
        updateMany(args: {
            where: Record<string, unknown>;
            data:
                | { projectId?: string; estimateId: string }
                | QboExpenseUpdateData
                | QboExpenseRetirementData;
        }): Promise<{ count: number }>;
    };
};

export interface QboExpensePersistenceClient {
    $transaction<T>(callback: (transaction: ExpenseTransaction) => Promise<T>): Promise<T>;
}

export type QboExpenseUpsertResult = "imported" | "updated" | "unchanged";

function isIncomingQboSyncTokenCurrent(current: string | null, incoming: string): boolean {
    if (current === null) return true;
    if (current === incoming) return true;
    if (/^\d+$/.test(current) && /^\d+$/.test(incoming)) {
        return BigInt(incoming) >= BigInt(current);
    }
    // QBO documents SyncToken as an integer string. If an unexpected legacy
    // value exists locally, a different current QBO token is still preferable.
    return true;
}

function datesEqual(left: Date | null, right: Date | null): boolean {
    return left?.getTime() === right?.getTime();
}

type ExistingQboExpense =
    NonNullable<Awaited<ReturnType<ExpenseTransaction["expense"]["findUnique"]>>>;

/**
 * What the main UPDATE may write. `taxDeductibleBase: null` is the ONLY
 * non-QBO field it can carry, and only to clear an allocation the new amount
 * would make impossible — see planQboExpenseUpdate.
 */
/**
 * What `deactivateQboExpense` writes. Separate from the update shape because it
 * is the only path allowed to zero the amount AND retire a tax classification
 * in one statement — see the comment at its call site.
 */
export interface QboExpenseRetirementData {
    amount: 0;
    description: string;
    status: "Reviewed";
    qbSyncToken?: string | undefined;
    qbSyncedAt: Date;
    taxAmount: null;
    taxAtSource: false;
    installedAtCustomer: null;
    taxDeductibleBase: null;
    needsTaxReview: false;
}

export type QboExpenseUpdateData = Partial<QboExpenseWrite> & {
    taxDeductibleBase?: null;
    taxAmount?: null;
    taxAtSource?: false;
    installedAtCustomer?: null;
    needsTaxReview?: true;
};

export interface QboExpenseUpdatePlan {
    /**
     * The ATTRIBUTION fill, applied by its own statement under a
     * `projectId: null` predicate — so the project and the estimate that
     * belongs to it land together or neither does. Null when there is nothing
     * to fill.
     */
    fill: { projectId?: string; estimateId: string } | null;
    /**
     * Everything the main UPDATE may write. NEVER contains `projectId` or
     * `estimateId` — both are attribution and both go in `fill`.
     */
    data: QboExpenseUpdateData;
}

/**
 * Decide what a re-sync is allowed to change on a row that already exists.
 *
 * ONE RULE, and it used to be a read-then-unconditional-update:
 *
 *   ATTRIBUTION IS WRITE-ONCE. `projectId` and `estimateId` are the same fact
 *   said twice, so they move together and only while the row has no project
 *   yet. The write happens under a `projectId: null` predicate, so the
 *   guarantee lives in the SQL rather than in a value read earlier in the
 *   transaction. Once a row is attributed — by this sync, by the backfill, or
 *   by a bookkeeper — QuickBooks never re-points it.
 *
 * An earlier version of this refreshed `estimateId` when the stored project and
 * the incoming match AGREED, on the reasoning that "same job, newer estimate"
 * was the sync's long-standing attach-to-the-active-estimate behaviour. That
 * carve-out is GONE (Codex round 2). It bought a marginal benefit — a row
 * following its job to a newer estimate — and paid for it by making the rule
 * conditional, which is how the original bug got in. A rule that is simply
 * "never after the first write" cannot be reasoned about wrongly at a call
 * site, and re-pointing an estimate is a job for an explicit re-attribution
 * path, not for an import.
 */
export function planQboExpenseUpdate(
    existing: Pick<ExistingQboExpense, "projectId" | "estimateId"> &
        Partial<Pick<ExistingQboExpense, "taxAmount" | "taxDeductibleBase">>,
    write: QboExpenseWrite,
): QboExpenseUpdatePlan {
    const existingProjectId = existing.projectId ?? null;
    const incomingProjectId = write.projectId ?? null;

    const data: QboExpenseUpdateData = { ...write };
    delete data.projectId;
    delete data.estimateId;

    // A LOWERED AMOUNT MUST NOT STRAND A DEDUCTION ALLOCATION.
    //
    // `Expense_taxDeductibleBase_check` enforces
    // `base <= amount - COALESCE(taxAmount, 0)` in the database, so a re-sync
    // that drops the amount below an existing allocation would abort the whole
    // sync transaction on a constraint violation — one hand-allocated receipt
    // taking the entire QBO import down with it.
    //
    // Clearing the allocation is the right resolution and not merely the
    // convenient one: the allocation was a human's split of a receipt that no
    // longer has those numbers, so it is stale by definition. It reverts to
    // NULL ("the whole pre-tax total"), and because the report counts only rows
    // a human flagged `installedAtCustomer`, the correction is visible rather
    // than silently generous.
    const existingTax =
        existing.taxAmount === null || existing.taxAmount === undefined
            ? null
            : Number(existing.taxAmount);
    const existingBase =
        existing.taxDeductibleBase === null || existing.taxDeductibleBase === undefined
            ? null
            : Number(existing.taxDeductibleBase);

    // A LOWERED GROSS INVALIDATES THE WHOLE TAX CLASSIFICATION.
    //
    // If QuickBooks now says the purchase was smaller than the tax a human
    // recorded, that tax is about a receipt this row no longer describes.
    // Keeping it makes `amount - taxAmount` NEGATIVE, and the report subtracts
    // money from the filing; the database CHECK would also refuse the write and
    // take the entire QBO import down with it.
    //
    // So the classification is CLEARED, not clamped — a guessed-down tax is
    // still a guess on a tax return — and `needsTaxReview` marks the row so a
    // person is asked rather than the silence being mistaken for "no tax".
    // `costCodeSource` is deliberately untouched: which PHASE the money is on
    // is a separate question the gross does not bear on.
    if (existingTax !== null && existingTax > write.amount) {
        data.taxAmount = null;
        data.taxAtSource = false;
        data.installedAtCustomer = null;
        data.taxDeductibleBase = null;
        data.needsTaxReview = true;
    } else if (existingBase !== null) {
        const ceiling = Math.round((write.amount - (existingTax ?? 0)) * 100) / 100;
        if (!Number.isFinite(ceiling) || existingBase > ceiling) {
            // NEVER A SILENT NULL. Clearing the allocation on its own leaves a
            // row that still reads as a valid deduction — `installedAtCustomer`
            // is untouched and a null base means "the whole pre-tax total", so
            // the report would quietly claim MORE than the human allocated.
            // Flagging it is what keeps the report's exclusion honest until a
            // person re-splits the receipt.
            data.taxDeductibleBase = null;
            data.needsTaxReview = true;
        }
    }

    if (existingProjectId !== null) return { fill: null, data };

    const wantsProjectId = incomingProjectId !== null;
    const wantsEstimateId = existing.estimateId !== write.estimateId;
    if (!wantsProjectId && !wantsEstimateId) return { fill: null, data };

    return {
        fill: {
            ...(incomingProjectId !== null ? { projectId: incomingProjectId } : {}),
            estimateId: write.estimateId,
        },
        data,
    };
}

/**
 * True when the plan would change nothing. Compares only the fields the plan
 * actually carries — a field the plan deliberately omits must not count as
 * drift, or the sync re-issues an update forever and reports it as "updated".
 * `qbSyncedAt` is excluded because it changes on every run by construction.
 */
function planIsNoop(existing: ExistingQboExpense, plan: QboExpenseUpdatePlan): boolean {
    if (plan.fill !== null) return false;
    const data = plan.data;
    // Clearing a stranded allocation is a real change, even when nothing else moved.
    if (data.taxDeductibleBase === null && existing.taxDeductibleBase != null) return false;
    if (data.needsTaxReview === true) return false;
    if (data.qbSyncToken !== undefined && existing.qbSyncToken !== data.qbSyncToken) return false;
    if (data.amount !== undefined && Number(existing.amount) !== data.amount) return false;
    if (data.vendor !== undefined && existing.vendor !== data.vendor) return false;
    if (data.date !== undefined && !datesEqual(existing.date, data.date)) return false;
    if (data.description !== undefined && existing.description !== data.description) return false;
    if (data.status !== undefined && existing.status !== data.status) return false;
    return true;
}

/**
 * The values a plan was computed from. `updatedAt` covers everything else on
 * the row — including the attribution the authorization rested on — so a
 * re-attribution landing in the gap fails the CAS rather than being written
 * over by a plan that never saw it.
 */
function casWhere(existing: {
    id: string;
    updatedAt?: Date;
    taxAmount?: unknown;
    taxDeductibleBase?: unknown;
}): Record<string, unknown> {
    return {
        id: existing.id,
        ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
        taxAmount: existing.taxAmount ?? null,
        taxDeductibleBase: existing.taxDeductibleBase ?? null,
    };
}

async function lockQboExpense(
    transaction: ExpenseTransaction,
    qbPurchaseId: string,
): Promise<void> {
    // Serialize all writers for one QBO Purchase id before reading its SyncToken.
    // The hash can collide, which only adds harmless serialization.
    await transaction.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS lock_result",
        qbPurchaseId,
    );
}

/**
 * Atomically insert or update one imported QBO expense by its Purchase id.
 * The update intentionally omits receiptUrl so an already-linked Drive receipt
 * survives when QuickBooks publishes a newer sync token.
 */
export async function upsertQboExpense(
    client: QboExpensePersistenceClient,
    write: QboExpenseWrite,
): Promise<QboExpenseUpsertResult> {
    return client.$transaction(async transaction => {
        await lockQboExpense(transaction, write.qbPurchaseId);
        const existing = await transaction.expense.findUnique({
            where: { qbPurchaseId: write.qbPurchaseId },
            select: {
                id: true,
                qbSyncToken: true,
                estimateId: true,
                projectId: true,
                updatedAt: true,
                taxAmount: true,
                taxDeductibleBase: true,
                amount: true,
                vendor: true,
                date: true,
                description: true,
                status: true,
            },
        });
        if (
            existing &&
            !isIncomingQboSyncTokenCurrent(existing.qbSyncToken, write.qbSyncToken)
        ) {
            return "unchanged";
        }
        if (!existing) {
            await transaction.expense.create({ data: write });
            return "imported";
        }

        // The per-EXPENSE lock, on top of the per-purchase one already held.
        // They are different scopes: the purchase lock orders two syncs of the
        // same Purchase, this one orders the sync against the tax PATCH and the
        // booking fill, which know nothing about QBO purchase ids.
        await lockExpense(transaction, existing.id);

        const plan = planQboExpenseUpdate(existing, write);
        if (planIsNoop(existing, plan)) return "unchanged";

        // The attribution fill is its OWN statement, and its predicate — not a
        // value read a few lines above — is what guarantees a human's
        // re-attribution survives. projectId and estimateId land together or
        // neither does.
        if (plan.fill !== null) {
            await transaction.expense.updateMany({
                where: { id: existing.id, projectId: null },
                data: plan.fill,
            });
        }
        // CAS when the client supports it: a tax correction committing between
        // the read above and this write would otherwise be clobbered by a plan
        // that never saw it. Zero rows means the row moved — re-read and
        // re-plan once, which is enough because the second read is inside the
        // advisory lock this transaction already holds.
        const cas = await transaction.expense.updateMany({
            where: casWhere(existing),
            data: plan.data,
        });
        if (cas.count > 0) return "updated";

        // The row moved between the read and the write despite the lock — i.e.
        // a writer that does NOT take it (a script, a migration, a path nobody
        // wired). Re-read, RE-PLAN, and re-CAS: never an unconditional write,
        // because the same thing can happen again and "give up and clobber" is
        // not a resolution when the loser is a human's tax answer.
        const fresh = await transaction.expense.findUnique({
            where: { qbPurchaseId: write.qbPurchaseId },
            select: {
                id: true, qbSyncToken: true, estimateId: true, projectId: true,
                updatedAt: true, taxAmount: true, taxDeductibleBase: true, amount: true,
                vendor: true, date: true, description: true, status: true,
            },
        });
        if (!fresh) return "unchanged";
        const replanned = planQboExpenseUpdate(fresh, write);
        if (planIsNoop(fresh, replanned)) return "unchanged";
        const retry = await transaction.expense.updateMany({
            where: casWhere(fresh),
            data: replanned.data,
        });
        // Still contended. Leaving it is correct: the sync's facts are
        // recoverable on the next run, a discarded tax correction is not.
        return retry.count > 0 ? "updated" : "unchanged";
    });
}

export interface QboExpenseRemovalWrite {
    qbPurchaseId: string;
    qbSyncToken: string | null;
    reason: string;
    qbSyncedAt: Date;
}

export type QboExpenseRemovalResult = "removed" | "unchanged";

export async function deactivateQboExpense(
    client: QboExpensePersistenceClient,
    removal: QboExpenseRemovalWrite,
): Promise<QboExpenseRemovalResult> {
    return client.$transaction(async transaction => {
        await lockQboExpense(transaction, removal.qbPurchaseId);
        const existing = await transaction.expense.findUnique({
            where: { qbPurchaseId: removal.qbPurchaseId },
            select: {
                id: true,
                qbSyncToken: true,
                estimateId: true,
                amount: true,
                vendor: true,
                date: true,
                description: true,
                status: true,
                taxAmount: true,
                taxAtSource: true,
                installedAtCustomer: true,
                taxDeductibleBase: true,
                needsTaxReview: true,
            },
        });
        if (!existing) return "unchanged";
        if (
            removal.qbSyncToken &&
            !isIncomingQboSyncTokenCurrent(existing.qbSyncToken, removal.qbSyncToken)
        ) {
            return "unchanged";
        }

        const description = `[QuickBooks import] Removed in QBO (${removal.reason})`;
        const qbSyncToken = removal.qbSyncToken ?? existing.qbSyncToken;
        // A DELETED PURCHASE HAS NO TAX CLASSIFICATION TO KEEP.
        //
        // Zeroing `amount` while leaving `taxAmount` behind leaves
        // `taxAmount > amount` — which the new CHECK refuses, so the whole sync
        // transaction would abort on a receipt someone had classified. And the
        // classification is about a purchase QuickBooks says never happened, so
        // there is nothing to preserve: it is RETIRED, in the same statement as
        // the zeroing, or the row is briefly inconsistent in a way the report
        // can read.
        //
        // `needsTaxReview` is cleared rather than set: this is not a figure a
        // human needs to re-check, it is a purchase that is gone.
        const classificationIsRetired =
            existing.taxAmount === null &&
            existing.taxAtSource === false &&
            existing.installedAtCustomer === null &&
            existing.taxDeductibleBase === null &&
            existing.needsTaxReview === false;
        if (
            Number(existing.amount) === 0 &&
            existing.description === description &&
            existing.qbSyncToken === qbSyncToken &&
            existing.status === "Reviewed" &&
            classificationIsRetired
        ) {
            return "unchanged";
        }
        await transaction.expense.update({
            where: { id: existing.id },
            data: {
                amount: 0,
                description,
                status: "Reviewed",
                qbSyncToken: qbSyncToken ?? undefined,
                qbSyncedAt: removal.qbSyncedAt,
                taxAmount: null,
                taxAtSource: false,
                installedAtCustomer: null,
                taxDeductibleBase: null,
                needsTaxReview: false,
            },
        });
        return "removed";
    });
}

// ── Cost-code suggestion (Phase 3 attribution, spec §3.1) ──────────────────
//
// A QBO import has never carried a cost code — the sync only ever project-
// matched, so every imported expense landed on the job with no phase and fell
// into the variance report's "unattributed" bucket. The rules in
// expense-cost-suggest.ts answer the unambiguous ones; the rest stay NULL for
// a human, which is the same deliberate refusal the backfill makes.
//
// TWO THINGS THIS MUST NEVER DO, both encoded in the `where` below rather than
// in a caller's discipline:
//   * overwrite a code (the `costCodeId: null` predicate), and
//   * overwrite a HUMAN's code (`notHumanCodedExpenseWhere()` — capture and
//     manual are off limits, and its explicit NULL branch is what keeps legacy
//     rows eligible; see that function's comment).
// It also never runs on the deactivate path: a Purchase deleted in QBO is not
// an occasion to guess its phase.

/**
 * Only the identity. The vendor and description the suggestion reads come from
 * the PERSISTED row, never from the caller — see below.
 */
export interface QboCostCodeSuggestionInput {
    qbPurchaseId: string;
}

export interface QboCostCodeSuggestionClient {
    expense: {
        findUnique(args: {
            where: { qbPurchaseId: string };
            select: Record<string, unknown>;
        }): Promise<{
            projectId: string | null;
            costCodeId: string | null;
            costCodeSource: string | null;
            vendor: string | null;
            description: string | null;
            qbSyncToken: string | null;
            updatedAt?: Date;
            estimate?: { projectId: string | null } | null;
        } | null>;
        updateMany(args: {
            where: Record<string, unknown>;
            data: { costCodeId: string; costCodeSource: string; costCodeConfidence: number };
        }): Promise<{ count: number }>;
    };
}

export type QboCostCodeSuggestionResult =
    /** The upsert did not leave a row (deactivated, or raced away). */
    | "missing-row"
    /** Nothing knows whose job this is, so no job phase can be right. */
    | "skipped-no-project"
    /** The overhead bucket is not a job and does not get a job phase. */
    | "skipped-overhead"
    /** The rules refused — the honest majority case. */
    | "no-match"
    /** The rules named a code this company does not have active. */
    | "unknown-code"
    /** The code exists, but it is not one of THIS job's phases. */
    | "phase-not-on-project"
    /** Already coded, or coded by a human: the guard held. */
    | "not-written"
    | "written";

/**
 * Scope comes from the row's STORED attribution, never from the incoming QBO
 * match. Those two disagree exactly when a bookkeeper has re-attributed the
 * expense — and that is the case where using the match would suggest a phase
 * for the job the row is no longer on. It is also how an overhead row stays
 * out: a row moved INTO the overhead bucket by hand must stop being offered
 * job phases, and the match would never tell us that.
 */
export async function applyQboExpenseCostCodeSuggestion(
    client: QboCostCodeSuggestionClient,
    input: QboCostCodeSuggestionInput,
    costCodeIdByCode: ReadonlyMap<string, string>,
    /**
     * "Is this code a phase of that job?" Injected so the rules stay testable
     * without a database. Omitted = no scope check, which is only acceptable
     * for a caller that has already scoped the map it passed in.
     */
    isAllowedForProject?: (projectId: string, costCodeId: string) => Promise<boolean>,
): Promise<QboCostCodeSuggestionResult> {
    // THE PERSISTED ROW IS THE ONLY INPUT.
    //
    // The sync used to hand this function the vendor and description off the
    // purchase it had just processed. That is wrong whenever the upsert did not
    // actually accept them: an out-of-order QBO webhook carries an OLDER
    // SyncToken, `isIncomingQboSyncTokenCurrent` correctly refuses it and
    // returns "unchanged" — and the suggestion then ran on the rejected
    // payload's text and coded the row from a version of the purchase the
    // database deliberately threw away.
    //
    // Reading the row back means the suggestion can only ever describe what is
    // actually stored.
    const stored = await client.expense.findUnique({
        where: { qbPurchaseId: input.qbPurchaseId },
        select: {
            projectId: true,
            costCodeId: true,
            costCodeSource: true,
            vendor: true,
            description: true,
            qbSyncToken: true,
            updatedAt: true,
            estimate: { select: { projectId: true } },
        },
    });
    if (!stored) return "missing-row";
    // Read-side twin of the update predicate below. Both are needed: this one
    // stops us computing a suggestion nobody may use, that one is the actual
    // guarantee.
    if (stored.costCodeId) return "not-written";
    if ((HUMAN_COST_CODE_SOURCES as readonly string[]).includes(stored.costCodeSource ?? "")) {
        return "not-written";
    }

    const projectId = resolveExpenseProjectId(stored);
    if (!projectId) return "skipped-no-project";
    if (isOverheadProject(projectId)) return "skipped-overhead";
    // The attribution this decision was MADE on, so the write can require that
    // it has not changed underneath. `null` is itself a meaningful expectation:
    // it means the row was still unattributed when we scoped the suggestion,
    // and a row that has since been attributed must be re-scoped, not written.
    const expectedProjectId = stored.projectId ?? null;

    const suggestion = suggestCode({ vendor: stored.vendor, description: stored.description });
    if (!suggestion) return "no-match";

    const costCodeId = costCodeIdByCode.get(suggestion.code);
    if (!costCodeId) return "unknown-code";

    // A phase the job does not have is not an answer, however confident the
    // regex was. The rules match on a vendor name; they know nothing about
    // which phases this job actually carries, and an automated write has LESS
    // standing to invent one than a human does, not more.
    if (isAllowedForProject && !(await isAllowedForProject(projectId, costCodeId))) {
        return "phase-not-on-project";
    }

    const written = await client.expense.updateMany({
        where: {
            qbPurchaseId: input.qbPurchaseId,
            // Everything the decision depended on, re-asserted at write time.
            // A row re-attributed or coded between the read above and here is
            // skipped rather than written on stale reasoning.
            projectId: expectedProjectId,
            costCodeId: null,
            // The exact row version the suggestion was computed from. Without
            // `qbSyncToken` a NEWER sync could commit between the read and this
            // write, and the row would be coded from the text of a purchase it
            // no longer holds — the same staleness the read above fixed, just
            // one statement later.
            ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
            qbSyncToken: stored.qbSyncToken,
            ...notHumanCodedExpenseWhere(),
        },
        data: {
            costCodeId,
            // "ai" is the spec's value for "a machine chose this". The rules are
            // regexes; the label is about provenance, not about technique.
            costCodeSource: "ai",
            costCodeConfidence: suggestion.confidence,
        },
    });
    return written.count > 0 ? "written" : "not-written";
}

// ── Purchase classification (Unified Money Register plan §5 step 3) ─────────
//
// Persists the NATURE of a Purchase's money — job-costable, overhead, owner
// draw, or unknown — at the moment the sync has full QBO Purchase detail
// (customer refs, equity-account lines) in hand. A bank-register GL row never
// carries that detail, so this is the only point in the whole pipeline where
// it can be captured; register-merge.ts (plan §4) only ever READS it back by
// qbPurchaseId.

export interface QboPurchaseClassificationWrite {
    qbPurchaseId: string;
    classification: PurchaseClassification;
    reason: string | null;
    qbSyncToken: string | null;
}

export interface QboPurchaseClassificationPersistenceClient {
    qboPurchaseClassification: {
        upsert(args: {
            where: { qbPurchaseId: string };
            create: { qbPurchaseId: string; classification: string; reason: string | null; qbSyncToken: string | null };
            update: { classification: string; reason: string | null; qbSyncToken: string | null };
        }): Promise<unknown>;
    };
}

/** Upsert by qbPurchaseId — one classification row per Purchase, last sync wins. */
export async function upsertQboPurchaseClassification(
    client: QboPurchaseClassificationPersistenceClient,
    write: QboPurchaseClassificationWrite,
): Promise<void> {
    await client.qboPurchaseClassification.upsert({
        where: { qbPurchaseId: write.qbPurchaseId },
        create: {
            qbPurchaseId: write.qbPurchaseId,
            classification: write.classification,
            reason: write.reason,
            qbSyncToken: write.qbSyncToken,
        },
        update: {
            classification: write.classification,
            reason: write.reason,
            qbSyncToken: write.qbSyncToken,
        },
    });
}

/**
 * Classify a normalized Purchase by the SAME match outcome the import loop
 * is about to act on — computed once, independent of whether the overhead
 * triage bucket (`overheadProjectId`) happens to be configured or available
 * today. A no-customer, non-equity purchase is "overhead" money whether or
 * not it actually got routed into the triage project this run; a matched
 * purchase is "job-cost" whether or not the overhead bucket is even in play.
 */
function classifyPurchaseOutcome(
    purchase: Pick<QboPurchaseForImport, "isEquityDraw">,
    match: ActiveProjectMatch,
): { classification: PurchaseClassification; reason: string | null } {
    if (match.kind === "matched") return { classification: "job-cost", reason: null };
    if (match.reason === "missing-customer") {
        return purchase.isEquityDraw
            ? { classification: "owner-draw", reason: "equity-draw" }
            : { classification: "overhead", reason: "missing-customer" };
    }
    // no-active-project / ambiguous-project / no-estimate: has a customer,
    // but whether it would have job-costed is genuinely undetermined without
    // guessing — never silently promoted to "overhead" or "job-cost".
    return { classification: "unknown", reason: match.reason };
}

export interface QboExpenseSyncDependencies {
    getTokens(): Promise<QBTokens>;
    readPurchases(
        tokens: QBTokens,
        since: Date,
        mode: "incremental" | "backfill",
        until?: Date,
    ): Promise<QboPurchaseReadResult>;
    listProjects(): Promise<QboExpenseProjectCandidate[]>;
    upsertExpense(write: QboExpenseWrite): Promise<QboExpenseUpsertResult>;
    deactivateExpense(write: QboExpenseRemovalWrite): Promise<QboExpenseRemovalResult>;
    /** Optional: copy the QBO receipt attachment into ProBuild storage for this purchase. */
    attachReceipt?(tokens: QBTokens, qbPurchaseId: string): Promise<void>;
    upsertPurchaseClassification(write: QboPurchaseClassificationWrite): Promise<void>;
    /**
     * Optional: rule-based phase suggestion for a job-costed import that has no
     * cost code yet (spec §3.1). Optional so a caller can turn it off outright,
     * and so existing tests that build dependencies by hand keep compiling.
     */
    suggestCostCode?(input: QboCostCodeSuggestionInput): Promise<void>;
    /**
     * The company's configured zone — `Expense.date` is a day in it, not an
     * instant.
     *
     * OPTIONAL, defaulting to the shared resolver. Making it required broke
     * every caller that builds its own dependency set (the e2e reconcile spec
     * among them) for a value none of them has an opinion about; a dependency
     * exists to be overridden, not to be re-stated.
     */
    companyTimeZone?(): Promise<string>;
    now(): Date;
}

export interface QboExpenseSyncResult {
    imported: number;
    updated: number;
    removed: number;
    skipped: Array<{ qbPurchaseId: string; reason: string }>;
}

/**
 * Bounded skip summary for audit-event detail — shared by the cron/manual
 * sync route and the Command Center's sync-now route so both log the same
 * shape. The full skipped array can blow past the detail budget; the sample
 * is capped and the histogram is bounded by the small closed set of reasons.
 */
export function skippedAuditSummary(skipped: QboExpenseSyncResult["skipped"]): {
    skipped: number;
    skippedSample: QboExpenseSyncResult["skipped"];
    skippedByReason: Record<string, number>;
} {
    return {
        skipped: skipped.length,
        skippedSample: skipped.slice(0, 10),
        skippedByReason: skipped.reduce<Record<string, number>>((acc, s) => {
            acc[s.reason] = (acc[s.reason] ?? 0) + 1;
            return acc;
        }, {}),
    };
}

async function listInProgressProjects(): Promise<QboExpenseProjectCandidate[]> {
    const projects = await prisma.project.findMany({
        where: { status: "In Progress" },
        select: {
            id: true,
            name: true,
            status: true,
            client: { select: { qbCustomerId: true } },
            estimates: {
                where: { archivedAt: null },
                select: { id: true, createdAt: true },
                orderBy: { createdAt: "desc" },
            },
        },
    });

    return projects.map(project => ({
        id: project.id,
        name: project.name,
        status: project.status,
        qbCustomerId: project.client.qbCustomerId,
        estimates: project.estimates,
    }));
}

function createDefaultSyncDependencies(): QboExpenseSyncDependencies {
    // Loaded once per sync, on first use: a sync that matches nothing (or one
    // where every row is already coded) should not pay for the lookup, and a
    // sync of 400 purchases should not pay for it 400 times. Scoped to this
    // closure rather than to the module so a long-lived process picks up a
    // newly added cost code on the next run.
    let costCodeIdByCode: ReadonlyMap<string, string> | null = null;
    const loadCostCodes = async (): Promise<ReadonlyMap<string, string>> => {
        if (!costCodeIdByCode) {
            const codes = await prisma.costCode.findMany({
                where: { isActive: true },
                select: { id: true, code: true },
            });
            costCodeIdByCode = new Map(codes.map(code => [code.code, code.id]));
        }
        return costCodeIdByCode;
    };

    return {
        getTokens: getFreshQBTokens,
        readPurchases: (tokens, since, mode, until) =>
            mode === "incremental"
                ? readQboPurchaseChangesForImport(tokens, since)
                : readQboPurchasesForImport(tokens, since, until),
        listProjects: listInProgressProjects,
        upsertExpense: write =>
            upsertQboExpense(
                prisma as unknown as QboExpensePersistenceClient,
                write,
            ),
        deactivateExpense: write =>
            deactivateQboExpense(
                prisma as unknown as QboExpensePersistenceClient,
                write,
            ),
        attachReceipt: async (tokens, qbPurchaseId) => {
            const { attachQboReceipt } = await import("./qbo-receipt-attachments");
            await attachQboReceipt(tokens, qbPurchaseId);
        },
        upsertPurchaseClassification: write =>
            upsertQboPurchaseClassification(
                prisma as unknown as QboPurchaseClassificationPersistenceClient,
                write,
            ),
        suggestCostCode: async input => {
            await applyQboExpenseCostCodeSuggestion(
                prisma as unknown as QboCostCodeSuggestionClient,
                input,
                await loadCostCodes(),
                (projectId, costCodeId) =>
                    isCostCodeAllowedForProject(prismaPhaseDataSource, projectId, costCodeId),
            );
        },
        companyTimeZone: resolveCompanyTimeZone,
        now: () => new Date(),
    };
}

function qboExpenseDescription(
    purchase: QboPurchaseForImport,
    prefix = "[QuickBooks import]",
): string {
    // `memo` (PrivateNote) may already carry OUR OWN [gtr-file:...]
    // idempotency marker — receipts pushed via the API path write it there
    // (qbo-receipt-push.ts), and this sync copies memo straight into the
    // expense description, so the marker rides along. Extract it FIRST and
    // remove it from the descriptive body, then re-append the complete
    // marker LAST after truncation, mirroring "truncate the descriptive
    // prefix, never the marker" in qbo-receipt-push.ts:583-587 — a lost
    // marker breaks receiptJourneys()'s sync-landing match and this
    // function's own retry idempotency, which both depend on finding the
    // FULL marker in the description.
    const markerMatch = (purchase.memo ?? "").match(/\[gtr-file:[^\]]+\]/);
    const marker = markerMatch ? markerMatch[0] : "";
    const memoWithoutMarker = marker
        ? (purchase.memo ?? "").replace(marker, "").trim()
        : purchase.memo;

    const detail = memoWithoutMarker || purchase.vendor || "Finalized expense";
    const lineParts = (purchase.lines ?? [])
        .filter(line => line.description)
        .map(line =>
            line.amount !== null
                ? `${line.description} ($${line.amount.toFixed(2)})`
                : line.description!,
        );
    const suffix = lineParts.length ? ` | Lines: ${lineParts.join("; ")}` : "";
    const body = `${prefix} ${detail}${suffix}`;

    if (!marker) return body.slice(0, 4000);
    return `${body.slice(0, 4000 - marker.length - 1)} ${marker}`;
}

/**
 * A QBO `TxnDate` is a CALENDAR DAY ("2026-07-01"), not an instant. Storing it
 * at UTC midnight put every Pacific expense on the previous day for anything
 * that reads `Expense.date` in the company's zone — the tax report filters on
 * company-midnight bounds and buckets with `dayKeyInTimeZone`, so a 1 July
 * purchase fell into June and out of Q3 entirely.
 *
 * `dateOnlyInTimeZone` is the shared parser every other writer now uses. It
 * anchors the day at local NOON, which is what makes it DST-proof: midnight can
 * fall in a spring-forward gap, noon never does, and both land in the same
 * company calendar day for bucketing.
 */
function qboTransactionDate(txnDate: string | null, timeZone: string): Date | null {
    if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) return null;
    try {
        return dateOnlyInTimeZone(txnDate, timeZone);
    } catch {
        return null;
    }
}

/**
 * Import finalized QBO money-out transactions for currently in-progress jobs.
 * External QBO reads and project loading happen before the short per-row
 * database transaction used by the upsert.
 */
export async function syncQboExpenses(
    options: {
        since: Date;
        until?: Date;
        mode?: "incremental" | "backfill";
        /** In-progress project that receives no-customer overhead purchases as a triage bucket. */
        overheadProjectId?: string;
    },
    dependencies: QboExpenseSyncDependencies = createDefaultSyncDependencies(),
    runtime: { tokens?: QBTokens } = {},
): Promise<QboExpenseSyncResult> {
    if (!Number.isFinite(options.since.getTime())) {
        throw new Error("QBO expense sync requires a valid since date");
    }
    if (options.until) {
        if (!Number.isFinite(options.until.getTime())) {
            throw new Error("QBO expense sync requires a valid until date");
        }
        if (options.until.getTime() < options.since.getTime()) {
            throw new Error("QBO expense sync until date must not precede since");
        }
    }

    const tokens = runtime.tokens ?? await dependencies.getTokens();
    const mode = options.mode ?? "backfill";
    // One read per sync. `Expense.date` is a company CALENDAR DAY, and every
    // writer has to agree on that or the tax report reads them in two zones.
    const companyTimeZone = await (dependencies.companyTimeZone?.() ?? resolveCompanyTimeZone());
    const [purchaseRead, projects] = await Promise.all([
        dependencies.readPurchases(tokens, options.since, mode, options.until),
        dependencies.listProjects(),
    ]);
    const result: QboExpenseSyncResult = {
        imported: 0,
        updated: 0,
        removed: 0,
        skipped: [...purchaseRead.skipped],
    };

    // Classification writes are additive bookkeeping alongside the existing
    // sync — a write failure must never abort the Expense import/removal it
    // rides alongside (same resilience posture as attachReceipt below).
    const persistClassification = async (write: QboPurchaseClassificationWrite) => {
        try {
            await dependencies.upsertPurchaseClassification(write);
        } catch (error) {
            console.error(
                "QBO purchase classification write failed",
                write.qbPurchaseId,
                error instanceof Error ? error.name : "UnknownError",
            );
        }
    };

    // Normalization-time skips that never produced a full QboPurchaseForImport
    // (missing-purchase-id has no real id to key by — skip it; multiple-customers
    // / mixed-customer-allocation are deactivations, classified in that loop
    // below to avoid writing the same qbPurchaseId twice).
    for (const skip of purchaseRead.skipped) {
        if (skip.qbPurchaseId === "(missing)") continue;
        if (skip.reason === "multiple-customers" || skip.reason === "mixed-customer-allocation") continue;
        await persistClassification({
            qbPurchaseId: skip.qbPurchaseId,
            classification: "unknown",
            reason: skip.reason,
            qbSyncToken: null,
        });
    }

    for (const removal of [...purchaseRead.removed, ...purchaseRead.deactivations]) {
        // Removed (deleted/voided/credit-card-refund) or deactivated
        // (multiple-customers/mixed-customer-allocation) Purchases are no
        // longer trustworthy job-cost candidates. Their true nature isn't
        // recoverable from the removal signal alone, so this is "unknown"
        // with the removal reason recorded — never a guess at overhead vs.
        // job-cost.
        await persistClassification({
            qbPurchaseId: removal.qbPurchaseId,
            classification: "unknown",
            reason: removal.reason,
            qbSyncToken: removal.qbSyncToken,
        });
        const outcome = await dependencies.deactivateExpense({
            ...removal,
            qbSyncedAt: dependencies.now(),
        });
        if (outcome === "removed") result.removed += 1;
    }

    // The overhead triage bucket must itself be an eligible in-progress project;
    // when unset or ineligible, no-customer purchases skip exactly as before.
    const overheadProject = options.overheadProjectId
        ? projects.find(
            project =>
                project.id === options.overheadProjectId &&
                project.status === "In Progress",
        )
        : undefined;
    const overheadTarget = overheadProject ? matchCandidateEstimate(overheadProject) : null;
    const overheadEstimateId =
        overheadTarget?.kind === "matched" ? overheadTarget.estimateId : null;

    const attachReceipt = async (qbPurchaseId: string) => {
        // Attempt for every processed purchase: the helper exits after one
        // indexed read when a receipt is already linked, and retrying here is
        // what recovers from a transient failure on an earlier run.
        if (!dependencies.attachReceipt) return;
        try {
            await dependencies.attachReceipt(tokens, qbPurchaseId);
        } catch (error) {
            console.error(
                "QBO receipt attach failed",
                qbPurchaseId,
                error instanceof Error ? error.name : "UnknownError",
            );
        }
    };

    for (const purchase of purchaseRead.purchases) {
        const match = findActiveProjectForQboPurchase(purchase, projects);

        // Persisted BEFORE anything below acts on the match — the money's
        // nature (job-cost/overhead/owner-draw/unknown) is written once,
        // unconditionally, independent of whether the overhead triage bucket
        // is configured/available or the import itself later fails.
        const classified = classifyPurchaseOutcome(purchase, match);
        await persistClassification({
            qbPurchaseId: purchase.qbPurchaseId,
            classification: classified.classification,
            reason: classified.reason,
            qbSyncToken: purchase.syncToken,
        });

        if (match.kind === "skipped") {
            const isOverheadCandidate =
                match.reason === "missing-customer" && !purchase.isEquityDraw;
            if (isOverheadCandidate && overheadEstimateId) {
                const outcome = await dependencies.upsertExpense({
                    qbPurchaseId: purchase.qbPurchaseId,
                    qbSyncToken: purchase.syncToken,
                    qbSyncedAt: dependencies.now(),
                    estimateId: overheadEstimateId,
                    // The overhead bucket IS this row's project — the sync has
                    // always known it, it just never wrote it down.
                    // Non-null on this branch by construction: overheadEstimateId
                    // is derived from overheadProject and gates the branch.
                    projectId: overheadProject?.id ?? null,
                    amount: purchase.total,
                    vendor: purchase.vendor,
                    date: qboTransactionDate(purchase.txnDate, companyTimeZone),
                    description: qboExpenseDescription(purchase, "[Overhead]"),
                    status: "Reviewed",
                });
                if (outcome === "imported") result.imported += 1;
                if (outcome === "updated") result.updated += 1;
                // NO cost-code suggestion here. Overhead is not a job and does
                // not get a job phase (same scope rule as
                // scripts/suggest-expense-cost-codes.mjs).
                await attachReceipt(purchase.qbPurchaseId);
                continue;
            }
            if (isOverheadCandidate && options.overheadProjectId) {
                // Overhead routing is configured but the target project is
                // missing, not in progress, or estimate-less. Zeroing prior
                // imports on a misconfiguration would wipe the whole triage
                // bucket, so this skips WITHOUT mutating anything.
                result.skipped.push({
                    qbPurchaseId: purchase.qbPurchaseId,
                    reason: "overhead-project-unavailable",
                });
                continue;
            }

            const skipReason =
                match.reason === "missing-customer" && purchase.isEquityDraw
                    ? "equity-draw"
                    : match.reason;
            result.skipped.push({
                qbPurchaseId: purchase.qbPurchaseId,
                reason: skipReason,
            });
            const outcome = await dependencies.deactivateExpense({
                qbPurchaseId: purchase.qbPurchaseId,
                qbSyncToken: purchase.syncToken,
                qbSyncedAt: dependencies.now(),
                reason: skipReason,
            });
            if (outcome === "removed") result.removed += 1;
            continue;
        }

        const description = qboExpenseDescription(purchase);
        const outcome = await dependencies.upsertExpense({
            qbPurchaseId: purchase.qbPurchaseId,
            qbSyncToken: purchase.syncToken,
            qbSyncedAt: dependencies.now(),
            estimateId: match.estimateId,
            // The matched job. `match.projectId` was computed to pick the
            // estimate and then thrown away; now it is persisted.
            projectId: match.projectId,
            amount: purchase.total,
            vendor: purchase.vendor,
            date: qboTransactionDate(purchase.txnDate, companyTimeZone),
            description,
            status: "Reviewed",
        });
        if (outcome === "imported") result.imported += 1;
        if (outcome === "updated") result.updated += 1;

        // Runs on "unchanged" too: a row imported before Phase 3 is unchanged
        // by definition and is exactly the row that still has no phase. The
        // write is guarded (uncoded, and not human-coded), so a re-run over an
        // already-coded row is a no-op.
        //
        // Failure here must never fail the import — the money is already
        // recorded, and a missing phase is a reportable gap, not a lost cost.
        // Same resilience posture as persistClassification/attachReceipt.
        if (dependencies.suggestCostCode) {
            try {
                // Identity only. Whether this purchase's payload was ACCEPTED
                // is the upsert's business, and the suggestion reads whatever
                // the upsert left behind rather than what it was offered.
                await dependencies.suggestCostCode({ qbPurchaseId: purchase.qbPurchaseId });
            } catch (error) {
                console.error(
                    "QBO cost-code suggestion failed",
                    purchase.qbPurchaseId,
                    error instanceof Error ? error.name : "UnknownError",
                );
            }
        }
        await attachReceipt(purchase.qbPurchaseId);
    }

    // Review-alert evaluation (Unified Money Register plan §5 step 8) is
    // additive bookkeeping that rides alongside this sync — a failure here
    // must never fail or block the Expense import/removal above, same
    // resilience posture as persistClassification/attachReceipt. Ships
    // disabled (REVIEW_ALERTS_ENABLED unset); the env check happens before
    // the dynamic import so a disabled deployment never even loads the
    // register-merge/QBO-register graph this pulls in. Dynamic import
    // mirrors payment-outbox.ts's `deliver()` — this module is imported by
    // every sync caller (cron route, manual sync-now, tests), so pulling in
    // the review-alert machinery unconditionally would widen its footprint
    // for consumers that never use it.
    //
    // Finding 5: this used to be awaited INLINE — a full 90-day QBO register
    // report fetch plus a per-target evaluation pass, directly extending the
    // money-sync request/response. Scheduled via `after()` instead (same
    // established pattern as actions.ts's `autoAssignAfterApprove`) so it
    // runs AFTER the response is sent and never blocks the sync caller.
    // `after()` throws synchronously outside a request scope (direct
    // invocation from a script or a `node:test` file, same as
    // autoAssignAfterApprove's own comment) — fall back to a caught floating
    // promise so a disabled/non-request context never fails the sync either.
    if (process.env.REVIEW_ALERTS_ENABLED === "true") {
        const runReviewAlerts = () =>
            import("./review-alert-evaluator")
                .then(({ evaluateReviewAlertsPostSync }) => evaluateReviewAlertsPostSync())
                .then(() => undefined)
                .catch(error => {
                    console.error(
                        "review alert post-sync evaluation failed",
                        error instanceof Error ? error.name : "UnknownError",
                    );
                });
        try {
            after(runReviewAlerts);
        } catch {
            void runReviewAlerts();
        }
    }

    return result;
}
