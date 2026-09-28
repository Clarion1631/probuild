/**
 * CI-only helper for the "Apply change order offline approval schema" step.
 *
 * `prisma migrate deploy` already adds the columns, so running the apply
 * script alone would only prove its no-op branch. This drops the three
 * columns first so the apply script genuinely adds them, and asserts
 * presence/absence at each step.
 *
 * It runs a raw DROP COLUMN, so `assertCiDatabaseTarget` refuses anything
 * that is not the throwaway CI database before `@prisma/client` is imported.
 *
 * Usage: node ci-change-order-offline-approval-columns.mjs <drop|assert-present>
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

const COLUMNS = ["approvalSource", "approvalMethod", "approvalNote"];

async function main() {
    const mode = process.argv[2];
    if (!["drop", "assert-present"].includes(mode)) {
        console.error("usage: node ci-change-order-offline-approval-columns.mjs <drop|assert-present>");
        process.exitCode = 1;
        return;
    }

    assertCiDatabaseTarget(process.env.DATABASE_URL);

    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
        if (mode === "drop") {
            for (const column of COLUMNS) {
                await prisma.$executeRawUnsafe(`ALTER TABLE "ChangeOrder" DROP COLUMN IF EXISTS "${column}"`);
            }
        }
        const rows = await prisma.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'ChangeOrder'
                AND column_name IN ('approvalSource', 'approvalMethod', 'approvalNote')`,
        );
        const present = rows.length;
        if (mode === "drop" && present !== 0) {
            console.error("offline approval columns are still present after DROP COLUMN");
            process.exitCode = 1;
            return;
        }
        if (mode === "assert-present" && present !== COLUMNS.length) {
            console.error(`expected ${COLUMNS.length} offline approval columns, found ${present}`);
            process.exitCode = 1;
            return;
        }
        console.log(`offline approval columns present: ${present} -- ${mode}: OK`);
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
