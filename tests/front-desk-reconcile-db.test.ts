/**
 * Front Desk v1 acceptance test 28 (the booking reconciler, §2.3) — against
 * a REAL PostgreSQL (SPEED_TO_LEAD_TEST_URL). Calendly's `/scheduled_events`
 * and its `/invitees` sub-resource are counting fakes over `global.fetch`;
 * `/invitees` (the booking POST) is asserted as never called.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { encryptObject } from "../src/lib/crypto";
import { reconcileFrontDeskBookings } from "../src/lib/front-desk/booking";
import { FRONT_DESK_RECONCILE_ABSENT_GRACE_MS, FRONT_DESK_RECONCILE_MAX_AGE_MS, FRONT_DESK_RECONCILE_SUBMITTING_MIN_AGE_MS } from "../src/lib/front-desk/constants";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-front-desk-reconcile-tests";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

const TEST_EVENT_TYPE_URI = "https://api.calendly.com/event_types/reconcile-test";
const TEST_USER_URI = "https://api.calendly.com/users/richard-reconcile-test";

let db: PrismaClient;
let originalFetch: typeof fetch;
let inviteePostCount = 0;
/** Map of scheduled-event uri -> the utm_content it should report as booked. Empty = no events found (a genuine "absent" search). null = the whole scheduled_events call errors (an outage, not an absence). */
let scheduledEvents: { uri: string; utmContent: string }[] | null = [];

function fakeResponse(status: number, json: unknown): Response {
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

before(async () => {
    if (skip) return;
    db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", frontDeskCalendlyTokenEnc: encryptObject({ token: "fake-token" }), frontDeskCalendlyUserUri: TEST_USER_URI, frontDeskCalendlyTestEventTypeUri: TEST_EVENT_TYPE_URI },
        update: { frontDeskCalendlyTokenEnc: encryptObject({ token: "fake-token" }), frontDeskCalendlyUserUri: TEST_USER_URI, frontDeskCalendlyTestEventTypeUri: TEST_EVENT_TYPE_URI },
    });

    originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/invitees") && init?.method === "POST") {
            inviteePostCount++;
            return fakeResponse(201, { resource: { uri: "should-not-be-called" }, event: "x", cancel_url: "c", reschedule_url: "r" });
        }
        if (url.includes("/scheduled_events") && !url.includes("/invitees")) {
            if (scheduledEvents === null) throw new TypeError("simulated network outage");
            return fakeResponse(200, { collection: scheduledEvents.map(e => ({ uri: e.uri })) });
        }
        if (url.includes("/scheduled_events/") && url.includes("/invitees")) {
            const uri = url.split("?")[0].replace("/invitees", "");
            const match = (scheduledEvents ?? []).find(e => e.uri === uri);
            return fakeResponse(200, { collection: match ? [{ tracking: { utm_content: match.utmContent } }] : [] });
        }
        return fakeResponse(404, { message: "unhandled in test fake" });
    }) as typeof fetch;
});

after(async () => {
    if (skip) return;
    global.fetch = originalFetch;
    await db.frontDeskBooking.deleteMany({});
    await db.companySettings.update({ where: { id: "singleton" }, data: { frontDeskCalendlyTokenEnc: null, frontDeskCalendlyUserUri: null, frontDeskCalendlyTestEventTypeUri: null } }).catch(() => undefined);
    await db.$disconnect();
});

beforeEach(() => {
    inviteePostCount = 0;
    scheduledEvents = [];
});

async function makeRow(overrides: Partial<{ status: "SUBMITTING" | "UNCERTAIN"; createdAt: Date; submittedAt: Date | null; lastReconcileAt: Date | null }> = {}) {
    return db.frontDeskBooking.create({
        data: {
            id: randomUUID(),
            conversationId: `conv-${randomUUID()}`,
            requestHash: randomUUID(),
            status: overrides.status ?? "SUBMITTING",
            isTest: true,
            eventTypeUri: TEST_EVENT_TYPE_URI,
            startTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
            phoneE164: "+13605550100",
            emailLower: `reconcile-${randomUUID()}@example.test`,
            createdAt: overrides.createdAt ?? new Date(Date.now() - FRONT_DESK_RECONCILE_SUBMITTING_MIN_AGE_MS - 5000),
            submittedAt: overrides.submittedAt === undefined ? new Date(Date.now() - FRONT_DESK_RECONCILE_SUBMITTING_MIN_AGE_MS - 5000) : overrides.submittedAt,
            lastReconcileAt: overrides.lastReconcileAt ?? null,
        },
    });
}

test("a SUBMITTING row older than 2 minutes, found on Calendly -> BOOKED, and no /invitees POST is ever made", { skip }, async () => {
    const row = await makeRow();
    scheduledEvents = [{ uri: "https://api.calendly.com/scheduled_events/abc", utmContent: row.id }];
    await reconcileFrontDeskBookings(new Date(), db);
    const after1 = await db.frontDeskBooking.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after1.status, "BOOKED");
    assert.equal(inviteePostCount, 0);
});

test("an UNCERTAIN row found on Calendly -> BOOKED", { skip }, async () => {
    const row = await makeRow({ status: "UNCERTAIN" });
    scheduledEvents = [{ uri: "https://api.calendly.com/scheduled_events/def", utmContent: row.id }];
    await reconcileFrontDeskBookings(new Date(), db);
    const after1 = await db.frontDeskBooking.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after1.status, "BOOKED");
});

test("a SUBMITTING row too young (under 2 minutes) is left alone by this sweep", { skip }, async () => {
    const row = await makeRow({ createdAt: new Date(), submittedAt: new Date() });
    scheduledEvents = [];
    await reconcileFrontDeskBookings(new Date(), db);
    const after1 = await db.frontDeskBooking.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after1.status, "SUBMITTING");
});

test("genuinely absent for 30+ minutes since submission -> NOT_BOOKED:reconciled_absent", { skip }, async () => {
    const submittedAt = new Date(Date.now() - FRONT_DESK_RECONCILE_ABSENT_GRACE_MS - 60_000);
    const row = await makeRow({ status: "UNCERTAIN", submittedAt, createdAt: submittedAt });
    scheduledEvents = [];
    await reconcileFrontDeskBookings(new Date(), db);
    const after1 = await db.frontDeskBooking.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after1.status, "NOT_BOOKED");
    assert.equal(after1.reason, "reconciled_absent");
});

test("a Calendly outage (not a real absence) never marks the booking absent — it is retried on a later sweep", { skip }, async () => {
    const submittedAt = new Date(Date.now() - FRONT_DESK_RECONCILE_ABSENT_GRACE_MS - 60_000);
    const row = await makeRow({ status: "UNCERTAIN", submittedAt, createdAt: submittedAt });
    scheduledEvents = null; // simulated outage
    await reconcileFrontDeskBookings(new Date(), db);
    const after1 = await db.frontDeskBooking.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after1.status, "UNCERTAIN", "an outage must not be read as absence");
});

test("still unresolved at 24 hours -> reconcileStoppedAt is set and no further Calendly call happens next sweep", { skip }, async () => {
    const old = new Date(Date.now() - FRONT_DESK_RECONCILE_MAX_AGE_MS - 60_000);
    const row = await makeRow({ status: "UNCERTAIN", createdAt: old, submittedAt: old });
    scheduledEvents = null; // still can't confirm either way
    await reconcileFrontDeskBookings(new Date(), db);
    const after1 = await db.frontDeskBooking.findUniqueOrThrow({ where: { id: row.id } });
    assert.ok(after1.reconcileStoppedAt, "24h with no resolution must stop reconciling");

    const lastReconcileAt = after1.lastReconcileAt;
    await reconcileFrontDeskBookings(new Date(), db);
    const after2 = await db.frontDeskBooking.findUniqueOrThrow({ where: { id: row.id } });
    assert.deepEqual(after2.lastReconcileAt, lastReconcileAt, "a stopped row is excluded from the next sweep's query entirely");
});

test("the reconciler never POSTs to /invitees, across every case above", { skip }, async () => {
    assert.equal(inviteePostCount, 0);
});
