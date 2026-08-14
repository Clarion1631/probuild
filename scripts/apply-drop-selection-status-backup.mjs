// One-off DESTRUCTIVE cleanup: drops "_SelectionProposalStatusBackup".
//
// That table was a one-time pre-migration snapshot captured by
// scripts/apply-selections-playground.mjs on 2026-07-28, so the legacy →
// playground status rename (Pending→Idea / Approved→Chosen / Declined→
// Archived) could be reversed precisely. Nothing in the codebase ever read
// it — the only executable references are inside the script that created it
// and the schema model this change removes alongside it (a historical note in
// .claude/skills/probuild-schema-migration/SKILL.md also names it). It was the
// single genuinely dead object found in the #370 schema-drift audit.
//
// Verified against prod before running (2026-08-13): all 16 rows hold status
// 'Pending' on one project, every corresponding SelectionProposal row still
// exists and now reads 'Idea'. The snapshot is keyed per row, but every stored
// status value is the same one, so the reversal it enables is a blanket rename
// rather than per-row state — and a JSON dump was handed to Justin first
// regardless. Post-drop, SelectionProposal is 21 Idea / 3 Archived / 2 Chosen
// with zero legacy statuses left, so the remap is settled. Justin gave the
// explicit go-ahead for the drop.
//
// scripts/apply-selections-playground.mjs is deliberately left untouched as a
// historical record. Note that it is therefore no longer safe to re-run: its
// capture step is CREATE TABLE IF NOT EXISTS followed by an unconditional
// INSERT … SELECT, so a rerun would recreate this table and fill it with
// CURRENT statuses — a fake "pre-migration" snapshot, and fresh schema drift.
// That script has already done its job; do not run it again.
//
// This is the only statement that runs. It is idempotent (IF EXISTS) and
// deliberately has no CASCADE — the table is standalone and nothing
// references it, so a dependency error here means an assumption broke and
// the drop should stop rather than take dependents with it.
//
//   node scripts/apply-drop-selection-status-backup.mjs
//
// Run it BEFORE deploying the build that removes the Prisma model (see the
// pre-deploy checklist in CLAUDE.md). Order is not load-bearing in this
// direction — no runtime code queries the model — but keeping schema and
// database in step is the point of the change.
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

const statements = [`DROP TABLE IF EXISTS "_SelectionProposalStatusBackup"`];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("applied:", sql);
  }
  console.log("_SelectionProposalStatusBackup dropped.");
} finally {
  await prisma.$disconnect();
}
