/**
 * deleteEstimate must make its destructive decision from the Estimate row it locks in the
 * deletion transaction. The root-client reads in these fixtures deliberately return a stale
 * Draft/no-evidence snapshot while the transaction sees the concurrent committed state.
 */

import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import Module from "node:module";

type EstimateSnapshot = {
    id: string;
    projectId: string | null;
    leadId: string | null;
    status: string;
    sentAt?: Date | null;
    viewedAt?: Date | null;
    qbSyncedAt?: Date | null;
    contractId?: string | null;
};

const state: {
    outside: EstimateSnapshot;
    locked: EstimateSnapshot | null;
    expenseCountInTransaction: number;
    timeEntryCountInTransaction: number;
    estimateFileCountInTransaction: number;
    providerScheduleCountInTransaction: number;
    invoiceCountInTransaction: number;
    budgetCountInTransaction: number;
    generatedScheduleTaskCountInTransaction: number;
    manuallyLinkedScheduleTaskCountInTransaction: number;
    takeoffCountInTransaction: number;
    legacyPurchaseOrderLinkCountInTransaction: number;
    purchaseOrderJoinCountInTransaction: number;
    preparedChangeOrderCount: number;
    discoveredChangeOrderIds: string[];
    changeOrderIdsAfterParentLock: string[];
    currentStaff: { id: string; role: string } | null;
} = {
    outside: {
        id: "estimate-race",
        projectId: "project-1",
        leadId: null,
        status: "Draft",
    },
    locked: null,
    expenseCountInTransaction: 0,
    timeEntryCountInTransaction: 0,
    estimateFileCountInTransaction: 0,
    providerScheduleCountInTransaction: 0,
    invoiceCountInTransaction: 0,
    budgetCountInTransaction: 0,
    generatedScheduleTaskCountInTransaction: 0,
    manuallyLinkedScheduleTaskCountInTransaction: 0,
    takeoffCountInTransaction: 0,
    legacyPurchaseOrderLinkCountInTransaction: 0,
    purchaseOrderJoinCountInTransaction: 0,
    preparedChangeOrderCount: 0,
    discoveredChangeOrderIds: [],
    changeOrderIdsAfterParentLock: [],
    currentStaff: { id: "staff-1", role: "ADMIN" },
};

const transactionOps: string[] = [];
let directUserReads = 0;
let changeOrderReads = 0;

function resetFixture() {
    state.outside = {
        id: "estimate-race",
        projectId: "project-1",
        leadId: null,
        status: "Draft",
    };
    state.locked = { ...state.outside };
    state.expenseCountInTransaction = 0;
    state.timeEntryCountInTransaction = 0;
    state.estimateFileCountInTransaction = 0;
    state.providerScheduleCountInTransaction = 0;
    state.invoiceCountInTransaction = 0;
    state.budgetCountInTransaction = 0;
    state.generatedScheduleTaskCountInTransaction = 0;
    state.manuallyLinkedScheduleTaskCountInTransaction = 0;
    state.takeoffCountInTransaction = 0;
    state.legacyPurchaseOrderLinkCountInTransaction = 0;
    state.purchaseOrderJoinCountInTransaction = 0;
    state.preparedChangeOrderCount = 0;
    state.discoveredChangeOrderIds = [];
    state.changeOrderIdsAfterParentLock = [];
    state.currentStaff = { id: "staff-1", role: "ADMIN" };
    transactionOps.length = 0;
    directUserReads = 0;
    changeOrderReads = 0;
}

function destructiveTransactionOps() {
    return transactionOps.filter((operation) => operation.includes("delete"));
}

const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (/FROM "EstimateItem"/i.test(sql)) {
            assert.match(sql, /ORDER BY "id"[\s\S]*FOR UPDATE/i);
            assert.equal(values[0], state.outside.id);
            transactionOps.push("estimate-items.lock-stable");
            return [{ id: "item-1" }];
        }
        if (/FROM "EstimatePaymentSchedule"/i.test(sql)) {
            assert.match(sql, /ORDER BY "id"[\s\S]*FOR UPDATE/i);
            transactionOps.push("estimate-payment-schedules.lock-stable");
            return [];
        }
        assert.match(sql, /FROM "Estimate"[\s\S]*FOR UPDATE/i);
        assert.equal(values[0], state.outside.id);
        transactionOps.push("estimate.lock-and-read");
        return state.locked ? [{ ...state.locked }] : [];
    },
    estimate: {
        findUnique: async () => {
            transactionOps.push("estimate.re-read");
            return state.locked ? { ...state.locked } : null;
        },
        delete: async () => {
            transactionOps.push("estimate.delete");
            return state.locked;
        },
    },
    expense: {
        count: async () => {
            transactionOps.push("expense.count");
            return state.expenseCountInTransaction;
        },
        deleteMany: async () => {
            transactionOps.push("expense.deleteMany");
            return { count: 0 };
        },
    },
    timeEntry: {
        count: async () => {
            transactionOps.push("timeEntry.count");
            return state.timeEntryCountInTransaction;
        },
    },
    budget: {
        count: async () => {
            transactionOps.push("budget.count");
            return state.budgetCountInTransaction;
        },
        deleteMany: async () => {
            transactionOps.push("budget.deleteMany");
            return { count: 0 };
        },
    },
    estimateItem: {
        count: async () => {
            transactionOps.push("estimateItem.purchaseOrderLink-count");
            return state.legacyPurchaseOrderLinkCountInTransaction;
        },
        deleteMany: async () => {
            transactionOps.push("estimateItem.deleteMany");
            return { count: 0 };
        },
    },
    estimatePaymentSchedule: {
        count: async () => {
            transactionOps.push("estimatePaymentSchedule.evidence-count");
            return state.providerScheduleCountInTransaction;
        },
        deleteMany: async () => {
            transactionOps.push("estimatePaymentSchedule.deleteMany");
            return { count: 0 };
        },
    },
    estimateFile: {
        count: async () => {
            transactionOps.push("estimateFile.count");
            return state.estimateFileCountInTransaction;
        },
    },
    invoice: {
        count: async () => {
            transactionOps.push("invoice.count");
            return state.invoiceCountInTransaction;
        },
    },
    scheduleTask: {
        count: async (input: { where?: { generatedFromEstimateId?: string; estimateItem?: unknown } }) => {
            if (input.where?.generatedFromEstimateId) {
                transactionOps.push("generatedScheduleTask.count");
                return state.generatedScheduleTaskCountInTransaction;
            }
            transactionOps.push("manuallyLinkedScheduleTask.count");
            return state.manuallyLinkedScheduleTaskCountInTransaction;
        },
    },
    estimateItemPurchaseOrder: {
        count: async () => {
            transactionOps.push("estimateItemPurchaseOrder.count");
            return state.purchaseOrderJoinCountInTransaction;
        },
    },
    takeoff: {
        count: async () => {
            transactionOps.push("takeoff.count");
            return state.takeoffCountInTransaction;
        },
    },
    changeOrder: {
        findMany: async () => {
            const afterParentLock = transactionOps.includes("estimate.lock-and-read");
            transactionOps.push(afterParentLock
                ? "change-orders.verify-after-parent-lock"
                : "change-orders.discover-before-prepare");
            const ids = afterParentLock
                ? state.changeOrderIdsAfterParentLock
                : state.discoveredChangeOrderIds;
            return ids.map(id => ({ id }));
        },
    },
};

const fakePrisma = {
    estimate: {
        // assertEstimateAccess plus the old preflight both see the stale snapshot.
        findUnique: async () => ({ ...state.outside }),
    },
    expense: {
        count: async () => 0,
    },
    timeEntry: {
        count: async () => 0,
    },
    changeOrderAutomationJob: {
        count: async () => 0,
    },
    user: {
        // The legacy countersign gate reads role directly and therefore accepts this
        // otherwise-disabled fixture instead of honoring currentStaffUserOrNull.
        findUnique: async () => {
            directUserReads += 1;
            return { role: "ADMIN", status: "DISABLED" };
        },
    },
    changeOrder: {
        findUnique: async () => {
            changeOrderReads += 1;
            return null;
        },
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
};

class FakeParentDeleteBlockedError extends Error {}

let deleteEstimate: (estimateId: string) => Promise<{ success: boolean; error?: string }>;
let countersignChangeOrderAsCompany: (
    id: string,
    signerName: string,
    signatureDataUrl?: string,
) => Promise<{ success: boolean; revision: number }>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "./prisma") return { prisma: fakePrisma };
        if (id === "next-auth") {
            // eslint-disable-next-line prefer-rest-params
            const actual = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return {
                ...actual,
                getServerSession: async () => ({ user: { email: "disabled@example.test" } }),
            };
        }
        if (id === "next/cache") {
            // eslint-disable-next-line prefer-rest-params
            const actual = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return {
                ...actual,
                revalidatePath: () => undefined,
                revalidateTag: () => undefined,
            };
        }
        if (id === "./permissions") {
            // Preserve the full module surface needed while actions.ts loads, overriding only the
            // three decisions exercised by this action.
            // eslint-disable-next-line prefer-rest-params
            const actual = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return {
                ...actual,
                currentStaffUserOrNull: async () => state.currentStaff,
                hasPermission: () => true,
                canAccessEstimate: () => true,
            };
        }
        if (id === "./change-order-automation-jobs") {
            return {
                ChangeOrderParentDeleteBlockedError: FakeParentDeleteBlockedError,
                prepareChangeOrderReviewJobsForMutation: async () => 0,
                prepareChangeOrdersForParentDelete: async () => {
                    transactionOps.push("change-orders.prepare");
                    return { changeOrders: state.preparedChangeOrderCount, removedJobs: 0 };
                },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    try {
        const loaded = await import("../src/lib/actions");
        const exports = (loaded as any).deleteEstimate ? loaded : (loaded as any).default;
        deleteEstimate = exports.deleteEstimate;
        countersignChangeOrderAsCompany = exports.countersignChangeOrderAsCompany;
    } finally {
        Module.prototype.require = originalRequire;
    }

    assert.equal(typeof deleteEstimate, "function");
    assert.equal(typeof countersignChangeOrderAsCompany, "function");
});

beforeEach(resetFixture);

test("deleteEstimate refuses a status that became protected before its transaction lock", async () => {
    state.locked = { ...state.outside, status: "Approved" };

    const result = await deleteEstimate(state.outside.id);

    assert.deepEqual(result, {
        success: false,
        error: "Approved estimates cannot be deleted",
    });
    assert.deepEqual(transactionOps.slice(0, 3), [
        "change-orders.discover-before-prepare",
        "change-orders.prepare",
        "estimate.lock-and-read",
    ]);
    assert.deepEqual(destructiveTransactionOps(), []);
});

test("deleteEstimate preserves a sent proposal even when its legacy status still looks deletable", async () => {
    state.locked = {
        ...state.outside,
        status: "Sent",
        sentAt: new Date("2026-08-17T12:00:00.000Z"),
    };

    const result = await deleteEstimate(state.outside.id);

    assert.deepEqual(result, {
        success: false,
        error: "Sent or externally processed estimates must be archived, not deleted",
    });
    assert.deepEqual(destructiveTransactionOps(), []);
});

test("deleteEstimate preserves a QBO-synced proposal even when its legacy status looks Draft", async () => {
    state.locked = {
        ...state.outside,
        qbSyncedAt: new Date("2026-08-17T12:00:00.000Z"),
    };

    const result = await deleteEstimate(state.outside.id);

    assert.deepEqual(result, {
        success: false,
        error: "Sent or externally processed estimates must be archived, not deleted",
    });
    assert.deepEqual(destructiveTransactionOps(), []);
});

test("deleteEstimate preserves an Estimate-to-Contract legal provenance link", async () => {
    state.locked = { ...state.outside, contractId: "contract-1" };

    const result = await deleteEstimate(state.outside.id);

    assert.deepEqual(result, {
        success: false,
        error: "Sent or externally processed estimates must be archived, not deleted",
    });
    assert.deepEqual(destructiveTransactionOps(), []);
});

test("deleteEstimate refuses financial evidence that appeared before its transaction lock", async () => {
    state.expenseCountInTransaction = 1;
    state.timeEntryCountInTransaction = 2;

    const result = await deleteEstimate(state.outside.id);

    assert.deepEqual(result, {
        success: false,
        error: "Cannot delete estimate because it has linked 1 expense(s) and 2 time entry/entries. Please delete these entries first.",
    });
    assert.deepEqual(transactionOps.slice(0, 7), [
        "change-orders.discover-before-prepare",
        "change-orders.prepare",
        "estimate.lock-and-read",
        "change-orders.verify-after-parent-lock",
        "estimate-items.lock-stable",
        "estimate-payment-schedules.lock-stable",
        "expense.count",
    ]);
    assert.ok(
        transactionOps.indexOf("estimate-items.lock-stable") < transactionOps.indexOf("timeEntry.count"),
        "EstimateItem rows must be locked in stable order before TimeEntry evidence is counted",
    );
    assert.deepEqual(destructiveTransactionOps(), []);
});

test("deleteEstimate refuses a change order that appeared before the parent lock", async () => {
    state.preparedChangeOrderCount = 0;
    state.changeOrderIdsAfterParentLock = ["co-new"];

    const result = await deleteEstimate(state.outside.id);

    assert.deepEqual(result, {
        success: false,
        error: "Estimate change orders changed during deletion. Please try again.",
    });
    assert.deepEqual(transactionOps.slice(0, 4), [
        "change-orders.discover-before-prepare",
        "change-orders.prepare",
        "estimate.lock-and-read",
        "change-orders.verify-after-parent-lock",
    ]);
    assert.deepEqual(destructiveTransactionOps(), []);
});

test("deleteEstimate refuses an equal-count replacement in the prepared change-order set", async () => {
    state.discoveredChangeOrderIds = ["co-old"];
    state.preparedChangeOrderCount = 1;
    state.changeOrderIdsAfterParentLock = ["co-new"];

    const result = await deleteEstimate(state.outside.id);

    assert.deepEqual(result, {
        success: false,
        error: "Estimate change orders changed during deletion. Please try again.",
    });
    assert.deepEqual(destructiveTransactionOps(), []);
});

for (const [label, setEvidence] of [
    ["invoice", () => { state.invoiceCountInTransaction = 1; }],
    ["budget", () => { state.budgetCountInTransaction = 1; }],
    ["generated schedule", () => { state.generatedScheduleTaskCountInTransaction = 1; }],
    ["takeoff", () => { state.takeoffCountInTransaction = 1; }],
    ["manually linked schedule task", () => { state.manuallyLinkedScheduleTaskCountInTransaction = 1; }],
    ["legacy purchase-order link", () => { state.legacyPurchaseOrderLinkCountInTransaction = 1; }],
    ["purchase-order join", () => { state.purchaseOrderJoinCountInTransaction = 1; }],
] as const) {
    test(`deleteEstimate preserves ${label} provenance linked to an otherwise Draft estimate`, async () => {
        setEvidence();

        const result = await deleteEstimate(state.outside.id);

        assert.deepEqual(result, {
            success: false,
            error: "Estimate billing, budget, schedule, takeoff, or procurement history must be archived, not deleted",
        });
        assert.deepEqual(destructiveTransactionOps(), []);
    });
}

test("countersignChangeOrderAsCompany rejects a disabled ADMIN through the active-staff gate", async () => {
    // getCurrentUserWithPermissions/currentStaffUserOrNull represents a DISABLED database user as
    // null. The action must use that canonical loader rather than trusting session + role alone.
    state.currentStaff = null;

    await assert.rejects(
        countersignChangeOrderAsCompany("co-disabled", "Company Signer"),
        /Unauthorized/,
    );
    assert.equal(directUserReads, 0);
    assert.equal(changeOrderReads, 0);
});
