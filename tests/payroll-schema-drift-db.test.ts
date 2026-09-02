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
        assert.match(row!.reason, /definition lost/);
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
