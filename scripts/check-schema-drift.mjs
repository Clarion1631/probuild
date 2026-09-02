// Fail-closed gate: compares Prisma's schema (what the built app expects to
// query) against production's actual information_schema, and fails loudly if
// prod is missing a table or column the app now depends on.
//
// This exists because "run the apply script before merging" has already been
// silently skipped twice, and each time every project page crashed with the
// generic error boundary for days before anyone noticed:
//   - 2026-07-20: company-schedule deploy shipped before
//     apply-company-schedule-schema.mjs ran against prod.
//   - 2026-08-29: PR #406 (Inspection table) merged and auto-deployed
//     without apply-inspections-schema.mjs; project pages were down four
//     days before a customer reported it.
//
// This script is READ-ONLY: it only ever issues SELECT statements against
// information_schema.columns. It never runs DDL/DML and never applies a
// migration itself — that stays a deliberate, reviewed step
// (scripts/apply-*.mjs, see .claude/skills/probuild-schema-migration/SKILL.md).
//
// Usage:
//   node scripts/check-schema-drift.mjs [--json]
//
// Exit code 0: prod has every table/column the Prisma schema expects.
// Exit code 1: prod is missing at least one table or column.
import { PrismaClient, Prisma } from "@prisma/client";
import fs from "node:fs";

function databaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("DATABASE_URL not found in process.env, .env.local, or .env");
}

function masked(url) {
    return url.replace(/:[^:@]*@/, ":****@");
}

function expectedSchema() {
    // table name -> Set of expected column names
    const tables = new Map();
    for (const model of Prisma.dmmf.datamodel.models) {
        const tableName = model.dbName ?? model.name;
        const columns = new Set();
        for (const field of model.fields) {
            if (field.kind !== "scalar" && field.kind !== "enum") continue;
            columns.add(field.dbName ?? field.name);
        }
        tables.set(tableName, columns);
    }
    return tables;
}

async function actualSchema(prisma) {
    // table_name -> Set of column_name, for the public schema only.
    const rows = await prisma.$queryRawUnsafe(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
    );
    const tables = new Map();
    for (const row of rows) {
        if (!tables.has(row.table_name)) tables.set(row.table_name, new Set());
        tables.get(row.table_name).add(row.column_name);
    }
    return tables;
}

async function main() {
    const asJson = process.argv.includes("--json");
    const url = databaseUrl();
    const host = new URL(url).hostname;

    if (!asJson) console.log(`Checking schema drift against ${masked(url)}`);

    const expected = expectedSchema();
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    let actual;
    try {
        actual = await actualSchema(prisma);
    } finally {
        await prisma.$disconnect();
    }

    const missingTables = [];
    const missingColumns = [];

    for (const [table, columns] of expected) {
        const actualColumns = actual.get(table);
        if (!actualColumns) {
            missingTables.push(table);
            continue;
        }
        for (const column of columns) {
            if (!actualColumns.has(column)) missingColumns.push(`${table}.${column}`);
        }
    }

    if (asJson) {
        console.log(JSON.stringify({ host, missingTables, missingColumns }, null, 2));
    } else if (missingTables.length === 0 && missingColumns.length === 0) {
        console.log("No schema drift detected: production has every table and column the Prisma schema expects.");
    } else {
        if (missingTables.length > 0) {
            console.log("\nMissing tables in production:");
            for (const table of missingTables) console.log(`  - ${table}`);
        }
        if (missingColumns.length > 0) {
            console.log("\nMissing columns in production:");
            for (const column of missingColumns) console.log(`  - ${column}`);
        }
    }

    if (missingTables.length > 0 || missingColumns.length > 0) process.exitCode = 1;
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
