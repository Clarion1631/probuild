import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    buildFrozenNotification,
    sendFrozenNotification,
    type FrozenNotification,
} from "../src/lib/email";

test("a frozen notification is canonical and retryable with one stable idempotency key", async () => {
    const dispatch = buildFrozenNotification({
        to: [" Client@Example.test ", "client@example.test"],
        cc: [" Backup@Example.test ", "backup@example.test"],
        bcc: [" Audit@Example.test ", "client@example.test"],
        fromName: "Golden Touch\r\nInjected",
        replyTo: " office@example.test ",
        subject: "Change order\r\nreview",
        html: "<p>Frozen body</p>",
    });

    assert.deepEqual(dispatch, {
        from: "Golden Touch Injected <notifications@goldentouchremodeling.com>",
        to: ["Client@Example.test"],
        cc: ["Backup@Example.test"],
        bcc: ["Audit@Example.test"],
        replyTo: "office@example.test",
        subject: "Change order review",
        html: "<p>Frozen body</p>",
        text: "Frozen body",
    } satisfies FrozenNotification);

    const calls: Array<{ payload: FrozenNotification; options: { idempotencyKey: string } }> = [];
    const dependencies = {
        send: async (payload: FrozenNotification, options: { idempotencyKey: string }) => {
            calls.push({ payload, options });
            return { data: { id: "provider-1" }, error: null };
        },
    };

    assert.deepEqual(await sendFrozenNotification(dispatch, "co-job/job-1", dependencies), {
        success: true,
        id: "provider-1",
    });
    assert.deepEqual(await sendFrozenNotification(dispatch, "co-job/job-1", dependencies), {
        success: true,
        id: "provider-1",
    });
    assert.equal(calls.length, 2);
    assert.strictEqual(calls[0].payload, dispatch);
    assert.strictEqual(calls[1].payload, dispatch);
    assert.deepEqual(calls.map(call => call.options), [
        { idempotencyKey: "co-job/job-1" },
        { idempotencyKey: "co-job/job-1" },
    ]);
});

test("a provider rejection is returned as a failed frozen dispatch", async () => {
    const dispatch = buildFrozenNotification({
        to: ["client@example.test"],
        subject: "Review",
        html: "<p>Review</p>",
    });
    const result = await sendFrozenNotification(dispatch, "co-job/job-2", {
        send: async () => ({ data: null, error: { message: "rejected" } }),
    });
    assert.deepEqual(result, { success: false, ambiguous: false });
});

test("a thrown or timed-out provider attempt is reported as ambiguous for safe retry", async () => {
    const dispatch = buildFrozenNotification({
        to: ["client@example.test"],
        subject: "Review",
        html: "<p>Review</p>",
    });
    const result = await sendFrozenNotification(dispatch, "co-job/job-3", {
        send: async () => { throw new Error("connection dropped after request write"); },
    });
    assert.deepEqual(result, { success: false, ambiguous: true });
});

test("a provider response without a message id is never treated as delivered", async () => {
    const dispatch = buildFrozenNotification({
        to: ["client@example.test"],
        subject: "Review",
        html: "<p>Review</p>",
    });
    const result = await sendFrozenNotification(dispatch, "co-job/job-4", {
        send: async () => ({ data: null, error: undefined }),
    });
    assert.deepEqual(result, { success: false, ambiguous: true });
});

test("the unconfigured local provider keeps the existing mock-delivery contract", async () => {
    const dispatch = buildFrozenNotification({
        to: ["local-test@example.test"],
        subject: "Local review",
        html: "<p>Local review</p>",
    });
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = (async () => {
        providerCalls++;
        throw new Error("the dummy provider must never reach the network");
    }) as typeof fetch;
    try {
        assert.deepEqual(await sendFrozenNotification(dispatch, "co-job/local-mock"), {
            success: true,
            id: "mock_resend_id_123",
        });
        assert.equal(providerCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("the Playwright CI job cannot inherit the real Resend credential", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const playwrightStart = workflow.indexOf("\n  playwright:");
    assert.notEqual(playwrightStart, -1, "the Playwright job must exist");
    const playwrightJob = workflow.slice(playwrightStart);
    assert.doesNotMatch(
        playwrightJob,
        /^\s+RESEND_API_KEY:/m,
        "browser regressions must use the deterministic no-provider mail path",
    );
});
