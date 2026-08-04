import { prisma } from "@/lib/prisma";
import type { AutomationEvent } from "@prisma/client";
import { resolveEventFileId, resolveEventQbPurchaseId } from "@/lib/automation-events";

/**
 * Shared resolution for API routes that need to find the ONE receipt-push
 * AutomationEvent a client is asking about — the same defect
 * `receiptJourneys()` (automation-events.ts) was already fixed for:
 * `docNumber` is `fileId.slice(0,21)` (qbo-receipt-push.ts:477-481), and two
 * different Drive fileIds CAN share that 21-char prefix, so matching on the
 * bare docNumber alone can silently select the WRONG receipt.
 *
 * Callers should prefer sending the full `driveFileId` and/or `qbPurchaseId`
 * (typed columns, near-zero collision risk) and only fall back to
 * `docNumber` for legacy callers/rows that don't have one. Any result
 * reached via that fallback is `confirmed: false` and must never be
 * presented to a user as a sure match.
 */

/** Minimal shape of a receipt-push row needed to pick and disambiguate among
 * candidates sharing a docNumber prefix. */
export interface PushEventCandidate {
    driveFileId: string | null;
    detail: string | null;
    status: string;
    createdAt: Date;
}

/**
 * Pick ONE event among push-event rows that already refer to the same
 * receipt (an exact driveFileId/qbPurchaseId match, or a docNumber-prefix
 * group already confirmed non-ambiguous): prefer the original "created"
 * event (earliest — booking-time evidence), else the latest
 * "already-exists" retry. Mirrors the two-query lookup both routes used
 * before this fix (created asc, then already-exists desc), operating on an
 * in-memory candidate list instead of two DB round-trips.
 */
export function pickPushEvent<T extends { status: string; createdAt: Date }>(candidates: T[]): T | null {
    const created = candidates.filter((c) => c.status === "created");
    if (created.length > 0) {
        return created.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    }
    const alreadyExists = candidates.filter((c) => c.status === "already-exists");
    if (alreadyExists.length > 0) {
        return alreadyExists.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
    }
    return null;
}

export type PrefixResolution<T> =
    | { outcome: "none" }
    | { outcome: "ambiguous"; candidateCount: number; distinctFileIds: string[] }
    | { outcome: "resolved"; event: T; fullFileId: string | null };

/**
 * Resolve ONE push event from candidates that all share the same bare
 * 21-char docNumber prefix. Never silently picks a candidate when the set
 * contains more than one DISTINCT resolvable full fileId — that would be
 * exactly the collision this whole fix exists to close.
 *
 * LEGACY FALLBACK ONLY — every "resolved" result here must be treated by
 * the caller as unconfirmed. Only call this when a direct driveFileId/
 * qbPurchaseId lookup found nothing (or wasn't available).
 */
export function resolvePushEventByDocNumberPrefix<T extends PushEventCandidate>(
    candidates: T[],
): PrefixResolution<T> {
    if (candidates.length === 0) return { outcome: "none" };

    const distinctFileIds = new Set<string>();
    for (const c of candidates) {
        const id = resolveEventFileId(c);
        if (id) distinctFileIds.add(id);
    }
    if (distinctFileIds.size > 1) {
        return { outcome: "ambiguous", candidateCount: candidates.length, distinctFileIds: [...distinctFileIds] };
    }

    const event = pickPushEvent(candidates);
    if (!event) return { outcome: "none" };
    return { outcome: "resolved", event, fullFileId: resolveEventFileId(event) };
}

/** Trim + length-sanity a client-supplied identifier string. Returns null for
 * anything not a usable string (missing, blank, or absurdly long). */
export function readIdentifier(value: unknown, maxLen: number): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= maxLen ? trimmed : null;
}

export interface ReceiptIdentifiers {
    docNumber: string | null;
    driveFileId: string | null;
    qbPurchaseId: string | null;
}

export type ReceiptPushResolution =
    | { outcome: "not-found" }
    | { outcome: "ambiguous"; candidateCount: number }
    | { outcome: "resolved"; event: AutomationEvent; fullFileId: string | null; confirmed: boolean };

const PUSH_EVENT_STATUSES = ["created", "already-exists"];

/** Above this many rows sharing a bare docNumber prefix, refuse to guess
 * rather than risk sampling only one side of a real collision — see
 * `ReceiptPushEventStore.countByDocNumber` below. */
const MAX_DOC_NUMBER_CANDIDATES = 50;

/**
 * DB access this resolver needs, factored out so `resolveReceiptPushEvent`
 * can be unit-tested against a fake store instead of a live database —
 * `resolveReceiptPushEvent(ids, fakeStore)` exercises the exact same
 * tier/equality/ambiguity logic that runs in production against Prisma.
 */
export interface ReceiptPushEventStore {
    /** Rows whose typed `driveFileId` equals the id, OR whose `detail` JSON
     * merely CONTAINS the id as a substring (legacy rows) — the caller MUST
     * re-filter these to an exact `resolveEventFileId(row) === id` match
     * before trusting one; `contains` alone can hit an unrelated row whose
     * detail happens to embed this id as a substring of a longer one. */
    findByDriveFileId(driveFileId: string): Promise<AutomationEvent[]>;
    /** Same contains-prefilter contract as `findByDriveFileId`, for
     * `qbPurchaseId` — re-filter to `resolveEventQbPurchaseId(row) === id`. */
    findByQbPurchaseId(qbPurchaseId: string): Promise<AutomationEvent[]>;
    /** Total rows sharing this bare docNumber prefix — queried BEFORE
     * fetching them so a set larger than we're willing to scan can fail
     * closed as ambiguous instead of silently sampling an arbitrary subset
     * (which could sample only one side of a real collision and never
     * detect it). */
    countByDocNumber(docNumber: string): Promise<number>;
    /** All rows sharing this bare docNumber prefix, deterministically
     * ordered. Only called when `countByDocNumber` is within the cap, so
     * this always returns the COMPLETE set — never a partial sample. */
    findByDocNumber(docNumber: string): Promise<AutomationEvent[]>;
}

const prismaStore: ReceiptPushEventStore = {
    findByDriveFileId: (driveFileId) =>
        prisma.automationEvent.findMany({
            where: {
                kind: "receipt-push",
                status: { in: PUSH_EVENT_STATUSES },
                OR: [{ driveFileId }, { detail: { contains: driveFileId } }],
            },
            take: 20,
        }),
    findByQbPurchaseId: (qbPurchaseId) =>
        prisma.automationEvent.findMany({
            where: {
                kind: "receipt-push",
                status: { in: PUSH_EVENT_STATUSES },
                OR: [{ qbPurchaseId }, { detail: { contains: qbPurchaseId } }],
            },
            take: 20,
        }),
    countByDocNumber: (docNumber) =>
        prisma.automationEvent.count({
            where: { kind: "receipt-push", status: { in: PUSH_EVENT_STATUSES }, docNumber },
        }),
    findByDocNumber: (docNumber) =>
        prisma.automationEvent.findMany({
            where: { kind: "receipt-push", status: { in: PUSH_EVENT_STATUSES }, docNumber },
            orderBy: { createdAt: "asc" },
        }),
};

/**
 * Full three-tier lookup used by both `/api/automation/ai-review` and
 * `/api/automation/verify`:
 *   A. exact driveFileId (typed column, then legacy `detail` JSON)
 *   B. exact qbPurchaseId (typed column, then legacy `detail` JSON)
 *   C. bare docNumber prefix — LEGACY FALLBACK, always unconfirmed, and
 *      refuses to guess when the prefix is genuinely ambiguous
 *
 * `store` defaults to the real Prisma-backed lookups; tests pass a fake to
 * exercise this logic without a database.
 */
export async function resolveReceiptPushEvent(
    ids: ReceiptIdentifiers,
    store: ReceiptPushEventStore = prismaStore,
): Promise<ReceiptPushResolution> {
    if (ids.driveFileId) {
        const rows = await store.findByDriveFileId(ids.driveFileId);
        // The `contains` prefilter above is a DB-narrowing step only — a
        // short or overlapping id can match a DIFFERENT receipt's detail
        // blob as a substring. Only an exact, PARSED equality match may be
        // trusted as confirmed.
        const exact = rows.filter((row) => resolveEventFileId(row) === ids.driveFileId);
        const event = pickPushEvent(exact);
        if (event) return { outcome: "resolved", event, fullFileId: ids.driveFileId, confirmed: true };
    }

    if (ids.qbPurchaseId) {
        const rows = await store.findByQbPurchaseId(ids.qbPurchaseId);
        const exact = rows.filter((row) => resolveEventQbPurchaseId(row) === ids.qbPurchaseId);
        const event = pickPushEvent(exact);
        if (event) return { outcome: "resolved", event, fullFileId: resolveEventFileId(event), confirmed: true };
    }

    const docNumber = ids.docNumber ?? (ids.driveFileId ? ids.driveFileId.slice(0, 21) : null);
    if (docNumber) {
        // Count first: if more rows share this prefix than we're willing to
        // scan, we cannot prove there ISN'T a second distinct fileId among
        // the ones we didn't fetch — fail closed as ambiguous rather than
        // risk missing a real collision by sampling an arbitrary subset.
        const candidateCount = await store.countByDocNumber(docNumber);
        if (candidateCount > MAX_DOC_NUMBER_CANDIDATES) {
            return { outcome: "ambiguous", candidateCount };
        }
        const rows = await store.findByDocNumber(docNumber);
        const resolution = resolvePushEventByDocNumberPrefix(rows);
        if (resolution.outcome === "ambiguous") {
            return { outcome: "ambiguous", candidateCount: resolution.candidateCount };
        }
        if (resolution.outcome === "resolved") {
            return { outcome: "resolved", event: resolution.event, fullFileId: resolution.fullFileId, confirmed: false };
        }
    }

    return { outcome: "not-found" };
}

/**
 * The qbPurchaseId to trust once a push event has been resolved — always
 * derived from the RESOLVED event's own data, never from a second,
 * independently client-supplied identifier that might name a different
 * receipt.
 *
 * A client can send a `driveFileId` that resolves event A and a conflicting
 * `qbPurchaseId` that belongs to a different event B. Using B's id for a
 * post-resolution QBO/Expense lookup would compare A's evidence against B's
 * live record while telling the user it's confirmed (ai-review.ts's Expense
 * lookup and verify/route.ts's live QBO query both do this lookup — see
 * their call sites). This function is the single choke point both go
 * through so neither can be swayed by client input the resolution didn't
 * actually verify.
 */
export function trustedQbPurchaseId(event: { qbPurchaseId: string | null; detail: string | null }): string | null {
    return resolveEventQbPurchaseId(event);
}
