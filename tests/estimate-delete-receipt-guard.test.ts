/**
 * `deleteEstimate` — the receipt-booked-expense guard (2026-09-23 follow-up
 * to PR #534 / the native receipt-booking cutover).
 *
 * Since 2026-09-21 ProBuild books receipts natively onto the job's newest
 * non-archived estimate, drafts included (receipt-intake/book.ts). The count
 * check at the top of deleteEstimate runs BEFORE any of the function's own
 * deletes and OUTSIDE the evidence-locked transaction, so a receipt can land
 * on this estimate in the gap between that count and the transaction that
 * hard-deletes its Expenses. Unguarded, that Expense is destroyed with it —
 * stranding its ReceiptIntake at BOOKED with expenseId null: on no job,
 * unre-sendable, and its bank charge still looks covered.
 *
 * Prisma, next-auth and the permission reader are patched at require() time —
 * same shape as tests/expense-delete-scope.test.ts and
 * tests/job-variance-db.test.ts. No mock.module: CI is Node 20.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

/** The order of every statement the guarded transaction issues. */
let opLog: string[] = [];

let estimateRow: Record<string, unknown> | null;
let earlyExpenseCount: number;
let earlyTimeEntryCount: number;
let budgetRow: Record<string, unknown> | null;
/** What the NEW guard's `tx.expense.count(...)` (inside the lock) returns. */
let txReceiptBookedCount: number;
let txCountArgs: unknown;
let estimateDeleteArgs: unknown;

const fakeTx: any = {
    // The receipt-evidence lock and its epoch bump (PR #443 gate rounds
    // 42/45): the real withReceiptEvidenceLock/lockReceiptEvidence/
    // bumpReceiptEvidenceEpoch run unmocked against this fake — nothing here
    // depends on their result, only that they are answerable and ordered.
    $executeRaw: async (..._args: unknown[]) => { opLog.push("lock"); return 1; },
    $queryRaw: async (..._args: unknown[]) => { opLog.push("epoch-bump"); return [{ value: "1" }]; },
    expense: {
        count: async (args: unknown) => {
            txCountArgs = args;
            opLog.push("tx.expense.count");
            return txReceiptBookedCount;
        },
        deleteMany: async (_args: unknown) => {
            opLog.push("tx.expense.deleteMany");
            return { count: 1 };
        },
    },
};

const fakePrisma: any = {
    estimate: {
        findUnique: async () => estimateRow,
        delete: async (args: unknown) => { estimateDeleteArgs = args; opLog.push("estimate.delete"); return estimateRow; },
    },
    expense: {
        // The EARLY, unlocked count at the top of deleteEstimate — unrelated
        // to the tx-scoped guard this suite is about.
        count: async () => earlyExpenseCount,
    },
    timeEntry: {
        count: async () => earlyTimeEntryCount,
    },
    budget: {
        findUnique: async () => budgetRow,
        delete: async () => ({}),
    },
    estimateItem: {
        deleteMany: async () => ({ count: 0 }),
    },
    estimatePaymentSchedule: {
        deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (fn: any) => fn(fakeTx),
};

let deleteEstimate: (id: string) => Promise<{ success: boolean; error?: string }>;

before(async () => {
    const originalRequire = Module.prototype.require;
    let hit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma" || id === "./prisma") { hit = true; return { prisma: fakePrisma }; }
        if (id === "@/lib/permissions" || id === "./permissions") {
            return {
                getCurrentUserWithPermissions: async () => ({ id: "staff-1", role: "ADMIN" }),
                hasPermission: () => true,
                canAccessProject: () => true,
                canAccessEstimate: () => true,
                canCreateContractFor: () => true,
                canAccessContract: () => true,
                contractScopeWhere: () => ({}),
                estimateScopeWhere: () => ({}),
                estimateTotalsAreComplete: () => true,
                canWriteDocumentTemplateType: () => true,
                canUseDevAuthFallback: () => false,
                currentStaffUserOrNull: async () => ({ id: "staff-1", role: "ADMIN" }),
                getUserWithPermissionsByEmail: async () => null,
                isAdminOrManager: () => true,
                PortalAuthError: class extends Error {},
            };
        }
        if (id === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: any) => fn };
        if (id === "next/server") return { after: (fn: any) => fn() };
        if (id === "next-auth") return { getServerSession: async () => null };
        if (id === "next-auth/next") return { getServerSession: async () => null };
        if (id === "next/headers") return { headers: () => new Map() };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/lib/actions");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.deleteEstimate !== "function") {
        throw new Error(`estimate-delete-receipt-guard: mocks did not apply (require patch ${hit ? "WAS" : "was NOT"} hit)`);
    }
    deleteEstimate = mod.deleteEstimate;
});

beforeEach(() => {
    opLog = [];
    estimateRow = { projectId: "job-1", leadId: null, status: "Draft" };
    earlyExpenseCount = 0;
    earlyTimeEntryCount = 0;
    budgetRow = null;
    txReceiptBookedCount = 0;
    txCountArgs = null;
    estimateDeleteArgs = null;
});

test("refuses the whole delete when a receipt-booked Expense is linked", async () => {
    // The race: nothing showed up in the early, unlocked count, but a receipt
    // landed on this estimate by the time the locked transaction runs.
    txReceiptBookedCount = 1;
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, {
        success: false,
        error: "This estimate has 1 expense(s) from receipts, so it can't be deleted. Archive it instead.",
    });
    assert.ok(!opLog.includes("tx.expense.deleteMany"), `no Expense delete ran: ${opLog.join(" ")}`);
    assert.equal(estimateDeleteArgs, null, "the Estimate row itself was not deleted either");
});

test("the guard's query asks for receipt-booked Expenses specifically", () => {
    // Not exercised by the assertion above directly (the fake ignores its
    // args), so pin the WHERE shape once, behaviorally, via a dedicated run.
    return deleteEstimate("est-1").then(() => {
        assert.deepEqual(txCountArgs, {
            where: { estimateId: "est-1", qbPurchaseId: null, receiptIntake: { isNot: null } },
        });
    });
});

test("unchanged behavior: proceeds normally when no receipt-booked expense is linked", async () => {
    txReceiptBookedCount = 0;
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, { success: true });
    assert.ok(opLog.includes("tx.expense.deleteMany"), `the ordinary Expense delete still ran: ${opLog.join(" ")}`);
    assert.deepEqual(estimateDeleteArgs, { where: { id: "est-1" } });
});

test("unchanged behavior: the pre-existing linked-expense count still refuses first, before any of this", async () => {
    // A NON-race case: the estimate visibly has expenses at the time of the
    // click. That is the existing count/confirmation gate above the new
    // guard, and it must still fire exactly as before — the new guard never
    // even runs the transaction.
    earlyExpenseCount = 2;
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, {
        success: false,
        error: "Cannot delete estimate because it has linked 2 expense(s). Please delete these entries first.",
    });
    assert.deepEqual(opLog, [], "the guarded transaction never ran at all");
});

test("the receipt check runs inside the lock, after it, and before the delete", async () => {
    txReceiptBookedCount = 0;
    await deleteEstimate("est-1");

    assert.deepEqual(
        opLog,
        ["lock", "tx.expense.count", "tx.expense.deleteMany", "epoch-bump", "estimate.delete"],
        "lock, then the guard's own check, then the Expense delete, then the epoch bump, then the Estimate row itself",
    );
});

test("when refused, the transaction still closes out the lock and epoch bump normally", async () => {
    // A refusal is not a thrown transaction failure — it is a plain early
    // return from inside the locked body, so the transaction commits.
    txReceiptBookedCount = 3;
    await deleteEstimate("est-1");

    assert.deepEqual(opLog, ["lock", "tx.expense.count", "epoch-bump"]);
});
