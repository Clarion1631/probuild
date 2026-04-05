import { test as setup, expect } from "@playwright/test";

setup("authenticate", async ({ page }) => {
  await page.goto("/api/auth/signin");

  // Click the "Sign in with Test" button to get to the credentials form
  await page.getByText("Sign in with Test").click();

  // Fill the credentials form
  await page.locator('input[name="email"]').fill("jadkins@goldentouchremodeling.com");
  await page.locator('input[name="secret"]').fill(process.env.PLAYWRIGHT_TEST_SECRET || "");

  // Submit the form
  await page.locator('button[type="submit"]').click();

  // Wait for redirect after successful login
  await page.waitForURL("**/projects**", { timeout: 15_000 });
  await expect(page).not.toHaveURL(/.*signin.*/);

  // Save signed-in state
  await page.context().storageState({ path: "e2e/.auth/user.json" });
});
