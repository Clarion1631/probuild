/**
 * The rollout script and the committed migration must describe the SAME
 * columns.
 *
 * They are written twice on purpose — the script is what PRODUCTION gets
 * (before the deploy that selects these columns), the migration is what a fresh
 * CI/dev database gets — and nothing else in the repo notices when the two
 * drift. CI's `migrations` job would eventually catch a difference by diffing
 * against production, but only AFTER the script has been run there, which is
 * exactly the wrong time to find out.
 *
 * Importing the script must NOT open a connection or read DATABASE_URL: all of
 * that sits behind the isMainModule guard, the same shape apply-receipt-intake
 * has.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { resolveTargetOrRefuse } from "../scripts/lib/apply-target.mjs";
import {
    APPLY_TARGETS,
    PRODUCTION_BASELINE_MIGRATION,
    parseTarget,
    projectRefFromUrl,
    projectRefVerdict,
    resolveTargetDatabaseUrl,
    targetBanner,
    targetHostVerdict,
    expectedCheckConstraints,
    expectedColumns,
    expectedConstraints,
    expectedIndexes,
    expectedReceiptIntakeColumns,
    normalizeCheckDefinition,
    backfillStatements,
    DDL_STATEMENTS,
    INDEX_STATEMENTS,
    PHASE_A_STEPS,
    toConcurrentIndexSql,
    AMOUNT_TAX_GUARD_DROP_SQL,
    AMOUNT_TAX_GUARD_SQL,
    COMPATIBILITY_TRIGGERS,
    indexDrift,
    needsReanchorPredicate,
    pickCompanyTimeZone,
    MISMATCHED_PAIRS_QUERY,
    postDeployStatements,
    postDeployTeardownStatements,
    PROJECT_ID_BACKFILL,
    PROJECT_ID_BACKFILL_LOCK_PROJECTS,
    reanchorSql,
    SOURCE_FILE_ID_BACKFILL,
    SPLIT_JOB_GUARD_DROP_SQL,
    SOURCE_FILE_BRIDGE_DROP_SQL,
    SOURCE_FILE_BRIDGE_SQL,
    SPLIT_JOB_GUARD_SQL,
    SPLIT_JOB_REPAIR,
    SPLIT_JOB_REPAIR_LOCK_PROJECTS,
    statements,
    targetMatches,
} from "../scripts/apply-expense-attribution.mjs";
import {
    HUMAN_TAX_SOURCES,
    TAX_CLASSIFICATION_COLUMNS,
    TAX_CLASSIFICATION_FIGURE_COLUMNS,
    TAX_CLASSIFICATION_SOURCE_COLUMNS,
} from "../src/lib/expense-attribution";

const migrationSql = readFileSync(
    path.join(__dirname, "..", "prisma", "migrations", "20260901120000_expense_attribution", "migration.sql"),
    "utf8",
);

/** Compare SQL by meaning, not by indentation: collapse whitespace, drop comments. */
function normalize(sql: string): string {
    return sql
        .split(/\r?\n/)
        .filter(line => !/^\s*--/.test(line))
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/\s*([(),])\s*/g, "$1")
        .trim()
        .toLowerCase();
}

const normalizedMigration = normalize(migrationSql);

test("every statement the apply script runs is in the committed migration", () => {
    for (const statement of statements as string[]) {
        const wanted = normalize(statement).replace(/;$/, "");
        assert.ok(
            normalizedMigration.includes(wanted),
            `migration.sql is missing:\n  ${wanted}`,
        );
    }
});

test("the migration adds no Expense column the apply script does not", () => {
    // The reverse direction: a column added ONLY to the migration would exist
    // on a fresh CI database and be absent from production, which is the
    // failure mode P2022 shows up as.
    const migrationColumns = [...migrationSql.matchAll(/ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "(\w+)"/g)]
        .map(m => m[1])
        .sort();
    const scriptColumns = (statements as string[])
        .flatMap(s => [...s.matchAll(/ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "(\w+)"/g)].map(m => m[1]))
        .sort();
    assert.deepEqual(migrationColumns, scriptColumns);
    assert.deepEqual(scriptColumns, [...expectedColumns.Expense].sort());
});

test("the ReceiptIntake columns are behind a to_regclass guard in both files", () => {
    // Phase 1 and Phase 3 can land in either order. Without the guard, running
    // this against a database that has not seen Phase 1 yet aborts partway and
    // leaves the Expense half applied.
    const guarded = (statements as string[]).find(s => s.includes("ReceiptIntake"));
    assert.ok(guarded, "the script must touch ReceiptIntake");
    assert.match(guarded!, /to_regclass\('"ReceiptIntake"'\) IS NOT NULL/);
    assert.match(migrationSql, /to_regclass\('"ReceiptIntake"'\) IS NOT NULL/);
    for (const column of ["taxAtSource", "installedAtCustomer"]) {
        assert.ok(guarded!.includes(`"${column}"`), `script guard is missing ${column}`);
        assert.ok(migrationSql.includes(`"${column}"`), `migration is missing ${column}`);
    }
});

test("the backfill UPDATE only ever touches rows whose projectId is still NULL", () => {
    // This is the whole of its idempotency. A re-run must report 0 rows, and a
    // manual re-attribution must survive it.
    // Selected by what it WRITES, not by "the first UPDATE" — the script
    // carries a second one (the updatedAt backfill), and a positional match
    // would have silently started asserting about the wrong statement. It no
    // longer STARTS with UPDATE either: the projectId fill is a data-modifying
    // CTE so it can lock the estimates it reads from.
    const update = (statements as string[]).find(s => s.includes('SET "projectId"'));
    assert.ok(update, "the script must carry the backfill UPDATE");
    assert.equal(update, PROJECT_ID_BACKFILL, "the array holds the exported constant, not a copy");
    assert.match(update!, /e\."projectId" IS NULL/);
    assert.match(update!, /est\."projectId" IS NOT NULL/);
});

test("the backfill LOCKS the estimates it reads its answer from", () => {
    // Codex round 32. A bare `UPDATE ... FROM "Estimate"` join takes no row
    // lock: under READ COMMITTED the statement reads est."projectId" at its own
    // snapshot, and an estimate moved right after that read leaves the expense
    // stamped with the job it has already left. One statement, so there is no
    // window between locking and writing for a phantom to arrive in.
    assert.match(PROJECT_ID_BACKFILL, /FOR SHARE/, "the estimate read is locked");
    assert.match(PROJECT_ID_BACKFILL, /ORDER BY est\.id/, "ascending ids, like lockMoneyParentsMany");
    assert.ok(
        PROJECT_ID_BACKFILL.trimStart().toUpperCase().startsWith("WITH"),
        "the lock and the write are ONE statement",
    );
    assert.ok(
        PROJECT_ID_BACKFILL.indexOf("FOR SHARE") < PROJECT_ID_BACKFILL.indexOf("UPDATE"),
        "the rows are locked before they are written from",
    );
    // ...and the row count is still printed. The runner keyed off "UPDATE" at
    // the head of the statement, which this no longer is — losing that count
    // would silently retire the script's only idempotency proof.
    const source = readFileSync(
        path.join(__dirname, "..", "scripts", "apply-expense-attribution.mjs"),
        "utf8",
    );
    const ROW_COUNT_MATCHER = /^(UPDATE|WITH)\b/i;
    assert.ok(
        source.includes("/^(UPDATE|WITH)\\b/i.test(sql.trimStart())"),
        "the runner must still decide the row-count print from the statement head",
    );
    assert.ok(
        ROW_COUNT_MATCHER.test(PROJECT_ID_BACKFILL.trimStart()),
        "and that matcher must actually match the backfill statement",
    );
});

test("the pair is verified in BOTH directions after the run", () => {
    // The original verification asked only "is any expense still NULL against
    // an estimate that knows a project?". A row whose projectId DISAGREES with
    // its estimate's — one expense on two jobs — passes that check perfectly,
    // and it is exactly what an unlocked backfill or an unguarded estimate move
    // produces.
    assert.match(MISMATCHED_PAIRS_QUERY, /COUNT\(\*\)::int AS n/);
    assert.match(MISMATCHED_PAIRS_QUERY, /e\."projectId" IS NOT NULL/);
    assert.match(MISMATCHED_PAIRS_QUERY, /est\."projectId" IS NOT NULL/);
    assert.match(MISMATCHED_PAIRS_QUERY, /e\."projectId" <> est\."projectId"/);

    const source = readFileSync(
        path.join(__dirname, "..", "scripts", "apply-expense-attribution.mjs"),
        "utf8",
    );
    assert.ok(
        source.includes("$queryRawUnsafe(MISMATCHED_PAIRS_QUERY)"),
        "main() must actually run it, not merely export it",
    );
    // The COUNT is REPORTED whatever it is — a verification that only speaks up
    // on failure cannot be read as evidence that it ran.
    assert.match(source, /disagree with their estimate's project/);
    assert.match(source, /mismatched\.n !== 0/);
    assert.match(source, /VERIFY FAILED: \$\{mismatched\.n\}/);
});

test("the FK is SET NULL, named the way Prisma would name it, and guarded on its DEFINITION", () => {
    // A name-only `IF NOT EXISTS` would silently accept a pre-existing
    // Expense_projectId_fkey that points at another table or carries ON DELETE
    // CASCADE — exactly the thing SET NULL is here to prevent. Existing-and-
    // wrong must RAISE, not be skipped.
    const fk = (statements as string[]).find(s => s.includes("Expense_projectId_fkey"));
    assert.ok(fk);
    assert.match(fk!, /pg_get_constraintdef\(oid\)/);
    assert.match(fk!, /ON DELETE SET NULL ON UPDATE CASCADE/);
    // The in-database guard must check the SAME four properties the post-run
    // verifier does, or the two can disagree about what "correct" means.
    assert.match(fk!, /NOT LIKE '%FOREIGN KEY \("projectId"\)%'/);
    assert.match(fk!, /NOT LIKE '%REFERENCES "Project"\(id\)%'/);
    assert.match(fk!, /NOT LIKE '%ON DELETE SET NULL%'/);
    assert.match(fk!, /NOT LIKE '%ON UPDATE CASCADE%'/);
    assert.match(fk!, /RAISE EXCEPTION/);
    assert.ok(
        !/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/.test(fk!),
        "the name-only guard must be gone, not merely accompanied",
    );

    // ...and the post-run verification asserts the same thing against the live
    // catalog, rather than only asserting the constraint's NAME exists.
    assert.equal(expectedConstraints.length, 2, "projectId's FK and estimateId's");
    const [constraint] = expectedConstraints as { name: string; table: string; mustMatch: RegExp[] }[];
    assert.equal(constraint.name, "Expense_projectId_fkey");
    assert.equal(constraint.table, "Expense");
    const rendered = 'FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE SET NULL';
    for (const pattern of constraint.mustMatch) {
        assert.match(rendered, pattern, `pg_get_constraintdef output must satisfy ${pattern}`);
    }
    // Both halves check the same four things — the SQL guard by LIKE, the
    // verifier by regex — so a constraint either guard accepts, the other does.
    for (const property of ['FOREIGN KEY ("projectId")', 'REFERENCES "Project"(id)', "ON DELETE SET NULL", "ON UPDATE CASCADE"]) {
        assert.ok(fk!.includes(`NOT LIKE '%${property}%'`), `SQL guard does not check ${property}`);
        assert.ok(
            constraint.mustMatch.some(pattern => pattern.test(property)),
            `verifier does not check ${property}`,
        );
    }
    // A CASCADE wearing the right name must fail every one of those checks.
    const cascade = 'FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE CASCADE';
    assert.ok(
        constraint.mustMatch.some(pattern => !pattern.test(cascade)),
        "an ON DELETE CASCADE constraint of the same name must be rejected",
    );

    // SHAPE, not just a name (round 36, item 2). Each entry has to say what the
    // index must BE, because `CREATE INDEX IF NOT EXISTS` matches on the name
    // alone and leaves a wrong index of the right name exactly where it is.
    assert.deepEqual(expectedIndexes, [
        { name: "Expense_projectId_idx", table: "Expense", unique: false, keyColumns: ["projectId"], predicate: null },
        { name: "Expense_sourceFileId_idx", table: "Expense", unique: false, keyColumns: ["sourceFileId"], predicate: null },
        {
            name: "Expense_sourceFileId_sourceGroupIndex_key",
            table: "Expense",
            unique: true,
            keyColumns: ["sourceFileId", "sourceGroupIndex"],
            predicate: /^\("?sourceFileId"? IS NOT NULL\)$/,
        },
    ]);
});

test("every statement is additive — nothing drops, renames, or rewrites data", () => {
    for (const statement of statements as string[]) {
        // TWO exceptions, and neither is data.
        //
        // 1. the tax CHECK is dropped and re-added by name so a database
        //    carrying the OLD definition (which refused every refund) is
        //    corrected rather than skipped; and
        // 2. the two rollout-window guards drop their own trigger immediately
        //    before creating it — Postgres has no CREATE TRIGGER IF NOT
        //    EXISTS, so drop-then-create is the only way a re-run does not
        //    fail on the trigger the previous run left. They drop a TRIGGER,
        //    never a row.
        //
        // Nothing else may drop anything, and nothing may drop a table, column
        // or index.
        const isConstraintReplace =
            /DROP CONSTRAINT IF EXISTS "Expense_(taxAmount|taxDeductibleBase|taxAtSource)_check"/.test(statement);
        // ROUND 42, ITEM 4b. `DROP NOT NULL` widens a column — it destroys no
        // row and refuses no existing value — and the FK swap replaces a
        // CASCADE rule with SET NULL, which is the whole point. Both are named
        // explicitly rather than admitted by a loose pattern.
        const isNullabilityWidening =
            /^ALTER TABLE "Expense" ALTER COLUMN "estimateId" DROP NOT NULL$/.test(statement.trim());
        const isEstimateFkReplace =
            statement.includes("Expense_estimateId_fkey") &&
            statement.includes("ON DELETE SET NULL");
        const isGuardTriggerReplace =
            /^DROP TRIGGER IF EXISTS probuild_expense_(estimate_pair_guard|amount_tax_(guard|ack)|source_file_bridge) ON "Expense"$/.test(statement.trim());
        assert.ok(
            isConstraintReplace || isGuardTriggerReplace || isNullabilityWidening || isEstimateFkReplace || !/\bDROP\b/i.test(statement),
            `destructive statement: ${statement}`,
        );
        assert.ok(!/DROP (TABLE|COLUMN|INDEX)/i.test(statement), `destructive: ${statement}`);
        assert.ok(!/\bDELETE FROM\b/i.test(statement), `destructive statement: ${statement}`);
        assert.ok(!/\bTRUNCATE\b/i.test(statement), `destructive statement: ${statement}`);
    }
});

test("the target guard compares database AND host, both exactly", () => {
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10.0.0.5"), true);
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10.0.0.50"), false);
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10"), false);
    assert.equal(targetMatches({ db: "other", host: "10.0.0.5" }, "postgres", "10.0.0.5"), false);
    assert.equal(targetMatches(null, "postgres", "10.0.0.5"), false);
});

// ── the legacy date re-anchor (Codex round 6, item 1) ──────────────────────

test("the re-anchor only touches rows sitting at exactly 00:00 UTC", () => {
    // Rows written by time-expense-core have always used the shared parser and
    // sit at local noon; re-anchoring those would move them a second time.
    const sql = reanchorSql("America/Los_Angeles");
    assert.match(sql, /WHERE "date" IS NOT NULL/);
    assert.match(sql, /"date"::time = TIME '00:00:00'/);
    // ...and the predicate is what makes it once-only: after the update the
    // time-of-day is no longer midnight UTC, so a second run matches nothing.
    assert.match(sql, /AT TIME ZONE 'America\/Los_Angeles'/);
    assert.match(sql, /AT TIME ZONE 'UTC'/);
});

test("the re-anchor refuses a time zone it cannot safely interpolate", () => {
    // The zone reaches the database unparameterized, so it has to be an IANA
    // name and nothing else.
    for (const bad of ["x'; DROP TABLE \"Expense\"; --", "America/Los Angeles", "'", ""]) {
        assert.throws(() => reanchorSql(bad), /suspicious time zone/, JSON.stringify(bad));
    }
    for (const good of ["UTC", "America/Los_Angeles", "Europe/Isle_of_Man", "Etc/GMT+7"]) {
        assert.ok(reanchorSql(good).includes(`'${good}'`), good);
    }
});

test("the tax-vs-gross CHECK is in both DDL paths and in the verifier", () => {
    const guard = (statements as string[]).find(
        s => s.includes("Expense_taxAmount_check") && s.includes("ADD CONSTRAINT"),
    );
    assert.ok(guard, "the script must carry it");
    // Signed: the tax points the same way as the money and is never bigger.
    assert.match(guard!, /sign\("taxAmount"\) = sign\("amount"\)/);
    assert.match(guard!, /abs\("taxAmount"\) <= abs\("amount"\)/);
    // ...and the old definition, which refused every refund, is REPLACED rather
    // than left in place on a database that already has it.
    const drop = (statements as string[]).find(
        s => /DROP CONSTRAINT IF EXISTS "Expense_taxAmount_check"/.test(s),
    );
    assert.ok(drop, "the old definition is dropped first");
    assert.ok(
        (statements as string[]).indexOf(drop!) < (statements as string[]).indexOf(guard!),
        "drop before add",
    );
    assert.ok(
        normalizedMigration.includes(normalize(guard!).replace(/;$/, "")),
        "and the migration must carry the same statement",
    );
    const verified = (expectedCheckConstraints as { name: string }[]).some(
        c => c.name === "Expense_taxAmount_check",
    );
    assert.ok(verified, "and the post-run verification must assert it");
});

// ── updatedAt must survive the PRE-DEPLOY window (round 10, item 1) ────────

test("updatedAt is added WITH its default, then repaired, THEN made NOT NULL", () => {
    // Order is the whole point, and round 13 moved it. The script runs against
    // production BEFORE the build that knows about the column, so the OLD app
    // is still inserting Expenses without it. If the column arrives bare, every
    // one of those inserts lands NULL — including ones that land AFTER the
    // backfill has run — and `SET NOT NULL` then aborts. Arriving with the
    // default means no insert can produce a NULL at all.
    const sql = (statements as string[]).filter(s => s.includes('"updatedAt"'));
    assert.equal(sql.length, 4, "add-with-default, repair default, repair nulls, not-null");
    assert.match(sql[0], /ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP\(3\) DEFAULT now\(\)$/);
    assert.ok(!/NOT NULL/.test(sql[0]), "still nullable, so a repair backfill can run");
    // Repair for a database left in the OLD half-applied shape: column present
    // with no default, and NULLs from the window that shape allowed.
    assert.match(sql[1], /ALTER COLUMN "updatedAt" SET DEFAULT now\(\)/);
    assert.match(sql[2], /^UPDATE [\s\S]*SET "updatedAt" = COALESCE\("createdAt"/);
    assert.match(sql[3], /SET NOT NULL/);
    // Both repairs must precede NOT NULL, or the old-shape database still fails.
    const idx = (needle: string) => (statements as string[]).indexOf(needle);
    assert.ok(idx(sql[1]) < idx(sql[3]) && idx(sql[2]) < idx(sql[3]), "repair before NOT NULL");
});

test("every updatedAt statement is re-runnable, and matches the migration", () => {
    const sql = (statements as string[]).filter(s => s.includes('"updatedAt"'));
    // IF NOT EXISTS; two idempotent ALTERs; a predicate-bound UPDATE.
    assert.match(sql[0], /IF NOT EXISTS/);
    assert.match(sql[2], /WHERE "updatedAt" IS NULL/);
    for (const statement of sql) {
        assert.ok(
            normalizedMigration.includes(normalize(statement).replace(/;$/, "")),
            `migration.sql is missing:
  ${statement}`,
        );
    }
});

test("the run is a SEQUENCE OF SHORT TRANSACTIONS: PHASE_A_STEPS, then data", () => {
    // ROUND 15, ITEM 1, replacing round 44's "the run is TWO transactions".
    // That was still wrong: bundling every DDL statement (including the two
    // FK adds) into ONE phase-A transaction still deadlocks a parent-first
    // writer, because `ADD CONSTRAINT ... REFERENCES "Project"` takes SHARE
    // ROW EXCLUSIVE on Project regardless of NOT VALID, and round 44's single
    // transaction held ACCESS EXCLUSIVE on Expense the whole time it did so.
    //
    // The fix is MORE transactions, not fewer: PHASE_A_STEPS is the ordered,
    // exported list of what actually runs, and main() drives it directly
    // rather than hand-rolling a second copy of the sequence.
    const script = readFileSync(
        path.join(__dirname, "..", "scripts", "apply-expense-attribution.mjs"),
        "utf8",
    );
    const loopAt = script.indexOf("for (const sql of sqlList)");
    assert.ok(loopAt > 0, "the run loop is still there");
    const run = script.slice(loopAt);
    assert.match(run, /await client\.\$executeRawUnsafe\(rendered\)/, "the loop runs on whichever client it is given");
    // ONE loop, reused — not two loops that could drift.
    assert.equal(
        script.split("for (const sql of sqlList)").length - 1, 1,
        "one loop, whichever set it is given",
    );
    // Each step commits (transactional) or completes (concurrent) on its own,
    // rather than every step sharing one enclosing transaction — that is the
    // whole fix, so both branches have to exist and disagree about whether
    // $transaction wraps the loop.
    const runPhaseAt = script.indexOf("const runPhase = async");
    assert.ok(runPhaseAt > -1 && runPhaseAt < loopAt, "runPhase is defined before its loop");
    const runPhaseBody = script.slice(runPhaseAt, script.indexOf("await runPhase("));
    assert.match(runPhaseBody, /if \(concurrent\) \{/);
    assert.match(runPhaseBody, /await execute\(prisma\)/, "the concurrent branch runs OUTSIDE any transaction");
    assert.match(runPhaseBody, /await prisma\.\$transaction\(tx => execute\(tx\)/, "the default branch wraps the loop in its OWN transaction");

    // PHASE_A_STEPS is iterated directly — no hand-rolled second copy of the
    // sequence that could drift from the exported, tested list.
    const stepsLoopAt = script.indexOf("for (const step of PHASE_A_STEPS)");
    assert.ok(stepsLoopAt > -1, "main() must drive PHASE_A_STEPS, not a private copy");
    assert.match(
        script.slice(stepsLoopAt),
        /await runPhase\(step\.label, step\.statements, \{ concurrent: !!step\.concurrent \}\)/,
    );
    // ...and it runs BEFORE phase B, which is the only other step that
    // reaches for a Project or Estimate lock.
    const bAt = script.indexOf('runPhase("phase B');
    assert.ok(bAt > -1, "phase B still runs");
    assert.ok(stepsLoopAt < bAt, "every phase-A step runs before phase B asks for a parent row");
});

test("PHASE_A_STEPS is the ordered, structured view PHASE_A actually runs as", () => {
    // The property round 15 exists to buy: no step ever holds a lock on
    // Expense from an EARLIER statement while requesting one on Project or
    // Estimate. The only steps that reach a parent table are the two FK
    // steps, and each does so as the FIRST thing in a FRESH transaction —
    // immediately after the explicit LOCK TABLE that makes the acquisition
    // order Project/Estimate-then-Expense, never the other way round.
    const labels = (PHASE_A_STEPS as { label: string }[]).map(s => s.label);
    assert.deepEqual(labels, [
        "phase A: columns (Expense-only, no parent lock)",
        "phase A: normalize (Expense-only, no parent lock)",
        "phase A: checks (Expense-only, no parent lock)",
        "phase A: indexes (CONCURRENTLY, standalone -- refuses to run inside a transaction)",
        "phase A: triggers (Expense-only, no parent lock)",
        "phase A: ReceiptIntake (Phase 1's table -- not Project, Estimate, or Expense)",
        "phase A: project FK (locks Project FIRST, parent before child)",
        "phase A: validate project FK",
        "phase A: estimate FK (locks Estimate FIRST, parent before child)",
        "phase A: validate estimate FK",
    ]);
    // Exactly one step is concurrent (the indexes) — everything else is a
    // normal short transaction.
    const concurrentSteps = (PHASE_A_STEPS as { label: string; concurrent?: boolean }[]).filter(s => s.concurrent);
    assert.equal(concurrentSteps.length, 1);
    assert.equal(concurrentSteps[0].label, "phase A: indexes (CONCURRENTLY, standalone -- refuses to run inside a transaction)");

    // Each FK step's FIRST statement is the explicit parent lock, and its
    // LAST is the ADD CONSTRAINT DO-block — nothing else shares the
    // transaction with it.
    const project = (PHASE_A_STEPS as { label: string; statements: string[] }[])
        .find(s => s.label.includes("project FK ("))!;
    assert.equal(project.statements.length, 2);
    assert.equal(project.statements[0], `LOCK TABLE "Project" IN SHARE ROW EXCLUSIVE MODE`);
    assert.match(project.statements[1], /Expense_projectId_fkey/);
    assert.match(project.statements[1], /NOT VALID/);

    const estimate = (PHASE_A_STEPS as { label: string; statements: string[] }[])
        .find(s => s.label.includes("estimate FK ("))!;
    assert.equal(estimate.statements.length, 2);
    assert.equal(estimate.statements[0], `LOCK TABLE "Estimate" IN SHARE ROW EXCLUSIVE MODE`);
    assert.match(estimate.statements[1], /Expense_estimateId_fkey/);
    assert.match(estimate.statements[1], /NOT VALID/);

    // Each VALIDATE step is a SEPARATE step from its LOCK+ADD, so the parent
    // lock is not held one moment longer than the metadata-only add needs.
    const projectValidate = (PHASE_A_STEPS as { label: string; statements: string[] }[])
        .find(s => s.label === "phase A: validate project FK")!;
    assert.deepEqual(projectValidate.statements, [`ALTER TABLE "Expense" VALIDATE CONSTRAINT "Expense_projectId_fkey"`]);
    const estimateValidate = (PHASE_A_STEPS as { label: string; statements: string[] }[])
        .find(s => s.label === "phase A: validate estimate FK")!;
    assert.deepEqual(estimateValidate.statements, [`ALTER TABLE "Expense" VALIDATE CONSTRAINT "Expense_estimateId_fkey"`]);

    // DDL_STATEMENTS is derived, not a second hand-maintained list.
    assert.deepEqual(DDL_STATEMENTS, (PHASE_A_STEPS as { statements: string[] }[]).flatMap(s => s.statements));
});

test("toConcurrentIndexSql renders each plain index statement, and only that", () => {
    for (const sql of INDEX_STATEMENTS as string[]) {
        const rendered = toConcurrentIndexSql(sql);
        assert.match(rendered, /CREATE (UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS/);
        // Nothing else about the statement changes.
        assert.equal(rendered.replace("CONCURRENTLY ", ""), sql);
    }
    assert.throws(() => toConcurrentIndexSql(`SELECT 1`), /could not find/);
});

test("phase A takes no Project or Estimate lock, and phase B is the backfills", () => {
    // The property the split exists for, asserted on the DATA rather than on
    // the prose: nothing in the DDL phase may name `Project` or `Estimate` as
    // a locking target, and every statement that does must be in phase B.
    for (const sql of DDL_STATEMENTS as string[]) {
        // A `CREATE OR REPLACE FUNCTION` body is COMPILED, not executed: the
        // split-job guard's body reads "Estimate", but only later, when the
        // trigger fires on somebody else's transaction. The CREATE itself
        // takes no lock on it. Everything else is judged on what it does NOW.
        const executesNow = /^CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(sql.trimStart())
            ? sql.slice(0, sql.search(/AS\s+\$/i))
            : sql;
        assert.ok(
            !/FOR\s+(SHARE|UPDATE|KEY\s+SHARE)/i.test(executesNow),
            `phase A must take no row locks:\n  ${sql.slice(0, 120)}`,
        );
        assert.ok(
            !/FROM\s+"Project"|FROM\s+"Estimate"/i.test(executesNow),
            `phase A must not read a parent table:\n  ${sql.slice(0, 120)}`,
        );
    }
    // The FK DO-blocks read pg_constraint, not the parent tables, so they are
    // allowed above; this pins that they really are the only survivors.
    assert.ok((DDL_STATEMENTS as string[]).some(s => s.includes("Expense_estimateId_fkey")));

    // Phase B is exactly the re-runnable set — one definition, so the two
    // cannot drift.
    assert.deepEqual(
        backfillStatements("America/Los_Angeles"),
        postDeployStatements("America/Los_Angeles"),
    );
    // ...and the combined list the migration is checked against is A then B.
    const all = statements as string[];
    assert.deepEqual(all.slice(0, (DDL_STATEMENTS as string[]).length), DDL_STATEMENTS);
    for (const sql of [PROJECT_ID_BACKFILL_LOCK_PROJECTS, PROJECT_ID_BACKFILL, SOURCE_FILE_ID_BACKFILL]) {
        assert.ok(all.includes(sql as string), "every backfill is still in the committed set");
        assert.ok(!(DDL_STATEMENTS as string[]).includes(sql as string), "and none of them is in phase A");
    }
});

test("taxSource is declared everywhere the other tax columns are", () => {
    // Codex round 13, item 5. A column that exists only in the migration is a
    // P2022 on production; one that exists only in the script is a fresh CI
    // database that cannot reproduce prod.
    assert.ok((statements as string[]).some(s => /ADD COLUMN IF NOT EXISTS "taxSource" TEXT/.test(s)));
    assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS "taxSource" TEXT/);
    assert.ok(expectedColumns.Expense.includes("taxSource"), "and it is verified after the run");
    const schema = readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    assert.match(schema, /taxSource\s+String\?/);
});

test("schema.prisma's Expense comments describe the CURRENT shape, not a stale one (round 15, item 5)", () => {
    // Three comments had drifted from what the schema actually declares:
    //   - the Phase 3 banner above `projectId` used to call `estimateId` the
    //     "REQUIRED parent" that "still Cascade-deletes this row", which round
    //     42 item 4b made false (nullable, onDelete: SetNull);
    //   - `needsTaxReview`'s comment said the tax report "ignores" it, when
    //     queryTaxAtSourceRows actually filters `needsTaxReview: false`,
    //     EXCLUDING a flagged row even when its remaining figures would
    //     otherwise qualify;
    //   - `costCodeSource`'s comment listed capture | ai | manual | backfill
    //     and omitted "manual-none" entirely, though it is a
    //     HUMAN_COST_CODE_SOURCES member and a real, deliberate decision (a
    //     bookkeeper clearing the phase), not an oversight.
    const schema = readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    assert.ok(!/REQUIRED parent/.test(schema), "estimateId is no longer claimed to be required");
    assert.ok(!/still\s+\/{2,3}\s*Cascade-deletes this row/.test(schema), "estimateId is no longer claimed to cascade-delete");
    assert.match(schema, /estimateId[\s\S]{0,200}NOT the required parent this comment once described/);
    assert.match(schema, /queryTaxAtSourceRows/, "needsTaxReview must name the reader that filters on it");
    assert.match(schema, /filters it OUT with `needsTaxReview:\s*\n?\s*\/\/\/ false`/);
    assert.match(schema, /capture \| ai \| manual \| manual-none \| backfill/, "manual-none must be in the precedence list");
    assert.match(schema, /HUMAN_COST_CODE_SOURCES in src\/lib\/expense-attribution\.ts/);
});

test("taxDeductibleBaseSource is declared in BOTH DDL paths, the verifier and the schema", () => {
    // Round 33, item 4 — the same parity the column above buys, for the column
    // that splits provenance per field. Prod runs the apply script and CI
    // replays the migration, so a column in one and not the other is a
    // database that cannot reproduce the other: P2022 on production, or a CI
    // schema that silently disagrees with prod.
    assert.ok(
        (statements as string[]).some(s => /ADD COLUMN IF NOT EXISTS "taxDeductibleBaseSource" TEXT/.test(s)),
        "the apply script adds it",
    );
    assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS "taxDeductibleBaseSource" TEXT/);
    assert.ok(
        expectedColumns.Expense.includes("taxDeductibleBaseSource"),
        "and the post-run verify would catch its absence",
    );
    const schema = readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    assert.match(schema, /taxDeductibleBaseSource\s+String\?/);
});

test("the base-provenance backfill is identical in both DDL paths, and idempotent", () => {
    // The conservative reading of the rows that predate the column: before the
    // split, a human base could only stand on a row a human had also answered
    // about tax. It must be the SAME statement in both files — prod runs one
    // and CI replays the other, and a backfill that differs between them is a
    // difference nothing else in the system would ever surface.
    const backfill = (statements as string[]).find(
        s => /"taxDeductibleBaseSource" = 'manual'/.test(s),
    );
    assert.ok(backfill, "the apply script carries the backfill");
    // Not a second copy in the migration: the parity test above compares every
    // script statement against the migration by meaning, so asserting the
    // migration matches here is asserting the pair cannot drift.
    assert.ok(
        normalize(migrationSql).includes(normalize(backfill!).replace(/;$/, "")),
        "and the migration carries the same one",
    );
    // Idempotent by predicate: a second run matches nothing, so a re-run
    // cannot re-stamp a row a human has since cleared.
    assert.match(backfill!, /"taxDeductibleBaseSource" IS NULL/);
    // Only where a human actually decided. An OCR or absent taxSource means
    // nobody typed the base, and inventing "manual" there would hand a guess
    // the one provenance booking is forbidden to overwrite.
    assert.match(backfill!, /"taxDeductibleBase" IS NOT NULL/);
    assert.match(backfill!, /"taxSource" IN\('manual','manual-none'\)|"taxSource" IN \('manual', 'manual-none'\)/);
});

test("Prisma declares the same default, so the migration check sees them agree", () => {
    const schema = readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    assert.match(schema, /updatedAt DateTime @default\(now\(\)\) @updatedAt/);
});

// ── the company zone is not guessed (Codex round 18, item 5) ───────────────

test("only an ABSENT settings row falls back to the app default", () => {
    // This zone decides which quarter every legacy receipt lands in. An empty
    // result is a database that has never had settings written, and the app's
    // own default is the honest answer for it.
    assert.deepEqual(pickCompanyTimeZone([]), {
        timeZone: "America/Los_Angeles",
        from: "default",
    });
    assert.deepEqual(pickCompanyTimeZone([{ timeZone: null }]), {
        timeZone: "America/Los_Angeles",
        from: "default",
    });
    assert.deepEqual(pickCompanyTimeZone([{ timeZone: "   " }]), {
        timeZone: "America/Los_Angeles",
        from: "default",
    });
});

test("a configured zone is used verbatim, and reported as such", () => {
    assert.deepEqual(pickCompanyTimeZone([{ timeZone: "America/New_York" }]), {
        timeZone: "America/New_York",
        from: "settings",
    });
    assert.deepEqual(pickCompanyTimeZone([{ timeZone: "  UTC  " }]), {
        timeZone: "UTC",
        from: "settings",
    });
});

test("an UNREADABLE settings query is not an answer", () => {
    // The old code wrapped the query in `.catch(() => [undefined])`, so a
    // permissions error or a dropped connection read as "no settings" and
    // quietly re-anchored a whole table into Pacific.
    assert.throws(() => pickCompanyTimeZone(undefined as never), /refusing to guess/i);
    assert.throws(() => pickCompanyTimeZone(null as never), /refusing to guess/i);
});

test("the script does not swallow the settings query error", () => {
    const script = readFileSync(
        path.join(__dirname, "..", "scripts", "apply-expense-attribution.mjs"),
        "utf8",
    );
    const read = script.slice(script.indexOf('SELECT "timeZone" FROM "CompanySettings"'));
    assert.ok(
        !/\.catch\(/.test(read.slice(0, 200)),
        "an unreadable settings table must abort, not fall back",
    );
});

test("the re-anchor is idempotent by DATE SHAPE, not by the marker (round 31, item 3)", () => {
    // The marker used to be the gate (`attributionAnchoredAt IS NULL`), on the
    // reasoning that only a legacy, never-touched row could sit at UTC
    // midnight. An OLD app instance proves that wrong: its Prisma client
    // predates the marker column, so it can UPDATE a row this script already
    // anchored back to UTC midnight without ever touching
    // `attributionAnchoredAt`. Gating on the marker made the post-deploy
    // verification blind to exactly that row. The predicate no longer
    // mentions the marker at all — it asks whether applying the SAME anchor
    // transform the UPDATE uses would actually change the row's value.
    const sql = reanchorSql("America/Los_Angeles");
    assert.doesNotMatch(
        sql,
        /"attributionAnchoredAt" IS NULL/,
        "the WHERE clause no longer gates on the marker",
    );
    assert.match(sql, /SET[\s\S]*"attributionAnchoredAt" = now\(\)/, "the marker is still stamped, as an audit trail");
    // The legacy selector stays: everything written by time-expense-core has
    // always carried a real time-of-day.
    assert.match(sql, /"date"::time = TIME '00:00:00'/);
    // The self-limiting half: comparing the transform's result against the
    // stored value is what stops a UTC-configured company from being
    // rescanned forever (there the transform is the identity, so nothing
    // ever matches) — the same non-eligible-forever guarantee the marker
    // existed to buy, without needing the marker to buy it.
    assert.match(
        sql,
        /AT TIME ZONE 'America\/Los_Angeles'\) AT TIME ZONE 'UTC' <> "date"/,
    );
    // The marker column still ships with the rest of the DDL, in both files —
    // it is now pure provenance (when was this row last touched by the
    // re-anchor), not a gate.
    assert.ok((statements as string[]).some(s => /"attributionAnchoredAt" TIMESTAMP\(3\)/.test(s)));
    assert.match(migrationSql, /"attributionAnchoredAt" TIMESTAMP\(3\)/);
});

test("the verification query uses the SAME predicate as the UPDATE, not a second copy", () => {
    // Two independent copies of "does this row need re-anchoring" are two
    // things that can drift — and the copy that drifts silently is the
    // VERIFICATION, whose entire job is to be the thing nobody has to trust.
    const update = reanchorSql("America/Los_Angeles");
    const predicate = needsReanchorPredicate("America/Los_Angeles");
    assert.ok(
        update.includes(predicate),
        "reanchorSql's WHERE clause must be built from needsReanchorPredicate",
    );
    const script = readFileSync(
        path.join(__dirname, "..", "scripts", "apply-expense-attribution.mjs"),
        "utf8",
    );
    assert.match(
        script,
        /unanchored\] = await prisma\.\$queryRawUnsafe\(\s*`SELECT COUNT\(\*\)::int AS n FROM "Expense" WHERE \$\{needsReanchorPredicate\(companyTimeZone\)\}`/,
        "the verification COUNT calls needsReanchorPredicate rather than re-stating the WHERE clause",
    );
});

/**
 * A pure-JS mirror of needsReanchorPredicate's arithmetic, narrowed to a
 * FIXED-OFFSET zone: Etc/GMT+n never observes DST, so "local midnight is N
 * hours ahead of UTC" is exact and needs no timezone library to verify by
 * hand. This does not replace the SQL-text assertions above — it exists only
 * to prove the PREDICATE'S LOGIC against constructed rows without a live
 * Postgres to run the real SQL against.
 */
function needsReanchorFixedOffset(dateIso: string, utcHourOfLocalMidnight: number): boolean {
    const date = new Date(dateIso);
    const isUtcMidnight =
        date.getUTCHours() === 0 && date.getUTCMinutes() === 0 &&
        date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
    if (!isUtcMidnight) return false;
    const day = date.toISOString().slice(0, 10);
    const anchored = new Date(`${day}T${String(utcHourOfLocalMidnight).padStart(2, "0")}:00:00.000Z`);
    return anchored.getTime() !== date.getTime();
}

test("pre-pass anchors a legacy row; an old client's later UTC-midnight rewrite is still caught post-pass (round 31, item 3)", () => {
    // Etc/GMT+8 never observes DST, so local midnight there is always exactly
    // 08:00 UTC — unlike a real IANA zone, that offset needs no library to
    // verify.
    const LOCAL_MIDNIGHT_UTC_HOUR = 8;
    const day = "2026-07-01";

    // PRE-PASS: a legacy row, never anchored, sitting at raw UTC midnight —
    // exactly what the old (pre-Phase-3) writer produced.
    assert.equal(
        needsReanchorFixedOffset(`${day}T00:00:00.000Z`, LOCAL_MIDNIGHT_UTC_HOUR),
        true,
        "a legacy row at UTC midnight needs re-anchoring",
    );

    // The SAME row after the pre-pass corrects it: no longer at UTC midnight,
    // so the shape condition alone already excludes it — nothing to catch.
    const anchoredIso = `${day}T08:00:00.000Z`;
    assert.equal(
        needsReanchorFixedOffset(anchoredIso, LOCAL_MIDNIGHT_UTC_HOUR),
        false,
        "a correctly-anchored row is left alone",
    );

    // POST-PASS SCENARIO: an OLD app instance — its Prisma client predates
    // both `attributionAnchoredAt` and the anchor logic — is still draining
    // and UPDATEs this SAME row's `date` back to raw UTC midnight. It never
    // touches the marker column, so `attributionAnchoredAt` stays set from
    // the pre-pass. A marker-gated predicate would see that and skip the row
    // forever, and the post-deploy verification would report 0 while the row
    // sat wrong — the exact gap this fix closes. The shape-based predicate
    // never consults the marker, so it catches this row exactly as it caught
    // the untouched legacy one.
    const corruptedByOldClient = `${day}T00:00:00.000Z`;
    assert.equal(
        needsReanchorFixedOffset(corruptedByOldClient, LOCAL_MIDNIGHT_UTC_HOUR),
        true,
        "the post-pass predicate catches the old-client rewrite even though the marker is already set",
    );
});

test("ReceiptIntake.costCodeSource ships behind the same guard as the other two", () => {
    // Phase 1 owns that table; the column is additive and skipped when the
    // table is not there yet (round 18, item 3).
    const guarded = (statements as string[]).find(s => s.includes("ReceiptIntake"));
    assert.match(guarded!, /"costCodeSource" TEXT/);
    assert.match(migrationSql, /ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "costCodeSource" TEXT/);
});

// ── the post-deploy re-run (Codex round 21, item 3) ────────────────────────

test("the post-deploy set is a SUBSET of the main run, never a second copy", () => {
    // Two copies of a backfill are two things that can drift, and the one that
    // drifts is the one nobody runs on the day it matters.
    const main = [...(statements as string[]), reanchorSql("America/Los_Angeles")];
    for (const sql of postDeployStatements("America/Los_Angeles")) {
        assert.ok(main.includes(sql), `not part of the main run:\n  ${sql}`);
    }
});

test("every post-deploy statement is idempotent BY PREDICATE", () => {
    // The whole reason a second pass is safe. The projectId fill only ever
    // touches a NULL, and the date re-anchor only ever touches a row that is
    // still sitting at UTC midnight AND whose company-zone anchor would
    // actually change it — the shape the OLD build's writes leave behind,
    // whether that row has ever been anchored before or not (round 31, item 3:
    // it must NOT be gated on the marker, or an old client's rewrite of an
    // already-anchored row is invisible to this exact pass).
    // The project LOCK travels with the fill it protects (round 41, item 1) and
    // is trivially idempotent: it is a locking SELECT that writes nothing. It
    // must come immediately before the fill, because that is the whole point.
    const [lockProjects, projectFill, reanchor, sourceFileFill] =
        postDeployStatements("America/Los_Angeles");
    assert.equal(postDeployStatements("America/Los_Angeles").length, 4);
    assert.equal(lockProjects, PROJECT_ID_BACKFILL_LOCK_PROJECTS, "the array holds the exported constant");
    assert.match(lockProjects, /FROM "Project" p/);
    assert.match(lockProjects, /ORDER BY p\.id\s+FOR SHARE/);
    assert.ok(!/\b(UPDATE|INSERT|DELETE)\b/i.test(lockProjects), "it locks, it does not write");
    assert.match(projectFill, /"projectId" IS NULL/);
    assert.doesNotMatch(reanchor, /"attributionAnchoredAt" IS NULL/);
    assert.match(reanchor, /"date"::time = TIME '00:00:00'/);
    // The third one has the SAME live-write gap and the same shape of answer:
    // the old build keeps writing receipt expenses with a receiptUrl and no
    // sourceFileId after this statement has already passed over the table, and
    // a row left in that shape is invisible to the new equality dedupe.
    assert.match(sourceFileFill, /"sourceFileId" IS NULL/);
    assert.equal(sourceFileFill, SOURCE_FILE_ID_BACKFILL, "the array holds the exported constant");
});

test("the projects are locked in their own statement, immediately before the fill", () => {
    // ROUND 41, ITEM 1. The fill's UPDATE takes FOR KEY SHARE on every
    // referenced Project through the foreign key this same script adds, so on
    // its own it is Estimate -> Project — the inversion rounds 37 to 40 removed
    // from the application, reintroduced by the migration that creates the
    // constraint. A 40P01 here rolls back the whole DDL run.
    const main = statements as string[];
    const lockAt = main.indexOf(PROJECT_ID_BACKFILL_LOCK_PROJECTS);
    const fillAt = main.indexOf(PROJECT_ID_BACKFILL);
    assert.ok(lockAt > -1, "the project lock is in the main run");
    assert.equal(fillAt, lockAt + 1, "nothing may run between the lock and the fill it protects");
    // A SEPARATE statement, not another CTE: CTE evaluation order is not
    // guaranteed, so a locking CTE beside the fill would be a hope rather than
    // a rule. Two statements in one transaction have a defined order.
    assert.ok(
        !/WITH\s/i.test(PROJECT_ID_BACKFILL_LOCK_PROJECTS),
        "the project lock must not be folded into a CTE",
    );
    // ...and both halves are in the committed migration, in that order.
    const lockInMigration = migrationSql.indexOf('FROM "Project" p');
    const fillInMigration = migrationSql.indexOf('UPDATE "Expense" e SET "projectId" = locked."projectId"');
    assert.ok(lockInMigration > -1 && fillInMigration > -1);
    assert.ok(lockInMigration < fillInMigration, "the migration locks the jobs first too");
    assert.ok(
        normalizedMigration.includes(normalize(PROJECT_ID_BACKFILL_LOCK_PROJECTS).replace(/;$/, "")),
        "migration.sql is missing the project lock",
    );
});

test("the live-write gap is documented where the statement is, not only in a PR", () => {
    const script = readFileSync(
        path.join(__dirname, "..", "scripts", "apply-expense-attribution.mjs"),
        "utf8",
    );
    assert.match(script, /POST-DEPLOY: re-run this section/);
    assert.match(script, /--post-deploy/, "and the mode that re-runs it exists");
    // The backfill itself is the exported constant the mode reuses.
    assert.match(PROJECT_ID_BACKFILL, /UPDATE "Expense" e SET "projectId"/);
});

// ── the receipt dedupe's own identity column (round 34, item 1) ────────────

test("the source-file identity is added by BOTH files, with its indexes", () => {
    // The ingest deduped with `receiptUrl contains fileId` while storing a
    // CALLER-SUPPLIED url. A payload whose `fileUrl` omitted the id deduped
    // against nothing and re-booked the receipt on every delivery, and the
    // substring match conflated a file id that is a prefix of another. The
    // fix needs a column, so the column has to reach production (this script)
    // and a fresh database (the migration) identically — a column present in
    // only one of them is the shape P2022 shows up as.
    for (const column of ["sourceFileId", "sourceGroupIndex"]) {
        assert.ok(
            (statements as string[]).some(s =>
                s.includes(`ADD COLUMN IF NOT EXISTS "${column}"`)),
            `the script must add ${column}`,
        );
        assert.ok(expectedColumns.Expense.includes(column), `and verify ${column} after the run`);
    }

    // The plain index the equality dedupe reads through...
    assert.ok(
        (statements as string[]).some(s => s.includes('"Expense_sourceFileId_idx"')),
        "the lookup index is created",
    );
    // ...and the PARTIAL UNIQUE index that makes a duplicate group
    // unrepresentable even for a writer that never takes the ingest's
    // advisory lock. Partial on `sourceFileId IS NOT NULL` so manual and
    // QBO-imported expenses are outside it entirely.
    const unique = (statements as string[]).find(s =>
        s.includes('"Expense_sourceFileId_sourceGroupIndex_key"'));
    assert.ok(unique, "the durable backstop is created");
    assert.match(unique!, /CREATE UNIQUE INDEX IF NOT EXISTS/);
    assert.match(unique!, /\("sourceFileId", "sourceGroupIndex"\)/, "on the PAIR, not the file alone");
    assert.match(unique!, /WHERE "sourceFileId" IS NOT NULL/);
});

test("Prisma cannot see the partial unique index, so the snapshot must", () => {
    // `prisma migrate diff` omits partial indexes without comment, which is
    // exactly why scripts/check-migrations-match.mjs compares them against
    // prisma/prisma-blind-spots.json instead. An index created by the
    // migration and absent from that file fails CI's migrations job — and,
    // worse, an index in neither would be silently missing from a fresh
    // database while production had it.
    const snapshot = JSON.parse(
        readFileSync(path.join(__dirname, "..", "prisma", "prisma-blind-spots.json"), "utf8"),
    ) as { partialIndexes: { name: string; def: string }[] };
    const entry = snapshot.partialIndexes.find(
        row => row.name === "Expense_sourceFileId_sourceGroupIndex_key",
    );
    assert.ok(entry, "the partial unique index is recorded as a Prisma blind spot");
    // Compared RAW against pg_get_indexdef by the checker, so the recorded
    // definition has to be the canonical rendering, not an approximation.
    assert.equal(
        entry!.def,
        'CREATE UNIQUE INDEX "Expense_sourceFileId_sourceGroupIndex_key" ON public."Expense" ' +
            'USING btree ("sourceFileId", "sourceGroupIndex") WHERE ("sourceFileId" IS NOT NULL)',
    );
});

test("the sourceFileId backfill parses the id EXACTLY, or leaves it null", () => {
    // A guessed id is worse than none: it would dedupe two unrelated
    // documents against each other, which is the failure this whole column
    // exists to end. Only the two url shapes the app has ever written are
    // parsed, and anything else stays NULL.
    assert.match(SOURCE_FILE_ID_BACKFILL, /'\/d\/\(\[A-Za-z0-9_-\]\+\)'/);
    assert.match(SOURCE_FILE_ID_BACKFILL, /'\[\?&\]id=\(\[A-Za-z0-9_-\]\+\)'/);
    // Idempotent by predicate, like every other backfill here: a re-run
    // touches 0 rows and cannot overwrite an id the ingest wrote itself.
    assert.match(SOURCE_FILE_ID_BACKFILL, /"sourceFileId" IS NULL/);
    // And it writes NO group ordinal. Nothing can say which group of a
    // document an old row was, and a false ordinal under a unique index is a
    // fabricated identity. NULLs are distinct in a btree unique index, so
    // those rows neither collide with each other nor gain its protection.
    assert.ok(
        !/sourceGroupIndex/.test(SOURCE_FILE_ID_BACKFILL),
        "the backfill must not invent a group ordinal",
    );
    // The migration carries the same statement (the generic parity test
    // above proves it), and the array holds the exported constant rather
    // than a copy that could drift from it.
    assert.ok((statements as string[]).includes(SOURCE_FILE_ID_BACKFILL));
});

/* ------------------------------------------------------------------ *
 * Round 36, item 2: the index verifier checks SHAPE, not just a name.
 * ------------------------------------------------------------------ */

/** One catalog row, shaped the way the verifier's query returns it. */
function catalogRow(over: Record<string, unknown> = {}) {
    return {
        table_name: "Expense",
        is_unique: true,
        key_columns: ["sourceFileId", "sourceGroupIndex"],
        predicate: '("sourceFileId" IS NOT NULL)',
        def: "CREATE UNIQUE INDEX ...",
        ...over,
    };
}

const dedupeIndex = expectedIndexes.find(
    i => i.name === "Expense_sourceFileId_sourceGroupIndex_key",
)!;

test("a correctly shaped index is not drift", () => {
    assert.equal(indexDrift(dedupeIndex, catalogRow()), null);
    // pg renders the predicate with the column quoted; an unquoted rendering of
    // the same predicate is the same index and must also pass.
    assert.equal(indexDrift(dedupeIndex, catalogRow({ predicate: "(sourceFileId IS NOT NULL)" })), null);
});

test("a same-named index that is NOT unique is caught", () => {
    // The whole point of this index is that a duplicate receipt is
    // unrepresentable. A non-unique index of the same name enforces nothing,
    // and `CREATE UNIQUE INDEX IF NOT EXISTS` would skip right over it.
    const drift = indexDrift(dedupeIndex, catalogRow({ is_unique: false }));
    assert.match(String(drift), /uniqueness/);
    assert.match(String(drift), /expected indisunique = true/);
});

test("a same-named index over the WRONG columns is caught", () => {
    assert.match(
        String(indexDrift(dedupeIndex, catalogRow({ key_columns: ["sourceFileId"] }))),
        /wrong key columns/,
    );
    // Right columns, wrong ORDER is a different index with the same members.
    assert.match(
        String(indexDrift(dedupeIndex, catalogRow({ key_columns: ["sourceGroupIndex", "sourceFileId"] }))),
        /wrong key columns/,
    );
    // An EXPRESSION where a plain column belongs (attnum 0 -> null attname).
    assert.match(
        String(indexDrift(dedupeIndex, catalogRow({ key_columns: [null, "sourceGroupIndex"] }))),
        /<expression>/,
    );
    // An INCLUDE column must not be able to pad the list into a match either;
    // the query cuts at indnkeyatts, so a third name here is a real third key.
    assert.match(
        String(indexDrift(dedupeIndex, catalogRow({ key_columns: ["sourceFileId", "sourceGroupIndex", "id"] }))),
        /wrong key columns/,
    );
});

test("a same-named index that LOST its partial predicate is caught", () => {
    // Without `WHERE "sourceFileId" IS NOT NULL` every legacy row with a NULL
    // sourceFileId is dragged into the uniqueness, which is a different
    // constraint entirely.
    assert.match(
        String(indexDrift(dedupeIndex, catalogRow({ predicate: null }))),
        /is not partial/,
    );
    assert.match(
        String(indexDrift(dedupeIndex, catalogRow({ predicate: '("sourceGroupIndex" IS NOT NULL)' }))),
        /wrong predicate/,
    );
});

test("a null predicate expectation ASSERTS the index is total, it does not skip the check", () => {
    // The two plain indexes expect `predicate: null`. If that meant "not
    // checked", a partial index of the same name would pass while covering only
    // part of the table.
    const plain = expectedIndexes.find(i => i.name === "Expense_projectId_idx")!;
    assert.equal(
        indexDrift(plain, catalogRow({ is_unique: false, key_columns: ["projectId"], predicate: null })),
        null,
    );
    assert.match(
        String(indexDrift(plain, catalogRow({
            is_unique: false,
            key_columns: ["projectId"],
            predicate: '("projectId" IS NOT NULL)',
        }))),
        /expected no predicate/,
    );
});

test("an index on the wrong TABLE is caught", () => {
    assert.match(String(indexDrift(dedupeIndex, catalogRow({ table_name: "ReceiptIntake" }))), /wrong table/);
});

test("the ReceiptIntake column check covers every column the DDL adds", () => {
    // costCodeSource was added by the guarded DO block and left out of the
    // verifier's list, so the one column the receipt-intake provenance depends
    // on was the one column nothing checked (round 36, item 2).
    const guarded = (statements as string[]).find(s => s.includes("ReceiptIntake"))!;
    const added = [...guarded.matchAll(/ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "(\w+)"/g)]
        .map(m => m[1])
        .sort();
    assert.deepEqual(added, [...expectedReceiptIntakeColumns].sort());
    assert.ok(expectedReceiptIntakeColumns.includes("costCodeSource"));
});

/* ------------------------------------------------------------------ *
 * Round 36, item 1: the rollout window cannot split a row across jobs.
 * ------------------------------------------------------------------ */

test("the split-job guard is created BEFORE the projectId backfill", () => {
    // Order is the whole fix. Created after the fill, there is a window in
    // which the column already carries values and nothing maintains the pair.
    const trigger = (statements as string[]).findIndex(s => /^CREATE TRIGGER probuild_expense_estimate_pair_guard/m.test(s.trim()));
    const backfill = (statements as string[]).indexOf(PROJECT_ID_BACKFILL);
    assert.ok(trigger > -1, "the guard must be part of the main run");
    assert.ok(backfill > -1, "the backfill must be part of the main run");
    assert.ok(trigger < backfill, "the guard has to be in place before the column has values");
});

test("the guard only fires when the writer left projectId alone", () => {
    // This is what stops it reverting a bookkeeper. The new build's writers set
    // BOTH columns from one locked read; a trigger that corrected them would
    // silently overrule a deliberate re-attribution, which is the same class of
    // wrong answer it exists to prevent.
    const fn = SPLIT_JOB_GUARD_SQL.find(s => s.includes("CREATE OR REPLACE FUNCTION"))!;
    assert.match(fn, /NEW\."estimateId" IS DISTINCT FROM OLD\."estimateId"/);
    assert.match(fn, /NEW\."projectId" IS NOT DISTINCT FROM OLD\."projectId"/);
    assert.match(fn, /OLD\."projectId" IS NOT NULL/);
    // And it never nulls an attribution out: an estimate belonging to no job
    // leaves the row with the projectId it had.
    assert.match(fn, /IF est_project IS NOT NULL THEN/);
    // BEFORE UPDATE OF estimateId — it must not fire on every expense write.
    const trigger = SPLIT_JOB_GUARD_SQL.find(s => s.includes("CREATE TRIGGER"))!;
    assert.match(trigger, /BEFORE UPDATE OF "estimateId" ON "Expense"/);
});

test("the guard is idempotent: it drops its own trigger before creating it", () => {
    // Postgres has no CREATE TRIGGER IF NOT EXISTS, so a second run of the
    // script would fail on the trigger the first one left behind.
    const dropIndex = SPLIT_JOB_GUARD_SQL.findIndex(s => /^DROP TRIGGER IF EXISTS/.test(s.trim()));
    const createIndex = SPLIT_JOB_GUARD_SQL.findIndex(s => /^CREATE TRIGGER/.test(s.trim()));
    assert.ok(dropIndex > -1 && createIndex > -1);
    assert.ok(dropIndex < createIndex, "drop must come before create");
});

test("the post-deploy pass takes BOTH guards back out", () => {
    // They are compatibility scaffolding for ONE deploy. Left standing, the
    // split-job guard would overrule a future writer that legitimately moves
    // an estimate, and the amount/tax guard would re-open a review on every
    // amount edit a bookkeeper makes deliberately.
    const teardown = postDeployTeardownStatements();
    for (const name of COMPATIBILITY_TRIGGERS) {
        assert.ok(
            teardown.some(s => new RegExp(`DROP TRIGGER IF EXISTS ${name}`).test(s)),
            `${name}'s trigger is never dropped`,
        );
        assert.ok(
            teardown.some(s => new RegExp(`DROP FUNCTION IF EXISTS ${name}`).test(s)),
            `${name}'s function is never dropped`,
        );
    }
    // The Drive-receipt bridge comes out in the same pass, LAST (round 48,
    // item 1): while it stands, a straggler instance is still stamped and
    // still serialized, so the sourceFileId backfill above it cannot race one.
    assert.deepEqual(teardown, [
        ...SPLIT_JOB_GUARD_DROP_SQL,
        ...AMOUNT_TAX_GUARD_DROP_SQL,
        ...SOURCE_FILE_BRIDGE_DROP_SQL,
    ]);
});

test("the amount/tax guard is a transcription of planExpenseUpdate, not a new policy", () => {
    // Every branch of src/lib/qbo-expense-sync.ts's planExpenseUpdate, in the
    // same order and with the same outcomes. Asserting the SHAPE here is what
    // keeps the two from drifting into different answers about the same row;
    // the BEHAVIOUR is proved against a real Postgres in
    // tests/expense-attribution-triggers-db.test.ts.
    const fn = AMOUNT_TAX_GUARD_SQL.find(s => s.includes("FUNCTION probuild_expense_amount_tax_guard()"))!;
    // It fires only on a gross that actually moved.
    assert.match(fn, /NEW\."amount" IS NOT DISTINCT FROM OLD\."amount"[\s\S]{0,60}RETURN NEW/);
    // Branch 1: the tax cannot fit — the figure AND every provenance that
    // described it are cleared. A surviving "manual" would keep claiming a
    // person answered about money that is gone.
    for (const column of ["taxAmount", "installedAtCustomer", "taxDeductibleBase", "taxDeductibleBaseSource", "taxSource"]) {
        assert.match(fn, new RegExp(`NEW\."${column}" := NULL`), `branch 1 never clears ${column}`);
    }
    // Branch 2: the allocation alone cannot fit.
    assert.match(fn, /base_ceiling := NEW\."amount" - COALESCE\(NEW\."taxAmount", 0\)/);
    // Branch 3: an ordinary move that breaks nothing still re-opens a review,
    // read off the OLD row exactly as planExpenseUpdate reads it off `existing`.
    //
    // Pinned against TAX_CLASSIFICATION_COLUMNS itself rather than against a
    // copy of the column list (round 38, item 3): the whole finding was that
    // three writers each carried their own answer to "is this row classified?"
    // and the narrowest of them decided what reached a state filing. Adding a
    // column to the shared constant now fails this test until the trigger
    // learns about it too.
    const classifiedClause = fn.slice(fn.indexOf("was_classified :="));
    const clauseBody = classifiedClause.slice(0, classifiedClause.indexOf(";"));
    // A FIGURE counts whenever it is present at all...
    assert.deepEqual(
        [...clauseBody.matchAll(/OLD\."(\w+)" IS NOT NULL/g)].map(m => m[1]),
        [...TAX_CLASSIFICATION_FIGURE_COLUMNS],
        "the figure columns must be named, each as a plain IS NOT NULL",
    );
    // ...a PROVENANCE only when it is a HUMAN one, and the values have to be
    // HUMAN_TAX_SOURCES rather than a list retyped in SQL.
    assert.deepEqual(
        [...clauseBody.matchAll(/COALESCE\(OLD\."(\w+)", ''\) IN \(([^)]*)\)/g)].map(m => m[1]),
        [...TAX_CLASSIFICATION_SOURCE_COLUMNS],
        "the provenance columns must be named, each tested against the human values",
    );
    for (const [, , values] of clauseBody.matchAll(/COALESCE\(OLD\."(\w+)", ''\) IN \(([^)]*)\)/g)) {
        assert.deepEqual(
            values.split(",").map(value => value.trim().replace(/^'|'$/g, "")),
            [...HUMAN_TAX_SOURCES],
        );
    }
    // Nothing outside the shared list may appear in the test at all.
    const allNamed = [...clauseBody.matchAll(/OLD\."(\w+)"/g)].map(m => m[1]);
    assert.deepEqual(allNamed, [...TAX_CLASSIFICATION_COLUMNS]);
    // ...and the review flag is the only thing branch 3 sets — but ONLY when
    // the statement did not state the flag itself (round 41, item 3). It used
    // to be unconditional, which is what defeated a valid `taxReviewAck`.
    assert.match(
        fn,
        /IF was_classified\s+AND COALESCE\(current_setting\('probuild\.tax_flag_stated', true\), ''\)\s+IS DISTINCT FROM NEW\."id" \|\| '@' \|\| statement_timestamp\(\)::text\s+THEN\s+NEW\."needsTaxReview" := true;\s+END IF;/,
    );
    // Branches 1 and 2 stay UNCONDITIONAL: a classification the new gross
    // cannot carry needs review whatever the statement claims, and the old
    // build cannot reach them while naming the flag anyway.
    assert.ok(
        !/tax_flag_stated/.test(fn.slice(0, fn.indexOf("IF was_classified"))),
        "the exemption applies to branch 3 only",
    );
    // The derived flag is re-derived last, so no path can leave the row in
    // violation of Expense_taxAtSource_check.
    assert.match(fn, /NEW\."taxAtSource" := \(NEW\."taxAmount" IS NOT NULL AND NEW\."taxAmount" <> 0\);\s+RETURN NEW/);
    // It NEVER invents a figure: nothing is assigned a computed tax amount.
    assert.ok(
        !/NEW\."(taxAmount|taxDeductibleBase)" := (?!NULL)/.test(fn),
        "the guard must clear a figure it cannot keep, never compute a replacement",
    );
});

test("the amount/tax trigger fires BEFORE UPDATE OF amount, per row", () => {
    const trigger = AMOUNT_TAX_GUARD_SQL.find(s => /^CREATE TRIGGER probuild_expense_amount_tax_guard/.test(s.trim()))!;
    assert.match(trigger, /BEFORE UPDATE OF "amount" ON "Expense"/);
    assert.match(trigger, /FOR EACH ROW/);
    // BEFORE, not AFTER: an AFTER trigger cannot change the row that is
    // landing, so a gross that violates a CHECK would still fail the old
    // writer instead of being made coherent.
    assert.ok(!/AFTER UPDATE/.test(trigger));
});

test("the amount/tax guard is idempotent to re-create", () => {
    // Same rule as the split-job guard: no CREATE TRIGGER IF NOT EXISTS
    // exists, so the drop has to come first or a second run of this script
    // fails on the trigger the first one left.
    const dropIndex = AMOUNT_TAX_GUARD_SQL.findIndex(s => /^DROP TRIGGER IF EXISTS/.test(s.trim()));
    const createIndex = AMOUNT_TAX_GUARD_SQL.findIndex(s => /^CREATE TRIGGER/.test(s.trim()));
    assert.ok(dropIndex > -1 && createIndex > -1);
    assert.ok(dropIndex < createIndex, "drop must come before create");
    assert.match(AMOUNT_TAX_GUARD_SQL[0], /CREATE OR REPLACE FUNCTION/);
});

test("both guards go in BEFORE the projectId backfill", () => {
    // From the moment the columns carry values, an old instance can damage
    // them. A guard created after the fill leaves exactly that window open.
    const fillAt = (statements as string[]).indexOf(PROJECT_ID_BACKFILL);
    assert.ok(fillAt > -1);
    for (const create of [SPLIT_JOB_GUARD_SQL, AMOUNT_TAX_GUARD_SQL]) {
        const at = (statements as string[]).indexOf(create[create.length - 1]);
        assert.ok(at > -1, "the CREATE TRIGGER is not in the main run at all");
        assert.ok(at < fillAt, "the guard must be standing before the fill runs");
    }
});

test("the split-job repair is OPT-IN and never runs by default", () => {
    // After the new build is live, a mismatched pair is EITHER the rollout
    // window OR a bookkeeper's deliberate re-attribution, and the row cannot
    // say which. Running the repair by default would mean choosing to overwrite
    // human decisions whenever the guess is wrong.
    assert.equal(postDeployTeardownStatements().includes(SPLIT_JOB_REPAIR), false);
    assert.equal(postDeployTeardownStatements({ repairSplitJobs: false }).includes(SPLIT_JOB_REPAIR), false);
    assert.equal(postDeployTeardownStatements({ repairSplitJobs: true }).includes(SPLIT_JOB_REPAIR), true);
});

test("the repair runs BEFORE the guard is dropped, and only on QBO-synced rows", () => {
    const withRepair = postDeployTeardownStatements({ repairSplitJobs: true });
    // ROUND 15, ITEM 2: the project lock travels WITH the repair, immediately
    // before it — the same shape PROJECT_ID_BACKFILL_LOCK_PROJECTS has beside
    // PROJECT_ID_BACKFILL, and for the same reason: the repair's UPDATE takes
    // FOR KEY SHARE on every referenced Project through the FK this script
    // adds, so on its own it is Estimate -> Project.
    assert.equal(withRepair[0], SPLIT_JOB_REPAIR_LOCK_PROJECTS, "the project lock runs first");
    assert.equal(withRepair[1], SPLIT_JOB_REPAIR, "repair second, teardown third");
    assert.ok(
        !/WITH\s/i.test(SPLIT_JOB_REPAIR_LOCK_PROJECTS),
        "the project lock must not be folded into a CTE",
    );
    assert.match(SPLIT_JOB_REPAIR_LOCK_PROJECTS, /FROM "Project" p/);
    assert.match(SPLIT_JOB_REPAIR_LOCK_PROJECTS, /ORDER BY p\.id\s+FOR SHARE/);
    assert.ok(!/\b(UPDATE|INSERT|DELETE)\b/i.test(SPLIT_JOB_REPAIR_LOCK_PROJECTS), "it locks, it does not write");

    // The old QBO sync is the only writer that rewrites estimateId without
    // projectId, so a row that never came from QuickBooks cannot have been
    // damaged this way and is never a candidate however the flag is passed.
    assert.match(SPLIT_JOB_REPAIR, /"qbPurchaseId" IS NOT NULL/);
    // It targets the NON-NULL wrong answer the backfill is blind to...
    assert.match(SPLIT_JOB_REPAIR, /e\."projectId" <> locked\."projectId"/);
    // ...and re-derives from the estimate under the same locked CTE and the
    // same ascending-id order as PROJECT_ID_BACKFILL.
    assert.match(SPLIT_JOB_REPAIR, /ORDER BY est\.id\s+FOR SHARE/);
    assert.match(SPLIT_JOB_REPAIR, /"attributionAnchoredAt" = now\(\)/);
});

test("the repair is NOT in the main run, and the post-deploy subset invariant still holds", () => {
    // postDeployStatements' invariant is that it is a strict SUBSET of the main
    // run. The teardown and the repair have no counterpart there — the teardown
    // is the opposite of what the main run does — so they must stay out of it.
    assert.equal((statements as string[]).includes(SPLIT_JOB_REPAIR), false);
    const main = [...(statements as string[]), reanchorSql("America/Los_Angeles")];
    for (const sql of postDeployStatements("America/Los_Angeles")) {
        assert.ok(main.includes(sql), `not part of the main run:\n  ${sql}`);
    }
});

test("the guard and its teardown are BOTH in the committed migration", () => {
    // A fresh CI/dev database replays the migration end to end, so it must
    // finish in the shape production finishes in: with no trigger. A migration
    // that created it and never dropped it would leave every dev database
    // carrying compatibility scaffolding forever.
    for (const sql of SPLIT_JOB_GUARD_SQL) {
        assert.ok(normalizedMigration.includes(normalize(sql).replace(/;$/, "")), `migration.sql is missing:\n  ${sql}`);
    }
    for (const sql of SPLIT_JOB_GUARD_DROP_SQL) {
        assert.ok(normalizedMigration.includes(normalize(sql).replace(/;$/, "")), `migration.sql is missing:\n  ${sql}`);
    }
    // ...and the drop comes last, after the backfill it was protecting.
    const create = migrationSql.indexOf("CREATE TRIGGER probuild_expense_estimate_pair_guard");
    const fill = migrationSql.indexOf('UPDATE "Expense" e SET "projectId" = locked."projectId"');
    const drop = migrationSql.lastIndexOf("DROP FUNCTION IF EXISTS probuild_expense_estimate_pair_guard");
    assert.ok(create > -1 && fill > -1 && drop > -1);
    assert.ok(create < fill, "the guard has to exist before the fill gives the column values");
    assert.ok(fill < drop, "and it comes out only after the fill is done");
});

test("the amount/tax guard and its teardown are BOTH in the committed migration", () => {
    // Same contract as the split-job guard above: a fresh CI/dev database
    // replays this migration end to end and must finish in production's END
    // state — with neither trigger standing.
    for (const sql of [...AMOUNT_TAX_GUARD_SQL, ...AMOUNT_TAX_GUARD_DROP_SQL]) {
        assert.ok(normalizedMigration.includes(normalize(sql).replace(/;$/, "")), `migration.sql is missing:\n  ${sql}`);
    }
    const create = migrationSql.indexOf("CREATE TRIGGER probuild_expense_amount_tax_guard");
    const fill = migrationSql.indexOf('UPDATE "Expense" e SET "projectId" = locked."projectId"');
    const drop = migrationSql.lastIndexOf("DROP FUNCTION IF EXISTS probuild_expense_amount_tax_guard");
    assert.ok(create > -1 && fill > -1 && drop > -1);
    assert.ok(create < fill, "the guard has to exist before the fill gives the columns values");
    assert.ok(fill < drop, "and it comes out only after the fill is done");
});

// ── the CHECK comparison survives Postgres's own rendering (round 46, item 0) ─

test("normalizeCheckDefinition sees through PG's parens, casts and whitespace", () => {
    // THE DEPLOY BLOCKER. The old form was a list of regexes against
    // `pg_get_constraintdef`, and Postgres 16 renders a CHECK with its own
    // parenthesisation and casts:
    //
    //   CHECK (("taxAtSource" = (("taxAmount" IS NOT NULL) AND ("taxAmount" <> (0)::numeric))))
    //
    // `/"taxAtSource" = \(?"taxAmount" IS NOT NULL/` allows ONE optional paren
    // and PG writes TWO, so the script exited 1 on a database it had just built
    // correctly. Nothing caught it because CI never ran `main()`.
    const pg16 = `CHECK (("taxAtSource" = (("taxAmount" IS NOT NULL) AND ("taxAmount" <> (0)::numeric))))`;
    const ours = `"taxAtSource" = ("taxAmount" IS NOT NULL AND "taxAmount" <> 0)`;
    assert.equal(normalizeCheckDefinition(pg16), normalizeCheckDefinition(ours));

    // ...and it still says NO to a real difference. Every column name,
    // operator, function and their order has to match.
    for (const drifted of [
        `"taxAtSource" = ("taxAmount" IS NULL AND "taxAmount" <> 0)`,
        `"taxAtSource" = ("taxAmount" IS NOT NULL OR "taxAmount" <> 0)`,
        `"taxAtSource" = ("taxAmount" IS NOT NULL AND "taxAmount" <> 1)`,
        `"taxAtSource" = ("taxAmount" IS NOT NULL AND "amount" <> 0)`,
    ]) {
        assert.notEqual(
            normalizeCheckDefinition(pg16),
            normalizeCheckDefinition(drifted),
            drifted,
        );
    }
});

test("every expected CHECK is written the way this script writes it", () => {
    // Each definition is compared against the live catalog by the end-to-end CI
    // step; this pins the SHAPE so a typo fails here first. The renderings are
    // Postgres 16's own, captured from a real database.
    const rendered: Record<string, string> = {
        Expense_taxAtSource_check:
            `CHECK (("taxAtSource" = (("taxAmount" IS NOT NULL) AND ("taxAmount" <> (0)::numeric))))`,
        Expense_taxAmount_check:
            `CHECK ((("taxAmount" IS NULL) OR ("taxAmount" = (0)::numeric) OR ((sign("taxAmount") = sign(amount)) AND (abs("taxAmount") <= abs(amount)))))`,
        Expense_taxDeductibleBase_check:
            `CHECK ((("taxDeductibleBase" IS NULL) OR ("taxDeductibleBase" = (0)::numeric) OR ((sign("taxDeductibleBase") = sign(amount)) AND (abs("taxDeductibleBase") <= abs((amount - COALESCE("taxAmount", (0)::numeric)))))))`,
    };
    assert.equal(expectedCheckConstraints.length, 3);
    for (const { name, table, definition } of expectedCheckConstraints as {
        name: string; table: string; definition: string;
    }[]) {
        assert.equal(table, "Expense");
        assert.ok(rendered[name], `no captured PG rendering for ${name}`);
        assert.equal(
            normalizeCheckDefinition(definition),
            normalizeCheckDefinition(rendered[name]),
            `${name} does not match what Postgres renders`,
        );
        // No regexes left: the comparison is definition equality now.
        assert.equal(
            (expectedCheckConstraints as { mustMatch?: unknown }[]).some(c => c.mustMatch),
            false,
            "the substring form is gone, not merely accompanied",
        );
    }
});

test("the index verifier checks that an index is USABLE, not just present", () => {
    // ROUND 46, ITEM 1. A failed `CREATE INDEX CONCURRENTLY` leaves an index
    // with the right NAME and `indisvalid = false`: the planner ignores it and
    // a UNIQUE one enforces nothing, while `IF NOT EXISTS` skips it forever.
    const script = readFileSync(
        path.join(__dirname, "..", "scripts", "apply-expense-attribution.mjs"),
        "utf8",
    );
    assert.match(script, /i\.indisvalid\s+AS is_valid/, "the catalog read asks for validity");
    assert.match(script, /i\.indisready\s+AS is_ready/);
    assert.match(script, /row\.is_valid !== true \|\| row\.is_ready !== true/, "and the verifier acts on it");
    // ...and REBUILDS rather than merely reporting: IF NOT EXISTS can never
    // repair it, so telling a human is how it stayed invisible.
    assert.match(script, /DROP INDEX CONCURRENTLY IF EXISTS/);
    assert.match(script, /toConcurrentIndexSql\(rebuild\)/);
    assert.match(script, /is STILL invalid after a rebuild/, "and gives up loudly rather than looping");
});


// ── WHICH DATABASE (cross-PR rule, round 46) ───────────────────────────────

/**
 * A developer with a local Postgres in their shell could run this script,
 * watch every "verified ..." line print, and merge believing production had
 * the columns. `--expect-db` / `--expect-host` did not stop it: the operator
 * supplies BOTH sides of that comparison, so a local server satisfies it as
 * easily as the real one. The target has to be named, and prod's URL has to
 * come from the deployed env file rather than the shell.
 */
test("no --target is a refusal, not a default", () => {
    const missing = parseTarget(["node", "apply.mjs", "--yes"]);
    assert.match(missing.error ?? "", /--target is required/);
    // A misspelling is not a silent fallback to prod either.
    const wrong = parseTarget(["node", "apply.mjs", "--target", "production"]);
    assert.match(wrong.error ?? "", /Unknown --target/);
    const bare = parseTarget(["node", "apply.mjs", "--target"]);
    assert.match(bare.error ?? "", /Unknown --target/);
    assert.equal(parseTarget(["node", "apply.mjs", "--target", "prod"]).name, "prod");
    assert.equal(parseTarget(["node", "apply.mjs", "--target", "ci", "--yes"]).name, "ci");
});

test("an ambient DATABASE_URL cannot impersonate production", () => {
    // The failure this exists for, exactly: a local database in the shell.
    const ambient = { DATABASE_URL: "postgresql://probuild:probuild@localhost:5432/probuild" } as unknown as NodeJS.ProcessEnv;
    const files = {
        ".env.production.local":
            "NEXTAUTH_SECRET=irrelevant\n" +
            'DATABASE_URL="postgresql://postgres.ref:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true"\n',
    };
    const io = {
        env: ambient,
        exists: (file: unknown) => String(file) in files,
        read: (file: unknown) => files[String(file) as keyof typeof files],
    };

    const prod = resolveTargetDatabaseUrl("prod", io);
    assert.equal(prod.from, ".env.production.local", "the file, never the shell");
    assert.match(prod.url ?? "", /pooler\.supabase\.com/);
    assert.doesNotMatch(prod.url ?? "", /localhost/, "the ambient value is not consulted at all");

    // ...and with no such file, prod REFUSES rather than falling back to it.
    const noFile = resolveTargetDatabaseUrl("prod", { ...io, exists: () => false });
    assert.match(noFile.error ?? "", /\.env\.production\.local, which does not exist/);
    assert.equal(noFile.url, undefined, "no URL is produced, so no DDL can run");

    // The CI target is the one that DOES read the environment.
    const ci = resolveTargetDatabaseUrl("ci", io);
    assert.equal(ci.url, ambient.DATABASE_URL);
    assert.equal(ci.from, "process.env.DATABASE_URL");
});

test("each target refuses the other one's host", () => {
    assert.match(
        targetHostVerdict("prod", "postgresql://u:p@localhost:5432/probuild") ?? "",
        /expects the Supabase pooler, but the URL points at localhost/,
    );
    assert.equal(
        targetHostVerdict("prod", "postgresql://u:p@aws-0-us-west-2.pooler.supabase.com:6543/postgres"),
        null,
    );
    // The reverse guard: the CI path must never be pointed at production, so
    // the throwaway-container mode cannot become a way around the prod checks.
    assert.match(
        targetHostVerdict("ci", "postgresql://u:p@db.ghzdbzdnwjxazvmcefbh.supabase.co:5432/postgres") ?? "",
        /must never point at .*supabase\.co — that is production/,
    );
    assert.equal(targetHostVerdict("ci", "postgresql://u:p@localhost:5432/probuild_apply"), null);
});

test("only prod demands the production baseline row", () => {
    assert.equal(APPLY_TARGETS.prod.requireBaseline, true);
    assert.equal(APPLY_TARGETS.ci.requireBaseline, false);
    // The name is the one CLAUDE.md documents as marked applied in prod by the
    // deliberate one-off `migrate resolve --applied` step.
    assert.equal(PRODUCTION_BASELINE_MIGRATION, "20260814000000_baseline_production");
    assert.ok(
        readFileSync(path.resolve(__dirname, "..", "prisma", "migrations", PRODUCTION_BASELINE_MIGRATION, "migration.sql"), "utf8").length > 0,
        "and it is a real migration in this repo",
    );
});

test("the banner names the database and REDACTS the credentials", () => {
    const line = targetBanner("prod", {
        url: "postgresql://postgres.ref:sup3rs3cret@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true",
        from: ".env.production.local",
        db: "postgres",
        host: "10.0.0.5",
    });
    assert.doesNotMatch(line, /sup3rs3cret/, "the password never reaches the terminal");
    assert.match(line, /:\*\*\*\*@/);
    assert.match(line, /TARGET prod/);
    assert.match(line, /db="postgres"/);
    assert.match(line, /server="10\.0\.0\.5"/);
    assert.match(line, /from \.env\.production\.local/);
});

test("the CI driver passes --target ci, so the prod guard cannot be met by accident", () => {
    const driver = readFileSync(
        path.resolve(__dirname, "..", "scripts", "ci-apply-expense-attribution-e2e.mjs"),
        "utf8",
    );
    assert.match(driver, /"--target", "ci"/);
    assert.doesNotMatch(driver, /"--target", "prod"/);
});

test("THE ACTUAL SCRIPT refuses an ambient local URL, before any DDL", () => {
    // The refusal has to happen in the real process, not just in the pure
    // helpers: `main()` could call them and ignore the answer. Both attempts
    // below exit before a PrismaClient is even constructed, which is why this
    // needs no database.
    const script = path.resolve(__dirname, "..", "scripts", "apply-expense-attribution.mjs");
    const ambient = {
        ...process.env,
        DATABASE_URL: "postgresql://probuild:probuild@localhost:5432/probuild",
    };
    const attempt = (args: string[]) => {
        try {
            const stdout = execFileSync(process.execPath, [script, ...args], {
                env: ambient, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            });
            return { code: 0, output: stdout };
        } catch (error) {
            const failure = error as { status?: number; stdout?: string; stderr?: string };
            return { code: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
        }
    };

    const noTarget = attempt(["--yes", "--expect-db", "probuild", "--expect-host", "127.0.0.1"]);
    assert.notEqual(noTarget.code, 0, "it must not run");
    assert.match(noTarget.output, /REFUSING: --target is required/);
    assert.doesNotMatch(noTarget.output, /applied|verified/, "nothing was executed against the database");

    // ...and naming prod does not rescue it: the URL would come from
    // .env.production.local, which is not checked in and is not on CI.
    const asProd = attempt(["--target", "prod", "--yes", "--expect-db", "probuild", "--expect-host", "127.0.0.1"]);
    assert.notEqual(asProd.code, 0);
    assert.match(asProd.output, /REFUSING/);
    assert.doesNotMatch(asProd.output, /localhost/, "the ambient URL is not even echoed as a candidate");
});

test("the HOST is not the identity — the project ref is", () => {
    // Supabase pooler hostnames are shared REGIONALLY and every project's
    // database is called `postgres`, so host + database name + baseline row
    // all match a migrated staging clone just as well as they match
    // production. The ref in the URL username is the only thing that does not.
    const PROD = "postgresql://postgres.ghzdbzdnwjxazvmcefbh:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true";
    const CLONE = "postgresql://postgres.stagingprojectref:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true";

    assert.equal(projectRefFromUrl(PROD), "ghzdbzdnwjxazvmcefbh");
    assert.equal(projectRefFromUrl(CLONE), "stagingprojectref");
    // The direct-connection spelling puts the ref in the HOST instead. Read
    // too, so changing connection style cannot silently disable the check.
    assert.equal(
        projectRefFromUrl("postgresql://postgres:pw@db.ghzdbzdnwjxazvmcefbh.supabase.co:5432/postgres"),
        "ghzdbzdnwjxazvmcefbh",
    );
    assert.equal(projectRefFromUrl("postgresql://probuild:probuild@localhost:5432/probuild"), null);

    const env = { APPLY_EXPECT_PROJECT_REF: "ghzdbzdnwjxazvmcefbh" } as unknown as NodeJS.ProcessEnv;
    assert.equal(projectRefVerdict("prod", PROD, env), null, "the real project passes");
    const refused = projectRefVerdict("prod", CLONE, env);
    assert.match(refused ?? "", /this URL is for project stagingprojectref, not ghzdbzdnwjxazvmcefbh/);
    assert.match(refused ?? "", /shared across projects in a region/, "and it says WHY the other checks did not catch it");
});

test("an UNSET APPLY_EXPECT_PROJECT_REF is a refusal, not a skipped check", () => {
    // A guard that turns itself off when its input is missing protects nothing
    // on the machine that matters — the one where somebody is in a hurry.
    const PROD = "postgresql://postgres.ghzdbzdnwjxazvmcefbh:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres";
    for (const env of [{}, { APPLY_EXPECT_PROJECT_REF: "" }, { APPLY_EXPECT_PROJECT_REF: "   " }]) {
        assert.match(
            projectRefVerdict("prod", PROD, env as unknown as NodeJS.ProcessEnv) ?? "",
            /requires APPLY_EXPECT_PROJECT_REF/,
        );
    }
    // The name is shared with the other apply scripts on purpose: one variable,
    // set once, covers all of them.
    assert.match(
        projectRefVerdict("prod", PROD, {} as unknown as NodeJS.ProcessEnv) ?? "",
        /APPLY_EXPECT_PROJECT_REF/,
    );
    // ...and CI never asks for one: a throwaway container has no project ref.
    assert.equal(
        projectRefVerdict("ci", "postgresql://probuild:probuild@localhost:5432/probuild_apply", {} as unknown as NodeJS.ProcessEnv),
        null,
    );
});

test("the banner names the project, still redacted", () => {
    const line = targetBanner("prod", {
        url: "postgresql://postgres.ghzdbzdnwjxazvmcefbh:sup3rs3cret@aws-0-us-west-2.pooler.supabase.com:6543/postgres",
        from: ".env.production.local",
        db: "postgres",
        host: "10.0.0.5",
    });
    assert.match(line, /project="ghzdbzdnwjxazvmcefbh"/);
    assert.doesNotMatch(line, /sup3rs3cret/);
});

// ── the Drive-receipt drain-window bridge (round 48, item 1) ───────────────

test("the bridge locks the SAME key the ingest route locks", () => {
    // The one way this bridge could look installed and do nothing: hash a
    // different string, take a different lock, serialize with nobody. The
    // route's key is read out of the route rather than restated here.
    const route = readFileSync(
        path.resolve(__dirname, "..", "src", "app", "api", "integrations", "receipt-ingest", "route.ts"),
        "utf8",
    );
    const prefix = route.match(/RECEIPT_INGEST_LOCK_PREFIX = "([^"]+)"/)?.[1];
    assert.equal(prefix, "receipt-ingest:", "the route's lock prefix moved");
    assert.match(route, /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/,
        "the route hashes with hashtextextended");

    const fn = SOURCE_FILE_BRIDGE_SQL[0];
    assert.match(fn, /pg_advisory_xact_lock\(/);
    assert.match(fn, /hashtextextended\('receipt-ingest:' \|\| NEW\."sourceFileId", 0\)/,
        "the trigger must hash the SAME prefixed id, with the SAME function");
    assert.doesNotMatch(fn, /hashtext\(/, "hashtext() is a different lock space");
});

test("the bridge derives the file id the same way the backfill does", () => {
    // Two extractors that disagree would stamp one id at INSERT and a
    // different one at backfill time, which is a duplicate with extra steps.
    for (const pattern of ["/d/([A-Za-z0-9_-]+)", "[?&]id=([A-Za-z0-9_-]+)"]) {
        assert.ok(SOURCE_FILE_ID_BACKFILL.includes(pattern), `backfill lost ${pattern}`);
        assert.ok(SOURCE_FILE_BRIDGE_SQL[0].includes(pattern), `bridge lost ${pattern}`);
    }
});

test("the ordinal counts within the TRANSACTION, not within the table", () => {
    // MAX(existing) + 1 is the obvious rule and it is the wrong one: a
    // re-delivery would land on fresh ordinals and insert cleanly, which is
    // exactly the duplicate this bridge exists to stop. Counting per
    // transaction makes a second delivery collide with the rows already there.
    const fn = SOURCE_FILE_BRIDGE_SQL[0];
    assert.match(fn, /set_config\(counter_key, next_index::text, true\)/,
        "the counter must be TRANSACTION-local");
    assert.match(fn, /current_setting\(counter_key, true\)/);
    assert.doesNotMatch(fn, /MAX\("sourceGroupIndex"\)/,
        "a table-wide MAX lets a re-delivery insert cleanly");
});

test("it fires BEFORE INSERT and only touches rows that stay silent", () => {
    assert.match(SOURCE_FILE_BRIDGE_SQL[2], /BEFORE INSERT ON "Expense"/);
    assert.match(SOURCE_FILE_BRIDGE_SQL[2], /FOR EACH ROW/);
    // A row that names its own file id is the NEW build's; the trigger must
    // not renumber it.
    assert.match(SOURCE_FILE_BRIDGE_SQL[0], /IF NEW\."sourceFileId" IS NULL AND NEW\."receiptUrl" IS NOT NULL THEN/);
    assert.match(SOURCE_FILE_BRIDGE_SQL[0], /IF NEW\."sourceGroupIndex" IS NULL THEN/);
    // ...and an expense with no Drive url at all pays nothing.
    assert.match(SOURCE_FILE_BRIDGE_SQL[0], /IF NEW\."sourceFileId" IS NULL THEN\s+RETURN NEW;/);
});

test("the bridge and its teardown are BOTH in the committed migration", () => {
    // Same contract as the other two guards: a fresh CI/dev database replays
    // this migration end to end and must finish in production's END state,
    // with no scaffolding standing.
    for (const sql of [...SOURCE_FILE_BRIDGE_SQL, ...SOURCE_FILE_BRIDGE_DROP_SQL]) {
        assert.ok(normalizedMigration.includes(normalize(sql).replace(/;$/, "")), `migration.sql is missing:\n  ${sql}`);
    }
    const create = migrationSql.indexOf("CREATE TRIGGER probuild_expense_source_file_bridge");
    const fill = migrationSql.indexOf('UPDATE "Expense" e SET "projectId" = locked."projectId"');
    const drop = migrationSql.lastIndexOf("DROP FUNCTION IF EXISTS probuild_expense_source_file_bridge");
    assert.ok(create > -1 && fill > -1 && drop > -1);
    assert.ok(create < fill, "it has to stand before the backfill stamps ids");
    assert.ok(fill < drop, "and it comes out only after the backfill is done");
});

test("--post-deploy drops the bridge AFTER it has stamped the stragglers", () => {
    // Order is the whole argument: the backfill can only be safe if nothing
    // is still inserting unstamped rows behind it.
    const teardown = postDeployStatements("America/Los_Angeles")
        .concat(postDeployTeardownStatements({}));
    const backfillAt = teardown.findIndex(sql => sql.includes('SET "sourceFileId" = COALESCE'));
    const dropAt = teardown.findIndex(sql => sql.includes("DROP TRIGGER IF EXISTS probuild_expense_source_file_bridge"));
    assert.ok(backfillAt > -1, "the sourceFileId backfill runs in --post-deploy");
    assert.ok(dropAt > -1, "and the bridge is dropped in the same pass");
    assert.ok(backfillAt < dropAt, "the stamping happens while the bridge still stands");
});

// ── the guard must ACCEPT the real production URL (P0 on the sibling PR) ──

/** Byte-for-byte the shape CLAUDE.md documents for production. */
const PROD_URL =
    "postgresql://postgres.ghzdbzdnwjxazvmcefbh:s3cr3t@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true";

test("the prod guard ACCEPTS the real pooler URL, port and all", () => {
    // The failure this pins was found on the sibling PR: `new URL(url).host`
    // includes the PORT (`aws-0-us-west-2.pooler.supabase.com:6543`), so a
    // `/pooler\.supabase\.com$/` test against `host` rejects every real
    // transaction-pooler URL — and CI would never notice, because CI only
    // ever exercises `--target ci`. This helper reads `hostname`; the test is
    // here so it keeps doing that.
    assert.equal(new URL(PROD_URL).host, "aws-0-us-west-2.pooler.supabase.com:6543");
    assert.equal(new URL(PROD_URL).hostname, "aws-0-us-west-2.pooler.supabase.com");
    assert.equal(targetHostVerdict("prod", PROD_URL), null, "the REAL prod URL must pass the host check");
});

test("...and the whole chain passes with the right ref, refuses with a wrong one", () => {
    // The composite a caller actually uses — target, url source, host, ref —
    // driven against the production URL with the env file faked, because the
    // pieces can each be right while the wiring drops one.
    const files = { ".env.production.local": `DATABASE_URL="${PROD_URL}"\n` };
    const disk = {
        exists: (file: unknown) => String(file) in files,
        read: (file: unknown) => files[String(file) as keyof typeof files],
    };
    const argv = ["node", "apply.mjs", "--target", "prod", "--yes"];

    const right = resolveTargetOrRefuse(
        argv,
        { APPLY_EXPECT_PROJECT_REF: "ghzdbzdnwjxazvmcefbh" } as unknown as NodeJS.ProcessEnv,
        disk,
    );
    assert.equal(right.error, undefined, `the real production target must be accepted: ${right.error}`);
    assert.equal(right.target, "prod");
    assert.equal(right.url, PROD_URL);
    assert.equal(right.from, ".env.production.local");

    const wrong = resolveTargetOrRefuse(
        argv,
        { APPLY_EXPECT_PROJECT_REF: "stagingprojectref" } as unknown as NodeJS.ProcessEnv,
        disk,
    );
    assert.match(wrong.error ?? "", /this URL is for project ghzdbzdnwjxazvmcefbh, not stagingprojectref/);
    assert.equal(wrong.url, undefined, "and no URL is handed back to connect with");

    // ...and the banner built from that URL still hides the password.
    assert.doesNotMatch(targetBanner("prod", { url: PROD_URL, from: ".env.production.local", db: "postgres", host: "10.0.0.5" }), /s3cr3t/);
});
