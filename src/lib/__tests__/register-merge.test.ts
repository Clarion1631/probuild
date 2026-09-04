import assert from "node:assert/strict";
import test from "node:test";
import {
    mergeRegister,
    classifyOrphanReceipts,
    actionableOrphanReceipts,
    decimalToCents,
    type RegisterMergeExpense,
    type RegisterMergeReceiptEvent,
    type RegisterMergeClassification,
} from "../register-merge";
import type { BankRegisterRow } from "../qbo-bank-register";
import { isPurchaseType, isMoneyInType } from "../register-types";

// ── Fixtures ─────────────────────────────────────────────────────────────

function row(overrides: Partial<BankRegisterRow> = {}): BankRegisterRow {
    return {
        date: "2026-07-15",
        qbType: "Expense",
        qbTxnId: "purchase-1",
        docNum: "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
        name: "Home Depot",
        // The GL memo cell: usually the original POS descriptor. Absent here.
        memo: null,
        amountCents: -15000,
        // These fixtures are about merge/verdict classification, not clearance.
        clearedStatus: "Unknown",
        ...overrides,
    };
}

function expense(overrides: Partial<RegisterMergeExpense> = {}): RegisterMergeExpense {
    return {
        qbPurchaseId: "purchase-1",
        // string, not number — RegisterMergeExpense.amount no longer accepts
        // number (see decimalToCents's number-rejection fix).
        amount: "150.00",
        receiptUrl: "https://drive.example/receipt.pdf",
        estimate: { project: { id: "project-1", name: "Mueller Remodel" } },
        ...overrides,
    };
}

function receiptPushEvent(overrides: Partial<RegisterMergeReceiptEvent> = {}): RegisterMergeReceiptEvent {
    return {
        kind: "receipt-push",
        status: "created",
        qbPurchaseId: "purchase-1",
        driveFileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890-full-id",
        docNumber: "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
        fileName: "receipt.jpg",
        vendor: "Home Depot",
        amountCents: 15000,
        reason: null,
        createdAt: "2026-07-15T12:00:00.000Z",
        ...overrides,
    };
}

function classification(overrides: Partial<RegisterMergeClassification> = {}): RegisterMergeClassification {
    return {
        qbPurchaseId: "purchase-1",
        classification: "job-cost",
        reason: null,
        ...overrides,
    };
}

function mergeOne(
    r: BankRegisterRow,
    opts: {
        expenses?: RegisterMergeExpense[];
        receiptEvents?: RegisterMergeReceiptEvent[];
        classifications?: RegisterMergeClassification[];
    } = {},
) {
    const result = mergeRegister(
        [r],
        opts.expenses ?? [],
        opts.receiptEvents ?? [],
        opts.classifications ?? [],
    );
    return result.rows[0];
}

// ── Status matrix (plan §2), row by row ─────────────────────────────────────

test("documented: purchase-like, non-null id, amount<0, all edges pass, classified job-cost", () => {
    const merged = mergeOne(row(), {
        expenses: [expense()],
        receiptEvents: [receiptPushEvent()],
        classifications: [classification()],
    });
    assert.equal(merged.status, "documented");
    assert.equal(merged.edges?.receipt, "pass");
    assert.equal(merged.edges?.jobCost, "pass");
    assert.equal(merged.edges?.amount, "pass");
    assert.equal(merged.projectName, "Mueller Remodel");
});

test("job-cost-matched: receipt edge unknown (no push event) but job-cost/amount both pass -> job-cost-matched, not needs-review", () => {
    const merged = mergeOne(row(), {
        expenses: [expense()],
        receiptEvents: [],
        classifications: [classification()],
    });
    assert.equal(merged.edges?.receipt, "unknown");
    assert.equal(merged.status, "job-cost-matched");

    // Call mergeRegister directly (mergeOne only returns rows[0]) to also
    // assert on the roll-up counts: job-cost-matched is kept out of both
    // `documented` and `needsReview`, and counted separately.
    const { counts } = mergeRegister([row()], [expense()], [], [classification()]);
    assert.equal(counts.documented, 0);
    assert.equal(counts.needsReview, 0);
    assert.equal(counts.receiptProvenanceUnverified, 1);
    assert.equal(counts.denominator, 1);
});

test("needs-review: job-cost edge fails (no Expense record) -> amount is n/a, not fail", () => {
    const merged = mergeOne(row(), {
        expenses: [],
        receiptEvents: [receiptPushEvent()],
        classifications: [classification()],
    });
    assert.equal(merged.edges?.jobCost, "fail");
    assert.equal(merged.edges?.amount, "n/a");
    assert.equal(merged.status, "needs-review");
});

test("needs-review: amount edge fails on a cent mismatch", () => {
    const merged = mergeOne(row({ amountCents: -15001 }), {
        expenses: [expense({ amount: "150.00" })], // 150.00 != 150.01
        receiptEvents: [receiptPushEvent()],
        classifications: [classification()],
    });
    assert.equal(merged.edges?.jobCost, "pass");
    assert.equal(merged.edges?.amount, "fail");
    assert.equal(merged.status, "needs-review");
});

// ── decimalToCents: cent-exact parsing, never through a lossy float multiply ─

test("decimalToCents: normal exact match parses string input to cents", () => {
    assert.equal(decimalToCents("19.99"), 1999);
    // number inputs are no longer accepted — always indeterminate (null),
    // never silently converted (see the number-rejection tests below).
    assert.equal(decimalToCents(150 as unknown as string), null);
});

test("decimalToCents: values with trailing zeros parse correctly", () => {
    assert.equal(decimalToCents("150.00"), 15000);
    assert.equal(decimalToCents("10.10"), 1010);
    // number input — always indeterminate now, not silently converted.
    assert.equal(decimalToCents(10.20 as unknown as string), null);
});

test("decimalToCents: negative values parse with the sign preserved", () => {
    assert.equal(decimalToCents("-42.50"), -4250);
    // number input — always indeterminate now, not silently converted.
    assert.equal(decimalToCents(-1.5 as unknown as string), null);
});

test("decimalToCents: number input is always indeterminate (null), never a valid parse path", () => {
    // `number` is not an accepted input — the TS signature no longer types
    // it, and at runtime it always resolves to null (see decimalToCents's
    // number short-circuit). A string of the same digits still parses fine.
    assert.equal(decimalToCents(150 as unknown as string), null);
    assert.equal(decimalToCents("150"), 15000);
    assert.equal(decimalToCents("29.99"), 2999);
});

test("decimalToCents: a Decimal-like object (only has toString()) parses the same as a plain string", () => {
    const decimalLike = { toString: () => "42.75" };
    assert.equal(decimalToCents(decimalLike), 4275);
});

test("decimalToCents: fractional-cent input (more than 2 fractional digits) is indeterminate (null), never silently rounded — this is the exact shape of value that made Math.round(10.075 * 100) wrongly return 1007 instead of 1008", () => {
    // number input — always null via the number short-circuit now, still
    // asserted here for continuity with the string case below.
    assert.equal(decimalToCents(10.075 as unknown as string), null);
    assert.equal(decimalToCents("10.999"), null);
});

test("decimalToCents: non-finite or unparseable values are indeterminate (null)", () => {
    // NaN/Infinity are numbers — null via the number short-circuit now,
    // rather than the old finite check, but the result is unchanged.
    assert.equal(decimalToCents(NaN as unknown as string), null);
    assert.equal(decimalToCents(Infinity as unknown as string), null);
    assert.equal(decimalToCents("not-a-number"), null);
    assert.equal(decimalToCents("1e21"), null);
});

test("decimalToCents: magnitude beyond Number.MAX_SAFE_INTEGER cents is indeterminate (null)", () => {
    assert.equal(decimalToCents("999999999999999999.00"), null);
});

test("decimalToCents: a number input can never produce a false exact match — JS has already lost precision on the literal before the function runs", () => {
    // The string form correctly fails closed (>2 fractional digits). The
    // equivalent number LITERAL is rounded by JS to `2` at parse time —
    // before decimalToCents ever sees it — so the old number-conversion
    // path returned the false "exact" answer 200. The number path must
    // never resolve to anything but null now.
    assert.equal(decimalToCents("1.99999999999999999"), null);
    assert.equal(decimalToCents(1.99999999999999999 as unknown as string), null);

    // The string form parses to exact cents; the equivalent number literal
    // has already lost precision internally by the time it reaches this
    // function. The number path must return null, never a numerically
    // different "exact" answer like 9007199254740990.
    assert.equal(decimalToCents("90071992547409.91"), 9007199254740991);
    assert.equal(decimalToCents(90071992547409.91 as unknown as string), null);
});

// ── register-types.ts: classification is exposed only via predicate ────────
// functions, never as an exported mutable Set. `PURCHASE_TYPES` /
// `MONEY_IN_TYPES` are module-private now — there is nothing left to import
// and `.add()`/`.delete()` on, so external mutation of classification
// behavior is a TypeScript compile error, not a runtime concern to assert
// against. The test below is a structural + stability proof instead: the
// exports are plain functions (no mutator methods to call), and repeated
// calls for known types keep returning the same answer.
test("isPurchaseType / isMoneyInType are exported as pure functions, and classification is stable across repeated calls", () => {
    assert.equal(typeof isPurchaseType, "function");
    assert.equal(typeof isMoneyInType, "function");

    for (let i = 0; i < 3; i++) {
        assert.equal(isPurchaseType("Expense"), true);
        assert.equal(isMoneyInType("Expense"), false);
        assert.equal(isPurchaseType("Deposit"), false);
        assert.equal(isMoneyInType("Deposit"), true);
        assert.equal(isPurchaseType("Some Future Type"), false);
        assert.equal(isMoneyInType("Some Future Type"), false);
    }
});

test("decimalToCents: a Decimal-like object whose toString() throws returns null, not an uncaught exception", () => {
    const throwingDecimal = { toString: () => { throw new Error("boom"); } };
    assert.equal(decimalToCents(throwingDecimal), null);
});

test("decimalToCents: Decimal.js-style exponential notation fails closed to null (DECIMAL_PATTERN has no e/E support)", () => {
    const largeExponential = { toString: () => "1.234e+21" };
    const smallExponential = { toString: () => "1e-7" };
    assert.equal(decimalToCents(largeExponential), null);
    assert.equal(decimalToCents(smallExponential), null);
});

test("needs-review: expense amount with a fractional-cent value is an indeterminate amount edge, never a silent pass or a plain fail", () => {
    const merged = mergeOne(row(), {
        expenses: [expense({ amount: "150.075" })],
        receiptEvents: [receiptPushEvent()],
        classifications: [classification()],
    });
    assert.equal(merged.edges?.jobCost, "pass");
    assert.equal(merged.edges?.amount, "indeterminate");
    assert.equal(merged.status, "needs-review");
    assert.match(merged.label, /could not be parsed/i);
});

test("not-applicable: overhead classification is expected non-job spend, not needs-review, even with no receipt/job-cost evidence", () => {
    const merged = mergeOne(row(), {
        expenses: [],
        receiptEvents: [],
        classifications: [classification({ classification: "overhead" })],
    });
    assert.equal(merged.status, "not-applicable");
    assert.equal(merged.expectedNonJobSpend, true);
});

test("not-applicable: owner-draw classification is expected non-job spend", () => {
    const merged = mergeOne(row(), {
        classifications: [classification({ classification: "owner-draw" })],
    });
    assert.equal(merged.status, "not-applicable");
    assert.equal(merged.expectedNonJobSpend, true);
});

test("needs-review: classification conflict — overhead classification but a matched, job-costed Expense contradicts it", () => {
    const merged = mergeOne(row(), {
        expenses: [expense()], // matches on qbPurchaseId -> jobCost edge passes
        classifications: [classification({ classification: "overhead" })],
    });
    assert.equal(merged.edges?.jobCost, "pass");
    assert.equal(merged.status, "needs-review");
    assert.equal(merged.expectedNonJobSpend, false);
    assert.match(merged.label, /classification conflict/i);
});

test("needs-review: classification conflict — owner-draw classification but a matched, job-costed Expense contradicts it", () => {
    const merged = mergeOne(row(), {
        expenses: [expense()],
        classifications: [classification({ classification: "owner-draw" })],
    });
    assert.equal(merged.edges?.jobCost, "pass");
    assert.equal(merged.status, "needs-review");
    assert.equal(merged.expectedNonJobSpend, false);
    assert.match(merged.label, /classification conflict/i);
});

test("classification conflict rows are included in the denominator (unlike ordinary overhead/owner-draw)", () => {
    const rows: BankRegisterRow[] = [
        row({ qbTxnId: "p-conflict" }),
        row({ qbTxnId: "p-ordinary-overhead", amountCents: -1000 }),
    ];
    const expenses: RegisterMergeExpense[] = [
        expense({ qbPurchaseId: "p-conflict", amount: "150.00" }),
        // p-ordinary-overhead deliberately has NO matching Expense
    ];
    const classifications: RegisterMergeClassification[] = [
        classification({ qbPurchaseId: "p-conflict", classification: "overhead" }),
        classification({ qbPurchaseId: "p-ordinary-overhead", classification: "overhead" }),
    ];
    const { rows: merged, counts } = mergeRegister(rows, expenses, [], classifications);

    const conflictRow = merged.find(r => r.qbTxnId === "p-conflict");
    const ordinaryRow = merged.find(r => r.qbTxnId === "p-ordinary-overhead");
    assert.equal(conflictRow?.status, "needs-review");
    assert.equal(ordinaryRow?.status, "not-applicable");

    assert.equal(counts.denominator, 1); // only the conflict row
    assert.equal(counts.needsReview, 1);
    assert.equal(counts.notApplicable, 1);
    assert.equal(counts.expectedNonJobSpend, 1); // the ordinary overhead row only
});

test("needs-review: unclassified purchase is never documented and never hidden, even with all edges passing", () => {
    const merged = mergeOne(row(), {
        expenses: [expense()],
        receiptEvents: [receiptPushEvent()],
        classifications: [], // no classification record at all
    });
    assert.equal(merged.classification, "unknown");
    assert.equal(merged.status, "needs-review");
});

test("needs-review: explicit classification=unknown record behaves the same as no record", () => {
    const merged = mergeOne(row(), {
        expenses: [expense()],
        receiptEvents: [receiptPushEvent()],
        classifications: [classification({ classification: "unknown" })],
    });
    assert.equal(merged.status, "needs-review");
});

test("unclassifiable: zero-amount purchase-like row is not spend and stays unclassifiable", () => {
    const merged = mergeOne(row({ amountCents: 0 }), {
        classifications: [classification()],
    });
    assert.equal(merged.status, "unclassifiable");
});

test("needs-review: positive amount on a purchase-type row is a reversal, labelled money came back", () => {
    const merged = mergeOne(row({ amountCents: 15000 }), {
        classifications: [classification()],
    });
    assert.equal(merged.status, "needs-review");
    assert.match(merged.label, /came back/i);
});

test("unclassifiable: null qbTxnId cannot be joined to anything", () => {
    const merged = mergeOne(row({ qbTxnId: null }), {
        expenses: [expense()],
        receiptEvents: [receiptPushEvent()],
        classifications: [classification()],
    });
    assert.equal(merged.status, "unclassifiable");
    assert.equal(merged.edges, null);
    assert.equal(merged.classification, null);
});

test("not-applicable: known money-in type with positive amount", () => {
    const merged = mergeOne(row({ qbType: "Deposit", qbTxnId: null, amountCents: 5000 }));
    assert.equal(merged.status, "not-applicable");
});

test("needs-review: known money-in type posted negative is a sign/type conflict", () => {
    const merged = mergeOne(row({ qbType: "Deposit", qbTxnId: null, amountCents: -5000 }));
    assert.equal(merged.status, "needs-review");
    assert.match(merged.label, /sign\/type conflict/i);
});

test("not-applicable: Transfer, Journal Entry, tax payment, and bill payment are typed not-applicable regardless of sign", () => {
    for (const qbType of ["Transfer", "Journal Entry", "WA State Tax Payment", "Bill Payment (Check)"]) {
        const merged = mergeOne(row({ qbType, qbTxnId: null, amountCents: -1000 }));
        assert.equal(merged.status, "not-applicable", `expected not-applicable for ${qbType}`);
    }
});

test("needs-review: Refund Receipt with a negative amount is an unrecognized outflow", () => {
    const merged = mergeOne(row({ qbType: "Refund Receipt", qbTxnId: null, amountCents: -2000 }));
    assert.equal(merged.status, "needs-review");
});

test("needs-review: any other unrecognized type with a negative amount is an unrecognized outflow", () => {
    const merged = mergeOne(row({ qbType: "Some Future QBO Type", qbTxnId: null, amountCents: -2000 }));
    assert.equal(merged.status, "needs-review");
});

test("not-applicable: unrecognized other type with a positive amount is money in", () => {
    const merged = mergeOne(row({ qbType: "Some Future QBO Type", qbTxnId: null, amountCents: 2000 }));
    assert.equal(merged.status, "not-applicable");
});

// ── Denominator ──────────────────────────────────────────────────────────────

test("denominator excludes overhead/owner-draw, zero-amount, and positive reversals, but includes unclassified and needs-review job-cost rows", () => {
    const rows: BankRegisterRow[] = [
        row({ qbTxnId: "p-documented" }),
        row({ qbTxnId: "p-overhead", amountCents: -1000 }),
        row({ qbTxnId: "p-zero", amountCents: 0 }),
        row({ qbTxnId: "p-reversal", amountCents: 15000 }),
        row({ qbTxnId: "p-unclassified", amountCents: -2000 }),
        row({ qbTxnId: "p-needs-review", amountCents: -3000 }), // job-cost but missing evidence
    ];
    const expenses: RegisterMergeExpense[] = [
        expense({ qbPurchaseId: "p-documented", amount: "150.00" }),
    ];
    const receiptEvents: RegisterMergeReceiptEvent[] = [
        receiptPushEvent({ qbPurchaseId: "p-documented" }),
    ];
    const classifications: RegisterMergeClassification[] = [
        classification({ qbPurchaseId: "p-documented" }),
        classification({ qbPurchaseId: "p-overhead", classification: "overhead" }),
        classification({ qbPurchaseId: "p-zero" }),
        classification({ qbPurchaseId: "p-reversal" }),
        classification({ qbPurchaseId: "p-needs-review" }),
        // p-unclassified deliberately has no classification record
    ];

    const { counts } = mergeRegister(rows, expenses, receiptEvents, classifications);

    // Denominator = documented + unclassified(needs-review) + needs-review(job-cost, missing evidence) = 3
    assert.equal(counts.denominator, 3);
    assert.equal(counts.documented, 1);
    assert.equal(counts.expectedNonJobSpend, 1);
    assert.equal(counts.unknownClassification, 1);
    assert.equal(counts.unclassifiable, 1); // p-zero
    assert.equal(counts.needsReview, 3); // p-reversal, p-unclassified, p-needs-review
    assert.equal(counts.notApplicable, 1); // p-overhead
});

// ── Prefix-collision fallback ────────────────────────────────────────────────

test("prefix-collision fallback: legacy event matched only by docNumber prefix stays unknown, unconfirmed, never pass", () => {
    const legacyEvent = receiptPushEvent({
        qbPurchaseId: null, // not yet backfilled with the typed column
        driveFileId: null,  // legacy event, written before dual-write
        docNumber: "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
    });
    const merged = mergeOne(row(), {
        expenses: [expense()],
        receiptEvents: [legacyEvent],
        classifications: [classification()],
    });
    assert.equal(merged.edges?.receipt, "unknown");
    assert.equal(merged.edges?.receiptUnconfirmed, true);
    // A prefix-only hit must never let the row reach "documented".
    assert.notEqual(merged.status, "documented");
});

test("prefix-collision fallback does not fire when the row has no docNum to compare against", () => {
    const legacyEvent = receiptPushEvent({ qbPurchaseId: null, driveFileId: null, docNumber: "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890" });
    const merged = mergeOne(row({ docNum: null }), {
        receiptEvents: [legacyEvent],
        classifications: [classification()],
    });
    assert.equal(merged.edges?.receipt, "unknown");
    assert.equal(merged.edges?.receiptUnconfirmed, false);
});

// ── Orphan receipts — three-valued ───────────────────────────────────────────

test("orphan: reconciled when the journey's qbPurchaseId matches a purchase-like register row", () => {
    const events = [receiptPushEvent({ qbPurchaseId: "purchase-1", status: "created" })];
    const [orphan] = classifyOrphanReceipts(events, [row({ qbTxnId: "purchase-1" })]);
    assert.equal(orphan.classification, "reconciled");
});

test("orphan: exception when a parked/quarantined/errored/email-booked journey has a full driveFileId and no register match", () => {
    for (const status of ["parked", "quarantined", "error", "emailed"]) {
        const events = [receiptPushEvent({
            kind: "receipt-stage",
            status,
            qbPurchaseId: null,
            driveFileId: `full-id-${status}`,
            docNumber: null,
        })];
        const [orphan] = classifyOrphanReceipts(events, []);
        assert.equal(orphan.classification, "exception", `expected exception for status ${status}`);
        assert.equal(orphan.unconfirmed, false);
    }
});

test("orphan: no audit evidence at all stays unknown, never orphaned", () => {
    // No receipt events whatsoever, nothing to classify.
    const orphans = classifyOrphanReceipts([], [row({ qbTxnId: "purchase-1" })]);
    assert.deepEqual(orphans, []);
    assert.deepEqual(actionableOrphanReceipts(orphans), []);
});

test("orphan: an in-flight journey (seen but no terminal exception status, no register match) stays unknown, not exception", () => {
    const events = [receiptPushEvent({
        kind: "receipt-stage",
        status: "ok",
        qbPurchaseId: null,
        driveFileId: "full-id-inflight",
        docNumber: null,
    })];
    const [orphan] = classifyOrphanReceipts(events, []);
    assert.equal(orphan.classification, "unknown");
});

test("orphan: docNumber-prefix-only grouping (no driveFileId ever observed) can never become exception, even with a terminal status", () => {
    const events = [receiptPushEvent({
        kind: "receipt-stage",
        status: "parked",
        qbPurchaseId: null,
        driveFileId: null,
        docNumber: "prefix-only-doc-number",
    })];
    const [orphan] = classifyOrphanReceipts(events, []);
    assert.equal(orphan.unconfirmed, true);
    assert.equal(orphan.classification, "unknown");
});

test("actionableOrphanReceipts returns exceptions only", () => {
    const events: RegisterMergeReceiptEvent[] = [
        receiptPushEvent({ qbPurchaseId: "purchase-1", driveFileId: "full-1", docNumber: null }),
        receiptPushEvent({ kind: "receipt-stage", status: "parked", qbPurchaseId: null, driveFileId: "full-2", docNumber: null }),
        receiptPushEvent({ kind: "receipt-stage", status: "ok", qbPurchaseId: null, driveFileId: "full-3", docNumber: null }),
    ];
    const orphans = classifyOrphanReceipts(events, [row({ qbTxnId: "purchase-1" })]);
    const actionable = actionableOrphanReceipts(orphans);
    assert.equal(actionable.length, 1);
    assert.equal(actionable[0].key, "id:full-2");
});
