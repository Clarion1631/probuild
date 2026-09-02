// One-off additive migration for the payment-notification outbox
// (model PaymentNotification in prisma/schema.prisma, drained by
// src/lib/payment-outbox.ts). This script should have shipped with the model:
// prod was missing the table until 2026-07-23 and every settle that enqueued a
// milestone_paid notification rolled back with "table does not exist". The
// table was created manually in prod that day — running this again is a no-op.
// Safe to run against the live DB while the deployed (old) client is in use.
// Mirrors scripts/apply-schedule-provenance-schema.mjs.
//
// Run:  node scripts/apply-payment-notification-schema.mjs
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

const statements = [
  `CREATE TABLE IF NOT EXISTS "PaymentNotification" (
     "id" TEXT NOT NULL,
     "scheduleId" TEXT NOT NULL,
     "scheduleType" TEXT NOT NULL,
     "kind" TEXT NOT NULL DEFAULT 'milestone_paid',
     "status" TEXT NOT NULL DEFAULT 'PENDING',
     "attempts" INTEGER NOT NULL DEFAULT 0,
     "lastError" TEXT,
     "claimToken" TEXT,
     "processingStartedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "processedAt" TIMESTAMP(3),
     CONSTRAINT "PaymentNotification_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "PaymentNotification_status_idx" ON "PaymentNotification" ("status")`,
  `CREATE INDEX IF NOT EXISTS "PaymentNotification_scheduleId_idx" ON "PaymentNotification" ("scheduleId")`,
];

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

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
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
