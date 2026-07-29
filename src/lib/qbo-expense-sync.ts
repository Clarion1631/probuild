import type { QBTokens } from "./quickbooks";
import { getQBPurchasesSince } from "./quickbooks";

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
