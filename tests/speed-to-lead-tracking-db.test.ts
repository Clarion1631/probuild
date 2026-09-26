/**
 * Booked/Called and the 09:00 digest, against a REAL PostgreSQL — round-2
 * gap (acceptance tests 21 and 22): tracking.ts (markLeadBooked,
 * markLeadCalled, send0900Digest, maybeSend0900Digest) had zero automated
 * test coverage before this file. Also covers acceptance test 9's last,
 * previously-unverified claim: `promoteLeadToReal` creates no new alert.
 *
 * Opt-in by URL, same convention as tests/speed-to-lead-intake-db.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PrismaClient } from "@prisma/client";
import { intakeWebhookLead, promoteLeadToReal } from "../src/lib/speed-to-lead/intake";
import { markLeadBooked, markLeadCalled, send0900Digest, maybeSend0900Digest } from "../src/lib/speed-to-lead/tracking";
import type { WebIntakePayload } from "../src/lib/speed-to-lead/payload";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

// 09:00 America/Los_Angeles on a standard-time (non-DST) date, so the fixed
// UTC offset is exact regardless of the machine running this test's own
// local time zone.
const NINE_AM_PACIFIC = new Date("2026-01-15T09:00:00-08:00");
const NOT_NINE_AM_PACIFIC = new Date("2026-01-15T14:00:00-08:00");

async function startSink(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
    let hitCount = 0;
    const server = http.createServer((req, res) => {
        hitCount++;
        req.resume();
        res.setHeader("Connection", "close");
        handler(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(resolve => server.close(() => resolve())),
        hits: () => hitCount,
    };
}

function payload(overrides: Partial<WebIntakePayload> = {}): WebIntakePayload {
    return {
        submissionId: `track-${Math.random().toString(36).slice(2)}`,
        name: "Tracking Test",
        email: `track-${Math.random().toString(36).slice(2)}@example.test`,
        phone: null,
        message: "We would like a full kitchen remodel, please reach out soon and give us a quote.",
        projectType: null,
        location: null,
        honeypot: "",
        renderedAtMs: 0,
        submittedAtMs: 5000,
        smsConsent: false,
        attribution: {},
        ...overrides,
    };
}

/** An "owned" lead (linked to a LeadIntakeEvent) via the real intake path, matching OWNED_LEAD_WHERE's own definition of ownership. */
async function makeOwnedLead(db: PrismaClient) {
    const outcome = await intakeWebhookLead(payload(), { receivedAt: new Date(), isTest: false }, db);
    if (!outcome.leadId) throw new Error("intake did not create a lead");
    return outcome.leadId;
}

async function cleanupLead(db: PrismaClient, leadId: string) {
    await db.leadAlert.deleteMany({ where: { leadId } }).catch(() => undefined);
    await db.speedToLeadEvent.deleteMany({ where: { leadId } }).catch(() => undefined);
    await db.leadIntakeEvent.deleteMany({ where: { leadId } }).catch(() => undefined);
    const lead = await db.lead.findUnique({ where: { id: leadId }, select: { clientId: true } }).catch(() => null);
    await db.lead.delete({ where: { id: leadId } }).catch(() => undefined);
    if (lead?.clientId) await db.client.delete({ where: { id: lead.clientId } }).catch(() => undefined);
}

async function cleanupDigestSettings(db: PrismaClient) {
    await db.automationSetting.deleteMany({ where: { key: { startsWith: "speedToLeadDigest" } } }).catch(() => undefined);
}

/** A test double that forwards every call to the real client except AutomationSetting.upsert, which always throws — simulates the push succeeding but the "sent" marker write then failing. */
function withFailingSentMarkerUpsert(real: PrismaClient): PrismaClient {
    return new Proxy(real, {
        get(target, prop, receiver) {
            if (prop === "automationSetting") {
                const delegate = Reflect.get(target, prop, receiver) as PrismaClient["automationSetting"];
                return new Proxy(delegate, {
                    get(delegateTarget, delegateProp, delegateReceiver) {
                        if (delegateProp === "upsert") {
                            return async () => { throw new Error("simulated sent-marker write failure"); };
                        }
                        return Reflect.get(delegateTarget, delegateProp, delegateReceiver);
                    },
                });
            }
            return Reflect.get(target, prop, receiver);
        },
    }) as PrismaClient;
}

test("markLeadBooked sets bookedAt exactly once and logs the actor; a second press is a no-op that logs nothing new", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const leadId = await makeOwnedLead(db);
    try {
        await markLeadBooked(leadId, "richard@goldentouchremodeling.com", db);
        const afterFirst = await db.lead.findUnique({ where: { id: leadId }, select: { bookedAt: true } });
        assert.ok(afterFirst?.bookedAt, "bookedAt must be set");
        const eventsAfterFirst = await db.speedToLeadEvent.findMany({ where: { leadId, kind: "lead-booked" } });
        assert.equal(eventsAfterFirst.length, 1);
        assert.equal(eventsAfterFirst[0].actor, "richard@goldentouchremodeling.com");

        const firstBookedAt = afterFirst!.bookedAt!.getTime();
        await markLeadBooked(leadId, "someone-else@example.com", db);
        const afterSecond = await db.lead.findUnique({ where: { id: leadId }, select: { bookedAt: true } });
        assert.equal(afterSecond?.bookedAt?.getTime(), firstBookedAt, "a second press must never move the timestamp");
        const eventsAfterSecond = await db.speedToLeadEvent.findMany({ where: { leadId, kind: "lead-booked" } });
        assert.equal(eventsAfterSecond.length, 1, "a second press must log nothing new");
    } finally {
        await cleanupLead(db, leadId);
        await db.$disconnect();
    }
});

test("markLeadCalled sets calledAt exactly once and logs the actor; a second press is a no-op", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const leadId = await makeOwnedLead(db);
    try {
        await markLeadCalled(leadId, "cj@goldentouchremodeling.com", db);
        const afterFirst = await db.lead.findUnique({ where: { id: leadId }, select: { calledAt: true } });
        assert.ok(afterFirst?.calledAt);
        await markLeadCalled(leadId, "someone-else@example.com", db);
        const events = await db.speedToLeadEvent.findMany({ where: { leadId, kind: "lead-called" } });
        assert.equal(events.length, 1, "a second press must log nothing new");
        assert.equal(events[0].actor, "cj@goldentouchremodeling.com", "actor is whoever pressed it FIRST");
    } finally {
        await cleanupLead(db, leadId);
        await db.$disconnect();
    }
});

test("send0900Digest returns true and sends nothing when there are no owned leads and no DEAD alerts", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const sink = await startSink((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "should-not-be-hit" })); });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    try {
        // The lookback window is `createdAt >= now - 14 days` with NO upper
        // bound, so a `now` in the past would actually sweep in every real
        // lead ever created (including leftovers this same CI job's earlier
        // steps never clean up) — the opposite of "no leads". A `now` far in
        // the FUTURE pushes the window past every lead any test could ever
        // create, which is what actually proves zero.
        const sent = await send0900Digest(db, new Date(Date.UTC(2099, 0, 1)));
        assert.equal(sent, true);
        assert.equal(sink.hits(), 0);
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("maybeSend0900Digest never sends in OFF, and never sends outside the configured local hour", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await cleanupDigestSettings(db);
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    try {
        process.env.SPEED_TO_LEAD_MODE = "OFF";
        assert.equal(await maybeSend0900Digest(NINE_AM_PACIFIC, db), false, "OFF must never send, even at 09:00 local");

        process.env.SPEED_TO_LEAD_MODE = "TEST";
        assert.equal(await maybeSend0900Digest(NOT_NINE_AM_PACIFIC, db), false, "must never send outside the configured local hour");
    } finally {
        process.env.SPEED_TO_LEAD_MODE = originalMode;
        await cleanupDigestSettings(db);
        await db.$disconnect();
    }
});

test("maybeSend0900Digest sends once per local day even with two concurrent cron ticks; a later same-day call is a no-op", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await cleanupDigestSettings(db);
    const sink = await startSink((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "digest-ok" })); });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    const leadId = await makeOwnedLead(db);
    try {
        const [a, b] = await Promise.all([
            maybeSend0900Digest(NINE_AM_PACIFIC, db),
            maybeSend0900Digest(NINE_AM_PACIFIC, db),
        ]);
        const winners = [a, b].filter(Boolean);
        assert.equal(winners.length, 1, "exactly one of the two concurrent ticks must win the claim and send");
        assert.equal(sink.hits(), 1, "the sink must be hit exactly once across both concurrent runs");

        const again = await maybeSend0900Digest(NINE_AM_PACIFIC, db);
        assert.equal(again, false, "a later call the same local day is a no-op");
        assert.equal(sink.hits(), 1, "no second push for the same day");
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        process.env.SPEED_TO_LEAD_MODE = originalMode;
        await cleanupLead(db, leadId);
        await cleanupDigestSettings(db);
        await sink.close();
        await db.$disconnect();
    }
});

test("a failed digest push releases the claim (never marked sent) so a retry within the same local hour can succeed", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await cleanupDigestSettings(db);
    let requestCount = 0;
    const sink = await startSink((_req, res) => {
        requestCount++;
        if (requestCount === 1) { res.writeHead(500); res.end("boom"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "digest-retry-ok" }));
    });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    const leadId = await makeOwnedLead(db);
    try {
        const first = await maybeSend0900Digest(NINE_AM_PACIFIC, db);
        assert.equal(first, false, "a failed push must not report success");
        const sentMarkerAfterFailure = await db.automationSetting.findUnique({ where: { key: "speedToLeadDigestLastSentDate" } });
        assert.equal(sentMarkerAfterFailure, null, "the write-before-send bug: the 'sent' marker must never be written on a failed push");

        const retry = await maybeSend0900Digest(NINE_AM_PACIFIC, db);
        assert.equal(retry, true, "the released claim must let a retry within the same hour succeed");
        assert.equal(requestCount, 2);
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        process.env.SPEED_TO_LEAD_MODE = originalMode;
        await cleanupLead(db, leadId);
        await cleanupDigestSettings(db);
        await sink.close();
        await db.$disconnect();
    }
});

test("a stale digest claim (a crash, or a failed release, between claim and release) is reclaimed rather than blocking every tick for the rest of the local day", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await cleanupDigestSettings(db);
    const sink = await startSink((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "digest-reclaimed" })); });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    const leadId = await makeOwnedLead(db);
    try {
        // NINE_AM_PACIFIC is 2026-01-15 in America/Los_Angeles. Staleness is
        // relative to the `now` maybeSend0900Digest is called with, not real
        // wall-clock time — this test calls it with the fixed NINE_AM_PACIFIC.
        const claimKey = "speedToLeadDigestClaim:2026-01-15";
        await db.automationSetting.create({ data: { key: claimKey, value: "claimed" } });
        const staleSince = new Date(NINE_AM_PACIFIC.getTime() - 10 * 60 * 1000);
        await db.$executeRaw`UPDATE "AutomationSetting" SET "updatedAt" = ${staleSince} WHERE key = ${claimKey}`;

        const result = await maybeSend0900Digest(NINE_AM_PACIFIC, db);
        assert.equal(result, true, "a stale claim must be reclaimed rather than leaving the digest permanently blocked for the day");
        assert.equal(sink.hits(), 1);
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        process.env.SPEED_TO_LEAD_MODE = originalMode;
        await cleanupLead(db, leadId);
        await cleanupDigestSettings(db);
        await sink.close();
        await db.$disconnect();
    }
});

test("a FRESH digest claim (a run genuinely still in flight) is never reclaimed out from under it", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await cleanupDigestSettings(db);
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    try {
        const claimKey = "speedToLeadDigestClaim:2026-01-15";
        await db.automationSetting.create({ data: { key: claimKey, value: "claimed" } });

        const result = await maybeSend0900Digest(NINE_AM_PACIFIC, db);
        assert.equal(result, false, "a claim from moments ago must not be reclaimed — it may still be a genuinely in-flight run");
    } finally {
        process.env.SPEED_TO_LEAD_MODE = originalMode;
        await cleanupDigestSettings(db);
        await db.$disconnect();
    }
});

test("a push that succeeds but whose 'sent' marker write then fails never causes a duplicate send — the claim stays put, not released, until the next local day", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await cleanupDigestSettings(db);
    const sink = await startSink((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "digest-marker-fail" })); });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    const leadId = await makeOwnedLead(db);
    try {
        const failingDb = withFailingSentMarkerUpsert(db);
        const first = await maybeSend0900Digest(NINE_AM_PACIFIC, failingDb);
        assert.equal(first, false, "the marker write failed, so this call must not report success");
        assert.equal(sink.hits(), 1, "the push itself must have gone out exactly once");

        const sentMarker = await db.automationSetting.findUnique({ where: { key: "speedToLeadDigestLastSentDate" } });
        assert.equal(sentMarker, null, "the marker genuinely never got written");

        // A retry the SAME hour, on the real (non-failing) client, must never
        // re-send — the claim from the first call's successful push must
        // still be in place, exactly because it succeeded.
        const retry = await maybeSend0900Digest(NINE_AM_PACIFIC, db);
        assert.equal(retry, false, "the claim must never be released after a successful send, even though its marker write failed");
        assert.equal(sink.hits(), 1, "no second push, ever, for a day whose digest already went out");
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        process.env.SPEED_TO_LEAD_MODE = originalMode;
        await cleanupLead(db, leadId);
        await cleanupDigestSettings(db);
        await sink.close();
        await db.$disconnect();
    }
});

test("promoteLeadToReal flips the verdict to REAL but creates no new alert — a later manual promotion is not a new arrival", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const leadId = await makeOwnedLead(db);
    try {
        const before = await db.leadAlert.findMany({ where: { leadId } });
        assert.ok(before.length >= 1, "intake must have created at least one alert row to make this check meaningful");

        await promoteLeadToReal(leadId, db);

        const events = await db.leadIntakeEvent.findMany({ where: { leadId } });
        assert.ok(events.every(e => e.verdict === "REAL"), "every intake row for the lead must now read REAL");

        const after = await db.leadAlert.findMany({ where: { leadId } });
        assert.deepEqual(
            after.map(a => ({ channel: a.channel, id: a.id })).sort((x, y) => x.id.localeCompare(y.id)),
            before.map(a => ({ channel: a.channel, id: a.id })).sort((x, y) => x.id.localeCompare(y.id)),
            "promotion must create no new LeadAlert row and touch none of the existing ones",
        );
    } finally {
        await cleanupLead(db, leadId);
        await db.$disconnect();
    }
});
