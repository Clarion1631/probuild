import { test as setup, expect } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

// Load .env.local for PLAYWRIGHT_TEST_SECRET
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const PROD_URL = "https://probuild-amber.vercel.app";

setup("authenticate against production", async ({ page }) => {
  // 1. Get CSRF token
  const csrfRes = await page.request.get(`${PROD_URL}/api/auth/csrf`);
  expect(csrfRes.ok(), "Failed to fetch CSRF token").toBeTruthy();
  const { csrfToken } = await csrfRes.json();

  const secret = process.env.PLAYWRIGHT_TEST_SECRET || "";
  console.log(`[auth] CSRF token: ${csrfToken?.slice(0, 8)}...`);
  console.log(`[auth] Secret length: ${secret.length}`);

  // 2. POST credentials
  const authRes = await page.request.post(
    `${PROD_URL}/api/auth/callback/credentials`,
    {
      form: {
        csrfToken,
        email: "jadkins@goldentouchremodeling.com",
        secret,
      },
    }
  );
  console.log(`[auth] POST status: ${authRes.status()}`);
  console.log(`[auth] POST URL: ${authRes.url()}`);
  console.log(`[auth] POST headers:`, authRes.headers());

  // 3. Verify session by navigating to a protected page
  await page.goto(`${PROD_URL}/projects`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  console.log(`[auth] Final URL: ${page.url()}`);

  // If we're on login page, try alternative: direct cookie approach
  if (page.url().includes("login")) {
    // Try calling the session endpoint to see what we get
    const sessionRes = await page.request.get(`${PROD_URL}/api/auth/session`);
    const session = await sessionRes.json();
    console.log(`[auth] Session check:`, JSON.stringify(session));
  }

  await expect(page).not.toHaveURL(/.*login.*/);

  // 4. Save auth state for production
  await page.context().storageState({ path: "e2e/.auth/prod-user.json" });
});
