// One-off additive migration for multiple purchase orders per estimate line item.
// Creates the EstimateItemPurchaseOrder join table that replaces the one-PO-per-item
// cap of EstimateItem.purchaseOrderId.
//
// DDL ONLY — no data is written here. The backfill lives in a SEPARATE script that
// must run AFTER the deploy (scripts/backfill-estimate-item-po-links.mjs): while the
// old build is still live it writes only the legacy scalar column, so backfilling
// before the cutover would leave stale rows behind any unlink/replace that happens in
// the deploy window. Splitting the two means exactly one writer exists at any moment.
//
// Safe to re-run while the previous build is live — every statement is idempotent
// (IF NOT EXISTS / guarded DO $$ blocks). Additive only — no deletes, no drops.
//
// Run BEFORE deploying the build that ships this schema (see the pre-deploy checklist
// in CLAUDE.md):
//   node scripts/apply-estimate-item-po-links.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const statements = [
    `CREATE TABLE IF NOT EXISTS "EstimateItemPurchaseOrder" (
        "id" TEXT PRIMARY KEY,
        "estimateItemId" TEXT NOT NULL,
        "purchaseOrderId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    // Cascade on both sides mirrors today's behavior: deleting a PO dropped the link
    // (it was ON DELETE SET NULL on the scalar), and deleting an item took its link
    // with it. Undo restores these rows explicitly via restoreEstimateItemAssociations.
    `DO $$ BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'EstimateItemPurchaseOrder_estimateItemId_fkey'
              AND conrelid = '"EstimateItemPurchaseOrder"'::regclass
        ) THEN
            ALTER TABLE "EstimateItemPurchaseOrder"
                ADD CONSTRAINT "EstimateItemPurchaseOrder_estimateItemId_fkey"
                FOREIGN KEY ("estimateItemId") REFERENCES "EstimateItem"("id")
                ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
    END $$`,
    `DO $$ BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'EstimateItemPurchaseOrder_purchaseOrderId_fkey'
              AND conrelid = '"EstimateItemPurchaseOrder"'::regclass
        ) THEN
            ALTER TABLE "EstimateItemPurchaseOrder"
                ADD CONSTRAINT "EstimateItemPurchaseOrder_purchaseOrderId_fkey"
                FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
                ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
    END $$`,
    // The unique index is what makes every link write idempotent (createMany with
    // skipDuplicates, and the backfill's ON CONFLICT DO NOTHING).
    `CREATE UNIQUE INDEX IF NOT EXISTS "EstimateItemPurchaseOrder_estimateItemId_purchaseOrderId_key"
        ON "EstimateItemPurchaseOrder" ("estimateItemId", "purchaseOrderId")`,
    `CREATE INDEX IF NOT EXISTS "EstimateItemPurchaseOrder_purchaseOrderId_idx"
        ON "EstimateItemPurchaseOrder" ("purchaseOrderId")`,
    // Server-only table. RLS with no policies denies direct anon/authenticated Data API
    // access; server-side Prisma uses the owner role. Matches the convention in
    // scripts/apply-selections-playground.mjs.
    `ALTER TABLE "EstimateItemPurchaseOrder" ENABLE ROW LEVEL SECURITY`,
];

try {
    for (const sql of statements) {
        await prisma.$executeRawUnsafe(sql);
        console.log("OK:", sql.split("\n")[0].slice(0, 90));
    }

    const [{ count: pending }] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM "EstimateItem" WHERE "purchaseOrderId" IS NOT NULL`
    );
    console.log(`\nEstimateItemPurchaseOrder schema applied successfully.`);
    console.log(`${pending} existing scalar PO link(s) awaiting backfill.`);
    console.log(`NEXT: deploy, then run  node scripts/backfill-estimate-item-po-links.mjs`);
} catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
