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

// --- Round 46: a bypassed path is not an action dispatcher ---

/**
 * The bypass runs BEFORE the route handler, and Next's action IDs are global.
 * So an anonymous `next-action` POST to /api/health/pipeline never reached the
 * route's Bearer/staff-session check at all — that check is not the boundary
 * for an action dispatch, because the handler does not run. The path was simply
 * a public door onto every Server Action in the app.
 *
 * Driven through the REAL proxy in production mode, with no session cookie.
 */
async function inProduction<T>(run: () => Promise<T>): Promise<T> {
    const previousEnv = process.env.NODE_ENV;
    const previousVercel = process.env.VERCEL_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    (process.env as Record<string, string>).VERCEL_ENV = "production";
    try {
        return await run();
    } finally {
        if (previousEnv === undefined) delete (process.env as Record<string, string>).NODE_ENV;
        else (process.env as Record<string, string>).NODE_ENV = previousEnv;
        if (previousVercel === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = previousVercel;
    }
}

test("round 46: an anonymous Server Action POST to a health path is refused", async () => {
    await inProduction(async () => {
        const { default: proxy } = await loadProxy();
        const { NextRequest } = await import("next/server");
        const event = { waitUntil() {} } as any;

        for (const path of ["/api/health", "/api/health/pipeline"]) {
            const request = new NextRequest(`https://probuild.test${path}`, {
                method: "POST",
                headers: { "next-action": "7f9c1d2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9" },
            });
            const response = (await proxy(request, event)) as Response;
            assert.equal(
                response.headers.get("x-middleware-next"),
                null,
                `${path} must not pass an action dispatch through to the app`,
            );
            assert.equal(response.status, 403, path);
        }
    });
});

test("round 46: the action content-type is refused the same way as the header", async () => {
    await inProduction(async () => {
        const { default: proxy } = await loadProxy();
        const { NextRequest } = await import("next/server");
        const request = new NextRequest("https://probuild.test/api/health/pipeline", {
            method: "POST",
            headers: { "content-type": "text/x-component" },
        });
        const response = (await proxy(request, { waitUntil() {} } as any)) as Response;
        assert.equal(response.headers.get("x-middleware-next"), null);
        assert.equal(response.status, 403);
    });
});

test("round 46: every bypassed path except the anonymous-action trees refuses a dispatch", async () => {
    // The audit the finding asked for. Each of these is bypassed for a reason
    // that has nothing to do with actions — an ops read, a machine-to-machine
    // webhook, a self-authorizing PDF route, a static legal page — and each was
    // an open dispatcher.
    await inProduction(async () => {
        const { default: proxy } = await loadProxy();
        const { NextRequest } = await import("next/server");
        const event = { waitUntil() {} } as any;
        const refused = [
            "/api/health",
            "/api/health/pipeline",
            "/api/office-tasks/ingest",
            "/api/pdf/invoices/abc",
            "/api/version",
            "/api/mobile/leads",
            "/login",
            "/share/room/tok",
            "/privacy",
            "/support",
        ];
        for (const path of refused) {
            const response = (await proxy(
                new NextRequest(`https://probuild.test${path}`, {
                    method: "POST",
                    headers: { "next-action": "deadbeef" },
                }),
                event,
            )) as Response;
            assert.equal(response.status, 403, `${path} must refuse an action dispatch`);
        }
    });
});

test("round 46: the portal trees still dispatch their own anonymous actions (control)", async () => {
    // Without this the rule above would also pass if the proxy refused EVERY
    // action dispatch, which would break client approvals and portal payments.
    await inProduction(async () => {
        const { default: proxy } = await loadProxy();
        const { NextRequest } = await import("next/server");
        const event = { waitUntil() {} } as any;
        for (const path of ["/portal/estimates/abc", "/sub-portal/projects/abc"]) {
            const response = (await proxy(
                new NextRequest(`https://probuild.test${path}`, {
                    method: "POST",
                    headers: { "next-action": "deadbeef" },
                }),
                event,
            )) as Response;
            assert.equal(
                response.headers.get("x-middleware-next"),
                "1",
                `${path} serves anonymous actions and must still reach them`,
            );
        }
    });
});

test("round 46: an ordinary GET to the health paths still passes through (control)", async () => {
    await inProduction(async () => {
        const { default: proxy } = await loadProxy();
        const { NextRequest } = await import("next/server");
        const response = (await proxy(
            new NextRequest("https://probuild.test/api/health/pipeline", { method: "GET" }),
            { waitUntil() {} } as any,
        )) as Response;
        assert.equal(response.headers.get("x-middleware-next"), "1");
    });
});
