// One-off additive migration for the Unified Money Register (plan §5 step 3,
// docs/UNIFIED-REGISTER-PLAN.md): creates QboPurchaseClassification, which
// persists — at QBO expense-sync time — whether a Purchase is job-costable,
// overhead, an owner draw, or unclassifiable. This CANNOT be recomputed later
// from the bank register alone (a QuickBooks General Ledger row carries none
// of the Purchase's customer/account/equity fields — see
// src/lib/qbo-expense-sync.ts:13-27 and src/lib/qbo-bank-register.ts:20), so
// the table must exist and be deployed BEFORE the dual-write sync build ships.
// Safe to re-run while the old build is live: pure CREATE IF NOT EXISTS /
// idempotent constraint add, no existing table or row is touched.
//
//   node scripts/apply-qbo-purchase-classification.mjs
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
  `CREATE TABLE IF NOT EXISTS "QboPurchaseClassification" (
     "qbPurchaseId"   TEXT NOT NULL,
     "classification" TEXT NOT NULL,
     "reason"         TEXT,
     "qbSyncToken"    TEXT,
     "classifiedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt"      TIMESTAMP(3) NOT NULL,
     CONSTRAINT "QboPurchaseClassification_pkey" PRIMARY KEY ("qbPurchaseId")
   )`,
  // Money-path plan mandates CHECK constraints over unvalidated strings
  // (docs/UNIFIED-REGISTER-PLAN.md §4). Idempotent add: Postgres has no
  // "ADD CONSTRAINT IF NOT EXISTS", so guard with a catalog lookup — the
  // same pattern apply-mcp-confirmations-schema.mjs uses for its UNIQUE
  // constraint.
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'QboPurchaseClassification_classification_check'
         AND conrelid = '"QboPurchaseClassification"'::regclass
     ) THEN
       ALTER TABLE "QboPurchaseClassification"
         ADD CONSTRAINT "QboPurchaseClassification_classification_check"
         CHECK ("classification" IN ('job-cost', 'overhead', 'owner-draw', 'unknown'));
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "QboPurchaseClassification_classification_idx"
     ON "QboPurchaseClassification" ("classification")`,
  // Server-only table accessed exclusively through Prisma with the service
  // role (which bypasses RLS) — same posture as AutomationEvent
  // (apply-automation-events.mjs) and McpConfirmation.
  `ALTER TABLE "QboPurchaseClassification" ENABLE ROW LEVEL SECURITY`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("applied:", sql.split("\n")[0].trim());
  }
  console.log("QboPurchaseClassification schema applied successfully.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
