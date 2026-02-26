"use server";

import Database from "better-sqlite3";
import { revalidatePath } from "next/cache";
import { sendNotification } from "./email";
import { generateEstimatePdf } from "./pdf";

// Using a lazy DB connection
let _db: any = null;
function getDb() {
    if (!_db) _db = new Database("dev.db");
    return _db;
}

function cuid() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export async function getLeads() {
    const db = getDb();
    const leads = db.prepare("SELECT * FROM Lead ORDER BY createdAt DESC").all();
    for (const lead of leads) {
        lead.client = db.prepare("SELECT * FROM Client WHERE id = ?").get(lead.clientId);
        lead.estimates = db.prepare("SELECT * FROM Estimate WHERE leadId = ?").all(lead.id);
    }
    return leads;
}

export async function getLead(id: string) {
    const db = getDb();
    const lead = db.prepare("SELECT * FROM Lead WHERE id = ?").get(id);
    if (!lead) return null;
    lead.client = db.prepare("SELECT * FROM Client WHERE id = ?").get(lead.clientId);
    lead.estimates = db.prepare("SELECT * FROM Estimate WHERE leadId = ?").all(id);
    return lead;
}

export async function getProjects() {
    const db = getDb();
    const projects = db.prepare("SELECT * FROM Project ORDER BY viewedAt DESC").all();
    for (const project of projects) {
        project.client = db.prepare("SELECT * FROM Client WHERE id = ?").get(project.clientId);
        project.estimates = db.prepare("SELECT * FROM Estimate WHERE projectId = ?").all(project.id);
    }
    return projects;
}

export async function getProject(id: string) {
    const db = getDb();
    const project = db.prepare("SELECT * FROM Project WHERE id = ?").get(id);
    if (!project) return null;
    project.client = db.prepare("SELECT * FROM Client WHERE id = ?").get(project.clientId);
    project.estimates = db.prepare("SELECT * FROM Estimate WHERE projectId = ?").all(id);
    project.floorPlans = db.prepare("SELECT * FROM FloorPlan WHERE projectId = ?").all(id);
    return project;
}

export async function convertLeadToProject(leadId: string) {
    const db = getDb();

    const lead = db.prepare("SELECT * FROM Lead WHERE id = ?").get(leadId);
    if (!lead) throw new Error("Lead not found");

    const projectId = cuid();

    db.prepare(`
    INSERT INTO Project (id, name, clientId, location, status, type, viewedAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, lead.name, lead.clientId, lead.location, "In Progress", "Unknown", Date.now(), Date.now());

    // Relink estimates
    db.prepare("UPDATE Estimate SET projectId = ?, leadId = NULL WHERE leadId = ?").run(projectId, leadId);

    // Update lead
    db.prepare("UPDATE Lead SET stage = 'Won' WHERE id = ?").run(leadId);

    revalidatePath("/leads");
    revalidatePath("/projects");
    revalidatePath(`/leads/${leadId}`);

    return { id: projectId };
}

export async function createDraftEstimate(projectId: string) {
    const db = getDb();
    const estimateId = cuid();
    const code = `EST-${Math.floor(1000 + Math.random() * 9000)}`;

    db.prepare(`
        INSERT INTO Estimate (id, title, projectId, code, status, totalAmount, balanceDue, privacy, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(estimateId, "Draft Estimate", projectId, code, "Draft", 0, 0, "Shared", Date.now());

    revalidatePath(`/projects/${projectId}/estimates`);

    return { id: estimateId };
}

export async function createDraftFloorPlan(projectId: string) {
    const db = getDb();
    const floorPlanId = cuid();

    db.prepare(`
        INSERT INTO FloorPlan (id, name, projectId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
    `).run(floorPlanId, "New Floor Plan", projectId, Date.now(), Date.now());

    revalidatePath(`/projects/${projectId}/floor-plans`);
    return { id: floorPlanId };
}

export async function getEstimate(id: string) {
    const db = getDb();
    const estimate: any = db.prepare("SELECT * FROM Estimate WHERE id = ?").get(id);
    if (!estimate) return null;
    const items = db.prepare("SELECT * FROM EstimateItem WHERE estimateId = ? ORDER BY \"order\" ASC").all(id);
    const expenses = db.prepare("SELECT * FROM Expense WHERE estimateId = ?").all(id);
    for (const item of (items as any[])) {
        item.expenses = (expenses as any[]).filter(e => e.itemId === item.id);
    }
    estimate.items = items;
    estimate.paymentSchedules = db.prepare("SELECT * FROM EstimatePaymentSchedule WHERE estimateId = ? ORDER BY \"order\" ASC").all(id);
    return estimate;
}

export async function getEstimateForPortal(id: string) {
    const db = getDb();
    const estimate: any = db.prepare(`
        SELECT e.*, p.name as projectName, c.name as clientName, c.email as clientEmail, l.name as leadName, lc.name as leadClientName
        FROM Estimate e
        LEFT JOIN Project p ON e.projectId = p.id
        LEFT JOIN Client c ON p.clientId = c.id
        LEFT JOIN Lead l ON e.leadId = l.id
        LEFT JOIN Client lc ON l.clientId = lc.id
        WHERE e.id = ?
    `).get(id);
    if (!estimate) return null;

    estimate.clientName = estimate.clientName || estimate.leadClientName || "Unknown Client";

    const items = db.prepare("SELECT * FROM EstimateItem WHERE estimateId = ? ORDER BY \"order\" ASC").all(id);
    estimate.items = items;
    estimate.paymentSchedules = db.prepare("SELECT * FROM EstimatePaymentSchedule WHERE estimateId = ? ORDER BY \"order\" ASC").all(id);
    return estimate;
}

export async function markEstimateViewed(estimateId: string) {
    const db = getDb();
    const estimate: any = db.prepare("SELECT viewedAt Code FROM Estimate WHERE id = ?").get(estimateId);

    if (estimate && !estimate.viewedAt) {
        db.prepare("UPDATE Estimate SET viewedAt = ? WHERE id = ?").run(Date.now(), estimateId);

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
    const db = getDb();
    db.prepare(`
        UPDATE Estimate 
        SET status = 'Approved', approvedBy = ?, approvedAt = ?, approvalIp = ?, approvalUserAgent = ?
        WHERE id = ?
    `).run(signatureName, Date.now(), ipAddress, userAgent, estimateId);

    const estimate: any = db.prepare("SELECT projectId, code FROM Estimate WHERE id = ?").get(estimateId);

    const settings = await getCompanySettings();
    if (settings.notificationEmail) {
        // Generate the PDF snapshot of the newly signed estimate
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
    const db = getDb();

    // Update estimate
    db.prepare(`
        UPDATE Estimate 
        SET title = ?, code = ?, status = ?, totalAmount = ?, balanceDue = ?
        WHERE id = ?
    `).run(data.title, data.code, data.status, data.totalAmount, data.totalAmount, estimateId);

    // Delete existing items and schedules
    db.prepare("DELETE FROM EstimateItem WHERE estimateId = ?").run(estimateId);
    db.prepare("DELETE FROM EstimatePaymentSchedule WHERE estimateId = ?").run(estimateId);

    // Insert new items
    const insertItem = db.prepare(`
        INSERT INTO EstimateItem (id, estimateId, name, description, type, quantity, unitCost, total, "order", parentId, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let itemOrder = 0;
    for (const item of items) {
        insertItem.run(
            item.id || cuid(),
            estimateId,
            item.name,
            item.description || "",
            item.type,
            parseFloat(item.quantity) || 0,
            parseFloat(item.unitCost) || 0,
            parseFloat(item.total) || 0,
            item.order ?? itemOrder++,
            item.parentId || null,
            item.createdAt || Date.now()
        );
    }

    // Insert new payment schedules
    const insertSchedule = db.prepare(`
        INSERT INTO EstimatePaymentSchedule (id, estimateId, name, percentage, amount, dueDate, "order", createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let scheduleOrder = 0;
    const schedules = data.paymentSchedules || [];
    for (const schedule of schedules) {
        insertSchedule.run(
            schedule.id || cuid(),
            estimateId,
            schedule.name,
            schedule.percentage ? parseFloat(schedule.percentage) : null,
            parseFloat(schedule.amount) || 0,
            schedule.dueDate || null,
            schedule.order ?? scheduleOrder++,
            schedule.createdAt || Date.now()
        );
    }

    if (data.status === 'Approved') {
        const existingBudget = db.prepare("SELECT id FROM Budget WHERE estimateId = ?").get(estimateId);
        if (!existingBudget) {
            generateBudgetForEstimate(estimateId, projectId, db);
        }
    }

    revalidatePath(`/projects/${projectId}/estimates`);
    revalidatePath(`/projects/${projectId}/estimates/${estimateId}`);
    return { success: true };
}

export async function createInvoiceFromEstimate(estimateId: string) {
    const db = getDb();
    const estimate: any = db.prepare("SELECT * FROM Estimate WHERE id = ?").get(estimateId);
    if (!estimate) throw new Error("Estimate not found");
    const project: any = db.prepare("SELECT * FROM Project WHERE id = ?").get(estimate.projectId);
    if (!project) throw new Error("Project not found");

    const invoiceId = cuid();
    const code = `INV-${Math.floor(1000 + Math.random() * 9000)}`;

    db.prepare(`
        INSERT INTO Invoice (id, code, projectId, clientId, status, totalAmount, balanceDue, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(invoiceId, code, estimate.projectId, project.clientId, "Draft", estimate.totalAmount || 0, estimate.totalAmount || 0, Date.now());

    const schedules: any[] = db.prepare("SELECT * FROM EstimatePaymentSchedule WHERE estimateId = ? ORDER BY \"order\" ASC").all(estimateId);

    if (schedules.length > 0) {
        const insertPayment = db.prepare(`
            INSERT INTO PaymentSchedule (id, invoiceId, name, amount, status, dueDate, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const schedule of schedules) {
            insertPayment.run(
                cuid(),
                invoiceId,
                schedule.name,
                schedule.amount,
                "Pending",
                schedule.dueDate || null,
                Date.now()
            );
        }
    } else {
        // By default, create a single payment schedule for the full amount
        db.prepare(`
            INSERT INTO PaymentSchedule (id, invoiceId, name, amount, status, createdAt)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(cuid(), invoiceId, "Initial Payment", estimate.totalAmount || 0, "Pending", Date.now());
    }

    revalidatePath(`/projects/${estimate.projectId}/invoices`);

    return { id: invoiceId, projectId: estimate.projectId };
}

export async function getInvoice(id: string) {
    const db = getDb();
    const invoice: any = db.prepare("SELECT * FROM Invoice WHERE id = ?").get(id);
    if (!invoice) return null;
    invoice.payments = db.prepare("SELECT * FROM PaymentSchedule WHERE invoiceId = ? ORDER BY createdAt ASC").all(id);
    return invoice;
}

export async function recordPayment(paymentId: string, invoiceId: string, timestamp: number) {
    const db = getDb();
    const payment: any = db.prepare("SELECT * FROM PaymentSchedule WHERE id = ?").get(paymentId);
    if (!payment || payment.status === "Paid") return { success: false };

    db.prepare("UPDATE PaymentSchedule SET status = 'Paid', paymentDate = ? WHERE id = ?").run(timestamp, paymentId);

    // Update invoice balance
    const invoice: any = db.prepare("SELECT balanceDue FROM Invoice WHERE id = ?").get(invoiceId);
    const newBalance = Math.max(0, (invoice.balanceDue || 0) - (payment.amount || 0));
    const newStatus = newBalance <= 0 ? "Paid" : "Partially Paid";

    db.prepare("UPDATE Invoice SET balanceDue = ?, status = ? WHERE id = ?").run(newBalance, newStatus, invoiceId);

    const inv: any = db.prepare("SELECT projectId FROM Invoice WHERE id = ?").get(invoiceId);
    revalidatePath(`/projects/${inv.projectId}/invoices`);
    revalidatePath(`/projects/${inv.projectId}/invoices/${invoiceId}`);

    return { success: true };
}

export async function getProjectInvoices(projectId: string) {
    const db = getDb();
    return db.prepare("SELECT * FROM Invoice WHERE projectId = ? ORDER BY createdAt DESC").all(projectId);
}

function generateBudgetForEstimate(estimateId: string, projectId: string, db: any) {
    const items = db.prepare("SELECT * FROM EstimateItem WHERE estimateId = ?").all(estimateId);

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
            // Note: Currently counting Material, Subcontractor, Assembly as Material for simplicity.
            bucketsMap[topLevelId].materialBudget += item.total || 0;
            totalMaterialBudget += item.total || 0;
        }
    }

    const budgetId = cuid();
    db.prepare(`
        INSERT INTO Budget (id, projectId, estimateId, totalLaborBudget, totalMaterialBudget, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(budgetId, projectId, estimateId, totalLaborBudget, totalMaterialBudget, Date.now(), Date.now());

    const insertBucket = db.prepare(`
        INSERT INTO BudgetBucket (id, budgetId, name, laborBudget, materialBudget, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const topLevelId in bucketsMap) {
        const b = bucketsMap[topLevelId];
        insertBucket.run(cuid(), budgetId, b.name, b.laborBudget, b.materialBudget, Date.now(), Date.now());
    }
}

export async function getCompanySettings() {
    const db = getDb();
    let settings: any = db.prepare("SELECT * FROM CompanySettings WHERE id = 'singleton'").get();

    // Auto-initialize if it doesn't exist
    if (!settings) {
        db.prepare(`
            INSERT INTO CompanySettings (id, companyName, updatedAt) 
            VALUES ('singleton', 'My Construction Co.', ?)
        `).run(Date.now());
        settings = db.prepare("SELECT * FROM CompanySettings WHERE id = 'singleton'").get();
    }

    return settings;
}

export async function saveCompanySettings(data: any) {
    const db = getDb();
    db.prepare(`
        UPDATE CompanySettings 
        SET companyName = ?, address = ?, phone = ?, email = ?, website = ?, logoUrl = ?, notificationEmail = ?, updatedAt = ?
        WHERE id = 'singleton'
    `).run(
        data.companyName,
        data.address,
        data.phone,
        data.email,
        data.website,
        data.logoUrl,
        data.notificationEmail,
        Date.now()
    );

    revalidatePath("/settings/company");
    revalidatePath("/portal"); // Ensure portals update with new info
    return { success: true };
}

export async function deleteEstimate(estimateId: string) {
    const db = getDb();
    const estimate: any = db.prepare("SELECT projectId FROM Estimate WHERE id = ?").get(estimateId);
    if (!estimate) return { success: false, error: "Estimate not found" };

    // Delete related Budget and BudgetBucket
    const budget: any = db.prepare("SELECT id FROM Budget WHERE estimateId = ?").get(estimateId);
    if (budget) {
        db.prepare("DELETE FROM BudgetBucket WHERE budgetId = ?").run(budget.id);
        db.prepare("DELETE FROM Budget WHERE id = ?").run(budget.id);
    }

    // Delete related items and schedules, and finally the estimate
    db.prepare("DELETE FROM EstimateItem WHERE estimateId = ?").run(estimateId);
    db.prepare("DELETE FROM EstimatePaymentSchedule WHERE estimateId = ?").run(estimateId);
    db.prepare("DELETE FROM Expense WHERE estimateId = ?").run(estimateId);
    db.prepare("DELETE FROM Estimate WHERE id = ?").run(estimateId);

    if (estimate.projectId) {
        revalidatePath(`/projects/${estimate.projectId}/estimates`);
    } else {
        revalidatePath("/projects/all/estimates");
    }
    return { success: true };
}
