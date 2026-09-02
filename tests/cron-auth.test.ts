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
