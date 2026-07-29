import { randomUUID } from "crypto";
import { getSupabase, STORAGE_BUCKET } from "./supabase";
import { SECURE_BUCKET, isSecureRef, toSecureRef } from "./secure-storage";

// Accepts the data-URLs that SignaturePad / DocumentSignModal produce (canvas.toDataURL).
const SIGNATURE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

// Decoded-image ceiling. Drawn signatures are tens of KB even at high DPI; this is a
// generous abuse guard, not a real-world limit.
const MAX_SIGNATURE_BYTES = 6 * 1024 * 1024; // 6 MB

// Caller-visible upload deadline. Cleanup still waits for upload settlement so a late
// success can be removed instead of leaving an orphaned signature object.
const UPLOAD_TIMEOUT_MS = 10_000;

export type SignatureStorageBucket = {
    upload(
        path: string,
        body: Buffer,
        options: { contentType: string; upsert: false },
    ): Promise<{ error: unknown | null }>;
    remove(paths: string[]): Promise<{ error: unknown | null }>;
};

export type SignaturePersistenceDependencies = {
    getBucket: () => SignatureStorageBucket | null;
    now: () => number;
    randomId: () => string;
    uploadTimeoutMs: number;
};

export type OwnedSignature = {
    url: string | null;
    discard: () => Promise<void>;
};

const noDiscard = async () => {};

function defaultSignatureBucket(): SignatureStorageBucket | null {
    const supabase = getSupabase();
    return supabase
        ? supabase.storage.from(SECURE_BUCKET) as unknown as SignatureStorageBucket
        : null;
}

function cleanupErrorType(error: unknown): string {
    if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)) {
        return error.name;
    }
    return typeof error;
}

/**
 * SSRF guard. True only for a public/sign object URL in OUR Supabase project + bucket,
 * under the `signatures/` prefix. Mirrors isAllowedCapturedPdfUrl() in actions.ts. Used
 * to (a) reject untrusted http(s) values at the write boundary and (b) gate the
 * server-side fetch in pdf.ts so a DB-stored URL can never point the server at an
 * arbitrary host (e.g. cloud metadata).
 */
export function isOwnSignatureStorageUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return false;
        if (!parsed.hostname.endsWith(".supabase.co") && !parsed.hostname.endsWith(".supabase.in")) return false;
        const path = parsed.pathname;
        if (!path.startsWith("/storage/v1/object/public/") && !path.startsWith("/storage/v1/object/sign/")) return false;
        // Our bucket + the signatures directory specifically.
        if (!path.includes(`/${STORAGE_BUCKET}/signatures/`)) return false;
        // Must belong to our own Supabase project (when SUPABASE_URL is known).
        const supabaseUrl = process.env.SUPABASE_URL || "";
        if (supabaseUrl) {
            const ourRef = new URL(supabaseUrl).hostname.split(".")[0];
            if (ourRef && !parsed.hostname.startsWith(ourRef)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Persist a drawn-signature image and return an owned Storage object that can be
 * compensated if a subsequent database transaction fails.
 *
 * Storage-not-configured behaviour preserves the compatibility wrapper's prior
 * behaviour: fail on the Supabase pooler, otherwise return the data URL unchanged.
 *
 * @param value     captured signature (data-URL) or an existing URL
 * @param keyPrefix storage sub-path, e.g. `contracts/<id>/contractor`
 */
export async function persistOwnedSignature(
    value: string | null | undefined,
    keyPrefix: string,
    dependencies: Partial<SignaturePersistenceDependencies> = {},
): Promise<OwnedSignature> {
    if (!value) return { url: null, discard: noDiscard };

    // Already migrated to the private bucket — pass through unchanged.
    if (isSecureRef(value)) {
        return { url: value, discard: noDiscard };
    }

    // Already migrated / remote — only OUR storage URLs may pass through unchanged.
    if (/^https?:\/\//i.test(value)) {
        if (isOwnSignatureStorageUrl(value)) {
            return { url: value, discard: noDiscard };
        }
        throw new Error("Invalid signature format");
    }

    const match = value.match(SIGNATURE_DATA_URL_RE);
    if (!match) throw new Error("Invalid signature format");

    const mime = match[1]; // png | jpeg | webp
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length === 0) throw new Error("Invalid signature format");
    if (buffer.length > MAX_SIGNATURE_BYTES) throw new Error("Signature image too large");

    const getBucket = dependencies.getBucket ?? defaultSignatureBucket;
    const bucket = getBucket();
    if (!bucket) {
        const onPooler = (process.env.DATABASE_URL || "").includes("pgbouncer=true");
        if (onPooler) {
            // Pooler configured but Storage isn't — storing the data-URL here is exactly
            // what triggers the message-size failure. Refuse rather than regress.
            throw new Error("Signature storage is not configured");
        }
        // Plain Postgres (no pooler size limit) — keep prior behaviour, store the data-URL.
        return { url: value, discard: noDiscard };
    }

    const now = dependencies.now ?? Date.now;
    const randomId = dependencies.randomId ?? randomUUID;
    const ext = mime === "jpeg" ? "jpg" : mime;
    const safePrefix = keyPrefix.replace(/[^a-zA-Z0-9/_-]/g, "_");
    const storagePath = `signatures/${safePrefix}/${now()}_${randomId()}.${ext}`;

    const uploadPromise = bucket.upload(storagePath, buffer, {
        contentType: `image/${mime}`,
        upsert: false,
    });
    const uploadTimeoutMs = dependencies.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineWon = false;
    let uploadResult: Awaited<typeof uploadPromise>;
    try {
        const timeout = new Promise<"deadline">((resolve) => {
            timer = setTimeout(() => resolve("deadline"), uploadTimeoutMs);
        });
        const first = await Promise.race([uploadPromise, timeout]);
        if (first === "deadline") {
            deadlineWon = true;
            // Supabase upload has no proven cancellation signal. Observe settlement so
            // a late success can be removed before this attempt returns an error.
            uploadResult = await uploadPromise;
        } else {
            uploadResult = first;
        }
    } catch {
        throw new Error("Couldn't save your signature — please try again.");
    } finally {
        if (timer) clearTimeout(timer);
    }

    if (uploadResult.error) {
        throw new Error("Couldn't save your signature — please try again.");
    }

    let discardPromise: Promise<void> | undefined;
    const discard = () => {
        discardPromise ??= (async () => {
            const removal = await bucket.remove([storagePath]);
            if (removal.error) throw removal.error;
        })();
        return discardPromise;
    };

    if (deadlineWon) {
        try {
            await discard();
        } catch (error) {
            console.error("[signature-storage] cleanup failed", {
                operation: "discard-late-signature-upload",
                errorType: cleanupErrorType(error),
            });
        }
        throw new Error("Couldn't save your signature — please try again.");
    }

    // The address is derived locally from the storage path, so there's no "upload
    // succeeded but we couldn't construct an address" failure mode to guard against here.
    return { url: toSecureRef(storagePath), discard };
}
