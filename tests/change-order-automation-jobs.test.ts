import { before, test } from "node:test";
import assert from "node:assert/strict";

let jobsModule: Record<string, any> = {};
before(async () => {
    try {
        jobsModule = await import("../src/lib/change-order-automation-jobs");
    } catch {
        // RED starts with the wished-for module absent. The assertion below,
        // rather than an import crash, records the missing behavior clearly.
    }
});

type StoredJob = Record<string, any>;

function frozenDispatch(to: string, subject = "Change order") {
    return {
        from: "Golden Touch Remodeling <notifications@goldentouchremodeling.com>",
        to: [to],
        replyTo: "jadkins@goldentouchremodeling.com",
        subject,
        html: `<p>${subject}</p>`,
        text: subject,
    };
}

const PORTAL_BEARER_URL =
    "https://app.example.test/api/portal/verify?token=eyJhbGciOiJIUzI1NiJ9.secret-signature&next=%2Fportal%2Fchange-orders%2Fco-1";

function frozenPortalDispatch(to: string, subject = "Change order") {
    return {
        ...frozenDispatch(to, subject),
        html: `<p><a href="${PORTAL_BEARER_URL}">Review</a></p>`,
        text: `Review: ${PORTAL_BEARER_URL}`,
    };
}

function assertTerminalDispatchRedacted(row: StoredJob): void {
    const serialized = JSON.stringify({ payload: row.payload, result: row.result });
    assert.doesNotMatch(serialized, /secret-signature/);
    assert.doesNotMatch(serialized, /\/api\/portal\/verify/i);
    assert.equal(row.payload.dispatch, undefined);
    assert.equal(row.payload.dispatchAudit.contentRedacted, true);
    assert.match(row.payload.dispatchAudit.sha256, /^[a-f0-9]{64}$/);
    assert.equal(row.payload.dispatchAudit.subject, "Change order");
}

function memoryJobStore() {
    const rows = new Map<string, StoredJob>();
    const keyFor = (row: { dedupeKey: string }) => row.dedupeKey;

    const same = (left: unknown, right: unknown): boolean => {
        if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
        if (right && typeof right === "object" && "not" in right) return !same(left, right.not);
        if (right && typeof right === "object" && "in" in right) {
            return Array.isArray(right.in) && right.in.some((candidate: unknown) => same(left, candidate));
        }
        return left === right;
    };

    const matches = (row: StoredJob, where: StoredJob) =>
        Object.entries(where).every(([field, expected]) => same(row[field], expected));

    const applyData = (row: StoredJob, data: StoredJob) => {
        for (const [field, value] of Object.entries(data)) {
            row[field] =
                value && typeof value === "object" && "increment" in value
                    ? row[field] + value.increment
                    : value;
        }
    };

    const model = {
        async upsert(args: any) {
            const key = keyFor(args.create);
            const existing = rows.get(key);
            if (existing) return { ...existing };
            const created = {
                status: "PENDING",
                attempts: 0,
                maxAttempts: 8,
                nextAttemptAt: null,
                firstProviderAttemptAt: null,
                processingStartedAt: null,
                claimToken: null,
                result: null,
                providerMessageId: null,
                lastError: null,
                completedAt: null,
                createdAt: new Date("2026-08-16T12:00:00.000Z"),
                updatedAt: new Date("2026-08-16T12:00:00.000Z"),
                ...args.create,
            };
            rows.set(key, created);
            return { ...created };
        },
        async findUnique(args: any) {
            const row = [...rows.values()].find((candidate) => matches(candidate, args.where));
            return row ? { ...row } : null;
        },
        async findMany(args: any) {
            return [...rows.values()]
                .filter((candidate) => matches(candidate, args.where ?? {}))
                .map(row => ({ ...row }));
        },
        async updateMany(args: any) {
            let count = 0;
            for (const row of rows.values()) {
                if (!matches(row, args.where)) continue;
                applyData(row, args.data);
                count++;
            }
            return { count };
        },
    };
    return { tx: { changeOrderAutomationJob: model }, rows };
}

async function readStoredJob(tx: any, id: string): Promise<StoredJob> {
    const row = await tx.changeOrderAutomationJob.findUnique({ where: { id } });
    assert.ok(row, `expected automation job ${id} to exist`);
    return row;
}

async function seedPendingJob(
    tx: any,
    input: {
        id: string;
        changeOrderId: string;
        eventRevision: number;
        kind: string;
        approvalMode?: "CLIENT" | "MANUAL" | null;
        payload?: StoredJob;
        maxAttempts?: number;
    },
) {
    return tx.changeOrderAutomationJob.upsert({
        where: { dedupeKey: `test/${input.id}` },
        update: {},
        create: {
            ...input,
            approvalMode: input.approvalMode ?? null,
            status: "PENDING",
            idempotencyKey: `co-job/${input.id}`,
            dedupeKey: `test/${input.id}`,
            maxAttempts: input.maxAttempts ?? 8,
        },
    });
}

test("approval enqueue creates the exact graph and preserves first frozen payloads on replay", async () => {
    assert.equal(
        typeof jobsModule.enqueueApprovalAutomationJobs,
        "function",
        "approval automation enqueue helper must exist",
    );

    const { tx, rows } = memoryJobStore();
    const first = await jobsModule.enqueueApprovalAutomationJobs(tx, {
        changeOrderId: "co-1",
        eventRevision: 7,
        approvalMode: "CLIENT",
        pricingType: "FIXED",
        payloads: {
            APPROVAL_BILL: { signedSubtotalCents: 125_00 },
            APPROVAL_CLIENT_EMAIL: { recipientSource: "approved-client" },
            APPROVAL_SCHEDULE: { milestoneIds: ["milestone-1"] },
            APPROVAL_TEAM_EMAIL: { recipientSource: "company-settings" },
        },
    });
    const replay = await jobsModule.enqueueApprovalAutomationJobs(tx, {
        changeOrderId: "co-1",
        eventRevision: 7,
        approvalMode: "CLIENT",
        pricingType: "FIXED",
        payloads: {
            APPROVAL_BILL: { signedSubtotalCents: 999_00 },
            APPROVAL_CLIENT_EMAIL: { recipientSource: "wrong" },
            APPROVAL_SCHEDULE: { milestoneIds: ["wrong"] },
            APPROVAL_TEAM_EMAIL: { recipientSource: "wrong" },
        },
    });

    assert.equal(rows.size, 4, "same approval event must not create another durable graph");
    assert.deepEqual(
        first.map((row: StoredJob) => row.kind),
        ["APPROVAL_BILL", "APPROVAL_CLIENT_EMAIL", "APPROVAL_SCHEDULE", "APPROVAL_TEAM_EMAIL"],
    );
    assert.equal(replay.length, 4);
    assert.deepEqual(replay[0].payload, { signedSubtotalCents: 125_00 });
    assert.deepEqual(replay[1].payload, { recipientSource: "approved-client" });
    for (const row of first) {
        assert.equal(row.status, "PENDING");
        assert.equal(row.idempotencyKey, `co-job/${row.id}`);
        assert.match(row.dedupeKey, /^co-automation\/v1\/[a-f0-9]{64}$/);
    }
});

test("review generations can freeze new recipients at the same CO revision", async () => {
    const { tx, rows } = memoryJobStore();
    const first = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-review-generation",
        eventRevision: 6,
        generationKey: "preview-a",
        dispatch: frozenDispatch("first@example.test"),
    });
    const replay = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-review-generation",
        eventRevision: 6,
        generationKey: "preview-a",
        dispatch: frozenDispatch("wrong-replay@example.test"),
    });
    const recipientChanged = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-review-generation",
        eventRevision: 6,
        generationKey: "preview-b",
        dispatch: frozenDispatch("second@example.test"),
    });

    assert.equal(rows.size, 2);
    assert.equal(replay.id, first.id, "same preview generation is an idempotent replay");
    assert.deepEqual(replay.payload, { dispatch: frozenDispatch("first@example.test") });
    assert.notEqual(recipientChanged.id, first.id, "new recipient generation gets a new frozen job/key");
    assert.deepEqual(recipientChanged.payload, { dispatch: frozenDispatch("second@example.test") });
});

test("concurrent inline and cron claims have one winner and fence stale completion", async () => {
    assert.equal(typeof jobsModule.claimChangeOrderAutomationJob, "function", "claim helper must exist");
    assert.equal(typeof jobsModule.completeChangeOrderAutomationJob, "function", "completion helper must exist");

    const { tx, rows } = memoryJobStore();
    const job = await seedPendingJob(tx, {
        id: "job-race",
        changeOrderId: "co-race",
        eventRevision: 11,
        approvalMode: "CLIENT",
        kind: "APPROVAL_TEAM_EMAIL",
        payload: { dispatch: frozenDispatch("ops@example.test") },
    });
    const now = new Date("2026-08-16T12:05:00.000Z");

    const claims = await Promise.all([
        jobsModule.claimChangeOrderAutomationJob(tx, { jobId: job.id, claimToken: "inline", now }),
        jobsModule.claimChangeOrderAutomationJob(tx, { jobId: job.id, claimToken: "cron", now }),
    ]);
    const winner = claims.find(Boolean);
    const loserToken = winner?.claimToken === "inline" ? "cron" : "inline";

    assert.equal(claims.filter(Boolean).length, 1, "the status CAS must admit exactly one worker");
    assert.equal(winner.attempts, 1);
    assert.equal(winner.status, "PROCESSING");
    assert.equal(
        await jobsModule.completeChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: loserToken,
            result: { providerMessageId: "stale" },
            now,
        }),
        false,
        "a worker without the current fencing token cannot complete the job",
    );
    assert.equal(
        await jobsModule.completeChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: winner.claimToken,
            result: { providerMessageId: "msg-1" },
            providerMessageId: "msg-1",
            now,
        }),
        true,
    );

    const stored = [...rows.values()][0];
    assert.equal(stored.status, "SUCCEEDED");
    assert.deepEqual(stored.result, { providerMessageId: "msg-1" });
    assert.equal(stored.providerMessageId, "msg-1");
    assert.equal(stored.claimToken, null);
});

test("successful terminal completion removes frozen bearer content and portal URLs but retains audit metadata", async () => {
    const { tx, rows } = memoryJobStore();
    const job = await seedPendingJob(tx, {
        id: "job-terminal-success-redaction",
        changeOrderId: "co-terminal-success-redaction",
        eventRevision: 4,
        approvalMode: "CLIENT",
        kind: "REVIEW_EMAIL",
        payload: {
            expectedRevision: 4,
            dispatch: frozenPortalDispatch("client@example.test"),
        },
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: job.id,
        claimToken: "terminal-success-owner",
    });

    assert.equal(
        await jobsModule.completeChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: "terminal-success-owner",
            providerMessageId: "provider-message-terminal",
            result: {
                providerMessageId: "provider-message-terminal",
                portalUrl: PORTAL_BEARER_URL,
            },
        }),
        true,
    );

    const stored = [...rows.values()][0];
    assertTerminalDispatchRedacted(stored);
    assert.equal(stored.payload.expectedRevision, 4);
    assert.equal(stored.providerMessageId, "provider-message-terminal");
    assert.equal(stored.result.providerMessageId, "provider-message-terminal");
    assert.match(stored.result.portalUrl, /^\[redacted-url sha256=[a-f0-9]{64}\]$/);
});

test("canceled and skipped terminal helpers redact frozen bearers", async () => {
    const { tx, rows } = memoryJobStore();
    const superseded = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-terminal-helper-redaction",
        eventRevision: 1,
        generationKey: "superseded",
        dispatch: frozenPortalDispatch("old@example.test"),
    });
    const current = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-terminal-helper-redaction",
        eventRevision: 2,
        generationKey: "current",
        dispatch: frozenPortalDispatch("current@example.test"),
    });
    assert.equal(
        await jobsModule.cancelPendingReviewJobs(tx, "co-terminal-helper-redaction", current.id),
        1,
    );
    assertTerminalDispatchRedacted(await readStoredJob(tx, superseded.id));

    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: current.id,
        claimToken: "canceled-owner",
    });
    assert.equal(await jobsModule.markChangeOrderAutomationJobCanceled(tx, {
        jobId: current.id,
        claimToken: "canceled-owner",
        result: { portalUrl: PORTAL_BEARER_URL },
    }), true);
    assertTerminalDispatchRedacted(await readStoredJob(tx, current.id));

    const skipped = await seedPendingJob(tx, {
        id: "job-terminal-skipped-redaction",
        changeOrderId: "co-terminal-helper-redaction",
        eventRevision: 3,
        approvalMode: "MANUAL",
        kind: "APPROVAL_TEAM_EMAIL",
        payload: { dispatch: frozenPortalDispatch("ops@example.test") },
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: skipped.id,
        claimToken: "skipped-owner",
    });
    assert.equal(await jobsModule.markChangeOrderAutomationJobSkipped(tx, {
        jobId: skipped.id,
        claimToken: "skipped-owner",
    }), true);
    assertTerminalDispatchRedacted(await readStoredJob(tx, skipped.id));
    assert.equal(rows.size, 3);
});

test("retryable jobs retain exact dispatch bytes while NEEDS_ATTENTION distinguishes pre-provider from unresolved provider work", async () => {
    const { tx } = memoryJobStore();
    const retryDispatch = frozenPortalDispatch("retry@example.test");
    const retryable = await seedPendingJob(tx, {
        id: "job-retry-retains-bearer",
        changeOrderId: "co-retry-retains-bearer",
        eventRevision: 1,
        approvalMode: "CLIENT",
        kind: "REVIEW_EMAIL",
        payload: { dispatch: retryDispatch },
        maxAttempts: 2,
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: retryable.id,
        claimToken: "retryable-owner",
    });
    assert.equal(await jobsModule.rescheduleChangeOrderAutomationJob(tx, {
        jobId: retryable.id,
        claimToken: "retryable-owner",
        error: "temporary provider failure",
        nextAttemptAt: new Date("2026-08-17T12:01:00.000Z"),
    }), "PENDING");
    assert.deepEqual(
        (await readStoredJob(tx, retryable.id)).payload.dispatch,
        retryDispatch,
    );

    const preProvider = await seedPendingJob(tx, {
        id: "job-pre-provider-attention-redacts",
        changeOrderId: "co-pre-provider-attention-redacts",
        eventRevision: 1,
        approvalMode: "CLIENT",
        kind: "REVIEW_EMAIL",
        payload: { dispatch: frozenPortalDispatch("pre-provider@example.test") },
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: preProvider.id,
        claimToken: "pre-provider-owner",
    });
    assert.equal(await jobsModule.markChangeOrderAutomationJobNeedsAttention(tx, {
        jobId: preProvider.id,
        claimToken: "pre-provider-owner",
        error: "invalid frozen metadata before provider checkpoint",
    }), true);
    assertTerminalDispatchRedacted(await readStoredJob(tx, preProvider.id));

    const ambiguousDispatch = frozenPortalDispatch("ambiguous@example.test");
    const ambiguous = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-provider-attention-retains",
        eventRevision: 1,
        generationKey: "ambiguous-provider-attempt",
        dispatch: ambiguousDispatch,
        maxAttempts: 1,
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: ambiguous.id,
        claimToken: "ambiguous-provider-owner",
    });
    await jobsModule.checkpointChangeOrderAutomationProviderDispatch(tx, {
        jobId: ambiguous.id,
        claimToken: "ambiguous-provider-owner",
        dispatch: ambiguousDispatch,
    });
    assert.equal(await jobsModule.markChangeOrderAutomationJobNeedsAttention(tx, {
        jobId: ambiguous.id,
        claimToken: "ambiguous-provider-owner",
        error: "provider outcome is ambiguous and requires reconciliation",
        result: { portalUrl: PORTAL_BEARER_URL, reconciliationRequired: true },
        retainFrozenPayloadForReconciliation: true,
    }), true);
    const ambiguousStored = await readStoredJob(tx, ambiguous.id);
    assert.deepEqual(ambiguousStored.payload.dispatch, ambiguousDispatch);
    assert.match(JSON.stringify(ambiguousStored.payload), /secret-signature/);
    assert.match(ambiguousStored.result.portalUrl, /^\[redacted-url sha256=[a-f0-9]{64}\]$/);
    assert.equal(ambiguousStored.result.reconciliationRequired, true);
});

test("attempt exhaustion redacts pre-provider and rejected payloads but retains ambiguous provider bytes", async () => {
    const { tx, rows } = memoryJobStore();
    const exhausted = await seedPendingJob(tx, {
        id: "job-claim-exhausted-redacts",
        changeOrderId: "co-claim-exhausted-redacts",
        eventRevision: 1,
        approvalMode: "CLIENT",
        kind: "REVIEW_EMAIL",
        payload: { dispatch: frozenPortalDispatch("exhausted@example.test") },
        maxAttempts: 1,
    });
    const exhaustedStored = [...rows.values()].find(row => row.id === exhausted.id)!;
    exhaustedStored.attempts = 1;
    assert.equal(await jobsModule.claimChangeOrderAutomationJob(tx, { jobId: exhausted.id }), null);
    assertTerminalDispatchRedacted(await readStoredJob(tx, exhausted.id));

    const preProviderReschedule = await seedPendingJob(tx, {
        id: "job-reschedule-exhausted-redacts",
        changeOrderId: "co-reschedule-exhausted-redacts",
        eventRevision: 1,
        approvalMode: "CLIENT",
        kind: "REVIEW_EMAIL",
        payload: { dispatch: frozenPortalDispatch("reschedule-exhausted@example.test") },
        maxAttempts: 1,
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: preProviderReschedule.id,
        claimToken: "reschedule-exhausted-owner",
    });
    assert.equal(await jobsModule.rescheduleChangeOrderAutomationJob(tx, {
        jobId: preProviderReschedule.id,
        claimToken: "reschedule-exhausted-owner",
        error: "definite pre-provider failure",
        nextAttemptAt: new Date("2026-08-17T12:01:00.000Z"),
    }), "NEEDS_ATTENTION");
    assertTerminalDispatchRedacted(await readStoredJob(tx, preProviderReschedule.id));

    const definitelyRejectedDispatch = frozenPortalDispatch("provider-rejected@example.test");
    const definitelyRejected = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-provider-rejected-redacts",
        eventRevision: 1,
        generationKey: "provider-rejected",
        dispatch: definitelyRejectedDispatch,
        maxAttempts: 1,
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: definitelyRejected.id,
        claimToken: "provider-rejected-owner",
    });
    await jobsModule.checkpointChangeOrderAutomationProviderDispatch(tx, {
        jobId: definitelyRejected.id,
        claimToken: "provider-rejected-owner",
        dispatch: definitelyRejectedDispatch,
    });
    assert.equal(await jobsModule.rescheduleChangeOrderAutomationJob(tx, {
        jobId: definitelyRejected.id,
        claimToken: "provider-rejected-owner",
        error: "provider definitively rejected the request",
        nextAttemptAt: new Date("2026-08-17T12:01:00.000Z"),
        retainFrozenPayloadForReconciliation: false,
    }), "NEEDS_ATTENTION");
    assertTerminalDispatchRedacted(await readStoredJob(tx, definitelyRejected.id));

    const providerDispatch = frozenPortalDispatch("provider-exhausted@example.test");
    const providerStarted = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-provider-exhausted-retains",
        eventRevision: 1,
        generationKey: "provider-exhausted",
        dispatch: providerDispatch,
        maxAttempts: 1,
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: providerStarted.id,
        claimToken: "provider-exhausted-owner",
    });
    await jobsModule.checkpointChangeOrderAutomationProviderDispatch(tx, {
        jobId: providerStarted.id,
        claimToken: "provider-exhausted-owner",
        dispatch: providerDispatch,
    });
    assert.equal(await jobsModule.rescheduleChangeOrderAutomationJob(tx, {
        jobId: providerStarted.id,
        claimToken: "provider-exhausted-owner",
        error: "provider outcome ambiguous",
        nextAttemptAt: new Date("2026-08-17T12:01:00.000Z"),
        retainFrozenPayloadForReconciliation: true,
    }), "NEEDS_ATTENTION");
    assert.deepEqual(
        (await readStoredJob(tx, providerStarted.id)).payload.dispatch,
        providerDispatch,
    );
});

test("failed attempts wait until due and become NEEDS_ATTENTION at the retry cap", async () => {
    assert.equal(typeof jobsModule.rescheduleChangeOrderAutomationJob, "function", "retry helper must exist");

    const { tx, rows } = memoryJobStore();
    const job = await seedPendingJob(tx, {
        id: "job-retry",
        changeOrderId: "co-retry",
        eventRevision: 3,
        approvalMode: "MANUAL",
        kind: "APPROVAL_BILL",
        payload: { totalCents: 50_00 },
        maxAttempts: 2,
    });
    const firstAttemptAt = new Date("2026-08-16T13:00:00.000Z");
    const retryAt = new Date("2026-08-16T13:01:00.000Z");

    assert.ok(
        await jobsModule.claimChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: "attempt-1",
            now: firstAttemptAt,
        }),
    );
    assert.equal(
        await jobsModule.rescheduleChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: "attempt-1",
            error: "provider unavailable",
            nextAttemptAt: retryAt,
            now: firstAttemptAt,
        }),
        "PENDING",
    );
    assert.equal(
        await jobsModule.claimChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: "too-early",
            now: new Date("2026-08-16T13:00:59.999Z"),
        }),
        null,
    );

    assert.ok(
        await jobsModule.claimChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: "attempt-2",
            now: retryAt,
        }),
    );
    assert.equal(
        await jobsModule.rescheduleChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: "attempt-2",
            error: "permanent failure",
            nextAttemptAt: new Date("2026-08-16T13:02:00.000Z"),
            now: retryAt,
        }),
        "NEEDS_ATTENTION",
    );

    const stored = [...rows.values()][0];
    assert.equal(stored.attempts, 2);
    assert.equal(stored.status, "NEEDS_ATTENTION");
    assert.equal(stored.nextAttemptAt, null);
    assert.equal(stored.lastError, "permanent failure");
    assert.deepEqual(stored.completedAt, retryAt);
});

test("provider checkpoint requires a frozen dispatch, renews its lease, and never mutates it", async () => {
    assert.equal(
        typeof jobsModule.checkpointChangeOrderAutomationProviderDispatch,
        "function",
        "provider-dispatch checkpoint helper must exist",
    );

    const { tx } = memoryJobStore();
    const originalDispatch = frozenDispatch("frozen@example.test", "Frozen review");
    const job = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-checkpoint",
        eventRevision: 9,
        generationKey: "preview-token-1",
        dispatch: originalDispatch,
        payload: { revision: 9 },
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: job.id,
        claimToken: "owner",
        now: new Date("2026-08-16T14:59:00.000Z"),
    });
    const first = new Date("2026-08-16T15:00:00.000Z");

    const checkpoint = await jobsModule.checkpointChangeOrderAutomationProviderDispatch(tx, {
        jobId: job.id,
        claimToken: "owner",
        dispatch: frozenDispatch("changed@example.test", "Changed"),
        payload: { lateMetadata: true },
        now: first,
    });
    assert.deepEqual(checkpoint.payload, {
        revision: 9,
        lateMetadata: true,
        dispatch: originalDispatch,
    });
    assert.deepEqual(checkpoint.firstProviderAttemptAt, first);
    assert.deepEqual(checkpoint.processingStartedAt, first, "checkpoint renews the lease before dispatch");

    const renewedAt = new Date("2026-08-16T15:05:00.000Z");
    const retry = await jobsModule.checkpointChangeOrderAutomationProviderDispatch(tx, {
        jobId: job.id,
        claimToken: "owner",
        dispatch: frozenDispatch("wrong@example.test", "Wrong retry"),
        payload: { anotherLateField: true },
        now: renewedAt,
    });
    assert.deepEqual(retry.payload, checkpoint.payload, "nothing can mutate frozen dispatch after provider starts");
    assert.deepEqual(retry.firstProviderAttemptAt, first);
    assert.deepEqual(retry.processingStartedAt, renewedAt);
    assert.equal(
        await jobsModule.renewChangeOrderAutomationJobLease(tx, {
            jobId: job.id,
            claimToken: "stale-owner",
            now: renewedAt,
        }),
        null,
    );

    const approvalEmail = await seedPendingJob(tx, {
        id: "approval-email-checkpoint",
        changeOrderId: "co-checkpoint",
        eventRevision: 10,
        kind: "APPROVAL_CLIENT_EMAIL",
        approvalMode: "CLIENT",
        payload: { billingJobId: "bill-1", recipientSource: "approved-client" },
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: approvalEmail.id,
        claimToken: "approval-email-owner",
        now: first,
    });
    const approvalCheckpoint = await jobsModule.checkpointChangeOrderAutomationProviderDispatch(tx, {
        jobId: approvalEmail.id,
        claimToken: "approval-email-owner",
        dispatch: frozenDispatch("approved-client@example.test", "Payment link ready"),
        now: first,
    });
    assert.deepEqual(approvalCheckpoint.payload, {
        billingJobId: "bill-1",
        recipientSource: "approved-client",
        dispatch: frozenDispatch("approved-client@example.test", "Payment link ready"),
    });
});

test("pending review cancellation and claimed terminal transitions obey their fences", async () => {
    assert.equal(typeof jobsModule.cancelPendingReviewJobs, "function", "pending review cancellation helper must exist");
    assert.equal(typeof jobsModule.markChangeOrderAutomationJobSkipped, "function", "SKIPPED helper must exist");
    assert.equal(typeof jobsModule.markChangeOrderAutomationJobCanceled, "function", "CANCELED helper must exist");
    assert.equal(
        typeof jobsModule.markChangeOrderAutomationJobNeedsAttention,
        "function",
        "NEEDS_ATTENTION helper must exist",
    );

    const { tx, rows } = memoryJobStore();
    const oldReview = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-terminal",
        eventRevision: 1,
        generationKey: "preview-old",
        dispatch: frozenDispatch("old@example.test"),
        payload: { revision: 1 },
    });
    const currentReview = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-terminal",
        eventRevision: 2,
        generationKey: "preview-current",
        dispatch: frozenDispatch("current@example.test"),
        payload: { revision: 2 },
    });
    assert.equal(await jobsModule.cancelPendingReviewJobs(tx, "co-terminal", currentReview.id), 1);
    const canceledReview = await tx.changeOrderAutomationJob.findUnique({ where: { id: oldReview.id } });
    const preservedReview = await tx.changeOrderAutomationJob.findUnique({ where: { id: currentReview.id } });
    assert.ok(canceledReview);
    assert.ok(preservedReview);
    assert.equal(canceledReview.status, "CANCELED");
    assert.equal(preservedReview.status, "PENDING");

    await jobsModule.claimChangeOrderAutomationJob(tx, { jobId: currentReview.id, claimToken: "review-owner" });
    assert.equal(
        await jobsModule.markChangeOrderAutomationJobCanceled(tx, {
            jobId: currentReview.id,
            claimToken: "stale-owner",
            result: { reason: "scope changed" },
        }),
        false,
    );
    assert.equal(
        await jobsModule.markChangeOrderAutomationJobCanceled(tx, {
            jobId: currentReview.id,
            claimToken: "review-owner",
            result: { reason: "scope changed" },
        }),
        true,
    );

    const ambiguousReview = await jobsModule.enqueueReviewEmailAutomationJob(tx, {
        changeOrderId: "co-terminal",
        eventRevision: 2,
        generationKey: "preview-provider-attempted",
        dispatch: frozenDispatch("ambiguous@example.test"),
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: ambiguousReview.id,
        claimToken: "ambiguous-owner",
        now: new Date("2026-08-16T15:30:00.000Z"),
    });
    await jobsModule.checkpointChangeOrderAutomationProviderDispatch(tx, {
        jobId: ambiguousReview.id,
        claimToken: "ambiguous-owner",
        dispatch: frozenDispatch("ambiguous@example.test"),
        now: new Date("2026-08-16T15:30:01.000Z"),
    });
    await jobsModule.releaseChangeOrderAutomationJob(tx, {
        jobId: ambiguousReview.id,
        claimToken: "ambiguous-owner",
        error: "provider result ambiguous",
        nextAttemptAt: new Date("2026-08-16T15:31:00.000Z"),
    });
    assert.equal(
        await jobsModule.cancelPendingReviewJobs(tx, "co-terminal"),
        0,
        "provider-attempted review rows require reconciliation and cannot be bulk-canceled",
    );
    const ambiguousStored = await tx.changeOrderAutomationJob.findUnique({ where: { id: ambiguousReview.id } });
    assert.ok(ambiguousStored);
    assert.equal(ambiguousStored.status, "PENDING");

    const schedule = await seedPendingJob(tx, {
        id: "job-schedule",
        changeOrderId: "co-terminal",
        eventRevision: 3,
        approvalMode: "MANUAL",
        kind: "APPROVAL_SCHEDULE",
    });
    const team = await seedPendingJob(tx, {
        id: "job-team",
        changeOrderId: "co-terminal",
        eventRevision: 3,
        approvalMode: "MANUAL",
        kind: "APPROVAL_TEAM_EMAIL",
        payload: { dispatch: frozenDispatch("ops@example.test") },
    });
    await jobsModule.claimChangeOrderAutomationJob(tx, { jobId: schedule.id, claimToken: "schedule-owner" });
    await jobsModule.claimChangeOrderAutomationJob(tx, { jobId: team.id, claimToken: "team-owner" });
    assert.equal(
        await jobsModule.markChangeOrderAutomationJobSkipped(tx, {
            jobId: schedule.id,
            claimToken: "schedule-owner",
            result: { reason: "no dated milestones" },
        }),
        true,
    );
    assert.equal(
        await jobsModule.markChangeOrderAutomationJobNeedsAttention(tx, {
            jobId: team.id,
            claimToken: "team-owner",
            error: "provider idempotency horizon expired",
        }),
        true,
    );

    const states = [...rows.values()].map((row) => row.status);
    assert.equal(states.filter((status) => status === "CANCELED").length, 2);
    assert.ok(states.includes("SKIPPED"));
    assert.ok(states.includes("NEEDS_ATTENTION"));
});

test("dedicated approval enqueue cannot omit or add jobs for manual/cost-plus modes", async () => {
    const { tx } = memoryJobStore();
    const manual = await jobsModule.enqueueApprovalAutomationJobs(tx, {
        changeOrderId: "co-manual",
        eventRevision: 1,
        approvalMode: "MANUAL",
        pricingType: "FIXED",
        payloads: {
            APPROVAL_BILL: { totalCents: 10_00 },
            APPROVAL_CLIENT_EMAIL: { recipientSource: "must-be-ignored-by-graph" },
            APPROVAL_SCHEDULE: { milestoneIds: [] },
            APPROVAL_TEAM_EMAIL: { recipientSource: "company-settings" },
        },
    });
    assert.deepEqual(
        manual.map((row: StoredJob) => row.kind),
        ["APPROVAL_BILL", "APPROVAL_SCHEDULE", "APPROVAL_TEAM_EMAIL"],
    );

    const costPlus = await jobsModule.enqueueApprovalAutomationJobs(tx, {
        changeOrderId: "co-cost-plus",
        eventRevision: 1,
        approvalMode: "CLIENT",
        pricingType: "COST_PLUS",
        payloads: {
            APPROVAL_SCHEDULE: { milestoneIds: [] },
            APPROVAL_TEAM_EMAIL: { recipientSource: "company-settings" },
        },
    });
    assert.deepEqual(
        costPlus.map((row: StoredJob) => row.kind),
        ["APPROVAL_SCHEDULE", "APPROVAL_TEAM_EMAIL"],
    );
});

test("legacy Approved recovery never auto-emails and parks ambiguous existing billing", async () => {
    assert.equal(typeof jobsModule.legacyApprovedRecoveryPlan, "function");
    assert.deepEqual(
        jobsModule.legacyApprovedRecoveryPlan({ pricingType: "FIXED", approvalMode: "CLIENT", hasExistingMilestones: false }),
        {
            APPROVAL_BILL: "PENDING",
            APPROVAL_CLIENT_EMAIL: "SKIPPED",
            APPROVAL_SCHEDULE: "PENDING",
            APPROVAL_TEAM_EMAIL: "SKIPPED",
        },
    );
    assert.deepEqual(
        jobsModule.legacyApprovedRecoveryPlan({ pricingType: "FIXED", approvalMode: "CLIENT", hasExistingMilestones: true }),
        {
            APPROVAL_BILL: "NEEDS_ATTENTION",
            APPROVAL_CLIENT_EMAIL: "SKIPPED",
            APPROVAL_SCHEDULE: "PENDING",
            APPROVAL_TEAM_EMAIL: "SKIPPED",
        },
    );
    assert.deepEqual(
        jobsModule.legacyApprovedRecoveryPlan({ pricingType: "COST_PLUS", approvalMode: "MANUAL", hasExistingMilestones: false }),
        {
            APPROVAL_SCHEDULE: "PENDING",
            APPROVAL_TEAM_EMAIL: "SKIPPED",
        },
    );
});

test("legacy Approved recovery includes imported Approved rows without approvedAt", () => {
    assert.equal(typeof jobsModule.isLegacyApprovedRecoveryCandidate, "function");
    const cutover = new Date("2026-08-16T00:00:00.000Z");
    assert.equal(jobsModule.isLegacyApprovedRecoveryCandidate(null, cutover), true);
    assert.equal(
        jobsModule.isLegacyApprovedRecoveryCandidate(new Date("2026-08-16T00:00:00.000Z"), cutover),
        true,
    );
    assert.equal(
        jobsModule.isLegacyApprovedRecoveryCandidate(new Date("2026-08-15T23:59:59.999Z"), cutover),
        false,
    );
});

test("a stale processing lease is recoverable and its former owner stays fenced", async () => {
    const { tx, rows } = memoryJobStore();
    const job = await seedPendingJob(tx, {
        id: "job-stale",
        changeOrderId: "co-stale",
        eventRevision: 5,
        approvalMode: "MANUAL",
        kind: "APPROVAL_SCHEDULE",
    });
    const firstAt = new Date("2026-08-16T16:00:00.000Z");
    await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: job.id,
        claimToken: "dead-worker",
        now: firstAt,
    });

    assert.equal(
        await jobsModule.claimChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: "early-worker",
            now: new Date("2026-08-16T16:05:00.000Z"),
        }),
        null,
        "the lease remains exclusive through its full configured lifetime",
    );
    const recovered = await jobsModule.claimChangeOrderAutomationJob(tx, {
        jobId: job.id,
        claimToken: "recovery-worker",
        now: new Date("2026-08-16T16:05:00.001Z"),
    });
    assert.equal(recovered.claimToken, "recovery-worker");
    assert.equal(recovered.attempts, 2);
    assert.equal(
        await jobsModule.completeChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: "dead-worker",
        }),
        false,
    );
    assert.equal(
        await jobsModule.completeChangeOrderAutomationJob(tx, {
            jobId: job.id,
            claimToken: "recovery-worker",
        }),
        true,
    );
    assert.equal([...rows.values()][0].status, "SUCCEEDED");
});
