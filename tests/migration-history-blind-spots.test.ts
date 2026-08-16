import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { statements } from "../scripts/apply-bank-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = path.join(root, "prisma", "prisma-blind-spots.json");
const databaseUrl = process.env.MIGRATION_HISTORY_TEST_URL;
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");

// This test exercises the catalog-facing scripts on a disposable database.
// It intentionally needs an explicit opt-in URL so a normal unit-test run
// cannot mutate a developer database. The migration-history CI job supplies
// that URL from its Postgres service container.
test(
    "migration history checker rejects drifted Prisma-blind functions and triggers",
    { skip: !databaseUrl && "set MIGRATION_HISTORY_TEST_URL to a disposable PostgreSQL URL" },
    async () => {
        const env = { ...process.env, DATABASE_URL: databaseUrl!, DIRECT_URL: databaseUrl! };
        const originalSnapshot = readFileSync(snapshotPath, "utf8");
        const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

        try {
            execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
                cwd: root,
                env,
                stdio: "pipe",
            });
            for (const sql of statements) await db.$executeRawUnsafe(sql);

            execFileSync("node", ["scripts/snapshot-prisma-blind-spots.mjs", "--write"], {
                cwd: root,
                env,
                stdio: "pipe",
            });
            const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

            // A production regression that removes either query from the
            // snapshotter leaves these undefined. The assertions are catalog
            // behavior, not a source-text grep.
            assert.ok(Array.isArray(snapshot.functions), "snapshot must include PostgreSQL functions");
            assert.ok(Array.isArray(snapshot.triggers), "snapshot must include PostgreSQL triggers");
            assert.ok(snapshot.functions.some((row: { name: string }) => row.name === "check_bank_line_amount_immutable()"));
            assert.ok(
                snapshot.triggers.some(
                    (row: { table: string; name: string }) =>
                        row.table === "BankLine" && row.name === "bank_line_amount_immutable_trigger",
                ),
            );

            const assertCheckerRejects = (objectClass: string, name: string) => {
                const check = spawnSync("node", ["scripts/check-migrations-match.mjs"], {
                    cwd: root,
                    env,
                    encoding: "utf8",
                });
                assert.notEqual(check.status, 0, `the checker must reject a changed blind ${objectClass} definition`);
                assert.match(check.stderr, new RegExp(`${objectClass} [\\s\\S]*${name}[\\s\\S]*DIFFERENT definition`));
            };

            await db.$executeRawUnsafe(`
                CREATE OR REPLACE FUNCTION check_bank_line_amount_immutable() RETURNS TRIGGER AS $BODY$
                BEGIN
                  RETURN NEW;
                END;
                $BODY$ LANGUAGE plpgsql
            `);
            assertCheckerRejects("function", "check_bank_line_amount_immutable");

            const productionFunction = snapshot.functions.find(
                (row: { name: string }) => row.name === "check_bank_line_amount_immutable()",
            );
            assert.ok(productionFunction, "snapshot must retain the production function definition");
            await db.$executeRawUnsafe(productionFunction.def);

            await db.$executeRawUnsafe('DROP TRIGGER bank_line_amount_immutable_trigger ON "BankLine"');
            await db.$executeRawUnsafe(`
                CREATE TRIGGER bank_line_amount_immutable_trigger
                AFTER UPDATE ON "BankLine"
                FOR EACH ROW EXECUTE FUNCTION check_bank_line_amount_immutable()
            `);
            assertCheckerRejects("trigger", "bank_line_amount_immutable_trigger");
        } finally {
            await db.$disconnect();
            writeFileSync(snapshotPath, originalSnapshot, "utf8");
        }
    },
);
