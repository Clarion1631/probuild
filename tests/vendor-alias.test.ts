import assert from "node:assert/strict";
import test from "node:test";
import { normalizePayee } from "@/lib/bank-ledger";
import {
    proposeAliasMatches,
    vendorTokens,
    sharedVendorToken,
    aliasesFromProposals,
    type AliasCandidateLine,
} from "@/lib/vendor-alias";

// Fixture note: the descriptor strings below are REAL pairs pulled from prod
// on 2026-08-19 while diagnosing why reconcile linked 0 of 74 QBO
// observations. Same day, same cent, different vocabulary. No amounts or
// project data from those rows are asserted as business facts here — they are
// used only to prove the payee matching behaves.

const bank = (over: Partial<AliasCandidateLine> = {}): AliasCandidateLine => ({
    id: "b1",
    postedDate: "2026-08-12",
    amountCents: -83105,
    rawDescriptor: "MISCELLANEOUS DEBIT LOWE S #1632 LOWE S  1632 POS DEB 1106 08/12/26 00",
    normalizedPayee: normalizePayee("MISCELLANEOUS DEBIT LOWE S #1632 LOWE S  1632 POS DEB 1106 08/12/26 00"),
    ...over,
});

const qbo = (over: Partial<AliasCandidateLine> = {}): AliasCandidateLine => ({
    id: "q1",
    postedDate: "2026-08-12",
    amountCents: -83105,
    rawDescriptor: "LOWE'S HOME CENTERS, LLC Expense",
    normalizedPayee: normalizePayee("LOWE'S HOME CENTERS, LLC Expense"),
    ...over,
});

test("the real prod pair that reconcile could not match", async t => {
    await t.test("is proposed", () => {
        const { proposals } = proposeAliasMatches([bank()], [qbo()]);
        assert.equal(proposals.length, 1);
        assert.equal(proposals[0].bankLineId, "b1");
        assert.equal(proposals[0].qboLineId, "q1");
    });

    await t.test("with the shared vendor token as the reason", () => {
        const { proposals } = proposeAliasMatches([bank()], [qbo()]);
        assert.equal(proposals[0].sharedToken, "LOWE");
        assert.equal(proposals[0].confidence, "unique_date_amount_token");
    });

    await t.test("and carries both raw descriptors for human review", () => {
        const { proposals } = proposeAliasMatches([bank()], [qbo()]);
        assert.match(proposals[0].bankRawDescriptor, /LOWE S/);
        assert.match(proposals[0].qboRawDescriptor, /LOWE'S HOME CENTERS/);
    });
});

test("other real prod pairs", async t => {
    const cases: Array<{ name: string; bankRaw: string; qboRaw: string; token: string }> = [
        {
            name: "Space Age",
            bankRaw: "MISCELLANEOUS DEBIT SPACE AGE #202 RETAIL SPACE AGE  202 RET POS DEB 1",
            qboRaw: "Space Age Expense",
            token: "SPACE",
        },
        {
            name: "Costco",
            bankRaw: "MISCELLANEOUS DEBIT COSTCO WHSE #0772 COSTCO WHSE  0772 POS DEB 0943 0",
            qboRaw: "COSTCO WHOLESALE Expense",
            token: "COSTCO",
        },
        {
            name: "Parkrose",
            bankRaw: "MISCELLANEOUS DEBIT PARKROSE HAZEL DELL - PARKROSE HAZEL DEL POS DEB 1",
            qboRaw: "Parkrose Hardware Expense",
            token: "PARKROSE",
        },
    ];

    for (const c of cases) {
        await t.test(c.name, () => {
            const { proposals } = proposeAliasMatches(
                [bank({ rawDescriptor: c.bankRaw, normalizedPayee: normalizePayee(c.bankRaw) })],
                [qbo({ rawDescriptor: c.qboRaw, normalizedPayee: normalizePayee(c.qboRaw) })],
            );
            assert.equal(proposals.length, 1, `${c.name} should propose`);
            assert.equal(proposals[0].sharedToken, c.token);
        });
    }
});

test("an alias NEVER matches on payee alone — date and cents must agree", async t => {
    await t.test("different date → no proposal", () => {
        const { proposals } = proposeAliasMatches([bank()], [qbo({ postedDate: "2026-08-13" })]);
        assert.equal(proposals.length, 0);
    });
    await t.test("one cent apart → no proposal", () => {
        const { proposals } = proposeAliasMatches([bank()], [qbo({ amountCents: -83106 })]);
        assert.equal(proposals.length, 0);
    });
    await t.test("opposite sign → no proposal", () => {
        const { proposals } = proposeAliasMatches([bank()], [qbo({ amountCents: 83105 })]);
        assert.equal(proposals.length, 0);
    });
});

test("ambiguity is reported, never guessed", async t => {
    // Two Space Age charges on 2026-08-17 for different amounts are fine, but
    // two for the SAME amount cannot be told apart — prod has exactly this
    // shape (SPACE AGE 113.00 and 125.00 on the same day).
    await t.test("two bank rows, one QBO row → ambiguous, no proposal", () => {
        const { proposals, ambiguous } = proposeAliasMatches(
            [bank({ id: "b1" }), bank({ id: "b2" })],
            [qbo({ id: "q1" })],
        );
        assert.equal(proposals.length, 0);
        assert.equal(ambiguous.length, 1);
        assert.deepEqual(ambiguous[0].bankLineIds, ["b1", "b2"]);
        assert.deepEqual(ambiguous[0].qboLineIds, ["q1"]);
    });

    await t.test("one bank row, two QBO rows → ambiguous, no proposal", () => {
        const { proposals, ambiguous } = proposeAliasMatches(
            [bank({ id: "b1" })],
            [qbo({ id: "q1" }), qbo({ id: "q2" })],
        );
        assert.equal(proposals.length, 0);
        assert.equal(ambiguous.length, 1);
    });

    await t.test("same-day different amounts are NOT ambiguous", () => {
        const { proposals, ambiguous } = proposeAliasMatches(
            [bank({ id: "b1", amountCents: -11300 }), bank({ id: "b2", amountCents: -12500 })],
            [qbo({ id: "q1", amountCents: -11300 }), qbo({ id: "q2", amountCents: -12500 })],
        );
        assert.equal(ambiguous.length, 0);
        assert.equal(proposals.length, 2);
    });
});

test("output is deterministic regardless of input order", () => {
    const b = [bank({ id: "b1", amountCents: -11300 }), bank({ id: "b2", amountCents: -12500 })];
    const q = [qbo({ id: "q1", amountCents: -11300 }), qbo({ id: "q2", amountCents: -12500 })];
    const forward = JSON.stringify(proposeAliasMatches(b, q).proposals);
    const reversed = JSON.stringify(proposeAliasMatches([...b].reverse(), [...q].reverse()).proposals);
    assert.equal(forward, reversed);
});

test("an empty normalized payee is the EXCEPTION case and never matches", async t => {
    await t.test("empty on the bank side", () => {
        const { proposals } = proposeAliasMatches([bank({ normalizedPayee: "" })], [qbo()]);
        assert.equal(proposals.length, 0);
    });
    await t.test("empty on the QBO side", () => {
        const { proposals } = proposeAliasMatches([bank()], [qbo({ normalizedPayee: "" })]);
        assert.equal(proposals.length, 0);
    });
});

test("identical payees are not proposed — reconcile already handles them", () => {
    const same = normalizePayee("ACME SUPPLY");
    const { proposals } = proposeAliasMatches(
        [bank({ normalizedPayee: same })],
        [qbo({ normalizedPayee: same })],
    );
    assert.equal(proposals.length, 0);
});

test("a previously confirmed alias raises confidence to 'confirmed'", () => {
    const b = bank();
    const q = qbo();
    const { proposals } = proposeAliasMatches([b], [q], [
        { bankPayee: b.normalizedPayee, qboPayee: q.normalizedPayee },
    ]);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].confidence, "confirmed");
});

test("a pairing with no shared token is proposed at the WEAKEST confidence", () => {
    // "UNITED INTERIOR" vs a bank line reading "UIO PORTLAND OR" shares no
    // token — still surfaced (date+amount are unique) but flagged for a
    // harder human look, never silently trusted.
    const bankRaw = "MISCELLANEOUS DEBIT UIO PORTLAND OR";
    const qboRaw = "UNITED INTERIOR O. Expense";
    const { proposals } = proposeAliasMatches(
        [bank({ rawDescriptor: bankRaw, normalizedPayee: normalizePayee(bankRaw) })],
        [qbo({ rawDescriptor: qboRaw, normalizedPayee: normalizePayee(qboRaw) })],
    );
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].confidence, "unique_date_amount");
    assert.equal(proposals[0].sharedToken, null);
});

test("vendorTokens drops rail nouns, corporate suffixes, and numbers", async t => {
    await t.test("bank rail nouns are not vendor identity", () => {
        const tokens = vendorTokens(normalizePayee("MISCELLANEOUS DEBIT LOWE S #1632 LOWE S  1632 POS DEB 1106"));
        assert.ok(!tokens.has("MISCELLANEOUS"));
        assert.ok(!tokens.has("DEBIT"));
        assert.ok(!tokens.has("POS"));
    });
    await t.test("corporate suffixes and GL nouns are dropped", () => {
        const tokens = vendorTokens(normalizePayee("LOWE'S HOME CENTERS, LLC Expense"));
        assert.ok(!tokens.has("LLC"));
        assert.ok(!tokens.has("EXPENSE"));
        assert.ok(!tokens.has("HOME"));
        assert.ok(tokens.has("LOWE"), "the actual vendor token survives");
    });
    await t.test("store numbers can never be vendor identity", () => {
        const tokens = vendorTokens("LOWE S 1632");
        for (const t of tokens) assert.ok(!/\d/.test(t), `token ${t} contains digits`);
    });
    await t.test("possessive spellings all fold together", () => {
        // The bank prints "LOWE S" (apostrophe lost on the card rail), QBO
        // prints "LOWE'S". Both must reduce to the same token or the vendor
        // never matches itself.
        assert.ok(vendorTokens("LOWE'S").has("LOWE"));
        assert.ok(vendorTokens("LOWES").has("LOWE"));
        assert.ok(vendorTokens("LOWE S").has("LOWE"));
    });
    await t.test("short words are not truncated into collidable stubs", () => {
        assert.ok(vendorTokens("GAS").has("GAS"));
    });
});

test("sharedVendorToken prefers the longest (least collidable) token", () => {
    // Both sides share "ACE"; only one shares "HARDWARE". The longer token is
    // far less likely to be a coincidence.
    const token = sharedVendorToken("MAIN STREET ACE HARDWARE", "ACE HARDWARE PORTLAND");
    assert.equal(token, "HARDWARE");
});

test("aliasesFromProposals dedupes many charges into one durable alias", () => {
    const b = bank();
    const q = qbo();
    const many = [
        { ...b, id: "b1" },
        { ...b, id: "b2", amountCents: -11111 },
        { ...b, id: "b3", amountCents: -22222 },
    ];
    const manyQ = [
        { ...q, id: "q1" },
        { ...q, id: "q2", amountCents: -11111 },
        { ...q, id: "q3", amountCents: -22222 },
    ];
    const { proposals } = proposeAliasMatches(many, manyQ);
    assert.equal(proposals.length, 3, "three separate charges");
    const aliases = aliasesFromProposals(proposals);
    assert.equal(aliases.length, 1, "collapse to ONE alias to confirm");
    assert.equal(aliases[0].bankPayee, b.normalizedPayee);
    assert.equal(aliases[0].qboPayee, q.normalizedPayee);
});

test("empty inputs are handled without throwing", () => {
    assert.deepEqual(proposeAliasMatches([], []), { proposals: [], ambiguous: [] });
    assert.deepEqual(proposeAliasMatches([bank()], []), { proposals: [], ambiguous: [] });
    assert.deepEqual(aliasesFromProposals([]), []);
});
