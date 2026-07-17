import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { settleStripeEstimatePayment } from "../src/lib/stripe-estimate-settlement";

const prisma = new PrismaClient();
const PREFIX = "stripe-mirror-e2e";

type SeedOptions = {
  estimatePaid?: boolean;
  linkedDrift?: boolean;
  legacyCopies?: number;
  addLegacyDecoy?: boolean;
};

function ids(suffix: string) {
  return {
    client: `${PREFIX}-client-${suffix}`,
    project: `${PREFIX}-project-${suffix}`,
    estimate: `${PREFIX}-estimate-${suffix}`,
    estimateSchedule: `${PREFIX}-estimate-schedule-${suffix}`,
    invoice: `${PREFIX}-invoice-${suffix}`,
    linkedCopy: `${PREFIX}-linked-copy-${suffix}`,
  };
}

async function seed(suffix: string, options: SeedOptions = {}) {
  const id = ids(suffix);
  const estimatePaid = options.estimatePaid ?? false;

  await prisma.client.create({
    data: { id: id.client, name: `Stripe Mirror ${suffix}`, initials: "SM" },
  });
  await prisma.project.create({
    data: { id: id.project, clientId: id.client, name: `Stripe Mirror ${suffix}`, status: "In Progress" },
  });
  await prisma.estimate.create({
    data: {
      id: id.estimate,
      projectId: id.project,
      title: `Stripe Mirror ${suffix}`,
      code: `EST-SM-${suffix}`,
      status: estimatePaid ? "Partially Paid" : "Approved",
      statusBeforePayment: estimatePaid ? "Approved" : null,
      taxExempt: true,
      totalAmount: 1000,
      balanceDue: estimatePaid ? 600 : 1000,
    },
  });
  await prisma.estimatePaymentSchedule.create({
    data: {
      id: id.estimateSchedule,
      estimateId: id.estimate,
      name: "Deposit",
      amount: 400,
      status: estimatePaid ? "Paid" : "Pending",
      paymentMethod: estimatePaid ? "card" : null,
      paymentDate: estimatePaid ? new Date("2026-07-01T12:00:00Z") : null,
      paidAt: estimatePaid ? new Date("2026-07-01T12:00:00Z") : null,
      order: 1,
    },
  });
  await prisma.invoice.create({
    data: {
      id: id.invoice,
      projectId: id.project,
      clientId: id.client,
      estimateId: id.estimate,
      code: `INV-SM-${suffix}`,
      status: "Issued",
      totalAmount: 1000,
      balanceDue: 1000,
      issueDate: new Date("2026-07-01T00:00:00Z"),
    },
  });

  if (options.linkedDrift) {
    await prisma.paymentSchedule.create({
      data: {
        id: id.linkedCopy,
        invoiceId: id.invoice,
        sourceScheduleId: id.estimateSchedule,
        name: "Renamed after conversion",
        amount: 450,
        status: "Pending",
      },
    });
  }

  for (let index = 0; index < (options.legacyCopies ?? 0); index += 1) {
    await prisma.paymentSchedule.create({
      data: {
        id: `${PREFIX}-legacy-${suffix}-${index}`,
        invoiceId: id.invoice,
        sourceScheduleId: null,
        name: "Deposit",
        amount: 400,
        status: "Pending",
      },
    });
  }

  if (options.addLegacyDecoy) {
    await prisma.paymentSchedule.create({
      data: {
        id: `${PREFIX}-decoy-${suffix}`,
        invoiceId: id.invoice,
        sourceScheduleId: null,
        name: "Deposit",
        amount: 400,
        status: "Pending",
      },
    });
  }

  return id;
}

const settlement = {
  stripeSessionId: "cs_test_mirror",
  stripePaymentIntentId: "pi_test_mirror",
  paymentMethod: "card",
  paymentDate: new Date("2026-07-17T12:00:00Z"),
  paidAt: new Date("2026-07-17T12:00:00Z"),
};

test.describe.serial("Stripe estimate settlements preserve invoice mirrors", () => {
  test.beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl.includes("localhost") && !databaseUrl.includes("127.0.0.1")) {
      throw new Error("stripe-estimate-mirror.spec.ts requires a disposable local database");
    }
  });

  test.afterAll(async () => {
    try {
      const schedules = await prisma.estimatePaymentSchedule.findMany({
        where: { id: { startsWith: PREFIX } },
        select: { id: true },
      });
      await prisma.paymentNotification.deleteMany({
        where: { scheduleId: { in: schedules.map((row) => row.id) } },
      });
      await prisma.paymentSchedule.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await prisma.invoice.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await prisma.estimatePaymentSchedule.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await prisma.estimate.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await prisma.project.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await prisma.client.deleteMany({ where: { id: { startsWith: PREFIX } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("sourceScheduleId wins across name/amount drift and a matching legacy decoy", async () => {
    const id = await seed("linked", { linkedDrift: true, addLegacyDecoy: true });

    const first = await settleStripeEstimatePayment({
      estimateId: id.estimate,
      scheduleId: id.estimateSchedule,
      settlement,
      enqueueNotification: true,
    });
    const replay = await settleStripeEstimatePayment({
      estimateId: id.estimate,
      scheduleId: id.estimateSchedule,
      settlement,
      enqueueNotification: true,
    });

    expect(first.estimateClaimed).toBe(true);
    expect(first.mirroredCopyId).toBe(id.linkedCopy);
    expect(first.mirrorClaimed).toBe(true);
    expect(replay.changed).toBe(false);

    const linked = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: id.linkedCopy } });
    const decoy = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: `${PREFIX}-decoy-linked` } });
    const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: id.estimate } });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: id.invoice } });
    const notifications = await prisma.paymentNotification.findMany({ where: { scheduleId: id.estimateSchedule } });

    expect(linked.status).toBe("Paid");
    expect(linked.name).toBe("Renamed after conversion");
    expect(Number(linked.amount)).toBe(450);
    expect(linked.stripeSessionId).toBe(settlement.stripeSessionId);
    expect(decoy.status).toBe("Pending");
    expect(Number(estimate.balanceDue)).toBe(600);
    expect(estimate.status).toBe("Partially Paid");
    expect(Number(invoice.balanceDue)).toBe(550);
    expect(invoice.status).toBe("Partially Paid");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].scheduleType).toBe("estimate");
  });

  test("a unique unlinked name+amount legacy copy is the only fallback", async () => {
    const id = await seed("legacy", { legacyCopies: 1 });

    const result = await settleStripeEstimatePayment({
      estimateId: id.estimate,
      scheduleId: id.estimateSchedule,
      settlement,
      enqueueNotification: false,
    });

    expect(result.mirroredCopyId).toBe(`${PREFIX}-legacy-legacy-0`);
    expect(result.mirrorClaimed).toBe(true);
    const copy = await prisma.paymentSchedule.findUniqueOrThrow({
      where: { id: `${PREFIX}-legacy-legacy-0` },
    });
    expect(copy.status).toBe("Paid");
  });

  test("ambiguous unlinked legacy copies are left untouched", async () => {
    const id = await seed("ambiguous", { legacyCopies: 2 });

    const preview = await settleStripeEstimatePayment({
      estimateId: id.estimate,
      scheduleId: id.estimateSchedule,
      settlement,
      enqueueNotification: false,
      dryRun: true,
    });
    expect(preview.mirroredCopyId).toBeNull();
    expect(preview.mirrorClaimed).toBe(false);
    const pendingEstimate = await prisma.estimatePaymentSchedule.findUniqueOrThrow({
      where: { id: id.estimateSchedule },
    });
    expect(pendingEstimate.status).toBe("Pending");

    const result = await settleStripeEstimatePayment({
      estimateId: id.estimate,
      scheduleId: id.estimateSchedule,
      settlement,
      enqueueNotification: false,
    });

    expect(result.estimateClaimed).toBe(true);
    expect(result.mirroredCopyId).toBeNull();
    expect(result.mirrorClaimed).toBe(false);
    const copies = await prisma.paymentSchedule.findMany({ where: { invoiceId: id.invoice } });
    expect(copies.every((copy) => copy.status === "Pending")).toBe(true);
  });

  test("reconciliation repairs a pending invoice mirror when the estimate is already Paid", async () => {
    const id = await seed("repair", { estimatePaid: true, linkedDrift: true });

    const preview = await settleStripeEstimatePayment({
      estimateId: id.estimate,
      scheduleId: id.estimateSchedule,
      settlement,
      enqueueNotification: false,
      dryRun: true,
    });
    expect(preview.estimateClaimed).toBe(false);
    expect(preview.mirroredCopyId).toBe(id.linkedCopy);
    expect(preview.mirrorClaimed).toBe(true);
    expect(preview.changed).toBe(true);
    expect((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: id.linkedCopy } })).status).toBe("Pending");

    const result = await settleStripeEstimatePayment({
      estimateId: id.estimate,
      scheduleId: id.estimateSchedule,
      settlement,
      enqueueNotification: false,
    });

    expect(result.estimateClaimed).toBe(false);
    expect(result.mirroredCopyId).toBe(id.linkedCopy);
    expect(result.mirrorClaimed).toBe(true);
    expect(result.changed).toBe(true);
    const copy = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: id.linkedCopy } });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: id.invoice } });
    const notifications = await prisma.paymentNotification.findMany({ where: { scheduleId: id.estimateSchedule } });
    expect(copy.status).toBe("Paid");
    expect(Number(invoice.balanceDue)).toBe(550);
    expect(invoice.status).toBe("Partially Paid");
    expect(notifications).toHaveLength(0);
  });
});
