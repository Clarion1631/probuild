import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined
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

// Lazy singleton: only create PrismaClient when it's actually used at runtime,
// not when the module is evaluated during Vercel's static page collection.
function getPrismaClient(): PrismaClient {
    if (!globalForPrisma.prisma) {
        globalForPrisma.prisma = buildPrismaClient();
    }
    return globalForPrisma.prisma;
}

export const prisma = new Proxy({} as PrismaClient, {
    get(_target, prop) {
        return (getPrismaClient() as any)[prop];
    }
});
