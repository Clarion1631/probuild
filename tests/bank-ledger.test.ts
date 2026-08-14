import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizePayee,
    versionedHash,
    computeStatementContentHash,
    computeQboLineContentHash,
    isValidCalendarDate,
    isSafeCents,
    reconcileObservations,
    validateStatementSemantics,
    validateRefundEventSigns,
    INT4_MIN,
    INT4_MAX,
} from "../src/lib/bank-ledger";

test("normalizePayee", async t => {
    await t.test("strips POS/DBT rail metadata and card-ref tokens", () => {
        assert.equal(
            normalizePayee("PAYPAL *CONSTRUCTIO Int Fee 0825 07/01/26\n61333624 4029357733 00 C# 6098"),
            "PAYPAL CONSTRUCTIO",
        );
    });

    await t.test("cuts everything from POS DEB onward, leaving store/address", () => {
        assert.equal(
            normalizePayee("WM SUPERCENTER #5462 430 SE 192ND AVE POS\nDEB 1639 06/30/26 00007483 VANCOUVER WA\nC#6098"),
            "WM SUPERCENTER #5462 430 SE 192ND AVE",
        );
    });

    await t.test("keeps the sub-merchant name after an asterisk (person-to-person rails)", () => {
        // Cash App / PayPal payee names after "*" must survive normalization —
        // they're the actual counterparty, and collapsing them away would
        // reproduce the Chevron/Cash App wrong-match class of bug.
        assert.equal(
            normalizePayee("CASH APP*KANDI SNYDER Oakland CA C#4297\nDBT CRD 1545 06/30/26 47250398"),
            "CASH APP KANDI SNYDER OAKLAND CA",
        );
    });

    await t.test("strips phone numbers and DBT CRD rail metadata", () => {
        assert.equal(
            normalizePayee("LOWES #00907* 866-483-7521 NC C#6098 DBT CRD\n1038 06/30/26 63150228"),
            "LOWES #00907 NC",
        );
    });

    await t.test("strips masked account tails and trailing ACH SEC codes", () => {
        assert.equal(
            normalizePayee("TRANS PMT 360 SHEFFIELD FI ADKINS JUSTIN T 60\n*****3255001 PPD"),
            "TRANS PMT 360 SHEFFIELD FI ADKINS JUSTIN T 60",
        );
    });

    await t.test("keeps Gusto's FEE/TAX/NET/TLR prefix (a real semantic distinction)", () => {
        assert.equal(
            normalizePayee("FEE 656969 GUSTO Golden Touch Remodelin\n6seml5vu8me CCD"),
            "FEE GUSTO GOLDEN TOUCH REMODELIN 6SEML5VU8ME",
        );
    });

    await t.test("short descriptors with no rail metadata pass through unchanged (uppercased)", () => {
        assert.equal(normalizePayee("DEPOSIT"), "DEPOSIT");
        assert.equal(normalizePayee("hello world"), "HELLO WORLD");
    });

    await t.test("collapses a POS CRE (refund) descriptor the same way as POS DEB", () => {
        assert.equal(
            normalizePayee("LOWES #01632* VANCOUVER WA C#6098 POS\nCRE 0000 07/02/26 94985882"),
            "LOWES #01632 VANCOUVER WA",
        );
    });

    await t.test("empty/falsy input returns an empty string", () => {
        assert.equal(normalizePayee(""), "");
    });

    await t.test("a descriptor consisting entirely of stripped rail metadata returns an empty string", () => {
        // Callers (the ingest route) must treat "" as exceptional, not a
        // normal identity — this test just documents that normalizePayee
        // itself makes no attempt to avoid producing "".
        assert.equal(normalizePayee("C#6098 866-483-7521 07/01/26 123456"), "");
    });
});

test("versionedHash", async t => {
    await t.test("is deterministic for identical fields", () => {
        assert.equal(versionedHash(["a", 1, "b"]), versionedHash(["a", 1, "b"]));
    });

    await t.test("does not collide across a delimiter boundary between two fields", () => {
        // The bug the versioned JSON encoding replaces: joining with "|"
        // would make ("a|b", "c") and ("a", "b|c") hash identically.
        assert.notEqual(versionedHash(["a|b", "c"]), versionedHash(["a", "b|c"]));
    });

    await t.test("is a 64-char lowercase hex sha256 digest", () => {
        assert.match(versionedHash(["x"]), /^[0-9a-f]{64}$/);
    });
});

test("computeStatementContentHash", async t => {
    const base = {
        account: "WTB-0723",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        openingCents: 100000,
        closingCents: 200000,
        lines: [{ postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null }],
    };

    await t.test("is deterministic for identical input", () => {
        assert.equal(computeStatementContentHash(base), computeStatementContentHash({ ...base }));
    });

    await t.test("changes when any field changes", () => {
        assert.notEqual(computeStatementContentHash(base), computeStatementContentHash({ ...base, account: "WTB-8516" }));
        assert.notEqual(computeStatementContentHash(base), computeStatementContentHash({ ...base, openingCents: 100001 }));
        assert.notEqual(
            computeStatementContentHash(base),
            computeStatementContentHash({ ...base, lines: [{ ...base.lines[0], amountCents: -7401 }] }),
        );
    });

    await t.test("changes when line order changes", () => {
        const twoLines = {
            ...base,
            lines: [
                { postedDate: "2026-07-16", amountCents: -100, rawDescriptor: "A", checkNumber: null },
                { postedDate: "2026-07-17", amountCents: -200, rawDescriptor: "B", checkNumber: null },
            ],
        };
        const reordered = { ...twoLines, lines: [...twoLines.lines].reverse() };
        assert.notEqual(computeStatementContentHash(twoLines), computeStatementContentHash(reordered));
    });
});

test("isValidCalendarDate", async t => {
    await t.test("accepts real calendar dates", () => {
        assert.equal(isValidCalendarDate("2026-07-16"), true);
        assert.equal(isValidCalendarDate("2026-02-28"), true);
        assert.equal(isValidCalendarDate("2028-02-29"), true); // leap year
    });

    await t.test("rejects a day that doesn't exist in that month", () => {
        assert.equal(isValidCalendarDate("2026-02-31"), false);
        assert.equal(isValidCalendarDate("2026-04-31"), false);
    });

    await t.test("rejects a non-leap-year February 29th", () => {
        assert.equal(isValidCalendarDate("2026-02-29"), false);
    });

    await t.test("rejects malformed shapes", () => {
        assert.equal(isValidCalendarDate("2026/07/16"), false);
        assert.equal(isValidCalendarDate("26-07-16"), false);
        assert.equal(isValidCalendarDate(""), false);
    });

    await t.test("rejects non-string input", () => {
        assert.equal(isValidCalendarDate(20260716), false);
        assert.equal(isValidCalendarDate(null), false);
        assert.equal(isValidCalendarDate(undefined), false);
    });

    await t.test("rejects an implausible year", () => {
        assert.equal(isValidCalendarDate("0026-07-16"), false);
        assert.equal(isValidCalendarDate("9999-07-16"), false);
    });
});

test("isSafeCents", async t => {
    await t.test("accepts safe integers within int4 bounds", () => {
        assert.equal(isSafeCents(0), true);
        assert.equal(isSafeCents(-7400), true);
        assert.equal(isSafeCents(INT4_MIN), true);
        assert.equal(isSafeCents(INT4_MAX), true);
    });

    await t.test("rejects values outside int4 bounds", () => {
        assert.equal(isSafeCents(INT4_MAX + 1), false);
        assert.equal(isSafeCents(INT4_MIN - 1), false);
    });

    await t.test("rejects non-integers and unsafe values", () => {
        assert.equal(isSafeCents(1.5), false);
        assert.equal(isSafeCents(Number.MAX_SAFE_INTEGER + 1), false);
        assert.equal(isSafeCents(NaN), false);
        assert.equal(isSafeCents(Infinity), false);
    });

    await t.test("rejects non-number input", () => {
        assert.equal(isSafeCents("100"), false);
        assert.equal(isSafeCents(null), false);
    });
});

test("reconcileObservations", async t => {
    await t.test("links a QBO observation to a canonical BankLine on an exact account+date+amount+payee match", () => {
        const observations = [{ id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null }];
        const bankLines = [{ id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null }];
        assert.deepEqual(reconcileObservations(observations, bankLines), [{ observationId: "obs1", bankLineId: "bl1" }]);
    });

    await t.test("does not link when there is no exact match", () => {
        const observations = [{ id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null }];
        const bankLines = [{ id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7401, normalizedPayee: "US MARKET", checkNumber: null }];
        assert.deepEqual(reconcileObservations(observations, bankLines), []);
    });

    await t.test("skips observations already linked to a canonical BankLine", () => {
        const observations = [{ id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: "already-linked" }];
        const bankLines = [{ id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null }];
        assert.deepEqual(reconcileObservations(observations, bankLines), []);
    });

    await t.test("matches one-to-one: two identical observations claim two distinct BankLines, not the same one twice", () => {
        const observations = [
            { id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
            { id: "obs2", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
        ];
        const bankLines = [
            { id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
            { id: "bl2", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
        ];
        const links = reconcileObservations(observations, bankLines);
        assert.equal(links.length, 2);
        assert.notEqual(links[0].bankLineId, links[1].bankLineId);
    });

    await t.test("a third identical observation is left unmatched once both candidate BankLines are claimed", () => {
        const observations = [
            { id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
            { id: "obs2", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
            { id: "obs3", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
        ];
        const bankLines = [
            { id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
            { id: "bl2", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
        ];
        const links = reconcileObservations(observations, bankLines);
        assert.equal(links.length, 2);
        assert.equal(links.some(l => l.observationId === "obs3"), false);
    });

    await t.test("never matches across accounts even with the same date+amount+payee", () => {
        const observations = [{ id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null }];
        const bankLines = [{ id: "bl1", account: "WTB-8516", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null }];
        assert.deepEqual(reconcileObservations(observations, bankLines), []);
    });

    await t.test("does NOT cross-match two different payees sharing account+date+amount (the Chevron/Cash App class of bug)", () => {
        const observations = [{ id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "CHEVRON", checkNumber: null, bankLineId: null }];
        const bankLines = [{ id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "CASH APP KANDI SNYDER", checkNumber: null }];
        assert.deepEqual(reconcileObservations(observations, bankLines), []);
    });

    await t.test("amount+date+payee alone is not enough when a check number is present and disagrees", () => {
        const observations = [{ id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -400000, normalizedPayee: "CHECK", checkNumber: "1024", bankLineId: null }];
        const bankLines = [{ id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -400000, normalizedPayee: "CHECK", checkNumber: "1025" }];
        assert.deepEqual(reconcileObservations(observations, bankLines), []);
    });

    await t.test("matches when check numbers agree, in addition to account+date+amount+payee", () => {
        const observations = [{ id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -400000, normalizedPayee: "CHECK", checkNumber: "1024", bankLineId: null }];
        const bankLines = [{ id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -400000, normalizedPayee: "CHECK", checkNumber: "1024" }];
        assert.deepEqual(reconcileObservations(observations, bankLines), [{ observationId: "obs1", bankLineId: "bl1" }]);
    });

    await t.test("never matches an observation with an empty normalizedPayee (the EXCEPTION case)", () => {
        const observations = [{ id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "", checkNumber: null, bankLineId: null }];
        const bankLines = [{ id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "", checkNumber: null }];
        assert.deepEqual(reconcileObservations(observations, bankLines), []);
    });

    await t.test("never matches a candidate BankLine with an empty normalizedPayee", () => {
        const observations = [{ id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "", checkNumber: null, bankLineId: null }];
        const bankLines = [{ id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "SOMETHING", checkNumber: null }];
        assert.deepEqual(reconcileObservations(observations, bankLines), []);
    });
});

test("computeQboLineContentHash", async t => {
    await t.test("is deterministic for identical input", () => {
        const line = { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null };
        assert.equal(computeQboLineContentHash(line), computeQboLineContentHash({ ...line }));
    });

    await t.test("changes when any field changes", () => {
        const base = { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null };
        assert.notEqual(computeQboLineContentHash(base), computeQboLineContentHash({ ...base, amountCents: -7401 }));
        assert.notEqual(computeQboLineContentHash(base), computeQboLineContentHash({ ...base, postedDate: "2026-07-17" }));
        assert.notEqual(computeQboLineContentHash(base), computeQboLineContentHash({ ...base, rawDescriptor: "OTHER" }));
        assert.notEqual(computeQboLineContentHash(base), computeQboLineContentHash({ ...base, checkNumber: "1024" }));
    });
});

test("validateStatementSemantics", async t => {
    const base = {
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        openingCents: 100000,
        closingCents: 92600,
        lines: [{ postedDate: "2026-07-16", amountCents: -7400 }],
    };

    await t.test("passes when every line is inside the period and the balance reconciles", () => {
        assert.deepEqual(validateStatementSemantics(base), []);
    });

    await t.test("flags a line dated before periodStart", () => {
        const failures = validateStatementSemantics({ ...base, lines: [{ postedDate: "2026-06-30", amountCents: -7400 }] });
        assert.equal(failures.length, 1);
        assert.equal(failures[0].reason, "line-date-outside-period");
        assert.equal(failures[0].index, 0);
    });

    await t.test("flags a line dated after periodEnd", () => {
        const failures = validateStatementSemantics({ ...base, lines: [{ postedDate: "2026-08-01", amountCents: -7400 }] });
        assert.equal(failures.length, 1);
        assert.equal(failures[0].reason, "line-date-outside-period");
    });

    await t.test("flags openingCents + sum(lines) !== closingCents", () => {
        const failures = validateStatementSemantics({ ...base, closingCents: 92601 });
        assert.equal(failures.length, 1);
        assert.equal(failures[0].reason, "balance-mismatch");
    });

    await t.test("reports both an out-of-period line AND a balance mismatch in one pass", () => {
        const failures = validateStatementSemantics({
            ...base,
            closingCents: 92601,
            lines: [{ postedDate: "2026-08-15", amountCents: -7400 }],
        });
        assert.equal(failures.length, 2);
        assert.deepEqual(failures.map(f => f.reason).sort(), ["balance-mismatch", "line-date-outside-period"]);
    });
});

test("validateRefundEventSigns", async t => {
    await t.test("accepts a debit original + a credit refund", () => {
        assert.deepEqual(validateRefundEventSigns({ amountCents: -7400 }, { amountCents: 7400 }), { ok: true });
    });

    await t.test("accepts null on either side (not yet linked)", () => {
        assert.deepEqual(validateRefundEventSigns(null, null), { ok: true });
        assert.deepEqual(validateRefundEventSigns({ amountCents: -7400 }, null), { ok: true });
        assert.deepEqual(validateRefundEventSigns(null, { amountCents: 7400 }), { ok: true });
    });

    await t.test("rejects a credit (or zero) originalBankLineId", () => {
        const result = validateRefundEventSigns({ amountCents: 7400 }, null);
        assert.equal(result.ok, false);
        const result2 = validateRefundEventSigns({ amountCents: 0 }, null);
        assert.equal(result2.ok, false);
    });

    await t.test("rejects a debit (or zero) refundBankLineId", () => {
        const result = validateRefundEventSigns(null, { amountCents: -7400 });
        assert.equal(result.ok, false);
        const result2 = validateRefundEventSigns(null, { amountCents: 0 });
        assert.equal(result2.ok, false);
    });

    await t.test("rejects a fully swapped pairing (both sides wrong)", () => {
        const result = validateRefundEventSigns({ amountCents: 7400 }, { amountCents: -7400 });
        assert.equal(result.ok, false);
    });
});
