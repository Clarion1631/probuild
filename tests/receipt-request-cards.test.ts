import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendCardRecord, effectiveOwner } from "../src/lib/receipt-requests";
import {
    CardHistoryRaceError,
    itemsMissingCardRecord,
    recordCardOnIssues,
    type CardHistoryClient,
} from "../src/lib/receipt-card-history";
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
    selectOwnerItems,
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
                // `cleared` is an ADDED key, not a renamed one — the sweep
                // indexes the five it knows and ignores the rest. It is what
                // lets an ANSWERED item stay in its thread (so "sign 2" still
                // means item 2 of the message that was posted) while the bridge
                // renders it resolved instead of asking again.
                items: [{ n: 1, fingerprint: "pb-bl-1", date: "2026-08-16", vendor: "LOWES #02516", cents: 12_345, amount: "123.45", cleared: false }],
            },
        },
    });
    // Key order/name matters to the sweep — assert the keys, not just the values.
    assert.deepEqual(Object.keys(out.threads["spaces/AAQAKhvMYtg/threads/abc"]), ["owner", "owner_user", "message_name", "items"]);
    // The five the sweep reads come FIRST and unrenamed; `cleared` is appended.
    assert.deepEqual(Object.keys(out.threads["spaces/AAQAKhvMYtg/threads/abc"].items[0]),
        ["n", "fingerprint", "date", "vendor", "cents", "amount", "cleared"]);
});

test("an answered item still ships, marked cleared — the numbering must not move", () => {
    // The failure this guards: item 1 of a two-item card is answered, the
    // export drops it, and item 2 is now the only entry — so a crew member
    // replying "sign 2" to the message they can still see resolves nothing.
    const out = serializeThreads([{
        threadName: "t/1",
        messageName: "m/1",
        owner: "CJ",
        items: [
            { n: 1, fingerprint: "pb-bl-1", date: "2026-08-16", vendor: "LOWES", cents: 100, amount: "1.00", cleared: true },
            { n: 2, fingerprint: "pb-bl-2", date: "2026-08-16", vendor: "ARCO", cents: 200, amount: "2.00" },
        ],
    }], {});
    assert.deepEqual(out.threads["t/1"].items.map(i => [i.n, i.cleared]), [[1, true], [2, false]]);
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
    evidenceSatisfied: false,
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

test("evidence found after fingerprinting drops the item — the issue's own clearedAt is stale, not authoritative", () => {
    // The nightly sweep is what normally clears the ReviewIssue, and it runs
    // once a night. A receipt photographed after it ran and booked by the
    // 5-minute intake worker satisfies the charge hours before `clearedAt`
    // moves — asking for it anyway is exactly the noise this re-check exists
    // to prevent (Codex PR #443 gate, finding 1).
    const items = [cardItem("a", 1), cardItem("f", 2)];
    const truth = new Map<string, CardItemTruth>([
        ["a", truthOf()],
        ["f", truthOf({ evidenceSatisfied: true })],
    ]);
    const rebuilt = rebuildCardItems(items, truth, "CJ");
    assert.deepEqual(rebuilt.items.map(i => i.issueId), ["a"]);
    assert.deepEqual(rebuilt.dropped, [{ issueId: "f", reason: "evidence-found" }]);
});

test("evidence-found is checked BEFORE acknowledged/owner — the strongest reason to drop wins", () => {
    const truth = new Map<string, CardItemTruth>([
        ["a", truthOf({ evidenceSatisfied: true, acknowledged: true, owner: "Richard" })],
    ]);
    const rebuilt = rebuildCardItems([cardItem("a", 1)], truth, "CJ");
    assert.deepEqual(rebuilt.dropped, [{ issueId: "a", reason: "evidence-found" }]);
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

test("the cron re-verifies against CURRENT receipt evidence, not just the issue's own clearedAt (finding 1)", () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/app/api/cron/receipt-request-cards/route.ts"),
        "utf8",
    );
    // Reused from the nightly sweep rather than a second matcher. `recompute`
    // defaults to it but is DI'd (Codex PR #443 gate finding 3) so a
    // component-shared cache and a test double can both stand in for it.
    assert.match(source, /import \{ recomputeCodesFor \} from "@\/app\/api\/cron\/receipt-requests\/route";/);
    assert.match(source, /const recompute = deps\.recompute \?\? recomputeCodesFor;/);
    // The run clock goes IN with it (round-34 finding 3): checking the budget
    // only before the call bounded the DECISION to recompute, never the
    // multi-pass component walk and 60-day evidence load the call itself runs.
    assert.match(source, /await recompute\(row\.targetKey, cache, deadlineExceeded\)/);
    // And an abort is read as "not verified", never as a verdict — a `[]` from
    // a recompute means evidence was FOUND, which would close the chase.
    assert.match(source, /if \(!isComponentDeadlineExceeded\(error\)\) throw error;\s*\n\s*revalidationSkipped = true;/);
    // Only spent on an item that would otherwise be sent — already dead for a
    // cheaper reason skips the real evidence query.
    assert.match(source, /clearedAt === null && !resolved && !acknowledged/);
});

// ── An unconfirmed delivery is PARTIAL, and needs a human (round-13 item 6) ─

test("the cards cron reports partial — ok:false, HTTP 200 — for an uncertain send", () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/app/api/cron/receipt-request-cards/route.ts"),
        "utf8",
    );
    // ok:false so it is visible; 200 so the platform does not treat it as a
    // crashed invocation and re-run it (which would risk the duplicate card).
    assert.match(source, /ok: failures\.length === 0 && uncertainTransitions\.length === 0,/);
    assert.match(source, /partial: failures\.length === 0 && uncertainTransitions\.length > 0,/);
    assert.match(source, /status: failures\.length > 0 \? 500 : 200/);
    // TRANSITIONS, not the reported list: an old uncertain row must not make
    // every later run look partial.
    assert.match(source, /const uncertainTransitions: string\[\] = \[\];/);
    const pushes = source.match(/uncertainTransitions\.push\(/g) ?? [];
    assert.equal(pushes.length, 3, "the expired-POSTING conversion, an unknown post, and a lost completion");
    // The expired-POSTING conversion only counts when it actually wrote.
    assert.match(source, /if \(converted\.count > 0\) uncertainTransitions\.push\(owner\);/);
});

test("an uncertain card is surfaced, and resolving it is a CAS", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const actions = readFileSync(join(root, "src/lib/actions.ts"), "utf8");
    assert.match(actions, /export async function resolveUncertainCard\(\s*\n\s*cardId: string,\s*\n\s*decision: "delivered" \| "resend",\s*\n\s*expectedUpdatedAt: string,/);
    assert.match(actions, /where: \{ id: cardId, status: "UNCERTAIN", updatedAt: seenAt \}/);
    // "delivered" closes the day; "resend" hands it back to the retry pass.
    assert.match(actions, /status: "POSTED",[\s\S]{0,200}postedAt: new Date\(\)/);
    assert.match(actions, /status: "PENDING",\s*\n\s*lastError: "resend-requested"/);

    // The queue loads them and the tab renders a group with both actions.
    const data = readFileSync(join(root, "src/app/automation/receipts-data.ts"), "utf8");
    assert.match(data, /prisma\.receiptRequestCard\.count\(\{ where: \{ status: "UNCERTAIN" \} \}\)/);
    const tab = readFileSync(join(root, "src/app/automation/components/receipts/receipts-tab.tsx"), "utf8");
    assert.match(tab, /RECEIPT_GROUP_LABELS\["uncertain-cards"\]/);
    assert.match(tab, /<UncertainCardControls cardId=\{card\.id\} expectedUpdatedAt=\{card\.updatedAt\} \/>/);
    const filters = readFileSync(join(root, "src/app/automation/receipts-filters.ts"), "utf8");
    assert.match(filters, /"uncertain-cards": "Uncertain deliveries"/);
});

// ── A hand-resolved card leaves the same trace (round-15 item 3) ───────────

test("recording a delivered card marks its items CARDED, so tomorrow deprioritises them", () => {
    // The bug this closes: an operator marks an uncertain card delivered, no
    // thread record is written, and the items still read as never carded. The
    // never-carded-first ordering then puts them at the FRONT of tomorrow's
    // card, and the crew is asked again for receipts they were already asked
    // for — which is exactly how a chase list becomes noise.
    const now = new Date("2026-08-20T15:00:00Z");
    const details = appendCardRecord({}, {
        threadName: "spaces/AAQAKhvMYtg/threads/xyz",
        messageName: "spaces/AAQAKhvMYtg/messages/xyz.1",
        n: 1,
        date: "2026-08-20",
        requestId: requestIdFor("CJ", "2026-08-20"),
    }, now);
    // This is what the next day's scan reads to decide `everCarded`.
    assert.ok(Array.isArray(details.cards) && (details.cards as unknown[]).length === 1);
    assert.ok(details.card, "and the latest-card slot the older readers use");

    // Which changes the ordering: a carded item yields to one nobody has asked
    // about yet.
    const carded = issue({ id: "ri-carded", targetKey: "bl-carded", everCarded: true, postedDate: "2026-08-01" });
    const fresh = issue({ id: "ri-fresh", targetKey: "bl-fresh", everCarded: false, postedDate: "2026-08-16" });
    const { items } = selectOwnerItems([carded, fresh], "CJ");
    assert.deepEqual(items.map(i => i.issueId), ["ri-fresh", "ri-carded"], "never-carded first, even though it is newer");
});

test("marking delivered writes the thread record in the SAME transaction", () => {
    const actions = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/lib/actions.ts"),
        "utf8",
    );
    const fn = actions.slice(actions.indexOf("export async function resolveUncertainCard("));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /await prisma\.\$transaction\(async tx => \{/);
    // The card write and the history write are both on `tx`.
    assert.match(body, /const written = await tx\.receiptRequestCard\.updateMany\(/);
    assert.match(body, /await recordCardOnIssues\([\s\S]{0,400}tx,\s*\n\s*\);/);
    // Only on a COMMITTED delivered write — a resend leaves no thread record,
    // because there is no thread.
    assert.match(body, /if \(written\.count === 1 && confirmed && card\) \{/);
    // ONE writer, shared with the cron.
    const cron = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/app/api/cron/receipt-request-cards/route.ts"),
        "utf8",
    );
    assert.match(cron, /import \{ itemsMissingCardRecord, recordCardOnIssues \} from "@\/lib\/receipt-card-history";/);
    assert.doesNotMatch(cron, /async function recordCardOnIssues\(/, "no second copy");
});


// -- Delivery and history commit together (round-16 item 4) ----------------

test("a lost history CAS takes the POSTED write back with it", async () => {
    // A row marked POSTED whose items carry no thread record is a card nobody
    // can answer: a reply in that thread has nothing to resolve against, and
    // the items still read as never-carded so tomorrow asks again. Committing
    // one without the other is the failure.
    const items = [cardItem("a", 1), cardItem("b", 2)];
    const client = {
        reviewIssue: {
            findUnique: async ({ where }: { where: { id: string } }) => ({
                id: where.id, version: 1, displayDetails: "{}", clearedAt: null,
            }),
            // The second item loses its CAS.
            updateMany: async ({ where }: { where: { id: string } }) => ({ count: where.id === "b" ? 0 : 1 }),
            findMany: async () => [],
        },
    } as unknown as CardHistoryClient;

    await assert.rejects(
        () => recordCardOnIssues({ items, date: "2026-08-20", requestId: "req-1" }, "spaces/A/threads/t", "spaces/A/messages/m", new Date(), client),
        (error: unknown) => {
            assert.ok(error instanceof CardHistoryRaceError);
            assert.deepEqual(error.issueIds, ["b"]);
            return true;
        },
    );

    // "report" is for callers with nothing to roll back — the repair pass.
    const reported = await recordCardOnIssues(
        { items, date: "2026-08-20", requestId: "req-1" },
        "spaces/A/threads/t", "spaces/A/messages/m", new Date(), client, "report",
    );
    assert.deepEqual(reported, { recorded: 1, skipped: 0, lostRaces: 1 });
});

test("itemsMissingCardRecord finds exactly the items with no record", async () => {
    const withRecord = JSON.stringify({ cards: [{ requestId: "req-1", date: "2026-08-20", n: 1 }] });
    const withOther = JSON.stringify({ cards: [{ requestId: "req-OTHER", date: "2026-08-19", n: 1 }] });
    const legacySlot = JSON.stringify({ card: { requestId: "req-1", date: "2026-08-20", n: 1 } });
    const rows: Record<string, { displayDetails: string; clearedAt: Date | null }> = {
        "has-it": { displayDetails: withRecord, clearedAt: null },
        "legacy": { displayDetails: legacySlot, clearedAt: null },
        "other-card": { displayDetails: withOther, clearedAt: null },
        "empty": { displayDetails: "{}", clearedAt: null },
        // A CLEARED issue with no record is repaired too. Skipping it left the
        // one case that most needs repair permanently unrepairable: an item
        // whose issue closed before its thread record was written has no record
        // AND no way to get one, so a memo signed in that thread has nothing to
        // resolve against.
        "answered": { displayDetails: "{}", clearedAt: new Date() },
        // Cleared AND already recorded is still not missing.
        "answered-with-record": { displayDetails: withRecord, clearedAt: new Date() },
    };
    const client = {
        reviewIssue: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map(id => ({ id, ...rows[id] })),
            findUnique: async () => null,
            updateMany: async () => ({ count: 1 }),
        },
    } as unknown as CardHistoryClient;

    assert.deepEqual(
        await itemsMissingCardRecord(Object.keys(rows), "req-1", client),
        ["other-card", "empty", "answered"],
    );
    assert.deepEqual(await itemsMissingCardRecord([], "req-1", client), []);
});

test("the cron commits delivery+history together and repairs old gaps", () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/app/api/cron/receipt-request-cards/route.ts"),
        "utf8",
    );
    // ONE transaction: the POSTED write and the history write.
    assert.match(source, /const completed = await prisma\.\$transaction\(async tx => \{[\s\S]{0,900}await recordCardOnIssues\(card, result\.threadName, result\.messageName, now, tx\);/);
    // And no second, un-transacted call after it.
    assert.doesNotMatch(source, /await recordCardOnIssues\(card, result\.threadName, result\.messageName, now\);/);
    // THE REPAIR PASS: bounded, idempotent, and it never fails the run.
    assert.match(source, /const HISTORY_REPAIR_DAYS = 3;/);
    assert.match(source, /const HISTORY_REPAIR_MAX_CARDS = 20;/);
    assert.match(source, /await itemsMissingCardRecord\(items\.map\(item => item\.issueId\), requestId\)/);
    assert.match(source, /if \(missing\.length === 0\) continue;/);
    assert.match(source, /"report",/, "the repair reports a lost race rather than throwing");
    assert.match(source, /history repair failed/, "and never fails the run");
    assert.match(source, /repairedHistory: repaired,/);
});
