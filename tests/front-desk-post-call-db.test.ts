/**
 * Front Desk v1 acceptance tests 15, 16, 17 and 12 — against a REAL
 * PostgreSQL, same opt-in shape as tests/speed-to-lead-intake-db.test.ts.
 * `SPEED_TO_LEAD_TEST_URL` is reused deliberately: it is the same throwaway
 * database CI's `migrations` job builds from `prisma migrate deploy`, which
 * this feature's own migration is part of.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient, type Prisma } from "@prisma/client";
import { processPostCallInTx, extractPostCallFacts, postCallEnvelopeSchema, type FrontDeskCallFacts } from "../src/lib/front-desk/post-call";
import { resolveActionStep } from "../src/lib/front-desk/transfer";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

function baseFacts(overrides: Partial<FrontDeskCallFacts> = {}): FrontDeskCallFacts {
    const env = postCallEnvelopeSchema.parse({
        type: "post_call_transcription",
        data: {
            agent_id: "agent_x",
            conversation_id: "unused",
            metadata: { phone_call: { external_number: "+13605550100" } },
            analysis: {
                transcript_summary: "Wants a full kitchen remodel.",
                data_collection_results: {
                    caller_name: { value: "Race Caller" },
                    email: { value: `race-${Math.random().toString(36).slice(2)}@example.test` },
                    city: { value: "Vancouver" },
                    project_type: { value: "Kitchen" },
                    caller_kind: { value: "new_project" },
                },
            },
        },
    });
    return { ...extractPostCallFacts(env), ...overrides };
}

async function cleanup(db: PrismaClient, opts: { conversationId: string; leadId?: string | null }): Promise<void> {
    await db.frontDeskCall.deleteMany({ where: { conversationId: opts.conversationId } }).catch(() => undefined);
    await db.leadIntakeEvent.deleteMany({ where: { externalId: `fd:${opts.conversationId}` } }).catch(() => undefined);
    if (opts.leadId) {
        await db.leadAlert.deleteMany({ where: { leadId: opts.leadId } }).catch(() => undefined);
        const lead = await db.lead.findUnique({ where: { id: opts.leadId }, select: { clientId: true } }).catch(() => null);
        await db.lead.delete({ where: { id: opts.leadId } }).catch(() => undefined);
        if (lead?.clientId) await db.client.delete({ where: { id: lead.clientId } }).catch(() => undefined);
    }
}

async function runProcess(db: PrismaClient, conversationId: string, facts: FrontDeskCallFacts, isTest = true) {
    return db.$transaction((tx: Prisma.TransactionClient) => processPostCallInTx(tx, { conversationId, agentId: "agent_x", isTest, facts }));
}

test("a single post-call webhook creates exactly one FrontDeskCall, LeadIntakeEvent, Lead and NTFY alert", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const conversationId = `conv-${randomUUID()}`;
    let leadId: string | null = null;
    try {
        const result = await runProcess(db, conversationId, baseFacts());
        leadId = result.leadId;
        assert.equal(result.duplicate, false);
        assert.ok(result.leadId);
        assert.equal(result.outcome, "MESSAGE");

        const calls = await db.frontDeskCall.findMany({ where: { conversationId } });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].leadId, leadId);

        const events = await db.leadIntakeEvent.findMany({ where: { externalId: `fd:${conversationId}` } });
        assert.equal(events.length, 1);
        assert.equal(events[0].source, "FRONT_DESK_CALL");
        assert.equal(events[0].leadId, leadId);

        const alerts = await db.leadAlert.findMany({ where: { leadId: leadId! } });
        assert.equal(alerts.filter(a => a.channel === "NTFY").length, 1);
    } finally {
        await cleanup(db, { conversationId, leadId });
        await db.$disconnect();
    }
});

test("acceptance test 15/16: 5 concurrent identical webhooks -> exactly one processed, one Lead, one alert per channel; 4 say duplicate:true", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const conversationId = `conv-${randomUUID()}`;
    const facts = baseFacts();
    let leadId: string | null = null;
    try {
        const results = await Promise.all(Array.from({ length: 5 }, () => runProcess(db, conversationId, facts)));
        const nonDuplicate = results.filter(r => !r.duplicate);
        assert.equal(nonDuplicate.length, 1, "exactly one delivery should process");
        assert.equal(results.filter(r => r.duplicate).length, 4);
        leadId = nonDuplicate[0].leadId;

        const calls = await db.frontDeskCall.findMany({ where: { conversationId } });
        assert.equal(calls.length, 1);
        assert.ok(calls[0].postCallProcessedAt);

        const events = await db.leadIntakeEvent.findMany({ where: { externalId: `fd:${conversationId}` } });
        assert.equal(events.length, 1);

        const alerts = await db.leadAlert.findMany({ where: { leadId: leadId! } });
        const byChannel = new Map<string, number>();
        for (const a of alerts) byChannel.set(a.channel, (byChannel.get(a.channel) ?? 0) + 1);
        for (const [, count] of byChannel) assert.equal(count, 1);

        // Replaying after success: duplicate, no new writes.
        const replay = await runProcess(db, conversationId, facts);
        assert.equal(replay.duplicate, true);
        assert.equal((await db.frontDeskCall.findMany({ where: { conversationId } })).length, 1);
    } finally {
        await cleanup(db, { conversationId, leadId });
        await db.$disconnect();
    }
});

test("SPAM: verdict JUNK, no Lead, no LeadAlert, and the FrontDeskCall/LeadIntakeEvent rows are kept", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const conversationId = `conv-${randomUUID()}`;
    try {
        const result = await runProcess(db, conversationId, baseFacts({ callerKind: "spam" }));
        assert.equal(result.leadId, null);
        assert.equal(result.outcome, "SPAM");

        const event = await db.leadIntakeEvent.findUnique({ where: { externalId: `fd:${conversationId}` } });
        assert.equal(event?.verdict, "JUNK");
        assert.equal(event?.leadId, null);

        const call = await db.frontDeskCall.findUnique({ where: { conversationId } });
        assert.equal(call?.outcome, "SPAM");
    } finally {
        await cleanup(db, { conversationId });
        await db.$disconnect();
    }
});

test("acceptance test 17: a post-call and a missed-transfer action, concurrently, for the same conversation -> one Lead, one NTFY, at most one CHAT, one NTFY_URGENT", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const conversationId = `conv-${randomUUID()}`;
    let leadId: string | null = null;
    let transferId: string | null = null;
    try {
        const transfer = await db.frontDeskTransfer.create({
            data: {
                id: randomUUID(), conversationId, status: "DIALING", isTest: true,
                callerName: "Race Caller", callbackPhoneE164: "+13605550100", city: "Vancouver", project: "Kitchen",
                bridgeCallSid: `CA-${randomUUID()}`, dialStartedAt: new Date(),
            },
        });
        transferId = transfer.id;

        const [postCallResult] = await Promise.all([
            runProcess(db, conversationId, baseFacts()),
            resolveActionStep(db, { transferId: transfer.id, bridgeCallSid: transfer.bridgeCallSid!, dialCallStatus: "no-answer", dialBridged: "false" }),
        ]);
        leadId = postCallResult.leadId;

        const finalTransfer = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
        assert.equal(finalTransfer.status, "MISSED");
        assert.ok(finalTransfer.leadId, "the missed-transfer path must have linked a lead");

        // Both paths must resolve to the SAME lead.
        const finalLeadId = finalTransfer.leadId!;
        assert.equal(postCallResult.leadId, finalLeadId);
        const alerts = await db.leadAlert.findMany({ where: { leadId: finalLeadId } });
        const byChannel = new Map<string, number>();
        for (const a of alerts) byChannel.set(a.channel, (byChannel.get(a.channel) ?? 0) + 1);
        assert.equal(byChannel.get("NTFY"), 1);
        assert.equal(byChannel.get("NTFY_URGENT"), 1);
        assert.ok((byChannel.get("CHAT") ?? 0) <= 1);
        leadId = finalLeadId;
    } finally {
        if (transferId) await db.frontDeskTransfer.deleteMany({ where: { id: transferId } }).catch(() => undefined);
        await cleanup(db, { conversationId, leadId });
        await db.$disconnect();
    }
});
