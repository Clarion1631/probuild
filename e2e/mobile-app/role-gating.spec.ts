import { test, expect } from "@playwright/test";
import { FIELD_CREW_EMAIL, FIELD_CREW_PIN, MANAGER_EMAIL, MANAGER_PIN, loginWithPin } from "./helpers";

// (tabs)/_layout.tsx hides the Manager and Employees tabs entirely (href: null, not just
// disabled) for anyone isManager(role) doesn't cover — FIELD_CREW here. MANAGER/ADMIN see
// (and can open) both.

test.describe.serial("Mobile role gating", () => {
    test("field crew sees no Manager or Employees tabs", async ({ page }) => {
        await loginWithPin(page, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        await expect(page.getByText("Manager", { exact: true })).toHaveCount(0);
        await expect(page.getByText("Employees", { exact: true })).toHaveCount(0);
    });

    test("manager sees both tabs and can open them", async ({ page }) => {
        await loginWithPin(page, MANAGER_EMAIL, MANAGER_PIN);
        await expect(page.getByText("Manager", { exact: true })).toBeVisible();
        await expect(page.getByText("Employees", { exact: true })).toBeVisible();

        // exact: true — the tab bar's own "Employees"/"Manager" labels stay on screen
        // alongside each header's uppercase subtitle, and getByText's default match is
        // case-insensitive substring (proven by an earlier "TIME CLOCK" vs "Time Clock"
        // strict-mode collision here).
        await page.getByText("Employees", { exact: true }).click();
        await expect(page.getByText("EMPLOYEES", { exact: true })).toBeVisible({ timeout: 15000 });

        await page.getByText("Manager", { exact: true }).click();
        await expect(page.getByText("MANAGER DASHBOARD", { exact: true })).toBeVisible({ timeout: 15000 });
    });
});
