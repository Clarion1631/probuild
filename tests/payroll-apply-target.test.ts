/**
 * WHICH DATABASE DID THE DEPLOY STEP ACTUALLY TOUCH? (round 14, finding 1 — a P0)
 *
 * scripts/apply-payroll-phase5.mjs loaded .env.production.local WITHOUT
 * `override`, then used `process.env.DATABASE_URL`. dotenv does not overwrite a
 * variable that is already set, so a developer with a local URL exported in
 * their shell got the LOCAL database — silently. The script then printed a
 * clean apply and a clean `--dry-run`, which is the evidence this PR's deploy
 * step is gated on, while production still lacked `payrollRevision` and the
 * merged code required it. Nothing in the output named the database.
 *
 * The fix is three things, and the cases below cover each:
 *   1. `--target` is REQUIRED — no default, so nothing is guessed.
 *   2. `--target prod` reads DATABASE_URL out of .env.production.local's own
 *      parse result, so an ambient one is not outranked, it is never consulted.
 *   3. After connecting the script asks the database who it is and refuses on a
 *      mismatch IN BOTH DIRECTIONS — prod that is not the pooler, and any other
 *      target that IS.
 *
 * The identity is printed before the first statement, redacted, because this
 * output goes into deploy notes and PR comments.
 *
 * The pure helpers are exercised directly; the flag and env-precedence halves
 * are exercised by RUNNING the script, because "does an ambient DATABASE_URL
 * win?" is a question about dotenv's behaviour and not about our own code.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

const root = process.cwd();
const SCRIPT = path.join(root, "scripts", "apply-payroll-phase5.mjs");

/** A URL that is unmistakably NOT production. */
const LOCAL_URL = "postgresql://probuild:probuild@localhost:5433/probuild_migrations";
/** The shape production has. No credential: the password here is a literal fake. */
const PROD_URL = "postgresql://postgres.abcdefgh:not-a-real-password@aws-0-us-west-2.pooler.supabase.com:6543/postgres";

async function script() {
    return import("../scripts/apply-payroll-phase5.mjs");
}

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------

test("--target is required, and needs a value", async () => {
    const { parseTarget } = await script();
    assert.equal(parseTarget(["node", "s.mjs"]).ok, false);
    assert.match(String(parseTarget(["node", "s.mjs"]).error), /--target is required/);
    // A bare `--target` followed by another flag is a mistake, not a target
    // called "--dry-run".
    assert.equal(parseTarget(["node", "s.mjs", "--target"]).ok, false);
    assert.equal(parseTarget(["node", "s.mjs", "--target", "--dry-run"]).ok, false);

    assert.deepEqual(parseTarget(["node", "s.mjs", "--target", "prod"]), { ok: true, target: "prod" });
    assert.deepEqual(parseTarget(["node", "s.mjs", "--target", "ci", "--dry-run"]), { ok: true, target: "ci" });
});

// ---------------------------------------------------------------------------
// The identity check
// ---------------------------------------------------------------------------

test("--target prod REFUSES a local database — the exact incident", async () => {
    const { verifyTarget } = await script();
    const verdict = verifyTarget({
        target: "prod",
        url: LOCAL_URL,
        database: "probuild_migrations",
        hasBaseline: true,
    });
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.error), /REFUSING/);
    assert.match(String(verdict.error), /not a \.pooler\.supabase\.com host/);
});

test("--target prod REFUSES the right host with the wrong database, or no baseline", async () => {
    const { verifyTarget } = await script();
    // A pooler host is not enough: a second project's pooler is also a pooler.
    const wrongDb = verifyTarget({ target: "prod", url: PROD_URL, database: "someone_else", hasBaseline: true });
    assert.equal(wrongDb.ok, false);
    assert.match(String(wrongDb.error), /current_database\(\) is "someone_else"/);

    // And a database that was never built from prisma/migrations is not ours.
    const noBaseline = verifyTarget({ target: "prod", url: PROD_URL, database: "postgres", hasBaseline: false });
    assert.equal(noBaseline.ok, false);
    assert.match(String(noBaseline.error), /20260814000000_baseline_production/);
});

test("the check runs in BOTH directions — a non-prod target against the pooler is refused", async () => {
    const { verifyTarget } = await script();
    const verdict = verifyTarget({ target: "ci", url: PROD_URL, database: "postgres", hasBaseline: true });
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.error), /IS the production pooler/);
    assert.match(String(verdict.error), /--target prod/);
});

test("the happy paths pass — the guard is not a blanket refusal", async () => {
    const { verifyTarget } = await script();
    assert.deepEqual(verifyTarget({ target: "prod", url: PROD_URL, database: "postgres", hasBaseline: true }), {
        ok: true,
    });
    assert.deepEqual(verifyTarget({ target: "ci", url: LOCAL_URL, database: "probuild_migrations", hasBaseline: true }), {
        ok: true,
    });
});

test("the expectations come from env, so a pooler move needs no code change", async () => {
    const { verifyTarget, expectedProdIdentity, PROD_BASELINE_MIGRATION } = await script();
    const env = {
        PAYROLL_APPLY_EXPECT_HOST_SUFFIX: ".example-pooler.test",
        PAYROLL_APPLY_EXPECT_DATABASE: "probuild_prod",
    };
    assert.deepEqual(expectedProdIdentity(env), {
        hostSuffix: ".example-pooler.test",
        database: "probuild_prod",
        baseline: PROD_BASELINE_MIGRATION,
    });
    assert.deepEqual(
        verifyTarget({
            target: "prod",
            url: "postgresql://u:p@db.example-pooler.test:6543/probuild_prod",
            database: "probuild_prod",
            hasBaseline: true,
            env,
        }),
        { ok: true }
    );
    // ...and the default is still the real one when nothing is set.
    assert.equal(expectedProdIdentity().hostSuffix, ".pooler.supabase.com");
});

// ---------------------------------------------------------------------------
// The printed identity carries no credential
// ---------------------------------------------------------------------------

test("the identity line is REDACTED — it goes into deploy notes", async () => {
    const { identityLine, redactUrl } = await script();
    const line = identityLine({ target: "prod", url: PROD_URL, database: "postgres", hasBaseline: true });
    assert.match(line, /target=prod/);
    assert.match(line, /aws-0-us-west-2\.pooler\.supabase\.com:6543\/postgres/);
    assert.match(line, /current_database=postgres/);
    assert.match(line, /baseline=present/);

    // THE point: no user, no password, anywhere in it.
    assert.ok(!line.includes("not-a-real-password"), line);
    assert.ok(!line.includes("postgres.abcdefgh"), line);
    assert.ok(!/:\/\//.test(line), "no scheme means no chance of a credential riding along");

    // A missing baseline says so rather than being omitted.
    assert.match(identityLine({ target: "ci", url: LOCAL_URL, database: "x", hasBaseline: false }), /baseline=ABSENT/);
    // And an unparseable URL degrades to a label, not to a raw dump.
    assert.equal(redactUrl("not a url"), "(unparseable DATABASE_URL)");
});

// ---------------------------------------------------------------------------
// Through the real script: the flag, and dotenv's precedence
// ---------------------------------------------------------------------------

function run(args: string[], env: Record<string, string>) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: "utf8",
    });
    return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Nothing ran: no DDL echo, no drift report, no seed line. */
function assertExecutedNothing(out: string) {
    assert.ok(!/^ok: /m.test(out), `a statement was executed:\n${out}`);
    assert.ok(!/nothing to do/.test(out), `it reached the drift report:\n${out}`);
    assert.ok(!/seeded \d+ user/.test(out), `it reached the seed:\n${out}`);
}

test("no --target is a usage error, and nothing runs", () => {
    const { status, out } = run([], { DATABASE_URL: LOCAL_URL });
    assert.equal(status, 1);
    assert.match(out, /--target is required/);
    assert.match(out, /usage: node scripts\/apply-payroll-phase5\.mjs --target/);
    assertExecutedNothing(out);
});

test("an ambient DATABASE_URL cannot serve --target prod", () => {
    // THE incident, reproduced: a local URL exported in the shell. It used to be
    // taken silently. Now the ambient value is not consulted at all for this
    // target, so with no .env.production.local present the script refuses
    // instead of applying to the laptop and reporting success.
    //
    // (This worktree has no .env.production.local — asserted, so the case cannot
    // quietly stop testing what it says it tests.)
    assert.equal(existsSync(path.join(root, ".env.production.local")), false);

    const { status, out } = run(["--target", "prod"], { DATABASE_URL: LOCAL_URL });
    assert.equal(status, 1);
    assert.match(out, /REFUSING/);
    assert.match(out, /\.env\.production\.local/);
    assert.match(out, /ambient DATABASE_URL is deliberately ignored/);
    assertExecutedNothing(out);

    // And the same with --dry-run: the verification step refuses too, rather
    // than printing a clean report about the wrong database.
    const dry = run(["--target", "prod", "--dry-run"], { DATABASE_URL: LOCAL_URL });
    assert.equal(dry.status, 1);
    assertExecutedNothing(dry.out);
});

test("the script asks the database who it is BEFORE the first statement", () => {
    // Source order, because the behavioural cases above stop earlier than this
    // and an edit that moved the check below the DDL loop would not fail them.
    const source = require("node:fs").readFileSync(SCRIPT, "utf8") as string;
    const main = source.slice(source.indexOf("async function main()"));
    const identity = main.indexOf("current_database() AS db");
    const refusal = main.indexOf("if (!targetVerdict.ok)");
    const dryRunBranch = main.indexOf("if (dryRun) {");
    const ddl = main.indexOf("for (const sql of STATEMENTS)");
    assert.ok(identity > 0 && refusal > 0 && dryRunBranch > 0 && ddl > 0);
    assert.ok(identity < refusal, "ask first, then decide");
    assert.ok(refusal < dryRunBranch, "the refusal precedes even the read-only report");
    assert.ok(refusal < ddl, "and certainly precedes the DDL");
});
