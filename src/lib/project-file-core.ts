import { prisma } from "./prisma";
import {
    ALLOWED_FILE_EXTENSIONS,
    fileExtension,
    mimeTypeForFileName,
    saveProjectFile,
    type SaveProjectFileInput,
    type SaveProjectFileResult,
} from "./project-files";
import { ensureStandardFolders } from "./project-folders";
import {
    mcpActivityActorName,
    type McpActorContext,
} from "./mcp-actor";

export const MAX_UPLOAD_BYTES = 3_300_000;
export const MAX_UPLOAD_BASE64_CHARS = 4_400_000;

export type ProjectFileVisibility = "team" | "shared";

export type UploadProjectFileInput = {
    projectId?: string;
    leadId?: string;
    fileName: string;
    contentBase64: string;
    folder?: string;
    visibility?: ProjectFileVisibility;
    actor: McpActorContext;
};

// Server-side sources (for example Google Drive) must use this path instead of
// serializing bytes back through an MCP tool. It deliberately shares target,
// folder, visibility, Storage, ProjectFile, and activity behavior with the
// base64 connector path below.
export type UploadProjectFileBufferInput = Omit<UploadProjectFileInput, "contentBase64"> & {
    buffer: Buffer;
    activityAction?: string;
    activityMetadata?: Record<string, unknown>;
};

export type UploadProjectFileSuccess = {
    fileId: string;
    name: string;
    sizeBytes: number;
    folder: string | null;
    visibility: ProjectFileVisibility;
    url: string;
    movedToProject?: string;
    note: string;
};

export type UploadProjectFileResult =
    | { ok: true; data: UploadProjectFileSuccess }
    | { ok: false; error: string };

export type UploadFilesItem = {
    fileName: string;
    contentBase64: string;
    folder?: string;
    visibility?: ProjectFileVisibility;
};

export type UploadProjectFilesInput = {
    projectId?: string;
    leadId?: string;
    defaultFolder?: string;
    files: UploadFilesItem[];
    actor: McpActorContext;
};

type UploadDependencies = {
    saveProjectFile?: (input: SaveProjectFileInput) => Promise<SaveProjectFileResult>;
};

type ValidatedUpload = {
    buffer: Buffer;
    fileName: string;
    folder?: string;
    visibility?: ProjectFileVisibility;
};

type ResolvedTarget = {
    projectId: string | null;
    leadId: string | null;
    movedToProjectNote: string | null;
};

function invalidTargetError(): string {
    return "Provide exactly one of projectId or leadId (use find_job / list_projects / list_leads to resolve the target).";
}

function validateFileExtension(fileName: string): void {
    const ext = fileExtension(fileName);
    if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
        throw new Error(`File type "${ext || "(no extension)"}" not allowed. Allowed: ${[...ALLOWED_FILE_EXTENSIONS].join(", ")}.`);
    }
}

function decodeUploadFile(input: UploadFilesItem): ValidatedUpload {
    const b64 = input.contentBase64.replace(/\s+/g, "");
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
        throw new Error("contentBase64 is not valid base64 — send the file's raw bytes standard-base64-encoded, without a data: URL prefix.");
    }
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length === 0) {
        throw new Error("contentBase64 decoded to 0 bytes.");
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
        throw new Error(`File is ${(buffer.length / 1_000_000).toFixed(1)} MB — the connector accepts up to ~3 MB. Upload larger files in ProBuild directly.`);
    }
    return {
        buffer,
        fileName: input.fileName,
        folder: input.folder,
        visibility: input.visibility,
    };
}

function validateOneFile(input: UploadFilesItem): ValidatedUpload {
    validateFileExtension(input.fileName);
    return decodeUploadFile(input);
}

export function validateUploadFilesBatch(files: UploadFilesItem[]): ValidatedUpload[] {
    if (files.length < 1 || files.length > 8) {
        throw new Error("upload_files accepts between 1 and 8 files.");
    }
    const normalizedBase64Length = files.reduce(
        (total, file) => total + file.contentBase64.replace(/\s+/g, "").length,
        0,
    );
    if (normalizedBase64Length > MAX_UPLOAD_BASE64_CHARS) {
        throw new Error("Combined files exceed the connector's ~3 MB total upload limit. Split them into smaller calls or upload larger files in ProBuild directly.");
    }
    const validated = files.map(validateOneFile);
    const totalBytes = validated.reduce((total, file) => total + file.buffer.length, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) {
        throw new Error(`Combined files are ${(totalBytes / 1_000_000).toFixed(1)} MB — the connector accepts up to ~3 MB total. Split them into smaller calls.`);
    }
    return validated;
}

async function resolveTarget(projectId?: string, leadId?: string): Promise<ResolvedTarget> {
    if ((projectId ? 1 : 0) + (leadId ? 1 : 0) !== 1) {
        throw new Error(invalidTargetError());
    }
    let targetProjectId: string | null = projectId ?? null;
    let targetLeadId: string | null = leadId ?? null;
    let movedToProjectNote: string | null = null;
    if (targetProjectId) {
        const project = await prisma.project.findUnique({
            where: { id: targetProjectId },
            select: { id: true },
        });
        if (!project) {
            throw new Error(`No project with id ${targetProjectId}. Use find_job or list_projects.`);
        }
    } else {
        const lead = await prisma.lead.findUnique({
            where: { id: targetLeadId! },
            select: { id: true },
        });
        if (!lead) {
            throw new Error(`No lead with id ${targetLeadId}. Use find_job or list_leads.`);
        }
        const linkedProject = await prisma.project.findFirst({
            where: { leadId: targetLeadId! },
            select: { id: true, name: true },
        });
        if (linkedProject) {
            movedToProjectNote = `This lead was already converted to project "${linkedProject.name}" — the file was filed on the project.`;
            targetProjectId = linkedProject.id;
            targetLeadId = null;
        }
    }
    return {
        projectId: targetProjectId,
        leadId: targetLeadId,
        movedToProjectNote,
    };
}

export async function validateProjectFileTarget(projectId?: string, leadId?: string): Promise<void> {
    await resolveTarget(projectId, leadId);
}

async function ensureProjectScaffoldIfEmpty(projectId: string): Promise<void> {
    const folderCount = await prisma.fileFolder.count({
        where: { projectId, parentId: null },
    });
    if (folderCount === 0) await ensureStandardFolders(projectId);
}

async function prepareBatchFolders(
    target: ResolvedTarget,
    files: ValidatedUpload[],
): Promise<string | null> {
    const requested = new Map<string, { name: string; hasShared: boolean }>();
    for (const file of files) {
        const folderName = file.folder?.trim();
        if (!folderName) continue;
        const key = folderName.toLocaleLowerCase();
        const current = requested.get(key);
        requested.set(key, {
            name: current?.name ?? folderName,
            hasShared: current?.hasShared === true || file.visibility === "shared",
        });
    }
    if (requested.size === 0) return null;

    const existing = await prisma.fileFolder.findMany({
        where: {
            projectId: target.projectId,
            leadId: target.leadId,
            parentId: null,
        },
        select: { id: true, name: true, visibility: true },
    });
    const byName = new Map(existing.map(folder => [folder.name.trim().toLocaleLowerCase(), folder]));

    // Validate every requested folder before creating any of them. A later
    // team-folder conflict must not leave earlier shared folders behind after
    // the whole batch is rejected.
    for (const [key, request] of requested) {
        const folder = byName.get(key);
        if (folder && request.hasShared && folder.visibility !== "shared") {
            return `Folder "${folder.name}" is not a shared folder, so the customer could never see a shared file inside it. Upload the shared file without a folder, use a folder that is already shared, or drop visibility to keep it internal.`;
        }
    }
    for (const [key, request] of requested) {
        const folder = byName.get(key);
        if (!folder && request.hasShared) {
            await prisma.fileFolder.create({
                data: {
                    name: request.name,
                    projectId: target.projectId,
                    leadId: target.leadId,
                    parentId: null,
                    visibility: "shared",
                },
                select: { id: true },
            });
        }
    }
    return null;
}

export async function uploadProjectFileCore(
    input: UploadProjectFileInput,
    dependencies: UploadDependencies = {},
): Promise<UploadProjectFileResult> {
    try {
        validateFileExtension(input.fileName);
    } catch (error) {
        return { ok: false, error: (error as Error).message };
    }
    let validated: ValidatedUpload;
    try {
        validated = decodeUploadFile(input);
    } catch (error) {
        return { ok: false, error: (error as Error).message };
    }
    return uploadProjectFileBufferCore({
        ...input,
        buffer: validated.buffer,
    }, dependencies);
}

export async function uploadProjectFileBufferCore(
    input: UploadProjectFileBufferInput,
    dependencies: UploadDependencies = {},
): Promise<UploadProjectFileResult> {
    if ((input.projectId ? 1 : 0) + (input.leadId ? 1 : 0) !== 1) {
        return { ok: false, error: invalidTargetError() };
    }
    if (input.buffer.length === 0) {
        return { ok: false, error: "File decoded to 0 bytes." };
    }
    try {
        validateFileExtension(input.fileName);
    } catch (error) {
        return { ok: false, error: (error as Error).message };
    }

    let target: ResolvedTarget;
    try {
        target = await resolveTarget(input.projectId, input.leadId);
    } catch (error) {
        return { ok: false, error: (error as Error).message };
    }

    // Always store an EXPLICIT visibility (never null/inherit): the portal
    // shows null-visibility files inside shared folders.
    const fileVisibility = input.visibility ?? "team";
    let folderId: string | null = null;
    const folderName = input.folder?.trim();
    if (folderName) {
        const scope = {
            projectId: target.projectId,
            leadId: target.leadId,
            parentId: null,
        };
        const existing = await prisma.fileFolder.findFirst({
            where: {
                ...scope,
                name: { equals: folderName, mode: "insensitive" },
            },
            select: { id: true, name: true, visibility: true },
        });
        if (existing && fileVisibility === "shared" && existing.visibility !== "shared") {
            return {
                ok: false,
                error: `Folder "${existing.name}" is not a shared folder, so the customer could never see a shared file inside it. Upload the shared file without a folder, use a folder that is already shared, or drop visibility to keep it internal.`,
            };
        }
        folderId = existing
            ? existing.id
            : (await prisma.fileFolder.create({
                data: {
                    name: folderName,
                    ...scope,
                    visibility: fileVisibility === "shared" ? "shared" : "team",
                },
                select: { id: true },
            })).id;
    }

    const save = dependencies.saveProjectFile ?? saveProjectFile;
    const saved = await save({
        buffer: input.buffer,
        fileName: input.fileName,
        mimeType: mimeTypeForFileName(input.fileName),
        projectId: target.projectId,
        leadId: target.leadId,
        folderId,
        visibility: fileVisibility,
        uploadedById: input.actor.actorUserId,
        activity: {
            actorName: mcpActivityActorName(input.actor.actorLabel),
            action: input.activityAction ?? "uploaded_file",
            entityType: "project_file",
            entityName: input.fileName,
            metadata: {
                folderId,
                visibility: fileVisibility,
                sizeBytes: input.buffer.length,
                ...input.activityMetadata,
            },
        },
    });
    if (!saved.ok) return { ok: false, error: saved.error };

    const filesUrl = target.projectId
        ? `https://probuild.goldentouchremodeling.com/projects/${target.projectId}/files`
        : `https://probuild.goldentouchremodeling.com/leads/${target.leadId}/files`;
    return {
        ok: true,
        data: {
            fileId: saved.file.id,
            name: saved.file.name,
            sizeBytes: saved.file.size,
            folder: folderName ?? null,
            visibility: fileVisibility,
            url: filesUrl,
            ...(target.movedToProjectNote ? { movedToProject: target.movedToProjectNote } : {}),
            note: fileVisibility === "shared"
                ? "This file IS visible to the customer (in the client portal, once the job has a project with the portal's Files section enabled)."
                : "Internal file — the customer cannot see it.",
        },
    };
}

export async function uploadProjectFilesCore(
    input: UploadProjectFilesInput,
    dependencies: UploadDependencies = {},
): Promise<
    | { ok: false; error: string }
    | { ok: true; results: Array<{ fileName: string; ok: boolean; fileId?: string; error?: string }> }
> {
    let validated: ValidatedUpload[];
    try {
        validated = validateUploadFilesBatch(input.files.map(file => ({
            ...file,
            folder: file.folder ?? input.defaultFolder,
        })));
    } catch (error) {
        return { ok: false, error: (error as Error).message };
    }

    let target: ResolvedTarget;
    try {
        target = await resolveTarget(input.projectId, input.leadId);
        if (target.projectId) await ensureProjectScaffoldIfEmpty(target.projectId);
        const folderError = await prepareBatchFolders(target, validated);
        if (folderError) return { ok: false, error: folderError };
    } catch (error) {
        return { ok: false, error: (error as Error).message };
    }

    const results = [];
    for (const file of validated) {
        const result = await uploadProjectFileCore({
            projectId: target.projectId ?? undefined,
            leadId: target.leadId ?? undefined,
            fileName: file.fileName,
            contentBase64: file.buffer.toString("base64"),
            folder: file.folder,
            visibility: file.visibility,
            actor: input.actor,
        }, dependencies);
        results.push(result.ok
            ? { fileName: file.fileName, ok: true, fileId: result.data.fileId }
            : { fileName: file.fileName, ok: false, error: result.error });
    }
    return { ok: true, results };
}
