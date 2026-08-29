import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { saveQBSettings } from "../src/lib/integration-store";

/**
 * Deposit auto-apply pipeline (Phase B1) — hermetic e2e for
 * POST /api/payments/deposit-ingest (src/app/api/payments/deposit-ingest/route.ts).
 * Spec: C:\Users\jat00\.claude\plans\create-the-channel-for-elegant-hearth.md, section B1.
 *
 * Runs ONLY against the throwaway CI Postgres (data.setup.ts guards prod) —
 * see docs/TESTING.md. Real QuickBooks calls are forbidden here: E2E_QBO_MOCK=1
 * (same triple-gate as E2E_STORAGE_MOCK — see isE2eQboMockEnabled() in
 * src/lib/quickbooks-mock.ts) routes getFreshQBTokens/buildQBPaymentRequest/
 * sendQBPaymentCreateRequest to a deterministic, no-network mock. Because this
 * spec drives the endpoint over real HTTP against the Playwright webServer (a
 * SEPARATE Node process from this test file), the mock's captured calls are
 * read back through the test-only seam at /api/payments/test-only/qbo-mock
 * (also gated by isE2eQboMockEnabled(), so it 404s outside a Playwright run) —
 * see that route's doc comment for why a plain module import can't work here.
 *
 * Auth: DEPOSIT_INGEST_SECRET must be set for the server under test (CI wires
 * it as a literal in .github/workflows/ci.yml — nothing external depends on
 * its value). Every test that needs a valid call reads it straight from
 * process.env, same pattern as PLAYWRIGHT_TEST_SECRET elsewhere in e2e/.
 */

const prisma = new PrismaClient();
const DEPOSIT_INGEST_PATH = "/api/payments/deposit-ingest";
const QBO_MOCK_PATH = "/api/payments/test-only/qbo-mock";
const SECRET = process.env.DEPOSIT_INGEST_SECRET || "";

const CLIENT_ID = "di-e2e-client";
const CLIENT_NAME = "Deposit Ingest E2E Client";

// ── Small helpers ────────────────────────────────────────────────────────────

async function postDeposit(
  request: APIRequestContext,
  body: unknown,
  opts?: { force?: boolean; authHeader?: string | null; rawData?: string },
) {
  const qs = opts?.force ? "?force=1" : "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = opts?.authHeader === null ? undefined : opts?.authHeader ?? `Bearer ${SECRET}`;
  if (auth !== undefined) headers.authorization = auth;
  const data = opts?.rawData !== undefined ? opts.rawData : JSON.stringify(body);
  const res = await request.post(`${DEPOSIT_INGEST_PATH}${qs}`, { headers, data });
  return { res, body: await safeJson(res) };
}

async function getDeposit(
  request: APIRequestContext,
  fileId: string,
  authHeader: string | null = `Bearer ${SECRET}`,
) {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.authorization = authHeader;
  const res = await request.get(`${DEPOSIT_INGEST_PATH}?fileId=${encodeURIComponent(fileId)}`, { headers });
  return { res, body: await safeJson(res) };
}

async function safeJson(res: Awaited<ReturnType<APIRequestContext["post"]>>) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function resetQboMock(request: APIRequestContext) {
  const res = await request.post(QBO_MOCK_PATH, {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ action: "reset" }),
  });
  expect(res.ok(), "resetQboMock — is E2E_QBO_MOCK=1/PLAYWRIGHT_TEST_SECRET set on the server under test?").toBeTruthy();
}

async function seedQboInvoice(request: APIRequestContext, qbInvoiceId: string, balance: number, customerId: string) {
  const res = await request.post(QBO_MOCK_PATH, {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ action: "seedInvoice", qbInvoiceId, balance, customerId }),
  });
  expect(res.ok()).toBeTruthy();
}

async function getQboMockState(request: APIRequestContext): Promise<{
  calls: { readInvoice: number; paymentCreate: number };
  paymentCreateCalls: Array<{ requestBody: string; requestId: string; at: number }>;
}> {
  const res = await request.get(QBO_MOCK_PATH);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Mirrors the private `depositRequestId` helper in route.ts — duplicated
 *  here (not exported; route.ts is reviewed and left untouched) so the
 *  byte-identical-replay test (case 5) can assert the mock received the
 *  exact requestId the route computes from the fileId. */
function computeDepositRequestId(fileId: string): string {
  return createHash("sha256").update(`deposit-${fileId}`).digest("hex").slice(0, 50);
}

async function officeTasksMentioning(fileId: string) {
  return prisma.officeTask.findMany({ where: { notes: { contains: fileId } } });
}

type ScheduleSpec = {
  id: string;
  name: string;
  amount: number;
  qbInvoiceId?: string | null;
  qbPaymentId?: string | null;
  status?: "Pending" | "Paid";
};

async function seedFixture(opts: {
  projectId: string;
  projectName: string;
  invoiceId: string;
  invoiceCode: string;
  schedules: ScheduleSpec[];
}) {
  await prisma.client.upsert({
    where: { id: CLIENT_ID },
    update: {},
    create: { id: CLIENT_ID, name: CLIENT_NAME, initials: "DI" },
  });
  await prisma.project.upsert({
    where: { id: opts.projectId },
    update: { name: opts.projectName, status: "In Progress" },
    create: { id: opts.projectId, name: opts.projectName, clientId: CLIENT_ID, status: "In Progress" },
  });
  const total = opts.schedules.reduce((sum, s) => sum + s.amount, 0);
  await prisma.invoice.upsert({
    where: { id: opts.invoiceId },
    update: { status: "Issued", totalAmount: total, balanceDue: total },
    create: {
      id: opts.invoiceId, code: opts.invoiceCode, projectId: opts.projectId, clientId: CLIENT_ID,
      status: "Issued", totalAmount: total, balanceDue: total, issueDate: new Date(),
    },
  });
  for (const s of opts.schedules) {
    const status = s.status ?? "Pending";
    const paidFields = status === "Paid"
      ? { paidAt: new Date(), paymentDate: new Date(), paymentMethod: "quickbooks" }
      : { paidAt: null, paymentDate: null, paymentMethod: null };
    await prisma.paymentSchedule.upsert({
      where: { id: s.id },
      update: { status, amount: s.amount, qbInvoiceId: s.qbInvoiceId ?? null, qbPaymentId: s.qbPaymentId ?? null, referenceNumber: null, ...paidFields },
      create: {
        id: s.id, invoiceId: opts.invoiceId, name: s.name, amount: s.amount, status,
        qbInvoiceId: s.qbInvoiceId ?? null, qbPaymentId: s.qbPaymentId ?? null, ...paidFields,
      },
    });
  }
}

async function seedTiedProjects(idA: string, idB: string, name: string) {
  await prisma.client.upsert({ where: { id: CLIENT_ID }, update: {}, create: { id: CLIENT_ID, name: CLIENT_NAME, initials: "DI" } });
  for (const id of [idA, idB]) {
    await prisma.project.upsert({
      where: { id },
      update: { name, status: "In Progress" },
      create: { id, name, clientId: CLIENT_ID, status: "In Progress" },
    });
  }
}

// ── Fixture ids ───────────────────────────────────────────────────────────────

const F = {
  qbo: {
    project: "di-e2e-qbo-project", projectName: "Nnexo QBO Happy Path Project",
    invoice: "di-e2e-qbo-invoice", invoiceCode: "INV-DI-QBO",
    schedule: "di-e2e-qbo-schedule", amount: 500,
    qbInvoiceId: "di-mock-inv-qbo-1", fileId: "di-e2e-file-qbo-happy",
  },
  concurrent: {
    project: "di-e2e-concurrent-project", projectName: "Nnexo Concurrent Project",
    invoice: "di-e2e-concurrent-invoice", invoiceCode: "INV-DI-CONC",
    schedule: "di-e2e-concurrent-schedule", amount: 300,
    qbInvoiceId: "di-mock-inv-concurrent-1", fileId: "di-e2e-file-concurrent",
  },
  reserve: {
    project: "di-e2e-reserve-project", projectName: "Nnexo Reserve Project",
    invoice: "di-e2e-reserve-invoice", invoiceCode: "INV-DI-RES",
    schedule: "di-e2e-reserve-schedule", amount: 250,
    fileIdA: "di-e2e-file-reserve-a", fileIdB: "di-e2e-file-reserve-b",
  },
  resume: {
    project: "di-e2e-resume-project", projectName: "Nnexo Resume Project",
    invoice: "di-e2e-resume-invoice", invoiceCode: "INV-DI-RESUME",
    schedule: "di-e2e-resume-schedule", amount: 400,
    qbInvoiceId: "di-mock-inv-resume-1", fileId: "di-e2e-file-resume",
  },
  cronSame: {
    project: "di-e2e-cronsame-project", projectName: "Nnexo CronSame Project",
    invoice: "di-e2e-cronsame-invoice", invoiceCode: "INV-DI-CRONSAME",
    schedule: "di-e2e-cronsame-schedule", amount: 275,
    fileId: "di-e2e-file-cronsame", qbPaymentId: "di-cron-payment-same-1",
  },
  cronDiff: {
    project: "di-e2e-crondiff-project", projectName: "Nnexo CronDiff Project",
    invoice: "di-e2e-crondiff-invoice", invoiceCode: "INV-DI-CRONDIFF",
    schedule: "di-e2e-crondiff-schedule", amount: 285,
    fileId: "di-e2e-file-crondiff", rowQbPaymentId: "di-cron-payment-rowside-1", milestoneQbPaymentId: "di-cron-payment-milestoneside-DIFFERENT",
  },
  refuseUnresolvable: { fileId: "di-e2e-refuse-unresolvable-project" },
  refuseTied: {
    projectA: "di-e2e-tied-project-a", projectB: "di-e2e-tied-project-b",
    name: "Zzqxw Bratwald Kettlecorn", fileId: "di-e2e-refuse-tied-project",
  },
  refuseZeroAmt: {
    project: "di-e2e-zeroamt-project", projectName: "Nnexo Zeroamt Project",
    invoice: "di-e2e-zeroamt-invoice", invoiceCode: "INV-DI-ZEROAMT",
    schedule: "di-e2e-zeroamt-schedule", scheduleAmount: 999, postedAmount: 111,
    fileId: "di-e2e-refuse-zero-amount",
  },
  refuseTwoAmt: {
    project: "di-e2e-twoamt-project", projectName: "Nnexo Twoamt Project",
    invoice: "di-e2e-twoamt-invoice", invoiceCode: "INV-DI-TWOAMT",
    scheduleA: "di-e2e-twoamt-schedule-a", scheduleB: "di-e2e-twoamt-schedule-b", amount: 222,
    fileId: "di-e2e-refuse-two-amount",
  },
  refuseNoCheckNumber: { fileId: "di-e2e-refuse-no-check-number" },
  refuseNoCheckDate: { fileId: "di-e2e-refuse-no-check-date" },
  refusePayer: {
    project: "di-e2e-payer-project", projectName: "Nnexo Payer Project",
    invoice: "di-e2e-payer-invoice", invoiceCode: "INV-DI-PAYER",
    schedule: "di-e2e-payer-schedule", amount: 333,
    fileId: "di-e2e-refuse-payer-conflict",
  },
  forceCorrect: {
    project: "di-e2e-force-project", projectName: "Nnexo Force Project",
    invoice: "di-e2e-force-invoice", invoiceCode: "INV-DI-FORCE",
    schedule: "di-e2e-force-schedule", correctAmount: 350, wrongAmount: 999,
    fileId: "di-e2e-file-force-correct",
  },
  forceCrossedQbo: { fileId: "di-e2e-file-force-crossed-qbo" },
  nonQbo: {
    project: "di-e2e-nonqbo-project", projectName: "Nnexo NonQBO Project",
    invoice: "di-e2e-nonqbo-invoice", invoiceCode: "INV-DI-NONQBO",
    schedule: "di-e2e-nonqbo-schedule", amount: 600,
    fileId: "di-e2e-file-nonqbo",
  },
  validation: { fileId: "di-e2e-file-validation" },
  weakMatch: {
    project: "di-e2e-weak-project", projectName: "Weakguard Kitchen Remodel",
    invoice: "di-e2e-weak-invoice", invoiceCode: "INV-DI-WEAK",
    schedule: "di-e2e-weak-schedule", amount: 123,
    fileId: "di-e2e-file-weakmatch",
  },
  // Case 12: crash recovery across the NON-QBO money boundary (settleStartedAt) —
  // one invoice, two Pending milestones with distinct amounts so each sub-case
  // resumes against its own reservation.
  settleCrash: {
    project: "di-e2e-scrash-project", projectName: "Nnexo SettleCrash Project",
    invoice: "di-e2e-scrash-invoice", invoiceCode: "INV-DI-SCRASH",
    scheduleSettled: "di-e2e-scrash-sched-a", amountSettled: 700,
    scheduleUnsettled: "di-e2e-scrash-sched-b", amountUnsettled: 710,
    fileIdSettled: "di-e2e-file-scrash-settled", fileIdUnsettled: "di-e2e-file-scrash-unsettled",
  },
};

const ALL_PROJECT_IDS = [
  F.qbo.project, F.concurrent.project, F.reserve.project, F.resume.project,
  F.cronSame.project, F.cronDiff.project, F.refuseTied.projectA, F.refuseTied.projectB,
  F.refuseZeroAmt.project, F.refuseTwoAmt.project, F.refusePayer.project,
  F.forceCorrect.project, F.nonQbo.project, F.settleCrash.project, F.weakMatch.project,
];

const ALL_FILE_IDS = [
  F.qbo.fileId, F.concurrent.fileId, F.reserve.fileIdA, F.reserve.fileIdB, F.resume.fileId,
  F.cronSame.fileId, F.cronDiff.fileId, F.refuseUnresolvable.fileId, F.refuseTied.fileId,
  F.refuseZeroAmt.fileId, F.refuseTwoAmt.fileId, F.refuseNoCheckNumber.fileId, F.refuseNoCheckDate.fileId,
  F.refusePayer.fileId, F.forceCorrect.fileId, F.forceCrossedQbo.fileId, F.nonQbo.fileId, F.validation.fileId,
  F.settleCrash.fileIdSettled, F.settleCrash.fileIdUnsettled, F.weakMatch.fileId,
];

test.describe.serial("Deposit-ingest pipeline (Phase B1)", () => {
  test.beforeEach(() => {
    test.skip(!SECRET, "requires DEPOSIT_INGEST_SECRET on the server under test — see .github/workflows/ci.yml / docs/TESTING.md");
  });

  test.beforeAll(async () => {
    // createDepositReviewTask (route.ts) files every unmatched/reconcile task
    // into `officeBoardColumn.findFirst({orderBy:[{position:"asc"},{createdAt:"asc"}]})`
    // — a fresh throwaway DB has NO board columns (data.setup.ts doesn't seed
    // one), so without this every officeTaskId assertion below would see null.
    // Fixed id so re-running this beforeAll (retries) is idempotent; left in
    // place (not deleted in afterAll) since other specs in the same run may
    // also rely on at least one column existing.
    await prisma.officeBoardColumn.upsert({
      where: { id: "di-e2e-office-column" },
      update: {},
      create: { id: "di-e2e-office-column", name: "To Do", position: 0 },
    });

    await seedFixture({
      projectId: F.qbo.project, projectName: F.qbo.projectName,
      invoiceId: F.qbo.invoice, invoiceCode: F.qbo.invoiceCode,
      schedules: [{ id: F.qbo.schedule, name: "QBO Deposit", amount: F.qbo.amount, qbInvoiceId: F.qbo.qbInvoiceId }],
    });
    await seedFixture({
      projectId: F.concurrent.project, projectName: F.concurrent.projectName,
      invoiceId: F.concurrent.invoice, invoiceCode: F.concurrent.invoiceCode,
      schedules: [{ id: F.concurrent.schedule, name: "Concurrent Deposit", amount: F.concurrent.amount, qbInvoiceId: F.concurrent.qbInvoiceId }],
    });
    await seedFixture({
      projectId: F.reserve.project, projectName: F.reserve.projectName,
      invoiceId: F.reserve.invoice, invoiceCode: F.reserve.invoiceCode,
      schedules: [{ id: F.reserve.schedule, name: "Reserve Deposit", amount: F.reserve.amount }],
    });
    await seedFixture({
      projectId: F.resume.project, projectName: F.resume.projectName,
      invoiceId: F.resume.invoice, invoiceCode: F.resume.invoiceCode,
      schedules: [{ id: F.resume.schedule, name: "Resume Deposit", amount: F.resume.amount, qbInvoiceId: F.resume.qbInvoiceId }],
    });
    await seedFixture({
      projectId: F.cronSame.project, projectName: F.cronSame.projectName,
      invoiceId: F.cronSame.invoice, invoiceCode: F.cronSame.invoiceCode,
      schedules: [{ id: F.cronSame.schedule, name: "CronSame Deposit", amount: F.cronSame.amount, status: "Paid", qbPaymentId: F.cronSame.qbPaymentId }],
    });
    await seedFixture({
      projectId: F.cronDiff.project, projectName: F.cronDiff.projectName,
      invoiceId: F.cronDiff.invoice, invoiceCode: F.cronDiff.invoiceCode,
      schedules: [{ id: F.cronDiff.schedule, name: "CronDiff Deposit", amount: F.cronDiff.amount, status: "Paid", qbPaymentId: F.cronDiff.milestoneQbPaymentId }],
    });
    await seedTiedProjects(F.refuseTied.projectA, F.refuseTied.projectB, F.refuseTied.name);
    await seedFixture({
      projectId: F.refuseZeroAmt.project, projectName: F.refuseZeroAmt.projectName,
      invoiceId: F.refuseZeroAmt.invoice, invoiceCode: F.refuseZeroAmt.invoiceCode,
      schedules: [{ id: F.refuseZeroAmt.schedule, name: "ZeroAmt Deposit", amount: F.refuseZeroAmt.scheduleAmount }],
    });
    await seedFixture({
      projectId: F.refuseTwoAmt.project, projectName: F.refuseTwoAmt.projectName,
      invoiceId: F.refuseTwoAmt.invoice, invoiceCode: F.refuseTwoAmt.invoiceCode,
      schedules: [
        { id: F.refuseTwoAmt.scheduleA, name: "TwoAmt Deposit A", amount: F.refuseTwoAmt.amount },
        { id: F.refuseTwoAmt.scheduleB, name: "TwoAmt Deposit B", amount: F.refuseTwoAmt.amount },
      ],
    });
    await seedFixture({
      projectId: F.refusePayer.project, projectName: F.refusePayer.projectName,
      invoiceId: F.refusePayer.invoice, invoiceCode: F.refusePayer.invoiceCode,
      schedules: [{ id: F.refusePayer.schedule, name: "Payer Deposit", amount: F.refusePayer.amount }],
    });
    await seedFixture({
      projectId: F.forceCorrect.project, projectName: F.forceCorrect.projectName,
      invoiceId: F.forceCorrect.invoice, invoiceCode: F.forceCorrect.invoiceCode,
      schedules: [{ id: F.forceCorrect.schedule, name: "Force Deposit", amount: F.forceCorrect.correctAmount }],
    });
    await seedFixture({
      projectId: F.nonQbo.project, projectName: F.nonQbo.projectName,
      invoiceId: F.nonQbo.invoice, invoiceCode: F.nonQbo.invoiceCode,
      schedules: [{ id: F.nonQbo.schedule, name: "NonQBO Deposit", amount: F.nonQbo.amount }],
    });
    // The QBO mock replaces the network, NOT the connection state (see
    // getFreshQBTokens) — QBO-linked cases need a connected settings row. Cleared in
    // afterAll so later-ordered fail-closed specs (CI runs workers:1, serialized)
    // keep their disconnected premise.
    await saveQBSettings({ connected: true, accessToken: "e2e-mock", refreshToken: "e2e-mock", realmId: "e2e-mock-realm" });
    await seedFixture({
      projectId: F.weakMatch.project, projectName: F.weakMatch.projectName,
      invoiceId: F.weakMatch.invoice, invoiceCode: F.weakMatch.invoiceCode,
      schedules: [{ id: F.weakMatch.schedule, name: "Weak Match Deposit", amount: F.weakMatch.amount }],
    });
    await seedFixture({
      projectId: F.settleCrash.project, projectName: F.settleCrash.projectName,
      invoiceId: F.settleCrash.invoice, invoiceCode: F.settleCrash.invoiceCode,
      schedules: [
        { id: F.settleCrash.scheduleSettled, name: "SettleCrash Committed", amount: F.settleCrash.amountSettled },
        { id: F.settleCrash.scheduleUnsettled, name: "SettleCrash Uncommitted", amount: F.settleCrash.amountUnsettled },
      ],
    });
  });

  test.afterAll(async () => {
    try {
      await saveQBSettings({ connected: false, accessToken: undefined, refreshToken: undefined, realmId: undefined });
      await prisma.paymentNotification.deleteMany({
        where: { scheduleId: { in: [F.qbo.schedule, F.concurrent.schedule, F.reserve.schedule, F.resume.schedule, F.nonQbo.schedule, F.forceCorrect.schedule, F.settleCrash.scheduleSettled, F.settleCrash.scheduleUnsettled] } },
      });
      await prisma.activityLog.deleteMany({ where: { projectId: { in: ALL_PROJECT_IDS } } });
      for (const fileId of ALL_FILE_IDS) {
        await prisma.officeTask.deleteMany({ where: { notes: { contains: fileId } } });
      }
      await prisma.depositIngest.deleteMany({ where: { fileId: { in: ALL_FILE_IDS } } });
      await prisma.invoice.deleteMany({ where: { projectId: { in: ALL_PROJECT_IDS } } }); // cascades PaymentSchedule
      await prisma.project.deleteMany({ where: { id: { in: ALL_PROJECT_IDS } } });
      await prisma.client.deleteMany({ where: { id: CLIENT_ID } });
    } finally {
      await prisma.$disconnect();
    }
  });

  // ── 1 & 2: QBO-linked happy path, then idempotent re-POST ──────────────────
  test("1-2: QBO-linked deposit applies (correct date/ref, PaymentNotification enqueued); re-POST is idempotent with no second QBO call", async ({ request }) => {
    await resetQboMock(request);
    await seedQboInvoice(request, F.qbo.qbInvoiceId, F.qbo.amount, "di-mock-cust-qbo-1");

    const payload = {
      fileId: F.qbo.fileId, projectName: F.qbo.projectName, amount: F.qbo.amount,
      checkDate: "2026-07-20", checkNumber: "4501", fileUrl: "https://drive.example/qbo.jpg", fileName: "qbo.jpg",
    };
    const first = await postDeposit(request, payload);
    expect(first.res.status()).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.status).toBe("applied");
    expect(first.body.scheduleId).toBe(F.qbo.schedule);
    expect(first.body.qbPaymentId).toBeTruthy();
    const qbPaymentId = first.body.qbPaymentId as string;

    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.qbo.schedule } });
    expect(schedule.status).toBe("Paid");
    expect(schedule.paymentMethod).toBe("quickbooks");
    expect(schedule.referenceNumber).toBe("4501");
    expect(schedule.qbPaymentId).toBe(qbPaymentId);
    expect(schedule.paymentDate?.toISOString().slice(0, 10)).toBe("2026-07-20");

    const row = await prisma.depositIngest.findUniqueOrThrow({ where: { fileId: F.qbo.fileId } });
    expect(row.status).toBe("applied");
    expect(row.qbPaymentId).toBe(qbPaymentId);

    const notes = await prisma.paymentNotification.findMany({ where: { scheduleId: F.qbo.schedule } });
    expect(notes, "PaymentNotification outbox row exists for the settled milestone").toHaveLength(1);
    expect(notes[0].scheduleType).toBe("invoice");

    const afterFirst = await getQboMockState(request);
    expect(afterFirst.calls.paymentCreate).toBe(1);

    // ── Idempotent re-POST ──
    const second = await postDeposit(request, payload);
    expect(second.res.status()).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.status).toBe("applied");
    expect(second.body.alreadyApplied).toBe(true);
    expect(second.body.qbPaymentId).toBe(qbPaymentId);

    const afterSecond = await getQboMockState(request);
    expect(afterSecond.calls.paymentCreate, "re-POST of an already-applied row makes no second QBO call").toBe(1);

    const scheduleAfter = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.qbo.schedule } });
    expect(scheduleAfter.qbPaymentId, "no state change on re-POST").toBe(qbPaymentId);
  });

  test("2b: status probe reads the persisted deposit but never returns raw QBO replay data", async ({ request }) => {
    const unauthorized = await getDeposit(request, F.qbo.fileId, null);
    expect(unauthorized.res.status()).toBe(401);

    const found = await getDeposit(request, F.qbo.fileId);
    expect(found.res.status()).toBe(200);
    expect(found.body).toMatchObject({
      ok: true,
      deposit: {
        status: "applied",
        fileId: F.qbo.fileId,
        paymentScheduleId: F.qbo.schedule,
        amountCents: F.qbo.amount * 100,
      },
    });
    expect(found.body.deposit.extracted).toBeUndefined();
    expect(found.body.deposit.qbRequestPayload).toBeUndefined();
  });

  // ── 3: Concurrent duplicates, same fileId ───────────────────────────────────
  test("3: two concurrent POSTs of the SAME fileId apply exactly once, with exactly one QBO payment create", async ({ request }) => {
    await resetQboMock(request);
    await seedQboInvoice(request, F.concurrent.qbInvoiceId, F.concurrent.amount, "di-mock-cust-concurrent-1");

    const payload = {
      fileId: F.concurrent.fileId, projectName: F.concurrent.projectName, amount: F.concurrent.amount,
      checkDate: "2026-07-21", checkNumber: "6001",
    };
    const [a, b] = await Promise.all([postDeposit(request, payload), postDeposit(request, payload)]);

    for (const r of [a, b]) {
      expect(r.res.status()).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(["applied", "processing", "qbo_unknown", "qbo_created"]).toContain(r.body.status);
    }

    const mockState = await getQboMockState(request);
    expect(mockState.calls.paymentCreate, "exactly one QBO payment create across both concurrent requests").toBe(1);

    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.concurrent.schedule } });
    expect(schedule.status).toBe("Paid");
    expect(schedule.referenceNumber).toBe("6001");

    const row = await prisma.depositIngest.findUniqueOrThrow({ where: { fileId: F.concurrent.fileId } });
    expect(row.status).toBe("applied");
    expect(row.qbPaymentId).toBe(schedule.qbPaymentId);
  });

  // ── 4: Reservation blocking, two different fileIds → one milestone ─────────
  test("4: two different fileIds matching the same Pending milestone — one applies, the other is unmatched (already being applied)", async ({ request }) => {
    const payloadA = { fileId: F.reserve.fileIdA, projectName: F.reserve.projectName, amount: F.reserve.amount, checkDate: "2026-07-22", checkNumber: "7001" };
    const payloadB = { fileId: F.reserve.fileIdB, projectName: F.reserve.projectName, amount: F.reserve.amount, checkDate: "2026-07-22", checkNumber: "7002" };

    const [a, b] = await Promise.all([postDeposit(request, payloadA), postDeposit(request, payloadB)]);
    for (const r of [a, b]) {
      expect(r.res.status()).toBe(200);
      expect(r.body.ok).toBe(true);
    }

    const applied = [a, b].filter((r) => r.body.status === "applied");
    const unmatched = [a, b].filter((r) => r.body.status === "unmatched");
    expect(applied, "exactly one of the two deposits applies").toHaveLength(1);
    expect(unmatched, "exactly one is refused by the reservation").toHaveLength(1);
    expect(unmatched[0].body.reason).toContain("already being applied by another deposit");
    expect(unmatched[0].body.officeTaskId).toBeTruthy();

    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.reserve.schedule } });
    expect(schedule.status).toBe("Paid");

    const loserFileId = unmatched[0].body === a.body ? F.reserve.fileIdA : F.reserve.fileIdB;
    const loserRow = await prisma.depositIngest.findUniqueOrThrow({ where: { fileId: loserFileId } });
    expect(loserRow.status).toBe("unmatched");
    expect(loserRow.paymentScheduleId, "the losing row never holds the reservation").toBeNull();
  });

  // ── 5: Crash-after-QBO-create resume — byte-identical replay ────────────────
  test("5: qbo_unknown resume replays the byte-identical request body + requestid and resolves to applied", async ({ request }) => {
    await resetQboMock(request);

    const seededRequestBody = JSON.stringify({
      TotalAmt: F.resume.amount,
      TxnDate: "2026-07-15",
      PaymentRefNum: "5551",
      CustomerRef: { value: "di-mock-cust-resume-1" },
      Line: [{ Amount: F.resume.amount, LinkedTxn: [{ TxnId: F.resume.qbInvoiceId, TxnType: "Invoice" }] }],
    });
    const extracted = {
      fileId: F.resume.fileId, fileUrl: null, fileName: null, projectName: F.resume.projectName,
      payerName: null, amount: F.resume.amount, checkDate: "2026-07-15", checkNumber: "5551", memo: null,
    };
    // processingStartedAt must be OLDER than the 5-minute stale-claim window
    // (route.ts's STALE_PROCESSING_MS) — a fresh lease reads as "another
    // request is actively working this file" and the route bails out with
    // "in progress — retry shortly" WITHOUT ever calling resumeFromQboUnknown.
    await prisma.depositIngest.create({
      data: {
        fileId: F.resume.fileId, status: "qbo_unknown", extracted: JSON.stringify(extracted),
        paymentScheduleId: F.resume.schedule, qbRequestPayload: seededRequestBody, qbPaymentId: null,
        attempts: 1, processingStartedAt: new Date(Date.now() - 6 * 60_000),
      },
    });

    const res = await postDeposit(request, { fileId: F.resume.fileId, projectName: F.resume.projectName, amount: F.resume.amount, checkDate: "2026-07-15", checkNumber: "5551" });
    expect(res.res.status()).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe("applied");

    const row = await prisma.depositIngest.findUniqueOrThrow({ where: { fileId: F.resume.fileId } });
    expect(row.status).toBe("applied");
    expect(row.qbRequestPayload, "the row's persisted request bytes are untouched by the replay").toBe(seededRequestBody);

    const mockState = await getQboMockState(request);
    const expectedRequestId = computeDepositRequestId(F.resume.fileId);
    const replay = mockState.paymentCreateCalls.find((c) => c.requestId === expectedRequestId);
    expect(replay, "the mock received a create call with the route's own requestid").toBeTruthy();
    expect(replay?.requestBody, "replayed body is byte-identical to the seeded qbRequestPayload").toBe(seededRequestBody);

    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.resume.schedule } });
    expect(schedule.status).toBe("Paid");
    expect(schedule.qbPaymentId).toBe(row.qbPaymentId);
  });

  // ── 6: Cron-race rule ────────────────────────────────────────────────────────
  test("6a: qbo_created resume where the cron already settled with OUR qbPaymentId — success-if-same", async ({ request }) => {
    await resetQboMock(request);
    const extracted = {
      fileId: F.cronSame.fileId, fileUrl: null, fileName: null, projectName: F.cronSame.projectName,
      payerName: null, amount: F.cronSame.amount, checkDate: "2026-07-21", checkNumber: "9101", memo: null,
    };
    await prisma.depositIngest.create({
      data: {
        fileId: F.cronSame.fileId, status: "qbo_created", extracted: JSON.stringify(extracted),
        paymentScheduleId: F.cronSame.schedule, qbPaymentId: F.cronSame.qbPaymentId,
        attempts: 1, processingStartedAt: new Date(Date.now() - 6 * 60_000),
      },
    });

    const res = await postDeposit(request, { fileId: F.cronSame.fileId, projectName: F.cronSame.projectName, amount: F.cronSame.amount, checkDate: "2026-07-21", checkNumber: "9101" });
    expect(res.res.status()).toBe(200);
    expect(res.body.status).toBe("applied");

    const row = await prisma.depositIngest.findUniqueOrThrow({ where: { fileId: F.cronSame.fileId } });
    expect(row.status).toBe("applied");

    // resumeFromQboCreated never calls QBO at all (it only settles ProBuild).
    const mockState = await getQboMockState(request);
    expect(mockState.calls.readInvoice).toBe(0);
    expect(mockState.calls.paymentCreate).toBe(0);
  });

  test("6b: qbo_created resume where the milestone settled with a DIFFERENT qbPaymentId — reconcile + one OfficeTask", async ({ request }) => {
    const extracted = {
      fileId: F.cronDiff.fileId, fileUrl: null, fileName: null, projectName: F.cronDiff.projectName,
      payerName: null, amount: F.cronDiff.amount, checkDate: "2026-07-21", checkNumber: "9201", memo: null,
    };
    await prisma.depositIngest.create({
      data: {
        fileId: F.cronDiff.fileId, status: "qbo_created", extracted: JSON.stringify(extracted),
        paymentScheduleId: F.cronDiff.schedule, qbPaymentId: F.cronDiff.rowQbPaymentId,
        attempts: 1, processingStartedAt: new Date(Date.now() - 6 * 60_000),
      },
    });

    const first = await postDeposit(request, { fileId: F.cronDiff.fileId, projectName: F.cronDiff.projectName, amount: F.cronDiff.amount, checkDate: "2026-07-21", checkNumber: "9201" });
    expect(first.res.status()).toBe(200);
    expect(first.body.status).toBe("reconcile");
    expect(first.body.reason).toContain("different QuickBooks payment");
    expect(first.body.officeTaskId).toBeTruthy();

    const row = await prisma.depositIngest.findUniqueOrThrow({ where: { fileId: F.cronDiff.fileId } });
    expect(row.status).toBe("reconcile");

    // Milestone itself is untouched (still Paid with the cron's own qbPaymentId, not ours).
    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.cronDiff.schedule } });
    expect(schedule.qbPaymentId).toBe(F.cronDiff.milestoneQbPaymentId);

    // Second POST (no force) — reconcile is terminal-to-the-bot; task self-heals but never duplicates.
    const second = await postDeposit(request, { fileId: F.cronDiff.fileId, projectName: F.cronDiff.projectName, amount: F.cronDiff.amount, checkDate: "2026-07-21", checkNumber: "9201" });
    expect(second.body.status).toBe("reconcile");
    expect(second.body.officeTaskId).toBe(first.body.officeTaskId);

    const tasks = await officeTasksMentioning(F.cronDiff.fileId);
    expect(tasks, "exactly one OfficeTask even after a second POST").toHaveLength(1);
  });

  // ── 7: Match refusals — each unmatched + exactly ONE OfficeTask ────────────
  test("7a: unresolvable project name", async ({ request }) => {
    const payload = { fileId: F.refuseUnresolvable.fileId, projectName: "Zzqxw Nonexistent Ferngully 9999", amount: 123, checkDate: "2026-07-01", checkNumber: "1001" };
    const first = await postDeposit(request, payload);
    expect(first.body.status).toBe("unmatched");
    // The e2e DB is shared across specs in one CI run: sibling specs' projects can
    // accidentally share two generic words with the gibberish label and turn "no
    // project matched" into "ambiguous" or the first-word weak-match refusal. All
    // three are correct refusals of an unresolvable name — the invariant under test
    // is unmatched + exactly one task, not the specific reason string.
    expect(first.body.reason).toMatch(/no project matched|ambiguous|first word differs/);
    expect(first.body.officeTaskId).toBeTruthy();

    const second = await postDeposit(request, payload);
    expect(second.body.officeTaskId).toBe(first.body.officeTaskId);
    expect(await officeTasksMentioning(F.refuseUnresolvable.fileId)).toHaveLength(1);
  });

  test("7a2: single weak fuzzy match (generic shared words, first word differs) refuses", async ({ request }) => {
    // "Kitchen Remodel" alone scores 2 in the shared matcher — enough to route an
    // expense receipt, not enough to move money. The winner (if unique) must also
    // contain the label's first word (client surname convention).
    const payload = { fileId: F.weakMatch.fileId, projectName: "Zzyxfirst Kitchen Remodel", amount: 123, checkDate: "2026-07-01", checkNumber: "1003" };
    const first = await postDeposit(request, payload);
    expect(first.body.status).toBe("unmatched");
    expect(first.body.reason, "either the weak-match guard fires or sibling-spec data makes it ambiguous — both refuse").toMatch(/first word differs|ambiguous/);
    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.weakMatch.schedule } });
    expect(schedule.status, "no money moved on a weak match").toBe("Pending");
  });

  test("7b: tied project names refuse (findBestProjectNameMatches ties)", async ({ request }) => {
    const payload = { fileId: F.refuseTied.fileId, projectName: F.refuseTied.name, amount: 123, checkDate: "2026-07-01", checkNumber: "1002" };
    const first = await postDeposit(request, payload);
    expect(first.body.status).toBe("unmatched");
    expect(first.body.reason).toContain("ambiguous");
    expect(first.body.officeTaskId).toBeTruthy();

    const second = await postDeposit(request, payload);
    expect(second.body.officeTaskId).toBe(first.body.officeTaskId);
    expect(await officeTasksMentioning(F.refuseTied.fileId)).toHaveLength(1);
  });

  test("7c: zero amount-matching Pending milestones", async ({ request }) => {
    const payload = { fileId: F.refuseZeroAmt.fileId, projectName: F.refuseZeroAmt.projectName, amount: F.refuseZeroAmt.postedAmount, checkDate: "2026-07-01", checkNumber: "1003" };
    const first = await postDeposit(request, payload);
    expect(first.body.status).toBe("unmatched");
    expect(first.body.reason).toContain("no pending milestone");
    expect(first.body.officeTaskId).toBeTruthy();

    const second = await postDeposit(request, payload);
    expect(second.body.officeTaskId).toBe(first.body.officeTaskId);
    expect(await officeTasksMentioning(F.refuseZeroAmt.fileId)).toHaveLength(1);
  });

  test("7d: two amount-matching Pending milestones (ambiguous)", async ({ request }) => {
    const payload = { fileId: F.refuseTwoAmt.fileId, projectName: F.refuseTwoAmt.projectName, amount: F.refuseTwoAmt.amount, checkDate: "2026-07-01", checkNumber: "1004" };
    const first = await postDeposit(request, payload);
    expect(first.body.status).toBe("unmatched");
    expect(first.body.reason).toContain("ambiguous");
    expect(first.body.officeTaskId).toBeTruthy();

    const second = await postDeposit(request, payload);
    expect(second.body.officeTaskId).toBe(first.body.officeTaskId);
    expect(await officeTasksMentioning(F.refuseTwoAmt.fileId)).toHaveLength(1);
  });

  test("7e: missing check number", async ({ request }) => {
    const payload = { fileId: F.refuseNoCheckNumber.fileId, projectName: "Whatever Project Name", amount: 50, checkDate: "2026-07-01" };
    const first = await postDeposit(request, payload);
    expect(first.body.status).toBe("unmatched");
    expect(first.body.reason).toBe("missing check number");
    expect(first.body.officeTaskId).toBeTruthy();

    const second = await postDeposit(request, payload);
    expect(second.body.officeTaskId).toBe(first.body.officeTaskId);
    expect(await officeTasksMentioning(F.refuseNoCheckNumber.fileId)).toHaveLength(1);
  });

  test("7f: missing check date", async ({ request }) => {
    const payload = { fileId: F.refuseNoCheckDate.fileId, projectName: "Whatever Project Name", amount: 50, checkNumber: "2001" };
    const first = await postDeposit(request, payload);
    expect(first.body.status).toBe("unmatched");
    expect(first.body.reason).toBe("missing or invalid check date");
    expect(first.body.officeTaskId).toBeTruthy();

    const second = await postDeposit(request, payload);
    expect(second.body.officeTaskId).toBe(first.body.officeTaskId);
    expect(await officeTasksMentioning(F.refuseNoCheckDate.fileId)).toHaveLength(1);
  });

  test("7g: payer gross-conflict with the client name", async ({ request }) => {
    const payload = {
      fileId: F.refusePayer.fileId, projectName: F.refusePayer.projectName, amount: F.refusePayer.amount,
      checkDate: "2026-07-01", checkNumber: "3001", payerName: "Zqbrandt Talwick",
    };
    const first = await postDeposit(request, payload);
    expect(first.body.status).toBe("unmatched");
    expect(first.body.reason).toContain("shares no name with client");
    expect(first.body.officeTaskId).toBeTruthy();

    const second = await postDeposit(request, payload);
    expect(second.body.officeTaskId).toBe(first.body.officeTaskId);
    expect(await officeTasksMentioning(F.refusePayer.fileId)).toHaveLength(1);
  });

  // ── 8: force=1 ────────────────────────────────────────────────────────────
  test("8a: force=1 re-runs an unmatched pre-QBO row with corrected data and applies", async ({ request }) => {
    const wrong = { fileId: F.forceCorrect.fileId, projectName: F.forceCorrect.projectName, amount: F.forceCorrect.wrongAmount, checkDate: "2026-07-05", checkNumber: "4001" };
    const first = await postDeposit(request, wrong);
    expect(first.body.status).toBe("unmatched");
    expect(first.body.reason).toContain("no pending milestone");

    const corrected = { fileId: F.forceCorrect.fileId, projectName: F.forceCorrect.projectName, amount: F.forceCorrect.correctAmount, checkDate: "2026-07-05", checkNumber: "4001" };
    const second = await postDeposit(request, corrected, { force: true });
    expect(second.res.status()).toBe(200);
    expect(second.body.status).toBe("applied");
    expect(second.body.scheduleId).toBe(F.forceCorrect.schedule);

    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.forceCorrect.schedule } });
    expect(schedule.status).toBe("Paid");
    expect(schedule.referenceNumber).toBe("4001");
  });

  test("8b: force=1 on a row that already crossed the QBO boundary is refused", async ({ request }) => {
    await prisma.depositIngest.create({
      data: {
        fileId: F.forceCrossedQbo.fileId, status: "unmatched",
        extracted: JSON.stringify({ fileId: F.forceCrossedQbo.fileId, projectName: "Whatever", amount: 1, checkDate: "2026-07-01", checkNumber: "1", payerName: null, fileUrl: null, fileName: null, memo: null }),
        qbRequestPayload: JSON.stringify({ TotalAmt: 1 }), attempts: 1,
      },
    });

    const res = await postDeposit(request, { fileId: F.forceCrossedQbo.fileId, projectName: "Whatever", amount: 1, checkDate: "2026-07-01", checkNumber: "1" }, { force: true });
    expect(res.res.status()).toBe(200);
    expect(res.body.status).toBe("unmatched");
    expect(res.body.reason).toContain("reconcile it manually");

    const row = await prisma.depositIngest.findUniqueOrThrow({ where: { fileId: F.forceCrossedQbo.fileId } });
    expect(row.status, "no reprocessing happened").toBe("unmatched");
  });

  // ── 9: Non-QBO-linked milestone ─────────────────────────────────────────────
  test("9: non-QBO-linked milestone applies via recordPaymentCore — no QBO calls, invoice balance recomputed", async ({ request }) => {
    await resetQboMock(request);

    const res = await postDeposit(request, { fileId: F.nonQbo.fileId, projectName: F.nonQbo.projectName, amount: F.nonQbo.amount, checkDate: "2026-07-10", checkNumber: "8001" });
    expect(res.res.status()).toBe(200);
    expect(res.body.status).toBe("applied");

    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.nonQbo.schedule } });
    expect(schedule.status).toBe("Paid");
    expect(schedule.paymentMethod).toBe("check");
    expect(schedule.referenceNumber).toBe("8001");
    expect(schedule.paymentDate?.toISOString().slice(0, 10)).toBe("2026-07-10");

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: F.nonQbo.invoice } });
    expect(Number(invoice.balanceDue)).toBe(0);
    expect(invoice.status).toBe("Paid");

    const notes = await prisma.paymentNotification.findMany({ where: { scheduleId: F.nonQbo.schedule } });
    expect(notes).toHaveLength(1);
    expect(notes[0].status, "recordPaymentCore drains the outbox inline").toBe("PROCESSED");

    const mockState = await getQboMockState(request);
    expect(mockState.calls.readInvoice, "non-QBO path never touches the QuickBooks mock").toBe(0);
    expect(mockState.calls.paymentCreate).toBe(0);
  });

  // ── 12: Non-QBO money-boundary crash recovery (settleStartedAt) ──────────────
  test("12a: settle committed, crash before applied-write — stale reclaim resumes the reserved row and finalizes applied without re-settling", async ({ request }) => {
    await resetQboMock(request);
    const extracted = {
      fileId: F.settleCrash.fileIdSettled, fileUrl: null, fileName: null, projectName: F.settleCrash.projectName,
      payerName: null, amount: F.settleCrash.amountSettled, checkDate: "2026-07-25", checkNumber: "7001", memo: null,
    };
    // Simulate: recordPaymentCore committed (milestone Paid with our method/ref/date),
    // then the process died before the row's applied-write. Boundary marker set,
    // reservation held, lease stale.
    await prisma.paymentSchedule.update({
      where: { id: F.settleCrash.scheduleSettled },
      data: { status: "Paid", paymentMethod: "check", referenceNumber: "7001", paymentDate: new Date("2026-07-25T00:00:00Z"), paidAt: new Date() },
    });
    await prisma.depositIngest.create({
      data: {
        fileId: F.settleCrash.fileIdSettled, status: "processing", extracted: JSON.stringify(extracted),
        paymentScheduleId: F.settleCrash.scheduleSettled, settleStartedAt: new Date(Date.now() - 6 * 60_000),
        attempts: 1, processingStartedAt: new Date(Date.now() - 6 * 60_000),
      },
    });

    const res = await postDeposit(request, {
      fileId: F.settleCrash.fileIdSettled, projectName: F.settleCrash.projectName,
      amount: F.settleCrash.amountSettled, checkDate: "2026-07-25", checkNumber: "7001",
    });
    expect(res.res.status()).toBe(200);
    expect(res.body.status).toBe("applied");

    const row = await prisma.depositIngest.findUniqueOrThrow({ where: { fileId: F.settleCrash.fileIdSettled } });
    expect(row.status).toBe("applied");
    expect(row.paymentScheduleId, "reservation survives the reclaim (boundary marker)").toBe(F.settleCrash.scheduleSettled);
    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.settleCrash.scheduleSettled } });
    expect(schedule.referenceNumber, "the committed settle is untouched").toBe("7001");
    const tasks = await officeTasksMentioning(F.settleCrash.fileIdSettled);
    expect(tasks, "recovered-as-ours is not a review case").toHaveLength(0);
  });

  test("12b: marker set but settle never committed — reclaim keeps the reservation and settles using the PRESERVED extracted payload, not the divergent re-POST", async ({ request }) => {
    const extracted = {
      fileId: F.settleCrash.fileIdUnsettled, fileUrl: null, fileName: null, projectName: F.settleCrash.projectName,
      payerName: null, amount: F.settleCrash.amountUnsettled, checkDate: "2026-07-26", checkNumber: "7002", memo: null,
    };
    await prisma.depositIngest.create({
      data: {
        fileId: F.settleCrash.fileIdUnsettled, status: "processing", extracted: JSON.stringify(extracted),
        paymentScheduleId: F.settleCrash.scheduleUnsettled, settleStartedAt: new Date(Date.now() - 6 * 60_000),
        attempts: 1, processingStartedAt: new Date(Date.now() - 6 * 60_000),
      },
    });

    // The bot re-sends with a DIVERGENT re-extraction (different check number/date):
    // the reserved-row resume must settle with the ORIGINAL stored payload.
    const res = await postDeposit(request, {
      fileId: F.settleCrash.fileIdUnsettled, projectName: F.settleCrash.projectName,
      amount: F.settleCrash.amountUnsettled, checkDate: "2026-07-27", checkNumber: "9999",
    });
    expect(res.res.status()).toBe(200);
    expect(res.body.status).toBe("applied");

    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: F.settleCrash.scheduleUnsettled } });
    expect(schedule.status).toBe("Paid");
    expect(schedule.referenceNumber, "settled with the preserved original check number").toBe("7002");
    expect(schedule.paymentDate?.toISOString().slice(0, 10)).toBe("2026-07-26");
    const row = await prisma.depositIngest.findUniqueOrThrow({ where: { fileId: F.settleCrash.fileIdUnsettled } });
    expect(row.status).toBe("applied");
  });

  // ── 10: Auth ─────────────────────────────────────────────────────────────────
  test("10a: missing Authorization header is refused with 401", async ({ request }) => {
    const { res } = await postDeposit(request, { fileId: "di-e2e-auth-no-header", projectName: "X", amount: 1 }, { authHeader: null });
    expect(res.status()).toBe(401);
  });

  test("10b: wrong secret is refused with 401", async ({ request }) => {
    const { res } = await postDeposit(request, { fileId: "di-e2e-auth-wrong-secret", projectName: "X", amount: 1 }, { authHeader: "Bearer this-is-not-the-secret" });
    expect(res.status()).toBe(401);
  });

  // NOTE: the "DEPOSIT_INGEST_SECRET unset" fail-closed branch
  // (`if (!secret) return 401` at the top of the route) is NOT covered here —
  // the secret is read from process.env at request time by the already-running
  // server under test, and this spec has no way to unset it and restart that
  // server mid-suite. Covered instead by code inspection (the same "fail
  // closed when unset" pattern as /api/office-tasks/ingest) and the plan's
  // manual verification step.

  // ── 11: Validation ───────────────────────────────────────────────────────────
  test("11a: a JSON `null` body is rejected with 400", async ({ request }) => {
    const { res, body } = await postDeposit(request, null, { rawData: "null" });
    expect(res.status()).toBe(400);
    expect(body.ok).toBe(false);
  });

  test("11b: an amount with more than 2 decimal places is rejected with 400", async ({ request }) => {
    const { res, body } = await postDeposit(request, {
      fileId: F.validation.fileId, projectName: "Whatever Project", amount: 12.345, checkDate: "2026-07-01", checkNumber: "1",
    });
    expect(res.status()).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("2 decimal places");
  });
});
