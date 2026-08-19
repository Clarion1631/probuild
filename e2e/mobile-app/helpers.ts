import { expect, type Page } from "@playwright/test";

// Fixture ids seeded by e2e/data.setup.ts — see its "Mobile-app + suggestion spec
// fixtures" section. Kept in one place so every mobile-app spec references the same
// constants instead of re-typing them.
export const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
export const PROJECT_NAME = "Test Project — DO NOT DELETE (used by e2e)";

export const COST_CODE_DEMO_ID = "e2e-mob-cc-demo";
export const COST_CODE_DRYW_ID = "e2e-mob-cc-dryw";

export const MOBILE_ESTIMATE_ID = "e2e-mob-estimate";
export const MOBILE_ITEM_DEMO_ID = "e2e-mob-item-demo";
export const MOBILE_ITEM_DRYW_ID = "e2e-mob-item-dryw";
export const MOBILE_TASK_DRYW_ID = "e2e-mob-task-dryw";
export const MOBILE_DAILYLOG_ID = "e2e-mob-dailylog";
export const MOBILE_TIME_ENTRY_HIST_ID = "e2e-mob-entry-hist";

export const FIELD_CREW_EMAIL = "field-crew@test.local";
export const FIELD_CREW_PIN = "246810";
export const MANAGER_EMAIL = "manager@test.local";
export const MANAGER_PIN = "135790";

// Key secureToken.ts uses to persist the bearer JWT in localStorage on web.
export const TOKEN_STORAGE_KEY = "probuild.mobileJwt";

/** Short unique-enough suffix for spec-created rows (id/name collisions across runs). */
export function runId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function clearLocalStorage(page: Page) {
    await page.evaluate(() => window.localStorage.clear());
}

/**
 * Drives the real PIN sign-in form (Auth.tsx's "Use PIN instead" toggle) from a clean
 * (logged-out) localStorage, and waits for the Time Clock tab to land. Every mobile-app
 * spec should start from this instead of assuming session state left by another test.
 */
export async function loginWithPin(page: Page, email: string, pin: string): Promise<void> {
    // A page must exist at the app's origin before localStorage is reachable — first load,
    // then clear, then reload so the login form starts from a genuinely logged-out state.
    await page.goto("/");
    await clearLocalStorage(page);
    await page.goto("/");

    await page.getByText("Use PIN instead").click();
    await page.getByPlaceholder("you@company.com").fill(email);
    await page.getByPlaceholder("••••").fill(pin);
    await page.getByText("Sign in with PIN", { exact: true }).click();

    // BrandHeader's uppercase subtitle on the Time Clock tab — unique to that screen and
    // stable regardless of clocked-in/break/off-clock badge state. Playwright's default
    // getByText match is case-INsensitive substring, so without `exact: true` this also
    // matches the card title "Time Clock" and the tab label "Time Clock" (strict-mode
    // violation — 3 elements).
    await expect(page.getByText("TIME CLOCK", { exact: true })).toBeVisible({ timeout: 20000 });
}
