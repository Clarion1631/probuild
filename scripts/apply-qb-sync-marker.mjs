// Durable in-flight marker for the document sync rail
// (Codex round-38 gate, finding 5):
//
//   Estimate.qbSyncMarker  \
//   Invoice.qbSyncMarker   /  same vocabulary as PaymentSchedule.qbSyncError
//                             (src/lib/qbo-create-markers.ts):
//                             create-in-flight -> ambiguous-create
//
// /api/quickbooks/sync created a QuickBooks estimate or invoice, returned its
// id, and persisted nothing. A 503 that told the caller "retry: false" is only
// advice: a refresh re-POSTed and QuickBooks got a second document for the same
// record, with nothing in ProBuild pointing at either. The marker is written
// BEFORE the POST so a crash between the request and the write is visible, and
// the id is persisted in the same write that clears it.
//
// ADD COLUMN IF NOT EXISTS only — idempotent, no drops, safe to re-run and
// safe while the previous build is live. Run BEFORE deploying the build that
// selects it, per CLAUDE.md "Schema migrations" (no `prisma db push` /
// `migrate dev` here — DIRECT_URL is IPv6-only from this machine). Then
// regenerate the client from PowerShell.
//
//   node scripts/apply-qb-sync-marker.mjs --target prod
//
// The identical DDL is checked in at
// prisma/migrations/20260903120000_qb_sync_marker/migration.sql, which is what
// CI's throwaway database is built from.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STATEMENTS = [
    `ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "qbSyncMarker" TEXT`,
    `ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "qbSyncMarker" TEXT`,
];

export const EXPECTED = [
    { table: "Estimate", column: "qbSyncMarker" },
    { table: "Invoice", column: "qbSyncMarker" },
];

// Every side effect lives in here and runs ONLY behind the main-module guard
// below, so importing this module to read its exported SQL never opens a
// connection or mutates anything (the 2026-09-02 incident).
/** The migration that marks a database as the baselined PRODUCTION one. */
export const PROD_BASELINE_MIGRATION = "20260814000000_baseline_production";

/** Everything identifying about a connection string, with the secret removed. */
export function redactTarget(url) {
    try {
        const u = new URL(url);
        const db = u.pathname.replace(/^\//, "") || "(none)";
        return `${u.protocol}//${u.username ? u.username + "@" : ""}${u.host}/${db}`;
    } catch {
        return "(unparseable connection string)";
    }
}

async function main() {
    // Parsed HERE, not at module scope: this file must stay inert on import
    // (the 2026-09-02 incident, and tests/apply-scripts-inert-on-import.test.ts).
    const args = process.argv.slice(2);
    const targetAt = args.indexOf("--target");
    const target = targetAt === -1 ? null : args[targetAt + 1];
    if (target !== "prod") {
        console.error(
            "Refusing to run: this script applies DDL and must be told which database.\n" +
            "  node scripts/apply-qb-sync-marker.mjs --target prod",
        );
        process.exit(1);
    }

    // ONLY .env.production.local, and it OVERRIDES whatever is already in the
    // environment. `dotenv` does not overwrite by default, so an ambient
    // DATABASE_URL — a local database, or a shell left over from a test run —
    // won silently and the script applied production DDL somewhere else
    // entirely. The other env files are deliberately NOT loaded: --target prod
    // means prod, and there is then no file precedence to reason about.
    const envPath = join(__dirname, "..", ".env.production.local");
    const loaded = config({ path: envPath, override: true });
    if (loaded.error || !loaded.parsed?.DATABASE_URL) {
        console.error(`Refusing to run: no DATABASE_URL in ${envPath} (run \`vercel env pull\` first).`);
        process.exit(1);
    }
    const url = loaded.parsed.DATABASE_URL;

    // Said BEFORE the first statement, redacted, so the operator sees what is
    // about to be altered while there is still time to stop it.
    console.log(`target: ${redactTarget(url)}`);

    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
        // Prove the connection landed where it was told to. A connection string
        // can be stale, rewritten, or pointed at a branch database; these three
        // facts are what production actually looks like.
        const [{ current_database: database }] = await prisma.$queryRawUnsafe("SELECT current_database()");
        const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
        const baseline = await prisma.$queryRawUnsafe(
            `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = '${PROD_BASELINE_MIGRATION}'`,
        );
        const problems = [];
        if (database !== "postgres") problems.push(`current_database() is "${database}", not "postgres"`);
        if (!/pooler\.supabase\.com$/.test(host)) problems.push(`host "${host}" is not the Supabase pooler`);
        if (baseline.length !== 1) problems.push(`${PROD_BASELINE_MIGRATION} is not recorded in _prisma_migrations`);
        if (problems.length) {
            console.error(`Refusing to run: this is not production.\n  - ${problems.join("\n  - ")}`);
            process.exit(1);
        }
        console.log(`verified: ${database} on ${host}, baselined`);
        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
            console.log("ok:", sql.split("\n")[0].trim());
        }
        const missing = [];
        for (const { table, column } of EXPECTED) {
            const cols = await prisma.$queryRawUnsafe(
                `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`
            );
            const present = new Set(cols.map((c) => c.column_name));
            if (!present.has(column)) missing.push(`${table}.${column}`);
        }
        console.log(
            `verified ${EXPECTED.length - missing.length}/${EXPECTED.length} column(s) present`,
            missing.length ? `— MISSING: ${missing.join(", ")}` : ""
        );
        if (missing.length) process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
