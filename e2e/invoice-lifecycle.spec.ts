import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  executeInvoiceSendAttempt,
  markInvoiceViewedCore,
  sweepStrandedSendAttempts,
} from "../src/lib/invoice-lifecycle";

/**
 * Invoice lifecycle regression net.
 *
 * These tests call the durable cores directly against CI's disposable Postgres.
 * Local execution is intentionally blocked by e2e/data.setup.ts when .env points
 * at Supabase; CI supplies the throwaway database and runs the suite.
 */

const prisma = new PrismaClient();

const IDS = {
  client: "invoice-lifecycle-client",
  project: "invoice-lifecycle-project",
  failedInvoice: "invoice-lifecycle-failed-invoice",
  failedMilestone: "invoice-lifecycle-failed-milestone",
  resumeInvoice: "invoice-lifecycle-resume-invoice",
  resumeMilestone: "invoice-lifecycle-resume-milestone",
  otherMilestone: "invoice-lifecycle-other-milestone",
  atomicInvoice: "invoice-lifecycle-atomic-invoice",
  atomicMilestone: "invoice-lifecycle-atomic-milestone",
};

function request(input: {
  invoiceId: string;
  milestoneId: string;
  sendRequestId: string;
  amount?: number;
}) {
  return {
    invoiceId: input.invoiceId,
    recipient: "lifecycle@example.com",
    sendRequestId: input.sendRequestId,
    milestones: [{ id: input.milestoneId, name: "Progress draw", amount: input.amount ?? 1_000 }],
    actorName: "Lifecycle E2E",
    subject: "Payment requested",
    html: "<p>Payment requested</p>",
    emailOptions: { fromName: "Golden Touch Remodeling" },
  };
}

test.describe.serial("Invoice lifecycle: send attempts and view projection", () => {
  test.beforeAll(async () => {
    await prisma.client.create({
      data: { id: IDS.client, name: "Invoice Lifecycle Client", initials: "ILC" },
    });
    await prisma.project.create({
      data: { id: IDS.project, name: "Invoice Lifecycle Project", clientId: IDS.client },
    });

    for (const invoice of [
      { id: IDS.failedInvoice, code: "INV-LIFE-FAIL" },
      { id: IDS.resumeInvoice, code: "INV-LIFE-RESUME" },
      { id: IDS.atomicInvoice, code: "INV-LIFE-ATOMIC" },
    ]) {
      await prisma.invoice.create({
        data: {
          ...invoice,
          projectId: IDS.project,
          clientId: IDS.client,
          status: "Issued",
          issueDate: new Date("2026-07-01T12:00:00.000Z"),
          totalAmount: invoice.id === IDS.resumeInvoice ? 1_500 : 1_000,
          balanceDue: invoice.id === IDS.resumeInvoice ? 1_500 : 1_000,
        },
      });
    }

    await prisma.paymentSchedule.createMany({
      data: [
        { id: IDS.failedMilestone, invoiceId: IDS.failedInvoice, name: "Failed draw", amount: 1_000 },
        { id: IDS.resumeMilestone, invoiceId: IDS.resumeInvoice, name: "Resume draw", amount: 1_000 },
        { id: IDS.otherMilestone, invoiceId: IDS.resumeInvoice, name: "Other draw", amount: 500 },
        { id: IDS.atomicMilestone, invoiceId: IDS.atomicInvoice, name: "Atomic draw", amount: 1_000 },
      ],
    });
  });

  test.afterAll(async () => {
    await prisma.activityLog.deleteMany({
      where: { entityId: { in: [IDS.failedInvoice, IDS.resumeInvoice, IDS.atomicInvoice] } },
    });
    await prisma.emailEvent.deleteMany({ where: { resendEmailId: { startsWith: "life_" } } });
    await prisma.invoiceViewEvent.deleteMany({
      where: { invoiceId: { in: [IDS.failedInvoice, IDS.resumeInvoice, IDS.atomicInvoice] } },
    });
    await prisma.sendAttemptMilestone.deleteMany({
      where: { paymentScheduleId: { in: [IDS.failedMilestone, IDS.resumeMilestone, IDS.otherMilestone, IDS.atomicMilestone] } },
    });
    await prisma.sendAttempt.deleteMany({
      where: { invoiceId: { in: [IDS.failedInvoice, IDS.resumeInvoice, IDS.atomicInvoice] } },
    });
    await prisma.paymentSchedule.deleteMany({
      where: { invoiceId: { in: [IDS.failedInvoice, IDS.resumeInvoice, IDS.atomicInvoice] } },
    });
    await prisma.invoice.deleteMany({
      where: { id: { in: [IDS.failedInvoice, IDS.resumeInvoice, IDS.atomicInvoice] } },
    });
    await prisma.project.deleteMany({ where: { id: IDS.project } });
    await prisma.client.deleteMany({ where: { id: IDS.client } });
    await prisma.$disconnect();
  });

  test("mailer failure finalizes the attempt as failed and stamps nothing", async () => {
    const result = await executeInvoiceSendAttempt(
      request({
        invoiceId: IDS.failedInvoice,
        milestoneId: IDS.failedMilestone,
        sendRequestId: "invoice-lifecycle-mailer-failure",
      }),
      { sendEmail: async () => ({ success: false }) },
    );

    expect(result.status).toBe("failed");
    const attempt = await prisma.sendAttempt.findUniqueOrThrow({
      where: { sendRequestId: "invoice-lifecycle-mailer-failure" },
    });
    expect(attempt.status).toBe("failed");
    expect(attempt.lastError).toContain("provider");
    expect(attempt.sentAt).toBeNull();

    const milestone = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.failedMilestone } });
    expect(milestone.qbInvoiceSentAt).toBeNull();
    expect(await prisma.activityLog.count({
      where: { entityId: IDS.failedInvoice, action: "sent_invoice" },
    })).toBe(0);
  });

  test("provider success, crash, portal view, and resume reuse one attempt and recover the view projection", async () => {
    const acceptedByKey = new Map<string, { id: string; acceptedAt: Date }>();
    let providerCalls = 0;
    let providerAcceptances = 0;
    const sendEmail = async (
      _to: string,
      _subject: string,
      _html: string,
      _attachments: undefined,
      options: { idempotencyKey?: string },
    ) => {
      providerCalls += 1;
      const key = options.idempotencyKey!;
      let accepted = acceptedByKey.get(key);
      if (!accepted) {
        providerAcceptances += 1;
        accepted = { id: "life_resume_email", acceptedAt: new Date("2026-07-20T18:00:00.000Z") };
        acceptedByKey.set(key, accepted);
      }
      return { success: true as const, ...accepted };
    };

    await expect(executeInvoiceSendAttempt(
      request({
        invoiceId: IDS.resumeInvoice,
        milestoneId: IDS.resumeMilestone,
        sendRequestId: "invoice-lifecycle-resume",
      }),
      {
        sendEmail,
        afterProviderAccepted: async () => {
          throw new Error("simulated process death after provider acceptance");
        },
      },
    )).rejects.toThrow("simulated process death");

    const stranded = await prisma.sendAttempt.findUniqueOrThrow({
      where: { sendRequestId: "invoice-lifecycle-resume" },
    });
    expect(stranded.status).toBe("sending");
    expect(stranded.sentAt).toBeNull();

    const viewedAt = new Date(Math.max(Date.now(), stranded.createdAt.getTime() + 1_000));
    const view = await markInvoiceViewedCore(IDS.resumeInvoice, IDS.client, {
      now: () => viewedAt,
    });
    expect(view.firstView).toBe(true);
    expect((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.resumeMilestone } })).firstViewedAt).toBeNull();

    const resumed = await executeInvoiceSendAttempt(
      request({
        invoiceId: IDS.resumeInvoice,
        milestoneId: IDS.resumeMilestone,
        sendRequestId: "invoice-lifecycle-resume",
      }),
      { sendEmail },
    );

    expect(resumed.attemptId).toBe(stranded.id);
    expect(resumed.status).toBe("sent");
    expect(providerCalls).toBe(2);
    expect(providerAcceptances).toBe(1);

    const finalized = await prisma.sendAttempt.findUniqueOrThrow({ where: { id: stranded.id } });
    expect(finalized.sentAt?.toISOString()).toBe("2026-07-20T18:00:00.000Z");
    expect(finalized.resendEmailId).toBe("life_resume_email");
    const projected = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.resumeMilestone } });
    expect(projected.firstViewedAt?.toISOString()).toBe(viewedAt.toISOString());
    expect(projected.lastViewedAt?.toISOString()).toBe(viewedAt.toISOString());
  });

  test("the same sendRequestId cannot resume a changed milestone payload", async () => {
    await expect(executeInvoiceSendAttempt(
      request({
        invoiceId: IDS.resumeInvoice,
        milestoneId: IDS.otherMilestone,
        sendRequestId: "invoice-lifecycle-resume",
        amount: 500,
      }),
      { sendEmail: async () => ({ success: true, id: "life_must_not_send" }) },
    )).rejects.toThrow("sendRequestId reused with a different payload");
  });

  test("repeat views append events and keep firstViewedAt stable", async () => {
    const before = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.resumeMilestone } });
    const later = new Date((before.firstViewedAt?.getTime() ?? Date.now()) + 60_000);
    const second = await markInvoiceViewedCore(IDS.resumeInvoice, IDS.client, { now: () => later });

    expect(second.firstView).toBe(false);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: IDS.resumeInvoice } });
    expect(invoice.viewCount).toBe(2);
    expect(invoice.viewedAt?.toISOString()).toBe(before.firstViewedAt?.toISOString());
    expect(invoice.lastViewedAt?.toISOString()).toBe(later.toISOString());
    const milestone = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.resumeMilestone } });
    expect(milestone.firstViewedAt?.toISOString()).toBe(before.firstViewedAt?.toISOString());
    expect(milestone.lastViewedAt?.toISOString()).toBe(later.toISOString());
    expect(await prisma.invoiceViewEvent.count({ where: { invoiceId: IDS.resumeInvoice } })).toBe(2);
    expect(await prisma.activityLog.count({
      where: { entityId: IDS.resumeInvoice, action: "viewed_invoice" },
    })).toBe(2);
  });

  test("a mid-transaction failure leaves the view event and every projection absent", async () => {
    const attempt = await prisma.sendAttempt.create({
      data: {
        invoiceId: IDS.atomicInvoice,
        recipient: "lifecycle@example.com",
        sendRequestId: "invoice-lifecycle-atomic-attempt",
        payloadHash: "atomic-payload",
        status: "sent",
        sentAt: new Date("2026-07-20T17:00:00.000Z"),
        resendEmailId: "life_atomic_email",
        milestones: { create: { paymentScheduleId: IDS.atomicMilestone } },
      },
    });
    expect(attempt.id).toBeTruthy();

    await expect(markInvoiceViewedCore(IDS.atomicInvoice, IDS.client, {
      now: () => new Date("2026-07-20T18:00:00.000Z"),
      beforeActivityLog: async () => { throw new Error("injected view transaction failure"); },
    })).rejects.toThrow("injected view transaction failure");

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: IDS.atomicInvoice } });
    const milestone = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.atomicMilestone } });
    expect(invoice.viewedAt).toBeNull();
    expect(invoice.lastViewedAt).toBeNull();
    expect(invoice.viewCount).toBe(0);
    expect(milestone.firstViewedAt).toBeNull();
    expect(milestone.lastViewedAt).toBeNull();
    expect(await prisma.invoiceViewEvent.count({ where: { invoiceId: IDS.atomicInvoice } })).toBe(0);
    expect(await prisma.activityLog.count({
      where: { entityId: IDS.atomicInvoice, action: "viewed_invoice" },
    })).toBe(0);
  });

  test("stranded sending attempts are swept to failed/interrupted", async () => {
    await prisma.sendAttempt.create({
      data: {
        invoiceId: IDS.atomicInvoice,
        recipient: "lifecycle@example.com",
        sendRequestId: "invoice-lifecycle-stranded",
        payloadHash: "stranded-payload",
        status: "sending",
        createdAt: new Date("2026-07-20T16:00:00.000Z"),
        milestones: { create: { paymentScheduleId: IDS.atomicMilestone } },
      },
    });

    const swept = await sweepStrandedSendAttempts({ now: new Date("2026-07-20T16:11:00.000Z") });
    expect(swept).toBe(1);
    const attempt = await prisma.sendAttempt.findUniqueOrThrow({
      where: { sendRequestId: "invoice-lifecycle-stranded" },
    });
    expect(attempt.status).toBe("failed");
    expect(attempt.lastError).toBe("interrupted");
  });
});
