// Fail-closed gate: compares Prisma's schema (what the built app expects to
// query) against production's actual information_schema/pg_enum, and fails
// loudly if prod is missing a table, column, or enum value the app now
// depends on.
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
// information_schema.columns and pg_catalog (pg_type/pg_enum/pg_namespace).
// It never runs DDL/DML and never applies a migration itself — that stays a
// deliberate, reviewed step (scripts/apply-*.mjs, see
// .claude/skills/probuild-schema-migration/SKILL.md).
//
// Usage:
//   node scripts/check-schema-drift.mjs [--json] [--expect-host <host>] [--expect-db <db>]
//
// Exit code 0: prod has every table/column/enum value the Prisma schema expects.
// Exit code 2: drift found (missing table, column, enum type, or enum value).
// Exit code 1: any other failure (missing/invalid DATABASE_URL, connection
//   error, host/db mismatch, empty Prisma DMMF, etc).
//
// Known gaps — NOT checked by this script:
//   implicit many-to-many join tables; column types, nullability, defaults,
//   indexes, and foreign keys.
import { PrismaClient, Prisma } from "@prisma/client";
import fs from "node:fs";

function readFlag(flag) {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function databaseUrl() {
    if (process.env.CI) {
        if (!process.env.DATABASE_URL) {
            throw new Error("DATABASE_URL is required in CI (no .env fallback) — is the secret missing?");
        }
        return process.env.DATABASE_URL;
    }
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("DATABASE_URL not found in process.env, .env.local, or .env");
}

function expectedTarget(url) {
    const parsed = new URL(url);
    return { db: decodeURIComponent(parsed.pathname.replace(/^\//, "")), host: parsed.hostname };
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

function expectedEnums() {
    // enum name -> Set of expected value labels
    const enums = new Map();
    for (const en of Prisma.dmmf.datamodel.enums) {
        const enumName = en.dbName ?? en.name;
        const values = new Set(en.values.map(v => v.dbName ?? v.name));
        enums.set(enumName, values);
    }
    return enums;
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

async function actualEnums(prisma) {
    // typname -> Set of enumlabel, for the public schema only.
    const rows = await prisma.$queryRawUnsafe(
        `SELECT t.typname, e.enumlabel FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public'`
    );
    const enums = new Map();
    for (const row of rows) {
        if (!enums.has(row.typname)) enums.set(row.typname, new Set());
        enums.get(row.typname).add(row.enumlabel);
    }
    return enums;
}

async function main() {
    const asJson = process.argv.includes("--json");
    const expectHost = readFlag("--expect-host");
    const expectDb = readFlag("--expect-db");

    const url = databaseUrl();
    const target = expectedTarget(url);

    if (expectHost && target.host !== expectHost) {
        throw new Error(`Refusing target host=${target.host}; expected host=${expectHost}`);
    }
    if (expectDb && target.db !== expectDb) {
        throw new Error(`Refusing target db=${target.db}; expected db=${expectDb}`);
    }

    if (!asJson) console.log(`Checking schema drift against host=${target.host} db=${target.db}`);

    const models = Prisma.dmmf.datamodel.models;
    if (!Array.isArray(models) || models.length === 0) {
        throw new Error("Prisma.dmmf.datamodel.models is empty — refusing to compare against an empty expected schema");
    }

    const expected = expectedSchema();
    const expectedEnumTypes = expectedEnums();

    const prisma = new PrismaClient({ datasources: { db: { url } } });
    let actual;
    let actualEnumTypes;
    try {
        actual = await actualSchema(prisma);
        actualEnumTypes = await actualEnums(prisma);
    } finally {
        await prisma.$disconnect();
    }

    const missingTables = [];
    const missingColumns = [];
    const missingEnums = [];
    const missingEnumValues = [];

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

    for (const [enumName, values] of expectedEnumTypes) {
        const actualValues = actualEnumTypes.get(enumName);
        if (!actualValues) {
            missingEnums.push(enumName);
            continue;
        }
        for (const value of values) {
            if (!actualValues.has(value)) missingEnumValues.push(`${enumName}.${value}`);
        }
    }

    const hasDrift = missingTables.length > 0 || missingColumns.length > 0
        || missingEnums.length > 0 || missingEnumValues.length > 0;

    if (asJson) {
        console.log(JSON.stringify({ host: target.host, db: target.db, missingTables, missingColumns, missingEnums, missingEnumValues }, null, 2));
    } else if (!hasDrift) {
        console.log("No schema drift detected: production has every table, column, and enum value the Prisma schema expects.");
    } else {
        if (missingTables.length > 0) {
            console.log("\nMissing tables in production:");
            for (const table of missingTables) console.log(`  - ${table}`);
        }
        if (missingColumns.length > 0) {
            console.log("\nMissing columns in production:");
            for (const column of missingColumns) console.log(`  - ${column}`);
        }
        if (missingEnums.length > 0) {
            console.log("\nMissing enum types in production:");
            for (const en of missingEnums) console.log(`  - ${en}`);
        }
        if (missingEnumValues.length > 0) {
            console.log("\nMissing enum values in production:");
            for (const value of missingEnumValues) console.log(`  - ${value}`);
        }
    }

    if (hasDrift) process.exitCode = 2;
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
