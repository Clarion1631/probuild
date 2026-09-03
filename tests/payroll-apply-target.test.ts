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
import { existsSync, readFileSync } from "node:fs";

const root = process.cwd();
const SCRIPT = path.join(root, "scripts", "apply-payroll-phase5.mjs");

/** A URL that is unmistakably NOT production. */
const LOCAL_URL = "postgresql://probuild:probuild@localhost:5433/probuild_migrations";
/** The shape production has. No credential: the password here is a literal fake. */
const PROD_URL = "postgresql://postgres.abcdefgh:not-a-real-password@aws-0-us-west-2.pooler.supabase.com:6543/postgres";
/** The project ref that URL carries. Supabase project refs are identifiers, not secrets. */
const PROD_REF = "abcdefgh";
/** Another project on the SAME regional pooler, with the same database name. */
const SIBLING_URL = "postgresql://postgres.zzzz9999:not-a-real-password@aws-0-us-west-2.pooler.supabase.com:6543/postgres";
const REF_ENV = { APPLY_EXPECT_PROJECT_REF: PROD_REF };

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
        env: REF_ENV,
    });
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.error), /REFUSING/);
    // A local URL fails the PROJECT check first — its username carries no ref at
    // all — which is the earlier and stronger refusal (round 15, finding 2).
    assert.match(String(verdict.error), /no project ref in its username/);

    // ...and the HOST check is still there behind it: a URL that carries the
    // right project ref but is not the pooler is refused too. Without this the
    // host half could have been deleted and nothing would notice.
    const rightRefWrongHost = verifyTarget({
        target: "prod",
        url: `postgresql://postgres.${PROD_REF}:pw@localhost:5433/postgres`,
        database: "postgres",
        hasBaseline: true,
        env: REF_ENV,
    });
    assert.equal(rightRefWrongHost.ok, false);
    assert.match(String(rightRefWrongHost.error), /not a \.pooler\.supabase\.com host/);
});

test("--target prod REFUSES the right host with the wrong database, or no baseline", async () => {
    const { verifyTarget } = await script();
    // A pooler host is not enough: a second project's pooler is also a pooler.
    const wrongDb = verifyTarget({ target: "prod", url: PROD_URL, database: "someone_else", hasBaseline: true, env: REF_ENV });
    assert.equal(wrongDb.ok, false);
    assert.match(String(wrongDb.error), /current_database\(\) is "someone_else"/);

    // And a database that was never built from prisma/migrations is not ours.
    const noBaseline = verifyTarget({ target: "prod", url: PROD_URL, database: "postgres", hasBaseline: false, env: REF_ENV });
    assert.equal(noBaseline.ok, false);
    assert.match(String(noBaseline.error), /20260814000000_baseline_production/);
});

test("the check runs in BOTH directions — a non-prod target against the pooler is refused", async () => {
    const { verifyTarget } = await script();
    const verdict = verifyTarget({ target: "ci", url: PROD_URL, database: "postgres", hasBaseline: true });
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.error), /is a Supabase host/);
    assert.match(String(verdict.error), /--target prod/);

    // And it is ANY Supabase host, not only the production pooler — a staging
    // project is still somebody's real data, and `--target ci` is what the CI
    // end-to-end driver runs.
    const staging = verifyTarget({
        target: "ci",
        url: "postgresql://postgres.zzzz9999:pw@db.zzzz9999.supabase.co:5432/postgres",
        database: "postgres",
        hasBaseline: true,
    });
    assert.equal(staging.ok, false);
    assert.match(String(staging.error), /is a Supabase host/);

    // ...while an ordinary throwaway database is fine, which is what CI uses.
    assert.deepEqual(
        verifyTarget({ target: "ci", url: LOCAL_URL, database: "probuild_migrations", hasBaseline: true }),
        { ok: true }
    );
});

test("the happy paths pass — the guard is not a blanket refusal", async () => {
    const { verifyTarget } = await script();
    assert.deepEqual(
        verifyTarget({ target: "prod", url: PROD_URL, database: "postgres", hasBaseline: true, env: REF_ENV }),
        { ok: true }
    );
    assert.deepEqual(verifyTarget({ target: "ci", url: LOCAL_URL, database: "probuild_migrations", hasBaseline: true }), {
        ok: true,
    });
});

test("the expectations come from env, so a pooler move needs no code change", async () => {
    const { verifyTarget, expectedProdIdentity, PROD_BASELINE_MIGRATION } = await script();
    const env = {
        APPLY_EXPECT_HOST_SUFFIX: ".example-pooler.test",
        APPLY_EXPECT_DATABASE: "probuild_prod",
        APPLY_EXPECT_PROJECT_REF: "someref",
    };
    assert.deepEqual(expectedProdIdentity(env), {
        hostSuffix: ".example-pooler.test",
        database: "probuild_prod",
        projectRef: "someref",
        baseline: PROD_BASELINE_MIGRATION,
    });
    assert.deepEqual(
        verifyTarget({
            target: "prod",
            url: "postgresql://postgres.someref:p@db.example-pooler.test:6543/probuild_prod",
            database: "probuild_prod",
            hasBaseline: true,
            env,
        }),
        { ok: true }
    );
    // ...and the default is still the real one when nothing is set. The
    // project ref has NO default: a guess about which project is production
    // is exactly what must not be baked into the repo.
    assert.equal(expectedProdIdentity().hostSuffix, ".pooler.supabase.com");
    assert.equal(expectedProdIdentity().projectRef, null);
});

test("a DIFFERENT Supabase project on the same pooler is REFUSED", async () => {
    // THE HOLE (round 15, finding 2). Pooler hosts are shared REGIONALLY: every
    // project in us-west-2 connects through the same
    // `aws-0-us-west-2.pooler.supabase.com`, and every one of them has a
    // database called `postgres` and — once built from prisma/migrations — the
    // same baseline row. So host + database + baseline identified a REGION, and
    // the round-14 verifier would have accepted any sibling project as
    // production.
    //
    // What differs is the USERNAME: `postgres.<project-ref>`.
    const { verifyTarget, projectRefFromUrl } = await script();

    // Same host, same database, same baseline — everything round 14 checked.
    const sibling = verifyTarget({
        target: "prod",
        url: SIBLING_URL,
        database: "postgres",
        hasBaseline: true,
        env: REF_ENV,
    });
    assert.equal(sibling.ok, false);
    assert.match(String(sibling.error), /Supabase project "zzzz9999"/);
    assert.match(String(sibling.error), /pooler hosts are shared/i);

    // The control: the same three fields with the RIGHT ref pass, so the
    // refusal above is about the ref and nothing else.
    assert.deepEqual(
        verifyTarget({ target: "prod", url: PROD_URL, database: "postgres", hasBaseline: true, env: REF_ENV }),
        { ok: true }
    );
    assert.equal(projectRefFromUrl(SIBLING_URL), "zzzz9999");
    assert.equal(projectRefFromUrl(PROD_URL), PROD_REF);
});

test("an UNSET expected project ref is a refusal, not a pass", async () => {
    // Fail closed. A verifier whose identity check silently switches itself off
    // when a variable is missing is the shape of every all-negative env gate
    // that has ever failed open here.
    const { verifyTarget } = await script();
    const verdict = verifyTarget({ target: "prod", url: PROD_URL, database: "postgres", hasBaseline: true, env: {} });
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.error), /APPLY_EXPECT_PROJECT_REF is not set/);
});

test("a URL with no project ref in its username is refused", async () => {
    // A plain `postgres:` username is not a Supabase pooler connection, so there
    // is nothing to compare and nothing to assume.
    const { verifyTarget, projectRefFromUrl } = await script();
    const bare = "postgresql://postgres:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres";
    assert.equal(projectRefFromUrl(bare), null);
    const verdict = verifyTarget({
        target: "prod",
        url: bare,
        database: "postgres",
        hasBaseline: true,
        env: REF_ENV,
    });
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.error), /no project ref in its username/);
});

// ---------------------------------------------------------------------------
// The printed identity carries no credential
// ---------------------------------------------------------------------------

test("the identity line is REDACTED — it goes into deploy notes", async () => {
    const { identityLine, redactUrl } = await script();
    const line = identityLine({ target: "prod", url: PROD_URL, database: "postgres", hasBaseline: true });
    assert.match(line, /target=prod/);
    // The project ref IS printed: it is an identifier (it is in every Supabase
    // dashboard URL), and it is the one field that says which project this is.
    assert.match(line, /project_ref=abcdefgh/);
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

test("the end-to-end driver is WIRED, and refuses a hosted database", () => {
    // The driver is the only thing that ever executes the apply script's
    // main() over a database it has to BUILD. A step that quietly stops
    // running is the same failure mode as a test that stops being imported.
    const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
    assert.match(ci, /node scripts\/ci-apply-payroll-phase5-e2e\.mjs/, "the driver must run in CI");
    assert.match(ci, /APPLY_E2E_SERVER_URL:/);

    const driver = readFileSync(path.join(root, "scripts", "ci-apply-payroll-phase5-e2e.mjs"), "utf8");
    // Its own database, so it cannot disturb the suites that share the job's.
    assert.match(driver, /APPLY_E2E_DB/);
    // It refuses a hosted server outright, BEFORE it drops anything — the
    // first thing it does to its target database is DROP DATABASE.
    assert.ok(driver.includes("supabase"), "the driver must recognise a Supabase host");
    assert.ok(
        driver.indexOf("REFUSING: APPLY_E2E_SERVER_URL") < driver.indexOf("DROP DATABASE"),
        "the refusal must come before anything destructive"
    );
    // ...and it drives the script through the non-prod target.
    assert.match(driver, /"--target", "ci"/);
    assert.ok(!/--target", "prod"/.test(driver), "the CI driver must never use the production target");
});
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
    const source = readFileSync(SCRIPT, "utf8");
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
