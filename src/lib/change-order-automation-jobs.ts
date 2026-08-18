import { createHash, randomUUID } from "node:crypto";
import type { ChangeOrderAutomationJob as PrismaChangeOrderAutomationJob, Prisma, PrismaClient } from "@prisma/client";
import {
    APPROVAL_JOB_KINDS,
    approvalJobKinds,
    providerIdempotencyKey,
    type ChangeOrderApprovalJobKind,
    type ChangeOrderApprovalMode,
    type ChangeOrderPricingType,
} from "./change-order-automation";
import type { FrozenNotification } from "./email";

export const CHANGE_ORDER_AUTOMATION_JOB_KINDS = [
    "REVIEW_EMAIL",
    "APPROVAL_BILL",
    "APPROVAL_CLIENT_EMAIL",
    "APPROVAL_SCHEDULE",
    "APPROVAL_TEAM_EMAIL",
] as const;

export type ChangeOrderAutomationJobKind = "REVIEW_EMAIL" | ChangeOrderApprovalJobKind;

export const CHANGE_ORDER_AUTOMATION_JOB_STATUSES = [
    "PENDING",
    "PROCESSING",
    "SUCCEEDED",
    "SKIPPED",
    "CANCELED",
    "NEEDS_ATTENTION",
] as const;

export type ChangeOrderAutomationJobStatus = (typeof CHANGE_ORDER_AUTOMATION_JOB_STATUSES)[number];

export const CHANGE_ORDER_APPROVAL_MODES = ["CLIENT", "MANUAL"] as const satisfies readonly ChangeOrderApprovalMode[];

export const DEFAULT_CHANGE_ORDER_AUTOMATION_MAX_ATTEMPTS = 8;
export const DEFAULT_CHANGE_ORDER_AUTOMATION_STALE_AFTER_MS = 5 * 60_000;

export type ChangeOrderAutomationJobRecord = PrismaChangeOrderAutomationJob;
export type ChangeOrderAutomationJobClient = Pick<Prisma.TransactionClient, "changeOrderAutomationJob">;
type ChangeOrderAutomationJobLockClient = ChangeOrderAutomationJobClient & Pick<Prisma.TransactionClient, "$queryRaw">;

type EnqueueChangeOrderAutomationJob = {
    kind: ChangeOrderAutomationJobKind;
    payload?: Prisma.InputJsonObject;
    generationKey?: string;
};

type EnqueueChangeOrderAutomationJobsInput = {
    changeOrderId: string;
    eventRevision: number;
    approvalMode?: ChangeOrderApprovalMode | null;
    jobs: readonly EnqueueChangeOrderAutomationJob[];
    maxAttempts?: number;
};

const EMAIL_JOB_KINDS = new Set<ChangeOrderAutomationJobKind>([
    "REVIEW_EMAIL",
    "APPROVAL_CLIENT_EMAIL",
    "APPROVAL_TEAM_EMAIL",
]);

function frozenNotificationJson(dispatch: FrozenNotification): Prisma.InputJsonObject {
    if (
        !dispatch ||
        typeof dispatch !== "object" ||
        !Array.isArray(dispatch.to) ||
        dispatch.to.length === 0 ||
        dispatch.to.some((recipient) => typeof recipient !== "string" || !recipient.trim()) ||
        typeof dispatch.from !== "string" ||
        !dispatch.from.trim() ||
        typeof dispatch.replyTo !== "string" ||
        !dispatch.replyTo.trim() ||
        typeof dispatch.subject !== "string" ||
        !dispatch.subject.trim() ||
        typeof dispatch.html !== "string" ||
        typeof dispatch.text !== "string" ||
        (dispatch.cc !== undefined &&
            (!Array.isArray(dispatch.cc) || dispatch.cc.some((recipient) => typeof recipient !== "string"))) ||
        (dispatch.bcc !== undefined &&
            (!Array.isArray(dispatch.bcc) || dispatch.bcc.some((recipient) => typeof recipient !== "string")))
    ) {
        throw new Error("A complete frozen email dispatch is required");
    }

    return {
        from: dispatch.from,
        to: [...dispatch.to],
        replyTo: dispatch.replyTo,
        subject: dispatch.subject,
        html: dispatch.html,
        text: dispatch.text,
        ...(dispatch.cc === undefined ? {} : { cc: [...dispatch.cc] }),
        ...(dispatch.bcc === undefined ? {} : { bcc: [...dispatch.bcc] }),
    };
}

function frozenNotificationFromJson(value: unknown): Prisma.InputJsonObject {
    // The validator also copies every field into a provider-safe plain object.
    return frozenNotificationJson(value as FrozenNotification);
}

function automationDedupeKey(input: {
    changeOrderId: string;
    eventRevision: number;
    kind: ChangeOrderAutomationJobKind;
    generationKey?: string;
}): string {
    const digest = createHash("sha256")
        .update(
            JSON.stringify([
                "change-order-automation-v1",
                input.changeOrderId,
                input.eventRevision,
                input.kind,
                input.generationKey ?? null,
            ]),
        )
        .digest("hex");
    return `co-automation/v1/${digest}`;
}

function assertEnqueueInput(input: EnqueueChangeOrderAutomationJobsInput): void {
    if (!input.changeOrderId.trim()) throw new Error("changeOrderId is required");
    if (!Number.isSafeInteger(input.eventRevision) || input.eventRevision < 0) {
        throw new Error("eventRevision must be a non-negative safe integer");
    }

    const maxAttempts = input.maxAttempts ?? DEFAULT_CHANGE_ORDER_AUTOMATION_MAX_ATTEMPTS;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error("maxAttempts must be a positive safe integer");
    }

    const kinds = new Set<ChangeOrderAutomationJobKind>();
    let hasReviewJob = false;
    for (const job of input.jobs) {
        if (!CHANGE_ORDER_AUTOMATION_JOB_KINDS.includes(job.kind)) {
            throw new Error(`Unsupported change-order automation job kind: ${String(job.kind)}`);
        }
        if (kinds.has(job.kind)) throw new Error(`Duplicate change-order automation job kind: ${job.kind}`);
        kinds.add(job.kind);
        if (job.kind === "REVIEW_EMAIL") {
            hasReviewJob = true;
            if (!job.generationKey?.trim()) throw new Error("REVIEW_EMAIL requires a non-empty generationKey");
        } else if (job.generationKey !== undefined) {
            throw new Error("generationKey is only valid for REVIEW_EMAIL");
        }
    }

    const hasApprovalJob = [...kinds].some((kind) => kind !== "REVIEW_EMAIL");
    if (hasReviewJob && hasApprovalJob) throw new Error("Review and approval automation jobs cannot be mixed");
    if (hasApprovalJob && input.approvalMode == null) {
        throw new Error("approvalMode is required for approval automation jobs");
    }

    // A manual approval is an internal audit action. It must never enqueue the
    // customer-facing approval email that is reserved for a portal signer.
    if (input.approvalMode === "MANUAL" && kinds.has("APPROVAL_CLIENT_EMAIL")) {
        throw new Error("Manual approval cannot enqueue APPROVAL_CLIENT_EMAIL");
    }
}

/**
 * Atomically enqueue the durable work associated with a change-order event.
 *
 * Call this with the approval/send transaction client. The derived dedupe key
 * makes transaction retries and repeated commands harmless; `update: {}` is
 * intentional so a retry cannot replace the first frozen payload or provider
 * idempotency key.
 */
async function enqueueChangeOrderAutomationJobs(
    tx: ChangeOrderAutomationJobClient,
    input: EnqueueChangeOrderAutomationJobsInput,
): Promise<ChangeOrderAutomationJobRecord[]> {
    assertEnqueueInput(input);
    const maxAttempts = input.maxAttempts ?? DEFAULT_CHANGE_ORDER_AUTOMATION_MAX_ATTEMPTS;

    return Promise.all(
        input.jobs.map(async (job) => {
            const id = randomUUID();
            const dedupeKey = automationDedupeKey({
                changeOrderId: input.changeOrderId,
                eventRevision: input.eventRevision,
                kind: job.kind,
                generationKey: job.generationKey,
            });
            return tx.changeOrderAutomationJob.upsert({
                where: { dedupeKey },
                update: {},
                create: {
                    id,
                    changeOrderId: input.changeOrderId,
                    eventRevision: input.eventRevision,
                    kind: job.kind,
                    approvalMode: input.approvalMode ?? null,
                    status: "PENDING",
                    idempotencyKey: providerIdempotencyKey(id),
                    dedupeKey,
                    maxAttempts,
                    ...(job.payload === undefined ? {} : { payload: job.payload }),
                },
            });
        }),
    );
}

export type EnqueueApprovalAutomationJobsInput = {
    changeOrderId: string;
    eventRevision: number;
    pricingType: ChangeOrderPricingType;
    approvalMode: ChangeOrderApprovalMode;
    payloads: Partial<Record<ChangeOrderApprovalJobKind, Prisma.InputJsonObject>>;
    maxAttempts?: number;
};

/** Enqueue the complete, mode-correct approval graph; callers cannot omit a side effect. */
export async function enqueueApprovalAutomationJobs(
    tx: ChangeOrderAutomationJobClient,
    input: EnqueueApprovalAutomationJobsInput,
): Promise<ChangeOrderAutomationJobRecord[]> {
    const kinds = approvalJobKinds(input.pricingType, input.approvalMode);
    const jobs = kinds.map((kind) => {
        const payload = input.payloads[kind];
        if (payload === undefined) throw new Error(`Missing frozen payload for ${kind}`);
        return { kind, payload };
    });
    return enqueueChangeOrderAutomationJobs(tx, {
        changeOrderId: input.changeOrderId,
        eventRevision: input.eventRevision,
        approvalMode: input.approvalMode,
        jobs,
        maxAttempts: input.maxAttempts,
    });
}

export type LegacyApprovedRecoveryStatus = "PENDING" | "SKIPPED" | "NEEDS_ATTENTION";

/**
 * Cutover recovery is intentionally no-email. Old after()-based approvals may
 * need billing/schedule convergence, but an unknown historic delivery outcome
 * must never cause a second customer or team message.
 */
export function legacyApprovedRecoveryPlan(input: {
    pricingType: ChangeOrderPricingType;
    approvalMode: ChangeOrderApprovalMode;
    hasExistingMilestones: boolean;
    /** isApprovedWithinAutomationCutover() — false parks billing rather than auto-billing history (Codex round 7). */
    approvedWithinCutover: boolean;
}): Partial<Record<ChangeOrderApprovalJobKind, LegacyApprovedRecoveryStatus>> {
    // Billing runs automatically ONLY for deploy-window approvals with no
    // recognized milestone. Historic/undated approvals and rows that already
    // carry milestones are parked for a human — never guessed, never billed.
    const bill: LegacyApprovedRecoveryStatus =
        input.approvedWithinCutover && !input.hasExistingMilestones ? "PENDING" : "NEEDS_ATTENTION";
    if (input.pricingType === "COST_PLUS") {
        return {
            APPROVAL_SCHEDULE: "PENDING",
            APPROVAL_TEAM_EMAIL: "SKIPPED",
        };
    }
    return input.approvalMode === "CLIENT"
        ? {
            APPROVAL_BILL: bill,
            APPROVAL_CLIENT_EMAIL: "SKIPPED",
            APPROVAL_SCHEDULE: "PENDING",
            APPROVAL_TEAM_EMAIL: "SKIPPED",
        }
        : {
            APPROVAL_BILL: bill,
            APPROVAL_SCHEDULE: "PENDING",
            APPROVAL_TEAM_EMAIL: "SKIPPED",
        };
}

type LegacyRecoveryDatabase = Pick<
    PrismaClient,
    "changeOrder" | "changeOrderAutomationJob" | "paymentSchedule" | "$transaction"
>;

// The outbox deployment cutover. Approvals at/after this instant were made in
// the deploy window by a build (old or new) whose billing state is known, so
// their recovered APPROVAL_BILL may run automatically. Approvals BEFORE it —
// and imported rows with no approvedAt at all — are historic: their money was
// handled through legacy/manual paths this seeder cannot see, so recovery
// still creates their bookkeeping rows but parks billing in NEEDS_ATTENTION
// instead of auto-billing history (Codex round 7; the previous new Date(0)
// cutover auto-billed every historic Approved CO without a recognized
// milestone).
export const CHANGE_ORDER_AUTOMATION_CUTOVER_AT = new Date("2026-08-16T00:00:00Z");

export function isLegacyApprovedRecoveryCandidate(
    approvedAt: Date | null,
    cutoverAt: Date,
): boolean {
    // Candidacy is deliberately unrestricted by date: every Approved CO with
    // no approval jobs gets bookkeeping rows (emails terminally suppressed).
    // The cutover decides how its BILLING job is seeded, not whether the row
    // is recovered — see legacyApprovedRecoveryPlan's approvedWithinCutover.
    void approvedAt;
    void cutoverAt;
    return true;
}

/** Approved at/after the cutover with a real timestamp — the only rows whose recovered billing may run automatically. */
export function isApprovedWithinAutomationCutover(
    approvedAt: Date | null,
    cutoverAt: Date,
): boolean {
    return approvedAt !== null && approvedAt.getTime() >= cutoverAt.getTime();
}

/**
 * Recover approvals committed by the old build around outbox deployment. The
 * cutover lower bound is fixed (not a moving age band), so an eligible row is
 * never missed forever. Emails are terminally SKIPPED; existing billing is
 * parked for human review rather than guessed or duplicated.
 */
export async function seedLegacyApprovedChangeOrderAutomationJobs(
    input: { limit?: number; cutoverAt?: Date } = {},
    dependencies: { db?: LegacyRecoveryDatabase; now?: () => Date } = {},
): Promise<{ seeded: number; changeOrderIds: string[] }> {
    const db = dependencies.db ?? (await import("./prisma")).prisma;
    const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
    const cutoverAt = input.cutoverAt ?? CHANGE_ORDER_AUTOMATION_CUTOVER_AT;
    // No date filter: EVERY Approved CO without approval jobs is recovered
    // (billing for historic rows is parked, not run — see the plan). The
    // `none` filter is scoped to APPROVAL kinds (Codex round 7): during a
    // rolling deploy a CO can already carry a new-build REVIEW_EMAIL job yet
    // be approved by an old instance with no approval jobs — an unscoped
    // `none: {}` would skip that CO forever.
    const candidates = await db.changeOrder.findMany({
        where: {
            status: "Approved",
            automationJobs: { none: { kind: { in: [...APPROVAL_JOB_KINDS] } } },
        },
        select: { id: true },
        orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
        take: limit,
    });
    const changeOrderIds: string[] = [];

    for (const candidate of candidates) {
        const seeded = await db.$transaction(async tx => {
            const [current] = await tx.$queryRaw<Array<{
                id: string;
                code: string;
                projectId: string;
                revision: number;
                status: string;
                pricingType: string;
                approvedAt: Date | null;
                clientSignatureUrl: string | null;
            }>>`
                SELECT "id", "code", "projectId", "revision", "status", "pricingType", "approvedAt", "clientSignatureUrl"
                FROM "ChangeOrder" WHERE "id" = ${candidate.id} FOR UPDATE`;
            if (
                !current
                || current.status !== "Approved"
                || !isLegacyApprovedRecoveryCandidate(current.approvedAt, cutoverAt)
            ) return false;
            // Approval kinds only (Codex round 7): a REVIEW_EMAIL job from the
            // new build must not hide an approval that still has no
            // bill/schedule/email jobs.
            if (await tx.changeOrderAutomationJob.count({
                where: { changeOrderId: current.id, kind: { in: [...APPROVAL_JOB_KINDS] } },
            }) > 0) return false;

            const pricingType: ChangeOrderPricingType = current.pricingType === "COST_PLUS" ? "COST_PLUS" : "FIXED";
            // A preserved client signature is the only safe legacy proof of a
            // client approval. Unknown/no-signature rows recover as MANUAL, and
            // both modes suppress every historic email below.
            const approvalMode: ChangeOrderApprovalMode = current.clientSignatureUrl ? "CLIENT" : "MANUAL";
            const existingMilestone = pricingType === "FIXED"
                ? await tx.paymentSchedule.findFirst({
                    where: {
                        OR: [
                            { sourceChangeOrderId: current.id },
                            { name: { startsWith: `${current.code} — ` }, invoice: { projectId: current.projectId } },
                        ],
                    },
                    select: { id: true },
                })
                : null;
            const frozenEvent = {
                changeOrderId: current.id,
                eventRevision: current.revision,
                approvalMode,
                recoveredLegacyApproval: true,
            } satisfies Prisma.InputJsonObject;
            const jobs = await enqueueApprovalAutomationJobs(tx, {
                changeOrderId: current.id,
                eventRevision: current.revision,
                pricingType,
                approvalMode,
                payloads: {
                    APPROVAL_BILL: { ...frozenEvent },
                    APPROVAL_CLIENT_EMAIL: { ...frozenEvent },
                    APPROVAL_SCHEDULE: { ...frozenEvent },
                    APPROVAL_TEAM_EMAIL: { ...frozenEvent },
                },
            });
            const approvedWithinCutover = isApprovedWithinAutomationCutover(current.approvedAt, cutoverAt);
            const plan = legacyApprovedRecoveryPlan({
                pricingType,
                approvalMode,
                hasExistingMilestones: Boolean(existingMilestone),
                approvedWithinCutover,
            });
            const now = dependencies.now?.() ?? new Date();
            for (const job of jobs) {
                const status = plan[job.kind as ChangeOrderApprovalJobKind];
                if (!status || status === "PENDING") continue;
                const reason = status === "SKIPPED"
                    ? "Legacy approval recovery never sends historic customer/team email"
                    : existingMilestone
                        ? "Legacy approval already has billing milestones; verify the retained billing before recovery"
                        : "Approved before the automation cutover (or missing approvedAt); verify and bill this historic approval manually";
                const terminalResult = { reason, recoveredLegacyApproval: true } satisfies Prisma.InputJsonObject;
                await tx.changeOrderAutomationJob.updateMany({
                    where: observedStateWhere(job),
                    data: {
                        status,
                        ...terminalSanitizationData(job, status, terminalResult),
                        lastError: status === "NEEDS_ATTENTION" ? reason : null,
                        nextAttemptAt: null,
                        processingStartedAt: null,
                        claimToken: null,
                        completedAt: now,
                    },
                });
            }
            return true;
        });
        if (seeded) changeOrderIds.push(candidate.id);
    }
    return { seeded: changeOrderIds.length, changeOrderIds };
}

export type EnqueueReviewEmailAutomationJobInput = {
    changeOrderId: string;
    eventRevision: number;
    generationKey: string;
    dispatch: FrozenNotification;
    payload?: Prisma.InputJsonObject;
    maxAttempts?: number;
};

/** Enqueue one exact review dispatch; a new preview generation gets a new row/key. */
export async function enqueueReviewEmailAutomationJob(
    tx: ChangeOrderAutomationJobClient,
    input: EnqueueReviewEmailAutomationJobInput,
): Promise<ChangeOrderAutomationJobRecord> {
    const dispatch = frozenNotificationJson(input.dispatch);
    const [job] = await enqueueChangeOrderAutomationJobs(tx, {
        changeOrderId: input.changeOrderId,
        eventRevision: input.eventRevision,
        jobs: [
            {
                kind: "REVIEW_EMAIL",
                generationKey: input.generationKey,
                payload: { ...(input.payload ?? {}), dispatch },
            },
        ],
        maxAttempts: input.maxAttempts,
    });
    return job;
}

export type ClaimChangeOrderAutomationJobInput = {
    jobId: string;
    now?: Date;
    claimToken?: string;
    staleAfterMs?: number;
};

function observedStateWhere(row: ChangeOrderAutomationJobRecord) {
    return {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        claimToken: row.claimToken,
        processingStartedAt: row.processingStartedAt,
        nextAttemptAt: row.nextAttemptAt,
    };
}

/**
 * Claim one due job with a compare-and-swap transition. The claim token fences
 * every later state change, including a late completion by a worker whose lease
 * expired and was recovered by cron.
 */
export async function claimChangeOrderAutomationJob(
    db: ChangeOrderAutomationJobClient,
    input: ClaimChangeOrderAutomationJobInput,
): Promise<ChangeOrderAutomationJobRecord | null> {
    const now = input.now ?? new Date();
    const staleAfterMs = input.staleAfterMs ?? DEFAULT_CHANGE_ORDER_AUTOMATION_STALE_AFTER_MS;
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
        throw new Error("staleAfterMs must be positive");
    }

    const candidate = await db.changeOrderAutomationJob.findUnique({ where: { id: input.jobId } });
    if (!candidate) return null;

    const pendingAndDue =
        candidate.status === "PENDING" &&
        (candidate.nextAttemptAt === null || candidate.nextAttemptAt.getTime() <= now.getTime());
    const processingAndStale =
        candidate.status === "PROCESSING" &&
        candidate.processingStartedAt !== null &&
        candidate.processingStartedAt.getTime() < now.getTime() - staleAfterMs;
    if (!pendingAndDue && !processingAndStale) return null;

    const where = observedStateWhere(candidate);
    if (candidate.attempts >= candidate.maxAttempts) {
        await db.changeOrderAutomationJob.updateMany({
            where,
            data: {
                status: "NEEDS_ATTENTION",
                ...terminalSanitizationData(candidate, "NEEDS_ATTENTION"),
                lastError: candidate.lastError ?? "Maximum automation attempts exhausted",
                nextAttemptAt: null,
                processingStartedAt: null,
                claimToken: null,
                completedAt: now,
            },
        });
        return null;
    }

    const claimToken = input.claimToken ?? randomUUID();
    const claimed = await db.changeOrderAutomationJob.updateMany({
        where,
        data: {
            status: "PROCESSING",
            attempts: { increment: 1 },
            nextAttemptAt: null,
            processingStartedAt: now,
            claimToken,
            completedAt: null,
        },
    });
    if (claimed.count !== 1) return null;

    const row = await db.changeOrderAutomationJob.findUnique({ where: { id: candidate.id } });
    return row?.status === "PROCESSING" && row.claimToken === claimToken ? row : null;
}

export type CompleteChangeOrderAutomationJobInput = {
    jobId: string;
    claimToken: string;
    result?: Prisma.InputJsonValue;
    providerMessageId?: string | null;
    now?: Date;
};

/** Complete a claimed job. A stale or incorrect claim token always no-ops. */
export async function completeChangeOrderAutomationJob(
    db: ChangeOrderAutomationJobClient,
    input: CompleteChangeOrderAutomationJobInput,
): Promise<boolean> {
    const row = await db.changeOrderAutomationJob.findUnique({ where: { id: input.jobId } });
    if (!row || row.status !== "PROCESSING" || row.claimToken !== input.claimToken) return false;
    const done = await db.changeOrderAutomationJob.updateMany({
        where: observedStateWhere(row),
        data: {
            status: "SUCCEEDED",
            ...terminalSanitizationData(row, "SUCCEEDED", input.result),
            ...(input.providerMessageId === undefined ? {} : { providerMessageId: input.providerMessageId }),
            lastError: null,
            nextAttemptAt: null,
            processingStartedAt: null,
            claimToken: null,
            completedAt: input.now ?? new Date(),
        },
    });
    return done.count === 1;
}

export type RescheduleChangeOrderAutomationJobInput = {
    jobId: string;
    claimToken: string;
    error: string;
    nextAttemptAt: Date;
    /** False only when the provider conclusively rejected and no reconciliation can need the bytes. */
    retainFrozenPayloadForReconciliation?: boolean;
    now?: Date;
};

/**
 * Release a failed claim for retry, or park it for human intervention after
 * the final permitted attempt. The claim token prevents an expired worker from
 * rescheduling work now owned (or completed) by somebody else.
 */
export async function rescheduleChangeOrderAutomationJob(
    db: ChangeOrderAutomationJobClient,
    input: RescheduleChangeOrderAutomationJobInput,
): Promise<"PENDING" | "NEEDS_ATTENTION" | null> {
    const row = await db.changeOrderAutomationJob.findUnique({ where: { id: input.jobId } });
    if (!row || row.status !== "PROCESSING" || row.claimToken !== input.claimToken) return null;

    const exhausted = row.attempts >= row.maxAttempts;
    const status = exhausted ? "NEEDS_ATTENTION" : "PENDING";
    const changed = await db.changeOrderAutomationJob.updateMany({
        where: {
            id: row.id,
            status: "PROCESSING",
            attempts: row.attempts,
            claimToken: input.claimToken,
        },
        data: {
            status,
            ...(exhausted
                ? terminalSanitizationData(
                    row,
                    "NEEDS_ATTENTION",
                    undefined,
                    input.retainFrozenPayloadForReconciliation,
                )
                : {}),
            lastError: input.error.slice(0, 2_000),
            nextAttemptAt: exhausted ? null : input.nextAttemptAt,
            processingStartedAt: null,
            claimToken: null,
            completedAt: exhausted ? (input.now ?? new Date()) : null,
        },
    });
    return changed.count === 1 ? status : null;
}

export type CheckpointChangeOrderAutomationProviderDispatchInput = {
    jobId: string;
    claimToken: string;
    dispatch: FrozenNotification;
    /** Metadata fields absent from the already-frozen payload are filled once. */
    payload?: Prisma.InputJsonObject;
    now?: Date;
};

function jsonObject(value: Prisma.JsonValue | null): Prisma.JsonObject | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

type TerminalAutomationJobStatus = "SUCCEEDED" | "SKIPPED" | "CANCELED" | "NEEDS_ATTENTION";
type TerminalSanitizationRow = Pick<
    ChangeOrderAutomationJobRecord,
    "kind" | "payload" | "result" | "firstProviderAttemptAt"
>;

function terminalAuditSha256(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function terminalStringContainsPortalCredential(value: string, key: string): boolean {
    return /portal.*url|url.*portal/i.test(key)
        || /\/(?:api\/)?portal(?:\/|\?)/i.test(value)
        || /[?&](?:token|access_token)=/i.test(value);
}

function terminalSafeJson(value: unknown, key = ""): Prisma.InputJsonValue | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
        return terminalStringContainsPortalCredential(value, key)
            ? `[redacted-url sha256=${terminalAuditSha256(value)}]`
            : value;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
        return value.map(item => terminalSafeJson(item)) as Prisma.InputJsonArray;
    }
    if (typeof value !== "object") return String(value);

    const source = value as Record<string, unknown>;
    const output: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [childKey, childValue] of Object.entries(source)) {
        if (childValue === undefined) continue;
        if (childKey === "dispatch" && childValue && typeof childValue === "object" && !Array.isArray(childValue)) {
            const dispatch = childValue as Record<string, unknown>;
            const audit: Record<string, Prisma.InputJsonValue | null> = {
                contentRedacted: true,
                sha256: terminalAuditSha256(dispatch),
            };
            for (const metadataKey of ["from", "to", "replyTo", "subject", "cc", "bcc"] as const) {
                if (dispatch[metadataKey] !== undefined) {
                    audit[metadataKey] = terminalSafeJson(dispatch[metadataKey], metadataKey);
                }
            }
            output.dispatchAudit = audit as Prisma.InputJsonObject;
            continue;
        }
        output[childKey] = terminalSafeJson(childValue, childKey);
    }
    return output as Prisma.InputJsonObject;
}

/**
 * A provider-started email parked in NEEDS_ATTENTION is conservatively retained
 * when its outcome may require delivery reconciliation. A caller with a
 * conclusive provider rejection opts out explicitly. Pre-provider attention
 * rows and every other terminal status have no legal retry path, so bearer
 * content is replaced by an audit hash in the same fenced terminal update.
 */
function retainFrozenPayloadForReconciliation(
    row: TerminalSanitizationRow,
    status: TerminalAutomationJobStatus,
    requested?: boolean,
): boolean {
    return status === "NEEDS_ATTENTION"
        && requested !== false
        && row.firstProviderAttemptAt !== null
        && EMAIL_JOB_KINDS.has(row.kind as ChangeOrderAutomationJobKind);
}

function terminalSanitizationData(
    row: TerminalSanitizationRow,
    status: TerminalAutomationJobStatus,
    resultOverride?: Prisma.InputJsonValue,
    retainFrozenPayload?: boolean,
): { payload?: Prisma.InputJsonValue; result?: Prisma.InputJsonValue } {
    const data: { payload?: Prisma.InputJsonValue; result?: Prisma.InputJsonValue } = {};
    if (!retainFrozenPayloadForReconciliation(row, status, retainFrozenPayload) && row.payload !== null) {
        data.payload = terminalSafeJson(row.payload) as Prisma.InputJsonValue;
    }
    const result = resultOverride === undefined ? row.result : resultOverride;
    if (result !== null && result !== undefined) {
        // Results are never provider retry input, even when the frozen payload
        // must remain for a NEEDS_ATTENTION reconciliation.
        data.result = terminalSafeJson(result) as Prisma.InputJsonValue;
    }
    return data;
}

/**
 * Fenced pre-provider checkpoint. Before the first attempt it validates and
 * freezes a complete dispatch, records the provider horizon, and renews the
 * lease in one CAS. Once attempted, payload and horizon remain immutable.
 */
export async function checkpointChangeOrderAutomationProviderDispatch(
    db: ChangeOrderAutomationJobClient,
    input: CheckpointChangeOrderAutomationProviderDispatchInput,
): Promise<ChangeOrderAutomationJobRecord | null> {
    const row = await db.changeOrderAutomationJob.findUnique({ where: { id: input.jobId } });
    if (!row || row.status !== "PROCESSING" || row.claimToken !== input.claimToken) return null;
    if (!EMAIL_JOB_KINDS.has(row.kind as ChangeOrderAutomationJobKind)) {
        throw new Error("Provider dispatch checkpoint is only valid for email jobs");
    }

    const existingPayload = jsonObject(row.payload);
    if (row.payload !== null && !existingPayload) {
        throw new Error("Change-order automation payload must be a JSON object");
    }
    const incomingDispatch = frozenNotificationJson(input.dispatch);
    const frozenDispatch =
        existingPayload?.dispatch === undefined
            ? incomingDispatch
            : frozenNotificationFromJson(existingPayload.dispatch);
    const mergedPayload = {
        ...(input.payload ?? {}),
        ...(existingPayload ?? {}),
        dispatch: frozenDispatch,
    } satisfies Prisma.InputJsonObject;
    const now = input.now ?? new Date();
    const firstProviderAttemptAt = row.firstProviderAttemptAt ?? now;
    const recorded = await db.changeOrderAutomationJob.updateMany({
        where: {
            id: row.id,
            status: "PROCESSING",
            attempts: row.attempts,
            claimToken: input.claimToken,
            processingStartedAt: row.processingStartedAt,
            firstProviderAttemptAt: row.firstProviderAttemptAt,
        },
        data: {
            ...(row.firstProviderAttemptAt === null ? { payload: mergedPayload } : {}),
            firstProviderAttemptAt,
            processingStartedAt: now,
        },
    });
    if (recorded.count !== 1) return null;

    const current = await db.changeOrderAutomationJob.findUnique({ where: { id: row.id } });
    return current?.status === "PROCESSING" && current.claimToken === input.claimToken ? current : null;
}

export type RenewChangeOrderAutomationJobLeaseInput = {
    jobId: string;
    claimToken: string;
    now?: Date;
};

/** Renew and re-verify a fence immediately before any non-idempotent side effect. */
export async function renewChangeOrderAutomationJobLease(
    db: ChangeOrderAutomationJobClient,
    input: RenewChangeOrderAutomationJobLeaseInput,
): Promise<ChangeOrderAutomationJobRecord | null> {
    const now = input.now ?? new Date();
    const renewed = await db.changeOrderAutomationJob.updateMany({
        where: { id: input.jobId, status: "PROCESSING", claimToken: input.claimToken },
        data: { processingStartedAt: now },
    });
    if (renewed.count !== 1) return null;
    const current = await db.changeOrderAutomationJob.findUnique({ where: { id: input.jobId } });
    return current?.status === "PROCESSING" && current.claimToken === input.claimToken ? current : null;
}

/** Integration-facing name for the fenced retry release transition. */
export async function releaseChangeOrderAutomationJob(
    db: ChangeOrderAutomationJobClient,
    input: RescheduleChangeOrderAutomationJobInput,
): Promise<"PENDING" | "NEEDS_ATTENTION" | null> {
    return rescheduleChangeOrderAutomationJob(db, input);
}

type ClaimedTerminalInput = {
    jobId: string;
    claimToken: string;
    result?: Prisma.InputJsonValue;
    error?: string;
    retainFrozenPayloadForReconciliation?: boolean;
    now?: Date;
};

async function markClaimedTerminal(
    db: ChangeOrderAutomationJobClient,
    input: ClaimedTerminalInput,
    status: "SKIPPED" | "CANCELED" | "NEEDS_ATTENTION",
): Promise<boolean> {
    const row = await db.changeOrderAutomationJob.findUnique({ where: { id: input.jobId } });
    if (!row || row.status !== "PROCESSING" || row.claimToken !== input.claimToken) return false;
    const changed = await db.changeOrderAutomationJob.updateMany({
        where: observedStateWhere(row),
        data: {
            status,
            ...terminalSanitizationData(
                row,
                status,
                input.result,
                input.retainFrozenPayloadForReconciliation,
            ),
            lastError: status === "NEEDS_ATTENTION" ? (input.error ?? "Needs attention").slice(0, 2_000) : null,
            nextAttemptAt: null,
            processingStartedAt: null,
            claimToken: null,
            completedAt: input.now ?? new Date(),
        },
    });
    return changed.count === 1;
}

export type MarkChangeOrderAutomationJobTerminalInput = Omit<ClaimedTerminalInput, "error">;

export function markChangeOrderAutomationJobSkipped(
    db: ChangeOrderAutomationJobClient,
    input: MarkChangeOrderAutomationJobTerminalInput,
): Promise<boolean> {
    return markClaimedTerminal(db, input, "SKIPPED");
}

export function markChangeOrderAutomationJobCanceled(
    db: ChangeOrderAutomationJobClient,
    input: MarkChangeOrderAutomationJobTerminalInput,
): Promise<boolean> {
    return markClaimedTerminal(db, input, "CANCELED");
}

export type MarkChangeOrderAutomationJobNeedsAttentionInput = ClaimedTerminalInput & { error: string };

export function markChangeOrderAutomationJobNeedsAttention(
    db: ChangeOrderAutomationJobClient,
    input: MarkChangeOrderAutomationJobNeedsAttentionInput,
): Promise<boolean> {
    return markClaimedTerminal(db, input, "NEEDS_ATTENTION");
}

/**
 * Cancel obsolete, not-yet-claimed review dispatches in the caller's scope-write
 * transaction. `exceptJobId` preserves the freshly-created replacement.
 */
export async function cancelPendingReviewJobs(
    tx: ChangeOrderAutomationJobClient,
    changeOrderId: string,
    exceptJobId?: string,
    now = new Date(),
): Promise<number> {
    const candidates = await tx.changeOrderAutomationJob.findMany({
        where: {
            changeOrderId,
            kind: "REVIEW_EMAIL",
            status: "PENDING",
            firstProviderAttemptAt: null,
            ...(exceptJobId ? { id: { not: exceptJobId } } : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    let canceled = 0;
    for (const row of candidates) {
        const result = {
            code: "REVISION_CONFLICT",
            error: "Superseded by a scope change or newer review dispatch",
        } satisfies Prisma.InputJsonObject;
        const changed = await tx.changeOrderAutomationJob.updateMany({
            where: observedStateWhere(row),
            data: {
                status: "CANCELED",
                ...terminalSanitizationData(row, "CANCELED", result),
                lastError: null,
                nextAttemptAt: null,
                processingStartedAt: null,
                claimToken: null,
                completedAt: now,
            },
        });
        canceled += changed.count;
    }
    return canceled;
}

export class ChangeOrderReviewDeliveryUnresolvedError extends Error {
    constructor() {
        super("A change-order review email is still being delivered or needs attention. Wait for delivery recovery before changing its scope or status.");
        this.name = "ChangeOrderReviewDeliveryUnresolvedError";
    }
}

export class ChangeOrderParentDeleteBlockedError extends Error {
    constructor() {
        super("This project or estimate contains sent, signed, approved, or automated change-order audit history and cannot be deleted.");
        this.name = "ChangeOrderParentDeleteBlockedError";
    }
}

type LockedAutomationJob = {
    id: string;
    kind: string;
    status: string;
    firstProviderAttemptAt: Date | null;
    providerMessageId: string | null;
};

async function lockAutomationJobs(
    tx: ChangeOrderAutomationJobLockClient,
    changeOrderId: string,
): Promise<LockedAutomationJob[]> {
    // Every caller must already hold the ChangeOrder row lock. Keeping the one
    // CO -> job lock order lets a scope mutation serialize with REVIEW_EMAIL's
    // final provider transaction without deadlocking.
    return tx.$queryRaw<LockedAutomationJob[]>`
        SELECT "id", "kind", "status", "firstProviderAttemptAt", "providerMessageId"
        FROM "ChangeOrderAutomationJob"
        WHERE "changeOrderId" = ${changeOrderId}
        ORDER BY "createdAt" ASC, "id" ASC
        FOR UPDATE`;
}

/**
 * Fence a CO scope/status write against review delivery. Unclaimed work is
 * canceled under lock; claimed, ambiguous, or attention-required work blocks
 * the mutation so cron can never send a stale frozen dispatch afterward.
 */
export async function prepareChangeOrderReviewJobsForMutation(
    tx: ChangeOrderAutomationJobLockClient,
    changeOrderId: string,
    exceptJobId?: string,
): Promise<number> {
    const rows = await lockAutomationJobs(tx, changeOrderId);
    const unresolved = rows.some((row) =>
        row.kind === "REVIEW_EMAIL"
        && row.id !== exceptJobId
        && (
            row.status === "PROCESSING"
            || row.status === "NEEDS_ATTENTION"
            || (row.status === "PENDING" && (row.firstProviderAttemptAt !== null || row.providerMessageId !== null))
        ));
    if (unresolved) throw new ChangeOrderReviewDeliveryUnresolvedError();
    return cancelPendingReviewJobs(tx, changeOrderId, exceptJobId);
}

/**
 * Prepare an unsigned Draft CO for deletion while preserving every durable
 * provider/audit record. Only never-attempted PENDING/CANCELED review rows can
 * be removed; anything else is a clear, retained audit-history conflict.
 */
export async function removeSafeReviewJobsForDraftDelete(
    tx: ChangeOrderAutomationJobLockClient,
    changeOrderId: string,
): Promise<number> {
    const rows = await lockAutomationJobs(tx, changeOrderId);
    const unsafe = rows.some((row) =>
        row.kind !== "REVIEW_EMAIL"
        || !["PENDING", "CANCELED"].includes(row.status)
        || row.firstProviderAttemptAt !== null
        || row.providerMessageId !== null);
    if (unsafe) {
        throw new Error("This change order has automation audit history and cannot be deleted.");
    }
    if (rows.length === 0) return 0;
    const deleted = await tx.changeOrderAutomationJob.deleteMany({
        where: {
            changeOrderId,
            kind: "REVIEW_EMAIL",
            status: { in: ["PENDING", "CANCELED"] },
            firstProviderAttemptAt: null,
            providerMessageId: null,
        },
    });
    return deleted.count;
}

type ParentDeleteChangeOrder = {
    id: string;
    status: string;
    approvedBy: string | null;
    approvedAt: Date | null;
    clientSignatureUrl: string | null;
    companySignedBy: string | null;
    companySignedAt: Date | null;
    companySignatureUrl: string | null;
};

type ChangeOrderParentDeleteClient = ChangeOrderAutomationJobLockClient & Pick<Prisma.TransactionClient, "changeOrder">;

export type ChangeOrderParentDeleteScope =
    | { projectIds: readonly string[]; estimateIds?: never }
    | { estimateIds: readonly string[]; projectIds?: never };

/**
 * Reconcile descendant COs before a Project/Estimate cascade. For Project
 * scope the caller must first lock Project rows in stable order (Project -> CO
 * -> job, matching schedule/review workers). Estimate deletion uses CO -> job
 * -> Estimate, matching billing's CO-before-Estimate order.
 * Only unsigned Draft COs with never-attempted review rows are deletable;
 * lifecycle/signature history is preserved even for pre-outbox legacy rows.
 */
export async function prepareChangeOrdersForParentDelete(
    tx: ChangeOrderParentDeleteClient,
    scope: ChangeOrderParentDeleteScope,
): Promise<{ changeOrders: number; removedJobs: number }> {
    const projectIds = "projectIds" in scope
        ? [...new Set((scope.projectIds ?? []).map(id => id.trim()).filter(Boolean))]
        : [];
    const estimateIds = "estimateIds" in scope
        ? [...new Set((scope.estimateIds ?? []).map(id => id.trim()).filter(Boolean))]
        : [];
    if ((projectIds.length > 0) === (estimateIds.length > 0)) {
        if (projectIds.length === 0 && estimateIds.length === 0) {
            return { changeOrders: 0, removedJobs: 0 };
        }
        throw new Error("Exactly one parent-delete scope is required");
    }

    const candidates = await tx.changeOrder.findMany({
        where: projectIds.length > 0
            ? { projectId: { in: projectIds } }
            : { estimateId: { in: estimateIds } },
        select: { id: true },
        orderBy: { id: "asc" },
    });
    let removedJobs = 0;
    for (const candidate of candidates) {
        const [current] = await tx.$queryRaw<ParentDeleteChangeOrder[]>`
            SELECT "id", "status",
                   "approvedBy", "approvedAt", "clientSignatureUrl",
                   "companySignedBy", "companySignedAt", "companySignatureUrl"
            FROM "ChangeOrder" WHERE "id" = ${candidate.id} FOR UPDATE`;
        if (!current) continue;
        const hasSignatureAudit = Boolean(
            current.approvedBy
            || current.approvedAt
            || current.clientSignatureUrl
            || current.companySignedBy
            || current.companySignedAt
            || current.companySignatureUrl,
        );
        if (current.status !== "Draft" || hasSignatureAudit) {
            throw new ChangeOrderParentDeleteBlockedError();
        }
        try {
            removedJobs += await removeSafeReviewJobsForDraftDelete(tx, current.id);
        } catch (error) {
            if (error instanceof Error && /automation audit history/i.test(error.message)) {
                throw new ChangeOrderParentDeleteBlockedError();
            }
            throw error;
        }
    }
    return { changeOrders: candidates.length, removedJobs };
}
