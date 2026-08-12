// One-off additive migration for the Vanessa review loop (Goal 1).
// Creates the DigestRun claim table backing the "posted yesterday" digest
// cron. Safe to re-run while the old build is live: pure CREATE IF NOT
// EXISTS, no existing table is touched.
//
//   node scripts/apply-digest-runs.mjs
//
// Apply BEFORE deploying the build that selects this table (P2022 otherwise).
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
  `CREATE TABLE IF NOT EXISTS "DigestRun" (
     "id"             TEXT NOT NULL,
     "digestDate"     TEXT NOT NULL,
     "status"         TEXT NOT NULL,
     "attempts"       INTEGER NOT NULL DEFAULT 0,
     "claimToken"     TEXT NOT NULL,
     "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
     "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "DigestRun_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DigestRun_digestDate_key" ON "DigestRun"("digestDate")`,
  // Server-only table accessed exclusively through Prisma with the service
  // role (which bypasses RLS) — same treatment as AutomationEvent.
  `ALTER TABLE "DigestRun" ENABLE ROW LEVEL SECURITY`,
];

for (const sql of statements) {
  console.log(sql.split("\n")[0].trim() + " ...");
  await prisma.$executeRawUnsafe(sql);
}
console.log("DigestRun schema applied.");
await prisma.$disconnect();
