/**
 * Alert claim/deliver, against a REAL PostgreSQL, with a local HTTP sink
 * standing in for ntfy and Google Chat — no real message is ever sent by
 * this test. Opt-in by URL, same convention as
 * tests/speed-to-lead-intake-db.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { deliverDueAlerts, createLeadAlertsInTx } from "../src/lib/speed-to-lead/alerts";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

/** A tiny local HTTP sink standing in for both ntfy and Chat, so a test never touches a real third-party service. */
async function startSink(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(resolve => server.close(() => resolve())),
    };
}

async function makeLead(db: PrismaClient, opts: { email?: string } = {}) {
    const client = await db.client.create({ data: { name: "Alert DB Test", initials: "AD", email: opts.email ?? `alert-${randomUUID()}@example.test` } });
    return db.lead.create({ data: { clientId: client.id, name: "Alert DB Test Lead", message: "Please call us back about our remodel." } });
}

test("delivered ntfy 2xx-with-id marks the row DELIVERED, sets providerRef, and is never re-claimed by a second concurrent run", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    let hits = 0;
    const sink = await startSink((_req, res) => {
        hits++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ntfy-msg-1" }));
    });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    try {
        const lead = await makeLead(db);
        await db.$transaction(tx => createLeadAlertsInTx(tx, { leadId: lead.id, verdict: "REAL", reasons: [], isTest: false }));

        // Two concurrent delivery passes — only one may claim and send the row.
        await Promise.all([deliverDueAlerts(db), deliverDueAlerts(db)]);

        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY" } } });
        assert.equal(row?.status, "DELIVERED");
        assert.equal(row?.providerRef, "ntfy-msg-1");
        assert.equal(hits, 1, "the sink must be hit exactly once across both concurrent runs");
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("an ntfy 400 goes DEAD immediately, with no retry", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const sink = await startSink((_req, res) => { res.writeHead(400); res.end("bad request"); });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    try {
        const lead = await makeLead(db);
        await db.$transaction(tx => createLeadAlertsInTx(tx, { leadId: lead.id, verdict: "REAL", reasons: [], isTest: false }));
        await deliverDueAlerts(db);
        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY" } } });
        assert.equal(row?.status, "DEAD");
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("an ntfy timeout/5xx retries with backoff (stays PENDING, nextAttemptAt in the future)", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const sink = await startSink((_req, res) => { res.writeHead(500); res.end("oops"); });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    try {
        const lead = await makeLead(db);
        await db.$transaction(tx => createLeadAlertsInTx(tx, { leadId: lead.id, verdict: "REAL", reasons: [], isTest: false }));
        const before = new Date();
        await deliverDueAlerts(db, before);
        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY" } } });
        assert.equal(row?.status, "PENDING");
        assert.equal(row?.attempts, 1);
        assert.ok(row!.nextAttemptAt.getTime() > before.getTime());
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("a stale SENDING row (worker died) is reclaimed and delivered on the next run", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const sink = await startSink((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "ntfy-reclaim" })); });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    try {
        const lead = await makeLead(db);
        await db.$transaction(tx => createLeadAlertsInTx(tx, { leadId: lead.id, verdict: "REAL", reasons: [], isTest: false }));
        // Simulate a worker that claimed the row 3 minutes ago and then died.
        await db.leadAlert.update({
            where: { leadId_channel: { leadId: lead.id, channel: "NTFY" } },
            data: { status: "SENDING", claimedAt: new Date(Date.now() - 3 * 60 * 1000) },
        });
        await deliverDueAlerts(db);
        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY" } } });
        assert.equal(row?.status, "DELIVERED");
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("a lead older than 6h with an alert never attempted goes SKIPPED, never DEAD, and never even reaches the sink", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    let hits = 0;
    const sink = await startSink((_req, res) => { hits++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "should-not-happen" })); });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    try {
        const client = await db.client.create({ data: { name: "Stale Lead", initials: "SL", email: `stale-${randomUUID()}@example.test` } });
        const lead = await db.lead.create({ data: { clientId: client.id, name: "Stale Lead", message: "old", createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000) } });
        await db.leadAlert.create({ data: { leadId: lead.id, channel: "NTFY", status: "PENDING", isTest: false } });
        await deliverDueAlerts(db);
        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY" } } });
        assert.equal(row?.status, "SKIPPED");
        assert.equal(row?.attempts, 0);
        assert.equal(hits, 0, "a never-attempted stale alert must never be sent");
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("an alert that already had attempts, now stale, goes DEAD (not SKIPPED)", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    try {
        const client = await db.client.create({ data: { name: "Stale Retried Lead", initials: "SR", email: `stale-retried-${randomUUID()}@example.test` } });
        const lead = await db.lead.create({ data: { clientId: client.id, name: "Stale Retried Lead", message: "old", createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000) } });
        await db.leadAlert.create({ data: { leadId: lead.id, channel: "NTFY", status: "PENDING", isTest: false, attempts: 3 } });
        await deliverDueAlerts(db);
        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "NTFY" } } });
        assert.equal(row?.status, "DEAD");
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        await db.$disconnect();
    }
});

test("ntfy content never carries email, full phone or message text — Click header carries the lead link", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const captured: { headers: http.IncomingHttpHeaders | null } = { headers: null };
    let capturedBody = "";
    const sink = await startSink((req, res) => {
        captured.headers = req.headers;
        req.on("data", chunk => { capturedBody += chunk; });
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "ntfy-content" }));
        });
    });
    const originalTopic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    const originalBase = process.env.SPEED_TO_LEAD_NTFY_BASE_URL;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = sink.url;
    try {
        const email = "secret-address@example.test";
        const client = await db.client.create({ data: { name: "Content Test", initials: "CT", email, primaryPhone: "3605551234" } });
        const lead = await db.lead.create({ data: { clientId: client.id, name: "Content Test Lead", message: "very secret message body that must never leak into a push" } });
        await db.$transaction(tx => createLeadAlertsInTx(tx, { leadId: lead.id, verdict: "REAL", reasons: [], isTest: false }));
        await deliverDueAlerts(db);

        assert.ok(!capturedBody.includes(email));
        assert.ok(!capturedBody.includes("3605551234"));
        assert.ok(!capturedBody.includes("very secret message body"));
        assert.ok(capturedBody.includes("1234"), "the last 4 digits of the phone ARE allowed");
        assert.ok(String(captured.headers?.click ?? "").includes(`/leads/${lead.id}`));
    } finally {
        process.env.SPEED_TO_LEAD_NTFY_TOPIC = originalTopic;
        process.env.SPEED_TO_LEAD_NTFY_BASE_URL = originalBase;
        await sink.close();
        await db.$disconnect();
    }
});

test("a Chat webhook URL outside the chat.googleapis.com allowlist never posts — the CHAT row goes DEAD, not PENDING forever", { skip }, async () => {
    // isValidChatWebhookUrl (src/lib/chat-webhook.ts, reused by alerts.ts)
    // only accepts https://chat.googleapis.com/v1/spaces/... — a local test
    // sink can never satisfy that by construction, which is the SSRF
    // allowlist working as intended. This asserts the CONSEQUENCE: an
    // unreachable/invalid Chat config resolves to DEAD (config error, no
    // retry), never an infinite PENDING loop, and never an attempt to reach
    // whatever URL is actually configured.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const originalUrl = process.env.SPEED_TO_LEAD_CHAT_WEBHOOK_URL;
    process.env.SPEED_TO_LEAD_CHAT_WEBHOOK_URL = "https://not-a-real-chat-host.example.com/v1/spaces/test/messages";
    try {
        const lead = await makeLead(db);
        await db.leadAlert.create({ data: { leadId: lead.id, channel: "CHAT", status: "PENDING", isTest: false } });
        await deliverDueAlerts(db);
        const row = await db.leadAlert.findUnique({ where: { leadId_channel: { leadId: lead.id, channel: "CHAT" } } });
        assert.equal(row?.status, "DEAD");
    } finally {
        process.env.SPEED_TO_LEAD_CHAT_WEBHOOK_URL = originalUrl;
        await db.$disconnect();
    }
});
