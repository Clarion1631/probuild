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
    reconcileExistingExpense,
    type BookableRow,
    type BookDependencies,
} from "../src/lib/receipt-intake/book";
// The ONE vendor comparison — the same function the identity check uses.
import { normalizeVendorName } from "../src/lib/qbo-receipt-push";
import {
    phaseConfidenceMin,
    phaseSuggestionIsConfident,
    RECEIPT_PHASE_CONFIDENCE_MIN,
} from "../src/lib/receipt-intake/intake-core";
import { QBO_PURCHASE_MISMATCH_PREFIX } from "../src/lib/receipt-intake/book";
import { finalizeDisposition, RECOVERABLE_PARK_REASONS } from "../src/lib/receipt-intake/stored-object";
import { startOfDateInTimeZone } from "../src/lib/tz-date";
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

/**
 * "QuickBooks holds this Purchase and it says what this document says."
 *
 * Every already-exists stub carries one, because the real
 * createQBReceiptPurchase always does — and the difference between `match` and
 * anything else decides whether an Expense is written from the read at all.
 */
const BOOKS_AGREE = {
    verdict: "match" as const,
    differences: [] as string[],
    booked: {
        totalAmount: 364.98,
        txnDate: "2026-08-03",
        vendor: "Lowes",
        projectNames: ["Berg ADU"],
        taxAmount: 29.2,
    },
};

/** The same shape, disagreeing however a test needs it to. */
const booksSay = (
    verdict: "derive" | "review",
    differences: string[],
    booked: Partial<typeof BOOKS_AGREE.booked> = {},
) => ({ verdict, differences, booked: { ...BOOKS_AGREE.booked, ...booked } });

const NOW = new Date("2026-09-01T12:00:00.000Z");

function row(overrides: Partial<BookableRow> = {}): BookableRow {
    return {
        id: "intake-1",
        source: "drive",
        sourceRef: "drive:FILE123",
        dryRun: false,
        projectId: "proj-1",
        costCodeId: null,
        costCodeSource: null,
        suggestedCostCodeId: "cc-plumb",
        suggestedConfidence: 0.82,
        taxAtSource: true,
        installedAtCustomer: true,
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
        stateReason: null,
        ...overrides,
    };
}

interface Recorder {
    deps: BookDependencies;
    sendMarks: string[];
    purchaseCalls: any[];
    expenses: any[];
    expenseUpdates: any[];
    intakeUpdates: any[];
    events: any[];
    /**
     * Every advisory-lock key this transaction took, IN ORDER: the
     * qbPurchaseId first (`lockQboExpense`), then `expense:<id>`
     * (`lockExpense`). The order is the invariant — the Expense is the child
     * and is always last — so it is recorded rather than ignored.
     */
    locks: string[];
    existingExpense: any;
    /**
     * The world the IN-TRANSACTION phase invariant reads (round 17, item 5):
     * the job's status, whether the cost code is still active, and what the
     * locked estimate says its job is. A test that models an archive, a
     * deactivation or a reassignment moves these.
     */
    state: {
        existingExpense: any;
        projectStatus: string;
        costCodeActive: boolean;
        estimateProjectId: string | null;
    };
}

/**
 * Everything the guarded fills actually WROTE, merged into one object.
 *
 * The fill is several `updateMany`s rather than one `update`, because each
 * field has its own predicate and a single one would make one field's
 * contention veto another's legitimate fill. So "what did the fill do" is the
 * union of their payloads, not `expenseUpdates[0]`.
 */
function fillData(rec: Recorder): Record<string, any> {
    return Object.assign({}, ...rec.expenseUpdates.map((u: any) => u.data ?? u));
}

function recorder(
    overrides: Partial<BookDependencies> = {},
    opts: { estimates?: { id: string }[]; existingExpense?: Record<string, unknown> | null } = {},
): Recorder {
    const purchaseCalls: any[] = [];
    const sendMarks: string[] = [];
    const expenses: any[] = [];
    const expenseUpdates: any[] = [];
    const intakeUpdates: any[] = [];
    const events: any[] = [];
    const locks: string[] = [];
    const state: {
        existingExpense: any;
        projectStatus: string;
        costCodeActive: boolean;
        estimateProjectId: string | null;
    } = {
        // Set by a test to model a Purchase that is ALREADY booked.
        existingExpense: opts.existingExpense ?? null,
        // What the locked estimate says its job is. A test that models a
        // reassignment moves this.
        estimateProjectId: "proj-1",
        // What the phase invariant reads back for this job and code.
        projectStatus: "In Progress",
        costCodeActive: true,
    };

    const tx = {
        project: {
            findUnique: async () => ({
                id: "proj-1",
                name: "Berg ADU",
                estimates: opts.estimates ?? [{ id: "est-1" }],
            }),
        },
        expense: {
            findUnique: async () => state.existingExpense,
            create: async (args: any) => { expenses.push(args.data); return { id: `exp-${expenses.length}` }; },
            update: async (args: any) => { expenseUpdates.push(args); return {}; },
            // Models the PREDICATE. Each guarded fill has to be able to match
            // ZERO rows, because that is the whole guarantee it buys.
            updateMany: async (args: any) => {
                expenseUpdates.push(args);
                const cur = state.existingExpense ?? {};
                const eq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
                for (const key of ["costCodeId", "taxAmount", "installedAtCustomer", "receiptUrl", "vendor", "date"]) {
                    if (key in args.where && !eq(cur[key], args.where[key])) return { count: 0 };
                }
                // `projectId` is pinned in every fill predicate to the
                // attribution the decision was made under; the pair fill
                // itself pins NULL.
                if ("projectId" in args.where) {
                    const want = args.where.projectId;
                    const have = cur.projectId ?? null;
                    if (want === null ? have !== null : !(have === null || have === want)) {
                        return { count: 0 };
                    }
                }
                // OR branches, evaluated with SQL's NULL rules: `NOT IN` and
                // `<> x` are both NULL (i.e. NOT a match) for a NULL column,
                // which is exactly why every guard here carries an explicit
                // `{ column: null }` branch. Modelling that is the only way a
                // test can catch a guard that silently drops legacy rows.
                if (Array.isArray(args.where.OR)) {
                    const branchMatches = (branch: any) =>
                        Object.entries(branch).every(([key, want]: [string, any]) => {
                            const have = cur[key] ?? null;
                            if (want && typeof want === "object" && "notIn" in want) {
                                return have !== null && !want.notIn.includes(have);
                            }
                            if (want && typeof want === "object" && "not" in want) {
                                return have !== null && have !== want.not;
                            }
                            return (want ?? null) === have;
                        });
                    if (!args.where.OR.some(branchMatches)) return { count: 0 };
                }
                if (state.existingExpense) Object.assign(state.existingExpense, args.data);
                return { count: 1 };
            },
        },
        receiptIntake: {
            update: async (args: any) => { intakeUpdates.push(args.data); return {}; },
            updateMany: async (args: any) => { intakeUpdates.push(args.data); return { count: 1 }; },
        },
        // TWO jobs. The advisory locks (the shared per-qbPurchaseId one and
        // the per-expense one) are RECORDED — taking them, in that order, is
        // the whole point — and the phase invariant's questions are ANSWERED
        // from the same injected `isCostCodeAllowed` rule every test already
        // sets, so a test writes one rule and the pre-send checks and the
        // in-transaction one both obey it.
        $queryRawUnsafe: async (query: string, ...args: any[]) => {
            if (query.includes("pg_advisory_xact_lock")) {
                locks.push(String(args[0]));
                return [{ lock_result: null }];
            }
            // The attribution PAIR is re-read from the locked estimate before
            // it is written (round 20, item 3).
            if (/FROM "Estimate" WHERE id/.test(query) && /"projectId"/.test(query)) {
                return [{ projectId: state.estimateProjectId }];
            }
            if (/FROM "Project" WHERE id/.test(query) && /status/.test(query)) {
                return [{ id: args[0], status: state.projectStatus }];
            }
            if (/FROM "CostCode" WHERE id/.test(query)) {
                return state.costCodeActive
                    ? [{ id: args[0], code: "03-PLUMB", isActive: true }]
                    : [{ id: args[0], code: "03-PLUMB", isActive: false }];
            }
            if (/FROM "EstimateItem"/.test(query) && /LIMIT 1/.test(query)) {
                return (await deps.isCostCodeAllowed(args[0], args[1])) ? [{ ok: 1 }] : [];
            }
            return [];
        },
        $transaction: async (fn: any) => fn(tx),
    };

    const deps: BookDependencies = {
        db: tx as any,
        isPushEnabled: () => true,
        isPushPaused: async () => false,
        isDryRunEnabled: () => false,
        getTokens: async () => ({ accessToken: "t", realmId: "r" }) as any,
        createPurchase: atCreate(async (_tokens: any, input: any) => {
            purchaseCalls.push(input);
            return { ok: true, qbPurchaseId: "QB-1", docNumber: input.fileId.slice(0, 21), alreadyExists: false, attachment: "attached" };
        }) as any,
        downloadBytes: async () => ({ ok: true as const, bytes: Buffer.from("bytes") }),
        logEvent: async (event) => { events.push(event); },
        now: () => NOW,
        companyTimeZone: async () => "America/Los_Angeles",
        isCostCodeAllowed: async () => true,
        markSendAttempted: async id => { sendMarks.push(id); return true; },
        ...overrides,
    };
    return {
        deps, sendMarks, purchaseCalls, expenses, expenseUpdates, intakeUpdates, events, locks, state,
        set existingExpense(value: any) { state.existingExpense = value; },
        get existingExpense() { return state.existingExpense; },
    };
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
    // QBO-managed from birth — status "Reviewed" keeps it out of the
    // bookkeeper's actionable "Pending" queue (manager/receipts/page.tsx),
    // matching every other qbPurchaseId-bearing Expense. approve/edit/delete
    // reject anything with a qbPurchaseId (qbo-expense-guard.ts), so leaving
    // it "Pending" would strand it in a queue nothing can act on.
    assert.equal(r.expenses[0].status, "Reviewed");
    assert.equal(r.expenses[0].receiptUrl, "https://drive.google.com/file/d/FILE123/view");

    assert.equal(r.intakeUpdates[0].state, "BOOKED");
    assert.equal(r.intakeUpdates[0].qbPurchaseId, "QB-1");
    assert.equal(r.events[0].kind, "receipt-push");
    assert.equal(r.events[0].source, "intake-worker");
    assert.equal(r.events[0].amountCents, 36498);
    assert.equal(r.events[0].taxCents, 2920, "the tax that actually posted");
});

test("a tax-implausible warning survives into BOOKED", async () => {
    // Codex gate: READ->BOOKING used to clear stateReason unconditionally, and
    // BOOKED cleared it again — so an automatically booked receipt with a bad
    // tax read became indistinguishable from one with no tax read at all.
    const r = recorder();
    const result = await bookReceipt(row({ stateReason: "tax-implausible" }), r.deps);

    assert.equal(result.outcome, "booked");
    assert.equal(r.intakeUpdates[0].state, "BOOKED");
    assert.equal(r.intakeUpdates[0].stateReason, "tax-implausible");
});

test("a transient BOOKING reason (e.g. a past defer) does NOT survive into BOOKED", async () => {
    const r = recorder();
    const result = await bookReceipt(row({ stateReason: "push-paused" }), r.deps);

    assert.equal(result.outcome, "booked");
    assert.equal(r.intakeUpdates[0].stateReason, null, "only the tax warning is meant to survive");
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

test("round-31 P0: row.sendAttempted from an EARLIER attempt survives into every needs-review path", async () => {
    // The sequence the finding described: attempt 1 reaches QBO and commits a
    // Purchase, but the response or the Expense tx fails, so the row parks
    // with row.sendAttempted persisted true. Attempt 2 re-reads the row and
    // hits a refusal that, taken on its OWN, never touched QuickBooks this
    // time — a deleted estimate, a missing object, an ok:false decision. None
    // of those three shapes may release the strong key: QBO may already hold
    // a Purchase from attempt 1, and releasing it lets a resubmission mint a
    // second one.

    // 1. parkedBeforeSend — pre-send refusals reached WITHOUT this attempt
    //    ever calling QBO, on a row that already sent once.
    for (const [rowOverrides, reason] of [
        [{ projectId: null }, "no-estimate"],
        [{ totalCents: 0 }, "refund-or-zero"],
        [{ txnDate: null }, "invalid-date"],
    ] as const) {
        const r = recorder();
        const result = await bookReceipt(row({ ...rowOverrides, sendAttempted: true }), r.deps);
        assert.deepEqual(
            result,
            { outcome: "needs-review", reason, releaseStrongKey: false },
            `${reason}: an earlier attempt may already hold a Purchase`,
        );
        assert.equal(r.purchaseCalls.length, 0, reason);
    }

    // The exact scenario named in the finding: the project's estimate was
    // deleted between attempt 1 and attempt 2.
    const deletedEstimate = recorder({}, { estimates: [] });
    assert.deepEqual(
        await bookReceipt(row({ sendAttempted: true }), deletedEstimate.deps),
        { outcome: "needs-review", reason: "no-estimate", releaseStrongKey: false },
    );

    // Also named in the finding: the receipt object has since gone missing.
    const missingObject = recorder({ downloadBytes: async () => ({ ok: false, kind: "missing" }) });
    assert.deepEqual(
        await bookReceipt(row({ sendAttempted: true }), missingObject.deps),
        { outcome: "needs-review", reason: "receipt-bytes-missing", releaseStrongKey: false },
    );

    // 2. The terminal catch — THIS attempt throws before ever reaching the
    //    create hook (sent.attempted stays false), but the row already sent.
    const preCreateFault = recorder({ createPurchase: async () => { throw new QboVendorDuplicateError("Lowes"); } });
    assert.deepEqual(
        await bookReceipt(row({ sendAttempted: true }), preCreateFault.deps),
        { outcome: "needs-review", reason: "qbo-fault:vendor-duplicate", releaseStrongKey: false },
    );

    // 3. ok:false — a deterministic refusal decided before qbCreateFn runs on
    //    THIS attempt, but the row already sent on an earlier one.
    const okFalse = recorder({ createPurchase: async () => ({ ok: false, reason: "missing-vendor" }) as any });
    assert.deepEqual(
        await bookReceipt(row({ sendAttempted: true }), okFalse.deps),
        { outcome: "needs-review", reason: "qbo-fault:missing-vendor", releaseStrongKey: false },
    );
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

test("the global kill switch stops a row even when its persisted flag says live", async () => {
    // A row's dryRun flag is snapshotted once at intake, so it is not itself a
    // kill switch: reverting RECEIPT_INTAKE_DRYRUN after rows were already
    // claimed dryRun=false must still stop them from reaching QuickBooks.
    const r = recorder({ isDryRunEnabled: () => true });
    const result = await bookReceipt(row({ dryRun: false }), r.deps);
    assert.deepEqual(result, { outcome: "deferred", reason: "push-disabled" });
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
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "failed:500", existing: BOOKS_AGREE,
        })) as any,
    });
    const failed = await bookReceipt(row(), failing.deps);
    assert.equal(failed.outcome, "retry", "an upload fault on an existing Purchase is recoverable");
    assert.equal(failing.expenses.length, 0, "and it is NOT booked meanwhile");

    const skipped = recorder({
        createPurchase: atExisting(async () => ({
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "skipped", existing: BOOKS_AGREE,
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
            return { ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "already-attached", existing: BOOKS_AGREE } as any;
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
            alreadyExists: true, attachment: "already-attached", existing: BOOKS_AGREE,
        })) as any,
    });
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    assert.equal((result as any).alreadyExisted, true);
    assert.equal(r.expenses.length, 1);
    assert.equal(r.events[0].status, "already-exists");
});


// ── Never link an Expense blindly (Codex round-12 item 2) ──────────────────
//
// The row under this `qbPurchaseId` is not necessarily one we wrote. The
// expected race: the worker creates the QBO Purchase, dies before its commit,
// and QBO expense sync imports that Purchase before the retry comes round. The
// imported row is right about the money and knows nothing about this receipt —
// `QboExpenseWrite` carries neither `costCodeId` nor `receiptUrl`. Legacy and
// human-edited rows can disagree about more than that.
//
// Selecting `{ id: true }` and taking `existing ?? create` marked the intake
// row BOOKED against whatever was there.

/**
 * What the QBO importer writes for this Purchase: right about the money,
 * silent about the receipt. NOTE the date anchor — qboTransactionDate() writes
 * `${txnDate}T00:00:00.000Z`, UTC midnight, while this file writes the
 * company's LOCAL midnight for the same calendar day. The two differ by hours
 * and mean the same day; a reconcile that compared instants would call every
 * imported row a conflict.
 */
function importedExpense(over: Record<string, unknown> = {}) {
    return {
        id: "exp-existing",
        estimateId: "est-1",
        amount: 364.98,
        vendor: "Lowes",
        date: new Date("2026-08-03T00:00:00.000Z"),
        costCodeId: null,
        receiptUrl: null,
        ...over,
    };
}

/** The row a crash-gap retry finds of its OWN making: fully attributed. */
function matchingExpense(over: Record<string, unknown> = {}) {
    return importedExpense({
        // Local midnight Pacific for the same day — the other anchor.
        date: new Date("2026-08-03T07:00:00.000Z"),
        costCodeId: "cc-plumb",
        receiptUrl: "https://drive.google.com/file/d/FILE123/view",
        ...over,
    });
}

test("an existing Expense for the same Purchase is reused, never duplicated", async () => {
    // The crash-gap retry finding its OWN row: everything agrees, so it links.
    const r = recorder({}, { existingExpense: matchingExpense() });
    const result = await bookReceipt(row(), r.deps);
    assert.equal((result as any).expenseId, "exp-existing");
    assert.equal(r.expenses.length, 0, "no second Expense row");
    // THE LOCK ORDER, in one assertion: the shared per-Purchase advisory lock
    // (the identity of the document) and only then the per-Expense one. The
    // Expense is the child and is always last.
    assert.deepEqual(r.locks, ["QB-1", "expense:exp-existing"]);
});

test("IMPORTER WINS: the receipt fills the attribution the sync could not know", async () => {
    // The expected race. The importer's row carries no cost code and no
    // receiptUrl — it cannot, those columns are not in QboExpenseWrite — so the
    // retry fills them rather than linking a job-cost row that points at
    // nothing and sits on no phase.
    const r = recorder({}, { existingExpense: importedExpense() });
    const result = await bookReceipt(row(), r.deps);

    assert.equal(result.outcome, "booked");
    assert.equal((result as any).expenseId, "exp-existing");
    assert.equal(r.expenses.length, 0, "still no duplicate");
    assert.ok(r.expenseUpdates.length > 0, "the existing row was completed, not replaced");
    const filled = fillData(r);
    assert.equal(filled.costCodeId, "cc-plumb");
    assert.match(String(filled.receiptUrl), /FILE123/);
    // Money and identity agreed, so nothing there was touched. `estimateId`
    // rides along with the attribution PAIR (the importer's row carries no
    // projectId), and it is written as the value it already holds.
    for (const field of ["amount", "vendor", "date"]) {
        assert.ok(!(field in filled), `${field} is not rewritten`);
    }
    assert.equal(filled.estimateId, "est-1", "the pair is written from the locked read, unchanged");
});

test("the two date ANCHORS are not a conflict — same day, different midnight", async () => {
    // The trap this test exists for: the importer stamps UTC midnight and this
    // file stamps local midnight, so `existing.date.getTime() !== receipt.date`
    // for EVERY imported row. Comparing instants would park the whole queue.
    const utcAnchored = reconcileExistingExpense(importedExpense() as never, receiptValues());
    const localAnchored = reconcileExistingExpense(matchingExpense() as never, receiptValues());
    assert.deepEqual(utcAnchored.conflicts, [], "UTC-midnight marker, from the importer");
    assert.deepEqual(localAnchored.conflicts, [], "local midnight, from this file");
    // CONTROL: a genuinely different DAY is still a conflict.
    const wrongDay = reconcileExistingExpense(
        importedExpense({ date: new Date("2026-08-04T00:00:00.000Z") }) as never,
        receiptValues(),
    );
    assert.deepEqual(wrongDay.conflicts, ["date"]);
});

test("a human's cost code is never overwritten by the receipt's suggestion", async () => {
    // costCodeId and receiptUrl are fill-only. The importer cannot write either
    // column, so a value there came from a person or an earlier receipt — and
    // theirs is the answer that stands. On THIS schema there IS a provenance
    // column and a `notHumanCodedExpenseWhere` helper, and the guarded write
    // below pins both — but a populated `costCodeId` never reaches it at all,
    // whoever wrote it.
    const r = recorder({}, { existingExpense: importedExpense({ costCodeId: "cc-electrical" }) });
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    const patch = fillData(r);
    assert.ok(!("costCodeId" in patch), "the human's phase stands");
    assert.ok(!("costCodeSource" in patch), "and its provenance with it");
    assert.match(String(patch.receiptUrl), /FILE123/, "but the missing receipt link is still filled");
});

test("a CONFLICTING amount parks for a human instead of linking", async () => {
    // Two views of one Purchase that disagree about real money. Nothing here
    // can pick a winner, and linking would mark the intake row BOOKED against
    // a job-cost figure the books do not have.
    const r = recorder({}, { existingExpense: importedExpense({ amount: 401.11 }) });
    const result = await bookReceipt(row(), r.deps);

    assert.equal(result.outcome, "needs-review");
    assert.match((result as any).reason, /^expense-conflict:/);
    assert.match((result as any).reason, /amount/);
    // THE KEY IS RETAINED. A Purchase provably exists in QuickBooks, so
    // releasing it would let a resubmission of this receipt book a second one.
    assert.equal((result as any).releaseStrongKey, false);
    assert.equal(r.expenses.length, 0, "nothing written");
    assert.equal(r.expenseUpdates.length, 0);
    assert.ok(
        !r.intakeUpdates.some(u => u.state === "BOOKED"),
        "and the intake row was never marked BOOKED",
    );
});

test("a CONFLICTING job parks too, and names the field", async () => {
    const r = recorder({}, { existingExpense: importedExpense({ estimateId: "est-other" }) });
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "needs-review");
    assert.match((result as any).reason, /estimate/);
    assert.equal((result as any).releaseStrongKey, false);
});

test("reconcile: the truth table, field by field", () => {
    const base = () => reconcileExistingExpense(importedExpense() as never, receiptValues());
    assert.deepEqual(base().conflicts, [], "the expected importer row is not a conflict");
    assert.deepEqual(
        Object.keys(base().fill).sort(),
        // The phase is filled as a TRIO — the id, who chose it, and how sure
        // they were. `receiptValues()` supplies no job, no tax and no excise
        // answer, so none of the other Phase 3 fills is even asked for.
        ["costCodeConfidence", "costCodeId", "costCodeSource", "receiptUrl"],
        "only what the importer could not know",
    );

    // Nullable columns: absent means missing attribution, not disagreement.
    const noVendor = reconcileExistingExpense(importedExpense({ vendor: null }) as never, receiptValues());
    assert.deepEqual(noVendor.conflicts, []);
    assert.equal(noVendor.fill.vendor, "Lowes");
    const noDate = reconcileExistingExpense(importedExpense({ date: null }) as never, receiptValues());
    assert.deepEqual(noDate.conflicts, []);
    assert.ok(noDate.fill.date instanceof Date);

    // Populated and different: a real contradiction.
    assert.deepEqual(
        reconcileExistingExpense(importedExpense({ vendor: "Home Depot" }) as never, receiptValues()).conflicts,
        ["vendor"],
    );
    // Several at once are all reported, so a reviewer sees the whole picture.
    assert.deepEqual(
        reconcileExistingExpense(
            importedExpense({ estimateId: "est-9", amount: 1, vendor: "X" }) as never,
            receiptValues(),
        ).conflicts,
        ["estimate", "amount", "vendor"],
    );
    // A receipt with no phase to offer fills nothing rather than nulling one.
    const noSuggestion = reconcileExistingExpense(
        importedExpense() as never,
        { ...receiptValues(), costCodeId: null },
    );
    assert.ok(!("costCodeId" in noSuggestion.fill));
});

/** The receipt's canonical values, as bookReceipt computes them for row(). */
function receiptValues() {
    return {
        estimateId: "est-1",
        amountCents: 36498,
        vendor: "Lowes",
        date: new Date("2026-08-03T07:00:00.000Z"),
        calendarDay: "2026-08-03",
        timeZone: "America/Los_Angeles",
        costCodeId: "cc-plumb",
        receiptUrl: "https://drive.google.com/file/d/FILE123/view",
    };
}

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
    await bookReceipt(row({ costCodeId: null, suggestedConfidence: 0.82 }), r.deps);
    assert.equal(r.expenses[0].costCodeId, "cc-plumb");
    assert.match(r.expenses[0].description, /phase suggested \(confidence 0\.82\)/);
    assert.equal(r.events[0].detail.suggestedConfidence, 0.82);
});

// ── The confidence the prompt asks for is the confidence that decides ──────

test("a LOW-confidence suggestion books UNCODED and is flagged for a human", async () => {
    // read.ts tells the model "a low number sends the receipt to a human", and
    // then nothing read the number: the suggestion was applied whatever it
    // said, including when the model itself reported it was guessing. A phase
    // the document never pointed at then rode into the Expense and every
    // variance report counted it as spend on a line nobody budgeted — silently,
    // because the audit note said "phase suggested" either way.
    const r = recorder();
    await bookReceipt(row({ costCodeId: null, suggestedConfidence: 0.42 }), r.deps);
    assert.equal(r.expenses[0].costCodeId, null, "the Expense books UNCODED");
    assert.match(r.expenses[0].description, /phase suggestion withheld \(confidence 0\.42 < 0\.6\)/);
    assert.match(r.expenses[0].description, /assign one/, "and says what a human must do");
    assert.equal(r.events[0].detail.phaseRejected, "cc-plumb", "the discarded suggestion is auditable");
    assert.equal(r.events[0].detail.suggestedConfidence, undefined);
});

test("NO confidence at all is not 'sure' — it books UNCODED too", async () => {
    // null is an ABSENT answer (an older prompt, a truncated response, a phase
    // list that was never sent). Letting it clear the bar would apply exactly
    // the suggestions we know least about.
    const r = recorder();
    await bookReceipt(row({ costCodeId: null, suggestedConfidence: null }), r.deps);
    assert.equal(r.expenses[0].costCodeId, null);
    assert.match(r.expenses[0].description, /phase suggestion withheld \(confidence none stated < 0\.6\)/);
    assert.equal(r.events[0].detail.phaseRejected, "cc-plumb");
});

test("exactly AT the threshold is confident enough — the boundary is inclusive", async () => {
    const r = recorder();
    await bookReceipt(row({ costCodeId: null, suggestedConfidence: 0.6 }), r.deps);
    assert.equal(r.expenses[0].costCodeId, "cc-plumb");
    assert.match(r.expenses[0].description, /phase suggested \(confidence 0\.60\)/);
});

test("a HUMAN's explicit pick is never subject to the threshold", async () => {
    // It is not a suggestion. A bookkeeper who codes a receipt by hand must not
    // have it withheld because the model was unsure about a phase nobody asked
    // it about.
    const r = recorder();
    await bookReceipt(row({ costCodeId: "cc-chosen", suggestedConfidence: 0.01 }), r.deps);
    assert.equal(r.expenses[0].costCodeId, "cc-chosen");
    assert.ok(!/withheld/.test(r.expenses[0].description));
});

test("the threshold is env-overridable, and a junk override is ignored", () => {
    assert.equal(phaseConfidenceMin(undefined), RECEIPT_PHASE_CONFIDENCE_MIN);
    assert.equal(phaseConfidenceMin(""), RECEIPT_PHASE_CONFIDENCE_MIN);
    assert.equal(phaseConfidenceMin("0.8"), 0.8);
    assert.equal(phaseConfidenceMin("0"), 0, "zero is a real choice: apply every suggestion");
    assert.equal(phaseConfidenceMin("1"), 1);
    for (const junk of ["banana", "-0.1", "1.5", "NaN", "Infinity"]) {
        assert.equal(phaseConfidenceMin(junk), RECEIPT_PHASE_CONFIDENCE_MIN, junk);
    }
});

test("null confidence never clears the bar, whatever the bar is", () => {
    assert.equal(phaseSuggestionIsConfident(null, 0), false, "not even at zero");
    assert.equal(phaseSuggestionIsConfident(undefined, 0), false);
    assert.equal(phaseSuggestionIsConfident(0, 0), true, "but a stated zero does");
    assert.equal(phaseSuggestionIsConfident(0.59, 0.6), false);
    assert.equal(phaseSuggestionIsConfident(0.6, 0.6), true);
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
    (r.deps.db as any).receiptIntake.updateMany = async () => ({ count: 0 });
    const result = await bookReceipt(row(), r.deps);

    assert.deepEqual(result, { outcome: "stale" });
    assert.equal(r.purchaseCalls.length, 1, "the create did happen");
    assert.equal(r.events.length, 0, "but nothing is logged as booked");
});

test("the BOOKED write is a CAS on state AND token", async () => {
    const wheres: any[] = [];
    const r = recorder();
    (r.deps.db as any).receiptIntake.updateMany = async (args: any) => {
        wheres.push(args.where);
        return { count: 1 };
    };
    await bookReceipt(row({ claimToken: "token-abc" }), r.deps);
    assert.deepEqual(wheres, [{ id: "intake-1", state: "BOOKING", claimToken: "token-abc" }]);
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
            return { ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "already-attached", existing: BOOKS_AGREE } as any;
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
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "failed:500", existing: BOOKS_AGREE,
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
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "failed:415", existing: BOOKS_AGREE,
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
            ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true, attachment: "already-attached", existing: BOOKS_AGREE,
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

// -- An EXISTING QBO Purchase decides the Expense (round-34 item 2) ----------

/**
 * `alreadyExists` is not only the lost-response retry. It is every v1-cutover
 * document (the Apps Script posted the Purchase from its OWN read of the file)
 * and every Drive revision that kept its fileId. The Expense used to be written
 * from THIS pass's OCR values regardless, so ProBuild's job cost could carry a
 * total, a date or a job QuickBooks does not have — under a `qbPurchaseId` that
 * says the two are the same document.
 */
function existingPurchase(existing: unknown) {
    return atExisting(async () => ({
        ok: true, qbPurchaseId: "QB-1", docNumber: "d", alreadyExists: true,
        attachment: "already-attached", existing,
    })) as any;
}

test("a matching Purchase books exactly as it always did", async () => {
    // The control. Without it every assertion below would pass on a code path
    // that had simply stopped booking.
    const r = recorder({ createPurchase: existingPurchase(BOOKS_AGREE) });
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    assert.equal(r.expenses.length, 1);
    assert.equal(r.expenses[0].amount, 364.98);
    assert.equal(r.expenses[0].vendor, "Lowes");
    assert.ok(!/existing QuickBooks Purchase/.test(r.expenses[0].description));
    assert.equal(r.events[0].detail.qboDerivedFields, undefined);
});

test("AMOUNT: the Expense is DERIVED from the books, not from the read", async () => {
    // Real money posted against QBO's number, and the Expense is linked to that
    // very Purchase. Writing 364.98 next to a Purchase the books say is 372.10
    // is a variance report that can never tie out.
    const r = recorder({ createPurchase: existingPurchase(booksSay("derive", ["amount"], { totalAmount: 372.1 })) });
    const result = await bookReceipt(row(), r.deps);

    assert.equal(result.outcome, "booked");
    assert.equal(r.expenses.length, 1);
    assert.equal(r.expenses[0].amount, 372.1, "the books' total, not the OCR one");
    assert.match(
        r.expenses[0].description,
        /amount taken from the existing QuickBooks Purchase/,
        "and it says so, so a bookkeeper reading the Expense knows why",
    );
    assert.equal(r.events[0].amountCents, 37210, "the audit row records what was booked");
    assert.deepEqual(r.events[0].detail.qboDerivedFields, ["amount"]);
});

test("DATE and VENDOR are derived the same way", async () => {
    const r = recorder({
        createPurchase: existingPurchase(booksSay("derive", ["date", "vendor"], {
            txnDate: "2026-08-01",
            vendor: "Lowe's Home Improvement #1234",
        })),
    });
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    assert.equal(r.expenses[0].vendor, "Lowe's Home Improvement #1234");
    // Re-anchored to the company's calendar day, exactly as the normal path
    // does — the derived day goes through the same conversion, not around it.
    assert.equal(
        (r.expenses[0].date as Date).toISOString(),
        startOfDateInTimeZone("2026-08-01", "America/Los_Angeles").toISOString(),
    );
});

test("PROJECT: a disagreement parks the row and writes NO Expense", async () => {
    // Which job carries the cost is an attribution decision. Deriving it would
    // move money between jobs on QuickBooks' say-so; using the read would file
    // it under a job the books disagree with. Neither is ours to choose.
    const r = recorder({ createPurchase: existingPurchase(booksSay("review", ["project"], { projectNames: ["Mesplay Kitchen"] })) });
    const result = await bookReceipt(row(), r.deps);

    assert.equal(result.outcome, "needs-review");
    assert.equal((result as any).reason, "qbo-purchase-mismatch:project");
    assert.equal(
        (result as any).releaseStrongKey,
        false,
        "a Purchase provably exists, so the dedup key must NOT go back",
    );
    assert.equal(r.expenses.length, 0, "nothing is written from the read");
    assert.equal(r.intakeUpdates.length, 0, "and the row is not marked BOOKED");
});

test("TAX: a split the books do not have parks too, naming every difference", async () => {
    const r = recorder({ createPurchase: existingPurchase(booksSay("review", ["project", "tax"])) });
    const result = await bookReceipt(row(), r.deps);
    assert.equal((result as any).reason, "qbo-purchase-mismatch:project,tax");
    assert.equal(r.expenses.length, 0);
});

test("the mismatch park is NOT recoverable by a re-upload", async () => {
    // A re-upload of the same bytes changes nothing about the books, and
    // dragging the row back to RECEIVED would re-read it into the same
    // disagreement. It is a human's decision, like every other non-sweeper park.
    assert.ok(!RECOVERABLE_PARK_REASONS.some(reason => QBO_PURCHASE_MISMATCH_PREFIX.startsWith(reason)));
    assert.equal(
        finalizeDisposition({
            state: "NEEDS_REVIEW",
            stateReason: `${QBO_PURCHASE_MISMATCH_PREFIX}project`,
        }),
        "not-recoverable",
    );
});

test("a FRESHLY created Purchase never consults the books — there is nothing to consult", async () => {
    // alreadyExists:false carries no comparison at all: this call wrote the
    // Purchase from these very values, so they agree by construction.
    const r = recorder();
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    assert.equal(r.expenses[0].amount, 364.98);
    assert.equal(r.events[0].detail.qboDerivedFields, undefined);
});

// ── Tolerance is for IDENTITY, not for VALUES (Codex round-13 items 1 & 2) ──
//
// `compareExistingPurchase` calls a Purchase the SAME purchase when it is
// within two cents on the amount or the tax, and when the vendor differs only
// in case or spacing. That tolerance exists so a rounding split or a
// capitalisation difference does not send an ordinary receipt to a human. It
// says nothing about which numbers to STORE.
//
// Adopting QBO's values only on `derive` meant a verdict of `match`:
//   - wrote the OCR total into job cost while QuickBooks held a figure a cent
//     away, under a qbPurchaseId asserting the two are one document;
//   - logged the OCR tax to the audit register as "what posted", so the
//     sales-tax filing report reconciled against a number no Purchase carried;
//   - and, on the importer-won crash gap, met the importer's QBO-sourced
//     Expense at the exact comparison in reconcileExistingExpense and parked a
//     receipt nothing was wrong with.

/** A Purchase QBO posted a hair away from the OCR read — still ONE purchase. */
const booksWithin = (booked: Partial<typeof BOOKS_AGREE.booked>) => ({
    verdict: "match" as const,
    differences: [] as string[],
    booked: { ...BOOKS_AGREE.booked, ...booked },
});

/** The deps override for a Purchase already in the books. */
const fromBooks = (existing: unknown) => ({ createPurchase: existingPurchase(existing) });

for (const [label, deltaCents] of [["+1c", 1], ["-1c", -1], ["+2c", 2], ["-2c", -2]] as const) {
    test(`MATCHED ${label} on the AMOUNT: the Expense carries QBO's number, not the OCR one`, async () => {
        // row() reads 364.98; QBO posted a cent or two away and the identity
        // check still says "same purchase".
        const postedCents = 36498 + deltaCents;
        const r = recorder(fromBooks(booksWithin({ totalAmount: postedCents / 100 })));

        const result = await bookReceipt(row(), r.deps);

        assert.equal(result.outcome, "booked", label);
        assert.equal(r.expenses.length, 1);
        assert.equal(
            Math.round(Number(r.expenses[0].amount) * 100),
            postedCents,
            `${label}: job cost records what QuickBooks actually posted`,
        );
        // THE PRE-FIX CONTROL: the OCR figure is a DIFFERENT number, so this
        // assertion cannot pass for code that simply kept the read.
        assert.notEqual(postedCents, 36498, "the two really do differ");
        assert.equal(r.events[0].amountCents, postedCents, "and the audit reports the same");
    });
}

for (const [label, deltaCents] of [["+1c", 1], ["-2c", -2]] as const) {
    test(`MATCHED ${label} on the TAX: the audit reports QBO's tax, not the read's`, async () => {
        const postedTaxCents = 2920 + deltaCents;
        const r = recorder(fromBooks(booksWithin({ taxAmount: postedTaxCents / 100 })));

        const result = await bookReceipt(row(), r.deps);

        assert.equal(result.outcome, "booked", label);
        assert.equal(
            r.events[0].taxCents,
            postedTaxCents,
            `${label}: the filing register reconciles against the Purchase`,
        );
        assert.notEqual(postedTaxCents, 2920, "the OCR tax is a different number");
    });
}

test("CONTROL: a fresh create still reports the read's own numbers", async () => {
    // Nothing was in the books, so there is no posted figure to adopt and the
    // groups this pass actually sent are the truth. Without this control, code
    // that always reached for `booked` would pass every test above.
    const r = recorder();
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    assert.equal(Math.round(Number(r.expenses[0].amount) * 100), 36498);
    assert.equal(r.events[0].taxCents, 2920);
});

test("a DERIVE verdict adopts exactly as a MATCH does, and still names the fields", async () => {
    // The two verdicts must not disagree about what gets stored — only about
    // what gets REPORTED as a difference.
    const r = recorder(fromBooks(
        booksSay("derive", ["amount"], { totalAmount: 401.11 }),
    ));
    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");
    assert.equal(Math.round(Number(r.expenses[0].amount) * 100), 40111);
    assert.deepEqual(r.events[0].detail.qboDerivedFields, ["amount"]);
});

test("a MATCH adopts silently — no derived-fields noise for a within-tolerance cent", async () => {
    // `differences` is the beyond-tolerance list. A one-cent adoption is not a
    // disagreement anyone needs to review, so it must not fill the register
    // with derived-field rows.
    const r = recorder(fromBooks(booksWithin({ totalAmount: 364.99 })));
    await bookReceipt(row(), r.deps);
    assert.equal(r.events[0].detail.qboDerivedFields, undefined);
});

test("IMPORTER WINS at ±1c: the retry reconciles against QBO's number, not the read's", async () => {
    // The whole failure, end to end. QBO posted 364.99; the importer wrote that
    // into the Expense; the OCR read says 364.98. Before the fix the worker
    // compared its OCR cents to the importer's QBO cents and parked
    // `expense-conflict:amount` — a receipt that was never wrong about anything.
    const r = recorder(
        fromBooks(booksWithin({ totalAmount: 364.99 })),
        { existingExpense: importedExpense({ amount: 364.99 }) },
    );

    const result = await bookReceipt(row(), r.deps);

    assert.equal(result.outcome, "booked", "it recovers instead of parking");
    assert.equal((result as any).expenseId, "exp-existing");
    assert.equal(r.expenses.length, 0, "no duplicate Expense");
    // CONTROL: the same importer row against the OCR figure IS a conflict, so
    // this is not passing because the reconcile stopped comparing amounts.
    const wouldPark = reconcileExistingExpense(
        importedExpense({ amount: 364.99 }) as never,
        { ...receiptValues(), amountCents: 36498 },
    );
    assert.deepEqual(wouldPark.conflicts, ["amount"], "the OCR comparison would have parked");
});

test("IMPORTER WINS on VENDOR SPELLING: canonical vs OCR recovers, not parks", async () => {
    // `compareExistingPurchase` normalizes case and whitespace, so QBO's
    // canonical "Home Depot" and the receipt's "  home   depot " are ONE vendor
    // to the identity check. The importer wrote QBO's spelling; the reconcile
    // compared byte-for-byte and parked `expense-conflict:vendor`.
    const r = recorder(
        fromBooks(booksWithin({ vendor: "Home Depot" })),
        { existingExpense: importedExpense({ vendor: "Home Depot" }) },
    );

    const result = await bookReceipt(row({ vendor: "  home   depot " }), r.deps);

    assert.equal(result.outcome, "booked", "it recovers instead of parking");
    assert.equal((result as any).expenseId, "exp-existing");
    // The persisted vendor is QBO's canonical display name on every path that
    // identified an existing Purchase — nothing rewrites the books, but job
    // cost must not carry a spelling QuickBooks does not use.
    assert.ok(
        !("vendor" in fillData(r)),
        "the importer's canonical spelling stands",
    );
});

test("ONE vendor normalizer, and it is the identity check's", async () => {
    // The two comparisons must never be able to disagree again. Asserted on
    // the shared function directly, and on the reconcile that now calls it.
    assert.equal(normalizeVendorName("  home   depot "), normalizeVendorName("Home Depot"));
    const spelled = reconcileExistingExpense(
        importedExpense({ vendor: "Home Depot" }) as never,
        { ...receiptValues(), vendor: "  home   depot " },
    );
    assert.deepEqual(spelled.conflicts, [], "case and spacing are not a contradiction");
    // CONTROL: a genuinely different vendor still is.
    const different = reconcileExistingExpense(
        importedExpense({ vendor: "Home Depot" }) as never,
        { ...receiptValues(), vendor: "Lowes" },
    );
    assert.deepEqual(different.conflicts, ["vendor"]);
});

test("a fresh create on an alreadyExists purchase stores QBO's vendor spelling", async () => {
    // No importer row this time: the Expense is created here, so the value
    // written is the one this file chose. It must still be QBO's.
    const r = recorder(fromBooks(booksWithin({ vendor: "Home Depot" })));
    await bookReceipt(row({ vendor: "  home   depot " }), r.deps);
    assert.equal(r.expenses[0].vendor, "Home Depot");
});

// ── The audit must report the phase that was PERSISTED (round-13 item 3) ───

test("a preserved human phase is what the booking event reports", async () => {
    // The worker picks cc-plumb; the row already carries a human's
    // cc-electrical, which the reconcile keeps. The event used to log the
    // worker's pick regardless — asserting a cost code never applied to
    // anything, and attaching the model's confidence score to it.
    const r = recorder(
        fromBooks(BOOKS_AGREE),
        { existingExpense: importedExpense({ costCodeId: "cc-electrical" }) },
    );

    const result = await bookReceipt(row(), r.deps);

    assert.equal(result.outcome, "booked");
    const detail = r.events[0].detail;
    assert.equal(detail.costCodeId, "cc-electrical", "the persisted phase, not the worker's");
    assert.equal(detail.costCodeOrigin, "existing");
    assert.equal(detail.phasePreserved, true, "and it says so explicitly");
    // CONTROL: the worker really did pick something else, so this cannot pass
    // for an event that simply echoed whatever the row already had.
    assert.equal(row().suggestedCostCodeId, "cc-plumb");
    assert.equal(
        detail.suggestedConfidence,
        undefined,
        "a confidence score for a suggestion that lost describes nothing",
    );
});

test("an unclaimed phase is FILLED, and reported as the receipt's", async () => {
    const r = recorder(fromBooks(BOOKS_AGREE), { existingExpense: importedExpense() });
    await bookReceipt(row(), r.deps);
    const detail = r.events[0].detail;
    assert.equal(detail.costCodeId, "cc-plumb");
    assert.equal(detail.costCodeOrigin, "receipt");
    assert.equal(detail.phasePreserved, undefined, "nothing was displaced");
    assert.equal(detail.suggestedConfidence, 0.82, "and the confidence still rides along");
});

test("a phase the row already agrees with is not 'preserved'", async () => {
    // Only a CONTEST counts. Marking every existing value as preserved would
    // make the flag useless for finding the cases a human should look at.
    const r = recorder(
        fromBooks(BOOKS_AGREE),
        { existingExpense: importedExpense({ costCodeId: "cc-plumb" }) },
    );
    await bookReceipt(row(), r.deps);
    assert.equal(r.events[0].detail.phasePreserved, undefined);
    assert.equal(r.events[0].detail.costCodeId, "cc-plumb");
});

test("reconcile reports the effective attribution, three ways", () => {
    const withHuman = reconcileExistingExpense(
        importedExpense({ costCodeId: "cc-electrical" }) as never,
        receiptValues(),
    );
    assert.deepEqual(withHuman.attribution, {
        costCodeId: "cc-electrical", costCodeOrigin: "existing", preserved: true,
    });
    // No contest: the receipt had nothing to offer.
    const noSuggestion = reconcileExistingExpense(
        importedExpense({ costCodeId: "cc-electrical" }) as never,
        { ...receiptValues(), costCodeId: null },
    );
    assert.equal(noSuggestion.attribution.preserved, false);
    // Filled from the receipt.
    const filled = reconcileExistingExpense(importedExpense() as never, receiptValues());
    assert.deepEqual(filled.attribution, {
        costCodeId: "cc-plumb", costCodeOrigin: "receipt", preserved: false,
    });
    // Neither side has one.
    const neither = reconcileExistingExpense(
        importedExpense() as never,
        { ...receiptValues(), costCodeId: null },
    );
    assert.deepEqual(neither.attribution, {
        costCodeId: null, costCodeOrigin: "none", preserved: false,
    });
});

// ── The intake row records what POSTED (Codex round-16 item 3) ─────────────
//
// "QuickBooks is authoritative for an existing Purchase" was only half true:
// booking derived the total, vendor, date and tax from QBO and wrote them to
// the Expense, but left the intake row carrying the OCR read. So `taxCents` —
// the column Phase 3's sales-tax reporting is specified to read — kept a
// figure no Purchase ever posted, and the row disagreed with its own Expense
// under a qbPurchaseId asserting the two are one document. The audit event
// reported `row.vendor` (the OCR spelling) while the Expense carried QBO's.

test("BOOKED persists QBO's tax, vendor, total and date on the intake row", async () => {
    // The read says Lowes / 364.98 / 29.20; QuickBooks posted Home Depot /
    // 372.10 / 31.00 on a different day, and identified the same purchase.
    const r = recorder(fromBooks(booksSay("derive", ["amount", "vendor", "date"], {
        totalAmount: 372.10,
        vendor: "Home Depot",
        txnDate: "2026-08-04",
        taxAmount: 31.0,
    })));

    const result = await bookReceipt(row(), r.deps);
    assert.equal(result.outcome, "booked");

    const booked = r.intakeUpdates.find(u => u.state === "BOOKED");
    assert.ok(booked, "the row reached BOOKED");
    assert.equal(booked.vendor, "Home Depot", "QBO's vendor, not the read's");
    assert.equal(booked.totalCents, 37210);
    assert.equal(booked.taxCents, 3100, "the column Phase 3 reads");
    assert.equal(
        (booked.txnDate as Date).toISOString().slice(0, 10),
        "2026-08-04",
        "and QBO's calendar day",
    );

    // PRE-FIX CONTROL: every one of those is a DIFFERENT value from the OCR
    // read, so these assertions cannot pass for code that left the row alone.
    assert.equal(row().vendor, "Lowes");
    assert.equal(row().totalCents, 36498);
    assert.equal(row().taxCents, 2920);
});

test("the audit event reports exactly what the Expense got", async () => {
    const r = recorder(fromBooks(booksSay("derive", ["amount", "vendor"], {
        totalAmount: 372.10,
        vendor: "Home Depot",
        taxAmount: 31.0,
    })));
    await bookReceipt(row(), r.deps);

    const event = r.events[0];
    const expense = r.expenses[0];
    assert.equal(event.vendor, "Home Depot", "not row.vendor");
    assert.equal(event.vendor, expense.vendor, "the event and the Expense agree");
    assert.equal(event.amountCents, 37210);
    assert.equal(Math.round(Number(expense.amount) * 100), event.amountCents);
    assert.equal(event.taxCents, 3100);
});

test("the row, the Expense and the audit are ONE object — asserted together", async () => {
    // The property that keeps them from drifting again: all three writes read
    // the same `booked`, so any disagreement is a code change, not a
    // maintenance slip in one of three places.
    const r = recorder(fromBooks(booksWithin({ totalAmount: 364.99, taxAmount: 29.25 })));
    await bookReceipt(row(), r.deps);

    const rowUpdate = r.intakeUpdates.find(u => u.state === "BOOKED")!;
    const expense = r.expenses[0];
    const event = r.events[0];
    assert.equal(rowUpdate.totalCents, 36499);
    assert.equal(Math.round(Number(expense.amount) * 100), 36499);
    assert.equal(event.amountCents, 36499);
    assert.equal(rowUpdate.taxCents, 2925);
    assert.equal(event.taxCents, 2925);
    assert.equal(rowUpdate.vendor, expense.vendor);
});

test("a FRESH create still records the read's own values", async () => {
    // Nothing was in the books, so there is no posted figure to adopt — the
    // control that stops the fix from reaching for `booked` unconditionally.
    const r = recorder();
    await bookReceipt(row(), r.deps);
    const rowUpdate = r.intakeUpdates.find(u => u.state === "BOOKED")!;
    assert.equal(rowUpdate.vendor, "Lowes");
    assert.equal(rowUpdate.totalCents, 36498);
    assert.equal(rowUpdate.taxCents, 2920);
});

test("readJson is NEVER rewritten, so the OCR original stays auditable", async () => {
    // BOOKED overwrites the extracted values on purpose; this is what makes
    // that safe. There is no `extracted*` column pair on the model and none is
    // needed while the raw model response survives verbatim.
    const r = recorder(fromBooks(booksSay("derive", ["vendor"], { vendor: "Home Depot" })));
    await bookReceipt(row(), r.deps);
    for (const update of r.intakeUpdates) {
        assert.ok(!("readJson" in update), "no booking write touches the raw read");
    }
});

// ── PHASE 3: the already-booked Purchase still needs its attribution ───────
//
// Everything below drives the SAME `bookReceipt`, through the same recorder,
// against the Phase 3 columns: the job pair, the phase and its provenance, the
// two tax figures and their provenance, and the excise answer. The fills are
// several guarded `updateMany`s rather than one `update` — the predicate IS
// the guarantee — so what landed is asserted on the row, not on the statement.

/**
 * An existing Expense in the PHASE 3 shape: the money-and-identity columns a
 * real row always has (without them the reconcile reads every fixture as an
 * `amount` conflict, which is true of a real row too) plus the attribution
 * columns booking fills.
 */
function phase3Expense(over: Record<string, unknown> = {}) {
    return {
        id: "expense-1",
        estimateId: "est-1",
        amount: 364.98,
        vendor: "Lowes",
        // The importer's UTC-midnight marker for the same calendar day.
        date: new Date("2026-08-03T00:00:00.000Z"),
        costCodeId: null,
        receiptUrl: null,
        projectId: null,
        costCodeSource: null,
        taxAmount: null,
        taxAtSource: false,
        taxSource: null,
        installedAtCustomer: null,
        estimate: { projectId: null },
        ...over,
    };
}

/** The same row, already on this job — so only the empty columns are in play. */
const onThisJob = (over: Record<string, unknown> = {}) =>
    phase3Expense({ projectId: "proj-1", estimate: { projectId: "proj-1" }, ...over });

test("an alreadyExists row is FILLED, not left blank", async () => {
    // `alreadyExists` covers the lost-response retry AND a row v1 created
    // before this pipeline existed. Returning it untouched left projectId, the
    // phase, the provenance and the tax columns NULL forever on exactly the
    // receipts the tax report is made of.
    const rec = recorder();
    rec.existingExpense = phase3Expense();
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "booked");
    const fill = fillData(rec);
    assert.equal(fill.projectId, "proj-1");
    assert.equal(fill.installedAtCustomer, true);
    assert.ok("taxAmount" in fill, "the tax the booking validated lands too");
});

test("the fill writes the phase's PROVENANCE with the phase, never the id alone", async () => {
    // ROUND 24 DECISION 2. A `costCodeId` with no `costCodeSource` reads as a
    // legacy row that any later automated pass may overwrite, and the
    // confidence belongs to the same decision. One statement, three columns,
    // behind the ONE shared human-source predicate.
    const rec = recorder();
    rec.existingExpense = phase3Expense();
    await bookReceipt(row(), rec.deps);
    const write = rec.expenseUpdates.find((u: any) => "costCodeId" in (u.data ?? {}));
    assert.ok(write, "the phase was filled");
    assert.deepEqual(Object.keys(write.data).sort(), ["costCodeConfidence", "costCodeId", "costCodeSource"]);
    assert.equal(write.data.costCodeId, "cc-plumb");
    assert.equal(write.data.costCodeSource, "ai", "the model's suggestion, correctable by a later pass");
    assert.equal(write.data.costCodeConfidence, 0.82);
    // ...and the predicate carries the shared definition of "a human chose
    // this", with its explicit NULL branch, not a list restated here.
    assert.equal(write.where.costCodeId, null);
    assert.deepEqual(
        write.where.OR,
        [{ costCodeSource: null }, { costCodeSource: { notIn: ["capture", "manual", "manual-none"] } }],
    );
    assert.equal(rec.existingExpense.costCodeSource, "ai", "and it landed");
});

test("a human's decisions on an existing row are never overwritten", async () => {
    const rec = recorder();
    rec.existingExpense = onThisJob({
        costCodeId: "cc-human", costCodeSource: "manual",
        taxAmount: 9.99, taxAtSource: true, installedAtCustomer: false,
    });
    await bookReceipt(row(), rec.deps);
    // Nothing a human owns may be written — the guarded predicates are what
    // enforce it, so assert on what actually LANDED, not on what was attempted.
    const after = rec.existingExpense;
    assert.equal(after.costCodeId, "cc-human", "a manual phase is untouchable");
    assert.equal(after.taxAmount, 9.99, "a recorded tax outranks a re-read");
    assert.equal(after.installedAtCustomer, false, "an answered tax question is a human's");
    assert.ok(rec.expenseUpdates.every((u: any) => u.where.id === "expense-1"));
});

test("a bookkeeper's CLEARED phase survives an intake retry", async () => {
    // ROUND 37, ITEM 1 — the recovery this guard exists for, end to end.
    //
    // A bookkeeper opens a booked receipt, decides the machine's phase is
    // wrong, and clears it. That writes `costCodeId: null` with
    // `costCodeSource: "manual-none"` — a DECISION, not an absence (see
    // HUMAN_COST_CODE_SOURCES). Booking's fill predicate used to spell its own
    // exclusion list as ["capture", "manual"], so "manual-none" fell straight
    // through it: the next retry of the SAME document — a lost QBO response, a
    // re-delivery, a worker re-run — matched the row (its code IS null) and
    // wrote the machine's suggestion back on top. The clear was undone within
    // minutes and nothing recorded that it had happened.
    const rec = recorder();
    rec.existingExpense = onThisJob({
        costCodeId: null, costCodeSource: "manual-none",
        taxAmount: 9.99, taxAtSource: true, installedAtCustomer: false,
    });
    const result = await bookReceipt(row({ costCodeId: "cc-demo", costCodeSource: "user" }), rec.deps);
    assert.equal(result.outcome, "booked");
    const after = rec.existingExpense;
    assert.equal(after.costCodeId, null, "the cleared phase stays cleared");
    assert.equal(after.costCodeSource, "manual-none", "and so does the person's provenance");
    // AND THE AUDIT SAYS SO. A "manual-none" row is a human's answer even
    // though the column is null, so the event must not report the phase this
    // pass picked — that would assert a cost code applied to nothing.
    const detail = rec.events[0].detail;
    assert.equal(detail.costCodeId, null);
    assert.equal(detail.costCodeOrigin, "existing");
    assert.equal(detail.phasePreserved, true);
});

test("a PATCH landing between the read and the fill is not overrun", async () => {
    // The read happens inside the transaction and inside the per-expense lock,
    // but a writer that does not take that lock can still commit before these
    // writes. Deciding from the read and writing unconditionally would overrun
    // exactly the authority this fill must respect; the predicate is what
    // makes the gap safe.
    const rec = recorder();
    rec.existingExpense = phase3Expense();
    const seenByBooking = { ...rec.existingExpense };
    let reads = 0;
    (rec.deps.db as any).expense.findUnique = async () => {
        reads += 1;
        // Read 1 is the id lookup that the lock is taken on. Read 2 is the one
        // every decision is made from — hand it the PRE-patch snapshot, and let
        // the PATCH land in the same breath. Later reads (the post-fill
        // attribution check) see the row as it really is.
        if (reads === 1) return { id: "expense-1" };
        if (reads > 2) return rec.existingExpense;
        rec.existingExpense = {
            ...rec.existingExpense,
            costCodeId: "cc-human",
            costCodeSource: "manual",
            installedAtCustomer: false,
        };
        return seenByBooking;
    };

    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "booked");
    assert.equal(rec.existingExpense.costCodeId, "cc-human", "the human's phase survives");
    assert.equal(rec.existingExpense.costCodeSource, "manual");
    assert.equal(rec.existingExpense.installedAtCustomer, false, "and their tax answer");
    // ...while the field nobody contended for is still filled.
    assert.equal(rec.existingExpense.projectId, "proj-1");
});

test("a Purchase already on ANOTHER job parks instead of booking", async () => {
    // ROUND 24 DECISION 1. Filling would be guessing which job is right;
    // overwriting would silently move real money between jobs. It is ONE MORE
    // ENTRY in the reconcile's conflicts list, so it raises the same
    // ExpenseConflictError every other disagreement does — with its own reason.
    const rec = recorder();
    rec.existingExpense = phase3Expense({
        projectId: "some-other-job", estimate: { projectId: "some-other-job" },
    });
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "needs-review");
    if (result.outcome === "needs-review") {
        assert.equal(result.reason, "expense-conflict:attribution");
        assert.equal(result.releaseStrongKey, false, "the Purchase exists — keep the key");
    }
    assert.equal(rec.expenses.length, 0, "nothing written");
    assert.equal(rec.expenseUpdates.length, 0, "and no fill was even attempted");
    assert.ok(!rec.intakeUpdates.some((u: any) => u.state === "BOOKED"));
});

test("the JOB fallback is the estimate, when the column is null", async () => {
    // CONTROL for the check above: `resolveExpenseProjectId` prefers the
    // column and falls back through the estimate, so a row with no
    // `projectId` but an estimate on another job is the same conflict.
    const rec = recorder();
    rec.existingExpense = phase3Expense({
        projectId: null, estimate: { projectId: "some-other-job" },
    });
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "needs-review");
    if (result.outcome === "needs-review") assert.equal(result.reason, "expense-conflict:attribution");
});

// ── the CREATE path re-reads the pair too (round 21, item 1) ───────────────

test("a NEW expense is created from the LOCKED pair, not the pre-transaction one", async () => {
    // The estimate was chosen before the QBO Purchase round trip. This is the
    // control: nothing moved, so the pair is written unchanged.
    const rec = recorder();
    await bookReceipt(row(), rec.deps);
    assert.equal(rec.expenses[0].projectId, "proj-1");
    assert.equal(rec.expenses[0].estimateId, "est-1");
});

test("an estimate MOVED before the create parks instead of splitting the job", async () => {
    // The fill path already refused this shape; the create path wrote
    // `row.projectId` beside an estimate nobody had looked at since it was
    // picked, producing a brand-new expense on two jobs at once.
    const rec = recorder();
    rec.state.estimateProjectId = "another-job";
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "needs-review");
    if (result.outcome === "needs-review") {
        assert.equal(result.reason, "expense-conflict:attribution");
        assert.equal(result.releaseStrongKey, false, "the Purchase exists — keep the key");
    }
    assert.equal(rec.expenses.length, 0, "nothing was written on either job");
    assert.equal(
        rec.intakeUpdates.filter((u: any) => u.state === "BOOKED").length, 0,
        "and the row is not marked booked",
    );
});

test("an estimate that lost its project before the create parks too", async () => {
    // Half a pair is the same bug reached the other way: `projectId` set, the
    // estimate on no job at all.
    const rec = recorder();
    rec.state.estimateProjectId = null;
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "needs-review");
    if (result.outcome === "needs-review") assert.equal(result.reason, "expense-conflict:attribution");
    assert.equal(rec.expenses.length, 0);
});

// ── tax provenance and the post-fill attribution check ─────────────────────

test("a bookkeeper's NO-TAX decision is not overwritten by an OCR re-read", async () => {
    // The case a null taxAmount cannot express on its own: a person looked at
    // this receipt, concluded there is no sales tax on it, and left the column
    // NULL. Without `taxSource` that is indistinguishable from "nobody has
    // looked", and the next booking writes an OCR figure over their answer.
    const rec = recorder();
    rec.existingExpense = onThisJob({ taxSource: "manual" });
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "booked");
    assert.equal(rec.existingExpense.taxAmount, null, "their answer stands");
    assert.equal(rec.existingExpense.taxSource, "manual");
    // ...while the excise question, which they did NOT answer, is still filled
    // from the capture. `taxSource` governs the tax figures only; the
    // installed-at-customer answer is its own evidence (round 16, item 1).
    assert.equal(rec.existingExpense.installedAtCustomer, true);
});

test("a legacy row with no provenance IS filled, and stamped ocr", async () => {
    // The control for the test above: `taxSource` NULL is "nobody has looked",
    // and SQL's `<> 'manual'` would drop exactly these rows without the
    // explicit NULL branch in the guard.
    const rec = recorder();
    rec.existingExpense = onThisJob();
    await bookReceipt(row(), rec.deps);
    assert.ok(Number(rec.existingExpense.taxAmount) > 0, "the validated tax lands");
    assert.equal(rec.existingExpense.taxSource, "ocr");
    assert.equal(rec.existingExpense.taxAtSource, true);
});

test("a newly created Expense records where its tax came from", async () => {
    const rec = recorder();
    await bookReceipt(row(), rec.deps);
    assert.equal(rec.expenses[0].taxSource, "ocr");
    assert.ok(rec.expenses[0].taxAmount > 0);
    // And says nothing about a base it never wrote. Booking does not split a
    // receipt into a resold portion, so both the base and its provenance start
    // empty and wait for a person (round 33, item 4).
    assert.equal(rec.expenses[0].taxDeductibleBase, undefined);
    assert.equal(rec.expenses[0].taxDeductibleBaseSource, undefined);
});

test("MIXED PROVENANCE: a manual base survives an OCR tax fill with its own source", async () => {
    // Round 33, item 4 — the state one column could not represent.
    //
    // A bookkeeper sets `taxDeductibleBase` and says nothing about the tax, so
    // the PATCH deliberately leaves `taxSource` NULL (the row stays open to an
    // automated read). Booking then fills `taxAmount` and stamps
    // `taxSource: "ocr"`. While `taxSource` governed BOTH figures, the row
    // came out of that sequence claiming OCR had decided a base a person had
    // typed — the value was theirs and the provenance said machine.
    const rec = recorder();
    rec.existingExpense = onThisJob({
        amount: 100, taxDeductibleBase: 20, taxDeductibleBaseSource: "manual",
    });
    const result = await bookReceipt(row({ totalCents: 10_000, taxCents: 900 }), rec.deps);
    assert.equal(result.outcome, "booked");
    assert.ok(Number(rec.existingExpense.taxAmount) > 0, "the OCR tax fills the gap it found");
    assert.equal(rec.existingExpense.taxSource, "ocr", "and claims only the figure it read");
    assert.equal(rec.existingExpense.taxDeductibleBase, 20, "the human base is untouched");
    assert.equal(
        rec.existingExpense.taxDeductibleBaseSource,
        "manual",
        "and still says a person decided it",
    );
});

test("no tax means no provenance, so a bookkeeper can still answer", async () => {
    const rec = recorder();
    await bookReceipt(row({ taxCents: 0 }), rec.deps);
    assert.equal(rec.expenses[0].taxAmount, null);
    assert.equal(rec.expenses[0].taxSource, null, "nobody has decided anything yet");
});

test("an Expense re-attributed DURING the fill parks instead of booking", async () => {
    // The pre-fill conflict check passed, the guarded fills ran, and a
    // re-attribution committed underneath. Marking the intake row BOOKED here
    // would tie this receipt to an Expense on somebody else's job.
    const rec = recorder();
    rec.existingExpense = phase3Expense();
    let reads = 0;
    (rec.deps.db as any).expense.findUnique = async () => {
        reads += 1;
        if (reads === 1) return { id: "expense-1" };
        if (reads === 2) return rec.existingExpense;
        // The post-fill re-read: somebody moved it.
        return { projectId: "another-job", estimate: { projectId: "another-job" } };
    };
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "needs-review");
    if (result.outcome === "needs-review") {
        assert.equal(result.reason, "expense-conflict:attribution");
        assert.equal(result.releaseStrongKey, false, "the Purchase exists — keep the key");
    }
    // Nothing was marked BOOKED: the throw rolled the whole transaction back.
    assert.equal(
        rec.intakeUpdates.filter((u: any) => u.state === "BOOKED").length, 0,
        "no booking on a row that ended up on another job",
    );
});

test("the locks are taken in one order: the Purchase, the parents, then the Expense", async () => {
    // ROUND 24 DECISION 3, asserted on the call order of the fake tx.
    //
    // Reading first and locking second leaves the decision resting on a value
    // from before the lock, which is the race the lock exists to close — and
    // taking the Expense before its parents is a cycle against every other
    // writer of expense attribution.
    const rec = recorder();
    rec.existingExpense = onThisJob();
    const trace: string[] = [];
    const realFind = (rec.deps.db as any).expense.findUnique;
    (rec.deps.db as any).expense.findUnique = async (args: any) => {
        trace.push("read");
        return realFind(args);
    };
    const realQuery = (rec.deps.db as any).$queryRawUnsafe;
    (rec.deps.db as any).$queryRawUnsafe = async (query: string, ...args: any[]) => {
        trace.push(
            query.includes("pg_advisory_xact_lock") ? "lock"
                : query.includes("FOR SHARE") ? "phase-share"
                    : "phase-read",
        );
        return realQuery(query, ...args);
    };
    await bookReceipt(row(), rec.deps);

    // 1. the per-Purchase advisory lock, before ANYTHING is read;
    assert.equal(trace[0], "lock", "the Purchase's own lock comes first");
    // 2. the attribution parents, before the id lookup;
    const idReadAt = trace.indexOf("read");
    assert.ok(idReadAt > 0, "something is read");
    assert.ok(
        trace.slice(0, idReadAt).filter(entry => entry === "phase-share").length >= 4,
        "Project, Estimate, EstimateItem and CostCode are all held first",
    );
    // 3. the Expense last, and the decisive read INSIDE it.
    const expenseLockAt = trace.lastIndexOf("lock");
    assert.ok(expenseLockAt > idReadAt, "the id lookup, then its lock");
    assert.ok(
        trace.lastIndexOf("read") > expenseLockAt,
        "and the decisive read happens INSIDE the per-expense lock",
    );
    assert.deepEqual(
        rec.locks,
        ["QB-1", "expense:expense-1"],
        "the two advisory keys, purchase first and expense last",
    );
});

// ── an implausible OCR tax is flagged, never booked (round 15, item 1) ─────

test("$90 of tax on a $100 receipt is NOT booked as tax paid at source", async () => {
    // buildGroups only rejects tax >= total, which leaves a wide band of
    // nonsense: this satisfies every check the pipeline had and would land on a
    // state excise return as a $90 deduction nobody looked at.
    const rec = recorder();
    const result = await bookReceipt(row({ totalCents: 10_000, taxCents: 9_000 }), rec.deps);
    assert.equal(result.outcome, "booked", "the Purchase is real; only the tax read is wrong");
    const created = rec.expenses[0];
    assert.equal(created.taxAmount, null, "nothing implausible reaches the report");
    assert.equal(created.taxAtSource, false);
    assert.equal(created.needsTaxReview, true, "a person is asked instead");
    assert.equal(created.taxSource, "ocr", "a machine DID look — that is what needs replacing");
    assert.match(created.description, /needs review/);
    assert.doesNotMatch(created.description, /incl\. \$90/);
});

test("a believable tax on the same receipt is booked normally", async () => {
    // The control: same shape, a figure inside the bound.
    const rec = recorder();
    await bookReceipt(row({ totalCents: 10_000, taxCents: 900 }), rec.deps);
    const created = rec.expenses[0];
    assert.equal(created.taxAmount, 9);
    assert.equal(created.taxAtSource, true);
    assert.equal(created.needsTaxReview, false);
    assert.equal(created.taxSource, "ocr");
});

test("an implausible read FILLS nothing on an already-booked Purchase", async () => {
    // Worse here than on a new row: this one may already sit in a filing period
    // somebody has reconciled.
    const rec = recorder();
    rec.existingExpense = onThisJob({ amount: 100 });
    await bookReceipt(row({ totalCents: 10_000, taxCents: 9_000 }), rec.deps);
    assert.equal(rec.existingExpense.taxAmount, null);
    assert.equal(rec.existingExpense.taxAtSource, false);
    assert.equal(rec.existingExpense.needsTaxReview, true);
});

test("a manual deduction base that no longer fits a fresh OCR tax is flagged, not overwritten", async () => {
    // scripts/apply-expense-attribution.mjs's Expense_taxDeductibleBase_check:
    // base <= amount - COALESCE(taxAmount, 0). A bookkeeper's PATCH can set
    // taxDeductibleBase while leaving taxAmount (and taxSource) null — the
    // exact case from the finding: { amount: 100, taxAmount: null,
    // taxDeductibleBase: 100, taxSource: null }. Writing an OCR taxAmount on
    // top of that, unguarded, would shrink the ceiling below the base and
    // violate the CHECK on every retry of this already-booked Purchase.
    const rec = recorder();
    rec.existingExpense = onThisJob({ amount: 100, taxDeductibleBase: 100 });
    const result = await bookReceipt(row({ totalCents: 10_000, taxCents: 900 }), rec.deps);
    assert.equal(result.outcome, "booked", "the Purchase is real; the conflict is only about the tax fill");
    assert.equal(rec.existingExpense.taxAmount, null, "an OCR figure that would break the CHECK is never written");
    assert.equal(rec.existingExpense.taxAtSource, false);
    assert.equal(rec.existingExpense.taxSource, null, "provenance is untouched — nothing was decided");
    assert.equal(rec.existingExpense.taxDeductibleBase, 100, "the human's base stands");
    assert.equal(rec.existingExpense.needsTaxReview, true, "a person resolves the conflict instead");
});

test("an OCR tax that fits inside a manual deduction base's ceiling is booked normally", async () => {
    // The control for the test above: same manually-set base, but small
    // enough that amount - taxAmount never dips below it.
    const rec = recorder();
    rec.existingExpense = onThisJob({ amount: 100, taxDeductibleBase: 50, needsTaxReview: false });
    const result = await bookReceipt(row({ totalCents: 10_000, taxCents: 900 }), rec.deps);
    assert.equal(result.outcome, "booked");
    assert.equal(rec.existingExpense.taxAmount, 9);
    assert.equal(rec.existingExpense.taxAtSource, true);
    assert.equal(rec.existingExpense.taxSource, "ocr");
    assert.equal(rec.existingExpense.taxDeductibleBase, 50, "the base is untouched by this write");
    assert.equal(rec.existingExpense.needsTaxReview, false);
});

// ── the two provenances do not gate each other (round 16, item 1) ──────────

test("an ANSWERED installedAtCustomer is never overwritten, whatever taxSource says", async () => {
    // Its own value is the evidence: non-null means a person answered. This is
    // the "no" case, which is the one that costs money if it is flipped — a
    // false reads as "not resold" and keeps the receipt off the excise return.
    const rec = recorder();
    rec.existingExpense = onThisJob({ installedAtCustomer: false });
    await bookReceipt(row({ installedAtCustomer: true }), rec.deps);
    assert.equal(rec.existingExpense.installedAtCustomer, false, "their answer stands");
});

test("a manual TAX figure does not block the capture's excise answer", async () => {
    // The cross-field regression: `taxSource: "manual"` guards taxAmount and
    // taxDeductibleBase. Letting it also guard installedAtCustomer meant a
    // bookkeeper correcting a tax figure silently stopped every later capture
    // from answering a question they never touched.
    const rec = recorder();
    rec.existingExpense = onThisJob({ taxAmount: 16.55, taxAtSource: true, taxSource: "manual" });
    await bookReceipt(row(), rec.deps);
    assert.equal(rec.existingExpense.installedAtCustomer, true, "the capture answers it");
    assert.equal(rec.existingExpense.taxAmount, 16.55, "and their figure is untouched");
    assert.equal(rec.existingExpense.taxSource, "manual");
});

// ── the phase is held still across the money write (round 16, item 2) ──────

test("a phase REMOVED between the read and the write parks, it does not book", async () => {
    // Deterministic interleaving on the window that matters. The code was a
    // phase of this job at both earlier checks; a person deletes it from the
    // estimate while the booking transaction runs.
    //
    // Booking it would post money to a line the job no longer has. Booking it
    // UNCODED would silently discard a phase a person captured. Neither is this
    // pipeline's call, and the Purchase already exists — so the row parks.
    let asked = 0;
    const rec = recorder({
        isCostCodeAllowed: async () => {
            asked += 1;
            return asked < 3; // valid before the send and after it, gone by the write
        },
    });
    const result = await bookReceipt(row({ costCodeId: "cc-demo" }), rec.deps);

    assert.equal(asked, 3, "asked again inside the transaction");
    assert.equal(result.outcome, "needs-review");
    if (result.outcome === "needs-review") {
        // Its OWN reason, not an expense-conflict: nothing about the existing
        // Expense is wrong, and the fix is a person re-phasing the row.
        assert.equal(result.reason, "phase-changed:not-a-phase");
        assert.equal(result.releaseStrongKey, false, "the Purchase exists — keep the key");
    }
    assert.equal(rec.expenses.length, 0, "no Expense was written");
    assert.equal(
        rec.intakeUpdates.filter((update: any) => update.state === "BOOKED").length, 0,
        "and nothing was marked BOOKED",
    );
});

test("the in-transaction check happens AFTER the phase rows are locked", async () => {
    // Asking before the lock answers about a moment the lock then fails to
    // preserve — the whole point of taking it.
    const order: string[] = [];
    const rec = recorder({
        isCostCodeAllowed: async () => {
            order.push("ask");
            return true;
        },
    });
    const passThrough = (rec.deps.db as any).$queryRawUnsafe;
    (rec.deps.db as any).$queryRawUnsafe = async (query: string, ...args: any[]) => {
        // The PHASE locks specifically. The attribution pair takes its own
        // FOR SHARE on the estimate at the create site (round 21, item 1),
        // which is a different question and must not be counted as one of
        // these.
        if (query.includes("FOR SHARE") && !/FROM "Estimate" WHERE id = \$1 FOR SHARE/.test(query)) {
            order.push("phase-share");
        }
        return passThrough(query, ...args);
    };
    await bookReceipt(row({ costCodeId: "cc-demo" }), rec.deps);
    // ask (pre-send), ask (post-create), then the share locks, and only then
    // the question that decides the write.
    assert.deepEqual(order.slice(0, 2), ["ask", "ask"]);
    const lastShare = order.lastIndexOf("phase-share");
    assert.ok(lastShare > 1, "the locks come after the two stateless checks");
    assert.equal(order[order.length - 1], "ask", "and the decisive question comes last");
    assert.equal(
        order.filter(entry => entry === "ask").length, 3,
        "asked once more, inside the transaction",
    );
});

test("a row with NO phase is not parked by this check", async () => {
    // Nothing to revalidate, so the extra question is not even asked — and an
    // uncoded receipt still books, exactly as before.
    let asked = 0;
    const rec = recorder({
        isCostCodeAllowed: async () => {
            asked += 1;
            return false; // the captured code was never a phase of this job
        },
    });
    const result = await bookReceipt(row({ costCodeId: "cc-from-another-job" }), rec.deps);
    assert.equal(result.outcome, "booked", "it books UNCODED, as it always did");
    assert.equal(asked, 2, "no third question once there is no code left to check");
    assert.equal(rec.expenses[0].costCodeId, null);
});

// ── a machine's capture is not a human's (round 18, item 3) ────────────────

test("a phase captured by a PERSON books as untouchable 'capture'", async () => {
    const rec = recorder();
    await bookReceipt(row({ costCodeId: "cc-demo", costCodeSource: "user" }), rec.deps);
    assert.equal(rec.expenses[0].costCodeId, "cc-demo");
    assert.equal(rec.expenses[0].costCodeSource, "capture");
});

test("a phase captured by a FORWARDER books as correctable 'machine'", async () => {
    // A Drive folder name is a guess. Booking it as "capture" gave it exactly
    // the authority of a person who picked it, and froze it against every later
    // pass that could have corrected it.
    const rec = recorder();
    await bookReceipt(row({ costCodeId: "cc-demo", costCodeSource: "machine" }), rec.deps);
    assert.equal(rec.expenses[0].costCodeId, "cc-demo");
    assert.equal(rec.expenses[0].costCodeSource, "machine");
});

test("a row captured before the column existed is treated as a machine guess", async () => {
    // The safe direction: it leaves the phase correctable rather than freezing
    // an unattributed guess in place forever.
    const rec = recorder();
    await bookReceipt(row({ costCodeId: "cc-demo", costCodeSource: null }), rec.deps);
    assert.equal(rec.expenses[0].costCodeSource, "machine");
});

// ── a recovered row gets its receipt link (round 18, item 6) ───────────────

test("an existing Expense with NO receiptUrl is given one", async () => {
    // v1 created plenty of these, and a crash between the Purchase and the
    // commit leaves one too. A receipt nobody can open is the difference
    // between a defensible deduction and a number in a spreadsheet.
    const rec = recorder();
    rec.existingExpense = onThisJob({ receiptUrl: null });
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "booked");
    assert.ok(rec.existingExpense.receiptUrl, "the link is filled");
});

test("an EXISTING receiptUrl is never replaced", async () => {
    // Somebody may have fixed it by hand, or an earlier pass wrote a better
    // one. The guard is the predicate, so a value that appears between the read
    // and the write survives as well.
    const rec = recorder();
    rec.existingExpense = onThisJob({
        receiptUrl: "https://drive.google.com/file/d/HAND-FIXED/view",
    });
    await bookReceipt(row(), rec.deps);
    assert.equal(
        rec.existingExpense.receiptUrl,
        "https://drive.google.com/file/d/HAND-FIXED/view",
        "the existing link stands",
    );
});

// ── the attribution is filled as a PAIR (round 20, item 3) ─────────────────

test("an alreadyExists row gets BOTH halves of the attribution", async () => {
    // Writing `projectId` alone onto a row whose `estimateId` came from v1 (or
    // an estimate deletion) leaves an expense claiming two jobs: the column
    // says one thing, every join through the estimate says another.
    //
    // A row pointing at a DIFFERENT estimate does not reach here at all — that
    // is `expense-conflict:estimate`, above — so the pair fill is for the row
    // that has NO estimate to disagree with, which is what `onDelete: SetNull`
    // leaves behind.
    const rec = recorder();
    rec.existingExpense = phase3Expense({ estimateId: null });
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "booked");
    const fill = fillData(rec);
    assert.equal(fill.projectId, "proj-1");
    assert.equal(fill.estimateId, "est-1", "the estimate this booking resolved");
    // ONE statement, both columns — never one without the other.
    const pairWrite = rec.expenseUpdates.find((u: any) => "projectId" in (u.data ?? {}));
    assert.ok(pairWrite && "estimateId" in pairWrite.data, "the pair moves together");
    assert.equal(pairWrite.where.projectId, null, "and only onto a row that has no job yet");
});

test("an estimate REASSIGNED under the fill parks instead of half-writing", async () => {
    // The locked read is the first thing that can see the move. Filling
    // `projectId` from the intake row while the estimate now belongs elsewhere
    // is the two-jobs-at-once state, so nobody is booked.
    const rec = recorder();
    rec.state.estimateProjectId = "another-job";
    rec.existingExpense = phase3Expense();
    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "needs-review");
    if (result.outcome === "needs-review") {
        assert.equal(result.reason, "expense-conflict:attribution");
        assert.equal(result.releaseStrongKey, false, "the Purchase exists");
    }
    assert.equal(
        rec.intakeUpdates.filter((u: any) => u.state === "BOOKED").length, 0,
        "and nothing was marked BOOKED",
    );
});

test("a phase CLEARED between the read and the fill is not overrun either", async () => {
    // THE SQL GUARD ON ITS OWN. The reconcile refuses to offer a phase for a
    // row whose READ already said "a human decided" — but the read is not the
    // last word: a bookkeeper can clear the phase in the gap between it and
    // the write. Then the decision was made from a legacy-looking row and only
    // `notHumanCodedExpenseWhere()` in the predicate stands between the
    // machine's suggestion and the person's clear.
    const rec = recorder();
    rec.existingExpense = onThisJob();
    const seenByBooking = { ...rec.existingExpense };
    let reads = 0;
    (rec.deps.db as any).expense.findUnique = async () => {
        reads += 1;
        if (reads === 1) return { id: "expense-1" };
        if (reads > 2) return rec.existingExpense;
        // The PATCH lands: the phase is cleared, deliberately, by a person.
        rec.existingExpense = {
            ...rec.existingExpense,
            costCodeId: null,
            costCodeSource: "manual-none",
        };
        return seenByBooking;
    };

    const result = await bookReceipt(row(), rec.deps);
    assert.equal(result.outcome, "booked");
    // The fill WAS attempted from the stale read — that is the premise — and
    // the predicate is what made it match zero rows.
    const attempted = rec.expenseUpdates.find((u: any) => "costCodeId" in (u.data ?? {}));
    assert.ok(attempted, "the write was issued");
    assert.equal(rec.existingExpense.costCodeId, null, "and the clear survived it");
    assert.equal(rec.existingExpense.costCodeSource, "manual-none");
});
