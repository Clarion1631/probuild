import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logOutreachEvent } from "./audit";

type Db = PrismaClient | Prisma.TransactionClient;

/** `ContactEndpoint.endpoint` holds this normalized form — lowercase, trimmed. Never plus/dot canonicalized: that would merge addresses Gmail itself treats as distinct destinations for delivery purposes. */
export function normalizeEndpoint(email: string): string {
    return email.trim().toLowerCase();
}

/** Throws if `value` carries a CR, LF or NUL — the difference between a value that ends up INSIDE a header and one that injects a NEW header (Bcc, an extra Subject, ...) into the raw RFC822 message dispatch.ts builds. Applies to every value that becomes a header: `to`, `subject`, `inReplyTo`, `references`, the message id. */
export function assertNoHeaderInjection(value: string, field: string): void {
    if (/[\r\n\0]/.test(value)) throw new Error(`invalid ${field}: control characters are not allowed in a message header`);
}

/**
 * Exactly one RFC 5322 mailbox, with no control characters. A comma- or
 * semicolon-separated list of recipients would let every address AFTER the
 * first bypass suppression/allowlist checks entirely — those checks
 * normalize and look up exactly one `to` string, never a list.
 */
const SINGLE_MAILBOX_PATTERN = /^[^\s<>,;"()[\]:\\]+@[^\s<>,;"()[\]:\\]+\.[^\s<>,;"()[\]:\\]{2,}$/;
export function isValidSingleRecipient(to: string): boolean {
    if (/[\r\n\0]/.test(to)) return false;
    return SINGLE_MAILBOX_PATTERN.test(to.trim());
}

export interface EndpointStatus {
    endpoint: string;
    suppressed: boolean;
    junk: boolean;
    reason: string | null;
}

/** One row per endpoint, across all clients and leads (spec "Suppression"). */
export async function getEndpointStatus(email: string, db: Db = prisma): Promise<EndpointStatus> {
    const endpoint = normalizeEndpoint(email);
    const row = await db.contactEndpoint.findUnique({ where: { endpoint } });
    return {
        endpoint,
        suppressed: !!row?.suppressedAt,
        junk: !!row?.junkAt,
        reason: row?.reason ?? null,
    };
}

/** Suppress permanently. Idempotent — a second call for the same reason/source is a no-op observed as already-suppressed. */
export async function suppressEndpoint(
    email: string,
    opts: { reason: string; source: string },
    db: Db = prisma,
): Promise<void> {
    const endpoint = normalizeEndpoint(email);
    await db.contactEndpoint.upsert({
        where: { endpoint },
        create: { endpoint, suppressedAt: new Date(), reason: opts.reason, source: opts.source },
        update: { suppressedAt: new Date(), reason: opts.reason, source: opts.source },
    });
    await logOutreachEvent(db, { kind: "endpoint-suppressed", detail: { endpoint, reason: opts.reason, source: opts.source } });
}

export async function markEndpointBounced(email: string, db: Db = prisma): Promise<void> {
    const endpoint = normalizeEndpoint(email);
    await db.contactEndpoint.upsert({
        where: { endpoint },
        create: { endpoint, bouncedAt: new Date(), suppressedAt: new Date(), reason: "bounce", source: "poll" },
        update: { bouncedAt: new Date(), suppressedAt: new Date(), reason: "bounce", source: "poll" },
    });
    await logOutreachEvent(db, { kind: "endpoint-bounced", detail: { endpoint } });
}

export async function markEndpointJunk(email: string, db: Db = prisma): Promise<void> {
    const endpoint = normalizeEndpoint(email);
    await db.contactEndpoint.upsert({
        where: { endpoint },
        create: { endpoint, junkAt: new Date(), suppressedAt: new Date(), reason: "junk", source: "justin" },
        update: { junkAt: new Date(), suppressedAt: new Date(), reason: "junk", source: "justin" },
    });
    await logOutreachEvent(db, { kind: "endpoint-junk", detail: { endpoint } });
}

/** Justin-only, per spec's Approval "Who". Requires a reason; clears suppression AND junk together, since junk is what put the endpoint there. */
export async function clearEndpointSuppression(
    email: string,
    opts: { clearedBy: string; reason: string },
    db: Db = prisma,
): Promise<void> {
    const endpoint = normalizeEndpoint(email);
    await db.contactEndpoint.upsert({
        where: { endpoint },
        create: {
            endpoint, suppressedAt: null, junkAt: null,
            clearedBy: opts.clearedBy, clearedAt: new Date(), reason: opts.reason,
        },
        update: {
            suppressedAt: null, junkAt: null,
            clearedBy: opts.clearedBy, clearedAt: new Date(), reason: opts.reason,
        },
    });
    await logOutreachEvent(db, { kind: "endpoint-suppression-cleared", detail: { endpoint, clearedBy: opts.clearedBy, reason: opts.reason } });
}
