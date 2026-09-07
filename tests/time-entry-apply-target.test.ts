import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runTimeEntryApply } from "../scripts/lib/time-entry-apply.mjs";

test("time-entry apply CLI requires an explicit target before opening a connection", () => {
    for (const file of ["apply-clock-in-integrity.mjs", "apply-time-entry-void.mjs"]) {
        const run = spawnSync(process.execPath, [`scripts/${file}`], { encoding: "utf8", timeout: 10000, env: { ...process.env, DATABASE_URL: "postgresql://secret:do-not-print@127.0.0.1:1/wrong" } });
        assert.notEqual(run.status, 0); assert.match(run.stderr, /target/); assert.doesNotMatch(run.stdout + run.stderr, /do-not-print/);
    }
});

test("shared target preflight rejects missing/wrong project, remote CI and absent live baseline before DDL", async () => {
    const url = "postgresql://postgres.expected:do-not-print@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true";
    let connects = 0, writes = 0, disconnects = 0; const logs: string[] = [];
    const options = {
        argv: ["--target", "prod"], env: { DATABASE_URL: "ambient-must-not-win", APPLY_EXPECT_PROJECT_REF: "expected" },
        resolveUrl: (target: string) => { assert.equal(target, "prod"); return { url, from: ".env.production.local" }; },
        createClient: () => { connects++; return { $queryRawUnsafe: async (sql: string) => sql.includes("current_database") ? [{ database: "postgres" }] : [{ migration_name: "baseline" }], $disconnect: async () => { disconnects++; } }; },
        log: (line: string) => logs.push(line),
    };
    const apply = async () => { writes++; };
    await assert.rejects(runTimeEntryApply(apply, { ...options, env: {} }), /APPLY_EXPECT_PROJECT_REF/);
    await assert.rejects(runTimeEntryApply(apply, { ...options, env: { APPLY_EXPECT_PROJECT_REF: "different" } }), /project/);
    await assert.rejects(runTimeEntryApply(apply, { ...options, argv: ["--target", "ci"], resolveUrl: () => ({ url, from: "ambient" }) }), /ci/);
    assert.equal(connects, 0); assert.equal(writes, 0);
    await assert.rejects(runTimeEntryApply(apply, { ...options, createClient: () => ({ $queryRawUnsafe: async (sql: string) => sql.includes("current_database") ? [{ database: "postgres" }] : [], $disconnect: async () => {} }) }), /baseline/);
    assert.equal(writes, 0);
    await runTimeEntryApply(apply, options); assert.equal(connects, 1); assert.equal(writes, 1); assert.equal(disconnects, 1);
    assert.doesNotMatch(logs.join("\n"), /do-not-print|ambient-must-not-win/);
});
