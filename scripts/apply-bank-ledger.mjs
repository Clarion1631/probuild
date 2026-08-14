// One-off additive migration for the Bank Ledger (Receipt Automation Phase 1,
// docs/RECEIPT-AUTOMATION-PHASES.md "Persistence decision"): BankLine
// (durable per-transaction identity + state), BankLineItem (line-item child
// rows), RefundEvent (returns as events, linked to the original line).
//
// Additive and idempotent: pure CREATE TABLE IF NOT EXISTS / guarded FK adds,
// safe to re-run while an older build is live. No existing table is touched.
//
//   node scripts/apply-bank-ledger.mjs
//
// Apply BEFORE deploying the build that selects these tables (P2022 otherwise).
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

const url = resolveDatabaseUrl();
const prisma = new PrismaClient({ datasources: { db: { url } } });

const statements = [
    `CREATE TABLE IF NOT EXISTS "BankLine" (
       "id"                TEXT NOT NULL,
       "account"           TEXT NOT NULL,
       "postedDate"        TIMESTAMP(3) NOT NULL,
       "amountCents"       INTEGER NOT NULL,
       "rawDescriptor"     TEXT NOT NULL,
       "normalizedPayee"   TEXT NOT NULL,
       "checkNumber"       TEXT,
       "source"            TEXT NOT NULL,
       "statementId"       TEXT,
       "lineHash"          TEXT NOT NULL,
       "state"             TEXT NOT NULL DEFAULT 'POSTED',
       "exceptionReason"   TEXT,
       "qbTxnId"           TEXT,
       "qbBankMatched"     BOOLEAN NOT NULL DEFAULT false,
       "probuildExpenseId" TEXT,
       "projectName"       TEXT,
       "projectValidated"  BOOLEAN NOT NULL DEFAULT false,
       "receiptUrl"        TEXT,
       "taxValidated"      BOOLEAN NOT NULL DEFAULT false,
       "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"         TIMESTAMP(3) NOT NULL,
       CONSTRAINT "BankLine_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "BankLine_lineHash_key" ON "BankLine" ("lineHash")`,
    `CREATE INDEX IF NOT EXISTS "BankLine_account_postedDate_idx" ON "BankLine" ("account", "postedDate")`,
    `CREATE INDEX IF NOT EXISTS "BankLine_qbTxnId_idx" ON "BankLine" ("qbTxnId")`,
    // Server-only table accessed exclusively through Prisma with the service
    // role (which bypasses RLS) — same posture as AutomationEvent/TaskMaterial.
    `ALTER TABLE "BankLine" ENABLE ROW LEVEL SECURITY`,

    `CREATE TABLE IF NOT EXISTS "BankLineItem" (
       "id"             TEXT NOT NULL,
       "bankLineId"     TEXT NOT NULL,
       "description"    TEXT NOT NULL,
       "qty"            DECIMAL(65,30),
       "unitPriceCents" INTEGER,
       "lineTotalCents" INTEGER,
       "source"         TEXT NOT NULL,
       "jobHint"        TEXT,
       "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "BankLineItem_pkey" PRIMARY KEY ("id")
     )`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'BankLineItem_bankLineId_fkey'
           AND conrelid = '"BankLineItem"'::regclass
       ) THEN
         ALTER TABLE "BankLineItem"
           ADD CONSTRAINT "BankLineItem_bankLineId_fkey"
           FOREIGN KEY ("bankLineId") REFERENCES "BankLine"("id")
           ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,
    `CREATE INDEX IF NOT EXISTS "BankLineItem_bankLineId_idx" ON "BankLineItem" ("bankLineId")`,
    `ALTER TABLE "BankLineItem" ENABLE ROW LEVEL SECURITY`,

    `CREATE TABLE IF NOT EXISTS "RefundEvent" (
       "id"                 TEXT NOT NULL,
       "originalBankLineId" TEXT,
       "refundBankLineId"   TEXT,
       "vendorRefundRef"    TEXT,
       "amountCents"        INTEGER NOT NULL,
       "taxCents"           INTEGER NOT NULL DEFAULT 0,
       "status"             TEXT NOT NULL DEFAULT 'EXPECTED',
       "notes"              TEXT,
       "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"          TIMESTAMP(3) NOT NULL,
       CONSTRAINT "RefundEvent_pkey" PRIMARY KEY ("id")
     )`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'RefundEvent_originalBankLineId_fkey'
           AND conrelid = '"RefundEvent"'::regclass
       ) THEN
         ALTER TABLE "RefundEvent"
           ADD CONSTRAINT "RefundEvent_originalBankLineId_fkey"
           FOREIGN KEY ("originalBankLineId") REFERENCES "BankLine"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'RefundEvent_refundBankLineId_fkey'
           AND conrelid = '"RefundEvent"'::regclass
       ) THEN
         ALTER TABLE "RefundEvent"
           ADD CONSTRAINT "RefundEvent_refundBankLineId_fkey"
           FOREIGN KEY ("refundBankLineId") REFERENCES "BankLine"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,
    `CREATE INDEX IF NOT EXISTS "RefundEvent_originalBankLineId_idx" ON "RefundEvent" ("originalBankLineId")`,
    `CREATE INDEX IF NOT EXISTS "RefundEvent_refundBankLineId_idx" ON "RefundEvent" ("refundBankLineId")`,
    `ALTER TABLE "RefundEvent" ENABLE ROW LEVEL SECURITY`,
];

async function main() {
    console.log(`Applying to ${url.replace(/:[^:@]*@/, ":****@")}`);

    for (const sql of statements) {
        console.log(`  ${sql.replace(/\s+/g, " ").slice(0, 90)}...`);
        await prisma.$executeRawUnsafe(sql);
    }

    const [{ count }] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM information_schema.tables
          WHERE table_name IN ('BankLine', 'BankLineItem', 'RefundEvent');`,
    );
    if (count !== 3) throw new Error(`Verification failed: expected 3 bank ledger tables, found ${count}`);

    const [{ idx }] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS idx
           FROM pg_indexes
          WHERE tablename = 'BankLine' AND indexname = 'BankLine_lineHash_key';`,
    );
    if (idx !== 1) throw new Error(`Verification failed: BankLine_lineHash_key index missing`);

    console.log("BankLine / BankLineItem / RefundEvent schema applied and verified.");
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
