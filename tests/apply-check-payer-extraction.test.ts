import assert from "node:assert/strict";
import test from "node:test";
import {
    BANK_IMAGE_CONSTRAINT_QUERY,
    BANK_IMAGE_FOUNDATION_PREFLIGHT_QUERY,
    constraintDefinitionMatches,
    missingFoundationTables,
    runPayerExtractionMigration,
    statements,
    targetMatches,
    wrongColumnDefinitions,
} from "../scripts/apply-check-payer-extraction.mjs";

test("same-named constraint on another relation does not satisfy BankImage constraint lookup", () => {
    assert.match(BANK_IMAGE_CONSTRAINT_QUERY, /conname = 'BankImage_extraction_pair'/);
    assert.match(BANK_IMAGE_CONSTRAINT_QUERY, /conrelid = 'public\."BankImage"'::regclass/);

    const addConstraintStatement = statements.at(-1) ?? "";
    assert.match(addConstraintStatement, /conname = 'BankImage_extraction_pair'/);
    assert.match(addConstraintStatement, /conrelid = 'public\."BankImage"'::regclass/);
});

test("migration preflight is read-only and requires both BankImage foundation tables", () => {
    const preflight = BANK_IMAGE_FOUNDATION_PREFLIGHT_QUERY;
    assert.match(preflight, /information_schema\.tables/);
    assert.match(preflight, /table_type = 'BASE TABLE'/);
    assert.match(preflight, /'BankImage'/);
    assert.match(preflight, /'BankImageMatch'/);
    assert.doesNotMatch(preflight, /\bALTER\b|\bCREATE\b|\bDROP\b|\bUPDATE\b|\bDELETE\b|\bINSERT\b/i);
    assert.deepEqual(missingFoundationTables([{ table_name: "BankImage" }]), ["BankImageMatch"]);
    assert.deepEqual(
        missingFoundationTables([{ table_name: "BankImage" }, { table_name: "BankImageMatch" }]),
        [],
    );
});

test("target host must match exactly, never as a prefix", () => {
    assert.equal(targetMatches({ db: "ledger", host: "10.0.0.1" }, "ledger", "10.0.0.1"), true);
    assert.equal(targetMatches({ db: "ledger", host: "10.0.0.12" }, "ledger", "10.0.0.1"), false);
});

test("constraint verification rejects a same-name check with the wrong invariant", () => {
    assert.equal(
        constraintDefinitionMatches('CHECK ((("extractedAt" IS NULL) = ("extractionModel" IS NULL)))'),
        true,
    );
    assert.equal(constraintDefinitionMatches("CHECK (true)"), false);
});

test("post-DDL verification requires TIMESTAMPTZ(6), not a lower-precision lookalike", () => {
    const baseColumns = [
        { column_name: "payerName", data_type: "text", datetime_precision: null },
        { column_name: "memoText", data_type: "text", datetime_precision: null },
        { column_name: "extractedAt", data_type: "timestamp with time zone", datetime_precision: 6 },
        { column_name: "extractionModel", data_type: "text", datetime_precision: null },
    ];
    assert.deepEqual(wrongColumnDefinitions(baseColumns), []);
    assert.deepEqual(
        wrongColumnDefinitions(baseColumns.map(column =>
            column.column_name === "extractedAt" ? { ...column, datetime_precision: 0 } : column,
        )),
        ["extractedAt"],
    );
});

test("failed foundation preflight rejects before any DDL can run", async () => {
    let executedStatements = 0;
    const prisma = {
        async $queryRawUnsafe(sql: string) {
            if (sql.includes("current_database()")) return [{ db: "ledger", host: "10.0.0.1" }];
            if (sql === BANK_IMAGE_FOUNDATION_PREFLIGHT_QUERY) return [{ table_name: "BankImage" }];
            throw new Error(`unexpected query: ${sql}`);
        },
        async $executeRawUnsafe() {
            executedStatements += 1;
        },
    };

    await assert.rejects(
        runPayerExtractionMigration({ prisma, expectDb: "ledger", expectHost: "10.0.0.1", write: () => {} }),
        /PREFLIGHT FAILED: missing foundation table\(s\): BankImageMatch/,
    );
    assert.equal(executedStatements, 0, "a missing foundation must stop before the first DDL statement");
});
