import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    FIELD_CREW_EMAIL,
    FIELD_CREW_PIN,
    MOBILE_TASK_DRYW_ID,
    PROJECT_NAME,
    loginWithPin,
} from "./helpers";

// (tabs)/schedule.tsx ("Today" tab) + task/[id].tsx comment composer.

const prisma = new PrismaClient();

test.describe.serial("Schedule + task detail", () => {
    const createdCommentIds: string[] = [];

    test.afterAll(async () => {
        if (createdCommentIds.length > 0) {
            await prisma.taskComment.deleteMany({ where: { id: { in: createdCommentIds } } });
        }
        await prisma.$disconnect();
    });

    test("today's schedule lists the seeded drywall task under its project", async ({ page }) => {
        await loginWithPin(page, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        await page.getByText("Today", { exact: true }).click();

        await expect(page.getByText("Hang drywall in hall bath")).toBeVisible({ timeout: 15000 });
        // exact: true — the field-crew fixture has a closed historical entry, so the Time
        // Clock tab (visited first by loginWithPin) renders a "Resume Last Task" button whose
        // detail line is "<project> — <phase> · <when>". React Navigation's bottom-tabs keeps
        // that screen mounted (just hidden) after switching tabs, so a non-exact match on the
        // bare project name also matches that leftover combined string (2 elements).
        await expect(page.getByText(PROJECT_NAME, { exact: true })).toBeVisible();
    });

    test("opening the task and adding a comment renders it in the thread", async ({ page }) => {
        await loginWithPin(page, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        await page.getByText("Today", { exact: true }).click();
        await expect(page.getByText("Hang drywall in hall bath")).toBeVisible({ timeout: 15000 });
        await page.getByText("Hang drywall in hall bath").click();

        const composer = page.getByPlaceholder("What's happening on site?");
        await expect(composer).toBeVisible({ timeout: 15000 });

        const commentText = `E2E schedule comment ${Date.now()}`;
        await composer.fill(commentText);
        await page.getByText("Send", { exact: true }).click();

        // The composer is a <textarea>, and Playwright's getByText also matches an
        // input/textarea's current value — so a bare getByText(commentText) is already
        // satisfied by the freshly-typed composer text, before submit() even resolves
        // (false positive: it'd pass even if the send silently failed). submit() only
        // clears the composer (setText("")) after its POST succeeds, so wait for that
        // first — from then on the only element left matching commentText is the real
        // comment row rendered from the server response.
        await expect(composer).toHaveValue("");
        await expect(page.getByText(commentText)).toBeVisible({ timeout: 15000 });

        const comment = await prisma.taskComment.findFirst({
            where: { taskId: MOBILE_TASK_DRYW_ID, text: commentText },
            orderBy: { createdAt: "desc" },
        });
        expect(comment).not.toBeNull();
        createdCommentIds.push(comment!.id);
    });
});
