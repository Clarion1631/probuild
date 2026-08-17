import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient, type Prisma } from "@prisma/client";

import { billChangeOrderCore, sendChangeOrderToClientCore } from "../src/lib/billing-core";
import { approveChangeOrderCore, updateChangeOrderCore } from "../src/lib/change-order-core";
import { approveChangeOrderWithSignature } from "../src/lib/change-order-approval";
import {
    canonicalCoTaxTerms,
    coTaxFingerprint,
    effectiveCoTaxInfo,
} from "../src/lib/co-tax";
import { buildChangeOrderSendPreviewPayload } from "../src/lib/change-order-send-preview";
import { verifyPreviewToken } from "../src/lib/mcp-preview-token";
import { generateChangeOrderPdf } from "../src/lib/pdf";
import { applyChangeOrderToSchedule, getChangeOrderOverlayRows } from "../src/lib/schedule-core";
import { POST as repairChangeOrder } from "../src/app/api/integrations/co-audit/route";

const prisma = new PrismaClient();
const run = `co-terms-${process.pid}-${Date.now()}`;
const ids = {
    client: `${run}-client`,
    project: `${run}-project`,
    estimate: `${run}-estimate`,
    invoice: `${run}-invoice`,
    staleDraft: `${run}-stale-draft`,
    sendConflict: `${run}-send-conflict`,
    mcpStaleDraft: `${run}-mcp-stale-draft`,
    mcpTaxCoreRace: `${run}-mcp-tax-race`,
    mcpRevisionCoreRace: `${run}-mcp-rev-race`,
    resendLifecycle: `${run}-resend-lifecycle`,
    customerFlow: `${run}-customer-flow`,
    legacySent: `${run}-legacy-sent`,
    legacyApproved: `${run}-legacy-approved`,
    scheduled: `${run}-scheduled`,
    zeroSchedule: `${run}-zero-schedule`,
    auditSent: `${run}-audit-sent`,
    manualHeader: `${run}-manual-header`,
    roleVisibility: `${run}-role-visibility`,
} as const;

const sentTerms = {
    taxExempt: false,
    taxRatePercent: 8.875,
    taxRateName: "Seattle exact rate",
};
const coreDependencies = {
    logActivity: async () => ({ id: `${run}-activity` }) as never,
    revalidatePath: () => undefined,
    buildClientPortalUrl: async (_clientId: string, _email: string, path: string) => `http://localhost:3000${path}`,
};

async function extractPdfText(buffer: Buffer): Promise<string> {
    await import("@napi-rs/canvas").catch(() => null);
    const pdfParseMod: any = await import("pdf-parse");
    const PDFParseCtor = pdfParseMod.PDFParse ?? pdfParseMod.default?.PDFParse;
    const workerMod: any = await import("pdf-parse/worker").catch(() => null);
    const workerData = workerMod?.getData?.();
    if (workerData && typeof PDFParseCtor.setWorker === "function") PDFParseCtor.setWorker(workerData);
    const parser = new PDFParseCtor({ data: buffer });
    try {
        return (await parser.getText())?.text ?? "";
    } finally {
        await parser.destroy?.();
    }
}

async function createFixedCo(
    id: string,
    overrides: Record<string, unknown> = {},
    withSchedule = false,
) {
    return prisma.changeOrder.create({
        data: {
            id,
            code: id.slice(-36),
            title: `Terms fixture ${id.slice(-10)}`,
            projectId: ids.project,
            estimateId: ids.estimate,
            status: "Draft",
            pricingType: "FIXED",
            totalAmount: 10,
            balanceDue: 10,
            items: {
                create: { name: "Exact terms work", type: "Labor", quantity: 1, unitCost: 10, total: 10 },
            },
            ...(withSchedule ? {
                paymentSchedules: {
                    create: [
                        { name: "First third", amount: 3.33, order: 0 },
                        { name: "Second third", amount: 3.33, order: 1 },
                        { name: "Final remainder", amount: 3.34, order: 2 },
                    ],
                },
            } : {}),
            ...overrides,
        } as never,
    });
}

async function readRevisionAndDisplayedFingerprint(id: string) {
    const co = await prisma.changeOrder.findUniqueOrThrow({
        where: { id },
        include: { estimate: { select: { taxExempt: true, taxRatePercent: true, taxRateName: true } } },
    });
    return {
        revision: co.revision,
        fingerprint: coTaxFingerprint(effectiveCoTaxInfo(co, co.estimate)),
    };
}

async function callMcpTool(
    request: APIRequestContext,
    id: number,
    name: string,
    args: Record<string, unknown>,
) {
    const secret = process.env.MCP_SECRET;
    if (!secret) throw new Error("MCP_SECRET is required for the disposable MCP route regression");
    const response = await request.post(`/api/mcp/mcp?key=${encodeURIComponent(secret)}`, {
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
        },
        data: {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
        },
    });
    expect(response.status()).toBe(200);
    const raw = await response.text();
    const dataLine = raw.split(/\r?\n/).find(line => line.startsWith("data:"));
    const envelope = raw.trimStart().startsWith("{")
        ? JSON.parse(raw)
        : JSON.parse(dataLine?.slice(5).trim() ?? "null");
    const text = envelope?.result?.content?.find((entry: { type?: string }) => entry.type === "text")?.text;
    if (typeof text !== "string") throw new Error(`MCP ${name} returned no JSON text result: ${raw}`);
    try {
        return JSON.parse(text) as Record<string, any>;
    } catch {
        throw new Error(`MCP ${name} returned non-JSON text: ${text}`);
    }
}

async function waitForBlockedChangeOrderCore(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
            SELECT COUNT(*)::int AS waiting
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND query LIKE '%FROM "ChangeOrder"%'
              AND query LIKE '%FOR UPDATE%'
        `;
        if (Number(row?.waiting ?? 0) > 0) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for the MCP send core to block on the ChangeOrder row lock");
}

async function callMcpConfirmAcrossLockedRace(
    request: APIRequestContext,
    rpcId: number,
    changeOrderId: string,
    confirmToken: string,
    mutateBeforeUnlock: (tx: Prisma.TransactionClient) => Promise<unknown>,
) {
    let lockReady!: () => void;
    let release!: () => void;
    const locked = new Promise<void>(resolve => { lockReady = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const blocker = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "ChangeOrder" WHERE id = ${changeOrderId} FOR UPDATE`;
        lockReady();
        await releaseGate;
        await mutateBeforeUnlock(tx);
    }, { timeout: 15_000 });

    await locked;
    const confirmation = callMcpTool(request, rpcId, "send_change_order", { changeOrderId, confirmToken });
    try {
        // This proves the route already read and verified the old token before
        // the concurrent mutation lands; the locked core is the waiting query.
        await waitForBlockedChangeOrderCore();
        release();
        await blocker;
        return await confirmation;
    } catch (error) {
        release();
        await blocker.catch(() => undefined);
        await confirmation.catch(() => undefined);
        throw error;
    }
}

async function currentMcpSendPayload(changeOrderId: string) {
    const co = await prisma.changeOrder.findUniqueOrThrow({
        where: { id: changeOrderId },
        select: {
            code: true, title: true, status: true, pricingType: true, markupPercent: true, totalAmount: true,
            revision: true, termsTaxExempt: true, termsTaxRateName: true, termsTaxRatePercent: true,
            paymentSchedules: { orderBy: { order: "asc" }, select: { id: true, name: true, amount: true, dueDate: true, order: true } },
            estimate: { select: { taxExempt: true, taxRatePercent: true, taxRateName: true } },
            project: { select: { client: { select: { email: true } } } },
        },
    });
    return buildChangeOrderSendPreviewPayload({
        changeOrderId,
        recipient: co.project.client.email ?? "",
        code: co.code,
        title: co.title,
        pricingType: co.pricingType,
        markupPercent: co.markupPercent,
        total: Number(co.totalAmount),
        schedules: co.paymentSchedules.map(row => [row.id, row.name, Number(row.amount), row.dueDate?.toISOString(), row.order]),
        status: co.status,
        revision: co.revision,
        taxTerms: canonicalCoTaxTerms(effectiveCoTaxInfo(co, co.estimate)),
    });
}

test.describe.serial("change-order sent terms are a stable guarded contract", () => {
    test.beforeAll(async () => {
        await prisma.client.create({
            data: { id: ids.client, name: "CO Terms Client", initials: "CT", email: `${run}@example.test` },
        });
        await prisma.project.create({
            data: {
                id: ids.project,
                name: "CO Terms Disposable Project",
                clientId: ids.client,
                status: "In Progress",
                startDate: new Date("2026-09-01T00:00:00.000Z"),
                endDate: new Date("2026-10-15T00:00:00.000Z"),
            },
        });
        await prisma.estimate.create({
            data: {
                id: ids.estimate,
                code: `${run}-EST`,
                title: "CO Terms Base Estimate",
                projectId: ids.project,
                status: "Approved",
                totalAmount: 100,
                balanceDue: 100,
                taxExempt: sentTerms.taxExempt,
                taxRatePercent: sentTerms.taxRatePercent,
                taxRateName: sentTerms.taxRateName,
                items: { create: { name: "Base labor", type: "Labor", quantity: 1, unitCost: 100, total: 100 } },
            },
        });
        await prisma.invoice.create({
            data: {
                id: ids.invoice,
                code: `${run}-INV`,
                projectId: ids.project,
                clientId: ids.client,
                estimateId: ids.estimate,
                status: "Pending",
                subtotal: 100,
                totalAmount: 100,
                balanceDue: 100,
            },
        });
        const scoped = await prisma.user.findUnique({ where: { email: "scoped-staff@test.local" }, select: { id: true } });
        if (!scoped) throw new Error("data.setup scoped user is required for role-visibility coverage");
        await prisma.projectAccess.upsert({
            where: { userId_projectId: { userId: scoped.id, projectId: ids.project } },
            update: {},
            create: { userId: scoped.id, projectId: ids.project },
        });
    });

    test.afterAll(async () => {
        try {
            await prisma.notification.deleteMany({ where: { projectId: ids.project } });
            await prisma.activityLog.deleteMany({ where: { projectId: ids.project } });
            await prisma.changeOrderBilling.deleteMany({ where: { changeOrder: { projectId: ids.project } } });
            await prisma.paymentSchedule.deleteMany({ where: { invoiceId: ids.invoice } });
            await prisma.scheduleTask.deleteMany({ where: { projectId: ids.project } });
            await prisma.changeOrder.deleteMany({ where: { projectId: ids.project } });
            await prisma.invoice.deleteMany({ where: { id: ids.invoice } });
            await prisma.estimate.deleteMany({ where: { id: ids.estimate } });
            await prisma.projectAccess.deleteMany({ where: { projectId: ids.project } });
            await prisma.project.deleteMany({ where: { id: ids.project } });
            await prisma.client.deleteMany({ where: { id: ids.client } });
        } finally {
            await prisma.$disconnect();
        }
    });

    test("stale Draft send tax fingerprint rejects without status, revision, tuple, or email mutation", async () => {
        await createFixedCo(ids.staleDraft);
        const loaded = await readRevisionAndDisplayedFingerprint(ids.staleDraft);
        await prisma.estimate.update({
            where: { id: ids.estimate },
            data: { taxRatePercent: 9.125, taxRateName: "Tax-only edit" },
        });
        let emails = 0;
        const result = await sendChangeOrderToClientCore(ids.staleDraft, {
            expectedRevision: loaded.revision,
            expectedTaxFingerprint: loaded.fingerprint,
            sendNotification: async () => {
                emails++;
                return { success: true, id: "must-not-send" };
            },
            ...coreDependencies,
        });

        expect(result.success).toBe(false);
        if (result.success) throw new Error("stale tax send unexpectedly succeeded");
        expect(result.code).toBe("TAX_TERMS_CONFLICT");
        expect(result.error).toMatch(/tax terms changed/i);
        expect(emails).toBe(0);
        const row = await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.staleDraft } });
        expect(row).toMatchObject({ status: "Draft", revision: loaded.revision, termsTaxExempt: null });

        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
    });

    test("UI Send returns TAX_TERMS_CONFLICT and hard reloads after a tax-only edit", async ({ page }) => {
        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
        await createFixedCo(ids.sendConflict);
        await prisma.activityLog.deleteMany({ where: { projectId: ids.project } });
        const notificationsBefore = await prisma.notification.count({ where: { projectId: ids.project } });

        await page.goto(`/projects/${ids.project}/change-orders/${ids.sendConflict}`, { waitUntil: "networkidle" });
        await expect(page.getByText("Seattle exact rate (8.875%)", { exact: true })).toBeVisible();
        await prisma.estimate.update({
            where: { id: ids.estimate },
            data: { taxRatePercent: 9.125, taxRateName: "UI tax-only edit" },
        });

        page.once("dialog", dialog => dialog.accept());
        const hardReload = page.waitForNavigation({ waitUntil: "networkidle", timeout: 15_000 });
        await page.getByRole("button", { name: "Send for Approval" }).click();
        await hardReload;
        await expect(page.getByText("UI tax-only edit (9.125%)", { exact: true })).toBeVisible({ timeout: 15_000 });

        const row = await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.sendConflict } });
        expect(row).toMatchObject({
            status: "Draft",
            revision: 1,
            sentAt: null,
            termsTaxExempt: null,
            termsTaxRateName: null,
            termsTaxRatePercent: null,
        });
        expect(await prisma.notification.count({ where: { projectId: ids.project } })).toBe(notificationsBefore);
        expect(await prisma.activityLog.count({ where: { projectId: ids.project } })).toBe(0);

        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
    });

    test("MCP preview token becomes a fresh preview after a tax-only edit and cannot send", async ({ request }) => {
        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
        await createFixedCo(ids.mcpStaleDraft);
        await prisma.activityLog.deleteMany({ where: { projectId: ids.project } });

        const preview = await callMcpTool(request, 1, "send_change_order", {
            changeOrderId: ids.mcpStaleDraft,
        });
        expect(preview).toMatchObject({
            preview: true,
            changeOrder: {
                status: "Draft",
                taxTreatment: "Seattle exact rate (8.875%)",
                revisedAmountCustomerSigns: 10.89,
            },
        });
        expect(preview.confirmToken).toEqual(expect.any(String));

        await prisma.estimate.update({
            where: { id: ids.estimate },
            data: { taxRatePercent: 9.125, taxRateName: "MCP tax-only edit" },
        });
        const staleConfirm = await callMcpTool(request, 2, "send_change_order", {
            changeOrderId: ids.mcpStaleDraft,
            confirmToken: preview.confirmToken,
        });
        expect(staleConfirm).toMatchObject({
            preview: true,
            changeOrder: {
                status: "Draft",
                taxTreatment: "MCP tax-only edit (9.125%)",
                revisedAmountCustomerSigns: 10.91,
            },
        });
        expect(staleConfirm.confirmToken).not.toBe(preview.confirmToken);

        const row = await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.mcpStaleDraft } });
        expect(row).toMatchObject({
            status: "Draft",
            revision: 0,
            sentAt: null,
            termsTaxExempt: null,
            termsTaxRateName: null,
            termsTaxRatePercent: null,
        });
        const auditActions = (await prisma.activityLog.findMany({
            where: { projectId: ids.project },
            orderBy: { createdAt: "asc" },
            select: { action: true },
        })).map(entry => entry.action);
        expect(auditActions).toEqual([
            "mcp_preview_send_change_order",
            "mcp_preview_send_change_order",
        ]);
        expect(auditActions).not.toContain("mcp_send_send_change_order");
        expect(auditActions).not.toContain("sent_change_order");

        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
    });

    test("MCP returns a newly queried preview when tax changes after token verification but before the locked core check", async ({ request }) => {
        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
        await createFixedCo(ids.mcpTaxCoreRace);
        await prisma.activityLog.deleteMany({ where: { projectId: ids.project } });
        const notificationsBefore = await prisma.notification.count({ where: { projectId: ids.project } });
        const preview = await callMcpTool(request, 10, "send_change_order", { changeOrderId: ids.mcpTaxCoreRace });

        const raced = await callMcpConfirmAcrossLockedRace(
            request,
            11,
            ids.mcpTaxCoreRace,
            preview.confirmToken,
            tx => tx.estimate.update({
                where: { id: ids.estimate },
                data: { taxRatePercent: 9.375, taxRateName: "Post-token tax race" },
            }),
        );

        expect(raced).toMatchObject({
            preview: true,
            changeOrder: {
                status: "Draft",
                taxTreatment: "Post-token tax race (9.375%)",
                revisedAmountCustomerSigns: 10.94,
            },
        });
        expect(raced.confirmToken).not.toBe(preview.confirmToken);
        expect(verifyPreviewToken(raced.confirmToken, await currentMcpSendPayload(ids.mcpTaxCoreRace))).toBe(true);
        expect(await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.mcpTaxCoreRace } })).toMatchObject({
            status: "Draft",
            revision: 0,
            sentAt: null,
            termsTaxExempt: null,
            termsTaxRateName: null,
            termsTaxRatePercent: null,
        });
        expect(await prisma.notification.count({ where: { projectId: ids.project } })).toBe(notificationsBefore);
        expect((await prisma.activityLog.findMany({
            where: { projectId: ids.project },
            orderBy: { createdAt: "asc" },
            select: { action: true },
        })).map(row => row.action)).toEqual([
            "mcp_preview_send_change_order",
            "mcp_preview_send_change_order",
        ]);

        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
    });

    test("MCP returns a newly queried preview when revision changes after token verification but before the locked core check", async ({ request }) => {
        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
        await createFixedCo(ids.mcpRevisionCoreRace);
        await prisma.activityLog.deleteMany({ where: { projectId: ids.project } });
        const notificationsBefore = await prisma.notification.count({ where: { projectId: ids.project } });
        const preview = await callMcpTool(request, 20, "send_change_order", { changeOrderId: ids.mcpRevisionCoreRace });

        const raced = await callMcpConfirmAcrossLockedRace(
            request,
            21,
            ids.mcpRevisionCoreRace,
            preview.confirmToken,
            tx => tx.changeOrder.update({
                where: { id: ids.mcpRevisionCoreRace },
                data: { title: "Post-token revision race", revision: { increment: 1 } },
            }),
        );

        expect(raced).toMatchObject({
            preview: true,
            changeOrder: {
                title: "Post-token revision race",
                status: "Draft",
                taxTreatment: "Seattle exact rate (8.875%)",
                revisedAmountCustomerSigns: 10.89,
            },
        });
        expect(raced.confirmToken).not.toBe(preview.confirmToken);
        expect(verifyPreviewToken(raced.confirmToken, await currentMcpSendPayload(ids.mcpRevisionCoreRace))).toBe(true);
        expect(await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.mcpRevisionCoreRace } })).toMatchObject({
            title: "Post-token revision race",
            status: "Draft",
            revision: 1,
            sentAt: null,
            termsTaxExempt: null,
            termsTaxRateName: null,
            termsTaxRatePercent: null,
        });
        expect(await prisma.notification.count({ where: { projectId: ids.project } })).toBe(notificationsBefore);
        expect((await prisma.activityLog.findMany({
            where: { projectId: ids.project },
            orderBy: { createdAt: "asc" },
            select: { action: true },
        })).map(row => row.action)).toEqual([
            "mcp_preview_send_change_order",
            "mcp_preview_send_change_order",
        ]);
    });

    test("a Sent scope save clears old terms and the next guarded send freezes current terms", async () => {
        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
        await createFixedCo(ids.resendLifecycle, {
            status: "Sent",
            sentAt: new Date("2026-09-01T12:00:00.000Z"),
            termsTaxExempt: sentTerms.taxExempt,
            termsTaxRateName: sentTerms.taxRateName,
            termsTaxRatePercent: sentTerms.taxRatePercent,
        });

        const saved = await updateChangeOrderCore(ids.resendLifecycle, {
            title: "Scope changed after first send",
            expectedRevision: 0,
        });
        expect(saved).toMatchObject({
            status: "Draft",
            revision: 1,
            sentAt: null,
            termsTaxExempt: null,
            termsTaxRateName: null,
            termsTaxRatePercent: null,
        });

        const freshTerms = {
            taxExempt: false,
            taxRatePercent: 9.5,
            taxRateName: "Fresh terms after scope edit",
        };
        await prisma.estimate.update({ where: { id: ids.estimate }, data: freshTerms });
        const guard = await readRevisionAndDisplayedFingerprint(ids.resendLifecycle);
        let sentHtml = "";
        const resent = await sendChangeOrderToClientCore(ids.resendLifecycle, {
            expectedRevision: guard.revision,
            expectedTaxFingerprint: guard.fingerprint,
            sendNotification: async (_to, _subject, html) => {
                sentHtml = html;
                return { success: true, id: `${run}-lifecycle-resend` };
            },
            ...coreDependencies,
        });
        expect(resent).toMatchObject({ success: true, revision: 2 });
        expect(sentHtml).toContain("Fresh terms after scope edit (9.5%)");
        const resentRow = await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.resendLifecycle } });
        expect(resentRow).toMatchObject({
            status: "Sent",
            revision: 2,
            termsTaxExempt: false,
            termsTaxRateName: "Fresh terms after scope edit",
        });
        expect(Number(resentRow.termsTaxRatePercent)).toBe(9.5);

        await prisma.estimate.update({ where: { id: ids.estimate }, data: sentTerms });
    });

    test("send freezes terms and email, portal, PDF, and billing share gross schedule cents after estimate edits", async ({ page }) => {
        await createFixedCo(ids.customerFlow, {}, true);
        const loaded = await readRevisionAndDisplayedFingerprint(ids.customerFlow);
        let sentHtml = "";
        const sent = await sendChangeOrderToClientCore(ids.customerFlow, {
            expectedRevision: loaded.revision,
            expectedTaxFingerprint: loaded.fingerprint,
            sendNotification: async (_to, _subject, html) => {
                sentHtml = html;
                return { success: true, id: `${run}-mock-email` };
            },
            ...coreDependencies,
        });
        expect(sent.success).toBe(true);
        if (!sent.success) throw new Error(sent.error);
        expect(sentHtml).toContain("Seattle exact rate (8.875%)");
        expect(sentHtml.match(/\$3\.63/g)?.length).toBe(3);
        expect(sentHtml).toContain("$10.89");

        const sentRow = await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.customerFlow } });
        expect(sentRow).toMatchObject({
            status: "Sent",
            revision: 1,
            termsTaxExempt: false,
            termsTaxRateName: "Seattle exact rate",
        });
        expect(Number(sentRow.termsTaxRatePercent)).toBe(8.875);

        await prisma.estimate.update({
            where: { id: ids.estimate },
            data: { taxRatePercent: 12.5, taxRateName: "Changed after customer send" },
        });

        await page.goto(`/portal/change-orders/${ids.customerFlow}`, { waitUntil: "networkidle" });
        await expect(page.getByText("Seattle exact rate (8.875%)", { exact: true })).toBeVisible();
        await expect(page.getByText("$10.89", { exact: true })).toBeVisible();
        await expect(page.getByText("$3.63", { exact: true })).toHaveCount(3);

        const pdfText = await extractPdfText(await generateChangeOrderPdf(ids.customerFlow));
        expect(pdfText).toContain("Seattle exact rate (8.875%)");
        expect(pdfText).toContain("$10.89");
        expect(pdfText.match(/\$3\.63/g)?.length).toBeGreaterThanOrEqual(3);

        const firstPortalRevision = sent.revision;
        const resendGuard = await readRevisionAndDisplayedFingerprint(ids.customerFlow);
        const resent = await sendChangeOrderToClientCore(ids.customerFlow, {
            expectedRevision: resendGuard.revision,
            expectedTaxFingerprint: resendGuard.fingerprint,
            sendNotification: async () => ({ success: true, id: `${run}-mock-resend` }),
            ...coreDependencies,
        });
        expect(resent.success).toBe(true);
        if (!resent.success) throw new Error(resent.error);

        let discarded = 0;
        await expect(approveChangeOrderWithSignature(ids.customerFlow, {
            signatureName: "Stale portal signer",
            signatureDataUrl: "data:image/png;base64,AA==",
            approvedAt: new Date("2026-09-02T12:00:00.000Z"),
            expectedRevision: firstPortalRevision,
            expectedTaxFingerprint: coTaxFingerprint(sentTerms),
        }, {
            persistSignature: async () => ({
                url: `secure-doc://${run}/stale-client-signature.png`,
                discard: async () => { discarded++; },
            }),
            approveCore: approveChangeOrderCore,
        })).rejects.toThrow(/modified after this page loaded/i);
        expect(discarded).toBe(1);
        expect(await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.customerFlow } })).toMatchObject({
            status: "Sent",
            clientSignatureUrl: null,
            revision: resent.revision,
        });

        const approved = await approveChangeOrderWithSignature(ids.customerFlow, {
            signatureName: "Current portal signer",
            signatureDataUrl: "data:image/png;base64,AA==",
            approvedAt: new Date("2026-09-02T12:05:00.000Z"),
            expectedRevision: resent.revision,
            expectedTaxFingerprint: coTaxFingerprint(sentTerms),
        }, {
            persistSignature: async () => ({ url: `secure-doc://${run}/current-client-signature.png`, discard: async () => undefined }),
            approveCore: approveChangeOrderCore,
        });
        expect(approved?.co).toMatchObject({ status: "Approved", termsTaxRateName: "Seattle exact rate" });
        expect(Number(approved?.co.termsTaxRatePercent)).toBe(8.875);

        const billed = await billChangeOrderCore(ids.customerFlow, coreDependencies);
        expect(billed.ok).toBe(true);
        if (!billed.ok) throw new Error(billed.error);
        expect(billed.amount).toBe(10.89);
        expect(billed.milestones.map(row => row.amount)).toEqual([3.63, 3.63, 3.63]);
    });

    test("legacy Sent/null bootstraps only through the guard and legacy Approved/null deliberately uses live fallback", async ({ page }) => {
        await prisma.estimate.update({
            where: { id: ids.estimate },
            data: { taxRatePercent: 12.5, taxRateName: "Changed after customer send" },
        });
        await createFixedCo(ids.legacySent, { status: "Sent", sentAt: new Date() });
        const guard = await readRevisionAndDisplayedFingerprint(ids.legacySent);
        const bootstrapped = await sendChangeOrderToClientCore(ids.legacySent, {
            expectedRevision: guard.revision,
            expectedTaxFingerprint: guard.fingerprint,
            sendNotification: async () => ({ success: true, id: `${run}-legacy-bootstrap` }),
            ...coreDependencies,
        });
        expect(bootstrapped.success).toBe(true);
        const stored = await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.legacySent } });
        expect(stored.termsTaxExempt).toBe(false);
        expect(Number(stored.termsTaxRatePercent)).toBe(12.5);
        expect(stored.termsTaxRateName).toBe("Changed after customer send");

        await createFixedCo(ids.legacyApproved, {
            status: "Approved",
            approvedBy: "Legacy Client",
            approvedAt: new Date(),
            clientSignatureUrl: `secure-doc://${run}/legacy.png`,
            termsTaxExempt: null,
            termsTaxRateName: null,
            termsTaxRatePercent: null,
        });
        await page.goto(`/portal/change-orders/${ids.legacyApproved}`, { waitUntil: "networkidle" });
        await expect(page.getByText("Changed after customer send (12.5%)", { exact: true })).toBeVisible();
        await expect(page.getByText("$11.25", { exact: true })).toBeVisible();
    });

    test("schedule overlays and zero-row apply/regenerate notes stay on stored terms after estimate changes", async () => {
        await createFixedCo(ids.scheduled, {
            status: "Approved",
            approvedBy: "Schedule Client",
            approvedAt: new Date(),
            termsTaxExempt: false,
            termsTaxRateName: "Seattle exact rate",
            termsTaxRatePercent: 8.875,
        }, true);
        await createFixedCo(ids.zeroSchedule, {
            status: "Approved",
            approvedBy: "Schedule Client",
            approvedAt: new Date(),
            termsTaxExempt: false,
            termsTaxRateName: "Seattle exact rate",
            termsTaxRatePercent: 8.875,
        });

        const actor = { type: "TEAM" as const, name: "Playwright terms schedule" };
        await applyChangeOrderToSchedule({ changeOrderId: ids.scheduled, actor });
        const zeroFirst = await applyChangeOrderToSchedule({ changeOrderId: ids.zeroSchedule, actor });
        expect(zeroFirst.notes.join(" ")).toContain("$10.89 projected");

        const from = new Date("2026-01-01T00:00:00.000Z");
        const to = new Date("2027-12-31T00:00:00.000Z");
        const before = await getChangeOrderOverlayRows(from, to);
        expect(before.filter(row => row.changeOrderId === ids.scheduled).map(row => row.amount)).toEqual([3.63, 3.63, 3.63]);
        expect(before.find(row => row.changeOrderId === ids.zeroSchedule)?.amount).toBe(10.89);

        await prisma.estimate.update({ where: { id: ids.estimate }, data: { taxRatePercent: 17.125, taxRateName: "Later live edit" } });
        await applyChangeOrderToSchedule({ changeOrderId: ids.scheduled, mode: "regenerate", actor });
        const zeroRegenerated = await applyChangeOrderToSchedule({ changeOrderId: ids.zeroSchedule, mode: "regenerate", actor });
        expect(zeroRegenerated.notes.join(" ")).toContain("$10.89 projected");
        const after = await getChangeOrderOverlayRows(from, to);
        expect(after.filter(row => row.changeOrderId === ids.scheduled).map(row => row.amount)).toEqual([3.63, 3.63, 3.63]);
        expect(after.find(row => row.changeOrderId === ids.zeroSchedule)?.amount).toBe(10.89);
    });

    test("co-audit repair of Sent scope returns Draft and clears the sent terms tuple", async () => {
        await createFixedCo(ids.auditSent, {
            status: "Sent",
            sentAt: new Date(),
            totalAmount: 10.89,
            balanceDue: 10.89,
            termsTaxExempt: false,
            termsTaxRateName: "Seattle exact rate",
            termsTaxRatePercent: 8.875,
        });
        const priorSecret = process.env.CO_AUDIT_SECRET;
        process.env.CO_AUDIT_SECRET = `${run}-audit-secret`;
        try {
            const response = await repairChangeOrder(new Request("http://localhost/api/integrations/co-audit", {
                method: "POST",
                headers: { "content-type": "application/json", "x-audit-key": process.env.CO_AUDIT_SECRET },
                body: JSON.stringify({ changeOrderId: ids.auditSent, expectedTotalAmount: 10.89 }),
            }));
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ ok: true, changed: true });
        } finally {
            if (priorSecret === undefined) delete process.env.CO_AUDIT_SECRET;
            else process.env.CO_AUDIT_SECRET = priorSecret;
        }
        const row = await prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.auditSent } });
        expect(row).toMatchObject({
            status: "Draft",
            sentAt: null,
            viewedAt: null,
            termsTaxExempt: null,
            termsTaxRateName: null,
            termsTaxRatePercent: null,
            revision: 1,
        });
    });

    test("manual Approved header is honest and non-privileged change-order staff never see manual approval", async ({ page, browser }) => {
        await createFixedCo(ids.manualHeader, {
            status: "Approved",
            approvedBy: "Manager Name (manual approval — staff)",
            approvedAt: new Date(),
            termsTaxExempt: false,
            termsTaxRateName: "Seattle exact rate",
            termsTaxRatePercent: 8.875,
        });
        await page.goto(`/portal/change-orders/${ids.manualHeader}`, { waitUntil: "networkidle" });
        await expect(page.getByText("✓ Approved", { exact: true })).toBeVisible();
        await expect(page.getByText("✓ Approved & Signed", { exact: true })).toHaveCount(0);

        await createFixedCo(ids.roleVisibility, {
            status: "Sent",
            sentAt: new Date(),
            termsTaxExempt: false,
            termsTaxRateName: "Seattle exact rate",
            termsTaxRatePercent: 8.875,
        });
        const scopedContext = await browser.newContext({ storageState: "e2e/.auth/scoped-user.json" });
        const scopedPage = await scopedContext.newPage();
        try {
            await scopedPage.goto(`/projects/${ids.project}/change-orders/${ids.roleVisibility}`, { waitUntil: "networkidle" });
            await scopedPage.getByRole("button", { name: "Details & Signatures" }).click();
            await expect(scopedPage.getByRole("button", { name: "Mark as Approved (manual)" })).toHaveCount(0);
        } finally {
            await scopedContext.close();
        }
    });
});
