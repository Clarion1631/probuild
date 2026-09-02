// Additive schema for the per-member dispatch roster switch
// (src/lib/dispatch-roster.ts):
//   User.showOnDispatch   Appears on the dispatch board bench/grid.
//                         Owner-controlled on Company → Team members.
//
// Backfill preserves current dispatch-roster membership (FIELD_CREW,
// ACTIVATED) so existing crews don't vanish from the board the moment this
// ships. MANAGER/ADMIN accounts that used to be dispatchable by role
// (Richard, CJ) are left off — the owner opts them in explicitly.
//
// ADD COLUMN IF NOT EXISTS only — idempotent, no drops, safe while the
// previous build is live (the old build simply ignores the new column). Run
// BEFORE deploying the site build that reads it, per CLAUDE.md "Schema
// migrations" (no `prisma db push` / `migrate dev` here — DIRECT_URL is
// IPv6-only). Then regenerate the client from PowerShell.
//   node scripts/apply-show-on-dispatch.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATEMENTS = [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "showOnDispatch" BOOLEAN NOT NULL DEFAULT false`,
];

async function main() {
    config({ path: join(__dirname, "..", ".env.production.local") });
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL is not set (.env.production.local missing? see card t_275a9e4d — restore from gtr-probuild-ledger).");
        process.exit(1);
    }

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    try {
        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
            console.log("ok:", sql);
        }
        const backfilled = await prisma.$executeRawUnsafe(
            `UPDATE "User" SET "showOnDispatch" = true WHERE "role" = 'FIELD_CREW' AND "status" = 'ACTIVATED' AND "showOnDispatch" = false`
        );
        console.log(`backfilled ${backfilled} FIELD_CREW/ACTIVATED user(s) to showOnDispatch = true`);
        const cols = await prisma.$queryRawUnsafe(
            `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_name = 'User' AND column_name = 'showOnDispatch'`
        );
        console.log(`verified ${cols.length}/1 columns present:`, cols.map((c) => `${c.table_name}.${c.column_name}`).join(", "));
        if (cols.length !== 1) process.exit(1);
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
