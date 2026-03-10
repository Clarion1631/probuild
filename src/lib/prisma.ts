import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined
}

function buildPrismaClient(): PrismaClient {
    let dbUrl = process.env.DATABASE_URL;
    if (dbUrl && !dbUrl.includes("connection_limit")) {
        dbUrl += (dbUrl.includes("?") ? "&" : "?") + "connection_limit=1";
    }
    if (dbUrl) {
        return new PrismaClient({
            datasources: { db: { url: dbUrl } }
        });
    }
    return new PrismaClient();
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
