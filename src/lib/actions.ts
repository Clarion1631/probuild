"use server";

import { prisma } from "./prisma";
import { revalidatePath } from "next/cache";
import { sendNotification } from "./email";

// Safe estimate include that omits columns not yet migrated to the database.
// Remove this wrapper once the DB Push workflow succeeds and the Estimate table
// has: processingFeeMarkup, hideProcessingFee, expirationDate, archivedAt.
const safeEstimateInclude = {
    select: {
        id: true,
        number: true,
        title: true,
        projectId: true,
        leadId: true,
        code: true,
        status: true,
        privacy: true,
        createdAt: true,
        totalAmount: true,
        balanceDue: true,
        items: true,
        expenses: true,
        paymentSchedules: true,
        approvedBy: true,
        approvedAt: true,
        approvalIp: true,
        approvalUserAgent: true,
        signatureUrl: true,
        contractId: true,
        viewedAt: true,
    },
} as const;

export async function getLeads() {
    const leads = await prisma.lead.findMany({
        orderBy: { createdAt: "desc" },
        include: {
            client: true,
            estimates: safeEstimateInclude,
            manager: true,
            tasks: {
                where: { status: { not: "Done" } },
                orderBy: { dueDate: "asc" },
                take: 1
            }
        },
    });
    return leads.map((l: any) => ({
        ...l,
        client: l.client || { id: "unassigned", name: "No Client", email: "", primaryPhone: "", addressLine1: "", city: "", state: "", zipCode: "" }
    }));
}

export async function getLead(id: string) {
    const lead = await prisma.lead.findUnique({
        where: { id },
        include: {
            client: true,
            estimates: safeEstimateInclude,
            contracts: true,
            manager: true,
            tasks: {
                orderBy: { createdAt: "desc" }
            },
            floorPlans: true
        },
    });
    if (lead && !lead.client) {
        (lead as any).client = { id: "unassigned", name: "No Client", email: "", primaryPhone: "", addressLine1: "", city: "", state: "", zipCode: "" };
    }
    return lead;
}

export async function updateLeadStage(id: string, stage: string) {
    await prisma.lead.update({
        where: { id },
        data: { stage }
    });
    revalidatePath(`/leads/${id}`);
    revalidatePath(`/leads`);
}

export async function createLead(data: { name: string; clientName: string; clientEmail?: string; clientPhone?: string; location?: string; source?: string; projectType?: string; message?: string }) {
    // Find or create client
    let client = await prisma.client.findFirst({
        where: { name: data.clientName },
    });

    if (!client) {
        const initials = data.clientName
            .split(" ")
            .map((n) => n[0])
            .join("")
            .toUpperCase()
            .slice(0, 2);
        client = await prisma.client.create({
            data: {
                name: data.clientName,
                initials,
                email: data.clientEmail || null,
                primaryPhone: data.clientPhone || null,
            },
        });
    }

    const lead = await prisma.lead.create({
        data: {
            name: data.name,
            clientId: client.id,
            location: data.location || null,
            source: data.source || null,
            projectType: data.projectType || null,
            message: data.message || null,
            stage: "New",
        },
    });

    revalidatePath("/leads");
    return { id: lead.id };
}

export async function updateLeadMetadata(id: string, updates: { isUnread?: boolean; isArchived?: boolean; snoozedUntil?: Date | null; tags?: string; expectedProfit?: number; expectedStartDate?: Date | null; targetRevenue?: number }) {
    await prisma.lead.update({
        where: { id },
        data: {
            ...updates,
            lastActivityAt: new Date()
        }
    });
    revalidatePath(`/leads`);
    revalidatePath(`/leads/${id}`);
}

export async function deleteLead(id: string) {
    await prisma.lead.delete({
        where: { id }
    });
    revalidatePath(`/leads`);
}

export async function updateLeadAssignment(id: string, managerId: string | null) {
    await prisma.lead.update({
        where: { id },
        data: { managerId }
    });
    revalidatePath(`/leads`);
    revalidatePath(`/leads/${id}`);
}

export async function updateLeadInfo(id: string, data: any) {
    // data contains all the EditLeadModal form data
    const lead = await prisma.lead.findUnique({ where: { id }});
    if (!lead) return;

    await prisma.lead.update({
        where: { id },
        data: {
            name: data.name,
            source: data.source,
            stage: data.stage,
            location: data.location,
            tags: data.tags,
            targetRevenue: data.targetRevenue ? parseFloat(data.targetRevenue) : null,
            expectedProfit: data.expectedProfit ? parseFloat(data.expectedProfit) : null,
            projectType: data.projectType,
            expectedStartDate: data.expectedStartDate ? new Date(data.expectedStartDate) : null,
            message: data.message,
            lastActivityAt: new Date()
        }
    });

    // Also update client if passed in
    if (data.clientName) {
        await prisma.client.update({
            where: { id: lead.clientId },
            data: {
                name: data.clientName,
                addressLine1: data.location // Simple mapping for now
            }
        });
    }

    revalidatePath(`/leads`);
    revalidatePath(`/leads/${id}`);
}

export async function getClients() {
    return await prisma.client.findMany({
        orderBy: { name: "asc" },
        include: {
            projects: {
                include: { estimates: safeEstimateInclude }
            },
            leads: true
        }
    });
}

export async function getClient(id: string) {
    return await prisma.client.findUnique({
        where: { id },
        include: {
            projects: true,
            leads: true,
            invoices: true,
        }
    });
}

export async function createClient(data: { name: string; email?: string; companyName?: string; primaryPhone?: string; addressLine1?: string; city?: string; state?: string; zipCode?: string; internalNotes?: string }) {
    "use server";
    const initials = data.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);

    const client = await prisma.client.create({
        data: {
            name: data.name,
            initials,
            email: data.email || null,
            companyName: data.companyName || null,
            primaryPhone: data.primaryPhone || null,
            addressLine1: data.addressLine1 || null,
            city: data.city || null,
            state: data.state || null,
            zipCode: data.zipCode || null,
            internalNotes: data.internalNotes || null,
        },
    });
    revalidatePath("/clients");
    return client;
}

export async function updateClient(clientId: string, data: { name?: string; email?: string; primaryPhone?: string; addressLine1?: string; city?: string; state?: string; zipCode?: string }) {
    "use server";
    const client = await prisma.client.update({
        where: { id: clientId },
        data: {
            name: data.name,
            email: data.email,
            primaryPhone: data.primaryPhone,
            addressLine1: data.addressLine1,
            city: data.city,
            state: data.state,
            zipCode: data.zipCode,
        },
    });

    // Revalidate all projects using this client so name/details update everywhere
    const linkedProjects = await prisma.project.findMany({
        where: { clientId },
        select: { id: true },
    });
    for (const p of linkedProjects) {
        revalidatePath(`/projects/${p.id}`, 'layout');
    }
    revalidatePath("/leads");
    revalidatePath("/projects");
    return client;
}

export async function updateLead(leadId: string, data: { name?: string; source?: string; expectedStartDate?: string | null; targetRevenue?: number | null; location?: string; projectType?: string }) {
    "use server";
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.source !== undefined) updateData.source = data.source;
    if (data.location !== undefined) updateData.location = data.location;
    if (data.projectType !== undefined) updateData.projectType = data.projectType;
    if (data.expectedStartDate !== undefined) updateData.expectedStartDate = data.expectedStartDate ? new Date(data.expectedStartDate) : null;
    if (data.targetRevenue !== undefined) updateData.targetRevenue = data.targetRevenue;

    const lead = await prisma.lead.update({
        where: { id: leadId },
        data: updateData,
    });

    // Sync name to linked project when lead name changes
    if (data.name !== undefined) {
        const linkedProject = await prisma.project.findUnique({ where: { leadId } });
        if (linkedProject) {
            await prisma.project.update({
                where: { id: linkedProject.id },
                data: { name: data.name },
            });
            revalidatePath(`/projects`);
            revalidatePath(`/projects/${linkedProject.id}`, 'layout');
        }
    }

    revalidatePath(`/leads/${leadId}`);
    return lead;
}

// =============================================
// Lead Tasks CRUD
// =============================================

export async function getLeadTasks(leadId: string) {
    return await prisma.leadTask.findMany({
        where: { leadId },
        orderBy: { createdAt: "desc" },
        include: { assignee: { select: { id: true, name: true, email: true } } },
    });
}

export async function createLeadTask(leadId: string, data: {
    title: string;
    status?: string;
    dueDate?: string | null;
    tags?: string | null;
    assigneeId?: string | null;
}) {
    const task = await prisma.leadTask.create({
        data: {
            leadId,
            title: data.title,
            status: data.status || "To Do",
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            tags: data.tags || null,
            assigneeId: data.assigneeId || null,
        },
    });
    revalidatePath(`/leads/${leadId}/tasks`);
    return task;
}

export async function updateLeadTask(taskId: string, data: {
    title?: string;
    status?: string;
    dueDate?: string | null;
    tags?: string | null;
    assigneeId?: string | null;
}) {
    const updateData: any = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (data.tags !== undefined) updateData.tags = data.tags;
    if (data.assigneeId !== undefined) updateData.assigneeId = data.assigneeId || null;

    const task = await prisma.leadTask.update({
        where: { id: taskId },
        data: updateData,
    });
    revalidatePath(`/leads/${task.leadId}/tasks`);
    return task;
}

export async function deleteLeadTask(taskId: string) {
    const task = await prisma.leadTask.findUnique({ where: { id: taskId } });
    if (!task) return { success: false };
    await prisma.leadTask.delete({ where: { id: taskId } });
    revalidatePath(`/leads/${task.leadId}/tasks`);
    return { success: true };
}

// =============================================
// Lead Meetings CRUD
// =============================================

export async function getLeadMeetings(leadId: string) {
    return await prisma.leadMeeting.findMany({
        where: { leadId },
        orderBy: { scheduledAt: "asc" },
    });
}

export async function createLeadMeeting(leadId: string, data: {
    title: string;
    meetingType: string;
    duration: number;
    scheduledAt: string;
    location?: string | null;
    videoApp?: string | null;
    description?: string | null;
}) {
    const startDate = new Date(data.scheduledAt);
    const endDate = new Date(startDate.getTime() + data.duration * 60000);

    const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { client: true } });
    if (!lead) throw new Error("Lead not found");

    const meeting = await prisma.leadMeeting.create({
        data: {
            leadId,
            title: data.title,
            meetingType: data.meetingType,
            duration: data.duration,
            scheduledAt: startDate,
            endAt: endDate,
            location: data.location || null,
            videoApp: data.videoApp || null,
            description: data.description || null,
        },
    });

    // Generate .ics string
    const formatIcsDate = (date: Date) => date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
UID:${meeting.id}@probuild.goldentouchremodeling.com
DTSTAMP:${formatIcsDate(new Date())}
DTSTART:${formatIcsDate(startDate)}
DTEND:${formatIcsDate(endDate)}
SUMMARY:${data.title}
DESCRIPTION:${data.description || 'Meeting scheduled via ProBuild.'}
LOCATION:${data.location || data.videoApp || 'Remote'}
ORGANIZER;CN="Golden Touch Remodeling":mailto:info@goldentouchremodeling.com
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="${lead.client.name}":mailto:${lead.client.email || 'unknown@example.com'}
END:VEVENT
END:VCALENDAR`;

    const icsBuffer = Buffer.from(icsContent, 'utf8');
    const attachments = [{ filename: 'invite.ics', content: icsBuffer }];

    try {
        const { sendNotification } = await import('@/lib/email');

        const companyEmail = 'jadkins@goldentouchremodeling.com';
        
        // 1. Send to internal team (for Google Calendar processing)
        await sendNotification(
            companyEmail,
            `New Meeting Scheduled: ${data.title}`,
            `<p>A new meeting was scheduled with ${lead.client.name} for ${startDate.toLocaleString()}. Check your calendar for details.</p>`,
            attachments
        );

        // 2. Send to Client
        if (lead.client.email) {
            await sendNotification(
                lead.client.email,
                `Meeting Scheduled: ${data.title}`,
                `<p>Hi ${lead.client.name},<br><br>We have scheduled a meeting to discuss your project: ${data.title}.<br>Time: ${startDate.toLocaleString()}<br><br>Please see the attached calendar invite.<br><br>Thanks,<br>Golden Touch Remodeling</p>`,
                attachments
            );
        }
    } catch (e) {
        console.error("Failed to sequence calendar invites: ", e);
    }

    revalidatePath(`/leads/${leadId}`);
    revalidatePath(`/leads/${leadId}/meetings`);
    return meeting;
}

export async function updateLeadMeeting(meetingId: string, data: {
    title?: string;
    meetingType?: string;
    duration?: number;
    scheduledAt?: string;
    location?: string | null;
    videoApp?: string | null;
    description?: string | null;
    status?: string;
}) {
    const updateData: any = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.meetingType !== undefined) updateData.meetingType = data.meetingType;
    if (data.duration !== undefined) updateData.duration = data.duration;
    if (data.location !== undefined) updateData.location = data.location;
    if (data.videoApp !== undefined) updateData.videoApp = data.videoApp;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.scheduledAt !== undefined) {
        updateData.scheduledAt = new Date(data.scheduledAt);
        if (data.duration !== undefined) {
            updateData.endAt = new Date(updateData.scheduledAt.getTime() + data.duration * 60000);
        }
    }

    const meeting = await prisma.leadMeeting.update({
        where: { id: meetingId },
        data: updateData,
    });
    revalidatePath(`/leads/${meeting.leadId}`);
    revalidatePath(`/leads/${meeting.leadId}/meetings`);
    return meeting;
}

export async function deleteLeadMeeting(meetingId: string) {
    const meeting = await prisma.leadMeeting.findUnique({ where: { id: meetingId } });
    if (!meeting) return { success: false };
    await prisma.leadMeeting.delete({ where: { id: meetingId } });
    revalidatePath(`/leads/${meeting.leadId}`);
    revalidatePath(`/leads/${meeting.leadId}/meetings`);
    return { success: true };
}

export async function getProjects() {
    const projects = await prisma.project.findMany({
        orderBy: { viewedAt: "desc" },
        include: {
            client: true,
            estimates: safeEstimateInclude,
        },
    });
    return projects.map((p: any) => ({
        ...p,
        client: p.client || { id: "unassigned", name: "No Client", email: "", primaryPhone: "", addressLine1: "", city: "", state: "", zipCode: "" }
    }));
}

export async function getProject(id: string) {
    const include = {
        client: true,
        estimates: safeEstimateInclude,
        floorPlans: true,
        contracts: { include: { signingRecords: true }, orderBy: { createdAt: "desc" } },
    } as const;

    // Support both CUID and friendly numeric ID in URL params
    const numericId = /^\d+$/.test(id) ? parseInt(id, 10) : null;
    const project = numericId
        ? await prisma.project.findFirst({ where: { number: numericId }, include })
        : await prisma.project.findUnique({ where: { id }, include });

    if (project && !project.client) {
        (project as any).client = { id: "unassigned", name: "No Client", email: "", primaryPhone: "", addressLine1: "", city: "", state: "", zipCode: "" };
    }
    return project;
}

export async function getProjectLead(projectId: string) {
    // Direct approach: use leadId if set
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { leadId: true, clientId: true, lead: { select: { id: true, name: true, stage: true } } },
    });
    if (!project) return null;
    if (project.lead) return project.lead;
    // Fallback: find lead by matching client
    const lead = await prisma.lead.findFirst({
        where: { clientId: project.clientId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, stage: true },
    });
    return lead;
}

export async function linkProjectToLead(projectId: string, leadId: string | null) {
    "use server";
    const project = await prisma.project.update({
        where: { id: projectId },
        data: { leadId },
    });
    revalidatePath(`/projects/${projectId}`, 'layout');
    revalidatePath(`/projects`);
    return project;
}

export async function getLeadsForLinking() {
    "use server";
    const leads = await prisma.lead.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, stage: true, client: { select: { name: true } } },
        take: 50,
    });
    return leads;
}

export async function createProject(data: { name: string; clientName: string; clientEmail?: string; location?: string; type?: string }) {
    // Find or create client
    let client = await prisma.client.findFirst({
        where: { name: data.clientName },
    });

    if (!client) {
        const initials = data.clientName
            .split(" ")
            .map((n) => n[0])
            .join("")
            .toUpperCase()
            .slice(0, 2);
        client = await prisma.client.create({
            data: {
                name: data.clientName,
                initials,
                email: data.clientEmail || null,
            },
        });
    }

    const project = await prisma.project.create({
        data: {
            name: data.name,
            clientId: client.id,
            location: data.location || null,
            type: data.type || null,
            status: "In Progress",
        },
    });

    revalidatePath("/");
    return { id: project.id };
}

export async function convertLeadToProject(leadId: string) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new Error("Lead not found");

    const project = await prisma.project.create({
        data: {
            name: lead.name,
            clientId: lead.clientId,
            location: lead.location,
            status: "In Progress",
            type: "Unknown",
        },
    });

    // Relink estimates
    await prisma.estimate.updateMany({
        where: { leadId },
        data: { projectId: project.id, leadId: null },
    });

    // Relink floor plans
    await prisma.floorPlan.updateMany({
        where: { leadId },
        data: { projectId: project.id, leadId: null },
    });

    // Update lead
    await prisma.lead.update({
        where: { id: leadId },
        data: { stage: "Won" },
    });

    revalidatePath("/leads");
    revalidatePath("/projects");
    revalidatePath(`/leads/${leadId}`);

    return { id: project.id };
}

export async function createDraftEstimate(projectId: string) {
    const code = `EST-${Math.floor(1000 + Math.random() * 9000)}`;

    const estimate = await prisma.estimate.create({
        data: {
            title: "Draft Estimate",
            projectId,
            code,
            status: "Draft",
            totalAmount: 0,
            balanceDue: 0,
            privacy: "Shared",
        },
    });

    revalidatePath(`/projects/${projectId}/estimates`);
    return { id: estimate.id };
}

export async function createDraftLeadEstimate(leadId: string) {
    const code = `EST-${Math.floor(1000 + Math.random() * 9000)}`;

    const estimate = await prisma.estimate.create({
        data: {
            title: "Draft Estimate",
            leadId,
            code,
            status: "Draft",
            totalAmount: 0,
            balanceDue: 0,
            privacy: "Shared",
        },
    });

    revalidatePath(`/leads/${leadId}`);
    return { id: estimate.id };
}

export async function createDraftFloorPlan(projectId: string) {
    const floorPlan = await prisma.floorPlan.create({
        data: {
            name: "New Floor Plan",
            projectId,
        },
    });

    revalidatePath(`/projects/${projectId}/floor-plans`);
    return { id: floorPlan.id };
}

export async function createDraftLeadFloorPlan(leadId: string) {
    const floorPlan = await prisma.floorPlan.create({
        data: {
            name: "New Floor Plan",
            leadId,
        },
    });

    revalidatePath(`/leads/${leadId}/floor-plans`);
    return { id: floorPlan.id };
}

export async function getFloorPlan(id: string) {
    return await prisma.floorPlan.findUnique({ where: { id } });
}

export async function saveFloorPlanData(id: string, relatedId: string, data: string, isLead: boolean = false) {
    await prisma.floorPlan.update({
        where: { id },
        data: { data },
    });

    if (isLead) {
        revalidatePath(`/leads/${relatedId}/floor-plans`);
    } else {
        revalidatePath(`/projects/${relatedId}/floor-plans`);
    }
    return { success: true };
}

export async function getEstimate(id: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id },
        include: {
            items: {
                orderBy: { order: "asc" },
                include: {
                    expenses: true,
                    costCode: true,
                    costType: true,
                },
            },
            paymentSchedules: {
                orderBy: { order: "asc" },
            },
            expenses: true,
        },
    });
    return estimate;
}

export async function updateEstimateStatus(id: string, status: string, leadId?: string, projectId?: string) {
    await prisma.estimate.update({
        where: { id },
        data: { status }
    });
    if (leadId) revalidatePath(`/leads/${leadId}`);
    if (projectId) revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/leads/${leadId}/estimates/${id}`);
    revalidatePath(`/projects/${projectId}/estimates/${id}`);
}

export async function getEstimateForPortal(id: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id },
        include: {
            project: {
                include: { client: true },
            },
            lead: {
                include: { client: true },
            },
            items: {
                orderBy: { order: "asc" },
            },
            paymentSchedules: {
                orderBy: { order: "asc" },
            },
        },
    });

    if (!estimate) return null;

    // Flatten for portal usage
    return {
        ...estimate,
        projectName: estimate.project?.name || estimate.lead?.name || null,
        clientName: estimate.project?.client?.name || estimate.lead?.client?.name || "Unknown Client",
        clientEmail: estimate.project?.client?.email || estimate.lead?.client?.email || null,
    };
}

export async function getAllEstimates() {
    return await prisma.estimate.findMany({
        orderBy: { createdAt: "desc" },
        include: {
            project: {
                include: { client: true }
            },
            lead: {
                include: { client: true }
            }
        }
    });
}

export async function markEstimateViewed(estimateId: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { viewedAt: true, title: true, code: true, project: { select: { name: true, client: { select: { name: true } } } }, lead: { select: { name: true, client: { select: { name: true } } } } },
    });

    if (estimate && !estimate.viewedAt) {
        await prisma.estimate.update({
            where: { id: estimateId },
            data: { viewedAt: new Date() },
        });

        const clientName = estimate.project?.client?.name || estimate.lead?.client?.name || "A client";
        const projectName = estimate.project?.name || estimate.lead?.name || "";
        const settings = await getCompanySettings();
        if (settings.notificationEmail) {
            await sendNotification(
                settings.notificationEmail,
                `👁️ Estimate Viewed — ${estimate.title || estimate.code}`,
                `<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 20px;">
                        <h3 style="margin: 0 0 8px; color: #0369a1;">Estimate Viewed</h3>
                        <p style="margin: 0 0 4px; color: #333;"><strong>${clientName}</strong> opened estimate <strong>${estimate.title || estimate.code}</strong>${projectName ? ` for ${projectName}` : ""}.</p>
                        <p style="margin: 0; color: #666; font-size: 13px;">Viewed at: ${new Date().toLocaleString()}</p>
                    </div>
                </div>`
            );
        }
    }
}

export async function markContractViewed(contractId: string) {
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        select: { viewedAt: true, title: true, project: { select: { name: true, client: { select: { name: true } } } }, lead: { select: { name: true, client: { select: { name: true } } } } },
    });

    if (contract && !contract.viewedAt) {
        await prisma.contract.update({
            where: { id: contractId },
            data: { viewedAt: new Date() },
        });

        const clientName = contract.project?.client?.name || contract.lead?.client?.name || "A client";
        const projectName = contract.project?.name || contract.lead?.name || "";
        const settings = await getCompanySettings();
        if (settings.notificationEmail) {
            await sendNotification(
                settings.notificationEmail,
                `👁️ Contract Viewed — ${contract.title}`,
                `<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                    <div style="background: #fefce8; border: 1px solid #fde68a; border-radius: 8px; padding: 20px;">
                        <h3 style="margin: 0 0 8px; color: #854d0e;">Contract Viewed</h3>
                        <p style="margin: 0 0 4px; color: #333;"><strong>${clientName}</strong> opened contract <strong>${contract.title}</strong>${projectName ? ` for ${projectName}` : ""}.</p>
                        <p style="margin: 0; color: #666; font-size: 13px;">Viewed at: ${new Date().toLocaleString()}</p>
                    </div>
                </div>`
            );
        }
    }
}

export async function approveEstimate(estimateId: string, signatureName: string, ipAddress: string, userAgent: string, signatureDataUrl?: string) {
    const approvedAt = new Date();

    await prisma.estimate.update({
        where: { id: estimateId },
        data: {
            status: "Approved",
            approvedBy: signatureName,
            approvedAt,
            approvalIp: ipAddress,
            approvalUserAgent: userAgent,
            signatureUrl: signatureDataUrl || null,
        },
    });

    // Fetch full estimate data for emails and filing
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: {
            projectId: true, leadId: true, code: true, title: true,
            project: { select: { id: true, name: true, client: { select: { name: true, email: true } } } },
            lead: { select: { name: true, client: { select: { name: true, email: true } } } },
        },
    });

    const settings = await getCompanySettings();
    const companyName = settings.companyName || "Golden Touch Remodeling";
    const estimateCode = estimate?.code || estimateId;
    const projectName = estimate?.project?.name || estimate?.lead?.name || "your project";
    const clientName = estimate?.project?.client?.name || estimate?.lead?.client?.name || signatureName;
    const clientEmail = estimate?.project?.client?.email || estimate?.lead?.client?.email || null;
    const pdfFilename = `Signed_Estimate_${estimateCode}.pdf`;

    // Generate PDF once — reused for customer email, company email, and project filing
    let pdfBuffer: Buffer | null = null;
    let attachments: any = undefined;
    try {
        const { generateEstimatePdf } = await import("./pdf");
        pdfBuffer = await generateEstimatePdf(estimateId);
        attachments = [{ filename: pdfFilename, content: pdfBuffer }];
    } catch (e) {
        console.error("Failed to generate PDF snapshot for signed estimate:", e);
    }

    // ─── 1. Email the CUSTOMER a professional confirmation ───
    if (clientEmail) {
        await sendNotification(
            clientEmail,
            `Your Approved Estimate — ${estimateCode}`,
            `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-radius: 12px 12px 0 0; padding: 32px 28px;">
                    <h1 style="color: #fff; font-size: 20px; margin: 0 0 4px;">Thank You, ${clientName}!</h1>
                    <p style="color: #94a3b8; font-size: 14px; margin: 0;">Your estimate has been approved and signed.</p>
                </div>
                <div style="background: #fff; border: 1px solid #e2e8f0; border-top: none; padding: 28px; border-radius: 0 0 12px 12px;">
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                        <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Estimate</td><td style="padding: 8px 0; text-align: right; font-weight: 600; color: #0f172a; font-size: 13px;">${estimateCode}</td></tr>
                        <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Project</td><td style="padding: 8px 0; text-align: right; font-weight: 600; color: #0f172a; font-size: 13px;">${projectName}</td></tr>
                        <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Signed By</td><td style="padding: 8px 0; text-align: right; font-weight: 600; color: #0f172a; font-size: 13px;">${signatureName}</td></tr>
                        <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Date</td><td style="padding: 8px 0; text-align: right; font-weight: 600; color: #0f172a; font-size: 13px;">${approvedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</td></tr>
                    </table>
                    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px;">
                        <p style="margin: 0; color: #166534; font-size: 13px;">✓ A signed copy of your estimate is attached to this email for your records.</p>
                    </div>
                    <p style="color: #64748b; font-size: 13px; line-height: 1.6; margin: 0;">
                        If you have any questions, feel free to reach out to us${settings.phone ? ` at ${settings.phone}` : ""}${settings.email ? ` or ${settings.email}` : ""}.
                    </p>
                </div>
                <p style="text-align: center; color: #94a3b8; font-size: 11px; margin-top: 16px;">${companyName}${settings.address ? ` • ${settings.address}` : ""}</p>
            </div>`,
            attachments,
            { fromName: companyName, replyTo: settings.email || undefined }
        );
    }

    // ─── 2. Email the COMPANY notification ───
    if (settings.notificationEmail) {
        await sendNotification(
            settings.notificationEmail,
            `✅ Estimate Approved: ${estimateCode}`,
            `<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px;">
                    <h3 style="margin: 0 0 8px; color: #166534;">Estimate Signed & Approved</h3>
                    <p style="margin: 0 0 12px; color: #333;"><strong>${signatureName}</strong> has electronically signed estimate <strong>${estimateCode}</strong> for <strong>${projectName}</strong>.</p>
                    <table style="width: 100%; font-size: 13px; color: #555;">
                        <tr><td style="padding: 4px 0;">Client</td><td style="text-align: right; font-weight: 600;">${clientName}</td></tr>
                        <tr><td style="padding: 4px 0;">Signed At</td><td style="text-align: right;">${approvedAt.toLocaleString()}</td></tr>
                        <tr><td style="padding: 4px 0;">IP Address</td><td style="text-align: right; font-family: monospace; font-size: 12px;">${ipAddress}</td></tr>
                    </table>
                </div>
                ${clientEmail ? `<p style="margin: 12px 0 0; font-size: 12px; color: #888;">A copy was also sent to the client at ${clientEmail}.</p>` : ""}
            </div>`,
            attachments
        );
    }

    // ─── 3. File the signed PDF into the project's "Signed Documents" folder ───
    if (pdfBuffer && estimate?.projectId) {
        try {
            const { getSupabase, STORAGE_BUCKET } = await import("./supabase");
            const supabase = getSupabase();

            if (supabase) {
                // Find or create a "Signed Documents" folder for this project
                let folder = await prisma.fileFolder.findFirst({
                    where: { projectId: estimate.projectId, name: "Signed Documents", parentId: null },
                });
                if (!folder) {
                    folder = await prisma.fileFolder.create({
                        data: { name: "Signed Documents", projectId: estimate.projectId },
                    });
                }

                // Upload to Supabase Storage
                const storagePath = `projects/${estimate.projectId}/signed/${Date.now()}_${pdfFilename}`;
                const { error: uploadError } = await supabase.storage
                    .from(STORAGE_BUCKET)
                    .upload(storagePath, pdfBuffer, {
                        contentType: "application/pdf",
                        upsert: false,
                    });

                if (!uploadError) {
                    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
                    const publicUrl = urlData?.publicUrl || storagePath;

                    await prisma.projectFile.create({
                        data: {
                            name: pdfFilename,
                            url: publicUrl,
                            size: pdfBuffer.length,
                            mimeType: "application/pdf",
                            projectId: estimate.projectId,
                            folderId: folder.id,
                        },
                    });
                } else {
                    console.error("[approveEstimate] Supabase upload failed:", uploadError);
                }
            }
        } catch (fileErr) {
            // Non-critical — don't block the approval if filing fails
            console.error("[approveEstimate] Failed to file signed PDF:", fileErr);
        }
    }

    if (estimate?.projectId) {
        revalidatePath(`/projects/${estimate.projectId}/estimates`);
        revalidatePath(`/projects/${estimate.projectId}/files`);
    }
    revalidatePath(`/portal/estimates/${estimateId}`);
    return { success: true };
}

export async function deleteInvoice(invoiceId: string) {
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
    });
    if (!invoice) throw new Error("Invoice not found");

    const hasPaidPayments = invoice.payments.some(p => p.status === "Paid");
    if (hasPaidPayments) throw new Error("Cannot delete an invoice with recorded payments");
    if (invoice.status === "Paid" || invoice.status === "Partially Paid") {
        throw new Error("Cannot delete a paid or partially paid invoice");
    }

    await prisma.invoice.delete({ where: { id: invoiceId } });
    revalidatePath(`/projects/${invoice.projectId}/invoices`);
    revalidatePath(`/invoices`);
    return { success: true, projectId: invoice.projectId };
}

export async function updateInvoiceNotes(invoiceId: string, notes: string) {
    const invoice = await prisma.invoice.update({
        where: { id: invoiceId },
        data: { notes },
    });
    revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    return { success: true };
}

export async function sendInvoiceToClient(invoiceId: string, overrideEmail?: string) {
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
            project: { include: { client: true } },
            client: true,
        },
    });
    if (!invoice) throw new Error("Invoice not found");

    const recipientEmail = overrideEmail || invoice.client?.email;
    if (!recipientEmail) throw new Error("No email address provided");

    if (invoice.status === "Draft") {
        await prisma.invoice.update({
            where: { id: invoiceId },
            data: { status: "Issued", issueDate: new Date(), sentAt: new Date() },
        });
    } else {
        await prisma.invoice.update({
            where: { id: invoiceId },
            data: { sentAt: new Date() },
        });
    }

    const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/portal/invoices/${invoiceId}`;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

    await sendNotification(
        recipientEmail,
        `${companyName} sent you an invoice — ${invoice.code}`,
        `<!DOCTYPE html>
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
            </div>
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">Invoice ${invoice.code}</h2>
                <p style="color: #666; margin: 0 0 24px;">Hi ${invoice.client?.name || 'there'},</p>
                <p style="color: #666; line-height: 1.6;">
                    ${companyName} has sent you an invoice for <strong>$${(invoice.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>.
                    Please click the button below to view the details and make a payment.
                </p>
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${portalUrl}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        View & Pay Invoice
                    </a>
                </div>
                <div style="background: #f9fafb; border-radius: 8px; padding: 16px; text-align: center;">
                    <div style="color: #666; font-size: 13px; margin-bottom: 4px;">Amount Due</div>
                    <div style="font-size: 24px; font-weight: 700; color: #111;">$${(invoice.balanceDue || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                </div>
                <p style="color: #999; font-size: 13px; text-align: center; margin-top: 16px;">
                    Or copy this link: ${portalUrl}
                </p>
            </div>
            <p style="text-align: center; color: #aaa; font-size: 12px; margin-top: 32px;">
                Sent via ProBuild • ${companyName}
            </p>
        </body>
        </html>`,
        undefined,
        { fromName: companyName, replyTo: settings?.email || undefined }
    );

    revalidatePath(`/projects/${invoice.projectId}/invoices`);
    revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    revalidatePath(`/invoices`);
    return { success: true, sentTo: recipientEmail };
}

export async function getInvoiceForPortal(id: string) {
    const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: {
            project: { include: { client: true } },
            client: true,
            payments: { orderBy: { createdAt: "asc" } },
        },
    });
    if (!invoice) return null;
    return {
        ...invoice,
        projectName: invoice.project?.name || null,
        clientName: invoice.client?.name || invoice.project?.client?.name || "Client",
        clientEmail: invoice.client?.email || invoice.project?.client?.email || null,
    };
}

export async function markInvoiceViewed(invoiceId: string) {
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: {
            viewedAt: true, code: true,
            project: { select: { name: true, client: { select: { name: true } } } },
            client: { select: { name: true } },
        },
    });
    if (invoice && !invoice.viewedAt) {
        await prisma.invoice.update({
            where: { id: invoiceId },
            data: { viewedAt: new Date() },
        });
        const clientName = invoice.client?.name || invoice.project?.client?.name || "A client";
        const projectName = invoice.project?.name || "";
        const settings = await getCompanySettings();
        if (settings.notificationEmail) {
            await sendNotification(
                settings.notificationEmail,
                `👁️ Invoice Viewed — ${invoice.code}`,
                `<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                    <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 20px;">
                        <h3 style="margin: 0 0 8px; color: #065f46;">Invoice Viewed</h3>
                        <p style="margin: 0 0 4px; color: #333;"><strong>${clientName}</strong> opened invoice <strong>${invoice.code}</strong>${projectName ? ` for ${projectName}` : ""}.</p>
                        <p style="margin: 0; color: #666; font-size: 13px;">Viewed at: ${new Date().toLocaleString()}</p>
                    </div>
                </div>`
            );
        }
    }
}

export async function saveEstimate(estimateId: string, contextId: string, contextType: "project" | "lead", data: any, items: any[]) {
    // Update estimate
    await prisma.estimate.update({
        where: { id: estimateId },
        data: {
            title: data.title,
            code: data.code,
            status: data.status,
            totalAmount: data.totalAmount,
            balanceDue: data.totalAmount,
            ...(data.processingFeeMarkup !== undefined && { processingFeeMarkup: data.processingFeeMarkup }),
            ...(data.hideProcessingFee !== undefined && { hideProcessingFee: data.hideProcessingFee }),
            ...(data.expirationDate !== undefined && { expirationDate: data.expirationDate }),
        },
    });

    // Delete existing items and schedules
    await prisma.estimateItem.deleteMany({ where: { estimateId } });
    await prisma.estimatePaymentSchedule.deleteMany({ where: { estimateId } });

    // Insert new items
    let itemOrder = 0;
    for (const item of items) {
        await prisma.estimateItem.create({
            data: {
                id: item.id || undefined,
                estimateId,
                name: item.name,
                description: item.description || "",
                type: item.type,
                quantity: parseFloat(item.quantity) || 0,
                baseCost: item.baseCost != null ? parseFloat(item.baseCost) || 0 : null,
                markupPercent: parseFloat(item.markupPercent) ?? 25,
                unitCost: parseFloat(item.unitCost) || 0,
                total: parseFloat(item.total) || 0,
                order: item.order ?? itemOrder++,
                parentId: item.parentId || null,
                costCodeId: item.costCodeId || null,
                costTypeId: item.costTypeId || null,
            },
        });
    }

    // Insert new payment schedules
    const schedules = data.paymentSchedules || [];
    let scheduleOrder = 0;
    for (const schedule of schedules) {
        await prisma.estimatePaymentSchedule.create({
            data: {
                id: schedule.id || undefined,
                estimateId,
                name: schedule.name,
                percentage: schedule.percentage ? parseFloat(schedule.percentage) : null,
                amount: parseFloat(schedule.amount) || 0,
                dueDate: schedule.dueDate ? new Date(schedule.dueDate) : null,
                order: schedule.order ?? scheduleOrder++,
            },
        });
    }

    if (data.status === 'Approved' && contextType === 'project') {
        const existingBudget = await prisma.budget.findUnique({ where: { estimateId } });
        if (!existingBudget) {
            await generateBudgetForEstimate(estimateId, contextId);
        }
    }

    if (contextType === "project") {
        revalidatePath(`/projects/${contextId}/estimates`);
        revalidatePath(`/projects/${contextId}/estimates/${estimateId}`);
    } else {
        revalidatePath(`/leads/${contextId}`);
        revalidatePath(`/leads/${contextId}/estimates/${estimateId}`);
    }
    return { success: true };
}

export async function logEstimatePayment(estimateId: string, data: { amount: number; paymentMethod: string; date: string; referenceNumber?: string }) {
    "use server";
    const estimate = await prisma.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) throw new Error("Estimate not found");

    const refNum = data.referenceNumber || `PM-${String(estimate.number).padStart(5, "0")}`;
    const scheduleCount = await prisma.estimatePaymentSchedule.count({ where: { estimateId } });

    await prisma.estimatePaymentSchedule.create({
        data: {
            estimateId,
            name: `Payment — ${data.paymentMethod} (${refNum})`,
            amount: data.amount,
            dueDate: new Date(data.date),
            order: scheduleCount,
        },
    });

    // Update balance
    const newBalance = Math.max(0, Number(estimate.balanceDue) - data.amount);
    await prisma.estimate.update({
        where: { id: estimateId },
        data: {
            balanceDue: newBalance,
            ...(newBalance === 0 ? { status: "Paid" } : {}),
        },
    });

    if (estimate.projectId) {
        revalidatePath(`/projects/${estimate.projectId}/estimates/${estimateId}`);
    }
    return { success: true };
}

export async function archiveEstimate(estimateId: string) {
    "use server";
    const estimate = await prisma.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) throw new Error("Estimate not found");

    const isArchived = !!estimate.archivedAt;
    await prisma.estimate.update({
        where: { id: estimateId },
        data: { archivedAt: isArchived ? null : new Date() },
    });

    if (estimate.projectId) {
        revalidatePath(`/projects/${estimate.projectId}/estimates`);
        revalidatePath(`/projects/${estimate.projectId}/estimates/${estimateId}`);
    }
    if (estimate.leadId) {
        revalidatePath(`/leads`);
    }
    return { success: true, archived: !isArchived };
}

export async function createInvoiceFromEstimate(estimateId: string) {
    const estimate = await prisma.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) throw new Error("Estimate not found");

    const project = await prisma.project.findUnique({ where: { id: estimate.projectId! } });
    if (!project) throw new Error("Project not found");

    const code = `INV-${Math.floor(1000 + Math.random() * 9000)}`;

    const invoice = await prisma.invoice.create({
        data: {
            code,
            projectId: estimate.projectId!,
            clientId: project.clientId,
            status: "Draft",
            totalAmount: estimate.totalAmount || 0,
            balanceDue: estimate.totalAmount || 0,
        },
    });

    const schedules = await prisma.estimatePaymentSchedule.findMany({
        where: { estimateId },
        orderBy: { order: "asc" },
    });

    if (schedules.length > 0) {
        for (const schedule of schedules) {
            await prisma.paymentSchedule.create({
                data: {
                    invoiceId: invoice.id,
                    name: schedule.name,
                    amount: schedule.amount,
                    status: "Pending",
                    dueDate: schedule.dueDate || null,
                },
            });
        }
    } else {
        await prisma.paymentSchedule.create({
            data: {
                invoiceId: invoice.id,
                name: "Initial Payment",
                amount: estimate.totalAmount || 0,
                status: "Pending",
            },
        });
    }

    revalidatePath(`/projects/${estimate.projectId}/invoices`);
    return { id: invoice.id, projectId: estimate.projectId };
}

export async function getInvoice(id: string) {
    const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: {
            project: {
                include: { client: true },
            },
            client: true,
            payments: {
                orderBy: { createdAt: "asc" },
            },
        },
    });
    return invoice;
}

export async function recordPayment(paymentId: string, invoiceId: string, timestamp: number) {
    const payment = await prisma.paymentSchedule.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status === "Paid") return { success: false };

    await prisma.paymentSchedule.update({
        where: { id: paymentId },
        data: {
            status: "Paid",
            paymentDate: new Date(timestamp),
        },
    });

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    const newBalance = Math.max(0, (invoice!.balanceDue || 0) - (payment.amount || 0));
    const newStatus = newBalance <= 0 ? "Paid" : "Partially Paid";

    await prisma.invoice.update({
        where: { id: invoiceId },
        data: { balanceDue: newBalance, status: newStatus },
    });

    revalidatePath(`/projects/${invoice!.projectId}/invoices`);
    revalidatePath(`/projects/${invoice!.projectId}/invoices/${invoiceId}`);
    revalidatePath(`/invoices`);

    return { success: true };
}

export async function getProjectInvoices(projectId: string) {
    return await prisma.invoice.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        include: { client: true },
    });
}

export async function getAllInvoices() {
    return await prisma.invoice.findMany({
        orderBy: { createdAt: "desc" },
        include: {
            project: { select: { id: true, name: true } },
            client: { select: { id: true, name: true } },
        },
    });
}

export async function issueInvoice(invoiceId: string) {
    const invoice = await prisma.invoice.update({
        where: { id: invoiceId },
        data: {
            status: "Issued",
            issueDate: new Date(),
        },
    });
    revalidatePath(`/projects/${invoice.projectId}/invoices`);
    revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    revalidatePath(`/invoices`);
    return { success: true };
}

async function generateBudgetForEstimate(estimateId: string, projectId: string) {
    const items = await prisma.estimateItem.findMany({ where: { estimateId } });

    let totalLaborBudget = 0;
    let totalMaterialBudget = 0;

    for (const item of items) {
        if (item.type === "Labor") {
            totalLaborBudget += item.total || 0;
        } else {
            totalMaterialBudget += item.total || 0;
        }
    }

    await prisma.budget.create({
        data: {
            projectId,
            estimateId,
            totalLaborBudget,
            totalMaterialBudget,
        },
    });
}


export async function getCompanySettings() {
    let settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });

    if (!settings) {
        settings = await prisma.companySettings.create({
            data: {
                id: "singleton",
                companyName: "My Construction Co.",
            },
        });
    }

    return settings;
}

export async function saveCompanySettings(data: any) {
    await prisma.companySettings.update({
        where: { id: "singleton" },
        data: {
            companyName: data.companyName,
            address: data.address,
            phone: data.phone,
            email: data.email,
            website: data.website,
            logoUrl: data.logoUrl,
            notificationEmail: data.notificationEmail,
            stripeEnabled: data.stripeEnabled,
            enableCard: data.enableCard,
            enableBankTransfer: data.enableBankTransfer,
            enableAffirm: data.enableAffirm,
            enableKlarna: data.enableKlarna,
            passProcessingFee: data.passProcessingFee,
            cardProcessingRate: data.cardProcessingRate !== undefined ? parseFloat(data.cardProcessingRate) : undefined,
            cardProcessingFlat: data.cardProcessingFlat !== undefined ? parseFloat(data.cardProcessingFlat) : undefined,
        },
    });

    revalidatePath("/settings/company");
    revalidatePath("/portal");
    return { success: true };
}

export async function deleteEstimate(estimateId: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { projectId: true, leadId: true },
    });
    if (!estimate) return { success: false, error: "Estimate not found" };

    // Delete related Budget
    const budget = await prisma.budget.findUnique({ where: { estimateId } });
    if (budget) {
        await prisma.budget.delete({ where: { id: budget.id } });
    }

    // Delete related items, schedules, expenses, and the estimate itself
    await prisma.estimateItem.deleteMany({ where: { estimateId } });
    await prisma.estimatePaymentSchedule.deleteMany({ where: { estimateId } });
    await prisma.expense.deleteMany({ where: { estimateId } });
    await prisma.estimate.delete({ where: { id: estimateId } });

    if (estimate.projectId) {
        revalidatePath(`/projects/${estimate.projectId}/estimates`);
    } else if (estimate.leadId) {
        revalidatePath(`/leads/${estimate.leadId}`);
    } else {
        revalidatePath("/projects/all/estimates");
    }
    return { success: true };
}

// =============================================
// Duplicate Estimate
// =============================================

export async function duplicateEstimate(estimateId: string) {
    const original = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
            items: { orderBy: { order: "asc" } },
            paymentSchedules: { orderBy: { order: "asc" } },
        },
    });
    if (!original) throw new Error("Estimate not found");

    const code = `EST-${Math.floor(1000 + Math.random() * 9000)}`;

    const newEstimate = await prisma.estimate.create({
        data: {
            title: `Copy of ${original.title}`,
            projectId: original.projectId,
            leadId: original.leadId,
            code,
            status: "Draft",
            totalAmount: original.totalAmount,
            balanceDue: original.totalAmount,
            privacy: original.privacy,
        },
    });

    // Build old-to-new ID mapping for parentId references
    const idMap: Record<string, string> = {};

    for (const item of original.items) {
        const newItem = await prisma.estimateItem.create({
            data: {
                estimateId: newEstimate.id,
                name: item.name,
                description: item.description || "",
                type: item.type,
                quantity: item.quantity,
                baseCost: item.baseCost,
                markupPercent: item.markupPercent,
                unitCost: item.unitCost,
                total: item.total,
                order: item.order,
                costCodeId: item.costCodeId,
                costTypeId: item.costTypeId,
                // parentId mapped below
            },
        });
        idMap[item.id] = newItem.id;
    }

    // Fix parentId references
    for (const item of original.items) {
        if (item.parentId && idMap[item.parentId]) {
            await prisma.estimateItem.update({
                where: { id: idMap[item.id] },
                data: { parentId: idMap[item.parentId] },
            });
        }
    }

    for (const schedule of original.paymentSchedules) {
        await prisma.estimatePaymentSchedule.create({
            data: {
                estimateId: newEstimate.id,
                name: schedule.name,
                percentage: schedule.percentage,
                amount: schedule.amount,
                dueDate: schedule.dueDate,
                order: schedule.order,
            },
        });
    }

    if (original.projectId) {
        revalidatePath(`/projects/${original.projectId}/estimates`);
    } else if (original.leadId) {
        revalidatePath(`/leads/${original.leadId}`);
    }
    revalidatePath("/estimates");

    return { id: newEstimate.id, projectId: original.projectId, leadId: original.leadId };
}

// =============================================
// Estimate Templates
// =============================================

export async function saveEstimateAsTemplate(estimateId: string, templateName: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: { items: { orderBy: { order: "asc" } } },
    });
    if (!estimate) throw new Error("Estimate not found");

    const template = await prisma.estimateTemplate.create({
        data: {
            name: templateName,
            items: {
                create: estimate.items.map((item) => ({
                    name: item.name,
                    description: item.description || "",
                    type: item.type,
                    quantity: item.quantity,
                    baseCost: item.baseCost,
                    markupPercent: item.markupPercent,
                    unitCost: item.unitCost,
                    order: item.order,
                    parentId: item.parentId,
                    costCodeId: item.costCodeId,
                    costTypeId: item.costTypeId,
                })),
            },
        },
    });

    return { id: template.id, name: template.name };
}

export async function getEstimateTemplates() {
    return await prisma.estimateTemplate.findMany({
        orderBy: { createdAt: "desc" },
        include: { items: { orderBy: { order: "asc" } } },
    });
}

export async function createEstimateFromTemplate(projectId: string, templateId: string) {
    const template = await prisma.estimateTemplate.findUnique({
        where: { id: templateId },
        include: { items: { orderBy: { order: "asc" } } },
    });
    if (!template) throw new Error("Template not found");

    const code = `EST-${Math.floor(1000 + Math.random() * 9000)}`;

    const estimate = await prisma.estimate.create({
        data: {
            title: template.name,
            projectId,
            code,
            status: "Draft",
            totalAmount: 0,
            balanceDue: 0,
            privacy: "Shared",
        },
    });

    for (const item of template.items) {
        await prisma.estimateItem.create({
            data: {
                estimateId: estimate.id,
                name: item.name,
                description: item.description || "",
                type: item.type,
                quantity: item.quantity,
                baseCost: item.baseCost,
                markupPercent: item.markupPercent,
                unitCost: item.unitCost,
                total: (item.quantity || 0) * (item.unitCost || 0),
                order: item.order,
                parentId: item.parentId,
                costCodeId: item.costCodeId,
                costTypeId: item.costTypeId,
            },
        });
    }

    revalidatePath(`/projects/${projectId}/estimates`);
    return { id: estimate.id };
}

// =============================================
// Document Templates CRUD
// =============================================

export async function getDocumentTemplates() {
    return await prisma.documentTemplate.findMany({
        orderBy: { updatedAt: "desc" },
    });
}

export async function getDocumentTemplate(id: string) {
    return await prisma.documentTemplate.findUnique({ where: { id } });
}

export async function createDocumentTemplate(data: { name: string; type: string; body: string; isDefault?: boolean }) {
    // If setting as default, unset all other defaults of same type
    if (data.isDefault) {
        await prisma.documentTemplate.updateMany({
            where: { type: data.type, isDefault: true },
            data: { isDefault: false }
        });
    }
    const template = await prisma.documentTemplate.create({ data });
    revalidatePath("/company/templates");
    return template;
}

export async function updateDocumentTemplate(id: string, data: { name?: string; type?: string; body?: string; isDefault?: boolean }) {
    if (data.isDefault) {
        const existing = await prisma.documentTemplate.findUnique({ where: { id } });
        if (existing) {
            await prisma.documentTemplate.updateMany({
                where: { type: data.type || existing.type, isDefault: true, NOT: { id } },
                data: { isDefault: false }
            });
        }
    }
    const template = await prisma.documentTemplate.update({ where: { id }, data });
    revalidatePath("/company/templates");
    return template;
}

export async function deleteDocumentTemplate(id: string) {
    await prisma.documentTemplate.delete({ where: { id } });
    revalidatePath("/company/templates");
    return { success: true };
}

// =============================================
// Send Estimate to Client
// =============================================

export async function sendEstimateToClient(estimateId: string, templateId?: string, overrideEmail?: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
            project: { include: { client: true } },
            lead: { include: { client: true } },
        }
    });

    if (!estimate) throw new Error("Estimate not found");

    const client = estimate.project?.client || estimate.lead?.client;
    const recipientEmail = overrideEmail || client?.email;
    if (!recipientEmail) throw new Error("No email address provided");

    // Snapshot T&C if a template is selected
    let termsHtml: string | null = null;
    if (templateId) {
        const template = await prisma.documentTemplate.findUnique({ where: { id: templateId } });
        if (template) termsHtml = template.body;
    } else {
        // Try to use the default terms template
        const defaultTemplate = await prisma.documentTemplate.findFirst({
            where: { type: "terms", isDefault: true }
        });
        if (defaultTemplate) termsHtml = defaultTemplate.body;
    }

    // Update estimate with T&C snapshot and sent timestamp
    await prisma.estimate.update({
        where: { id: estimateId },
        data: {
            termsAndConditions: termsHtml,
            sentAt: new Date(),
            status: "Sent"
        }
    });

    // Send email notification to client
    const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/portal/estimates/${estimateId}`;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

    await sendNotification(
        recipientEmail,
        `${companyName} sent you an estimate`,
        `<!DOCTYPE html>
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
            </div>
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">New Estimate for You</h2>
                <p style="color: #666; margin: 0 0 24px;">Hi ${client?.name || 'there'},</p>
                <p style="color: #666; line-height: 1.6;">
                    ${companyName} has sent you an estimate for review and approval.
                    Please click the button below to view the details, terms and conditions, and approve if you'd like to proceed.
                </p>
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${portalUrl}" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        View & Sign Estimate
                    </a>
                </div>
                <p style="color: #999; font-size: 13px; text-align: center;">
                    Or copy this link: ${portalUrl}
                </p>
            </div>
            <p style="text-align: center; color: #aaa; font-size: 12px; margin-top: 32px;">
                Sent via ProBuild • ${companyName}
            </p>
        </body>
        </html>`,
        undefined,
        { fromName: companyName, replyTo: settings?.email || undefined }
    );

    // Revalidate paths
    if (estimate.projectId) revalidatePath(`/projects/${estimate.projectId}/estimates`);
    if (estimate.leadId) revalidatePath(`/leads/${estimate.leadId}`);
    revalidatePath("/projects/all/estimates");

    return { success: true, sentTo: recipientEmail };
}

// ────────────────────────────────────────────────
// Contracts
// ────────────────────────────────────────────────

function resolveMergeFields(template: string, data: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] || match);
}

async function buildMergeData(projectId?: string | null, leadId?: string | null): Promise<Record<string, string>> {
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const data: Record<string, string> = {
        company_name: settings?.companyName || "Our Company",
        company_address: settings?.address || "",
        company_phone: settings?.phone || "",
        company_email: settings?.email || "",
        date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
        year: new Date().getFullYear().toString(),
    };

    if (projectId) {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: { client: true, estimates: { orderBy: { createdAt: "desc" }, take: 1 } }
        });
        if (project) {
            data.project_name = project.name;
            data.client_name = project.client.name;
            data.client_email = project.client.email || "";
            data.client_phone = project.client.primaryPhone || "";
            data.client_address = [project.client.addressLine1, project.client.city, project.client.state, project.client.zipCode].filter(Boolean).join(", ");
            data.location = project.location || "";
            data.estimate_total = project.estimates[0] ? `$${project.estimates[0].totalAmount.toLocaleString()}` : "$0.00";
        }
    } else if (leadId) {
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            include: { client: true, estimates: { orderBy: { createdAt: "desc" }, take: 1 } }
        });
        if (lead) {
            data.project_name = lead.name;
            data.client_name = lead.client.name;
            data.client_email = lead.client.email || "";
            data.client_phone = lead.client.primaryPhone || "";
            data.client_address = [lead.client.addressLine1, lead.client.city, lead.client.state, lead.client.zipCode].filter(Boolean).join(", ");
            data.location = lead.location || "";
            data.estimate_total = lead.estimates[0] ? `$${lead.estimates[0].totalAmount.toLocaleString()}` : "$0.00";
        }
    }

    return data;
}

export async function getContracts(projectId?: string, leadId?: string) {
    return prisma.contract.findMany({
        where: {
            ...(projectId ? { projectId } : {}),
            ...(leadId ? { leadId } : {}),
        },
        orderBy: { createdAt: "desc" },
        include: {
            project: { select: { name: true, client: { select: { name: true } } } },
            lead: { select: { name: true, client: { select: { name: true } } } },
        }
    });
}

export async function getContract(id: string) {
    return prisma.contract.findUnique({
        where: { id },
        include: {
            project: { include: { client: true } },
            lead: { include: { client: true } },
        }
    });
}

export async function createContractFromTemplate(
    templateId: string,
    context: { type: "project" | "lead"; id: string },
    titleOverride?: string,
    recurringDays?: number
) {
    const template = await prisma.documentTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new Error("Template not found");

    const mergeData = await buildMergeData(
        context.type === "project" ? context.id : null,
        context.type === "lead" ? context.id : null
    );

    const resolvedBody = resolveMergeFields(template.body, mergeData);

    const contract = await prisma.contract.create({
        data: {
            title: titleOverride || template.name,
            body: resolvedBody,
            ...(context.type === "project" ? { projectId: context.id } : { leadId: context.id }),
            ...(recurringDays && recurringDays > 0 ? {
                recurringDays,
                nextDueDate: new Date(Date.now() + recurringDays * 86400000),
            } : {}),
        }
    });

    if (context.type === "project") revalidatePath(`/projects/${context.id}`);
    if (context.type === "lead") revalidatePath(`/leads/${context.id}`);

    return contract;
}

export async function createContractBlank(
    context: { type: "project" | "lead"; id: string },
    title: string,
    body: string
) {
    const mergeData = await buildMergeData(
        context.type === "project" ? context.id : null,
        context.type === "lead" ? context.id : null
    );

    const resolvedBody = resolveMergeFields(body, mergeData);

    const contract = await prisma.contract.create({
        data: {
            title,
            body: resolvedBody,
            ...(context.type === "project" ? { projectId: context.id } : { leadId: context.id }),
        }
    });

    if (context.type === "project") revalidatePath(`/projects/${context.id}`);
    if (context.type === "lead") revalidatePath(`/leads/${context.id}`);

    return contract;
}

export async function updateContract(id: string, data: { title?: string; body?: string; status?: string }) {
    const contract = await prisma.contract.update({ where: { id }, data });
    revalidatePath(`/`);
    return contract;
}

export async function deleteContract(id: string) {
    const contract = await prisma.contract.findUnique({ where: { id } });
    await prisma.contract.delete({ where: { id } });
    if (contract?.projectId) revalidatePath(`/projects/${contract.projectId}`);
    if (contract?.leadId) revalidatePath(`/leads/${contract.leadId}`);
}

export async function sendContractToClient(contractId: string) {
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        include: {
            project: { include: { client: true } },
            lead: { include: { client: true } },
        }
    });

    if (!contract) throw new Error("Contract not found");
    const client = contract.project?.client || contract.lead?.client;
    if (!client?.email) throw new Error("Client has no email address");

    await prisma.contract.update({
        where: { id: contractId },
        data: { status: "Sent", sentAt: new Date() }
    });

    const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/portal/contracts/${contractId}`;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

    await sendNotification(
        client.email,
        `${companyName} sent you a contract to review`,
        `<!DOCTYPE html>
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
            </div>
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">Contract Ready for Your Signature</h2>
                <p style="color: #666; margin: 0 0 24px;">Hi ${client.name},</p>
                <p style="color: #666; line-height: 1.6;">
                    ${companyName} has sent you a contract titled "<strong>${contract.title}</strong>" for your review and signature.
                    Please click the button below to read the agreement and sign electronically.
                </p>
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${portalUrl}" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        Review & Sign Contract
                    </a>
                </div>
                <p style="color: #999; font-size: 13px; margin: 0;">If you have any questions, reply to this email or contact us directly.</p>
            </div>
        </body>
        </html>`
    );

    if (contract.projectId) revalidatePath(`/projects/${contract.projectId}`);
    if (contract.leadId) revalidatePath(`/leads/${contract.leadId}`);

    return { success: true, sentTo: client.email };
}

export async function approveContract(contractId: string, signatureName: string, ipAddress: string, userAgent: string, signatureDataUrl?: string) {
    // Fetch the contract first to get recurring info
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        include: { project: true, lead: true }
    });
    if (!contract) throw new Error("Contract not found");

    const now = new Date();

    // Always save a signing record for historical audit
    await prisma.contractSigningRecord.create({
        data: {
            contractId,
            signedBy: signatureName,
            signedAt: now,
            signatureUrl: signatureDataUrl || null,
            ipAddress,
            userAgent,
            periodStart: contract.nextDueDate
                ? new Date(contract.nextDueDate.getTime() - (contract.recurringDays || 30) * 86400000)
                : contract.sentAt || contract.createdAt,
            periodEnd: now,
        }
    });

    if (contract.recurringDays && contract.recurringDays > 0) {
        // Recurring contract: save the signature, then reset for next cycle
        const nextDue = new Date(now.getTime() + contract.recurringDays * 86400000);
        await prisma.contract.update({
            where: { id: contractId },
            data: {
                approvedBy: signatureName,
                approvedAt: now,
                approvalIp: ipAddress,
                approvalUserAgent: userAgent,
                signatureUrl: signatureDataUrl || null,
                status: "Sent", // Reset to Sent so it can be signed again next cycle
                viewedAt: null,
                nextDueDate: nextDue,
            }
        });
    } else {
        // One-time contract: mark as signed permanently
        await prisma.contract.update({
            where: { id: contractId },
            data: {
                status: "Signed",
                approvedBy: signatureName,
                approvedAt: now,
                approvalIp: ipAddress,
                approvalUserAgent: userAgent,
                signatureUrl: signatureDataUrl || null,
            }
        });
    }

    const settings = await getCompanySettings();
    if (settings.notificationEmail) {
        const isRecurring = contract.recurringDays && contract.recurringDays > 0;
        await sendNotification(
            settings.notificationEmail,
            `Contract "${contract.title}" has been signed!`,
            `<p>The contract "<strong>${contract.title}</strong>" has been electronically signed by <strong>${signatureName}</strong> on ${now.toLocaleString()}.</p>
            ${isRecurring ? `<p style="color: #666; font-size: 0.9em;">This is a recurring document (every ${contract.recurringDays} days). The next signing will be due on <strong>${new Date(now.getTime() + contract.recurringDays! * 86400000).toLocaleDateString()}</strong>.</p>` : ""}`
        );
    }

    revalidatePath("/");
    return { success: true };
}

export async function getContractSigningHistory(contractId: string) {
    return await prisma.contractSigningRecord.findMany({
        where: { contractId },
        orderBy: { signedAt: "desc" },
    });
}

// ────────────────────────────────────────────────
// Schedule Tasks
// ────────────────────────────────────────────────

export async function getScheduleTasks(projectId: string) {
    return prisma.scheduleTask.findMany({
        where: { projectId },
        orderBy: { order: "asc" },
        include: {
            children: true,
            dependencies: { include: { predecessor: true } },
            dependents: { include: { dependent: true } },
            timeEntries: { select: { durationHours: true } },
            assignments: { include: { user: { select: { id: true, name: true, email: true } } } },
            subAssignments: { include: { subcontractor: true } },
            estimateItem: { select: { id: true, name: true, type: true, total: true, estimateId: true } },
        },
    });
}

export async function getEstimateItemsForProject(projectId: string) {
    return prisma.estimateItem.findMany({
        where: { estimate: { projectId }, parentId: null },
        orderBy: { order: "asc" },
        select: { id: true, name: true, type: true, total: true, estimateId: true },
    });
}

export async function getScheduleTasksForSub(projectId: string, subcontractorId: string) {
    return prisma.scheduleTask.findMany({
        where: {
            projectId,
            subAssignments: { some: { subcontractorId } },
        },
        orderBy: { order: "asc" },
        include: {
            dependencies: true,
            comments: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } },
            timeEntries: { select: { durationHours: true } },
            assignments: { include: { user: { select: { id: true, name: true, email: true } } } },
            subAssignments: { include: { subcontractor: true } },
            estimateItem: { select: { id: true, name: true, type: true, total: true, estimateId: true } },
        },
    });
}

export async function addTaskCommentAsSub(taskId: string, subcontractorId: string, text: string) {
    const sub = await prisma.subcontractor.findUnique({ where: { id: subcontractorId }, select: { companyName: true, contactName: true } });
    const displayName = sub?.contactName || sub?.companyName || "Subcontractor";
    const comment = await prisma.taskComment.create({
        data: { taskId, userId: null, text, subcontractorName: displayName },
    });
    revalidatePath(`/projects`);
    return comment;
}

export async function updateTaskStatusAsSub(taskId: string, subcontractorId: string, status: string) {
    const allowed = ["In Progress", "Complete"];
    if (!allowed.includes(status)) throw new Error("Invalid status");
    const assignment = await prisma.subTaskAssignment.findUnique({
        where: { subcontractorId_taskId: { subcontractorId, taskId } },
    });
    if (!assignment) throw new Error("Not assigned to this task");
    const task = await prisma.scheduleTask.update({
        where: { id: taskId },
        data: { status },
    });
    revalidatePath(`/projects`);
    return task;
}

export async function createScheduleTask(projectId: string, data: {
    name: string;
    startDate: string;
    endDate: string;
    color?: string;
    status?: string;
    assignee?: string;
    parentId?: string;
    type?: string;
}) {
    const maxOrder = await prisma.scheduleTask.aggregate({
        where: { projectId },
        _max: { order: true },
    });
    const isMilestone = data.type === "milestone";
    const task = await prisma.scheduleTask.create({
        data: {
            projectId,
            name: data.name,
            startDate: new Date(data.startDate),
            endDate: isMilestone ? new Date(data.startDate) : new Date(data.endDate),
            color: data.color || "#4c9a2a",
            status: data.status || "Not Started",
            assignee: data.assignee || null,
            parentId: data.parentId || null,
            order: (maxOrder._max.order ?? -1) + 1,
            type: data.type || "task",
        },
    });
    revalidatePath(`/projects/${projectId}/schedule`);
    return task;
}

export async function updateScheduleTask(taskId: string, data: {
    name?: string;
    startDate?: string;
    endDate?: string;
    color?: string;
    progress?: number;
    status?: string;
    assignee?: string;
    order?: number;
    estimatedHours?: number | null;
    type?: string;
    estimateItemId?: string | null;
}) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.startDate !== undefined) updateData.startDate = new Date(data.startDate);
    if (data.endDate !== undefined) updateData.endDate = new Date(data.endDate);
    if (data.color !== undefined) updateData.color = data.color;
    if (data.progress !== undefined) updateData.progress = data.progress;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.assignee !== undefined) updateData.assignee = data.assignee;
    if (data.order !== undefined) updateData.order = data.order;
    if (data.estimatedHours !== undefined) updateData.estimatedHours = data.estimatedHours;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.estimateItemId !== undefined) updateData.estimateItemId = data.estimateItemId;
    // Milestones always have same start and end date
    if (data.type === "milestone" && updateData.startDate) {
        updateData.endDate = updateData.startDate;
    }

    const task = await prisma.scheduleTask.update({
        where: { id: taskId },
        data: updateData,
    });
    revalidatePath(`/projects/${task.projectId}/schedule`);
    return task;
}

export async function deleteScheduleTask(taskId: string) {
    const task = await prisma.scheduleTask.delete({ where: { id: taskId } });
    revalidatePath(`/projects/${task.projectId}/schedule`);
    return task;
}

export async function linkTasks(predecessorId: string, dependentId: string) {
    const dep = await prisma.taskDependency.create({
        data: { predecessorId, dependentId },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: predecessorId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
    return dep;
}

export async function unlinkTasks(predecessorId: string, dependentId: string) {
    await prisma.taskDependency.deleteMany({
        where: { predecessorId, dependentId },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: predecessorId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
}

export async function importEstimateToSchedule(projectId: string, estimateId: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
            items: {
                where: { parentId: null },
                orderBy: { order: "asc" },
                include: {
                    subItems: { orderBy: { order: "asc" } },
                },
            },
        },
    });
    if (!estimate || estimate.items.length === 0) return [];

    const maxOrder = await prisma.scheduleTask.aggregate({
        where: { projectId },
        _max: { order: true },
    });
    let order = (maxOrder._max.order ?? -1) + 1;

    const TYPE_COLORS: Record<string, string> = {
        Material: "#3b82f6",
        Labor: "#f59e0b",
        Subcontractor: "#8b5cf6",
    };

    const today = new Date();
    const created = [];
    let dayOffset = 0;

    for (const item of estimate.items) {
        // Calculate estimated hours from labor items
        let estimatedHours: number | null = null;
        if (item.type === "Labor") {
            // Top-level is labor — use its quantity as hours
            estimatedHours = item.quantity || null;
        } else if (item.subItems && item.subItems.length > 0) {
            // Parent group — sum labor sub-item quantities as hours
            const laborHours = item.subItems
                .filter((si: any) => si.type === "Labor")
                .reduce((sum: number, si: any) => sum + (si.quantity || 0), 0);
            if (laborHours > 0) estimatedHours = laborHours;
        }

        const duration = item.type === "Labor" ? 7 : item.type === "Subcontractor" ? 10 : 5;
        const startDate = new Date(today.getTime() + dayOffset * 86400000);
        const endDate = new Date(today.getTime() + (dayOffset + duration) * 86400000);
        dayOffset += Math.ceil(duration * 0.7);

        const task = await prisma.scheduleTask.create({
            data: {
                projectId,
                name: item.name,
                startDate,
                endDate,
                color: TYPE_COLORS[item.type] || "#4c9a2a",
                order: order++,
                status: "Not Started",
                estimatedHours,
                estimateItemId: item.id,
            },
        });
        created.push(task);
    }

    revalidatePath(`/projects/${projectId}/schedule`);
    return created;
}


// ========== TASK COMMENTS ==========

export async function addTaskComment(taskId: string, userId: string, text: string) {
    const comment = await prisma.taskComment.create({
        data: { taskId, userId, text },
        include: { user: { select: { id: true, name: true, email: true } } },
    });
    return comment;
}

export async function getTaskComments(taskId: string) {
    return prisma.taskComment.findMany({
        where: { taskId },
        orderBy: { createdAt: "asc" },
        include: { user: { select: { id: true, name: true, email: true } } },
    });
}

// ========== PUNCH LIST ==========

export async function addTaskPunchItem(taskId: string, name: string) {
    const maxOrder = await prisma.taskPunchItem.aggregate({
        where: { taskId },
        _max: { order: true },
    });
    return prisma.taskPunchItem.create({
        data: { taskId, name, order: (maxOrder._max.order ?? -1) + 1 },
    });
}

export async function togglePunchItem(id: string) {
    const item = await prisma.taskPunchItem.findUnique({ where: { id } });
    if (!item) return null;
    return prisma.taskPunchItem.update({
        where: { id },
        data: { completed: !item.completed },
    });
}

export async function deletePunchItem(id: string) {
    return prisma.taskPunchItem.delete({ where: { id } });
}

export async function getTaskPunchItems(taskId: string) {
    return prisma.taskPunchItem.findMany({
        where: { taskId },
        orderBy: { order: "asc" },
    });
}

// ========== TASK ASSIGNMENTS ==========

export async function assignUserToTask(taskId: string, userId: string) {
    const assignment = await prisma.taskAssignment.create({
        data: { taskId, userId },
        include: { user: { select: { id: true, name: true, email: true } } },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: taskId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
    return assignment;
}

export async function unassignUserFromTask(taskId: string, userId: string) {
    await prisma.taskAssignment.deleteMany({
        where: { taskId, userId },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: taskId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
}

export async function assignSubToTask(taskId: string, subcontractorId: string) {
    const assignment = await prisma.subTaskAssignment.create({
        data: { taskId, subcontractorId },
        include: { subcontractor: { select: { id: true, companyName: true, email: true, trade: true } } },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: taskId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
    return assignment;
}

export async function unassignSubFromTask(taskId: string, subcontractorId: string) {
    await prisma.subTaskAssignment.deleteMany({
        where: { taskId, subcontractorId },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: taskId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
}

// ========== AI PUNCHLIST ==========

export async function aiGeneratePunchlist(taskId: string) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const task = await prisma.scheduleTask.findUnique({
        where: { id: taskId },
        include: { project: true },
    });
    if (!task) throw new Error("Task not found");

    const prompt = `You are an expert construction project manager. Generate a detailed punch list for this construction task.

TASK: "${task.name}"
PROJECT: "${task.project.name}"
PROJECT TYPE: ${task.project.type || "General Construction"}

Generate 5-10 specific, actionable punch list items that a foreman would check before marking this task complete. Be specific to the trade and scope of work.

Return ONLY a JSON array of strings, nothing else. Each string is one punch list item.
Example: ["Check all outlets for proper voltage", "Verify GFCI protection in wet areas"]`;

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
            }),
        }
    );

    const data = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error("No AI response");

    let items: string[] = JSON.parse(rawText);
    if (!Array.isArray(items)) throw new Error("Invalid AI response");

    const maxOrder = await prisma.taskPunchItem.aggregate({
        where: { taskId },
        _max: { order: true },
    });
    let order = (maxOrder._max.order ?? -1) + 1;

    const created = [];
    for (const name of items) {
        const item = await prisma.taskPunchItem.create({
            data: { taskId, name, order: order++ },
        });
        created.push(item);
    }
    return created;
}

export async function aiGenerateSchedule(projectId: string, estimateId?: string) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error("Project not found");

    let estimateContext = "";
    if (estimateId) {
        const estimate = await prisma.estimate.findUnique({
            where: { id: estimateId },
            include: { items: { where: { parentId: null }, orderBy: { order: "asc" }, include: { subItems: true } } },
        });
        if (estimate) {
            estimateContext = `\n\nESTIMATE LINE ITEMS:\n${estimate.items.map(i => {
                const laborHrs = i.subItems?.filter((s: any) => s.type === "Labor").reduce((a: number, s: any) => a + (s.quantity || 0), 0) || (i.type === "Labor" ? i.quantity : 0);
                return `- ${i.name} (Type: ${i.type}, Labor Hours: ${laborHrs || "N/A"})`;
            }).join("\n")}`;
        }
    }

    const prompt = `You are an expert construction project manager. Generate a realistic schedule for this project.

PROJECT: "${project.name}"
TYPE: ${project.type || "General Remodeling"}${estimateContext}

Generate 8-15 construction tasks in logical order with realistic durations and dependencies. Each task should have a name, duration in days, estimated labor hours, and which tasks it depends on (by index, 0-based).

Return ONLY a JSON array with objects like:
[{"name":"Demo & Site Prep","durationDays":5,"estimatedHours":40,"dependsOn":[]},{"name":"Framing","durationDays":7,"estimatedHours":56,"dependsOn":[0]}]

Rules:
- Use real construction phases appropriate for the project type
- Duration should be realistic working days
- EstimatedHours = labor hours only
- Dependencies reference previous task indexes (0-based)
- The first task has no dependencies`;

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
            }),
        }
    );

    const data = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error("No AI response");

    const aiTasks: { name: string; durationDays: number; estimatedHours: number; dependsOn: number[] }[] = JSON.parse(rawText);
    if (!Array.isArray(aiTasks)) throw new Error("Invalid AI response");

    const maxOrder = await prisma.scheduleTask.aggregate({ where: { projectId }, _max: { order: true } });
    let order = (maxOrder._max.order ?? -1) + 1;

    const COLORS = ["#4c9a2a", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#ec4899", "#06b6d4", "#64748b"];
    const today = new Date();
    const createdIds: string[] = [];
    const created = [];
    let dayOffset = 0;

    for (let i = 0; i < aiTasks.length; i++) {
        const t = aiTasks[i];
        const startDate = new Date(today.getTime() + dayOffset * 86400000);
        const endDate = new Date(today.getTime() + (dayOffset + (t.durationDays || 5)) * 86400000);
        dayOffset += Math.ceil((t.durationDays || 5) * 0.7);

        const task = await prisma.scheduleTask.create({
            data: {
                projectId,
                name: t.name,
                startDate,
                endDate,
                color: COLORS[i % COLORS.length],
                order: order++,
                status: "Not Started",
                estimatedHours: t.estimatedHours || null,
            },
        });
        createdIds.push(task.id);
        created.push(task);
    }

    // Create dependencies
    for (let i = 0; i < aiTasks.length; i++) {
        for (const depIdx of (aiTasks[i].dependsOn || [])) {
            if (depIdx >= 0 && depIdx < createdIds.length && depIdx !== i) {
                await prisma.taskDependency.create({
                    data: { predecessorId: createdIds[depIdx], dependentId: createdIds[i] },
                });
            }
        }
    }

    revalidatePath(`/projects/${projectId}/schedule`);
    return created;
}

// ========== MASTER SCHEDULE ==========

export async function getAllScheduleTasks() {
    return prisma.scheduleTask.findMany({
        orderBy: [{ projectId: "asc" }, { order: "asc" }],
        include: {
            project: { select: { id: true, name: true, type: true, status: true } },
            assignments: {
                include: { user: { select: { id: true, name: true, email: true } } },
            },
            timeEntries: { select: { durationHours: true } },
        },
    });
}

export async function getTeamMembers() {
    return prisma.user.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, email: true, role: true },
    });
}

export async function clearAllTasks(projectId: string) {
    // Delete all related data first (dependencies, comments, punch items, assignments)
    const taskIds = (await prisma.scheduleTask.findMany({ where: { projectId }, select: { id: true } })).map(t => t.id);
    if (taskIds.length === 0) return;
    await prisma.taskAssignment.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.taskComment.deleteMany({ where: { taskId: { in: taskIds } } });
    revalidatePath(`/projects/${projectId}/schedule`);
}

export async function getActiveSubcontractors() {
    return prisma.subcontractor.findMany({
        where: { status: "ACTIVE" },
        orderBy: { companyName: "asc" },
        select: { id: true, companyName: true, email: true, trade: true }
    });
}

// ========== PROJECT BOARD ACTIONS ==========

export async function updateProjectStatus(projectId: string, status: string) {
    await prisma.project.update({
        where: { id: projectId },
        data: { status }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`);
    return { success: true };
}

export async function updateProjectColor(projectId: string, color: string) {
    await prisma.project.update({
        where: { id: projectId },
        data: { color }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`);
    return { success: true };
}

export async function updateProjectTags(projectId: string, tags: string) {
    await prisma.project.update({
        where: { id: projectId },
        data: { tags }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`);
    return { success: true };
}

export async function updateProjectName(projectId: string, name: string) {
    await prisma.project.update({
        where: { id: projectId },
        data: { name }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`, 'layout');
    return { success: true };
}

export async function deleteProjects(projectIds: string[]) {
    await prisma.project.deleteMany({
        where: { id: { in: projectIds } }
    });
    revalidatePath(`/projects`);
    return { success: true };
}

export async function updateCompanyProjectStatuses(statuses: string) {
    await prisma.companySettings.update({
        where: { id: "singleton" },
        data: { projectStatuses: statuses }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/settings/company`);
    return { success: true };
}

// ────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────

export async function getProjectMessages(projectId: string) {
    let thread = await prisma.messageThread.findFirst({
        where: { projectId, subcontractorId: null },
        include: {
            messages: { orderBy: { createdAt: "asc" } },
        },
    });

    if (!thread) {
        thread = await prisma.messageThread.create({
            data: { projectId, subcontractorId: null },
            include: {
                messages: { orderBy: { createdAt: "asc" } },
            },
        });
    }

    return thread;
}

export async function getUnreadMessageCount(projectId: string, forSenderType: "CLIENT" | "TEAM") {
    // Count messages sent by the OTHER party that haven't been read
    const oppositeType = forSenderType === "TEAM" ? "CLIENT" : "TEAM";

    const thread = await prisma.messageThread.findFirst({
        where: { projectId, subcontractorId: null },
    });

    if (!thread) return 0;

    return prisma.message.count({
        where: {
            threadId: thread.id,
            senderType: oppositeType,
            readAt: null,
        },
    });
}





export async function getPortalVisibility(projectId: string) {
    const record = await prisma.portalVisibility.findUnique({
        where: { projectId },
    });
    // Return defaults if no record exists
    if (!record) {
        return {
            id: 'default',
            projectId,
            showSchedule: true,
            showFiles: true,
            showDailyLogs: false,
            showEstimates: true,
            showInvoices: true,
            showContracts: true,
            showMessages: true,
            showChangeOrders: true,
            showSelections: true,
            showMoodBoards: true,
            isPortalEnabled: true,
            lastSharedAt: null,
            lastShareEmailId: null,
            lastShareEmailStatus: null,
        };
    }
    return record;
}

export async function savePortalVisibility(projectId: string, data: {
    showSchedule: boolean;
    showFiles: boolean;
    showDailyLogs: boolean;
    showEstimates: boolean;
    showInvoices: boolean;
    showContracts: boolean;
    showMessages: boolean;
    showSelections?: boolean;
    showMoodBoards?: boolean;
    isPortalEnabled: boolean;
}) {
    const record = await prisma.portalVisibility.upsert({
        where: { projectId },
        update: {
            showSchedule: data.showSchedule,
            showFiles: data.showFiles,
            showDailyLogs: data.showDailyLogs,
            showEstimates: data.showEstimates,
            showInvoices: data.showInvoices,
            showContracts: data.showContracts,
            showMessages: data.showMessages,
            showSelections: data.showSelections ?? true,
            showMoodBoards: data.showMoodBoards ?? true,
            isPortalEnabled: data.isPortalEnabled,
        },
        create: {
            projectId,
            showSchedule: data.showSchedule,
            showFiles: data.showFiles,
            showDailyLogs: data.showDailyLogs,
            showEstimates: data.showEstimates,
            showInvoices: data.showInvoices,
            showContracts: data.showContracts,
            showMessages: data.showMessages,
            showSelections: data.showSelections ?? true,
            showMoodBoards: data.showMoodBoards ?? true,
            isPortalEnabled: data.isPortalEnabled,
        },
    });
    revalidatePath(`/projects/${projectId}/settings`);
    revalidatePath(`/portal/projects/${projectId}`);
    return { success: true };
}

// =============================================
// Portal Dashboard Shared Actions
// =============================================

export async function emailPortalLinkToClient(projectId: string) {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { client: true }
    });
    
    if (!project || !project.client.email) {
        return { success: false, error: "Client email not found on project." };
    }
    
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const portalUrl = `${appUrl}/portal/projects/${projectId}`;
    
    // Send email using our enhanced library fn
    const { sendNotification } = await import('@/lib/email');
    const result = await sendNotification(
        project.client.email,
        `Your Dashboard for ${project.name} is Ready`,
        `<p>Hi ${project.client.name},</p><p>We have updated the portal for your project: <strong>${project.name}</strong>.</p><p><a href="${portalUrl}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:white;text-decoration:none;border-radius:5px;">Access Your Client Dashboard</a></p><p>From here you can view estimates, invoices, updates, and more.</p><br/>Thanks,<br/>Golden Touch Remodeling`
    );
    
    if (result.success && result.id) {
        await prisma.portalVisibility.upsert({
            where: { projectId },
            update: {
                lastSharedAt: new Date(),
                lastShareEmailId: result.id,
                lastShareEmailStatus: "delivered"
            },
            create: {
                projectId,
                lastSharedAt: new Date(),
                lastShareEmailId: result.id,
                lastShareEmailStatus: "delivered"
            }
        });
        revalidatePath(`/projects/${projectId}/settings`);
        return { success: true };
    }
    
    return { success: false, error: "Failed to dispatch email." };
}

export async function checkPortalEmailStatus(projectId: string) {
    const visibility = await prisma.portalVisibility.findUnique({ where: { projectId } });
    if (!visibility?.lastShareEmailId) return null;
    
    const { checkEmailStatus } = await import('@/lib/email');
    const status = await checkEmailStatus(visibility.lastShareEmailId);
    
    if (status && status !== visibility.lastShareEmailStatus) {
        await prisma.portalVisibility.update({
            where: { projectId },
            data: { lastShareEmailStatus: status }
        });
        revalidatePath(`/projects/${projectId}/settings`);
    }
    
    return status || visibility.lastShareEmailStatus;
}

// =============================================
// =============================================

export async function getCompanySubcontractorTrades() {
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    if (!settings?.subcontractorTrades) return [];
    try {
        return JSON.parse(settings.subcontractorTrades) as string[];
    } catch {
        return [];
    }
}

export async function saveCompanySubcontractorTrades(trades: string[]) {
    await prisma.companySettings.update({
        where: { id: "singleton" },
        data: { subcontractorTrades: JSON.stringify(trades) },
    });
    revalidatePath("/company/subcontractors");
    return { success: true };
}

// =============================================
// Subcontractor Project Access
// =============================================

export async function getSubcontractorExplicitProjects(subId: string) {
    const accesses = await prisma.subcontractorProjectAccess.findMany({
        where: { subcontractorId: subId },
        select: { projectId: true },
    });
    return accesses.map(a => a.projectId);
}

export async function saveSubcontractorExplicitProjects(subId: string, projectIds: string[]) {
    await prisma.$transaction([
        prisma.subcontractorProjectAccess.deleteMany({ where: { subcontractorId: subId } }),
        prisma.subcontractorProjectAccess.createMany({
            data: projectIds.map(projectId => ({
                subcontractorId: subId,
                projectId
            }))
        })
    ]);
    revalidatePath(`/company/subcontractors/${subId}`);
    return { success: true };
}

// =============================================
// Change Orders CRUD
// =============================================

export async function createChangeOrder(projectId: string, estimateId: string, itemIds?: string[]) {
    "use server";
    const count = await prisma.changeOrder.count({ where: { projectId } });
    const code = `CO-${Math.floor(1000 + Math.random() * 9000)}`;

    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: { items: true }
    });
    if (!estimate) throw new Error("Estimate not found");

    const changeOrder = await prisma.changeOrder.create({
        data: {
            title: `Change Order for ${estimate.title}`,
            projectId,
            estimateId,
            code,
            status: "Draft",
        }
    });

    if (itemIds && itemIds.length > 0) {
        const selectedItems = estimate.items.filter(i => itemIds.includes(i.id));
        for (const item of selectedItems) {
            await prisma.changeOrderItem.create({
                data: {
                    changeOrderId: changeOrder.id,
                    name: item.name,
                    description: item.description,
                    type: item.type,
                    quantity: item.quantity,
                    baseCost: item.baseCost,
                    markupPercent: item.markupPercent,
                    unitCost: item.unitCost,
                    total: item.total,
                    order: item.order,
                    costCodeId: item.costCodeId,
                    costTypeId: item.costTypeId,
                }
            });
        }
    }

    revalidatePath(`/projects/${projectId}/change-orders`);
    return { id: changeOrder.id };
}

export async function getChangeOrders(projectId: string) {
    "use server";
    return await prisma.changeOrder.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        include: { estimate: { select: { title: true, code: true } } }
    });
}

export async function getChangeOrder(id: string) {
    "use server";
    return await prisma.changeOrder.findUnique({
        where: { id },
        include: {
            project: { include: { client: true } },
            estimate: { select: { title: true, code: true } },
            items: { orderBy: { order: "asc" } },
            paymentSchedules: { orderBy: { order: "asc" } }
        }
    });
}

export async function updateChangeOrder(id: string, data: any) {
    "use server";
    const co = await prisma.changeOrder.update({
        where: { id },
        data
    });
    revalidatePath(`/projects/${co.projectId}/change-orders/${id}`);
    revalidatePath(`/projects/${co.projectId}/change-orders`);
    return co;
}

export async function deleteChangeOrder(id: string) {
    "use server";
    const co = await prisma.changeOrder.findUnique({ where: { id } });
    if (!co) return;
    await prisma.changeOrder.delete({ where: { id } });
    revalidatePath(`/projects/${co.projectId}/change-orders`);
}

export async function updateChangeOrderStatus(id: string, status: string, projectId: string) {
    "use server";
    await prisma.changeOrder.update({
        where: { id },
        data: { status }
    });
    revalidatePath(`/projects/${projectId}/change-orders/${id}`);
    revalidatePath(`/projects/${projectId}/change-orders`);
}

export async function approveChangeOrder(id: string, signatureName: string, ipAddress: string, userAgent: string, signatureDataUrl?: string) {
    "use server";
    const approvedAt = new Date();
    const co = await prisma.changeOrder.update({
        where: { id },
        data: {
            status: "Approved",
            approvedBy: signatureName,
            approvedAt,
            clientSignatureUrl: signatureDataUrl || null,
        },
    });
    
    revalidatePath(`/projects/${co.projectId}/change-orders/${id}`);
    revalidatePath(`/projects/${co.projectId}/change-orders`);
    return co;
}

export async function uploadSubcontractorCOI(subcontractorId: string, formData: FormData) {
    "use server";
    
    const file = formData.get("file") as File;
    if (!file) throw new Error("No file uploaded");

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const { getSupabase, STORAGE_BUCKET } = await import("./supabase");
    const supabase = getSupabase();
    if (!supabase) throw new Error("Storage not configured");

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `subcontractors/${subcontractorId}/coi/${Date.now()}_${safeName}`;

    const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, buffer, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
        });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData?.publicUrl || storagePath;

    let coiExpiresAt: Date | null = null;
    try {
        coiExpiresAt = await extractCoiExpirationDate(file.type, buffer);
    } catch (e) {
        console.error("Failed to parse COI Expiration via AI:", e);
    }

    await prisma.subcontractor.update({
        where: { id: subcontractorId },
        data: {
            coiFileUrl: publicUrl,
            coiUploaded: true,
            ...(coiExpiresAt ? { coiExpiresAt } : {})
        }
    });

    revalidatePath(`/company/subcontractors/${subcontractorId}`);
    return { success: true, url: publicUrl, coiExpiresAt };
}

export async function subPortalUploadCOI(formData: FormData) {
    "use server";
    const { getSubPortalSession } = await import("@/lib/sub-portal-auth");
    const sub = await getSubPortalSession();
    if (!sub) throw new Error("Unauthorized");

    const file = formData.get("file") as File;
    if (!file) throw new Error("No file uploaded");

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const { getSupabase, STORAGE_BUCKET } = await import("./supabase");
    const supabase = getSupabase();
    if (!supabase) throw new Error("Storage not configured");

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `subcontractors/${sub.id}/coi/${Date.now()}_${safeName}`;

    const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, buffer, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
        });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData?.publicUrl || storagePath;

    let coiExpiresAt: Date | null = null;
    try {
        coiExpiresAt = await extractCoiExpirationDate(file.type, buffer);
    } catch (e) {
        console.error("Failed to parse COI Expiration via AI:", e);
    }

    await prisma.subcontractor.update({
        where: { id: sub.id },
        data: {
            coiFileUrl: publicUrl,
            coiUploaded: true,
            ...(coiExpiresAt ? { coiExpiresAt } : {})
        }
    });

    revalidatePath(`/sub-portal`);
    return { success: true, url: publicUrl, coiExpiresAt };
}

async function extractCoiExpirationDate(mimeType: string, buffer: Buffer): Promise<Date | null> {
    if (!process.env.GEMINI_API_KEY) return null;
    const cleanMime = mimeType.includes("pdf") ? "application/pdf" : 
                      mimeType.includes("png") ? "image/png" :
                      mimeType.includes("webp") ? "image/webp" : "image/jpeg";
    
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    try {
        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inlineData: {
                                data: buffer.toString("base64"),
                                mimeType: cleanMime,
                            }
                        },
                        { text: `Extract the expiration date from this Certificate of Insurance (COI) document. Look for fields like 'Policy Expiration', 'Exp Date', 'Expiration', or 'Policy Ends'. 
Respond ONLY with the single date translated into YYYY-MM-DD format.
- If there are multiple policies (e.g. General Liability, Auto, Workers Comp), find the LATEST expiration date out of all the active policies.
- Do not include any other words in your response.
- If no dates can be found at all, respond with 'NULL'.` }
                    ]
                }
            ]
        });
        
        const text = response.text?.trim() || "";
        if (text === "NULL" || !text) return null;
        
        // Extract YYYY-MM-DD from the response
        const match = text.match(/\d{4}-\d{2}-\d{2}/);
        if (match) {
            const parsed = new Date(match[0]);
            // Convert to local midnight to avoid timezone shifting
            const userOffset = parsed.getTimezoneOffset() * 60000;
            const localDate = new Date(parsed.getTime() + userOffset);
            if (!isNaN(localDate.getTime())) return localDate;
        }
        
        // Final fallback: try standard js Date parsing if the text is short
        if (text.length < 30) {
            const parsedStr = new Date(text);
            if (!isNaN(parsedStr.getTime())) return parsedStr;
        }
        
        return null;
    } catch (e) {
        console.error("AI COI Extraction Error:", e);
        return null;
    }
}

export async function deleteSubcontractorCOI(subcontractorId: string) {
    "use server";
    
    await prisma.subcontractor.update({
        where: { id: subcontractorId },
        data: {
            coiFileUrl: null,
            coiUploaded: false,
            coiExpiresAt: null,
        }
    });

    revalidatePath(`/company/subcontractors/${subcontractorId}`);
    return { success: true };
}

export async function subPortalDeleteCOI() {
    "use server";
    const { getSubPortalSession } = await import("@/lib/sub-portal-auth");
    const sub = await getSubPortalSession();
    if (!sub) throw new Error("Unauthorized");
    
    await prisma.subcontractor.update({
        where: { id: sub.id },
        data: {
            coiFileUrl: null,
            coiUploaded: false,
            coiExpiresAt: null,
        }
    });

    revalidatePath(`/sub-portal`);
    return { success: true };
}

// ==========================================
// Vendors
// ==========================================
export async function getVendors() {
    "use server";
    return prisma.vendor.findMany({ 
        orderBy: { name: "asc" },
        include: { tags: true, files: true, _count: { select: { purchaseOrders: true } } }
    });
}

export async function createVendor(data: any) {
    "use server";
    const { tagIds, files, ...vendorData } = data;

    const v = await prisma.vendor.create({ 
        data: {
            ...vendorData,
            tags: tagIds?.length ? { connect: tagIds.map((id: string) => ({ id })) } : undefined,
            files: files?.length ? { create: files } : undefined
        }
    });
    revalidatePath("/company/vendors");
    return v;
}

export async function updateVendor(id: string, data: any) {
    "use server";
    const { tagIds, files, ...vendorData } = data;

    const v = await prisma.vendor.update({ 
        where: { id }, 
        data: {
            ...vendorData,
            tags: tagIds ? { set: tagIds.map((id: string) => ({ id })) } : undefined,
        }
    });

    if (files && files.length > 0) {
        await prisma.vendorFile.createMany({
            data: files.map((f: any) => ({
                name: f.name,
                url: f.url,
                size: f.size,
                type: f.type,
                vendorId: id
            }))
        });
    }

    revalidatePath("/company/vendors");
    return v;
}

export async function deleteVendor(id: string) {
    "use server";
    await prisma.vendor.delete({ where: { id } });
    revalidatePath("/company/vendors");
}

export async function deleteVendorFile(id: string) {
    "use server";
    await prisma.vendorFile.delete({ where: { id } });
    revalidatePath("/company/vendors");
}

export async function getVendorTags() {
    "use server";
    return prisma.vendorTag.findMany({ orderBy: { name: "asc" } });
}

export async function createVendorTag(name: string) {
    "use server";
    const tag = await prisma.vendorTag.create({ data: { name } });
    revalidatePath("/company/vendors");
    return tag;
}

export async function updateVendorTag(id: string, name: string) {
    "use server";
    const tag = await prisma.vendorTag.update({ where: { id }, data: { name } });
    revalidatePath("/company/vendors");
    return tag;
}

export async function deleteVendorTag(id: string) {
    "use server";
    await prisma.vendorTag.delete({ where: { id } });
    revalidatePath("/company/vendors");
}

// ==========================================
// Purchase Orders
// ==========================================
export async function getPurchaseOrders(projectId: string) {
    "use server";
    return prisma.purchaseOrder.findMany({
        where: { projectId },
        include: { vendor: true, items: true },
        orderBy: { createdAt: "desc" }
    });
}

export async function getPurchaseOrder(id: string) {
    "use server";
    return prisma.purchaseOrder.findUnique({
        where: { id },
        include: { vendor: true, items: { include: { costCode: true } }, files: true, expenses: { include: { costCode: true } } }
    });
}

export async function createPurchaseOrder(projectId: string, data: any) {
    "use server";
    const count = await prisma.purchaseOrder.count({ where: { projectId } });
    const code = `PO-${(count + 1).toString().padStart(3, "0")}`;
    
    const { items, ...poData } = data;
    
    const po = await prisma.purchaseOrder.create({
        data: {
            ...poData,
            projectId,
            code,
            items: {
                create: items || []
            }
        }
    });
    revalidatePath(`/projects/${projectId}/purchase-orders`);
    return po;
}

export async function createPurchaseOrderFromEstimate(projectId: string, estimateId: string, itemIds: string[], vendorId: string) {
    "use server";
    
    // Validate inputs
    if (!itemIds || itemIds.length === 0) throw new Error("No items selected");
    if (!vendorId) throw new Error("Vendor ID is required to create a Purchase Order");

    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: { items: true }
    });

    if (!estimate) throw new Error("Estimate not found");

    const selectedItems = estimate.items.filter((item: any) => itemIds.includes(item.id));
    if (selectedItems.length === 0) throw new Error("No valid items found");

    const totalAmount = selectedItems.reduce((acc: number, item: any) => acc + ((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)), 0);

    // Get project PO count for the code
    const count = await prisma.purchaseOrder.count({ where: { projectId } });
    const nextNum = (count + 1).toString().padStart(3, '0');

    // Create the PO
    const newPo = await prisma.purchaseOrder.create({
        data: {
            projectId,
            vendorId,
            code: `PO-${nextNum}`,
            status: "Draft",
            totalAmount,
            notes: `Auto-generated from Estimate: ${estimate.title}\n\nReview line items and update costs/quantities as needed.`,
            memos: "",
            terms: "Standard Subcontractor/Vendor terms apply unless overridden.",
            items: {
                create: selectedItems.map((item: any, idx: number) => ({
                    description: item.name + (item.description ? ` - ${item.description}` : ""),
                    quantity: parseFloat(item.quantity) || 1,
                    unitCost: parseFloat(item.unitCost) || 0,
                    total: (parseFloat(item.quantity) || 1) * (parseFloat(item.unitCost) || 0),
                    order: idx,
                    costCodeId: item.costCodeId,
                    costTypeId: item.costTypeId
                }))
            }
        }
    });

    revalidatePath(`/projects/${projectId}/purchase-orders`);
    return newPo;
}

export async function updatePurchaseOrder(id: string, data: any) {
    "use server";
    const { items, vendorId, ...poData } = data;
    
    let updateData: any = { ...poData };
    if (vendorId) updateData.vendorId = vendorId;

    const po = await prisma.purchaseOrder.update({
        where: { id },
        data: updateData
    });

    if (items) {
        await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
        await prisma.purchaseOrder.update({
            where: { id },
            data: {
                items: {
                    create: items.map((i: any) => ({
                        description: i.description,
                        quantity: i.quantity,
                        unitCost: i.unitCost,
                        total: i.total,
                        order: i.order,
                        costCodeId: i.costCodeId,
                        costTypeId: i.costTypeId
                    }))
                }
            }
        });
    }

    revalidatePath(`/projects/${po.projectId}/purchase-orders/${id}`);
    revalidatePath(`/projects/${po.projectId}/purchase-orders`);
    
    return po;
}

export async function deletePurchaseOrder(id: string) {
    "use server";
    const po = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po) return;
    await prisma.purchaseOrder.delete({ where: { id } });
    revalidatePath(`/projects/${po.projectId}/purchase-orders`);
}

export async function updatePurchaseOrderStatus(id: string, status: string) {
    "use server";
    const po = await prisma.purchaseOrder.update({
        where: { id },
        data: { status }
    });
    revalidatePath(`/projects/${po.projectId}/purchase-orders/${id}`);
    revalidatePath(`/projects/${po.projectId}/purchase-orders`);
    return po;
}

export async function approvePurchaseOrder(id: string, signatureName: string) {
    "use server";
    const approvedAt = new Date();
    const po = await prisma.purchaseOrder.update({
        where: { id },
        data: {
            status: "Approved",
            approvedBy: signatureName,
            approvedAt,
        },
    });
    
    revalidatePath(`/projects/${po.projectId}/purchase-orders/${id}`);
    revalidatePath(`/projects/${po.projectId}/purchase-orders`);
    return po;
}

export async function uploadPurchaseOrderFile(purchaseOrderId: string, formData: FormData) {
    "use server";
    const file = formData.get("file") as File;
    if (!file) throw new Error("No file uploaded");

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const { getSupabase, STORAGE_BUCKET } = await import("./supabase");
    const supabase = getSupabase();
    if (!supabase) throw new Error("Storage not configured");

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `purchase-orders/${purchaseOrderId}/${Date.now()}_${safeName}`;

    const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, buffer, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
        });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData?.publicUrl || storagePath;

    const uploaded = await prisma.purchaseOrderFile.create({
        data: {
            purchaseOrderId,
            name: file.name,
            url: publicUrl,
            size: file.size,
            type: file.type || "application/octet-stream",
        }
    });

    const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (po) {
        revalidatePath(`/projects/${po.projectId}/purchase-orders/${purchaseOrderId}`);
    }
    return uploaded;
}

export async function deletePurchaseOrderFile(fileId: string) {
    "use server";
    const file = await prisma.purchaseOrderFile.findUnique({ where: { id: fileId }, include: { purchaseOrder: true } });
    if (!file) return;

    await prisma.purchaseOrderFile.delete({ where: { id: fileId } });
    revalidatePath(`/projects/${file.purchaseOrder.projectId}/purchase-orders/${file.purchaseOrderId}`);
}


export async function sendPurchaseOrder(id: string, toEmail: string, message: string) {
    "use server";
    const { sendNotification } = await import("./email");
    const { generatePurchaseOrderPdf } = await import("./pdf");

    const po = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: { project: true, vendor: true }
    });
    if (!po) throw new Error("PO not found");

    const pdfBuffer = await generatePurchaseOrderPdf(id);

    const htmlContent = `
        <div style="font-family: sans-serif; color: #333;">
            <h2>Purchase Order ${po.code}</h2>
            <p><strong>Project:</strong> ${po.project.name}</p>
            <p><strong>Vendor:</strong> ${po.vendor.name}</p>
            <hr />
            <p>${message.replace(/\n/g, '<br/>')}</p>
            <br />
            <p>Please find the official Purchase Order attached as a PDF.</p>
        </div>
    `;

    await sendNotification(
        toEmail,
        `Purchase Order ${po.code} - ${po.project.name}`,
        htmlContent,
        [{ filename: `PO_${po.code}.pdf`, content: pdfBuffer }]
    );

    // Update status to Sent
    await updatePurchaseOrderStatus(id, "Sent");
    
    // Mark sentAt
    await prisma.purchaseOrder.update({
        where: { id },
        data: { sentAt: new Date() }
    });
    
    return { success: true };
}

// =============================================
// Selection Boards
// =============================================

export async function getSelectionBoards(projectId: string) {
    return await prisma.selectionBoard.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        include: {
            categories: {
                orderBy: { order: "asc" },
                include: {
                    options: { orderBy: { order: "asc" } },
                },
            },
        },
    });
}

export async function getSelectionBoard(id: string) {
    return await prisma.selectionBoard.findUnique({
        where: { id },
        include: {
            project: { include: { client: true } },
            categories: {
                orderBy: { order: "asc" },
                include: {
                    options: { orderBy: { order: "asc" } },
                },
            },
        },
    });
}

export async function createSelectionBoard(projectId: string, title: string) {
    const board = await prisma.selectionBoard.create({
        data: { projectId, title },
    });
    revalidatePath(`/projects/${projectId}/selections`);
    return board;
}

export async function updateSelectionBoard(id: string, data: { title?: string; status?: string }) {
    const board = await prisma.selectionBoard.update({
        where: { id },
        data,
    });
    revalidatePath(`/projects/${board.projectId}/selections`);
    return board;
}

export async function deleteSelectionBoard(id: string) {
    const board = await prisma.selectionBoard.findUnique({ where: { id } });
    if (!board) return { success: false };
    await prisma.selectionBoard.delete({ where: { id } });
    revalidatePath(`/projects/${board.projectId}/selections`);
    return { success: true };
}

export async function createSelectionCategory(boardId: string, name: string) {
    const maxOrder = await prisma.selectionCategory.aggregate({
        where: { boardId },
        _max: { order: true },
    });
    const cat = await prisma.selectionCategory.create({
        data: { boardId, name, order: (maxOrder._max.order ?? -1) + 1 },
    });
    const board = await prisma.selectionBoard.findUnique({ where: { id: boardId } });
    if (board) revalidatePath(`/projects/${board.projectId}/selections`);
    return cat;
}

export async function updateSelectionCategory(id: string, data: { name?: string; order?: number }) {
    return await prisma.selectionCategory.update({ where: { id }, data });
}

export async function deleteSelectionCategory(id: string) {
    const cat = await prisma.selectionCategory.findUnique({ where: { id }, include: { board: true } });
    if (!cat) return { success: false };
    await prisma.selectionCategory.delete({ where: { id } });
    revalidatePath(`/projects/${cat.board.projectId}/selections`);
    return { success: true };
}

export async function createSelectionOption(categoryId: string, data: {
    name: string;
    description?: string;
    imageUrl?: string;
    price?: number;
    vendorUrl?: string;
}) {
    const maxOrder = await prisma.selectionOption.aggregate({
        where: { categoryId },
        _max: { order: true },
    });
    const option = await prisma.selectionOption.create({
        data: {
            categoryId,
            name: data.name,
            description: data.description || null,
            imageUrl: data.imageUrl || null,
            price: data.price ?? null,
            vendorUrl: data.vendorUrl || null,
            order: (maxOrder._max.order ?? -1) + 1,
        },
    });
    const cat = await prisma.selectionCategory.findUnique({ where: { id: categoryId }, include: { board: true } });
    if (cat) revalidatePath(`/projects/${cat.board.projectId}/selections`);
    return option;
}

export async function updateSelectionOption(id: string, data: {
    name?: string;
    description?: string;
    imageUrl?: string;
    price?: number;
    vendorUrl?: string;
    selected?: boolean;
}) {
    return await prisma.selectionOption.update({ where: { id }, data });
}

export async function deleteSelectionOption(id: string) {
    const option = await prisma.selectionOption.findUnique({
        where: { id },
        include: { category: { include: { board: true } } },
    });
    if (!option) return { success: false };
    await prisma.selectionOption.delete({ where: { id } });
    revalidatePath(`/projects/${option.category.board.projectId}/selections`);
    return { success: true };
}

export async function sendSelectionBoardToClient(boardId: string) {
    const board = await prisma.selectionBoard.findUnique({
        where: { id: boardId },
        include: { project: { include: { client: true } } },
    });
    if (!board) throw new Error("Board not found");

    await prisma.selectionBoard.update({
        where: { id: boardId },
        data: { status: "Sent" },
    });

    // Email the client
    const clientEmail = board.project.client.email;
    if (clientEmail) {
        const settings = await getCompanySettings();
        const portalUrl = `https://probuild.goldentouchremodeling.com/portal/projects/${board.projectId}/selections`;
        await sendNotification(
            clientEmail,
            `Selection Board Ready: ${board.title}`,
            `<div style="font-family: sans-serif; color: #333;">
                <h2>Your Selection Board is Ready</h2>
                <p>Hi ${board.project.client.name},</p>
                <p>Your project manager has prepared a selection board "<strong>${board.title}</strong>" for the project <strong>${board.project.name}</strong>.</p>
                <p>Please review the options and make your selections:</p>
                <p><a href="${portalUrl}" style="display:inline-block;padding:12px 24px;background:#4c9a2a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">View Selections</a></p>
                <p style="color:#666;font-size:13px;">— ${settings.companyName || 'Your Project Team'}</p>
            </div>`
        );
    }

    revalidatePath(`/projects/${board.projectId}/selections`);
    return { success: true };
}

export async function submitClientSelections(boardId: string, selections: Record<string, string>) {
    // selections is { categoryId: optionId }
    const board = await prisma.selectionBoard.findUnique({
        where: { id: boardId },
        include: {
            project: { include: { client: true } },
            categories: { include: { options: true } },
        },
    });
    if (!board) throw new Error("Board not found");

    // Reset all options then set selected ones
    for (const cat of board.categories) {
        const selectedOptionId = selections[cat.id];
        for (const opt of cat.options) {
            await prisma.selectionOption.update({
                where: { id: opt.id },
                data: { selected: opt.id === selectedOptionId },
            });
        }
    }

    await prisma.selectionBoard.update({
        where: { id: boardId },
        data: { status: "Selections Made" },
    });

    // Notify PM
    const settings = await getCompanySettings();
    if (settings.notificationEmail) {
        const selectedSummary = board.categories.map(cat => {
            const selectedOpt = cat.options.find(o => selections[cat.id] === o.id);
            return `<li><strong>${cat.name}:</strong> ${selectedOpt?.name || 'None'}</li>`;
        }).join('');

        await sendNotification(
            settings.notificationEmail,
            `✅ Selections Made — ${board.title}`,
            `<div style="font-family: sans-serif; color: #333;">
                <h3>Client Selections Submitted</h3>
                <p><strong>${board.project.client.name}</strong> has made their selections for "<strong>${board.title}</strong>" on project <strong>${board.project.name}</strong>.</p>
                <ul>${selectedSummary}</ul>
            </div>`
        );
    }

    revalidatePath(`/projects/${board.projectId}/selections`);
    return { success: true };
}

export async function getSelectionBoardsForPortal(projectId: string) {
    return await prisma.selectionBoard.findMany({
        where: {
            projectId,
            status: { not: "Draft" },
        },
        orderBy: { createdAt: "desc" },
        include: {
            categories: {
                orderBy: { order: "asc" },
                include: {
                    options: { orderBy: { order: "asc" } },
                },
            },
        },
    });
}


// =============================================
// Daily Logs CRUD
// =============================================

export async function getDailyLogs(projectId: string) {
    return await prisma.dailyLog.findMany({
        where: { projectId },
        orderBy: { date: "desc" },
        include: {
            createdBy: { select: { id: true, name: true, email: true } },
            photos: { orderBy: { createdAt: "asc" } },
        },
    });
}

export async function getDailyLog(id: string) {
    return await prisma.dailyLog.findUnique({
        where: { id },
        include: {
            createdBy: { select: { id: true, name: true, email: true } },
            photos: { orderBy: { createdAt: "asc" } },
            project: { select: { id: true, name: true } },
        },
    });
}

export async function createDailyLog(projectId: string, data: {
    date: string;
    weather?: string;
    crewOnSite?: string;
    workPerformed: string;
    materialsDelivered?: string;
    issues?: string;
    createdById: string;
    photoUrls?: { url: string; caption?: string }[];
}) {
    const log = await prisma.dailyLog.create({
        data: {
            projectId,
            date: new Date(data.date),
            weather: data.weather || null,
            crewOnSite: data.crewOnSite || null,
            workPerformed: data.workPerformed,
            materialsDelivered: data.materialsDelivered || null,
            issues: data.issues || null,
            createdById: data.createdById,
            photos: data.photoUrls && data.photoUrls.length > 0 ? {
                create: data.photoUrls.map(p => ({
                    url: p.url,
                    caption: p.caption || null,
                })),
            } : undefined,
        },
        include: { photos: true },
    });

    revalidatePath(`/projects/${projectId}/dailylogs`);
    return log;
}

export async function updateDailyLog(id: string, data: {
    date?: string;
    weather?: string;
    crewOnSite?: string;
    workPerformed?: string;
    materialsDelivered?: string;
    issues?: string;
}) {
    const updateData: any = {};
    if (data.date !== undefined) updateData.date = new Date(data.date);
    if (data.weather !== undefined) updateData.weather = data.weather || null;
    if (data.crewOnSite !== undefined) updateData.crewOnSite = data.crewOnSite || null;
    if (data.workPerformed !== undefined) updateData.workPerformed = data.workPerformed;
    if (data.materialsDelivered !== undefined) updateData.materialsDelivered = data.materialsDelivered || null;
    if (data.issues !== undefined) updateData.issues = data.issues || null;

    const log = await prisma.dailyLog.update({
        where: { id },
        data: updateData,
    });

    revalidatePath(`/projects/${log.projectId}/dailylogs`);
    return log;
}

export async function deleteDailyLog(id: string) {
    const log = await prisma.dailyLog.findUnique({ where: { id }, select: { projectId: true } });
    if (!log) return { success: false };

    await prisma.dailyLog.delete({ where: { id } });
    revalidatePath(`/projects/${log.projectId}/dailylogs`);
    return { success: true };
}

export async function addDailyLogPhotos(dailyLogId: string, photos: { url: string; caption?: string }[]) {
    const log = await prisma.dailyLog.findUnique({ where: { id: dailyLogId }, select: { projectId: true } });
    if (!log) throw new Error("Daily log not found");

    await prisma.dailyLogPhoto.createMany({
        data: photos.map(p => ({
            dailyLogId,
            url: p.url,
            caption: p.caption || null,
        })),
    });

    revalidatePath(`/projects/${log.projectId}/dailylogs`);
    return { success: true };
}

export async function deleteDailyLogPhoto(photoId: string) {
    const photo = await prisma.dailyLogPhoto.findUnique({
        where: { id: photoId },
        include: { dailyLog: { select: { projectId: true } } },
    });
    if (!photo) return { success: false };

    await prisma.dailyLogPhoto.delete({ where: { id: photoId } });
    revalidatePath(`/projects/${photo.dailyLog.projectId}/dailylogs`);
    return { success: true };
}

// =============================================
// Mood Boards (Visual Canvas)
// =============================================

export async function getMoodBoards(projectId: string) {
    return await prisma.moodBoard.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        include: { items: true },
    });
}

export async function getMoodBoard(id: string) {
    return await prisma.moodBoard.findUnique({
        where: { id },
        include: { items: true, project: { include: { client: true } } },
    });
}

export async function createMoodBoard(projectId: string, title: string) {
    const board = await prisma.moodBoard.create({
        data: { projectId, title },
    });
    revalidatePath(`/projects/${projectId}/mood-boards`);
    return board;
}

export async function deleteMoodBoard(id: string) {
    const board = await prisma.moodBoard.findUnique({ where: { id } });
    if (!board) return { success: false };
    await prisma.moodBoard.delete({ where: { id } });
    revalidatePath(`/projects/${board.projectId}/mood-boards`);
    return { success: true };
}

export async function saveMoodBoardItems(boardId: string, items: Array<{
    id?: string;
    type: string;
    content: string;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
}>) {
    const board = await prisma.moodBoard.findUnique({ where: { id: boardId } });
    if (!board) throw new Error("Board not found");

    await prisma.$transaction(async (tx) => {
        const currentItemIds = items.filter(i => i.id && !i.id.startsWith("temp-")).map(i => i.id as string);
        await tx.moodBoardItem.deleteMany({
            where: {
                moodBoardId: boardId,
                id: { notIn: currentItemIds }
            }
        });

        for (const item of items) {
            if (item.id && !item.id.startsWith("temp-")) {
                await tx.moodBoardItem.update({
                    where: { id: item.id },
                    data: {
                        type: item.type,
                        content: item.content,
                        x: item.x,
                        y: item.y,
                        width: item.width,
                        height: item.height,
                        zIndex: item.zIndex,
                    }
                });
            } else {
                await tx.moodBoardItem.create({
                    data: {
                        moodBoardId: boardId,
                        type: item.type,
                        content: item.content,
                        x: item.x,
                        y: item.y,
                        width: item.width,
                        height: item.height,
                        zIndex: item.zIndex,
                    }
                });
            }
        }
    });

    revalidatePath(`/projects/${board.projectId}/mood-boards/${boardId}`);
    return { success: true };
}

// ─── Catalog Items ─────────────────────────────────────────────────────────

export async function createCatalogItem(data: {
    name: string;
    description?: string;
    unitCost: number;
    unit?: string;
    costCodeId?: string;
}) {
    "use server";
    const item = await prisma.catalogItem.create({
        data: {
            name: data.name,
            description: data.description || null,
            unitCost: data.unitCost,
            unit: data.unit || "each",
            costCodeId: data.costCodeId || null,
        },
        include: { costCode: { select: { code: true, name: true } } },
    });
    revalidatePath("/company/my-items");
    return item;
}

export async function updateCatalogItem(id: string, data: {
    name?: string;
    description?: string;
    unitCost?: number;
    unit?: string;
    costCodeId?: string | null;
    isActive?: boolean;
}) {
    "use server";
    const item = await prisma.catalogItem.update({
        where: { id },
        data,
        include: { costCode: { select: { code: true, name: true } } },
    });
    revalidatePath("/company/my-items");
    return item;
}

export async function deleteCatalogItem(id: string) {
    "use server";
    await prisma.catalogItem.delete({ where: { id } });
    revalidatePath("/company/my-items");
    return { success: true };
}

// ─── Lead Schedule ────────────────────────────────────────────────────────

export async function getLeadScheduleTasks(leadId: string) {
    return prisma.scheduleTask.findMany({
        where: { leadId },
        orderBy: { order: "asc" },
    });
}

export async function createLeadScheduleTask(leadId: string, data: {
    name: string;
    startDate: Date;
    endDate: Date;
}) {
    "use server";
    const task = await prisma.scheduleTask.create({
        data: {
            leadId,
            name: data.name,
            startDate: data.startDate,
            endDate: data.endDate,
        },
    });
    revalidatePath(`/leads/${leadId}/schedule`);
    return task;
}

export async function updateLeadScheduleTask(taskId: string, leadId: string, data: {
    name?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
}) {
    "use server";
    const task = await prisma.scheduleTask.update({
        where: { id: taskId },
        data,
    });
    revalidatePath(`/leads/${leadId}/schedule`);
    return task;
}

export async function deleteLeadScheduleTask(taskId: string, leadId: string) {
    "use server";
    await prisma.scheduleTask.delete({ where: { id: taskId } });
    revalidatePath(`/leads/${leadId}/schedule`);
    return { success: true };
}

// ─── Bid Packages ─────────────────────────────────────────────────────────

export async function getProjectBidPackages(projectId: string) {
    return prisma.bidPackage.findMany({
        where: { projectId },
        include: { scopes: { orderBy: { order: "asc" } }, invitations: true },
        orderBy: { createdAt: "desc" },
    });
}

export async function getBidPackage(id: string) {
    return prisma.bidPackage.findUnique({
        where: { id },
        include: {
            scopes: { orderBy: { order: "asc" } },
            invitations: { orderBy: { createdAt: "asc" } },
            project: { select: { id: true, name: true } },
        },
    });
}

export async function createBidPackage(projectId: string, data: {
    title: string;
    description?: string;
    dueDate?: Date | null;
    totalBudget?: number | null;
}) {
    "use server";
    const pkg = await prisma.bidPackage.create({
        data: { projectId, ...data },
    });
    revalidatePath(`/projects/${projectId}/bid-packages`);
    return pkg;
}

export async function updateBidPackage(id: string, projectId: string, data: {
    title?: string;
    description?: string;
    dueDate?: Date | null;
    status?: string;
    totalBudget?: number | null;
}) {
    "use server";
    const pkg = await prisma.bidPackage.update({ where: { id }, data });
    revalidatePath(`/projects/${projectId}/bid-packages`);
    revalidatePath(`/projects/${projectId}/bid-packages/${id}/edit`);
    return pkg;
}

export async function deleteBidPackage(id: string, projectId: string) {
    "use server";
    await prisma.bidPackage.delete({ where: { id } });
    revalidatePath(`/projects/${projectId}/bid-packages`);
    return { success: true };
}

export async function addBidScope(packageId: string, projectId: string, data: {
    name: string;
    description?: string;
    budgetAmount?: number | null;
}) {
    "use server";
    const scope = await prisma.bidScope.create({
        data: { packageId, ...data },
    });
    revalidatePath(`/projects/${projectId}/bid-packages/${packageId}/edit`);
    return scope;
}

export async function deleteBidScope(scopeId: string, packageId: string, projectId: string) {
    "use server";
    await prisma.bidScope.delete({ where: { id: scopeId } });
    revalidatePath(`/projects/${projectId}/bid-packages/${packageId}/edit`);
    return { success: true };
}

export async function inviteSubToBid(packageId: string, projectId: string, data: {
    email: string;
    subcontractorId?: string;
}) {
    "use server";
    const inv = await prisma.bidInvitation.create({
        data: { packageId, email: data.email, subcontractorId: data.subcontractorId || null, sentAt: new Date() },
    });
    revalidatePath(`/projects/${projectId}/bid-packages/${packageId}/edit`);
    return inv;
}

export async function recordBidResponse(invitationId: string, packageId: string, projectId: string, data: {
    status: string;
    bidAmount?: number | null;
    notes?: string;
}) {
    "use server";
    const inv = await prisma.bidInvitation.update({
        where: { id: invitationId },
        data: { ...data, respondedAt: new Date() },
    });
    revalidatePath(`/projects/${projectId}/bid-packages/${packageId}/edit`);
    return inv;
}

export async function awardBid(packageId: string, invitationId: string, projectId: string) {
    "use server";
    await prisma.$transaction([
        prisma.bidInvitation.update({ where: { id: invitationId }, data: { status: "Awarded" } }),
        prisma.bidPackage.update({ where: { id: packageId }, data: { status: "Awarded" } }),
    ]);
    revalidatePath(`/projects/${projectId}/bid-packages/${packageId}/edit`);
    return { success: true };
}

// ── Retainers ──────────────────────────────────────────────

export async function createRetainer(projectId: string, data: {
    totalAmount: number;
    notes?: string;
    dueDate?: string;
}) {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { clientId: true },
    });
    if (!project || !project.clientId) throw new Error("Project or client not found");

    const count = await prisma.retainer.count({ where: { projectId } });
    const nextNum = (count + 1).toString().padStart(3, '0');

    const retainer = await prisma.retainer.create({
        data: {
            projectId,
            clientId: project.clientId,
            code: `RT-${nextNum}`,
            totalAmount: data.totalAmount,
            balanceDue: data.totalAmount,
            amountPaid: 0,
            notes: data.notes || null,
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            issueDate: new Date(),
            status: "Draft",
        },
    });

    revalidatePath(`/projects/${projectId}/retainers`);
    return retainer;
}

export async function updateRetainer(id: string, data: {
    totalAmount?: number;
    notes?: string;
    dueDate?: string | null;
    status?: string;
}) {
    const existing = await prisma.retainer.findUnique({ where: { id }, select: { projectId: true, amountPaid: true } });
    if (!existing) throw new Error("Retainer not found");

    const updateData: any = {};
    if (data.totalAmount !== undefined) {
        updateData.totalAmount = data.totalAmount;
        updateData.balanceDue = data.totalAmount - Number(existing.amountPaid);
    }
    if (data.notes !== undefined) updateData.notes = data.notes || null;
    if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (data.status !== undefined) {
        updateData.status = data.status;
        if (data.status === "Sent" && !updateData.sentAt) updateData.sentAt = new Date();
    }

    const retainer = await prisma.retainer.update({ where: { id }, data: updateData });
    revalidatePath(`/projects/${existing.projectId}/retainers`);
    revalidatePath(`/projects/${existing.projectId}/retainers/${id}`);
    return retainer;
}

export async function deleteRetainer(id: string) {
    const retainer = await prisma.retainer.findUnique({ where: { id }, select: { projectId: true } });
    if (!retainer) return { success: false };

    await prisma.retainer.delete({ where: { id } });
    revalidatePath(`/projects/${retainer.projectId}/retainers`);
    return { success: true };
}
