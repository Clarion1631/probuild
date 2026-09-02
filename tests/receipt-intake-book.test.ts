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
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    appliedTaxCents,
    attachmentBlocker,
    isTerminalAttachmentFailure,
    bookReceipt,
    buildGroups,
    driveFileIdOf,
    expenseAmountCents,
    MIN_BOOKING_BUDGET_MS,
    type BookableRow,
    type BookDependencies,
} from "../src/lib/receipt-intake/book";
import { QBTimeoutError } from "../src/lib/quickbooks";
import {
    QboAccountConfigError,
    QboPurchaseFaultError,
    QboVendorDuplicateError,
} from "../src/lib/qbo-receipt-push";

/**
 * A createPurchase stub that stands for a call which REACHED the create.
 *
 * createQBReceiptPurchase fires `onBeforeCreate` immediately before the HTTP
 * create and nowhere else, so whether a stub invokes it is the whole difference
 * between "QuickBooks may hold a Purchase" and "nothing was ever sent" — which
 * is what decides whether a parked row keeps its strong dedup key. Stubs
 * standing for a PRE-create refusal (an account or vendor ensure, an ok:false
 * decision) deliberately do not use this.
 */
function atCreate<T>(fn: (...args: any[]) => Promise<T>) {
    return async (tokens: any, input: any, deadline: any, onBeforeCreate?: () => Promise<void>) => {
        await onBeforeCreate?.();
        return fn(tokens, input, deadline);
    };
}

/**
 * A stub for the ALREADY-EXISTS branch, mirroring the real control flow.
 *
 * createQBReceiptPurchase returns there from the idempotency query and never
 * reaches qbCreateFn, so `onBeforeCreate` does NOT fire — only
 * `onExistingPurchase` does. A fake that called onBeforeCreate anyway would
 * mark the row "sent" and hide the very bug this branch had: a Purchase that
 * exists while the row believes nothing was ever sent.
 */
function atExisting<T>(fn: (...args: any[]) => Promise<T>) {
    return async (
        tokens: any,
        input: any,
        deadline: any,
        _onBeforeCreate?: () => Promise<void>,
        onExistingPurchase?: () => Promise<void>,
    ) => {
        await onExistingPurchase?.();
        return fn(tokens, input, deadline);
    };
}

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
        suggestedConfidence: 0.82,
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
        lastError: null,
        sendAttempted: false,
        fileSha256: "s".repeat(64),
        claimToken: "claim-1",
        ...overrides,
    };
}

interface Recorder {
    deps: BookDependencies;
    sendMarks: string[];
    purchaseCalls: any[];
    expenses: any[];
    intakeUpdates: any[];
    events: any[];
}

function recorder(
    overrides: Partial<BookDependencies> = {},
    opts: { estimates?: { id: string }[]; intakeStillBooking?: boolean } = {},
): Recorder {
    const intakeStillBooking = opts.intakeStillBooking !== false;
    const purchaseCalls: any[] = [];
    const sendMarks: string[] = [];
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
            // TWO fenced writes, in one transaction: the state fence
            // (`state: 'BOOKING'`) refuses when a human voided the row, and the
            // claim CAS (`claimToken`) refuses when the row was re-claimed.
            // `intakeStillBooking` lets a test say "somebody voided it while
            // QuickBooks was answering".
            updateMany: async (args: any) => {
                if (args.where?.state === "BOOKING" && !intakeStillBooking) return { count: 0 };
                intakeUpdates.push(args.data);
                return { count: 1 };
            },
        },
        $transaction: async (fn: any) => fn(tx),
    };

    const deps: BookDependencies = {
        db: tx as any,
        isPushEnabled: () => true,
        isPushPaused: async () => false,
        getTokens: async () => ({ accessToken: "t", realmId: "r" }) as any,
        createPurchase: atCreate(async (_tokens: any, input: any) => {
            purchaseCalls.push(input);
            return { ok: true, qbPurchaseId: "QB-1", docNumber: input.fileId.slice(0, 21), alreadyExists: false, attachment: "attached" };
        }) as any,
        downloadBytes: async () => ({ ok: true as const, bytes: Buffer.from("bytes") }),
        logEvent: async (event) => { events.push(event); },
        // The pre-send re-read (Codex blocker 5). The default says "still
        // BOOKING", i.e. nobody touched the row; a test that wants the abort
        // path overrides it.
        readState: async () => "BOOKING",
        now: () => NOW,
        companyTimeZone: async () => "America/Los_Angeles",
        isCostCodeAllowed: async () => true,
        markSendAttempted: async id => { sendMarks.push(id); return true; },
        ...overrides,
    };
    return { deps, sendMarks, purchaseCalls, expenses, intakeUpdates, events };
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

test("the Expense amount is the GROSS total, tax included, split or not", () => {
    // Justin's call (2026-09-01), overriding the plan's pre-tax wording: the
    // expenses already imported from QuickBooks record the gross line total, so
    // booking pre-tax here would put two meanings of `amount` in one table and
    // silently under-count every receipt this pipeline touched.
    const split = buildGroups("receipt", 36498, 2920, "82766");
    assert.equal(split.length, 2, "the QBO Purchase still splits the tax");
    assert.equal(expenseAmountCents(split, 36498), 36498);
    assert.equal(expenseAmountCents(buildGroups("receipt", 10000, null, "1"), 10000), 10000);
});

test("appliedTaxCents reports what POSTED, not what the model asked for", () => {
    assert.equal(appliedTaxCents(buildGroups("receipt", 36498, 2920, "82766")), 2920);
    // buildGroups rejects both of these, so the audit row must say 0 — the
    // filing report reconciles against the Purchase, not against the read.
    assert.equal(appliedTaxCents(buildGroups("check", 120000, 9000, "Check4178")), 0);
    assert.equal(appliedTaxCents(buildGroups("receipt", 10000, 20000, "1")), 0);
    assert.equal(appliedTaxCents(buildGroups("receipt", 10000, null, "1")), 0);
});

test("only a drive row books under the Drive file id", () => {
    assert.equal(driveFileIdOf({ source: "drive", sourceRef: "drive:FILE123" }), "FILE123");
    assert.equal(driveFileIdOf({ source: "mobile", sourceRef: "mobile:abc" }), null);
    assert.equal(driveFileIdOf({ source: "drive", sourceRef: "drive:" }), null);
});

test("a successful booking creates the Expense at the gross amount and marks the row BOOKED", async () => {
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
    assert.equal(r.expenses[0].amount, 364.98, "gross, tax included");
    assert.equal(r.expenses[0].estimateId, "est-1");
    assert.equal(r.expenses[0].costCodeId, "cc-plumb", "falls back to the model's phase suggestion");
    assert.equal(r.expenses[0].qbPurchaseId, "QB-1");
    assert.equal(r.expenses[0].status, "Pending");
    assert.equal(r.expenses[0].receiptUrl, "https://drive.google.com/file/d/FILE123/view");

    assert.equal(r.intakeUpdates[0].state, "BOOKED");
    assert.equal(r.intakeUpdates[0].qbPurchaseId, "QB-1");
    assert.equal(r.events[0].kind, "receipt-push");
    assert.equal(r.events[0].source, "intake-worker");
    assert.equal(r.events[0].amountCents, 36498);
    assert.equal(r.events[0].taxCents, 2920, "the tax that actually posted");
});

test("an explicitly chosen cost code beats the model's suggestion", async () => {
    const r = recorder();
    await bookReceipt(row({ costCodeId: "cc-chosen" }), r.deps);
    assert.equal(r.expenses[0].costCodeId, "cc-chosen");
});

test("a non-drive row books under its intake id and stores a resolvable reference", async () => {
    const r = recorder();
    await bookReceipt(row({ source: "mobile", sourceRef: "mobile:abc", id: "intake-9" }), r.deps);
    // The QBO identity still needs SOMETHING unique, and the intake id is it.
    assert.equal(r.purchaseCalls[0].fileId, "intake-9");
    // The Expense holds a stable reference — not a signed URL that expires, and
    // not a bare path that says nothing about which bucket it is in.
    assert.equal(r.expenses[0].receiptUrl, "receipt-intake://receipt-intake/receipts/intake/intake-1.jpg");
});

test("the audit event calls a DRIVE id fileId, and everything else intakeId", async () => {
    // `fileId` is dual-written into the typed `driveFileId` column, which the
    // cutover queries to decide whether v1 already booked a document. An intake
    // cuid there fills it with ids no Drive query can ever match.
    const mobile = recorder();
    await bookReceipt(row({ source: "mobile", sourceRef: "mobile:abc", id: "intake-9" }), mobile.deps);
    const mobileDetail = mobile.events[0].detail as Record<string, unknown>;
    assert.ok(!("fileId" in mobileDetail), "no Drive file exists for this row");
    assert.equal(mobileDetail.intakeId, "intake-9");

    const drive = recorder();
    await bookReceipt(row({ source: "drive", sourceRef: "drive:FILE9", id: "intake-9" }), drive.deps);
    const driveDetail = drive.events[0].detail as Record<string, unknown>;
    assert.equal(driveDetail.fileId, "FILE9", "a real Drive id, not the intake row id");
    assert.equal(driveDetail.intakeId, "intake-9", "and the row id is still carried");
});

test("a project with no estimate is terminal, spends NO attempt, and RELEASES the strong key", async () => {
    // Nothing was ever sent, so the row is holding a dedup key on behalf of a
    // document that never became a purchase. A corrected re-send of the same
    // receipt would be quarantined against it (v3.5 rule).
    const r = recorder({}, { estimates: [] });
    const result = await bookReceipt(row(), r.deps);
    assert.deepEqual(result, { outcome: "needs-review", reason: "no-estimate", releaseStrongKey: true });
    assert.equal(r.purchaseCalls.length, 0, "QuickBooks is never touched");
    assert.equal(r.expenses.length, 0);
});

test("every PRE-send refusal releases the key; every POST-send one holds it", async () => {
    // Pre-send: nothing exists in QuickBooks, so the key must go back.
    for (const [rowOverrides, reason] of [
        [{ projectId: null }, "no-estimate"],
        [{ totalCents: 0 }, "refund-or-zero"],
        [{ totalCents: -2257 }, "refund-or-zero"],
        [{ txnDate: null }, "invalid-date"],
    ] as const) {
        const r = recorder();
        const result = await bookReceipt(row(rowOverrides), r.deps);
        assert.deepEqual(result, { outcome: "needs-review", reason, releaseStrongKey: true }, reason);
        assert.equal(r.purchaseCalls.length, 0, reason);
    }

    // Post-send: QBO may hold a Purchase whose response we lost, so the key
    // stays claimed even though the row is parked.
    const faulted = recorder({
        createPurchase: atCreate(async () => { throw new QboPurchaseFaultError(400, "closed period", "6210"); }) as any,
    });
    const result = await bookReceipt(row(), faulted.deps);
    assert.equal((result as any).releaseStrongKey, false);
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
    // A fault raised by the PURCHASE create may have created one: QuickBooks
    // answered, and a lost response looks exactly like this. Key retained.
    const posted = recorder({
        createPurchase: atCreate(async () => {
            throw new QboPurchaseFaultError(400, "closed period", "6210");
        }) as any,
    });
    assert.deepEqual(await bookReceipt(row(), posted.deps), {
        outcome: "needs-review", reason: "qbo-fault:6210", releaseStrongKey: false,
    });

    // The ENSURES — resolving the expense account, creating the vendor — run
    // BEFORE the create, so nothing was posted and the strong key goes back.
    // This is what moving the fenced send mark to the create bought: these two
    // used to quarantine the corrected re-submission against a booking that
    // never happened.
    const preCreate: [unknown, string][] = [
        [new QboAccountConfigError("bad account"), "qbo-fault:account-config"],
        [new QboVendorDuplicateError("Lowes"), "qbo-fault:vendor-duplicate"],
    ];
    for (const [error, reason] of preCreate) {
        const r = recorder({ createPurchase: async () => { throw error; } });
        const result = await bookReceipt(row(), r.deps);
        assert.deepEqual(result, { outcome: "needs-review", reason, releaseStrongKey: true }, reason);
        assert.deepEqual(r.sendMarks, [], "the create was never reached");
        assert.equal(r.expenses.length, 0);
    }
});

test("EVERY ok:false happens before the create, so all of them RELEASE the key", async () => {
    // The list is exhaustive on purpose: project-not-matched, missing-vendor,
    // invalid-date, amount-mismatch, duplicate-name and the overhead cases are
    // all decided before qbCreateFn runs, and docnumber-conflict is the
    // idempotency QUERY finding somebody ELSE'S Purchase. So no Purchase exists
    // for this row, and holding the strong key would quarantine the corrected
    // re-submission against a booking that never happened.
    const reasons = [
        "docnumber-conflict", "project-not-matched", "missing-vendor", "invalid-date",
        "amount-mismatch", "duplicate-name", "invalid-group-amount",
        "overhead-account-not-matched", "overhead-tax-unsupported",
    ];
    for (const reason of reasons) {
        const r = recorder({ createPurchase: async () => ({ ok: false, reason }) as any });
        assert.deepEqual(await bookReceipt(row(), r.deps), {
            outcome: "needs-review",
            reason: `qbo-fault:${reason}`,
            releaseStrongKey: true,
        }, reason);
        assert.equal(r.expenses.length, 0, reason);
    }
});

// ── Never a Purchase without its receipt ON it (round-3 gate, item 4) ───────

test("a format QBO cannot attach is refused BEFORE the Purchase is created", async () => {
    // The QBO core returns ok:true with attachment:"skipped" for these, and the
    // old code marked that BOOKED — a Purchase in the real books with no
    // receipt, which a bookkeeper cannot spot because it looks complete. Every
    // accepted .txt receipt hit this.
    const r = recorder();
    const result = await bookReceipt(row({ mimeType: "text/plain" }), r.deps);
    assert.equal(result.outcome, "needs-review");
    assert.match((result as any).reason, /^unsupported-attachment:mime:text\/plain/);
    assert.equal((result as any).releaseStrongKey, true, "nothing was sent");
    assert.equal(r.purchaseCalls.length, 0, "no Purchase is created");
});

test("a file over QBO's 8MB attachment ceiling is refused before the create", async () => {
    // Our intake ceiling is 15MB and QBO's attachment ceiling is 8MB, so this
    // gap is reachable by a real phone photo.
    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    const r = recorder({ downloadBytes: async () => ({ ok: true, bytes: big }) });
    const result = await bookReceipt(row(), r.deps);
    assert.match((result as any).reason, /^unsupported-attachment:size:/);
    assert.equal(r.purchaseCalls.length, 0);
});

test("attachmentBlocker mirrors QBO's own ceilings", () => {
    assert.equal(attachmentBlocker("image/jpeg", 1000), null);
    assert.equal(attachmentBlocker("application/pdf", 1000), null);
    assert.equal(attachmentBlocker("image/heic", 1000), null);
    assert.equal(attachmentBlocker("image/jpeg; charset=binary", 1000), null, "parameters are stripped");
    assert.match(attachmentBlocker("text/plain", 1000)!, /^mime:/);
    assert.match(attachmentBlocker("image/tiff", 1000)!, /^mime:/);
    // Exactly 8MB is allowed; one byte more is not.
    assert.equal(attachmentBlocker("image/jpeg", 8 * 1024 * 1024), null);
    assert.match(attachmentBlocker("image/jpeg", 8 * 1024 * 1024 + 1)!, /^size:/);
});

test("an attachment upload that FAILED is retried, never reported as booked", async () => {
    const r = recorder({
        createPurchase: atCreate(async () => ({
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: false, attachment: "failed:500",
        })) as any,
    });
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "retry");
    assert.match((result as any).reason, /^attachment-failed:failed:500/);
    assert.equal(r.expenses.length, 0, "no Expense until the receipt is actually on the Purchase");
});

test("an EXISTING purchase is held to the SAME attachment standard", async () => {
    // This is the path that matters: it is reached by every retry after a lost
    // response — exactly when a Purchase is most likely to be sitting in the
    // books without its image. It was the one path exempt from the check.
    const failing = recorder({
        createPurchase: atExisting(async () => ({
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "failed:500",
        })) as any,
    });
    const failed = await bookReceipt(row(), failing.deps);
    assert.equal(failed.outcome, "retry", "an upload fault on an existing Purchase is recoverable");
    assert.equal(failing.expenses.length, 0, "and it is NOT booked meanwhile");

    const skipped = recorder({
        createPurchase: atExisting(async () => ({
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "skipped",
        })) as any,
    });
    const skippedResult = await bookReceipt(row(), skipped.deps);
    assert.equal(skippedResult.outcome, "needs-review");
    assert.equal((skippedResult as any).reason, "unsupported-attachment:skipped");
    assert.equal(skipped.expenses.length, 0);
});

test("a previous attachment failure does NOT block the recovery attempt", async () => {
    // The QBO core re-checks and re-uploads the file for an existing Purchase
    // (ensureAttachmentOnExistingPurchase), so the retry IS the recovery.
    // Short-circuiting on lastError made the stranded-receipt case permanent —
    // the opposite of what the guard was for.
    const r = recorder({
        createPurchase: atExisting(async (_t: any, input: any) => {
            r.purchaseCalls.push(input);
            return { ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "already-attached" } as any;
        }) as any,
    });
    const result = await bookReceipt(row({ lastError: "attachment-failed:failed:500" }), r.deps);
    assert.equal(result.outcome, "booked", "the recovery succeeded and the row books");
    assert.equal(r.purchaseCalls.length, 1, "the recovery attempt actually happened");
    assert.equal(r.expenses.length, 1);
});

test("already-attached counts as attached on the fresh-create path too", async () => {
    const r = recorder({
        createPurchase: atCreate(async () => ({
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: false, attachment: "already-attached",
        })) as any,
    });
    assert.equal((await bookReceipt(row(), r.deps)).outcome, "booked");
});

test("a QBTimeoutError retries on the backoff schedule", async () => {
    const r = recorder({ createPurchase: atCreate(async () => { throw new QBTimeoutError("timed out"); }) as any });
    const first = await bookReceipt(row({ attempts: 0 }), r.deps);
    assert.equal(first.outcome, "retry");
    assert.equal((first as any).attempts, 1);
    assert.equal((first as any).nextRetryAt.getTime(), NOW.getTime() + 5 * 60_000);
    assert.equal((first as any).reason, "QBTimeoutError");

    const third = await bookReceipt(row({ attempts: 2 }), recorder({
        createPurchase: atCreate(async () => { throw new QBTimeoutError("timed out"); }) as any,
    }).deps);
    assert.equal((third as any).nextRetryAt.getTime(), NOW.getTime() + 60 * 60_000);
});

test("a plain network error retries; MAX_BOOK_ATTEMPTS means 20 attempts in TOTAL", async () => {
    const transient = recorder({ createPurchase: atCreate(async () => { throw new TypeError("fetch failed"); }) as any });
    assert.equal((await bookReceipt(row({ attempts: 5 }), transient.deps)).outcome, "retry");

    // row.attempts 18 -> this is attempt 19: still retryable.
    const nearly = recorder({ createPurchase: atCreate(async () => { throw new TypeError("fetch failed"); }) as any });
    assert.equal((await bookReceipt(row({ attempts: 18 }), nearly.deps)).outcome, "retry");

    // row.attempts 19 -> this is attempt 20, the last one the constant allows.
    // sendAttempted is what decides the key, not the fact of reaching the limit.
    const exhausted = recorder({ createPurchase: atCreate(async () => { throw new TypeError("fetch failed"); }) as any });
    assert.deepEqual(await bookReceipt(row({ attempts: 19, sendAttempted: true }), exhausted.deps), {
        outcome: "needs-review",
        reason: "max-retries",
        // A send HAS been attempted, so QBO may hold a Purchase: keep the key.
        releaseStrongKey: false,
    });

    // ...and a row that burned all 20 attempts WITHOUT ever reaching QuickBooks
    // (storage faults, say) created no Purchase, so its key must go back.
    const neverSent = recorder({
        downloadBytes: async () => ({ ok: false, kind: "transient", message: "ECONNRESET" }),
    });
    assert.deepEqual(await bookReceipt(row({ attempts: 19, sendAttempted: false }), neverSent.deps), {
        outcome: "needs-review",
        reason: "max-retries",
        releaseStrongKey: true,
    });
});

test("alreadyExists books identically — the lost-response retry", async () => {
    const r = recorder({
        createPurchase: atExisting(async (_t: any, input: any) => ({
            ok: true, qbPurchaseId: "QB-7", docNumber: input.fileId.slice(0, 21),
            alreadyExists: true, attachment: "already-attached",
        })) as any,
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

// ── Never a Purchase without its receipt (Codex round 3, item 3) ────────────

test("a MISSING receipt file refuses the booking outright", async () => {
    // Booking with `fileBase64: undefined` produced a QBO Purchase with no
    // attachment — the one failure the bookkeeper cannot fix later, because the
    // Purchase looks complete and nothing flags it. The receipt IS the evidence
    // for the expense.
    const r = recorder({ downloadBytes: async () => ({ ok: false, kind: "missing" }) });
    const result = await bookReceipt(row(), r.deps);
    assert.deepEqual(result, {
        outcome: "needs-review",
        reason: "receipt-bytes-missing",
        // Pre-send: nothing reached QuickBooks, so the key goes back for a
        // corrected re-upload.
        releaseStrongKey: true,
    });
    assert.equal(r.purchaseCalls.length, 0, "QuickBooks is never touched");
    assert.equal(r.expenses.length, 0);
});

test("a TRANSIENT storage fault retries instead of parking a good receipt", async () => {
    const r = recorder({
        downloadBytes: async () => ({ ok: false, kind: "transient", message: "ECONNRESET" }),
    });
    const result = await bookReceipt(row({ attempts: 1 }), r.deps);
    assert.equal(result.outcome, "retry");
    assert.match((result as any).reason, /^storage:/);
    assert.equal(r.purchaseCalls.length, 0);
});

test("the receipt bytes always ride along with the Purchase", async () => {
    const r = recorder();
    await bookReceipt(row(), r.deps);
    assert.equal(r.purchaseCalls[0].fileBase64, Buffer.from("bytes").toString("base64"));
    assert.equal(r.purchaseCalls[0].fileContentType, "image/jpeg");
});

test("a void between the claim and the send ABORTS — QBO is never called", async () => {
    // Everything before the send takes real time (a project lookup, a file
    // download), and a human on the Receipts tab can void the row in that
    // window. QBO is read-only from here: a Purchase created for a cancelled
    // receipt cannot be taken back.
    const { deps, purchaseCalls, intakeUpdates } = recorder({ readState: async () => "VOID" });
    const result = await bookReceipt(row(), deps);
    assert.equal(result.outcome, "aborted");
    assert.match((result as { reason: string }).reason, /state-changed:VOID/);
    assert.deepEqual(purchaseCalls, [], "nothing was sent");
    assert.deepEqual(intakeUpdates, [], "and nothing overwrote the human's decision");
});

test("a row that vanished mid-flight also aborts rather than booking", async () => {
    const { deps, purchaseCalls } = recorder({ readState: async () => null });
    const result = await bookReceipt(row(), deps);
    assert.equal(result.outcome, "aborted");
    assert.match((result as { reason: string }).reason, /state-changed:missing/);
    assert.deepEqual(purchaseCalls, []);
});

test("the normal path is unaffected: still BOOKING means send", async () => {
    const { deps, purchaseCalls } = recorder({ readState: async () => "BOOKING" });
    const result = await bookReceipt(row(), deps);
    assert.equal(result.outcome, "booked");
    assert.equal(purchaseCalls.length, 1);
});

// ── Expense.date is a business calendar day (round-6 item 3) ────────────────

test("Expense.date is re-anchored to the company's local midnight", async () => {
    // txnDate is a @db.Date column and round-trips as UTC midnight. Written
    // straight into Expense.date (a full timestamp) that records 5pm the
    // PREVIOUS day in Pacific, and every job-cost or variance report bounded by
    // local midnight then counts the expense in the wrong period.
    const r = recorder();
    await bookReceipt(row({ txnDate: new Date("2026-08-03T00:00:00.000Z") }), r.deps);

    const written = r.expenses[0].date as Date;
    assert.equal(written.toISOString(), "2026-08-03T07:00:00.000Z", "local midnight PDT");

    // The assertion that matters: read back in the company zone it is the 3rd.
    const localDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(written);
    assert.equal(localDay, "2026-08-03");

    // Control: the raw txnDate would have read as the 2nd. That was the bug.
    assert.equal(
        new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date("2026-08-03T00:00:00.000Z")),
        "2026-08-02",
    );

    // ...and QBO still gets the bare calendar day, unchanged.
    assert.equal(r.purchaseCalls[0].date, "2026-08-03");
});

test("winter dates use the winter offset — no hardcoded -07:00", async () => {
    const r = recorder();
    await bookReceipt(row({ txnDate: new Date("2026-01-15T00:00:00.000Z") }), r.deps);
    assert.equal((r.expenses[0].date as Date).toISOString(), "2026-01-15T08:00:00.000Z");
});

// ── A booking must not start without room to finish (round-6 item 4) ────────

test("a booking with less than 25s of runway DEFERS instead of starting", async () => {
    // Two QuickBooks round trips plus the attachment upload and the commit do
    // not fit in a few seconds, and a booking cut off mid-flight is the worst
    // outcome available: the Purchase may exist in the real books while the row
    // never learns it did.
    // An absolute deadline that is already nearly spent.
    const r = recorder({ deadline: { startedAt: Date.now() - 50_000, budgetMs: 55_000 } });
    const result = await bookReceipt(row(), r.deps);
    assert.deepEqual(result, { outcome: "deferred", reason: "out-of-budget" });
    assert.equal(r.purchaseCalls.length, 0, "QuickBooks is never touched");
    assert.equal(r.expenses.length, 0);
});

test("the runway check spends no attempt — the document did nothing wrong", async () => {
    const r = recorder({ deadline: { startedAt: Date.now() - 60_000, budgetMs: 55_000 } });
    const result = await bookReceipt(row({ attempts: 3 }), r.deps);
    assert.equal(result.outcome, "deferred");
    assert.ok(!("attempts" in result), "not a retry, so no attempt is spent");
});

test("ample runway books normally, and threads ONE deadline into both QBO calls", async () => {
    const seen: unknown[] = [];
    const deadline = { startedAt: Date.now(), budgetMs: 55_000 };
    const r = recorder({
        deadline,
        getTokens: async d => { seen.push(d); return { accessToken: "t", realmId: "r" } as any; },
        createPurchase: atCreate(async (_t: any, input: any, d: any) => {
            seen.push(d);
            r.purchaseCalls.push(input);
            return { ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: false, attachment: "attached" } as any;
        }) as any,
    });
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    assert.equal(seen.length, 2);
    assert.strictEqual(seen[0], seen[1], "the SAME deadline object, so a slow refresh shortens the create");
    assert.strictEqual(seen[0], deadline, "and it is the INVOCATION's deadline, not a fresh one");
});

test("MIN_BOOKING_BUDGET_MS is the documented 25s", () => {
    assert.equal(MIN_BOOKING_BUDGET_MS, 25_000);
});

// ── The phase is re-validated against the FINAL project (Phase 3 gate, a) ───

test("a cost code that is not a phase of THIS job is cleared, and the row still books", async () => {
    // The scenario: the receipt was READ while it had no project (NEEDS_JOB) or
    // a different one, and a human then assigned the real job. A cost code from
    // the old project is not a phase of the new one, and posting against it puts
    // real money on a phase that job does not have — which every variance report
    // reads as overspend on a line nobody budgeted.
    const r = recorder({ isCostCodeAllowed: async () => false });
    const result = await bookReceipt(row({ costCodeId: "cc-from-another-job" }), r.deps);

    assert.equal(result.outcome, "booked", "the receipt is fine — it books UNCODED");
    assert.equal(r.expenses[0].costCodeId, null, "the wrong phase is cleared, never posted");
    assert.match(r.expenses[0].description, /phase cleared \(not a phase of this job\)/);
    assert.equal(r.events[0].detail.phaseRejected, "cc-from-another-job", "and it is auditable");
});

test("the SUGGESTED code is checked against the final project too", async () => {
    // The model suggested it from the phase list of whatever project the row had
    // at READ time. That list is not authority over the project it books to.
    const asked: Array<[string, string]> = [];
    const r = recorder({
        isCostCodeAllowed: async (projectId, costCodeId) => {
            asked.push([projectId, costCodeId]);
            return false;
        },
    });
    await bookReceipt(row({ costCodeId: null }), r.deps);
    // TWICE: once immediately before the QBO create, once immediately before
    // the Expense write. The create is a network round trip, and a project
    // reassignment that lands in between must not reach job cost.
    assert.deepEqual(asked, [["proj-1", "cc-plumb"], ["proj-1", "cc-plumb"]]);
    assert.equal(r.expenses[0].costCodeId, null);
});

test("the phase is re-checked AFTER the create, not just before it", async () => {
    // The window that matters is the one around the money write. This proves
    // the second check is real: the same row, answered differently the second
    // time, must produce the LATER answer.
    let call = 0;
    const r = recorder({
        isCostCodeAllowed: async () => {
            call++;
            return call === 1; // allowed before the send, revoked after it
        },
    });
    await bookReceipt(row({ costCodeId: "cc-demo" }), r.deps);
    assert.equal(call, 2, "asked on both sides of the create");
    assert.equal(r.expenses[0].costCodeId, null, "the post-create answer wins");
    assert.match(r.expenses[0].description, /phase cleared/);
});

test("unassigned during READ, assigned before BOOKING: the phase is re-checked", async () => {
    // End to end for the exact sequence the gate named.
    const allowedByProject: Record<string, string[]> = {
        "proj-1": ["cc-demo"], // the job it was finally assigned to
    };
    const r = recorder({
        isCostCodeAllowed: async (projectId, costCodeId) =>
            (allowedByProject[projectId] ?? []).includes(costCodeId),
    });

    // Suggested "cc-plumb" while unassigned; the job it landed on has no plumbing phase.
    await bookReceipt(row({ costCodeId: null, suggestedCostCodeId: "cc-plumb" }), r.deps);
    assert.equal(r.expenses[0].costCodeId, null, "the stale suggestion does not survive");

    // A code that IS a phase of the final project is kept.
    const ok = recorder({
        isCostCodeAllowed: async (projectId, costCodeId) =>
            (allowedByProject[projectId] ?? []).includes(costCodeId),
    });
    await bookReceipt(row({ costCodeId: "cc-demo" }), ok.deps);
    assert.equal(ok.expenses[0].costCodeId, "cc-demo");
});

// ── Confidence rides through to the booking (Phase 3 gate, b) ──────────────

test("the phase-suggestion confidence is recorded when the suggestion is used", async () => {
    const r = recorder();
    await bookReceipt(row({ costCodeId: null, suggestedConfidence: 0.42 }), r.deps);
    assert.equal(r.expenses[0].costCodeId, "cc-plumb");
    assert.match(r.expenses[0].description, /phase suggested \(confidence 0\.42\)/);
    assert.equal(r.events[0].detail.suggestedConfidence, 0.42);
});

test("a human's explicit pick is not labelled a suggestion", async () => {
    const r = recorder();
    await bookReceipt(row({ costCodeId: "cc-chosen" }), r.deps);
    assert.equal(r.expenses[0].costCodeId, "cc-chosen");
    assert.ok(!/phase suggested/.test(r.expenses[0].description));
    assert.equal(r.events[0].detail.suggestedConfidence, undefined);
});

// ── sendAttempted is marked at the LAST possible moment (round-8 item 4) ────

test("a token failure leaves sendAttempted UNSET, so the key is released", async () => {
    // Marking before the token refresh meant a refresh that threw left
    // sendAttempted=true on a row that never reached QuickBooks — and its
    // strong key was then held forever against a Purchase that does not exist.
    const r = recorder({
        getTokens: async () => { throw new Error("QBNotConnectedError"); },
    });
    const result = await bookReceipt(row({ attempts: 19 }), r.deps);
    assert.deepEqual(r.sendMarks, [], "never marked — nothing was sent");
    assert.equal(result.outcome, "needs-review");
    assert.equal((result as any).reason, "max-retries");
    assert.equal((result as any).releaseStrongKey, true, "so the key goes back");
});

test("budget exhausted AFTER the token refresh also leaves it unset", async () => {
    // The final runway check sits between the tokens and the create. A deferral
    // there must not look like an attempted send.
    const deadline = { startedAt: Date.now(), budgetMs: 55_000 };
    const r = recorder({
        deadline,
        getTokens: async () => {
            // Burn the remaining budget during the refresh.
            deadline.startedAt = Date.now() - 60_000;
            return { accessToken: "t", realmId: "r" } as any;
        },
    });
    const result = await bookReceipt(row(), r.deps);
    assert.deepEqual(result, { outcome: "deferred", reason: "out-of-budget" });
    assert.deepEqual(r.sendMarks, [], "never marked");
    assert.equal(r.purchaseCalls.length, 0);
});

test("a real create DOES mark it, before the call", async () => {
    const order: string[] = [];
    const r = recorder({
        createPurchase: atCreate(async (_t: any, input: any) => {
            order.push("create");
            r.purchaseCalls.push(input);
            return { ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: false, attachment: "attached" } as any;
        }) as any,
        markSendAttempted: async (id: string) => { order.push("mark"); r.sendMarks.push(id); return true; },
    });
    await bookReceipt(row(), r.deps);
    assert.deepEqual(order, ["mark", "create"], "marked FIRST, so a mid-create death still records it");
    assert.deepEqual(r.sendMarks, ["intake-1"]);
});

test("a void that lands AFTER the send parks the orphaned Purchase for a human", async () => {
    // The pre-send re-read narrows this window but cannot close it: QuickBooks
    // takes real time to answer, and the money exists the moment it does. QBO
    // is read-only from this pipeline, so nothing here can take it back.
    const { deps, purchaseCalls, intakeUpdates, events, expenses } = recorder({}, { intakeStillBooking: false });
    const result = await bookReceipt(row(), deps);

    assert.equal(result.outcome, "booked-after-void");
    assert.equal((result as { qbPurchaseId: string }).qbPurchaseId, "QB-1");
    assert.equal(purchaseCalls.length, 1, "the send did happen — that is the whole problem");

    // BOTH TABLES. The Expense create used to run before the fence, so a void
    // still polluted job costs with a purchase somebody had cancelled.
    assert.deepEqual(expenses, [], "no Expense may be written for a voided row");

    const parked = intakeUpdates.find(u => u.stateReason === "booked-after-void");
    assert.ok(parked, "the row must record what happened");
    assert.equal(parked.postVoidQbPurchaseId, "QB-1");
    // NOT qbPurchaseId: that column means "this row is booked", and it is not.
    assert.equal(parked.qbPurchaseId, undefined);
    assert.equal(parked.state, undefined, "the human's state is never overwritten");
    assert.equal(parked.bookedAt, undefined);

    assert.ok(events.some(e => e.status === "booked-after-void"), "and it must be auditable");
});

test("the fence does not fire on the normal path — and the Expense IS written", async () => {
    const { deps, intakeUpdates, expenses } = recorder();
    const result = await bookReceipt(row(), deps);
    assert.equal(result.outcome, "booked");
    assert.equal(expenses.length, 1);
    assert.ok(intakeUpdates.some(u => u.state === "BOOKED"));
    assert.ok(intakeUpdates.some(u => u.expenseId), "and linked back onto the intake");
    assert.ok(!intakeUpdates.some(u => u.stateReason === "booked-after-void"));
});

// ── An attachment QBO REFUSED is terminal (round-9 item 5) ─────────────────

test("a 4xx or fault attachment failure goes to a human on the FIRST one", async () => {
    // Retrying a file QuickBooks refused changes nothing except how long the
    // Purchase sits in the books without its receipt.
    for (const attachment of ["failed:400", "failed:413", "failed:415", "failed:fault"]) {
        const r = recorder({
            createPurchase: atCreate(async () => ({
                ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: false, attachment,
            })) as any,
        });
        const result = await bookReceipt(row(), r.deps);
        assert.equal(result.outcome, "needs-review", attachment);
        assert.equal((result as any).reason, `attachment-refused:${attachment}`);
        // The Purchase EXISTS, so the key is retained either way.
        assert.equal((result as any).releaseStrongKey, false, attachment);
        assert.equal(r.expenses.length, 0, attachment);
    }
});

test("a 5xx or thrown attachment failure is still retried", async () => {
    for (const attachment of ["failed:500", "failed:502", "failed:AbortError", "failed:TypeError"]) {
        const r = recorder({
            createPurchase: atCreate(async () => ({
                ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: false, attachment,
            })) as any,
        });
        const result = await bookReceipt(row(), r.deps);
        assert.equal(result.outcome, "retry", attachment);
    }
});

test("isTerminalAttachmentFailure splits refusal from blip", () => {
    for (const t of ["failed:400", "failed:404", "failed:413", "failed:499", "failed:fault"]) {
        assert.equal(isTerminalAttachmentFailure(t), true, t);
    }
    for (const t of ["failed:500", "failed:503", "failed:AbortError", "failed:unknown"]) {
        assert.equal(isTerminalAttachmentFailure(t), false, t);
    }
});

// ── retry() must read the CURRENT send flag (round-9 item 2) ───────────────

test("attempt 20 RETAINS the key when the failure was at the create", async () => {
    const r = recorder({ createPurchase: atCreate(async () => { throw new TypeError("fetch failed"); }) as any });
    const result = await bookReceipt(row({ attempts: 19, sendAttempted: false }), r.deps);
    assert.equal((result as any).reason, "max-retries");
    // row.sendAttempted was false when the row was CLAIMED, but this attempt
    // reached the create — so QBO may hold a Purchase and the key must stay.
    assert.equal((result as any).releaseStrongKey, false, "the CURRENT send flag decides");
    assert.deepEqual(r.sendMarks, ["intake-1"]);
});

test("attempt 20 RETAINS the key when the failure was at the attachment leg", async () => {
    const r = recorder({
        createPurchase: atCreate(async () => ({
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: false, attachment: "failed:500",
        })) as any,
    });
    const result = await bookReceipt(row({ attempts: 19, sendAttempted: false }), r.deps);
    assert.equal((result as any).reason, "max-retries");
    assert.equal((result as any).releaseStrongKey, false, "the Purchase exists");
});

test("attempt 20 RETAINS the key when the POST-create DB write failed", async () => {
    const r = recorder();
    (r.deps.db as any).$transaction = async () => { throw new Error("connection reset"); };
    const result = await bookReceipt(row({ attempts: 19, sendAttempted: false }), r.deps);
    assert.equal((result as any).reason, "max-retries");
    assert.equal((result as any).releaseStrongKey, false, "the Purchase exists even though the row does not know");
});

test("attempt 20 RELEASES the key only when nothing was ever sent", async () => {
    const r = recorder({
        downloadBytes: async () => ({ ok: false, kind: "transient", message: "ECONNRESET" }),
    });
    const result = await bookReceipt(row({ attempts: 19, sendAttempted: false }), r.deps);
    assert.equal((result as any).reason, "max-retries");
    assert.equal((result as any).releaseStrongKey, true);
    assert.deepEqual(r.sendMarks, [], "never reached the create");
});

// ── A superseded worker sends nothing (Phase 2 gate) ──────────────────────

test("a STALE claim aborts BEFORE the QBO create", async () => {
    // The zombie case: an invocation killed mid-booking resumes after its row
    // has been re-claimed. markSendAttempted is a CAS on the claim, so it
    // affects zero rows — and the booking stops THERE, having sent nothing.
    // Posting a Purchase the live worker is also about to post is the
    // double-booking this whole mechanism exists to prevent.
    const r = recorder({ markSendAttempted: async () => false });
    const result = await bookReceipt(row(), r.deps);

    assert.deepEqual(result, { outcome: "stale" });
    assert.equal(r.purchaseCalls.length, 0, "QuickBooks is never called");
    assert.equal(r.expenses.length, 0, "no Expense");
    assert.deepEqual(r.intakeUpdates, [], "and no state write at all");
});

test("the send fence receives the row's OWN claim token", async () => {
    const seen: Array<string | null> = [];
    const r = recorder({
        markSendAttempted: async (_id, token) => { seen.push(token); return true; },
    });
    await bookReceipt(row({ claimToken: "token-xyz" }), r.deps);
    assert.deepEqual(seen, ["token-xyz"]);
});

test("losing the claim DURING the commit rolls back and reports stale", async () => {
    // The window between the create and the commit. The Purchase exists, so
    // the successor's retry hits alreadyExists and books it once, under one
    // owner — but THIS worker must not complete a BOOKED write.
    const r = recorder();
    // The STATE fence passes (nobody voided it) and the CLAIM CAS fails
    // (somebody re-claimed it). Zeroing both would be the VOID case, which is
    // booked-after-void, not stale — they are different failures.
    let calls = 0;
    (r.deps.db as any).receiptIntake.updateMany = async () => ({ count: ++calls === 1 ? 1 : 0 });
    const result = await bookReceipt(row(), r.deps);

    assert.deepEqual(result, { outcome: "stale" });
    assert.equal(calls, 2, "the claim CAS is a second write, after the Expense");
    assert.equal(r.purchaseCalls.length, 1, "the create did happen");
    assert.equal(r.events.length, 0, "but nothing is logged as booked");
});

test("the BOOKED write is a CAS on state AND token", async () => {
    // BOTH, but as two writes in one transaction, and it has to be two: the
    // first write moves the row to BOOKED, so a second one re-asserting
    // `state: 'BOOKING'` would fail on this transaction's OWN uncommitted
    // write, every time. So the state fence goes first (a void loses there, and
    // is parked as booked-after-void) and the claim CAS follows (a re-claim
    // loses there, and rolls the whole thing back as stale).
    const wheres: any[] = [];
    const r = recorder();
    (r.deps.db as any).receiptIntake.updateMany = async (args: any) => {
        wheres.push(args.where);
        return { count: 1 };
    };
    await bookReceipt(row({ claimToken: "token-abc" }), r.deps);
    assert.deepEqual(wheres, [
        { id: "intake-1", state: "BOOKING" },
        { id: "intake-1", claimToken: "token-abc" },
    ]);
});

// ── A Purchase found by the idempotency query is still a Purchase ───────────

test("the already-exists branch does NOT go through onBeforeCreate", async () => {
    // The control for every test below: if the fake called onBeforeCreate here
    // the row would look "sent" for the wrong reason and the bug would be
    // invisible. The real core returns from the idempotency query.
    const seen: string[] = [];
    const r = recorder({
        createPurchase: async (_t: any, _i: any, _d: any, onBeforeCreate: any, onExisting: any) => {
            seen.push("create-called");
            await onExisting?.();
            void onBeforeCreate;
            return { ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "already-attached" } as any;
        },
    });
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    assert.deepEqual(seen, ["create-called"]);
    assert.deepEqual(r.sendMarks, ["intake-1"], "the EXISTING-purchase hook marked it, fenced the same way");
});

test("attempt 20 on an ALREADY-EXISTING purchase retains the strong key", async () => {
    // The hole: this path never reaches the create, so `sendAttempted` stayed
    // false — and a row that exhausted its retries here handed its dedup key
    // back while a real Purchase sat in the books. The next submission of the
    // same receipt would then book it a second time.
    const r = recorder({
        createPurchase: atExisting(async () => ({
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "failed:500",
        })) as any,
    });
    const result = await bookReceipt(row({ attempts: 19, sendAttempted: false }), r.deps);
    assert.equal((result as any).reason, "max-retries");
    assert.equal((result as any).releaseStrongKey, false, "the Purchase EXISTS");
    assert.deepEqual(r.sendMarks, ["intake-1"], "and the flag was persisted, not just held in memory");
});

test("a terminal attachment refusal on an existing purchase also retains the key", async () => {
    const r = recorder({
        createPurchase: atExisting(async () => ({
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "failed:415",
        })) as any,
    });
    const result = await bookReceipt(row(), r.deps);
    assert.equal((result as any).reason, "attachment-refused:failed:415");
    assert.equal((result as any).releaseStrongKey, false);
});

test("a STALE claim on the existing-purchase hook aborts, exactly like the create hook", async () => {
    const r = recorder({
        markSendAttempted: async () => false,
        createPurchase: atExisting(async () => ({
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "already-attached",
        })) as any,
    });
    assert.deepEqual(await bookReceipt(row(), r.deps), { outcome: "stale" });
    assert.equal(r.expenses.length, 0, "a superseded worker books nothing");
});

test("the QBO core fires onExistingPurchase before it touches the attachment", () => {
    // Ordering matters: the attachment re-check is a round trip that can fail,
    // and the caller still has to know a Purchase is there.
    const source = readFileSync(
        path.join(__dirname, "..", "src/lib/qbo-receipt-push.ts"),
        "utf8",
    );
    const branch = source.slice(source.indexOf("if (existing.length > 0) {"));
    const body = branch.slice(0, branch.indexOf("alreadyExists: true"));
    assert.match(body, /await deps\.onExistingPurchase\?\.\(\);/);
    assert.ok(
        body.indexOf("onExistingPurchase") < body.indexOf("ensureAttachmentOnExistingPurchase"),
        "the signal precedes the attachment work",
    );
    // And the create hook is NOT fired on this path.
    assert.ok(!body.includes("onBeforeCreate"), "onBeforeCreate belongs to the create path only");
});
