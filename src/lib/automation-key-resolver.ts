import { prisma } from "@/lib/prisma";
import type { AutomationEvent } from "@prisma/client";
import { resolveEventFileId } from "@/lib/automation-events";

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

/**
 * Full three-tier lookup used by both `/api/automation/ai-review` and
 * `/api/automation/verify`:
 *   A. exact driveFileId (typed column, then legacy `detail` JSON)
 *   B. exact qbPurchaseId (typed column, then legacy `detail` JSON)
 *   C. bare docNumber prefix — LEGACY FALLBACK, always unconfirmed, and
 *      refuses to guess when the prefix is genuinely ambiguous
 */
export async function resolveReceiptPushEvent(ids: ReceiptIdentifiers): Promise<ReceiptPushResolution> {
    if (ids.driveFileId) {
        const rows = await prisma.automationEvent.findMany({
            where: {
                kind: "receipt-push",
                status: { in: PUSH_EVENT_STATUSES },
                OR: [{ driveFileId: ids.driveFileId }, { detail: { contains: ids.driveFileId } }],
            },
            take: 20,
        });
        const event = pickPushEvent(rows);
        if (event) return { outcome: "resolved", event, fullFileId: ids.driveFileId, confirmed: true };
    }

    if (ids.qbPurchaseId) {
        const rows = await prisma.automationEvent.findMany({
            where: {
                kind: "receipt-push",
                status: { in: PUSH_EVENT_STATUSES },
                OR: [{ qbPurchaseId: ids.qbPurchaseId }, { detail: { contains: ids.qbPurchaseId } }],
            },
            take: 20,
        });
        const event = pickPushEvent(rows);
        if (event) return { outcome: "resolved", event, fullFileId: resolveEventFileId(event), confirmed: true };
    }

    const docNumber = ids.docNumber ?? (ids.driveFileId ? ids.driveFileId.slice(0, 21) : null);
    if (docNumber) {
        const rows = await prisma.automationEvent.findMany({
            where: { kind: "receipt-push", status: { in: PUSH_EVENT_STATUSES }, docNumber },
            take: 50,
        });
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
