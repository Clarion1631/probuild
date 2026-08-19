import assert from "node:assert/strict";
import test from "node:test";
import { registerRowToLine } from "../scripts/post-qbo-register.mjs";

// Fixture note: synthetic QBO General Ledger rows shaped like the ones
// fetchBankRegister() returns for the WTB bank account. No real GTR data.
//
// These cases guard the QBO→ledger pipe found missing on 2026-08-19: prod had
// 51 STATEMENT observations and 0 QBO ones, so reconcile could never link
// anything and receipt-matching was starved.

const row = (over = {}) => ({
    date: "2026-08-12",
    qbType: "Expense",
    qbTxnId: "txn-1",
    docNum: null,
    name: "LOWES",
    amountCents: -1234,
    ...over,
});

/**
 * registerRowToLine returns `line | null` (null = a row with no transaction
 * identity). Most cases here expect a real line, so this narrows once and
 * fails the test loudly if the mapper unexpectedly skipped the row.
 */
function mapped(over = {}) {
    const line = registerRowToLine(row(over));
    assert.ok(line, "expected registerRowToLine to produce a line, got null");
    return line;
}

test("maps a normal expense row to an ingest line", () => {
    const line = mapped();
    assert.deepEqual(line, {
        postedDate: "2026-08-12",
        amountCents: -1234,
        rawDescriptor: "LOWES Expense",
        checkNumber: null,
        qbTxnId: "txn-1",
    });
});

test("rows without a transaction identity are skipped", async t => {
    await t.test("null qbTxnId (balance/summary row)", () => {
        assert.equal(registerRowToLine(row({ qbTxnId: null })), null);
    });
    await t.test("nothing to build a descriptor from", () => {
        assert.equal(registerRowToLine(row({ name: null, qbType: "", docNum: null })), null);
    });
    await t.test("whitespace-only name and type", () => {
        assert.equal(registerRowToLine(row({ name: "   ", qbType: "  ", docNum: "  " })), null);
    });
});

test("descriptor carries the payee name — reconcile normalizes it into a payee", () => {
    // An empty normalizedPayee is the EXCEPTION case in bank-ledger and never
    // matches anything, so the name must survive into the descriptor.
    const line = mapped({ name: "HOME DEPOT #4718", qbType: "Expense" });
    assert.ok(line.rawDescriptor.startsWith("HOME DEPOT #4718"));
});

test("internal whitespace is collapsed for hash stability", () => {
    // The daily CSV parser learned this the hard way: an unnormalized
    // descriptor turns a cosmetic spacing change into a false 409.
    const line = mapped({ name: "LOWES    #1632", qbType: "Expense" });
    assert.equal(line.rawDescriptor, "LOWES #1632 Expense");
    assert.ok(!/ {2}/.test(line.rawDescriptor));
});

test("doc number is NOT appended (see the Drive-file-id suite below)", () => {
    const line = mapped({ docNum: "1027" });
    assert.equal(line.rawDescriptor, "LOWES Expense");
});

test("doc_num NEVER enters the descriptor — it holds a Drive file id here", async t => {
    // Verified against live QBO 2026-08-19: on this realm doc_num carries a
    // Google Drive FILE ID stamped by the receipt pipeline (e.g.
    // "1sEISJBJaGRYpivooQJBR"), not a human doc number — the real txn id is a
    // short integer ("6625"). Splicing it into rawDescriptor would put an
    // opaque per-file identifier into the payee text, so the same vendor
    // re-filed under a new Drive id would look like a different payee and
    // never reconcile.
    await t.test("drive-file-id doc_num is absent from the descriptor", () => {
        const line = mapped({ docNum: "1sEISJBJaGRYpivooQJBR" });
        assert.equal(line.rawDescriptor, "LOWES Expense");
        assert.ok(!line.rawDescriptor.includes("1sEISJBJaGRYpivooQJBR"));
    });
    await t.test("and it is not mistaken for a check number", () => {
        const line = mapped({ docNum: "1sEISJBJaGRYpivooQJBR" });
        assert.equal(line.checkNumber, null);
    });
    await t.test("even a numeric doc_num stays out of the descriptor", () => {
        const line = mapped({ docNum: "1027" });
        assert.equal(line.rawDescriptor, "LOWES Expense");
    });
    await t.test("same vendor, different Drive ids → identical descriptor", () => {
        const a = mapped({ docNum: "1AAAAAAAAAAAAAAAAAAAA", qbTxnId: "6625" });
        const b = mapped({ docNum: "1BBBBBBBBBBBBBBBBBBBB", qbTxnId: "6626" });
        assert.equal(a.rawDescriptor, b.rawDescriptor);
    });
});

test("check numbers: one identity across all three parsers", async t => {
    await t.test("check-type row takes its number from docNum", () => {
        const line = mapped({ qbType: "Check", docNum: "1027" });
        assert.equal(line.checkNumber, "1027");
    });
    await t.test("leading zeros stripped (matches daily CSV + monthly PDF)", () => {
        const line = mapped({ qbType: "Check", docNum: "01027" });
        assert.equal(line.checkNumber, "1027");
    });
    await t.test("case-insensitive type match", () => {
        const line = mapped({ qbType: "check", docNum: "1027" });
        assert.equal(line.checkNumber, "1027");
    });
    await t.test("non-check row never claims a check number", () => {
        const line = mapped({ qbType: "Expense", docNum: "1027" });
        assert.equal(line.checkNumber, null);
    });
    await t.test("non-numeric docNum on a check is not a check number", () => {
        const line = mapped({ qbType: "Check", docNum: "EFT-99" });
        assert.equal(line.checkNumber, null);
    });
});

test("amounts pass through as signed integer cents, untouched", async t => {
    await t.test("money out stays negative", () => {
        assert.equal(mapped({ amountCents: -1234 }).amountCents, -1234);
    });
    await t.test("money in stays positive", () => {
        assert.equal(mapped({ amountCents: 565760, qbType: "Deposit" }).amountCents, 565760);
    });
    await t.test("zero is preserved", () => {
        assert.equal(mapped({ amountCents: 0 }).amountCents, 0);
    });
});

test("the posted date is passed through verbatim — no Date object, no tz shift", () => {
    const line = mapped({ date: "2026-01-01" });
    assert.equal(line.postedDate, "2026-01-01");
    assert.equal(typeof line.postedDate, "string");
});
