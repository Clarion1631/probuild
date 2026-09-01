// Additive schema for percent complete / earned margin
// (docs/plans/PHASE-4-EARNED-MARGIN-SPEC.md §2):
//
//   Project.percentComplete               the EFFECTIVE value every screen shows
//   Project.percentCompleteSource         AUTO (nightly cron) | MANUAL (override)
//   Project.percentCompleteAsOf           when percentComplete was last written
//   Project.percentCompleteAuto           last machine-computed value (always refreshed)
//   Project.percentCompleteAutoAtOverride snapshot of the auto value at override time,
//                                         the baseline for the >5-point drift check
//   Project.percentCompleteUpdatedById    who overrode it (null for AUTO writes)
//
// CREATE TYPE guarded by an EXCEPTION handler + ADD COLUMN IF NOT EXISTS only —
// idempotent, no drops, safe to re-run and safe while the previous build is
// live (the old build simply ignores the new columns). Run BEFORE deploying the
// build that selects them, per CLAUDE.md "Schema migrations" (no `prisma db
// push` / `migrate dev` here — DIRECT_URL is IPv6-only from this machine).
// Then regenerate the client from PowerShell.
//
//   node scripts/apply-percent-complete.mjs
//
// The identical DDL is checked in at
// prisma/migrations/20260901000000_percent_complete/migration.sql, which is what
// CI's throwaway database is built from.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.production.local") });
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (.env.production.local missing?).");
    process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

export const STATEMENTS = [
    `DO $$ BEGIN
       CREATE TYPE "PercentCompleteSource" AS ENUM ('AUTO', 'MANUAL');
     EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentComplete" DECIMAL(5,2)`,
    `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteSource" "PercentCompleteSource"`,
    `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteAsOf" TIMESTAMP(3)`,
    `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteAuto" DECIMAL(5,2)`,
    `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteAutoAtOverride" DECIMAL(5,2)`,
    `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteUpdatedById" TEXT`,
    `DO $$ BEGIN
       ALTER TABLE "Project" ADD CONSTRAINT "Project_percentCompleteUpdatedById_fkey"
         FOREIGN KEY ("percentCompleteUpdatedById") REFERENCES "User"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
];

export const EXPECTED_COLUMNS = [
    "percentComplete",
    "percentCompleteSource",
    "percentCompleteAsOf",
    "percentCompleteAuto",
    "percentCompleteAutoAtOverride",
    "percentCompleteUpdatedById",
];

try {
    for (const sql of STATEMENTS) {
        await prisma.$executeRawUnsafe(sql);
        console.log("ok:", sql.split("\n")[0].trim());
    }
    const cols = await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'Project' AND column_name = ANY($1::text[])`,
        EXPECTED_COLUMNS
    );
    console.log(
        `verified ${cols.length}/${EXPECTED_COLUMNS.length} columns present:`,
        cols.map((c) => `Project.${c.column_name}`).join(", ")
    );
    if (cols.length !== EXPECTED_COLUMNS.length) process.exit(1);

    const fk = await prisma.$queryRawUnsafe(
        `SELECT conname FROM pg_constraint WHERE conname = 'Project_percentCompleteUpdatedById_fkey'`
    );
    console.log(`verified ${fk.length}/1 foreign key present`);
    if (fk.length !== 1) process.exit(1);
} finally {
    await prisma.$disconnect();
}
