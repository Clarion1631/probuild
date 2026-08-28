import { ALLOWED_FILE_EXTENSIONS, fileExtension } from "./project-files";
import {
    uploadProjectFileBufferCore,
    validateProjectFileTarget,
    type ProjectFileVisibility,
    type UploadProjectFileBufferInput,
    type UploadProjectFileResult,
    type UploadProjectFileSuccess,
} from "./project-file-core";
import { DriveFileTooLargeError, downloadDriveFile, getFileMeta, type DriveFileMeta } from "./lead-drive";
import type { McpActorContext } from "./mcp-actor";

export const MAX_GOOGLE_DRIVE_IMPORT_BYTES = 25 * 1024 * 1024;
const GOOGLE_DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export type GoogleDriveImportInput = {
    projectId?: string;
    leadId?: string;
    driveFileId: string;
    folder?: string;
    visibility?: ProjectFileVisibility;
    actor: McpActorContext;
};

export type GoogleDriveImportSuccess = Omit<UploadProjectFileSuccess, "url">;
export type GoogleDriveImportResult =
    | { ok: true; data: GoogleDriveImportSuccess }
    | { ok: false; error: string };

export type GoogleDriveImportDependencies = {
    getFileMeta: (fileId: string) => Promise<DriveFileMeta>;
    downloadDriveFile: (fileId: string, options: { maxBytes?: number }) => Promise<Buffer>;
    validateProjectFileTarget: (projectId?: string, leadId?: string) => Promise<void>;
    uploadProjectFileBufferCore: (input: UploadProjectFileBufferInput) => Promise<UploadProjectFileResult>;
};

const productionDependencies: GoogleDriveImportDependencies = {
    getFileMeta,
    downloadDriveFile,
    validateProjectFileTarget,
    uploadProjectFileBufferCore,
};

function tooLargeError(sizeBytes: number): string {
    return `Google Drive file is ${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB — imports are limited to 25 MiB.`;
}

function validDriveFileId(fileId: string): boolean {
    return GOOGLE_DRIVE_FILE_ID.test(fileId);
}

function validateMetadata(meta: DriveFileMeta, requestedId: string): string | null {
    if (meta.id !== requestedId) return "Google Drive returned a different file than requested.";
    if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
        return "Google-native files are not supported yet. Export the document to PDF, Word, or Excel first.";
    }
    const ext = fileExtension(meta.name);
    if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
        return `File type "${ext || "(no extension)"}" not allowed. Allowed: ${[...ALLOWED_FILE_EXTENSIONS].join(", ")}.`;
    }
    if (meta.size !== undefined && (!Number.isSafeInteger(meta.size) || meta.size < 0)) {
        return "Google Drive returned an invalid file size.";
    }
    if (meta.size !== undefined && meta.size > MAX_GOOGLE_DRIVE_IMPORT_BYTES) {
        return tooLargeError(meta.size);
    }
    return null;
}

/**
 * Imports one existing Google Drive file through server-side OAuth and the
 * canonical ProjectFile/Supabase path. It deliberately never accepts or emits
 * a Drive URL, OAuth token, or document bytes.
 */
export async function importGoogleDriveFileCore(
    input: GoogleDriveImportInput,
    dependencies: GoogleDriveImportDependencies = productionDependencies,
): Promise<GoogleDriveImportResult> {
    if (!validDriveFileId(input.driveFileId)) {
        return { ok: false, error: "Provide a bare Google Drive file ID, not a URL, path, or file name." };
    }

    let meta: DriveFileMeta;
    try {
        meta = await dependencies.getFileMeta(input.driveFileId);
    } catch {
        return { ok: false, error: "Could not access that Google Drive file. Confirm the ProBuild Drive connection can access it." };
    }
    const metadataError = validateMetadata(meta, input.driveFileId);
    if (metadataError) return { ok: false, error: metadataError };

    try {
        await dependencies.validateProjectFileTarget(input.projectId, input.leadId);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Could not validate the ProBuild target." };
    }

    let buffer: Buffer;
    try {
        buffer = await dependencies.downloadDriveFile(input.driveFileId, { maxBytes: MAX_GOOGLE_DRIVE_IMPORT_BYTES });
    } catch (error) {
        if (error instanceof DriveFileTooLargeError) return { ok: false, error: "Google Drive file exceeds the 25 MiB import limit." };
        return { ok: false, error: "Could not download that Google Drive file. Confirm it is still accessible." };
    }
    if (buffer.length === 0) return { ok: false, error: "Google Drive returned a 0-byte file." };
    if (buffer.length > MAX_GOOGLE_DRIVE_IMPORT_BYTES) {
        return { ok: false, error: tooLargeError(buffer.length) };
    }

    const saved = await dependencies.uploadProjectFileBufferCore({
        projectId: input.projectId,
        leadId: input.leadId,
        fileName: meta.name,
        buffer,
        folder: input.folder,
        visibility: input.visibility ?? "team",
        actor: input.actor,
        activityAction: "imported_google_drive_file",
        activityMetadata: {
            source: "google_drive",
            driveFileId: input.driveFileId,
            sizeBytes: buffer.length,
        },
    });
    if (!saved.ok) return saved;

    const { url: _url, ...safeData } = saved.data;
    return { ok: true, data: safeData };
}
