// One-off additive migration for cost-plus & milestone change orders
// (.specs/PB-pipeline-004-cost-plus-change-orders.md).
// Executes migrations/004_cost_plus_change_orders.sql statement-by-statement.
// Safe to run against the live DB while the deployed (old) client is in use:
// columns/indexes use IF NOT EXISTS and FKs are guarded via pg_constraint.
// Mirrors scripts/apply-schedule-provenance-schema.mjs.
//
// Run:  node scripts/apply-cost-plus-change-orders.mjs
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

const sqlFile = fs.readFileSync(new URL("../migrations/004_cost_plus_change_orders.sql", import.meta.url), "utf8");

// Split into individual statements: everything before the DO block splits on
// ";", the DO $$ ... $$ block (which contains semicolons) runs as one statement.
const doIndex = sqlFile.indexOf("DO $$");
if (doIndex === -1) throw new Error("expected DO $$ block in migration file");
const plain = sqlFile
  .slice(0, doIndex)
  .split(";")
  .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
  .filter(Boolean);
const doBlock = sqlFile.slice(doIndex).trim().replace(/;\s*$/, "");
const statements = [...plain, doBlock];

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
