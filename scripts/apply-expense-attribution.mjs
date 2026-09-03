// One-off additive migration for Expense attribution (Receipt Pipeline v2,
// Phase 3 — docs/plans/PHASE-3-ATTRIBUTION-SPEC.md §2): the denormalized
// `projectId` every money-path reader resolves through, plus the tax columns
// the WA "tax paid at source" deduction report needs, plus the provenance of a
// row's cost code so an automated suggester can never overwrite a human.
//
// The SQL here is byte-equivalent to
// prisma/migrations/20260901120000_expense_attribution/migration.sql — that
// file is what a fresh CI/dev database gets; this script is what production
// gets, BEFORE the build that selects these columns deploys (CLAUDE.md
// pre-deploy rule #2 — otherwise every page touching them throws P2022).
// tests/apply-expense-attribution.test.ts asserts the two never drift.
//
// Additive and idempotent: ADD COLUMN / CREATE INDEX IF NOT EXISTS, a guarded
// constraint add, and a backfill UPDATE that only ever touches rows whose
// `projectId` is still NULL. A second run reports every statement "ok" and
// updates 0 rows.
//
//   node scripts/apply-expense-attribution.mjs --yes --expect-db <name> --expect-host <host>
//
// THIS DEPLOY IS TWO PASSES, NOT ONE. The --post-deploy pass below is not an
// optional cleanup — skipping it leaves every Expense the old build wrote
// while it drained permanently NULL-projectId and UTC-midnight, silently
// dropped from the variance report and the tax-paid-at-source report with no
// error anywhere. Run it AFTER the new build is live and the old one has
// drained (Vercel: previous deployment no longer serving traffic):
//
//   node scripts/apply-expense-attribution.mjs --post-deploy --yes --expect-db <name> --expect-host <host>
//
// The run itself proves it worked: the verify step at the end reports the
// count of rows still unattributed / still unanchored, and a --post-deploy
// pass is not done until both read 0. See the POST-DEPLOY note above
// `PROJECT_ID_BACKFILL`.
//
// --expect-db and --expect-host are BOTH required alongside --yes, matching
// scripts/apply-receipt-intake.mjs: "--yes" alone only proves you meant to run
// something, and a database NAME alone doesn't prove which SERVER it's on.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, from: "process.env.DATABASE_URL" };
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return { url: match[1], from: file };
    }
    throw new Error("DATABASE_URL not found in process.env, .env.local, or .env");
}

/**
 * WHICH DATABASE, SAID OUT LOUD (cross-PR rule, round 46).
 *
 * `resolveDatabaseUrl` above prefers an AMBIENT `DATABASE_URL`. That is the
 * right default for a driver that hands the script a throwaway container, and
 * the wrong one for a person: a developer with a local Postgres in their shell
 * runs this, watches every "verified ..." line print, and merges believing
 * production has the columns. Nothing in the output contradicts them —
 * `--expect-db postgres --expect-host ...` can be satisfied by a local server
 * as easily as by the real one, because the operator supplies both sides of
 * that comparison.
 *
 * So the TARGET is now an explicit argument, and each target decides where the
 * URL may come from:
 *
 *   * `--target prod` reads `.env.production.local` and IGNORES the ambient
 *     `DATABASE_URL` entirely — the file Vercel writes is the only thing that
 *     can name production — and additionally requires the pooler host and the
 *     production baseline migration row.
 *   * `--target ci` is the throwaway container: ambient `DATABASE_URL`, no
 *     baseline row (a database built from `migrate deploy` in a fresh
 *     container has one, but a hand-rolled fixture may not), and it REFUSES a
 *     Supabase-looking URL so the CI path can never be pointed at prod.
 *
 * Both are named on the command line. There is deliberately no default: a
 * missing `--target` is an error, not a guess.
 */
export const APPLY_TARGETS = {
    prod: {
        envFile: ".env.production.local",
        allowAmbient: false,
        requireBaseline: true,
        hostMustMatch: /(^|\.)pooler\.supabase\.com$/i,
        hostDescription: "the Supabase pooler",
    },
    ci: {
        envFile: null,
        allowAmbient: true,
        requireBaseline: false,
        hostMustNotMatch: /supabase\.(co|com)$/i,
        hostDescription: "a throwaway container",
    },
};

/** The migration whose presence proves this is the real, baselined database. */
export const PRODUCTION_BASELINE_MIGRATION = "20260814000000_baseline_production";

/**
 * `--target <name>` out of an argv array. Returns the name or an error string;
 * never throws, so `main()` can print and exit rather than stack-trace.
 */
export function parseTarget(argv) {
    const idx = argv.indexOf("--target");
    if (idx < 0) {
        return { error: `--target is required: one of ${Object.keys(APPLY_TARGETS).join(", ")}.` };
    }
    const name = argv[idx + 1];
    if (!name || !Object.prototype.hasOwnProperty.call(APPLY_TARGETS, name)) {
        return { error: `Unknown --target ${JSON.stringify(name ?? null)}: expected one of ${Object.keys(APPLY_TARGETS).join(", ")}.` };
    }
    return { name, target: APPLY_TARGETS[name] };
}

/**
 * The URL this target is allowed to use.
 *
 * `env` and the two fs functions are parameters so the rule can be tested
 * without a `.env.production.local` on the machine running the tests — and so
 * the "ambient DATABASE_URL is ignored for prod" claim is checked rather than
 * asserted.
 */
export function resolveTargetDatabaseUrl(
    name,
    { env = process.env, exists = fs.existsSync, read = file => fs.readFileSync(file, "utf8") } = {},
) {
    const target = APPLY_TARGETS[name];
    if (!target) return { error: `Unknown target ${name}.` };
    if (target.envFile) {
        if (!exists(target.envFile)) {
            return { error: `--target ${name} reads ${target.envFile}, which does not exist. Run: vercel env pull ${target.envFile}` };
        }
        const match = String(read(target.envFile)).match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (!match) return { error: `${target.envFile} has no DATABASE_URL.` };
        // Deliberately NOT falling back to the ambient value: for this target
        // the file is the only authority, and a missing key is an error rather
        // than a reason to use whatever is in the shell.
        return { url: match[1], from: target.envFile };
    }
    if (!env.DATABASE_URL) return { error: `--target ${name} needs DATABASE_URL in the environment.` };
    return { url: env.DATABASE_URL, from: "process.env.DATABASE_URL" };
}

/**
 * Does the URL's HOST agree with what this target is? Checked on the URL and
 * not on `inet_server_addr()`, because the latter is an IP address and "is
 * this the pooler" is a question about the name we dialled.
 */
export function targetHostVerdict(name, url) {
    const target = APPLY_TARGETS[name];
    if (!target) return `Unknown target ${name}.`;
    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        return `The resolved DATABASE_URL is not a valid URL.`;
    }
    if (target.hostMustMatch && !target.hostMustMatch.test(host)) {
        return `--target ${name} expects ${target.hostDescription}, but the URL points at ${host}.`;
    }
    if (target.hostMustNotMatch && target.hostMustNotMatch.test(host)) {
        return `--target ${name} must never point at ${host} — that is production.`;
    }
    return null;
}

/** The one line printed before any DDL, with the credentials removed. */
export function targetBanner(name, { url, from, db, host }) {
    return `TARGET ${name}: db="${db}" server="${host || "(local socket)"}" url=${maskUrl(url)} (from ${from})`;
}

export function maskUrl(url) {
    return url.replace(/:[^:@]*@/, ":****@");
}

function readFlagValue(flag) {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/**
 * Pure comparison, exported for unit testing without a live DB. Compares BOTH
 * database name and server host, and both EXACTLY — same rule and same reason
 * as apply-receipt-intake.mjs: a guard that accepts a substring gets looser the
 * shorter the operator's input is.
 */
export function targetMatches(actual, expectDb, expectHost) {
    if (!actual || typeof actual !== "object") return false;
    if (String(actual.db ?? "") !== String(expectDb ?? "")) return false;
    return String(actual.host ?? "") === String(expectHost ?? "");
}

/**
 * The company zone the legacy re-anchor uses. Read from CompanySettings at run
 * time when it is there; the fallback matches src/lib/tz-date.ts.
 */
export const DEFAULT_COMPANY_TIME_ZONE = "America/Los_Angeles";

/**
 * ONLY AN ABSENT SETTINGS ROW FALLS BACK.
 *
 * This decides the zone every legacy `Expense.date` is re-anchored INTO, so a
 * wrong answer silently moves receipts between quarters on a tax filing. There
 * are three distinguishable cases and they must not be collapsed:
 *
 *   * no row at all  -> a database that has never had settings written; the
 *                       app's own default is the honest answer.
 *   * a row with a blank zone -> same thing said differently.
 *   * a row we could not read -> NOT an answer. The previous version wrapped
 *                       the query in `.catch(() => [undefined])`, so a
 *                       permissions error, a typo'd column, or a dropped
 *                       connection read as "no settings" and quietly re-anchored
 *                       a whole table into Pacific.
 *
 * So the caller passes the QUERY RESULT and this returns the zone; an error is
 * the caller's to throw, and main() no longer swallows it.
 */
export function pickCompanyTimeZone(rows) {
    if (!Array.isArray(rows)) {
        throw new Error("CompanySettings query did not return rows; refusing to guess the company time zone");
    }
    const zone = rows[0]?.timeZone;
    if (zone === undefined || zone === null || String(zone).trim() === "") {
        return { timeZone: DEFAULT_COMPANY_TIME_ZONE, from: "default" };
    }
    return { timeZone: String(zone).trim(), from: "settings" };
}

/**
 * The WHERE clause a row must satisfy before this script re-anchors it —
 * shared by the UPDATE below and its own verification query in main(), so the
 * two can never say different things about the same row.
 *
 * DATE SHAPE, NOT THE MARKER (round 31, item 3 — the gap this replaces).
 *
 * The predicate used to gate on `attributionAnchoredAt IS NULL`, on the
 * reasoning that the marker and the row's shape can only disagree one way: a
 * legacy row, never touched, sitting at UTC midnight. That is not the only
 * way they disagree. An OLD app instance, still draining after this script's
 * DDL half has run, writes `Expense.date` with no idea the company-zone
 * anchor or the marker column exist at all — its Prisma client predates both.
 * If that instance later UPDATEs a row this script had already anchored (any
 * write that touches `date`, not only a create), the row lands back at UTC
 * midnight while the marker stays non-null from the earlier pass. Gating on
 * `attributionAnchoredAt IS NULL` excluded it forever — and the --post-deploy
 * verification, whose whole job is to prove that live-write gap is closed,
 * reported 0 while the row sat wrong.
 *
 * The fix asks the ROW instead of the marker: it needs re-anchoring exactly
 * when it sits at UTC midnight AND applying the same transform the UPDATE
 * uses would actually CHANGE its value. That is true for every legacy row
 * regardless of what the marker says, and false for a row that is genuinely
 * already anchored — including, for a company configured as UTC, one that is
 * correctly anchored and still sits at UTC midnight (the transform is the
 * identity there, so the diff is zero and the row is correctly left alone
 * rather than rescanned every run — the same non-eligible-forever guarantee
 * the marker existed to buy, derived from the row itself instead).
 */
export function needsReanchorPredicate(timeZone) {
    // The zone is interpolated, so it must be a real IANA name and nothing
    // else — this string reaches the database unparameterized.
    if (!/^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+)*$/.test(timeZone)) {
        throw new Error(`Refusing to interpolate a suspicious time zone: ${timeZone}`);
    }
    return `"date" IS NOT NULL
   AND "date"::time = TIME '00:00:00'
   AND (("date"::date)::timestamp AT TIME ZONE '${timeZone}') AT TIME ZONE 'UTC' <> "date"`;
}

/** Built per-run so the zone is the company's, not a hard-coded guess. */
export function reanchorSql(timeZone) {
    return `UPDATE "Expense"
   SET "date" = (("date"::date)::timestamp AT TIME ZONE '${timeZone}') AT TIME ZONE 'UTC',
       "attributionAnchoredAt" = now()
 WHERE ${needsReanchorPredicate(timeZone)}`;
}

/**
 * -- POST-DEPLOY: re-run this section
 *
 * THE LIVE-WRITE GAP (Codex round 21, item 3).
 *
 * This script runs BEFORE the new build deploys — it has to, or every page
 * selecting the new columns throws P2022. That ordering leaves a window: while
 * the OLD build is still serving, it keeps creating expenses, and it does not
 * know about `projectId` or about the company-calendar-day date rule. Rows
 * arriving in that window land with `projectId` NULL and a UTC-midnight date,
 * AFTER both backfills have already passed over the table.
 *
 * Nothing in a single pre-deploy run can close that — the writes have not
 * happened yet. So the resolution is to run this section AGAIN once the new
 * build is live and the old one is drained:
 *
 *   node scripts/apply-expense-attribution.mjs --post-deploy --yes \
 *     --expect-db <name> --expect-host <host>
 *
 * Both statements are idempotent BY PREDICATE, so the second pass is safe and
 * touches only the stragglers:
 *
 *   * the projectId fill matches `"projectId" IS NULL`, which is exactly the
 *     set the old build was still producing, and
 *   * the date re-anchor matches a row still sitting at UTC midnight whose
 *     company-zone anchor would actually change it (needsReanchorPredicate) —
 *     which is exactly the shape the old build wrote, AND the shape the old
 *     build can leave behind on a row this script already anchored, since its
 *     writes never touch `attributionAnchoredAt` at all.
 *
 * A re-run reporting 0 rows on both is the proof the gap is closed, and it is
 * the same check a second run of the whole script has always made.
 */
/**
 * THE BACKFILL READS THE ESTIMATE UNDER A LOCK (Codex round 32).
 *
 * The first version was a bare `UPDATE ... FROM "Estimate"`. A plain join takes
 * no row lock: under READ COMMITTED the statement reads `est."projectId"` at
 * its own snapshot, and a lead conversion (or any future move) committing right
 * after that read leaves the expense stamped with the job the estimate has
 * already left. That is the exact split-job row this whole migration exists to
 * create correctly, manufactured by the migration itself.
 *
 * The locked CTE is the fix, and it is ONE statement rather than a lock query
 * followed by an update — the rows the UPDATE writes from are, by construction,
 * exactly the rows the CTE locked, with no window in between for a phantom to
 * arrive. `FOR SHARE` (not `FOR UPDATE`): the backfill does not modify the
 * estimates, it only needs them to hold still, and a share lock leaves other
 * readers — including a concurrent expense booking — free.
 *
 * `ORDER BY est.id` keeps the acquisition order the same ascending-id rule
 * `lockMoneyParentsMany` uses in the app, so this script and a live transaction
 * cannot deadlock against each other on the Estimate table.
 */
/**
 * THE JOBS FIRST, AND IT IS NOT OPTIONAL (Codex round 41, item 1).
 *
 * The backfill below locks Estimate rows and then UPDATEs `Expense.projectId`.
 * That UPDATE is not the estimate-only statement it looks like: the foreign key
 * added by this same script makes Postgres take `FOR KEY SHARE` on every
 * referenced `Project` row to enforce it. So the statement's real acquisition
 * order is Estimate -> Project — the exact inversion rounds 37 to 40 removed
 * from the application — and a job editor holding its `Project` row FOR UPDATE
 * while reaching for an estimate closes the cycle. Postgres breaks it with
 * 40P01, and because this whole script runs inside ONE transaction, the victim
 * is not one row: it is the entire DDL run, rolled back mid-migration.
 *
 * A separate STATEMENT, not another CTE. CTE evaluation order is not
 * guaranteed — an unreferenced or laterally-independent locking CTE may be
 * evaluated in either order — so "lock the projects in an earlier CTE" would
 * be a hope rather than a rule. Two statements in one transaction have a
 * defined order, and the locks the first one takes are held for the second.
 *
 * `ORDER BY id` for the same reason the estimate scan has it: ascending ids
 * within a table is the rule `lockMoneyParentsMany` and
 * `lockAttributionParents` both follow, so two holders acquire the same rows
 * the same way.
 *
 * NOT BATCHED, deliberately. Batching is the usual answer to "keep the lock set
 * small", and here it would buy nothing: the script is one transaction by
 * design (round 13, item 6 — either the whole shape lands or none of it does),
 * so every lock is held until the final COMMIT whatever size the batches are.
 * Splitting the statement would add a loop and change nothing about the lock
 * set. Recorded here so the next reader does not re-derive it.
 */
export const PROJECT_ID_BACKFILL_LOCK_PROJECTS =
    `SELECT p.id
       FROM "Project" p
      WHERE p.id IN (
            SELECT DISTINCT est."projectId"
              FROM "Estimate" est
             WHERE est."projectId" IS NOT NULL
               AND EXISTS (
                     SELECT 1 FROM "Expense" e
                      WHERE e."estimateId" = est.id AND e."projectId" IS NULL
                   )
          )
      ORDER BY p.id
        FOR SHARE`;

export const PROJECT_ID_BACKFILL =
    `WITH locked AS (
       SELECT est.id, est."projectId"
         FROM "Estimate" est
        WHERE est."projectId" IS NOT NULL
          AND EXISTS (
                SELECT 1 FROM "Expense" e
                 WHERE e."estimateId" = est.id AND e."projectId" IS NULL
              )
        ORDER BY est.id
          FOR SHARE
     )
     UPDATE "Expense" e SET "projectId" = locked."projectId"
       FROM locked
      WHERE e."estimateId" = locked.id AND e."projectId" IS NULL`;

/**
 * FILL THE SOURCE FILE ID FROM THE URL WE ALREADY STORED.
 *
 * -- POST-DEPLOY: re-run this section
 *
 * Only where the Drive id is UNAMBIGUOUS. Both url shapes the app has ever
 * written carry it (`/d/<id>/view` from the ingest's own default, `id=<id>`
 * from a Drive share link); anything else is left NULL, because a guessed id
 * would dedupe two unrelated documents against each other — the exact failure
 * the substring match caused.
 *
 * WHAT A LEFT-NULL ROW COSTS, said plainly: a legacy receipt whose stored url
 * carries no recoverable id stays invisible to the new equality dedupe, so a
 * re-delivery of THAT file would book it again. That is not a regression —
 * `receiptUrl contains fileId` did not match those rows either, for exactly the
 * same reason — and it is bounded: every row the new ingest writes carries the
 * id, so the set can only shrink.
 *
 * Idempotent by predicate (`"sourceFileId" IS NULL`), so it is safe in the
 * --post-deploy pass. It has the SAME live-write gap the projectId fill has,
 * and for the same reason: this script runs before the new build deploys, so
 * the old build keeps writing receipt Expenses with a `receiptUrl` and no
 * `sourceFileId` after this statement has already passed over the table. A
 * row left in that shape is invisible to the new equality dedupe, so a
 * re-delivery of that file would book it a second time — which is why this is
 * part of the post-deploy set rather than a one-shot.
 *
 * It writes no `sourceGroupIndex`: nothing here can say which group of a
 * document an old row was, and inventing one would put a false identity under
 * a unique index. NULLs are distinct in a btree unique index, so those rows
 * neither collide nor gain its protection.
 */
export const SOURCE_FILE_ID_BACKFILL =
    `UPDATE "Expense"
   SET "sourceFileId" = COALESCE(
         substring("receiptUrl" from '/d/([A-Za-z0-9_-]+)'),
         substring("receiptUrl" from '[?&]id=([A-Za-z0-9_-]+)')
       )
 WHERE "sourceFileId" IS NULL
   AND COALESCE(
         substring("receiptUrl" from '/d/([A-Za-z0-9_-]+)'),
         substring("receiptUrl" from '[?&]id=([A-Za-z0-9_-]+)')
       ) IS NOT NULL`;

/**
 * The pair, checked in BOTH directions after the run.
 *
 * The original verification asked only "is any expense still NULL against an
 * estimate that knows a project?". That cannot see the failure this script can
 * actually cause, or that a live estimate move causes: an expense with a
 * NON-null projectId that DISAGREES with its estimate's. A row on two jobs at
 * once passes a null check perfectly.
 *
 * WHY ZERO IS THE RIGHT EXPECTATION AT BOTH INTENDED RUN TIMES, and when it
 * would not be. `Expense.projectId` is created BY this script, so on the
 * pre-deploy run every non-null value in the column was written by the backfill
 * itself and therefore equals its estimate's. On the --post-deploy run the new
 * build has been live for minutes and every writer in it takes the pair from
 * one locked read (`lockEstimateAttribution`), so it still equals.
 *
 * Later than that, a NON-zero count is not necessarily a defect: a bookkeeper
 * re-attributing an expense to another job through the expense PATCH is a
 * supported, deliberate operation, and it produces exactly this shape (see the
 * "RE-ATTRIBUTED expense" note in src/app/api/expenses/[id]/route.ts). This
 * check cannot tell that apart from an estimate moved out from under its
 * expenses, so it reports the count either way and refuses to claim success —
 * read the rows before overriding it. Re-running this script months later is
 * not a supported operation, and a wedged re-run is the correct outcome for an
 * operation nobody planned.
 */
export const MISMATCHED_PAIRS_QUERY =
    `SELECT COUNT(*)::int AS n FROM "Expense" e
       JOIN "Estimate" est ON est.id = e."estimateId"
      WHERE e."projectId" IS NOT NULL
        AND est."projectId" IS NOT NULL
        AND e."projectId" <> est."projectId"`;


/**
 * THE ROLLOUT WINDOW CAN SPLIT A ROW ACROSS TWO JOBS (round 36, item 1).
 *
 * The sequence this migration runs in has a gap neither backfill can close on
 * its own, because the damage happens BETWEEN them:
 *
 *   1. this script runs (it has to — the new build selects these columns);
 *      PROJECT_ID_BACKFILL stamps `Expense.projectId` from the estimate.
 *   2. the OLD build is still serving. Its QBO sync writes the whole expense
 *      record on every changed purchase (`transaction.expense.update({ data:
 *      write })`), and `write` carries `estimateId` — but its Prisma client
 *      predates `projectId`, so it cannot carry that. It re-points the row at
 *      another job's estimate and leaves the projectId this script just wrote.
 *   3. the row is now `projectId = job A, estimateId = job B`. Every reader
 *      that trusts one of the two reports the other job's money.
 *
 * The --post-deploy pass cannot repair this by re-running the fill: that fill
 * matches `"projectId" IS NULL`, and these rows HAVE a projectId. It is a
 * non-null WRONG answer, the one shape a null-guarded backfill is blind to.
 *
 * So the window is closed rather than cleaned up afterwards. This trigger goes
 * in BEFORE the backfill below, and from that moment any writer that moves
 * `estimateId` while saying nothing about `projectId` — precisely the old
 * build, and precisely nothing in the new one — has the pair re-derived for
 * it inside the same statement.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It fires only when the UPDATE leaves
 * `projectId` untouched (`NEW IS NOT DISTINCT FROM OLD`). Every writer in the
 * new build sets both columns from one locked read, and this must never
 * second-guess them: a bookkeeper deliberately re-attributing an expense to
 * another job keeps the estimate of the job it left, on purpose (see the
 * "RE-ATTRIBUTED expense" note in src/app/api/expenses/[id]/route.ts), and a
 * trigger that "corrected" that would silently revert the human.
 *
 * It also refuses to null a projectId out: if the incoming estimate belongs to
 * no job, the row keeps the attribution it had. Losing attribution is not a
 * better outcome than holding a stale one.
 *
 * Idempotent by DROP-then-CREATE: Postgres has no CREATE TRIGGER IF NOT
 * EXISTS, and a re-run must not fail on the trigger it created last time.
 */
export const SPLIT_JOB_GUARD_SQL = [
    `CREATE OR REPLACE FUNCTION probuild_expense_estimate_pair_guard()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $guard$
     DECLARE
         est_project TEXT;
     BEGIN
         IF NEW."estimateId" IS DISTINCT FROM OLD."estimateId"
            AND NEW."projectId" IS NOT DISTINCT FROM OLD."projectId"
            AND OLD."projectId" IS NOT NULL
            AND NEW."estimateId" IS NOT NULL
         THEN
             -- LOCKED, NOT A PLAIN READ (Codex round 15, item 3). A bare
             -- SELECT is ordinary MVCC: it can read the estimate's project as
             -- it stood before an in-flight estimate move commits, stamp that
             -- stale value onto this row, and let the move commit right after
             -- -- landing a split attribution the guard exists to prevent.
             -- FOR KEY SHARE blocks behind a mover holding FOR UPDATE /
             -- NO KEY UPDATE on the same estimate row (the real
             -- estimate-move path already locks Estimate before touching any
             -- expense, so this is parent before child) while leaving every
             -- other reader free.
             SELECT est."projectId" INTO est_project
               FROM "Estimate" est
              WHERE est.id = NEW."estimateId"
                FOR KEY SHARE;
             IF est_project IS NOT NULL THEN
                 NEW."projectId" := est_project;
             END IF;
         END IF;
         RETURN NEW;
     END;
     $guard$`,
    `DROP TRIGGER IF EXISTS probuild_expense_estimate_pair_guard ON "Expense"`,
    `CREATE TRIGGER probuild_expense_estimate_pair_guard
     BEFORE UPDATE OF "estimateId" ON "Expense"
     FOR EACH ROW
     EXECUTE FUNCTION probuild_expense_estimate_pair_guard()`,
];

/**
 * Dropped in the --post-deploy pass, once the old instances have drained and
 * every writer of `estimateId` is one that owns `projectId` too.
 *
 * It is compatibility scaffolding for ONE deploy, not a permanent invariant.
 * Left in place it would quietly overrule a future writer that legitimately
 * moves an estimate without restating the job — the same class of surprise it
 * exists to prevent, pointing the other way.
 */
export const SPLIT_JOB_GUARD_DROP_SQL = [
    `DROP TRIGGER IF EXISTS probuild_expense_estimate_pair_guard ON "Expense"`,
    `DROP FUNCTION IF EXISTS probuild_expense_estimate_pair_guard()`,
];

/**
 * THE SAME ROLLOUT WINDOW, POINTED AT THE TAX FIGURES (round 37, item 2).
 *
 * The guard above protects the attribution pair. It protects nothing else, and
 * the old build can damage more than the pair on its way past:
 *
 *   1. this script adds `taxAmount`, `taxDeductibleBase`, `needsTaxReview` and
 *      the two CHECK constraints that keep them coherent with `amount`.
 *   2. the OLD build is still serving. Its QBO sync writes the whole expense
 *      record on every changed purchase, and `amount` is part of that record —
 *      but its Prisma client predates every tax column, so it cannot restate
 *      one and has never heard of `needsTaxReview`.
 *   3. it re-syncs a $412.10 receipt as $498.30 and the row keeps a recorded
 *      $34.06 of tax, an `installedAtCustomer` yes and a hand-allocated
 *      deduction base that all describe a purchase that no longer exists. The
 *      new build would have flagged every one of those for review
 *      (`planExpenseUpdate`, src/lib/qbo-expense-sync.ts). The old one says
 *      nothing, and the tax report reads a stale figure as certified.
 *   4. and if the new gross is SMALLER than the recorded tax, or leaves the
 *      allocation above `amount - taxAmount`, the row violates a CHECK this
 *      script just added and the old sync simply fails — repeatedly, on a
 *      Purchase that already exists in QuickBooks.
 *
 * So the same window gets the same treatment: a BEFORE UPDATE OF "amount"
 * trigger, created in the pre-deploy step and dropped by --post-deploy, that
 * re-applies the new build's own rules to any statement that moves the gross.
 *
 * IT IS A TRANSCRIPTION OF `planExpenseUpdate`, NOT A NEW POLICY — the three
 * branches below are its `taxCannotFitGross`, its `baseCannotFit` and its
 * `classified && amountMoved`, in the same order, with the same outcomes.
 * That is what makes it safe to leave firing while the NEW build is also
 * serving (a deploy window has both): the new build has already computed these
 * values before its UPDATE reaches here, so the trigger recomputes the same
 * answer and changes nothing. A discriminator on "did the writer restate the
 * tax columns?" was the alternative and it is worse — a new-build PUT that
 * moves the amount without touching tax is legitimate and would have been
 * clobbered by it.
 *
 * IT NEVER INVENTS A NUMBER. Where a figure no longer fits it is CLEARED and
 * the row is flagged for review, along with the provenance that described it —
 * a surviving "manual" beside a cleared figure would keep claiming a person
 * answered a question about money that is gone. Where the figures still fit,
 * nothing is cleared and only the review flag is raised: the classification
 * may well still be right, and the report reads the flag as "not until a
 * person looks".
 *
 * `taxAtSource` is re-derived last, unconditionally, because it is not an
 * independent answer — `Expense_taxAtSource_check` defines it as
 * `"taxAmount" IS NOT NULL AND "taxAmount" <> 0`, so recomputing it can only
 * ever avoid a violation.
 *
 * Idempotent by DROP-then-CREATE, same as the guard above: Postgres has no
 * CREATE TRIGGER IF NOT EXISTS and a re-run must not fail on its own trigger.
 */
export const AMOUNT_TAX_GUARD_SQL = [
    // THE STATEMENT'S OWN VOICE (round 41, item 3).
    //
    // `BEFORE UPDATE OF "needsTaxReview"` fires ONLY when that column is in the
    // UPDATE's SET list -- which the old build can never do, because its Prisma
    // client predates the column. That is the signal the guard needs to tell a
    // new build's deliberate decision (an acknowledged tax review) from the old
    // build's silence, and there is no other way to ask it: once a BEFORE
    // trigger has NEW in hand, a column that was set to its existing value is
    // indistinguishable from one that was never mentioned.
    //
    // It records the row AND the statement, so the exemption cannot leak: a
    // second statement in the same transaction has a different
    // `statement_timestamp()` and is judged on its own. `set_config(..., true)`
    // is transaction-local, so nothing survives the COMMIT either.
    //
    // Named to sort BEFORE the guard: Postgres fires BEFORE ROW triggers in
    // name order, and this has to have run before the guard reads it.
    `CREATE OR REPLACE FUNCTION probuild_expense_amount_tax_ack()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $ack$
     BEGIN
         PERFORM set_config(
             'probuild.tax_flag_stated',
             NEW."id" || '@' || statement_timestamp()::text,
             true
         );
         RETURN NEW;
     END;
     $ack$`,
    `DROP TRIGGER IF EXISTS probuild_expense_amount_tax_ack ON "Expense"`,
    `CREATE TRIGGER probuild_expense_amount_tax_ack
     BEFORE UPDATE OF "needsTaxReview" ON "Expense"
     FOR EACH ROW
     EXECUTE FUNCTION probuild_expense_amount_tax_ack()`,
    `CREATE OR REPLACE FUNCTION probuild_expense_amount_tax_guard()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $guard$
     DECLARE
         base_ceiling NUMERIC;
         was_classified BOOLEAN;
     BEGIN
         IF NEW."amount" IS NOT DISTINCT FROM OLD."amount" OR NEW."amount" IS NULL THEN
             RETURN NEW;
         END IF;

         -- Did this row carry a tax answer BEFORE the write? Read off OLD, the
         -- same way planExpenseUpdate reads it off the stored row.
         --
         -- The columns, and how each KIND is read, are
         -- TAX_CLASSIFICATION_FIGURE_COLUMNS and
         -- TAX_CLASSIFICATION_SOURCE_COLUMNS in
         -- src/lib/expense-attribution.ts -- the ONE definition the QBO sync
         -- and the expense PUT handler both read too, and the shape of this
         -- expression is pinned against those constants in
         -- tests/apply-expense-attribution.test.ts. A FIGURE counts whenever
         -- it is present at all; a PROVENANCE counts only when it is a HUMAN
         -- one, because a machine guess with no surviving figure has nothing
         -- left to invalidate. Deciding that differently in each writer was
         -- how the three drifted apart in the first place.
         was_classified :=
             OLD."taxAmount" IS NOT NULL
             OR OLD."taxDeductibleBase" IS NOT NULL
             OR OLD."installedAtCustomer" IS NOT NULL
             OR COALESCE(OLD."taxSource", '') IN ('manual', 'manual-none')
             OR COALESCE(OLD."taxDeductibleBaseSource", '') IN ('manual', 'manual-none');

         -- 1. The recorded tax cannot fit the new gross: it points the other
         --    way, or it is bigger. Everything the row claimed about tax goes,
         --    provenance included.
         IF NEW."taxAmount" IS NOT NULL
            AND NEW."taxAmount" <> 0
            AND (sign(NEW."taxAmount") <> sign(NEW."amount")
                 OR abs(NEW."taxAmount") > abs(NEW."amount"))
         THEN
             NEW."taxAmount" := NULL;
             NEW."installedAtCustomer" := NULL;
             NEW."taxDeductibleBase" := NULL;
             NEW."taxDeductibleBaseSource" := NULL;
             NEW."taxSource" := NULL;
             NEW."needsTaxReview" := true;
         -- 2. The tax still fits, but the hand allocation no longer does.
         --    Clearing it silently would leave a row that still reads as a
         --    valid deduction of the WHOLE pre-tax total, so it is flagged.
         ELSIF NEW."taxDeductibleBase" IS NOT NULL AND NEW."taxDeductibleBase" <> 0 THEN
             base_ceiling := NEW."amount" - COALESCE(NEW."taxAmount", 0);
             IF sign(NEW."taxDeductibleBase") <> sign(base_ceiling)
                OR abs(NEW."taxDeductibleBase") > abs(base_ceiling)
             THEN
                 NEW."taxDeductibleBase" := NULL;
                 NEW."taxDeductibleBaseSource" := NULL;
                 NEW."needsTaxReview" := true;
             END IF;
         END IF;

         -- 3. ANY movement in the gross re-opens a classification that survived
         --    the two branches above. The numbers still satisfy every CHECK,
         --    which is exactly why nothing else would ever ask.
         --
         --    UNLESS THE STATEMENT SPOKE FOR ITSELF (round 41, item 3). This
         --    used to be unconditional, and it defeated a valid
         --    taxReviewAck: the PUT decided the row was certified, omitted
         --    the flag, and this line put it straight back -- so for the whole
         --    drain window an acknowledged edit was still excluded from the
         --    filing and queued for a review that had already happened.
         --
         --    The exemption is "this UPDATE named needsTaxReview in its SET
         --    list", which is EXACTLY what the old build can never do: its
         --    Prisma client predates the column. The companion trigger
         --    probuild_expense_amount_tax_ack is declared BEFORE UPDATE OF
         --    "needsTaxReview", so it fires only for a statement that names it,
         --    and it fires FIRST because BEFORE ROW triggers run in name order
         --    and 'ack' sorts before 'guard'. The marker carries the row id AND
         --    statement_timestamp(), so it can only ever exempt the row and the
         --    statement that set it -- a later statement in the same
         --    transaction has a different timestamp and is judged on its own.
         IF was_classified
            AND COALESCE(current_setting('probuild.tax_flag_stated', true), '')
                IS DISTINCT FROM NEW."id" || '@' || statement_timestamp()::text
         THEN
             NEW."needsTaxReview" := true;
         END IF;

         -- ...and the derived flag agrees with the figure, whatever happened.
         NEW."taxAtSource" := (NEW."taxAmount" IS NOT NULL AND NEW."taxAmount" <> 0);
         RETURN NEW;
     END;
     $guard$`,
    `DROP TRIGGER IF EXISTS probuild_expense_amount_tax_guard ON "Expense"`,
    `CREATE TRIGGER probuild_expense_amount_tax_guard
     BEFORE UPDATE OF "amount" ON "Expense"
     FOR EACH ROW
     EXECUTE FUNCTION probuild_expense_amount_tax_guard()`,
];

/**
 * Dropped by --post-deploy for the same reason the split-job guard is: it is
 * scaffolding for one deploy. The new build enforces these rules itself, in
 * `planExpenseUpdate` and in the expense PUT/PATCH handlers, where it can also
 * tell a bookkeeper what happened. Left standing, the trigger would silently
 * re-open a review on every amount edit a human makes deliberately.
 */
export const AMOUNT_TAX_GUARD_DROP_SQL = [
    `DROP TRIGGER IF EXISTS probuild_expense_amount_tax_guard ON "Expense"`,
    `DROP FUNCTION IF EXISTS probuild_expense_amount_tax_guard()`,
    // ...and its companion. The ack trigger is inert on its own -- it only
    // writes a transaction-local setting -- but leaving it behind would mean
    // every UPDATE naming needsTaxReview paid for a set_config forever.
    `DROP TRIGGER IF EXISTS probuild_expense_amount_tax_ack ON "Expense"`,
    `DROP FUNCTION IF EXISTS probuild_expense_amount_tax_ack()`,
];

/**
 * The compatibility triggers, by name, and which run they belong to.
 *
 * The main (pre-deploy) run must END with both of them present — that is the
 * state the drain window needs — and the --post-deploy run must end with
 * neither. Verified from `pg_trigger` rather than assumed, because both are
 * created by `CREATE OR REPLACE` + `DROP`/`CREATE` pairs whose failure mode is
 * silence.
 */
export const COMPATIBILITY_TRIGGERS = [
    "probuild_expense_estimate_pair_guard",
    "probuild_expense_amount_tax_guard",
];

/**
 * The repair, for a database where the guard was NOT in place — an earlier run
 * of this script, or a deploy that went out before this fix existed.
 *
 * IT IS OPT-IN (`--repair-split-jobs`), AND THAT IS NOT TIMIDITY. Once the new
 * build is live, `projectId <> estimate.projectId` has TWO causes that are
 * indistinguishable in the row:
 *
 *   * the rollout window above — the estimate is right, the projectId is a
 *     stale leftover, and re-deriving from the estimate is the fix; and
 *   * a bookkeeper re-attributing an expense to another job — the projectId IS
 *     the human's answer, the estimate belongs to the job the row LEFT, and
 *     re-deriving from the estimate silently reverts them.
 *
 * Nothing in the schema records which happened. Running this by default would
 * mean choosing to overwrite human decisions whenever the guess is wrong, on a
 * money-attribution column, leaving no trace that it happened. So the verifier
 * REPORTS the count and fails (MISMATCHED_PAIRS_QUERY), a person reads the
 * rows, and this runs only once they have concluded the estimate is right.
 *
 * Scoped to `qbPurchaseId IS NOT NULL` because the old QBO sync is the only
 * writer that rewrites `estimateId` without `projectId`: a row that never came
 * from QuickBooks cannot have been damaged this way, so it is never a
 * candidate however the flag is passed.
 *
 * Same locked-CTE shape and same `ORDER BY est.id` as PROJECT_ID_BACKFILL, for
 * the same two reasons — the estimate must hold still between the read and the
 * write, and the acquisition order must match `lockMoneyParentsMany`.
 */

/**
 * THE PROJECTS, LOCKED FIRST (Codex round 15, item 2 — the same fix round 41
 * item 1 gave PROJECT_ID_BACKFILL, missed here). Locking the Estimate rows and
 * then UPDATE-ing `Expense.projectId` is not an Estimate-only statement: the
 * foreign key this script adds makes Postgres take `FOR KEY SHARE` on every
 * referenced Project row to enforce it, so SPLIT_JOB_REPAIR's real acquisition
 * order is Estimate -> Project — the exact inversion the rest of this script
 * exists to remove. A job editor holding its Project row FOR UPDATE while
 * reaching for an estimate closes the cycle.
 *
 * A separate STATEMENT, not another CTE, for the same reason
 * PROJECT_ID_BACKFILL_LOCK_PROJECTS is: CTE evaluation order is not
 * guaranteed. `ORDER BY id`, ascending, matches `lockMoneyParentsMany` and
 * every other locking statement in this file.
 *
 * Scoped to the SAME candidate set SPLIT_JOB_REPAIR reads from — the target
 * projects of the QBO-synced rows whose pair disagrees — so it locks no more
 * than the repair itself will touch.
 */
export const SPLIT_JOB_REPAIR_LOCK_PROJECTS =
    `SELECT p.id
       FROM "Project" p
      WHERE p.id IN (
            SELECT DISTINCT est."projectId"
              FROM "Estimate" est
             WHERE est."projectId" IS NOT NULL
               AND EXISTS (
                     SELECT 1 FROM "Expense" e
                      WHERE e."estimateId" = est.id
                        AND e."qbPurchaseId" IS NOT NULL
                        AND e."projectId" IS NOT NULL
                        AND e."projectId" <> est."projectId"
                   )
          )
      ORDER BY p.id
        FOR SHARE`;

export const SPLIT_JOB_REPAIR =
    `WITH locked AS (
       SELECT est.id, est."projectId"
         FROM "Estimate" est
        WHERE est."projectId" IS NOT NULL
          AND EXISTS (
                SELECT 1 FROM "Expense" e
                 WHERE e."estimateId" = est.id
                   AND e."qbPurchaseId" IS NOT NULL
                   AND e."projectId" IS NOT NULL
                   AND e."projectId" <> est."projectId"
              )
        ORDER BY est.id
          FOR SHARE
     )
     UPDATE "Expense" e
        SET "projectId" = locked."projectId",
            "attributionAnchoredAt" = now()
       FROM locked
      WHERE e."estimateId" = locked.id
        AND e."qbPurchaseId" IS NOT NULL
        AND e."projectId" IS NOT NULL
        AND e."projectId" <> locked."projectId"`;


/**
 * PHASE A IS A SEQUENCE OF SHORT TRANSACTIONS, NOT ONE (Codex round 15, item
 * 1 — replacing round 44's "every DDL statement in one transaction, no
 * Project/Estimate lock at all").
 *
 * Round 44's claim was false. `ALTER TABLE "Expense" ADD CONSTRAINT ...
 * FOREIGN KEY ... REFERENCES "Project"` takes SHARE ROW EXCLUSIVE on the
 * REFERENCED table too — Postgres needs it to install the FK's enforcement
 * trigger, and it takes it even when the constraint is `NOT VALID`. Bundled
 * into round 44's single phase-A transaction, that meant: hold ACCESS
 * EXCLUSIVE on Expense (from the very first `ALTER TABLE`, held to COMMIT),
 * and only near the end of the SAME transaction reach for Project's and
 * Estimate's table lock. A concurrent parent-first writer — anything holding
 * a Project or Estimate row and then writing Expense, which is every writer
 * `lockAttributionParents` protects — is the other half of a cycle, and
 * Postgres breaks a cycle with 40P01: the victim is chosen by the server, so
 * half the time it is a person's save rather than this script.
 *
 * There is also a SECOND, subtler bug in the naive fix of "just add an
 * explicit `LOCK TABLE`": `ALTER TABLE "Expense" ADD CONSTRAINT ...` opens
 * and locks the table NAMED IN THE ALTER TABLE CLAUSE (Expense, ACCESS
 * EXCLUSIVE) BEFORE it opens the REFERENCED table (Project/Estimate, SHARE
 * ROW EXCLUSIVE) to install the FK trigger — the wrong order, Expense before
 * its parent, baked into a single ALTER TABLE statement no matter how it is
 * phrased. `LOCK TABLE "Project" IN SHARE ROW EXCLUSIVE MODE` as its OWN,
 * PRECEDING statement fixes that: Postgres locks are cumulative within a
 * transaction and never downgraded, so once the LOCK TABLE statement holds
 * Project, the ADD CONSTRAINT statement's own (redundant) request for the
 * same lock is a no-op — the OBSERVABLE acquisition order, the one every
 * other waiter sees, becomes Project-then-Expense. That is `lockAttributionParents`'s
 * own order, said in DDL.
 *
 * So the fix is not "wrap it all in fewer transactions" but the opposite:
 * split phase A into short transactions, each doing ONE kind of thing, so
 * that by the time any transaction reaches for a Project or Estimate lock it
 * is not ALSO holding a lock on Expense from an earlier, unrelated statement.
 * Every step below is additive and idempotent, so a crash between any two of
 * them is safe to re-run from the top — the verification pass at the end
 * checks the END STATE, never that a particular transaction committed:
 *
 *   (a) each foreign key is added `NOT VALID` in its own short transaction
 *       that FIRST takes the explicit parent lock and only then alters
 *       Expense (PROJECT_FK_LOCK_STATEMENTS / ESTIMATE_FK_LOCK_STATEMENTS),
 *       and is VALIDATED in a separate, later transaction
 *       (PROJECT_FK_VALIDATE_STATEMENTS / ESTIMATE_FK_VALIDATE_STATEMENTS) —
 *       `VALIDATE CONSTRAINT` takes only `SHARE UPDATE EXCLUSIVE` on Expense
 *       and nothing table-level on the parent, so splitting it out of the
 *       lock-holding transaction shrinks the window the parent lock is held
 *       for to "however long the NOT VALID add itself takes", which is
 *       metadata-only;
 *   (b) the three indexes run as standalone `CREATE INDEX CONCURRENTLY IF NOT
 *       EXISTS` statements, OUTSIDE any transaction (`prisma.$executeRawUnsafe`
 *       directly, never inside `prisma.$transaction`) — CONCURRENTLY refuses
 *       to run inside a transaction block at all, and buys the extra benefit
 *       that an index build no longer blocks writers on Expense either
 *       (INDEX_STATEMENTS, rendered through `toConcurrentIndexSql`);
 *   (c) the three normalising UPDATEs run in their own short transaction,
 *       after the columns they read exist (NORMALIZE_STATEMENTS);
 *   (d) every `ADD COLUMN` / `ALTER COLUMN` runs in its own short transaction,
 *       touching only Expense (COLUMN_STATEMENTS).
 *
 * `PHASE_A_STEPS` is the one list that says what actually runs and how — main()
 * and the two-connection DB test in tests/attribution-lock-order-db.test.ts
 * both execute it directly, so the two can never describe different runs.
 * `DDL_STATEMENTS` (kept for every existing consumer: the migration-parity
 * tests, expectedColumns, the source tripwires) is its flat concatenation —
 * one definition, so the flat and the structured view cannot drift.
 */
export const COLUMN_STATEMENTS = [
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "projectId" TEXT`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(65,30)`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "costCodeSource" TEXT`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "costCodeConfidence" DECIMAL(65,30)`,
    // THE SOURCE DOCUMENT'S OWN IDENTITY. The ingest stored a caller-supplied
    // url and deduped with `receiptUrl contains fileId`, so a payload whose
    // `fileUrl` omitted the id deduped against nothing and re-booked the
    // receipt on every delivery — and the substring match conflated a file id
    // that is a prefix of another. Compared by equality now.
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "sourceFileId" TEXT`,
    // Which group of that document this row is: one receipt becomes one
    // Expense per category group, so the file id alone is not a row identity.
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "sourceGroupIndex" INTEGER`,
    // (The fill for the rows that predate this column is PHASE B -- see
    // SOURCE_FILE_ID_BACKFILL and the two-transaction note above.)
    // Mixed receipts: the portion actually resold, when it is less than the
    // whole pre-tax total. NULL means "all of it".
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxDeductibleBase" DECIMAL(65,30)`,
    // Set when a re-sync invalidated a human tax classification.
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "needsTaxReview" BOOLEAN NOT NULL DEFAULT false`,
    // WHO decided the tax fields: "ocr" or "manual". A manual decision
    // includes "there is no tax here", which is a NULL taxAmount and so cannot
    // be told from "nobody has looked" without this column. Booking never
    // overwrites "manual".
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxSource" TEXT`,
    // WHO decided the deduction BASE — a different question from who decided
    // the tax, and not always the same answer. A base-only PATCH deliberately
    // leaves `taxSource` alone so a later OCR read may still fill `taxAmount`;
    // booking then stamps `taxSource = 'ocr'` for the tax it filled, and while
    // one column governed both figures that made the row claim a machine had
    // decided a base a person had typed.
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxDeductibleBaseSource" TEXT`,
    // THE CONSERVATIVE READING OF THE ROWS THAT PREDATE THE COLUMN. Before the
    // split, a human-entered base could only exist on a row a human had also
    // spoken to about tax, so a non-NULL base beside a human `taxSource` was
    // necessarily a human base — and saying so is what stops the next booking
    // pass being able to claim it. Rows with an OCR or absent `taxSource` stay
    // NULL: nobody wrote a base on them, and inventing a provenance is how a
    // guess becomes a fact. Idempotent by the IS NULL predicate.
    // The re-anchor marker (see reanchorSql): a predicate on the time-of-day
    // cannot tell an already-re-anchored row from one legitimately written at
    // local midnight, so the fact is recorded on the row.
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "attributionAnchoredAt" TIMESTAMP(3)`,

    // A ROW VERSION FOR THE TAX CORRECTION PATH (Codex round 9, item 2;
    // ordering fixed in round 13, item 6).
    //
    // THE DEFAULT ARRIVES WITH THE COLUMN, IN THE SAME STATEMENT.
    //
    // The previous order added the column bare, backfilled, and only THEN set
    // the default. That left a window in which the column existed, was
    // nullable, and had no default — and this script runs against production
    // BEFORE the build that knows about the column, so the OLD app is inserting
    // Expenses through that window with no value for it. Every such row lands
    // NULL after the backfill has already passed, and `SET NOT NULL` then
    // aborts. Adding the column WITH the default means no insert can ever
    // produce a NULL, so the last step cannot lose that race.
    //
    // The repair for a database left in the old half-applied shape (column
    // present, no default, NULLs from that window) is NORMALIZE_STATEMENTS
    // below — it has to run in a LATER transaction than this one, because it
    // depends on the column this statement adds.
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) DEFAULT now()`,
    `ALTER TABLE "Expense" ALTER COLUMN "updatedAt" SET DEFAULT now()`,

    // SET NULL, not Cascade: `estimateId` already owns this row's lifecycle. A
    // project delete must not silently destroy spend history that the estimate
    // still holds. AN ESTIMATE MAY NOT DELETE SPEND (round 42, item 4b): this
    // column has to become nullable before the FK below can be SET NULL, or
    // the constraint is unenforceable and Postgres refuses it. `DROP NOT
    // NULL` is idempotent and Expense-only, so it belongs with the rest of
    // the column shape rather than with the FK step that reaches for Estimate.
    `ALTER TABLE "Expense" ALTER COLUMN "estimateId" DROP NOT NULL`,
];

/**
 * (c) THE NORMALISING UPDATEs, IN THEIR OWN SHORT TRANSACTION, AFTER THE
 * COLUMNS THEY READ (Codex round 15, item 1(c)).
 *
 * All three are Expense-only — no table outside Expense is named — and each
 * is idempotent by predicate, so this transaction can run any number of times
 * with the second run touching 0 rows.
 */
export const NORMALIZE_STATEMENTS = [
    // THE CONSERVATIVE READING OF THE ROWS THAT PREDATE taxDeductibleBaseSource.
    // Before the split, a human-entered base could only exist on a row a human
    // had also spoken to about tax, so a non-NULL base beside a human
    // `taxSource` was necessarily a human base — and saying so is what stops
    // the next booking pass being able to claim it. Rows with an OCR or absent
    // `taxSource` stay NULL: nobody wrote a base on them, and inventing a
    // provenance is how a guess becomes a fact.
    `UPDATE "Expense"
   SET "taxDeductibleBaseSource" = 'manual'
 WHERE "taxDeductibleBaseSource" IS NULL
   AND "taxDeductibleBase" IS NOT NULL
   AND "taxSource" IN ('manual', 'manual-none')`,
    // REPAIR for a database left in the OLD half-applied `updatedAt` shape
    // (column present, no default, NULLs from that window); a no-op on a
    // clean run. Must precede SET NOT NULL below, in this same transaction.
    `UPDATE "Expense" SET "updatedAt" = COALESCE("createdAt", now()) WHERE "updatedAt" IS NULL`,
    `ALTER TABLE "Expense" ALTER COLUMN "updatedAt" SET NOT NULL`,
    // `taxAtSource` IS DERIVED, AND THE DATABASE SAYS SO (round 20, item 1).
    // Normalised here, BEFORE CHECK_STATEMENTS adds the CHECK that depends on
    // it — a CHECK cannot be added to a table that already violates it.
    `UPDATE "Expense"
   SET "taxAtSource" = ("taxAmount" IS NOT NULL AND "taxAmount" <> 0)
 WHERE "taxAtSource" <> ("taxAmount" IS NOT NULL AND "taxAmount" <> 0)`,
];

/**
 * The three CHECK constraints, Expense-only, in their own short transaction
 * after NORMALIZE_STATEMENTS has committed the data they depend on.
 */
export const CHECK_STATEMENTS = [
    // TAX POINTS THE SAME WAY AS THE MONEY, AND IS NEVER BIGGER THAN IT
    // (round 6 item 2; signed amounts, round 16 item 3). The deduction base is
    // `amount - taxAmount`, so a tax above the gross makes it NEGATIVE and the
    // report subtracts money from the filing; the taxDeductibleBase CHECK does
    // not cover that, since a NULL allocation has nothing to violate.
    //
    // `amount` is SIGNED — a refund or vendor credit is a negative expense and
    // its tax comes back with it. The first version refused every such row.
    //
    // DROPPED AND RE-ADDED BY NAME rather than skipped when present, so a
    // database already carrying the old definition is corrected. Both
    // statements are re-runnable.
    `ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_taxAmount_check"`,
    `ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxAmount_check"
  CHECK ("taxAmount" IS NULL
         OR "taxAmount" = 0
         OR (sign("taxAmount") = sign("amount") AND abs("taxAmount") <= abs("amount")))`,

    `ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_taxAtSource_check"`,
    `ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxAtSource_check"
  CHECK ("taxAtSource" = ("taxAmount" IS NOT NULL AND "taxAmount" <> 0))`,

    // THE DEDUCTION INVARIANT, IN THE DATABASE (Codex round 5, item 4).
    // Enforced only by the API handler before this: read the amount, validate,
    // then UPDATE. A QBO re-sync changing `amount` between those two statements
    // leaves a row the tax report TRUSTS verbatim. Prisma cannot express a
    // CHECK, so it is hand-written here and in prisma-blind-spots.json.
    // SIGNED, for the same reason the tax check is: the resold portion of a
    // return is negative. `base >= 0` made every credit unallocatable.
    // Dropped and re-added by name so an old definition is corrected.
    `ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_taxDeductibleBase_check"`,
    `ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxDeductibleBase_check"
  CHECK ("taxDeductibleBase" IS NULL
         OR "taxDeductibleBase" = 0
         OR (sign("taxDeductibleBase") = sign("amount")
             AND abs("taxDeductibleBase") <= abs("amount" - COALESCE("taxAmount", 0))))`,
];

/**
 * (b) THE THREE INDEXES (Codex round 15, item 1(b)).
 *
 * Kept here in their PLAIN, non-concurrent form — this is what stays
 * byte-equivalent to migration.sql, and what the shape/drift checks in this
 * file and tests/apply-expense-attribution.test.ts compare against the live
 * catalog. Production never runs this exact text: `toConcurrentIndexSql`
 * renders each one through `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT
 * EXISTS` at the point PHASE_A_STEPS actually executes it, standalone and
 * outside any transaction — CONCURRENTLY is not just friendlier (it does not
 * block writers on Expense for the build), it is REQUIRED here: Postgres
 * refuses to run it inside a transaction block at all, and index creation is
 * Expense-only regardless, so pulling it out of a transaction cannot create a
 * new lock-ordering hazard. The committed migration keeps the plain form
 * verbatim, in one transaction with everything else — Prisma has no
 * supported way to run CONCURRENTLY inside a migration, and it costs nothing
 * there: a migration only ever runs against a fresh CI/dev database with
 * nothing else writing.
 */
export const INDEX_STATEMENTS = [
    `CREATE INDEX IF NOT EXISTS "Expense_projectId_idx" ON "Expense"("projectId")`,
    `CREATE INDEX IF NOT EXISTS "Expense_sourceFileId_idx" ON "Expense"("sourceFileId")`,
    // THE DURABLE BACKSTOP FOR THE INGEST LOCK. The advisory lock in the
    // ingest route serialises two concurrent deliveries of one Drive file, but
    // an advisory lock is not a constraint — a writer that does not take it
    // cannot be stopped by it. This index makes the duplicate unrepresentable
    // for every row the new ingest writes, which stamps both columns.
    //
    // PARTIAL and NULLS-DISTINCT, both deliberately: `sourceFileId IS NOT
    // NULL` keeps manual and QBO-imported expenses out of it entirely, and the
    // rows backfilled above have a NULL `sourceGroupIndex` (nothing can say
    // which group they were), which a btree unique index treats as distinct —
    // so the backfill cannot collide with itself. Those legacy rows are NOT
    // protected by this index; the file-level dedupe covers them.
    //
    // Prisma cannot express a partial index, so it is SQL-only and recorded in
    // prisma/prisma-blind-spots.json, exactly like BankImage_driveFileId_key.
    `CREATE UNIQUE INDEX IF NOT EXISTS "Expense_sourceFileId_sourceGroupIndex_key"
  ON "Expense"("sourceFileId", "sourceGroupIndex")
  WHERE "sourceFileId" IS NOT NULL`,
];

/**
 * Renders a plain `CREATE [UNIQUE] INDEX IF NOT EXISTS` statement as its
 * CONCURRENTLY form. Pulled out and tested on its own (rather than inlined at
 * the call site) so a typo here fails a unit test instead of a production run.
 */
export function toConcurrentIndexSql(sql) {
    const rendered = sql.replace(
        /^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+)(IF NOT EXISTS)/i,
        "$1CONCURRENTLY $2",
    );
    if (rendered === sql) {
        throw new Error(`toConcurrentIndexSql could not find "CREATE [UNIQUE] INDEX IF NOT EXISTS" in: ${sql.slice(0, 80)}`);
    }
    return rendered;
}

/**
 * The compatibility triggers, Expense-only (they read "Estimate" only inside
 * a function BODY, which is compiled, not executed, at CREATE time — the
 * table is touched only later, when the trigger fires on somebody else's
 * transaction). Their own short transaction, run before PHASE_A_STEPS reaches
 * for either FK, and well before phase B's backfill — see the comment at
 * SPLIT_JOB_GUARD_SQL for why they must exist before the columns carry values.
 */
export const TRIGGER_STATEMENTS = [...SPLIT_JOB_GUARD_SQL, ...AMOUNT_TAX_GUARD_SQL];

/**
 * ReceiptIntake is Phase 1's table, not Project, Estimate, or even Expense —
 * its own short transaction, touching neither of the tables the FK steps
 * below reach for. The guard keeps this runnable in EITHER merge order: if
 * Phase 1 has not landed in the target database yet, these two columns are
 * skipped, and re-running this script after Phase 1 lands adds them.
 */
export const RECEIPT_INTAKE_STATEMENTS = [
    `DO $$ BEGIN
       IF to_regclass('"ReceiptIntake"') IS NOT NULL THEN
         ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false;
         ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN;
         ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "costCodeSource" TEXT;
       END IF;
     END $$`,
];

/**
 * (a) THE TWO FOREIGN KEYS, EACH `NOT VALID` AND EACH PRECEDED BY AN EXPLICIT
 * PARENT LOCK, IN ITS OWN SHORT TRANSACTION (Codex round 15, item 1(a)).
 *
 * `LOCK TABLE "Project" IN SHARE ROW EXCLUSIVE MODE` runs FIRST, as its own
 * statement — not because `ADD CONSTRAINT` would fail to take that lock on
 * its own, but because it takes it in the WRONG ORDER on its own: an `ALTER
 * TABLE "Expense" ADD CONSTRAINT ... REFERENCES "Project"` statement opens
 * and locks the table NAMED IN THE ALTER TABLE CLAUSE (Expense, ACCESS
 * EXCLUSIVE) before it opens the REFERENCED table (Project, SHARE ROW
 * EXCLUSIVE) to install the FK's enforcement trigger — Expense before its own
 * parent, exactly backwards from `lockAttributionParents`. Postgres locks are
 * cumulative and never downgraded within one transaction, so taking the
 * Project lock as its own PRECEDING statement makes the ADD CONSTRAINT
 * statement's own request for the same lock a no-op, and the acquisition
 * order every other waiter observes becomes Project-then-Expense.
 *
 * `NOT VALID` keeps this transaction short: it adds the constraint and the
 * enforcement trigger (for every write from this moment on) without scanning
 * existing rows, so the ACCESS EXCLUSIVE it takes on Expense — and the SHARE
 * ROW EXCLUSIVE it takes on Project — are both held only for a metadata
 * change. Existing data is checked afterward, by PROJECT_FK_VALIDATE_STATEMENTS,
 * in a separate transaction that needs no parent lock at all. At the moment
 * this runs `projectId` is a column this same script just added, so every row
 * is NULL and validation later finds nothing to disagree with — but the split
 * is the correct shape regardless of when it runs, not a fact about this being
 * the column's first migration.
 */
export const PROJECT_FK_LOCK_STATEMENTS = [
    `LOCK TABLE "Project" IN SHARE ROW EXCLUSIVE MODE`,
    // Guarded on the DEFINITION, not just the name: a name-only IF NOT EXISTS
    // silently accepts a same-named constraint that points elsewhere or
    // carries ON DELETE CASCADE. Existing-and-wrong raises rather than being
    // skipped.
    `DO $$
DECLARE existing_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def
    FROM pg_constraint
   WHERE conname = 'Expense_projectId_fkey'
     AND conrelid = '"Expense"'::regclass;
  IF existing_def IS NULL THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  ELSIF existing_def NOT LIKE '%FOREIGN KEY ("projectId")%'
     OR existing_def NOT LIKE '%REFERENCES "Project"(id)%'
     OR existing_def NOT LIKE '%ON DELETE SET NULL%'
     OR existing_def NOT LIKE '%ON UPDATE CASCADE%' THEN
    RAISE EXCEPTION 'Expense_projectId_fkey already exists with an unexpected definition: %', existing_def;
  END IF;
END $$`,
];

/**
 * `VALIDATE CONSTRAINT` takes only `SHARE UPDATE EXCLUSIVE` on Expense (reads
 * and writes proceed; only other DDL is blocked) and no table-level lock on
 * Project at all, so it cannot take part in a Project/Expense cycle. A
 * separate, later transaction from the lock+add above, so the SHARE ROW
 * EXCLUSIVE lock on Project is not held one moment longer than the
 * metadata-only add needs. Idempotent: Postgres treats VALIDATE CONSTRAINT as
 * a no-op once a constraint is already marked valid.
 */
export const PROJECT_FK_VALIDATE_STATEMENTS = [
    `ALTER TABLE "Expense" VALIDATE CONSTRAINT "Expense_projectId_fkey"`,
];

/**
 * The estimateId FK, same treatment as the project FK above. AN ESTIMATE MAY
 * NOT DELETE SPEND (round 42, item 4b): `Expense_estimateId_fkey` was NOT
 * NULL + ON DELETE CASCADE, so deleting an estimate deleted every expense
 * booked through it — worse after Phase 3, since a re-attributed row is
 * reported under a DIFFERENT job while still hanging off the estimate it
 * left. SET NULL, not RESTRICT: the row keeps `projectId`, the attribution
 * every reader already prefers, so the spend stays on its job with no
 * estimate behind it; RESTRICT would also block deleting a PROJECT, since
 * Project cascades to its Estimates. `Invoice.estimateId` and
 * `Takeoff.estimateId` already take the SET NULL stance in this schema.
 */
export const ESTIMATE_FK_LOCK_STATEMENTS = [
    `LOCK TABLE "Estimate" IN SHARE ROW EXCLUSIVE MODE`,
    `DO $$
DECLARE existing_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def
    FROM pg_constraint
   WHERE conname = 'Expense_estimateId_fkey'
     AND conrelid = '"Expense"'::regclass;
  IF existing_def IS NULL THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_estimateId_fkey"
      FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  ELSIF existing_def NOT LIKE '%ON DELETE SET NULL%' THEN
    ALTER TABLE "Expense" DROP CONSTRAINT "Expense_estimateId_fkey";
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_estimateId_fkey"
      FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
END $$`,
];

export const ESTIMATE_FK_VALIDATE_STATEMENTS = [
    `ALTER TABLE "Expense" VALIDATE CONSTRAINT "Expense_estimateId_fkey"`,
];

/**
 * THE ORDERED SEQUENCE OF SHORT TRANSACTIONS PHASE A ACTUALLY RUNS AS.
 *
 * main() and tests/attribution-lock-order-db.test.ts both drive this list
 * directly, so "what the script runs" and "what the deadlock test measures"
 * are the same data, not two hand-written copies that can drift. Each entry
 * commits (or, for the `concurrent` entry, completes its standalone
 * statements) before the next one begins — that is the entire fix: no step
 * here is EVER holding a lock on Expense while ALSO requesting one on Project
 * or Estimate, because the only steps that touch a parent table (the two FK
 * steps) do so as the very FIRST thing in a fresh transaction, immediately
 * after taking the explicit parent lock.
 */
export const PHASE_A_STEPS = [
    { label: "phase A: columns (Expense-only, no parent lock)", statements: COLUMN_STATEMENTS },
    { label: "phase A: normalize (Expense-only, no parent lock)", statements: NORMALIZE_STATEMENTS },
    { label: "phase A: checks (Expense-only, no parent lock)", statements: CHECK_STATEMENTS },
    { label: "phase A: indexes (CONCURRENTLY, standalone -- refuses to run inside a transaction)", statements: INDEX_STATEMENTS, concurrent: true },
    { label: "phase A: triggers (Expense-only, no parent lock)", statements: TRIGGER_STATEMENTS },
    { label: "phase A: ReceiptIntake (Phase 1's table -- not Project, Estimate, or Expense)", statements: RECEIPT_INTAKE_STATEMENTS },
    { label: "phase A: project FK (locks Project FIRST, parent before child)", statements: PROJECT_FK_LOCK_STATEMENTS },
    { label: "phase A: validate project FK", statements: PROJECT_FK_VALIDATE_STATEMENTS },
    { label: "phase A: estimate FK (locks Estimate FIRST, parent before child)", statements: ESTIMATE_FK_LOCK_STATEMENTS },
    { label: "phase A: validate estimate FK", statements: ESTIMATE_FK_VALIDATE_STATEMENTS },
];

/**
 * The flat concatenation of every PHASE_A_STEPS statement, in run order. Kept
 * for every consumer that predates the split — the migration-parity tests,
 * expectedColumns, the source tripwires — none of which care how many
 * transactions the run is broken into, only which statements run and in what
 * order. Built by SPREADING the same step arrays `PHASE_A_STEPS` holds
 * (rather than `PHASE_A_STEPS.flatMap(...)`, a module-scope method call
 * tests/apply-scripts-inert-on-import.test.ts's AST guard refuses to treat as
 * inert), so the flat view and the structured view still cannot drift apart —
 * there is exactly one array of statements per step, referenced from both
 * places.
 */
export const DDL_STATEMENTS = [
    ...COLUMN_STATEMENTS,
    ...NORMALIZE_STATEMENTS,
    ...CHECK_STATEMENTS,
    ...INDEX_STATEMENTS,
    ...TRIGGER_STATEMENTS,
    ...RECEIPT_INTAKE_STATEMENTS,
    ...PROJECT_FK_LOCK_STATEMENTS,
    ...PROJECT_FK_VALIDATE_STATEMENTS,
    ...ESTIMATE_FK_LOCK_STATEMENTS,
    ...ESTIMATE_FK_VALIDATE_STATEMENTS,
];

/**
 * PHASE B: THE DATA, IN THE CANONICAL LOCK ORDER (round 44, item 1).
 *
 * Projects first, then Estimates, then the Expense rows the UPDATE touches —
 * and in its OWN transaction, so every phase-A lock is long released by the
 * time any parent is asked for here.
 *
 * It is exactly `postDeployStatements`, which is not a coincidence and is the
 * point: the post-deploy pass exists to re-run the backfills against rows the
 * old build wrote during the drain window, so "the data phase" and "the
 * re-runnable half" are the same set of statements by construction. One
 * definition means the two can never drift.
 */
export function backfillStatements(timeZone) {
    return postDeployStatements(timeZone);
}

/**
 * EVERY statement the main run executes, in run order — phase A then phase B.
 *
 * Kept as one exported list because that is what the committed migration has to
 * contain and what tests/apply-expense-attribution.test.ts checks it against. A
 * migration file is replayed by Prisma inside a SINGLE transaction and there is
 * no supported way to split one, which costs nothing: it only ever runs against
 * a fresh CI or dev database where nothing else is writing. Production gets the
 * short-transaction treatment described at PHASE_A_STEPS, which is the only
 * place the concurrency exists.
 *
 * `reanchorSql` needs the company time zone, so this list holds the three
 * zone-free backfills and `main()` splices the re-anchor in beside them.
 */
export const statements = [
    ...DDL_STATEMENTS,
    PROJECT_ID_BACKFILL_LOCK_PROJECTS,
    PROJECT_ID_BACKFILL,
    SOURCE_FILE_ID_BACKFILL,
];

/**
 * The re-runnable half: the three statements marked POST-DEPLOY above.
 *
 * Both are already in the main run — this is a SUBSET, never a second copy, so
 * the two can never say different things (asserted in
 * tests/apply-expense-attribution.test.ts).
 */
export function postDeployStatements(timeZone) {
    return [
        // The project locks travel WITH the fill they protect: the post-deploy
        // pass runs the same statement against a live database, where a job
        // editor is far more likely to be holding a Project row than during
        // the pre-deploy window.
        PROJECT_ID_BACKFILL_LOCK_PROJECTS,
        PROJECT_ID_BACKFILL,
        reanchorSql(timeZone),
        SOURCE_FILE_ID_BACKFILL,
    ];
}

/**
 * The rest of the --post-deploy pass: the compatibility guard comes OUT, and
 * (only when asked) the split-job repair runs before it does.
 *
 * Deliberately NOT part of postDeployStatements: that function's invariant is
 * that it is a strict SUBSET of the main run, which is what stops the two
 * drifting into different backfills. These statements have no counterpart in
 * the main run — the teardown is the opposite of what the main run does, and
 * the repair must never run unasked — so folding them in would quietly break
 * the one property that test asserts.
 *
 * Order matters: repair first, drop second. The repair moves `projectId` and
 * leaves `estimateId` alone, so the guard never sees it; but if a future
 * version ever touched `estimateId`, doing it while the guard still stands is
 * the safe order, not the other way round.
 *
 * The lock travels WITH the repair (round 15, item 2), immediately before it,
 * for the same reason PROJECT_ID_BACKFILL_LOCK_PROJECTS precedes
 * PROJECT_ID_BACKFILL.
 */
export function postDeployTeardownStatements({ repairSplitJobs = false } = {}) {
    return [
        ...(repairSplitJobs ? [SPLIT_JOB_REPAIR_LOCK_PROJECTS, SPLIT_JOB_REPAIR] : []),
        ...SPLIT_JOB_GUARD_DROP_SQL,
        // The amount/tax guard comes out in the same pass and for the same
        // reason (see AMOUNT_TAX_GUARD_DROP_SQL). AFTER the repair, which
        // rewrites `projectId` and `attributionAnchoredAt` and never touches
        // `amount`, so this trigger never sees it either way.
        ...AMOUNT_TAX_GUARD_DROP_SQL,
    ];
}

export const expectedColumns = {
    Expense: [
        "projectId", "taxAmount", "taxAtSource", "installedAtCustomer",
        "costCodeSource", "costCodeConfidence", "taxDeductibleBase", "needsTaxReview",
        "taxSource", "taxDeductibleBaseSource", "attributionAnchoredAt", "updatedAt",
        "sourceFileId", "sourceGroupIndex",
    ],
};

/**
 * Verified by DEFINITION, not by name (Codex round 1, issue 9).
 *
 * The DO-block above skips when a constraint of that NAME already exists — so
 * a pre-existing `Expense_projectId_fkey` pointing at the wrong table, or
 * carrying ON DELETE CASCADE, would be left in place and the script would still
 * report success. The whole point of SET NULL here is that deleting a project
 * must not destroy spend history; a CASCADE wearing the same name is the exact
 * failure this check has to catch.
 */
export const expectedConstraints = [
    {
        name: "Expense_projectId_fkey",
        table: "Expense",
        mustMatch: [
            /FOREIGN KEY \("projectId"\)/,
            /REFERENCES "?Project"?\(id\)/,
            /ON UPDATE CASCADE/,
            /ON DELETE SET NULL/,
        ],
    },
    {
        // ROUND 42, ITEM 4b. Verified by DEFINITION like the one above, and
        // for a sharper reason: this constraint ALREADY EXISTED, with ON
        // DELETE CASCADE. A run that failed to replace it leaves a database
        // where deleting an estimate still deletes spend, and every other
        // check in this script would pass.
        name: "Expense_estimateId_fkey",
        table: "Expense",
        mustMatch: [
            /FOREIGN KEY \("estimateId"\)/,
            /REFERENCES "?Estimate"?\(id\)/,
            /ON UPDATE CASCADE/,
            /ON DELETE SET NULL/,
        ],
        // ...and the column it protects has to be nullable, or SET NULL can
        // never fire. `confdeltype = 'n'` is the catalog's own word for it.
        mustNotMatch: [/ON DELETE CASCADE/],
    },
];

/**
 * Columns this migration makes NULLABLE, checked from the catalog rather than
 * inferred from the DDL having run. A SET NULL foreign key on a NOT NULL
 * column is a constraint that can only ever raise an error.
 */
export const expectedNullableColumns = [
    { table: "Expense", column: "estimateId" },
];

/**
 * COMPARE CHECK CONSTRAINTS BY THEIR WHOLE NORMALIZED DEFINITION, NOT BY
 * SUBSTRINGS (Codex round 46, item 0 — a DEPLOY BLOCKER).
 *
 * The old form was a list of regexes run against `pg_get_constraintdef`, and it
 * did not survive contact with Postgres 16. PG renders a CHECK with its own
 * parenthesisation and its own casts:
 *
 *   CHECK (("taxAtSource" = (("taxAmount" IS NOT NULL) AND ("taxAmount" <> (0)::numeric))))
 *
 * `/"taxAtSource" = \(?"taxAmount" IS NOT NULL/` allows ONE optional paren and
 * PG writes TWO, so the pattern never matched and `main()` exited 1 on a
 * database that was in fact correct. Nothing caught it because CI has never run
 * `main()` — every test in this repo imports the constants and checks their
 * TEXT. The verifier was the one part of this script no test exercised, and it
 * was broken.
 *
 * So the comparison is now equality between the constraint PG reports and the
 * expression this script asked for, after normalising away the three things PG
 * is free to change and we do not care about:
 *
 *   * the outer `CHECK ( ... )` wrapper,
 *   * casts it adds to literals (`(0)::numeric`, `'x'::text`), and
 *   * whitespace and parenthesisation.
 *
 * REMOVING PARENS IS DELIBERATE, AND IT IS THE ONE THING THIS CANNOT SEE: two
 * expressions that differ only in grouping normalise the same. Every column
 * name, operator, function and their ORDER still has to match exactly, which is
 * far more than the substring form checked — and the constraints' actual
 * BEHAVIOUR (which rows they refuse) is proved separately against a real
 * Postgres in tests/expense-attribution-triggers-db.test.ts. Grouping is the
 * cheap half to lose; identity is the half that was missing.
 */
export function normalizeCheckDefinition(definition) {
    return String(definition ?? "")
        .toLowerCase()
        // The wrapper PG always prints, and only the outermost one.
        .replace(/^\s*check\s*/, "")
        // Casts PG synthesises on literals. `(0)::numeric` and a bare `0` are
        // the same constant; the script never writes a cast itself.
        .replace(/::\s*[a-z_][a-z0-9_ ]*/g, "")
        .replace(/[()\s]/g, "");
}

/**
 * The expression each CHECK must be, written the way this script writes it.
 * Compared through `normalizeCheckDefinition`, so parenthesisation and casts do
 * not matter and every token does.
 */
export const expectedCheckConstraints = [
    {
        name: "Expense_taxAtSource_check",
        table: "Expense",
        definition: `"taxAtSource" = ("taxAmount" IS NOT NULL AND "taxAmount" <> 0)`,
    },
    {
        name: "Expense_taxAmount_check",
        table: "Expense",
        // `amount` is unquoted because it is all-lowercase and not a keyword;
        // the mixed-case columns keep their quotes. Normalisation does not
        // touch quoting, so this has to be written the way PG renders it.
        definition:
            `"taxAmount" IS NULL OR "taxAmount" = 0 ` +
            `OR (sign("taxAmount") = sign(amount) AND abs("taxAmount") <= abs(amount))`,
    },
    {
        name: "Expense_taxDeductibleBase_check",
        table: "Expense",
        definition:
            `"taxDeductibleBase" IS NULL OR "taxDeductibleBase" = 0 ` +
            `OR (sign("taxDeductibleBase") = sign(amount) ` +
            `AND abs("taxDeductibleBase") <= abs(amount - COALESCE("taxAmount", 0)))`,
    },
];

/**
 * Verified by SHAPE, not by name (round 36, item 2) — the same lesson
 * expectedConstraints learned in round 1.
 *
 * Every creation above is `CREATE ... IF NOT EXISTS`, which matches on the
 * NAME alone. An index already carrying one of these names is therefore left
 * exactly as it is, whatever it indexes: the dedupe backstop could be a
 * non-unique index, could be over the wrong columns, or could have lost its
 * `WHERE "sourceFileId" IS NOT NULL` and so drag every NULL row into the
 * uniqueness. Checking `pg_class.relname` existed proved only that the CREATE
 * had been skipped, and the script printed "verified 3 index(es)" over a
 * duplicate-receipt guard that did not guard anything.
 *
 * So each entry carries what the index must BE, and the check reads the
 * catalog: `indisunique` for uniqueness, the key-column names in order
 * (`indkey`, cut to `indnkeyatts` so an INCLUDE column cannot pad it), and
 * `pg_get_expr(indpred)` for the partial predicate — `null` here means the
 * index must NOT be partial, which is a real assertion and not a skip.
 *
 * Drift fails the run rather than silently re-skipping the CREATE, and says
 * to drop and recreate, because that is the only thing that fixes it: no
 * `CREATE INDEX IF NOT EXISTS` will ever replace a wrong index in place.
 */
export const expectedIndexes = [
    { name: "Expense_projectId_idx", table: "Expense", unique: false, keyColumns: ["projectId"], predicate: null },
    { name: "Expense_sourceFileId_idx", table: "Expense", unique: false, keyColumns: ["sourceFileId"], predicate: null },
    // The partial UNIQUE index. Its shape is ALSO asserted against a real
    // catalog by scripts/check-migrations-match.mjs (out of
    // prisma/prisma-blind-spots.json); this checks the database the migration
    // actually ran against, which that one never sees.
    {
        name: "Expense_sourceFileId_sourceGroupIndex_key",
        table: "Expense",
        unique: true,
        keyColumns: ["sourceFileId", "sourceGroupIndex"],
        // pg renders it with the column quoted and the whole thing parenthesised.
        predicate: /^\("?sourceFileId"? IS NOT NULL\)$/,
    },
];

/**
 * Phase 1's table, checked only when it is present (see the guarded DO block).
 * `costCodeSource` was missing from this list while the DDL above added it —
 * so the one column the receipt-intake path needs for provenance was the one
 * column nothing verified.
 */

/**
 * Does the index in the database differ from the one we asked for?
 *
 * Pulled out of the verification loop so it can be tested against every wrong
 * shape without needing a database. Returns a human sentence describing the
 * FIRST difference, or null when the index is what it should be.
 *
 * `actual` is one row of the catalog query in main(): `table_name`,
 * `is_unique`, `key_columns` (ordered, NULL for an expression column) and
 * `predicate` (`pg_get_expr` of `indpred`, null when the index is total).
 */
export function indexDrift(expected, actual) {
    if (actual.table_name !== expected.table) {
        return `wrong table: expected ${expected.table}, found ${actual.table_name}`;
    }
    if (actual.is_unique !== expected.unique) {
        return `wrong uniqueness: expected indisunique = ${expected.unique}, found ${actual.is_unique}`;
    }
    const found = (actual.key_columns ?? []).map(column => column ?? "<expression>");
    if (found.length !== expected.keyColumns.length
        || found.some((column, index) => column !== expected.keyColumns[index])) {
        return `wrong key columns: expected (${expected.keyColumns.join(", ")}), found (${found.join(", ")})`;
    }
    // A null expectation ASSERTS the index is total. A partial index where a
    // total one belongs silently narrows whatever the index was meant to cover,
    // so "no predicate expected" cannot mean "predicate not checked".
    if (expected.predicate === null) {
        return actual.predicate === null
            ? null
            : `expected no predicate (a total index), found: ${actual.predicate}`;
    }
    if (actual.predicate === null) {
        return `expected the partial predicate ${expected.predicate}, but the index is not partial`;
    }
    return expected.predicate.test(actual.predicate)
        ? null
        : `wrong predicate: expected ${expected.predicate}, found: ${actual.predicate}`;
}

export const expectedReceiptIntakeColumns = ["taxAtSource", "installedAtCustomer", "costCodeSource"];

async function main() {
    // FLAGS ARE PARSED HERE, never at module scope: importing this file must
    // do nothing at all (tests/apply-scripts-inert-on-import.test.ts).
    const chosen = parseTarget(process.argv);
    if (chosen.error) {
        console.error(`REFUSING: ${chosen.error}`);
        process.exit(1);
    }
    if (!process.argv.includes("--yes")) {
        console.error("Refusing to run without --yes (and --expect-db / --expect-host).");
        process.exit(1);
    }
    const expectDb = readFlagValue("--expect-db") ?? process.env.EXPENSE_ATTRIBUTION_EXPECT_DB;
    const expectHost = readFlagValue("--expect-host") ?? process.env.EXPENSE_ATTRIBUTION_EXPECT_HOST;
    if (!expectDb || !expectHost) {
        console.error("Both --expect-db and --expect-host are required (or EXPENSE_ATTRIBUTION_EXPECT_DB / EXPENSE_ATTRIBUTION_EXPECT_HOST).");
        process.exit(1);
    }

    // The TARGET decides where the URL comes from — for `prod` that is
    // `.env.production.local` and the ambient `DATABASE_URL` is ignored, which
    // is the whole point: a local server in the shell must not be able to
    // impersonate production.
    const resolved = resolveTargetDatabaseUrl(chosen.name);
    if (resolved.error) {
        console.error(`REFUSING: ${resolved.error}`);
        process.exit(1);
    }
    const { url, from } = resolved;
    const hostProblem = targetHostVerdict(chosen.name, url);
    if (hostProblem) {
        console.error(`REFUSING: ${hostProblem}`);
        process.exit(1);
    }
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        const [actual] = await prisma.$queryRawUnsafe(
            `SELECT current_database() AS db, COALESCE(host(inet_server_addr()), '') AS host`,
        );
        // The REDACTED target line, before a single statement of phase A —
        // so what the operator sees first is which database is about to be
        // changed, with the credentials removed.
        console.log(targetBanner(chosen.name, { url, from, db: actual.db, host: actual.host }));
        if (!targetMatches(actual, expectDb, expectHost)) {
            console.error(`REFUSING: expected db="${expectDb}" host="${expectHost}" but connected to db="${actual.db}" host="${actual.host}".`);
            process.exit(1);
        }
        // AND THE DATABASE'S OWN IDENTITY, not just the one we dialled. The
        // production baseline row is written once, by the deliberate
        // `migrate resolve --applied` step documented in CLAUDE.md; a local
        // database somebody built with `db push` does not have it, and neither
        // does a fresh container built from a subset of the migrations.
        if (APPLY_TARGETS[chosen.name].requireBaseline) {
            const baseline = await prisma.$queryRawUnsafe(
                `SELECT 1 AS present FROM "_prisma_migrations"
                  WHERE migration_name = $1 AND finished_at IS NOT NULL`,
                PRODUCTION_BASELINE_MIGRATION,
            );
            if (!baseline?.length) {
                console.error(
                    `REFUSING: this database has no applied ${PRODUCTION_BASELINE_MIGRATION} row, ` +
                    `so it is not the baselined production database.`,
                );
                process.exit(1);
            }
            console.log(`verified baseline ${PRODUCTION_BASELINE_MIGRATION} is applied here`);
        }

        // The company zone, for the legacy re-anchor below. Read before the DDL
        // so a bad answer fails before anything is written.
        //
        // NOT wrapped in a catch: an unreadable settings table is not "no
        // settings", and treating it as such re-anchors a whole table into a
        // zone nobody chose. An absent row is the only thing that falls back.
        const settingsRows = await prisma.$queryRawUnsafe(
            `SELECT "timeZone" FROM "CompanySettings" WHERE id = 'singleton'`,
        );
        const { timeZone: companyTimeZone, from: zoneFrom } = pickCompanyTimeZone(settingsRows);
        console.log(`company time zone for the date re-anchor: ${companyTimeZone} (from ${zoneFrom})`);

        // A SEQUENCE OF SHORT TRANSACTIONS, SHAPE THEN DATA (round 15, item 1
        // — replacing round 44's "two transactions", which was still wrong:
        // see the comment at PHASE_A_STEPS for why bundling every DDL
        // statement into ONE phase-A transaction still deadlocks a
        // parent-first writer, even though nothing in that transaction's own
        // text says "Project" or "Estimate" outside a `pg_constraint` lookup.
        //
        // ATOMICITY IS NOT LOST, it is re-argued: every statement in every
        // step is additive and idempotent, so a crash between any two of them
        // is safe to re-run from the top, and the verification pass below
        // checks the END STATE rather than that any particular transaction
        // committed. That is a stronger guarantee than "all or nothing" for a
        // script whose whole design is to be re-runnable.
        //
        // The timeout is generous because a backfill over the Expense table on
        // a cold connection is not a five-second operation, and the default
        // would roll the whole thing back for being slow.
        // --post-deploy runs ONLY the two backfills, for the live-write gap
        // documented above PROJECT_ID_BACKFILL. Phase A is skipped because it
        // has already run; re-running it would be harmless but the point of
        // this mode is to be an obviously-narrow second pass.
        const postDeployOnly = process.argv.includes("--post-deploy");
        // OPT-IN, and only meaningful in the post-deploy pass. See
        // SPLIT_JOB_REPAIR for why this cannot be the default: after the new
        // build is live, a mismatched pair is either the rollout window or a
        // bookkeeper's deliberate re-attribution, and the row cannot say which.
        const repairSplitJobs = process.argv.includes("--repair-split-jobs");
        if (repairSplitJobs && !postDeployOnly) {
            console.error("--repair-split-jobs is only valid together with --post-deploy.");
            process.exit(1);
        }
        const phaseB = postDeployOnly
            ? [...postDeployStatements(companyTimeZone), ...postDeployTeardownStatements({ repairSplitJobs })]
            : backfillStatements(companyTimeZone);
        if (postDeployOnly) {
            console.log("--post-deploy: the three backfills, then BOTH compatibility guards come out (see PROJECT_ID_BACKFILL and AMOUNT_TAX_GUARD_SQL).");
            console.log(
                repairSplitJobs
                    ? "--repair-split-jobs: ALSO re-deriving projectId from the estimate for QBO-synced rows whose pair disagrees. Read SPLIT_JOB_REPAIR before trusting this on a database where humans have re-attributed expenses."
                    : "split-job repair NOT running (pass --repair-split-jobs to enable it; the verifier below reports the count either way).",
            );
        }
        const runPhase = async (label, sqlList, { concurrent = false } = {}) => {
            if (!sqlList.length) return;
            console.log(`\n-- ${label} --`);
            const execute = async client => {
                for (const sql of sqlList) {
                    // CREATE INDEX CONCURRENTLY refuses to run inside a
                    // transaction block, so the concurrent step renders each
                    // statement here rather than storing the CONCURRENTLY
                    // text in the exported constant (which stays plain, for
                    // byte-equivalence with migration.sql).
                    const rendered = concurrent ? toConcurrentIndexSql(sql) : sql;
                    const head = rendered.replace(/\s+/g, " ").slice(0, 84);
                    process.stdout.write(`  ${head} ... `);
                    const affected = await client.$executeRawUnsafe(rendered);
                    // Print the row count for the backfill: a SECOND run
                    // reporting 0 is the whole idempotency proof, and a silent
                    // "ok" hides it. `WITH` as well as `UPDATE`:
                    // PROJECT_ID_BACKFILL is a data-modifying CTE (it locks the
                    // estimates it reads), and matching only on "UPDATE"
                    // silently dropped the one row count this script's
                    // idempotency argument rests on.
                    console.log(/^(UPDATE|WITH)\b/i.test(sql.trimStart()) ? `ok (${affected} rows)` : "ok");
                }
            };
            if (concurrent) {
                // Each statement here is its own implicit transaction — that
                // is the whole point, and it is Expense-only regardless, so
                // running it outside any transaction cannot introduce a new
                // lock-ordering hazard.
                await execute(prisma);
            } else {
                await prisma.$transaction(tx => execute(tx), { timeout: 300_000, maxWait: 60_000 });
            }
        };
        // Phase A is skipped entirely on --post-deploy: the shape has already
        // landed, and the point of that mode is to be an obviously-narrow
        // second pass over the rows the old build wrote while it drained.
        //
        // ORDER IS THE POINT: every phase-A step commits (or, for the
        // concurrent index step, completes) before the next one starts, and
        // phase B — the only other step reaching for Project or Estimate —
        // runs only after every phase-A step has.
        if (!postDeployOnly) {
            for (const step of PHASE_A_STEPS) {
                await runPhase(step.label, step.statements, { concurrent: !!step.concurrent });
            }
        }
        await runPhase("phase B: data (Projects, then Estimates, then rows)", phaseB);

        // Verify shape rather than trusting the run.
        for (const [table, columns] of Object.entries(expectedColumns)) {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
                table,
            );
            const found = new Set(rows.map(r => r.column_name));
            const missing = columns.filter(c => !found.has(c));
            if (missing.length) {
                console.error(`VERIFY FAILED: ${table} missing columns: ${missing.join(", ")}`);
                process.exit(1);
            }
            console.log(`verified ${table}: ${columns.length} columns`);
        }
        for (const { name, table, mustMatch, mustNotMatch } of expectedConstraints) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                  WHERE conname = $1 AND conrelid = $2::regclass`,
                name, `"${table}"`,
            );
            if (!row) {
                console.error(`VERIFY FAILED: constraint ${name} missing on ${table}`);
                process.exit(1);
            }
            for (const pattern of mustMatch) {
                if (!pattern.test(row.def)) {
                    console.error(`VERIFY FAILED: ${name} does not match ${pattern}
  actual: ${row.def}`);
                    process.exit(1);
                }
            }
            for (const pattern of mustNotMatch ?? []) {
                if (pattern.test(row.def)) {
                    console.error(`VERIFY FAILED: ${name} still matches ${pattern}
  actual: ${row.def}`);
                    process.exit(1);
                }
            }
            console.log(`verified constraint ${name}: ${row.def}`);
        }
        // NULLABILITY, FROM THE CATALOG (round 42, item 4b). A SET NULL foreign
        // key on a NOT NULL column is a constraint that can only ever raise an
        // error, and nothing above would notice.
        for (const { table, column } of expectedNullableColumns) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT is_nullable FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
                table, column,
            );
            if (!row || row.is_nullable !== "YES") {
                console.error(`VERIFY FAILED: ${table}.${column} must be NULLABLE for its SET NULL foreign key (found ${row?.is_nullable ?? "no such column"})`);
                process.exit(1);
            }
            console.log(`verified nullable: ${table}.${column}`);
        }
        for (const { name, table, definition } of expectedCheckConstraints) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                  WHERE conname = $1 AND conrelid = $2::regclass`,
                name, `"${table}"`,
            );
            if (!row) {
                console.error(`VERIFY FAILED: check constraint ${name} missing on ${table}`);
                process.exit(1);
            }
            const found = normalizeCheckDefinition(row.def);
            const wanted = normalizeCheckDefinition(definition);
            if (found !== wanted) {
                console.error(`VERIFY FAILED: ${name} is not the constraint this script asks for.
  expected: ${definition}
  actual:   ${row.def}
  (compared after lowercasing, dropping casts, and removing whitespace and parens)`);
                process.exit(1);
            }
            console.log(`verified check constraint ${name}: ${row.def}`);
        }
        for (const { name, table, unique, keyColumns, predicate } of expectedIndexes) {
            // ONE catalog read per index, answering every question at once.
            // `indkey` is cut to `indnkeyatts` so an INCLUDE column cannot pad
            // the key list, and the LEFT JOIN leaves a NULL name for an
            // EXPRESSION column (attnum 0) rather than dropping it — an
            // expression where a plain column belongs must read as a mismatch,
            // not as a shorter list that happens to compare equal.
            let row = await readIndexCatalog(prisma, name);
            if (!row) {
                console.error(`VERIFY FAILED: index ${name} missing on ${table}`);
                process.exit(1);
            }
            // AN INDEX CAN EXIST AND ENFORCE NOTHING (round 46, item 1).
            //
            // `CREATE INDEX CONCURRENTLY` builds in three phases and can fail
            // in any of them — a deadlock, a uniqueness violation found during
            // the second scan, a cancelled session. What it leaves behind is an
            // index with the RIGHT NAME and `indisvalid = false`: the planner
            // ignores it, and for a UNIQUE index it enforces nothing. Then
            // `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` matches the name
            // on the next run and skips, and every shape check below passes,
            // because the shape IS right. The script printed "verified" over a
            // duplicate-receipt guard that was not guarding.
            //
            // So the flags are checked, and an invalid index is REBUILT rather
            // than reported: `IF NOT EXISTS` can never repair it, and leaving a
            // human to notice a line of output is how it stayed invisible.
            // Bounded to one attempt — a rebuild that fails the same way twice
            // is a data problem (an actual duplicate), and a loop would only
            // delay saying so.
            if (row.is_valid !== true || row.is_ready !== true) {
                const repair = await rebuildInvalidIndex(prisma, name, row);
                if (!repair.ok) {
                    console.error(repair.error);
                    process.exit(1);
                }
                console.log(repair.message);
                // THE CATALOG MOVED (round 47, item 3). Everything below reads
                // `row` — the drift comparison, the definition it prints, the
                // "verified" line — and after a rebuild that snapshot describes
                // an index that no longer exists. An invalid index that was
                // ALSO drifted got correctly rebuilt into the right shape and
                // then reported as still drifted, with an instruction to drop
                // the index the rebuild had just made correct.
                row = await readIndexCatalog(prisma, name);
                if (!row) {
                    console.error(`VERIFY FAILED: index ${name} is missing after its rebuild`);
                    process.exit(1);
                }
                if (row.is_valid !== true || row.is_ready !== true) {
                    console.error(
                        `VERIFY FAILED: index ${name} is still not usable after a rebuild ` +
                        `(indisvalid=${row.is_valid}, indisready=${row.is_ready}).`,
                    );
                    process.exit(1);
                }
            }
            // The mismatch reports the SAME remedy whatever it is, because it
            // is the only one that works: `CREATE INDEX IF NOT EXISTS` matched
            // this name and skipped, and will skip again on every future run.
            // The index has to be dropped and recreated by hand.
            const drift = indexDrift({ name, table, unique, keyColumns, predicate }, row);
            if (drift) {
                console.error(
                    `VERIFY FAILED: index ${name} has drifted \u2014 ${drift}\r\n` +
                    `  actual definition: ${row.def}\r\n` +
                    `  This script's CREATE ... IF NOT EXISTS matched the NAME and skipped, so a\r\n` +
                    `  re-run will NOT repair it. DROP INDEX "${name}" and re-run this script.`,
                );
                process.exit(1);
            }
            console.log(`verified index ${name}: ${row.def}`);
        }

        // THE COMPATIBILITY TRIGGERS, IN WHICHEVER STATE THIS RUN OWES
        // (round 37, item 2).
        //
        // Both are created by `CREATE OR REPLACE` + `DROP`/`CREATE` pairs and
        // dropped by `DROP ... IF EXISTS`; every one of those statements
        // succeeds silently on a database where it did nothing useful. The
        // pre-deploy run must END with both triggers standing — that IS the
        // expected mid-deploy state, and the drain window is unprotected
        // without them — and the --post-deploy run must end with neither, or
        // scaffolding stays live and quietly overrules the real build.
        const triggerRows = await prisma.$queryRawUnsafe(
            `SELECT t.tgname AS name
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
              WHERE c.relname = 'Expense' AND NOT t.tgisinternal`,
        );
        const liveTriggers = new Set(triggerRows.map(row => row.name));
        for (const name of COMPATIBILITY_TRIGGERS) {
            const present = liveTriggers.has(name);
            if (postDeployOnly && present) {
                console.error(`VERIFY FAILED: compatibility trigger ${name} is STILL on "Expense" after --post-deploy`);
                process.exit(1);
            }
            if (!postDeployOnly && !present) {
                console.error(
                    `VERIFY FAILED: compatibility trigger ${name} is missing from "Expense". ` +
                    `The drain window is unprotected — do NOT deploy the new build until this run succeeds.`,
                );
                process.exit(1);
            }
        }
        console.log(
            postDeployOnly
                ? `verified teardown: ${COMPATIBILITY_TRIGGERS.length} compatibility trigger(s) dropped`
                : `verified compatibility triggers standing for the drain window: ${COMPATIBILITY_TRIGGERS.join(", ")}`,
        );

        // The backfill's own assertion: after this script, no expense may have
        // a NULL projectId while its estimate knows one. A count, not a sample
        // — one leftover row is a silently wrong variance report.
        const [leftover] = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "Expense" e
               JOIN "Estimate" est ON est.id = e."estimateId"
              WHERE e."projectId" IS NULL AND est."projectId" IS NOT NULL`,
        );
        if (leftover.n !== 0) {
            console.error(`VERIFY FAILED: ${leftover.n} expense(s) still have a NULL projectId with a known estimate project`);
            process.exit(1);
        }
        console.log("verified backfill: 0 expenses left unattributed against a known estimate project");

        // ...and the OTHER direction, which the null check above is blind to:
        // an expense whose projectId disagrees with its estimate's. That is a
        // row claiming two jobs, and it is what an unlocked backfill or an
        // unguarded estimate move produces. Reported as a count either way, so
        // a clean run says so out loud rather than saying nothing.
        const [mismatched] = await prisma.$queryRawUnsafe(MISMATCHED_PAIRS_QUERY);
        console.log(`verified pair: ${mismatched.n} expense(s) disagree with their estimate's project`);
        if (mismatched.n !== 0) {
            console.error(
                `VERIFY FAILED: ${mismatched.n} expense(s) are attributed to a different job than their estimate. ` +
                `On this script's two intended runs that count is necessarily zero (see MISMATCHED_PAIRS_QUERY). ` +
                `If this is a much later re-run, some of these may be deliberate re-attributions rather than ` +
                `estimates moved out from under their expenses — read the rows before concluding either way, ` +
                `and do not trust a variance or profitability report until you have.`,
            );
            process.exit(1);
        }

        // The re-anchor's own assertion, same reasoning as the one above: after
        // this script, no row may still need re-anchoring. This is the number a
        // --post-deploy pass exists to drive to zero — it is what proves the
        // old build's live-write gap has actually closed, not just that the
        // script ran without error. SAME predicate the UPDATE used (by DATE
        // SHAPE, not the `attributionAnchoredAt` marker — see
        // needsReanchorPredicate) so an old instance that rewrote an
        // already-marked row back to UTC midnight cannot hide behind a marker
        // this query would otherwise trust.
        const [unanchored] = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "Expense" WHERE ${needsReanchorPredicate(companyTimeZone)}`,
        );
        if (unanchored.n !== 0) {
            console.error(`VERIFY FAILED: ${unanchored.n} expense(s) still sitting at UTC midnight, unanchored`);
            process.exit(1);
        }
        console.log("verified re-anchor: 0 expenses left at UTC midnight");

        // Phase 1's table may legitimately not exist yet (see the guard above).
        const [intake] = await prisma.$queryRawUnsafe(
            `SELECT to_regclass('"ReceiptIntake"') IS NOT NULL AS present`,
        );
        if (intake.present) {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ReceiptIntake'`,
            );
            const found = new Set(rows.map(r => r.column_name));
            const missing = expectedReceiptIntakeColumns.filter(c => !found.has(c));
            if (missing.length) {
                console.error(`VERIFY FAILED: ReceiptIntake missing columns: ${missing.join(", ")}`);
                process.exit(1);
            }
            console.log(`verified ReceiptIntake: ${expectedReceiptIntakeColumns.length} columns`);
        } else {
            console.log("ReceiptIntake not present — Phase 1 has not landed here yet; RE-RUN this script after it does.");
        }

        console.log("\nExpense attribution migration applied and verified.");
    } finally {
        await prisma.$disconnect();
    }
}

/**
 * AN INDEX CAN EXIST AND ENFORCE NOTHING (Codex round 46, item 1).
 *
 * `CREATE INDEX CONCURRENTLY` builds in three phases and can fail in any of
 * them — a deadlock, a uniqueness violation found during the second scan, a
 * cancelled session. What it leaves behind is an index with the RIGHT NAME and
 * `indisvalid = false`: the planner ignores it, and for a UNIQUE index it
 * enforces nothing. `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` then
 * matches the name on the next run and skips, and every shape check passes,
 * because the shape IS right. The script printed "verified" over a
 * duplicate-receipt guard that was not guarding.
 *
 * So an invalid index is REBUILT rather than reported: `IF NOT EXISTS` can
 * never repair it, and leaving a human to notice a line of output is how it
 * stayed invisible. Bounded to ONE attempt — a rebuild that fails is a data
 * problem (an actual duplicate), and a loop would only delay saying so.
 *
 * Exported so a real Postgres can be pointed at every branch of it
 * (tests/apply-script-index-db.test.ts); `main()` only decides what to do with
 * the answer.
 */
/**
 * ONE catalog read per index, answering every question at once.
 *
 * `indkey` is cut to `indnkeyatts` so an INCLUDE column cannot pad the key
 * list, and the LEFT JOIN leaves a NULL name for an EXPRESSION column
 * (attnum 0) rather than dropping it — an expression where a plain column
 * belongs must read as a mismatch, not as a shorter list that happens to
 * compare equal.
 *
 * A FUNCTION, not an inline query, because it has to be called TWICE: once
 * before the validity check and again after a rebuild (round 47, item 3). A
 * rebuilt index is a different pg_class row, and verifying the new one against
 * the old snapshot reports drift that was just repaired.
 */
export async function readIndexCatalog(prisma, name) {
    const [row] = await prisma.$queryRawUnsafe(
        `SELECT c.relname                              AS table_name,
                        i.indisunique                          AS is_unique,
                        -- A CONCURRENTLY build that fails or is interrupted
                        -- leaves the index BEHIND, with the expected name and
                        -- indisvalid = false (round 46, item 1).
                        i.indisvalid                           AS is_valid,
                        i.indisready                           AS is_ready,
                        pg_get_expr(i.indpred, i.indrelid)     AS predicate,
                        pg_get_indexdef(i.indexrelid)          AS def,
                        (SELECT array_agg(a.attname ORDER BY k.ord)
                           FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
                           LEFT JOIN pg_attribute a
                                  ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                          WHERE k.ord <= i.indnkeyatts)        AS key_columns
                   FROM pg_index i
                   JOIN pg_class ic     ON ic.oid = i.indexrelid
                   JOIN pg_class c      ON c.oid  = i.indrelid
                   JOIN pg_namespace n  ON n.oid  = ic.relnamespace
                  WHERE ic.relname = $1 AND n.nspname = 'public'`,
        name,
    );
    return row ?? null;
}

export async function rebuildInvalidIndex(prisma, name, state) {
    const preamble =
        `index ${name} is present but NOT USABLE ` +
        `(indisvalid=${state?.is_valid}, indisready=${state?.is_ready}) — ` +
        `a CONCURRENTLY build must have failed. Dropping and rebuilding.`;
    console.warn(preamble);
    const rebuild = INDEX_STATEMENTS.find(sql => sql.includes(`"${name}"`));
    if (!rebuild) {
        return { ok: false, error: `VERIFY FAILED: no CREATE statement for index ${name} to rebuild from` };
    }
    await prisma.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    try {
        await prisma.$executeRawUnsafe(toConcurrentIndexSql(rebuild));
    } catch (error) {
        // The rebuild failing is the INTERESTING outcome, not a crash: for a
        // UNIQUE index it means the table holds rows the index would forbid,
        // and a stack trace buries the one sentence that says so.
        return {
            ok: false,
            error:
                `VERIFY FAILED: index ${name} could not be rebuilt — ${error?.meta?.message ?? error?.message ?? error}\r\n` +
                `  For a UNIQUE index this means the table holds rows it would refuse.\r\n` +
                `  Find and resolve them, then re-run this script; it will rebuild the index.`,
        };
    }
    const [rebuilt] = await prisma.$queryRawUnsafe(
        `SELECT i.indisvalid AS is_valid, i.indisready AS is_ready
           FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = ic.relnamespace
          WHERE ic.relname = $1 AND n.nspname = 'public'`,
        name,
    );
    if (!rebuilt || rebuilt.is_valid !== true || rebuilt.is_ready !== true) {
        return {
            ok: false,
            error:
                `VERIFY FAILED: index ${name} is STILL invalid after a rebuild. ` +
                `For a UNIQUE index that usually means the table holds duplicates — ` +
                `find them before re-running.`,
        };
    }
    return { ok: true, message: `rebuilt index ${name} (it was invalid)` };
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
