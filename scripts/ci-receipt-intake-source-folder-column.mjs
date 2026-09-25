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
 * DANGER (checker, PR #555 round 3): this file runs a raw DROP COLUMN with no
 * other guard, against whatever DATABASE_URL happens to be in the shell. The
 * fix is `assertCiDatabaseTarget` below -- the same Supabase-host test
 * `scripts/ci-apply-receipt-intake-e2e.mjs` uses, plus the exact CI database
 * name `.github/workflows/ci.yml` sets (`probuild_migrations`). It is a pure,
 * side-effect-free export so `tests/receipt-intake-source-folder-schema.test.ts`
 * can prove the refusal without opening a connection, and it runs BEFORE
 * `@prisma/client` is even imported so a bad target never gets that far.
 *
 * Usage: node ci-receipt-intake-source-folder-column.mjs <drop|assert-present>
 * DATABASE_URL must point at the throwaway CI database.
 */
import { pathToFileURL } from "node:url";

/** The CI database `.github/workflows/ci.yml` points every step at. */
export const EXPECTED_CI_DATABASE = "probuild_migrations";

/**
 * Refuses anything that is not obviously the throwaway CI database. Never
 * connects -- pure URL parsing -- so it is safe to call before deciding
 * whether to even load a database driver.
 */
export function assertCiDatabaseTarget(databaseUrl, expectedDb = EXPECTED_CI_DATABASE) {
    if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
        throw new Error("DATABASE_URL is required.");
    }
    let parsed;
    try {
        parsed = new URL(databaseUrl);
    } catch {
        throw new Error("DATABASE_URL is invalid.");
    }
    if (/supabase\.(co|com)/i.test(parsed.hostname)) {
        throw new Error(`REFUSING: DATABASE_URL host ${JSON.stringify(parsed.hostname)} looks like production (Supabase).`);
    }
    const rawDb = parsed.pathname.replace(/^\//, "");
    let database;
    try {
        database = decodeURIComponent(rawDb);
    } catch {
        throw new Error("DATABASE_URL database name is invalid.");
    }
    if (database !== expectedDb) {
        throw new Error(`REFUSING: DATABASE_URL database is ${JSON.stringify(database)}, expected ${JSON.stringify(expectedDb)}.`);
    }
    return { database, host: parsed.hostname };
}

async function main() {
    const mode = process.argv[2];
    if (!["drop", "assert-present"].includes(mode)) {
        console.error("usage: node ci-receipt-intake-source-folder-column.mjs <drop|assert-present>");
        process.exitCode = 1;
        return;
    }

    assertCiDatabaseTarget(process.env.DATABASE_URL);

    const { PrismaClient } = await import("@prisma/client");
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
            process.exitCode = 1;
            return;
        }
        if (mode === "assert-present" && !present) {
            console.error("sourceFolder is still absent after the apply script ran");
            process.exitCode = 1;
            return;
        }
        console.log(`sourceFolder is ${present ? "present" : "absent"} -- ${mode}: OK`);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
    main().catch((err) => {
        console.error(err?.message ?? String(err));
        process.exitCode = 1;
    });
}
