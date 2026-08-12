import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../src/app/api/automation/digest/route";

/** Snapshot + restore the env vars this route reads, so tests never leak
 * state into each other or the rest of the suite. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const keys = ["VERCEL_ENV", "CRON_SECRET", "VANESSA_EMAIL", "DIGEST_CC_EMAIL"] as const;
    const snapshot: Record<string, string | undefined> = {};
    for (const key of keys) snapshot[key] = process.env[key];
    for (const key of keys) {
        if (vars[key] === undefined) delete process.env[key];
        else process.env[key] = vars[key];
    }
    return fn().finally(() => {
        for (const key of keys) {
            if (snapshot[key] === undefined) delete process.env[key];
            else process.env[key] = snapshot[key];
        }
    });
}

test("GET rejects a deployed request with no CRON_SECRET header", async () => {
    await withEnv(
        { VERCEL_ENV: "production", CRON_SECRET: "the-real-secret", VANESSA_EMAIL: "v@x.com", DIGEST_CC_EMAIL: "cc@x.com" },
        async () => {
            const response = await GET(new Request("https://example.test/api/automation/digest"));
            assert.equal(response.status, 401);
        },
    );
});

test("GET rejects a deployed request with the wrong bearer token", async () => {
    await withEnv(
        { VERCEL_ENV: "production", CRON_SECRET: "the-real-secret", VANESSA_EMAIL: "v@x.com", DIGEST_CC_EMAIL: "cc@x.com" },
        async () => {
            const response = await GET(
                new Request("https://example.test/api/automation/digest", { headers: { authorization: "Bearer wrong" } }),
            );
            assert.equal(response.status, 401);
        },
    );
});

test("GET fails closed when VERCEL_ENV is set but CRON_SECRET itself is unset", async () => {
    await withEnv(
        { VERCEL_ENV: "production", CRON_SECRET: undefined, VANESSA_EMAIL: "v@x.com", DIGEST_CC_EMAIL: "cc@x.com" },
        async () => {
            const response = await GET(
                new Request("https://example.test/api/automation/digest", { headers: { authorization: "Bearer anything" } }),
            );
            assert.equal(response.status, 401);
        },
    );
});

test("GET returns 500 with a clear message when VANESSA_EMAIL is missing (auth passes, config doesn't)", async () => {
    await withEnv(
        { VERCEL_ENV: "production", CRON_SECRET: "s", VANESSA_EMAIL: undefined, DIGEST_CC_EMAIL: "cc@x.com" },
        async () => {
            const response = await GET(
                new Request("https://example.test/api/automation/digest", { headers: { authorization: "Bearer s" } }),
            );
            assert.equal(response.status, 500);
            const body = await response.json();
            assert.equal(body.ok, false);
            assert.match(body.error, /VANESSA_EMAIL/);
        },
    );
});

test("GET returns 500 with a clear message when DIGEST_CC_EMAIL is missing", async () => {
    await withEnv(
        { VERCEL_ENV: "production", CRON_SECRET: "s", VANESSA_EMAIL: "v@x.com", DIGEST_CC_EMAIL: undefined },
        async () => {
            const response = await GET(
                new Request("https://example.test/api/automation/digest", { headers: { authorization: "Bearer s" } }),
            );
            assert.equal(response.status, 500);
            const body = await response.json();
            assert.match(body.error, /DIGEST_CC_EMAIL/);
        },
    );
});

test("GET never returns a silent 200 when recipients are misconfigured, even in local dev (no VERCEL_ENV)", async () => {
    await withEnv(
        { VERCEL_ENV: undefined, CRON_SECRET: undefined, VANESSA_EMAIL: undefined, DIGEST_CC_EMAIL: undefined },
        async () => {
            const response = await GET(new Request("https://example.test/api/automation/digest"));
            assert.equal(response.status, 500);
        },
    );
});
