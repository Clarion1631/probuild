/**
 * Shared intake rules, so the single-shot POST and the two-step
 * start/finalize flow cannot drift apart on provenance, idempotency or limits.
 */
import { randomUUID } from "node:crypto";
import type { IntakeAuth } from "./intake-auth";

/**
 * The single-shot POST carries the file in the REQUEST BODY, and a serverless
 * request body is not a 15 MB pipe: Vercel caps it at 4.5 MB and the base64
 * JSON shape inflates the payload by a third on top of that. Anything larger
 * was failing at the platform edge with an opaque 413 that never reached this
 * code — so the endpoint now says so itself, and points at the two-step flow
 * that uploads straight to storage and has no body limit at all.
 */
export const MAX_INLINE_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * The JSON path's raw-bytes ceiling, LOWER than the multipart one on purpose.
 *
 * A JSON body carries the file base64-encoded, which inflates it by 4/3. At the
 * multipart limit of 4 MiB that is a ~5.4 MiB request — over the platform's
 * body cap, so it died at the edge with an opaque 413 this code never saw and
 * the caller learned nothing. 3 MiB raw encodes to ~4 MiB, which fits.
 *
 * Multipart sends the bytes as-is and keeps the full 4 MiB.
 */
export const MAX_INLINE_JSON_BYTES = 3 * 1024 * 1024;

/** The real ceiling for a stored receipt, enforced on the object itself. */
export const MAX_STORED_BYTES = 15 * 1024 * 1024;

/** Sources a shared-secret forwarder may declare. */
export const MACHINE_SOURCES = new Set(["drive", "email", "chat"]);
/** Minted server-side from the authenticated caller, never read off the body. */
export const USER_SOURCES = new Set(["mobile", "web"]);

/** Client-supplied idempotency tokens must be real UUIDs — never a free-text key. */
export const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SourceDecision =
    | { ok: true; source: string; sourceRef: string }
    | { ok: false; reason: string };

/**
 * Decide `source` and `sourceRef` from the AUTH KIND, not the body.
 *
 * A session or Bearer caller knows neither: letting one pass `source:"drive"`
 * plus a chosen `sourceRef` would let it claim another document's idempotency
 * key, and `drive` rows book under the Drive file id — which is what a QBO
 * DocNumber is derived from. A forwarder owns both, but only inside its own
 * namespace.
 */
export function decideSource(
    auth: Extract<IntakeAuth, { ok: true }>,
    body: { source?: string | null; sourceRef?: string | null; uploadId?: string | null },
): SourceDecision {
    if (auth.via === "secret") {
        const source = String(body.source ?? "");
        // The SECRET's own list, not a global one: a key is scoped to the
        // sources its program actually owns.
        if (!auth.allowedSources.has(source)) return { ok: false, reason: "invalid-source" };
        if (!MACHINE_SOURCES.has(source)) return { ok: false, reason: "invalid-source" };
        if (!body.sourceRef) return { ok: false, reason: "missing-sourceRef" };
        if (!body.sourceRef.startsWith(`${source}:`)) {
            return { ok: false, reason: "sourceRef-namespace-mismatch" };
        }
        return { ok: true, source, sourceRef: body.sourceRef };
    }

    const source = auth.userVia === "mobile-jwt" ? "mobile" : "web";
    if (body.source && body.source !== source) return { ok: false, reason: "invalid-source" };
    // A RAW sourceRef stays forbidden — provenance is not caller input.
    if (body.sourceRef) return { ok: false, reason: "sourceRef-not-allowed" };

    // `uploadId` is the client's own idempotency token, SCOPED TO THE USER
    // server-side: two people cannot collide on one uuid, and nobody can reach
    // another user's row by guessing one. Without it a phone that retries on a
    // flaky connection books the same receipt twice.
    if (body.uploadId) {
        if (!UUID_PATTERN.test(body.uploadId)) return { ok: false, reason: "invalid-uploadId" };
        return { ok: true, source, sourceRef: `${source}:${auth.user.id}:${body.uploadId.toLowerCase()}` };
    }
    return { ok: true, source, sourceRef: `${source}:${randomUUID()}` };
}
