import assert from "node:assert/strict";
import test from "node:test";
import { createBankLedgerIngestHandlers } from "../src/app/api/integrations/bank-ledger/ingest/route";
import { computeLineHash } from "../src/lib/bank-ledger";

const SECRET = "test-secret";

function makeRequest(body: unknown, headers: Record<string, string> = { "x-ingest-key": SECRET }) {
    return new Request("http://localhost/api/integrations/bank-ledger/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
}

function makeHandlers(overrides: Partial<{
    existingHashes: Set<string>;
    createLines: (rows: unknown[]) => Promise<number>;
}> = {}) {
    const created: unknown[] = [];
    const handlers = createBankLedgerIngestHandlers({
        getIngestSecret: () => SECRET,
        findExistingHashes: async () => overrides.existingHashes ?? new Set(),
        createLines: overrides.createLines
            ?? (async rows => {
                created.push(...rows);
                return rows.length;
            }),
    });
    return { handlers, created };
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
        const handlers = createBankLedgerIngestHandlers({
            getIngestSecret: () => undefined,
            findExistingHashes: async () => new Set(),
            createLines: async () => 0,
        });
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

    await t.test("400 missing-account", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ source: "STATEMENT", account: "", lines: [{ postedDate: "2026-01-01", amountCents: -100, rawDescriptor: "X" }] }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "missing-account");
    });

    await t.test("400 missing-lines when lines is empty or absent", async () => {
        const { handlers } = makeHandlers();
        const res = await handlers.POST(makeRequest({ source: "STATEMENT", account: "WTB-0723", lines: [] }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, "missing-lines");
    });

    await t.test("400 too-many-lines over the 5000 cap", async () => {
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
        const { handlers, created } = makeHandlers();
        const res = await handlers.POST(makeRequest({
            source: "STATEMENT",
            account: "WTB-0723",
            lines: [
                { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET US MARKET POS DEB 1027" },
                { postedDate: "2026-07-17", amountCents: 500000, rawDescriptor: "DEPOSIT" },
            ],
        }));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, inserted: 2, existing: 0 });
        assert.equal(created.length, 2);
        assert.equal((created[0] as { normalizedPayee: string }).normalizedPayee, "US MARKET US MARKET");
        assert.equal((created[0] as { account: string }).account, "WTB-0723");
        assert.equal((created[0] as { source: string }).source, "STATEMENT");
    });

    await t.test("passes checkNumber through when present, null when absent", async () => {
        const { handlers, created } = makeHandlers();
        await handlers.POST(makeRequest({
            source: "STATEMENT",
            account: "WTB-0723",
            lines: [
                { postedDate: "2026-07-17", amountCents: -400000, rawDescriptor: "Check #1024", checkNumber: "1024" },
                { postedDate: "2026-07-16", amountCents: -100, rawDescriptor: "X" },
            ],
        }));
        assert.equal((created[0] as { checkNumber: string | null }).checkNumber, "1024");
        assert.equal((created[1] as { checkNumber: string | null }).checkNumber, null);
    });

    await t.test("never duplicates a line whose hash already exists (idempotent upsert)", async () => {
        const line = { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" };
        const existingHash = computeLineHash({ account: "WTB-0723", postedDate: line.postedDate, amountCents: line.amountCents, rawDescriptor: line.rawDescriptor, occurrenceIndex: 0 });
        const { handlers, created } = makeHandlers({ existingHashes: new Set([existingHash]) });
        const res = await handlers.POST(makeRequest({ source: "STATEMENT", account: "WTB-0723", lines: [line] }));
        assert.deepEqual(await res.json(), { ok: true, inserted: 0, existing: 1 });
        assert.equal(created.length, 0);
    });

    await t.test("gives identical same-day duplicate lines distinct hashes so both insert", async () => {
        const { handlers, created } = makeHandlers();
        const res = await handlers.POST(makeRequest({
            source: "STATEMENT",
            account: "WTB-0723",
            lines: [
                { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
                { postedDate: "2026-07-16", amountCents: -7400, rawDescriptor: "US MARKET" },
            ],
        }));
        assert.deepEqual(await res.json(), { ok: true, inserted: 2, existing: 0 });
        const hashes = created.map(r => (r as { lineHash: string }).lineHash);
        assert.notEqual(hashes[0], hashes[1]);
    });
});
