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
import { qbTimedFetch, QBTimeoutError } from "../src/lib/quickbooks";

let server: Server;
let base: string;
/** Sockets the "hang" route is holding open, closed in `after` so the suite exits. */
const held: Array<() => void> = [];

before(async () => {
    server = createServer((req, res) => {
        if (req.url?.startsWith("/v3/company/hang")) {
            // Never respond — the client's own deadline is the only thing that
            // can end this request. That is exactly the outage shape.
            held.push(() => res.destroy());
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
