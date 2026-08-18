export type ChangeOrderApprovalMode = "CLIENT" | "MANUAL";
export type ChangeOrderPricingType = "FIXED" | "COST_PLUS";
export type ChangeOrderApprovalJobKind =
    | "APPROVAL_BILL"
    | "APPROVAL_CLIENT_EMAIL"
    | "APPROVAL_SCHEDULE"
    | "APPROVAL_TEAM_EMAIL";

/** Every approval-side kind (REVIEW_EMAIL excluded) — the set legacy recovery scopes its "has jobs already?" checks to. */
export const APPROVAL_JOB_KINDS: readonly ChangeOrderApprovalJobKind[] = [
    "APPROVAL_BILL",
    "APPROVAL_CLIENT_EMAIL",
    "APPROVAL_SCHEDULE",
    "APPROVAL_TEAM_EMAIL",
];

const PROVIDER_IDEMPOTENCY_HORIZON_MS = 24 * 60 * 60_000;

/** The immutable job graph enqueued in the same transaction as approval. */
export function approvalJobKinds(
    pricingType: ChangeOrderPricingType,
    approvalMode: ChangeOrderApprovalMode,
): ChangeOrderApprovalJobKind[] {
    if (pricingType === "COST_PLUS") {
        return ["APPROVAL_SCHEDULE", "APPROVAL_TEAM_EMAIL"];
    }
    return approvalMode === "CLIENT"
        ? ["APPROVAL_BILL", "APPROVAL_CLIENT_EMAIL", "APPROVAL_SCHEDULE", "APPROVAL_TEAM_EMAIL"]
        : ["APPROVAL_BILL", "APPROVAL_SCHEDULE", "APPROVAL_TEAM_EMAIL"];
}

export function providerIdempotencyKey(jobId: string): string {
    return `co-job/${jobId}`;
}

/** Resend keeps idempotency keys for 24h; never auto-send past that horizon. */
export function canRetryProviderAttempt(firstAttemptAt: Date | null, now = new Date()): boolean {
    return !firstAttemptAt || now.getTime() - firstAttemptAt.getTime() < PROVIDER_IDEMPOTENCY_HORIZON_MS;
}

export type ChangeOrderAutomationExecutionResult =
    | { kind: "success"; result?: Record<string, unknown>; providerMessageId?: string | null }
    | {
        kind: "retry";
        error: string;
        retryAt?: Date;
        retainFrozenPayloadForReconciliation?: boolean;
    }
    | { kind: "skipped"; result?: Record<string, unknown> }
    | { kind: "canceled"; result?: Record<string, unknown> }
    | {
        kind: "needs-attention";
        error: string;
        result?: Record<string, unknown>;
        retainFrozenPayloadForReconciliation?: boolean;
    }
    | { kind: "completed" };

export type AutomationJobLike = {
    id: string;
    changeOrderId: string;
    eventRevision: number;
    kind: string;
    approvalMode: string | null;
    status: string;
    payload: unknown;
    result: unknown;
    idempotencyKey: string;
    attempts: number;
    maxAttempts: number;
    nextAttemptAt: Date | null;
    firstProviderAttemptAt: Date | null;
    processingStartedAt: Date | null;
    claimToken: string | null;
};

type AutomationQueueClient = {
    changeOrderAutomationJob: {
        findMany(args: any): Promise<AutomationJobLike[]>;
        findUnique(args: any): Promise<any>;
        updateMany(args: any): Promise<{ count: number }>;
    };
};

export type DrainChangeOrderAutomationOptions = {
    jobId?: string;
    changeOrderId?: string;
    eventRevision?: number;
    limit?: number;
};

export type DrainChangeOrderAutomationDependencies = {
    db?: AutomationQueueClient;
    now?: () => Date;
    isEligible?: (job: AutomationJobLike) => Promise<boolean>;
    executeJob?: (job: AutomationJobLike) => Promise<ChangeOrderAutomationExecutionResult>;
};

async function defaultApprovalOrReviewEligible(job: AutomationJobLike): Promise<boolean> {
    if (job.kind === "REVIEW_EMAIL") return true;
    const { isApprovalAutomationJobEligible } = await import("./change-order-approval-automation");
    return isApprovalAutomationJobEligible(job as never);
}

async function defaultApprovalOrReviewExecutor(
    job: AutomationJobLike,
): Promise<ChangeOrderAutomationExecutionResult> {
    if (job.kind === "REVIEW_EMAIL") {
        const { executeReviewEmailAutomationJob } = await import("./change-order-review-automation");
        return executeReviewEmailAutomationJob(job);
    }
    const { executeApprovalAutomationJob } = await import("./change-order-approval-automation");
    return executeApprovalAutomationJob(job as never);
}

/**
 * Shared inline/cron queue loop. Candidate discovery is deliberately separate
 * from the atomic claim; any number of workers may see a row, but only the
 * compare-and-swap winner receives a fencing token and executes it.
 */
export async function drainChangeOrderAutomationJobs(
    options: DrainChangeOrderAutomationOptions = {},
    dependencies: DrainChangeOrderAutomationDependencies = {},
): Promise<{ processed: number; retried: number; skipped: number; canceled: number; needsAttention: number }> {
    const { prisma } = dependencies.db ? { prisma: dependencies.db } : await import("./prisma");
    const db = prisma as unknown as AutomationQueueClient;
    const clock = () => dependencies.now?.() ?? new Date();
    // Tests and specialized callers may provide only an executor, in which
    // case every discovered row is intentionally eligible. Production callers
    // omit both hooks and receive the complete approval/review dispatcher.
    const isEligible = dependencies.isEligible
        ?? (dependencies.executeJob ? undefined : defaultApprovalOrReviewEligible);
    const executeJob = dependencies.executeJob ?? defaultApprovalOrReviewExecutor;
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const result = { processed: 0, retried: 0, skipped: 0, canceled: 0, needsAttention: 0 };
    const jobs = await import("./change-order-automation-jobs");
    const terminalStatuses = new Set(["SUCCEEDED", "SKIPPED", "CANCELED", "NEEDS_ATTENTION"]);
    const pageSize = options.jobId ? 1 : Math.min(100, Math.max(25, limit * 4));
    let cursorId: string | undefined;
    let claimedCount = 0;
    let exhausted = false;

    while (!exhausted && claimedCount < limit) {
        const discoveryNow = clock();
        const staleBefore = new Date(discoveryNow.getTime() - 5 * 60_000);
        const where = options.jobId
            ? { id: options.jobId }
            : {
                ...(options.changeOrderId ? { changeOrderId: options.changeOrderId } : {}),
                ...(options.eventRevision !== undefined ? { eventRevision: options.eventRevision } : {}),
                OR: [
                    { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: discoveryNow } }] },
                    { status: "PROCESSING", processingStartedAt: { lt: staleBefore } },
                ],
            };
        const candidates = await db.changeOrderAutomationJob.findMany({
            where,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: pageSize,
            ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });
        if (candidates.length === 0) break;
        exhausted = options.jobId === undefined && candidates.length < pageSize;
        cursorId = candidates[candidates.length - 1]?.id;

        for (const candidate of candidates) {
            if (claimedCount >= limit) break;
            if (isEligible && !(await isEligible(candidate))) continue;
            const claimed = await jobs.claimChangeOrderAutomationJob(db as never, {
                jobId: candidate.id,
                now: clock(),
            });
            if (!claimed?.claimToken) {
                // The claim itself terminally parks an exhausted job
                // (attempts >= maxAttempts -> NEEDS_ATTENTION) and returns
                // null. That transition IS progress — it can unblock
                // dependents — so it must be counted, or the until-idle
                // wrapper sees an all-zero pass and stops with newly eligible
                // work still pending (Codex round 7).
                if (candidate.attempts >= candidate.maxAttempts) {
                    const current = await db.changeOrderAutomationJob.findUnique({ where: { id: candidate.id } });
                    if (current?.status === "NEEDS_ATTENTION" && current.claimToken === null) {
                        result.needsAttention++;
                    }
                }
                continue;
            }
            claimedCount++;

            let outcome: ChangeOrderAutomationExecutionResult;
            try {
                outcome = await executeJob(claimed as AutomationJobLike);
            } catch (error: any) {
                outcome = {
                    kind: "retry",
                    error: String(error?.message ?? error),
                };
            }

            if (outcome.kind === "completed") {
                const current = await db.changeOrderAutomationJob.findUnique({ where: { id: claimed.id } });
                if (current && terminalStatuses.has(current.status)) {
                    if (current.status === "SUCCEEDED") result.processed++;
                    if (current.status === "SKIPPED") result.skipped++;
                    if (current.status === "CANCELED") result.canceled++;
                    if (current.status === "NEEDS_ATTENTION") result.needsAttention++;
                    continue;
                }
                const transitionNow = clock();
                const state = await jobs.releaseChangeOrderAutomationJob(db as never, {
                    jobId: claimed.id,
                    claimToken: claimed.claimToken,
                    error: "Automation executor reported completion but did not durably finalize its fenced job",
                    nextAttemptAt: new Date(transitionNow.getTime() + 60_000),
                    now: transitionNow,
                });
                if (state === "PENDING") result.retried++;
                if (state === "NEEDS_ATTENTION") result.needsAttention++;
                continue;
            }
            if (outcome.kind === "success") {
                const completed = await jobs.completeChangeOrderAutomationJob(db as never, {
                    jobId: claimed.id,
                    claimToken: claimed.claimToken,
                    ...(outcome.result ? { result: outcome.result as never } : {}),
                    ...(outcome.providerMessageId !== undefined ? { providerMessageId: outcome.providerMessageId } : {}),
                    now: clock(),
                });
                if (completed) result.processed++;
                continue;
            }
            if (outcome.kind === "skipped" || outcome.kind === "canceled") {
                const terminal = outcome.kind === "skipped"
                    ? jobs.markChangeOrderAutomationJobSkipped
                    : jobs.markChangeOrderAutomationJobCanceled;
                const changed = await terminal(db as never, {
                    jobId: claimed.id,
                    claimToken: claimed.claimToken,
                    ...(outcome.result ? { result: outcome.result as never } : {}),
                    now: clock(),
                });
                if (changed) result[outcome.kind === "skipped" ? "skipped" : "canceled"]++;
                continue;
            }
            if (outcome.kind === "needs-attention") {
                const changed = await jobs.markChangeOrderAutomationJobNeedsAttention(db as never, {
                    jobId: claimed.id,
                    claimToken: claimed.claimToken,
                    error: outcome.error,
                    ...(outcome.result ? { result: outcome.result as never } : {}),
                    ...(outcome.retainFrozenPayloadForReconciliation === undefined
                        ? {}
                        : { retainFrozenPayloadForReconciliation: outcome.retainFrozenPayloadForReconciliation }),
                    now: clock(),
                });
                if (changed) result.needsAttention++;
                continue;
            }

            const transitionNow = clock();
            const state = await jobs.releaseChangeOrderAutomationJob(db as never, {
                jobId: claimed.id,
                claimToken: claimed.claimToken,
                error: outcome.error,
                nextAttemptAt: outcome.retryAt ?? new Date(transitionNow.getTime() + 60_000),
                ...(outcome.retainFrozenPayloadForReconciliation === undefined
                    ? {}
                    : { retainFrozenPayloadForReconciliation: outcome.retainFrozenPayloadForReconciliation }),
                now: transitionNow,
            });
            if (state === "PENDING") result.retried++;
            if (state === "NEEDS_ATTENTION") result.needsAttention++;
        }
    }

    return result;
}

/**
 * Targeted inline drain for a single approval/send event. A dependent job can
 * sort before its prerequisite, so repeat discovery after every terminal
 * transition until no more immediate work is possible. Retried rows have a
 * future nextAttemptAt and are left for the cron backstop.
 */
export async function drainChangeOrderAutomationUntilIdle(
    options: DrainChangeOrderAutomationOptions = {},
    dependencies: DrainChangeOrderAutomationDependencies = {},
    maxPasses = 8,
): Promise<{ processed: number; retried: number; skipped: number; canceled: number; needsAttention: number }> {
    const aggregate = { processed: 0, retried: 0, skipped: 0, canceled: 0, needsAttention: 0 };
    const passes = Math.max(1, Math.min(maxPasses, 20));
    for (let pass = 0; pass < passes; pass++) {
        const result = await drainChangeOrderAutomationJobs(options, dependencies);
        aggregate.processed += result.processed;
        aggregate.retried += result.retried;
        aggregate.skipped += result.skipped;
        aggregate.canceled += result.canceled;
        aggregate.needsAttention += result.needsAttention;
        if (result.processed + result.skipped + result.canceled + result.needsAttention === 0) break;
    }
    return aggregate;
}
