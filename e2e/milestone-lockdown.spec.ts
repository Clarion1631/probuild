import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Milestone lockdown (Aug 2026, after the Mesplay INV-00171 drift).
 *
 * Once the client can see the money (estimate sent, or an invoice exists), the
 * EstimateEditor's payment-schedule section must be read-only until the user
 * deliberately unlocks it via the confirm dialog. Draft estimates must NOT be
 * locked — the pre-send workflow is unchanged. See docs/MILESTONE-EDITING.md.
 *
 * Runs against the throwaway CI Postgres (data.setup.ts guards prod).
 */

const PFX = "ml-e2e";
const prisma = new PrismaClient();

const IDS = {
    client: `${PFX}-client`,
    project: `${PFX}-project`,
    sentEstimate: `${PFX}-est-sent`,
    draftEstimate: `${PFX}-est-draft`,
    sentDeposit: `${PFX}-eps-sent-dep`,
    sentFinal: `${PFX}-eps-sent-fin`,
    draftDeposit: `${PFX}-eps-draft-dep`,
    viewedEstimate: `${PFX}-est-viewed`,
    viewedDeposit: `${PFX}-eps-viewed-dep`,
};

test.describe.serial("Milestone lockdown on client-visible estimates", () => {
    test.beforeAll(async () => {
        await prisma.client.upsert({
            where: { id: IDS.client },
            update: {},
            create: { id: IDS.client, name: "ML Drill Client", initials: "ML" },
        });
        await prisma.project.upsert({
            where: { id: IDS.project },
            update: {},
            create: { id: IDS.project, name: "ML Drill Project", clientId: IDS.client },
        });
        await prisma.estimate.upsert({
            where: { id: IDS.sentEstimate },
            update: { status: "Sent", sentAt: new Date() },
            create: {
                id: IDS.sentEstimate,
                title: "ML Sent Estimate",
                code: "EST-MLSENT",
                projectId: IDS.project,
                status: "Sent",
                sentAt: new Date(),
                taxExempt: true,
                totalAmount: 1000,
                balanceDue: 1000,
            },
        });
        await prisma.estimate.upsert({
            where: { id: IDS.draftEstimate },
            update: { status: "Draft", sentAt: null },
            create: {
                id: IDS.draftEstimate,
                title: "ML Draft Estimate",
                code: "EST-MLDRAFT",
                projectId: IDS.project,
                status: "Draft",
                taxExempt: true,
                totalAmount: 1000,
                balanceDue: 1000,
            },
        });
        await prisma.estimatePaymentSchedule.upsert({
            where: { id: IDS.sentDeposit },
            update: { amount: 600, status: "Pending" },
            create: { id: IDS.sentDeposit, estimateId: IDS.sentEstimate, name: "ML Deposit", amount: 600, status: "Pending", order: 1 },
        });
        await prisma.estimatePaymentSchedule.upsert({
            where: { id: IDS.sentFinal },
            update: { amount: 400, status: "Pending" },
            create: { id: IDS.sentFinal, estimateId: IDS.sentEstimate, name: "ML Final", amount: 400, status: "Pending", order: 2 },
        });
        // Status says Draft but the client has opened it — the marker must win over the label.
        await prisma.estimate.upsert({
            where: { id: IDS.viewedEstimate },
            update: { status: "Draft", sentAt: null, viewedAt: new Date() },
            create: {
                id: IDS.viewedEstimate,
                title: "ML Viewed Estimate",
                code: "EST-MLVIEWED",
                projectId: IDS.project,
                status: "Draft",
                viewedAt: new Date(),
                taxExempt: true,
                totalAmount: 1000,
                balanceDue: 1000,
            },
        });
        await prisma.estimatePaymentSchedule.upsert({
            where: { id: IDS.viewedDeposit },
            update: { amount: 1000, status: "Pending" },
            create: { id: IDS.viewedDeposit, estimateId: IDS.viewedEstimate, name: "ML Viewed Deposit", amount: 1000, status: "Pending", order: 1 },
        });
        await prisma.estimatePaymentSchedule.upsert({
            where: { id: IDS.draftDeposit },
            update: { amount: 1000, status: "Pending" },
            create: { id: IDS.draftDeposit, estimateId: IDS.draftEstimate, name: "ML Draft Deposit", amount: 1000, status: "Pending", order: 1 },
        });
    });

    test.afterAll(async () => {
        try {
            await prisma.estimatePaymentSchedule.deleteMany({ where: { id: { startsWith: PFX } } });
            await prisma.estimate.deleteMany({ where: { id: { startsWith: PFX } } });
            await prisma.project.deleteMany({ where: { id: { startsWith: PFX } } });
            await prisma.client.deleteMany({ where: { id: { startsWith: PFX } } });
        } finally {
            await prisma.$disconnect();
        }
    });

    test("sent estimate: schedule is locked, inputs disabled", async ({ page }) => {
        await page.goto(`/projects/${IDS.project}/estimates/${IDS.sentEstimate}`, { waitUntil: "networkidle" });

        await expect(page.getByTestId("unlock-milestones"), "lock button must show on a sent estimate").toBeVisible();

        // Every milestone row input is disabled while locked.
        const nameInputs = page.getByPlaceholder("e.g. Initial Deposit");
        await expect(nameInputs.first()).toBeDisabled();
        await expect(nameInputs.nth(1)).toBeDisabled();
        const pctInputs = page.getByPlaceholder("%");
        await expect(pctInputs.first()).toBeDisabled();

        // The add-milestone button is repurposed as a lock indicator.
        await expect(page.getByRole("button", { name: /Locked — unlock to edit/ }).first()).toBeVisible();
        await expect(page.getByRole("button", { name: "+ Add milestone" })).toHaveCount(0);
    });

    test("unlock confirm re-enables editing for the visit", async ({ page }) => {
        await page.goto(`/projects/${IDS.project}/estimates/${IDS.sentEstimate}`, { waitUntil: "networkidle" });

        page.on("dialog", d => d.accept());
        await page.getByTestId("unlock-milestones").click();

        await expect(page.getByTestId("milestones-unlocked")).toBeVisible();
        await expect(page.getByPlaceholder("e.g. Initial Deposit").first()).toBeEnabled();
        await expect(page.getByRole("button", { name: "+ Add milestone" })).toBeVisible();
    });

    test("dismissing the unlock confirm keeps the lock", async ({ page }) => {
        await page.goto(`/projects/${IDS.project}/estimates/${IDS.sentEstimate}`, { waitUntil: "networkidle" });

        page.on("dialog", d => d.dismiss());
        await page.getByTestId("unlock-milestones").click();

        await expect(page.getByTestId("unlock-milestones")).toBeVisible();
        await expect(page.getByPlaceholder("e.g. Initial Deposit").first()).toBeDisabled();
    });

    test("status Draft but client has viewed it: still locked", async ({ page }) => {
        await page.goto(`/projects/${IDS.project}/estimates/${IDS.viewedEstimate}`, { waitUntil: "networkidle" });

        await expect(page.getByTestId("unlock-milestones"), "viewedAt must lock even with a Draft status").toBeVisible();
        await expect(page.getByPlaceholder("e.g. Initial Deposit").first()).toBeDisabled();
    });

    test("draft estimate: never locked, editing works as before", async ({ page }) => {
        await page.goto(`/projects/${IDS.project}/estimates/${IDS.draftEstimate}`, { waitUntil: "networkidle" });

        await expect(page.getByTestId("unlock-milestones")).toHaveCount(0);
        await expect(page.getByTestId("milestones-unlocked")).toHaveCount(0);
        await expect(page.getByPlaceholder("e.g. Initial Deposit").first()).toBeEnabled();
        await expect(page.getByRole("button", { name: "+ Add milestone" })).toBeVisible();
    });
});
