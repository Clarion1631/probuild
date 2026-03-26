"use server";

import { prisma } from "./prisma";
import { revalidatePath } from "next/cache";
import { sendNotification } from "./email";

export async function getLeads() {
    const leads = await prisma.lead.findMany({
        orderBy: { createdAt: "desc" },
        include: {
            client: true,
            estimates: true,
        },
    });
    return leads;
}

export async function getLead(id: string) {
    const lead = await prisma.lead.findUnique({
        where: { id },
        include: {
            client: true,
            estimates: true,
            contracts: true,
        },
    });
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

export async function createLead(data: { name: string; clientName: string; clientEmail?: string; clientPhone?: string; location?: string; source?: string; projectType?: string }) {
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
            stage: "New",
        },
    });

    revalidatePath("/leads");
    return { id: lead.id };
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
            estimates: true,
        },
    });
    return projects;
}

export async function getProject(id: string) {
    const project = await prisma.project.findUnique({
        where: { id },
        include: {
            client: true,
            estimates: true,
            floorPlans: true,
            contracts: { include: { signingRecords: true }, orderBy: { createdAt: "desc" } },
        },
    });
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

export async function getFloorPlan(id: string) {
    return await prisma.floorPlan.findUnique({ where: { id } });
}

export async function saveFloorPlanData(id: string, projectId: string, data: string) {
    await prisma.floorPlan.update({
        where: { id },
        data: { data },
    });

    revalidatePath(`/projects/${projectId}/floor-plans`);
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
    await prisma.estimate.update({
        where: { id: estimateId },
        data: {
            status: "Approved",
            approvedBy: signatureName,
            approvedAt: new Date(),
            approvalIp: ipAddress,
            approvalUserAgent: userAgent,
            signatureUrl: signatureDataUrl || null,
        },
    });

    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { projectId: true, code: true },
    });

    const settings = await getCompanySettings();
    if (settings.notificationEmail) {
        let attachments: any = undefined;
        try {
            const { generateEstimatePdf } = await import("./pdf");
            const pdfBuffer = await generateEstimatePdf(estimateId);
            attachments = [{
                filename: `Estimate_${estimate?.code || estimateId}.pdf`,
                content: pdfBuffer,
            }];
        } catch (e) {
            console.error("Failed to generate PDF snapshot for email:", e);
        }

        await sendNotification(
            settings.notificationEmail,
            `Estimate Approved: ${estimate?.code || estimateId}`,
            `<p>Great news! The client <b>${signatureName}</b> has electronically signed and approved estimate <b>${estimate?.code || estimateId}</b>.</p>
             <p>IP Address: ${ipAddress}</p>
             <p>User Agent: ${userAgent}</p>`,
            attachments
        );
    }

    if (estimate?.projectId) {
        revalidatePath(`/projects/${estimate.projectId}/estimates`);
    }
    revalidatePath(`/portal/estimates/${estimateId}`);
    return { success: true };
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
        },
    });
}

export async function createScheduleTask(projectId: string, data: {
    name: string;
    startDate: string;
    endDate: string;
    color?: string;
    status?: string;
    assignee?: string;
    parentId?: string;
}) {
    const maxOrder = await prisma.scheduleTask.aggregate({
        where: { projectId },
        _max: { order: true },
    });
    const task = await prisma.scheduleTask.create({
        data: {
            projectId,
            name: data.name,
            startDate: new Date(data.startDate),
            endDate: new Date(data.endDate),
            color: data.color || "#4c9a2a",
            status: data.status || "Not Started",
            assignee: data.assignee || null,
            parentId: data.parentId || null,
            order: (maxOrder._max.order ?? -1) + 1,
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
