/**
 * CI-only helper for the "Apply receipt intake source folder schema" step.
 *
 * `prisma migrate deploy`, earlier in the migrations job, already applies
 * every committed migration -- including this feature's -- so by the time
 * that step reaches `apply-receipt-intake-source-folder.mjs`, the column
 * already exists. Running the apply script there alone only ever exercises
 * its idempotent no-op branch, never the ADD COLUMN a fresh production run
 * actually needs (Codex round 2, finding 5).
 *
 * This drops the column first, so the apply script genuinely adds it, and
 * asserts presence/absence at each step so a broken apply script -- one that
 * silently failed to add the column -- cannot pass by no-op alone.
 *
 * Usage: node ci-receipt-intake-source-folder-column.mjs <drop|assert-present>
 * DATABASE_URL must point at the throwaway CI database.
 */
import { PrismaClient } from "@prisma/client";

const mode = process.argv[2];
if (!["drop", "assert-present"].includes(mode)) {
    console.error("usage: node ci-receipt-intake-source-folder-column.mjs <drop|assert-present>");
    process.exit(1);
}

const prisma = new PrismaClient();
try {
    if (mode === "drop") {
        await prisma.$executeRawUnsafe('ALTER TABLE "ReceiptIntake" DROP COLUMN IF EXISTS "sourceFolder"');
    }
    const rows = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'ReceiptIntake' AND column_name = 'sourceFolder'`,
    );
    const present = rows.length === 1;
    if (mode === "drop" && present) {
        console.error("sourceFolder is still present after DROP COLUMN");
        process.exit(1);
    }
    if (mode === "assert-present" && !present) {
        console.error("sourceFolder is still absent after the apply script ran");
        process.exit(1);
    }
    console.log(`sourceFolder is ${present ? "present" : "absent"} -- ${mode}: OK`);
} finally {
    await prisma.$disconnect();
}
