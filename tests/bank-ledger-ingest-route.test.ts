import assert from "node:assert/strict";
import test from "node:test";
import { createBankLedgerIngestHandlers, type BankLedgerIngestHandlerDependencies } from "../src/app/api/integrations/bank-ledger/ingest/route";
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
        findExistingQboObservations: async () => new Set(),
        createQboObservations: async rows => {
            createQboObservationsCalls.push(...rows);
            return rows.length;
        },
    };
    const handlers = createBankLedgerIngestHandlers({ ...defaults, ...overrides });
    return { handlers, createStatementImportCalls, createQboObservationsCalls };
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
        const lines = Array.from({ length: 20001 }, (_, i) => ({ postedDate: "2026-01-01", amountCents: -100 - i, rawDescriptor: "X" }));
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
            closingCents: 200000,
            lines: [
                { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET US MARKET POS DEB 1027" },
                { postedDate: "2026-07-17", amountCents: 500000, rawDescriptor: "DEPOSIT" },
            ],
        }));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, statementImportId: "stmt-1", inserted: 2, existing: 0 });
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
        assert.deepEqual(await res.json(), { ok: true, statementImportId: "stmt-1", inserted: 2, existing: 0 });
        const call = createStatementImportCalls[0] as { lines: Array<{ sequence: number }> };
        assert.equal(call.lines.length, 2);
        assert.notEqual(call.lines[0].sequence, call.lines[1].sequence);
    });
});
