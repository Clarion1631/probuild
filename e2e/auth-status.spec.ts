import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getUserWithPermissionsByEmail } from "../src/lib/permissions";
import { isStaffAccountEnabled } from "../src/lib/staff-status";
import proxy, { config, isPublicProxyBypass } from "../src/proxy";

const prisma = new PrismaClient();
const STAFF_EMAIL = "auth-status-e2e@goldentouchremodeling.com";

async function signInWithTestCredentials(page: Page) {
  const csrfResponse = await page.request.get("/api/auth/csrf");
  expect(csrfResponse.ok()).toBeTruthy();
  const { csrfToken } = await csrfResponse.json();

  await page.request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken,
      email: STAFF_EMAIL,
      secret: process.env.PLAYWRIGHT_TEST_SECRET || "",
    },
  });
}

test("health proxy bypass remains exact in both matching paths", () => {
  expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/health" })).toBe(false);
  expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/health/private" })).toBe(true);
  expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/admin/stripe-backfill" })).toBe(true);
  expect(isPublicProxyBypass("/api/health")).toBe(true);
  expect(isPublicProxyBypass("/api/health/private")).toBe(false);
  expect(isPublicProxyBypass("/api/admin/stripe-backfill")).toBe(false);
});

test("health proxy runtime keeps nested and unrelated APIs protected", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const exact = await proxy(new NextRequest("http://localhost:3000/api/health"), { waitUntil() {} });
    expect(exact.headers.get("x-middleware-next")).toBe("1");

    for (const path of ["/api/health/private", "/api/admin/stripe-backfill"]) {
      const response = await proxy(new NextRequest(`http://localhost:3000${path}`), { waitUntil() {} });
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/login");
    }
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

test.describe("public deployment probe", () => {
  test("only the exact /api/health path bypasses production authentication", async ({ playwright }) => {
    const baseURL = test.info().project.use.baseURL as string;
    const anonymous = await playwright.request.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const session = await anonymous.get("/api/auth/session", { maxRedirects: 0 });
      expect(session.status()).toBe(200);
      expect(await session.json()).toEqual({});

      const health = await anonymous.get("/api/health", { maxRedirects: 0 });
      expect(health.status()).toBe(200);
      expect(health.headers()["cache-control"]).toBe("no-store, max-age=0");
      const body = await health.json();
      expect(Object.keys(body).sort()).toEqual(["status", "ts"]);
      expect(body.status).toBe("ok");
      expect(typeof body.ts).toBe("string");
      const timestamp = Date.parse(body.ts);
      expect(Number.isNaN(timestamp)).toBe(false);
      expect(new Date(timestamp).toISOString()).toBe(body.ts);
      expect(Math.abs(Date.now() - timestamp)).toBeLessThan(10_000);

      const nested = await anonymous.get("/api/health/private", { maxRedirects: 0 });
      const protectedApi = await anonymous.post("/api/admin/stripe-backfill", {
        data: "not-json",
        headers: { "content-type": "application/json" },
        maxRedirects: 0,
      });
      if (process.env.CI) {
        // The CI runner can surface a 404 for this nested route before proxy
        // handling; accept only that fail-closed result or the expected login redirect.
        expect([307, 404]).toContain(nested.status());
        if (nested.status() === 307) {
          expect(nested.headers().location).toContain("/login");
        }
        expect(protectedApi.status()).toBe(307);
        expect(protectedApi.headers().location).toContain("/login");
      } else {
        expect(nested.status()).toBe(404);
        expect(protectedApi.status()).toBe(403);
      }
    } finally {
      await anonymous.dispose();
    }
  });
});

test.describe.serial("staff status revokes existing sessions", () => {
  test.beforeAll(async () => {
    await prisma.user.upsert({
      where: { email: STAFF_EMAIL },
      update: { name: "Auth Status E2E", role: "ADMIN", status: "ACTIVATED" },
      create: {
        email: STAFF_EMAIL,
        name: "Auth Status E2E",
        role: "ADMIN",
        status: "ACTIVATED",
      },
    });
  });

  test.afterAll(async () => {
    try {
      await prisma.user.deleteMany({ where: { email: STAFF_EMAIL } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("active test login works, then DISABLED blocks the stale session", async ({ page }) => {
    await signInWithTestCredentials(page);

    const activeSessionResponse = await page.request.get("/api/auth/session");
    const activeSession = await activeSessionResponse.json();
    expect(activeSession.user).toMatchObject({
      email: STAFF_EMAIL,
      role: "ADMIN",
    });
    expect(activeSession.user.id).toBeTruthy();
    expect(await getUserWithPermissionsByEmail(STAFF_EMAIL)).not.toBeNull();
    expect(await isStaffAccountEnabled(STAFF_EMAIL)).toBe(true);

    await prisma.user.update({
      where: { email: STAFF_EMAIL },
      data: { status: "DISABLED" },
    });

    // Exercise the database-backed guards independently of JWT refresh. This
    // catches regressions where the token is revoked but permission lookups or
    // the production proxy still accept a disabled User row.
    expect(await getUserWithPermissionsByEmail(STAFF_EMAIL)).toBeNull();
    expect(await isStaffAccountEnabled(STAFF_EMAIL)).toBe(false);

    if (process.env.CI) {
      // Server Action requests are matched even on public portal routes. This
      // closes the stale-cookie bypass around the normal protected-route proxy.
      const publicActionReplay = await page.request.post("/portal", {
        headers: { "next-action": "not-a-real-action-id" },
        maxRedirects: 0,
      });
      expect(publicActionReplay.status()).toBe(403);
    }

    // Invalid JSON is deliberate: an active ADMIN reaches body validation (400),
    // while a revoked session must stop before validation at an auth boundary.
    const protectedResponse = await page.request.post("/api/admin/stripe-backfill", {
      data: "not-json",
      headers: { "content-type": "application/json" },
      maxRedirects: 0,
    });
    if (process.env.CI) {
      // `next start` exercises the production proxy. The stale JWT has not
      // refreshed yet, so this proves the proxy checks current DB status.
      expect(protectedResponse.status()).toBe(307);
      expect(protectedResponse.headers().location).toContain("/login");
    } else {
      // The development proxy is intentionally bypassed; the route's shared
      // permission guard must still reject the disabled user.
      expect(protectedResponse.status()).toBe(403);
    }

    const bogusBearerResponse = await page.request.post("/api/admin/stripe-backfill", {
      data: "not-json",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-real-mobile-token",
      },
      maxRedirects: 0,
    });
    if (process.env.CI) {
      expect(bogusBearerResponse.status()).toBe(307);
      expect(bogusBearerResponse.headers().location).toContain("/login");
    } else {
      expect(bogusBearerResponse.status()).toBe(403);
    }

    const disabledSessionResponse = await page.request.get("/api/auth/session");
    expect(await disabledSessionResponse.json()).toEqual({});

    await prisma.user.update({
      where: { email: STAFF_EMAIL },
      data: { status: "ACTIVATED" },
    });

    const reactivatedSessionResponse = await page.request.get("/api/auth/session");
    const reactivatedSession = await reactivatedSessionResponse.json();
    expect(reactivatedSession.user).toMatchObject({
      email: STAFF_EMAIL,
      role: "ADMIN",
    });

    await prisma.user.delete({ where: { email: STAFF_EMAIL } });

    expect(await getUserWithPermissionsByEmail(STAFF_EMAIL)).toBeNull();
    expect(await isStaffAccountEnabled(STAFF_EMAIL)).toBe(false);

    const deletedUserSessionResponse = await page.request.get("/api/auth/session");
    expect(await deletedUserSessionResponse.json()).toEqual({});
  });

  test("invoice mutations enforce authorization inside the server action", async () => {
    const source = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");

    for (const actionName of ["deleteInvoice", "updateInvoiceNotes"]) {
      const actionStart = source.indexOf(`export async function ${actionName}`);
      expect(actionStart, `${actionName} must remain exported`).toBeGreaterThanOrEqual(0);
      const nextAction = source.indexOf("\nexport async function ", actionStart + 1);
      const actionSource = source.slice(actionStart, nextAction === -1 ? undefined : nextAction);
      const authIndex = actionSource.indexOf("await assertInvoicePermission()");
      const databaseIndex = actionSource.indexOf("prisma.");

      expect(authIndex, `${actionName} must authorize internally`).toBeGreaterThanOrEqual(0);
      expect(authIndex, `${actionName} must authorize before database access`).toBeLessThan(databaseIndex);
    }
  });
});
