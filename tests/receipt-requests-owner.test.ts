import assert from "node:assert/strict";
import test from "node:test";
import { CARD_OWNERS, resolveReceiptOwner } from "../src/lib/receipt-policy";
import { planReceiptRequests } from "../src/lib/receipt-requests";

// Owner resolution decides WHO gets asked. Getting it wrong doesn't just
// misroute a card — chatAffidavitApp.js gates signing on the owner, so a wrong
// owner locks someone out of signing their own memo.

const NOW = new Date("2026-08-20T09:00:00Z");

function ownerFor(rawDescriptor: string) {
    const { open } = planReceiptRequests({
        bankLines: [{ id: "bl-1", postedDate: "2026-08-16", amountCents: -5_000, rawDescriptor, checkNumber: null }],
        expenses: [],
        intakes: [],
        openIssueKeys: [],
        now: NOW,
    });
    assert.equal(open.length, 1, `expected ${rawDescriptor} to open a request`);
    return open[0].displayDetails;
}

test("card tails resolve to their owner", async t => {
    await t.test("C#8516 → CJ", () => {
        const details = ownerFor("LOWES #02516 POS DEB C#8516");
        assert.equal(details.owner, "CJ");
        assert.equal(details.cardTail, "8516");
    });
    await t.test("C# 6098 (spaced) → Richard", () => {
        const details = ownerFor("HOME DEPOT #4718 DBT CRD C# 6098");
        assert.equal(details.owner, "Richard");
        assert.equal(details.cardTail, "6098");
    });
    await t.test("C#4297 → Justin", () => {
        const details = ownerFor("ANTHROPIC C#4297");
        assert.equal(details.owner, "Justin");
        assert.equal(details.cardTail, "4297");
    });
});

test("no card tail → office (an ACH/check/transfer the office owns, never the crew)", () => {
    const details = ownerFor("PACIFIC PLUMBING SUPPLY ACH");
    assert.equal(details.owner, "office");
    assert.equal(details.cardTail, null);
});

test("an unknown tail is 'unassigned' — never silently attributed to someone", () => {
    const details = ownerFor("SOME VENDOR C#0000");
    assert.equal(details.owner, "unassigned");
    assert.equal(details.cardTail, "0000");
});

test("a descriptor carrying two card refs resolves to the FIRST, deterministically — no ambiguous owner", () => {
    // The regex takes the first match. This test exists so the behaviour is a
    // decision on record rather than an accident: a two-tail descriptor is a
    // data oddity, and picking the first is stable across runs.
    const a = ownerFor("VENDOR C#8516 SETTLED C#6098");
    const b = ownerFor("VENDOR C#8516 SETTLED C#6098");
    assert.equal(a.owner, "CJ");
    assert.equal(a.cardTail, b.cardTail);
});

test("the matcher owns no card literals — CARD_OWNERS is the single config map", () => {
    // Mutating the exported map must change the matcher's answer. If the
    // matcher had its own copy of the tails, this would still say "CJ".
    const original = CARD_OWNERS["8516"];
    try {
        CARD_OWNERS["8516"] = "Richard";
        assert.equal(resolveReceiptOwner("X C#8516").owner, "Richard");
        assert.equal(ownerFor("LOWES C#8516").owner, "Richard");
    } finally {
        CARD_OWNERS["8516"] = original;
    }
    assert.equal(ownerFor("LOWES C#8516").owner, "CJ");
});
