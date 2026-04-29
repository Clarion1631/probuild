import { NextResponse } from "next/server";
import twilio from "twilio";
import { prisma } from "@/lib/prisma";
import { normalizeE164 } from "@/lib/phone";

// Twilio's default opt-out / help / start keywords. Twilio handles the
// auto-reply for these itself at the Messaging Service level — we just
// don't pollute the lead/project conversation log with them.
const OPT_OUT_KEYWORDS = new Set([
    "STOP", "STOPALL", "CANCEL", "END", "QUIT",
    "UNSUBSCRIBE", "REVOKE", "OPTOUT",
    "HELP", "INFO", "START",
]);

function emptyTwiml() {
    return new NextResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response/>`,
        { headers: { "Content-Type": "text/xml" } }
    );
}

export async function POST(request: Request) {
    // Twilio posts as application/x-www-form-urlencoded; Next's Web Request
    // .formData() parses both that and multipart.
    const formData = await request.formData();
    const params: Record<string, string> = {};
    for (const [k, v] of formData.entries()) params[k] = String(v);

    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const signature = request.headers.get("x-twilio-signature") || "";

    // Reconstruct the URL Twilio signed against. Vercel's x-forwarded-host can
    // resolve to an internal deployment URL rather than the custom domain, causing
    // signature mismatch. NEXT_PUBLIC_APP_URL is the authoritative public base and
    // matches exactly what we configured in the Twilio Messaging Service webhook.
    const appBase = process.env.NEXT_PUBLIC_APP_URL
        || (() => {
            const proto = request.headers.get("x-forwarded-proto") || "https";
            const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
            return `${proto}://${host}`;
        })();
    const reconstructedUrl = `${appBase}/api/twilio/inbound`;

    // Production: fail closed if creds missing or signature invalid.
    // Dev: skip validation only when TWILIO_AUTH_TOKEN is unset.
    if (process.env.NODE_ENV === "production") {
        if (!authToken) {
            console.error("[twilio/inbound] missing TWILIO_AUTH_TOKEN — refusing webhook");
            return new NextResponse("server misconfigured", { status: 500 });
        }
        const valid = twilio.validateRequest(authToken, signature, reconstructedUrl, params);
        if (!valid) {
            console.warn("[twilio/inbound] signature mismatch", { reconstructedUrl, signature: signature.slice(0, 10) });
            return new NextResponse("forbidden", { status: 403 });
        }
    } else if (authToken && signature) {
        // Dev with creds present: still validate, but only warn on failure.
        const valid = twilio.validateRequest(authToken, signature, reconstructedUrl, params);
        if (!valid) {
            console.warn("[twilio/inbound] (dev) signature mismatch — proceeding anyway");
        }
    }

    const fromRaw = params.From || "";
    const body = params.Body || "";
    const messageSid = params.MessageSid || "";
    const numMedia = parseInt(params.NumMedia || "0", 10) || 0;
    const fromE164 = normalizeE164(fromRaw);

    // Malformed payload: ack so Twilio doesn't retry, but record nothing.
    if (!messageSid) return emptyTwiml();

    // Idempotency: short-circuit if Twilio retried this MessageSid.
    const existing = await prisma.clientMessage.findUnique({ where: { twilioMessageSid: messageSid } });
    if (existing) return emptyTwiml();

    // Twilio handles STOP/HELP itself; don't pollute the conversation log.
    if (OPT_OUT_KEYWORDS.has(body.trim().toUpperCase())) return emptyTwiml();

    // Lookup client by indexed E.164 columns (primary OR additional).
    const client = fromE164
        ? await prisma.client.findFirst({
            where: {
                OR: [
                    { primaryPhoneE164: fromE164 },
                    { additionalPhoneE164: fromE164 },
                ],
            },
        })
        : null;

    // Resolve thread binding via outbound history first (most stable —
    // replies thread to wherever the team last sent from).
    // Fallback: active project (status="In Progress") by viewedAt desc,
    // else most recent non-archived lead by lastActivityAt desc.
    let leadId: string | null = null;
    let projectId: string | null = null;

    if (client) {
        const lastOutbound = await prisma.clientMessage.findFirst({
            where: {
                direction: "OUTBOUND",
                channel: { in: ["sms", "both"] },
                OR: [
                    { lead: { is: { clientId: client.id } } },
                    { project: { is: { clientId: client.id } } },
                ],
            },
            orderBy: { createdAt: "desc" },
            select: { leadId: true, projectId: true },
        });
        if (lastOutbound) {
            leadId = lastOutbound.leadId;
            projectId = lastOutbound.projectId;
        } else {
            const activeProject = await prisma.project.findFirst({
                where: { clientId: client.id, status: "In Progress" },
                orderBy: { viewedAt: "desc" },
                select: { id: true },
            });
            if (activeProject) {
                projectId = activeProject.id;
            } else {
                const latestLead = await prisma.lead.findFirst({
                    where: { clientId: client.id, isArchived: false },
                    orderBy: { lastActivityAt: "desc" },
                    select: { id: true },
                });
                leadId = latestLead?.id ?? null;
            }
        }
    }

    // MMS: capture media URLs into attachments JSON, append count note to body.
    const mediaUrls: string[] = [];
    for (let i = 0; i < numMedia; i++) {
        const url = params[`MediaUrl${i}`];
        if (url) mediaUrls.push(url);
    }
    const attachmentsJson = mediaUrls.length
        ? JSON.stringify(
              mediaUrls.map((u, i) => ({ type: "mms", url: u, name: `image-${i + 1}` }))
          )
        : null;
    const displayBody = mediaUrls.length
        ? `${body}${body ? "\n" : ""}[${mediaUrls.length} attached image${mediaUrls.length > 1 ? "s" : ""}]`
        : body;

    try {
        await prisma.clientMessage.create({
            data: {
                leadId,
                projectId,
                direction: "INBOUND",
                senderName: client?.name || fromE164 || fromRaw,
                senderEmail: null,
                subject: null,
                body: displayBody,
                channel: "sms",
                attachments: attachmentsJson,
                sentViaEmail: false,
                sentViaSms: true,
                status: "SENT",
                twilioMessageSid: messageSid,
            },
        });
    } catch (err: any) {
        // TOCTOU on Twilio retry: parallel webhook fires can race past the
        // findUnique idempotency check and both reach create. The unique index
        // on twilioMessageSid throws Prisma P2002. That means another request
        // already persisted this MessageSid — safe to ack.
        if (err?.code === "P2002") return emptyTwiml();
        console.error("[twilio/inbound] persist failed:", err?.message || err);
        // Return 5xx so Twilio retries; missing inbound is worse than a duplicate.
        return new NextResponse("persist error", { status: 500 });
    }

    return emptyTwiml();
}
