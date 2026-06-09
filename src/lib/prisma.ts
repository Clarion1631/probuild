import { PrismaClient } from '@prisma/client';
import { softDeleteExtension } from './prisma-soft-delete-extension';

const globalForPrisma = globalThis as unknown as {
    prismaBase: PrismaClient | undefined
    prismaExtended: PrismaClient | undefined
}

function buildPrismaClient(): PrismaClient {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        throw new Error("DATABASE_URL is not set. Configure it in Vercel project settings.");
    }
    let url: URL;
    try {
        url = new URL(dbUrl);
    } catch {
        throw new Error("DATABASE_URL is not a valid URL. Check the value in Vercel project settings.");
    }
    if (url.searchParams.get("pgbouncer") !== "true") {
        throw new Error(
            `DATABASE_URL must include the query param pgbouncer=true ` +
            `(required for Supabase transaction pooler on port 6543). ` +
            `Host detected: ${url.hostname}:${url.port || "(none)"}. ` +
            `To fix: update DATABASE_URL in Vercel project settings.`
        );
    }
    if (!url.searchParams.has("connection_limit")) {
        url.searchParams.set("connection_limit", "5");
    }
    return new PrismaClient({
        datasources: { db: { url: url.toString() } }
    });
}

// Lazy singletons: only create the PrismaClient when it's actually used at runtime,
// not when the module is evaluated during Vercel's static page collection.
function getBaseClient(): PrismaClient {
    if (!globalForPrisma.prismaBase) {
        globalForPrisma.prismaBase = buildPrismaClient();
    }
    return globalForPrisma.prismaBase;
}

function getExtendedClient(): PrismaClient {
    if (!globalForPrisma.prismaExtended) {
        // $extends shares the underlying engine/connection with the base client.
        globalForPrisma.prismaExtended = getBaseClient().$extends(
            softDeleteExtension
        ) as unknown as PrismaClient;
    }
    return globalForPrisma.prismaExtended;
}

/**
 * Default client — auto-hides soft-deleted rows (deletedAt != null) on the covered
 * models via the soft-delete extension. Use this everywhere for normal reads/writes.
 */
export const prisma = new Proxy({} as PrismaClient, {
    get(_target, prop) {
        return (getExtendedClient() as any)[prop];
    }
});

/**
 * ESCAPE HATCH — the un-extended client. Reads here are NOT filtered, so it can see
 * soft-deleted rows. Use ONLY for the soft-delete/restore actions and the admin
 * Trash/Audit UI (see src/lib/soft-delete.ts). Do not use for normal app reads.
 */
export const prismaBase = new Proxy({} as PrismaClient, {
    get(_target, prop) {
        return (getBaseClient() as any)[prop];
    }
});
