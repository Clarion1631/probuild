import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getUserWithPermissionsByEmail } from "../src/lib/permissions";
import { isStaffAccountEnabled } from "../src/lib/staff-status";

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
