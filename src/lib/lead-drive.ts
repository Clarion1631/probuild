// Per-lead Google Drive folders for mobile lead intake (photos/videos/scans).
//
// Credentials resolve in order: GMAIL_REFRESH_TOKEN env -> CompanySettings
// .googleDriveRefreshToken (set by /api/gmail/callback - survives deploys,
// works on Vercel) -> local .gmail-token.json. Same Google OAuth client as
// the gmail integration; scope includes drive.

import fs from "fs";
import path from "path";
import { google, type drive_v3 } from "googleapis";
import { prisma } from "@/lib/prisma";

export const LEADS_ROOT_NAME = "ProBuild Leads";

export class DriveNotConnectedError extends Error {
    constructor() {
        super("Google Drive is not connected - run /api/gmail/callback as an admin first");
    }
}

async function resolveRefreshToken(): Promise<string | null> {
    if (process.env.GMAIL_REFRESH_TOKEN) return process.env.GMAIL_REFRESH_TOKEN;
    const settings = await prisma.companySettings.findFirst({
        select: { googleDriveRefreshToken: true },
    });
    if (settings?.googleDriveRefreshToken) return settings.googleDriveRefreshToken;
    try {
        const p = path.join(process.cwd(), ".gmail-token.json");
        if (fs.existsSync(p)) {
            const tok = JSON.parse(fs.readFileSync(p, "utf-8"));
            if (tok.refresh_token) return tok.refresh_token;
        }
    } catch {
        // fall through
    }
    return null;
}

export async function isDriveConnected(): Promise<boolean> {
    return !!(await resolveRefreshToken());
}

async function driveClient(): Promise<drive_v3.Drive> {
    const refreshToken = await resolveRefreshToken();
    if (!refreshToken) throw new DriveNotConnectedError();
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: "v3", auth });
}

async function findFolder(drive: drive_v3.Drive, name: string, parentId?: string): Promise<string | null> {
    const q = [
        `name = '${name.replace(/'/g, "\\'")}'`,
        "mimeType = 'application/vnd.google-apps.folder'",
        "trashed = false",
        parentId ? `'${parentId}' in parents` : null,
    ].filter(Boolean).join(" and ");
    const res = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
    return res.data.files?.[0]?.id ?? null;
}

async function createFolder(drive: drive_v3.Drive, name: string, parentId?: string): Promise<string> {
    const res = await drive.files.create({
        requestBody: {
            name,
            mimeType: "application/vnd.google-apps.folder",
            parents: parentId ? [parentId] : undefined,
        },
        fields: "id",
    });
    if (!res.data.id) throw new Error("Drive folder create returned no id");
    return res.data.id;
}

export function folderUrl(folderId: string): string {
    return `https://drive.google.com/drive/folders/${folderId}`;
}

/** Find-or-create "ProBuild Leads/<Lead #N - Name>" and persist it on the lead. */
export async function ensureLeadFolder(leadId: string): Promise<{ folderId: string; url: string }> {
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { id: true, name: true, number: true, driveFolderId: true, driveFolderUrl: true },
    });
    if (!lead) throw new Error("Lead not found");
    if (lead.driveFolderId && lead.driveFolderUrl) {
        return { folderId: lead.driveFolderId, url: lead.driveFolderUrl };
    }

    const drive = await driveClient();
    const rootId = (await findFolder(drive, LEADS_ROOT_NAME)) ?? (await createFolder(drive, LEADS_ROOT_NAME));
    const safeName = `Lead #${lead.number} - ${lead.name}`.replace(/[\\/]/g, "-").slice(0, 100);
    const folderId = (await findFolder(drive, safeName, rootId)) ?? (await createFolder(drive, safeName, rootId));
    const url = folderUrl(folderId);

    await prisma.lead.update({
        where: { id: leadId },
        data: { driveFolderId: folderId, driveFolderUrl: url },
    });
    return { folderId, url };
}

/**
 * Start a resumable upload session in a folder. The phone then PUTs the bytes
 * straight to Google - no Vercel body-size limits for big videos.
 */
export async function createResumableSession(input: {
    folderId: string;
    name: string;
    mimeType: string;
    size?: number;
}): Promise<string> {
    const refreshToken = await resolveRefreshToken();
    if (!refreshToken) throw new DriveNotConnectedError();
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({ refresh_token: refreshToken });
    const { token } = await auth.getAccessToken();
    if (!token) throw new Error("Drive access token unavailable");

    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Upload-Content-Type": input.mimeType,
            ...(input.size ? { "X-Upload-Content-Length": String(input.size) } : {}),
        },
        body: JSON.stringify({ name: input.name.slice(0, 200), parents: [input.folderId] }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Drive resumable init failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const session = res.headers.get("location");
    if (!session) throw new Error("Drive resumable init returned no session URL");
    return session;
}

export interface DriveFileMeta {
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    webViewLink: string;
}

export async function getFileMeta(fileId: string): Promise<DriveFileMeta> {
    const drive = await driveClient();
    const res = await drive.files.get({
        fileId,
        fields: "id,name,mimeType,size,webViewLink",
    });
    const f = res.data;
    if (!f.id || !f.webViewLink) throw new Error("Drive file lookup incomplete");
    return {
        id: f.id,
        name: f.name ?? "file",
        mimeType: f.mimeType ?? "application/octet-stream",
        size: f.size ? Number(f.size) : undefined,
        webViewLink: f.webViewLink,
    };
}

export class DriveFileTooLargeError extends Error {
    constructor() {
        super("Google Drive file exceeds the configured download limit.");
    }
}

/**
 * Downloads Drive bytes with the server-side OAuth client; never returns a URL.
 * A caller-supplied ceiling aborts the stream before an oversized object is
 * buffered in a serverless worker.
 */
export async function downloadDriveFile(fileId: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    const drive = await driveClient();
    const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" },
    );
    const stream = res.data as unknown as AsyncIterable<Buffer | Uint8Array | string> & { destroy?: (error?: Error) => void };
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
        throw new Error("Drive download did not return a readable stream.");
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.length;
        if (options.maxBytes !== undefined && totalBytes > options.maxBytes) {
            const error = new DriveFileTooLargeError();
            stream.destroy?.(error);
            throw error;
        }
        chunks.push(bytes);
    }
    return Buffer.concat(chunks, totalBytes);
}

const MIRROR_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Best-effort copy of an already-uploaded Supabase file into the lead's Drive
 * folder (photos, USDZ scans). Never throws - logs and returns null instead,
 * so registration flows keep working when Drive is down or disconnected.
 */
export async function mirrorUrlToLeadFolder(input: {
    leadId: string;
    url: string;
    name: string;
    mimeType: string;
    size?: number;
}): Promise<{ id: string } | null> {
    try {
        if (input.size && input.size > MIRROR_MAX_BYTES) return null;
        if (!(await isDriveConnected())) return null;
        const { folderId } = await ensureLeadFolder(input.leadId);

        const fileRes = await fetch(input.url);
        if (!fileRes.ok) throw new Error(`source fetch ${fileRes.status}`);
        const buf = Buffer.from(await fileRes.arrayBuffer());
        if (buf.length > MIRROR_MAX_BYTES) return null;

        const drive = await driveClient();
        const { Readable } = await import("stream");
        const res = await drive.files.create({
            requestBody: { name: input.name.slice(0, 200), parents: [folderId] },
            media: { mimeType: input.mimeType, body: Readable.from(buf) },
            fields: "id",
        });
        return res.data.id ? { id: res.data.id } : null;
    } catch (e) {
        console.error("[lead-drive] mirror failed:", e instanceof Error ? e.message : e);
        return null;
    }
}
