/**
 * The apply script against an ALREADY-APPLIED database.
 *
 * Production received this migration on 2026-09-02 (an import of the script
 * executed it as a side effect — see the guard in the script's own header). The
 * documented deploy command therefore has to be a safe no-op against that state,
 * and `--dry-run` has to be genuinely read-only, because it is now the
 * verification step for this PR rather than a real apply.
 *
 * This proves both against the migrations job's throwaway Postgres, which
 * `prisma migrate deploy` has already brought to the same applied shape. It
 * never touches production.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";
const root = process.cwd();

/**
 * Every invocation names its target. The script has no default any more: it
 * used to take whatever DATABASE_URL happened to be in the environment, which
 * is exactly what these tests set (round 14, finding 1). `ci` is a non-prod
 * target, so the script uses the ordinary env chain and then REFUSES if that
 * turns out to point at the production pooler.
 */
const TARGET = ["--target", "ci"];

function runScript(args: string[]): string {
    return execFileSync(process.execPath, [path.join(root, "scripts", "apply-payroll-phase5.mjs"), ...TARGET, ...args], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: databaseUrl!, DIRECT_URL: databaseUrl! },
        encoding: "utf8",
        stdio: "pipe",
    });
}

/**
 * The same run, but the EXIT CODE is the thing under test.
 *
 * runScript() throws on a nonzero exit, which was fine while `--dry-run`
 * always exited 0 — and that was the bug: a verification step that cannot fail
 * verifies nothing. Drift now exits 1, so the drift case needs a runner that
 * returns the status instead of throwing on it.
 */
function runScriptForStatus(args: string[]): { status: number | null; out: string } {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "apply-payroll-phase5.mjs"), ...TARGET, ...args], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: databaseUrl!, DIRECT_URL: databaseUrl! },
        encoding: "utf8",
    });
    return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("--dry-run reports 'nothing to do' once every object is present", { skip }, async () => {
    // Apply for real first, so the database is in the state production is in.
    runScript([]);

    const clean = runScriptForStatus(["--dry-run"]);
    const out = clean.out;
    assert.match(out, /nothing to do/, out);
    assert.match(out, /no statement was executed/);
    // The control for the drift case below: a matching database exits 0, so
    // that test's `status === 1` is about the drift and not about the script
    // failing for some unrelated reason.
    assert.equal(clean.status, 0, out);
    assert.doesNotMatch(out, /FAILED/, out);
    // Nothing was guessed: the seed reports itself as a no-op when the env var
    // is unset, which is exactly production's configuration.
    assert.match(out, /PAYROLL_SALARIED_EMAILS is not set/);
});

test("--dry-run executes NO statement — it is safe to point at production", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        // Drop one object, dry-run, and assert it is still missing afterwards.
        // A dry run that repairs anything is not a dry run.
        await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "PayrollPeriod_discardedAt_idx"`);

        const { status, out } = runScriptForStatus(["--dry-run"]);
        // Round 20 replaced the presence-only check with a definition-level one,
        // so the wording is "missing or drifted" and each line is prefixed with
        // the table. This assertion was left describing the old output.
        assert.match(out, /1 of \d+ object\(s\) are missing or drifted/, out);
        assert.match(out, /index PayrollPeriod\.PayrollPeriod_discardedAt_idx: missing/, out);
        // Drift is a FAILURE. The dry run is the verification step of a deploy,
        // so a caller that reads the exit code has to be able to tell this apart
        // from a clean database — it exited 0 for both until now.
        assert.equal(status, 1, out);
        assert.match(out, /FAILED: 1 drift item\(s\)/, out);

        const after = (await db.$queryRawUnsafe(
            `SELECT 1 FROM pg_indexes WHERE indexname = 'PayrollPeriod_discardedAt_idx'`
        )) as unknown[];
        assert.equal(after.length, 0, "the dry run must not have created it");

        // And the real run repairs it, which is what makes the report meaningful.
        runScript([]);
        const repaired = (await db.$queryRawUnsafe(
            `SELECT 1 FROM pg_indexes WHERE indexname = 'PayrollPeriod_discardedAt_idx'`
        )) as unknown[];
        assert.equal(repaired.length, 1);
    } finally {
        await db.$disconnect();
    }
});

test("running the documented command twice is a no-op the second time", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        runScript([]);
        const first = (await db.$queryRawUnsafe(
            `SELECT conname, confdeltype FROM pg_constraint
              WHERE conrelid = '"TimeEntry"'::regclass
                AND conname IN ('TimeEntry_userId_fkey','TimeEntry_projectId_fkey') ORDER BY conname`
        )) as Array<{ conname: string; confdeltype: string }>;

        // Second run: must succeed and change nothing.
        runScript([]);
        const second = (await db.$queryRawUnsafe(
            `SELECT conname, confdeltype FROM pg_constraint
              WHERE conrelid = '"TimeEntry"'::regclass
                AND conname IN ('TimeEntry_userId_fkey','TimeEntry_projectId_fkey') ORDER BY conname`
        )) as Array<{ conname: string; confdeltype: string }>;

        assert.deepEqual(second, first);
        for (const row of second) {
            assert.equal(row.confdeltype, "r", `${row.conname} must stay RESTRICT across re-runs`);
        }
        // And the dry run agrees there is nothing left to do.
        assert.match(runScript(["--dry-run"]), /nothing to do/);
    } finally {
        await db.$disconnect();
    }
});

test("the CHECK constraints come back VALIDATED, not NOT VALID", { skip }, async () => {
    runScript([]);
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        const rows = (await db.$queryRawUnsafe(
            `SELECT conname FROM pg_constraint
              WHERE conrelid = '"PayrollPeriod"'::regclass
                AND conname = 'PayrollPeriod_discard_unlocked' AND convalidated`
        )) as unknown[];
        // An unvalidated constraint is not enforced for existing rows, so prod
        // would silently disagree with CI's replay of the same file.
        assert.equal(rows.length, 1);
    } finally {
        await db.$disconnect();
    }
});
