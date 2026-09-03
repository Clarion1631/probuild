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
export const PROJECT_ID_BACKFILL =
    `UPDATE "Expense" e SET "projectId" = est."projectId"
     FROM "Estimate" est
     WHERE e."estimateId" = est.id AND e."projectId" IS NULL AND est."projectId" IS NOT NULL`;

export const statements = [
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "projectId" TEXT`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(65,30)`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "costCodeSource" TEXT`,
    `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "costCodeConfidence" DECIMAL(65,30)`,
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
 * The re-runnable half: the two statements marked POST-DEPLOY above.
 *
 * Both are already in the main run — this is a SUBSET, never a second copy, so
 * the two can never say different things (asserted in
 * tests/apply-expense-attribution.test.ts).
 */
export function postDeployStatements(timeZone) {
    return [PROJECT_ID_BACKFILL, reanchorSql(timeZone)];
}

export const expectedColumns = {
    Expense: [
        "projectId", "taxAmount", "taxAtSource", "installedAtCustomer",
        "costCodeSource", "costCodeConfidence", "taxDeductibleBase", "needsTaxReview",
        "taxSource", "attributionAnchoredAt", "updatedAt",
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

export const expectedIndexes = [
    { name: "Expense_projectId_idx", table: "Expense" },
];

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
        const toRun = postDeployOnly
            ? postDeployStatements(companyTimeZone)
            : [...statements, reanchorSql(companyTimeZone)];
        if (postDeployOnly) {
            console.log("--post-deploy: running the two backfills only (see PROJECT_ID_BACKFILL).");
        }
        await prisma.$transaction(async tx => {
            for (const sql of toRun) {
                const label = sql.replace(/\s+/g, " ").slice(0, 84);
                process.stdout.write(`  ${label} ... `);
                const affected = await tx.$executeRawUnsafe(sql);
                // Print the row count for the backfill: a SECOND run reporting
                // 0 is the whole idempotency proof, and a silent "ok" hides it.
                console.log(sql.trimStart().startsWith("UPDATE") ? `ok (${affected} rows)` : "ok");
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
        for (const { name, table } of expectedIndexes) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT 1 AS ok FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`, name,
            );
            if (!row) {
                console.error(`VERIFY FAILED: index ${name} missing on ${table}`);
                process.exit(1);
            }
        }
        console.log(`verified ${expectedIndexes.length} index(es)`);

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
            const missing = ["taxAtSource", "installedAtCustomer"].filter(c => !found.has(c));
            if (missing.length) {
                console.error(`VERIFY FAILED: ReceiptIntake missing columns: ${missing.join(", ")}`);
                process.exit(1);
            }
            console.log("verified ReceiptIntake: 2 columns");
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
