import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const run = `co-editor-revision-${process.pid}-${Date.now()}`;

const IDS = {
    client: `${run}-client`,
    project: `${run}-project`,
    estimate: `${run}-estimate`,
    invoice: `${run}-invoice`,
    sendCo: `${run}-send-co`,
    countersignCo: `${run}-countersign-co`,
    conflictCo: `${run}-conflict-co`,
    manualConflictCo: `${run}-manual-conflict-co`,
} as const;

const SEND_TITLE = "Revision adoption after send";
const COUNTERSIGN_TITLE = "Revision adoption after countersign";
const CONFLICT_TITLE = "Revision conflict original";
const EXTERNAL_TITLE = "Revision conflict server copy";
const MANUAL_CONFLICT_TITLE = "Manual approval conflict original";
const MANUAL_EXTERNAL_TITLE = "Manual approval conflict server copy";

async function readCo(id: string) {
    return prisma.changeOrder.findUniqueOrThrow({
        where: { id },
        select: { status: true, revision: true, title: true, companySignedBy: true },
    });
}

async function approvalJobsAreTerminal(changeOrderId: string) {
    const jobs = await prisma.changeOrderAutomationJob.findMany({
        where: { changeOrderId },
        select: { status: true },
    });
    return jobs.length > 0 && jobs.every(job => ["SUCCEEDED", "SKIPPED", "CANCELED", "NEEDS_ATTENTION"].includes(job.status));
}

test.describe.serial("Change-order editor revision adoption (real DB + browser)", () => {
    test.beforeAll(async () => {
        await prisma.client.create({
            data: {
                id: IDS.client,
                name: "Revision Adoption Client",
                initials: "RA",
                email: `${run}@example.test`,
            },
        });
        await prisma.project.create({
            data: {
                id: IDS.project,
                name: "Revision Adoption Project",
                clientId: IDS.client,
                status: "In Progress",
            },
        });
        await prisma.estimate.create({
            data: {
                id: IDS.estimate,
                code: `${run}-EST`,
                title: "Revision Adoption Estimate",
                projectId: IDS.project,
                status: "Approved",
                totalAmount: 300,
                balanceDue: 300,
                taxExempt: true,
            },
        });
        // Fixed-price approval automation bills onto an existing project invoice.
        // Keep this browser fixture faithful to the signed-estimate lifecycle so
        // its durable approval graph can reach terminal states before cleanup.
        await prisma.invoice.create({
            data: {
                id: IDS.invoice,
                code: `${run}-INV`,
                projectId: IDS.project,
                clientId: IDS.client,
                estimateId: IDS.estimate,
                status: "Draft",
            },
        });

        await prisma.changeOrder.create({
            data: {
                id: IDS.sendCo,
                code: `${run}-SEND`,
                title: SEND_TITLE,
                projectId: IDS.project,
                estimateId: IDS.estimate,
                status: "Draft",
                pricingType: "FIXED",
                totalAmount: 100,
                balanceDue: 100,
                items: { create: { name: "Send flow item", type: "Material", quantity: 1, unitCost: 100, total: 100 } },
            },
        });
        await prisma.changeOrder.create({
            data: {
                id: IDS.countersignCo,
                code: `${run}-COUNTERSIGN`,
                title: COUNTERSIGN_TITLE,
                projectId: IDS.project,
                estimateId: IDS.estimate,
                status: "Sent",
                sentAt: new Date(),
                pricingType: "FIXED",
                totalAmount: 100,
                balanceDue: 100,
                items: { create: { name: "Countersign flow item", type: "Labor", quantity: 1, unitCost: 100, total: 100 } },
            },
        });
        await prisma.changeOrder.create({
            data: {
                id: IDS.conflictCo,
                code: `${run}-CONFLICT`,
                title: CONFLICT_TITLE,
                projectId: IDS.project,
                estimateId: IDS.estimate,
                status: "Draft",
                pricingType: "FIXED",
                totalAmount: 100,
                balanceDue: 100,
                items: { create: { name: "Conflict flow item", type: "Other", quantity: 1, unitCost: 100, total: 100 } },
            },
        });
        await prisma.changeOrder.create({
            data: {
                id: IDS.manualConflictCo,
                code: `${run}-MANUAL-CONFLICT`,
                title: MANUAL_CONFLICT_TITLE,
                projectId: IDS.project,
                estimateId: IDS.estimate,
                status: "Sent",
                sentAt: new Date(),
                pricingType: "FIXED",
                totalAmount: 100,
                balanceDue: 100,
                companySignedBy: "Existing Company Signer",
                companySignedAt: new Date(),
                items: { create: { name: "Manual conflict item", type: "Labor", quantity: 1, unitCost: 100, total: 100 } },
            },
        });
    });

    test.afterAll(async () => {
        try {
            await prisma.notification.deleteMany({ where: { projectId: IDS.project } });
            await prisma.changeOrderAutomationJob.deleteMany({ where: { changeOrderId: { in: [IDS.sendCo, IDS.countersignCo, IDS.conflictCo, IDS.manualConflictCo] } } });
            await prisma.changeOrder.deleteMany({ where: { id: { in: [IDS.sendCo, IDS.countersignCo, IDS.conflictCo, IDS.manualConflictCo] } } });
            await prisma.invoice.deleteMany({ where: { id: IDS.invoice } });
            await prisma.estimate.deleteMany({ where: { id: IDS.estimate } });
            await prisma.project.deleteMany({ where: { id: IDS.project } });
            await prisma.client.deleteMany({ where: { id: IDS.client } });
        } finally {
            await prisma.$disconnect();
        }
    });

    test("same tab adopts revisions returned by send and countersign", async ({ page }) => {
        test.setTimeout(120_000);

        // Save -> send -> save -> manual approve. The send owns the second
        // revision bump, so the open editor must adopt the revision returned by
        // that action before either subsequent guarded operation.
        await page.goto(`/projects/${IDS.project}/change-orders/${IDS.sendCo}`, { waitUntil: "networkidle" });
        page.once("dialog", (dialog) => dialog.accept());
        await page.getByRole("button", { name: "Send for Approval" }).click();
        await expect.poll(async () => JSON.stringify(await readCo(IDS.sendCo))).toContain('"status":"Sent","revision":2');

        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(async () => (await readCo(IDS.sendCo)).revision).toBe(3);

        await page.getByRole("button", { name: "Details & Signatures" }).click();
        await page.getByRole("button", { name: "Mark as Approved (manual)" }).click();
        await page.getByRole("button", { name: "Confirm approval" }).click();
        await expect.poll(async () => (await readCo(IDS.sendCo)).status).toBe("Approved");

        // Countersign -> manual approve. Wait for the refreshed server props to
        // display the signature so the approval follows the scope-locked path;
        // its CAS token must still come from the countersign action result.
        await page.goto(`/projects/${IDS.project}/change-orders/${IDS.countersignCo}`, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Details & Signatures" }).click();
        await page.getByRole("button", { name: "Sign Now →" }).click();
        await page.getByPlaceholder("Your name").fill("Revision Counter Signer");
        await page.getByRole("button", { name: "Sign", exact: true }).click();
        await expect.poll(async () => (await readCo(IDS.countersignCo)).revision).toBe(1);
        await expect(page.getByText("Revision Counter Signer", { exact: true })).toBeVisible();

        await page.getByRole("button", { name: "Mark as Approved (manual)" }).click();
        await page.getByRole("button", { name: "Confirm approval" }).click();
        await expect.poll(async () => (await readCo(IDS.countersignCo)).status).toBe("Approved");
        // Next's after() drain can finish after the action response. Keep fixture
        // cleanup from deleting durable rows out from under an active worker.
        await expect.poll(async () => approvalJobsAreTerminal(IDS.sendCo), { timeout: 30_000 }).toBe(true);
        await expect.poll(async () => approvalJobsAreTerminal(IDS.countersignCo), { timeout: 30_000 }).toBe(true);
    });

    test("Save conflict hard-reloads every controlled field from the server copy", async ({ page }) => {
        // A genuinely stale form must be replaced wholesale. router.refresh()
        // alone updates props but preserves the controlled title/revision state,
        // so the old implementation left this input on the stale local value.
        await page.goto(`/projects/${IDS.project}/change-orders/${IDS.conflictCo}`, { waitUntil: "networkidle" });
        const title = page.getByPlaceholder("Change Order Title");
        await expect(title).toHaveValue(CONFLICT_TITLE);
        await prisma.changeOrder.update({
            where: { id: IDS.conflictCo },
            data: { title: EXTERNAL_TITLE, revision: { increment: 1 } },
        });
        await title.fill("Stale local copy");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(title).toHaveValue(EXTERNAL_TITLE, { timeout: 15_000 });
    });

    test("scope-locked Manual Approve conflict hard-reloads the full server copy", async ({ page }) => {
        // The company signature locks scope, so handleManualApprove intentionally
        // skips Save and submits this tab's page-load revision directly to the
        // manual-approval action. A concurrent writer then makes that token stale.
        await page.goto(`/projects/${IDS.project}/change-orders/${IDS.manualConflictCo}`, { waitUntil: "networkidle" });
        const title = page.getByPlaceholder("Change Order Title");
        await expect(title).toHaveValue(MANUAL_CONFLICT_TITLE);
        await expect(title).toBeDisabled();

        await prisma.changeOrder.update({
            where: { id: IDS.manualConflictCo },
            data: { title: MANUAL_EXTERNAL_TITLE, revision: { increment: 1 } },
        });

        await page.getByRole("button", { name: "Details & Signatures" }).click();
        await page.getByRole("button", { name: "Mark as Approved (manual)" }).click();
        await page.getByRole("button", { name: "Confirm approval" }).click();

        await expect(title).toHaveValue(MANUAL_EXTERNAL_TITLE, { timeout: 15_000 });
        await expect.poll(async () => (await readCo(IDS.manualConflictCo)).status).toBe("Sent");
    });
});
