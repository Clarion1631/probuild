"use server";

import { prisma } from "./prisma";
import { revalidatePath } from "next/cache";
import { sendNotification } from "./email";
import { generateEstimatePdf } from "./pdf";

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
        },
    });
    return project;
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
        select: { viewedAt: true },
    });

    if (estimate && !estimate.viewedAt) {
        await prisma.estimate.update({
            where: { id: estimateId },
            data: { viewedAt: new Date() },
        });

        const settings = await getCompanySettings();
        if (settings.notificationEmail) {
            await sendNotification(
                settings.notificationEmail,
                `Estimate Viewed: ${estimateId}`,
                `<p>A client has opened and viewed estimate <b>${estimateId}</b>.</p>`
            );
        }
    }
}

export async function approveEstimate(estimateId: string, signatureName: string, ipAddress: string, userAgent: string) {
    await prisma.estimate.update({
        where: { id: estimateId },
        data: {
            status: "Approved",
            approvedBy: signatureName,
            approvedAt: new Date(),
            approvalIp: ipAddress,
            approvalUserAgent: userAgent,
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
                unitCost: parseFloat(item.unitCost) || 0,
                total: parseFloat(item.total) || 0,
                order: item.order ?? itemOrder++,
                parentId: item.parentId || null,
                costCodeId: item.costCodeId || null,
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

    return { success: true };
}

export async function getProjectInvoices(projectId: string) {
    return await prisma.invoice.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
    });
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

export async function sendEstimateToClient(estimateId: string, templateId?: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
            project: { include: { client: true } },
            lead: { include: { client: true } },
        }
    });

    if (!estimate) throw new Error("Estimate not found");

    const client = estimate.project?.client || estimate.lead?.client;
    if (!client?.email) throw new Error("Client has no email address");

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
        client.email,
        `${companyName} sent you an estimate`,
        `<!DOCTYPE html>
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
            </div>
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">New Estimate for You</h2>
                <p style="color: #666; margin: 0 0 24px;">Hi ${client.name},</p>
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
        </html>`
    );

    // Revalidate paths
    if (estimate.projectId) revalidatePath(`/projects/${estimate.projectId}/estimates`);
    if (estimate.leadId) revalidatePath(`/leads/${estimate.leadId}`);
    revalidatePath("/projects/all/estimates");

    return { success: true, sentTo: client.email };
}

// ────────────────────────────────────────────────
// Schedule Tasks
// ────────────────────────────────────────────────

export async function getScheduleTasks(projectId: string) {
    return prisma.scheduleTask.findMany({
        where: { projectId },
        orderBy: { order: "asc" },
        include: { children: true },
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

export async function importEstimateToSchedule(projectId: string, estimateId: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
            items: {
                where: { parentId: null },
                orderBy: { order: "asc" },
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
        const duration = item.type === "Labor" ? 7 : item.type === "Subcontractor" ? 10 : 5;
        const startDate = new Date(today.getTime() + dayOffset * 86400000);
        const endDate = new Date(today.getTime() + (dayOffset + duration) * 86400000);
        dayOffset += Math.ceil(duration * 0.7); // overlap a bit

        const task = await prisma.scheduleTask.create({
            data: {
                projectId,
                name: item.name,
                startDate,
                endDate,
                color: TYPE_COLORS[item.type] || "#4c9a2a",
                order: order++,
                status: "Not Started",
            },
        });
        created.push(task);
    }

    revalidatePath(`/projects/${projectId}/schedule`);
    return created;
}


