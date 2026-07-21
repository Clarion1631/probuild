import { createHmac } from "node:crypto";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { validSignature } from "../src/app/api/webhooks/quickbooks/route";
import { drainQboEvents } from "../src/lib/invoice-event-workers";
import { extractLinkedInvoiceIds } from "../src/lib/quickbooks";
import { markMilestonePaidFromQB } from "../src/lib/quickbooks-payments";

const prisma = new PrismaClient();
const IDS = {
  client: "invoice-qbo-events-client",
  project: "invoice-qbo-events-project",
  invoice: "invoice-qbo-events-invoice",
  milestone: "invoice-qbo-events-milestone",
};

test.describe.serial("Invoice lifecycle: QBO inbox", () => {
  test.beforeAll(async () => {
    await prisma.client.create({ data: { id: IDS.client, name: "QBO Event Client", initials: "QEC" } });
    await prisma.project.create({ data: { id: IDS.project, name: "QBO Event Project", clientId: IDS.client } });
    await prisma.invoice.create({
      data: {
        id: IDS.invoice,
        code: "INV-QBO-EVENT",
        projectId: IDS.project,
        clientId: IDS.client,
        status: "Issued",
        issueDate: new Date("2026-07-01T12:00:00.000Z"),
        totalAmount: 100,
        balanceDue: 100,
      },
    });
    await prisma.paymentSchedule.create({
      data: { id: IDS.milestone, invoiceId: IDS.invoice, name: "QBO draw", amount: 100, qbInvoiceId: "qbo-invoice-event-1" },
    });
  });

  test.afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { action: { in: ["qbo_event_dead_letter", "payment_received"] }, projectId: IDS.project } });
    await prisma.paymentNotification.deleteMany({ where: { scheduleId: IDS.milestone } });
    await prisma.inboundQboEvent.deleteMany({ where: { realmId: { startsWith: "qbo-test-realm" } } });
    await prisma.paymentSchedule.deleteMany({ where: { id: IDS.milestone } });
    await prisma.invoice.deleteMany({ where: { id: IDS.invoice } });
    await prisma.project.deleteMany({ where: { id: IDS.project } });
    await prisma.client.deleteMany({ where: { id: IDS.client } });
    await prisma.$disconnect();
  });

  test("validates the raw payload signature and extracts linked invoice ids", () => {
    const raw = JSON.stringify({ eventNotifications: [{ realmId: "123" }] });
    const token = "qbo-webhook-test-token";
    const signature = createHmac("sha256", token).update(raw).digest("base64");
    expect(validSignature(raw, signature, token)).toBe(true);
    expect(validSignature(`${raw} `, signature, token)).toBe(false);
    expect(extractLinkedInvoiceIds({
      Line: [
        { LinkedTxn: [{ TxnType: "Invoice", TxnId: "inv-a" }, { TxnType: "CreditMemo", TxnId: "credit-a" }] },
        { LinkedTxn: [{ TxnType: "Invoice", TxnId: "inv-a" }, { TxnType: "Invoice", TxnId: "inv-b" }] },
      ],
    })).toEqual(["inv-a", "inv-b"]);
  });

  test("dedupes inbox rows and a lease prevents concurrent double processing", async () => {
    const duplicate = {
      realmId: "qbo-test-realm-dedupe",
      eventId: "same-event",
      entity: "Invoice",
      entityQboId: "same-invoice",
      payload: {},
    };
    const inserted = await prisma.inboundQboEvent.createMany({ data: [duplicate, duplicate], skipDuplicates: true });
    expect(inserted.count).toBe(1);

    let calls = 0;
    let release!: () => void;
    let started!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const claimed = new Promise<void>(resolve => { started = resolve; });
    const processEvent = async () => {
      calls += 1;
      started();
      await hold;
    };

    const first = drainQboEvents(10, { processEvent });
    await claimed;
    const second = await drainQboEvents(10, { processEvent });
    expect(second.processed).toBe(0);
    expect(calls).toBe(1);
    release();
    expect((await first).processed).toBe(1);
  });

  test("the fifth real failure dead-letters without marking processed and logs evidence", async () => {
    const row = await prisma.inboundQboEvent.create({
      data: {
        realmId: "qbo-test-realm-dead",
        eventId: "dead-event",
        entity: "Invoice",
        entityQboId: "qbo-invoice-event-1",
        payload: {},
      },
    });
    let calls = 0;
    const fail = async () => {
      calls += 1;
      throw new Error("injected QBO worker failure");
    };
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await drainQboEvents(10, { processEvent: fail });
      expect(result.dead).toBe(attempt === 5 ? 1 : 0);
    }
    const dead = await prisma.inboundQboEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(dead.attempts).toBe(5);
    expect(dead.processedAt).toBeNull();
    expect(dead.lastError).toContain("dead:injected QBO worker failure");
    expect(await prisma.activityLog.count({ where: { action: "qbo_event_dead_letter", entityId: IDS.invoice } })).toBe(1);

    const sixth = await drainQboEvents(10, { processEvent: fail });
    expect(sixth.processed + sixth.retried + sixth.dead).toBe(0);
    expect(calls).toBe(5);
  });

  test("settlement replay performs one paid transition and enqueues one notification", async () => {
    const payment = {
      paidAt: new Date("2026-07-20T12:00:00.000Z"),
      referenceNumber: "QBO-PAY-1",
      qbPaymentId: "qbo-payment-1",
    };
    expect(await markMilestonePaidFromQB(IDS.milestone, IDS.invoice, payment)).toBe(true);
    expect(await markMilestonePaidFromQB(IDS.milestone, IDS.invoice, payment)).toBe(false);
    const milestone = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: IDS.milestone } });
    expect(milestone.status).toBe("Paid");
    expect(await prisma.paymentNotification.count({ where: { scheduleId: IDS.milestone } })).toBe(1);
  });
});
