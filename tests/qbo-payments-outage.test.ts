/**
 * The payments cron must not keep dialling a dead QuickBooks.
 *
 * Codex gate: probeQBInvoice folded every failure into {state:"error"} and both
 * loops just `continue`d across up to 200 rows. During the 2026-09-01 outage
 * that meant six 20s timeouts in a row — the cron's entire 120s ceiling — and
 * the function was killed before it could report anything.
 *
 * probeQBInvoice now marks connection-level failures, which is what lets the
 * loops stop. These tests pin that classification (the loops themselves need a
 * database, so the multi-row behaviour is covered by simulating the same
 * decision the loop makes).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { probeQBInvoice, QBTimeoutError, type QBInvoiceProbe } from "../src/lib/quickbooks";

const TOKENS = { accessToken: "a", refreshToken: "r", realmId: "realm-1" };

/** Swap global fetch for one call; qbFetch goes through it. */
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
        return await run();
    } finally {
        globalThis.fetch = original;
    }
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a timeout is classified as a connection failure, not a per-invoice error", async () => {
    const probe = await withFetch(
        async () => {
            throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/invoice/1");
        },
        () => probeQBInvoice(TOKENS, "1"),
    );
    assert.equal(probe.state, "error");
    assert.equal(probe.state === "error" && probe.connectionFailed, true);
    assert.equal(probe.state === "error" && probe.timedOut, true);
});

test("a thrown network error is a connection failure too", async () => {
    const probe = await withFetch(
        async () => {
            throw new TypeError("fetch failed");
        },
        () => probeQBInvoice(TOKENS, "1"),
    );
    assert.equal(probe.state === "error" && probe.connectionFailed, true);
    assert.equal(probe.state === "error" && probe.timedOut, false);
});

test("429 and 5xx are connection failures; an ordinary 401 is not", async () => {
    for (const status of [429, 500, 503]) {
        const probe = await withFetch(async () => json(status, { Fault: {} }), () => probeQBInvoice(TOKENS, "1"));
        assert.equal(probe.state === "error" && probe.connectionFailed, true, `status ${status}`);
    }
    const unauthorized = await withFetch(async () => json(401, { Fault: {} }), () => probeQBInvoice(TOKENS, "1"));
    assert.equal(unauthorized.state, "error");
    assert.equal(unauthorized.state === "error" && unauthorized.connectionFailed, undefined);
});

test("a healthy invoice is unaffected by the new classification", async () => {
    const probe = await withFetch(
        async () => json(200, { Invoice: { TotalAmt: 100, Balance: 0, LinkedTxn: [{ TxnType: "Payment", TxnId: "7" }] } }),
        () => probeQBInvoice(TOKENS, "1"),
    );
    assert.deepEqual(probe, { state: "ok", balance: 0, total: 100, paymentTxnIds: ["7"] });
});

test("a voided invoice is still authoritative, not a connection failure", async () => {
    const probe = await withFetch(
        async () => json(200, { Invoice: { TotalAmt: 0, Balance: 0, LinkedTxn: [] } }),
        () => probeQBInvoice(TOKENS, "1"),
    );
    assert.deepEqual(probe, { state: "voided" });
});

// ─── The loop rule the classification exists to drive ───────────────────────

/**
 * Mirrors the guard in syncQuickBooksPayments: stop on the first
 * connection-level failure, count the rest as skipped. The real loops need a
 * database; this pins the DECISION they make, over many rows.
 */
function runLoop(probes: QBInvoiceProbe[]): { checked: number; skipped: number; aborted: boolean } {
    let checked = 0;
    let skipped = 0;
    let aborted = false;
    for (const [index, probe] of probes.entries()) {
        checked++;
        if (probe.state === "error") {
            if (probe.connectionFailed) {
                aborted = true;
                skipped += probes.length - index - 1;
                break;
            }
            continue;
        }
    }
    return { checked, skipped, aborted };
}

test("200 pending rows during an outage cost ONE probe, not 200", () => {
    const outage: QBInvoiceProbe[] = Array.from({ length: 200 }, () => ({
        state: "error" as const,
        status: 0,
        connectionFailed: true,
        timedOut: true,
    }));
    const run = runLoop(outage);
    // One 20s deadline, not six-plus — the whole point.
    assert.equal(run.checked, 1);
    assert.equal(run.skipped, 199);
    assert.equal(run.aborted, true);
});

test("an ordinary per-invoice error does NOT stop the run", () => {
    const probes: QBInvoiceProbe[] = [
        { state: "error", status: 401 },
        { state: "error", status: 401 },
        { state: "ok", balance: 0, total: 10, paymentTxnIds: [] },
    ];
    const run = runLoop(probes);
    assert.equal(run.checked, 3);
    assert.equal(run.skipped, 0);
    assert.equal(run.aborted, false);
});

test("an outage partway through skips only the remainder", () => {
    const probes: QBInvoiceProbe[] = [
        { state: "ok", balance: 0, total: 10, paymentTxnIds: [] },
        { state: "ok", balance: 0, total: 10, paymentTxnIds: [] },
        { state: "error", status: 0, connectionFailed: true, timedOut: true },
        { state: "ok", balance: 0, total: 10, paymentTxnIds: [] },
        { state: "ok", balance: 0, total: 10, paymentTxnIds: [] },
    ];
    const run = runLoop(probes);
    assert.equal(run.checked, 3);
    assert.equal(run.skipped, 2);
    assert.equal(run.aborted, true);
});
