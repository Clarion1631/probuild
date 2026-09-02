// Additive schema for Phase 5 payroll
// (docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md sections 2 and 3):
//
//   User.lastRateSyncAt   Last time this member's pay rate was CONFIRMED (via
//                         the Gusto CSV rate import or a manual edit on
//                         Company -> Team Members). Null = never confirmed.
//   PayrollPeriod         A reviewed/exported pay period, half-open
//                         [periodStart, periodEnd). lockedAt freezes every
//                         time entry whose startTime falls inside it.
//
// ADD COLUMN / CREATE TABLE IF NOT EXISTS only — idempotent, no drops, safe
// while the previous build is live (the old build ignores both). Run BEFORE
// deploying the build that reads them, per CLAUDE.md "Schema migrations" (no
// `prisma db push` / `migrate dev` here — DIRECT_URL is IPv6-only). Then
// regenerate the client from PowerShell.
//   node scripts/apply-payroll-phase5.mjs
//
// Kept statement-for-statement in sync with
// prisma/migrations/20260901000000_payroll_phase5/migration.sql.
import { PrismaClient } from "@prisma/client";

/**
 * Which addresses this run is allowed to mark SALARY.
 *
 * NO DEFAULT, deliberately. An unset env var means nobody — the previous
 * revision defaulted to two hardcoded people, which is a migration script
 * guessing a pay type on nobody's authority. Exported so the rule can be tested
 * without a database.
 */
export function classifySalariedEmails(raw) {
    if (typeof raw !== "string") return [];
    return [
        ...new Set(
            raw
                .split(",")
                .map((email) => email.trim().toLowerCase())
                .filter(Boolean)
        ),
    ].sort();
}

/** `--dry-run` prints what the seed WOULD do and writes nothing. */
export const isDryRun = (argv = process.argv) => argv.includes("--dry-run");

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Every object this script is responsible for, as a catalog query.
 *
 * Used two ways: `--dry-run` reports which of these already exist (and prints
 * "nothing to do" when they all do), and the normal run verifies them after
 * writing. One list, so the dry run and the real run cannot disagree about what
 * "applied" means.
 */
export const EXPECTED_OBJECTS = [
    { kind: "column", table: "User", name: "lastRateSyncAt" },
    { kind: "column", table: "User", name: "payType" },
    { kind: "table", name: "PayrollPeriod" },
    { kind: "column", table: "PayrollPeriod", name: "timeZone" },
    { kind: "column", table: "PayrollPeriod", name: "summaryCsvSnapshot" },
    { kind: "column", table: "PayrollPeriod", name: "detailCsvSnapshot" },
    { kind: "column", table: "PayrollPeriod", name: "periodStartKey" },
    { kind: "column", table: "PayrollPeriod", name: "periodEndKey" },
    { kind: "column", table: "PayrollPeriod", name: "discardedAt" },
    { kind: "column", table: "PayrollPeriod", name: "discardedById" },
    { kind: "column", table: "PayrollPeriod", name: "discardedReason" },
    { kind: "index", name: "PayrollPeriod_periodStart_periodEnd_key" },
    { kind: "index", name: "PayrollPeriod_periodStartKey_periodEndKey_key" },
    { kind: "index", name: "PayrollPeriod_lockedAt_idx" },
    { kind: "index", name: "PayrollPeriod_lockedById_idx" },
    { kind: "index", name: "PayrollPeriod_discardedAt_idx" },
    { kind: "index", name: "TimeEntry_startTime_idx" },
    { kind: "constraint", table: "PayrollPeriod", name: "PayrollPeriod_lockedById_fkey" },
    { kind: "constraint", table: "PayrollPeriod", name: "PayrollPeriod_range_check" },
    { kind: "constraint", table: "PayrollPeriod", name: "PayrollPeriod_keys_present" },
    { kind: "constraint", table: "PayrollPeriod", name: "PayrollPeriod_discard_unlocked" },
    { kind: "constraint", table: "User", name: "User_payType_check" },
    { kind: "column", table: "HelpRequest", name: "submissionId" },
    { kind: "column", table: "HelpRequest", name: "providerIssueRef" },
    { kind: "column", table: "HelpRequest", name: "providerState" },
    { kind: "column", table: "HelpRequest", name: "providerLeaseToken" },
    { kind: "column", table: "HelpRequest", name: "providerLeaseExpiresAt" },
    { kind: "index", name: "HelpRequest_userId_submissionId_key" },
    { kind: "index", name: "HelpRequest_userId_createdAt_idx" },
    { kind: "table", name: "HelpSubmissionQuota" },
    { kind: "index", name: "HelpSubmissionQuota_userId_hourBucket_key" },
    // Not created by a statement — CONVERTED. 'r' is RESTRICT; 'c' is the old
    // CASCADE that silently destroyed payroll history.
    { kind: "fk-restrict", table: "TimeEntry", name: "TimeEntry_userId_fkey" },
    { kind: "fk-restrict", table: "TimeEntry", name: "TimeEntry_projectId_fkey" },
];

/** Read-only. Returns the subset of EXPECTED_OBJECTS that is NOT yet present. */
export async function findMissingObjects(db, expected = EXPECTED_OBJECTS) {
    const missing = [];
    for (const object of expected) {
        let rows;
        if (object.kind === "column") {
            rows = await db.$queryRawUnsafe(
                `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
                object.table,
                object.name
            );
        } else if (object.kind === "table") {
            rows = await db.$queryRawUnsafe(
                `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
                object.name
            );
        } else if (object.kind === "index") {
            rows = await db.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, object.name);
        } else if (object.kind === "constraint") {
            // convalidated: a NOT VALID constraint is not enforced for existing
            // rows, so an unvalidated one does not count as applied.
            rows = await db.$queryRawUnsafe(
                `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2) AND convalidated`,
                object.name,
                `"${object.table}"`
            );
        } else if (object.kind === "fk-restrict") {
            rows = await db.$queryRawUnsafe(
                `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2) AND confdeltype = 'r'`,
                object.name,
                `"${object.table}"`
            );
        }
        if (!rows || rows.length === 0) missing.push(object);
    }
    return missing;
}

const STATEMENTS = [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastRateSyncAt" TIMESTAMPTZ(6)`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "payType" TEXT`,
    `CREATE TABLE IF NOT EXISTS "PayrollPeriod" (
        "id" TEXT NOT NULL,
        "periodStart" TIMESTAMPTZ(6) NOT NULL,
        "periodEnd" TIMESTAMPTZ(6) NOT NULL,
        "lockedAt" TIMESTAMPTZ(6),
        "lockedById" TEXT,
        "exportHash" TEXT,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_periodStart_periodEnd_key" ON "PayrollPeriod"("periodStart", "periodEnd")`,
    `CREATE INDEX IF NOT EXISTS "PayrollPeriod_lockedAt_idx" ON "PayrollPeriod"("lockedAt")`,
    `CREATE INDEX IF NOT EXISTS "PayrollPeriod_lockedById_idx" ON "PayrollPeriod"("lockedById")`,
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "timeZone" TEXT`,
    // The exported CSVs, frozen at lock time. A locked period is served from
    // these verbatim rather than recomputed — the CSVs are built from mutable
    // inputs (name, email, payType, Gusto id mapping, a punch's project and
    // cost code after logistics recoding) and would not reproduce.
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "summaryCsvSnapshot" TEXT`,
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "detailCsvSnapshot" TEXT`,
    // Stable identity — see the matching migration.
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "periodStartKey" TEXT`,
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "periodEndKey" TEXT`,
    `UPDATE "PayrollPeriod"
     SET "periodStartKey" = to_char("periodStart" AT TIME ZONE COALESCE("timeZone", 'America/Los_Angeles'), 'YYYY-MM-DD'),
         "periodEndKey"   = to_char("periodEnd"   AT TIME ZONE COALESCE("timeZone", 'America/Los_Angeles'), 'YYYY-MM-DD')
     WHERE "periodStartKey" IS NULL OR "periodEndKey" IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_periodStartKey_periodEndKey_key" ON "PayrollPeriod"("periodStartKey", "periodEndKey")`,
    // Every payroll read is a startTime RANGE scan; no FK index serves that.
    `CREATE INDEX IF NOT EXISTS "TimeEntry_startTime_idx" ON "TimeEntry"("startTime")`,
    // ADD CONSTRAINT has no IF NOT EXISTS — guard it so a replay is a no-op.
    `DO $$
     BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_lockedById_fkey') THEN
            ALTER TABLE "PayrollPeriod"
                ADD CONSTRAINT "PayrollPeriod_lockedById_fkey"
                FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
     END $$`,
    // ---- Integrity + RLS (review round 5, items 7 and 9) ----------------
    // CHECKs because payType and the period bounds are money-critical and
    // reachable from several code paths; Prisma cannot see them, so they are
    // also recorded in prisma/prisma-blind-spots.json.
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_payType_check' AND conrelid = '"User"'::regclass) THEN
            ALTER TABLE "User" ADD CONSTRAINT "User_payType_check" CHECK ("payType" IS NULL OR "payType" IN ('HOURLY', 'SALARY'));
        END IF;
     END $$`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_range_check' AND conrelid = '"PayrollPeriod"'::regclass) THEN
            ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_range_check" CHECK ("periodEnd" > "periodStart");
        END IF;
     END $$`,
    // NOT VALID: new rows must carry the stable keys, legacy rows are backfilled
    // above and never fail the migration.
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_keys_present' AND conrelid = '"PayrollPeriod"'::regclass) THEN
            ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_keys_present" CHECK ("periodStartKey" IS NOT NULL AND "periodEndKey" IS NOT NULL) NOT VALID;
        END IF;
     END $$`,
    // The key backfill above filled every legacy row, so validate it: a
    // permanently NOT VALID constraint has never checked anything, and it is a
    // real difference from production. VALIDATE takes only SHARE UPDATE
    // EXCLUSIVE, so it blocks neither reads nor writes.
    `ALTER TABLE "PayrollPeriod" VALIDATE CONSTRAINT "PayrollPeriod_keys_present"`,
    // A leaked anon/authenticated Supabase key must not read payroll periods,
    // their frozen CSVs, or the pay columns on User. Prisma connects as the
    // table OWNER and owners bypass RLS, so the app is unaffected; the Supabase
    // client here is storage-only (CLAUDE.md), so nothing reads these through
    // the Data API.
    `ALTER TABLE "PayrollPeriod" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "User" ENABLE ROW LEVEL SECURITY`,
    // The Supabase roles do not exist on a vanilla Postgres and REVOKE on a
    // missing role is a hard error — guarded so CI's throwaway DB runs the same
    // statements.
    `DO $$
     BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON TABLE "PayrollPeriod" FROM anon;
            REVOKE ALL ON TABLE "User" FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON TABLE "PayrollPeriod" FROM authenticated;
            REVOKE ALL ON TABLE "User" FROM authenticated;
        END IF;
     END $$`,
    // ---- Help-widget throttle + idempotency (round 6, item 6) -----------
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "submissionId" TEXT`,
    // Whether the GitHub issue exists yet — `status` could not tell "never
    // tried" from "tried and finished".
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerIssueRef" TEXT`,
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerState" TEXT DEFAULT 'pending'`,
    // CAS lease over the provider call — see the matching migration.
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerLeaseToken" TEXT`,
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerLeaseExpiresAt" TIMESTAMPTZ(6)`,
    // Unique PER USER — a global key would collide across users and hand back
    // somebody else's report.
    `CREATE UNIQUE INDEX IF NOT EXISTS "HelpRequest_userId_submissionId_key" ON "HelpRequest"("userId", "submissionId")`,
    `CREATE INDEX IF NOT EXISTS "HelpRequest_userId_createdAt_idx" ON "HelpRequest"("userId", "createdAt")`,
    `CREATE TABLE IF NOT EXISTS "HelpSubmissionQuota" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "hourBucket" TIMESTAMPTZ(6) NOT NULL,
        "count" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "HelpSubmissionQuota_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "HelpSubmissionQuota_userId_hourBucket_key" ON "HelpSubmissionQuota"("userId", "hourBucket")`,
    `ALTER TABLE "HelpSubmissionQuota" ENABLE ROW LEVEL SECURITY`,
    `DO $$
     BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON TABLE "HelpSubmissionQuota" FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON TABLE "HelpSubmissionQuota" FROM authenticated;
        END IF;
     END $$`,
];

/**
 * DO NOT run any of this at import time.
 *
 * The env loading below reads .env.production.local, so merely importing this
 * file used to load PRODUCTION credentials and then execute every statement
 * against them. That is not hypothetical: it happened on 2026-09-02 when a test
 * imported the module to reach classifySalariedEmails, and the whole Phase 5
 * migration ran against production as a side effect of the import.
 *
 * Everything with a side effect now lives in main(), which only runs when this
 * file is the entrypoint. The exported helpers above are pure and safe to
 * import.
 */
async function main() {
    config({ path: join(__dirname, "..", ".env.production.local") });
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL is not set (.env.production.local missing?).");
        process.exit(1);
    }

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const dryRun = isDryRun();

    try {
        // --dry-run is READ-ONLY, for the whole script — not just the seed.
        //
        // It is the verification step for a deploy, so it has to be safe to point
        // at production. An earlier revision gated only the payType seed on this
        // flag and executed every DDL statement regardless, which made "--dry-run"
        // a lie in the one place it mattered most.
        if (dryRun) {
            const missing = await findMissingObjects(prisma);
            if (missing.length === 0) {
                console.log(
                    `[dry-run] nothing to do — all ${EXPECTED_OBJECTS.length} objects this script manages are already present.`
                );
            } else {
                console.log(`[dry-run] ${missing.length} of ${EXPECTED_OBJECTS.length} object(s) would be created or converted:`);
                for (const object of missing) {
                    console.log(`[dry-run]   ${object.kind} ${object.table ? object.table + "." : ""}${object.name}`);
                }
            }

            const salariedPreview = classifySalariedEmails(process.env.PAYROLL_SALARIED_EMAILS);
            if (!salariedPreview.length) {
                console.log("[dry-run] PAYROLL_SALARIED_EMAILS is not set — no payType would be seeded.");
            } else {
                const would = await prisma.$queryRawUnsafe(
                    `SELECT "email" FROM "User" WHERE "payType" IS NULL AND lower("email") = ANY($1::text[]) ORDER BY "email"`,
                    salariedPreview
                );
                console.log(`[dry-run] would set payType = SALARY for ${would.length} user(s):`);
                for (const row of would) console.log(`[dry-run]   ${row.email}`);
                const unmatched = salariedPreview.filter(
                    (email) => !would.some((row) => String(row.email).toLowerCase() === email)
                );
                if (unmatched.length) {
                    console.log(`[dry-run] ${unmatched.length} listed address(es) matched no NULL-payType user: ${unmatched.join(", ")}`);
                }
            }
            console.log("[dry-run] no statement was executed.");
            return;
        }

        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
            console.log("ok:", sql.split("\n")[0].trim().slice(0, 90));
        }
        // NO endTime backfill — see the note in the matching migration. Synthesising
        // a span for a manual entry makes WA meal settlement treat PAID hours as a
        // RAW span, deduct a meal it never owed, and reprice it at the member's
        // current rate. The readers were fixed instead.

        // User.payType is left NULL for anyone nobody has confirmed.
        //
        // An earlier revision also stamped every ACTIVATED crew member and manager
        // as HOURLY. That defeated the whole point of the column: stored values beat
        // the env fallback, so a salaried manager omitted from
        // PAYROLL_SALARIED_EMAILS would have been permanently marked hourly, and
        // later fixing the env var would have changed nothing — Gusto would pay them
        // a salary AND the exported hours. NULL blocks the export until a human
        // answers on Company -> Team Members, which is the fail-closed behaviour the
        // column exists for.
        //
        // The SALARY seed only ever moves a row in the SAFE direction (excluded from
        // the summary = cannot be double-paid), only for emails an operator
        // EXPLICITLY listed, and never over an existing answer.
        //
        // It used to default that list to two named people when the env var was
        // unset. That is the same guess the NULL column exists to prevent, just
        // aimed the other way: a migration script deciding, on nobody's authority,
        // that two specific humans are salaried. If either had actually been hourly
        // the export would have silently dropped their hours. No env var, no seed.
        const salaried = classifySalariedEmails(process.env.PAYROLL_SALARIED_EMAILS);
        if (!salaried.length) {
            console.log(
                "PAYROLL_SALARIED_EMAILS is not set — no payType is being seeded. Everyone stays NULL until a human answers on Company -> Team Members."
            );
        } else {
            const seededSalary = await prisma.$executeRawUnsafe(
                `UPDATE "User" SET "payType" = 'SALARY' WHERE "payType" IS NULL AND lower("email") = ANY($1::text[])`,
                salaried
            );
            console.log(`seeded ${seededSalary} user(s) to payType = SALARY from PAYROLL_SALARIED_EMAILS`);
        }
        const unconfirmed = await prisma.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "User" WHERE "payType" IS NULL AND "status" = 'ACTIVATED'`
        );
        console.log(
            `${unconfirmed[0].n} activated user(s) still have no payType — the payroll export will refuse to run for anyone with hours until they are set on Company -> Team Members. This is intentional.`
        );

        // ----------------------------------------------------------------------
        // TimeEntry no longer cascades from User or Project (review round 16).
        // Idempotent on confdeltype: 'c' is CASCADE, 'r' is RESTRICT, so a second
        // run finds 'r' and does nothing.
        // ----------------------------------------------------------------------
        await prisma.$executeRawUnsafe(`
            DO $$
            DECLARE
                fk RECORD;
            BEGIN
                FOR fk IN
                    SELECT unnest(ARRAY['TimeEntry_userId_fkey', 'TimeEntry_projectId_fkey']) AS name,
                           unnest(ARRAY['userId', 'projectId'])                               AS col,
                           unnest(ARRAY['User', 'Project'])                                   AS parent
                LOOP
                    IF EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = fk.name
                          AND conrelid = '"TimeEntry"'::regclass
                          AND confdeltype = 'c'
                    ) THEN
                        EXECUTE format('ALTER TABLE "TimeEntry" DROP CONSTRAINT %I', fk.name);
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = fk.name AND conrelid = '"TimeEntry"'::regclass
                    ) THEN
                        EXECUTE format(
                            'ALTER TABLE "TimeEntry" ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I("id") ON DELETE RESTRICT ON UPDATE CASCADE',
                            fk.name, fk.col, fk.parent
                        );
                    END IF;
                END LOOP;
            END $$;
        `);
        const cascading = await prisma.$queryRawUnsafe(
            `SELECT conname FROM pg_constraint
              WHERE conrelid = '"TimeEntry"'::regclass AND confdeltype = 'c'
                AND conname IN ('TimeEntry_userId_fkey', 'TimeEntry_projectId_fkey')`
        );
        console.log(`TimeEntry parent FKs still cascading: ${cascading.length} (expected 0)`);
        if (cascading.length !== 0) process.exit(1);

        // ----------------------------------------------------------------------
        // A wrong-range period is DISCARDED, not deleted (review round 16, item 6).
        // Unlocking leaves the row behind and every overlap check then refuses the
        // corrected range forever, so there was no way back from a typo.
        //
        // These three columns, the index and the CHECK shipped in the migration but
        // NOT here for one commit — a prod run of this script would have left the
        // discard action writing to columns that did not exist. tests/
        // payroll-apply-script-parity.test.ts now fails the build if the two files
        // ever diverge again.
        // ----------------------------------------------------------------------
        await prisma.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "discardedAt" TIMESTAMPTZ(6)`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "discardedById" TEXT`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "discardedReason" TEXT`);
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "PayrollPeriod_discardedAt_idx" ON "PayrollPeriod"("discardedAt")`
        );
        // A LOCKED period is never discarded: that would retire hours already
        // exported and paid, and every reader would stop seeing the freeze that
        // protects them. VALIDATE, not NOT VALID — an unvalidated constraint is not
        // enforced for existing rows, so prod would disagree with CI's replay.
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_discard_unlocked"`
        );
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_discard_unlocked"
                CHECK ("discardedAt" IS NULL OR "lockedAt" IS NULL) NOT VALID`
        );
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" VALIDATE CONSTRAINT "PayrollPeriod_discard_unlocked"`
        );

        const discardBits = await prisma.$queryRawUnsafe(
            `SELECT column_name AS name FROM information_schema.columns
              WHERE table_name = 'PayrollPeriod'
                AND column_name IN ('discardedAt', 'discardedById', 'discardedReason')
             UNION ALL
             SELECT indexname FROM pg_indexes
              WHERE tablename = 'PayrollPeriod' AND indexname = 'PayrollPeriod_discardedAt_idx'
             UNION ALL
             SELECT conname FROM pg_constraint
              WHERE conrelid = '"PayrollPeriod"'::regclass
                AND conname = 'PayrollPeriod_discard_unlocked'
                AND convalidated`
        );
        console.log(`verified ${discardBits.length}/5 discard columns, index and validated CHECK`);
        if (discardBits.length !== 5) process.exit(1);

        const cols = await prisma.$queryRawUnsafe(
            `SELECT table_name, column_name FROM information_schema.columns
             WHERE (table_name = 'User' AND column_name IN ('lastRateSyncAt','payType'))
                OR (table_name = 'PayrollPeriod' AND column_name IN ('id','periodStart','periodEnd','lockedAt','lockedById','exportHash','createdAt'))`
        );
        console.log(`verified ${cols.length}/9 columns present`);
        if (cols.length !== 9) process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    await main();
}

