import { test, expect } from "@playwright/test";
import { FIELD_CREW_EMAIL, FIELD_CREW_PIN, TOKEN_STORAGE_KEY, loginWithPin } from "./helpers";

// Auth flow for the Expo-web build: PIN sign-in (components/Auth.tsx's "Use PIN instead"
// form), token persistence across reload, and the 401 -> logout bounce that
// setUnauthorizedHandler (lib/auth-store.ts) + app/_layout.tsx's routing effect wire up.

test.describe.serial("Mobile auth", () => {
    test("PIN happy path lands on the time-clock tab", async ({ page }) => {
        await loginWithPin(page, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        await expect(page.getByText("TIME CLOCK", { exact: true })).toBeVisible();
    });

    test("wrong PIN shows an error and stays on the login form", async ({ page }) => {
        await page.goto("/");
        await page.evaluate(() => window.localStorage.clear());
        await page.goto("/");

        await page.getByText("Use PIN instead").click();
        await page.getByPlaceholder("you@company.com").fill(FIELD_CREW_EMAIL);
        await page.getByPlaceholder("••••").fill("000000");
        await page.getByText("Sign in with PIN", { exact: true }).click();

        // Auth.tsx's onPinPress -> showDialog("Sign-in failed", "Invalid email or PIN.")
        // on a 401 from /api/mobile/login.
        await expect(page.getByText("Sign-in failed")).toBeVisible({ timeout: 15000 });
        await expect(page.getByText("Invalid email or PIN.")).toBeVisible();
        await page.getByText("OK", { exact: true }).click();

        // Still on the login form, not routed to the tabs.
        await expect(page.getByText("Sign in with PIN", { exact: true })).toBeVisible();
        await expect(page.getByText("TIME CLOCK", { exact: true })).toHaveCount(0);
    });

    test("token persists across a page reload", async ({ page }) => {
        await loginWithPin(page, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        await page.reload();
        // bootstrap() re-validates the stored token via /api/mobile/me and lands back on
        // the same tab without requiring a fresh sign-in.
        await expect(page.getByText("TIME CLOCK", { exact: true })).toBeVisible({ timeout: 20000 });
    });

    test("a corrupted token is rejected on the next API call and bounces to login", async ({ page }) => {
        await loginWithPin(page, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        await page.evaluate(
            (key) => window.localStorage.setItem(key, "not-a-valid-jwt"),
            TOKEN_STORAGE_KEY
        );
        // Reload triggers bootstrap() -> api.me() -> 401 (jwtVerify throws on a malformed
        // token) -> user cleared -> login screen.
        await page.reload();
        await expect(page.getByText("Sign in with Google")).toBeVisible({ timeout: 20000 });
        await expect(page.getByText("TIME CLOCK", { exact: true })).toHaveCount(0);
    });
});
