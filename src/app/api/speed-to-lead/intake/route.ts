import { NextResponse } from "next/server";
import { verifyWebhookSignature, WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_SIGNATURE_HEADER } from "@/lib/speed-to-lead/hmac";
import { webIntakePayloadSchema } from "@/lib/speed-to-lead/payload";
import { intakeWebhookLead } from "@/lib/speed-to-lead/intake";
import { pushToJustin } from "@/lib/speed-to-lead/push";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Web intake webhook (spec Goal 1). The site POSTs a signed payload; this
 * route verifies the signature, validates the payload, and runs intake
 * exactly-once per submissionId. Every web lead and Voice event gets a push
 * within 5 minutes (Goal 3) — Voice pushes come from the inbox poll, not here.
 */
export async function POST(request: Request) {
    const rawBody = await request.text();
    const verify = verifyWebhookSignature({
        timestamp: request.headers.get(WEBHOOK_TIMESTAMP_HEADER),
        signature: request.headers.get(WEBHOOK_SIGNATURE_HEADER),
        rawBody,
        secret: process.env.SPEED_TO_LEAD_WEBHOOK_SECRET,
    });
    if (!verify.ok) {
        return NextResponse.json({ error: "signature verification failed", reason: verify.reason }, { status: 401 });
    }

    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(rawBody);
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const parsed = webIntakePayloadSchema.safeParse(parsedBody);
    if (!parsed.success) {
        return NextResponse.json({ error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
    }

    // Test intake is signed with a DIFFERENT secret and never from form
    // fields (spec Release "Test identity") — the admin "Create test lead"
    // action and the readiness runner both call intakeWebhookLead directly
    // rather than going through this route, so isTest is always false here.
    const outcome = await intakeWebhookLead(parsed.data, { receivedAt: new Date() });

    if (outcome.won) {
        await pushToJustin(
            "New web lead",
            `${parsed.data.name} (${parsed.data.email}) — ${outcome.verdict ?? "REVIEW"}`,
        );
    }

    return NextResponse.json({ leadId: outcome.leadId, verdict: outcome.verdict });
}
