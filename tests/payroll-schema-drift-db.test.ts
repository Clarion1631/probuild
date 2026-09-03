/**
 * Schema DRIFT, against a real database.
 *
 * Presence is not correctness. Every check the apply script used to make asked
 * only "does this exist" — which an index on the wrong columns, a CHECK
 * rewritten to something weaker, RLS switched off, or an identically-named
 * object in another schema all pass, while the guarantee they were written for
 * is gone.
 *
 * Each test here breaks ONE thing and asserts findSchemaDrift reports it. A
 * verifier that cannot fail is not a verifier, so these are mutation tests for
 * the verifier itself.
 *
 * Opt-in by URL. The migrations CI job supplies it from its service container.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

async function drift(db: PrismaClient) {
    const { findSchemaDrift } = await import("../scripts/apply-payroll-phase5.mjs");
    return findSchemaDrift(db);
}

function reported(rows: Array<{ object: { name?: string; table?: string }; reason: string }>, name: string) {
    return rows.find((row) => (row.object.name ?? row.object.table) === name);
}

/** The round-6 locked-snapshot CHECK, in the exact shape the migration and the apply script write. */
const LOCKED_SNAPSHOT_CHECK = `CHECK (
    "lockedAt" IS NULL
    OR ("summaryCsvSnapshot" IS NOT NULL AND "detailCsvSnapshot" IS NOT NULL AND "exportHash" IS NOT NULL)
)`;

/** Is that constraint actually there right now? Used as a PRECONDITION, so a test cannot silently no-op. */
async function hasLockedSnapshotCheck(db: PrismaClient): Promise<boolean> {
    const rows = (await db.$queryRawUnsafe(
        `SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_locked_snapshot_complete'
           AND conrelid = '"PayrollPeriod"'::regclass`
    )) as unknown[];
    return rows.length > 0;
}

// ── normalizeCheckDef, as a pure function (round 12, finding 3) ────────────
// No database needed — these run in every `npm run test:unit` / `test:payroll`
// pass, not just the migrations job. The three below are the EXACT mutation
// classes a substring check ("is every expected fragment somewhere in the
// actual text") let through: A AND B AND C contains the words "A", "B" and
// "C" just as much as A OR B OR C does, so a fragment check cannot tell them
// apart. Values here are lifted verbatim from a real PostgreSQL 16
// `pg_get_constraintdef()`, not guessed — see the function's own header.

test("normalizeCheckDef treats Postgres's printed form and the hand-written migration SQL as equal", async () => {
    const { normalizeCheckDef } = await import("../scripts/apply-payroll-phase5.mjs");
    // A real pg_get_constraintdef() result for `"payType" IS NULL OR "payType" IN ('HOURLY', 'SALARY')`.
    const actual = `CHECK ((("payType" IS NULL) OR ("payType" = ANY (ARRAY['HOURLY'::text, 'SALARY'::text]))))`;
    const expected = `"payType" IS NULL OR "payType" IN ('HOURLY', 'SALARY')`;
    assert.equal(normalizeCheckDef(actual), normalizeCheckDef(expected));
});

test("normalizeCheckDef distinguishes an AND->OR flip", async () => {
    const { normalizeCheckDef } = await import("../scripts/apply-payroll-phase5.mjs");
    const original = `"lockedAt" IS NULL OR ("summaryCsvSnapshot" IS NOT NULL AND "detailCsvSnapshot" IS NOT NULL AND "exportHash" IS NOT NULL)`;
    // A real pg_get_constraintdef() result for the same expression with the
    // trailing ANDs flipped to ORs.
    const flipped = `CHECK ((("lockedAt" IS NULL) OR (("summaryCsvSnapshot" IS NOT NULL) OR ("detailCsvSnapshot" IS NOT NULL) OR ("exportHash" IS NOT NULL))))`;
    assert.notEqual(
        normalizeCheckDef(original),
        normalizeCheckDef(flipped),
        "AND->OR must change the normalized comparison — a substring check would have missed this"
    );
});

test("normalizeCheckDef distinguishes IN from NOT IN", async () => {
    const { normalizeCheckDef } = await import("../scripts/apply-payroll-phase5.mjs");
    const original = `"payType" IS NULL OR "payType" IN ('HOURLY', 'SALARY')`;
    // A real pg_get_constraintdef() result for the NOT IN form.
    const negated = `CHECK ((("payType" IS NULL) OR ("payType" <> ALL (ARRAY['HOURLY'::text, 'SALARY'::text]))))`;
    assert.notEqual(normalizeCheckDef(original), normalizeCheckDef(negated));
});

test("normalizeCheckDef distinguishes a dropped clause", async () => {
    const { normalizeCheckDef } = await import("../scripts/apply-payroll-phase5.mjs");
    const original = `"periodStartKey" IS NOT NULL AND "periodEndKey" IS NOT NULL`;
    // A real pg_get_constraintdef() result with the second clause missing.
    const dropped = `CHECK (("periodStartKey" IS NOT NULL))`;
    assert.notEqual(normalizeCheckDef(original), normalizeCheckDef(dropped));
});

test("a clean database reports NO drift — the control", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        const rows = await drift(db);
        assert.deepEqual(
            rows.map((r: { object: { name?: string }; reason: string }) => [r.object.name, r.reason]),
            [],
            "without this control every assertion below is vacuous"
        );
    } finally {
        await db.$disconnect();
    }
});

test("RLS switched OFF is reported", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DISABLE ROW LEVEL SECURITY`);
        const row = reported(await drift(db), "PayrollPeriod");
        assert.ok(row, "disabling RLS must be reported");
        assert.match(row!.reason, /ROW LEVEL SECURITY is DISABLED/);
    } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ENABLE ROW LEVEL SECURITY`).catch(() => {});
        await db.$disconnect();
    }
});

test("a POLICY appearing on a protected table is reported", { skip }, async () => {
    // Zero policies IS the deny-all. A permissive policy reopens the door a
    // leaked anon key would come through, so it is drift, not an improvement.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`CREATE POLICY "drift_test_policy" ON "PayrollPeriod" FOR SELECT USING (true)`);
        const row = reported(await drift(db), "PayrollPeriod");
        assert.ok(row, "a new policy must be reported");
        assert.match(row!.reason, /1 polic\(ies\), expected 0/);
    } finally {
        await db.$executeRawUnsafe(`DROP POLICY IF EXISTS "drift_test_policy" ON "PayrollPeriod"`).catch(() => {});
        await db.$disconnect();
    }
});

test("an index on the WRONG COLUMNS is reported, though it exists", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "PayrollPeriod_lockedAt_idx"`);
        // Right name, right table, wrong column. A presence check passes.
        await db.$executeRawUnsafe(`CREATE INDEX "PayrollPeriod_lockedAt_idx" ON "PayrollPeriod"("lockedById")`);
        const row = reported(await drift(db), "PayrollPeriod_lockedAt_idx");
        assert.ok(row, "wrong index columns must be reported");
        assert.match(row!.reason, /columns are \[lockedById\], expected \[lockedAt\]/);
    } finally {
        await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "PayrollPeriod_lockedAt_idx"`).catch(() => {});
        await db
            .$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PayrollPeriod_lockedAt_idx" ON "PayrollPeriod"("lockedAt")`)
            .catch(() => {});
        await db.$disconnect();
    }
});

test("a UNIQUE index demoted to a plain index is reported", { skip }, async () => {
    // The invariant lives in the uniqueness, not the name.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "HelpSubmissionQuota_userId_hourBucket_key"`);
        await db.$executeRawUnsafe(
            `CREATE INDEX "HelpSubmissionQuota_userId_hourBucket_key" ON "HelpSubmissionQuota"("userId","hourBucket")`
        );
        const row = reported(await drift(db), "HelpSubmissionQuota_userId_hourBucket_key");
        assert.ok(row);
        assert.match(row!.reason, /unique is false, expected true/);
    } finally {
        await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "HelpSubmissionQuota_userId_hourBucket_key"`).catch(() => {});
        await db
            .$executeRawUnsafe(
                `CREATE UNIQUE INDEX IF NOT EXISTS "HelpSubmissionQuota_userId_hourBucket_key" ON "HelpSubmissionQuota"("userId","hourBucket")`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

test("a CHECK rewritten to something weaker is reported", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DROP CONSTRAINT "PayrollPeriod_discard_unlocked"`);
        // Same name, still VALIDATED, enforces nothing.
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_discard_unlocked" CHECK (true)`
        );
        const row = reported(await drift(db), "PayrollPeriod_discard_unlocked");
        assert.ok(row, "a weakened CHECK must be reported");
        assert.match(row!.reason, /definition drifted/);
    } finally {
        await db
            .$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_discard_unlocked"`)
            .catch(() => {});
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_discard_unlocked" CHECK ("discardedAt" IS NULL OR "lockedAt" IS NULL)`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

test("an FK reverted to CASCADE is reported", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_userId_fkey"`);
        await db.$executeRawUnsafe(
            `ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey"
             FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`
        );
        const row = reported(await drift(db), "TimeEntry_userId_fkey");
        assert.ok(row, "the cascade that destroyed payroll history must be reported");
        assert.match(row!.reason, /ON DELETE is 'c', expected 'r'/);
    } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "TimeEntry" DROP CONSTRAINT IF EXISTS "TimeEntry_userId_fkey"`).catch(() => {});
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey"
                 FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

test("a same-named object in ANOTHER SCHEMA does not satisfy the check", { skip }, async () => {
    // The trap: put a decoy in a schema that is on the search_path, drop the
    // real one, and a search_path-resolving lookup (to_regclass, a bare
    // table_name) reports healthy while the application's table is gone.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS drift_decoy`);
        await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "PayrollPeriod_discardedAt_idx"`);
        await db.$executeRawUnsafe(`CREATE TABLE drift_decoy."PayrollPeriod" ("discardedAt" timestamptz)`);
        await db.$executeRawUnsafe(
            `CREATE INDEX "PayrollPeriod_discardedAt_idx" ON drift_decoy."PayrollPeriod"("discardedAt")`
        );

        const row = reported(await drift(db), "PayrollPeriod_discardedAt_idx");
        assert.ok(row, "an index that only exists in another schema must still be reported missing");
        assert.equal(row!.reason, "missing");
    } finally {
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS drift_decoy CASCADE`).catch(() => {});
        await db
            .$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PayrollPeriod_discardedAt_idx" ON "PayrollPeriod"("discardedAt")`)
            .catch(() => {});
        await db.$disconnect();
    }
});

test("a column that came back NULLABLE is reported", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ALTER COLUMN "periodStart" DROP NOT NULL`);
        const row = reported(await drift(db), "periodStart");
        assert.ok(row, "a lost NOT NULL must be reported");
        assert.match(row!.reason, /nullability is true, expected false/);
    } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ALTER COLUMN "periodStart" SET NOT NULL`).catch(() => {});
        await db.$disconnect();
    }
});

// ── the objects the expected list used to omit entirely ────────────────────
// A verifier can only report what it names. EXPECTED_OBJECTS listed the
// ALTER-added columns and nothing a CREATE TABLE brought with it, so dropping
// any of the below left the script printing "verified N/N objects" — including
// exportHash, which src/lib/gusto-export-db.ts selects on every export.

test("a dropped CREATE TABLE column (exportHash) is reported — it used to be invisible", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DROP COLUMN "exportHash"`);
        const row = reported(await drift(db), "exportHash");
        assert.ok(row, "a column the export reads must not be able to vanish silently");
        assert.equal(row!.reason, "missing");
    } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "exportHash" TEXT`).catch(() => {});
        // DROP COLUMN takes every constraint OVER that column with it, silently.
        // PayrollPeriod_locked_snapshot_complete names exportHash, so restoring
        // the column alone left the constraint gone for every test after this
        // one — and the "an ABSENT locked-snapshot CHECK" case below then found
        // nothing to drop. A teardown has to undo the cascade, not just the
        // statement it typed.
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_locked_snapshot_complete" ${LOCKED_SNAPSHOT_CHECK}`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

test("a DROPPED DEFAULT on User.payrollRevision is reported", { skip }, async () => {
    // The rate-import signature is keyed on this counter; without the default a
    // new row's revision is whatever the writer forgot to supply.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "User" ALTER COLUMN "payrollRevision" DROP DEFAULT`);
        const row = reported(await drift(db), "payrollRevision");
        assert.ok(row, "a lost DEFAULT must be reported");
        assert.match(row!.reason, /default is null, expected 0/i);
    } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "User" ALTER COLUMN "payrollRevision" SET DEFAULT 0`).catch(() => {});
        await db.$disconnect();
    }
});

test("a CHANGED DEFAULT on HelpRequest.providerState is reported", { skip }, async () => {
    // reserveHelpRequest's INSERT does not name providerState. A default of
    // 'created' would make every brand-new report claim its GitHub issue exists.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "HelpRequest" ALTER COLUMN "providerState" SET DEFAULT 'created'`);
        const row = reported(await drift(db), "providerState");
        assert.ok(row, "a changed DEFAULT must be reported");
        assert.match(row!.reason, /default is 'created'/);
    } finally {
        await db
            .$executeRawUnsafe(`ALTER TABLE "HelpRequest" ALTER COLUMN "providerState" SET DEFAULT 'pending'`)
            .catch(() => {});
        await db.$disconnect();
    }
});

test("a PRIMARY KEY replaced by a same-named CHECK is reported, though it exists and validates", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "HelpSubmissionQuota" DROP CONSTRAINT "HelpSubmissionQuota_pkey"`);
        await db.$executeRawUnsafe(
            `ALTER TABLE "HelpSubmissionQuota" ADD CONSTRAINT "HelpSubmissionQuota_pkey" CHECK (true)`
        );
        const row = reported(await drift(db), "HelpSubmissionQuota_pkey");
        assert.ok(row, "row identity is not something a name alone guarantees");
        assert.match(row!.reason, /is a 'c' constraint, expected 'p'/);
    } finally {
        await db
            .$executeRawUnsafe(`ALTER TABLE "HelpSubmissionQuota" DROP CONSTRAINT IF EXISTS "HelpSubmissionQuota_pkey"`)
            .catch(() => {});
        await db
            .$executeRawUnsafe(`ALTER TABLE "HelpSubmissionQuota" ADD CONSTRAINT "HelpSubmissionQuota_pkey" PRIMARY KEY ("id")`)
            .catch(() => {});
        await db.$disconnect();
    }
});

// ── the payroll snapshot's own FK (round 34, finding 4) ────────────────────
// PayrollPeriod_lockedById_fkey was checked as "a foreign-key constraint of
// this name". A same-named ON DELETE CASCADE passes that, and deleting the
// admin who locked a period would then delete the period row — the frozen
// exportHash and both CSV snapshots, the immutable record of what payroll was
// actually paid. These break it one part at a time.

test("the payroll snapshot FK recreated as ON DELETE CASCADE is reported, and the dry run exits nonzero", { skip }, async () => {
    const { driftVerdict } = await import("../scripts/apply-payroll-phase5.mjs");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DROP CONSTRAINT "PayrollPeriod_lockedById_fkey"`);
        // Same name, same table, same column, still a validated foreign key —
        // and it destroys payroll history when a user row goes.
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_lockedById_fkey"
             FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`
        );
        const rows = await drift(db);
        const row = reported(rows, "PayrollPeriod_lockedById_fkey");
        assert.ok(row, "a CASCADE on the payroll snapshot must be reported");
        assert.match(row!.reason, /ON DELETE is 'c', expected 'n'/);
        // And the deploy step a human reads the exit code of actually fails.
        assert.equal(driftVerdict(rows).exitCode, 1, "--dry-run must exit nonzero on this");
    } finally {
        await db
            .$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_lockedById_fkey"`)
            .catch(() => {});
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_lockedById_fkey"
                 FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

test("the same FK pointed at a DIFFERENT TABLE is reported", { skip }, async () => {
    // Right name, right column, right ON DELETE — and it now says a lock was
    // taken by a Project. An FK is a relationship, not a name.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DROP CONSTRAINT "PayrollPeriod_lockedById_fkey"`);
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_lockedById_fkey"
             FOREIGN KEY ("lockedById") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE`
        );
        const row = reported(await drift(db), "PayrollPeriod_lockedById_fkey");
        assert.ok(row, "the referenced table must be pinned, not assumed");
        assert.match(row!.reason, /references public.Project, expected public.User/);
    } finally {
        await db
            .$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_lockedById_fkey"`)
            .catch(() => {});
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_lockedById_fkey"
                 FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

test("an ABSENT User.payrollRevision is reported as drift — this is what prod is presumed to be", { skip }, async () => {
    // The deploy procedure in the PR body turns on this: the 9/2 accidental
    // import applied the earlier objects but NOT this column, so prod is
    // presumed to lack it and --dry-run has to say so. The DEFAULT test above
    // only proves a weakened column is caught; this proves an absent one is.
    const { driftVerdict } = await import("../scripts/apply-payroll-phase5.mjs");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "User" DROP COLUMN "payrollRevision"`);
        const rows = await drift(db);
        const row = reported(rows, "payrollRevision");
        assert.ok(row, "the column every User read now selects must not be able to be silently absent");
        assert.equal(row!.reason, "missing");
        assert.equal(driftVerdict(rows).exitCode, 1);
    } finally {
        await db
            .$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "payrollRevision" INTEGER NOT NULL DEFAULT 0`)
            .catch(() => {});
        await db.$disconnect();
    }
});

// ── the locked-snapshot CHECK (round 6, finding 4) ─────────────────────────
// Its absence is what let a locked period with a null snapshot exist at all,
// and the export then served live data for it. The dry run has to say so.

test("an ABSENT locked-snapshot CHECK is reported, and the dry run exits nonzero", { skip }, async () => {
    const { driftVerdict } = await import("../scripts/apply-payroll-phase5.mjs");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        // PRECONDITION, asserted rather than assumed: an earlier test that
        // dropped a column this constraint names would have taken it with it,
        // and then "dropping" it here would be a no-op that still reported
        // drift — a green test proving nothing.
        assert.equal(await hasLockedSnapshotCheck(db), true, "the constraint must exist before this test drops it");
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT "PayrollPeriod_locked_snapshot_complete"`
        );
        const rows = await drift(db);
        const row = reported(rows, "PayrollPeriod_locked_snapshot_complete");
        assert.ok(row, "the constraint that makes a snapshot-less lock unrepresentable must not vanish quietly");
        assert.equal(row!.reason, "missing");
        assert.equal(driftVerdict(rows).exitCode, 1);
    } finally {
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_locked_snapshot_complete" ${LOCKED_SNAPSHOT_CHECK}`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

test("the same CHECK WEAKENED to cover only one column is reported", { skip }, async () => {
    // Same name, still validated, still a CHECK — and it would now accept a
    // locked period with no detail CSV and no hash. Presence is not correctness.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT "PayrollPeriod_locked_snapshot_complete"`
        );
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_locked_snapshot_complete"
             CHECK ("lockedAt" IS NULL OR "summaryCsvSnapshot" IS NOT NULL)`
        );
        const row = reported(await drift(db), "PayrollPeriod_locked_snapshot_complete");
        assert.ok(row, "a weakened CHECK must be reported");
        assert.match(row!.reason, /definition drifted/);
        // normalizeCheckDef lowercases, so the reported expected/actual text
        // does too — the reason names what went missing either way.
        assert.match(row!.reason, /detailcsvsnapshot|exporthash/i, "and it names what went missing");
    } finally {
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_locked_snapshot_complete"`
            )
            .catch(() => {});
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_locked_snapshot_complete" ${LOCKED_SNAPSHOT_CHECK}`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

// ── the substring-check hole itself (round 12, finding 3) ──────────────────
// findMissingObjects/findSchemaDrift used to ask only "does every expected
// FRAGMENT appear somewhere in the actual definition" — so `A AND B AND C`
// passed a check written for `A OR B OR C`, because every fragment is still
// in there. These three recreate each constraint with exactly the mutation a
// fragment check would have missed, against a REAL PostgreSQL 16 instance —
// not the hand-derived strings in the pure normalizeCheckDef tests above.

test("an AND->OR flip on the locked-snapshot CHECK is reported, and the dry run exits nonzero", { skip }, async () => {
    const { driftVerdict } = await import("../scripts/apply-payroll-phase5.mjs");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        assert.equal(await hasLockedSnapshotCheck(db), true, "the constraint must exist before this test replaces it");
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT "PayrollPeriod_locked_snapshot_complete"`
        );
        // Same name, still validated, still a CHECK, and it now accepts a
        // locked period missing TWO of the three snapshot columns as long as
        // ONE is present — a substring check ("summaryCsvSnapshot IS NOT
        // NULL" still appears in the text) would have missed this entirely.
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_locked_snapshot_complete"
             CHECK (
                "lockedAt" IS NULL
                OR ("summaryCsvSnapshot" IS NOT NULL OR "detailCsvSnapshot" IS NOT NULL OR "exportHash" IS NOT NULL)
             )`
        );
        const rows = await drift(db);
        const row = reported(rows, "PayrollPeriod_locked_snapshot_complete");
        assert.ok(row, "AND->OR must be reported — a fragment check would have passed this");
        assert.match(row!.reason, /definition drifted/);
        assert.equal(driftVerdict(rows).exitCode, 1, "--dry-run must exit nonzero on this");
    } finally {
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_locked_snapshot_complete"`
            )
            .catch(() => {});
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_locked_snapshot_complete" ${LOCKED_SNAPSHOT_CHECK}`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

test("User_payType_check flipped IN->NOT IN is reported, and the dry run exits nonzero", { skip }, async () => {
    const { driftVerdict } = await import("../scripts/apply-payroll-phase5.mjs");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "User" DROP CONSTRAINT "User_payType_check"`);
        // Same name, still validated — and it now REJECTS exactly the two
        // values the migration exists to allow, and accepts everything else.
        // Both "HOURLY" and "SALARY" still appear in the definition text, so
        // a fragment check would have passed this too.
        await db.$executeRawUnsafe(
            `ALTER TABLE "User" ADD CONSTRAINT "User_payType_check"
             CHECK ("payType" IS NULL OR "payType" NOT IN ('HOURLY', 'SALARY'))`
        );
        const rows = await drift(db);
        const row = reported(rows, "User_payType_check");
        assert.ok(row, "IN->NOT IN must be reported");
        assert.match(row!.reason, /definition drifted/);
        assert.equal(driftVerdict(rows).exitCode, 1, "--dry-run must exit nonzero on this");
    } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_payType_check"`).catch(() => {});
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "User" ADD CONSTRAINT "User_payType_check" CHECK ("payType" IS NULL OR "payType" IN ('HOURLY', 'SALARY'))`
            )
            .catch(() => {});
        await db.$disconnect();
    }
});

test("PayrollPeriod_keys_present with a dropped clause is reported, and the dry run exits nonzero", { skip }, async () => {
    const { driftVerdict } = await import("../scripts/apply-payroll-phase5.mjs");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await db.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DROP CONSTRAINT "PayrollPeriod_keys_present"`);
        // Same name, still validated — and it no longer requires periodEndKey
        // at all. "periodStartKey" IS NOT NULL still appears in the text, so a
        // fragment check would have reported this as healthy.
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_keys_present"
             CHECK ("periodStartKey" IS NOT NULL)`
        );
        const rows = await drift(db);
        const row = reported(rows, "PayrollPeriod_keys_present");
        assert.ok(row, "a dropped clause must be reported");
        assert.match(row!.reason, /definition drifted/);
        assert.equal(driftVerdict(rows).exitCode, 1, "--dry-run must exit nonzero on this");
    } finally {
        await db
            .$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_keys_present"`)
            .catch(() => {});
        await db
            .$executeRawUnsafe(
                `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_keys_present"
                 CHECK ("periodStartKey" IS NOT NULL AND "periodEndKey" IS NOT NULL) NOT VALID`
            )
            .catch(() => {});
        await db
            .$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" VALIDATE CONSTRAINT "PayrollPeriod_keys_present"`)
            .catch(() => {});
        await db.$disconnect();
    }
});

// ── the correct constraint, one more time — the control for the three above.
// Without this, every assertion above could pass on a normalizer so eager it
// reports drift on EVERYTHING, including the real thing.
test("the correct locked-snapshot CHECK, keys-present CHECK and payType CHECK all report clean", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        const rows = await drift(db);
        for (const name of [
            "PayrollPeriod_locked_snapshot_complete",
            "PayrollPeriod_keys_present",
            "User_payType_check",
        ]) {
            assert.equal(reported(rows, name), undefined, `${name} must NOT be reported when it matches exactly`);
        }
    } finally {
        await db.$disconnect();
    }
});

test("everything is restored — the teardown actually worked", { skip }, async () => {
    // Each test above repairs what it broke. If any teardown silently failed,
    // this catches it rather than letting a later CI step fail confusingly.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        assert.deepEqual(
            (await drift(db)).map((r: { object: { name?: string }; reason: string }) => [r.object.name, r.reason]),
            []
        );
    } finally {
        await db.$disconnect();
    }
});
