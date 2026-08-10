import { test as setup, expect } from "@playwright/test";

/**
 * Second storage state: a staff reader whose project scope is PARTIAL.
 *
 * Mirrors auth.setup.ts, which logs in the ADMIN. ADMIN is useless for scope
 * assertions — accessibleProjectIds() short-circuits to "ALL" for it — so every
 * "your projects" / "you can see" label was previously unreachable at runtime
 * and only greppable in source. This session reaches those branches for real.
 *
 * The fixture (user, permissions, single ProjectAccess row, out-of-scope
 * project) is seeded by data.setup.ts, which this project depends on.
 */
setup("authenticate scoped staff", async ({ page }) => {
  const baseURL = "http://localhost:3000";
  const email = "scoped-staff@test.local";

  const csrfRes = await page.request.get(`${baseURL}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json();

  const authRes = await page.request.post(`${baseURL}/api/auth/callback/credentials`, {
    form: {
      csrfToken,
      email,
      secret: process.env.PLAYWRIGHT_TEST_SECRET || "",
    },
  });
  expect(authRes.ok(), `Credentials callback failed at ${authRes.url()}`).toBeTruthy();

  // In development the app falls back to a known ADMIN when there is no
  // session. That fallback would make every assertion in the scoped spec pass
  // for the wrong reason, so prove the session is this user and NOT an admin
  // before saving the state.
  const sessionRes = await page.request.get(`${baseURL}/api/auth/session`);
  expect(sessionRes.ok()).toBeTruthy();
  const session = await sessionRes.json();
  expect(session.user).toMatchObject({ email, role: "EMPLOYEE" });
  expect(session.user.id).toBeTruthy();

  await page.goto("/projects", { waitUntil: "networkidle", timeout: 15_000 });
  await expect(page).not.toHaveURL(/.*login.*/);

  await page.context().storageState({ path: "e2e/.auth/scoped-user.json" });
});
