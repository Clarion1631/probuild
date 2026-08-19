import { test, expect } from "@playwright/test";

/**
 * RUNTIME proof for the scoped-total labels shipped in PR #346.
 *
 * Three layers guard this behaviour and they prove different things:
 *   - estimate-scope-rules.spec.ts  — the pure rule, over a truth table.
 *   - financial-action-auth.spec.ts — the wiring, by reading the source.
 *   - this file                     — the rendered page, in a real browser.
 *
 * Only the third can catch a page that computes the flag correctly and then
 * renders the wrong string, because only it looks at what the reader sees.
 *
 * The whole thing hinges on running as a NON-ADMIN: accessibleProjectIds()
 * returns "ALL" for ADMIN and MANAGER, so under the default admin session every
 * qualified label is dead code. e2e/auth-scoped.setup.ts provides the second
 * session; e2e/data.setup.ts provides the one-project-of-two fixture.
 *
 * Creates no data — the fixtures are stable upserts owned by data.setup.ts —
 * so there is nothing to tear down.
 */

const OOS_LEAD_ID = "e2e-scope-oos-lead";
const OOS_PROJECT_ID = "e2e-scope-oos-project";
const IN_SCOPE_PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const OOS_PROJECT_NAME = "E2E Out-Of-Scope Project — DO NOT DELETE";

const ADMIN_STATE = "e2e/.auth/user.json";
const SCOPED_STATE = "e2e/.auth/scoped-user.json";

test.describe("scoped staff (one project of two)", () => {
    test.use({ storageState: SCOPED_STATE });

    test("/projects qualifies the revenue label while still counting every project", async ({ page }) => {
        await page.goto("/projects", { waitUntil: "networkidle" });

        // The list itself is NOT scoped: the out-of-scope project is on screen.
        // That is the whole hazard — a company-wide row count sitting beside a
        // per-caller revenue sum. If this ever stops being true the label
        // question is moot and this spec should be revisited, not deleted.
        // Attached, not visible: the page renders both the list and the kanban
        // markup and hides the inactive one, so visibility would assert which
        // view happens to be selected rather than what the query returned.
        await expect(page.locator(`a[href="/projects/${OOS_PROJECT_ID}"]`).first()).toBeAttached();

        await expect(page.getByText("Revenue (your projects)")).toBeVisible();
        await expect(page.getByText("Excludes projects you don't have access to")).toBeVisible();
        await expect(page.getByText("Total Revenue", { exact: true })).toHaveCount(0);
    });

    test("a converted lead whose project is out of scope qualifies all three cards", async ({ page }) => {
        await page.goto(`/leads/${OOS_LEAD_ID}/estimates`, { waitUntil: "networkidle" });

        await expect(page.getByText("Across the estimates you can see")).toBeVisible();
        await expect(page.getByText("Visible to you")).toBeVisible();
        await expect(page.getByText(`you don't have access to ${OOS_PROJECT_NAME}`)).toBeVisible();

        // The exact figures, not just the strings: the lead-owned $1,000 is in,
        // the project-owned $5,000 is out. A wildcard "N approved" would still
        // pass if the fixture degraded to zero rows, which is precisely the
        // state in which a hedged label proves nothing.
        await expect(page.getByText("1 approved that you can see")).toBeVisible();
        await expect(page.getByText("$1,000.00").first()).toBeVisible();
        await expect(page.getByText("$6,000.00")).toHaveCount(0);

        // The unqualified claims must be gone, not merely joined.
        await expect(page.getByText("Across all estimates")).toHaveCount(0);
        await expect(page.getByText("Total created")).toHaveCount(0);
    });
});

test.describe("admin (sees everything)", () => {
    test.use({ storageState: ADMIN_STATE });

    test("/projects keeps the unqualified revenue label", async ({ page }) => {
        await page.goto("/projects", { waitUntil: "networkidle" });

        await expect(page.getByText("Total Revenue", { exact: true })).toBeVisible();
        await expect(page.getByText("Revenue (your projects)")).toHaveCount(0);
        await expect(page.getByText("Excludes projects you don't have access to")).toHaveCount(0);
    });

    test("the same lead's cards claim completeness", async ({ page }) => {
        await page.goto(`/leads/${OOS_LEAD_ID}/estimates`, { waitUntil: "networkidle" });

        await expect(page.getByText("Across all estimates")).toBeVisible();
        await expect(page.getByText("Total created")).toBeVisible();
        await expect(page.getByText("Across the estimates you can see")).toHaveCount(0);
        await expect(page.getByText("Visible to you")).toHaveCount(0);
        await expect(page.getByText(/approved that you can see/)).toHaveCount(0);

        // Same two estimates, both in scope: $1,000 lead + $5,000 project. The
        // scoped reader's $1,000 above is the same page missing this row.
        await expect(page.getByText("2 approved", { exact: true })).toBeVisible();
        await expect(page.getByText("$6,000.00").first()).toBeVisible();
    });
});

test("both sessions list the same two projects, and only one of them hedges", async ({ browser }) => {
    // This is what makes the differing revenue labels meaningful: it rules out
    // the alternative explanation that the scoped reader simply sees fewer
    // project rows, in which case a scoped total would need no hedge at all.
    //
    // Asserted over the two fixture ids rather than the "Total Projects" number:
    // the suite is fully parallel and other specs create and delete projects, so
    // that count is not stable between two sequential page loads.
    for (const [label, storageState] of [["admin", ADMIN_STATE], ["scoped", SCOPED_STATE]] as const) {
        const context = await browser.newContext({ storageState });
        const page = await context.newPage();
        await page.goto("/projects", { waitUntil: "networkidle" });

        for (const id of [IN_SCOPE_PROJECT_ID, OOS_PROJECT_ID]) {
            await expect(
                page.locator(`a[href="/projects/${id}"]`).first(),
                `${label} should see project ${id} in the company-wide list`,
            ).toBeAttached();
        }

        const hedged = await page.getByText("Excludes projects you don't have access to").count();
        expect(hedged, `${label} hedge`).toBe(label === "scoped" ? 1 : 0);

        await context.close();
    }
});
