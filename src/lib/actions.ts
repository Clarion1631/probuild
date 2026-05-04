"use server";

import { getServerSession } from "next-auth";
import { prisma } from "./prisma";
import { revalidatePath, unstable_cache } from "next/cache";
import { authOptions } from "./auth";
import { sendNotification } from "./email";
import { safeEstimateSelect, toNum } from "./prisma-helpers";
import { formatCurrency } from "./utils";
import { createHmac, timingSafeEqual } from "crypto";
import { resolveSessionClientId } from "./portal-auth";
import { getCurrentUserWithPermissions, hasPermission } from "./permissions";
import { buildDefaultLayout, type RoomType } from "@/components/room-designer/types";
import { normalizeE164 } from "./phone";

type NotificationToggleKey = "newLead" | "estimateViewed" | "estimateSigned" | "contractSigned" | "invoiceViewed" | "paymentReceived" | "messageReceived";

function isNotificationEnabled(settings: { notificationToggles?: string | null } | null, key: NotificationToggleKey): boolean {
    if (!settings?.notificationToggles) return true;
    try {
        const toggles = JSON.parse(settings.notificationToggles);
        return toggles[key] !== false;
    } catch {
        return true;
    }
}

// Build a CC array for a secondary client email (spouse/partner).
// Returns undefined when additionalEmail is absent, empty, or identical to the primary (case-insensitive).
function buildCc(primaryEmail: string, additionalEmail?: string | null): string[] | undefined {
    if (!additionalEmail) return undefined;
    if (additionalEmail.toLowerCase() === primaryEmail.toLowerCase()) return undefined;
    return [additionalEmail];
}

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

/**
 * Validates a capturedPdfUrl before the server fetches it.
 * Prevents SSRF — only Supabase Storage URLs for our own project are allowed.
 */
function isAllowedCapturedPdfUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return false;
        // Must be a Supabase storage hostname
        if (!parsed.hostname.endsWith(".supabase.co") && !parsed.hostname.endsWith(".supabase.in")) return false;
        // Must be a storage path (object endpoint) containing our known prefixes
        const path = parsed.pathname;
        const allowedPrefixes = ["/storage/v1/object/public/", "/storage/v1/object/sign/"];
        if (!allowedPrefixes.some(p => path.startsWith(p))) return false;
        // Must be one of our upload directories
        if (!path.includes("estimate-pdfs/") && !path.includes("/signed/")) return false;
        // Must belong to our own Supabase project
        const supabaseUrl = process.env.SUPABASE_URL || "";
        if (supabaseUrl) {
            const projectHost = new URL(supabaseUrl).hostname;
            if (parsed.hostname !== projectHost && !parsed.hostname.endsWith(`.${projectHost.split(".").slice(1).join(".")}`)) {
                // Allow the pooler subdomain variations — just verify same project ref prefix
                const ourProjectRef = projectHost.split(".")[0];
                if (!parsed.hostname.startsWith(ourProjectRef)) return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Generates a short-lived HMAC token that authorises a single PDF upload for
 * the given estimateId.  Valid for 5 minutes.
 *
 * The token format is: `<estimateId>:<expiry>:<sig>`
 * where <expiry> is a Unix timestamp (seconds) and <sig> is HMAC-SHA256.
 */
export async function generatePdfUploadToken(estimateId: string): Promise<string> {
    const secret = process.env.NEXTAUTH_SECRET || "probuild-pdf-token-secret";
    const expiry = Math.floor(Date.now() / 1000) + 300; // 5 min
    const payload = `${estimateId}:${expiry}`;
    const sig = createHmac("sha256", secret).update(payload).digest("hex");
    return `${payload}:${sig}`;
}

export async function getLeads() {
    const leads = await prisma.lead.findMany({
        orderBy: { createdAt: "desc" },
        include: {
            client: true,
            estimates: safeEstimateInclude,
            manager: true,
            project: { select: { id: true } },
            tasks: {
                where: { status: { not: "Done" } },
                orderBy: { dueDate: "asc" },
                take: 1
            }
        },
    });
    return JSON.parse(JSON.stringify(leads.map((l: any) => ({
        ...l,
        targetRevenue: l.targetRevenue != null ? Number(l.targetRevenue) : null,
        expectedProfit: l.expectedProfit != null ? Number(l.expectedProfit) : null,
        estimates: (l.estimates || []).map((e: any) => ({
            ...e,
            totalAmount: e.totalAmount != null ? Number(e.totalAmount) : 0,
            balanceDue: e.balanceDue != null ? Number(e.balanceDue) : 0,
        })),
        client: l.client || { id: "unassigned", name: "No Client", email: "", primaryPhone: "", addressLine1: "", city: "", state: "", zipCode: "" }
    }))));
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
            roomDesigns: true,
            // Pull the linked project + its estimates so the lead estimates page
            // can surface project estimates alongside lead-direct ones.
            project: {
                select: {
                    id: true,
                    name: true,
                    estimates: safeEstimateInclude,
                }
            }
        },
    });
    if (lead && !lead.client) {
        (lead as any).client = { id: "unassigned", name: "No Client", email: "", primaryPhone: "", addressLine1: "", city: "", state: "", zipCode: "" };
    }
    if (lead) {
        (lead as any).targetRevenue = lead.targetRevenue != null ? Number(lead.targetRevenue) : null;
        (lead as any).expectedProfit = lead.expectedProfit != null ? Number(lead.expectedProfit) : null;
        (lead as any).estimates = ((lead as any).estimates || []).map((e: any) => ({
            ...e,
            totalAmount: e.totalAmount != null ? Number(e.totalAmount) : 0,
            balanceDue: e.balanceDue != null ? Number(e.balanceDue) : 0,
        }));
        if ((lead as any).project?.estimates) {
            (lead as any).project.estimates = ((lead as any).project.estimates || []).map((e: any) => ({
                ...e,
                totalAmount: e.totalAmount != null ? Number(e.totalAmount) : 0,
                balanceDue: e.balanceDue != null ? Number(e.balanceDue) : 0,
            }));
        }
    }
    return lead ? JSON.parse(JSON.stringify(lead)) : null;
}

export async function updateLeadStage(id: string, stage: string) {
    await prisma.lead.update({
        where: { id },
        data: { stage }
    });
    revalidatePath(`/leads/${id}`);
    revalidatePath(`/leads`);
}

export async function createLead(data: { name: string; clientName: string; clientEmail?: string; clientPhone?: string; location?: string; addressLine1?: string; city?: string; state?: string; zipCode?: string; source?: string; projectType?: string; message?: string }) {
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
                primaryPhoneE164: normalizeE164(data.clientPhone),
                addressLine1: data.addressLine1 || null,
                city: data.city || null,
                state: data.state || null,
                zipCode: data.zipCode || null,
            },
        });
    } else if (data.addressLine1 && !client.addressLine1 && !client.city && !client.state && !client.zipCode) {
        // Returning client: only fill if the entire address slot is empty.
        // A returning client may already have a billing/home address on file
        // and we must not silently overwrite it with a new lead's site address.
        client = await prisma.client.update({
            where: { id: client.id },
            data: {
                addressLine1: data.addressLine1,
                city: data.city || null,
                state: data.state || null,
                zipCode: data.zipCode || null,
            },
        });
    }

    // Dedup guard: if an identical lead for this client was created in the last 24h, return it
    const existing = await prisma.lead.findFirst({
        where: {
            clientId: client.id,
            name: data.name,
            stage: "New",
            createdAt: { gte: new Date(Date.now() - 86400000) },
        },
    });
    if (existing) return { id: existing.id };

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

    try {
        const settings = await getCompanySettings();
        if (settings.notificationEmail && isNotificationEnabled(settings, "newLead")) {
            await sendNotification(
                settings.notificationEmail,
                `New Lead: ${data.name}`,
                `<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px;">
                        <h3 style="margin: 0 0 8px; color: #166534;">New Lead Created</h3>
                        <p style="margin: 0 0 4px; color: #333;"><strong>${data.clientName}</strong> — ${data.name}</p>
                        ${data.source ? `<p style="margin: 0 0 4px; color: #666; font-size: 13px;">Source: ${data.source}</p>` : ""}
                        ${data.projectType ? `<p style="margin: 0 0 4px; color: #666; font-size: 13px;">Type: ${data.projectType}</p>` : ""}
                        ${data.location ? `<p style="margin: 0; color: #666; font-size: 13px;">Location: ${data.location}</p>` : ""}
                    </div>
                </div>`
            );
        }
    } catch (e) {
        console.error("Failed to send new lead notification:", e);
    }

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
    // Prevent deletion of leads that have a linked project — checking the FK directly is
    // authoritative. Previously this only checked stage === "Won", but any stage can be
    // linked to a project, and with unlink removed there is no recovery path from a
    // Postgres FK constraint violation.
    const linked = await prisma.project.findUnique({ where: { leadId: id }, select: { id: true } });
    if (linked) {
        throw new Error("Cannot delete a lead that has a linked project. Archive it instead.");
    }
    const lead = await prisma.lead.findUnique({ where: { id }, select: { stage: true } });
    if (lead?.stage === "Won") {
        throw new Error("Cannot delete a converted lead. Archive it instead.");
    }
    // Contract.lead FK is onDelete:SetNull — explicitly delete lead-only contracts to
    // avoid orphaning rows with both leadId=null and projectId=null after the lead is gone.
    // (Leads with a linked project are already blocked above, so all contracts here have projectId=null.)
    await prisma.contract.deleteMany({ where: { leadId: id, projectId: null } });
    await prisma.lead.delete({
        where: { id }
    });
    revalidatePath(`/leads`);
}

export async function deleteLeads(ids: string[]): Promise<{ deleted: number; skipped: { id: string; reason: string }[] }> {
    let deleted = 0;
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
        try {
            await deleteLead(id);
            deleted++;
        } catch (e: any) {
            skipped.push({ id, reason: e?.message ?? "unknown" });
        }
    }
    revalidatePath("/leads");
    return { deleted, skipped };
}

export async function copyLeads(ids: string[]): Promise<{ created: string[]; skipped: { id: string; reason: string }[] }> {
    const created: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
        try {
            const src = await prisma.lead.findUnique({ where: { id } });
            if (!src) { skipped.push({ id, reason: "not found" }); continue; }
            const copy = await prisma.lead.create({
                data: {
                    name: `${src.name} (Copy)`,
                    clientId: src.clientId,
                    stage: "New",
                    source: src.source,
                    projectType: src.projectType,
                    location: src.location,
                    targetRevenue: src.targetRevenue,
                    expectedStartDate: src.expectedStartDate,
                    tags: src.tags,
                    expectedProfit: src.expectedProfit,
                    lastActivityAt: new Date(),
                    managerId: src.managerId,
                    isUnread: true,
                    isArchived: false,
                    message: src.message,
                },
            });
            created.push(copy.id);
        } catch (e: any) {
            skipped.push({ id, reason: e?.message ?? "unknown" });
        }
    }
    revalidatePath("/leads");
    return { created, skipped };
}

export async function updateLeadAssignment(id: string, managerId: string | null) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    await prisma.lead.update({
        where: { id },
        data: { managerId }
    });
    revalidatePath(`/leads`);
    revalidatePath(`/leads/${id}`);
}

export async function updateProjectManager(projectId: string, managerId: string | null) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    await prisma.project.update({
        where: { id: projectId },
        data: { managerId }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`, 'layout');
}

export async function updateLeadInfo(id: string, data: any) {
    // data contains all the EditLeadModal form data
    const lead = await prisma.lead.findUnique({ where: { id }});
    if (!lead) return;

    const updateData: any = {
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
    };
    if (data.name !== undefined) updateData.name = data.name;

    let linkedProjectId: string | undefined;

    await prisma.$transaction(async (tx) => {
        await tx.lead.update({ where: { id }, data: updateData });

        // Sync location to linked project so the estimate header stays up to date
        if (data.location !== undefined) {
            const linked = await tx.project.findUnique({ where: { leadId: id }, select: { id: true } });
            if (linked) {
                await tx.project.update({ where: { id: linked.id }, data: { location: data.location || null } });
                linkedProjectId = linked.id;
            }
        }
    });

    // Also update client if passed in
    if (data.clientName) {
        await prisma.client.update({
            where: { id: lead.clientId },
            data: {
                name: data.clientName,
                // undefined-check: EditLeadModal always sends all address fields (initialized from
                // DB values), so these guards fire every save. Empty string → null clears the field.
                // Callers that omit a field entirely (pass undefined) preserve the existing DB value.
                ...(data.addressLine1 !== undefined ? { addressLine1: data.addressLine1 || null } : {}),
                ...(data.city !== undefined ? { city: data.city || null } : {}),
                ...(data.state !== undefined ? { state: data.state || null } : {}),
                ...(data.zipCode !== undefined ? { zipCode: data.zipCode || null } : {}),
            }
        });
    }

    revalidatePath(`/leads`);
    revalidatePath(`/leads/${id}`);
    if (linkedProjectId) revalidatePath(`/projects/${linkedProjectId}`, 'layout');
}

export async function getClients() {
    const clients = await prisma.client.findMany({
        orderBy: { name: "asc" },
        include: {
            projects: {
                include: { estimates: safeEstimateInclude }
            },
            leads: true
        }
    });
    return JSON.parse(JSON.stringify(clients));
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
            primaryPhoneE164: normalizeE164(data.primaryPhone),
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

export async function updateClient(clientId: string, data: { name?: string; email?: string; additionalEmail?: string; primaryPhone?: string; addressLine1?: string; city?: string; state?: string; zipCode?: string }) {
    "use server";
    const client = await prisma.client.update({
        where: { id: clientId },
        data: {
            name: data.name,
            email: data.email,
            additionalEmail: data.additionalEmail || undefined,
            primaryPhone: data.primaryPhone,
            // Keep E164 in sync with the raw value when caller updates the phone.
            ...(data.primaryPhone !== undefined ? { primaryPhoneE164: normalizeE164(data.primaryPhone) } : {}),
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
    revalidatePath(`/leads`);
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
            const meetingCc = buildCc(lead.client.email || "", (lead.client as any).additionalEmail);
            await sendNotification(
                lead.client.email,
                `Meeting Scheduled: ${data.title}`,
                `<p>Hi ${lead.client.name},<br><br>We have scheduled a meeting to discuss your project: ${data.title}.<br>Time: ${startDate.toLocaleString()}<br><br>Please see the attached calendar invite.<br><br>Thanks,<br>Golden Touch Remodeling</p>`,
                attachments,
                meetingCc ? { cc: meetingCc } : undefined
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
            estimates: { select: { totalAmount: true, status: true } },
        },
    });
    return JSON.parse(JSON.stringify(projects.map((p: any) => ({
        ...p,
        client: p.client || { id: "unassigned", name: "No Client", email: "", primaryPhone: "", addressLine1: "", city: "", state: "", zipCode: "" }
    }))));
}

export async function getProject(id: string) {
    const include = {
        client: true,
        estimates: safeEstimateInclude,
        roomDesigns: true,
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
    return project ? JSON.parse(JSON.stringify(project)) : null;
}

export async function convertLeadToProject(leadId: string) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new Error("Lead not found");

    // Idempotency: if this lead was already converted, return existing project
    const existingProject = await prisma.project.findUnique({ where: { leadId } });
    if (existingProject) return { id: existingProject.id };

    // Wrap entire conversion in a transaction for atomicity
    const project = await prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
            data: {
                name: lead.name,
                clientId: lead.clientId,
                location: lead.location,
                status: "In Progress",
                type: lead.projectType || "Unknown",
                managerId: lead.managerId || null,
                tags: lead.tags || null,
                leadId,
            },
        });

        // Relink child records to the new project.
        // Estimate has no onDelete:Cascade on its lead FK — keep leadId so it
        // remains visible from both the lead view and the project view.
        await tx.estimate.updateMany({ where: { leadId }, data: { projectId: project.id } });
        // RoomDesign has an owner-XOR CHECK constraint (projectId XOR leadId), so we must
        // clear leadId when setting projectId in the same transaction.
        await tx.roomDesign.updateMany({ where: { leadId }, data: { projectId: project.id, leadId: null } });
        // Contract.lead FK is onDelete:SetNull — keep leadId so contracts remain visible from
        // both the lead view and the project view (same pattern as Estimate).
        await tx.contract.updateMany({ where: { leadId }, data: { projectId: project.id } });
        // The remaining models still have onDelete:Cascade on their lead FK — clear leadId.
        await tx.projectFile.updateMany({ where: { leadId }, data: { projectId: project.id, leadId: null } });
        await tx.fileFolder.updateMany({ where: { leadId }, data: { projectId: project.id, leadId: null } });
        await tx.scheduleTask.updateMany({ where: { leadId }, data: { projectId: project.id, leadId: null } });
        await tx.takeoff.updateMany({ where: { leadId }, data: { projectId: project.id, leadId: null } });
        await tx.clientMessage.updateMany({ where: { leadId }, data: { projectId: project.id, leadId: null } });

        await tx.lead.update({ where: { id: leadId }, data: { stage: "Won" } });

        return project;
    });

    // Auto-grant access to eligible team members
    const { autoGrantProjectAccessToEligibleUsers } = await import("@/lib/auto-grant-project-access");
    await autoGrantProjectAccessToEligibleUsers(project.id);

    revalidatePath("/leads");
    revalidatePath("/projects");
    revalidatePath(`/leads/${leadId}`);

    return { id: project.id };
}

export async function createDraftEstimate(projectId: string) {
    const estimate = await prisma.estimate.create({
        data: {
            title: "Draft Estimate",
            projectId,
            code: "EST-TEMP",
            status: "Draft",
            totalAmount: 0,
            balanceDue: 0,
            privacy: "Shared",
        },
    });

    // Use the DB-assigned autoincrement number for a collision-free code
    const code = `EST-${String(estimate.number).padStart(5, "0")}`;
    await prisma.estimate.update({ where: { id: estimate.id }, data: { code } });

    revalidatePath(`/projects/${projectId}/estimates`);
    return { id: estimate.id };
}

export async function createDraftLeadEstimate(leadId: string) {
    const estimate = await prisma.estimate.create({
        data: {
            title: "Draft Estimate",
            leadId,
            code: "EST-TEMP",
            status: "Draft",
            totalAmount: 0,
            balanceDue: 0,
            privacy: "Shared",
        },
    });

    const code = `EST-${String(estimate.number).padStart(5, "0")}`;
    await prisma.estimate.update({ where: { id: estimate.id }, data: { code } });

    revalidatePath(`/leads/${leadId}`);
    return { id: estimate.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Room Designer (Stage 0) — replaces the old FloorPlan actions. Supports both
// projects and leads (same owner-XOR pattern as Estimate). Mutations enforce
// the XOR at the app layer; the DB also has a CHECK constraint for defense.
//
// SECURITY: every function below resolves the caller from NextAuth and verifies
// ownership before touching a row. The /api/rooms route layer has its own
// guards; these duplicate them so server-action callers (form posts, Next
// Link traversal to server components) can't bypass auth by calling the action
// directly.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveCaller() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, role: true },
    });
}

async function callerCanAccessProject(caller: { id: string; role: string }, projectId: string) {
    if (caller.role === "ADMIN" || caller.role === "MANAGER") return true;
    const pa = await prisma.projectAccess.findFirst({
        where: { userId: caller.id, projectId },
        select: { id: true },
    });
    if (pa) return true;
    const crew = await prisma.project.findFirst({
        where: { id: projectId, crew: { some: { id: caller.id } } },
        select: { id: true },
    });
    return !!crew;
}

async function callerCanAccessLead(caller: { id: string; role: string }, leadId: string) {
    if (caller.role === "ADMIN" || caller.role === "MANAGER") return true;
    const lead = await prisma.lead.findFirst({
        where: { id: leadId, managerId: caller.id },
        select: { id: true },
    });
    return !!lead;
}

async function callerCanAccessRoom(
    caller: { id: string; role: string },
    room: { projectId: string | null; leadId: string | null },
) {
    if (caller.role === "ADMIN" || caller.role === "MANAGER") return true;
    if (room.projectId) return callerCanAccessProject(caller, room.projectId);
    if (room.leadId) return callerCanAccessLead(caller, room.leadId);
    return false;
}

export async function createDraftRoom(opts: {
    projectId?: string;
    leadId?: string;
    name?: string;
    roomType?: RoomType;
}) {
    const caller = await resolveCaller();
    if (!caller) throw new Error("Unauthorized");

    const { projectId, leadId, name, roomType } = opts;
    if (!!projectId === !!leadId) {
        throw new Error("createDraftRoom requires exactly one of projectId or leadId");
    }
    if (projectId && !(await callerCanAccessProject(caller, projectId))) throw new Error("Forbidden");
    if (leadId && !(await callerCanAccessLead(caller, leadId))) throw new Error("Forbidden");

    const room = await prisma.roomDesign.create({
        data: {
            name: name ?? "New Room",
            roomType: roomType ?? "kitchen",
            projectId: projectId ?? null,
            leadId: leadId ?? null,
            layoutJson: buildDefaultLayout() as any,
        },
    });
    if (projectId) revalidatePath(`/projects/${projectId}/room-designer`);
    if (leadId) revalidatePath(`/leads/${leadId}/room-designer`);
    return { id: room.id };
}

export async function getRoom(id: string) {
    const caller = await resolveCaller();
    if (!caller) return null;

    const room = await prisma.roomDesign.findUnique({
        where: { id },
        include: { assets: true },
    });
    if (!room) return null;
    if (!(await callerCanAccessRoom(caller, room))) return null;
    return JSON.parse(JSON.stringify(room));
}

export async function deleteRoom(id: string) {
    const caller = await resolveCaller();
    if (!caller) throw new Error("Unauthorized");

    const room = await prisma.roomDesign.findUnique({
        where: { id },
        select: { projectId: true, leadId: true },
    });
    if (!room) return { success: false };
    if (!(await callerCanAccessRoom(caller, room))) throw new Error("Forbidden");

    await prisma.roomDesign.delete({ where: { id } });
    if (room.projectId) revalidatePath(`/projects/${room.projectId}/room-designer`);
    if (room.leadId) revalidatePath(`/leads/${room.leadId}/room-designer`);
    return { success: true };
}

export async function renameRoom(id: string, name: string) {
    const caller = await resolveCaller();
    if (!caller) throw new Error("Unauthorized");

    const trimmed = name.trim();
    if (!trimmed) throw new Error("Room name cannot be empty");

    const existing = await prisma.roomDesign.findUnique({
        where: { id },
        select: { projectId: true, leadId: true },
    });
    if (!existing) throw new Error("Room not found");
    if (!(await callerCanAccessRoom(caller, existing))) throw new Error("Forbidden");

    const room = await prisma.roomDesign.update({
        where: { id },
        data: { name: trimmed },
        select: { projectId: true, leadId: true },
    });
    if (room.projectId) revalidatePath(`/projects/${room.projectId}/room-designer`);
    if (room.leadId) revalidatePath(`/leads/${room.leadId}/room-designer`);
    return { success: true };
}

export async function listRoomsForProject(projectId: string) {
    const caller = await resolveCaller();
    if (!caller) return [];
    if (!(await callerCanAccessProject(caller, projectId))) return [];

    const rooms = await prisma.roomDesign.findMany({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true, name: true, roomType: true, thumbnail: true,
            updatedAt: true, createdAt: true,
        },
    });
    return JSON.parse(JSON.stringify(rooms));
}

export async function listRoomsForLead(leadId: string) {
    const caller = await resolveCaller();
    if (!caller) return [];
    if (!(await callerCanAccessLead(caller, leadId))) return [];

    const rooms = await prisma.roomDesign.findMany({
        where: { leadId },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true, name: true, roomType: true, thumbnail: true,
            updatedAt: true, createdAt: true,
        },
    });
    return JSON.parse(JSON.stringify(rooms));
}

export async function getEstimate(id: string) {
    try {
        // Full query — works when all schema columns exist in DB
        return await prisma.estimate.findUnique({
            where: { id },
            include: {
                items: {
                    orderBy: { order: "asc" },
                    include: {
                        expenses: true,
                        costCode: true,
                        costType: true,
                        purchaseOrder: { include: { vendor: true } },
                    },
                },
                paymentSchedules: { orderBy: { order: "asc" } },
                expenses: true,
                files: { orderBy: { createdAt: "desc" } },
            },
        });
    } catch {
        // Safe fallback — omit columns not yet migrated to DB
        // TODO: remove after running: gh workflow run db-push.yml --repo Clarion1631/probuild
        return await prisma.estimate.findUnique({
            where: { id },
            select: {
                id: true, number: true, title: true, projectId: true, leadId: true,
                code: true, status: true, privacy: true, createdAt: true,
                totalAmount: true, balanceDue: true, taxExempt: true,
                taxRateName: true, taxRatePercent: true,
                approvedBy: true, approvedAt: true,
                approvalUserAgent: true, signatureUrl: true, contractId: true, viewedAt: true,
                items: {
                    orderBy: { order: "asc" },
                    select: {
                        id: true, estimateId: true, name: true, description: true, type: true,
                        quantity: true, baseCost: true, markupPercent: true, unitCost: true,
                        total: true, order: true, parentId: true,
                        costCodeId: true, costTypeId: true, createdAt: true,
                        expenses: true, costCode: true, costType: true,
                        approvalStatus: true, approvalNote: true,
                        purchaseOrderId: true,
                        budgetQuantity: true, budgetUnit: true, budgetRate: true,
                        purchaseOrder: { select: { id: true, code: true, totalAmount: true, status: true, vendor: { select: { id: true, name: true } } } },
                    },
                },
                paymentSchedules: { orderBy: { order: "asc" } },
                expenses: true,
            },
        });
    }
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
    // Staff members (any user with a role on their session) can preview any estimate.
    // Portal clients must pass the IDOR ownership check below.
    const staffSession = await getServerSession(authOptions);
    const isStaff = !!(staffSession?.user as any)?.role;

    if (!isStaff) {
        // IDOR #2 fix: require a resolvable portal session and gate the fetch by
        // the estimate's owning clientId chain (project.clientId OR lead.clientId).
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) return null;

        // Restrict the query to the client's own estimates below
        const ownershipFilter = {
            id,
            OR: [
                { project: { is: { clientId: sessionClientId } } },
                { lead: { is: { clientId: sessionClientId } } },
            ],
        };

        let estimate: any;
        try {
            estimate = await prisma.estimate.findFirst({
                where: ownershipFilter,
                include: {
                    project: { include: { client: true } },
                    lead: { include: { client: true } },
                    items: { orderBy: { order: "asc" } },
                    paymentSchedules: { orderBy: { order: "asc" } },
                },
            });
        } catch (err) {
            console.error("[getEstimateForPortal] Primary query failed:", err);
            try {
                estimate = await prisma.estimate.findFirst({
                    where: ownershipFilter,
                    select: {
                        id: true, number: true, title: true, projectId: true, leadId: true,
                        code: true, status: true, privacy: true, createdAt: true,
                        totalAmount: true, balanceDue: true, taxExempt: true,
                        taxRateName: true, taxRatePercent: true,
                        approvedBy: true, approvedAt: true,
                        approvalUserAgent: true, signatureUrl: true, contractId: true, viewedAt: true,
                        project: { include: { client: true } },
                        lead: { include: { client: true } },
                        items: {
                            orderBy: { order: "asc" },
                            select: {
                                id: true, estimateId: true, name: true, description: true, type: true,
                                quantity: true, baseCost: true, markupPercent: true, unitCost: true,
                                total: true, order: true, parentId: true,
                                costCodeId: true, costTypeId: true, createdAt: true,
                            },
                        },
                        paymentSchedules: { orderBy: { order: "asc" } },
                    },
                });
            } catch (fallbackErr) {
                console.error("[getEstimateForPortal] Fallback query also failed:", fallbackErr);
                return null;
            }
        }

        if (!estimate) return null;

        return JSON.parse(JSON.stringify({
            ...estimate,
            projectName: estimate.project?.name || estimate.lead?.name || null,
            clientName: estimate.project?.client?.name || estimate.lead?.client?.name || "Unknown Client",
            clientEmail: estimate.project?.client?.email || estimate.lead?.client?.email || null,
            jobsiteAddress: estimate.project?.location || estimate.lead?.location || null,
        }));
    }

    // Staff path: no ownership restriction — just fetch by id
    let estimate: any;
    try {
        estimate = await prisma.estimate.findFirst({
            where: { id },
            include: {
                project: { include: { client: true } },
                lead: { include: { client: true } },
                items: { orderBy: { order: "asc" } },
                paymentSchedules: { orderBy: { order: "asc" } },
            },
        });
    } catch (err) {
        console.error("[getEstimateForPortal] Primary query failed:", err);
        try {
            estimate = await prisma.estimate.findFirst({
                where: { id },
                select: {
                    id: true, number: true, title: true, projectId: true, leadId: true,
                    code: true, status: true, privacy: true, createdAt: true,
                    totalAmount: true, balanceDue: true, taxExempt: true,
                    approvedBy: true, approvedAt: true,
                    approvalUserAgent: true, signatureUrl: true, contractId: true, viewedAt: true,
                    project: { include: { client: true } },
                    lead: { include: { client: true } },
                    items: {
                        orderBy: { order: "asc" },
                        select: {
                            id: true, estimateId: true, name: true, description: true, type: true,
                            quantity: true, baseCost: true, markupPercent: true, unitCost: true,
                            total: true, order: true, parentId: true,
                            costCodeId: true, costTypeId: true, createdAt: true,
                        },
                    },
                    paymentSchedules: { orderBy: { order: "asc" } },
                },
            });
        } catch (fallbackErr) {
            console.error("[getEstimateForPortal] Fallback query also failed:", fallbackErr);
            return null;
        }
    }

    if (!estimate) return null;

    return JSON.parse(JSON.stringify({
        ...estimate,
        projectName: estimate.project?.name || estimate.lead?.name || null,
        clientName: estimate.project?.client?.name || estimate.lead?.client?.name || "Unknown Client",
        clientEmail: estimate.project?.client?.email || estimate.lead?.client?.email || null,
        jobsiteAddress: estimate.project?.location || estimate.lead?.location || null,
    }));
}

/** Returns the id of the "Payment in Full" schedule for an estimate, creating one if none exist.
 *  Amount is always derived server-side from balanceDue to prevent client-side manipulation.
 *  Race-safe: catches P2002 on concurrent creates and re-reads the winner. */
export async function ensureEstimatePayInFullSchedule(estimateId: string): Promise<string> {
    "use server";
    // Derive amount from canonical server data — never accept it from the client
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { balanceDue: true, totalAmount: true },
    });
    if (!estimate) throw new Error("Estimate not found");
    const amount = Number(estimate.balanceDue ?? estimate.totalAmount ?? 0);
    if (amount <= 0) throw new Error("Estimate has no balance due");

    // Return existing schedule if one exists (handles abandoned Stripe sessions too)
    const existing = await prisma.estimatePaymentSchedule.findFirst({
        where: { estimateId, name: "Payment in Full" },
        select: { id: true },
    });
    if (existing) return existing.id;

    try {
        const created = await prisma.estimatePaymentSchedule.create({
            data: {
                estimateId,
                name: "Payment in Full",
                amount,
                order: 0,
                status: "Pending",
            },
            select: { id: true },
        });
        return created.id;
    } catch (e: any) {
        // Race: concurrent request already created it — read the winner
        if (e.code === "P2002") {
            const winner = await prisma.estimatePaymentSchedule.findFirst({
                where: { estimateId, name: "Payment in Full" },
                select: { id: true },
            });
            if (winner) return winner.id;
        }
        throw e;
    }
}

export async function getAllEstimates() {
    return await prisma.estimate.findMany({
        orderBy: { createdAt: "desc" },
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
            project: {
                select: { name: true, client: { select: { name: true } } }
            },
            lead: {
                select: { name: true, client: { select: { name: true } } }
            },
        },
    });
}

// Race-safe find-or-create for the client MessageThread (subcontractorId IS NULL).
// Exported for use in API route handlers that can't import server actions directly.
// The partial unique index "MessageThread_projectId_client_unique" makes this safe under concurrency:
// if two requests both see no thread and both call create, the second will get P2002 and re-read.
export async function findOrCreateClientThread(projectId: string) {
    let thread = await prisma.messageThread.findFirst({
        where: { projectId, subcontractorId: null },
        orderBy: { createdAt: "asc" },
    });
    if (!thread) {
        try {
            thread = await prisma.messageThread.create({
                data: { projectId, subcontractorId: null },
            });
        } catch (e: any) {
            if (e?.code === "P2002") {
                // Race: another request created it — re-read
                thread = await prisma.messageThread.findFirst({
                    where: { projectId, subcontractorId: null },
                    orderBy: { createdAt: "asc" },
                });
            } else {
                throw e;
            }
        }
    }
    if (!thread) throw new Error(`Failed to find or create MessageThread for project ${projectId}`);
    return thread;
}

export async function logActivity({
    projectId,
    actorType,
    actorName,
    action,
    entityType,
    entityId,
    entityName,
    metadata,
}: {
    projectId: string;
    actorType: string;
    actorName: string;
    action: string;
    entityType?: string;
    entityId?: string;
    entityName?: string;
    metadata?: Record<string, unknown>;
}) {
    try {
        await prisma.activityLog.create({
            data: {
                projectId,
                actorType,
                actorName,
                action,
                entityType: entityType ?? null,
                entityId: entityId ?? null,
                entityName: entityName ?? null,
                metadata: metadata ? JSON.stringify(metadata) : null,
            },
        });
    } catch (err) {
        console.error("[logActivity] Failed:", err);
    }
}

export async function logPortalVisit(projectId: string, clientName: string) {
    // Dedup: skip if a portal visit was logged in the last 30 minutes
    const recent = await prisma.activityLog.findFirst({
        where: {
            projectId,
            action: "viewed_portal",
            createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
        },
    });
    if (!recent) {
        await logActivity({
            projectId,
            actorType: "CLIENT",
            actorName: clientName,
            action: "viewed_portal",
            entityType: "project",
            entityId: projectId,
        });
    }
}

/**
 * Append a system-generated event line (contract sent / viewed / signed) onto the
 * lead's ClientMessage thread or the project's Message thread, so team members
 * see the event inline with other messages on the detail page.
 *
 * IMPORTANT — field semantics (Codex peer review blocker #3):
 *
 * These rows are NOT outbound communications — no email was sent, no SMS went
 * out. They are system events that happen to share the messaging surface for
 * display purposes. To avoid corrupting message history and confusing other
 * subsystems, every field carries a distinct SYSTEM sentinel:
 *
 *   - `direction: "SYSTEM"` (not INBOUND/OUTBOUND). Anything filtering on
 *     real directions skips these cleanly.
 *   - `channel:   "system"` (not email/sms/both/app). The scheduled-message
 *     cron filters on `status: "SCHEDULED"` so these will never be re-sent,
 *     but using a distinct channel also makes them filterable anywhere else.
 *   - `status:    "SYSTEM"` (not SENT/SCHEDULED/FAILED). Never matched by the
 *     cron's `SCHEDULED` query; explicit enough for any downstream filter.
 *   - `sentViaEmail: false`, `sentViaSms: false` — nothing actually went out.
 *
 * Client-facing API routes must exclude SYSTEM rows before returning messages
 * to a portal client (the current routes don't expose ClientMessage to clients,
 * only to the team, so this is belt-and-suspenders).
 *
 * Errors are swallowed on purpose: a system-log write failure must never block
 * the primary action (contract send / sign / view). Log and move on.
 */
async function postActivityToThread(leadId: string | null, projectId: string | null, body: string) {
    try {
        if (leadId) {
            // Resolve clientId for unified conversation view
            const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { clientId: true } });
            await prisma.clientMessage.create({
                data: {
                    clientId: lead?.clientId ?? null,
                    leadId,
                    direction: "SYSTEM",     // distinct from INBOUND/OUTBOUND real messages
                    senderName: "System",
                    body,
                    channel: "system",       // distinct from email/sms/both/app
                    status: "SYSTEM",        // never matched by the SCHEDULED cron
                    sentViaEmail: false,
                    sentViaSms: false,
                },
            });
        } else if (projectId) {
            const thread = await findOrCreateClientThread(projectId);
            await prisma.message.create({
                data: {
                    threadId: thread.id,
                    senderType: "SYSTEM",    // was "TEAM"; distinct from real sender types
                    senderName: "System",
                    body,
                },
            });
        }
    } catch (err) {
        console.error("[postActivityToThread] Failed:", err);
    }
}

export async function markEstimateViewed(estimateId: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { viewedAt: true, title: true, code: true, projectId: true, leadId: true, project: { select: { name: true, client: { select: { name: true } } } }, lead: { select: { name: true, client: { select: { name: true } } } } },
    });

    if (estimate && !estimate.viewedAt) {
        await prisma.estimate.update({
            where: { id: estimateId },
            data: { viewedAt: new Date() },
        });

        const clientName = estimate.project?.client?.name || estimate.lead?.client?.name || "A client";
        const projectName = estimate.project?.name || estimate.lead?.name || "";
        const settings = await getCompanySettings();
        if (settings.notificationEmail && isNotificationEnabled(settings, "estimateViewed")) {
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

        // Post activity to message thread
        await postActivityToThread(
            estimate.leadId, estimate.projectId,
            `👁️ ${clientName} viewed estimate ${estimate.title || estimate.code}`
        );

        // Log to activity feed
        if (estimate.projectId) {
            await logActivity({
                projectId: estimate.projectId,
                actorType: "CLIENT",
                actorName: clientName,
                action: "viewed_estimate",
                entityType: "estimate",
                entityId: estimateId,
                entityName: `Estimate ${estimate.code || estimate.title}`,
            });
        }
    }
}

export async function markContractViewed(contractId: string, accessToken?: string) {
    // Ownership gate — same shape as approveContract. Either the caller presents a
    // matching accessToken (magic-link path, no session) or the logged-in portal session
    // resolves to the exact client that owns the lead/project. Unknown callers get a
    // silent no-op (idempotent) to avoid leaking existence via a thrown error.
    const sessionClientId = await resolveSessionClientId();

    const ownershipClauses: any[] = [];
    if (accessToken) ownershipClauses.push({ accessToken });
    if (sessionClientId) {
        ownershipClauses.push({ lead: { clientId: sessionClientId } });
        ownershipClauses.push({ project: { clientId: sessionClientId } });
    }
    if (ownershipClauses.length === 0) return;

    const contract = await prisma.contract.findFirst({
        where: { id: contractId, OR: ownershipClauses },
        select: { viewedAt: true, title: true, projectId: true, leadId: true, project: { select: { name: true, client: { select: { name: true } } } }, lead: { select: { name: true, client: { select: { name: true } } } } },
    });

    if (contract && !contract.viewedAt) {
        await prisma.contract.updateMany({
            where: { id: contractId, status: "Sent" },
            data: { viewedAt: new Date(), status: "Viewed" },
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

        // Post activity to lead/project thread so it surfaces in Recent Activity
        await postActivityToThread(
            contract.leadId ?? null,
            contract.projectId ?? null,
            `👁️ ${clientName} viewed contract "${contract.title}"`
        );

        // Log to project activity feed
        if (contract.projectId) {
            const projectId = contract.projectId;
            await logActivity({
                projectId,
                actorType: "CLIENT",
                actorName: clientName,
                action: "viewed_contract",
                entityType: "contract",
                entityId: contractId,
                entityName: `Contract "${contract.title}"`,
            });
        }
    }
}

export async function approveEstimate(estimateId: string, signatureName: string, userAgent: string, signatureDataUrl?: string, capturedPdfUrl?: string) {
    // Auth: internal admins skip ownership check; portal clients must prove ownership.
    const session = await getServerSession(authOptions);
    let isAdmin = false;
    if (session?.user?.email) {
        const internalUser = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { role: true },
        });
        isAdmin = !!internalUser && ["ADMIN", "MANAGER"].includes(internalUser.role);
    }
    if (!isAdmin) {
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) return null;
        const owned = await prisma.estimate.findFirst({
            where: {
                id: estimateId,
                OR: [
                    { project: { clientId: sessionClientId } },
                    { lead: { clientId: sessionClientId } },
                ],
            },
            select: { id: true },
        });
        if (!owned) return null;
    }

    const approvedAt = new Date();

    await prisma.estimate.update({
        where: { id: estimateId },
        data: {
            status: "Approved",
            approvedBy: signatureName,
            approvedAt,
            approvalUserAgent: userAgent,
            signatureUrl: signatureDataUrl || null,
        },
    });

    // Fetch full estimate data for emails and filing
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: {
            projectId: true, leadId: true, code: true, title: true,
            project: { select: { id: true, name: true, client: { select: { name: true, email: true, additionalEmail: true } } } },
            lead: { select: { name: true, client: { select: { name: true, email: true, additionalEmail: true } } } },
        },
    });

    const settings = await getCompanySettings();
    const companyName = settings.companyName || "Golden Touch Remodeling";
    const estimateCode = estimate?.code || estimateId;
    const projectName = estimate?.project?.name || estimate?.lead?.name || "your project";
    const clientName = estimate?.project?.client?.name || estimate?.lead?.client?.name || signatureName;
    const clientEmail = estimate?.project?.client?.email || estimate?.lead?.client?.email || null;
    const clientAdditionalEmail = estimate?.project?.client?.additionalEmail || estimate?.lead?.client?.additionalEmail || null;
    const pdfFilename = `Signed_Estimate_${estimateCode}.pdf`;

    // Generate PDF — prefer the portal-captured version (pixel-perfect), fall back to pdf-lib
    let pdfBuffer: Buffer | null = null;
    let attachments: any = undefined;
    try {
        if (capturedPdfUrl && isAllowedCapturedPdfUrl(capturedPdfUrl)) {
            const res = await fetch(capturedPdfUrl);
            if (res.ok) {
                const ab = await res.arrayBuffer();
                pdfBuffer = Buffer.from(ab);
            }
        } else if (capturedPdfUrl) {
            console.warn("[approveEstimate] Rejected capturedPdfUrl (failed allowlist):", capturedPdfUrl);
        }
        if (!pdfBuffer) {
            const { generateEstimatePdf } = await import("./pdf");
            pdfBuffer = await generateEstimatePdf(estimateId);
        }
        if (pdfBuffer) {
            attachments = [{ filename: pdfFilename, content: pdfBuffer }];
        }
    } catch (e) {
        console.error("Failed to generate PDF snapshot for signed estimate:", e);
    }

    // ─── 1. Email the CUSTOMER a professional confirmation ───
    if (clientEmail) {
        const approvedCc = buildCc(clientEmail || "", clientAdditionalEmail);
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
            { fromName: companyName, replyTo: settings.email || undefined, cc: approvedCc }
        );
    }

    // ─── 2. Email the COMPANY notification ───
    if (settings.notificationEmail && isNotificationEnabled(settings, "estimateSigned")) {
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

    // Post activity to message thread
    if (estimate) {
        await postActivityToThread(
            estimate.leadId, estimate.projectId,
            `✅ ${signatureName} signed and approved estimate ${estimate.code || estimate.title}`
        );
    }

    // Log to activity feed
    if (estimate?.projectId) {
        await logActivity({
            projectId: estimate.projectId,
            actorType: "CLIENT",
            actorName: signatureName,
            action: "signed_estimate",
            entityType: "estimate",
            entityId: estimateId,
            entityName: `Estimate ${estimate.code || estimate.title}`,
        });
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

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const clientId = invoice.clientId || invoice.project?.clientId;
    let portalUrl: string;
    if (clientId) {
        const { signClientPortalToken } = await import("./client-portal-auth");
        const token = await signClientPortalToken(clientId, recipientEmail.toLowerCase());
        portalUrl = `${appUrl}/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(`/portal/invoices/${invoiceId}`)}`;
    } else {
        portalUrl = `${appUrl}/portal/invoices/${invoiceId}`;
    }
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

    const invoiceAdditionalEmail = invoice.client?.additionalEmail || invoice.project?.client?.additionalEmail || null;
    const invoiceCc = buildCc(recipientEmail, invoiceAdditionalEmail);
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
                    ${companyName} has sent you an invoice for <strong>${formatCurrency(invoice.totalAmount)}</strong>.
                    Please click the button below to view the details and make a payment.
                </p>
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${portalUrl}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        View & Pay Invoice
                    </a>
                </div>
                <div style="background: #f9fafb; border-radius: 8px; padding: 16px; text-align: center;">
                    <div style="color: #666; font-size: 13px; margin-bottom: 4px;">Amount Due</div>
                    <div style="font-size: 24px; font-weight: 700; color: #111;">${formatCurrency(invoice.balanceDue)}</div>
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
        { fromName: companyName, replyTo: settings?.email || undefined, cc: invoiceCc }
    );

    // Log to activity feed (project-scoped only)
    if (invoice.projectId) {
        await logActivity({
            projectId: invoice.projectId,
            actorType: "TEAM",
            actorName: companyName,
            action: "sent_invoice",
            entityType: "invoice",
            entityId: invoiceId,
            entityName: `Invoice ${invoice.code}`,
        });
    }

    if (invoice.projectId) {
        revalidatePath(`/projects/${invoice.projectId}/invoices`);
        revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    }
    revalidatePath(`/invoices`);
    return { success: true, sentTo: recipientEmail };
}

export async function getInvoiceForPortal(id: string) {
    const staffSession = await getServerSession(authOptions);
    const isStaff = ["ADMIN", "MANAGER"].includes((staffSession?.user as any)?.role);

    if (!isStaff) {
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) return null;

        try {
            const invoice = await prisma.invoice.findFirst({
                where: {
                    id,
                    OR: [
                        { clientId: sessionClientId },
                        { project: { clientId: sessionClientId } },
                    ],
                },
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
        } catch (err) {
            console.error("[getInvoiceForPortal] Query failed:", err);
            return null;
        }
    }

    try {
        const invoice = await prisma.invoice.findFirst({
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
    } catch (err) {
        console.error("[getInvoiceForPortal] Query failed:", err);
        return null;
    }
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
        if (settings.notificationEmail && isNotificationEnabled(settings, "invoiceViewed")) {
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
    // Update estimate — try full update, fallback to safe fields if columns missing.
    // targetMarginPercent must live in safeData so a failure on the main payload does
    // not silently revert the AI budget target to the default.

    // Preserve payment credits: subtract already-paid milestones from totalAmount
    const paidMilestones = await prisma.estimatePaymentSchedule.findMany({
        where: { estimateId, status: "Paid" },
        select: { amount: true },
    });
    const paidSum = paidMilestones.reduce((sum, s) => sum + toNum(s.amount), 0);
    const computedBalance = Math.max(0, (data.totalAmount || 0) - paidSum);
    const computedStatus = paidSum > 0
        ? (computedBalance <= 0 ? "Paid" : "Partially Paid")
        : data.status;

    const safeData = {
        title: data.title,
        code: data.code,
        status: computedStatus,
        totalAmount: data.totalAmount,
        balanceDue: computedBalance,
        ...(data.signatureUrl !== undefined && { signatureUrl: data.signatureUrl }),
        ...(data.targetMarginPercent !== undefined && {
            targetMarginPercent: Math.max(0, Math.min(70, parseFloat(data.targetMarginPercent) || 25)),
        }),
    };
    try {
        await prisma.estimate.update({
            where: { id: estimateId },
            data: {
                ...safeData,
                ...(data.processingFeeMarkup !== undefined && { processingFeeMarkup: data.processingFeeMarkup }),
                ...(data.hideProcessingFee !== undefined && { hideProcessingFee: data.hideProcessingFee }),
                ...(data.expirationDate !== undefined && { expirationDate: data.expirationDate }),
                ...(data.memo !== undefined && { memo: data.memo }),
                ...(data.termsAndConditions !== undefined && { termsAndConditions: data.termsAndConditions }),
                ...(data.taxExempt !== undefined && { taxExempt: !!data.taxExempt }),
                ...(data.taxRateName !== undefined && { taxRateName: data.taxRateName }),
                ...(data.taxRatePercent !== undefined && { taxRatePercent: data.taxRatePercent }),
            },
        });
    } catch {
        await prisma.estimate.update({ where: { id: estimateId }, data: safeData });
    }

    // Delete existing items and NON-PAID schedules, then batch-insert replacements
    // Preserve Paid schedules so payment history survives estimate edits
    await prisma.estimateItem.deleteMany({ where: { estimateId } });
    await prisma.estimatePaymentSchedule.deleteMany({ where: { estimateId, status: { not: "Paid" } } });

    // Build item data — split parents/children so FK ordering is respected
    const toItemData = (item: any, fallbackOrder: number) => ({
        ...(item.id ? { id: item.id } : {}),
        estimateId,
        name: item.name,
        description: item.description || "",
        type: item.type,
        quantity: parseFloat(item.quantity) || 0,
        baseCost: item.baseCost != null ? (parseFloat(item.baseCost) || 0) : null,
        markupPercent: parseFloat(item.markupPercent) || 25,
        unitCost: parseFloat(item.unitCost) || 0,
        total: parseFloat(item.total) || 0,
        order: item.order ?? fallbackOrder,
        parentId: item.parentId || null,
        costCodeId: item.costCodeId || null,
        costTypeId: item.costTypeId || null,
        purchaseOrderId: item.purchaseOrderId || null,
        budgetQuantity: item.budgetQuantity != null ? (parseFloat(item.budgetQuantity) || null) : null,
        budgetUnit: item.budgetUnit || null,
        budgetRate: item.budgetRate != null ? (parseFloat(item.budgetRate) || null) : null,
    });

    const parentItems = items.filter((i: any) => !i.parentId);
    const childItems  = items.filter((i: any) =>  i.parentId);

    if (parentItems.length > 0) {
        await prisma.estimateItem.createMany({ data: parentItems.map(toItemData) });
    }
    if (childItems.length > 0) {
        await prisma.estimateItem.createMany({ data: childItems.map(toItemData) });
    }

    // Batch-insert payment schedules (skip Paid ones — they were preserved above)
    const schedules = (data.paymentSchedules || []).filter((s: any) => s.status !== "Paid");
    if (schedules.length > 0) {
        await prisma.estimatePaymentSchedule.createMany({
            data: schedules.map((schedule: any, idx: number) => ({
                ...(schedule.id ? { id: schedule.id } : {}),
                estimateId,
                name: schedule.name,
                percentage: schedule.percentage ? parseFloat(schedule.percentage) : null,
                amount: parseFloat(schedule.amount) || 0,
                dueDate: schedule.dueDate ? new Date(schedule.dueDate) : null,
                order: schedule.order ?? idx,
            })),
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

    // Update balance — round to 2 decimal places to avoid floating-point drift
    const newBalance = Math.max(0, Math.round((Number(estimate.balanceDue) - data.amount) * 100) / 100);
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
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: safeEstimateSelect,
    });
    if (!estimate) throw new Error("Estimate not found");

    let archived: boolean;
    try {
        // Try archivedAt column (may not exist in DB yet)
        const full = await prisma.estimate.findUnique({ where: { id: estimateId }, select: { archivedAt: true } });
        const isArchived = !!full?.archivedAt;
        await prisma.estimate.update({
            where: { id: estimateId },
            data: { archivedAt: isArchived ? null : new Date() },
        });
        archived = !isArchived;
    } catch {
        // Fallback: use status field as proxy for archival
        const isArchived = estimate.status === "Archived";
        await prisma.estimate.update({
            where: { id: estimateId },
            data: { status: isArchived ? "Draft" : "Archived" },
        });
        archived = !isArchived;
    }

    if (estimate.projectId) {
        revalidatePath(`/projects/${estimate.projectId}/estimates`);
        revalidatePath(`/projects/${estimate.projectId}/estimates/${estimateId}`);
    }
    if (estimate.leadId) {
        revalidatePath(`/leads/${estimate.leadId}`);
        revalidatePath(`/leads/${estimate.leadId}/estimates`);
    }
    return { success: true, archived };
}

// Returns the default sales tax rate (percent, e.g. 8.8) from CompanySettings.
// Returns 0 if no default is configured. Safe to call often — the singleton row is tiny.
async function getDefaultSalesTaxRate(): Promise<number> {
    const settings = await prisma.companySettings.findUnique({
        where: { id: "singleton" },
        select: { salesTaxes: true },
    });
    if (!settings?.salesTaxes) return 0;
    try {
        const taxes = JSON.parse(settings.salesTaxes) as Array<{ name?: string; rate?: number; isDefault?: boolean }>;
        if (!Array.isArray(taxes) || taxes.length === 0) return 0;
        const def = taxes.find(t => t.isDefault) || taxes[0];
        return typeof def.rate === "number" ? def.rate : 0;
    } catch {
        return 0;
    }
}

// Reverse-out tax from a total (total = subtotal + subtotal * rate/100).
// If exempt or rate <= 0, the whole amount is subtotal and taxAmount is 0.
function deriveInvoiceTaxFields(totalAmount: number, ratePercent: number, isExempt: boolean) {
    if (isExempt || ratePercent <= 0) {
        return { subtotal: totalAmount, taxRate: 0, taxAmount: 0 };
    }
    const factor = ratePercent / (100 + ratePercent);
    const taxAmount = Math.round(totalAmount * factor * 100) / 100;
    const subtotal = Math.round((totalAmount - taxAmount) * 100) / 100;
    return { subtotal, taxRate: ratePercent, taxAmount };
}

export async function createInvoiceFromEstimate(estimateId: string) {
    const estimate = await prisma.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) throw new Error("Estimate not found");

    const project = await prisma.project.findUnique({ where: { id: estimate.projectId! } });
    if (!project) throw new Error("Project not found");

    const total = toNum(estimate.totalAmount || 0);
    const rate = await getDefaultSalesTaxRate();
    const tax = deriveInvoiceTaxFields(total, rate, !!estimate.taxExempt);

    const invoice = await prisma.invoice.create({
        data: {
            code: "INV-TEMP",
            projectId: estimate.projectId!,
            clientId: project.clientId,
            status: "Draft",
            totalAmount: total,
            balanceDue: total,
            subtotal: tax.subtotal,
            taxRate: tax.taxRate,
            taxAmount: tax.taxAmount,
        },
    });

    // Use DB-assigned autoincrement for collision-free code
    const invoiceCode = `INV-${String(invoice.number).padStart(5, "0")}`;
    await prisma.invoice.update({ where: { id: invoice.id }, data: { code: invoiceCode } });

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

export async function createOneOffInvoice(
    projectId: string,
    items: { name: string; amount: number; dueDate?: string | null }[],
) {
    await assertInvoicePermission();

    if (!items.length) throw new Error("At least one line item is required");

    const validatedItems = items.map((item, i) => {
        const name = (item.name || "").trim();
        const amount = Math.round(Number(item.amount) * 100) / 100;
        if (!name) throw new Error(`Item ${i + 1}: description is required`);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Item ${i + 1}: amount must be greater than zero`);
        return { name, amount, dueDate: item.dueDate || null };
    });

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error("Project not found");

    const total = Math.round(validatedItems.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    const rate = await getDefaultSalesTaxRate();
    const tax = deriveInvoiceTaxFields(total, rate, false);

    // Nest schedule creation inside invoice.create so both are atomic in one DB round-trip
    const invoice = await prisma.invoice.create({
        data: {
            code: "INV-TEMP",
            projectId,
            clientId: project.clientId,
            status: "Draft",
            totalAmount: total,
            balanceDue: total,
            subtotal: tax.subtotal,
            taxRate: tax.taxRate,
            taxAmount: tax.taxAmount,
            payments: {
                create: validatedItems.map((item) => ({
                    name: item.name,
                    amount: item.amount,
                    status: "Pending",
                    dueDate: item.dueDate ? new Date(item.dueDate) : null,
                })),
            },
        },
    });

    const invoiceCode = `INV-${String(invoice.number).padStart(5, "0")}`;
    await prisma.invoice.update({ where: { id: invoice.id }, data: { code: invoiceCode } });

    revalidatePath(`/projects/${projectId}/invoices`);
    return { id: invoice.id, projectId };
}

export async function createInvoiceFromTimeEntries(projectId: string, timeEntryIds: string[]) {
    "use server";
    if (!timeEntryIds.length) throw new Error("No time entries selected");

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error("Project not found");

    const entries = await prisma.timeEntry.findMany({
        where: { id: { in: timeEntryIds } },
        include: { user: true, costCode: true },
    });

    if (!entries.length) throw new Error("No matching time entries found");

    const totalAmount = entries.reduce((sum, e) => sum + (Number(e.laborCost) || 0), 0);
    const rate = await getDefaultSalesTaxRate();
    const tax = deriveInvoiceTaxFields(totalAmount, rate, false);

    const invoice = await prisma.invoice.create({
        data: {
            code: "INV-TEMP",
            projectId,
            clientId: project.clientId,
            status: "Draft",
            totalAmount,
            balanceDue: totalAmount,
            subtotal: tax.subtotal,
            taxRate: tax.taxRate,
            taxAmount: tax.taxAmount,
        },
    });

    const invoiceCode2 = `INV-${String(invoice.number).padStart(5, "0")}`;
    await prisma.invoice.update({ where: { id: invoice.id }, data: { code: invoiceCode2 } });

    // Create one payment schedule entry per time entry as line items
    for (const entry of entries) {
        const label = [
            entry.user?.name || "Labor",
            entry.costCode ? `(${entry.costCode.code})` : "",
            `— ${Number(entry.durationHours || 0).toFixed(1)}h`,
            `on ${new Date(entry.startTime).toLocaleDateString()}`,
        ].filter(Boolean).join(" ");

        await prisma.paymentSchedule.create({
            data: {
                invoiceId: invoice.id,
                name: label,
                amount: Number(entry.laborCost) || 0,
                status: "Pending",
            },
        });
    }

    await prisma.timeEntry.updateMany({
        where: { id: { in: timeEntryIds } },
        data: { invoicedAt: new Date() },
    });

    revalidatePath(`/projects/${projectId}/invoices`);
    revalidatePath(`/projects/${projectId}/time-expenses`);
    return { id: invoice.id, projectId };
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

/** Parse a payment-date input into a Date.
 *  Accepts:
 *   - `YYYY-MM-DD` (strict — end-anchored, rejects overflow) → interpreted as LOCAL midnight
 *     so the stored value matches the calendar day the user typed.
 *   - A positive epoch-ms number → treated as an absolute instant.
 *   - An ISO-8601 datetime with a time component → `new Date()` (UTC semantics).
 *  Rejects: empty strings, 0/negative numbers, non-strict YYYY-M-D-ish shapes. */
function parsePaymentDateInput(input: number | string): Date | null {
    if (typeof input === "number") {
        if (!Number.isFinite(input) || input <= 0) return null;
        const d = new Date(input);
        return isNaN(d.getTime()) ? null : d;
    }
    if (typeof input !== "string" || input.trim() === "") return null;
    // Strict YYYY-MM-DD → local midnight (primary path from the date picker).
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if (ymd) {
        const y = Number(ymd[1]);
        const mo = Number(ymd[2]);
        const d = Number(ymd[3]);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const dt = new Date(y, mo - 1, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
        return dt;
    }
    // Accept full ISO datetimes (e.g. "2026-04-20T14:30:00Z") for API callers that pass them.
    const dt = new Date(input);
    return isNaN(dt.getTime()) ? null : dt;
}

export async function recordPayment(
    paymentId: string,
    invoiceId: string,
    input: {
        paymentDate: number | string;
        method: string;
        referenceNumber?: string | null;
        notes?: string | null;
    },
) {
    await assertInvoicePermission();

    const VALID_METHODS = ["check", "cash", "zelle", "venmo", "credit_card", "ach", "wire", "other"];
    const method = input.method;
    if (!VALID_METHODS.includes(method)) {
        return { success: false, error: "Invalid payment method" as const };
    }
    const referenceNumber = (input.referenceNumber || "").trim() || null;
    if (method === "check" && !referenceNumber) {
        return { success: false, error: "Check number is required" as const };
    }
    const notes = (input.notes || "").trim() || null;
    const paymentDate = parsePaymentDateInput(input.paymentDate);
    if (!paymentDate) {
        return { success: false, error: "Invalid payment date" as const };
    }

    const payment = await prisma.paymentSchedule.findUnique({ where: { id: paymentId } });
    if (!payment) return { success: false, error: "Milestone not found" as const };
    if (payment.status === "Paid") return { success: false, error: "Milestone already paid" as const };
    if (payment.invoiceId !== invoiceId) return { success: false, error: "Milestone/invoice mismatch" as const };

    await prisma.paymentSchedule.update({
        where: { id: paymentId },
        data: {
            status: "Paid",
            paymentDate,
            paidAt: new Date(),
            paymentMethod: method,
            referenceNumber,
            notes,
        },
    });

    // Recalculate from scratch (matches Stripe webhook) to avoid drift.
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return { success: false, error: "Invoice not found" as const };

    const allSchedules = await prisma.paymentSchedule.findMany({ where: { invoiceId } });
    const totalPaid = allSchedules
        .filter((s) => s.status === "Paid")
        .reduce((sum, s) => sum + toNum(s.amount), 0);
    const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalPaid);
    const newStatus =
        newBalance <= 0 ? "Paid"
        : totalPaid > 0 ? "Partially Paid"
        : invoice.status;

    await prisma.invoice.update({
        where: { id: invoiceId },
        data: { balanceDue: newBalance, status: newStatus },
    });

    revalidatePath(`/projects/${invoice.projectId}/invoices`);
    revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    revalidatePath(`/invoices`);
    revalidatePath(`/portal`);
    revalidatePath(`/reports/open-invoices`);
    revalidatePath(`/reports/sales-tax`);
    revalidatePath(`/reports/payments`);
    revalidatePath(`/reports/transactions`);

    return { success: true };
}

export async function recordEstimatePayment(
    paymentId: string,
    estimateId: string,
    input: {
        paymentDate: number | string;
        method: string;
        referenceNumber?: string | null;
        notes?: string | null;
    },
) {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "estimates")) throw new Error("Forbidden");

    const VALID_METHODS = ["check", "cash", "zelle", "venmo", "credit_card", "ach", "wire", "other"];
    const method = input.method;
    if (!VALID_METHODS.includes(method)) {
        return { success: false, error: "Invalid payment method" as const };
    }
    const referenceNumber = (input.referenceNumber || "").trim() || null;
    if (method === "check" && !referenceNumber) {
        return { success: false, error: "Check number is required" as const };
    }
    const notes = (input.notes || "").trim() || null;
    const paymentDate = parsePaymentDateInput(input.paymentDate);
    if (!paymentDate) {
        return { success: false, error: "Invalid payment date" as const };
    }

    const tx = await prisma.$transaction(async (t) => {
        const payment = await t.estimatePaymentSchedule.findUnique({ where: { id: paymentId } });
        if (!payment) return { success: false as const, error: "Milestone not found" as const };
        if (payment.status === "Paid") return { success: false as const, error: "Milestone already paid" as const };
        if (payment.estimateId !== estimateId) return { success: false as const, error: "Milestone/estimate mismatch" as const };

        const claim = await t.estimatePaymentSchedule.updateMany({
            where: { id: paymentId, status: { not: "Paid" } },
            data: {
                status: "Paid",
                paymentDate,
                paidAt: new Date(),
                paymentMethod: method,
                referenceNumber,
                notes,
            },
        });
        if (claim.count === 0) return { success: false as const, error: "Milestone already paid" as const };

        const estimate = await t.estimate.findUnique({ where: { id: estimateId } });
        if (!estimate) return { success: false as const, error: "Estimate not found" as const };

        const allSchedules = await t.estimatePaymentSchedule.findMany({ where: { estimateId } });
        const totalPaid = allSchedules
            .filter((s) => s.status === "Paid")
            .reduce((sum, s) => sum + toNum(s.amount), 0);
        const newBalance = Math.max(0, toNum(estimate.totalAmount) - totalPaid);
        const newStatus =
            newBalance <= 0 ? "Paid"
            : totalPaid > 0 ? "Partially Paid"
            : estimate.status;

        await t.estimate.update({
            where: { id: estimateId },
            data: { balanceDue: newBalance, status: newStatus },
        });

        return { success: true as const, projectId: estimate.projectId, leadId: estimate.leadId };
    });

    if (!tx.success) return tx;

    if (tx.projectId) {
        revalidatePath(`/projects/${tx.projectId}/estimates`);
        revalidatePath(`/projects/${tx.projectId}/estimates/${estimateId}`);
    }
    if (tx.leadId) {
        revalidatePath(`/leads/${tx.leadId}/estimates`);
        revalidatePath(`/leads/${tx.leadId}/estimates/${estimateId}`);
    }
    revalidatePath(`/estimates`);
    revalidatePath(`/portal`);
    revalidatePath(`/reports/sales-tax`);
    revalidatePath(`/reports/payments`);
    revalidatePath(`/reports/transactions`);

    return { success: true };
}

export async function sendPaymentReceipt(paymentScheduleId: string) {
    await assertInvoicePermission();
    const { sendInvoicePaymentReceiptOnly } = await import("./payment-notifications");
    const result = await sendInvoicePaymentReceiptOnly(paymentScheduleId);

    if (result.success) {
        const schedule = await prisma.paymentSchedule.findUnique({
            where: { id: paymentScheduleId },
            include: { invoice: true },
        });
        if (schedule?.invoice) {
            revalidatePath(`/projects/${schedule.invoice.projectId}/invoices/${schedule.invoiceId}`);
        }
    }
    return result;
}

export async function sendEstimatePaymentReceipt(paymentScheduleId: string) {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "estimates")) throw new Error("Forbidden");

    const { sendEstimatePaymentReceiptOnly } = await import("./payment-notifications");
    const result = await sendEstimatePaymentReceiptOnly(paymentScheduleId);

    if (result.success) {
        const schedule = await prisma.estimatePaymentSchedule.findUnique({
            where: { id: paymentScheduleId },
            include: { estimate: true },
        });
        if (schedule?.estimate?.projectId) {
            revalidatePath(`/projects/${schedule.estimate.projectId}/estimates/${schedule.estimateId}`);
        }
        if (schedule?.estimate?.leadId) {
            revalidatePath(`/leads/${schedule.estimate.leadId}/estimates/${schedule.estimateId}`);
        }
    }
    return result;
}

export async function unrecordEstimatePayment(paymentId: string, estimateId: string) {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "estimates")) throw new Error("Forbidden");

    const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.estimatePaymentSchedule.findUnique({ where: { id: paymentId } });
        if (!payment) throw new Error("Payment not found");
        if (payment.status !== "Paid") return null;

        const estimate = await tx.estimate.findUnique({ where: { id: estimateId } });
        if (!estimate) throw new Error("Estimate not found");
        if (payment.estimateId !== estimateId) throw new Error("Payment/estimate mismatch");

        await tx.estimatePaymentSchedule.update({
            where: { id: paymentId },
            data: { status: "Pending", paymentDate: null, paidAt: null },
        });

        const allSchedules = await tx.estimatePaymentSchedule.findMany({ where: { estimateId } });
        const totalPaid = allSchedules
            .filter((s) => s.status === "Paid")
            .reduce((sum, s) => sum + toNum(s.amount), 0);
        const newBalance = Math.max(0, toNum(estimate.totalAmount) - totalPaid);
        const wasPaymentStatus = ["Paid", "Partially Paid"].includes(estimate.status);
        const newStatus =
            newBalance <= 0 ? "Paid"
            : totalPaid > 0 ? "Partially Paid"
            : wasPaymentStatus ? "Approved"
            : estimate.status;

        await tx.estimate.update({
            where: { id: estimateId },
            data: { balanceDue: newBalance, status: newStatus },
        });

        return { projectId: estimate.projectId, leadId: estimate.leadId };
    });

    if (!result) return { success: false };

    if (result.projectId) {
        revalidatePath(`/projects/${result.projectId}/estimates`);
        revalidatePath(`/projects/${result.projectId}/estimates/${estimateId}`);
    }
    if (result.leadId) {
        revalidatePath(`/leads/${result.leadId}/estimates`);
        revalidatePath(`/leads/${result.leadId}/estimates/${estimateId}`);
    }
    revalidatePath(`/estimates`);
    revalidatePath(`/portal`);
    revalidatePath(`/reports/payments`);
    revalidatePath(`/reports/transactions`);
    revalidatePath(`/reports/sales-tax`);

    return { success: true };
}

async function assertInvoicePermission() {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "invoices")) throw new Error("Forbidden");
    return user;
}

export async function addInvoiceMilestone(
    invoiceId: string,
    input: { name: string; amount: number; dueDate?: string | null },
) {
    await assertInvoicePermission();

    const name = (input.name || "").trim();
    const amount = Number(input.amount);
    if (!name) throw new Error("Milestone name is required");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Milestone amount must be greater than zero");

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new Error("Invoice not found");

    await prisma.paymentSchedule.create({
        data: {
            invoiceId,
            name,
            amount,
            status: "Pending",
            dueDate: input.dueDate ? new Date(input.dueDate) : null,
        },
    });

    const nextStatus = invoice.status === "Paid" ? "Partially Paid" : invoice.status;
    await prisma.invoice.update({
        where: { id: invoiceId },
        data: {
            totalAmount: { increment: amount },
            balanceDue: { increment: amount },
            ...(nextStatus !== invoice.status ? { status: nextStatus } : {}),
        },
    });

    revalidatePath(`/projects/${invoice.projectId}/invoices`);
    revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    revalidatePath(`/invoices`);
    revalidatePath(`/portal`);
    revalidatePath(`/reports/open-invoices`);

    return { success: true };
}

export async function splitInvoiceMilestones(
    invoiceId: string,
    milestones: { name: string; amount: number; dueDate?: string | null }[],
) {
    await assertInvoicePermission();

    if (!milestones.length) throw new Error("At least one milestone is required");

    const validated = milestones.map((m, i) => {
        const name = (m.name || "").trim();
        const amount = Math.round(Number(m.amount) * 100) / 100;
        if (!name) throw new Error(`Milestone ${i + 1}: name is required`);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Milestone ${i + 1}: amount must be greater than zero`);
        return { name, amount, dueDate: m.dueDate || null };
    });

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new Error("Invoice not found");

    const newTotal = Math.round(validated.reduce((s, m) => s + m.amount, 0) * 100) / 100;

    // Recalculate balanceDue: paid amount stays the same, only pending changes
    const paidAmount = Math.round(
        (Number(invoice.totalAmount) - Number(invoice.balanceDue)) * 100,
    ) / 100;
    const newBalance = Math.max(0, Math.round((newTotal - paidAmount) * 100) / 100);
    const newStatus =
        newBalance <= 0 ? "Paid"
        : invoice.status === "Draft" ? "Draft"
        : invoice.status === "Overdue" ? "Overdue"
        : "Issued";

    // Array-form transaction — atomic with pgbouncer, no interactive session needed
    await prisma.$transaction([
        prisma.paymentSchedule.deleteMany({ where: { invoiceId, status: { not: "Paid" } } }),
        prisma.paymentSchedule.createMany({
            data: validated.map((m) => ({
                invoiceId,
                name: m.name,
                amount: m.amount,
                status: "Pending",
                dueDate: m.dueDate ? new Date(m.dueDate) : null,
            })),
        }),
        prisma.invoice.update({
            where: { id: invoiceId },
            data: { totalAmount: newTotal, balanceDue: newBalance, status: newStatus },
        }),
    ]);

    revalidatePath(`/projects/${invoice.projectId}/invoices`);
    revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    revalidatePath(`/invoices`);

    return { success: true };
}

export async function unrecordPayment(paymentId: string, invoiceId: string) {
    await assertInvoicePermission();

    const projectId = await prisma.$transaction(async (tx) => {
        const payment = await tx.paymentSchedule.findUnique({ where: { id: paymentId } });
        if (!payment) throw new Error("Payment not found");
        if (payment.status !== "Paid") return null;

        const invoice = await tx.invoice.findUnique({
            where: { id: invoiceId },
            include: { payments: true },
        });
        if (!invoice) throw new Error("Invoice not found");

        await tx.paymentSchedule.update({
            where: { id: paymentId },
            data: { status: "Pending", paymentDate: null, paidAt: null },
        });

        const amount = toNum(payment.amount);
        const cappedDelta = Math.min(amount, Math.max(0, toNum(invoice.totalAmount) - toNum(invoice.balanceDue)));

        const otherPaidExists = invoice.payments.some(
            (p) => p.id !== paymentId && p.status === "Paid",
        );
        const projectedBalance = toNum(invoice.balanceDue) + cappedDelta;
        let newStatus: string;
        if (projectedBalance <= 0) {
            newStatus = "Paid";
        } else if (otherPaidExists) {
            newStatus = "Partially Paid";
        } else if (invoice.status === "Overdue") {
            newStatus = "Overdue";
        } else {
            newStatus = "Issued";
        }

        await tx.invoice.update({
            where: { id: invoiceId },
            data: { balanceDue: { increment: cappedDelta }, status: newStatus },
        });

        return invoice.projectId;
    });

    if (!projectId) return { success: false };

    revalidatePath(`/projects/${projectId}/invoices`);
    revalidatePath(`/projects/${projectId}/invoices/${invoiceId}`);
    revalidatePath(`/invoices`);
    revalidatePath(`/portal`);
    revalidatePath(`/reports/open-invoices`);
    revalidatePath(`/reports/payments`);
    revalidatePath(`/reports/transactions`);
    revalidatePath(`/reports/sales-tax`);

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
            totalLaborBudget += toNum(item.total);
        } else {
            totalMaterialBudget += toNum(item.total);
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


export const getCompanySettings = unstable_cache(
    async () => {
        let settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });

        if (!settings) {
            settings = await prisma.companySettings.create({
                data: {
                    id: "singleton",
                    companyName: "My Construction Co.",
                },
            });
        }

        return JSON.parse(JSON.stringify(settings));
    },
    ["company-settings"],
    { revalidate: 300 }
);

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
            licenseNumber: typeof data.licenseNumber === "string"
                ? data.licenseNumber.replace(/[\r\n\t]/g, "").trim().slice(0, 50)
                : undefined,
            notificationEmail: data.notificationEmail,
            stripeEnabled: data.stripeEnabled,
            enableCard: data.enableCard,
            enableBankTransfer: data.enableBankTransfer,
            enableAffirm: data.enableAffirm,
            enableKlarna: data.enableKlarna,
            passProcessingFee: data.passProcessingFee,
            cardProcessingRate: data.cardProcessingRate !== undefined ? parseFloat(data.cardProcessingRate) : undefined,
            cardProcessingFlat: data.cardProcessingFlat !== undefined ? parseFloat(data.cardProcessingFlat) : undefined,
            workDays: data.workDays,
            workdayStart: data.workdayStart,
            workdayEnd: data.workdayEnd,
            salesTaxes: data.salesTaxes,
            ...(data.notificationToggles !== undefined ? { notificationToggles: data.notificationToggles } : {}),
        },
    });

    revalidatePath("/settings/notifications");
    revalidatePath("/settings/company");
    revalidatePath("/portal");
    revalidatePath("/"); // bust company-settings cache
    return { success: true };
}

export async function deleteEstimate(estimateId: string): Promise<{ success: boolean; error?: string }> {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { projectId: true, leadId: true, status: true },
    });
    if (!estimate) return { success: false, error: "Estimate not found" };
    const PROTECTED_STATUSES = new Set(["Approved", "Invoiced", "Partially Paid"]);
    if (PROTECTED_STATUSES.has(estimate.status)) return { success: false, error: `${estimate.status} estimates cannot be deleted` };

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
        revalidatePath("/estimates");
    }
    return { success: true };
}

// =============================================
// Duplicate Estimate
// =============================================

export async function duplicateEstimate(estimateId: string, targetProjectId?: string, newTitle?: string) {
    const original = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
            items: { orderBy: { order: "asc" } },
            paymentSchedules: { orderBy: { order: "asc" } },
        },
    });
    if (!original) throw new Error("Estimate not found");

    if (targetProjectId) {
        const target = await prisma.project.findUnique({ where: { id: targetProjectId } });
        if (!target) throw new Error("Target project not found");
    }

    const newEstimate = await prisma.estimate.create({
        data: {
            title: newTitle?.trim() || `Copy of ${original.title}`,
            projectId: targetProjectId ?? original.projectId,
            leadId: targetProjectId ? null : original.leadId,
            code: "EST-TEMP",
            status: "Draft",
            totalAmount: original.totalAmount,
            balanceDue: original.totalAmount,
            privacy: original.privacy,
        },
    });

    // Use DB-assigned autoincrement for collision-free code
    const copyCode = `EST-${String(newEstimate.number).padStart(5, "0")}`;
    await prisma.estimate.update({ where: { id: newEstimate.id }, data: { code: copyCode } });

    // Pre-generate new IDs so parentId can be mapped at creation time
    const idMap: Record<string, string> = {};
    for (const item of original.items) {
        idMap[item.id] = crypto.randomUUID();
    }

    const toItemData = (item: typeof original.items[number]) => ({
        id: idMap[item.id],
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
        parentId: item.parentId ? (idMap[item.parentId] || null) : null,
    });

    // Create parents first, then children — FK ordering respected (same pattern as saveEstimate)
    const parentItems = original.items.filter(i => !i.parentId);
    const childItems = original.items.filter(i => i.parentId);

    if (parentItems.length > 0) {
        await prisma.estimateItem.createMany({ data: parentItems.map(toItemData) });
    }
    if (childItems.length > 0) {
        await prisma.estimateItem.createMany({ data: childItems.map(toItemData) });
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

    if (targetProjectId) {
        revalidatePath(`/projects/${targetProjectId}/estimates`);
        if (original.projectId && original.projectId !== targetProjectId) {
            revalidatePath(`/projects/${original.projectId}/estimates`);
        }
    } else if (original.projectId) {
        revalidatePath(`/projects/${original.projectId}/estimates`);
    } else if (original.leadId) {
        revalidatePath(`/leads/${original.leadId}`);
    }
    revalidatePath("/estimates");

    return {
        id: newEstimate.id,
        projectId: targetProjectId ?? original.projectId,
        leadId: targetProjectId ? null : original.leadId,
    };
}

// =============================================
// Bulk Estimate Actions
// =============================================

export async function deleteEstimates(ids: string[]): Promise<{ deleted: number; skipped: { id: string; reason: string }[] }> {
    let deleted = 0;
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
        try {
            const res = await deleteEstimate(id);
            if (res.success) deleted++;
            else skipped.push({ id, reason: res.error ?? "unknown" });
        } catch (e: any) {
            skipped.push({ id, reason: e?.message ?? "unknown" });
        }
    }
    return { deleted, skipped };
}

export async function duplicateEstimates(
    ids: string[],
    targetProjectId?: string,
): Promise<{ createdIds: string[]; skipped: { id: string; reason: string }[] }> {
    const createdIds: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
        try {
            const res = await duplicateEstimate(id, targetProjectId);
            createdIds.push(res.id);
        } catch (e: any) {
            skipped.push({ id, reason: e?.message ?? "unknown" });
        }
    }
    return { createdIds, skipped };
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

    const estimate = await prisma.estimate.create({
        data: {
            title: template.name,
            projectId,
            code: "EST-TEMP",
            status: "Draft",
            totalAmount: 0,
            balanceDue: 0,
            privacy: "Shared",
        },
    });

    const templateCode = `EST-${String(estimate.number).padStart(5, "0")}`;
    await prisma.estimate.update({ where: { id: estimate.id }, data: { code: templateCode } });

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
                total: toNum(item.quantity) * toNum(item.unitCost),
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
// Assembly (Reusable Item Bundles)
// =============================================

export async function saveItemsAsAssembly(name: string, items: { name: string; description?: string; type: string; quantity: number; baseCost: number; markupPercent: number; unitCost: number; order: number; parentId?: string | null; costCodeId?: string | null; costTypeId?: string | null; isSection?: boolean }[]) {
    const template = await prisma.estimateTemplate.create({
        data: {
            name,
            items: {
                create: items.map((item, idx) => ({
                    name: item.name,
                    description: item.description || "",
                    type: item.type,
                    quantity: item.quantity,
                    baseCost: item.baseCost || 0,
                    markupPercent: item.markupPercent,
                    unitCost: item.unitCost || 0,
                    order: idx,
                    parentId: item.parentId || null,
                    costCodeId: item.costCodeId || null,
                    costTypeId: item.costTypeId || null,
                })),
            },
        },
        include: { items: true },
    });
    return { id: template.id, name: template.name, itemCount: template.items.length };
}

export async function deleteAssembly(templateId: string) {
    await prisma.estimateTemplate.delete({ where: { id: templateId } });
    return { success: true };
}

// =============================================
// Document Templates CRUD
// =============================================

export async function getDocumentTemplates(type?: string) {
    return await prisma.documentTemplate.findMany({
        where: type ? { type } : undefined,
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
    revalidatePath("/estimates");
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
    revalidatePath("/estimates");
    return template;
}

export async function deleteDocumentTemplate(id: string) {
    await prisma.documentTemplate.delete({ where: { id } });
    revalidatePath("/company/templates");
    revalidatePath("/estimates");
    return { success: true };
}

// =============================================
// Send Estimate to Client
// =============================================

export async function sendEstimateToClient(estimateId: string, templateId?: string, overrideEmail?: string, ccEmails?: string[], customMessage?: string, capturedPdfUrl?: string): Promise<{ success: true; sentTo: string } | { success: false; error: string }> {
    try {
    // --- Server-side CC validation ---
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const CC_MAX = 20;
    if (ccEmails && ccEmails.length > 0) {
        if (ccEmails.length > CC_MAX) {
            return { success: false, error: `Too many CC recipients (max ${CC_MAX}).` };
        }
        const invalid = ccEmails.filter(e => !EMAIL_REGEX.test(e));
        if (invalid.length > 0) {
            return { success: false, error: `Invalid CC email address${invalid.length > 1 ? "es" : ""}: ${invalid.join(", ")}` };
        }
        // Dedupe case-insensitively
        const seen = new Set<string>();
        ccEmails = ccEmails.filter(e => {
            const key = e.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: {
            ...safeEstimateSelect,
            sentAt: true,
            memo: true,
            termsAndConditions: true,
            project: { select: { id: true, name: true, client: true } },
            lead: { select: { id: true, name: true, client: true } },
        },
    });

    if (!estimate) return { success: false, error: "Estimate not found" };

    const schedules = await prisma.estimatePaymentSchedule.findMany({ where: { estimateId }, orderBy: { order: "asc" } });
    const unpaidSchedules = schedules.filter(s => s.status !== "Paid");
    if (unpaidSchedules.length > 0) {
        const estimateTotal = toNum(estimate.totalAmount);
        // Half-cent-safe currency rounding
        const rc = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

        const paidSum = schedules.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
        const balanceDue = rc(estimateTotal - paidSum);

        // Recalculate percentage-based unpaid milestones so stale DB values (from edits
        // made without clicking Save) don't block sending. The LAST percentage milestone
        // (by order) absorbs any rounding residual, guaranteeing the total sums exactly to
        // balanceDue. If the computed lastAmount would be negative (inconsistent user data)
        // we skip auto-correction and let the manual validation error fire instead.
        const pctUnpaid = unpaidSchedules.filter(s => (s.percentage != null ? Number(s.percentage) : 0) > 0);
        if (pctUnpaid.length > 0) {
            const allButLast = pctUnpaid.slice(0, -1);
            const allButLastAmounts = allButLast.map(s => rc(estimateTotal * (Number(s.percentage!) / 100)));
            const allButLastSum = allButLastAmounts.reduce((a, b) => a + b, 0);
            const fixedUnpaidSum = unpaidSchedules
                .filter(s => (s.percentage != null ? Number(s.percentage) : 0) <= 0)
                .reduce((sum, s) => sum + toNum(s.amount), 0);
            const lastMilestone = pctUnpaid[pctUnpaid.length - 1];
            const lastAmount = rc(balanceDue - fixedUnpaidSum - allButLastSum);

            if (lastAmount >= 0) {
                const updates: { id: string; amount: number }[] = [];
                allButLast.forEach((s, i) => {
                    if (Math.abs(allButLastAmounts[i] - toNum(s.amount)) > 0.001)
                        updates.push({ id: s.id, amount: allButLastAmounts[i] });
                });
                if (Math.abs(lastAmount - toNum(lastMilestone.amount)) > 0.001)
                    updates.push({ id: lastMilestone.id, amount: lastAmount });

                if (updates.length > 0) {
                    await Promise.all(updates.map(u =>
                        prisma.estimatePaymentSchedule.update({ where: { id: u.id }, data: { amount: u.amount } })
                    ));
                    const refreshed = await prisma.estimatePaymentSchedule.findMany({ where: { estimateId }, orderBy: { order: "asc" } });
                    schedules.splice(0, schedules.length, ...refreshed);
                }
            }
        }

        const unpaidSum = schedules.reduce((sum, s) => sum + toNum(s.amount), 0) - paidSum;
        const unpaidRounded = rc(unpaidSum);
        if (Math.abs(unpaidRounded - balanceDue) > 0.01) {
            const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
            const diff = Math.abs(unpaidRounded - balanceDue);
            return { success: false, error: `Milestone total (${fmt(unpaidRounded)}) doesn't match the estimate balance due (${fmt(balanceDue)}). Difference: ${fmt(diff)}. Please adjust your milestones before sending.` };
        }
    }

    const client = estimate.project?.client || estimate.lead?.client;
    const recipientEmail = overrideEmail || client?.email;
    if (!recipientEmail) return { success: false, error: "No email address found for this client. Please add an email address before sending." };

    // Auto-include secondary client email (spouse/partner) if set
    const clientAdditionalEmailForEstimate = (client as any)?.additionalEmail as string | undefined;
    if (clientAdditionalEmailForEstimate) {
        ccEmails = ccEmails ? [...ccEmails] : [];
        if (!ccEmails.some(e => e.toLowerCase() === clientAdditionalEmailForEstimate.toLowerCase())) {
            ccEmails.unshift(clientAdditionalEmailForEstimate);
        }
    }

    // Remove the primary recipient from CC to avoid Resend duplicate-recipient errors
    if (ccEmails && ccEmails.length > 0) {
        const recipientLower = recipientEmail.toLowerCase();
        ccEmails = ccEmails.filter(e => e.toLowerCase() !== recipientLower);
        if (ccEmails.length === 0) ccEmails = undefined;
    }

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

    // Snapshot T&C before sending (don't flip status yet)
    await prisma.estimate.update({
        where: { id: estimateId },
        data: { termsAndConditions: termsHtml },
    });

    // Generate PDF for email attachment
    let emailAttachments: { filename: string; content: Buffer }[] | undefined = undefined;
    let pdfAttached = false;
    try {
        let pdfBuffer: Buffer | undefined;
        if (capturedPdfUrl && isAllowedCapturedPdfUrl(capturedPdfUrl)) {
            // Use the pre-captured portal PDF (high-quality, matches what client sees)
            const res = await fetch(capturedPdfUrl);
            if (res.ok) {
                const ab = await res.arrayBuffer();
                pdfBuffer = Buffer.from(ab);
            }
        } else if (capturedPdfUrl) {
            console.warn("[sendEstimateToClient] Rejected capturedPdfUrl (failed allowlist):", capturedPdfUrl);
        }
        if (!pdfBuffer) {
            // Fall back to server-side PDF generation
            const { generateEstimatePdf } = await import("./pdf");
            pdfBuffer = await generateEstimatePdf(estimateId);
        }
        if (pdfBuffer) {
            const filename = `Estimate_${estimate.code || estimateId}.pdf`;
            emailAttachments = [{ filename, content: pdfBuffer }];
            pdfAttached = true;
        }
    } catch (e) {
        console.error("Failed to generate estimate PDF for send:", e);
        // Do not block the email send — matches approveEstimate() pattern
    }

    // Send email notification to client
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    let portalUrl: string;
    if (client?.id) {
        const { signClientPortalToken } = await import("./client-portal-auth");
        const token = await signClientPortalToken(client.id, recipientEmail.toLowerCase());
        portalUrl = `${appUrl}/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(`/portal/estimates/${estimateId}`)}`;
    } else {
        portalUrl = `${appUrl}/portal/estimates/${estimateId}`;
    }
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

    // HTML-encode customMessage to prevent injection into email template
    const safeMessage = customMessage
        ? customMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
        : '';

    const personalNote = safeMessage
        ? `<div style="background: #f8fafc; border-left: 3px solid #4f46e5; padding: 16px; margin: 0 0 24px; border-radius: 0 8px 8px 0;">
                <p style="color: #333; margin: 0; line-height: 1.6; white-space: pre-wrap;">${safeMessage}</p>
           </div>`
        : '';

    const pdfNote = pdfAttached
        ? `<div style="background: #f0fdf4; border-left: 3px solid #16a34a; padding: 12px 16px; margin: 0 0 24px; border-radius: 0 8px 8px 0;">
               <p style="color: #15803d; margin: 0; font-size: 13px; font-weight: 600;">✓ A copy of your estimate is attached to this email for your records.</p>
           </div>`
        : '';

    const sendResult = await sendNotification(
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
                ${personalNote}
                ${pdfNote}
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
        emailAttachments,
        { fromName: companyName, replyTo: settings?.email || undefined, cc: ccEmails }
    );

    if (!sendResult.success) {
        return { success: false, error: "Failed to send estimate email. Please check the recipient address and try again." };
    }

    // Mark as Sent only after confirmed delivery
    await prisma.estimate.update({
        where: { id: estimateId },
        data: { sentAt: new Date(), status: "Sent" },
    });

    // Store as message in the appropriate thread
    const messageBody = customMessage
        ? `📄 Estimate sent: ${estimate.title || estimate.code}\n\n${customMessage}\n\n🔗 Portal link: ${portalUrl}`
        : `📄 Estimate sent: ${estimate.title || estimate.code}\n\n🔗 Portal link: ${portalUrl}`;

    if (estimate.leadId) {
        // Resolve clientId for unified conversation view
        const lead = await prisma.lead.findUnique({ where: { id: estimate.leadId }, select: { clientId: true } });
        await prisma.clientMessage.create({
            data: {
                clientId: lead?.clientId ?? null,
                leadId: estimate.leadId,
                direction: "OUTBOUND",
                senderName: companyName,
                senderEmail: settings?.email || null,
                subject: `Estimate sent: ${estimate.title || estimate.code}`,
                body: messageBody,
                channel: "email",
                sentViaEmail: true,
                status: "SENT",
                ccEmails: ccEmails && ccEmails.length > 0 ? JSON.stringify(ccEmails) : null,
            },
        });
        revalidatePath(`/leads/${estimate.leadId}/messages`);
    } else if (estimate.projectId) {
        const thread = await findOrCreateClientThread(estimate.projectId);
        const projectMessageBody = ccEmails && ccEmails.length > 0
            ? `${messageBody}\n\nCC: ${ccEmails.join(", ")}`
            : messageBody;
        await prisma.message.create({
            data: {
                threadId: thread.id,
                senderType: "TEAM",
                senderName: companyName,
                senderEmail: settings?.email || null,
                body: projectMessageBody,
            },
        });
        revalidatePath(`/projects/${estimate.projectId}/messages`);
    }

    // Log to activity feed (project-scoped only)
    if (estimate.projectId) {
        await logActivity({
            projectId: estimate.projectId,
            actorType: "TEAM",
            actorName: companyName,
            action: "sent_estimate",
            entityType: "estimate",
            entityId: estimateId,
            entityName: `Estimate ${estimate.code || estimate.title}`,
        });
    }

    // GAP-1: Auto-update lead stage to "Estimate Sent" if applicable
    if (estimate.leadId) {
        const lead = await prisma.lead.findUnique({ where: { id: estimate.leadId }, select: { stage: true } });
        const earlyStages = ["New", "Followed Up", "Connected"];
        if (lead && earlyStages.includes(lead.stage)) {
            await prisma.lead.update({ where: { id: estimate.leadId }, data: { stage: "Estimate Sent" } });
        }
    }

    // Revalidate paths
    if (estimate.projectId) revalidatePath(`/projects/${estimate.projectId}/estimates`);
    if (estimate.leadId) revalidatePath(`/leads/${estimate.leadId}`);
    revalidatePath("/estimates");
    revalidatePath("/leads");

    return { success: true, sentTo: recipientEmail };
    } catch (err) {
        console.error("[sendEstimateToClient] unexpected error:", err);
        return { success: false, error: "An unexpected error occurred. Please try again." };
    }
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
        company_license: settings?.licenseNumber || "",
        company_website: settings?.website || "",
        date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
        year: new Date().getFullYear().toString(),
    };

    const populateFromEntity = (
        entity: { name: string; location?: string | null; number?: number; type?: string | null },
        client: { name: string; email?: string | null; primaryPhone?: string | null; additionalEmail?: string | null; additionalPhone?: string | null; addressLine1?: string | null; city?: string | null; state?: string | null; zipCode?: string | null },
        estimates: { code: string; totalAmount: any; balanceDue: any; paymentSchedules?: { name: string; percentage?: number | null; amount: any; order: number }[] }[]
    ) => {
        data.project_name = entity.name;
        data.location = entity.location || "";
        if (entity.number) data.project_number = `P-${entity.number}`;
        if (entity.type) data.project_type = entity.type;

        data.client_name = client.name;
        data.client_email = client.email || "";
        data.client_phone = client.primaryPhone || "";
        data.client_address = [client.addressLine1, client.city, client.state, client.zipCode].filter(Boolean).join(", ");
        data.client_additional_email = client.additionalEmail || "";
        data.client_additional_phone = client.additionalPhone || "";

        const est = estimates[0];
        if (est) {
            data.estimate_total = `$${Number(est.totalAmount).toLocaleString()}`;
            data.estimate_number = est.code;
            data.estimate_balance_due = `$${Number(est.balanceDue).toLocaleString()}`;
            if (est.paymentSchedules && est.paymentSchedules.length > 0) {
                const rows = est.paymentSchedules
                    .sort((a, b) => a.order - b.order)
                    .map((ps) => `<tr><td style="padding:4px 12px 4px 0;border-bottom:1px solid #e5e7eb;">${ps.name}</td><td style="padding:4px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${ps.percentage ? `${ps.percentage}%` : ""}</td><td style="padding:4px 0 4px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">$${Number(ps.amount).toLocaleString()}</td></tr>`)
                    .join("");
                data.payment_schedule = `<table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr style="border-bottom:2px solid #333;"><th style="text-align:left;padding:4px 12px 4px 0;">Milestone</th><th style="text-align:right;padding:4px 12px;">%</th><th style="text-align:right;padding:4px 0 4px 12px;">Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
            }
        }
        if (!est) {
            data.estimate_total = "$0.00";
            data.estimate_number = "";
            data.estimate_balance_due = "$0.00";
        }
    };

    const estimateInclude = { orderBy: { createdAt: "desc" as const }, take: 1, include: { paymentSchedules: { orderBy: { order: "asc" as const } } } };

    if (projectId) {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: { client: true, estimates: estimateInclude },
        });
        if (project) populateFromEntity(project, project.client, project.estimates);
    } else if (leadId) {
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            include: { client: true, estimates: estimateInclude },
        });
        if (lead) populateFromEntity(lead, lead.client, lead.estimates);
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

/**
 * Ownership-scoped contract fetch for the client portal.
 *
 * Returns the contract only if the caller can prove access in one of two ways:
 *   1. A matching `accessToken` (the magic-link the contractor emailed)
 *   2. A portal session whose email resolves to exactly one Client row, and
 *      that client is the owner of the lead/project the contract belongs to.
 *
 * Returns `null` on not-found OR not-authorized — never leak existence with a 403.
 *
 * This is the only path `/portal/contracts/[id]/page.tsx` and related portal mutations
 * should use. Plain `getContract` has no ownership check and is admin-only.
 */
export async function getContractForPortal(id: string, token?: string | null) {
    // Try token first — it's the path the email link uses and needs no session.
    if (token) {
        const byToken = await prisma.contract.findFirst({
            where: { id, accessToken: token },
            include: {
                project: { include: { client: true } },
                lead: { include: { client: true } },
            },
        });
        if (byToken) return byToken;
    }

    // Fall back to session-based access for logged-in clients browsing /portal.
    const sessionClientId = await resolveSessionClientId();
    if (!sessionClientId) return null;

    return prisma.contract.findFirst({
        where: {
            id,
            OR: [
                { lead: { clientId: sessionClientId } },
                { project: { clientId: sessionClientId } },
            ],
        },
        include: {
            project: { include: { client: true } },
            lead: { include: { client: true } },
        },
    });
}

/**
 * Returns the executed PDF ProjectFile for a specific contract.
 *
 * Files written by the finalize route set `ProjectFile.name` to the exact string
 * `Executed_Contract_{contractId}.pdf` (no timestamp prefix — the timestamp only
 * appears in the storage path, not the DB `name` column). We use exact equality
 * for airtight lookup.
 *
 * Legacy fallback: files written before the contractId naming convention used
 * `Executed_Contract_{safeTitle}.pdf`. If exact-match returns nothing we retry
 * with the title-based prefix as a best-effort courtesy for old data. Same-title
 * collisions on legacy data are accepted as a known limitation — new data is
 * unambiguous.
 */
export async function getExecutedContractPdf(contract: { id: string; title: string; projectId: string | null; leadId: string | null }) {
    const where: any = contract.projectId
        ? { projectId: contract.projectId }
        : contract.leadId
            ? { leadId: contract.leadId }
            : null;
    if (!where) return null;

    // Preferred: exact-match on the contract-id-embedded filename.
    const exactName = `Executed_Contract_${contract.id}.pdf`;
    const byContractId = await prisma.projectFile.findFirst({
        where: {
            ...where,
            name: exactName,
            mimeType: "application/pdf",
        },
        orderBy: { createdAt: "desc" },
    });
    if (byContractId) return byContractId;

    // Legacy fallback — title-prefixed files from before the contractId naming change.
    const legacyPrefix = `Executed_Contract_${contract.title.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    return prisma.projectFile.findFirst({
        where: {
            ...where,
            name: { startsWith: legacyPrefix },
            mimeType: "application/pdf",
        },
        orderBy: { createdAt: "desc" },
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

    // Atomic first-mint of accessToken. We cannot read-then-update because two
    // concurrent senders (e.g. a human resend racing with the recurring-docs cron)
    // could both read `null`, mint different UUIDs, and the later write would
    // invalidate the earlier emailed link. Instead, we race with `updateMany`
    // gated on `accessToken IS NULL` — only the first writer wins. Then we
    // re-read to learn the canonical value (ours or a concurrent writer's).
    if (!contract.accessToken) {
        const candidate = crypto.randomUUID();
        await prisma.contract.updateMany({
            where: { id: contractId, accessToken: null },
            data: { accessToken: candidate },
        });
    }
    const minted = await prisma.contract.findUnique({
        where: { id: contractId },
        select: { accessToken: true },
    });
    const accessToken = minted?.accessToken;
    if (!accessToken) throw new Error("Failed to mint contract access token");

    // Status/sentAt update is now separate — it does NOT touch accessToken, so it
    // can never clobber a token another writer has already set.
    //
    // ─── Codex round-2 blocker: resend-after-sign race ───
    // Before this guard, `sendContractToClient` blindly wrote `status: "Sent"`.
    // A human clicking Resend while the client was mid-sign (or the recurring
    // cron racing a portal signature) could revert `Signed` → `Sent`, reopening
    // the contract and defeating the idempotency guard in `approveContract`.
    // Fix: only transition if the row is still in a pre-sign state. Losing
    // resends against an already-signed contract become no-ops (we still send
    // the email so the client gets their link, but we do NOT clobber status).
    // Recurring contracts that the cron re-arms legitimately re-enter "Sent"
    // from an earlier "Sent"/"Viewed" cycle — the whitelist includes those.
    await prisma.contract.updateMany({
        where: {
            id: contractId,
            status: { in: ["Draft", "Sent", "Viewed"] },
        },
        data: {
            status: "Sent",
            sentAt: new Date(),
        }
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const portalUrl = `${appUrl}/portal/contracts/${contractId}?token=${accessToken}`;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";
    const companyLogo = settings?.logoUrl || "";
    const companyLicense = settings?.licenseNumber || "";

    // Brand header — logo if present, else just company name. License displayed under name.
    const brandHeader = `
        <div style="text-align: center; margin-bottom: 32px;">
            ${companyLogo
                ? `<img src="${companyLogo}" alt="${companyName}" style="max-height: 64px; width: auto; margin: 0 auto 12px; display: block;" />`
                : ""}
            <h1 style="font-size: 22px; font-weight: 700; margin: 0; color: #0f172a;">${companyName}</h1>
            ${companyLicense
                ? `<p style="font-size: 12px; color: #64748b; margin: 4px 0 0;">Lic# ${companyLicense}</p>`
                : ""}
        </div>`;

    const contractCc = buildCc(client.email, (client as any).additionalEmail);
    await sendNotification(
        client.email,
        `${companyName} sent you a contract to review`,
        `<!DOCTYPE html>
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            ${brandHeader}
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">Contract Ready for Your Signature</h2>
                <p style="color: #666; margin: 0 0 24px;">Hi ${client.name},</p>
                <p style="color: #666; line-height: 1.6;">
                    ${companyName} has sent you a contract titled "<strong>${contract.title}</strong>" for your review and signature.
                    Click the button below to open your document portal, read the agreement, and sign electronically.
                </p>
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${portalUrl}" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        View in Portal
                    </a>
                </div>
                <p style="color: #999; font-size: 13px; margin: 0;">If you have any questions, reply to this email or contact us directly.</p>
            </div>
        </body>
        </html>`,
        undefined,
        { fromName: companyName, replyTo: settings?.email || undefined, cc: contractCc }
    );

    // Log to activity feed — project side uses ActivityLog, lead side uses the client message thread.
    if (contract.projectId) {
        await logActivity({
            projectId: contract.projectId,
            actorType: "TEAM",
            actorName: companyName,
            action: "sent_contract",
            entityType: "contract",
            entityId: contractId,
            entityName: contract.title,
        });
    }
    await postActivityToThread(
        contract.leadId,
        contract.projectId,
        `📄 Contract "${contract.title}" sent to ${client.name} (${client.email}) for review and signature.`
    );

    if (contract.projectId) revalidatePath(`/projects/${contract.projectId}`);
    if (contract.leadId) revalidatePath(`/leads/${contract.leadId}`);

    return { success: true, sentTo: client.email, clientName: client.name };
}

export async function signContractAsContractor(contractId: string, signerName: string, signatureDataUrl: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Not authenticated");

    // Role gate — only ADMIN/MANAGER can sign as contractor
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } });
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER")) throw new Error("Forbidden");

    // Validate data URL is a safe image type before storing
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(signatureDataUrl)) {
        throw new Error("Invalid signature format");
    }

    // Verify contract exists first (gives a clear 404-style error if not found)
    const existing = await prisma.contract.findUnique({ where: { id: contractId }, select: { id: true } });
    if (!existing) throw new Error("Contract not found");

    // Atomic idempotency guard — updateMany only matches rows where contractorSignedAt IS NULL,
    // so two concurrent requests can't both succeed (eliminates TOCTOU race)
    const result = await prisma.contract.updateMany({
        where: { id: contractId, contractorSignedAt: null },
        data: {
            contractorSignedBy: signerName,
            contractorSignedAt: new Date(),
            contractorSignatureUrl: signatureDataUrl,
        },
    });
    if (result.count === 0) throw new Error("Contract already signed by contractor");

    revalidatePath(`/projects/[id]/contracts`, "page");
    revalidatePath(`/leads/[id]/contracts`, "page");
    return { success: true };
}

export async function approveContract(contractId: string, signatureName: string, userAgent: string, signatureDataUrl?: string, accessToken?: string) {
    // Ownership gate — caller must have either an access-token match (magic-link path) or
    // a portal session whose email resolves to exactly one Client row that owns the
    // lead/project. Duplicate emails collapse to null (see resolveSessionClientId).
    // Unknown callers get "Contract not found" so we don't leak existence.
    const sessionClientId = await resolveSessionClientId();

    const ownershipClauses: any[] = [];
    if (accessToken) ownershipClauses.push({ accessToken });
    if (sessionClientId) {
        ownershipClauses.push({ lead: { clientId: sessionClientId } });
        ownershipClauses.push({ project: { clientId: sessionClientId } });
    }
    if (ownershipClauses.length === 0) throw new Error("Contract not found");

    // Fetch the contract, verifying ownership in the same query
    const contract = await prisma.contract.findFirst({
        where: { id: contractId, OR: ownershipClauses },
        include: { project: true, lead: true }
    });
    if (!contract) throw new Error("Contract not found");

    const now = new Date();
    const isRecurring = !!(contract.recurringDays && contract.recurringDays > 0);

    // ─── Atomic state transition (Codex peer review blocker #1) ───
    // Before this guard, approveContract was not idempotent: two concurrent
    // requests (email-link retry, portal browser race) could each insert a
    // ContractSigningRecord and overwrite approvedBy/approvedAt, corrupting
    // the audit trail of a one-time contract.
    //
    // Fix: do the status flip as a conditional `updateMany` that only matches
    // rows in a signable state. `Signed`/`Finalized` rows are filtered out,
    // so the second caller gets count=0 and we throw. Insert the signing
    // record ONLY after this transition wins — losing races never persist.
    //
    // Recurring contracts are excepted: they explicitly re-enter the Sent state
    // on each cycle, so a second sign is legal. For recurring, concurrent sign
    // races within the same cycle are tolerated as duplicate audit records
    // (noise, not correctness).
    // ─── Codex round-2 real-issue: atomicity of transition + audit record ───
    // The state transition and ContractSigningRecord insert must commit or
    // abort together. If the record insert failed after the status flip, the
    // contract would be stuck `Signed` with no audit row, and the guard below
    // would reject every retry with "not in a signable state" — losing the
    // audit trail permanently. Wrap both writes in prisma.$transaction so a
    // downstream failure rolls back the status flip and the client can retry.
    const periodStart = contract.nextDueDate
        ? new Date(contract.nextDueDate.getTime() - (contract.recurringDays || 30) * 86400000)
        : contract.sentAt || contract.createdAt;

    await prisma.$transaction(async (tx) => {
        if (!isRecurring) {
            const transition = await tx.contract.updateMany({
                where: {
                    id: contractId,
                    status: { in: ["Draft", "Sent", "Viewed"] },
                },
                data: {
                    status: "Signed",
                    approvedBy: signatureName,
                    approvedAt: now,
                    approvalUserAgent: userAgent,
                    signatureUrl: signatureDataUrl || null,
                },
            });
            if (transition.count === 0) {
                throw new Error("Contract is not in a signable state (already signed or finalized)");
            }
        } else {
            const nextDue = new Date(now.getTime() + contract.recurringDays! * 86400000);
            await tx.contract.update({
                where: { id: contractId },
                data: {
                    approvedBy: signatureName,
                    approvedAt: now,
                    approvalUserAgent: userAgent,
                    signatureUrl: signatureDataUrl || null,
                    status: "Sent", // Reset to Sent so it can be signed again next cycle
                    viewedAt: null,
                    nextDueDate: nextDue,
                }
            });
        }

        // Audit record — inside the same transaction as the state flip, so
        // a failure here aborts the whole thing and the client can retry.
        await tx.contractSigningRecord.create({
            data: {
                contractId,
                signedBy: signatureName,
                signedAt: now,
                signatureUrl: signatureDataUrl || null,
                userAgent,
                periodStart,
                periodEnd: now,
            }
        });
    });

    const settings = await getCompanySettings();
    if (settings.notificationEmail && isNotificationEnabled(settings, "contractSigned")) {
        const isRecurring = contract.recurringDays && contract.recurringDays > 0;
        await sendNotification(
            settings.notificationEmail,
            `Contract "${contract.title}" has been signed!`,
            `<p>The contract "<strong>${contract.title}</strong>" has been electronically signed by <strong>${signatureName}</strong> on ${now.toLocaleString()}.</p>
            ${isRecurring ? `<p style="color: #666; font-size: 0.9em;">This is a recurring document (every ${contract.recurringDays} days). The next signing will be due on <strong>${new Date(now.getTime() + contract.recurringDays! * 86400000).toLocaleDateString()}</strong>.</p>` : ""}`
        );
    }

    // Log to project activity feed
    if (contract.projectId) {
        await logActivity({
            projectId: contract.projectId,
            actorType: "CLIENT",
            actorName: signatureName,
            action: "signed_contract",
            entityType: "contract",
            entityId: contractId,
            entityName: `Contract "${contract.title}"`,
        });
    }

    // Post to lead/project thread (Recent Activity panel)
    await postActivityToThread(
        contract.leadId ?? null,
        contract.projectId ?? null,
        `✅ ${signatureName} signed contract "${contract.title}" on ${now.toLocaleDateString()}`
    );

    revalidatePath("/");

    // GAP-3: Check if the linked estimate has payment schedules → signal UI to prompt deposit invoice
    let depositReady = false;
    let linkedEstimateId: string | null = null;
    if (contract.projectId) {
        const linkedEstimate = await prisma.estimate.findFirst({
            where: { projectId: contract.projectId, status: "Approved" },
            include: { paymentSchedules: { where: { status: "Pending" }, take: 1 } },
        });
        if (linkedEstimate && linkedEstimate.paymentSchedules.length > 0) {
            depositReady = true;
            linkedEstimateId = linkedEstimate.id;
        }
    }

    return { success: true, depositReady, linkedEstimateId };
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
PROJECT: "${task.project?.name || "Unknown Project"}"
PROJECT TYPE: ${task.project?.type || "General Construction"}

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

export async function updateProjectLocation(projectId: string, location: string) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    await prisma.project.update({
        where: { id: projectId },
        data: { location: location || null }
    });
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
    // Count unread inbound ClientMessages for this project.
    // "Inbound" from the team's perspective = messages sent by the CLIENT.
    // Uses readAt to determine unread status — badge clears when markClientMessagesRead is called.
    const inboundDirection = forSenderType === "TEAM" ? "INBOUND" : "OUTBOUND";
    return prisma.clientMessage.count({
        where: { projectId, direction: inboundDirection, readAt: null },
    });
}

export async function markClientMessagesRead(entityId: string, entityType: "lead" | "project") {
    const where = entityType === "lead"
        ? { leadId: entityId, direction: "INBOUND", readAt: null }
        : { projectId: entityId, direction: "INBOUND", readAt: null };
    await prisma.clientMessage.updateMany({
        where,
        data: { readAt: new Date() },
    });
}





export async function toggleSchedulePublished(projectId: string, published: boolean) {
    const existing = await prisma.portalVisibility.findUnique({ where: { projectId } });
    if (existing) {
        await prisma.portalVisibility.update({ where: { projectId }, data: { showSchedule: published } });
    } else {
        await prisma.portalVisibility.create({
            data: { projectId, showSchedule: published, showFiles: true, showDailyLogs: false, showEstimates: true, showInvoices: true, showContracts: true, showMessages: true, isPortalEnabled: true },
        });
    }
    revalidatePath(`/projects/${projectId}`);
    return { published };
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
    const portalCc = buildCc(project.client.email, (project.client as any).additionalEmail);
    const result = await sendNotification(
        project.client.email,
        `Your Dashboard for ${project.name} is Ready`,
        `<p>Hi ${project.client.name},</p><p>We have updated the portal for your project: <strong>${project.name}</strong>.</p><p><a href="${portalUrl}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:white;text-decoration:none;border-radius:5px;">Access Your Client Dashboard</a></p><p>From here you can view estimates, invoices, updates, and more.</p><br/>Thanks,<br/>Golden Touch Remodeling`,
        undefined,
        portalCc ? { cc: portalCc } : undefined
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
            code: "CO-TEMP",
            status: "Draft",
        }
    });

    const coCode = `CO-${String(changeOrder.number).padStart(5, "0")}`;
    await prisma.changeOrder.update({ where: { id: changeOrder.id }, data: { code: coCode } });

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

export async function getChangeOrderForPortal(id: string) {
    "use server";
    // IDOR-4 fix: gate by portal session's clientId
    const sessionClientId = await resolveSessionClientId();
    if (!sessionClientId) return null;

    return await prisma.changeOrder.findFirst({
        where: {
            id,
            project: { clientId: sessionClientId },
        },
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

export async function approveChangeOrder(id: string, signatureName: string, userAgent: string, signatureDataUrl?: string) {
    "use server";
    // Auth: internal admins skip ownership check; portal clients must prove ownership.
    const session = await getServerSession(authOptions);
    let isAdmin = false;
    if (session?.user?.email) {
        const internalUser = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { role: true },
        });
        isAdmin = !!internalUser && ["ADMIN", "MANAGER"].includes(internalUser.role);
    }
    if (!isAdmin) {
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) return null;
        const owned = await prisma.changeOrder.findFirst({
            where: { id, project: { clientId: sessionClientId } },
            select: { id: true },
        });
        if (!owned) return null;
    }

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

export async function sendChangeOrderToClient(changeOrderId: string): Promise<{ success: true; sentTo: string } | { success: false; error: string }> {
    "use server";
    const co = await prisma.changeOrder.findUnique({
        where: { id: changeOrderId },
        include: {
            project: { include: { client: true } },
            items: { orderBy: { order: "asc" } },
        }
    });

    if (!co) return { success: false, error: "Change order not found" };
    const client = co.project?.client;
    if (!client?.email) return { success: false, error: "Client has no email address" };

    // Update status to Sent (only if still in Draft or Sent state)
    await prisma.changeOrder.updateMany({
        where: { id: changeOrderId, status: { in: ["Draft", "Sent"] } },
        data: { status: "Sent", sentAt: new Date() }
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const portalUrl = `${appUrl}/portal/change-orders/${changeOrderId}`;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

    const changeOrderCc = buildCc(client.email, (client as any).additionalEmail);
    await sendNotification(
        client.email,
        `${companyName} sent you a change order to review`,
        `<!DOCTYPE html>
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">Change Order for Your Review</h2>
                <p style="color: #666; margin: 0 0 24px;">Hi ${client.name},</p>
                <p style="color: #666; line-height: 1.6;">
                    ${companyName} has sent you a change order titled "<strong>${co.title}</strong>" for project <strong>${co.project?.name || "your project"}</strong>.
                    Please review the scope changes and approve or decline.
                </p>
                <div style="background: #f9fafb; border-radius: 8px; padding: 16px; text-align: center; margin: 24px 0;">
                    <div style="color: #666; font-size: 13px; margin-bottom: 4px;">Change Order Amount</div>
                    <div style="font-size: 24px; font-weight: 700; color: #111;">${formatCurrency(co.totalAmount)}</div>
                </div>
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${portalUrl}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        Review Change Order
                    </a>
                </div>
                <p style="color: #999; font-size: 13px; text-align: center;">
                    Or copy this link: ${portalUrl}
                </p>
            </div>
            <p style="text-align: center; color: #aaa; font-size: 12px; margin-top: 32px;">
                Sent via ProBuild &bull; ${companyName}
            </p>
        </body>
        </html>`,
        undefined,
        { fromName: companyName, replyTo: settings?.email || undefined, cc: changeOrderCc }
    );

    // Log activity
    await logActivity({
        projectId: co.projectId,
        actorType: "TEAM",
        actorName: companyName,
        action: "sent_change_order",
        entityType: "change_order",
        entityId: changeOrderId,
        entityName: `Change Order ${co.code || co.title}`,
    });

    revalidatePath(`/projects/${co.projectId}/change-orders/${changeOrderId}`);
    revalidatePath(`/projects/${co.projectId}/change-orders`);
    return { success: true, sentTo: client.email };
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

// Upload a File object (not FormData) to a newly created PO — used after PDF-extract flow
export async function uploadPurchaseOrderFileFromBuffer(
    purchaseOrderId: string,
    projectId: string,
    formData: FormData
) {
    "use server";
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const file = formData.get("file") as File;
    if (!file) return;

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const { getSupabase, STORAGE_BUCKET } = await import("./supabase");
    const supabase = getSupabase();
    if (!supabase) return;

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `purchase-orders/${purchaseOrderId}/${Date.now()}_${safeName}`;

    const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, buffer, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
        });

    if (uploadError) return; // non-fatal — PO was already created

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData?.publicUrl || storagePath;

    await prisma.purchaseOrderFile.create({
        data: {
            purchaseOrderId,
            name: file.name,
            url: publicUrl,
            size: file.size,
            type: file.type || "application/octet-stream",
        },
    });

    revalidatePath(`/projects/${projectId}/purchase-orders/${purchaseOrderId}`);
}

export async function uploadEstimateFile(estimateId: string, formData: FormData) {
    "use server";
    const file = formData.get("file") as File;
    if (!file) throw new Error("No file uploaded");

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const { getSupabase, STORAGE_BUCKET } = await import("./supabase");
    const supabase = getSupabase();
    if (!supabase) throw new Error("Storage not configured");

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `estimates/${estimateId}/${Date.now()}_${safeName}`;

    const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, buffer, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
        });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData?.publicUrl || storagePath;

    const uploaded = await prisma.estimateFile.create({
        data: {
            estimateId,
            name: file.name,
            url: publicUrl,
            size: file.size,
            type: file.type || "application/octet-stream",
        }
    });

    const estimate = await prisma.estimate.findUnique({ where: { id: estimateId } });
    if (estimate?.projectId) {
        revalidatePath(`/projects/${estimate.projectId}/estimates/${estimateId}`);
    }
    if (estimate?.leadId) {
        revalidatePath(`/leads/${estimate.leadId}`);
    }
    return uploaded;
}

export async function deleteEstimateFile(fileId: string) {
    "use server";
    const file = await prisma.estimateFile.findUnique({ where: { id: fileId }, include: { estimate: { select: { id: true, code: true, title: true, status: true, totalAmount: true, projectId: true, leadId: true } } } });
    if (!file) return;

    await prisma.estimateFile.delete({ where: { id: fileId } });
    if (file.estimate.projectId) {
        revalidatePath(`/projects/${file.estimate.projectId}/estimates/${file.estimateId}`);
    }
}

export async function getEstimateFiles(estimateId: string) {
    "use server";
    return prisma.estimateFile.findMany({
        where: { estimateId },
        orderBy: { createdAt: "desc" },
    });
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
    const clientEmail = board.project.client?.email;
    if (clientEmail) {
        const settings = await getCompanySettings();
        const portalUrl = `https://probuild.goldentouchremodeling.com/portal/projects/${board.projectId}/selections`;
        const selectionCc = buildCc(clientEmail, (board.project.client as any)?.additionalEmail);
        await sendNotification(
            clientEmail,
            `Selection Board Ready: ${board.title}`,
            `<div style="font-family: sans-serif; color: #333;">
                <h2>Your Selection Board is Ready</h2>
                <p>Hi ${board.project.client?.name || "Client"},</p>
                <p>Your project manager has prepared a selection board "<strong>${board.title}</strong>" for the project <strong>${board.project.name}</strong>.</p>
                <p>Please review the options and make your selections:</p>
                <p><a href="${portalUrl}" style="display:inline-block;padding:12px 24px;background:#4c9a2a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">View Selections</a></p>
                <p style="color:#666;font-size:13px;">— ${settings.companyName || 'Your Project Team'}</p>
            </div>`,
            undefined,
            selectionCc ? { cc: selectionCc } : undefined
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
                <p><strong>${board.project.client?.name || "Client"}</strong> has made their selections for "<strong>${board.title}</strong>" on project <strong>${board.project.name}</strong>.</p>
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
    const pkg = await prisma.bidPackage.findUnique({
        where: { id },
        include: {
            scopes: { orderBy: { order: "asc" } },
            invitations: { orderBy: { createdAt: "asc" } },
            project: { select: { id: true, name: true } },
        },
    });

    if (!pkg) return null;

    return {
        ...pkg,
        totalBudget: pkg.totalBudget === null ? null : toNum(pkg.totalBudget),
        scopes: pkg.scopes.map((scope) => ({
            ...scope,
            budgetAmount: scope.budgetAmount === null ? null : toNum(scope.budgetAmount),
        })),
        invitations: pkg.invitations.map((invitation) => ({
            ...invitation,
            bidAmount: invitation.bidAmount === null ? null : toNum(invitation.bidAmount),
        })),
    };
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

// ========== DOCUMENT COMMENTS ==========

export async function getDocumentComments(documentType: string, documentId: string) {
    return prisma.documentComment.findMany({
        where: { documentType, documentId },
        orderBy: { createdAt: "asc" },
        include: { author: { select: { id: true, name: true, email: true } } },
    });
}

export async function addDocumentComment(
    documentType: string,
    documentId: string,
    text: string,
    visibility: "team" | "client",
    authorId?: string,
    authorName?: string,
) {
    const comment = await prisma.documentComment.create({
        data: { documentType, documentId, text, visibility, authorId: authorId || null, authorName: authorName || null },
        include: { author: { select: { id: true, name: true, email: true } } },
    });
    return comment;
}

export async function deleteDocumentComment(commentId: string) {
    await prisma.documentComment.delete({ where: { id: commentId } });
    return { success: true };
}

// ========== PER-ITEM APPROVAL ==========

export async function updateItemApproval(itemId: string, status: "approved" | "rejected" | null, note?: string) {
    try {
        return await prisma.estimateItem.update({
            where: { id: itemId },
            data: { approvalStatus: status, approvalNote: note || null },
            select: { id: true, approvalStatus: true, estimateId: true },
        });
    } catch {
        return { id: itemId, approvalStatus: status, estimateId: null };
    }
}

export async function bulkUpdateItemApproval(itemIds: string[], status: "approved" | "rejected" | null) {
    try {
        await prisma.estimateItem.updateMany({
            where: { id: { in: itemIds } },
            data: { approvalStatus: status, approvalNote: null },
        });
    } catch (err) {
        console.error("[bulkUpdateItemApproval] Failed — approvalStatus column may not exist:", err);
        return { success: false, count: 0, error: "Update failed — database column may not be migrated yet" };
    }
    return { success: true, count: itemIds.length }
}

export async function linkPOToEstimateItem(estimateItemId: string, purchaseOrderId: string) {
    "use server";
    const session = await getServerSession(authOptions);
    if (!session) throw new Error("Unauthorized");

    const item = await prisma.estimateItem.findUnique({
        where: { id: estimateItemId },
        include: { estimate: { select: { projectId: true } } },
    });
    if (!item) throw new Error("Estimate item not found");
    if (!item.estimate.projectId) throw new Error("Purchase orders require a project");

    const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (!po) throw new Error("Purchase order not found");
    if (po.projectId !== item.estimate.projectId) throw new Error("PO must belong to the same project");

    await prisma.estimateItem.update({
        where: { id: estimateItemId },
        data: { purchaseOrderId },
    });
    revalidatePath(`/projects/${item.estimate.projectId}/estimates`);
    return po;
}

export async function unlinkPOFromEstimateItem(estimateItemId: string) {
    "use server";
    const session = await getServerSession(authOptions);
    if (!session) throw new Error("Unauthorized");

    const item = await prisma.estimateItem.findUnique({
        where: { id: estimateItemId },
        include: { estimate: { select: { projectId: true } } },
    });
    await prisma.estimateItem.update({
        where: { id: estimateItemId },
        data: { purchaseOrderId: null },
    });
    if (item?.estimate.projectId) {
        revalidatePath(`/projects/${item.estimate.projectId}/estimates`);
    }
}

export async function quickCreatePOAndLink(estimateItemId: string, data: { vendorId: string; amount: number; notes?: string }) {
    "use server";
    const session = await getServerSession(authOptions);
    if (!session) throw new Error("Unauthorized");

    const item = await prisma.estimateItem.findUnique({
        where: { id: estimateItemId },
        include: { estimate: { select: { projectId: true } } },
    });
    if (!item) throw new Error("Estimate item not found");
    if (!item.estimate.projectId) throw new Error("Purchase orders require a project");

    const projectId = item.estimate.projectId;

    // Retry loop to handle TOCTOU race: two concurrent creates could pick the same count
    let po: any;
    for (let attempt = 0; attempt < 5; attempt++) {
        const count = await prisma.purchaseOrder.count({ where: { projectId } });
        const code = `PO-${(count + 1 + attempt).toString().padStart(3, "0")}`;
        try {
            po = await prisma.purchaseOrder.create({
                data: {
                    projectId,
                    vendorId: data.vendorId,
                    code,
                    totalAmount: data.amount,
                    notes: data.notes || null,
                    status: "Draft",
                },
                include: { vendor: true },
            });
            break;
        } catch (e: any) {
            // Unique constraint violation on code — retry with next number
            if (attempt === 4) throw e;
        }
    }

    await prisma.estimateItem.update({
        where: { id: estimateItemId },
        data: { purchaseOrderId: po.id },
    });

    revalidatePath(`/projects/${projectId}/purchase-orders`);
    revalidatePath(`/projects/${projectId}/estimates`);
    return po;
}

export async function getProjectPurchaseOrdersForLinking(projectId: string) {
    "use server";
    const session = await getServerSession(authOptions);
    if (!session) throw new Error("Unauthorized");

    return prisma.purchaseOrder.findMany({
        where: { projectId },
        select: { id: true, code: true, totalAmount: true, status: true, vendor: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
    });
}
