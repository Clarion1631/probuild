/**
 * `deleteExpense` — the SINGLE-expense server action (Codex round 10, item 3).
 *
 * The earlier divergent-attribution test covered the DELETE route, not this
 * path, and this one had its own copy of the bug: it authorized against
 * `expense.estimate.projectId`. For a re-attributed expense that names the job
 * it LEFT, so the check both admitted someone whose access is to the old job
 * and refused the crew who now own the row.
 *
 * Prisma, next-auth and the permission reader are patched at require() time —
 * same shape as tests/job-variance-db.test.ts. No mock.module: CI is Node 20.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { QboManagedExpenseError } from "../src/lib/qbo-expense-guard";
import { MOVE_MESSAGES } from "../src/lib/receipt-intake/booked-expense-rules";

interface FakeUser {
    id: string;
    role: string;
    permissions: Record<string, boolean>;
    projectIds: string[];
    email?: string;
}

let currentUser: FakeUser | null;
let storedExpense: Record<string, unknown> | null;
let deleteArgs: unknown;

/**
 * The ORDER of everything the batch does, one entry per statement — the only
 * way to see that every parent is reached before the first Expense row is
 * touched, which is what round 46 item 3 is about.
 */
let opLog: string[] = [];
let batchRows: Record<string, unknown>[] = [];
let findManyArgs: any = null;
/** Every `where` object a `deleteMany` call ever ran with, in call order. */
let deleteManyWheres: any[] = [];
/** How many times `$transaction` actually opened one. */
let transactionCalls = 0;

// ── Move to job (moveReceiptExpenseToJob) fixtures ─────────────────────────
/** `assertPhaseOfProjectTx`'s membership-proof query — [] means "not a phase". */
let membershipRows: unknown[] = [{ ok: 1 }];
/** `assertPhaseOfProjectTx`'s plain Project status read. */
let projectStatusRows: unknown[] = [{ id: "job-2", status: "In Progress" }];
/** `assertPhaseOfProjectTx`'s plain CostCode read. */
let costCodeRows: unknown[] = [{ id: "cc-1", code: "03-PLUMB", isActive: true }];
/** `tx.project.findUnique` — the target job Move to job reads at step 7. */
let projectRow: { name: string; status: string } | null = { name: "Mesplay Kitchen", status: "In Progress" };
/** `tx.estimate.findFirst` — `reattributeExpense`'s target-estimate peek/re-read. */
let targetEstimateId: string | null = "est-target-1";
let estimateFindFirstOverride: ((call: number) => string | null) | null = null;
let estimateFindFirstCall = 0;
/** `tx.expense.findUnique` call count, and an optional per-call override. */
let expenseFindUniqueCall = 0;
let expenseFindUniqueOverride: ((call: number, base: Record<string, unknown> | null) => Record<string, unknown> | null) | null = null;
/** The `reattributeExpense` CAS write (`tx.expense.updateMany` with projectId/estimateId in `data`). */
let reattributeUpdateArgs: any = null;
let reattributeUpdateCount = 1;
/** Move's own link-clearing write (`tx.expense.updateMany` with no projectId/estimateId in `data`). */
let linksUpdateArgs: any = null;
let linksUpdateCount = 1;
let intakeUpdateArgs: any = null;
let intakeUpdateCount = 1;
let automationEventArgs: any = null;

const fakePrisma: any = {
    // The receipt-evidence lock and its epoch bump (PR #443 gate rounds
    // 42/45): every Expense writer takes them, and nothing in this suite
    // depends on their result — only that they are answerable.
    $executeRaw: async () => { opLog.push("evidence-lock"); return 1; },
    $queryRaw: async () => { opLog.push("epoch-bump"); return [{ value: "1" }]; },
    // The delete now runs in a transaction that re-resolves a fallback-
    // attributed row's job from the LOCKED estimate (round 20, item 4).
    $transaction: async (fn: any) => { transactionCalls++; return fn(fakePrisma); },
    $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
        // `assertPhaseOfProjectTx`'s membership proof (`FOR SHARE OF ei, e` —
        // distinct from lockAttributionParents' bare `FOR SHARE OF ei`).
        if (/FOR SHARE OF ei, e/.test(query)) {
            opLog.push("phase:membership");
            return membershipRows;
        }
        // `lockExpense`'s per-expense advisory lock.
        if (/pg_advisory_xact_lock\(hashtextextended/.test(query)) {
            opLog.push(`advisory:${values[0]}`);
            return [{}];
        }
        if (/^SELECT id, status FROM "Project" WHERE id = \$1$/.test(query)) {
            opLog.push("phase:project-status");
            return projectStatusRows;
        }
        if (/^SELECT id, code, "isActive" FROM "CostCode" WHERE id = \$1$/.test(query)) {
            opLog.push("phase:costcode");
            return costCodeRows;
        }
        const table = query.match(/FROM "(\w+)"/)?.[1];
        if (/^SELECT "projectId" FROM "Estimate"/.test(query)) {
            opLog.push(`resolve:${values[0]}`);
            const known = batchRows.find(row => (row as any).estimateId === values[0]) as any;
            const row = storedExpense as Record<string, any> | null;
            return [{ projectId: known ? known.estimate?.projectId ?? null : row?.estimate?.projectId ?? null }];
        }
        if (/FOR SHARE/.test(query)) opLog.push(`lock:${table}[${values.flat(2).map(String).join(",")}]`);
        if (/FROM "Estimate"/.test(query) && /"projectId"/.test(query)) {
            const row = storedExpense as Record<string, any> | null;
            return [{ projectId: row?.estimate?.projectId ?? null }];
        }
        return [{}];
    },
    expense: {
        findUnique: async () => {
            expenseFindUniqueCall++;
            if (expenseFindUniqueOverride) return expenseFindUniqueOverride(expenseFindUniqueCall, storedExpense);
            return storedExpense;
        },
        findMany: async (args: unknown) => {
            findManyArgs = args;
            return batchRows;
        },
        deleteMany: async (args: unknown) => {
            deleteArgs = args;
            deleteManyWheres.push((args as any)?.where);
            opLog.push(`delete:${(args as any)?.where?.id}`);
            return { count: 1 };
        },
        // Two different writers share this method: `reattributeExpense`'s CAS
        // (its `data` names `projectId`/`estimateId`) and Move's own link-clear
        // (its `data` never does — see MoveToJobModal/booked-expense.ts §11).
        updateMany: async (args: unknown) => {
            const data = (args as any)?.data ?? {};
            if ("projectId" in data || "estimateId" in data) {
                reattributeUpdateArgs = args;
                opLog.push("reattribute:updateMany");
                return { count: reattributeUpdateCount };
            }
            linksUpdateArgs = args;
            opLog.push("links:updateMany");
            return { count: linksUpdateCount };
        },
    },
    estimate: {
        findFirst: async () => {
            estimateFindFirstCall++;
            const id = estimateFindFirstOverride ? estimateFindFirstOverride(estimateFindFirstCall) : targetEstimateId;
            opLog.push(`estimate.findFirst:${id ?? "null"}`);
            return id ? { id } : null;
        },
    },
    project: {
        findUnique: async () => {
            opLog.push("project:findUnique");
            return projectRow;
        },
    },
    receiptIntake: {
        updateMany: async (args: unknown) => {
            intakeUpdateArgs = args;
            opLog.push("intake:updateMany");
            return { count: intakeUpdateCount };
        },
    },
    automationEvent: {
        create: async (args: unknown) => {
            automationEventArgs = args;
            opLog.push("automationEvent:create");
            return {};
        },
    },
};

let deleteExpense: (id: string, projectId: string) => Promise<void>;
let deleteExpenses: (ids: string[]) => Promise<{ deleted: number; skippedFromReceipts: number }>;
let moveReceiptExpenseToJob: (
    expenseId: string, fromProjectId: string, toProjectId: string
) => Promise<{ ok: true; toProjectName: string; phaseCleared: boolean } | { ok: false; message: string }>;

before(async () => {
    const originalRequire = Module.prototype.require;
    let hit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") { hit = true; return { prisma: fakePrisma }; }
        if (id === "@/lib/permissions") {
            return {
                getCurrentUserWithPermissions: async () => currentUser,
                hasPermission: (user: FakeUser | null, key: string) =>
                    !!user && (user.role === "ADMIN" || user.permissions?.[key] === true),
                canAccessProject: (user: FakeUser, projectId: string) =>
                    user.role === "ADMIN" || user.projectIds.includes(projectId),
            };
        }
        if (id === "next/cache") return { revalidatePath: () => {} };
        if (id === "next-auth/next") return { getServerSession: async () => ({ user: { email: "x@y.z" } }) };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/lib/time-expense-actions");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.deleteExpense !== "function") {
        throw new Error(`expense-delete-scope: mocks did not apply (require patch ${hit ? "WAS" : "was NOT"} hit)`);
    }
    deleteExpense = mod.deleteExpense;
    deleteExpenses = mod.deleteExpenses;
    moveReceiptExpenseToJob = mod.moveReceiptExpenseToJob;
});

beforeEach(() => {
    currentUser = { id: "u1", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    // RE-ATTRIBUTED: it lives on job-1 now, its estimate still names job-2.
    storedExpense = {
        qbPurchaseId: null,
        invoiceId: null,
        invoicedAt: null,
        projectId: "job-1",
        estimateId: "est-job-2",
        estimate: { projectId: "job-2" },
    };
    deleteArgs = null;
    opLog = [];
    findManyArgs = null;
    batchRows = [];
    deleteManyWheres = [];
    transactionCalls = 0;
    membershipRows = [{ ok: 1 }];
    projectStatusRows = [{ id: "job-2", status: "In Progress" }];
    costCodeRows = [{ id: "cc-1", code: "03-PLUMB", isActive: true }];
    projectRow = { name: "Mesplay Kitchen", status: "In Progress" };
    targetEstimateId = "est-target-1";
    estimateFindFirstOverride = null;
    estimateFindFirstCall = 0;
    expenseFindUniqueCall = 0;
    expenseFindUniqueOverride = null;
    reattributeUpdateArgs = null;
    reattributeUpdateCount = 1;
    linksUpdateArgs = null;
    linksUpdateCount = 1;
    intakeUpdateArgs = null;
    intakeUpdateCount = 1;
    automationEventArgs = null;
});

// ── Move to job (moveReceiptExpenseToJob) ───────────────────────────────────

const FROM_PROJECT = "job-1";
const TO_PROJECT = "job-2";

/** A receipt-booked native Expense, ready to move from FROM_PROJECT to TO_PROJECT. */
function receiptBookedExpense(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "e1",
        projectId: FROM_PROJECT,
        estimateId: "est-source-1",
        costCodeId: "cc-1",
        amount: "146.32",
        vendor: "Lowe's",
        qbPurchaseId: null,
        invoiceId: null,
        invoicedAt: null,
        changeOrderId: null,
        receiptIntake: {
            id: "intake-1",
            state: "BOOKED",
            sendAttempted: false,
            qbPurchaseId: null,
            postVoidQbPurchaseId: null,
            claimToken: null,
        },
        ...overrides,
    };
}

function moverUser(overrides: Partial<FakeUser> = {}): FakeUser {
    return {
        id: "u-mover", role: "MANAGER", permissions: { timeClock: true },
        projectIds: [FROM_PROJECT, TO_PROJECT], email: "mover@goldentouchremodeling.com",
        ...overrides,
    };
}

test("moveReceiptExpenseToJob: happy path, phase kept — opLog order, one transaction", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();

    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);

    assert.deepEqual(res, { ok: true, toProjectName: "Mesplay Kitchen", phaseCleared: false });
    assert.equal(transactionCalls, 1, "one transaction, no retry");

    const at = (needle: string) => opLog.findIndex(entry => entry.startsWith(needle));
    const evidenceLock = at("evidence-lock");
    const epochBump = at("epoch-bump");
    const firstExpenseRead = 0; // findUnique itself isn't logged; inferred from call count below
    void firstExpenseRead;
    const firstLock = at("lock:Project");
    const estimateLock = at("lock:Estimate");
    const itemLock = at("lock:EstimateItem");
    const costCodeLock = at("lock:CostCode");
    const projectRead = at("project:findUnique");
    const phaseProjectStatus = at("phase:project-status");
    const phaseCostCode = at("phase:costcode");
    const phaseMembership = at("phase:membership");
    const advisory = at("advisory:expense:e1");
    const reattribute = at("reattribute:updateMany");
    const links = at("links:updateMany");
    const intake = at("intake:updateMany");
    const automationEvent = at("automationEvent:create");

    assert.ok(evidenceLock === 0, `evidence lock is first: ${opLog.join(" ")}`);
    assert.ok(epochBump === 1, `epoch bump is second: ${opLog.join(" ")}`);
    assert.ok(evidenceLock < epochBump, opLog.join(" "));
    assert.ok(epochBump < firstLock, `parents locked after the epoch bump: ${opLog.join(" ")}`);
    assert.ok(firstLock < estimateLock && estimateLock < itemLock && itemLock < costCodeLock,
        `Project, Estimate, EstimateItem, CostCode, in that order: ${opLog.join(" ")}`);
    assert.ok(costCodeLock < projectRead, `the parents are held before the target job is read: ${opLog.join(" ")}`);
    assert.ok(projectRead < phaseProjectStatus, opLog.join(" "));
    assert.ok(phaseProjectStatus < phaseCostCode && phaseCostCode < phaseMembership,
        `the phase check runs project, then cost code, then membership: ${opLog.join(" ")}`);
    assert.ok(phaseMembership < advisory, `the per-expense lock comes last of the locks: ${opLog.join(" ")}`);
    assert.ok(advisory < reattribute, `reattributeExpense's CAS follows the advisory lock: ${opLog.join(" ")}`);
    assert.ok(reattribute < links, `the links clear follows the move: ${opLog.join(" ")}`);
    assert.ok(links < intake, `the intake row moves after the links clear: ${opLog.join(" ")}`);
    assert.ok(intake < automationEvent, `the audit row is written last: ${opLog.join(" ")}`);

    assert.equal(expenseFindUniqueCall, 3, "the initial read, the re-read, and reattributeExpense's own read");
});

test("moveReceiptExpenseToJob: happy path, phase cleared — links and intake data, result", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    membershipRows = []; // not a phase of the target job

    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);

    assert.deepEqual(res, { ok: true, toProjectName: "Mesplay Kitchen", phaseCleared: true });

    assert.deepEqual(linksUpdateArgs.data, {
        itemId: null, changeOrderId: null, isBillable: false, purchaseOrderId: null,
        costCodeId: null, costCodeSource: null, costCodeConfidence: null,
    });
    assert.deepEqual(linksUpdateArgs.where, {
        id: "e1", projectId: TO_PROJECT, estimateId: "est-target-1",
        qbPurchaseId: null, invoiceId: null, invoicedAt: null,
    });

    assert.deepEqual(intakeUpdateArgs.data, {
        projectId: TO_PROJECT, costCodeId: null, suggestedCostCodeId: null,
        suggestedConfidence: null, costCodeSource: null,
    });
});

test("moveReceiptExpenseToJob: phase kept — links data carries no phase clear, and no money/status keys", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();

    await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);

    assert.deepEqual(linksUpdateArgs.data, {
        itemId: null, changeOrderId: null, isBillable: false, purchaseOrderId: null,
    });
    for (const forbidden of ["amount", "vendor", "date", "description", "receiptUrl", "status", "taxAmount", "taxDeductibleBase"]) {
        assert.ok(!(forbidden in linksUpdateArgs.data), `links data must not touch ${forbidden}`);
    }

    assert.deepEqual(intakeUpdateArgs.where, {
        id: "intake-1", expenseId: "e1", state: "BOOKED",
        qbPurchaseId: null, postVoidQbPurchaseId: null, sendAttempted: false, claimToken: null,
    });
    for (const forbidden of ["state", "bookedAt", "expenseId", "dedupStrongKey", "dedupWeakKey"]) {
        assert.ok(!(forbidden in intakeUpdateArgs.data), `intake data must not touch ${forbidden}`);
    }

    assert.equal(automationEventArgs.data.kind, "receipt-moved");
    const detail = JSON.parse(automationEventArgs.data.detail);
    assert.equal(detail.expenseId, "e1");
    assert.equal(detail.intakeId, "intake-1");
    assert.equal(detail.fromProjectId, FROM_PROJECT);
    assert.equal(detail.toProjectId, TO_PROJECT);
    assert.equal(detail.phaseKept, true);
});

test("moveReceiptExpenseToJob: role check — a non-ADMIN/MANAGER user gets notAllowed, no transaction", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser({ role: "FIELD_CREW" });

    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);

    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.notAllowed });
    assert.equal(transactionCalls, 0, "no transaction runs");
});

test("moveReceiptExpenseToJob: not receipt-booked", async () => {
    storedExpense = receiptBookedExpense({ receiptIntake: null });
    currentUser = moverUser();
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.notFromReceipt });
});

test("moveReceiptExpenseToJob: a QBO row is refused as not-from-receipt, even with an intake link", async () => {
    // QBO-backed wins (design spec §4.1): a qbPurchaseId disqualifies the row
    // from isReceiptBookedExpense, whatever else is true of it.
    storedExpense = receiptBookedExpense({ qbPurchaseId: "qbo-purchase-1" });
    currentUser = moverUser();
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.notFromReceipt });
});

test("moveReceiptExpenseToJob: billed", async () => {
    storedExpense = receiptBookedExpense({ invoiceId: "inv-1" });
    currentUser = moverUser();
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.billed });
});

test("moveReceiptExpenseToJob: invoicedAt alone also refuses billed", async () => {
    storedExpense = receiptBookedExpense({ invoicedAt: new Date().toISOString() });
    currentUser = moverUser();
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.billed });
});

test("moveReceiptExpenseToJob: ARCHIVED intake", async () => {
    const base = receiptBookedExpense();
    storedExpense = receiptBookedExpense({ receiptIntake: { ...(base.receiptIntake as object), state: "ARCHIVED" } });
    currentUser = moverUser();
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.archived });
});

for (const [label, patch] of [
    ["sendAttempted", { sendAttempted: true }],
    ["qbPurchaseId on the intake", { qbPurchaseId: "qbo-1" }],
    ["postVoidQbPurchaseId", { postVoidQbPurchaseId: "qbo-2" }],
    ["claimToken", { claimToken: "claim-1" }],
    ["a non-BOOKED state", { state: "NEEDS_REVIEW" }],
] as const) {
    test(`moveReceiptExpenseToJob: a busy intake (${label}) refuses askJustin`, async () => {
        const base = receiptBookedExpense();
        storedExpense = receiptBookedExpense({ receiptIntake: { ...(base.receiptIntake as object), ...patch } });
        currentUser = moverUser();
        const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
        assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.askJustin });
    });
}

test("moveReceiptExpenseToJob: stale fromProjectId refuses changed", async () => {
    storedExpense = receiptBookedExpense({ projectId: "some-other-job" });
    currentUser = moverUser({ projectIds: [FROM_PROJECT, TO_PROJECT, "some-other-job"] });
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.changed });
});

test("moveReceiptExpenseToJob: same job refuses sameJob", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, FROM_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.sameJob });
});

test("moveReceiptExpenseToJob: a closed target job refuses jobNotOpen", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    projectRow = { name: "Closed Job", status: "Closed Complete" };
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.jobNotOpen });
});

test("moveReceiptExpenseToJob: a missing target job also refuses jobNotOpen", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    projectRow = null;
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.jobNotOpen });
});

test("moveReceiptExpenseToJob: reattributeExpense no-such-expense refuses gone", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    // Calls 1 and 2 are Move's own reads; call 3 is reattributeExpense's `before` read.
    expenseFindUniqueOverride = (call, base) => (call >= 3 ? null : base);
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.gone });
});

test("moveReceiptExpenseToJob: reattributeExpense already-there refuses sameJob", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    expenseFindUniqueOverride = (call, base) => (call >= 3 ? { ...base, projectId: TO_PROJECT } : base);
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.sameJob });
});

test("moveReceiptExpenseToJob: reattributeExpense target-moved refuses changed", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    // The peek (call 1) and the locked re-read (call 2) disagree.
    estimateFindFirstOverride = call => (call === 1 ? "est-peek" : "est-relocked");
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.changed });
});

test("moveReceiptExpenseToJob: reattributeExpense lost-the-race refuses changed", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    reattributeUpdateCount = 0;
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.changed });
});

test("moveReceiptExpenseToJob: no estimate on the target job refuses noEstimate, after rolling back", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    targetEstimateId = null;
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.noEstimate });
    // The rollback point: nothing after the move's own estimate lookup runs.
    assert.equal(linksUpdateArgs, null, "no link write after a refused move");
    assert.equal(intakeUpdateArgs, null, "no intake write after a refused move");
    assert.equal(automationEventArgs, null, "no audit write after a refused move");
});

test("moveReceiptExpenseToJob: an intake CAS count of 0 refuses changed, after the links already wrote", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    intakeUpdateCount = 0;
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.changed });
});

test("moveReceiptExpenseToJob: a links CAS count of 0 refuses changed, before the intake row is touched", async () => {
    storedExpense = receiptBookedExpense();
    currentUser = moverUser();
    linksUpdateCount = 0;
    const res = await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.deepEqual(res, { ok: false, message: MOVE_MESSAGES.changed });
    assert.equal(intakeUpdateArgs, null, "the transaction rolled back before the intake write");
});

test("moveReceiptExpenseToJob: every refusal makes no write at all", async () => {
    storedExpense = receiptBookedExpense({ invoiceId: "inv-1" }); // billed — refused before any lock
    currentUser = moverUser();
    await moveReceiptExpenseToJob("e1", FROM_PROJECT, TO_PROJECT);
    assert.equal(linksUpdateArgs, null);
    assert.equal(intakeUpdateArgs, null);
    assert.equal(automationEventArgs, null);
});

async function attempt(projectId: string): Promise<string | null> {
    try {
        await deleteExpense("e1", projectId);
        return null;
    } catch (error) {
        return (error as Error).message;
    }
}

test("the job the expense is ON can delete it", async () => {
    assert.equal(await attempt("job-1"), null);
    // The predicate carries the job the actor was authorized against (round 20,
    // item 4), so a row that moves in the gap matches nothing.
    assert.deepEqual(deleteArgs, {
        where: {
            id: "e1", qbPurchaseId: null, invoiceId: null, invoicedAt: null,
            receiptIntake: { is: null },
            projectId: "job-1",
        },
    });
});

test("the job it LEFT cannot — not even from that job's own page", async () => {
    // Reading the estimate would have said "job-2" and allowed this.
    currentUser = { id: "u2", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-2"] };
    assert.equal(await attempt("job-2"), "Forbidden");
    assert.equal(deleteArgs, null, "and nothing is deleted");
});

test("access to the new job is still required, not just the right projectId", async () => {
    currentUser = { id: "u3", role: "FIELD_CREW", permissions: { timeClock: true }, projectIds: ["somewhere-else"] };
    assert.equal(await attempt("job-1"), "Forbidden");
    assert.equal(deleteArgs, null);
});

test("an unattributed expense falls back to its estimate's job", async () => {
    // The resolver's other branch: nothing to prefer, so the estimate decides.
    storedExpense = { ...storedExpense, projectId: null };
    currentUser = { id: "u4", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-2"] };
    assert.equal(await attempt("job-2"), null);
    // ...and the estimate is pinned in the predicate, so a re-point loses.
    assert.deepEqual((deleteArgs as any).where.estimate, { is: { projectId: "job-2" } });
});

test("an estimate re-pointed under a fallback DELETE is refused", async () => {
    // The locked read is the first thing that can see the move; the actor was
    // authorized for job-2 and the row now belongs to somebody else.
    storedExpense = { ...storedExpense, projectId: null };
    currentUser = { id: "u7", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-2"] };
    const original = fakePrisma.$queryRawUnsafe;
    fakePrisma.$queryRawUnsafe = async (query: string) => {
        if (/FROM "Estimate"/.test(query) && /"projectId"/.test(query)) {
            return [{ projectId: "job-3" }];
        }
        return [{}];
    };
    try {
        assert.equal(await attempt("job-2"), "Forbidden");
        assert.equal(deleteArgs, null, "nothing is destroyed under a stale permission");
    } finally {
        fakePrisma.$queryRawUnsafe = original;
    }
});

test("a row with no job at all cannot be deleted here", async () => {
    storedExpense = { ...storedExpense, projectId: null, estimate: { projectId: null } };
    currentUser = { id: "u5", role: "ADMIN", permissions: {}, projectIds: [] };
    assert.equal(await attempt("job-1"), "Forbidden", "no scope to authorize against");
});

test("the timeClock permission is still required", async () => {
    currentUser = { id: "u6", role: "FIELD_CREW", permissions: {}, projectIds: ["job-1"] };
    assert.equal(await attempt("job-1"), "Forbidden");
});

// ── receipt-booked guards (design spec, native-expense-guards-spec.md §5) ───

test("deleteExpense on a receipt row throws RECEIPT_EXPENSE_NO_DELETE and never opens a transaction", async () => {
    storedExpense = { ...storedExpense, projectId: "job-1", receiptIntake: { id: "intake-1" } };
    assert.equal(await attempt("job-1"), "This came from a receipt, so it can't be deleted. Use Move to job if it's on the wrong job. If it's a double, tell Justin.");
    assert.equal(transactionCalls, 0, "the row is refused before the transaction that would lock and delete it");
    assert.equal(deleteArgs, null);
});

test("a QBO row still throws QboManagedExpenseError, whether or not it also carries a receipt link", async () => {
    storedExpense = { ...storedExpense, projectId: "job-1", qbPurchaseId: "qbo-1", receiptIntake: { id: "intake-1" } };
    await assert.rejects(() => deleteExpense("e1", "job-1"), QboManagedExpenseError);
    assert.equal(deleteArgs, null);

    batchRows = [{ id: "e-qbo", qbPurchaseId: "qbo-1", projectId: "job-1", estimateId: null, invoiceId: null, invoicedAt: null, receiptIntake: null }];
    currentUser = { id: "u-qbo", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    await assert.rejects(() => deleteExpenses(["e-qbo"]), QboManagedExpenseError);
});

test("deleteExpenses skips a receipt row, deletes a manual one, and pins receiptIntake: { is: null } on every write", async () => {
    batchRows = [
        {
            id: "e-manual", qbPurchaseId: null, invoiceId: null, invoicedAt: null,
            projectId: "job-1", estimateId: null, estimate: { projectId: null }, receiptIntake: null,
        },
        {
            id: "e-receipt", qbPurchaseId: null, invoiceId: null, invoicedAt: null,
            projectId: "job-1", estimateId: null, estimate: { projectId: null }, receiptIntake: { id: "intake-1" },
        },
    ];
    currentUser = { id: "u-batch", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };

    const result = await deleteExpenses(["e-manual", "e-receipt"]);

    assert.deepEqual(result, { deleted: 1, skippedFromReceipts: 1 });
    assert.equal(deleteManyWheres.length, 1, "no deleteMany is ever issued for the receipt row");
    assert.equal(deleteManyWheres[0].id, "e-manual");
    for (const where of deleteManyWheres) {
        assert.deepEqual(where.receiptIntake, { is: null });
    }
});

test("deleteExpenses: every row receipt-booked returns deleted: 0 with the right skipped count", async () => {
    batchRows = [{
        id: "e-receipt", qbPurchaseId: null, invoiceId: null, invoicedAt: null,
        projectId: "job-1", estimateId: null, estimate: { projectId: null }, receiptIntake: { id: "intake-1" },
    }];
    currentUser = { id: "u-batch2", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    const result = await deleteExpenses(["e-receipt"]);
    assert.deepEqual(result, { deleted: 0, skippedFromReceipts: 1 });
    assert.equal(deleteManyWheres.length, 0);
});

// ── the BATCH (Codex round 46, item 3) ─────────────────────────────────────

/**
 * TWO ROWS, TWO ESTIMATES — the shape that makes the interleaving visible.
 * Both are fallback-attributed, so each one's job is re-resolved from its own
 * estimate under lock, which is the parent acquisition that used to sit
 * BETWEEN the deletes.
 */
function twoRowBatch() {
    batchRows = [
        { id: "e-a", qbPurchaseId: null, invoiceId: null, invoicedAt: null,
          projectId: null, estimateId: "est-a", estimate: { projectId: "job-1" } },
        { id: "e-b", qbPurchaseId: null, invoiceId: null, invoicedAt: null,
          projectId: null, estimateId: "est-b", estimate: { projectId: "job-1" } },
    ];
}

test("the batch takes EVERY parent before it touches any expense", async () => {
    // The bug: lock row A's parents, delete row A — which takes that Expense
    // exclusively and, through the foreign keys, a KEY SHARE on its Project
    // and Estimate — and only THEN reach for row B's parents. That is
    // Expense -> Estimate inside one transaction, the declared order
    // backwards, and against anything holding an estimate while touching an
    // expense it is a cycle. tests/attribution-lock-order-db.test.ts drives
    // the same sequence against a real Postgres and shows the 40P01.
    twoRowBatch();
    currentUser = { id: "u8", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    const result = await deleteExpenses(["e-a", "e-b"]);

    assert.equal(result.deleted, 2);
    const firstDelete = opLog.findIndex(entry => entry.startsWith("delete:"));
    assert.ok(firstDelete > 0, `something has to be locked first: ${opLog.join(" ")}`);
    const idsIn = (entries: string[]) =>
        new Set(entries.flatMap(entry => (entry.match(/\[(.*)\]/)?.[1] ?? "").split(",").filter(Boolean)));
    const before = idsIn(opLog.slice(0, firstDelete).filter(entry => entry.startsWith("lock:")));
    const after = opLog.slice(firstDelete).filter(entry => entry.startsWith("lock:"));

    // A NEW parent may not be reached after an Expense has been written. The
    // per-row `resolveExpenseProjectUnderLock` still re-locks each estimate as
    // it goes and that is fine — re-acquiring a share lock this transaction
    // already holds takes no new lock at all, which is exactly why the ids are
    // checked rather than the statements.
    const fresh = [...idsIn(after)].filter(id => !before.has(id));
    assert.deepEqual(fresh, [], `these parents were first reached AFTER a delete: ${opLog.join(" ")}`);
    assert.deepEqual(
        after.filter(entry => entry.startsWith("lock:Project")),
        [],
        `and no Project row may be reached after a delete: ${opLog.join(" ")}`,
    );
});

test("...and both rows' estimates are named in that ONE acquisition", async () => {
    // Locking only the first row's parents would satisfy the ordering check
    // above while leaving the second row's estimate to be reached after the
    // first delete, so the ids matter as much as the position.
    twoRowBatch();
    currentUser = { id: "u9", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    await deleteExpenses(["e-a", "e-b"]);
    // BEFORE the first delete, not merely somewhere in the transaction: the
    // per-row re-resolve reaches every estimate eventually, so a check that
    // only asks "was it locked at all" passes against the un-fixed code.
    const firstDelete = opLog.findIndex(entry => entry.startsWith("delete:"));
    const upfront = opLog.slice(0, firstDelete).join(" ");
    assert.match(upfront, /est-a/, `est-a is locked up front: ${opLog.join(" ")}`);
    assert.match(upfront, /est-b/, `est-b is locked up front: ${opLog.join(" ")}`);
});

test("the batch is read in ASCENDING id order, so two of them cannot invert", async () => {
    // Expense-vs-Expense, with no parent table involved: two people deleting
    // overlapping selections take the same rows exclusively, and an unordered
    // `findMany` lets the server hand them back in different orders. Pinning
    // the read order is the whole fix — the loop preserves it.
    twoRowBatch();
    currentUser = { id: "u10", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    await deleteExpenses(["e-b", "e-a"]);

    assert.deepEqual(findManyArgs?.orderBy, { id: "asc" }, "the read is ordered");
    assert.deepEqual(
        opLog.filter(entry => entry.startsWith("delete:")),
        ["delete:e-a", "delete:e-b"],
        "and the writes follow that order, not the caller's argument order",
    );
});
