/**
 * The document-sync rail: Estimate and Invoice creates through
 * POST /api/quickbooks/sync.
 *
 * Split out of the route because the SAME decision is now made in two places:
 * the route, when a caller arrives at a record that is already claimed, and the
 * maintenance sweep, which walks records nobody has come back to. A second copy
 * of "is this document actually in QuickBooks?" is a second place for the two to
 * disagree about whether a record may be re-created.
 */
import { createHash } from "node:crypto";

import {
    findQBEstimatesByDocNumber,
    findQBInvoicesByDocNumber,
    canonicalPrivateNote,
    QB_DOC_NUMBER_MAX_LEN,
    type QBTokens,
    type RouteDeadline,
} from "./quickbooks";
import { AMBIGUOUS_CREATE_MARKER, CREATE_IN_FLIGHT_MARKER } from "./qbo-create-markers";

const MARKER_NONCE_SEP = ":";

/** The two kinds a document-sync marker can carry. */
export const DOCUMENT_SYNC_MARKERS: readonly string[] = [CREATE_IN_FLIGHT_MARKER, AMBIGUOUS_CREATE_MARKER];

/** `create-in-flight:<nonce>` — the nonce is what makes the requestid stable. */
export function composeSyncMarker(kind: string, nonce: string): string {
    return `${kind}${MARKER_NONCE_SEP}${nonce}`;
}

export function syncMarkerKind(marker: string | null | undefined): string | null {
    if (!marker) return null;
    for (const kind of DOCUMENT_SYNC_MARKERS) {
        if (marker === kind || marker.startsWith(kind + MARKER_NONCE_SEP)) return kind;
    }
    return null;
}

export function syncMarkerNonce(marker: string): string {
    const at = marker.indexOf(MARKER_NONCE_SEP);
    return at === -1 ? "" : marker.slice(at + 1);
}

/**
 * Intuit's documented ceiling for `requestid`. Exceed it and the parameter is
 * not "mostly fine" — it is rejected or silently ignored, and a silently
 * ignored idempotency key is worse than none, because the caller believes it is
 * protected.
 */
export const QB_REQUEST_ID_MAX_LEN = 36;

/**
 * The QuickBooks idempotency key for one create attempt.
 *
 * HASHED, not concatenated. The obvious form — `${recordId}:${nonce}` — is a
 * CUID (25 chars) joined to a UUID (36) and runs to about 62, well past the
 * limit above; the tests hid it by using `est-1` as an id. A SHA-256 over the
 * same two values, truncated, is bounded by construction and still
 * deterministic: the SAME record and the SAME claim nonce always produce the
 * same key, which is the whole property a replay depends on, and two different
 * records can never collide into one.
 *
 * 32 hex characters (128 bits) of it: comfortably inside 36, and an accidental
 * collision between two attempts is not a thing that happens.
 */
export function syncRequestId(recordId: string, marker: string): string {
    const digest = createHash("sha256")
        .update(`${recordId}${MARKER_NONCE_SEP}${syncMarkerNonce(marker)}`)
        .digest("hex")
        .slice(0, 32);
    // Asserted rather than assumed: this is a constant-length digest today, and
    // the assertion is what stops a future "let us prefix it with the code"
    // from quietly disabling Intuit's dedupe.
    if (digest.length > QB_REQUEST_ID_MAX_LEN) {
        throw new Error(`QuickBooks requestid exceeds ${QB_REQUEST_ID_MAX_LEN} characters`);
    }
    return digest;
}

/** What a recovery probe concluded about a claimed record. */
export type DocumentSyncRecovery =
    /** QuickBooks holds exactly one document that is ours. Adopt it. */
    | { state: "found"; qbId: string }
    /**
     * QuickBooks authoritatively holds none. The claim is KEPT and the caller
     * may create — reusing this marker's nonce, so the create carries the same
     * requestid and Intuit dedupes if the document existed but had not indexed.
     */
    | { state: "absent" }
    /** Could not be established (outage, truncated result set, several matches). */
    | { state: "unknown"; reason: string };

export interface DocumentSyncProbeDeps {
    findEstimates?: typeof findQBEstimatesByDocNumber;
    findInvoices?: typeof findQBInvoicesByDocNumber;
}

/**
 * Ask QuickBooks whether the create this record was claimed for actually landed.
 *
 * Identity is the DocNumber, which on this rail is the record's OWN ProBuild
 * code (`EST-00001` / `INV-00001`) — one code, one record, unlike the milestone
 * rail where the DocNumber is derived from a position and needs a PrivateNote
 * beside it to be safe. The estimate's note is checked as well when the record
 * has one, because it costs nothing and a hand-created QuickBooks document that
 * happened to reuse the code should not be adopted.
 *
 * Everything that is not a confident single match is `unknown`, including TWO
 * matches: adopting one of a pair, or declaring absence because the answer was
 * confusing, are both worse than asking a human.
 */
export async function probeDocumentSync(
    tokens: QBTokens,
    input: { kind: "estimate" | "invoice"; code: string; privateNote?: string | null },
    deadline?: RouteDeadline,
    deps?: DocumentSyncProbeDeps,
): Promise<DocumentSyncRecovery> {
    const findEstimates = deps?.findEstimates ?? findQBEstimatesByDocNumber;
    const findInvoices = deps?.findInvoices ?? findQBInvoicesByDocNumber;
    // The create truncates its DocNumber to Intuit's cap, so the lookup has to
    // ask about the value QuickBooks actually stored, not the untruncated code.
    const docNumber = input.code.slice(0, QB_DOC_NUMBER_MAX_LEN);

    let matches: Array<{ id: string; privateNote: string | null }>;
    try {
        matches = input.kind === "estimate"
            ? await findEstimates(tokens, docNumber, deadline)
            : await findInvoices(tokens, docNumber, deadline);
    } catch (error) {
        // An outage, a timeout, or a truncated result set. NOT absence: the one
        // thing this must never do is conclude "there is none" from a question
        // QuickBooks did not answer, because that permits a duplicate create.
        return { state: "unknown", reason: error instanceof Error ? error.message : "QuickBooks lookup failed" };
    }

    const wanted = input.privateNote ? canonicalPrivateNote(input.privateNote) : null;
    const ours = wanted
        ? matches.filter((m) => (m.privateNote ? canonicalPrivateNote(m.privateNote) : null) === wanted)
        : matches;

    if (ours.length === 1) return { state: "found", qbId: ours[0].id };
    if (matches.length === 0) return { state: "absent" };
    if (ours.length === 0) {
        // Documents carry this code but none is ours. That is a human's call —
        // creating another one alongside them is exactly the duplicate this
        // whole mechanism exists to prevent.
        return {
            state: "unknown",
            reason: `${matches.length} QuickBooks document(s) already use ${docNumber}, and none carries this record's note`,
        };
    }
    return { state: "unknown", reason: `${ours.length} QuickBooks documents match ${docNumber}` };
}

/** One rail worth of parked document syncs. */
export interface DocumentSyncSweepResult {
    checked: number;
    /** Found in QuickBooks and adopted: the id is now recorded. */
    recovered: number;
    /** Still claimed afterwards, for any reason. Counted from the database. */
    stillParked: number;
    reason: string | null;
}

export interface DocumentSyncSweepDeps {
    /** Rows carrying a marker, oldest first. */
    listParked?: () => Promise<Array<{ id: string; code: string; privateNote: string | null; marker: string; kind: "estimate" | "invoice" }>>;
    /** Adopt one: CAS the id in and clear the marker. Returns rows written. */
    adopt?: (row: { id: string; kind: "estimate" | "invoice"; marker: string }, qbId: string) => Promise<number>;
    countParked?: () => Promise<number>;
    probe?: typeof probeDocumentSync;
    isExhausted?: (deadline?: RouteDeadline) => boolean;
}

/**
 * Finish the document syncs nobody came back to.
 *
 * A record claimed by a create whose outcome was never learned is invisible
 * until somebody happens to press Sync again. That is not a work queue, and it
 * is exactly the state a duplicate would be hiding in, so the maintenance pass
 * walks them: probe by DocNumber, adopt an authoritative single match, and
 * leave everything else alone.
 *
 * It NEVER creates. An absent document here means the next user-initiated sync
 * may go ahead (it reuses the same requestid), and deciding that unattended,
 * against a query index that can lag a create by seconds, is not this job.
 *
 * Whatever is still parked when it finishes is REPORTED, so it makes the
 * maintenance run ok:false rather than sitting quietly for another day.
 */
export async function sweepPendingDocumentSyncs(
    tokens: QBTokens,
    deadline?: RouteDeadline,
    deps?: DocumentSyncSweepDeps,
): Promise<DocumentSyncSweepResult> {
    const result: DocumentSyncSweepResult = { checked: 0, recovered: 0, stillParked: 0, reason: null };
    if (!deps?.listParked || !deps?.adopt || !deps?.countParked) {
        // The caller owns the Prisma shape (two different tables, two different
        // id columns), so it supplies the reads and the write. No default: a
        // silent no-op sweep is the failure mode this whole thing is about.
        throw new Error("sweepPendingDocumentSyncs requires listParked, adopt and countParked");
    }
    const probe = deps.probe ?? probeDocumentSync;
    const isExhausted = deps.isExhausted ?? (() => false);

    const rows = await deps.listParked();
    for (const row of rows) {
        // Checked before EVERY row: each is a QuickBooks query, and this sweep
        // runs after the other maintenance passes have already spent the route.
        if (isExhausted(deadline)) {
            result.reason = "budget-exhausted";
            break;
        }
        result.checked++;
        const found = await probe(
            tokens,
            { kind: row.kind, code: row.code, privateNote: row.privateNote },
            deadline,
        );
        if (found.state !== "found") {
            // `absent` is left for a real sync to act on; `unknown` is left for
            // the next run. Either way the claim stands, so nothing can create
            // a second document in the meantime.
            if (found.state === "unknown") result.reason = result.reason ?? found.reason;
            continue;
        }
        if (await deps.adopt(row, found.qbId) === 1) result.recovered++;
    }

    // Counted from the database AFTER the loop, so it includes rows this run
    // never reached as well as the ones it could not finish.
    result.stillParked = await deps.countParked().catch(() => rows.length - result.recovered);
    return result;
}
