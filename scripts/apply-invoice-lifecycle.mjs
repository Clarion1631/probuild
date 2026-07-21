// Additive, idempotent migration for invoice lifecycle visibility and QBO alignment.
//
// IMPORTANT: run against production BEFORE deploying the build that selects
// these columns. Do not run this script from tests or local development.
//
// Run: node scripts/apply-invoice-lifecycle.mjs
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

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

const statements = [
  `ALTER TABLE "Invoice"
     ADD COLUMN IF NOT EXISTS "lastViewedAt" TIMESTAMP(3),
     ADD COLUMN IF NOT EXISTS "viewCount" INTEGER NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS "emailStatus" TEXT,
     ADD COLUMN IF NOT EXISTS "emailBouncedAt" TIMESTAMP(3)`,
  `ALTER TABLE "PaymentSchedule"
     ADD COLUMN IF NOT EXISTS "firstViewedAt" TIMESTAMP(3),
     ADD COLUMN IF NOT EXISTS "lastViewedAt" TIMESTAMP(3)`,
  `ALTER TABLE "CompanySettings"
     ADD COLUMN IF NOT EXISTS "qbAlsoSendIntuitEmail" BOOLEAN NOT NULL DEFAULT false`,

  `CREATE TABLE IF NOT EXISTS "InvoiceViewEvent" (
     "id" TEXT NOT NULL,
     "invoiceId" TEXT NOT NULL,
     "viewedAt" TIMESTAMP(3) NOT NULL,
     "source" TEXT,
     CONSTRAINT "InvoiceViewEvent_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE TABLE IF NOT EXISTS "SendAttempt" (
     "id" TEXT NOT NULL,
     "invoiceId" TEXT NOT NULL,
     "recipient" TEXT NOT NULL,
     "sendRequestId" TEXT NOT NULL,
     "payloadHash" TEXT NOT NULL,
     "resendEmailId" TEXT,
     "status" TEXT NOT NULL DEFAULT 'sending',
     "sentAt" TIMESTAMP(3),
     "deliveredAt" TIMESTAMP(3),
     "terminalAt" TIMESTAMP(3),
     "lastError" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "SendAttempt_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE TABLE IF NOT EXISTS "SendAttemptMilestone" (
     "sendAttemptId" TEXT NOT NULL,
     "paymentScheduleId" TEXT NOT NULL,
     CONSTRAINT "SendAttemptMilestone_pkey" PRIMARY KEY ("sendAttemptId", "paymentScheduleId")
   )`,
  `CREATE TABLE IF NOT EXISTS "EmailEvent" (
     "id" TEXT NOT NULL,
     "svixId" TEXT NOT NULL,
     "resendEmailId" TEXT NOT NULL,
     "type" TEXT NOT NULL,
     "occurredAt" TIMESTAMP(3) NOT NULL,
     "payload" JSONB NOT NULL,
     "processedAt" TIMESTAMP(3),
     "claimedAt" TIMESTAMP(3),
     "claimToken" TEXT,
     "attempts" INTEGER NOT NULL DEFAULT 0,
     "lastError" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE TABLE IF NOT EXISTS "InboundQboEvent" (
     "id" TEXT NOT NULL,
     "realmId" TEXT NOT NULL,
     "eventId" TEXT NOT NULL,
     "entity" TEXT NOT NULL,
     "entityQboId" TEXT NOT NULL,
     "payload" JSONB NOT NULL,
     "processedAt" TIMESTAMP(3),
     "claimedAt" TIMESTAMP(3),
     "claimToken" TEXT,
     "attempts" INTEGER NOT NULL DEFAULT 0,
     "lastError" TEXT,
     CONSTRAINT "InboundQboEvent_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE TABLE IF NOT EXISTS "AlignmentFinding" (
     "id" TEXT NOT NULL,
     "paymentScheduleId" TEXT NOT NULL,
     "qbInvoiceId" TEXT NOT NULL,
     "kind" TEXT NOT NULL,
     "detail" JSONB NOT NULL,
     "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "lastRunId" TEXT NOT NULL,
     "resolvedAt" TIMESTAMP(3),
     "reopenedCount" INTEGER NOT NULL DEFAULT 0,
     CONSTRAINT "AlignmentFinding_pkey" PRIMARY KEY ("id")
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS "SendAttempt_sendRequestId_key" ON "SendAttempt" ("sendRequestId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SendAttempt_resendEmailId_key" ON "SendAttempt" ("resendEmailId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "EmailEvent_svixId_key" ON "EmailEvent" ("svixId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "InboundQboEvent_realmId_eventId_key" ON "InboundQboEvent" ("realmId", "eventId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AlignmentFinding_paymentScheduleId_qbInvoiceId_kind_key"
     ON "AlignmentFinding" ("paymentScheduleId", "qbInvoiceId", "kind")`,
  `CREATE INDEX IF NOT EXISTS "InvoiceViewEvent_invoiceId_viewedAt_idx" ON "InvoiceViewEvent" ("invoiceId", "viewedAt")`,
  `CREATE INDEX IF NOT EXISTS "SendAttempt_invoiceId_createdAt_idx" ON "SendAttempt" ("invoiceId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "SendAttempt_status_createdAt_idx" ON "SendAttempt" ("status", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "SendAttemptMilestone_paymentScheduleId_idx" ON "SendAttemptMilestone" ("paymentScheduleId")`,
  `CREATE INDEX IF NOT EXISTS "EmailEvent_resendEmailId_processedAt_idx" ON "EmailEvent" ("resendEmailId", "processedAt")`,
  `CREATE INDEX IF NOT EXISTS "EmailEvent_processedAt_claimedAt_idx" ON "EmailEvent" ("processedAt", "claimedAt")`,
  `CREATE INDEX IF NOT EXISTS "InboundQboEvent_processedAt_claimedAt_idx" ON "InboundQboEvent" ("processedAt", "claimedAt")`,
  `CREATE INDEX IF NOT EXISTS "AlignmentFinding_resolvedAt_lastSeenAt_idx" ON "AlignmentFinding" ("resolvedAt", "lastSeenAt")`,

  `DO $$ BEGIN
     ALTER TABLE "InvoiceViewEvent" ADD CONSTRAINT "InvoiceViewEvent_invoiceId_fkey"
       FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "SendAttempt" ADD CONSTRAINT "SendAttempt_invoiceId_fkey"
       FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "SendAttemptMilestone" ADD CONSTRAINT "SendAttemptMilestone_sendAttemptId_fkey"
       FOREIGN KEY ("sendAttemptId") REFERENCES "SendAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "SendAttemptMilestone" ADD CONSTRAINT "SendAttemptMilestone_paymentScheduleId_fkey"
       FOREIGN KEY ("paymentScheduleId") REFERENCES "PaymentSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "AlignmentFinding" ADD CONSTRAINT "AlignmentFinding_paymentScheduleId_fkey"
       FOREIGN KEY ("paymentScheduleId") REFERENCES "PaymentSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // These server-owned inbox/projection tables are not exposed through the
  // Supabase Data API. The app's trusted Prisma connection remains the writer.
  `ALTER TABLE "InvoiceViewEvent" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "SendAttempt" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "SendAttemptMilestone" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "EmailEvent" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "InboundQboEvent" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "AlignmentFinding" ENABLE ROW LEVEL SECURITY`,
  `DO $$
   DECLARE role_name TEXT;
   BEGIN
     FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
       IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
         EXECUTE format(
           'REVOKE ALL ON TABLE "InvoiceViewEvent", "SendAttempt", "SendAttemptMilestone", "EmailEvent", "InboundQboEvent", "AlignmentFinding" FROM %I',
           role_name
         );
       END IF;
     END LOOP;
   END $$`,

  // W2 legacy-view backfill. The deterministic id + NOT EXISTS predicate make
  // this safe to re-run. Existing viewedAt is the only historical observation,
  // so every milestone on that legacy invoice receives the same projection.
  `INSERT INTO "InvoiceViewEvent" ("id", "invoiceId", "viewedAt", "source")
   SELECT 'ive_backfill_' || md5(i."id"), i."id", i."viewedAt", 'legacy_backfill'
   FROM "Invoice" i
   WHERE i."viewedAt" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "InvoiceViewEvent" e
       WHERE e."invoiceId" = i."id" AND e."viewedAt" = i."viewedAt"
     )`,
  `UPDATE "Invoice"
   SET "viewCount" = GREATEST("viewCount", 1),
       "lastViewedAt" = COALESCE("lastViewedAt", "viewedAt")
   WHERE "viewedAt" IS NOT NULL`,
  `UPDATE "PaymentSchedule" p
   SET "firstViewedAt" = COALESCE(p."firstViewedAt", i."viewedAt"),
       "lastViewedAt" = COALESCE(p."lastViewedAt", i."viewedAt")
   FROM "Invoice" i
   WHERE p."invoiceId" = i."id" AND i."viewedAt" IS NOT NULL`,

  // W6 canonical status backfill. issueDate is the best surviving evidence for
  // legacy milestone sends whose Invoice.sentAt was never stamped.
  `UPDATE "Invoice" SET "sentAt" = "issueDate"
   WHERE "issueDate" IS NOT NULL AND "sentAt" IS NULL`,
  `UPDATE "Invoice" i
   SET "status" = CASE
     WHEN i."status" = 'Canceled' THEN 'Canceled'
     WHEN i."balanceDue" <= 0 OR (
       EXISTS (
         SELECT 1 FROM "PaymentSchedule" p
         WHERE p."invoiceId" = i."id" AND p."status" <> 'Canceled'
       )
       AND NOT EXISTS (
         SELECT 1 FROM "PaymentSchedule" p
         WHERE p."invoiceId" = i."id" AND p."status" NOT IN ('Paid', 'Canceled')
       )
     ) THEN 'Paid'
     WHEN EXISTS (
       SELECT 1 FROM "PaymentSchedule" p
       WHERE p."invoiceId" = i."id" AND p."status" = 'Paid'
     ) THEN 'Partially Paid'
     WHEN i."issueDate" IS NOT NULL OR i."sentAt" IS NOT NULL THEN 'Issued'
     ELSE 'Draft'
   END`,
  `DO $$ BEGIN
     ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_status_check"
       CHECK ("status" IN ('Draft', 'Issued', 'Partially Paid', 'Paid', 'Canceled'));
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("applied:", sql.split("\n")[0]);
  }
  console.log("Invoice lifecycle migration complete.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
