// One-off additive migration for PR-B1 atomic Dispatch publication.
// Adds Project.updatedAt plus the publication audit and ChatDelivery outbox
// tables. Safe to re-run while the old build is live.
//
// Run only through the release orchestrator:
//   node scripts/apply-dispatch-b1-schema.mjs
//
// Do not run this during implementation handoff. The new Prisma client selects
// Project.updatedAt immediately, so the schema must be applied before deploy.
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
  `ALTER TABLE "Project"
     ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,

  `CREATE TABLE IF NOT EXISTS "DispatchPublication" (
     "id" TEXT NOT NULL,
     "clientRequestId" TEXT NOT NULL,
     "requestHash" TEXT NOT NULL,
     "publishedById" TEXT,
     "publishedByName" TEXT NOT NULL,
     "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "DispatchPublication_pkey" PRIMARY KEY ("id"),
     CONSTRAINT "DispatchPublication_clientRequestId_key" UNIQUE ("clientRequestId")
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'DispatchPublication_clientRequestId_key'
         AND conrelid = '"DispatchPublication"'::regclass
     ) THEN
       ALTER TABLE "DispatchPublication"
         ADD CONSTRAINT "DispatchPublication_clientRequestId_key" UNIQUE ("clientRequestId");
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'DispatchPublication_publishedById_fkey'
         AND conrelid = '"DispatchPublication"'::regclass
     ) THEN
       ALTER TABLE "DispatchPublication"
         ADD CONSTRAINT "DispatchPublication_publishedById_fkey"
         FOREIGN KEY ("publishedById") REFERENCES "User"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "DispatchPublication_publishedById_idx"
     ON "DispatchPublication" ("publishedById")`,
  `CREATE INDEX IF NOT EXISTS "DispatchPublication_publishedAt_idx"
     ON "DispatchPublication" ("publishedAt")`,

  `CREATE TABLE IF NOT EXISTS "DispatchPublicationChange" (
     "id" TEXT NOT NULL,
     "publicationId" TEXT NOT NULL,
     "position" INTEGER NOT NULL,
     "projectId" TEXT NOT NULL,
     "targetType" TEXT NOT NULL,
     "targetId" TEXT NOT NULL,
     "kind" TEXT NOT NULL,
     "before" JSONB NOT NULL,
     "after" JSONB NOT NULL,
     "summary" TEXT NOT NULL,
     CONSTRAINT "DispatchPublicationChange_pkey" PRIMARY KEY ("id"),
     CONSTRAINT "DispatchChange_pub_position_key" UNIQUE ("publicationId", "position"),
     CONSTRAINT "DispatchChange_pub_target_kind_key" UNIQUE ("publicationId", "kind", "targetType", "targetId")
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'DispatchChange_pub_position_key'
         AND conrelid = '"DispatchPublicationChange"'::regclass
     ) THEN
       ALTER TABLE "DispatchPublicationChange"
         ADD CONSTRAINT "DispatchChange_pub_position_key" UNIQUE ("publicationId", "position");
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'DispatchChange_pub_target_kind_key'
         AND conrelid = '"DispatchPublicationChange"'::regclass
     ) THEN
       ALTER TABLE "DispatchPublicationChange"
         ADD CONSTRAINT "DispatchChange_pub_target_kind_key"
         UNIQUE ("publicationId", "kind", "targetType", "targetId");
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'DispatchPublicationChange_publicationId_fkey'
         AND conrelid = '"DispatchPublicationChange"'::regclass
     ) THEN
       ALTER TABLE "DispatchPublicationChange"
         ADD CONSTRAINT "DispatchPublicationChange_publicationId_fkey"
         FOREIGN KEY ("publicationId") REFERENCES "DispatchPublication"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "DispatchPublicationChange_publicationId_idx"
     ON "DispatchPublicationChange" ("publicationId")`,
  `CREATE INDEX IF NOT EXISTS "DispatchPublicationChange_projectId_idx"
     ON "DispatchPublicationChange" ("projectId")`,
  `CREATE INDEX IF NOT EXISTS "DispatchPublicationChange_targetType_targetId_idx"
     ON "DispatchPublicationChange" ("targetType", "targetId")`,

  `CREATE TABLE IF NOT EXISTS "ChatDelivery" (
     "id" TEXT NOT NULL,
     "publicationId" TEXT NOT NULL,
     "destination" TEXT NOT NULL,
     "kind" TEXT NOT NULL DEFAULT 'dispatch_publication',
     "payload" JSONB NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'PENDING',
     "attempts" INTEGER NOT NULL DEFAULT 0,
     "lastError" TEXT,
     "claimToken" TEXT,
     "processingStartedAt" TIMESTAMP(3),
     "providerMessageId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "processedAt" TIMESTAMP(3),
     CONSTRAINT "ChatDelivery_pkey" PRIMARY KEY ("id"),
     CONSTRAINT "ChatDelivery_pub_dest_kind_key" UNIQUE ("publicationId", "destination", "kind")
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ChatDelivery_pub_dest_kind_key'
         AND conrelid = '"ChatDelivery"'::regclass
     ) THEN
       ALTER TABLE "ChatDelivery"
         ADD CONSTRAINT "ChatDelivery_pub_dest_kind_key"
         UNIQUE ("publicationId", "destination", "kind");
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ChatDelivery_publicationId_fkey'
         AND conrelid = '"ChatDelivery"'::regclass
     ) THEN
       ALTER TABLE "ChatDelivery"
         ADD CONSTRAINT "ChatDelivery_publicationId_fkey"
         FOREIGN KEY ("publicationId") REFERENCES "DispatchPublication"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "ChatDelivery_publicationId_idx"
     ON "ChatDelivery" ("publicationId")`,
  `CREATE INDEX IF NOT EXISTS "ChatDelivery_status_createdAt_idx"
     ON "ChatDelivery" ("status", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ChatDelivery_status_processingStartedAt_idx"
     ON "ChatDelivery" ("status", "processingStartedAt")`,

  // These tables are server-only. RLS with no policies makes the exposed
  // Supabase Data API deny anon/authenticated access. Prisma connects as the
  // database owner through the server-only pooler and is not subject to RLS
  // unless FORCE ROW LEVEL SECURITY is enabled (this script does not force it).
  `ALTER TABLE "DispatchPublication" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "DispatchPublicationChange" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "ChatDelivery" ENABLE ROW LEVEL SECURITY`,
];

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
