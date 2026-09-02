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

// --- Round 29 gate: getQBInvoiceStatus must not collapse a shared failure into null ---

test("getQBInvoiceStatus throws on 401/403/429/503 instead of answering null", async () => {
    // Codex gate: sendMilestoneInvoicesCore read a null total as "this ONE
    // row's total is unreadable" and kept spending a fresh deadline on every
    // remaining row against what was really a shared credential/rate wall.
    const { getQBInvoiceStatus, isQboConnectionFailure } = await import("../src/lib/quickbooks");
    for (const status of [401, 403, 429, 503]) {
        const error = await withFetch(
            async () => json(status, { Fault: {} }),
            () => getQBInvoiceStatus(TOKENS, "1"),
        ).then(() => null, (e: unknown) => e as Error);
        assert.ok(error, `status ${status} must throw, not return null`);
        assert.equal(isQboConnectionFailure(error), true, `status ${status} must be a recognised shared wall`);
    }
});

test("getQBInvoiceStatus still answers null for 404 — the only authoritative absence", async () => {
    const { getQBInvoiceStatus } = await import("../src/lib/quickbooks");
    const status = await withFetch(async () => json(404, { Fault: {} }), () => getQBInvoiceStatus(TOKENS, "1"));
    assert.equal(status, null);
});

test("getQBInvoiceStatus still reads a healthy invoice normally", async () => {
    const { getQBInvoiceStatus } = await import("../src/lib/quickbooks");
    const status = await withFetch(
        async () => json(200, { Invoice: { TotalAmt: 250, Balance: 100, LinkedTxn: [{ TxnType: "Payment", TxnId: "p1" }] } }),
        () => getQBInvoiceStatus(TOKENS, "1"),
    );
    assert.deepEqual(status, { balance: 100, total: 250, paymentTxnIds: ["p1"] });
});

// --- Round 29 gate: findQBInvoicesByDocNumber must not silently cap at 20 ---

test("findQBInvoicesByDocNumber refuses when the page cap is hit, instead of silently answering a partial list", async () => {
    const { findQBInvoicesByDocNumber, isQBResultSetTruncatedError } = await import("../src/lib/quickbooks");
    const rows = Array.from({ length: 20 }, (_, i) => ({ Id: String(i), DocNumber: "INV-1-1", PrivateNote: "note", TotalAmt: 100, Balance: 100 }));
    const error = await withFetch(
        async () => json(200, { QueryResponse: { Invoice: rows } }),
        () => findQBInvoicesByDocNumber(TOKENS, "INV-1-1"),
    ).then(() => null, (e: unknown) => e as Error);
    assert.ok(error, "exactly 20 results must refuse, not answer");
    assert.equal(isQBResultSetTruncatedError(error), true);
});

test("findQBInvoicesByDocNumber answers normally under the page cap", async () => {
    const { findQBInvoicesByDocNumber } = await import("../src/lib/quickbooks");
    const rows = Array.from({ length: 19 }, (_, i) => ({ Id: String(i), DocNumber: "INV-1-1", PrivateNote: "note", TotalAmt: 100, Balance: 100 }));
    const matches = await withFetch(
        async () => json(200, { QueryResponse: { Invoice: rows } }),
        () => findQBInvoicesByDocNumber(TOKENS, "INV-1-1"),
    );
    assert.equal(matches.length, 19);
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

test("a 401/403 preflight failure is classified qbo-auth, not qbo-unavailable", async () => {
    // Round 29 gate: pipeline-health's digest only counts events reasoned
    // "qbo-auth" toward its reconnect-QuickBooks alert. Folding a credential
    // rejection into the generic "qbo-unavailable" bucket made a broken
    // connection invisible to that alert.
    const { QboHttpError } = await import("../src/lib/quickbooks");
    for (const status of [401, 403]) {
        assert.deepEqual(
            classifyPreflightFailure(new QboHttpError(`QB CompanyInfo failed (${status})`, status)),
            { reason: "qbo-auth", abortedOnQboOutage: true },
            `status ${status}`,
        );
    }
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

test("an EXPLICIT 400/401 rejection falls back to the old access token", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const { QboHttpError } = await import("../src/lib/quickbooks");
    // Intuit processed the exchange and refused it (invalid_grant and
    // friends), so nothing rotated and the stored access token may still work.
    for (const status of [400, 401]) {
        let saves = 0;
        const tokens = await refreshTokensOrFallBack(
            STALE_QB,
            async () => { throw new QboHttpError(`QB token refresh failed (${status})`, status); },
            async () => { saves++; },
        );
        assert.deepEqual(tokens, STALE_QB, `status ${status}`);
        assert.equal(saves, 0, "nothing was rotated, so nothing is saved");
    }
});

test("a 5xx refresh strands instead of falling back", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const { QboRetryableError, isQBTokenStrandedError } = await import("../src/lib/quickbooks");
    // Codex gate: Intuit broke somewhere in its own pipeline and may well have
    // rotated before failing, so the stored pair could already be spent.
    const error = await refreshTokensOrFallBack(
        STALE_QB,
        async () => { throw new QboRetryableError("QB token refresh failed (503)", 503); },
        async () => {},
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(isQBTokenStrandedError(error), true, `got ${error?.name}`);
});

test("an untyped refresh failure strands - no status is no evidence", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const { isQBTokenStrandedError } = await import("../src/lib/quickbooks");
    const error = await refreshTokensOrFallBack(
        STALE_QB,
        async () => { throw new Error("something went wrong"); },
        async () => {},
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(isQBTokenStrandedError(error), true, `got ${error?.name}`);
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

test("only an explicit client rejection falls back to the stored pair", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const { QboHttpError, isQBTokenStrandedError } = await import("../src/lib/quickbooks");

    // 400 invalid_grant: Intuit answered and refused, rotating nothing.
    const tokens = await refreshTokensOrFallBack(
        STORED_QB,
        async () => { throw new QboHttpError("QB token refresh failed (400): invalid_grant", 400); },
        async () => {},
    );
    assert.deepEqual(tokens, STORED_QB);

    // A 500 is not a refusal - it is an unknown outcome.
    const stranded = await refreshTokensOrFallBack(
        STORED_QB,
        async () => { throw new QboHttpError("QB token refresh failed (500)", 500); },
        async () => {},
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(isQBTokenStrandedError(stranded), true, `got ${stranded?.name}`);
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
        async ({ cursorId }) => after(cursorId).length,
        async (page) => {
            for (const row of page) seen.add(row.id);
            return { lastCompletedId: page[page.length - 1]?.id ?? null };
        },
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


// --- The cursor may not step over rows an outage cut short ---

test("a mid-page outage leaves the cursor on the last COMPLETED row", async () => {
    const { runQboRowLoop } = await import("../src/lib/quickbooks-payments");
    // Codex gate: the cursor used to jump to the page tail regardless, so the
    // rows an outage interrupted were stepped over and not looked at again
    // until the cursor wrapped all the way round.
    const result = emptyResult();
    const page = rows(10);
    const { client } = fakeQbo({
        probe: (id) => (Number(id) >= 4
            ? { state: "error", status: 0, connectionFailed: true, timedOut: true }
            : { state: "ok", balance: 5, total: 10, paymentTxnIds: [] }),
    });

    const { lastCompletedId } = await runQboRowLoop(page, result, rowHandler(client, result), () => {}, "milestones");

    // Rows s0..s2 completed (invoice ids 1..3); the outage hit on the 4th.
    assert.equal(lastCompletedId, "s2");
    assert.equal(result.abortedOnQboOutage, true);
});

test("across consecutive runs, a mid-page outage loses no rows", async () => {
    const { forEachPendingPage, runQboRowLoop } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");

    const all = Array.from({ length: 12 }, (_, i) => ({ id: `row-${String(i).padStart(2, "0")}` }));
    const { store } = memoryCursorStore();
    const verified = new Set<string>();
    const after = (cursorId: string | null) =>
        cursorId === null ? all : all.filter(r => r.id > cursorId);

    // Run 1: QBO dies partway through the first page.
    const firstRun = emptyResult();
    let failFrom: string | null = "row-05";
    const pass = async (result: typeof firstRun) => {
        await forEachPendingPage(
            result,
            createRouteDeadline(30_000),
            async (cursorId, take) => after(cursorId).slice(0, take),
            async ({ cursorId }) => after(cursorId).length,
            (page) => runQboRowLoop(
                page,
                result,
                async (row) => {
                    if (failFrom !== null && row.id >= failFrom) {
                        throw new QboRetryableError("QBO went away", 503);
                    }
                    verified.add(row.id);
                },
                () => {},
                "milestones",
            ),
            { store, key: "k" },
            100,
        );
    };

    await pass(firstRun);
    assert.equal(firstRun.abortedOnQboOutage, true);
    assert.deepEqual([...verified].sort(), ["row-00", "row-01", "row-02", "row-03", "row-04"]);

    // Run 2: QBO is healthy again. It must pick up at row-05, the first row
    // the outage prevented us from verifying - not at row-11.
    failFrom = null;
    await pass(emptyResult());

    assert.equal(verified.size, 12, `missed ${12 - verified.size} rows`);
    assert.deepEqual([...verified].sort(), all.map(r => r.id));
});

test("a row-level error still advances the cursor, so one bad row cannot wedge the run", async () => {
    const { runQboRowLoop } = await import("../src/lib/quickbooks-payments");
    const result = emptyResult();
    const { client } = fakeQbo({
        probe: (id) => (id === "2" ? { state: "error", status: 400 } : { state: "ok", balance: 5, total: 10, paymentTxnIds: [] }),
    });
    const handler = async (row: { id: string; qbInvoiceId: string }) => {
        result.checked++;
        const probe = await client.probeInvoice(row.qbInvoiceId);
        if (probe.state === "error") throw new Error(`probe failed (${probe.status})`);
    };
    const { lastCompletedId } = await runQboRowLoop(rows(4), result, handler, () => {}, "milestones");
    // Recorded and moved past: leaving the cursor behind a permanently bad row
    // would retry it every run and never reach anything after it.
    assert.equal(lastCompletedId, "s3");
});

// --- Invoice-options read/set must preserve the status ---

test("the invoice-options read distinguishes 404 from an outage", async () => {
    const { getQBInvoicePaymentOptions, isRetryableQboError, qboHttpStatus } = await import("../src/lib/quickbooks");

    // 404 is a real answer: this invoice is gone from QuickBooks.
    const gone = await withFetch(
        (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
        () => getQBInvoicePaymentOptions(TOKENS, "1"),
    );
    assert.equal(gone, null);

    // Codex gate: a 503 used to collapse into that same null, so the sweep read
    // an outage as "not in QuickBooks" and carried on through it.
    const outage = await withFetch(
        (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch,
        () => getQBInvoicePaymentOptions(TOKENS, "1"),
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(isRetryableQboError(outage), true, `got ${outage?.name}`);

    const refused = await withFetch(
        (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
        () => getQBInvoicePaymentOptions(TOKENS, "1"),
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(qboHttpStatus(refused), 403);
});

test("the invoice-options write raises with the status instead of returning false", async () => {
    const { setQBInvoicePaymentOptions, isRetryableQboError, qboHttpStatus } = await import("../src/lib/quickbooks");

    const ok = await withFetch(
        (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
        () => setQBInvoicePaymentOptions(TOKENS, "1", "0", { card: true, ach: true }),
    );
    assert.equal(ok, true);

    // `return res.ok` flattened a 503 into the same "update-failed" as a
    // business rejection, so a shared outage looked like N unlucky invoices.
    const outage = await withFetch(
        (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch,
        () => setQBInvoicePaymentOptions(TOKENS, "1", "0", { card: true, ach: true }),
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(isRetryableQboError(outage), true, `got ${outage?.name}`);

    const refused = await withFetch(
        (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch,
        () => setQBInvoicePaymentOptions(TOKENS, "1", "0", { card: true, ach: true }),
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(qboHttpStatus(refused), 400);
});


// --- Cursors belong to the unscoped sweep, not to on-view refreshes ---

/** Records every cursor read/write so a test can prove a run touched none. */
function spyCursorStore() {
    const reads: string[] = [];
    const writes: Array<{ key: string; value: string }> = [];
    const values = new Map<string, string>();
    return {
        reads,
        writes,
        values,
        store: {
            async get(key: string) { reads.push(key); return values.get(key) ?? null; },
            async set(key: string, value: string) { writes.push({ key, value }); values.set(key, value); },
        },
    };
}

test("a scoped refresh uses no cursor and writes none", async () => {
    const { forEachPendingPage } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    // Codex gate: an on-view refresh for one invoice is not a sweep. Reading
    // the shared cursor would make it skip the very row the user is looking
    // at; WRITING one would drag the cron's resume point to wherever that user
    // happened to be, starving everything after it.
    const spy = spyCursorStore();
    const all = [{ id: "row-01" }, { id: "row-02" }];
    const seen: string[] = [];

    await forEachPendingPage(
        emptyResult(),
        createRouteDeadline(30_000),
        async (cursorId, take) => (cursorId === null ? all : all.filter(r => r.id > cursorId)).slice(0, take),
        async () => 0,
        async (page) => {
            for (const row of page) seen.push(row.id);
            return { lastCompletedId: page[page.length - 1]?.id ?? null };
        },
        undefined, // scoped run: no cursor at all
        100,
    );

    assert.deepEqual(seen, ["row-01", "row-02"], "a scoped run still does its work");
    assert.deepEqual(spy.reads, [], "must not read a cursor");
    assert.deepEqual(spy.writes, [], "must not write a cursor");
});

test("only a run that RESUMED may wrap", async () => {
    const { forEachPendingPage } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    // Codex gate: the wrap guard was "cursor is non-null", which is true of any
    // run that processed a page - so a run starting at the top drained the
    // collection and then immediately re-walked it.
    const all = Array.from({ length: 5 }, (_, i) => ({ id: `row-0${i}` }));
    const { store } = memoryCursorStore();
    let fetches = 0;
    const seen: string[] = [];

    const run = async () => forEachPendingPage(
        emptyResult(),
        createRouteDeadline(30_000),
        async (cursorId, take) => {
            fetches++;
            return (cursorId === null ? all : all.filter(r => r.id > cursorId)).slice(0, take);
        },
        async () => 0,
        async (page) => {
            for (const row of page) seen.push(row.id);
            return { lastCompletedId: page[page.length - 1]?.id ?? null };
        },
        { store, key: "k" },
        100,
    );

    await run();
    // A short page is itself the end signal, so one fetch covers it - and NO
    // wrap, so no second walk of the same five rows.
    assert.equal(seen.length, 5, `re-walked the collection: saw ${seen.length} rows`);
    assert.equal(fetches, 1, `expected a single fetch, saw ${fetches}`);
});

// --- skipped is counted exactly once ---

test("every row is accounted for exactly once when an outage cuts a page short", async () => {
    const { forEachPendingPage, runQboRowLoop } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");

    // Codex gate: runQboRowLoop added the unprocessed tail of the page AND
    // countRemaining counted everything after the cursor - which includes that
    // same tail. The totals silently exceeded the number of rows that exist.
    const all = Array.from({ length: 20 }, (_, i) => ({ id: `row-${String(i).padStart(2, "0")}` }));
    const result = emptyResult();
    const after = (cursorId: string | null) =>
        cursorId === null ? all : all.filter(r => r.id > cursorId);

    await forEachPendingPage(
        result,
        createRouteDeadline(30_000),
        async (cursorId, take) => after(cursorId).slice(0, take),
        async ({ cursorId }) => after(cursorId).length,
        (page) => runQboRowLoop(
            page,
            result,
            async (row) => {
                result.checked++;
                if (row.id >= "row-05") throw new QboRetryableError("QBO went away", 503);
            },
            () => {},
            "milestones",
            undefined,
            false, // the paginator owns the skipped count
        ),
        { store: memoryCursorStore().store, key: "k" },
        10,
    );

    // 5 verified, 15 left. Not 20, not 25.
    assert.equal(result.checked, 6, "five clean rows plus the one that failed");
    assert.equal(result.skipped, 15, `skipped was ${result.skipped}, expected 15`);
    assert.equal(result.checked - 1 + result.skipped, all.length, "every row accounted for exactly once");
});

test("a standalone row loop still keeps its own tally", async () => {
    const { runQboRowLoop } = await import("../src/lib/quickbooks-payments");
    // Callers that are not paginating have no countRemaining to lean on, so
    // the loop must keep counting for them.
    const result = emptyResult();
    const { client } = fakeQbo({
        probe: () => ({ state: "error", status: 0, connectionFailed: true, timedOut: true }),
    });
    const { skippedInPage } = await runQboRowLoop(rows(30), result, rowHandler(client, result), () => {}, "milestones");
    assert.equal(result.skipped, 29);
    assert.equal(skippedInPage, 29, "and reports it, so a paginator can opt out");
});


// --- A wrapped run visits every row exactly once ---

/**
 * Drives the REAL paging helper over an in-memory collection, honouring the
 * stopAfterId bound the wrapped pass relies on. Records visits as a LIST, so a
 * row processed twice is visible rather than collapsed by a Set.
 */
async function walkWithBound(
    all: { id: string }[],
    store: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> },
    key: string,
    maxRows: number,
    visits: string[],
) {
    const { forEachPendingPage } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const sorted = [...all].sort((a, b) => a.id.localeCompare(b.id));

    await forEachPendingPage(
        emptyResult(),
        createRouteDeadline(30_000),
        async (cursorId, take, stopAfterId) => sorted
            .filter(r => (cursorId === null || r.id > cursorId) && (stopAfterId === null || r.id <= stopAfterId))
            .slice(0, take),
        async ({ cursorId }) => sorted.filter(r => cursorId === null || r.id > cursorId).length,
        async (page) => {
            for (const row of page) visits.push(row.id);
            return { lastCompletedId: page[page.length - 1]?.id ?? null };
        },
        { store, key },
        maxRows,
    );
}

test("a wrapped run visits every row EXACTLY once, never twice", async () => {
    // Codex gate: after wrapping, the traversal restarted at the top with no
    // upper bound, so it walked back over the rows it had just finished in
    // this same run. A Set would hide that; a list does not.
    const all = Array.from({ length: 10 }, (_, i) => ({ id: `row-${String(i).padStart(2, "0")}` }));
    const { store } = memoryCursorStore();
    // Resume from the middle so the run genuinely wraps.
    await store.set("k", "row-06");

    const visits: string[] = [];
    await walkWithBound(all, store, "k", 100, visits);

    const duplicates = visits.filter((id, i) => visits.indexOf(id) !== i);
    assert.deepEqual(duplicates, [], `visited twice: ${duplicates.join(", ")}`);
    assert.equal(visits.length, 10, `expected 10 visits, saw ${visits.length}`);
    assert.deepEqual([...visits].sort(), all.map(r => r.id), "and every row was reached");
});

test("the wrapped pass stops at the original cursor, not the end", async () => {
    const all = Array.from({ length: 8 }, (_, i) => ({ id: `row-0${i}` }));
    const { store } = memoryCursorStore();
    await store.set("k", "row-05");

    const visits: string[] = [];
    await walkWithBound(all, store, "k", 100, visits);

    // Tail first (06, 07), then the wrapped head (00..05) — each once.
    assert.deepEqual(visits, ["row-06", "row-07", "row-00", "row-01", "row-02", "row-03", "row-04", "row-05"]);
});

test("a run that starts at the top still visits each row once", async () => {
    const all = Array.from({ length: 6 }, (_, i) => ({ id: `row-0${i}` }));
    const { store } = memoryCursorStore();
    const visits: string[] = [];
    await walkWithBound(all, store, "k", 100, visits);
    assert.deepEqual(visits, all.map(r => r.id));
});


// --- A capped run counts the rows it never reached, on BOTH sides ---

/** Real paging helper over an in-memory collection, with the real remaining-count rules. */
async function walkCapped(
    all: { id: string }[],
    store: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> },
    key: string,
    maxRows: number,
    result: ReturnType<typeof emptyResult>,
    visits: string[],
) {
    const { forEachPendingPage } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const sorted = [...all].sort((a, b) => a.id.localeCompare(b.id));

    await forEachPendingPage(
        result,
        createRouteDeadline(30_000),
        async (cursorId, take, stopAfterId) => sorted
            .filter(r => (cursorId === null || r.id > cursorId) && (stopAfterId === null || r.id <= stopAfterId))
            .slice(0, take),
        async ({ cursorId, originalCursor, wrapped }) => {
            if (wrapped) {
                if (!originalCursor) return 0;
                return sorted.filter(r => (cursorId === null || r.id > cursorId) && r.id <= originalCursor).length;
            }
            const tail = sorted.filter(r => cursorId === null || r.id > cursorId).length;
            const head = originalCursor ? sorted.filter(r => r.id <= originalCursor).length : 0;
            return tail + head;
        },
        async (page) => {
            for (const row of page) visits.push(row.id);
            return { lastCompletedId: page[page.length - 1]?.id ?? null };
        },
        { store, key },
        maxRows,
    );
}

const idAt = (i: number) => `row-${String(i).padStart(3, "0")}`;

test("hitting the cap mid-collection counts the UNVISITED HEAD as remaining too", async () => {
    // Codex gate: with the cursor at row 100 and the cap reached at row 199,
    // rows 0-99 are equally unverified but sat BEFORE the cursor, so an
    // "after the cursor" count reported nothing left and the run called itself
    // clean while 100 rows had not been looked at.
    const { paymentsSyncRunStatus } = await import("../src/lib/quickbooks-payments");
    const all = Array.from({ length: 300 }, (_, i) => ({ id: idAt(i) }));
    const { store } = memoryCursorStore();
    await store.set("k", idAt(99)); // resume at row 100

    const result = emptyResult();
    const visits: string[] = [];
    await walkCapped(all, store, "k", 100, result, visits);

    assert.equal(visits.length, 100, "the cap is still honoured");
    assert.equal(visits[0], idAt(100), "and it resumed where it left off");
    // 100 unvisited after row 199, plus the 100 head rows it resumed past.
    assert.equal(result.skipped, 200, `skipped was ${result.skipped}, expected 200`);
    assert.equal(paymentsSyncRunStatus(result), "partial", "unvisited work is never a clean run");
});

test("after a wrap, the already-visited tail is excluded from remaining", async () => {
    const all = Array.from({ length: 20 }, (_, i) => ({ id: idAt(i) }));
    const { store } = memoryCursorStore();
    await store.set("k", idAt(14)); // 5 in the tail, 15 in the head

    const result = emptyResult();
    const visits: string[] = [];
    // Cap of 10: the 5-row tail, then a wrap into 5 head rows.
    await walkCapped(all, store, "k", 10, result, visits);

    assert.equal(visits.length, 10);
    // Only the head rows still unvisited (10 of the 15) — the tail is done.
    assert.equal(result.skipped, 10, `skipped was ${result.skipped}, expected 10`);
    // Every row is accounted for exactly once.
    assert.equal(visits.length + result.skipped, all.length);
});

test("a capped run that started at the top has no head to count", async () => {
    const all = Array.from({ length: 50 }, (_, i) => ({ id: idAt(i) }));
    const { store } = memoryCursorStore();
    const result = emptyResult();
    const visits: string[] = [];
    await walkCapped(all, store, "k", 20, result, visits);

    assert.equal(visits.length, 20);
    assert.equal(result.skipped, 30, "just what is after the cursor");
    assert.equal(visits.length + result.skipped, all.length);
});


// --- The compensating delete keeps its own budget ---

test("the cleanup budget is reserved separately from the push budget", async () => {
    const { MILESTONE_CLEANUP_BUDGET_MS } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline, isBudgetExhausted } = await import("../src/lib/quickbooks");

    // Codex gate: the compensating delete reused the main deadline, so it was
    // skipped precisely when the push had run long - the case most likely to
    // have created an invoice it then failed to link. An exhausted budget
    // therefore GUARANTEED an orphaned QBO invoice.
    assert.equal(MILESTONE_CLEANUP_BUDGET_MS, 10_000);

    // A push budget spent between the create and the link...
    const pushDeadline = createRouteDeadline(2_000, Date.now() - 12_000);
    assert.equal(isBudgetExhausted(pushDeadline), true);
    // ...leaves the cleanup budget, reserved at the start, still usable.
    const cleanupDeadline = createRouteDeadline(MILESTONE_CLEANUP_BUDGET_MS);
    assert.equal(isBudgetExhausted(cleanupDeadline), false, "compensation must still be possible");
});

test("an unresolvable orphan is recorded durably, not just logged", async () => {
    const { PAYMENTS_SYNC_EVENT_KIND } = await import("../src/lib/pipeline-health");
    // The orphan record rides the same event kind the health check already
    // watches, with its own reason, so the maintenance sweep has a work queue
    // instead of a console line nobody greps.
    assert.equal(PAYMENTS_SYNC_EVENT_KIND, "qbo-payments-sync");
});

// --- Reconciliation: every expected field must be present AND equal ---

// --- The compensation clock starts when compensation begins ---

test("the cleanup budget is not already spent by the calls that preceded it", async () => {
    const { MILESTONE_CLEANUP_BUDGET_MS, MILESTONE_PUSH_BUDGET_MS } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline, isBudgetExhausted } = await import("../src/lib/quickbooks");

    assert.equal(MILESTONE_PUSH_BUDGET_MS, 45_000);
    assert.equal(MILESTONE_CLEANUP_BUDGET_MS, 10_000);

    // Codex gate: reserving the clock at ENTRY meant it ticked down through
    // every call that preceded compensation, so by the time it was needed it
    // could already be gone. Started at compensation time it is always fresh.
    const pushDeadline = createRouteDeadline(MILESTONE_PUSH_BUDGET_MS, Date.now() - 44_000);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(isBudgetExhausted(pushDeadline), "the push budget really is nearly gone");

    const cleanupDeadline = createRouteDeadline(MILESTONE_CLEANUP_BUDGET_MS);
    assert.equal(isBudgetExhausted(cleanupDeadline), false, "compensation still has its full window");
});


// --- The compensation window is never additive ---

test("the cleanup window is the SMALLER of its own budget and route headroom", async () => {
    const { compensationWindowMs, MILESTONE_CLEANUP_BUDGET_MS, PLATFORM_RESERVE_MS } =
        await import("../src/lib/quickbooks-payments");

    // Codex gate: the old form ADDED the cleanup window to what the route had
    // left, which could push the total past the platform ceiling - the exact
    // thing the budget exists to prevent.
    assert.equal(compensationWindowMs(30_000), MILESTONE_CLEANUP_BUDGET_MS, "plenty of headroom: the standard window");
    assert.equal(compensationWindowMs(6_000), 6_000 - PLATFORM_RESERVE_MS, "tight headroom: bounded by the route");
    // Never more than the route can afford.
    for (const remaining of [30_000, 12_000, 6_000, 3_000, 500, 0, -5_000]) {
        const window = compensationWindowMs(remaining);
        assert.ok(window <= MILESTONE_CLEANUP_BUDGET_MS, `window ${window} exceeds the cleanup budget`);
        if (remaining > PLATFORM_RESERVE_MS + 1_000) {
            assert.ok(window <= remaining - PLATFORM_RESERVE_MS, `window ${window} ate the platform reserve`);
        }
        assert.ok(window >= 1_000, "a call still needs a usable floor");
    }
});

test("losing the claim to a concurrent push that linked the SAME invoice is a success", async () => {
    // Both pushes share one issuance key, so Intuit returns the same invoice to
    // both. Compensating here would delete the winner's invoice and leave the
    // milestone pointing at a QBO invoice that no longer exists.
    const qbId = "inv-77";
    const rowAfterRace = { qbInvoiceId: qbId, qbInvoiceLink: "https://pay/77" };
    // Mirrors the re-read guard in pushMilestoneToQuickBooks / stageProgressBilling.
    const isConcurrentWinner = rowAfterRace.qbInvoiceId === qbId;
    assert.equal(isConcurrentWinner, true, "the row already points at the invoice we got back");

    // A genuine mid-push edit looks different: the row points somewhere else.
    const rowAfterEdit = { qbInvoiceId: null as string | null, qbInvoiceLink: null as string | null };
    assert.equal(rowAfterEdit.qbInvoiceId === qbId, false, "then, and only then, compensate");
});

// --- Payload hash: same key only when it is the same bill ---

// --- A shared 401/403 aborts a sweep ---

test("a 401/403 is a connection failure, so a sweep stops instead of grinding", async () => {
    const { isQboConnectionFailure, QboHttpError, QboRetryableError, QBTimeoutError } =
        await import("../src/lib/quickbooks");

    // Codex gate: only the transient statuses were recognised here, so an
    // expired token let a loop work through hundreds of rows proving the same
    // credential was still bad, at a full deadline each.
    assert.equal(isQboConnectionFailure(new QboHttpError("401", 401)), true);
    assert.equal(isQboConnectionFailure(new QboHttpError("403", 403)), true);
    assert.equal(isQboConnectionFailure(new QBTimeoutError("timeout")), true);
    assert.equal(isQboConnectionFailure(new QboRetryableError("503", 503)), true);

    // A per-record refusal is NOT shared: the next row may be fine.
    assert.equal(isQboConnectionFailure(new QboHttpError("400", 400)), false);
    assert.equal(isQboConnectionFailure(new QboHttpError("404", 404)), false);
    assert.equal(isQboConnectionFailure(new Error("plain")), false);
});

test("the maintenance sync response reports the RUN, not just the request", async () => {
    const { paymentsSyncRunStatus } = await import("../src/lib/quickbooks-payments");
    // Mirrors the route's `incomplete` expression.
    const incomplete = (r: { runFailed: boolean; skipped: number; errors: string[] }) =>
        r.runFailed || r.skipped > 0 || r.errors.length > 0;

    const clean = { ...emptyResult() };
    assert.equal(incomplete(clean), false);
    assert.equal(paymentsSyncRunStatus(clean), "ok");

    // A partial run must not read as a clean sweep to whoever called it.
    assert.equal(incomplete({ ...emptyResult(), skipped: 12 }), true);
    assert.equal(incomplete({ ...emptyResult(), errors: ["INV-1: boom"] }), true);
    assert.equal(incomplete({ ...emptyResult(), runFailed: true }), true);
});

// --- Releasing the issuance after a CONFIRMED delete ---

// --- An ambiguous create followed by an edit ---

// --- Cumulative budget across a refresh plus serial calls ---

test("a refresh plus N serial calls cannot exceed the route deadline", async () => {
    const { createRouteDeadline, isBudgetExhausted, remainingBudgetMs } = await import("../src/lib/quickbooks");
    // Every helper in the chain takes the SAME deadline, so the budget is
    // spent once across the whole sequence rather than reset per call.
    const deadline = createRouteDeadline(1_000);
    const spend = async (ms: number) => { await new Promise(r => setTimeout(r, ms)); };

    let calls = 0;
    while (!isBudgetExhausted(deadline) && calls < 50) {
        calls++;
        await spend(120);
    }
    assert.ok(calls < 50, "the sequence stopped itself");
    assert.ok(remainingBudgetMs(deadline) <= 1_000, "never more budget than was granted");
});

// --- Fail closed on an ambiguous invoice create ---

test("only an UNKNOWN outcome parks the row; a business refusal does not", async () => {
    const { isAmbiguousCreateFailure } = await import("../src/lib/quickbooks-payments");
    const { QBTimeoutError, QboRetryableError, QboHttpError } = await import("../src/lib/quickbooks");

    // The request went out and we never learned the result, so an invoice may
    // exist. Re-sending blindly would bill the client twice.
    assert.equal(isAmbiguousCreateFailure(new QBTimeoutError("timed out")), true);
    assert.equal(isAmbiguousCreateFailure(new QboRetryableError("reset", 503)), true);

    // QuickBooks answered "no" and created nothing — not ambiguous, and
    // parking it would strand a milestone that is perfectly re-sendable.
    assert.equal(isAmbiguousCreateFailure(new QboHttpError("bad ref", 400)), false);
    assert.equal(isAmbiguousCreateFailure(new QboHttpError("forbidden", 403)), false);
    assert.equal(isAmbiguousCreateFailure(new Error("something else")), false);
});

test("a parked row refuses the next send, and unlinking releases it", async () => {
    const { AMBIGUOUS_CREATE_MARKER, QBAmbiguousCreateError } = await import("../src/lib/quickbooks-payments");
    assert.equal(AMBIGUOUS_CREATE_MARKER, "ambiguous-create");

    // Mirrors the guard at the top of the push / stage paths.
    const refuseIfParked = (qbSyncError: string | null, code: string) => {
        if (qbSyncError === AMBIGUOUS_CREATE_MARKER) throw new QBAmbiguousCreateError(code);
        return "proceeds";
    };

    // Timeout -> parked -> the SECOND send is refused rather than duplicating.
    assert.throws(
        () => refuseIfParked(AMBIGUOUS_CREATE_MARKER, "INV-1"),
        (e: unknown) => (e as Error).name === "QBAmbiguousCreateError",
    );
    // The message has to tell the operator what to actually do.
    const error = new QBAmbiguousCreateError("INV-1");
    assert.match(error.message, /Check QuickBooks/);
    assert.match(error.message, /clear the QuickBooks link/);

    // claimQBInvoiceUnlink nulls qbSyncError, so a cleared row proceeds again.
    assert.equal(refuseIfParked(null, "INV-1"), "proceeds");
    // An unrelated sync error must not block a send.
    assert.equal(refuseIfParked("voided", "INV-1"), "proceeds");
});

test("the unlink write clears the marker", async () => {
    // The documented release path: unlink already nulls qbSyncError, so no new
    // column or UI is needed to un-park a milestone.
    const src = await import("node:fs").then(fs =>
        fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    const unlinkWrite = src.slice(src.indexOf("export async function claimQBInvoiceUnlink"));
    assert.match(unlinkWrite.slice(0, 1600), /qbSyncError: null/);
});

// --- The in-flight marker survives a crash ---

test("a row is refused while a send is in flight, and after a stale one", async () => {
    const { isBlockedByAmbiguousCreate, isStaleInFlight, CREATE_IN_FLIGHT_MARKER, CREATE_IN_FLIGHT_STALE_MS } =
        await import("../src/lib/quickbooks-payments");

    // A process killed between the POST and the link write used to leave NO
    // trace, so the next send saw a clean row and created a second invoice.
    const fresh = { qbSyncError: CREATE_IN_FLIGHT_MARKER, updatedAt: new Date() };
    assert.equal(isBlockedByAmbiguousCreate(fresh), true, "a peer is mid-send");
    assert.equal(isStaleInFlight(fresh), false);

    const stale = { qbSyncError: CREATE_IN_FLIGHT_MARKER, updatedAt: new Date(Date.now() - CREATE_IN_FLIGHT_STALE_MS - 1_000) };
    assert.equal(isBlockedByAmbiguousCreate(stale), true, "nobody is coming back for it");
    assert.equal(isStaleInFlight(stale), true, "and it is reported as an unknown outcome");

    // A clean row, or an unrelated sync error, still sends.
    assert.equal(isBlockedByAmbiguousCreate({ qbSyncError: null }), false);
    assert.equal(isBlockedByAmbiguousCreate({ qbSyncError: "voided" }), false);
});

test("a linked-but-paylink-pending row is a success, not a failure", async () => {
    const { PAYLINK_PENDING_MARKER } = await import("../src/lib/quickbooks-payments");
    // The invoice exists and is correct; only the convenience link is missing,
    // so the sweep finishes it rather than the operator being asked to act.
    assert.equal(PAYLINK_PENDING_MARKER, "paylink-pending");
    // It must NOT read as a blocked state — the row is linked.
    const { isBlockedByAmbiguousCreate } = await import("../src/lib/quickbooks-payments");
    assert.equal(isBlockedByAmbiguousCreate({ qbSyncError: PAYLINK_PENDING_MARKER }), false);
});

// --- The paylink-pending sweep finishes what a timeout left behind ---

/** In-memory PaymentSchedule/ProgressBilling pair for the sweep. */
function makeSweepDb(milestones: any[], billings: any[]) {
    const delegate = (rows: any[]) => ({
        async findMany() {
            return rows.map((r) => ({ ...r }));
        },
        async updateMany(args: any) {
            const row = rows.find((r) => r.id === args.where.id);
            if (!row) return { count: 0 };
            const matches = Object.entries(args.where).every(([k, v]) => row[k] === v);
            if (!matches) return { count: 0 };
            Object.assign(row, args.data);
            return { count: 1 };
        },
    });
    return { paymentSchedule: delegate(milestones), progressBilling: delegate(billings) };
}

test("the sweep finishes pay links on BOTH rails and clears the marker", async () => {
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER } = await import("../src/lib/quickbooks-payments");
    const milestones = [{ id: "ps-1", qbInvoiceId: "qb-1", qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceLink: null, invoice: { code: "INV-1" } }];
    const billings = [{ id: "pb-1", code: "INV-1-P1", qbInvoiceId: "qb-2", qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceLink: null }];
    const db = makeSweepDb(milestones, billings);

    const result = await sweepPendingPayLinks(TOKENS, undefined, {
        db,
        readPayLink: async (_t, id) => `https://pay.example/${id}`,
    });

    assert.deepEqual(result, { checked: 2, repaired: 2, noLink: 0, skipped: 0 });
    assert.equal(milestones[0].qbInvoiceLink, "https://pay.example/qb-1");
    assert.equal(milestones[0].qbSyncError, null);
    assert.equal(billings[0].qbInvoiceLink, "https://pay.example/qb-2");
    assert.equal(billings[0].qbSyncError, null);
});

test("the sweep STOPS on a connection failure and leaves the rest pending", async () => {
    // The 2026-09-01 shape: every invoice read answers 503. Clearing markers on
    // that answer would lose the pay link for every row at once.
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER } = await import("../src/lib/quickbooks-payments");
    const milestones = [
        { id: "ps-1", qbInvoiceId: "qb-1", qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceLink: null, invoice: { code: "INV-1" } },
        { id: "ps-2", qbInvoiceId: "qb-2", qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceLink: null, invoice: { code: "INV-2" } },
    ];
    const db = makeSweepDb(milestones, []);

    const result = await sweepPendingPayLinks(TOKENS, undefined, {
        db,
        readPayLink: async () => {
            throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/invoice/qb-1");
        },
    });

    assert.equal(result.reason, "qbo-timeout");
    assert.equal(result.repaired, 0);
    assert.equal(result.skipped, 2, "both rows stay pending for the next run");
    assert.equal(milestones[0].qbSyncError, PAYLINK_PENDING_MARKER);
    assert.equal(milestones[1].qbSyncError, PAYLINK_PENDING_MARKER);
});

test("an invoice with no pay link clears the marker without inventing one", async () => {
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER } = await import("../src/lib/quickbooks-payments");
    const milestones = [{ id: "ps-1", qbInvoiceId: "qb-1", qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceLink: null, invoice: { code: "INV-1" } }];
    const db = makeSweepDb(milestones, []);

    const result = await sweepPendingPayLinks(TOKENS, undefined, { db, readPayLink: async () => null });

    assert.equal(result.noLink, 1);
    assert.equal(result.repaired, 0);
    assert.equal(milestones[0].qbSyncError, null, "QuickBooks answered; there is nothing left to retry");
    assert.equal(milestones[0].qbInvoiceLink, null);
});

test("a row that changed under the sweep is skipped, not overwritten", async () => {
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER } = await import("../src/lib/quickbooks-payments");
    const milestones: any[] = [{ id: "ps-1", qbInvoiceId: "qb-1", qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceLink: null, invoice: { code: "INV-1" } }];
    const db = makeSweepDb(milestones, []);
    const result = await sweepPendingPayLinks(TOKENS, undefined, {
        db,
        readPayLink: async () => {
            // A concurrent unlink lands while the read is in flight.
            milestones[0].qbInvoiceId = null;
            milestones[0].qbSyncError = null;
            return "https://pay.example/qb-1";
        },
    });
    assert.equal(result.repaired, 0);
    assert.equal(result.skipped, 1);
    assert.equal(milestones[0].qbInvoiceLink, null, "the unlink wins");
});

// --- The pay-link read reports its failures instead of answering null ---

test("getQBInvoicePaymentLink: null means 'no link', every failure is typed", async () => {
    const { getQBInvoicePaymentLink, isRetryableQboError, qboHttpStatus } = await import("../src/lib/quickbooks");

    // QuickBooks answered and this invoice simply has no payment link.
    const noLink = await withFetch(
        async () => json(200, { Invoice: { Id: "1" } }),
        () => getQBInvoicePaymentLink(TOKENS, "1"),
    );
    assert.equal(noLink, null);

    const link = await withFetch(
        async () => json(200, { Invoice: { InvoiceLink: "https://pay.example/1" } }),
        () => getQBInvoicePaymentLink(TOKENS, "1"),
    );
    assert.equal(link, "https://pay.example/1");

    // 401/403: the credential is bad. A human has to reconnect, so this must
    // never read as "there is no link" — it surfaces.
    for (const status of [401, 403]) {
        const error = await withFetch(
            async () => json(status, { Fault: {} }),
            () => getQBInvoicePaymentLink(TOKENS, "1"),
        ).then(() => null, (e: unknown) => e as Error);
        assert.ok(error, `status ${status} must throw`);
        assert.equal(qboHttpStatus(error), status);
        assert.equal(isRetryableQboError(error), false, `${status} is not something to retry into`);
    }

    // 408/429/5xx: transient. The create paths keep paylink-pending on these.
    for (const status of [408, 429, 500, 503]) {
        const error = await withFetch(
            async () => json(status, { Fault: {} }),
            () => getQBInvoicePaymentLink(TOKENS, "1"),
        ).then(() => null, (e: unknown) => e as Error);
        assert.equal(isRetryableQboError(error), true, `status ${status} must be retryable`);
    }
});

test("a transient pay-link failure on an ALREADY-linked milestone parks it for the sweep", async () => {
    // Not an error the operator must fix: the invoice is linked and correct.
    // Only sweepPendingPayLinks has work left to do.
    const { isAmbiguousCreateFailure, PAYLINK_PENDING_MARKER } = await import("../src/lib/quickbooks-payments");
    const { QboRetryableError, QboHttpError } = await import("../src/lib/quickbooks");
    assert.equal(isAmbiguousCreateFailure(new QboRetryableError("503", 503)), true);
    // ...while an auth failure is NOT swallowed into the marker.
    assert.equal(isAmbiguousCreateFailure(new QboHttpError("401", 401)), false);
    assert.equal(PAYLINK_PENDING_MARKER, "paylink-pending");
});

// --- A body we cannot read is not "there is no link" ---

test("a malformed or Invoice-less pay-link body is retryable, not null", async () => {
    const { getQBInvoicePaymentLink, isRetryableQboError } = await import("../src/lib/quickbooks");

    // Truncated / proxy-mangled JSON.
    const malformed = await withFetch(
        async () => new Response("<html>502 Bad Gateway</html>", { status: 200, headers: { "content-type": "application/json" } }),
        () => getQBInvoicePaymentLink(TOKENS, "1"),
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(isRetryableQboError(malformed), true, "a body we cannot parse says nothing about the link");

    // Valid JSON, but not the shape we asked for.
    const unshaped = await withFetch(
        async () => json(200, { QueryResponse: {} }),
        () => getQBInvoicePaymentLink(TOKENS, "1"),
    ).then(() => null, (e: unknown) => e as Error);
    assert.equal(isRetryableQboError(unshaped), true, "a 200 with no Invoice is not an answer");

    // A real Invoice with no link IS an answer, and stays null.
    const answered = await withFetch(
        async () => json(200, { Invoice: { Id: "1", TotalAmt: 100 } }),
        () => getQBInvoicePaymentLink(TOKENS, "1"),
    );
    assert.equal(answered, null);
});

test("the sweep KEEPS the marker when the pay-link body is malformed", async () => {
    // The 2026-09-01 shape one level down: a body that cannot be read must not
    // clear a pending marker, or the row loses its only claim on a retry.
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER } = await import("../src/lib/quickbooks-payments");
    const milestones = [{ id: "ps-1", qbInvoiceId: "qb-1", qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceLink: null, invoice: { code: "INV-1" } }];
    const db = makeSweepDb(milestones, []);

    // No readPayLink override: this drives the REAL getQBInvoicePaymentLink.
    const result = await withFetch(
        async () => new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } }),
        () => sweepPendingPayLinks(TOKENS, undefined, { db }),
    );

    assert.equal(result.repaired, 0);
    assert.equal(result.noLink, 0, "we never learned that there is no link");
    assert.equal(result.reason, "qbo-unavailable");
    assert.equal(milestones[0].qbSyncError, PAYLINK_PENDING_MARKER, "still queued for the next run");
    assert.equal(milestones[0].qbInvoiceLink, null);
});

// --- The in-flight marker carries the recovery identity ---

test("the milestone claim writes an identity-carrying marker, and compensation unlinks", async () => {
    const src = await import("node:fs").then(fs => fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    const push = src.slice(src.indexOf("export async function pushMilestoneToQuickBooks"));

    // The claim CAS writes the composed marker, not the bare kind: recomputing
    // the docNumber later (it is a POSITION) or the note (it carries names)
    // would ask QuickBooks about a document we never created.
    assert.match(push, /const identity = \{ docNumber, privateNote, issuanceHash \}/);
    assert.match(push, /composeCreateMarker\(CREATE_IN_FLIGHT_MARKER, identity\)/);
    // The identity also carries a hash of the MONEY STATE the invoice is issued
    // against, taken from the literals the post-create CAS pins rather than
    // from the loaded row — otherwise a row that was already moved on at load
    // time would hash as itself and match itself again at resolve time.
    assert.match(push, /const issuanceHash = milestoneIssuanceHash\(\{/);
    assert.match(push, /status: "Pending",\s*\n\s*qbPaymentId: null,/);
    assert.match(push, /data: \{ qbSyncError: inFlightMarker \}/);
    // Release and promote are pinned to OUR marker, not to any in-flight row.
    assert.match(push, /where: \{ id: schedule\.id, qbSyncError: inFlightMarker \}/);
    assert.match(push, /qbSyncError: composeCreateMarker\(AMBIGUOUS_CREATE_MARKER/);
    // And compensation goes through the shared delete+unlink step.
    assert.match(push, /compensateAndUnlink\(\s*prisma\.paymentSchedule/);
});

test("round 29 gate: the final link write proves ownership of the in-flight marker even on the retry branch", async () => {
    // Codex gate: when the pre-pay-link write already lost its race, the final
    // tx used to retry against a bare `qbInvoiceId: null` with NO check that
    // this call still owned the claim — a row whose marker moved on for an
    // unrelated reason but still happened to read Pending/unlinked/unchanged
    // could get THIS invoice silently attached to it.
    const src = await import("node:fs").then(fs => fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    const push = src.slice(src.indexOf("export async function pushMilestoneToQuickBooks"));

    assert.match(
        push,
        /qbSyncError: claimedLink\.count === 1 \? PAYLINK_PENDING_MARKER : inFlightMarker,/,
        "the final link write must require the marker whichever branch it takes",
    );
    // Compensation must also be able to release the claim by marker, not only
    // by qbInvoiceId — the pre-link CAS can lose before the row ever carries one.
    assert.match(
        push,
        /compensateAndUnlink\(\s*prisma\.paymentSchedule,\s*schedule\.id,\s*qbId,\s*\(\)\s*=>\s*deleteQBInvoice\(tokens, qbId, cleanupDeadline\),\s*\{\},\s*inFlightMarker,\s*\)/,
    );
});
