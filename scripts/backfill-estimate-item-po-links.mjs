// Data backfill for multiple purchase orders per estimate line item.
// Copies every legacy EstimateItem.purchaseOrderId into the EstimateItemPurchaseOrder
// join table created by scripts/apply-estimate-item-po-links.mjs.
//
// RUN THIS *AFTER* THE DEPLOY, not before. The old build writes only the legacy scalar
// column, so backfilling while it is still serving traffic would leave a stale join row
// behind any unlink or PO replacement that happens in the deploy window — an insert-only
// sweep can never detect those. Running after the cutover means the scalar column is the
// undisputed source of truth for every pre-existing link at the moment we read it.
//
// Nothing is lost in the gap between deploy and backfill: the new build falls back to the
// legacy scalar when an item has no join rows, and every link-write path migrates the
// legacy scalar into the join table first (migrate-on-write).
//
// Processes one EstimateItem at a time, each in its own transaction that locks the item row
// FOR UPDATE and re-reads the scalar before inserting — the same per-item locking protocol
// every server action uses (see lockEstimateItemLinks in src/lib/actions.ts). Without it, a
// live unlink running concurrently with this backfill could delete a join row that doesn't
// exist yet, the backfill's bulk insert could then recreate it from the (about-to-be-nulled)
// scalar, and the unlink's own mirror resync could re-materialize it — silently undoing the
// unlink. Locking the row first means whichever side gets there first (this script or a live
// unlink/link transaction) fully completes, including the mirror resync, before the other
// proceeds.
//
// Idempotent — safe to run late, twice, or after users have already added links:
//   node scripts/backfill-estimate-item-po-links.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

// Counts legacy scalar links that have no matching join row. This is the assertion that
// matters — NOT "rows inserted by this run", which is legitimately 0 on a rerun and can
// also be short by however many rows migrate-on-write already created.
const COVERAGE_SQL = `
    SELECT count(*)::int AS count
    FROM "EstimateItem" e
    WHERE e."purchaseOrderId" IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM "EstimateItemPurchaseOrder" j
          WHERE j."estimateItemId" = e."id"
            AND j."purchaseOrderId" = e."purchaseOrderId"
      )`;

try {
    const [{ count: scalarLinks }] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM "EstimateItem" WHERE "purchaseOrderId" IS NOT NULL`
    );
    const [{ count: before }] = await prisma.$queryRawUnsafe(COVERAGE_SQL);
    console.log(`${scalarLinks} legacy scalar link(s); ${before} not yet in the join table.`);

    // Sorted so this script's per-item lock acquisition order matches the app's
    // (Estimate → sorted EstimateItem ids), even though each row here gets its own
    // transaction — consistent ordering avoids unnecessary lock-wait pileups.
    const candidates = await prisma.$queryRawUnsafe(
        `SELECT "id" FROM "EstimateItem" WHERE "purchaseOrderId" IS NOT NULL ORDER BY "id" ASC`
    );

    let inserted = 0;
    for (const { id } of candidates) {
        inserted += await prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRawUnsafe(
                `SELECT "purchaseOrderId", "createdAt" FROM "EstimateItem" WHERE "id" = $1 FOR UPDATE`,
                id,
            );
            const current = rows[0];
            if (!current?.purchaseOrderId) return 0; // unlinked since the initial scan above
            return tx.$executeRawUnsafe(
                `INSERT INTO "EstimateItemPurchaseOrder" ("id", "estimateItemId", "purchaseOrderId", "createdAt")
                 VALUES (gen_random_uuid()::text, $1, $2, COALESCE($3, NOW()))
                 ON CONFLICT ("estimateItemId", "purchaseOrderId") DO NOTHING`,
                id, current.purchaseOrderId, current.createdAt,
            );
        });
    }
    console.log(`Inserted ${inserted} join row(s) across ${candidates.length} candidate item(s).`);

    const [{ count: after }] = await prisma.$queryRawUnsafe(COVERAGE_SQL);
    if (after !== 0) {
        console.error(`\nFAILED: ${after} legacy link(s) still have no join row. No data was removed — investigate before proceeding.`);
        process.exit(1);
    }

    const [{ count: total }] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM "EstimateItemPurchaseOrder"`
    );
    console.log(`\nBackfill complete. Coverage check passed (0 legacy links missing a join row).`);
    console.log(`${total} total link row(s) now in EstimateItemPurchaseOrder.`);
} catch (e) {
    console.error("Backfill failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
