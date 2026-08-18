import { expect, test } from "@playwright/test";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";

const PREFIX = "e2e-project-delete-race";
const ids = {
    client: `${PREFIX}-client`,
    project: `${PREFIX}-project`,
    invoice: `${PREFIX}-invoice`,
    schedule: `${PREFIX}-schedule`,
    activity: `${PREFIX}-activity`,
};

async function cleanFixture() {
    await prisma.paymentSchedule.updateMany({
        where: { id: ids.schedule },
        data: {
            qbCreateRequestId: null,
            qbCreateFingerprint: null,
            qbCreateStartedAt: null,
        },
    });
    await prisma.paymentSchedule.deleteMany({ where: { id: ids.schedule } });
    await prisma.invoice.deleteMany({ where: { id: ids.invoice } });
    await prisma.activityLog.deleteMany({ where: { id: ids.activity } });
    await prisma.project.deleteMany({ where: { id: ids.project } });
    await prisma.client.deleteMany({ where: { id: ids.client } });
}

async function seedFixture() {
    await cleanFixture();
    await prisma.client.create({
        data: { id: ids.client, name: "Project Delete Race", initials: "PD" },
    });
    await prisma.project.create({
        data: { id: ids.project, name: "Project Delete Race", clientId: ids.client },
    });
}

async function waitUntilDeleteIsBlockedBy(writerPid: number) {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT EXISTS (
                SELECT 1
                FROM pg_stat_activity activity
                WHERE ${writerPid} = ANY(pg_blocking_pids(activity.pid))
            ) AS blocked
        `;
        if (row?.blocked) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("deleteProjects never waited on the writer's Project FK lock");
}

async function startDeleteFromProjectsPage(page: import("@playwright/test").Page) {
    await page.goto("/projects");
    const projectRow = page.getByRole("row").filter({ hasText: "Project Delete Race" });
    await expect(projectRow).toHaveCount(1);
    await projectRow.getByRole("checkbox").check();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
}

async function runChildInsertRace(
    page: import("@playwright/test").Page,
    insertEvidence: (tx: Prisma.TransactionClient) => Promise<void>,
) {
    let releaseWriter!: () => void;
    const writerRelease = new Promise<void>(resolve => { releaseWriter = resolve; });
    let reportWriterPid!: (pid: number) => void;
    const writerPid = new Promise<number>(resolve => { reportWriterPid = resolve; });

    const writer = prisma.$transaction(async tx => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        await insertEvidence(tx);
        // The child FK check now holds KEY SHARE on Project until commit. A
        // delete taking Project FOR UPDATE must wait, then see this child in its
        // fresh READ COMMITTED evidence query.
        reportWriterPid(backend.pid);
        await writerRelease;
    }, { timeout: 15_000 });

    const pid = await writerPid;
    try {
        await startDeleteFromProjectsPage(page);
        await waitUntilDeleteIsBlockedBy(pid);
    } finally {
        releaseWriter();
    }
    await writer;
}

test.describe.serial("project hard-delete shell fence", () => {
    test.beforeEach(seedFixture);
    test.afterEach(cleanFixture);

    test("preserves an Invoice and ambiguous QBO checkpoint inserted before the Project lock", async ({ page }) => {
        await runChildInsertRace(page, async tx => {
            await tx.invoice.create({
                data: {
                    id: ids.invoice,
                    code: "INV-PROJECT-DELETE-RACE",
                    projectId: ids.project,
                    clientId: ids.client,
                    status: "Draft",
                },
            });
            await tx.paymentSchedule.create({
                data: {
                    id: ids.schedule,
                    invoiceId: ids.invoice,
                    name: "Race milestone",
                    amount: 100,
                    status: "Pending",
                    qbCreateRequestId: "project-delete-race-request",
                    qbCreateFingerprint: "project-delete-race-fingerprint",
                    qbCreateStartedAt: new Date("2026-08-17T12:00:00.000Z"),
                },
            });
        });

        await expect(page.getByText("Project financial or legal history must be archived, not hard-deleted"))
            .toBeVisible();
        expect(await prisma.project.findUnique({ where: { id: ids.project } })).not.toBeNull();
        expect((await prisma.paymentSchedule.findUnique({ where: { id: ids.schedule } }))?.qbCreateRequestId)
            .toBe("project-delete-race-request");
    });

    test("preserves a newly committed audit row before the shell evidence read", async ({ page }) => {
        await runChildInsertRace(page, async tx => {
            await tx.activityLog.create({
                data: {
                    id: ids.activity,
                    projectId: ids.project,
                    actorType: "SYSTEM",
                    actorName: "Project-delete race",
                    action: "provider_attempt",
                    entityType: "project",
                    entityId: ids.project,
                },
            });
        });

        await expect(page.getByText("Project financial or legal history must be archived, not hard-deleted"))
            .toBeVisible();
        expect(await prisma.project.findUnique({ where: { id: ids.project } })).not.toBeNull();
        expect(await prisma.activityLog.findUnique({ where: { id: ids.activity } })).not.toBeNull();
    });
});
