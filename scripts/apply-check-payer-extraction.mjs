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
    return String(actual.host ?? "") === String(expectHost ?? "");
}

export const NEW_COLUMNS = ["payerName", "memoText", "extractedAt", "extractionModel"];
export const FOUNDATION_TABLES = ["BankImage", "BankImageMatch"];

// PostgreSQL constraint names are only unique per relation. Both the DDL
// guard and post-DDL verification must use this exact relation predicate.
export const BANK_IMAGE_CONSTRAINT_QUERY = `SELECT 1 AS ok
    FROM pg_constraint
    WHERE conname = 'BankImage_extraction_pair'
      AND conrelid = 'public."BankImage"'::regclass`;

// This is intentionally read-only. It runs before individual DDL statements,
// because those statements cannot be one transaction with every production
// deployment path that invokes this script.
export const BANK_IMAGE_FOUNDATION_PREFLIGHT_QUERY = `SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name IN ('BankImage', 'BankImageMatch')`;

export function missingFoundationTables(rows) {
    const found = new Set(rows.map(row => row.table_name));
    return FOUNDATION_TABLES.filter(table => !found.has(table));
}

export function wrongColumnDefinitions(rows) {
    const found = new Map(rows.map(row => [row.column_name, row]));
    const expected = new Map([
        ["payerName", { dataType: "text" }],
        ["memoText", { dataType: "text" }],
        ["extractedAt", { dataType: "timestamp with time zone", datetimePrecision: 6 }],
        ["extractionModel", { dataType: "text" }],
    ]);
    return NEW_COLUMNS.filter(column => {
        const actual = found.get(column);
        const requirement = expected.get(column);
        return !actual || !requirement
            || actual.data_type !== requirement.dataType
            || (requirement.datetimePrecision !== undefined
                && Number(actual.datetime_precision) !== requirement.datetimePrecision);
    });
}

export function constraintDefinitionMatches(definition) {
    const normalized = String(definition ?? "").replace(/\s+/g, "");
    return /^CHECK\(\(+"extractedAt"ISNULL\)=\("extractionModel"ISNULL\)\)+$/.test(normalized);
}

export const statements = [
    `ALTER TABLE public."BankImage" ADD COLUMN IF NOT EXISTS "payerName" TEXT`,
    `ALTER TABLE public."BankImage" ADD COLUMN IF NOT EXISTS "memoText" TEXT`,
    `ALTER TABLE public."BankImage" ADD COLUMN IF NOT EXISTS "extractedAt" TIMESTAMPTZ(6)`,
    `ALTER TABLE public."BankImage" ADD COLUMN IF NOT EXISTS "extractionModel" TEXT`,

    // The extractor stamps extractedAt and extractionModel together — a row
    // claiming extraction without saying what did it (or vice versa) is a bug.
    `DO $$ BEGIN
       IF NOT EXISTS (${BANK_IMAGE_CONSTRAINT_QUERY}) THEN
         ALTER TABLE public."BankImage" ADD CONSTRAINT "BankImage_extraction_pair"
           CHECK (("extractedAt" IS NULL) = ("extractionModel" IS NULL));
       END IF;
     END $$`,
];

export async function runPayerExtractionMigration({ prisma, expectDb, expectHost, write = console.log }) {
    const [actual] = await prisma.$queryRawUnsafe(
        `SELECT current_database() AS db, COALESCE(host(inet_server_addr()), '') AS host`,
    );
    write(`connected to db="${actual?.db ?? "<unknown>"}" host="${actual?.host ?? "<unknown>"}"`);
    if (!targetMatches(actual, expectDb, expectHost)) {
        throw new Error(`REFUSING: expected db="${expectDb}" host="${expectHost}" but connected to db="${actual?.db ?? "<unknown>"}" host="${actual?.host ?? "<unknown>"}".`);
    }

    // Verify the pre-existing image/match foundation before the first
    // non-transactional DDL statement can make a partial schema change.
    const foundationRows = await prisma.$queryRawUnsafe(BANK_IMAGE_FOUNDATION_PREFLIGHT_QUERY);
    const missingFoundation = missingFoundationTables(foundationRows);
    if (missingFoundation.length) {
        throw new Error(`PREFLIGHT FAILED: missing foundation table(s): ${missingFoundation.join(", ")}`);
    }
    write(`preflight verified ${FOUNDATION_TABLES.join(" + ")} foundation`);

    for (const sql of statements) {
        const label = sql.replace(/\s+/g, " ").slice(0, 84);
        write(`  ${label} ...`);
        await prisma.$executeRawUnsafe(sql);
        write("ok");
    }

    // Verify shape rather than trusting the run. PostgreSQL reports the
    // timestamp precision separately from data_type, so check both.
    const rows = await prisma.$queryRawUnsafe(
        `SELECT column_name, data_type, datetime_precision FROM information_schema.columns WHERE table_schema='public' AND table_name='BankImage'`,
    );
    const missing = NEW_COLUMNS.filter(column => !rows.some(row => row.column_name === column));
    if (missing.length) {
        throw new Error(`VERIFY FAILED: BankImage missing columns: ${missing.join(", ")}`);
    }
    const wrongDefinitions = wrongColumnDefinitions(rows);
    if (wrongDefinitions.length) {
        throw new Error(`VERIFY FAILED: BankImage has wrong column type or precision: ${wrongDefinitions.join(", ")}`);
    }
    const [pair] = await prisma.$queryRawUnsafe(
        BANK_IMAGE_CONSTRAINT_QUERY.replace("SELECT 1 AS ok", "SELECT pg_get_constraintdef(oid, true) AS definition"),
    );
    if (!pair || !constraintDefinitionMatches(pair.definition)) {
        throw new Error("VERIFY FAILED: BankImage_extraction_pair missing or has the wrong invariant");
    }
    write(`verified ${NEW_COLUMNS.length} columns + 1 constraint`);
    write("\nCheck-payer extraction migration applied and verified.");
}

async function main() {
    if (process.argv.includes("--dry-run")) {
        console.log("DRY RUN — the following SQL would be applied (nothing executed):\n");
        for (const sql of statements) console.log(sql.replace(/\n\s+/g, "\n  ") + ";\n");
        console.log("Re-run with --yes --expect-db <name> --expect-host <host> to apply.");
        return;
    }

    if (!process.argv.includes("--yes")) {
        throw new Error("Refusing to run without --yes (and --expect-db / --expect-host). Use --dry-run to preview.");
    }
    const expectDb = readFlagValue("--expect-db") ?? process.env.BANK_LEDGER_EXPECT_DB;
    const expectHost = readFlagValue("--expect-host") ?? process.env.BANK_LEDGER_EXPECT_HOST;
    if (!expectDb || !expectHost) {
        throw new Error("Both --expect-db and --expect-host are required (or BANK_LEDGER_EXPECT_DB / BANK_LEDGER_EXPECT_HOST).");
    }

    const { url, from } = resolveDatabaseUrl();
    console.log(`DATABASE_URL from ${from}: ${maskUrl(url)}`);
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
        await runPayerExtractionMigration({ prisma, expectDb, expectHost });
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
