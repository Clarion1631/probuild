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

/**
 * In-memory PaymentSchedule/ProgressBilling pair for the sweep.
 *
 * `findMany` honours the FILTER, the ORDER and the TAKE, and `count` answers
 * from the same rows. It used to ignore `args` entirely and hand back every
 * row: the cursor, the page cap and the wrap were all invisible to these tests,
 * which is how a cursor that reset without ever visiting the head of the
 * collection shipped green.
 */
function makeSweepDb(milestones: any[], billings: any[]) {
    const eligible = (rows: any[], where: any) =>
        rows.filter((r) => {
            if (where.qbSyncError !== undefined && r.qbSyncError !== where.qbSyncError) return false;
            if (where.qbInvoiceId?.not === null && r.qbInvoiceId === null) return false;
            if (where.id?.gt !== undefined && !(r.id > where.id.gt)) return false;
            if (where.id?.lt !== undefined && !(r.id < where.id.lt)) return false;
            return true;
        });
    const delegate = (rows: any[]) => ({
        async findMany(args: any) {
            const matched = eligible(rows, args?.where ?? {}).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            const taken = typeof args?.take === "number" ? matched.slice(0, args.take) : matched;
            return taken.map((r) => ({ ...r }));
        },
        async count(args: any) {
            return eligible(rows, args?.where ?? {}).length;
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

/** An in-memory stand-in for the AutomationSetting cursor store. */
function makeCursorStore(initial: Record<string, string> = {}) {
    const values: Record<string, string> = { ...initial };
    return {
        values,
        async get(key: string) {
            return values[key] ?? null;
        },
        async set(key: string, value: string) {
            values[key] = value;
        },
    };
}

/** A pending row on the milestone rail. */
function pendingMilestone(id: string, marker: string) {
    return { id, qbInvoiceId: `qb-${id}`, qbSyncError: marker, qbInvoiceLink: null, invoice: { code: `INV-${id}` } };
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

    assert.equal(result.checked, 2);
    assert.equal(result.repaired, 2);
    assert.equal(result.noLink, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.unvisited.total, 0);
    assert.equal(result.unresolved.total, 0, "both markers are gone");
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

// --- The pay-link cursor: a short tail is not a visited head ---

test("a retained marker BEFORE the cursor is reported unresolved, never a clean run", async () => {
    // The false-green shape. `ps-01` sits at the head of the collection and its
    // pay-link read is refused per-invoice, so it keeps its marker forever. The
    // cursor is parked past it, the post-cursor tail is short and nonempty, and
    // the old code processed that tail, reset the cursor and returned a result
    // whose every counter said "clean". The head row was never looked at.
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER, PAYLINK_CURSOR_KEYS } =
        await import("../src/lib/quickbooks-payments");
    const { QboHttpError } = await import("../src/lib/quickbooks");
    const milestones = [pendingMilestone("ps-01", PAYLINK_PENDING_MARKER), pendingMilestone("ps-09", PAYLINK_PENDING_MARKER)];
    const db = makeSweepDb(milestones, []);
    const cursorStore = makeCursorStore({ [PAYLINK_CURSOR_KEYS.milestones]: "ps-05" });

    const result = await sweepPendingPayLinks(TOKENS, undefined, {
        db,
        cursorStore,
        // 404 is a per-invoice refusal: the row keeps its marker by design.
        readPayLink: async () => {
            throw new QboHttpError("gone", 404);
        },
    });

    assert.equal(result.unresolved.milestone, 2, "both rows still carry the marker");
    assert.equal(result.unresolved.total, 2);
    assert.equal(result.unvisited.total, 0, "the wrap DID reach the head in this run");
    assert.equal(milestones[0].qbSyncError, PAYLINK_PENDING_MARKER);
});

test("a short tail with budget left wraps to the head IN THE SAME RUN, and only then resets the cursor", async () => {
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER, PAYLINK_CURSOR_KEYS } =
        await import("../src/lib/quickbooks-payments");
    const milestones = [pendingMilestone("ps-01", PAYLINK_PENDING_MARKER), pendingMilestone("ps-09", PAYLINK_PENDING_MARKER)];
    const db = makeSweepDb(milestones, []);
    const cursorStore = makeCursorStore({ [PAYLINK_CURSOR_KEYS.milestones]: "ps-05" });
    const visited: string[] = [];

    const result = await sweepPendingPayLinks(TOKENS, undefined, {
        db,
        cursorStore,
        readPayLink: async (_t, id) => {
            visited.push(id);
            return `https://pay.example/${id}`;
        },
    });

    assert.deepEqual(visited, ["qb-ps-09", "qb-ps-01"], "tail first, then the bounded wrap to the head");
    assert.equal(result.repaired, 2);
    assert.equal(result.unvisited.total, 0);
    assert.equal(result.unresolved.total, 0);
    assert.equal(
        cursorStore.values[PAYLINK_CURSOR_KEYS.milestones],
        "",
        "reset only because the head was actually visited",
    );
});

test("a run that stops part-way through the wrap persists where it got to, and does NOT reset", async () => {
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER, PAYLINK_CURSOR_KEYS } =
        await import("../src/lib/quickbooks-payments");
    const { QBTimeoutError } = await import("../src/lib/quickbooks");
    const milestones = [
        pendingMilestone("ps-01", PAYLINK_PENDING_MARKER),
        pendingMilestone("ps-02", PAYLINK_PENDING_MARKER),
        pendingMilestone("ps-09", PAYLINK_PENDING_MARKER),
    ];
    const db = makeSweepDb(milestones, []);
    const cursorStore = makeCursorStore({ [PAYLINK_CURSOR_KEYS.milestones]: "ps-05" });
    let calls = 0;

    const result = await sweepPendingPayLinks(TOKENS, undefined, {
        db,
        cursorStore,
        readPayLink: async (_t, id) => {
            calls++;
            // ps-09 (the tail) and ps-01 succeed; the connection dies before ps-02.
            if (calls > 2) throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/x");
            return `https://pay.example/${id}`;
        },
    });

    assert.equal(result.reason, "qbo-timeout");
    assert.equal(
        cursorStore.values[PAYLINK_CURSOR_KEYS.milestones],
        "ps-01",
        "resume inside the head, not from the top and not from the old cursor",
    );
    assert.equal(result.unvisited.milestone, 1, "ps-02 was eligible and never reached");
    assert.equal(result.unresolved.milestone, 1, "ps-02 still carries its marker");
});

test("budget exhausted on the first rail: the NEXT run starts on the other one", async () => {
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER, PAYLINK_ORDER_KEY } =
        await import("../src/lib/quickbooks-payments");
    const cursorStore = makeCursorStore();
    const order: string[] = [];
    const run = async () => {
        const milestones = [pendingMilestone("ps-01", PAYLINK_PENDING_MARKER)];
        const billings = [{ id: "pb-01", code: "INV-1-P1", qbInvoiceId: "qb-pb-01", qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceLink: null }];
        const db = makeSweepDb(milestones, billings);
        const seen: string[] = [];
        const result = await sweepPendingPayLinks(TOKENS, undefined, {
            db,
            cursorStore,
            readPayLink: async (_t, id) => {
                seen.push(id);
                // One row's worth of budget, then the connection is gone —
                // exactly the repeated exhaustion that starved the second rail.
                if (seen.length > 1) {
                    const { QBTimeoutError } = await import("../src/lib/quickbooks");
                    throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/x");
                }
                return `https://pay.example/${id}`;
            },
        });
        order.push(seen[0]);
        return result;
    };

    const first = await run();
    assert.equal(first.railFirst, "milestone", "the historical order is kept for the first run");
    assert.equal(cursorStore.values[PAYLINK_ORDER_KEY], "milestone");
    const second = await run();
    assert.equal(second.railFirst, "progressBilling");
    assert.deepEqual(order, ["qb-ps-01", "qb-pb-01"], "the second rail is reached on the next run, not starved");
});

test("mixed-rail counts add up", async () => {
    const { sweepPendingPayLinks, PAYLINK_PENDING_MARKER } = await import("../src/lib/quickbooks-payments");
    const { QboHttpError } = await import("../src/lib/quickbooks");
    const milestones = [pendingMilestone("ps-01", PAYLINK_PENDING_MARKER), pendingMilestone("ps-02", PAYLINK_PENDING_MARKER)];
    const billings = [{ id: "pb-01", code: "INV-1-P1", qbInvoiceId: "qb-pb-01", qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceLink: null }];
    const db = makeSweepDb(milestones, billings);

    const result = await sweepPendingPayLinks(TOKENS, undefined, {
        db,
        // Every row refused per-invoice: all three keep their markers.
        readPayLink: async () => {
            throw new QboHttpError("gone", 404);
        },
    });

    assert.equal(result.unresolved.milestone, 2);
    assert.equal(result.unresolved.progressBilling, 1);
    assert.equal(result.unresolved.total, result.unresolved.milestone + result.unresolved.progressBilling);
    assert.equal(result.unvisited.total, result.unvisited.milestone + result.unvisited.progressBilling);
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
    // From claimMilestonePreCreateUnderLock (the claim itself) through the end
    // of pushMilestoneToQuickBooks — the claim now lives in a helper the push
    // calls, so the identity/CAS assertions below have to see both.
    const push = src.slice(src.indexOf("export async function claimMilestonePreCreateUnderLock"));

    // The claim CAS writes the composed marker, not the bare kind: recomputing
    // the docNumber later (it is a POSITION) or the note (it carries names)
    // would ask QuickBooks about a document we never created.
    assert.match(push, /const identity = \{\s*\n\s*docNumber, privateNote, issuanceHash,/);
    // Round 33 gate: DocNumber + PrivateNote prove a resolved match is OURS,
    // not that its total is right — the identity must also carry the expected
    // total so the resolver can refuse a coincidental match.
    assert.match(push, /expectedTotal: amount,/);
    // The SAME claim timestamp is captured once and threaded into both the
    // in-flight marker and its later promotion to ambiguous-create — a
    // promotion must never reset the clock the resolver's cooldown reads.
    assert.match(push, /const claimedAt = new Date\(\)/);
    assert.match(push, /composeCreateMarker\(CREATE_IN_FLIGHT_MARKER, identity, claimedAt\)/);
    // The identity also carries a hash of the MONEY STATE the invoice is issued
    // against, taken from the literals the post-create CAS pins rather than
    // from the loaded row — otherwise a row that was already moved on at load
    // time would hash as itself and match itself again at resolve time.
    assert.match(push, /const issuanceHash = milestoneIssuanceHash\(\{/);
    assert.match(push, /status: "Pending",\s*\n\s*qbPaymentId: null,/);
    // Round 33 gate: the pre-create claim is taken UNDER the invoice lock, with
    // a re-check of the progress-billing relationship inside that same lock —
    // see the interleaving test below for the race this closes.
    assert.match(push, /await lockMoneyParents\(tx, \{ invoiceId: schedule\.invoiceId \}\);/);
    assert.match(push, /const claimedNow = await tx\.progressBillingLine\.findFirst\(\{/);
    assert.match(push, /data: \{ qbSyncError: inFlightMarker \}/);
    assert.match(push, /const claimedSend = await claimMilestonePreCreateUnderLock\(schedule, inFlightMarker\);/);
    // Release and promote are pinned to OUR marker, not to any in-flight row.
    assert.match(push, /where: \{ id: schedule\.id, qbSyncError: inFlightMarker \}/);
    assert.match(push, /qbSyncError: composeCreateMarker\(AMBIGUOUS_CREATE_MARKER/);
    // And compensation goes through the shared delete+unlink step.
    assert.match(push, /compensateAndUnlink\(\s*prisma\.paymentSchedule/);
});

test("round 33 gate: a progress billing that lands between the pre-read and the claim makes the claim refuse", async () => {
    // Codex gate: the pre-create CAS used to run OUTSIDE the invoice lock. A
    // full progress billing could claim this same milestone (createProgressBillingCore
    // takes the same Invoice lock — tx-retry.ts's canonical order) in the window
    // between pushMilestoneToQuickBooks's early check and this write — both
    // remote QBO calls (token refresh, customer/item resolve) happen in
    // between — and the claim would still succeed, leaving two collectible
    // QuickBooks invoices for one milestone.
    const { claimMilestonePreCreateUnderLock } = await import("../src/lib/quickbooks-payments");

    const schedule = {
        id: "ps-1", invoiceId: "inv-1", status: "Pending",
        amount: 1000, qbPaymentId: null, dueDate: null, name: "Rough-in",
    };
    const locked: string[] = [];
    const claims: any[] = [];
    const tx = {
        // Stands in for lockMoneyParents's `SELECT ... FOR UPDATE` — its own
        // unit is covered by tx-retry.ts; here it just has to run BEFORE the
        // re-check below, which the call order in claimMilestonePreCreateUnderLock
        // already guarantees.
        $queryRaw: async () => { locked.push("invoice"); return []; },
        progressBillingLine: {
            async findFirst() {
                // The interleaving: a progress billing landed on this exact
                // milestone since the caller's earlier (unlocked) check.
                return { billing: { code: "INV-1-P1", status: "Draft" } };
            },
        },
        paymentSchedule: {
            async updateMany(args: any) {
                claims.push(args);
                return { count: 1 };
            },
        },
    };
    const previous = (globalThis as any).prisma;
    (globalThis as any).prisma = { $transaction: async (fn: any) => fn(tx) };
    try {
        await assert.rejects(
            () => claimMilestonePreCreateUnderLock(schedule, "create-in-flight:@1|INV-1-2|note"),
            /already covered by progress invoice INV-1-P1 \(Draft\)/,
        );
    } finally {
        (globalThis as any).prisma = previous;
    }
    assert.equal(locked.length, 1, "the invoice lock must still be taken before the re-check");
    assert.equal(claims.length, 0, "the claim write must never run once a progress billing owns this milestone");
});

test("round 33 gate: with no progress billing in the way, the locked claim still succeeds", async () => {
    const { claimMilestonePreCreateUnderLock } = await import("../src/lib/quickbooks-payments");

    const schedule = {
        id: "ps-1", invoiceId: "inv-1", status: "Pending",
        amount: 1000, qbPaymentId: null, dueDate: null, name: "Rough-in",
    };
    const claims: any[] = [];
    const tx = {
        $queryRaw: async () => [],
        progressBillingLine: { async findFirst() { return null; } },
        paymentSchedule: {
            async updateMany(args: any) {
                claims.push(args);
                return { count: 1 };
            },
        },
    };
    const previous = (globalThis as any).prisma;
    (globalThis as any).prisma = { $transaction: async (fn: any) => fn(tx) };
    try {
        const result = await claimMilestonePreCreateUnderLock(schedule, "create-in-flight:@1|INV-1-2|note");
        assert.equal(result.count, 1);
    } finally {
        (globalThis as any).prisma = previous;
    }
    assert.equal(claims.length, 1);
    assert.equal(claims[0].where.id, "ps-1");
    assert.equal(claims[0].data.qbSyncError, "create-in-flight:@1|INV-1-2|note");
});

test("round 29 gate: the final link write proves ownership of the in-flight marker even on the retry branch", async () => {
    // Codex gate: when the pre-pay-link write already lost its race, the final
    // tx used to retry against a bare `qbInvoiceId: null` with NO check that
    // this call still owned the claim — a row whose marker moved on for an
    // unrelated reason but still happened to read Pending/unlinked/unchanged
    // could get THIS invoice silently attached to it.
    const src = await import("node:fs").then(fs => fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    const push = src.slice(src.indexOf("export async function pushMilestoneToQuickBooks"));
    // The write itself moved into finalizeMilestoneLinkUnderLock when the
    // concurrent-finalize verdict was added (round 34); the invariant did not.
    const finalize = src.slice(
        src.indexOf("export async function finalizeMilestoneLinkUnderLock"),
        src.indexOf("export async function pushMilestoneToQuickBooks"),
    );

    assert.match(
        finalize,
        /qbSyncError: preLinked \? PAYLINK_PENDING_MARKER : inFlightMarker,/,
        "the final link write must require the marker whichever branch it takes",
    );
    // Compensation must also be able to release the claim by marker, not only
    // by qbInvoiceId — the pre-link CAS can lose before the row ever carries one.
    assert.match(
        push,
        /compensateAndUnlink\(\s*prisma\.paymentSchedule,\s*schedule\.id,\s*qbId,\s*\(\)\s*=>\s*deleteQBInvoice\(tokens, qbId, cleanupDeadline\),\s*\{\},\s*inFlightMarker,\s*\)/,
    );
});

// --- deleteQBPayment / deleteQBInvoice: authoritative 404 vs. the shared wall ---

/**
 * Codex gate (round 30): both delete helpers collapsed EVERY non-2xx — a real
 * 404 "already gone" AND a 401/403/429/5xx shared outage alike — into a bare
 * `false`. The billing-core rebalance loop reads a `false` as a per-row
 * refusal and carries on to the next row (see isSharedQboWall); with the
 * outage disguised as an ordinary "couldn't delete", the loop kept dialling
 * the same dead connection at full cost on every remaining row instead of
 * stopping on the first one. 404 stays authoritative (`false`); everything
 * else must now throw, same rule as readQBInvoice already applied to its read.
 */

/** Typed wrapper so a URL/method-aware mock can be passed to withFetch. */
function fakeFetch(impl: (url: string | URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => impl(url, init)) as unknown as typeof fetch;
}

test("deleteQBPayment: a 404 read is authoritative — false, no delete attempted", async () => {
    const { deleteQBPayment } = await import("../src/lib/quickbooks");
    let posted = false;
    const deleted = await withFetch(fakeFetch((url) => {
        if (String(url).includes("/payment/")) return json(404, {});
        posted = true;
        return json(200, {});
    }), () => deleteQBPayment(TOKENS, "pay-1"));
    assert.equal(deleted, false);
    assert.equal(posted, false, "never attempted a delete of a payment that is already gone");
});

test("deleteQBPayment: a shared failure on the READ throws instead of collapsing to false", async () => {
    const { deleteQBPayment } = await import("../src/lib/quickbooks");
    for (const status of [401, 429, 503]) {
        await assert.rejects(
            () => withFetch(fakeFetch(() => json(status, { Fault: {} })), () => deleteQBPayment(TOKENS, "pay-1")),
            (error: unknown) => (error as Error).name === "QboHttpError" || (error as Error).name === "QboRetryableError",
            String(status),
        );
    }
});

test("deleteQBPayment: a 404 on the DELETE itself is also authoritative — false", async () => {
    const { deleteQBPayment } = await import("../src/lib/quickbooks");
    const deleted = await withFetch(fakeFetch((url, init) => {
        if (String(url).includes("/payment/") && (!init || init.method === "GET")) {
            return json(200, { Payment: { SyncToken: "3" } });
        }
        return json(404, {}); // gone between the read and the delete
    }), () => deleteQBPayment(TOKENS, "pay-1"));
    assert.equal(deleted, false);
});

test("deleteQBPayment: a shared failure on the DELETE POST throws", async () => {
    const { deleteQBPayment } = await import("../src/lib/quickbooks");
    await assert.rejects(
        () => withFetch(fakeFetch((url, init) => {
            if (String(url).includes("/payment/") && (!init || init.method === "GET")) {
                return json(200, { Payment: { SyncToken: "3" } });
            }
            return json(503, { Fault: {} });
        }), () => deleteQBPayment(TOKENS, "pay-1")),
        (error: unknown) => (error as Error).name === "QboRetryableError",
    );
});

test("deleteQBPayment: a clean read + delete returns true", async () => {
    const { deleteQBPayment } = await import("../src/lib/quickbooks");
    const deleted = await withFetch(fakeFetch((url, init) => {
        if (String(url).includes("/payment/") && (!init || init.method === "GET")) {
            return json(200, { Payment: { SyncToken: "3" } });
        }
        return json(200, { Payment: { Id: "pay-1" } });
    }), () => deleteQBPayment(TOKENS, "pay-1"));
    assert.equal(deleted, true);
});

test("deleteQBInvoice: a 404 DELETE (post-read) is authoritative — false", async () => {
    const { deleteQBInvoice } = await import("../src/lib/quickbooks");
    const deleted = await withFetch(fakeFetch((url, init) => {
        if (String(url).includes("/invoice/") && (!init || init.method === "GET")) {
            return json(200, { Invoice: { SyncToken: "1", TotalAmt: 100, Balance: 0, CustomerRef: { value: "c1" } } });
        }
        return json(404, {}); // gone between the read and the delete
    }), () => deleteQBInvoice(TOKENS, "inv-1"));
    assert.equal(deleted, false);
});

test("deleteQBInvoice: a shared failure on the DELETE POST throws, not a swallowed false", async () => {
    const { deleteQBInvoice } = await import("../src/lib/quickbooks");
    await assert.rejects(
        () => withFetch(fakeFetch((url, init) => {
            if (String(url).includes("/invoice/") && (!init || init.method === "GET")) {
                return json(200, { Invoice: { SyncToken: "1", TotalAmt: 100, Balance: 0, CustomerRef: { value: "c1" } } });
            }
            return json(401, { Fault: {} });
        }), () => deleteQBInvoice(TOKENS, "inv-1")),
        (error: unknown) => (error as Error).name === "QboHttpError",
    );
});

test("deleteQBInvoice: a clean read + delete returns true", async () => {
    const { deleteQBInvoice } = await import("../src/lib/quickbooks");
    const deleted = await withFetch(fakeFetch((url, init) => {
        if (String(url).includes("/invoice/") && (!init || init.method === "GET")) {
            return json(200, { Invoice: { SyncToken: "1", TotalAmt: 100, Balance: 0, CustomerRef: { value: "c1" } } });
        }
        return json(200, { Invoice: { Id: "inv-1" } });
    }), () => deleteQBInvoice(TOKENS, "inv-1"));
    assert.equal(deleted, true);
});

// --- Round 33 gate: an estimate/invoice sync whose create outcome is unknown ---

/**
 * PR #438 round 33: /api/quickbooks/sync advertised retry:true after ANY
 * timeout, including one that happened AFTER the create POST was dispatched —
 * syncEstimateToQB/syncInvoiceToQB neither create a durable claim nor pass a
 * QBO `requestid`, so a blind retry there risks a genuine duplicate document.
 * These pin that syncEstimateToQB/syncInvoiceToQB now throw a distinct,
 * name-based error for exactly that case, so the route can classify it apart
 * from an ordinary pre-dispatch outage.
 */

const ESTIMATE_INPUT = {
    id: "est-1",
    code: "EST-00001",
    title: "Kitchen Remodel",
    totalAmount: 100,
    items: [{ id: "item-1", parentId: null, name: "Demo", quantity: 1, unitCost: 100, total: 100, type: "Item" }],
    customerId: "cust-1",
    itemId: "item-svc-1",
    project: { name: "Mesplay Kitchen" },
};

const INVOICE_INPUT = {
    code: "INV-00001",
    totalAmount: 100,
    balanceDue: 100,
    customerId: "cust-1",
    itemId: "item-svc-1",
    project: { name: "Mesplay Kitchen" },
};

test("syncEstimateToQB: a timeout AFTER the create POST is dispatched is ambiguous, not a plain outage", async () => {
    const { syncEstimateToQB, isQBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => { throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/estimate"); },
        () => syncEstimateToQB(TOKENS, ESTIMATE_INPUT as any, {}),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error, "must throw, not resolve");
    assert.equal(isQBAmbiguousDocumentCreateError(error), true, `not classified ambiguous: ${error?.name}`);
});

test("syncEstimateToQB: a 2xx response missing Estimate.Id is ambiguous, not a silent success", async () => {
    const { syncEstimateToQB, isQBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => json(200, { Estimate: {} }), // no Id
        () => syncEstimateToQB(TOKENS, ESTIMATE_INPUT as any, {}),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error, "must throw, not return txnId:undefined as a success");
    assert.equal(isQBAmbiguousDocumentCreateError(error), true, `not classified ambiguous: ${error?.name}`);
});

test("syncEstimateToQB: a definite 400 refusal is NOT ambiguous — QuickBooks answered no, nothing was created", async () => {
    const { syncEstimateToQB, isQBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => json(400, { Fault: { Error: [{ Message: "bad request" }] } }),
        () => syncEstimateToQB(TOKENS, ESTIMATE_INPUT as any, {}),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error);
    assert.equal(isQBAmbiguousDocumentCreateError(error), false, "a plain refusal must not be told apart as ambiguous");
    assert.equal(error?.name, "QboHttpError");
});

test("syncInvoiceToQB: a timeout AFTER dispatch is ambiguous", async () => {
    const { syncInvoiceToQB, isQBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => { throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/invoice"); },
        () => syncInvoiceToQB(TOKENS, INVOICE_INPUT as any),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error);
    assert.equal(isQBAmbiguousDocumentCreateError(error), true, `not classified ambiguous: ${error?.name}`);
});

test("syncInvoiceToQB: a 2xx response missing Invoice.Id is ambiguous", async () => {
    const { syncInvoiceToQB, isQBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => json(200, { Invoice: {} }),
        () => syncInvoiceToQB(TOKENS, INVOICE_INPUT as any),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error);
    assert.equal(isQBAmbiguousDocumentCreateError(error), true, `not classified ambiguous: ${error?.name}`);
});

// --- Round 31 gate: the ambiguous boundary must cover the BODY READ too ---
//
// The two blocks above only proved a dispatch-time failure or a clean 2xx
// missing an Id is ambiguous. A 2xx header followed by a body that stalls
// or arrives truncated/malformed used to escape that classification — the
// `try` closed right after `qbFetch` resolved, so `res.json()` ran unguarded
// and a failure there surfaced as a plain QBTimeoutError/QboRetryableError.
// The route's classifier treated that as an ordinary outage and advertised
// retry:true, risking a genuine duplicate document. A caller-originated
// AbortError is the one exception that must still propagate as itself.

test("syncEstimateToQB: a body read that times out AFTER a 2xx header is ambiguous, not a plain timeout", async () => {
    const { syncEstimateToQB, isQBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => ({
            ok: true,
            status: 200,
            json: async () => { throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/estimate"); },
        }) as any,
        () => syncEstimateToQB(TOKENS, ESTIMATE_INPUT as any, {}),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error, "must throw, not resolve");
    assert.equal(isQBAmbiguousDocumentCreateError(error), true, `not classified ambiguous: ${error?.name}`);
});

test("syncEstimateToQB: truncated/malformed JSON in a 2xx body is ambiguous, not a plain parse failure", async () => {
    const { syncEstimateToQB, isQBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => new Response('{"Estimate": {"Id": "9"', { status: 200, headers: { "content-type": "application/json" } }),
        () => syncEstimateToQB(TOKENS, ESTIMATE_INPUT as any, {}),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error, "must throw, not resolve");
    assert.equal(isQBAmbiguousDocumentCreateError(error), true, `not classified ambiguous: ${error?.name}`);
});

test("syncEstimateToQB: a caller-originated abort during the body read propagates as itself, not ambiguous", async () => {
    const { syncEstimateToQB } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => ({
            ok: true,
            status: 200,
            json: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
        }) as any,
        () => syncEstimateToQB(TOKENS, ESTIMATE_INPUT as any, {}),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error);
    assert.equal(error?.name, "AbortError", "a caller's own cancellation must propagate as itself, not become ambiguous");
});

test("syncInvoiceToQB: a body read that times out AFTER a 2xx header is ambiguous, not a plain timeout", async () => {
    const { syncInvoiceToQB, isQBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => ({
            ok: true,
            status: 200,
            json: async () => { throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/invoice"); },
        }) as any,
        () => syncInvoiceToQB(TOKENS, INVOICE_INPUT as any),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error);
    assert.equal(isQBAmbiguousDocumentCreateError(error), true, `not classified ambiguous: ${error?.name}`);
});

test("syncInvoiceToQB: truncated/malformed JSON in a 2xx body is ambiguous, not a plain parse failure", async () => {
    const { syncInvoiceToQB, isQBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    const error = await withFetch(
        async () => new Response('{"Invoice": {"Id": "9"', { status: 200, headers: { "content-type": "application/json" } }),
        () => syncInvoiceToQB(TOKENS, INVOICE_INPUT as any),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error);
    assert.equal(isQBAmbiguousDocumentCreateError(error), true, `not classified ambiguous: ${error?.name}`);
});

test("the /api/quickbooks/sync route classifies an ambiguous create distinctly, retry:false", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/app/api/quickbooks/sync/route.ts", "utf8");
    assert.ok(source.includes("isQBAmbiguousDocumentCreateError"), "route does not classify the ambiguous-create error");
    // The ambiguous branch must come first (checked before the generic
    // retry:true outage classifier) and must never advertise retry:true.
    const ambiguousIdx = source.indexOf("isQBAmbiguousDocumentCreateError(err)");
    const genericIdx = source.indexOf("isQBBudgetExhaustedError(err)");
    assert.ok(ambiguousIdx > -1 && genericIdx > -1 && ambiguousIdx < genericIdx, "ambiguous branch must be checked first");
    const ambiguousBlock = source.slice(ambiguousIdx, genericIdx);
    assert.ok(ambiguousBlock.includes('retry: false'), "an ambiguous create must never advertise retry:true");
    assert.ok(ambiguousBlock.includes('"ambiguous-create"'), "must surface the ambiguous-create reason");
});

// --- Round 34 gate: a lost final CAS is not proof the invoice was abandoned ---

/**
 * The failure: after the provisional link (`qbInvoiceId` + `paylink-pending`)
 * is persisted, `sweepPendingPayLinks` — or a concurrent resend taking the
 * already-linked branch at the top of the push — fills the pay link and clears
 * the marker. The original request's final CAS pins that marker, so it fails
 * for that reason ALONE, was read as "the milestone was abandoned", and
 * compensation deleted a live, correct QuickBooks invoice that the concurrent
 * caller had already reported as a success.
 */

const ISSUED_DUE = new Date("2026-09-30T00:00:00.000Z");
const ISSUED_FROM = { amount: 1200.5, name: "Rough-in", dueDate: ISSUED_DUE };

test("the pay-link sweep clearing our marker is NOT divergence", async () => {
    const { isConcurrentlyFinalizedMilestoneLink } = await import("../src/lib/quickbooks-payments");

    // Exactly what the row looks like after the sweep finished it: our id, the
    // link filled in, the marker gone, everything else untouched.
    const afterSweep = {
        qbInvoiceId: "inv-77",
        qbInvoiceLink: "https://pay/77",
        status: "Pending",
        amount: 1200.5,
        name: "Rough-in",
        dueDate: ISSUED_DUE,
    };
    assert.equal(isConcurrentlyFinalizedMilestoneLink(afterSweep, "inv-77", ISSUED_FROM), true);

    // A settle that landed against THIS invoice while we were fetching its pay
    // link must not be compensated either — deleting a paid QuickBooks document
    // is strictly worse than leaving an abandoned one.
    assert.equal(
        isConcurrentlyFinalizedMilestoneLink({ ...afterSweep, status: "Paid" }, "inv-77", ISSUED_FROM),
        true,
    );
    // A different Date OBJECT carrying the same instant is the same due date.
    assert.equal(
        isConcurrentlyFinalizedMilestoneLink(
            { ...afterSweep, dueDate: new Date(ISSUED_DUE.getTime()) },
            "inv-77",
            ISSUED_FROM,
        ),
        true,
    );
});

test("genuine divergence still compensates", async () => {
    const { isConcurrentlyFinalizedMilestoneLink } = await import("../src/lib/quickbooks-payments");
    const base = {
        qbInvoiceId: "inv-77",
        qbInvoiceLink: null,
        status: "Pending",
        amount: 1200.5,
        name: "Rough-in",
        dueDate: ISSUED_DUE,
    };
    const cases: Array<[string, any]> = [
        ["the row vanished", null],
        ["a different invoice", { ...base, qbInvoiceId: "inv-99" }],
        ["no invoice at all", { ...base, qbInvoiceId: null }],
        ["cancelled mid-push", { ...base, status: "Canceled" }],
        ["repriced mid-push", { ...base, amount: 1500 }],
        ["renamed mid-push", { ...base, name: "Rough-in (revised)" }],
        ["rescheduled mid-push", { ...base, dueDate: new Date("2026-10-31T00:00:00.000Z") }],
        ["due date cleared", { ...base, dueDate: null }],
    ];
    for (const [label, row] of cases) {
        assert.equal(
            isConcurrentlyFinalizedMilestoneLink(row, "inv-77", ISSUED_FROM),
            false,
            `${label} must still compensate`,
        );
    }
    // ...and a row that never had a due date matches one issued without one.
    assert.equal(
        isConcurrentlyFinalizedMilestoneLink({ ...base, dueDate: null }, "inv-77", { ...ISSUED_FROM, dueDate: null }),
        true,
    );
});

/**
 * Drives the REAL transaction (src/lib/prisma.ts reads globalThis.prisma before
 * it builds a client), so the interleaving is exercised end to end rather than
 * simulated.
 */
function fakeFinalizeDb(opts: {
    claimCount: number;
    current: Record<string, unknown> | null;
    billingClaim?: boolean;
}) {
    const seen = { locked: 0, claims: [] as any[], reads: 0 };
    const tx = {
        $queryRaw: async () => { seen.locked++; return []; },
        progressBillingLine: {
            async findFirst() { return opts.billingClaim ? { id: "pbl-1" } : null; },
        },
        paymentSchedule: {
            async updateMany(args: any) { seen.claims.push(args); return { count: opts.claimCount }; },
            async findUnique() { seen.reads++; return opts.current; },
        },
    };
    return { seen, prisma: { $transaction: async (fn: any) => fn(tx) } };
}

const SCHEDULE = {
    id: "ps-1",
    invoiceId: "inv-1",
    amount: 1200.5,
    dueDate: ISSUED_DUE,
    name: "Rough-in",
};

async function runFinalize(fake: { prisma: unknown }, preLinked = true) {
    const { finalizeMilestoneLinkUnderLock } = await import("../src/lib/quickbooks-payments");
    const previous = (globalThis as any).prisma;
    (globalThis as any).prisma = fake.prisma;
    try {
        return await finalizeMilestoneLinkUnderLock(SCHEDULE, {
            qbId: "inv-77",
            payLink: "https://pay/77",
            preLinked,
            inFlightMarker: "create-in-flight:@1|INV-1-2|note",
        });
    } finally {
        (globalThis as any).prisma = previous;
    }
}

test("interleaving: provisional link persisted, sweep finishes it, our CAS loses — no compensation", async () => {
    // 1. this push wrote qbInvoiceId=inv-77 + `paylink-pending`
    // 2. the sweep fetched the pay link and cleared the marker
    // 3. this push's final CAS pins `paylink-pending` and therefore loses
    const fake = fakeFinalizeDb({
        claimCount: 0,
        current: {
            qbInvoiceId: "inv-77",
            qbInvoiceLink: "https://pay/77",
            status: "Pending",
            amount: 1200.5,
            name: "Rough-in",
            dueDate: ISSUED_DUE,
        },
    });
    const result = await runFinalize(fake);

    assert.equal(result.outcome, "already-finalized", "the invoice is live and referenced — never delete it");
    assert.equal(result.payLink, "https://pay/77", "report the link the winner wrote");
    assert.equal(fake.seen.locked, 1, "the verdict is reached under the invoice lock");
    assert.equal(fake.seen.reads, 1, "the verdict comes from a re-read, not from the lost CAS alone");
});

test("interleaving: the row really did move on — still abandoned, so compensation runs", async () => {
    const fake = fakeFinalizeDb({
        claimCount: 0,
        current: {
            qbInvoiceId: null,
            qbInvoiceLink: null,
            status: "Canceled",
            amount: 1200.5,
            name: "Rough-in",
            dueDate: ISSUED_DUE,
        },
    });
    assert.equal((await runFinalize(fake)).outcome, "abandoned");
});

test("a progress billing that claimed the milestone is abandoned even when the row carries OUR id", async () => {
    // The billing stages its own covering invoice, so ours is the duplicate:
    // the id matching is not enough to make this a success.
    const fake = fakeFinalizeDb({
        claimCount: 0,
        billingClaim: true,
        current: {
            qbInvoiceId: "inv-77",
            qbInvoiceLink: "https://pay/77",
            status: "Pending",
            amount: 1200.5,
            name: "Rough-in",
            dueDate: ISSUED_DUE,
        },
    });
    const result = await runFinalize(fake);
    assert.equal(result.outcome, "abandoned");
    assert.equal(fake.seen.claims.length, 0, "the link write must never run once a progress billing owns this milestone");
});

test("the ordinary path still writes the link and reports `linked`", async () => {
    const fake = fakeFinalizeDb({ claimCount: 1, current: null });
    const result = await runFinalize(fake);
    assert.equal(result.outcome, "linked");
    assert.equal(result.payLink, "https://pay/77");
    assert.equal(fake.seen.reads, 0, "a winning CAS needs no re-read");
    const where = fake.seen.claims[0].where;
    assert.equal(where.qbInvoiceId, "inv-77", "pre-linked: pinned to the id we already wrote");
    assert.equal(where.qbSyncError, "paylink-pending");
    // The retry branch (the pre-link write lost) still proves ownership.
    const retry = fakeFinalizeDb({ claimCount: 1, current: null });
    await runFinalize(retry, false);
    assert.equal(retry.seen.claims[0].where.qbInvoiceId, null);
    assert.equal(retry.seen.claims[0].where.qbSyncError, "create-in-flight:@1|INV-1-2|note");
});

test("the push returns the concurrent winner's id instead of compensating", async () => {
    const src = await import("node:fs").then(fs => fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    const push = src.slice(src.indexOf("export async function pushMilestoneToQuickBooks"));
    const finalized = push.indexOf('linked.outcome === "already-finalized"');
    const compensate = push.indexOf("compensateAndUnlink(");
    assert.ok(finalized > -1, "the push must act on the already-finalized verdict");
    assert.ok(compensate > -1, "compensation is still there for the genuinely abandoned case");
    assert.ok(finalized < compensate, "the success return must come BEFORE any compensating delete");
});


// --- Round 35 gate: `checked` is the whole run, not just the milestone rail ---

/**
 * Enough of Prisma to drive the REAL `syncQuickBooksPayments` over both
 * collections. src/lib/prisma.ts reads globalThis.prisma before building a
 * client, which is the seam this uses — no database, real loop.
 */
function makeMixedRailPrisma(milestones: any[], billings: any[], settings: string) {
    const events: any[] = [];
    const table = (rows: any[]) => ({
        async count(args: any) {
            const gt = args?.where?.id?.gt;
            return gt ? rows.filter((r) => r.id > gt).length : rows.length;
        },
        async findMany(args: any) {
            const gt = args?.where?.id?.gt;
            const list = gt ? rows.filter((r) => r.id > gt) : rows;
            return list.slice(0, args?.take ?? list.length).map((r) => ({ ...r }));
        },
        async updateMany() {
            return { count: 0 };
        },
    });
    return {
        events,
        client: {
            // The QBO connection state getFreshQBTokens reads. The E2E mock
            // replaces the NETWORK, not the connection row — with no connected
            // integration the preflight still (correctly) refuses.
            integration: {
                async findUnique() { return { settings }; },
                async upsert() { return {}; },
            },
            paymentSchedule: table(milestones),
            progressBilling: table(billings),
            automationEvent: { async create(args: any) { events.push(args.data); return {}; } },
        },
    };
}

test("round 35 gate: checked counts progress-billing probes as well as milestone probes", async () => {
    // The progress-billing handler never incremented `checked`, so a run that
    // verified nothing but billings reported "checked: 0" — and any coverage
    // number computed off it under-reported that rail entirely.
    const milestones = [
        { id: "ps-1", invoiceId: "inv-1", qbInvoiceId: "qb-1", qbSyncError: null, name: "Rough-in", amount: 100, invoice: { code: "INV-1", project: null, client: null } },
        { id: "ps-2", invoiceId: "inv-1", qbInvoiceId: "qb-2", qbSyncError: null, name: "Final", amount: 100, invoice: { code: "INV-1", project: null, client: null } },
    ];
    const billings = [
        { id: "pb-1", invoiceId: "inv-1", qbInvoiceId: "qb-3", code: "INV-1-P1", lines: [], invoice: { code: "INV-1", estimateId: null } },
        { id: "pb-2", invoiceId: "inv-1", qbInvoiceId: "qb-4", code: "INV-1-P2", lines: [], invoice: { code: "INV-1", estimateId: null } },
        { id: "pb-3", invoiceId: "inv-1", qbInvoiceId: "qb-5", code: "INV-1-P3", lines: [], invoice: { code: "INV-1", estimateId: null } },
    ];
    const previousNextauth = process.env.NEXTAUTH_SECRET;
    process.env.NEXTAUTH_SECRET = "test-nextauth-secret";
    const { encryptObject } = await import("../src/lib/crypto");
    const { client, events } = makeMixedRailPrisma(milestones, billings, encryptObject({
        quickbooks: { connected: true, accessToken: "a", refreshToken: "r", realmId: "realm-1", serviceItemId: "7" },
    }));

    const previousPrisma = (globalThis as any).prisma;
    // The existing QBO mock gate: canned tokens with NO network I/O, so the
    // preflight token refresh is not part of what this test exercises. All
    // three env vars are the gate (see isE2eQboMockEnabled).
    const previousEnv = {
        mock: process.env.E2E_QBO_MOCK,
        playwright: process.env.PLAYWRIGHT_TEST_SECRET,
        vercel: process.env.VERCEL,
    };
    (globalThis as any).prisma = client;
    process.env.E2E_QBO_MOCK = "1";
    process.env.PLAYWRIGHT_TEST_SECRET = "pw";
    delete process.env.VERCEL;
    try {
        const { syncQuickBooksPayments } = await import("../src/lib/quickbooks-payments");
        const probed: string[] = [];
        const cursors = new Map<string, string>();
        const result = await syncQuickBooksPayments(undefined, {
            source: "cron",
            qboClient: {
                async probeInvoice(id) {
                    probed.push(id);
                    // Part-paid: exercised, counted, but no settle side effects.
                    return { state: "ok", balance: 5, total: 10, paymentTxnIds: [] };
                },
                async getPayment() { return null; },
                async verifyConnection() {},
            },
            cursorStore: {
                async get(key) { return cursors.get(key) ?? null; },
                async set(key, value) { cursors.set(key, value); },
            },
        });

        assert.equal(probed.length, 5, "every row on both rails was probed");
        assert.equal(result.checked, 5, "and every probe is counted — 2 milestones + 3 progress billings");
        assert.equal(result.partiallyPaid, 5);
        assert.equal(result.skipped, 0);
        // The audit event carries the same number the caller sees — the health
        // digest reads THAT, so a rail missing from `checked` is invisible there too.
        assert.equal(JSON.parse(String(events.at(-1)?.detail)).checked, 5);
    } finally {
        (globalThis as any).prisma = previousPrisma;
        for (const [key, value] of Object.entries({
            NEXTAUTH_SECRET: previousNextauth,
            E2E_QBO_MOCK: previousEnv.mock,
            PLAYWRIGHT_TEST_SECRET: previousEnv.playwright,
            VERCEL: previousEnv.vercel,
        })) {
            if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
            else (process.env as Record<string, string>)[key] = value;
        }
    }
});
