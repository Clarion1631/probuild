// One-off additive migration for the PDF contract imports.
// Adds originalPdfPath column to Contract table.
//
// Run:  node scripts/apply-pdf-contracts-schema.mjs
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
  `ALTER TABLE "Contract" ADD COLUMN IF NOT EXISTS "originalPdfPath" TEXT`,
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
