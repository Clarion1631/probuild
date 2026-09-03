/**
 * The document-sync rail: Estimate and Invoice creates through
 * POST /api/quickbooks/sync.
 *
 * Split out of the route because the SAME decision is now made in two places:
 * the route, when a caller arrives at a record that is already claimed, and the
 * maintenance sweep, which walks records nobody has come back to. A second copy
 * of "is this document actually in QuickBooks?" is a second place for the two to
 * disagree about whether a record may be re-created.
 *
 * The marker vocabulary is the one the milestone rail already uses
 * (`qbo-create-markers.ts`) rather than a private format. That module already
 * carries every field a recovery has to prove ownership with — realm, customer,
 * DocNumber, PrivateNote, expected total, issuance hash — and the first cut of
 * this rail stored a bare nonce and re-derived everything else from CURRENT
 * local state, which is exactly how a recovery adopts the wrong document.
 */
import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { withTxRetry, lockMoneyParents } from "./tx-retry";

import { toNum } from "./prisma-helpers";
import { documentIssuanceHash } from "./qbo-issuance";
import {
    findQBEstimatesByDocNumber,
    findQBInvoicesByDocNumber,
    canonicalPrivateNote,
    QB_DOC_NUMBER_MAX_LEN,
    type QBTokens,
    type RouteDeadline,
} from "./quickbooks";
import {
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    composeCreateMarker,
    parseCreateMarker,
    type CreateIdentity,
} from "./qbo-create-markers";

/** The two kinds a document-sync marker can carry. */
export const DOCUMENT_SYNC_MARKERS: readonly string[] = [CREATE_IN_FLIGHT_MARKER, AMBIGUOUS_CREATE_MARKER];

/**
 * A Prisma `OR` that matches only markers this rail understands.
 *
 * The sweep used to select every non-null `qbSyncMarker` and filter the
 * recognised ones in memory. A page made entirely of legacy or corrupt values
 * then came back EMPTY after filtering, which the pager read as "this rail is
 * exhausted" — so every valid row behind it was never visited. Filtering in the
 * QUERY means a page is only empty when there is genuinely nothing left.
 */
export function documentSyncMarkerWhere(): Array<{ qbSyncMarker: string | { startsWith: string } }> {
    return DOCUMENT_SYNC_MARKERS.flatMap((kind) => [
        { qbSyncMarker: kind },
        { qbSyncMarker: { startsWith: `${kind}:` } },
    ]);
}

export function syncMarkerKind(marker: string | null | undefined): string | null {
    return parseCreateMarker(marker)?.kind ?? null;
}

/** The identity a document-sync claim recorded, or null if it carries none. */
export function syncMarkerIdentity(marker: string | null | undefined): CreateIdentity | null {
    return parseCreateMarker(marker)?.identity ?? null;
}

/**
 * The PrivateNote every document this rail creates carries.
 *
 * ONE definition, written by the create and recorded in the marker, so the
 * recovery can prove a QuickBooks document is OURS rather than merely sharing a
 * DocNumber. QuickBooks does not enforce DocNumber uniqueness, so a
 * hand-created estimate or an import can collide with ours by accident; the
 * estimate rail used to send the bare title, which any document could carry,
 * and the invoice rail sent no note at all.
 *
 * Same shape as the milestone and progress-billing notes so the three read
 * alike in QuickBooks: `ProBuild EST-00001 · Kitchen remodel`.
 */
export function documentPrivateNote(code: string, label: string | null): string {
    return canonicalPrivateNote(label ? `ProBuild ${code} · ${label}` : `ProBuild ${code}`);
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
 * HASHED, not concatenated. The obvious form — the record id joined to the
 * claim — runs well past the limit above (a CUID is 25 characters and the
 * marker is far longer), and the tests hid that by using `est-1` as an id. A
 * SHA-256 over the record and the WHOLE marker is bounded by construction and
 * still deterministic: the same record and the same claim always produce the
 * same key, which is the property a replay depends on, while a NEW claim
 * produces a new one.
 *
 * 32 hex characters (128 bits): comfortably inside 36, and an accidental
 * collision between two attempts is not a thing that happens.
 */
export function syncRequestId(recordId: string, marker: string): string {
    const digest = createHash("sha256").update(`${recordId}:${marker}`).digest("hex").slice(0, 32);
    // Asserted rather than assumed: this is a constant-length digest today, and
    // the assertion is what stops a future "let us prefix it with the code"
    // from quietly disabling Intuit's dedupe.
    if (digest.length > QB_REQUEST_ID_MAX_LEN) {
        throw new Error(`QuickBooks requestid exceeds ${QB_REQUEST_ID_MAX_LEN} characters`);
    }
    return digest;
}

/** Compose a document-sync claim. Thin wrapper so callers share one shape. */
export function composeSyncMarker(
    kind: typeof CREATE_IN_FLIGHT_MARKER | typeof AMBIGUOUS_CREATE_MARKER,
    identity: CreateIdentity,
    at?: Date,
): string {
    return composeCreateMarker(kind, identity, at);
}

/** What a recovery probe concluded about a claimed record. */
export type DocumentSyncRecovery =
    /** QuickBooks holds exactly one document that is PROVABLY ours. Adopt it. */
    | { state: "found"; qbId: string }
    /**
     * QuickBooks authoritatively holds no document with this DocNumber. The
     * claim is KEPT and the caller may create — reusing this marker, so the
     * create carries the same requestid and Intuit dedupes if the document
     * existed but had not indexed.
     */
    | { state: "absent" }
    /** Could not be established, or could not be proved ours. Stays parked. */
    | { state: "unknown"; reason: string };

export interface DocumentSyncProbeDeps {
    findEstimates?: typeof findQBEstimatesByDocNumber;
    findInvoices?: typeof findQBInvoicesByDocNumber;
}

/** Money equality at QuickBooks' cent precision. */
function sameMoney(a: number | null | undefined, b: number | null | undefined): boolean {
    if (a == null || b == null) return false;
    return Math.abs(a - b) <= 0.005;
}

/**
 * Ask QuickBooks whether the create this record was claimed for actually landed
 * — and whether what it found is OURS.
 *
 * Everything it compares comes from the MARKER, never from current local state.
 * That distinction is the whole point: the record may have been edited since the
 * create, and re-deriving the identity from how it looks now would ask about a
 * document we never sent.
 *
 * A document is adopted only when ALL of these agree with the claim:
 *   • the realm — the connection can legitimately point at another company now,
 *     and against the wrong books the lookup finds nothing, which would read as
 *     "no document exists" while ours sits collectible in the original company;
 *   • the QuickBooks customer it bills;
 *   • the DocNumber;
 *   • the canonical PrivateNote marker the create wrote — QuickBooks does not
 *     enforce DocNumber uniqueness, so this is what separates our document from
 *     a hand-created or imported one that happens to share a code;
 *   • the total the create expected to produce.
 *
 * Anything else is `unknown` and stays parked, including TWO matches and
 * "documents exist under this code but none is ours". Adopting one of a pair,
 * or declaring absence because the answer was confusing, are both worse than
 * asking a human.
 */
export async function probeDocumentSync(
    tokens: QBTokens,
    input: { kind: "estimate" | "invoice"; marker: string },
    deadline?: RouteDeadline,
    deps?: DocumentSyncProbeDeps,
): Promise<DocumentSyncRecovery> {
    const findEstimates = deps?.findEstimates ?? findQBEstimatesByDocNumber;
    const findInvoices = deps?.findInvoices ?? findQBInvoicesByDocNumber;

    const identity = syncMarkerIdentity(input.marker);
    if (!identity?.docNumber || !identity.privateNote) {
        return { state: "unknown", reason: "the claim does not record which QuickBooks document to look for" };
    }
    if (!identity.realmId || !identity.customerId) {
        // Never "probably fine". An unverifiable claim is refused, exactly as
        // the milestone resolver refuses a marker with no realm.
        return { state: "unknown", reason: "the claim does not record which QuickBooks company or customer it billed" };
    }
    if (identity.realmId !== tokens.realmId) {
        return {
            state: "unknown",
            reason: `the claim was made against QuickBooks company ${identity.realmId}, but ${tokens.realmId} is connected now`,
        };
    }

    // The create truncates its DocNumber to Intuit's cap, so the lookup has to
    // ask about the value QuickBooks actually stored.
    const docNumber = identity.docNumber.slice(0, QB_DOC_NUMBER_MAX_LEN);

    let matches: Array<{ id: string; privateNote: string | null; total: number; customerId: string | null }>;
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

    const ours = matches.filter((m) =>
        canonicalPrivateNote(m.privateNote) === identity.privateNote
        && m.customerId === identity.customerId
        && (identity.expectedTotal == null || sameMoney(m.total, identity.expectedTotal)));

    if (ours.length === 1) return { state: "found", qbId: ours[0].id };
    if (matches.length === 0) return { state: "absent" };
    if (ours.length === 0) {
        return {
            state: "unknown",
            reason:
                `${matches.length} QuickBooks document(s) already use ${docNumber}, and none matches this claim's ` +
                `customer, note and total — reconcile it by hand`,
        };
    }
    return { state: "unknown", reason: `${ours.length} QuickBooks documents match ${docNumber}` };
}

/** What one rail did this run. */
export interface DocumentSyncRailResult {
    checked: number;
    recovered: number;
    unrecognised: number;
    /** Rows this rail looked at and could not settle, with the first reason why. */
    unresolved: number;
    /** Only ever a SHARED failure (budget, outage). A per-row refusal is not one. */
    stopped: string | null;
    /** The first per-row refusal, for the operator. Does not stop anything. */
    note: string | null;
}

/** Both rails, plus the totals the maintenance response reports. */
export interface DocumentSyncSweepResult {
    checked: number;
    /** Found in QuickBooks and adopted: the id is now recorded. */
    recovered: number;
    /** Still claimed afterwards, for any reason. Counted from the database. */
    stillParked: number;
    /** Rows eligible at the start that this run never reached. */
    unvisited: number;
    /** Rows whose marker this rail does not recognise, stepped over and reported. */
    unrecognised: number;
    /**
     * A SHARED stop only: out of budget, or QuickBooks unreachable.
     *
     * A per-row refusal used to land here, and the outer loop breaks on it — so
     * one permanently-unresolvable estimate meant the invoice rail was never
     * examined at all, run after run. Row-level trouble is now recorded against
     * its own rail and the sweep carries on.
     */
    reason: string | null;
    rails: { estimate: DocumentSyncRailResult; invoice: DocumentSyncRailResult };
}

/** One record this sweep may act on. */
export interface ParkedDocumentRow {
    id: string;
    marker: string;
    kind: "estimate" | "invoice";
    /** The Client the adoption decision locks; empty means the row cannot be billed. */
    clientId: string;
}

export interface DocumentSyncSweepDeps {
    /**
     * One PAGE of parked rows per rail, after that rail's cursor, plus a bounded
     * wrap back to the head once the tail drains. The caller owns the Prisma
     * shape (two tables, two id columns); this owns the fairness.
     */
    listParked?: (rail: "estimate" | "invoice", after: string | null, take: number) => Promise<ParkedDocumentRow[]>;
    /** Adopt one: CAS the id in and clear the marker. Returns rows written. */
    adopt?: (row: ParkedDocumentRow, qbId: string) => Promise<number>;
    countParked?: () => Promise<number>;
    probe?: typeof probeDocumentSync;
    isExhausted?: (deadline?: RouteDeadline) => boolean;
    /** Where each rail resumes. Same KV the milestone sweeps use. */
    cursors?: {
        get(key: string): Promise<string | null>;
        set(key: string, value: string): Promise<void>;
    };
    /** Which rail goes first this run. Defaults to alternating by clock. */
    railFirst?: "estimate" | "invoice";
    /** Rows one rail may visit per RUN. Overridable so a test can make it 1. */
    pageSize?: number;
}

export const DOCUMENT_SYNC_CURSOR_KEYS = {
    estimate: "qbo-maintenance.document-sync.estimate.cursor",
    invoice: "qbo-maintenance.document-sync.invoice.cursor",
} as const;

/** How many rows one rail may look at per run. */
export const DOCUMENT_SYNC_PAGE_SIZE = 25;

/**
 * Finish the document syncs nobody came back to.
 *
 * A record claimed by a create whose outcome was never learned is invisible
 * until somebody happens to press Sync again. That is not a work queue, and it
 * is exactly the state a duplicate would be hiding in, so the maintenance pass
 * walks them: probe by the claim's own identity, adopt an authoritative match,
 * and leave everything else alone.
 *
 * It NEVER creates. An absent document here means the next user-initiated sync
 * may go ahead (it reuses the same requestid), and deciding that unattended,
 * against a query index that can lag a create by seconds, is not this job.
 *
 * FAIRNESS. The first cut took the first 25 rows of each rail every run. Rows
 * that cannot be resolved stay eligible forever, so a permanently-unresolvable
 * head row was re-probed every run and everything behind it was never reached —
 * head-of-line starvation, in a queue whose whole purpose is to find rows nobody
 * is looking at. Each rail now keeps a persisted keyset cursor, wraps ONCE back
 * to the head when its tail drains, and the rails alternate which goes first so
 * a run that runs out of budget does not always starve the same one. Identical
 * shape to `sweepPendingPayLinks`.
 *
 * Whatever is still parked when it finishes is REPORTED, so it makes the
 * maintenance run ok:false rather than sitting quietly for another day.
 */
export async function sweepPendingDocumentSyncs(
    tokens: QBTokens,
    deadline?: RouteDeadline,
    deps?: DocumentSyncSweepDeps,
): Promise<DocumentSyncSweepResult> {
    const railResult = (): DocumentSyncRailResult =>
        ({ checked: 0, recovered: 0, unrecognised: 0, unresolved: 0, stopped: null, note: null });
    const result: DocumentSyncSweepResult = {
        checked: 0, recovered: 0, stillParked: 0, unvisited: 0, unrecognised: 0, reason: null,
        rails: { estimate: railResult(), invoice: railResult() },
    };
    if (!deps?.listParked || !deps?.adopt || !deps?.countParked) {
        // The caller owns the reads and the write. No default: a silent no-op
        // sweep is the failure mode this whole thing is about.
        throw new Error("sweepPendingDocumentSyncs requires listParked, adopt and countParked");
    }
    const probe = deps.probe ?? probeDocumentSync;
    const isExhausted = deps.isExhausted ?? (() => false);
    const cursors = deps.cursors;
    const pageSize = deps.pageSize ?? DOCUMENT_SYNC_PAGE_SIZE;

    // Alternate by clock when the caller does not say. A fixed order means the
    // second rail is always the one that loses a short run.
    const first = deps.railFirst ?? (Date.now() % 2 === 0 ? "estimate" : "invoice");
    const rails: Array<"estimate" | "invoice"> = first === "estimate"
        ? ["estimate", "invoice"]
        : ["invoice", "estimate"];

    for (const rail of rails) {
        // ONLY a shared failure stops the other rail. A row this one could not
        // settle says nothing about the other collection.
        if (result.reason) break;
        const tally = result.rails[rail];
        const key = DOCUMENT_SYNC_CURSOR_KEYS[rail];
        const stored = (await cursors?.get(key).catch(() => null)) || null;
        // "" is how "start from the top" is stored; it is never a real id.
        let cursor: string | null = stored && stored.length > 0 ? stored : null;
        // Seeded with what this run INHERITED, never null: an abort before the
        // first row completes must leave the cursor where it was, or the next
        // run restarts from the top and the tail starves again.
        let checkpoint: string | null = cursor;
        let wrapped = false;
        let exhausted = false;
        let visited = 0;

        while (visited < pageSize) {
            if (isExhausted(deadline)) {
                result.reason = "budget-exhausted";
                tally.stopped = "budget-exhausted";
                break;
            }
            const page = await deps.listParked(rail, cursor, pageSize - visited);
            if (page.length === 0) {
                // Nothing at all, walking from the top: the rail is empty, so the
                // next run should start from the top too.
                if (cursor === null) {
                    exhausted = true;
                    break;
                }
                // Already wrapped: this run has seen the head portion as well.
                // Keep the checkpoint so the next run continues AFTER the last
                // row visited, rather than re-walking what was just done.
                if (wrapped) break;
                // Tail drained. Wrap ONCE back to the head so rows before the
                // cursor are not stranded until somebody resets it by hand —
                // and only once, or a run could walk the collection forever.
                wrapped = true;
                cursor = null;
                continue;
            }
            for (const row of page) {
                if (isExhausted(deadline)) {
                    result.reason = "budget-exhausted";
                    tally.stopped = "budget-exhausted";
                    break;
                }
                visited++;
                // A marker this rail cannot read is STEPPED OVER, not stopped on:
                // the cursor advances past it exactly as it does for a resolved
                // row, so it can never wedge the queue. It is counted so an
                // operator can see the rail is carrying values nobody handles.
                if (!syncMarkerKind(row.marker)) {
                    result.unrecognised++;
                    tally.unrecognised++;
                    checkpoint = row.id;
                    cursor = row.id;
                    continue;
                }
                result.checked++;
                tally.checked++;
                const found = await probe(tokens, { kind: row.kind, marker: row.marker }, deadline);
                // The cursor advances PAST every row this run looked at,
                // resolved or not. That is the whole fix: a row that can never
                // be resolved must not be re-probed ahead of everything else on
                // the next run.
                checkpoint = row.id;
                cursor = row.id;
                if (found.state !== "found") {
                    // `absent` is left for a real sync to act on; `unknown` is
                    // left for the next run. Either way the claim stands, so
                    // nothing can create a second document meanwhile.
                    //
                    // Recorded against THIS rail and nothing else. It used to set
                    // the run-wide `reason`, which the outer loop breaks on, so a
                    // single unresolvable estimate stopped the invoice rail from
                    // being looked at at all.
                    if (found.state === "unknown") {
                        tally.unresolved++;
                        tally.note = tally.note ?? found.reason;
                    }
                    continue;
                }
                if (await deps.adopt(row, found.qbId) === 1) {
                    result.recovered++;
                    tally.recovered++;
                } else {
                    // The adopt refused (an identity mismatch, or the row moved).
                    // Outstanding work, and it is this rail that carries it.
                    tally.unresolved++;
                    tally.note = tally.note ?? "a parked record no longer matches the document it claimed";
                }
            }
            if (result.reason === "budget-exhausted") break;
        }

        // Never throws — a lost cursor costs one restart from the top, never
        // correctness.
        await cursors?.set(key, exhausted ? "" : (checkpoint ?? "")).catch(() => {});
    }

    // Counted from the database AFTER the loop, so it includes rows this run
    // never reached as well as the ones it could not finish.
    result.stillParked = await deps.countParked().catch(() => result.checked - result.recovered);
    result.unvisited = Math.max(0, result.stillParked - (result.checked - result.recovered));
    return result;
}

// ─── The ONE identity decision ──────────────────────────────────────────────

/**
 * Everything a document-sync decision is allowed to decide from.
 *
 * Rounds 39, 40 and 41 all found the same shape of bug: a decision — adopt,
 * replay, finalize — comparing a SUBSET of columns and missing whichever one the
 * next reviewer thought of. So there is now exactly one description of "what
 * this record would send to QuickBooks right now", one function that computes it
 * under the money locks, and one comparison against what the marker recorded.
 * Every decision routes through them; none of them re-derives a subset.
 */
export interface DocumentIdentityFacts {
    /** Fingerprint of the whole payload: lines, totals, tax, text, customer. */
    hash: string;
    docNumber: string;
    privateNote: string;
    total: number;
    customerId: string;
    /** Estimates only: the canonical optimistic-concurrency token for items. */
    itemsRevision: number | null;
    /**
     * Everything the outbound QuickBooks payload is built from, read in the
     * SAME locked query that produced the hash above.
     *
     * The claim used to reload state under the locks while the POST still used
     * the copy read before the token refresh and the customer resolve. An edit
     * committed in that window made the marker fingerprint the NEW state while
     * QuickBooks received the OLD lines and totals — and finalize, comparing
     * the new state to a marker that also described it, happily recorded the
     * link. Fingerprint and payload now come from one read, so they cannot
     * describe different things.
     */
    payload: DocumentPayload;
}

/** The document to send, as the locked read saw it. */
export type DocumentPayload =
    | {
        kind: "estimate";
        id: string;
        code: string;
        title: string;
        totalAmount: number;
        projectName: string | null;
        items: Array<{
            id: string;
            parentId: string | null;
            name: string;
            quantity: number;
            unitCost: number;
            total: number;
            /** Non-null in the schema (defaults to "Material"); buildQBEstimateLines
             *  needs it for legacy section detection, so it is not optional here. */
            type: string;
        }>;
    }
    | {
        kind: "invoice";
        code: string;
        totalAmount: number;
        balanceDue: number;
        projectName: string | null;
    };

/** Why an identity comparison refused. Reported verbatim to the operator. */
export type IdentityMismatch =
    | { ok: true }
    | { ok: false; reason: string };

/**
 * Does the record, AS IT STANDS NOW, still describe what the claim recorded?
 *
 * Fail-closed in every uncertain direction. A marker with no issuance hash is a
 * legacy shape from before this rail recorded one: it cannot be verified, so it
 * is refused rather than adopted on the fields that happen to be present.
 */
export function identityMatchesMarker(facts: DocumentIdentityFacts, marker: string): IdentityMismatch {
    const identity = syncMarkerIdentity(marker);
    if (!identity) return { ok: false, reason: "its claim could not be read" };
    if (!identity.issuanceHash) {
        return {
            ok: false,
            reason:
                "its claim was recorded by an older release that did not fingerprint the payload, so it cannot be " +
                "verified — check QuickBooks and reconcile it by hand",
        };
    }
    if (identity.issuanceHash !== facts.hash) {
        return { ok: false, reason: "it was edited after that QuickBooks document was requested" };
    }
    if (identity.customerId !== facts.customerId) {
        return { ok: false, reason: "its QuickBooks customer changed after that document was requested" };
    }
    if (identity.docNumber !== facts.docNumber) {
        return { ok: false, reason: "its code changed after that document was requested" };
    }
    if (identity.privateNote !== facts.privateNote) {
        return { ok: false, reason: "its description changed after that document was requested" };
    }
    if (identity.expectedTotal != null && !sameMoney(identity.expectedTotal, facts.total)) {
        return { ok: false, reason: "its total changed after that document was requested" };
    }
    return { ok: true };
}

/**
 * Load what this record would send RIGHT NOW, from inside a transaction that
 * already holds the money locks.
 *
 * The customer is read from `Client` under the lock rather than taken from a
 * caller argument: `resolveCustomerAndItem` re-points that column, and a
 * decision made against a value read before that write is exactly the class of
 * bug this exists to close.
 *
 * Returns null when the record is gone, or has no client/project association
 * left to bill — both of which must refuse rather than fall back to a default.
 */
export async function loadDocumentIdentity(
    tx: {
        estimate: { findUnique(args: any): Promise<any> };
        invoice: { findUnique(args: any): Promise<any> };
    },
    kind: "estimate" | "invoice",
    id: string,
): Promise<DocumentIdentityFacts | null> {
    if (kind === "estimate") {
        const row = await tx.estimate.findUnique({
            where: { id },
            select: {
                id: true, code: true, title: true, totalAmount: true, itemsRevision: true,
                items: {
                    // parentId/type feed buildQBEstimateLines section detection;
                    // the hash reads only the money fields, so adding them here
                    // does not move it.
                    orderBy: [{ order: "asc" }, { id: "asc" }],
                    select: {
                        id: true, parentId: true, name: true, quantity: true,
                        unitCost: true, total: true, type: true,
                    },
                },
                // The ASSOCIATION as well as the name: a reparent changes which
                // client is billed, which no column on the estimate itself records.
                project: { select: { id: true, name: true, client: { select: { id: true, qbCustomerId: true } } } },
            },
        });
        if (!row?.project?.client?.qbCustomerId) return null;
        const note = documentPrivateNote(row.code, row.title);
        return {
            hash: documentIssuanceHash({
                kind: "estimate",
                code: row.code,
                itemsRevision: row.itemsRevision,
                total: row.totalAmount,
                taxAmount: null,
                title: row.title,
                projectName: row.project.name,
                customerId: row.project.client.qbCustomerId,
                lines: row.items,
            }),
            docNumber: row.code.slice(0, QB_DOC_NUMBER_MAX_LEN),
            privateNote: note,
            total: toNum(row.totalAmount),
            customerId: row.project.client.qbCustomerId,
            itemsRevision: row.itemsRevision,
            payload: {
                kind: "estimate",
                id: row.id,
                code: row.code,
                title: row.title,
                totalAmount: toNum(row.totalAmount),
                projectName: row.project.name,
                items: row.items.map((i: any) => ({
                    id: i.id,
                    parentId: i.parentId ?? null,
                    name: i.name,
                    quantity: i.quantity,
                    unitCost: toNum(i.unitCost),
                    total: toNum(i.total),
                    type: i.type,
                })),
            },
        };
    }
    const row = await tx.invoice.findUnique({
        where: { id },
        select: {
            id: true, code: true, totalAmount: true, balanceDue: true, taxAmount: true,
            project: { select: { id: true, name: true } },
            client: { select: { id: true, qbCustomerId: true } },
        },
    });
    if (!row?.client?.qbCustomerId) return null;
    const note = documentPrivateNote(row.code, row.project?.name ?? null);
    return {
        hash: documentIssuanceHash({
            kind: "invoice",
            code: row.code,
            itemsRevision: null,
            total: row.totalAmount,
            taxAmount: row.taxAmount,
            title: null,
            projectName: row.project?.name ?? null,
            customerId: row.client.qbCustomerId,
            lines: [],
        }),
        docNumber: row.code.slice(0, QB_DOC_NUMBER_MAX_LEN),
        privateNote: note,
        total: toNum(row.totalAmount),
        customerId: row.client.qbCustomerId,
        itemsRevision: null,
        payload: {
            kind: "invoice",
            code: row.code,
            totalAmount: toNum(row.totalAmount),
            balanceDue: toNum(row.balanceDue),
            projectName: row.project?.name ?? null,
        },
    };
}

/**
 * THE decision primitive. Every adopt, replay, finalize and fresh claim on
 * this rail goes through it, and none of them re-derives its own subset of
 * columns.
 *
 * Rounds 39, 40 and 41 each found the same bug in a different place: a
 * decision comparing SOME of the state and missing whichever field the next
 * reviewer thought of — the customer, then the line items, then the project
 * association and the code. So this takes the canonical money locks
 * (Estimate → Invoice → Client), recomputes the WHOLE payload identity from the
 * database inside them (`loadDocumentIdentity`), optionally compares it to what
 * the marker recorded (`identityMatchesMarker`), and only then runs the write.
 *
 * The Client lock is FOR SHARE: this reads the mapping, but must not straddle
 * the FOR UPDATE remap in `resolveCustomerAndItem`, which may have run moments
 * ago on this very request.
 */
export async function decideUnderIdentity<T>(args: {
    kind: "estimate" | "invoice";
    id: string;
    clientId: string;
    /** When set, the current identity must still equal what this claim recorded. */
    expectMarker?: string;
    /**
     * When set, the customer read under the lock must be this one.
     *
     * A fresh claim passes what `resolveCustomerAndItem` just answered. If the
     * locked read disagrees, the mapping moved between that call and this
     * decision — and the payload is built from the resolved value, so proceeding
     * would send an invoice to one customer while recording another. Fail
     * closed; the retry resolves against the mapping that now stands.
     */
    expectCustomerId?: string;
    decide: (tx: Prisma.TransactionClient, facts: DocumentIdentityFacts) => Promise<T>;
}): Promise<{ ok: true; value: T; facts: DocumentIdentityFacts } | { ok: false; reason: string }> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(
            tx,
            {
                estimateId: args.kind === "estimate" ? args.id : null,
                invoiceId: args.kind === "invoice" ? args.id : null,
                clientId: args.clientId,
            },
            { clientLock: "share" },
        );
        const facts = await loadDocumentIdentity(tx, args.kind, args.id);
        if (!facts) {
            return { ok: false as const, reason: "it no longer has a client and project to bill" };
        }
        if (args.expectCustomerId && facts.customerId !== args.expectCustomerId) {
            return { ok: false as const, reason: "its QuickBooks customer changed while this was being prepared" };
        }
        if (args.expectMarker) {
            const verdict = identityMatchesMarker(facts, args.expectMarker);
            if (!verdict.ok) return { ok: false as const, reason: verdict.reason };
        }
        return { ok: true as const, value: await args.decide(tx, facts), facts };
    }));
}
