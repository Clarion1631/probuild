import type { Prisma } from "@prisma/client";
import type { FrozenNotification } from "./email";
import type {
    ChangeOrderAutomationExecutionResult,
} from "./change-order-automation";
import { canRetryProviderAttempt } from "./change-order-automation";
import { lockMoneyParents } from "./tx-retry";
import {
    checkpointChangeOrderAutomationProviderDispatch,
    completeChangeOrderAutomationJob,
    markChangeOrderAutomationJobSkipped,
    renewChangeOrderAutomationJobLease,
    type ChangeOrderAutomationJobRecord,
} from "./change-order-automation-jobs";

type ApprovalJob = ChangeOrderAutomationJobRecord;
type Database = Pick<
    typeof import("./prisma").prisma,
    | "$transaction"
    | "changeOrderAutomationJob"
    | "changeOrder"
    | "companySettings"
    | "paymentSchedule"
    | "invoice"
    | "activityLog"
    | "invoiceEmailAttempt"
>;

type ApplySchedule = typeof import("./schedule-core").applyChangeOrderToScheduleInTransaction;
type BillChangeOrder = typeof import("./billing-core").billChangeOrderCore;
type SendMilestoneInvoices = typeof import("./billing-core").sendMilestoneInvoicesCore;
type SendFrozen = (
    dispatch: FrozenNotification,
    idempotencyKey: string,
) => Promise<{ success: true; id?: string } | { success: false; ambiguous: boolean }>;

export type ApprovalAutomationExecutionDependencies = {
    db?: Database;
    now?: () => Date;
    billChangeOrder?: BillChangeOrder;
    applySchedule?: ApplySchedule;
    isSchedulePreconditionError?: (error: unknown) => boolean;
    sendMilestoneInvoices?: SendMilestoneInvoices;
    sendFrozenNotification?: SendFrozen;
};

const APPROVAL_KINDS = [
    "APPROVAL_BILL",
    "APPROVAL_CLIENT_EMAIL",
    "APPROVAL_SCHEDULE",
    "APPROVAL_TEAM_EMAIL",
] as const;

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "SKIPPED", "CANCELED", "NEEDS_ATTENTION"]);

class AutomationFenceLostError extends Error {
    constructor(jobId: string) {
        super(`Automation claim fence was lost for ${jobId}`);
        this.name = "AutomationFenceLostError";
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function database(dependencies: ApprovalAutomationExecutionDependencies): Promise<Database> {
    return dependencies.db ?? (await import("./prisma")).prisma;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function frozenDispatch(value: unknown): FrozenNotification {
    const dispatch = jsonObject(value);
    if (
        !dispatch ||
        typeof dispatch.from !== "string" || !dispatch.from.trim() ||
        !Array.isArray(dispatch.to) || dispatch.to.length === 0 ||
        dispatch.to.some(recipient => typeof recipient !== "string" || !recipient.trim()) ||
        typeof dispatch.replyTo !== "string" || !dispatch.replyTo.trim() ||
        typeof dispatch.subject !== "string" || !dispatch.subject.trim() ||
        typeof dispatch.html !== "string" ||
        typeof dispatch.text !== "string" ||
        (dispatch.cc !== undefined && (!Array.isArray(dispatch.cc) || dispatch.cc.some(value => typeof value !== "string"))) ||
        (dispatch.bcc !== undefined && (!Array.isArray(dispatch.bcc) || dispatch.bcc.some(value => typeof value !== "string")))
    ) {
        throw new Error("Automation job contains an incomplete frozen email dispatch");
    }
    return {
        from: dispatch.from,
        to: [...dispatch.to] as string[],
        replyTo: dispatch.replyTo,
        subject: dispatch.subject,
        html: dispatch.html,
        text: dispatch.text,
        ...(dispatch.cc === undefined ? {} : { cc: [...dispatch.cc] as string[] }),
        ...(dispatch.bcc === undefined ? {} : { bcc: [...dispatch.bcc] as string[] }),
    };
}

type MilestoneState = {
    id: string;
    name: string;
    amount: number;
    status: string;
    qbInvoiceSentAt: string | null;
    qbInvoiceId: string;
    qbInvoiceLink: string | null;
    qbSyncError: string | null;
};

function milestoneStateFingerprint(invoiceId: string, milestones: MilestoneState[]): string {
    return JSON.stringify({
        invoiceId,
        milestones: [...milestones].sort((a, b) => a.id.localeCompare(b.id)),
    });
}

function milestoneStatesFromRows(rows: Array<{
    id: string;
    name: string;
    amount: unknown;
    status: string;
    qbInvoiceSentAt: Date | null;
    qbInvoiceId: string | null;
    qbInvoiceLink: string | null;
    qbSyncError: string | null;
}>): MilestoneState[] {
    return rows.map((row): MilestoneState => ({
        id: row.id,
        name: row.name,
        amount: Number(row.amount),
        status: row.status,
        qbInvoiceSentAt: row.qbInvoiceSentAt?.toISOString() ?? null,
        qbInvoiceId: row.qbInvoiceId ?? "",
        qbInvoiceLink: row.qbInvoiceLink,
        qbSyncError: row.qbSyncError,
    })).sort((a, b) => a.id.localeCompare(b.id));
}

function milestoneStatesFromJson(value: unknown): MilestoneState[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.some(state => (
        !state || typeof state !== "object" || Array.isArray(state)
        || typeof (state as Record<string, unknown>).id !== "string"
        || typeof (state as Record<string, unknown>).name !== "string"
        || typeof (state as Record<string, unknown>).amount !== "number"
        || typeof (state as Record<string, unknown>).status !== "string"
        || ((state as Record<string, unknown>).qbInvoiceSentAt !== null && typeof (state as Record<string, unknown>).qbInvoiceSentAt !== "string")
        || typeof (state as Record<string, unknown>).qbInvoiceId !== "string"
        || ((state as Record<string, unknown>).qbInvoiceLink !== null && typeof (state as Record<string, unknown>).qbInvoiceLink !== "string")
        || ((state as Record<string, unknown>).qbSyncError !== null && typeof (state as Record<string, unknown>).qbSyncError !== "string")
    ))) return null;
    return value as MilestoneState[];
}

function dispatchFromJob(job: ApprovalJob): FrozenNotification | undefined {
    const payload = jsonObject(job.payload);
    return payload?.dispatch === undefined ? undefined : frozenDispatch(payload.dispatch);
}

function uniqueIds(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== "string" || !id.trim())) {
        return null;
    }
    const ids = value as string[];
    return new Set(ids).size === ids.length ? [...ids] : null;
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length &&
        [...actual].sort().every((id, index) => id === [...expected].sort()[index]);
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function recipients(value: string | null | undefined): string[] {
    return [...new Map(
        (value ?? "")
            .split(/[,;]/)
            .map(item => item.trim())
            .filter(Boolean)
            .map(item => [item.toLowerCase(), item]),
    ).values()];
}

async function lockChangeOrderRow(
    tx: Prisma.TransactionClient,
    job: ApprovalJob,
): Promise<{ id: string; projectId: string }> {
    const lockedChangeOrder = await tx.$queryRaw<Array<{ id: string; projectId: string }>>`
        SELECT "id", "projectId" FROM "ChangeOrder" WHERE "id" = ${job.changeOrderId} FOR UPDATE
    `;
    if (!lockedChangeOrder[0]) throw new AutomationFenceLostError(job.id);
    return lockedChangeOrder[0];
}

async function lockClaimedJob(
    tx: Prisma.TransactionClient,
    job: ApprovalJob,
): Promise<ChangeOrderAutomationJobRecord> {
    await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ChangeOrderAutomationJob" WHERE "id" = ${job.id} FOR UPDATE
    `;
    const current = await tx.changeOrderAutomationJob.findUnique({ where: { id: job.id } });
    if (!current || current.status !== "PROCESSING" || !job.claimToken || current.claimToken !== job.claimToken) {
        throw new AutomationFenceLostError(job.id);
    }
    return current;
}

async function lockChangeOrderAndClaim(
    tx: Prisma.TransactionClient,
    job: ApprovalJob,
): Promise<ChangeOrderAutomationJobRecord> {
    await lockChangeOrderRow(tx, job);
    return lockClaimedJob(tx, job);
}

async function lockClientDeliveryParentsAndClaim(
    tx: Prisma.TransactionClient,
    job: ApprovalJob,
    invoiceId: string,
    options: {
        allowInvoiceEmailAttemptKey?: string | null;
        expectedFirstAttemptDispatch?: FrozenNotification;
    },
): Promise<void> {
    // This first read is a routing hint only. Every routing/recipient value is
    // re-read after its owning row is locked. The global order is:
    // Project -> ChangeOrder -> Estimate -> Invoice -> InvoiceEmailAttempt
    // -> Invoice Client -> CompanySettings -> automation job.
    const routing = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { estimateId: true, projectId: true, clientId: true },
    });
    if (!routing) throw new Error("Invoice disappeared before client delivery");

    const [project] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Project" WHERE "id" = ${routing.projectId} FOR SHARE
    `;
    if (!project) throw new Error("Invoice project disappeared before client delivery");
    const changeOrder = await lockChangeOrderRow(tx, job);
    if (changeOrder.projectId !== project.id) {
        throw new Error("Change order and invoice no longer belong to the same project");
    }
    await lockMoneyParents(tx, {
        estimateId: routing.estimateId,
        invoiceId,
        allowInvoiceEmailAttemptKey: options.allowInvoiceEmailAttemptKey,
    });
    const lockedInvoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { estimateId: true, projectId: true, clientId: true },
    });
    if (!lockedInvoice
        || lockedInvoice.estimateId !== routing.estimateId
        || lockedInvoice.projectId !== project.id) {
        throw new Error("Invoice routing changed while acquiring the provider fence; retry from fresh state");
    }

    if (options.expectedFirstAttemptDispatch) {
        // Reuse the milestone delivery seam's canonical To/CC/BCC calculation.
        // It locks the required Invoice client and CompanySettings singleton
        // FOR SHARE, and those locks remain held through our job checkpoint.
        const {
            completeFrozenRecipientConflictError,
            lockInvoiceDeliveryRecipientSet,
        } = await import("./billing-core");
        const lockedRecipients = await lockInvoiceDeliveryRecipientSet(tx, {
            clientId: lockedInvoice.clientId,
        });
        const recipientConflict = completeFrozenRecipientConflictError({
            expected: options.expectedFirstAttemptDispatch,
            current: lockedRecipients.complete,
        });
        if (recipientConflict) throw new Error(recipientConflict);
    }
    await lockClaimedJob(tx, job);
}

async function lockScheduleParentsAndClaim(
    tx: Prisma.TransactionClient,
    job: ApprovalJob,
): Promise<ChangeOrderAutomationJobRecord> {
    const coRef = await tx.changeOrder.findUnique({ where: { id: job.changeOrderId }, select: { projectId: true } });
    if (!coRef) throw new AutomationFenceLostError(job.id);
    // schedule-core's canonical parent order is Project -> ChangeOrder. Taking
    // the same locks before the job prevents a schedule worker from inverting
    // that order while still fencing its terminal transition.
    await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Project" WHERE "id" = ${coRef.projectId} FOR UPDATE
    `;
    return lockChangeOrderAndClaim(tx, job);
}

async function completeInsideTransaction(
    tx: Prisma.TransactionClient,
    job: ApprovalJob,
    input: { result: Prisma.InputJsonObject; providerMessageId?: string; now: Date },
): Promise<void> {
    const completed = await completeChangeOrderAutomationJob(tx, {
        jobId: job.id,
        claimToken: job.claimToken!,
        result: input.result,
        ...(input.providerMessageId === undefined ? {} : { providerMessageId: input.providerMessageId }),
        now: input.now,
    });
    if (!completed) throw new AutomationFenceLostError(job.id);
}

/**
 * Dependency ordering for the approval graph. Failed terminal prerequisites are
 * also eligible so their dependent can end in NEEDS_ATTENTION instead of
 * remaining PENDING forever.
 */
export async function isApprovalAutomationJobEligible(
    job: ApprovalJob,
    dependencies: Pick<ApprovalAutomationExecutionDependencies, "db"> = {},
): Promise<boolean> {
    if (!APPROVAL_KINDS.includes(job.kind as (typeof APPROVAL_KINDS)[number])) return false;
    if (job.kind === "APPROVAL_BILL") return true;
    const db = await database(dependencies);
    if (job.kind === "APPROVAL_SCHEDULE") {
        const billing = await billingPrerequisite(db, job);
        // Cost-plus approvals have no BILL node. Fixed-price schedule merging
        // must wait until BILL is terminal so billed milestone clones exist and
        // can be linked during the single convergent schedule pass.
        return !billing || TERMINAL_STATUSES.has(billing.status);
    }
    if (job.kind === "APPROVAL_CLIENT_EMAIL") {
        const billing = await db.changeOrderAutomationJob.findFirst({
            where: {
                changeOrderId: job.changeOrderId,
                eventRevision: job.eventRevision,
                kind: "APPROVAL_BILL",
            },
        });
        return Boolean(billing && TERMINAL_STATUSES.has(billing.status));
    }

    const siblings = await db.changeOrderAutomationJob.findMany({
        where: {
            changeOrderId: job.changeOrderId,
            eventRevision: job.eventRevision,
            kind: { in: ["APPROVAL_BILL", "APPROVAL_CLIENT_EMAIL", "APPROVAL_SCHEDULE"] },
        },
    });
    return siblings.length > 0 && siblings.every(sibling => TERMINAL_STATUSES.has(sibling.status));
}

async function executeBill(
    job: ApprovalJob,
    dependencies: ApprovalAutomationExecutionDependencies,
): Promise<ChangeOrderAutomationExecutionResult> {
    const db = await database(dependencies);
    const renewed = await renewChangeOrderAutomationJobLease(db, {
        jobId: job.id,
        claimToken: job.claimToken!,
        now: dependencies.now?.() ?? new Date(),
    });
    if (!renewed) return { kind: "retry", error: `Automation claim fence was lost for ${job.id}` };
    const billChangeOrder = dependencies.billChangeOrder ?? (await import("./billing-core")).billChangeOrderCore;
    const bill = await billChangeOrder(job.changeOrderId, {
        logActivity: async () => undefined,
        revalidatePath: () => undefined,
    });
    if (!bill.ok) return { kind: "retry", error: bill.error };
    if (!Array.isArray(bill.milestones) || bill.milestones.length === 0) {
        return { kind: "needs-attention", error: "Billing completed without an exact milestone set" };
    }
    const milestoneIds = uniqueIds(bill.milestones.map(milestone => milestone.id));
    if (!milestoneIds) return { kind: "needs-attention", error: "Billing returned an invalid milestone set" };
    const now = dependencies.now?.() ?? new Date();

    try {
        await db.$transaction(async tx => {
            await lockChangeOrderAndClaim(tx, job);
            const changeOrder = await tx.changeOrder.findUnique({
                where: { id: job.changeOrderId },
                select: { projectId: true },
            });
            await tx.activityLog.create({
                data: {
                    projectId: changeOrder?.projectId ?? null,
                    actorType: "SYSTEM",
                    actorName: "Change-order approval automation",
                    action: "billed_change_order",
                    entityType: "invoice",
                    entityId: bill.invoiceId,
                    entityName: `Invoice ${bill.invoiceCode}`,
                    metadata: JSON.stringify({
                        automationJobId: job.id,
                        changeOrderId: job.changeOrderId,
                        eventRevision: job.eventRevision,
                        milestoneIds,
                        alreadyBilled: bill.alreadyBilled,
                        amount: bill.amount,
                    }),
                },
            });
            await completeInsideTransaction(tx, job, {
                result: {
                    invoiceId: bill.invoiceId,
                    invoiceCode: bill.invoiceCode,
                    milestoneIds,
                    milestones: bill.milestones.map(milestone => ({
                        id: milestone.id,
                        name: milestone.name,
                        amount: milestone.amount,
                        status: milestone.status,
                        created: milestone.created,
                    })),
                    alreadyBilled: bill.alreadyBilled,
                    amount: bill.amount,
                },
                now,
            });
        }, { timeout: 15_000 });
        return { kind: "completed" };
    } catch (error) {
        return { kind: "retry", error: errorText(error) };
    }
}

async function executeSchedule(
    job: ApprovalJob,
    dependencies: ApprovalAutomationExecutionDependencies,
): Promise<ChangeOrderAutomationExecutionResult> {
    const db = await database(dependencies);
    const billing = await billingPrerequisite(db, job);
    if (billing && !TERMINAL_STATUSES.has(billing.status)) {
        return { kind: "retry", error: "Waiting for approval billing to finish" };
    }
    if (billing && billing.status !== "SUCCEEDED") {
        return {
            kind: "needs-attention",
            error: `Schedule automation blocked because billing ended ${billing.status}`,
        };
    }
    const scheduleModule = dependencies.applySchedule && dependencies.isSchedulePreconditionError
        ? null
        : await import("./schedule-core");
    const applySchedule = dependencies.applySchedule ?? scheduleModule!.applyChangeOrderToScheduleInTransaction;
    const isPrecondition = dependencies.isSchedulePreconditionError ??
        ((error: unknown) => error instanceof scheduleModule!.CoSchedulePreconditionError);
    const now = dependencies.now?.() ?? new Date();

    try {
        await db.$transaction(async tx => {
            await lockScheduleParentsAndClaim(tx, job);
            try {
                const applied = await applySchedule(tx, {
                    changeOrderId: job.changeOrderId,
                    mode: "merge",
                    actor: { type: "SYSTEM", name: "Change-order approval automation" },
                });
                await completeInsideTransaction(tx, job, {
                    result: {
                        projectId: applied.projectId,
                        changeOrderCode: applied.changeOrderCode,
                        createdTaskIds: applied.created.map(task => task.id),
                        skipped: applied.skipped,
                        milestonesLinked: applied.milestonesLinked,
                        notes: applied.notes,
                    },
                    now,
                });
            } catch (error) {
                if (!isPrecondition(error)) throw error;
                const skipped = await markChangeOrderAutomationJobSkipped(tx, {
                    jobId: job.id,
                    claimToken: job.claimToken!,
                    result: { reason: errorText(error) },
                    now,
                });
                if (!skipped) throw new AutomationFenceLostError(job.id);
            }
        }, { timeout: 15_000 });
        return { kind: "completed" };
    } catch (error) {
        return { kind: "retry", error: errorText(error) };
    }
}

async function billingPrerequisite(db: Database, job: ApprovalJob) {
    return db.changeOrderAutomationJob.findFirst({
        where: {
            changeOrderId: job.changeOrderId,
            eventRevision: job.eventRevision,
            kind: "APPROVAL_BILL",
        },
    });
}

async function deliverClientFrozenDispatch(input: {
    db: Database;
    job: ApprovalJob;
    invoiceId: string;
    invoiceCode: string;
    milestoneIds: string[];
    milestoneFingerprint: string;
    milestones: MilestoneState[];
    dispatch: FrozenNotification;
    sendFrozen: SendFrozen;
    now: () => Date;
}): Promise<ChangeOrderAutomationExecutionResult> {
    const attemptAt = input.now();
    if (!canRetryProviderAttempt(input.job.firstProviderAttemptAt, attemptAt)) {
        return {
            kind: "needs-attention",
            error: "Client payment request exceeded the provider idempotency horizon; verify delivery before any manual action",
        };
    }
    const existingAttempt = await input.db.invoiceEmailAttempt.findUnique({
        where: { invoiceId: input.invoiceId },
        select: { attemptKey: true, kind: true },
    });
    if (existingAttempt
        && (existingAttempt.kind !== "APPROVAL_MILESTONE" || existingAttempt.attemptKey !== input.job.idempotencyKey)) {
        return { kind: "retry", error: "Another invoice email has a provider-started outcome; reconcile it before approval delivery." };
    }
    // The job checkpoint is the durable provider-started authority. The
    // InvoiceEmailAttempt should normally exist with it, but recovery must not
    // consult mutable recipients even if that auxiliary fence needs rebuilding.
    const providerAlreadyStarted = Boolean(input.job.firstProviderAttemptAt || existingAttempt);
    const checkpoint = await input.db.$transaction(async tx => {
        await lockClientDeliveryParentsAndClaim(tx, input.job, input.invoiceId, {
            allowInvoiceEmailAttemptKey: existingAttempt?.attemptKey,
            ...(providerAlreadyStarted ? {} : { expectedFirstAttemptDispatch: input.dispatch }),
        });
        const liveRows = await tx.paymentSchedule.findMany({
            where: { invoiceId: input.invoiceId, id: { in: input.milestoneIds } },
            select: { id: true, name: true, amount: true, status: true, qbInvoiceSentAt: true, qbInvoiceId: true, qbInvoiceLink: true, qbSyncError: true },
        });
        if (liveRows.length !== input.milestoneIds.length
            || milestoneStateFingerprint(input.invoiceId, milestoneStatesFromRows(liveRows)) !== input.milestoneFingerprint) {
            throw new Error("Milestone state changed after billing preflight; no client email was sent");
        }
        const recorded = await checkpointChangeOrderAutomationProviderDispatch(tx, {
            jobId: input.job.id,
            claimToken: input.job.claimToken!,
            dispatch: input.dispatch,
            payload: {
                invoiceId: input.invoiceId,
                milestoneIds: input.milestoneIds,
                milestoneFingerprint: input.milestoneFingerprint,
                milestones: input.milestones,
            },
            now: attemptAt,
        });
        if (!recorded) return null;
        if (!existingAttempt) {
            await tx.invoiceEmailAttempt.create({
                data: {
                    invoiceId: input.invoiceId,
                    kind: "APPROVAL_MILESTONE",
                    attemptKey: input.job.idempotencyKey,
                    payload: {
                        dispatch: input.dispatch,
                        recipients: { to: input.dispatch.to, cc: input.dispatch.cc ?? [] },
                        financialFingerprint: input.milestoneFingerprint,
                        milestoneIds: input.milestoneIds,
                        milestones: input.milestones,
                    } as unknown as Prisma.InputJsonObject,
                    startedAt: attemptAt,
                    providerStartedAt: attemptAt,
                },
            });
        }
        return recorded;
    }, { timeout: 15_000 });
    if (!checkpoint) return { kind: "retry", error: `Automation claim fence was lost for ${input.job.id}` };
    const authoritative = frozenDispatch(jsonObject(checkpoint.payload)?.dispatch);
    if (authoritative.to.length !== 1) {
        return { kind: "needs-attention", error: "Frozen client dispatch must contain exactly one primary recipient" };
    }

    try {
        return await input.db.$transaction(async tx => {
            await lockClientDeliveryParentsAndClaim(tx, input.job, input.invoiceId, {
                allowInvoiceEmailAttemptKey: input.job.idempotencyKey,
                // Once providerStartedAt exists, recipient bytes are immutable.
                // Do not revalidate mutable contacts on retry.
            });
            const attempt = await tx.invoiceEmailAttempt.findUnique({ where: { invoiceId: input.invoiceId } });
            if (!attempt
                || attempt.kind !== "APPROVAL_MILESTONE"
                || attempt.attemptKey !== input.job.idempotencyKey
                || !attempt.providerStartedAt) {
                throw new Error("Approval milestone provider checkpoint is missing or invalid");
            }
            const liveRows = await tx.paymentSchedule.findMany({
                where: { invoiceId: input.invoiceId, id: { in: input.milestoneIds } },
                select: { id: true, name: true, amount: true, status: true, qbInvoiceSentAt: true, qbInvoiceId: true, qbInvoiceLink: true, qbSyncError: true },
            });
            if (liveRows.length !== input.milestoneIds.length
                || milestoneStateFingerprint(input.invoiceId, milestoneStatesFromRows(liveRows)) !== input.milestoneFingerprint) {
                throw new Error("Milestone state changed at the provider fence; no client email was sent");
            }

            let provider: Awaited<ReturnType<SendFrozen>>;
            try {
                provider = await input.sendFrozen(authoritative, input.job.idempotencyKey);
            } catch (error) {
                throw new Error(`Client email provider outcome is ambiguous (${errorText(error)}); retry only this same frozen payload/key`);
            }
            if (!provider.success) {
                if (provider.ambiguous) {
                    throw new Error("Client email provider outcome is ambiguous; retry only this same frozen payload/key");
                }
                await tx.invoiceEmailAttempt.delete({ where: { invoiceId: input.invoiceId } });
                return {
                    kind: "retry" as const,
                    error: "Client email provider rejected the payment request",
                    retainFrozenPayloadForReconciliation: false,
                };
            }
            if (!provider.id?.trim()) {
                throw new Error("Client email was accepted without a durable provider message id; retry only this same frozen payload/key");
            }

            const sentAt = input.now();
            for (const state of input.milestones) {
                const stamped = await tx.paymentSchedule.updateMany({
                    where: {
                        id: state.id,
                        invoiceId: input.invoiceId,
                        name: state.name,
                        amount: state.amount,
                        status: state.status,
                        qbInvoiceSentAt: state.qbInvoiceSentAt ? new Date(state.qbInvoiceSentAt) : null,
                        qbInvoiceId: state.qbInvoiceId,
                        qbInvoiceLink: state.qbInvoiceLink,
                        qbSyncError: state.qbSyncError,
                    },
                    data: { qbInvoiceSentAt: sentAt },
                });
                if (stamped.count !== 1) throw new Error("Not every exact billed milestone could be stamped as sent");
            }
            await tx.invoice.updateMany({
                where: { id: input.invoiceId, status: "Draft" },
                data: { status: "Issued", issueDate: sentAt },
            });
            const changeOrder = await tx.changeOrder.findUnique({
                where: { id: input.job.changeOrderId },
                select: { projectId: true },
            });
            await tx.activityLog.create({
                data: {
                    projectId: changeOrder?.projectId ?? null,
                    actorType: "SYSTEM",
                    actorName: "Change-order approval automation",
                    action: "sent_invoice",
                    entityType: "invoice",
                    entityId: input.invoiceId,
                    entityName: `Invoice ${input.invoiceCode}`,
                    metadata: JSON.stringify({
                        automationJobId: input.job.id,
                        changeOrderId: input.job.changeOrderId,
                        eventRevision: input.job.eventRevision,
                        milestoneIds: input.milestoneIds,
                        sentTo: authoritative.to[0],
                        providerMessageId: provider.id,
                    }),
                },
            });
            await completeInsideTransaction(tx, input.job, {
                result: {
                    invoiceId: input.invoiceId,
                    milestoneIds: input.milestoneIds,
                    sentTo: authoritative.to[0],
                    sentAt: sentAt.toISOString(),
                },
                providerMessageId: provider.id,
                now: sentAt,
            });
            await tx.invoiceEmailAttempt.delete({ where: { invoiceId: input.invoiceId } });
            return { kind: "completed" as const };
        }, { timeout: 45_000 });
    } catch (error) {
        return {
            kind: "retry",
            error: errorText(error),
        };
    }
}

async function executeClientEmail(
    job: ApprovalJob,
    dependencies: ApprovalAutomationExecutionDependencies,
): Promise<ChangeOrderAutomationExecutionResult> {
    const db = await database(dependencies);
    if (job.approvalMode !== "CLIENT") {
        return { kind: "needs-attention", error: "A manual approval must never have a client-email automation job" };
    }
    const billing = await billingPrerequisite(db, job);
    if (!billing || !TERMINAL_STATUSES.has(billing.status)) {
        return { kind: "retry", error: "Waiting for approval billing to finish" };
    }
    if (billing.status !== "SUCCEEDED") {
        return {
            kind: "needs-attention",
            error: `Client payment request blocked because billing ended ${billing.status}`,
        };
    }
    const billingResult = jsonObject(billing.result);
    const invoiceId = typeof billingResult?.invoiceId === "string" ? billingResult.invoiceId : null;
    const invoiceCode = typeof billingResult?.invoiceCode === "string" ? billingResult.invoiceCode : invoiceId;
    const milestoneIds = uniqueIds(billingResult?.milestoneIds);
    if (!invoiceId || !milestoneIds) {
        return { kind: "needs-attention", error: "Billing result is missing the exact invoice milestone set" };
    }
    const clock = () => dependencies.now?.() ?? new Date();
    const now = clock();
    if (!canRetryProviderAttempt(job.firstProviderAttemptAt, now)) {
        return {
            kind: "needs-attention",
            error: "Client payment request exceeded the provider idempotency horizon; verify delivery before any manual action",
        };
    }

    let existingDispatch: FrozenNotification | undefined;
    try {
        existingDispatch = dispatchFromJob(job);
    } catch (error) {
        return { kind: "needs-attention", error: errorText(error) };
    }
    const sendFrozen = dependencies.sendFrozenNotification ?? (await import("./email")).sendFrozenNotification;

    // Once a provider attempt is checkpointed, replay the immutable dispatch
    // directly. Re-running the mutable invoice/QBO preflight could suppress a
    // retry after a recipient/status change or produce different bytes.
    if (existingDispatch) {
        const checkpointPayload = jsonObject(job.payload);
        const checkpointInvoiceId = typeof checkpointPayload?.invoiceId === "string"
            ? checkpointPayload.invoiceId
            : null;
        const checkpointMilestoneIds = uniqueIds(checkpointPayload?.milestoneIds);
        const checkpointMilestoneFingerprint = typeof checkpointPayload?.milestoneFingerprint === "string"
            ? checkpointPayload.milestoneFingerprint
            : null;
        const checkpointMilestones = milestoneStatesFromJson(checkpointPayload?.milestones);
        if (!checkpointInvoiceId || !checkpointMilestoneIds || !checkpointMilestoneFingerprint || !checkpointMilestones) {
            return {
                kind: "needs-attention",
                error: "Frozen client dispatch is missing its checkpointed invoice milestone set",
            };
        }
        if (checkpointInvoiceId !== invoiceId || !sameIds(checkpointMilestoneIds, milestoneIds)) {
            return {
                kind: "needs-attention",
                error: "Frozen client checkpoint no longer matches the immutable billing result; verify delivery before any action",
            };
        }
        return deliverClientFrozenDispatch({
            db,
            job,
            invoiceId: checkpointInvoiceId,
            invoiceCode: invoiceCode ?? invoiceId,
            milestoneIds: checkpointMilestoneIds,
            milestoneFingerprint: checkpointMilestoneFingerprint,
            milestones: checkpointMilestones,
            dispatch: existingDispatch,
            sendFrozen,
            now: clock,
        });
    }

    const sendMilestoneInvoices = dependencies.sendMilestoneInvoices ??
        (await import("./billing-core")).sendMilestoneInvoicesCore;

    try {
        let stagedDispatch: FrozenNotification | null = null;
        let providerOutcome: ChangeOrderAutomationExecutionResult | null = null;
        const delivery = await sendMilestoneInvoices(
            invoiceId,
            [...milestoneIds],
            undefined,
            undefined,
            "Change-order approval automation",
            {
                idempotencyKey: job.idempotencyKey,
                expectedScheduleIds: [...milestoneIds],
                renewBeforeSideEffect: async () => Boolean(await renewChangeOrderAutomationJobLease(db, {
                    jobId: job.id,
                    claimToken: job.claimToken!,
                    now: clock(),
                })),
                persistFrozenNotification: async candidate => {
                    // This is a preflight staging callback, not the provider
                    // checkpoint. The billing core only exposes its exact
                    // sendable IDs in completeAfterDelivery, so the durable
                    // checkpoint happens there immediately before the real send.
                    stagedDispatch = candidate;
                    return candidate;
                },
                sendFrozenNotification: async (dispatch, idempotencyKey) => {
                    if (idempotencyKey !== job.idempotencyKey) {
                        throw new Error("Milestone preflight changed the automation idempotency key");
                    }
                    stagedDispatch = dispatch;
                    // Defer the actual provider call until completeAfterDelivery
                    // reveals and validates the sendable milestone IDs.
                    return { success: true, id: `preflight-only/${job.id}` };
                },
                completeAfterDelivery: async delivered => {
                    if (delivered.invoiceId !== invoiceId || !sameIds(delivered.scheduleIds, milestoneIds)) {
                        providerOutcome = {
                            kind: "retry",
                            error: "Billing preflight did not preserve the exact billed milestone set; no client email was sent",
                        };
                        throw new Error("Provider completion did not contain the exact billed milestone set");
                    }
                    if (!delivered.recipient.trim()) throw new Error("Provider completion is missing the client recipient");
                    if (!delivered.milestoneFingerprint || !delivered.milestones) {
                        throw new Error("Provider completion is missing the exact milestone state fingerprint");
                    }
                    if (!stagedDispatch) throw new Error("Milestone preflight did not produce a frozen dispatch");
                    providerOutcome = await deliverClientFrozenDispatch({
                        db,
                        job,
                        invoiceId,
                        invoiceCode: invoiceCode ?? invoiceId,
                        milestoneIds,
                        milestoneFingerprint: delivered.milestoneFingerprint,
                        milestones: delivered.milestones,
                        dispatch: stagedDispatch,
                        sendFrozen,
                        now: clock,
                    });
                    if (providerOutcome.kind !== "completed") {
                        throw new Error(
                            "error" in providerOutcome
                                ? providerOutcome.error
                                : "Client payment request did not complete",
                        );
                    }
                },
            },
        );

        const current = await db.changeOrderAutomationJob.findUnique({ where: { id: job.id } });
        if (current?.status === "SUCCEEDED") return { kind: "completed" };
        if (providerOutcome) return providerOutcome;
        if (delivery.deliveredButUnrecorded) {
            return {
                kind: "retry",
                error: "Client email was accepted but its atomic bookkeeping did not commit; retry only this same job/key",
            };
        }
        if (delivery.deliveryAmbiguous) {
            return {
                kind: "retry",
                error: "Client email provider outcome is ambiguous; retry only this same frozen payload/key",
            };
        }
        const errors = delivery.results.map(result => result.error).filter((value): value is string => Boolean(value));
        return {
            kind: "retry",
            error: delivery.error || errors.join("; ") || "Client payment request did not complete",
        };
    } catch (error) {
        return { kind: "retry", error: errorText(error) };
    }
}

type TeamSummary = {
    billing: string;
    client: string;
    schedule: string;
};

function siblingByKind(siblings: ChangeOrderAutomationJobRecord[], kind: string) {
    return siblings.find(sibling => sibling.kind === kind);
}

function terminalLabel(job: ChangeOrderAutomationJobRecord | undefined, success: string, skipped: string): string {
    if (!job) return skipped;
    if (job.status === "SUCCEEDED") return success;
    if (job.status === "SKIPPED" || job.status === "CANCELED") return skipped;
    return `requires attention (${job.status.toLowerCase().replace(/_/g, " ")})`;
}

function teamSummary(job: ApprovalJob, siblings: ChangeOrderAutomationJobRecord[]): TeamSummary {
    const billing = siblingByKind(siblings, "APPROVAL_BILL");
    const client = siblingByKind(siblings, "APPROVAL_CLIENT_EMAIL");
    const schedule = siblingByKind(siblings, "APPROVAL_SCHEDULE");
    return {
        billing: billing
            ? terminalLabel(billing, "completed", "skipped")
            : "awaiting actual costs (cost-plus)",
        client: job.approvalMode === "MANUAL"
            ? "suppressed (manual staff approval; no client signature or client email)"
            : terminalLabel(client, "delivered", "not delivered"),
        schedule: terminalLabel(schedule, "applied", "skipped"),
    };
}

function teamSummaryHtml(input: {
    companyName: string;
    changeOrderCode: string;
    changeOrderTitle: string;
    projectName: string;
    approvalMode: string | null;
    summary: TeamSummary;
}): string {
    return `<!doctype html><html><body>
        <h2>${escapeHtml(input.changeOrderCode)} approved</h2>
        <p><strong>${escapeHtml(input.changeOrderTitle)}</strong> — ${escapeHtml(input.projectName)}</p>
        <p>Approval: ${input.approvalMode === "MANUAL" ? "manual staff approval" : "client portal approval"}</p>
        <ul>
            <li>Billing: ${escapeHtml(input.summary.billing)}</li>
            <li>Client payment request: ${escapeHtml(input.summary.client)}</li>
            <li>Schedule: ${escapeHtml(input.summary.schedule)}</li>
        </ul>
        <p>This summary reports each independent durable automation result; a warning above requires staff review.</p>
        <p>${escapeHtml(input.companyName)}</p>
    </body></html>`;
}

async function executeTeamEmail(
    job: ApprovalJob,
    dependencies: ApprovalAutomationExecutionDependencies,
): Promise<ChangeOrderAutomationExecutionResult> {
    const db = await database(dependencies);
    const siblings = await db.changeOrderAutomationJob.findMany({
        where: {
            changeOrderId: job.changeOrderId,
            eventRevision: job.eventRevision,
            kind: { in: ["APPROVAL_BILL", "APPROVAL_CLIENT_EMAIL", "APPROVAL_SCHEDULE"] },
        },
    });
    if (siblings.length === 0 || siblings.some(sibling => !TERMINAL_STATUSES.has(sibling.status))) {
        return { kind: "retry", error: "Waiting for approval automation siblings to finish" };
    }
    const now = dependencies.now?.() ?? new Date();
    if (!canRetryProviderAttempt(job.firstProviderAttemptAt, now)) {
        return {
            kind: "needs-attention",
            error: "Team approval summary exceeded the provider idempotency horizon; verify delivery before any manual action",
        };
    }
    let existingDispatch: FrozenNotification | undefined;
    try {
        existingDispatch = dispatchFromJob(job);
    } catch (error) {
        return { kind: "needs-attention", error: errorText(error) };
    }
    const [changeOrder, settingsHint] = await Promise.all([
        db.changeOrder.findUnique({
            where: { id: job.changeOrderId },
            select: { code: true, title: true, projectId: true, project: { select: { name: true } } },
        }),
        db.companySettings.findUnique({
            where: { id: "singleton" },
            select: { companyName: true, notificationEmail: true, email: true },
        }),
    ]);
    if (!changeOrder) return { kind: "needs-attention", error: "Change order no longer exists" };
    const summary = teamSummary(job, siblings);

    let dispatch: FrozenNotification;
    try {
        if (existingDispatch) {
            if (!job.firstProviderAttemptAt) {
                return { kind: "needs-attention", error: "Frozen team dispatch is missing its provider-started checkpoint" };
            }
            dispatch = existingDispatch;
            const checkpoint = await checkpointChangeOrderAutomationProviderDispatch(db, {
                jobId: job.id,
                claimToken: job.claimToken!,
                dispatch,
                payload: { summary },
                now: dependencies.now?.() ?? new Date(),
            });
            if (!checkpoint) throw new AutomationFenceLostError(job.id);
            dispatch = frozenDispatch(jsonObject(checkpoint.payload)?.dispatch);
        } else {
            const { buildFrozenNotification } = await import("./email");
            // settingsHint is deliberately non-authoritative. A settings update
            // may commit after this optimistic read; the transaction below takes
            // CompanySettings FOR SHARE, re-reads every provider-visible field,
            // builds the dispatch, and checkpoints before releasing that lock.
            void settingsHint;
            const prepared = await db.$transaction(async tx => {
                // TEAM lock order: ChangeOrder -> CompanySettings -> job. The
                // ordinary settings writers touch only CompanySettings, while
                // scope writers take ChangeOrder -> job, so neither is inverted.
                await lockChangeOrderRow(tx, job);
                const lockedChangeOrder = await tx.changeOrder.findUnique({
                    where: { id: job.changeOrderId },
                    select: { code: true, title: true, projectId: true, project: { select: { name: true } } },
                });
                if (!lockedChangeOrder) throw new Error("Change order no longer exists");
                const [lockedSettings] = await tx.$queryRaw<Array<{
                    companyName: string;
                    notificationEmail: string | null;
                    email: string | null;
                }>>`
                    SELECT "companyName", "notificationEmail", "email"
                    FROM "CompanySettings" WHERE "id" = 'singleton' FOR SHARE
                `;
                await lockClaimedJob(tx, job);
                const to = recipients(lockedSettings?.notificationEmail?.trim() || lockedSettings?.email?.trim());
                if (to.length === 0) {
                    const skipped = await markChangeOrderAutomationJobSkipped(tx, {
                        jobId: job.id,
                        claimToken: job.claimToken!,
                        result: { reason: "No team notification email is configured", summary },
                        now,
                    });
                    if (!skipped) throw new AutomationFenceLostError(job.id);
                    return { kind: "skipped" as const };
                }
                const companyName = lockedSettings?.companyName?.trim() || "Golden Touch Remodeling";
                const candidate = buildFrozenNotification({
                    to,
                    subject: `${companyName} — ${lockedChangeOrder.code} approval automation summary`,
                    html: teamSummaryHtml({
                        companyName,
                        changeOrderCode: lockedChangeOrder.code,
                        changeOrderTitle: lockedChangeOrder.title,
                        projectName: lockedChangeOrder.project?.name ?? "Project",
                        approvalMode: job.approvalMode,
                        summary,
                    }),
                    fromName: companyName,
                    replyTo: lockedSettings?.email || undefined,
                });
                const checkpoint = await checkpointChangeOrderAutomationProviderDispatch(tx, {
                    jobId: job.id,
                    claimToken: job.claimToken!,
                    dispatch: candidate,
                    payload: { summary },
                    now: dependencies.now?.() ?? new Date(),
                });
                if (!checkpoint) throw new AutomationFenceLostError(job.id);
                return {
                    kind: "dispatch" as const,
                    dispatch: frozenDispatch(jsonObject(checkpoint.payload)?.dispatch),
                };
            }, { timeout: 15_000 });
            if (prepared.kind === "skipped") return { kind: "completed" };
            dispatch = prepared.dispatch;
        }
    } catch (error) {
        return { kind: "retry", error: errorText(error) };
    }

    const sendFrozen = dependencies.sendFrozenNotification ?? (await import("./email")).sendFrozenNotification;
    let provider: Awaited<ReturnType<SendFrozen>>;
    try {
        provider = await sendFrozen(dispatch, job.idempotencyKey);
    } catch (error) {
        return {
            kind: "retry",
            error: `Team approval summary provider outcome is ambiguous (${errorText(error)}); retry only this same frozen payload/key`,
        };
    }
    if (!provider.success) {
        return {
            kind: "retry",
            error: provider.ambiguous
                ? "Team approval summary provider outcome is ambiguous; retry only this same frozen payload/key"
                : "Team approval summary provider rejected the request",
            retainFrozenPayloadForReconciliation: provider.ambiguous,
        };
    }
    if (!provider.id?.trim()) {
        return {
            kind: "retry",
            error: "Team approval summary was accepted without a durable provider message id; retry only this same frozen payload/key",
        };
    }

    try {
        await db.$transaction(async tx => {
            await lockChangeOrderAndClaim(tx, job);
            await tx.activityLog.create({
                data: {
                    projectId: changeOrder.projectId,
                    actorType: "SYSTEM",
                    actorName: "Change-order approval automation",
                    action: "notified_change_order_approval_team",
                    entityType: "change_order",
                    entityId: job.changeOrderId,
                    entityName: `${changeOrder.code} — ${changeOrder.title}`,
                    metadata: JSON.stringify({
                        automationJobId: job.id,
                        eventRevision: job.eventRevision,
                        recipients: dispatch.to,
                        providerMessageId: provider.id,
                        summary,
                    }),
                },
            });
            await completeInsideTransaction(tx, job, {
                result: { recipients: dispatch.to, summary },
                providerMessageId: provider.id,
                now: dependencies.now?.() ?? new Date(),
            });
        }, { timeout: 15_000 });
        return { kind: "completed" };
    } catch (error) {
        return {
            kind: "retry",
            error: `Team summary was accepted but its atomic completion failed (${errorText(error)}); retry only this same job/key`,
        };
    }
}

/** Execute one already-claimed approval job. Every durable transition is fenced. */
export async function executeApprovalAutomationJob(
    job: ApprovalJob,
    dependencies: ApprovalAutomationExecutionDependencies = {},
): Promise<ChangeOrderAutomationExecutionResult> {
    if (job.status !== "PROCESSING" || !job.claimToken) {
        return { kind: "retry", error: "Approval automation job must be claimed before execution" };
    }
    try {
        if (job.kind === "APPROVAL_BILL") return await executeBill(job, dependencies);
        if (job.kind === "APPROVAL_SCHEDULE") return await executeSchedule(job, dependencies);
        if (job.kind === "APPROVAL_CLIENT_EMAIL") return await executeClientEmail(job, dependencies);
        if (job.kind === "APPROVAL_TEAM_EMAIL") return await executeTeamEmail(job, dependencies);
        return { kind: "needs-attention", error: `Unsupported approval automation job kind: ${job.kind}` };
    } catch (error) {
        return { kind: "retry", error: errorText(error) };
    }
}
