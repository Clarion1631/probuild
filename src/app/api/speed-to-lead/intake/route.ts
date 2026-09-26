import { NextResponse, after } from "next/server";
import { verifyWebhookSignature, WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_SIGNATURE_HEADER } from "@/lib/speed-to-lead/hmac";
import { webIntakePayloadSchema } from "@/lib/speed-to-lead/payload";
import { intakeWebhookLead } from "@/lib/speed-to-lead/intake";
import { deliverDueAlerts } from "@/lib/speed-to-lead/alerts";
import { isRetryableTxError } from "@/lib/tx-retry";
import { speedToLeadMode, INTAKE_MAX_BODY_BYTES } from "@/lib/speed-to-lead/constants";
import { safeErrorCategory } from "@/lib/speed-to-lead/error-category";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Web intake webhook. v1a sends nothing to callers beyond `{ok, duplicate}`
 * — no leadId, no verdict (those are internal facts, not something an
 * unauthenticated-by-session caller needs echoed back).
 */
export async function POST(request: Request) {
    // Mode gate FIRST — before even reading the body — so OFF never touches
    // the DB or does any work at all.
    if (speedToLeadMode() === "OFF") {
        return NextResponse.json({ error: "not available" }, { status: 503 });
    }

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > INTAKE_MAX_BODY_BYTES) {
        return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }

    const timestamp = request.headers.get(WEBHOOK_TIMESTAMP_HEADER);
    const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER);

    // isTest is a SIGNED claim, never a bare field in the body: the request
    // is verified against the real webhook secret first; only if that fails
    // is it tried against LEAD_INGEST_TEST_SECRET. Either success continues;
    // any other outcome — including a present-but-invalid signature under
    // EITHER secret, or LEAD_INGEST_TEST_SECRET being unset — is a generic
    // 401 with zero rows. There is no path where a failed test signature
    // falls through and creates a real lead.
    const real = verifyWebhookSignature({ timestamp, signature, rawBody, secret: process.env.SPEED_TO_LEAD_WEBHOOK_SECRET });
    let isTest = false;
    let ok = real.ok;
    if (!ok) {
        const test = verifyWebhookSignature({ timestamp, signature, rawBody, secret: process.env.LEAD_INGEST_TEST_SECRET });
        if (test.ok) { ok = true; isTest = true; }
    }
    if (!ok) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(rawBody);
    } catch {
        return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    const parsed = webIntakePayloadSchema.safeParse(parsedBody);
    if (!parsed.success) {
        return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }

    // Intake's own interactive transaction carries an explicit timeout
    // (constants.ts's INTAKE_TX_TIMEOUT_MS) — a timeout maps to 503, so the
    // site retries, and intake stays idempotent either way (the exactly-once
    // externalId insert is never partially applied).
    let outcome;
    try {
        outcome = await intakeWebhookLead(parsed.data, { receivedAt: new Date(), isTest });
    } catch (error) {
        if (isRetryableTxError(error)) {
            return NextResponse.json({ error: "try again" }, { status: 503 });
        }
        throw error;
    }

    // Alert delivery runs in after() — the caller (the site) gets its 200
    // back immediately, and the alert still goes out within ~60s via the
    // durable claim/deliver loop rather than blocking this response on a
    // third-party HTTP call.
    after(async () => {
        try {
            await deliverDueAlerts();
        } catch (error) {
            console.error("[speed-to-lead] post-intake alert delivery failed", safeErrorCategory(error));
        }
    });

    return NextResponse.json({ ok: true, duplicate: !outcome.won });
}
