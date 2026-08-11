// One-off additive migration for the Permits feature (per-project permit CRUD).
// Safe to re-run while the previous build is live.
//
// Run only through the release orchestrator:
//   node scripts/apply-permits-schema.mjs
//
// Do not run this during implementation handoff. The new Prisma client uses
// Permit immediately, so this schema must be applied before deploy.
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
  `CREATE TABLE IF NOT EXISTS "Permit" (
     "id" TEXT PRIMARY KEY,
     "projectId" TEXT NOT NULL,
     "permitNumber" TEXT NOT NULL,
     "type" TEXT,
     "status" TEXT NOT NULL DEFAULT 'applied',
     "issuingAuthority" TEXT,
     "issueDate" TIMESTAMP(3),
     "expirationDate" TIMESTAMP(3),
     "notes" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'Permit_projectId_fkey'
         AND conrelid = '"Permit"'::regclass
     ) THEN
       ALTER TABLE "Permit"
         ADD CONSTRAINT "Permit_projectId_fkey"
         FOREIGN KEY ("projectId") REFERENCES "Project"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "Permit_projectId_idx" ON "Permit"("projectId")`,

  // This table is server-only. RLS with no policies makes the exposed
  // Supabase Data API deny anon/authenticated access. Prisma connects as the
  // database owner through the server-only pooler and is not subject to RLS
  // unless FORCE ROW LEVEL SECURITY is enabled (this script does not force it).
  `ALTER TABLE "Permit" ENABLE ROW LEVEL SECURITY`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("applied:", sql.split("\n")[0]);
  }
  console.log("Permit schema applied successfully.");
} finally {
  await prisma.$disconnect();
}
