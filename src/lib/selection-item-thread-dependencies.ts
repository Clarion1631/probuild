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
import type { ThreadActor, ThreadAttachment, ThreadFileCandidate, ThreadItem } from "@/lib/selection-item-thread-core";

const DESIGN_FILES_FOLDER_NAME = "Design Files";

// Deletes a ProjectFile row + its storage object, best-effort. Used for
// whole-batch cleanup when a later file in an attachment batch fails to
// upload — every already-created row/object in the batch is rolled back
// before the caller rethrows.
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
            throw new Error(`File type not allowed: ${ext || "(no extension)"}.`);
        }
    }

    const folderId = await findOrCreateDesignFilesFolder(item.projectId);
    const uploaded: ThreadAttachment[] = [];
    try {
        for (const file of files) {
            const result = await saveProjectFile({
                buffer: file.buffer,
                fileName: file.name,
                mimeType: file.mimeType || mimeTypeForFileName(file.name),
                projectId: item.projectId,
                folderId,
                visibility: "shared",
                uploadedById: actor.userId,
                uploadedByClient: !actor.isStaff,
            });
            if (!result.ok) {
                throw new Error(result.error);
            }
            uploaded.push(result.file);
        }
        return uploaded;
    } catch (err) {
        // Whole-batch cleanup: roll back every file already created in this
        // batch, not just the one that failed.
        await Promise.all(uploaded.map((file) => deleteProjectFileAndStorage(file.id)));
        throw err;
    }
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
            throw new Error("Item not found");
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
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

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
                `New comment on ${item.name} — ${companyName}`,
                `<!DOCTYPE html>
                <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                    <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                        <h2 style="font-size: 20px; margin: 0 0 8px;">New comment on ${item.name}</h2>
                        <p style="color: #666; margin: 0 0 8px;">From: <strong>${comment.authorName}</strong></p>
                        <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
                            <p style="margin: 0; line-height: 1.6;">${comment.body}</p>
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
        const project = await prisma.project.findUnique({
            where: { id: item.projectId },
            select: { name: true, client: { select: { email: true } } },
        });
        if (project?.client?.email) {
            await sendNotification(
                project.client.email,
                `${companyName} sent you a message — ${project.name}`,
                `<!DOCTYPE html>
                <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                    <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                        <h2 style="font-size: 20px; margin: 0 0 8px;">New comment on ${item.name}</h2>
                        <p style="color: #666; margin: 0 0 8px;">From: <strong>${comment.authorName}</strong></p>
                        <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
                            <p style="margin: 0; line-height: 1.6;">${comment.body}</p>
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

export function revalidate(projectId: string) {
    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);
    revalidatePath(`/projects/${projectId}`, "layout");
    revalidatePath(`/portal/projects/${projectId}`);
}
