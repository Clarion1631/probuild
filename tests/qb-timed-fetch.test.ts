/**
 * qbTimedFetch — the per-request deadline on every QuickBooks HTTP call.
 *
 * The defect it fixes: bare fetch() has no timeout, so the 2026-09-01 Intuit
 * outage hung each QB call until Vercel killed the whole function at its
 * maxDuration. Routes learned nothing and burned the entire budget.
 *
 * Tested against a real local http server rather than a stubbed fetch —
 * `mock.module` corrupts the require chain on Node 20, which is what CI pins.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { qbTimedFetch, QBTimeoutError, isQBTimeoutError, parseJsonOrNull } from "../src/lib/quickbooks";

let server: Server;
let base: string;
/** Sockets the stalling routes are holding open, closed in `after` so the suite exits. */
const held: Array<() => void> = [];

before(async () => {
    server = createServer((req, res) => {
        if (req.url?.startsWith("/v3/company/hang")) {
            // Never respond — the client's own deadline is the only thing that
            // can end this request. That is exactly the outage shape.
            held.push(() => res.destroy());
            return;
        }
        if (req.url?.startsWith("/v3/company/stall-body")) {
            // Headers land immediately, so `fetch` RESOLVES and the wrapper's
            // header-phase try/catch is already behind us — then the body
            // never finishes. This is the case that used to escape as a raw
            // AbortError out of res.json().
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write('{"partial":');
            held.push(() => res.destroy());
            return;
        }
        if (req.url?.startsWith("/v3/company/garbage")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("not json at all");
            return;
        }
        if (req.url?.startsWith("/v3/company/reset-body")) {
            // Headers, a partial body, then the socket dies — a transport
            // failure that happens AFTER fetch() has already resolved.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write('{"partial":');
            setTimeout(() => res.destroy(), 30);
            return;
        }
        if (req.url?.startsWith("/v3/company/errstall")) {
            // A non-2xx whose ERROR body never finishes arriving.
            res.writeHead(500, { "Content-Type": "application/json" });
            res.write('{"Fault":');
            held.push(() => res.destroy());
            return;
        }
        if (req.url?.startsWith("/v3/company/errreset")) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.write('{"Fault":');
            setTimeout(() => res.destroy(), 30);
            return;
        }
        if (req.url?.startsWith("/v3/company/plain-400")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"invalid_grant"}');
            return;
        }
        if (req.url?.startsWith("/v3/company/slow")) {
            // Each call costs real time, so a sequence of them accumulates.
            setTimeout(() => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            }, 400);
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    for (const destroy of held) destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
});

test("times out into QBTimeoutError when the server never responds", async () => {
    const error = await qbTimedFetch(`${base}/v3/company/hang?realmId=secret`, {}, 100).then(
        () => null,
        (e: unknown) => e,
    );
    assert.ok(error instanceof QBTimeoutError, `expected QBTimeoutError, got ${String(error)}`);
    assert.equal((error as Error).name, "QBTimeoutError");
});

test("timeout message carries the path but never the query string", async () => {
    const error = await qbTimedFetch(`${base}/v3/company/hang?query=select%20*&token=shhh`, {}, 1_000)
        .then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof QBTimeoutError);
    assert.match(error.message, /\/v3\/company\/hang/);
    assert.doesNotMatch(error.message, /shhh/);
    assert.doesNotMatch(error.message, /select/);
    assert.match(error.message, /1000ms/);
});

test("a successful response passes through untouched", async () => {
    const res = await qbTimedFetch(`${base}/v3/company/query`, {}, 5_000);
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, path: "/v3/company/query" });
});

test("request init (method, headers, body) is forwarded", async () => {
    const res = await qbTimedFetch(
        `${base}/v3/company/purchase`,
        { method: "POST", headers: { "X-Probe": "1" }, body: JSON.stringify({ a: 1 }) },
        5_000,
    );
    assert.equal(res.status, 200);
});

test("a non-timeout network error passes through unchanged", async () => {
    // Port 1 on loopback refuses immediately — a connection error, not a
    // deadline, so it must NOT be relabelled as a QBO outage.
    const error = await qbTimedFetch("http://127.0.0.1:1/v3/company/query", {}, 5_000).then(
        () => null,
        (e: unknown) => e as Error,
    );
    assert.ok(error instanceof Error);
    assert.equal(error instanceof QBTimeoutError, false);
});

test("a caller's own abort is not reported as a QBO timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const error = await qbTimedFetch(`${base}/v3/company/hang`, { signal: controller.signal }, 10_000)
        .then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof Error);
    assert.equal(error instanceof QBTimeoutError, false);
});

// ─── Body-phase deadline ────────────────────────────────────────────────────

test("a deadline that fires while READING THE BODY still becomes QBTimeoutError", async () => {
    // Regression: fetch resolves on headers, so this rejection happens after
    // the wrapper's header try/catch. It used to surface as a raw AbortError,
    // which the receipt route classified as a generic 500 instead of a 503
    // qbo-timeout.
    const res = await qbTimedFetch(`${base}/v3/company/stall-body?token=shhh`, {}, 150);
    assert.equal(res.ok, true);
    const error = await res.json().then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof QBTimeoutError, `expected QBTimeoutError, got ${String(error)}`);
    assert.match(error.message, /\/v3\/company\/stall-body/);
    assert.doesNotMatch(error.message, /shhh/);
});

test("text() and arrayBuffer() get the same body-phase translation", async () => {
    for (const method of ["text", "arrayBuffer"] as const) {
        const res = await qbTimedFetch(`${base}/v3/company/stall-body`, {}, 150);
        const error = await (res[method]() as Promise<unknown>).then(() => null, (e: unknown) => e as Error);
        assert.ok(error instanceof QBTimeoutError, `${method}: got ${String(error)}`);
    }
});

test("the proxied Response still exposes real status, headers, and clone()", async () => {
    const res = await qbTimedFetch(`${base}/v3/company/query`, {}, 5_000);
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(res.headers.get("content-type"), "application/json");
    // clone() must not throw on the proxy receiver.
    const copy = res.clone();
    assert.deepEqual(await copy.json(), { ok: true, path: "/v3/company/query" });
});

test("a caller's own abort DURING the body read stays a plain error", async () => {
    const controller = new AbortController();
    const res = await qbTimedFetch(
        `${base}/v3/company/stall-body`,
        { signal: controller.signal },
        10_000,
    );
    setTimeout(() => controller.abort(), 50);
    const error = await res.json().then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof Error);
    assert.equal(error instanceof QBTimeoutError, false);
});

test("a clone() of a QBO response is wrapped too", async () => {
    const res = await qbTimedFetch(`${base}/v3/company/stall-body`, {}, 150);
    const copy = res.clone();
    const error = await copy.json().then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof QBTimeoutError, `expected QBTimeoutError, got ${String(error)}`);
});

// ─── Signal combining ───────────────────────────────────────────────────────

test("the deadline wins the race even if the caller aborts a moment later", async () => {
    // The race Codex flagged: our deadline fires first, the caller aborts
    // before the rejection is observed, and BOTH signals then read aborted.
    // Attribution must come from who got there FIRST (latched in the handler),
    // not from inspecting `callerSignal.aborted` afterwards — otherwise a real
    // outage is misreported as a caller cancellation and the receipt route
    // answers 500 instead of 503.
    const controller = new AbortController();
    const pending = qbTimedFetch(`${base}/v3/company/hang`, { signal: controller.signal }, 1_000).then(
        () => null,
        (e: unknown) => e as Error,
    );
    // A sibling deadline on the same schedule: its handler aborts the caller
    // SYNCHRONOUSLY the moment the real deadline has fired. Registered after
    // the call, so the wrapper's own timeout signal is created — and fires —
    // first. Both signals end up aborted; only the latched winner disambiguates.
    // (1s, not 60ms: deadlines are clamped to a 1s floor.)
    AbortSignal.timeout(1_000).addEventListener("abort", () => controller.abort(), { once: true });

    const error = await pending;
    // Let the sibling handler land regardless of timer/microtask interleaving,
    // then assert the caller really did abort too — that is what makes this a
    // race rather than a plain timeout.
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(controller.signal.aborted, true, "the caller signal must also be aborted by now");
    assert.ok(error instanceof QBTimeoutError, `expected QBTimeoutError, got ${String(error)}`);
});

test("the caller still wins when it aborts first, even though the deadline follows", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const error = await qbTimedFetch(
        `${base}/v3/company/hang`,
        { signal: controller.signal },
        80,
    ).then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof Error);
    assert.equal(error instanceof QBTimeoutError, false);
});

test("without AbortSignal.any, a caller signal does NOT silently disable the deadline", async () => {
    const original = (AbortSignal as unknown as Record<string, unknown>).any;
    delete (AbortSignal as unknown as Record<string, unknown>).any;
    try {
        // A caller signal that never fires: the only thing that can end this
        // request is our deadline. The old fallback dropped it entirely.
        const neverAborts = new AbortController();
        const error = await qbTimedFetch(
            `${base}/v3/company/hang`,
            { signal: neverAborts.signal },
            120,
        ).then(() => null, (e: unknown) => e as Error);
        assert.ok(error instanceof QBTimeoutError, `expected QBTimeoutError, got ${String(error)}`);
    } finally {
        (AbortSignal as unknown as Record<string, unknown>).any = original;
    }
});

test("without AbortSignal.any, a caller's abort still cancels the request", async () => {
    const original = (AbortSignal as unknown as Record<string, unknown>).any;
    delete (AbortSignal as unknown as Record<string, unknown>).any;
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 50);
        const error = await qbTimedFetch(
            `${base}/v3/company/hang`,
            { signal: controller.signal },
            10_000,
        ).then(() => null, (e: unknown) => e as Error);
        assert.ok(error instanceof Error);
        assert.equal(error instanceof QBTimeoutError, false);
    } finally {
        (AbortSignal as unknown as Record<string, unknown>).any = original;
    }
});

test("an already-aborted caller signal is honoured immediately without AbortSignal.any", async () => {
    const original = (AbortSignal as unknown as Record<string, unknown>).any;
    delete (AbortSignal as unknown as Record<string, unknown>).any;
    try {
        const error = await qbTimedFetch(
            `${base}/v3/company/hang`,
            { signal: AbortSignal.abort() },
            10_000,
        ).then(() => null, (e: unknown) => e as Error);
        assert.ok(error instanceof Error);
        assert.equal(error instanceof QBTimeoutError, false);
    } finally {
        (AbortSignal as unknown as Record<string, unknown>).any = original;
    }
});

test("QB_FETCH_TIMEOUT_MS drives the default deadline", async () => {
    const previous = process.env.QB_FETCH_TIMEOUT_MS;
    process.env.QB_FETCH_TIMEOUT_MS = "1200";
    try {
        const error = await qbTimedFetch(`${base}/v3/company/hang`).then(
            () => null,
            (e: unknown) => e as Error,
        );
        assert.ok(error instanceof QBTimeoutError);
        assert.match(error.message, /1200ms/);
    } finally {
        if (previous === undefined) delete process.env.QB_FETCH_TIMEOUT_MS;
        else process.env.QB_FETCH_TIMEOUT_MS = previous;
    }
});

test("a garbage QB_FETCH_TIMEOUT_MS falls back to the 20s default rather than throwing", async () => {
    const previous = process.env.QB_FETCH_TIMEOUT_MS;
    process.env.QB_FETCH_TIMEOUT_MS = "not-a-number";
    try {
        const res = await qbTimedFetch(`${base}/v3/company/query`);
        assert.equal(res.status, 200);
    } finally {
        if (previous === undefined) delete process.env.QB_FETCH_TIMEOUT_MS;
        else process.env.QB_FETCH_TIMEOUT_MS = previous;
    }
});

test("a bad timeout value never reaches AbortSignal.timeout", async () => {
    // A fraction would be coerced and a 0/negative value rejected outright,
    // which would break EVERY QB call rather than one misconfigured setting.
    for (const value of [0.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const res = await qbTimedFetch(`${base}/v3/company/query`, {}, value);
        assert.equal(res.status, 200, `timeout ${value} should fall back to the default`);
    }
    // A valid fraction floors instead of falling back: 1500.9 -> 1500.
    const error = await qbTimedFetch(`${base}/v3/company/hang`, {}, 1500.9).then(
        () => null,
        (e: unknown) => e as Error,
    );
    assert.ok(error instanceof QBTimeoutError);
    assert.match(error.message, /1500ms/);
});

test("a huge but FINITE timeout is clamped instead of throwing", async () => {
    // Codex gate: AbortSignal.timeout takes an unsigned long long, so a value
    // past that bound threw synchronously — one mistyped env var would have
    // broken every QuickBooks call in the app. 2**32 is finite, so the
    // Number.isFinite guard above did not catch it.
    for (const value of [4294967296, 2 ** 53, 60_000]) {
        // A responsive endpoint: the clamped deadline never fires, so what this
        // asserts is that the call was MADE at all rather than throwing
        // synchronously out of AbortSignal.timeout.
        const res = await qbTimedFetch(`${base}/v3/company/query`, {}, value);
        assert.equal(res.status, 200, `timeout ${value} must not throw`);
    }
});

test("a sub-second timeout is raised to the 1s floor", async () => {
    const started = Date.now();
    const error = await qbTimedFetch(`${base}/v3/company/hang`, {}, 5).then(
        () => null,
        (e: unknown) => e as Error,
    );
    assert.ok(error instanceof QBTimeoutError);
    assert.match(error.message, /1000ms/);
    // A 5ms deadline would make QuickBooks permanently "down" — the floor is
    // what stops a misconfiguration becoming a self-inflicted outage.
    assert.ok(Date.now() - started >= 900, "must actually wait the floor");
});


// ─── parseJsonOrNull ────────────────────────────────────────────────────────

test("parseJsonOrNull returns the parsed body on success", async () => {
    const res = await qbTimedFetch(`${base}/v3/company/query`, {}, 5_000);
    assert.deepEqual(await parseJsonOrNull(res), { ok: true, path: "/v3/company/query" });
});

test("parseJsonOrNull swallows a genuine parse error", async () => {
    const res = await qbTimedFetch(`${base}/v3/company/garbage`, {}, 5_000);
    assert.equal(await parseJsonOrNull(res), null);
});

test("parseJsonOrNull RETHROWS a body-read timeout instead of reporting an empty body", async () => {
    // The trap this replaces: `.json().catch(() => null)` turned an outage into
    // "QBO returned no body", which callers reported as a generic failure — and
    // on the attachment path could even read as a successful upload.
    const res = await qbTimedFetch(`${base}/v3/company/stall-body`, {}, 150);
    const error = await parseJsonOrNull(res).then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof QBTimeoutError, `expected QBTimeoutError, got ${String(error)}`);
});


// ─── Cross-module identity ──────────────────────────────────────────────────

test("isQBTimeoutError recognises a timeout from a DUPLICATE copy of this module", () => {
    // CI (Node 20) proved this: a CJS/ESM interop split loaded quickbooks.ts
    // twice, so `instanceof` was false across the boundary and every timeout
    // branch quietly took the non-timeout path. Bundler chunk duplication does
    // the same thing in production. Match the name too.
    class ForeignQBTimeoutError extends Error {
        name = "QBTimeoutError";
    }
    assert.equal(isQBTimeoutError(new ForeignQBTimeoutError("from another copy")), true);
    assert.equal(isQBTimeoutError(new QBTimeoutError("native")), true);
});

test("isQBTimeoutError does not over-match", () => {
    assert.equal(isQBTimeoutError(new Error("AbortError")), false);
    assert.equal(isQBTimeoutError(Object.assign(new Error("x"), { name: "AbortError" })), false);
    assert.equal(isQBTimeoutError(null), false);
    assert.equal(isQBTimeoutError("QBTimeoutError"), false);
    assert.equal(isQBTimeoutError({ name: "QBTimeoutError" }), false);
});


// --- Parse failure vs transport failure, after headers ---

test("a malformed JSON body is a PARSE failure, not a connection failure", async () => {
    const { isQboMalformedResponseError, isRetryableQboError } = await import("../src/lib/quickbooks");
    const res = await qbTimedFetch(`${base}/v3/company/garbage`, {}, 5_000);
    const error = await res.json().then(() => null, (e: unknown) => e as Error);

    // Garbage JSON is a property of THIS response - it looks the same on every
    // retry and says nothing about the connection. Collapsing it into a
    // transport failure made one bad payload abort a whole run as an outage.
    assert.equal(isQboMalformedResponseError(error), true, `got ${error?.name}`);
    assert.equal(isRetryableQboError(error), false);
    // parseJsonOrNull still degrades a genuine parse failure to null.
    const res2 = await qbTimedFetch(`${base}/v3/company/garbage`, {}, 5_000);
    assert.equal(await parseJsonOrNull(res2), null);
});

test("headers-then-RESET is connection-level and reaches the caller", async () => {
    const { isRetryableQboError } = await import("../src/lib/quickbooks");
    // Headers arrive, then the socket dies mid-body: the connection really is
    // gone, so this must abort a loop exactly like a timeout does - and must
    // NOT be swallowed into "QBO returned no body".
    const res = await qbTimedFetch(`${base}/v3/company/reset-body`, {}, 5_000);
    assert.equal(res.ok, true);

    const error = await res.json().then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof Error, "a dead socket must not resolve");
    assert.equal(isRetryableQboError(error), true, `got ${error?.name}`);

    const res2 = await qbTimedFetch(`${base}/v3/company/reset-body`, {}, 5_000);
    await assert.rejects(
        () => parseJsonOrNull(res2),
        (e: unknown) => isRetryableQboError(e),
    );
});

// --- Route-wide budget ---

test("each call is capped by what is LEFT of the route budget", async () => {
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    // 1.4s of budget, but a 20s per-call timeout: the call must give up on the
    // budget, not the per-call deadline.
    const deadline = createRouteDeadline(1_400);
    const started = Date.now();
    const error = await qbTimedFetch(`${base}/v3/company/hang`, { qbDeadline: deadline }, 20_000).then(
        () => null,
        (e: unknown) => e as Error,
    );
    const elapsed = Date.now() - started;
    assert.ok(error instanceof QBTimeoutError, `got ${String(error)}`);
    assert.ok(elapsed < 5_000, `should stop near the budget, took ${elapsed}ms`);
});

test("a call is refused outright once the budget is gone", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");
    // Budget started 10s ago with only 2s allowed: nothing left.
    const deadline = createRouteDeadline(2_000, Date.now() - 10_000);
    const error = await qbTimedFetch(`${base}/v3/company/query`, { qbDeadline: deadline }, 20_000).then(
        () => null,
        (e: unknown) => e as Error,
    );
    assert.equal(isQBBudgetExhaustedError(error), true, `got ${String(error)}`);
});

test("CUMULATIVE latency: serial calls stop before the route ceiling", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");
    // The original failure mode: six individually-legal calls adding up past
    // the function's ceiling. With a shared budget the sequence stops itself.
    const CEILING_MS = 3_000;
    const deadline = createRouteDeadline(2_000);
    const started = Date.now();

    let calls = 0;
    let stopped: unknown = null;
    for (let i = 0; i < 20; i++) {
        try {
            calls++;
            await qbTimedFetch(`${base}/v3/company/slow`, { qbDeadline: deadline }, 20_000);
        } catch (error) {
            stopped = error;
            break;
        }
    }

    const elapsed = Date.now() - started;
    assert.ok(stopped, "the sequence must stop itself");
    assert.ok(
        isQBBudgetExhaustedError(stopped) || stopped instanceof QBTimeoutError,
        `stopped for the wrong reason: ${String(stopped)}`,
    );
    assert.ok(elapsed < CEILING_MS, `ran ${elapsed}ms, past the ${CEILING_MS}ms ceiling`);
    assert.ok(calls > 1, "should have made several calls before stopping");
});


// --- Reading the ERROR body is a body read too ---

test("a stalled error body surfaces the timeout, not a tidy empty message", async () => {
    const { qboResponseError, isQBTimeoutError } = await import("../src/lib/quickbooks");
    // Codex gate: `.catch(() => "")` around res.text() swallowed a timeout or a
    // dead socket while reading the ERROR body, turning an outage into
    // "failed (400): " — status preserved, real failure lost.
    const res = await qbTimedFetch(`${base}/v3/company/errstall`, {}, 150);
    assert.equal(res.ok, false);

    const outcome = await qboResponseError(res, "QB query").then(
        (e) => ({ returned: e }),
        (thrown: unknown) => ({ thrown }),
    );
    assert.ok("thrown" in outcome, `expected a throw, got ${String((outcome as { returned?: Error }).returned)}`);
    assert.equal(isQBTimeoutError((outcome as { thrown: unknown }).thrown), true);
});

test("a reset error body is connection-level, not an empty message", async () => {
    const { qboResponseError, isRetryableQboError } = await import("../src/lib/quickbooks");
    const res = await qbTimedFetch(`${base}/v3/company/errreset`, {}, 5_000);
    const outcome = await qboResponseError(res, "QB query").then(
        (e) => ({ returned: e }),
        (thrown: unknown) => ({ thrown }),
    );
    assert.ok("thrown" in outcome, "a dead socket must not resolve to an empty body");
    assert.equal(isRetryableQboError((outcome as { thrown: unknown }).thrown), true);
});

test("an ordinary error body is still read into the message", async () => {
    const { qboResponseError, qboHttpStatus } = await import("../src/lib/quickbooks");
    const res = await qbTimedFetch(`${base}/v3/company/plain-400`, {}, 5_000);
    const error = await qboResponseError(res, "QB query");
    assert.equal(qboHttpStatus(error), 400);
    assert.match(error.message, /invalid_grant/);
});


// --- The milestone invoice create is idempotent ---

test("createQBMilestoneInvoice sends a stable requestid so a retry cannot double-bill", async () => {
    const { createQBMilestoneInvoice, qboRequestId } = await import("../src/lib/quickbooks");
    const TOKENS = { accessToken: "a", refreshToken: "r", realmId: "test-realm" };
    // Codex gate: without a requestid, an ambiguous timeout (the request landed,
    // the response did not) left the caller to retry and create a SECOND
    // invoice for the same milestone - a duplicate bill to a client.
    const urls: string[] = [];
    const impl = (async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ Invoice: { Id: "inv-1", TotalAmt: 500, CustomerRef: { value: "c1" } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;

    const args = {
        docNumber: "INV-00123-DEP",
        idempotencyKey: "sched-abc123",
        customerId: "c1",
        itemId: "i1",
        description: "Deposit",
        amount: 500,
        dueDate: null,
        billEmail: null,
        privateNote: "note",
    };

    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
        await createQBMilestoneInvoice(TOKENS, args);
        await createQBMilestoneInvoice(TOKENS, args); // the retry
    } finally {
        globalThis.fetch = original;
    }

    const expected = qboRequestId(`milestone-invoice:${args.idempotencyKey}`);
    assert.equal(urls.length, 2);
    for (const url of urls) {
        assert.match(url, /requestid=/, `no requestid on ${url}`);
        assert.ok(url.includes(expected), "the SAME key both times, so Intuit returns the original");
    }
    // Keyed on the IMMUTABLE schedule id: renaming the milestone (which
    // changes DocNumber) must not mint a new key and create a second invoice.
    assert.equal(qboRequestId(`milestone-invoice:${args.idempotencyKey}`), expected);
    assert.notEqual(qboRequestId("milestone-invoice:sched-different"), expected);
});



// --- An invoice create must actually return an invoice ---

test("a 200 with no usable Invoice is ambiguous and retryable, never a silent link", async () => {
    const { createQBMilestoneInvoice, isRetryableQboError } = await import("../src/lib/quickbooks");
    const TOKENS = { accessToken: "a", refreshToken: "r", realmId: "test-realm" };
    const args = {
        docNumber: "INV-1", idempotencyKey: "sched-1", customerId: "c1", itemId: "i1",
        description: "d", amount: 100, dueDate: null, billEmail: null, privateNote: "n",
    };

    // Codex gate: an empty id and a NaN-coerced 0 total let the caller link a
    // milestone to nothing, or "verify" the amount against a fabricated zero.
    for (const body of [{}, { Invoice: {} }, { Invoice: { Id: "" } }, { Invoice: { Id: "1" } }, { Invoice: { Id: "1", TotalAmt: "abc" } }]) {
        const original = globalThis.fetch;
        globalThis.fetch = (async () => new Response(JSON.stringify(body), {
            status: 200, headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
        try {
            const error = await createQBMilestoneInvoice(TOKENS, args).then(() => null, (e: unknown) => e as Error);
            assert.ok(error, `${JSON.stringify(body)} should not resolve`);
            assert.equal(isRetryableQboError(error), true, `${JSON.stringify(body)} -> ${error?.name}`);
        } finally {
            globalThis.fetch = original;
        }
    }
});

test("a well-formed invoice returns what QBO actually holds, for reconciliation", async () => {
    const { createQBMilestoneInvoice } = await import("../src/lib/quickbooks");
    const TOKENS = { accessToken: "a", refreshToken: "r", realmId: "test-realm" };
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
        Invoice: { Id: "42", TotalAmt: 1500.5, CustomerRef: { value: "cust-9" }, DueDate: "2026-10-01", DocNumber: "INV-9" },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    try {
        const created = await createQBMilestoneInvoice(TOKENS, {
            docNumber: "INV-9", idempotencyKey: "sched-9", customerId: "cust-9", itemId: "i1",
            description: "d", amount: 1500.5, dueDate: null, billEmail: null, privateNote: "n",
        });
        // The caller compares these against the milestone before linking.
        assert.equal(created.qbId, "42");
        assert.equal(created.total, 1500.5);
        assert.equal(created.customerId, "cust-9");
        assert.equal(created.dueDate, "2026-10-01");
    } finally {
        globalThis.fetch = original;
    }
});
