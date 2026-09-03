import assert from "node:assert/strict";
import test from "node:test";
import {
    createBankLedgerReconcileHandlers,
    persistLinksInChunks,
    type BankLedgerReconcileHandlerDependencies,
    type PersistedReconciliation,
    type ReconcileExceptionResult,
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
            return { linked: links.map(l => l.observationId), exceptions: [], chunkErrors: [], remaining: 0 };
        },
    };
    const handlers = createBankLedgerReconcileHandlers({ ...defaults, ...overrides });
    return { handlers, persistLinksCalls };
}

test("bank-ledger reconcile: auth", async t => {
    await t.test("401 when x-ingest-key is missing", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ all: true }, {}));
        assert.equal(res.status, 401);
    });

    await t.test("401 when x-ingest-key is wrong", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ all: true }, { "x-ingest-key": "wrong" }));
        assert.equal(res.status, 401);
    });

    await t.test("401 when the server has no configured secret (never falls open)", async () => {
        const { handlers } = makeHandlers({ getIngestSecret: () => undefined });
        const res = await handlers.POST(makeRequest({ all: true }, { "x-ingest-key": "" }));
        assert.equal(res.status, 401);
    });
});

test("bank-ledger reconcile: strict body validation (Codex round-3 should-fix)", async t => {
    await t.test("400 missing-body when no body is sent at all", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest(undefined));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "missing-body");
    });

    await t.test("400 invalid-body on a JSON null body — never silently treated as a global run", async () => {
        const { handlers, persistLinksCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest(null));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-body");
        assert.equal(persistLinksCalls.length, 0);
    });

    await t.test("400 invalid-body when the body is an array", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest([]));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-body");
    });

    await t.test("400 missing-scope on an empty object — no implicit global run", async () => {
        const { handlers, persistLinksCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest({}));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "missing-scope");
        assert.equal(persistLinksCalls.length, 0);
    });

    await t.test("400 missing-scope when both account and all are present", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ account: "WTB-0723", all: true }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "missing-scope");
    });

    await t.test("400 unknown-field on an unrecognized field (e.g. a typo'd 'acount')", async () => {
        const { handlers, persistLinksCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest({ acount: "WTB-0723" }));
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.reason, "unknown-field");
        assert.equal(body.field, "acount");
        assert.equal(persistLinksCalls.length, 0);
    });

    await t.test("400 invalid-all when all is present but not exactly true", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ all: "true" }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-all");
    });

    await t.test("400 invalid-all when all is false — must be explicit true, not merely present", async () => {
        const { handlers, persistLinksCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest({ all: false }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "invalid-all");
        assert.equal(persistLinksCalls.length, 0);
    });

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

    await t.test("200 when { all: true } explicitly requests a global reconcile", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ all: true }));
        assert.equal(res.status, 200);
    });

    await t.test("200 when { account } scopes to one account", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ account: "WTB-0723" }));
        assert.equal(res.status, 200);
    });
});

test("bank-ledger reconcile: happy path", async t => {
    await t.test("proposes nothing and never calls persistLinks when there is nothing to reconcile", async () => {
        const { handlers, persistLinksCalls } = makeHandlers();
        const res = await handlers.POST(makeRequest({ all: true }));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, proposed: 0, linked: 0, exceptions: [], ambiguous: [], pairedByOrder: [], chunkErrors: [], remaining: 0 });
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
        const res = await handlers.POST(makeRequest({ all: true }));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, proposed: 1, linked: 1, exceptions: [], ambiguous: [], pairedByOrder: [], chunkErrors: [], remaining: 0 });
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
        const res = await handlers.POST(makeRequest({ all: true }));
        assert.deepEqual(await res.json(), { ok: true, proposed: 0, linked: 0, exceptions: [], ambiguous: [], pairedByOrder: [], chunkErrors: [], remaining: 0 });
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

    await t.test("passes null (all accounts) through to both dependency lookups when { all: true }", async () => {
        const seenAccounts: Array<string | null> = [];
        const { handlers } = makeHandlers({
            findUnlinkedQboObservations: async account => { seenAccounts.push(account); return []; },
            findCandidateBankLines: async account => { seenAccounts.push(account); return []; },
        });
        await handlers.POST(makeRequest({ all: true }));
        assert.deepEqual(seenAccounts, [null, null]);
    });
});

test("bank-ledger reconcile: ambiguous groups (Codex round-3 defect 1)", async t => {
    await t.test("an ambiguous group is reported in the response and never reaches persistLinks", async () => {
        const { handlers, persistLinksCalls } = makeHandlers({
            findUnlinkedQboObservations: async () => [
                { id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
            ],
            findCandidateBankLines: async () => [
                { id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
                { id: "bl2", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
            ],
        });
        const res = await handlers.POST(makeRequest({ all: true }));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.proposed, 0);
        assert.equal(body.linked, 0);
        assert.equal(body.ambiguous.length, 1);
        assert.deepEqual(body.ambiguous[0].observationIds, ["obs1"]);
        assert.deepEqual(body.ambiguous[0].bankLineIds.sort(), ["bl1", "bl2"]);
        assert.equal(persistLinksCalls.length, 0);
    });

    await t.test("an unambiguous link and an ambiguous group in the same run: the link persists, the group is reported separately", async () => {
        const { handlers, persistLinksCalls } = makeHandlers({
            findUnlinkedQboObservations: async () => [
                { id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -100, normalizedPayee: "LOWES", checkNumber: null, bankLineId: null },
                { id: "obs2", account: "WTB-0723", postedDate: "2026-07-17", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
            ],
            findCandidateBankLines: async () => [
                { id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -100, normalizedPayee: "LOWES", checkNumber: null },
                { id: "bl2", account: "WTB-0723", postedDate: "2026-07-17", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
                { id: "bl3", account: "WTB-0723", postedDate: "2026-07-17", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
            ],
        });
        const res = await handlers.POST(makeRequest({ all: true }));
        const body = await res.json();
        assert.equal(body.proposed, 1);
        assert.equal(body.linked, 1);
        assert.equal(body.ambiguous.length, 1);
        assert.equal(persistLinksCalls.length, 1);
        assert.deepEqual(persistLinksCalls[0], [{ observationId: "obs1", bankLineId: "bl1" }]);
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
                chunkErrors: [],
                remaining: 0,
            }),
        });
        const res = await handlers.POST(makeRequest({ all: true }));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.proposed, 2);
        assert.equal(body.linked, 1);
        assert.equal(body.exceptions.length, 1);
        assert.equal(body.exceptions[0].reason, "bank-line-already-claimed");
    });
});

test("bank-ledger reconcile: chunk errors surface in the response (Codex round-3 new blocker)", async t => {
    await t.test("a chunk failure is relayed in chunkErrors without failing the request", async () => {
        const { handlers } = makeHandlers({
            findUnlinkedQboObservations: async () => [
                { id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
            ],
            findCandidateBankLines: async () => [
                { id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
            ],
            persistLinks: async () => ({
                linked: [],
                exceptions: [],
                chunkErrors: [{ chunkIndex: 0, linkCount: 1, error: "transaction timeout" }],
                remaining: 0,
            }),
        });
        const res = await handlers.POST(makeRequest({ all: true }));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.linked, 0);
        assert.deepEqual(body.chunkErrors, [{ chunkIndex: 0, linkCount: 1, error: "transaction timeout" }]);
    });
});

test("bank-ledger reconcile: remaining count is relayed to the caller (Codex round-4 fix 3)", async t => {
    await t.test("a nonzero remaining from persistLinks is passed straight through to the response", async () => {
        const { handlers } = makeHandlers({
            findUnlinkedQboObservations: async () => [
                { id: "obs1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null, bankLineId: null },
            ],
            findCandidateBankLines: async () => [
                { id: "bl1", account: "WTB-0723", postedDate: "2026-07-16", amountCents: -7400, normalizedPayee: "US MARKET", checkNumber: null },
            ],
            persistLinks: async () => ({
                linked: [],
                exceptions: [],
                chunkErrors: [],
                // Simulates RECONCILE_MAX_CHUNKS_PER_INVOCATION being reached
                // before every proposed link was attempted — the caller must
                // re-invoke (same scope) to resume the rest.
                remaining: 450,
            }),
        });
        const res = await handlers.POST(makeRequest({ all: true }));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.remaining, 450);
    });

    await t.test("proposed: 0 (nothing to reconcile) always reports remaining: 0", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ all: true }));
        const body = await res.json();
        assert.equal(body.proposed, 0);
        assert.equal(body.remaining, 0);
    });
});

test("persistLinksInChunks (Codex round-3 new blocker: bounded, isolated chunks)", async t => {
    function link(observationId: string, bankLineId: string): ReconcileLink {
        return { observationId, bankLineId };
    }

    await t.test("splits links into chunks of the given size and runs each chunk once", async () => {
        const links = [link("o1", "b1"), link("o2", "b2"), link("o3", "b3"), link("o4", "b4"), link("o5", "b5")];
        const chunksSeen: ReconcileLink[][] = [];
        const result = await persistLinksInChunks(links, 2, async chunk => {
            chunksSeen.push(chunk);
            return { linked: chunk.map(l => l.observationId), exceptions: [] };
        });
        assert.deepEqual(chunksSeen, [
            [link("o1", "b1"), link("o2", "b2")],
            [link("o3", "b3"), link("o4", "b4")],
            [link("o5", "b5")],
        ]);
        assert.deepEqual(result.linked, ["o1", "o2", "o3", "o4", "o5"]);
        assert.deepEqual(result.exceptions, []);
        assert.deepEqual(result.chunkErrors, []);
    });

    await t.test("a failing chunk is reported as a chunk error and does NOT roll back an already-succeeded chunk's results", async () => {
        const links = [link("o1", "b1"), link("o2", "b2"), link("o3", "b3"), link("o4", "b4")];
        const result = await persistLinksInChunks(links, 2, async (chunk, chunkIndex) => {
            if (chunkIndex === 1) throw new Error("transaction timeout");
            return { linked: chunk.map(l => l.observationId), exceptions: [] };
        });
        assert.deepEqual(result.linked, ["o1", "o2"]);
        assert.equal(result.chunkErrors.length, 1);
        assert.deepEqual(result.chunkErrors[0], { chunkIndex: 1, linkCount: 2, error: "transaction timeout" });
    });

    await t.test("a chunk that throws a non-Error value still produces a chunk error with a string message", async () => {
        const links = [link("o1", "b1")];
        const result = await persistLinksInChunks(links, 2, async () => {
            throw "boom";
        });
        assert.equal(result.linked.length, 0);
        assert.deepEqual(result.chunkErrors, [{ chunkIndex: 0, linkCount: 1, error: "boom" }]);
    });

    await t.test("exceptions from a successful chunk are merged into the aggregate result", async () => {
        const links = [link("o1", "b1"), link("o2", "b2")];
        const exception: ReconcileExceptionResult = { observationId: "o2", bankLineId: "b2", reason: "bank-line-already-claimed" };
        const result = await persistLinksInChunks(links, 2, async () => ({
            linked: ["o1"],
            exceptions: [exception],
        }));
        assert.deepEqual(result.linked, ["o1"]);
        assert.deepEqual(result.exceptions, [exception]);
    });

    await t.test("an empty links array runs zero chunks and returns empty results", async () => {
        let calls = 0;
        const result = await persistLinksInChunks([], 200, async () => {
            calls++;
            return { linked: [], exceptions: [] };
        });
        assert.equal(calls, 0);
        assert.deepEqual(result, { linked: [], exceptions: [], chunkErrors: [], remaining: 0 });
    });

    await t.test("no maxChunks passed: every chunk runs in one call and remaining is 0", async () => {
        const links = [link("o1", "b1"), link("o2", "b2"), link("o3", "b3"), link("o4", "b4"), link("o5", "b5")];
        const result = await persistLinksInChunks(links, 2, async chunk => ({ linked: chunk.map(l => l.observationId), exceptions: [] }));
        assert.deepEqual(result.linked, ["o1", "o2", "o3", "o4", "o5"]);
        assert.equal(result.remaining, 0);
    });
});

test("persistLinksInChunks maxChunks cap (Codex round-4 fix 3: bound one invocation's duration)", async t => {
    function link(observationId: string, bankLineId: string): ReconcileLink {
        return { observationId, bankLineId };
    }

    await t.test("stops after maxChunks chunks and reports the untouched links as remaining", async () => {
        const links = [link("o1", "b1"), link("o2", "b2"), link("o3", "b3"), link("o4", "b4"), link("o5", "b5")];
        const chunksSeen: ReconcileLink[][] = [];
        const result = await persistLinksInChunks(links, 2, async chunk => {
            chunksSeen.push(chunk);
            return { linked: chunk.map(l => l.observationId), exceptions: [] };
        }, 2);
        // 5 links, chunk size 2, cap 2 chunks -> only the first 4 links (2
        // chunks of 2) are attempted; the 5th link is never touched.
        assert.deepEqual(chunksSeen, [
            [link("o1", "b1"), link("o2", "b2")],
            [link("o3", "b3"), link("o4", "b4")],
        ]);
        assert.deepEqual(result.linked, ["o1", "o2", "o3", "o4"]);
        assert.equal(result.remaining, 1);
    });

    await t.test("remaining is 0 when the link count fits within maxChunks chunks", async () => {
        const links = [link("o1", "b1"), link("o2", "b2"), link("o3", "b3"), link("o4", "b4")];
        const result = await persistLinksInChunks(links, 2, async chunk => ({ linked: chunk.map(l => l.observationId), exceptions: [] }), 2);
        assert.deepEqual(result.linked, ["o1", "o2", "o3", "o4"]);
        assert.equal(result.remaining, 0);
    });

    await t.test("a chunk error still counts toward the cap, and un-run links after it are remaining, not chunkErrors", async () => {
        const links = [link("o1", "b1"), link("o2", "b2"), link("o3", "b3"), link("o4", "b4"), link("o5", "b5"), link("o6", "b6")];
        const result = await persistLinksInChunks(links, 2, async (chunk, chunkIndex) => {
            if (chunkIndex === 1) throw new Error("transaction timeout");
            return { linked: chunk.map(l => l.observationId), exceptions: [] };
        }, 2);
        // chunk 0 succeeds (o1,o2), chunk 1 throws (o3,o4) — both count
        // toward the cap of 2, so chunk 2 (o5,o6) is never attempted and is
        // reported as remaining, not as a third chunk error.
        assert.deepEqual(result.linked, ["o1", "o2"]);
        assert.deepEqual(result.chunkErrors, [{ chunkIndex: 1, linkCount: 2, error: "transaction timeout" }]);
        assert.equal(result.remaining, 2);
    });

    await t.test("chunks already run before the cap stay in the result even though later links are deferred — committed work is never undone by the cap", async () => {
        const links = [link("o1", "b1"), link("o2", "b2"), link("o3", "b3"), link("o4", "b4")];
        const result = await persistLinksInChunks(links, 1, async chunk => ({ linked: chunk.map(l => l.observationId), exceptions: [] }), 1);
        assert.deepEqual(result.linked, ["o1"]);
        assert.equal(result.remaining, 3);
    });
});

test("persistLinksInChunks stops at an absolute deadline and reports the rest", async t => {
    const links = Array.from({ length: 10 }, (_, i) => ({ observationId: `o${i}`, bankLineId: `b${i}` }));

    await t.test("un-started chunks come back as `remaining`, not as errors", async () => {
        let clock = 1_000;
        const ran: number[] = [];
        const result = await persistLinksInChunks(
            links, 2,
            async chunk => { ran.push(chunk.length); return { linked: chunk.map(l => l.observationId), exceptions: [] }; },
            Infinity,
            // Two chunks fit; the third check is past the deadline.
            { deadlineAt: 1_000 + 20, now: () => (clock += 10) - 10 },
        );
        assert.deepEqual(ran, [2, 2]);
        assert.equal(result.linked.length, 4);
        assert.equal(result.remaining, 6, "six links were never attempted");
        assert.deepEqual(result.chunkErrors, [], "a deadline is not a failure");
    });

    await t.test("no deadline means every chunk runs, as before", async () => {
        const result = await persistLinksInChunks(
            links, 2,
            async chunk => ({ linked: chunk.map(l => l.observationId), exceptions: [] }),
        );
        assert.equal(result.linked.length, 10);
        assert.equal(result.remaining, 0);
    });

    await t.test("a deadline already passed attempts nothing at all", async () => {
        const result = await persistLinksInChunks(
            links, 2,
            async () => { throw new Error("must not run"); },
            Infinity,
            { deadlineAt: 500, now: () => 1_000 },
        );
        assert.equal(result.linked.length, 0);
        assert.equal(result.remaining, 10);
    });
});
