// Adds ChangeOrder.revision — a monotonic optimistic-concurrency token for
// approval/billing (replaces the updatedAt-based CAS guard on manual approval,
// which Codex rejected as too coarse: any write bumps updatedAt, including ones
// unrelated to billing inputs). Bumped in every transaction that changes billing
// inputs (items, schedules, pricing, status, signatures); NOT bumped by passive
// writes like viewedAt.
//
// Also adds ChangeOrder.termsTaxExempt / termsTaxRateName /
// termsTaxRatePercent — the customer terms frozen at guarded send (see the
// column comments in schema.prisma and lib/co-tax.ts's effectiveCoTaxInfo).
//
// Finally, adds the durable ChangeOrderAutomationJob outbox used by review-send
// and post-approval automation. Its DDL, indexes, FK, and role revokes are all
// safe to replay.
//
// PaymentSchedule also receives the opaque request id/fingerprint checkpoint
// used to recover an ambiguously accepted QBO invoice create without duplicating
// the charge. No QBO request body or customer PII is stored in these columns.
//
// Idempotent: columns, table, indexes, FK, and conditional role revokes can all
// be replayed. Additive only — no deletes, no drops, no destructive rewrites.
// Safe to run while the previous build is live; the new build's Prisma client
// selects the new columns/table immediately after this runs.
//
// Run BEFORE deploying the build that ships this schema (see the pre-deploy
// checklist in CLAUDE.md):
//   node scripts/apply-co-revision-schema.mjs
//
// This runs the SQL directly over DATABASE_URL (the pooler) rather than through
// `prisma migrate deploy` (which needs DIRECT_URL — IPv6-only, unreachable from
// developer machines) — same reasoning as every other scripts/apply-*.mjs. That
// means prod's _prisma_migrations table is NOT updated by this script, on
// purpose: production writes to that table are a deliberate, separate step, the
// same precedent PR #382 (the migration-history baseline, commit 43b7fcd8) set —
// its own commit message says the prod write "is deliberately NOT part of this
// commit and is performed separately". The committed migration.sql for
// 20260815000000_add_change_order_revision and
// 20260816000000_add_change_order_automation_jobs are written IF-NOT-EXISTS, so they do
// not actually need that reconciliation step to be safe: whenever `migrate
// deploy` next runs for real against prod (from an environment that can reach
// DIRECT_URL, e.g. a CI runner), it will apply as a harmless no-op and record
// itself in _prisma_migrations on its own. See docs/DB-MIGRATE-WORKFLOW.md.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const statements = [
    `ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "termsTaxExempt" BOOLEAN`,
    `ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "termsTaxRateName" TEXT`,
    `ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "termsTaxRatePercent" DECIMAL`,
    `ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "qbCreateGeneration" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "qbCreateRequestId" TEXT`,
    `ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "qbCreateFingerprint" TEXT`,
    `ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "qbCreateStartedAt" TIMESTAMPTZ(6)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PaymentSchedule_qbCreateRequestId_key"
        ON "PaymentSchedule"("qbCreateRequestId")`,
    `CREATE TABLE IF NOT EXISTS "InvoiceEmailAttempt" (
        "invoiceId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "attemptKey" TEXT NOT NULL,
        "payload" JSONB NOT NULL,
        "startedAt" TIMESTAMPTZ(6) NOT NULL,
        "providerStartedAt" TIMESTAMPTZ(6),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "InvoiceEmailAttempt_pkey" PRIMARY KEY ("invoiceId")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceEmailAttempt_attemptKey_key"
        ON "InvoiceEmailAttempt"("attemptKey")`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'InvoiceEmailAttempt_invoiceId_fkey'
              AND conrelid = '"InvoiceEmailAttempt"'::regclass
        ) THEN
            ALTER TABLE "InvoiceEmailAttempt"
                ADD CONSTRAINT "InvoiceEmailAttempt_invoiceId_fkey"
                FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
                ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
    END $$`,
    // Server-only bearer-bearing checkpoint. No policies means Data API roles
    // are denied even if a later broad grant restores table privileges. The
    // direct Prisma owner/service role bypasses non-FORCE RLS.
    `ALTER TABLE "InvoiceEmailAttempt" ENABLE ROW LEVEL SECURITY`,
    `REVOKE ALL PRIVILEGES ON TABLE "InvoiceEmailAttempt" FROM PUBLIC`,
    `DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "InvoiceEmailAttempt" FROM anon';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "InvoiceEmailAttempt" FROM authenticated';
        END IF;
    END $$`,
    `CREATE TABLE IF NOT EXISTS "ChangeOrderAutomationJob" (
        "id" TEXT NOT NULL,
        "changeOrderId" TEXT NOT NULL,
        "eventRevision" INTEGER NOT NULL,
        "kind" TEXT NOT NULL,
        "approvalMode" TEXT,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "payload" JSONB,
        "result" JSONB,
        "idempotencyKey" TEXT NOT NULL,
        "dedupeKey" TEXT NOT NULL,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "maxAttempts" INTEGER NOT NULL DEFAULT 8,
        "nextAttemptAt" TIMESTAMP(3),
        "firstProviderAttemptAt" TIMESTAMP(3),
        "processingStartedAt" TIMESTAMP(3),
        "claimToken" TEXT,
        "providerMessageId" TEXT,
        "lastError" TEXT,
        "completedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "ChangeOrderAutomationJob_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_idempotencyKey_key"
        ON "ChangeOrderAutomationJob"("idempotencyKey")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_dedupeKey_key"
        ON "ChangeOrderAutomationJob"("dedupeKey")`,
    `CREATE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_changeOrderId_eventRevision_kind_idx"
        ON "ChangeOrderAutomationJob"("changeOrderId", "eventRevision", "kind")`,
    `CREATE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_changeOrderId_idx"
        ON "ChangeOrderAutomationJob"("changeOrderId")`,
    `CREATE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_status_nextAttemptAt_createdAt_idx"
        ON "ChangeOrderAutomationJob"("status", "nextAttemptAt", "createdAt")`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'ChangeOrderAutomationJob_changeOrderId_fkey'
              AND conrelid = '"ChangeOrderAutomationJob"'::regclass
        ) THEN
            ALTER TABLE "ChangeOrderAutomationJob"
                ADD CONSTRAINT "ChangeOrderAutomationJob_changeOrderId_fkey"
                FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id")
                ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
    END $$`,
    // Same server-only/no-policy posture as InvoiceEmailAttempt. Do not FORCE:
    // the durable worker uses the direct Prisma owner connection.
    `ALTER TABLE "ChangeOrderAutomationJob" ENABLE ROW LEVEL SECURITY`,
    `REVOKE ALL PRIVILEGES ON TABLE "ChangeOrderAutomationJob" FROM PUBLIC`,
    `DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "ChangeOrderAutomationJob" FROM anon';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "ChangeOrderAutomationJob" FROM authenticated';
        END IF;
    END $$`,
];

try {
    for (const sql of statements) {
        await prisma.$executeRawUnsafe(sql);
        console.log("OK:", sql.split("\n")[0].slice(0, 80));
    }
    console.log("\nChangeOrder automation and QBO create-checkpoint schema applied successfully.");
    console.log(
        "\nNote: this did not touch _prisma_migrations. Once this environment's DIRECT_URL is\n" +
        "reachable (e.g. running from CI), reconcile prod's migration history for real with:\n" +
        "  npx prisma migrate deploy\n" +
        "(the migrations are IF-NOT-EXISTS, so this safely self-records them) — or, if that\n" +
        "is not available, a manual:\n" +
        "  npx prisma migrate resolve --applied 20260815000000_add_change_order_revision\n" +
        "  npx prisma migrate resolve --applied 20260816000000_add_change_order_automation_jobs\n" +
        "See docs/DB-MIGRATE-WORKFLOW.md.",
    );
} catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
