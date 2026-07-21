import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  applyEmailEventTx,
  executeInvoiceSendAttempt,
  markInvoiceViewedCore,
  replayPendingEmailEventsForAttemptTx,
  sweepStrandedSendAttempts,
} from "../src/lib/invoice-lifecycle";
import { drainEmailEvents } from "../src/lib/invoice-event-workers";

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

  test("a stale retry cannot overwrite another caller's completed retry", async () => {
    const input = request({
      invoiceId: IDS.failedInvoice,
      milestoneId: IDS.failedMilestone,
      sendRequestId: "invoice-lifecycle-mailer-failure",
    });
    let paused!: () => void;
    let release!: () => void;
    const reachedRestart = new Promise<void>(resolve => { paused = resolve; });
    const holdRestart = new Promise<void>(resolve => { release = resolve; });
    let providerCalls = 0;
    const sendEmail = async () => {
      providerCalls += 1;
      return { success: true as const, id: "life_retry_race_email", acceptedAt: new Date("2026-07-20T17:15:00.000Z") };
    };

    const staleRetry = executeInvoiceSendAttempt(input, {
      sendEmail,
      beforeRestartAttempt: async () => {
        paused();
        await holdRestart;
      },
    });
    await reachedRestart;
    const winningRetry = await executeInvoiceSendAttempt(input, { sendEmail });
    release();
    const staleResult = await staleRetry;

    expect(winningRetry).toMatchObject({ status: "sent", resumed: false });
    expect(staleResult).toMatchObject({ status: "sent", resumed: true });
    expect(providerCalls).toBe(1);
    const attempt = await prisma.sendAttempt.findUniqueOrThrow({ where: { sendRequestId: input.sendRequestId } });
    expect(attempt.status).toBe("sent");
    expect(await prisma.activityLog.count({
      where: { entityId: IDS.failedInvoice, action: "sent_invoice", metadata: { contains: attempt.id } },
    })).toBe(1);
  });

  test("a late concurrent provider failure cannot overwrite a finalized success", async () => {
    let releaseFailure!: () => void;
    const successCommitted = new Promise<void>(resolve => { releaseFailure = resolve; });
    const input = request({
      invoiceId: IDS.failedInvoice,
      milestoneId: IDS.failedMilestone,
      sendRequestId: "invoice-lifecycle-concurrent-finalize",
    });
    const lateFailure = executeInvoiceSendAttempt(input, {
      sendEmail: async () => {
        await successCommitted;
        return { success: false as const };
      },
    });

    const success = await executeInvoiceSendAttempt(input, {
      sendEmail: async () => ({
        success: true as const,
        id: "life_concurrent_finalize_email",
        acceptedAt: new Date("2026-07-20T17:30:00.000Z"),
      }),
    });
    releaseFailure();
    const failureResult = await lateFailure;

    expect(success).toMatchObject({ status: "sent", resumed: false });
    expect(failureResult).toMatchObject({ status: "sent", resumed: true });
    const attempt = await prisma.sendAttempt.findUniqueOrThrow({ where: { sendRequestId: input.sendRequestId } });
    expect(attempt.status).toBe("sent");
    expect(attempt.resendEmailId).toBe("life_concurrent_finalize_email");
    expect(await prisma.activityLog.count({
      where: { entityId: IDS.failedInvoice, action: "sent_invoice", metadata: { contains: attempt.id } },
    })).toBe(1);
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

    await prisma.emailEvent.create({
      data: {
        svixId: "life_svix_before_finalization",
        resendEmailId: "life_resume_email",
        type: "email.delivered",
        occurredAt: new Date("2026-07-20T18:00:05.000Z"),
        payload: {},
      },
    });
    const unmatchedDrain = await drainEmailEvents(50);
    expect(unmatchedDrain.processed).toBe(0);
    expect((await prisma.emailEvent.findUniqueOrThrow({ where: { svixId: "life_svix_before_finalization" } })).attempts).toBe(0);

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
    expect(resumed.status).toBe("delivered");
    expect(providerCalls).toBe(2);
    expect(providerAcceptances).toBe(1);

    const finalized = await prisma.sendAttempt.findUniqueOrThrow({ where: { id: stranded.id } });
    expect(finalized.sentAt?.toISOString()).toBe("2026-07-20T18:00:00.000Z");
    expect(finalized.resendEmailId).toBe("life_resume_email");
    expect(finalized.status).toBe("delivered");
    expect((await prisma.emailEvent.findUniqueOrThrow({ where: { svixId: "life_svix_before_finalization" } })).attempts).toBe(0);
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

  test("duplicate provider ids are deduped and event recency cannot regress the latest send", async () => {
    const duplicate = {
      svixId: "life_svix_duplicate",
      resendEmailId: "life_resume_email",
      type: "email.delivered",
      occurredAt: new Date("2026-07-20T18:00:06.000Z"),
      payload: {},
    };
    const inserted = await prisma.emailEvent.createMany({ data: [duplicate, duplicate], skipDuplicates: true });
    expect(inserted.count).toBe(1);

    const bounced = await prisma.emailEvent.create({
      data: {
        svixId: "life_svix_bounced",
        resendEmailId: "life_resume_email",
        type: "email.bounced",
        occurredAt: new Date("2026-07-20T18:00:10.000Z"),
        payload: {},
      },
    });
    await prisma.$transaction(tx => applyEmailEventTx(tx, bounced));

    const staleHealthy = await prisma.emailEvent.create({
      data: {
        svixId: "life_svix_stale_healthy",
        resendEmailId: "life_resume_email",
        type: "email.delivery_delayed",
        occurredAt: new Date("2026-07-20T18:00:02.000Z"),
        payload: {},
      },
    });
    await prisma.$transaction(tx => applyEmailEventTx(tx, staleHealthy));
    expect((await prisma.sendAttempt.findUniqueOrThrow({ where: { resendEmailId: "life_resume_email" } })).status).toBe("bounced");

    const latest = await executeInvoiceSendAttempt(
      request({
        invoiceId: IDS.resumeInvoice,
        milestoneId: IDS.resumeMilestone,
        sendRequestId: "invoice-lifecycle-latest-send",
      }),
      { sendEmail: async () => ({ success: true, id: "life_latest_email", acceptedAt: new Date("2026-07-20T18:01:00.000Z") }) },
    );
    expect(latest.status).toBe("sent");

    const lateOldBounce = await prisma.emailEvent.create({
      data: {
        svixId: "life_svix_late_old_bounce",
        resendEmailId: "life_resume_email",
        type: "email.bounced",
        occurredAt: new Date("2026-07-20T18:02:00.000Z"),
        payload: {},
      },
    });
    await prisma.$transaction(tx => applyEmailEventTx(tx, lateOldBounce));
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: IDS.resumeInvoice } });
    expect(invoice.emailStatus).toBe("sent");
    expect(invoice.emailBouncedAt).toBeNull();
  });

  test("concurrent events for one invoice serialize and roll up once per event", async () => {
    const delivered = await prisma.emailEvent.create({
      data: {
        svixId: "life_svix_concurrent_delivered",
        resendEmailId: "life_latest_email",
        type: "email.delivered",
        occurredAt: new Date("2026-07-20T18:03:00.000Z"),
        payload: {},
      },
    });
    const bounced = await prisma.emailEvent.create({
      data: {
        svixId: "life_svix_concurrent_bounced",
        resendEmailId: "life_latest_email",
        type: "email.bounced",
        occurredAt: new Date("2026-07-20T18:03:01.000Z"),
        payload: {},
      },
    });

    await Promise.all([
      prisma.$transaction(tx => applyEmailEventTx(tx, delivered)),
      prisma.$transaction(tx => applyEmailEventTx(tx, bounced)),
    ]);

    expect((await prisma.sendAttempt.findUniqueOrThrow({ where: { resendEmailId: "life_latest_email" } })).status).toBe("bounced");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: IDS.resumeInvoice } })).emailStatus).toBe("bounced");
    expect(await prisma.activityLog.count({
      where: { entityId: IDS.resumeInvoice, metadata: { contains: "life_latest_email" } },
    })).toBe(2);
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

  test("finalization replay racing the worker applies and logs an event once", async () => {
    await prisma.sendAttempt.create({
      data: {
        invoiceId: IDS.atomicInvoice,
        recipient: "lifecycle@example.com",
        sendRequestId: "invoice-lifecycle-replay-race",
        payloadHash: "replay-race-payload",
        status: "sent",
        sentAt: new Date("2026-07-20T19:00:00.000Z"),
        resendEmailId: "life_replay_race_email",
        milestones: { create: { paymentScheduleId: IDS.atomicMilestone } },
      },
    });
    await prisma.emailEvent.create({
      data: {
        svixId: "life_svix_replay_race",
        resendEmailId: "life_replay_race_email",
        type: "email.delivered",
        occurredAt: new Date("2026-07-20T19:00:01.000Z"),
        payload: {},
      },
    });

    await Promise.all([
      prisma.$transaction(tx => replayPendingEmailEventsForAttemptTx(tx, "life_replay_race_email")),
      drainEmailEvents(50),
    ]);

    const event = await prisma.emailEvent.findUniqueOrThrow({ where: { svixId: "life_svix_replay_race" } });
    expect(event.processedAt).not.toBeNull();
    expect(event.attempts).toBe(0);
    expect(await prisma.activityLog.count({
      where: { entityId: IDS.atomicInvoice, metadata: { contains: "life_replay_race_email" } },
    })).toBe(1);
  });
});
