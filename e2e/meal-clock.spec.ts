import { test, expect } from "@playwright/test";

test("browser clock-out sends explicit meal/rest answers and leaves uncertain meal unanswered", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 47.6, longitude: -122.3 });
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/projects?assigned=true", route => route.fulfill({ json: [] }));
    await page.route("**/api/time-entries**", async route => {
        if (route.request().method() === "PUT") {
            bodies.push(route.request().postDataJSON());
            await route.fulfill({ json: { id: "meal-ui-test" } });
        } else {
            await route.fulfill({ json: [{ id: "meal-ui-test", endTime: null }] });
        }
    });
    await page.goto("/time-clock");
    await page.getByLabel("Meal break today").selectOption("worked");
    await page.getByLabel("Paid rest breaks today").selectOption("missed");
    await page.getByRole("button", { name: "Clock Out", exact: true }).click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ mealSkipped: true, restBreaksMissed: true });
    await page.reload();
    await page.getByRole("button", { name: "Clock Out", exact: true }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).not.toHaveProperty("mealSkipped");
    await page.reload();
    await page.getByLabel("Meal break today").selectOption("taken");
    await page.getByLabel("Paid rest breaks today").selectOption("taken");
    await page.getByRole("button", { name: "Clock Out", exact: true }).click();
    await expect.poll(() => bodies.length).toBe(3);
    expect(bodies[2]).toMatchObject({ mealSkipped: false, restBreaksMissed: false });
});
