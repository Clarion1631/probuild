import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined
}

function buildPrismaClient(): PrismaClient {
    let dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
        try {
            // Check if it's a valid relative file protocol or a standard URL
            const isRelativeFile = dbUrl.startsWith('file:') && !dbUrl.startsWith('file://');
            const parsedUrl = isRelativeFile ? new URL(dbUrl, 'file://') : new URL(dbUrl);

            const allowedProtocols = [
                'postgresql:', 'postgres:', 'mysql:', 'sqlite:', 'file:',
                'mongodb:', 'mongodb+srv:', 'sqlserver:', 'cockroachdb:'
            ];

            if (!allowedProtocols.includes(parsedUrl.protocol)) {
                throw new Error(`Invalid database protocol: ${parsedUrl.protocol}`);
            }
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Invalid database protocol')) {
                throw error;
            }
            throw new Error('Invalid DATABASE_URL format');
        }

        if (!dbUrl.includes("connection_limit")) {
            dbUrl += (dbUrl.includes("?") ? "&" : "?") + "connection_limit=5";
        }

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
