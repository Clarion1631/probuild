import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logLeadEvent } from "./audit";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * v1a's `ContactEndpoint` is junk-only (docs/plans/SPEED-TO-LEAD-V1A.md
 * "(1) #557 files"): there is no outbound send, so there is nothing to
 * suppress, no bounce to record, and no recipient/footer header-injection
 * validators to keep — those all guarded content this branch never builds.
 * What is kept is the one thing tracking.ts's Justin-only Junk action needs:
 * marking an endpoint junk, and reading whether it already is.
 */

/** `endpoint` is `"email:<addr>"` or `"phone:<e164>"` (schema §5) — normalized lowercase/trimmed, never plus/dot canonicalized. */
export function normalizeEndpoint(kind: "email" | "phone", value: string): string {
    return `${kind}:${value.trim().toLowerCase()}`;
}

export interface EndpointStatus {
    endpoint: string;
    junk: boolean;
}

/** One row per endpoint (spec: "junk only; v2 may add columns"). */
export async function getEndpointStatus(kind: "email" | "phone", value: string, db: Db = prisma): Promise<EndpointStatus> {
    const endpoint = normalizeEndpoint(kind, value);
    const row = await db.contactEndpoint.findUnique({ where: { endpoint } });
    return { endpoint, junk: !!row?.junkAt && !row.clearedAt };
}

/** Justin-only (tracking.ts's markLeadJunk). Idempotent. */
export async function markEndpointJunk(kind: "email" | "phone", value: string, justinEmail: string, db: Db = prisma): Promise<void> {
    const endpoint = normalizeEndpoint(kind, value);
    await db.contactEndpoint.upsert({
        where: { endpoint },
        create: { endpoint, junkAt: new Date(), junkBy: justinEmail, clearedAt: null, clearedBy: null },
        update: { junkAt: new Date(), junkBy: justinEmail, clearedAt: null, clearedBy: null },
    });
    await logLeadEvent(db, { kind: "endpoint-junk", detail: { endpoint } });
}
