// Adds Expense.qbPurchaseId / qbSyncToken / qbSyncedAt — QBO identity columns
// for the finalized QuickBooks expense importer (migrations/20260729_qbo_expense_sync.sql).
//
// Additive and idempotent: safe to run against prod while the old build is
// live. Run this BEFORE deploying the build that selects the columns, or
// expense pages throw P2022 "column does not exist".
//
// Usage: node scripts/apply-qbo-expense-sync.mjs
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// Same resolution the sibling apply-*.mjs scripts use: env first, then the
// checked-out .env files, since these are run by hand rather than by Next.
function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env", ".env.local"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("DATABASE_URL not found in env or .env files");
}

const STATEMENTS = [
    `ALTER TABLE "Expense"
         ADD COLUMN IF NOT EXISTS "qbPurchaseId" TEXT,
         ADD COLUMN IF NOT EXISTS "qbSyncToken" TEXT,
         ADD COLUMN IF NOT EXISTS "qbSyncedAt" TIMESTAMPTZ;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Expense_qbPurchaseId_key"
         ON "Expense" ("qbPurchaseId");`,
];

async function main() {
    const url = resolveDatabaseUrl();
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        console.log(`Applying to ${url.replace(/:[^:@]*@/, ":****@")}`);

        for (const sql of STATEMENTS) {
            console.log(`  ${sql.replace(/\s+/g, " ").slice(0, 90)}...`);
            await prisma.$executeRawUnsafe(sql);
        }

        const [{ count }] = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS count
           FROM information_schema.columns
          WHERE table_name = 'Expense'
            AND column_name IN ('qbPurchaseId', 'qbSyncToken', 'qbSyncedAt');`,
        );
        if (count !== 3) throw new Error(`Verification failed: qb column count = ${count}, expected 3`);

        const [{ idx }] = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS idx
           FROM pg_indexes
          WHERE tablename = 'Expense' AND indexname = 'Expense_qbPurchaseId_key';`,
        );
        if (idx !== 1) throw new Error(`Verification failed: Expense_qbPurchaseId_key index missing`);
        console.log("qbPurchaseId/qbSyncToken/qbSyncedAt columns + unique index verified.");
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
