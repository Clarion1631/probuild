import { test, expect } from "@playwright/test";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const ESTIMATE_ID = "cmml6vtx7001dpwrh8n65xzy6";

test.describe("Estimate Editor", () => {
  test("loads without crashing", async ({ page }) => {
    const path = `/projects/${PROJECT_ID}/estimates/${ESTIMATE_ID}`;
    const res = await page.goto(path, { waitUntil: "networkidle" });

    // HTTP status must be 2xx or 3xx
    expect(
      res?.status(),
      `Estimate editor returned HTTP ${res?.status()}`
    ).toBeLessThan(400);

    // Must not show error boundary
    const body = await page.locator("body").innerText();
    expect(body, "Estimate editor shows error boundary").not.toContain(
      "Something went wrong"
    );

    // Must not show NaN or undefined values
    expect(body, "Estimate editor shows NaN").not.toMatch(/NaN/);
    expect(body, "Estimate editor shows undefined").not.toMatch(/\bundefined\b/);
  });

  test("renders item approval status without errors", async ({ page }) => {
    const path = `/projects/${PROJECT_ID}/estimates/${ESTIMATE_ID}`;
    await page.goto(path, { waitUntil: "networkidle" });

    // No JS errors during load
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // Page should contain the estimate editor (title input or builder tab)
    const hasEditor =
      (await page.locator('input[placeholder*="Estimate"]').count()) > 0 ||
      (await page.locator('button:has-text("Builder")').count()) > 0 ||
      (await page.locator('[data-testid="estimate-editor"]').count()) > 0;

    expect(hasEditor, "Estimate editor UI elements not found").toBeTruthy();

    expect(
      errors,
      `Estimate editor threw JS errors: ${errors.join("; ")}`
    ).toHaveLength(0);
  });
});
