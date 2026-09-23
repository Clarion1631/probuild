/**
 * The external heartbeat ping (Healthchecks.io-style dead man's switch) money
 * crons call via `withCronHeartbeat`. Round 2 (Codex review of the first
 * pass, which called `pingCronHeartbeat` inline in each route): these tests
 * cover the findings that round fixed —
 *
 *   1. latency/lease: the wrapper must add no latency on the request path
 *      when a real request scope is available (proven indirectly: every test
 *      below observes the finish ping synchronously after awaiting the
 *      wrapped handler, which only holds if the no-request-scope fallback —
 *      the one this test file actually exercises, since it calls wrapped
 *      handlers directly rather than through a real Next.js request — awaits
 *      the ping rather than firing it detached).
 *   2. misclassification: non-2xx is a failure by default; a 2xx with an
 *      `isFailure` predicate can be escalated; a non-2xx with the predicate
 *      returning `false` can be cleared (an intentional skip).
 *   3. a thrown handler error still pings fail (no gap before a route's own
 *      try/catch, because the wrapper's try/catch is OUTSIDE the handler).
 *   4. the timeout bounds a fetch call that never resolves at all, not just
 *      a slow one.
 *   5. detail sanitizing: only a short safe code (or "status-<code>") ever
 *      reaches the ping body; anything else becomes "error".
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

test("a 2xx response with isFailure returning false (or undefined) pings success", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ ok: true, skipped: "weekend" });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, { isFailure: () => undefined });
    await wrapped(req());
    assert.ok(calls.some(c => c.url === "https://hc-ping.test/abc123"), "success should have fired");
    assert.equal(calls.find(c => c.url.endsWith("/fail")), undefined);
});

test("isFailure returning false clears an intentional non-2xx skip to success (qbo-expenses sync-disabled shape)", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    const handler = async () => NextResponse.json({ ok: false, reason: "sync-disabled" }, { status: 503 });
    const wrapped = withCronHeartbeat("TEST_JOB", handler, {
        isFailure: body => isRecord(body) && body.reason === "sync-disabled" ? false : undefined,
    });
    const response = await wrapped(req());

    assert.equal(response.status, 503, "the route's own status code must not change");
    assert.ok(calls.some(c => c.url === "https://hc-ping.test/abc123"), "success should have fired");
    assert.equal(calls.find(c => c.url.endsWith("/fail")), undefined, "fail must not fire for an intentional skip");
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
