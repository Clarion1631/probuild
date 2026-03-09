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

export async function saveEstimate(estimateId: string, projectId: string, data: any, items: any[]) {
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

    if (data.status === 'Approved') {
        const existingBudget = await prisma.budget.findUnique({ where: { estimateId } });
        if (!existingBudget) {
            await generateBudgetForEstimate(estimateId, projectId);
        }
    }

    revalidatePath(`/projects/${projectId}/estimates`);
    revalidatePath(`/projects/${projectId}/estimates/${estimateId}`);
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

    const bucketsMap: Record<string, { name: string, laborBudget: number, materialBudget: number }> = {};

    for (const item of items) {
        const topLevelId = item.parentId || item.id;
        if (!bucketsMap[topLevelId]) {
            const topItem = items.find((i: any) => i.id === topLevelId);
            bucketsMap[topLevelId] = {
                name: topItem ? topItem.name : (item.name || "Phase"),
                laborBudget: 0,
                materialBudget: 0
            };
        }

        if (item.type === "Labor") {
            bucketsMap[topLevelId].laborBudget += item.total || 0;
            totalLaborBudget += item.total || 0;
        } else {
            bucketsMap[topLevelId].materialBudget += item.total || 0;
            totalMaterialBudget += item.total || 0;
        }
    }

    const budget = await prisma.budget.create({
        data: {
            projectId,
            estimateId,
            totalLaborBudget,
            totalMaterialBudget,
        },
    });

    for (const topLevelId in bucketsMap) {
        const b = bucketsMap[topLevelId];
        await prisma.budgetBucket.create({
            data: {
                budgetId: budget.id,
                name: b.name,
                laborBudget: b.laborBudget,
                materialBudget: b.materialBudget,
            },
        });
    }
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
        select: { projectId: true },
    });
    if (!estimate) return { success: false, error: "Estimate not found" };

    // Delete related Budget and BudgetBuckets
    const budget = await prisma.budget.findUnique({ where: { estimateId } });
    if (budget) {
        await prisma.budgetBucket.deleteMany({ where: { budgetId: budget.id } });
        await prisma.budget.delete({ where: { id: budget.id } });
    }

    // Delete related items, schedules, expenses, and the estimate itself
    await prisma.estimateItem.deleteMany({ where: { estimateId } });
    await prisma.estimatePaymentSchedule.deleteMany({ where: { estimateId } });
    await prisma.expense.deleteMany({ where: { estimateId } });
    await prisma.estimate.delete({ where: { id: estimateId } });

    if (estimate.projectId) {
        revalidatePath(`/projects/${estimate.projectId}/estimates`);
    } else {
        revalidatePath("/projects/all/estimates");
    }
    return { success: true };
}
