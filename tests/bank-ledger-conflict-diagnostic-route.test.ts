import assert from "node:assert/strict";
import test from "node:test";
import { hasCronSecret } from "../src/lib/cron-auth";
import {
    createConflictDiagnosticHandlers,
    createStoredReader,
    rollingWindow,
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
    };
    return {
        handlers: createConflictDiagnosticHandlers({ ...defaults, ...overrides }),
        storedCalls,
        reads: () => storedCalls.length + registerCalls,
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

test("conflict diagnostic: stored adapter is scoped to WTB-0723 / QBO_REGISTER / exact id, five columns, two rows", async () => {
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
        select: { postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, sourceLineId: true },
        take: 2,
    });
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
    const stored: StoredObservationRow[] = [{
        postedDate: new Date("2026-08-20T00:00:00.000Z"),
        amountCents: -12345,
        rawDescriptor: "HOME DEPOT #1234",
        checkNumber: null,
        sourceLineId: "6456",
    }];
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
    assert.deepEqual(body.stored, [{
        postedDate: "2026-08-20",
        amountCents: -12345,
        rawDescriptor: "HOME DEPOT #1234",
        checkNumber: null,
        sourceLineId: "6456",
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
});
