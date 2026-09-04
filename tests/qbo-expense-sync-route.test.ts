import assert from "node:assert/strict";
import test from "node:test";
import { createQboExpenseSyncHandlers } from "../src/app/api/integrations/qbo-expenses/sync/route";

const TOKENS = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    realmId: "test-realm",
};

function createHandlers(options: { cronEnabled?: boolean; syncError?: Error } = {}) {
    const calls: Array<{ since: Date; until?: Date; mode: "incremental" | "backfill"; tokens: typeof TOKENS }> = [];
    const events: any[] = [];
    const handlers = createQboExpenseSyncHandlers({
        getIngestSecret: () => "ingest-secret",
        getCronSecret: () => "cron-secret",
        isCronEnabled: () => options.cronEnabled ?? true,
        getFreshTokens: async () => TOKENS,
        syncExpenses: async ({ since, until, mode }, { tokens }) => {
            calls.push({ since, until, mode, tokens });
            if (options.syncError) throw options.syncError;
            return {
                imported: 2,
                updated: 1,
                removed: 0,
                attributionRaceSkipped: 0,
                skipped: [{ qbPurchaseId: "purchase-skipped", reason: "no-active-project" }],
            };
        },
        now: () => new Date("2026-07-29T12:00:00.000Z"),
        incrementalLookbackDays: 7,
        // Stub the audit logger and pause switch — with no DB the real pause
        // read fails CLOSED (paused) and would 503 the cron test. Real events
        // are still captured so a test can assert on the recorded reason.
        logEvent: (e: any) => { events.push(e); },
        isSyncPaused: async () => false,
    });
    return { ...handlers, calls, events };
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
        removed: 0,
        attributionRaceSkipped: 0,
        skipped: [{ qbPurchaseId: "purchase-skipped", reason: "no-active-project" }],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].since.toISOString(), "2026-07-22T12:00:00.000Z");
    assert.equal(calls[0].mode, "incremental");
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
    assert.equal(calls[0].until, undefined);
    assert.equal(calls[0].mode, "backfill");
});

test("POST backfill accepts an inclusive until bound for chunked runs", async () => {
    const { POST, calls } = createHandlers();
    const response = await POST(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "backfill", since: "2026-01-01", until: "2026-01-31" }),
        headers: {
            "content-type": "application/json",
            "x-ingest-key": "ingest-secret",
        },
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.since, "2026-01-01");
    assert.equal(body.until, "2026-01-31");
    assert.equal(calls[0].since.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(calls[0].until?.toISOString(), "2026-01-31T00:00:00.000Z");
});

test("POST backfill rejects a malformed until and an until before since", async () => {
    const { POST, calls } = createHandlers();
    for (const until of ["01/31/2026", "2025-12-31"]) {
        const response = await POST(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
            method: "POST",
            body: JSON.stringify({ mode: "backfill", since: "2026-01-01", until }),
            headers: {
                "content-type": "application/json",
                "x-ingest-key": "ingest-secret",
            },
        }));
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { ok: false, reason: "invalid-until" });
    }
    assert.equal(calls.length, 0);
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

test("GET can disable only the QBO expense cron without affecting manual backfill", async () => {
    const { GET, calls } = createHandlers({ cronEnabled: false });
    const response = await GET(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        headers: { authorization: "Bearer cron-secret" },
    }));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, reason: "sync-disabled" });
    assert.equal(calls.length, 0);
});

test("sync failures return a stable reason without exposing upstream QBO details", async () => {
    const { POST } = createHandlers({
        syncError: new Error("QB query failed: access_token=secret transaction body"),
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "incremental" }),
        headers: {
            "content-type": "application/json",
            "x-ingest-key": "ingest-secret",
        },
    }));

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, reason: "sync-failed" });
});

test("round 33 gate: a 401/403 from the CDC purchase read is recorded as qbo-auth, not a generic error", async () => {
    // Codex gate: getQBPurchaseChangesSince used to convert every non-2xx into
    // a bare Error, so a credential rejection here reached this route as an
    // unclassified "sync-failed" and pipeline-health.ts's reconnect alert
    // (which only fires on the reason string "qbo-auth") never saw it.
    const qboAuthError = Object.assign(new Error("QBO Purchase CDC failed (401): ..."), {
        name: "QboHttpError",
        status: 401,
    });
    const { POST, events } = createHandlers({ syncError: qboAuthError as any });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "incremental" }),
        headers: {
            "content-type": "application/json",
            "x-ingest-key": "ingest-secret",
        },
    }));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, retry: true, reason: "qbo-auth" });
    assert.equal(events.at(-1)?.reason, "qbo-auth");
});
