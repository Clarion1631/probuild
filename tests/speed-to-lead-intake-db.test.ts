/**
 * Speed-to-Lead v1a intake, against a REAL PostgreSQL. A fake `$transaction`
 * (a plain callback call) cannot prove exactly-once under a real race — the
 * whole point of the `INSERT ... ON CONFLICT DO NOTHING` / advisory-lock
 * design is that Postgres itself serializes the losers, which no mock can
 * fake honestly.
 *
 * Opt-in by URL, like tests/qbo-client-lock-db.test.ts: a normal unit run
 * must never be able to write to a developer database. CI's `migrations`
 * job supplies the URL from its Postgres service container, with this
 * feature's migration already applied via `migrate deploy`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { intakeWebhookLead, recordPendingFallback } from "../src/lib/speed-to-lead/intake";
import { parseFallbackEmail } from "../src/lib/speed-to-lead/fallback-email";
import type { WebIntakePayload } from "../src/lib/speed-to-lead/payload";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

function payload(overrides: Partial<WebIntakePayload> = {}): WebIntakePayload {
    return {
        submissionId: `sub-${Math.random().toString(36).slice(2)}`,
        name: "Race Test",
        email: `race-${Math.random().toString(36).slice(2)}@example.test`,
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

async function countRows(db: PrismaClient, externalId: string) {
    const rows = await db.leadIntakeEvent.findMany({ where: { externalId } });
    const leadIds = new Set(rows.map(r => r.leadId).filter(Boolean));
    return { rowCount: rows.length, leadIds };
}

/**
 * Every test's own rows, removed unconditionally. Without this, leftover
 * LeadAlert PENDING rows from this file leak into
 * tests/speed-to-lead-alerts-db.test.ts's `deliverDueAlerts` calls in the
 * SAME CI step (it scans the whole table with no per-test scope), inflating
 * that file's sink-hit-count assertions on a shared Postgres — the actual
 * root cause of the CI `migrations` job going red, not just a flake to step
 * around (mirrors the `cleanup` helper in speed-to-lead-alerts-db.test.ts).
 */
async function cleanup(db: PrismaClient, opts: { externalIds: string[]; leadId?: string | null }): Promise<void> {
    await db.leadIntakeEvent.deleteMany({ where: { externalId: { in: opts.externalIds } } }).catch(() => undefined);
    if (opts.leadId) {
        await db.leadAlert.deleteMany({ where: { leadId: opts.leadId } }).catch(() => undefined);
        await db.lead.delete({ where: { id: opts.leadId } }).catch(() => undefined);
    }
}

test("a single webhook submission creates exactly one Lead, one intake row, and its ntfy alert row", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const p = payload();
    let leadId: string | null = null;
    try {
        const outcome = await intakeWebhookLead(p, { receivedAt: new Date(), isTest: false }, db);
        leadId = outcome.leadId;
        assert.equal(outcome.won, true);
        assert.ok(outcome.leadId);

        const { rowCount, leadIds } = await countRows(db, `sub:${p.submissionId}`);
        assert.equal(rowCount, 1);
        assert.equal(leadIds.size, 1);

        const alerts = await db.leadAlert.findMany({ where: { leadId: outcome.leadId! } });
        assert.ok(alerts.length >= 1);
        assert.equal(alerts.filter(a => a.channel === "NTFY").length, 1);
        assert.equal(new Set(alerts.map(a => a.channel)).size, alerts.length); // never two of the same channel
    } finally {
        await cleanup(db, { externalIds: [`sub:${p.submissionId}`], leadId });
        await db.$disconnect();
    }
});

test("5 concurrent webhook deliveries for the SAME submissionId produce exactly one Lead and at most one alert per channel", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const p = payload();
    let leadId: string | null = null;
    try {
        const results = await Promise.all(
            Array.from({ length: 5 }, () => intakeWebhookLead(p, { receivedAt: new Date(), isTest: false }, db)),
        );
        const winners = results.filter(r => r.won);
        assert.equal(winners.length, 1, "exactly one delivery should win the race");
        const leadIds = new Set(results.map(r => r.leadId).filter(Boolean));
        assert.equal(leadIds.size, 1, "every delivery must resolve to the SAME lead");
        leadId = [...leadIds][0] as string;

        const { rowCount } = await countRows(db, `sub:${p.submissionId}`);
        assert.equal(rowCount, 1);

        const alerts = await db.leadAlert.findMany({ where: { leadId } });
        const byChannel = new Map<string, number>();
        for (const a of alerts) byChannel.set(a.channel, (byChannel.get(a.channel) ?? 0) + 1);
        for (const [, count] of byChannel) assert.equal(count, 1);
    } finally {
        await cleanup(db, { externalIds: [`sub:${p.submissionId}`], leadId });
        await db.$disconnect();
    }
});

test("fallback-first: the fallback poller's PENDING_FALLBACK row is taken over by the real webhook, using the webhook's own triage", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const p = payload();
    let leadId: string | null = null;
    try {
        const fallback = parseFallbackEmail({ headers: [{ name: "Reply-To", value: p.email }], bodyText: `Name: ${p.name}\nEmail: ${p.email}\nMessage:\n${p.message}`, submissionId: p.submissionId });
        await db.$transaction(tx => recordPendingFallback(tx, { gmailMessageId: `gm-${p.submissionId}`, receivedAt: new Date(), payload: fallback }));

        const before = await db.leadIntakeEvent.findUnique({ where: { externalId: `sub:${p.submissionId}` } });
        assert.equal(before?.state, "PENDING_FALLBACK");
        assert.equal(before?.source, "WEB_EMAIL_FALLBACK");

        const outcome = await intakeWebhookLead(p, { receivedAt: new Date(), isTest: false }, db);
        leadId = outcome.leadId;
        assert.equal(outcome.won, true);

        const after = await db.leadIntakeEvent.findUnique({ where: { externalId: `sub:${p.submissionId}` } });
        assert.equal(after?.state, "PROCESSED");
        assert.equal(after?.source, "WEB");
        assert.equal(after?.leadId, outcome.leadId);

        const { rowCount } = await countRows(db, `sub:${p.submissionId}`);
        assert.equal(rowCount, 1, "the takeover must never create a second row");
    } finally {
        await cleanup(db, { externalIds: [`sub:${p.submissionId}`], leadId });
        await db.$disconnect();
    }
});

test("cross-channel dedupe: a fallback with no submissionId and a webhook for the same email within 15 minutes collapse to ONE lead", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const email = `cross-${Math.random().toString(36).slice(2)}@example.test`;
    const messageId = `gm-cross-${Math.random().toString(36).slice(2)}`;
    const webhookPayload = payload({ email });
    let leadId: string | null = null;
    try {
        const fallback = parseFallbackEmail({ headers: [{ name: "Reply-To", value: email }], bodyText: `Name: Cross Channel\nEmail: ${email}\nMessage:\nWe need a full remodel of our whole house please.`, submissionId: null });
        const fallbackOutcome = await db.$transaction(async tx => {
            await recordPendingFallback(tx, { gmailMessageId: messageId, receivedAt: new Date(), payload: fallback });
            // A fallback with no submissionId is due immediately — promote it inline for the test rather than waiting on the cron.
            const row = await tx.leadIntakeEvent.findUniqueOrThrow({ where: { externalId: `voice:${messageId}` } });
            return row;
        });
        assert.equal(fallbackOutcome.state, "PENDING_FALLBACK");
        assert.ok(fallbackOutcome.dueAt && fallbackOutcome.dueAt.getTime() <= Date.now() + 1000, "no-submissionId fallback must be due immediately");

        // Promote the fallback (simulating the cron's promoteDueFallbacks) via the same module used in production.
        const { promoteDueFallbacks } = await import("../src/lib/speed-to-lead/intake");
        const promoted = await promoteDueFallbacks(new Date(Date.now() + 1000), db);
        const fallbackLead = promoted.find(o => o.won)?.leadId;
        assert.ok(fallbackLead, "the fallback should have promoted to a lead");
        leadId = fallbackLead ?? null;

        // Now a webhook arrives for the SAME email, a different submissionId (the site's real webhook twin).
        const webhookOutcome = await intakeWebhookLead(webhookPayload, { receivedAt: new Date(), isTest: false }, db);
        assert.equal(webhookOutcome.leadId, fallbackLead, "the webhook must link to the SAME lead the fallback created, not a second one");
    } finally {
        await cleanup(db, { externalIds: [`voice:${messageId}`, `sub:${webhookPayload.submissionId}`], leadId });
        await db.$disconnect();
    }
});
