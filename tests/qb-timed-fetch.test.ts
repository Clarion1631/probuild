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
import { qbTimedFetch, QBTimeoutError, parseJsonOrNull } from "../src/lib/quickbooks";

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
    const error = await qbTimedFetch(`${base}/v3/company/hang?query=select%20*&token=shhh`, {}, 100)
        .then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof QBTimeoutError);
    assert.match(error.message, /\/v3\/company\/hang/);
    assert.doesNotMatch(error.message, /shhh/);
    assert.doesNotMatch(error.message, /select/);
    assert.match(error.message, /100ms/);
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
    const pending = qbTimedFetch(`${base}/v3/company/hang`, { signal: controller.signal }, 60).then(
        () => null,
        (e: unknown) => e as Error,
    );
    // A sibling deadline on the same schedule: its handler aborts the caller
    // SYNCHRONOUSLY the moment the real deadline has fired. Registered after
    // the call, so the wrapper's own timeout signal is created — and fires —
    // first. Both signals end up aborted; only the latched winner disambiguates.
    AbortSignal.timeout(60).addEventListener("abort", () => controller.abort(), { once: true });

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
    process.env.QB_FETCH_TIMEOUT_MS = "120";
    try {
        const error = await qbTimedFetch(`${base}/v3/company/hang`).then(
            () => null,
            (e: unknown) => e as Error,
        );
        assert.ok(error instanceof QBTimeoutError);
        assert.match(error.message, /120ms/);
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

test("fractional and sub-1ms timeouts never reach AbortSignal.timeout", async () => {
    // A fraction would be coerced and a 0/negative value rejected outright,
    // which would break EVERY QB call rather than one misconfigured setting.
    for (const value of [0.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const res = await qbTimedFetch(`${base}/v3/company/query`, {}, value);
        assert.equal(res.status, 200, `timeout ${value} should fall back to the default`);
    }
    // A valid fraction floors instead of falling back: 150.9 -> 150.
    const error = await qbTimedFetch(`${base}/v3/company/hang`, {}, 150.9).then(
        () => null,
        (e: unknown) => e as Error,
    );
    assert.ok(error instanceof QBTimeoutError);
    assert.match(error.message, /150ms/);
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
