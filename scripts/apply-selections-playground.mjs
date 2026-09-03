// One-off additive migration for the Client Selections Playground spec
// (docs/specs/client-selections-playground.md), Phase 1.
// Safe to re-run while the previous build is live — every statement is
// idempotent (IF NOT EXISTS / guarded DO $$ blocks / WHERE-scoped UPDATEs).
// Additive DDL + a guarded status remap only — no deletes, no drops, no
// destructive rewrites.
//
// Run through the release orchestrator BEFORE deploying the build that
// ships this schema (see the pre-deploy checklist in CLAUDE.md):
//   node scripts/apply-selections-playground.mjs
//
// RUN IT AGAIN AFTER THE DEPLOY COMPLETES. The old build stays live for the
// whole migration window and can still insert new 'Pending'/'Approved'/
// 'Declined' SelectionProposal rows after the remap statements below have
// already passed — a second, post-deploy run sweeps up those stragglers.
// Every read/write path in actions.ts also treats the legacy strings
// defensively in the meantime (see normalizeProposalStatus), so a straggler
// never renders wrong or disappears — this second run just finishes the
// cleanup.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const statements = [
  // ── Decision ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "Decision" (
     "id" TEXT NOT NULL,
     "projectId" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "area" TEXT,
     "status" TEXT NOT NULL DEFAULT 'Open',
     "chosenItemId" TEXT,
     "sortOrder" INTEGER NOT NULL DEFAULT 0,
     "templateKey" TEXT,
     "createdByClient" BOOLEAN NOT NULL DEFAULT false,
     "decidedAt" TIMESTAMP(3),
     "pmNote" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "deletedAt" TIMESTAMP(3),
     CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
   )`,
  // Defensive re-assert in case an earlier partial run of this script
  // already created the table without this column.
  `ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3)`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'Decision_projectId_fkey'
         AND conrelid = '"Decision"'::regclass
     ) THEN
       ALTER TABLE "Decision"
         ADD CONSTRAINT "Decision_projectId_fkey"
         FOREIGN KEY ("projectId") REFERENCES "Project"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'Decision_chosenItemId_key'
         AND conrelid = '"Decision"'::regclass
     ) THEN
       ALTER TABLE "Decision"
         ADD CONSTRAINT "Decision_chosenItemId_key" UNIQUE ("chosenItemId");
     END IF;
   END $$`,
  // FK to SelectionProposal added AFTER SelectionProposal.decisionId below so
  // both tables/columns exist regardless of statement ordering assumptions.
  `CREATE INDEX IF NOT EXISTS "Decision_projectId_status_idx" ON "Decision" ("projectId", "status")`,
  // Authoritative idempotency guard for importBoardPicksAsDecisions (rather
  // than trusting a read-then-write) — nullable templateKey is fine,
  // Postgres treats every NULL as distinct so ordinary decisions never
  // collide with each other on this constraint.
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'Decision_projectId_templateKey_key'
         AND conrelid = '"Decision"'::regclass
     ) THEN
       ALTER TABLE "Decision"
         ADD CONSTRAINT "Decision_projectId_templateKey_key" UNIQUE ("projectId", "templateKey");
     END IF;
   END $$`,

  // ── SelectionProposal.decisionId ─────────────────────────────────────────
  `ALTER TABLE "SelectionProposal"
     ADD COLUMN IF NOT EXISTS "decisionId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "SelectionProposal_decisionId_idx" ON "SelectionProposal" ("decisionId")`,
  // Re-asserted defensively (already created by apply-product-library.mjs
  // when SelectionProposal was first added) — IF NOT EXISTS makes this a
  // no-op today, kept here so this script alone fully describes every
  // index/constraint the Phase 1 code depends on.
  `CREATE INDEX IF NOT EXISTS "SelectionProposal_projectId_status_idx" ON "SelectionProposal" ("projectId", "status")`,
  // Database default must match prisma/schema.prisma's @default("Idea") —
  // existing rows are untouched, this only changes what new inserts without
  // an explicit status get.
  `ALTER TABLE "SelectionProposal" ALTER COLUMN "status" SET DEFAULT 'Idea'`,

  // ── Decision.chosenItemId → SelectionProposal ────────────────────────────
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'Decision_chosenItemId_fkey'
         AND conrelid = '"Decision"'::regclass
     ) THEN
       ALTER TABLE "Decision"
         ADD CONSTRAINT "Decision_chosenItemId_fkey"
         FOREIGN KEY ("chosenItemId") REFERENCES "SelectionProposal"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     END IF;
   END $$`,

  // ── SelectionProposal.decisionId → Decision ──────────────────────────────
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'SelectionProposal_decisionId_fkey'
         AND conrelid = '"SelectionProposal"'::regclass
     ) THEN
       ALTER TABLE "SelectionProposal"
         ADD CONSTRAINT "SelectionProposal_decisionId_fkey"
         FOREIGN KEY ("decisionId") REFERENCES "Decision"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     END IF;
   END $$`,

  // Server-only table. RLS with no policies denies direct anon/authenticated
  // Data API access; server-side Prisma uses the owner role. Matches the
  // convention in scripts/apply-product-library.mjs.
  `ALTER TABLE "Decision" ENABLE ROW LEVEL SECURITY`,

  // ── Pre-remap snapshot ────────────────────────────────────────────────────
  // Prod check (2026-07-28): Hoppe has 13 SelectionProposal rows, all
  // 'Pending', added today and the client is still actively adding — she's
  // mid-flight. This captures the exact pre-migration status of every row
  // before the remap below touches anything, so any remap is reversible
  // precisely (UPDATE "SelectionProposal" sp SET status = b.status FROM
  // "_SelectionProposalStatusBackup" b WHERE b.id = sp.id). ON CONFLICT DO
  // NOTHING makes this safe to re-run — only the FIRST capture per row
  // sticks, so a second run can't overwrite a true pre-migration snapshot
  // with an already-remapped status. Never dropped by this script.
  `CREATE TABLE IF NOT EXISTS "_SelectionProposalStatusBackup" (
     "id" TEXT PRIMARY KEY,
     "status" TEXT NOT NULL,
     "capturedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `INSERT INTO "_SelectionProposalStatusBackup" ("id", "status")
     SELECT "id", "status" FROM "SelectionProposal"
     ON CONFLICT ("id") DO NOTHING`,

  // ── Status remap: SelectionProposal legacy → playground statuses ────────
  // "Nothing was rejected" per the spec — this is a rename, not a re-decide.
  // WHERE-scoped on the OLD value so it's safe to re-run: a row already
  // remapped no longer matches and is skipped on subsequent runs.
  `UPDATE "SelectionProposal" SET "status" = 'Idea' WHERE "status" = 'Pending'`,
  `UPDATE "SelectionProposal" SET "status" = 'Chosen' WHERE "status" = 'Approved'`,
  `UPDATE "SelectionProposal" SET "status" = 'Archived' WHERE "status" = 'Declined'`,
];

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: resolveDatabaseUrl() } },
  });

  try {
    for (const sql of statements) {
      await prisma.$executeRawUnsafe(sql);
      console.log("applied:", sql.split("\n")[0]);
    }
    console.log("Client Selections Playground schema applied successfully.");
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
