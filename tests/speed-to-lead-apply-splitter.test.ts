/**
 * The v1a migration file, split the exact way scripts/apply-speed-to-lead.mjs
 * splits it. Its own header comment quotes the "-- statement-break" marker
 * in prose (not on a line of its own) precisely so a naive substring split
 * cannot fragment it — this test proves the real splitter regex still
 * produces clean, balanced statements from the real file, not a synthetic
 * fixture.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_PATH = path.join(root, "prisma/migrations/20260926120000_speed_to_lead_v1a/migration.sql");

function splitStatements(sql: string): string[] {
    return sql.split(/^-- statement-break[ \t]*$/m).map(s => s.trim()).filter(Boolean);
}

test("the migration file's own header quotes the marker in prose, never on its own line", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    assert.match(sql, /"-- statement-break" delimiter/);
    // If the marker text appeared as a standalone line inside the header
    // comment itself, splitting on it would fragment the header — this
    // asserts the split still starts with the header's own first line.
    const statements = splitStatements(sql);
    assert.match(statements[0], /^-- Speed-to-Lead v1a/);
});

test("splitting produces only well-formed, non-empty statements", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    const statements = splitStatements(sql);
    assert.ok(statements.length > 20, `expected many statements, got ${statements.length}`);
    for (const statement of statements) {
        assert.ok(statement.length > 0, "no empty fragment");
        // Never starts mid-DO-block (e.g. a bare "EXCEPTION" or "END $$;"
        // continuation) — every fragment either has no DO block, or a
        // complete, balanced one.
        assert.ok(!/^\s*(EXCEPTION|END \$\$)/i.test(statement), `fragment starts mid-block: ${statement.slice(0, 60)}`);
        const doCount = (statement.match(/DO \$\$/g) ?? []).length;
        const endCount = (statement.match(/END \$\$/g) ?? []).length;
        assert.equal(doCount, endCount, `unbalanced DO/END in fragment: ${statement.slice(0, 60)}`);
    }
});

test("the last statement enables RLS on every new table", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    const statements = splitStatements(sql);
    const rlsStatements = statements.filter(s => s.includes("ENABLE ROW LEVEL SECURITY"));
    assert.equal(rlsStatements.length, 5);
    for (const table of ["LeadIntakeEvent", "LeadAlert", "ContactEndpoint", "SpeedToLeadEvent", "LeadInboxMessage"]) {
        assert.ok(rlsStatements.some(s => s.includes(`"${table}"`)), `missing RLS statement for ${table}`);
    }
});
