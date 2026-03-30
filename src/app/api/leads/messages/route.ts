import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sendNotification } from "@/lib/email";
import { sendSMS } from "@/lib/sms";

// GET /api/leads/messages?leadId=X — list messages for a lead
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const leadId = searchParams.get("leadId");

    if (!leadId) {
        return NextResponse.json({ error: "leadId required" }, { status: 400 });
    }

    const messages = await prisma.leadMessage.findMany({
        where: { leadId },
        orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({ messages });
}

// POST /api/leads/messages — send a new outbound message from team to client
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    const body = await request.json();
    const {
        leadId,
        body: messageBody,
        subject,
        channel = "email", // "email", "sms", or "both"
        attachments = [],  // [{ type: "estimate", id, name }]
    } = body;

    if (!leadId || !messageBody) {
        return NextResponse.json({ error: "leadId and body required" }, { status: 400 });
    }

    // Fetch lead + client
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        include: { client: true, estimates: { select: { id: true, code: true, title: true, status: true } } },
    });

    if (!lead) {
        return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    const senderName = session?.user?.name || session?.user?.email || "Team";
    const senderEmail = session?.user?.email || null;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://probuild-amber.vercel.app";

    // Resolve attachments — build email attachments and estimate links
    const emailAttachments: { filename: string; content: Buffer }[] = [];
    const resolvedAttachments: { type: string; id: string; name: string; url?: string }[] = [];

    for (const att of attachments) {
        if (att.type === "estimate") {
            // Generate estimate PDF
            try {
                const { generateEstimatePdf } = await import("@/lib/pdf");
                const pdfBuffer = await generateEstimatePdf(att.id);
                if (pdfBuffer) {
                    const filename = `Estimate_${att.name || att.id}.pdf`;
                    emailAttachments.push({ filename, content: pdfBuffer });
                    resolvedAttachments.push({ type: "estimate", id: att.id, name: att.name || "Estimate", url: `${appUrl}/portal/estimates/${att.id}` });
                }
            } catch (e) {
                console.error("[leadMessages] Failed to generate estimate PDF:", e);
                // Still add as a link-only attachment
                resolvedAttachments.push({ type: "estimate", id: att.id, name: att.name || "Estimate", url: `${appUrl}/portal/estimates/${att.id}` });
            }
        }
    }

    // Build estimate links HTML for the email body
    const estimateLinksHtml = resolvedAttachments
        .filter(a => a.type === "estimate")
        .map(a => `<a href="${a.url}" style="display: inline-block; background: #4c9a2a; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; margin: 4px 0;">View ${a.name}</a>`)
        .join("<br/>");

    let sentViaEmail = false;
    let sentViaSms = false;

    // Send email
    if ((channel === "email" || channel === "both") && lead.client.email) {
        const emailSubject = subject || `Message from ${companyName} about your project`;
        await sendNotification(
            lead.client.email,
            emailSubject,
            `<!DOCTYPE html>
            <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                <div style="text-align: center; margin-bottom: 32px;">
                    <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
                </div>
                <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                    <p style="color: #666; margin: 0 0 8px;">From: <strong>${senderName}</strong></p>
                    <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
                        <p style="margin: 0; line-height: 1.6; white-space: pre-wrap;">${messageBody}</p>
                    </div>
                    ${estimateLinksHtml ? `<div style="margin-top: 20px; text-align: center;">${estimateLinksHtml}</div>` : ""}
                </div>
                <p style="text-align: center; color: #94a3b8; font-size: 11px; margin-top: 16px;">${companyName}${settings?.address ? ` • ${settings.address}` : ""}</p>
            </body></html>`,
            emailAttachments.length > 0 ? emailAttachments : undefined,
            { fromName: companyName, replyTo: settings?.email || undefined }
        );
        sentViaEmail = true;
    }

    // Send SMS
    if ((channel === "sms" || channel === "both") && lead.client.primaryPhone) {
        const smsBody = resolvedAttachments.length > 0
            ? `${companyName}: ${messageBody}\n\nView your estimate: ${resolvedAttachments[0]?.url || appUrl}`
            : `${companyName}: ${messageBody}`;
        await sendSMS(lead.client.primaryPhone, smsBody);
        sentViaSms = true;
    }

    // Persist message
    const message = await prisma.leadMessage.create({
        data: {
            leadId,
            direction: "OUTBOUND",
            senderName,
            senderEmail,
            subject: subject || null,
            body: messageBody,
            channel,
            attachments: resolvedAttachments.length > 0 ? JSON.stringify(resolvedAttachments) : null,
            sentViaEmail,
            sentViaSms,
        },
    });

    return NextResponse.json(message, { status: 201 });
}
