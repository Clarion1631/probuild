// One-off additive migration for the Bank Ledger (Receipt Automation Phase 1,
// docs/RECEIPT-AUTOMATION-PHASES.md "Persistence decision" + Codex
// peer-review round-1 amendments): StatementImport (one row per ingested
// statement, content-addressed), BankLine (canonical per-transaction
// identity + state — only ever minted from a STATEMENT observation),
// BankLineObservation (one row per source sighting: a statement line or a
// QBO register row), BankLineItem (line-item child rows), RefundEvent
// (returns as events, linked to the original line).
//
// Additive and idempotent: pure CREATE TABLE IF NOT EXISTS / guarded FK and
// CHECK-constraint adds, safe to re-run while an older build is live. No
// existing table is touched. This has never been applied to any database —
// there is no prior incompatible shape to repair.
//
//   node scripts/apply-bank-ledger.mjs --yes
//
// Apply BEFORE deploying the build that selects these tables (P2022 otherwise).
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, from: "process.env.DATABASE_URL" };
    // .env.local before .env: Next.js env-file precedence is DATABASE_URL >
    // .env.local > .env, and a stale value in the less-specific file must
    // never silently win over a deliberate .env.local override.
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return { url: match[1], from: file };
    }
    throw new Error("DATABASE_URL not found in process.env, .env.local, or .env");
}

function maskUrl(url) {
    return url.replace(/:[^:@]*@/, ":****@");
}

const { url, from } = resolveDatabaseUrl();
const maskedUrl = maskUrl(url);

if (!process.argv.includes("--yes")) {
    console.error(
        `Refusing to run without --yes.\n` +
        `Target database (from ${from}): ${maskedUrl}\n` +
        `Re-run as: node scripts/apply-bank-ledger.mjs --yes`,
    );
    process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

const statements = [
    `CREATE TABLE IF NOT EXISTS "StatementImport" (
       "id"            TEXT NOT NULL,
       "account"       TEXT NOT NULL,
       "periodStart"   DATE NOT NULL,
       "periodEnd"     DATE NOT NULL,
       "openingCents"  INTEGER NOT NULL,
       "closingCents"  INTEGER NOT NULL,
       "contentHash"   TEXT NOT NULL,
       "status"        TEXT NOT NULL DEFAULT 'FINALIZED',
       "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"     TIMESTAMP(3) NOT NULL,
       CONSTRAINT "StatementImport_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "StatementImport_contentHash_key" ON "StatementImport" ("contentHash")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "StatementImport_account_periodStart_periodEnd_key" ON "StatementImport" ("account", "periodStart", "periodEnd")`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'StatementImport_status_check' AND conrelid = '"StatementImport"'::regclass
       ) THEN
         ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_status_check"
           CHECK ("status" IN ('PENDING', 'FINALIZED', 'FAILED'));
       END IF;
     END $$`,
    `ALTER TABLE "StatementImport" ENABLE ROW LEVEL SECURITY`,

    `CREATE TABLE IF NOT EXISTS "BankLine" (
       "id"                TEXT NOT NULL,
       "account"           TEXT NOT NULL,
       "postedDate"        DATE NOT NULL,
       "amountCents"       INTEGER NOT NULL,
       "rawDescriptor"     TEXT NOT NULL,
       "normalizedPayee"   TEXT NOT NULL,
       "checkNumber"       TEXT,
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
    `CREATE INDEX IF NOT EXISTS "BankLine_account_postedDate_idx" ON "BankLine" ("account", "postedDate")`,
    `CREATE INDEX IF NOT EXISTS "BankLine_qbTxnId_idx" ON "BankLine" ("qbTxnId")`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'BankLine_state_check' AND conrelid = '"BankLine"'::regclass
       ) THEN
         ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_state_check"
           CHECK ("state" IN ('POSTED', 'EVIDENCE_FOUND', 'TRANSACTION_CREATED', 'ATTACHMENT_CONFIRMED', 'MATCHED', 'JOB_CODED', 'TAX_VALIDATED', 'EXCEPTION'));
       END IF;
     END $$`,
    // Server-only table accessed exclusively through Prisma with the service
    // role (which bypasses RLS) — same posture as AutomationEvent/TaskMaterial.
    `ALTER TABLE "BankLine" ENABLE ROW LEVEL SECURITY`,

    `CREATE TABLE IF NOT EXISTS "BankLineObservation" (
       "id"                TEXT NOT NULL,
       "source"            TEXT NOT NULL,
       "account"           TEXT NOT NULL,
       "sourceDocumentId"  TEXT NOT NULL,
       "sourceLineId"      TEXT NOT NULL,
       "postedDate"        DATE NOT NULL,
       "amountCents"       INTEGER NOT NULL,
       "rawDescriptor"     TEXT NOT NULL,
       "checkNumber"       TEXT,
       "bankLineId"        TEXT,
       "statementImportId" TEXT,
       "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "BankLineObservation_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "BankLineObservation_source_account_sourceDocumentId_sourceLineId_key"
       ON "BankLineObservation" ("source", "account", "sourceDocumentId", "sourceLineId")`,
    `CREATE INDEX IF NOT EXISTS "BankLineObservation_bankLineId_idx" ON "BankLineObservation" ("bankLineId")`,
    `CREATE INDEX IF NOT EXISTS "BankLineObservation_account_postedDate_idx" ON "BankLineObservation" ("account", "postedDate")`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'BankLineObservation_source_check' AND conrelid = '"BankLineObservation"'::regclass
       ) THEN
         ALTER TABLE "BankLineObservation" ADD CONSTRAINT "BankLineObservation_source_check"
           CHECK ("source" IN ('STATEMENT', 'QBO_REGISTER'));
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'BankLineObservation_bankLineId_fkey'
           AND conrelid = '"BankLineObservation"'::regclass
       ) THEN
         ALTER TABLE "BankLineObservation"
           ADD CONSTRAINT "BankLineObservation_bankLineId_fkey"
           FOREIGN KEY ("bankLineId") REFERENCES "BankLine"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'BankLineObservation_statementImportId_fkey'
           AND conrelid = '"BankLineObservation"'::regclass
       ) THEN
         ALTER TABLE "BankLineObservation"
           ADD CONSTRAINT "BankLineObservation_statementImportId_fkey"
           FOREIGN KEY ("statementImportId") REFERENCES "StatementImport"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,
    `ALTER TABLE "BankLineObservation" ENABLE ROW LEVEL SECURITY`,

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
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'BankLineItem_source_check' AND conrelid = '"BankLineItem"'::regclass
       ) THEN
         ALTER TABLE "BankLineItem" ADD CONSTRAINT "BankLineItem_source_check"
           CHECK ("source" IN ('RECEIPT_AI', 'LOWES_CSV', 'AMAZON_APP', 'MANUAL'));
       END IF;
     END $$`,
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
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'RefundEvent_status_check' AND conrelid = '"RefundEvent"'::regclass
       ) THEN
         ALTER TABLE "RefundEvent" ADD CONSTRAINT "RefundEvent_status_check"
           CHECK ("status" IN ('EXPECTED', 'CREDIT_SEEN', 'PAIRED', 'POSTED'));
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'RefundEvent_amountCents_check' AND conrelid = '"RefundEvent"'::regclass
       ) THEN
         ALTER TABLE "RefundEvent" ADD CONSTRAINT "RefundEvent_amountCents_check"
           CHECK ("amountCents" > 0);
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'RefundEvent_taxCents_check' AND conrelid = '"RefundEvent"'::regclass
       ) THEN
         ALTER TABLE "RefundEvent" ADD CONSTRAINT "RefundEvent_taxCents_check"
           CHECK ("taxCents" >= 0 AND "taxCents" <= "amountCents");
       END IF;
     END $$`,
    `ALTER TABLE "RefundEvent" ENABLE ROW LEVEL SECURITY`,
];

// Table -> a representative subset of columns that must exist, spot-checking
// that a stale/partial table wasn't left behind by an earlier failed run —
// CREATE TABLE IF NOT EXISTS silently no-ops against an existing table of
// the wrong shape, so this is the only thing that would catch that.
const expectedColumns = {
    StatementImport: ["account", "periodStart", "periodEnd", "openingCents", "closingCents", "contentHash", "status"],
    BankLine: ["account", "postedDate", "amountCents", "normalizedPayee", "state"],
    BankLineObservation: ["source", "account", "sourceDocumentId", "sourceLineId", "postedDate", "amountCents", "bankLineId", "statementImportId"],
    BankLineItem: ["bankLineId", "description", "source"],
    RefundEvent: ["originalBankLineId", "refundBankLineId", "amountCents", "taxCents", "status"],
};

const expectedConstraints = [
    "StatementImport_contentHash_key",
    "StatementImport_account_periodStart_periodEnd_key",
    "StatementImport_status_check",
    "BankLine_state_check",
    "BankLineObservation_source_account_sourceDocumentId_sourceLineId_key",
    "BankLineObservation_source_check",
    "BankLineItem_source_check",
    "RefundEvent_status_check",
    "RefundEvent_amountCents_check",
    "RefundEvent_taxCents_check",
];

async function verifyShape() {
    for (const [table, columns] of Object.entries(expectedColumns)) {
        const rows = await prisma.$queryRaw`
            SELECT column_name FROM information_schema.columns
             WHERE table_name = ${table} AND column_name = ANY(${columns})`;
        const found = new Set(rows.map(r => r.column_name));
        const missing = columns.filter(c => !found.has(c));
        if (missing.length > 0) {
            throw new Error(`Verification failed: "${table}" is missing expected column(s): ${missing.join(", ")}`);
        }
    }

    for (const name of expectedConstraints) {
        const rows = await prisma.$queryRaw`
            SELECT 1 FROM pg_constraint WHERE conname = ${name}
            UNION ALL
            SELECT 1 FROM pg_indexes WHERE indexname = ${name}`;
        if (rows.length === 0) {
            throw new Error(`Verification failed: expected constraint/index "${name}" not found`);
        }
    }
}

async function main() {
    console.log(`Applying to ${maskedUrl} (DATABASE_URL from ${from})`);

    for (const sql of statements) {
        console.log(`  ${sql.replace(/\s+/g, " ").slice(0, 90)}...`);
        await prisma.$executeRawUnsafe(sql);
    }

    await verifyShape();

    console.log("StatementImport / BankLine / BankLineObservation / BankLineItem / RefundEvent schema applied and verified.");
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
