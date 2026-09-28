/**
 * approveChangeOrderOfflineCore behavior (spec G2, G5), hermetic.
 *
 * Loads the REAL billing-core with a fake in-memory Prisma (tests/helpers).
 * QuickBooks and the network throw if touched; every email is recorded.
 * Real rollback on a billing failure is proven against PostgreSQL in
 * tests/change-order-offline-approval-db.test.ts.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_EMAIL, NOW, TEAM_EMAIL, loadModules, makeWorld, setWorld, type Row, type World } from "./helpers/co-offline-harness";

let core: (id: string, input: Row, deps?: Row) => Promise<Row>;
let restore: () => void;
let world: World;

before(async () => {
    world = makeWorld();
    setWorld(world);
    const loaded = await loadModules();
    core = loaded.billing.approveChangeOrderOfflineCore;
    restore = loaded.restore;
});
after(() => restore?.());

const ACTOR = { userId: "user-1", name: "Jordan Lee" };
const activityRows: Row[] = [];

function input(overrides: Row = {}) {
    return {
        method: "PHONE",
        approvedOn: "2026-09-26",
        note: "  approved on a call  ",
        expectedUpdatedAt: world.state.co.updatedAt.toISOString(),
        actor: ACTOR,
        ...overrides,
    };
}
function deps(overrides: Row = {}) {
    return {
        now: () => NOW,
        logActivity: async (entry: Row) => { activityRows.push(entry); },
        applySchedule: async () => {},
        ...overrides,
    };
}
function fresh(options: Parameters<typeof makeWorld>[0] = {}) {
    world = makeWorld(options);
    setWorld(world);
    activityRows.length = 0;
}
beforeEach(() => fresh({ scheduleAmounts: [400, 600] }));

test("T2: FIXED happy path writes every approval field and bills in the same transaction", async () => {
    const result = await core("co-1", input(), deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    const co = world.state.co;
    assert.equal(co.status, "Approved");
    assert.equal(co.approvedBy, "Jordan Lee");
    assert.equal(co.approvedAt.toISOString(), "2026-09-26T19:00:00.000Z"); // company-local noon (PDT)
    assert.equal(co.approvalSource, "OFFLINE");
    assert.equal(co.approvalMethod, "PHONE");
    assert.equal(co.approvalNote, "approved on a call");
    assert.equal(co.clientSignatureUrl, null);
    assert.equal(co.companySignedBy, undefined);

    // Two schedule rows -> two unrequested milestones, tax-inclusive (10%).
    assert.equal(world.state.milestones.length, 2);
    assert.deepEqual(world.state.milestones.map((m) => m.amount), [440, 660]);
    assert.ok(world.state.milestones.every((m) => m.sourceChangeOrderId === "co-1" && m.status === "Pending" && m.qbInvoiceSentAt === null));
    assert.equal(world.state.invoices[0].totalAmount, 5500 + 1100);
    assert.equal(result.billing.invoiceCode, "INV-00001");
    assert.equal(result.billing.milestones.length, 2);
});

test("T2: activity rows, schedule hook, and the team-only email", async () => {
    let scheduled = 0;
    const result = await core("co-1", input(), deps({ applySchedule: async () => { scheduled += 1; } }));
    assert.equal(result.ok, true);
    assert.equal(scheduled, 1);

    const approval = activityRows.find((row) => row.action === "approved_change_order_offline");
    assert.ok(approval);
    assert.equal(approval.actorType, "TEAM");
    assert.equal(approval.actorName, "Jordan Lee");
    assert.equal(approval.actorUserId, "user-1");
    assert.equal(approval.entityType, "change_order");
    assert.equal(approval.metadata.billing, "billed_no_send");
    assert.equal(approval.metadata.method, "PHONE");
    assert.equal(approval.metadata.approvedOn, "2026-09-26");
    assert.equal(activityRows.filter((row) => row.action === "billed_change_order").length, 1);
    assert.equal(activityRows.find((row) => row.action === "billed_change_order")!.actorName, "Jordan Lee");

    assert.equal(world.emails.length, 1);
    assert.equal(world.emails[0].to, TEAM_EMAIL);
    assert.match(world.emails[0].subject, /approved by Jordan Lee \(by phone\)/);
    assert.match(world.emails[0].html, /customer was not notified/);
    assert.equal(world.customerEmails().length, 0);
    assert.doesNotMatch(JSON.stringify(world.emails), new RegExp(CLIENT_EMAIL));
    assert.equal(world.qbCalls.length, 0);
    assert.equal(world.fetchCalls.length, 0);
    assert.equal(world.sms.length, 0);
});

test("T2: COST_PLUS approves without billing", async () => {
    fresh({ pricingType: "COST_PLUS", scheduleAmounts: [] });
    const result = await core("co-1", input(), deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.billing, null);
    assert.equal(world.state.co.status, "Approved");
    assert.equal(world.state.milestones.length, 0);
    assert.equal(activityRows.find((row) => row.action === "approved_change_order_offline")!.metadata.billing, "awaiting_actuals");
    assert.equal(world.customerEmails().length, 0);
});

test("T2: a schedule-less FIXED change order bills one milestone", async () => {
    fresh({ scheduleAmounts: [] });
    const result = await core("co-1", input(), deps());
    assert.equal(result.ok, true);
    assert.equal(world.state.milestones.length, 1);
    assert.equal(world.state.milestones[0].amount, 1100);
});

async function refuses(code: string, setup: () => Row | void, expectMessage?: RegExp) {
    const override = setup() ?? {};
    const before = JSON.stringify(world.state.co);
    const result = await core("co-1", input(override), deps());
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, code);
    if (expectMessage) assert.match(result.error, expectMessage);
    assert.equal(JSON.stringify(world.state.co), before, "no write to the change order");
    assert.equal(world.state.milestones.length, 0, "no milestones");
    assert.equal(activityRows.length, 0);
    assert.equal(world.emails.length, 0);
}

test("T2: not found", async () => {
    // The fake returns the single row for any lock query, so model "not found" by an empty world.
    const emptyRaw = world.prisma.$transaction;
    world.prisma.$transaction = async (callback: (tx: Row) => Promise<unknown>) => emptyRaw(async (tx: Row) => callback({ ...tx, $queryRaw: async () => [] }));
    const result = await core("missing", input(), deps());
    assert.deepEqual([result.ok, result.code], [false, "NOT_FOUND"]);
});

test("T2: already approved by the customer, by the office, or with any approval audit", async () => {
    fresh({ scheduleAmounts: [400, 600], status: "Approved", signed: true });
    let result = await core("co-1", input(), deps());
    assert.deepEqual([result.ok, result.code], [false, "ALREADY_APPROVED"]);
    assert.match(result.error, /customer already signed CO-00001/);

    fresh({ scheduleAmounts: [400, 600] });
    world.state.co.approvalSource = "OFFLINE";
    result = await core("co-1", input(), deps());
    assert.match(result.error, /already marked approved/);

    // Audit present on a Sent row (legacy corruption): still refused.
    fresh({ scheduleAmounts: [400, 600] });
    world.state.co.approvedBy = "Someone";
    result = await core("co-1", input(), deps());
    assert.equal(result.code, "ALREADY_APPROVED");
    assert.equal(world.state.milestones.length, 0);
});

test("T2: Declined and other statuses are not approvable", async () => {
    await refuses("NOT_APPROVABLE", () => { world.state.co.status = "Declined"; }, /Only Draft or Sent/);
});

test("T2: a stale updatedAt pin is refused", async () => {
    await refuses("STALE", () => ({ expectedUpdatedAt: new Date("2026-09-01T00:00:00.000Z").toISOString() }), /changed since you opened it/);
    await refuses("STALE", () => ({ expectedUpdatedAt: "not a date" }));
});

test("T2: invalid approval input is refused before any lock", async () => {
    await refuses("INVALID", () => ({ method: "CARRIER_PIGEON" }), /Choose how/);
    await refuses("INVALID", () => ({ approvedOn: "2026-09-29" }), /future/); // company zone: still the 28th
    await refuses("INVALID", () => ({ approvedOn: "2026-02-30" }));
    await refuses("INVALID", () => ({ note: "x".repeat(1001) }));
});

test("T2: shared validation refusals (section rows, no items, zero or out-of-sync subtotal)", async () => {
    await refuses("INVALID", () => { world.state.items.push({ name: "Phase", type: "Section", quantity: 1, unitCost: 0 }); }, /section headers/);
    fresh({ scheduleAmounts: [] });
    await refuses("INVALID", () => { world.state.items = []; }, /at least one priced item/);
    fresh({ scheduleAmounts: [] });
    await refuses("INVALID", () => { world.state.co.totalAmount = 0; world.state.items = [{ name: "A", type: "Labor", quantity: 1, unitCost: 0 }]; }, /positive subtotal/);
    fresh({ scheduleAmounts: [] });
    await refuses("INVALID", () => { world.state.co.totalAmount = 999; }, /out of sync/);
});

test("T2: COST_PLUS with schedule rows is refused", async () => {
    fresh({ pricingType: "COST_PLUS", scheduleAmounts: [500, 500] });
    await refuses("INVALID", () => {}, /Cost-plus change orders cannot have a fixed payment schedule/);
});

test("T2: FIXED schedule problems are refused up front", async () => {
    fresh({ scheduleAmounts: [1000] });
    await refuses("INVALID", () => {}, /payment schedule doesn't add up/);
    fresh({ scheduleAmounts: [0, 1000] });
    await refuses("INVALID", () => {}, /payment schedule doesn't add up/);
    fresh({ scheduleAmounts: [300, 300] });
    await refuses("INVALID", () => {}, /payment schedule doesn't add up/);
});

test("T2: no invoice on the project rolls everything back with BILLING_FAILED", async () => {
    fresh({ scheduleAmounts: [400, 600], withInvoice: false });
    const before = JSON.stringify(world.state.co);
    const result = await core("co-1", input(), deps());
    assert.deepEqual([result.ok, result.code], [false, "BILLING_FAILED"]);
    assert.match(result.error, /CO-00001/);
    assert.match(result.error, /no invoice yet/);
    assert.equal(JSON.stringify(world.state.co), before, "the status write was rolled back");
    assert.equal(world.state.co.status, "Sent");
    assert.equal(world.state.milestones.length, 0);
    assert.equal(activityRows.length, 0);
    assert.equal(world.emails.length, 0);
});

test("T2: a second call is refused as already approved and adds nothing", async () => {
    const first = await core("co-1", input(), deps());
    assert.equal(first.ok, true);
    const second = await core("co-1", input({ expectedUpdatedAt: world.state.co.updatedAt.toISOString() }), deps());
    assert.deepEqual([second.ok, second.code], [false, "ALREADY_APPROVED"]);
    assert.equal(world.state.milestones.length, 2);
    assert.equal(world.emails.length, 1);
});

test("T2: post-commit failures become warnings and the result is still ok", async () => {
    const result = await core("co-1", input(), deps({
        logActivity: async () => { throw new Error("log down"); },
        applySchedule: async () => { throw new Error("schedule down"); },
        notifyTeam: async () => { throw new Error("mail down"); },
        revalidatePath: () => { throw new Error("cache down"); },
    }));
    assert.equal(result.ok, true);
    assert.ok(result.warnings.length >= 3, result.warnings.join(" | "));
    assert.equal(world.state.co.status, "Approved");
    assert.equal(world.state.milestones.length, 2);
});

test("T2: the team email HTML-escapes staff-supplied values", async () => {
    await core("co-1", input({ note: "<script>alert(1)</script>", actor: { userId: "u", name: "Jordan <b>Lee</b>" } }), deps());
    assert.doesNotMatch(world.emails[0].html, /<script>/);
    assert.doesNotMatch(world.emails[0].html, /<b>Lee<\/b>/);
});

test("T2: any non-null approval audit column refuses, even an empty string", async () => {
    fresh({ scheduleAmounts: [400, 600] });
    world.state.co.clientSignatureUrl = "";
    const result = await core("co-1", input(), deps());
    assert.deepEqual([result.ok, result.code], [false, "ALREADY_APPROVED"]);
    assert.equal(world.state.milestones.length, 0);
});
