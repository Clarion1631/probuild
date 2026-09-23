/**
 * The external heartbeat ping (Healthchecks.io-style dead man's switch) money
 * crons call at start/success/fail. The property that matters most: it is
 * genuinely optional infrastructure. An unset `HC_PING_URL_<JOB_KEY>` must
 * make zero network calls, and a ping that fails — network error, timeout, or
 * a bad status — must never throw and must never change what the cron it
 * instruments returns.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pingCronHeartbeat } from "../src/lib/cron-heartbeat";

type FetchCall = { url: string; init: RequestInit | undefined };

const originalFetch = globalThis.fetch;

let calls: FetchCall[];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
    calls = [];
    fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 200 });
    };
    globalThis.fetch = ((url: string, init?: RequestInit) => fetchImpl(url, init)) as unknown as typeof fetch;
    delete process.env.HC_PING_URL_TEST_JOB;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.HC_PING_URL_TEST_JOB;
});

test("no env var set means no fetch at all", async () => {
    await pingCronHeartbeat("TEST_JOB", "start");
    await pingCronHeartbeat("TEST_JOB", "success");
    await pingCronHeartbeat("TEST_JOB", "fail", "boom");
    assert.equal(calls.length, 0);
});

test("an empty or blank env var is also a no-op", async () => {
    process.env.HC_PING_URL_TEST_JOB = "";
    await pingCronHeartbeat("TEST_JOB", "start");
    process.env.HC_PING_URL_TEST_JOB = "   ";
    await pingCronHeartbeat("TEST_JOB", "start");
    assert.equal(calls.length, 0);
});

test("start/success/fail hit the right URL suffixes", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";

    await pingCronHeartbeat("TEST_JOB", "start");
    await pingCronHeartbeat("TEST_JOB", "success");
    await pingCronHeartbeat("TEST_JOB", "fail", "reason-code");

    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, "https://hc-ping.test/abc123/start");
    assert.equal(calls[1].url, "https://hc-ping.test/abc123");
    assert.equal(calls[2].url, "https://hc-ping.test/abc123/fail");
});

test("only the fail ping carries a body, and it is truncated", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";

    await pingCronHeartbeat("TEST_JOB", "start");
    await pingCronHeartbeat("TEST_JOB", "success");
    assert.equal(calls[0].init?.body, undefined);
    assert.equal(calls[1].init?.body, undefined);

    await pingCronHeartbeat("TEST_JOB", "fail", "short reason");
    assert.equal(calls[2].init?.body, "short reason");

    await pingCronHeartbeat("TEST_JOB", "fail", "x".repeat(1000));
    assert.equal((calls[3].init?.body as string).length, 500);

    // A fail ping with no detail still fires, just without a body.
    await pingCronHeartbeat("TEST_JOB", "fail");
    assert.equal(calls[4].init?.body, undefined);
});

test("every ping is a POST carrying an abort signal", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    await pingCronHeartbeat("TEST_JOB", "start");
    assert.equal(calls[0].init?.method, "POST");
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
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

test("an abort (timeout) is swallowed, not thrown", async () => {
    process.env.HC_PING_URL_TEST_JOB = "https://hc-ping.test/abc123";
    // Simulates what a real 5s timeout produces (fetch rejecting with the
    // AbortController's reason) without this test waiting out the real clock.
    fetchImpl = async () => { throw new DOMException("Aborted", "AbortError"); };
    await assert.doesNotReject(() => pingCronHeartbeat("TEST_JOB", "start"));
});

test("job key maps to HC_PING_URL_<JOB_KEY> literally, no extra normalization", async () => {
    process.env.HC_PING_URL_BANK_REGISTER_PULL = "https://hc-ping.test/bank";
    try {
        await pingCronHeartbeat("BANK_REGISTER_PULL", "start");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://hc-ping.test/bank/start");
    } finally {
        delete process.env.HC_PING_URL_BANK_REGISTER_PULL;
    }
});

// --- Integration: a wired handler's response is untouched by the ping -------

test("the quickbooks-payments cron returns its normal 503 body even when its heartbeat ping fails", async () => {
    // Same fixture as tests/cron-auth.test.ts's "answers 503 when the run
    // itself failed": no real database, so src/lib/prisma.ts's lazy client
    // build is preempted by a fake on globalThis, and the sync takes its
    // not-connected preflight exit. This proves the heartbeat wiring added to
    // that route does not touch the response, not that the sync itself works.
    const previousEnv = process.env.NODE_ENV;
    const previousVercel = process.env.VERCEL_ENV;
    const previousSecret = process.env.CRON_SECRET;
    const previousPing = process.env.HC_PING_URL_QUICKBOOKS_PAYMENTS;
    const previousPrisma = (globalThis as Record<string, unknown>).prisma;
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.VERCEL_ENV;
    process.env.CRON_SECRET = "s3cret";
    process.env.HC_PING_URL_QUICKBOOKS_PAYMENTS = "https://hc-ping.test/qbo-payments";
    // The ping must fail loudly (network error) so this test actually proves
    // the response survives a broken heartbeat, not just an unused one.
    fetchImpl = async (url, init) => { calls.push({ url, init }); throw new Error("NETWORK DOWN"); };
    (globalThis as Record<string, unknown>).prisma = {
        paymentSchedule: { count: async () => 3 },
        progressBilling: { count: async () => 1 },
        integration: { findUnique: async () => null }, // -> QuickBooks not connected
        automationEvent: { create: async () => ({}) },
        automationSetting: { findUnique: async () => null, upsert: async () => ({}) },
    };
    try {
        const { GET } = await import("../src/app/api/cron/quickbooks-payments/route");
        const response = await GET(new Request("https://probuild.test/api/cron/quickbooks-payments", {
            headers: { authorization: "Bearer s3cret" },
        }));
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.runFailed, true);
        assert.equal(body.retry, true);
        assert.equal(body.failureReason, "quickbooks-not-connected");
        assert.equal(body.skipped, 4);
        // The ping fired (proving it's wired) and still failed to reach the
        // network, and neither changed the response above.
        assert.ok(calls.some(c => c.url.startsWith("https://hc-ping.test/qbo-payments")));
    } finally {
        if (previousEnv === undefined) delete (process.env as Record<string, string>).NODE_ENV;
        else (process.env as Record<string, string>).NODE_ENV = previousEnv;
        if (previousVercel === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = previousVercel;
        if (previousSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = previousSecret;
        if (previousPing === undefined) delete process.env.HC_PING_URL_QUICKBOOKS_PAYMENTS;
        else process.env.HC_PING_URL_QUICKBOOKS_PAYMENTS = previousPing;
        (globalThis as Record<string, unknown>).prisma = previousPrisma;
    }
});

test("the payment-reminders cron is unauthenticated-safe and never pings on a rejected request", async () => {
    // No CRON_SECRET means isCronAuthorized-style checks in this route reject
    // before the heartbeat helper is ever reached — an unauthenticated probe
    // must not be able to make a dead cron look alive.
    const previousVercel = process.env.VERCEL_ENV;
    const previousSecret = process.env.CRON_SECRET;
    const previousPing = process.env.HC_PING_URL_PAYMENT_REMINDERS;
    process.env.VERCEL_ENV = "production";
    delete process.env.CRON_SECRET;
    process.env.HC_PING_URL_PAYMENT_REMINDERS = "https://hc-ping.test/payment-reminders";
    try {
        const { GET } = await import("../src/app/api/cron/payment-reminders/route");
        const response = await GET(new Request("https://probuild.test/api/cron/payment-reminders"));
        assert.equal(response.status, 401);
        assert.equal(calls.length, 0);
    } finally {
        if (previousVercel === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = previousVercel;
        if (previousSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = previousSecret;
        if (previousPing === undefined) delete process.env.HC_PING_URL_PAYMENT_REMINDERS;
        else process.env.HC_PING_URL_PAYMENT_REMINDERS = previousPing;
    }
});
