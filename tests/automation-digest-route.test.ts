import assert from "node:assert/strict";
import test from "node:test";
import { GET, digestResultResponse } from "../src/app/api/automation/digest/route";
import type { DigestTickResult } from "../src/lib/automation-digest";

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

// ── digestResultResponse: never a silent 200 on a genuine delivery failure ──

test("digestResultResponse returns 500 for an ok:false result (delivery genuinely failed this tick)", async () => {
    const result: DigestTickResult = { ok: false, digestDate: "2026-08-10", attempts: 3, error: "Resend reported failure sending the digest" };
    const response = digestResultResponse(result);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), result);
});

test("digestResultResponse returns 200 for an ok:true sent result", async () => {
    const result: DigestTickResult = { ok: true, sent: true, digestDate: "2026-08-10", rowCount: 2 };
    const response = digestResultResponse(result);
    assert.equal(response.status, 200);
});

test("digestResultResponse returns 200 for a benign skip (before-send-window / already-sent / in-flight)", async () => {
    for (const skipped of ["before-send-window", "already-sent", "in-flight", "terminal-failed"] as const) {
        const response = digestResultResponse({ ok: true, skipped });
        assert.equal(response.status, 200);
    }
});
