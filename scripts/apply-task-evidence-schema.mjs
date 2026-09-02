// One-off additive migration for punch-item completion evidence.
// Adds TaskPunchItem.completedAt so a punch-item completion can be used as
// dated evidence. Safe to re-run while the old build is live.
//
// Run only through the release orchestrator:
//   node scripts/apply-task-evidence-schema.mjs
//
// Do not run this during implementation handoff. The new Prisma client selects
// TaskPunchItem.completedAt immediately, so the schema must be applied before deploy.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const statements = [
  // Backfill nothing: existing completed items keep a NULL completedAt. We do not know
  // when they were actually completed, and inventing a date would fabricate evidence.
  `ALTER TABLE "TaskPunchItem"
     ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3)`,
  // RLS is table-level, so the new column needs no policy of its own — but no
  // migration in this repo ever enabled RLS on TaskPunchItem, unlike the
  // comparable server-only TaskMaterial (apply-task-materials-schema.mjs).
  // Enabling it is idempotent and closes that gap. All access is server-side
  // through Prisma with the service role, which bypasses RLS, so no policy is
  // required for the app to keep working.
  `ALTER TABLE "TaskPunchItem" ENABLE ROW LEVEL SECURITY`,
];

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: resolveDatabaseUrl() } },
  });

  try {
    for (const sql of statements) {
      await prisma.$executeRawUnsafe(sql);
      console.log("✔ applied:", sql.split("\n")[0]);
    }
    console.log("Done.");
  } catch (error) {
    console.error("Migration failed:", error);
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
