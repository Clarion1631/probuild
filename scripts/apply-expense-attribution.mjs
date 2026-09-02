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

/** Built per-run so the zone is the company's, not a hard-coded guess. */
export function reanchorSql(timeZone) {
    // The zone is interpolated, so it must be a real IANA name and nothing
    // else — this string reaches the database unparameterized.
    if (!/^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+)*$/.test(timeZone)) {
        throw new Error(`Refusing to interpolate a suspicious time zone: ${timeZone}`);
    }
    return `UPDATE "Expense"
   SET "date" = (("date"::date)::timestamp AT TIME ZONE '${timeZone}') AT TIME ZONE 'UTC'
 WHERE "date" IS NOT NULL
   AND "date"::time = TIME '00:00:00'`;
}

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

    // TAX CANNOT EXCEED THE GROSS (Codex round 6, item 2). The deduction base
    // is `amount - taxAmount`, so a tax above the gross makes it NEGATIVE and
    // the report subtracts money from the filing. The taxDeductibleBase CHECK
    // does not cover it — a NULL allocation has nothing to violate.
    `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'Expense_taxAmount_check'
                    AND conrelid = '"Expense"'::regclass) THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxAmount_check"
      CHECK ("taxAmount" IS NULL
             OR ("taxAmount" >= 0 AND "taxAmount" <= "amount"));
  END IF;
END $$`,

    // THE DEDUCTION INVARIANT, IN THE DATABASE (Codex round 5, item 4).
    // Enforced only by the API handler before this: read the amount, validate,
    // then UPDATE. A QBO re-sync changing `amount` between those two statements
    // leaves a row the tax report TRUSTS verbatim. Prisma cannot express a
    // CHECK, so it is hand-written here and in prisma-blind-spots.json.
    `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'Expense_taxDeductibleBase_check'
                    AND conrelid = '"Expense"'::regclass) THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_taxDeductibleBase_check"
      CHECK ("taxDeductibleBase" IS NULL
             OR ("taxDeductibleBase" >= 0
                 AND "taxDeductibleBase" <= "amount" - COALESCE("taxAmount", 0)));
  END IF;
END $$`,

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
    `UPDATE "Expense" e SET "projectId" = est."projectId"
     FROM "Estimate" est
     WHERE e."estimateId" = est.id AND e."projectId" IS NULL AND est."projectId" IS NOT NULL`,

    // ReceiptIntake is Phase 1's table. The guard keeps this runnable in EITHER
    // merge order: if Phase 1 has not landed in the target database yet, these
    // two columns are skipped, and re-running this script after Phase 1 lands
    // adds them.
    `DO $$ BEGIN
       IF to_regclass('"ReceiptIntake"') IS NOT NULL THEN
         ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false;
         ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN;
       END IF;
     END $$`,
];

export const expectedColumns = {
    Expense: [
        "projectId", "taxAmount", "taxAtSource", "installedAtCustomer",
        "costCodeSource", "costCodeConfidence", "taxDeductibleBase", "needsTaxReview",
        "taxSource", "updatedAt",
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
        name: "Expense_taxAmount_check",
        table: "Expense",
        mustMatch: [/"taxAmount" IS NULL/, /"taxAmount" >= \(?0/, /"taxAmount" <= amount/],
    },
    {
        name: "Expense_taxDeductibleBase_check",
        table: "Expense",
        mustMatch: [
            /"taxDeductibleBase" IS NULL/,
            /"taxDeductibleBase" >= \(?0/,
            // pg_get_constraintdef renders `amount` UNQUOTED (all-lowercase,
            // not a keyword) while the mixed-case columns keep their quotes.
            /amount - COALESCE\("taxAmount"/,
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
        // so a missing CompanySettings row fails loudly rather than half-way.
        const [settings] = await prisma.$queryRawUnsafe(
            `SELECT "timeZone" FROM "CompanySettings" WHERE id = 'singleton'`,
        ).catch(() => [undefined]);
        const companyTimeZone = settings?.timeZone || DEFAULT_COMPANY_TIME_ZONE;
        console.log(`company time zone for the date re-anchor: ${companyTimeZone}`);

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
        await prisma.$transaction(async tx => {
            for (const sql of [...statements, reanchorSql(companyTimeZone)]) {
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
