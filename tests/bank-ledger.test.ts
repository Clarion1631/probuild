import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizePayee,
    computeLineHash,
    assignLineHashes,
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
});

test("computeLineHash", async t => {
    await t.test("is deterministic for identical input", () => {
        const input = { account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", occurrenceIndex: 0 };
        assert.equal(computeLineHash(input), computeLineHash({ ...input }));
    });

    await t.test("changes when occurrenceIndex changes and nothing else does", () => {
        const base = { account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", occurrenceIndex: 0 };
        assert.notEqual(computeLineHash(base), computeLineHash({ ...base, occurrenceIndex: 1 }));
    });

    await t.test("changes when any other field changes", () => {
        const base = { account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", occurrenceIndex: 0 };
        assert.notEqual(computeLineHash(base), computeLineHash({ ...base, account: "WTB-8516" }));
        assert.notEqual(computeLineHash(base), computeLineHash({ ...base, postedDate: "2026-07-17" }));
        assert.notEqual(computeLineHash(base), computeLineHash({ ...base, amountCents: -7401 }));
        assert.notEqual(computeLineHash(base), computeLineHash({ ...base, rawDescriptor: "US MARKET " }));
    });

    await t.test("is a 64-char lowercase hex sha256 digest", () => {
        const hash = computeLineHash({ account: "A", postedDate: "2026-01-01", amountCents: 100, rawDescriptor: "X", occurrenceIndex: 0 });
        assert.match(hash, /^[0-9a-f]{64}$/);
    });
});

test("assignLineHashes", async t => {
    await t.test("assigns 0-based occurrence indexes per identical (date, amount, descriptor) key, in array order", () => {
        const lines = [
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
            { postedDate: "2026-07-16", amountCents: -2901, rawDescriptor: "US MARKET OTHER" },
        ];
        const result = assignLineHashes("WTB-0723", lines);
        assert.equal(result[0].occurrenceIndex, 0);
        assert.equal(result[1].occurrenceIndex, 1);
        assert.equal(result[2].occurrenceIndex, 0);
    });

    await t.test("gives identical same-day duplicates distinct hashes", () => {
        const lines = [
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
        ];
        const result = assignLineHashes("WTB-0723", lines);
        assert.notEqual(result[0].lineHash, result[1].lineHash);
    });

    await t.test("re-running on the identical, identically-ordered batch reproduces the identical hashes (idempotent retry)", () => {
        const lines = [
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
            { postedDate: "2026-07-17", amountCents: -100, rawDescriptor: "OTHER" },
        ];
        const first = assignLineHashes("WTB-0723", lines).map(l => l.lineHash);
        const second = assignLineHashes("WTB-0723", lines).map(l => l.lineHash);
        assert.deepEqual(first, second);
    });

    await t.test("each computed lineHash matches computeLineHash with the same occurrence index", () => {
        const lines = [{ postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" }];
        const [result] = assignLineHashes("WTB-0723", lines);
        assert.equal(
            result.lineHash,
            computeLineHash({ account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", occurrenceIndex: 0 }),
        );
    });
});
