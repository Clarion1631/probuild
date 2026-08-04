// One-off additive migration for the Unified Money Register review-alert
// pipeline (plan §5 step 8, docs/UNIFIED-REGISTER-PLAN.md §4): creates
// ReviewIssue (current state), ReviewAlertEpisode (immutable per-generation
// delivery snapshot), ReviewAlertBatch (rate-ceiling overflow summary, same
// retry model as episodes), and RolloutGate (durable baseline lease — never a
// long transaction or session advisory lock, neither survives pgbouncer).
//
// Safe to re-run while the old build is live: no existing ROW is ever
// touched, only table/column/constraint/index DEFINITIONS. Apply BEFORE
// deploying the build that selects these tables (P2022 otherwise), and well
// before flipping REVIEW_ALERTS_ENABLED — the plan's internal order is apply
// schema → deploy evaluator disabled → baseline (scripts/run-review-alerts-
// baseline.ts) → catch-up → enable.
//
// Convergence policy (Codex finding 10 — "CREATE TABLE IF NOT EXISTS doesn't
// add missing columns, and an older same-named CHECK is never replaced, so a
// re-run after an earlier version of this file can keep a list that rejects
// BATCHED/SUPERSEDED"; on today's fresh DB the lists already match — this is
// an UPGRADE-path fix for whoever edits this file next):
//   - New columns ship as their own explicit `ADD COLUMN IF NOT EXISTS`
//     statement below (not folded into CREATE TABLE, which no-ops entirely
//     once the table exists) — the FUTURE author who adds a column to one of
//     these 4 tables must add its own such statement, same as the ones below.
//   - CHECK constraints (status allow-lists) are unconditionally
//     DROP-then-ADD, never "IF NOT EXISTS (name match)" — a same-named CHECK
//     with a STALE value list would otherwise never be replaced.
//   - Same DROP-then-ADD treatment for the one FK whose definition can
//     change (episode → batch, see finding 3 below). FKs/UNIQUEs whose
//     definition never changes across versions of this file keep the cheaper
//     "IF NOT EXISTS (name match)" form.
//
//   node scripts/apply-review-alerts-schema.mjs
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const prisma = new PrismaClient({
  datasources: { db: { url: resolveDatabaseUrl() } },
});

const statements = [
  // ── ReviewIssue ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "ReviewIssue" (
     "id"                TEXT NOT NULL,
     "targetType"        TEXT NOT NULL,
     "targetKey"         TEXT NOT NULL,
     "version"           INTEGER NOT NULL DEFAULT 1,
     "reasonCodes"       TEXT NOT NULL,
     "reasonHash"        TEXT NOT NULL,
     "displayDetails"    TEXT,
     "acknowledgedCodes" TEXT NOT NULL DEFAULT '[]',
     "acknowledgedAt"    TIMESTAMP(3),
     "firstObservedAt"   TIMESTAMP(3) NOT NULL,
     "clearedAt"         TIMESTAMP(3),
     "currentGeneration" INTEGER NOT NULL DEFAULT 1,
     "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt"         TIMESTAMP(3) NOT NULL,
     CONSTRAINT "ReviewIssue_pkey" PRIMARY KEY ("id"),
     CONSTRAINT "ReviewIssue_targetType_targetKey_key" UNIQUE ("targetType", "targetKey")
   )`,
  // Convergent column upgrade path (finding 10): a no-op on a fresh CREATE
  // above, but retrofits a table created by an EARLIER version of this file
  // that predates one of these columns.
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "reasonCodes" TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "reasonHash" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "displayDetails" TEXT`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "acknowledgedCodes" TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMP(3)`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "clearedAt" TIMESTAMP(3)`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "currentGeneration" INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `ALTER TABLE "ReviewIssue" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  // Idempotent add for a table created by an earlier version of this script
  // (mirrors apply-mcp-confirmations-schema.mjs's UNIQUE-constraint pattern —
  // Postgres has no "ADD CONSTRAINT IF NOT EXISTS"). Definition never
  // changes across versions of this file, so the cheaper name-check form is
  // fine here (contrast the CHECK constraints below).
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ReviewIssue_targetType_targetKey_key'
         AND conrelid = '"ReviewIssue"'::regclass
     ) THEN
       ALTER TABLE "ReviewIssue"
         ADD CONSTRAINT "ReviewIssue_targetType_targetKey_key" UNIQUE ("targetType", "targetKey");
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "ReviewIssue_clearedAt_idx" ON "ReviewIssue" ("clearedAt")`,
  `ALTER TABLE "ReviewIssue" ENABLE ROW LEVEL SECURITY`,

  // ── ReviewAlertEpisode ───────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "ReviewAlertEpisode" (
     "id"              TEXT NOT NULL,
     "issueId"         TEXT NOT NULL,
     "generation"      INTEGER NOT NULL,
     "reasonCodes"     TEXT NOT NULL,
     "reasonHash"      TEXT NOT NULL,
     "displayDetails"  TEXT,
     "status"          TEXT NOT NULL DEFAULT 'PENDING',
     "claimToken"      TEXT,
     "claimedAt"       TIMESTAMP(3),
     "attempts"        INTEGER NOT NULL DEFAULT 0,
     "lastError"       TEXT,
     "nextAttemptAt"   TIMESTAMP(3),
     "sentAt"          TIMESTAMP(3),
     "chatMessageName" TEXT,
     "batchId"         TEXT,
     "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ReviewAlertEpisode_pkey" PRIMARY KEY ("id"),
     CONSTRAINT "ReviewAlertEpisode_issueId_generation_key" UNIQUE ("issueId", "generation")
   )`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "reasonCodes" TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "reasonHash" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "displayDetails" TEXT`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING'`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "claimToken" TEXT`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3)`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "lastError" TEXT`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3)`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3)`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "chatMessageName" TEXT`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "batchId" TEXT`,
  `ALTER TABLE "ReviewAlertEpisode" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ReviewAlertEpisode_issueId_generation_key'
         AND conrelid = '"ReviewAlertEpisode"'::regclass
     ) THEN
       ALTER TABLE "ReviewAlertEpisode"
         ADD CONSTRAINT "ReviewAlertEpisode_issueId_generation_key" UNIQUE ("issueId", "generation");
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ReviewAlertEpisode_issueId_fkey'
         AND conrelid = '"ReviewAlertEpisode"'::regclass
     ) THEN
       ALTER TABLE "ReviewAlertEpisode"
         ADD CONSTRAINT "ReviewAlertEpisode_issueId_fkey"
         FOREIGN KEY ("issueId") REFERENCES "ReviewIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  // Finding 10's literal example: unconditional DROP+ADD so a re-run after
  // an EARLIER version of this file (whose allow-list predates BATCHED/
  // SUPERSEDED) actually replaces the stale CHECK instead of silently
  // keeping it (the old "IF NOT EXISTS (name match)" form only guarded
  // against re-creating a constraint that already exists BY NAME — it never
  // compared the allow-list itself).
  `ALTER TABLE "ReviewAlertEpisode" DROP CONSTRAINT IF EXISTS "ReviewAlertEpisode_status_check"`,
  `ALTER TABLE "ReviewAlertEpisode"
     ADD CONSTRAINT "ReviewAlertEpisode_status_check"
     CHECK ("status" IN ('PENDING', 'CLAIMED', 'SENT', 'FAILED', 'SUPERSEDED', 'CANCELLED', 'SUPPRESSED', 'BATCHED'))`,
  // Finding 11: a single composite (status, nextAttemptAt, claimedAt) index
  // cannot serve both due-retry candidate branches of the drainer's query
  // (review-alert-outbox.ts's `drainCore`) — `{status:"PENDING",
  // nextAttemptAt:<=now}` OR `{status:"CLAIMED", claimedAt:<staleBefore}` are
  // two DIFFERENT scan shapes, and with nextAttemptAt as the middle key
  // column, claimedAt can't be used as a proper range condition for the
  // second branch. Two PARTIAL indexes, one per branch, each keyed on its own
  // range column with createdAt appended so the drainer's `ORDER BY
  // createdAt ASC` (FIFO) can also use the index.
  `DROP INDEX IF EXISTS "ReviewAlertEpisode_status_nextAttemptAt_claimedAt_idx"`,
  `CREATE INDEX IF NOT EXISTS "ReviewAlertEpisode_pending_retry_idx"
     ON "ReviewAlertEpisode" ("nextAttemptAt", "createdAt") WHERE "status" = 'PENDING'`,
  `CREATE INDEX IF NOT EXISTS "ReviewAlertEpisode_claimed_lease_idx"
     ON "ReviewAlertEpisode" ("claimedAt", "createdAt") WHERE "status" = 'CLAIMED'`,
  `CREATE INDEX IF NOT EXISTS "ReviewAlertEpisode_batchId_idx" ON "ReviewAlertEpisode" ("batchId")`,
  `ALTER TABLE "ReviewAlertEpisode" ENABLE ROW LEVEL SECURITY`,

  // ── ReviewAlertBatch ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "ReviewAlertBatch" (
     "id"              TEXT NOT NULL,
     "status"          TEXT NOT NULL DEFAULT 'PENDING',
     "claimToken"      TEXT,
     "claimedAt"       TIMESTAMP(3),
     "attempts"        INTEGER NOT NULL DEFAULT 0,
     "lastError"       TEXT,
     "nextAttemptAt"   TIMESTAMP(3),
     "sentAt"          TIMESTAMP(3),
     "chatMessageName" TEXT,
     "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ReviewAlertBatch_pkey" PRIMARY KEY ("id")
   )`,
  `ALTER TABLE "ReviewAlertBatch" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING'`,
  `ALTER TABLE "ReviewAlertBatch" ADD COLUMN IF NOT EXISTS "claimToken" TEXT`,
  `ALTER TABLE "ReviewAlertBatch" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3)`,
  `ALTER TABLE "ReviewAlertBatch" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "ReviewAlertBatch" ADD COLUMN IF NOT EXISTS "lastError" TEXT`,
  `ALTER TABLE "ReviewAlertBatch" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3)`,
  `ALTER TABLE "ReviewAlertBatch" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3)`,
  `ALTER TABLE "ReviewAlertBatch" ADD COLUMN IF NOT EXISTS "chatMessageName" TEXT`,
  `ALTER TABLE "ReviewAlertBatch" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `ALTER TABLE "ReviewAlertBatch" DROP CONSTRAINT IF EXISTS "ReviewAlertBatch_status_check"`,
  `ALTER TABLE "ReviewAlertBatch"
     ADD CONSTRAINT "ReviewAlertBatch_status_check"
     CHECK ("status" IN ('PENDING', 'CLAIMED', 'SENT', 'FAILED'))`,
  // Same partial-index split as ReviewAlertEpisode (finding 11) — the batch
  // drain goes through the identical `drainCore` query shape.
  `DROP INDEX IF EXISTS "ReviewAlertBatch_status_nextAttemptAt_claimedAt_idx"`,
  `CREATE INDEX IF NOT EXISTS "ReviewAlertBatch_pending_retry_idx"
     ON "ReviewAlertBatch" ("nextAttemptAt", "createdAt") WHERE "status" = 'PENDING'`,
  `CREATE INDEX IF NOT EXISTS "ReviewAlertBatch_claimed_lease_idx"
     ON "ReviewAlertBatch" ("claimedAt", "createdAt") WHERE "status" = 'CLAIMED'`,
  `ALTER TABLE "ReviewAlertBatch" ENABLE ROW LEVEL SECURITY`,

  // FK from episode → batch, added after both tables exist.
  //
  // Finding 3: ON DELETE SET NULL let a deleted batch silently orphan its
  // still-BATCHED members (unowned rows nothing would ever drain again).
  // RESTRICT instead — a batch may only be deleted once nothing references
  // it, forcing whatever deletes a batch to first detach/requeue its members
  // explicitly (review-alert-outbox.ts's `onTerminalFailure` requeue does
  // exactly that on terminal batch failure, BEFORE the batch itself would
  // ever be a deletion candidate). Unconditional DROP+ADD (not "IF NOT
  // EXISTS (name match)") so a re-run after the OLDER SET NULL version
  // actually replaces the delete rule — the same convergence gap as the
  // CHECK constraints above.
  `ALTER TABLE "ReviewAlertEpisode" DROP CONSTRAINT IF EXISTS "ReviewAlertEpisode_batchId_fkey"`,
  `ALTER TABLE "ReviewAlertEpisode"
     ADD CONSTRAINT "ReviewAlertEpisode_batchId_fkey"
     FOREIGN KEY ("batchId") REFERENCES "ReviewAlertBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,

  // ── RolloutGate ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "RolloutGate" (
     "key"         TEXT NOT NULL,
     "status"      TEXT NOT NULL DEFAULT 'pending',
     "claimToken"  TEXT,
     "claimedAt"   TIMESTAMP(3),
     "startedAt"   TIMESTAMP(3),
     "completedAt" TIMESTAMP(3),
     "attempts"    INTEGER NOT NULL DEFAULT 0,
     "lastError"   TEXT,
     "updatedAt"   TIMESTAMP(3) NOT NULL,
     CONSTRAINT "RolloutGate_pkey" PRIMARY KEY ("key")
   )`,
  `ALTER TABLE "RolloutGate" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE "RolloutGate" ADD COLUMN IF NOT EXISTS "claimToken" TEXT`,
  `ALTER TABLE "RolloutGate" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3)`,
  `ALTER TABLE "RolloutGate" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3)`,
  `ALTER TABLE "RolloutGate" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3)`,
  `ALTER TABLE "RolloutGate" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "RolloutGate" ADD COLUMN IF NOT EXISTS "lastError" TEXT`,
  `ALTER TABLE "RolloutGate" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `ALTER TABLE "RolloutGate" DROP CONSTRAINT IF EXISTS "RolloutGate_status_check"`,
  `ALTER TABLE "RolloutGate"
     ADD CONSTRAINT "RolloutGate_status_check"
     CHECK ("status" IN ('pending', 'in-progress', 'complete'))`,
  `CREATE INDEX IF NOT EXISTS "RolloutGate_status_idx" ON "RolloutGate" ("status")`,
  `ALTER TABLE "RolloutGate" ENABLE ROW LEVEL SECURITY`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("applied:", sql.split("\n")[0].trim());
  }
  console.log("Review alert schema (ReviewIssue, ReviewAlertEpisode, ReviewAlertBatch, RolloutGate) applied successfully.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
