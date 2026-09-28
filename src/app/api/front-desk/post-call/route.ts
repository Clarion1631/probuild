import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyElevenLabsSignature } from "@/lib/front-desk/auth";
import { postCallEnvelopeSchema, extractPostCallFacts, processPostCallInTx } from "@/lib/front-desk/post-call";
import { frontDeskAgentId, frontDeskIsTest, frontDeskMode, FRONT_DESK_INTAKE_TX_MAX_WAIT_MS, FRONT_DESK_INTAKE_TX_TIMEOUT_MS, FRONT_DESK_POST_CALL_MAX_BYTES } from "@/lib/front-desk/constants";
import { deliverDueAlerts } from "@/lib/speed-to-lead/alerts";
import { logLeadEvent } from "@/lib/speed-to-lead/audit";
import { isRetryableTxError } from "@/lib/tx-retry";
import { safeErrorCategory } from "@/lib/speed-to-lead/error-category";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Front Desk v1 §1 — the ElevenLabs post-call webhook. Every early exit
 * writes nothing. No customer is ever contacted from this route — it only
 * writes rows and queues internal alerts.
 */
export async function POST(request: Request) {
    // §1 step 1: mode gate FIRST, before the body is even read.
    if (frontDeskMode() === "OFF") {
        return NextResponse.json({ error: "not available" }, { status: 503 });
    }

    // §1 step 2: size cap before signature verification.
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > FRONT_DESK_POST_CALL_MAX_BYTES) {
        return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }

    // §1 step 3: signature.
    const header = request.headers.get("elevenlabs-signature");
    const verified = verifyElevenLabsSignature({ header, rawBody, secret: process.env.FRONT_DESK_ELEVENLABS_WEBHOOK_SECRET });
    if (!verified.ok) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    // §1 step 4: parse.
    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(rawBody);
    } catch {
        return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    const parsed = postCallEnvelopeSchema.safeParse(parsedBody);
    if (!parsed.success) {
        return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    const envelope = parsed.data;

    // §1 step 5: type and agent.
    if (envelope.type !== "post_call_transcription") {
        await logLeadEvent(prisma, { kind: "front-desk-webhook-ignored", detail: { reason: "type", type: envelope.type } });
        return NextResponse.json({ ok: true, ignored: "type" });
    }
    const expectedAgentId = frontDeskAgentId();
    if (!expectedAgentId || envelope.data.agent_id !== expectedAgentId) {
        await logLeadEvent(prisma, { kind: "front-desk-webhook-ignored", detail: { reason: "agent", agentId: envelope.data.agent_id ?? null } });
        return NextResponse.json({ ok: true, ignored: "agent" });
    }

    const isTest = frontDeskIsTest();
    const facts = extractPostCallFacts(envelope);

    // §1 step 6: one interactive transaction.
    let outcome;
    try {
        outcome = await prisma.$transaction(
            tx => processPostCallInTx(tx, { conversationId: envelope.data.conversation_id, agentId: envelope.data.agent_id ?? null, isTest, facts }),
            { timeout: FRONT_DESK_INTAKE_TX_TIMEOUT_MS, maxWait: FRONT_DESK_INTAKE_TX_MAX_WAIT_MS },
        );
    } catch (error) {
        if (isRetryableTxError(error)) {
            return NextResponse.json({ error: "try again" }, { status: 503 });
        }
        console.error("[front-desk] post-call processing failed", safeErrorCategory(error));
        throw error;
    }

    // §1 step 7: alert delivery runs in after() — the webhook gets its 200 back immediately.
    after(async () => {
        try {
            await deliverDueAlerts();
        } catch (error) {
            console.error("[front-desk] post-call alert delivery failed", safeErrorCategory(error));
        }
    });

    return NextResponse.json({ ok: true, duplicate: outcome.duplicate });
}
