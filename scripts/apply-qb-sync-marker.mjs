// Durable in-flight marker for the document sync rail
// (Codex round-38 gate, finding 5):
//
//   Estimate.qbSyncMarker  \
//   Invoice.qbSyncMarker   /  same vocabulary as PaymentSchedule.qbSyncError
//                             (src/lib/qbo-create-markers.ts):
//                             create-in-flight -> ambiguous-create
//
// /api/quickbooks/sync created a QuickBooks estimate or invoice, returned its
// id, and persisted nothing. A 503 that told the caller "retry: false" is only
// advice: a refresh re-POSTed and QuickBooks got a second document for the same
// record, with nothing in ProBuild pointing at either. The marker is written
// BEFORE the POST so a crash between the request and the write is visible, and
// the id is persisted in the same write that clears it.
//
// ADD COLUMN IF NOT EXISTS only — idempotent, no drops, safe to re-run and
// safe while the previous build is live. Run BEFORE deploying the build that
// selects it, per CLAUDE.md "Schema migrations" (no `prisma db push` /
// `migrate dev` here — DIRECT_URL is IPv6-only from this machine). Then
// regenerate the client from PowerShell.
//
//   node scripts/apply-qb-sync-marker.mjs
//
// The identical DDL is checked in at
// prisma/migrations/20260903120000_qb_sync_marker/migration.sql, which is what
// CI's throwaway database is built from.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STATEMENTS = [
    `ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "qbSyncMarker" TEXT`,
    `ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "qbSyncMarker" TEXT`,
];

export const EXPECTED = [
    { table: "Estimate", column: "qbSyncMarker" },
    { table: "Invoice", column: "qbSyncMarker" },
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
        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
            console.log("ok:", sql.split("\n")[0].trim());
        }
        const missing = [];
        for (const { table, column } of EXPECTED) {
            const cols = await prisma.$queryRawUnsafe(
                `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`
            );
            const present = new Set(cols.map((c) => c.column_name));
            if (!present.has(column)) missing.push(`${table}.${column}`);
        }
        console.log(
            `verified ${EXPECTED.length - missing.length}/${EXPECTED.length} column(s) present`,
            missing.length ? `— MISSING: ${missing.join(", ")}` : ""
        );
        if (missing.length) process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
