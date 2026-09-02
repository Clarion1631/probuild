// One-off additive migration for the collaborative client mood board feature
// (portal add/move/delete mood-board items). Adds MoodBoardItem.addedByClient
// so client-added items can be told apart from staff-added ones and protected
// from being clobbered by a stale staff full-save.
// Safe to run against the live DB while the deployed (old) client is in use:
// the column uses IF NOT EXISTS. Mirrors scripts/apply-cost-plus-change-orders.mjs.
//
// Run:  node scripts/apply-moodboard-client-collab.mjs
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
  `ALTER TABLE "MoodBoardItem" ADD COLUMN IF NOT EXISTS "addedByClient" BOOLEAN NOT NULL DEFAULT false;`,
];

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

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
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
