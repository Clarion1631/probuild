import assert from "node:assert/strict";
import { before, test } from "node:test";

let jobsModule: Record<string, any> = {};
before(async () => {
    jobsModule = await import("../src/lib/change-order-automation-jobs");
});

function fakeTx(rows: Array<Record<string, any>>) {
    const same = (left: unknown, right: unknown): boolean => {
        if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
        if (right && typeof right === "object" && "not" in right) return !same(left, right.not);
        if (right && typeof right === "object" && "in" in right) {
            return Array.isArray(right.in) && right.in.some((candidate: unknown) => same(left, candidate));
        }
        return left === right;
    };
    const matches = (row: Record<string, any>, where: Record<string, any>) =>
        Object.entries(where).every(([field, expected]) => same(row[field], expected));

    return {
        $queryRaw: async () => rows.map(row => ({ ...row })),
        changeOrderAutomationJob: {
            findMany: async ({ where }: any) => rows
                .filter(row => matches(row, where ?? {}))
                .map(row => ({ ...row })),
            updateMany: async ({ where, data }: any) => {
                let count = 0;
                for (const row of rows) {
                    if (!matches(row, where)) continue;
                    Object.assign(row, data);
                    count++;
                }
                return { count };
            },
            deleteMany: async ({ where }: any) => {
                let count = 0;
                for (let index = rows.length - 1; index >= 0; index--) {
                    const row = rows[index];
                    if (row.changeOrderId !== where.changeOrderId || row.kind !== where.kind) continue;
                    if (!where.status.in.includes(row.status)) continue;
                    if (row.firstProviderAttemptAt !== null || row.providerMessageId !== null) continue;
                    rows.splice(index, 1);
                    count++;
                }
                return { count };
            },
        },
    };
}

function fakeParentDeleteTx(input: {
    changeOrders: Array<Record<string, any>>;
    jobs: Array<Record<string, any>>;
    lockOrder?: string[];
}) {
    const lockOrder = input.lockOrder ?? [];
    return {
        changeOrder: {
            findMany: async ({ where }: any) => input.changeOrders
                .filter((row) => {
                    if (where.projectId?.in) return where.projectId.in.includes(row.projectId);
                    if (where.estimateId?.in) return where.estimateId.in.includes(row.estimateId);
                    return false;
                })
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(({ id }) => ({ id })),
        },
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join("?");
            const changeOrderId = String(values[0]);
            if (sql.includes('FROM "ChangeOrderAutomationJob"')) {
                lockOrder.push(`jobs:${changeOrderId}`);
                return input.jobs
                    .filter(row => row.changeOrderId === changeOrderId)
                    .map(row => ({ ...row }));
            }
            lockOrder.push(`co:${changeOrderId}`);
            const row = input.changeOrders.find(candidate => candidate.id === changeOrderId);
            return row ? [{ ...row }] : [];
        },
        changeOrderAutomationJob: {
            updateMany: async () => ({ count: 0 }),
            deleteMany: async ({ where }: any) => {
                let count = 0;
                for (let index = input.jobs.length - 1; index >= 0; index--) {
                    const row = input.jobs[index];
                    if (row.changeOrderId !== where.changeOrderId || row.kind !== where.kind) continue;
                    if (!where.status.in.includes(row.status)) continue;
                    if (row.firstProviderAttemptAt !== null || row.providerMessageId !== null) continue;
                    input.jobs.splice(index, 1);
                    count++;
                }
                return { count };
            },
        },
    };
}

const review = (overrides: Record<string, any> = {}) => ({
    id: "review-1",
    changeOrderId: "co-1",
    eventRevision: 1,
    kind: "REVIEW_EMAIL",
    approvalMode: null,
    status: "PENDING",
    payload: null,
    result: null,
    attempts: 0,
    maxAttempts: 8,
    nextAttemptAt: null,
    firstProviderAttemptAt: null,
    processingStartedAt: null,
    claimToken: null,
    providerMessageId: null,
    ...overrides,
});

test("a scope mutation cancels only never-attempted pending review work", async () => {
    assert.equal(typeof jobsModule.prepareChangeOrderReviewJobsForMutation, "function");
    const rows = [review(), review({ id: "sent", status: "SUCCEEDED", providerMessageId: "provider-1" })];
    const canceled = await jobsModule.prepareChangeOrderReviewJobsForMutation(fakeTx(rows), "co-1");

    assert.equal(canceled, 1);
    assert.equal(rows.find(row => row.id === "review-1")?.status, "CANCELED");
    assert.equal(rows.find(row => row.id === "sent")?.status, "SUCCEEDED");
});

test("a scope mutation fails closed while review delivery is claimed, ambiguous, or needs attention", async () => {
    assert.equal(typeof jobsModule.ChangeOrderReviewDeliveryUnresolvedError, "function");
    for (const row of [
        review({ status: "PROCESSING", claimToken: "worker" }),
        review({ status: "PENDING", firstProviderAttemptAt: new Date("2026-08-16T12:00:00Z") }),
        review({ status: "NEEDS_ATTENTION" }),
    ]) {
        await assert.rejects(
            jobsModule.prepareChangeOrderReviewJobsForMutation(fakeTx([row]), "co-1"),
            (error: any) => error instanceof jobsModule.ChangeOrderReviewDeliveryUnresolvedError,
        );
        assert.notEqual(row.status, "CANCELED");
    }
});

test("Draft deletion removes only safe review rows and preserves every attempted or terminal audit row", async () => {
    assert.equal(typeof jobsModule.removeSafeReviewJobsForDraftDelete, "function");
    const safeRows = [review(), review({ id: "canceled", status: "CANCELED" })];
    assert.equal(await jobsModule.removeSafeReviewJobsForDraftDelete(fakeTx(safeRows), "co-1"), 2);
    assert.equal(safeRows.length, 0);

    for (const retained of [
        review({ status: "PROCESSING" }),
        review({ status: "PENDING", firstProviderAttemptAt: new Date("2026-08-16T12:00:00Z") }),
        review({ status: "SUCCEEDED", providerMessageId: "provider-1" }),
        review({ kind: "APPROVAL_BILL", status: "SUCCEEDED" }),
    ]) {
        await assert.rejects(
            jobsModule.removeSafeReviewJobsForDraftDelete(fakeTx([retained]), "co-1"),
            /automation audit history/i,
        );
    }
});

test("parent deletion locks change orders first, removes only safe Draft review rows, and refuses audit history", async () => {
    assert.equal(typeof jobsModule.prepareChangeOrdersForParentDelete, "function");
    assert.equal(typeof jobsModule.ChangeOrderParentDeleteBlockedError, "function");

    const safeJobs = [
        review({ id: "review-b", changeOrderId: "co-b" }),
        review({ id: "review-a", changeOrderId: "co-a", status: "CANCELED" }),
    ];
    const lockOrder: string[] = [];
    const safeTx = fakeParentDeleteTx({
        changeOrders: [
            { id: "co-b", projectId: "project-1", estimateId: "estimate-b", status: "Draft" },
            { id: "co-a", projectId: "project-1", estimateId: "estimate-a", status: "Draft" },
        ],
        jobs: safeJobs,
        lockOrder,
    });
    assert.deepEqual(
        await jobsModule.prepareChangeOrdersForParentDelete(safeTx, { projectIds: ["project-1"] }),
        { changeOrders: 2, removedJobs: 2 },
    );
    assert.deepEqual(lockOrder, ["co:co-a", "jobs:co-a", "co:co-b", "jobs:co-b"]);
    assert.equal(safeJobs.length, 0);

    for (const retained of [
        {
            changeOrder: { id: "co-sent", projectId: "project-2", estimateId: "estimate-2", status: "Sent" },
            jobs: [],
        },
        {
            changeOrder: {
                id: "co-signed",
                projectId: "project-2",
                estimateId: "estimate-2",
                status: "Draft",
                companySignedAt: new Date("2026-08-17T12:00:00Z"),
            },
            jobs: [],
        },
        {
            changeOrder: { id: "co-job", projectId: "project-2", estimateId: "estimate-2", status: "Draft" },
            jobs: [review({ changeOrderId: "co-job", status: "SUCCEEDED", providerMessageId: "provider-1" })],
        },
    ]) {
        await assert.rejects(
            jobsModule.prepareChangeOrdersForParentDelete(
                fakeParentDeleteTx({ changeOrders: [retained.changeOrder], jobs: retained.jobs }),
                { estimateIds: ["estimate-2"] },
            ),
            (error: any) => error instanceof jobsModule.ChangeOrderParentDeleteBlockedError,
        );
    }
});
