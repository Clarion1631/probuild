// Adds PaymentSchedule.qbIssuanceKey and ProgressBilling.qbIssuanceKey — the
// per-issuance idempotency seed for a QuickBooks invoice send.
//
// Why a column and not a derived value: the key has to survive the process, so
// an ambiguous retry (request landed, response did not) reuses it and Intuit
// returns the ORIGINAL invoice instead of creating a duplicate. Deriving it
// from the row id did that much, but could never express a RE-ISSUE: after an
// unlink the next send reused the same key and got back the stale invoice.
// Minting on send and clearing on unlink separates the two.
//
// Additive, nullable, idempotent (IF NOT EXISTS): safe to run against prod
// while the old build is live. Run it BEFORE deploying the build that selects
// the column, or every page touching these models throws P2022.
//
// Usage:
//   node scripts/apply-qbo-issuance-key.mjs --yes --expect-db <name> --expect-host <host>
//
// --yes alone only proves you meant to run something; --expect-db and
// --expect-host prove you meant to run it HERE. All three are required.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

export function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, from: "process.env.DATABASE_URL" };
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return { url: match[1], from: file };
    }
    throw new Error("DATABASE_URL not found in process.env, .env.local, or .env");
}

export function maskUrl(url) {
    return url.replace(/:[^:@]*@/, ":****@");
}

function readFlagValue(flag) {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/**
 * Pure comparison, exported so the guard can be unit-tested without a live DB
 * (same shape as apply-bank-image.mjs). Compares BOTH database name and host —
 * the database name alone is identical across every Supabase project.
 */
export function targetMatches(actual, expectDb, expectHost) {
    if (!actual || typeof actual !== "object") return false;
    if (String(actual.db ?? "") !== String(expectDb ?? "")) return false;
    const host = String(actual.host ?? "");
    const wanted = String(expectHost ?? "");
    if (host === wanted) return true;
    // A pooled Supabase host resolves to an IP; accept either the literal host
    // string or an address the operator typed instead.
    return host !== "" && wanted !== "" && (host.includes(wanted) || wanted.includes(host));
}

export const statements = [
    `ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "qbIssuanceKey" TEXT`,
    `ALTER TABLE "ProgressBilling" ADD COLUMN IF NOT EXISTS "qbIssuanceKey" TEXT`,
    `ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "qbIssuancePayloadHash" TEXT`,
    `ALTER TABLE "ProgressBilling" ADD COLUMN IF NOT EXISTS "qbIssuancePayloadHash" TEXT`,
];

const expectedColumns = {
    PaymentSchedule: ["qbIssuanceKey", "qbIssuancePayloadHash"],
    ProgressBilling: ["qbIssuanceKey", "qbIssuancePayloadHash"],
};

async function main() {
    if (!process.argv.includes("--yes")) {
        console.error("Refusing to run without --yes (and --expect-db / --expect-host).");
        process.exit(1);
    }
    const expectDb = readFlagValue("--expect-db") ?? process.env.QBO_ISSUANCE_EXPECT_DB;
    const expectHost = readFlagValue("--expect-host") ?? process.env.QBO_ISSUANCE_EXPECT_HOST;
    if (!expectDb || !expectHost) {
        console.error("Both --expect-db and --expect-host are required (or QBO_ISSUANCE_EXPECT_DB / QBO_ISSUANCE_EXPECT_HOST).");
        process.exit(1);
    }

    const { url, from } = resolveDatabaseUrl();
    console.log(`DATABASE_URL from ${from}: ${maskUrl(url)}`);
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        const [actual] = await prisma.$queryRawUnsafe(
            `SELECT current_database() AS db, COALESCE(host(inet_server_addr()), '') AS host`,
        );
        console.log(`connected to db="${actual.db}" host="${actual.host}"`);
        if (!targetMatches(actual, expectDb, expectHost)) {
            console.error(`REFUSING: expected db="${expectDb}" host="${expectHost}" but connected to db="${actual.db}" host="${actual.host}".`);
            process.exit(1);
        }

        for (const sql of statements) {
            process.stdout.write(`  ${sql} ... `);
            await prisma.$executeRawUnsafe(sql);
            console.log("ok");
        }

        // Verify the shape rather than trusting the run.
        for (const [table, columns] of Object.entries(expectedColumns)) {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
                table,
            );
            const found = new Set(rows.map(r => r.column_name));
            const missing = columns.filter(c => !found.has(c));
            if (missing.length) {
                console.error(`VERIFY FAILED: ${table} missing columns: ${missing.join(", ")}`);
                process.exit(1);
            }
            console.log(`verified ${table}.${columns.join(", ")}`);
        }
        console.log("\nqbIssuanceKey migration applied and verified.");
    } finally {
        await prisma.$disconnect();
    }
}

// Importing this file for its pure helpers must not connect to anything.
if (process.argv[1] && process.argv[1].endsWith("apply-qbo-issuance-key.mjs")) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}
