/**
 * Front Desk v1 acceptance tests 7 (half), 8, 18, 19, 20, 22, 23, 24, 25, 26,
 * 27 — against a REAL PostgreSQL (SPEED_TO_LEAD_TEST_URL, same opt-in shape
 * as the other front-desk-*-db.test.ts files). Calendly itself is a counting
 * fake over `global.fetch` — nothing here reaches a real host. Also covers
 * Codex SHIP-BLOCKING finding #1 (round 1 review of PR #559).
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { encryptObject } from "../src/lib/crypto";
import { handleBookTool, handleAvailabilityTool, pacificDayStartUtc } from "../src/lib/front-desk/booking";
import { pacificDateString, pacificTimeString } from "../src/lib/front-desk/constants";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-front-desk-booking-tests";
process.env.FRONT_DESK_BOOKING = "ON";
process.env.FRONT_DESK_TEST_INVITEE_DOMAINS = "example.test";
// Codex SHIP-BLOCKING finding #1 (round 1 review of PR #559): a real
// Calendly invitee POST can send the customer an email/calendar invite
// Calendly controls, so it stays behind this SECOND gate
// (`frontDeskBookingLiveSendVerified`), independent of FRONT_DESK_BOOKING,
// until a verified no-send mechanism exists. This whole file deliberately
// sets it ON, alongside FRONT_DESK_BOOKING, so the reservation/POST state
// machine below — replay, caps, races — stays fully exercised for when it is
// eventually re-enabled for real. The disabled-by-default behavior itself
// (this flag left OFF) is proven separately, below.
process.env.FRONT_DESK_BOOKING_LIVE_SEND = "ON";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

const TEST_EVENT_TYPE_URI = "https://api.calendly.com/event_types/front-desk-test";
const TEST_USER_URI = "https://api.calendly.com/users/richard-test";

let db: PrismaClient;
let originalFetch: typeof fetch;
let inviteePostCount = 0;
let inviteeResponder: (requestBody: unknown) => { status: number; json?: unknown } = () => ({
    status: 201,
    json: { resource: { uri: `https://api.calendly.com/scheduled_events/x/invitees/${randomUUID()}` }, event: "https://api.calendly.com/scheduled_events/x", cancel_url: "https://calendly.com/cancel", reschedule_url: "https://calendly.com/reschedule" },
});
/** §2.1 availability tool (tests 7 half, 18, 19) — a counting fake over `/event_type_available_times`. */
let availableTimesResponder: () => { status: number; json?: unknown } = () => ({ status: 200, json: { collection: [] } });
let availableTimesCallCount = 0;

function fakeResponse(status: number, json: unknown): Response {
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

before(async () => {
    if (skip) return;
    db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: {
            id: "singleton",
            frontDeskCalendlyTokenEnc: encryptObject({ token: "fake-token" }),
            frontDeskCalendlyUserUri: TEST_USER_URI,
            frontDeskCalendlyTestEventTypeUri: TEST_EVENT_TYPE_URI,
        },
        update: {
            frontDeskCalendlyTokenEnc: encryptObject({ token: "fake-token" }),
            frontDeskCalendlyUserUri: TEST_USER_URI,
            frontDeskCalendlyTestEventTypeUri: TEST_EVENT_TYPE_URI,
        },
    });

    originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/invitees") && init?.method === "POST") {
            inviteePostCount++;
            const body = JSON.parse(String(init.body));
            const result = inviteeResponder(body);
            return fakeResponse(result.status, result.json ?? {});
        }
        if (url.includes("/event_type_available_times")) {
            availableTimesCallCount++;
            const result = availableTimesResponder();
            return fakeResponse(result.status, result.json ?? {});
        }
        return fakeResponse(404, { message: "unhandled in test fake" });
    }) as typeof fetch;
});

after(async () => {
    if (skip) return;
    global.fetch = originalFetch;
    await db.frontDeskBooking.deleteMany({});
    await db.frontDeskCall.deleteMany({});
    await db.companySettings.update({ where: { id: "singleton" }, data: { frontDeskCalendlyTokenEnc: null, frontDeskCalendlyUserUri: null, frontDeskCalendlyTestEventTypeUri: null } }).catch(() => undefined);
    await db.$disconnect();
});

beforeEach(async () => {
    inviteePostCount = 0;
    inviteeResponder = () => ({
        status: 201,
        json: { resource: { uri: `https://api.calendly.com/scheduled_events/x/invitees/${randomUUID()}` }, event: "https://api.calendly.com/scheduled_events/x", cancel_url: "https://calendly.com/cancel", reschedule_url: "https://calendly.com/reschedule" },
    });
    availableTimesResponder = () => ({ status: 200, json: { collection: [] } });
    availableTimesCallCount = 0;
    // The daily cap (§2.2 step 3.5) counts every active row created TODAY
    // across the WHOLE table — real, and shared by every test below in this
    // one file's run against one real Postgres. Without this, a test late in
    // the file inherits however much of the day's 6-row budget earlier tests
    // happened to consume, rather than proving the cap on its own terms.
    if (!skip) await db.frontDeskBooking.deleteMany({});
});

async function seedCallWithSlot(conversationId: string, slot: { id: string; startTime: string; expiresAt: string; offer: number }) {
    await db.frontDeskCall.create({
        data: { id: randomUUID(), conversationId, isTest: true, offeredSlots: [slot] as unknown as object, slotSeq: 1 },
    });
}

function futureSlot(hoursFromNow: number, id = "1") {
    const start = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
    // Round to an even hour so distinct conversations can share the exact same start time deterministically.
    start.setUTCMinutes(0, 0, 0);
    return { id, startTime: start.toISOString(), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
}

function bookInput(overrides: Partial<Parameters<typeof handleBookTool>[1]> = {}): Parameters<typeof handleBookTool>[1] {
    const conversationId = overrides.conversationId ?? `conv-${randomUUID()}`;
    return {
        conversationId,
        agentId: "agent_x",
        callerId: null,
        isTest: true,
        slotId: "1",
        confirmedDate: "",
        confirmedTime: "",
        name: "Race Caller",
        email: `race-${randomUUID()}@example.test`,
        // A random suffix, not a fixed constant: two tests in this file that
        // each book a real slot and don't care about phone collisions must
        // never accidentally trip §2.2's "double booking by phone" guard
        // against EACH OTHER (they share one real, uncleaned-between-tests
        // Postgres table within this file's run).
        callbackPhone: `+1360555${String(1000 + Math.floor(Math.random() * 9000))}`,
        readbackConfirmed: true,
        ...overrides,
    };
}

// ── Test 20: read-back guard ──────────────────────────────────────────────

test("read-back guard: a missing required field -> readback_incomplete, no Calendly POST", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const slot = futureSlot(24);
    await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
    const result = await handleBookTool(db, bookInput({ conversationId, slotId: slot.id, confirmedDate: "", confirmedTime: "", readbackConfirmed: true }));
    assert.equal(result.kind, "not_booked");
    assert.equal((result as { reason: string }).reason, "readback_incomplete");
    assert.equal(inviteePostCount, 0);
});

test("read-back guard: readback_confirmed:false -> readback_incomplete", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const slot = futureSlot(24);
    await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
    const result = await handleBookTool(db, bookInput({ conversationId, slotId: slot.id, confirmedDate: "2099-01-01", confirmedTime: "09:00", readbackConfirmed: false }));
    assert.equal((result as { reason: string }).reason, "readback_incomplete");
    assert.equal(inviteePostCount, 0);
});

test("read-back guard: a mismatched date/time -> readback_mismatch, no POST", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const slot = futureSlot(24);
    await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
    const result = await handleBookTool(db, bookInput({ conversationId, slotId: slot.id, confirmedDate: "2099-01-01", confirmedTime: "09:00", readbackConfirmed: true }));
    assert.equal((result as { reason: string }).reason, "readback_mismatch");
    assert.equal(inviteePostCount, 0);
});

test("an unknown slot_id -> slot_unknown; an expired slot -> slot_expired", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const slot = futureSlot(24);
    const expired = { id: "2", startTime: futureSlot(48, "2").startTime, expiresAt: new Date(Date.now() - 1000).toISOString(), offer: 1 };
    await db.frontDeskCall.create({ data: { id: randomUUID(), conversationId, isTest: true, offeredSlots: [{ ...slot, offer: 1 }, expired] as unknown as object, slotSeq: 2 } });

    const unknown = await handleBookTool(db, bookInput({ conversationId, slotId: "no-such-id", confirmedDate: "2099-01-01", confirmedTime: "09:00" }));
    assert.equal((unknown as { reason: string }).reason, "slot_unknown");

    const expiredResult = await handleBookTool(db, bookInput({ conversationId, slotId: "2", confirmedDate: "2099-01-01", confirmedTime: "09:00" }));
    assert.equal((expiredResult as { reason: string }).reason, "slot_expired");
    assert.equal(inviteePostCount, 0);
});

// ── Test 21/22: POST body shape and outcome mapping ────────────────────────

test("the invitee POST body has the fixed location.kind and timezone, and never carries text_reminder_number/event_guests/questions_and_answers", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const slot = futureSlot(24);
    await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
    let capturedBody: Record<string, unknown> | null = null;
    inviteeResponder = body => {
        capturedBody = body as Record<string, unknown>;
        return { status: 201, json: { resource: { uri: "https://api.calendly.com/x/invitees/y" }, event: "https://api.calendly.com/x", cancel_url: "c", reschedule_url: "r" } };
    };
    const dateStr = pacificDateString(new Date(slot.startTime));
    const result = await handleBookTool(db, bookInput({ conversationId, slotId: slot.id, confirmedDate: dateStr, confirmedTime: pacificTimeString(new Date(slot.startTime)) }));
    assert.equal(result.kind, result.kind); // no-op — real assertion is on the body below; date/time formatting is UTC-based here purely to reach a POST
    assert.ok(capturedBody);
    const body = capturedBody as unknown as { location: { kind: string }; invitee: { timezone: string }; tracking: { utm_content: string } };
    assert.equal(body.location.kind, "outbound_call");
    assert.equal(body.invitee.timezone, "America/Los_Angeles");
    assert.ok(body.tracking.utm_content);
    const json = JSON.stringify(body);
    assert.doesNotMatch(json, /text_reminder_number/);
    assert.doesNotMatch(json, /event_guests/);
    assert.doesNotMatch(json, /questions_and_answers/);
});

// ── Test 23: concurrent identical requests -> one POST, both booked ────────

test("acceptance test 23: 2 concurrent identical book requests produce ONE Calendly POST and both answers equal booked", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const slot = futureSlot(30);
    await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
    const email = `same-${randomUUID()}@example.test`;
    const dateStr = pacificDateString(new Date(slot.startTime));
    const timeStr = pacificTimeString(new Date(slot.startTime));
    const input = bookInput({ conversationId, slotId: slot.id, confirmedDate: dateStr, confirmedTime: timeStr, email, callbackPhone: "+13605550111", name: "Same Caller" });

    const [a, b] = await Promise.all([handleBookTool(db, input), handleBookTool(db, input)]);
    assert.equal(a.kind, "booked");
    assert.equal(b.kind, "booked");
    assert.equal(inviteePostCount, 1, "exactly one Calendly POST for two identical concurrent requests");
});

// ── Test 24: same slot, two conversations -> one POST, the other slot_taken ─

test("acceptance test 24: two conversations booking the SAME slot concurrently -> one POST, the other gets slot_taken", { skip }, async () => {
    const slot = futureSlot(31);
    const dateStr = pacificDateString(new Date(slot.startTime));
    const timeStr = pacificTimeString(new Date(slot.startTime));

    const conv1 = `conv-${randomUUID()}`;
    const conv2 = `conv-${randomUUID()}`;
    await seedCallWithSlot(conv1, { ...slot, offer: 1 });
    await seedCallWithSlot(conv2, { ...slot, offer: 1 });

    const input1 = bookInput({ conversationId: conv1, slotId: slot.id, confirmedDate: dateStr, confirmedTime: timeStr, email: `c1-${randomUUID()}@example.test`, callbackPhone: "+13605550121" });
    const input2 = bookInput({ conversationId: conv2, slotId: slot.id, confirmedDate: dateStr, confirmedTime: timeStr, email: `c2-${randomUUID()}@example.test`, callbackPhone: "+13605550122" });

    const [r1, r2] = await Promise.all([handleBookTool(db, input1), handleBookTool(db, input2)]);
    const outcomes = [r1, r2];
    const booked = outcomes.filter(r => r.kind === "booked");
    const slotTaken = outcomes.filter(r => r.kind === "not_booked" && (r as { reason: string }).reason === "slot_taken");
    assert.equal(booked.length, 1);
    assert.equal(slotTaken.length, 1);
    assert.equal(inviteePostCount, 1);
});

// ── Test 25: same phone/email, different slots -> already_booked ───────────

test("acceptance test 25: two conversations, same phone, different slots -> one booked, the other already_booked", { skip }, async () => {
    const slotA = futureSlot(32, "1");
    const slotB = futureSlot(33, "1");
    const conv1 = `conv-${randomUUID()}`;
    const conv2 = `conv-${randomUUID()}`;
    await seedCallWithSlot(conv1, { ...slotA, offer: 1 });
    await seedCallWithSlot(conv2, { ...slotB, offer: 1 });

    const phone = "+13605550131";
    const input1 = bookInput({ conversationId: conv1, slotId: "1", confirmedDate: pacificDateString(new Date(slotA.startTime)), confirmedTime: pacificTimeString(new Date(slotA.startTime)), callbackPhone: phone });
    const input2 = bookInput({ conversationId: conv2, slotId: "1", confirmedDate: pacificDateString(new Date(slotB.startTime)), confirmedTime: pacificTimeString(new Date(slotB.startTime)), callbackPhone: phone });

    const r1 = await handleBookTool(db, input1);
    assert.equal(r1.kind, "booked");
    const r2 = await handleBookTool(db, input2);
    assert.equal(r2.kind, "not_booked");
    assert.equal((r2 as { reason: string }).reason, "already_booked");
});

test("same email, different slots -> the second gets already_booked", { skip }, async () => {
    const slotA = futureSlot(34, "1");
    const slotB = futureSlot(35, "1");
    const conv1 = `conv-${randomUUID()}`;
    const conv2 = `conv-${randomUUID()}`;
    await seedCallWithSlot(conv1, { ...slotA, offer: 1 });
    await seedCallWithSlot(conv2, { ...slotB, offer: 1 });

    const email = `dupe-${randomUUID()}@example.test`;
    const input1 = bookInput({ conversationId: conv1, slotId: "1", confirmedDate: pacificDateString(new Date(slotA.startTime)), confirmedTime: pacificTimeString(new Date(slotA.startTime)), email, callbackPhone: "+13605550141" });
    const input2 = bookInput({ conversationId: conv2, slotId: "1", confirmedDate: pacificDateString(new Date(slotB.startTime)), confirmedTime: pacificTimeString(new Date(slotB.startTime)), email, callbackPhone: "+13605550142" });

    const r1 = await handleBookTool(db, input1);
    assert.equal(r1.kind, "booked");
    const r2 = await handleBookTool(db, input2);
    assert.equal((r2 as { reason: string }).reason, "already_booked");
});

// ── Test 26: one booking per call, then retry after rejection ──────────────

test("acceptance test 26: after booked, a second slot in the same call -> already_booked; after a rejection, a new slot is allowed; the 4th attempt -> too_many_attempts", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const slot1 = futureSlot(40, "1");
    await seedCallWithSlot(conversationId, { ...slot1, offer: 1 });
    const input1 = bookInput({ conversationId, slotId: "1", confirmedDate: pacificDateString(new Date(slot1.startTime)), confirmedTime: pacificTimeString(new Date(slot1.startTime)) });
    const first = await handleBookTool(db, input1);
    assert.equal(first.kind, "booked");

    const slot2 = futureSlot(41, "2");
    await db.frontDeskCall.updateMany({ where: { conversationId }, data: { offeredSlots: [{ ...slot1, offer: 1 }, { ...slot2, offer: 2 }] as unknown as object, slotSeq: 2 } });
    const secondAttempt = await handleBookTool(db, bookInput({ conversationId, slotId: "2", confirmedDate: pacificDateString(new Date(slot2.startTime)), confirmedTime: pacificTimeString(new Date(slot2.startTime)) }));
    assert.equal((secondAttempt as { reason: string }).reason, "already_booked");
});

test("after a Calendly rejection, a fresh slot may be attempted; the 4th attempt in one call -> too_many_attempts", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    inviteeResponder = () => ({ status: 400, json: { message: "invalid" } });

    for (let i = 1; i <= 3; i++) {
        const slot = futureSlot(50 + i, String(i));
        const existing = await db.frontDeskCall.findUnique({ where: { conversationId } });
        const slots = ((existing?.offeredSlots as unknown[]) ?? []).concat([{ ...slot, offer: i }]);
        if (existing) {
            await db.frontDeskCall.update({ where: { conversationId }, data: { offeredSlots: slots as unknown as object, slotSeq: i } });
        } else {
            await db.frontDeskCall.create({ data: { id: randomUUID(), conversationId, isTest: true, offeredSlots: slots as unknown as object, slotSeq: i } });
        }
        const result = await handleBookTool(db, bookInput({ conversationId, slotId: String(i), confirmedDate: pacificDateString(new Date(slot.startTime)), confirmedTime: pacificTimeString(new Date(slot.startTime)) }));
        if (i <= 3) assert.equal((result as { reason: string }).reason, "calendly_rejected", `attempt ${i}`);
    }

    // 4th attempt: too_many_attempts, checked BEFORE any Calendly call.
    const slot4 = futureSlot(60, "4");
    const existing = await db.frontDeskCall.findUnique({ where: { conversationId } });
    const slots = ((existing?.offeredSlots as unknown[]) ?? []).concat([{ ...slot4, offer: 4 }]);
    await db.frontDeskCall.update({ where: { conversationId }, data: { offeredSlots: slots as unknown as object } });
    const before = inviteePostCount;
    const fourth = await handleBookTool(db, bookInput({ conversationId, slotId: "4", confirmedDate: pacificDateString(new Date(slot4.startTime)), confirmedTime: pacificTimeString(new Date(slot4.startTime)) }));
    assert.equal((fourth as { reason: string }).reason, "too_many_attempts");
    assert.equal(inviteePostCount, before, "too_many_attempts must not POST to Calendly");
});

// ── Test 27: the daily cap ──────────────────────────────────────────────

test("acceptance test 27: 8 concurrent bookings (distinct callers/slots), cap 6 -> exactly 6 succeed to SUBMITTING-or-better and 2 get daily_cap", { skip }, async () => {
    const inputs = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
        const conversationId = `conv-cap-${randomUUID()}`;
        const slot = futureSlot(80 + i, "1");
        await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
        return bookInput({
            conversationId, slotId: "1",
            confirmedDate: pacificDateString(new Date(slot.startTime)),
            confirmedTime: pacificTimeString(new Date(slot.startTime)),
            email: `cap-${i}-${randomUUID()}@example.test`,
            callbackPhone: `+1360555${String(1000 + i).slice(-4)}`,
        });
    }));

    const results = await Promise.all(inputs.map(input => handleBookTool(db, input)));
    const succeeded = results.filter(r => r.kind === "booked" || r.kind === "uncertain");
    const capped = results.filter(r => r.kind === "not_booked" && (r as { reason: string }).reason === "daily_cap");
    assert.equal(succeeded.length, 6, JSON.stringify(results));
    assert.equal(capped.length, 2, JSON.stringify(results));
});

// ── Codex SHIP-BLOCKING finding #1 (round 1 review of PR #559) ────────────
//
// A real Calendly invitee POST sends the customer an email/calendar invite
// Calendly itself controls — omitting text_reminder_number does not suppress
// it. `frontDeskBookingLiveSendVerified` is a SECOND gate, independent of
// FRONT_DESK_BOOKING, that must ALSO be explicitly ON before any POST is
// attempted. This file otherwise sets it ON everywhere above so the
// reservation/POST state machine stays fully proven; these tests are the one
// place it is deliberately left at its real, safe default (OFF).

test("Codex finding #1: with FRONT_DESK_BOOKING_LIVE_SEND unset (the real default), handleBookTool never calls Calendly — even with FRONT_DESK_BOOKING=ON — and makes zero FrontDeskBooking writes", { skip }, async () => {
    const original = process.env.FRONT_DESK_BOOKING_LIVE_SEND;
    delete process.env.FRONT_DESK_BOOKING_LIVE_SEND;
    try {
        const conversationId = `conv-${randomUUID()}`;
        const slot = futureSlot(90);
        await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
        const before = inviteePostCount;
        const result = await handleBookTool(db, bookInput({
            conversationId, slotId: slot.id,
            confirmedDate: pacificDateString(new Date(slot.startTime)),
            confirmedTime: pacificTimeString(new Date(slot.startTime)),
        }));
        assert.equal(result.kind, "not_booked");
        assert.equal((result as { reason: string }).reason, "booking_disabled");
        assert.equal((result as { mode?: string }).mode, "take_preferred_times");
        assert.equal(inviteePostCount, before, "no Calendly POST may ever happen while the live-send gate is off");
        const rows = await db.frontDeskBooking.findMany({ where: { conversationId } });
        assert.deepEqual(rows, [], "no FrontDeskBooking row at all — the gate is checked before any reservation attempt");
    } finally {
        if (original === undefined) delete process.env.FRONT_DESK_BOOKING_LIVE_SEND;
        else process.env.FRONT_DESK_BOOKING_LIVE_SEND = original;
    }
});

test("Codex finding #1: FRONT_DESK_BOOKING_LIVE_SEND='off' (garbage/explicit-off) also disables booking", { skip }, async () => {
    const original = process.env.FRONT_DESK_BOOKING_LIVE_SEND;
    process.env.FRONT_DESK_BOOKING_LIVE_SEND = "off";
    try {
        const conversationId = `conv-${randomUUID()}`;
        const slot = futureSlot(91);
        await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
        const result = await handleBookTool(db, bookInput({
            conversationId, slotId: slot.id,
            confirmedDate: pacificDateString(new Date(slot.startTime)),
            confirmedTime: pacificTimeString(new Date(slot.startTime)),
        }));
        assert.equal((result as { reason: string }).reason, "booking_disabled");
    } finally {
        if (original === undefined) delete process.env.FRONT_DESK_BOOKING_LIVE_SEND;
        else process.env.FRONT_DESK_BOOKING_LIVE_SEND = original;
    }
});

// ── Test 8: TEST-mode invitee-domain restriction ───────────────────────────

test("acceptance test 8: in TEST, an invitee email outside FRONT_DESK_TEST_INVITEE_DOMAINS -> test_invitee_not_allowed, with no POST", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const slot = futureSlot(92);
    await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
    const before = inviteePostCount;
    const result = await handleBookTool(db, bookInput({
        conversationId, slotId: slot.id,
        confirmedDate: pacificDateString(new Date(slot.startTime)),
        confirmedTime: pacificTimeString(new Date(slot.startTime)),
        email: `not-allowed-${randomUUID()}@not-example.test`,
        isTest: true,
    }));
    assert.equal(result.kind, "not_booked");
    assert.equal((result as { reason: string }).reason, "test_invitee_not_allowed");
    assert.equal(inviteePostCount, before);
});

test("acceptance test 8: in TEST, an invitee email ON the allowlist proceeds past the domain check", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const slot = futureSlot(93);
    await seedCallWithSlot(conversationId, { ...slot, offer: 1 });
    const result = await handleBookTool(db, bookInput({
        conversationId, slotId: slot.id,
        confirmedDate: pacificDateString(new Date(slot.startTime)),
        confirmedTime: pacificTimeString(new Date(slot.startTime)),
        email: `allowed-${randomUUID()}@example.test`,
        isTest: true,
    }));
    assert.notEqual((result as { reason?: string }).reason, "test_invitee_not_allowed");
});

// ── Availability tool (tests 7 half, 18, 19) — zero prior coverage ─────────

function availabilityInput(overrides: Partial<Parameters<typeof handleAvailabilityTool>[1]> = {}): Parameters<typeof handleAvailabilityTool>[1] {
    return {
        conversationId: `conv-${randomUUID()}`,
        agentId: "agent_x",
        isTest: true,
        preferredDate: null,
        partOfDay: null,
        ...overrides,
    };
}

test("acceptance test 18: available slots come back in Pacific (spoken/date/time), at most 3, correct across the PDT->PST fall-back", { skip }, async () => {
    // 2026-11-01 02:00 Pacific is the fall-back instant; pick times either side of it.
    const times = [
        "2026-10-30T16:00:00.000Z", // 2026-10-30 09:00 PDT
        "2026-10-30T17:00:00.000Z",
        "2026-11-02T17:00:00.000Z", // 2026-11-02 09:00 PST (after fall-back)
        "2026-11-02T18:00:00.000Z",
    ];
    availableTimesResponder = () => ({ status: 200, json: { collection: times.map(t => ({ status: "available", invitee_remaining: 1, start_time: t })) } });
    const now = new Date("2026-10-25T12:00:00.000Z"); // inside the 7-day window for all four times above
    const result = await handleAvailabilityTool(db, availabilityInput(), now);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.ok(result.slots.length <= 3, "at most 3 slots per offer");
    assert.equal(result.timezone, "America/Los_Angeles");
    const first = result.slots[0];
    assert.equal(first.date, "2026-10-30");
    assert.equal(first.time, "09:00");
    assert.match(first.spoken, /9:00\s*AM Pacific$/);
});

test("acceptance test 18: any Calendly availability failure -> take_preferred_times:calendly_unavailable, never slots", { skip }, async () => {
    availableTimesResponder = () => ({ status: 500, json: { message: "outage" } });
    const result = await handleAvailabilityTool(db, availabilityInput(), new Date());
    assert.equal(result.status, "take_preferred_times");
    assert.equal((result as { reason: string }).reason, "calendly_unavailable");
});

test("acceptance test 19: slot ids are never reused across re-offers in the same call; the 4th offer call -> offer_limit", { skip }, async () => {
    // 4 available times per offer so each of the 3 offer calls gets a fresh, non-overlapping set.
    availableTimesResponder = () => ({
        status: 200,
        json: {
            collection: Array.from({ length: 4 }, (_, i) => ({
                status: "available", invitee_remaining: 1,
                start_time: new Date(Date.now() + (24 + i * 6) * 60 * 60 * 1000).toISOString(),
            })),
        },
    });
    const input = availabilityInput();
    const now = new Date();

    const offer1 = await handleAvailabilityTool(db, input, now);
    assert.equal(offer1.status, "ok");
    const offer2 = await handleAvailabilityTool(db, input, now);
    assert.equal(offer2.status, "ok");
    const offer3 = await handleAvailabilityTool(db, input, now);
    assert.equal(offer3.status, "ok");

    const allIds = [offer1, offer2, offer3].flatMap(r => (r.status === "ok" ? r.slots.map(s => s.slot_id) : []));
    assert.equal(new Set(allIds).size, allIds.length, "no slot_id was reused across the 3 offer calls");

    const offer4 = await handleAvailabilityTool(db, input, now);
    assert.equal(offer4.status, "take_preferred_times");
    assert.equal((offer4 as { reason: string }).reason, "offer_limit");
});

test("acceptance test 7 (half): FRONT_DESK_BOOKING off -> availability take_preferred_times:booking_off, no Calendly call", { skip }, async () => {
    const original = process.env.FRONT_DESK_BOOKING;
    process.env.FRONT_DESK_BOOKING = "OFF";
    try {
        const before = availableTimesCallCount;
        const result = await handleAvailabilityTool(db, availabilityInput(), new Date());
        assert.equal(result.status, "take_preferred_times");
        assert.equal((result as { reason: string }).reason, "booking_off");
        assert.equal(availableTimesCallCount, before);
    } finally {
        process.env.FRONT_DESK_BOOKING = original;
    }
});

// ── pacificDayStartUtc ────────────────────────────────────────────────────

test("pacificDayStartUtc returns the UTC instant of Pacific local midnight, correct across DST", () => {
    const oct30 = pacificDayStartUtc(new Date("2026-10-30T20:00:00.000Z")); // PDT day
    // Pacific midnight on 2026-10-30 is 2026-10-30T07:00:00Z (UTC-7).
    assert.equal(oct30.toISOString(), "2026-10-30T07:00:00.000Z");
    const nov3 = pacificDayStartUtc(new Date("2026-11-03T20:00:00.000Z")); // PST day, after fall-back
    assert.equal(nov3.toISOString(), "2026-11-03T08:00:00.000Z");
});
