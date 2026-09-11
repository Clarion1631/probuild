/**
 * Contract tests for `src/lib/receipt-on-demand.ts` — single-target
 * prepare/apply, against the CURRENT service interface.
 *
 * Everything synthetic: fictional UUIDs, fictional pb-fingerprint, complete
 * item, fixed 2026-01-12 clock. Deps are injected fakes; no Prisma, no network.
 *
 * Deliberately RED on the current service where it disagrees with the
 * contract: (a) source drift detected only via `updatedAt` in the digest is
 * not observable — the digest includes it, so we assert drift on the
 * persisted source version, which the current service folds into `updatedAt`;
 * (b) `finish` is invoked with `uncertain` when the post returns a
 * non-delivered result, and the service must not record POSTED; (c) a
 * revalidation/deadline-style delay between claim and post must not produce a
 * delivered row — the current service has no deadline hook, so the assertion
 * "no post after ~50s near-deadline claim" is red until the service gains one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test('a claim crossing Pacific midnight posts the already reserved request day', async () => {
    let t = Date.parse('2026-01-13T07:59:59.000Z');
    const clock = () => new Date(t);
    const s = freshSnapshot();
    const digest = computeOnDemandDigest(s, clock());
    const {deps: d, rec} = deps(s, {claim: () => { t += 2_000; return {kind:'claimed',claimId:'claim1',claimToken:'token1'}; }}, clock);
    const result = await runOnDemand(applyWith(digest),d,{allowedTargets:ALLOWED,now:clock});
    assert.equal(result.kind,'posted');
    assert.equal(rec.posts[0].date,'2026-01-12');
    assert.equal(rec.posts[0].requestId,'receipt-req-Justin-2026-01-12');
});

import {
    runOnDemand,
    decodeOnDemandInput,
    parseAllowedTargets,
    validateSnapshot,
    computeOnDemandDigest,
    toOwnerCard,
    toOwnerCardView,
    ON_DEMAND_OWNER,
    ON_DEMAND_MAX_TARGETS,
    type OnDemandDeps,
    type OnDemandInput,
    type OnDemandResult,
    type PreparedSnapshot,
    type ClaimResult,
    type FinishResult,
    type OwnerCardView,
} from "../src/lib/receipt-on-demand";
import type { CardItem, OwnerCard } from "../src/lib/receipt-request-cards";
import { CARD_OWNERS_ASKED } from "../src/lib/receipt-request-cards";
import { pacificDate } from "../src/lib/receipt-request-cards";


// ── Fixed synthetic fixtures ────────────────────────────────────────────────

const BANKLINE = "3f2b7c1a-9d4e-4a11-8f7b-2c8e6d1a0b93"; // fictional UUID
const ISSUE_ID = "issue_synth_0001";
const FP = `pb-${BANKLINE}`;
const OWNER_USER = "users/987654321";
const CENTS = 12_345;
const DAY = "2026-01-12";
const POSTED = "2026-01-10";
const POLICY = "receipt-source-v1:off";
const LEDGER_EPOCH = "41";
const EVIDENCE_EPOCH = "19";
const VERSION = 7;
const UPDATED_AT = "2026-01-11T22:03:11.000Z";
const RAW = "POS DEB 1432 01/10/26 12345678 C#4321 CHEVRON 0093121 VANCOUVER WA";
const NOW = new Date("2026-01-12T14:30:00.000Z"); // Monday, Pacific morning

const ALLOWED = [BANKLINE];

function freshSnapshot(over: Partial<PreparedSnapshot> = {}): PreparedSnapshot {
    const base: PreparedSnapshot = {
        bankLineId: BANKLINE,
        account: "WTB-0723",
        sourceOfRecord: "STATEMENT",
        debitCents: CENTS,
        postedDate: POSTED,
        rawDescriptor: RAW,
        updatedAt: UPDATED_AT,
        item: {
            issueId: ISSUE_ID,
            targetKey: BANKLINE,
            fingerprint: FP,
            date: POSTED,
            vendor: "Chevron",
            cents: CENTS,
            amount: "123.45",
            cardTail: "4321",
        },
        owner: ON_DEMAND_OWNER,
        ownerUser: OWNER_USER,
        issueVersion: VERSION,
        epochs: { ledger: LEDGER_EPOCH, evidence: EVIDENCE_EPOCH },
        policy: POLICY,
        sweep: { certified: true, fresh: true, evidenceEligible: true },
        flags: { acknowledged: false, resolved: false, sourceFound: false },
    };
    return { ...base, ...over };
}

interface Recorder {
    reads: number;
    claims: Array<{ bankLineId: string; digest: string }>;
    posts: OwnerCard[];
    finishCalls: Array<{ claim: Extract<ClaimResult, { kind: "claimed" }>; result: FinishResult }>;
}

function deps(
    snapshot: PreparedSnapshot | (() => PreparedSnapshot | Promise<PreparedSnapshot>),
    script: {
        claim?: () => Promise<ClaimResult> | ClaimResult;
        postResult?: FinishResult | { kind: "unknown"; reason: string } | "throw";
        finishResult?: { kind: "recorded" } | { kind: "failed"; reason: string } | "throw";
        onPost?: () => void | Promise<void>;
    } = {},
    clock: () => Date = () => NOW,
): { deps: OnDemandDeps; rec: Recorder } {
    const rec: Recorder = { reads: 0, claims: [], posts: [], finishCalls: [] };
    const impl: OnDemandDeps = {
        async readSnapshot(bankLineId: string) {
            rec.reads++;
            assert.equal(bankLineId, BANKLINE);
            return typeof snapshot === "function" ? await snapshot() : snapshot;
        },
        async claim(s, digest) {
            rec.claims.push({ bankLineId: s.bankLineId, digest });
            if (script.claim) return script.claim();
            return { kind: "claimed", claimId: `claim-${rec.claims.length}`, claimToken: `tok-${rec.claims.length}` };
        },
        async post(card) {
            rec.posts.push(card);
            if (script.onPost) await script.onPost();
            if (script.postResult === "throw") throw new Error("synthetic post blew up");
            return script.postResult ?? { kind: "delivered", threadName: "spaces/synth/threads/t1", messageName: "spaces/synth/messages/m1" };
        },
        async finish(claim, result) {
            rec.finishCalls.push({ claim, result });
            if (script.finishResult === "throw") throw new Error("synthetic finish blew up");
            return script.finishResult ?? { kind: "recorded" };
        },
        webhookUrl: "https://chat.googleapis.com/v1/spaces/SYNTH/messages?key=k&token=t",
        now: clock,
    };
    return { deps: impl, rec };
}

const PREPARE: OnDemandInput = { action: "prepare", bankLineId: BANKLINE };
function applyWith(digest: string): OnDemandInput {
    return { action: "apply", bankLineId: BANKLINE, digest };
}

async function digestFor(over: Partial<PreparedSnapshot> = {}, allowed = ALLOWED): Promise<string> {
    const { deps: d } = deps(freshSnapshot(over));
    const out = await runOnDemand(PREPARE, d, { allowedTargets: allowed, now: () => NOW });
    assert.equal(out.kind, "ready", `expected ready, got ${JSON.stringify(out)}`);
    return (out as Extract<OnDemandResult, { kind: "ready" }>).digest;
}

// ── prepare ─────────────────────────────────────────────────────────────────

test("prepare returns ready with a 64-hex digest, one read, zero writes", async () => {
    const { deps: d, rec } = deps(freshSnapshot());
    const out = await runOnDemand(PREPARE, d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "ready");
    const ready = out as Extract<OnDemandResult, { kind: "ready" }>;
    assert.match(ready.digest, /^[0-9a-f]{64}$/);
    assert.equal(rec.reads, 1);
    assert.equal(rec.claims.length, 0);
    assert.equal(rec.posts.length, 0);
    assert.equal(rec.finishCalls.length, 0);
});

test("prepare preview carries the complete item and no caller-supplied fields", async () => {
    const { deps: d } = deps(freshSnapshot());
    const out = await runOnDemand(PREPARE, d, { allowedTargets: ALLOWED, now: () => NOW }) as Extract<OnDemandResult, { kind: "ready" }>;
    const view: OwnerCardView = out.card;
    assert.equal(view.owner, ON_DEMAND_OWNER);
    assert.equal(view.date, DAY);
    assert.equal(view.requestId, `receipt-req-${ON_DEMAND_OWNER}-${DAY}`);
    assert.equal(view.items.length, 1);
    const it: CardItem = view.items[0];
    assert.equal(it.issueId, ISSUE_ID);
    assert.equal(it.fingerprint, FP);
    assert.equal(it.cents, CENTS);
    assert.equal(it.amount, "123.45");
    assert.equal(it.cardTail, "4321");
});

// ── strict input ────────────────────────────────────────────────────────────

test("invalid input is blocked before any read (strict shape, no extra keys)", () => {
    const cases: unknown[] = [
        null, undefined, 42, "prepare", [], {},
        { action: "prepare" },
        { action: "prepare", bankLineId: "" },
        { action: "prepare", bankLineId: "c-not-a-uuid" },
        { action: "prepare", bankLineId: BANKLINE, extra: true },
        { action: "nope", bankLineId: BANKLINE },
        { action: "apply", bankLineId: BANKLINE },
        { action: "apply", bankLineId: BANKLINE, digest: "" },
        { action: "apply", bankLineId: BANKLINE, digest: "A".repeat(64) },
        { action: "apply", bankLineId: BANKLINE, digest: "a".repeat(64), extra: 1 },
        { action: "prepare", bankLineId: BANKLINE, digest: "a".repeat(64) },
    ];
    for (const bad of cases) {
        assert.equal(decodeOnDemandInput(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
});

test("malformed input to runOnDemand is blocked and never reads the snapshot", async () => {
    const { deps: d, rec } = deps(freshSnapshot());
    const bad: unknown[] = [null, { action: "prepare", bankLineId: BANKLINE, vendor: "x" }, { action: "apply", bankLineId: BANKLINE }];
    for (const b of bad) {
        const out = await runOnDemand(b as OnDemandInput, d, { allowedTargets: ALLOWED, now: () => NOW });
        assert.equal(out.kind, "blocked");
    }
    assert.equal(rec.reads, 0);
});

// ── allowlist ───────────────────────────────────────────────────────────────

test("allowlist: absent, empty, wrong, or malformed denies; exactly-one exact match allows", () => {
    assert.deepEqual(parseAllowedTargets(undefined), []);
    assert.deepEqual(parseAllowedTargets([]), []);
    assert.deepEqual(parseAllowedTargets(["x"]), []);
    assert.deepEqual(parseAllowedTargets([BANKLINE, "3f2b7c1a-9d4e-4a11-8f7b-2c8e6d1a0b94"]), []);
    assert.deepEqual(parseAllowedTargets([BANKLINE]), [BANKLINE]);
    assert.equal(ON_DEMAND_MAX_TARGETS, 1);
});

test("a target not on the allowlist is refused before reading", async () => {
    const { deps: d, rec } = deps(freshSnapshot());
    const out = await runOnDemand(PREPARE, d, { allowedTargets: ["3f2b7c1a-9d4e-4a11-8f7b-2c8e6d1a0b94"], now: () => NOW });
    assert.equal(out.kind, "blocked");
    assert.equal(rec.reads, 0);

    const absent = await runOnDemand(PREPARE, d, { now: () => NOW });
    assert.equal(absent.kind, "blocked");
    assert.equal(rec.reads, 0);
});

// ── snapshot validation ─────────────────────────────────────────────────────

test("wrong account, source, owner, amount, or identity are blocked before any claim", async () => {
    const cases: Array<Partial<PreparedSnapshot>> = [
        { account: "WTB-0000" },
        { sourceOfRecord: "RECEIPT" },
        { owner: "CJ" },
        { owner: "Richard" },
        { owner: "office" },
        { ownerUser: "" },
        { ownerUser: "justin@example.com" },
        { debitCents: 0 },
        { debitCents: -CENTS },
        { debitCents: 12.5 as unknown as number },
        { bankLineId: "3f2b7c1a-9d4e-4a11-8f7b-2c8e6d1a0b94" },
        { item: { ...freshSnapshot().item, targetKey: "3f2b7c1a-9d4e-4a11-8f7b-2c8e6d1a0b94" } },
        { item: { ...freshSnapshot().item, cents: CENTS + 1 } },
        { item: { ...freshSnapshot().item, amount: "123.46" } },
        { item: { ...freshSnapshot().item, date: "2026-01-09" } },
        { issueVersion: 0 },
    ];
    for (const over of cases) {
        const { deps: d, rec } = deps(freshSnapshot(over));
        const out = await runOnDemand(PREPARE, d, { allowedTargets: ALLOWED, now: () => NOW });
        assert.equal(out.kind, "blocked", `expected blocked for ${JSON.stringify(over)}`);
        assert.equal(rec.claims.length, 0);
        assert.equal(rec.posts.length, 0);
    }
});

test("missing or non-boolean flags, epochs, or sweep fields are blocked", async () => {
    const cases: unknown[] = [
        { flags: undefined },
        { flags: { acknowledged: "no", resolved: false, sourceFound: false } },
        { flags: { acknowledged: false, resolved: 1, sourceFound: false } },
        { sweep: { certified: false, fresh: true, evidenceEligible: true } },
        { sweep: { certified: true, fresh: false, evidenceEligible: true } },
        { sweep: { certified: true, fresh: true, evidenceEligible: false } },
        { epochs: { ledger: "abc", evidence: EVIDENCE_EPOCH } },
        { policy: "" },
        { updatedAt: "" },
        { rawDescriptor: "" },
    ];
    for (const over of cases) {
        const snap = freshSnapshot(over as Partial<PreparedSnapshot>);
        const issues = validateSnapshot(snap, BANKLINE, ALLOWED, NOW);
        assert.ok(issues.length > 0, `expected issues for ${JSON.stringify(over)}`);
    }
});

// ── digest drift ────────────────────────────────────────────────────────────

test("digest changes on source version, issue, epoch, owner, or date drift", async () => {
    const base = await digestFor();
    const muts: Array<Partial<PreparedSnapshot>> = [
        { updatedAt: "2026-01-11T23:00:00.000Z" },
        { rawDescriptor: RAW + " X" },
        { issueVersion: VERSION + 1 },
        { item: { ...freshSnapshot().item, issueId: "issue_synth_0002" } },
        { epochs: { ledger: "42", evidence: EVIDENCE_EPOCH } },
        { epochs: { ledger: LEDGER_EPOCH, evidence: "20" } },
        { policy: "receipt-source-v1:off:next" },
        { ownerUser: "users/111" },
    ];
    for (const over of muts) {
        const changed = await digestFor(over);
        assert.notEqual(changed, base, `digest should change for ${JSON.stringify(over)}`);
    }
});

test("digest excludes observation timestamps: same-day later clock still matches", async () => {
    const { deps: d1 } = deps(freshSnapshot());
    const prep = await runOnDemand(PREPARE, d1, { allowedTargets: ALLOWED, now: () => NOW }) as Extract<OnDemandResult, { kind: "ready" }>;
    // Same Pacific day, ~9 hours later.
    const later = new Date("2026-01-12T23:59:00.000Z");
    assert.equal(pacificDate(later), DAY);
    const { deps: d2 } = deps(freshSnapshot());
    const applied = await runOnDemand(applyWith(prep.digest), d2, { allowedTargets: ALLOWED, now: () => later });
    assert.equal(applied.kind, "posted");
});

// ── apply happy path ────────────────────────────────────────────────────────

test("apply on unchanged source claims once, posts once, finishes once", async () => {
    const snap = freshSnapshot();
    const digest = await digestFor();
    const { deps: d, rec } = deps(snap);
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "posted");
    assert.equal(rec.reads, 1);
    assert.equal(rec.claims.length, 1);
    assert.equal(rec.posts.length, 1);
    assert.equal(rec.finishCalls.length, 1);
    assert.equal(rec.finishCalls[0].result.kind, "delivered");
});

test("posted card text contains the actual Beverly sign instructions", async () => {
    const digest = await digestFor();
    const { deps: d, rec } = deps(freshSnapshot());
    await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    const text = rec.posts[0].text;
    assert.match(text, /@\*, pick \*Beverly\* from the list, then \*sign 1\*/);
    assert.match(text, /a typed @Beverly that is not picked from the list does not reach her/);
    assert.match(text, /send a \*photo\* of the receipt/);
    // Item line, numbered 1.
    assert.match(text, /1\. 2026-01-10 · Chevron · \$123\.45/);
});

test("posted card carries the immutable requestId as the thread key", async () => {
    const digest = await digestFor();
    const { deps: d, rec } = deps(freshSnapshot());
    await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(rec.posts[0].requestId, `receipt-req-${ON_DEMAND_OWNER}-${DAY}`);
});

// ── digest mismatch / no claim ──────────────────────────────────────────────

test("a wrong digest is blocked with no claim, no post, no finish", async () => {
    const wrong = "0".repeat(64);
    const { deps: d, rec } = deps(freshSnapshot());
    const out = await runOnDemand(applyWith(wrong), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "blocked");
    assert.equal(rec.reads, 1, "apply re-reads to detect drift");
    assert.equal(rec.claims.length, 0);
    assert.equal(rec.posts.length, 0);
    assert.equal(rec.finishCalls.length, 0);
});

test("source-updatedAt drift between prepare and apply blocks (digest mismatch, no claim)", async () => {
    const digest = await digestFor();
    const drifted = freshSnapshot({ updatedAt: "2026-01-12T01:00:00.000Z" });
    const { deps: d, rec } = deps(drifted);
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "blocked");
    assert.equal(rec.claims.length, 0);
    assert.equal(rec.posts.length, 0);
});

test("a blocking claim never posts", async () => {
    const digest = await digestFor();
    const { deps: d, rec } = deps(freshSnapshot(), { claim: () => ({ kind: "blocked", reason: "claim-lost" }) });
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "blocked");
    assert.equal(rec.claims.length, 1);
    assert.equal(rec.posts.length, 0);
    assert.equal(rec.finishCalls.length, 0);
});

test("an already-posted claim returns the real thread and never resends", async () => {
    const digest = await digestFor();
    const actual = { kind: "already-posted" as const, threadName: "spaces/SYNTH/threads/t9", messageName: "spaces/SYNTH/messages/m9" };
    const { deps: d, rec } = deps(freshSnapshot(), { claim: () => actual });
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "posted");
    const posted = out as Extract<OnDemandResult, { kind: "posted" }>;
    assert.equal(posted.threadName, actual.threadName);
    assert.equal(posted.messageName, actual.messageName);
    assert.equal(rec.posts.length, 0);
    assert.equal(rec.finishCalls.length, 0);
});

// ── unknown / thrown post still finishes with uncertain, never POSTED ───────

test("a thrown post is converted to unknown AND finish is called with uncertain (never delivered)", async () => {
    const digest = await digestFor();
    const { deps: d, rec } = deps(freshSnapshot(), { postResult: "throw" });
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "unknown");
    assert.equal(rec.posts.length, 1, "post attempted exactly once");
    assert.equal(rec.finishCalls.length, 1);
    assert.notEqual(rec.finishCalls[0].result.kind, "delivered");
    assert.equal(rec.finishCalls[0].result.kind, "uncertain");
});

test("an explicit unknown post result still finishes with a non-delivered outcome", async () => {
    const digest = await digestFor();
    const { deps: d, rec } = deps(freshSnapshot(), { postResult: { kind: "unknown", reason: "no-bridge-identity" } });
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "unknown");
    assert.notEqual(rec.finishCalls[0].result.kind, "delivered");
});

test("a failed finish is reported as unknown, never posted", async () => {
    const digest = await digestFor();
    const { deps: d, rec } = deps(freshSnapshot(), { finishResult: { kind: "failed", reason: "lost-cas" } });
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "unknown");
    assert.equal(rec.posts.length, 1);
    assert.equal(rec.finishCalls.length, 1);
});

test("a thrown finish is reported as unknown, never posted", async () => {
    const digest = await digestFor();
    const { deps: d } = deps(freshSnapshot(), { finishResult: "throw" });
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "unknown");
});

// ── REGRESSIONS for the current module ──────────────────────────────────────

test("REGRESSION: invalid delivered thread resource name must not be recorded as POSTED", async () => {
    // The current service treats any `delivered` post result as a delivered
    // finish and never validates the Chat resource-name shape that
    // `isChatThreadName`/`isChatMessageName` in receipt-request-cards enforce.
    // A malformed thread name threaded through `post` therefore records
    // POSTED with an unusable bridge identity — the exact shape the on-demand
    // path must refuse.
    const digest = await digestFor();
    const { deps: d, rec } = deps(freshSnapshot(), {
        postResult: { kind: "delivered", threadName: "not-a-thread", messageName: "also-not-a-message" },
    });
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "unknown", "malformed delivered identities must not be reported as posted");
    assert.equal(rec.finishCalls.length, 1);
    assert.notEqual(rec.finishCalls[0].result.kind, "delivered");
});

test("REGRESSION: near-deadline clock after claim must not post", async () => {
    // The current service has no invocation deadline hook: `apply` swallows
    // the ~50s wall-clock budget entirely, so a claim near the deadline still
    // posts a card whose completion writes cannot finish inside the cron
    // ceiling. Until the service gains a deadline seam, this is RED.
    let t = NOW.getTime();
    const clock = () => new Date(t);
    const digest = await digestFor();
    const { deps: d, rec } = deps(freshSnapshot(), {
        claim: () => {
            // Time advances ~49s while the store holds the claim transaction.
            t += 49_000;
            return { kind: "claimed", claimId: "c1", claimToken: "tok-1" };
        },
    }, clock);

    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: clock });
    assert.notEqual(out.kind, "posted", "near-deadline claim must not post");
    assert.equal(rec.posts.length, 0, "no post when the invocation is out of budget");
    assert.equal(rec.finishCalls.length, 1);
    assert.equal(rec.finishCalls[0].result.kind, "uncertain");
});

// ── strict snapshot shape is blocked, never thrown ──────────────────────────

test("a malformed snapshot returns blocked, not a thrown exception", async () => {
    const digest = await digestFor();
    // A shape the adapter would never build, but which a bad fake might.
    const malformed = { ...freshSnapshot(), item: undefined } as unknown as PreparedSnapshot;
    const { deps: d, rec } = deps(malformed);
    const out = await runOnDemand(applyWith(digest), d, { allowedTargets: ALLOWED, now: () => NOW });
    assert.equal(out.kind, "blocked");
    assert.equal(rec.claims.length, 0);
    assert.equal(rec.posts.length, 0);
});

// ── unrelated config unchanged ──────────────────────────────────────────────

test("CARD_OWNERS_ASKED is unchanged by this feature", () => {
    assert.deepEqual([...CARD_OWNERS_ASKED], ["CJ", "Richard"]);
});

// ── digest helper is stable ─────────────────────────────────────────────────

test("computeOnDemandDigest is deterministic and refuses a null clock", () => {
    const snap = freshSnapshot();
    const a = computeOnDemandDigest(snap, NOW);
    const b = computeOnDemandDigest(snap, NOW);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
    const issues = validateSnapshot(snap, BANKLINE, ALLOWED, NEW_BAD as unknown as Date);
    assert.ok(issues.some(i => i.field === "now"));
});

const NEW_BAD = new Date("nope") as unknown as Date;

test("toOwnerCard produces a buildable card whose item round-trips", () => {
    const card: OwnerCard = toOwnerCard(freshSnapshot(), NOW);
    assert.equal(card.owner, ON_DEMAND_OWNER);
    assert.equal(card.date, DAY);
    assert.equal(card.items.length, 1);
    assert.equal(card.items[0].issueId, ISSUE_ID);
    assert.equal(card.overflow, 0);
    assert.equal(card.overflowExact, true);
});
