// Additive schema for the Logistics voice-dump → formalize → route feature
// (plan 02; src/lib/logistics-formalize.ts, /api/ai/formalize-logistics,
// /api/time-entries/[id]/logistics, /manager/logistics).
// ADD COLUMN IF NOT EXISTS only — idempotent, safe while the old build is live.
//   node scripts/apply-logistics-routing-schema.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATEMENTS = [
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "rawNote" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "formalizedNote" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "logisticsCategory" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "routedFromProjectId" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "routedAt" TIMESTAMP(3)`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "routedById" TEXT`,
];

async function main() {
    config({ path: join(__dirname, "..", ".env.production.local") });
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });
    if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    try {
        for (const sql of STATEMENTS) { await prisma.$executeRawUnsafe(sql); console.log("ok:", sql); }
        const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'TimeEntry' AND column_name IN ('rawNote','formalizedNote','logisticsCategory','routedFromProjectId','routedAt','routedById')`);
        console.log(`verified ${cols.length}/6 columns present`);
        if (cols.length !== 6) process.exit(1);
    } finally { await prisma.$disconnect(); }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    await main();
}
