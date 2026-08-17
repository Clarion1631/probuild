/**
 * QuickBooks Payments rail.
 *
 * Each ProBuild payment milestone (PaymentSchedule) maps to ONE QuickBooks
 * invoice with QuickBooks Payments enabled, so the customer pays large draws
 * on Intuit's hosted page (card/ACH) instead of Stripe. Money recorded in
 * QuickBooks — including manual checks Vanessa applies against the QBO
 * invoice from the Washington Trust bank feed — flows back into ProBuild via
 * `syncQuickBooksPayments()` (hourly cron + on-view refresh), which marks the
 * milestone Paid exactly like the Stripe webhook does. That keeps ProBuild,
 * QuickBooks, and the bank in sync, and keeps the sales-tax report truthful.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { withTxRetry, lockMoneyParents } from "./tx-retry";
import { enqueueMilestonePaid, drainPaymentNotifications } from "./payment-outbox";
import { toNum, deriveInvoiceTaxFields } from "./prisma-helpers";
import { getQBSettings, saveQBSettings } from "./integration-store";
import {
    type QBTokens,
    type QBMilestoneInvoiceInput,
    refreshQBToken,
    ensureQBCustomer,
    ensureQBServiceItem,
    createQBMilestoneInvoice,
    findQBInvoiceByDocNumber,
    type QBInvoiceCreateRecovery,
    getQBInvoicePaymentLink,
    getQBInvoiceStatus,
    probeQBInvoice,
    getQBPayment,
    deleteQBInvoice,
    createQBAutomationSideEffectFence,
} from "./quickbooks";
import { isE2eQboMockEnabled, MOCK_QB_TOKENS } from "./quickbooks-mock";
import type { QBSyncIssue } from "./payment-notifications";

export class QBNotConnectedError extends Error {
    constructor() {
        super("QuickBooks is not connected (Settings → Integrations → QuickBooks)");
        this.name = "QBNotConnectedError";
    }
}

/** Fresh tokens, persisting the rotated refresh token. Throws QBNotConnectedError. */
export async function getFreshQBTokens(options: { signal?: AbortSignal } = {}): Promise<QBTokens> {
    // E2E_QBO_MOCK (deposit-ingest hermeticity) — see quickbooks-mock.ts. The mock
    // replaces the NETWORK, not the CONNECTION STATE: with no connected settings row
    // it still throws QBNotConnectedError, so fail-closed specs (e.g.
    // milestone-payment-request) keep their "rail is down" premise; specs that need
    // QuickBooks seed a connected row (see e2e/deposit-ingest.spec.ts beforeAll).
    if (isE2eQboMockEnabled()) {
        const qb = await getQBSettings();
        if (!qb.connected) throw new QBNotConnectedError();
        return MOCK_QB_TOKENS;
    }
    const qb = await getQBSettings();
    if (!qb.connected || !qb.accessToken || !qb.refreshToken || !qb.realmId) {
        throw new QBNotConnectedError();
    }
    try {
        const fresh = await refreshQBToken(qb.refreshToken, options);
        await saveQBSettings({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
        return { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, realmId: qb.realmId };
    } catch {
        options.signal?.throwIfAborted();
        // Refresh can fail transiently; the old access token may still be valid.
        return { accessToken: qb.accessToken, refreshToken: qb.refreshToken, realmId: qb.realmId };
    }
}

/**
 * Atomically finalize a milestone's QuickBooks unlink after the provider has
 * authoritatively confirmed that invoice deleted/voided. The guard fields
 * (`status`, `qbPaymentId`, and the exact `qbInvoiceId` the caller read) all go
 * in the WHERE, so if a QB settlement lands on this milestone between the
 * caller's read and this write, the claim matches 0 rows and the settle wins —
 * we never strip QB fields off a now-paid row, and a concurrent re-push (new
 * id) can't be clobbered either.
 *
 * The public wrapper always opens its own canonical Invoice transaction;
 * callers that already need a longer provider-fenced transaction use the
 * private locked claim below after acquiring the same parent lock.
 */
type QBInvoiceUnlinkDatabase = Pick<typeof prisma, "$transaction" | "paymentSchedule">;

async function claimQBInvoiceUnlinkLocked(
    tx: Prisma.TransactionClient,
    input: {
        scheduleId: string;
        invoiceId: string;
        qbInvoiceId: string;
        expectedGeneration?: number;
    },
): Promise<boolean> {
    const current = await tx.paymentSchedule.findUnique({
        where: { id: input.scheduleId },
        select: {
            id: true,
            invoiceId: true,
            status: true,
            qbPaymentId: true,
            qbInvoiceId: true,
            qbCreateGeneration: true,
        },
    });
    if (!current
        || current.invoiceId !== input.invoiceId
        || current.status === "Paid"
        || current.qbPaymentId
        || current.qbInvoiceId !== input.qbInvoiceId
        || (input.expectedGeneration !== undefined
            && current.qbCreateGeneration !== input.expectedGeneration)) {
        return false;
    }
    const cleared = await tx.paymentSchedule.updateMany({
        where: {
            id: current.id,
            invoiceId: current.invoiceId,
            status: current.status,
            qbPaymentId: null,
            qbInvoiceId: input.qbInvoiceId,
            qbCreateGeneration: current.qbCreateGeneration,
        },
        data: {
            qbInvoiceId: null,
            qbInvoiceLink: null,
            // qbInvoiceSentAt deliberately survives the unlink: it records that a
            // payment request was emailed (the portal's "due" marker), which stays
            // true even when the QBO invoice behind it is voided and re-staged.
            qbSyncedAt: null,
            qbSyncError: null,
            // A confirmed unlink ends this provider-create lifecycle. The next
            // stage must use a fresh QBO requestid; ambiguous/unlinked retries
            // never come through this path and retain the original generation.
            qbCreateGeneration: { increment: 1 },
            qbCreateRequestId: null,
            qbCreateFingerprint: null,
            qbCreateStartedAt: null,
        },
    });
    return cleared.count === 1;
}

export async function claimQBInvoiceUnlink(
    client: QBInvoiceUnlinkDatabase,
    scheduleId: string,
    expectedQbInvoiceId: string,
    expectedInvoiceId?: string,
): Promise<boolean> {
    const invoiceId = expectedInvoiceId ?? (await client.paymentSchedule.findUnique({
        where: { id: scheduleId },
        select: { invoiceId: true },
    }))?.invoiceId;
    if (!invoiceId) return false;

    return withTxRetry(() => client.$transaction(async tx => {
        await lockMoneyParents(tx, { invoiceId });
        return claimQBInvoiceUnlinkLocked(tx, {
            scheduleId,
            invoiceId,
            qbInvoiceId: expectedQbInvoiceId,
        });
    }));
}

export type QBInvoiceUnlinkResult =
    | { ok: true; providerState: "already-gone" | "deleted" }
    | {
        ok: false;
        reason: "live-invoice" | "provider-error" | "delete-failed" | "stale-local-state";
        error: string;
    };

type QBInvoiceUnlinkDependencies = {
    probe: typeof probeQBInvoice;
    remove: typeof deleteQBInvoice;
};

/**
 * Provider-first unlink boundary. A live invoice with deletion disabled, an
 * unavailable provider, or a failed delete leaves every local link/checkpoint
 * byte untouched, so a replacement create cannot start beside a collectible
 * invoice. Only authoritative gone/voided/deleted state reaches the final CAS.
 */
export async function unlinkQBInvoiceAfterProviderConfirmation(
    client: QBInvoiceUnlinkDatabase,
    tokens: QBTokens,
    input: {
        paymentScheduleId: string;
        invoiceId?: string;
        qbInvoiceId: string;
        deleteInQBO: boolean;
    },
    dependencies: QBInvoiceUnlinkDependencies = {
        probe: probeQBInvoice,
        remove: deleteQBInvoice,
    },
): Promise<QBInvoiceUnlinkResult> {
    const invoiceId = input.invoiceId ?? (await client.paymentSchedule.findUnique({
        where: { id: input.paymentScheduleId },
        select: { invoiceId: true },
    }))?.invoiceId;
    if (!invoiceId) {
        return {
            ok: false,
            reason: "stale-local-state",
            error: "The milestone changed before QuickBooks could be checked. Its local link was not changed.",
        };
    }

    // The bounded provider probe/delete is deliberately inside the Invoice
    // transaction. Email delivery takes this same lock through providerStarted;
    // therefore it cannot validate a live link while this path deletes it, and
    // this path cannot delete a link after delivery crossed its durable fence.
    return withTxRetry(() => client.$transaction(async tx => {
        await lockMoneyParents(tx, { invoiceId });
        const current = await tx.paymentSchedule.findUnique({
            where: { id: input.paymentScheduleId },
            select: {
                invoiceId: true,
                status: true,
                qbPaymentId: true,
                qbInvoiceId: true,
                qbCreateGeneration: true,
            },
        });
        if (!current
            || current.invoiceId !== invoiceId
            || current.status === "Paid"
            || current.qbPaymentId
            || current.qbInvoiceId !== input.qbInvoiceId) {
            return {
                ok: false as const,
                reason: "stale-local-state" as const,
                error: "The milestone changed while QuickBooks was being checked. Its local link was not changed; refresh and review it.",
            };
        }

        let probe;
        try {
            probe = await dependencies.probe(tokens, input.qbInvoiceId);
        } catch {
            return {
                ok: false as const,
                reason: "provider-error" as const,
                error: "QuickBooks could not confirm whether this invoice still exists. The link was left unchanged.",
            };
        }
        if (probe.state === "error") {
            return {
                ok: false as const,
                reason: "provider-error" as const,
                error: "QuickBooks could not confirm whether this invoice still exists. The link was left unchanged.",
            };
        }

        let providerState: "already-gone" | "deleted";
        if (probe.state === "voided" || probe.state === "notFound") {
            providerState = "already-gone";
        } else {
            if (probe.paymentTxnIds.length > 0 || Math.abs(probe.balance - probe.total) > 0.005) {
                return {
                    ok: false as const,
                    reason: "live-invoice" as const,
                    error: "This QuickBooks invoice has payment activity. Refresh payments and reconcile it before breaking the link.",
                };
            }
            if (!input.deleteInQBO) {
                return {
                    ok: false as const,
                    reason: "live-invoice" as const,
                    error: "This QuickBooks invoice is still live. Delete it in QuickBooks (or choose provider deletion) before breaking the link.",
                };
            }

            let deleted = false;
            try {
                deleted = await dependencies.remove(tokens, input.qbInvoiceId);
            } catch {
                return {
                    ok: false as const,
                    reason: "provider-error" as const,
                    error: "QuickBooks deletion could not be completed. The link and retry identity were left unchanged.",
                };
            }
            if (!deleted) {
                let afterDelete;
                try {
                    afterDelete = await dependencies.probe(tokens, input.qbInvoiceId);
                } catch {
                    return {
                        ok: false as const,
                        reason: "provider-error" as const,
                        error: "QuickBooks could not verify the failed deletion. The link and retry identity were left unchanged.",
                    };
                }
                if (afterDelete.state === "error") {
                    return {
                        ok: false as const,
                        reason: "provider-error" as const,
                        error: "QuickBooks could not verify the failed deletion. The link and retry identity were left unchanged.",
                    };
                }
                if (afterDelete.state !== "voided" && afterDelete.state !== "notFound") {
                    return {
                        ok: false as const,
                        reason: "delete-failed" as const,
                        error: "The QuickBooks invoice is still live after the deletion attempt. The link and retry identity were left unchanged.",
                    };
                }
            }
            providerState = deleted ? "deleted" : "already-gone";
        }

        const cleared = await claimQBInvoiceUnlinkLocked(tx, {
            scheduleId: input.paymentScheduleId,
            invoiceId,
            qbInvoiceId: input.qbInvoiceId,
            expectedGeneration: current.qbCreateGeneration,
        });
        return cleared
            ? { ok: true as const, providerState }
            : {
                ok: false as const,
                reason: "stale-local-state" as const,
                error: "The milestone changed while QuickBooks was being checked. Its local link was not changed; refresh and review it.",
            };
    }, { timeout: 70_000 }));
}

// Exported for stageProgressBillingToQuickBooksCore (src/lib/progress-billing.ts),
// which needs the same customer/item resolution pushMilestoneToQuickBooks uses.
export async function resolveCustomerAndItem(
    tokens: QBTokens,
    clientId: string,
    options: { signal?: AbortSignal } = {},
): Promise<{ customerId: string; itemId: string }> {
    const client = await prisma.client.findUnique({
        where: { id: clientId },
        select: { id: true, name: true, email: true, qbCustomerId: true },
    });
    if (!client) throw new Error("Client not found");

    const customerId = await ensureQBCustomer(tokens, client, options);
    if (customerId !== client.qbCustomerId) {
        await prisma.client.update({ where: { id: client.id }, data: { qbCustomerId: customerId } });
    }

    const qb = await getQBSettings();
    let itemId = qb.serviceItemId;
    if (!itemId) {
        itemId = await ensureQBServiceItem(tokens, options);
        await saveQBSettings({ serviceItemId: itemId });
    }
    return { customerId, itemId };
}

export interface MilestonePushResult {
    qbInvoiceId: string;
    payLink: string | null;
    qbTotal?: number; // grand total as QBO computed it (drift check vs the milestone)
    mismatch?: MilestoneQboAmountMismatch;
}

export interface MilestoneQboAmountMismatch {
    code: "QBO_TOTAL_MISMATCH";
    expectedAmount: number;
    qbTotal: number;
    requiresAttention: true;
}

/** Typed handoff to callers: they must not deliver until this drift is reviewed. */
export function getMilestoneQboAmountMismatch(
    expectedAmount: number,
    qbTotal: number,
): MilestoneQboAmountMismatch | undefined {
    if (Math.abs(qbTotal - expectedAmount) <= 0.05) return undefined;
    return {
        code: "QBO_TOTAL_MISMATCH",
        expectedAmount,
        qbTotal,
        requiresAttention: true,
    };
}

/**
 * QBO create idempotency is keyed by `requestid` and caps the key at 50
 * characters. The key intentionally depends only on the milestone identity:
 * until the first QBO id is durably linked, every retry must replay QBO's
 * original response even if local content changed. A content-derived key could
 * turn an ambiguous accepted POST into a second collectible invoice after an
 * intervening edit. The returned QBO total is therefore authoritative and the
 * caller's drift guard blocks delivery until any mismatch is reviewed.
 */
export function buildMilestoneInvoiceRequestId(paymentScheduleId: string, generation: number): string {
    if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error("QuickBooks milestone create generation must be a non-negative integer");
    }
    return createHash("sha256")
        .update(JSON.stringify(["probuild-milestone-invoice-v2", paymentScheduleId, generation]))
        .digest("hex")
        .slice(0, 50);
}

/**
 * Stable, opaque lookup key for Intuit's query-before-retry recovery pattern.
 * It contains no invoice/customer data, fits QBO's 21-character limit, and
 * rotates with the same explicit generation boundary as `requestid`.
 */
export function buildMilestoneInvoiceDocNumber(paymentScheduleId: string, generation: number): string {
    if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error("QuickBooks milestone create generation must be a non-negative integer");
    }
    const digest = createHash("sha256")
        .update(JSON.stringify(["probuild-milestone-doc-v1", paymentScheduleId, generation]))
        .digest("hex")
        .slice(0, 18)
        .toUpperCase();
    return `PB-${digest}`;
}

type FrozenMilestoneQboCreatePayloadV1 = {
    version: 1;
    docNumber: string;
    customerId: string;
    itemId: string;
    description: string;
    amount: number;
    tax: { preTaxAmount: number; taxAmount: number } | null;
    txnDate: string;
    dueDate: string | null;
    billEmail: string | null;
    privateNote: string | null;
};

export interface FrozenMilestoneQboCreateSnapshot {
    payload: string;
    fingerprint: string;
}

/** Normalize every create field in memory; only its SHA-256 digest is persisted. */
export function freezeMilestoneQboCreatePayload(
    input: QBMilestoneInvoiceInput & { txnDate: string },
): FrozenMilestoneQboCreateSnapshot {
    const withTax = !!input.tax && input.tax.taxAmount > 0;
    const frozen: FrozenMilestoneQboCreatePayloadV1 = {
        version: 1,
        docNumber: input.docNumber.slice(0, 21),
        customerId: input.customerId,
        itemId: input.itemId,
        description: input.description.slice(0, 4000),
        amount: input.amount,
        tax: withTax
            ? { preTaxAmount: input.tax!.preTaxAmount, taxAmount: input.tax!.taxAmount }
            : null,
        txnDate: input.txnDate,
        dueDate: input.dueDate?.toISOString().slice(0, 10) ?? null,
        billEmail: input.billEmail || null,
        privateNote: input.privateNote ? input.privateNote.slice(0, 4000) : null,
    };
    const payload = JSON.stringify(frozen);
    return {
        payload,
        fingerprint: createHash("sha256").update(payload).digest("hex"),
    };
}

export interface MilestoneQboCreateFingerprintMismatch {
    code: "QBO_CREATE_FINGERPRINT_MISMATCH";
    frozenFingerprint: string;
    currentFingerprint: string;
    changedFields: string[];
    requiresAttention: true;
}

const MILESTONE_QBO_CREATE_FIELDS = [
    "docNumber",
    "customerId",
    "itemId",
    "description",
    "amount",
    "tax",
    "txnDate",
    "dueDate",
    "billEmail",
    "privateNote",
] as const satisfies ReadonlyArray<keyof FrozenMilestoneQboCreatePayloadV1>;

/** Compare the entire normalized provider create request, not only its total. */
export function getMilestoneQboCreateFingerprintMismatch(
    frozen: { fingerprint: string; payload?: string },
    current: FrozenMilestoneQboCreateSnapshot,
): MilestoneQboCreateFingerprintMismatch | undefined {
    if (frozen.fingerprint === current.fingerprint) return undefined;
    const changedFields = frozen.payload
        ? (() => {
            const frozenPayload = JSON.parse(frozen.payload) as FrozenMilestoneQboCreatePayloadV1;
            const currentPayload = JSON.parse(current.payload) as FrozenMilestoneQboCreatePayloadV1;
            return MILESTONE_QBO_CREATE_FIELDS
                .filter(field => JSON.stringify(frozenPayload[field]) !== JSON.stringify(currentPayload[field]))
                .sort();
        })()
        : [];
    return {
        code: "QBO_CREATE_FINGERPRINT_MISMATCH",
        frozenFingerprint: frozen.fingerprint,
        currentFingerprint: current.fingerprint,
        changedFields,
        requiresAttention: true,
    };
}

export class QBMilestoneCreateNeedsAttentionError extends Error {
    readonly code = "QBO_CREATE_FINGERPRINT_MISMATCH" as const;
    readonly requiresAttention = true as const;

    constructor(readonly mismatch: MilestoneQboCreateFingerprintMismatch) {
        super(
            `This milestone changed after its QuickBooks invoice create began (${mismatch.changedFields.join(", ") || "payload"}). `
            + "The original QuickBooks invoice was preserved; review or replace it before sending.",
        );
        this.name = "QBMilestoneCreateNeedsAttentionError";
    }
}

type MilestoneQboCreateAttemptRow = {
    id: string;
    status: string;
    qbPaymentId: string | null;
    qbInvoiceId: string | null;
    qbCreateGeneration: number;
    qbCreateRequestId: string | null;
    qbCreateFingerprint: string | null;
    qbCreateStartedAt: Date | null;
};

export interface ReservedMilestoneQboCreateAttempt {
    generation: number;
    requestId: string;
    fingerprint: string;
    startedAt: Date;
    qbInvoiceId: string | null;
    isNew: boolean;
    mismatch?: MilestoneQboCreateFingerprintMismatch;
}

function readMilestoneQboCreateAttempt(
    row: MilestoneQboCreateAttemptRow,
    current: FrozenMilestoneQboCreateSnapshot,
): ReservedMilestoneQboCreateAttempt | null {
    const values = [
        row.qbCreateRequestId,
        row.qbCreateFingerprint,
        row.qbCreateStartedAt,
    ];
    if (values.every(value => value === null)) return null;
    if (values.some(value => value === null)) {
        throw new Error(
            "This milestone has an incomplete durable QuickBooks create attempt; reconcile it before retrying.",
        );
    }

    const requestId = row.qbCreateRequestId!;
    const fingerprint = row.qbCreateFingerprint!;
    const startedAt = row.qbCreateStartedAt!;
    const expectedRequestId = buildMilestoneInvoiceRequestId(row.id, row.qbCreateGeneration);
    if (requestId !== expectedRequestId) {
        throw new Error(
            "This milestone's durable QuickBooks request identity is invalid; reconcile it before retrying.",
        );
    }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw new Error("This milestone's durable QuickBooks create fingerprint is invalid; reconcile it before retrying.");
    }
    const frozen = { fingerprint };
    const mismatch = getMilestoneQboCreateFingerprintMismatch(frozen, current);
    return {
        generation: row.qbCreateGeneration,
        requestId,
        fingerprint,
        startedAt,
        qbInvoiceId: row.qbInvoiceId,
        isNew: false,
        ...(mismatch ? { mismatch } : {}),
    };
}

/**
 * Persist the opaque request identity and full-payload fingerprint before the
 * irreversible create. Callers hold the parent Invoice lock, making this a
 * serial lifecycle reservation. Existing attempts always reuse their identity.
 */
export async function reserveMilestoneQboCreateAttempt(
    client: Prisma.TransactionClient,
    paymentScheduleId: string,
    current: FrozenMilestoneQboCreateSnapshot,
    now = new Date(),
): Promise<ReservedMilestoneQboCreateAttempt> {
    const row = await client.paymentSchedule.findUnique({
        where: { id: paymentScheduleId },
        select: {
            id: true,
            status: true,
            qbPaymentId: true,
            qbInvoiceId: true,
            qbCreateGeneration: true,
            qbCreateRequestId: true,
            qbCreateFingerprint: true,
            qbCreateStartedAt: true,
        },
    });
    if (!row) throw new Error("Payment milestone not found");
    if (row.status !== "Pending" || row.qbPaymentId) {
        throw new Error("Only an unpaid pending milestone can stage a QuickBooks invoice");
    }

    const existing = readMilestoneQboCreateAttempt(row, current);
    if (existing) return existing;
    if (row.qbInvoiceId) {
        throw new Error(
            "This milestone already has a QuickBooks invoice but no durable create snapshot; refresh before retrying.",
        );
    }

    const requestId = buildMilestoneInvoiceRequestId(row.id, row.qbCreateGeneration);
    const claimed = await client.paymentSchedule.updateMany({
        where: {
            id: row.id,
            status: "Pending",
            qbPaymentId: null,
            qbInvoiceId: null,
            qbCreateGeneration: row.qbCreateGeneration,
            qbCreateRequestId: null,
            qbCreateFingerprint: null,
            qbCreateStartedAt: null,
        },
        data: {
            qbCreateRequestId: requestId,
            qbCreateFingerprint: current.fingerprint,
            qbCreateStartedAt: now,
        },
    });
    if (claimed.count !== 1) {
        throw new Error(
            "This milestone changed while reserving its QuickBooks create attempt; refresh and retry.",
        );
    }
    return {
        generation: row.qbCreateGeneration,
        requestId,
        fingerprint: current.fingerprint,
        startedAt: now,
        qbInvoiceId: null,
        isNew: true,
    };
}

export type MilestoneQboCreateRetryDecision =
    | { action: "link"; recovered: QBInvoiceCreateRecovery; mismatch?: MilestoneQboCreateFingerprintMismatch }
    | { action: "create" }
    | { action: "needs-attention"; mismatch: MilestoneQboCreateFingerprintMismatch };

/**
 * Never submit changed content under an existing Intuit requestid. Official QBO
 * guidance only demonstrates replaying the same content + requestid and names
 * query-by-stable-DocNumber as the most reliable Create recovery pattern.
 */
export function classifyMilestoneQboCreateRetry(
    attempt: ReservedMilestoneQboCreateAttempt,
    recovered: QBInvoiceCreateRecovery | null,
): MilestoneQboCreateRetryDecision {
    if (recovered) {
        return {
            action: "link",
            recovered,
            ...(attempt.mismatch ? { mismatch: attempt.mismatch } : {}),
        };
    }
    if (attempt.mismatch) return { action: "needs-attention", mismatch: attempt.mismatch };
    return { action: "create" };
}

type MilestoneQboCreateSource = {
    id: string;
    name: string;
    amount: Prisma.Decimal | number;
    pretaxAmount: Prisma.Decimal | number | null;
    taxAmount: Prisma.Decimal | number | null;
    dueDate: Date | null;
    createdAt: Date;
    invoice: {
        code: string;
        clientId: string;
        taxRate: Prisma.Decimal | number;
        client: {
            email: string | null;
            qbCustomerId: string | null;
        };
        project: { name: string } | null;
        payments: Array<{ id: string; createdAt: Date }>;
    };
};

function buildMilestoneQboCreateInput(
    schedule: MilestoneQboCreateSource,
    customerId: string,
    itemId: string,
    docNumber: string,
): QBMilestoneInvoiceInput & { txnDate: string } {
    const invoice = schedule.invoice;
    const projectName = invoice.project?.name || "Project";
    const amount = toNum(schedule.amount);

    let tax: { preTaxAmount: number; taxAmount: number } | null = null;
    if (schedule.pretaxAmount != null && schedule.taxAmount != null) {
        tax = {
            preTaxAmount: toNum(schedule.pretaxAmount),
            taxAmount: toNum(schedule.taxAmount),
        };
    } else {
        const taxRate = toNum(invoice.taxRate);
        const preTaxAmount = Math.round((amount / (1 + taxRate / 100)) * 100) / 100;
        const taxAmount = Math.round((amount - preTaxAmount) * 100) / 100;
        if (taxRate > 0 && taxAmount > 0) tax = { preTaxAmount, taxAmount };
    }

    return {
        docNumber,
        customerId,
        itemId,
        description: `${projectName} — ${schedule.name}`,
        amount,
        tax,
        dueDate: schedule.dueDate,
        txnDate: schedule.createdAt.toISOString().slice(0, 10),
        billEmail: invoice.client.email || null,
        privateNote: `ProBuild ${invoice.code} · ${schedule.name} · ${projectName}`,
    };
}

function hasAnyMilestoneQboCreateAttempt(row: {
    qbCreateRequestId: string | null;
    qbCreateFingerprint: string | null;
    qbCreateStartedAt: Date | null;
}): boolean {
    return row.qbCreateRequestId !== null
        || row.qbCreateFingerprint !== null
        || row.qbCreateStartedAt !== null;
}

/**
 * Full-payload drift guard for already-linked invoices. Unlinked ambiguous
 * attempts deliberately return undefined here: `pushMilestoneToQuickBooks`
 * must first replay the idempotent request and durably recover its QBO id, then it
 * surfaces the typed mismatch. Legacy links without a snapshot are unchanged.
 */
export async function getMilestoneQboCreatePayloadMismatch(
    paymentScheduleId: string,
): Promise<MilestoneQboCreateFingerprintMismatch | undefined> {
    const schedule = await prisma.paymentSchedule.findUnique({
        where: { id: paymentScheduleId },
        include: {
            invoice: {
                include: {
                    client: { select: { email: true, qbCustomerId: true } },
                    project: { select: { name: true } },
                    payments: {
                        select: { id: true, createdAt: true },
                        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    },
                },
            },
        },
    });
    if (!schedule) throw new Error("Payment milestone not found");
    if (!schedule.qbInvoiceId || !hasAnyMilestoneQboCreateAttempt(schedule)) return undefined;

    const qb = await getQBSettings();
    // The provider ids are not PII, but we still avoid persisting the whole
    // create body. Existing local mappings are the current candidate; when a
    // mapping was merely cleared, there is no replacement identity to compare.
    // In that rare case, use an impossible sentinel so the guard fails closed.
    const missingMapping = "__missing_qbo_mapping__";
    const currentInput = buildMilestoneQboCreateInput(
        schedule,
        schedule.invoice.client.qbCustomerId ?? missingMapping,
        qb.serviceItemId ?? missingMapping,
        buildMilestoneInvoiceDocNumber(schedule.id, schedule.qbCreateGeneration),
    );
    const current = freezeMilestoneQboCreatePayload(currentInput);
    return readMilestoneQboCreateAttempt(schedule, current)?.mismatch;
}

export type MilestoneInvoiceLinkDecision =
    | "claim"
    | "reuse"
    | "preserve-conflict"
    | "compensate-conflict";

/**
 * Decide whether a QBO invoice returned for an idempotent create can be linked,
 * was already linked by a concurrent retry, or is now an orphan. In particular,
 * the same QBO id is already owned and must never be compensation-deleted.
 */
export function classifyMilestoneInvoiceLink(input: {
    current: {
        status: string;
        qbPaymentId: string | null;
        qbInvoiceId: string | null;
        amount: Prisma.Decimal | number;
        name: string;
        dueDate: Date | null;
    } | null;
    expected: {
        amount: number;
        name: string;
        dueDate: Date | null;
        qbInvoiceId: string;
    };
    claimedByProgressBilling: boolean;
}): MilestoneInvoiceLinkDecision {
    const { current, expected, claimedByProgressBilling } = input;
    const sameContent = !!current
        && current.status === "Pending"
        && current.qbPaymentId === null
        && toNum(current.amount) === expected.amount
        && current.name === expected.name
        && (current.dueDate?.getTime() ?? null) === (expected.dueDate?.getTime() ?? null);
    const alreadyOwnsThisInvoice = current?.qbInvoiceId === expected.qbInvoiceId;

    if (alreadyOwnsThisInvoice) {
        return !claimedByProgressBilling && sameContent ? "reuse" : "preserve-conflict";
    }
    if (!claimedByProgressBilling && current?.qbInvoiceId === null && sameContent) {
        return "claim";
    }
    return "compensate-conflict";
}

export interface MilestoneQboCreateLinkOutcome {
    decision: MilestoneInvoiceLinkDecision;
    mismatch?: MilestoneQboCreateFingerprintMismatch;
}

/**
 * Attach the QBO result only to the durable attempt that issued it. Local
 * payload drift is not a reason to delete an idempotently recovered invoice:
 * link the original id, hide its payment URL, and require human attention.
 */
export async function linkMilestoneQboCreateResult(
    client: Prisma.TransactionClient,
    input: {
        paymentScheduleId: string;
        attempt: ReservedMilestoneQboCreateAttempt;
        qbInvoiceId: string;
        qbInvoiceLink: string | null;
        current: FrozenMilestoneQboCreateSnapshot;
        claimedByProgressBilling: boolean;
        now?: Date;
    },
): Promise<MilestoneQboCreateLinkOutcome> {
    const row = await client.paymentSchedule.findUnique({
        where: { id: input.paymentScheduleId },
        select: {
            id: true,
            status: true,
            qbPaymentId: true,
            qbInvoiceId: true,
            qbInvoiceLink: true,
            qbCreateGeneration: true,
            qbCreateRequestId: true,
            qbCreateFingerprint: true,
            qbCreateStartedAt: true,
        },
    });
    if (!row) return { decision: "compensate-conflict" };
    const currentAttempt = readMilestoneQboCreateAttempt(row, input.current);
    const sameAttempt = !!currentAttempt
        && currentAttempt.generation === input.attempt.generation
        && currentAttempt.requestId === input.attempt.requestId
        && currentAttempt.fingerprint === input.attempt.fingerprint
        && currentAttempt.startedAt.getTime() === input.attempt.startedAt.getTime();

    if (row.qbInvoiceId === input.qbInvoiceId) {
        if (
            input.claimedByProgressBilling
            || row.status !== "Pending"
            || row.qbPaymentId
            || !sameAttempt
        ) {
            return { decision: "preserve-conflict" };
        }
        if (currentAttempt?.mismatch && row.qbInvoiceLink) {
            await client.paymentSchedule.updateMany({
                where: {
                    id: row.id,
                    status: "Pending",
                    qbPaymentId: null,
                    qbInvoiceId: input.qbInvoiceId,
                    qbCreateGeneration: input.attempt.generation,
                    qbCreateRequestId: input.attempt.requestId,
                    qbCreateFingerprint: input.attempt.fingerprint,
                    qbCreateStartedAt: input.attempt.startedAt,
                },
                data: { qbInvoiceLink: null },
            });
        }
        return {
            decision: "reuse",
            ...(currentAttempt?.mismatch ? { mismatch: currentAttempt.mismatch } : {}),
        };
    }
    if (
        input.claimedByProgressBilling
        || row.status !== "Pending"
        || row.qbPaymentId
        || row.qbInvoiceId !== null
        || !sameAttempt
    ) {
        return { decision: "compensate-conflict" };
    }

    const claimed = await client.paymentSchedule.updateMany({
        where: {
            id: row.id,
            status: "Pending",
            qbPaymentId: null,
            qbInvoiceId: null,
            qbCreateGeneration: input.attempt.generation,
            qbCreateRequestId: input.attempt.requestId,
            qbCreateFingerprint: input.attempt.fingerprint,
            qbCreateStartedAt: input.attempt.startedAt,
        },
        data: {
            qbInvoiceId: input.qbInvoiceId,
            qbInvoiceLink: currentAttempt?.mismatch ? null : input.qbInvoiceLink,
            qbSyncedAt: input.now ?? new Date(),
            qbSyncError: null,
        },
    });
    return claimed.count === 1
        ? {
            decision: "claim",
            ...(currentAttempt?.mismatch ? { mismatch: currentAttempt.mismatch } : {}),
        }
        : { decision: "compensate-conflict" };
}

async function resetMilestoneQboCreateAttemptAfterAuthoritativeDelete(
    client: Prisma.TransactionClient,
    paymentScheduleId: string,
    attempt: ReservedMilestoneQboCreateAttempt,
): Promise<boolean> {
    const reset = await client.paymentSchedule.updateMany({
        where: {
            id: paymentScheduleId,
            qbInvoiceId: null,
            qbPaymentId: null,
            qbCreateGeneration: attempt.generation,
            qbCreateRequestId: attempt.requestId,
            qbCreateFingerprint: attempt.fingerprint,
            qbCreateStartedAt: attempt.startedAt,
        },
        data: {
            qbCreateGeneration: { increment: 1 },
            qbCreateRequestId: null,
            qbCreateFingerprint: null,
            qbCreateStartedAt: null,
        },
    });
    return reset.count === 1;
}

export type ExistingMilestoneQboRefreshWrite = "updated" | "unchanged" | "stale";

/**
 * Apply provider-read link/health refreshes only while holding the canonical
 * parent Invoice fence. Every field from the optimistic pre-provider snapshot
 * that can identify the QBO lifecycle is re-read and exact-CASed, so an email
 * checkpoint, sync flag, unlink, settle, or replacement generation wins over a
 * stale provider response.
 */
export async function refreshExistingMilestoneQboStateUnderInvoiceLock(
    tx: Prisma.TransactionClient,
    input: {
        scheduleId: string;
        invoiceId: string;
        expectedStatus?: string;
        expectedQbInvoiceId: string;
        expectedGeneration: number;
        expectedQbInvoiceLink: string | null;
        expectedQbSyncError: string | null;
        payLink: string | null;
        providerReachable: boolean;
    },
): Promise<ExistingMilestoneQboRefreshWrite> {
    await lockMoneyParents(tx, { invoiceId: input.invoiceId });
    const current = await tx.paymentSchedule.findUnique({
        where: { id: input.scheduleId },
        select: {
            id: true,
            invoiceId: true,
            status: true,
            qbInvoiceId: true,
            qbCreateGeneration: true,
            qbInvoiceLink: true,
            qbSyncError: true,
        },
    });
    if (!current
        || current.invoiceId !== input.invoiceId
        || current.status !== (input.expectedStatus ?? "Pending")
        || current.qbInvoiceId !== input.expectedQbInvoiceId
        || current.qbCreateGeneration !== input.expectedGeneration
        || current.qbInvoiceLink !== input.expectedQbInvoiceLink
        || current.qbSyncError !== input.expectedQbSyncError) {
        return "stale";
    }

    const nextLink = input.payLink || current.qbInvoiceLink;
    const nextError = input.providerReachable ? null : current.qbSyncError;
    if (nextLink === current.qbInvoiceLink && nextError === current.qbSyncError) return "unchanged";
    const updated = await tx.paymentSchedule.updateMany({
        where: {
            id: current.id,
            invoiceId: current.invoiceId,
            status: current.status,
            qbInvoiceId: current.qbInvoiceId,
            qbCreateGeneration: current.qbCreateGeneration,
            qbInvoiceLink: current.qbInvoiceLink,
            qbSyncError: current.qbSyncError,
        },
        data: {
            ...(nextLink !== current.qbInvoiceLink ? { qbInvoiceLink: nextLink } : {}),
            ...(nextError !== current.qbSyncError ? { qbSyncError: nextError } : {}),
        },
    });
    return updated.count === 1 ? "updated" : "stale";
}

/**
 * Create (or reuse) the QBO invoice for one milestone and return its pay link.
 * Idempotent: a milestone that already has a QBO invoice just refreshes the link.
 */
export async function pushMilestoneToQuickBooks(
    paymentScheduleId: string,
    passedTokens?: QBTokens,
    options: { signal?: AbortSignal } = {},
): Promise<MilestonePushResult> {
    const operationFence = options.signal ? null : createQBAutomationSideEffectFence();
    const operationSignal = options.signal ?? operationFence!.signal;
    const assertOperationOpen = () => {
        operationSignal.throwIfAborted();
        operationFence?.throwIfExpired();
    };
    assertOperationOpen();
    const schedule = await prisma.paymentSchedule.findUnique({
        where: { id: paymentScheduleId },
        include: {
            invoice: {
                include: {
                    client: { select: { id: true, name: true, email: true, qbCustomerId: true } },
                    project: { select: { id: true, name: true } },
                    payments: {
                        select: { id: true, createdAt: true },
                        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    },
                },
            },
        },
    });
    if (!schedule) throw new Error("Payment milestone not found");
    if (schedule.status === "Paid") throw new Error("Milestone is already paid");

    // A milestone already claimed by a progress billing must never get its own
    // legacy QBO invoice: the billing stages one covering it, so a second one here
    // would leave TWO collectible invoices for the same money. Checked (and
    // re-checked below, immediately before the link write) because a full-milestone
    // billing leaves the row Pending and unlinked — exactly the state this function
    // otherwise accepts.
    const claimedBy = await prisma.progressBillingLine.findFirst({
        where: { scheduleId: paymentScheduleId, billing: { status: { not: "Void" } } },
        select: { billing: { select: { code: true, status: true } } },
    });
    if (claimedBy) {
        throw new Error(
            `This milestone is already covered by progress invoice ${claimedBy.billing.code} (${claimedBy.billing.status}) — stage that instead of creating a separate QuickBooks invoice here.`
        );
    }

    assertOperationOpen();
    const tokens = passedTokens ?? await getFreshQBTokens({ signal: operationSignal });

    if (schedule.qbInvoiceId) {
        const createPayloadMismatch = await getMilestoneQboCreatePayloadMismatch(schedule.id);
        if (createPayloadMismatch) {
            throw new QBMilestoneCreateNeedsAttentionError(createPayloadMismatch);
        }
        const payLink = schedule.qbInvoiceLink || (await getQBInvoicePaymentLink(
            tokens,
            schedule.qbInvoiceId,
            { signal: operationSignal },
        ));
        const status = await getQBInvoiceStatus(tokens, schedule.qbInvoiceId, { signal: operationSignal });
        const linkChanged = !!payLink && payLink !== schedule.qbInvoiceLink;
        // A reachable invoice (status read back) clears any stale voided/notFound flag.
        const clearFlag = !!status && !!schedule.qbSyncError;
        if (linkChanged || clearFlag) {
            const refresh = await withTxRetry(() => prisma.$transaction(tx => (
                refreshExistingMilestoneQboStateUnderInvoiceLock(tx, {
                    scheduleId: schedule.id,
                    invoiceId: schedule.invoiceId,
                    expectedStatus: schedule.status,
                    expectedQbInvoiceId: schedule.qbInvoiceId!,
                    expectedGeneration: schedule.qbCreateGeneration,
                    expectedQbInvoiceLink: schedule.qbInvoiceLink,
                    expectedQbSyncError: schedule.qbSyncError,
                    payLink,
                    providerReachable: !!status,
                })
            )));
            if (refresh === "stale") {
                throw new Error("This milestone changed while its QuickBooks link was being refreshed; reload and try again.");
            }
        }
        const qbTotal = status?.total;
        const mismatch = qbTotal === undefined
            ? undefined
            : getMilestoneQboAmountMismatch(toNum(schedule.amount), qbTotal);
        return {
            qbInvoiceId: schedule.qbInvoiceId,
            payLink,
            qbTotal,
            ...(mismatch ? { mismatch } : {}),
        };
    }

    const invoice = schedule.invoice;
    const { customerId, itemId } = await resolveCustomerAndItem(tokens, invoice.clientId, { signal: operationSignal });
    assertOperationOpen();

    // Reserve the QBO request identity BEFORE the irreversible POST. The parent
    // invoice lock serializes this with every other money writer. If a previous
    // response was lost, this returns the same generation/requestid and compares
    // today's full normalized request against the original opaque fingerprint.
    const reservation = await withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, { invoiceId: schedule.invoiceId });
        const [current, claimedNow] = await Promise.all([
            tx.paymentSchedule.findUnique({
                where: { id: schedule.id },
                include: {
                    invoice: {
                        include: {
                            client: { select: { email: true, qbCustomerId: true } },
                            project: { select: { name: true } },
                            payments: {
                                select: { id: true, createdAt: true },
                                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                            },
                        },
                    },
                },
            }),
            tx.progressBillingLine.findFirst({
                where: { scheduleId: schedule.id, billing: { status: { not: "Void" } } },
                select: { id: true },
            }),
        ]);
        if (!current) throw new Error("Payment milestone not found");
        if (claimedNow) {
            throw new Error(
                "This milestone became covered by a progress invoice before its QuickBooks create could be reserved.",
            );
        }
        if (current.invoice.clientId !== invoice.clientId) {
            throw new Error("This invoice's client changed while resolving QuickBooks; refresh and retry.");
        }
        const lockedInput = buildMilestoneQboCreateInput(
            current,
            current.invoice.client.qbCustomerId ?? customerId,
            itemId,
            buildMilestoneInvoiceDocNumber(current.id, current.qbCreateGeneration),
        );
        const attempt = await reserveMilestoneQboCreateAttempt(
            tx,
            schedule.id,
            freezeMilestoneQboCreatePayload(lockedInput),
        );
        return { attempt, createInput: lockedInput };
    }));
    const { attempt, createInput } = reservation;
    const docNumber = createInput.docNumber;

    // A concurrent replay may already have durably linked this exact lifecycle.
    // Never POST or compensation-delete in that case.
    if (attempt.qbInvoiceId) {
        if (attempt.mismatch) throw new QBMilestoneCreateNeedsAttentionError(attempt.mismatch);
        const payLink = await getQBInvoicePaymentLink(tokens, attempt.qbInvoiceId, { signal: operationSignal });
        const status = await getQBInvoiceStatus(tokens, attempt.qbInvoiceId, { signal: operationSignal });
        const qbTotal = status?.total;
        const mismatch = qbTotal === undefined
            ? undefined
            : getMilestoneQboAmountMismatch(createInput.amount, qbTotal);
        return {
            qbInvoiceId: attempt.qbInvoiceId,
            payLink,
            qbTotal,
            ...(mismatch ? { mismatch } : {}),
        };
    }

    let providerResult: { qbId: string; total: number } | null = null;
    if (!attempt.isNew) {
        // Intuit documents re-sending the SAME content + requestid. Before every
        // existing-attempt retry, follow its stronger query-by-stable-DocNumber
        // recovery pattern. Changed content is never POSTed under the old key.
        assertOperationOpen();
        const recovered = await findQBInvoiceByDocNumber(tokens, docNumber, { signal: operationSignal });
        const retryDecision = classifyMilestoneQboCreateRetry(attempt, recovered);
        if (retryDecision.action === "needs-attention") {
            throw new QBMilestoneCreateNeedsAttentionError(retryDecision.mismatch);
        }
        if (retryDecision.action === "link") {
            providerResult = {
                qbId: retryDecision.recovered.qbId,
                total: retryDecision.recovered.total,
            };
        }
    }
    if (!providerResult) {
        assertOperationOpen();
        // The body is intentionally not persisted because it contains customer
        // PII. This is either the first POST, or an identical-fingerprint retry;
        // an edited body cannot reach this boundary.
        providerResult = await createQBMilestoneInvoice(tokens, createInput, {
            requestId: attempt.requestId,
            signal: operationSignal,
        });
    }
    const { qbId, total } = providerResult;

    // QBO Automated Sales Tax can recalculate on top of what we send — verify the
    // grand total still equals the milestone. A drift means the client would be
    // asked for a different amount than ProBuild expects; flag it loudly.
    const mismatch = getMilestoneQboAmountMismatch(createInput.amount, total);
    if (mismatch) {
        console.warn(`[quickbooks-payments] QBO total drift on ${createInput.docNumber}: ProBuild ${createInput.amount} vs QBO ${total}`);
    }

    const payLink = await getQBInvoicePaymentLink(tokens, qbId, { signal: operationSignal });

    // Conditional link write: the milestone was read as unlinked and unpaid at
    // the top, but this function does several remote calls in between — a manual
    // "Record Payment", a QB settle, a cancellation, a concurrent push, or a
    // rebalance changing the row's content can all land in that window. The
    // guards go in the WHERE — status pinned to Pending (a Canceled row must
    // never get a fresh collectible invoice: the payment poller only watches
    // Pending) and create-generation fields pinned to the reserved lifecycle.
    // Local payload drift links the recovered original with its pay URL hidden
    // and returns typed needs-attention; ownership/progress conflicts compensate.
    // Taken under the invoice lock and paired with a progress-billing re-check:
    // createProgressBillingCore locks the same invoice row, so the two paths
    // serialize instead of interleaving. Without this a progress billing could
    // claim this milestone in the window between the guard at the top of this
    // function and the write below (a full-milestone billing leaves the row
    // Pending and unlinked, so every pinned column here would still match) and
    // the client would end up with two collectible QuickBooks invoices.
    const currentQbSettings = await getQBSettings();
    const linkOutcome = await withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, { invoiceId: schedule.invoiceId });
        const [current, claimedNow] = await Promise.all([
            tx.paymentSchedule.findUnique({
                where: { id: schedule.id },
                include: {
                    invoice: {
                        include: {
                            client: { select: { email: true, qbCustomerId: true } },
                            project: { select: { name: true } },
                            payments: {
                                select: { id: true, createdAt: true },
                                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                            },
                        },
                    },
                },
            }),
            tx.progressBillingLine.findFirst({
                where: { scheduleId: schedule.id, billing: { status: { not: "Void" } } },
                select: { id: true },
            }),
        ]);
        if (!current) return { decision: "compensate-conflict" as const };
        const currentInput = buildMilestoneQboCreateInput(
            current,
            current.invoice.client.qbCustomerId ?? customerId,
            currentQbSettings.serviceItemId ?? itemId,
            buildMilestoneInvoiceDocNumber(current.id, attempt.generation),
        );
        return linkMilestoneQboCreateResult(tx, {
            paymentScheduleId: schedule.id,
            attempt,
            qbInvoiceId: qbId,
            qbInvoiceLink: payLink,
            current: freezeMilestoneQboCreatePayload(currentInput),
            claimedByProgressBilling: claimedNow !== null,
        });
    }));
    if (linkOutcome.decision === "preserve-conflict") {
        throw new Error("This milestone changed while staging its QuickBooks invoice; its existing QuickBooks invoice was preserved — refresh and try again.");
    }
    if (linkOutcome.decision === "compensate-conflict") {
        const compensated = await deleteQBInvoice(tokens, qbId).catch(() => false);
        if (!compensated) {
            console.error(`[quickbooks-payments] milestone ${schedule.id} changed mid-push and compensating delete of QBO invoice ${qbId} (${createInput.docNumber}) failed — delete it in QuickBooks manually`);
            throw new Error(`This milestone changed while staging its QuickBooks invoice, and the abandoned QuickBooks invoice ${createInput.docNumber} (id ${qbId}) could not be deleted — remove it in QuickBooks, then retry.`);
        }
        await withTxRetry(() => prisma.$transaction(async (tx) => {
            await lockMoneyParents(tx, { invoiceId: schedule.invoiceId });
            await resetMilestoneQboCreateAttemptAfterAuthoritativeDelete(tx, schedule.id, attempt);
        }));
        throw new Error("This milestone changed while staging its QuickBooks invoice — refresh and try again.");
    }
    if (linkOutcome.mismatch) {
        throw new QBMilestoneCreateNeedsAttentionError(linkOutcome.mismatch);
    }

    return {
        qbInvoiceId: qbId,
        payLink,
        qbTotal: total,
        ...(mismatch ? { mismatch } : {}),
    };
}

/**
 * Shared bookkeeping for settling ONE milestone from a QuickBooks payment:
 * claim it Paid, recompute the parent invoice's balance/status from every
 * milestone, and mirror the settle onto the linked estimate-side copy.
 *
 * Caller-locked: the caller must already hold the canonical Estimate→Invoice
 * locks (via `lockMoneyParents`) for this milestone's invoice BEFORE calling
 * this — it does no locking of its own so it can be called more than once
 * inside one transaction (progressBillingSettleLoop below settles every
 * milestone line of a multi-line progress billing under ONE lock+transaction).
 *
 * Deliberately does NOT enqueue a paid notification — that is the caller's
 * job, so a caller that must not notify (progress billing settle, this pass)
 * can skip it without a second/duplicate writer for the same lifecycle event.
 */
async function settleMilestonePaidInTx(
    t: Prisma.TransactionClient,
    paymentScheduleId: string,
    invoiceId: string,
    payment: { paidAt: Date; referenceNumber: string | null; qbPaymentId: string | null }
): Promise<boolean> {
    // INVARIANT: do NOT pin qbInvoiceId in this claim. A real QBO settlement must
    // win over a concurrent breakQBInvoiceLink (which nulls qbInvoiceId): pinning it
    // would drop a genuinely-received payment (the row would be excluded from the next
    // sync's `pending` query forever → client could be double-billed). The settle
    // wins; qbPaymentId below preserves the QBO audit link even if the id was cleared.
    const claim = await t.paymentSchedule.updateMany({
        where: { id: paymentScheduleId, status: { not: "Paid" } },
        data: {
            status: "Paid",
            paymentMethod: "quickbooks",
            paidAt: payment.paidAt,
            paymentDate: payment.paidAt,
            referenceNumber: payment.referenceNumber,
            qbPaymentId: payment.qbPaymentId,
            qbSyncedAt: new Date(),
        },
    });
    if (claim.count === 0) return false;

    const invoice = await t.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return false;
    const allSchedules = await t.paymentSchedule.findMany({ where: { invoiceId } });
    const totalPaid = allSchedules
        .filter(s => s.status === "Paid")
        .reduce((sum, s) => sum + toNum(s.amount), 0);
    const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalPaid);
    await t.invoice.update({
        where: { id: invoiceId },
        data: {
            balanceDue: newBalance,
            status: newBalance <= 0 ? "Paid" : totalPaid > 0 ? "Partially Paid" : invoice.status,
        },
    });

    // Mirror the settle onto the estimate-side milestone copy so the
    // estimate editor/balance track the QuickBooks rail too (link-first,
    // name+amount fallback for pre-link rows; claimed update).
    if (invoice.estimateId) {
        const settled = allSchedules.find(s => s.id === paymentScheduleId);
        let estCopy: { id: string } | null = null;
        if (settled?.sourceScheduleId) {
            estCopy = await t.estimatePaymentSchedule.findFirst({
                where: { id: settled.sourceScheduleId, estimateId: invoice.estimateId, status: { not: "Paid" } },
            });
        } else if (settled) {
            // Fallback for pre-link rows: only safe when exactly one candidate matches.
            const candidates = await t.estimatePaymentSchedule.findMany({
                where: { estimateId: invoice.estimateId, status: { not: "Paid" }, name: settled.name },
                take: 2,
            });
            const matching = candidates.filter(c => toNum(c.amount) === toNum(settled.amount));
            estCopy = matching.length === 1 ? matching[0] : null;
        }
        if (estCopy && settled) {
            const mirrorClaim = await t.estimatePaymentSchedule.updateMany({
                where: { id: estCopy.id, status: { not: "Paid" } },
                data: {
                    status: "Paid",
                    paymentMethod: "quickbooks",
                    paidAt: payment.paidAt,
                    paymentDate: payment.paidAt,
                    referenceNumber: payment.referenceNumber,
                },
            });
            if (mirrorClaim.count > 0) {
                const estimate = await t.estimate.findUnique({ where: { id: invoice.estimateId } });
                if (estimate) {
                    const estSiblings = await t.estimatePaymentSchedule.findMany({ where: { estimateId: invoice.estimateId } });
                    const estPaid = estSiblings.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
                    const estBalance = Math.max(0, toNum(estimate.totalAmount) - estPaid);
                    const estFirstPayment = !["Paid", "Partially Paid"].includes(estimate.status);
                    await t.estimate.update({
                        where: { id: invoice.estimateId },
                        data: {
                            balanceDue: estBalance,
                            status: estBalance <= 0 ? "Paid" : estPaid > 0 ? "Partially Paid" : estimate.status,
                            ...(estFirstPayment && { statusBeforePayment: estimate.status }),
                        },
                    });
                }
            }
        }
    }
    return true;
}

/**
 * Settle ONE progress billing (src/lib/progress-billing.ts) from a QuickBooks
 * payment: claim the billing Paid, then settle every milestone line it
 * carries (custom/CO lines are materialized into a real PaymentSchedule at
 * billing-creation time — see createProgressBillingCore — so every line has a
 * scheduleId here; there is no special case). Exported (not just inlined in
 * syncQuickBooksPayments below) so it can be driven directly — by a caller
 * that already has a settlement to record, or by a test with no live
 * QuickBooks connection.
 */
export async function settleProgressBillingPaidCore(
    billingId: string,
    payment: { paidAt: Date; referenceNumber: string | null; qbPaymentId: string | null },
): Promise<boolean> {
    const billing = await prisma.progressBilling.findUnique({
        where: { id: billingId },
        select: {
            id: true,
            invoiceId: true,
            lines: { select: { scheduleId: true } },
            invoice: { select: { estimateId: true } },
        },
    });
    if (!billing) return false;

    return withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. Every line of
        // this billing shares the same invoiceId, so one lock covers them all.
        await lockMoneyParents(t, { estimateId: billing.invoice.estimateId, invoiceId: billing.invoiceId });

        const claim = await t.progressBilling.updateMany({
            where: { id: billing.id, status: { in: ["Staged", "Sent"] }, qbPaymentId: null },
            data: { status: "Paid", paidAt: payment.paidAt, qbPaymentId: payment.qbPaymentId, qbSyncedAt: new Date() },
        });
        if (claim.count === 0) return false;

        for (const line of billing.lines) {
            if (!line.scheduleId) continue; // defensive — every line should have one by creation time
            await settleMilestonePaidInTx(t, line.scheduleId, billing.invoiceId, payment);
        }
        // TODO(progress-billing): route paid-billing notifications through
        // notifyMilestonePaid in the UI pass — deliberately not enqueued here
        // (this pass ships no customer notifications, per the owner's hard
        // constraint; see PROGRESS_BILLING_REPORT.md).
        return true;
    }));
}

/**
 * Settle ONE milestone from a QuickBooks payment: claim it Paid, recompute
 * the parent invoice, mirror the estimate copy, and enqueue the paid
 * notification. Mirrors the Stripe webhook's claim-then-recalculate
 * transaction so balances never drift.
 *
 * Exported (not just the hourly sync's private helper) so the deposit-ingest
 * endpoint (src/app/api/payments/deposit-ingest/route.ts, Phase B1) can
 * settle a milestone from a deposit-triggered QuickBooks Payment the exact
 * same way the cron settles one it discovers on its own poll. Claim-once via
 * `settleMilestonePaidInTx`'s `status: { not: "Paid" }` guard: a caller that
 * loses the claim (the cron beat it to this schedule, or vice versa) gets
 * `false` back and must NOT treat that as a generic failure — re-read the
 * schedule and compare `qbPaymentId`. The same `qbPaymentId` means the OTHER
 * caller settled it with OUR OWN QuickBooks payment (deposit-ingest raced the
 * cron's poll of the payment it just created) and this is a success, not a
 * conflict; a different or absent `qbPaymentId` is a genuine conflict the
 * caller must route to manual reconciliation.
 */
export async function settleMilestoneFromQBPayment(input: {
    paymentScheduleId: string;
    invoiceId: string;
    qbPaymentId: string | null;
    paidAt: Date;
    referenceNumber: string | null;
}): Promise<boolean> {
    const { paymentScheduleId, invoiceId, ...payment } = input;
    return withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. This settle mirrors onto the
        // estimate copy, so read the estimate link (non-locking) and lock Estimate before Invoice,
        // matching recordPayment/recordEstimatePayment so overlapping settles never invert order.
        const invLink = await t.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
        await lockMoneyParents(t, { estimateId: invLink?.estimateId, invoiceId });

        const claimed = await settleMilestonePaidInTx(t, paymentScheduleId, invoiceId, payment);
        if (!claimed) return false;

        // Durable notification, enqueued in-tx (delivered by the drainer after commit).
        await enqueueMilestonePaid(t, { scheduleId: paymentScheduleId, scheduleType: "invoice" });
        return true;
    }));
}

/**
 * Reconcile a milestone's ProBuild amount to the QBO grand total, then recompute
 * the parent invoice (and mirror the estimate copy + recompute the estimate),
 * all inside one transaction.
 *
 * QBO is the system of record for what the client is actually charged. When a
 * bookkeeper edits a price/tax/discount directly in QuickBooks the QBO total
 * drifts from the ProBuild milestone; this brings ProBuild back in line so the
 * books stay truthful before the invoice is (re)sent.
 *
 * Recalc/mirror logic is modeled on `settleMilestoneFromQBPayment` above — link-first
 * via `sourceScheduleId`, single-candidate name+amount fallback for pre-link
 * rows, claimed updates that never touch a settled row. Amounts are tax-inclusive
 * so we recompute the invoice/estimate totals from the milestone amounts and
 * re-derive the invoice tax fields from the new total at the existing tax rate.
 */
export async function reconcileMilestoneToQbo(
    paymentScheduleId: string,
    qbTotal: number,
): Promise<{ ok: boolean; error?: string; oldAmount?: number; newAmount?: number; invoiceId?: string; estimateTouched?: boolean }> {
    // Round every money figure to whole cents before writing/comparing so float
    // sums of Decimal amounts can't leave sub-penny residue in balances/status.
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const newAmount = r2(qbTotal);
    // A milestone should never reconcile to $0 — a $0/negative QBO total means the
    // invoice is voided/deleted, not legitimately free. Refuse rather than zero it
    // out (which could falsely flip the parent invoice to Paid).
    if (newAmount <= 0) {
        return { ok: false, error: "QuickBooks shows a $0 total — the invoice may be voided or deleted. Re-push it before sending." };
    }
    return withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. This reconcile moves the invoice
        // amount and mirrors onto the estimate copy, so read the schedule's invoice + estimate
        // links (non-locking) and lock Estimate before Invoice before touching either balance.
        const linkRow = await t.paymentSchedule.findUnique({
            where: { id: paymentScheduleId },
            select: { invoiceId: true, invoice: { select: { estimateId: true } } },
        });
        if (linkRow) {
            await lockMoneyParents(t, { estimateId: linkRow.invoice?.estimateId, invoiceId: linkRow.invoiceId });
        }

        const schedule = await t.paymentSchedule.findUnique({ where: { id: paymentScheduleId } });
        if (!schedule) return { ok: false, error: "Milestone not found" };
        // Fast reject for an already-settled milestone — money already moved.
        if (schedule.status === "Paid" || schedule.status === "Canceled") {
            return { ok: false, error: "Cannot reconcile a paid or canceled milestone" };
        }
        if (schedule.pretaxAmount != null || schedule.taxAmount != null) {
            return {
                ok: false,
                error: "This milestone has a frozen ProBuild tax split and cannot be reconciled to a changed QuickBooks total. Void the QuickBooks invoice and rebill it in ProBuild.",
            };
        }

        const oldAmount = toNum(schedule.amount);
        // Idempotent: a re-submit with the same QBO total is a no-op.
        if (Math.abs(oldAmount - newAmount) <= 0.005) {
            return { ok: true, oldAmount, newAmount, invoiceId: schedule.invoiceId, estimateTouched: false };
        }

        // 1) Claimed update of the invoice-side amount — mirrors settleMilestoneFromQBPayment's
        //    pattern so a concurrent settle (QB sync / Stripe) that marks the row Paid
        //    between the read above and this write can't have its amount overwritten.
        const claim = await t.paymentSchedule.updateMany({
            where: { id: schedule.id, status: { notIn: ["Paid", "Canceled"] } },
            data: { amount: newAmount, qbSyncedAt: new Date() },
        });
        if (claim.count === 0) {
            return { ok: false, error: "Milestone changed status (paid or canceled) — reload and try again." };
        }

        // 2) Recompute the parent invoice (mirror settleMilestoneFromQBPayment's recalc,
        //    extended to also move totalAmount since an amount change moves the grand total).
        const invoice = await t.invoice.findUnique({ where: { id: schedule.invoiceId } });
        if (!invoice) return { ok: false, error: "Invoice not found" };
        const allSchedules = await t.paymentSchedule.findMany({ where: { invoiceId: schedule.invoiceId } });
        const newTotal = r2(allSchedules.reduce((sum, s) => sum + toNum(s.amount), 0));
        const totalPaid = r2(allSchedules.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0));
        const newBalance = Math.max(0, r2(newTotal - totalPaid));
        const splitSchedules = allSchedules.filter((row) => row.pretaxAmount != null && row.taxAmount != null);
        const legacySchedules = allSchedules.filter((row) => row.pretaxAmount == null || row.taxAmount == null);
        const storedPretax = r2(splitSchedules.reduce((sum, row) => sum + toNum(row.pretaxAmount), 0));
        const storedTax = r2(splitSchedules.reduce((sum, row) => sum + toNum(row.taxAmount), 0));
        const residualTotal = r2(legacySchedules.reduce((sum, row) => sum + toNum(row.amount), 0));
        const invoiceRate = toNum(invoice.taxRate);
        const residualTax = deriveInvoiceTaxFields(residualTotal, invoiceRate, invoiceRate <= 0);
        await t.invoice.update({
            where: { id: invoice.id },
            data: {
                totalAmount: newTotal,
                subtotal: r2(storedPretax + residualTax.subtotal),
                taxAmount: r2(storedTax + residualTax.taxAmount),
                balanceDue: newBalance,
                status: newBalance <= 0 ? "Paid" : totalPaid > 0 ? "Partially Paid" : invoice.status,
            },
        });

        // 3) Mirror onto the estimate-side copy (link-first via sourceScheduleId,
        //    name + OLD-amount fallback for pre-link rows; only touch an unpaid copy)
        //    and recompute the estimate, matching settleMilestoneFromQBPayment's mirror block.
        let estimateTouched = false;
        if (invoice.estimateId) {
            let estCopy: { id: string } | null = null;
            if (schedule.sourceScheduleId) {
                estCopy = await t.estimatePaymentSchedule.findFirst({
                    where: { id: schedule.sourceScheduleId, estimateId: invoice.estimateId, status: { not: "Paid" } },
                });
            } else {
                // Fallback for pre-link rows: match on name AND the old amount in the
                // query (not after a take:2), so 3+ same-name rows can't slip a wrong
                // single match through. Only mirror when exactly one candidate matches.
                const candidates = await t.estimatePaymentSchedule.findMany({
                    where: { estimateId: invoice.estimateId, status: { not: "Paid" }, name: schedule.name, amount: oldAmount },
                    take: 2,
                });
                estCopy = candidates.length === 1 ? candidates[0] : null;
            }
            if (estCopy) {
                const mirrorClaim = await t.estimatePaymentSchedule.updateMany({
                    where: { id: estCopy.id, status: { not: "Paid" } },
                    data: { amount: newAmount },
                });
                if (mirrorClaim.count > 0) {
                    estimateTouched = true;
                    const estimate = await t.estimate.findUnique({ where: { id: invoice.estimateId } });
                    if (estimate) {
                        const estSiblings = await t.estimatePaymentSchedule.findMany({ where: { estimateId: invoice.estimateId } });
                        const estTotal = r2(estSiblings.reduce((sum, s) => sum + toNum(s.amount), 0));
                        const estPaid = r2(estSiblings.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0));
                        const estBalance = Math.max(0, r2(estTotal - estPaid));
                        await t.estimate.update({
                            where: { id: invoice.estimateId },
                            data: {
                                totalAmount: estTotal,
                                balanceDue: estBalance,
                                status: estBalance <= 0 ? "Paid" : estPaid > 0 ? "Partially Paid" : estimate.status,
                            },
                        });
                    }
                }
            }
        }
        return { ok: true, oldAmount, newAmount, invoiceId: schedule.invoiceId, estimateTouched };
    }));
}

export interface QBPaymentSyncResult {
    checked: number;
    settled: number;
    partiallyPaid: number;
    errors: string[];
    // Progress billings (src/lib/progress-billing.ts) settled this run — a
    // separate counter from `settled` (which counts individual milestones)
    // since one progress billing can carry several milestone lines.
    progressBillingsSettled: number;
}

export type MilestoneQbSyncIssueWrite = "newly-flagged" | "refreshed" | "unchanged" | "stale";

/**
 * Commit one authoritative QBO void/not-found observation behind the same
 * parent Invoice fence used by milestone email delivery. The external probe
 * intentionally happens before this helper; after the lock is acquired we
 * re-read and exact-CAS the linked schedule so a settle, unlink, re-stage, or
 * provider-started email wins rather than being overwritten by a stale poll.
 */
export async function recordMilestoneQbSyncIssueUnderInvoiceLock(
    tx: Prisma.TransactionClient,
    input: {
        scheduleId: string;
        invoiceId: string;
        qbInvoiceId: string;
        state: "voided" | "notFound";
    },
): Promise<MilestoneQbSyncIssueWrite> {
    await lockMoneyParents(tx, { invoiceId: input.invoiceId });
    const current = await tx.paymentSchedule.findUnique({
        where: { id: input.scheduleId },
        select: {
            id: true,
            invoiceId: true,
            status: true,
            qbInvoiceId: true,
            qbSyncError: true,
        },
    });
    if (!current
        || current.invoiceId !== input.invoiceId
        || current.status !== "Pending"
        || current.qbInvoiceId !== input.qbInvoiceId) {
        return "stale";
    }
    if (current.qbSyncError === input.state) return "unchanged";

    const claim = await tx.paymentSchedule.updateMany({
        where: {
            id: current.id,
            invoiceId: current.invoiceId,
            status: current.status,
            qbInvoiceId: current.qbInvoiceId,
            qbSyncError: current.qbSyncError,
        },
        data: { qbSyncError: input.state },
    });
    if (claim.count !== 1) return "stale";
    return current.qbSyncError === null ? "newly-flagged" : "refreshed";
}

/**
 * Poll QuickBooks for settled milestone invoices and record them in ProBuild.
 * Safe to run repeatedly (cron + on-view). Never throws on a single bad row.
 */
export async function syncQuickBooksPayments(scope?: { invoiceId?: string; projectId?: string }): Promise<QBPaymentSyncResult> {
    const result: QBPaymentSyncResult = { checked: 0, settled: 0, partiallyPaid: 0, errors: [], progressBillingsSettled: 0 };

    const pending = await prisma.paymentSchedule.findMany({
        where: {
            status: "Pending",
            qbInvoiceId: { not: null },
            ...(scope?.invoiceId ? { invoiceId: scope.invoiceId } : {}),
            ...(scope?.projectId ? { invoice: { projectId: scope.projectId } } : {}),
        },
        select: {
            id: true, invoiceId: true, qbInvoiceId: true, qbSyncError: true, name: true, amount: true,
            invoice: { select: { code: true, project: { select: { id: true, name: true } }, client: { select: { name: true, email: true } } } },
        },
        take: 100,
    });

    // Progress billings (src/lib/progress-billing.ts) staged/sent to QuickBooks
    // — a second, independent pass over the same QBO connection. Milestones
    // billed through a ProgressBilling are NOT in `pending` above (billing
    // them there doesn't touch PaymentSchedule.qbInvoiceId), so this pass is
    // the only place they get settled from a QuickBooks payment.
    const pendingBillings = await prisma.progressBilling.findMany({
        where: {
            qbInvoiceId: { not: null },
            status: { in: ["Staged", "Sent"] },
            ...(scope?.invoiceId ? { invoiceId: scope.invoiceId } : {}),
            ...(scope?.projectId ? { invoice: { projectId: scope.projectId } } : {}),
        },
        select: {
            id: true, invoiceId: true, qbInvoiceId: true, code: true,
            lines: { select: { scheduleId: true } },
            invoice: { select: { code: true, estimateId: true } },
        },
        take: 100,
    });

    if (pending.length === 0 && pendingBillings.length === 0) return result;

    let tokens: QBTokens;
    try {
        tokens = await getFreshQBTokens();
    } catch (e) {
        result.errors.push(e instanceof Error ? e.message : "QB tokens unavailable");
        return result;
    }

    // Milestones whose linked QBO invoice was found voided/deleted THIS run (flag was
    // previously null). Reported once per breakage; a re-push clears the flag and re-arms.
    const newlyFlagged: QBSyncIssue[] = [];

    for (const schedule of pending) {
        result.checked++;
        try {
            const probe = await probeQBInvoice(tokens, schedule.qbInvoiceId!);
            // Transient error (token/429/5xx/network) — leave untouched and retry next run.
            if (probe.state === "error") continue;

            if (probe.state === "voided" || probe.state === "notFound") {
                // The QBO invoice is gone/voided: it can never settle. Flag so the UI can
                // surface a Break-Link recovery, and report it ONCE so a human re-issues.
                const write = await withTxRetry(() => prisma.$transaction(tx => (
                    recordMilestoneQbSyncIssueUnderInvoiceLock(tx, {
                        scheduleId: schedule.id,
                        invoiceId: schedule.invoiceId,
                        qbInvoiceId: schedule.qbInvoiceId!,
                        state: probe.state,
                    })
                )));
                if (write === "newly-flagged") {
                    newlyFlagged.push({
                        scheduleId: schedule.id,
                        invoiceId: schedule.invoiceId,
                        state: probe.state,
                        invoiceCode: schedule.invoice.code,
                        milestoneName: schedule.name,
                        projectId: schedule.invoice.project?.id ?? null,
                        projectName: schedule.invoice.project?.name ?? null,
                    });
                }
                result.errors.push(`${schedule.invoice.code}/${schedule.name}: QBO invoice ${probe.state}`);
                continue;
            }

            // probe.state === "ok"
            if (probe.total > 0 && probe.balance <= 0) {
                // Fully settled in QuickBooks (online payment OR a check Vanessa applied)
                const paymentId = probe.paymentTxnIds[0] || null;
                let paidAt = new Date();
                let referenceNumber: string | null = null;
                if (paymentId) {
                    const p = await getQBPayment(tokens, paymentId);
                    if (p?.txnDate) paidAt = new Date(`${p.txnDate}T12:00:00Z`);
                    referenceNumber = p?.referenceNumber || null;
                }
                const recorded = await settleMilestoneFromQBPayment({
                    paymentScheduleId: schedule.id,
                    invoiceId: schedule.invoiceId,
                    paidAt,
                    referenceNumber,
                    qbPaymentId: paymentId,
                });
                if (recorded) {
                    result.settled++;
                    await drainPaymentNotifications({ scheduleId: schedule.id }).catch(() => {});
                }
            } else if (probe.balance < probe.total) {
                result.partiallyPaid++;
            }
        } catch (e) {
            result.errors.push(`${schedule.invoice.code}/${schedule.name}: ${e instanceof Error ? e.message : "sync failed"}`);
        }
    }

    // ── Progress billings ───────────────────────────────────────────────────
    // Same probe → settle shape as the milestone loop above, but claims ONE
    // ProgressBilling row and settles it via settleProgressBillingPaidCore,
    // which walks every line the billing carries under a single lock+transaction
    // (custom/change-order lines were materialized into a real PaymentSchedule
    // at billing-creation time — see createProgressBillingCore — so every line
    // has a scheduleId and settles like any other milestone; no special case).
    for (const billing of pendingBillings) {
        try {
            const probe = await probeQBInvoice(tokens, billing.qbInvoiceId!);
            if (probe.state === "error") continue; // transient — retry next run
            if (probe.state === "voided" || probe.state === "notFound") {
                result.errors.push(`${billing.invoice.code}/${billing.code}: QBO invoice ${probe.state}`);
                continue;
            }
            // probe.state === "ok"
            if (probe.total > 0 && probe.balance <= 0) {
                const paymentId = probe.paymentTxnIds[0] || null;
                let paidAt = new Date();
                let referenceNumber: string | null = null;
                if (paymentId) {
                    const p = await getQBPayment(tokens, paymentId);
                    if (p?.txnDate) paidAt = new Date(`${p.txnDate}T12:00:00Z`);
                    referenceNumber = p?.referenceNumber || null;
                }
                const settled = await settleProgressBillingPaidCore(billing.id, { paidAt, referenceNumber, qbPaymentId: paymentId });
                if (settled) result.progressBillingsSettled++;
            } else if (probe.balance < probe.total) {
                result.partiallyPaid++;
            }
        } catch (e) {
            result.errors.push(`${billing.invoice.code}/${billing.code}: ${e instanceof Error ? e.message : "sync failed"}`);
        }
    }

    if (newlyFlagged.length > 0) {
        const { notifyQBSyncIssues } = await import("./payment-notifications");
        await notifyQBSyncIssues(newlyFlagged);
    }

    return result;
}
