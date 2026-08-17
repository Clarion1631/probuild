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
// Idempotent: ADD COLUMN IF NOT EXISTS. Additive only — no deletes, no drops,
// no destructive rewrites. Safe to run while the previous build is live; the
// new build's Prisma client selects the new columns immediately after this runs.
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
// 20260815000000_add_change_order_revision is written IF-NOT-EXISTS, so it does
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
];

try {
    for (const sql of statements) {
        await prisma.$executeRawUnsafe(sql);
        console.log("OK:", sql.split("\n")[0].slice(0, 80));
    }
    console.log("\nChangeOrder.revision / termsTax* schema applied successfully.");
    console.log(
        "\nNote: this did not touch _prisma_migrations. Once this environment's DIRECT_URL is\n" +
        "reachable (e.g. running from CI), reconcile prod's migration history for real with:\n" +
        "  npx prisma migrate deploy\n" +
        "(the migration is IF-NOT-EXISTS, so this is a safe no-op that self-records) — or, if that\n" +
        "is not available, a manual:\n" +
        "  npx prisma migrate resolve --applied 20260815000000_add_change_order_revision\n" +
        "See docs/DB-MIGRATE-WORKFLOW.md.",
    );
} catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
