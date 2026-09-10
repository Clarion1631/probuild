import { prisma } from '@/lib/prisma';
import { hasCronSecret } from '@/lib/cron-auth';
import { createLegacyMemoPreflightHandler } from '@/lib/legacy-memo-preflight';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export const GET = createLegacyMemoPreflightHandler({ authorized: hasCronSecret, db: prisma, now: () => new Date() });
