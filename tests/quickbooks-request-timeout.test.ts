import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CHANGE_ORDER_AUTOMATION_STALE_AFTER_MS } from "../src/lib/change-order-automation-jobs";
import * as quickBooks from "../src/lib/quickbooks";

test("every QuickBooks request is bounded below the automation lease horizon", async () => {
    assert.equal(typeof quickBooks.QB_REQUEST_TIMEOUT_MS, "number");
    assert.equal(typeof quickBooks.MAX_QB_REQUESTS_PER_AUTOMATION_SIDE_EFFECT, "number");
    assert.ok(quickBooks.QB_REQUEST_TIMEOUT_MS > 0);
    assert.ok(
        quickBooks.QB_REQUEST_TIMEOUT_MS * quickBooks.MAX_QB_REQUESTS_PER_AUTOMATION_SIDE_EFFECT
            < DEFAULT_CHANGE_ORDER_AUTOMATION_STALE_AFTER_MS,
        "the full cold QBO call chain must time out before another worker can reclaim the lease",
    );

    const originalFetch = globalThis.fetch;
    let observedSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => {
        observedSignal = init?.signal;
        return new Response("{}", { status: 200 });
    };
    try {
        await quickBooks.qbFetch(
            "/invoice/timeout-contract",
            { accessToken: "test", refreshToken: "test", realmId: "test" },
            { method: "GET" },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.ok(observedSignal instanceof AbortSignal, "qbFetch must install an abort signal by default");
    assert.equal(observedSignal.aborted, false);
});
