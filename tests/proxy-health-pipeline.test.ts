/**
 * /api/health/pipeline must reach its own handler.
 *
 * Codex gate: the route self-authenticates (Bearer CRON_SECRET, or a staff
 * session with financialReports), but the proxy only bypassed the EXACT
 * /api/health path — so NextAuth intercepted /api/health/pipeline first and a
 * headless Bearer check got a redirect to /login instead of its JSON.
 *
 * Exact-match only, mirroring the api/office-tasks/ingest precedent: nothing
 * else under /api/health/ may inherit a public bypass.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const loadProxy = () => import("../src/proxy");

test("the pipeline health endpoint is bypassed so its own auth can answer", async () => {
    const { isPublicProxyBypass } = await loadProxy();
    for (const path of ["/api/health", "/api/health/pipeline", "/api/health/pipeline/"]) {
        assert.equal(isPublicProxyBypass(path), true, path);
    }
});

test("the bypass does NOT widen to other /api/health descendants", async () => {
    const { isPublicProxyBypass } = await loadProxy();
    for (const path of [
        "/api/health/pipeline/deep",
        "/api/health/secrets",
        "/api/healthcheck",
        "/api/health-pipeline",
    ]) {
        assert.equal(isPublicProxyBypass(path), false, path);
    }
});

test("in production mode a Bearer request reaches the handler instead of /login", async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousVercel = process.env.VERCEL_ENV;
    // NODE_ENV is readonly in the Next types but writable at runtime.
    (process.env as Record<string, string>).NODE_ENV = "production";
    (process.env as Record<string, string>).VERCEL_ENV = "production";
    try {
        const { default: proxy } = await loadProxy();
        const { NextRequest } = await import("next/server");
        const event = { waitUntil() {} } as any;

        const request = new NextRequest("https://probuild.test/api/health/pipeline", {
            method: "GET",
            headers: { authorization: "Bearer some-cron-secret" },
        });
        const response = await proxy(request, event);

        assert.ok(response instanceof Response, "proxy must return a response");
        // x-middleware-next: 1 means "continue to the route handler", which is
        // where the endpoint's own Bearer/staff-session check runs.
        assert.equal(
            response.headers.get("x-middleware-next"),
            "1",
            `expected pass-through to the handler, got status ${response.status}`,
        );
    } finally {
        if (previousEnv === undefined) delete (process.env as Record<string, string>).NODE_ENV;
        else (process.env as Record<string, string>).NODE_ENV = previousEnv;
        if (previousVercel === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = previousVercel;
    }
});
