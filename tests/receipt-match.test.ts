import assert from "node:assert/strict";
import test from "node:test";
import {
    extractCardRail,
    matchReceipts,
    type ReceiptMatchBankLine,
    type ReceiptMatchExpense,
    type ReceiptMatchObservation,
} from "../src/lib/receipt-match";

// ── Fixture helpers ──────────────────────────────────────────────────────

function line(overrides: Partial<ReceiptMatchBankLine> = {}): ReceiptMatchBankLine {
    return {
        id: "bl1",
        state: "POSTED",
        postedDate: "2026-08-18",
        amountCents: -7400,
        rawDescriptor: "LOWES #00907* 866-483-7521 NC C#6098 DBT CRD",
        ...overrides,
    };
}

function obs(overrides: Partial<ReceiptMatchObservation> = {}): ReceiptMatchObservation {
    return {
        id: "obs1",
        source: "QBO_REGISTER",
        bankLineId: "bl1",
        sourceLineId: "qbo-txn-1",
        ...overrides,
    };
}

function expense(overrides: Partial<ReceiptMatchExpense> = {}): ReceiptMatchExpense {
    return {
        id: "exp1",
        qbPurchaseId: "qbo-txn-1",
        receiptUrl: "https://drive.google.com/file/d/receipt-1",
        ...overrides,
    };
}

// ── extractCardRail ──────────────────────────────────────────────────────

test("extractCardRail", async t => {
    await t.test("C#8516 → CJ", () => {
        assert.equal(extractCardRail("WM SUPERCENTER #5462 VANCOUVER WA C#8516 DBT CRD 1639"), "CJ");
    });

    await t.test("C#6098 → Richard", () => {
        assert.equal(extractCardRail("LOWES #00907* 866-483-7521 NC C#6098 DBT CRD 1038"), "Richard");
    });

    await t.test("tolerates a space after C# (matches normalizePayee's card-ref shape)", () => {
        assert.equal(extractCardRail("PAYPAL *CONSTRUCTIO C# 8516"), "CJ");
        assert.equal(extractCardRail("PAYPAL *CONSTRUCTIO C# 6098"), "Richard");
    });

    await t.test("CHECK PAID → check", () => {
        assert.equal(extractCardRail("CHECK PAID #1024"), "check");
    });

    await t.test("no card ref and no CHECK PAID → other", () => {
        assert.equal(extractCardRail("TRANS PMT 360 SHEFFIELD FI ADKINS JUSTIN T PPD"), "other");
        assert.equal(extractCardRail(""), "other");
    });

    await t.test("an unknown card number is other, not force-fit to a known card", () => {
        assert.equal(extractCardRail("SOME VENDOR C#4297 DBT CRD"), "other");
    });

    await t.test("is case-insensitive (defensive — WTB descriptors are uppercase)", () => {
        assert.equal(extractCardRail("lowes c#6098"), "Richard");
        assert.equal(extractCardRail("check paid #1024"), "check");
    });

    await t.test("a card ref takes precedence over CHECK PAID text in the same descriptor", () => {
        assert.equal(extractCardRail("CHECK PAID REVERSAL C#8516"), "CJ");
    });

    await t.test("BOTH card refs present identifies nobody → other, never a pattern-order guess", () => {
        assert.equal(extractCardRail("TRANSFER C#8516 TO C#6098"), "other");
    });

    await t.test("does not false-match a longer number containing 8516/6098", () => {
        assert.equal(extractCardRail("VENDOR C#85161 DBT CRD"), "other");
        assert.equal(extractCardRail("VENDOR C#60980 DBT CRD"), "other");
    });
});

// ── matchReceipts ────────────────────────────────────────────────────────

test("matchReceipts", async t => {
    await t.test("happy path: POSTED line + reconciled QBO obs + expense with receiptUrl → EVIDENCE_FOUND proposal", () => {
        const result = matchReceipts([line()], [obs()], [expense()]);
        assert.deepEqual(result, {
            proposals: [{ bankLineId: "bl1", receiptUrl: "https://drive.google.com/file/d/receipt-1", newState: "EVIDENCE_FOUND" }],
            unmatched: [],
            skipped: [],
        });
    });

    await t.test("proposals never carry amount fields (BankLine.amountCents is immutable)", () => {
        const result = matchReceipts([line()], [obs()], [expense()]);
        assert.deepEqual(Object.keys(result.proposals[0]).sort(), ["bankLineId", "newState", "receiptUrl"]);
    });

    await t.test("a line already past POSTED is skipped — never proposed, never on the missing-receipt list", () => {
        for (const state of ["EVIDENCE_FOUND", "TRANSACTION_CREATED", "MATCHED", "TAX_VALIDATED", "EXCEPTION"]) {
            const result = matchReceipts([line({ state })], [obs()], [expense()]);
            assert.deepEqual(result.proposals, [], `state ${state} must not produce a proposal`);
            assert.deepEqual(result.unmatched, [], `state ${state} must not land on the missing-receipt list`);
            assert.deepEqual(result.skipped, [{ bankLineId: "bl1", state }]);
        }
    });

    await t.test("no reconciled QBO observation → unmatched with reason no_qbo_link and full render fields", () => {
        const result = matchReceipts([line()], [], [expense()]);
        assert.deepEqual(result.proposals, []);
        assert.deepEqual(result.unmatched, [{
            bankLineId: "bl1",
            postedDate: "2026-08-18",
            amountCents: -7400,
            rawDescriptor: "LOWES #00907* 866-483-7521 NC C#6098 DBT CRD",
            cardRail: "Richard",
            reason: "no_qbo_link",
        }]);
    });

    await t.test("an observation reconciled to a DIFFERENT line does not vouch for this one", () => {
        const result = matchReceipts([line()], [obs({ bankLineId: "some-other-line" })], [expense()]);
        assert.equal(result.unmatched[0]?.reason, "no_qbo_link");
    });

    await t.test("an unreconciled observation (bankLineId null) does not count as a QBO link", () => {
        const result = matchReceipts([line()], [obs({ bankLineId: null })], [expense()]);
        assert.equal(result.unmatched[0]?.reason, "no_qbo_link");
    });

    await t.test("a non-QBO_REGISTER observation never counts as a QBO link, even when reconciled", () => {
        const result = matchReceipts([line()], [obs({ source: "STATEMENT" })], [expense()]);
        assert.equal(result.unmatched[0]?.reason, "no_qbo_link");
    });

    await t.test("QBO link but no expense row for that qbPurchaseId → qbo_link_no_receipt", () => {
        const result = matchReceipts([line()], [obs()], []);
        assert.deepEqual(result.proposals, []);
        assert.equal(result.unmatched[0]?.reason, "qbo_link_no_receipt");
    });

    await t.test("QBO link but the expense's receiptUrl is null → qbo_link_no_receipt", () => {
        const result = matchReceipts([line()], [obs()], [expense({ receiptUrl: null })]);
        assert.equal(result.unmatched[0]?.reason, "qbo_link_no_receipt");
    });

    await t.test("empty-string and whitespace-only receiptUrl are the same as absent", () => {
        assert.equal(matchReceipts([line()], [obs()], [expense({ receiptUrl: "" })]).unmatched[0]?.reason, "qbo_link_no_receipt");
        assert.equal(matchReceipts([line()], [obs()], [expense({ receiptUrl: "   " })]).unmatched[0]?.reason, "qbo_link_no_receipt");
    });

    await t.test("an expense with a null qbPurchaseId can never be joined", () => {
        const result = matchReceipts([line()], [obs()], [expense({ qbPurchaseId: null })]);
        assert.equal(result.unmatched[0]?.reason, "qbo_link_no_receipt");
    });

    await t.test("the proposed receiptUrl is trimmed", () => {
        const result = matchReceipts([line()], [obs()], [expense({ receiptUrl: "  https://drive.google.com/file/d/receipt-1  " })]);
        assert.equal(result.proposals[0]?.receiptUrl, "https://drive.google.com/file/d/receipt-1");
    });

    await t.test("duplicate expense rows with the SAME receiptUrl still propose (one distinct url)", () => {
        const result = matchReceipts(
            [line()],
            [obs()],
            [expense({ id: "exp1" }), expense({ id: "exp2" })],
        );
        assert.equal(result.proposals.length, 1);
        assert.deepEqual(result.unmatched, []);
    });

    await t.test("two DISTINCT receiptUrls for the same QBO purchase → no proposal, reason ambiguous_receipt_evidence (never guessed by input order)", () => {
        const result = matchReceipts(
            [line()],
            [obs()],
            [
                expense({ id: "exp1", receiptUrl: "https://drive.google.com/file/d/receipt-1" }),
                expense({ id: "exp2", receiptUrl: "https://drive.google.com/file/d/receipt-2" }),
            ],
        );
        assert.deepEqual(result.proposals, []);
        assert.equal(result.unmatched[0]?.reason, "ambiguous_receipt_evidence");
    });

    await t.test("two QBO observations resolving to different receipts is ambiguous, not first-wins", () => {
        const result = matchReceipts(
            [line()],
            [obs({ id: "obs1", sourceLineId: "qbo-txn-1" }), obs({ id: "obs2", sourceLineId: "qbo-txn-2" })],
            [
                expense({ id: "exp1", qbPurchaseId: "qbo-txn-1", receiptUrl: "https://drive.google.com/file/d/receipt-1" }),
                expense({ id: "exp2", qbPurchaseId: "qbo-txn-2", receiptUrl: "https://drive.google.com/file/d/receipt-2" }),
            ],
        );
        assert.deepEqual(result.proposals, []);
        assert.equal(result.unmatched[0]?.reason, "ambiguous_receipt_evidence");
    });

    await t.test("card rails render correctly on the unmatched list for both cards, a check, and other", () => {
        const lines = [
            line({ id: "cj", rawDescriptor: "WM SUPERCENTER C#8516 DBT CRD" }),
            line({ id: "rich", rawDescriptor: "LOWES #00907 C#6098 DBT CRD" }),
            line({ id: "chk", rawDescriptor: "CHECK PAID #1024" }),
            line({ id: "ach", rawDescriptor: "GUSTO NET PAYROLL CCD" }),
        ];
        const result = matchReceipts(lines, [], []);
        assert.deepEqual(
            result.unmatched.map(u => [u.bankLineId, u.cardRail]),
            [["cj", "CJ"], ["rich", "Richard"], ["chk", "check"], ["ach", "other"]],
        );
        assert.ok(result.unmatched.every(u => u.reason === "no_qbo_link"));
    });

    await t.test("mixed batch: one proposes, one lacks a link, one lacks a receipt, one is skipped", () => {
        const result = matchReceipts(
            [
                line({ id: "ok" }),
                line({ id: "nolink", rawDescriptor: "CHECK PAID #1024" }),
                line({ id: "noreceipt", rawDescriptor: "WM SUPERCENTER C#8516" }),
                line({ id: "done", state: "MATCHED" }),
            ],
            [
                obs({ id: "obs-ok", bankLineId: "ok", sourceLineId: "qbo-txn-1" }),
                obs({ id: "obs-nr", bankLineId: "noreceipt", sourceLineId: "qbo-txn-2" }),
            ],
            [
                expense({ qbPurchaseId: "qbo-txn-1" }),
                expense({ id: "exp2", qbPurchaseId: "qbo-txn-2", receiptUrl: null }),
            ],
        );
        assert.deepEqual(result.proposals, [{ bankLineId: "ok", receiptUrl: "https://drive.google.com/file/d/receipt-1", newState: "EVIDENCE_FOUND" }]);
        assert.deepEqual(
            result.unmatched.map(u => [u.bankLineId, u.reason, u.cardRail]),
            [["nolink", "no_qbo_link", "check"], ["noreceipt", "qbo_link_no_receipt", "CJ"]],
        );
        assert.deepEqual(result.skipped, [{ bankLineId: "done", state: "MATCHED" }]);
    });

    await t.test("empty inputs produce an empty result", () => {
        assert.deepEqual(matchReceipts([], [], []), { proposals: [], unmatched: [], skipped: [] });
        assert.deepEqual(matchReceipts([], [obs()], [expense()]), { proposals: [], unmatched: [], skipped: [] });
    });
});
