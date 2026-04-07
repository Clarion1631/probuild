import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sendNotification } from "@/lib/email";
import { sendSMS } from "@/lib/sms";

// GET /api/client-messages?leadId=X  OR  ?projectId=X
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const leadId = searchParams.get("leadId");
    const projectId = searchParams.get("projectId");

    if (!leadId && !projectId) {
        return NextResponse.json({ error: "leadId or projectId required" }, { status: 400 });
    }

    const messages = await prisma.clientMessage.findMany({
        where: leadId ? { leadId } : { projectId: projectId! },
        orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({ messages });
}

// POST /api/client-messages — send an outbound message to the client
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    const body = await request.json();
    const {
        leadId,
        projectId,
        body: messageBody,
        subject,
        channel = "email",
        attachments = [],
        scheduledFor,
        ccEmails = [],
    } = body;

    if (!messageBody || (!leadId && !projectId)) {
        return NextResponse.json({ error: "body and (leadId or projectId) required" }, { status: 400 });
    }

    // Resolve client info from lead or project
    let clientEmail: string | null = null;
    let clientPhone: string | null = null;
    let estimates: { id: string; code: string; title: string; status: string }[] = [];

    if (leadId) {
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            include: {
                client: true,
                estimates: { select: { id: true, code: true, title: true, status: true } },
            },
        });
        if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
        clientEmail = lead.client?.email ?? null;
        clientPhone = lead.client?.primaryPhone ?? null;
        estimates = lead.estimates;
    } else {
        const project = await prisma.project.findUnique({
            where: { id: projectId! },
            include: {
                client: true,
                estimates: { select: { id: true, code: true, title: true, status: true } },
            },
        });
        if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
        clientEmail = project.client?.email ?? null;
        clientPhone = project.client?.primaryPhone ?? null;
        estimates = project.estimates;
    }

    const senderName = session?.user?.name || session?.user?.email || "Team";
    const senderEmail = session?.user?.email || null;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    // Resolve attachments
    const emailAttachments: { filename: string; content: Buffer }[] = [];
    const resolvedAttachments: { type: string; id: string; name: string; url?: string }[] = [];

    for (const att of attachments) {
        if (att.type === "estimate") {
            try {
                const { generateEstimatePdf } = await import("@/lib/pdf");
                const pdfBuffer = await generateEstimatePdf(att.id);
                if (pdfBuffer) {
                    emailAttachments.push({ filename: `Estimate_${att.name || att.id}.pdf`, content: pdfBuffer });
                    resolvedAttachments.push({ type: "estimate", id: att.id, name: att.name || "Estimate", url: `${appUrl}/portal/estimates/${att.id}` });
                }
            } catch (e) {
                console.error("[clientMessages] Failed to generate estimate PDF:", e);
                resolvedAttachments.push({ type: "estimate", id: att.id, name: att.name || "Estimate", url: `${appUrl}/portal/estimates/${att.id}` });
            }
        }
    }

    const parseDate = scheduledFor ? new Date(scheduledFor) : null;
    const isScheduled = parseDate && parseDate > new Date();

    let sentViaEmail = false;
    let sentViaSms = false;

    if (!isScheduled) {
        const estimateLinksHtml = resolvedAttachments
            .filter(a => a.type === "estimate")
            .map(a => `<a href="${a.url}" style="display:inline-block;background:#4c9a2a;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-weight:600;font-size:14px;margin:4px 0;">View ${a.name}</a>`)
            .join("<br/>");

        if ((channel === "email" || channel === "both") && clientEmail) {
            const emailSubject = subject || `Message from ${companyName} about your project`;
            await sendNotification(
                clientEmail,
                emailSubject,
                `<!DOCTYPE html>
                <html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#333;">
                    <div style="text-align:center;margin-bottom:32px;"><h1 style="font-size:24px;font-weight:700;margin:0;">${companyName}</h1></div>
                    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
                        <p style="color:#666;margin:0 0 8px;">From: <strong>${senderName}</strong></p>
                        <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:16px 0;">
                            <p style="margin:0;line-height:1.6;white-space:pre-wrap;">${messageBody}</p>
                        </div>
                        ${estimateLinksHtml ? `<div style="margin-top:20px;text-align:center;">${estimateLinksHtml}</div>` : ""}
                    </div>
                    <p style="text-align:center;color:#94a3b8;font-size:11px;margin-top:16px;">${companyName}${settings?.address ? ` • ${settings.address}` : ""}</p>
                </body></html>`,
                emailAttachments.length > 0 ? emailAttachments : undefined,
                { fromName: companyName, replyTo: settings?.email || undefined, cc: ccEmails.length > 0 ? ccEmails : undefined }
            );
            sentViaEmail = true;
        }

        if ((channel === "sms" || channel === "both") && clientPhone) {
            const smsBody = resolvedAttachments.length > 0
                ? `${companyName}: ${messageBody}\n\nView your estimate: ${resolvedAttachments[0]?.url || appUrl}`
                : `${companyName}: ${messageBody}`;
            await sendSMS(clientPhone, smsBody);
            sentViaSms = true;
        }
    }

    const message = await prisma.clientMessage.create({
        data: {
            leadId: leadId || null,
            projectId: projectId || null,
            direction: "OUTBOUND",
            senderName,
            senderEmail,
            subject: subject || null,
            body: messageBody,
            channel,
            attachments: resolvedAttachments.length > 0 ? JSON.stringify(resolvedAttachments) : null,
            sentViaEmail,
            sentViaSms,
            status: isScheduled ? "SCHEDULED" : "SENT",
            scheduledFor: isScheduled ? parseDate : null,
            ccEmails: ccEmails.length > 0 ? JSON.stringify(ccEmails) : null,
        },
    });

    return NextResponse.json(message, { status: 201 });
}
