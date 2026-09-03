"use server";

import type { Prisma } from "@prisma/client";

import { getServerSession } from "next-auth";
import { prisma } from "./prisma";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { after } from "next/server";
import { cache } from "react";
import { authOptions, getSessionOrDev } from "./auth";
import { sendNotification } from "./email";
import { safeEstimateSelect, toNum, deriveInvoiceTaxFields } from "./prisma-helpers";
import { formatCurrency } from "./utils";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { resolveSessionClientId } from "./portal-auth";
import { portalVisibleEstimateWhere } from "./estimate-portal-visibility";
import { persistOwnedSignature } from "./signature-storage";
import { parseProductUrl, MAX_PRICE as PRODUCT_PARSE_MAX_PRICE } from "./product-parse";
import { isHttpUrl } from "./url-safety";
import { parsePaymentDateInput } from "./payment-date";
import { canApproveMealSkip, checkMealSkipDecision, stripSettlementNotes } from "./wa-breaks";
import { LOGISTICS_COST_CODE } from "./logistics-formalize";
import { retryTargetFor } from "./receipt-intake/route-state";
import { POSSIBLE_ORPHAN_REASON, UNKNOWN_ORPHAN_STATES, planParkWrites, type ParkPlan } from "./receipt-intake/park";
import { duplicateChainRefusal, withDuplicateChainLock } from "./receipt-intake/duplicate-guard";
import { driveFileIdOf } from "./receipt-intake/book";
import { CARD_RESEND_QUEUED_REASON, parseChatDelivery, requestIdFor, type CardItem } from "./receipt-request-cards";
import { recordCardOnIssues } from "./receipt-card-history";
import {
    ORPHAN_AUDIT_KIND,
    ORPHAN_RESOLUTIONS,
    isQboPurchaseId,
    verifyOrphanClaim,
    type QboPurchaseFacts,
} from "./receipt-intake/orphan-purchase";
import { logAutomationEvent } from "./automation-events";
import { RECEIPT_OWNER_CHOICES, RECEIPT_REQUEST_TARGET_TYPE } from "./receipt-requests";
import { isCostCodeAllowedForProject } from "./project-phases";
import { prismaPhaseDataSource } from "./project-phases-db";
import { PROJECT_STATUS_IN_PROGRESS } from "./project-status";
import { normalizePercentCompleteInput } from "./percent-complete";
// normalizeEstimateItemForSave is no longer imported here — the item projection moved into
// estimate-item-upsert.ts, which is now its only caller on the save path.
import { selectedBillableRows } from "./estimate-item-payload";
import { LEGACY_MARKUP_MARGIN_PCT, roundMoney, sellFromMargin } from "./budget-math";
import { canUseDevAuthFallback, currentStaffUserOrNull as currentStaffViewerOrNull, getCurrentUserWithPermissions, getUserWithPermissionsByEmail, hasPermission, isAdminOrManager, canAccessProject, canAccessEstimate, canCreateContractFor, canAccessContract, contractScopeWhere, estimateScopeWhere, estimateTotalsAreComplete, canWriteDocumentTemplateType, PortalAuthError } from "./permissions";
import { logActivity } from "./activity-log";
import { getDefaultSalesTaxRate } from "./sales-tax";
import { withTxRetry, lockMoneyParents } from "./tx-retry";

import { upsertEstimateItems, assertEstimateItemParentsInScope, EstimateStaleSaveError } from "./estimate-item-upsert";
import { appendPunchItemsInTransaction } from "./punch-items";
import { runDailyLogTaskMatch } from "./daily-log-task-match";
import { postDailyLogSummary } from "./chat-webhook";
import { runAfterRequest } from "./after-request";
import { enqueueMilestonePaid, drainPaymentNotifications } from "./payment-outbox";
import { recordPaymentCore } from "./payment-record-core";
import { deleteChangeOrderCore, updateChangeOrderCore } from "./change-order-core";
import { approveChangeOrderWithSignature } from "./change-order-approval";
import { applyChangeOrderToSchedule, autoGenerateScheduleForApprovedEstimate, canonicalContractEstimateQuery, deriveEstimateItemHours, setProjectStartDate, shiftNotStartedTasks, parseStartDateInput, generateScheduleFromEstimate, setProjectCrew, setTaskCrew, lockTaskAssignmentParent, touchTaskAssignmentRevision } from "./schedule-core";
import type { ShiftNotStartedTasksResult } from "./schedule-core";
import type { ChangeOrderUpdateInput } from "./change-order-core";
import { emptyDoc } from "@/lib/studio/doc";
import type { RoomType } from "@/lib/studio/templates";
import { normalizeE164 } from "./phone";
import { resolveCompanyTimeZone } from "./company-timezone";
import {
    applySuggestedDecision as aiSortApplySuggestedDecision,
    dismissSelectionSuggestion as aiSortDismissSelectionSuggestion,
    createDecisionForSuggestion as aiSortCreateDecisionForSuggestion,
} from "./selection-ai-sort-apply-core";
import {
    createDecisionTemplate as createDecisionTemplateCore,
    updateDecisionTemplate as updateDecisionTemplateCore,
    archiveDecisionTemplate as archiveDecisionTemplateCore,
    unarchiveDecisionTemplate as unarchiveDecisionTemplateCore,
    listDecisionTemplates as listDecisionTemplatesCore,
} from "./decision-template-crud-core";
import type { DecisionTemplateInput } from "./decision-template-crud-core";
import {
    listActiveDecisionTemplatesForApply as listActiveDecisionTemplatesForApplyCore,
    applyDecisionTemplate as applyDecisionTemplateCore,
} from "./decision-template-apply-core";
import {
    linkDecisionToSchedule as linkDecisionToScheduleCore,
    setDecisionDueDateOverride as setDecisionDueDateOverrideCore,
} from "./decision-link-actions-core";
import { computeEffectiveDueDate, computeLinkState, type DecisionLinkState } from "./decision-due-date";
import {
    setDecisionOrderInfo as setDecisionOrderInfoCore,
    type DecisionOrderInput,
} from "./decision-order-actions-core";
import { assessDeliveryRisk, type DeliveryRisk } from "./selection-order-risk";
import type { TemplateItemInput } from "./decision-template-core";
import { getDefaultColorForTaskName } from "@/app/projects/[id]/schedule/schedule-utils";
import { headers } from "next/headers";
import { getSupabase, STORAGE_BUCKET } from "./supabase";
import { uploadSecureDoc, removeSecureDoc, downloadDocBytes, isSecureRef, resolveDocUrl, toSecureRef } from "./secure-storage";
import { archiveExecutedContractPdf, sendExecutedContractEmails } from "./contract-finalize";
import { appendContractCountersignaturePage } from "./pdf";
import { defaultTaxForNewEstimate } from "./wa-tax";
import { geocodeJobSiteAddress } from "./geocode";
import { assertColumnExists, parseOfficeTaskDateOnly } from "./office-task-utils";
import { autoAssignPhasesForEstimate } from "./auto-assign-phases";
import { publishDispatch } from "./dispatch-publication";
import type { DispatchIntent } from "./dispatch-intent";
import type { PublishDispatchResult } from "./dispatch-publication";
import {
    addTaskMaterialCore,
    deleteTaskMaterialCore,
    getStagingQueueCore,
    getTaskMaterialsCore,
    importEstimateMaterialsCore,
    setTaskMaterialStatusCore,
    updateTaskMaterialCore,
    type TaskMaterialActor,
    type TaskMaterialInput,
    type TaskMaterialUpdateInput,
    type TaskMaterialStatus,
} from "./task-materials-core";
import { assertPortalProjectAccess } from "./portal-project-access";
import {
    CLIENT_STAGES,
    computeDailyLogSharedContentHash,
    getPortalScheduleTasksCore,
    setDailyLogPortalShareCore,
} from "./portal-tracker";
import {
    createScheduleTaskInTransaction,
    SCHEDULE_TASK_STATUSES,
    setTaskLeadInTransaction,
    updateScheduleTaskInTransaction,
    type CreateScheduleTaskInput,
    type UpdateScheduleTaskInput,
} from "./schedule-task-core";
import { convertLeadToProjectCore } from "./lead-conversion-core";
import { buildContractMergeData, normalizeContractBody, resolveMergeFields, createContractFromTemplateCore, createContractBlankCore } from "./contract-creation-core";
import { executedContractPdfFor } from "./contract-files-core";
import { createDailyLogCore } from "./daily-log-core";
import { normalizeSelectionItemNote } from "./selection-item-notes";
// Import the -core module, not the "server-only" wrapper: actions.ts is in the
// verify suites' import graph (verify-crew-overlays.ts), and tsx cannot resolve
// server-only outside a Next build. Same split selection-ai-sort-apply-core uses.
import { persistSelectionItemNote } from "./selection-item-note-persistence-core";
import {
    markSelectionItemThreadRead as markSelectionItemThreadReadCore,
    parseThreadAttachments,
    unreadThreadCommentCount,
} from "./selection-item-thread-core";
import { findThreadItem } from "./selection-item-thread-dependencies";
import { lockReceiptEvidence, withReceiptEvidenceLock } from "./receipt-evidence-lock";

type NotificationToggleKey = "newLead" | "estimateViewed" | "estimateSigned" | "contractSigned" | "invoiceViewed" | "paymentReceived" | "messageReceived";

// Server runs in UTC; "Viewed at" timestamps in notification emails must render
// in the company's timezone, not the server's.
async function formatViewedAt(): Promise<string> {
    const timeZone = await resolveCompanyTimeZone();
    return new Date().toLocaleString("en-US", { timeZone });
}

function isNotificationEnabled(settings: { notificationToggles?: string | null } | null, key: NotificationToggleKey): boolean {
    if (!settings?.notificationToggles) return true;
    try {
        const toggles = JSON.parse(settings.notificationToggles);
        return toggles[key] !== false;
    } catch {
        return true;
    }
}

// Build a CC array from any number of candidate addresses (spouse/partner, lead manager,
// send-time extras). Drops blanks, the primary recipient, and case-insensitive duplicates.
// Returns undefined when nothing is left to CC.
function buildCc(primaryEmail: string, ...candidates: (string | null | undefined)[]): string[] | undefined {
    const primary = (primaryEmail || "").trim().toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of candidates) {
        const e = c?.trim();
        if (!e) continue;
        const key = e.toLowerCase();
        if (key === primary || seen.has(key)) continue;
        seen.add(key);
        out.push(e);
    }
    return out.length ? out : undefined;
}

// Best-effort client IP for the e-signature audit trail. Server actions can read request
// headers via next/headers; behind Vercel the client IP is the first x-forwarded-for hop.
async function getRequestIp(): Promise<string | null> {
    try {
        const h = await headers();
        return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
    } catch {
        return null;
    }
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
    await assertEstimateStaffOrPortalAccess(estimateId);
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
        throw new Error("NEXTAUTH_SECRET is not configured");
    }
    const expiry = Math.floor(Date.now() / 1000) + 300; // 5 min
    const payload = `${estimateId}:${expiry}`;
    const sig = createHmac("sha256", secret).update(payload).digest("hex");
    return `${payload}:${sig}`;
}

export async function getLeads() {
    const user = await assertActiveStaff();
    const leads = await prisma.lead.findMany({
        orderBy: { createdAt: "desc" },
        include: {
            client: true,
            estimates: scopedEstimateRelation(safeEstimateInclude, user),
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

export const getLead = cache(async function getLead(id: string) {
    const user = await currentStaffUserOrNull();
    const lead = await prisma.lead.findUnique({
        where: { id },
        include: {
            client: true,
            estimates: scopedEstimateRelation(safeEstimateInclude, user),
            // Scoped for the same reason the estimates relation above is, and
            // it mattered more here: currentStaffUserOrNull() returns null
            // rather than throwing, so `contracts: true` handed an ANONYMOUS
            // caller who knew a lead id every contract field — legal body,
            // signatures, audit metadata and the accessToken that is by itself
            // sufficient to view and sign. That defeated the per-action gates
            // through a differently named action. contractScopeWhere matches
            // nothing for a null user or one without the `contracts`
            // permission. (Codex round-1 blocker.)
            contracts: { where: contractScopeWhere(user) },
            manager: true,
            tasks: {
                orderBy: { createdAt: "desc" }
            },
            roomDesigns: true,
            // Pull the linked project + its estimates so the lead estimates page
            // can surface project estimates alongside lead-direct ones. These are
            // project-owned, so they are scoped by project access, not leadAccess.
            project: {
                select: {
                    id: true,
                    name: true,
                    estimates: scopedEstimateRelation(safeEstimateInclude, user),
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
});

export async function updateLeadStage(id: string, stage: string) {
    await prisma.lead.update({
        where: { id },
        data: { stage }
    });
    revalidatePath(`/leads/${id}`);
    revalidatePath(`/leads`);
}

/** Find a client by name, tolerating legacy rows saved with stray whitespace or
 *  different casing — an exact lookup on a trimmed name would miss e.g. "Dixie Berg "
 *  and create a duplicate client. */
async function findClientByName(name: string) {
    const exact = await prisma.client.findFirst({ where: { name } });
    if (exact) return exact;
    const collapse = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const candidates = await prisma.client.findMany({
        where: { name: { contains: name.trim(), mode: "insensitive" } },
    });
    return candidates.find((c) => collapse(c.name) === collapse(name)) ?? null;
}

export async function createLead(data: { name: string; clientName: string; clientEmail?: string; clientPhone?: string; location?: string; addressLine1?: string; city?: string; state?: string; zipCode?: string; source?: string; projectType?: string; message?: string }) {
    // Find or create client
    const clientName = data.clientName.trim();
    if (!clientName) throw new Error("Client name is required.");
    let client = await findClientByName(clientName);

    if (!client) {
        const initials = clientName
            .split(" ")
            .map((n) => n[0])
            .join("")
            .toUpperCase()
            .slice(0, 2);
        client = await prisma.client.create({
            data: {
                name: clientName,
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

    // Normalize the job-site address (autocomplete isn't enforced client-side,
    // so hand-typed text reaches here); fail-soft keeps the raw string.
    const geo = await geocodeJobSiteAddress(data.location);

    const lead = await prisma.lead.create({
        data: {
            name: data.name,
            clientId: client.id,
            location: geo?.formattedAddress ?? (data.location || null),
            source: data.source || null,
            projectType: data.projectType || null,
            message: data.message || null,
            stage: "New",
        },
    });

    revalidatePath("/leads");

    try {
        const settings = await getCachedCompanySettings();
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
    await assertActiveStaff();
    // One transaction for the whole flow. The guard below is a read, so it cannot stop a
    // Project from being created against this lead a moment later; once
    // Project_leadId_fkey is ON DELETE RESTRICT (migration 20260814120000) that race makes
    // `lead.delete` raise P2003. Run as separate statements the contract deletes would
    // already have committed by then, leaving the lead alive with its contracts gone.
    // Inside the transaction the FK failure rolls the deletes back with it.
    try {
        await prisma.$transaction(async (tx) => {
            // Prevent deletion of leads that have a linked project — checking the FK directly is
            // authoritative. Previously this only checked stage === "Won", but any stage can be
            // linked to a project, and with unlink removed there is no recovery path from a
            // Postgres FK constraint violation.
            const linked = await tx.project.findUnique({ where: { leadId: id }, select: { id: true } });
            if (linked) {
                throw new Error("Cannot delete a lead that has a linked project. Archive it instead.");
            }
            const lead = await tx.lead.findUnique({ where: { id }, select: { stage: true } });
            if (lead?.stage === "Won") {
                throw new Error("Cannot delete a converted lead. Archive it instead.");
            }
            // Contract.lead FK is onDelete:SetNull — explicitly delete lead-only contracts to
            // avoid orphaning rows with both leadId=null and projectId=null after the lead is gone.
            // (Leads with a linked project are already blocked above, so all contracts here have projectId=null.)
            await tx.contract.deleteMany({ where: { leadId: id, projectId: null } });
            await tx.lead.delete({
                where: { id }
            });
        });
    } catch (error: any) {
        // P2003 = FK constraint failure, i.e. a Project was linked to this lead between the
        // guard above and the delete. Nothing was written — report it the same way the guard
        // does instead of surfacing a raw Prisma error.
        if (error?.code === "P2003") {
            throw new Error("Cannot delete a lead that has a linked project. Delete the project first.");
        }
        throw error;
    }
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

    // Normalize the job-site address before the transaction (external call).
    // EditLeadModal sends the whole form, so skip the lookup when unchanged.
    const geo = data.location && data.location !== lead.location
        ? await geocodeJobSiteAddress(data.location)
        : null;
    const location = geo?.formattedAddress ?? data.location;

    const updateData: any = {
        source: data.source,
        stage: data.stage,
        location,
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
                await tx.project.update({
                    where: { id: linked.id },
                    data: {
                        location: location || null,
                        // Precise geocode also refreshes the time-clock geofence;
                        // clearing the address clears it; coarse/failed lookups
                        // leave existing coordinates alone.
                        ...(geo?.lat != null && geo?.lng != null
                            ? { locationLat: geo.lat, locationLng: geo.lng }
                            : !location ? { locationLat: null, locationLng: null } : {}),
                    },
                });
                linkedProjectId = linked.id;
            }
        }
    });

    // Also update client if passed in
    const updatedClientName = data.clientName?.trim();
    if (data.clientName && !updatedClientName) throw new Error("Client name cannot be blank.");
    if (updatedClientName) {
        await prisma.client.update({
            where: { id: lead.clientId },
            data: {
                name: updatedClientName,
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
    // Server Actions are remotely invokable, so the getSessionOrDev() check in
    // /settings/contacts guards the page render, not this getter. Without a gate
    // here anyone who can reach the app could read every client's internalNotes
    // and QuickBooks fields plus the full leads relation. The contacts page and
    // its settings nav entry are gated on "logged in" only — no permission key —
    // so the matching rule is active staff, not a per-role scope.
    await assertActiveStaff();
    const clients = await prisma.client.findMany({
        orderBy: { name: "asc" },
        include: {
            // The contacts page only renders a project count and the combobox
            // only needs id/name — no caller reads the project rows themselves,
            // so keep this to ids instead of every column (and every estimate).
            projects: { select: { id: true } },
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
    const name = data.name.trim();
    if (!name) throw new Error("Client name is required.");
    const initials = name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);

    const client = await prisma.client.create({
        data: {
            name,
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
    const name = data.name?.trim();
    if (data.name !== undefined && !name) throw new Error("Client name is required.");
    const client = await prisma.client.update({
        where: { id: clientId },
        data: {
            name,
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

// ── Client tax-exemption certificate (WA DOR: a reseller permit / exemption
// certificate must be on file for every tax-exempt sale) ──────────────────────

const TAX_CERT_ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const TAX_CERT_ALLOWED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "webp", "heic", "heif"];
const TAX_CERT_MAX_BYTES = 10 * 1024 * 1024;

/** Map a public storage URL back to its bucket path, but only within tax-certs/ —
 *  never derive a deletable path from anything else. */
function taxCertStoragePathFromUrl(url: string | null, bucket: string): string | null {
    if (!url) return null;
    try {
        const pathname = new URL(url).pathname;
        const marker = `/storage/v1/object/public/${bucket}/`;
        if (!pathname.startsWith(marker)) return null;
        const path = decodeURIComponent(pathname.slice(marker.length));
        return path.startsWith("tax-certs/") ? path : null;
    } catch {
        return null; // malformed URL or bad % escape — skip cleanup rather than guess
    }
}

async function revalidateClientCertSurfaces(clientId: string) {
    const [linkedProjects, linkedLeads] = await Promise.all([
        prisma.project.findMany({ where: { clientId }, select: { id: true } }),
        prisma.lead.findMany({ where: { clientId }, select: { id: true } }),
    ]);
    for (const p of linkedProjects) revalidatePath(`/projects/${p.id}`, "layout");
    for (const l of linkedLeads) revalidatePath(`/leads/${l.id}`, "layout");
    revalidatePath("/settings/contacts");
}

/** Upload/update the client's tax-exemption certificate. `file` is optional when a
 *  certificate is already on file (metadata-only edit); expiresAt is "YYYY-MM-DD" or "". */
export async function saveClientTaxExemptCert(clientId: string, formData: FormData) {
    "use server";
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");

    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { taxExemptCertUrl: true } });
    if (!client) throw new Error("Client not found");

    const file = formData.get("file");
    const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();
    const note = String(formData.get("note") ?? "").trim();

    let certUrl = client.taxExemptCertUrl;
    if (file instanceof File && file.size > 0) {
        if (file.size > TAX_CERT_MAX_BYTES) throw new Error("Certificate file is too large (10 MB max)");
        // MIME is client-controlled and may be empty — require BOTH a known type and extension.
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (!TAX_CERT_ALLOWED_TYPES.includes(file.type) || !TAX_CERT_ALLOWED_EXTENSIONS.includes(ext)) {
            throw new Error("Certificate must be a PDF or image");
        }

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `tax-certs/${clientId}/${Date.now()}_${safeName}`;
        const buffer = Buffer.from(await file.arrayBuffer());
        certUrl = await uploadSecureDoc(storagePath, buffer, file.type || "application/octet-stream");
    }
    if (!certUrl) throw new Error("Attach a certificate file");

    let expiresAt: Date | null = null;
    if (expiresAtRaw) {
        // Round-trip the UTC parts: JS silently normalizes impossible dates
        // (2026-02-31 -> Mar 3), which would store a different date than submitted.
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiresAtRaw);
        expiresAt = m ? new Date(`${expiresAtRaw}T00:00:00.000Z`) : null;
        const valid = !!m && !!expiresAt && !isNaN(expiresAt.getTime()) &&
            expiresAt.getUTCFullYear() === Number(m[1]) &&
            expiresAt.getUTCMonth() + 1 === Number(m[2]) &&
            expiresAt.getUTCDate() === Number(m[3]);
        if (!valid) throw new Error("Invalid expiration date");
    }

    const updated = await prisma.client.update({
        where: { id: clientId },
        data: {
            taxExemptCertUrl: certUrl,
            taxExemptCertExpiresAt: expiresAt,
            taxExemptCertNote: note || null,
        },
        select: { taxExemptCertUrl: true, taxExemptCertExpiresAt: true, taxExemptCertNote: true },
    });

    await revalidateClientCertSurfaces(clientId);
    // The caller pushes this straight into local component state, which the subsequent
    // router.refresh() won't replace, so hand back a loadable URL rather than a `secure:` ref.
    return JSON.parse(JSON.stringify({
        ...updated,
        taxExemptCertUrl: await resolveDocUrl(updated.taxExemptCertUrl),
    }));
}

export async function removeClientTaxExemptCert(clientId: string) {
    "use server";
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");

    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { taxExemptCertUrl: true } });
    if (!client) throw new Error("Client not found");

    // Conditional clear: only wins if the cert wasn't concurrently replaced, so we
    // never delete an object the row stopped pointing at (superseded certs are kept).
    const { count } = await prisma.client.updateMany({
        where: { id: clientId, taxExemptCertUrl: client.taxExemptCertUrl },
        data: { taxExemptCertUrl: null, taxExemptCertExpiresAt: null, taxExemptCertNote: null },
    });

    // Best-effort: explicit "Remove" should not leave the file reachable.
    if (count === 1) {
        try {
            if (isSecureRef(client.taxExemptCertUrl)) {
                await removeSecureDoc(client.taxExemptCertUrl!);
            } else {
                const { getSupabase, STORAGE_BUCKET } = await import("./supabase");
                const supabase = getSupabase();
                const path = taxCertStoragePathFromUrl(client.taxExemptCertUrl, STORAGE_BUCKET);
                if (supabase && path) await supabase.storage.from(STORAGE_BUCKET).remove([path]);
            }
        } catch (e) {
            console.warn("[removeClientTaxExemptCert] storage cleanup failed:", e instanceof Error ? e.message : e);
        }
    }

    const updated = await prisma.client.findUnique({
        where: { id: clientId },
        select: { taxExemptCertUrl: true, taxExemptCertExpiresAt: true, taxExemptCertNote: true },
    });
    if (!updated) throw new Error("Client not found");

    await revalidateClientCertSurfaces(clientId);
    return JSON.parse(JSON.stringify(updated));
}

export async function updateLead(leadId: string, data: { name?: string; source?: string; expectedStartDate?: string | null; targetRevenue?: number | null; location?: string; projectType?: string }) {
    "use server";
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.source !== undefined) updateData.source = data.source;
    let locationGeo: Awaited<ReturnType<typeof geocodeJobSiteAddress>> = null;
    if (data.location !== undefined) {
        locationGeo = await geocodeJobSiteAddress(data.location);
        updateData.location = locationGeo?.formattedAddress ?? data.location;
    }
    if (data.projectType !== undefined) updateData.projectType = data.projectType;
    if (data.expectedStartDate !== undefined) updateData.expectedStartDate = data.expectedStartDate ? new Date(data.expectedStartDate) : null;
    if (data.targetRevenue !== undefined) updateData.targetRevenue = data.targetRevenue;

    const lead = await prisma.lead.update({
        where: { id: leadId },
        data: updateData,
    });

    // Sync name/location to linked project so they stay a single source of truth
    if (data.name !== undefined || data.location !== undefined) {
        const linkedProject = await prisma.project.findUnique({ where: { leadId } });
        if (linkedProject) {
            await prisma.project.update({
                where: { id: linkedProject.id },
                data: {
                    ...(data.name !== undefined ? { name: data.name } : {}),
                    ...(data.location !== undefined
                        ? {
                            location: updateData.location || null,
                            // Precise geocode also refreshes the time-clock geofence;
                            // clearing the address clears it; coarse/failed lookups
                            // leave existing coordinates alone.
                            ...(locationGeo?.lat != null && locationGeo?.lng != null
                                ? { locationLat: locationGeo.lat, locationLng: locationGeo.lng }
                                : !updateData.location ? { locationLat: null, locationLng: null } : {}),
                        }
                        : {}),
                },
            });
            revalidatePath(`/projects`);
            revalidatePath(`/projects/${linkedProject.id}`, 'layout');
        }
    }

    revalidatePath(`/leads/${leadId}`);
    revalidatePath(`/leads`);
    // targetRevenue/expectedProfit are Prisma Decimals — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(lead));
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
                { cc: meetingCc, copyToInternal: true }
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
    const user = await assertActiveStaff();
    const projects = await prisma.project.findMany({
        orderBy: { viewedAt: "desc" },
        include: {
            client: true,
            estimates: scopedEstimateRelation({ select: { totalAmount: true, status: true } }, user),
        },
    });
    return JSON.parse(JSON.stringify(projects.map((p: any) => ({
        ...p,
        client: p.client || { id: "unassigned", name: "No Client", email: "", primaryPhone: "", addressLine1: "", city: "", state: "", zipCode: "" }
    }))));
}
export const getProject = cache(async function getProject(id: string) {
    const user = await assertActiveStaff();
    const include = {
        client: true,
        estimates: scopedEstimateRelation({
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
                approvedBy: true,
                approvedAt: true,
                approvalIp: true,
                approvalUserAgent: true,
                signatureUrl: true,
                contractId: true,
                viewedAt: true,
            }
        }, user),
    };

    // Support both CUID and friendly numeric ID in URL params
    const numericId = /^\d+$/.test(id) ? parseInt(id, 10) : null;
    const project = numericId
        ? await prisma.project.findFirst({ where: { number: numericId }, include })
        : await prisma.project.findUnique({ where: { id }, include });

    if (project && !project.client) {
        (project as any).client = { id: "unassigned", name: "No Client", email: "", primaryPhone: "", addressLine1: "", city: "", state: "", zipCode: "" };
    }
    return project ? JSON.parse(JSON.stringify(project)) : null;
});

// Staff entry point for lead → project conversion. The conversion itself moves
// every estimate, contract, schedule task and file off the lead and onto a brand
// new project, so as a remotely invokable Server Action it must not run for an
// unauthenticated caller. Mirrors the /leads/[id] layout gate (`leadAccess`),
// which is the only UI that offers "Convert to project".
//
// Callers that authorize the conversion themselves — the portal's
// approveEstimate (client ownership via resolveSessionClientId) and
// /api/manager/jobs (mobile token or session + assertLeadAccess) — call
// convertLeadToProjectCore directly instead; a portal client is not staff and
// would always fail this gate.
export async function convertLeadToProject(leadId: string) {
    const user = await assertActiveStaff();
    if (!hasPermission(user, "leadAccess")) throw new Error("Forbidden");
    return convertLeadToProjectCore(leadId);
}

// Create a project directly (e.g. a repeat customer with another job).
// Maintains the 1-1 Project↔Lead invariant: every project is backed by a lead.
// Pass `clientId` to tie the project to an EXISTING customer, or `clientName`
// (+ optional contact details) to create a new one.
export async function createProject(data: {
    name: string;
    clientId?: string;
    clientName?: string;
    clientEmail?: string;
    clientPhone?: string;
    location?: string;
    addressLine1?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    projectType?: string;
    status?: string;
}) {
    // Same conversion path as convertLeadToProject, and it creates a Client and
    // a Lead on the way — it cannot be left open to an unauthenticated caller.
    // Gated on staff (not `leadAccess`) because the lead here is an internal
    // implementation detail of "new project", offered on /projects.
    await assertActiveStaff();
    if (!data.name?.trim()) throw new Error("Project name is required.");

    // Resolve the customer: prefer an existing client by id; otherwise find-or-create by name.
    let clientId: string | undefined = data.clientId;
    if (clientId) {
        const exists = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
        if (!exists) clientId = undefined;
    }
    if (!clientId) {
        const clientName = (data.clientName || "").trim();
        if (!clientName) throw new Error("A customer is required to create a project.");
        let client = await findClientByName(clientName);
        if (!client) {
            const initials = clientName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
            client = await prisma.client.create({
                data: {
                    name: clientName,
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
        }
        clientId = client.id;
    }

    // Back the project with a lead, then reuse the conversion path so the project is
    // created + linked 1-1 (also provisions Drive and grants team access).
    const lead = await prisma.lead.create({
        data: {
            name: data.name.trim(),
            clientId,
            location: data.location || null,
            projectType: data.projectType || null,
            source: "Direct project",
            stage: "New",
            isUnread: false,
        },
    });

    // Core, not the gated wrapper: this action already authorized the caller
    // above, and it owns the lead it just created.
    const { id: projectId } = await convertLeadToProjectCore(lead.id);

    // Apply project-specific fields the conversion doesn't carry (it defaults status to "Waiting to Start").
    // A provided status always applies — including "In Progress" for callers
    // that explicitly want the job to skip the waiting stage.
    if (data.status) {
        await prisma.project.update({ where: { id: projectId }, data: { status: data.status } });
    }

    revalidatePath("/projects");
    revalidatePath("/leads");
    return { id: projectId };
}

export async function createDraftEstimate(projectId: string) {
    await assertEstimateProjectAccess(projectId);
    // WA is destination-based: default the rate from the job-site address,
    // falling back to the company default (null fields) when unresolvable.
    const taxDefault = await defaultTaxForNewEstimate({ projectId });
    const estimate = await prisma.estimate.create({
        data: {
            title: "Draft Estimate",
            projectId,
            code: "EST-TEMP",
            status: "Draft",
            totalAmount: 0,
            balanceDue: 0,
            privacy: "Shared",
            ...(taxDefault ?? {}),
        },
    });

    // Use the DB-assigned autoincrement number for a collision-free code
    const code = `EST-${String(estimate.number).padStart(5, "0")}`;
    await prisma.estimate.update({ where: { id: estimate.id }, data: { code } });

    revalidatePath(`/projects/${projectId}/estimates`);
    return { id: estimate.id };
}

export async function createDraftLeadEstimate(leadId: string) {
    await assertEstimateLeadAccess(leadId);
    const taxDefault = await defaultTaxForNewEstimate({ leadId });
    const estimate = await prisma.estimate.create({
        data: {
            title: "Draft Estimate",
            leadId,
            code: "EST-TEMP",
            status: "Draft",
            totalAmount: 0,
            balanceDue: 0,
            privacy: "Shared",
            ...(taxDefault ?? {}),
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
            layoutJson: emptyDoc() as any,
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

// Linked-invoice shape shared by BOTH getEstimate query branches (the fallback
// must stay in sync or the editor silently loses this data on a healthy DB).
// Includes the invoice-side payment rows so the editor can diff mirrored rows
// (via sourceScheduleId) against the estimate's schedule — the portal renders
// the invoice's rows once one exists. Oldest-first + take 1 matches
// getEstimateForPortal's pick, so the editor warns about the invoice the
// client actually sees.
const ESTIMATE_LINKED_INVOICE_QUERY = {
    select: {
        id: true, code: true, status: true, projectId: true,
        payments: {
            select: { id: true, name: true, amount: true, sourceScheduleId: true },
            orderBy: { createdAt: "asc" as const },
        },
    },
    orderBy: { createdAt: "asc" as const },
    take: 1,
};

export const getEstimate = cache(async function getEstimate(id: string) {
    await assertEstimateAccess(id);
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
                        purchaseOrderLinks: {
                            orderBy: { createdAt: "asc" },
                            include: { purchaseOrder: { include: { vendor: true } } },
                        },
                        scheduleTask: { select: { id: true, name: true } },
                        _count: { select: { timeEntries: true, expenses: true } },
                    },
                },
                paymentSchedules: { orderBy: { order: "asc" } },
                expenses: true,
                files: { orderBy: { createdAt: "desc" } },
                invoices: ESTIMATE_LINKED_INVOICE_QUERY,
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
                // If the apply-estimate-items-revision.mjs migration hasn't run yet, selecting
                // this column throws P2022 and this whole fallback query fails loudly (caught by
                // getEstimate's own outer try only if a caller wraps it further) rather than
                // silently omitting the column and letting the editor fabricate itemsRevision 0
                // — which would defeat the save-conflict guard for every editor session opened
                // against a not-yet-migrated DB. That's deliberate: CLAUDE.md's schema-before-
                // deploy checklist is what's supposed to prevent this state from being reachable.
                itemsRevision: true,
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
                        purchaseOrderLinks: {
                            orderBy: { createdAt: "asc" },
                            select: {
                                purchaseOrderId: true,
                                purchaseOrder: { select: { id: true, code: true, totalAmount: true, status: true, vendor: { select: { id: true, name: true } } } },
                            },
                        },
                        scheduleTask: { select: { id: true, name: true } },
                        _count: { select: { timeEntries: true, expenses: true } },
                    },
                },
                paymentSchedules: { orderBy: { order: "asc" } },
                expenses: true,
                invoices: ESTIMATE_LINKED_INVOICE_QUERY,
            },
        });
    }
});

export async function updateEstimateStatus(id: string, status: string, leadId?: string, projectId?: string) {
    // Scoped on the estimate's own owner, not the caller-supplied leadId/projectId
    // — those two are revalidatePath hints only and are attacker-controlled.
    const { user } = await assertEstimateAccess(id);

    const VALID_STATUSES = ["Draft", "Sent", "Viewed", "Approved", "Invoiced", "Partially Paid", "Paid", "Declined", "Expired", "Archived"];
    if (!VALID_STATUSES.includes(status)) throw new Error("Invalid status");

    const before = await prisma.estimate.findUnique({
        where: { id },
        select: { status: true, code: true, title: true, projectId: true, leadId: true },
    });
    if (!before) throw new Error("Estimate not found");

    if (before.status !== status) {
        await prisma.estimate.update({
            where: { id },
            data: { status }
        });
        await logActivity({
            projectId: before.projectId,
            leadId: before.leadId,
            actorType: "TEAM",
            actorName: user.name || "Team",
            action: "estimate_status_changed",
            entityType: "estimate",
            entityId: id,
            entityName: `Estimate ${before.code || before.title || ""}`.trim(),
            metadata: { from: before.status, to: status },
        });
    }
    if (leadId) revalidatePath(`/leads/${leadId}`);
    if (projectId) revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/leads/${leadId}/estimates/${id}`);
    revalidatePath(`/projects/${projectId}/estimates/${id}`);
}

export const getEstimateForPortal = cache(async function getEstimateForPortal(id: string) {
    // Staff members can preview an estimate they are scoped to; portal clients
    // must pass the IDOR ownership check below.
    const staffSession = await getServerSession(authOptions);
    // An explicit allowlist, not "any truthy role" — this branch bypasses the
    // client gate below, so an unexpected role value must fall to the client path
    // (which fails closed) rather than be handed staff access.
    const isStaff = ["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE"]
        .includes((staffSession?.user as { role?: string } | undefined)?.role ?? "");
    // The session carries a role but not projectAccess/assignedProjects, so the
    // horizontal check needs the full user row.
    const staffUser = isStaff ? await currentStaffUserOrNull() : null;

    if (!isStaff) {
        // IDOR #2 fix: require a resolvable portal session and gate the fetch by
        // the estimate's owning clientId chain (project.clientId OR lead.clientId).
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) return null;

        // Ownership alone is not enough. An estimate the contractor has never
        // shared is internal pricing, and ids are reachable by walking the
        // sequential `number` route — so AND the shared-ness predicate onto the
        // ownership predicate. AND-composed rather than spread, because two `OR`
        // keys in one object silently drop the first.
        const ownershipFilter = {
            id,
            AND: [
                {
                    OR: [
                        { project: { is: { clientId: sessionClientId } } },
                        { lead: { is: { clientId: sessionClientId } } },
                    ],
                },
                portalVisibleEstimateWhere(),
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
                    files: { orderBy: { createdAt: "desc" } },
                    // Auto-created invoice (signing) — its milestones are the payable source of truth
                    invoices: {
                        select: {
                            id: true, code: true, status: true,
                            payments: {
                                select: {
                                    id: true, name: true, amount: true, status: true, dueDate: true,
                                    paidAt: true, paymentDate: true, paymentMethod: true,
                                    stripeSessionId: true, qbInvoiceLink: true,
                                },
                                orderBy: { createdAt: "asc" },
                            },
                        },
                        orderBy: { createdAt: "asc" },
                        take: 1,
                    },
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
                        files: { select: { id: true, name: true, url: true, size: true, type: true, createdAt: true }, orderBy: { createdAt: "desc" } },
                        paymentSchedules: { orderBy: { order: "asc" } },
                        invoices: {
                            select: {
                                id: true, code: true, status: true,
                                payments: {
                                    select: {
                                        id: true, name: true, amount: true, status: true, dueDate: true,
                                        paidAt: true, paymentDate: true, paymentMethod: true,
                                        stripeSessionId: true, qbInvoiceLink: true,
                                    },
                                    orderBy: { createdAt: "asc" },
                                },
                            },
                            orderBy: { createdAt: "asc" },
                            take: 1,
                        },
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

    // Staff path: fetch by id, narrowed to the estimates this staff user is
    // scoped to. AND-composed rather than spread so a match-nothing predicate
    // cannot overwrite the id it is meant to narrow.
    const staffFilter = { AND: [{ id }, estimateScopeWhere(staffUser)] };
    let estimate: any;
    try {
        estimate = await prisma.estimate.findFirst({
            where: staffFilter,
            include: {
                project: { include: { client: true } },
                lead: { include: { client: true } },
                items: { orderBy: { order: "asc" } },
                paymentSchedules: { orderBy: { order: "asc" } },
                files: { orderBy: { createdAt: "desc" } },
                invoices: {
                    select: {
                        id: true, code: true, status: true,
                        payments: {
                            select: {
                                id: true, name: true, amount: true, status: true, dueDate: true,
                                paidAt: true, paymentDate: true, paymentMethod: true,
                                stripeSessionId: true, qbInvoiceLink: true,
                            },
                            orderBy: { createdAt: "asc" },
                        },
                    },
                    orderBy: { createdAt: "asc" },
                    take: 1,
                },
            },
        });
    } catch (err) {
        console.error("[getEstimateForPortal] Primary query failed:", err);
        try {
            estimate = await prisma.estimate.findFirst({
                where: staffFilter,
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
                    files: { select: { id: true, name: true, url: true, size: true, type: true, createdAt: true }, orderBy: { createdAt: "desc" } },
                    paymentSchedules: { orderBy: { order: "asc" } },
                    invoices: {
                        select: {
                            id: true, code: true, status: true,
                            payments: {
                                select: {
                                    id: true, name: true, amount: true, status: true, dueDate: true,
                                    paidAt: true, paymentDate: true, paymentMethod: true,
                                    stripeSessionId: true, qbInvoiceLink: true,
                                },
                                orderBy: { createdAt: "asc" },
                            },
                        },
                        orderBy: { createdAt: "asc" },
                        take: 1,
                    },
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
});

/** Returns the id of the "Payment in Full" schedule for an estimate, creating one if none exist.
 *  Amount is always derived server-side from balanceDue to prevent client-side manipulation.
 *  Race-safe: catches P2002 on concurrent creates and re-reads the winner. */
export async function ensureEstimatePayInFullSchedule(estimateId: string): Promise<string> {
    "use server";
    await assertEstimateStaffOrPortalAccess(estimateId);
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

export const getAllEstimates = cache(async function getAllEstimates() {
    const user = await assertEstimatePermission();
    // Same rule the estimate detail page applies — see estimateScopeWhere.
    return await prisma.estimate.findMany({
        where: estimateScopeWhere(user),
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
});

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
    // Staff previews must never register as client views.
    const staffSession = await getServerSession(authOptions);
    if ((staffSession?.user as { role?: string } | undefined)?.role) return;

    // Same ownership shape as getEstimateForPortal: only the owning portal
    // client can trip the first-view signal.
    const sessionClientId = await resolveSessionClientId();
    if (!sessionClientId) return;

    // Atomic first-view claim — two simultaneous opens produce exactly one
    // notification and one activity event.
    // Same shared-ness gate as getEstimateForPortal — an estimate the client
    // cannot open must not be markable as viewed either, even by calling this
    // server action directly. AND-composed so the two OR predicates cannot collide.
    const claim = await prisma.estimate.updateMany({
        where: {
            id: estimateId,
            viewedAt: null,
            AND: [
                {
                    OR: [
                        { project: { is: { clientId: sessionClientId } } },
                        { lead: { is: { clientId: sessionClientId } } },
                    ],
                },
                portalVisibleEstimateWhere(),
            ],
        },
        data: { viewedAt: new Date() },
    });
    if (claim.count === 0) return;

    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { viewedAt: true, title: true, code: true, projectId: true, leadId: true, project: { select: { name: true, client: { select: { name: true } } } }, lead: { select: { name: true, client: { select: { name: true } } } } },
    });

    if (estimate) {

        const clientName = estimate.project?.client?.name || estimate.lead?.client?.name || "A client";
        const projectName = estimate.project?.name || estimate.lead?.name || "";
        const settings = await getCachedCompanySettings();
        if (settings.notificationEmail && isNotificationEnabled(settings, "estimateViewed")) {
            await sendNotification(
                settings.notificationEmail,
                `👁️ Estimate Viewed — ${estimate.title || estimate.code}`,
                `<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 20px;">
                        <h3 style="margin: 0 0 8px; color: #0369a1;">Estimate Viewed</h3>
                        <p style="margin: 0 0 4px; color: #333;"><strong>${clientName}</strong> opened estimate <strong>${estimate.title || estimate.code}</strong>${projectName ? ` for ${projectName}` : ""}.</p>
                        <p style="margin: 0; color: #666; font-size: 13px;">Viewed at: ${await formatViewedAt()}</p>
                    </div>
                </div>`
            );
        }

        // Post activity to message thread
        await postActivityToThread(
            estimate.leadId, estimate.projectId,
            `👁️ ${clientName} viewed estimate ${estimate.title || estimate.code}`
        );

        // Log to activity feed (lead-stage estimates log against the lead)
        await logActivity({
            projectId: estimate.projectId,
            leadId: estimate.leadId,
            actorType: "CLIENT",
            actorName: clientName,
            action: "viewed_estimate",
            entityType: "estimate",
            entityId: estimateId,
            entityName: `Estimate ${estimate.code || estimate.title}`,
        });
    }
}

export type EstimateActivityEvent = {
    id: string;
    ts: string; // ISO timestamp
    kind: "created" | "sent" | "viewed" | "signed" | "invoice" | "payment" | "other";
    title: string;
    detail?: string | null;
};

/**
 * Append-only activity feed for one estimate: ActivityLog events (every send,
 * incl. resends), legacy single-timestamp baselines for estimates that predate
 * the log, plus the linked invoice's lifecycle and settled payments read live —
 * so payment history is always complete without any extra logging.
 */
export async function getEstimateActivity(estimateId: string): Promise<EstimateActivityEvent[]> {
    await assertEstimateAccess(estimateId);
    const [estimate, logs, invoice] = await Promise.all([
        prisma.estimate.findUnique({
            where: { id: estimateId },
            select: { createdAt: true, sentAt: true, viewedAt: true, approvedAt: true, approvedBy: true },
        }),
        prisma.activityLog.findMany({
            where: { entityType: "estimate", entityId: estimateId },
            orderBy: { createdAt: "asc" },
        }),
        prisma.invoice.findFirst({
            where: { estimateId },
            select: {
                code: true, createdAt: true, sentAt: true, viewedAt: true,
                payments: {
                    select: { id: true, name: true, amount: true, status: true, paidAt: true, paymentDate: true, paymentMethod: true, referenceNumber: true, sourceScheduleId: true },
                    orderBy: { createdAt: "asc" },
                },
            },
        }),
    ]);
    if (!estimate) return [];

    const events: EstimateActivityEvent[] = [
        { id: "created", ts: estimate.createdAt.toISOString(), kind: "created", title: "Estimate created" },
    ];
    // Legacy baselines from the single-timestamp columns. Hidden only when a log
    // event of the same action sits within 5 minutes (i.e. it IS that same send —
    // sends made after the activity log shipped write both). An older baseline
    // (e.g. the original Oct send) always stays even after later resends.
    const hasLogNear = (action: string, at: Date) =>
        logs.some(l => l.action === action && Math.abs(l.createdAt.getTime() - at.getTime()) < 5 * 60 * 1000);
    if (estimate.sentAt && !hasLogNear("sent_estimate", estimate.sentAt)) {
        events.push({ id: "sentAt", ts: estimate.sentAt.toISOString(), kind: "sent", title: "Sent to client" });
    }
    if (estimate.viewedAt && !hasLogNear("viewed_estimate", estimate.viewedAt)) {
        events.push({ id: "viewedAt", ts: estimate.viewedAt.toISOString(), kind: "viewed", title: "Viewed by client" });
    }
    if (estimate.approvedAt && !hasLogNear("signed_estimate", estimate.approvedAt)) {
        events.push({ id: "approvedAt", ts: estimate.approvedAt.toISOString(), kind: "signed", title: estimate.approvedBy ? `Signed by ${estimate.approvedBy}` : "Signed & approved" });
    }

    for (const l of logs) {
        let meta: Record<string, unknown> = {};
        try { meta = l.metadata ? JSON.parse(l.metadata) : {}; } catch { /* ignore */ }
        const ts = l.createdAt.toISOString();
        if (l.action === "sent_estimate") {
            const by = l.actorName && l.actorName !== "Team" ? `by ${l.actorName}` : null;
            events.push({ id: l.id, ts, kind: "sent", title: meta.resend ? "Resent to client" : "Sent to client", detail: [typeof meta.to === "string" ? `to ${meta.to}` : null, by].filter(Boolean).join(" · ") || null });
        } else if (l.action === "viewed_estimate") {
            events.push({ id: l.id, ts, kind: "viewed", title: "Viewed by client", detail: l.actorName && l.actorName !== "A client" ? l.actorName : null });
        } else if (l.action === "signed_estimate") {
            events.push({ id: l.id, ts, kind: "signed", title: `Signed by ${l.actorName}` });
        } else if (l.action === "estimate_status_changed") {
            const from = typeof meta.from === "string" ? meta.from : "?";
            const to = typeof meta.to === "string" ? meta.to : "?";
            events.push({ id: l.id, ts, kind: "other", title: `Status changed: ${from} → ${to}`, detail: l.actorName && l.actorName !== "Team" ? `by ${l.actorName}` : null });
        } else if (l.action === "payment_received") {
            // Pre-invoice estimate payments (deposits) log against the estimate
            // itself. If an invoice was created later, its copied paid milestone
            // renders the same payment from live data — skip the older log then.
            // Identity match via scheduleId; name match only for legacy logs
            // that predate the scheduleId metadata.
            const milestone = typeof meta.milestone === "string" ? meta.milestone : null;
            const scheduleId = typeof meta.scheduleId === "string" ? meta.scheduleId : null;
            const coveredByInvoiceCopy = !!invoice?.payments.some(p =>
                p.status === "Paid" &&
                (scheduleId ? p.sourceScheduleId === scheduleId : (!!milestone && p.name === milestone))
            );
            if (coveredByInvoiceCopy) continue;
            events.push({ id: l.id, ts, kind: "payment", title: "Payment received", detail: [milestone, typeof meta.method === "string" ? meta.method.replace(/_/g, " ") : null, typeof meta.referenceNumber === "string" ? `#${meta.referenceNumber}` : null].filter(Boolean).join(" · ") || null });
        } else {
            events.push({ id: l.id, ts, kind: "other", title: l.action.replace(/_/g, " "), detail: l.entityName });
        }
    }

    if (invoice) {
        events.push({ id: "inv-created", ts: invoice.createdAt.toISOString(), kind: "invoice", title: `Invoice ${invoice.code} created` });
        if (invoice.sentAt) events.push({ id: "inv-sent", ts: invoice.sentAt.toISOString(), kind: "invoice", title: `Invoice ${invoice.code} sent to client` });
        if (invoice.viewedAt) events.push({ id: "inv-viewed", ts: invoice.viewedAt.toISOString(), kind: "viewed", title: `Invoice ${invoice.code} viewed by client` });
        for (const p of invoice.payments) {
            if (p.status !== "Paid") continue;
            const ts = (p.paidAt || p.paymentDate || invoice.createdAt).toISOString();
            const amt = toNum(p.amount).toLocaleString("en-US", { style: "currency", currency: "USD" });
            const method = p.paymentMethod ? p.paymentMethod.replace(/_/g, " ") : null;
            events.push({
                id: `pay-${p.id}`, ts, kind: "payment",
                title: `Payment received — ${amt}`,
                detail: [p.name, method, p.referenceNumber ? `#${p.referenceNumber}` : null].filter(Boolean).join(" · ") || null,
            });
        }
    }

    events.sort((a, b) => a.ts.localeCompare(b.ts));
    return events;
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
        const settings = await getCachedCompanySettings();
        if (settings.notificationEmail) {
            await sendNotification(
                settings.notificationEmail,
                `👁️ Contract Viewed — ${contract.title}`,
                `<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                    <div style="background: #fefce8; border: 1px solid #fde68a; border-radius: 8px; padding: 20px;">
                        <h3 style="margin: 0 0 8px; color: #854d0e;">Contract Viewed</h3>
                        <p style="margin: 0 0 4px; color: #333;"><strong>${clientName}</strong> opened contract <strong>${contract.title}</strong>${projectName ? ` for ${projectName}` : ""}.</p>
                        <p style="margin: 0; color: #666; font-size: 13px;">Viewed at: ${await formatViewedAt()}</p>
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

// ─────────────────────────────────────────────────────────────────────────────
// Signed estimate → project + invoice + QuickBooks deposit pay link.
// Signing is the moment a lead becomes a project — and the first time anything
// is allowed to touch QuickBooks (keeps QBO free of unsold estimates).
// Every step is fail-soft: a QBO outage can never block a client's signature.
// ─────────────────────────────────────────────────────────────────────────────
interface PostApprovalInfo {
    projectId: string;
    invoiceId: string;
    invoiceCode: string;
    depositName: string | null;
    depositAmount: number | null;
    payLink: string | null;
}

async function ensureProjectAndDepositInvoiceForEstimate(estimateId: string): Promise<PostApprovalInfo | null> {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { id: true, projectId: true, leadId: true },
    });
    if (!estimate) return null;

    // 1) Ensure a project exists (idempotent — conversion returns the existing one).
    let projectId = estimate.projectId;
    if (!projectId && estimate.leadId) {
        // Core, not the gated wrapper: the caller here is approveEstimate, which
        // has already proven the signed-in PORTAL CLIENT owns this estimate
        // (resolveSessionClientId + project.clientId/lead.clientId). A portal
        // client is not staff, so the staff gate would reject a legitimate
        // client approval.
        const converted = await convertLeadToProjectCore(estimate.leadId);
        projectId = converted.id;
    }
    if (!projectId) return null;

    // 1.5) Tax integrity: if the estimate never had a tax rate chosen, the portal
    // DISPLAY adds the default rate on top while the stored total excludes it —
    // the client would see more than they get billed. Snapshot the default rate
    // and gross the totals (and pending milestones) up to match what was shown,
    // exactly once, before any invoice is created from it.
    const taxCheck = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { taxRatePercent: true, taxExempt: true, totalAmount: true, balanceDue: true },
    });
    if (taxCheck && !taxCheck.taxExempt && taxCheck.taxRatePercent == null) {
        const defaultRate = await getDefaultSalesTaxRate();
        if (defaultRate > 0) {
            const factor = 1 + defaultRate / 100;
            await prisma.estimate.update({
                where: { id: estimateId },
                data: {
                    taxRatePercent: defaultRate,
                    totalAmount: Math.round(toNum(taxCheck.totalAmount) * factor * 100) / 100,
                    balanceDue: Math.round(toNum(taxCheck.balanceDue) * factor * 100) / 100,
                },
            });
            await prisma.$executeRaw`UPDATE "EstimatePaymentSchedule" SET amount = ROUND(amount * ${factor}::numeric, 2) WHERE "estimateId" = ${estimateId} AND status = 'Pending'`;
        }
    }

    // 2) One invoice per signed estimate (idempotent on re-approval).
    let invoice = await prisma.invoice.findFirst({
        where: { estimateId },
        select: { id: true, code: true },
    });
    if (!invoice) {
        const created = await createInvoiceFromEstimateInternal(estimateId);
        invoice = await prisma.invoice.update({
            where: { id: created.id },
            data: { status: "Issued", issueDate: new Date() },
            select: { id: true, code: true },
        });
    }
    // The money now lives on the invoice — flip the estimate to Invoiced so
    // financial forecasts don't count the same dollars twice. Runs outside the
    // creation branch so a re-approval can't leave the status stuck on Approved,
    // and never downgrades a payment-driven status (Partially Paid / Paid).
    await prisma.estimate.updateMany({
        where: { id: estimateId, status: { in: ["Sent", "Viewed", "Approved"] } },
        data: { status: "Invoiced" },
    });

    // 3) ONLY the deposit gets a QuickBooks invoice + hosted pay link here, so it can
    //    ride the approval email. The rest of the schedule stays a suggestion until
    //    someone deliberately bills it ("QuickBooks Link" per milestone today, the
    //    progress-invoice builder next) — staging the whole schedule up front filled
    //    QuickBooks with invoices nobody had billed yet and let payments land against
    //    amounts that had since changed (Mesplay: a $25k check against a staged $40k
    //    milestone, 2026-07). One approval, one QuickBooks invoice.
    let payLink: string | null = null;
    const pendingMilestones = await prisma.paymentSchedule.findMany({
        where: { invoiceId: invoice.id, status: "Pending" },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, amount: true },
    });
    const deposit = pendingMilestones[0] || null;
    if (deposit) {
        try {
            const { pushMilestoneToQuickBooks } = await import("./quickbooks-payments");
            const pushed = await pushMilestoneToQuickBooks(deposit.id);
            payLink = pushed.payLink;
        } catch (e) {
            // QuickBooks not connected or unreachable — Stripe portal payment and
            // manual recording still work; the PM can push links later.
            console.warn("[approveEstimate] QuickBooks deposit push skipped:", e instanceof Error ? e.message : e);
        }
    }

    revalidatePath(`/projects/${projectId}/invoices`);
    revalidatePath(`/invoices`);
    revalidatePath(`/portal`);

    return {
        projectId,
        invoiceId: invoice.id,
        invoiceCode: invoice.code,
        depositName: deposit?.name || null,
        depositAmount: deposit ? toNum(deposit.amount) : null,
        payLink,
    };
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

    // ─── 0. The job is won: ensure project + invoice + QuickBooks deposit link ───
    let postApproval: PostApprovalInfo | null = null;
    try {
        postApproval = await ensureProjectAndDepositInvoiceForEstimate(estimateId);
        if (postApproval && estimate && !estimate.projectId) {
            // Conversion just created the project — let the signed-PDF filing below see it.
            (estimate as { projectId: string | null }).projectId = postApproval.projectId;
        }
    } catch (e) {
        console.error("[approveEstimate] post-approval automation failed:", e);
    }

    // Backstop: an approved estimate is about to be worked by crew, whose
    // clock-in is blocked on cost-coded line items. saveEstimate already
    // auto-codes on every save, but cover the approval path too in case items
    // were added some other way. Scheduled post-response via after() so this
    // Anthropic call never blocks the signature/approval flow. after() throws
    // synchronously outside a request scope (direct invocation/scripts) — fall
    // back to a caught floating promise so the approval itself never fails here.
    const autoAssignAfterApprove = () =>
        autoAssignPhasesForEstimate(estimateId).catch((e) =>
            console.error("[approveEstimate] auto-assign phases failed:", e instanceof Error ? e.message : e)
        );
    try {
        after(autoAssignAfterApprove);
    } catch {
        void autoAssignAfterApprove();
    }

    await logActivity({
        projectId: estimate?.projectId,
        leadId: estimate?.leadId,
        actorType: "CLIENT",
        actorName: signatureName,
        action: "signed_estimate",
        entityType: "estimate",
        entityId: estimateId,
        entityName: `Estimate ${estimate?.code || estimateId}`,
    });

    const settings = await getCachedCompanySettings();
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
        if (capturedPdfUrl) {
            pdfBuffer = await downloadDocBytes(capturedPdfUrl);
            if (!pdfBuffer) {
                console.warn("[approveEstimate] Failed to read capturedPdfUrl:", capturedPdfUrl);
            }
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
                    ${postApproval?.depositAmount ? `
                    <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 16px 18px; margin-bottom: 20px;">
                        <p style="margin: 0 0 10px; color: #312e81; font-size: 14px; font-weight: 600;">Next step — ${postApproval.depositName || "Deposit"}: ${formatCurrency(postApproval.depositAmount)}</p>
                        ${postApproval.payLink
                            ? `<a href="${postApproval.payLink}" style="display: inline-block; background: #4f46e5; color: #ffffff; font-size: 14px; font-weight: 600; padding: 11px 24px; border-radius: 8px; text-decoration: none;">Pay Securely Online</a>
                               <p style="margin: 10px 0 0; color: #6366f1; font-size: 12px;">Card, debit, or bank transfer on QuickBooks' secure page · Invoice ${postApproval.invoiceCode}</p>`
                            : `<p style="margin: 0; color: #4338ca; font-size: 13px;">Invoice ${postApproval.invoiceCode} has been created for your project — we'll follow up with payment instructions.</p>`}
                    </div>` : ""}
                    <p style="color: #64748b; font-size: 13px; line-height: 1.6; margin: 0;">
                        If you have any questions, feel free to reach out to us${settings.phone ? ` at ${settings.phone}` : ""}${settings.email ? ` or ${settings.email}` : ""}.
                    </p>
                </div>
                <p style="text-align: center; color: #94a3b8; font-size: 11px; margin-top: 16px;">${companyName}${settings.address ? ` • ${settings.address}` : ""}</p>
            </div>`,
            attachments,
            { fromName: companyName, replyTo: settings.email || undefined, cc: approvedCc, copyToInternal: true }
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
        let filedSecureRef: string | null = null;
        try {
            // Find or create a SHARED "Signed Documents" folder for this project.
            //
            // A client must be able to open their own signed estimate at any time.
            // The portal only lists folders whose whole ancestor chain is "shared"
            // (api/portal/files + isAncestorChainShared), so a team folder here makes
            // the document unreachable no matter what the file says — which is
            // exactly how 13 signed estimates across 6 projects ended up invisible to
            // their clients.
            //
            // A same-named folder that is NOT shared is deliberately left alone
            // rather than promoted: the name is not reserved, staff can create one,
            // and flipping it would publish every null-visibility file already inside
            // to the client as a side effect of approving an unrelated estimate. In
            // that case the PDF is filed at the project root with explicit "shared" —
            // exactly what archiveExecutedContractPdf does for executed contracts,
            // which has always been client-visible and correct.
            let folder = await prisma.fileFolder.findFirst({
                where: {
                    projectId: estimate.projectId,
                    name: "Signed Documents",
                    parentId: null,
                    visibility: "shared",
                },
            });
            if (!folder) {
                const conflicting = await prisma.fileFolder.findFirst({
                    where: { projectId: estimate.projectId, name: "Signed Documents", parentId: null },
                    select: { id: true, visibility: true },
                });
                if (conflicting) {
                    console.warn(
                        `[approveEstimate] "Signed Documents" exists on project ${estimate.projectId} with visibility "${conflicting.visibility}"; filing the signed PDF at the project root so the client can still reach it (promoting that folder could expose unrelated files).`,
                    );
                } else {
                    folder = await prisma.fileFolder.create({
                        data: { name: "Signed Documents", projectId: estimate.projectId, visibility: "shared" },
                    });
                }
            }

            // Upload to the private secure-docs bucket
            const storagePath = `projects/${estimate.projectId}/signed/${Date.now()}_${pdfFilename}`;
            filedSecureRef = await uploadSecureDoc(storagePath, pdfBuffer, "application/pdf");

            await prisma.projectFile.create({
                data: {
                    name: pdfFilename,
                    url: filedSecureRef,
                    size: pdfBuffer.length,
                    mimeType: "application/pdf",
                    projectId: estimate.projectId,
                    // null => project root, which the client can still reach because
                    // the visibility below is explicit.
                    folderId: folder?.id ?? null,
                    // Explicit, not inherited: a null visibility only reads as shared
                    // while the file sits inside a shared folder, so it would silently
                    // un-share the moment anyone moved it or changed the folder. This
                    // matches archiveExecutedContractPdf, which already files executed
                    // contracts as explicitly shared.
                    visibility: "shared",
                },
            });

            // The portal-captured PDF (if any) was only a transient capture used to build
            // pdfBuffer above — now that a permanent copy is filed, remove the temporary
            // object so it doesn't linger as an orphan duplicate in the private bucket.
            if (capturedPdfUrl && isSecureRef(capturedPdfUrl)) {
                try {
                    await removeSecureDoc(capturedPdfUrl);
                } catch (cleanupErr) {
                    console.error("[approveEstimate] Failed to remove transient captured PDF:", cleanupErr);
                }
            }
        } catch (fileErr) {
            // The upload may have succeeded even though the DB write failed — remove the
            // orphaned storage object so a retry doesn't leave a dangling signed PDF behind.
            if (filedSecureRef) {
                try { await removeSecureDoc(filedSecureRef); } catch {}
            }
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

    // (signing is already logged to the activity feed right after post-approval
    //  automation — that entry also covers lead-stage estimates)

    if (estimate?.projectId) {
        const existingBudget = await prisma.budget.findUnique({ where: { estimateId } });
        if (!existingBudget) {
            const itemsList = await prisma.estimateItem.findMany({ where: { estimateId } });
            const parentIds = new Set(itemsList.map(item => item.parentId).filter(Boolean));
            const leafItems = itemsList.filter(item => !parentIds.has(item.id) && item.type !== "Section");

            let totalLaborBudget = 0;
            let totalMaterialBudget = 0;
            for (const item of leafItems) {
                if (item.type === "Labor") {
                    totalLaborBudget += toNum(item.total);
                } else {
                    totalMaterialBudget += toNum(item.total);
                }
            }
            await prisma.budget.create({
                data: {
                    projectId: estimate.projectId,
                    estimateId,
                    totalLaborBudget,
                    totalMaterialBudget,
                },
            });
        }

        revalidatePath(`/projects/${estimate.projectId}/estimates`);
        revalidatePath(`/projects/${estimate.projectId}/files`);
    }
    // Post-commit best effort: approval/invoice/budget work above must stand even
    // if schedule generation is skipped or fails.
    try {
        await autoGenerateScheduleForApprovedEstimate(estimateId);
    } catch (error) {
        console.error("[approveEstimate] schedule auto-generation failed (approval unaffected):", error);
    }
    revalidatePath(`/portal/estimates/${estimateId}`);
    return { success: true };
}

export async function deleteInvoice(invoiceId: string) {
    await assertInvoicePermission();

    // Guard failures return { error } instead of throwing: production masks
    // thrown server-action messages, so the client would never see the reason.
    try {
    const projectId = await withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, { invoiceId });
        const invoice = await tx.invoice.findUnique({
            where: { id: invoiceId },
            include: { payments: true },
        });
        if (!invoice) throw new Error("Invoice not found");

        const hasPaidPayments = invoice.payments.some((p) => p.status === "Paid");
        if (hasPaidPayments) throw new Error("Cannot delete an invoice with recorded payments");
        if (invoice.status === "Paid" || invoice.status === "Partially Paid") {
            throw new Error("Cannot delete a paid or partially paid invoice");
        }
        const { assertInvoiceHasNoChangeOrderBilling } = await import("./billing-core");
        await assertInvoiceHasNoChangeOrderBilling(tx, invoiceId, "delete");

        await tx.invoice.delete({ where: { id: invoiceId } });
        return invoice.projectId;
    }));
    revalidatePath("/projects/" + projectId + "/invoices");
    revalidatePath("/invoices");
    return { success: true as const, projectId };
    } catch (e: any) {
        return { success: false as const, error: e?.message || "Cannot delete this invoice" };
    }
}
export async function updateInvoiceNotes(invoiceId: string, notes: string) {
    await assertInvoicePermission();
    const invoice = await prisma.invoice.update({
        where: { id: invoiceId },
        data: { notes },
    });
    revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    return { success: true };
}

export async function sendInvoiceToClient(invoiceId: string, overrideEmail?: string) {
    // Customer-facing send from the UI — require the invoices permission (this
    // export is a remotely invokable server action). Core logic lives in
    // billing-core.ts so the shared-secret-gated MCP connector can reuse it.
    await assertInvoicePermission();
    const { sendInvoiceToClientCore } = await import("./billing-core");
    return sendInvoiceToClientCore(invoiceId, overrideEmail);
}

export async function sendMilestoneInvoices(
    invoiceId: string,
    paymentScheduleIds: string[],
    overrideEmail?: string,
    // Per-milestone reconcile intents the user explicitly confirmed in the review
    // step: scheduleId -> the QBO total they saw and approved.
    opts?: { reconcile?: Record<string, number> },
) {
    // Permission gate stays here (remotely invokable server action); the send
    // logic lives in billing-core.ts, shared with the MCP connector.
    const actor = await assertInvoicePermission();
    const { sendMilestoneInvoicesCore } = await import("./billing-core");
    return sendMilestoneInvoicesCore(invoiceId, paymentScheduleIds, overrideEmail, opts, actor.name || "");
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
                    payments: { include: { coBilling: { select: { id: true, changeOrderId: true, label: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
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
                payments: { include: { coBilling: { select: { id: true, changeOrderId: true, label: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
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

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function markInvoiceViewed(invoiceId: string, focusedMilestoneIds?: string[]) {
    const sessionClientId = await assertInvoicePortalAccess();
    if (!sessionClientId) return;

    // Client-supplied (from the portal's ?milestone= param) — validated against
    // the invoice's own payments below before it influences anything.
    const claimedFocusIds = Array.isArray(focusedMilestoneIds)
        ? focusedMilestoneIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 50).slice(0, 40)
        : [];

    const claim = await prisma.invoice.updateMany({
        where: {
            id: invoiceId,
            viewedAt: null,
            OR: [
                { clientId: sessionClientId },
                { project: { clientId: sessionClientId } },
            ],
        },
        data: { viewedAt: new Date() },
    });
    if (claim.count === 0) return;

    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: {
            viewedAt: true, code: true, projectId: true,
            project: { select: { name: true, client: { select: { name: true } } } },
            client: { select: { name: true } },
            payments: { select: { id: true, name: true, amount: true, status: true, qbInvoiceId: true, qbSyncError: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        },
    });
    if (invoice) {
        const clientName = invoice.client?.name || invoice.project?.client?.name || "A client";
        const projectName = invoice.project?.name || "";
        // The milestones the client was actually looking at (focused portal view).
        // Pending-only — same predicate as the portal's focus mode and the PDF.
        const focusedPayments = invoice.payments.filter(
            p => claimedFocusIds.includes(p.id) && p.status === "Pending"
        );
        const focusedTotal = focusedPayments.reduce((sum, p) => sum + Number(p.amount), 0);
        try {
            const settings = await getCachedCompanySettings();
            if (settings.notificationEmail && isNotificationEnabled(settings, "invoiceViewed")) {
                const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
                const editorUrl = invoice.projectId ? `${appUrl}/projects/${invoice.projectId}/invoices/${invoiceId}` : `${appUrl}/invoices`;

                let attachments: { filename: string; content: Buffer }[] | undefined = undefined;
                try {
                    const { generateInvoicePdf } = await import("./pdf");
                    const pdfBuffer = await generateInvoicePdf(invoiceId, {
                        requestedMilestoneIds: focusedPayments.map(p => p.id),
                    });
                    if (pdfBuffer) {
                        attachments = [{ filename: `Invoice_${invoice.code}.pdf`, content: pdfBuffer }];
                    }
                } catch (e) {
                    console.error("[markInvoiceViewed] PDF generation failed; sending without attachment:", e);
                }

                const focusedLine = focusedPayments.length > 0
                    ? `<p style="margin: 0 0 4px; color: #333;">They were viewing the payment request for <strong>${focusedPayments.map(p => escapeHtml(p.name)).join(" · ")}</strong> (${formatCurrency(focusedTotal)}).</p>`
                    : "";

                // Each milestone maps to its own QBO invoice (schema.prisma:595), so there is no
                // single "the" QuickBooks invoice for this ProBuild invoice. When the portal scoped
                // the view to specific milestones, link only those — note this keys off the CLAIM,
                // not off focusedPayments, so a stale/invalid ?milestone= param doesn't silently
                // widen into "link everything". Milestones not staged to QuickBooks have no link.
                //
                // qbSyncError ("voided" | "notFound") is set by the sync poller when the linked QBO
                // invoice is gone, and it deliberately KEEPS qbInvoiceId so the Break-QB-Link flow
                // can still act on it. Linking a flagged row would point at a dead or stale QBO
                // page, so those fall back to the ProBuild button instead.
                const scopedView = claimedFocusIds.length > 0;
                const qbLinked = (scopedView ? focusedPayments : invoice.payments)
                    .filter(p => !p.qbSyncError)
                    .map(p => ({ name: p.name, amount: Number(p.amount), qbId: (p.qbInvoiceId || "").trim() }))
                    .filter(p => p.qbId.length > 0);
                const qbUrlFor = (qbId: string) => `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(qbId)}`;
                const btn = (href: string, label: string) =>
                    `<a href="${href}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 14px;">${label}</a>`;

                let ctaBlock: string;
                if (qbLinked.length === 1) {
                    ctaBlock = `<div style="text-align: center; margin: 16px 0;">
                                ${btn(qbUrlFor(qbLinked[0].qbId), "View in QuickBooks")}
                            </div>`;
                } else if (qbLinked.length > 1) {
                    const heading = scopedView
                        ? "QuickBooks invoices for the milestones they viewed:"
                        : `This invoice has ${qbLinked.length} QuickBooks invoices, one per milestone:`;
                    ctaBlock = `<p style="margin: 16px 0 8px; color: #333; font-size: 13px;">${heading}</p>
                            <div style="margin: 0 0 16px;">
                                ${qbLinked.map(p => `<p style="margin: 0 0 6px;"><a href="${qbUrlFor(p.qbId)}" style="color: #059669; font-weight: 600; text-decoration: none;">${escapeHtml(p.name)} — ${formatCurrency(p.amount)}</a></p>`).join("")}
                            </div>`;
                } else {
                    // Nothing staged to QuickBooks yet — the ProBuild invoice is the only real target.
                    ctaBlock = `<div style="text-align: center; margin: 16px 0;">
                                ${btn(editorUrl, "View Invoice")}
                            </div>`;
                }
                await sendNotification(
                    settings.notificationEmail,
                    `👁️ Invoice Viewed — ${invoice.code}`,
                    `<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                        <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 20px;">
                            <h3 style="margin: 0 0 8px; color: #065f46;">Invoice Viewed</h3>
                            <p style="margin: 0 0 4px; color: #333;"><strong>${escapeHtml(clientName)}</strong> opened invoice <strong>${escapeHtml(invoice.code)}</strong>${projectName ? ` for ${escapeHtml(projectName)}` : ""}.</p>
                            ${focusedLine}
                            <p style="margin: 0 0 16px; color: #666; font-size: 13px;">Viewed at: ${await formatViewedAt()}</p>
                            ${ctaBlock}
                            ${qbLinked.length > 0 ? `<p style="margin: 0 0 12px; text-align: center;"><a href="${editorUrl}" style="color: #666; font-size: 12px;">Open in ProBuild</a></p>` : ""}
                            ${attachments ? `<p style="margin: 0; color: #666; font-size: 12px; text-align: center;">A PDF copy of the invoice as the client saw it is attached.</p>` : ""}
                        </div>
                    </div>`,
                    attachments
                );
            }
        } catch (e) {
            console.error("[markInvoiceViewed] Notification block failed:", e);
        }
        await logActivity({
            projectId: invoice.projectId,
            actorType: "CLIENT",
            actorName: clientName,
            action: "viewed_invoice",
            entityType: "invoice",
            entityId: invoiceId,
            entityName: `Invoice ${invoice.code}`,
        });
    }
}

export async function emailInvoiceCopyToMe(
    invoiceId: string
): Promise<{ success: boolean; sentTo?: string; error?: string }> {
    const user = await getCurrentUserWithPermissions();
    if (!user) return { success: false, error: "Unauthorized" };
    if (!hasPermission(user, "invoices")) return { success: false, error: "Forbidden" };
    if (!user.email) return { success: false, error: "Your account has no email address" };

    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { code: true },
    });
    if (!invoice) return { success: false, error: "Invoice not found" };

    let pdfBuffer: Buffer;
    try {
        const { generateInvoicePdf } = await import("./pdf");
        pdfBuffer = await generateInvoicePdf(invoiceId);
    } catch (e) {
        console.error("[emailInvoiceCopyToMe] PDF generation failed:", e);
        return { success: false, error: "Failed to generate invoice PDF" };
    }

    const result = await sendNotification(
        user.email,
        `Your copy — Invoice ${invoice.code}`,
        `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
            <p>Here is the copy of invoice <strong>${invoice.code}</strong> you requested. The PDF is attached.</p>
        </div>`,
        [{ filename: `Invoice_${invoice.code}.pdf`, content: pdfBuffer }]
    );
    if (!result.success) return { success: false, error: "Failed to send email" };
    return { success: true, sentTo: user.email };
}

export async function saveEstimate(estimateId: string, contextId: string, contextType: "project" | "lead", data: any, items: any[]) {
    // Scope on the estimate's OWN project/lead, not on the caller-supplied
    // contextId — every argument here is attacker-controlled, so trusting the
    // context id would let a caller name a job it can access while writing to
    // an estimate belonging to one it cannot.
    const scope = await assertEstimateAccess(estimateId);
    // ...and then require the context to MATCH that owner. contextId is not just
    // a revalidatePath hint: the Budget row below is created with
    // `projectId: contextId`, so an unchecked mismatch files an in-scope
    // estimate's budget under an out-of-scope project.
    const expectedContextId = contextType === "project" ? scope.projectId : scope.leadId;
    if (!expectedContextId || contextId !== expectedContextId) {
        throw new Error("Estimate does not belong to the supplied context");
    }
    // Update estimate inside a transaction to guarantee atomicity and avoid partial write inconsistencies.
    // targetMarginPercent must live in safeData so a failure on the main payload does
    // not silently revert the AI budget target to the default.
    // safeOnly re-runs the whole transaction writing only the always-present columns — see the
    // schema-drift fallback below the closure for why the retry has to happen at this level.
    const runSave = (safeOnly: boolean) => prisma.$transaction(async (tx) => {
        // Lock the Estimate row FIRST — before reading paid milestones — for two reasons:
        //  (1) Canonical lock order (Estimate → Invoice → schedules), shared with the payment
        //      flows, so no two money-path transactions can deadlock on inverse lock ordering.
        //  (2) Serializes the balance computation on the Estimate row. A concurrent payment
        //      either committed before we took this lock (so the paidSum read below reflects it)
        //      or is blocked until we commit (so it recomputes against our new totalAmount).
        //      Either way, no committed payment's balanceDue effect is silently overwritten.
        await lockMoneyParents(tx, { estimateId });

        // Estimate-level optimistic-concurrency compare-and-set — see
        // docs/specs/estimate-item-optimistic-concurrency.md REVISION 2. The Estimate row is
        // already locked FOR UPDATE by lockMoneyParents above, so this CAS is airtight (not
        // merely probable): no other transaction can read or write itemsRevision on this row
        // until we commit or roll back. No escape hatch — a payload without a numeric
        // itemsRevision is rejected as stale. The sole caller is the editor, which always sends
        // one.
        // Non-negative safe integer only. A plain `typeof === "number"` let NaN, Infinity and
        // fractional values through to Prisma, where they surface as a generic query/validation
        // error instead of the structured conflict the client knows how to handle.
        if (!Number.isSafeInteger(data.itemsRevision) || data.itemsRevision < 0) {
            throw new EstimateStaleSaveError();
        }
        const revisionCas = await tx.estimate.updateMany({
            where: { id: estimateId, itemsRevision: data.itemsRevision },
            data: { itemsRevision: { increment: 1 } },
        });
        if (revisionCas.count === 0) {
            throw new EstimateStaleSaveError();
        }

        // Preserve payment credits: subtract already-paid milestones from totalAmount.
        // Read AFTER the lock above so paidSum reflects committed-and-locked state, not a stale
        // snapshot taken before a racing payment committed.
        const paidMilestones = await tx.estimatePaymentSchedule.findMany({
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
            ...(data.taxExempt !== undefined && { taxExempt: !!data.taxExempt }),
            ...(data.taxRateName !== undefined && { taxRateName: data.taxRateName }),
            ...(data.taxRatePercent !== undefined && { taxRatePercent: data.taxRatePercent }),
        };

        // On the safeOnly retry, write only the always-present columns. A failed update inside an
        // interactive transaction aborts the whole transaction (Postgres 25P02), so we cannot catch
        // a missing-column error and retry within the same tx — the retry is driven from outside.
        // select: { id: true } keeps the UPDATE ... RETURNING clause off the optional columns, so a
        // DB missing one of them fails only when it is actually being SET — which routes to the
        // safeOnly retry — rather than on every write via RETURNING.
        if (safeOnly) {
            await tx.estimate.update({ where: { id: estimateId }, data: safeData, select: { id: true } });
        } else {
            await tx.estimate.update({
                where: { id: estimateId },
                data: {
                    ...safeData,
                    ...(data.processingFeeMarkup !== undefined && { processingFeeMarkup: data.processingFeeMarkup }),
                    ...(data.hideProcessingFee !== undefined && { hideProcessingFee: data.hideProcessingFee }),
                    ...(data.expirationDate !== undefined && { expirationDate: data.expirationDate }),
                    ...(data.memo !== undefined && { memo: data.memo }),
                    ...(data.termsAndConditions !== undefined && { termsAndConditions: data.termsAndConditions }),
                    ...(data.overviewEnabled !== undefined && { overviewEnabled: !!data.overviewEnabled }),
                    ...(data.overviewTitle !== undefined && { overviewTitle: data.overviewTitle }),
                    ...(data.overviewBody !== undefined && { overviewBody: data.overviewBody }),
                    ...(data.notesEnabled !== undefined && { notesEnabled: !!data.notesEnabled }),
                    ...(data.notesTitle !== undefined && { notesTitle: data.notesTitle }),
                    ...(data.notesBody !== undefined && { notesBody: data.notesBody }),
                    ...(data.notesPlacement !== undefined && { notesPlacement: data.notesPlacement === "before" ? "before" : "after" }),
                },
                select: { id: true },
            });
        }

        // 1. Differential Item Upsert
        const existingItems = await tx.estimateItem.findMany({ where: { estimateId } });
        const existingItemsMap = new Map(existingItems.map(item => [item.id, item]));

        // Payload check, ahead of every item write (and ahead of the destructive delete pass
        // below). Item ids are already scoped by existingItemsMap, but parentId used to be passed
        // straight through, and EstimateItem's self-referencing FK does not require parent and
        // child to share an estimateId — so a save could hang this estimate's rows off another
        // estimate's tree, and the section roll-up would then compute this estimate's subtotal
        // (and therefore its tax and payment milestones) over that other tree. Throwing here
        // aborts the whole transaction, so the estimate-level update above never survives either.
        assertEstimateItemParentsInScope(items, existingItemsMap.keys());

        const incomingItemIds = new Set(items.map(item => item.id).filter(Boolean));
        const deletedItems = existingItems.filter(item => !incomingItemIds.has(item.id));

        if (deletedItems.length > 0) {
            const deletedItemIds = deletedItems.map(item => item.id);
            // Check for linked expenses/time entries first to throw descriptive error before cascading delete
            const linkedExpensesCount = await tx.expense.count({
                where: { itemId: { in: deletedItemIds } }
            });
            const linkedTimeEntriesCount = await tx.timeEntry.count({
                where: { estimateItemId: { in: deletedItemIds } }
            });
            if (linkedExpensesCount > 0 || linkedTimeEntriesCount > 0) {
                const parts = [];
                if (linkedExpensesCount > 0) parts.push(`${linkedExpensesCount} expense(s)`);
                if (linkedTimeEntriesCount > 0) parts.push(`${linkedTimeEntriesCount} time entry/entries`);
                throw new Error(`Cannot delete estimate item(s) because they have linked ${parts.join(" and ")}. Please delete or re-assign these entries first.`);
            }

            // Delete child items first, then parent items to respect FK reference order
            await tx.estimateItem.deleteMany({
                where: {
                    id: { in: deletedItemIds },
                    parentId: { not: null }
                }
            });
            await tx.estimateItem.deleteMany({
                where: {
                    id: { in: deletedItemIds },
                    parentId: null
                }
            });
        }

        // The itemsRevision CAS above already guards this whole write — no per-row conflict
        // handling needed here. The field list lives in lib/estimate-item-payload, shared with
        // the editor's change-detection snapshot so the two can't drift (a snapshot missing a
        // field saveEstimate writes makes edits to it invisible, and the save silently no-ops).
        await upsertEstimateItems(tx, {
            estimateId,
            items,
            existingItemsMap,
        });

        // 2. Differential Payment Schedule Upsert
        const existingSchedules = await tx.estimatePaymentSchedule.findMany({ where: { estimateId } });
        const existingSchedulesMap = new Map(existingSchedules.map(s => [s.id, s]));

        const incomingSchedules = data.paymentSchedules || [];
        const incomingScheduleIds = new Set(incomingSchedules.map((s: any) => s.id).filter(Boolean));

        // Delete schedules that are not in incoming payload AND are not Paid and have no active Stripe session/intent
        const schedulesToDelete = existingSchedules.filter(s => 
            !incomingScheduleIds.has(s.id) &&
            s.status !== "Paid" &&
            !s.stripeSessionId &&
            !s.stripePaymentIntentId
        );

        if (schedulesToDelete.length > 0) {
            await tx.estimatePaymentSchedule.deleteMany({
                where: { id: { in: schedulesToDelete.map(s => s.id) } }
            });
        }

        // Update or insert incoming schedules
        for (let idx = 0; idx < incomingSchedules.length; idx++) {
            const s = incomingSchedules[idx];
            const dueDateParsed = s.dueDate ? new Date(s.dueDate) : null;
            const amountParsed = parseFloat(s.amount) || 0;
            const pctParsed = s.percentage ? parseFloat(s.percentage) : null;

            if (s.id && existingSchedulesMap.has(s.id)) {
                const existing = existingSchedulesMap.get(s.id)!;
                if (existing.status === "Paid") {
                    // Paid schedules preserve status and amount but update name/order/dueDate
                    await tx.estimatePaymentSchedule.update({
                        where: { id: s.id },
                        data: {
                            name: s.name,
                            dueDate: dueDateParsed,
                            order: s.order ?? idx,
                        }
                    });
                } else {
                    await tx.estimatePaymentSchedule.update({
                        where: { id: s.id },
                        data: {
                            name: s.name,
                            percentage: pctParsed,
                            amount: amountParsed,
                            dueDate: dueDateParsed,
                            order: s.order ?? idx,
                        }
                    });
                }
            } else {
                await tx.estimatePaymentSchedule.create({
                    data: {
                        ...(s.id ? { id: s.id } : {}),
                        estimateId,
                        name: s.name,
                        percentage: pctParsed,
                        amount: amountParsed,
                        dueDate: dueDateParsed,
                        order: s.order ?? idx,
                        status: s.status || "Pending",
                    }
                });
            }
        }

        // 3. Project Budget Generation (Leaf items only to avoid double-counting)
        if (data.status === 'Approved' && contextType === 'project') {
            const existingBudget = await tx.budget.findUnique({ where: { estimateId } });
            if (!existingBudget) {
                const itemsList = await tx.estimateItem.findMany({ where: { estimateId } });
                const parentIds = new Set(itemsList.map(item => item.parentId).filter(Boolean));
                const leafItems = itemsList.filter(item => !parentIds.has(item.id) && item.type !== "Section");

                let totalLaborBudget = 0;
                let totalMaterialBudget = 0;
                for (const item of leafItems) {
                    if (item.type === "Labor") {
                        totalLaborBudget += toNum(item.total);
                    } else {
                        totalMaterialBudget += toNum(item.total);
                    }
                }
                await tx.budget.create({
                    data: {
                        projectId: contextId,
                        estimateId,
                        totalLaborBudget,
                        totalMaterialBudget,
                    },
                });
            }
        }

        return { success: true as const, itemsRevision: data.itemsRevision + 1 };
    }, {
        // A full estimate save fans out to ~12 + itemCount + scheduleCount sequential statements;
        // the default 5s interactive-transaction limit is too tight for large estimates that
        // previously committed under autocommit. Give the batch room without being unbounded.
        maxWait: 10000,
        timeout: 30000,
    });

    // Schema-drift fallback (preserves the original "fallback to safe fields if columns missing"
    // behavior). If the deployed DB is missing an optional column, Prisma throws P2022 and the
    // transaction rolls back cleanly; re-run the whole transaction writing only the safe columns.
    // Any other error (e.g. the linked-expense guard, deadlocks) propagates unchanged.
    //
    // EstimateStaleSaveError is checked around BOTH attempts (not just the first) — a conflict
    // can just as easily surface on the safeOnly retry, and prod redacts thrown server-action
    // messages, so an uncaught throw from that retry would reach the client as a generic failure
    // instead of the named conflict. Nothing was written either way (the transaction rolled
    // back), so we return immediately, before the revalidatePath/auto-assign-phases calls below.
    let result;
    try {
        try {
            result = await withTxRetry(() => runSave(false));
        } catch (e: any) {
            if (e?.code === "P2022") {
                result = await withTxRetry(() => runSave(true));
            } else {
                throw e;
            }
        }
    } catch (e: any) {
        if (e instanceof EstimateStaleSaveError) {
            return { success: false as const, conflict: { staleSave: true } };
        }
        throw e;
    }

    if (contextType === "project") {
        revalidatePath(`/projects/${contextId}/estimates`);
        revalidatePath(`/projects/${contextId}/estimates/${estimateId}`);
    } else {
        revalidatePath(`/leads/${contextId}`);
        revalidatePath(`/leads/${contextId}/estimates/${estimateId}`);
    }

    // Auto-code any newly added line items so crew clock-in (which requires
    // cost-coded items) isn't blocked on someone remembering to click
    // "Auto-Assign Phases". Scheduled post-response via after() (not a bare
    // floating promise, which serverless can kill before it finishes) —
    // fail-soft, errors are logged inside the helper, not thrown here. after()
    // throws synchronously outside a request scope (direct invocation/scripts)
    // — fall back to a caught floating promise so the save itself never fails.
    const autoAssignAfterSave = () =>
        autoAssignPhasesForEstimate(estimateId).catch((e) =>
            console.error("[saveEstimate] auto-assign phases failed:", e instanceof Error ? e.message : e)
        );
    try {
        after(autoAssignAfterSave);
    } catch {
        void autoAssignAfterSave();
    }

    return result;
}

/**
 * Read-only: the current `costCodeId` of every line item on an estimate.
 *
 * Exists for one job — letting an open editor learn what `autoAssignPhasesForEstimate` wrote.
 * That helper runs post-response via `after()` on every save and fills `costCodeId` on uncoded
 * rows directly, deliberately WITHOUT bumping `Estimate.itemsRevision` (bumping there would wedge
 * the editor into a permanent conflict, see the comment in auto-assign-phases.ts). Nothing else
 * tells the editor, so its rows keep `costCodeId: null` and its next save writes that null back,
 * silently reverting the assignment. The editor polls this after a save that carried uncoded rows
 * and merges the answer into local state, fill-only.
 *
 * Deliberately returns nothing but ids and codes — in particular NOT `itemsRevision`. The merge
 * is a local catch-up to writes that never bumped the revision, so the editor's revision is still
 * correct and this must not disturb it (or the merge would look like a conflict to its next save).
 */
export async function getEstimateItemCostCodes(estimateId: string): Promise<{ id: string; costCodeId: string | null }[]> {
    "use server";
    // Scoped, like every other estimate action addressed by an estimate id (#333). This action
    // was written on a branch cut before that landed, so it originally carried the old bare
    // `assertEstimatePermission()` — which merges without a git conflict and would have quietly
    // reopened the hole #333 closed.
    await assertEstimateAccess(estimateId);
    return prisma.estimateItem.findMany({
        where: { estimateId },
        select: { id: true, costCodeId: true },
    });
}

export async function logEstimatePayment(estimateId: string, data: { amount: number; paymentMethod: string; date: string; referenceNumber?: string }) {
    "use server";
    await assertEstimateAccess(estimateId);
    // One transaction, estimate locked FIRST (canonical Estimate → Invoice order; this flow
    // touches only the estimate). Without the lock two concurrent logs each read the same
    // balanceDue and each write balanceDue − amount, losing one decrement. The lock serializes
    // them so the second reads the already-decremented balance. withTxRetry recovers a deadlock.
    const result = await withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, { estimateId });
        const estimate = await tx.estimate.findUnique({ where: { id: estimateId } });
        if (!estimate) throw new Error("Estimate not found");

        const refNum = data.referenceNumber || `PM-${String(estimate.number).padStart(5, "0")}`;
        const scheduleCount = await tx.estimatePaymentSchedule.count({ where: { estimateId } });

        const createdSchedule = await tx.estimatePaymentSchedule.create({
            data: {
                estimateId,
                name: `Payment — ${data.paymentMethod} (${refNum})`,
                amount: data.amount,
                dueDate: new Date(data.date),
                order: scheduleCount,
                status: "Paid",
                paidAt: new Date(),
                paymentDate: new Date(data.date),
                paymentMethod: data.paymentMethod.toLowerCase(),
                referenceNumber: refNum,
            },
        });

        // Update balance — round to 2 decimal places to avoid floating-point drift.
        // Read from the locked estimate row above, so no concurrent decrement is lost.
        const newBalance = Math.max(0, Math.round((Number(estimate.balanceDue) - data.amount) * 100) / 100);
        const newStatus = newBalance === 0 ? "Paid" : "Partially Paid";
        const isFirstPayment = !estimate.statusBeforePayment;
        const statusBeforePayment = isFirstPayment ? estimate.status : estimate.statusBeforePayment;

        await tx.estimate.update({
            where: { id: estimateId },
            data: {
                balanceDue: newBalance,
                status: newStatus,
                statusBeforePayment,
            },
        });

        return { createdSchedule, newStatus, newBalance, projectId: estimate.projectId };
    }));

    if (result.projectId) {
        revalidatePath(`/projects/${result.projectId}/estimates/${estimateId}`);
    }
    return { success: true, schedule: result.createdSchedule, newStatus: result.newStatus, newBalance: result.newBalance };
}

export async function archiveEstimate(estimateId: string) {
    "use server";
    await assertEstimateAccess(estimateId);
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

export async function createInvoiceFromEstimate(estimateId: string) {
    // `invoices` says WHAT you may do, not WHICH job — the invoice this mints
    // inherits the estimate's numbers, so the source estimate must be in scope.
    const user = await assertInvoicePermission();
    assertEstimateScope(user, await estimateOwnerOrThrow(estimateId));
    return createInvoiceFromEstimateInternal(estimateId);
}

async function createInvoiceFromEstimateInternal(estimateId: string) {
    const { createInvoiceFromEstimateCore } = await import("./billing-core");
    return createInvoiceFromEstimateCore(estimateId);
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
    await assertInvoicePermission();
    if (!timeEntryIds.length) throw new Error("No time entries selected");

    const result = await withTxRetry(() => prisma.$transaction(async (tx) => {
        const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, clientId: true } });
        if (!project) throw new Error("Project not found");

        const uniqueIds = [...new Set(timeEntryIds)];
        const entries = await tx.timeEntry.findMany({
            where: {
                id: { in: uniqueIds },
                projectId,
                changeOrderId: null,
                invoiceId: null,
                invoicedAt: null,
            },
            include: { user: true, costCode: true },
            orderBy: { id: "asc" },
        });
        if (!entries.length) throw new Error("No eligible untagged and unbilled time entries were selected");
        if (entries.length !== uniqueIds.length) {
            throw new Error("Only untagged, unbilled time entries from this project can be invoiced; refresh and try again.");
        }

        const laborCents = entries.reduce((sum, entry) => sum + Math.round((Number(entry.laborCost) || 0) * 100), 0);
        const totalAmount = laborCents / 100;
        const rate = await getDefaultSalesTaxRate();
        const tax = deriveInvoiceTaxFields(totalAmount, rate, false);
        const invoice = await tx.invoice.create({
            data: {
                code: "INV-TEMP",
                projectId: project.id,
                clientId: project.clientId,
                status: "Draft",
                totalAmount,
                balanceDue: totalAmount,
                subtotal: tax.subtotal,
                taxRate: tax.taxRate,
                taxAmount: tax.taxAmount,
            },
        });
        await tx.invoice.update({
            where: { id: invoice.id },
            data: { code: "INV-" + String(invoice.number).padStart(5, "0") },
        });

        await tx.paymentSchedule.createMany({
            data: entries.map((entry) => ({
                invoiceId: invoice.id,
                name: [
                    entry.user?.name || "Labor",
                    entry.costCode ? "(" + entry.costCode.code + ")" : "",
                    "- " + Number(entry.durationHours || 0).toFixed(1) + "h",
                    "on " + new Date(entry.startTime).toLocaleDateString(),
                ].filter(Boolean).join(" "),
                amount: Math.round((Number(entry.laborCost) || 0) * 100) / 100,
                status: "Pending",
            })),
        });

        const claimed = await tx.timeEntry.updateMany({
            where: { id: { in: uniqueIds }, projectId, changeOrderId: null, invoiceId: null, invoicedAt: null },
            data: { invoiceId: invoice.id, invoicedAt: new Date() },
        });
        if (claimed.count !== uniqueIds.length) {
            throw new Error("A selected time entry was billed or tagged concurrently; no invoice was created. Refresh and try again.");
        }
        return { id: invoice.id, projectId };
    }));

    revalidatePath("/projects/" + projectId + "/invoices");
    revalidatePath("/projects/" + projectId + "/time-expenses");
    return result;
}
export async function getInvoice(id: string) {
    await assertInvoicePermission();
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

// parsePaymentDateInput lives in lib/payment-date.ts, next to isDateOnly — the
// calendar-day sentinel's writer and reader have to agree, so they are unit-tested together.

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

    const VALID_METHODS = ["check", "cash", "zelle", "venmo", "credit_card", "ach", "wire", "quickbooks", "other"];
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

    // Core transaction (claim → recalc → estimate mirror → enqueue notification)
    // lives in payment-record-core.ts, shared with the deposit-ingest endpoint
    // (src/app/api/payments/deposit-ingest/route.ts, Phase B1) so both settle a
    // milestone through the exact same claim-then-recalculate-then-mirror path.
    const result = await recordPaymentCore(paymentId, invoiceId, { paymentDate, method, referenceNumber, notes });
    if (!result.success) return result;
    const tx = result;

    revalidatePath(`/projects/${tx.projectId}/invoices`);
    revalidatePath(`/projects/${tx.projectId}/invoices/${invoiceId}`);
    revalidatePath(`/invoices`);
    revalidatePath(`/portal`);
    revalidatePath(`/reports/open-invoices`);
    revalidatePath(`/reports/sales-tax`);
    revalidatePath(`/reports/payments`);
    revalidatePath(`/reports/transactions`);

    return { success: true };
}

/** Set company monthly overhead (profitability report). ADMIN/FINANCE only. */
export async function updateMonthlyOverhead(amount: number) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } })
        : null;
    if (!caller || !["ADMIN", "FINANCE"].includes(caller.role)) {
        return { success: false as const, error: "Only Admin or Finance can set overhead" };
    }
    if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
        return { success: false as const, error: "Invalid amount" };
    }
    await prisma.companySettings.update({
        where: { id: "singleton" },
        data: { monthlyOverhead: amount },
    });
    revalidatePath("/reports/profitability");
    return { success: true as const };
}

// ─── QuickBooks payment-rail actions (used by InvoiceEditor + portal refresh) ───

/** Create (or fetch) the QuickBooks invoice + hosted pay link for one milestone. */
export async function createQBPaymentLink(paymentId: string) {
    await assertInvoicePermission();
    try {
        const { pushMilestoneToQuickBooks } = await import("./quickbooks-payments");
        const res = await pushMilestoneToQuickBooks(paymentId);
        const schedule = await prisma.paymentSchedule.findUnique({
            where: { id: paymentId },
            select: { invoiceId: true, invoice: { select: { projectId: true } } },
        });
        if (schedule) {
            revalidatePath(`/projects/${schedule.invoice.projectId}/invoices/${schedule.invoiceId}`);
        }
        return { success: true as const, payLink: res.payLink, qbInvoiceId: res.qbInvoiceId };
    } catch (e) {
        return { success: false as const, error: e instanceof Error ? e.message : "QuickBooks push failed" };
    }
}

/** Pull settled QuickBooks payments for one invoice right now (on-view refresh). */
export async function refreshQBPayments(invoiceId: string) {
    await assertInvoicePermission();
    const { syncQuickBooksPayments } = await import("./quickbooks-payments");
    const result = await syncQuickBooksPayments({ invoiceId }, { source: "view" });
    if (result.settled > 0) {
        const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { projectId: true } });
        if (inv) {
            revalidatePath(`/projects/${inv.projectId}/invoices/${invoiceId}`);
            revalidatePath(`/invoices`);
            revalidatePath(`/portal`);
        }
    }
    return result;
}

/**
 * Break a milestone's link to a voided/deleted QuickBooks invoice so it can be
 * re-sent from scratch. Clears the QB tracking fields ONLY — never touches money
 * state. The Paid/qbPaymentId refusal guards are the money-path safety boundary:
 * clearing these fields on a Pending milestone changes no status, fires no
 * notifyMilestonePaid, and doesn't touch the estimate mirror (which has no QB fields).
 *
 * `deleteInQBO` is wired for a future "also delete in QuickBooks" toggle but defaults
 * OFF — we never issue a destructive QBO write (voided invoices are often kept as a
 * deliberate audit record; a deleted one is already gone).
 */
export async function breakQBInvoiceLink(
    paymentId: string,
    opts?: { deleteInQBO?: boolean },
): Promise<{ success: true; warning?: string } | { success: false; error: string }> {
    await assertInvoicePermission();

    const schedule = await prisma.paymentSchedule.findUnique({
        where: { id: paymentId },
        select: {
            id: true, status: true, qbInvoiceId: true, qbPaymentId: true,
            invoiceId: true, invoice: { select: { projectId: true } },
        },
    });
    if (!schedule) return { success: false, error: "Milestone not found" };
    if (schedule.status === "Paid") {
        return { success: false, error: "This milestone is already paid — unlinking is blocked. Use Undo first if you need to reverse it." };
    }
    if (schedule.qbPaymentId) {
        return { success: false, error: "A QuickBooks payment is recorded against this milestone. Refusing to unlink." };
    }
    if (!schedule.qbInvoiceId) {
        return { success: false, error: "This milestone has no QuickBooks link to break." };
    }

    // Claim the unlink atomically via the shared helper (also used by
    // updatePendingMilestoneAmountsCore) — see its doc comment for the race it closes.
    const { claimQBInvoiceUnlink } = await import("./quickbooks-payments");
    const cleared = await claimQBInvoiceUnlink(prisma, schedule.id, schedule.qbInvoiceId);
    if (!cleared) {
        return { success: false, error: "This milestone changed while unlinking (it may have just been paid or re-synced). Refresh and try again." };
    }

    // Only after we've claimed the local unlink do we (optionally) clean up QBO.
    // Default OFF — we never issue a destructive QBO write unless asked.
    let warning: string | undefined;
    if (opts?.deleteInQBO === true) {
        try {
            const { getFreshQBTokens } = await import("./quickbooks-payments");
            const { deleteQBInvoice } = await import("./quickbooks");
            const tokens = await getFreshQBTokens();
            const deleted = await deleteQBInvoice(tokens, schedule.qbInvoiceId);
            if (!deleted) warning = "Link cleared in ProBuild, but the QuickBooks invoice could not be deleted (it may already be gone, or has a linked payment — check QuickBooks).";
        } catch {
            warning = "Link cleared in ProBuild, but QuickBooks delete could not be attempted (QuickBooks unavailable).";
        }
    }

    revalidatePath(`/projects/${schedule.invoice.projectId}/invoices/${schedule.invoiceId}`);
    revalidatePath(`/invoices`);
    revalidatePath(`/portal`);
    return { success: true, warning };
}

export async function recordEstimatePayment(
    paymentId: string,
    estimateId: string,
    input: {
        paymentDate: number | string;
        method: string;
        referenceNumber?: string | null;
        notes?: string | null;
        amount?: number;
    },
) {
    // Two ids, and the milestone is the one that actually gets settled. Scope
    // the estimate, then resolve the milestone THROUGH it — pairing enforced by
    // the query rather than by a follow-up comparison, so there is no second
    // authorization to keep in sync and no way to settle another job's
    // milestone by pairing it with an estimateId this caller can reach.
    const { user } = await assertEstimateAccess(estimateId);
    await assertPaymentBelongsToEstimate(paymentId, estimateId);

    const VALID_METHODS = ["check", "cash", "zelle", "venmo", "credit_card", "ach", "wire", "quickbooks", "other"];
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

    const tx = await withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. Lock the estimate first,
        // then its (oldest) linked invoice if one exists, BEFORE any reads/writes below.
        // This flow mirrors onto the invoice copy, so it must take the invoice lock in the
        // same order recordPayment/the Stripe+QB settles do, or overlapping settles from both
        // sides would deadlock on every collision (retry recovers, but the lock order avoids it).
        await lockMoneyParents(t, { estimateId });
        const lockInv = await t.invoice.findFirst({
            where: { estimateId },
            // id tiebreaker so the lock target == the mutation target below even on a createdAt tie.
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true },
        });
        if (lockInv) await lockMoneyParents(t, { invoiceId: lockInv.id });

        // One settle instant for BOTH sides of the mirrored pair, taken AFTER the parent
        // locks so a contended settle records when it settled, not when it started
        // queueing — see the fuller note in payment-record-core.ts.
        const settledAt = new Date();

        const payment = await t.estimatePaymentSchedule.findUnique({ where: { id: paymentId } });
        if (!payment) return { success: false as const, error: "Milestone not found" as const };
        if (payment.status === "Paid") return { success: false as const, error: "Milestone already paid" as const };
        if (payment.estimateId !== estimateId) return { success: false as const, error: "Milestone/estimate mismatch" as const };

        // When a linked invoice exists, its milestone copy is the CANONICAL claim
        // target — claim it FIRST so a concurrent settle on the invoice/QBO side
        // can't race this one into double side effects. Oldest invoice wins when
        // several link back (manual re-invoicing); name+amount fallback only
        // fires when it matches exactly one candidate.
        let mirroredCopyId: string | null = null;
        // Fetch the SAME invoice we locked above by id — not a fresh findFirst — so the mirror
        // mutates exactly the locked row even if a concurrent insert/delete/re-timestamp shifts
        // which invoice is "oldest" between the two reads (READ COMMITTED).
        const linkedInvoice = lockInv
            ? await t.invoice.findUnique({ where: { id: lockInv.id }, include: { payments: true } })
            : null;
        if (linkedInvoice) {
            const linked = linkedInvoice.payments.find(p => p.sourceScheduleId === paymentId);
            const fallbackCandidates = linked ? [] : linkedInvoice.payments.filter(p =>
                !p.sourceScheduleId &&
                p.name === payment.name &&
                toNum(p.amount) === toNum(payment.amount)
            );
            const copy = linked ?? (fallbackCandidates.length === 1 ? fallbackCandidates[0] : null);
            if (copy) {
                // Already settled from the invoice/QBO side → this is a conflict,
                // not a fresh payment. Refuse rather than double-record.
                const mirrorClaim = await t.paymentSchedule.updateMany({
                    where: { id: copy.id, status: { not: "Paid" } },
                    data: {
                        status: "Paid", paymentDate, paidAt: settledAt, paymentMethod: method, referenceNumber, notes,
                        // Keep both sides agreeing on what was actually paid when the
                        // recorded amount overrides the milestone amount.
                        ...(input.amount != null && { amount: input.amount }),
                    },
                });
                if (mirrorClaim.count === 0) return { success: false as const, error: "Milestone already paid" as const };
                const allCopies = await t.paymentSchedule.findMany({ where: { invoiceId: linkedInvoice.id } });
                const invPaid = allCopies.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
                const invBalance = Math.max(0, toNum(linkedInvoice.totalAmount) - invPaid);
                await t.invoice.update({
                    where: { id: linkedInvoice.id },
                    data: {
                        balanceDue: invBalance,
                        status: invBalance <= 0 ? "Paid" : invPaid > 0 ? "Partially Paid" : linkedInvoice.status,
                    },
                });
                mirroredCopyId = copy.id;
            }
        }

        const claim = await t.estimatePaymentSchedule.updateMany({
            where: { id: paymentId, status: { not: "Paid" } },
            data: {
                status: "Paid",
                paymentDate,
                paidAt: settledAt,
                paymentMethod: method,
                referenceNumber,
                notes,
                ...(input.amount != null && { amount: input.amount }),
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
        const isFirstPayment = !["Paid", "Partially Paid"].includes(estimate.status);

        await t.estimate.update({
            where: { id: estimateId },
            data: {
                balanceDue: newBalance,
                status: newStatus,
                ...(isFirstPayment && { statusBeforePayment: estimate.status }),
            },
        });

        // Durable notification, enqueued in-tx. When the payment settled the mirrored INVOICE
        // copy, notify the invoice side (matches the pre-outbox behavior); otherwise it's a
        // pre-invoice estimate deposit, so notify the estimate side.
        const notifyScheduleId = mirroredCopyId ?? paymentId;
        await enqueueMilestonePaid(t, {
            scheduleId: notifyScheduleId,
            scheduleType: mirroredCopyId ? "invoice" : "estimate",
        });

        return {
            success: true as const, projectId: estimate.projectId, leadId: estimate.leadId,
            mirroredCopyId, notifyScheduleId, paymentName: payment.name, newBalance,
            paymentAmount: input.amount != null ? input.amount : toNum(payment.amount),
        };
    }));

    if (!tx.success) return tx;

    // Inline fast-path delivery via the outbox's single canonical writer (notifyMilestonePaid
    // for an invoice copy, notifyEstimateMilestonePaid for an estimate deposit — the latter
    // now writes the payment_received activity entry the inline path used to log here).
    await drainPaymentNotifications({ scheduleId: tx.notifyScheduleId }).catch(() => {});

    if (tx.projectId) {
        revalidatePath(`/projects/${tx.projectId}/estimates`);
        revalidatePath(`/projects/${tx.projectId}/estimates/${estimateId}`);
        revalidatePath(`/projects/${tx.projectId}/invoices`);
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
    // Emails a client, so scope has to be settled before the send, not after.
    await assertEstimatePaymentAccess(paymentScheduleId);

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
    // Same two-id pairing as recordEstimatePayment — see the note there.
    const { user } = await assertEstimateAccess(estimateId);
    await assertPaymentBelongsToEstimate(paymentId, estimateId);

    const result = await withTxRetry(() => prisma.$transaction(async (tx) => {
        // Canonical lock order: Estimate → Invoice → schedules. This flow releases both the
        // estimate milestone and its mirrored invoice copy, so lock the estimate first, then its
        // (oldest) linked invoice, before recomputing either balance.
        await lockMoneyParents(tx, { estimateId });
        const lockInv = await tx.invoice.findFirst({
            where: { estimateId },
            // id tiebreaker so the lock target == the mutation target below even on a createdAt tie.
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true },
        });
        if (lockInv) await lockMoneyParents(tx, { invoiceId: lockInv.id });

        const payment = await tx.estimatePaymentSchedule.findUnique({ where: { id: paymentId } });
        if (!payment) throw new Error("Payment not found");
        if (payment.status !== "Paid") return null;

        const estimate = await tx.estimate.findUnique({ where: { id: estimateId } });
        if (!estimate) throw new Error("Estimate not found");
        if (payment.estimateId !== estimateId) throw new Error("Payment/estimate mismatch");

        await tx.estimatePaymentSchedule.update({
            where: { id: paymentId },
            data: {
                status: "Pending",
                paymentDate: null,
                paidAt: null,
                paymentMethod: null,
                referenceNumber: null,
                notes: null,
            },
        });

        const allSchedules = await tx.estimatePaymentSchedule.findMany({ where: { estimateId } });
        const totalPaid = allSchedules
            .filter((s) => s.status === "Paid")
            .reduce((sum, s) => sum + toNum(s.amount), 0);
        const newBalance = Math.max(0, toNum(estimate.totalAmount) - totalPaid);
        const newStatus =
            totalPaid === 0 ? estimate.statusBeforePayment ?? "Approved"
            : newBalance <= 0 ? "Paid"
            : "Partially Paid";

        await tx.estimate.update({
            where: { id: estimateId },
            data: {
                balanceDue: newBalance,
                status: newStatus,
                ...(totalPaid === 0 && { statusBeforePayment: null }),
            },
        });

        // Unwind the mirrored invoice copy too — a payment recorded on either
        // side settles both, so unrecording must release both. Oldest linked
        // invoice; name+amount fallback only when it matches exactly one row.
        // Fetch the SAME invoice we locked above by id (see recordEstimatePayment for rationale).
        const linkedInvoice = lockInv
            ? await tx.invoice.findUnique({ where: { id: lockInv.id }, include: { payments: true } })
            : null;
        if (linkedInvoice) {
            const linked = linkedInvoice.payments.find(p => p.sourceScheduleId === paymentId && p.status === "Paid");
            const fallbackCandidates = linked ? [] : linkedInvoice.payments.filter(p =>
                !p.sourceScheduleId &&
                p.status === "Paid" &&
                p.name === payment.name &&
                toNum(p.amount) === toNum(payment.amount)
            );
            const copy = linked ?? (fallbackCandidates.length === 1 ? fallbackCandidates[0] : null);
            if (copy) {
                await tx.paymentSchedule.update({
                    where: { id: copy.id },
                    data: { status: "Pending", paymentDate: null, paidAt: null, paymentMethod: null, referenceNumber: null, notes: null },
                });
                const allCopies = await tx.paymentSchedule.findMany({ where: { invoiceId: linkedInvoice.id } });
                const invPaid = allCopies.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
                const invBalance = Math.max(0, toNum(linkedInvoice.totalAmount) - invPaid);
                await tx.invoice.update({
                    where: { id: linkedInvoice.id },
                    data: {
                        balanceDue: invBalance,
                        status: invBalance <= 0 ? "Paid" : invPaid > 0 ? "Partially Paid" : "Issued",
                    },
                });
            }
        }

        return { projectId: estimate.projectId, leadId: estimate.leadId };
    }));

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

/**
 * Resolve the acting staff user, or null if there genuinely isn't one.
 *
 * Deliberately has NO try/catch: a Prisma or session failure must propagate.
 * Swallowing it would turn an outage into "no user", which the estimate scope
 * filter reads as "show no estimates" — a page of zeroes that looks like real
 * data. Only a real absence of a signed-in staff user returns null.
 */
async function currentStaffUserOrNull(): Promise<any | null> {
    // Body moved to permissions.ts so server components that scope a query
    // themselves can share it without actions.ts publishing another endpoint.
    return currentStaffViewerOrNull();
}

async function assertActiveStaff(): Promise<any> {
    const user = await currentStaffUserOrNull();
    if (!user) throw new Error("Unauthorized");
    return user;
}

async function assertStaffPermission(permission: "estimates" | "invoices" | "changeOrders" | "financialReports" | "companySettings" | "contracts" | "manageVendors") {
    const user = await assertActiveStaff();
    if (!hasPermission(user, permission)) throw new Error("Forbidden");
    return user;
}

async function assertEstimatePermission() {
    return assertStaffPermission("estimates");
}

async function assertInvoicePermission() {
    return assertStaffPermission("invoices");
}

async function assertChangeOrderPermission() {
    return assertStaffPermission("changeOrders");
}

/**
 * Horizontal-access check for an estimate that has already been resolved to its
 * owner. `assertEstimatePermission()` answers "may this user touch estimates at
 * all", NOT "may this user touch THIS estimate" — and every action in this file
 * is a remotely invokable Server Action, so without this any staff member
 * holding `estimates` could read or rewrite another job's numbers by id alone.
 *
 * Same shape as assertSendScope: project-owned estimates go through
 * canAccessProject (ADMIN/MANAGER pass unconditionally inside it); lead-owned
 * ones fall back to `leadAccess`, the gate the /leads/[id] layout applies.
 * FINANCE is deliberately NOT exempt the way assertFinancialProjectScope exempts
 * it for reports — an estimate is a per-job document, not a company roll-up.
 */
function assertEstimateScope(user: any, scope: { projectId?: string | null; leadId?: string | null }) {
    // Fail CLOSED on an ownerless estimate. Both ownership columns are optional
    // in the schema, so "no project and no lead" would otherwise fall straight
    // through this function and be authorized by default. Reported distinctly
    // from "Forbidden" because it is a data problem, not a permissions one.
    if (!scope.projectId && !scope.leadId) {
        throw new Error("This estimate is not attached to a project or lead, so access cannot be checked");
    }
    // The decision itself lives in access-rules.ts, shared verbatim with the
    // list filter (estimateScopeWhere) so the two can never disagree.
    if (!canAccessEstimate(user, scope)) throw new Error("Forbidden");
}

/**
 * The nested-relation form of estimateScopeWhere. Prisma relation filters take
 * the same where shape, so a lead/project getter that embeds estimates can
 * reuse the predicate rather than growing its own copy of the rules.
 */
function scopedEstimateRelation<T extends object>(relation: T, user: any | null | undefined): T & { where: any } {
    return { ...relation, where: estimateScopeWhere(user) };
}

/**
 * Session-bound form of estimateTotalsAreComplete, for pages that sum estimates
 * embedded in an UNSCOPED parent list (the project list is company-wide, so its
 * revenue card would otherwise label a scoped sum as company-wide truth).
 *
 * Pass the OWNERS the aggregate could have drawn from — `{ projectId }` for a
 * project's estimates, `{ leadId }` for a lead's. Not a bare id list: null in
 * one cannot distinguish lead-owned from attached-to-nothing, and those two
 * answer differently.
 */
export async function estimateTotalsComplete(owners: { projectId?: string | null; leadId?: string | null }[]): Promise<boolean> {
    const user = await assertActiveStaff();
    return estimateTotalsAreComplete(user, owners);
}

/** Permission + scope for actions that reach estimates through a project id. */
async function assertEstimateProjectAccess(projectId: string) {
    const user = await assertEstimatePermission();
    assertEstimateScope(user, { projectId });
    return user;
}

/** Permission + scope for actions that reach estimates through a lead id. */
async function assertEstimateLeadAccess(leadId: string) {
    const user = await assertEstimatePermission();
    assertEstimateScope(user, { leadId });
    return user;
}

/**
 * Permission + scope for actions that create a contract on a project or lead.
 * `createContractFromTemplate` / `createContractBlank` are exported Server
 * Actions with no other caller-supplied proof of identity, so without this
 * gate any anonymous caller could generate a contract — with merged client
 * and financial data — on any job by id alone.
 */
async function assertContractContextAccess(context: { type: "project" | "lead"; id: string }) {
    const user = await assertActiveStaff();
    const scope = context.type === "project" ? { projectId: context.id } : { leadId: context.id };
    if (!canCreateContractFor(user, scope)) throw new Error("Forbidden");
    return user;
}

/**
 * Resolve a contract's owning project/lead. Deliberately reads the owner from
 * the DATABASE by id: every contract action is addressed by contract id, and
 * the descriptor a caller hands us is exactly the thing an attacker controls.
 */
async function contractOwnerOrThrow(contractId: string) {
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        select: { projectId: true, leadId: true, title: true },
    });
    if (!contract) throw new Error("Contract not found");
    return contract;
}

/**
 * Horizontal-access check for a contract already resolved to its owner.
 * Same shape as assertEstimateScope, and fails CLOSED on an ownerless contract
 * for the same reason: both ownership columns are optional in the schema, so
 * "no project and no lead" would otherwise be authorized by default.
 */
function assertContractScope(user: any, scope: { projectId?: string | null; leadId?: string | null }) {
    if (!scope.projectId && !scope.leadId) {
        throw new Error("This contract is not attached to a project or lead, so access cannot be checked");
    }
    if (!canAccessContract(user, scope)) throw new Error("Forbidden");
}

/**
 * Permission + scope for a single EXISTING contract, addressed by contract id.
 *
 * The contract-family actions in this file are exported Server Actions, i.e.
 * individually invokable POST endpoints — "only imported by a staff page" is
 * not an enforced boundary. Reading a contract exposes its legal body, the
 * approval IP/user-agent trail, the signature storage paths and the portal
 * `accessToken`, which by itself authorizes a client to view AND SIGN; writing
 * one can clear a contractor signature. Both therefore need the same gate.
 *
 * Permission is asserted BEFORE the lookup so the "Contract not found" vs
 * "Forbidden" difference cannot be used as an existence oracle by a caller who
 * holds no contract permission at all.
 */
async function assertContractAccess(contractId: string) {
    const user = await assertStaffPermission("contracts");
    const contract = await contractOwnerOrThrow(contractId);
    assertContractScope(user, contract);
    return { user, projectId: contract.projectId, leadId: contract.leadId, title: contract.title };
}

/** Resolve an estimate's owning project/lead, for callers that hold a user already. */
async function estimateOwnerOrThrow(estimateId: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { projectId: true, leadId: true },
    });
    if (!estimate) throw new Error("Estimate not found");
    return estimate;
}

/**
 * Permission + scope for a single estimate. Mirrors assertScheduleTaskAccess:
 * resolve the row's owning project/lead, then apply the horizontal check.
 * Permission is asserted BEFORE the lookup so the "Estimate not found" vs
 * "Forbidden" difference cannot be used as an existence oracle by a caller who
 * holds no estimate permission at all.
 */
async function assertEstimateAccess(estimateId: string) {
    const user = await assertEstimatePermission();
    const estimate = await estimateOwnerOrThrow(estimateId);
    assertEstimateScope(user, estimate);
    return { user, projectId: estimate.projectId, leadId: estimate.leadId };
}

/**
 * Pairing check for the two-id payment actions. The caller has already been
 * scoped against `estimateId`; this proves the milestone it is about to settle
 * or release actually hangs off that estimate. Enforced by the WHERE clause, so
 * there is no second authorization decision that can drift out of sync.
 */
async function assertPaymentBelongsToEstimate(paymentId: string, estimateId: string) {
    const payment = await prisma.estimatePaymentSchedule.findFirst({
        where: { id: paymentId, estimateId },
        select: { id: true },
    });
    if (!payment) throw new Error("Payment not found");
}

/**
 * Permission + scope for actions addressed by EstimatePaymentSchedule id alone.
 * The milestone carries no ownership of its own, so it has to be walked back to
 * its estimate before any side effect (a receipt email) happens.
 */
async function assertEstimatePaymentAccess(paymentScheduleId: string) {
    const user = await assertEstimatePermission();
    const schedule = await prisma.estimatePaymentSchedule.findUnique({
        where: { id: paymentScheduleId },
        select: { estimateId: true, estimate: { select: { projectId: true, leadId: true } } },
    });
    if (!schedule?.estimate) throw new Error("Payment not found");
    assertEstimateScope(user, schedule.estimate);
    return { user, estimateId: schedule.estimateId };
}

/**
 * Permission + scope for actions addressed by EstimateItem id rather than by
 * estimate id. Every id must resolve: a missing row is something the caller
 * cannot be scoped against, so it is rejected rather than silently skipped.
 */
async function assertEstimateItemAccess(itemIds: string[]) {
    const user = await assertEstimatePermission();
    const unique = Array.from(new Set(itemIds));
    if (unique.length === 0) return user;
    const items = await prisma.estimateItem.findMany({
        where: { id: { in: unique } },
        select: { estimate: { select: { projectId: true, leadId: true } } },
    });
    if (items.length !== unique.length) throw new Error("Estimate item not found");
    for (const item of items) assertEstimateScope(user, item.estimate);
    return user;
}

async function assertScheduleProjectAccess(projectId: string) {
    const user = await assertActiveStaff();
    if (!hasPermission(user, "schedules") || !canAccessProject(user, projectId)) throw new Error("Forbidden");
    return user;
}

async function assertScheduleTaskAccess(taskId: string) {
    const task = await prisma.scheduleTask.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!task?.projectId) throw new Error("Task not found");
    const user = await assertScheduleProjectAccess(task.projectId);
    return { user, projectId: task.projectId };
}

// Mirrors the /leads/[id] layout gate: a remotely invoked Server Action cannot
// lean on the page layout that normally checks `leadAccess`.
async function assertLeadScheduleAccess(leadId: string) {
    const user = await assertActiveStaff();
    if (!hasPermission(user, "leadAccess")) throw new Error("Forbidden");
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } });
    if (!lead) throw new Error("Lead not found");
    return user;
}

async function assertStagingQueueAccess() {
    const user = await assertActiveStaff();
    if (!["ADMIN", "MANAGER", "FIELD_CREW"].includes(user.role) || !hasPermission(user, "schedules")) {
        throw new Error("Forbidden");
    }
    return user;
}

function taskMaterialActor(user: any): TaskMaterialActor {
    if (!user?.id) throw new Error("Authenticated staff user is required");
    return {
        userId: user.id,
        role: user.role,
        name: user.name || user.email,
    };
}

function revalidateTaskMaterialPaths(projectId: string) {
    revalidatePath(`/projects/${projectId}/schedule`);
    revalidatePath("/company-dashboard");
    revalidatePath("/company-dashboard/staging");
}

async function assertFinancialPermission() {
    return assertStaffPermission("financialReports");
}

function assertFinancialProjectScope(user: any, projectId: string) {
    if (["ADMIN", "MANAGER", "FINANCE"].includes(user.role)) return;
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
}

async function assertFinancialProjectAccess(projectId: string) {
    const user = await assertFinancialPermission();
    assertFinancialProjectScope(user, projectId);
    return user;
}

async function assertCompanySettingsPermission() {
    return assertStaffPermission("companySettings");
}

async function assertVendorPermission() {
    return assertStaffPermission("manageVendors");
}

// Document templates hold the terms & conditions, contract language and
// disclaimers that get SNAPSHOTTED onto estimates and contracts when they are
// sent — an unauthenticated write changes the legal text on future
// client-facing documents. Company-wide, so there is no per-project scope to
// apply; the split below follows the screens that actually use them.
//
// Reads: every consumer is an estimates or contracts surface (the estimate
// editor's T&C picker, SendEstimateModal, the lead/project contracts tabs) plus
// the company settings library itself.
async function assertDocumentTemplateReadAccess() {
    const user = await assertActiveStaff();
    if (!hasPermission(user, "estimates") && !hasPermission(user, "contracts") && !hasPermission(user, "companySettings")) {
        throw new Error("Forbidden");
    }
    return user;
}

// Writes: `companySettings` is the permission that owns the library at
// /company/templates, and it alone may touch EVERY type. `estimates` is
// accepted too, but only for the types an estimator actually authors — the
// estimate editor's "save as template" and the /estimates Terms & Conditions
// tab. Without the type scope below, an estimates-only user (which is the
// FINANCE default) could rewrite contract, lien-release, warranty, addendum and
// disclaimer language through /company/templates' full type selector, which is
// a far bigger grant than the estimator surfaces justify.
async function assertDocumentTemplateWritePermission() {
    const user = await assertActiveStaff();
    if (!hasPermission(user, "companySettings") && !hasPermission(user, "estimates")) {
        throw new Error("Forbidden");
    }
    return user;
}

// Second half of the write gate: which TYPE this caller may write. Split from
// the permission check so the permission still runs before any database access
// — update/delete have to load the row to learn its type, and an edit that
// changes `type` must clear the scope on BOTH the old and the new value or a
// caller could launder a contract template out of its protected type.
function assertDocumentTemplateTypeScope(user: any, type: string | null | undefined) {
    if (!canWriteDocumentTemplateType(user, type)) throw new Error("Forbidden");
}

// Creating a vendor is also part of the PO flow — SelectVendorModal and
// POQuickCreateModal let an estimator add one inline, and those screens gate on
// financialReports (see quickCreatePOAndLink). So either permission is enough to
// create; editing and deleting still require manageVendors.
async function assertVendorCreatePermission() {
    const user = await assertActiveStaff();
    if (!hasPermission(user, "manageVendors") && !hasPermission(user, "financialReports")) {
        throw new Error("Forbidden");
    }
    return user;
}

async function assertEstimateStaffOrPortalAccess(estimateId: string) {
    const user = await getCurrentUserWithPermissions();
    if (user) {
        if (!hasPermission(user, "estimates") && !hasPermission(user, "invoices")) {
            throw new Error("Forbidden");
        }
        // The portal branch below is already ownership-scoped; the staff branch
        // was not. Same horizontal check as assertEstimateAccess so a staff
        // caller cannot mint a PDF upload token (or a pay-in-full schedule) for
        // a job they have no access to.
        const estimate = await prisma.estimate.findUnique({
            where: { id: estimateId },
            select: { projectId: true, leadId: true },
        });
        if (!estimate) throw new Error("Estimate not found");
        assertEstimateScope(user, estimate);
        return;
    }
    if (await canUseDevAuthFallback()) {
        await assertActiveStaff();
        return;
    }

    const clientId = await resolveSessionClientId();
    if (!clientId) throw new Error("Unauthorized");
    const owned = await prisma.estimate.findFirst({
        where: {
            id: estimateId,
            OR: [
                { project: { is: { clientId } } },
                { lead: { is: { clientId } } },
            ],
        },
        select: { id: true },
    });
    if (!owned) throw new Error("Unauthorized");
}

async function assertInvoicePortalAccess(): Promise<string | null> {
    // Staff previews must never register as client views.
    if (await getCurrentUserWithPermissions()) return null;
    if (await canUseDevAuthFallback()) {
        await assertActiveStaff();
        return null;
    }
    return resolveSessionClientId();
}

export type SendActor = { type: "SYSTEM" | "TEAM"; name: string };

/**
 * Actor plus the staff identity behind it. `user` is null for machine callers,
 * which are company-wide by design; for humans it carries projectAccess so the
 * caller can be scoped to the specific document AFTER it is loaded. Permission
 * alone is not authorization: `contracts`/`estimates` says WHAT you may do, not
 * WHICH job you may do it to.
 */
type SendPrincipal = SendActor & { user: any | null };

/**
 * Authorize a customer-facing document send, and return the actor PROVEN by
 * whatever authenticated the call.
 *
 * The actor must never be its own argument. This module is "use server", so
 * every parameter is attacker-controlled: a caller could authenticate as itself
 * and then label the audit trail as somebody else. Deriving the label from the
 * secret that actually matched makes that impossible.
 */
async function assertDocumentSendPermission(
    mcpSecret: string | undefined,
    permission: "estimates" | "contracts",
): Promise<SendPrincipal> {
    // Strict presence check, not truthiness. An empty string — or an
    // attacker-supplied null/false/0 at runtime — must NOT be treated as
    // "omitted", or a bad machine token silently falls through to the session
    // path and rides in on whatever staff cookie happens to be attached.
    // ONLY undefined counts as omitted. Excluding null here as well was the bug:
    // it let an explicitly-supplied null skip validation and reach the staff-session
    // path — precisely the fallback this check exists to prevent.
    if (mcpSecret !== undefined) {
        if (typeof mcpSecret !== "string" || mcpSecret.length === 0) {
            throw new Error("Unauthorized");
        }
        const supplied = createHash("sha256").update(mcpSecret).digest();
        const candidates: Array<[string, string | undefined]> = [
            ["justin-ai", process.env.MCP_SECRET],
            ["richard-ai", process.env.MCP_SECRET_RICHARD],
        ];
        for (const [label, configuredSecret] of candidates) {
            const configured = createHash("sha256").update(configuredSecret ?? "").digest();
            if (configuredSecret && timingSafeEqual(supplied, configured)) {
                return { type: "SYSTEM", name: "SYSTEM:" + label, user: null };
            }
        }
        // A supplied-but-wrong secret must NOT fall through to the session path:
        // that would let a bad machine token ride in on a stray staff cookie.
        throw new Error("Unauthorized");
    }
    const user = await assertStaffPermission(permission);
    return { type: "TEAM", name: user?.name || user?.email || "Team", user };
}

/**
 * Horizontal-access check for a loaded document. A remotely invoked Server Action
 * cannot lean on the page layout that normally gates project access, so without
 * this a non-admin holding `contracts` (or FINANCE holding `estimates`) could send
 * a document belonging to a job they have no access to, just by knowing its id.
 */
function assertSendScope(
    principal: SendPrincipal,
    scope: { projectId?: string | null; leadId?: string | null },
) {
    // Fail CLOSED on an ownerless document, before the machine exemption. Both
    // ownership columns are optional in the schema, and an ownerless estimate can
    // still be emailed via overrideEmail — so "no project and no lead" previously
    // fell straight through this function and was authorized by default.
    if (!scope.projectId && !scope.leadId) {
        throw new Error("This document is not attached to a project or lead, so access cannot be checked");
    }
    if (!principal.user) return; // machine callers are company-wide by design
    if (scope.projectId) {
        if (!canAccessProject(principal.user, scope.projectId)) throw new Error("Forbidden");
        return;
    }
    if (!hasPermission(principal.user, "leadAccess")) throw new Error("Forbidden");
}

async function assertEstimateSendPermission(mcpSecret?: string): Promise<SendPrincipal> {
    return assertDocumentSendPermission(mcpSecret, "estimates");
}

/**
 * Contract sends had NO authorization at all: the Server Action went straight to
 * reading and mutating the contract, and Server Actions are remotely invokable.
 * Mirrors the estimate path so both are gated the same way.
 */
async function assertContractSendPermission(mcpSecret?: string): Promise<SendPrincipal> {
    return assertDocumentSendPermission(mcpSecret, "contracts");
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

    // Guard failures return { error } instead of throwing: production masks
    // thrown server-action messages, so the client would never see the reason.
    let projectId: string;
    try {
        const { splitInvoiceMilestonesCore } = await import("./billing-core");
        projectId = await splitInvoiceMilestonesCore(invoiceId, milestones);
    } catch (e: any) {
        return { success: false as const, error: e?.message || "Failed to update payment schedule" };
    }

    revalidatePath(`/projects/${projectId}/invoices`);
    revalidatePath(`/projects/${projectId}/invoices/${invoiceId}`);
    revalidatePath(`/invoices`);

    return { success: true as const };
}

/**
 * Re-price the Pending milestones on an invoice without changing the invoice
 * total ("Edit amounts"). See `updatePendingMilestoneAmountsCore` for the
 * validation, mirror-sync, and QuickBooks re-stage details.
 */
export async function updatePendingMilestoneAmounts(
    invoiceId: string,
    rows: { scheduleId: string; name: string; amount: number; dueDate?: string | null }[],
) {
    await assertInvoicePermission();

    const { updatePendingMilestoneAmountsCore } = await import("./billing-core");
    const result = await updatePendingMilestoneAmountsCore(invoiceId, rows);

    // Same paths splitInvoiceMilestones revalidates.
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { projectId: true } });
    if (invoice) {
        revalidatePath(`/projects/${invoice.projectId}/invoices`);
        revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    }
    revalidatePath(`/invoices`);

    return result;
}

/**
 * Delete a Pending, non-mirrored, non-QB-linked "extra charge" milestone —
 * the inverse of `addInvoiceMilestone`. QB-linked rows must be unlinked via
 * Break QB Link first; this action is DB-only.
 */
export async function deleteInvoiceMilestone(scheduleId: string) {
    await assertInvoicePermission();

    const { deleteInvoiceMilestoneCore } = await import("./billing-core");
    const result = await deleteInvoiceMilestoneCore(scheduleId);

    revalidatePath(`/projects/${result.projectId}/invoices`);
    revalidatePath(`/projects/${result.projectId}/invoices/${result.invoiceId}`);
    revalidatePath(`/invoices`);
    revalidatePath(`/portal`);
    revalidatePath(`/reports/open-invoices`);

    return { success: true };
}

export async function unrecordPayment(paymentId: string, invoiceId: string) {
    await assertInvoicePermission();

    const projectId = await withTxRetry(() => prisma.$transaction(async (tx) => {
        // Canonical lock order: Estimate → Invoice → schedules. This flow releases the invoice
        // milestone and its mirrored estimate copy, so read the estimate link (non-locking), then
        // lock Estimate before Invoice, before recomputing either balance.
        const invLink = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
        await lockMoneyParents(tx, { estimateId: invLink?.estimateId, invoiceId });

        const payment = await tx.paymentSchedule.findUnique({ where: { id: paymentId } });
        if (!payment) throw new Error("Payment not found");
        // Guard BEFORE mutating: a mismatched invoiceId would leave the payment's real
        // parent stale and recompute the wrong (locked) invoice. Mirrors recordPayment.
        if (payment.invoiceId !== invoiceId) throw new Error("Payment/invoice mismatch");
        if (payment.status !== "Paid") return null;

        await tx.paymentSchedule.update({
            where: { id: paymentId },
            data: {
                status: "Pending",
                paymentDate: null,
                paidAt: null,
                paymentMethod: null,
                referenceNumber: null,
                notes: null,
            },
        });

        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
        if (!invoice) throw new Error("Invoice not found");

        const allSchedules = await tx.paymentSchedule.findMany({ where: { invoiceId } });
        const totalPaid = allSchedules
            .filter((s) => s.status === "Paid")
            .reduce((sum, s) => sum + toNum(s.amount), 0);
        const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalPaid);
        
        let newStatus = invoice.status;
        if (newBalance <= 0) {
            newStatus = "Paid";
        } else if (totalPaid > 0) {
            newStatus = "Partially Paid";
        } else if (invoice.status === "Overdue") {
            newStatus = "Overdue";
        } else {
            newStatus = "Issued"; // default state for issued invoices with no payments
        }

        await tx.invoice.update({
            where: { id: invoiceId },
            data: { balanceDue: newBalance, status: newStatus },
        });

        // Unwind the mirrored estimate-side copy too (link-first, fallback by
        // name+amount) so the estimate doesn't keep claiming money the invoice
        // no longer shows as received.
        if (invoice.estimateId) {
            let estCopy: { id: string; amount: unknown } | null = null;
            if (payment.sourceScheduleId) {
                estCopy = await tx.estimatePaymentSchedule.findFirst({
                    where: { id: payment.sourceScheduleId, estimateId: invoice.estimateId, status: "Paid" },
                });
            } else {
                const candidates = await tx.estimatePaymentSchedule.findMany({
                    where: { estimateId: invoice.estimateId, status: "Paid", name: payment.name },
                    take: 2,
                });
                const matching = candidates.filter(c => toNum(c.amount) === toNum(payment.amount));
                estCopy = matching.length === 1 ? matching[0] : null;
            }
            if (estCopy) {
                await tx.estimatePaymentSchedule.update({
                    where: { id: estCopy.id },
                    data: { status: "Pending", paymentDate: null, paidAt: null, paymentMethod: null, referenceNumber: null, notes: null },
                });
                const estimate = await tx.estimate.findUnique({ where: { id: invoice.estimateId } });
                if (estimate) {
                    const estSiblings = await tx.estimatePaymentSchedule.findMany({ where: { estimateId: invoice.estimateId } });
                    const estPaid = estSiblings.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
                    const estBalance = Math.max(0, toNum(estimate.totalAmount) - estPaid);
                    await tx.estimate.update({
                        where: { id: invoice.estimateId },
                        data: {
                            balanceDue: estBalance,
                            status: estPaid === 0 ? estimate.statusBeforePayment ?? "Invoiced"
                                : estBalance <= 0 ? "Paid"
                                : "Partially Paid",
                            ...(estPaid === 0 && { statusBeforePayment: null }),
                        },
                    });
                }
            }
        }

        return invoice.projectId;
    }));

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
    await assertInvoicePermission();
    return await prisma.invoice.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        include: { client: true },
    });
}

export async function getAllInvoices() {
    await assertInvoicePermission();
    return await prisma.invoice.findMany({
        orderBy: { createdAt: "desc" },
        include: {
            project: { select: { id: true, name: true } },
            client: { select: { id: true, name: true } },
        },
    });
}

export async function issueInvoice(invoiceId: string) {
    await assertInvoicePermission();
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


const staffCompanySettingsSelect = {
    id: true,
    companyName: true,
    address: true,
    phone: true,
    email: true,
    website: true,
    logoUrl: true,
    licenseNumber: true,
    notificationEmail: true,
    googleDriveEmail: true,
    projectStatuses: true,
    subcontractorTrades: true,
    stripeEnabled: true,
    enableCard: true,
    enableBankTransfer: true,
    enableAffirm: true,
    enableKlarna: true,
    passProcessingFee: true,
    cardProcessingRate: true,
    cardProcessingFlat: true,
    monthlyOverhead: true,
    workDays: true,
    workdayStart: true,
    workdayEnd: true,
    salesTaxes: true,
    letterheadMode: true,
    letterheadImageUrl: true,
    letterheadLogoPosition: true,
    letterheadFields: true,
    letterheadAccentColor: true,
    letterheadDivider: true,
    notificationToggles: true,
    requireContractCountersign: true,
    updatedAt: true,
} as const;

const publicCompanySettingsSelect = {
    id: true,
    companyName: true,
    address: true,
    phone: true,
    email: true,
    website: true,
    logoUrl: true,
    licenseNumber: true,
    stripeEnabled: true,
    enableCard: true,
    enableBankTransfer: true,
    enableAffirm: true,
    enableKlarna: true,
    passProcessingFee: true,
    cardProcessingRate: true,
    cardProcessingFlat: true,
    salesTaxes: true,
    letterheadMode: true,
    letterheadImageUrl: true,
    letterheadLogoPosition: true,
    letterheadFields: true,
    letterheadAccentColor: true,
    letterheadDivider: true,
    requireContractCountersign: true,
    updatedAt: true,
} as const;

const getCachedCompanySettings = unstable_cache(
    async () => {
        let settings = await prisma.companySettings.findUnique({
            where: { id: "singleton" },
            select: staffCompanySettingsSelect,
        });

        if (!settings) {
            settings = await prisma.companySettings.create({
                data: {
                    id: "singleton",
                    companyName: "My Construction Co.",
                },
                select: staffCompanySettingsSelect,
            });
        }

        return JSON.parse(JSON.stringify(settings));
    },
    ["company-settings"],
    { revalidate: 300, tags: ["company-settings"] }
);

const getCachedPublicCompanySettings = unstable_cache(
    async () => {
        const settings = await prisma.companySettings.findUnique({
            where: { id: "singleton" },
            select: publicCompanySettingsSelect,
        });
        return settings ? JSON.parse(JSON.stringify(settings)) : null;
    },
    ["public-company-settings"],
    { revalidate: 300, tags: ["company-settings"] },
);

export async function getCompanySettings() {
    await assertActiveStaff();
    return getCachedCompanySettings();
}

export async function getPublicCompanySettings() {
    return getCachedPublicCompanySettings();
}

export async function saveCompanySettings(data: any) {
    await assertCompanySettingsPermission();
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
                ? data.licenseNumber.replace(/[\n\t]/g, "").trim().slice(0, 50)
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
            ...(data.letterheadMode !== undefined ? { letterheadMode: data.letterheadMode } : {}),
            ...(data.letterheadImageUrl !== undefined ? { letterheadImageUrl: data.letterheadImageUrl } : {}),
            ...(data.letterheadLogoPosition !== undefined ? { letterheadLogoPosition: data.letterheadLogoPosition } : {}),
            ...(data.letterheadFields !== undefined ? { letterheadFields: data.letterheadFields } : {}),
            ...(data.letterheadAccentColor !== undefined ? { letterheadAccentColor: data.letterheadAccentColor } : {}),
            ...(data.letterheadDivider !== undefined ? { letterheadDivider: data.letterheadDivider } : {}),
        },
    });

    revalidateTag("company-settings", "max");
    revalidatePath("/settings/notifications");
    revalidatePath("/settings/company");
    revalidatePath("/settings/letterhead");
    revalidatePath("/portal");
    return { success: true };
}

export async function deleteEstimate(estimateId: string): Promise<{ success: boolean; error?: string }> {
    await assertEstimateAccess(estimateId);
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { projectId: true, leadId: true, status: true },
    });
    if (!estimate) return { success: false, error: "Estimate not found" };
    const PROTECTED_STATUSES = new Set(["Approved", "Invoiced", "Partially Paid", "Paid"]);
    if (PROTECTED_STATUSES.has(estimate.status)) return { success: false, error: `${estimate.status} estimates cannot be deleted` };

    // Check if there are any linked Expenses or TimeEntries
    const expenseCount = await prisma.expense.count({
        where: { estimateId }
    });
    const timeEntryCount = await prisma.timeEntry.count({
        where: {
            estimateItem: {
                estimateId
            }
        }
    });

    if (expenseCount > 0 || timeEntryCount > 0) {
        const parts = [];
        if (expenseCount > 0) parts.push(`${expenseCount} expense(s)`);
        if (timeEntryCount > 0) parts.push(`${timeEntryCount} time entry/entries`);
        return {
            success: false,
            error: `Cannot delete estimate because it has linked ${parts.join(" and ")}. Please delete these entries first.`
        };
    }

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
    // Both ends are scoped: you must be able to read the source estimate AND to
    // write into the destination job, or a duplicate becomes a copy-out channel.
    await assertEstimateAccess(estimateId);
    if (targetProjectId) await assertEstimateProjectAccess(targetProjectId);
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
            taxExempt: original.taxExempt,
            taxRateName: original.taxRateName,
            taxRatePercent: original.taxRatePercent,
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
    // The template is company-wide, but it is BUILT from this estimate's line
    // items — so reading the source still needs the source's scope.
    await assertEstimateAccess(estimateId);
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: { items: { orderBy: { order: "asc" } } },
    });
    if (!estimate) throw new Error("Estimate not found");

    const itemRows = estimate.items.map((item) => ({
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
    }));

    // Saving under an existing name replaces that template's contents (keeping its
    // id/source and bumping updatedAt) instead of piling up same-name duplicates.
    const existing = await prisma.estimateTemplate.findFirst({
        where: { name: { equals: templateName, mode: "insensitive" } },
        select: { id: true },
    });
    if (existing) {
        const template = await prisma.$transaction(async tx => {
            await tx.estimateTemplateItem.deleteMany({ where: { templateId: existing.id } });
            return tx.estimateTemplate.update({
                where: { id: existing.id },
                data: { name: templateName, items: { create: itemRows } },
            });
        });
        return { id: template.id, name: template.name, updated: true };
    }

    const template = await prisma.estimateTemplate.create({
        data: { name: templateName, items: { create: itemRows } },
    });

    return { id: template.id, name: template.name, updated: false };
}

export async function getEstimateTemplates() {
    await assertEstimatePermission();
    const templates = await prisma.estimateTemplate.findMany({
        orderBy: { createdAt: "desc" },
        include: { items: { orderBy: [{ order: "asc" }, { id: "asc" }] } },
    });
    // Item baseCost/unitCost are Prisma Decimals, which can't cross the server->client
    // boundary; consumers already coerce with Number(...).
    return JSON.parse(JSON.stringify(templates));
}

export async function createEstimateFromTemplate(projectId: string, templateId: string) {
    await assertEstimateProjectAccess(projectId);
    const template = await prisma.estimateTemplate.findUnique({
        where: { id: templateId },
        include: { items: { orderBy: [{ order: "asc" }, { id: "asc" }] } },
    });
    if (!template) throw new Error("Template not found");

    const taxDefault = await defaultTaxForNewEstimate({ projectId });
    const estimate = await prisma.estimate.create({
        data: {
            title: template.name,
            projectId,
            code: "EST-TEMP",
            status: "Draft",
            totalAmount: 0,
            balanceDue: 0,
            privacy: "Shared",
            ...(taxDefault ?? {}),
        },
    });

    const templateCode = `EST-${String(estimate.number).padStart(5, "0")}`;
    await prisma.estimate.update({ where: { id: estimate.id }, data: { code: templateCode } });

    // Rebuild grouping by walking items in order: a Section row starts a group and
    // the child rows after it belong to that group. Stored template parentId VALUES
    // can't be copied — they reference rows in whatever estimate the template was
    // saved from, and EstimateItem.parentId is a self-FK, so a raw copy fails or
    // dangles — but null-vs-set still reliably marks a row as top-level vs child.
    let currentSectionId: string | null = null;
    for (const item of template.items) {
        const isSection = item.type === "Section";
        const newId = crypto.randomUUID();
        await prisma.estimateItem.create({
            data: {
                id: newId,
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
                parentId: isSection || item.parentId == null ? null : currentSectionId,
                costCodeId: item.costCodeId,
                costTypeId: item.costTypeId,
            },
        });
        if (isSection) currentSectionId = newId;
    }

    revalidatePath(`/projects/${projectId}/estimates`);
    return { id: estimate.id };
}

// =============================================
// Assembly (Reusable Item Bundles)
// =============================================

export async function saveItemsAsAssembly(name: string, items: { name: string; description?: string; type: string; quantity: number; baseCost: number; markupPercent: number; unitCost: number; order: number; parentId?: string | null; costCodeId?: string | null; costTypeId?: string | null; isSection?: boolean }[]) {
    await assertEstimatePermission();
    const itemRows = items.map((item, idx) => ({
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
    }));

    // Same-name save replaces the existing template (keeps id/source, bumps
    // updatedAt) so the library doesn't accumulate duplicates.
    const existing = await prisma.estimateTemplate.findFirst({
        where: { name: { equals: name, mode: "insensitive" } },
        select: { id: true },
    });
    if (existing) {
        const template = await prisma.$transaction(async tx => {
            await tx.estimateTemplateItem.deleteMany({ where: { templateId: existing.id } });
            return tx.estimateTemplate.update({
                where: { id: existing.id },
                data: { name, items: { create: itemRows } },
                include: { items: true },
            });
        });
        return { id: template.id, name: template.name, itemCount: template.items.length, updated: true };
    }

    const template = await prisma.estimateTemplate.create({
        data: { name, items: { create: itemRows } },
        include: { items: true },
    });
    return { id: template.id, name: template.name, itemCount: template.items.length, updated: false };
}

export async function deleteAssembly(templateId: string) {
    await assertEstimatePermission();
    await prisma.estimateTemplate.delete({ where: { id: templateId } });
    return { success: true };
}

// =============================================
// Document Templates CRUD
// =============================================

export async function getDocumentTemplates(type?: string) {
    await assertDocumentTemplateReadAccess();
    return await prisma.documentTemplate.findMany({
        where: type ? { type } : undefined,
        orderBy: { updatedAt: "desc" },
    });
}

export async function getDocumentTemplate(id: string) {
    await assertDocumentTemplateReadAccess();
    return await prisma.documentTemplate.findUnique({ where: { id } });
}

export async function createDocumentTemplate(data: { name: string; type: string; body: string; isDefault?: boolean }) {
    const user = await assertDocumentTemplateWritePermission();
    assertDocumentTemplateTypeScope(user, data.type);
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
    const user = await assertDocumentTemplateWritePermission();
    const existing = await prisma.documentTemplate.findUnique({ where: { id } });
    if (!existing) throw new Error("Template not found");
    // Scope the type this row ALREADY has, and — when the edit retypes it — the
    // one it is moving to, so neither end of a retype escapes the estimator set.
    assertDocumentTemplateTypeScope(user, existing.type);
    if (data.type !== undefined) assertDocumentTemplateTypeScope(user, data.type);
    // The type was authorized from a separately-loaded row, so the write must
    // re-assert it or a concurrent retype (by someone who IS allowed to retype)
    // could hand an estimates-only caller a now-protected row. Pinning the
    // observed type in the mutation's own filter closes that window; count 0
    // means the row changed type underneath us, which is a refusal, not a 404.
    const template = await prisma.$transaction(async (tx) => {
        const claimed = await tx.documentTemplate.updateMany({
            where: { id, type: existing.type },
            data,
        });
        if (claimed.count === 0) throw new Error("Forbidden");
        if (data.isDefault) {
            await tx.documentTemplate.updateMany({
                where: { type: data.type || existing.type, isDefault: true, NOT: { id } },
                data: { isDefault: false }
            });
        }
        return tx.documentTemplate.findUnique({ where: { id } });
    });
    revalidatePath("/company/templates");
    revalidatePath("/estimates");
    return template;
}

export async function deleteDocumentTemplate(id: string) {
    const user = await assertDocumentTemplateWritePermission();
    const existing = await prisma.documentTemplate.findUnique({ where: { id }, select: { type: true } });
    if (!existing) throw new Error("Template not found");
    assertDocumentTemplateTypeScope(user, existing.type);
    // Same TOCTOU pin as the update path: delete only the row whose type was
    // actually authorized, never "whatever this id is now".
    const removed = await prisma.documentTemplate.deleteMany({ where: { id, type: existing.type } });
    if (removed.count === 0) throw new Error("Forbidden");
    revalidatePath("/company/templates");
    revalidatePath("/estimates");
    return { success: true };
}

// =============================================
// Send Estimate to Client
// =============================================

export async function sendEstimateToClient(
    estimateId: string,
    templateId?: string,
    overrideEmail?: string,
    ccEmails?: string[],
    customMessage?: string,
    capturedPdfUrl?: string,
    mcpSecret?: string,
): Promise<{ success: true; sentTo: string } | { success: false; error: string }> {
    // The actor is DERIVED from what authenticated this call, never passed in.
    const sendActor = await assertEstimateSendPermission(mcpSecret);
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
    assertSendScope(sendActor, { projectId: estimate.project?.id ?? null, leadId: estimate.lead?.id ?? null });

    const schedules = await prisma.estimatePaymentSchedule.findMany({ where: { estimateId }, orderBy: { order: "asc" } });
    const unpaidSchedules = schedules.filter(s => s.status !== "Paid");
    if (unpaidSchedules.length > 0) {
        const estimateTotal = toNum(estimate.totalAmount);
        // Half-cent-safe currency rounding
        const rc = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

        const paidSum = schedules.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
        const balanceDue = rc(estimateTotal - paidSum);

        // No silent repair: this used to UPDATE the last unpaid milestone to
        // balanceDue − others before emailing, which is one of the writers that
        // kept reverting hand-corrected amounts (Mesplay EST-4226-3, Aug 2026).
        // A mismatched schedule now blocks the send with the explicit error
        // below — the editor's distribute-remainder button is the fix.
        const unpaidRounded = rc(unpaidSchedules.reduce((sum, s) => sum + toNum(s.amount), 0));
        // Integer-cent compare: |99.99 − 100| in floats is 0.010000000000005116,
        // which would reject an exactly-one-cent difference the tolerance means to allow.
        if (Math.abs(Math.round(unpaidRounded * 100) - Math.round(balanceDue * 100)) > 1) {
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
        if (capturedPdfUrl && (isSecureRef(capturedPdfUrl) || isAllowedCapturedPdfUrl(capturedPdfUrl))) {
            // Use the pre-captured portal PDF (high-quality, matches what client sees).
            // Read via the service key so this still works now that the capture lands in the
            // private bucket; the allowlist still gates legacy http(s) values.
            pdfBuffer = (await downloadDocBytes(capturedPdfUrl)) ?? undefined;
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

    // Also attach any files uploaded to the estimate, capped so the email stays deliverable.
    // Anything skipped here is still viewable in the client portal.
    let attachedFileCount = 0;
    try {
        const estimateFiles = await prisma.estimateFile.findMany({
            where: { estimateId },
            orderBy: { createdAt: "desc" },
        });
        if (estimateFiles.length > 0) {
            const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;  // 8 MB per file
            const MAX_TOTAL_EMAIL_BYTES = 18 * 1024 * 1024; // 18 MB total raw (PDF + files); ~25 MB once base64-encoded
            // Seed the budget with whatever is already attached (the estimate PDF) so we don't exceed Resend's payload limit.
            let usedBytes = (emailAttachments || []).reduce((sum, a) => sum + a.content.length, 0);
            const skipped: string[] = [];
            for (const f of estimateFiles) {
                if (f.size > MAX_SINGLE_FILE_BYTES) { skipped.push(`${f.name} (exceeds per-file limit)`); continue; }
                if (usedBytes + f.size > MAX_TOTAL_EMAIL_BYTES) { skipped.push(`${f.name} (over total size budget)`); continue; }
                // Defense-in-depth: only fetch our own Supabase storage URLs, never an arbitrary host (SSRF guard).
                let parsedUrl: URL;
                try { parsedUrl = new URL(f.url); } catch { skipped.push(`${f.name} (invalid url)`); continue; }
                if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname.endsWith(".supabase.co")) {
                    skipped.push(`${f.name} (untrusted url host)`);
                    continue;
                }
                try {
                    const res = await fetch(f.url, { signal: AbortSignal.timeout(15_000) });
                    if (!res.ok) { skipped.push(`${f.name} (fetch ${res.status})`); continue; }
                    const buf = Buffer.from(await res.arrayBuffer());
                    // Re-check against the real downloaded size in case the stored metadata was wrong.
                    if (buf.length > MAX_SINGLE_FILE_BYTES) { skipped.push(`${f.name} (exceeds per-file limit)`); continue; }
                    if (usedBytes + buf.length > MAX_TOTAL_EMAIL_BYTES) { skipped.push(`${f.name} (over total size budget)`); continue; }
                    emailAttachments = emailAttachments || [];
                    emailAttachments.push({ filename: f.name, content: buf });
                    usedBytes += buf.length;
                    attachedFileCount++;
                } catch (err) {
                    skipped.push(`${f.name} (download error)`);
                }
            }
            if (skipped.length > 0) {
                console.warn(`[sendEstimateToClient] ${skipped.length} estimate file(s) not attached (still viewable in the client portal):`, skipped);
            }
        }
    } catch (e) {
        console.error("[sendEstimateToClient] Failed to attach estimate files:", e);
        // Do not block the send — files remain viewable in the portal
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

    const attachmentsNote = attachedFileCount > 0
        ? `<div style="background: #f8fafc; border-left: 3px solid #4f46e5; padding: 12px 16px; margin: 0 0 24px; border-radius: 0 8px 8px 0;">
               <p style="color: #334155; margin: 0; font-size: 13px; font-weight: 600;">📎 ${attachedFileCount} additional file${attachedFileCount > 1 ? 's' : ''} attached. You can also view ${attachedFileCount > 1 ? 'them' : 'it'} anytime in your portal.</p>
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
                ${attachmentsNote}
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
        { fromName: companyName, replyTo: settings?.email || undefined, cc: ccEmails, copyToInternal: true }
    );

    if (!sendResult.success) {
        return { success: false, error: "Failed to send estimate email. Please check the recipient address and try again." };
    }

    const updatedStatus = ["Draft", "Sent", "Viewed"].includes(estimate.status) ? "Sent" : estimate.status;
    const isResend = !!estimate.sentAt;
    await prisma.estimate.update({
        where: { id: estimateId },
        data: { sentAt: new Date(), status: updatedStatus },
    });

    // Append-only send trail — every send (incl. resends) gets its own event.
    {
        // Legacy preservation: the first new-style resend overwrites sentAt (the
        // only record of the original send), so freeze that timestamp into the
        // log before it's gone. Runs at most once per estimate.
        if (isResend && estimate.sentAt) {
            const priorSendLogs = await prisma.activityLog.count({
                where: { entityType: "estimate", entityId: estimateId, action: "sent_estimate" },
            });
            if (priorSendLogs === 0) {
                await prisma.activityLog.create({
                    data: {
                        projectId: estimate.project?.id ?? null,
                        leadId: estimate.lead?.id ?? null,
                        actorType: "TEAM",
                        actorName: "Team",
                        action: "sent_estimate",
                        entityType: "estimate",
                        entityId: estimateId,
                        entityName: `Estimate ${estimate.code || estimate.title}`,
                        metadata: JSON.stringify({ resend: false, backfilled: true }),
                        createdAt: estimate.sentAt,
                    },
                }).catch(() => {});
            }
        }
        await logActivity({
            projectId: estimate.project?.id,
            leadId: estimate.lead?.id,
            // Trusted actor from assertEstimateSendPermission, not a caller argument.
            actorType: sendActor.type,
            actorName: sendActor.name,
            action: "sent_estimate",
            entityType: "estimate",
            entityId: estimateId,
            entityName: `Estimate ${estimate.code || estimate.title}`,
            metadata: { to: recipientEmail, cc: ccEmails && ccEmails.length > 0 ? ccEmails : undefined, resend: isResend },
        });
    }

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

    // (send is already logged to the activity feed right after sentAt is set —
    //  richer entry with recipient + resend flag, and it covers lead estimates too)

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

function bodyHasContractorBlock(body: string): boolean {
    return /\{\{CONTRACTOR_SIGNATURE_BLOCK\}\}|data-merge-field=["']CONTRACTOR_SIGNATURE_BLOCK["']/i.test(body || "");
}

function escapeEmailHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function resolveContractBody(
    body: string,
    projectId?: string | null,
    leadId?: string | null
): Promise<string> {
    if (!/\{\{\w+\}\}/.test(body) && !/data-merge-field=/.test(body)) return body;
    const data = await buildContractMergeData(projectId, leadId);
    return resolveMergeFields(body, data);
}

export async function getResolvedMergePreview(
    projectId?: string | null,
    leadId?: string | null
): Promise<Record<string, string>> {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    return buildContractMergeData(projectId, leadId);
}

// `getContracts` was deleted here. It had no callers anywhere — the live staff
// screens (projects/[id]/contracts, leads/[id]/contracts) query prisma.contract
// directly with contractScopeWhere(viewer). Having no callers did NOT make it
// inert: as this module actually builds (Next 16.2.11), the server-reference
// manifest registers all 360 of its exports as individually invokable POST
// endpoints, 37 of them unreferenced anywhere in src/ — so a caller-less export
// here is live attack surface whose gate nothing exercises. Next documents that
// unused actions MAY be eliminated, so that is a measurement of this build, not
// a universal rule; see docs/CONTRACTS.md. #367 gated it; this removes it. The
// scope rule it used, contractScopeWhere, is NOT orphaned: the two pages above
// and getLead's contracts relation are its consumers.

export async function getContract(id: string) {
    // Staff-only, scoped to the owning job. The docstring on getContractForPortal
    // below always CLAIMED this one was "admin-only"; nothing enforced it, so an
    // anonymous caller could read any contract — including its accessToken — plus
    // the full related client record, by id alone.
    await assertContractAccess(id);
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
    let contract: any = null;

    // Try token first — it's the path the email link uses and needs no session.
    if (token) {
        contract = await prisma.contract.findFirst({
            where: { id, accessToken: token },
            include: {
                project: { include: { client: true } },
                lead: { include: { client: true } },
            },
        });
    }

    // Fall back to session-based access for logged-in clients browsing /portal.
    if (!contract) {
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) return null;

        contract = await prisma.contract.findFirst({
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

    if (!contract) return null;

    // Re-resolve any remaining merge field placeholders against current data
    contract.body = await resolveContractBody(contract.body, contract.projectId, contract.leadId);

    return contract;
}

// `getExecutedContractPdf` was deleted here, for the same reason as
// `getContracts` above: no callers, but on this build every export of this
// module is registered as a POST endpoint anyway. Every real caller already uses
// the session-free core `executedContractPdfFor` in contract-files-core.ts —
// the client portal proves access by accessToken/portal session, and
// countersignContractAsCompany calls it after its own gate.

export async function createContractFromTemplate(
    templateId: string,
    context: { type: "project" | "lead"; id: string },
    titleOverride?: string,
    recurringDays?: number
) {
    await assertContractContextAccess(context);
    return createContractFromTemplateCore(templateId, context, titleOverride, recurringDays);
}

export async function createContractBlank(
    context: { type: "project" | "lead"; id: string },
    title: string,
    body: string
) {
    await assertContractContextAccess(context);
    return createContractBlankCore(context, title, body);
}

export async function createContractFromPdf(
    context: { type: "project" | "lead"; id: string },
    title: string,
    originalPdfPath: string,
    isPrivate: boolean = false
) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Not authenticated");
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } });
    if (!user || !["ADMIN", "MANAGER"].includes(user.role)) throw new Error("Forbidden");

    const coSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" }, select: { requireContractCountersign: true } });

    const contract = await prisma.contract.create({
        data: {
            title,
            body: "", // Empty HTML body for PDF contracts
            // `originalPdfPath` is a raw storage path. When the upload targeted the private
            // secure-docs bucket (see /api/files/signed-upload's "contract-original" scope),
            // wrap it into a secure ref so every downstream reader (downloadDocBytes,
            // resolveDocUrl) treats it correctly.
            originalPdfPath: isPrivate ? toSecureRef(originalPdfPath) : originalPdfPath,
            requiresCountersign: coSettings?.requireContractCountersign ?? false,
            ...(context.type === "project" ? { projectId: context.id } : { leadId: context.id }),
            status: "Draft",
        }
    });

    if (context.type === "project") revalidatePath(`/projects/${context.id}`);
    if (context.type === "lead") revalidatePath(`/leads/${context.id}`);

    // Resolve a browser-loadable URL server-side (mirrors the contracts page's own
    // findOriginalPdfUrl) so the client can preview the just-uploaded PDF immediately
    // without ever calling resolveDocUrl itself — the private bucket has no public URL,
    // so the caller has no other way to get one.
    const originalPdfUrl = await resolveDocUrl(contract.originalPdfPath);

    return { ...contract, originalPdfUrl };
}

export async function updateContract(id: string, data: { title?: string; body?: string; status?: string; requiresCountersign?: boolean }) {
    // Unauthenticated before this gate: an anonymous caller could rewrite any
    // contract's title/body/status/requiresCountersign by id — and because a
    // text edit clears the contractor signature (see below), a plain edit was
    // enough to strip a signature off a live legal document.
    await assertContractAccess(id);
    const existing = await prisma.contract.findUnique({
        where: { id },
        select: { status: true, title: true, body: true, contractorSignedBy: true, contractorSignedAt: true },
    });
    if (!existing) throw new Error("Contract not found");

    // Guard the signing-field handshake: normalize any un-normalized merge-field spans to
    // raw {{KEY}} so the portal (which greps for {{KEY}}) can always find the signing blocks.
    const safeData = { ...data };
    if (typeof safeData.body === "string") safeData.body = normalizeContractBody(safeData.body);

    const editsText = safeData.title !== undefined || safeData.body !== undefined;
    if (!editsText) {
        const contract = await prisma.contract.update({ where: { id }, data: safeData });
        revalidatePath(`/`);
        return contract;
    }

    // A contractor pre-signature (signContractAsContractor) covers the document text as it
    // stood when signed — the send/approve gates only check that contractorSignedAt exists,
    // so an edit after pre-sign would present altered text over the old signature. Text
    // edits therefore clear the contractor signature fields (forcing a re-sign of the new
    // text) in the SAME write, and the write is a full compare-and-swap on the snapshot we
    // diffed against (title/body/signature state): any concurrent edit or signature landing
    // between our read and this write makes the CAS miss and the save is rejected, instead
    // of silently reverting someone else's text under a live signature (Codex round-1
    // blocker: a stale no-op save must not retain a signature made over newer text).
    const textChanged =
        (safeData.title !== undefined && safeData.title !== existing.title) ||
        (safeData.body !== undefined && safeData.body !== (existing.body ?? ""));
    const clearingSignature = textChanged && !!existing.contractorSignedAt;
    await prisma.$transaction(async (tx) => {
        const res = await tx.contract.updateMany({
            where: {
                id,
                status: { notIn: ["Signed", "Finalized"] },
                title: existing.title,
                body: existing.body,
                contractorSignedAt: existing.contractorSignedAt,
            },
            data: {
                ...safeData,
                ...(textChanged ? { contractorSignedBy: null, contractorSignedAt: null, contractorSignatureUrl: null } : {}),
            },
        });
        if (res.count === 0) {
            const current = await tx.contract.findUnique({ where: { id }, select: { status: true } });
            if (current && ["Signed", "Finalized"].includes(current.status)) {
                throw new Error("Cannot edit a contract that has already been signed or finalized");
            }
            throw new Error("Contract changed while you were editing (someone edited or signed it) — reload and try again.");
        }
        // The cleared signature's original audit row stays; append an invalidation marker so
        // the e-sign trail shows the pre-edit signature no longer covers the current text.
        if (clearingSignature) {
            await tx.contractSigningRecord.create({
                data: {
                    contractId: id,
                    signedBy: existing.contractorSignedBy || "Contractor",
                    notes: "Contractor signature invalidated — contract text was edited after signing; re-sign required",
                },
            });
        }
    });
    const contract = await prisma.contract.findUnique({ where: { id } });
    if (!contract) throw new Error("Contract not found");
    revalidatePath(`/`);
    return contract;
}

export async function deleteContract(id: string) {
    // Unauthenticated before this gate: an anonymous caller could permanently
    // delete any contract — signed ones included — by id alone.
    await assertContractAccess(id);
    const contract = await prisma.contract.findUnique({ where: { id } });
    await prisma.contract.delete({ where: { id } });
    if (contract?.projectId) revalidatePath(`/projects/${contract.projectId}`);
    if (contract?.leadId) revalidatePath(`/leads/${contract.leadId}`);
}

export async function sendContractToClient(
    contractId: string,
    ccOverride?: string[],
    expectedFingerprint?: string,
    mcpSecret?: string,
) {
    // The actor is DERIVED from what authenticated this call, never passed in.
    const sendActor = await assertContractSendPermission(mcpSecret);
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        include: {
            project: { include: { client: true, manager: { select: { email: true } } } },
            lead: { include: { client: true, manager: { select: { email: true } } } },
        }
    });

    if (!contract) throw new Error("Contract not found");
    // Permission said WHAT; this says WHICH. Runs after the load, because the
    // document is what tells us which project/lead the caller is reaching into.
    assertSendScope(sendActor, { projectId: contract.projectId, leadId: contract.leadId });

    // MCP confirm-token guard: the caller previewed a specific document to the user and
    // binds that snapshot's hash here. If the contract changed between their preview and
    // this read (a concurrent edit), refuse — never email a legal document whose text
    // differs from what the user approved. Must hash the SAME fields, the same way, as
    // the send_contract tool in src/app/api/mcp/[transport]/route.ts.
    if (expectedFingerprint) {
        const fresh = createHash("sha256")
            .update(JSON.stringify({ title: contract.title, body: contract.body, status: contract.status, requiresCountersign: contract.requiresCountersign }))
            .digest("hex").slice(0, 24);
        if (fresh !== expectedFingerprint) {
            throw new Error("The contract changed after the preview — run the send preview again and re-confirm.");
        }
    }
    const client = contract.project?.client || contract.lead?.client;
    if (!client?.email) throw new Error("Client has no email address");

    if (bodyHasContractorBlock(contract.body || "") && !contract.contractorSignedAt) {
        throw new Error("Contractor must sign this contract before sending to the client.");
    }

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
    //
    // The transition also CAS-binds the body we validated above (and, when the text
    // carries a contractor block, that the contractor signature still exists) — an
    // edit landing between the gate check and here now clears the pre-signature, so
    // without this binding we could email a link to altered, unsigned text that the
    // upfront gate never saw. A CAS miss on a still-unsigned contract aborts the
    // send; a miss on an already-Signed/Finalized row keeps the old resend-as-no-op
    // behavior (email the executed contract's link, never clobber status).
    const sendTransition = await prisma.contract.updateMany({
        where: {
            id: contractId,
            status: { in: ["Draft", "Sent", "Viewed"] },
            body: contract.body,
            ...(bodyHasContractorBlock(contract.body || "") ? { contractorSignedAt: { not: null } } : {}),
        },
        data: {
            status: "Sent",
            sentAt: new Date(),
        }
    });
    if (sendTransition.count === 0) {
        const current = await prisma.contract.findUnique({ where: { id: contractId }, select: { status: true } });
        if (!current || !["Signed", "Finalized"].includes(current.status)) {
            throw new Error("Contract changed while sending (text edited or signature cleared) — reload and try again.");
        }
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const portalUrl = `${appUrl}/portal/contracts/${contractId}?token=${accessToken}`;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";
    const companyLogo = settings?.logoUrl || "";
    const companyLicense = settings?.licenseNumber || "";

    const safeCompany = escapeEmailHtml(companyName);
    const safeClient = escapeEmailHtml(client.name);
    const safeTitle = escapeEmailHtml(contract.title);
    const safeLicense = escapeEmailHtml(companyLicense);
    const logoHtml = companyLogo ? `<img src="${encodeURI(companyLogo)}" alt="${safeCompany}" style="max-height:56px;width:auto;margin:0 auto 8px;display:block;" />` : "";
    const licenseHtml = safeLicense ? `<p style="font-size:12px;color:#64748b;margin:4px 0 0;">Lic# ${safeLicense}</p>` : "";

    // CC: an explicit send-time override if the user edited it, otherwise the durable
    // auto-set — the client's additional email (spouse) + the assigned lead/project manager.
    const managerEmail = contract.project?.manager?.email || contract.lead?.manager?.email || null;
    const contractCc = ccOverride !== undefined
        ? buildCc(client.email, ...ccOverride)
        : buildCc(client.email, (client as any).additionalEmail, managerEmail);
    await sendNotification(
        client.email,
        `${companyName} sent you a contract to review`,
        [
            '<!DOCTYPE html><html><head><meta charset="utf-8"></head>',
            '<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">',
            `<div style="text-align:center;margin-bottom:24px;">${logoHtml}`,
            `<h1 style="font-size:20px;font-weight:700;margin:0;color:#0f172a;">${safeCompany}</h1>${licenseHtml}</div>`,
            '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;">',
            `<p style="color:#666;margin:0 0 16px;">Hi ${safeClient},</p>`,
            `<p style="color:#666;margin:0 0 20px;line-height:1.5;">${safeCompany} has sent you a contract titled "<strong>${safeTitle}</strong>" for your review and signature.</p>`,
            `<div style="text-align:center;margin:0 0 20px;"><a href="${encodeURI(portalUrl)}" style="display:inline-block;background:#222;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">View &amp; Sign Contract</a></div>`,
            '<p style="color:#999;font-size:13px;margin:0;">If you have any questions, reply to this email.</p>',
            '</div></body></html>',
        ].join(''),
        undefined,
        { fromName: companyName, replyTo: settings?.email || undefined, cc: contractCc, copyToInternal: true }
    );

    // Log to activity feed — project side uses ActivityLog, lead side uses the client message thread.
    if (contract.projectId) {
        await logActivity({
            projectId: contract.projectId,
            actorType: sendActor.type,
            actorName: sendActor.name,
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

    // Status re-read at return time, not from the transition above — the client can sign
    // while the email/activity awaits run, and callers use this to lock their editors.
    // "Sent" fallback only for the impossible row-deleted-mid-send case.
    const finalRow = await prisma.contract.findUnique({ where: { id: contractId }, select: { status: true } });
    return { success: true, sentTo: client.email, clientName: client.name, status: finalRow?.status ?? "Sent" };
}

// Prefill for the "Send contract" dialog: the primary recipient + the default CC set
// (additional client email + assigned manager) that the user can edit before sending.
export async function getContractSendDefaults(contractId: string): Promise<{ toEmail: string | null; autoCc: string[] }> {
    // Was authenticated but neither permission-checked nor scoped: a hard-coded
    // role list let any FINANCE user pass an arbitrary contract id and read the
    // client's primary/additional email plus the assigned manager's. FINANCE's
    // role default is `estimates`, not `contracts`, and this prefills a dialog
    // whose send path (assertContractSendPermission) already demands `contracts`
    // — so the old list granted a preview of data it could never act on.
    await assertContractAccess(contractId);

    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        include: {
            project: { include: { client: { select: { email: true, additionalEmail: true } }, manager: { select: { email: true } } } },
            lead: { include: { client: { select: { email: true, additionalEmail: true } }, manager: { select: { email: true } } } },
        },
    });
    if (!contract) throw new Error("Contract not found");
    const client = contract.project?.client || contract.lead?.client;
    const managerEmail = contract.project?.manager?.email || contract.lead?.manager?.email || null;
    const autoCc = buildCc(client?.email || "", client?.additionalEmail, managerEmail) || [];
    return { toEmail: client?.email || null, autoCc };
}

/**
 * Compensating delete for an uploaded signature after an AMBIGUOUS database outcome.
 * A Prisma rejection does not prove the write rolled back — on the PgBouncer pooler a
 * connection can drop after COMMIT — so probe for a surviving reference to this exact
 * object first. Unknown outcome => KEEP the object: an orphan is sweepable
 * (scripts/sweep-orphaned-signature-objects.mjs, which covers both the public project-files
 * bucket and the private secure-docs bucket this upload lands in), a deleted e-signature is not.
 */
async function discardSignatureUnlessReferenced(
    url: string | null,
    discard: () => Promise<void>,
    isReferenced: () => Promise<boolean>,
    context: string,
): Promise<void> {
    if (!url) return;

    // Typed `unknown` on purpose: the delete decision must fail closed even if a future
    // probe returns something other than a boolean.
    let referenced: unknown;
    try {
        referenced = await isReferenced();
    } catch (error) {
        try {
            console.error(`[${context}] signature reference probe failed — keeping the upload (unknown outcome, refuse to delete)`, error);
        } catch {
            // Logging must never replace the caller's primary error.
        }
        return;
    }

    // Fail closed: ONLY an explicit `false` authorises deletion. `true` means the write
    // committed despite the rejection; anything else means we don't actually know.
    if (referenced !== false) {
        try {
            console.warn(
                referenced === true
                    ? `[${context}] signature survived a rejected write — keeping the upload`
                    : `[${context}] signature reference probe gave a non-boolean result — keeping the upload (unknown outcome, refuse to delete)`,
                { url },
            );
        } catch {
            // Logging must never replace the caller's primary error.
        }
        return;
    }

    try {
        await discard();
    } catch (error) {
        try {
            console.error(`[${context}] signature cleanup failed`, error);
        } catch {
            // Logging must never replace the caller's primary error.
        }
    }
}

export async function signContractAsContractor(contractId: string, signerName: string, signatureDataUrl: string, expectedTitle: string, expectedBody: string) {
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

    // Move the signature image out of the DB column into Supabase Storage (avoids the
    // PgBouncer pooler message-size error on large high-DPI data-URLs). Falls back to the
    // raw data-URL when Storage isn't configured. See persistOwnedSignature().
    const ownedContractorSignature = await persistOwnedSignature(signatureDataUrl, `contracts/${contractId}/contractor`);
    const contractorSignatureUrl = ownedContractorSignature.url;
    const discardContractorSignature = async () => {
        try {
            await ownedContractorSignature.discard();
        } catch (error) {
            try {
                console.error("[signContractAsContractor] signature cleanup failed", error);
            } catch {
                // Logging must never replace the caller's primary error.
            }
        }
    };
    const ip = await getRequestIp();
    const signedAt = new Date();

    // Atomic idempotency guard + audit insert share a transaction so a failed audit insert rolls
    // the signature write back too — a retry then redoes BOTH (never leaves contractorSignedAt set
    // with no audit row). updateMany only matches rows where contractorSignedAt IS NULL, so two
    // concurrent requests can't both succeed (eliminates TOCTOU race).
    // The guard also CAS-checks the title and body the signer saw (both are cleared-signature
    // triggers in updateContract), so a signature can never commit over a document that was
    // edited after the signer last saw it (Codex blockers: a sign request based on an old
    // document must not reintroduce a live signature on changed text OR a changed title).
    try {
        await prisma.$transaction(async (tx) => {
            const guard = await tx.contract.updateMany({
                where: {
                    id: contractId,
                    contractorSignedAt: null,
                    title: expectedTitle,
                    body: expectedBody,
                },
                data: {
                    contractorSignedBy: signerName,
                    contractorSignedAt: signedAt,
                    contractorSignatureUrl,
                },
            });
            if (guard.count === 0) {
                const current = await tx.contract.findUnique({ where: { id: contractId }, select: { contractorSignedAt: true } });
                if (current?.contractorSignedAt) throw new Error("Contract already signed by contractor");
                throw new Error("The contract text changed after you opened it — review the current text and sign again.");
            }
            // Audit record for the contractor signature (captures IP + timestamp for the e-sign trail).
            await tx.contractSigningRecord.create({
                data: { contractId, signedBy: signerName, signedAt, signatureUrl: contractorSignatureUrl, ipAddress: ip, notes: "Contractor signature" },
            });
        });
    } catch (error) {
        // Ambiguous outcome (could be a genuine failed write, or a PgBouncer connection
        // drop after commit) — probe before deleting. See discardSignatureUnlessReferenced.
        await discardSignatureUnlessReferenced(
            contractorSignatureUrl,
            discardContractorSignature,
            async () => {
                const [contractHit, recordHit] = await Promise.all([
                    prisma.contract.findFirst({ where: { id: contractId, contractorSignatureUrl }, select: { id: true } }),
                    prisma.contractSigningRecord.findFirst({ where: { contractId, signatureUrl: contractorSignatureUrl }, select: { id: true } }),
                ]);
                return !!contractHit || !!recordHit;
            },
            "signContractAsContractor",
        );
        throw error;
    }

    try {
        await updateExecutedPdfIfFinalized(contractId, ip);
    } catch (err) {
        console.error("[signContractAsContractor] failed to update executed PDF:", err);
    }

    revalidatePath(`/projects/[id]/contracts`, "page");
    revalidatePath(`/leads/[id]/contracts`, "page");
    return { success: true };
}

async function updateExecutedPdfIfFinalized(contractId: string, ip: string | null) {
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        include: {
            project: { include: { client: true, manager: true } },
            lead: { include: { client: true, manager: true } },
        },
    });

    if (!contract || contract.status !== "Finalized" || !contract.originalPdfPath) {
        return;
    }

    const supabase = getSupabase();
    if (!supabase) return;

    // 1. Download original PDF
    const originalBuffer = await downloadDocBytes(contract.originalPdfPath);
    if (!originalBuffer) throw new Error("Could not load original PDF contract");

    // 2. Generate updated PDF
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    
    // Decide company/contractor values to show on Certificate of Execution.
    // We prefer the company countersignature if it exists, otherwise fall back to contractor signature.
    const companySignedBy = contract.companySignedBy || contract.contractorSignedBy;
    const companySignedAt = contract.companySignedAt || contract.contractorSignedAt;
    const companySignatureUrl = contract.companySignatureUrl || contract.contractorSignatureUrl;
    const companyIp = contract.companySignedAt ? "Stored" : (contract.contractorSignedAt ? (ip || "0.0.0.0") : undefined);

    const updatedPdfBuffer = await appendContractCountersignaturePage(originalBuffer, {
        companyName: settings?.companyName || "Company",
        contractTitle: contract.title,
        clientSignedBy: contract.approvedBy,
        clientSignedAt: contract.approvedAt,
        clientIp: contract.approvalIp || "0.0.0.0",
        clientSignatureValue: contract.signatureUrl,
        companySignedBy: companySignedBy || undefined,
        companySignedAt: companySignedAt || undefined,
        companyIp: companyIp || undefined,
        companySignatureValue: companySignatureUrl || undefined,
    });

    // 3. Find the existing executed file
    const fileName = `Executed_Contract_${contract.id}.pdf`;
    const existingFile = await prisma.projectFile.findFirst({
        where: {
            name: fileName,
            ...(contract.projectId ? { projectId: contract.projectId } : { leadId: contract.leadId }),
        },
        orderBy: { createdAt: "desc" },
    });

    // 4. Delete the old file from Storage if it exists
    if (existingFile?.url) {
        if (isSecureRef(existingFile.url)) {
            try {
                await removeSecureDoc(existingFile.url);
            } catch (removeErr) {
                console.warn("[updateExecutedPdfIfFinalized] Could not remove old PDF from storage:", removeErr);
            }
        } else {
            const match = existingFile.url.match(/\/project-files\/(.+)$/);
            if (match) {
                const oldStoragePath = decodeURIComponent(match[1]);
                try {
                    await supabase.storage.from(STORAGE_BUCKET).remove([oldStoragePath]);
                } catch (removeErr) {
                    console.warn("[updateExecutedPdfIfFinalized] Could not remove old PDF from storage:", removeErr);
                }
            }
        }
        // Delete the old DB record
        await prisma.projectFile.delete({
            where: { id: existingFile.id }
        });
    }

    // 5. Archive the new PDF (creates a new ProjectFile record and uploads it)
    const archived = await archiveExecutedContractPdf(
        { id: contract.id, title: contract.title, projectId: contract.projectId, leadId: contract.leadId },
        updatedPdfBuffer
    );

    // 6. Send the executed contract emails with the new PDF (best-effort)
    const client = contract.project?.client || contract.lead?.client;
    const managerEmail = contract.project?.manager?.email || contract.lead?.manager?.email || null;
    const cc = buildCc(client?.email || "", client?.additionalEmail, managerEmail);
    const companyEmail = settings?.notificationEmail || settings?.email;

    try {
        await sendExecutedContractEmails({
            contractTitle: contract.title,
            buffer: updatedPdfBuffer,
            fileName: archived.fileName,
            publicUrl: archived.publicUrl,
            clientEmail: client?.email,
            clientName: client?.name,
            cc,
            companyName: settings?.companyName || "ProBuild",
            companyEmail,
            replyTo: settings?.email,
        });
    } catch (emailErr) {
        console.error("[updateExecutedPdfIfFinalized] failed to send executed email:", emailErr);
    }
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

    if (bodyHasContractorBlock(contract.body || "") && !contract.contractorSignedAt) {
        throw new Error("This contract requires the contractor's signature before it can be signed by the client.");
    }

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

    // Persist the signature image to Storage BEFORE the transaction so the network upload
    // stays out of the DB tx. The same URL is written to both the Contract and the
    // ContractSigningRecord audit row. Falls back to the data-URL when Storage is absent.
    const ownedClientSignature = await persistOwnedSignature(signatureDataUrl, `contracts/${contractId}/client`);
    const signatureUrl = ownedClientSignature.url;
    const discardClientSignature = async () => {
        try {
            await ownedClientSignature.discard();
        } catch (error) {
            try {
                console.error("[approveContract] signature cleanup failed", error);
            } catch {
                // Logging must never replace the caller's primary error.
            }
        }
    };
    const ip = await getRequestIp();

    // Set inside the transaction when the CAS guard loses to a prior "already Signed" retry
    // (the no-op early-return below) — the uploaded signature never gets written to the row
    // in that case, so it must be discarded after the transaction settles.
    let signatureDidNotLand = false;

    try {
    await prisma.$transaction(async (tx) => {
        // Recompute per attempt: if this callback is ever re-run (e.g. someone wraps this in
        // withTxRetry), a flag left true by a previous attempt would make us delete a
        // signature the successful attempt committed.
        signatureDidNotLand = false;
        if (!isRecurring) {
            // CAS-bind the body we validated (and, when it carries a contractor block, that
            // the contractor pre-signature still exists) into the transition — text edits now
            // clear the pre-signature, so without this a contract could flip to Signed over
            // text the upfront gate never validated, or without the required contractor
            // signature at commit time.
            const transition = await tx.contract.updateMany({
                where: {
                    id: contractId,
                    status: { in: ["Draft", "Sent", "Viewed"] },
                    body: contract.body,
                    ...(bodyHasContractorBlock(contract.body || "") ? { contractorSignedAt: { not: null } } : {}),
                },
                data: {
                    status: "Signed",
                    approvedBy: signatureName,
                    approvedAt: now,
                    approvalUserAgent: userAgent,
                    approvalIp: ip,
                    signatureUrl,
                },
            });
            if (transition.count === 0) {
                // Already signed — allow finalize retry without overwriting audit data.
                const current = await tx.contract.findUnique({ where: { id: contractId }, select: { status: true } });
                if (current?.status === "Signed") {
                    // Idempotent retry — the row already carries a prior signature; this
                    // upload never gets written, so it must be cleaned up after the tx commits.
                    signatureDidNotLand = true;
                    return;
                }
                if (current && ["Draft", "Sent", "Viewed"].includes(current.status)) {
                    // Still signable ⇒ the CAS missed: text was edited (or the contractor
                    // signature was cleared) between validation and commit.
                    throw new Error("The contract changed while you were signing — please reload and review the current text.");
                }
                throw new Error("Contract is not in a signable state (already finalized)");
            }
        } else {
            const nextDue = new Date(now.getTime() + contract.recurringDays! * 86400000);
            // Recurring signs tolerate duplicate same-cycle audit rows, but they get the same
            // content/signature CAS as the one-time branch: both concurrent signers see the
            // same body so both still match, while an edit (which clears the contractor
            // pre-signature) between validation and commit makes the CAS miss and rejects.
            const recurringTransition = await tx.contract.updateMany({
                where: {
                    id: contractId,
                    body: contract.body,
                    ...(bodyHasContractorBlock(contract.body || "") ? { contractorSignedAt: { not: null } } : {}),
                },
                data: {
                    approvedBy: signatureName,
                    approvedAt: now,
                    approvalUserAgent: userAgent,
                    approvalIp: ip,
                    signatureUrl,
                    status: "Sent", // Reset to Sent so it can be signed again next cycle
                    viewedAt: null,
                    nextDueDate: nextDue,
                }
            });
            if (recurringTransition.count === 0) {
                throw new Error("The contract changed while you were signing — please reload and review the current text.");
            }
        }

        // Audit record — inside the same transaction as the state flip, so
        // a failure here aborts the whole thing and the client can retry.
        await tx.contractSigningRecord.create({
            data: {
                contractId,
                signedBy: signatureName,
                signedAt: now,
                signatureUrl,
                userAgent,
                ipAddress: ip,
                periodStart,
                periodEnd: now,
            }
        });
    });
    } catch (error) {
        // Ambiguous outcome (could be a genuine failed write, or a PgBouncer connection
        // drop after commit) — probe before deleting. See discardSignatureUnlessReferenced.
        await discardSignatureUnlessReferenced(
            signatureUrl,
            discardClientSignature,
            async () => {
                const [contractHit, recordHit] = await Promise.all([
                    prisma.contract.findFirst({ where: { id: contractId, signatureUrl }, select: { id: true } }),
                    prisma.contractSigningRecord.findFirst({ where: { contractId, signatureUrl }, select: { id: true } }),
                ]);
                return !!contractHit || !!recordHit;
            },
            "approveContract",
        );
        throw error;
    }
    if (signatureDidNotLand) {
        // Deterministic: the transaction committed and told us this upload was never
        // written anywhere (idempotent retry against an already-Signed row).
        await discardClientSignature();
    }

    const settings = await getCachedCompanySettings();
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
    // Unauthenticated before this gate: signer names, IP addresses, user agents,
    // notes and — because this action resolves `secure:` refs into loadable URLs
    // — the signature IMAGES themselves, for any contract id.
    await assertContractAccess(contractId);
    const records = await prisma.contractSigningRecord.findMany({
        where: { contractId },
        orderBy: { signedAt: "desc" },
    });
    // Called live from the Signing History modal, so resolve here: the client can't turn a
    // private-bucket `secure:` ref into a loadable URL itself. Legacy values pass through.
    return await Promise.all(
        records.map(async (record) => ({
            ...record,
            signatureUrl: await resolveDocUrl(record.signatureUrl),
        })),
    );
}

/**
 * Company countersignature — executed AFTER the client signs (see plan B).
 *
 * Flow when contract.requiresCountersign is true:
 *   client signs (approveContract → "Signed") → the finalize route stores the client-signed
 *   PDF privately on contract.signedPdfPath (status stays "Signed") → an ADMIN/MANAGER calls
 *   this action → we record the company signature, load the intermediate PDF, append a
 *   "Certificate of Execution" page carrying both signatures, archive it as the shared
 *   executed PDF, flip the contract to "Finalized", and email both parties.
 *
 * Idempotent + atomic: the company-signature write and the Signed→Finalized claim are each
 * guarded updateMany's, and the archive step rolls the status back on failure so a retry is safe.
 */
export async function countersignContractAsCompany(contractId: string, signerName: string, signatureDataUrl?: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Not authenticated");
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } });
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER")) throw new Error("Forbidden");

    if (!signerName?.trim()) throw new Error("Signer name is required");
    // pdf-lib can only embed PNG/JPEG on the certificate page, so restrict to those.
    if (signatureDataUrl && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(signatureDataUrl)) {
        throw new Error("Invalid signature format (PNG or JPEG required)");
    }

    const contract = await prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) throw new Error("Contract not found");

    // Already finalized → return the executed file idempotently. If status is Finalized but the
    // file isn't archived yet (a concurrent call is mid-archive), tell the admin to retry rather
    // than returning a false success with no file.
    if (contract.status === "Finalized") {
        const existing = await executedContractPdfFor(contract);
        if (existing) return { success: true, file: existing, alreadyFinalized: true };
        throw new Error("This contract is being finalized by another request. Please refresh in a moment.");
    }
    if (contract.status !== "Signed" || !contract.approvedAt) {
        throw new Error("The client must sign this contract before the company can countersign.");
    }
    if (!contract.signedPdfPath) {
        throw new Error("The signed contract PDF isn't ready yet. Please wait a moment and try again.");
    }

    const ip = await getRequestIp();
    const now = new Date();

    // Record the company signature once. On a retry where it's already recorded (companySignedAt
    // set), reuse the stored value and skip a duplicate upload. The signature write and audit
    // record share a transaction so a failed audit insert rolls the signature back too — a retry
    // then redoes BOTH (never leaves companySignedAt set with no audit row).
    if (!contract.companySignedAt) {
        const ownedCompanySignature = await persistOwnedSignature(signatureDataUrl, `contracts/${contractId}/company`);
        const companySignatureUrl = ownedCompanySignature.url;
        const discardCompanySignature = async () => {
            try {
                await ownedCompanySignature.discard();
            } catch (error) {
                try {
                    console.error("[countersignContractAsCompany] signature cleanup failed", error);
                } catch {
                    // Logging must never replace the caller's primary error.
                }
            }
        };
        let companySignatureLanded = false;
        try {
            await prisma.$transaction(async (tx) => {
                // Recompute per attempt: if this callback is ever re-run (e.g. someone wraps
                // this in withTxRetry), a stale value from a previous attempt would decide the
                // wrong way about deleting a committed signature.
                companySignatureLanded = false;
                const guard = await tx.contract.updateMany({
                    where: { id: contractId, status: "Signed", companySignedAt: null },
                    data: { companySignedBy: signerName, companySignedAt: now, companySignatureUrl },
                });
                if (guard.count > 0) {
                    companySignatureLanded = true;
                    await tx.contractSigningRecord.create({
                        data: { contractId, signedBy: signerName, signedAt: now, signatureUrl: companySignatureUrl, ipAddress: ip, notes: "Company countersignature" },
                    });
                }
            });
        } catch (error) {
            // Ambiguous outcome (could be a genuine failed write, or a PgBouncer connection
            // drop after commit) — probe before deleting. See discardSignatureUnlessReferenced.
            await discardSignatureUnlessReferenced(
                companySignatureUrl,
                discardCompanySignature,
                async () => {
                    const [contractHit, recordHit] = await Promise.all([
                        prisma.contract.findFirst({ where: { id: contractId, companySignatureUrl }, select: { id: true } }),
                        prisma.contractSigningRecord.findFirst({ where: { contractId, signatureUrl: companySignatureUrl }, select: { id: true } }),
                    ]);
                    return !!contractHit || !!recordHit;
                },
                "countersignContractAsCompany",
            );
            throw error;
        }
        if (!companySignatureLanded) {
            // Deterministic: the transaction committed and told us via guard.count this
            // upload lost the race and was never written anywhere.
            await discardCompanySignature();
        }
    }

    // Canonical state (covers a retry that recorded the signature but failed before finalizing).
    const after = await prisma.contract.findUnique({
        where: { id: contractId },
        include: {
            project: { include: { client: true, manager: true } },
            lead: { include: { client: true, manager: true } },
        },
    });
    if (!after) throw new Error("Contract not found");
    if (after.status === "Finalized") {
        return { success: true, file: await executedContractPdfFor(after), alreadyFinalized: true };
    }
    if (after.status !== "Signed" || !after.companySignedAt || !after.signedPdfPath) {
        throw new Error("Contract is not in a countersignable state.");
    }

    // Atomically claim the finalize transition so concurrent calls can't double-archive.
    const flip = await prisma.contract.updateMany({
        where: { id: contractId, status: "Signed" },
        data: { status: "Finalized" },
    });
    if (flip.count === 0) {
        // Lost the race. Report success only if the executed file actually exists yet — otherwise
        // the winner is still archiving (or rolled back), so tell the admin to retry rather than
        // returning a false success with no file.
        const fresh = await prisma.contract.findUnique({ where: { id: contractId } });
        const existing = fresh?.status === "Finalized" ? await executedContractPdfFor(fresh) : null;
        if (existing) return { success: true, file: existing, alreadyFinalized: true };
        throw new Error("This contract is being finalized by another request. Please refresh in a moment.");
    }

    // Build + archive the executed PDF. This is the commit point: on failure we roll status back to
    // "Signed" and archiveExecutedContractPdf removes its own storage object, so a retry is clean.
    // Emails happen AFTER (best-effort) — an email hiccup must not undo a successfully executed doc.
    let executedRecord: any = null;
    let executedBuffer: Buffer | null = null;
    let archivedMeta: { publicUrl: string; fileName: string } | null = null;
    try {
        const supabase = getSupabase();
        if (!supabase) throw new Error("Storage not configured.");

        // signedPdfPath is polymorphic: a secure ref for a freshly-uploaded intermediate
        // (countersign-required, non-PDF contracts), or a legacy bare path when it was set
        // to the pre-existing originalPdfPath (PDF-contract countersign branch). downloadDocBytes
        // handles both.
        const clientPdf = await downloadDocBytes(after.signedPdfPath);
        if (!clientPdf) throw new Error("Could not load the signed contract PDF.");

        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        executedBuffer = await appendContractCountersignaturePage(clientPdf, {
            companyName: settings?.companyName || "Company",
            contractTitle: after.title,
            clientSignedBy: after.approvedBy,
            clientSignedAt: after.approvedAt,
            clientIp: after.approvalIp,
            clientSignatureValue: after.originalPdfPath ? after.signatureUrl : null, // client signature url for PDF contracts
            companySignedBy: after.companySignedBy!,
            companySignedAt: after.companySignedAt!,
            companyIp: ip,
            companySignatureValue: after.companySignatureUrl,
        });

        const archived = await archiveExecutedContractPdf(
            { id: after.id, title: after.title, projectId: after.projectId, leadId: after.leadId },
            executedBuffer
        );
        executedRecord = archived.record;
        archivedMeta = { publicUrl: archived.publicUrl, fileName: archived.fileName };

        // Drop the now-superseded private intermediate (best-effort). For a PDF-contract
        // countersign, signedPdfPath was set to the SAME value as originalPdfPath (see
        // finalize/route.ts) — there is no distinct intermediate to remove in that case, and
        // deleting it would delete the contract's original PDF. Only remove when signedPdfPath
        // names a genuinely distinct, contract-owned object.
        try {
            if (after.signedPdfPath !== after.originalPdfPath) {
                if (isSecureRef(after.signedPdfPath)) {
                    await removeSecureDoc(after.signedPdfPath);
                } else {
                    await supabase.storage.from(STORAGE_BUCKET).remove([after.signedPdfPath]);
                }
            }
        } catch {}
    } catch (e: any) {
        // Roll back the finalize claim so the admin can retry. companySignedAt stays set (the
        // company DID sign); the retry re-claims and re-archives.
        await prisma.contract.updateMany({ where: { id: contractId, status: "Finalized" }, data: { status: "Signed" } });
        console.error("[countersignContractAsCompany] finalize step failed:", e);
        throw new Error(`Couldn't generate the executed PDF: ${e?.message || e}. Your signature was saved — please retry.`);
    }

    // Best-effort notifications — a failure here does NOT undo the executed contract.
    try {
        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const client = after.project?.client || after.lead?.client;
        const managerEmail = after.project?.manager?.email || after.lead?.manager?.email || null;
        const cc = buildCc(client?.email || "", (client as any)?.additionalEmail, managerEmail);
        if (executedBuffer && archivedMeta) {
            await sendExecutedContractEmails({
                contractTitle: after.title,
                buffer: executedBuffer,
                fileName: archivedMeta.fileName,
                publicUrl: archivedMeta.publicUrl,
                clientEmail: client?.email,
                clientName: client?.name,
                cc,
                companyName: settings?.companyName || "ProBuild",
                companyEmail: settings?.notificationEmail || settings?.email,
                replyTo: settings?.email,
            });
        }
    } catch (e) {
        console.error("[countersignContractAsCompany] executed-doc email failed (non-fatal):", e);
    }

    // Post-commit activity logging is best-effort — the contract is already executed + archived,
    // so a logging hiccup must not surface to the admin as a failure.
    try {
        if (after.projectId) {
            await logActivity({
                projectId: after.projectId,
                actorType: "TEAM",
                actorName: signerName,
                action: "countersigned_contract",
                entityType: "contract",
                entityId: contractId,
                entityName: `Contract "${after.title}"`,
            });
        }
        await postActivityToThread(
            after.leadId ?? null,
            after.projectId ?? null,
            `🖋️ ${signerName} countersigned contract "${after.title}" on ${now.toLocaleDateString()} — fully executed.`
        );
    } catch (e) {
        console.error("[countersignContractAsCompany] post-commit activity log failed (non-fatal):", e);
    }

    revalidatePath(`/projects/[id]/contracts`, "page");
    revalidatePath(`/leads/[id]/contracts`, "page");
    revalidatePath("/");
    return { success: true, file: executedRecord };
}

// ────────────────────────────────────────────────
// Schedule Tasks
// ────────────────────────────────────────────────

export async function getScheduleTasks(projectId: string) {
    // Hardened (dispatch-arc foundation): internal schedule details require an authenticated team session.
    const session = await getSessionOrDev();
    if (!session?.user) throw new Error("Unauthorized");
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
            estimateItem: { select: { id: true, name: true, type: true, total: true, estimateId: true, quantity: true, budgetUnit: true } },
        },
    });
}

export interface TaskBankResult {
    estimate: { id: string; code: string } | null;
    items: {
        estimateItemId: string;
        name: string;
        estimatedHours: number | null;
    }[];
    scheduledCount: number;
    totalCount: number;
}

export async function getTaskBank(projectId: string): Promise<TaskBankResult> {
    const session = await getSessionOrDev();
    if (!session?.user) throw new Error("Unauthorized");

    const estimate = await prisma.estimate.findFirst({
        ...canonicalContractEstimateQuery(projectId),
        select: {
            id: true,
            code: true,
            items: {
                where: { type: { not: "Section" } },
                orderBy: [{ order: "asc" }, { id: "asc" }],
                select: {
                    id: true,
                    name: true,
                    quantity: true,
                    budgetUnit: true,
                    _count: { select: { subItems: true } },
                    scheduleTask: { select: { id: true } },
                },
            },
        },
    });
    if (!estimate) {
        return {
            estimate: null,
            items: [],
            scheduledCount: 0,
            totalCount: 0,
        };
    }

    const scheduledCount = estimate.items.filter(item => Boolean(item.scheduleTask)).length;
    return {
        estimate: { id: estimate.id, code: estimate.code },
        items: estimate.items
            .filter(item => !item.scheduleTask)
            .map(item => ({
                estimateItemId: item.id,
                name: item.name,
                estimatedHours: deriveEstimateItemHours({
                    quantity: item.quantity,
                    budgetUnit: item.budgetUnit,
                    childCount: item._count.subItems,
                }),
            })),
        scheduledCount,
        totalCount: estimate.items.length,
    };
}

function serializeScheduleTaskForDetail(task: any) {
    return {
        id: task.id,
        projectId: task.projectId,
        name: task.name,
        startDate: task.startDate.toISOString().slice(0, 10),
        endDate: task.endDate.toISOString().slice(0, 10),
        color: task.color,
        progress: task.progress,
        estimatedHours: task.estimatedHours,
        assignee: task.assignee,
        parentId: task.parentId,
        estimateItemId: task.estimateItemId ?? null,
        order: task.order,
        status: task.status,
        type: task.type,
        doneWhen: task.doneWhen ?? null,
        blockedReason: task.blockedReason ?? null,
        clientStage: task.clientStage ?? null,
        scheduledTime: task.scheduledTime ?? null,
        confirmationStatus: task.confirmationStatus ?? null,
        actualHours: task.timeEntries.reduce((sum: number, entry: { durationHours: number }) => sum + entry.durationHours, 0),
        dependencies: task.dependencies,
        dependents: task.dependents,
        timeEntries: task.timeEntries,
        assignments: task.assignments,
        subAssignments: task.subAssignments,
        estimateItem: task.estimateItem ? { ...task.estimateItem, total: Number(task.estimateItem.total) } : null,
    };
}

export async function getScheduleTaskDetail(taskId: string) {
    const { projectId } = await assertScheduleTaskAccess(taskId);
    const tasks = await prisma.scheduleTask.findMany({
        where: { projectId },
        orderBy: { order: "asc" },
        include: {
            dependencies: true,
            dependents: true,
            timeEntries: { select: { durationHours: true } },
            assignments: { include: { user: { select: { id: true, name: true, email: true } } } },
            subAssignments: { include: { subcontractor: { select: { id: true, companyName: true, email: true, trade: true } } } },
            estimateItem: { select: { id: true, name: true, type: true, total: true, estimateId: true, quantity: true, budgetUnit: true } },
        },
    });
    const task = tasks.find((candidate: any) => candidate.id === taskId);
    if (!task) throw new Error("Task not found");
    return {
        ...serializeScheduleTaskForDetail(task),
        allTasks: tasks.map(serializeScheduleTaskForDetail),
    };
}

export async function getTaskMaterials(taskId: string) {
    const { user } = await assertScheduleTaskAccess(taskId);
    const rows = await getTaskMaterialsCore(taskId);
    return rows.map(row => ({
        ...row,
        canDelete: ["ADMIN", "MANAGER"].includes(user.role) || row.createdById === user.id,
    }));
}

export async function addTaskMaterial(taskId: string, input: TaskMaterialInput) {
    const { user, projectId } = await assertScheduleTaskAccess(taskId);
    const row = await addTaskMaterialCore({
        taskId,
        input,
        actor: taskMaterialActor(user),
    });
    revalidateTaskMaterialPaths(projectId);
    return {
        ...row,
        canDelete: ["ADMIN", "MANAGER"].includes(user.role) || row.createdById === user.id,
    };
}

export async function updateTaskMaterial(materialId: string, input: TaskMaterialUpdateInput) {
    const material = await prisma.taskMaterial.findUnique({
        where: { id: materialId },
        select: { taskId: true },
    });
    if (!material) throw new Error("Material not found");
    const { user, projectId } = await assertScheduleTaskAccess(material.taskId);
    const row = await updateTaskMaterialCore({
        materialId,
        input,
        actor: taskMaterialActor(user),
    });
    revalidateTaskMaterialPaths(projectId);
    return {
        ...row,
        canDelete: ["ADMIN", "MANAGER"].includes(user.role) || row.createdById === user.id,
    };
}

export async function setTaskMaterialStatus(
    materialId: string,
    status: TaskMaterialStatus,
    resolutionNote?: string | null,
) {
    const material = await prisma.taskMaterial.findUnique({
        where: { id: materialId },
        select: { taskId: true },
    });
    if (!material) throw new Error("Material not found");
    const { user, projectId } = await assertScheduleTaskAccess(material.taskId);
    const row = await setTaskMaterialStatusCore({
        materialId,
        status,
        resolutionNote,
        actor: taskMaterialActor(user),
    });
    revalidateTaskMaterialPaths(projectId);
    return {
        ...row,
        canDelete: ["ADMIN", "MANAGER"].includes(user.role) || row.createdById === user.id,
    };
}

export async function deleteTaskMaterial(materialId: string) {
    const material = await prisma.taskMaterial.findUnique({
        where: { id: materialId },
        select: { taskId: true },
    });
    if (!material) throw new Error("Material not found");
    const { user, projectId } = await assertScheduleTaskAccess(material.taskId);
    const result = await deleteTaskMaterialCore({
        materialId,
        actor: taskMaterialActor(user),
    });
    revalidateTaskMaterialPaths(projectId);
    return result;
}

export async function importEstimateMaterials(taskId: string) {
    const { user, projectId } = await assertScheduleTaskAccess(taskId);
    const result = await importEstimateMaterialsCore({
        taskId,
        actor: taskMaterialActor(user),
    });
    revalidateTaskMaterialPaths(projectId);
    return result;
}

export async function getStagingQueue(dayISO: string) {
    await assertStagingQueueAccess();
    return getStagingQueueCore(dayISO);
}

export async function getPortalScheduleTasks(projectId: string) {
    // Client-safe allowlist shared by the simple tracker and the full schedule.
    await assertPortalProjectAccess(projectId, "showSchedule");
    return getPortalScheduleTasksCore(projectId);
}

export async function getDashboardTasks(projectId: string) {
    // Hardened (dispatch-arc foundation): dashboard task summaries require an authenticated team session.
    const session = await getSessionOrDev();
    if (!session?.user) throw new Error("Unauthorized");
    return prisma.scheduleTask.findMany({
        where: { projectId },
        orderBy: { order: "asc" },
        select: {
            id: true,
            status: true,
            endDate: true,
            color: true,
            name: true,
            progress: true,
        }
    });
}

export async function getEstimateItemsForProject(projectId: string) {
    await assertEstimateProjectAccess(projectId);
    const items = await prisma.estimateItem.findMany({
        where: { estimate: { projectId }, type: { not: "Section" } },
        orderBy: { order: "asc" },
        select: { id: true, name: true, type: true, total: true, estimateId: true, parentId: true, parent: { select: { name: true } }, quantity: true, budgetUnit: true, scheduleTask: { select: { id: true, name: true } } },
    });
    return items.map(({ scheduleTask, ...rest }) => ({
        ...rest,
        total: Number(rest.total),
        linkedTaskId: scheduleTask?.id ?? null,
        linkedTaskName: scheduleTask?.name ?? null,
    }));
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
            estimateItem: { select: { id: true, name: true, type: true, total: true, estimateId: true, quantity: true, budgetUnit: true } },
        },
    });
}

export async function addTaskCommentAsSub(taskId: string, subcontractorId: string, text: string) {
    const { getSubPortalSession } = await import("@/lib/sub-portal-auth");
    const session = await getSubPortalSession();
    if (!session || session.id !== subcontractorId) throw new Error("Unauthorized");
    const assignment = await prisma.subTaskAssignment.findUnique({
        where: { subcontractorId_taskId: { subcontractorId, taskId } },
    });
    if (!assignment) throw new Error("Not assigned to this task");
    const sub = await prisma.subcontractor.findUnique({ where: { id: subcontractorId }, select: { companyName: true, contactName: true } });
    const displayName = sub?.contactName || sub?.companyName || "Subcontractor";
    const comment = await prisma.taskComment.create({
        data: { taskId, userId: null, text, subcontractorName: displayName },
    });
    revalidatePath(`/projects`);
    return comment;
}

export async function updateTaskStatusAsSub(taskId: string, subcontractorId: string, status: string) {
    const { getSubPortalSession } = await import("@/lib/sub-portal-auth");
    const session = await getSubPortalSession();
    if (!session || session.id !== subcontractorId) throw new Error("Unauthorized");
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

type TaskCommentAuthor = {
    userId: string | null;
    fallbackLabel: string;
};

async function resolveTaskCommentAuthor(): Promise<TaskCommentAuthor> {
    const session = await getSessionOrDev();
    const sessionUserId = (session?.user as any)?.id as string | null | undefined;
    const sessionName = (session?.user?.name as string | null) ?? null;
    const sessionEmail = (session?.user?.email as string | null) ?? null;
    let userId: string | null = null;
    if (sessionUserId) {
        userId = (await prisma.user.findUnique({ where: { id: sessionUserId }, select: { id: true } }))?.id ?? null;
    }
    return { userId, fallbackLabel: sessionName ?? sessionEmail ?? "Unknown" };
}

function buildTaskCommentCreateData(taskId: string, text: string, author: TaskCommentAuthor, photoUrls?: string[]) {
    const cleanPhotoUrls = (photoUrls ?? []).filter(url => typeof url === "string" && url.length > 0).slice(0, 10);
    return {
        taskId,
        text,
        userId: author.userId,
        subcontractorName: author.userId ? null : author.fallbackLabel,
        photos: cleanPhotoUrls.length > 0 ? { create: cleanPhotoUrls.map(url => ({ url })) } : undefined,
    };
}

export async function createScheduleTask(projectId: string, data: CreateScheduleTaskInput) {
    const user = await assertScheduleProjectAccess(projectId);
    const note = data.note?.trim() || null;
    const commentAuthor = note ? await resolveTaskCommentAuthor() : null;
    const task = await withTxRetry(() => prisma.$transaction(tx =>
        createScheduleTaskInTransaction(
            tx,
            projectId,
            data,
            { type: "TEAM", name: user.name || user.email },
            commentAuthor,
        ),
    ));
    revalidatePath("/company-dashboard");
    revalidatePath(`/projects/${projectId}/schedule`);
    return task;
}

export async function updateScheduleTask(taskId: string, data: UpdateScheduleTaskInput) {
    const { user, projectId } = await assertScheduleTaskAccess(taskId);
    const task = await withTxRetry(() => prisma.$transaction(tx =>
        updateScheduleTaskInTransaction(
            tx,
            taskId,
            data,
            { type: "TEAM", name: user.name || user.email },
            projectId,
        ),
    ));
    revalidatePath("/company-dashboard");
    revalidatePath(`/projects/${projectId}/schedule`);
    return task;
}
export async function deleteScheduleTask(taskId: string) {
    await assertScheduleTaskAccess(taskId);
    const task = await prisma.scheduleTask.delete({ where: { id: taskId } });
    revalidatePath(`/projects/${task.projectId}/schedule`);
    return task;
}

export async function reorderScheduleTasks(projectId: string, orderedIds: string[]) {
    await assertScheduleProjectAccess(projectId);
    if (new Set(orderedIds).size !== orderedIds.length) {
        throw new Error("Duplicate task IDs in reorder request");
    }
    await prisma.$transaction(async (tx) => {
        const projectTasks = await tx.scheduleTask.findMany({
            where: { projectId },
            select: { id: true },
        });
        const projectIdSet = new Set(projectTasks.map(t => t.id));
        if (projectIdSet.size !== orderedIds.length) {
            throw new Error("Reorder must include the full set of project tasks");
        }
        for (const id of orderedIds) {
            if (!projectIdSet.has(id)) throw new Error(`Task ${id} does not belong to project`);
        }
        await Promise.all(
            orderedIds.map((id, idx) =>
                tx.scheduleTask.update({ where: { id }, data: { order: idx } })
            )
        );
    });
    revalidatePath(`/projects/${projectId}/schedule`);
    return { ok: true };
}

export async function linkTasks(predecessorId: string, dependentId: string) {
    const [predecessor, dependent] = await Promise.all([
        assertScheduleTaskAccess(predecessorId),
        assertScheduleTaskAccess(dependentId),
    ]);
    if (predecessor.projectId !== dependent.projectId) throw new Error("Tasks must belong to the same project");
    const dep = await prisma.taskDependency.create({
        data: { predecessorId, dependentId },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: predecessorId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
    return dep;
}

export async function unlinkTasks(predecessorId: string, dependentId: string) {
    const [predecessor, dependent] = await Promise.all([
        assertScheduleTaskAccess(predecessorId),
        assertScheduleTaskAccess(dependentId),
    ]);
    if (predecessor.projectId !== dependent.projectId) throw new Error("Tasks must belong to the same project");
    await prisma.taskDependency.deleteMany({
        where: { predecessorId, dependentId },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: predecessorId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
}

export async function importEstimateToSchedule(projectId: string, estimateId: string) {
    // Two ids, two scopes: the estimate being read and the project whose
    // schedule is written. They are independent arguments, so check both.
    await assertEstimateAccess(estimateId);
    await assertEstimateProjectAccess(projectId);
    // Rewired through the schedule-core generator (PB-pipeline-002): one
    // shared precondition/idempotency path for estimate — schedule.
    // Merge mode skips already task-linked items. Response shape preserved
    // for existing callers: the created task rows.
    const result = await generateScheduleFromEstimate({
        estimateId,
        mode: "merge",
        actor: { type: "TEAM", name: "Team" },
    });
    revalidatePath(`/projects/${projectId}/schedule`);
    return result.created;
}

// ========== TASK COMMENTS ==========

export async function addTaskComment(taskId: string, text: string, photoUrls?: string[]) {
    // Hardened (owner-feedback round, item 3): this action had no auth check
    // at all — any caller could comment on any task. Same gate every other
    // per-task schedule mutation in this file uses (schedules permission +
    // project access), now also the entry point for the schedule board's
    // hover-card "Add note…".
    await assertScheduleTaskAccess(taskId);
    // Derive identity from the session — never trust a client-supplied userId.
    const author = await resolveTaskCommentAuthor();

    const comment = await prisma.taskComment.create({
        data: buildTaskCommentCreateData(taskId, text, author, photoUrls),
        include: {
            user: { select: { id: true, name: true, email: true } },
            photos: { orderBy: { createdAt: "asc" } },
        },
    });
    return comment;
}

export async function getTaskComments(taskId: string) {
    return prisma.taskComment.findMany({
        where: { taskId },
        orderBy: { createdAt: "asc" },
        include: {
            user: { select: { id: true, name: true, email: true } },
            photos: { orderBy: { createdAt: "asc" } },
        },
    });
}

export async function getTaskTimeEntries(taskId: string) {
    const [entries, total] = await Promise.all([
        prisma.timeEntry.findMany({
            where: { scheduleTaskId: taskId },
            orderBy: { startTime: "desc" },
            take: 50,
            select: {
                id: true,
                startTime: true,
                durationHours: true,
                user: { select: { id: true, name: true, email: true } },
                costCode: { select: { id: true, code: true, name: true } },
            },
        }),
        prisma.timeEntry.count({ where: { scheduleTaskId: taskId } }),
    ]);
    return { entries, total };
}

// ========== FIELD UPDATES FEED ==========
// Cross-project comment stream for managers. Filtered to projects the
// caller can access (ADMIN/MANAGER see all; others see only ProjectAccess + crew-assigned).

async function getAccessibleProjectIds(userId: string, role: string | null): Promise<string[] | "ALL"> {
    if (role === "ADMIN" || role === "MANAGER") return "ALL";
    const access = await prisma.projectAccess.findMany({ where: { userId }, select: { projectId: true } });
    const crew = await prisma.project.findMany({
        where: { crew: { some: { id: userId } } },
        select: { id: true },
    });
    return Array.from(new Set([...access.map(a => a.projectId), ...crew.map(c => c.id)]));
}

export async function getFieldUpdatesFeed(opts?: { limit?: number; sinceDays?: number }) {
    const session = await getSessionOrDev();
    const sessionUserId = (session?.user as any)?.id as string | null | undefined;
    const sessionRole = ((session?.user as any)?.role as string | null) ?? null;
    const isFullAccess = sessionRole === "ADMIN" || sessionRole === "MANAGER";
    if (!sessionUserId && !isFullAccess) return { comments: [], scope: "none" as const };

    const accessible: string[] | "ALL" = isFullAccess
        ? "ALL"
        : await getAccessibleProjectIds(sessionUserId!, sessionRole);
    const limit = Math.min(opts?.limit ?? 50, 200);
    const sinceDays = opts?.sinceDays ?? 14;
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    const where: any = { createdAt: { gte: since } };
    if (accessible !== "ALL") {
        if (accessible.length === 0) return { comments: [], scope: "scoped" as const };
        where.task = { projectId: { in: accessible } };
    }

    const comments = await prisma.taskComment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        include: {
            user: { select: { id: true, name: true, email: true } },
            photos: { orderBy: { createdAt: "asc" }, select: { id: true, url: true } },
            task: {
                select: {
                    id: true,
                    name: true,
                    projectId: true,
                    project: { select: { id: true, name: true } },
                },
            },
        },
    });
    return { comments, scope: accessible === "ALL" ? ("all" as const) : ("scoped" as const) };
}

export async function getUnreadFieldUpdatesCount(): Promise<number> {
    const session = await getSessionOrDev();
    const sessionUserId = (session?.user as any)?.id as string | null | undefined;
    const sessionRole = ((session?.user as any)?.role as string | null) ?? null;
    const isFullAccess = sessionRole === "ADMIN" || sessionRole === "MANAGER";
    if (!sessionUserId && !isFullAccess) return 0;

    let since: Date;
    if (sessionUserId) {
        const user = await prisma.user.findUnique({
            where: { id: sessionUserId },
            select: { fieldUpdatesSeenAt: true },
        });
        since = user?.fieldUpdatesSeenAt ?? new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    } else {
        // No DB user (e.g. dev session without seed user): use a 14d window so the page
        // still shows a non-zero badge for testing.
        since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    }

    const accessible: string[] | "ALL" = isFullAccess
        ? "ALL"
        : await getAccessibleProjectIds(sessionUserId!, sessionRole);
    const where: any = {
        createdAt: { gt: since },
    };
    if (sessionUserId) {
        // Don't count the viewer's own comments as unread to themselves.
        where.NOT = { userId: sessionUserId };
    }
    if (accessible !== "ALL") {
        if (accessible.length === 0) return 0;
        where.task = { projectId: { in: accessible } };
    }
    return prisma.taskComment.count({ where });
}

export async function markFieldUpdatesSeen() {
    const session = await getSessionOrDev();
    const sessionUserId = (session?.user as any)?.id as string | null | undefined;
    if (!sessionUserId) return { ok: true, note: "no-op (no user session)" };
    await prisma.user.update({
        where: { id: sessionUserId },
        data: { fieldUpdatesSeenAt: new Date() },
    });
    revalidatePath("/manager/field-updates");
    return { ok: true };
}

// ========== PUNCH LIST ==========

export async function addTaskPunchItem(taskId: string, name: string) {
    await assertScheduleTaskAccess(taskId);
    const [item] = await withTxRetry(() => prisma.$transaction(
        tx => appendPunchItemsInTransaction(tx, taskId, [name]),
    ));
    return item;
}

export async function togglePunchItem(id: string) {
    const current = await prisma.taskPunchItem.findUnique({ where: { id } });
    if (!current) return null;
    // Completing a punch item is now DIRECT field evidence on the schedule
    // board, so this needs the same access gate as every other task mutation.
    await assertScheduleTaskAccess(current.taskId);
    const nextCompleted = !current.completed;
    const nextCompletedAt = nextCompleted ? new Date() : null;
    // Guarded flip: the WHERE clause pins the expected `completed` value, so two concurrent
    // taps can't both read false and both write true. The loser's updateMany matches 0 rows
    // and falls back to reading the winner's result instead of double-flipping.
    const result = await prisma.taskPunchItem.updateMany({
        where: { id, completed: current.completed },
        data: { completed: nextCompleted, completedAt: nextCompletedAt },
    });
    if (result.count === 0) {
        return prisma.taskPunchItem.findUnique({ where: { id } });
    }
    return { ...current, completed: nextCompleted, completedAt: nextCompletedAt };
}

export async function deletePunchItem(id: string) {
    const current = await prisma.taskPunchItem.findUnique({
        where: { id },
        select: { taskId: true },
    });
    if (!current) return null;
    await assertScheduleTaskAccess(current.taskId);
    // deleteMany so a concurrent delete of the same item is a no-op, not a P2025 throw
    await prisma.taskPunchItem.deleteMany({ where: { id } });
    return { id };
}

export async function getTaskPunchItems(taskId: string) {
    await assertScheduleTaskAccess(taskId);
    return prisma.taskPunchItem.findMany({
        where: { taskId },
        orderBy: { order: "asc" },
    });
}

// ========== TASK ASSIGNMENTS ==========

export async function assignUserToTask(taskId: string, userId: string) {
    const { projectId } = await assertScheduleTaskAccess(taskId);
    const assignment = await withTxRetry(() => prisma.$transaction(async tx => {
        await lockTaskAssignmentParent(tx, taskId, projectId);
        const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
        if (!user || user.status !== "ACTIVATED") throw new Error("Task crew members must be ACTIVATED users");
        const created = await tx.taskAssignment.create({
            data: { taskId, userId },
            include: { user: { select: { id: true, name: true, email: true } } },
        });
        await touchTaskAssignmentRevision(tx, taskId);
        return created;
    }));
    revalidatePath("/company-dashboard");
    revalidatePath(`/projects/${projectId}/schedule`);
    return assignment;
}

export async function unassignUserFromTask(taskId: string, userId: string) {
    const { projectId } = await assertScheduleTaskAccess(taskId);
    await withTxRetry(() => prisma.$transaction(async tx => {
        await lockTaskAssignmentParent(tx, taskId, projectId);
        const deleted = await tx.taskAssignment.deleteMany({
            where: { taskId, userId },
        });
        if (deleted.count > 0) await touchTaskAssignmentRevision(tx, taskId);
    }));
    revalidatePath("/company-dashboard");
    revalidatePath(`/projects/${projectId}/schedule`);
}

export async function setTaskLead(taskId: string, userId: string | null) {
    const { user, projectId } = await assertScheduleTaskAccess(taskId);
    const assignments = await withTxRetry(() => prisma.$transaction(tx =>
        setTaskLeadInTransaction(
            tx,
            taskId,
            userId,
            { type: "TEAM", name: user.name || user.email },
            projectId,
        ),
    ));
    revalidatePath("/company-dashboard");
    revalidatePath(`/projects/${projectId}/schedule`);
    return assignments;
}
export async function assignSubToTask(taskId: string, subcontractorId: string) {
    await assertScheduleTaskAccess(taskId);
    const assignment = await prisma.subTaskAssignment.create({
        data: { taskId, subcontractorId },
        include: { subcontractor: { select: { id: true, companyName: true, email: true, trade: true } } },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: taskId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
    return assignment;
}

export async function unassignSubFromTask(taskId: string, subcontractorId: string) {
    await assertScheduleTaskAccess(taskId);
    await prisma.subTaskAssignment.deleteMany({
        where: { taskId, subcontractorId },
    });
    const task = await prisma.scheduleTask.findUnique({ where: { id: taskId } });
    if (task) revalidatePath(`/projects/${task.projectId}/schedule`);
}

// ========== AI PUNCHLIST ==========

export async function aiGeneratePunchlist(taskId: string) {
    await assertScheduleTaskAccess(taskId);
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

    const items: string[] = JSON.parse(rawText);
    if (!Array.isArray(items)) throw new Error("Invalid AI response");

    // One transaction so a mid-loop failure cannot leave a partial punch list,
    // and the task lock serializes `order` with concurrent punch-item writers.
    const created = await withTxRetry(() => prisma.$transaction(
        tx => appendPunchItemsInTransaction(tx, taskId, items),
        { maxWait: 10000, timeout: 30000 },
    ));
    return created;
}

export async function aiGenerateSchedule(projectId: string, estimateId?: string) {
    await assertScheduleProjectAccess(projectId);
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error("Project not found");

    let estimateContext = "";
    if (estimateId) {
        const estimate = await prisma.estimate.findFirst({
            where: { id: estimateId, projectId },
            include: { items: { where: { parentId: null }, orderBy: { order: "asc" }, include: { subItems: true } } },
        });
        if (!estimate) throw new Error("Estimate not found on this project");
        estimateContext = `\n\nESTIMATE LINE ITEMS:\n${estimate.items.map(i => {
            const laborHrs = i.subItems?.filter((s: any) => s.type === "Labor").reduce((a: number, s: any) => a + (s.quantity || 0), 0) || (i.type === "Labor" ? i.quantity : 0);
            return `- ${i.name} (Type: ${i.type}, Labor Hours: ${laborHrs || "N/A"})`;
        }).join("\n")}`;
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

    const parsed: unknown = JSON.parse(rawText);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 40) throw new Error("Invalid AI response");

    // The model's output is untrusted input: bound every field before it reaches
    // the database. Dependencies may only point backward (matches the prompt),
    // which also rules out self-references, cycles, and forward references; the
    // Set dedupe keeps the (predecessorId, dependentId) unique constraint safe.
    const aiTasks = parsed.map((raw, i) => {
        const t = (raw ?? {}) as { name?: unknown; durationDays?: unknown; estimatedHours?: unknown; dependsOn?: unknown };
        // Strip NUL bytes — they pass string checks but PostgreSQL rejects them.
        const name = typeof t.name === "string" ? t.name.replace(/\u0000/g, "").trim().slice(0, 200) : "";
        if (!name) throw new Error("Invalid AI response");
        const durationDays = typeof t.durationDays === "number" && Number.isFinite(t.durationDays) && t.durationDays >= 1
            ? Math.min(Math.round(t.durationDays), 90)
            : 5;
        const estimatedHours = typeof t.estimatedHours === "number" && Number.isFinite(t.estimatedHours) && t.estimatedHours > 0
            ? Math.min(t.estimatedHours, 10000)
            : null;
        const dependsOn = [...new Set(
            (Array.isArray(t.dependsOn) ? t.dependsOn : []).filter((d): d is number => Number.isInteger(d) && d >= 0 && d < i)
        )];
        return { name, durationDays, estimatedHours, dependsOn };
    });

    const COLORS = ["#4c9a2a", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#ec4899", "#06b6d4", "#64748b"];
    const today = new Date();

    // All writes happen in one transaction so a mid-loop failure cannot leave a
    // partial schedule behind, and the project lock serializes `order` with the
    // other schedule writers (same pattern as clearAllTasks).
    const created = await withTxRetry(() => prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
        const maxOrder = await tx.scheduleTask.aggregate({ where: { projectId }, _max: { order: true } });
        let order = (maxOrder._max.order ?? -1) + 1;

        const createdIds: string[] = [];
        const createdTasks = [];
        let dayOffset = 0;

        for (let i = 0; i < aiTasks.length; i++) {
            const t = aiTasks[i];
            const startDate = new Date(today.getTime() + dayOffset * 86400000);
            const endDate = new Date(today.getTime() + (dayOffset + (t.durationDays || 5)) * 86400000);
            dayOffset += Math.ceil((t.durationDays || 5) * 0.7);

            const task = await tx.scheduleTask.create({
                data: {
                    projectId,
                    name: t.name,
                    startDate,
                    endDate,
                    color: getDefaultColorForTaskName(t.name) || COLORS[i % COLORS.length],
                    order: order++,
                    status: "Not Started",
                    estimatedHours: t.estimatedHours || null,
                },
            });
            createdIds.push(task.id);
            createdTasks.push(task);
        }

        // Create dependencies
        for (let i = 0; i < aiTasks.length; i++) {
            for (const depIdx of (aiTasks[i].dependsOn || [])) {
                if (depIdx >= 0 && depIdx < createdIds.length && depIdx !== i) {
                    await tx.taskDependency.create({
                        data: { predecessorId: createdIds[depIdx], dependentId: createdIds[i] },
                    });
                }
            }
        }

        return createdTasks;
    }, { maxWait: 10000, timeout: 30000 }));

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

export async function getScheduleCrewMembers() {
    const user = await assertActiveStaff();
    if (!hasPermission(user, "schedules")) throw new Error("Forbidden");
    return prisma.user.findMany({
        where: { status: "ACTIVATED", role: "FIELD_CREW" },
        orderBy: { name: "asc" },
        select: { id: true, name: true, email: true },
    });
}

export async function clearAllTasks(projectId: string) {
    await assertScheduleProjectAccess(projectId);
    await withTxRetry(() => prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
        const taskRows = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id"
            FROM "ScheduleTask"
            WHERE "projectId" = ${projectId}
            ORDER BY "id"
            FOR UPDATE
        `;
        const taskIds = taskRows.map(task => task.id);
        if (taskIds.length === 0) return;
        const assignedTaskIds = (await tx.taskAssignment.findMany({
            where: { taskId: { in: taskIds } },
            distinct: ["taskId"],
            select: { taskId: true },
        })).map(row => row.taskId);
        await tx.taskAssignment.deleteMany({ where: { taskId: { in: taskIds } } });
        if (assignedTaskIds.length > 0) {
            await tx.scheduleTask.updateMany({
                where: { id: { in: assignedTaskIds } },
                data: { updatedAt: new Date() },
            });
        }
        await tx.taskComment.deleteMany({ where: { taskId: { in: taskIds } } });
    }));
    revalidatePath("/company-dashboard");
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

// Company-board authorization adapter only. updateScheduleTask remains the
// single validation, locking, mutation, audit, and revalidation capability.
export async function updateCompanyScheduleTaskDatesAction(taskId: string, dates: {
    startDate: string;
    endDate: string;
}) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    return updateScheduleTask(taskId, dates);
}

export async function updateProjectStatus(projectId: string, status: string) {
    await assertActiveStaff();
    await prisma.project.update({
        where: { id: projectId },
        data: { status }
    });
    // "All field crew and CJ auto added" to jobs being worked. Post-response
    // via after() and fail-soft inside the helper, so it can never block the
    // status save (same pattern as autoAssignPhasesForEstimate above).
    const { autoAssignCrewOnStatusChange } = await import("@/lib/crew-auto-assign-sync");
    after(() => autoAssignCrewOnStatusChange(projectId, status));
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`);
    return { success: true };
}

// Move a project's company-level start date from the dashboard's waiting-to-start
// table. Thin wrapper over schedule-core (which owns the shift rules + ActivityLog);
// ADMIN/MANAGER only, same inline role check as the other project actions.
export async function updateProjectStartDateAction(projectId: string, startDateISO: string | null, shiftJobTasks: boolean) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true, name: true, email: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    const result = await setProjectStartDate({
        projectId,
        startDate: startDateISO ? parseStartDateInput(startDateISO) : null,
        shiftJobTasks,
        actor: { type: "TEAM", name: caller.name || caller.email },
    });
    revalidatePath("/company-dashboard");
    revalidatePath("/projects");
    return result;
}

// Set (or clear) a project's target end date — an IMMEDIATE write, unlike
// task/project START dates on the company board, which route through the
// draft-mode system (see ScheduleBoard.tsx). ADMIN/MANAGER only, same gate
// pattern as updateProjectStartDateAction.
//
// Project.endDate feeds getEffectiveProjectRange (bar rendering, see
// useBarLayout.ts) AND effectiveWorkEnd (schedule-core.ts — CO placement +
// the project-window conflict rule) via the same raw value — moving it
// changes where future CO blocks land. That's intentional, not a bug.
export async function updateProjectEndDateAction(projectId: string, endDateISO: string | null) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true, name: true, email: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");

    const endDate = endDateISO ? parseStartDateInput(endDateISO) : null;
    // Same lock family as setProjectStartDate: validate against the LOCKED
    // startDate so a concurrent start move can't slip past the invariant.
    const project = await withTxRetry(() => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
        const locked = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true, name: true, startDate: true, endDate: true },
        });
        if (!locked) throw new Error("Project not found");
        if (endDate && locked.startDate && endDate.getTime() <= locked.startDate.getTime()) {
            throw new Error("End date must be after the project's start date");
        }
        await tx.project.update({ where: { id: projectId }, data: { endDate } });
        return locked;
    }));
    await prisma.activityLog.create({
        data: {
            projectId,
            actorType: "TEAM",
            actorName: caller.name || caller.email,
            action: "set_project_end_date",
            entityType: "project",
            entityId: projectId,
            entityName: project.name,
            metadata: JSON.stringify({
                previousEndDate: project.endDate ? project.endDate.toISOString() : null,
                endDate: endDate ? endDate.toISOString() : null,
            }),
        },
    });
    revalidatePath("/company-dashboard");
    revalidatePath("/projects");
    return { projectId, endDate: endDate ? endDate.toISOString() : null };
}

// Shift unfinished work on an active project without moving its company-level
// start marker or any payment milestone. ADMIN/MANAGER only.
export async function shiftNotStartedTasksAction(projectId: string, deltaDays: number): Promise<ShiftNotStartedTasksResult> {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true, name: true, email: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    const result = await shiftNotStartedTasks({
        projectId,
        deltaDays,
        actor: { type: "TEAM", name: caller.name || caller.email },
    });
    revalidatePath("/company-dashboard");
    revalidatePath("/projects");
    return result;
}

// Generate a project's schedule from its most recent qualifying estimate
// (the same deterministic selection contractValue uses). ADMIN/MANAGER only.
export async function generateProjectScheduleAction(projectId: string) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true, name: true, email: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");

    const estimate = await prisma.estimate.findFirst({
        ...canonicalContractEstimateQuery(projectId),
        select: { id: true },
    });
    if (!estimate) throw new Error("No Approved, Invoiced, Partially Paid, or Paid estimate on this project yet — approve an estimate first.");

    const result = await generateScheduleFromEstimate({
        estimateId: estimate.id,
        mode: "merge",
        requireEmptyProject: true,
        actor: { type: "TEAM", name: caller.name || caller.email },
    });
    revalidatePath("/company-dashboard");
    revalidatePath(`/projects/${projectId}/schedule`);
    return result;
}

// Replace a project's crew from the dashboard picker. ADMIN/MANAGER only;
// the core validates every id is an ACTIVATED user.
export async function updateProjectCrewAction(projectId: string, userIds: string[]) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true, name: true, email: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    const result = await setProjectCrew({
        projectId,
        userIds,
        actor: { type: "TEAM", name: caller.name || caller.email },
    });
    revalidatePath("/company-dashboard");
    return result;
}

export async function applyChangeOrderToScheduleAction(changeOrderId: string, mode: "merge" | "regenerate" = "merge") {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true, name: true, email: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    const result = await applyChangeOrderToSchedule({
        changeOrderId,
        mode,
        actor: { type: "TEAM", name: caller.name || caller.email },
    });
    revalidatePath("/company-dashboard");
    revalidatePath(`/projects/${result.projectId}/schedule`);
    return result;
}

export async function updateTaskCrewAction(taskId: string, userIds: string[]) {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true, name: true, email: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    const result = await setTaskCrew({
        taskId,
        userIds,
        actor: { type: "TEAM", name: caller.name || caller.email },
    });
    revalidatePath("/company-dashboard");
    revalidatePath(`/projects/${result.projectId}/schedule`);
    return result;
}

export interface SaveCompanyScheduleTaskDatesInput {
    taskId: string;
    startDate: string; // YYYY-MM-DD
    endDate: string;   // YYYY-MM-DD
}

export interface PublishDispatchActionInput {
    clientRequestId: string;
    intents: DispatchIntent[];
    dryRun?: boolean;
}

export async function publishDispatchAction(
    input: PublishDispatchActionInput,
): Promise<PublishDispatchResult> {
    // Same session helper as every other hardened schedule mutation — the
    // dev fallback only exists under NODE_ENV=development.
    const session = await getSessionOrDev();
    const caller = session?.user?.email
        ? await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true, role: true, status: true, name: true, email: true },
        })
        : null;
    if (!caller || caller.status !== "ACTIVATED" || !["ADMIN", "MANAGER"].includes(caller.role)) {
        return {
            ok: false,
            code: "FORBIDDEN",
            message: "You do not have permission to queue a dispatch.",
            conflicts: [],
        };
    }

    return publishDispatch({
        clientRequestId: input.clientRequestId,
        intents: input.intents,
        dryRun: input.dryRun,
        actor: {
            userId: caller.id,
            name: caller.name || caller.email,
        },
    }).then(result => {
        if (result.ok && result.publicationId) {
            revalidatePath("/company-dashboard");
        }
        return result;
    }).catch(error => {
        console.error("Dispatch publication failed", error);
        return {
            ok: false as const,
            code: "DISPATCH_FAILED" as const,
            message: "Nothing was queued. Please try again with the same review.",
            conflicts: [],
        };
    });
}

export interface SaveCompanyScheduleTaskDateResult {
    taskId: string;
    ok: boolean;
    startDate?: string;
    endDate?: string;
    error?: string;
}

export interface SaveCompanyScheduleTaskDatesResult {
    results: SaveCompanyScheduleTaskDateResult[];
    succeeded: number;
    failed: number;
}

// Commit the company schedule board's draft-mode edits in one batch. ADMIN/
// MANAGER only, same gate as the other dashboard batch actions. Loops the
// canonical updateScheduleTask per task — deliberately NOT a second mutation
// core — so every existing lock/validation/ActivityLog path applies
// unchanged. One task's failure never blocks the rest: each change is applied
// independently and reported in `results`, so the client can clear succeeded
// drafts and keep failed ones pending for retry.
export async function saveCompanyScheduleTaskDatesAction(
    changes: SaveCompanyScheduleTaskDatesInput[],
): Promise<SaveCompanyScheduleTaskDatesResult> {
    const session = await getServerSession(authOptions);
    const caller = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true, name: true, email: true } })
        : null;
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) throw new Error("Forbidden");
    if (changes.length > 200) throw new Error("Too many schedule changes in one save (max 200) — save in smaller batches");
    // Deterministic dedupe: the LAST occurrence of a taskId wins and is applied
    // exactly once (no duplicate activity records or inflated success counts).
    const deduped = [...new Map(changes.map(change => [change.taskId, change])).values()];

    const results: SaveCompanyScheduleTaskDateResult[] = [];
    for (const change of deduped) {
        try {
            const task = await updateScheduleTask(change.taskId, {
                startDate: change.startDate,
                endDate: change.endDate,
            });
            results.push({
                taskId: change.taskId,
                ok: true,
                startDate: task.startDate.toISOString(),
                endDate: task.endDate.toISOString(),
            });
        } catch (err: any) {
            results.push({ taskId: change.taskId, ok: false, error: err?.message ?? String(err) });
        }
    }

    return {
        results,
        succeeded: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
    };
}

// PB-schedule-002 item 2: this action previously had NO auth check at all
// (not even assertActiveStaff) and, as of this change, no UI caller in the
// repo either — tightened to the same schedule-permission gate as the other
// per-project schedule mutations (deleteScheduleTask, reorderScheduleTasks,
// etc.) rather than the weaker assertActiveStaff, since the company
// schedule board's Color… menu item is schedules-scoped. The board's canEdit
// is ADMIN/MANAGER-only (schedule-core.ts), and both hasPermission and
// canAccessProject auto-pass ADMIN/MANAGER, so this is a no-op for that
// caller.
export async function updateProjectColor(projectId: string, color: string) {
    await assertScheduleProjectAccess(projectId);
    await prisma.project.update({
        where: { id: projectId },
        data: { color }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`);
    return { success: true };
}

export async function updateProjectTags(projectId: string, tags: string) {
    await assertProjectMemberStaff(projectId);
    await prisma.project.update({
        where: { id: projectId },
        data: { tags }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`);
    return { success: true };
}

export async function updateProjectType(projectId: string, type: string) {
    await assertProjectMemberStaff(projectId);
    const trimmed = type.trim();
    await prisma.project.update({
        where: { id: projectId },
        data: { type: trimmed || null }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`);
    return { success: true };
}

export async function updateProjectCode(projectId: string, code: string) {
    await assertProjectMemberStaff(projectId);
    const trimmed = code.trim();
    await prisma.project.update({
        where: { id: projectId },
        data: { code: trimmed || null }
    });
    revalidatePath(`/projects`);
    revalidatePath(`/projects/${projectId}`);
    return { success: true };
}

export async function updateProjectName(projectId: string, name: string) {
    await assertActiveStaff();
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
    const geo = await geocodeJobSiteAddress(location);
    await prisma.project.update({
        where: { id: projectId },
        data: {
            location: geo?.formattedAddress ?? (location || null),
            // Precise geocode also refreshes the time-clock geofence; clearing
            // the address clears it; coarse/failed lookups leave it alone.
            ...(geo?.lat != null && geo?.lng != null
                ? { locationLat: geo.lat, locationLng: geo.lng }
                : !location ? { locationLat: null, locationLng: null } : {}),
        }
    });
    revalidatePath(`/projects/${projectId}`, 'layout');
    return { success: true };
}

// ── Percent complete (Phase 4) ───────────────────────────────────────────────
// Money-path-INERT on purpose: percent complete drives an internal management
// number (earned revenue / earned margin) and nothing else. It notifies nobody,
// is never shown in the client portal, and touches no invoice, milestone or
// payment. Do not grow a notifier here.
//
// ADMIN/MANAGER only. This is the number the owner and the PM adjust when the
// automatic estimate is wrong; a field-crew account sees the card read-only.

/** Shared gate for both percent-complete writes. */
async function assertPercentCompleteEditor() {
    const user = await assertActiveStaff();
    if (!isAdminOrManager(user)) throw new Error("Forbidden");
    return user;
}

/**
 * Override a project's percent complete by hand.
 *
 * Snapshots the CURRENT auto value into percentCompleteAutoAtOverride, which is
 * the baseline the >5-point drift flag compares against later. Without that
 * snapshot the flag would have to compare "auto now" to the manual value, and
 * would fire the instant anyone disagreed with the machine — which is the whole
 * purpose of an override.
 */
export async function updateProjectPercentComplete(projectId: string, value: number | string) {
    const user = await assertPercentCompleteEditor();

    const normalized = normalizePercentCompleteInput(value);
    if (normalized === null) throw new Error("Enter a percentage between 0 and 100");

    // The snapshot is taken COLUMN-TO-COLUMN inside the UPDATE
    // (percentCompleteAutoAtOverride = "percentCompleteAuto"), never from a
    // value read into JS first. The nightly recalc rewrites percentCompleteAuto
    // while this action is in flight, and a read-then-write here would freeze a
    // baseline the row no longer has — making the drift flag compare against a
    // number that was never current.
    const updated = await prisma.$executeRaw`
        UPDATE "Project" SET
            "percentComplete" = ${normalized}::numeric,
            "percentCompleteSource" = 'MANUAL'::"PercentCompleteSource",
            "percentCompleteAsOf" = ${new Date()}::timestamp(3),
            "percentCompleteAutoAtOverride" = "percentCompleteAuto",
            "percentCompleteUpdatedById" = ${user.id}
        WHERE "id" = ${projectId}`;
    if (updated === 0) throw new Error("Project not found");

    revalidatePath(`/projects/${projectId}/financial-overview`);
    revalidatePath(`/reports/company-financials`);
    return { success: true, percentComplete: normalized };
}

/**
 * Hand the number back to the nightly cron. Clears the override snapshot (so
 * nothing is left to drift against) and adopts whatever the machine last
 * computed — which may be null on a job the trust gate cannot measure.
 */
export async function resetProjectPercentCompleteToAuto(projectId: string) {
    await assertPercentCompleteEditor();

    // Adopts the column's CURRENT auto value in the UPDATE itself, for the same
    // reason as the override above: a stale JS copy could resurrect an auto
    // value the nightly recalc has already replaced.
    const rows = await prisma.$queryRaw<Array<{ percentComplete: unknown }>>`
        UPDATE "Project" SET
            "percentComplete" = "percentCompleteAuto",
            "percentCompleteSource" = 'AUTO'::"PercentCompleteSource",
            "percentCompleteAsOf" = ${new Date()}::timestamp(3),
            "percentCompleteAutoAtOverride" = NULL,
            "percentCompleteUpdatedById" = NULL
        WHERE "id" = ${projectId}
        RETURNING "percentComplete"`;
    if (rows.length === 0) throw new Error("Project not found");

    revalidatePath(`/projects/${projectId}/financial-overview`);
    revalidatePath(`/reports/company-financials`);
    return { success: true, percentComplete: rows[0].percentComplete == null ? null : Number(rows[0].percentComplete) };
}

export async function deleteProjects(projectIds: string[]) {
    await assertActiveStaff();
    await prisma.project.deleteMany({
        where: { id: { in: projectIds } }
    });
    revalidatePath(`/projects`);
    return { success: true };
}

export async function updateCompanyProjectStatuses(statuses: string) {
    await assertCompanySettingsPermission();
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
    // Hardened (dispatch-arc foundation): only ADMIN/MANAGER sessions may change client schedule visibility.
    const session = await getSessionOrDev();
    const role = ((session?.user as any)?.role as string | null) ?? null;
    if (!role || !["ADMIN", "MANAGER"].includes(role)) throw new Error("Forbidden");
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
            showPermits: true,
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
    showPermits?: boolean;
    isPortalEnabled: boolean;
}) {
    await assertProjectMemberStaff(projectId);
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
            showPermits: data.showPermits ?? true,
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
            showPermits: data.showPermits ?? true,
            isPortalEnabled: data.isPortalEnabled,
        },
    });
    revalidatePath(`/projects/${projectId}/settings`);
    revalidatePath(`/portal/projects/${projectId}`);
    return { success: true };
}

export async function setPaymentRemindersEnabled(projectId: string, enabled: boolean) {
    const user = await getCurrentUserWithPermissions();
    if (!user) return { success: false, error: "Unauthorized" };
    if (!hasPermission(user, "invoices")) return { success: false, error: "Forbidden" };
    if (!canAccessProject(user, projectId)) return { success: false, error: "Forbidden" };

    await prisma.project.update({
        where: { id: projectId },
        data: { paymentRemindersEnabled: enabled },
    });
    revalidatePath(`/projects/${projectId}/client-portal`);
    revalidatePath(`/projects/${projectId}/settings`);
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
    
    const { buildClientPortalUrl } = await import("./client-portal-auth");
    const portalUrl = await buildClientPortalUrl(project.client.id, project.client.email, `/portal/projects/${projectId}`);

    const companySettings = await getCachedCompanySettings();
    const companyName = companySettings?.companyName || "Your Contractor";
    const companyPhone = companySettings?.phone || "";

    // Welcome / how-to email. The same action powers resends, so the wording
    // has to read fine on a second delivery too — not first-visit-only.
    const { sendNotification } = await import('@/lib/email');
    const portalCc = buildCc(project.client.email, (project.client as any).additionalEmail);
    const welcomeItems = [
        ["Follow your project", "See the schedule, progress updates, and photos as work happens."],
        ["Review and approve", "Estimates and change orders come to you for review and online signature."],
        ["Pay securely online", "When a payment is requested, you can pay by card or bank transfer with one click. Only requested amounts are ever due."],
        ["Everything in one place", "Plans, documents, selections, and photos, available any time."],
    ].map(([title, text]) => `
        <tr>
            <td style="padding: 6px 0; vertical-align: top; width: 22px;"><span style="color: #059669; font-weight: 700;">&#10003;</span></td>
            <td style="padding: 6px 0; color: #444; font-size: 14px; line-height: 1.5;"><strong style="color: #111;">${title}.</strong> ${text}</td>
        </tr>`).join("");
    const result = await sendNotification(
        project.client.email,
        `Welcome to your ${project.name} project portal`,
        `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
            </div>
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">Your project portal is ready</h2>
                <p style="color: #666; margin: 0 0 20px;">Hi ${project.client.name || "there"},</p>
                <p style="color: #666; line-height: 1.6; margin: 0 0 16px;">
                    ${companyName} has set up a private online portal for <strong>${project.name}</strong>. It's your one place to stay on top of the project:
                </p>
                <table style="width: 100%; border-collapse: collapse; margin: 0 0 8px;">${welcomeItems}</table>
                <div style="text-align: center; margin: 28px 0;">
                    <a href="${portalUrl}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        Open Your Portal
                    </a>
                </div>
                <p style="color: #999; font-size: 13px; text-align: center; margin: 0 0 8px;">
                    The link signs you in automatically, so there is no password to remember. Bookmark it for easy access.
                </p>
                <p style="color: #999; font-size: 13px; text-align: center; margin: 0;">
                    If the link ever stops working, just reply to this email and we will send a fresh one.
                </p>
            </div>
            <p style="text-align: center; color: #aaa; font-size: 12px; margin-top: 32px;">
                ${companyName}${companyPhone ? ` &bull; ${companyPhone}` : ""}
            </p>
        </div>`,
        undefined,
        { cc: portalCc, copyToInternal: true }
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
    await assertCompanySettingsPermission();
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
    const user = await assertChangeOrderPermission();
    // Scope the destination project, then require the source estimate to be
    // that same project's. Unpaired, this copies an arbitrary estimate's priced
    // items into an arbitrary project.
    assertEstimateScope(user, { projectId });

    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId, projectId },
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
        // Section headers carry their children's rolled-up total, and ChangeOrderItem is flat,
        // so copying a header alongside its children would bill the section twice. Selecting a
        // header means "bill this whole phase" — it resolves to the leaves underneath it.
        const selectedItems = selectedBillableRows(estimate.items, itemIds);
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

// AI-suggested change orders: ONE transactional creation path used by the
// daily-logs "Create draft CO" flow. Deliberately self-contained (auth +
// estimate resolution + title/description all in one call) rather than a
// create-then-update pair — a two-call flow can leave an orphaned Draft CO
// if the second call fails, and would require trusting a client-held
// estimateId that could point at a different project's estimate.
export async function createSuggestedChangeOrder(
    projectId: string,
    data: { title: string; description?: string }
) {
    "use server";

    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "changeOrders")) throw new Error("Forbidden");
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");

    const title = data.title?.trim();
    if (!title) throw new Error("title is required");
    const description = data.description?.trim() || null;

    const changeOrder = await prisma.$transaction(async (tx) => {
        // Re-resolve the estimate server-side — never trust a client-held
        // estimateId. Only an Approved estimate qualifies; no "most recent"
        // fallback, since an unsigned estimate isn't a real base scope yet.
        const candidate = await tx.estimate.findFirst({
            where: { projectId, status: "Approved", archivedAt: null },
            select: { id: true },
            orderBy: { createdAt: "desc" },
        });
        if (!candidate) {
            throw new Error("This project has no approved estimate to attach a change order to — create one first.");
        }
        // Defense-in-depth: re-verify the resolved estimate still belongs to
        // exactly this project (id + projectId together) before creating the
        // CO — kills any cross-project pairing bug even if the resolution
        // query above is ever refactored to accept an id from elsewhere.
        const estimate = await tx.estimate.findFirst({
            where: { id: candidate.id, projectId },
            select: { id: true },
        });
        if (!estimate) {
            throw new Error("Estimate no longer belongs to this project — try again.");
        }

        const created = await tx.changeOrder.create({
            data: {
                title,
                description,
                projectId,
                estimateId: estimate.id,
                code: "CO-TEMP",
                status: "Draft",
            },
        });
        return tx.changeOrder.update({
            where: { id: created.id },
            data: { code: `CO-${String(created.number).padStart(5, "0")}` },
        });
    });

    revalidatePath(`/projects/${projectId}/change-orders`);
    return { id: changeOrder.id, code: changeOrder.code };
}

export async function getChangeOrders(projectId: string) {
    const user = await assertChangeOrderPermission();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
    return await prisma.changeOrder.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        include: { estimate: { select: { title: true, code: true } } }
    });
}

export async function getChangeOrder(id: string) {
    const user = await assertChangeOrderPermission();
    const target = await prisma.changeOrder.findUnique({ where: { id }, select: { projectId: true } });
    if (!target || !canAccessProject(user, target.projectId)) return null;
    return await prisma.changeOrder.findUnique({
        where: { id },
        include: {
            project: { include: { client: true } },
            estimate: { select: { title: true, code: true, taxExempt: true, taxRatePercent: true, taxRateName: true } },
            items: { orderBy: { order: "asc" } },
            paymentSchedules: { orderBy: { order: "asc" } },
            timeEntries: { include: { user: { select: { name: true, email: true } } }, orderBy: { startTime: "desc" } },
            expenses: { orderBy: { createdAt: "desc" } },
            billings: { include: { paymentSchedule: { select: { id: true, name: true, amount: true, status: true } } }, orderBy: { createdAt: "desc" } },
        }
    });
}

export async function getChangeOrderForPortal(id: string) {
    "use server";
    // Staff (ADMIN/MANAGER) may preview any change order — mirrors getInvoiceForPortal.
    const staffSession = await getServerSession(authOptions);
    const isStaff = ["ADMIN", "MANAGER"].includes((staffSession?.user as any)?.role);

    // IDOR-4 fix: portal clients are gated by their session's clientId
    let clientFilter = {};
    let lifecycleFilter = {};
    if (!isStaff) {
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) return null;
        clientFilter = { project: { clientId: sessionClientId } };
        // Draft includes never-sent and invalidated-after-edit versions. A
        // leaked/stale portal URL must not expose either to the client.
        lifecycleFilter = { status: { in: ["Sent", "Approved", "Declined"] } };
    }

    return await prisma.changeOrder.findFirst({
        where: {
            id,
            ...clientFilter,
            ...lifecycleFilter,
        },
        include: {
            project: { include: { client: true } },
            estimate: { select: { title: true, code: true, taxExempt: true, taxRatePercent: true, taxRateName: true } },
            items: { orderBy: { order: "asc" } },
            paymentSchedules: { orderBy: { order: "asc" } }
        }
    });
}

export async function updateChangeOrder(id: string, data: ChangeOrderUpdateInput) {
    "use server";
    // Money-path: this is a remotely invokable server action — gate it like
    // sendChangeOrderToClient and whitelist fields so callers can't write
    // approval/signature/audit columns or arbitrary amounts.
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "changeOrders")) throw new Error("Forbidden");
    const target = await prisma.changeOrder.findUnique({ where: { id }, select: { projectId: true } });
    if (!target) throw new Error("Change order not found");
    if (!canAccessProject(user, target.projectId)) throw new Error("Forbidden");

    const co = await updateChangeOrderCore(id, data);

    revalidatePath(`/projects/${co.projectId}/change-orders/${id}`);
    revalidatePath(`/projects/${co.projectId}/change-orders`);
    // totalAmount/balanceDue are Prisma Decimals — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(co));
}

export async function previewCostPlusChangeOrder(changeOrderId: string, throughDate: string) {
    const user = await assertChangeOrderPermission();
    const target = await prisma.changeOrder.findUnique({ where: { id: changeOrderId }, select: { projectId: true } });
    if (!target || !canAccessProject(user, target.projectId)) throw new Error("Forbidden");
    const { previewCostPlusChangeOrderCore } = await import("./billing-core");
    return previewCostPlusChangeOrderCore(changeOrderId, { throughDate });
}

export async function billCostPlusChangeOrder(
    changeOrderId: string,
    throughDate: string,
    expectedFingerprint: string,
    expectedInvoiceId?: string,
    expectedMarkupPercent?: number,
    expectedTaxRate?: number,
) {
    const user = await assertChangeOrderPermission();
    const target = await prisma.changeOrder.findUnique({ where: { id: changeOrderId }, select: { projectId: true } });
    if (!target || !canAccessProject(user, target.projectId)) throw new Error("Forbidden");
    const { billCostPlusChangeOrderCore } = await import("./billing-core");
    const result = await billCostPlusChangeOrderCore(changeOrderId, {
        throughDate,
        expectedFingerprint,
        expectedInvoiceId,
        expectedMarkupPercent,
        expectedTaxRate,
        actor: user.name || user.email,
    });
    revalidatePath(`/projects/${target.projectId}/change-orders/${changeOrderId}`);
    revalidatePath(`/projects/${target.projectId}/invoices/${result.invoiceId}`);
    return result;
}

export async function deleteChangeOrder(id: string) {
    const user = await assertChangeOrderPermission();
    const target = await prisma.changeOrder.findUnique({ where: { id }, select: { projectId: true } });
    if (!target) return;
    if (!canAccessProject(user, target.projectId)) throw new Error("Forbidden");

    const co = await deleteChangeOrderCore(id);
    if (!co) return;
    revalidatePath(`/projects/${co.projectId}/change-orders`);
}

// updateChangeOrderStatus was removed: it had no callers and, as an unauthenticated
// remotely-invokable server action, let anyone flip CO statuses — bypassing both the
// signature flow and the approval automation. Rebuild with auth + the approval hook
// if a raw status setter is ever actually needed.

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

    const normalizedSignatureName = signatureName.trim();
    if (!normalizedSignatureName) throw new Error("Your full legal name is required");
    if (!signatureDataUrl) throw new Error("A drawn signature is required");

    const approvedAt = new Date();
    const approval = await approveChangeOrderWithSignature(id, {
        signatureName: normalizedSignatureName,
        signatureDataUrl,
        approvedAt,
    });
    if (!approval) return null;
    const { co, transitioned } = approval;

    // Exactly-once post-approval automation: bill the CO onto the invoice and send
    // the payment link (the signature on the exact amount is the approval), with a
    // team notification either way. Scheduled AFTER the response so the customer's
    // signing screen never waits on QuickBooks; falls back to inline best-effort
    // outside a request context.
    if (transitioned) {
        const runAutomation = async () => {
            try {
                const { handleChangeOrderApproved } = await import("./billing-core");
                await handleChangeOrderApproved(id, { freshlyApproved: true });
            } catch (err) {
                console.error("[approveChangeOrder] post-approval automation failed:", err);
            }
        };
        try {
            after(runAutomation);
        } catch {
            await runAutomation();
        }
    }

    revalidatePath(`/projects/${co.projectId}/change-orders/${id}`);
    revalidatePath(`/projects/${co.projectId}/change-orders`);
    // totalAmount/balanceDue are Prisma Decimals — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(co));
}

// Company-side countersignature. Distinct from approveChangeOrder (the customer's
// approval) so that signing on behalf of the company NEVER overwrites the client's
// approvedBy/approvedAt/clientSignatureUrl audit trail. Writes ONLY company fields
// and leaves status untouched (the customer's approval still drives Approved).
// Auth mirrors signContractAsContractor; signatureDataUrl is optional because the
// editor's "Sign Now" flow captures a typed name rather than a drawn signature.
export async function countersignChangeOrderAsCompany(id: string, signerName: string, signatureDataUrl?: string) {
    "use server";
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Not authenticated");

    // Role gate — only ADMIN/MANAGER can countersign on behalf of the company.
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } });
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER")) throw new Error("Forbidden");

    if (!signerName.trim()) throw new Error("Signer name is required");

    // Validate the data URL is a safe image type before storing (only when provided).
    if (signatureDataUrl && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(signatureDataUrl)) {
        throw new Error("Invalid signature format");
    }

    // Verify the change order exists (clear 404-style error) and grab projectId for revalidation.
    const existing = await prisma.changeOrder.findUnique({ where: { id }, select: { id: true, projectId: true, status: true } });
    if (!existing) throw new Error("Change order not found");
    if (existing.status !== "Sent" && existing.status !== "Approved") {
        throw new Error("Change order must be Sent before it can be countersigned");
    }

    // Move the signature image into Storage (avoids the PgBouncer pooler message-size
    // error on large data-URLs); falls back to the data-URL when Storage isn't configured.
    const ownedCompanySignature = await persistOwnedSignature(signatureDataUrl, `change-orders/${id}/company`);
    const companySignatureUrl = ownedCompanySignature.url;
    const discardCompanySignature = async () => {
        try {
            await ownedCompanySignature.discard();
        } catch (error) {
            try {
                console.error("[countersignChangeOrderAsCompany] signature cleanup failed", error);
            } catch {
                // Logging must never replace the caller's primary error.
            }
        }
    };

    // Atomic idempotency guard — updateMany only matches rows where companySignedAt IS NULL,
    // so two concurrent requests can't both succeed (eliminates TOCTOU race).
    let result;
    try {
        result = await prisma.changeOrder.updateMany({
            where: { id, companySignedAt: null, status: { in: ["Sent", "Approved"] } },
            data: {
                companySignedBy: signerName.trim(),
                companySignedAt: new Date(),
                companySignatureUrl,
            },
        });
    } catch (error) {
        // Ambiguous outcome (could be a genuine failed write, or a PgBouncer connection
        // drop after commit) — probe before deleting. See discardSignatureUnlessReferenced.
        await discardSignatureUnlessReferenced(
            companySignatureUrl,
            discardCompanySignature,
            async () => {
                const hit = await prisma.changeOrder.findFirst({ where: { id, companySignatureUrl }, select: { id: true } });
                return !!hit;
            },
            "countersignChangeOrderAsCompany",
        );
        throw error;
    }
    if (result.count === 0) {
        // Deterministic: the updateMany itself reported zero rows matched — this upload
        // never landed anywhere.
        await discardCompanySignature();
        throw new Error("Change order already countersigned by company");
    }

    revalidatePath(`/projects/${existing.projectId}/change-orders/${id}`);
    revalidatePath(`/projects/${existing.projectId}/change-orders`);
    return { success: true };
}

export async function sendChangeOrderToClient(changeOrderId: string): Promise<{ success: true; sentTo: string } | { success: false; error: string }> {
    "use server";
    // Customer-facing send from the UI — require the changeOrders permission
    // (this export is a remotely invokable server action). Core logic lives in
    // billing-core.ts so the shared-secret-gated MCP connector can reuse it.
    const user = await getCurrentUserWithPermissions();
    if (!user) return { success: false, error: "Unauthorized" };
    if (!hasPermission(user, "changeOrders")) return { success: false, error: "Forbidden" };
    const target = await prisma.changeOrder.findUnique({ where: { id: changeOrderId }, select: { projectId: true } });
    if (!target) return { success: false, error: "Change order not found" };
    if (!canAccessProject(user, target.projectId)) return { success: false, error: "Forbidden" };
    const { sendChangeOrderToClientCore } = await import("./billing-core");
    return sendChangeOrderToClientCore(changeOrderId);
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
    // Vendor rows carry EIN, account numbers, contacts and file URLs — this was
    // reachable unauthenticated. The PO-flow modals need it too, so gate on
    // active staff and let the two write permissions stay narrower.
    await assertVendorCreatePermission();
    return prisma.vendor.findMany({
        orderBy: { name: "asc" },
        include: { tags: true, files: true, _count: { select: { purchaseOrders: true } } }
    });
}

// Vendor columns a caller is allowed to write. Anything not listed here — most
// importantly the `purchaseOrders` relation — is dropped. Spreading the raw
// payload into Prisma let a caller pass nested relation writes such as
// { purchaseOrders: { deleteMany: {} } }, which deletes POs directly and so
// never trips the vendor FK's ON DELETE RESTRICT or deletePurchaseOrder's checks.
const VENDOR_WRITABLE_FIELDS = [
    "name", "website", "description", "firstName", "lastName", "email", "phone",
    "fax", "address1", "address2", "city", "state", "zipCode", "country",
    "paymentTerms", "chargesTax", "accountNumber", "ein", "notes", "status",
] as const;

function pickVendorFields(data: any) {
    const out: Record<string, any> = {};
    for (const key of VENDOR_WRITABLE_FIELDS) {
        if (data?.[key] !== undefined) out[key] = data[key];
    }
    return out;
}

// Same reasoning for vendor files — map the scalars explicitly rather than
// handing Prisma a caller-shaped object.
function pickVendorFiles(files: any[]) {
    return files.map((f: any) => ({
        name: f.name,
        url: f.url,
        size: f.size,
        type: f.type,
    }));
}

// Free-text trade labels ("Supplier, Lumber") normalised into VendorTag names.
// Tags are how the vendors list filters, so a trade typed during inline vendor
// creation belongs here rather than buried in a text column.
const MAX_TAG_NAME_LENGTH = 40;
const MAX_NEW_TAGS = 10;

function parseTagNames(tagNames: any): string[] {
    if (!tagNames) return [];
    const raw = Array.isArray(tagNames) ? tagNames : [tagNames];
    const seen = new Set<string>();
    for (const entry of raw) {
        if (typeof entry !== "string") continue;
        for (const part of entry.split(",")) {
            const name = part.trim().slice(0, MAX_TAG_NAME_LENGTH);
            if (name) seen.add(name);
            if (seen.size >= MAX_NEW_TAGS) return [...seen];
        }
    }
    return [...seen];
}

export async function createVendor(data: any) {
    "use server";
    await assertVendorCreatePermission();
    const { tagIds, tagNames, files } = data ?? {};
    const newTagNames = parseTagNames(tagNames);

    // name is the one required Vendor column — the allowlist above can't prove
    // to the type system that it survived, so check it rather than cast it away.
    const fields = pickVendorFields(data);
    const name = typeof fields.name === "string" ? fields.name.trim() : "";
    if (!name) {
        // status lets the API route answer 400 without matching on the message.
        const err: any = new Error("Vendor name is required");
        err.status = 400;
        throw err;
    }

    const tagWrite = {
        ...(tagIds?.length ? { connect: tagIds.map((id: string) => ({ id })) } : {}),
        // connectOrCreate so an existing trade tag is reused rather than
        // colliding on VendorTag.name's unique constraint.
        ...(newTagNames.length
            ? { connectOrCreate: newTagNames.map(tagName => ({ where: { name: tagName }, create: { name: tagName } })) }
            : {}),
    };

    const createArgs = {
        data: {
            ...fields,
            name,
            ...(Object.keys(tagWrite).length ? { tags: tagWrite } : {}),
            ...(files?.length ? { files: { create: pickVendorFiles(files) } } : {}),
        },
        include: { tags: true, files: true, _count: { select: { purchaseOrders: true } } }
    };

    let v;
    try {
        v = await prisma.vendor.create(createArgs);
    } catch (error: any) {
        // connectOrCreate is a check-then-create, so two vendors naming the same
        // new tag at once can race and one loses on VendorTag.name. The retry
        // finds the tag the winner just created and connects to it instead.
        const rawTarget = error?.meta?.target;
        const targets: string[] = Array.isArray(rawTarget)
            ? rawTarget.map(String)
            : rawTarget ? [String(rawTarget)] : [];
        const isTagNameRace = error?.code === "P2002"
            && targets.includes("name")
            && newTagNames.length > 0;
        if (!isTagNameRace) throw error;
        v = await prisma.vendor.create(createArgs);
    }

    revalidatePath("/company/vendors");
    return v;
}

export async function updateVendor(id: string, data: any) {
    "use server";
    await assertVendorPermission();
    const { tagIds, files } = data ?? {};

    const v = await prisma.vendor.update({
        where: { id },
        data: {
            ...pickVendorFields(data),
            tags: tagIds ? { set: tagIds.map((id: string) => ({ id })) } : undefined,
        }
    });

    if (files && files.length > 0) {
        await prisma.vendorFile.createMany({
            data: pickVendorFiles(files).map(f => ({ ...f, vendorId: id }))
        });
    }

    revalidatePath("/company/vendors");
    return v;
}

export async function deleteVendor(id: string) {
    "use server";
    await assertVendorPermission();

    // Purchase orders are financial records — a vendor that still has any must
    // not be deletable. The FK is ON DELETE RESTRICT, so the database is the
    // real guard; the count here only turns that into a message naming how many
    // POs are in the way. The two are not atomic, hence the P2003 catch below.
    //
    // This returns a result rather than throwing, because a production Next
    // build redacts thrown Server Function messages — a throw would reach the
    // user as a generic error with the count stripped out. Authorization still
    // throws: being denied is not an expected outcome worth rendering.
    const poCount = await prisma.purchaseOrder.count({ where: { vendorId: id } });
    if (poCount > 0) {
        return { ok: false as const, reason: "HAS_PURCHASE_ORDERS" as const, count: poCount };
    }

    try {
        await prisma.vendor.delete({ where: { id } });
    } catch (error: any) {
        // P2003 = FK constraint failure, i.e. a PO was attached between the
        // count above and this delete.
        if (error?.code === "P2003") {
            const recount = await prisma.purchaseOrder.count({ where: { vendorId: id } });
            return { ok: false as const, reason: "HAS_PURCHASE_ORDERS" as const, count: recount };
        }
        throw error;
    }

    revalidatePath("/company/vendors");
    return { ok: true as const };
}

export async function deleteVendorFile(id: string) {
    "use server";
    await assertVendorPermission();
    await prisma.vendorFile.delete({ where: { id } });
    revalidatePath("/company/vendors");
}

export async function getVendorTags() {
    "use server";
    return prisma.vendorTag.findMany({ orderBy: { name: "asc" } });
}

export async function createVendorTag(name: string) {
    "use server";
    await assertVendorPermission();
    const tag = await prisma.vendorTag.create({ data: { name } });
    revalidatePath("/company/vendors");
    return tag;
}

export async function updateVendorTag(id: string, name: string) {
    "use server";
    await assertVendorPermission();
    const tag = await prisma.vendorTag.update({ where: { id }, data: { name } });
    revalidatePath("/company/vendors");
    return tag;
}

export async function deleteVendorTag(id: string) {
    "use server";
    await assertVendorPermission();
    await prisma.vendorTag.delete({ where: { id } });
    revalidatePath("/company/vendors");
}

// ==========================================
// Purchase Orders
// ==========================================
export async function getPurchaseOrders(projectId: string) {
    await assertFinancialProjectAccess(projectId);
    return prisma.purchaseOrder.findMany({
        where: { projectId },
        include: { vendor: true, items: true },
        orderBy: { createdAt: "desc" }
    });
}

export async function getPurchaseOrder(id: string) {
    const user = await assertFinancialPermission();
    const purchaseOrder = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: { vendor: true, items: { include: { costCode: true } }, files: true, expenses: { include: { costCode: true } } }
    });
    if (purchaseOrder) assertFinancialProjectScope(user, purchaseOrder.projectId);
    return purchaseOrder;
}

export async function createPurchaseOrder(projectId: string, data: any) {
    await assertFinancialProjectAccess(projectId);
    const count = await prisma.purchaseOrder.count({ where: { projectId } });
    const code = `PO-${(count + 1).toString().padStart(3, "0")}`;
    const items = data.items;
    
    const po = await prisma.purchaseOrder.create({
        data: {
            projectId,
            code,
            vendorId: data.vendorId,
            status: data.status,
            totalAmount: data.totalAmount,
            notes: data.notes,
            memos: data.memos,
            terms: data.terms,
            items: {
                create: (items || []).map((item: any) => ({
                    description: item.description,
                    quantity: item.quantity,
                    unitCost: item.unitCost,
                    total: item.total,
                    order: item.order,
                    costCodeId: item.costCodeId,
                    costTypeId: item.costTypeId,
                })),
            }
        }
    });
    revalidatePath(`/projects/${projectId}/purchase-orders`);
    // totalAmount is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(po));
}

export async function createPurchaseOrderFromEstimate(projectId: string, estimateId: string, itemIds: string[], vendorId: string) {
    await assertFinancialProjectAccess(projectId);
    
    // Validate inputs
    if (!itemIds || itemIds.length === 0) throw new Error("No items selected");
    if (!vendorId) throw new Error("Vendor ID is required to create a Purchase Order");

    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: { items: true }
    });

    if (!estimate) throw new Error("Estimate not found");
    if (estimate.projectId !== projectId) throw new Error("Estimate does not belong to this project");

    const selectedItems = estimate.items.filter((item: any) => itemIds.includes(item.id));
    if (selectedItems.length === 0) throw new Error("No valid items found");

    // itemIds must exactly match a validated in-estimate selection — never trust the raw
    // argument for the PO-link step below, or a caller could link cross-estimate/cross-project
    // items by passing arbitrary ids alongside valid ones.
    const dedupedItemIds = Array.from(new Set(itemIds));
    if (dedupedItemIds.length !== selectedItems.length) {
        throw new Error("Selected items do not match a valid set of items on this estimate");
    }

    const totalAmount = selectedItems.reduce((acc: number, item: any) => acc + ((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)), 0);

    // Create the PO, its PurchaseOrderItems, the PO<->item join rows, and the legacy mirror
    // resync all inside ONE retried transaction (mirrors quickCreatePOAndLink's fix) — the PO
    // used to commit in its own transaction before the link step ran separately, so a failure in
    // the link step left an orphaned, unlinked PO behind, and a retry after the fact created a
    // second one instead of resuming the first. The attempt loop keeps the same PO-code
    // collision retry quickCreatePOAndLink uses: a P2002 on the code aborts that attempt's
    // transaction cleanly (nothing committed), so the next attempt starts clean.
    let newPo: any;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            newPo = await withTxRetry(() => prisma.$transaction(async (tx) => {
                // Selected items are pre-validated against the in-estimate selection above —
                // never the raw itemIds argument.
                await lockEstimateItemLinks(tx, estimateId, selectedItems.map((item: any) => item.id));
                const count = await tx.purchaseOrder.count({ where: { projectId } });
                const code = `PO-${(count + 1 + attempt).toString().padStart(3, "0")}`;
                const created = await tx.purchaseOrder.create({
                    data: {
                        projectId,
                        vendorId,
                        code,
                        status: "Draft",
                        totalAmount,
                        notes: `Auto-generated from Estimate: ${estimate.title}\n\nReview line items and update costs/quantities as needed.`,
                        memos: "",
                        terms: "Standard Subcontractor/Vendor terms apply unless overridden.",
                        items: {
                            create: selectedItems.map((item: any, idx: number) => {
                                // Preserve an explicit zero quantity (optional/alternate estimate
                                // lines are shown at $0) — only a missing/unparseable quantity
                                // falls back to 1. `|| 1` would reprice a $0 option into the PO.
                                const parsedQty = parseFloat(item.quantity);
                                const qty = Number.isFinite(parsedQty) ? parsedQty : 1;
                                return {
                                    description: item.name + (item.description ? ` - ${item.description}` : ""),
                                    quantity: qty,
                                    unitCost: parseFloat(item.unitCost) || 0,
                                    total: qty * (parseFloat(item.unitCost) || 0),
                                    order: idx,
                                    costCodeId: item.costCodeId,
                                    costTypeId: item.costTypeId
                                };
                            })
                        }
                    }
                });
                for (const item of selectedItems) {
                    await migrateLegacyPoLink(tx, item.id);
                }
                await tx.estimateItemPurchaseOrder.createMany({
                    data: selectedItems.map((item: any) => ({ estimateItemId: item.id, purchaseOrderId: created.id })),
                    skipDuplicates: true,
                });
                for (const item of selectedItems) {
                    await syncLegacyPoLink(tx, item.id);
                }
                return created;
            }));
            break;
        } catch (e: any) {
            // Unique constraint violation on code — retry with the next number. Any other
            // error (including a deadlock withTxRetry already exhausted its own retries on)
            // propagates immediately. Check e.meta?.target too, not just e.code, so a P2002 on
            // some unrelated constraint inside this same transaction doesn't get mistaken for a
            // code collision and silently retried instead of surfaced.
            // NOTE: PurchaseOrder.code has no unique constraint in the schema yet (see
            // prisma/schema.prisma ~1553), so this P2002 branch may never actually fire, and
            // concurrent creates from different estimates can still produce duplicate codes —
            // that gap needs its own migration + duplicate-cleanup plan, out of scope here.
            const target = e?.meta?.target;
            const isCodeCollision = e?.code === "P2002"
                && (Array.isArray(target) ? target.includes("code") : typeof target === "string" && target.includes("code"));
            if (!isCodeCollision || attempt === 4) throw e;
        }
    }

    revalidatePath(`/projects/${projectId}/purchase-orders`);
    // totalAmount is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(newPo));
}

export async function updatePurchaseOrder(id: string, data: any) {
    const user = await assertFinancialPermission();
    const existing = await prisma.purchaseOrder.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing) throw new Error("Purchase order not found");
    assertFinancialProjectScope(user, existing.projectId);
    const items = data.items;
    const updateData = {
        ...(data.vendorId ? { vendorId: data.vendorId } : {}),
        status: data.status,
        totalAmount: data.totalAmount,
        notes: data.notes,
        memos: data.memos,
        terms: data.terms,
    };

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

    // totalAmount is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(po));
}

export async function deletePurchaseOrder(id: string) {
    const user = await assertFinancialPermission();
    const po = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po) return;
    assertFinancialProjectScope(user, po.projectId);

    await withTxRetry(() => prisma.$transaction(async (tx) => {
        // Lock this PurchaseOrder row FIRST, before discovering which items are currently
        // linked to it. Without this, the "affected" snapshot below is a bare read that races
        // a concurrent link/quick-create/legacy-migrate: that operation could commit a brand
        // new join row (or migrate the legacy scalar mirror onto this PO) in the gap between
        // our snapshot and the delete, so our resync loop — built from the stale, possibly-empty
        // snapshot — would never touch that item's legacy mirror, leaving it dangling once the
        // PO it names has been deleted out from under it.
        //
        // Every PO-link writer (linkPOToEstimateItem, unlinkPOFromEstimateItem, and
        // restoreEstimateItemAssociations) locks its target PurchaseOrder id(s) through
        // lockEstimateItemLinks BEFORE the Estimate/EstimateItem locks — see that function's
        // doc comment for why PurchaseOrder leads the order. Locking it here, first, keeps this
        // path consistent with that same order (PurchaseOrder → Estimate → EstimateItem below).
        await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`;

        // Collect affected items BEFORE the delete cascades their join rows away, so their
        // legacy scalar mirrors can be resynced even when other links survive (the FK alone
        // would only null out the mirror for items whose one-and-only link was this PO).
        const affected = await tx.estimateItemPurchaseOrder.findMany({
            where: { purchaseOrderId: id },
            select: { estimateItemId: true },
        });
        if (affected.length > 0) {
            const items = await tx.estimateItem.findMany({
                where: { id: { in: affected.map((a) => a.estimateItemId) } },
                select: { id: true, estimateId: true },
            });
            // Group by estimate and lock each group in sorted order so this commutes with
            // every other path's Estimate → sorted-EstimateItem lock order instead of
            // deadlocking against it. This PO is already locked above — passing it again here
            // is a harmless re-lock (same transaction already holds it) that keeps every
            // lockEstimateItemLinks call site symmetric.
            const byEstimate = new Map<string, string[]>();
            for (const it of items) {
                const arr = byEstimate.get(it.estimateId) ?? [];
                arr.push(it.id);
                byEstimate.set(it.estimateId, arr);
            }
            for (const [estId, itemIds] of Array.from(byEstimate.entries()).sort(([a], [b]) => a.localeCompare(b))) {
                await lockEstimateItemLinks(tx, estId, itemIds, [id]);
            }
        }
        await tx.purchaseOrder.delete({ where: { id } });
        for (const link of affected) {
            await syncLegacyPoLink(tx, link.estimateItemId);
        }
    }));

    revalidatePath(`/projects/${po.projectId}/purchase-orders`);
}

export async function updatePurchaseOrderStatus(id: string, status: string) {
    const user = await assertFinancialPermission();
    const existing = await prisma.purchaseOrder.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing) throw new Error("Purchase order not found");
    assertFinancialProjectScope(user, existing.projectId);
    const po = await prisma.purchaseOrder.update({
        where: { id },
        data: { status }
    });
    revalidatePath(`/projects/${po.projectId}/purchase-orders/${id}`);
    revalidatePath(`/projects/${po.projectId}/purchase-orders`);
    return po;
}

export async function approvePurchaseOrder(id: string, signatureName: string) {
    const user = await assertFinancialPermission();
    const existing = await prisma.purchaseOrder.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing) throw new Error("Purchase order not found");
    assertFinancialProjectScope(user, existing.projectId);
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
    // totalAmount is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(po));
}

export async function uploadPurchaseOrderFile(purchaseOrderId: string, formData: FormData) {
    const user = await assertFinancialPermission();
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, select: { projectId: true } });
    if (!existing) throw new Error("Purchase order not found");
    assertFinancialProjectScope(user, existing.projectId);
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
    const user = await assertFinancialPermission();
    const file = await prisma.purchaseOrderFile.findUnique({ where: { id: fileId }, include: { purchaseOrder: true } });
    if (!file) return;
    assertFinancialProjectScope(user, file.purchaseOrder.projectId);

    await prisma.purchaseOrderFile.delete({ where: { id: fileId } });
    revalidatePath(`/projects/${file.purchaseOrder.projectId}/purchase-orders/${file.purchaseOrderId}`);
}

// Upload a File object (not FormData) to a newly created PO — used after PDF-extract flow
export async function uploadPurchaseOrderFileFromBuffer(
    purchaseOrderId: string,
    projectId: string,
    formData: FormData
) {
    const user = await assertFinancialPermission();
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, select: { projectId: true } });
    if (!existing || existing.projectId !== projectId) return;
    assertFinancialProjectScope(user, existing.projectId);

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
    await assertEstimateAccess(estimateId);
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
    const user = await assertEstimatePermission();
    const file = await prisma.estimateFile.findUnique({ where: { id: fileId }, include: { estimate: { select: { id: true, code: true, title: true, status: true, totalAmount: true, projectId: true, leadId: true } } } });
    if (!file) return;
    // Addressed by file id, so the owning estimate has to be resolved before the
    // horizontal check can run.
    assertEstimateScope(user, file.estimate);

    await prisma.estimateFile.delete({ where: { id: fileId } });
    if (file.estimate.projectId) {
        revalidatePath(`/projects/${file.estimate.projectId}/estimates/${file.estimateId}`);
    }
}

export async function getEstimateFiles(estimateId: string) {
    await assertEstimateAccess(estimateId);
    return prisma.estimateFile.findMany({
        where: { estimateId },
        orderBy: { createdAt: "desc" },
    });
}


export async function sendPurchaseOrder(id: string, toEmail: string, message: string) {
    const user = await assertFinancialPermission();
    const { sendNotification } = await import("./email");
    const { generatePurchaseOrderPdf } = await import("./pdf");

    const po = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: { project: true, vendor: true }
    });
    if (!po) throw new Error("PO not found");
    assertFinancialProjectScope(user, po.projectId);

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
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
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
    const user = await assertActiveStaff();
    const board = await prisma.selectionBoard.findUnique({
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
    if (!board) return null;
    if (!canAccessProject(user, board.projectId)) throw new Error("Forbidden");
    return board;
}

export async function createSelectionBoard(projectId: string, title: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
    const board = await prisma.selectionBoard.create({
        data: { projectId, title },
    });
    revalidatePath(`/projects/${projectId}/selections`);
    return board;
}

export async function updateSelectionBoard(id: string, data: { title?: string; status?: string }) {
    const user = await assertActiveStaff();
    const existing = await prisma.selectionBoard.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing) throw new Error("Board not found");
    if (!canAccessProject(user, existing.projectId)) throw new Error("Forbidden");
    const board = await prisma.selectionBoard.update({
        where: { id },
        data,
    });
    revalidatePath(`/projects/${board.projectId}/selections`);
    return board;
}

export async function deleteSelectionBoard(id: string) {
    const user = await assertActiveStaff();
    const board = await prisma.selectionBoard.findUnique({ where: { id } });
    if (!board) return { success: false };
    if (!canAccessProject(user, board.projectId)) throw new Error("Forbidden");
    await prisma.selectionBoard.delete({ where: { id } });
    revalidatePath(`/projects/${board.projectId}/selections`);
    return { success: true };
}

export async function createSelectionCategory(boardId: string, name: string) {
    const user = await assertActiveStaff();
    const board = await prisma.selectionBoard.findUnique({ where: { id: boardId } });
    if (!board) throw new Error("Board not found");
    if (!canAccessProject(user, board.projectId)) throw new Error("Forbidden");
    const maxOrder = await prisma.selectionCategory.aggregate({
        where: { boardId },
        _max: { order: true },
    });
    const cat = await prisma.selectionCategory.create({
        data: { boardId, name, order: (maxOrder._max.order ?? -1) + 1 },
    });
    revalidatePath(`/projects/${board.projectId}/selections`);
    return cat;
}

export async function updateSelectionCategory(id: string, data: { name?: string; order?: number }) {
    const user = await assertActiveStaff();
    const existing = await prisma.selectionCategory.findUnique({ where: { id }, include: { board: true } });
    if (!existing) throw new Error("Category not found");
    if (!canAccessProject(user, existing.board.projectId)) throw new Error("Forbidden");
    return await prisma.selectionCategory.update({ where: { id }, data });
}

export async function deleteSelectionCategory(id: string) {
    const user = await assertActiveStaff();
    const cat = await prisma.selectionCategory.findUnique({ where: { id }, include: { board: true } });
    if (!cat) return { success: false };
    if (!canAccessProject(user, cat.board.projectId)) throw new Error("Forbidden");
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
    const user = await assertActiveStaff();
    const cat = await prisma.selectionCategory.findUnique({ where: { id: categoryId }, include: { board: true } });
    if (!cat) throw new Error("Category not found");
    if (!canAccessProject(user, cat.board.projectId)) throw new Error("Forbidden");
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
    revalidatePath(`/projects/${cat.board.projectId}/selections`);
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
    const user = await assertActiveStaff();
    const existing = await prisma.selectionOption.findUnique({
        where: { id },
        include: { category: { include: { board: true } } },
    });
    if (!existing) throw new Error("Option not found");
    if (!canAccessProject(user, existing.category.board.projectId)) throw new Error("Forbidden");
    return await prisma.selectionOption.update({ where: { id }, data });
}

export async function deleteSelectionOption(id: string) {
    const user = await assertActiveStaff();
    const option = await prisma.selectionOption.findUnique({
        where: { id },
        include: { category: { include: { board: true } } },
    });
    if (!option) return { success: false };
    if (!canAccessProject(user, option.category.board.projectId)) throw new Error("Forbidden");
    await prisma.selectionOption.delete({ where: { id } });
    revalidatePath(`/projects/${option.category.board.projectId}/selections`);
    return { success: true };
}

export async function sendSelectionBoardToClient(boardId: string) {
    const user = await assertActiveStaff();

    const board = await prisma.selectionBoard.findUnique({
        where: { id: boardId },
        include: {
            project: { include: { client: true } },
            categories: { include: { options: true } },
        },
    });
    if (!board) throw new Error("Board not found");
    if (!canAccessProject(user, board.projectId)) throw new Error("Forbidden");

    if (board.categories.length === 0) {
        throw new Error("Add at least one category before sending.");
    }
    const emptyCategories = board.categories.filter((c) => c.options.length === 0);
    if (emptyCategories.length > 0) {
        throw new Error(`Every category needs at least one option before sending. Missing options: ${emptyCategories.map((c) => c.name).join(", ")}`);
    }

    await prisma.selectionBoard.update({
        where: { id: boardId },
        data: { status: "Sent" },
    });

    // Email the client
    const clientEmail = board.project.client?.email;
    if (clientEmail) {
        const settings = await getCachedCompanySettings();
        const { buildClientPortalUrl } = await import("./client-portal-auth");
        const portalUrl = await buildClientPortalUrl(board.project.client?.id, clientEmail, `/portal/projects/${board.projectId}/selections`);
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
            { cc: selectionCc, copyToInternal: true }
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

    await assertPortalProjectOwnership(board.projectId);

    if (board.status !== "Sent") {
        throw new Error("This board is not open for selections.");
    }

    // Cheap pre-check against the snapshot read above, for a fast error
    // before touching the transaction. This snapshot can go stale if staff
    // edit the board's categories/options between this read and the claim
    // below, so it is re-validated against fresh in-tx data after the claim
    // succeeds — this pass is purely an early-exit convenience.
    for (const cat of board.categories) {
        if (cat.options.length === 0) continue;
        const selectedOptionId = selections[cat.id];
        if (!selectedOptionId || !cat.options.some((o) => o.id === selectedOptionId)) {
            throw new Error("Please select an option for every category.");
        }
    }

    // Claim the board first, inside the transaction: updateMany only flips
    // status if it's still "Sent", so two concurrent submits (or a resubmit
    // racing a re-send) can't both write option selections — the loser gets
    // count 0 and throws instead of silently double-applying.
    const freshCategories = await prisma.$transaction(async (tx) => {
        const claim = await tx.selectionBoard.updateMany({
            where: { id: boardId, status: "Sent" },
            data: { status: "Selections Made" },
        });
        if (claim.count === 0) {
            throw new Error("This board is not open for selections.");
        }

        // Re-read categories+options inside the transaction, after the claim
        // succeeds, and re-run the same validation against this fresh data —
        // a staff edit that slipped in between the pre-check above and the
        // claim (e.g. removing/replacing an option) throws here, which rolls
        // back the claim instead of recording a selection against stale data.
        const cats = await tx.selectionCategory.findMany({
            where: { boardId },
            include: { options: true },
        });
        for (const cat of cats) {
            if (cat.options.length === 0) continue;
            const selectedOptionId = selections[cat.id];
            if (!selectedOptionId || !cat.options.some((o) => o.id === selectedOptionId)) {
                throw new Error("Please select an option for every category.");
            }
        }

        // Reset all options then set selected ones, per category.
        for (const cat of cats) {
            const selectedOptionId = selections[cat.id];
            if (cat.options.length === 0) continue;
            await tx.selectionOption.updateMany({
                where: { categoryId: cat.id },
                data: { selected: false },
            });
            const set = await tx.selectionOption.updateMany({
                where: { id: selectedOptionId, categoryId: cat.id },
                data: { selected: true },
            });
            if (set.count !== 1) {
                throw new Error("Please select an option for every category.");
            }
        }

        return cats;
    });

    // Notify PM — built from the fresh in-tx data captured above, not the
    // pre-transaction snapshot.
    const settings = await getCachedCompanySettings();
    if (settings.notificationEmail) {
        const selectedSummary = freshCategories.map(cat => {
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
    await assertProjectReadAccess(projectId);
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
// Product Library, Clipper, Client Selection Proposals
// (docs/specs/product-library-portal-selections.md)
// =============================================

/**
 * Ownership + visibility assertion for the portal-facing product-library
 * actions below (all gated on the Selections tab: proposals and favorites).
 * Mirrors the exact check order the portal selections page.tsx and
 * /api/portal/files route use — visibility gate first, applied uniformly to
 * staff AND client (no staff bypass here, matching how this feature area's
 * own pages/routes read PortalVisibility; that's a different convention from
 * assertPortalProjectAccessCore's staff-bypass, which is scoped to the
 * schedule/daily-logs areas) — then staff-bypass + resolveSessionClientId +
 * project-ownership for the client path.
 */
async function assertPortalProjectOwnership(projectId: string): Promise<{ isStaff: boolean; clientId: string | null }> {
    const visibility = await getPortalVisibility(projectId);
    if (!visibility.isPortalEnabled || !visibility.showSelections) throw new PortalAuthError();

    const session = await getSessionOrDev();
    const role = (session?.user as { role?: string } | undefined)?.role;
    const isStaff = role === "ADMIN" || role === "MANAGER";
    if (isStaff) return { isStaff: true, clientId: null };

    const clientId = await resolveSessionClientId();
    if (!clientId) throw new PortalAuthError();
    const project = await prisma.project.findFirst({ where: { id: projectId, clientId }, select: { id: true } });
    if (!project) throw new PortalAuthError();
    return { isStaff: false, clientId };
}

/**
 * Ownership + visibility assertion for the portal-facing collaborative mood
 * board actions below. Modeled exactly on assertPortalProjectOwnership above,
 * gated on showMoodBoards instead of showSelections.
 */
async function assertPortalMoodBoardAccess(projectId: string): Promise<{ isStaff: boolean; clientId: string | null }> {
    const visibility = await getPortalVisibility(projectId);
    if (!visibility.isPortalEnabled || !visibility.showMoodBoards) throw new PortalAuthError();

    const session = await getSessionOrDev();
    const role = (session?.user as { role?: string } | undefined)?.role;
    const isStaff = role === "ADMIN" || role === "MANAGER";
    if (isStaff) return { isStaff: true, clientId: null };

    const clientId = await resolveSessionClientId();
    if (!clientId) throw new PortalAuthError();
    const project = await prisma.project.findFirst({ where: { id: projectId, clientId }, select: { id: true } });
    if (!project) throw new PortalAuthError();
    return { isStaff: false, clientId };
}

// Thin exported wrapper around assertPortalMoodBoardAccess for the portal
// mood-board pages (server components), which need the same
// ownership/visibility check the actions above enforce — throws on failure,
// same as the internal function.
export async function getPortalMoodBoardAccess(projectId: string): Promise<{ isStaff: boolean; clientId: string | null }> {
    return assertPortalMoodBoardAccess(projectId);
}

/** Read gate for project-scoped data shared by the staff app and the client
 * portal: internal staff see everything; a client session must own the
 * project. Deliberately does NOT read PortalVisibility — those per-feature
 * flags decide what the CLIENT is shown and are enforced by the portal pages
 * themselves; applying them here would lock staff out of their own tools
 * whenever a project's portal is switched off.
 *
 * ADMIN/MANAGER get an unconditional global bypass. FIELD_CREW/FINANCE are
 * staff but not global — they only read projects they're scoped to via
 * ProjectAccess or a crew assignment, mirrored exactly from the same check in
 * src/app/projects/[id]/layout.tsx via the shared canAccessProject() helper,
 * so this read gate can't be wider than the page boundary that guards the
 * rest of that project's staff UI. */
async function assertProjectReadAccess(projectId: string): Promise<{ isStaff: boolean }> {
    const session = await getSessionOrDev();
    const role = (session?.user as { role?: string } | undefined)?.role;

    if (role === "ADMIN" || role === "MANAGER") return { isStaff: true };

    if (role === "FIELD_CREW" || role === "FINANCE") {
        const email = session?.user?.email;
        const user = email ? await getUserWithPermissionsByEmail(email) : null;
        if (!user || !canAccessProject(user, projectId)) throw new PortalAuthError();
        return { isStaff: true };
    }

    const clientId = await resolveSessionClientId();
    if (!clientId) throw new PortalAuthError();
    const project = await prisma.project.findFirst({ where: { id: projectId, clientId }, select: { id: true } });
    if (!project) throw new PortalAuthError();
    return { isStaff: false };
}

/** Persist boundary for any stored vendorUrl/imageUrl: only a plain http(s)
 * URL is ever written — a scraped page, Gemini's output, or a client-typed
 * "Photo URL" field could otherwise smuggle a javascript:/data: URL into the
 * DB, which would execute if a render site ever put it straight into href/img
 * src. Render sites additionally guard with the same isHttpUrl() check
 * (belt-and-suspenders — see ClientSuggestions.tsx etc.), but nothing unsafe
 * should reach the database in the first place. */
function safeUrlOrNull(url: string | null | undefined): string | null {
    return isHttpUrl(url) ? url : null;
}

/** Clamp a client-supplied list price identically to product-parse.ts's own
 * normalizeParsedProduct() price rule (finite, >0, <=MAX_PRICE) — used by
 * submitSelectionProposal's optional listPrice param (the portal clipper's
 * bookmarklet-extracted price) so it's held to the exact same bound as a
 * server-parsed price instead of a second, driftable check. Returns
 * undefined (not persisted) for anything out of range. */
function clampListPrice(value: number | null | undefined): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > PRODUCT_PARSE_MAX_PRICE) {
        return undefined;
    }
    return value;
}

// ── Product Library CRUD (team) ─────────────────────────────────────────────

export async function createProductLibraryItem(data: {
    name: string;
    description?: string;
    imageUrl?: string;
    price?: number;
    vendor?: string;
    vendorUrl?: string;
    category?: string;
    source?: "clip" | "manual";
}) {
    const user = await assertActiveStaff();
    const name = data.name?.trim();
    if (!name) throw new Error("Name is required");

    const item = await prisma.productLibraryItem.create({
        data: {
            name,
            description: data.description?.trim() || null,
            imageUrl: safeUrlOrNull(data.imageUrl),
            price: data.price ?? null,
            vendor: data.vendor?.trim() || null,
            vendorUrl: safeUrlOrNull(data.vendorUrl),
            category: data.category?.trim() || null,
            source: data.source || "manual",
            clippedById: user.id,
        },
    });
    revalidatePath("/company/product-library");
    // price is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(item));
}

export async function updateProductLibraryItem(id: string, data: {
    name?: string;
    description?: string;
    imageUrl?: string;
    price?: number;
    vendor?: string;
    vendorUrl?: string;
    category?: string;
}) {
    await assertActiveStaff();
    const item = await prisma.productLibraryItem.update({
        where: { id },
        data: {
            ...(data.name !== undefined && { name: data.name.trim() }),
            ...(data.description !== undefined && { description: data.description?.trim() || null }),
            ...(data.imageUrl !== undefined && { imageUrl: safeUrlOrNull(data.imageUrl) }),
            ...(data.price !== undefined && { price: data.price }),
            ...(data.vendor !== undefined && { vendor: data.vendor?.trim() || null }),
            ...(data.vendorUrl !== undefined && { vendorUrl: safeUrlOrNull(data.vendorUrl) }),
            ...(data.category !== undefined && { category: data.category?.trim() || null }),
        },
    });
    revalidatePath("/company/product-library");
    // price is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(item));
}

export async function deleteProductLibraryItem(id: string) {
    await assertActiveStaff();
    await prisma.productLibraryItem.delete({ where: { id } });
    revalidatePath("/company/product-library");
    return { success: true };
}

export async function getProductLibrary(filter?: { search?: string; category?: string }) {
    await assertActiveStaff();
    const where: any = {};
    if (filter?.category) where.category = filter.category;
    if (filter?.search?.trim()) {
        const q = filter.search.trim();
        where.OR = [
            { name: { contains: q, mode: "insensitive" } },
            { vendor: { contains: q, mode: "insensitive" } },
            { category: { contains: q, mode: "insensitive" } },
        ];
    }
    return prisma.productLibraryItem.findMany({
        where,
        orderBy: { createdAt: "desc" },
    });
}

// ── Project Favorites (team + portal read) ──────────────────────────────────

export async function addProjectFavorite(projectId: string, productId: string, note?: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
    const favorite = await prisma.projectProductFavorite.upsert({
        where: { projectId_productId: { projectId, productId } },
        update: { note: note?.trim() || null },
        create: { projectId, productId, note: note?.trim() || null, addedById: user.id, addedByClient: false },
    });
    revalidatePath(`/projects/${projectId}/selections`);
    return favorite;
}

export async function removeProjectFavorite(projectId: string, productId: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
    await prisma.projectProductFavorite.deleteMany({ where: { projectId, productId } });
    revalidatePath(`/projects/${projectId}/selections`);
    return { success: true };
}

export async function getProjectFavorites(projectId: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
    return prisma.projectProductFavorite.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        include: { product: true },
    });
}

export async function getProjectFavoritesForPortal(projectId: string) {
    await assertPortalProjectOwnership(projectId);
    return prisma.projectProductFavorite.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        include: { product: true },
    });
}

// ── Client Selection Proposals ("Client suggestions") ───────────────────────

export async function submitSelectionProposal(projectId: string, data: {
    url?: string;
    name: string;
    description?: string;
    imageUrl?: string;
    clientNote?: string;
    // Price already known at call time (e.g. the portal clipper bookmarklet
    // read it straight off the live page DOM, same as the team clipper) — see
    // clampListPrice() above. Still never returned to the client below; only
    // ever persisted server-side. Falls back to the server-side parse's price
    // when not supplied, same as every other field's precedence in this
    // function (client-supplied value wins, parse fills the gap).
    listPrice?: number;
    // Playground: drop the new item straight into a decision instead of
    // landing it Unsorted. Optional — validated against this project below,
    // same TOCTOU-safe pattern as decideSelectionProposal's boardId/categoryId.
    decisionId?: string;
}) {
    await assertPortalProjectOwnership(projectId);

    const manualName = data.name?.trim();
    const url = data.url?.trim();
    if (!manualName && !url) throw new Error("A name or a product link is required");
    const clientNote = normalizeSelectionItemNote(data.clientNote ?? "");

    let validDecisionId: string | null = null;
    if (data.decisionId) {
        const decision = await prisma.decision.findFirst({
            where: { id: data.decisionId, projectId, deletedAt: null },
            select: { id: true },
        });
        if (!decision) throw new Error("That decision doesn't belong to this project — refresh and try again.");
        validDecisionId = decision.id;
    }

    const clampedListPrice = clampListPrice(data.listPrice);

    // Parse server-side so price is captured even though it's never returned
    // to the client here. Never throws — degrades to {vendorUrl, name: null}.
    // Skipped entirely when the caller already supplied a valid listPrice —
    // the only reason this re-parse exists is to recover the price that the
    // portal prefill route (/api/portal/projects/[id]/proposals/parse)
    // strips from its response; the clipper path (submitSelectionProposal's
    // listPrice caller) already has that price from the bookmarklet's
    // in-page DOM read, so re-fetching the URL server-side here would just
    // be a slow (up to the Gemini url_context fallback's ~20s+) no-op for
    // price, while every other field already prefers the caller-supplied
    // value over parsed.* below regardless. The manual "Suggest an item"
    // modal never sends listPrice, so it's unaffected and still gets parsed.
    let parsed: Awaited<ReturnType<typeof parseProductUrl>> | null = null;
    if (url && clampedListPrice === undefined) {
        parsed = await parseProductUrl(url);
    }

    const name = (manualName || parsed?.name || "Suggested item").slice(0, 200);

    const proposal = await prisma.selectionProposal.create({
        data: {
            projectId,
            name,
            description: data.description?.trim() || parsed?.description || null,
            imageUrl: safeUrlOrNull(data.imageUrl) || safeUrlOrNull(parsed?.imageUrl),
            price: clampedListPrice ?? parsed?.price ?? null,
            vendorUrl: safeUrlOrNull(url) || safeUrlOrNull(parsed?.vendorUrl),
            clientNote,
            status: "Idea",
            decisionId: validDecisionId,
        },
    });

    const project = await prisma.project.findUnique({ where: { id: projectId }, include: { client: true } });

    // Notify the team — quiet informational note, not an action request. The
    // client's own space is ungated now (docs/specs/client-selections-playground.md
    // — "the event that matters is the client *deciding*"), so this is no
    // longer framed as a suggestion awaiting approval.
    const settings = await getCachedCompanySettings();
    if (settings.notificationEmail && project) {
        await sendNotification(
            settings.notificationEmail,
            `Client added a selection item — ${project.name}`,
            `<div style="font-family: sans-serif; color: #333;">
                <h3>Client Added a Selection Item</h3>
                <p><strong>${project.client?.name || "Client"}</strong> added an item to their selections for project <strong>${project.name}</strong>:</p>
                <ul>
                    <li><strong>${name}</strong></li>
                    ${proposal.vendorUrl ? `<li><a href="${proposal.vendorUrl}">${proposal.vendorUrl}</a></li>` : ""}
                    ${proposal.clientNote ? `<li>Note: ${proposal.clientNote}</li>` : ""}
                </ul>
                <p>No action needed — it'll show up as a Decision once they choose one.</p>
            </div>`
        );
    }

    await logActivity({
        projectId,
        actorType: "CLIENT",
        actorName: project?.client?.name || "Client",
        action: "suggested_selection_item",
        entityType: "SelectionProposal",
        entityId: proposal.id,
        entityName: name,
    });

    revalidatePath(`/portal/projects/${projectId}/selections`);
    revalidatePath(`/projects/${projectId}/selections`);

    // Price is PM-side info until approval — never return it to the client.
    // AI-suggestion fields are staff-only too (the portal never shows
    // suggestions) — always null on a freshly created row, but stripped
    // explicitly here so this return never depends on that being true.
    const { price, ...proposalWithoutPrice } = proposal;
    return stripSuggestionFields(proposalWithoutPrice);
}

export async function getSelectionProposalsForPortal(projectId: string) {
    await assertPortalProjectOwnership(projectId);
    const proposals = await prisma.selectionProposal.findMany({
        where: { projectId, deletedAt: null },
        orderBy: { createdAt: "desc" },
    });
    // Price is never shown to the client — no exceptions, no "unless
    // Approved/Chosen" (docs/specs/client-selections-playground.md, "Decisions
    // locked with Justin": GTR controls whether a number appears). Stricter
    // than the old behavior here, which returned price once a proposal was
    // Approved. AI-suggestion fields are staff-only for the same reason
    // (docs/superpowers/plans/2026-07-30-selection-ai-sort.md).
    return proposals.map((p) => stripSuggestionFields({ ...p, price: null }));
}

export async function getSelectionProposals(projectId: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
    return prisma.selectionProposal.findMany({
        where: { projectId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        include: { decidedBy: { select: { id: true, name: true, email: true } } },
    });
}

export async function decideSelectionProposal(proposalId: string, input: {
    action: "approve" | "decline";
    pmNote?: string;
    price?: number;
    boardId?: string;
    categoryId?: string;
    addToFavorites?: boolean;
}) {
    const user = await assertActiveStaff();
    if (input.action !== "approve" && input.action !== "decline") throw new Error("Invalid action");

    const proposal = await prisma.selectionProposal.findUnique({
        where: { id: proposalId },
        include: { project: { include: { client: true } } },
    });
    if (!proposal) throw new Error("Proposal not found");
    if (!canAccessProject(user, proposal.projectId)) throw new Error("Forbidden");

    const newStatus = input.action === "approve" ? "Approved" : "Declined";
    const decidedAt = new Date();
    const pmNote = input.pmNote?.trim() || null;
    // Re-validated at every persist boundary — proposal.imageUrl/vendorUrl were
    // already sanitized when the proposal was created (submitSelectionProposal),
    // but this is the second place they get copied into a new row, so it's
    // checked again rather than trusted.
    const safeImageUrl = safeUrlOrNull(proposal.imageUrl);
    const safeVendorUrl = safeUrlOrNull(proposal.vendorUrl);

    let productId: string | null = null;
    let favoriteCreated = false;
    let optionCreated = false;
    let alreadyDecided = false;

    // CAS claim + board/category validation + every dependent write
    // (ProductLibraryItem, favorite, SelectionOption, the proposal's own
    // productId/boardId/categoryId backfill) run inside one transaction, so:
    //   - a mid-sequence failure can't leave a half-approved proposal (e.g.
    //     status flipped to Approved but no ProductLibraryItem), and
    //   - the board/category ownership check reads the SAME transactional
    //     snapshot the writes commit against — validating outside the
    //     transaction would leave a TOCTOU window where the board/category
    //     could be deleted or reassigned between the check and the write.
    await prisma.$transaction(async (tx) => {
        // Status CAS: only a Pending proposal transitions. A duplicate decide
        // call (double-click, retried request) matches zero rows and no-ops
        // instead of re-deciding or minting a second ProductLibraryItem/
        // favorite/option. boardId/categoryId are intentionally NOT set here —
        // they're only known-valid once the check below runs, inside this same
        // transaction, and are written in the follow-up update further down.
        const claim = await tx.selectionProposal.updateMany({
            where: { id: proposalId, status: "Pending" },
            data: {
                status: newStatus,
                pmNote,
                decidedById: user.id,
                decidedAt,
                ...(input.action === "approve" ? {
                    price: input.price ?? proposal.price ?? null,
                } : {}),
            },
        });
        if (claim.count === 0) {
            alreadyDecided = true;
            return;
        }

        if (input.action !== "approve") return;

        // Validate board/category ownership INSIDE the transaction (after the
        // claim, same isolated snapshot the writes below use). A staff user
        // scoped to project A could otherwise pass a boardId from project B
        // and write a SelectionOption into another project's board. Only ever
        // persist boardId/categoryId on the proposal when BOTH were supplied
        // AND validated — never the raw, unvalidated input.boardId. If the
        // caller explicitly asked to link a board+category and that link
        // doesn't check out, abort the whole decision (throwing here rolls
        // back the CAS claim above too, so the proposal stays Pending) rather
        // than silently approving without the link.
        let validBoardId: string | null = null;
        let validCategoryId: string | null = null;
        if (input.boardId && input.categoryId) {
            const board = await tx.selectionBoard.findFirst({
                where: { id: input.boardId, projectId: proposal.projectId },
                select: { id: true },
            });
            if (!board) {
                throw new Error("That board doesn't belong to this project — refresh and try again.");
            }
            const category = await tx.selectionCategory.findFirst({
                where: { id: input.categoryId, boardId: input.boardId },
                select: { id: true },
            });
            if (!category) {
                throw new Error("That category doesn't belong to the selected board — refresh and try again.");
            }
            validBoardId = board.id;
            validCategoryId = category.id;
        }

        const product = await tx.productLibraryItem.create({
            data: {
                name: proposal.name,
                description: proposal.description,
                imageUrl: safeImageUrl,
                price: input.price ?? proposal.price ?? null,
                vendorUrl: safeVendorUrl,
                source: "client_proposal",
                clippedById: user.id,
            },
        });
        productId = product.id;

        await tx.selectionProposal.update({
            where: { id: proposalId },
            data: { productId: product.id, boardId: validBoardId, categoryId: validCategoryId },
        });

        // Default true per spec — approving a suggestion pins it to the
        // project's client-visible Favorites list unless explicitly opted out.
        if (input.addToFavorites !== false) {
            await tx.projectProductFavorite.upsert({
                where: { projectId_productId: { projectId: proposal.projectId, productId: product.id } },
                update: {},
                create: {
                    projectId: proposal.projectId,
                    productId: product.id,
                    addedById: null,
                    addedByClient: true,
                },
            });
            favoriteCreated = true;
        }

        // Optional: also drop it into a board category as a pickable option
        // (validCategoryId is only set above once board+category ownership is
        // confirmed). Never touches SelectionBoard.status — approving a
        // suggestion must not silently flip a board back to an earlier
        // lifecycle state.
        if (validCategoryId) {
            const maxOrder = await tx.selectionOption.aggregate({
                where: { categoryId: validCategoryId },
                _max: { order: true },
            });
            await tx.selectionOption.create({
                data: {
                    categoryId: validCategoryId,
                    name: proposal.name,
                    description: proposal.description,
                    imageUrl: safeImageUrl,
                    price: input.price ?? proposal.price ?? null,
                    vendorUrl: safeVendorUrl,
                    order: (maxOrder._max.order ?? -1) + 1,
                },
            });
            optionCreated = true;
        }
    });

    if (alreadyDecided) {
        return { success: false, alreadyDecided: true };
    }

    // Notifications + activity log run AFTER the transaction commits, and a
    // failure here must not throw the whole action into a failed state — the
    // decision is already durably recorded. Same pattern submitClientSelections
    // and the other portal notifiers use (sendNotification never throws on its
    // own, but building the portal link can, so the whole block is wrapped).
    try {
        const clientEmail = proposal.project.client?.email;
        if (clientEmail) {
            const settings = await getCachedCompanySettings();
            const { buildClientPortalUrl } = await import("./client-portal-auth");
            const portalUrl = await buildClientPortalUrl(proposal.project.clientId, clientEmail, `/portal/projects/${proposal.projectId}/selections`);
            const cc = buildCc(clientEmail, (proposal.project.client as any)?.additionalEmail);
            const isApproved = input.action === "approve";
            await sendNotification(
                clientEmail,
                isApproved ? `✅ Your suggestion was approved — ${proposal.project.name}` : `Update on your suggestion — ${proposal.project.name}`,
                `<div style="font-family: sans-serif; color: #333;">
                    <h2>${isApproved ? "Your Suggestion Was Approved" : "Update on Your Suggestion"}</h2>
                    <p>Hi ${proposal.project.client?.name || "there"},</p>
                    <p>Your suggested item "<strong>${proposal.name}</strong>" for <strong>${proposal.project.name}</strong> ${isApproved ? "has been approved and added to your project." : "was not approved this time."}</p>
                    ${pmNote ? `<p style="color:#555;">Note from your project manager: "${pmNote}"</p>` : ""}
                    <p><a href="${portalUrl}" style="display:inline-block;padding:12px 24px;background:#4c9a2a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">View Selections</a></p>
                    <p style="color:#666;font-size:13px;">— ${settings.companyName || "Your Project Team"}</p>
                </div>`,
                undefined,
                { cc, copyToInternal: true }
            );
        }
    } catch (err) {
        console.error("[decideSelectionProposal] client notification failed:", err);
    }

    await logActivity({
        projectId: proposal.projectId,
        actorType: "TEAM",
        actorName: user.name || user.email,
        action: input.action === "approve" ? "approved_selection_suggestion" : "declined_selection_suggestion",
        entityType: "SelectionProposal",
        entityId: proposal.id,
        entityName: proposal.name,
    });

    revalidatePath(`/projects/${proposal.projectId}/selections`);
    revalidatePath(`/portal/projects/${proposal.projectId}/selections`);

    return { success: true, status: newStatus, productId, favoriteCreated, optionCreated };
}

// =============================================
// Decisions — Client Selections Playground, Phase 1
// (docs/specs/client-selections-playground.md)
// =============================================

/**
 * Actor + access resolution shared by the decision-structure mutations below
 * (createDecision, renameDecision, reorderDecisions, deleteDecision,
 * assignItemToDecision) — the spec calls these out as "available to team
 * too" rather than naming separate team actions, so one function serves both
 * callers instead of near-duplicate exports. Staff editing from the team's
 * own Selections tab go through assertActiveStaff + canAccessProject
 * (portal-enabled/showSelections must NOT gate the team's own UI — same
 * reasoning as decideSelectionProposal/getSelectionProposals above). Client
 * callers fall through to assertPortalProjectOwnership, the same gate every
 * other client-facing selections action in this file uses.
 */
export async function assertDecisionActorAccess(projectId: string): Promise<{ isStaff: boolean; clientId: string | null; userId: string | null; actorName: string }> {
    const staffUser = await getCurrentUserWithPermissions();
    if (staffUser) {
        if (!canAccessProject(staffUser, projectId)) throw new Error("Forbidden");
        return { isStaff: true, clientId: null, userId: staffUser.id, actorName: staffUser.name || staffUser.email };
    }
    if (await canUseDevAuthFallback()) {
        const devSession = await getSessionOrDev();
        const devRole = (devSession?.user as { role?: string } | undefined)?.role;
        if (devRole) {
            return { isStaff: true, clientId: null, userId: null, actorName: (devSession?.user as { name?: string } | undefined)?.name || "Team" };
        }
    }
    const { clientId } = await assertPortalProjectOwnership(projectId);
    let actorName = "Client";
    if (clientId) {
        const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
        if (client?.name) actorName = client.name;
    }
    return { isStaff: false, clientId, userId: null, actorName };
}

/** Strip price from a SelectionProposal for any client-facing read — no
 * exceptions, no "unless Chosen" (docs/specs/client-selections-playground.md,
 * "Decisions locked with Justin": GTR controls whether a number appears). */
function stripProposalPrice<T extends { price?: unknown }>(item: T): Omit<T, "price"> {
    const { price, ...rest } = item;
    return rest;
}

/** Strip AI Auto-Sort suggestion fields from any client-facing read — no
 * exceptions (docs/superpowers/plans/2026-07-30-selection-ai-sort.md: "the
 * portal never shows suggestions"). Applied to every portal-facing
 * SelectionProposal read, alongside stripProposalPrice above. */
function stripSuggestionFields<T extends { suggestedDecisionId?: unknown; suggestedAt?: unknown }>(
    item: T,
): Omit<T, "suggestedDecisionId" | "suggestedAt"> {
    const { suggestedDecisionId, suggestedAt, ...rest } = item;
    return rest;
}

// ── Schedule-driven due dates (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md) ──

type DecisionDueDateFields = { dueDate: Date | null; scheduleTaskId: string | null; leadTimeDays: number | null };

/** ONE batched query per page load — never a per-decision lookup (plan's
 * explicit requirement). Only the linked task's startDate is needed for
 * derivation. */
async function loadScheduleTaskStartDates(
    projectId: string,
    decisions: DecisionDueDateFields[],
): Promise<Map<string, Date>> {
    const linkedIds = [...new Set(decisions.map((d) => d.scheduleTaskId).filter((id): id is string => !!id))];
    if (linkedIds.length === 0) return new Map();
    const tasks = await prisma.scheduleTask.findMany({
        where: { projectId, id: { in: linkedIds } },
        select: { id: true, startDate: true },
    });
    return new Map(tasks.map((t) => [t.id, t.startDate]));
}

/** Attaches computed `effectiveDueDate` to every decision, using the batched
 * task lookup above. Raw dueDate/scheduleTaskId/leadTimeDays are left in
 * place here — the STAFF read keeps them (the edit popover needs them);
 * stripDueDateFields (below) removes them for the portal read. */
function attachEffectiveDueDate<T extends DecisionDueDateFields>(
    decision: T,
    taskStartDateById: Map<string, Date>,
): T & { effectiveDueDate: Date | null } {
    return { ...decision, effectiveDueDate: computeEffectiveDueDate(decision, taskStartDateById) };
}

/** STAFF-ONLY enrichment (Codex review round 1, issue 7) — adds `isManual`
 * (a dueDate override is set) and `linkState` ("linked"/"dangling"/"none")
 * so the staff badge can show a "manual" marker and the edit popover can
 * distinguish "never linked" from "was linked, task got deleted" instead of
 * both silently rendering as nothing. NEVER applied to the portal read —
 * that stays effectiveDueDate-only (getProjectDecisionsForPortal does not
 * call this). */
function attachStaffDueDateMeta<T extends DecisionDueDateFields>(
    decision: T,
    taskStartDateById: Map<string, Date>,
): T & { isManual: boolean; linkState: DecisionLinkState } {
    return {
        ...decision,
        isManual: !!decision.dueDate,
        linkState: computeLinkState(decision, taskStartDateById),
    };
}

/** Strip the raw due-date/link fields from any client-facing read — the
 * portal only ever sees the computed `effectiveDueDate`, never whether it
 * came from a manual override or a schedule derivation (extends
 * stripSuggestionFields's pattern: the negative payload assertion covers all
 * three raw field names, so the portal can never infer whether a date was
 * manually set). */
function stripDueDateFields<T extends { dueDate?: unknown; scheduleTaskId?: unknown; leadTimeDays?: unknown }>(
    item: T,
): Omit<T, "dueDate" | "scheduleTaskId" | "leadTimeDays"> {
    const { dueDate, scheduleTaskId, leadTimeDays, ...rest } = item;
    return rest;
}

// ── Order tracking + delivery risk (Phase 4 —
// docs/superpowers/plans/2026-07-31-selection-order-tracking.md) ──────────

/** STAFF-ONLY enrichment — computed delivery risk, reusing the SAME batched
 * schedule-task lookup as the due-date derivation above (no new N+1). Only
 * passes `linkedTaskStartAt` when the schedule link is genuinely live
 * (linkState === "linked") — a dangling/absent link falls back to
 * effectiveDueDate inside assessDeliveryRisk itself, per the plan's spec. */
function attachOrderRisk<T extends {
    status: string;
    expectedArrivalAt: Date | null;
    scheduleTaskId: string | null;
    effectiveDueDate: Date | null;
    linkState: DecisionLinkState;
}>(decision: T, taskStartDateById: Map<string, Date>): T & { risk: DeliveryRisk } {
    const linkedTaskStartAt =
        decision.linkState === "linked" && decision.scheduleTaskId
            ? taskStartDateById.get(decision.scheduleTaskId) ?? null
            : null;
    return {
        ...decision,
        risk: assessDeliveryRisk({
            status: decision.status,
            expectedArrivalAt: decision.expectedArrivalAt,
            linkedTaskStartAt,
            effectiveDueDate: decision.effectiveDueDate,
        }),
    };
}

/** Portal-only derived status — {status, expectedArrivalAt} ONLY when the
 * decision is Ordered/Received; null otherwise (nothing to show). This is
 * the ONLY order-tracking shape the portal ever receives — no risk, no
 * orderedBy, no raw orderedAt/expectedArrivalAt (those are removed by
 * stripOrderFields below, applied AFTER this attach so the derivation still
 * has the raw expectedArrivalAt to read). */
type OrderStatusForPortal = { status: string; expectedArrivalAt: Date | null } | null;

function attachOrderStatusForPortal<T extends { status: string; expectedArrivalAt: Date | null }>(
    decision: T,
): T & { orderStatusForPortal: OrderStatusForPortal } {
    const orderStatusForPortal: OrderStatusForPortal =
        decision.status === "Ordered" || decision.status === "Received"
            ? { status: decision.status, expectedArrivalAt: decision.expectedArrivalAt }
            : null;
    return { ...decision, orderStatusForPortal };
}

/** Strip the raw order-tracking fields from any client-facing read — the
 * portal only ever sees the derived orderStatusForPortal, never who ordered
 * it or the raw timestamps directly (extends stripDueDateFields's pattern —
 * the negative payload assertion covers all three raw field names). */
function stripOrderFields<T extends { orderedAt?: unknown; orderedBy?: unknown; expectedArrivalAt?: unknown }>(
    item: T,
): Omit<T, "orderedAt" | "orderedBy" | "expectedArrivalAt"> {
    const { orderedAt, orderedBy, expectedArrivalAt, ...rest } = item;
    return rest;
}

/** Deploy-window hazard: the old build stays live while
 * apply-selections-playground.mjs's remap runs, so it can still insert new
 * 'Pending'/'Approved'/'Declined' SelectionProposal rows after the remap
 * statements have already passed (and the script may not have been re-run as
 * a post-deploy sweep yet — see the note at the top of that script). Every
 * new read/write path below treats these legacy strings as their playground
 * equivalent defensively, so a straggler row never renders wrong or
 * disappears while it waits to be swept up. */
function normalizeProposalStatus(status: string): string {
    if (status === "Pending") return "Idea";
    if (status === "Approved") return "Chosen";
    if (status === "Declined") return "Archived";
    return status;
}

function normalizeProposal<T extends { status: string }>(item: T): T {
    return { ...item, status: normalizeProposalStatus(item.status) };
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function getProjectDecisionsForPortal(projectId: string) {
    await assertPortalProjectOwnership(projectId);
    const [decisions, unsorted] = await Promise.all([
        prisma.decision.findMany({
            where: { projectId, deletedAt: null },
            orderBy: { sortOrder: "asc" },
            include: { candidates: { where: { deletedAt: null }, orderBy: { createdAt: "asc" }, include: CANDIDATE_COMMENTS_INCLUDE } },
        }),
        prisma.selectionProposal.findMany({
            where: { projectId, decisionId: null, deletedAt: null },
            include: CANDIDATE_COMMENTS_INCLUDE,
            orderBy: { createdAt: "desc" },
        }),
    ]);
    // ONE batched schedule-task lookup for the whole page — never a
    // per-decision query (see loadScheduleTaskStartDates).
    const taskStartDateById = await loadScheduleTaskStartDates(projectId, decisions);
    return {
        decisions: decisions.map((d) => ({
            ...stripOrderFields(stripDueDateFields(attachOrderStatusForPortal(attachEffectiveDueDate(d, taskStartDateById)))),
            candidates: d.candidates.map((c) => withThreadSummary(stripSuggestionFields(stripProposalPrice(normalizeProposal(c))), false)),
        })),
        unsorted: unsorted.map((p) => withThreadSummary(stripSuggestionFields(stripProposalPrice(normalizeProposal(p))), false)),
    };
}

// Attaches parsed comments + the viewer-side unread count to a candidate for
// the thread UI (SelectionItemThread). Shared shape between the staff read
// (below) and the portal read (getProjectDecisionsForPortal). Only the
// fields the UI type actually needs are sent to the browser — internal ids
// (authorUserId/authorClientId) and the opposite side's read timestamps
// never leave the server; unreadThreadCount is derived from them here
// instead of shipping them raw.
function withThreadSummary<T extends { comments: {
    id: string; authorType: string;
    authorName: string; body: string; attachments: string | null; readByTeamAt: Date | null;
    readByClientAt: Date | null; createdAt: Date;
}[] }>(candidate: T, isStaff: boolean) {
    const { comments, ...rest } = candidate;
    return {
        ...rest,
        comments: comments.map((c) => ({
            id: c.id,
            authorType: c.authorType,
            authorName: c.authorName,
            body: c.body,
            attachments: parseThreadAttachments(c.attachments),
            createdAt: c.createdAt,
        })),
        unreadThreadCount: unreadThreadCommentCount(comments, isStaff),
    };
}

// authorUserId/authorClientId are deliberately NOT selected — nothing after
// this fetch needs them (unreadThreadCommentCount only reads
// authorType/readByTeamAt/readByClientAt), and withThreadSummary's job is to
// keep internal ids out of the portal/staff payload in the first place.
const CANDIDATE_COMMENTS_INCLUDE = {
    comments: {
        orderBy: { createdAt: "asc" as const },
        select: {
            id: true,
            authorType: true,
            authorName: true,
            body: true,
            attachments: true,
            readByTeamAt: true,
            readByClientAt: true,
            createdAt: true,
        },
    },
};

export async function getProjectDecisions(projectId: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
    // Team context — price included, unlike getProjectDecisionsForPortal
    // above. Soft-deleted decisions are excluded here too — see
    // getRecentlyDeletedDecisions for the restore tray.
    const [decisions, unsorted] = await Promise.all([
        prisma.decision.findMany({
            where: { projectId, deletedAt: null },
            orderBy: { sortOrder: "asc" },
            include: { candidates: { where: { deletedAt: null }, orderBy: { createdAt: "asc" }, include: CANDIDATE_COMMENTS_INCLUDE } },
        }),
        prisma.selectionProposal.findMany({
            where: { projectId, decisionId: null, deletedAt: null },
            include: CANDIDATE_COMMENTS_INCLUDE,
            orderBy: { createdAt: "desc" },
        }),
    ]);
    // ONE batched schedule-task lookup for the whole page — never a
    // per-decision query (see loadScheduleTaskStartDates).
    const taskStartDateById = await loadScheduleTaskStartDates(projectId, decisions);
    return {
        decisions: decisions.map((d) => ({
            ...attachOrderRisk(attachStaffDueDateMeta(attachEffectiveDueDate(d, taskStartDateById), taskStartDateById), taskStartDateById),
            candidates: d.candidates.map((c) => withThreadSummary(normalizeProposal(c), true)),
        })),
        unsorted: unsorted.map((c) => withThreadSummary(normalizeProposal(c), true)),
    };
}

/** Project schedule tasks for the per-decision edit popover's manual link
 * select (Phase 3 — docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
 * Staff-only, ordered by startDate — the same shape the link-schedule
 * review modal already renders selects from. */
export async function listProjectScheduleTasksForLinking(projectId: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
    return prisma.scheduleTask.findMany({
        where: { projectId },
        orderBy: { startDate: "asc" },
        select: { id: true, name: true, startDate: true },
    });
}

// ── Structure — shared by client + team (see assertDecisionActorAccess) ────

export async function createDecision(projectId: string, data: { name: string; area?: string }) {
    const actor = await assertDecisionActorAccess(projectId);
    const name = data.name?.trim();
    if (!name) throw new Error("Name is required");

    // Codex review (selection-ai-sort new-categories follow-up), issue 1:
    // createDecisionForSuggestion (selection-ai-sort-apply-core.ts) takes the
    // project's advisory lock before reading max sortOrder + creating, but
    // this manual path didn't — a manual create racing an AI-sort "Create
    // <name>" resolution (or another manual create) could read the same
    // max-sortOrder snapshot and both write, producing colliding sortOrder.
    // Same lock, same transaction shape as applyDecisionTemplate/
    // createDecisionForSuggestion. Behavior is otherwise UNCHANGED — manual
    // duplicate names are still allowed (no dedupe check added here); this
    // only closes the ordering race window.
    const decision = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`;

        const maxOrder = await tx.decision.aggregate({ where: { projectId }, _max: { sortOrder: true } });
        return tx.decision.create({
            data: {
                projectId,
                name: name.slice(0, 200),
                area: data.area?.trim() || null,
                createdByClient: !actor.isStaff,
                sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
            },
        });
    });

    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);
    return decision;
}

export async function renameDecision(decisionId: string, name: string) {
    const decision = await prisma.decision.findUnique({ where: { id: decisionId }, select: { projectId: true, deletedAt: true } });
    if (!decision || decision.deletedAt) throw new Error("Decision not found");
    await assertDecisionActorAccess(decision.projectId);

    const trimmed = name?.trim();
    if (!trimmed) throw new Error("Name is required");

    const updated = await prisma.decision.update({
        where: { id: decisionId },
        data: { name: trimmed.slice(0, 200) },
    });

    revalidatePath(`/projects/${decision.projectId}/selections`);
    revalidatePath(`/portal/projects/${decision.projectId}/selections`);
    return updated;
}

export async function updateSelectionItemNote(
    itemId: string,
    note: string,
): Promise<{ success: true; note: string | null }> {
    return persistSelectionItemNote(itemId, note, {
        findItem: (id) =>
            prisma.selectionProposal.findUnique({
                where: { id },
                select: { id: true, projectId: true, deletedAt: true },
            }),
        assertAccess: assertDecisionActorAccess,
        updateNote: async (id, normalizedNote) => {
            // CAS on deletedAt: the findItem check above is non-atomic with
            // this write, so a concurrent soft-delete must make the update
            // match zero rows rather than land a note on a deleted item.
            const updated = await prisma.selectionProposal.updateMany({
                where: { id, deletedAt: null },
                data: { clientNote: normalizedNote },
            });
            if (updated.count === 0) {
                throw new Error("Item not found");
            }
        },
        revalidate: (projectId) => {
            revalidatePath(`/projects/${projectId}/selections`);
            revalidatePath(`/portal/projects/${projectId}/selections`);
        },
    });
}

/** Marks only the comment ids the viewer actually rendered as read for their
 * side. Called from the UI when a thread is expanded. */
export async function markSelectionItemThreadRead(itemId: string, seenCommentIds: string[]): Promise<void> {
    return markSelectionItemThreadReadCore(itemId, seenCommentIds, {
        findItem: findThreadItem,
        assertAccess: assertDecisionActorAccess,
        markRead: async (proposalId, seenIds, isStaff) => {
            // Mirrors the decision-soft-delete guard in createComment
            // (selection-item-thread-dependencies.ts): findThreadItem's
            // check up front and this write are not atomic with each other,
            // so a decision soft-deleted in that window must still make this
            // match zero rows rather than mark a since-invisible thread read.
            const visibleProposal = { OR: [{ decisionId: null }, { decision: { deletedAt: null } }] };
            if (isStaff) {
                await prisma.selectionItemComment.updateMany({
                    where: { proposalId, id: { in: seenIds }, readByTeamAt: null, proposal: visibleProposal },
                    data: { readByTeamAt: new Date() },
                });
            } else {
                await prisma.selectionItemComment.updateMany({
                    where: { proposalId, id: { in: seenIds }, readByClientAt: null, proposal: visibleProposal },
                    data: { readByClientAt: new Date() },
                });
            }
        },
        revalidate: (projectId) => {
            revalidatePath(`/projects/${projectId}/selections`);
            revalidatePath(`/portal/projects/${projectId}/selections`);
            revalidatePath(`/projects/${projectId}`, "layout");
            revalidatePath(`/portal/projects/${projectId}`);
        },
    });
}

export async function reorderDecisions(projectId: string, orderedIds: string[]) {
    await assertDecisionActorAccess(projectId);

    const existing = await prisma.decision.findMany({ where: { projectId, deletedAt: null }, select: { id: true } });
    const validIds = new Set(existing.map((d) => d.id));
    if (orderedIds.some((id) => !validIds.has(id))) {
        throw new Error("One or more decisions don't belong to this project — refresh and try again.");
    }

    await prisma.$transaction(
        orderedIds.map((id, index) => prisma.decision.update({ where: { id }, data: { sortOrder: index } }))
    );

    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);
    return { success: true };
}

export async function deleteDecision(decisionId: string) {
    const decision = await prisma.decision.findUnique({
        where: { id: decisionId },
        select: { projectId: true, status: true, deletedAt: true },
    });
    if (!decision || decision.deletedAt) return { success: false };
    await assertDecisionActorAccess(decision.projectId);

    // Soft delete only. "They can approve and unapprove themselves, delete
    // stuff, it's their playground" (Justin, explicit) — clients can delete
    // ANY decision on their own project, no createdByClient or status
    // restriction. But "lose no customer data" still holds: nothing is
    // actually destroyed. The row and its candidates stay intact with
    // deletedAt set (candidates are left attached rather than scattered to
    // Unsorted, so a restore brings the whole decision back exactly as it
    // was) and every read below filters deletedAt out — invisible to the
    // client, full control preserved. The team can restore within 30 days
    // (getRecentlyDeletedDecisions / restoreDecision below). Any candidate
    // still carrying "Chosen" resets to "Idea" and the decision's own
    // chosenItemId/status reset alongside it, in the same transaction — a
    // deleted decision has no live approved record, and this keeps the
    // chooseItem/unchooseItem invariant (Decided+chosenItemId only ever
    // points at an item actually marked Chosen) true even while deleted.
    //
    // Ordered/Received are terminal — that's the company's purchasing
    // record (Phase 4), not something either side deletes. Codex review
    // round 1 BLOCKER: the guard used to be a plain read-then-check BEFORE
    // this transaction, so a concurrent setDecisionOrderInfo("ordered")
    // landing between the read above and this write would sail through
    // undetected — the decision gets soft-deleted AND its status silently
    // reset to Open, stranding orderedAt/orderedBy/expectedArrivalAt on a
    // now-"Open" row with no CAS ever having rejected the delete. The guard
    // now lives INSIDE the transaction as a CAS (status NOT IN
    // [Ordered,Received], re-evaluated atomically at write time) — a
    // concurrent order landing first makes this updateMany match zero rows,
    // which is treated as "can't delete an ordered decision", same as if
    // the pre-transaction read had already seen it. The reset also nulls
    // the three order fields explicitly as defense-in-depth, even though
    // the CAS should make it structurally impossible for a deleted row to
    // carry them.
    const deleted = await prisma.$transaction(async (tx) => {
        const claim = await tx.decision.updateMany({
            where: { id: decisionId, deletedAt: null, status: { notIn: ["Ordered", "Received"] } },
            data: { deletedAt: new Date(), chosenItemId: null, status: "Open", decidedAt: null, orderedAt: null, orderedBy: null, expectedArrivalAt: null },
        });
        if (claim.count === 0) return false;

        await tx.selectionProposal.updateMany({
            where: { decisionId, status: "Chosen" },
            data: { status: "Idea" },
        });
        return true;
    });

    if (!deleted) {
        throw new Error("This decision has already been ordered — it can't be deleted.");
    }

    revalidatePath(`/projects/${decision.projectId}/selections`);
    revalidatePath(`/portal/projects/${decision.projectId}/selections`);
    return { success: true };
}

export async function assignItemToDecision(itemId: string, decisionId: string | null) {
    const item = await prisma.selectionProposal.findFirst({
        where: { id: itemId, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (!item) throw new Error("Item not found");
    await assertDecisionActorAccess(item.projectId);

    if (decisionId) {
        const decision = await prisma.decision.findFirst({
            where: { id: decisionId, projectId: item.projectId, deletedAt: null },
            select: { id: true },
        });
        if (!decision) throw new Error("That decision doesn't belong to this project — refresh and try again.");
    }

    await prisma.$transaction(async (tx) => {
        // Atomic CAS write, not a separate read-then-write: status:{notIn:
        // [Chosen, Approved]} is evaluated by Postgres against the row's
        // state AT UPDATE TIME (concurrent UPDATEs on the same row always
        // serialize), so this can't be raced past by a chooseItem that
        // claims the item mid-flight — whichever UPDATE lands second
        // re-evaluates the WHERE against the just-committed row and fails to
        // match (count 0) instead of silently moving a decision's approved
        // record out from under it. "Approved" is the legacy-status
        // equivalent of "Chosen" (see normalizeProposalStatus). An item
        // that's Chosen but already sitting in the SAME decision we're
        // "moving" it into is a no-op reassignment — allowed through.
        const claim = await tx.selectionProposal.updateMany({
            where: {
                id: itemId,
                deletedAt: null,
                OR: [
                    { status: { notIn: ["Chosen", "Approved"] } },
                    { status: { in: ["Chosen", "Approved"] }, decisionId },
                ],
            },
            // An assigned (or manually re-filed) item carries no stale AI
            // chip — clear the suggestion in the same write
            // (docs/superpowers/plans/2026-07-30-selection-ai-sort.md).
            data: { decisionId, suggestedDecisionId: null, suggestedAt: null },
        });
        if (claim.count === 0) {
            throw new Error("Un-choose this item before moving it to a different decision.");
        }
    });

    revalidatePath(`/projects/${item.projectId}/selections`);
    revalidatePath(`/portal/projects/${item.projectId}/selections`);
    return { success: true };
}

// ── AI Auto-Sort (docs/superpowers/plans/2026-07-30-selection-ai-sort.md) ──
// Thin "use server" wrappers — the CAS logic lives in
// selection-ai-sort-apply-core.ts (a plain module, no "server-only"
// transitively) so it's importable directly by tests, the same split
// selection-item-thread-core.ts/selection-item-note-persistence-core.ts use.

export async function applySuggestedDecision(itemId: string, decisionId: string): Promise<{ applied: boolean }> {
    return aiSortApplySuggestedDecision(itemId, decisionId);
}

export async function dismissSelectionSuggestion(itemId: string): Promise<{ success: true }> {
    return aiSortDismissSelectionSuggestion(itemId);
}

export async function createDecisionForSuggestion(
    projectId: string,
    name: string,
): Promise<{ decisionId: string; existed: boolean }> {
    return aiSortCreateDecisionForSuggestion(projectId, name);
}

// ── Decision Templates + Schedule-Driven Due Dates (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md) ──
// Thin "use server" wrappers — the CRUD/apply/link logic lives in plain
// (non-"use server") modules so it's importable directly by tests, the same
// split selection-ai-sort-apply-core.ts/selection-item-thread-core.ts use.

export async function createDecisionTemplate(input: DecisionTemplateInput) {
    return createDecisionTemplateCore(input);
}

export async function updateDecisionTemplate(templateId: string, input: DecisionTemplateInput) {
    return updateDecisionTemplateCore(templateId, input);
}

export async function archiveDecisionTemplate(templateId: string) {
    return archiveDecisionTemplateCore(templateId);
}

export async function unarchiveDecisionTemplate(templateId: string) {
    return unarchiveDecisionTemplateCore(templateId);
}

export async function listDecisionTemplates() {
    return listDecisionTemplatesCore();
}

export async function listActiveDecisionTemplatesForApply() {
    return listActiveDecisionTemplatesForApplyCore();
}

export async function applyDecisionTemplate(projectId: string, templateId: string) {
    return applyDecisionTemplateCore(projectId, templateId);
}

export async function linkDecisionToSchedule(
    decisionId: string,
    scheduleTaskId: string | null,
    leadTimeDays: number | null,
) {
    return linkDecisionToScheduleCore(decisionId, scheduleTaskId, leadTimeDays);
}

export async function setDecisionDueDateOverride(decisionId: string, dueDate: Date | null) {
    return setDecisionDueDateOverrideCore(decisionId, dueDate);
}

export async function setDecisionOrderInfo(decisionId: string, input: DecisionOrderInput) {
    return setDecisionOrderInfoCore(decisionId, input);
}

// ── Client-only: choose / un-choose / archive ───────────────────────────────

export async function chooseItem(itemId: string) {
    const item = await prisma.selectionProposal.findFirst({
        where: { id: itemId, deletedAt: null },
        include: { decision: true, project: { include: { client: true } } },
    });
    if (!item) throw new Error("Item not found");
    if (!item.decisionId || !item.decision || item.decision.deletedAt) {
        throw new Error("Add this item to a decision before choosing it.");
    }
    if (["Archived", "Declined"].includes(normalizeProposalStatus(item.status))) {
        throw new Error("This item has been archived — unarchive it before choosing it.");
    }

    await assertPortalProjectOwnership(item.projectId);

    const decisionId = item.decision.id;
    if (item.decision.status === "Ordered" || item.decision.status === "Received") {
        throw new Error("Your team has already ordered this — message them if something needs to change.");
    }

    let alreadyChosen = false;
    let previousChosenItemId: string | null = null;

    // Transactional + CAS-guarded so a double-submit no-ops instead of
    // re-notifying/re-writing. The "already done" signal comes from what
    // THIS transaction observes (freshDecision/freshItem, read here), never
    // from the pre-transaction snapshot above (item.decision) — two
    // concurrent chooseItem calls both trusting that stale snapshot would
    // both compute alreadyChosen=false and both fire the loud team email +
    // activity row. Choosing a DIFFERENT candidate on an already-Decided (or
    // Flagged — chooseItem must work from Flagged per spec) decision is a
    // valid "change of mind" transition, not blocked here; only Ordered/
    // Received are terminal.
    await prisma.$transaction(async (tx) => {
        const freshItem = await tx.selectionProposal.findUnique({
            where: { id: itemId },
            select: { status: true, decisionId: true },
        });
        if (!freshItem || freshItem.decisionId !== decisionId) {
            throw new Error("This item is no longer in that decision — refresh and try again.");
        }
        if (["Archived", "Declined"].includes(normalizeProposalStatus(freshItem.status))) {
            throw new Error("This item has been archived — unarchive it before choosing it.");
        }

        const freshDecision = await tx.decision.findUnique({
            where: { id: decisionId },
            select: { status: true, chosenItemId: true, deletedAt: true },
        });
        if (!freshDecision || freshDecision.deletedAt) throw new Error("Decision not found");
        if (freshDecision.status === "Ordered" || freshDecision.status === "Received") {
            throw new Error("Your team has already ordered this — message them if something needs to change.");
        }
        if (freshDecision.chosenItemId === itemId && freshDecision.status === "Decided") {
            alreadyChosen = true;
            return;
        }

        previousChosenItemId = freshDecision.chosenItemId;

        // Compare-and-swap on the exact pre-image just read inside this
        // transaction: Postgres re-evaluates this WHERE clause against the
        // row's committed state at UPDATE time, so a concurrent
        // chooseItem/unchooseItem/flagDecision racing us can't both "win" —
        // the loser's UPDATE simply fails to match (count 0) once it
        // acquires the row lock after the winner commits.
        const claim = await tx.decision.updateMany({
            where: { id: decisionId, status: freshDecision.status, chosenItemId: freshDecision.chosenItemId },
            data: { chosenItemId: itemId, status: "Decided", decidedAt: new Date() },
        });
        if (claim.count === 0) {
            // Someone else changed this decision between our read and our
            // write. If the race landed on the exact outcome we wanted
            // (duplicate submit), treat it as done instead of erroring.
            const after = await tx.decision.findUnique({ where: { id: decisionId }, select: { status: true, chosenItemId: true } });
            if (after?.chosenItemId === itemId && after.status === "Decided") {
                alreadyChosen = true;
                return;
            }
            throw new Error("This decision just changed — refresh and try again.");
        }

        // A previously-chosen sibling (switching candidates) reverts to Idea
        // — never auto-archived, the runner-up still matters per spec.
        if (previousChosenItemId && previousChosenItemId !== itemId) {
            await tx.selectionProposal.updateMany({
                where: { id: previousChosenItemId, status: "Chosen" },
                data: { status: "Idea" },
            });
        }
        // CAS on the item too, not a blind by-id update: a concurrent
        // assignItemToDecision/archiveItem can commit between our freshItem
        // read above and this write. Pinning decisionId (and excluding
        // Archived) means the item must still belong to THIS decision at
        // write time, so we can never mark a moved/archived candidate Chosen
        // and leave the decision pointing outside its own candidate list.
        const itemClaim = await tx.selectionProposal.updateMany({
            where: { id: itemId, decisionId, deletedAt: null, status: { notIn: ["Archived", "Declined"] } },
            data: { status: "Chosen" },
        });
        if (itemClaim.count === 0) {
            throw new Error("This item just changed — refresh and try again.");
        }
    });

    revalidatePath(`/projects/${item.projectId}/selections`);
    revalidatePath(`/portal/projects/${item.projectId}/selections`);

    if (alreadyChosen) {
        return { success: true, alreadyChosen: true };
    }

    // Notify the team — the loud one, it demands action (Richard buys it).
    // After-commit, non-fatal on failure, same pattern as
    // decideSelectionProposal's client notification block.
    try {
        const settings = await getCachedCompanySettings();
        if (settings.notificationEmail) {
            await sendNotification(
                settings.notificationEmail,
                `Decision made: ${item.decision.name} — ${item.project.name}`,
                `<div style="font-family: sans-serif; color: #333;">
                    <h3>Client Decided</h3>
                    <p><strong>${item.project.client?.name || "Client"}</strong> chose <strong>${item.name}</strong> for "<strong>${item.decision.name}</strong>" on project <strong>${item.project.name}</strong>.</p>
                    <p>This is the approved record — ready to purchase.</p>
                </div>`
            );
        }
    } catch (err) {
        console.error("[chooseItem] team notification failed:", err);
    }

    await logActivity({
        projectId: item.projectId,
        actorType: "CLIENT",
        actorName: item.project.client?.name || "Client",
        action: "chose_decision_item",
        entityType: "Decision",
        entityId: decisionId,
        entityName: `${item.decision.name}: ${item.name}`,
    });

    return { success: true, alreadyChosen: false };
}

export async function unchooseItem(decisionId: string) {
    const decision = await prisma.decision.findUnique({
        where: { id: decisionId },
        include: { project: { include: { client: true } } },
    });
    if (!decision || decision.deletedAt) throw new Error("Decision not found");

    await assertPortalProjectOwnership(decision.projectId);

    if (decision.status === "Ordered" || decision.status === "Received") {
        throw new Error("Your team has already ordered this — message them if something needs to change.");
    }

    let noop = false;

    // Same fix shape as chooseItem above: the "already done" signal comes
    // from a fresh in-tx read, not the pre-transaction snapshot above, so a
    // concurrent double-submit skips the duplicate activity row instead of
    // writing it twice.
    await prisma.$transaction(async (tx) => {
        const freshDecision = await tx.decision.findUnique({
            where: { id: decisionId },
            select: { status: true, chosenItemId: true, deletedAt: true },
        });
        if (!freshDecision || freshDecision.deletedAt) throw new Error("Decision not found");
        if (freshDecision.status === "Ordered" || freshDecision.status === "Received") {
            throw new Error("Your team has already ordered this — message them if something needs to change.");
        }
        if (!freshDecision.chosenItemId) {
            noop = true;
            return;
        }

        const claim = await tx.decision.updateMany({
            where: { id: decisionId, status: freshDecision.status, chosenItemId: freshDecision.chosenItemId },
            data: { chosenItemId: null, status: "Open", decidedAt: null },
        });
        if (claim.count === 0) {
            const after = await tx.decision.findUnique({ where: { id: decisionId }, select: { chosenItemId: true } });
            if (!after?.chosenItemId) {
                noop = true;
                return;
            }
            throw new Error("This decision just changed — refresh and try again.");
        }

        await tx.selectionProposal.updateMany({
            where: { id: freshDecision.chosenItemId, status: "Chosen" },
            data: { status: "Idea" },
        });
    });

    revalidatePath(`/projects/${decision.projectId}/selections`);
    revalidatePath(`/portal/projects/${decision.projectId}/selections`);

    if (!noop) {
        await logActivity({
            projectId: decision.projectId,
            actorType: "CLIENT",
            actorName: decision.project.client?.name || "Client",
            action: "unchose_decision_item",
            entityType: "Decision",
            entityId: decision.id,
            entityName: decision.name,
        });
    }

    return { success: true };
}

export async function archiveItem(itemId: string) {
    const item = await prisma.selectionProposal.findFirst({
        where: { id: itemId, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (!item) throw new Error("Item not found");
    await assertPortalProjectOwnership(item.projectId);

    await prisma.$transaction(async (tx) => {
        // Atomic CAS write: status not in [Chosen, Approved] (the legacy
        // equivalent, see normalizeProposalStatus) is evaluated against the
        // row at UPDATE time, so this can't be raced past by a concurrent
        // chooseItem that just claimed this item as its decision's approved
        // record — see assignItemToDecision above for the same pattern.
        const claim = await tx.selectionProposal.updateMany({
            where: { id: itemId, deletedAt: null, status: { notIn: ["Chosen", "Approved", "Archived"] } },
            data: { status: "Archived" },
        });
        if (claim.count === 0) {
            const fresh = await tx.selectionProposal.findUnique({ where: { id: itemId }, select: { status: true } });
            // Already archived (or the legacy Declined-equivalent) — idempotent no-op.
            if (!fresh || !["Archived", "Declined"].includes(fresh.status)) {
                throw new Error("Un-choose this item before archiving it.");
            }
        }
    });

    revalidatePath(`/projects/${item.projectId}/selections`);
    revalidatePath(`/portal/projects/${item.projectId}/selections`);
    return { success: true };
}

export async function unarchiveItem(itemId: string) {
    const item = await prisma.selectionProposal.findFirst({
        where: { id: itemId, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (!item) throw new Error("Item not found");
    await assertPortalProjectOwnership(item.projectId);

    await prisma.selectionProposal.updateMany({
        where: { id: itemId, deletedAt: null, status: { in: ["Archived", "Declined"] } },
        data: { status: "Idea" },
    });

    revalidatePath(`/projects/${item.projectId}/selections`);
    revalidatePath(`/portal/projects/${item.projectId}/selections`);
    return { success: true };
}

/** Delete an archived item outright from the client's playground.
 *
 * Soft delete only, exactly like deleteDecision: the client sees it gone and
 * every read filters deletedAt out, but the row survives so the team keeps a
 * 30-day restore window (getRecentlyDeletedItems / restoreItem below). "It's
 * their playground" — but "lose no customer data" still holds.
 *
 * Archived-only by design: this sits behind the archive tray, so an item is
 * always one deliberate step (archive) away from deletable. That also keeps
 * the invariant work trivial — an Archived item can't be any decision's
 * chosenItemId, since chooseItem refuses archived rows and archiveItem
 * refuses chosen ones. The CAS below re-checks that at UPDATE time rather
 * than trusting the read above, so a concurrent unarchive→choose can't slip a
 * live approved record out from under the delete. */
export async function deleteItem(itemId: string) {
    const item = await prisma.selectionProposal.findFirst({
        where: { id: itemId, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (!item) return { success: false };
    await assertPortalProjectOwnership(item.projectId);

    const claim = await prisma.selectionProposal.updateMany({
        where: { id: itemId, deletedAt: null, status: { in: ["Archived", "Declined"] } },
        data: { deletedAt: new Date() },
    });
    if (claim.count === 0) {
        throw new Error("Archive this item before deleting it.");
    }

    revalidatePath(`/projects/${item.projectId}/selections`);
    revalidatePath(`/portal/projects/${item.projectId}/selections`);
    return { success: true };
}

/** Team-only restore of a soft-deleted item. Comes back Archived (where it
 * was when the client deleted it), not Idea — restoring shouldn't quietly put
 * an item the client threw away back among their live options. Its decision
 * link is untouched, so it lands back in the same archive tray it left. */
export async function restoreItem(itemId: string) {
    const item = await prisma.selectionProposal.findUnique({
        where: { id: itemId },
        select: { id: true, projectId: true, deletedAt: true },
    });
    if (!item) throw new Error("Item not found");
    if (!item.deletedAt) return { success: true };

    const user = await assertActiveStaff();
    if (!canAccessProject(user, item.projectId)) throw new Error("Forbidden");

    await prisma.selectionProposal.updateMany({
        where: { id: itemId, deletedAt: { not: null } },
        data: { deletedAt: null, status: "Archived" },
    });

    revalidatePath(`/projects/${item.projectId}/selections`);
    revalidatePath(`/portal/projects/${item.projectId}/selections`);
    return { success: true };
}

// ── Team-only ────────────────────────────────────────────────────────────

const RECENTLY_DELETED_WINDOW_DAYS = 30;

/** Decisions a client (or team member) soft-deleted in the last 30 days —
 * the "recently deleted" restore tray. deleteDecision never hard-deletes, so
 * this is a plain filtered read, not a recovery from anywhere else. */
export async function getRecentlyDeletedDecisions(projectId: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");

    const cutoff = new Date(Date.now() - RECENTLY_DELETED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const decisions = await prisma.decision.findMany({
        where: { projectId, deletedAt: { not: null, gte: cutoff } },
        orderBy: { deletedAt: "desc" },
        include: { candidates: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } } },
    });
    return decisions;
}

/** Individual items a client soft-deleted from their archive in the last 30
 * days — the item half of the same restore tray (see deleteItem). Deliberately
 * excludes items that merely sit inside a soft-deleted DECISION: those are
 * still live rows, restored as a set by restoreDecision, and listing them
 * separately would offer a restore that puts an item back into a decision the
 * client can't see. */
export async function getRecentlyDeletedItems(projectId: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");

    const cutoff = new Date(Date.now() - RECENTLY_DELETED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return prisma.selectionProposal.findMany({
        where: { projectId, deletedAt: { not: null, gte: cutoff } },
        orderBy: { deletedAt: "desc" },
        include: { decision: { select: { id: true, name: true, deletedAt: true } } },
    });
}

export async function restoreDecision(decisionId: string) {
    const decision = await prisma.decision.findUnique({
        where: { id: decisionId },
        select: { projectId: true, deletedAt: true },
    });
    if (!decision) throw new Error("Decision not found");
    const user = await assertActiveStaff();
    if (!canAccessProject(user, decision.projectId)) throw new Error("Forbidden");
    if (!decision.deletedAt) {
        return { success: true }; // already live — idempotent no-op
    }

    // Defense-in-depth (Codex review round 1, BLOCKER follow-up): deleteDecision's
    // CAS fix means a soft-deleted row can never carry order fields today,
    // but null them explicitly here too so a restore is provably clean
    // regardless of how the row got deleted.
    await prisma.decision.update({ where: { id: decisionId }, data: { deletedAt: null, orderedAt: null, orderedBy: null, expectedArrivalAt: null } });

    revalidatePath(`/projects/${decision.projectId}/selections`);
    revalidatePath(`/portal/projects/${decision.projectId}/selections`);

    await logActivity({
        projectId: decision.projectId,
        actorType: "TEAM",
        actorName: user.name || user.email,
        action: "restored_decision",
        entityType: "Decision",
        entityId: decisionId,
    });

    return { success: true };
}

export async function flagDecision(decisionId: string, pmNote: string) {
    const user = await assertActiveStaff();
    const decision = await prisma.decision.findUnique({
        where: { id: decisionId },
        include: { project: { include: { client: true } }, chosenItem: true },
    });
    if (!decision || decision.deletedAt) throw new Error("Decision not found");
    if (!canAccessProject(user, decision.projectId)) throw new Error("Forbidden");

    const trimmedNote = pmNote?.trim();
    if (!trimmedNote) throw new Error("A note is required so the client knows what to look at.");

    // Only a Decided item can be flagged. chosenItemId is deliberately kept
    // (not cleared) so the client still sees what was flagged — this is a
    // flag, not a veto; it reopens the decision, chooseItem then works again
    // from Flagged (see chooseItem above).
    const claim = await prisma.decision.updateMany({
        where: { id: decisionId, status: "Decided" },
        data: { status: "Flagged", pmNote: trimmedNote },
    });
    if (claim.count === 0) {
        throw new Error("Only a decided item can be flagged.");
    }

    revalidatePath(`/projects/${decision.projectId}/selections`);
    revalidatePath(`/portal/projects/${decision.projectId}/selections`);

    // Client email — "Team flags → client email" per the notifications rule.
    try {
        const clientEmail = decision.project.client?.email;
        if (clientEmail) {
            const settings = await getCachedCompanySettings();
            const { buildClientPortalUrl } = await import("./client-portal-auth");
            const portalUrl = await buildClientPortalUrl(decision.project.clientId, clientEmail, `/portal/projects/${decision.projectId}/selections`);
            const cc = buildCc(clientEmail, (decision.project.client as any)?.additionalEmail);
            await sendNotification(
                clientEmail,
                `A look is needed — ${decision.name} (${decision.project.name})`,
                `<div style="font-family: sans-serif; color: #333;">
                    <h2>Your Team Flagged a Decision</h2>
                    <p>Hi ${decision.project.client?.name || "there"},</p>
                    <p>Your team wants a second look at "<strong>${decision.name}</strong>"${decision.chosenItem ? ` — <strong>${decision.chosenItem.name}</strong>` : ""} on <strong>${decision.project.name}</strong>.</p>
                    <p style="color:#555;">Note: "${trimmedNote}"</p>
                    <p><a href="${portalUrl}" style="display:inline-block;padding:12px 24px;background:#4c9a2a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Review It</a></p>
                    <p style="color:#666;font-size:13px;">— ${settings.companyName || "Your Project Team"}</p>
                </div>`,
                undefined,
                { cc, copyToInternal: true }
            );
        }
    } catch (err) {
        console.error("[flagDecision] client notification failed:", err);
    }

    await logActivity({
        projectId: decision.projectId,
        actorType: "TEAM",
        actorName: user.name || user.email,
        action: "flagged_decision",
        entityType: "Decision",
        entityId: decision.id,
        entityName: decision.name,
    });

    return { success: true };
}

export async function addTeamCandidate(decisionId: string | null, data: {
    name: string;
    description?: string;
    imageUrl?: string;
    price?: number;
    vendorUrl?: string;
    clientNote?: string;
    projectId?: string;
}) {
    const user = await assertActiveStaff();

    let projectId: string;
    if (decisionId) {
        const decision = await prisma.decision.findUnique({ where: { id: decisionId }, select: { id: true, projectId: true, deletedAt: true } });
        if (!decision || decision.deletedAt) throw new Error("Decision not found");
        projectId = decision.projectId;
    } else {
        if (!data.projectId) throw new Error("projectId is required when not adding into a decision");
        projectId = data.projectId;
    }
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");

    const name = data.name?.trim();
    if (!name) throw new Error("Name is required");

    // A peer candidate ("Richard suggests") — ungated like any other
    // candidate, lands as Idea alongside the client's own picks.
    const candidate = await prisma.selectionProposal.create({
        data: {
            projectId,
            decisionId: decisionId || null,
            name: name.slice(0, 200),
            description: data.description?.trim() || null,
            imageUrl: safeUrlOrNull(data.imageUrl),
            price: data.price ?? null,
            vendorUrl: safeUrlOrNull(data.vendorUrl),
            clientNote: normalizeSelectionItemNote(data.clientNote ?? ""),
            status: "Idea",
        },
    });

    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);

    await logActivity({
        projectId,
        actorType: "TEAM",
        actorName: user.name || user.email,
        action: "added_team_candidate",
        entityType: "SelectionProposal",
        entityId: candidate.id,
        entityName: candidate.name,
    });

    // price is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(candidate));
}

export async function importBoardPicksAsDecisions(projectId: string) {
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");

    const boards = await prisma.selectionBoard.findMany({
        where: { projectId },
        include: { categories: { include: { options: true } } },
    });

    const importable = boards
        .flatMap((b) => b.categories)
        .map((cat) => ({ cat, chosen: cat.options.find((o) => o.selected) }))
        .filter((x): x is { cat: typeof x.cat; chosen: NonNullable<typeof x.chosen> } => !!x.chosen);

    if (importable.length === 0) {
        return { created: 0, skipped: 0 };
    }

    // Guard re-runs with a stable marker (Decision.templateKey, reused here
    // for board-import provenance rather than adding a new column) rather
    // than matching on name — two categories could share a name, and the
    // client may separately have their own decision with the same name.
    const markers = importable.map(({ cat }) => `board-import:${cat.id}`);
    const existing = await prisma.decision.findMany({
        where: { projectId, templateKey: { in: markers } },
        select: { templateKey: true },
    });
    const alreadyImported = new Set(existing.map((d) => d.templateKey));

    const maxOrderRow = await prisma.decision.aggregate({ where: { projectId }, _max: { sortOrder: true } });
    let nextOrder = (maxOrderRow._max.sortOrder ?? -1) + 1;

    let created = 0;
    let skipped = 0;

    for (const { cat, chosen } of importable) {
        const marker = `board-import:${cat.id}`;
        if (alreadyImported.has(marker)) {
            skipped++;
            continue;
        }
        const sortOrder = nextOrder++;
        try {
            // Source board/category/option rows are only ever read here,
            // never written — the mirror is a brand-new SelectionProposal +
            // Decision. The pre-read alreadyImported check above is just an
            // optimization; the authoritative idempotency guard is the
            // Decision(projectId, templateKey) unique constraint — a
            // concurrent second click racing this same loop hits P2002 on
            // the decision.create below and the whole transaction rolls
            // back (including the just-created proposal), so it's caught
            // and counted as skipped rather than double-creating.
            await prisma.$transaction(async (tx) => {
                const proposal = await tx.selectionProposal.create({
                    data: {
                        projectId,
                        name: chosen.name,
                        description: chosen.description,
                        imageUrl: safeUrlOrNull(chosen.imageUrl),
                        price: chosen.price ?? null,
                        vendorUrl: safeUrlOrNull(chosen.vendorUrl),
                        status: "Chosen",
                    },
                });
                const decision = await tx.decision.create({
                    data: {
                        projectId,
                        name: cat.name,
                        status: "Decided",
                        chosenItemId: proposal.id,
                        decidedAt: new Date(),
                        templateKey: marker,
                        createdByClient: false,
                        sortOrder,
                    },
                });
                await tx.selectionProposal.update({ where: { id: proposal.id }, data: { decisionId: decision.id } });
            });
            created++;
        } catch (e: any) {
            if (e?.code === "P2002") {
                skipped++;
                continue;
            }
            throw e;
        }
    }

    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);

    await logActivity({
        projectId,
        actorType: "TEAM",
        actorName: user.name || user.email,
        action: "imported_board_picks_as_decisions",
        entityType: "Decision",
        entityName: `${created} imported${skipped ? `, ${skipped} skipped` : ""}`,
    });

    return { created, skipped };
}

// =============================================
// Daily Logs CRUD
// =============================================

async function assertDailyLogAccess(projectId: string) {
    const session = await getSessionOrDev();
    const sessionUserId = (session?.user as any)?.id as string | null | undefined;
    if (!sessionUserId) throw new Error("Unauthorized");

    const user = await prisma.user.findUnique({
        where: { id: sessionUserId },
        include: {
            permissions: true,
            projectAccess: { select: { projectId: true } },
            assignedProjects: { select: { id: true } },
        },
    });
    if (!user || user.status === "DISABLED") throw new Error("Unauthorized");
    if (!hasPermission(user, "dailyLogs") || !canAccessProject(user, projectId)) throw new Error("Forbidden");
    return user;
}

export async function getDailyLogs(projectId: string) {
    // Hardened (dispatch-arc foundation): require daily-log permission and project access before reading logs.
    await assertDailyLogAccess(projectId);
    const logs = await prisma.dailyLog.findMany({
        where: { projectId },
        orderBy: { date: "desc" },
        include: {
            createdBy: { select: { id: true, name: true, email: true } },
            photos: { orderBy: { createdAt: "asc" } },
        },
    });
    return logs.map(log => {
        const sharedPhotoIds = log.photos
            .filter(photo => photo.sharedToPortal)
            .map(photo => photo.id);
        const currentHash = computeDailyLogSharedContentHash(
            log.workPerformed,
            sharedPhotoIds,
        );
        return {
            ...log,
            sharedPhotoIds,
            portalShareValid: log.sharedToPortal
                && Boolean(log.sharedContentHash)
                && log.sharedContentHash === currentHash,
        };
    });
}

export async function getDailyLog(id: string) {
    // Hardened (dispatch-arc foundation): resolve the log's project before authorizing the read.
    const target = await prisma.dailyLog.findUnique({ where: { id }, select: { projectId: true } });
    if (!target) return null;
    await assertDailyLogAccess(target.projectId);
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
    nextSteps?: string;
    photoUrls?: { url: string; caption?: string }[];
}) {
    // Hardened (dispatch-arc foundation): derive the author from an authorized staff session.
    const author = await assertDailyLogAccess(projectId);
    const log = await createDailyLogCore({
        projectId,
        actorUserId: author.id,
        ...data,
    });

    // Best-effort enrichment after the response: pin the AI task match on the
    // log, then post the summary (with tomorrow's task) to the project's Chat
    // space. Neither may block or fail the log write.
    runAfterRequest(async () => {
        await runDailyLogTaskMatch(log.id);
        await postDailyLogSummary(log.id);
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
    nextSteps?: string;
}) {
    // Hardened (dispatch-arc foundation): authorize against the persisted log project before updating.
    const target = await prisma.dailyLog.findUnique({ where: { id }, select: { projectId: true } });
    if (!target) throw new Error("Daily log not found");
    await assertDailyLogAccess(target.projectId);
    const updateData: any = {};
    if (data.date !== undefined) updateData.date = new Date(data.date);
    if (data.weather !== undefined) updateData.weather = data.weather || null;
    if (data.crewOnSite !== undefined) updateData.crewOnSite = data.crewOnSite || null;
    if (data.workPerformed !== undefined) {
        updateData.workPerformed = data.workPerformed;
        // Content approval is a snapshot. Any work-text edit requires a
        // manager to re-share, even if the new string happens to be similar.
        updateData.sharedContentHash = null;
    }
    if (data.materialsDelivered !== undefined) updateData.materialsDelivered = data.materialsDelivered || null;
    if (data.issues !== undefined) updateData.issues = data.issues || null;
    if (data.nextSteps !== undefined) updateData.nextSteps = data.nextSteps || null;

    const log = await prisma.dailyLog.update({
        where: { id },
        data: updateData,
    });

    // Re-run the task match on any edit; re-post to Chat only when the
    // narrative fields changed (a weather/date touch-up shouldn't re-ping the
    // whole crew space).
    const narrativeChanged = data.workPerformed !== undefined
        || data.nextSteps !== undefined
        || data.issues !== undefined;
    runAfterRequest(async () => {
        await runDailyLogTaskMatch(log.id);
        if (narrativeChanged) await postDailyLogSummary(log.id);
    });

    revalidatePath(`/projects/${log.projectId}/dailylogs`);
    return log;
}

export async function deleteDailyLog(id: string) {
    // Hardened (dispatch-arc foundation): authorize against the persisted log project before deleting.
    const log = await prisma.dailyLog.findUnique({ where: { id }, select: { projectId: true } });
    if (!log) return { success: false };
    await assertDailyLogAccess(log.projectId);

    await prisma.dailyLog.delete({ where: { id } });
    revalidatePath(`/projects/${log.projectId}/dailylogs`);
    return { success: true };
}

export async function addDailyLogPhotos(dailyLogId: string, photos: { url: string; caption?: string }[]) {
    // Hardened (dispatch-arc foundation): authorize against the persisted log project before adding photos.
    const log = await prisma.dailyLog.findUnique({ where: { id: dailyLogId }, select: { projectId: true } });
    if (!log) throw new Error("Daily log not found");
    await assertDailyLogAccess(log.projectId);

    await prisma.dailyLogPhoto.createMany({
        data: photos.map(p => ({
            dailyLogId,
            url: p.url,
            caption: p.caption || null,
        })),
    });
    // Bump the log row: its updatedAt versions the content for the matcher's
    // atomic stale-store guard, and photo rows alone don't touch it.
    await prisma.dailyLog.update({ where: { id: dailyLogId }, data: { updatedAt: new Date() } });

    // Photos are matcher evidence — refresh the pick. No Chat re-post for
    // photo-only mutations.
    runAfterRequest(() => runDailyLogTaskMatch(dailyLogId));

    revalidatePath(`/projects/${log.projectId}/dailylogs`);
    return { success: true };
}

export async function deleteDailyLogPhoto(photoId: string) {
    // Hardened (dispatch-arc foundation): authorize against the photo's persisted log project before deleting.
    const photo = await prisma.dailyLogPhoto.findUnique({
        where: { id: photoId },
        include: { dailyLog: { select: { id: true, projectId: true } } },
    });
    if (!photo) return { success: false };
    await assertDailyLogAccess(photo.dailyLog.projectId);

    await prisma.$transaction(async tx => {
        await tx.dailyLogPhoto.delete({ where: { id: photoId } });
        // Bump the log row regardless: updatedAt versions the content for the
        // matcher's atomic stale-store guard.
        await tx.dailyLog.update({
            where: { id: photo.dailyLog.id },
            data: photo.sharedToPortal ? { sharedContentHash: null, updatedAt: new Date() } : { updatedAt: new Date() },
        });
    });

    // Photos are matcher evidence — refresh the pick after removal too.
    runAfterRequest(() => runDailyLogTaskMatch(photo.dailyLog.id));

    revalidatePath(`/projects/${photo.dailyLog.projectId}/dailylogs`);
    return { success: true };
}

export async function setDailyLogPortalShare(
    logId: string,
    input: { shared: boolean; photoIds: string[] },
) {
    const session = await getSessionOrDev();
    const role = ((session?.user as any)?.role as string | null) ?? null;
    if (!role || !["ADMIN", "MANAGER"].includes(role)) throw new Error("Forbidden");

    const target = await prisma.dailyLog.findUnique({
        where: { id: logId },
        select: { projectId: true },
    });
    if (!target) throw new Error("Daily log not found");
    await assertDailyLogAccess(target.projectId);

    const userId = ((session?.user as any)?.id as string | null) ?? null;
    const actorName = session?.user?.name || session?.user?.email || "Team member";
    const result = await setDailyLogPortalShareCore(
        logId,
        input,
        {
            userId: userId || "session",
            role,
            name: actorName,
        },
    );

    revalidatePath(`/projects/${target.projectId}/dailylogs`);
    revalidatePath(`/portal/projects/${target.projectId}`);
    return result;
}

// Staff pin for the client portal project route: forces which stage reads as
// "current" (earlier stages read done) when the schedule's keyword inference
// lags reality. Pass null to clear and return to task-derived position.
export async function setPortalStageOverride(projectId: string, stageLabel: string | null) {
    const session = await getSessionOrDev();
    const role = ((session?.user as any)?.role as string | null) ?? null;
    if (!role || !["ADMIN", "MANAGER"].includes(role)) throw new Error("Forbidden");

    if (stageLabel !== null && !CLIENT_STAGES.some(stage => stage.label === stageLabel)) {
        throw new Error(`Unknown stage: ${stageLabel}`);
    }

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, portalStageOverride: true },
    });
    if (!project) throw new Error("Project not found");
    if (project.portalStageOverride === stageLabel) return { stageLabel };

    await prisma.project.update({
        where: { id: projectId },
        data: { portalStageOverride: stageLabel },
    });

    await logActivity({
        projectId,
        actorType: "TEAM",
        actorName: session?.user?.name || session?.user?.email || "Team member",
        action: stageLabel ? "set_portal_stage_override" : "cleared_portal_stage_override",
        entityType: "project",
        entityId: projectId,
        entityName: project.name,
        metadata: { from: project.portalStageOverride, to: stageLabel },
    });

    revalidatePath(`/portal/projects/${projectId}`);
    revalidatePath(`/projects/${projectId}`);
    return { stageLabel };
}

// =============================================
// Mood Boards (Visual Canvas)
// =============================================

export async function getMoodBoards(projectId: string) {
    await assertProjectReadAccess(projectId);
    return await prisma.moodBoard.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        include: { items: true },
    });
}

export async function getMoodBoard(id: string) {
    // Look up just the projectId to assert access on before loading the full
    // board (items + project + client) — avoids fetching data the caller may
    // not be authorized to see.
    const boardRef = await prisma.moodBoard.findUnique({
        where: { id },
        select: { projectId: true },
    });
    if (!boardRef) return null;
    await assertProjectReadAccess(boardRef.projectId);

    return await prisma.moodBoard.findUnique({
        where: { id },
        include: { items: true, project: { include: { client: true } } },
    });
}

export async function createMoodBoard(projectId: string, title: string) {
    await assertActiveStaff();
    const board = await prisma.moodBoard.create({
        data: { projectId, title },
    });
    revalidatePath(`/projects/${projectId}/mood-boards`);
    return board;
}

export async function deleteMoodBoard(id: string) {
    await assertActiveStaff();
    const board = await prisma.moodBoard.findUnique({ where: { id } });
    if (!board) return { success: false };
    await prisma.moodBoard.delete({ where: { id } });
    revalidatePath(`/projects/${board.projectId}/mood-boards`);
    return { success: true };
}

// deletedIds: ids the staff editor removed locally since it loaded the board.
// Only these are deleted server-side (filtered to ids actually belonging to
// this board) — the old "delete everything not in the submitted array"
// behavior would silently wipe items a client added via the portal after the
// staff editor's initial load (see portalAddMoodBoardItem below).
export async function saveMoodBoardItems(boardId: string, items: Array<{
    id?: string;
    type: string;
    content: string;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
}>, deletedIds?: string[]) {
    await assertActiveStaff();

    const board = await prisma.moodBoard.findUnique({ where: { id: boardId } });
    if (!board) throw new Error("Board not found");

    const skippedIds: string[] = [];

    await prisma.$transaction(async (tx) => {
        if (deletedIds && deletedIds.length > 0) {
            await tx.moodBoardItem.deleteMany({
                where: {
                    moodBoardId: boardId,
                    id: { in: deletedIds },
                },
            });
        }

        for (const item of items) {
            if (item.id && !item.id.startsWith("temp-")) {
                // updateMany (not update) so this is scoped to moodBoardId as
                // well as id: an item the client deleted concurrently is
                // silently skipped (matchCount 0) instead of throwing and
                // rolling back the whole save, and a forged id belonging to
                // another board is a no-op rather than cross-board writes.
                const updated = await tx.moodBoardItem.updateMany({
                    where: { id: item.id, moodBoardId: boardId },
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
                if (updated.count === 0) skippedIds.push(item.id);
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

    // Return the persisted, ordered item list (real DB ids) so the caller can
    // replace its local state — the editor re-sends "temp-*" ids on every
    // save, so without this the client can't tell which temp ids became which
    // real ids and would recreate them on the next save.
    const persisted = await prisma.moodBoardItem.findMany({
        where: { moodBoardId: boardId },
        orderBy: { createdAt: "asc" },
    });
    return { success: true, items: persisted, skippedIds };
}

// ── Portal collaborative mood board actions ─────────────────────────────────
// Staff and client share the same board: both can arrange (move/resize) any
// item, but only the client's own added items (or staff, always) can delete
// a given item. See assertPortalMoodBoardAccess above.

const MOODBOARD_ITEM_TYPES = ["IMAGE", "TEXT", "SWATCH"] as const;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function clampMoodBoardCoord(value: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(5000, Math.max(0, n));
}

function clampMoodBoardSize(value: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 40;
    return Math.min(2000, Math.max(40, n));
}

function clampMoodBoardZIndex(value: number): number {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 1;
    return Math.min(100000, Math.max(1, n));
}

export async function portalAddMoodBoardItem(boardId: string, data: {
    type: string;
    content: string;
    x: number;
    y: number;
    width: number;
    height: number;
}) {
    const board = await prisma.moodBoard.findUnique({ where: { id: boardId } });
    if (!board) throw new Error("Board not found");
    const { isStaff } = await assertPortalMoodBoardAccess(board.projectId);

    if (!MOODBOARD_ITEM_TYPES.includes(data.type as any)) {
        throw new Error("Invalid item type");
    }

    let content: string;
    if (data.type === "IMAGE") {
        if (!isHttpUrl(data.content)) throw new Error("Invalid image URL");
        content = data.content;
    } else if (data.type === "SWATCH") {
        if (!HEX_COLOR_RE.test(data.content?.trim() || "")) throw new Error("Invalid color — use a 6-digit hex code like #3b82f6");
        content = data.content.trim();
    } else {
        const trimmed = (data.content || "").trim();
        if (!trimmed) throw new Error("Note text is required");
        if (trimmed.length > 500) throw new Error("Note text must be 500 characters or fewer");
        content = trimmed;
    }

    const maxZ = await prisma.moodBoardItem.aggregate({
        where: { moodBoardId: boardId },
        _max: { zIndex: true },
    });

    const item = await prisma.moodBoardItem.create({
        data: {
            moodBoardId: boardId,
            type: data.type,
            content,
            x: clampMoodBoardCoord(data.x),
            y: clampMoodBoardCoord(data.y),
            width: clampMoodBoardSize(data.width),
            height: clampMoodBoardSize(data.height),
            zIndex: (maxZ._max.zIndex ?? 0) + 1,
            addedByClient: !isStaff,
        },
    });

    revalidatePath(`/portal/projects/${board.projectId}/mood-boards/${boardId}`);
    return item;
}

export async function portalMoveMoodBoardItem(boardId: string, itemId: string, data: {
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex?: number;
}) {
    const item = await prisma.moodBoardItem.findUnique({ where: { id: itemId } });
    if (!item || item.moodBoardId !== boardId) throw new Error("Item not found");

    const board = await prisma.moodBoard.findUnique({ where: { id: boardId } });
    if (!board) throw new Error("Board not found");
    await assertPortalMoodBoardAccess(board.projectId);

    const updated = await prisma.moodBoardItem.update({
        where: { id: itemId },
        data: {
            x: clampMoodBoardCoord(data.x),
            y: clampMoodBoardCoord(data.y),
            width: clampMoodBoardSize(data.width),
            height: clampMoodBoardSize(data.height),
            ...(data.zIndex != null ? { zIndex: clampMoodBoardZIndex(data.zIndex) } : {}),
        },
    });

    revalidatePath(`/portal/projects/${board.projectId}/mood-boards/${boardId}`);
    return updated;
}

export async function portalDeleteMoodBoardItem(boardId: string, itemId: string) {
    const item = await prisma.moodBoardItem.findUnique({ where: { id: itemId } });
    if (!item || item.moodBoardId !== boardId) throw new Error("Item not found");

    const board = await prisma.moodBoard.findUnique({ where: { id: boardId } });
    if (!board) throw new Error("Board not found");
    const { isStaff } = await assertPortalMoodBoardAccess(board.projectId);

    if (!isStaff && !item.addedByClient) {
        throw new Error("Only items you added can be removed.");
    }

    await prisma.moodBoardItem.delete({ where: { id: itemId } });
    revalidatePath(`/portal/projects/${board.projectId}/mood-boards/${boardId}`);
    return { success: true };
}

export async function portalCreateMoodBoard(projectId: string, title: string) {
    await assertPortalMoodBoardAccess(projectId);

    const trimmed = title?.trim();
    if (!trimmed) throw new Error("Title is required");
    if (trimmed.length > 120) throw new Error("Title must be 120 characters or fewer");

    const board = await prisma.moodBoard.create({
        data: { projectId, title: trimmed },
    });

    revalidatePath(`/portal/projects/${projectId}/mood-boards`);
    revalidatePath(`/projects/${projectId}/mood-boards`);
    return board;
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
    // unitCost is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(item));
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
    // unitCost is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(item));
}

export async function deleteCatalogItem(id: string) {
    "use server";
    await prisma.catalogItem.delete({ where: { id } });
    revalidatePath("/company/my-items");
    return { success: true };
}

// ─── Lead Schedule ────────────────────────────────────────────────────────

export async function getLeadScheduleTasks(leadId: string) {
    await assertLeadScheduleAccess(leadId);
    return prisma.scheduleTask.findMany({
        where: { leadId },
        orderBy: { order: "asc" },
    });
}

// Runtime validation for lead task fields — the TS signature is not enforced on
// a forged Server Action call, so every accepted value gets checked here.
function leadTaskName(value: unknown): string {
    const name = typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, 200) : "";
    if (!name) throw new Error("Task name is required");
    return name;
}

function leadTaskDate(value: unknown, label: string): Date {
    const date = value instanceof Date ? value : (typeof value === "string" ? new Date(value) : null);
    if (!date || isNaN(date.getTime())) throw new Error(`Invalid ${label}`);
    return date;
}

function leadTaskStatus(value: unknown): string {
    if (!(SCHEDULE_TASK_STATUSES as readonly string[]).includes(value as string)) {
        throw new Error(`Invalid schedule task status "${value}"`);
    }
    return value as string;
}

export async function createLeadScheduleTask(leadId: string, data: {
    name: string;
    startDate: Date;
    endDate: Date;
}) {
    "use server";
    await assertLeadScheduleAccess(leadId);
    const name = leadTaskName(data.name);
    const startDate = leadTaskDate(data.startDate, "start date");
    const endDate = leadTaskDate(data.endDate, "end date");
    if (endDate < startDate) throw new Error("Task end date cannot be before its start date");
    const task = await prisma.scheduleTask.create({
        data: { leadId, name, startDate, endDate },
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
    await assertLeadScheduleAccess(leadId);
    // Whitelist fields explicitly — a forged Server Action call can carry extra
    // properties (leadId, projectId, order, ...) that the TS signature doesn't
    // stop at runtime. The leadId in the where keeps the ownership check and the
    // write atomic (no re-parent race between check and update).
    const update: { name?: string; status?: string; startDate?: Date; endDate?: Date } = {};
    if (data.name !== undefined) update.name = leadTaskName(data.name);
    if (data.status !== undefined) update.status = leadTaskStatus(data.status);
    if (data.startDate !== undefined) update.startDate = leadTaskDate(data.startDate, "start date");
    if (data.endDate !== undefined) update.endDate = leadTaskDate(data.endDate, "end date");
    if (update.startDate || update.endDate) {
        let start = update.startDate;
        let end = update.endDate;
        if (!start || !end) {
            const persisted = await prisma.scheduleTask.findFirst({
                where: { id: taskId, leadId },
                select: { startDate: true, endDate: true },
            });
            if (!persisted) throw new Error("Task not found");
            start = start ?? persisted.startDate;
            end = end ?? persisted.endDate;
        }
        if (end < start) throw new Error("Task end date cannot be before its start date");
    }
    let task;
    try {
        task = await prisma.scheduleTask.update({
            where: { id: taskId, leadId },
            data: update,
        });
    } catch (e) {
        if ((e as { code?: string })?.code === "P2025") throw new Error("Task not found");
        throw e;
    }
    revalidatePath(`/leads/${leadId}/schedule`);
    return task;
}

export async function deleteLeadScheduleTask(taskId: string, leadId: string) {
    "use server";
    await assertLeadScheduleAccess(leadId);
    const deleted = await prisma.scheduleTask.deleteMany({ where: { id: taskId, leadId } });
    if (deleted.count === 0) throw new Error("Task not found");
    revalidatePath(`/leads/${leadId}/schedule`);
    return { success: true };
}

// ─── Bid Packages ─────────────────────────────────────────────────────────

export async function getProjectBidPackages(projectId: string) {
    await assertFinancialProjectAccess(projectId);
    return prisma.bidPackage.findMany({
        where: { projectId },
        include: { scopes: { orderBy: { order: "asc" } }, invitations: true },
        orderBy: { createdAt: "desc" },
    });
}

export async function getBidPackage(id: string) {
    const user = await assertFinancialPermission();
    const pkg = await prisma.bidPackage.findUnique({
        where: { id },
        include: {
            scopes: { orderBy: { order: "asc" } },
            invitations: { orderBy: { createdAt: "asc" } },
            project: { select: { id: true, name: true } },
        },
    });

    if (!pkg) return null;
    assertFinancialProjectScope(user, pkg.projectId);

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
    await assertFinancialProjectAccess(projectId);
    const pkg = await prisma.bidPackage.create({
        data: {
            projectId,
            title: data.title,
            description: data.description,
            dueDate: data.dueDate,
            totalBudget: data.totalBudget,
        },
    });
    revalidatePath(`/projects/${projectId}/bid-packages`);
    // totalBudget is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(pkg));
}

export async function updateBidPackage(id: string, projectId: string, data: {
    title?: string;
    description?: string;
    dueDate?: Date | null;
    status?: string;
    totalBudget?: number | null;
}) {
    await assertFinancialProjectAccess(projectId);
    const existing = await prisma.bidPackage.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing || existing.projectId !== projectId) throw new Error("Bid package not found");
    const pkg = await prisma.bidPackage.update({
        where: { id },
        data: {
            title: data.title,
            description: data.description,
            dueDate: data.dueDate,
            status: data.status,
            totalBudget: data.totalBudget,
        },
    });
    revalidatePath(`/projects/${projectId}/bid-packages`);
    revalidatePath(`/projects/${projectId}/bid-packages/${id}/edit`);
    // totalBudget is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(pkg));
}

export async function deleteBidPackage(id: string, projectId: string) {
    await assertFinancialProjectAccess(projectId);
    const existing = await prisma.bidPackage.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing || existing.projectId !== projectId) throw new Error("Bid package not found");
    await prisma.bidPackage.delete({ where: { id } });
    revalidatePath(`/projects/${projectId}/bid-packages`);
    return { success: true };
}

export async function addBidScope(packageId: string, projectId: string, data: {
    name: string;
    description?: string;
    budgetAmount?: number | null;
}) {
    await assertFinancialProjectAccess(projectId);
    const pkg = await prisma.bidPackage.findUnique({ where: { id: packageId }, select: { projectId: true } });
    if (!pkg || pkg.projectId !== projectId) throw new Error("Bid package not found");
    const scope = await prisma.bidScope.create({
        data: {
            packageId,
            name: data.name,
            description: data.description,
            budgetAmount: data.budgetAmount,
        },
    });
    revalidatePath(`/projects/${projectId}/bid-packages/${packageId}/edit`);
    // budgetAmount is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(scope));
}

export async function deleteBidScope(scopeId: string, packageId: string, projectId: string) {
    await assertFinancialProjectAccess(projectId);
    const existing = await prisma.bidScope.findUnique({
        where: { id: scopeId },
        select: { packageId: true, package: { select: { projectId: true } } },
    });
    if (!existing || existing.packageId !== packageId || existing.package.projectId !== projectId) {
        throw new Error("Bid scope not found");
    }
    await prisma.bidScope.delete({ where: { id: scopeId } });
    revalidatePath(`/projects/${projectId}/bid-packages/${packageId}/edit`);
    return { success: true };
}

export async function inviteSubToBid(packageId: string, projectId: string, data: {
    email: string;
    subcontractorId?: string;
}) {
    await assertFinancialProjectAccess(projectId);
    const pkg = await prisma.bidPackage.findUnique({ where: { id: packageId }, select: { projectId: true } });
    if (!pkg || pkg.projectId !== projectId) throw new Error("Bid package not found");
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
    await assertFinancialProjectAccess(projectId);
    const existing = await prisma.bidInvitation.findUnique({
        where: { id: invitationId },
        select: { packageId: true, package: { select: { projectId: true } } },
    });
    if (!existing || existing.packageId !== packageId || existing.package.projectId !== projectId) {
        throw new Error("Bid invitation not found");
    }
    const inv = await prisma.bidInvitation.update({
        where: { id: invitationId },
        data: {
            status: data.status,
            bidAmount: data.bidAmount,
            notes: data.notes,
            respondedAt: new Date(),
        },
    });
    revalidatePath(`/projects/${projectId}/bid-packages/${packageId}/edit`);
    // bidAmount is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(inv));
}

export async function awardBid(packageId: string, invitationId: string, projectId: string) {
    await assertFinancialProjectAccess(projectId);
    const invitation = await prisma.bidInvitation.findUnique({
        where: { id: invitationId },
        select: { packageId: true, package: { select: { projectId: true } } },
    });
    if (!invitation || invitation.packageId !== packageId || invitation.package.projectId !== projectId) {
        throw new Error("Bid invitation not found");
    }
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
    await assertInvoicePermission();
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
    // totalAmount/balanceDue/amountPaid are Prisma Decimals — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(retainer));
}

export async function updateRetainer(id: string, data: {
    totalAmount?: number;
    notes?: string;
    dueDate?: string | null;
    status?: string;
}) {
    await assertInvoicePermission();
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
    // totalAmount/balanceDue/amountPaid are Prisma Decimals — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(retainer));
}

export async function deleteRetainer(id: string) {
    await assertInvoicePermission();
    const retainer = await prisma.retainer.findUnique({ where: { id }, select: { projectId: true } });
    if (!retainer) return { success: false };

    await prisma.retainer.delete({ where: { id } });
    revalidatePath(`/projects/${retainer.projectId}/retainers`);
    return { success: true };
}

// ========== DOCUMENT COMMENTS ==========

// documentType is a free-typed string coming from a server action, i.e.
// untrusted at runtime regardless of the TS signature — whitelist it.
// Portal (non-staff) access is only wired up for "estimate" and "invoice"
// below; the other two are staff-only surfaces (no portal ownership shape
// resolved for them yet).
const DOCUMENT_COMMENT_TYPES = ["estimate", "invoice", "change-order", "purchase-order", "contract"] as const;
type DocumentCommentType = (typeof DOCUMENT_COMMENT_TYPES)[number];

function assertValidDocumentType(documentType: string): asserts documentType is DocumentCommentType {
    if (!(DOCUMENT_COMMENT_TYPES as readonly string[]).includes(documentType)) {
        throw new Error("Invalid documentType");
    }
}

function assertValidVisibility(visibility: string): asserts visibility is "team" | "client" {
    if (visibility !== "team" && visibility !== "client") {
        throw new Error("Invalid visibility");
    }
}

// Resolves the Client that owns a given document, for portal ownership
// checks. Returns null for document types with no portal-ownership shape
// (change-order, purchase-order, contract) or when the document isn't found.
async function resolveDocumentOwnerClientId(documentType: DocumentCommentType, documentId: string): Promise<string | null> {
    if (documentType === "estimate") {
        const estimate = await prisma.estimate.findUnique({
            where: { id: documentId },
            select: {
                project: { select: { clientId: true } },
                lead: { select: { clientId: true } },
            },
        });
        return estimate?.project?.clientId ?? estimate?.lead?.clientId ?? null;
    }
    if (documentType === "invoice") {
        const invoice = await prisma.invoice.findUnique({
            where: { id: documentId },
            select: { clientId: true },
        });
        return invoice?.clientId ?? null;
    }
    return null;
}

function withCanDelete<T extends { authorId: string | null }>(
    comments: T[],
    staffUser: { id: string; role: string } | null,
): (T & { canDelete: boolean })[] {
    if (!staffUser) return comments.map((c) => ({ ...c, canDelete: false }));
    const isAdminOrManager = ["ADMIN", "MANAGER"].includes(staffUser.role);
    return comments.map((c) => ({ ...c, canDelete: isAdminOrManager || c.authorId === staffUser.id }));
}

export async function getDocumentComments(documentType: string, documentId: string) {
    assertValidDocumentType(documentType);

    // Read-side gating mirrors the write side: staff sessions see both
    // visibilities, portal clients see client-visible comments only for a
    // document their session-resolved Client actually owns, and anyone else
    // (server actions are callable by any authenticated-or-not client) gets
    // nothing back — otherwise a caller who merely knows a documentId (e.g.
    // from a portal URL) could read another client's, or TEAM-visibility,
    // comments.
    const staffUser = await getCurrentUserWithPermissions();
    if (staffUser) {
        const comments = await prisma.documentComment.findMany({
            where: { documentType, documentId },
            orderBy: { createdAt: "asc" },
            include: { author: { select: { id: true, name: true, email: true } } },
        });
        return withCanDelete(comments, staffUser);
    }

    const sessionClientId = await resolveSessionClientId();
    if (!sessionClientId) return [];

    const ownerClientId = await resolveDocumentOwnerClientId(documentType, documentId);
    if (!ownerClientId || ownerClientId !== sessionClientId) return [];

    const comments = await prisma.documentComment.findMany({
        where: { documentType, documentId, visibility: "client" },
        orderBy: { createdAt: "asc" },
        include: { author: { select: { id: true, name: true, email: true } } },
    });
    // No portal mount exists for this component yet, so portal-authored
    // deletes stay admin-only (deleteDocumentComment already enforces that —
    // see its comment below) — canDelete is always false from this branch.
    return withCanDelete(comments, null);
}

export async function addDocumentComment(
    documentType: string,
    documentId: string,
    text: string,
    visibility: "team" | "client",
) {
    assertValidDocumentType(documentType);
    assertValidVisibility(visibility);

    // Derive the author from the session — never trust a client-supplied
    // authorId/authorName (the old signature accepted both as plain args).
    // Team-visible comments are internal-only and require a signed-in staff
    // user. Client-visible comments may come from staff posting on the
    // client's behalf, or from a logged-in portal client whose
    // session-resolved Client actually owns this document.
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Comment text is required");

    let authorId: string | null = null;
    let authorName: string | null = null;

    const staffUser = await getCurrentUserWithPermissions();
    if (staffUser) {
        authorId = staffUser.id;
        authorName = staffUser.name || staffUser.email;
    } else if (visibility === "team") {
        throw new Error("Unauthorized");
    } else {
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) throw new Error("Unauthorized");

        const ownerClientId = await resolveDocumentOwnerClientId(documentType, documentId);
        if (!ownerClientId || ownerClientId !== sessionClientId) throw new Error("Unauthorized");

        const client = await prisma.client.findUnique({ where: { id: sessionClientId }, select: { name: true } });
        authorName = client?.name || "Client";
    }

    const comment = await prisma.documentComment.create({
        data: { documentType, documentId, text: trimmed, visibility, authorId, authorName },
        include: { author: { select: { id: true, name: true, email: true } } },
    });
    // The caller can always delete the comment they just created if they're
    // staff (matches withCanDelete's authorId === staffUser.id branch);
    // portal-authored comments stay non-deletable from the client's own view.
    return { ...comment, canDelete: !!staffUser };
}

export async function deleteDocumentComment(commentId: string) {
    // Only the comment's own author, or an ADMIN/MANAGER, may delete it.
    // Non-staff (portal) callers never satisfy either check today — there's
    // no portal mount for this component yet, so portal-authored comments
    // are deliberately admin-only to delete for now (see getDocumentComments).
    const staffUser = await getCurrentUserWithPermissions();
    const comment = await prisma.documentComment.findUnique({ where: { id: commentId }, select: { authorId: true } });
    if (!comment) return { success: true };

    const isOwnComment = !!staffUser && comment.authorId === staffUser.id;
    const isAdminOrManager = !!staffUser && ["ADMIN", "MANAGER"].includes(staffUser.role);
    if (!isOwnComment && !isAdminOrManager) throw new Error("Unauthorized");

    await prisma.documentComment.delete({ where: { id: commentId } });
    return { success: true };
}

// ========== PER-ITEM APPROVAL ==========

export async function updateItemApproval(itemId: string, status: "approved" | "rejected" | null, note?: string) {
    await assertEstimateItemAccess([itemId]);
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
    // All-or-nothing: one out-of-scope id fails the whole batch rather than
    // being quietly dropped from the updateMany.
    await assertEstimateItemAccess(itemIds);
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

// Keeps the deprecated EstimateItem.purchaseOrderId mirror pointing at the oldest surviving
// link (or null) so a rollback to the pre-many-to-many build stays correct. Secondary `id`
// ordering makes the pick deterministic when two rows share the identical `createdAt` (e.g. a
// migrated legacy row and a brand-new link inserted in the same transaction both get the same
// CURRENT_TIMESTAMP from Postgres) — without it, ordering by `createdAt` alone could pick the
// NEW link as the mirror instead of the original.
async function syncLegacyPoLink(tx: Prisma.TransactionClient, estimateItemId: string) {
    const oldest = await tx.estimateItemPurchaseOrder.findFirst({
        where: { estimateItemId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { purchaseOrderId: true },
    });
    await tx.estimateItem.update({
        where: { id: estimateItemId },
        data: { purchaseOrderId: oldest?.purchaseOrderId ?? null },
    });
}

// If the item still carries a non-null legacy scalar link with no matching join row (predates
// the join table, or the backfill hasn't run yet), create that join row first so it isn't
// silently dropped when a new link is added. Safe to call unconditionally — no-ops otherwise.
//
// Uses createMany + skipDuplicates rather than a bare create with a P2002 catch: a unique
// violation from a bare create aborts the whole surrounding Postgres transaction, so every
// later statement in the same tx — including syncLegacyPoLink — would fail too, even though
// "the row already exists" is exactly the no-op case this function exists to handle.
//
// Backdates the migrated row to the item's own `createdAt` (not "now") so it is genuinely the
// oldest link and syncLegacyPoLink's findFirst deterministically picks it as the mirror.
async function migrateLegacyPoLink(tx: Prisma.TransactionClient, estimateItemId: string) {
    const item = await tx.estimateItem.findUnique({
        where: { id: estimateItemId },
        select: { purchaseOrderId: true, createdAt: true },
    });
    if (!item?.purchaseOrderId) return;
    await tx.estimateItemPurchaseOrder.createMany({
        data: [{ estimateItemId, purchaseOrderId: item.purchaseOrderId, createdAt: item.createdAt }],
        skipDuplicates: true,
    });
}

// Locks the affected PurchaseOrder row(s), then the parent Estimate, then the affected
// EstimateItem row(s) FOR UPDATE — all in a stable (sorted) id order within each type — before
// any read or write of purchaseOrderLinks / the legacy scalar mirror. Every path that mutates
// PO<->item links takes these same locks in this same order so concurrent link/unlink/backfill
// operations serialize instead of racing — without it, two concurrent unlinks on the same item
// can each read the other's uncommitted delete and pick the wrong "oldest surviving link" in
// syncLegacyPoLink, resurrecting a link the user just removed.
//
// PurchaseOrder leads (rather than following Estimate) because deletePurchaseOrder must lock its
// own PO row before it can even discover which estimate(s)/item(s) are currently linked to it
// (that discovery is itself a snapshot read racing against concurrent links) — putting
// PurchaseOrder after Estimate would force deletePurchaseOrder to lock Estimate rows it hasn't
// identified yet, which isn't possible without re-introducing that race. Every caller that knows
// its target PurchaseOrder id(s) upfront (link/unlink/restore/delete) passes them here so this
// stays the one global order; callers creating a brand-new PO (quickCreatePOAndLink,
// createPurchaseOrderFromEstimate) have no existing row to lock and pass none.
async function lockEstimateItemLinks(
    tx: Prisma.TransactionClient,
    estimateId: string,
    estimateItemIds: string[],
    purchaseOrderIds: string[] = [],
) {
    const sortedPoIds = Array.from(new Set(purchaseOrderIds)).sort();
    for (const id of sortedPoIds) {
        await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`;
    }
    await lockMoneyParents(tx, { estimateId });
    const sortedIds = Array.from(new Set(estimateItemIds)).sort();
    for (const id of sortedIds) {
        await tx.$queryRaw`SELECT id FROM "EstimateItem" WHERE id = ${id} FOR UPDATE`;
    }
}

export async function linkPOToEstimateItem(estimateItemId: string, purchaseOrderId: string) {
    const user = await assertFinancialPermission();

    const item = await prisma.estimateItem.findUnique({
        where: { id: estimateItemId },
        include: { estimate: { select: { projectId: true } } },
    });
    if (!item) throw new Error("Estimate item not found");
    if (!item.estimate.projectId) throw new Error("Purchase orders require a project");
    assertFinancialProjectScope(user, item.estimate.projectId);

    const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (!po) throw new Error("Purchase order not found");
    if (po.projectId !== item.estimate.projectId) throw new Error("PO must belong to the same project");

    await withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockEstimateItemLinks(tx, item.estimateId, [estimateItemId], [purchaseOrderId]);
        await migrateLegacyPoLink(tx, estimateItemId);
        await tx.estimateItemPurchaseOrder.createMany({
            data: [{ estimateItemId, purchaseOrderId }],
            skipDuplicates: true,
        });
        await syncLegacyPoLink(tx, estimateItemId);
    }));

    revalidatePath(`/projects/${item.estimate.projectId}/estimates`);
    // totalAmount is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(po));
}

export async function unlinkPOFromEstimateItem(estimateItemId: string, purchaseOrderId: string) {
    const user = await assertFinancialPermission();

    const item = await prisma.estimateItem.findUnique({
        where: { id: estimateItemId },
        include: { estimate: { select: { projectId: true } } },
    });
    if (!item) throw new Error("Estimate item not found");
    if (!item.estimate.projectId) throw new Error("Purchase orders require a project");
    assertFinancialProjectScope(user, item.estimate.projectId);

    await withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockEstimateItemLinks(tx, item.estimateId, [estimateItemId], [purchaseOrderId]);
        await tx.estimateItemPurchaseOrder.deleteMany({
            where: { estimateItemId, purchaseOrderId },
        });
        await syncLegacyPoLink(tx, estimateItemId);
    }));

    if (item?.estimate.projectId) {
        revalidatePath(`/projects/${item.estimate.projectId}/estimates`);
    }
}

export async function quickCreatePOAndLink(estimateItemId: string, data: { vendorId: string; amount: number; notes?: string }) {
    const user = await assertFinancialPermission();

    const item = await prisma.estimateItem.findUnique({
        where: { id: estimateItemId },
        include: { estimate: { select: { projectId: true } } },
    });
    if (!item) throw new Error("Estimate item not found");
    if (!item.estimate.projectId) throw new Error("Purchase orders require a project");

    const projectId = item.estimate.projectId;
    assertFinancialProjectScope(user, projectId);

    // Retry loop to handle TOCTOU race: two concurrent creates could pick the same count.
    // Each attempt is its own retried transaction that creates the PO AND its join row AND
    // resyncs the legacy mirror atomically. A P2002 on the code aborts that attempt's
    // transaction cleanly (nothing committed) so the next attempt retries clean — the PO was
    // previously created in a separate transaction from its link, which meant a retry after
    // the fact left an orphaned, unlinked PO behind and created a second one.
    let po: any;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            po = await withTxRetry(() => prisma.$transaction(async (tx) => {
                await lockEstimateItemLinks(tx, item.estimateId, [estimateItemId]);
                const count = await tx.purchaseOrder.count({ where: { projectId } });
                const code = `PO-${(count + 1 + attempt).toString().padStart(3, "0")}`;
                const created = await tx.purchaseOrder.create({
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
                await migrateLegacyPoLink(tx, estimateItemId);
                await tx.estimateItemPurchaseOrder.createMany({
                    data: [{ estimateItemId, purchaseOrderId: created.id }],
                    skipDuplicates: true,
                });
                await syncLegacyPoLink(tx, estimateItemId);
                return created;
            }));
            break;
        } catch (e: any) {
            // Unique constraint violation on code — retry with the next number. Any other
            // error (including a deadlock withTxRetry already exhausted its own retries on)
            // propagates immediately.
            if (e?.code !== "P2002" || attempt === 4) throw e;
        }
    }

    revalidatePath(`/projects/${projectId}/purchase-orders`);
    revalidatePath(`/projects/${projectId}/estimates`);
    // totalAmount is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(po));
}

// Result of restoreEstimateItemAssociations — reports exactly what was (and wasn't) restored
// so the caller can distinguish "nothing left to do" from "nothing happened yet". Two skip
// reasons are classified separately because they call for opposite caller behavior:
//   - missing.itemIds is RETRYABLE: the EstimateItem itself doesn't exist yet (e.g. its
//     row-recreation save hasn't landed, or hasn't happened at all). It may come back on a
//     later save, so the caller should keep these entries pending and retry.
//   - missing.purchaseOrderIds / missing.scheduleTaskIds are PERMANENT: the target itself is
//     gone, out of this estimate's project scope, or (for a ScheduleTask) already owned by a
//     different EstimateItem. Retrying can never fix these — the caller should drop them.
export type RestoreEstimateItemAssociationsResult = {
    restoredLinks: { estimateItemId: string; purchaseOrderId: string }[];
    restoredScheduleTasks: { scheduleTaskId: string; estimateItemId: string }[];
    missing: {
        itemIds: string[];
        purchaseOrderIds: string[];
        scheduleTaskIds: string[];
    };
};

// Backs the durable delete-undo (Part B). Re-creates join rows and re-points schedule tasks
// severed when an estimate item was deleted (both cascade/SetNull at the DB level), and
// resyncs the legacy scalar mirror. Idempotent — skips ids that no longer exist rather than
// throwing, so a partial restore (e.g. a PO deleted in the meantime) still succeeds. Reports
// exactly what it restored vs. skipped (see RestoreEstimateItemAssociationsResult) instead of
// a bare success — the caller cannot tell "restored everything" from "restored nothing" any
// other way, and treating both as plain success risks clearing a still-needed retry payload.
export async function restoreEstimateItemAssociations({
    estimateId,
    links,
    scheduleTasks,
}: {
    estimateId: string;
    links: { estimateItemId: string; purchaseOrderId: string; createdAt?: string | Date }[];
    scheduleTasks: { scheduleTaskId: string; estimateItemId: string }[];
}): Promise<RestoreEstimateItemAssociationsResult> {
    // This restores TWO independent kinds of association from an undo snapshot: PO<->item
    // links (financial data) and estimateItemId<->ScheduleTask repoints (schedule data). They
    // are authorized separately by payload — per permissions.ts, FINANCE has no "schedules"
    // permission, so a FINANCE user must not be able to repoint ScheduleTask rows just because
    // they're restoring PO links in the same undo call, and a schedule-only user must not need
    // financial access just to restore a task link. A payload the caller isn't permitted to
    // touch throws (rather than being silently skipped) — consistent with every other auth
    // assertion in this file, and it keeps an undo from ever reporting "done" while quietly
    // leaving part of the restore undone.
    const user = await assertActiveStaff();

    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { projectId: true },
    });
    if (!estimate) throw new Error("Estimate not found");
    if (!estimate.projectId) throw new Error("Purchase orders require a project");
    const projectId = estimate.projectId;

    if (links.length > 0) {
        if (!hasPermission(user, "financialReports")) throw new Error("Forbidden: restoring purchase-order links requires financial access");
        assertFinancialProjectScope(user, projectId);
    }
    if (scheduleTasks.length > 0) {
        if (!hasPermission(user, "schedules") || !canAccessProject(user, projectId)) {
            throw new Error("Forbidden: restoring schedule-task links requires schedule access");
        }
    }

    const result = await withTxRetry(() => prisma.$transaction(async (tx) => {
        // PO-item ids are only those referenced by the `links` payload — the financial
        // permission asserted above authorizes the legacy PO mirror ONLY for these items. An
        // item that appears solely in `scheduleTasks` is authorized under the schedules
        // permission and must never reach migrateLegacyPoLink/syncLegacyPoLink below, or a
        // schedules-only caller could pass a valid EstimateItem id (paired with even a
        // nonexistent ScheduleTask id) and clobber that item's financial PO link.
        const poItemIds = new Set(links.map(l => l.estimateItemId));
        const candidateItemIds = Array.from(new Set([
            ...links.map(l => l.estimateItemId),
            ...scheduleTasks.map(s => s.estimateItemId),
        ]));
        // Purchase-order ids are known upfront from the undo snapshot, so lock them now too —
        // PurchaseOrder → Estimate → EstimateItem is the global order every PO-link path obeys
        // (see lockEstimateItemLinks's doc comment). Lock the full candidate set (PO items AND
        // schedule-only items) since both are read/written below and must serialize against
        // concurrent link/delete operations — only the migrate/sync calls further down are
        // restricted to PO items.
        await lockEstimateItemLinks(tx, estimateId, candidateItemIds, links.map(l => l.purchaseOrderId));

        const existingItems = candidateItemIds.length
            ? await tx.estimateItem.findMany({
                where: { id: { in: candidateItemIds }, estimateId },
                select: { id: true },
            })
            : [];
        const existingItemIds = new Set(existingItems.map(i => i.id));

        // RETRYABLE: the EstimateItem itself isn't back yet. Collected from both payloads —
        // an item id can appear in `links`, `scheduleTasks`, or both.
        const missingItemIds = new Set<string>();
        for (const l of links) if (!existingItemIds.has(l.estimateItemId)) missingItemIds.add(l.estimateItemId);
        for (const st of scheduleTasks) if (!existingItemIds.has(st.estimateItemId)) missingItemIds.add(st.estimateItemId);

        // Materialize any pre-existing legacy scalar link into the join table BEFORE creating
        // the restored links below, so the final syncLegacyPoLink pass sees the full set of
        // links (legacy + restored) instead of racing its own migration. PO items only.
        for (const itemId of existingItemIds) {
            if (poItemIds.has(itemId)) {
                await migrateLegacyPoLink(tx, itemId);
            }
        }

        const validLinks = links.filter(l => existingItemIds.has(l.estimateItemId));
        const restoredLinks: { estimateItemId: string; purchaseOrderId: string }[] = [];
        // PERMANENT: the PO itself is gone or out of this project — retrying can't fix it.
        const missingPurchaseOrderIds = new Set<string>();
        if (validLinks.length > 0) {
            // A PO must belong to the SAME project as this estimate — otherwise a caller
            // authorized for this estimate could pass an id belonging to another project's PO
            // (or ScheduleTask, below) and have it linked here.
            const existingPos = await tx.purchaseOrder.findMany({
                where: { id: { in: validLinks.map(l => l.purchaseOrderId) }, projectId },
                select: { id: true },
            });
            const existingPoIds = new Set(existingPos.map(p => p.id));
            const linksToCreate = validLinks
                .filter(l => existingPoIds.has(l.purchaseOrderId))
                .map(l => ({
                    estimateItemId: l.estimateItemId,
                    purchaseOrderId: l.purchaseOrderId,
                    // Preserve the original link's timestamp when the caller has it (e.g. an
                    // undo snapshot), so syncLegacyPoLink's oldest-link ordering stays correct
                    // instead of treating a restored link as brand new.
                    ...(l.createdAt ? { createdAt: new Date(l.createdAt) } : {}),
                }));
            if (linksToCreate.length > 0) {
                await tx.estimateItemPurchaseOrder.createMany({
                    data: linksToCreate,
                    skipDuplicates: true,
                });
            }
            for (const l of validLinks) {
                if (existingPoIds.has(l.purchaseOrderId)) {
                    restoredLinks.push({ estimateItemId: l.estimateItemId, purchaseOrderId: l.purchaseOrderId });
                } else {
                    missingPurchaseOrderIds.add(l.purchaseOrderId);
                }
            }
        }

        if (scheduleTasks.length > 0) {
            // Schedule-task repointing writes ScheduleTask rows, so it must take the Project
            // row lock FIRST — the same order lockTaskAssignmentParent establishes for every
            // other ScheduleTask writer in schedule-core.ts (Project → ScheduleTask; see its
            // doc comment there). Taking it here — after the PurchaseOrder/Estimate/EstimateItem
            // locks above, before any ScheduleTask lock below — makes this function's full lock
            // chain (PurchaseOrder → Estimate → EstimateItem → Project → ScheduleTask) a strict
            // extension of both established orders, so it can't invert against either family of
            // writer. (schedule-core.ts itself never acquires a PurchaseOrder, Estimate, or
            // EstimateItem lock, so there's no reciprocal ordering constraint on that side to
            // reconcile — no follow-up change to schedule-core.ts is needed for this.)
            await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
        }

        // Sort so two concurrent restores lock ScheduleTask rows in the same global order.
        const sortedScheduleTasks = [...scheduleTasks].sort((a, b) => a.scheduleTaskId.localeCompare(b.scheduleTaskId));
        const restoredScheduleTasks: { scheduleTaskId: string; estimateItemId: string }[] = [];
        // PERMANENT: the ScheduleTask is gone, out of project scope, or owned by a different
        // item — retrying can't fix any of these (item-missing is tracked separately above).
        const missingScheduleTaskIds = new Set<string>();
        for (const st of sortedScheduleTasks) {
            if (!existingItemIds.has(st.estimateItemId)) continue;
            const rows = await tx.$queryRaw<{ id: string; projectId: string | null; estimateItemId: string | null }[]>`
                SELECT id, "projectId", "estimateItemId" FROM "ScheduleTask" WHERE id = ${st.scheduleTaskId} FOR UPDATE
            `;
            const task = rows[0];
            if (!task) { missingScheduleTaskIds.add(st.scheduleTaskId); continue; }
            // Same-project + no-theft guard: a ScheduleTask must belong to this estimate's
            // project, and must be either unlinked or already pointing at the target item —
            // never repoint a task that belongs to a different estimate item (schedule-task
            // theft across items or projects).
            if (task.projectId !== projectId) { missingScheduleTaskIds.add(st.scheduleTaskId); continue; }
            if (task.estimateItemId && task.estimateItemId !== st.estimateItemId) { missingScheduleTaskIds.add(st.scheduleTaskId); continue; }
            await tx.scheduleTask.update({
                where: { id: st.scheduleTaskId },
                data: { estimateItemId: st.estimateItemId },
            });
            restoredScheduleTasks.push({ scheduleTaskId: st.scheduleTaskId, estimateItemId: st.estimateItemId });
        }

        // Resync the legacy mirror only for PO items — never for schedule-only candidates (see
        // poItemIds above); a schedules-only caller has no financial permission and must not be
        // able to reach this write.
        for (const itemId of existingItemIds) {
            if (poItemIds.has(itemId)) {
                await syncLegacyPoLink(tx, itemId);
            }
        }

        return {
            restoredLinks,
            restoredScheduleTasks,
            missing: {
                itemIds: Array.from(missingItemIds),
                purchaseOrderIds: Array.from(missingPurchaseOrderIds),
                scheduleTaskIds: Array.from(missingScheduleTaskIds),
            },
        };
    }));

    revalidatePath(`/projects/${projectId}/estimates`);
    return result;
}

export async function getProjectPurchaseOrdersForLinking(projectId: string) {
    await assertFinancialProjectAccess(projectId);

    const pos = await prisma.purchaseOrder.findMany({
        where: { projectId },
        select: { id: true, code: true, totalAmount: true, status: true, vendor: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
    });
    // totalAmount is a Prisma Decimal — serialize before crossing the server->client boundary.
    return JSON.parse(JSON.stringify(pos));
}

export async function createEstimateFromRoomDesign(roomId: string) {
    const user = await assertEstimatePermission();

    const room = await prisma.roomDesign.findUnique({
        where: { id: roomId },
        include: { assets: true },
    });
    if (!room) throw new Error("Room Design not found");
    // The new estimate lands on the room's project/lead, so that owner is what
    // has to be scoped — the room id alone says nothing about access.
    assertEstimateScope(user, room);

    const isProject = !!room.projectId;
    const ownerId = isProject ? room.projectId : room.leadId;
    if (!ownerId) throw new Error("Room Design is not associated with any Lead or Project");

    // Dynamic imports to avoid circular dependency
    const { getItemDef } = await import("@/lib/studio/catalog");
    const { getFinish } = await import("@/lib/studio/materials");
    const { toInches } = await import("@/lib/studio/units");

    const costCodes = await prisma.costCode.findMany({ where: { isActive: true } });
    const costCodeMap = new Map(costCodes.map((cc) => [cc.code, cc.id]));

    const getCostCodeId = (def: any, assetId: string) => {
        const cat = def?.category;
        if (cat === "cabinets") return costCodeMap.get("11-CABINET") ?? null;
        if (cat === "appliances") return costCodeMap.get("18-APPLIANCE") ?? null;
        if (cat === "doors-windows") return costCodeMap.get("14-DOOR") ?? null;
        if (assetId === "fireplace") return costCodeMap.get("25-FIREPLACE") ?? costCodeMap.get("19-FIXTURE") ?? null;
        if (assetId === "pony-wall" || assetId === "interior-wall" || assetId === "interior-wall-doorway") {
            return costCodeMap.get("02-FRAME") ?? null;
        }
        if (cat === "fixtures") return costCodeMap.get("19-FIXTURE") ?? null;
        if (cat === "lighting") return costCodeMap.get("19-FIXTURE") ?? costCodeMap.get("04-ELEC") ?? null;
        if (cat === "furniture" || cat === "decor") return costCodeMap.get("19-FIXTURE") ?? null;
        return null;
    };

    const items: Array<{
        name: string;
        description: string;
        type: string;
        quantity: number;
        baseCost: number;
        markupPercent: number;
        unitCost: number;
        total: number;
        costCodeId: string | null;
    }> = [];

    let totalEstimate = 0;

    // Rough budgetary pricing per builder recipe; width-scaled for millwork.
    const MESH_BASE_COST: Record<string, number> = {
        "cabinet-base": 350, "cabinet-drawers": 420, "cabinet-sink": 480, "cabinet-corner": 480,
        "cabinet-cooktop": 460, island: 1450, "island-overhang": 1750, "cabinet-wall": 280,
        "cabinet-wall-glass": 360, "open-shelves": 180, "cabinet-tall": 650, "cabinet-oven-tower": 780,
        vanity: 620, "vanity-double": 1150,
        "fridge-french": 2199, "fridge-side": 1599, range: 1299, "range-pro": 3499, hood: 549,
        dishwasher: 799, microwave: 399, "wine-fridge": 899, washer: 899, dryer: 849,
        "sink-farmhouse": 650, toilet: 385, tub: 1850, "tub-alcove": 620, shower: 2400,
        "pedestal-sink": 320, fireplace: 2800,
        recessed: 95, pendant: 185, "pendant-glass": 220, "pendant-trio": 540, chandelier: 690,
        "flush-mount": 140, sconce: 160, "floor-lamp": 210, "table-lamp": 120, track: 260,
        door: 380, "door-double": 720, "door-sliding": 1650, doorway: 250,
        window: 480, "window-double": 880, "window-picture": 1350,
        sofa: 1400, sectional: 2400, armchair: 700, "coffee-table": 380, "side-table": 180,
        "tv-console": 650, "dining-table": 950, "dining-chair": 160, stool: 140, bookshelf: 420,
        bed: 1300, dresser: 850, nightstand: 280, desk: 520, rug: 450,
        plant: 120, "plant-small": 35, mirror: 220, art: 150, vase: 40,
    };

    // Real vendor products placed from the library price by their actual
    // price/SKU instead of the budgetary table.
    const productIds = room.assets
        .filter((a) => a.assetId.startsWith("prod-"))
        .map((a) => a.assetId.slice(5));
    const libraryProducts = productIds.length
        ? await prisma.catalogProduct.findMany({ where: { id: { in: productIds } } })
        : [];
    const productById = new Map(libraryProducts.map((p) => [p.id, p]));

    // Library finishes referenced in placed items, for naming in line items.
    const libraryFinishes = await prisma.catalogFinish.findMany({
        select: { id: true, name: true, vendor: true },
    });
    const libFinishName = new Map(
        libraryFinishes.map((f) => [`lib-${f.id}`, f.vendor ? `${f.name} (${f.vendor})` : f.name]),
    );

    for (let idx = 0; idx < room.assets.length; idx++) {
        const asset = room.assets[idx];
        const product = asset.assetId.startsWith("prod-")
            ? productById.get(asset.assetId.slice(5))
            : undefined;
        const def = getItemDef(asset.assetId);
        const marginPercent = LEGACY_MARKUP_MARGIN_PCT;
        const name = product?.name ?? def?.name ?? `${asset.assetType.charAt(0).toUpperCase()}${asset.assetType.slice(1)}`;

        const metadata = (asset.metadata ?? {}) as Record<string, any>;
        const studio = (metadata.studio ?? {}) as Record<string, any>;
        const finishes = { ...(def?.finishes ?? {}), ...((studio.finishes ?? {}) as Record<string, string>) };

        let baseCost = def ? MESH_BASE_COST[def.mesh] ?? 250 : 250;
        if (product?.price != null) baseCost = Number(product.price);
        else if (product) baseCost = MESH_BASE_COST[product.mesh] ?? 250;

        const wM = typeof studio.w === "number" ? studio.w : def?.w ?? 0.6;
        const hM = typeof studio.h === "number" ? studio.h : def?.h ?? 0.76;
        const dM = typeof studio.d === "number" ? studio.d : def?.d ?? 0.6;
        const wIn = Math.round(toInches(wM));

        // Millwork scales by width vs the catalog default (24" base assumption)
        // - but never rescale a real product's actual price.
        if (!product?.price && def?.category === "cabinets" && def.resizable) {
            const defaultIn = Math.max(1, Math.round(toInches(def.w)));
            baseCost = Math.round(baseCost * Math.max(0.6, wIn / defaultIn));
        }

        const detailsArray: string[] = [
            `Size: ${wIn}"W x ${Math.round(toInches(hM))}"H x ${Math.round(toInches(dM))}"D`,
        ];
        if (product?.vendor) detailsArray.push(`Vendor: ${product.vendor}`);
        for (const [slot, finishId] of Object.entries(finishes)) {
            if (!finishId) continue;
            const finishName = libFinishName.get(finishId) ?? getFinish(finishId, "cab-white").name;
            detailsArray.push(`${slot.charAt(0).toUpperCase()}${slot.slice(1)}: ${finishName}`);
        }
        const sku = product?.sku
            ?? `GTR-${(def?.category ?? "item").slice(0, 3).toUpperCase()}-${(def?.id ?? asset.assetId).toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 10)}-${wIn}`;
        detailsArray.unshift(`SKU: ${sku}`);

        const unitCost = roundMoney(sellFromMargin(baseCost, marginPercent));
        const total = unitCost * 1;
        totalEstimate += total;

        const costCodeId = getCostCodeId(def, asset.assetId);

        items.push({
            name,
            description: detailsArray.join(" | "),
            type: "Material",
            quantity: 1,
            baseCost,
            markupPercent: marginPercent,
            unitCost,
            total,
            costCodeId,
        });
    }

    // Create the Estimate
    const estimate = await prisma.estimate.create({
        data: {
            title: `${room.name} — Material Takeoff Estimate`,
            projectId: isProject ? room.projectId : null,
            leadId: !isProject ? room.leadId : null,
            code: "EST-TEMP",
            status: "Draft",
            totalAmount: totalEstimate,
            balanceDue: totalEstimate,
            privacy: "Shared",
        },
    });

    const code = `EST-${String(estimate.number).padStart(5, "0")}`;
    await prisma.estimate.update({ where: { id: estimate.id }, data: { code } });

    // Create items
    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        await prisma.estimateItem.create({
            data: {
                estimateId: estimate.id,
                name: item.name,
                description: item.description,
                type: item.type,
                quantity: item.quantity,
                baseCost: item.baseCost,
                markupPercent: item.markupPercent,
                unitCost: item.unitCost,
                total: item.total,
                order: idx,
                costCodeId: item.costCodeId,
            },
        });
    }

    const redirectUrl = isProject
        ? `/projects/${room.projectId}/estimates/${estimate.id}`
        : `/leads/${room.leadId}/estimates/${estimate.id}`;

    if (isProject) {
        revalidatePath(`/projects/${room.projectId}/estimates`);
    } else {
        revalidatePath(`/leads/${room.leadId}`);
    }

    return {
        success: true,
        estimateId: estimate.id,
        redirectUrl,
    };
}

export async function addVoiceEstimateItem(projectId: string, name: string, quantity: number, unitCost: number) {
    await assertEstimateProjectAccess(projectId);
    const estimate = await prisma.estimate.findFirst({
        where: { projectId },
        orderBy: { createdAt: "desc" }
    });

    if (!estimate) {
        throw new Error("No active estimate found for this project. Please create an estimate first.");
    }

    // One transaction, estimate locked FIRST (canonical Estimate → Invoice order), because the
    // row insert and the itemsRevision bump must be atomic. Split across two autocommit
    // statements — as this was — a concurrent saveEstimate can interleave between them: it takes
    // the lock, passes its CAS against the not-yet-bumped revision, sees this brand-new row as
    // absent from its own payload, deletes it as "removed by the user", and commits. Bumping
    // inside the lock means that save either ran entirely before this insert (and is now stale,
    // so its next attempt is rejected) or blocks until the bump is committed and fails its CAS.
    // See docs/specs/estimate-item-optimistic-concurrency.md REVISION 2.
    const item = await withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, { estimateId: estimate.id });

        const lastItem = await tx.estimateItem.findFirst({
            where: { estimateId: estimate.id },
            orderBy: { order: "desc" },
            select: { order: true }
        });
        const nextOrder = lastItem ? lastItem.order + 1 : 0;

        const created = await tx.estimateItem.create({
            data: {
                estimateId: estimate.id,
                name,
                type: "Material",
                quantity,
                baseCost: unitCost,
                markupPercent: 0,
                unitCost,
                total: quantity * unitCost,
                order: nextOrder
            }
        });

        const allItems = await tx.estimateItem.findMany({
            where: { estimateId: estimate.id },
            select: { total: true }
        });
        const totalAmount = allItems.reduce((sum, it) => sum + Number(it.total), 0);

        await tx.estimate.update({
            where: { id: estimate.id },
            data: { totalAmount, itemsRevision: { increment: 1 } }
        });

        return created;
    }));

    revalidatePath(`/projects/${projectId}/estimates/${estimate.id}`);
    revalidatePath(`/projects/${projectId}/estimates`);

    return item;
}

// =============================================
// Office Tasks (internal kanban board — ADMIN/MANAGER only)
// =============================================

async function assertOfficeTaskAccess() {
    const session = await getSessionOrDev();
    const sessionUserId = (session?.user as any)?.id as string | null | undefined;
    const sessionEmail = session?.user?.email as string | null | undefined;
    const sessionRole = ((session?.user as any)?.role as string | null) ?? null;

    // Dev-fallback session with no backing User row (see buildDevSession in
    // auth.ts) — same shape getFieldUpdatesFeed trusts: no id, but a synthetic
    // ADMIN/MANAGER role. There's no DB row to re-check in that case.
    const isSyntheticDevAccess = !sessionUserId && (sessionRole === "ADMIN" || sessionRole === "MANAGER");
    if (isSyntheticDevAccess) {
        return { id: null as string | null, role: sessionRole as string };
    }

    // Otherwise, re-resolve the caller from the DB as defense in depth. The
    // shared JWT callback already suppresses missing and DISABLED staff users.
    const user = sessionUserId
        ? await prisma.user.findUnique({ where: { id: sessionUserId }, select: { id: true, role: true, status: true } })
        : sessionEmail
            ? await prisma.user.findUnique({ where: { email: sessionEmail }, select: { id: true, role: true, status: true } })
            : null;

    if (!user || !["ADMIN", "MANAGER"].includes(user.role) || user.status === "DISABLED") {
        throw new Error("Forbidden");
    }
    return { id: user.id, role: user.role };
}

export async function getOfficeTasksBoard() {
    await assertOfficeTaskAccess();

    const [columns, tasks, archived, users] = await Promise.all([
        prisma.officeBoardColumn.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
        prisma.officeTask.findMany({
            where: { archivedAt: null },
            orderBy: [{ columnId: "asc" }, { position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
            include: { assignee: { select: { id: true, name: true, email: true } } },
        }),
        prisma.officeTask.findMany({
            where: { archivedAt: { not: null } },
            orderBy: { archivedAt: "desc" },
            take: 100,
            include: { assignee: { select: { id: true, name: true, email: true } } },
        }),
        prisma.user.findMany({
            where: { role: { in: ["ADMIN", "MANAGER"] }, status: "ACTIVATED" },
            select: { id: true, name: true, email: true },
        }),
    ]);

    return { columns, tasks, archived, users };
}

export async function createBoardColumn(name: string) {
    await assertOfficeTaskAccess();

    const trimmed = name.trim();
    if (!trimmed) throw new Error("Column name is required");

    const column = await prisma.$transaction(async (tx) => {
        const dup = await tx.officeBoardColumn.findFirst({
            where: { name: { equals: trimmed, mode: "insensitive" } },
            select: { id: true },
        });
        if (dup) throw new Error("A column with that name already exists");

        const last = await tx.officeBoardColumn.findFirst({
            orderBy: [{ position: "desc" }, { createdAt: "desc" }],
            select: { position: true },
        });

        return tx.officeBoardColumn.create({
            data: { name: trimmed, position: (last?.position ?? -1) + 1 },
        });
    });

    revalidatePath("/tasks");
    return column;
}

// isDoneColumn is optional here rather than a separate action — a rename
// dialog checkbox for it is trivial to wire alongside the name field.
export async function renameBoardColumn(id: string, name: string, isDoneColumn?: boolean) {
    await assertOfficeTaskAccess();

    const trimmed = name.trim();
    if (!trimmed) throw new Error("Column name is required");

    const column = await prisma.$transaction(async (tx) => {
        const dup = await tx.officeBoardColumn.findFirst({
            where: { name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
            select: { id: true },
        });
        if (dup) throw new Error("A column with that name already exists");

        const data: { name: string; isDoneColumn?: boolean } = { name: trimmed };
        if (isDoneColumn !== undefined) data.isDoneColumn = isDoneColumn;

        return tx.officeBoardColumn.update({ where: { id }, data });
    });

    revalidatePath("/tasks");
    return column;
}

export async function reorderBoardColumn(id: string, newIndex: number) {
    await assertOfficeTaskAccess();

    await prisma.$transaction(async (tx) => {
        const columns = await tx.officeBoardColumn.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
        const idx = columns.findIndex((c) => c.id === id);
        if (idx === -1) throw new Error("Column not found");

        const [moved] = columns.splice(idx, 1);
        const clampedIndex = Math.max(0, Math.min(newIndex, columns.length));
        columns.splice(clampedIndex, 0, moved);

        for (let i = 0; i < columns.length; i++) {
            await tx.officeBoardColumn.update({ where: { id: columns[i].id }, data: { position: i } });
        }
    });

    revalidatePath("/tasks");
    return { success: true };
}

export async function deleteBoardColumn(id: string) {
    await assertOfficeTaskAccess();

    // Checks and the delete run inside one transaction, with counts re-read
    // inside it, so a concurrent create/move can't slip a task into this
    // column between the check and the delete (which would otherwise orphan
    // it to columnId NULL via the FK's ON DELETE SET NULL).
    await prisma.$transaction(async (tx) => {
        const [taskCount, columnCount] = await Promise.all([
            tx.officeTask.count({ where: { columnId: id, archivedAt: null } }),
            tx.officeBoardColumn.count(),
        ]);

        if (taskCount > 0) throw new Error("Move or archive all tasks out of this column before deleting it");
        if (columnCount <= 1) throw new Error("The board must have at least one column");

        await tx.officeBoardColumn.delete({ where: { id } });
    });

    revalidatePath("/tasks");
    return { success: true };
}

export async function createOfficeTask(data: {
    title: string;
    columnId?: string;
    assigneeId?: string | null;
    dueDate?: string | null;
}) {
    const caller = await assertOfficeTaskAccess();

    const task = await prisma.$transaction(async (tx) => {
        const column = data.columnId
            ? await tx.officeBoardColumn.findUnique({ where: { id: data.columnId } })
            : await tx.officeBoardColumn.findFirst({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
        if (!column) throw new Error("No board column available");

        const last = await tx.officeTask.findFirst({
            where: { columnId: column.id, archivedAt: null },
            orderBy: [{ position: "desc" }, { createdAt: "desc" }, { id: "desc" }],
            select: { position: true },
        });

        return tx.officeTask.create({
            data: {
                title: data.title,
                columnId: column.id,
                status: column.name, // TRANSITIONAL COMPAT — see OfficeTask.status
                position: (last?.position ?? -1) + 1,
                assigneeId: data.assigneeId || null,
                dueDate: data.dueDate ? parseOfficeTaskDateOnly(data.dueDate) : null,
                createdById: caller.id,
            },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
    });

    revalidatePath("/tasks");
    return task;
}

export async function updateOfficeTask(id: string, data: {
    title?: string;
    notes?: string | null;
    dueDate?: string | null;
    assigneeId?: string | null;
    aiPrompt?: string | null;
    automationGap?: string | null;
}) {
    await assertOfficeTaskAccess();

    const updateData: any = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.notes !== undefined) updateData.notes = data.notes || null;
    if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? parseOfficeTaskDateOnly(data.dueDate) : null;
    if (data.assigneeId !== undefined) updateData.assigneeId = data.assigneeId || null;
    if (data.aiPrompt !== undefined) updateData.aiPrompt = data.aiPrompt || null;
    if (data.automationGap !== undefined) updateData.automationGap = data.automationGap || null;

    const task = await prisma.officeTask.update({
        where: { id },
        data: updateData,
        include: { assignee: { select: { id: true, name: true, email: true } } },
    });

    revalidatePath("/tasks");
    return task;
}

export async function moveOfficeTask(id: string, columnId: string, newIndex: number) {
    await assertOfficeTaskAccess();
    await assertColumnExists(columnId);

    await prisma.$transaction(async (tx) => {
        const task = await tx.officeTask.findUnique({ where: { id } });
        if (!task) throw new Error("Task not found");

        const column = await tx.officeBoardColumn.findUnique({ where: { id: columnId }, select: { name: true } });
        if (!column) throw new Error("Invalid column");

        const oldColumnId = task.columnId;

        const targetTasks = await tx.officeTask.findMany({
            where: { columnId, archivedAt: null, id: { not: id } },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        });

        const clampedIndex = Math.max(0, Math.min(newIndex, targetTasks.length));
        targetTasks.splice(clampedIndex, 0, { ...task, columnId } as typeof task);

        // Renumbering must touch position only — status is legacy-compat and
        // should only be rewritten for the task that actually moved, not for
        // unrelated tasks that were already sitting in the target column.
        for (let i = 0; i < targetTasks.length; i++) {
            const t = targetTasks[i];
            if (t.id === id) {
                await tx.officeTask.update({
                    where: { id: t.id },
                    data: { position: i, columnId, status: column.name }, // TRANSITIONAL COMPAT — see OfficeTask.status
                });
            } else {
                await tx.officeTask.update({
                    where: { id: t.id },
                    data: { position: i },
                });
            }
        }

        if (oldColumnId && oldColumnId !== columnId) {
            const sourceTasks = await tx.officeTask.findMany({
                where: { columnId: oldColumnId, archivedAt: null, id: { not: id } },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
            });
            for (let i = 0; i < sourceTasks.length; i++) {
                await tx.officeTask.update({
                    where: { id: sourceTasks[i].id },
                    data: { position: i },
                });
            }
        }
    });

    revalidatePath("/tasks");
    return { success: true };
}

export async function deleteOfficeTask(id: string) {
    await assertOfficeTaskAccess();

    await prisma.officeTask.delete({ where: { id } });

    revalidatePath("/tasks");
    return { success: true };
}

export async function archiveOfficeTask(id: string) {
    await assertOfficeTaskAccess();

    await prisma.officeTask.update({ where: { id }, data: { archivedAt: new Date() } });

    revalidatePath("/tasks");
    return { success: true };
}

export async function restoreOfficeTask(id: string) {
    await assertOfficeTaskAccess();

    const task = await prisma.$transaction(async (tx) => {
        const existing = await tx.officeTask.findUnique({ where: { id } });
        if (!existing) throw new Error("Task not found");

        // The task's column may have been deleted while it was archived (FK
        // ON DELETE SET NULL), or it may never have had one — in either case
        // fall back to the first-position column rather than restoring into
        // a NULL columnId.
        let column = existing.columnId
            ? await tx.officeBoardColumn.findUnique({ where: { id: existing.columnId } })
            : null;
        if (!column) {
            column = await tx.officeBoardColumn.findFirst({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
        }
        if (!column) throw new Error("No board column available");

        const last = await tx.officeTask.findFirst({
            where: { columnId: column.id, archivedAt: null, id: { not: id } },
            orderBy: [{ position: "desc" }, { createdAt: "desc" }, { id: "desc" }],
            select: { position: true },
        });

        return tx.officeTask.update({
            where: { id },
            data: {
                archivedAt: null,
                columnId: column.id,
                status: column.name, // TRANSITIONAL COMPAT — see OfficeTask.status
                position: (last?.position ?? -1) + 1,
            },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
    });

    revalidatePath("/tasks");
    return task;
}

// ============ Permits CRUD ============

const PERMIT_STATUSES = ["applied", "issued", "inspections", "closed", "expired"] as const;

// Shared staff-membership gate: caller must be a signed-in, non-disabled
// staff user with access to this specific project (canAccessProject covers
// ADMIN/MANAGER auto-pass plus per-user projectAccess/assignedProjects
// scoping). Used anywhere a mutation is scoped to one project and the
// weaker assertActiveStaff (any signed-in staff, any project) would be
// too permissive.
async function assertProjectMemberStaff(projectId: string) {
    // assertActiveStaff already handles the ID-less dev-auth fallback and
    // disabled-user rejection; its user carries projectAccess/assignedProjects.
    const user = await assertActiveStaff();
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");
    return user;
}

async function assertPermitAccess(projectId: string) {
    return assertProjectMemberStaff(projectId);
}

function parsePermitDate(value: string | undefined): Date | null | undefined {
    if (value === undefined) return undefined;
    if (!value) return null;
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
}

export async function getPermits(projectId: string) {
    await assertPermitAccess(projectId);
    return prisma.permit.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
    });
}

export async function createPermit(projectId: string, data: {
    permitNumber: string;
    type?: string;
    status?: string;
    issuingAuthority?: string;
    issueDate?: string;
    expirationDate?: string;
    notes?: string;
}) {
    await assertPermitAccess(projectId);

    const permitNumber = data.permitNumber?.trim();
    if (!permitNumber) throw new Error("Permit number is required");

    const status = data.status && (PERMIT_STATUSES as readonly string[]).includes(data.status)
        ? data.status
        : "applied";

    const permit = await prisma.permit.create({
        data: {
            projectId,
            permitNumber,
            type: data.type || null,
            status,
            issuingAuthority: data.issuingAuthority || null,
            issueDate: parsePermitDate(data.issueDate) ?? null,
            expirationDate: parsePermitDate(data.expirationDate) ?? null,
            notes: data.notes || null,
        },
    });

    revalidatePath(`/projects/${projectId}/permits`);
    return permit;
}

export async function updatePermit(permitId: string, data: {
    permitNumber?: string;
    type?: string;
    status?: string;
    issuingAuthority?: string;
    issueDate?: string;
    expirationDate?: string;
    notes?: string;
}) {
    const target = await prisma.permit.findUnique({ where: { id: permitId }, select: { projectId: true } });
    if (!target) throw new Error("Permit not found");
    await assertPermitAccess(target.projectId);

    const updateData: any = {};
    if (data.permitNumber !== undefined) {
        const permitNumber = data.permitNumber.trim();
        if (!permitNumber) throw new Error("Permit number is required");
        updateData.permitNumber = permitNumber;
    }
    if (data.type !== undefined) updateData.type = data.type.trim() || null;
    if (data.status !== undefined) {
        updateData.status = (PERMIT_STATUSES as readonly string[]).includes(data.status)
            ? data.status
            : "applied";
    }
    if (data.issuingAuthority !== undefined) updateData.issuingAuthority = data.issuingAuthority.trim() || null;
    if (data.issueDate !== undefined) updateData.issueDate = parsePermitDate(data.issueDate);
    if (data.expirationDate !== undefined) updateData.expirationDate = parsePermitDate(data.expirationDate);
    if (data.notes !== undefined) updateData.notes = data.notes.trim() || null;

    const permit = await prisma.permit.update({
        where: { id: permitId },
        data: updateData,
    });

    revalidatePath(`/projects/${target.projectId}/permits`);
    return permit;
}

export async function deletePermit(permitId: string) {
    const target = await prisma.permit.findUnique({ where: { id: permitId }, select: { projectId: true } });
    if (!target) throw new Error("Permit not found");
    await assertPermitAccess(target.projectId);

    await prisma.permit.delete({ where: { id: permitId } });
    revalidatePath(`/projects/${target.projectId}/permits`);
    return { success: true };
}

// ── Bank image match confirmation (Automation "Check images" panel) ─────────

/**
 * The ONE writer of BankImageMatch. A row in that table means a HUMAN said
 * "this image explains this bank line" (prisma/schema.prisma) — the matchers
 * (lib/bank-image.ts, lib/check-payer-match.ts, the extract script's
 * --report) only ever suggest. Gated on financialReports like the Automation
 * page itself: internal roles only, never a portal role (portal sessions
 * carry no staff user, so assertActiveStaff already rejects them).
 *
 * bankImageId is @unique on BankImageMatch, so a second confirm for the same
 * image loses the P2002 race honestly instead of double-writing.
 */
export async function confirmBankImageMatch(input: {
    bankImageId: string;
    bankLineId: string;
    note?: string | null;
}): Promise<{ success: true } | { success: false; error: string }> {
    const user = await assertFinancialPermission();

    const bankImageId = (input.bankImageId ?? "").trim();
    const bankLineId = (input.bankLineId ?? "").trim();
    if (!bankImageId || !bankLineId) {
        return { success: false, error: "Missing image or bank line id" };
    }
    // The note is display/audit text from our own proposal reason — cap it so
    // a mangled payload can't stuff arbitrary blobs into the audit trail.
    const note = (input.note ?? "").trim().slice(0, 500) || null;

    const [image, line] = await Promise.all([
        prisma.bankImage.findUnique({ where: { id: bankImageId }, select: { id: true, sourceExternalId: true } }),
        prisma.bankLine.findUnique({ where: { id: bankLineId }, select: { id: true } }),
    ]);
    if (!image) return { success: false, error: "That image no longer exists" };
    if (!line) return { success: false, error: "That bank line no longer exists" };

    const confirmedBy = user.email ?? user.name ?? "staff";
    try {
        await prisma.bankImageMatch.create({
            data: { bankImageId, bankLineId, confirmedBy, note },
        });
    } catch (e: any) {
        if (e?.code === "P2002") {
            return { success: false, error: "This image is already confirmed — refresh the page" };
        }
        throw e;
    }

    revalidatePath("/automation");
    return { success: true };
}

/**
 * Mark a flagged time entry as reviewed by a manager. Used by the
 * /manager/time-entries "Needs review" queue (WA meal-waiver attestations set
 * needsReview=true at clock-out; this is the human acknowledgment that closes
 * the loop). The waiver note in `notes` is preserved — only the flag clears —
 * and the reviewer + timestamp are appended so the audit trail survives.
 */
export async function markTimeEntryReviewed(entryId: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Not authenticated");

    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true, name: true, email: true, role: true } });
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER")) throw new Error("Forbidden");

    const entry = await prisma.timeEntry.findUnique({ where: { id: entryId }, select: { id: true, needsReview: true, notes: true, reviewReason: true } });
    if (!entry) throw new Error("Time entry not found");
    if (!entry.needsReview) return { success: true }; // already reviewed — idempotent

    const stamp = `[Reviewed by ${user.name || user.email} ${new Date().toISOString().slice(0, 10)}]`;
    await prisma.timeEntry.update({
        where: { id: entryId },
        data: {
            needsReview: false,
            // Retire the settlement-owned notes (src/lib/wa-breaks.ts) so a later
            // day re-plan cannot read them as "still unanswered" and re-flag a row
            // a manager already looked at. Other reasons (GPS etc.) are kept.
            reviewReason: stripSettlementNotes(entry.reviewReason),
            notes: entry.notes ? `${entry.notes}\n${stamp}` : stamp,
        },
    });

    revalidatePath("/manager/time-entries");
    return { success: true };
}

// ============ Inspections CRUD ============

const INSPECTION_RESULTS = ["SCHEDULED", "PASSED", "FAILED", "PARTIAL"] as const;
type InspectionResult = (typeof INSPECTION_RESULTS)[number];

type InspectionInput = {
    type?: string;
    result?: string;
    scheduledDate?: string;
    performedDate?: string;
    inspector?: string;
    notes?: string;
    customerNote?: string;
    sharedToPortal?: boolean;
    permitId?: string;
    scheduleTaskId?: string;
};

function inspectionResult(value: string | undefined, fallback: InspectionResult = "SCHEDULED"): InspectionResult {
    if (value === undefined) return fallback;
    if (!(INSPECTION_RESULTS as readonly string[]).includes(value)) throw new Error("Invalid inspection result");
    return value as InspectionResult;
}

function parseInspectionDate(value: string | undefined, label: string): Date | null | undefined {
    if (value === undefined) return undefined;
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD`);
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label} is invalid`);
    return parsed;
}

function requiredInspectionDate(result: InspectionResult, scheduledDate: Date | null, performedDate: Date | null) {
    if (result === "SCHEDULED" && !scheduledDate) throw new Error("Scheduled inspections require a scheduled date");
    if (result !== "SCHEDULED" && !performedDate) throw new Error(`${result} inspections require a performed date`);
}

function optionalText(value: string | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    return value.trim() || null;
}

export async function createInspection(projectId: string, data: InspectionInput & { type: string }) {
    const user = await assertProjectMemberStaff(projectId);
    const type = data.type.trim();
    if (!type) throw new Error("Inspection type is required");
    const result = inspectionResult(data.result);
    const scheduledDate = parseInspectionDate(data.scheduledDate, "Scheduled date") ?? null;
    const performedDate = parseInspectionDate(data.performedDate, "Performed date") ?? null;
    requiredInspectionDate(result, scheduledDate, performedDate);

    const permitId = optionalText(data.permitId) ?? null;
    const scheduleTaskId = optionalText(data.scheduleTaskId) ?? null;
    if (permitId) {
        const permit = await prisma.permit.findFirst({ where: { id: permitId, projectId }, select: { id: true } });
        if (!permit) throw new Error("permitId does not belong to this project");
    }
    if (scheduleTaskId) {
        const task = await prisma.scheduleTask.findFirst({ where: { id: scheduleTaskId, projectId }, select: { id: true } });
        if (!task) throw new Error("scheduleTaskId does not belong to this project");
    }

    const inspection = await prisma.inspection.create({
        data: {
            projectId, type, result, scheduledDate, performedDate,
            inspector: optionalText(data.inspector) ?? null,
            notes: optionalText(data.notes) ?? null,
            customerNote: optionalText(data.customerNote) ?? null,
            sharedToPortal: data.sharedToPortal ?? result === "PASSED",
            permitId,
            scheduleTaskId,
            createdById: user.id,
        },
    });

    revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/portal/projects/${projectId}`);
    return inspection;
}

export async function updateInspection(inspectionId: string, data: InspectionInput) {
    const target = await prisma.inspection.findUnique({
        where: { id: inspectionId },
        select: { projectId: true, result: true, scheduledDate: true, performedDate: true, sharedToPortal: true },
    });
    if (!target) throw new Error("Inspection not found");
    await assertProjectMemberStaff(target.projectId);

    const result = inspectionResult(data.result, target.result as InspectionResult);
    const scheduledDate = data.scheduledDate === undefined
        ? target.scheduledDate
        : parseInspectionDate(data.scheduledDate, "Scheduled date") ?? null;
    const performedDate = data.performedDate === undefined
        ? target.performedDate
        : parseInspectionDate(data.performedDate, "Performed date") ?? null;
    requiredInspectionDate(result, scheduledDate, performedDate);

    const permitId = data.permitId === undefined ? null : optionalText(data.permitId) ?? null;
    const scheduleTaskId = data.scheduleTaskId === undefined ? null : optionalText(data.scheduleTaskId) ?? null;
    if (data.permitId !== undefined && permitId) {
        const permit = await prisma.permit.findFirst({ where: { id: permitId, projectId: target.projectId }, select: { id: true } });
        if (!permit) throw new Error("permitId does not belong to this project");
    }
    if (data.scheduleTaskId !== undefined && scheduleTaskId) {
        const task = await prisma.scheduleTask.findFirst({ where: { id: scheduleTaskId, projectId: target.projectId }, select: { id: true } });
        if (!task) throw new Error("scheduleTaskId does not belong to this project");
    }

    const updateData: Record<string, unknown> = {};
    if (data.type !== undefined) {
        const type = data.type.trim();
        if (!type) throw new Error("Inspection type is required");
        updateData.type = type;
    }
    if (data.result !== undefined) updateData.result = result;
    if (data.scheduledDate !== undefined) updateData.scheduledDate = scheduledDate;
    if (data.performedDate !== undefined) updateData.performedDate = performedDate;
    if (data.inspector !== undefined) updateData.inspector = optionalText(data.inspector);
    if (data.notes !== undefined) updateData.notes = optionalText(data.notes);
    if (data.customerNote !== undefined) updateData.customerNote = optionalText(data.customerNote);
    if (data.permitId !== undefined) updateData.permitId = permitId;
    if (data.scheduleTaskId !== undefined) updateData.scheduleTaskId = scheduleTaskId;
    if (data.sharedToPortal !== undefined) {
        updateData.sharedToPortal = data.sharedToPortal;
    } else if (data.result !== undefined) {
        // Result changes re-apply the documented default. A caller that wants
        // an exception must send sharedToPortal explicitly.
        updateData.sharedToPortal = result === "PASSED";
    }

    const inspection = await prisma.inspection.update({ where: { id: inspectionId }, data: updateData });
    revalidatePath(`/projects/${target.projectId}`);
    revalidatePath(`/portal/projects/${target.projectId}`);
    return inspection;
}

/**
 * Skip-lunch decision from the manager queue (/manager/time-entries). Same
 * rules as PATCH /api/time-entries/[id]/meal-skip — a named approver
 * (src/lib/wa-breaks.ts), a PENDING request, and for APPROVED an open shift
 * plus a signed waiver on file. Guarded update so two approvers cannot race.
 */
export async function decideMealSkip(entryId: string, decision: "APPROVED" | "DENIED") {
    // Server actions are callable with any payload — validate at runtime.
    if (decision !== "APPROVED" && decision !== "DENIED") throw new Error("decision must be APPROVED or DENIED");
    if (typeof entryId !== "string" || !entryId) throw new Error("entryId is required");
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Not authenticated");
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true, email: true, role: true } });
    if (!user || !canApproveMealSkip({ role: user.role, email: user.email })) throw new Error("Forbidden");

    const entry = await prisma.timeEntry.findUnique({
        where: { id: entryId },
        select: { id: true, endTime: true, mealSkipStatus: true, user: { select: { mealWaiverSignedAt: true } } },
    });
    if (!entry) throw new Error("Time entry not found");
    const check = checkMealSkipDecision({
        decision,
        currentStatus: entry.mealSkipStatus,
        entryClosed: entry.endTime != null,
        waiverSignedAt: entry.user.mealWaiverSignedAt,
    });
    if (!check.ok) {
        const messages = {
            NOT_PENDING: "No pending request on this entry",
            WAIVER_NOT_SIGNED: "No signed meal-period waiver on file for this worker — mark it signed first",
            ENTRY_CLOSED: "The shift already closed; the clock-out attestation applies instead",
        } as const;
        throw new Error(messages[check.code]);
    }
    const flipped = await prisma.timeEntry.updateMany({
        // APPROVED additionally requires the shift to STILL be open at write time
        // (a clock-out racing this decision already settled pay via attestation).
        where: {
            id: entryId,
            mealSkipStatus: "PENDING",
            ...(decision === "APPROVED" ? { endTime: null, user: { mealWaiverSignedAt: { not: null } } } : {}),
        },
        data: { mealSkipStatus: decision, mealSkipDecidedById: user.id, mealSkipDecidedAt: new Date() },
    });
    if (flipped.count === 0) throw new Error("Request was already decided or the shift closed");
    revalidatePath("/manager/time-entries");
    return { success: true };
}

/**
 * Record that a worker signed Marge's meal-period waiver (the written,
 * revocable waiver WA expects before any meal period is given up). Managers
 * only; `signed=false` revokes it, which immediately blocks new approvals.
 */
export async function setMealWaiverSigned(userId: string, signed: boolean) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Not authenticated");
    // Same gate as approving: the whole approval chain rests on this bit, so only
    // the named approvers may assert a waiver is on file.
    const actor = await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true, email: true } });
    if (!actor || !canApproveMealSkip({ role: actor.role, email: actor.email })) throw new Error("Forbidden");
    await prisma.user.update({ where: { id: userId }, data: { mealWaiverSignedAt: signed ? new Date() : null } });
    revalidatePath("/manager/time-entries");
    revalidatePath("/company/team-members");
    return { success: true };
}

/**
 * Manager re-route of a Logistics entry (plan 02): send it to a real job (it
 * becomes that job's 31-LOGISTICS labor) or back to overhead (null). Same
 * rules as PATCH /api/time-entries/[id]/logistics, manager-only here.
 */
export async function rerouteLogisticsEntry(entryId: string, routeToProjectId: string | null) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Not authenticated");
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true, role: true } });
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER")) throw new Error("Forbidden");
    if (typeof entryId !== "string" || !entryId) throw new Error("entryId is required");
    if (routeToProjectId !== null && (typeof routeToProjectId !== "string" || !routeToProjectId)) throw new Error("bad target");

    const entry = await prisma.timeEntry.findUnique({
        where: { id: entryId },
        select: { id: true, projectId: true, routedFromProjectId: true, invoiceId: true, invoicedAt: true, project: { select: { isLogistics: true } } },
    });
    if (!entry) throw new Error("Time entry not found");
    if (!entry.project.isLogistics && !entry.routedFromProjectId) throw new Error("Not a logistics entry");
    if (entry.invoiceId != null || entry.invoicedAt != null) throw new Error("This time was already invoiced and cannot be re-routed");

    // Guarded at write time (Codex): an invoice landing between our read and
    // the write must win — count 0 means "changed underneath you".
    if (routeToProjectId === null) {
        if (entry.routedFromProjectId) {
            const r = await prisma.timeEntry.updateMany({
                where: { id: entryId, invoiceId: null, invoicedAt: null },
                data: { projectId: entry.routedFromProjectId, costCodeId: null, routedFromProjectId: null, routedAt: null, routedById: null },
            });
            if (r.count === 0) throw new Error("This entry changed underneath you (invoiced?) — reload");
        }
    } else {
        const job = await prisma.project.findUnique({ where: { id: routeToProjectId }, select: { id: true, isLogistics: true, status: true } });
        if (!job || job.isLogistics || job.status !== PROJECT_STATUS_IN_PROGRESS) throw new Error("That job is not available for routing");
        const costCode = await prisma.costCode.findUnique({ where: { code: LOGISTICS_COST_CODE }, select: { id: true } });
        if (!costCode) throw new Error(`${LOGISTICS_COST_CODE} cost code is missing`);
        const r = await prisma.timeEntry.updateMany({
            where: { id: entryId, invoiceId: null, invoicedAt: null },
            data: {
                projectId: job.id,
                costCodeId: costCode.id,
                estimateItemId: null,
                routedFromProjectId: entry.routedFromProjectId ?? entry.projectId,
                routedAt: new Date(),
                routedById: user.id,
            },
        });
        if (r.count === 0) throw new Error("This entry changed underneath you (invoiced?) — reload");
    }
    revalidatePath("/manager/logistics");
    revalidatePath("/manager/time-entries");
    return { success: true };
}

// ── Receipt intake queue (the /automation Receipts tab, Phase 2 §2) ──────────

/**
 * Every action below is guarded twice, and both guards matter:
 *
 *   1. The SAME permission the register is gated by (`financialReports`) — a
 *      "use server" export is a live POST endpoint whether or not any UI links
 *      to it (the dead-server-actions lesson), so the gate lives in the action,
 *      not in the page that renders the button.
 *   2. A compare-and-swap on `state`. The 5-minute intake worker is moving
 *      these same rows; an unguarded update would silently overwrite whatever
 *      it just decided. `updateMany({ where: { id, state: expected } })`
 *      returning 0 means the view was stale — that is surfaced as an error the
 *      UI toasts, NEVER as a silent no-op that looks like it worked.
 *
 * None of these calls QuickBooks inline. The queue's only job is to change what
 * the worker will do on its next pass.
 */
async function assertReceiptQueueAccess() {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Not authenticated");
    if (!hasPermission(user, "financialReports")) throw new Error("Forbidden");
    return user;
}

class StaleReceiptIntakeError extends Error {
    constructor(message = "This receipt changed underneath you — refresh and try again.") {
        super(message);
        this.name = "StaleReceiptIntakeError";
    }
}

/**
 * The worker's OWNERSHIP, expressed as a where-clause.
 *
 * The 5-minute worker claims a row by writing `claimToken` + `claimedAt`. That
 * is ownership. `nextRetryAt` is SCHEDULING — when the worker should next look
 * at the row — and fencing on it (the previous shape) conflated the two: a row
 * merely waiting out its retry backoff could not be voided, while a row
 * genuinely mid-send looked free the instant its backoff elapsed.
 *
 * A claim older than the lease belongs to a run that died and is not honoured.
 */
const WORKER_CLAIM_LEASE_MS = 10 * 60_000;

function notClaimedByWorker(now: Date): Prisma.ReceiptIntakeWhereInput {
    return {
        OR: [
            { claimedAt: null },
            { claimedAt: { lt: new Date(now.getTime() - WORKER_CLAIM_LEASE_MS) } },
        ],
    };
}

const WORKER_BUSY_MESSAGE = "The pipeline is working on this receipt right now — try again in a minute.";

/**
 * Distinguish "you were looking at stale state" from "the worker holds it".
 * A guarded update returning 0 cannot tell them apart, and the two need
 * different words: one says refresh, the other says wait.
 */
async function receiptIntakeWriteFailure(id: string, allowedStates: readonly string[], now: Date): Promise<never> {
    const current = await prisma.receiptIntake.findUnique({
        where: { id },
        select: { state: true, claimedAt: true },
    });
    if (!current) throw new StaleReceiptIntakeError("That receipt no longer exists — refresh.");
    const claimLive = current.claimedAt !== null
        && current.claimedAt.getTime() > now.getTime() - WORKER_CLAIM_LEASE_MS;
    if (allowedStates.includes(current.state) && claimLive) {
        throw new StaleReceiptIntakeError(WORKER_BUSY_MESSAGE);
    }
    throw new StaleReceiptIntakeError();
}

/**
 * Run a park plan: try the key-releasing write, and if it matched nothing try
 * the key-KEEPING one. Both losing means the row moved under the human (or the
 * worker holds it), which is a refusal they can act on.
 *
 * The order matters and is not an optimisation: the release branch is the
 * narrower CAS (`sendAttempted: false`), so trying it first means the common,
 * clean case takes exactly one write, and the fallback only runs for a row
 * whose send had already started.
 */
/**
 * INTAKE WRITES FROM THE QUEUE UI, EACH IN ITS OWN LOCKED TRANSACTION (Codex
 * PR #443 gate round 42, finding 1). Unmarking a duplicate, parking an orphan
 * or re-routing a row all change what the missing-receipt sweep reads, so they
 * queue behind it exactly like the worker's writes do.
 */
const evidenceIntakeUpdateMany = (args: Prisma.ReceiptIntakeUpdateManyArgs): Promise<{ count: number }> =>
    withReceiptEvidenceLock<{ count: number }>(fn => prisma.$transaction(fn), tx => tx.receiptIntake.updateMany(args));

async function runParkWrites(
    plan: ParkPlan,
    id: string,
    expected: string,
    now: Date,
    // Defaults to the global client; mark-duplicate passes its transaction so
    // the writes land under the same row locks its validation was done with.
    client: Pick<typeof prisma, "receiptIntake"> = prisma,
): Promise<void> {
    const released = await client.receiptIntake.updateMany(plan.release);
    if (released.count === 1) return;
    const kept = await client.receiptIntake.updateMany(plan.keep);
    if (kept.count === 1) return;
    await receiptIntakeWriteFailure(id, [expected], now);
}

/**
 * The row version the submitted view was rendering, as a Date.
 *
 * WHY THE STATE IS NOT ENOUGH (the ABA problem). A row can be NEEDS_REVIEW when
 * the page renders, get routed, booked, and parked in NEEDS_REVIEW again a
 * minute later — same state, different row. A state-only CAS happily applies a
 * decision somebody made about the FIRST one to the second. `updatedAt` moves
 * on every write, so pinning it means "the row I was looking at", not "a row
 * that looks like the one I was looking at".
 */
function assertExpectedUpdatedAt(value: unknown): Date {
    const at = typeof value === "string" || value instanceof Date ? new Date(value) : new Date(NaN);
    if (Number.isNaN(at.getTime())) {
        throw new Error("Refresh the page and try again — that view is out of date.");
    }
    return at;
}

/** Every state a manual write may legally act on (never BOOKED/ARCHIVED). */
const HUMAN_WRITABLE_STATES = ["STAGING", "RECEIVED", "READ", "NEEDS_JOB", "NEEDS_REVIEW", "BOOKING", "DUPLICATE", "VOID", "NON_RECEIPT"];

/**
 * The state the user's page was showing when they clicked.
 *
 * Every queue action CASes on THIS, not on a set of "states this action is
 * allowed from". The difference matters: a row can legally be in NEEDS_REVIEW
 * when the page renders and legally be in NEEDS_REVIEW again a minute later
 * having been routed, booked and parked in between — an allowed-set check
 * happily applies a decision made about a row that no longer exists. Matching
 * the exact state the human SAW turns that into a refusal they can act on.
 */
function assertExpectedState(expectedState: string): string {
    if (typeof expectedState !== "string" || !HUMAN_WRITABLE_STATES.includes(expectedState)) {
        throw new Error("Refresh the page and try again — that view is out of date.");
    }
    return expectedState;
}

function revalidateReceiptQueue() {
    revalidatePath("/automation");
}

/**
 * Assign a job (and optionally a cost code) and hand the row back to the
 * worker at `READ`. Deliberately NOT `BOOKING`: routing owns dedup, and
 * jumping the row straight to booking would skip the weak/strong duplicate
 * checks that stand between a re-uploaded receipt and a double purchase.
 */
export async function setReceiptIntakeJob(id: string, projectId: string, expectedState: string, expectedUpdatedAt: string, costCodeId?: string | null) {
    const user = await assertReceiptQueueAccess();
    if (typeof id !== "string" || !id) throw new Error("id is required");
    if (typeof projectId !== "string" || !projectId) throw new Error("projectId is required");
    if (!canAccessProject(user, projectId)) throw new Error("Forbidden");

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new Error("That job no longer exists");

    // "The cost code exists" is not a permission — it has to be a phase of THIS
    // job. The same rule the clock-in validator applies.
    if (costCodeId && !(await isCostCodeAllowedForProject(prismaPhaseDataSource, projectId, costCodeId))) {
        throw new Error("That cost code isn't a phase on this job");
    }

    // MOVING A RECEIPT MOVES ITS JOB, so a code carried over from the old job is
    // almost certainly wrong for the new one — and a wrong code is a wrong job
    // cost, which is worse than no code at all. Clear it and let the worker
    // re-suggest against the new project's phases.
    const existing = await prisma.receiptIntake.findUnique({
        where: { id },
        select: { costCodeId: true },
    });
    const keepExisting = !costCodeId
        && existing?.costCodeId
        && await isCostCodeAllowedForProject(prismaPhaseDataSource, projectId, existing.costCodeId);

    const now = new Date();
    const expected = assertExpectedState(expectedState);
    const seenAt = assertExpectedUpdatedAt(expectedUpdatedAt);
    if (!["NEEDS_JOB", "NEEDS_REVIEW"].includes(expected)) {
        throw new Error("A job can only be set on a receipt waiting for one");
    }
    const result = await evidenceIntakeUpdateMany({
        where: { id, state: expected, updatedAt: seenAt, ...notClaimedByWorker(now) },
        data: {
            projectId,
            // Explicit code wins; otherwise keep one still valid here, else null.
            costCodeId: costCodeId ?? (keepExisting ? existing!.costCodeId : null),
            // A stale suggestion is re-derived against the new job's phases.
            suggestedCostCodeId: null,
            suggestedConfidence: null,
            state: "READ",
            stateReason: null,
            lastError: null,
            nextRetryAt: null,
        },
    });
    if (result.count === 0) await receiptIntakeWriteFailure(id, [expected], now);
    revalidateReceiptQueue();
    return { success: true };
}

/** Park a row as a duplicate of another. `duplicateOfId` must be a real, different row. */
export async function markReceiptIntakeDuplicate(id: string, duplicateOfId: string, expectedState: string, expectedUpdatedAt: string) {
    await assertReceiptQueueAccess();
    if (typeof id !== "string" || !id) throw new Error("id is required");
    if (typeof duplicateOfId !== "string" || !duplicateOfId) throw new Error("duplicateOfId is required");
    if (id === duplicateOfId) throw new Error("A receipt can't be a duplicate of itself");

    const now = new Date();
    const expected = assertExpectedState(expectedState);
    if (["BOOKED", "ARCHIVED", "VOID"].includes(expected)) {
        // A BOOKED row is money history — it is never reclassified from here.
        throw new Error("That receipt can't be marked a duplicate");
    }
    const seenAt = assertExpectedUpdatedAt(expectedUpdatedAt);

    /**
     * ONE TRANSACTION, BOTH ROWS LOCKED, VALIDATED AFTER THE LOCK.
     *
     * The check that the target is a real original has to happen while holding
     * it, or the classic pair race gets through: Marge marks A→B while Richard
     * marks B→A. Both validations pass (neither row is a duplicate YET), both
     * writes land, and the two rows now point at each other — a cycle nothing
     * downstream can resolve, and neither receipt has an original.
     *
     * LOCKED IN ID ORDER, which is the whole reason this cannot deadlock: two
     * transactions wanting the same pair ask for it in the same sequence, so
     * one waits rather than both holding half of what the other needs. Postgres
     * would detect a deadlock and abort one, but "we designed for an abort" is
     * not the same as "this cannot happen".
     *
     * `FOR UPDATE` on a plain SELECT of both ids, ordered — one statement, so
     * there is no window between taking the first lock and the second.
     */
    /**
     * BOTH ROWS AND EVERY ROW THAT POINTS AT EITHER (round-39 gate, finding 2),
     * through the shared guard so this path and the worker cannot diverge
     * (round-40 gate, finding 1). One statement, ordered by id, so the lock
     * order is the same for every transaction and this cannot deadlock — and so
     * the inbound references cannot change between the read and the write.
     */
    await withDuplicateChainLock(fn => prisma.$transaction(fn), [id, duplicateOfId], async (tx, inbound) => {
        // The evidence lock is the OUTERMOST lock (round-42 gate, finding 1):
        // marking a row DUPLICATE changes what the sweep reads.
        await lockReceiptEvidence(tx);

        // RE-READ INSIDE THE LOCK. Everything below was read a moment ago on
        // the page; under the lock it is read again because that is the only
        // version that can still be true when the write lands.
        const original = await tx.receiptIntake.findUnique({
            where: { id: duplicateOfId },
            select: { id: true, state: true, duplicateOfId: true },
        });
        if (!original) throw new Error("That original receipt no longer exists");
        // THE TARGET MUST BE A REAL ORIGINAL. Pointing at a row that is itself
        // DUPLICATE builds a chain nobody can follow ("a duplicate of a
        // duplicate of..."), and pointing at a VOID row files this receipt
        // behind something that was cancelled — in both cases the original it
        // claims to duplicate does not exist as far as the pipeline is
        // concerned.
        if (original.state === "DUPLICATE") throw new Error("That receipt is itself a duplicate — point at the original instead");
        if (original.state === "VOID") throw new Error("That receipt was voided — it can't be the original");
        // NO CYCLES. A points at B while B points at A is unresolvable, and the
        // chain check above does not catch it on its own.
        if (original.duplicateOfId === id) throw new Error("Those two receipts already point at each other");
        /**
         * AND THIS ROW MUST NOT ALREADY BE SOMEBODY ELSE'S ORIGINAL.
         *
         * The target check above stops A→B when B is a duplicate; this stops
         * the same chain built from the other end — A→B already exists and B is
         * now being marked a duplicate of C, leaving A pointing at a copy.
         * Refused rather than retargeted: which receipt is the real original is
         * a human's call, and unmarking A is how they make it.
         */
        const inboundToSource = inbound.get(id) ?? [];
        if (inboundToSource.length > 0) throw duplicateChainRefusal("duplicate", inboundToSource);

        // CAS on the exact state the view saw. The lease fence matters most on
        // this path: BOOKING is a legal source state, and BOOKING is where the
        // worker is mid-send. The strong key goes back ONLY if the send had not
        // started — see planParkWrites.
        await runParkWrites(planParkWrites({
            id,
            expectedState: expected,
            targetState: "DUPLICATE",
            stateReason: `manual-dup:${duplicateOfId}`,
            extraData: { duplicateOfId },
            claimFence: { updatedAt: seenAt, ...notClaimedByWorker(now) },
        }), id, expected, now, tx);
    });
    revalidateReceiptQueue();
    return { success: true };
}

/** "Not a duplicate" — back to READ so routing and dedup run again from scratch. */
export async function unmarkReceiptIntakeDuplicate(id: string, expectedUpdatedAt: string) {
    await assertReceiptQueueAccess();
    if (typeof id !== "string" || !id) throw new Error("id is required");

    const now = new Date();
    const seenAt = assertExpectedUpdatedAt(expectedUpdatedAt);
    const result = await evidenceIntakeUpdateMany({
        // DUPLICATE twice over is the ABA case exactly: unmarked, re-marked
        // against a different original, and this click would undo the new one.
        where: { id, state: "DUPLICATE", updatedAt: seenAt, ...notClaimedByWorker(now) },
        data: { state: "READ", duplicateOfId: null, stateReason: null, lastError: null, nextRetryAt: null },
    });
    if (result.count === 0) await receiptIntakeWriteFailure(id, ["DUPLICATE"], now);
    revalidateReceiptQueue();
    return { success: true };
}

/** Void anything that hasn't booked. A BOOKED/ARCHIVED row is refused outright. */
export async function voidReceiptIntake(id: string, expectedState: string, expectedUpdatedAt: string) {
    await assertReceiptQueueAccess();
    if (typeof id !== "string" || !id) throw new Error("id is required");

    const now = new Date();
    const expected = assertExpectedState(expectedState);
    if (["BOOKED", "ARCHIVED"].includes(expected)) throw new Error("A booked receipt can't be voided");
    const seenAt = assertExpectedUpdatedAt(expectedUpdatedAt);
    /**
     * VOIDING AN ORIGINAL LEAVES ITS DUPLICATES POINTING AT A CANCELLED ROW
     * (round-39 gate, finding 2) — the same broken relation the mark path
     * refuses to create when it checks the target for VOID, arriving a
     * different way. Locked and checked in ONE transaction with the write, or
     * a duplicate marked a moment later slips through the gap.
     */
    await withDuplicateChainLock(fn => prisma.$transaction(fn), [id], async (tx, inboundById) => {
        // Same rule for a void: the row stops being evidence.
        await lockReceiptEvidence(tx);
        const inbound = inboundById.get(id) ?? [];
        if (inbound.length > 0) throw duplicateChainRefusal("void", inbound);
        await runParkWrites(planParkWrites({
            id,
            expectedState: expected,
            targetState: "VOID",
            stateReason: "voided-by-user",
            claimFence: { updatedAt: seenAt, ...notClaimedByWorker(now) },
        }), id, expected, now, tx);
    });
    revalidateReceiptQueue();
    return { success: true };
}

/**
 * "Retry now": clear the error and make the row due. The 5-minute worker picks
 * it up on its next pass — this never calls QuickBooks inline, so a stuck QBO
 * can't turn a button click into a 30-second page hang.
 *
 * `attempts` is deliberately NOT reset: the retry ceiling exists so a
 * permanently-broken document stops hammering QBO, and a human clicking retry
 * shouldn't silently remove that ceiling.
 */
export async function retryReceiptIntake(id: string, expectedUpdatedAt: string) {
    await assertReceiptQueueAccess();
    if (typeof id !== "string" || !id) throw new Error("id is required");

    const now = new Date();
    const seenAt = assertExpectedUpdatedAt(expectedUpdatedAt);
    const current = await prisma.receiptIntake.findUnique({
        where: { id },
        select: { state: true, stateReason: true, nextRetryAt: true },
    });
    if (!current) throw new StaleReceiptIntakeError("That receipt no longer exists — refresh.");

    // A CLOSED list of retryable reasons, and each one resumes where it failed.
    // Retrying a document VERDICT (multi-doc, no-estimate, a dup) just parks it
    // again with the same reason, having spent an attempt and a QBO round trip.
    const target = retryTargetFor(current.state, current.stateReason);
    if (!target) {
        throw new StaleReceiptIntakeError(
            "This one can't be retried — it needs a decision, not another attempt.",
        );
    }

    const result = await evidenceIntakeUpdateMany({
        // The row version the human SAW, not merely the state and reason the
        // re-read found: those two can be identical across a whole failed
        // attempt in between.
        where: { id, state: current.state, stateReason: current.stateReason, updatedAt: seenAt, ...notClaimedByWorker(now) },
        data: {
            // RECEIVED re-reads the document; BOOKING resumes at the send.
            state: target,
            // Scheduling only. Ownership is claimToken/claimedAt and belongs to
            // the worker; clearing a live claim here would let two runs process
            // the same row.
            nextRetryAt: now,
            // The reason described a failure that is now being retried; leaving
            // it would make the row look parked while it is actually in flight.
            stateReason: null,
            lastError: null,
        },
    });
    if (result.count === 0) await receiptIntakeWriteFailure(id, [current.state], now);
    revalidateReceiptQueue();
    return { success: true };
}

/**
 * "Resolved" on an orphaned QuickBooks purchase (Codex round-4 item 1).
 *
 * A row whose send went out and was then voided carries `postVoidQbPurchaseId`
 * — a real Purchase in QuickBooks that only a human can remove. This does NOT
 * touch QuickBooks: it records that somebody went and voided it there, so the
 * Exceptions queue empties as the work is actually done rather than by anyone
 * clicking it away. The id is kept in `stateReason` so the audit trail survives.
 */
export async function resolveOrphanedQbPurchase(id: string, expectedUpdatedAt: string) {
    await assertReceiptQueueAccess();
    if (typeof id !== "string" || !id) throw new Error("id is required");
    const seenAt = assertExpectedUpdatedAt(expectedUpdatedAt);

    const row = await prisma.receiptIntake.findUnique({
        where: { id },
        select: { state: true, stateReason: true, postVoidQbPurchaseId: true },
    });
    if (!row?.postVoidQbPurchaseId) {
        return { success: false, stale: true as const, reason: "Nothing to resolve on this receipt — refresh." };
    }

    // APPENDED, never overwritten. `stateReason` already carries why the row is
    // where it is ("booked-after-void", a dup reference, a QBO fault); replacing
    // it to record the cleanup would destroy the only note saying how the row
    // got into this state in the first place.
    const note = `orphan-purchase-resolved:${row.postVoidQbPurchaseId}`;
    const stateReason = row.stateReason && !row.stateReason.includes(note)
        ? `${row.stateReason}; ${note}`.slice(0, 400)
        : (row.stateReason ?? note);

    // CAS on BOTH the state and the purchase id: the worker can move the state
    // and a second tab can resolve the same row, and either means the view this
    // click came from is stale.
    const result = await evidenceIntakeUpdateMany({
        where: { id, state: row.state, updatedAt: seenAt, postVoidQbPurchaseId: row.postVoidQbPurchaseId },
        data: { postVoidQbPurchaseId: null, stateReason },
    });
    if (result.count === 0) {
        return { success: false, stale: true as const, reason: "This receipt changed underneath you — refresh and try again." };
    }
    revalidateReceiptQueue();
    return { success: true, stale: false as const };
}

/**
 * Read ONE QuickBooks Purchase by id. Read-only, and the only QBO call any
 * receipts-queue action makes.
 *
 * Imported lazily for the same reason the payments actions do it: pulling the
 * QuickBooks client into this module's top-level graph costs every unrelated
 * server action that imports actions.ts.
 */
async function readQboPurchase(purchaseId: string): Promise<QboPurchaseFacts | null> {
    const { getFreshQBTokens } = await import("./quickbooks-payments");
    const { qbFetch, parseJsonOrNull } = await import("./quickbooks");
    const tokens = await getFreshQBTokens();
    const response = await qbFetch(`/purchase/${encodeURIComponent(purchaseId)}`, tokens);
    // 404 is an ANSWER — that id is not a purchase in this realm — and it is
    // the answer an operator's typo produces, so it must not read as an outage.
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`QuickBooks returned ${response.status}`);
    const body = await parseJsonOrNull<{ Purchase?: { Id?: string; TotalAmt?: number; PrivateNote?: string } }>(response);
    const purchase = body?.Purchase;
    if (!purchase?.Id) return null;
    // TotalAmt is dollars as a float; cents is what everything here compares in.
    const totalCents = typeof purchase.TotalAmt === "number" && Number.isFinite(purchase.TotalAmt)
        ? Math.round(purchase.TotalAmt * 100)
        : null;
    // PrivateNote carries `[gtr-file:<fileId>]` on everything this pipeline
    // creates — the only field that ties a Purchase to one document.
    return {
        id: String(purchase.Id),
        totalCents,
        privateNote: typeof purchase.PrivateNote === "string" ? purchase.PrivateNote : null,
    };
}

/**
 * Resolve an orphaned Purchase whose ID WE NEVER LEARNED (round-14 item 3).
 *
 * The row's send went out and no answer came back, so `sendAttempted` is true,
 * the strong dedup key is still held, and nobody knows whether QuickBooks
 * created anything. Before this the row was a dead end: the key stayed held
 * forever, and a corrected re-send of the same receipt bounced as a duplicate
 * with nothing on screen saying why.
 *
 * Two honest answers, both from a human who went and looked, both AUDITED with
 * who said so:
 *
 *   "located"     — they found the Purchase and typed its id. We READ IT BACK
 *                   from QuickBooks and require the amount to match this
 *                   receipt to the cent. A transposed digit lands on somebody
 *                   else's purchase, and accepting it would attach this
 *                   receipt's history to theirs. The id is recorded exactly
 *                   where the known-id case records it, so the same "mark
 *                   resolved" flow finishes the job.
 *   "no-purchase" — they checked and there is none. THIS is what frees the
 *                   dedup key, because now we know the re-send is safe.
 *
 * QuickBooks is READ-ONLY here, as everywhere in this pipeline: this never
 * voids, edits or creates anything. It reads one purchase by id.
 */
export async function resolveUnknownOrphan(
    id: string,
    decision: "located" | "no-purchase",
    expectedUpdatedAt: string,
    input?: { purchaseId?: string; note?: string },
) {
    const user = await assertReceiptQueueAccess();
    if (typeof id !== "string" || !id) throw new Error("id is required");
    if (decision !== "located" && decision !== "no-purchase") {
        throw new Error("decision must be located or no-purchase");
    }
    const seenAt = assertExpectedUpdatedAt(expectedUpdatedAt);
    const note = typeof input?.note === "string" ? input.note.trim().slice(0, 200) : "";

    const row = await prisma.receiptIntake.findUnique({
        where: { id },
        select: {
            state: true, stateReason: true, totalCents: true, vendor: true,
            source: true, sourceRef: true,
            sendAttempted: true, dedupStrongKey: true, postVoidQbPurchaseId: true,
        },
    });
    if (!row) throw new StaleReceiptIntakeError("That receipt no longer exists — refresh.");

    /**
     * THE WHOLE ORPHAN PREDICATE, IN THE WHERE CLAUSE.
     *
     * Read-then-write is not enough here and the gap is not theoretical: every
     * one of these conditions can change between the page render and the click
     * (the worker re-claims the row, a re-send books it, another operator
     * resolves it). Re-checking them in JavaScript proves what was true a
     * moment ago; putting them in the UPDATE proves what is true at the write.
     *
     * A BOOKED or ARCHIVED row is not in the permitted set at all — it booked,
     * it has its Purchase id, and the orphan path must not be able to rewrite
     * money history even when called directly.
     */
    const orphanWhere = {
        id,
        state: { in: [...UNKNOWN_ORPHAN_STATES] },
        stateReason: { endsWith: `:${POSSIBLE_ORPHAN_REASON}` },
        sendAttempted: true,
        // An UNKNOWN-id orphan by definition has no id recorded. A row that has
        // one is the other kind, and "mark resolved" is its path.
        postVoidQbPurchaseId: null,
        // The worker must not be mid-anything with this row.
        claimToken: null,
        updatedAt: seenAt,
    };

    let purchaseId: string | null = null;
    if (decision === "located") {
        if (!isQboPurchaseId(input?.purchaseId)) {
            return { success: false, stale: false as const, reason: "That is not a QuickBooks purchase id." };
        }
        const claimed = (input!.purchaseId as string).trim();
        let facts: QboPurchaseFacts | null;
        try {
            facts = await readQboPurchase(claimed);
        } catch (error) {
            // An outage is not a verdict. Refuse and let them try later rather
            // than record an unverified id.
            return {
                success: false,
                stale: false as const,
                reason: `QuickBooks did not answer, so that id is unverified: ${error instanceof Error ? error.message : "unknown error"}`,
            };
        }
        // The SAME fileId book.ts stamps into the Purchase's PrivateNote.
        const expectedFileId = driveFileIdOf({ source: row.source, sourceRef: row.sourceRef }) ?? id;
        const verdict = verifyOrphanClaim(facts, row.totalCents, expectedFileId);
        if (!verdict.ok) {
            return { success: false, stale: false as const, reason: verdict.detail ?? `That purchase ${verdict.reason.replace("-", " ")}.` };
        }
        purchaseId = verdict.purchaseId;
    }

    // ONE CAS, on the row version the operator was looking at.
    const data = purchaseId !== null
        ? {
            // Recorded where the known-id case records it, so the existing
            // "mark resolved" flow takes it from here. The key stays HELD: a
            // Purchase exists, so a re-send would double-book.
            postVoidQbPurchaseId: purchaseId,
            stateReason: `${row.stateReason ?? "possible-orphan"}; ${ORPHAN_RESOLUTIONS.located}:${purchaseId}`.slice(0, 400),
        }
        : {
            // No Purchase exists, so the quarantine has nothing to protect.
            dedupStrongKey: null,
            stateReason: `${row.stateReason ?? "possible-orphan"}; ${ORPHAN_RESOLUTIONS.noPurchase}`.slice(0, 400),
        };
    const result = await evidenceIntakeUpdateMany({ where: orphanWhere, data });
    if (result.count === 0) {
        // TYPED, so the caller can tell "somebody else got here first" from
        // "this row was never an unknown-id orphan" — the second one is a bug
        // or a direct call, not a race.
        return {
            success: false,
            stale: true as const,
            code: "not-an-unknown-orphan" as const,
            reason: "This receipt is not an unresolved unknown-id orphan any more — refresh and look again.",
        };
    }

    // AUDITED, and after the write: an event describing a decision that did not
    // commit is worse than no event. Never fails the action — the decision is
    // already recorded on the row itself.
    await logAutomationEvent({
        kind: ORPHAN_AUDIT_KIND,
        status: purchaseId !== null ? ORPHAN_RESOLUTIONS.located : ORPHAN_RESOLUTIONS.noPurchase,
        source: "receipts-tab",
        vendor: row.vendor ?? undefined,
        amountCents: row.totalCents ?? undefined,
        reason: note || undefined,
        detail: {
            intakeId: id,
            qbPurchaseId: purchaseId,
            // WHO said so. That is the whole point of auditing a judgement call.
            decidedBy: user.email ?? user.id,
            decidedAt: new Date().toISOString(),
            dedupStrongKeyReleased: purchaseId === null && row.dedupStrongKey !== null,
        },
    }).catch(() => { /* audit only — the row already carries the decision */ });

    revalidateReceiptQueue();
    return { success: true, stale: false as const };
}

/** The stored card snapshot, back into items. A malformed one records nothing. */
function parseCardItems(itemsJson: string): CardItem[] {
    try {
        const parsed: unknown = JSON.parse(itemsJson);
        return Array.isArray(parsed) ? (parsed as CardItem[]) : [];
    } catch {
        return [];
    }
}

/**
 * Resolve a Chat card whose delivery was never confirmed (round-13 item 6).
 *
 * An UNCERTAIN row means we called the webhook and did not get an answer we
 * could believe: the card may be sitting in the crew's space right now, or it
 * may never have arrived. The cron will NEVER decide that for itself — an
 * automatic resend risks a duplicate chase card, and a duplicate teaches people
 * the list is noise. So a human looks in the space and says which it was:
 *
 *   "delivered" — it is there, AND the operator pastes the thread and message
 *     names off it. Without those the row stays UNCERTAIN: a card marked POSTED
 *     with no thread identity is the worst of both worlds — closed, possibly
 *     never seen, and with nothing for a reply to resolve against. The row is
 *     POSTED, the day is closed, and the bridge can find the thread.
 *   "resend"    — it is not there. The row goes back to PENDING with its claim
 *     released, so the retry pass sends it — and that pass re-verifies the
 *     snapshot first, so anything answered in the meantime is dropped.
 *
 * CASed on `updatedAt` as well as `status`: two people looking at the same
 * queue must not both decide, and the cron may have moved the row since the
 * page rendered.
 */
export async function resolveUncertainCard(
    cardId: string,
    decision: "delivered" | "resend",
    expectedUpdatedAt: string,
    delivery?: { threadName?: string; messageName?: string },
) {
    await assertReceiptQueueAccess();
    if (typeof cardId !== "string" || !cardId) throw new Error("cardId is required");
    if (decision !== "delivered" && decision !== "resend") throw new Error("decision must be delivered or resend");
    const seenAt = assertExpectedUpdatedAt(expectedUpdatedAt);

    // NO THREAD IDENTITY, NO "DELIVERED". Both names, well-formed, same space.
    // "resend" is always available as the other answer, so refusing here never
    // leaves an operator stuck — it leaves the row where it was.
    const confirmed = decision === "delivered"
        ? parseChatDelivery(delivery?.threadName, delivery?.messageName)
        : null;
    if (decision === "delivered" && !confirmed) {
        return {
            success: false,
            stale: false as const,
            reason: "Paste the thread and message names from the card (spaces/…/threads/… and spaces/…/messages/…), or choose Resend.",
        };
    }

    const card = await prisma.receiptRequestCard.findUnique({
        where: { id: cardId },
        select: { itemsJson: true, pacificDate: true, owner: true },
    });
    const result = await prisma.$transaction(async tx => {
        const written = await tx.receiptRequestCard.updateMany({
            where: { id: cardId, status: "UNCERTAIN", updatedAt: seenAt },
            data: confirmed
                ? {
                    status: "POSTED",
                    // The card IS out; `postedAt` is what stops any later run
                    // re-posting the day.
                    postedAt: new Date(),
                    // The bridge identities, so a reply in that thread resolves
                    // like any other card's.
                    threadName: confirmed.threadName,
                    messageName: confirmed.messageName,
                    lastError: null,
                    claimedAt: null,
                    claimToken: null,
                }
                : {
                    status: "PENDING",
                    // THE QUEUE STATE, in its own column (round-41 gate, finding
                    // 3). `lastError` is diagnostic text and every later write
                    // replaces it — a rejection wrote `rejected:*` straight over
                    // the marker, and the drain and the health probe both lost
                    // the row. `resendQueuedAt` is what they query now; the text
                    // stays for a human reading the queue.
                    resendQueuedAt: new Date(),
                    lastError: CARD_RESEND_QUEUED_REASON,
                    // Ownership released, so the retry pass can claim it.
                    claimedAt: null,
                    claimToken: null,
                },
        });

        /**
         * AND THE THREAD RECORD, in the same transaction.
         *
         * A card the cron posts writes one; a card an operator marks delivered
         * used to write none — so the sweep and the bridge had nothing to
         * resolve a reply against, and worse, the items still counted as NEVER
         * CARDED. Never-carded-first ordering then put them at the front of
         * tomorrow's card, and the crew was asked again for receipts they had
         * already been asked for. Same claim, same trace, one writer.
         */
        if (written.count === 1 && confirmed && card) {
            await recordCardOnIssues(
                { items: parseCardItems(card.itemsJson), date: card.pacificDate, requestId: requestIdFor(card.owner, card.pacificDate) },
                confirmed.threadName,
                confirmed.messageName,
                new Date(),
                tx,
            );
        }
        return written;
    });
    if (result.count === 0) {
        return { success: false, stale: true as const, reason: "That card changed underneath you — refresh." };
    }
    revalidateReceiptQueue();
    return { success: true, stale: false as const };
}

/**
 * Assign the owner of an unattributed bank charge (Codex round-4 item 7).
 *
 * A QBO-minted line whose descriptor carries no card tail lands in the
 * `unattributed` bucket. Marge picks the owner here, it is written to
 * `displayDetails.ownerOverride` — a key the nightly matcher PRESERVES, so the
 * next recompute cannot undo it — and the morning card picks the item up.
 */
export async function setMissingReceiptOwner(issueId: string, owner: string, expectedVersion: number) {
    await assertReceiptQueueAccess();
    if (typeof issueId !== "string" || !issueId) throw new Error("issueId is required");
    if (!RECEIPT_OWNER_CHOICES.includes(owner)) throw new Error("That isn't an owner we recognise");
    // THE VERSION THE PAGE RENDERED, not the one this click happens to find.
    //
    // Reading the current version here and then guarding on it guards against
    // nothing an operator cares about: the row can be cleared, reopened and
    // rewritten between the render and the click, and the read would simply
    // pick up whatever it had become — so an assignment aimed at the charge
    // somebody was LOOKING at lands on a different question with the same id.
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw new Error("Refresh the page and try again — that view is out of date.");
    }

    const issue = await prisma.reviewIssue.findUnique({
        where: { id: issueId },
        select: { id: true, version: true, targetType: true, displayDetails: true, clearedAt: true },
    });
    if (!issue || issue.targetType !== RECEIPT_REQUEST_TARGET_TYPE) throw new Error("Not a missing-receipt item");
    if (issue.clearedAt !== null) throw new Error("That item is already answered — refresh.");
    if (issue.version !== expectedVersion) {
        throw new Error("That item changed underneath you — refresh and try again.");
    }

    let details: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(issue.displayDetails ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
    } catch { /* a corrupt blob still gets an owner */ }
    details.ownerOverride = owner;

    // Version-guarded: the nightly sweep writes this same column, and losing
    // that race silently would drop the assignment on the floor.
    const result = await prisma.reviewIssue.updateMany({
        // The RENDERED version, so the write is refused atomically even if the
        // row moved between the read above and this statement.
        where: { id: issue.id, version: expectedVersion, clearedAt: null },
        data: { displayDetails: JSON.stringify(details), version: { increment: 1 } },
    });
    if (result.count === 0) throw new Error("That item changed underneath you — refresh and try again.");
    revalidateReceiptQueue();
    return { success: true };
}
