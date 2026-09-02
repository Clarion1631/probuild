// One-off additive migration for the ChangeOrder company-countersignature feature.
// Adds nullable columns only — safe to run against the live DB while the deployed
// (old) client is in use, since it never references these columns. Mirrors the
// Contract countersignature migration (scripts/apply-countersign-schema.mjs).
//
// Run:  node scripts/apply-co-countersign-schema.mjs
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
  // companySignatureUrl already exists on ChangeOrder; add the two new audit columns.
  `ALTER TABLE "ChangeOrder"
     ADD COLUMN IF NOT EXISTS "companySignedBy" TEXT,
     ADD COLUMN IF NOT EXISTS "companySignedAt" TIMESTAMP(3)`,
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
