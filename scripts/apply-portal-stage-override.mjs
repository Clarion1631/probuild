// One-off additive migration for the portal project-route stage override.
// Adds Project.portalStageOverride so staff can pin the current stage shown
// on the client portal tracker when the schedule's keyword inference lags
// reality. Null (the default) keeps the existing task-derived behavior.
// Safe to run against the live DB while the deployed (old) client is in use:
// the column uses IF NOT EXISTS. Mirrors scripts/apply-moodboard-client-collab.mjs.
//
// Run:  node scripts/apply-portal-stage-override.mjs
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
  `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "portalStageOverride" TEXT;`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("✔ applied:", sql.split("\n")[0].slice(0, 90));
  }
  console.log(`Done. ${statements.length} statements applied.`);
} catch (e) {
  console.error("Migration failed:", e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
