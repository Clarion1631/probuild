"use server";

import { prisma } from "./prisma";
import { revalidatePath } from "next/cache";

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

    // Mock sending invite
    if (data.sendEmail) {
        console.log(`[Email] Mock inviting subcontractor ${data.email} to project ${projectId}`);
    }
    if (data.sendText && data.phone) {
        console.log(`[SMS] Mock inviting subcontractor ${data.phone} to project ${projectId}`);
    }

    revalidatePath(`/projects/${projectId}`);
    return { success: true, subId };
}
