// Additive schema for auto-assign provenance
// (src/lib/crew-auto-assign-sync.ts):
//   ProjectCrewAutoLink   Row exists iff the auto-assign sync (not a manual
//                         Team Access connection) put this user on this
//                         project's crew. Lets the sync revoke only what it
//                         added, when the user becomes ineligible or the
//                         project leaves the auto-assign statuses, without
//                         ever touching a manually-curated crew connection.
//
// Backfill inserts a row for every existing Project.crew pair that the sync
// would have created itself: an In Progress/Open/Active project, crewed by a
// user who is currently dispatchable (showOnDispatch true, ACTIVATED, role
// != FINANCE). Everything else already on a crew (manual connections,
// currently-ineligible users) is left with no row, i.e. treated as manual
// and never auto-revoked.
//
// CREATE TABLE IF NOT EXISTS + guarded FKs only -- idempotent, no drops, safe
// while the previous build is live (the old build simply ignores the new
// table). Run BEFORE deploying the site build that reads it, per CLAUDE.md
// "Schema migrations" (no `prisma db push` / `migrate dev` here -- DIRECT_URL
// is IPv6-only). Then regenerate the client from PowerShell.
//   node scripts/apply-project-crew-auto-link.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.production.local") });
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (.env.production.local missing? see card t_275a9e4d — restore from gtr-probuild-ledger).");
    process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS "ProjectCrewAutoLink" (
        "projectId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ProjectCrewAutoLink_pkey" PRIMARY KEY ("projectId", "userId")
    )`,
    `DO $$ BEGIN
        ALTER TABLE "ProjectCrewAutoLink" ADD CONSTRAINT "ProjectCrewAutoLink_projectId_fkey"
            FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`,
    `DO $$ BEGIN
        ALTER TABLE "ProjectCrewAutoLink" ADD CONSTRAINT "ProjectCrewAutoLink_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`,
];

try {
    for (const sql of STATEMENTS) {
        await prisma.$executeRawUnsafe(sql);
        console.log("ok:", sql.split("\n")[0].trim());
    }

    const backfilled = await prisma.$executeRawUnsafe(`
        INSERT INTO "ProjectCrewAutoLink" ("projectId", "userId", "createdAt")
        SELECT ca."A", ca."B", CURRENT_TIMESTAMP
        FROM "_CrewAssignments" ca
        JOIN "Project" p ON p."id" = ca."A"
        JOIN "User" u ON u."id" = ca."B"
        WHERE p."status" IN ('In Progress', 'Open', 'Active')
          AND u."showOnDispatch" = true
          AND u."status" = 'ACTIVATED'
          AND u."role" != 'FINANCE'
        ON CONFLICT ("projectId", "userId") DO NOTHING
    `);
    console.log(`backfilled ${backfilled} auto-link row(s) for existing eligible crew pairs on In Progress/Open/Active projects`);

    const [{ count }] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM "ProjectCrewAutoLink"`
    );
    console.log(`verified: "ProjectCrewAutoLink" now holds ${count} row(s) total`);

    const tableCheck = await prisma.$queryRawUnsafe(
        `SELECT table_name FROM information_schema.tables WHERE table_name = 'ProjectCrewAutoLink'`
    );
    console.log(`verified ${tableCheck.length}/1 table present:`, tableCheck.map((t) => t.table_name).join(", "));
    if (tableCheck.length !== 1) process.exit(1);
} finally {
    await prisma.$disconnect();
}
