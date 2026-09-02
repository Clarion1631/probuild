import assert from "node:assert/strict";
import test from "node:test";
import {
    decimalStringToCents,
    payeeMatches,
    planReceiptRequests,
    receiptRequestFingerprint,
    bankLineIdFromFingerprint,
    type ReceiptEvidenceExpense,
    type ReceiptEvidenceIntake,
    type ReceiptRequestBankLine,
} from "../src/lib/receipt-requests";

// Spec §7 table, case for case. Synthetic descriptors in the shapes the 2026-08-19
// prod survey found; no real GTR data.

const NOW = new Date("2026-08-20T09:00:00Z");

const line = (over: Partial<ReceiptRequestBankLine> = {}): ReceiptRequestBankLine => ({
    id: "bl-1",
    postedDate: "2026-08-16", // 4 days before NOW
    amountCents: -12_345,
    rawDescriptor: "LOWES #02516 POS DEB C#8516",
    checkNumber: null,
    ...over,
});

const expense = (over: Partial<ReceiptEvidenceExpense> = {}): ReceiptEvidenceExpense => ({
    id: "exp-1",
    amountCents: 12_345,
    date: "2026-08-16",
    vendor: "Lowe's Home Improvement",
    ...over,
});

const intake = (over: Partial<ReceiptEvidenceIntake> = {}): ReceiptEvidenceIntake => ({
    id: "int-1",
    totalCents: 12_345,
    txnDate: "2026-08-16",
    vendor: "Lowes",
    state: "BOOKED",
    ...over,
});

function plan(over: {
    bankLines?: ReceiptRequestBankLine[];
    expenses?: ReceiptEvidenceExpense[];
    intakes?: ReceiptEvidenceIntake[];
    openIssueKeys?: string[];
    now?: Date;
} = {}) {
    return planReceiptRequests({
        bankLines: over.bankLines ?? [line()],
        expenses: over.expenses ?? [],
        intakes: over.intakes ?? [],
        openIssueKeys: over.openIssueKeys ?? [],
        now: over.now ?? NOW,
    });
}

test("debit, 4 days old, no expense → opens MISSING_RECEIPT with the owner from the card tail", () => {
    const result = plan();
    assert.equal(result.close.length, 0);
    assert.equal(result.open.length, 1);
    assert.equal(result.open[0].targetKey, "bl-1");
    assert.equal(result.open[0].displayDetails.owner, "CJ");
    assert.equal(result.open[0].displayDetails.cardTail, "8516");
    assert.equal(result.open[0].displayDetails.amountCents, -12_345);
    assert.equal(result.open[0].displayDetails.fingerprint, "pb-bl-1");
    // The card ref is rail noise, not payee identity.
    assert.ok(!result.open[0].displayDetails.payee.includes("8516"));
});

test("matching expense (exact cents, same date, LOWES #02516 vs Lowe's Home Improvement) → no open", () => {
    const result = plan({ expenses: [expense()] });
    assert.deepEqual(result.open, []);
    assert.deepEqual(result.close, [], "nothing to close when no issue is open");
});

test("...and closes an existing issue", () => {
    const result = plan({ expenses: [expense()], openIssueKeys: ["bl-1"] });
    assert.deepEqual(result.open, []);
    assert.deepEqual(result.close, ["bl-1"]);
});

test("expense date +2 / -2 days still matches", async t => {
    await t.test("+2", () => {
        assert.deepEqual(plan({ expenses: [expense({ date: "2026-08-18" })], openIssueKeys: ["bl-1"] }).close, ["bl-1"]);
    });
    await t.test("-2", () => {
        assert.deepEqual(plan({ expenses: [expense({ date: "2026-08-14" })], openIssueKeys: ["bl-1"] }).close, ["bl-1"]);
    });
});

test("expense date +3 days does NOT match", () => {
    const result = plan({ expenses: [expense({ date: "2026-08-19" })] });
    assert.equal(result.open.length, 1);
});

test("amount off by one cent does NOT match", () => {
    const result = plan({ expenses: [expense({ amountCents: 12_346 })] });
    assert.equal(result.open.length, 1);
});

test("disjoint payee tokens with equal amount+date never match — the Chevron/Cash App lesson", () => {
    const result = plan({
        bankLines: [line({ rawDescriptor: "CHEVRON 0090337 C#8516" })],
        expenses: [expense({ vendor: "CASH APP KANDI" })],
    });
    assert.equal(result.open.length, 1, "amount + date alone is zero confidence");
});

test("a credit line is ignored, and closes an issue it already had", async t => {
    await t.test("no issue → nothing at all", () => {
        const result = plan({ bankLines: [line({ amountCents: 4_500 })] });
        assert.deepEqual(result, { open: [], close: [] });
    });
    await t.test("issue open → close", () => {
        const result = plan({ bankLines: [line({ amountCents: 4_500 })], openIssueKeys: ["bl-1"] });
        assert.deepEqual(result.close, ["bl-1"]);
    });
});

test("a debit 2 days old is inside the grace window", () => {
    const result = plan({ bankLines: [line({ postedDate: "2026-08-18" })] });
    assert.deepEqual(result, { open: [], close: [] });
    // ...and exactly 3 days old is not.
    assert.equal(plan({ bankLines: [line({ postedDate: "2026-08-17" })] }).open.length, 1);
});

test("policy-exempt rails never open, and close an issue if one exists", async t => {
    const exempt = [
        ["loan payment", "INDIVIDUAL LOAN PAYMENTS 000000123"],
        ["insurance", "PROGRESSIVE INSURANCE PREM"],
        ["tax payment", "WA DEPT OF REVENUE TAX PAYMENT"],
        ["owner transfer", "TRANSFER TO SAVINGS"],
        ["bank fee", "SERVICE CHARGE"],
    ] as const;
    for (const [label, descriptor] of exempt) {
        await t.test(label, () => {
            const bankLines = [line({ rawDescriptor: descriptor })];
            assert.deepEqual(plan({ bankLines }).open, [], `${label} must not be chased`);
            assert.deepEqual(plan({ bankLines, openIssueKeys: ["bl-1"] }).close, ["bl-1"]);
        });
    }
});

test("a live ReceiptIntake satisfies a line the same way an Expense does", () => {
    const result = plan({ intakes: [intake()], openIssueKeys: ["bl-1"] });
    assert.deepEqual(result.open, []);
    assert.deepEqual(result.close, ["bl-1"]);
});

test("DUPLICATE / VOID / NON_RECEIPT intakes never satisfy a line", async t => {
    for (const state of ["DUPLICATE", "VOID", "NON_RECEIPT"]) {
        await t.test(state, () => {
            const result = plan({ intakes: [intake({ state })] });
            assert.equal(result.open.length, 1);
        });
    }
});

test("a null-total intake is not evidence", () => {
    assert.equal(plan({ intakes: [intake({ totalCents: null })] }).open.length, 1);
});

test("an expense with a null vendor or a null date never matches", async t => {
    await t.test("null vendor", () => {
        assert.equal(plan({ expenses: [expense({ vendor: null })] }).open.length, 1);
    });
    await t.test("empty vendor", () => {
        assert.equal(plan({ expenses: [expense({ vendor: "   " })] }).open.length, 1);
    });
    await t.test("null date", () => {
        assert.equal(plan({ expenses: [expense({ date: null })] }).open.length, 1);
    });
});

test("an expense deleted since the last run re-opens the line", () => {
    // Run 1: matched, so the issue closes.
    assert.deepEqual(plan({ expenses: [expense()], openIssueKeys: ["bl-1"] }).close, ["bl-1"]);
    // Run 2: the expense is gone and the issue is cleared — the line reopens
    // (lifecycle step 3 turns this open into a generation bump).
    const rerun = plan({ expenses: [], openIssueKeys: [] });
    assert.equal(rerun.open.length, 1);
    assert.equal(rerun.open[0].targetKey, "bl-1");
});

test("a line whose descriptor normalizes to nothing is never matched on an empty payee", () => {
    // "" is not an identity (bank-ledger). It must open a request, not silently
    // match the first same-amount expense.
    const result = plan({
        bankLines: [line({ rawDescriptor: "C#8516 *****3255001" })],
        expenses: [expense({ vendor: "Anything At All" })],
    });
    assert.equal(result.open.length, 1);
    assert.equal(result.open[0].displayDetails.payee, "");
});

test("payeeMatches: the two real-world shapes, and the two that must not match", async t => {
    await t.test("LOWES #02516 ↔ Lowe's Home Improvement", () => {
        assert.equal(payeeMatches("LOWES #02516", "Lowe's Home Improvement"), true);
    });
    await t.test("HOMEDEPOT.COM ↔ Home Depot", () => {
        assert.equal(payeeMatches("HOMEDEPOT.COM", "Home Depot"), true);
    });
    await t.test("CHEVRON ↔ CASH APP KANDI", () => {
        assert.equal(payeeMatches("CHEVRON", "CASH APP KANDI"), false);
    });
    await t.test("empty either side", () => {
        assert.equal(payeeMatches("", "Lowe's"), false);
        assert.equal(payeeMatches("LOWES", ""), false);
        assert.equal(payeeMatches("LOWES", null), false);
    });
    await t.test("digits and 2-char tokens are not identity", () => {
        assert.equal(payeeMatches("STORE 4718", "SHOP 4718"), false);
        assert.equal(payeeMatches("A B 4718", "C D 4718"), false);
    });
});

test("decimalStringToCents is exact — never Number(d) * 100", async t => {
    await t.test("a value where Number(d) * 100 actually breaks", () => {
        assert.equal(decimalStringToCents("19.99"), 1999);
        assert.notEqual(Number("19.99") * 100, 1999); // 1998.9999999999998 — the trap is real
        assert.equal(decimalStringToCents("1234.56"), 123_456);
    });
    await t.test("one decimal place, none, and trailing digits", () => {
        assert.equal(decimalStringToCents("12.5"), 1250);
        assert.equal(decimalStringToCents("12"), 1200);
        assert.equal(decimalStringToCents("12.999"), 1299);
    });
    await t.test("negative and zero", () => {
        assert.equal(decimalStringToCents("-8.07"), -807);
        assert.equal(decimalStringToCents("0.00"), 0);
    });
    await t.test("garbage is null, never 0", () => {
        assert.equal(decimalStringToCents(""), null);
        assert.equal(decimalStringToCents("1e3"), null);
        assert.equal(decimalStringToCents("abc"), null);
    });
});

test("fingerprints round-trip, and a foreign fingerprint is refused", () => {
    assert.equal(receiptRequestFingerprint("bl-1"), "pb-bl-1");
    assert.equal(bankLineIdFromFingerprint("pb-bl-1"), "bl-1");
    assert.equal(bankLineIdFromFingerprint("2026-08-16_LOWES_123"), null, "Beverly's own fingerprints are not ours");
    assert.equal(bankLineIdFromFingerprint("pb-"), null);
});
