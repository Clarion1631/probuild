// One-off additive migration for the Unified Money Register (plan §1,
// "Promote evidence out of JSON"): promotes qbPurchaseId / driveFileId out of
// AutomationEvent.detail JSON into typed nullable columns. Safe to re-run
// while the old build is live: pure ADD COLUMN IF NOT EXISTS / CREATE INDEX
// CONCURRENTLY IF NOT EXISTS, no existing column or row is touched.
//
// Mandated rollout order (docs/UNIFIED-REGISTER-PLAN.md §1, punch 12):
//   1. node scripts/apply-review-evidence-columns.mjs                  (this script — columns only)
//   2. deploy the dual-write build (logAutomationEvent populates both new columns)
//   3. node scripts/backfill-review-evidence.mjs                       (historical backfill, resumable)
//   4. node scripts/backfill-review-evidence.mjs                       (catch-up pass over remaining nulls)
//   5. node scripts/apply-review-evidence-columns.mjs --with-indexes   (adds the indexes)
//
// Apply step 1 BEFORE deploying the build that selects these columns (P2022
// otherwise). Step 5 is a deliberately SEPARATE, explicit invocation:
// building a CONCURRENTLY index while the backfill's UPDATEs are still
// landing is wasted churn (every backfill write would also maintain a
// half-built index), so indexing waits until the data has settled.
//
// CREATE INDEX CONCURRENTLY also cannot run inside a transaction block. This
// script never batches statements via prisma.$transaction() — each
// $executeRawUnsafe call is its own autocommit statement — and the index
// phase connects via DIRECT_URL (the unpooled connection; see
// prisma/schema.prisma `directUrl`) rather than the pgbouncer-pooled
// DATABASE_URL, so the single physical connection CONCURRENTLY needs for its
// whole run is guaranteed rather than multiplexed away mid-build.
//
//   node scripts/apply-review-evidence-columns.mjs [--with-indexes]
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

function resolveUrl(varName) {
  if (process.env[varName]) return process.env[varName];
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const re = new RegExp(`^${varName}\\s*=\\s*"?([^"\\n]+)"?`, "m");
    const match = fs.readFileSync(file, "utf8").match(re);
    if (match) return match[1];
  }
  return undefined;
}

const withIndexes = process.argv.includes("--with-indexes");

const columnStatements = [
  `ALTER TABLE "AutomationEvent" ADD COLUMN IF NOT EXISTS "qbPurchaseId" TEXT`,
  `ALTER TABLE "AutomationEvent" ADD COLUMN IF NOT EXISTS "driveFileId" TEXT`,
];

const indexStatements = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "AutomationEvent_qbPurchaseId_idx" ON "AutomationEvent"("qbPurchaseId")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "AutomationEvent_driveFileId_idx" ON "AutomationEvent"("driveFileId")`,
];

async function main() {
  await applyColumns();
  if (withIndexes) {
    await applyIndexes();
  } else {
    console.log(
      "Indexes skipped — re-run with --with-indexes after the backfill catch-up pass completes (rollout step 5).",
    );
  }
}

async function applyColumns() {
  const url = resolveUrl("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL not found in env or .env files");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    for (const sql of columnStatements) {
      console.log(sql + " ...");
      await prisma.$executeRawUnsafe(sql);
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log("AutomationEvent.qbPurchaseId / driveFileId columns applied.");
}

async function applyIndexes() {
  const directUrl = resolveUrl("DIRECT_URL");
  if (!directUrl) {
    throw new Error(
      "DIRECT_URL not found — CREATE INDEX CONCURRENTLY needs the unpooled " +
        "connection (pgbouncer transaction pooling can't hold one physical " +
        "connection for the whole build). Set DIRECT_URL and re-run with --with-indexes.",
    );
  }
  const prisma = new PrismaClient({ datasources: { db: { url: directUrl } } });
  try {
    for (const sql of indexStatements) {
      console.log(sql + " ...");
      // Sent individually — never batched via prisma.$transaction() — so each
      // runs as its own autocommit statement, which CONCURRENTLY requires.
      await prisma.$executeRawUnsafe(sql);
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log("AutomationEvent qbPurchaseId / driveFileId indexes applied.");
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
