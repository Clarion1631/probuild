/**
 * The ambiguity boundary around a QuickBooks document create.
 *
 * Codex gate (round 36, item 3): `syncEstimateToQB` and `syncInvoiceToQB`
 * classified non-2xx responses through `qboResponseError`, which sits OUTSIDE
 * that boundary. A 500 or 503 arriving AFTER QuickBooks had already processed
 * the POST therefore came back as `QboRetryableError`, and
 * /api/quickbooks/sync answered `retry: true` for a document that may well
 * exist. Retrying then bills the client twice.
 *
 * The rule, encoded once in `classifyDocumentCreateFailure` and used by every
 * create path so it cannot drift apart again:
 *
 *   dispatched + not a proven refusal  →  QBAmbiguousDocumentCreateError
 *   4xx WITH a parsed QBO Fault        →  terminal (nothing was created)
 *   never dispatched / caller aborted  →  propagates as itself, still retryable
 *
 * Driven through the real create functions with a stubbed global fetch —
 * `mock.module` corrupts the require chain on Node 20, which is what CI pins.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    syncEstimateToQB,
    syncInvoiceToQB,
    createQBMilestoneInvoice,
    classifyDocumentCreateFailure,
    parseQboFault,
    isQBAmbiguousDocumentCreateError,
    qboHttpStatus,
    QBTimeoutError,
    QBBudgetExhaustedError,
    isQBBudgetExhaustedError,
    createRouteDeadline,
    type QBTokens,
} from "../src/lib/quickbooks";
import { isAmbiguousCreateFailure } from "../src/lib/quickbooks-payments";

const TOKENS: QBTokens = { accessToken: "a", refreshToken: "r", realmId: "realm-1" };

/** A QBO validation Fault, the evidence half of "QuickBooks said no". */
const FAULT = JSON.stringify({
    Fault: { Error: [{ Message: "Invalid Reference Id", code: "6240" }], type: "ValidationFault" },
    time: "2026-09-02T00:00:00.000Z",
});

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

const responding = (status: number, body: string): typeof fetch =>
    (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

const throwing = (error: unknown): typeof fetch => (async () => { throw error; }) as unknown as typeof fetch;

const ESTIMATE = {
    id: "est-1",
    code: "EST-00237",
    title: "Mesplay Kitchen",
    totalAmount: 1089,
    items: [{ id: "i1", parentId: null, name: "Rough-in", quantity: 1, unitCost: 1089, total: 1089, type: "labor" }],
    customerId: "42",
    itemId: "7",
    project: { name: "Mesplay Kitchen" },
};

const INVOICE = {
    code: "INV-00171",
    totalAmount: 1089,
    balanceDue: 1089,
    customerId: "42",
    itemId: "7",
    project: { name: "Mesplay Kitchen" },
};

async function capture(run: () => Promise<unknown>): Promise<unknown> {
    try {
        await run();
        return null;
    } catch (error) {
        return error;
    }
}

// ─── The classifier itself ─────────────────────────────────────────────────

test("a QBO Fault is only recognised when the body actually carries one", () => {
    assert.notEqual(parseQboFault(FAULT), null);
    assert.equal(parseQboFault(FAULT)?.codes[0], "6240");
    // Everything an edge device or proxy might answer with instead.
    assert.equal(parseQboFault(""), null);
    assert.equal(parseQboFault(null), null);
    assert.equal(parseQboFault("<html>403 Forbidden</html>"), null);
    assert.equal(parseQboFault('{"Estimate":{"Id":"9"}}'), null);
    assert.equal(parseQboFault("[1,2,3]"), null);
});

test("classification table: only a 4xx carrying a Fault is terminal", () => {
    type Row = { name: string; outcome: Parameters<typeof classifyDocumentCreateFailure>[0]; terminal: boolean };
    const rows: Row[] = [
        { name: "400 with Fault", outcome: { status: 400, body: FAULT }, terminal: true },
        { name: "401 with Fault", outcome: { status: 401, body: FAULT }, terminal: true },
        { name: "403 with Fault", outcome: { status: 403, body: FAULT }, terminal: true },
        { name: "404 with Fault", outcome: { status: 404, body: FAULT }, terminal: true },
        { name: "422 with Fault", outcome: { status: 422, body: FAULT }, terminal: true },
        // No Fault: an edge device can produce a 4xx that Intuit never saw, so
        // "we could not read the refusal" is not a refusal.
        { name: "400 no Fault", outcome: { status: 400, body: "Bad Request" }, terminal: false },
        { name: "401 no Fault", outcome: { status: 401, body: "" }, terminal: false },
        { name: "400 unreadable body", outcome: { status: 400, bodyUnreadable: true }, terminal: false },
        // Never definitive, Fault or not: QuickBooks failed to ANSWER, which
        // says nothing about whether it also failed to act.
        { name: "408", outcome: { status: 408, body: FAULT }, terminal: false },
        { name: "429", outcome: { status: 429, body: FAULT }, terminal: false },
        { name: "500", outcome: { status: 500, body: FAULT }, terminal: false },
        { name: "502", outcome: { status: 502, body: "" }, terminal: false },
        { name: "503", outcome: { status: 503, body: "" }, terminal: false },
        { name: "418 (unexpected)", outcome: { status: 418, body: FAULT }, terminal: false },
        { name: "2xx with no Id", outcome: { status: 200, missingId: true }, terminal: false },
        { name: "201 with no Id", outcome: { status: 201, missingId: true }, terminal: false },
        { name: "no response at all", outcome: {}, terminal: false },
    ];
    for (const row of rows) {
        const error = classifyDocumentCreateFailure(row.outcome, "QB estimate sync");
        assert.equal(
            isQBAmbiguousDocumentCreateError(error),
            !row.terminal,
            `${row.name}: expected ${row.terminal ? "terminal" : "ambiguous"}, got ${error.name}`,
        );
        if (row.terminal) {
            // The status survives, so the route still reports a 401/403 as the
            // reconnect it is rather than a generic failure.
            assert.equal(qboHttpStatus(error), row.outcome.status, row.name);
        }
    }
});

// ─── The create paths, end to end ──────────────────────────────────────────

for (const [label, run] of [
    ["estimate", () => syncEstimateToQB(TOKENS, ESTIMATE, {}, createRouteDeadline(30_000))],
    ["invoice", () => syncInvoiceToQB(TOKENS, INVOICE, createRouteDeadline(30_000))],
] as const) {
    test(`${label} create: every dispatched non-definitive outcome is ambiguous`, async () => {
        const cases: Array<[string, typeof fetch]> = [
            ["200 with no Id", responding(200, JSON.stringify({}))],
            ["201 with no Id", responding(201, JSON.stringify({ Estimate: {}, Invoice: {} }))],
            ["200 with an unparseable body", responding(200, "{not json")],
            ["400 with no Fault", responding(400, "Bad Request")],
            ["429", responding(429, FAULT)],
            ["500", responding(500, "upstream error")],
            ["502", responding(502, "<html>bad gateway</html>")],
            ["503", responding(503, "")],
            ["our own deadline firing", throwing(new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/estimate"))],
            ["a dead socket", throwing(new TypeError("fetch failed"))],
        ];
        for (const [name, impl] of cases) {
            const error = await withFetch(impl, () => capture(run));
            assert.ok(
                isQBAmbiguousDocumentCreateError(error),
                `${label} / ${name}: expected ambiguous-create, got ${(error as Error)?.name ?? error}`,
            );
        }
    });

    test(`${label} create: a 4xx carrying a QuickBooks Fault stays terminal`, async () => {
        for (const status of [400, 401, 403, 404, 422]) {
            const error = await withFetch(responding(status, FAULT), () => capture(run));
            assert.equal(isQBAmbiguousDocumentCreateError(error), false, `${label} / ${status}`);
            assert.equal(qboHttpStatus(error), status, `${label} / ${status}`);
        }
    });

    test(`${label} create: a 2xx carrying an Id succeeds`, async () => {
        const ok = await withFetch(
            responding(201, JSON.stringify({ Estimate: { Id: "99" }, Invoice: { Id: "99" } })),
            run,
        );
        assert.equal((ok as { qbId: string }).qbId, "99");
    });

    test(`${label} create: a PRE-dispatch failure stays retryable, not ambiguous`, async () => {
        // The route budget was already gone, so `qbTimedFetch` never called
        // fetch: nothing was created and the caller should simply come back.
        const exhausted = await capture(() =>
            label === "estimate"
                ? syncEstimateToQB(TOKENS, ESTIMATE, {}, createRouteDeadline(30_000, Date.now() - 60_000))
                : syncInvoiceToQB(TOKENS, INVOICE, createRouteDeadline(30_000, Date.now() - 60_000)));
        assert.ok(isQBBudgetExhaustedError(exhausted), `${label}: ${(exhausted as Error)?.name}`);
        assert.equal(isQBAmbiguousDocumentCreateError(exhausted), false);
        assert.equal(exhausted instanceof QBBudgetExhaustedError, true);
    });

    test(`${label} create: a CALLER's own abort propagates as itself`, async () => {
        const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
        const error = await withFetch(throwing(aborted), () => capture(run));
        assert.equal((error as Error).name, "AbortError");
        assert.equal(isQBAmbiguousDocumentCreateError(error), false);
    });
}

// ─── The money rail reads the new class as ambiguous ───────────────────────

test("the milestone create shares the boundary, and the money rail parks on it", async () => {
    // createQBMilestoneInvoice used to classify through `qboResponseError`, so
    // a Fault-less 4xx reached the caller as a plain QboHttpError —
    // `isAmbiguousCreateFailure` read that as "QuickBooks said no", RELEASED
    // the in-flight claim, and left the row freely re-sendable while an invoice
    // may have existed.
    const input = {
        docNumber: "INV-00171-2",
        customerId: "42",
        itemId: "7",
        description: "Mesplay Kitchen — Rough-in",
        amount: 1089,
        tax: { preTaxAmount: 1000, taxAmount: 89 },
        privateNote: "ProBuild INV-00171 - Rough-in - Mesplay Kitchen",
    };
    const deadline = createRouteDeadline(30_000);

    const faultless = await withFetch(
        responding(400, "Bad Request"),
        () => capture(() => createQBMilestoneInvoice(TOKENS, input, deadline)),
    );
    assert.ok(isQBAmbiguousDocumentCreateError(faultless));
    assert.equal(isAmbiguousCreateFailure(faultless), true, "the row must STAY parked");

    const noId = await withFetch(
        responding(200, JSON.stringify({ Invoice: { TotalAmt: 1089 } })),
        () => capture(() => createQBMilestoneInvoice(TOKENS, input, deadline)),
    );
    assert.ok(isQBAmbiguousDocumentCreateError(noId));
    assert.equal(isAmbiguousCreateFailure(noId), true);

    // A real QuickBooks refusal still releases the claim — that is the whole
    // point of keeping the terminal branch.
    const refused = await withFetch(
        responding(400, FAULT),
        () => capture(() => createQBMilestoneInvoice(TOKENS, input, deadline)),
    );
    assert.equal(isQBAmbiguousDocumentCreateError(refused), false);
    assert.equal(isAmbiguousCreateFailure(refused), false);
});
