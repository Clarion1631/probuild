// Additive schema for the AUTOMATIC-BREAK time-clock model (src/lib/wa-breaks.ts):
//   TimeEntry.shiftHours            raw clock-in→clock-out hours (durationHours = PAID hours)
//   TimeEntry.mealOutcome           NOT_REQUIRED | PUNCHED | AUTO_DEDUCTED | WORKED_THROUGH | WAIVED_APPROVED
//   TimeEntry.restBreaksMissed      clock-out attestation (documentation only, never pay)
//   TimeEntry.mealSkipRequestedAt / mealSkipStatus / mealSkipDecidedById / mealSkipDecidedAt / mealSkipReason
//                                   the skip-lunch request → manager approval trail
//   User.mealWaiverSignedAt         Marge's signed meal-period waiver on file (approval precondition)
//
// ADD COLUMN IF NOT EXISTS only — idempotent, no drops, safe while the previous
// build is live (the old build simply ignores the new nullable columns). Run
// BEFORE deploying the site build that reads them, per CLAUDE.md "Schema
// migrations" (no `prisma db push` / `migrate dev` here — DIRECT_URL is
// IPv6-only). Then regenerate the client from PowerShell.
//   node scripts/apply-wa-breaks-schema.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATEMENTS = [
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "shiftHours" DOUBLE PRECISION`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "mealOutcome" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "restBreaksMissed" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "mealSkipRequestedAt" TIMESTAMP(3)`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "mealSkipStatus" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "mealSkipDecidedById" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "mealSkipDecidedAt" TIMESTAMP(3)`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "mealSkipReason" TEXT`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mealWaiverSignedAt" TIMESTAMP(3)`,
];

async function main() {
    config({ path: join(__dirname, "..", ".env.production.local") });
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL is not set (.env.production.local missing? see card t_275a9e4d — restore from gtr-probuild-ledger).");
        process.exit(1);
    }

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    try {
        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
            console.log("ok:", sql);
        }
        const cols = await prisma.$queryRawUnsafe(
            `SELECT table_name, column_name FROM information_schema.columns
         WHERE (table_name = 'TimeEntry' AND column_name IN ('shiftHours','mealOutcome','restBreaksMissed','mealSkipRequestedAt','mealSkipStatus','mealSkipDecidedById','mealSkipDecidedAt','mealSkipReason'))
            OR (table_name = 'User' AND column_name = 'mealWaiverSignedAt')
         ORDER BY table_name, column_name`
        );
        console.log(`verified ${cols.length}/9 columns present:`, cols.map((c) => `${c.table_name}.${c.column_name}`).join(", "));
        if (cols.length !== 9) process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
