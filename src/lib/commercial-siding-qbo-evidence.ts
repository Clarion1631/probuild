import { qbFetch, escapeQBString, type QBTokens } from "./quickbooks";

/** Fixed investigation scope. This is deliberately not a user-searchable QBO browser. */
export const APRIL_VELILLA_QBO_CUSTOMER = "April Velilla";
export const APRIL_VELILLA_QBO_INVOICE_CANDIDATES = [
    "INV-00321",
    "INV-00321-1",
    "INV-00321-2",
    "INV-00321-3",
    "INV-00246",
    "INV-00246-1",
    "INV-00246-2",
    "INV-00246-3",
] as const;

export interface QboEvidenceLinkedTxn {
    TxnId?: unknown;
    TxnType?: unknown;
}

export interface QboEvidenceInvoice {
    Id?: unknown;
    DocNumber?: unknown;
    TxnDate?: unknown;
    CustomerRef?: { value?: unknown; name?: unknown };
    TotalAmt?: unknown;
    Balance?: unknown;
    PrivateNote?: unknown;
    CustomerMemo?: { value?: unknown };
    TxnSource?: unknown;
    LinkedTxn?: QboEvidenceLinkedTxn[];
}

export interface QboEvidencePayment {
    Id?: unknown;
    TxnDate?: unknown;
    TotalAmt?: unknown;
    Line?: Array<{ Amount?: unknown; LinkedTxn?: QboEvidenceLinkedTxn[] }>;
}

export type QboEvidenceRuntime = {
    queryInvoices: (...args: [string]) => Promise<QboEvidenceInvoice[]>;
    readPayment: (...args: [string]) => Promise<QboEvidencePayment | null>;
    now(): Date;
};

export type QboReadOnlyRequestInit = Pick<RequestInit, "method" | "body">;

/**
 * A single guard for the only QBO HTTP shape this evidence feature may use.
 * It rejects a body too: QBO's accounting writes are body-bearing POSTs.
 */
export function assertReadOnlyQboRequest(init: QboReadOnlyRequestInit = {}): { method: "GET" } {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" || init.body !== undefined && init.body !== null) {
        throw new Error("QBO evidence requests are read-only GET requests without a body");
    }
    return { method: "GET" };
}

/** Authenticated GET only. Do not use qbFetch directly from this feature. */
export async function qbReadOnlyFetch(path: string, tokens: QBTokens): Promise<Response> {
    return qbFetch(path, tokens, assertReadOnlyQboRequest());
}

export async function queryQboReadOnly<T>(tokens: QBTokens, query: string): Promise<T[]> {
    const response = await qbReadOnlyFetch(`/query?query=${encodeURIComponent(query)}`, tokens);
    if (!response.ok) throw new Error(`QBO evidence query failed with HTTP ${response.status}`);
    const data = await response.json() as { QueryResponse?: Record<string, unknown> };
    const queryResponse = data.QueryResponse ?? {};
    const key = Object.keys(queryResponse).find(candidate => Array.isArray(queryResponse[candidate]));
    return key ? queryResponse[key] as T[] : [];
}

export async function readQboPaymentReadOnly(tokens: QBTokens, paymentId: string): Promise<QboEvidencePayment | null> {
    const response = await qbReadOnlyFetch(`/payment/${encodeURIComponent(paymentId)}`, tokens);
    if (!response.ok) return null;
    const data = await response.json() as { Payment?: QboEvidencePayment };
    return data.Payment ?? null;
}

export function createQboEvidenceRuntime(tokens: QBTokens, now: () => Date = () => new Date()): QboEvidenceRuntime {
    return {
        queryInvoices: (docNumber) => queryQboReadOnly<QboEvidenceInvoice>(
            tokens,
            `SELECT * FROM Invoice WHERE DocNumber = '${escapeQBString(docNumber)}'`,
        ),
        readPayment: (paymentId) => readQboPaymentReadOnly(tokens, paymentId),
        now,
    };
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
}

function centsOrNull(value: unknown): number | null {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    // QBO normally emits two decimals, but preserve a half-cent fixture at the
    // integer-cents boundary despite IEEE-754's 1.005 * 100 representation.
    return Math.sign(parsed) * Math.round((Math.abs(parsed) + Number.EPSILON) * 100);
}

function sameCustomer(value: unknown): boolean {
    return value === APRIL_VELILLA_QBO_CUSTOMER;
}

function paymentIds(invoice: QboEvidenceInvoice): string[] {
    return [...new Set((invoice.LinkedTxn ?? [])
        .filter(link => link.TxnType === "Payment")
        .map(link => stringOrNull(link.TxnId))
        .filter((id): id is string => id !== null))];
}

function paymentApplicationCents(payment: QboEvidencePayment, invoiceId: string): number[] {
    return (payment.Line ?? [])
        .filter(line => (line.LinkedTxn ?? []).some(link => link.TxnType === "Invoice" && String(link.TxnId) === invoiceId))
        .map(line => centsOrNull(line.Amount))
        .filter((amount): amount is number => amount !== null);
}

function invoiceStatus(totalCents: number | null, balanceCents: number | null, linkedTxnPaymentIds: string[]): "open" | "partially-paid" | "paid" | "voided" | "unknown" {
    if (totalCents === null || balanceCents === null) return "unknown";
    if (totalCents === 0 && balanceCents === 0 && linkedTxnPaymentIds.length === 0) return "voided";
    if (balanceCents === 0) return "paid";
    if (totalCents !== null && balanceCents !== null && balanceCents > 0 && balanceCents < totalCents) return "partially-paid";
    if (totalCents !== null && balanceCents !== null) return "open";
    return "unknown";
}

async function normalizeInvoice(invoice: QboEvidenceInvoice, runtime: QboEvidenceRuntime) {
    const id = stringOrNull(invoice.Id);
    if (!id) return null;
    const linkedTxnPaymentIds = paymentIds(invoice);
    const payments = [] as Array<{
        id: string;
        txnDate: string | null;
        totalCents: number | null;
        appliedLineAmountsCents: number[];
    }>;
    const unverifiedLinkedPaymentIds: string[] = [];

    for (const paymentId of linkedTxnPaymentIds) {
        const payment = await runtime.readPayment(paymentId);
        if (!payment || stringOrNull(payment.Id) !== paymentId) {
            unverifiedLinkedPaymentIds.push(paymentId);
            continue;
        }
        payments.push({
            id: paymentId,
            txnDate: stringOrNull(payment.TxnDate),
            totalCents: centsOrNull(payment.TotalAmt),
            appliedLineAmountsCents: paymentApplicationCents(payment, id),
        });
    }

    const totalCents = centsOrNull(invoice.TotalAmt);
    const balanceCents = centsOrNull(invoice.Balance);
    const status = invoiceStatus(totalCents, balanceCents, linkedTxnPaymentIds);
    return {
        id,
        docNumber: stringOrNull(invoice.DocNumber),
        txnDate: stringOrNull(invoice.TxnDate),
        customer: {
            id: stringOrNull(invoice.CustomerRef?.value),
            name: stringOrNull(invoice.CustomerRef?.name),
        },
        totalCents,
        balanceCents,
        status,
        voidState: status === "unknown" ? "unknown" : status === "voided" ? "voided" : "not-voided",
        privateNote: stringOrNull(invoice.PrivateNote),
        memo: stringOrNull(invoice.CustomerMemo?.value),
        source: stringOrNull(invoice.TxnSource),
        linkedTxnPaymentIds,
        payments,
        unverifiedLinkedPaymentIds,
    };
}

/**
 * Builds evidence only for the fixed April Velilla / Commercial Siding inquiry.
 * An invoice is a verified match only when BOTH the exact candidate DocNumber
 * and the exact QBO CustomerRef name match; near matches are never guessed.
 */
export async function buildCommercialSidingQboEvidence(runtime: QboEvidenceRuntime) {
    const candidates = [] as Array<{
        docNumber: string;
        matchState: "matched" | "no-verified-qbo-match";
        invoices: Awaited<ReturnType<typeof normalizeInvoice>>[];
    }>;

    for (const docNumber of APRIL_VELILLA_QBO_INVOICE_CANDIDATES) {
        const rows = await runtime.queryInvoices(docNumber);
        const invoices = (await Promise.all(rows
            .filter(row => stringOrNull(row.DocNumber) === docNumber && sameCustomer(row.CustomerRef?.name))
            .map(row => normalizeInvoice(row, runtime))))
            .filter((invoice): invoice is NonNullable<typeof invoice> => invoice !== null);
        candidates.push({
            docNumber,
            matchState: invoices.length ? "matched" : "no-verified-qbo-match",
            invoices,
        });
    }

    return {
        scope: {
            customer: APRIL_VELILLA_QBO_CUSTOMER,
            docNumbers: [...APRIL_VELILLA_QBO_INVOICE_CANDIDATES],
        },
        verifiedAt: runtime.now().toISOString(),
        candidates,
    };
}
