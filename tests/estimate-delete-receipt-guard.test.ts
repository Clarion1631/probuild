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
 * though nothing was deleted — it now bumps only inside the success branch,
 * alongside the deletes it actually describes. (2) The pre-existing early
 * gate above (the unlocked expense/time-entry count) used to tell the user to
 * "delete these entries first" even when the linked expense was
 * receipt-booked — since PR #534 that row's own UI only offers "Move to
 * job", so the instruction pointed nowhere. The early gate now runs the same
 * receipt-booked predicate the locked check uses and returns the plain
 * receipt message when it finds one; fakePrisma.expense.count distinguishes
 * the two query shapes so both paths can be driven independently.
 *
 * ROUND 5 (2026-09-23, Codex xhigh post-merge re-review of #542, BLOCKER):
 * the locked guard itself was still wrong. It counted only NATIVE receipt
 * expenses (qbPurchaseId null with a linked ReceiptIntake) and then, once
 * that count read zero, deleted EVERY Expense on the estimate regardless of
 * kind — so a QBO-backed receipt expense (qbPurchaseId SET, still carrying
 * its ReceiptIntake) was never counted but was destroyed anyway, and the
 * same was true of a plain ordinary Expense some other writer committed in
 * the gap between the early unlocked count and this lock (the R1 race,
 * flagged in the same review). The guard now counts ALL Expenses on the
 * estimate under the lock first; if any exist it refuses the whole delete
 * and only THEN asks whether any of them carry a ReceiptIntake (whatever
 * their qbPurchaseId) to choose which message to show. fakeTx.expense.count
 * now answers two distinct query shapes and `lockedCountCalls` records every
 * call, in order, so the tests below can assert both which query ran and how
 * many times.
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
/** The args of the early gate's receipt-specific count, captured for the shape assertion below. */
let earlyReceiptCountArgs: unknown;
let budgetRow: Record<string, unknown> | null;
/** What the locked guard's ALL-Expenses count (round 5) returns. */
let lockedExpenseCount: number;
/** What the locked guard's receipt-specific count (round 5, only run when lockedExpenseCount > 0) returns. */
let lockedReceiptCount: number;
/** Every `tx.expense.count` call this run made, in order, for shape and call-count assertions. */
let lockedCountCalls: unknown[];
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
        // ROUND 5: up to two distinct queries land here now. The ALL-Expenses
        // count has no `receiptIntake` key in its where; the receipt-specific
        // one (only asked when the first count is nonzero) does. Routing on
        // shape rather than call order keeps this honest about which query
        // deleteEstimate actually sent.
        count: async (args: { where?: { receiptIntake?: unknown } } = {}) => {
            lockedCountCalls.push(args);
            opLog.push("tx.expense.count");
            return args.where?.receiptIntake ? lockedReceiptCount : lockedExpenseCount;
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
        count: async (args: { where?: { receiptIntake?: unknown } } = {}) => {
            if (args.where?.receiptIntake) {
                earlyReceiptCountArgs = args;
                return earlyReceiptBookedCount;
            }
            return earlyExpenseCount;
        },
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
    earlyReceiptCountArgs = null;
    budgetRow = null;
    lockedExpenseCount = 0;
    lockedReceiptCount = 0;
    lockedCountCalls = [];
    estimateDeleteArgs = null;
});

test("refuses the whole delete when a NATIVE receipt-booked Expense is linked", async () => {
    // The race: nothing showed up in the early, unlocked count, but a receipt
    // landed on this estimate by the time the locked transaction runs.
    lockedExpenseCount = 1;
    lockedReceiptCount = 1;
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

test("round 5 BLOCKER: refuses the whole delete for a QBO-backed receipt Expense too", async () => {
    // Codex xhigh post-merge review of #542. The OLD guard's count filtered
    // on `qbPurchaseId: null`, so a receipt Expense QuickBooks already owns
    // (qbPurchaseId SET, ReceiptIntake still linked) was invisible to the
    // count and got deleted along with everything else once that count read
    // zero. The fake here cannot literally set qbPurchaseId (deleteEstimate's
    // real query no longer filters on it at all — that IS the fix), so this
    // asserts the observable behavior the old code got wrong: a receipt-
    // linked Expense at lock time refuses the delete, full stop, regardless
    // of who owns it downstream.
    lockedExpenseCount = 1;
    lockedReceiptCount = 1;
    budgetRow = { id: "budget-1" };
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, {
        success: false,
        error: "This estimate has 1 expense(s) from receipts, so it can't be deleted. Archive it instead.",
    });
    assert.ok(!opLog.some(isDelete), `no delete of any kind ran: ${opLog.join(" ")}`);
    assert.equal(estimateDeleteArgs, null);
});

test("round 5 (R1 race): refuses the whole delete for an ORDINARY Expense appearing at lock time too", async () => {
    // The other half of the same blocker: an Expense with no ReceiptIntake at
    // all, committed by some other writer in the gap between the early
    // unlocked count and this lock. The OLD guard's count was receipt-only,
    // so this case sailed straight through and the ordinary Expense (and the
    // rest of the estimate) was deleted under it. It now refuses with the
    // ordinary message instead, same as if it had been visible from the
    // start.
    lockedExpenseCount = 1;
    lockedReceiptCount = 0;
    budgetRow = { id: "budget-1" };
    const result = await deleteEstimate("est-1");

    assert.deepEqual(result, {
        success: false,
        error: "Cannot delete estimate because it has linked 1 expense(s). Please delete these entries first.",
    });
    assert.ok(!opLog.some(isDelete), `no delete of any kind ran: ${opLog.join(" ")}`);
    assert.equal(estimateDeleteArgs, null);
});

test("the locked guard's first query counts EVERY Expense on the estimate, not just receipt ones", async () => {
    await deleteEstimate("est-1");
    assert.deepEqual(lockedCountCalls[0], { where: { estimateId: "est-1" } });
});

test("the locked guard's second query — only run when Expenses exist — asks for receipt-booked ones specifically", async () => {
    lockedExpenseCount = 1;
    lockedReceiptCount = 1;
    await deleteEstimate("est-1");
    assert.deepEqual(lockedCountCalls, [
        { where: { estimateId: "est-1" } },
        { where: { estimateId: "est-1", receiptIntake: { isNot: null } } },
    ]);
});

test("the locked guard never runs its second query when the estimate is already clear of Expenses", async () => {
    lockedExpenseCount = 0;
    await deleteEstimate("est-1");
    assert.equal(lockedCountCalls.length, 1, `only the ALL-Expenses count should run: ${JSON.stringify(lockedCountCalls)}`);
});

test("the early gate's receipt test no longer filters on qbPurchaseId (matches the locked guard)", async () => {
    earlyExpenseCount = 1;
    earlyReceiptBookedCount = 1;
    await deleteEstimate("est-1");
    assert.deepEqual(earlyReceiptCountArgs, {
        where: { estimateId: "est-1", receiptIntake: { isNot: null } },
    });
});

test("unchanged behavior: proceeds normally when no Expense is linked at lock time", async () => {
    lockedExpenseCount = 0;
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

test("the Expense check runs inside the lock, after it, and before any delete", async () => {
    lockedExpenseCount = 0;
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
    lockedExpenseCount = 3;
    lockedReceiptCount = 0;
    budgetRow = { id: "budget-1" };
    await deleteEstimate("est-1");

    assert.deepEqual(opLog, ["lock", "tx.expense.count", "tx.expense.count"]);
    assert.ok(!opLog.includes("epoch-bump"), `a refusal must not bump the evidence epoch: ${opLog.join(" ")}`);
    assert.ok(!opLog.some(isDelete), `no delete of any kind ran: ${opLog.join(" ")}`);
});
