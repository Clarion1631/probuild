import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";
import { sendSMS } from "@/lib/sms";

// Prevent this hitting max duration, limit to batched amounts if needed
// Vercel Cron hits this endpoint via GET
export async function GET(request: Request) {
    try {
        // Authenticate the request via Vercel Cron header
        // For local development, we'll bypass this if not on Vercel
        const authHeader = request.headers.get("authorization");
        if (process.env.VERCEL_ENV === "production" && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const now = new Date();
        const scheduledMessages = await prisma.clientMessage.findMany({
            where: {
                status: "SCHEDULED",
                scheduledFor: { lte: now }
            },
            include: {
                lead: {
                    include: { client: true }
                }
            },
            take: 20 // limit batch size per run
        });

        if (scheduledMessages.length === 0) {
            return NextResponse.json({ message: "No scheduled messages to send" }, { status: 200 });
        }

        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyName = settings?.companyName || "Your Contractor";
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://probuild-amber.vercel.app";

        let sentCount = 0;
        let failCount = 0;

        for (const msg of scheduledMessages) {
            try {
                const { lead, channel, body: messageBody, subject, senderName, attachments, ccEmails } = msg;
                if (!lead) continue;

                const parsedAttachments: { type: string, id: string, name: string, url?: string }[] = attachments ? JSON.parse(attachments) : [];
                const parsedCcEmails: string[] = ccEmails ? JSON.parse(ccEmails) : [];

                const emailAttachments: { filename: string; content: Buffer }[] = [];
                for (const att of parsedAttachments) {
                    if (att.type === "estimate") {
                        try {
                            const { generateEstimatePdf } = await import("@/lib/pdf");
                            const pdfBuffer = await generateEstimatePdf(att.id);
                            if (pdfBuffer) {
                                emailAttachments.push({ filename: `Estimate_${att.name || att.id}.pdf`, content: pdfBuffer });
                            }
                        } catch (e) {
                           console.error("[Cron] Failed to generate estimate PDF:", e);
                        }
                    }
                }

                const estimateLinksHtml = parsedAttachments
                    .filter(a => a.type === "estimate")
                    .map(a => `<a href="${a.url || appUrl}" style="display: inline-block; background: #4c9a2a; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; margin: 4px 0;">View ${a.name}</a>`)
                    .join("<br/>");

                let sentViaEmail = false;
                let sentViaSms = false;

                // Send email
                if ((channel === "email" || channel === "both") && lead.client?.email) {
                    const emailSubject = subject || `Message from ${companyName} about your project`;
                    await sendNotification(
                        lead.client?.email,
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
                        { fromName: companyName, replyTo: settings?.email || undefined, cc: parsedCcEmails.length > 0 ? parsedCcEmails : undefined }
                    );
                    sentViaEmail = true;
                }

                // Send SMS
                if ((channel === "sms" || channel === "both") && lead.client?.primaryPhone) {
                    const smsBody = parsedAttachments.length > 0
                        ? `${companyName}: ${messageBody}\n\nView your estimate: ${parsedAttachments[0]?.url || appUrl}`
                        : `${companyName}: ${messageBody}`;
                    await sendSMS(lead.client?.primaryPhone, smsBody);
                    sentViaSms = true;
                }

                await prisma.clientMessage.update({
                    where: { id: msg.id },
                    data: {
                        status: "SENT",
                        sentViaEmail: msg.sentViaEmail || sentViaEmail,
                        sentViaSms: msg.sentViaSms || sentViaSms
                    }
                });
                
                sentCount++;
            } catch (err) {
                console.error(`[Cron] Error sending message ${msg.id}:`, err);
                await prisma.clientMessage.update({
                    where: { id: msg.id },
                    data: { status: "FAILED" }
                });
                failCount++;
            }
        }

        return NextResponse.json({ message: "Processed scheduled messages", sentCount, failCount }, { status: 200 });

    } catch (error) {
        console.error("[Cron] Unhandled error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
