import { expect, request, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  billChangeOrderCore,
  billCostPlusChangeOrderCore,
  createChangeOrderDraft,
  previewCostPlusChangeOrderCore,
  sendChangeOrderToClientCore,
} from "../src/lib/billing-core";
import { approveChangeOrderCore, updateChangeOrderCore } from "../src/lib/change-order-core";
import { approveChangeOrderWithSignature } from "../src/lib/change-order-approval";
import {
  calculateCrewTimeCosts,
  createExpenseCore,
  createTimeEntryCore,
  createTimeEntryFromStoredRatesCore,
  findCrewMatches,
  tagExpensesToChangeOrderCore,
  tagTimeEntriesToChangeOrderCore,
} from "../src/lib/time-expense-core";
import { reconcileMilestoneToQbo } from "../src/lib/quickbooks-payments";
import { querySalesTaxData } from "../src/lib/sales-tax-report";
import { signClientPortalToken } from "../src/lib/client-portal-auth";
import { dateOnlyInTimeZone, endOfDateInTimeZone, resolveCompanyTimeZone } from "../src/lib/company-timezone";

const prisma = new PrismaClient();
const run = `cpco-${process.pid}-${Date.now()}`;

const IDS = {
  user: `${run}-user`,
  clientA: `${run}-client-a`,
  clientB: `${run}-client-b`,
  projectA: `${run}-project-a`,
  projectB: `${run}-project-b`,
  estimateA: `${run}-estimate-a`,
  estimateSplit: `${run}-estimate-split`,
  estimateB: `${run}-estimate-b`,
  invoiceA: `${run}-invoice-a`,
  invoiceSplit: `${run}-invoice-split`,
  invoiceTax: `${run}-invoice-tax`,
  invoiceReconcile: `${run}-invoice-reconcile`,
  invoiceB: `${run}-invoice-b`,
  invoiceGuard: `${run}-invoice-guard`,
  receipt: `${run}-receipt`,
  costPlusZero: `${run}-co-zero`,
  dstCo: `${run}-co-dst`,
  dateOnlyCo: `${run}-co-date-only`,
  splitCo: `${run}-co-split`,
  lumpCo: `${run}-co-lump`,
  deniedCo: `${run}-co-denied`,
  itemA: `${run}-item-a`,
  itemB: `${run}-item-b`,
} as const;

let costPlusId = "";
let costPlusBillingId = "";

function dollars(value: unknown): number {
  return Math.round(Number(value) * 100) / 100;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const billingTestDependencies = {
  logActivity: async () => ({ id: "playwright-mock-activity" }) as never,
  revalidatePath: () => undefined,
};

test.describe.serial("PB-pipeline-004 cost-plus and split change orders", () => {
  test.beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: IDS.user,
        email: `${run}@example.test`,
        name: "Cost Plus Crew",
        status: "ACTIVATED",
        hourlyRate: 100,
        burdenRate: 25,
      },
    });
    await prisma.client.createMany({
      data: [
        { id: IDS.clientA, name: "Cost Plus Client A", initials: "CA", email: `${run}-a@example.test` },
        { id: IDS.clientB, name: "Cost Plus Client B", initials: "CB", email: `${run}-b@example.test` },
      ],
    });
    await prisma.project.create({
      data: {
        id: IDS.projectA,
        name: "Cost Plus Project A",
        clientId: IDS.clientA,
        status: "In Progress",
        crew: { connect: { id: IDS.user } },
      },
    });
    await prisma.project.create({
      data: { id: IDS.projectB, name: "Cost Plus Project B", clientId: IDS.clientB, status: "In Progress" },
    });
    await prisma.estimate.createMany({
      data: [
        {
          id: IDS.estimateA,
          code: `${run}-EST-A`,
          title: "Cost Plus Estimate",
          projectId: IDS.projectA,
          status: "Approved",
          totalAmount: 0,
          balanceDue: 0,
          taxRateName: "Test 10%",
          taxRatePercent: 10,
          taxExempt: false,
        },
        {
          id: IDS.estimateSplit,
          code: `${run}-EST-SPLIT`,
          title: "Split Estimate",
          projectId: IDS.projectA,
          status: "Approved",
          totalAmount: 0,
          balanceDue: 0,
          taxRateName: "Test 8.8%",
          taxRatePercent: 8.8,
          taxExempt: false,
        },
        {
          id: IDS.estimateB,
          code: `${run}-EST-B`,
          title: "Client B Estimate",
          projectId: IDS.projectB,
          status: "Approved",
          totalAmount: 0,
          balanceDue: 0,
          taxExempt: true,
        },
      ],
    });
    await prisma.invoice.createMany({
      data: [
        {
          id: IDS.invoiceA,
          code: `${run}-INV-A`,
          projectId: IDS.projectA,
          clientId: IDS.clientA,
          estimateId: IDS.estimateA,
          status: "Draft",
          subtotal: 0,
          taxRate: 10,
          taxAmount: 0,
          totalAmount: 0,
          balanceDue: 0,
        },
        {
          id: IDS.invoiceSplit,
          code: `${run}-INV-S`,
          projectId: IDS.projectA,
          clientId: IDS.clientA,
          estimateId: IDS.estimateSplit,
          status: "Draft",
          subtotal: 0,
          taxRate: 8.8,
          taxAmount: 0,
          totalAmount: 0,
          balanceDue: 0,
        },
        {
          id: IDS.invoiceTax,
          code: `${run}-INV-TAX`,
          projectId: IDS.projectA,
          clientId: IDS.clientA,
          status: "Paid",
          subtotal: 300,
          taxRate: 10,
          taxAmount: 25,
          totalAmount: 325,
          balanceDue: 0,
        },
        {
          id: IDS.invoiceReconcile,
          code: `${run}-INV-REC`,
          projectId: IDS.projectA,
          clientId: IDS.clientA,
          status: "Draft",
          subtotal: 300,
          taxRate: 10,
          taxAmount: 25,
          totalAmount: 325,
          balanceDue: 325,
        },
        {
          id: IDS.invoiceB,
          code: `${run}-INV-B`,
          projectId: IDS.projectB,
          clientId: IDS.clientB,
          estimateId: IDS.estimateB,
          status: "Draft",
          subtotal: 0,
          taxRate: 0,
          taxAmount: 0,
          totalAmount: 0,
          balanceDue: 0,
        },
        {
          id: IDS.invoiceGuard,
          code: `${run}-INV-GUARD`,
          projectId: IDS.projectA,
          clientId: IDS.clientA,
          status: "Draft",
          subtotal: 100,
          taxRate: 0,
          taxAmount: 0,
          totalAmount: 100,
          balanceDue: 100,
        },
      ],
    });
    await prisma.estimateItem.createMany({
      data: [
        { id: IDS.itemA, estimateId: IDS.estimateA, name: "Estimate A item", quantity: 1, unitCost: 10, total: 10 },
        { id: IDS.itemB, estimateId: IDS.estimateB, name: "Estimate B item", quantity: 1, unitCost: 20, total: 20 },
      ],
    });
    await prisma.projectFile.create({
      data: {
        id: IDS.receipt,
        name: "cost-plus-receipt.pdf",
        url: `https://files.example.test/${run}/receipt.pdf`,
        size: 1234,
        mimeType: "application/pdf",
        visibility: "shared",
        projectId: IDS.projectA,
      },
    });
  });

  test.afterAll(async () => {
    try {
      await prisma.changeOrderBilling.deleteMany({
        where: { changeOrder: { projectId: { in: [IDS.projectA, IDS.projectB] } } },
      });
      await prisma.paymentSchedule.deleteMany({
        where: { invoiceId: { in: [IDS.invoiceA, IDS.invoiceSplit, IDS.invoiceTax, IDS.invoiceReconcile, IDS.invoiceB, IDS.invoiceGuard] } },
      });
      await prisma.timeEntry.deleteMany({ where: { projectId: { in: [IDS.projectA, IDS.projectB] } } });
      await prisma.expense.deleteMany({ where: { estimateId: { in: [IDS.estimateA, IDS.estimateSplit, IDS.estimateB] } } });
      await prisma.changeOrder.deleteMany({ where: { projectId: { in: [IDS.projectA, IDS.projectB] } } });
      await prisma.invoice.deleteMany({ where: { id: { in: [IDS.invoiceA, IDS.invoiceSplit, IDS.invoiceTax, IDS.invoiceReconcile, IDS.invoiceB, IDS.invoiceGuard] } } });
      await prisma.estimateItem.deleteMany({ where: { id: { in: [IDS.itemA, IDS.itemB] } } });
      await prisma.projectFile.deleteMany({ where: { id: IDS.receipt } });
      await prisma.estimate.deleteMany({ where: { id: { in: [IDS.estimateA, IDS.estimateSplit, IDS.estimateB] } } });
      await prisma.project.deleteMany({ where: { id: { in: [IDS.projectA, IDS.projectB] } } });
      await prisma.client.deleteMany({ where: { id: { in: [IDS.clientA, IDS.clientB] } } });
      await prisma.user.deleteMany({ where: { id: IDS.user } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("CPCO1: COST_PLUS draft permits empty items and portal signing permits empty or $0 scope", async ({ page }) => {
    const draft = await createChangeOrderDraft({
      projectId: IDS.projectA,
      estimateId: IDS.estimateA,
      title: "Kitchen exploratory work",
      description: "Open wall and document actuals",
      pricingType: "COST_PLUS",
      markupPercent: 10,
      items: [],
      paymentSchedules: [],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error(draft.error);
    costPlusId = draft.changeOrderId;

    let sentHtml = "";
    const sent = await sendChangeOrderToClientCore(costPlusId, {
      sendNotification: async (_to, _subject, html) => {
        sentHtml = html;
        return { success: true, id: "playwright-mock-email" };
      },
      logActivity: async () => ({ id: "playwright-mock-activity" }) as never,
      revalidatePath: () => undefined,
    });
    expect(sent.success).toBe(true);
    expect(sentHtml).toContain("Billed from actual time and materials");
    expect(sentHtml).toContain("Cost + 10% + tax");
    await page.goto(`/portal/change-orders/${costPlusId}`);
    await page.getByRole("button", { name: "Sign & Approve Change Order" }).click();
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Signature canvas was not visible");
    await page.mouse.move(box.x + 80, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 170, box.y + 70, { steps: 6 });
    await page.mouse.move(box.x + 250, box.y + 110, { steps: 6 });
    await page.mouse.up();
    await page.getByPlaceholder("e.g. John A. Doe").fill("Client A");
    await expect(page.getByRole("button", { name: "Sign & Approve", exact: true })).toBeEnabled();
    const capturedSignature = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL("image/png"));
    const emptyApproval = await approveChangeOrderWithSignature(costPlusId, {
      signatureName: "Client A",
      signatureDataUrl: capturedSignature,
      approvedAt: new Date("2026-07-15T12:00:00.000Z"),
    }, {
      persistSignature: async (value) => ({ url: value, discard: async () => undefined }),
      approveCore: approveChangeOrderCore,
    });
    expect(emptyApproval?.co.status).toBe("Approved");

    await prisma.changeOrder.create({
      data: {
        id: IDS.costPlusZero,
        code: `${run}-CO-ZERO`,
        title: "Zero scope estimate",
        projectId: IDS.projectA,
        estimateId: IDS.estimateA,
        status: "Sent",
        pricingType: "COST_PLUS",
        markupPercent: 10,
        totalAmount: 0,
        balanceDue: 0,
        items: { create: { name: "Unknown until opened", quantity: 1, unitCost: 0, total: 0 } },
      },
    });
    const zeroApproval = await approveChangeOrderCore(IDS.costPlusZero, {
      signatureName: "Client A",
      clientSignatureUrl: "data:image/png;base64,AA==",
      approvedAt: new Date("2026-07-15T12:01:00.000Z"),
    });
    expect(zeroApproval?.co.status).toBe("Approved");
  });

  test("CPCO2: time/expense actuals persist, token drift rejects, and billing freezes a cent-exact snapshot", async () => {
    const time = await createTimeEntryCore({
      projectId: IDS.projectA,
      userId: IDS.user,
      costCodeId: null,
      date: "2026-07-15T16:00:00.000Z",
      durationHours: 4,
      laborCost: 100,
      burdenCost: 25,
      changeOrderId: costPlusId,
      isBillable: true,
      notes: "Mobile-shaped labor with burden",
    }, "Playwright CPCO");
    const expense = await createExpenseCore({
      projectId: IDS.projectA,
      changeOrderId: costPlusId,
      amount: 50,
      vendor: "Fixture Supply",
      date: "2026-07-15",
      description: "Exploratory materials",
      receiptFileId: IDS.receipt,
      isBillable: true,
    }, "Playwright CPCO");

    const persistedTime = await prisma.timeEntry.findUniqueOrThrow({ where: { id: time.id } });
    expect(persistedTime.notes).toBe("Mobile-shaped labor with burden");
    expect(persistedTime.changeOrderId).toBe(costPlusId);
    expect(persistedTime.isBillable).toBe(true);
    const persistedExpense = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(persistedExpense.receiptUrl).toContain("receipt.pdf");
    expect(persistedExpense.estimateId).toBe(IDS.estimateA);

    // Legacy invoice creation stamped only invoicedAt. Those rows must remain
    // permanently ineligible even when invoiceId is null.
    const legacyTime = await prisma.timeEntry.create({
      data: {
        projectId: IDS.projectA,
        userId: IDS.user,
        startTime: new Date("2026-07-15T15:00:00.000Z"),
        durationHours: 1,
        laborCost: 999,
        burdenCost: 0,
        invoicedAt: new Date("2026-07-15T15:30:00.000Z"),
      },
    });
    const legacyExpense = await prisma.expense.create({
      data: {
        estimateId: IDS.estimateA,
        amount: 999,
        date: new Date("2026-07-15T00:00:00.000Z"),
        invoicedAt: new Date("2026-07-15T15:30:00.000Z"),
      },
    });
    expect(await rejectionMessage(tagTimeEntriesToChangeOrderCore({ ids: [legacyTime.id], changeOrderId: costPlusId }, "Playwright"))).toContain("cannot be retagged");
    expect(await rejectionMessage(tagExpensesToChangeOrderCore({ ids: [legacyExpense.id], changeOrderId: costPlusId }, "Playwright"))).toContain("cannot be retagged");
    await prisma.timeEntry.update({ where: { id: legacyTime.id }, data: { changeOrderId: costPlusId, isBillable: true } });
    await prisma.expense.update({ where: { id: legacyExpense.id }, data: { changeOrderId: costPlusId, isBillable: true } });

    const preview = await previewCostPlusChangeOrderCore(costPlusId, { throughDate: "2026-07-15" });
    expect(preview.laborCents).toBe(12_500);
    expect(preview.expenseCents).toBe(5_000);
    expect(preview.markupCents).toBe(1_750);
    expect(preview.taxCents).toBe(1_925);
    expect(preview.totalCents).toBe(21_175);

    const driftExpense = await createExpenseCore({
      projectId: IDS.projectA,
      changeOrderId: costPlusId,
      amount: 1,
      vendor: "Late Vendor",
      date: "2026-07-15",
      description: "Tagged after preview",
      isBillable: true,
    }, "Playwright CPCO");
    const driftMessage = await rejectionMessage(billCostPlusChangeOrderCore(costPlusId, {
      throughDate: "2026-07-15",
      actor: "Playwright CPCO",
      expectedFingerprint: preview.fingerprint,
    }));
    expect(driftMessage).toContain("changed since the preview");
    await prisma.expense.delete({ where: { id: driftExpense.id } });

    const billed = await billCostPlusChangeOrderCore(costPlusId, {
      throughDate: "2026-07-15",
      actor: "Playwright CPCO",
      expectedFingerprint: preview.fingerprint,
    });
    expect(billed.totalCents).toBe(21_175);
    expect(billed.milestoneId).toBeTruthy();
    costPlusBillingId = billed.billingId;

    const billing = await prisma.changeOrderBilling.findUniqueOrThrow({
      where: { id: billed.billingId },
      include: { paymentSchedule: true },
    });
    expect(billing.laborCents).toBe(12_500);
    expect(billing.expenseCents).toBe(5_000);
    expect(billing.markupCents).toBe(1_750);
    expect(billing.taxCents).toBe(1_925);
    expect(billing.totalCents).toBe(21_175);
    expect(dollars(billing.paymentSchedule?.pretaxAmount)).toBe(192.5);
    expect(dollars(billing.paymentSchedule?.taxAmount)).toBe(19.25);
    expect(billing.paymentSchedule?.sourceChangeOrderId).toBe(costPlusId);
    expect(billing.snapshot).toMatchObject({
      timeEntries: [expect.objectContaining({ id: time.id, laborCents: 10_000, burdenCents: 2_500 })],
      expenses: [expect.objectContaining({ id: expense.id, amountCents: 5_000 })],
    });

    const stampedTime = await prisma.timeEntry.findUniqueOrThrow({ where: { id: time.id } });
    const stampedExpense = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(stampedTime.invoiceId).toBe(IDS.invoiceA);
    expect(stampedTime.invoicedAt).not.toBeNull();
    expect(stampedExpense.invoiceId).toBe(IDS.invoiceA);
    expect(stampedExpense.invoicedAt).not.toBeNull();

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: IDS.invoiceA } });
    expect(dollars(invoice.subtotal)).toBe(192.5);
    expect(dollars(invoice.taxAmount)).toBe(19.25);
    expect(dollars(invoice.totalAmount)).toBe(211.75);
    expect(dollars(invoice.balanceDue)).toBe(211.75);
  });

  test("CPCO-F1: CO-backed invoices refuse deletion and re-splitting", async ({ page }) => {
    await prisma.paymentSchedule.create({
      data: {
        invoiceId: IDS.invoiceGuard,
        name: "Frozen change-order billing",
        amount: 100,
        status: "Pending",
        sourceChangeOrderId: costPlusId,
      },
    });
    await page.goto("/projects/" + IDS.projectA + "/invoices/" + IDS.invoiceGuard, { waitUntil: "networkidle" });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.locator("[data-sonner-toast][data-type=\"error\"]").last()).toContainText(/void\/rebill/i);
    expect(await prisma.invoice.findUnique({ where: { id: IDS.invoiceGuard }, select: { id: true } })).not.toBeNull();
    await page.getByRole("button", { name: "Split payments", exact: true }).click();
    await page.getByPlaceholder("e.g. Deposit, Final Payment").fill("Replacement milestone");
    await page.getByPlaceholder("0.00").fill("100");
    await page.getByRole("button", { name: "Apply schedule", exact: true }).click();
    await expect(page.locator("[data-sonner-toast][data-type=\"error\"]").last()).toContainText(/void\/rebill/i);
    expect(await prisma.paymentSchedule.count({ where: { invoiceId: IDS.invoiceGuard, sourceChangeOrderId: costPlusId } })).toBe(1);
  });

  test("CPCO-F2: tagged or billed time rows are excluded from Create Invoice selection", async ({ page }) => {
    const eligible = await prisma.timeEntry.create({ data: { projectId: IDS.projectA, userId: IDS.user, startTime: new Date("2026-07-18T12:00:00.000Z"), durationHours: 1, laborCost: 100, burdenCost: 25 } });
    const tagged = await prisma.timeEntry.create({ data: { projectId: IDS.projectA, userId: IDS.user, changeOrderId: costPlusId, isBillable: true, startTime: new Date("2026-07-18T13:00:00.000Z"), durationHours: 1, laborCost: 100, burdenCost: 25 } });
    const billed = await prisma.timeEntry.create({ data: { projectId: IDS.projectA, userId: IDS.user, startTime: new Date("2026-07-18T14:00:00.000Z"), durationHours: 1, laborCost: 100, burdenCost: 25, invoiceId: IDS.invoiceA, invoicedAt: new Date("2026-07-18T15:00:00.000Z") } });
    await page.goto("/projects/" + IDS.projectA + "/time-expenses", { waitUntil: "networkidle" });
    await expect(page.getByTestId("time-entry-select-" + eligible.id)).toBeEnabled();
    await expect(page.getByTestId("time-entry-select-" + tagged.id)).toBeDisabled();
    await expect(page.getByTestId("time-entry-select-" + billed.id)).toBeDisabled();
    await expect(page.getByTestId("time-entry-select-" + tagged.id)).toHaveAttribute("title", /change-order/i);
    await expect(page.getByTestId("time-entry-select-" + billed.id)).toHaveAttribute("title", /billed/i);
  });

  test("CPCO-F3: date-only actuals use the company-local calendar boundary", async () => {
    await prisma.changeOrder.create({ data: { id: IDS.dateOnlyCo, code: run + "-CO-DATE-ONLY", title: "Date-only boundary", projectId: IDS.projectA, estimateId: IDS.estimateA, status: "Approved", pricingType: "COST_PLUS", markupPercent: 0, totalAmount: 0, balanceDue: 0 } });
    const sameDayTime = await createTimeEntryCore({ projectId: IDS.projectA, userId: IDS.user, costCodeId: null, date: "2026-03-08", durationHours: 1, laborCost: 10, burdenCost: 0, changeOrderId: IDS.dateOnlyCo, isBillable: true }, "Playwright date-only");
    const nextDayTime = await createTimeEntryCore({ projectId: IDS.projectA, userId: IDS.user, costCodeId: null, date: "2026-03-09", durationHours: 1, laborCost: 20, burdenCost: 0, changeOrderId: IDS.dateOnlyCo, isBillable: true }, "Playwright date-only");
    const sameDayExpense = await createExpenseCore({ projectId: IDS.projectA, estimateId: IDS.estimateA, amount: 30, date: "2026-03-08", changeOrderId: IDS.dateOnlyCo, isBillable: true }, "Playwright date-only");
    const nextDayExpense = await createExpenseCore({ projectId: IDS.projectA, estimateId: IDS.estimateA, amount: 40, date: "2026-03-09", changeOrderId: IDS.dateOnlyCo, isBillable: true }, "Playwright date-only");
    const billed = await billCostPlusChangeOrderCore(IDS.dateOnlyCo, { throughDate: "2026-03-08", actor: "Playwright date-only" });
    expect(billed.laborCents).toBe(1_000);
    expect(billed.expenseCents).toBe(3_000);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: sameDayTime.id } })).invoiceId).toBe(IDS.invoiceA);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: nextDayTime.id } })).invoiceId).toBeNull();
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: sameDayExpense.id } })).invoiceId).toBe(IDS.invoiceA);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: nextDayExpense.id } })).invoiceId).toBeNull();
  });

  test("CPCO-F4: manual time creation derives labor and burden from stored crew rates", async () => {
    const entry = await createTimeEntryFromStoredRatesCore({ projectId: IDS.projectA, userId: IDS.user, costCodeId: null, date: "2026-07-19T12:00:00.000Z", durationHours: 2, changeOrderId: costPlusId, isBillable: true }, "Playwright stored rates");
    expect(dollars(entry.laborCost)).toBe(200);
    expect(dollars(entry.burdenCost)).toBe(50);
  });

  test("CPCO-F5: a CO expense rejects a line item from another estimate", async () => {
    const message = await rejectionMessage(createExpenseCore({ projectId: IDS.projectA, estimateId: IDS.estimateB, itemId: IDS.itemB, amount: 1, changeOrderId: costPlusId, isBillable: true }, "Playwright item ownership"));
    expect(message.toLowerCase()).toContain("line item");
  });

  test("CPCO-F6: receipt upload failures cannot leave a stale attachment on the expense form", () => {
    const source = readFileSync(join(process.cwd(), "src/app/projects/[id]/time-expenses/NewExpenseEntryModal.tsx"), "utf8");
    expect(source).toContain("setReceiptFileId(null)");
    expect(source).toContain("receiptUploadError");
    expect(source).toContain("toast.error");
    expect(source).toMatch(/disabled=\{saving \|\| ocrLoading \|\| Boolean\(receiptUploadError\)\}/);
  });

  test("CPCO-G2: receipt uploads lock the picker and ignore stale completions", () => {
    const source = readFileSync(join(process.cwd(), "src/app/projects/[id]/time-expenses/NewExpenseEntryModal.tsx"), "utf8");
    expect(source).toContain("useRef");
    expect(source).toContain("receiptRequestGeneration");
    expect(source).toContain("requestToken");
    expect(source).toContain("isCurrentRequest");
    expect(source).toMatch(/id=\"receipt-upload\"[\s\S]*disabled=\{ocrLoading\}/);
  });

  test("CPCO-G3: time and expense forms default dates from the server-provided company timezone", () => {
    const page = readFileSync(join(process.cwd(), "src/app/projects/[id]/time-expenses/page.tsx"), "utf8");
    const client = readFileSync(join(process.cwd(), "src/app/projects/[id]/time-expenses/TimeExpensesClient.tsx"), "utf8");
    const timeModal = readFileSync(join(process.cwd(), "src/app/projects/[id]/time-expenses/NewTimeEntryModal.tsx"), "utf8");
    const expenseModal = readFileSync(join(process.cwd(), "src/app/projects/[id]/time-expenses/NewExpenseEntryModal.tsx"), "utf8");
    expect(page).toContain("resolveCompanyTimeZone");
    expect(client).toContain("companyTimeZone");
    for (const source of [timeModal, expenseModal]) {
      expect(source).toContain("companyTimeZone");
      expect(source).toContain("Intl.DateTimeFormat");
      expect(source).toMatch(/timeZone[,}]/);
      expect(source).not.toContain("new Date().toISOString().split(\"T\")[0]");
    }
  });
  test("CPCO3: a second cost-plus billing run reports nothing to bill", async () => {
    const message = await rejectionMessage(billCostPlusChangeOrderCore(costPlusId, {
      throughDate: "2026-07-15",
      actor: "Playwright CPCO",
    }));
    expect(message.toLowerCase()).toContain("nothing to bill");
  });

  test("CPCO4: throughDate uses CompanySettings IANA timezone across the spring DST boundary", async () => {
    expect(endOfDateInTimeZone("2026-03-08", "America/Los_Angeles").toISOString()).toBe("2026-03-09T06:59:59.999Z");
    const configuredZone = await resolveCompanyTimeZone();
    const configuredEnd = endOfDateInTimeZone("2026-03-08", configuredZone);
    await prisma.changeOrder.create({
      data: {
        id: IDS.dstCo,
        code: `${run}-CO-DST`,
        title: "DST boundary actuals",
        projectId: IDS.projectA,
        estimateId: IDS.estimateA,
        status: "Approved",
        pricingType: "COST_PLUS",
        markupPercent: 0,
        totalAmount: 0,
        balanceDue: 0,
      },
    });
    const included = await prisma.timeEntry.create({
      data: {
        userId: IDS.user,
        projectId: IDS.projectA,
        changeOrderId: IDS.dstCo,
        isBillable: true,
        startTime: new Date(configuredEnd.getTime() - 30 * 60 * 1000),
        durationHours: 1,
        laborCost: 10,
        burdenCost: 0,
      },
    });
    const excluded = await prisma.timeEntry.create({
      data: {
        userId: IDS.user,
        projectId: IDS.projectA,
        changeOrderId: IDS.dstCo,
        isBillable: true,
        startTime: new Date(configuredEnd.getTime() + 1),
        durationHours: 1,
        laborCost: 20,
        burdenCost: 0,
      },
    });

    const billed = await billCostPlusChangeOrderCore(IDS.dstCo, {
      throughDate: "2026-03-08",
      actor: "Playwright DST",
    });
    expect(billed.laborCents).toBe(1_000);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: included.id } })).invoiceId).toBe(IDS.invoiceA);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: excluded.id } })).invoiceId).toBeNull();
  });

  test("CPCO5: fixed lump billing remains idempotent and uses the canonical invoice", async () => {
    await prisma.changeOrder.create({
      data: {
        id: IDS.lumpCo,
        code: `${run}-CO-LUMP`,
        title: "Fixed lump regression",
        projectId: IDS.projectA,
        estimateId: IDS.estimateSplit,
        status: "Approved",
        pricingType: "FIXED",
        totalAmount: 10,
        balanceDue: 10,
        items: { create: { name: "Fixed lump", quantity: 1, unitCost: 10, total: 10 } },
      },
    });
    const first = await billChangeOrderCore(IDS.lumpCo, billingTestDependencies);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(first.alreadyBilled).toBe(false);
    expect(first.milestones).toHaveLength(1);
    expect(first.milestones[0]).toMatchObject({ pretaxAmount: 10, taxAmount: 0.88, amount: 10.88 });

    const second = await billChangeOrderCore(IDS.lumpCo, billingTestDependencies);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(second.alreadyBilled).toBe(true);
    expect(await prisma.paymentSchedule.count({ where: { sourceChangeOrderId: IDS.lumpCo } })).toBe(1);
  });

  test("CPCO6: fixed split CO creates linked milestones whose pretax and tax sums are cent exact", async () => {
    await prisma.changeOrder.create({
      data: {
        id: IDS.splitCo,
        code: `${run}-CO-SPLIT`,
        title: "Two milestone fixed CO",
        projectId: IDS.projectA,
        estimateId: IDS.estimateSplit,
        status: "Draft",
        pricingType: "FIXED",
        totalAmount: 100.01,
        balanceDue: 100.01,
        items: { create: { name: "Fixed work", quantity: 1, unitCost: 100.01, total: 100.01 } },
      },
    });
    await updateChangeOrderCore(IDS.splitCo, {
      paymentSchedules: [
        { name: "Start", amount: 50, dueDate: "2026-07-20", order: 0 },
        { name: "Finish", amount: 50.01, dueDate: "2026-08-05", order: 1 },
      ],
    });
    await prisma.changeOrder.update({ where: { id: IDS.splitCo }, data: { status: "Approved" } });

    const result = await billChangeOrderCore(IDS.splitCo, billingTestDependencies);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.alreadyBilled).toBe(false);
    expect(result.milestones).toHaveLength(2);

    const rows = await prisma.paymentSchedule.findMany({
      where: { sourceChangeOrderId: IDS.splitCo },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.sourceCoScheduleId)).size).toBe(2);
    expect(rows.every((row) => !!row.sourceCoScheduleId)).toBe(true);
    const timeZone = await resolveCompanyTimeZone();
    expect(rows.find((row) => row.name.includes("Start"))?.dueDate?.getTime()).toBe(dateOnlyInTimeZone("2026-07-20", timeZone).getTime());
    expect(rows.find((row) => row.name.includes("Finish"))?.dueDate?.getTime()).toBe(dateOnlyInTimeZone("2026-08-05", timeZone).getTime());
    expect(Math.round(rows.reduce((sum, row) => sum + Number(row.pretaxAmount), 0) * 100)).toBe(10_001);
    expect(Math.round(rows.reduce((sum, row) => sum + Number(row.taxAmount), 0) * 100)).toBe(880);
    expect(Math.round(rows.reduce((sum, row) => sum + Number(row.amount), 0) * 100)).toBe(10_881);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: IDS.invoiceSplit } });
    expect(dollars(invoice.subtotal)).toBe(110.01);
    expect(dollars(invoice.taxAmount)).toBe(9.68);
    expect(dollars(invoice.totalAmount)).toBe(119.69);
  });

  test("CPCO7 amendment A: mixed cash-basis rows use stored CO tax plus residual invoice tax exactly once", async () => {
    await prisma.paymentSchedule.createMany({
      data: [
        {
          invoiceId: IDS.invoiceTax,
          name: "Base milestone",
          amount: 110,
          status: "Paid",
          paymentDate: new Date("2026-07-10T12:00:00.000Z"),
          paidAt: new Date("2026-07-10T12:00:00.000Z"),
          paymentMethod: "check",
        },
        {
          invoiceId: IDS.invoiceTax,
          name: "CO milestone different rate",
          amount: 215,
          pretaxAmount: 200,
          taxAmount: 15,
          status: "Paid",
          paymentDate: new Date("2026-07-11T12:00:00.000Z"),
          paidAt: new Date("2026-07-11T12:00:00.000Z"),
          paymentMethod: "check",
        },
      ],
    });

    const report = await querySalesTaxData({
      basis: "cash",
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
      projectId: IDS.projectA,
    });
    const rows = report.rows.filter((row) => row.documentCode === `${run}-INV-TAX`);
    expect(rows).toHaveLength(2);
    expect(dollars(rows.reduce((sum, row) => sum + row.tax, 0))).toBe(25);
    expect(rows.find((row) => row.gross === 215)).toMatchObject({ tax: 15, taxRate: 7.5, isExempt: false });
    expect(rows.find((row) => row.gross === 110)).toMatchObject({ tax: 10, taxRate: 10, isExempt: false });
  });

  test("CPCO8 amendment B: split rows reject QBO reconciliation and non-split reconciliation preserves stored CO tax", async () => {
    const [base, stored] = await Promise.all([
      prisma.paymentSchedule.create({
        data: { invoiceId: IDS.invoiceReconcile, name: "Base", amount: 110, status: "Pending" },
      }),
      prisma.paymentSchedule.create({
        data: {
          invoiceId: IDS.invoiceReconcile,
          name: "Frozen CO",
          amount: 215,
          pretaxAmount: 200,
          taxAmount: 15,
          status: "Pending",
        },
      }),
    ]);

    const rejected = await reconcileMilestoneToQbo(stored.id, 220);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("Void the QuickBooks invoice and rebill it in ProBuild");
    expect(dollars((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: stored.id } })).amount)).toBe(215);

    const reconciled = await reconcileMilestoneToQbo(base.id, 121);
    expect(reconciled.ok).toBe(true);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: IDS.invoiceReconcile } });
    expect(dollars(invoice.totalAmount)).toBe(336);
    expect(dollars(invoice.subtotal)).toBe(310);
    expect(dollars(invoice.taxAmount)).toBe(26);
    expect(dollars(invoice.balanceDue)).toBe(336);
  });

  test("CPCO9 amendments C/D: backup PDF allows staff and matching client token, rejects cross-client token", async ({ page }) => {
    const staff = await page.request.get(`/api/pdf/change-orders/${costPlusId}/billing/${costPlusBillingId}`);
    expect(staff.status()).toBe(200);
    expect(staff.headers()["content-type"]).toContain("application/pdf");

    const clientAToken = await signClientPortalToken(IDS.clientA, `${run}-a@example.test`);
    const anonymous = await request.newContext({
      baseURL: "http://localhost:3000",
      storageState: { cookies: [], origins: [] },
    });
    const portal = await anonymous.get(
      `/api/pdf/change-orders/${costPlusId}/billing/${costPlusBillingId}?token=${encodeURIComponent(clientAToken)}`,
    );
    expect(portal.status()).toBe(200);
    expect((await anonymous.get(`/api/pdf/change-orders/${costPlusId}/billing/${costPlusBillingId}`)).status()).toBe(404);
    expect((await anonymous.get(
      `/api/pdf/change-orders/${IDS.deniedCo}/billing/${costPlusBillingId}?token=${encodeURIComponent(clientAToken)}`,
    )).status()).toBe(404);

    await prisma.changeOrder.create({
      data: {
        id: IDS.deniedCo,
        code: `${run}-CO-DENIED`,
        title: "Client B billing",
        projectId: IDS.projectB,
        estimateId: IDS.estimateB,
        status: "Approved",
        pricingType: "COST_PLUS",
        markupPercent: 10,
        totalAmount: 0,
        balanceDue: 0,
      },
    });
    const bSchedule = await prisma.paymentSchedule.create({
      data: {
        invoiceId: IDS.invoiceB,
        name: "Client B T&M",
        amount: 11,
        pretaxAmount: 10,
        taxAmount: 1,
        sourceChangeOrderId: IDS.deniedCo,
      },
    });
    const bBilling = await prisma.changeOrderBilling.create({
      data: {
        changeOrderId: IDS.deniedCo,
        paymentScheduleId: bSchedule.id,
        label: "T&M through 2026-07-15",
        laborCents: 1_000,
        expenseCents: 0,
        markupCents: 0,
        taxCents: 100,
        totalCents: 1_100,
        snapshot: { timeEntries: [], expenses: [] },
        createdBy: "Playwright",
      },
    });
    const denied = await anonymous.get(
      `/api/pdf/change-orders/${IDS.deniedCo}/billing/${bBilling.id}?token=${encodeURIComponent(clientAToken)}`,
    );
    expect(denied.status()).toBe(404);
    await anonymous.dispose();
  });

  test("CPCO10: MCP is v1.9.0 and exposes the required voice-first tools and UI copy", () => {
    const mcp = readFileSync(join(process.cwd(), "src/app/api/mcp/[transport]/route.ts"), "utf8");
    expect(mcp).toContain('version: "1.9.0"');
    for (const tool of ["list_change_orders", "log_time", "log_expense", "bill_change_order"]) {
      expect(mcp).toContain(`"${tool}"`);
    }
    expect(mcp).toContain("fingerprint");
    expect(mcp).toContain("throughDate");
    expect(findCrewMatches([
      { id: "a", name: "Alex Rivera", email: "alex@example.test" },
      { id: "b", name: "Alex Smith", email: "smith@example.test" },
    ], "Rivera")).toHaveLength(1);
    expect(findCrewMatches([
      { id: "a", name: "Alex Rivera", email: "alex@example.test" },
      { id: "b", name: "Alex Smith", email: "smith@example.test" },
    ], "Alex")).toHaveLength(2);
    expect(calculateCrewTimeCosts(4, 100, 25)).toEqual({ laborCost: 400, burdenCost: 100 });
    expect(calculateCrewTimeCosts(4, 100, 25, 12.34)).toEqual({ laborCost: 400, burdenCost: 12.34 });

    const editor = readFileSync(join(process.cwd(), "src/app/projects/[id]/change-orders/[coId]/ChangeOrderEditor.tsx"), "utf8");
    expect(editor).toContain("Cost plus");
    expect(editor).toContain("Actuals");
    expect(editor).toContain("Bill actuals");
    const timeTab = readFileSync(join(process.cwd(), "src/app/projects/[id]/time-expenses/TimeTab.tsx"), "utf8");
    const expenseTab = readFileSync(join(process.cwd(), "src/app/projects/[id]/time-expenses/ExpensesTab.tsx"), "utf8");
    expect(timeTab).toContain("Change order");
    expect(expenseTab).toContain("Change order");
  });
});
