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

/**
 * QuickBooks refuses an attachment over 8 MiB, and a receipt that cannot be
 * attached is worse than one that was never accepted: the Purchase is created,
 * the file is not on it, and the books look complete. THIS is therefore the
 * ceiling for the whole pipeline, not just for the booking step.
 *
 * It used to be 15 MiB at the door and 8 MiB at the books, and everything in
 * between was accepted, stored, read by the model, and then parked
 * `unsupported-attachment:size` — after a human had already been told we had
 * it. One number, enforced at every layer that can enforce anything:
 *
 *   * the bucket's own file_size_limit (the only place a signed-URL write can
 *     be refused at all — see bucket.ts / apply-receipt-intake.mjs),
 *   * /start, on the size the client declares,
 *   * inspectStoredObject, on the object's metadata and then on its bytes,
 *   * attachmentBlocker, as the last preflight before the Purchase.
 */
export const QBO_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/** The real ceiling for a stored receipt, enforced on the object itself. */
export const MAX_STORED_BYTES = QBO_ATTACHMENT_MAX_BYTES;

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
        // SHAPE, not just namespace. `drive:` with an empty tail used to be a
        // valid permanent idempotency key that every later empty-tail forward
        // collided with — and for Drive the tail is also the QuickBooks
        // DocNumber seed.
        const shape = validateSourceRef(source, body.sourceRef);
        if (!shape.ok) return { ok: false, reason: shape.reason };
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

/**
 * The longest sourceRef we will store. Long enough for any real Chat resource
 * name, short enough that it cannot be used as a payload: it lands in a UNIQUE
 * index, in QuickBooks-facing identity (Drive rows book under this id) and in
 * every log line about the row.
 */
export const MAX_SOURCE_REF_BYTES = 512;

/**
 * Per-source shape for the part AFTER `<source>:`.
 *
 * The namespace prefix alone was the only check, so `drive:` with nothing after
 * it was a valid, unique, permanent idempotency key — and every subsequent
 * empty-tail forward collided with it and was answered "already received",
 * silently dropping real receipts. Worse for Drive specifically: the tail IS
 * the QuickBooks DocNumber seed, so a junk tail becomes a junk DocNumber and
 * two junk tails sharing a 21-character prefix collide in the books.
 *
 * The shapes are the ones the Apps Script forwarder actually sends (see the
 * `sourceRef` doc on the Prisma model), NOT a superset invented here — a
 * validator that accepts more than production sends is a validator that would
 * have accepted the bug it exists to stop:
 *   drive — `drive:<fileId>`: the Drive file id, which is also the QuickBooks
 *           DocNumber seed for these rows.
 *   email — `email:<gmailMsgId>:<sha16>`: one message can carry several
 *           receipts, so the message id alone is not an identity; the 16-hex
 *           content hash distinguishes them.
 *   chat  — `chat:<messageResourceName>:<idx>`: a Chat message resource name
 *           (`spaces/<space>/messages/<message>`) plus the attachment index.
 */
export const SOURCE_REF_PATTERNS: Record<string, RegExp> = {
    drive: /^[A-Za-z0-9_-]{10,128}$/,
    email: /^[A-Za-z0-9_.+=~-]{1,256}:[0-9a-f]{16}$/,
    chat: /^spaces\/[A-Za-z0-9_-]{1,128}\/messages\/[A-Za-z0-9_.=-]{1,256}:\d{1,4}$/,
};

export type SourceRefCheck = { ok: true } | { ok: false; reason: string };

/** Shared by the single-shot POST and /start — one shape rule, checked once. */
export function validateSourceRef(source: string, sourceRef: string): SourceRefCheck {
    if (Buffer.byteLength(sourceRef, "utf8") > MAX_SOURCE_REF_BYTES) {
        return { ok: false, reason: "sourceRef-too-long" };
    }
    const prefix = `${source}:`;
    if (!sourceRef.startsWith(prefix)) return { ok: false, reason: "sourceRef-namespace-mismatch" };
    const tail = sourceRef.slice(prefix.length);
    if (!tail) return { ok: false, reason: "invalid-sourceRef" };
    // No control characters or whitespace anywhere, whatever the source: this
    // value is echoed into logs and compared for equality.
    if (/[\u0000-\u001f\u007f\s]/.test(sourceRef)) return { ok: false, reason: "invalid-sourceRef" };
    const pattern = SOURCE_REF_PATTERNS[source];
    // An unknown source never reaches here (decideSource checks the list first),
    // and if one ever did, "no pattern" must not mean "anything goes".
    if (!pattern) return { ok: false, reason: "invalid-source" };
    return pattern.test(tail) ? { ok: true } : { ok: false, reason: "invalid-sourceRef" };
}
