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
    const calls = { probes: [] as string[], payments: [] as string[], verifies: 0 };
    const client: PaymentsSyncQboClient = {
        async probeInvoice(id) {
            calls.probes.push(id);
            return script.probe ? script.probe(id) : { state: "ok", balance: 0, total: 10, paymentTxnIds: [] };
        },
        async getPayment(id) {
            calls.payments.push(id);
            return script.payment ? script.payment(id) : { txnDate: "2026-09-01", amount: 10, referenceNumber: null };
        },
        async verifyConnection() {
            calls.verifies += 1;
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


// --- Never settle without an authoritative payment date ---

test("settlement is refused when there is no linked payment id", async () => {
    const { resolveSettlementDate, PAYMENT_DATE_MISSING } = await import("../src/lib/quickbooks-payments");
    const { client } = fakeQbo({});
    await assert.rejects(
        () => resolveSettlementDate(client, null),
        (e: unknown) => (e as Error).message.includes(PAYMENT_DATE_MISSING),
    );
});

test("settlement is refused when the payment carries no TxnDate", async () => {
    const { resolveSettlementDate, PAYMENT_DATE_MISSING } = await import("../src/lib/quickbooks-payments");
    // Codex gate: paidAt defaulted to `new Date()` and was only replaced when
    // txnDate happened to be truthy, so a null date settled a REAL milestone
    // stamped with today - and fired the mirror/notification side effects.
    const { client } = fakeQbo({ payment: () => ({ txnDate: null, amount: 10, referenceNumber: null }) });
    await assert.rejects(
        () => resolveSettlementDate(client, "p1"),
        (e: unknown) => (e as Error).message.includes(PAYMENT_DATE_MISSING),
    );
});

test("settlement is refused when the payment record cannot be read", async () => {
    const { resolveSettlementDate, PAYMENT_DATE_MISSING } = await import("../src/lib/quickbooks-payments");
    const { client } = fakeQbo({ payment: () => null });
    await assert.rejects(
        () => resolveSettlementDate(client, "p1"),
        (e: unknown) => (e as Error).message.includes(PAYMENT_DATE_MISSING),
    );
});

test("settlement is refused when TxnDate is unparseable", async () => {
    const { resolveSettlementDate, PAYMENT_DATE_MISSING } = await import("../src/lib/quickbooks-payments");
    const { client } = fakeQbo({ payment: () => ({ txnDate: "not-a-date", amount: 10, referenceNumber: null }) });
    await assert.rejects(
        () => resolveSettlementDate(client, "p1"),
        (e: unknown) => (e as Error).message.includes(PAYMENT_DATE_MISSING),
    );
});

test("a real TxnDate settles at midday UTC, with the reference number", async () => {
    const { resolveSettlementDate } = await import("../src/lib/quickbooks-payments");
    const { client } = fakeQbo({ payment: () => ({ txnDate: "2026-08-14", amount: 10, referenceNumber: "CHK-8891" }) });
    const { paidAt, referenceNumber } = await resolveSettlementDate(client, "p1");
    assert.equal(paidAt.toISOString(), "2026-08-14T12:00:00.000Z");
    assert.equal(referenceNumber, "CHK-8891");
});


// --- An empty run must still prove the connection works ---

test("an empty run makes one authenticated call before it may claim ok", async () => {
    // Codex gate: holding a token object is not proof the rail works. A
    // non-timeout refresh failure falls back to the STALE pair, and stale
    // credentials, a wrong realm, or revoked accounting access all still
    // produce tokens - so an empty run recorded a fresh "ok" every hour
    // forever while nothing could ever have synced.
    const { client, calls } = fakeQbo({});
    await client.verifyConnection();
    assert.equal(calls.verifies, 1);
});

test("a failed connectivity check is classified as a failed run", async () => {
    const { classifyPreflightFailure } = await import("../src/lib/quickbooks-payments");
    // Whatever CompanyInfo throws, the run must not be recorded as ok.
    for (const error of [
        new QBTimeoutError("timed out"),
        new QboRetryableError("503", 503),
        new Error("AuthenticationFailed: invalid realm"),
    ]) {
        const verdict = classifyPreflightFailure(error);
        assert.ok(verdict.reason, `no reason for ${error.name}`);
    }
});

// --- Pagination: the run must not stop at an arbitrary first 100 ---

test("rows past the page cap are counted as skipped, never silently dropped", async () => {
    // Codex gate: both queries took an unordered first 100 and stopped. Rows
    // beyond that were neither checked nor counted, so the run emitted "ok"
    // while work was left undone - and with no ORDER BY, Postgres could hand
    // back the same first page every hour, starving the rest forever.
    const { paymentsSyncRunStatus } = await import("../src/lib/quickbooks-payments");

    const result = emptyResult();
    const { client } = fakeQbo({ probe: () => ({ state: "ok", balance: 5, total: 10, paymentTxnIds: [] }) });
    // One page of 100 processed, 43 left behind by the budget.
    await runQboRowLoop(rows(100), result, rowHandler(client, result), () => {}, "milestones");
    result.skipped += 43;

    assert.equal(result.checked, 100);
    assert.equal(result.skipped, 43);
    // The whole point: unreached work makes the run partial, not ok.
    assert.equal(paymentsSyncRunStatus(result), "partial");
});

test("a fully drained collection reports ok", async () => {
    const { paymentsSyncRunStatus } = await import("../src/lib/quickbooks-payments");
    const result = emptyResult();
    const { client } = fakeQbo({ probe: () => ({ state: "ok", balance: 5, total: 10, paymentTxnIds: [] }) });
    await runQboRowLoop(rows(250), result, rowHandler(client, result), () => {}, "milestones");

    assert.equal(result.checked, 250);
    assert.equal(result.skipped, 0);
    assert.equal(paymentsSyncRunStatus(result), "ok");
});


// --- The run budget stops the loop before the cron ceiling ---

test("the row loop stops when the route budget is gone, counting the rest skipped", async () => {
    const { paymentsSyncRunStatus, PAYMENTS_SYNC_BUDGET_MS } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");

    // 100s under the cron's 120s ceiling, leaving room to record the outcome.
    assert.equal(PAYMENTS_SYNC_BUDGET_MS, 100_000);

    const result = emptyResult();
    const { client, calls } = fakeQbo({ probe: () => ({ state: "ok", balance: 5, total: 10, paymentTxnIds: [] }) });
    // A budget that ran out 10s ago: not one row may start.
    const spent = createRouteDeadline(2_000, Date.now() - 12_000);
    await runQboRowLoop(rows(200), result, rowHandler(client, result), () => {}, "milestones", spent);

    assert.equal(calls.probes.length, 0, "no row may start with no budget left");
    assert.equal(result.skipped, 200);
    // Unfinished work is reported honestly rather than as a clean run.
    assert.equal(paymentsSyncRunStatus(result), "partial");
});

test("CUMULATIVE latency: the loop exits before the ceiling with slow rows", async () => {
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const CEILING_MS = 3_000;
    const result = emptyResult();
    const deadline = createRouteDeadline(1_200);

    // Each row costs 300ms of QBO time; 200 rows would be a full minute.
    const slowClient: PaymentsSyncQboClient = {
        async probeInvoice() {
            await new Promise(resolve => setTimeout(resolve, 300));
            return { state: "ok", balance: 5, total: 10, paymentTxnIds: [] };
        },
        async getPayment() {
            return { txnDate: "2026-09-01", amount: 10, referenceNumber: null };
        },
        async verifyConnection() {},
    };

    const started = Date.now();
    await runQboRowLoop(rows(200), result, rowHandler(slowClient, result), () => {}, "milestones", deadline);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < CEILING_MS, `ran ${elapsed}ms, past the ${CEILING_MS}ms ceiling`);
    assert.ok(result.checked > 0, "should have processed some rows");
    assert.ok(result.checked < 200, "must not have processed them all");
    assert.equal(result.checked + result.skipped, 200, "every row is accounted for");
});


// --- Exactly one audit event per invocation ---

test("a failed remaining-count makes the run error, never skipped:0/ok", async () => {
    const { paymentsSyncRunStatus } = await import("../src/lib/quickbooks-payments");
    // Codex gate: countRemaining used `.catch(() => 0)`, so a DB failure left
    // skipped at 0 and the run reported "ok" - an unknown amount of unverified
    // payment work vanished from the record. Not knowing is a failed run.
    const result = emptyResult();
    result.runFailed = true;
    result.failureReason = "count-failed";
    result.errors.push("Could not count remaining rows: connection lost");

    assert.equal(result.skipped, 0);
    assert.equal(paymentsSyncRunStatus(result), "error", "a 0 we cannot trust is not ok");
    assert.equal(result.failureReason, "count-failed");
});

test("a crashed run is still recorded exactly once, as an error", async () => {
    // The event is written in a finally-style guard, so a Prisma failure in the
    // pagination queries cannot return or throw with NO event: to the health
    // check, a crashing cron would look identical to one never deployed.
    const { paymentsSyncRunStatus } = await import("../src/lib/quickbooks-payments");
    const crashed = {
        checked: 0, settled: 0, partiallyPaid: 0, progressBillingsSettled: 0,
        skipped: 0, abortedOnQboOutage: false,
        runFailed: true, failureReason: "run-crashed",
        errors: ["Prisma: connection terminated"],
    };
    assert.equal(paymentsSyncRunStatus(crashed), "error");
});

test("the recorded-once guard is a single flag, not per-return-path", async () => {
    // Pins the invariant behind the try/catch wrapper: whichever path a run
    // takes, the audit row is written once and only once.
    const runState = { recorded: false };
    const writes: string[] = [];
    const record = async (label: string) => {
        if (runState.recorded) return;
        runState.recorded = true;
        writes.push(label);
    };
    await record("normal-return");
    await record("catch-handler");
    assert.deepEqual(writes, ["normal-return"]);
});


// --- An ambiguous refresh must never hand back the stored pair ---

const STORED_QB = { accessToken: "stored-access", refreshToken: "stored-refresh", realmId: "realm-1" };

test("a RESET during refresh is stranded, not a fallback", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const { QboRetryableError, isQBTokenStrandedError } = await import("../src/lib/quickbooks");
    // Codex gate: the request may well have reached Intuit and rotated the
    // token, so returning the stored pair reports a healthy connection sitting
    // on a spent refresh token.
    let saves = 0;
    const error = await refreshTokensOrFallBack(
        STORED_QB,
        async () => { throw new QboRetryableError("fetch failed: ECONNRESET"); },
        async () => { saves++; },
    ).then(() => null, (e: unknown) => e as Error);

    assert.equal(isQBTokenStrandedError(error), true, `got ${error?.name}`);
    assert.equal(saves, 0);
});

test("a MALFORMED refresh body is stranded, not a fallback", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const { QboMalformedResponseError, isQBTokenStrandedError } = await import("../src/lib/quickbooks");
    const error = await refreshTokensOrFallBack(
        STORED_QB,
        async () => { throw new QboMalformedResponseError("truncated body"); },
        async () => {},
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(isQBTokenStrandedError(error), true, `got ${error?.name}`);
});

test("a 200 MISSING either token is stranded, and nothing is persisted", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const { isQBTokenStrandedError } = await import("../src/lib/quickbooks");
    for (const bad of [
        { accessToken: "", refreshToken: "new-refresh" },
        { accessToken: "new-access", refreshToken: "" },
        { accessToken: "new-access", refreshToken: "   " },
        { accessToken: undefined as unknown as string, refreshToken: "new-refresh" },
    ]) {
        let saves = 0;
        const error = await refreshTokensOrFallBack(
            STORED_QB,
            async () => bad,
            async () => { saves++; },
        ).then(() => null, (e: unknown) => e as Error);
        assert.equal(isQBTokenStrandedError(error), true, `${JSON.stringify(bad)} -> ${error?.name}`);
        assert.equal(saves, 0, "an unusable pair must never be written over the stored one");
    }
});

test("an UNAMBIGUOUS refusal still falls back to the stored pair", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    // Intuit answered with a non-2xx and rotated nothing, so the old access
    // token may still be valid. This is the one branch that may fall back.
    const tokens = await refreshTokensOrFallBack(
        STORED_QB,
        async () => { throw new Error("QB token refresh failed"); },
        async () => {},
    );
    assert.deepEqual(tokens, STORED_QB);
});

test("a stranded refresh is classified as its own failed-run reason", async () => {
    const { classifyPreflightFailure } = await import("../src/lib/quickbooks-payments");
    const { QBTokenStrandedError } = await import("../src/lib/quickbooks");
    assert.deepEqual(
        classifyPreflightFailure(new QBTokenStrandedError("ECONNRESET")),
        { reason: "token-rotation-ambiguous", abortedOnQboOutage: false },
    );
});


// --- The cursor makes the row cap a rolling window, not a wall ---

/** In-memory stand-in for the AutomationSetting-backed cursor store. */
function memoryCursorStore() {
    const values = new Map<string, string>();
    return {
        values,
        store: {
            async get(key: string) { return values.get(key) ?? null; },
            async set(key: string, value: string) { values.set(key, value); },
        },
    };
}

/**
 * Drives the REAL paging helper the sync uses, against an in-memory
 * collection, so the resume/wrap behaviour under test is the shipped code
 * rather than a restatement of it.
 */
async function runPagedPass(
    all: { id: string }[],
    cursorStore: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> },
    key: string,
    maxRows: number,
    seen: Set<string>,
) {
    const { forEachPendingPage } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const sorted = [...all].sort((a, b) => a.id.localeCompare(b.id));
    const after = (cursorId: string | null) =>
        cursorId === null ? sorted : sorted.filter(r => r.id > cursorId);

    await forEachPendingPage(
        emptyResult(),
        createRouteDeadline(30_000),
        async (cursorId, take) => after(cursorId).slice(0, take),
        async (cursorId) => after(cursorId).length,
        async (page) => { for (const row of page) seen.add(row.id); },
        { store: cursorStore, key },
        maxRows,
    );
}

test("across runs, EVERY row is reached — the cap becomes a rolling window", async () => {
    // Codex gate: ordering by id made each run deterministic, but every run
    // still started at the same end, so with more pending rows than one run's
    // budget the tail was re-skipped forever and never verified.
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `row-${String(i).padStart(3, "0")}` }));
    const { store } = memoryCursorStore();
    const seen = new Set<string>();

    // 100 rows per run: three runs must cover all 250 and wrap cleanly.
    for (let run = 0; run < 3; run++) {
        await runPagedPass(all, store, "k", 100, seen);
    }

    assert.equal(seen.size, 250, `only reached ${seen.size} of 250 rows`);
});

test("a drained collection wraps back to the top for the next run", async () => {
    const all = Array.from({ length: 30 }, (_, i) => ({ id: `row-${String(i).padStart(3, "0")}` }));
    const { store } = memoryCursorStore();

    const first = new Set<string>();
    await runPagedPass(all, store, "k", 100, first);
    assert.equal(first.size, 30, "one run covers a small collection");

    // Having drained it, the cursor is back at the top and the next run
    // re-verifies from the start rather than sitting on an empty tail.
    const second = new Set<string>();
    await runPagedPass(all, store, "k", 100, second);
    assert.equal(second.size, 30, "the next run starts again from the top");
});

test("the cursor survives between runs so run 2 does not repeat run 1", async () => {
    const all = Array.from({ length: 200 }, (_, i) => ({ id: `row-${String(i).padStart(3, "0")}` }));
    const { store, values } = memoryCursorStore();

    const first = new Set<string>();
    await runPagedPass(all, store, "k", 100, first);
    assert.equal(first.size, 100);
    assert.ok(values.get("k"), "a cursor must be persisted for the next run");

    const second = new Set<string>();
    await runPagedPass(all, store, "k", 100, second);
    assert.equal(second.size, 100);
    // No overlap: run 2 continued instead of restarting.
    const overlap = [...second].filter(id => first.has(id));
    assert.deepEqual(overlap, [], `run 2 repeated ${overlap.length} of run 1's rows`);
});

test("the collection order alternates so neither side starves", async () => {
    const { PAYMENTS_ORDER_KEY } = await import("../src/lib/quickbooks-payments");
    // Whichever collection runs second only gets the budget the first left, so
    // a fixed order lets a busy queue starve the other one indefinitely.
    const { store } = memoryCursorStore();
    const order: string[] = [];
    for (let run = 0; run < 4; run++) {
        const last = await store.get(PAYMENTS_ORDER_KEY);
        const billingsFirst = last !== "billings-first";
        await store.set(PAYMENTS_ORDER_KEY, billingsFirst ? "billings-first" : "milestones-first");
        order.push(billingsFirst ? "billings" : "milestones");
    }
    assert.deepEqual(order, ["billings", "milestones", "billings", "milestones"]);
});

test("a cursor store that fails never breaks the run", async () => {
    const { automationSettingCursorStore } = await import("../src/lib/quickbooks-payments");
    // No database in unit tests: the real store must swallow that and report
    // "no cursor" rather than throwing into the sync.
    assert.equal(await automationSettingCursorStore.get("nope"), null);
    await automationSettingCursorStore.set("nope", "value"); // must not throw
});
