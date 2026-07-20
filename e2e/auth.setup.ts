import { test as setup, expect } from "@playwright/test";

setup("authenticate", async ({ page }) => {
  const baseURL = "http://localhost:3000";
  const email = "jadkins@goldentouchremodeling.com";

  // Get CSRF token from NextAuth (use page.request to share cookies with page)
  const csrfRes = await page.request.get(`${baseURL}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json();

  // POST directly to the credentials callback (bypasses custom login page)
  const authRes = await page.request.post(`${baseURL}/api/auth/callback/credentials`, {
    form: {
      csrfToken,
      email,
      secret: process.env.PLAYWRIGHT_TEST_SECRET || "",
    },
  });
  expect(authRes.ok(), `Credentials callback failed at ${authRes.url()}`).toBeTruthy();

  // The app has a development-only unauthenticated UI fallback, so merely
  // reaching /projects is not proof that the credentials session exists.
  const sessionRes = await page.request.get(`${baseURL}/api/auth/session`);
  expect(sessionRes.ok()).toBeTruthy();
  const session = await sessionRes.json();
  expect(session.user).toMatchObject({ email, role: "ADMIN" });
  expect(session.user.id).toBeTruthy();

  // Navigate to a protected page to verify the session is active
  await page.goto("/projects", { waitUntil: "networkidle", timeout: 15_000 });

  // Should NOT be on the login page
  await expect(page).not.toHaveURL(/.*login.*/);

  // Save signed-in state
  await page.context().storageState({ path: "e2e/.auth/user.json" });
});
