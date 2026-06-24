// One-off additive migration for the contract company-countersignature feature.
// Adds nullable/defaulted columns only — safe to run against the live DB while the
// deployed (old) client is in use, since it never references these columns.
//
// Run:  node scripts/apply-countersign-schema.mjs
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
  `ALTER TABLE "Contract"
     ADD COLUMN IF NOT EXISTS "requiresCountersign" BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS "companySignedBy" TEXT,
     ADD COLUMN IF NOT EXISTS "companySignedAt" TIMESTAMP(3),
     ADD COLUMN IF NOT EXISTS "companySignatureUrl" TEXT,
     ADD COLUMN IF NOT EXISTS "signedPdfPath" TEXT`,
  `ALTER TABLE "CompanySettings"
     ADD COLUMN IF NOT EXISTS "requireContractCountersign" BOOLEAN NOT NULL DEFAULT false`,
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
