import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { approveChangeOrderOfflineCore } from "../src/lib/billing-core";

// Credit (negative) change orders, end to end: staff open a credit CO, Mark approved,
// pick a NON-default milestone, and the credit comes off that milestone only. Nothing
// is sent to the customer. Fixture data is generic; the repo is public.

const prisma = new PrismaClient();
const run = `crco-${process.pid}-${Date.now()}`;

const IDS = {
  client: `${run}-client`,
  project: `${run}-project`,
  estimate: `${run}-estimate`,
  invoice: `${run}-invoice`,
  epsDeposit: `${run}-eps-deposit`,
  epsCabinets: `${run}-eps-cabinets`,
  epsFinal: `${run}-eps-final`,
  deposit: `${run}-ms-deposit`,
  cabinets: `${run}-ms-cabinets`,
  final: `${run}-ms-final`,
  co: `${run}-co`,
} as const;
const INVOICE_CODE = `${run}-INV`;
const ESTIMATE_CODE = `${run}-EST`;

const cents = (value: unknown) => Math.round(Number(value) * 100);

test.describe.serial("Credit change orders", () => {
  test.beforeAll(async () => {
    await prisma.client.create({ data: { id: IDS.client, name: "Credit Client", initials: "CC", email: `${run}@example.test` } });
    await prisma.project.create({ data: { id: IDS.project, name: "Kitchen remodel", clientId: IDS.client, status: "In Progress" } });
    await prisma.estimate.create({
      data: {
        id: IDS.estimate, code: ESTIMATE_CODE, title: "Kitchen remodel estimate", projectId: IDS.project, status: "Approved",
        totalAmount: 29637.12, balanceDue: 29637.12, taxRateName: "Sales tax", taxRatePercent: 8.8, taxExempt: false,
      },
    });
    await prisma.estimatePaymentSchedule.createMany({
      data: [
        { id: IDS.epsDeposit, estimateId: IDS.estimate, name: "Deposit", amount: 10880, order: 0 },
        { id: IDS.epsCabinets, estimateId: IDS.estimate, name: "Cabinets", amount: 9792, order: 1 },
        { id: IDS.epsFinal, estimateId: IDS.estimate, name: "Final", amount: 8965.12, order: 2 },
      ],
    });
    await prisma.invoice.create({
      data: {
        id: IDS.invoice, code: INVOICE_CODE, projectId: IDS.project, clientId: IDS.client, estimateId: IDS.estimate,
        status: "Issued", subtotal: 27240, taxRate: 8.8, taxAmount: 2397.12, totalAmount: 29637.12, balanceDue: 29637.12,
      },
    });
    await prisma.paymentSchedule.createMany({
      data: [
        { id: IDS.deposit, invoiceId: IDS.invoice, name: "Deposit", amount: 10880, pretaxAmount: 10000, taxAmount: 880, sourceScheduleId: IDS.epsDeposit },
        { id: IDS.cabinets, invoiceId: IDS.invoice, name: "Cabinets", amount: 9792, pretaxAmount: 9000, taxAmount: 792, sourceScheduleId: IDS.epsCabinets },
        { id: IDS.final, invoiceId: IDS.invoice, name: "Final", amount: 8965.12, sourceScheduleId: IDS.epsFinal },
      ],
    });
    await prisma.changeOrder.create({
      data: {
        id: IDS.co, projectId: IDS.project, estimateId: IDS.estimate, code: `${run}-CO`, title: "Remove pantry upgrade",
        status: "Draft", pricingType: "FIXED", totalAmount: -3020, balanceDue: -3020,
        items: { create: [{ name: "Remove pantry upgrade", type: "Material", quantity: 1, unitCost: -3020, total: -3020, order: 0 }] },
      },
    });
  });

  test.afterAll(async () => {
    try {
      await prisma.changeOrderBilling.deleteMany({ where: { changeOrderId: IDS.co } });
      await prisma.activityLog.deleteMany({ where: { projectId: IDS.project } });
      await prisma.changeOrder.deleteMany({ where: { id: IDS.co } });
      await prisma.paymentSchedule.deleteMany({ where: { invoiceId: IDS.invoice } });
      await prisma.invoice.deleteMany({ where: { id: IDS.invoice } });
      await prisma.estimatePaymentSchedule.deleteMany({ where: { estimateId: IDS.estimate } });
      await prisma.estimate.deleteMany({ where: { id: IDS.estimate } });
      await prisma.project.deleteMany({ where: { id: IDS.project } });
      await prisma.client.deleteMany({ where: { id: IDS.client } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("CRCO1: Mark approved takes the credit off the picked milestone and sends nothing", async ({ page }) => {
    await page.goto(`/projects/${IDS.project}/change-orders/${IDS.co}`, { waitUntil: "networkidle" });
    await expect(page.getByText("Credit Amount", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Mark approved", exact: true }).click();
    const modal = page.locator("div.fixed", { has: page.getByRole("heading", { name: "Mark approved" }) });
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId("credit-summary")).toContainText("Credit -$3,285.76 incl. Sales tax (8.8%)");
    await expect(modal.getByTestId("credit-summary")).toContainText(`Invoice ${INVOICE_CODE}`);
    await expect(modal.getByTestId("credit-summary")).toContainText(`Estimate ${ESTIMATE_CODE}`);

    const target = modal.locator("#offline-credit-target");
    await expect(target).toBeEnabled();
    await expect(target).toHaveValue(IDS.final); // the default is the estimate's last milestone
    await expect(target.locator("option")).toHaveText([
      "Deposit ($10,880.00 → $7,594.24)",
      "Cabinets ($9,792.00 → $6,506.24)",
      "Final ($8,965.12 → $5,679.36)",
    ]);
    await target.selectOption(IDS.cabinets);
    await modal.locator("#offline-approval-method").selectOption("PHONE");

    const confirm = modal.getByRole("button", { name: "Mark approved", exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.locator("[data-sonner-toast][data-type=\"success\"]").last())
      .toContainText(`Took $3,285.76 off Cabinets on invoice ${INVOICE_CODE} ($9,792.00 → $6,506.24)`);

    const co = await prisma.changeOrder.findUniqueOrThrow({ where: { id: IDS.co } });
    expect(co.status).toBe("Approved");
    expect(co.approvalSource).toBe("OFFLINE");

    const cabinets = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.cabinets } });
    expect([cents(cabinets.amount), cents(cabinets.pretaxAmount), cents(cabinets.taxAmount)]).toEqual([650624, 598000, 52624]);
    expect(cabinets.qbInvoiceSentAt).toBeNull();
    expect(cabinets.qbInvoiceId).toBeNull();
    expect(cabinets.sourceChangeOrderId).toBeNull();
    expect(cents((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.final } })).amount)).toBe(896512);
    expect(cents((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.deposit } })).amount)).toBe(1088000);
    expect(await prisma.paymentSchedule.count({ where: { invoiceId: IDS.invoice } })).toBe(3);
    const unsent = await prisma.paymentSchedule.findMany({ where: { invoiceId: IDS.invoice }, select: { qbInvoiceSentAt: true } });
    expect(unsent.every((row) => row.qbInvoiceSentAt === null)).toBe(true);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: IDS.invoice } });
    expect([cents(invoice.subtotal), cents(invoice.taxAmount), cents(invoice.totalAmount), cents(invoice.balanceDue)])
      .toEqual([2422000, 213136, 2635136, 2635136]);
    expect(invoice.status).toBe("Issued");

    const markers = await prisma.changeOrderBilling.findMany({ where: { changeOrderId: IDS.co } });
    expect(markers).toHaveLength(1);
    expect(markers[0].paymentScheduleId).toBeNull();
    expect(markers[0].totalCents).toBe(-328576);
    expect((markers[0].snapshot as { kind?: string; paymentScheduleId?: string }).kind).toBe("credit");
    expect((markers[0].snapshot as { kind?: string; paymentScheduleId?: string }).paymentScheduleId).toBe(IDS.cabinets);
  });

  test("CRCO2: a second Mark approved is refused and changes nothing", async ({ page }) => {
    await page.goto(`/projects/${IDS.project}/change-orders/${IDS.co}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Mark approved", exact: true })).toHaveCount(0);
    await expect(page.getByText("Credit applied to Cabinets", { exact: false })).toBeVisible();

    const row = await prisma.changeOrder.findUniqueOrThrow({ where: { id: IDS.co }, select: { updatedAt: true } });
    const replay = await approveChangeOrderOfflineCore(IDS.co, {
      method: "PHONE",
      // Yesterday by UTC is never in the future in the company zone (UTC-7/-8).
      approvedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      expectedUpdatedAt: row.updatedAt.toISOString(),
      actor: { userId: "playwright", name: "Office Manager" },
      targetMilestoneId: IDS.final,
    }, { logActivity: async () => {}, applySchedule: async () => {}, notifyTeam: (async () => ({ success: true })) as never, revalidatePath: () => {} });
    expect(replay.ok).toBe(false);
    expect((replay as { code: string }).code).toBe("ALREADY_APPROVED");

    expect(await prisma.changeOrderBilling.count({ where: { changeOrderId: IDS.co } })).toBe(1);
    expect(cents((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.final } })).amount)).toBe(896512);
    expect(cents((await prisma.invoice.findUniqueOrThrow({ where: { id: IDS.invoice } })).totalAmount)).toBe(2635136);
  });
});
