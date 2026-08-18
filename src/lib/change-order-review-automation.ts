import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma";
import {
    canRetryProviderAttempt,
    type AutomationJobLike,
    type ChangeOrderAutomationExecutionResult,
} from "./change-order-automation";
import {
    checkpointChangeOrderAutomationProviderDispatch,
    completeChangeOrderAutomationJob,
} from "./change-order-automation-jobs";
import {
    canonicalChangeOrderRecipients,
    type ChangeOrderRecipientSet,
} from "./change-order-send-preview";
import { canonicalCoTaxTerms, coTaxFingerprint, type CanonicalCoTaxTerms } from "./co-tax";
import {
    CLIENT_DOC_COPY_EMAIL,
    buildFrozenNotification,
    sendFrozenNotification as defaultSendFrozenNotification,
    type FrozenNotification,
} from "./email";

export type ReviewEmailSettingsExpectation = {
    companyName: string;
    replyTo: string;
    bcc: string[];
};

export function reviewEmailSettingsExpectation(input: {
    recipients: ChangeOrderRecipientSet;
    notificationEmail?: string | null;
    email?: string | null;
    companyName?: string | null;
}): ReviewEmailSettingsExpectation {
    const companyName = input.companyName || "Your Contractor";
    const internalCopies = (input.notificationEmail?.trim() || CLIENT_DOC_COPY_EMAIL)
        .split(",")
        .map(email => email.trim())
        .filter(Boolean);
    const providerShape = buildFrozenNotification({
        to: input.recipients.primary ? [input.recipients.primary] : [],
        cc: input.recipients.additional,
        bcc: internalCopies,
        replyTo: input.email || undefined,
        fromName: companyName,
        subject: "review-settings-fence",
        html: "review-settings-fence",
    });
    return {
        companyName,
        replyTo: providerShape.replyTo,
        bcc: [...(providerShape.bcc ?? [])],
    };
}

export function reviewEmailSettingsConflictError(
    expected: ReviewEmailSettingsExpectation,
    current: ReviewEmailSettingsExpectation,
): string | null {
    return JSON.stringify(expected) === JSON.stringify(current)
        ? null
        : "Company or email delivery settings changed before the review email provider boundary; review the fresh company name, reply-to, and internal BCC.";
}

export type ReviewEmailAutomationPayload = {
    dispatch: FrozenNotification;
    expectedRevision: number;
    expectedTaxFingerprint: string;
    expectedTaxTerms: CanonicalCoTaxTerms;
    expectedRecipients: ChangeOrderRecipientSet;
    expectedSubtotalCents: number;
    companyName: string;
    expectedSettings: ReviewEmailSettingsExpectation;
    // The Client/Project rows the frozen portalUrl was signed for (Codex
    // round 7): addresses alone can't prove identity. null only for jobs
    // enqueued before these fields shipped — those skip the id check.
    expectedClientId: string | null;
    expectedProjectId: string | null;
};

export function newChangeOrderReviewGeneration(): string {
    return randomUUID();
}

function jsonObject(value: unknown): Record<string, any> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, any>
        : null;
}

function parseDispatch(value: unknown): FrozenNotification {
    const row = jsonObject(value);
    if (
        !row
        || !Array.isArray(row.to)
        || row.to.length === 0
        || row.to.some((recipient: unknown) => typeof recipient !== "string" || !recipient.trim())
        || typeof row.from !== "string"
        || typeof row.replyTo !== "string"
        || typeof row.subject !== "string"
        || typeof row.html !== "string"
        || typeof row.text !== "string"
    ) {
        throw new Error("Review automation job is missing its complete frozen dispatch");
    }
    return {
        from: row.from,
        to: [...row.to],
        replyTo: row.replyTo,
        subject: row.subject,
        html: row.html,
        text: row.text,
        ...(Array.isArray(row.cc) ? { cc: [...row.cc] } : {}),
        ...(Array.isArray(row.bcc) ? { bcc: [...row.bcc] } : {}),
    };
}

export function parseReviewEmailAutomationPayload(value: unknown): ReviewEmailAutomationPayload {
    const row = jsonObject(value);
    const recipients = jsonObject(row?.expectedRecipients);
    const settings = jsonObject(row?.expectedSettings);
    const persistedTaxTerms = jsonObject(row?.expectedTaxTerms);
    if (
        !row
        || !Number.isSafeInteger(row.expectedRevision)
        || row.expectedRevision < 0
        || typeof row.expectedTaxFingerprint !== "string"
        || !Number.isSafeInteger(row.expectedSubtotalCents)
        || row.expectedSubtotalCents < 0
        || !recipients
        || typeof recipients.primary !== "string"
        || !Array.isArray(recipients.additional)
        || recipients.additional.some((email: unknown) => typeof email !== "string")
        || typeof row.companyName !== "string"
        || (settings !== null && (
            typeof settings.companyName !== "string"
            || typeof settings.replyTo !== "string"
            || !Array.isArray(settings.bcc)
            || settings.bcc.some((email: unknown) => typeof email !== "string")
            || settings.companyName !== row.companyName
        ))
    ) {
        throw new Error("Review automation job payload is invalid");
    }
    const dispatch = parseDispatch(row.dispatch);
    let expectedTaxTerms: CanonicalCoTaxTerms | null = null;
    if (persistedTaxTerms
        && typeof persistedTaxTerms.taxExempt === "boolean"
        && typeof persistedTaxTerms.taxRatePercent === "number"
        && Number.isFinite(persistedTaxTerms.taxRatePercent)
        && (persistedTaxTerms.taxRateName === null || typeof persistedTaxTerms.taxRateName === "string")) {
        expectedTaxTerms = canonicalCoTaxTerms(persistedTaxTerms);
    } else {
        // Durable jobs created immediately before expectedTaxTerms shipped used
        // the canonical JSON tuple as their fingerprint; recover that exact
        // tuple so an already-started frozen attempt remains resumable.
        try {
            const tuple = JSON.parse(row.expectedTaxFingerprint) as unknown;
            if (Array.isArray(tuple)
                && typeof tuple[0] === "boolean"
                && typeof tuple[1] === "number"
                && Number.isFinite(tuple[1])
                && (tuple[2] === null || typeof tuple[2] === "string")) {
                expectedTaxTerms = canonicalCoTaxTerms({
                    taxExempt: tuple[0],
                    taxRatePercent: tuple[1],
                    taxRateName: tuple[2],
                });
            }
        } catch { /* invalid payload below */ }
    }
    if (!expectedTaxTerms || coTaxFingerprint(expectedTaxTerms) !== row.expectedTaxFingerprint) {
        throw new Error("Review automation job payload is invalid");
    }
    // Compatibility for durable jobs enqueued immediately before this field
    // shipped: the frozen dispatch is already authoritative for reply-to/BCC,
    // and the legacy companyName was frozen beside it. New jobs always persist
    // expectedSettings explicitly.
    const expectedSettings: ReviewEmailSettingsExpectation = settings
        ? {
            companyName: settings.companyName,
            replyTo: settings.replyTo,
            bcc: [...settings.bcc],
        }
        : {
            companyName: row.companyName,
            replyTo: dispatch.replyTo,
            bcc: [...(dispatch.bcc ?? [])],
        };
    const expectedProviderShape = buildFrozenNotification({
        to: dispatch.to,
        cc: dispatch.cc,
        bcc: expectedSettings.bcc,
        replyTo: expectedSettings.replyTo,
        fromName: expectedSettings.companyName,
        subject: "review-settings-payload-check",
        html: "review-settings-payload-check",
    });
    if (dispatch.from !== expectedProviderShape.from
        || dispatch.replyTo !== expectedProviderShape.replyTo
        || JSON.stringify(dispatch.bcc ?? []) !== JSON.stringify(expectedProviderShape.bcc ?? [])) {
        throw new Error("Review automation job settings expectations do not match its frozen dispatch");
    }
    return {
        dispatch,
        expectedRevision: row.expectedRevision,
        expectedTaxFingerprint: row.expectedTaxFingerprint,
        expectedTaxTerms,
        expectedRecipients: {
            primary: recipients.primary,
            additional: [...recipients.additional],
        },
        expectedSubtotalCents: row.expectedSubtotalCents,
        companyName: row.companyName,
        expectedSettings,
        expectedClientId: parseFrozenIdentityField(row, "expectedClientId"),
        expectedProjectId: parseFrozenIdentityField(row, "expectedProjectId"),
    };
}

// Absent (or explicit null) => a legacy job from before identity binding
// shipped, which skips the id check. A PRESENT value must be a non-empty
// string: a malformed/empty value must reject the payload rather than
// silently disabling the fence by collapsing to null (Codex round 8).
function parseFrozenIdentityField(
    row: Record<string, any>,
    key: "expectedClientId" | "expectedProjectId",
): string | null {
    if (!(key in row) || row[key] === undefined || row[key] === null) return null;
    const value = row[key];
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("Review automation job payload is invalid");
    }
    return value;
}

type LockedDeliveryResult = ChangeOrderAutomationExecutionResult;

export type ReviewEmailAutomationDependencies = {
    now?: () => Date;
    checkpointFirstAttempt?: (
        job: AutomationJobLike,
        payload: ReviewEmailAutomationPayload,
        now: Date,
    ) => Promise<FirstAttemptCheckpointResult>;
    checkpoint?: (job: AutomationJobLike, now: Date) => Promise<AutomationJobLike | null>;
    deliverLocked?: (
        job: AutomationJobLike,
        payload: ReviewEmailAutomationPayload,
        send: typeof defaultSendFrozenNotification,
        now: () => Date,
        hadPriorProviderAttempt: boolean,
    ) => Promise<LockedDeliveryResult>;
    sendFrozenNotification?: typeof defaultSendFrozenNotification;
};

function conflict(
    code: "REVISION_CONFLICT" | "TAX_TERMS_CONFLICT" | "RECIPIENT_CONFLICT",
    error: string,
): ChangeOrderAutomationExecutionResult {
    return { kind: "canceled", result: { code, error } };
}

type FirstAttemptCheckpointResult =
    | { kind: "ready"; job: AutomationJobLike }
    | LockedDeliveryResult;

async function checkpointReviewEmailFirstAttemptLocked(
    job: AutomationJobLike,
    payload: ReviewEmailAutomationPayload,
    checkpointAt: Date,
): Promise<FirstAttemptCheckpointResult> {
    try {
        return await prisma.$transaction(async (tx): Promise<FirstAttemptCheckpointResult> => {
            // Canonical money order: Estimate -> Project -> ChangeOrder ->
            // Client -> CompanySettings -> job. Estimate comes FIRST (Codex
            // round 7): Estimate-first flows (restoreEstimateItemAssociations,
            // createInvoiceFromEstimateCore) would deadlock against a
            // transaction holding Project/CO while acquiring Estimate. The
            // unlocked coRef read is a routing hint, revalidated after the CO
            // lock. The first-provider checkpoint is committed while these
            // shared locks are still held. A crash after that commit is
            // therefore a frozen retry, never an unvalidated first attempt.
            const coRef = await tx.changeOrder.findUnique({
                where: { id: job.changeOrderId },
                select: { projectId: true, estimateId: true },
            });
            if (!coRef) return conflict("REVISION_CONFLICT", "Change order no longer exists");
            const [estimateTax] = await tx.$queryRaw<Array<{
                taxExempt: boolean;
                taxRatePercent: Prisma.Decimal | null;
                taxRateName: string | null;
            }>>`
                SELECT "taxExempt", "taxRatePercent", "taxRateName"
                FROM "Estimate" WHERE "id" = ${coRef.estimateId} FOR SHARE`;
            const [project] = await tx.$queryRaw<Array<{ id: string; clientId: string | null }>>`
                SELECT "id", "clientId" FROM "Project" WHERE "id" = ${coRef.projectId} FOR SHARE`;
            if (!project) return conflict("REVISION_CONFLICT", "Change-order project no longer exists");
            // Identity binding (Codex round 7): the frozen dispatch's portalUrl
            // was signed for a specific Client row. Matching addresses alone
            // would let a project reassigned to a same-email Client pass every
            // recipient/settings check while the token authenticates the OLD
            // client's scope.
            if (payload.expectedProjectId !== null && project.id !== payload.expectedProjectId) {
                return conflict("REVISION_CONFLICT", "The change order moved projects after its review email was frozen.");
            }
            if (payload.expectedClientId !== null && project.clientId !== payload.expectedClientId) {
                return conflict("RECIPIENT_CONFLICT", "The project's client changed after this review email was frozen; preview and send again for the current client.");
            }
            const [co] = await tx.$queryRaw<Array<{
                id: string;
                code: string;
                title: string;
                status: string;
                revision: number;
                totalAmount: unknown;
                estimateId: string;
                projectId: string;
                termsTaxExempt: boolean | null;
                termsTaxRateName: string | null;
                termsTaxRatePercent: Prisma.Decimal | null;
            }>>`
                SELECT "id", "code", "title", "status", "revision", "totalAmount", "estimateId", "projectId",
                       "termsTaxExempt", "termsTaxRateName", "termsTaxRatePercent"
                FROM "ChangeOrder" WHERE "id" = ${job.changeOrderId} FOR UPDATE`;
            if (!co) return conflict("REVISION_CONFLICT", "Change order no longer exists");
            if (co.projectId !== project.id || co.estimateId !== coRef.estimateId) {
                return conflict("REVISION_CONFLICT", `Change order ${co.code} moved projects before delivery.`);
            }
            if ((co.status !== "Draft" && co.status !== "Sent") || co.revision !== payload.expectedRevision) {
                return conflict("REVISION_CONFLICT", `Change order ${co.code} changed before its review email was delivered.`);
            }
            if (Math.round(Number(co.totalAmount) * 100) !== payload.expectedSubtotalCents) {
                return conflict("REVISION_CONFLICT", `Change order ${co.code} amount changed before delivery.`);
            }

            const [client] = project?.clientId
                ? await tx.$queryRaw<Array<{ email: string | null; additionalEmail: string | null }>>`
                    SELECT "email", "additionalEmail" FROM "Client" WHERE "id" = ${project.clientId} FOR SHARE`
                : [];
            const currentRecipients = canonicalChangeOrderRecipients(client?.email, client?.additionalEmail);
            if (JSON.stringify(currentRecipients) !== JSON.stringify(payload.expectedRecipients)) {
                return conflict("RECIPIENT_CONFLICT", `Change order ${co.code} recipients changed before delivery.`);
            }

            let terms = co.termsTaxExempt === null
                ? null
                : canonicalCoTaxTerms({
                    taxExempt: co.termsTaxExempt,
                    taxRateName: co.termsTaxRateName,
                    taxRatePercent: co.termsTaxRatePercent,
                });
            const mustSnapshotTerms = co.status === "Draft" || terms === null;
            if (mustSnapshotTerms) {
                // estimateTax was read under FOR SHARE at the TOP of this
                // transaction (Estimate before Project/CO) and stays locked
                // through the checkpoint commit.
                terms = estimateTax ? canonicalCoTaxTerms(estimateTax) : null;
            }
            if (!terms || coTaxFingerprint(terms) !== payload.expectedTaxFingerprint) {
                return conflict("TAX_TERMS_CONFLICT", `Change order ${co.code} tax terms changed before delivery.`);
            }

            const [settings] = await tx.$queryRaw<Array<{
                notificationEmail: string | null;
                email: string | null;
                companyName: string | null;
            }>>`
                SELECT "notificationEmail", "email", "companyName"
                FROM "CompanySettings" WHERE "id" = 'singleton' FOR SHARE`;
            const settingsConflict = reviewEmailSettingsConflictError(
                payload.expectedSettings,
                reviewEmailSettingsExpectation({
                    recipients: currentRecipients,
                    notificationEmail: settings?.notificationEmail,
                    email: settings?.email,
                    companyName: settings?.companyName,
                }),
            );
            if (settingsConflict) return conflict("RECIPIENT_CONFLICT", settingsConflict);

            const [lockedJob] = await tx.$queryRaw<Array<{
                status: string;
                claimToken: string | null;
            }>>`
                SELECT "status", "claimToken"
                FROM "ChangeOrderAutomationJob" WHERE "id" = ${job.id} FOR UPDATE`;
            if (!lockedJob || lockedJob.status !== "PROCESSING" || lockedJob.claimToken !== job.claimToken) {
                return { kind: "retry", error: "Review email claim was superseded before its provider checkpoint" };
            }
            const checkpointed = await checkpointChangeOrderAutomationProviderDispatch(tx, {
                jobId: job.id,
                claimToken: job.claimToken!,
                dispatch: payload.dispatch,
                now: checkpointAt,
            });
            if (!checkpointed?.claimToken) {
                return { kind: "retry", error: "Review email claim was lost at its provider checkpoint" };
            }
            return { kind: "ready", job: checkpointed as unknown as AutomationJobLike };
        }, { timeout: 15_000 });
    } catch (error: any) {
        return {
            kind: "retry",
            error: `Review email preflight/checkpoint transaction did not commit (${error?.message ?? "unknown error"})`,
        };
    }
}

async function deliverReviewEmailLocked(
    job: AutomationJobLike,
    payload: ReviewEmailAutomationPayload,
    send: typeof defaultSendFrozenNotification,
    now: () => Date,
    _hadPriorProviderAttempt: boolean,
): Promise<LockedDeliveryResult> {
    try {
        return await prisma.$transaction(async (tx): Promise<LockedDeliveryResult> => {
            // After the committed first-provider checkpoint, all mutable inputs
            // are deliberately ignored. Project -> ChangeOrder -> job locks keep
            // bookkeeping serialized while every retry uses the same bytes/key.
            const coRef = await tx.changeOrder.findUnique({
                where: { id: job.changeOrderId },
                select: { projectId: true },
            });
            if (!coRef) return { kind: "retry", error: "Checkpointed review change order no longer exists" };
            const [project] = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "Project" WHERE "id" = ${coRef.projectId} FOR SHARE`;
            if (!project) return { kind: "retry", error: "Checkpointed review project no longer exists" };
            const [co] = await tx.$queryRaw<Array<{
                id: string;
                code: string;
                title: string;
                projectId: string;
            }>>`
                SELECT "id", "code", "title", "projectId"
                FROM "ChangeOrder" WHERE "id" = ${job.changeOrderId} FOR UPDATE`;
            if (!co || co.projectId !== project.id) {
                return { kind: "retry", error: "Checkpointed review scope no longer has its frozen project" };
            }
            const [lockedJob] = await tx.$queryRaw<Array<{
                status: string;
                claimToken: string | null;
                idempotencyKey: string;
                firstProviderAttemptAt: Date | null;
            }>>`
                SELECT "status", "claimToken", "idempotencyKey", "firstProviderAttemptAt"
                FROM "ChangeOrderAutomationJob" WHERE "id" = ${job.id} FOR UPDATE`;
            if (!lockedJob || lockedJob.status !== "PROCESSING"
                || lockedJob.claimToken !== job.claimToken || !lockedJob.firstProviderAttemptAt) {
                return { kind: "retry", error: "Review email checkpoint was superseded before delivery" };
            }

            const provider = await send(payload.dispatch, lockedJob.idempotencyKey);
            if (!provider.success) {
                return {
                    kind: "retry",
                    error: provider.ambiguous
                        ? "Review email provider outcome is ambiguous; retry with the same job key"
                        : "Review email provider rejected the delivery",
                    retainFrozenPayloadForReconciliation: provider.ambiguous,
                };
            }

            const sentAt = now();
            const updated = await tx.changeOrder.updateMany({
                where: {
                    id: co.id,
                    projectId: project.id,
                    revision: payload.expectedRevision,
                    status: { in: ["Draft", "Sent"] },
                    totalAmount: payload.expectedSubtotalCents / 100,
                },
                data: {
                    status: "Sent",
                    sentAt,
                    termsTaxExempt: payload.expectedTaxTerms.taxExempt,
                    termsTaxRateName: payload.expectedTaxTerms.taxRateName,
                    termsTaxRatePercent: payload.expectedTaxTerms.taxRatePercent,
                    revision: { increment: 1 },
                },
            });
            if (updated.count !== 1) {
                throw new Error("frozen review state could not be stamped after provider delivery");
            }
            const recorded = await tx.changeOrder.findUnique({
                where: { id: co.id },
                select: { revision: true },
            });
            if (!recorded) throw new Error("review change order disappeared after provider delivery");
            const completed = await completeChangeOrderAutomationJob(tx, {
                jobId: job.id,
                claimToken: job.claimToken!,
                providerMessageId: provider.id,
                result: {
                    sentTo: payload.expectedRecipients.primary,
                    revision: recorded.revision,
                    sentAt: sentAt.toISOString(),
                },
                now: sentAt,
            });
            if (!completed) throw new Error("Review email job fence was lost after provider delivery");
            await tx.activityLog.create({
                data: {
                    projectId: co.projectId,
                    actorType: "TEAM",
                    actorName: payload.companyName,
                    action: "sent_change_order",
                    entityType: "change_order",
                    entityId: co.id,
                    entityName: `Change Order ${co.code || co.title}`,
                    metadata: JSON.stringify({ automationJobId: job.id, providerMessageId: provider.id }),
                },
            });
            return { kind: "completed" };
        }, { timeout: 15_000 });
    } catch (error: any) {
        return {
            kind: "retry",
            error: `Review email delivery transaction did not commit (${error?.message ?? "unknown error"})`,
        };
    }
}

export async function executeReviewEmailAutomationJob(
    job: AutomationJobLike,
    dependencies: ReviewEmailAutomationDependencies = {},
): Promise<ChangeOrderAutomationExecutionResult> {
    if (job.kind !== "REVIEW_EMAIL" || !job.claimToken) {
        return { kind: "needs-attention", error: "Invalid claimed review-email automation job" };
    }
    const now = dependencies.now ?? (() => new Date());
    const hadPriorProviderAttempt = job.firstProviderAttemptAt !== null;
    if (!canRetryProviderAttempt(job.firstProviderAttemptAt, now())) {
        return {
            kind: "needs-attention",
            error: "Review email is outside the provider idempotency window; verify delivery manually before any retry.",
        };
    }

    let payload: ReviewEmailAutomationPayload;
    try {
        payload = parseReviewEmailAutomationPayload(job.payload);
    } catch (error: any) {
        return { kind: "needs-attention", error: error?.message ?? "Invalid review email payload" };
    }
    const checkpoint = dependencies.checkpoint ?? (async (claimed, checkpointAt) => {
        const row = await checkpointChangeOrderAutomationProviderDispatch(prisma, {
            jobId: claimed.id,
            claimToken: claimed.claimToken!,
            dispatch: payload.dispatch,
            now: checkpointAt,
        });
        return row as unknown as AutomationJobLike | null;
    });
    let checkpointed: AutomationJobLike | null;
    if (!hadPriorProviderAttempt && !dependencies.checkpoint) {
        const firstAttemptCheckpoint = dependencies.checkpointFirstAttempt
            ?? checkpointReviewEmailFirstAttemptLocked;
        const preflight = await firstAttemptCheckpoint(job, payload, now());
        if (preflight.kind !== "ready") return preflight;
        checkpointed = preflight.job;
    } else {
        // Existing provider attempts never consult mutable live state. This CAS
        // only renews the claim while preserving the first frozen payload/key.
        checkpointed = await checkpoint(job, now());
    }
    if (!checkpointed?.claimToken) {
        return { kind: "retry", error: "Review email claim was lost before its provider checkpoint" };
    }
    payload = parseReviewEmailAutomationPayload(checkpointed.payload);
    const deliver = dependencies.deliverLocked ?? deliverReviewEmailLocked;
    const outcome = await deliver(
        checkpointed,
        payload,
        dependencies.sendFrozenNotification ?? defaultSendFrozenNotification,
        now,
        hadPriorProviderAttempt,
    );
    if (hadPriorProviderAttempt && outcome.kind === "canceled") {
        return {
            kind: "needs-attention",
            error: "Review terms changed after a prior provider attempt; verify whether that frozen email was delivered before changing or resending it.",
            result: outcome.result,
        };
    }
    return outcome;
}
