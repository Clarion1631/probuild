import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined
}

function createPrismaClient() {
    let dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        // During build/static-generation DATABASE_URL may not be set.
        // Return a dummy client that will never actually be used at build time.
        return new PrismaClient();
    }
    if (!dbUrl.includes("connection_limit")) {
        dbUrl += (dbUrl.includes("?") ? "&" : "?") + "connection_limit=1";
    }
    return new PrismaClient({
        datasources: {
            db: {
                url: dbUrl
            }
        }
    });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

