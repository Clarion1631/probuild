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
 * ROUND 2 (2026-09-23, independent-checker follow-up): Budget, EstimateItem
 * and EstimatePaymentSchedule were ALSO deleted as plain prisma.* calls ahead
 * of the lock, so a refusal below still left the estimate stripped of all
 * three even though the guard "worked". They now run only inside the same
 * guarded transaction, after the check — fakeTx carries all of them so every
 * delete (not just Expense) shows up in the op log, and the refusal tests
 * below prove none of them ran.
 *
 * ROUND 3 (2026-09-23, Codex round 1): the Estimate row itself was the last
 * holdout — a plain `prisma.estimate.delete()` ran AFTER this transaction
 * committed and released the lock, so a receipt could book onto the estimate
 * in that gap (book.ts re-validates against the still-live row and passes)
 * and the unguarded delete would still go through behind it. It is
 * `tx.estimate.delete` now, inside the same transaction as the other three —
 * fakePrisma.estimate no longer exposes `delete` at all, so a regression that
 * moves it back out fails loudly instead of silently passing.
 *
 * ROUND 4 (2026-09-23, Codex round 2 nits): two fixes, no behavior change to
 * the guard itself. (1) The refusal path used to bump the evidence epoch even
 * though nothing was deleted — it now bumps only inside the `receiptBookedCount
 * === 0` branch, alongside the deletes it actually describes. (2) The
 * pre-existing early gate above (the unlocked expense/time-entry count) used
 * to tell the user to "delete these entries first" even when the linked
 * expense was receipt-booked — since PR #534 that row's own UI only offers
 * "Move to job", so the instruction pointed nowhere. The early gate now runs
 * the same receipt-booked predicate the locked check uses and returns the
 * plain receipt message when it finds one; fakePrisma.expense.count
 * distinguishes the two query shapes so both paths can be driven
 * independently.
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
/** What the early gate's own receipt-booked-expense count (nit 2) returns. */
let earlyReceiptBookedCount: number;
let budgetRow: Record<string, unknown> | null;
/** What the NEW guard's `tx.expense.count(...)` (inside the lock) returns. */
let txReceiptBookedCount: number;
let txCountArgs: unknown;
let estimateDeleteArgs: unknown;

/** True for any opLog entry that represents a destructive statement. */
const isDelete = (op: string) => op.toLowerCase().includes("delete");

const fakeTx: any = {
    // The receipt-evidence lock and its epoch bump (PR #443 gate rounds
    // 42/45): the real lockReceiptEvidence/bumpReceiptEvidenceEpoch run
    // unmocked against this fake — nothing here depends on their result, only
    // that they are answerable and ordered.
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
    // Round 2: these three used to be plain prisma.* calls ahead of the lock
    // (see the file header). They now live on the SAME tx the guard checks,
    // so a regression that lets any of them run on the refusal path shows up
    // in opLog exactly like the Expense delete does.
    budget: {
        findUnique: async () => budgetRow,
        delete: async () => { opLog.push("tx.budget.delete"); return {}; },
    },
    estimateItem: {
        deleteMany: async () => { opLog.push("tx.estimateItem.deleteMany"); return { count: 0 }; },
    },
    estimatePaymentSchedule: {
        deleteMany: async () => { opLog.push("tx.estimatePaymentSchedule.deleteMany"); return { count: 0 }; },
    },
    // Round 3: the Estimate row itself, now deleted on this same tx client
    // instead of a separate post-commit `prisma.estimate.delete()`.
    estimate: {
        delete: async (args: unknown) => { estimateDeleteArgs = args; opLog.push("tx.estimate.delete"); return estimateRow; },
    },
};

const fakePrisma: any = {
    estimate: {
        findUnique: async () => estimateRow,
        // Deliberately no `delete` here (Round 3): the fix moved the Estimate
        // delete onto the transaction client. A regression that calls
        // `prisma.estimate.delete` again throws "not a function" instead of
        // quietly succeeding outside the lock.
    },
    expense: {
        // The EARLY, unlocked counts at the top of deleteEstimate — unrelated
        // to the tx-scoped guard this suite is about. Two different shapes
        // hit this same fake: the plain linked-expense count, and (nit 2) the
        // receipt-booked-only count the early gate now also runs. Route on
        // the where clause the way the real Prisma call is distinguished.
        count: async (args: { where?: { receiptIntake?: unknown } } = {}) =>
            args.where?.receiptIntake ? earlyReceiptBookedCount : earlyExpenseCount,
    },
    timeEntry: {
        count: async () => earlyTimeEntryCount,
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
    earlyReceiptBookedCount = 0;
    budgetRow = null;
    txReceiptBookedCount = 0;
    txCountArgs = null;
    estimateDeleteArgs = null;
});

test("refuses the whole delete when a receipt-booked Expense is linked", async () => {
    // The race: nothing showed up in the early, unlocked count, but a receipt
    // landed on this estimate by the time the locked transaction runs.
    txReceiptBookedCount = 1;
    // A Budget row is present, so a regression that deletes it before the
    // guard fires would show up in the op log below.
    budgetRow = { id: "budget-1" };
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, {
        success: false,
        error: "This estimate has 1 expense(s) from receipts, so it can't be deleted. Archive it instead.",
    });
    assert.ok(!opLog.some(isDelete), `no delete of any kind ran: ${opLog.join(" ")}`);
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
    budgetRow = { id: "budget-1" };
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, { success: true });
    assert.ok(opLog.includes("tx.expense.deleteMany"), `the ordinary Expense delete still ran: ${opLog.join(" ")}`);
    assert.ok(opLog.includes("tx.budget.delete"), `the Budget delete still ran: ${opLog.join(" ")}`);
    assert.ok(opLog.includes("tx.estimateItem.deleteMany"), `the EstimateItem delete still ran: ${opLog.join(" ")}`);
    assert.ok(opLog.includes("tx.estimatePaymentSchedule.deleteMany"), `the EstimatePaymentSchedule delete still ran: ${opLog.join(" ")}`);
    assert.ok(opLog.includes("tx.estimate.delete"), `the Estimate row itself was deleted on the tx client: ${opLog.join(" ")}`);
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

test("nit 2: the early gate is receipt-aware — returns the plain receipt message when a linked expense came from a receipt", async () => {
    earlyExpenseCount = 1;
    earlyReceiptBookedCount = 1;
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, {
        success: false,
        error: "This estimate has 1 expense(s) from receipts, so it can't be deleted. Archive it instead.",
    });
    assert.deepEqual(opLog, [], "the guarded transaction never ran at all — the early gate caught it first");
});

test("nit 2: the early gate's receipt message counts only receipt-booked expenses, not every linked expense", async () => {
    earlyExpenseCount = 3;
    earlyReceiptBookedCount = 2;
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, {
        success: false,
        error: "This estimate has 2 expense(s) from receipts, so it can't be deleted. Archive it instead.",
    });
});

test("nit 2: a linked time entry with no receipt-booked expense still gets the old, plain message", async () => {
    earlyTimeEntryCount = 1;
    earlyReceiptBookedCount = 0;
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, {
        success: false,
        error: "Cannot delete estimate because it has linked 1 time entry/entries. Please delete these entries first.",
    });
    assert.deepEqual(opLog, [], "the guarded transaction never ran at all");
});

test("the receipt check runs inside the lock, after it, and before any delete", async () => {
    txReceiptBookedCount = 0;
    budgetRow = { id: "budget-1" };
    await deleteEstimate("est-1");

    assert.deepEqual(
        opLog,
        [
            "lock",
            "tx.expense.count",
            "tx.budget.delete",
            "tx.estimateItem.deleteMany",
            "tx.estimatePaymentSchedule.deleteMany",
            "tx.expense.deleteMany",
            "tx.estimate.delete",
            "epoch-bump",
        ],
        "lock, then the guard's own check, then every delete inside that same transaction including the Estimate row itself, then the epoch bump",
    );
});

test("when refused, the transaction still closes out the lock normally, no delete runs, and (nit 1) the epoch is not bumped", async () => {
    // A refusal is not a thrown transaction failure — it is a plain early
    // return from inside the locked body, so the transaction commits. But
    // nothing was deleted, so nothing about receipt evidence changed either —
    // bumping the epoch here would only restart the missing-receipt sweep for
    // no reason (Codex round 2 nit).
    txReceiptBookedCount = 3;
    budgetRow = { id: "budget-1" };
    await deleteEstimate("est-1");

    assert.deepEqual(opLog, ["lock", "tx.expense.count"]);
    assert.ok(!opLog.includes("epoch-bump"), `a refusal must not bump the evidence epoch: ${opLog.join(" ")}`);
    assert.ok(!opLog.some(isDelete), `no delete of any kind ran: ${opLog.join(" ")}`);
});
