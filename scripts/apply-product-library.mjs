// One-off additive migration for the Product Library / Clipper / Client Selection
// Proposals spec (docs/specs/product-library-portal-selections.md).
// Safe to re-run while the previous build is live.
//
// Run only through the release orchestrator:
//   node scripts/apply-product-library.mjs
//
// Do not run this during implementation handoff. The new Prisma client selects
// these columns/tables immediately, so schema must be applied before deploy.
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
  // ── ProjectFile.uploadedByClient ─────────────────────────────────────────
  `ALTER TABLE "ProjectFile"
     ADD COLUMN IF NOT EXISTS "uploadedByClient" BOOLEAN NOT NULL DEFAULT false`,

  // ── ProductLibraryItem ───────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "ProductLibraryItem" (
     "id" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "description" TEXT,
     "imageUrl" TEXT,
     "price" DECIMAL(12,2),
     "vendor" TEXT,
     "vendorUrl" TEXT,
     "category" TEXT,
     "source" TEXT NOT NULL DEFAULT 'clip',
     "clippedById" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL,
     CONSTRAINT "ProductLibraryItem_pkey" PRIMARY KEY ("id")
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ProductLibraryItem_clippedById_fkey'
         AND conrelid = '"ProductLibraryItem"'::regclass
     ) THEN
       ALTER TABLE "ProductLibraryItem"
         ADD CONSTRAINT "ProductLibraryItem_clippedById_fkey"
         FOREIGN KEY ("clippedById") REFERENCES "User"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "ProductLibraryItem_category_idx" ON "ProductLibraryItem" ("category")`,
  `CREATE INDEX IF NOT EXISTS "ProductLibraryItem_createdAt_idx" ON "ProductLibraryItem" ("createdAt")`,

  // ── ProjectProductFavorite ───────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "ProjectProductFavorite" (
     "id" TEXT NOT NULL,
     "projectId" TEXT NOT NULL,
     "productId" TEXT NOT NULL,
     "addedById" TEXT,
     "addedByClient" BOOLEAN NOT NULL DEFAULT false,
     "note" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ProjectProductFavorite_pkey" PRIMARY KEY ("id")
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ProjectProductFavorite_projectId_fkey'
         AND conrelid = '"ProjectProductFavorite"'::regclass
     ) THEN
       ALTER TABLE "ProjectProductFavorite"
         ADD CONSTRAINT "ProjectProductFavorite_projectId_fkey"
         FOREIGN KEY ("projectId") REFERENCES "Project"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ProjectProductFavorite_productId_fkey'
         AND conrelid = '"ProjectProductFavorite"'::regclass
     ) THEN
       ALTER TABLE "ProjectProductFavorite"
         ADD CONSTRAINT "ProjectProductFavorite_productId_fkey"
         FOREIGN KEY ("productId") REFERENCES "ProductLibraryItem"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ProjectProductFavorite_addedById_fkey'
         AND conrelid = '"ProjectProductFavorite"'::regclass
     ) THEN
       ALTER TABLE "ProjectProductFavorite"
         ADD CONSTRAINT "ProjectProductFavorite_addedById_fkey"
         FOREIGN KEY ("addedById") REFERENCES "User"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ProjectProductFavorite_projectId_productId_key'
         AND conrelid = '"ProjectProductFavorite"'::regclass
     ) THEN
       ALTER TABLE "ProjectProductFavorite"
         ADD CONSTRAINT "ProjectProductFavorite_projectId_productId_key"
         UNIQUE ("projectId", "productId");
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "ProjectProductFavorite_projectId_idx" ON "ProjectProductFavorite" ("projectId")`,

  // ── SelectionProposal ────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "SelectionProposal" (
     "id" TEXT NOT NULL,
     "projectId" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "description" TEXT,
     "imageUrl" TEXT,
     "price" DECIMAL(12,2),
     "vendorUrl" TEXT,
     "clientNote" TEXT,
     "status" TEXT NOT NULL DEFAULT 'Pending',
     "pmNote" TEXT,
     "productId" TEXT,
     "boardId" TEXT,
     "categoryId" TEXT,
     "decidedById" TEXT,
     "decidedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "SelectionProposal_pkey" PRIMARY KEY ("id")
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'SelectionProposal_projectId_fkey'
         AND conrelid = '"SelectionProposal"'::regclass
     ) THEN
       ALTER TABLE "SelectionProposal"
         ADD CONSTRAINT "SelectionProposal_projectId_fkey"
         FOREIGN KEY ("projectId") REFERENCES "Project"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'SelectionProposal_decidedById_fkey'
         AND conrelid = '"SelectionProposal"'::regclass
     ) THEN
       ALTER TABLE "SelectionProposal"
         ADD CONSTRAINT "SelectionProposal_decidedById_fkey"
         FOREIGN KEY ("decidedById") REFERENCES "User"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "SelectionProposal_projectId_status_idx" ON "SelectionProposal" ("projectId", "status")`,

  // These tables are server-only. RLS with no policies denies direct
  // anon/authenticated Data API access; server-side Prisma uses the owner role.
  `ALTER TABLE "ProductLibraryItem" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "ProjectProductFavorite" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "SelectionProposal" ENABLE ROW LEVEL SECURITY`,
];

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: resolveDatabaseUrl() } },
  });

  try {
    for (const sql of statements) {
      await prisma.$executeRawUnsafe(sql);
      console.log("applied:", sql.split("\n")[0]);
    }
    console.log("Product library schema applied successfully.");
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
