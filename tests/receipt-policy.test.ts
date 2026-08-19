import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyReceiptRequirement,
    resolveReceiptOwner,
    summarizeReceiptWork,
} from "@/lib/receipt-policy";

// Fixture note: every descriptor below is a REAL string from the GTR prod
// ledger (surveyed 2026-08-19). They are used to prove bucketing behaviour;
// no amount here is asserted as a business fact.

const line = (rawDescriptor: string, amountCents = -1000, checkNumber: string | null = null) =>
    ({ rawDescriptor, amountCents, checkNumber });

test("rails with no merchant receipt are exempted, with a stated reason", async t => {
    const cases: Array<[string, string, string]> = [
        ["loan payment", "INDIVIDUAL LOAN PAYMENTS AUTOMATIC LOAN PAYMENT Acct No.        350080602", "loan-payment"],
        ["credit-card payment", "PREAUTHORIZED ACH DEBIT ONLINE PMT CAPITAL ONE Justin T Adkins CA06123513CAC82 CCD", "card-payment"],
        ["processor fee", "PREAUTHORIZED ACH DEBIT TRAN FEE   INTUIT 05890193 GOLDEN TOUCH REMODELIN 524771026483566 CCD", "merchant-fee"],
        ["insurance", "PREAUTHORIZED ACH DEBIT BILLPAY    RLI INSURANCE CO JUSTIN ADKINS RLI INSURANCE C PPD", "insurance"],
        ["bookkeeping", "PREAUTHORIZED ACH DEBIT SALE       BRYANT BOOKKEEPI JUSTIN ADKINS CCD", "professional-services"],
        ["owner transfer", "PREAUTHORIZED ACH DEBIT PAYMENT    VENMO JUSTIN ADKINS 1052320032752 WEB", "owner-transfer"],
    ];
    for (const [name, descriptor, ruleKey] of cases) {
        await t.test(name, () => {
            const v = classifyReceiptRequirement(line(descriptor));
            assert.equal(v.requirement, "no_receipt_expected");
            assert.equal(v.ruleKey, ruleKey);
            assert.ok(v.reason.length > 10, "a human-readable reason is always given");
        });
    }
});

test("real job purchases still demand a receipt", async t => {
    const purchases = [
        "MISCELLANEOUS DEBIT FERGUSON HOME 800-638-8875  CA C#6098 DBT CRD 1101 08/15/26 76816185",
        "MISCELLANEOUS DEBIT LOWE S #1632 LOWE S  1632 POS DEB 1106 08/12/26 00795348 VANCOUVER     WA C#6098",
        "MISCELLANEOUS DEBIT 169 QXO VANCOUVER     WA C#8516 DBT CRD 1759 08/12/26 27537817",
        "MISCELLANEOUS DEBIT 34 MUTUAL MATERIALS NO 8886888250    WA C#6098 DBT CRD 1758",
        "MISCELLANEOUS DEBIT FLOOR AND DECOR 386 FLOOR AND DECOR 38 POS DEB 1326",
        "MISCELLANEOUS DEBIT THE HOME DEPOT #4718 THE HOME DEPOT  47 POS DEB 1348",
        "MISCELLANEOUS DEBIT PAYPAL *THERTASTORE 402-935-7733  NY C#6098 DBT CRD 0827",
        "MISCELLANEOUS DEBIT AMAZON MKTPL*5H4ZN43C2 Amzn.com/bill WA C#6098 DBT CRD 1942",
    ];
    for (const descriptor of purchases) {
        await t.test(descriptor.slice(21, 48).trim(), () => {
            assert.equal(classifyReceiptRequirement(line(descriptor)).requirement, "receipt_expected");
        });
    }
});

test("an insurance-shaped word inside a merchant name does not exempt a purchase", () => {
    // Guard against the exemption patterns being too greedy.
    const v = classifyReceiptRequirement(line("MISCELLANEOUS DEBIT LOWES #01632* 360-260-2120  WA C#6098 DBT CRD 1409"));
    assert.equal(v.requirement, "receipt_expected");
});

test("software subscriptions expect a receipt but are labelled as overhead", async t => {
    for (const descriptor of [
        "MISCELLANEOUS DEBIT ANTHROPIC ANTHROPIC.COM CA C#4297 DBT CRD 1852",
        "MISCELLANEOUS DEBIT GOOGLE*CLOUD NGRDVM WWW.GOOGLE.CO CA C#4297 DBT CRD 1149",
        "MISCELLANEOUS DEBIT PST*Plaid Inc. 415-7991354   CA C#4297 DBT CRD 0852",
    ]) {
        await t.test(descriptor.slice(21, 40).trim(), () => {
            const v = classifyReceiptRequirement(line(descriptor));
            assert.equal(v.requirement, "receipt_expected");
            assert.equal(v.ruleKey, "software-subscription");
            assert.match(v.reason, /overhead/i);
        });
    }
});

test("an Intuit TRAN FEE is a fee, not a subscription", () => {
    // Both patterns could plausibly claim this string; the fee rule must win
    // or a bank fee would be sent out as a receipt to chase.
    const v = classifyReceiptRequirement(line("PREAUTHORIZED ACH DEBIT TRAN FEE   INTUIT 05890193 GOLDEN TOUCH REMODELIN"));
    assert.equal(v.ruleKey, "merchant-fee");
    assert.equal(v.requirement, "no_receipt_expected");
});

test("checks always need evidence — a bare CHECK PAID tells a human nothing", () => {
    const v = classifyReceiptRequirement(line("CHECK PAID CHECK", -603715, "1027"));
    assert.equal(v.requirement, "receipt_expected");
    assert.equal(v.ruleKey, "check");
    assert.match(v.reason, /check image/i);
});

test("money in is never a spend receipt", async t => {
    for (const descriptor of [
        "OTHER DEPOSITS DEPOSIT - DDA/MMKT",
        "PREAUTHORIZED ACH CREDIT DEPOSIT    INTUIT 04778693 GOLDEN TOUCH REMODELIN",
        "MISCELLANEOUS CREDIT Amazon.com Amzn.com/bill WA C#6098 POS CRE 0000",
    ]) {
        await t.test(descriptor.slice(0, 34), () => {
            assert.equal(classifyReceiptRequirement(line(descriptor, 1520)).requirement, "not_spend");
        });
    }
});

test("card rails resolve to the right person", async t => {
    await t.test("C#8516 is CJ", () => {
        const v = resolveReceiptOwner("MISCELLANEOUS DEBIT 169 QXO VANCOUVER WA C#8516 DBT CRD 1759");
        assert.equal(v.owner, "CJ");
        assert.equal(v.cardTail, "8516");
    });
    await t.test("C#6098 is Richard", () => {
        const v = resolveReceiptOwner("MISCELLANEOUS DEBIT LOWE S #1632 POS DEB 1106 C#6098");
        assert.equal(v.owner, "Richard");
        assert.equal(v.cardTail, "6098");
    });
    await t.test("an UNKNOWN card is never guessed onto a person", () => {
        // C#4297 appears in prod on Plaid/Google Cloud/Anthropic/Cash App.
        // Guessing an owner would send someone else's affidavit to the wrong
        // person — the exact trust failure this module prevents.
        const v = resolveReceiptOwner("MISCELLANEOUS DEBIT ANTHROPIC ANTHROPIC.COM CA C#4297 DBT CRD 1852");
        assert.equal(v.owner, "unassigned");
        assert.equal(v.cardTail, "4297");
    });
    await t.test("no card means the office owns it, not the crew", () => {
        const v = resolveReceiptOwner("PREAUTHORIZED ACH DEBIT BILLPAY    RLI INSURANCE CO");
        assert.equal(v.owner, "office");
        assert.equal(v.cardTail, null);
    });
});

test("summarizeReceiptWork buckets a realistic day", () => {
    const lines = [
        line("MISCELLANEOUS DEBIT FERGUSON HOME 800-638-8875  CA C#6098 DBT CRD 1101", -198423),
        line("MISCELLANEOUS DEBIT LOWE S #1632 LOWE S 1632 POS DEB 1106 C#6098", -83105),
        line("INDIVIDUAL LOAN PAYMENTS AUTOMATIC LOAN PAYMENT Acct No. 350080602", -26581),
        line("PREAUTHORIZED ACH DEBIT BILLPAY    RLI INSURANCE CO", -102032),
        line("OTHER DEPOSITS DEPOSIT - DDA/MMKT", 1650000),
    ];
    // Pretend the Lowe's charge already has its receipt.
    const withReceipt = new Set([lines[1]]);
    const s = summarizeReceiptWork(lines, l => withReceipt.has(l));

    assert.equal(s.needsReceipt.length, 1, "only Ferguson still needs one");
    assert.equal(s.satisfied.length, 1);
    assert.equal(s.exempt.length, 2, "loan + insurance");
    assert.equal(s.notSpend.length, 1);
    // Nothing is lost.
    assert.equal(s.needsReceipt.length + s.satisfied.length + s.exempt.length + s.notSpend.length, lines.length);
});

test("exempt lines are REPORTED, never silently dropped", () => {
    const lines = [line("INDIVIDUAL LOAN PAYMENTS AUTOMATIC LOAN PAYMENT", -26581)];
    const s = summarizeReceiptWork(lines, () => false);
    assert.equal(s.exempt.length, 1);
    assert.ok(s.exempt[0].verdict.reason, "the reason travels with it so a human can disagree");
});

test("empty input is handled", () => {
    const s = summarizeReceiptWork([], () => false);
    assert.deepEqual(s, { needsReceipt: [], exempt: [], notSpend: [], satisfied: [] });
});
