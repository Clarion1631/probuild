import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sendNotification } from "@/lib/email";
import { sendSMS, htmlToSmsText, type SmsResult } from "@/lib/sms";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// GET /api/client-messages?clientId=X  OR  ?leadId=X  OR  ?projectId=X  OR  ?unmatched=true
export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get("clientId");
    const leadId = searchParams.get("leadId");
    const projectId = searchParams.get("projectId");
    const unmatched = searchParams.get("unmatched") === "true";

    if (unmatched) {
        // Inbound SMS from numbers we couldn't match to any Client are stored
        // with both leadId and projectId null. Surface them via this filter.
        // NOTE: this endpoint is session-gated only, not permission-gated.
        // Any future browser client calling this API must add a server-side
        // clientCommunication permission check before shipping. The /manager/inbox
        // page bypasses this route by reading Prisma directly and is correctly gated.
        const messages = await prisma.clientMessage.findMany({
            where: { leadId: null, projectId: null, direction: "INBOUND" },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
        return NextResponse.json({ messages });
    }

    // Unified client-level query: returns ALL messages for a client across
    // all their leads and projects in a single chronological timeline.
    // Resource-level auth: verify caller has access to at least one of the
    // client's leads/projects (ADMIN/MANAGER bypass).
    if (clientId) {
        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true, role: true },
        });
        if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

        if (user.role !== "ADMIN" && user.role !== "MANAGER") {
            const hasAccess = await prisma.project.findFirst({
                where: {
                    clientId,
                    OR: [
                        { userAccess: { some: { userId: user.id } } },
                        { crew: { some: { id: user.id } } },
                    ],
                },
                select: { id: true },
            });
            if (!hasAccess) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        }

        const messages = await prisma.clientMessage.findMany({
            where: { clientId },
            orderBy: { createdAt: "asc" },
            include: {
                lead: { select: { id: true, name: true } },
                project: { select: { id: true, name: true } },
            },
        });
        return NextResponse.json({ messages });
    }

    if (!leadId && !projectId) {
        return NextResponse.json({ error: "clientId, leadId, or projectId required" }, { status: 400 });
    }

    // Legacy entity-level queries (kept for backward compatibility)
    const messages = await prisma.clientMessage.findMany({
        where: leadId ? { leadId } : { projectId: projectId! },
        orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({ messages });
}

// POST /api/client-messages — send an outbound message to the client
export async function POST(request: Request) {
    const user = await getCurrentUserWithPermissions();
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(user, "clientCommunication")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
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
    let resolvedClientId: string | null = null;
    let clientEmail: string | null = null;
    let clientAdditionalEmail: string | null = null;
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
        resolvedClientId = lead.clientId;
        clientEmail = lead.client?.email ?? null;
        clientAdditionalEmail = (lead.client as any)?.additionalEmail ?? null;
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
        resolvedClientId = project.clientId;
        clientEmail = project.client?.email ?? null;
        clientAdditionalEmail = (project.client as any)?.additionalEmail ?? null;
        clientPhone = project.client?.primaryPhone ?? null;
        estimates = project.estimates;
    }

    // Auto-prepend secondary client email (spouse/partner) to CC list
    let resolvedCcEmails: string[] = ccEmails;
    if (clientAdditionalEmail && clientEmail &&
        clientAdditionalEmail.toLowerCase() !== clientEmail.toLowerCase() &&
        !resolvedCcEmails.some((e: string) => e.toLowerCase() === clientAdditionalEmail!.toLowerCase())) {
        resolvedCcEmails = [clientAdditionalEmail, ...resolvedCcEmails];
    }

    const senderName = user.name || user.email || "Team";
    const senderEmail = user.email || null;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    // Resolve attachments
    const emailAttachments: { filename: string; content: Buffer }[] = [];
    const resolvedAttachments: { type: string; id: string; name: string; url?: string }[] = [];
    const supabaseHost = (process.env.SUPABASE_URL || "").replace(/^https?:\/\//, "");

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
        } else if (att.type === "file") {
            // Only accept URLs from our Supabase storage domain
            try {
                const fileUrl = new URL(att.url);
                if (!supabaseHost || !fileUrl.hostname.endsWith(".supabase.co")) {
                    console.warn("[clientMessages] Rejected non-Supabase file URL:", att.url);
                    continue;
                }
            } catch {
                continue;
            }
            resolvedAttachments.push({ type: "file", id: att.id || "", name: att.name || "File", url: att.url });
        }
    }

    const parseDate = scheduledFor ? new Date(scheduledFor) : null;
    const isScheduled = parseDate && parseDate > new Date();

    let sentViaEmail = false;
    let sentViaSms = false;
    let smsResult: SmsResult | null = null;
    let smsSkippedReason: string | null = null;

    if (!isScheduled) {
        const estimateLinksHtml = resolvedAttachments
            .filter(a => a.type === "estimate")
            .map(a => `<a href="${a.url}" style="display:inline-block;background:#4c9a2a;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-weight:600;font-size:14px;margin:4px 0;">View ${a.name}</a>`)
            .join("<br/>");
        const fileLinksHtml = resolvedAttachments
            .filter(a => a.type === "file" && a.url)
            .map(a => `<a href="${a.url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:8px 20px;border-radius:8px;font-weight:600;font-size:13px;margin:4px 0;">📎 Download ${a.name}</a>`)
            .join("<br/>");

        if ((channel === "email" || channel === "both") && clientEmail) {
            const emailSubject = subject || `Message from ${companyName} about your project`;
            try {
                await sendNotification(
                    clientEmail,
                    emailSubject,
                    `<!DOCTYPE html>
                    <html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#333;">
                        <div style="text-align:center;margin-bottom:32px;"><h1 style="font-size:24px;font-weight:700;margin:0;">${companyName}</h1></div>
                        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
                            <p style="color:#666;margin:0 0 8px;">From: <strong>${escapeHtml(senderName)}</strong></p>
                            <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:16px 0;">
                                <p style="margin:0;line-height:1.6;white-space:pre-wrap;">${escapeHtml(messageBody)}</p>
                            </div>
                            ${estimateLinksHtml ? `<div style="margin-top:20px;text-align:center;">${estimateLinksHtml}</div>` : ""}
                            ${fileLinksHtml ? `<div style="margin-top:16px;text-align:center;">${fileLinksHtml}</div>` : ""}
                            ${projectId && /^[a-z0-9_-]+$/i.test(projectId) ? `<div style="margin-top:24px;padding-top:20px;border-top:1px solid #e5e7eb;text-align:center;">
                                <a href="${appUrl}/portal/projects/${projectId}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:14px;">View Your Project Portal</a>
                                <p style="color:#94a3b8;font-size:11px;margin:8px 0 0;">Access your estimates, contracts, files, and project updates</p>
                            </div>` : ""}
                        </div>
                        <p style="text-align:center;color:#94a3b8;font-size:11px;margin-top:16px;">${companyName}${settings?.address ? ` • ${settings.address}` : ""}</p>
                    </body></html>`,
                    emailAttachments.length > 0 ? emailAttachments : undefined,
                    { fromName: companyName, replyTo: settings?.email || undefined, cc: resolvedCcEmails.length > 0 ? resolvedCcEmails : undefined }
                );
                sentViaEmail = true;
            } catch (e) {
                console.error("[clientMessages] email send failed:", e);
            }
        }

        if (channel === "sms" || channel === "both") {
            if (!clientPhone) {
                smsSkippedReason = "Client has no phone number on file";
                if (channel === "sms") {
                    smsResult = { ok: false, error: "no_phone" } as SmsResult;
                }
            } else {
                const plainText = htmlToSmsText(messageBody);
                const smsBody = resolvedAttachments.length > 0
                    ? `${plainText}\n\nView your estimate: ${resolvedAttachments[0]?.url || appUrl}`
                    : plainText;
                smsResult = await sendSMS(clientPhone, smsBody);
                sentViaSms = smsResult.ok === true;
            }
        }
    }

    // status is FAILED only if all selected channels failed; SCHEDULED if deferred; otherwise SENT.
    let status: string;
    if (isScheduled) {
        status = "SCHEDULED";
    } else if (channel === "email") {
        status = sentViaEmail ? "SENT" : "FAILED";
    } else if (channel === "sms") {
        status = sentViaSms ? "SENT" : "FAILED";
    } else if (channel === "both") {
        status = (sentViaEmail || sentViaSms) ? "SENT" : "FAILED";
    } else {
        status = "SENT"; // "app" channel — internal-only, no external delivery
    }

    const message = await prisma.clientMessage.create({
        data: {
            clientId: resolvedClientId,
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
            status,
            scheduledFor: isScheduled ? parseDate : null,
            ccEmails: resolvedCcEmails.length > 0 ? JSON.stringify(resolvedCcEmails) : null,
            twilioMessageSid: smsResult?.ok ? smsResult.messageSid : null,
        },
    });

    const smsError = smsResult && !smsResult.ok ? smsResult.error : null;
    const warnings: string[] = [];
    if (smsSkippedReason && channel === "both") {
        warnings.push(`SMS skipped: ${smsSkippedReason}`);
    }

    let deliveryError: string | null = null;
    if (status === "FAILED") {
        deliveryError = channel === "sms"
            ? `SMS delivery failed: ${smsError || "unknown error"}`
            : channel === "both"
                ? `All channels failed${smsError ? ` (SMS: ${smsError})` : ""}`
                : "Email delivery failed";
    }

    return NextResponse.json({
        ...message,
        emailDelivered: sentViaEmail,
        smsDelivered: sentViaSms,
        smsError,
        warnings,
        deliveryError,
    }, { status: 201 });
}
