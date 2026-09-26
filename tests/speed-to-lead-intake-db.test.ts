/**
 * Real-Postgres races for Speed-to-Lead intake (spec Test Plan: "fallback-first,
 * webhook-first and concurrent intake of one submissionId (one lead)";
 * "fallback persisted before the cursor advances").
 *
 * Requires SPEED_TO_LEAD_TEST_URL pointing at a DISPOSABLE local Postgres that
 * already has the Speed-to-Lead migration applied (see
 * scripts/apply-speed-to-lead.mjs --target ci). Skips locally when unset —
 * same convention as tests/bank-image-1027-repair-db.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { intakeWebhookLead, recordPendingFallback, promoteDueFallbacks } from "../src/lib/speed-to-lead/intake";
import type { WebIntakePayload } from "../src/lib/speed-to-lead/payload";

const url = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !url && "requires explicitly supplied disposable PostgreSQL";

function payload(submissionId: string, overrides: Partial<WebIntakePayload> = {}): WebIntakePayload {
    return {
        submissionId,
        name: "Race Test",
        email: `race-${submissionId}@example.com`,
        phone: null,
        message: "Testing the intake exactly-once race with enough letters.",
        projectType: null,
        location: null,
        honeypot: "",
        renderedAtMs: 0,
        submittedAtMs: 10_000,
        smsConsent: false,
        attribution: {},
        ...overrides,
    };
}

test("fallback-first: a fallback PENDING_FALLBACK row promotes to exactly one lead when no webhook ever arrives", { skip }, async () => {
    assert.ok(url);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "test refuses non-local databases");
    const db = new PrismaClient({ datasources: { db: { url } } });
    const submissionId = `fallback-first-${Date.now()}`;
    try {
        await db.$transaction(async tx => {
            await recordPendingFallback(tx, {
                submissionId, gmailMessageId: `msg-${submissionId}`, receivedAt: new Date(Date.now() - 11 * 60 * 1000),
                rawPayload: payload(submissionId),
            });
        });
        const row = await db.leadIntakeEvent.findUnique({ where: { submissionId } });
        assert.equal(row?.state, "PENDING_FALLBACK");
        assert.equal(row?.leadId, null);

        const outcomes = await promoteDueFallbacks(new Date(), db);
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].verdict, "REVIEW");

        const promoted = await db.leadIntakeEvent.findUnique({ where: { submissionId } });
        assert.equal(promoted?.state, "PROCESSED");
        assert.ok(promoted?.leadId);

        // A second promotion pass finds nothing left to do — exactly one lead.
        const second = await promoteDueFallbacks(new Date(), db);
        assert.equal(second.length, 0);
    } finally {
        await db.leadIntakeEvent.deleteMany({ where: { submissionId } });
        await db.$disconnect();
    }
});

test("webhook-first: the webhook creates the lead directly; a later fallback for the same submission links to it instead of creating a second", { skip }, async () => {
    assert.ok(url);
    const db = new PrismaClient({ datasources: { db: { url } } });
    const submissionId = `webhook-first-${Date.now()}`;
    try {
        const webhookOutcome = await intakeWebhookLead(payload(submissionId), { receivedAt: new Date() }, db);
        assert.equal(webhookOutcome.won, true);
        assert.ok(webhookOutcome.leadId);

        // The fallback poller later sees the (already-handled) forwarded email —
        // recordPendingFallback must find the row already PROCESSED and do nothing.
        await db.$transaction(async tx => {
            await recordPendingFallback(tx, {
                submissionId, gmailMessageId: `msg-${submissionId}`, receivedAt: new Date(),
                rawPayload: payload(submissionId),
            });
        });
        const row = await db.leadIntakeEvent.findUnique({ where: { submissionId } });
        assert.equal(row?.state, "PROCESSED");
        assert.equal(row?.leadId, webhookOutcome.leadId);

        const leadCount = await db.lead.count({ where: { id: webhookOutcome.leadId! } });
        assert.equal(leadCount, 1);
    } finally {
        const row = await db.leadIntakeEvent.findUnique({ where: { submissionId } });
        if (row?.leadId) {
            await db.lead.deleteMany({ where: { id: row.leadId } });
        }
        await db.leadIntakeEvent.deleteMany({ where: { submissionId } });
        await db.$disconnect();
    }
});

test("a webhook that arrives after a fallback PENDING_FALLBACK row takes it over with its own (REAL) triage, not the forced-REVIEW fallback verdict", { skip }, async () => {
    assert.ok(url);
    const db = new PrismaClient({ datasources: { db: { url } } });
    const submissionId = `take-over-${Date.now()}`;
    try {
        await db.$transaction(async tx => {
            await recordPendingFallback(tx, {
                submissionId, gmailMessageId: `msg-${submissionId}`, receivedAt: new Date(),
                rawPayload: payload(submissionId),
            });
        });
        const pending = await db.leadIntakeEvent.findUnique({ where: { submissionId } });
        assert.equal(pending?.state, "PENDING_FALLBACK");

        const webhookOutcome = await intakeWebhookLead(payload(submissionId), { receivedAt: new Date() }, db);
        assert.equal(webhookOutcome.won, true);
        // A clean payload with no history should triage REAL from the webhook
        // path — the fallback path would have forced REVIEW instead.
        assert.equal(webhookOutcome.verdict, "REAL");

        const taken = await db.leadIntakeEvent.findUnique({ where: { submissionId } });
        assert.equal(taken?.state, "PROCESSED");
        assert.equal(taken?.source, "WEB");

        // A subsequent promotion pass must find nothing left to promote.
        const promoted = await promoteDueFallbacks(new Date(Date.now() + 60 * 60 * 1000), db);
        assert.equal(promoted.filter(o => o.leadId === webhookOutcome.leadId).length, 0);
    } finally {
        const row = await db.leadIntakeEvent.findUnique({ where: { submissionId } });
        if (row?.leadId) await db.lead.deleteMany({ where: { id: row.leadId } });
        await db.leadIntakeEvent.deleteMany({ where: { submissionId } });
        await db.$disconnect();
    }
});

test("concurrent intake: two simultaneous webhook deliveries for the same submissionId collapse to exactly one lead", { skip }, async () => {
    assert.ok(url);
    const db = new PrismaClient({ datasources: { db: { url } } });
    const submissionId = `concurrent-${Date.now()}`;
    try {
        const [a, b] = await Promise.all([
            intakeWebhookLead(payload(submissionId), { receivedAt: new Date() }, db),
            intakeWebhookLead(payload(submissionId), { receivedAt: new Date() }, db),
        ]);
        assert.equal(a.leadId, b.leadId);
        assert.ok(a.leadId);
        // Exactly one of the two actually created the lead.
        assert.equal([a.won, b.won].filter(Boolean).length, 1);

        const leadCount = await db.lead.count({ where: { id: a.leadId! } });
        assert.equal(leadCount, 1);
        const eventCount = await db.leadIntakeEvent.count({ where: { submissionId } });
        assert.equal(eventCount, 1);
    } finally {
        const row = await db.leadIntakeEvent.findUnique({ where: { submissionId } });
        if (row?.leadId) await db.lead.deleteMany({ where: { id: row.leadId } });
        await db.leadIntakeEvent.deleteMany({ where: { submissionId } });
        await db.$disconnect();
    }
});
