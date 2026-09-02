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
    `CREATE INDEX IF NOT EXISTS "Project_percentCompleteUpdatedById_idx" ON "Project"("percentCompleteUpdatedById")`,
    `DO $$ BEGIN
       ALTER TABLE "Project" ADD CONSTRAINT "Project_percentCompleteUpdatedById_fkey"
         FOREIGN KEY ("percentCompleteUpdatedById") REFERENCES "User"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

    // ScheduleTask.costCodeId — phase attribution for CHANGE-ORDER tasks.
    // applyChangeOrderToSchedule sets estimateItemId null on everything it
    // creates, so a CO task had no route to a cost code, while approved CO
    // dollars WERE already in the phase budget. Net effect before this: a
    // CO-only phase could never advance past 0%.
    `ALTER TABLE "ScheduleTask" ADD COLUMN IF NOT EXISTS "costCodeId" TEXT`,
    `CREATE INDEX IF NOT EXISTS "ScheduleTask_costCodeId_idx" ON "ScheduleTask"("costCodeId")`,
    `DO $$ BEGIN
       ALTER TABLE "ScheduleTask" ADD CONSTRAINT "ScheduleTask_costCodeId_fkey"
         FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
];

// One-shot backfill for CO tasks created before the column existed. No durable
// task→ChangeOrderItem link exists (the child task is created from the item's
// `name`, in order), so the join is the name — and a name match is only
// trustworthy when it is UNAMBIGUOUS on both sides. Both guards are required.
// Anything ambiguous stays null and goes on being unattributed, which is the
// honest outcome rather than a guessed phase. Idempotent (`costCodeId IS NULL`).
export const BACKFILL_CO_TASK_COST_CODES = `
    UPDATE "ScheduleTask" st
    SET "costCodeId" = ci."costCodeId"
    FROM "ChangeOrderItem" ci
    WHERE st."generatedFromChangeOrderId" = ci."changeOrderId"
      AND st."name" = ci."name"
      AND st."costCodeId" IS NULL
      AND st."estimateItemId" IS NULL
      AND st."type" = 'task'
      AND st."parentId" IS NOT NULL
      AND ci."costCodeId" IS NOT NULL
      AND ci."total" >= 0
      AND (SELECT COUNT(*) FROM "ChangeOrderItem" c2
           WHERE c2."changeOrderId" = ci."changeOrderId" AND c2."name" = ci."name"
             AND c2."total" >= 0) = 1
      AND (SELECT COUNT(*) FROM "ScheduleTask" s2
           WHERE s2."generatedFromChangeOrderId" = st."generatedFromChangeOrderId"
             AND s2."name" = st."name" AND s2."type" = 'task'
             AND s2."parentId" IS NOT NULL) = 1`;

export const EXPECTED_COLUMNS = [
    "percentComplete",
    "percentCompleteSource",
    "percentCompleteAsOf",
    "percentCompleteAuto",
    "percentCompleteAutoAtOverride",
    "percentCompleteUpdatedById",
];

// Run the DDL, verify it, then run the repeatable backfill. Wrapped in a main
// guard (same discipline as scripts/apply-bank-ledger.mjs) so importing this
// module -- which tests/percent-complete-backfill.test.ts does, to prove the
// script's SQL and the cron's repair pass have not drifted apart -- never
// resolves DATABASE_URL, opens a connection, or mutates anything.
async function main() {
    config({ path: join(__dirname, "..", ".env.production.local") });
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL is not set (.env.production.local missing?).");
        process.exit(1);
    }

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    try {
        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
            console.log("ok:", sql.split("\n")[0].trim());
        }
        // Read the whole prefix and compare in JS rather than passing an array
        // parameter — one less raw-query serialization detail to get wrong in a
        // script whose failure mode is "the deploy 500s on P2022".
        const cols = await prisma.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'Project' AND column_name LIKE 'percentComplete%'`
        );
        const present = new Set(cols.map((c) => c.column_name));
        const missing = EXPECTED_COLUMNS.filter((name) => !present.has(name));
        console.log(
            `verified ${EXPECTED_COLUMNS.length - missing.length}/${EXPECTED_COLUMNS.length} columns present`,
            missing.length ? `— MISSING: ${missing.join(", ")}` : ""
        );
        if (missing.length) process.exit(1);

        const fk = await prisma.$queryRawUnsafe(
            `SELECT conname FROM pg_constraint WHERE conname = 'Project_percentCompleteUpdatedById_fkey'`
        );
        console.log(`verified ${fk.length}/1 foreign key present`);
        if (fk.length !== 1) process.exit(1);

        const idx = await prisma.$queryRawUnsafe(
            `SELECT indexname FROM pg_indexes WHERE indexname IN
             ('Project_percentCompleteUpdatedById_idx', 'ScheduleTask_costCodeId_idx')`
        );
        console.log(`verified ${idx.length}/2 indexes present`);
        if (idx.length !== 2) process.exit(1);

        const taskCol = await prisma.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'ScheduleTask' AND column_name = 'costCodeId'`
        );
        console.log(`verified ${taskCol.length}/1 ScheduleTask.costCodeId present`);
        if (taskCol.length !== 1) process.exit(1);

        const backfilled = await prisma.$executeRawUnsafe(BACKFILL_CO_TASK_COST_CODES);
        console.log(`backfilled ${backfilled} change-order task(s) with a cost code`);

        const stillUnattributed = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "ScheduleTask"
             WHERE "generatedFromChangeOrderId" IS NOT NULL AND "type" = 'task'
               AND "costCodeId" IS NULL AND "estimateItemId" IS NULL`
        );
        // Not a failure: ambiguous names and CO parent rows legitimately stay null.
        // Reported so the number is visible rather than assumed to be zero.
        console.log(`${stillUnattributed[0].n} CO task(s) remain without a cost code (ambiguous name or CO parent row)`);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
