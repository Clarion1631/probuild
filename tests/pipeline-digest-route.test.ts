/**
 * Pipeline digest cron delivery.
 *
 * A monitoring job that silently fails to deliver is worse than no monitoring
 * job, because its silence looks like good news. So: the two channels run
 * independently, neither can hang the cron, and an unaccepted email is a 500
 * that shows up in Vercel's cron history.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    createPipelineDigestHandlers,
    isEmailDeliveryConfigured,
    type PipelineDigestDependencies,
} from "../src/app/api/cron/pipeline-digest/route";
import type { PipelineHealth } from "../src/lib/pipeline-health";

const HEALTH: PipelineHealth = {
    ok: true,
    reasons: [],
    checkedAt: "2026-09-01T14:00:00.000Z",
    intuit: { status: "ok", indicator: "none" },
    qbo: {
        lastPurchaseSync: { status: "ok", at: "2026-09-01T10:00:00.000Z" },
        lastReceiptPush: { status: "ok", at: "2026-09-01T12:00:00.000Z" },
        lastPaymentsSync: { status: "ok", at: "2026-09-01T13:00:00.000Z" },
    },
    receipts24h: { status: "ok", counts: { created: 2 } },
    bank: { status: "ok", at: "2026-08-29T00:00:00.000Z" },
    stuck: { status: "ok", count: 0 },
    intake: {
        stuck: { status: "ok", count: 0 },
        needsReview: { status: "ok", count: 0 },
        unassigned: { status: "ok", count: 0 },
    },
};

function handlers(overrides: Partial<PipelineDigestDependencies> = {}) {
    return createPipelineDigestHandlers({
        getHealth: overrides.getHealth ?? (async () => HEALTH),
        sendEmail: overrides.sendEmail ?? (async () => ({ success: true })),
        postChat: overrides.postChat ?? (async () => ({ sent: true })),
        getChatWebhook: overrides.getChatWebhook ?? (() => undefined),
        getRecipient: overrides.getRecipient ?? (() => "ops@example.test"),
        isEmailConfigured: overrides.isEmailConfigured ?? (() => true),
        deliveryTimeoutMs: overrides.deliveryTimeoutMs ?? 100,
    });
}

function cronRequest(): Request {
    return new Request("https://example.test/api/cron/pipeline-digest", {
        headers: { authorization: "Bearer test-cron-secret" },
    });
}

function withCronSecret<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-cron-secret";
    return run().finally(() => {
        if (previous === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = previous;
    });
}

test("a delivered digest returns 200 with the health payload", async () => {
    await withCronSecret(async () => {
        const { GET } = handlers();
        const response = await GET(cronRequest());
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.emailed, true);
        assert.equal(body.ok, true);
    });
});

test("an unaccepted email is a 500 with reason email-not-accepted", async () => {
    await withCronSecret(async () => {
        const { GET } = handlers({ sendEmail: async () => ({ success: false }) });
        const response = await GET(cronRequest());
        assert.equal(response.status, 500);
        const body = await response.json();
        assert.equal(body.ok, false);
        assert.equal(body.reason, "email-not-accepted");
    });
});

test("a THROWN email failure is also a 500, not an unhandled rejection", async () => {
    await withCronSecret(async () => {
        const { GET } = handlers({
            sendEmail: async () => {
                throw new Error("resend exploded");
            },
        });
        const response = await GET(cronRequest());
        assert.equal(response.status, 500);
        assert.equal((await response.json()).reason, "email-not-accepted");
    });
});

test("a hanging email send does not hang the cron — it fails on its own deadline", async () => {
    await withCronSecret(async () => {
        const started = Date.now();
        // Deadline shortened for the test; production uses DELIVERY_TIMEOUT_MS.
        const { GET } = handlers({ sendEmail: () => new Promise(() => {}), deliveryTimeoutMs: 100 });
        const response = await GET(cronRequest());
        assert.equal(response.status, 500);
        assert.equal((await response.json()).reason, "email-not-accepted");
        assert.ok(Date.now() - started < 5_000, "the cron must return on its own deadline");
    });
});

test("Chat is optional: a failing webhook never costs us the email", async () => {
    await withCronSecret(async () => {
        const { GET } = handlers({
            getChatWebhook: () => "https://chat.googleapis.com/v1/spaces/x",
            postChat: async () => {
                throw new Error("chat down");
            },
        });
        const response = await GET(cronRequest());
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.emailed, true);
        assert.equal(body.chatPosted, false);
    });
});

test("a failing email does not stop the Chat post from being attempted", async () => {
    await withCronSecret(async () => {
        let chatCalls = 0;
        const { GET } = handlers({
            sendEmail: async () => {
                throw new Error("resend exploded");
            },
            getChatWebhook: () => "https://chat.googleapis.com/v1/spaces/x",
            postChat: async () => {
                chatCalls += 1;
                return { sent: true };
            },
        });
        const response = await GET(cronRequest());
        assert.equal(response.status, 500);
        assert.equal(chatCalls, 1, "the channels must run independently");
        assert.equal((await response.json()).chatPosted, true);
    });
});

test("no webhook configured means chatPosted false, not an error", async () => {
    await withCronSecret(async () => {
        const { GET } = handlers({ getChatWebhook: () => undefined });
        const response = await GET(cronRequest());
        assert.equal(response.status, 200);
        assert.equal((await response.json()).chatPosted, false);
    });
});

test("an unauthenticated request is rejected before any delivery is attempted", async () => {
    await withCronSecret(async () => {
        let sends = 0;
        const { GET } = handlers({
            sendEmail: async () => {
                sends += 1;
                return { success: true };
            },
        });
        const response = await GET(new Request("https://example.test/api/cron/pipeline-digest"));
        assert.equal(response.status, 401);
        assert.equal(sends, 0);
    });
});


// ─── Missing mailer credentials ─────────────────────────────────────────────

function withEnv(env: Record<string, string | undefined>, run: () => void) {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
        previous[key] = process.env[key];
        if (value === undefined) delete (process.env as Record<string, string>)[key];
        else (process.env as Record<string, string>)[key] = value;
    }
    try {
        run();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete (process.env as Record<string, string>)[key];
            else (process.env as Record<string, string>)[key] = value;
        }
    }
}

test("in production a missing RESEND_API_KEY is a delivery failure, not a silent no-op", () => {
    // email.ts falls back to a dummy key and returns {success:true} without
    // sending — which would make the pulse report good news while delivering
    // nothing. Checked here so no other caller's behaviour changes.
    withEnv({ NODE_ENV: "production", VERCEL_ENV: "production", RESEND_API_KEY: undefined }, () => {
        assert.equal(isEmailDeliveryConfigured(), false);
    });
    withEnv({ NODE_ENV: "production", VERCEL_ENV: "production", RESEND_API_KEY: "   " }, () => {
        assert.equal(isEmailDeliveryConfigured(), false);
    });
    withEnv({ NODE_ENV: "production", VERCEL_ENV: "production", RESEND_API_KEY: "re_live_key" }, () => {
        assert.equal(isEmailDeliveryConfigured(), true);
    });
});

test("local development without a key is still fine", () => {
    withEnv({ NODE_ENV: "development", VERCEL_ENV: undefined, RESEND_API_KEY: undefined }, () => {
        assert.equal(isEmailDeliveryConfigured(), true);
    });
});

test("an unconfigured mailer returns 500 and never claims emailed:true", async () => {
    await withCronSecret(async () => {
        let sends = 0;
        const { GET } = handlers({
            isEmailConfigured: () => false,
            sendEmail: async () => {
                sends += 1;
                return { success: true }; // what email.ts would wrongly report
            },
        });
        const response = await GET(cronRequest());
        assert.equal(response.status, 500);
        const body = await response.json();
        assert.equal(body.ok, false);
        assert.equal(body.reason, "email-not-accepted");
        assert.equal(sends, 0, "no point calling a mailer that cannot deliver");
    });
});

test("an unconfigured mailer still lets the Chat post through", async () => {
    await withCronSecret(async () => {
        const { GET } = handlers({
            isEmailConfigured: () => false,
            getChatWebhook: () => "https://chat.googleapis.com/v1/spaces/x",
            postChat: async () => ({ sent: true }),
        });
        const response = await GET(cronRequest());
        assert.equal(response.status, 500);
        assert.equal((await response.json()).chatPosted, true);
    });
});
