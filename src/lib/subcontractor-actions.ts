"use server";

import { prisma } from "./prisma";
import { revalidatePath } from "next/cache";
import { sendNotification } from "./email";
import { sendSMS } from "./sms";
import { SignJWT } from "jose";

const JWT_SECRET = new TextEncoder().encode(
    process.env.SUB_PORTAL_SECRET || "sub-portal-dev-secret-change-me"
);

export async function getProjectSubcontractors(projectId: string) {
    const allSubs = await prisma.subcontractor.findMany({
        orderBy: { companyName: "asc" }
    });

    const projectAccess = await prisma.subcontractorProjectAccess.findMany({
        where: { projectId },
        select: { subcontractorId: true }
    });

    const assignedIds = new Set(projectAccess.map(a => a.subcontractorId));

    return allSubs.map(sub => ({
        ...sub,
        isAssigned: assignedIds.has(sub.id)
    }));
}

export async function toggleSubcontractorProjectAccess(projectId: string, subcontractorId: string, assign: boolean) {
    if (assign) {
        await prisma.subcontractorProjectAccess.upsert({
            where: {
                subcontractorId_projectId: { subcontractorId, projectId }
            },
            create: { subcontractorId, projectId },
            update: {}
        });
    } else {
        await prisma.subcontractorProjectAccess.delete({
            where: {
                subcontractorId_projectId: { subcontractorId, projectId }
            }
        }).catch(() => {}); // ignore if it doesn't exist
    }

    revalidatePath(`/projects/${projectId}`);
    return { success: true };
}

export async function inviteNewSubcontractor(projectId: string, data: {
    firstName: string;
    lastName: string;
    company: string;
    website?: string;
    email: string;
    phone?: string;
    sendEmail: boolean;
    sendText: boolean;
}) {
    // Check if email already exists
    const existing = await prisma.subcontractor.findFirst({
        where: { email: data.email }
    });

    let subId = existing?.id;

    if (!existing) {
        const newSub = await prisma.subcontractor.create({
            data: {
                companyName: data.company,
                email: data.email,
                phone: data.phone || null,
                website: data.website || null,
                firstName: data.firstName || null,
                lastName: data.lastName || null,
            }
        });
        subId = newSub.id;
    }

    // Assign to project
    await prisma.subcontractorProjectAccess.upsert({
        where: { subcontractorId_projectId: { subcontractorId: subId!, projectId } },
        create: { subcontractorId: subId!, projectId },
        update: {}
    });

    // Send invite
    if (data.sendEmail) {
        let portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://probuild.goldentouchremodeling.com"}/sub-portal/projects/${projectId}`;
        
        try {
            // Generate a secure one-off magic link that auto-authenticates them and routes to the project
            const token = await new SignJWT({ subId: subId!, email: data.email })
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt()
                .setExpirationTime("72h") // Invite links last longer than standard re-login ones
                .sign(JWT_SECRET);
                
            portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://probuild.goldentouchremodeling.com"}/api/sub-portal/verify?token=${token}&next=/sub-portal/projects/${projectId}`;
        } catch (e) {
            console.error("Failed to generate magic invite link, sending static URL");
        }
        
        const html = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #1e293b; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">Project Invitation</h2>
                <p>Hello ${data.firstName || data.company},</p>
                <p>You have been invited to collaborate on a Golden Touch Remodeling project as a subcontractor.</p>
                <p>Please access the Subcontractor Portal to view project files, details, and schedules.</p>
                
                <div style="margin: 30px 0; text-align: center;">
                    <a href="${portalUrl}" style="background-color: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                        Access Project Portal
                    </a>
                </div>
                
                <p>If you have any questions, please reply to this email or contact your project manager.</p>
                <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
                    Best regards,<br/><strong>Golden Touch Remodeling</strong>
                </p>
            </div>
        `;

        await sendNotification(
            data.email,
            "You've been invited to a project - Golden Touch Remodeling",
            html
        );
    }
    if (data.sendText && data.phone) {
        await sendSMS(
            data.phone,
            `You've been invited to a project by Golden Touch Remodeling. Access your portal at ${process.env.NEXT_PUBLIC_APP_URL || 'https://probuild-amber.vercel.app'}/sub-portal`
        );
    }

    revalidatePath(`/projects/${projectId}`);
    return { success: true, subId };
}

export async function markSubcontractorProjectViewed(projectId: string, subcontractorId: string) {
    const access = await prisma.subcontractorProjectAccess.findUnique({
        where: { subcontractorId_projectId: { subcontractorId, projectId } },
        include: { subcontractor: true, project: { include: { client: true } } }
    });

    if (!access) return { success: false };

    // If already viewed, do nothing to avoid spam
    if (access.viewedAt) return { success: true };

    // Mark as viewed
    await prisma.subcontractorProjectAccess.update({
        where: { id: access.id },
        data: { viewedAt: new Date() }
    });

    // Notify Project Manager
    const managers = await prisma.user.findMany({
        where: { role: { in: ['ADMIN', 'MANAGER'] } },
        take: 1
    });

    if (managers.length > 0) {
        const pmEmail = managers[0].email;
        const html = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #1e293b; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">Project Seen!</h2>
                <p>Hello,</p>
                <p><strong>${access.subcontractor.companyName}</strong> has just accepted your invite and viewed the project: <strong>${access.project.name}</strong> on the Subcontractor Portal.</p>
                <p>They now have access to the files, schedules, and details you've shared.</p>
            </div>
        `;

        await sendNotification(
            pmEmail,
            `Subcontractor Viewed Project: ${access.project.name}`,
            html
        );
    }

    return { success: true };
}

export async function resendSubcontractorInvite(projectId: string, subcontractorId: string) {
    const sub = await prisma.subcontractor.findUnique({
        where: { id: subcontractorId }
    });

    if (!sub || !sub.email) return { success: false, error: "Subcontractor has no email address." };

    let portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://probuild.goldentouchremodeling.com"}/sub-portal/projects/${projectId}`;
    
    try {
        const token = await new SignJWT({ subId: sub.id, email: sub.email })
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt()
            .setExpirationTime("72h")
            .sign(JWT_SECRET);
            
        portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://probuild.goldentouchremodeling.com"}/api/sub-portal/verify?token=${token}&next=/sub-portal/projects/${projectId}`;
    } catch (e) {
        console.error("Failed to generate magic invite link, sending static URL");
    }
    
    const html = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1e293b; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">Project Invitation Reminder</h2>
            <p>Hello ${sub.firstName || sub.companyName},</p>
            <p>This is a reminder that you have been invited to collaborate on a Golden Touch Remodeling project as a subcontractor.</p>
            <p>Please access the Subcontractor Portal to view project files, details, and schedules.</p>
            
            <div style="margin: 30px 0; text-align: center;">
                <a href="${portalUrl}" style="background-color: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                    Access Project Portal
                </a>
            </div>
            
            <p>If you have any questions, please reply to this email or contact your project manager.</p>
            <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
                Best regards,<br/><strong>Golden Touch Remodeling</strong>
            </p>
        </div>
    `;

    await sendNotification(
        sub.email,
        "Reminder: You've been invited to a project - Golden Touch Remodeling",
        html
    );

    return { success: true };
}
