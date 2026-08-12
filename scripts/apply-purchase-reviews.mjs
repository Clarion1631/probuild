// One-off additive migration for the Vanessa review loop (Goal 2 / 2b).
// Creates the append-only PurchaseReview table and adds the nullable
// qboCreateTime column to Expense. Safe to re-run while the old build is
// live: CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS only, no existing
// data is touched.
//
//   node scripts/apply-purchase-reviews.mjs
//
// Apply BEFORE deploying the build that selects qboCreateTime or writes
// PurchaseReview rows (P2022 otherwise).
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
  `CREATE TABLE IF NOT EXISTS "PurchaseReview" (
     "id"            TEXT NOT NULL,
     "qboPurchaseId" TEXT NOT NULL,
     "qboSyncToken"  TEXT NOT NULL,
     "reviewerId"    TEXT NOT NULL,
     "reviewerName"  TEXT NOT NULL,
     "reviewedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "PurchaseReview_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReview_qboPurchaseId_qboSyncToken_key" ON "PurchaseReview"("qboPurchaseId", "qboSyncToken")`,
  `CREATE INDEX IF NOT EXISTS "PurchaseReview_qboPurchaseId_idx" ON "PurchaseReview"("qboPurchaseId")`,
  `ALTER TABLE "PurchaseReview" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "qboCreateTime" TIMESTAMP(3)`,
];

for (const sql of statements) {
  console.log(sql.split("\n")[0].trim() + " ...");
  await prisma.$executeRawUnsafe(sql);
}
console.log("PurchaseReview + Expense.qboCreateTime schema applied.");
await prisma.$disconnect();
