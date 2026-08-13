import { test as setup, expect } from "@playwright/test";

/**
 * Fourth storage state: an EMPLOYEE staff reader holding `contracts` +
 * `leadAccess`, scoped to a single project.
 *
 * ADMIN and MANAGER short-circuit hasPermission() to true and
 * accessibleProjectIds() to "ALL" (ADMIN_ROLES in access-rules.ts), so an
 * ADMIN-only suite can never reach the branch where a caller genuinely holds
 * the `contracts` permission but is still refused on horizontal scope — the
 * case where a converted contract carries both a projectId the caller cannot
 * reach and a leadId that would otherwise rescue it. This session IS the test
 * for that branch — see e2e/contract-auth-runtime.spec.ts, Block C.
 *
 * The fixture (user, permissions, single ProjectAccess row) is seeded by
 * data.setup.ts, which this project depends on.
 */
setup("authenticate contract staff", async ({ page }) => {
  const baseURL = "http://localhost:3000";
  const email = "contract-staff@test.local";

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
  // session. That fallback would make every assertion in the contract spec pass
  // for the wrong reason, so prove the session is this user and NOT an admin
  // before saving the state.
  const sessionRes = await page.request.get(`${baseURL}/api/auth/session`);
  expect(sessionRes.ok()).toBeTruthy();
  const session = await sessionRes.json();
  expect(session.user).toMatchObject({ email, role: "EMPLOYEE" });
  expect(session.user.id).toBeTruthy();

  await page.goto("/projects", { waitUntil: "networkidle", timeout: 15_000 });
  await expect(page).not.toHaveURL(/.*login.*/);

  await page.context().storageState({ path: "e2e/.auth/contract-user.json" });
});
