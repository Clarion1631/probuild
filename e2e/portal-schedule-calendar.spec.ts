import { expect, test } from "@playwright/test";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";

test.describe("Client portal schedule", () => {
  test("opens in Calendar view and can switch to Gantt", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem("probuild:portal:schedule:viewMode");
      localStorage.removeItem("probuild:portal:schedule:calendarSubMode");
    });

    await page.goto(`/portal/projects/${PROJECT_ID}/schedule`, {
      waitUntil: "load",
    });

    await expect(
      page.getByRole("heading", { name: "Project Schedule" })
    ).toBeVisible();

    await expect(page.getByRole("button", { name: "Calendar" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByRole("button", { name: "Gantt" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    await expect(page.getByRole("button", { name: /month/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    await page.getByRole("button", { name: "Gantt" }).click();
    await expect(page.getByRole("button", { name: "Gantt" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByRole("button", { name: "Calendar" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    await page.getByRole("button", { name: "Calendar" }).click();
    await expect(page.getByRole("button", { name: "Calendar" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
