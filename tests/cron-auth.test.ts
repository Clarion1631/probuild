/**
 * Cron/ops Bearer auth.
 *
 * The old shape (`if (process.env.VERCEL_ENV && ...)`) only enforced the secret
 * where VERCEL_ENV happened to be set, so the endpoint was open anywhere it was
 * not — the classic all-negative env gate that fails OPEN. These tests assert
 * the inverse: closed by default, open only for a real secret or an explicit
 * local dev run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { bearerMatches, hasCronSecret, isCronAuthorized } from "../src/lib/cron-auth";

function request(authorization?: string): Request {
    return new Request("https://example.test/api/cron/pipeline-digest", {
        headers: authorization ? { authorization } : {},
    });
}

function withEnv(env: Record<string, string | undefined>, run: () => void) {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        run();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test("bearerMatches accepts the exact secret and nothing else", () => {
    assert.equal(bearerMatches("Bearer s3cret", "s3cret"), true);
    assert.equal(bearerMatches("Bearer s3crf5", "s3cret"), false);
    assert.equal(bearerMatches("Bearer s3cret ", "s3cret"), false);
    assert.equal(bearerMatches("bearer s3cret", "s3cret"), false);
    assert.equal(bearerMatches("s3cret", "s3cret"), false);
});

test("bearerMatches rejects a length mismatch instead of throwing", () => {
    // timingSafeEqual throws on unequal lengths — the guard must come first.
    assert.doesNotThrow(() => bearerMatches("Bearer short", "a-much-longer-secret"));
    assert.equal(bearerMatches("Bearer short", "a-much-longer-secret"), false);
    assert.equal(bearerMatches("Bearer a-much-longer-secret-plus", "a-much-longer-secret"), false);
});

test("a missing or empty secret rejects every header — never waves traffic through", () => {
    assert.equal(bearerMatches("Bearer anything", undefined), false);
    assert.equal(bearerMatches("Bearer anything", ""), false);
    assert.equal(bearerMatches("Bearer ", ""), false);
    assert.equal(bearerMatches(null, "s3cret"), false);
    assert.equal(bearerMatches(undefined, "s3cret"), false);
});

test("hasCronSecret has no environment escape hatch — not even in development", () => {
    withEnv({ CRON_SECRET: "s3cret", NODE_ENV: "development" }, () => {
        assert.equal(hasCronSecret(request()), false);
        assert.equal(hasCronSecret(request("Bearer s3cret")), true);
    });
});

test("isCronAuthorized rejects an unauthenticated request in production", () => {
    withEnv({ CRON_SECRET: "s3cret", NODE_ENV: "production", VERCEL_ENV: undefined }, () => {
        assert.equal(isCronAuthorized(request()), false);
        assert.equal(isCronAuthorized(request("Bearer wrong!")), false);
        assert.equal(isCronAuthorized(request("Bearer s3cret")), true);
    });
});

test("VERCEL_ENV being unset no longer opens the endpoint (the fail-open regression)", () => {
    withEnv({ CRON_SECRET: "s3cret", NODE_ENV: "production", VERCEL_ENV: undefined }, () => {
        assert.equal(isCronAuthorized(request()), false);
    });
});

test("a deployment that forgot CRON_SECRET rejects rather than opening up", () => {
    withEnv({ CRON_SECRET: undefined, NODE_ENV: "production" }, () => {
        assert.equal(isCronAuthorized(request()), false);
        assert.equal(isCronAuthorized(request("Bearer anything")), false);
    });
});

test("local development is the one explicit bypass", () => {
    withEnv({ CRON_SECRET: undefined, NODE_ENV: "development" }, () => {
        assert.equal(isCronAuthorized(request()), true);
    });
});

test("test/CI is NOT a bypass", () => {
    withEnv({ CRON_SECRET: "s3cret", NODE_ENV: "test" }, () => {
        assert.equal(isCronAuthorized(request()), false);
    });
});


// --- The payments cron route was the last fail-open caller ---

test("the payments cron rejects an unauthenticated request outside development", async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousVercel = process.env.VERCEL_ENV;
    const previousSecret = process.env.CRON_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.VERCEL_ENV; // the exact hole: no VERCEL_ENV used to mean "no check"
    process.env.CRON_SECRET = "s3cret";
    try {
        const { GET } = await import("../src/app/api/cron/quickbooks-payments/route");
        const call = (headers?: Record<string, string>) =>
            GET(new Request("https://probuild.test/api/cron/quickbooks-payments", { headers }));

        assert.equal((await call()).status, 401, "no header");
        assert.equal((await call({ authorization: "Bearer wrong" })).status, 401, "wrong secret");
        assert.equal((await call({ authorization: "Bearer" })).status, 401, "malformed header");
        assert.equal((await call({ authorization: "Bearer undefined" })).status, 401, "literal undefined");
    } finally {
        if (previousEnv === undefined) delete (process.env as Record<string, string>).NODE_ENV;
        else (process.env as Record<string, string>).NODE_ENV = previousEnv;
        if (previousVercel === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = previousVercel;
        if (previousSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = previousSecret;
    }
});

test("a missing CRON_SECRET cannot be satisfied by 'Bearer undefined'", () => {
    withEnv({ CRON_SECRET: undefined, NODE_ENV: "production" }, () => {
        assert.equal(isCronAuthorized(request("Bearer undefined")), false);
        assert.equal(isCronAuthorized(request("Bearer ")), false);
    });
});
