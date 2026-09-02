import assert from "node:assert/strict";
import test from "node:test";
import { effectiveOwner } from "../src/lib/receipt-requests";
import {
    CARD_RATE_CEILING,
    MAX_ITEMS_PER_CARD,
    buildCardFromItems,
    buildOwnerCards,
    centsToAmount,
    isPacificWeekday,
    isValidChatWebhookUrl,
    pacificDate,
    parseOwnerChatUsers,
    postOwnerCard,
    requestIdFor,
    rebuildCardItems,
    serializeThreads,
    type CardCandidateIssue,
    type CardItem,
    type CardItemTruth,
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

// ── Tri-state delivery (round-8 item 1) ────────────────────────────────────

async function post(body: unknown, init: ResponseInit = { status: 200 }) {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = (async () => new Response(
            body === null ? "not json" : JSON.stringify(body),
            { headers: { "content-type": "application/json" }, ...init },
        )) as typeof fetch;
        const [card] = buildOwnerCards([issue()], NOW);
        return await postOwnerCard("https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=x", card);
    } finally {
        globalThis.fetch = original;
    }
}

test("a 2xx with both bridge ids is DELIVERED", async () => {
    const r = await post({ name: "spaces/x/messages/1", thread: { name: "spaces/x/threads/1" } });
    assert.equal(r.kind, "delivered");
    assert.deepEqual(r, {
        kind: "delivered", owner: "CJ",
        threadName: "spaces/x/threads/1", messageName: "spaces/x/messages/1",
    });
});

test("a 4xx is REJECTED — Chat declined, nothing is in the space", async () => {
    for (const status of [400, 401, 403, 404, 429]) {
        const r = await post({ error: "nope" }, { status });
        assert.equal(r.kind, "rejected", `http ${status}`);
    }
});

test("an invalid webhook URL is REJECTED — it was never sent", async () => {
    const [card] = buildOwnerCards([issue()], NOW);
    const r = await postOwnerCard("https://evil.example.com/v1/spaces/x", card);
    assert.equal(r.kind, "rejected");
    assert.equal(r.reason, "invalid-webhook-url");
});

test("a 5xx is UNKNOWN — it may have been processed before Chat fell over", async () => {
    for (const status of [500, 502, 503]) {
        const r = await post({ error: "boom" }, { status });
        assert.equal(r.kind, "unknown", `http ${status}`);
    }
});

test("a timeout or socket error is UNKNOWN, never rejected", async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = (async () => { throw new Error("ETIMEDOUT"); }) as typeof fetch;
        const [card] = buildOwnerCards([issue()], NOW);
        const r = await postOwnerCard("https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=x", card);
        assert.equal(r.kind, "unknown");
        assert.equal(r.reason, "network-or-timeout");
    } finally {
        globalThis.fetch = original;
    }
});

test("a 2xx with NO message name is UNKNOWN, not rejected", async () => {
    // Chat accepted it — the card is very probably in the space — we just
    // cannot bridge it. Reposting would double up on a card that did land.
    for (const body of [{}, { name: "m/1" }, { thread: { name: "t/1" } }, { name: "", thread: { name: "t/1" } }]) {
        const r = await post(body);
        assert.equal(r.kind, "unknown", JSON.stringify(body));
        assert.equal(r.reason, "no-bridge-identity");
    }
});

// ── The snapshot is re-verified under the claim, before the send (item 5) ───

const truthOf = (over: Partial<CardItemTruth> = {}): CardItemTruth => ({
    clearedAt: null,
    acknowledged: false,
    resolved: false,
    owner: "CJ",
    ...over,
});

const cardItem = (issueId: string, n: number): CardItem => ({
    n,
    fingerprint: `pb-bl-${issueId}`,
    date: "2026-08-16",
    vendor: "LOWES",
    cents: 12_345,
    amount: "123.45",
    cardTail: "8516",
    issueId,
    targetKey: `bl-${issueId}`,
});

test("an item answered between selection and the send is dropped from the card", () => {
    // Selection happens at the top of the run; a retry pass posts a snapshot
    // claimed hours earlier. Everything that answers an item happens in that
    // window — and the card used to go out regardless.
    const items = [cardItem("a", 1), cardItem("b", 2), cardItem("c", 3), cardItem("d", 4), cardItem("e", 5)];
    const truth = new Map<string, CardItemTruth>([
        ["a", truthOf()],
        // The sweep closed it: the receipt turned up.
        ["b", truthOf({ clearedAt: new Date("2026-08-20T14:00:00Z") })],
        // A memo was signed through the bridge.
        ["c", truthOf({ resolved: true })],
        // A human acknowledged it on the Receipts tab.
        ["d", truthOf({ acknowledged: true })],
        // Marge reassigned it to Richard.
        ["e", truthOf({ owner: "Richard" })],
    ]);

    const rebuilt = rebuildCardItems(items, truth, "CJ");
    assert.deepEqual(rebuilt.items.map(i => i.issueId), ["a"]);
    assert.deepEqual(rebuilt.dropped, [
        { issueId: "b", reason: "cleared" },
        { issueId: "c", reason: "resolved" },
        { issueId: "d", reason: "acknowledged" },
        { issueId: "e", reason: "owner-changed" },
    ]);
});

test("an issue that no longer exists is dropped, not carried", () => {
    const rebuilt = rebuildCardItems([cardItem("gone", 1)], new Map(), "CJ");
    assert.deepEqual(rebuilt.items, []);
    assert.deepEqual(rebuilt.dropped, [{ issueId: "gone", reason: "missing" }]);
});

test("survivors are RENUMBERED, because the numbers are what people reply with", () => {
    // "2 is on the truck" has to mean the second line of the card that was
    // actually posted; a gap in the numbering makes the reply ambiguous.
    const items = [cardItem("a", 1), cardItem("b", 2), cardItem("c", 3)];
    const truth = new Map<string, CardItemTruth>([
        ["a", truthOf({ clearedAt: new Date() })],
        ["b", truthOf()],
        ["c", truthOf()],
    ]);
    const rebuilt = rebuildCardItems(items, truth, "CJ");
    assert.deepEqual(rebuilt.items.map(i => i.n), [1, 2]);
    assert.deepEqual(rebuilt.items.map(i => i.issueId), ["b", "c"]);
    // And the rendered card counts from 1 with no gaps.
    // Anchored per line: the amounts contain dots too ("$123.45").
    const card = buildCardFromItems("CJ", "2026-08-20", rebuilt.items, 0);
    assert.match(card.text, /^1\. /m);
    assert.match(card.text, /^2\. /m);
    assert.doesNotMatch(card.text, /^3\. /m, "no gap, and no third line");
});

test("nothing left to ask about produces an EMPTY rebuild, which cancels the card", () => {
    const items = [cardItem("a", 1), cardItem("b", 2)];
    const truth = new Map<string, CardItemTruth>([
        ["a", truthOf({ clearedAt: new Date() })],
        ["b", truthOf({ resolved: true })],
    ]);
    assert.deepEqual(rebuildCardItems(items, truth, "CJ").items, []);
});

test("an untouched snapshot rebuilds to itself, byte for byte", () => {
    // The common case must not churn the row or renumber anything.
    const items = [cardItem("a", 1), cardItem("b", 2)];
    const truth = new Map<string, CardItemTruth>([["a", truthOf()], ["b", truthOf()]]);
    const rebuilt = rebuildCardItems(items, truth, "CJ");
    assert.deepEqual(rebuilt.items, items);
    assert.deepEqual(rebuilt.dropped, []);
});
