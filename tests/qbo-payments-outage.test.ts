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

test("429/5xx AND 401/403 are connection failures; a plain 400 is not", async () => {
    // Codex gate: 401 used to be an "ordinary" error the loop skipped past. But
    // the credential is the SAME for every remaining row, so the next 199 rows
    // fail identically at full cost — that is connection-level by definition.
    for (const status of [429, 500, 503, 401, 403]) {
        const probe = await withFetch(async () => json(status, { Fault: {} }), () => probeQBInvoice(TOKENS, "1"));
        assert.equal(probe.state === "error" && probe.connectionFailed, true, `status ${status}`);
    }
    const badRequest = await withFetch(async () => json(400, { Fault: {} }), () => probeQBInvoice(TOKENS, "1"));
    assert.equal(badRequest.state, "error");
    assert.equal(badRequest.state === "error" && badRequest.connectionFailed, undefined);
});

test("a raw fetch TypeError is normalized at the QBO boundary", async () => {
    // Codex gate: getQBPayment translated 429/5xx but let a bare
    // `TypeError: fetch failed` (DNS/TLS/reset) escape unclassified, so the
    // loop did not recognise it as connection-level and kept dialling.
    const { getQBPayment, isQboConnectionFailure } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        (async () => {
            throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
        () => getQBPayment(TOKENS, "p1"),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error instanceof Error, "a network failure must not resolve to null");
    assert.equal(isQboConnectionFailure(error), true, `not classified: ${error?.name}`);
});

test("a raw network TypeError on the invoice probe is connection-level too", async () => {
    const probe = await withFetch(
        (async () => {
            throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
        () => probeQBInvoice(TOKENS, "1"),
    );
    assert.equal(probe.state === "error" && probe.connectionFailed, true);
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

// --- The REAL loop, driven by a fake QuickBooks ---

import {
    runQboRowLoop,
    classifyPreflightFailure,
    QBNotConnectedError,
    type PaymentsSyncQboClient,
    type QBPaymentSyncResult,
} from "../src/lib/quickbooks-payments";
import { QboRetryableError } from "../src/lib/quickbooks";

function emptyResult(): QBPaymentSyncResult {
    return {
        checked: 0, settled: 0, partiallyPaid: 0, errors: [], progressBillingsSettled: 0,
        skipped: 0, abortedOnQboOutage: false, runFailed: false,
    };
}

/** A fake QuickBooks that records every call, so we can prove the run STOPPED. */
function fakeQbo(script: {
    probe?: (id: string) => QBInvoiceProbe;
    payment?: (id: string) => { txnDate: string | null; amount: number; referenceNumber: string | null } | null;
}) {
    const calls = { probes: [] as string[], payments: [] as string[] };
    const client: PaymentsSyncQboClient = {
        async probeInvoice(id) {
            calls.probes.push(id);
            return script.probe ? script.probe(id) : { state: "ok", balance: 0, total: 10, paymentTxnIds: [] };
        },
        async getPayment(id) {
            calls.payments.push(id);
            return script.payment ? script.payment(id) : { txnDate: "2026-09-01", amount: 10, referenceNumber: null };
        },
    };
    return { client, calls };
}

/** The same row body the real sync uses: probe, then read payment detail. */
function rowHandler(qbo: PaymentsSyncQboClient, result: QBPaymentSyncResult) {
    return async (row: { id: string; qbInvoiceId: string }) => {
        result.checked++;
        const probe = await qbo.probeInvoice(row.qbInvoiceId);
        if (probe.state === "error") {
            if (probe.connectionFailed) {
                throw new QboRetryableError("probe failed", probe.status);
            }
            return;
        }
        if (probe.state !== "ok") return;
        if (probe.total > 0 && probe.balance <= 0) {
            const paymentId = probe.paymentTxnIds[0];
            if (paymentId) await qbo.getPayment(paymentId);
            result.settled++;
        }
    };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, qbInvoiceId: `${i + 1}` }));

test("200 rows during an outage cost ONE probe, not 200", async () => {
    const result = emptyResult();
    const { client, calls } = fakeQbo({
        probe: () => ({ state: "error", status: 0, connectionFailed: true, timedOut: true }),
    });
    await runQboRowLoop(rows(200), result, rowHandler(client, result), () => {}, "milestones");

    // One 20s deadline instead of 200 - the whole point of the abort.
    assert.equal(calls.probes.length, 1);
    assert.equal(result.skipped, 199);
    assert.equal(result.abortedOnQboOutage, true);
    assert.equal(result.runFailed, true);
    assert.equal(result.failureReason, "qbo-unavailable");
});

test("a PAYMENT-DETAIL timeout aborts the run too, not just the probe", async () => {
    // Codex gate: getQBPayment failures were caught as ordinary row errors, so
    // many settled invoices could each burn a full deadline after a good probe.
    const result = emptyResult();
    const { client, calls } = fakeQbo({
        probe: () => ({ state: "ok", balance: 0, total: 100, paymentTxnIds: ["p1"] }),
        payment: () => {
            throw new QboRetryableError("QB payment read failed with status 503", 503);
        },
    });
    await runQboRowLoop(rows(50), result, rowHandler(client, result), () => {}, "milestones");

    assert.equal(calls.probes.length, 1, "must not probe row 2");
    assert.equal(calls.payments.length, 1, "must not read a second payment");
    assert.equal(result.skipped, 49);
    assert.equal(result.abortedOnQboOutage, true);
});

test("an ordinary per-row probe failure is RECORDED and the run continues", async () => {
    // Codex gate: this used to assert the failed row produced NO error, which
    // meant a run could check nothing and still emit status "ok" - a green
    // heartbeat for work that never happened. An unverified milestone is an
    // incomplete run, so it must be recorded.
    const result = emptyResult();
    const seen: string[] = [];
    const { client, calls } = fakeQbo({
        probe: (id) => (id === "2"
            ? { state: "error", status: 400 }
            : { state: "ok", balance: 0, total: 10, paymentTxnIds: [] }),
    });
    const handler = async (row: { id: string; qbInvoiceId: string }) => {
        result.checked++;
        const probe = await client.probeInvoice(row.qbInvoiceId);
        if (probe.state === "error") {
            if (probe.connectionFailed) throw new QboRetryableError("probe failed", probe.status);
            throw new Error(`QBO invoice probe failed (status ${probe.status})`);
        }
    };
    await runQboRowLoop(rows(4), result, handler, (row) => seen.push(row.id), "milestones");

    assert.equal(calls.probes.length, 4, "a non-shared failure must not abort the run");
    assert.equal(result.skipped, 0);
    assert.equal(result.abortedOnQboOutage, false);
    assert.deepEqual(seen, ["s1"], "the unverified row is recorded as an error");
});

test("a 401 on any probe aborts the run - the credential is shared", async () => {
    const result = emptyResult();
    const { client, calls } = fakeQbo({ probe: () => ({ state: "error", status: 401, connectionFailed: true }) });
    await runQboRowLoop(rows(120), result, rowHandler(client, result), () => {}, "milestones");

    assert.equal(calls.probes.length, 1, "the next 119 rows would fail identically");
    assert.equal(result.skipped, 119);
    assert.equal(result.abortedOnQboOutage, true);
});

test("a settle failure is recorded per row and the run continues", async () => {
    const result = emptyResult();
    const errors: string[] = [];
    const { client, calls } = fakeQbo({ probe: () => ({ state: "ok", balance: 0, total: 10, paymentTxnIds: [] }) });
    const handler = async (row: { id: string; qbInvoiceId: string }) => {
        result.checked++;
        await client.probeInvoice(row.qbInvoiceId);
        if (row.id === "s1") throw new Error("DB conflict");
    };
    await runQboRowLoop(rows(3), result, handler, (row) => errors.push(row.id), "milestones");

    assert.equal(calls.probes.length, 3, "a row-level DB error must not abort the run");
    assert.deepEqual(errors, ["s1"]);
    assert.equal(result.abortedOnQboOutage, false);
});

test("an outage partway through skips only the remainder", async () => {
    const result = emptyResult();
    const { client } = fakeQbo({
        probe: (id) => (Number(id) >= 3
            ? { state: "error", status: 0, connectionFailed: true, timedOut: true }
            : { state: "ok", balance: 5, total: 10, paymentTxnIds: [] }),
    });
    await runQboRowLoop(rows(5), result, rowHandler(client, result), () => {}, "milestones");

    assert.equal(result.checked, 3);
    assert.equal(result.skipped, 2);
});

test("a second pass is skipped wholesale once the first aborted", async () => {
    const result = emptyResult();
    result.abortedOnQboOutage = true;
    const { client, calls } = fakeQbo({});
    await runQboRowLoop(rows(7), result, rowHandler(client, result), () => {}, "progress billings");

    assert.equal(calls.probes.length, 0, "the connection is shared - do not retry it");
    assert.equal(result.skipped, 7);
});

// --- Preflight failures are failed runs ---

test("EVERY preflight failure marks the run failed, not just timeouts", () => {
    assert.deepEqual(
        classifyPreflightFailure(new QBTimeoutError("refresh timed out")),
        { reason: "qbo-unavailable", abortedOnQboOutage: true },
    );
    assert.deepEqual(
        classifyPreflightFailure(new QboRetryableError("503", 503)),
        { reason: "qbo-unavailable", abortedOnQboOutage: true },
    );
    // Codex gate: these two used to leave the run recorded as status "ok",
    // which made the digest blind to a disconnected or broken money rail.
    assert.deepEqual(
        classifyPreflightFailure(new QBNotConnectedError()),
        { reason: "quickbooks-not-connected", abortedOnQboOutage: false },
    );
    assert.deepEqual(
        classifyPreflightFailure(new Error("settings store unreadable")),
        { reason: "token-fetch-failed", abortedOnQboOutage: false },
    );
});


// --- A run that skipped work is never "ok" ---

test("run status: ok only when the run actually finished all its work", async () => {
    const { paymentsSyncRunStatus } = await import("../src/lib/quickbooks-payments");

    assert.equal(paymentsSyncRunStatus(emptyResult()), "ok");

    // Codex gate: these two used to record "ok" and refresh the health
    // heartbeat on the strength of milestones that were never checked.
    assert.equal(paymentsSyncRunStatus({ ...emptyResult(), skipped: 3 }), "partial");
    assert.equal(paymentsSyncRunStatus({ ...emptyResult(), errors: ["INV-1/Deposit: boom"] }), "partial");

    assert.equal(paymentsSyncRunStatus({ ...emptyResult(), runFailed: true }), "error");
    // A hard failure outranks a partial one.
    assert.equal(
        paymentsSyncRunStatus({ ...emptyResult(), runFailed: true, skipped: 9, errors: ["x"] }),
        "error",
    );
});

test("an aborted outage run reports error, not partial", async () => {
    const { paymentsSyncRunStatus } = await import("../src/lib/quickbooks-payments");
    const result = emptyResult();
    const { client } = fakeQbo({
        probe: () => ({ state: "error", status: 0, connectionFailed: true, timedOut: true }),
    });
    await runQboRowLoop(rows(10), result, rowHandler(client, result), () => {}, "milestones");
    assert.equal(paymentsSyncRunStatus(result), "error");
});

// --- Token rotation vs. persistence ---

const STALE_QB = { accessToken: "stale-access", refreshToken: "stale-refresh", realmId: "realm-1" };

test("a SAVE failure after a successful rotation is surfaced, never swallowed", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    // Codex gate: refresh and save shared one catch, so a rotation Intuit had
    // already committed could fall back to the now-spent stale pair and report
    // a healthy connection while the integration was stranded.
    let saves = 0;
    const error = await refreshTokensOrFallBack(
        STALE_QB,
        async () => ({ accessToken: "new-access", refreshToken: "new-refresh" }),
        async () => {
            saves++;
            throw new Error("DB write failed");
        },
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error instanceof Error);
    assert.equal(error.name, "QBTokenPersistenceError");
    assert.equal(saves, 2, "one retry before giving up");
});

test("a transient save blip is retried once and then succeeds", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    let saves = 0;
    const tokens = await refreshTokensOrFallBack(
        STALE_QB,
        async () => ({ accessToken: "new-access", refreshToken: "new-refresh" }),
        async () => {
            saves++;
            if (saves === 1) throw new Error("deadlock");
        },
    );
    assert.deepEqual(tokens, { accessToken: "new-access", refreshToken: "new-refresh", realmId: "realm-1" });
    assert.equal(saves, 2);
});

test("a REFRESH failure still falls back to the old access token (unchanged)", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    let saves = 0;
    const tokens = await refreshTokensOrFallBack(
        STALE_QB,
        async () => {
            throw new Error("500 from Intuit");
        },
        async () => {
            saves++;
        },
    );
    assert.deepEqual(tokens, STALE_QB);
    assert.equal(saves, 0, "nothing was rotated, so nothing is saved");
});

test("a token-persistence failure marks the run failed with its own reason", async () => {
    const { classifyPreflightFailure, QBTokenPersistenceError } = await import("../src/lib/quickbooks-payments");
    assert.deepEqual(
        classifyPreflightFailure(new QBTokenPersistenceError()),
        { reason: "token-not-persisted", abortedOnQboOutage: false },
    );
});


// --- Never settle a payment we could not read ---

test("a null payment read leaves the milestone unsettled and records an error", async () => {
    const result = emptyResult();
    const errors: string[] = [];
    let settled = 0;
    const { client } = fakeQbo({
        probe: () => ({ state: "ok", balance: 0, total: 100, paymentTxnIds: ["p1"] }),
        payment: () => null, // 400/404/malformed body
    });
    // Mirrors the real row body: a null read must throw, never settle.
    const handler = async (row: { id: string; qbInvoiceId: string }) => {
        result.checked++;
        const probe = await client.probeInvoice(row.qbInvoiceId);
        if (probe.state !== "ok") return;
        if (probe.total > 0 && probe.balance <= 0) {
            const p = await client.getPayment(probe.paymentTxnIds[0]);
            if (!p) throw new Error("QBO payment p1 could not be read; milestone left unsettled");
            settled++;
        }
    };
    await runQboRowLoop(rows(3), result, handler, (row) => errors.push(row.id), "milestones");

    // Codex gate: this used to fall back to `new Date()` and settle anyway,
    // stamping today as the payment date - wrong money data, reported clean.
    assert.equal(settled, 0);
    assert.deepEqual(errors, ["s0", "s1", "s2"]);
    assert.equal(result.abortedOnQboOutage, false, "a bad row is not an outage");
});

test("401/403/408 payment reads abort the run; a plain 404 does not", async () => {
    const { isSharedQboFailureStatus } = await import("../src/lib/quickbooks");
    for (const status of [401, 403, 408, 429, 500, 503]) {
        assert.equal(isSharedQboFailureStatus(status), true, String(status));
    }
    for (const status of [400, 404, 409, 422]) {
        assert.equal(isSharedQboFailureStatus(status), false, String(status));
    }
});
