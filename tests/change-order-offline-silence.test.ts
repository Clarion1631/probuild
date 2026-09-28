/**
 * OWNER ACCEPTANCE TEST (spec G7): an office "Mark approved" must never notify
 * the customer, by any channel, unless staff explicitly sends something.
 *
 * Every path that could reach the customer after an offline approval is driven
 * here against the REAL billing-core, payment-reminders, payment-notifications
 * and co-billing-sweep route, with a fake in-memory Prisma that evaluates
 * `where` clauses with SQL three-valued logic (tests/helpers). Email, SMS,
 * QuickBooks and the network are recorded and must stay empty.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_EMAIL, NOW, TEAM_EMAIL, evalWhere, loadModules, makeWorld, setWorld, type Row, type World } from "./helpers/co-offline-harness";

let billing: Row;
let reminders: Row;
let notifications: Row;
let sweep: Row;
let restore: () => void;
let world: World;

before(async () => {
    world = makeWorld();
    setWorld(world);
    const loaded = await loadModules();
    ({ billing, reminders, notifications, sweep, restore } = loaded);
});
after(() => restore?.());

const ACTOR = { userId: "user-1", name: "Jordan Lee" };
const DAY = 86_400_000;

function fresh(options: Parameters<typeof makeWorld>[0] = {}) {
    world = makeWorld({ scheduleAmounts: [400, 600], ...options });
    setWorld(world);
}

async function approveOffline() {
    const result = await billing.approveChangeOrderOfflineCore("co-1", {
        method: "TEXT",
        approvedOn: "2026-09-27",
        note: "internal note",
        expectedUpdatedAt: world.state.co.updatedAt.toISOString(),
        actor: ACTOR,
    }, { now: () => NOW, logActivity: async () => {}, applySchedule: async () => {} });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
}

/** Puts the milestones in the reminder window: due tomorrow on an Issued invoice. */
function dueTomorrow() {
    for (const milestone of world.state.milestones) milestone.dueDate = new Date(Date.now() + DAY);
}
/** Puts the approval inside the sweep's 15 minute to 2 hour band. */
function approvedHalfAnHourAgo() {
    world.state.co.approvedAt = new Date(Date.now() - 30 * 60_000);
}
function assertNothingReachedCustomer(label: string) {
    assert.equal(world.customerEmails().length, 0, `${label}: an email reached the customer`);
    assert.equal(world.sms.length, 0, `${label}: an SMS was sent`);
    assert.equal(world.qbCalls.length, 0, `${label}: QuickBooks was called`);
    assert.equal(world.fetchCalls.length, 0, `${label}: the network was called`);
}
function sweepRequest() {
    return new Request("http://localhost/api/cron/co-billing-sweep");
}

// ── Sweep ───────────────────────────────────────────────────────────────────

test("T3 sweep: the where clause carries approvalSource: null and skips an offline approval", async () => {
    fresh();
    await approveOffline();
    approvedHalfAnHourAgo();
    const wheres: Row[] = [];
    const original = world.prisma.changeOrder.findMany;
    world.prisma.changeOrder.findMany = async (args: Row) => { wheres.push(args.where); return original(args); };

    const response = await sweep.GET(sweepRequest());
    const body = await response.json();
    assert.equal(wheres.length, 1);
    assert.ok("approvalSource" in wheres[0] && wheres[0].approvalSource === null, "explicit null filter, not { not: 'OFFLINE' }");
    assert.equal(body.checked, 0);
    assertNothingReachedCustomer("sweep");
    assert.equal(world.emails.length, 1, "only the team email from the approval itself");
    assert.equal(world.emails[0].to, TEAM_EMAIL);
});

test("T3 sweep: a signed change order is still swept (the null filter does not drop signed rows)", async () => {
    fresh({ status: "Approved", signed: true });
    approvedHalfAnHourAgo();
    const response = await sweep.GET(sweepRequest());
    const body = await response.json();
    assert.equal(body.checked, 1);
    // The signed path bills and then tries to send: the send path reaches QuickBooks exactly once.
    assert.equal(world.state.milestones.length, 2);
    assert.ok(world.qbCalls.length >= 1, "the signed path reached the QuickBooks send rail");
});

test("T3 guard: handleChangeOrderApproved returns early for an offline approval, before billing, sending, or notifying", async () => {
    fresh();
    await approveOffline();
    // Simulate a sweep whose filter was bypassed and a CO with nothing billed yet.
    world.state.milestones.length = 0;
    world.state.invoices[0].totalAmount = 5500;
    world.emails.length = 0;

    const summary = await billing.handleChangeOrderApproved("co-1", { freshlyApproved: true });
    assert.deepEqual(summary, { billed: false, sent: false, issues: [], skippedOffline: true });
    assert.equal(world.state.milestones.length, 0, "nothing billed");
    assert.equal(world.emails.length, 0, "not even the team email");
    assertNothingReachedCustomer("guard");
});

test("T3 guard: a signed change order behaves as today (send path invoked once for fresh milestones)", async () => {
    fresh({ status: "Approved", signed: true });
    const summary = await billing.handleChangeOrderApproved("co-1");
    assert.equal(summary.skippedOffline, undefined);
    assert.equal(summary.billed, true);
    assert.equal(world.state.milestones.length, 2);
    assert.ok(world.qbCalls.length >= 1, "the signed path reached the QuickBooks send rail");
});

// ── Payment reminders ───────────────────────────────────────────────────────

test("T3 reminders: milestones from an offline approval are held until staff sends them", async () => {
    fresh();
    await approveOffline();
    dueTomorrow();

    const dry = await reminders.sendPaymentReminders({ dryRun: true });
    assert.equal(dry.scanned, 0, "selection carries the hold");

    const live = await reminders.sendPaymentReminders();
    assert.equal(live.sent, 0);
    assert.equal(live.scanned, 0);
    assertNothingReachedCustomer("reminders");
});

test("T3 reminders: the SAME milestones ARE reminded when the offline flag is absent (the test can fail)", async () => {
    fresh();
    await approveOffline();
    dueTomorrow();
    world.state.co.approvalSource = null; // control: pretend it was a signed CO
    const dry = await reminders.sendPaymentReminders({ dryRun: true });
    assert.equal(dry.scanned, 2);
});

test("T3 reminders: an ordinary unrequested milestone (no source change order) is still reminded", async () => {
    fresh();
    await approveOffline();
    dueTomorrow();
    world.state.milestones.push({
        id: "ms-ordinary", invoiceId: "inv-1", name: "Deposit", amount: 500, status: "Pending", dueDate: new Date(Date.now() + DAY),
        sourceChangeOrderId: null, qbInvoiceSentAt: null, qbInvoiceLink: null, lastReminderAt: null, sourceScheduleId: null,
    });
    const dry = await reminders.sendPaymentReminders({ dryRun: true });
    assert.equal(dry.scanned, 1, "exactly the ordinary milestone; the NULL trap must not drop it");
});

test("T3 reminders: once staff sends the milestone (qbInvoiceSentAt set) normal reminder rules apply again", async () => {
    fresh();
    await approveOffline();
    dueTomorrow();
    const [first, second] = world.state.milestones;
    first.qbInvoiceSentAt = new Date();
    first.qbInvoiceLink = "https://example.test/pay/1"; // hosted link: skips the portal-link builder
    const selects: Row[] = [];
    const claims: Row[] = [];
    const findMany = world.prisma.paymentSchedule.findMany;
    const updateMany = world.prisma.paymentSchedule.updateMany;
    world.prisma.paymentSchedule.findMany = async (args: Row) => { selects.push(args.where); return findMany(args); };
    world.prisma.paymentSchedule.updateMany = async (args: Row) => { claims.push(args.where); return updateMany(args); };

    const live = await reminders.sendPaymentReminders();
    assert.equal(live.scanned, 1);
    assert.equal(world.customerEmails().length, 1, "the requested milestone is reminded, as before");
    assert.equal(world.customerEmails()[0].to, CLIENT_EMAIL);

    // Both the selection and the claim carry the hold, and the claim would refuse the held row.
    assert.match(JSON.stringify(selects[0]), /"notIn":\["co-1"\]/);
    assert.match(JSON.stringify(claims[0]), /"notIn":\["co-1"\]/);
    const { id: _claimedId, ...claimWhere } = claims[0];
    first.lastReminderAt = null; // the live run above stamped the throttle; evaluate the claim as it saw the row
    assert.equal(evalWhere(first, claimWhere), true);
    assert.equal(evalWhere(second, claimWhere), false, "a held milestone can never be claimed");
});

// ── Paid receipt ────────────────────────────────────────────────────────────

function settle(milestone: Row) {
    milestone.status = "Paid";
    milestone.paymentDate = new Date();
    milestone.paidAt = new Date();
    milestone.paymentMethod = "check";
}

test("T3 receipt: a held milestone alerts the team and logs activity but sends the customer no receipt", async () => {
    fresh();
    await approveOffline();
    world.emails.length = 0;
    const milestone = world.state.milestones[0];
    settle(milestone);

    const result = await notifications.notifyMilestonePaid(milestone.id);
    assert.equal(result.ok, true);
    assert.equal(world.emails.length, 1);
    assert.equal(world.emails[0].to, TEAM_EMAIL);
    assert.equal(world.state.activity.filter((row) => row.action === "payment_received").length, 1);
    assert.equal(milestone.receiptSentAt, null, "receiptSentAt stays null so the Send Receipt button still works");
    assertNothingReachedCustomer("receipt");
});

test("T3 receipt: after staff sends the milestone the automatic receipt goes out as today", async () => {
    fresh();
    await approveOffline();
    world.emails.length = 0;
    const milestone = world.state.milestones[0];
    milestone.qbInvoiceSentAt = new Date();
    settle(milestone);

    await notifications.notifyMilestonePaid(milestone.id);
    assert.equal(world.customerEmails().length, 1);
    assert.equal(world.customerEmails()[0].to, CLIENT_EMAIL);
    assert.ok(milestone.receiptSentAt instanceof Date);
});

test("T3 receipt: an ordinary milestone still gets its automatic receipt", async () => {
    fresh();
    await approveOffline();
    world.emails.length = 0;
    world.state.milestones.push({
        id: "ms-ordinary", invoiceId: "inv-1", name: "Deposit", amount: 500, status: "Pending", dueDate: null,
        sourceChangeOrderId: null, qbInvoiceSentAt: null, lastReminderAt: null, receiptSentAt: null, paymentDate: null, referenceNumber: null,
    });
    const milestone = world.state.milestones.find((row) => row.id === "ms-ordinary")!;
    settle(milestone);
    await notifications.notifyMilestonePaid("ms-ordinary");
    assert.equal(world.customerEmails().length, 1);
});

// ── End to end ──────────────────────────────────────────────────────────────

test("T3 end to end: approve, sweep, reminders, record payment, receipts. Zero customer sends, zero SMS, zero QuickBooks calls", async () => {
    fresh();
    await approveOffline();
    approvedHalfAnHourAgo();
    dueTomorrow();

    const swept = await (await sweep.GET(sweepRequest())).json();
    assert.equal(swept.checked, 0);

    const reminded = await reminders.sendPaymentReminders();
    assert.equal(reminded.sent, 0);

    // Staff records the customer's earlier payment on the first milestone, then the notifier drains.
    const milestone = world.state.milestones[0];
    settle(milestone);
    await notifications.notifyMilestonePaid(milestone.id, { dedupeKey: "outbox-1" });
    // The outbox drainer retries; a second delivery must stay silent too.
    await notifications.notifyMilestonePaid(milestone.id, { dedupeKey: "outbox-1" });

    assertNothingReachedCustomer("end to end");
    assert.ok(world.emails.length >= 2);
    assert.ok(world.emails.every((mail) => mail.to === TEAM_EMAIL), `only the team was emailed: ${world.emails.map((m) => m.to).join(", ")}`);
    assert.equal(world.state.milestones.every((row) => row.qbInvoiceSentAt === null), true, "nothing was marked as requested");
});

// ── Source-level tripwires ──────────────────────────────────────────────────

test("T3 tripwire: the offline core never references a customer send function", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(__dirname, "..", "src", "lib", "billing-core.ts"), "utf8");
    const start = src.indexOf("export async function approveChangeOrderOfflineCore(");
    const end = src.indexOf("export async function handleChangeOrderApproved(");
    const body = src.slice(start, end);
    assert.ok(start > 0 && end > start);
    // Comments explain what the path avoids; only executable text matters.
    const code = body.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    for (const forbidden of ["sendMilestoneInvoicesCore", "pushMilestoneToQuickBooks", "sendChangeOrderToClientCore", "sendSMS", "handleChangeOrderApproved", "client.email", "clientEmail"]) {
        assert.ok(!code.includes(forbidden), `approveChangeOrderOfflineCore must not reference ${forbidden}`);
    }
    // The single email goes to the team address.
    assert.match(code, /notificationEmail\?\.trim\(\) \|\| settings\?\.email\?\.trim\(\)/);
});

test("T3 reminders: an approval that commits AFTER the offline-id snapshot is still held by the live per-milestone check", async () => {
    fresh();
    await approveOffline();
    dueTomorrow();
    // The run read its offline id list before the approval committed, so the list is empty and
    // the selection and claim holds are absent. The live check must still stop the send.
    world.prisma.changeOrder.findMany = async () => [];
    const live = await reminders.sendPaymentReminders();
    assert.equal(live.sent, 0);
    assert.equal(live.skipped, 2);
    assertNothingReachedCustomer("stale snapshot");
});

test("T3 receipt: provenance is re-read fresh, so a stale first read cannot send the customer a receipt", async () => {
    fresh();
    await approveOffline();
    world.emails.length = 0;
    const milestone = world.state.milestones[0];
    settle(milestone);
    // The row read at the top of the function predates the milestone being linked to the offline CO.
    const original = world.prisma.paymentSchedule.findUnique;
    let calls = 0;
    world.prisma.paymentSchedule.findUnique = async (args: Row) => {
        calls += 1;
        const row = await original(args);
        return calls === 1 ? { ...row, sourceChangeOrderId: null, qbInvoiceSentAt: null } : row;
    };
    await notifications.notifyMilestonePaid(milestone.id);
    assert.ok(calls >= 2, "a second, fresh read happened");
    assert.equal(world.customerEmails().length, 0);
    assert.equal(milestone.receiptSentAt, null);
});

test("T3 reminders: a milestone linked to an offline CO after selection is not claimed", async () => {
    fresh();
    await approveOffline();
    dueTomorrow();
    for (const m of world.state.milestones) m.qbInvoiceLink = "https://example.test/pay"; // hosted link: a claim WOULD send
    // Selection sees stale rows (no provenance) and an empty offline id list.
    world.prisma.changeOrder.findMany = async () => [];
    const original = world.prisma.paymentSchedule.findMany;
    world.prisma.paymentSchedule.findMany = async (args: Row) => (await original(args)).map((row: Row) => ({ ...row, sourceChangeOrderId: null }));
    const live = await reminders.sendPaymentReminders();
    assert.equal(live.sent, 0);
    assert.equal(world.state.milestones.every((m) => m.lastReminderAt === null), true, "no claim landed");
    assertNothingReachedCustomer("claim race");
});
