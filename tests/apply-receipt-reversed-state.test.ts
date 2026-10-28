/**
 * The REVERSED state has to exist in three places that nothing else keeps in
 * step: the runtime list, the production apply script, and the committed
 * migration. A reversal the CHECK constraint rejects is a guaranteed failure on
 * the one button meant to fix money, so they are compared here by meaning.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WANTED_DEF, WANTED_STATES } from "../scripts/apply-receipt-reversed-state.mjs";
import { RECEIPT_INTAKE_STATES } from "../src/lib/receipt-intake/route-state";

const migrationSql = readFileSync(
    path.join(__dirname, "..", "prisma", "migrations", "20261028000000_receipt_intake_reversed_state", "migration.sql"),
    "utf8",
);
const blindSpots = JSON.parse(readFileSync(path.join(__dirname, "..", "prisma", "prisma-blind-spots.json"), "utf8"));

const quoted = (sql: string) => Array.from(sql.matchAll(/'([A-Z_]{4,})'/g), m => m[1]);

test("the apply script allows exactly the runtime state set, REVERSED included", () => {
    assert.deepEqual([...WANTED_STATES].sort(), [...RECEIPT_INTAKE_STATES].sort());
    assert.ok(WANTED_STATES.includes("REVERSED"));
});

test("the migration declares the same ordered state list as the script", () => {
    const insertList = migrationSql.slice(migrationSql.indexOf('CHECK ("state" IN'));
    assert.deepEqual(quoted(insertList), WANTED_STATES);
});

test("the migration's wanted definition is character-for-character the script's", () => {
    const match = migrationSql.match(/wanted_def\s+TEXT := '(.*)';/);
    assert.ok(match, "wanted_def not found in the migration");
    assert.equal(match![1].replace(/''/g, "'"), WANTED_DEF);
});

test("the blind-spot snapshot describes the post-apply constraint", () => {
    const entry = blindSpots.checkConstraints?.find((c: { name: string }) => c.name === "ReceiptIntake_state_check")
        ?? JSON.stringify(blindSpots).includes("ReceiptIntake_state_check");
    assert.ok(entry);
    const snapshot = JSON.stringify(blindSpots);
    assert.ok(snapshot.includes(WANTED_DEF.replace(/"/g, '\\"')) || snapshot.includes(WANTED_DEF));
});

test("both the script and the migration are additive: no table or column is dropped", () => {
    const script = readFileSync(path.join(__dirname, "..", "scripts", "apply-receipt-reversed-state.mjs"), "utf8");
    for (const text of [migrationSql, script]) {
        assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(text));
        assert.ok(!/\bDELETE\s+FROM\b/i.test(text));
    }
});

test("the script carries the shared target gate and a transaction timeout longer than lock_timeout", () => {
    const script = readFileSync(path.join(__dirname, "..", "scripts", "apply-receipt-reversed-state.mjs"), "utf8");
    assert.match(script, /resolveTargetOrRefuse\(process\.argv\)/);
    assert.match(script, /verifyTargetIdentity\(/);
    assert.match(script, /--expect-db/);
    assert.match(script, /--expect-host/);
    const lock = Number(/LOCK_TIMEOUT_MS = (\d+)/.exec(script)?.[1]);
    const tx = Number(/TRANSACTION_TIMEOUT_MS = (\d+)/.exec(script)?.[1]);
    assert.ok(lock > 0 && tx > lock, `transaction timeout ${tx} must exceed lock_timeout ${lock}`);
    assert.ok(!/matching every sibling|matches every sibling/i.test(script));
});

test("rerunning the ORIGINAL apply script can no longer reset the CHECK: it allows REVERSED too", async () => {
    const { RECEIPT_INTAKE_STATES: original } = await import("../scripts/apply-receipt-intake.mjs");
    assert.deepEqual([...original].sort(), [...WANTED_STATES].sort());
});
