/**
 * The external heartbeat ping (Healthchecks.io-style dead man's switch) money
 * crons call via `withCronHeartbeat`.
 *
 * Round 2 (Codex review of the first pass, which called `pingCronHeartbeat`
 * inline in each route) fixed:
 *   1. latency/lease: the wrapper must add no latency on the request path
 *      when a real request scope is available (proven indirectly: every test
 *      below observes the finish ping synchronously after awaiting the
 *      wrapped handler, which only holds if the no-request-scope fallback —
 *      the one this test file actually exercises, since it calls wrapped
 *      handlers directly rather than through a real Next.js request — awaits
 *      the ping rather than firing it detached).
 *   2. misclassification, first pass: non-2xx is a failure by default, 2xx
 *      is a success by default.
 *   3. a thrown handler error still pings fail (no gap before a route's own
 *      try/catch, because the wrapper's try/catch is OUTSIDE the handler).
 *   4. the timeout bounds a fetch call that never resolves at all, not just
 *      a slow one.
 *   5. detail sanitizing: only a short safe code (or "status-<code>") ever
 *      reaches the ping body; anything else becomes "error".
 *
 * Round 3 (Codex review of round 2) fixed two more, both covered below:
 *   6. round 2's single `isFailure(body)` was consulted for every response
 *      regardless of status, so a predicate written to clear an intentional
 *      non-2xx skip could also clear an unrelated non-2xx it said nothing
 *      about — including a bare 401 on every route that had a predicate at
 *      all. Split into `isFailure` (2xx-only, escalate-only) and `isSkip`
 *      (non-2xx-only, clear-only).
 *   7. the start ping was fire-and-forget, so it could still be in flight
 *      when the terminal ping's request landed — out-of-order delivery at
 *      the heartbeat endpoint reads as a new run starting after the real one
 *      already finished. The finish task now awaits the kept start-ping
 *      promise before sending the terminal ping.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";
import { pingCronHeartbeat, sanitizeDetail, withCronHeartbeat, isRecord } from "../src/lib/cron-heartbeat";

type FetchCall = { url: string; init: RequestInit | undefined };

const originalFetch = globalThis.fetch;

let calls: FetchCall[];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

function defaultFetchImpl(): typeof fetchImpl {
    return async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 200 });
    };
}

beforeEach(() => {
    calls = [];
    fetchImpl = defaultFetchImpl();
    globalThis.fetch = ((url: string, init?: RequestInit) => fetchImpl(url, init)) as unknown as typeof fetch;
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("HC_PING_URL_")) delete process.env[key];
    }
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("HC_PING_URL_")) delete process.env[key];
    }
});

// ── sanitizeDetail ───────────────────────────────────────────────────────────

test("sanitizeDetail passes short safe codes through unchanged", () => {
    assert.equal(sanitizeDetail("quickbooks-not-connected"), "quickbooks-not-connected");
    assert.equal(sanitizeDetail("TypeError"), "TypeError");
    assert.equal(sanitizeDetail("status-404"), "status-404");
    assert.equal(sanitizeDetail("a".repeat(40)), "a".repeat(40));
    assert.equal(sanitizeDetail(undefined), undefined);
});

test("sanitizeDetail rejects anything else, including free text", () => {
    assert.equal(sanitizeDetail("QuickBooks is not connected (see Settings)"), "error");
    assert.equal(sanitizeDetail("has a space"), "error");
    assert.equal(sanitizeDetail("a".repeat(41)), "error");
    assert.equal(sanitizeDetail(""), "error");
    assert.equal(sanitizeDetail("semi;colon"), "error");
    assert.equal(sanitizeDetail("newline\nhere"), "error");
});

// ── pingCronHeartbeat (low level) ───────────────────────────────────────────

test("no env var set means no fetch at all", async () => {
    await pingCronHeartbeat("TEST_JOB", "start");
    await pingCronHeartbeat("TEST_JOB", "success");
    await pingCronHeartbeat("TEST_JOB", "fail", "boom");
    assert.equal(calls.length, 0);
});

test("start/success/fail hit the right URL suffixes", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    await pingCronHeartbeat("TEST_JOB", "start");
    await pingCronHeartbeat("TEST_JOB", "success");
    await pingCronHeartbeat("TEST_JOB", "fail", "reason-code");
    assert.equal(calls[0].url, "https://hc-ping.test/abc123/start");
    assert.equal(calls[1].url, "https://hc-ping.test/abc123");
    assert.equal(calls[2].url, "https://hc-ping.test/abc123/fail");
});

test("only the fail ping carries a body, and it goes through sanitizeDetail", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    await pingCronHeartbeat("TEST_JOB", "start");
    await pingCronHeartbeat("TEST_JOB", "success");
    assert.equal(calls[0].init?.body, undefined);
    assert.equal(calls[1].init?.body, undefined);

    await pingCronHeartbeat("TEST_JOB", "fail", "short-reason");
    assert.equal(calls[2].init?.body, "short-reason");

    await pingCronHeartbeat("TEST_JOB", "fail", "a raw error message with spaces");
    assert.equal(calls[3].init?.body, "error");
});

test("a rejecting fetch (network error) is swallowed, never thrown", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    fetchImpl = async () => { throw new Error("NETWORK DOWN"); };
    await assert.doesNotReject(() => pingCronHeartbeat("TEST_JOB", "start"));
    await assert.doesNotReject(() => pingCronHeartbeat("TEST_JOB", "fail", "reason"));
});

test("a non-2xx response is swallowed too, not thrown", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    fetchImpl = async () => new Response(null, { status: 500 });
    await assert.doesNotReject(() => pingCronHeartbeat("TEST_JOB", "success"));
});

test("a fetch that never resolves is aborted by the timer, not left hanging forever", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    // Resolves ONLY when the signal aborts — proves the timeout actually
    // interrupts a call that would otherwise never return, not just a slow
    // one. Real time (PING_TIMEOUT_MS, 3s): this is the one test in the file
    // that waits out the real clock on purpose.
    fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
    const startedAt = Date.now();
    await assert.doesNotReject(() => pingCronHeartbeat("TEST_JOB", "start"));
    // Loose bound: must have actually waited for the timer (not resolved
    // instantly), and must not have run away past a couple of timeouts.
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 2500, `expected to wait out the ~3s timer, only waited ${elapsed}ms`);
    assert.ok(elapsed < 9000, `expected one timeout's worth of wait, took ${elapsed}ms`);
});

// ── withCronHeartbeat (the wrapper) ─────────────────────────────────────────

function req(url = "https://probuild.test/api/cron/test-job"): Request {
    return new Request(url);
}

test("env unset: the wrapped handler runs normally and nothing is ever pinged", async () => {
    const handler = async () => NextResponse.json({ ok: true });
    const wrapped = withCronHeartbeat("TEST_JOB", handler);
    const response = await wrapped(req());
    assert.equal(response.status, 200);
    assert.equal(calls.length, 0);
});

test("a thrown handler error pings fail (sanitized) and rethrows the original error", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const boom = new TypeError("raw message that must never be sent");
    const handler = async () => { throw boom; };
    const wrapped = withCronHeartbeat("TEST_JOB", handler);

    await assert.rejects(() => wrapped(req()), (error: unknown) => error === boom);

    const startCall = calls.find(c => c.url.endsWith("/start"));
    const failCall = calls.find(c => c.url.endsWith("/fail"));
    assert.ok(startCall, "start should have fired");
    assert.ok(failCall, "fail should have fired");
    assert.equal(failCall!.init?.body, "TypeError");
});

test("a non-2xx response with no predicate pings fail with status-<code>, and returns the response unchanged", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ error: "nope" }, { status: 503 });
    const wrapped = withCronHeartbeat("TEST_JOB", handler);
    const response = await wrapped(req());

    assert.equal(response.status, 503);
    const failCall = calls.find(c => c.url.endsWith("/fail"));
    assert.ok(failCall);
    assert.equal(failCall!.init?.body, "status-503");
});

test("a 2xx response with isFailure returning true pings fail", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ ok: true, errors: ["one row failed"] });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, {
        isFailure: body => isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0,
    });
    const response = await wrapped(req());

    assert.equal(response.status, 200);
    const failCall = calls.find(c => c.url.endsWith("/fail"));
    const successCall = calls.find(c => c.url === "https://hc-ping.test/abc123");
    assert.ok(failCall, "fail should have fired");
    assert.equal(successCall, undefined, "success must not also fire");
});

test("a 2xx response with isFailure returning false, or undefined, or omitted, pings success", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ ok: true, skipped: "weekend" });
    for (const isFailure of [() => false, () => undefined, undefined] as const) {
        calls = [];
        const wrapped = withCronHeartbeat("TEST_JOB", handler, isFailure ? { isFailure } : {});
        await wrapped(req());
        assert.ok(calls.some(c => c.url === "https://hc-ping.test/abc123"), "success should have fired");
        assert.equal(calls.find(c => c.url.endsWith("/fail")), undefined);
    }
});

// ── round 3: isFailure/isSkip are scoped to their own status class ─────────

test("a 401 pings fail on a route that HAS an escalation predicate — isFailure must not be asked, and must not be able to clear it", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, {
        // A real route's escalation predicate: says nothing about `error`,
        // so under round 2's bug (isFailure consulted for every status) this
        // evaluated to `false` and CLEARED the 401 to success.
        isFailure: body => isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0,
    });
    const response = await wrapped(req());

    assert.equal(response.status, 401);
    assert.ok(calls.some(c => c.url.endsWith("/fail")), "401 must ping fail");
    assert.equal(calls.find(c => c.url === "https://hc-ping.test/abc123"), undefined, "must not also ping success");
});

test("a 503 with no recognized fields pings fail on a route with a predicate, when isSkip is absent", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({}, { status: 503 });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, {
        isFailure: body => isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0,
    });
    const response = await wrapped(req());

    assert.equal(response.status, 503);
    const failCall = calls.find(c => c.url.endsWith("/fail"));
    assert.ok(failCall);
    assert.equal(failCall!.init?.body, "status-503");
});

test("receipt-request-cards shape: a real 500 refusal (uncertainTransitions: []) still pings fail", async () => {
    // The exact round-3 regression case named in review: an EMPTY array is
    // still an array, so a naive `Array.isArray(x) && x.length > 0` guard
    // guessed right here by luck of the length check — but the underlying
    // bug (isFailure consulted for this 500 at all) meant any predicate that
    // didn't specifically account for the failure shape could clear it.
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ ok: false, uncertainTransitions: [], failedOwners: ["CJ"] }, { status: 500 });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, {
        isFailure: body => isRecord(body) && Array.isArray(body.uncertainTransitions) && body.uncertainTransitions.length > 0,
    });
    const response = await wrapped(req());

    assert.equal(response.status, 500);
    assert.ok(calls.some(c => c.url.endsWith("/fail")), "the 500 refusal must ping fail");
    assert.equal(calls.find(c => c.url === "https://hc-ping.test/abc123"), undefined);
});

test("isSkip clears an intentional non-2xx skip to success (qbo-expenses sync-disabled shape), without touching the status code", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ ok: false, reason: "sync-disabled" }, { status: 503 });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, {
        isSkip: body => isRecord(body) && body.reason === "sync-disabled",
        isFailure: body => isRecord(body) && body.ok === false,
    });
    const response = await wrapped(req());

    assert.equal(response.status, 503, "the route's own status code must not change");
    assert.ok(calls.some(c => c.url === "https://hc-ping.test/abc123"), "success should have fired");
    assert.equal(calls.find(c => c.url.endsWith("/fail")), undefined, "fail must not fire for an intentional skip");
});

test("isSkip is never consulted for a 2xx, so it cannot accidentally clear a real isFailure escalation", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ ok: true, reason: "sync-disabled", errors: ["boom"] });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, {
        isSkip: () => true, // would wrongly clear everything if it were ever asked about a 2xx
        isFailure: body => isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0,
    });
    await wrapped(req());
    assert.ok(calls.some(c => c.url.endsWith("/fail")), "isFailure must still win on a 2xx");
});

test("isFailure is never consulted for a non-2xx, so it cannot accidentally clear a real failure", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ ok: false }, { status: 500 });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, {
        isFailure: () => false, // would wrongly clear a real 500 if it were ever asked
    });
    const response = await wrapped(req());
    assert.equal(response.status, 500);
    assert.ok(calls.some(c => c.url.endsWith("/fail")), "the 500 must still ping fail");
});

// ── round 3: /start is ordered before the terminal ping ─────────────────────

test("a slow /start still completes before the terminal ping is sent, even when the handler returns immediately", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const order: string[] = [];
    // /start takes ~200ms to resolve; the terminal ping's mock resolves
    // instantly. Under round 2's fire-and-forget /start, the fast handler
    // below would let the terminal ping's fetch fire (and could even
    // complete) before /start's request ever reached the mock's push.
    fetchImpl = async url => {
        if (url.endsWith("/start")) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        order.push(url);
        return new Response(null, { status: 200 });
    };
    const handler = async () => NextResponse.json({ ok: true }); // returns with no delay of its own

    const wrapped = withCronHeartbeat("TEST_JOB", handler);
    const startedAt = Date.now();
    await wrapped(req());
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(order, ["https://hc-ping.test/abc123/start", "https://hc-ping.test/abc123"],
        "the terminal ping must be sent only after /start's own request has completed");
    assert.ok(elapsed >= 190, `expected the wrapper to wait out /start's ~200ms delay, only took ${elapsed}ms`);
});

test("an unparseable body defers to the default status-based rule", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, {
        isFailure: () => { throw new Error("should never be reached with an unparseable body"); },
    });
    await wrapped(req());
    assert.ok(calls.some(c => c.url === "https://hc-ping.test/abc123"), "200 + unparseable body still defers to success");
});

test("the caller's response body is still fully readable after the wrapper runs", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const payload = { checked: 3, results: ["a", "b", "c"] };
    const handler = async () => NextResponse.json(payload);
    const wrapped = withCronHeartbeat("TEST_JOB", handler);
    const response = await wrapped(req());
    const body = await response.json();
    assert.deepEqual(body, payload);
});

test("a failing ping never changes the handler's response", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    fetchImpl = async () => { throw new Error("heartbeat provider is down"); };
    const handler = async () => NextResponse.json({ checked: 1 }, { status: 200 });
    const wrapped = withCronHeartbeat("TEST_JOB", handler);
    const response = await wrapped(req());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { checked: 1 });
});
