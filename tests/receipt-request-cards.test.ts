import assert from "node:assert/strict";
import test from "node:test";
import { effectiveOwner } from "../src/lib/receipt-requests";
import {
    CARD_RATE_CEILING,
    MAX_ITEMS_PER_CARD,
    buildOwnerCards,
    centsToAmount,
    isPacificWeekday,
    isValidChatWebhookUrl,
    pacificDate,
    parseOwnerChatUsers,
    postOwnerCard,
    requestIdFor,
    serializeThreads,
    type CardCandidateIssue,
} from "../src/lib/receipt-request-cards";

// A Thursday, 8:00 AM Pacific.
const NOW = new Date("2026-08-20T15:00:00Z");

const issue = (over: Partial<CardCandidateIssue> = {}): CardCandidateIssue => ({
    id: "ri-1",
    targetKey: "bl-1",
    owner: "CJ",
    acknowledged: false,
    cardTail: "8516",
    postedDate: "2026-08-16",
    amountCents: -12_345,
    payee: "LOWES #02516",
    fingerprint: "pb-bl-1",
    everCarded: false,
    ...over,
});

test("one card per owner, items numbered from 1, oldest charge first", () => {
    const cards = buildOwnerCards([
        issue({ id: "a", targetKey: "bl-a", postedDate: "2026-08-17", payee: "HOME DEPOT" }),
        issue({ id: "b", targetKey: "bl-b", postedDate: "2026-08-14", payee: "LOWES" }),
        issue({ id: "c", targetKey: "bl-c", owner: "Richard", cardTail: "6098", payee: "NAPA" }),
    ], NOW);

    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map(c => c.owner), ["CJ", "Richard"]);
    assert.deepEqual(cards[0].items.map(i => [i.n, i.vendor]), [[1, "LOWES"], [2, "HOME DEPOT"]]);
    assert.deepEqual(cards[1].items.map(i => i.n), [1]);
});

test("only CJ and Richard are ever asked", async t => {
    for (const owner of ["Justin", "office", "unassigned", "Someone Else"]) {
        await t.test(owner, () => {
            assert.deepEqual(buildOwnerCards([issue({ owner })], NOW), []);
        });
    }
});

test("acknowledged issues are suppressed", () => {
    assert.deepEqual(buildOwnerCards([issue({ acknowledged: true })], NOW), []);
    const cards = buildOwnerCards([issue({ acknowledged: true }), issue({ id: "b", targetKey: "bl-b" })], NOW);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].items.length, 1);
    assert.equal(cards[0].items[0].targetKey, "bl-b");
});

test("requestId is deterministic per owner + Pacific date, and doubles as the thread key", () => {
    const cards = buildOwnerCards([issue()], NOW);
    assert.equal(cards[0].requestId, "receipt-req-CJ-2026-08-20");
    assert.equal(cards[0].requestId, requestIdFor("CJ", pacificDate(NOW)));
    // Same inputs, different Date object → same id. A retried cron cannot fork a thread.
    const again = buildOwnerCards([issue()], new Date("2026-08-20T16:30:00Z"));
    assert.equal(again[0].requestId, cards[0].requestId);
});

test("never-carded items outrank carded ones, however old the carded ones are", () => {
    // Ordering by age alone froze the list: once the ten oldest were on a card,
    // the same ten went out every morning and an eleventh newer charge was
    // never asked about at all.
    const cards = buildOwnerCards([
        issue({ id: "old", targetKey: "bl-old", postedDate: "2026-08-01", everCarded: true }),
        issue({ id: "new", targetKey: "bl-new", postedDate: "2026-08-18", everCarded: false }),
    ], NOW);
    assert.deepEqual(cards[0].items.map(i => i.targetKey), ["bl-new", "bl-old"]);
});

test("yesterday's overflow is today's first candidate", () => {
    const many = Array.from({ length: 12 }, (_, i) => issue({
        id: `ri-${i}`, targetKey: `bl-${i}`,
        postedDate: `2026-08-${String(i + 1).padStart(2, "0")}`,
        // The ten oldest were carded yesterday; two never were.
        everCarded: i < 10,
    }));
    const [card] = buildOwnerCards(many, NOW);
    assert.deepEqual(card.items.slice(0, 2).map(i => i.targetKey), ["bl-10", "bl-11"],
        "the two that did not fit yesterday lead today's card");
});

test("selection is stable across runs — same inputs, same order", () => {
    const input = [
        issue({ id: "b", targetKey: "bl-b", postedDate: "2026-08-16" }),
        issue({ id: "a", targetKey: "bl-a", postedDate: "2026-08-16" }),
    ];
    const first = buildOwnerCards(input, NOW)[0].items.map(i => i.targetKey);
    const second = buildOwnerCards([...input].reverse(), NOW)[0].items.map(i => i.targetKey);
    assert.deepEqual(first, second);
    assert.deepEqual(first, ["bl-a", "bl-b"], "the lowest targetKey breaks a same-date tie");
});

test("a card lists at most 10 items and says how many it held back", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
        issue({ id: `ri-${i}`, targetKey: `bl-${i}`, postedDate: `2026-08-${String(i + 1).padStart(2, "0")}` }));
    const [card] = buildOwnerCards(many, NOW);
    assert.equal(card.items.length, MAX_ITEMS_PER_CARD);
    assert.equal(card.overflow, 4);
    assert.match(card.text, /and 4 more/);
    assert.deepEqual(card.items.map(i => i.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("never more than CARD_RATE_CEILING cards per run", () => {
    // Only two owners are asked, so this can't bind today — asserted anyway so
    // a config change that adds owners can't turn one run into a flood.
    const cards = buildOwnerCards(
        Array.from({ length: 40 }, (_, i) => issue({ id: `ri-${i}`, targetKey: `bl-${i}`, owner: i % 2 ? "CJ" : "Richard" })),
        NOW,
    );
    assert.ok(cards.length <= CARD_RATE_CEILING);
    assert.equal(cards.length, 2);
});

test("the card text carries all three reply options and never mentions email", () => {
    const [card] = buildOwnerCards([issue()], NOW);
    assert.match(card.text, /photo/i);
    assert.match(card.text, /to name the job/i);
    // A one-item card names item 1 — see the single-item test below.
    assert.match(card.text, /sign 1/i);
    assert.doesNotMatch(card.text, /\bemail\b/i);
    assert.match(card.text, /1\. 2026-08-16 · LOWES #02516 · \$123\.45 · card …8516/);
});

test("weekend runs are skipped", () => {
    assert.equal(isPacificWeekday(new Date("2026-08-20T15:00:00Z")), true, "Thursday");
    assert.equal(isPacificWeekday(new Date("2026-08-22T15:00:00Z")), false, "Saturday");
    assert.equal(isPacificWeekday(new Date("2026-08-23T15:00:00Z")), false, "Sunday");
    // 2026-08-24T05:00:00Z is Sunday 10 PM Pacific — Pacific decides, not UTC.
    assert.equal(isPacificWeekday(new Date("2026-08-24T05:00:00Z")), false);
});

test("amounts display as a positive magnitude — a memo states what was spent", () => {
    assert.equal(centsToAmount(-12_345), "123.45");
    assert.equal(centsToAmount(500), "5.00");
    assert.equal(centsToAmount(0), "0.00");
});

test("the threads serializer emits EXACTLY sweepChatReceipts.js's shape", () => {
    const ownerChatUsers = { CJ: "users/111", Richard: "users/222" };
    const out = serializeThreads([{
        threadName: "spaces/AAQAKhvMYtg/threads/abc",
        messageName: "spaces/AAQAKhvMYtg/messages/def",
        owner: "CJ",
        items: [{ n: 1, fingerprint: "pb-bl-1", date: "2026-08-16", vendor: "LOWES #02516", cents: 12_345, amount: "123.45" }],
    }], ownerChatUsers);

    // Snapshot against a literal in the sweep's own shape.
    assert.deepEqual(out, {
        threads: {
            "spaces/AAQAKhvMYtg/threads/abc": {
                owner: "CJ",
                owner_user: "users/111",
                message_name: "spaces/AAQAKhvMYtg/messages/def",
                items: [{ n: 1, fingerprint: "pb-bl-1", date: "2026-08-16", vendor: "LOWES #02516", cents: 12_345, amount: "123.45" }],
            },
        },
    });
    // Key order/name matters to the sweep — assert the keys, not just the values.
    assert.deepEqual(Object.keys(out.threads["spaces/AAQAKhvMYtg/threads/abc"]), ["owner", "owner_user", "message_name", "items"]);
    assert.deepEqual(Object.keys(out.threads["spaces/AAQAKhvMYtg/threads/abc"].items[0]),
        ["n", "fingerprint", "date", "vendor", "cents", "amount"]);
});

test("a missing owner_user is an empty string, never undefined — the JSON must stay valid", () => {
    const out = serializeThreads([{ threadName: "t/1", messageName: "m/1", owner: "CJ", items: [] }], {});
    assert.equal(out.threads["t/1"].owner_user, "");
});

test("parseOwnerChatUsers is config-shaped and fails soft", async t => {
    await t.test("a good map", () => {
        assert.deepEqual(parseOwnerChatUsers('{"CJ":"users/111","Richard":"users/222"}'), { CJ: "users/111", Richard: "users/222" });
    });
    await t.test("unset / malformed / wrong type degrade to {}", () => {
        assert.deepEqual(parseOwnerChatUsers(undefined), {});
        assert.deepEqual(parseOwnerChatUsers("not json"), {});
        assert.deepEqual(parseOwnerChatUsers('["users/111"]'), {});
    });
    await t.test("a value that isn't a users/ id is dropped, not passed through", () => {
        assert.deepEqual(parseOwnerChatUsers('{"CJ":"cj@example.com","Richard":"users/222"}'), { Richard: "users/222" });
    });
});

test("the webhook URL allowlist is an SSRF guard, not a preference", () => {
    assert.equal(isValidChatWebhookUrl("https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=x"), true);
    assert.equal(isValidChatWebhookUrl("https://evil.example.com/v1/spaces/x"), false);
    assert.equal(isValidChatWebhookUrl("http://chat.googleapis.com/v1/spaces/x"), false);
    assert.equal(isValidChatWebhookUrl("https://chat.googleapis.com/v1/other"), false);
    assert.equal(isValidChatWebhookUrl("not a url"), false);
});

// ── A post without a bridge identity is a FAILURE (Codex round-4 item 4) ────

test("postOwnerCard returns null when the response lacks thread.name or message.name", async () => {
    // A 200 with no names looked like success: the row was marked posted, the
    // threads endpoint silently dropped the card, and every reply in that Chat
    // thread was orphaned with nothing to retry.
    const bodies = [
        {},
        { name: "spaces/x/messages/1" },                       // no thread
        { thread: { name: "spaces/x/threads/1" } },            // no message
        { name: "", thread: { name: "spaces/x/threads/1" } },  // empty message
        { name: "spaces/x/messages/1", thread: { name: "" } }, // empty thread
    ];
    const original = globalThis.fetch;
    try {
        for (const body of bodies) {
            globalThis.fetch = (async () => new Response(JSON.stringify(body), {
                status: 200, headers: { "content-type": "application/json" },
            })) as typeof fetch;
            const [card] = buildOwnerCards([issue()], NOW);
            const result = await postOwnerCard("https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=x", card);
            assert.equal(result, null, `body ${JSON.stringify(body)} must be a failure`);
        }

        // Both present → success.
        globalThis.fetch = (async () => new Response(
            JSON.stringify({ name: "spaces/x/messages/1", thread: { name: "spaces/x/threads/1" } }),
            { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
        const [card] = buildOwnerCards([issue()], NOW);
        const ok = await postOwnerCard("https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=x", card);
        assert.deepEqual(ok, { owner: "CJ", threadName: "spaces/x/threads/1", messageName: "spaces/x/messages/1" });
    } finally {
        globalThis.fetch = original;
    }
});

// ── Card copy names an item that EXISTS (Codex round-5 item 6) ──────────────

test("a single-item card's examples say item 1, not item 2", () => {
    // 'reply "sign 2"' on a one-item card is instructions for a message that
    // does not exist; the reader looks for item 2 and stops trusting the card.
    const [card] = buildOwnerCards([issue()], NOW);
    assert.equal(card.items.length, 1);
    assert.match(card.text, /reply \*"1 Mueller Remodel"\* to name the job for item 1/);
    assert.match(card.text, /reply \*"sign 1"\*/);
    assert.doesNotMatch(card.text, /item 2|sign 2/);
});

test("a multi-item card keeps the 2 examples", () => {
    const [card] = buildOwnerCards([issue(), issue({ id: "b", targetKey: "bl-b" })], NOW);
    assert.equal(card.items.length, 2);
    assert.match(card.text, /for item 2/);
    assert.match(card.text, /sign 2/);
});

// ── Overflow is only a NUMBER when it was counted (item 7) ──────────────────

test("an exact overflow prints a total; an unknown one says 'and more'", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
        issue({ id: `ri-${i}`, targetKey: `bl-${i}`, postedDate: `2026-08-${String(i + 1).padStart(2, "0")}` }));

    const exact = buildOwnerCards(many, NOW, true)[0];
    assert.equal(exact.overflow, 4);
    assert.equal(exact.overflowExact, true);
    assert.match(exact.text, /\(10 of 14\)/);
    assert.match(exact.text, /…and 4 more/);

    // The scan stopped at its page cap, so the total would be a guess.
    const inexact = buildOwnerCards(many, NOW, false)[0];
    assert.equal(inexact.overflowExact, false);
    assert.match(inexact.text, /\(10 of more\)/);
    assert.match(inexact.text, /…and more —/);
    assert.doesNotMatch(inexact.text, /and 4 more/);
});

test("no overflow prints a bare count either way", () => {
    for (const exact of [true, false]) {
        const [card] = buildOwnerCards([issue()], NOW, exact);
        assert.match(card.text, /\(1\)/);
        assert.doesNotMatch(card.text, /of more|…and/);
    }
});

// ── effectiveOwner is ONE function (item 2) ────────────────────────────────

test("effectiveOwner: a human's assignment beats the derived owner", () => {
    assert.equal(effectiveOwner({ owner: "unattributed", ownerOverride: "CJ" }), "CJ");
    assert.equal(effectiveOwner({ owner: "office" }), "office");
    assert.equal(effectiveOwner({ owner: "office", ownerOverride: "   " }), "office", "blank is not an assignment");
    assert.equal(effectiveOwner({}), "unassigned");
    assert.equal(effectiveOwner(null), "unassigned");
});

test("an assigned owner reaches the CARD, not just the page", () => {
    // The bug this closes: three surfaces spelled "whose is this" three ways,
    // so an item could move under CJ on the tab and never appear on his card.
    const assigned = issue({ owner: effectiveOwner({ owner: "unattributed", ownerOverride: "CJ" }) });
    const [card] = buildOwnerCards([assigned], NOW);
    assert.equal(card.owner, "CJ");
    assert.equal(card.items.length, 1);
});

test("an UNASSIGNED unattributed item is on nobody's card", () => {
    const unattributed = issue({ owner: effectiveOwner({ owner: "unattributed" }) });
    assert.deepEqual(buildOwnerCards([unattributed], NOW), [], "it waits for a human, it does not guess");
});
