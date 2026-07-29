import type { QBTokens } from "./quickbooks";
import { getQBPurchasesSince } from "./quickbooks";
import { findBestProjectNameMatches } from "./project-match";
import { prisma } from "./prisma";
import { getFreshQBTokens } from "./quickbooks-payments";

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
}

export type QboPurchaseNormalizationSkipReason =
    | "missing-purchase-id"
    | "missing-sync-token"
    | "invalid-amount"
    | "multiple-customers";

export type QboPurchaseNormalizationResult =
    | { kind: "purchase"; purchase: QboPurchaseForImport }
    | {
        kind: "skipped";
        qbPurchaseId: string;
        reason: QboPurchaseNormalizationSkipReason;
    };

export interface QboPurchaseReadResult {
    purchases: QboPurchaseForImport[];
    skipped: Array<{ qbPurchaseId: string; reason: QboPurchaseNormalizationSkipReason }>;
}

type QboReference = {
    value?: unknown;
    name?: unknown;
};

type QboPurchaseLine = {
    AccountBasedExpenseLineDetail?: { CustomerRef?: QboReference };
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

function collectCustomerReferences(purchase: RawQboPurchase): QboReference[] {
    const references: QboReference[] = [];
    if (purchase.CustomerRef) references.push(purchase.CustomerRef);

    if (Array.isArray(purchase.Line)) {
        for (const rawLine of purchase.Line) {
            if (!rawLine || typeof rawLine !== "object") continue;
            const line = rawLine as QboPurchaseLine;
            const reference =
                line.AccountBasedExpenseLineDetail?.CustomerRef ??
                line.ItemBasedExpenseLineDetail?.CustomerRef;
            if (reference) references.push(reference);
        }
    }

    const unique = new Map<string, QboReference>();
    for (const reference of references) {
        const key = customerReferenceKey(reference);
        if (key && !unique.has(key)) unique.set(key, reference);
    }
    return [...unique.values()];
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
    if (!syncToken) {
        return { kind: "skipped", qbPurchaseId, reason: "missing-sync-token" };
    }

    const total = Number(purchase.TotalAmt);
    if (!Number.isFinite(total) || total <= 0) {
        return { kind: "skipped", qbPurchaseId, reason: "invalid-amount" };
    }

    const customerReferences = collectCustomerReferences(purchase);
    if (customerReferences.length > 1) {
        return { kind: "skipped", qbPurchaseId, reason: "multiple-customers" };
    }
    const customerReference = customerReferences[0];

    const txnDate = optionalString(purchase.TxnDate);
    return {
        kind: "purchase",
        purchase: {
            qbPurchaseId,
            syncToken,
            txnDate: txnDate && /^\d{4}-\d{2}-\d{2}$/.test(txnDate) ? txnDate : null,
            total,
            vendor: optionalString(purchase.EntityRef?.name),
            customerName: optionalString(customerReference?.name),
            customerId: optionalString(customerReference?.value),
            accountName: optionalString(purchase.AccountRef?.name),
            memo: optionalString(purchase.PrivateNote),
        },
    };
}

export async function readQboPurchasesForImport(
    tokens: QBTokens,
    since: Date,
): Promise<QboPurchaseReadResult> {
    const rows = await getQBPurchasesSince(tokens, since);
    const result: QboPurchaseReadResult = { purchases: [], skipped: [] };

    for (const row of rows) {
        const normalized = normalizeQboPurchase(row);
        if (normalized.kind === "purchase") {
            result.purchases.push(normalized.purchase);
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
    expense: {
        findUnique(args: {
            where: { qbPurchaseId: string };
            select?: { qbSyncToken: true };
        }): Promise<{ qbSyncToken: string | null } | null>;
        upsert(args: {
            where: { qbPurchaseId: string };
            create: QboExpenseWrite;
            update: QboExpenseWrite;
        }): Promise<unknown>;
    };
};

export interface QboExpensePersistenceClient {
    $transaction<T>(callback: (transaction: ExpenseTransaction) => Promise<T>): Promise<T>;
}

export type QboExpenseUpsertResult = "imported" | "updated" | "unchanged";

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
        const existing = await transaction.expense.findUnique({
            where: { qbPurchaseId: write.qbPurchaseId },
            select: { qbSyncToken: true },
        });
        if (existing?.qbSyncToken === write.qbSyncToken) return "unchanged";

        await transaction.expense.upsert({
            where: { qbPurchaseId: write.qbPurchaseId },
            create: write,
            update: write,
        });
        return existing ? "updated" : "imported";
    });
}

export interface QboExpenseSyncDependencies {
    getTokens(): Promise<QBTokens>;
    readPurchases(tokens: QBTokens, since: Date): Promise<QboPurchaseReadResult>;
    listProjects(): Promise<QboExpenseProjectCandidate[]>;
    upsertExpense(write: QboExpenseWrite): Promise<QboExpenseUpsertResult>;
    now(): Date;
}

export interface QboExpenseSyncResult {
    imported: number;
    updated: number;
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
        readPurchases: readQboPurchasesForImport,
        listProjects: listInProgressProjects,
        upsertExpense: write =>
            upsertQboExpense(
                prisma as unknown as QboExpensePersistenceClient,
                write,
            ),
        now: () => new Date(),
    };
}

function qboExpenseDescription(purchase: QboPurchaseForImport): string {
    const detail = purchase.memo || purchase.vendor || "Finalized expense";
    return `[QuickBooks import] ${detail}`.slice(0, 4000);
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
    options: { since: Date },
    dependencies: QboExpenseSyncDependencies = createDefaultSyncDependencies(),
    runtime: { tokens?: QBTokens } = {},
): Promise<QboExpenseSyncResult> {
    if (!Number.isFinite(options.since.getTime())) {
        throw new Error("QBO expense sync requires a valid since date");
    }

    const tokens = runtime.tokens ?? await dependencies.getTokens();
    const [purchaseRead, projects] = await Promise.all([
        dependencies.readPurchases(tokens, options.since),
        dependencies.listProjects(),
    ]);
    const result: QboExpenseSyncResult = {
        imported: 0,
        updated: 0,
        skipped: [...purchaseRead.skipped],
    };

    for (const purchase of purchaseRead.purchases) {
        const match = findActiveProjectForQboPurchase(purchase, projects);
        if (match.kind === "skipped") {
            result.skipped.push({
                qbPurchaseId: purchase.qbPurchaseId,
                reason: match.reason,
            });
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
    }

    return result;
}
