import assert from "node:assert/strict";
import test from "node:test";
import { createBankLedgerIngestHandlers, QboIngestConflictError, type BankLedgerIngestHandlerDependencies } from "../src/app/api/integrations/bank-ledger/ingest/route";
import { computeStatementContentHash } from "../src/lib/bank-ledger";

const SECRET = "test-secret";

function makeRequest(body: unknown, headers: Record<string, string> = { "x-ingest-key": SECRET }) {
    return new Request("http://localhost/api/integrations/bank-ledger/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
}

function makeHandlers(overrides: Partial<BankLedgerIngestHandlerDependencies> = {}) {
    const createStatementImportCalls: unknown[] = [];
    const createQboObservationsCalls: unknown[] = [];
    const defaults: BankLedgerIngestHandlerDependencies = {
        getIngestSecret: () => SECRET,
        findStatementImport: async () => null,
        countStatementObservations: async () => 0,
        createStatementImport: async input => {
            createStatementImportCalls.push(input);
            return { statementImportId: "stmt-1", inserted: (input as { lines: unknown[] }).lines.length };
        },
        findExistingQboObservations: async () => new Map(),
        refreshQboDescriptors: async () => 0,
        refreshQboClearedStatus: async () => 0,
        createQboObservations: async rows => {
            createQboObservationsCalls.push(...rows);
            return rows.length;
        },
    };
    const handlers = createBankLedgerIngestHandlers({ ...defaults, ...overrides });
    return { handlers, createStatementImportCalls, createQboObservationsCalls };
}

function statementBody(overrides: Record<string, unknown> = {}) {
    return {
        source: "STATEMENT",
        account: "WTB-0723",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        openingCents: 100000,
        closingCents: 92600,
        lines: [{ postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" }],
        ...overrides,
    };
}

test("bank-ledger ingest: auth", async t => {
    await t.test("401 when x-ingest-key is missing", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ source: "STATEMENT", account: "WTB-0723", lines: [] }, {}));
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { ok: false, reason: "unauthorized" });
    });

    await t.test("401 when x-ingest-key is wrong", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ source: "STATEMENT", account: "WTB-0723", lines: [] }, { "x-ingest-key": "wrong" }));
        assert.equal(res.status, 401);
    });

    await t.test("401 when the server has no configured secret (never falls open)", async () => {
        const { handlers } = makeHandlers({ getIngestSecret: () => undefined });
        const res = await handlers.POST(makeRequest({ source: "STATEMENT", account: "WTB-0723", lines: [] }, { "x-ingest-key": "" }));
        assert.equal(res.status, 401);
    });
});

test("bank-ledger ingest: validation", async t => {
    await t.test("400 invalid-source", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ source: "BOGUS", account: "WTB-0723", lines: [{ postedDate: "2026-01-01", amountCents: -100, rawDescriptor: "X" }] }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-source");
    });

    await t.test("400 invalid-account when account is empty", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ source: "STATEMENT", account: "", lines: [{ postedDate: "2026-01-01", amountCents: -100, rawDescriptor: "X" }] }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-account");
    });

    await t.test("400 missing-lines when lines is empty or absent", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ source: "STATEMENT", account: "WTB-0723", lines: [] }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "missing-lines");
    });

    await t.test("400 too-many-lines over the request cap", async () => {
        const { handlers } = makeHandlers();
        const lines = Array.from({ length: 5001 }, (_, i) => ({ postedDate: "2026-01-01", amountCents: -100 - i, rawDescriptor: "X" }));
        const res = await handlers.POST(makeRequest({ source: "STATEMENT", account: "WTB-0723", lines }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "too-many-lines");
    });

    await t.test("400 invalid-line on a bad postedDate/amountCents/rawDescriptor", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({
            source: "STATEMENT",
            account: "WTB-0723",
            periodStart: "2026-01-01",
            periodEnd: "2026-01-31",
            openingCents: 0,
            closingCents: 0,
            lines: [{ postedDate: "01/01/2026", amountCents: -100, rawDescriptor: "X" }],
        }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-line");
    });

    await t.test("400 invalid-json", async () => {
        const { handlers } = makeHandlers();
        const req = new Request("http://localhost/x", { method: "POST", headers: { "x-ingest-key": SECRET }, body: "{not json" });
        const res = await handlers.POST(req);
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-json");
    });
});

test("bank-ledger ingest: happy path", async t => {
    await t.test("inserts new lines, normalizes payee, and returns inserted/existing counts", async () => {
        const { handlers, createStatementImportCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest({
            source: "STATEMENT",
            account: "WTB-0723",
            periodStart: "2026-07-01",
            periodEnd: "2026-07-31",
            openingCents: 100000,
            closingCents: 592600,
            lines: [
                { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET US MARKET POS DEB 1027" },
                { postedDate: "2026-07-17", amountCents: 500000, rawDescriptor: "DEPOSIT" },
            ],
        }));
        assert.equal(res.status, 200);
        // `adopted` (Phase 2): how many lines attached to a canonical row the QBO
        // pull had already minted, instead of minting a twin. 0 here — this fake
        // has no QBO-minted lines to adopt.
        assert.deepEqual(await res.json(), { ok: true, statementImportId: "stmt-1", inserted: 2, existing: 0, adopted: 0 });
        assert.equal(createStatementImportCalls.length, 1);
        const call = createStatementImportCalls[0] as { account: string; lines: Array<{ normalizedPayee: string }> };
        assert.equal(call.account, "WTB-0723");
        assert.equal(call.lines.length, 2);
        assert.equal(call.lines[0].normalizedPayee, "US MARKET US MARKET");
    });

    await t.test("passes checkNumber through when present, null when absent", async () => {
        const { handlers, createStatementImportCalls } = makeHandlers();
        await handlers.POST(makeRequest({
            source: "STATEMENT",
            account: "WTB-0723",
            periodStart: "2026-07-01",
            periodEnd: "2026-07-31",
            openingCents: 0,
            closingCents: -400100,
            lines: [
                { postedDate: "2026-07-17", amountCents: -400000, rawDescriptor: "Check #1024", checkNumber: "1024" },
                { postedDate: "2026-07-16", amountCents: -100, rawDescriptor: "X" },
            ],
        }));
        const call = createStatementImportCalls[0] as { lines: Array<{ checkNumber: string | null }> };
        assert.equal(call.lines[0].checkNumber, "1024");
        assert.equal(call.lines[1].checkNumber, null);
    });

    await t.test("replays an already-imported statement without re-inserting (content-hash idempotency)", async () => {
        const body = {
            source: "STATEMENT",
            account: "WTB-0723",
            periodStart: "2026-07-01",
            periodEnd: "2026-07-31",
            openingCents: 100000,
            closingCents: 92600,
            lines: [{ postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null }],
        };
        const contentHash = computeStatementContentHash({
            account: body.account,
            periodStart: body.periodStart,
            periodEnd: body.periodEnd,
            openingCents: body.openingCents,
            closingCents: body.closingCents,
            lines: body.lines,
        });
        let createCalled = false;
        const { handlers } = makeHandlers({
            findStatementImport: async () => ({ id: "existing-id", contentHash }),
            countStatementObservations: async () => 1,
            createStatementImport: async () => {
                createCalled = true;
                return { statementImportId: "should-not-happen", inserted: 0 };
            },
        });
        const res = await handlers.POST(makeRequest(body));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, statementImportId: "existing-id", inserted: 0, existing: 1, replay: true });
        assert.equal(createCalled, false);
    });

    await t.test("409 statement-conflict when the same account+period gets different content", async () => {
        const { handlers } = makeHandlers({
            findStatementImport: async () => ({ id: "existing-id", contentHash: "different-hash" }),
        });
        const res = await handlers.POST(makeRequest({
            source: "STATEMENT",
            account: "WTB-0723",
            periodStart: "2026-07-01",
            periodEnd: "2026-07-31",
            openingCents: 100000,
            closingCents: 92600,
            lines: [{ postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" }],
        }));
        assert.equal(res.status, 409);
        assert.equal((await res.json()).reason, "statement-conflict");
    });

    await t.test("identical same-day duplicate lines both insert (sequence, not content, distinguishes them)", async () => {
        const { handlers, createStatementImportCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest({
            source: "STATEMENT",
            account: "WTB-0723",
            periodStart: "2026-07-01",
            periodEnd: "2026-07-31",
            openingCents: 0,
            closingCents: -14800,
            lines: [
                { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
                { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
            ],
        }));
        // `adopted` (Phase 2): how many lines attached to a canonical row the QBO
        // pull had already minted, instead of minting a twin. 0 here — this fake
        // has no QBO-minted lines to adopt.
        assert.deepEqual(await res.json(), { ok: true, statementImportId: "stmt-1", inserted: 2, existing: 0, adopted: 0 });
        const call = createStatementImportCalls[0] as { lines: Array<{ sequence: number }> };
        assert.equal(call.lines.length, 2);
        assert.notEqual(call.lines[0].sequence, call.lines[1].sequence);
    });
});

test("bank-ledger ingest: statement semantic validation", async t => {
    await t.test("400 line-date-outside-period when a line falls before periodStart", async () => {
        const { handlers, createStatementImportCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(statementBody({
            lines: [{ postedDate: "2026-06-30", amountCents: -7400, rawDescriptor: "US MARKET" }],
        })));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "line-date-outside-period");
        assert.equal(createStatementImportCalls.length, 0);
    });

    await t.test("400 line-date-outside-period when a line falls after periodEnd", async () => {
        const { handlers, createStatementImportCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(statementBody({
            lines: [{ postedDate: "2026-08-01", amountCents: -7400, rawDescriptor: "US MARKET" }],
        })));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "line-date-outside-period");
        assert.equal(createStatementImportCalls.length, 0);
    });

    await t.test("400 balance-mismatch when openingCents + sum(lines) !== closingCents", async () => {
        const { handlers, createStatementImportCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(statementBody({ closingCents: 92601 })));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "balance-mismatch");
        assert.equal(createStatementImportCalls.length, 0);
    });

    await t.test("nothing is written when semantic validation fails (rejected before the DB call)", async () => {
        const { handlers, createStatementImportCalls } = makeHandlers();
        await handlers.POST(makeRequest(statementBody({ closingCents: 0 })));
        assert.equal(createStatementImportCalls.length, 0);
    });

    await t.test("passes through to insertion when the statement is semantically valid", async () => {
        const { handlers, createStatementImportCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(statementBody()));
        assert.equal(res.status, 200);
        assert.equal(createStatementImportCalls.length, 1);
    });
});

test("bank-ledger ingest: QBO_REGISTER", async t => {
    function qboBody(lines: unknown[], account = "WTB-0723") {
        return { source: "QBO_REGISTER", account, lines };
    }

    await t.test("inserts new QBO observations and reports existing=0", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, inserted: 1, existing: 0, descriptorsRefreshed: 0, clearedRefreshed: 0 });
        assert.equal(createQboObservationsCalls.length, 1);
    });

    await t.test("normalizes blank check numbers to null before persistence", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: "", qbTxnId: "qb-1" },
            { postedDate: "2026-07-17", amountCents: -5100, rawDescriptor: "OTHER VENDOR", checkNumber: "   ", qbTxnId: "qb-2" },
        ])));

        assert.equal(res.status, 200);
        const persisted = createQboObservationsCalls as Array<{ checkNumber: string | null }>;
        assert.equal(persisted[0].checkNumber, null);
        assert.equal(persisted[1].checkNumber, null);
    });

    await t.test("400 invalid-line when qbTxnId is missing", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
        ])));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-line");
    });

    await t.test("409 qbo-txn-conflict when a stored qbTxnId is retried with different content", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null }],
            ]),
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7401, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 409);
        assert.equal((await res.json()).reason, "qbo-txn-conflict");
        assert.equal(createQboObservationsCalls.length, 0);
    });

    await t.test("200 no-op (existing=1) when a stored qbTxnId is retried with IDENTICAL content", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null }],
            ]),
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, inserted: 0, existing: 1, descriptorsRefreshed: 0, clearedRefreshed: 0 });
        assert.equal(createQboObservationsCalls.length, 0);
    });

    await t.test("a row that CLEARS since last night is refreshed, never a restatement conflict", async () => {
        // Codex PR #443 gate, finding 1. Clearance is mutable state: every
        // uncleared row is expected to clear eventually. If it were part of the
        // content hash that ordinary transition would answer 409 and stall the
        // nightly pull on rows that had not changed at all.
        const refreshed: Array<{ qbTxnId: string; clearedStatus: string }> = [];
        const { handlers, createQboObservationsCalls } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null, clearedStatus: "Uncleared" }],
            ]),
            refreshQboClearedStatus: async (_account, rows) => { refreshed.push(...rows); return rows.length; },
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1", clearedStatus: "Reconciled" },
        ])));
        assert.equal(res.status, 200, "a clearance change is not a restatement");
        assert.deepEqual(await res.json(), { ok: true, inserted: 0, existing: 1, descriptorsRefreshed: 0, clearedRefreshed: 1 });
        assert.deepEqual(refreshed, [{ qbTxnId: "qb-1", clearedStatus: "Reconciled" }]);
        assert.equal(createQboObservationsCalls.length, 0, "and no second observation is minted for it");
    });

    await t.test("\"Unknown\" never overwrites a stored clearance", async () => {
        // "Unknown" is what a FAILED clearance probe produces. Letting it land
        // would wipe every stored answer on the first bad night, after which
        // nothing could mint until QuickBooks was asked again.
        const refreshed: unknown[] = [];
        const { handlers } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null, clearedStatus: "Reconciled" }],
            ]),
            refreshQboClearedStatus: async (_account, rows) => { refreshed.push(...rows); return rows.length; },
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1", clearedStatus: "Unknown" },
        ])));
        assert.equal(res.status, 200);
        assert.equal((await res.json()).clearedRefreshed, 0);
        assert.deepEqual(refreshed, [], "absence of evidence does not erase evidence");
    });

    await t.test("a new observation stores the clearance it came with, and an absent one is Unknown", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1", clearedStatus: "Cleared" },
            { postedDate: "2026-07-17", amountCents: -100, rawDescriptor: "ARCO", qbTxnId: "qb-2" },
        ])));
        assert.equal(res.status, 200);
        assert.deepEqual(
            (createQboObservationsCalls as Array<{ qbTxnId: string; clearedStatus: string }>).map(r => [r.qbTxnId, r.clearedStatus]),
            [["qb-1", "Cleared"], ["qb-2", "Unknown"]],
        );
    });

    await t.test("400 invalid-line when clearedStatus is present but not a value QuickBooks uses", async () => {
        // A typo must never read as a clearance — the closed set is enforced at
        // the boundary, which is why the column carries no CHECK constraint.
        const { handlers, createQboObservationsCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1", clearedStatus: "reconciled" },
        ])));
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { ok: false, reason: "invalid-line", index: 0, field: "clearedStatus" });
        assert.equal(createQboObservationsCalls.length, 0);
    });

    await t.test("409 qbo-duplicate-conflict when the SAME request carries one qbTxnId with two different contents", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
            { postedDate: "2026-07-16", amountCents: -7401, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 409);
        assert.equal((await res.json()).reason, "qbo-duplicate-conflict");
        assert.equal(createQboObservationsCalls.length, 0);
    });

    await t.test("identical duplicate qbTxnId within one request collapses to a single insert", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, inserted: 1, existing: 1, descriptorsRefreshed: 0, clearedRefreshed: 0 });
        assert.equal(createQboObservationsCalls.length, 1);
    });

    await t.test("Codex round-3 defect 7a / round-4 fix 2: a concurrent request that wins the createMany(skipDuplicates) race with DIFFERENT content 409s, never a silent 200", async () => {
        const { handlers } = makeHandlers({
            findExistingQboObservations: async () => new Map(), // pre-insert check: nothing stored yet
            // Real implementation: create + re-read + compare run inside ONE
            // transaction, and a content mismatch throws QboIngestConflictError
            // from INSIDE it (Codex round-4 fix 2) — the route never sees a
            // plain "0 inserted" return for this case, only the throw.
            createQboObservations: async () => {
                throw new QboIngestConflictError("qb-1");
            },
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.reason, "qbo-txn-conflict");
        assert.equal(body.qbTxnId, "qb-1");
        assert.equal("inserted" in body, false, "a conflict response must never carry a partial-success inserted count");
    });

    await t.test("Codex round-3 defect 7a: a lost race with IDENTICAL content is a benign no-op, not a 409", async () => {
        const { handlers } = makeHandlers({
            findExistingQboObservations: async () => new Map(),
            // The concurrent winner inserted the SAME content we tried to —
            // createQboObservations detects that internally and returns the
            // real inserted count (0, since our row wasn't the one that
            // landed) instead of throwing.
            createQboObservations: async () => 0,
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.inserted, 0);
        assert.equal(body.existing, 1);
    });

    await t.test("Codex round-4 fix 2: a conflict rolls back the whole batch — no partial-success fields leak into the 409 response for a mixed batch", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers({
            findExistingQboObservations: async () => new Map(), // pre-insert check: neither id stored yet
            createQboObservations: async rows => {
                createQboObservationsCalls.push(...rows);
                // Simulates the real create+recheck+compare transaction: BOTH
                // rows are attempted together in ONE call, and a conflict on
                // EITHER one throws for the whole call — there is no code path
                // where the route could report qb-1 as inserted while qb-2
                // 409s, because the DB implementation's transaction rolls
                // both back together.
                throw new QboIngestConflictError("qb-2");
            },
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
            { postedDate: "2026-07-17", amountCents: -5000, rawDescriptor: "OTHER VENDOR", qbTxnId: "qb-2" },
        ])));
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.deepEqual(body, { ok: false, reason: "qbo-txn-conflict", qbTxnId: "qb-2" });
        // Both rows were attempted together in the one createQboObservations
        // call — proving the route hands the whole batch to a single
        // atomic operation rather than inserting row-by-row.
        assert.equal(createQboObservationsCalls.length, 2);
    });

    await t.test("a body with no onConflict aborts, exactly as before", async () => {
        // AC1. The standalone runners (post-qbo-register.mjs,
        // parse-wtb-daily-csv.mjs) send no mode and must be untouched.
        const { handlers, createQboObservationsCalls } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null }],
            ]),
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7401, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.deepEqual(body, { ok: false, reason: "qbo-txn-conflict", qbTxnId: "qb-1" });
        assert.equal("conflicts" in body, false, "abort mode's response shape does not change");
        assert.equal(createQboObservationsCalls.length, 0);
    });

    await t.test("400 invalid-conflict-mode when onConflict is present but unrecognised", async () => {
        // The same "a typo must never read as a mode" rule as clearedStatus:
        // `onConflict: "quarantne"` silently aborting would be the worst of both.
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({
            ...qboBody([{ postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" }]),
            onConflict: "quarantne",
        }));
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { ok: false, reason: "invalid-conflict-mode" });
    });

    await t.test("Codex round-3 defect 7b: a representation-only difference (whitespace, empty-string checkNumber) does NOT 409", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US  MARKET", checkNumber: "" }],
            ]),
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.inserted, 0);
        assert.equal(body.existing, 1);
        assert.equal(createQboObservationsCalls.length, 0);
    });
});

test("bank-ledger ingest: QBO_REGISTER restatement quarantine", async t => {
    /**
     * One transaction a human edited in QuickBooks used to roll back the whole
     * nightly batch: the pull's freshness stamp never advanced, `bank-pull-stale`
     * fired after 36h, and the receipt chaser blocked indefinitely. Quarantine
     * mode excludes that line and commits the rest.
     *
     * It is NOT partial success. The check runs BEFORE any row is touched, from
     * data already in hand — so the response describes a complete operation over
     * a smaller set. The post-insert race path is a different thing entirely and
     * still aborts (see below).
     */
    function qboBody(lines: unknown[], account = "WTB-0723") {
        return { source: "QBO_REGISTER", account, lines, onConflict: "quarantine" };
    }
    const stored = (over: Record<string, unknown> = {}) => ({
        postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", checkNumber: null, ...over,
    });

    await t.test("AC2: the rest of the batch commits, and the conflict is reported", async () => {
        const { handlers, createQboObservationsCalls } = makeHandlers({
            findExistingQboObservations: async () => new Map([["qb-2", stored()]]),
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-15", amountCents: -100, rawDescriptor: "ARCO", qbTxnId: "qb-1" },
            { postedDate: "2026-07-16", amountCents: -7401, rawDescriptor: "US MARKET", qbTxnId: "qb-2" },
            { postedDate: "2026-07-17", amountCents: -200, rawDescriptor: "NAPA", qbTxnId: "qb-3" },
        ])));
        assert.equal(res.status, 200, "one edited transaction must not stop the register");
        const body = await res.json();
        assert.deepEqual(
            (createQboObservationsCalls as Array<{ qbTxnId: string }>).map(row => row.qbTxnId),
            ["qb-1", "qb-3"],
            "the two clean ids land; the restated one is not written",
        );
        assert.equal(body.conflicted, 1);
        assert.equal(body.conflicts[0].qbTxnId, "qb-2");
        assert.deepEqual(body.conflicts[0].fields, ["amountCents"]);
        assert.deepEqual(body.conflicts[0].stored, { postedDate: "2026-07-16", amountCents: -7400, checkNumber: null });
        assert.deepEqual(body.conflicts[0].fresh, { postedDate: "2026-07-16", amountCents: -7401, checkNumber: null });
        // NO LINE TEXT LEAVES THIS ROUTE — a payee move is a flag, never words.
        assert.equal(JSON.stringify(body).includes("US MARKET"), false);
    });

    await t.test("AC3: a conflicted line is neither inserted nor `existing`", async () => {
        const { handlers } = makeHandlers({
            findExistingQboObservations: async () => new Map([["qb-2", stored()]]),
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-15", amountCents: -100, rawDescriptor: "ARCO", qbTxnId: "qb-1" },
            { postedDate: "2026-07-16", amountCents: -7401, rawDescriptor: "US MARKET", qbTxnId: "qb-2" },
            { postedDate: "2026-07-17", amountCents: -200, rawDescriptor: "NAPA", qbTxnId: "qb-3" },
        ])));
        const body = await res.json();
        assert.equal(body.inserted, 2);
        assert.equal(body.existing, 0, "counting it as existing is the partial-success lie in a different costume");
        assert.equal(body.inserted + body.existing + body.conflicted, 3);
    });

    await t.test("AC4: not one column on a quarantined row is touched", async () => {
        const descriptors: unknown[] = [];
        const cleared: unknown[] = [];
        const { handlers, createQboObservationsCalls } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", stored({ clearedStatus: "Uncleared" })],
            ]),
            refreshQboDescriptors: async (_account, rows) => { descriptors.push(...rows); return rows.length; },
            refreshQboClearedStatus: async (_account, rows) => { cleared.push(...rows); return rows.length; },
        });
        // A new amount AND a new descriptor AND a new clearance, all at once.
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -9999, rawDescriptor: "US MARKET STORE 12", qbTxnId: "qb-1", clearedStatus: "Reconciled" },
        ])));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.conflicted, 1);
        assert.deepEqual(descriptors, [], "the stored descriptor stays as it is");
        assert.deepEqual(cleared, [], "and so does the stored clearance — we have declared this row stale");
        assert.equal(body.descriptorsRefreshed, 0);
        assert.equal(body.clearedRefreshed, 0);
        assert.equal(createQboObservationsCalls.length, 0);
    });

    await t.test("AC5: a descriptor-only change still refreshes, and is not a conflict", async () => {
        // The round-3 defect-7b fixture, in quarantine mode.
        const descriptors: unknown[] = [];
        const { handlers } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", stored({ rawDescriptor: "US  MARKET", checkNumber: "" })],
            ]),
            refreshQboDescriptors: async (_account, rows) => { descriptors.push(...rows); return rows.length; },
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET POS DEB C#8516", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.conflicted, 0);
        assert.deepEqual(body.conflicts, []);
        assert.equal(descriptors.length, 1, "same identity, newer words: take the newer words");
    });

    await t.test("AC6: the post-insert race still aborts, in quarantine mode too", async () => {
        /**
         * That conflict is discovered INSIDE createQboObservations' own
         * transaction, after the createMany — the only honest answer there is to
         * roll everything back and 409 with no counts. The next run's
         * deterministic pre-check quarantines it; no special case needed.
         */
        const { handlers } = makeHandlers({
            findExistingQboObservations: async () => new Map(),
            createQboObservations: async () => { throw new QboIngestConflictError("qb-1"); },
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
        ])));
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.deepEqual(body, { ok: false, reason: "qbo-txn-conflict", qbTxnId: "qb-1" });
        assert.equal("inserted" in body, false, "a conflict response must never carry a partial-success inserted count");
    });

    await t.test("AC7: `linked` says whether the stale row is already in the canonical ledger", async () => {
        const { handlers } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", stored({ bankLineId: "line-1" })],
                ["qb-2", stored({ bankLineId: null })],
            ]),
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7401, rawDescriptor: "US MARKET", qbTxnId: "qb-1" },
            { postedDate: "2026-07-18", amountCents: -7400, rawDescriptor: "US MARKET", qbTxnId: "qb-2" },
        ])));
        const body = await res.json();
        assert.equal(body.conflicts.length, 2);
        const byId = Object.fromEntries(body.conflicts.map((c: { qbTxnId: string }) => [c.qbTxnId, c]));
        assert.equal(byId["qb-1"].linked, true, "its amountCents is immutable by trigger — only a human can fix that one");
        assert.equal(byId["qb-2"].linked, false);
        assert.deepEqual(byId["qb-2"].fields, ["postedDate"]);
    });

    await t.test("a payee change is reported as a flag, and a check-number change by name", async () => {
        const { handlers } = makeHandlers({
            findExistingQboObservations: async () => new Map([
                ["qb-1", stored({ rawDescriptor: "US MARKET", checkNumber: "1027" })],
            ]),
        });
        const res = await handlers.POST(makeRequest(qboBody([
            { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "PACIFIC PLUMBING", checkNumber: "1028", qbTxnId: "qb-1" },
        ])));
        const body = await res.json();
        assert.deepEqual(body.conflicts[0].fields, ["checkNumber", "payee"]);
        assert.equal(JSON.stringify(body).includes("PACIFIC"), false, "no descriptor text leaves this route");
    });
});
