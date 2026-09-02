// One-off additive migration for client-deletable selection items.
// Adds SelectionProposal.deletedAt so a client can delete an archived item
// from their playground without destroying the row — the team keeps a 30-day
// restore window (getRecentlyDeletedItems / restoreItem), same rule already in
// place for Decision.deletedAt.
// Safe to run against the live DB while the deployed (old) client is in use:
// the column uses IF NOT EXISTS and every existing row keeps deletedAt NULL,
// which is exactly what the old build's unfiltered reads already assume.
// Mirrors scripts/apply-moodboard-client-collab.mjs.
//
// Run:  node scripts/apply-selection-item-soft-delete.mjs
// (DDL via $executeRawUnsafe over the Supabase transaction pooler — the working
//  path in this project; psql / prisma db push / migrate dev do not work here.)
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env", ".env.local"]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

// Note on locking: the CREATE INDEX below is deliberately NOT CONCURRENTLY.
// It takes a SHARE lock that blocks writes to SelectionProposal while it
// builds, but the table is small (hundreds of rows — one per client-suggested
// item across all projects), so the build is effectively instantaneous.
// CONCURRENTLY would trade that for a real hazard here: it cannot run inside a
// transaction block, and this connects over the Supabase transaction pooler
// (pgbouncer), where it is unreliable. Revisit if this table ever grows.
const statements = [
  `ALTER TABLE "SelectionProposal" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);`,
  `CREATE INDEX IF NOT EXISTS "SelectionProposal_projectId_deletedAt_idx" ON "SelectionProposal"("projectId", "deletedAt");`,
];

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

  try {
    for (const sql of statements) {
      await prisma.$executeRawUnsafe(sql);
      console.log("✔ applied:", sql.split("\n")[0].slice(0, 90));
    }
    console.log(`Done. ${statements.length} statements applied.`);
  } catch (e) {
    console.error("Migration failed:", e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
