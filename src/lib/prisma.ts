import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

// Fallback removed for safety, require DATABASE_URL from environment
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
