import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Layout guard for the estimate header/toolbar (issue #399).
 *
 * The header in src/app/projects/[id]/estimates/[estimateId]/EstimateEditor.tsx carries three
 * clusters — back/code/status on the left, the Builder / Costing & Expenses tabs in the middle,
 * and the view toggle + ⋮ menu + Send/Save on the right. The tabs are absolutely centred, which
 * is fine on a wide screen and paints straight over the other two clusters on a narrow one. This
 * spec pins the two things that must hold at every width: the header never overflows its own
 * box horizontally, and every action stays reachable — visible in the bar or inside the ⋮ menu.
 *
 * It asserts layout only, so it makes no estimate edits and needs no teardown beyond its fixtures.
 */

const IDS = {
    client: "ehr-e2e-client",
    project: "ehr-e2e-project",
    estimate: "ehr-e2e-estimate",
    item: "ehr-e2e-item-1",
};

const prisma = new PrismaClient();

test.describe("Estimate header: responsive action bar", () => {
    test.beforeAll(async () => {
        await prisma.client.upsert({
            where: { id: IDS.client },
            update: {},
            create: { id: IDS.client, name: "Header Responsive Drill Client", initials: "HR" },
        });
        await prisma.project.upsert({
            where: { id: IDS.project },
            update: {},
            create: { id: IDS.project, name: "Header Responsive Drill Project", clientId: IDS.client },
        });
        await prisma.estimate.upsert({
            where: { id: IDS.estimate },
            update: { title: "Header Responsive Drill" },
            create: {
                id: IDS.estimate,
                title: "Header Responsive Drill",
                code: "EST-EHRTEST",
                projectId: IDS.project,
                status: "Draft",
                totalAmount: 100,
                balanceDue: 100,
                itemsRevision: 0,
            },
        });
        await prisma.estimateItem.upsert({
            where: { id: IDS.item },
            update: {},
            create: {
                id: IDS.item,
                estimateId: IDS.estimate,
                name: "Header Responsive Drill Item",
                type: "Material",
                quantity: 1,
                unitCost: 100,
                total: 100,
                order: 0,
            },
        });
    });

    test.afterAll(async () => {
        try {
            await prisma.estimateItem.deleteMany({ where: { estimateId: IDS.estimate } });
            await prisma.estimate.deleteMany({ where: { id: IDS.estimate } });
            await prisma.project.deleteMany({ where: { id: IDS.project } });
            await prisma.client.deleteMany({ where: { id: IDS.client } });
        } finally {
            await prisma.$disconnect();
        }
    });

    for (const viewport of [
        { name: "desktop", width: 1440, height: 900 },
        { name: "narrow phone", width: 375, height: 812 },
    ]) {
        test(`primary CTAs and the ⋮ menu stay reachable at ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.goto(`/projects/${IDS.project}/estimates/${IDS.estimate}`, { waitUntil: "networkidle" });

            const save = page.getByRole("button", { name: "Save", exact: true });
            const send = page.getByRole("button", { name: "Send", exact: true });
            const more = page.locator('button[title="More actions"]');

            await expect(save).toBeVisible();
            await expect(send).toBeVisible();
            await expect(more).toBeVisible();

            // The sticky header is the Save button's nearest sticky ancestor. It must not
            // overflow itself: at 375px the absolutely-centred tabs used to push it wide.
            const header = page.locator("div.sticky.top-0").first();
            const overflow = await header.evaluate(
                (el) => el.scrollWidth - el.clientWidth,
            );
            expect(overflow).toBeLessThanOrEqual(1); // 1px of sub-pixel rounding slack

            // Both tabs stay reachable — on a narrow screen they drop to their own row rather
            // than painting over the clusters beside them.
            await expect(page.getByRole("button", { name: "Builder", exact: true })).toBeVisible();
            await expect(page.getByRole("button", { name: "Costing & Expenses", exact: true })).toBeVisible();

            // Every secondary action lives behind the single ⋮ button.
            await more.click();
            await expect(page.getByRole("button", { name: "Duplicate Estimate" })).toBeVisible();
            await expect(page.getByRole("button", { name: "Preview / Download PDF" })).toBeVisible();
            await expect(page.getByRole("button", { name: "Save as Template" })).toBeVisible();
            await expect(page.getByRole("button", { name: "Delete Estimate" })).toBeVisible();

            // The Client/Internal toggle is hidden from the bar below `sm` — when it is, the
            // menu must carry it instead, so the view mode is never stranded.
            const toggleInBar = page.getByRole("button", { name: "Internal", exact: true });
            const toggleInMenu = page.getByRole("button", { name: /Switch to (Client|Internal) view/ });
            if (viewport.width < 640) {
                await expect(toggleInMenu).toBeVisible();
            } else {
                await expect(toggleInBar).toBeVisible();
            }
        });
    }
});
