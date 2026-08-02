// Google Chat → DailyLog ingest.
//
// The crew's end-of-day posts live in per-project Chat "Team" spaces. A Chat app
// only receives push events when @mentioned, so this module PULLS: it lists a
// mapped space's recent messages with the app's own service-account credential
// (chat.bot scope — works for spaces the app has been added to) and upserts each
// human post as a DailyLog row (source "chat"), photos included.
//
// Idempotency is the message resource name (DailyLog.chatMessageName @unique):
// re-ingesting an overlapping window updates text in place instead of
// duplicating, so there is no fragile watermark to advance — a fixed lookback
// window plus upsert is self-healing.
import { prisma } from "./prisma";
import { getSupabase, STORAGE_BUCKET } from "./supabase";
import { toCompanyDayKey } from "./company-day";

const CHAT_API = "https://chat.googleapis.com/v1";
// chat.bot covers media download; spaces.messages.list under app auth needs
// chat.app.messages.readonly (granted once by a Workspace admin). Request both.
const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot https://www.googleapis.com/auth/chat.app.messages.readonly";
/** How far back each ingest looks. Overlap is safe (upsert), gaps are not. */
export const CHAT_INGEST_LOOKBACK_HOURS = 48;
const MAX_PHOTOS_PER_MESSAGE = 10;

export type ChatIngestResult = {
    spaceName: string;
    created: number;
    updated: number;
    photosSaved: number;
    skipped: number;
    errors: string[];
};

type ChatAttachment = {
    contentName?: string;
    contentType?: string;
    attachmentDataRef?: { resourceName?: string };
};

type ChatMessage = {
    name: string;
    text?: string;
    createTime: string;
    sender?: { name?: string; type?: string };
    attachment?: ChatAttachment[];
};

type ServiceAccountKey = {
    client_email: string;
    private_key: string;
    token_uri?: string;
};

export function isChatIngestConfigured(): boolean {
    return !!process.env.GOOGLE_CHAT_SA_KEY;
}

function readServiceAccountKey(): ServiceAccountKey {
    const raw = process.env.GOOGLE_CHAT_SA_KEY;
    if (!raw) throw new Error("GOOGLE_CHAT_SA_KEY not configured");
    let parsed: ServiceAccountKey;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("GOOGLE_CHAT_SA_KEY is not valid JSON");
    }
    if (!parsed.client_email || !parsed.private_key) {
        throw new Error("GOOGLE_CHAT_SA_KEY is missing client_email/private_key");
    }
    return parsed;
}

// Access-token cache: the SA token is good for an hour; one per lambda instance
// is plenty for a nightly run over a handful of spaces.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getChatAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
    const key = readServiceAccountKey();
    const { SignJWT, importPKCS8 } = await import("jose");
    const tokenUri = key.token_uri || "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const privateKey = await importPKCS8(key.private_key, "RS256");
    const assertion = await new SignJWT({ scope: CHAT_SCOPE })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(key.client_email)
        .setAudience(tokenUri)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(privateKey);
    const response = await fetch(tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }),
        // One hung Google request must not eat a whole cron run's budget.
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        throw new Error(`Chat SA token exchange failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("Chat SA token exchange returned no access_token");
    cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return cachedToken.token;
}

async function listRecentSpaceMessages(spaceName: string, sinceIso: string): Promise<ChatMessage[]> {
    const token = await getChatAccessToken();
    const messages: ChatMessage[] = [];
    let pageToken: string | undefined;
    do {
        const params = new URLSearchParams({
            pageSize: "100",
            filter: `createTime > "${sinceIso}"`,
            // Newest first, so if the cap ever bites it starves the OLDEST
            // messages (already had their chance on earlier runs), never the
            // newest.
            orderBy: "createTime DESC",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const response = await fetch(`${CHAT_API}/${spaceName}/messages?${params}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`messages.list failed for ${spaceName}: ${response.status} ${await response.text()}`);
        }
        const page = await response.json() as { messages?: ChatMessage[]; nextPageToken?: string };
        messages.push(...(page.messages ?? []));
        pageToken = page.nextPageToken;
    } while (pageToken && messages.length < 500);
    // Process chronologically regardless of fetch order.
    return messages.reverse();
}

async function downloadAttachment(resourceName: string): Promise<Buffer | null> {
    const token = await getChatAccessToken();
    const response = await fetch(`${CHAT_API}/media/${resourceName}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
}

/**
 * Resolve the User a chat-sourced daily log is attributed to. Chat's
 * messages.list payload carries only an opaque sender id (no email), so
 * per-person attribution isn't possible here — logs land under the oldest
 * ADMIN as a system attribution, and `source: "chat"` carries the provenance.
 */
async function resolveIngestUserId(): Promise<string> {
    const admin = await prisma.user.findFirst({
        where: { role: "ADMIN", status: "ACTIVATED" },
        // User has no createdAt; email asc keeps the attribution deterministic.
        orderBy: { email: "asc" },
        select: { id: true },
    });
    if (!admin) throw new Error("No ACTIVATED ADMIN user to attribute chat daily logs to");
    return admin.id;
}

function isIngestableMessage(message: ChatMessage): boolean {
    if (message.sender?.type && message.sender.type !== "HUMAN") return false;
    const text = message.text?.trim() ?? "";
    // 🤖-prefixed posts are our own routines' briefs — ingesting them would feed
    // the AI its own output.
    if (text.startsWith("🤖")) return false;
    const hasPhotos = (message.attachment ?? []).some(a => a.contentType?.startsWith("image/"));
    return text.length > 0 || hasPhotos;
}

/**
 * Pull a mapped space's recent human posts into DailyLog rows.
 * Photos are only fetched on first sight of a message (create), never on
 * update, so re-runs can't duplicate DailyLogPhoto rows.
 */
export async function ingestChatSpaceToDailyLogs(
    project: { id: string; googleChatSpaceId: string },
    // skipPhotos: the interactive "@mention sync" path must answer within
    // Google Chat's response deadline; photo downloads are the slow part and
    // the nightly run backfills them (partial-photo logs retry below).
    // deadlineAt: epoch ms after which no NEW slow work starts — what's
    // missed resumes on the next run (everything here is upsert/resumable).
    options: { dryRun?: boolean; lookbackHours?: number; skipPhotos?: boolean; deadlineAt?: number } = {},
): Promise<ChatIngestResult> {
    const result: ChatIngestResult = {
        spaceName: project.googleChatSpaceId,
        created: 0, updated: 0, photosSaved: 0, skipped: 0, errors: [],
    };
    const lookbackHours = options.lookbackHours ?? CHAT_INGEST_LOOKBACK_HOURS;
    const sinceIso = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
    const messages = await listRecentSpaceMessages(project.googleChatSpaceId, sinceIso);

    let ingestUserId: string | null = null;
    for (const message of messages) {
        if (options.deadlineAt && Date.now() > options.deadlineAt) {
            result.errors.push("time budget reached; remaining messages resume next run");
            break;
        }
        if (!isIngestableMessage(message)) {
            result.skipped += 1;
            continue;
        }
        const text = message.text?.trim() || "(photo update)";
        const imageAttachments = (message.attachment ?? [])
            .filter(a => a.contentType?.startsWith("image/") && a.attachmentDataRef?.resourceName)
            .slice(0, MAX_PHOTOS_PER_MESSAGE);

        if (options.dryRun) {
            const exists = await prisma.dailyLog.findUnique({
                where: { chatMessageName: message.name }, select: { id: true },
            });
            if (exists) result.updated += 1; else result.created += 1;
            continue;
        }

        try {
            ingestUserId ??= await resolveIngestUserId();
            // Match the manual-entry convention: DailyLog.date is UTC midnight of
            // the COMPANY-local day (a 7pm PDT post belongs to that PDT day, not
            // the next UTC day).
            const dayKey = toCompanyDayKey(message.createTime);
            const logDate = new Date(`${dayKey}T00:00:00.000Z`);
            const existing = await prisma.dailyLog.findUnique({
                where: { chatMessageName: message.name },
                select: { id: true, workPerformed: true, _count: { select: { photos: true } } },
            });
            if (existing) {
                if (existing.workPerformed !== text) {
                    await prisma.dailyLog.update({
                        where: { id: existing.id },
                        data: { workPerformed: text },
                    });
                    result.updated += 1;
                }
                // Photo retry: a crash or failed upload must not lose
                // attachments forever. Missing photos only — saveMessagePhotos
                // skips per-attachment URLs that already landed, so a fully
                // saved log costs one cheap query and no downloads.
                if (!options.skipPhotos && existing._count.photos < imageAttachments.length) {
                    result.photosSaved += await saveMessagePhotos(existing.id, project.id, message.name, imageAttachments, result.errors, options.deadlineAt);
                }
                continue;
            }
            let created: { id: string };
            try {
                created = await prisma.dailyLog.create({
                    data: {
                        projectId: project.id,
                        createdById: ingestUserId,
                        date: logDate,
                        workPerformed: text,
                        source: "chat",
                        chatMessageName: message.name,
                    },
                    select: { id: true },
                });
            } catch (err) {
                // A concurrent run won the unique-constraint race — that's a
                // dedupe, not an error; the winner owns the photos.
                if ((err as { code?: string })?.code === "P2002") {
                    result.skipped += 1;
                    continue;
                }
                throw err;
            }
            result.created += 1;
            if (!options.skipPhotos) {
                result.photosSaved += await saveMessagePhotos(created.id, project.id, message.name, imageAttachments, result.errors, options.deadlineAt);
            }
        } catch (err) {
            result.errors.push(`${message.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return result;
}

async function saveMessagePhotos(
    dailyLogId: string,
    projectId: string,
    messageName: string,
    attachments: ChatAttachment[],
    errors: string[],
    deadlineAt?: number,
): Promise<number> {
    if (attachments.length === 0) return 0;
    const supabase = getSupabase();
    if (!supabase) {
        errors.push(`${messageName}: storage not configured; photos skipped`);
        return 0;
    }
    // The (dailyLogId, url) pair is the photo's identity, and the URL is
    // deterministic per (message, index) — so a retry after a PARTIAL save
    // skips what landed and fetches only what's missing, and two overlapping
    // runs collapse on the unique constraint instead of double-inserting.
    const existingUrls = new Set(
        (await prisma.dailyLogPhoto.findMany({
            where: { dailyLogId }, select: { url: true },
        })).map(photo => photo.url),
    );
    let saved = 0;
    const messageKey = messageName.split("/").pop() ?? "msg";
    for (const [index, attachment] of attachments.entries()) {
        if (deadlineAt && Date.now() > deadlineAt) {
            errors.push(`${messageName}: photo ${index}+ deferred (time budget); next run resumes`);
            break;
        }
        try {
            const safeName = (attachment.contentName ?? `photo-${index}.jpg`).replace(/[^a-zA-Z0-9._-]/g, "_");
            const storagePath = `daily-logs/${projectId}/${messageKey}_${index}_${safeName}`;
            const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
            const url = urlData?.publicUrl || storagePath;
            if (existingUrls.has(url)) continue;

            const bytes = await downloadAttachment(attachment.attachmentDataRef!.resourceName!);
            if (!bytes) {
                errors.push(`${messageName}: attachment ${index} download failed`);
                continue;
            }
            const { error: uploadError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .upload(storagePath, bytes, {
                    contentType: attachment.contentType ?? "image/jpeg",
                    upsert: true,
                });
            if (uploadError) {
                errors.push(`${messageName}: upload failed: ${uploadError.message}`);
                continue;
            }
            try {
                await prisma.dailyLogPhoto.create({
                    data: { dailyLogId, url, caption: attachment.contentName ?? null },
                });
                saved += 1;
            } catch (err) {
                // Concurrent run inserted the same photo first — dedupe, not error.
                if ((err as { code?: string })?.code !== "P2002") throw err;
            }
        } catch (err) {
            errors.push(`${messageName}: photo ${index}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return saved;
}
