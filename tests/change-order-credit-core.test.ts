/**
 * Credit (negative) change orders through the REAL billing-core, hermetic.
 *
 * Same in-memory world as the offline-approval tests (tests/helpers/co-offline-harness):
 * fake Prisma with SQL three-valued where evaluation, QuickBooks and the network throw if
 * touched, every email is recorded. Covers the offline apply on a picked milestone, the
 * signed path (handleChangeOrderApproved), the sweep, the send guard, and every refusal.
 * Real-database coverage is in tests/change-order-offline-approval-db.test.ts.
 * Fixture data is generic; the repo is public.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_EMAIL, NOW, TEAM_EMAIL, loadModules, makeWorld, setWorld, type Row, type World } from "./helpers/co-offline-harness";

let billing: Row;
let sweep: Row;
let restore: () => void;
let world: World;

before(async () => {
    process.env.CLIENT_PORTAL_SECRET ??= "test-only-portal-secret";
    world = makeWorld();
    setWorld(world);
    const loaded = await loadModules();
    ({ billing, sweep, restore } = loaded);
});
after(() => restore?.());

const ACTOR = { userId: "user-1", name: "Office Manager" };
const activityRows: Row[] = [];
const r2 = (n: number) => Math.round(Number(n) * 100) / 100;

function milestone(id: string, name: string, amount: number, extra: Row = {}): Row {
    return {
        id, invoiceId: "inv-1", name, amount, pretaxAmount: null, taxAmount: null, status: "Pending", dueDate: null,
        qbInvoiceId: null, qbInvoiceLink: null, qbSyncError: null, qbInvoiceSentAt: null, lastReminderAt: null, receiptSentAt: null,
        stripeSessionId: null, stripePaymentIntentId: null, paidAt: null, paymentDate: null, paymentMethod: null, referenceNumber: null,
        sourceChangeOrderId: null, sourceCoScheduleId: null, sourceScheduleId: null,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        ...extra,
    };
}

/**
 * A FIXED credit CO (one item at `unitCost`, default -$3,020 at 8.8%) on an invoice cloned
 * from its estimate: Deposit and Cabinets carry a pretax/tax split, Final is a legacy row.
 * The estimate order puts Final last, so it is the default target.
 */
function creditWorld(options: { unitCost?: number; taxRatePercent?: number; status?: string; signed?: boolean; scheduleAmounts?: number[]; pricingType?: "FIXED" | "COST_PLUS" } = {}) {
    world = makeWorld({
        itemUnitCosts: [options.unitCost ?? -3020],
        taxRatePercent: options.taxRatePercent ?? 8.8,
        scheduleAmounts: options.scheduleAmounts ?? [],
        status: options.status,
        signed: options.signed,
        pricingType: options.pricingType,
    });
    setWorld(world);
    activityRows.length = 0;
    world.state.estimateSchedules.push({ id: "eps-1", order: 0 }, { id: "eps-2", order: 1 }, { id: "eps-3", order: 2 });
    world.state.milestones.push(
        milestone("ms-deposit", "Deposit", 10880, { pretaxAmount: 10000, taxAmount: 880, sourceScheduleId: "eps-1" }),
        milestone("ms-cabinets", "Cabinets", 9792, { pretaxAmount: 9000, taxAmount: 792, sourceScheduleId: "eps-2" }),
        milestone("ms-final", "Final", 8965.12, { sourceScheduleId: "eps-3" }),
    );
    Object.assign(world.state.invoices[0], { subtotal: 27240, taxAmount: 2397.12, totalAmount: 29637.12, balanceDue: 29637.12 });
}
beforeEach(() => creditWorld());

function input(overrides: Row = {}) {
    return {
        method: "PHONE",
        approvedOn: "2026-09-26",
        note: "credit agreed on a call",
        expectedUpdatedAt: world.state.co.updatedAt.toISOString(),
        actor: ACTOR,
        ...overrides,
    };
}
let scheduleHookCalls = 0;
function deps(overrides: Row = {}) {
    return {
        now: () => NOW,
        logActivity: async (entry: Row) => { activityRows.push(entry); },
        applySchedule: async () => { scheduleHookCalls += 1; },
        ...overrides,
    };
}
const offline = (overrides: Row = {}, depOverrides: Row = {}) =>
    billing.approveChangeOrderOfflineCore("co-1", input(overrides), deps(depOverrides));
const amountOf = (id: string) => world.state.milestones.find((row) => row.id === id)!.amount;

function assertNoCustomerContact(label: string) {
    assert.equal(world.customerEmails().length, 0, `${label}: an email reached the customer`);
    assert.equal(world.sms.length, 0, `${label}: an SMS was sent`);
    assert.equal(world.qbCalls.length, 0, `${label}: QuickBooks was called`);
    assert.equal(world.fetchCalls.length, 0, `${label}: the network was called`);
}

// ── Offline apply ────────────────────────────────────────────────────────────

test("offline credit on a picked non-default milestone lowers it, its split, and the invoice; writes one credit marker; sends nothing", async () => {
    scheduleHookCalls = 0;
    const result = await offline({ targetMilestoneId: "ms-cabinets" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(world.state.co.status, "Approved");

    // -$3,020.00 + -$265.76 tax = -$3,285.76 off Cabinets ($9,792.00 -> $6,506.24).
    const cabinets = world.state.milestones.find((row) => row.id === "ms-cabinets")!;
    assert.equal(r2(cabinets.amount), 6506.24);
    assert.equal(r2(cabinets.pretaxAmount), 5980);
    assert.equal(r2(cabinets.taxAmount), 526.24);
    assert.equal(cabinets.status, "Pending");
    assert.equal(amountOf("ms-final"), 8965.12, "the default target is untouched");
    assert.equal(amountOf("ms-deposit"), 10880);
    assert.equal(world.state.milestones.length, 3, "no milestone created, never a negative one");
    assert.ok(world.state.milestones.every((row) => row.sourceChangeOrderId === null && row.sourceCoScheduleId === null), "no provenance stamped");

    const invoice = world.state.invoices[0];
    assert.equal(r2(invoice.subtotal), 24220);
    assert.equal(r2(invoice.taxAmount), 2131.36);
    assert.equal(r2(invoice.totalAmount), 26351.36);
    assert.equal(r2(invoice.balanceDue), 26351.36);
    assert.equal(invoice.status, "Issued");

    assert.equal(world.state.billings.length, 1);
    const marker = world.state.billings[0];
    assert.equal(marker.changeOrderId, "co-1");
    assert.equal(marker.paymentScheduleId, null);
    assert.equal(marker.label, "Credit applied to Cabinets");
    assert.deepEqual([marker.laborCents, marker.expenseCents, marker.markupCents, marker.taxCents, marker.totalCents], [0, 0, 0, -26576, -328576]);
    assert.equal(marker.createdBy, "Office Manager");
    assert.equal(marker.snapshot.kind, "credit");
    assert.equal(marker.snapshot.paymentScheduleId, "ms-cabinets");
    assert.equal(marker.snapshot.invoiceCode, "INV-00001");
    assert.deepEqual(marker.snapshot.before, { amountCents: 979200, pretaxCents: 900000, taxCents: 79200 });
    assert.deepEqual(marker.snapshot.after, { amountCents: 650624, pretaxCents: 598000, taxCents: 52624 });

    assert.deepEqual(result.billing.milestones, []);
    assert.equal(result.billing.amount, -3285.76);
    assert.equal(result.billing.credit.milestoneId, "ms-cabinets");
    assert.equal(result.billing.credit.beforeAmount, 9792);
    assert.equal(result.billing.credit.afterAmount, 6506.24);

    assert.equal(scheduleHookCalls, 0, "a credit never touches the schedule");
    assert.equal(activityRows.find((row) => row.action === "approved_change_order_offline")!.metadata.billing, "credit_applied");

    assert.equal(world.emails.length, 1);
    assert.equal(world.emails[0].to, TEAM_EMAIL);
    assert.match(world.emails[0].subject, /\(-\$3,285\.76\)/);
    assert.match(world.emails[0].html, /Took the credit of \$3,285\.76 off Cabinets on INV-00001 \(\$9,792\.00 → \$6,506\.24\)\. The customer was not notified\./);
    assertNoCustomerContact("offline credit");
});

test("offline credit with no pick lands on the default (the estimate's last milestone); a legacy row keeps a null split", async () => {
    const result = await offline();
    assert.equal(result.ok, true, JSON.stringify(result));
    const final = world.state.milestones.find((row) => row.id === "ms-final")!;
    assert.equal(r2(final.amount), 5679.36); // 8,965.12 - 3,285.76
    assert.equal(final.pretaxAmount, null);
    assert.equal(final.taxAmount, null);
    assert.equal(amountOf("ms-cabinets"), 9792);
    assert.equal(world.state.billings[0].label, "Credit applied to Final");
});

test("the credit uses the displayed tax where the positive biller's formula would land a cent away", async () => {
    // -$19,999.45 at 10%: displayed tax -$1,999.95 (the biller's formula gives -$1,999.94).
    creditWorld({ unitCost: -19999.45, taxRatePercent: 10 });
    world.state.milestones.find((row) => row.id === "ms-final")!.amount = 30000;
    const result = await offline();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(r2(amountOf("ms-final")), 8000.6); // 30,000.00 - 21,999.40
    assert.equal(world.state.billings[0].taxCents, -199995);
    assert.equal(world.state.billings[0].totalCents, -2199940);
});

test("replay: a second offline approval is ALREADY_APPROVED and changes nothing", async () => {
    const first = await offline({ targetMilestoneId: "ms-cabinets" });
    assert.equal(first.ok, true);
    const second = await offline({ targetMilestoneId: "ms-final", expectedUpdatedAt: world.state.co.updatedAt.toISOString() });
    assert.deepEqual([second.ok, second.code], [false, "ALREADY_APPROVED"]);
    assert.equal(world.state.billings.length, 1);
    assert.equal(r2(amountOf("ms-cabinets")), 6506.24);
    assert.equal(amountOf("ms-final"), 8965.12);
    assert.equal(world.emails.length, 1);
});

// ── Refusals ─────────────────────────────────────────────────────────────────

async function refuses(code: string, expected: RegExp, overrides: Row = {}) {
    const coBefore = JSON.stringify(world.state.co);
    const milestonesBefore = JSON.stringify(world.state.milestones);
    const invoicesBefore = JSON.stringify(world.state.invoices);
    const result = await offline(overrides);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, code, result.error);
    assert.match(result.error, expected);
    assert.equal(JSON.stringify(world.state.co), coBefore, "the approval rolled back");
    assert.equal(JSON.stringify(world.state.milestones), milestonesBefore, "no milestone changed");
    assert.equal(JSON.stringify(world.state.invoices), invoicesBefore, "invoice totals unchanged");
    assert.equal(world.state.billings.length, 0, "no credit marker");
    assert.equal(world.emails.length, 0);
    assertNoCustomerContact(code);
}

test("refused: a credit with payment schedule rows", async () => {
    creditWorld({ scheduleAmounts: [-1000, -2020] });
    await refuses("INVALID", /CO-00001 is a credit .*can't have a payment schedule/);
});

test("refused: a negative cost-plus change order", async () => {
    creditWorld({ pricingType: "COST_PLUS" });
    await refuses("INVALID", /cost-plus change order can't be a credit/);
});

test("refused: no eligible milestone on the invoice", async () => {
    for (const row of world.state.milestones) row.qbInvoiceSentAt = new Date("2026-09-20T00:00:00.000Z");
    await refuses("BILLING_FAILED", /invoice INV-00001 has no unpaid milestone it can come off/);
});

test("refused: no invoice at all", async () => {
    world.state.invoices.length = 0;
    await refuses("BILLING_FAILED", /no invoice to take it off/);
});

test("refused: a credit bigger than (or equal to) the picked milestone", async () => {
    await refuses("BILLING_FAILED", /The credit \(\$3,285\.76 incl\. tax\) is not smaller than Final \(\$3,285\.76\)\. Pick a larger unpaid milestone\./,
        (() => { world.state.milestones.find((row) => row.id === "ms-final")!.amount = 3285.76; return {}; })());
});

test("refused: a target on another invoice", async () => {
    world.state.invoices.push({ id: "inv-2", code: "INV-00002", status: "Issued", estimateId: "est-2", projectId: "proj-1", subtotal: 1000, taxAmount: 0, totalAmount: 1000, balanceDue: 1000 });
    world.state.milestones.push(milestone("ms-other", "Other job final", 1000, { invoiceId: "inv-2" }));
    await refuses("BILLING_FAILED", /That milestone isn't on invoice INV-00001/, { targetMilestoneId: "ms-other" });
});

test("refused: an ineligible target (already in QuickBooks)", async () => {
    world.state.milestones.find((row) => row.id === "ms-deposit")!.qbInvoiceId = "qb-123";
    await refuses("BILLING_FAILED", /Deposit can't take this credit: it is already in QuickBooks/, { targetMilestoneId: "ms-deposit" });
});

test("refused: a $0 change order", async () => {
    world.state.co.totalAmount = 0;
    world.state.items = [{ name: "Item 1", type: "Labor", quantity: 1, unitCost: 0 }];
    await refuses("INVALID", /\$0 subtotal/);
});

test("a milestone that changes between the locked read and the write is refused and everything rolls back", async () => {
    const originalUpdateMany = world.prisma.paymentSchedule.updateMany;
    world.prisma.paymentSchedule.updateMany = async (args: Row) => {
        // A QuickBooks send lands on the target in the gap (it does not take the invoice lock).
        world.state.milestones.find((row) => row.id === "ms-final")!.qbInvoiceSentAt = new Date();
        return originalUpdateMany(args);
    };
    try {
        const result = await offline();
        assert.deepEqual([result.ok, result.code], [false, "BILLING_FAILED"]);
        assert.match(result.error, /This milestone changed while applying the credit\. Refresh and try again\./);
        assert.equal(world.state.co.status, "Sent");
        assert.equal(world.state.billings.length, 0);
        assert.equal(r2(world.state.invoices[0].totalAmount), 29637.12);
    } finally {
        world.prisma.paymentSchedule.updateMany = originalUpdateMany;
    }
});

// ── Signed path: handleChangeOrderApproved ───────────────────────────────────

test("a signed credit is applied to the default target, no payment email is attempted, and a replay adds no issue", async () => {
    creditWorld({ status: "Approved", signed: true });
    let sendReads = 0;
    const originalFindUnique = world.prisma.invoice.findUnique;
    world.prisma.invoice.findUnique = async (args: Row) => {
        // sendMilestoneInvoicesCore's first act is this read (invoice + payments + client).
        if (args?.include?.payments) sendReads += 1;
        return originalFindUnique(args);
    };
    try {
        const first = await billing.handleChangeOrderApproved("co-1", { freshlyApproved: true });
        assert.deepEqual(first, { billed: true, sent: false, issues: [] }, "no schedule-hook issue, no send issue");
        assert.equal(r2(amountOf("ms-final")), 5679.36);
        assert.equal(world.state.billings.length, 1);
        assert.equal(world.state.billings[0].createdBy, "Customer signature");
        assert.equal(sendReads, 0, "sendMilestoneInvoicesCore was never called");

        assert.equal(world.emails.length, 1);
        assert.equal(world.emails[0].to, TEAM_EMAIL);
        assert.equal(world.emails[0].subject, "✅ Change order credit applied — CO-00001 — Example change (-$3,285.76)");
        assert.match(world.emails[0].html, /Lowered <strong>Final<\/strong> on invoice INV-00001 from \$8,965\.12 to \$5,679\.36; the customer was not sent a payment link\./);

        const second = await billing.handleChangeOrderApproved("co-1");
        assert.deepEqual(second, { billed: true, sent: false, issues: [] });
        assert.equal(world.state.billings.length, 1);
        assert.equal(r2(amountOf("ms-final")), 5679.36, "no second reduction");
        assert.equal(sendReads, 0);
        assertNoCustomerContact("signed credit");
    } finally {
        world.prisma.invoice.findUnique = originalFindUnique;
    }
});

test("a signed credit whose default no longer fits is reported as NOT applied", async () => {
    creditWorld({ status: "Approved", signed: true });
    world.state.milestones.find((row) => row.id === "ms-final")!.amount = 1000;
    const summary = await billing.handleChangeOrderApproved("co-1");
    assert.equal(summary.billed, false);
    assert.equal(summary.issues.length, 1);
    assert.match(summary.issues[0], /not smaller than Final/);
    assert.equal(world.state.billings.length, 0);
    assert.match(world.emails[0].subject, /needs a look/);
    assert.match(world.emails[0].html, /it was NOT taken off the invoice/);
    assertNoCustomerContact("failed signed credit");
});

test("billChangeOrderCore on a credit returns the lowered milestone, no milestones[0] crash, and is idempotent", async () => {
    creditWorld({ status: "Approved", signed: true });
    const quiet = { logActivity: async () => {}, revalidatePath: () => {} };
    const first = await billing.billChangeOrderCore("co-1", quiet);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.alreadyBilled, false);
    assert.deepEqual(first.milestones, []);
    assert.equal(first.milestoneId, "ms-final");
    assert.equal(first.note, "Credit of $3,285.76 taken off Final on INV-00001 ($8,965.12 → $5,679.36).");
    const second = await billing.billChangeOrderCore("co-1", quiet);
    assert.equal(second.alreadyBilled, true);
    assert.equal(second.credit.afterAmount, 5679.36);
    assert.equal(world.state.billings.length, 1);
    assert.equal(r2(amountOf("ms-final")), 5679.36);
});

test("billing a $0 change order is still refused (no milestone, no marker)", async () => {
    creditWorld({ status: "Approved", signed: true });
    world.state.co.totalAmount = 0;
    world.state.items = [{ name: "Item 1", type: "Labor", quantity: 1, unitCost: 0 }];
    const result = await billing.billChangeOrderCore("co-1", { logActivity: async () => {}, revalidatePath: () => {} });
    assert.equal(result.ok, false);
    assert.match(result.error, /has a \$0 total — nothing to bill/);
    assert.equal(world.state.milestones.length, 3);
    assert.equal(world.state.billings.length, 0);
});

// ── Sweep ────────────────────────────────────────────────────────────────────

test("the sweep skips a change order that already has a ChangeOrderBilling row", async () => {
    creditWorld({ status: "Approved", signed: true });
    world.state.co.approvedAt = new Date(Date.now() - 30 * 60_000);
    world.state.billings.push({ id: "cob-existing", changeOrderId: "co-1", paymentScheduleId: null, label: "Credit applied to Final", totalCents: -328576, snapshot: { kind: "credit" } });
    const response = await sweep.GET(new Request("http://localhost/api/cron/co-billing-sweep"));
    const body = await response.json();
    assert.equal(body.checked, 1);
    assert.deepEqual(body.results, [{ code: "CO-00001", action: "skipped (already billed)" }]);
    assert.equal(amountOf("ms-final"), 8965.12);
    assert.equal(world.emails.length, 0);
});

test("the sweep applies a signed credit that has no marker yet, and reports it as success, not an alert", async () => {
    creditWorld({ status: "Approved", signed: true });
    world.state.co.approvedAt = new Date(Date.now() - 30 * 60_000);
    const response = await sweep.GET(new Request("http://localhost/api/cron/co-billing-sweep"));
    const body = await response.json();
    assert.equal(body.checked, 1);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].action, "credit applied (nothing to send)");
    assert.ok(!body.results[0].action.startsWith("alerted"), "the heartbeat must not read a credit as a failed run");
    assert.equal(world.state.billings.length, 1);
    assert.equal(r2(amountOf("ms-final")), 5679.36);
    assertNoCustomerContact("sweep credit");
});

// ── Send guard ───────────────────────────────────────────────────────────────

const sendDeps = { logActivity: async () => {}, revalidatePath: () => {} };

test("send: a credit whose default target fits goes out as a credit, with its tax line", async () => {
    creditWorld({ status: "Draft" });
    const result = await billing.sendChangeOrderToClientCore("co-1", sendDeps);
    assert.deepEqual(result, { success: true, sentTo: CLIENT_EMAIL });
    assert.equal(world.state.co.status, "Sent");
    const mail = world.emails.find((row) => row.to === CLIENT_EMAIL)!;
    assert.match(mail.html, /Change Order Credit/);
    assert.doesNotMatch(mail.html, /Change Order Amount/);
    assert.match(mail.html, /-\$3,285\.76/);
    assert.match(mail.html, /-\$3,020\.00 and -\$265\.76 Sales tax \(8\.8%\)/);
    assert.match(mail.html, /This credit will be taken off your remaining balance\./);
    assert.equal(world.state.billings.length, 0, "sending applies nothing");
    assert.equal(world.qbCalls.length, 0);
});

test("send: refused when the default target can't take the credit", async () => {
    creditWorld({ status: "Draft" });
    world.state.milestones.find((row) => row.id === "ms-final")!.amount = 1000;
    const result = await billing.sendChangeOrderToClientCore("co-1", sendDeps);
    assert.equal(result.success, false);
    assert.match(result.error, /The credit \(\$3,285\.76 incl\. tax\) is not smaller than Final \(\$1,000\.00\)/);
    assert.equal(world.state.co.status, "Draft");
    assert.equal(world.emails.length, 0);

    for (const row of world.state.milestones) row.lastReminderAt = new Date();
    const none = await billing.sendChangeOrderToClientCore("co-1", sendDeps);
    assert.match(none.error, /has no unpaid milestone it can come off/);
    assert.equal(world.emails.length, 0);
});

test("send: refused for a credit with schedule rows and for a negative cost-plus", async () => {
    creditWorld({ status: "Draft", scheduleAmounts: [-1000, -2020] });
    const scheduled = await billing.sendChangeOrderToClientCore("co-1", sendDeps);
    assert.match(scheduled.error, /can't have a payment schedule/);
    creditWorld({ status: "Draft", pricingType: "COST_PLUS" });
    const costPlus = await billing.sendChangeOrderToClientCore("co-1", sendDeps);
    assert.match(costPlus.error, /cost-plus change order can't be a credit/);
    assert.equal(world.emails.length, 0);
});

test("send: $0 is still refused", async () => {
    creditWorld({ status: "Draft" });
    world.state.co.totalAmount = 0;
    world.state.items = [{ name: "Item 1", type: "Labor", quantity: 1, unitCost: 0 }];
    const result = await billing.sendChangeOrderToClientCore("co-1", sendDeps);
    assert.equal(result.success, false);
    assert.match(result.error, /has no priced items yet/);
    assert.equal(world.emails.length, 0);
});

test("send: a positive change order email is unchanged (Change Order Amount, + tax line)", async () => {
    creditWorld({ status: "Draft", unitCost: 1000, taxRatePercent: 10 });
    const result = await billing.sendChangeOrderToClientCore("co-1", sendDeps);
    assert.equal(result.success, true, JSON.stringify(result));
    const mail = world.emails.find((row) => row.to === CLIENT_EMAIL)!;
    assert.match(mail.html, /Change Order Amount/);
    assert.match(mail.html, /\$1,000\.00 \+ \$100\.00 Sales tax/);
    assert.doesNotMatch(mail.html, /credit/i);
});

// ── Draft creation ───────────────────────────────────────────────────────────

test("createChangeOrderDraft refuses schedule rows on a credit with the credit message", async () => {
    const originalEstimate = world.prisma.estimate;
    world.prisma.estimate = { ...originalEstimate, findFirst: async () => ({ id: "est-1" }) };
    const originalCostCode = (world.prisma as Row).costCode;
    (world.prisma as Row).costCode = { findMany: async () => [] };
    try {
        const result = await billing.createChangeOrderDraft({
            projectId: "proj-1", estimateId: "est-1", title: "Credit",
            items: [{ name: "Remove upgrade", quantity: 1, unitCost: -500 }],
            paymentSchedules: [{ name: "A", amount: 100 }, { name: "B", amount: 100 }],
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /is a credit .*can't have a payment schedule/);
    } finally {
        world.prisma.estimate = originalEstimate;
        (world.prisma as Row).costCode = originalCostCode;
    }
});

// ── Portal signature: approveChangeOrderCore ─────────────────────────────────

test("portal signing refuses a credit whose default target can't take it, and approves one that fits", async () => {
    // change-order-core was loaded by billing-core under the harness, so this is the same
    // instance (fake Prisma), and its dynamic import of billing-core resolves to the same module.
    const { approveChangeOrderCore } = await import("../src/lib/change-order-core");
    const signature = { signatureName: "Customer A", clientSignatureUrl: "https://example.test/sig.png", approvedAt: NOW };

    creditWorld({ status: "Sent" });
    world.state.milestones.find((row) => row.id === "ms-final")!.amount = 1000;
    await assert.rejects(approveChangeOrderCore("co-1", signature), /not smaller than Final \(\$1,000\.00\)/);
    assert.equal(world.state.co.status, "Sent");

    creditWorld({ status: "Sent" });
    const approved = await approveChangeOrderCore("co-1", signature);
    assert.equal(approved?.transitioned, true);
    assert.equal(world.state.co.status, "Approved");
    assert.equal(world.state.billings.length, 0, "approval alone applies nothing; billing does");
    assert.equal(amountOf("ms-final"), 8965.12);
});

// ── "Edit amounts" rebalance after a credit ──────────────────────────────────

/** The estimate rows behind the three milestones, at the contract amounts. */
function withEstimateRows() {
    const amounts: Record<string, [string, number]> = { "eps-1": ["Deposit", 10880], "eps-2": ["Cabinets", 9792], "eps-3": ["Final", 8965.12] };
    for (const row of world.state.estimateSchedules) {
        const [name, amount] = amounts[row.id];
        Object.assign(row, { name, amount, status: "Pending", percentage: 30, dueDate: null });
    }
}
const epsAmount = (id: string) => r2(world.state.estimateSchedules.find((row) => row.id === id)!.amount);
const epsTotal = () => r2(world.state.estimateSchedules.reduce((sum, row) => sum + Number(row.amount), 0));
const rebalance = (rows: Array<{ scheduleId: string; name: string; amount: number }>) =>
    billing.updatePendingMilestoneAmountsCore("inv-1", rows);

test("rebalance that changes the credited milestone keeps its estimate row at invoice + credit", async () => {
    withEstimateRows();
    assert.equal((await offline()).ok, true); // -$3,285.76 off Final: invoice 5,679.36, estimate row still 8,965.12
    assert.equal(epsAmount("eps-3"), 8965.12, "the credit itself never touches the estimate row");

    const result = await rebalance([
        { scheduleId: "ms-deposit", name: "Deposit", amount: 10000 },
        { scheduleId: "ms-cabinets", name: "Cabinets", amount: 9792 },
        { scheduleId: "ms-final", name: "Final", amount: 6559.36 },
    ]);
    assert.deepEqual(result, { success: true, warnings: [] });
    assert.equal(r2(amountOf("ms-final")), 6559.36);
    assert.equal(epsAmount("eps-3"), 9845.12, "6,559.36 on the invoice + 3,285.76 credit");
    assert.equal(epsAmount("eps-1"), 10000, "a row without credits mirrors exactly as before");
    assert.equal(epsAmount("eps-2"), 9792);
    assert.equal(epsTotal(), 29637.12, "the estimate schedule still totals the contract");
    assert.equal(world.state.billings.length, 1, "the rebalance writes no billing rows");
});

test("rebalance that leaves the credited milestone alone keeps its estimate row at invoice + credit", async () => {
    withEstimateRows();
    assert.equal((await offline()).ok, true);
    const result = await rebalance([
        { scheduleId: "ms-deposit", name: "Deposit", amount: 11000 },
        { scheduleId: "ms-cabinets", name: "Cabinets", amount: 9672 },
        { scheduleId: "ms-final", name: "Final", amount: 5679.36 },
    ]);
    assert.equal(result.success, true);
    assert.equal(epsAmount("eps-3"), 8965.12, "not the lowered 5,679.36");
    assert.equal(epsAmount("eps-1"), 11000);
    assert.equal(epsAmount("eps-2"), 9672);
    assert.equal(epsTotal(), 29637.12);
});

test("rebalance with no credit on the invoice mirrors every row exactly as before", async () => {
    withEstimateRows();
    const result = await rebalance([
        { scheduleId: "ms-deposit", name: "Deposit", amount: 11000 },
        { scheduleId: "ms-cabinets", name: "Cabinets", amount: 9672 },
        { scheduleId: "ms-final", name: "Final", amount: 8965.12 },
    ]);
    assert.equal(result.success, true);
    assert.deepEqual(["eps-1", "eps-2", "eps-3"].map(epsAmount), [11000, 9672, 8965.12]);
    assert.ok(world.state.estimateSchedules.every((row) => row.percentage === null), "percentage cleared as before");
});

test("a credit on another invoice does not change this invoice's mirror", async () => {
    withEstimateRows();
    world.state.billings.push({
        id: "cob-elsewhere", changeOrderId: "co-9", paymentScheduleId: null, totalCents: -50000,
        snapshot: { kind: "credit", invoiceId: "inv-2", paymentScheduleId: "ms-final", totalCents: -50000 },
    });
    const result = await rebalance([
        { scheduleId: "ms-deposit", name: "Deposit", amount: 10880 },
        { scheduleId: "ms-cabinets", name: "Cabinets", amount: 9792 },
        { scheduleId: "ms-final", name: "Final", amount: 8965.12 },
    ]);
    assert.equal(result.success, true);
    assert.equal(epsAmount("eps-3"), 8965.12);
});

test("after a credit the per-pool check still refuses moving money from an estimate-linked row to an extra charge", async () => {
    withEstimateRows();
    assert.equal((await offline()).ok, true);
    world.state.milestones.push(milestone("ms-extra", "Extra charge", 500, { createdAt: "2026-10-01T00:00:00.000Z" }));
    const epsBefore = JSON.stringify(world.state.estimateSchedules);
    await assert.rejects(rebalance([
        { scheduleId: "ms-deposit", name: "Deposit", amount: 10880 },
        { scheduleId: "ms-cabinets", name: "Cabinets", amount: 9792 },
        { scheduleId: "ms-final", name: "Final", amount: 5179.36 },
        { scheduleId: "ms-extra", name: "Extra charge", amount: 1000 },
    ]), /move money between estimate-linked milestones and extra charges/);
    assert.equal(JSON.stringify(world.state.estimateSchedules), epsBefore, "nothing mirrored");
    assert.equal(r2(amountOf("ms-final")), 5679.36);
});
