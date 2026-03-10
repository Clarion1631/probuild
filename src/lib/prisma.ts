import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined
}

let dbUrl = process.env.DATABASE_URL;
if (dbUrl && !dbUrl.includes("connection_limit")) {
    dbUrl += (dbUrl.includes("?") ? "&" : "?") + "connection_limit=1";
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
    datasources: {
        db: {
            url: dbUrl
        }
    }
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
