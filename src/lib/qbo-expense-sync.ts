import type { QBTokens } from "./quickbooks";
import { getQBPurchaseChangesSince, getQBPurchasesSince } from "./quickbooks";
import { findBestProjectNameMatches } from "./project-match";
import { prisma } from "./prisma";
import { getFreshQBTokens } from "./quickbooks-payments";

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
                // Missing amounts are treated conservatively as monetary lines.
                if (!Number.isFinite(amount) || amount > 0) {
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
        return { kind: "skipped", reason: "ambiguous-project" };
    }
    return matchCandidateEstimate(nameMatches[0]);
}

export interface QboExpenseWrite {
    qbPurchaseId: string;
    qbSyncToken: string;
    qbSyncedAt: Date;
    estimateId: string;
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
            data: Partial<QboExpenseWrite>;
        }): Promise<unknown>;
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

function expenseMatchesQboWrite(
    existing: Awaited<ReturnType<ExpenseTransaction["expense"]["findUnique"]>>,
    write: QboExpenseWrite,
): boolean {
    if (!existing) return false;
    return (
        existing.qbSyncToken === write.qbSyncToken &&
        existing.estimateId === write.estimateId &&
        Number(existing.amount) === write.amount &&
        existing.vendor === write.vendor &&
        datesEqual(existing.date, write.date) &&
        existing.description === write.description &&
        existing.status === write.status
    );
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
        if (expenseMatchesQboWrite(existing, write)) return "unchanged";
        if (!existing) {
            await transaction.expense.create({ data: write });
            return "imported";
        }
        await transaction.expense.update({
            where: { id: existing.id },
            data: write,
        });
        return "updated";
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
        if (
            Number(existing.amount) === 0 &&
            existing.description === description &&
            existing.qbSyncToken === qbSyncToken &&
            existing.status === "Reviewed"
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
            },
        });
        return "removed";
    });
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
    now(): Date;
}

export interface QboExpenseSyncResult {
    imported: number;
    updated: number;
    removed: number;
    skipped: Array<{ qbPurchaseId: string; reason: string }>;
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
        now: () => new Date(),
    };
}

function qboExpenseDescription(
    purchase: QboPurchaseForImport,
    prefix = "[QuickBooks import]",
): string {
    const detail = purchase.memo || purchase.vendor || "Finalized expense";
    const lineParts = (purchase.lines ?? [])
        .filter(line => line.description)
        .map(line =>
            line.amount !== null
                ? `${line.description} ($${line.amount.toFixed(2)})`
                : line.description!,
        );
    const suffix = lineParts.length ? ` | Lines: ${lineParts.join("; ")}` : "";
    return `${prefix} ${detail}${suffix}`.slice(0, 4000);
}

function qboTransactionDate(txnDate: string | null): Date | null {
    if (!txnDate) return null;
    const parsed = new Date(`${txnDate}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
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

    for (const removal of [...purchaseRead.removed, ...purchaseRead.deactivations]) {
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
        if (match.kind === "skipped") {
            const isOverheadCandidate =
                match.reason === "missing-customer" && !purchase.isEquityDraw;
            if (isOverheadCandidate && overheadEstimateId) {
                const outcome = await dependencies.upsertExpense({
                    qbPurchaseId: purchase.qbPurchaseId,
                    qbSyncToken: purchase.syncToken,
                    qbSyncedAt: dependencies.now(),
                    estimateId: overheadEstimateId,
                    amount: purchase.total,
                    vendor: purchase.vendor,
                    date: qboTransactionDate(purchase.txnDate),
                    description: qboExpenseDescription(purchase, "[Overhead]"),
                    status: "Reviewed",
                });
                if (outcome === "imported") result.imported += 1;
                if (outcome === "updated") result.updated += 1;
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

        const outcome = await dependencies.upsertExpense({
            qbPurchaseId: purchase.qbPurchaseId,
            qbSyncToken: purchase.syncToken,
            qbSyncedAt: dependencies.now(),
            estimateId: match.estimateId,
            amount: purchase.total,
            vendor: purchase.vendor,
            date: qboTransactionDate(purchase.txnDate),
            description: qboExpenseDescription(purchase),
            status: "Reviewed",
        });
        if (outcome === "imported") result.imported += 1;
        if (outcome === "updated") result.updated += 1;
        await attachReceipt(purchase.qbPurchaseId);
    }

    return result;
}
