import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  recordAlignmentFinding,
  resolveAlignmentFindingsWithEvidence,
  runInvoiceAlignmentAudit,
} from "../src/lib/invoice-alignment";

const prisma = new PrismaClient();
const IDS = {
  client: "invoice-alignment-client",
  project: "invoice-alignment-project",
  invoice: "invoice-alignment-invoice",
  milestone: "invoice-alignment-milestone",
};

const fakeTokens = async () => ({ accessToken: "test", refreshToken: "test", realmId: "test-realm" });

test.describe.serial("Invoice lifecycle: alignment findings", () => {
  test.beforeAll(async () => {
    await prisma.client.create({ data: { id: IDS.client, name: "Alignment Client", initials: "ALC" } });
    await prisma.project.create({ data: { id: IDS.project, name: "Alignment Project", clientId: IDS.client } });
    await prisma.invoice.create({
      data: {
        id: IDS.invoice,
        code: "INV-ALIGNMENT",
        projectId: IDS.project,
        clientId: IDS.client,
        status: "Issued",
        issueDate: new Date("2026-07-01T12:00:00.000Z"),
        totalAmount: 100,
        balanceDue: 100,
      },
    });
    await prisma.paymentSchedule.create({
      data: { id: IDS.milestone, invoiceId: IDS.invoice, name: "Alignment draw", amount: 100, qbInvoiceId: "alignment-qbo-1" },
    });
  });

  test.afterAll(async () => {
    await prisma.alignmentFinding.deleteMany({ where: { paymentSchedule: { invoice: { projectId: IDS.project } } } });
    await prisma.paymentSchedule.deleteMany({ where: { invoice: { projectId: IDS.project } } });
    await prisma.invoice.deleteMany({ where: { projectId: IDS.project } });
    await prisma.project.deleteMany({ where: { id: IDS.project } });
    await prisma.client.deleteMany({ where: { id: IDS.client } });
    await prisma.$disconnect();
  });

  test("finding lifecycle inserts, refreshes, resolves, and reopens the same row", async () => {
    await recordAlignmentFinding(IDS.milestone, "alignment-qbo-1", "run-1", { kind: "amount_mismatch", detail: { qbo: 99 } });
    const created = await prisma.alignmentFinding.findFirstOrThrow({ where: { paymentScheduleId: IDS.milestone, kind: "amount_mismatch" } });

    await recordAlignmentFinding(IDS.milestone, "alignment-qbo-1", "run-2", { kind: "amount_mismatch", detail: { qbo: 98 } });
    const refreshed = await prisma.alignmentFinding.findUniqueOrThrow({ where: { id: created.id } });
    expect(refreshed.reopenedCount).toBe(0);
    expect(refreshed.resolvedAt).toBeNull();

    await resolveAlignmentFindingsWithEvidence(IDS.milestone, "alignment-qbo-1", "run-3", new Set());
    expect((await prisma.alignmentFinding.findUniqueOrThrow({ where: { id: created.id } })).resolvedAt).not.toBeNull();

    await recordAlignmentFinding(IDS.milestone, "alignment-qbo-1", "run-4", { kind: "amount_mismatch", detail: { qbo: 97 } });
    const reopened = await prisma.alignmentFinding.findUniqueOrThrow({ where: { id: created.id } });
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.reopenedCount).toBe(1);
  });

  test("a probe error leaves existing findings untouched", async () => {
    const before = await prisma.alignmentFinding.findFirstOrThrow({ where: { paymentScheduleId: IDS.milestone, kind: "amount_mismatch" } });
    const result = await runInvoiceAlignmentAudit({
      getTokens: fakeTokens,
      probeInvoice: async () => ({ state: "error" as const, status: 503 }),
    });
    expect(result.transientErrors).toBeGreaterThan(0);
    const after = await prisma.alignmentFinding.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.resolvedAt).toBeNull();
    expect(after.lastRunId).toBe(before.lastRunId);
  });

  test("the audit checks every nonterminal mapping beyond the former 250-row cap", async () => {
    test.setTimeout(120_000);
    const invoices = Array.from({ length: 251 }, (_, index) => ({
      id: `invoice-alignment-bulk-${index}`,
      code: `INV-ALIGN-${String(index).padStart(3, "0")}`,
      projectId: IDS.project,
      clientId: IDS.client,
      status: "Issued",
      issueDate: new Date("2026-07-01T12:00:00.000Z"),
      totalAmount: 100,
      balanceDue: 100,
    }));
    await prisma.invoice.createMany({ data: invoices });
    await prisma.paymentSchedule.createMany({
      data: invoices.map((invoice, index) => ({
        id: `invoice-alignment-bulk-milestone-${index}`,
        invoiceId: invoice.id,
        name: "Bulk alignment draw",
        amount: 100,
        qbInvoiceId: `alignment-qbo-bulk-${index}`,
      })),
    });

    const result = await runInvoiceAlignmentAudit({
      getTokens: fakeTokens,
      probeInvoice: async () => ({
        state: "ok" as const,
        balance: 100,
        total: 100,
        paymentTxnIds: [],
        emailStatus: null,
      }),
    });
    expect(result.checked).toBeGreaterThanOrEqual(252);
  });
});
