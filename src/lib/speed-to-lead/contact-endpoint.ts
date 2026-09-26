import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

/** `ContactEndpoint.endpoint` holds this normalized form — lowercase, trimmed. Never plus/dot canonicalized: that would merge addresses Gmail itself treats as distinct destinations for delivery purposes. */
export function normalizeEndpoint(email: string): string {
    return email.trim().toLowerCase();
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
}

export async function markEndpointBounced(email: string, db: Db = prisma): Promise<void> {
    const endpoint = normalizeEndpoint(email);
    await db.contactEndpoint.upsert({
        where: { endpoint },
        create: { endpoint, bouncedAt: new Date(), suppressedAt: new Date(), reason: "bounce", source: "poll" },
        update: { bouncedAt: new Date(), suppressedAt: new Date(), reason: "bounce", source: "poll" },
    });
}

export async function markEndpointJunk(email: string, db: Db = prisma): Promise<void> {
    const endpoint = normalizeEndpoint(email);
    await db.contactEndpoint.upsert({
        where: { endpoint },
        create: { endpoint, junkAt: new Date(), suppressedAt: new Date(), reason: "junk", source: "justin" },
        update: { junkAt: new Date(), suppressedAt: new Date(), reason: "junk", source: "justin" },
    });
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
}
