import assert from "node:assert/strict";
import test from "node:test";
import { createQboExpenseSyncHandlers } from "../src/app/api/integrations/qbo-expenses/sync/route";

const TOKENS = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    realmId: "test-realm",
};

function createHandlers() {
    const calls: Array<{ since: Date; tokens: typeof TOKENS }> = [];
    const handlers = createQboExpenseSyncHandlers({
        getIngestSecret: () => "ingest-secret",
        getCronSecret: () => "cron-secret",
        getFreshTokens: async () => TOKENS,
        syncExpenses: async ({ since }, { tokens }) => {
            calls.push({ since, tokens });
            return {
                imported: 2,
                updated: 1,
                skipped: [{ qbPurchaseId: "purchase-skipped", reason: "no-active-project" }],
            };
        },
        now: () => new Date("2026-07-29T12:00:00.000Z"),
        incrementalLookbackDays: 7,
    });
    return { ...handlers, calls };
}

test("POST rejects a missing ingest secret", async () => {
    const { POST } = createHandlers();
    const response = await POST(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "incremental" }),
        headers: { "content-type": "application/json" },
    }));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
});

test("POST rejects invalid modes and malformed backfill dates", async () => {
    const { POST } = createHandlers();
    const invalidMode = await POST(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "everything" }),
        headers: {
            "content-type": "application/json",
            "x-ingest-key": "ingest-secret",
        },
    }));
    assert.equal(invalidMode.status, 400);

    const invalidDate = await POST(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "backfill", since: "07/01/2026" }),
        headers: {
            "content-type": "application/json",
            "x-ingest-key": "ingest-secret",
        },
    }));
    assert.equal(invalidDate.status, 400);
    assert.deepEqual(await invalidDate.json(), { ok: false, reason: "invalid-since" });
});

test("POST runs an incremental sync over the configured rolling window", async () => {
    const { POST, calls } = createHandlers();
    const response = await POST(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "incremental" }),
        headers: {
            "content-type": "application/json",
            "x-ingest-key": "ingest-secret",
        },
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        ok: true,
        mode: "incremental",
        since: "2026-07-22",
        imported: 2,
        updated: 1,
        skipped: [{ qbPurchaseId: "purchase-skipped", reason: "no-active-project" }],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].since.toISOString(), "2026-07-22T12:00:00.000Z");
});

test("POST runs a date-bounded historical backfill", async () => {
    const { POST, calls } = createHandlers();
    const response = await POST(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "backfill", since: "2024-01-15" }),
        headers: {
            "content-type": "application/json",
            "x-ingest-key": "ingest-secret",
        },
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, "backfill");
    assert.equal(body.since, "2024-01-15");
    assert.equal(calls[0].since.toISOString(), "2024-01-15T00:00:00.000Z");
});

test("GET requires Vercel cron authorization and runs incremental mode", async () => {
    const { GET, calls } = createHandlers();
    const unauthorized = await GET(new Request("https://example.test/api/integrations/qbo-expenses/sync"));
    assert.equal(unauthorized.status, 401);

    const response = await GET(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        headers: { authorization: "Bearer cron-secret" },
    }));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal((await response.json()).mode, "incremental");
});
