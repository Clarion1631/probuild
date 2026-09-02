/**
 * The one place a STAGING row's stored object is validated and turned into row
 * metadata.
 *
 * Two callers publish a STAGING row — /intake/{id}/finalize (the client says it
 * has finished uploading) and the worker's stale-STAGING sweep (nobody ever
 * came back, but the object is there). They MUST agree: a sweep that published
 * on "the object exists" alone would wave through a 40 MB video, a .exe, or a
 * truncated upload that /finalize would have rejected — and those rows then go
 * to Gemini and, if they read at all, to QuickBooks.
 *
 * Everything here is derived from the BYTES IN STORAGE. The client uploaded
 * straight to Supabase, so nothing it declared about the file is evidence.
 */
import { createHash } from "node:crypto";
import { downloadDocBytesResult, toSecureRef, type DocBytesResult } from "@/lib/secure-storage";
import { sniffMime } from "./file-type";
import { MAX_STORED_BYTES } from "./intake-core";

export type StoredObjectCheck =
    /** Valid: these are the values the row must be published with. */
    | { ok: true; mimeType: string; fileSize: number; fileSha256: string }
    /** The object is not there. Terminal for the sweep; retryable for a client. */
    | { ok: false; kind: "missing" }
    /** Storage could not answer. Never a verdict — come back later. */
    | { ok: false; kind: "transient"; message: string }
    /** The object exists and is NOT acceptable. The row and object must go. */
    | { ok: false; kind: "rejected"; reason: string };

export async function inspectStoredObject(
    storagePath: string,
    /**
     * What the row recorded at /start. Used ONLY for text/plain, which has no
     * magic bytes — the same concession the single-shot path makes. Every
     * format that CAN be identified is identified from the bytes.
     */
    declaredMime: string,
    download: (ref: string) => Promise<DocBytesResult> = downloadDocBytesResult,
): Promise<StoredObjectCheck> {
    const result = await download(toSecureRef(storagePath));
    if (!result.ok) {
        return result.kind === "not-found"
            ? { ok: false, kind: "missing" }
            : { ok: false, kind: "transient", message: result.message };
    }

    const bytes = result.bytes;
    if (bytes.length === 0) return { ok: false, kind: "rejected", reason: "empty-file" };
    // Enforced on the OBJECT, because the signed upload URL bypassed every
    // check this server could otherwise have made.
    if (bytes.length > MAX_STORED_BYTES) {
        return { ok: false, kind: "rejected", reason: `file-too-large:${bytes.length}` };
    }

    // Magic bytes, exactly like the single-shot path. A declared mime is a
    // claim; this is the answer.
    const mimeType = sniffMime(bytes, declaredMime);
    if (!mimeType) return { ok: false, kind: "rejected", reason: "unsupported-file-type" };

    return {
        ok: true,
        mimeType,
        fileSize: bytes.length,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
    };
}
