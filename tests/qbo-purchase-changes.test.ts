import assert from "node:assert/strict";
import test from "node:test";
import { getQBPurchaseChangesSince, qboHttpStatus, isQboConnectionFailure } from "../src/lib/quickbooks";

const TOKENS = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    realmId: "test-realm",
};

test("QBO CDC reads changed and deleted Purchases independent of transaction date", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    globalThis.fetch = async (input) => {
        requestUrl = String(input);
        return new Response(JSON.stringify({
            CDCResponse: [{
                QueryResponse: [{
                    Purchase: [
                        {
                            Id: "backdated-new",
                            SyncToken: "0",
                            TxnDate: "2024-01-15",
                            TotalAmt: 75,
                            MetaData: { LastUpdatedTime: "2026-07-29T10:00:00-07:00" },
                        },
                        {
                            Id: "deleted-purchase",
                            status: "Deleted",
                            MetaData: { LastUpdatedTime: "2026-07-29T10:05:00-07:00" },
                        },
                    ],
                    startPosition: 1,
                    maxResults: 2,
                    totalCount: 2,
                }],
            }],
        }), { status: 200 });
    };

    try {
        const rows = await getQBPurchaseChangesSince(
            TOKENS,
            new Date("2026-07-22T12:00:00.000Z"),
        );
        assert.deepEqual(rows.map(row => row.Id), ["backdated-new", "deleted-purchase"]);
        assert.match(requestUrl, /\/cdc\?/);
        assert.match(requestUrl, /entities=Purchase/);
        assert.match(requestUrl, /changedSince=2026-07-22T12%3A00%3A00\.000Z/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("QBO CDC refuses a truncated change set instead of silently drifting", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        CDCResponse: [{
            QueryResponse: [{
                Purchase: [{ Id: "only-row-returned" }],
                startPosition: 1,
                maxResults: 1,
                totalCount: 2,
            }],
        }],
    }), { status: 200 });

    try {
        await assert.rejects(
            () => getQBPurchaseChangesSince(TOKENS, new Date("2026-07-22T12:00:00.000Z")),
            /truncated/i,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// --- Round 33 gate: a non-2xx must go through the shared classifier ---

test("round 33 gate: a 401 is a typed, classifiable auth failure, not a bare Error", async () => {
    // Codex gate: `new Error(...)` here left every caller unable to tell a
    // credential rejection apart from an ordinary transient outage — the
    // expense-sync route recorded the raw error name and pipeline-health.ts's
    // reconnect alert (which only fires on the reason string "qbo-auth") never
    // saw it.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ Fault: {} }), { status: 401 });

    try {
        const error = await getQBPurchaseChangesSince(TOKENS, new Date("2026-07-22T12:00:00.000Z"))
            .then(() => null, (e: unknown) => e as Error);
        assert.ok(error, "must throw, not resolve");
        assert.equal(qboHttpStatus(error), 401);
        assert.equal(isQboConnectionFailure(error), true, "401 must be recognised as a shared, credential-level failure");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("round 33 gate: a 503 stays a retryable outage, not a business refusal", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ Fault: {} }), { status: 503 });

    try {
        const error = await getQBPurchaseChangesSince(TOKENS, new Date("2026-07-22T12:00:00.000Z"))
            .then(() => null, (e: unknown) => e as Error);
        assert.ok(error);
        assert.equal(error?.name, "QboRetryableError");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("QBO CDC treats a full 1,000-row batch without totalCount as potentially truncated", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        CDCResponse: [{
            QueryResponse: [{
                Purchase: Array.from({ length: 1000 }, (_, index) => ({
                    Id: `purchase-${index}`,
                })),
                startPosition: 1,
                maxResults: 1000,
            }],
        }],
    }), { status: 200 });

    try {
        await assert.rejects(
            () => getQBPurchaseChangesSince(TOKENS, new Date("2026-07-22T12:00:00.000Z")),
            /truncated/i,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
