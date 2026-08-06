// One-off additive migration for the deposit auto-apply pipeline (Phase B1)
// (model DepositIngest in prisma/schema.prisma, driven by
// src/app/api/payments/deposit-ingest/route.ts). Mirrors
// scripts/apply-payment-notification-schema.mjs.
//
// Includes the partial reservation index Prisma cannot express: a unique
// index on paymentScheduleId scoped to the "in flight or done" statuses, so
// two different deposit files can never both claim the same pending
// milestone (the loser's insert/update hits the unique violation and the
// route maps that to an "unmatched" outcome).
//
// Run:  node scripts/apply-deposit-ingest-schema.mjs
// (DDL via $executeRawUnsafe over the Supabase transaction pooler — the working
//  path in this project; psql / prisma db push / migrate dev do not work here.)
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env", ".env.local"]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

const statements = [
  `CREATE TABLE IF NOT EXISTS "DepositIngest" (
     "id" TEXT NOT NULL,
     "fileId" TEXT NOT NULL,
     "status" TEXT NOT NULL,
     "extracted" TEXT NOT NULL,
     "paymentScheduleId" TEXT,
     "qbPaymentId" TEXT,
     "qbRequestPayload" TEXT,
     "officeTaskId" TEXT,
     "attempts" INTEGER NOT NULL DEFAULT 0,
     "lastError" TEXT,
     "processingStartedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "DepositIngest_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DepositIngest_fileId_key" ON "DepositIngest" ("fileId")`,
  `CREATE INDEX IF NOT EXISTS "DepositIngest_status_idx" ON "DepositIngest" ("status")`,
  `CREATE INDEX IF NOT EXISTS "DepositIngest_paymentScheduleId_idx" ON "DepositIngest" ("paymentScheduleId")`,
  // Partial reservation index — see the header comment + the matching note in
  // prisma/schema.prisma above the DepositIngest model. NOT expressible in Prisma.
  `CREATE UNIQUE INDEX IF NOT EXISTS "DepositIngest_paymentScheduleId_reservation_key"
     ON "DepositIngest" ("paymentScheduleId")
     WHERE "status" IN ('processing', 'qbo_unknown', 'qbo_created', 'applied', 'reconcile')
       AND "paymentScheduleId" IS NOT NULL`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("✔ applied:", sql.split("\n")[0]);
  }
  console.log("Done.");
} catch (e) {
  console.error("Migration failed:", e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
