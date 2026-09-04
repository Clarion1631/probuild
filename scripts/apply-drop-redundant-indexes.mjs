// Drop three redundant single-column indexes from production.
//
// Each is fully covered by a wider B-tree index on the same table that LEADS
// with the same column, so every lookup the narrow index served is still
// served; what goes away is the write overhead of maintaining a second copy of
// the same leading key.
//
//   DecisionTemplateItem_templateId_idx          covered by (templateId, order)
//   ChatDelivery_publicationId_idx               covered by the unique
//                                                (publicationId, destination, kind)
//   DispatchPublicationChange_publicationId_idx  covered by the unique
//                                                (publicationId, position)
//
// PR #370 adopted these into schema.prisma because prod genuinely had them;
// Codex flagged them as redundant in that review. This is the deliberate
// cleanup, with schema.prisma updated in the same change.
//
// DROP INDEX IF EXISTS only — idempotent, safe to re-run, safe while the
// previous build is live (an index the planner no longer finds is not an
// error). Run BEFORE deploying the build that stops declaring them, per
// CLAUDE.md "Schema migrations" (no `prisma db push` / `migrate dev` here —
// DIRECT_URL is IPv6-only from this machine).
//
//   node scripts/apply-drop-redundant-indexes.mjs
//
// The identical DDL is checked in at
// prisma/migrations/20260904000000_drop_redundant_indexes/migration.sql, which
// is what CI's throwaway database is built from. After CI is green, record it
// in prod's history: `prisma migrate resolve --applied 20260904000000_drop_redundant_indexes`
// (over the session pooler — see the probuild-schema-migration skill).
//
// NOT covered here, on purpose: everything else the original "residual drift"
// task listed (Project_managerId_fkey, Project_leadId RESTRICT, the three
// missing indexes, the ON UPDATE alignment) was already closed by
// 20260814120000_missing_fk_indexes / scripts/apply-missing-fk-indexes.mjs on
// 2026-08-17. Do not re-add it.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STATEMENTS = [
    `DROP INDEX IF EXISTS "DecisionTemplateItem_templateId_idx"`,
    `DROP INDEX IF EXISTS "ChatDelivery_publicationId_idx"`,
    `DROP INDEX IF EXISTS "DispatchPublicationChange_publicationId_idx"`,
];

export const DROPPED_INDEXES = [
    "DecisionTemplateItem_templateId_idx",
    "ChatDelivery_publicationId_idx",
    "DispatchPublicationChange_publicationId_idx",
];

// The covering indexes that make the drops safe. Verified present before the
// drops run so a database where one of these is somehow missing is refused
// rather than left with NO index on the leading column.
export const COVERING_INDEXES = [
    "DecisionTemplateItem_templateId_order_idx",
    "ChatDelivery_pub_dest_kind_key",
    "DispatchChange_pub_position_key",
];

// Every side effect lives in here and runs ONLY behind the main-module guard
// below, so importing this module to read its exported SQL never opens a
// connection or mutates anything (the 2026-09-02 incident).
async function main() {
    config({ path: join(__dirname, "..", ".env.production.local") });
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL is not set (.env.production.local missing?).");
        process.exit(1);
    }

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    try {
        const present = new Set(
            (await prisma.$queryRawUnsafe(
                `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
                [...COVERING_INDEXES, ...DROPPED_INDEXES]
            )).map((r) => r.indexname)
        );
        const missingCover = COVERING_INDEXES.filter((name) => !present.has(name));
        if (missingCover.length) {
            console.error(`refusing to drop: covering index(es) missing — ${missingCover.join(", ")}`);
            process.exitCode = 1;
            return; // fall through to finally so the client disconnects cleanly
        }

        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
            console.log("ok:", sql);
        }

        const after = new Set(
            (await prisma.$queryRawUnsafe(
                `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
                DROPPED_INDEXES
            )).map((r) => r.indexname)
        );
        const stillThere = DROPPED_INDEXES.filter((name) => after.has(name));
        console.log(
            `verified ${DROPPED_INDEXES.length - stillThere.length}/${DROPPED_INDEXES.length} index(es) gone`,
            stillThere.length ? `— STILL PRESENT: ${stillThere.join(", ")}` : ""
        );
        if (stillThere.length) process.exitCode = 1;
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
