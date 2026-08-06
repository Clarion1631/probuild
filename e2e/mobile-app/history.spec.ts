import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    FIELD_CREW_EMAIL,
    FIELD_CREW_PIN,
    MANAGER_EMAIL,
    MANAGER_PIN,
    PROJECT_ID,
    PROJECT_NAME,
    loginWithPin,
    runId,
} from "./helpers";

// (tabs)/history.tsx. Reality differs from a naive "crew can't edit" reading: tapping any
// entry (crew's own or, for a manager, one they can see) opens the same edit modal for
// EITHER role — PATCH /api/time-entries/[id] allows the owner OR a manager/admin
// (src/app/api/time-entries/[id]/route.ts: `if (!isOwner && !isPrivileged) return 403`).
// The only role-gated affordance inside that modal is "Delete entry" (client-checked via
// isManager(), and DELETE is server-gated the same way). The screen is also always scoped
// to the CALLER's own entries client-side (`all.filter(e => e.userId === user.id)` in
// fetchHistory) regardless of role — a manager does NOT see crew's entries here, unlike the
// separate Manager Dashboard. So the manager case below seeds its OWN time entry rather
// than reusing the field-crew fixture entry.

const prisma = new PrismaClient();

test.describe.serial("Time history", () => {
    const id = runId();
    const managerEntryId = `e2e-mweb-hist-${id}`;

    test.afterAll(async () => {
        await prisma.timeEntry.deleteMany({ where: { id: managerEntryId } });
        await prisma.$disconnect();
    });

    test("field crew can open the seeded entry but has no delete affordance", async ({ page }) => {
        await loginWithPin(page, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        await page.getByText("History", { exact: true }).click();

        await expect(page.getByText(PROJECT_NAME, { exact: true }).first()).toBeVisible({
            timeout: 15000,
        });
        await page.getByText(PROJECT_NAME, { exact: true }).first().click();

        await expect(page.getByText("Edit time entry")).toBeVisible({ timeout: 10000 });
        await expect(page.getByText("Delete entry")).toHaveCount(0);
        await page.getByText("Cancel", { exact: true }).click();
    });

    test("manager sees the delete affordance on their own entry", async ({ page }) => {
        const manager = await prisma.user.findUniqueOrThrow({
            where: { email: MANAGER_EMAIL },
            select: { id: true },
        });
        const start = new Date();
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        await prisma.timeEntry.create({
            data: {
                id: managerEntryId,
                userId: manager.id,
                projectId: PROJECT_ID,
                startTime: start,
                endTime: end,
                durationHours: 1,
            },
        });

        await loginWithPin(page, MANAGER_EMAIL, MANAGER_PIN);
        await page.getByText("History", { exact: true }).click();

        await expect(page.getByText(PROJECT_NAME, { exact: true }).first()).toBeVisible({
            timeout: 15000,
        });
        await page.getByText(PROJECT_NAME, { exact: true }).first().click();

        await expect(page.getByText("Edit time entry")).toBeVisible({ timeout: 10000 });
        await expect(page.getByText("Delete entry")).toBeVisible();
        await page.getByText("Cancel", { exact: true }).click();
    });
});
