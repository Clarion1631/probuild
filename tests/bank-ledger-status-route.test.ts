import assert from "node:assert/strict";
import test from "node:test";
import { GET as liveGET } from "../src/app/api/integrations/bank-ledger/status/route";
import {
    createBankLedgerStatusHandlers,
    type BankLedgerStatusHandlerDependencies,
} from "../src/app/api/integrations/bank-ledger/status/route";

const SECRET = "test-ledger-status-secret";

function makeRequest(query: string, headers: Record<string, string> = { "x-ledger-status-key": SECRET }) {
    return new Request(`http://localhost/api/integrations/bank-ledger/status?${query}`, { headers });
}

function makeHandlers(overrides: Partial<BankLedgerStatusHandlerDependencies> = {}) {
    const listCalls: Array<{ account: string; from: Date; to: Date }> = [];
    const defaults: BankLedgerStatusHandlerDependencies = {
        getStatusSecret: () => SECRET,
        listStatementImports: async input => {
            listCalls.push(input);
            return [];
        },
    };
    return {
        handlers: createBankLedgerStatusHandlers({ ...defaults, ...overrides }),
        listCalls,
    };
}

const VALID_QUERY = "account=WTB-0723&from=2026-08-03&to=2026-08-03";

test("bank-ledger status: authorization fails closed", async t => {
    await t.test("401 when x-ledger-status-key is missing or wrong", async () => {
        const { handlers, listCalls } = makeHandlers();
        const missing = await handlers.GET(makeRequest(VALID_QUERY, {}));
        const wrong = await handlers.GET(makeRequest(VALID_QUERY, { "x-ledger-status-key": "wrong" }));
        assert.equal(missing.status, 401);
        assert.equal(wrong.status, 401);
        assert.deepEqual(await missing.json(), { ok: false, reason: "unauthorized" });
        assert.equal(listCalls.length, 0);
    });

    await t.test("401 when the status secret is not configured", async () => {
        const { handlers, listCalls } = makeHandlers({ getStatusSecret: () => undefined });
        const response = await handlers.GET(makeRequest(VALID_QUERY));
        assert.equal(response.status, 401);
        assert.equal(listCalls.length, 0);
    });

    await t.test("the production route reads only BANK_LEDGER_STATUS_SECRET for this gate", async () => {
        const previous = process.env.BANK_LEDGER_STATUS_SECRET;
        process.env.BANK_LEDGER_STATUS_SECRET = "runtime-status-secret";
        try {
            const response = await liveGET(makeRequest(VALID_QUERY, { "x-ledger-status-key": "wrong" }));
            assert.equal(response.status, 401);
            assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
        } finally {
            if (previous === undefined) delete process.env.BANK_LEDGER_STATUS_SECRET;
            else process.env.BANK_LEDGER_STATUS_SECRET = previous;
        }
    });
});

test("bank-ledger status: strict WTB scope and range validation", async t => {
    await t.test("400 rejects every account other than exactly WTB-0723", async () => {
        const { handlers, listCalls } = makeHandlers();
        const response = await handlers.GET(makeRequest("account=WTB-9999&from=2026-08-03&to=2026-08-03"));
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { ok: false, reason: "invalid-account" });
        assert.equal(listCalls.length, 0);
    });

    await t.test("400 rejects malformed, impossible, reversed, missing, and duplicate dates", async () => {
        const { handlers, listCalls } = makeHandlers();
        const queries = [
            "account=WTB-0723&from=2026-02-30&to=2026-08-03",
            "account=WTB-0723&from=2026-08-03&to=08-03-2026",
            "account=WTB-0723&from=2026-08-04&to=2026-08-03",
            "account=WTB-0723&from=2026-08-03",
            "account=WTB-0723&from=2026-08-03&from=2026-08-04&to=2026-08-03",
        ];
        for (const query of queries) {
            const response = await handlers.GET(makeRequest(query));
            assert.equal(response.status, 400, query);
        }
        assert.equal(listCalls.length, 0);
    });

    await t.test("accepts exactly fourteen inclusive calendar days", async () => {
        const { handlers, listCalls } = makeHandlers();
        const response = await handlers.GET(makeRequest("account=WTB-0723&from=2026-08-01&to=2026-08-14"));
        assert.equal(response.status, 200);
        assert.equal(listCalls.length, 1);
    });

    await t.test("400 rejects an inclusive range longer than fourteen calendar days", async () => {
        const { handlers, listCalls } = makeHandlers();
        const response = await handlers.GET(makeRequest("account=WTB-0723&from=2026-08-01&to=2026-08-15"));
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { ok: false, reason: "range-too-large", maxDays: 14 });
        assert.equal(listCalls.length, 0);
    });
});

test("bank-ledger status: returns only the documented DB facts", async t => {
    await t.test("returns exact public shape, sorted by import period, with no transaction detail", async () => {
        const { handlers, listCalls } = makeHandlers({
            listStatementImports: async input => {
                listCalls.push(input);
                return [
                    {
                        periodStart: new Date("2026-08-04T00:00:00.000Z"),
                        periodEnd: new Date("2026-08-04T00:00:00.000Z"),
                        status: "FINALIZED",
                        openingCents: 12345,
                        closingCents: 67890,
                        contentHash: "hash-2",
                        lineCount: 2,
                    },
                    {
                        periodStart: new Date("2026-08-03T00:00:00.000Z"),
                        periodEnd: new Date("2026-08-03T00:00:00.000Z"),
                        status: "FINALIZED",
                        openingCents: 10000,
                        closingCents: 12345,
                        contentHash: "hash-1",
                        lineCount: 1,
                    },
                ];
            },
        });

        const response = await handlers.GET(makeRequest("account=WTB-0723&from=2026-08-03&to=2026-08-04"));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            ok: true,
            account: "WTB-0723",
            imports: [
                {
                    periodStart: "2026-08-03",
                    periodEnd: "2026-08-03",
                    status: "FINALIZED",
                    openingCents: 10000,
                    closingCents: 12345,
                    lineCount: 1,
                    contentHash: "hash-1",
                },
                {
                    periodStart: "2026-08-04",
                    periodEnd: "2026-08-04",
                    status: "FINALIZED",
                    openingCents: 12345,
                    closingCents: 67890,
                    lineCount: 2,
                    contentHash: "hash-2",
                },
            ],
        });
        assert.equal(listCalls.length, 1);
        assert.equal(listCalls[0].account, "WTB-0723");
        assert.equal(listCalls[0].from.toISOString(), "2026-08-03T00:00:00.000Z");
        assert.equal(listCalls[0].to.toISOString(), "2026-08-04T00:00:00.000Z");
    });

    await t.test("returns an empty imports array for a missing day", async () => {
        const { handlers } = makeHandlers();
        const response = await handlers.GET(makeRequest(VALID_QUERY));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, account: "WTB-0723", imports: [] });
    });
});
