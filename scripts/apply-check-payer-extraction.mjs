// Additive migration: check-payer extraction columns on BankImage.
//
// WHY (2026-08-22): the ledger's inbound lines say only "DEPOSIT - DDA/MMKT".
// The image names WHO PAID US — extracting the payer name and memo line lets
// Beverly (bookkeeping) attribute deposits to clients and jobs. Four nullable
// columns, nothing else:
//
//   payerName        TEXT         — name block top-left of the check
//   memoText         TEXT         — the "memo"/"for" line
//   extractedAt      TIMESTAMPTZ  — idempotency marker for the extractor
//   extractionModel  TEXT         — which model produced the values
//
// DELIBERATELY ABSENT: routing number, account number, MICR line. Those are
// NEVER extracted and NEVER stored — see scripts/extract-check-payers.mjs,
// which bans them in the prompt AND drops them in code. Do not add columns
// for them.
//
// Additive and idempotent: ADD COLUMN IF NOT EXISTS only. No existing column
// or row is touched. Safe to re-run.
//
//   node scripts/apply-check-payer-extraction.mjs --dry-run
//   node scripts/apply-check-payer-extraction.mjs --yes --expect-db <name> --expect-host <host>
//
// --expect-db and --expect-host are BOTH required alongside --yes, matching
// scripts/apply-bank-image.mjs: "--yes" alone only proves you meant to run
// something, and a database NAME alone doesn't prove which SERVER it's on.
//
// Apply BEFORE deploying any build whose Prisma client selects these columns
// (P2022), and BEFORE running extract-check-payers.mjs with --commit.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

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

/** Pure comparison, exported for unit testing (mirrors apply-bank-image.mjs). */
export function targetMatches(actual, expectDb, expectHost) {
    if (!actual || typeof actual !== "object") return false;
    if (String(actual.db ?? "") !== String(expectDb ?? "")) return false;
    const host = String(actual.host ?? "");
    const wanted = String(expectHost ?? "");
    if (host === wanted) return true;
    return host !== "" && wanted !== "" && (host.includes(wanted) || wanted.includes(host));
}

export const NEW_COLUMNS = ["payerName", "memoText", "extractedAt", "extractionModel"];

export const statements = [
    `ALTER TABLE "BankImage" ADD COLUMN IF NOT EXISTS "payerName" TEXT`,
    `ALTER TABLE "BankImage" ADD COLUMN IF NOT EXISTS "memoText" TEXT`,
    `ALTER TABLE "BankImage" ADD COLUMN IF NOT EXISTS "extractedAt" TIMESTAMPTZ(6)`,
    `ALTER TABLE "BankImage" ADD COLUMN IF NOT EXISTS "extractionModel" TEXT`,

    // The extractor stamps extractedAt and extractionModel together — a row
    // claiming extraction without saying what did it (or vice versa) is a bug.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImage_extraction_pair') THEN
         ALTER TABLE "BankImage" ADD CONSTRAINT "BankImage_extraction_pair"
           CHECK (("extractedAt" IS NULL) = ("extractionModel" IS NULL));
       END IF;
     END $$`,
];

async function main() {
    if (process.argv.includes("--dry-run")) {
        console.log("DRY RUN — the following SQL would be applied (nothing executed):\n");
        for (const sql of statements) console.log(sql.replace(/\n\s+/g, "\n  ") + ";\n");
        console.log("Re-run with --yes --expect-db <name> --expect-host <host> to apply.");
        return;
    }

    if (!process.argv.includes("--yes")) {
        console.error("Refusing to run without --yes (and --expect-db / --expect-host). Use --dry-run to preview.");
        process.exit(1);
    }
    const expectDb = readFlagValue("--expect-db") ?? process.env.BANK_LEDGER_EXPECT_DB;
    const expectHost = readFlagValue("--expect-host") ?? process.env.BANK_LEDGER_EXPECT_HOST;
    if (!expectDb || !expectHost) {
        console.error("Both --expect-db and --expect-host are required (or BANK_LEDGER_EXPECT_DB / BANK_LEDGER_EXPECT_HOST).");
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
            const label = sql.replace(/\s+/g, " ").slice(0, 84);
            process.stdout.write(`  ${label} ... `);
            await prisma.$executeRawUnsafe(sql);
            console.log("ok");
        }

        // Verify shape rather than trusting the run.
        const rows = await prisma.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='BankImage'`,
        );
        const found = new Set(rows.map(r => r.column_name));
        const missing = NEW_COLUMNS.filter(c => !found.has(c));
        if (missing.length) {
            console.error(`VERIFY FAILED: BankImage missing columns: ${missing.join(", ")}`);
            process.exit(1);
        }
        const [pair] = await prisma.$queryRawUnsafe(
            `SELECT 1 AS ok FROM pg_constraint WHERE conname = 'BankImage_extraction_pair'`,
        );
        if (!pair) {
            console.error("VERIFY FAILED: constraint BankImage_extraction_pair missing");
            process.exit(1);
        }
        console.log(`verified ${NEW_COLUMNS.length} columns + 1 constraint`);
        console.log("\nCheck-payer extraction migration applied and verified.");
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
