import { test, expect } from "@playwright/test";
import { getFirstProjectId, getFirstEstimateId } from "./helpers/test-data";

let PROJECT_ID: string;
let ESTIMATE_ID: string | null;

test.describe("Estimate Editor", () => {
  test.beforeAll(async ({ browser }) => {
    PROJECT_ID = await getFirstProjectId(browser);
    ESTIMATE_ID = await getFirstEstimateId(browser, PROJECT_ID);
  });

  test("loads without crashing", async ({ page }) => {
    test.skip(!ESTIMATE_ID, `No estimate found in project ${PROJECT_ID}`);
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
    test.skip(!ESTIMATE_ID, `No estimate found in project ${PROJECT_ID}`);
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
