import assert from "node:assert/strict";
import test from "node:test";

import {
    approvalJobKinds,
    canRetryProviderAttempt,
    drainChangeOrderAutomationJobs,
    drainChangeOrderAutomationUntilIdle,
    providerIdempotencyKey,
} from "../src/lib/change-order-automation";

function memoryQueue(rows: Array<Record<string, any>>) {
    const equal = (left: unknown, right: unknown) => left instanceof Date && right instanceof Date
        ? left.getTime() === right.getTime()
        : left === right;
    const matches = (row: Record<string, any>, where: Record<string, any>): boolean =>
        Object.entries(where ?? {}).every(([key, expected]: [string, any]) => {
            if (key === "OR") return expected.some((part: Record<string, any>) => matches(row, part));
            if (key === "AND") return expected.every((part: Record<string, any>) => matches(row, part));
            if (expected && typeof expected === "object" && "in" in expected) return expected.in.includes(row[key]);
            if (expected && typeof expected === "object" && "lte" in expected) return row[key] !== null && row[key] <= expected.lte;
            if (expected && typeof expected === "object" && "lt" in expected) return row[key] !== null && row[key] < expected.lt;
            return equal(row[key], expected);
        });
    const apply = (row: Record<string, any>, data: Record<string, any>) => {
        for (const [key, value] of Object.entries(data)) {
            row[key] = value && typeof value === "object" && "increment" in value
                ? row[key] + value.increment
                : value;
        }
    };
    const model = {
        findMany: async ({ where, take, cursor, skip }: any) => {
            let start = 0;
            if (cursor?.id) {
                const cursorIndex = rows.findIndex(row => row.id === cursor.id);
                start = Math.max(0, cursorIndex + (skip ?? 0));
            }
            return rows.slice(start).filter(row => matches(row, where)).slice(0, take).map(row => ({ ...row }));
        },
        findUnique: async ({ where }: any) => {
            const row = rows.find(candidate => candidate.id === where.id);
            return row && matches(row, where) ? { ...row } : null;
        },
        updateMany: async ({ where, data }: any) => {
            const row = rows.find(candidate => candidate.id === where.id);
            if (!row || !matches(row, where)) return { count: 0 };
            apply(row, data);
            return { count: 1 };
        },
    };
    return { db: { changeOrderAutomationJob: model } as any, rows };
}

function pendingJob(
    id: string,
    kind = "APPROVAL_BILL",
    createdAt = new Date("2026-08-16T12:00:00.000Z"),
): Record<string, any> {
    return {
        id,
        changeOrderId: `co-${id}`,
        eventRevision: 4,
        kind,
        approvalMode: "CLIENT",
        status: "PENDING",
        payload: null,
        result: null,
        idempotencyKey: `co-job/${id}`,
        attempts: 0,
        maxAttempts: 8,
        nextAttemptAt: null,
        firstProviderAttemptAt: null,
        processingStartedAt: null,
        claimToken: null,
        providerMessageId: null,
        lastError: null,
        completedAt: null,
        createdAt,
        updatedAt: createdAt,
    };
}

test("approval automation structurally omits client email for manual and cost-plus approvals", () => {
    assert.deepEqual(approvalJobKinds("FIXED", "CLIENT"), [
        "APPROVAL_BILL",
        "APPROVAL_CLIENT_EMAIL",
        "APPROVAL_SCHEDULE",
        "APPROVAL_TEAM_EMAIL",
    ]);
    assert.deepEqual(approvalJobKinds("FIXED", "MANUAL"), [
        "APPROVAL_BILL",
        "APPROVAL_SCHEDULE",
        "APPROVAL_TEAM_EMAIL",
    ]);
    assert.deepEqual(approvalJobKinds("COST_PLUS", "CLIENT"), [
        "APPROVAL_SCHEDULE",
        "APPROVAL_TEAM_EMAIL",
    ]);
    assert.deepEqual(approvalJobKinds("COST_PLUS", "MANUAL"), [
        "APPROVAL_SCHEDULE",
        "APPROVAL_TEAM_EMAIL",
    ]);
});

test("provider retries reuse the job key only inside the safe idempotency horizon", () => {
    const firstAttempt = new Date("2026-08-16T10:00:00.000Z");
    assert.equal(providerIdempotencyKey("job-123"), "co-job/job-123");
    assert.equal(canRetryProviderAttempt(firstAttempt, new Date("2026-08-17T09:59:59.999Z")), true);
    assert.equal(canRetryProviderAttempt(firstAttempt, new Date("2026-08-17T10:00:00.000Z")), false);
    assert.equal(canRetryProviderAttempt(null, new Date("2026-08-30T00:00:00.000Z")), true);
});

test("concurrent inline and cron drains execute one claimed job once", async () => {
    const row = pendingJob("job-race");
    const { db } = memoryQueue([row]);
    let executions = 0;
    const executeJob = async () => {
        executions++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { kind: "success" as const, result: { billed: true } };
    };

    const [inline, cron] = await Promise.all([
        drainChangeOrderAutomationJobs({ jobId: row.id }, { db, executeJob }),
        drainChangeOrderAutomationJobs({ jobId: row.id }, { db, executeJob }),
    ]);

    assert.equal(executions, 1);
    assert.equal(row.status, "SUCCEEDED");
    assert.deepEqual(row.result, { billed: true });
    assert.equal(inline.processed + cron.processed, 1);
});

test("the drainer samples a fresh clock for claim and completion transitions", async () => {
    const row = pendingJob("job-clock");
    const { db } = memoryQueue([row]);
    let tick = Date.parse("2026-08-16T12:00:00.000Z");
    const result = await drainChangeOrderAutomationJobs(
        { jobId: row.id },
        {
            db,
            now: () => new Date(tick += 1_000),
            executeJob: async () => ({ kind: "success" }),
        },
    );

    assert.equal(result.processed, 1);
    assert.ok(row.completedAt instanceof Date);
    assert.equal(row.completedAt.toISOString(), "2026-08-16T12:00:03.000Z");
});

test("completed means the executor already durably finalized the fenced row", async () => {
    const row = pendingJob("job-unfinalized");
    const { db } = memoryQueue([row]);
    const result = await drainChangeOrderAutomationJobs(
        { jobId: row.id },
        { db, executeJob: async () => ({ kind: "completed" }) },
    );

    assert.equal(result.processed, 0);
    assert.equal(result.retried, 1);
    assert.equal(row.status, "PENDING");
    assert.match(String(row.lastError), /did not durably finalize/i);
});

test("ineligible oldest rows cannot starve later due work", async () => {
    const rows = [
        pendingJob("job-team-1", "APPROVAL_TEAM_EMAIL", new Date("2026-08-16T12:00:00.000Z")),
        pendingJob("job-team-2", "APPROVAL_TEAM_EMAIL", new Date("2026-08-16T12:00:01.000Z")),
        pendingJob("job-bill", "APPROVAL_BILL", new Date("2026-08-16T12:00:02.000Z")),
    ];
    const { db } = memoryQueue(rows);
    const executed: string[] = [];
    const result = await drainChangeOrderAutomationJobs(
        { limit: 1 },
        {
            db,
            isEligible: async job => job.kind !== "APPROVAL_TEAM_EMAIL",
            executeJob: async job => {
                executed.push(job.id);
                return { kind: "success" };
            },
        },
    );

    assert.deepEqual(executed, ["job-bill"]);
    assert.equal(result.processed, 1);
});

test("targeted drains rescan dependencies until the event graph is idle", async () => {
    const team = pendingJob("job-team", "APPROVAL_TEAM_EMAIL", new Date("2026-08-16T12:00:00.000Z"));
    const bill = pendingJob("job-bill", "APPROVAL_BILL", new Date("2026-08-16T12:00:01.000Z"));
    team.changeOrderId = bill.changeOrderId = "co-event";
    const { db } = memoryQueue([team, bill]);
    const executed: string[] = [];

    const result = await drainChangeOrderAutomationUntilIdle(
        { changeOrderId: "co-event", eventRevision: 4, limit: 10 },
        {
            db,
            isEligible: async job => job.kind !== "APPROVAL_TEAM_EMAIL" || bill.status === "SUCCEEDED",
            executeJob: async job => {
                executed.push(job.id);
                return { kind: "success" };
            },
        },
    );

    assert.deepEqual(executed, ["job-bill", "job-team"]);
    assert.equal(result.processed, 2);
    assert.equal(team.status, "SUCCEEDED");
    assert.equal(bill.status, "SUCCEEDED");
});
