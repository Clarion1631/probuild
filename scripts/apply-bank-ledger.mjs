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
//   node scripts/apply-bank-ledger.mjs --yes --expect-db <database-name>
//
// --expect-db (or the BANK_LEDGER_EXPECT_DB env var) is REQUIRED in addition
// to --yes: this script queries current_database() and the server identity
// and refuses to run a single statement if they don't match what you typed —
// "--yes" alone only proves you meant to run *something*, not that you knew
// which database DATABASE_URL currently points at (Codex round-2 finding:
// generic --yes is not enough).
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

function readFlagValue(flag) {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const expectDb = readFlagValue("--expect-db") || process.env.BANK_LEDGER_EXPECT_DB;

if (!process.argv.includes("--yes")) {
    console.error(
        `Refusing to run without --yes.\n` +
        `Target database (from ${from}): ${maskedUrl}\n` +
        `Re-run as: node scripts/apply-bank-ledger.mjs --yes --expect-db <database-name>`,
    );
    process.exit(1);
}

if (!expectDb) {
    console.error(
        `Refusing to run without an expected database identity.\n` +
        `Target database (from ${from}): ${maskedUrl}\n` +
        `--yes alone does not prove you know which database this is about to mutate.\n` +
        `Pass --expect-db <database-name> or set BANK_LEDGER_EXPECT_DB.`,
    );
    process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

/** Queried and compared against --expect-db BEFORE the first mutating statement runs. */
async function verifyDatabaseIdentity() {
    const rows = await prisma.$queryRaw`
        SELECT current_database() AS db, inet_server_addr()::text AS host, inet_server_port() AS port`;
    const actual = rows[0];
    const host = actual.host ?? "local/unix-socket";
    const port = actual.port ?? "?";
    if (actual.db !== expectDb) {
        throw new Error(
            `Refusing to run: connected database "${actual.db}" (host=${host} port=${port}) ` +
            `does not match --expect-db "${expectDb}". Aborting before any mutation.`,
        );
    }
    console.log(`Verified target database identity: "${actual.db}" (host=${host} port=${port})`);
}

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
    // Codex round-2: at most one linked observation per (source, bankLineId)
    // — a canonical BankLine can never accumulate two QBO_REGISTER
    // observations (or two STATEMENT observations) across separate
    // reconciliation/ingest runs. Prisma cannot express a partial index, so
    // this exists ONLY here (see the schema.prisma NOTE above the model).
    `CREATE UNIQUE INDEX IF NOT EXISTS "BankLineObservation_source_bankLineId_key"
       ON "BankLineObservation" ("source", "bankLineId")
       WHERE "bankLineId" IS NOT NULL`,
    // Codex round-2: source-dependent shape — STATEMENT rows always carry
    // both statementImportId and bankLineId (minted together at ingest);
    // QBO_REGISTER rows must never carry a statementImportId.
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'BankLineObservation_source_shape_check' AND conrelid = '"BankLineObservation"'::regclass
       ) THEN
         ALTER TABLE "BankLineObservation" ADD CONSTRAINT "BankLineObservation_source_shape_check"
           CHECK (
             (source = 'STATEMENT' AND "statementImportId" IS NOT NULL AND "bankLineId" IS NOT NULL)
             OR (source = 'QBO_REGISTER' AND "statementImportId" IS NULL)
           );
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
    // Codex round-2 (should-fix d): originalBankLineId must reference a
    // DEBIT BankLine (amountCents < 0) and refundBankLineId a CREDIT
    // BankLine (amountCents > 0) — a plain CHECK constraint can't reach
    // across tables, so this is a trigger. Mirrored at the app layer by
    // validateRefundEventSigns() in src/lib/bank-ledger.ts, which is meant
    // to catch this BEFORE the write and give a normal validation error;
    // this trigger is the backstop for anything that bypasses that helper.
    `CREATE OR REPLACE FUNCTION check_refund_event_signs() RETURNS TRIGGER AS $BODY$
     DECLARE
       orig_amount INTEGER;
       refund_amount INTEGER;
     BEGIN
       IF NEW."originalBankLineId" IS NOT NULL THEN
         SELECT "amountCents" INTO orig_amount FROM "BankLine" WHERE "id" = NEW."originalBankLineId";
         IF orig_amount IS NOT NULL AND orig_amount >= 0 THEN
           RAISE EXCEPTION 'RefundEvent.originalBankLineId must reference a debit BankLine (amountCents < 0), got %', orig_amount;
         END IF;
       END IF;
       IF NEW."refundBankLineId" IS NOT NULL THEN
         SELECT "amountCents" INTO refund_amount FROM "BankLine" WHERE "id" = NEW."refundBankLineId";
         IF refund_amount IS NOT NULL AND refund_amount <= 0 THEN
           RAISE EXCEPTION 'RefundEvent.refundBankLineId must reference a credit BankLine (amountCents > 0), got %', refund_amount;
         END IF;
       END IF;
       RETURN NEW;
     END;
     $BODY$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS refund_event_signs_trigger ON "RefundEvent"`,
    `CREATE TRIGGER refund_event_signs_trigger
       BEFORE INSERT OR UPDATE ON "RefundEvent"
       FOR EACH ROW EXECUTE FUNCTION check_refund_event_signs()`,

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

// Each constraint/index is paired with the table it belongs to so
// verifyShape() can resolve that table's OID WITHIN THE TARGET SCHEMA and
// check against it — a bare unqualified name lookup (the old approach) can
// silently match an identically-named object in another schema.
const expectedConstraints = [
    { name: "StatementImport_contentHash_key", table: "StatementImport" },
    { name: "StatementImport_account_periodStart_periodEnd_key", table: "StatementImport" },
    { name: "StatementImport_status_check", table: "StatementImport" },
    { name: "BankLine_state_check", table: "BankLine" },
    { name: "BankLineObservation_source_account_sourceDocumentId_sourceLineId_key", table: "BankLineObservation" },
    { name: "BankLineObservation_source_check", table: "BankLineObservation" },
    { name: "BankLineObservation_source_bankLineId_key", table: "BankLineObservation" },
    { name: "BankLineObservation_source_shape_check", table: "BankLineObservation" },
    { name: "BankLineItem_source_check", table: "BankLineItem" },
    { name: "RefundEvent_status_check", table: "RefundEvent" },
    { name: "RefundEvent_amountCents_check", table: "RefundEvent" },
    { name: "RefundEvent_taxCents_check", table: "RefundEvent" },
];

/** Resolved once, before verifyShape() runs any lookup — see the module comment on --expect-db for why bare/unqualified lookups are unsafe. */
async function resolveCurrentSchema() {
    const rows = await prisma.$queryRaw`SELECT current_schema() AS schema`;
    const schema = rows[0]?.schema;
    if (!schema) throw new Error("Could not resolve current_schema() to verify against");
    return schema;
}

async function verifyShape(schema) {
    for (const [table, columns] of Object.entries(expectedColumns)) {
        const rows = await prisma.$queryRaw`
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = ${schema} AND table_name = ${table} AND column_name = ANY(${columns})`;
        const found = new Set(rows.map(r => r.column_name));
        const missing = columns.filter(c => !found.has(c));
        if (missing.length > 0) {
            throw new Error(`Verification failed: "${schema}"."${table}" is missing expected column(s): ${missing.join(", ")}`);
        }
    }

    for (const { name, table } of expectedConstraints) {
        // conrelid is resolved from an explicitly schema-qualified
        // "schema"."table" string, never a bare table name, so this can't
        // match a same-named constraint on a same-named table living in a
        // different schema on an unexpected search_path.
        const qualifiedTable = `"${schema}"."${table}"`;
        const rows = await prisma.$queryRaw`
            SELECT 1 FROM pg_constraint
             WHERE conname = ${name} AND conrelid = ${qualifiedTable}::regclass
            UNION ALL
            SELECT 1 FROM pg_indexes
             WHERE indexname = ${name} AND schemaname = ${schema} AND tablename = ${table}`;
        if (rows.length === 0) {
            throw new Error(`Verification failed: expected constraint/index "${name}" not found on "${schema}"."${table}"`);
        }
    }

    const triggerRows = await prisma.$queryRaw`
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE t.tgname = 'refund_event_signs_trigger' AND n.nspname = ${schema} AND c.relname = 'RefundEvent'`;
    if (triggerRows.length === 0) {
        throw new Error(`Verification failed: expected trigger "refund_event_signs_trigger" not found on "${schema}"."RefundEvent"`);
    }
}

async function main() {
    console.log(`Applying to ${maskedUrl} (DATABASE_URL from ${from})`);
    await verifyDatabaseIdentity();

    for (const sql of statements) {
        console.log(`  ${sql.replace(/\s+/g, " ").slice(0, 90)}...`);
        await prisma.$executeRawUnsafe(sql);
    }

    const schema = await resolveCurrentSchema();
    await verifyShape(schema);

    console.log("StatementImport / BankLine / BankLineObservation / BankLineItem / RefundEvent schema applied and verified.");
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
