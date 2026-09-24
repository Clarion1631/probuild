import { test, expect } from "@playwright/test";

// Signed out, like e2e/receipt-intake.spec.ts:127 and the picker spec's own
// signed-out case (its step 9 case 4). Google OAuth itself is out of reach
// in CI, so this blocks accounts.google.com and reads the cookie next-auth
// writes right before it would redirect there -- that cookie is where the
// callbackUrl this PR fixes actually lands.
test.use({ storageState: { cookies: [], origins: [] } });

test("a signed-out visit to a deep link returns there after sign-in", async ({ page, baseURL }) => {
    const deepLink = "/projects?tab=active";

    await page.goto(deepLink, { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);

    const loginUrl = new URL(page.url());
    expect(loginUrl.searchParams.get("callbackUrl")).toBe(deepLink);

    await page.route("https://accounts.google.com/**", (route) => route.abort());
    await page.getByText("Continue with Google").click();

    await expect
        .poll(async () => {
            const cookies = await page.context().cookies();
            const value = cookies.find((c) => c.name === "next-auth.callback-url")?.value ?? null;
            // next-auth writes this cookie through cookie.serialize, which
            // percent-encodes the value -- decode it before comparing.
            return value === null ? null : decodeURIComponent(value);
        })
        .toBe(`${baseURL}${deepLink}`);
});

test("a signed-out visit with no callbackUrl still lands on the default page after sign-in", async ({
    page,
    baseURL,
}) => {
    await page.goto("/login");

    await page.route("https://accounts.google.com/**", (route) => route.abort());
    await page.getByText("Continue with Google").click();

    await expect
        .poll(async () => {
            const cookies = await page.context().cookies();
            const value = cookies.find((c) => c.name === "next-auth.callback-url")?.value ?? null;
            // next-auth writes this cookie through cookie.serialize, which
            // percent-encodes the value -- decode it before comparing.
            return value === null ? null : decodeURIComponent(value);
        })
        .toBe(`${baseURL}/`);
});
