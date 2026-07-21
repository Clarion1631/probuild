import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { buildMilestoneRequestEmail, sendMilestoneInvoicesCore } from "../src/lib/billing-core";

/**
 * Milestone payment-request regression net — born from the July 2026 Berg ADU
 * confusion: the client opened the portal and saw the WHOLE invoice balance
 * ($21,590) when the office only meant to request the $10k progress payment.
 *
 * Guards:
 *  1. The request email asks for EXACTLY the selected milestones — the
 *     whole-invoice total/balance never appears in subject or body.
 *  2. Multiple milestones in one send are summed into a single Amount Due Now.
 *  3. Customer-controlled values (milestone/client/project/company names) are
 *     HTML-escaped in the body, and the subject is newline-stripped against
 *     header injection.
 *  4. sendMilestoneInvoicesCore fails CLOSED when the QuickBooks money rail is
 *     unavailable: no email, no sent stamps, no activity rows.
 *
 * The DB test runs against the throwaway CI Postgres (data.setup.ts guards
 * prod). No CompanySettings row + the dummy RESEND_API_KEY means no real email
 * can leave; the QBO path has no Integration row here, which is exactly what
 * test 4 relies on.
 */

const prisma = new PrismaClient();

test.describe("Milestone payment request email (composition)", () => {
    test("asks for exactly the selected milestone, never the whole balance", () => {
        const { subject, html } = buildMilestoneRequestEmail({
            companyName: "Golden Touch Remodeling",
            clientName: "Dixie Berg",
            projectName: "Berg ADU",
            invoiceCode: "INV-00177",
            milestones: [{ name: "Drywall Complete", amount: 10000 }],
            portalUrl: "https://app.example.com/portal/invoices/inv1?milestone=ms1",
        });

        expect(subject).toContain("$10,000.00");
        expect(subject).toContain("Drywall Complete");
        expect(html).toContain("Amount Due Now");
        expect(html).toContain("$10,000.00");
        expect(html).toContain("Drywall Complete");
        expect(html).toContain("Only the payment above is due now");
        // The whole-invoice figures (Berg: total $36,590 / balance $21,590)
        // must never leak into a milestone-scoped request.
        expect(html).not.toContain("36,590");
        expect(html).not.toContain("21,590");
        // The portal link carries the milestone focus.
        expect(html).toContain("milestone=ms1");
    });

    test("sums multiple milestones into one Amount Due Now", () => {
        const { subject, html } = buildMilestoneRequestEmail({
            companyName: "GTR",
            clientName: "Dixie",
            projectName: "Berg ADU",
            invoiceCode: "INV-00177",
            milestones: [
                { name: "Drywall Complete", amount: 10000 },
                { name: "Progress Payment", amount: 11590 },
            ],
            portalUrl: "https://app.example.com/portal/invoices/inv1?milestone=ms1,ms2",
        });

        expect(html).toContain("$21,590.00");
        expect(html).toContain("Only the payments above are due now");
        expect(subject).toContain("$21,590.00");
        // Multi-milestone sends must not name a single milestone in the subject.
        expect(subject).not.toContain("for Drywall");
    });

    test("escapes customer-controlled HTML and strips subject newlines", () => {
        const evilName = '<img src=x onerror=alert(1)>\nBCC: attacker@evil.com';
        const { subject, html } = buildMilestoneRequestEmail({
            companyName: 'GTR <b>"HQ"</b>',
            clientName: evilName,
            projectName: "<script>alert(1)</script>",
            invoiceCode: "INV-<b>1</b>",
            milestones: [{ name: evilName, amount: 10000 }],
            portalUrl: "https://app.example.com/portal/invoices/inv1?milestone=ms1",
        });

        expect(html).not.toContain("<img src=x");
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).not.toContain('GTR <b>"HQ"</b>');
        expect(html).toContain("&lt;img src=x");
        expect(html).toContain("&lt;script&gt;");
        // Header injection requires CRLF — the subject must contain neither.
        expect(subject).not.toMatch(/[\r\n]/);
    });
});

const FIX = {
    client: "msr-e2e-client",
    project: "msr-e2e-project",
    invoice: "msr-e2e-invoice",
    milestone: "msr-e2e-milestone",
};

test.describe("sendMilestoneInvoicesCore fail-closed (no QuickBooks connection)", () => {
    test.beforeAll(async () => {
        await prisma.client.create({ data: { id: FIX.client, name: "Milestone Send Drill", initials: "MSD" } });
        await prisma.project.create({ data: { id: FIX.project, name: "Milestone Send Drill Project", clientId: FIX.client } });
        await prisma.invoice.create({
            data: {
                id: FIX.invoice,
                code: "INV-E2E-MSR-001",
                projectId: FIX.project,
                clientId: FIX.client,
                totalAmount: 10000,
                balanceDue: 10000,
                status: "Issued",
            },
        });
        await prisma.paymentSchedule.create({
            data: { id: FIX.milestone, invoiceId: FIX.invoice, name: "Drywall Complete", amount: 10000 },
        });
    });

    test.afterAll(async () => {
        await prisma.paymentSchedule.deleteMany({ where: { invoiceId: FIX.invoice } });
        await prisma.invoice.deleteMany({ where: { id: FIX.invoice } });
        await prisma.project.deleteMany({ where: { id: FIX.project } });
        await prisma.client.deleteMany({ where: { id: FIX.client } });
        await prisma.$disconnect();
    });

    test("nothing is sent, stamped, or logged when the money rail is down", async () => {
        const res = await sendMilestoneInvoicesCore(FIX.invoice, [FIX.milestone], "drill@example.com", undefined, "E2E Drill", "e2e:milestone-payment-request");

        expect(res.success).toBe(false);
        expect(res.sent).toBe(0);
        expect(res.error || "").toBeTruthy();

        const ms = await prisma.paymentSchedule.findUnique({ where: { id: FIX.milestone } });
        expect(ms?.qbInvoiceSentAt).toBeNull();

        const logs = await prisma.activityLog.count({ where: { entityId: FIX.invoice, action: "sent_invoice" } });
        expect(logs).toBe(0);
    });
});
