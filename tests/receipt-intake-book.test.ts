/**
 * Booking, driven entirely through injected functions — no QuickBooks, no
 * Supabase, no database, and no module mocking (CI is Node 20, where
 * `mock.module` corrupts the require chain).
 *
 * This is a REAL BOOKS path, so the assertions are about money and about
 * attempts: which failures cost the row a strike and which do not is the
 * difference between a document a human sees today and one that quietly
 * retries for a week.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    bookReceipt,
    buildGroups,
    driveFileIdOf,
    expenseAmountCents,
    type BookableRow,
    type BookDependencies,
} from "../src/lib/receipt-intake/book";
import { QBTimeoutError } from "../src/lib/quickbooks";
import {
    QboAccountConfigError,
    QboPurchaseFaultError,
    QboVendorDuplicateError,
} from "../src/lib/qbo-receipt-push";

const NOW = new Date("2026-09-01T12:00:00.000Z");

function row(overrides: Partial<BookableRow> = {}): BookableRow {
    return {
        id: "intake-1",
        source: "drive",
        sourceRef: "drive:FILE123",
        dryRun: false,
        projectId: "proj-1",
        costCodeId: null,
        suggestedCostCodeId: "cc-plumb",
        storagePath: "receipts/intake/intake-1.jpg",
        fileName: "receipt.jpg",
        mimeType: "image/jpeg",
        vendor: "Lowes",
        txnDate: new Date("2026-08-03T00:00:00.000Z"),
        totalCents: 36498,
        taxCents: 2920,
        docType: "receipt",
        refNumber: "82766",
        memo: null,
        attempts: 0,
        ...overrides,
    };
}

interface Recorder {
    deps: BookDependencies;
    purchaseCalls: any[];
    expenses: any[];
    intakeUpdates: any[];
    events: any[];
}

function recorder(overrides: Partial<BookDependencies> = {}, opts: { estimates?: { id: string }[] } = {}): Recorder {
    const purchaseCalls: any[] = [];
    const expenses: any[] = [];
    const intakeUpdates: any[] = [];
    const events: any[] = [];

    const tx = {
        project: {
            findUnique: async () => ({
                id: "proj-1",
                name: "Berg ADU",
                estimates: opts.estimates ?? [{ id: "est-1" }],
            }),
        },
        expense: {
            findUnique: async () => null,
            create: async (args: any) => { expenses.push(args.data); return { id: `exp-${expenses.length}` }; },
        },
        receiptIntake: {
            update: async (args: any) => { intakeUpdates.push(args.data); return {}; },
        },
        $transaction: async (fn: any) => fn(tx),
    };

    const deps: BookDependencies = {
        db: tx as any,
        isPushEnabled: () => true,
        isPushPaused: async () => false,
        getTokens: async () => ({ accessToken: "t", realmId: "r" }) as any,
        createPurchase: async (_tokens, input) => {
            purchaseCalls.push(input);
            return { ok: true, qbPurchaseId: "QB-1", docNumber: input.fileId.slice(0, 21), alreadyExists: false, attachment: "attached" };
        },
        downloadBytes: async () => Buffer.from("bytes"),
        logEvent: async (event) => { events.push(event); },
        now: () => NOW,
        ...overrides,
    };
    return { deps, purchaseCalls, expenses, intakeUpdates, events };
}

test("a taxed receipt splits into a pre-tax line and a sales-tax line that reconstruct the total", () => {
    const groups = buildGroups("receipt", 36498, 2920, "82766");
    assert.deepEqual(groups, [
        { category: "Receipt (pre-tax)", amount: 335.78, lines: [] },
        { category: "Sales tax", amount: 29.2, tax: true, lines: [] },
    ]);
    assert.equal(Math.round((groups[0].amount + groups[1].amount) * 100), 36498);
});

test("a check NEVER splits tax, however the tax field was read", () => {
    // sendToQBOviaAPI.js:148 — the reseller-permit reclaim covers job materials,
    // and a handwritten check is not a taxed vendor purchase.
    const groups = buildGroups("check", 120000, 9000, "Check4178");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].category, "Check #4178");
    assert.equal(groups[0].tax, undefined);
});

test("a nonsense or absent tax falls back to the single-line shape", () => {
    assert.equal(buildGroups("receipt", 10000, null, "1").length, 1);
    assert.equal(buildGroups("receipt", 10000, 0, "1").length, 1);
    assert.equal(buildGroups("receipt", 10000, 10000, "1").length, 1, "tax >= total is a bad read");
    assert.equal(buildGroups("receipt", 10000, 20000, "1").length, 1);
});

test("the Expense amount is the PRE-TAX figure when the tax was split", () => {
    // Mirrors the QBO COGS line: the sales tax posts to its own reclaimable
    // account, so job cost must not double-count it.
    const groups = buildGroups("receipt", 36498, 2920, "82766");
    assert.equal(expenseAmountCents(groups, 36498), 33578);
    assert.equal(expenseAmountCents(buildGroups("receipt", 10000, null, "1"), 10000), 10000);
});

test("only a drive row books under the Drive file id", () => {
    assert.equal(driveFileIdOf({ source: "drive", sourceRef: "drive:FILE123" }), "FILE123");
    assert.equal(driveFileIdOf({ source: "mobile", sourceRef: "mobile:abc" }), null);
    assert.equal(driveFileIdOf({ source: "drive", sourceRef: "drive:" }), null);
});

test("a successful booking creates the Expense at the pre-tax amount and marks the row BOOKED", async () => {
    const r = recorder();
    const result = await bookReceipt(row(), r.deps);

    assert.equal(result.outcome, "booked");
    assert.equal(r.purchaseCalls.length, 1);
    // DocNumber idempotency stays continuous with any v1 booking of the same file.
    assert.equal(r.purchaseCalls[0].fileId, "FILE123");
    assert.equal(r.purchaseCalls[0].date, "2026-08-03");
    assert.equal(r.purchaseCalls[0].totalAmount, 364.98);
    assert.equal(r.purchaseCalls[0].groups.length, 2);

    assert.equal(r.expenses.length, 1);
    assert.equal(r.expenses[0].amount, 335.78);
    assert.equal(r.expenses[0].estimateId, "est-1");
    assert.equal(r.expenses[0].costCodeId, "cc-plumb", "falls back to the model's phase suggestion");
    assert.equal(r.expenses[0].qbPurchaseId, "QB-1");
    assert.equal(r.expenses[0].status, "Pending");
    assert.equal(r.expenses[0].receiptUrl, "https://drive.google.com/file/d/FILE123/view");

    assert.equal(r.intakeUpdates[0].state, "BOOKED");
    assert.equal(r.intakeUpdates[0].qbPurchaseId, "QB-1");
    assert.equal(r.events[0].kind, "receipt-push");
    assert.equal(r.events[0].source, "intake-worker");
});

test("an explicitly chosen cost code beats the model's suggestion", async () => {
    const r = recorder();
    await bookReceipt(row({ costCodeId: "cc-chosen" }), r.deps);
    assert.equal(r.expenses[0].costCodeId, "cc-chosen");
});

test("a non-drive row books under its intake id and stores the secure ref", async () => {
    const r = recorder();
    await bookReceipt(row({ source: "mobile", sourceRef: "mobile:abc", id: "intake-9" }), r.deps);
    assert.equal(r.purchaseCalls[0].fileId, "intake-9");
    assert.equal(r.expenses[0].receiptUrl, "secure:receipts/intake/intake-1.jpg");
});

test("a project with no estimate is terminal and spends NO attempt", async () => {
    const r = recorder({}, { estimates: [] });
    const result = await bookReceipt(row(), r.deps);
    assert.deepEqual(result, { outcome: "needs-review", reason: "no-estimate" });
    assert.equal(r.purchaseCalls.length, 0, "QuickBooks is never touched");
    assert.equal(r.expenses.length, 0);
});

test("the push kill switch and the pause switch defer without spending an attempt", async () => {
    const disabled = recorder({ isPushEnabled: () => false });
    assert.deepEqual(await bookReceipt(row(), disabled.deps), { outcome: "deferred", reason: "push-disabled" });
    assert.equal(disabled.purchaseCalls.length, 0);

    const paused = recorder({ isPushPaused: async () => true });
    assert.deepEqual(await bookReceipt(row(), paused.deps), { outcome: "deferred", reason: "push-paused" });
    assert.equal(paused.purchaseCalls.length, 0);
});

test("a dryRun row can never reach QuickBooks, even called directly", async () => {
    // The worker already refuses to route a dry-run row here. This second guard
    // exists because "no QBO calls in shadow mode" is the safety promise of the
    // whole phase, and one guard in one caller is not a promise.
    const r = recorder();
    const result = await bookReceipt(row({ dryRun: true }), r.deps);
    assert.equal(result.outcome, "deferred");
    assert.equal(r.purchaseCalls.length, 0);
    assert.equal(r.expenses.length, 0);
});

test("QBO business-rule faults are TERMINAL, never retried", async () => {
    const cases: [unknown, string][] = [
        [new QboPurchaseFaultError(400, "closed period", "6210"), "qbo-fault:6210"],
        [new QboAccountConfigError("bad account"), "qbo-fault:account-config"],
        [new QboVendorDuplicateError("Lowes"), "qbo-fault:vendor-duplicate"],
    ];
    for (const [error, reason] of cases) {
        const r = recorder({ createPurchase: async () => { throw error; } });
        const result = await bookReceipt(row(), r.deps);
        assert.deepEqual(result, { outcome: "needs-review", reason }, reason);
        assert.equal(r.expenses.length, 0);
    }
});

test("an ok:false result is a deterministic refusal, so it goes to a human too", async () => {
    const r = recorder({
        createPurchase: async () => ({ ok: false, reason: "docnumber-conflict", docNumber: "abc" }) as any,
    });
    assert.deepEqual(await bookReceipt(row(), r.deps), {
        outcome: "needs-review",
        reason: "qbo-fault:docnumber-conflict",
    });
});

test("a QBTimeoutError retries on the backoff schedule", async () => {
    const r = recorder({ createPurchase: async () => { throw new QBTimeoutError("timed out"); } });
    const first = await bookReceipt(row({ attempts: 0 }), r.deps);
    assert.equal(first.outcome, "retry");
    assert.equal((first as any).attempts, 1);
    assert.equal((first as any).nextRetryAt.getTime(), NOW.getTime() + 5 * 60_000);
    assert.equal((first as any).reason, "QBTimeoutError");

    const third = await bookReceipt(row({ attempts: 2 }), recorder({
        createPurchase: async () => { throw new QBTimeoutError("timed out"); },
    }).deps);
    assert.equal((third as any).nextRetryAt.getTime(), NOW.getTime() + 60 * 60_000);
});

test("a plain network error retries; past 20 attempts it stops and asks a human", async () => {
    const transient = recorder({ createPurchase: async () => { throw new TypeError("fetch failed"); } });
    assert.equal((await bookReceipt(row({ attempts: 5 }), transient.deps)).outcome, "retry");

    const exhausted = recorder({ createPurchase: async () => { throw new TypeError("fetch failed"); } });
    assert.deepEqual(await bookReceipt(row({ attempts: 20 }), exhausted.deps), {
        outcome: "needs-review",
        reason: "max-retries",
    });
});

test("alreadyExists books identically — the lost-response retry", async () => {
    const r = recorder({
        createPurchase: async (_t, input) => ({
            ok: true, qbPurchaseId: "QB-7", docNumber: input.fileId.slice(0, 21), alreadyExists: true,
        }) as any,
    });
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    assert.equal((result as any).alreadyExisted, true);
    assert.equal(r.expenses.length, 1);
    assert.equal(r.events[0].status, "already-exists");
});

test("an existing Expense for the same Purchase is reused, never duplicated", async () => {
    const r = recorder();
    (r.deps.db as any).expense.findUnique = async () => ({ id: "exp-existing" });
    const result = await bookReceipt(row(), r.deps);
    assert.equal((result as any).expenseId, "exp-existing");
    assert.equal(r.expenses.length, 0, "no second Expense row");
});

test("a DB failure AFTER the Purchase exists retries — the create is idempotent", async () => {
    const r = recorder();
    (r.deps.db as any).$transaction = async () => { throw new Error("connection reset"); };
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "retry");
});
