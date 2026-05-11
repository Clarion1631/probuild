import { test as setup, expect } from "@playwright/test";

setup("authenticate", async ({ page }) => {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
  const secret = process.env.PLAYWRIGHT_TEST_SECRET;

  if (!secret) {
    throw new Error("PLAYWRIGHT_TEST_SECRET is required for Playwright auth setup.");
  }

  // Get CSRF token from NextAuth (use page.request to share cookies with page)
  const csrfRes = await page.request.get(`${baseURL}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json();

  // POST directly to the credentials callback (bypasses custom login page)
  const authRes = await page.request.post(`${baseURL}/api/auth/callback/credentials`, {
    form: {
      csrfToken,
      email: "jadkins@goldentouchremodeling.com",
      secret,
    },
  });

  expect(authRes.ok(), `Credentials auth failed with ${authRes.status()}`).toBeTruthy();

  // Navigate to a protected page to verify the session is active
  await page.goto("/projects", { waitUntil: "networkidle", timeout: 15_000 });

  // Should NOT be on the login page
  await expect(page).not.toHaveURL(/.*login.*/);

  // Save signed-in state
  await page.context().storageState({ path: "e2e/.auth/user.json" });
});
