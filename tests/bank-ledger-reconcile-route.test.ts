import assert from "node:assert/strict";
import test from "node:test";
import {
    createBankLedgerReconcileHandlers,
    type BankLedgerReconcileHandlerDependencies,
    type PersistedReconciliation,
} from "../src/app/api/integrations/bank-ledger/reconcile/route";
import type { ReconcileLink } from "../src/lib/bank-ledger";

const SECRET = "test-secret";

function makeRequest(body?: unknown, headers: Record<string, string> = { "x-ingest-key": SECRET }) {
    return new Request("http://localhost/api/integrations/bank-ledger/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function makeHandlers(overrides: Partial<BankLedgerReconcileHandlerDependencies> = {}) {
    const persistLinksCalls: ReconcileLink[][] = [];
    const defaults: BankLedgerReconcileHandlerDependencies = {
        getIngestSecret: () => SECRET,
        findUnlinkedQboObservations: async () => [],
        findCandidateBankLines: async () => [],
        persistLinks: async (links): Promise<PersistedReconciliation> => {
            persistLinksCalls.push(links);
            return { linked: links.map(l => l.observationId), exceptions: [] };
        },
    };
    const handlers = createBankLedgerReconcileHandlers({ ...defaults, ...overrides });
    return { handlers, persistLinksCalls };
}

test("bank-ledger reconcile: auth", async t => {
    await t.test("401 when x-ingest-key is missing", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({}, {}));
        assert.equal(res.status, 401);
    });

    await t.test("401 when x-ingest-key is wrong", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({}, { "x-ingest-key": "wrong" }));
        assert.equal(res.status, 401);
    });

    await t.test("401 when the server has no configured secret (never falls open)", async () => {
        const { handlers } = makeHandlers({ getIngestSecret: () => undefined });
        const res = await handlers.POST(makeRequest({}, { "x-ingest-key": "" }));
        assert.equal(res.status, 401);
    });
});

test("bank-ledger reconcile: validation", async t => {
    await t.test("400 invalid-account when account is not a non-empty string", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ account: "" }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-account");
    });

    await t.test("400 invalid-json on malformed body", async () => {
        const { handlers } = makeHandlers();
        const req = new Request("http://localhost/x", { method: "POST", headers: { "x-ingest-key": SECRET }, body: "{not json" });
        const res = await handlers.POST(req);
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-json");
    });

    await t.test("account is optional — an empty body reconciles across all accounts", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest());
        assert.equal(res.status, 200);
    });
});

test("bank-ledger reconcile: happy path", async t => {
    await t.test("proposes nothing and never calls persistLinks when there is nothing to reconcile", async () => {
        const { handlers, persistLinksCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest({}));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, proposed: 0, linked: 0, exceptions: [] });
        assert.equal(persistLinksCalls.length, 0);
    });

    await t.test("proposes and persists a link on an exact account+date+amount+payee match", async () => {
        const { handlers, persistLinksCalls } = makeHandlers({
            findUnlinkedQboObservations: async () => [{
                id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400,
                normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null,
            }],
            findCandidateBankLines: async () => [{
                id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400,
                normalizedPayee: "US MARKET", checkNumber: null,
            }],
        });
        const res = await handlers.POST(makeRequest({}));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, proposed: 1, linked: 1, exceptions: [] });
        assert.equal(persistLinksCalls.length, 1);
        assert.deepEqual(persistLinksCalls[0], [{ observationId: "obs1", bankLineId: "bl1" }]);
    });

    await t.test("does not propose a link across different payees sharing account+date+amount", async () => {
        const { handlers, persistLinksCalls } = makeHandlers({
            findUnlinkedQboObservations: async () => [{
                id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400,
                normalizedPayee: "CHEVRON", checkNumber: null, bankLineId: null,
            }],
            findCandidateBankLines: async () => [{
                id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400,
                normalizedPayee: "CASH APP KANDI SNYDER", checkNumber: null,
            }],
        });
        const res = await handlers.POST(makeRequest({}));
        assert.deepEqual(await res.json(), { ok: true, proposed: 0, linked: 0, exceptions: [] });
        assert.equal(persistLinksCalls.length, 0);
    });

    await t.test("passes the account filter through to both dependency lookups", async () => {
        const seenAccounts: Array<string | null> = [];
        const { handlers } = makeHandlers({
            findUnlinkedQboObservations: async account => { seenAccounts.push(account); return []; },
            findCandidateBankLines: async account => { seenAccounts.push(account); return []; },
        });
        await handlers.POST(makeRequest({ account: "WTB-0723" }));
        assert.deepEqual(seenAccounts, ["WTB-0723", "WTB-0723"]);
    });
});

test("bank-ledger reconcile: unique-index conflict path", async t => {
    await t.test("a per-link exception does not fail the whole run — other links still report as linked", async () => {
        const { handlers } = makeHandlers({
            findUnlinkedQboObservations: async () => [
                { id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
                { id: "obs2", account: "WTB-0723", postedDate: "2026-07-17", amountCents: -100, normalizedPayee: "LOWES", checkNumber: null, bankLineId: null },
            ],
            findCandidateBankLines: async () => [
                { id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
                { id: "bl2", account: "WTB-0723", postedDate: "2026-07-17", amountCents: -100, normalizedPayee: "LOWES", checkNumber: null },
            ],
            persistLinks: async links => ({
                linked: [links[0].observationId],
                exceptions: [{ observationId: links[1].observationId, bankLineId: links[1].bankLineId, reason: "bank-line-already-claimed" }],
            }),
        });
        const res = await handlers.POST(makeRequest({}));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.proposed, 2);
        assert.equal(body.linked, 1);
        assert.equal(body.exceptions.length, 1);
        assert.equal(body.exceptions[0].reason, "bank-line-already-claimed");
    });
});
