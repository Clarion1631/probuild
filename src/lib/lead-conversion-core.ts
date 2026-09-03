import { revalidatePath as nextRevalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { geocodeJobSiteAddress } from "./geocode";
import { ensureStandardFolders } from "./project-folders";
import { assertEstimateMoveKeepsAttributionPairs } from "./expense-attribution";

// Session-free core of lead → project conversion, shared by the permission-gated
// `convertLeadToProject` server action in actions.ts and by callers that have
// ALREADY authorized the conversion some other way (the portal's
// approveEstimate, which validated client ownership via resolveSessionClientId,
// and /api/manager/jobs, which authenticates a mobile token or session and then
// runs assertLeadAccess). actions.ts is a server-action module, so every export
// there is a remotely invokable endpoint — auth-free logic must live here, NOT
// there. (This file deliberately carries no server-action directive.)
//
// The body of convertLeadToProjectCore is moved verbatim from actions.ts;
// behavior is unchanged for every existing path.

// Cache revalidation is best-effort: it throws outside a Next request context
// (e.g. verification scripts), and a stale cache page is never worth failing a
// conversion whose transaction already committed. This IS a behavior change
// from the pre-extraction action, where a revalidate failure propagated out of
// an already-successful conversion — so the failure is logged rather than
// silently dropped, otherwise a real invalidation outage would look like a
// clean conversion with stale /leads and /projects pages.
function revalidatePath(path: string) {
    try {
        nextRevalidatePath(path);
    } catch (err) {
        console.warn(`[Lead conversion] revalidatePath(${path}) failed:`, err);
    }
}

export async function convertLeadToProjectCore(leadId: string) {
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        include: { client: true }
    });
    if (!lead) throw new Error("Lead not found");

    // Idempotency: if this lead was already converted, return existing project
    const existingProject = await prisma.project.findUnique({ where: { leadId } });
    if (existingProject) return { id: existingProject.id };

    // Normalize the job-site address (outside the transaction — external call).
    // Also catches legacy leads saved before geocode-on-save existed; a precise
    // match seeds the project's time-clock geofence coordinates.
    const geo = await geocodeJobSiteAddress(lead.location);

    // Wrap entire conversion in a transaction for atomicity
    const project = await prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
            data: {
                name: lead.name,
                clientId: lead.clientId,
                location: geo?.formattedAddress ?? lead.location,
                ...(geo?.lat != null && geo?.lng != null ? { locationLat: geo.lat, locationLng: geo.lng } : {}),
                status: "Waiting to Start",
                startDate: lead.expectedStartDate ?? null,
                type: lead.projectType || "Unknown",
                managerId: lead.managerId || null,
                tags: lead.tags || null,
                leadId,
            },
        });

        // Relink child records to the new project.
        // Estimate has no onDelete:Cascade on its lead FK — keep leadId so it
        // remains visible from both the lead view and the project view.
        //
        // MOVING AN ESTIMATE BREAKS THE WRITE-ONCE ATTRIBUTION PAIR (round 32).
        // This is the ONE path in the codebase that changes an existing
        // `Estimate.projectId` — everything else that "moves" an estimate
        // actually creates a new one (duplicateEstimate). `Expense.projectId`
        // is write-once and `Estimate.projectId` is not, so an estimate that
        // already has expenses pinned to another job would leave those rows
        // claiming job A while the estimate, the billing paths and the phase
        // cascade all follow job B. The guard refuses rather than dragging the
        // expenses across: those rows carry job A's cost codes and receipts,
        // and re-attributing them is a deliberate operation, not a side effect
        // of winning a lead.
        //
        // The ids are read, locked, checked and moved as ONE set. Re-scanning
        // by `leadId` for the write would move an estimate the guard never saw
        // — a row can acquire this leadId between the two statements under READ
        // COMMITTED, and the whole point of the lock is that the set is fixed.
        const movingEstimates = await tx.estimate.findMany({
            where: { leadId },
            select: { id: true },
        });
        const movingEstimateIds = movingEstimates.map(estimate => estimate.id);
        await assertEstimateMoveKeepsAttributionPairs(tx, movingEstimateIds, project.id);
        if (movingEstimateIds.length) {
            await tx.estimate.updateMany({
                where: { id: { in: movingEstimateIds } },
                data: { projectId: project.id },
            });
        }
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

    // The ProBuild Files tab gets its own canonical scaffold. This is
    // deliberately independent of Drive provisioning and never rolls back a
    // successfully-created project.
    try {
        await ensureStandardFolders(project.id);
    } catch (folderErr) {
        console.error("[Project folders] Failed to create the standard scaffold:", folderErr);
    }

    // Provision Google Drive Folders in the background/async after project creation
    try {
        const { createProjectDriveFolder } = await import("./google-drive");
        const driveResult = await createProjectDriveFolder(project.name, lead.client?.email);

        if (driveResult.success) {
            // Create a FileFolder record in ProBuild representing this Google Drive folder
            await prisma.fileFolder.create({
                data: {
                    name: `📁 Google Drive - Client Shared Folder`,
                    projectId: project.id,
                    visibility: "shared", // Shared with client
                }
            });
            console.log(`[Google Drive] Successfully provisioned Google Drive for project: ${project.id}`);
        }
    } catch (driveErr) {
        console.error("[Google Drive] Failed to provision Google Drive folder during conversion:", driveErr);
    }

    revalidatePath("/leads");
    revalidatePath("/projects");
    revalidatePath(`/leads/${leadId}`);

    return { id: project.id };
}
