import assert from "node:assert/strict";
import test from "node:test";
import { hasCronSecret } from "../src/lib/cron-auth";
import {
    createConflictDiagnosticHandlers,
    createPurchaseReader,
    createStoredReader,
    projectPurchase,
    rollingWindow,
    STORED_SELECT,
    type ConflictDiagnosticDependencies,
    type StoredObservationRow,
} from "../src/app/api/integrations/bank-ledger/conflict-diagnostic/route";
import type { BankRegisterResult } from "../src/lib/qbo-bank-register";

const SECRET = "test-cron-secret";

function makeRequest(query: string, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
    return new Request(`http://localhost/api/integrations/bank-ledger/conflict-diagnostic?${query}`, { headers });
}

function emptyRegister(): BankRegisterResult {
    return {
        rows: [],
        fetchedAt: "2026-09-09T05:00:00.000Z",
        stale: false,
        clearedProbeOk: true,
        accountId: "154",
        startDate: "2026-07-12",
        endDate: "2026-09-09",
    };
}

function makeHandlers(overrides: Partial<ConflictDiagnosticDependencies> = {}) {
    const storedCalls: string[] = [];
    const purchaseCalls: Array<[string, string]> = [];
    let registerCalls = 0;
    const defaults: ConflictDiagnosticDependencies = {
        authorize: request => request.headers.get("authorization") === `Bearer ${SECRET}`,
        readStored: async id => {
            storedCalls.push(id);
            return [];
        },
        readRegister: async () => {
            registerCalls += 1;
            return emptyRegister();
        },
        readPurchase: async (id, accountId) => {
            purchaseCalls.push([id, accountId]);
            return null;
        },
    };
    return {
        handlers: createConflictDiagnosticHandlers({ ...defaults, ...overrides }),
        storedCalls,
        purchaseCalls,
        reads: () => storedCalls.length + registerCalls + purchaseCalls.length,
    };
}

function storedRow(overrides: Partial<StoredObservationRow> = {}): StoredObservationRow {
    return {
        id: "obs_qbo_1",
        createdAt: new Date("2026-08-06T04:00:00.000Z"),
        bankLineId: null,
        postedDate: new Date("2026-08-05T00:00:00.000Z"),
        amountCents: -2195,
        rawDescriptor: "Uber Expense",
        checkNumber: null,
        sourceLineId: "6456",
        bankLine: null,
        ...overrides,
    };
}

function expenseRegister(): BankRegisterResult {
    return {
        ...emptyRegister(),
        rows: [
            { date: "2026-07-30", qbType: "Expense", qbTxnId: "6456", docNum: null, name: "Uber", memo: "Shop", amountCents: -2195, clearedStatus: "Cleared" },
        ],
    };
}

function fullPurchase() {
    return {
        Id: "6456",
        TxnDate: "2026-07-30",
        TotalAmt: 21.95,
        EntityRef: { name: "Uber", value: "88", type: "Vendor" },
        AccountRef: { name: "WTB Checking", value: "154" },
        PrivateNote: "Shop",
        DocNumber: null,
        SyncToken: "2",
        MetaData: { CreateTime: "2026-07-30T10:00:00-07:00", LastUpdatedTime: "2026-08-06T09:00:00-07:00" },
        Line: [{ Amount: 21.95, Description: "should not leak" }],
        PaymentType: "CreditCard",
    };
}

test("conflict diagnostic: authorization fails closed", async t => {
    await t.test("401 when the bearer is missing or wrong, with no reads", async () => {
        const { handlers, reads } = makeHandlers();
        const missing = await handlers.GET(makeRequest("qbTxnId=6456", {}));
        const wrong = await handlers.GET(makeRequest("qbTxnId=6456", { authorization: "Bearer nope" }));
        assert.equal(missing.status, 401);
        assert.equal(wrong.status, 401);
        assert.deepEqual(await missing.json(), { ok: false, reason: "unauthorized" });
        assert.equal(reads(), 0);
    });

    await t.test("401 via the real hasCronSecret when CRON_SECRET is absent, even in development", async () => {
        const previousSecret = process.env.CRON_SECRET;
        const previousEnv = process.env.NODE_ENV;
        delete process.env.CRON_SECRET;
        (process.env as Record<string, string>).NODE_ENV = "development";
        try {
            const { handlers, reads } = makeHandlers({ authorize: hasCronSecret });
            const response = await handlers.GET(makeRequest("qbTxnId=6456", { authorization: "Bearer anything" }));
            assert.equal(response.status, 401);
            assert.equal(reads(), 0);
        } finally {
            if (previousSecret === undefined) delete process.env.CRON_SECRET;
            else process.env.CRON_SECRET = previousSecret;
            (process.env as Record<string, string>).NODE_ENV = previousEnv ?? "test";
        }
    });
});

test("conflict diagnostic: query validation happens before any read", async () => {
    const { handlers, reads } = makeHandlers();
    const queries = [
        "",
        "qbTxnId=",
        "qbTxnId=abc",
        "qbTxnId=64x56",
        "qbTxnId=123456789012345678901",
        "qbTxnId=6456&qbTxnId=6457",
        "qbTxnId=6456&account=WTB-0723",
        "account=WTB-0723",
        "qbtxnid=6456",
    ];
    for (const query of queries) {
        const response = await handlers.GET(makeRequest(query));
        assert.equal(response.status, 400, query || "<empty>");
        assert.deepEqual(await response.json(), { ok: false, reason: "invalid-query" });
    }
    assert.equal(reads(), 0);
});

test("conflict diagnostic: stored adapter is scoped to WTB-0723 / QBO_REGISTER / exact id with a bounded nested projection", async () => {
    let received: unknown;
    const readStored = createStoredReader({
        bankLineObservation: {
            async findMany(input) {
                received = input;
                return [];
            },
        },
    });
    await readStored("6456");
    assert.deepEqual(received, {
        where: {
            source: "QBO_REGISTER",
            account: "WTB-0723",
            sourceDocumentId: "QBO_REGISTER",
            sourceLineId: "6456",
        },
        select: STORED_SELECT,
        take: 2,
    });
    // The nested projection is bounded to STATEMENT observations, ordered by id, at most three.
    const nested = STORED_SELECT.bankLine.select.observations;
    assert.deepEqual(nested.where, { source: "STATEMENT" });
    assert.deepEqual(nested.orderBy, { id: "asc" });
    assert.equal(nested.take, 3);
    // Sensitive columns are never selected.
    const bankLineKeys = Object.keys(STORED_SELECT.bankLine.select);
    for (const forbidden of ["receiptUrl", "projectName", "exceptionReason", "items", "imageMatches"]) {
        assert.ok(!bankLineKeys.includes(forbidden), forbidden);
    }
    assert.deepEqual(Object.keys(nested.select.statementImport.select), [
        "id", "account", "periodStart", "periodEnd", "openingCents", "closingCents", "contentHash", "status", "createdAt",
    ]);
});

test("conflict diagnostic: rolling window is 60 inclusive UTC days ending today", () => {
    const window = rollingWindow(new Date("2026-09-09T23:59:59.000Z"));
    assert.deepEqual(window, { startDate: "2026-07-12", endDate: "2026-09-09" });
});

test("conflict diagnostic: upstream failures become a sanitized 503", async t => {
    await t.test("stored read failure", async () => {
        const { handlers } = makeHandlers({
            readStored: async () => { throw new Error("SECRET-DB-DETAIL connection refused"); },
        });
        const response = await handlers.GET(makeRequest("qbTxnId=6456"));
        assert.equal(response.status, 503);
        const body = await response.text();
        assert.deepEqual(JSON.parse(body), { ok: false, reason: "upstream-unavailable" });
        assert.ok(!body.includes("SECRET-DB-DETAIL"));
    });

    await t.test("register read failure", async () => {
        const { handlers } = makeHandlers({
            readRegister: async () => { throw new Error("SECRET-QBO-DETAIL GL report 500"); },
        });
        const response = await handlers.GET(makeRequest("qbTxnId=6456"));
        assert.equal(response.status, 503);
        const body = await response.text();
        assert.deepEqual(JSON.parse(body), { ok: false, reason: "upstream-unavailable" });
        assert.ok(!body.includes("SECRET-QBO-DETAIL"));
    });
});

test("conflict diagnostic: returns raw stored and live rows for exactly the requested id", async () => {
    const stored: StoredObservationRow[] = [storedRow({
        id: "obs_1",
        createdAt: new Date("2026-08-21T04:00:00.000Z"),
        postedDate: new Date("2026-08-20T00:00:00.000Z"),
        amountCents: -12345,
        rawDescriptor: "HOME DEPOT #1234",
    })];
    const register: BankRegisterResult = {
        ...emptyRegister(),
        stale: true,
        clearedProbeOk: false,
        rows: [
            { date: "2026-08-21", qbType: "Expense", qbTxnId: "6456", docNum: null, name: "Home Depot", memo: "HOME DEPOT #1234 KNOXVILLE", amountCents: -12345, clearedStatus: "Unknown" },
            { date: "2026-08-21", qbType: "Expense", qbTxnId: "64560", docNum: null, name: "Other", memo: "OTHER", amountCents: -100, clearedStatus: "Unknown" },
            { date: "2026-08-22", qbType: "Deposit", qbTxnId: null, docNum: null, name: null, memo: null, amountCents: 500, clearedStatus: "Unknown" },
        ],
    };
    const { handlers, storedCalls } = makeHandlers({
        readStored: async id => { storedCalls.push(id); return stored; },
        readRegister: async () => register,
    });

    const response = await handlers.GET(makeRequest("qbTxnId=6456"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(storedCalls, ["6456"]);
    assert.equal(body.ok, true);
    assert.equal(body.account, "WTB-0723");
    assert.equal(body.qbTxnId, "6456");
    assert.equal(body.historyStatus, "not-recorded");
    assert.deepEqual(body.stored, [{
        id: "obs_1",
        createdAt: "2026-08-21T04:00:00.000Z",
        bankLineId: null,
        postedDate: "2026-08-20",
        amountCents: -12345,
        rawDescriptor: "HOME DEPOT #1234",
        checkNumber: null,
        sourceLineId: "6456",
        bankLine: null,
    }]);
    assert.deepEqual(body.register, {
        stale: true,
        fetchedAt: "2026-09-09T05:00:00.000Z",
        clearedProbeOk: false,
        startDate: "2026-07-12",
        endDate: "2026-09-09",
        rows: [{
            date: "2026-08-21",
            qbType: "Expense",
            qbTxnId: "6456",
            docNum: null,
            name: "Home Depot",
            memo: "HOME DEPOT #1234 KNOXVILLE",
            amountCents: -12345,
            clearedStatus: "Unknown",
        }],
    });
    assert.ok(!("matches" in body));
    assert.ok(!("conflict" in body));
    assert.ok(Array.isArray(body.limitations));
    assert.ok(body.limitations.some((line: string) => /QBO source history is not recorded/.test(line)));
    assert.ok(body.limitations.some((line: string) => /do not prove which field changed/.test(line)));
});

test("conflict diagnostic: linked bank line and statement evidence are projected exactly", async () => {
    const stored: StoredObservationRow[] = [storedRow({
        bankLineId: "bl_1",
        bankLine: {
            id: "bl_1",
            account: "WTB-0723",
            postedDate: new Date("2026-08-05T00:00:00.000Z"),
            amountCents: -2195,
            rawDescriptor: "UBER *TRIP",
            normalizedPayee: "UBER",
            checkNumber: null,
            state: "MATCHED",
            sourceOfRecord: "STATEMENT",
            qbTxnId: "6456",
            qbBankMatched: true,
            probuildExpenseId: "exp_9",
            createdAt: new Date("2026-08-06T04:00:00.000Z"),
            updatedAt: new Date("2026-09-01T04:00:00.000Z"),
            observations: [{
                id: "obs_stmt_1",
                source: "STATEMENT",
                sourceDocumentId: "imp_1",
                sourceLineId: "17",
                postedDate: new Date("2026-08-05T00:00:00.000Z"),
                amountCents: -2195,
                rawDescriptor: "UBER *TRIP",
                checkNumber: null,
                createdAt: new Date("2026-09-01T04:00:00.000Z"),
                statementImport: {
                    id: "imp_1",
                    account: "WTB-0723",
                    periodStart: new Date("2026-08-01T00:00:00.000Z"),
                    periodEnd: new Date("2026-08-31T00:00:00.000Z"),
                    openingCents: 100000,
                    closingCents: 97805,
                    contentHash: "abc123",
                    status: "FINALIZED",
                    createdAt: new Date("2026-09-01T04:00:00.000Z"),
                },
            }],
        },
    })];
    const { handlers } = makeHandlers({ readStored: async () => stored });
    const body = await (await handlers.GET(makeRequest("qbTxnId=6456"))).json();
    assert.deepEqual(body.stored, [{
        id: "obs_qbo_1",
        createdAt: "2026-08-06T04:00:00.000Z",
        bankLineId: "bl_1",
        postedDate: "2026-08-05",
        amountCents: -2195,
        rawDescriptor: "Uber Expense",
        checkNumber: null,
        sourceLineId: "6456",
        bankLine: {
            id: "bl_1",
            account: "WTB-0723",
            postedDate: "2026-08-05",
            amountCents: -2195,
            rawDescriptor: "UBER *TRIP",
            normalizedPayee: "UBER",
            checkNumber: null,
            state: "MATCHED",
            sourceOfRecord: "STATEMENT",
            qbTxnId: "6456",
            qbBankMatched: true,
            probuildExpenseId: "exp_9",
            createdAt: "2026-08-06T04:00:00.000Z",
            updatedAt: "2026-09-01T04:00:00.000Z",
            statementObservations: [{
                id: "obs_stmt_1",
                source: "STATEMENT",
                sourceDocumentId: "imp_1",
                sourceLineId: "17",
                postedDate: "2026-08-05",
                amountCents: -2195,
                rawDescriptor: "UBER *TRIP",
                checkNumber: null,
                createdAt: "2026-09-01T04:00:00.000Z",
                statementImport: {
                    id: "imp_1",
                    account: "WTB-0723",
                    periodStart: "2026-08-01",
                    periodEnd: "2026-08-31",
                    openingCents: 100000,
                    closingCents: 97805,
                    contentHash: "abc123",
                    status: "FINALIZED",
                    createdAt: "2026-09-01T04:00:00.000Z",
                },
            }],
        },
    }]);
    assert.deepEqual(body.currentPurchase, {
        status: "not-applicable",
        reason: "no Expense or Check register row for this id; Purchase entity not guessed",
    });
});

test("conflict diagnostic: Purchase is never fetched unless the register shows an Expense or Check", async () => {
    const register: BankRegisterResult = {
        ...emptyRegister(),
        rows: [
            { date: "2026-07-30", qbType: "Transfer", qbTxnId: "6456", docNum: null, name: null, memo: null, amountCents: -2195, clearedStatus: "Cleared" },
            { date: "2026-07-30", qbType: "Expense", qbTxnId: "9999", docNum: null, name: "Other", memo: null, amountCents: -1, clearedStatus: "Cleared" },
        ],
    };
    const { handlers, purchaseCalls } = makeHandlers({ readRegister: async () => register });
    const body = await (await handlers.GET(makeRequest("qbTxnId=6456"))).json();
    assert.deepEqual(purchaseCalls, []);
    assert.equal(body.currentPurchase.status, "not-applicable");
});

test("conflict diagnostic: current Purchase projection", async t => {
    await t.test("Expense row triggers one read with the register account id and returns only allow-listed fields", async () => {
        const { handlers, purchaseCalls } = makeHandlers({
            readStored: async () => [storedRow()],
            readRegister: async () => expenseRegister(),
            readPurchase: async (id, accountId) => { purchaseCalls.push([id, accountId]); return fullPurchase(); },
        });
        const response = await handlers.GET(makeRequest("qbTxnId=6456"));
        const text = await response.text();
        const body = JSON.parse(text);
        assert.deepEqual(purchaseCalls, [["6456", "154"]]);
        assert.deepEqual(body.currentPurchase, {
            status: "ok",
            purchase: {
                Id: "6456",
                TxnDate: "2026-07-30",
                TotalAmt: 21.95,
                EntityRef: { name: "Uber", value: "88" },
                AccountRef: { name: "WTB Checking", value: "154" },
                PrivateNote: "Shop",
                DocNumber: null,
                SyncToken: "2",
                MetaData: { CreateTime: "2026-07-30T10:00:00-07:00", LastUpdatedTime: "2026-08-06T09:00:00-07:00" },
            },
        });
        assert.ok(!text.includes("should not leak"));
        assert.ok(!text.includes("PaymentType"));
        assert.equal(body.stored.length, 1);
        assert.equal(body.register.rows.length, 1);
    });

    await t.test("foreign entity id or wrong AccountRef yields mismatch with no data", async () => {
        const wrongId = { ...fullPurchase(), Id: "7777" };
        const wrongAccount = { ...fullPurchase(), AccountRef: { name: "Other", value: "999" } };
        for (const raw of [wrongId, wrongAccount]) {
            const { handlers } = makeHandlers({
                readRegister: async () => expenseRegister(),
                readPurchase: async () => raw,
            });
            const text = await (await handlers.GET(makeRequest("qbTxnId=6456"))).text();
            const body = JSON.parse(text);
            assert.deepEqual(body.currentPurchase, { status: "mismatch" });
            assert.ok(!JSON.stringify(body.currentPurchase).includes("Uber"));
            assert.ok(!text.includes("7777"));
            assert.ok(!text.includes("999"));
        }
        assert.deepEqual(projectPurchase(wrongId, "6456", "154"), { status: "mismatch" });
    });

    await t.test("404 and read failure degrade to unavailable without hiding stored GL evidence", async () => {
        for (const readPurchase of [
            async () => null,
            async () => { throw new Error("SECRET-PURCHASE-DETAIL 500"); },
        ]) {
            const { handlers } = makeHandlers({
                readStored: async () => [storedRow()],
                readRegister: async () => expenseRegister(),
                readPurchase,
            });
            const response = await handlers.GET(makeRequest("qbTxnId=6456"));
            assert.equal(response.status, 200);
            const text = await response.text();
            const body = JSON.parse(text);
            assert.ok(!text.includes("SECRET-PURCHASE-DETAIL"));
            assert.deepEqual(body.currentPurchase, { status: "unavailable" });
            assert.equal(body.stored[0].rawDescriptor, "Uber Expense");
            assert.equal(body.register.rows[0].memo, "Shop");
        }
    });
});

test("conflict diagnostic: purchase reader uses GET /purchase/{id} with a 10s deadline and no writes", async t => {
    const tokens = { accessToken: "at", refreshToken: "rt", realmId: "realm" };
    const sentinelDeadline = { until: 123 };
    function reader(response: Response) {
        const calls: Array<{ path: string; opts: unknown }> = [];
        const deadlines: number[] = [];
        const read = createPurchaseReader({
            fetch: (async (path: string, _tokens: unknown, opts: unknown) => { calls.push({ path, opts }); return response; }) as never,
            tokens: (async (deadline: unknown) => { assert.equal(deadline, sentinelDeadline); return tokens; }) as never,
            deadline: ((ms: number) => { deadlines.push(ms); return sentinelDeadline; }) as never,
        });
        return { read, calls, deadlines };
    }

    await t.test("200 returns the raw Purchase", async () => {
        const { read, calls, deadlines } = reader(new Response(JSON.stringify({ Purchase: fullPurchase() }), { status: 200 }));
        const raw = await read("6456");
        assert.deepEqual(raw, fullPurchase());
        assert.deepEqual(calls, [{ path: "/purchase/6456", opts: { qbDeadline: sentinelDeadline } }]);
        assert.deepEqual(deadlines, [10_000]);
    });

    await t.test("404 returns null", async () => {
        const { read } = reader(new Response("", { status: 404 }));
        assert.equal(await read("6456"), null);
    });

    await t.test("other statuses throw", async () => {
        const { read } = reader(new Response("boom", { status: 500 }));
        await assert.rejects(read("6456"));
    });
});


test("conflict diagnostic: malformed optional Purchase strings remain null", () => {
    const projected = projectPurchase({ ...fullPurchase(), PrivateNote: { unexpected: true }, SyncToken: [] }, "6456", "154");
    assert.equal(projected.status, "ok");
    if (projected.status === "ok") {
        assert.equal(projected.purchase.PrivateNote, null);
        assert.equal(projected.purchase.SyncToken, null);
    }
});
