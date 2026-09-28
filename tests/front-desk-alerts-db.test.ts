/**
 * Front Desk v1 acceptance tests 14 (front-desk card/ntfy content) and 37
 * (NTFY_URGENT delivery), against a REAL PostgreSQL (SPEED_TO_LEAD_TEST_URL).
 * A local HTTP sink stands in for ntfy — no real message is ever sent by
 * this test. Mirrors tests/speed-to-lead-alerts-db.test.ts's sink pattern.
 * Zero prior test referenced NTFY_URGENT at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { deliverDueAlerts } from "../src/lib/speed-to-lead/alerts";
import { setSpeedToLeadPaused } from "../src/lib/speed-to-lead/settings";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

/** Same shape as speed-to-lead-alerts-db.test.ts's sink — drains every request before responding. */
async function startSink(): Promise<{
    url: string;
    close: () => Promise<void>;
    lastHeaders: () => Record<string, string | string[] | undefined>;
    lastBody: () => string;
    hits: () => number;
}> {
    let hitCount = 0;
    let headers: Record<string, string | string[] | undefined> = {};
    let body = "";
    const server = http.createServer((req, res) => {
        hitCount++;
        headers = req.headers;
        const chunks: Buffer[] = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => {
            body = Buffer.concat(chunks).toString("utf8");
            res.setHeader("Connection", "close");
            res.end(JSON.stringify({ id: `sink-${randomUUID()}` }));
        });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(resolve => server.close(() => resolve())),
        lastHeaders: () => headers,
        lastBody: () => body,
        hits: () => hitCount,
    };
}

async function makeFrontDeskLead(db: PrismaClient, opts: { reasons: string[]; isTest: boolean; phone?: string }) {
    const client = await db.client.create({ data: { name: "Front Desk Caller", initials: "FD", primaryPhone: opts.phone ?? "+13605551234" } });
    const lead = await db.lead.create({ data: { clientId: client.id, name: "Front Desk Caller - Kitchen", message: "Missed transfer, details from the call", location: "Vancouver", projectType: "Kitchen" } });
    await db.leadIntakeEvent.create({
        data: {
            id: randomUUID(), externalId: `fd:test-${randomUUID()}`, source: "FRONT_DESK_CALL", state: "PROCESSED",
            leadId: lead.id, verdict: "REVIEW", reasons: opts.reasons, payload: {}, isTest: opts.isTest, receivedAt: new Date(),
        },
    });
    return { client, lead };
}

async function cleanup(db: PrismaClient, leadId: string, clientId: string): Promise<void> {
    await db.leadAlert.deleteMany({ where: { leadId } }).catch(() => undefined);
    await db.leadIntakeEvent.deleteMany({ where: { leadId } }).catch(() => undefined);
    await db.lead.delete({ where: { id: leadId } }).catch(() => undefined);
    await db.client.delete({ where: { id: clientId } }).catch(() => undefined);
}

// ── Test 37: NTFY_URGENT delivery specifics ────────────────────────────────

test("NTFY_URGENT: priority 5, ASCII [TEST]-prefixed title, phone masked to last 4 digits — the full number never appears", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const originalTopic = process.env.FRONT_DESK_URGENT_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    const sink = await startSink();
    process.env.FRONT_DESK_URGENT_NTFY_TOPIC = "test-urgent-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    let leadId = "", clientId = "";
    try {
        const { client, lead } = await makeFrontDeskLead(db, { reasons: ["front-desk-missed-transfer"], isTest: true, phone: "+13605559876" });
        leadId = lead.id; clientId = client.id;
        await db.leadAlert.create({ data: { id: randomUUID(), leadId: lead.id, channel: "NTFY_URGENT", status: "PENDING", isTest: true } });
        await deliverDueAlerts(db);

        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY_URGENT" } } });
        assert.equal(row?.status, "DELIVERED");
        assert.equal(sink.hits(), 1);

        const headers = sink.lastHeaders();
        assert.equal(headers.priority, "5");
        assert.equal(headers.title, "[TEST] Missed transfer - call back now");
        assert.match(String(headers.title), /^[\x20-\x7e]+$/, "the Title header value must be ASCII-safe");

        const body = sink.lastBody();
        assert.match(body, /9876/, "the last 4 digits must appear");
        assert.doesNotMatch(body, /13605559876|3605559876|605559876/, "the full phone number must never appear on ntfy");
    } finally {
        if (leadId) await cleanup(db, leadId, clientId);
        process.env.FRONT_DESK_URGENT_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("NTFY_URGENT: LIVE mode carries no [TEST] prefix", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const originalTopic = process.env.FRONT_DESK_URGENT_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    const sink = await startSink();
    process.env.FRONT_DESK_URGENT_NTFY_TOPIC = "test-urgent-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    let leadId = "", clientId = "";
    try {
        const { client, lead } = await makeFrontDeskLead(db, { reasons: ["front-desk-missed-transfer"], isTest: false });
        leadId = lead.id; clientId = client.id;
        await db.leadAlert.create({ data: { id: randomUUID(), leadId: lead.id, channel: "NTFY_URGENT", status: "PENDING", isTest: false } });
        await deliverDueAlerts(db);
        assert.equal(sink.lastHeaders().title, "Missed transfer - call back now");
    } finally {
        if (leadId) await cleanup(db, leadId, clientId);
        process.env.FRONT_DESK_URGENT_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("NTFY_URGENT: a missing FRONT_DESK_URGENT_NTFY_TOPIC -> DEAD, reason 'no urgent ntfy topic configured', no network call", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const original = process.env.FRONT_DESK_URGENT_NTFY_TOPIC;
    delete process.env.FRONT_DESK_URGENT_NTFY_TOPIC;
    let leadId = "", clientId = "";
    try {
        const { client, lead } = await makeFrontDeskLead(db, { reasons: ["front-desk-missed-transfer"], isTest: true });
        leadId = lead.id; clientId = client.id;
        await db.leadAlert.create({ data: { id: randomUUID(), leadId: lead.id, channel: "NTFY_URGENT", status: "PENDING", isTest: true } });
        await deliverDueAlerts(db);
        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY_URGENT" } } });
        assert.equal(row?.status, "DEAD");
        assert.equal(row?.lastErrorCategory, "no urgent ntfy topic configured");
    } finally {
        if (leadId) await cleanup(db, leadId, clientId);
        if (original === undefined) delete process.env.FRONT_DESK_URGENT_NTFY_TOPIC;
        else process.env.FRONT_DESK_URGENT_NTFY_TOPIC = original;
        await db.$disconnect();
    }
});

test("NTFY_URGENT: while speed-to-lead is paused, a due alert becomes SKIPPED and is never sent", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const originalTopic = process.env.FRONT_DESK_URGENT_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    const sink = await startSink();
    process.env.FRONT_DESK_URGENT_NTFY_TOPIC = "test-urgent-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    let leadId = "", clientId = "";
    try {
        await setSpeedToLeadPaused(true, db);
        const { client, lead } = await makeFrontDeskLead(db, { reasons: ["front-desk-missed-transfer"], isTest: true });
        leadId = lead.id; clientId = client.id;
        await db.leadAlert.create({ data: { id: randomUUID(), leadId: lead.id, channel: "NTFY_URGENT", status: "PENDING", isTest: true } });
        await deliverDueAlerts(db);
        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY_URGENT" } } });
        assert.equal(row?.status, "SKIPPED");
        assert.equal(row?.lastErrorCategory, "paused");
        assert.equal(sink.hits(), 0, "a paused urgent alert must never reach the network — even a missed-transfer page respects the pause");
    } finally {
        await setSpeedToLeadPaused(false, db);
        if (leadId) await cleanup(db, leadId, clientId);
        process.env.FRONT_DESK_URGENT_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

// ── Test 14: front-desk card/ntfy content ───────────────────────────────

test("the ntfy title uses the §1 front-desk reason mapping, and 'Booking uncertain, don't rebook' appears in the body when flagged", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    const sink = await startSink();
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    let leadId = "", clientId = "";
    try {
        const { client, lead } = await makeFrontDeskLead(db, { reasons: ["front-desk-transferred", "front-desk-booking-uncertain"], isTest: true });
        leadId = lead.id; clientId = client.id;
        await db.leadAlert.create({ data: { id: randomUUID(), leadId: lead.id, channel: "NTFY", status: "PENDING", isTest: true } });
        await deliverDueAlerts(db);

        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY" } } });
        assert.equal(row?.status, "DELIVERED");
        assert.equal(sink.lastHeaders().title, "[TEST] Front desk: transferred");
        assert.match(sink.lastBody(), /Booking uncertain, don't rebook/);
    } finally {
        if (leadId) await cleanup(db, leadId, clientId);
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("ntfy phone privacy: the body carries only the last 4 digits, never the full number, for a non-urgent front-desk alert too", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    const sink = await startSink();
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    let leadId = "", clientId = "";
    try {
        const { client, lead } = await makeFrontDeskLead(db, { reasons: ["front-desk-message"], isTest: true, phone: "+13605554321" });
        leadId = lead.id; clientId = client.id;
        await db.leadAlert.create({ data: { id: randomUUID(), leadId: lead.id, channel: "NTFY", status: "PENDING", isTest: true } });
        await deliverDueAlerts(db);
        const body = sink.lastBody();
        assert.match(body, /4321/);
        assert.doesNotMatch(body, /13605554321|3605554321|605554321/);
    } finally {
        if (leadId) await cleanup(db, leadId, clientId);
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});
