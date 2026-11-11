/**
 * splitPendingMilestoneCore through the REAL billing-core + payment-record-core, hermetic.
 *
 * Same in-memory world as the change-order tests (tests/helpers/co-offline-harness): fake Prisma
 * with SQL three-valued where evaluation, QuickBooks / email / SMS / network throw or are
 * recorded. Splits ONE pending milestone into two rows that sum to the original so the normal
 * Record Payment flow can settle the part the client actually paid.
 * Fixture data is generic; the repo is public.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { partialSplitCents } from "../src/lib/milestone-split";
import { attachCheckoutSessionIfUnchanged } from "../src/lib/stripe-session-attach";
import { loadModules, makeWorld, setWorld, type Row, type World } from "./helpers/co-offline-harness";

let billing: Row;
let paymentRecord: Row;
let restore: () => void;
let world: World;

before(async () => {
    process.env.CLIENT_PORTAL_SECRET ??= "test-only-portal-secret";
    world = makeWorld();
    setWorld(world);
    ({ billing, paymentRecord, restore } = await loadModules());
});
after(() => restore?.());

const cents = (n: unknown) => Math.round(Number(n) * 100);

function milestone(id: string, name: string, amount: number, extra: Row = {}): Row {
    return {
        id, invoiceId: "inv-1", name, amount, pretaxAmount: null, taxAmount: null, status: "Pending", dueDate: null,
        qbInvoiceId: null, qbInvoiceLink: null, qbSyncError: null, qbInvoiceSentAt: null, lastReminderAt: null, receiptSentAt: null,
        stripeSessionId: null, stripePaymentIntentId: null, paidAt: null, paymentDate: null, paymentMethod: null, referenceNumber: null,
        sourceChangeOrderId: null, sourceCoScheduleId: null, sourceScheduleId: null, scheduleTaskId: null,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        ...extra,
    };
}

function estimateRow(id: string, name: string, amount: number, extra: Row = {}): Row {
    return {
        id, estimateId: "est-1", name, amount, status: "Pending", dueDate: null, order: 0, percentage: 50, scheduleTaskId: null,
        stripeSessionId: null, stripePaymentIntentId: null, paymentDate: null, paidAt: null,
        ...extra,
    };
}

/**
 * Invoice $60,000: a mirrored $37,000 milestone (the one that gets split), another mirrored
 * $20,000 row, and a QuickBooks-linked change-order row ($3,000, with its billing row).
 * The estimate carries only the two mirrored rows ($57,000).
 */
function freshWorld() {
    world = makeWorld();
    setWorld(world);
    const s = world.state;
    Object.assign(s.invoices[0], { subtotal: 60000, taxAmount: 0, totalAmount: 60000, balanceDue: 60000, status: "Issued" });
    Object.assign(s.estimate, { id: "est-1", totalAmount: 57000, balanceDue: 57000, status: "Approved", itemsRevision: 5 });
    s.estimateSchedules.push(
        estimateRow("eps-a", "Cabinets", 37000, { order: 1 }),
        estimateRow("eps-b", "Final", 20000, { order: 2 }),
    );
    s.milestones.push(
        milestone("ms-a", "Cabinets", 37000, { sourceScheduleId: "eps-a" }),
        milestone("ms-b", "Final", 20000, { sourceScheduleId: "eps-b" }),
        milestone("ms-co", "CO-00001 Extra", 3000, { qbInvoiceId: "qb-9", qbInvoiceLink: "https://example.test/pay", sourceChangeOrderId: "co-1" }),
    );
    s.billings.push({ id: "cob-1", changeOrderId: "co-1", paymentScheduleId: "ms-co", label: "Extra", totalCents: 300000, snapshot: { invoiceId: "inv-1" } });
}

function split(first: number, remainder: number, id = "ms-a", remainderName?: string | null) {
    return billing.splitPendingMilestoneCore(id, { firstAmount: first, remainderAmount: remainder, remainderName });
}

function assertNoCustomerContact(label: string) {
    assert.equal(world.customerEmails().length, 0, `${label}: an email reached the customer`);
    assert.equal(world.sms.length, 0, `${label}: an SMS was sent`);
    assert.equal(world.qbCalls.length, 0, `${label}: QuickBooks was called`);
    assert.equal(world.fetchCalls.length, 0, `${label}: the network was called`);
    assert.equal(world.enqueues.length, 0, `${label}: a payment notification was enqueued`);
    assert.equal(world.state.activity.length, 0, `${label}: an activity row was written`);
}

const sum = (rows: Row[]) => rows.reduce((total, row) => total + cents(row.amount), 0);
const snapshotOf = () => JSON.stringify({
    milestones: world.state.milestones, invoices: world.state.invoices, estimateSchedules: world.state.estimateSchedules, estimate: world.state.estimate,
});

// eslint-disable-next-line no-unused-vars -- parameter name in a function TYPE
async function assertRefusal(label: string, run: () => Promise<unknown>, message: RegExp | ((error: Error) => boolean)) {
    const before = snapshotOf();
    await assert.rejects(run, (e: Error) => (typeof message === "function" ? message(e) : message.test(e.message)), label);
    assert.equal(snapshotOf(), before, `${label}: something changed on a refused split`);
    assertNoCustomerContact(label);
}

// ── Main flow ────────────────────────────────────────────────────────────────

test("splits a mirrored pending milestone, leaves the invoice alone, then Record Payment settles just the first part", async () => {
    freshWorld();
    const s = world.state;
    const invoiceBefore = { ...s.invoices[0] };
    const coBefore = JSON.stringify(s.milestones.find((m) => m.id === "ms-co"));
    const milestoneSumBefore = sum(s.milestones);
    const mirroredBefore = sum(s.milestones.filter((m) => m.sourceScheduleId));
    const estimateSumBefore = sum(s.estimateSchedules);

    const result = await split(30000, 7000);
    assert.equal(result.success, true);
    assert.equal(result.firstId, "ms-a");
    assert.equal(result.projectId, "proj-1");
    assert.equal(result.invoiceId, "inv-1");

    const first = s.milestones.find((m) => m.id === "ms-a")!;
    assert.equal(first.amount, 30000);
    assert.equal(first.name, "Cabinets");
    assert.equal(first.sourceScheduleId, "eps-a", "the original keeps its mirror link");
    assert.equal(first.status, "Pending");

    const rest = s.milestones.find((m) => m.id === result.remainderId)!;
    assert.equal(rest.amount, 7000);
    assert.equal(rest.name, "Cabinets (remaining)");
    assert.equal(rest.status, "Pending");
    assert.equal(rest.invoiceId, "inv-1");
    assert.ok(rest.sourceScheduleId && rest.sourceScheduleId !== "eps-a", "the remainder links to a NEW estimate row");

    const estFirst = s.estimateSchedules.find((e) => e.id === "eps-a")!;
    assert.equal(estFirst.amount, 30000);
    assert.equal(estFirst.percentage, null);
    const estRest = s.estimateSchedules.find((e) => e.id === rest.sourceScheduleId)!;
    assert.equal(estRest.amount, 7000);
    assert.equal(estRest.status, "Pending");
    assert.equal(estRest.name, "Cabinets (remaining)");
    assert.equal(estRest.estimateId, "est-1");
    assert.equal(estRest.order, 1);

    const invoice = s.invoices[0];
    assert.equal(invoice.totalAmount, invoiceBefore.totalAmount);
    assert.equal(invoice.balanceDue, invoiceBefore.balanceDue);
    assert.equal(invoice.status, invoiceBefore.status);
    assert.equal(sum(s.milestones), milestoneSumBefore);
    assert.equal(sum(s.milestones.filter((m) => m.sourceScheduleId)), mirroredBefore);
    assert.equal(sum(s.estimateSchedules), estimateSumBefore);
    assert.equal(JSON.stringify(s.milestones.find((m) => m.id === "ms-co")), coBefore, "the QuickBooks-linked CO row is untouched");
    assert.equal(s.milestones.length, 4);
    assertNoCustomerContact("split");
    assert.equal(s.estimate.itemsRevision, 6, "a mirrored split bumps itemsRevision by exactly 1 so a stale editor tab cannot overwrite it");
    assert.equal(s.estimate.totalAmount, 57000);
    assert.equal(s.estimate.balanceDue, 57000);
    assert.equal(s.estimate.status, "Approved");

    // The existing Record Payment flow settles the first part only.
    const paid = await paymentRecord.recordPaymentCore("ms-a", "inv-1", {
        paymentDate: new Date("2026-10-22T12:00:00.000Z"), method: "check", referenceNumber: "1001", notes: null,
    });
    assert.equal(paid.success, true, JSON.stringify(paid));
    assert.equal(s.milestones.find((m) => m.id === "ms-a")!.status, "Paid");
    const remainder = s.milestones.find((m) => m.id === result.remainderId)!;
    assert.equal(remainder.status, "Pending");
    for (const key of ["qbInvoiceId", "qbInvoiceLink", "qbSyncError", "stripeSessionId", "stripePaymentIntentId", "paymentMethod", "paidAt"]) {
        assert.equal(remainder[key] ?? null, null, `remainder.${key} must stay empty so it is payable`);
    }
    assert.equal(cents(s.invoices[0].balanceDue), cents(invoiceBefore.balanceDue) - 3000000, "balanceDue dropped by exactly the first part");
    assert.equal(s.estimateSchedules.find((e) => e.id === "eps-a")!.status, "Paid");
    assert.equal(s.estimateSchedules.find((e) => e.id === rest.sourceScheduleId)!.status, "Pending");
    assert.equal(world.enqueues.length, 1, "only the settle enqueued a notification (the split enqueued none)");
});

test("a custom remainder name is trimmed and used on both sides", async () => {
    freshWorld();
    const result = await split(30000, 7000, "ms-a", "  Cabinets balance  ");
    const rest = world.state.milestones.find((m) => m.id === result.remainderId)!;
    assert.equal(rest.name, "Cabinets balance");
    assert.equal(world.state.estimateSchedules.find((e) => e.id === rest.sourceScheduleId)!.name, "Cabinets balance");
});

// ── Tax columns ──────────────────────────────────────────────────────────────

test("pretax/tax columns split so each column still sums to the original and each row adds up", async () => {
    freshWorld();
    Object.assign(world.state.milestones.find((m) => m.id === "ms-a")!, { pretaxAmount: 34000, taxAmount: 3000 });
    const result = await split(30000, 7000);
    const a = world.state.milestones.find((m) => m.id === "ms-a")!;
    const b = world.state.milestones.find((m) => m.id === result.remainderId)!;
    // Worked by hand, in cents: pretax1 = round(3,400,000 * 3,000,000 / 3,700,000) = round(2,756,756.76) = 2,756,757
    // tax1 = 3,000,000 - 2,756,757 = 243,243; pretax2 = 3,400,000 - 2,756,757 = 643,243; tax2 = 300,000 - 243,243 = 56,757.
    assert.equal(a.pretaxAmount, 27567.57);
    assert.equal(a.taxAmount, 2432.43);
    assert.equal(a.amount, 30000);
    assert.equal(b.pretaxAmount, 6432.43);
    assert.equal(b.taxAmount, 567.57);
    assert.equal(b.amount, 7000);
    // Exact column sums, in integer cents from the literals (no rounding helper involved).
    assert.equal(2756757 + 643243, 3400000);
    assert.equal(243243 + 56757, 300000);
    assert.equal(2756757 + 243243, 3000000);
    assert.equal(643243 + 56757, 700000);
});

test("a legacy row with both tax columns null leaves both null on both rows", async () => {
    freshWorld();
    const result = await split(30000, 7000);
    const a = world.state.milestones.find((m) => m.id === "ms-a")!;
    const b = world.state.milestones.find((m) => m.id === result.remainderId)!;
    for (const row of [a, b]) {
        assert.equal(row.pretaxAmount ?? null, null);
        assert.equal(row.taxAmount ?? null, null);
    }
});

test("awkward tax rounding still sums exactly in both columns", async () => {
    freshWorld();
    // $33.33 pretax + $2.93 tax = $36.26 milestone, split at $10.01 / $26.25 (does not divide evenly).
    Object.assign(world.state.milestones.find((m) => m.id === "ms-a")!, { amount: 36.26, pretaxAmount: 33.33, taxAmount: 2.93 });
    Object.assign(world.state.estimateSchedules.find((e) => e.id === "eps-a")!, { amount: 36.26 });
    const result = await split(10.01, 26.25);
    const a = world.state.milestones.find((m) => m.id === "ms-a")!;
    const b = world.state.milestones.find((m) => m.id === result.remainderId)!;
    // Worked by hand, in cents: pretax1 = round(3,333 * 1,001 / 3,626) = round(920.11) = 920; tax1 = 1,001 - 920 = 81;
    // pretax2 = 3,333 - 920 = 2,413; tax2 = 293 - 81 = 212.
    assert.equal(a.pretaxAmount, 9.2);
    assert.equal(a.taxAmount, 0.81);
    assert.equal(a.amount, 10.01);
    assert.equal(b.pretaxAmount, 24.13);
    assert.equal(b.taxAmount, 2.12);
    assert.equal(b.amount, 26.25);
    assert.equal(920 + 2413, 3333);
    assert.equal(81 + 212, 293);
    assert.equal(920 + 81, 1001);
    assert.equal(2413 + 212, 2625);
});

test("one-cent parts are allowed (36,999.99 + 0.01)", async () => {
    freshWorld();
    const result = await split(36999.99, 0.01);
    assert.equal(cents(world.state.milestones.find((m) => m.id === "ms-a")!.amount), 3699999);
    assert.equal(cents(world.state.milestones.find((m) => m.id === result.remainderId)!.amount), 1);
});

// ── Carried fields ───────────────────────────────────────────────────────────

test("dueDate, qbInvoiceSentAt, lastReminderAt and scheduleTaskId carry onto the remainder", async () => {
    freshWorld();
    const due = new Date("2026-11-15T00:00:00.000Z");
    const sent = new Date("2026-10-01T17:00:00.000Z");
    const reminded = new Date("2026-10-10T17:00:00.000Z");
    Object.assign(world.state.milestones.find((m) => m.id === "ms-a")!, { dueDate: due, qbInvoiceSentAt: sent, lastReminderAt: reminded, scheduleTaskId: "task-1" });
    Object.assign(world.state.estimateSchedules.find((e) => e.id === "eps-a")!, { dueDate: due, scheduleTaskId: "task-9" });
    const result = await split(30000, 7000);
    const rest = world.state.milestones.find((m) => m.id === result.remainderId)!;
    assert.equal(rest.dueDate.getTime(), due.getTime());
    assert.equal(rest.qbInvoiceSentAt.getTime(), sent.getTime());
    assert.equal(rest.lastReminderAt.getTime(), reminded.getTime());
    assert.equal(rest.scheduleTaskId, "task-1");
    const estRest = world.state.estimateSchedules.find((e) => e.id === rest.sourceScheduleId)!;
    assert.equal(estRest.dueDate.getTime(), due.getTime());
    assert.equal(estRest.scheduleTaskId, "task-9");
    assert.equal(rest.qbInvoiceId ?? null, null);
    assert.equal(rest.stripeSessionId ?? null, null);
});

// ── Invoice-only row ─────────────────────────────────────────────────────────

test("a row with no estimate link splits invoice-side only, with no estimate writes", async () => {
    freshWorld();
    world.state.milestones.push(milestone("ms-x", "Extra charge", 1000));
    const estimatesBefore = JSON.stringify(world.state.estimateSchedules);
    const estimateBefore = JSON.stringify(world.state.estimate);
    const result = await split(400, 600, "ms-x");
    assert.equal(JSON.stringify(world.state.estimateSchedules), estimatesBefore);
    assert.equal(JSON.stringify(world.state.estimate), estimateBefore);
    assert.equal(world.state.estimate.itemsRevision, 5, "an invoice-only split leaves itemsRevision alone");
    const rest = world.state.milestones.find((m) => m.id === result.remainderId)!;
    assert.equal(rest.amount, 600);
    assert.equal(rest.sourceScheduleId, null);
    assert.equal(world.state.milestones.find((m) => m.id === "ms-x")!.amount, 400);
    assertNoCustomerContact("invoice-only split");
});

// ── Refusals ─────────────────────────────────────────────────────────────────

const ms = (id = "ms-a") => world.state.milestones.find((m) => m.id === id)!;

test("refuses a missing milestone", async () => {
    freshWorld();
    await assertRefusal("missing", () => split(1, 1, "nope"), /Milestone not found/);
});

test("refuses a Paid milestone", async () => {
    freshWorld();
    Object.assign(ms(), { status: "Paid" });
    await assertRefusal("paid", () => split(30000, 7000), /only pending milestones can be split/i);
});

test("refuses while a Stripe checkout session is open", async () => {
    freshWorld();
    Object.assign(ms(), { stripeSessionId: "cs_test_1" });
    await assertRefusal("stripe session", () => split(30000, 7000), /payment is in progress/i);
});

test("refuses while a Stripe payment intent exists", async () => {
    freshWorld();
    Object.assign(ms(), { stripePaymentIntentId: "pi_test_1" });
    await assertRefusal("stripe intent", () => split(30000, 7000), /payment is in progress/i);
});

test("refuses a QuickBooks-linked milestone and points at Break QB Link", async () => {
    freshWorld();
    Object.assign(ms(), { qbInvoiceId: "qb-1" });
    await assertRefusal("qb linked", () => split(30000, 7000), /Break QB Link/);
});

test("refuses an ambiguous-create marker with QBResolveRequiredError", async () => {
    freshWorld();
    Object.assign(ms(), { qbSyncError: "ambiguous-create" });
    await assertRefusal("ambiguous", () => split(30000, 7000), (e) => e.name === "QBResolveRequiredError");
});

test("refuses any other QuickBooks error flag", async () => {
    freshWorld();
    Object.assign(ms(), { qbSyncError: "QuickBooks said no" });
    await assertRefusal("qb flag", () => split(30000, 7000), /QuickBooks/);
});

test("refuses parts that do not add up, naming the current amount and what was entered", async () => {
    freshWorld();
    await assertRefusal("sum", () => split(30000, 6000), (e) => /37,000/.test(e.message) && /36,000/.test(e.message) && /refresh/i.test(e.message));
});

test("refuses a zero part, a negative part and NaN", async () => {
    freshWorld();
    await assertRefusal("zero first", () => split(0, 37000), /greater than zero/);
    await assertRefusal("zero remainder", () => split(37000, 0), /greater than zero/);
    await assertRefusal("negative", () => split(-1, 37001), /greater than zero/);
    await assertRefusal("NaN", () => split(Number.NaN, 37000), /greater than zero/);
});

test("refuses a change-order milestone (provenance on the row)", async () => {
    freshWorld();
    Object.assign(ms(), { sourceChangeOrderId: "co-1" });
    await assertRefusal("co provenance", () => split(30000, 7000), /change-order/i);
    freshWorld();
    Object.assign(ms(), { sourceCoScheduleId: "cos-1" });
    await assertRefusal("co schedule", () => split(30000, 7000), /change-order/i);
});

test("refuses a milestone that has a change-order billing row", async () => {
    freshWorld();
    world.state.billings.push({ id: "cob-2", changeOrderId: "co-1", paymentScheduleId: "ms-a", label: "Billing", totalCents: 1, snapshot: {} });
    await assertRefusal("co billing", () => split(30000, 7000), /change-order/i);
});

test("refuses a milestone a credit change order lowered", async () => {
    freshWorld();
    world.state.billings.push({
        id: "cob-3", changeOrderId: "co-1", paymentScheduleId: null, label: "Credit", totalCents: -50000,
        snapshot: { invoiceId: "inv-1", kind: "credit", paymentScheduleId: "ms-a" },
    });
    await assertRefusal("credited", () => split(30000, 7000), /credit/i);
});

test("refuses a milestone on a non-Void progress billing, naming its code; a Void one does not block", async () => {
    freshWorld();
    world.state.progressLines.push({ scheduleId: "ms-a", billing: { code: "PB-00001", status: "Void" } });
    const ok = await split(30000, 7000);
    assert.equal(ok.success, true);

    freshWorld();
    world.state.progressLines.push({ scheduleId: "ms-a", billing: { code: "PB-00002", status: "Issued" } });
    await assertRefusal("progress billing", () => split(30000, 7000), /PB-00002/);
});

test("refuses a milestone held by an in-flight deposit", async () => {
    freshWorld();
    world.state.depositIngests.push({ paymentScheduleId: "ms-a", status: "applied" });
    await assertRefusal("deposit", () => split(30000, 7000), /deposit/i);
});

test("refuses when the estimate mirror row is missing", async () => {
    freshWorld();
    world.state.estimateSchedules = world.state.estimateSchedules.filter((e) => e.id !== "eps-a");
    await assertRefusal("mirror missing", () => split(30000, 7000), /no longer exists/);
});

test("refuses when the estimate mirror row is already Paid", async () => {
    freshWorld();
    Object.assign(world.state.estimateSchedules.find((e) => e.id === "eps-a")!, { status: "Paid" });
    await assertRefusal("mirror paid", () => split(30000, 7000), /estimate/i);
});

// ── Design-review additions ──────────────────────────────────────────────────

test("refuses a Canceled milestone", async () => {
    freshWorld();
    Object.assign(ms(), { status: "Canceled" });
    await assertRefusal("canceled", () => split(30000, 7000), /only pending milestones can be split/i);
});

test("refuses a suffixed create-in-flight marker with QBResolveRequiredError", async () => {
    freshWorld();
    Object.assign(ms(), { qbSyncError: "create-in-flight:issuance-123" });
    await assertRefusal("suffixed marker", () => split(30000, 7000), (e) => e.name === "QBResolveRequiredError");
});

test("refuses sub-cent input parts instead of rounding them", async () => {
    freshWorld();
    await assertRefusal("sub-cent part", () => split(30000.004, 6999.996), /whole number of cents/);
    await assertRefusal("sub-cent remainder", () => split(30000, 7000.004), /whole number of cents/);
});

test("refuses a stored amount with fractions of a cent", async () => {
    freshWorld();
    Object.assign(ms(), { amount: 37000.004 });
    await assertRefusal("stored sub-cent", () => split(30000, 7000), /fractions of a cent/);
});

test("refuses an inconsistent tax split (one column null, or columns that do not add up)", async () => {
    freshWorld();
    Object.assign(ms(), { pretaxAmount: 34000, taxAmount: null });
    await assertRefusal("one null", () => split(30000, 7000), /tax split/i);
    freshWorld();
    Object.assign(ms(), { pretaxAmount: 34000, taxAmount: 2000 });
    await assertRefusal("does not add up", () => split(30000, 7000), /tax split/i);
});

test("refuses a mirror on a different estimate, a shared mirror, and a mirror with a different amount", async () => {
    freshWorld();
    Object.assign(world.state.estimateSchedules.find((e) => e.id === "eps-a")!, { estimateId: "est-other" });
    await assertRefusal("other estimate", () => split(30000, 7000), /different estimate/);

    freshWorld();
    Object.assign(ms("ms-b"), { sourceScheduleId: "eps-a" });
    await assertRefusal("shared mirror", () => split(30000, 7000), /shared by more than one/);

    freshWorld();
    Object.assign(world.state.estimateSchedules.find((e) => e.id === "eps-a")!, { amount: 36000 });
    await assertRefusal("amount mismatch", () => split(30000, 7000), (e) => /36,000/.test(e.message) && /37,000/.test(e.message) && /Edit amounts/.test(e.message));
});

test("refuses a mirrored row on an invoice with no estimate", async () => {
    freshWorld();
    world.state.invoices[0].estimateId = null;
    await assertRefusal("no estimate", () => split(30000, 7000), /different estimate/);
});

test("a row on a VOID progress billing is allowed; a deposit in a non-retaining status is allowed", async () => {
    freshWorld();
    world.state.progressLines.push({ scheduleId: "ms-a", billing: { code: "PB-00009", status: "Void" } });
    world.state.depositIngests.push({ paymentScheduleId: "ms-a", status: "unmatched" });
    const result = await split(30000, 7000);
    assert.equal(result.success, true);
});

test("a failure after the claim rolls EVERYTHING back (rows, estimate rows, itemsRevision)", async () => {
    freshWorld();
    const before = snapshotOf();
    const model = world.prisma.paymentSchedule as Row;
    const realCreate = model.create;
    model.create = async () => { throw new Error("simulated insert failure"); };
    try {
        await assert.rejects(() => split(30000, 7000), /simulated insert failure/);
    } finally {
        model.create = realCreate;
    }
    assert.equal(snapshotOf(), before);
    assert.equal(world.state.estimate.itemsRevision, 5);
    assertNoCustomerContact("rollback");
});

test("the remainder can be split again (7,000 -> 5,000 + 2,000)", async () => {
    freshWorld();
    const first = await split(30000, 7000);
    const second = await split(5000, 2000, first.remainderId);
    const s = world.state;
    assert.equal(second.success, true);
    assert.equal(cents(s.milestones.find((m) => m.id === first.remainderId)!.amount), 500000);
    assert.equal(cents(s.milestones.find((m) => m.id === second.remainderId)!.amount), 200000);
    assert.equal(sum(s.milestones.filter((m) => m.sourceScheduleId)), 5700000);
    assert.equal(sum(s.estimateSchedules), 5700000);
    assert.equal(s.estimate.itemsRevision, 7);
});

test("settling BOTH parts one after the other leaves the invoice and estimate fully paid for that milestone", async () => {
    freshWorld();
    const s = world.state;
    const result = await split(30000, 7000);
    assertNoCustomerContact("split");
    const input = { paymentDate: new Date("2026-10-22T12:00:00.000Z"), method: "check", referenceNumber: "1001", notes: null };
    assert.equal((await paymentRecord.recordPaymentCore(result.firstId, "inv-1", input)).success, true);
    assert.equal((await paymentRecord.recordPaymentCore(result.remainderId, "inv-1", { ...input, referenceNumber: "1002" })).success, true);
    assert.equal(cents(s.invoices[0].balanceDue), 6000000 - 3700000);
    assert.equal(s.invoices[0].status, "Partially Paid");
    const mirrored = s.estimateSchedules.filter((e) => e.name.startsWith("Cabinets"));
    assert.equal(mirrored.length, 2);
    assert.ok(mirrored.every((e) => e.status === "Paid"));
    assert.equal(cents(s.estimate.balanceDue), 5700000 - 3700000);
    assert.equal(world.enqueues.length, 2, "one notification per settle, none from the split");
});

// ── Round 2 ──────────────────────────────────────────────────────────────────

test("refuses a sub-cent estimate mirror amount (37000.004 vs 37000) and changes nothing", async () => {
    freshWorld();
    Object.assign(world.state.estimateSchedules.find((e) => e.id === "eps-a")!, { amount: 37000.004 });
    await assertRefusal("sub-cent mirror", () => split(30000, 7000), /estimate schedule.*fractions of a cent/i);
});

test("refuses sub-cent pretax / tax columns (34000.004 + 2999.996) and changes nothing", async () => {
    freshWorld();
    Object.assign(ms(), { pretaxAmount: 34000.004, taxAmount: 2999.996 });
    await assertRefusal("sub-cent tax columns", () => split(30000, 7000), /tax split.*fractions of a cent/i);
});

test("refuses an unlinked row matched to the estimate schedule by name only (legacy invoice)", async () => {
    freshWorld();
    world.state.milestones.push(milestone("ms-x", "Cabinets", 1000));
    Object.assign(world.state.estimateSchedules.find((e) => e.id === "eps-a")!, { amount: 1000 });
    await assertRefusal("name match", () => split(400, 600, "ms-x"), /matched to the estimate's payment schedule by name only/);

    freshWorld();
    world.state.milestones.push(milestone("ms-y", "Deposit", 1000));
    world.state.estimateSchedules.push(estimateRow("eps-r", "Deposit (remaining)", 1000, { order: 3 }));
    await assertRefusal("remainder-name match", () => split(400, 600, "ms-y"), /by name only/);
});

test("an unlinked row whose same-named estimate row is already Paid is allowed", async () => {
    freshWorld();
    world.state.milestones.push(milestone("ms-x", "Cabinets", 1000));
    Object.assign(world.state.estimateSchedules.find((e) => e.id === "eps-a")!, { status: "Paid" });
    const result = await split(400, 600, "ms-x");
    assert.equal(result.success, true);
    assert.equal(world.state.estimate.itemsRevision, 5);
});

test("the estimate-side claim losing rolls back the invoice-row claim (stripe session / payment intent on the estimate row)", async () => {
    for (const field of ["stripeSessionId", "stripePaymentIntentId"]) {
        freshWorld();
        Object.assign(world.state.estimateSchedules.find((e) => e.id === "eps-a")!, { [field]: "x_test_1" });
        await assertRefusal(`estimate ${field}`, () => split(30000, 7000), /estimate/i);
        assert.equal(cents(ms().amount), 3700000);
        assert.equal(world.state.estimate.itemsRevision, 5);
        assert.equal(world.state.milestones.length, 3);
    }
});

// ── partialSplitCents (the modal's amount rule) ──────────────────────────────

test("partialSplitCents: valid whole-cent amounts below the full amount", () => {
    assert.deepEqual(partialSplitCents("30000", 37000), { firstCents: 3000000, remainderCents: 700000 });
    assert.deepEqual(partialSplitCents("36999.99", 37000), { firstCents: 3699999, remainderCents: 1 });
    assert.deepEqual(partialSplitCents("0.1", 0.3), { firstCents: 10, remainderCents: 20 });
    assert.deepEqual(partialSplitCents(30000, 37000), { firstCents: 3000000, remainderCents: 700000 });
});

test("partialSplitCents: everything else is null", () => {
    for (const bad of ["30000.004", "0", "-5", "37000", "37000.01", "", "   ", "abc", "NaN", "Infinity"]) {
        assert.equal(partialSplitCents(bad, 37000), null, `"${bad}" must be refused`);
    }
});

// ── Interleaving with a Stripe Checkout session attach ───────────────────────

test("split lands between the checkout's amount read and its attach: the attach misses", async () => {
    freshWorld();
    const read = { id: "ms-a", amount: ms().amount }; // what create-session read before calling Stripe
    await split(30000, 7000);
    const attached = await attachCheckoutSessionIfUnchanged(world.prisma as never, "invoice", read, "cs_test_old");
    assert.equal(attached, false);
    assert.equal(ms().stripeSessionId ?? null, null);
    assert.equal(ms().amount, 30000);
});

test("attach first, then the split is refused as payment in progress with nothing changed", async () => {
    freshWorld();
    const read = { id: "ms-a", amount: ms().amount };
    assert.equal(await attachCheckoutSessionIfUnchanged(world.prisma as never, "invoice", read, "cs_test_new"), true);
    assert.equal(ms().stripeSessionId, "cs_test_new");
    await assertRefusal("after attach", () => split(30000, 7000), /payment is in progress/i);
});
