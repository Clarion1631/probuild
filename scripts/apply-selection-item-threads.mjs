// One-off additive migration for Selection Item Discussion Threads
// (docs/superpowers/plans/2026-07-30-selection-item-threads.md, Phase 1).
// Safe to re-run while the previous build is live — every statement is
// idempotent (IF NOT EXISTS / guarded DO $$ blocks). Additive DDL only — no
// deletes, no drops, no destructive rewrites.
//
// Run BEFORE deploying the build that ships this schema (see the pre-deploy
// checklist in CLAUDE.md):
//   node scripts/apply-selection-item-threads.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const statements = [
    `CREATE TABLE IF NOT EXISTS "SelectionItemComment" (
        "id" TEXT PRIMARY KEY,
        "proposalId" TEXT NOT NULL,
        "authorType" TEXT NOT NULL,
        "authorUserId" TEXT,
        "authorClientId" TEXT,
        "authorName" TEXT NOT NULL,
        "body" TEXT NOT NULL,
        "attachments" TEXT,
        "readByTeamAt" TIMESTAMP(3),
        "readByClientAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `DO $$ BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'SelectionItemComment_proposalId_fkey'
              AND conrelid = '"SelectionItemComment"'::regclass
        ) THEN
            ALTER TABLE "SelectionItemComment"
                ADD CONSTRAINT "SelectionItemComment_proposalId_fkey"
                FOREIGN KEY ("proposalId") REFERENCES "SelectionProposal"("id")
                ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
    END $$`,
    `CREATE INDEX IF NOT EXISTS "SelectionItemComment_proposalId_createdAt_idx" ON "SelectionItemComment" ("proposalId", "createdAt")`,
    // Supports the unread nav-badge counts (getUnreadSelectionThreadCountForStaff
    // / ForPortal), which filter on authorType + the viewer-side read
    // timestamp before joining to the proposal's projectId.
    `CREATE INDEX IF NOT EXISTS "SelectionItemComment_authorType_readByTeamAt_idx" ON "SelectionItemComment" ("authorType", "readByTeamAt")`,
    `CREATE INDEX IF NOT EXISTS "SelectionItemComment_authorType_readByClientAt_idx" ON "SelectionItemComment" ("authorType", "readByClientAt")`,
    // Server-only table. RLS with no policies denies direct anon/authenticated
    // Data API access; server-side Prisma uses the owner role. Matches the
    // convention in scripts/apply-selections-playground.mjs.
    `ALTER TABLE "SelectionItemComment" ENABLE ROW LEVEL SECURITY`,
];

async function main() {
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    try {
        for (const sql of statements) {
            await prisma.$executeRawUnsafe(sql);
            console.log("OK:", sql.split("\n")[0].slice(0, 80));
        }
        console.log("\nSelection item threads schema applied successfully.");
    } catch (e) {
        console.error("Migration failed:", e);
        process.exit(1);
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
