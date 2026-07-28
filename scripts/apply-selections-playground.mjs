// One-off additive migration for the Client Selections Playground spec
// (docs/specs/client-selections-playground.md), Phase 1.
// Safe to re-run while the previous build is live. Additive DDL + a guarded
// status remap only — no deletes, no drops, no destructive rewrites.
//
// Run only through the release orchestrator, and BEFORE deploying the build
// that ships this schema (see the pre-deploy checklist in CLAUDE.md):
//   node scripts/apply-selections-playground.mjs
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
     CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
   )`,
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

  // ── SelectionProposal.decisionId ─────────────────────────────────────────
  `ALTER TABLE "SelectionProposal"
     ADD COLUMN IF NOT EXISTS "decisionId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "SelectionProposal_decisionId_idx" ON "SelectionProposal" ("decisionId")`,

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

  // ── Status remap: SelectionProposal legacy → playground statuses ────────
  // "Nothing was rejected" per the spec — this is a rename, not a re-decide.
  // WHERE-scoped on the OLD value so it's safe to re-run: a row already
  // remapped no longer matches and is skipped on subsequent runs.
  `UPDATE "SelectionProposal" SET "status" = 'Idea' WHERE "status" = 'Pending'`,
  `UPDATE "SelectionProposal" SET "status" = 'Chosen' WHERE "status" = 'Approved'`,
  `UPDATE "SelectionProposal" SET "status" = 'Archived' WHERE "status" = 'Declined'`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("applied:", sql.split("\n")[0]);
  }
  console.log("Client Selections Playground schema applied successfully.");
} finally {
  await prisma.$disconnect();
}
