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
             SELECT est."projectId" INTO est_project
               FROM "Estimate" est
              WHERE est.id = NEW."estimateId";
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


export const statements = [
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
    // ...and fill it for the rows that predate the column. See the POST-DEPLOY
    // note above SOURCE_FILE_ID_BACKFILL.
    SOURCE_FILE_ID_BACKFILL,
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
    `UPDATE "Expense"
   SET "taxDeductibleBaseSource" = 'manual'
 WHERE "taxDeductibleBaseSource" IS NULL
   AND "taxDeductibleBase" IS NOT NULL
   AND "taxSource" IN ('manual', 'manual-none')`,
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
    // The three statements after it are REPAIR for a database left in the old
    // half-applied shape (column present, no default, NULLs from that window),
    // and no-ops on a clean run. The whole array runs in one transaction, so a
    // failure anywhere leaves the table exactly as it was.
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) DEFAULT now()`,
    `ALTER TABLE "Expense" ALTER COLUMN "updatedAt" SET DEFAULT now()`,
    `UPDATE "Expense" SET "updatedAt" = COALESCE("createdAt", now()) WHERE "updatedAt" IS NULL`,
    `ALTER TABLE "Expense" ALTER COLUMN "updatedAt" SET NOT NULL`,

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

    // SET NULL, not Cascade: `estimateId` already owns this row's lifecycle. A
    // project delete must not silently destroy spend history that the estimate
    // still holds.
    //
    // Guarded on the DEFINITION, not just the name: a name-only IF NOT EXISTS
    // silently accepts a same-named constraint that points elsewhere or carries
    // ON DELETE CASCADE. Existing-and-wrong raises rather than being skipped.
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
      ON DELETE SET NULL ON UPDATE CASCADE;
  ELSIF existing_def NOT LIKE '%FOREIGN KEY ("projectId")%'
     OR existing_def NOT LIKE '%REFERENCES "Project"(id)%'
     OR existing_def NOT LIKE '%ON DELETE SET NULL%'
     OR existing_def NOT LIKE '%ON UPDATE CASCADE%' THEN
    RAISE EXCEPTION 'Expense_projectId_fkey already exists with an unexpected definition: %', existing_def;
  END IF;
END $$`,

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

    // THE DEDUCTION INVARIANT, IN THE DATABASE (Codex round 5, item 4).
    // Enforced only by the API handler before this: read the amount, validate,
    // then UPDATE. A QBO re-sync changing `amount` between those two statements
    // leaves a row the tax report TRUSTS verbatim. Prisma cannot express a
    // CHECK, so it is hand-written here and in prisma-blind-spots.json.
    // `taxAtSource` IS DERIVED, AND THE DATABASE SAYS SO (round 20, item 1).
    // It was a second writable column saying what `taxAmount` already says, so
    // the two could disagree: `true` with no amount is a claim about nothing,
    // `false` with a figure is a deduction dropped from the filing. Normalised
    // first — a CHECK cannot be added to a table that already violates it —
    // then constrained. Both statements are re-runnable.
    `UPDATE "Expense"
   SET "taxAtSource" = ("taxAmount" IS NOT NULL AND "taxAmount" <> 0)
 WHERE "taxAtSource" <> ("taxAmount" IS NOT NULL AND "taxAmount" <> 0)`,
    `ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_taxAtSource_check"`,
    `ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxAtSource_check"
  CHECK ("taxAtSource" = ("taxAmount" IS NOT NULL AND "taxAmount" <> 0))`,

    // SIGNED, for the same reason the tax check is: the resold portion of a
    // return is negative. `base >= 0` made every credit unallocatable.
    // Dropped and re-added by name so an old definition is corrected.
    `ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_taxDeductibleBase_check"`,
    `ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxDeductibleBase_check"
  CHECK ("taxDeductibleBase" IS NULL
         OR "taxDeductibleBase" = 0
         OR (sign("taxDeductibleBase") = sign("amount")
             AND abs("taxDeductibleBase") <= abs("amount" - COALESCE("taxAmount", 0))))`,

    // RE-ANCHOR THE LEGACY UTC-MIDNIGHT ROWS (Codex round 6, item 1).
    //
    // Every writer now stores `Expense.date` as a company calendar day, but the
    // rows already in the table were written at UTC midnight — which the tax
    // report reads as the PREVIOUS day in Pacific, moving a 1 July receipt out
    // of Q3.
    //
    // IDEMPOTENT BY PREDICATE, which is stronger than a marker: re-anchoring
    // moves the time-of-day off 00:00 UTC, so a second run matches nothing and
    // there is no flag that can be lost, copied to another database, or get out
    // of step with the data. (A marker was specified; this is the same
    // once-only guarantee derived from the rows themselves, which is why it is
    // used instead — noted in the PR.)
    //
    // For a company configured as UTC the update is a no-op by arithmetic:
    // local midnight IS 00:00 UTC, so the value is rewritten to itself.
    //
    // It deliberately does NOT touch rows already at a non-midnight time —
    // those were written by time-expense-core, which has always used the shared
    // parser.
    // The backfill. Idempotent by predicate, and a no-op on an empty database.
    // THE COMPATIBILITY GUARD GOES IN BEFORE THE FILL, not after: from the
    // moment the column carries values, an old instance moving `estimateId`
    // can split the row across two jobs. See SPLIT_JOB_GUARD_SQL.
    ...SPLIT_JOB_GUARD_SQL,
    // See PROJECT_ID_BACKFILL and the POST-DEPLOY note above it.
    PROJECT_ID_BACKFILL,

    // ReceiptIntake is Phase 1's table. The guard keeps this runnable in EITHER
    // merge order: if Phase 1 has not landed in the target database yet, these
    // two columns are skipped, and re-running this script after Phase 1 lands
    // adds them.
    `DO $$ BEGIN
       IF to_regclass('"ReceiptIntake"') IS NOT NULL THEN
         ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false;
         ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN;
         ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "costCodeSource" TEXT;
       END IF;
     END $$`,
];

/**
 * The re-runnable half: the three statements marked POST-DEPLOY above.
 *
 * Both are already in the main run — this is a SUBSET, never a second copy, so
 * the two can never say different things (asserted in
 * tests/apply-expense-attribution.test.ts).
 */
export function postDeployStatements(timeZone) {
    return [PROJECT_ID_BACKFILL, reanchorSql(timeZone), SOURCE_FILE_ID_BACKFILL];
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
 */
export function postDeployTeardownStatements({ repairSplitJobs = false } = {}) {
    return [
        ...(repairSplitJobs ? [SPLIT_JOB_REPAIR] : []),
        ...SPLIT_JOB_GUARD_DROP_SQL,
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
];

export const expectedCheckConstraints = [
    {
        name: "Expense_taxAtSource_check",
        table: "Expense",
        mustMatch: [
            /"taxAtSource" = \(?"taxAmount" IS NOT NULL/,
            /"taxAmount" <> \(?0/,
        ],
    },
    {
        name: "Expense_taxAmount_check",
        table: "Expense",
        mustMatch: [
            /"taxAmount" IS NULL/,
            /"taxAmount" = \(?0/,
            // pg_get_constraintdef renders `amount` unquoted (all-lowercase,
            // not a keyword) while the mixed-case column keeps its quotes.
            /sign\("taxAmount"\) = sign\(amount\)/,
            /abs\("taxAmount"\) <= abs\(amount\)/,
        ],
    },
    {
        name: "Expense_taxDeductibleBase_check",
        table: "Expense",
        mustMatch: [
            /"taxDeductibleBase" IS NULL/,
            /"taxDeductibleBase" = \(?0/,
            /sign\("taxDeductibleBase"\) = sign\(amount\)/,
            // pg_get_constraintdef renders `amount` UNQUOTED (all-lowercase,
            // not a keyword) while the mixed-case columns keep their quotes.
            /abs\("taxDeductibleBase"\) <= abs\(\(?amount - COALESCE\("taxAmount"/,
        ],
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

    const { url, from } = resolveDatabaseUrl();
    console.log(`DATABASE_URL from ${from}: ${maskUrl(url)}`);
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        const [actual] = await prisma.$queryRawUnsafe(
            `SELECT current_database() AS db, COALESCE(host(inet_server_addr()), '') AS host`,
        );
        console.log(`connected to db="${actual.db}" host="${actual.host}"`);
        if (!targetMatches(actual, expectDb, expectHost)) {
            console.error(`REFUSING: expected db="${expectDb}" host="${expectHost}" but connected to db="${actual.db}" host="${actual.host}".`);
            process.exit(1);
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

        // ONE TRANSACTION FOR THE WHOLE THING (Codex round 13, item 6).
        //
        // Postgres is transactional for DDL, so there is no reason for this to
        // be able to stop half-way: a network blip between the backfill and
        // `SET NOT NULL` used to leave production with a column the next run
        // had to repair, and one wrong statement used to leave every statement
        // before it applied. Either the whole shape lands or none of it does.
        //
        // The timeout is generous because a backfill over the Expense table on
        // a cold connection is not a five-second operation, and the default
        // would roll the whole thing back for being slow.
        // --post-deploy runs ONLY the two backfills, for the live-write gap
        // documented above PROJECT_ID_BACKFILL. The DDL is skipped because it
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
        const toRun = postDeployOnly
            ? [...postDeployStatements(companyTimeZone), ...postDeployTeardownStatements({ repairSplitJobs })]
            : [...statements, reanchorSql(companyTimeZone)];
        if (postDeployOnly) {
            console.log("--post-deploy: the three backfills, then the compatibility guard comes out (see PROJECT_ID_BACKFILL).");
            console.log(
                repairSplitJobs
                    ? "--repair-split-jobs: ALSO re-deriving projectId from the estimate for QBO-synced rows whose pair disagrees. Read SPLIT_JOB_REPAIR before trusting this on a database where humans have re-attributed expenses."
                    : "split-job repair NOT running (pass --repair-split-jobs to enable it; the verifier below reports the count either way).",
            );
        }
        await prisma.$transaction(async tx => {
            for (const sql of toRun) {
                const label = sql.replace(/\s+/g, " ").slice(0, 84);
                process.stdout.write(`  ${label} ... `);
                const affected = await tx.$executeRawUnsafe(sql);
                // Print the row count for the backfill: a SECOND run reporting
                // 0 is the whole idempotency proof, and a silent "ok" hides it.
                // `WITH` as well as `UPDATE`: PROJECT_ID_BACKFILL is now a
                // data-modifying CTE (it locks the estimates it reads), and
                // matching only on "UPDATE" silently dropped the one row count
                // this script's idempotency argument rests on.
                console.log(/^(UPDATE|WITH)\b/i.test(sql.trimStart()) ? `ok (${affected} rows)` : "ok");
            }
        }, { timeout: 300_000, maxWait: 60_000 });

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
        for (const { name, table, mustMatch } of expectedConstraints) {
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
            console.log(`verified constraint ${name}: ${row.def}`);
        }
        for (const { name, table, mustMatch } of expectedCheckConstraints) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                  WHERE conname = $1 AND conrelid = $2::regclass`,
                name, `"${table}"`,
            );
            if (!row) {
                console.error(`VERIFY FAILED: check constraint ${name} missing on ${table}`);
                process.exit(1);
            }
            for (const pattern of mustMatch) {
                if (!pattern.test(row.def)) {
                    console.error(`VERIFY FAILED: ${name} does not match ${pattern}
  actual: ${row.def}`);
                    process.exit(1);
                }
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
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT c.relname                              AS table_name,
                        i.indisunique                          AS is_unique,
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
            if (!row) {
                console.error(`VERIFY FAILED: index ${name} missing on ${table}`);
                process.exit(1);
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

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
