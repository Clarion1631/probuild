// One-off additive migration for progress billing core (models ProgressBilling,
// ProgressBillingLine in prisma/schema.prisma, plus Estimate.taxInclusiveMilestones).
// Additive only: new tables + one new column, no drops/renames. Safe to re-run
// while the previous build is live and safe to run twice (every statement is
// IF NOT EXISTS / guarded).
//
// Run only through the release orchestrator:
//   node scripts/apply-progress-billing-schema.mjs
//
// Do not run this against prod during implementation handoff — the new Prisma
// client selects these columns/tables immediately, so this must be applied
// before deploy (see CLAUDE.md's pre-deploy checklist).
// (DDL via $executeRawUnsafe over the Supabase transaction pooler — the working
//  path in this project; psql / prisma db push / migrate dev do not work here.)
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
  `ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "taxInclusiveMilestones" BOOLEAN NOT NULL DEFAULT true`,

  `CREATE TABLE IF NOT EXISTS "ProgressBilling" (
     "id" TEXT NOT NULL,
     "invoiceId" TEXT NOT NULL,
     "code" TEXT NOT NULL,
     "description" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'Draft',
     "subtotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
     "taxExempt" BOOLEAN NOT NULL DEFAULT false,
     "taxRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
     "taxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
     "total" DECIMAL(65,30) NOT NULL DEFAULT 0,
     "qbInvoiceId" TEXT,
     "qbInvoiceLink" TEXT,
     "qbInvoiceSentAt" TIMESTAMP(3),
     "qbPaymentId" TEXT,
     "qbSyncedAt" TIMESTAMP(3),
     "qbSyncError" TEXT,
     "sentAt" TIMESTAMP(3),
     "paidAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ProgressBilling_pkey" PRIMARY KEY ("id")
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ProgressBilling_invoiceId_fkey'
         AND conrelid = '"ProgressBilling"'::regclass
     ) THEN
       ALTER TABLE "ProgressBilling"
         ADD CONSTRAINT "ProgressBilling_invoiceId_fkey"
         FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "ProgressBilling_invoiceId_idx" ON "ProgressBilling" ("invoiceId")`,
  `CREATE INDEX IF NOT EXISTS "ProgressBilling_status_idx" ON "ProgressBilling" ("status")`,

  `CREATE TABLE IF NOT EXISTS "ProgressBillingLine" (
     "id" TEXT NOT NULL,
     "billingId" TEXT NOT NULL,
     "scheduleId" TEXT,
     "description" TEXT NOT NULL,
     "amount" DECIMAL(65,30) NOT NULL,
     "splitAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
     "order" INTEGER NOT NULL DEFAULT 0,
     CONSTRAINT "ProgressBillingLine_pkey" PRIMARY KEY ("id")
   )`,
  // Separate ADD COLUMN so a database that already has the table from an
  // earlier run of this script still picks up splitAmount.
  `ALTER TABLE "ProgressBillingLine" ADD COLUMN IF NOT EXISTS "splitAmount" DECIMAL(65,30) NOT NULL DEFAULT 0`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ProgressBillingLine_billingId_fkey'
         AND conrelid = '"ProgressBillingLine"'::regclass
     ) THEN
       ALTER TABLE "ProgressBillingLine"
         ADD CONSTRAINT "ProgressBillingLine_billingId_fkey"
         FOREIGN KEY ("billingId") REFERENCES "ProgressBilling"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "ProgressBillingLine_billingId_idx" ON "ProgressBillingLine" ("billingId")`,
  `CREATE INDEX IF NOT EXISTS "ProgressBillingLine_scheduleId_idx" ON "ProgressBillingLine" ("scheduleId")`,
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
    console.log("Progress billing schema applied successfully.");
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
