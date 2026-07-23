import { NextResponse } from "next/server";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const ACCEPTED_EVENTS = new Set([
    "email.delivered",
    "email.bounced",
    "email.complained",
    "email.delivery_delayed",
    "email.failed",
]);

export async function POST(request: Request) {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 });

    const payload = await request.text();
    let event: any;
    try {
        event = new Resend(process.env.RESEND_API_KEY || "re_webhook_verify_only").webhooks.verify({
            payload,
            headers: {
                id: request.headers.get("svix-id") || "",
                timestamp: request.headers.get("svix-timestamp") || "",
                signature: request.headers.get("svix-signature") || "",
            },
            webhookSecret: secret,
        });
    } catch {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    if (!ACCEPTED_EVENTS.has(event.type) || !event.data?.email_id) {
        return NextResponse.json({ accepted: true, ignored: true });
    }
    const occurredAt = new Date(event.created_at || event.data.created_at);
    if (Number.isNaN(occurredAt.getTime())) {
        return NextResponse.json({ error: "Invalid event timestamp" }, { status: 400 });
    }

    await prisma.emailEvent.upsert({
        where: { svixId: request.headers.get("svix-id")! },
        create: {
            svixId: request.headers.get("svix-id")!,
            resendEmailId: event.data.email_id,
            type: event.type,
            occurredAt,
            payload: event,
        },
        update: {},
    });
    return NextResponse.json({ accepted: true });
}
