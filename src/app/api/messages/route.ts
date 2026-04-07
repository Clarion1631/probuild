import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sendNotification } from "@/lib/email";
import { sendSMS } from "@/lib/sms";

// GET /api/messages?projectId=X&subcontractorId=Y — list messages for a project thread
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    const subcontractorId = searchParams.get("subcontractorId") || null;

    if (!projectId) {
        return NextResponse.json({ error: "projectId required" }, { status: 400 });
    }

    // Find or create the thread
    let thread = await prisma.messageThread.findFirst({
        where: { projectId, subcontractorId },
        include: {
            messages: {
                orderBy: { createdAt: "asc" },
            },
        },
    });

    if (!thread) {
        thread = await prisma.messageThread.create({
            data: { projectId, subcontractorId },
            include: {
                messages: {
                    orderBy: { createdAt: "asc" },
                },
            },
        });
    }

    return NextResponse.json(thread);
}

// POST /api/messages — send a message
export async function POST(request: Request) {
    const body = await request.json();
    let { projectId, body: messageBody, senderType, senderName, senderEmail, subcontractorId } = body;
    subcontractorId = subcontractorId || null;

    if (!projectId || !messageBody || !senderType) {
        return NextResponse.json({ error: "projectId, body, and senderType required" }, { status: 400 });
    }

    if (!["CLIENT", "TEAM", "SUBCONTRACTOR"].includes(senderType)) {
        return NextResponse.json({ error: "senderType must be CLIENT, TEAM, or SUBCONTRACTOR" }, { status: 400 });
    }

    // Ensure thread exists
    let thread = await prisma.messageThread.findFirst({ where: { projectId, subcontractorId } });
    if (!thread) {
        thread = await prisma.messageThread.create({ data: { projectId, subcontractorId } });
    }

    // Resolve sender name if not provided
    let resolvedName = senderName || "Unknown";
    let resolvedEmail = senderEmail || null;

    if (senderType === "TEAM" && !senderName) {
        const session = await getServerSession(authOptions);
        if (session?.user) {
            resolvedName = session.user.name || session.user.email || "Team Member";
            resolvedEmail = session.user.email || null;
        }
    }

    const message = await prisma.message.create({
        data: {
            threadId: thread.id,
            senderType,
            senderName: resolvedName,
            senderEmail: resolvedEmail,
            body: messageBody,
        },
    });

    // Send email notification
    try {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: { client: true },
        });

        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyName = settings?.companyName || "Your Contractor";
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

        // Logic for Subcontractor Thread Notifications
        if (subcontractorId) {
            const sub = await prisma.subcontractor.findUnique({ where: { id: subcontractorId } });
            
            if (senderType === "SUBCONTRACTOR" && settings?.notificationEmail) {
                // Sub sent a message → notify the team
                await sendNotification(
                    settings.notificationEmail,
                    `New sub message from ${resolvedName} — ${project?.name || "Project"}`,
                    `<!DOCTYPE html>
                    <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                        <div style="text-align: center; margin-bottom: 32px;">
                            <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
                        </div>
                        <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                            <h2 style="font-size: 20px; margin: 0 0 8px;">New Subcontractor Message</h2>
                            <p style="color: #666; margin: 0 0 16px;">Project: <strong>${project?.name || "Unknown"}</strong></p>
                            <p style="color: #666; margin: 0 0 8px;">From: <strong>${resolvedName}</strong> (Subcontractor)</p>
                            <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
                                <p style="margin: 0; line-height: 1.6;">${messageBody}</p>
                            </div>
                            <div style="text-align: center; margin-top: 24px;">
                                <a href="${appUrl}/projects/${projectId}/messages/subs" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                                    Reply in ProBuild
                                </a>
                            </div>
                        </div>
                    </body></html>`
                );
            } else if (senderType === "TEAM" && sub?.email) {
                // Team sent a message → notify the subcontractor
                await sendNotification(
                    sub.email,
                    `${companyName} sent you a message — ${project?.name}`,
                    `<!DOCTYPE html>
                    <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                        <div style="text-align: center; margin-bottom: 32px;">
                            <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
                        </div>
                        <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                            <h2 style="font-size: 20px; margin: 0 0 8px;">New Message</h2>
                            <p style="color: #666; margin: 0 0 16px;">Project: <strong>${project?.name || "Unknown"}</strong></p>
                            <p style="color: #666; margin: 0 0 8px;">From: <strong>${resolvedName}</strong></p>
                            <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
                                <p style="margin: 0; line-height: 1.6;">${messageBody}</p>
                            </div>
                            <div style="text-align: center; margin-top: 24px;">
                                <a href="${appUrl}/sub-portal/projects/${projectId}/messages" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                                    View in Portal
                                </a>
                            </div>
                        </div>
                    </body></html>`
                );
            }
        } else {
            // Client Thread Notifications
            if (senderType === "CLIENT" && settings?.notificationEmail) {
                // Client sent a message → notify the team
                await sendNotification(
                    settings.notificationEmail,
                    `New message from ${resolvedName} — ${project?.name || "Project"}`,
                    `<!DOCTYPE html>
                    <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                        <div style="text-align: center; margin-bottom: 32px;">
                            <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
                        </div>
                        <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                            <h2 style="font-size: 20px; margin: 0 0 8px;">New Client Message</h2>
                            <p style="color: #666; margin: 0 0 16px;">Project: <strong>${project?.name || "Unknown"}</strong></p>
                            <p style="color: #666; margin: 0 0 8px;">From: <strong>${resolvedName}</strong></p>
                            <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
                                <p style="margin: 0; line-height: 1.6;">${messageBody}</p>
                            </div>
                            <div style="text-align: center; margin-top: 24px;">
                                <a href="${appUrl}/projects/${projectId}/messages" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                                    Reply in ProBuild
                                </a>
                            </div>
                        </div>
                    </body></html>`
                );
            } else if (senderType === "TEAM" && project?.client?.email) {
                // Team sent a message → notify the client
                await sendNotification(
                    project.client?.email,
                    `${companyName} sent you a message — ${project.name}`,
                    `<!DOCTYPE html>
                    <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                        <div style="text-align: center; margin-bottom: 32px;">
                            <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
                        </div>
                        <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                            <h2 style="font-size: 20px; margin: 0 0 8px;">New Message</h2>
                            <p style="color: #666; margin: 0 0 16px;">Project: <strong>${project.name}</strong></p>
                            <p style="color: #666; margin: 0 0 8px;">From: <strong>${resolvedName}</strong></p>
                            <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
                                <p style="margin: 0; line-height: 1.6;">${messageBody}</p>
                            </div>
                            <div style="text-align: center; margin-top: 24px;">
                                <a href="${appUrl}/portal/projects/${projectId}" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                                    View in Portal
                                </a>
                            </div>
                        </div>
                    </body></html>`
                );
            }
            // Send SMS notification
            if (senderType === "CLIENT" && settings?.phone) {
                // Client sent a message → text the team
                await sendSMS(
                    settings.phone,
                    `${companyName}: New message from ${resolvedName} on ${project?.name || "project"}: "${messageBody.substring(0, 100)}${messageBody.length > 100 ? '...' : ''}" — Reply at ${appUrl}/projects/${projectId}/messages`
                );
            } else if (senderType === "TEAM" && project?.client?.primaryPhone) {
                // Team sent a message → text the client
                await sendSMS(
                    project.client?.primaryPhone,
                    `${companyName}: New message about your ${project.name} project from ${resolvedName}: "${messageBody.substring(0, 100)}${messageBody.length > 100 ? '...' : ''}" — View at ${appUrl}/portal/projects/${projectId}`
                );
            }
        }
    } catch (e) {
        console.error("Failed to send message notification:", e);
    }

    return NextResponse.json(message, { status: 201 });
}
