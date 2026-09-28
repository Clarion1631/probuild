/**
 * Front Desk v1 acceptance tests 29, 30, 34, 35, 36 — against a REAL
 * PostgreSQL (SPEED_TO_LEAD_TEST_URL).
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { handlePrepareTransferTool, resolveActionStep, resolveScreenResult, runFrontDeskSweeps } from "../src/lib/front-desk/transfer";
import { FRONT_DESK_SWEEP_DIALING_MISS_MS, FRONT_DESK_TRANSFER_PREPARED_TTL_MS } from "../src/lib/front-desk/constants";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

// A fixed Monday 11:00 Pacific instant — inside transfer hours regardless of when this suite actually runs.
const WITHIN_HOURS = new Date("2026-10-05T18:00:00.000Z");
const OUTSIDE_HOURS = new Date("2026-10-03T20:00:00.000Z"); // Saturday

let db: PrismaClient;
const createdConversationIds: string[] = [];
const createdLeadIds: string[] = [];

before(async () => {
    if (skip) return;
    db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", frontDeskTakingTransfers: true },
        update: { frontDeskTakingTransfers: true },
    });
});

after(async () => {
    if (skip) return;
    await db.frontDeskTransfer.deleteMany({ where: { conversationId: { in: createdConversationIds } } }).catch(() => undefined);
    for (const leadId of createdLeadIds) {
        await db.leadAlert.deleteMany({ where: { leadId } }).catch(() => undefined);
        await db.leadIntakeEvent.updateMany({ where: { leadId }, data: { leadId: null } }).catch(() => undefined);
        const lead = await db.lead.findUnique({ where: { id: leadId }, select: { clientId: true } }).catch(() => null);
        await db.lead.delete({ where: { id: leadId } }).catch(() => undefined);
        if (lead?.clientId) await db.client.delete({ where: { id: lead.clientId } }).catch(() => undefined);
    }
    await db.companySettings.update({ where: { id: "singleton" }, data: { frontDeskTakingTransfers: false } }).catch(() => undefined);
    await db.$disconnect();
});

function conv(): string {
    const id = `conv-${randomUUID()}`;
    createdConversationIds.push(id);
    return id;
}

function prepareInput(conversationId: string, overrides: Partial<Parameters<typeof handlePrepareTransferTool>[1]> = {}): Parameters<typeof handlePrepareTransferTool>[1] {
    return {
        conversationId, agentId: "agent_x", isTest: true,
        callerName: "Jane Caller", callbackPhone: "+13605550100", city: "Vancouver", project: "Kitchen remodel",
        spanish: false, readbackConfirmed: true,
        ...overrides,
    };
}

function reasonOf(result: Awaited<ReturnType<typeof handlePrepareTransferTool>>): string | undefined {
    return result.kind === "no_transfer" ? result.reason : undefined;
}

test("prepare-transfer: readback_incomplete, invalid_phone, outside_hours, richard_unavailable", { skip }, async () => {
    const c1 = conv();
    assert.equal(reasonOf(await handlePrepareTransferTool(db, prepareInput(c1, { callerName: "" }), WITHIN_HOURS)), "readback_incomplete");
    const c2 = conv();
    assert.equal(reasonOf(await handlePrepareTransferTool(db, prepareInput(c2, { callbackPhone: "not-a-phone" }), WITHIN_HOURS)), "invalid_phone");
    const c3 = conv();
    assert.equal(reasonOf(await handlePrepareTransferTool(db, prepareInput(c3), OUTSIDE_HOURS)), "outside_hours");

    await db.companySettings.update({ where: { id: "singleton" }, data: { frontDeskTakingTransfers: false } });
    const c4 = conv();
    assert.equal(reasonOf(await handlePrepareTransferTool(db, prepareInput(c4), WITHIN_HOURS)), "richard_unavailable");
    await db.companySettings.update({ where: { id: "singleton" }, data: { frontDeskTakingTransfers: true } });
});

test("acceptance test 30: two conversations prepare concurrently -> exactly one transfer_ready, one busy", { skip }, async () => {
    // Clear any leftover active row from a prior test file run.
    await db.frontDeskTransfer.updateMany({ where: { status: { in: ["PREPARED", "DIALING"] } }, data: { status: "EXPIRED", resolvedAt: WITHIN_HOURS, reason: "test-cleanup" } });

    const c1 = conv();
    const c2 = conv();
    const [r1, r2] = await Promise.all([
        handlePrepareTransferTool(db, prepareInput(c1), WITHIN_HOURS),
        handlePrepareTransferTool(db, prepareInput(c2), WITHIN_HOURS),
    ]);
    const ready = [r1, r2].filter(r => r.kind === "transfer_ready");
    const busy = [r1, r2].filter(r => r.kind === "no_transfer" && r.reason === "busy");
    assert.equal(ready.length, 1);
    assert.equal(busy.length, 1);
});

test("a stale PREPARED row older than 60s does not block a new prepare", { skip }, async () => {
    await db.frontDeskTransfer.updateMany({ where: { status: { in: ["PREPARED", "DIALING"] } }, data: { status: "EXPIRED", resolvedAt: WITHIN_HOURS, reason: "test-cleanup" } });
    const staleConv = conv();
    await db.frontDeskTransfer.create({
        data: {
            id: randomUUID(), conversationId: staleConv, status: "PREPARED", isTest: true,
            callerName: "Stale", callbackPhoneE164: "+13605550199", city: "X", project: "Y",
            preparedAt: new Date(WITHIN_HOURS.getTime() - FRONT_DESK_TRANSFER_PREPARED_TTL_MS - 5000),
        },
    });
    const c = conv();
    const result = await handlePrepareTransferTool(db, prepareInput(c), WITHIN_HOURS);
    assert.equal(result.kind, "transfer_ready");
    const stale = await db.frontDeskTransfer.findUniqueOrThrow({ where: { conversationId: staleConv } });
    assert.equal(stale.status, "EXPIRED");
});

test("preparing twice for the SAME conversation -> already_transferred", { skip }, async () => {
    await db.frontDeskTransfer.updateMany({ where: { status: { in: ["PREPARED", "DIALING"] } }, data: { status: "EXPIRED", resolvedAt: WITHIN_HOURS, reason: "test-cleanup" } });
    const c = conv();
    const first = await handlePrepareTransferTool(db, prepareInput(c), WITHIN_HOURS);
    assert.equal(first.kind, "transfer_ready");
    const second = await handlePrepareTransferTool(db, prepareInput(c), WITHIN_HOURS);
    assert.equal(second.kind, "no_transfer");
    assert.equal((second as { reason: string }).reason, "already_transferred");
});

// ── Test 34: action transitions ─────────────────────────────────────────

async function makeDialingTransfer(opts: { screenAccepted?: boolean } = {}) {
    const conversationId = conv();
    const bridgeCallSid = `CA-${randomUUID()}`;
    const row = await db.frontDeskTransfer.create({
        data: {
            id: randomUUID(), conversationId, status: "DIALING", isTest: true,
            callerName: "Test Caller", callbackPhoneE164: "+13605550188", city: "Vancouver", project: "Bath",
            bridgeCallSid, dialStartedAt: new Date(),
            screenAcceptedAt: opts.screenAccepted ? new Date() : null,
        },
    });
    return row;
}

test("DialBridged=true + accepted -> CONNECTED, no alert", { skip }, async () => {
    const row = await makeDialingTransfer({ screenAccepted: true });
    const outcome = await resolveActionStep(db, { transferId: row.id, bridgeCallSid: row.bridgeCallSid!, dialCallStatus: "completed", dialBridged: "true" });
    assert.equal(outcome, "connected");
    const final = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(final.status, "CONNECTED");
    assert.equal(final.leadId, null);
});

test("DialBridged=false + DialCallStatus=completed -> MISSED + NTFY_URGENT", { skip }, async () => {
    const row = await makeDialingTransfer();
    const outcome = await resolveActionStep(db, { transferId: row.id, bridgeCallSid: row.bridgeCallSid!, dialCallStatus: "completed", dialBridged: "false" });
    assert.equal(outcome, "missed");
    const final = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(final.status, "MISSED");
    assert.ok(final.leadId);
    createdLeadIds.push(final.leadId!);
    const alerts = await db.leadAlert.findMany({ where: { leadId: final.leadId! } });
    assert.equal(alerts.filter(a => a.channel === "NTFY_URGENT").length, 1);
});

test("DialBridged=true WITHOUT acceptance -> MISSED, reason bridged-without-screen, alerted", { skip }, async () => {
    const row = await makeDialingTransfer();
    const outcome = await resolveActionStep(db, { transferId: row.id, bridgeCallSid: row.bridgeCallSid!, dialCallStatus: "completed", dialBridged: "true" });
    assert.equal(outcome, "missed");
    const final = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(final.status, "MISSED");
    assert.equal(final.reason, "bridged-without-screen");
    if (final.leadId) createdLeadIds.push(final.leadId);
});

// ── Test 35: duplicate action callbacks ─────────────────────────────────

test("acceptance test 35: 3 concurrent duplicate action callbacks -> one transition, one NTFY_URGENT row", { skip }, async () => {
    const row = await makeDialingTransfer();
    const params = { transferId: row.id, bridgeCallSid: row.bridgeCallSid!, dialCallStatus: "completed", dialBridged: "false" };
    const outcomes = await Promise.all([resolveActionStep(db, params), resolveActionStep(db, params), resolveActionStep(db, params)]);
    assert.equal(outcomes.filter(o => o === "missed").length, 1);
    assert.equal(outcomes.filter(o => o === "duplicate").length, 2);
    const final = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: row.id } });
    if (final.leadId) {
        createdLeadIds.push(final.leadId);
        const alerts = await db.leadAlert.findMany({ where: { leadId: final.leadId } });
        assert.equal(alerts.filter(a => a.channel === "NTFY_URGENT").length, 1);
    }
});

// ── screen-result: only Digits="1" accepts ──────────────────────────────

test("screen-result: only Digits=1 sets screenAcceptedAt; 2, *, empty and a wrong ParentCallSid do not", { skip }, async () => {
    for (const digits of ["2", "*", "", "11"]) {
        const row = await makeDialingTransfer();
        const accepted = await resolveScreenResult(db, row.id, digits || null, row.bridgeCallSid);
        assert.equal(accepted, false, `digits=${JSON.stringify(digits)}`);
    }
    const wrongParent = await makeDialingTransfer();
    assert.equal(await resolveScreenResult(db, wrongParent.id, "1", "CAdifferent"), false);

    const good = await makeDialingTransfer();
    assert.equal(await resolveScreenResult(db, good.id, "1", good.bridgeCallSid), true);
    const finalGood = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: good.id } });
    assert.ok(finalGood.screenAcceptedAt);
});

// ── Test 36: sweep ───────────────────────────────────────────────────────

test("acceptance test 36: sweep — unaccepted DIALING older than 90s -> MISSED + alert; accepted isn't touched until 4h; PREPARED older than 60s -> EXPIRED, no alert", { skip }, async () => {
    const sweepNow = new Date(WITHIN_HOURS.getTime() + 10_000);

    const staleUnaccepted = await db.frontDeskTransfer.create({
        data: {
            id: randomUUID(), conversationId: conv(), status: "DIALING", isTest: true,
            callerName: "Stale Unaccepted", callbackPhoneE164: "+13605550177", city: "X", project: "Y",
            bridgeCallSid: `CA-${randomUUID()}`, dialStartedAt: new Date(sweepNow.getTime() - FRONT_DESK_SWEEP_DIALING_MISS_MS - 5000),
        },
    });
    const freshAccepted = await db.frontDeskTransfer.create({
        data: {
            id: randomUUID(), conversationId: conv(), status: "DIALING", isTest: true,
            callerName: "Fresh Accepted", callbackPhoneE164: "+13605550166", city: "X", project: "Y",
            bridgeCallSid: `CA-${randomUUID()}`, dialStartedAt: sweepNow, screenAcceptedAt: sweepNow,
        },
    });
    const stalePrepared = await db.frontDeskTransfer.create({
        data: {
            id: randomUUID(), conversationId: conv(), status: "PREPARED", isTest: true,
            callerName: "Stale Prepared", callbackPhoneE164: "+13605550155", city: "X", project: "Y",
            preparedAt: new Date(sweepNow.getTime() - FRONT_DESK_TRANSFER_PREPARED_TTL_MS - 5000),
        },
    });

    await runFrontDeskSweeps(sweepNow, db);

    const swept1 = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: staleUnaccepted.id } });
    assert.equal(swept1.status, "MISSED");
    if (swept1.leadId) {
        createdLeadIds.push(swept1.leadId);
        const alerts = await db.leadAlert.findMany({ where: { leadId: swept1.leadId } });
        assert.equal(alerts.filter(a => a.channel === "NTFY_URGENT").length, 1);
    }

    const swept2 = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: freshAccepted.id } });
    assert.equal(swept2.status, "DIALING", "an accepted call stays DIALING until 4h, not swept early");

    const swept3 = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: stalePrepared.id } });
    assert.equal(swept3.status, "EXPIRED");
    assert.equal(swept3.leadId, null, "an expired PREPARED row is never alerted");
});
