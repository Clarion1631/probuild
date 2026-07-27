import { prisma } from "@/lib/prisma";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";

// Single source of truth for which file types may enter project/lead storage —
// shared by the browser upload route (/api/files) and the MCP connector's
// upload_file tool so the two allowlists can't drift.
export const ALLOWED_FILE_EXTENSIONS = new Set([
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
    ".txt", ".rtf", ".dwg", ".dxf",
]);

// Client-portal file uploads (two-way Design Files exchange). Narrower purpose
// than the team allowlist above — images, PDFs, CAD, common office docs, and
// zip archives (designers often send a zipped folder of files) — but adds
// .zip, which the team allowlist doesn't need.
export const PORTAL_UPLOAD_EXTENSIONS = new Set([
    ...ALLOWED_FILE_EXTENSIONS,
    ".zip",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".txt": "text/plain",
    ".rtf": "application/rtf",
    ".dwg": "image/vnd.dwg",
    ".dxf": "image/vnd.dxf",
};

export function fileExtension(fileName: string): string {
    return fileName.includes(".") ? `.${fileName.split(".").pop()!.toLowerCase()}` : "";
}

export function mimeTypeForFileName(fileName: string): string {
    return MIME_BY_EXTENSION[fileExtension(fileName)] ?? "application/octet-stream";
}

export type SaveProjectFileInput = {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    projectId?: string | null;
    leadId?: string | null;
    folderId?: string | null;
    // null = inherit from the folder (default "team"), matching /api/files.
    visibility?: string | null;
    uploadedById?: string | null;
};

export type SaveProjectFileResult =
    | { ok: true; file: { id: string; name: string; size: number; url: string } }
    | { ok: false; error: string };

/**
 * Stores a file in Supabase Storage and records it as a ProjectFile, using the
 * same storage-path scheme as /api/files so both surfaces list identically.
 * Callers are responsible for authorization and extension validation.
 */
export async function saveProjectFile(input: SaveProjectFileInput): Promise<SaveProjectFileResult> {
    const supabase = getSupabase();
    if (!supabase) {
        return { ok: false, error: "Storage not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY missing)." };
    }

    const prefix = input.projectId ? `projects/${input.projectId}` : `leads/${input.leadId}`;
    const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${prefix}/${Date.now()}_${safeName}`;

    const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, input.buffer, { contentType: input.mimeType, upsert: false });
    if (uploadError) {
        return { ok: false, error: `Storage upload failed: ${uploadError.message}` };
    }

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    try {
        const record = await prisma.projectFile.create({
            data: {
                name: input.fileName,
                url: urlData?.publicUrl || storagePath,
                size: input.buffer.length,
                mimeType: input.mimeType,
                ...(input.visibility && { visibility: input.visibility }),
                ...(input.projectId && { projectId: input.projectId }),
                ...(input.leadId && { leadId: input.leadId }),
                ...(input.folderId && { folderId: input.folderId }),
                uploadedById: input.uploadedById ?? null,
            },
            select: { id: true, name: true, size: true, url: true },
        });
        return { ok: true, file: record };
    } catch (err: any) {
        // The object is already in storage; without the DB row it would be
        // orphaned and invisible everywhere — best-effort delete before failing.
        await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
        return { ok: false, error: `File record creation failed: ${err?.message ?? "unknown error"}` };
    }
}
