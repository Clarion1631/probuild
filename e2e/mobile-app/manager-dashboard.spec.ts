import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { MANAGER_EMAIL, MANAGER_PIN, PROJECT_ID, PROJECT_NAME, loginWithPin, runId } from "./helpers";

// components/ManagerDashboard.tsx's "Field compliance" section, computed by
// /api/manager/dashboard (src/app/api/manager/dashboard/route.ts, ~line 279 on): a project
// is "eligible" for the day only once it has a TimeEntry whose startTime falls in that day's
// window; then noDailyLog = no DailyLog dated that day, noPhotos = a same-day DailyLog
// exists but has zero DailyLogPhoto rows (noPhotos never fires alongside noDailyLog). The
// seeded fixtures' daily log + entry are both dated "yesterday" (data.setup.ts), so today
// starts with neither flag showing until this spec stages today's rows itself.

const prisma = new PrismaClient();

test.describe.serial("Manager dashboard — field compliance", () => {
    const id = runId();
    const entryId = `e2e-mweb-compliance-entry-${id}`;
    const dailyLogId = `e2e-mweb-compliance-log-${id}`;

    test.beforeAll(async () => {
        const manager = await prisma.user.findUniqueOrThrow({
            where: { email: MANAGER_EMAIL },
            select: { id: true },
        });
        const now = new Date();
        // Makes the project "eligible" for today's compliance computation — no other
        // fields (costCodeId/estimateItemId) matter for this flag.
        await prisma.timeEntry.create({
            data: {
                id: entryId,
                userId: manager.id,
                projectId: PROJECT_ID,
                startTime: now,
                endTime: new Date(now.getTime() + 60 * 60 * 1000),
                durationHours: 1,
            },
        });
    });

    test.afterAll(async () => {
        await prisma.dailyLog.deleteMany({ where: { id: dailyLogId } }); // cascades any photos
        await prisma.timeEntry.deleteMany({ where: { id: entryId } });
        await prisma.$disconnect();
    });

    test("flags no daily log today, then flips to no photos once one is logged", async ({ page }) => {
        await loginWithPin(page, MANAGER_EMAIL, MANAGER_PIN);
        await page.getByText("Manager", { exact: true }).click();
        await expect(page.getByText("MANAGER DASHBOARD", { exact: true })).toBeVisible({ timeout: 15000 });

        await expect(page.getByText("Field compliance")).toBeVisible({ timeout: 20000 });
        // .first() — the project's own name also renders again in the "Active jobs" card
        // further down (this fixture's staged TimeEntry makes it active today too); the
        // compliance card renders first in the JSX, so .first() is the compliance row.
        await expect(page.getByText(PROJECT_NAME, { exact: true }).first()).toBeVisible();
        await expect(page.getByText("⚠ No daily log today")).toBeVisible();
        await expect(page.getByText("⚠ Daily log has no photos")).toHaveCount(0);

        const manager = await prisma.user.findUniqueOrThrow({
            where: { email: MANAGER_EMAIL },
            select: { id: true },
        });
        await prisma.dailyLog.create({
            data: {
                id: dailyLogId,
                projectId: PROJECT_ID,
                createdById: manager.id,
                date: new Date(),
                workPerformed: "E2E compliance check",
                nextSteps: "n/a",
            },
        });

        // Force a fresh fetch — the dashboard's own 30s poll would eventually pick this up,
        // but a reload + re-navigate is deterministic for a test.
        await page.reload();
        await page.getByText("Manager", { exact: true }).click();
        await expect(page.getByText("Field compliance")).toBeVisible({ timeout: 20000 });

        await expect(page.getByText("⚠ Daily log has no photos")).toBeVisible({ timeout: 15000 });
        await expect(page.getByText("⚠ No daily log today")).toHaveCount(0);
    });
});
