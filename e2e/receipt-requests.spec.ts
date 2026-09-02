import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * The Receipts tab and its two machine bridge endpoints, at the real HTTP
 * surface (throwaway CI Postgres — data.setup.ts guards prod, docs/TESTING.md).
 *
 * Two things source-reading cannot prove and these can:
 *   1. `/automation?tab=receipts` renders the six group headings for an ADMIN
 *      session instead of hitting the route error boundary.
 *   2. The bridge endpoints answer 401 JSON — not a 307 to /login — for an
 *      anonymous caller AND for one carrying a bogus session cookie. That
 *      second case is the getclients-auth-gate lesson: a cookie must not be a
 *      way past a machine-secret gate, and a redirect is what a machine caller
 *      silently mis-reads as "try again later" forever.
 *
 * NOT covered here, deliberately: the "RECEIPT_INTAKE_SECRET is unset" branch —
 * a spec cannot unset an env var on the server it is talking to. That is pinned
 * as a unit test in tests/receipt-intake-auth.test.ts.
 *
 * This file creates NO data, so it needs no teardown.
 */

const THREADS_PATH = "/api/automation/receipt-requests/threads";
const ANSWERS_PATH = "/api/automation/receipt-requests/answers";

const GROUP_HEADINGS = ["Needs job", "Needs review", "Booking", "Booked today", "Missing receipts", "Duplicates"];

test.describe("Receipts tab", () => {
    test("an ADMIN sees all six groups, and the register stays reachable", async ({ page }) => {
        await page.goto("/automation?tab=receipts");
        await expect(page.getByRole("heading", { name: "Automation" })).toBeVisible();
        for (const heading of GROUP_HEADINGS) {
            await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        }
        // Both tab controls are present, so neither view is a dead end.
        await expect(page.getByRole("link", { name: "Register", exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "Receipts", exact: true })).toBeVisible();
    });

    test("an empty group says so rather than rendering a blank panel", async ({ page }) => {
        await page.goto("/automation?tab=receipts&group=duplicates");
        await expect(page.getByRole("heading", { name: "Duplicates", exact: true })).toBeVisible();
        // Either rows or an honest empty message — never nothing at all.
        const card = page.locator("section", { has: page.getByRole("heading", { name: "Duplicates", exact: true }) });
        await expect(card).not.toBeEmpty();
    });

    test("an unknown group falls back to every group instead of an error", async ({ page }) => {
        await page.goto("/automation?tab=receipts&group=not-a-real-group");
        for (const heading of GROUP_HEADINGS) {
            await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        }
    });
});

test.describe("bridge endpoint auth", () => {
    async function assertJsonUnauthorized(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
        expect(response.status()).toBe(401);
        // A redirect would be a 3xx; assert the JSON body too, so a future
        // change that starts redirecting can't pass by coincidence.
        expect((response.headers()["content-type"] ?? "")).toContain("application/json");
        expect(await response.json()).toMatchObject({ ok: false, reason: "unauthorized" });
    }

    test("GET threads with no auth is a JSON 401, not a login redirect", async ({ playwright, baseURL }) => {
        const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: {} });
        await assertJsonUnauthorized(await context.get(THREADS_PATH, { maxRedirects: 0 }));
        await context.dispose();
    });

    test("GET threads with a BOGUS session cookie is still a JSON 401", async ({ playwright, baseURL }) => {
        const context = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: { cookie: "next-auth.session-token=not-a-real-session" },
        });
        await assertJsonUnauthorized(await context.get(THREADS_PATH, { maxRedirects: 0 }));
        await context.dispose();
    });

    test("GET threads with a WRONG secret is refused outright", async ({ playwright, baseURL }) => {
        const context = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: { "x-receipt-intake-secret": "definitely-not-the-secret" },
        });
        await assertJsonUnauthorized(await context.get(THREADS_PATH, { maxRedirects: 0 }));
        await context.dispose();
    });

    test("POST answers with no auth is a JSON 401", async ({ playwright, baseURL }) => {
        const context = await playwright.request.newContext({ baseURL });
        const response = await context.post(ANSWERS_PATH, {
            data: { fingerprint: "pb-nope", signed: true },
            maxRedirects: 0,
        });
        await assertJsonUnauthorized(response);
        await context.dispose();
    });

    test("POST answers with a bogus session cookie is a JSON 401", async ({ playwright, baseURL }) => {
        const context = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: { cookie: "next-auth.session-token=not-a-real-session" },
        });
        const response = await context.post(ANSWERS_PATH, {
            data: { fingerprint: "pb-nope", signed: true },
            maxRedirects: 0,
        });
        await assertJsonUnauthorized(response);
        await context.dispose();
    });
});

test.describe("bridge endpoints with the machine secret", () => {
    const SECRET = process.env.RECEIPT_INTAKE_SECRET || "";
    test.skip(() => !SECRET, "RECEIPT_INTAKE_SECRET is not set for the server under test");

    test("threads returns the affidavit-threads.json envelope", async ({ playwright, baseURL }) => {
        const context = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: { "x-receipt-intake-secret": SECRET },
        });
        const response = await context.get(THREADS_PATH);
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty("threads");
        expect(typeof body.threads).toBe("object");
        await context.dispose();
    });

    test("a fingerprint that isn't ours is ignored, never an error the forwarder retries forever", async ({ playwright, baseURL }) => {
        const context = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: { "x-receipt-intake-secret": SECRET },
        });
        const response = await context.post(ANSWERS_PATH, {
            data: { fingerprint: "2026-08-16_LOWES_123.45_CJ", signed: true },
        });
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, ignored: true });
        await context.dispose();
    });

    test("a signed answer for an unknown bank line is ignored, not a 500", async ({ playwright, baseURL }) => {
        const context = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: { "x-receipt-intake-secret": SECRET },
        });
        const response = await context.post(ANSWERS_PATH, {
            data: { fingerprint: "pb-no-such-bank-line", signed: true },
        });
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, ignored: true, reason: "unknown-target" });
        await context.dispose();
    });
});
