import { type Browser } from "@playwright/test";

const AUTH_STATE = "e2e/.auth/user.json";
const BASE_URL = "http://localhost:3000";

// Pick the first project ID visible on /projects. Throws if no project exists,
// since these tests can't run without one. Use in a beforeAll to capture once.
export async function getFirstProjectId(browser: Browser): Promise<string> {
    const ctx = await browser.newContext({ storageState: AUTH_STATE });
    try {
        const page = await ctx.newPage();
        await page.goto(`${BASE_URL}/projects`, { waitUntil: "networkidle", timeout: 30_000 });
        const href = await page
            .locator('a[href^="/projects/"]')
            .first()
            .getAttribute("href", { timeout: 10_000 });
        if (!href) throw new Error("No project links found on /projects");
        const m = href.match(/^\/projects\/([a-z0-9]+)(?:[/?#]|$)/i);
        if (!m) throw new Error(`Could not extract project ID from href: ${href}`);
        return m[1];
    } finally {
        await ctx.close();
    }
}

// Pick the first estimate ID inside a given project. Returns null if the
// project has no estimates — caller should test.skip in that case.
export async function getFirstEstimateId(browser: Browser, projectId: string): Promise<string | null> {
    const ctx = await browser.newContext({ storageState: AUTH_STATE });
    try {
        const page = await ctx.newPage();
        await page.goto(`${BASE_URL}/projects/${projectId}/estimates`, { waitUntil: "networkidle", timeout: 30_000 });
        const href = await page
            .locator(`a[href*="/projects/${projectId}/estimates/"]`)
            .first()
            .getAttribute("href", { timeout: 5_000 })
            .catch(() => null);
        if (!href) return null;
        const m = href.match(/\/estimates\/([a-z0-9]+)(?:[/?#]|$)/i);
        return m ? m[1] : null;
    } finally {
        await ctx.close();
    }
}
