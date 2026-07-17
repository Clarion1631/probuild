import { randomUUID } from "crypto";
import { getSupabase, STORAGE_BUCKET } from "./supabase";

// Accepts the data-URLs that SignaturePad / DocumentSignModal produce (canvas.toDataURL).
const SIGNATURE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

// Decoded-image ceiling. Drawn signatures are tens of KB even at high DPI; this is a
// generous abuse guard, not a real-world limit.
const MAX_SIGNATURE_BYTES = 6 * 1024 * 1024; // 6 MB

// Cap on the storage upload so a hung/degraded Storage backend can't hang the signing
// request indefinitely. Drawn signatures are tiny — this only bounds pathological hangs.
const UPLOAD_TIMEOUT_MS = 10_000;

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
 * Persist a drawn-signature image and return a value that is safe to store in the DB.
 *
 * Behaviour:
 *  - null / empty             → null (nothing to store)
 *  - an http(s) URL           → returned unchanged ONLY if it is one of OUR Storage URLs
 *                               (idempotent re-runs / backfill output); any other http(s)
 *                               value is rejected as "Invalid signature format" so an
 *                               untrusted caller cannot store an arbitrary URL (SSRF/audit)
 *  - a PNG/JPEG/WEBP data-URL  → uploaded to Supabase Storage; the public URL is returned
 *  - anything else            → throws "Invalid signature format"
 *
 * Storage-not-configured behaviour: getSupabase() is null only when SUPABASE_URL /
 * SUPABASE_SERVICE_KEY are absent. On the Supabase transaction pooler (the prod/preview
 * signal `pgbouncer=true` in DATABASE_URL) that is a misconfiguration — we FAIL LOUDLY
 * rather than silently store a large data-URL and reintroduce the pooler message-size
 * error. Off the pooler (plain Postgres in e2e/CI/local, no such limit) we keep the
 * data-URL so signing still works without Storage.
 *
 * @param value     captured signature (data-URL) or an existing URL
 * @param keyPrefix storage sub-path, e.g. `contracts/<id>/contractor`
 */
export async function persistSignature(
    value: string | null | undefined,
    keyPrefix: string,
): Promise<string | null> {
    if (!value) return null;

    // Already migrated / remote — only OUR storage URLs may pass through unchanged.
    if (/^https?:\/\//i.test(value)) {
        if (isOwnSignatureStorageUrl(value)) return value;
        throw new Error("Invalid signature format");
    }

    const match = value.match(SIGNATURE_DATA_URL_RE);
    if (!match) throw new Error("Invalid signature format");

    const mime = match[1]; // png | jpeg | webp
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length === 0) throw new Error("Invalid signature format");
    if (buffer.length > MAX_SIGNATURE_BYTES) throw new Error("Signature image too large");

    const supabase = getSupabase();
    if (!supabase) {
        const onPooler = (process.env.DATABASE_URL || "").includes("pgbouncer=true");
        if (onPooler) {
            // Pooler configured but Storage isn't — storing the data-URL here is exactly
            // what triggers the message-size failure. Refuse rather than regress.
            throw new Error("Signature storage is not configured");
        }
        // Plain Postgres (no pooler size limit) — keep prior behaviour, store the data-URL.
        return value;
    }

    const ext = mime === "jpeg" ? "jpg" : mime;
    const safePrefix = keyPrefix.replace(/[^a-zA-Z0-9/_-]/g, "_");
    const storagePath = `signatures/${safePrefix}/${Date.now()}_${randomUUID()}.${ext}`;

    const uploadPromise = supabase.storage.from(STORAGE_BUCKET).upload(storagePath, buffer, {
        contentType: `image/${mime}`,
        upsert: false,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let res: Awaited<typeof uploadPromise>;
    try {
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Signature upload timed out")), UPLOAD_TIMEOUT_MS);
        });
        res = await Promise.race([uploadPromise, timeout]);
    } catch {
        throw new Error("Couldn't save your signature — please try again.");
    } finally {
        if (timer) clearTimeout(timer);
    }

    if (res.error) throw new Error("Couldn't save your signature — please try again.");

    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    if (!data?.publicUrl) {
        // Don't persist a bare object path — it's neither renderable nor re-migratable.
        throw new Error("Couldn't save your signature — please try again.");
    }
    return data.publicUrl;
}
