// Production implementations of the injected dependencies consumed by
// postSelectionItemComment (src/lib/selection-item-thread-core.ts). Kept out
// of src/app/api/selections/item-comments/route.ts so this module can be
// imported directly by tests — Next.js route.ts files may only export HTTP
// method handlers (plus a small reserved set), so a plain lib module is the
// correct place for anything else that needs to be testable in isolation.
import { prisma } from "@/lib/prisma";
import {
    ALLOWED_FILE_EXTENSIONS,
    PORTAL_UPLOAD_EXTENSIONS,
    fileExtension,
    mimeTypeForFileName,
    saveProjectFile,
} from "@/lib/project-files";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import { sendNotification } from "@/lib/email";
import { logActivity } from "@/lib/activity-log";
import { revalidatePath } from "next/cache";
import { ThreadNotFoundError, ThreadValidationError, type ThreadActor, type ThreadAttachment, type ThreadFileCandidate, type ThreadItem } from "@/lib/selection-item-thread-core";

const DESIGN_FILES_FOLDER_NAME = "Design Files";

// Both email templates below interpolate client-controlled strings (item
// name, author name, comment body) directly into HTML — every one of them
// must be escaped, or a comment body like "<img src=x onerror=...>" would
// execute in whatever mail client renders it.
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Resolves a SelectionProposal for the thread core, treating a candidate
// whose parent Decision is soft-deleted the same as a missing/deleted item —
// deleteDecision leaves candidates attached (their own deletedAt stays null)
// but every read path hides them once the decision is gone, so the thread
// must be neither postable nor markable-read from that state either.
export async function findThreadItem(itemId: string): Promise<ThreadItem | null> {
    const proposal = await prisma.selectionProposal.findUnique({
        where: { id: itemId },
        select: {
            id: true,
            projectId: true,
            deletedAt: true,
            name: true,
            decisionId: true,
            decision: { select: { deletedAt: true } },
        },
    });
    if (!proposal) return null;
    if (proposal.decisionId && proposal.decision?.deletedAt) return null;
    return proposal;
}

// Deletes a ProjectFile row + its storage object, best-effort. Used both by
// uploadAttachments' own in-batch rollback (a later file in the batch fails
// to upload) and by the core's cleanupAttachments dependency below (upload
// succeeds but createComment throws afterward) — every already-created row/
// object is rolled back before the caller rethrows, regardless of which step
// failed.
async function deleteProjectFileAndStorage(fileId: string): Promise<void> {
    const supabase = getSupabase();
    const file = await prisma.projectFile.findUnique({ where: { id: fileId }, select: { url: true } });
    await prisma.projectFile.delete({ where: { id: fileId } }).catch(() => {});
    if (!file || !supabase) return;
    const marker = `/${STORAGE_BUCKET}/`;
    const idx = file.url.indexOf(marker);
    if (idx === -1) return;
    const path = file.url.slice(idx + marker.length);
    await supabase.storage.from(STORAGE_BUCKET).remove([path]).catch(() => {});
}

async function findOrCreateDesignFilesFolder(projectId: string): Promise<string> {
    let folder = await prisma.fileFolder.findFirst({
        where: { projectId, name: DESIGN_FILES_FOLDER_NAME, parentId: null, visibility: "shared" },
    });
    if (!folder) {
        folder = await prisma.fileFolder.create({
            data: { projectId, name: DESIGN_FILES_FOLDER_NAME, visibility: "shared" },
        });
    }
    return folder.id;
}

// Called by the core AFTER assertAccess + validation both pass — never
// before. Extensions are checked for every file up front (per the now-known
// actor) so a batch with any disallowed extension never uploads anything.
export async function uploadAttachments(
    files: ThreadFileCandidate[],
    actor: ThreadActor,
    item: ThreadItem,
): Promise<ThreadAttachment[]> {
    const allowed = actor.isStaff ? ALLOWED_FILE_EXTENSIONS : PORTAL_UPLOAD_EXTENSIONS;
    for (const file of files) {
        const ext = fileExtension(file.name);
        if (!allowed.has(ext)) {
            throw new ThreadValidationError(`File type not allowed: ${ext || "(no extension)"}.`);
        }
    }

    const folderId = await findOrCreateDesignFilesFolder(item.projectId);
    const uploaded: ThreadAttachment[] = [];
    try {
        for (const file of files) {
            const result = await saveProjectFile({
                buffer: file.buffer,
                fileName: file.name,
                // Derived strictly from the (already-validated) extension —
                // never trust the client-supplied File.type, which is
                // trivially spoofable (e.g. a ".exe" renamed with a fake
                // "image/png" type would otherwise slip past extension
                // checks upstream and get served back with that content type).
                mimeType: mimeTypeForFileName(file.name),
                projectId: item.projectId,
                folderId,
                visibility: "shared",
                uploadedById: actor.userId,
                uploadedByClient: !actor.isStaff,
            });
            if (!result.ok) {
                throw new Error(result.error);
            }
            // Canonical shape only — saveProjectFile's result also carries
            // `size`, which must never leak into the stored attachments JSON.
            uploaded.push({ id: result.file.id, name: result.file.name, url: result.file.url });
        }
        return uploaded;
    } catch (err) {
        // Whole-batch cleanup: roll back every file already created in this
        // batch, not just the one that failed.
        await Promise.all(uploaded.map((file) => deleteProjectFileAndStorage(file.id)));
        throw err;
    }
}

// The core's cleanupAttachments dependency: called for EVERY uploaded
// attachment when createComment throws after a successful upload (e.g. the
// CAS row-lock losing a concurrent soft-delete race) — this is the path a
// lone in-uploadAttachments rollback can't reach, since by then
// uploadAttachments has already returned successfully.
export async function cleanupAttachments(attachments: ThreadAttachment[]): Promise<void> {
    await Promise.all(attachments.map((attachment) => deleteProjectFileAndStorage(attachment.id)));
}

export async function createComment(input: {
    item: ThreadItem;
    actor: ThreadActor;
    body: string;
    attachments: ThreadAttachment[] | null;
}) {
    const { item, actor, body, attachments } = input;
    const comment = await prisma.$transaction(async (tx) => {
        // Row-lock via a conditional no-op write (SelectionProposal has no
        // updatedAt column to bump) — count 0 means a concurrent soft-delete
        // won the race, and this blocks that delete until commit either way.
        const locked = await tx.selectionProposal.updateMany({
            where: { id: item.id, deletedAt: null },
            data: { deletedAt: null },
        });
        if (locked.count === 0) {
            throw new ThreadNotFoundError();
        }
        return tx.selectionItemComment.create({
            data: {
                proposalId: item.id,
                authorType: actor.isStaff ? "TEAM" : "CLIENT",
                authorUserId: actor.isStaff ? actor.userId : null,
                authorClientId: !actor.isStaff ? actor.clientId : null,
                authorName: actor.actorName,
                body,
                attachments: attachments ? JSON.stringify(attachments) : null,
                readByTeamAt: actor.isStaff ? new Date() : null,
                readByClientAt: actor.isStaff ? null : new Date(),
            },
        });
    });

    await logActivity({
        projectId: item.projectId,
        actorType: actor.isStaff ? "TEAM" : "CLIENT",
        actorName: actor.actorName,
        actorUserId: actor.userId ?? undefined,
        action: "selection_comment",
        entityType: "selectionProposal",
        entityId: item.id,
        entityName: item.name,
    });

    return comment;
}

export async function notify(input: { item: ThreadItem; actor: ThreadActor; comment: Awaited<ReturnType<typeof createComment>> }) {
    const { item, actor, comment } = input;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const [settings, project] = await Promise.all([
        prisma.companySettings.findUnique({ where: { id: "singleton" } }),
        prisma.project.findUnique({
            where: { id: item.projectId },
            select: { name: true, client: { select: { email: true } } },
        }),
    ]);
    const companyName = settings?.companyName || "Your Contractor";
    const projectName = project?.name || "your project";
    // Every client-controlled string interpolated into these templates
    // (item name, author name, comment body) must be escaped — a comment
    // body containing "<img src=x onerror=...>" would otherwise execute in
    // whatever mail client renders it.
    const safeItemName = escapeHtml(item.name);
    const safeAuthorName = escapeHtml(comment.authorName);
    const safeBody = escapeHtml(comment.body);

    if (!actor.isStaff) {
        // CLIENT post → notify the team, gated on the existing "New Message"
        // toggle (messageReceived means "client sent us something").
        const msgToggleOn = !settings?.notificationToggles || (() => {
            try {
                return JSON.parse(settings.notificationToggles!).messageReceived !== false;
            } catch {
                return true;
            }
        })();
        if (settings?.notificationEmail && msgToggleOn) {
            await sendNotification(
                settings.notificationEmail,
                `New comment on ${item.name} — ${projectName}`,
                `<!DOCTYPE html>
                <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                    <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                        <h2 style="font-size: 20px; margin: 0 0 8px;">New comment on ${safeItemName}</h2>
                        <p style="color: #666; margin: 0 0 8px;">From: <strong>${safeAuthorName}</strong></p>
                        <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
                            <p style="margin: 0; line-height: 1.6;">${safeBody}</p>
                        </div>
                        <div style="text-align: center; margin-top: 24px;">
                            <a href="${appUrl}/projects/${item.projectId}/selections" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                                Reply in ProBuild
                            </a>
                        </div>
                    </div>
                </body></html>`
            );
        }
    } else {
        // TEAM post → email the client, NOT gated on messageReceived (that
        // toggle governs inbound notifications only — existing team-to-client
        // mail is ungated, api/messages/route.ts:192).
        if (project?.client?.email) {
            await sendNotification(
                project.client.email,
                `${companyName} sent you a message — ${projectName}`,
                `<!DOCTYPE html>
                <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                    <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                        <h2 style="font-size: 20px; margin: 0 0 8px;">New comment on ${safeItemName}</h2>
                        <p style="color: #666; margin: 0 0 8px;">From: <strong>${safeAuthorName}</strong></p>
                        <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
                            <p style="margin: 0; line-height: 1.6;">${safeBody}</p>
                        </div>
                        <div style="text-align: center; margin-top: 24px;">
                            <a href="${appUrl}/portal/projects/${item.projectId}/selections" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                                View in Portal
                            </a>
                        </div>
                    </div>
                </body></html>`
            );
        }
    }
}

// Excludes candidates whose parent Decision is soft-deleted, matching the
// visibility rule findThreadItem enforces above — those items are invisible
// in every read path (getProjectDecisions/getProjectDecisionsForPortal), so
// a badge that still counted their comments would point at a thread the
// viewer can never actually open.
function visibleProposalWhere(projectId: string) {
    return {
        projectId,
        deletedAt: null,
        OR: [{ decisionId: null }, { decision: { deletedAt: null } }],
    };
}

/** Nav badge count — unread CLIENT comments across every visible item on the
 * project, for the project layout's "Selection Boards" link. Lives in a
 * plain (non-"use server") module: it takes only a projectId with no auth
 * check of its own, so it must never be directly remotely invokable —
 * callers are server components that already resolved the project in
 * context (src/app/projects/[id]/layout.tsx). */
export async function getUnreadSelectionThreadCountForStaff(projectId: string): Promise<number> {
    return prisma.selectionItemComment.count({
        where: { authorType: "CLIENT", readByTeamAt: null, proposal: visibleProposalWhere(projectId) },
    });
}

/** Portal Selections tab badge count — unread TEAM comments across every
 * visible item on the project. Same non-"use server" placement/caveat as
 * getUnreadSelectionThreadCountForStaff above. */
export async function getUnreadSelectionThreadCountForPortal(projectId: string): Promise<number> {
    return prisma.selectionItemComment.count({
        where: { authorType: "TEAM", readByClientAt: null, proposal: visibleProposalWhere(projectId) },
    });
}

export function revalidate(projectId: string) {
    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);
    revalidatePath(`/projects/${projectId}`, "layout");
    revalidatePath(`/portal/projects/${projectId}`);
}
