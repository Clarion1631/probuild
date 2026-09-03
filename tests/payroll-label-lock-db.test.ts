/**
 * TWO REAL CONNECTIONS, contending over the LABELS the detail CSV prints.
 *
 * The hole (round 10, finding 3). `Project.name` and `CostCode.code` are
 * columns of the detail CSV, so they are inputs to the frozen hash exactly like
 * a team member's name is — and unlike the member row, neither was held by
 * anything. lockPayrollPeriod could read the entries, hash the file, and commit
 * while a rename landed in between, leaving a pay period frozen around a file
 * that no longer described the database at the instant it was frozen.
 *
 * The fix re-reads both under `SELECT ... FOR SHARE` inside the lock
 * transaction, in the order Project -> CostCode (after the TimeEntry read,
 * before the roster), and uses THOSE values. So a renamer waits, and the hash
 * describes what was held.
 *
 * Each test drives a rename on a second connection while the export transaction
 * is open, and carries the pre-fix control: the same rename committed BEFORE the
 * export, which does change the bytes — so a test that saw no difference would
 * be proving nothing.
 *
 * Opt-in by URL, like every other DB test here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-payroll-label-lock";
if (databaseUrl && !process.env.DATABASE_URL?.includes("pgbouncer=true")) {
    const url = new URL(databaseUrl);
    url.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = url.toString();
}

const TZ = "America/Los_Angeles";
const PERIOD_START = new Date("2026-08-17T07:00:00.000Z");
const PERIOD_END = new Date("2026-08-31T07:00:00.000Z");
const START_KEY = "2026-08-17";
const END_KEY = "2026-08-31";
const PUNCH_START = "2026-08-24T15:00:00Z";
const PUNCH_END = "2026-08-24T23:00:00Z";

/** Resolves true once `promise` has not settled for `ms` — i.e. it is genuinely blocked. */
function stillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const marker = Symbol("pending");
    return Promise.race([
        promise.then(() => false),
        new Promise((resolve) => setTimeout(() => resolve(marker), ms)).then((v) => v === marker),
    ]) as Promise<boolean>;
}

async function seed(db: PrismaClient, suffix: string) {
    const { encryptObject } = await import("../src/lib/crypto");
    const priorCompany = await db.companySettings.findUnique({ where: { id: "singleton" } });
    const priorIntegration = await db.integration.findUnique({ where: { id: "system_settings" } });
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", timeZone: TZ },
        update: { timeZone: TZ },
    });
    const settings = encryptObject({ gusto: { connected: true, employeeMappings: {} } });
    await db.integration.upsert({
        where: { id: "system_settings" },
        create: { id: "system_settings", settings },
        update: { settings },
    });

    const email = `label-lock-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email } });
    const user = await db.user.create({
        data: {
            name: `Label Lock ${suffix}`,
            email,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 30,
        },
        select: { id: true },
    });

    const clientId = `label-client-${suffix}`;
    const projectId = `label-project-${suffix}`;
    const costCodeId = `label-costcode-${suffix}`;
    const entryId = `label-entry-${suffix}`;

    await db.$executeRawUnsafe(`INSERT INTO "Client" ("id","name","initials") VALUES ($1,'Label Lock','LL')`, clientId);
    await db.$executeRawUnsafe(
        `INSERT INTO "Project" ("id","name","clientId","updatedAt") VALUES ($1,'ORIGINAL PROJECT',$2,now())`,
        projectId,
        clientId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "CostCode" ("id","code","name","updatedAt") VALUES ($1,'01-ORIG','Original',now())`,
        costCodeId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "TimeEntry" ("id","userId","projectId","costCodeId","startTime","endTime","durationHours","updatedAt")
         VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,8,now())`,
        entryId,
        user.id,
        projectId,
        costCodeId,
        PUNCH_START,
        PUNCH_END
    );

    return {
        user,
        projectId,
        costCodeId,
        restore: async () => {
            await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = $1`, entryId).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, projectId).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "CostCode" WHERE "id" = $1`, costCodeId).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Client" WHERE "id" = $1`, clientId).catch(() => {});
            await db.user.deleteMany({ where: { email } }).catch(() => {});
            if (priorCompany) {
                await db.companySettings
                    .update({ where: { id: "singleton" }, data: { timeZone: priorCompany.timeZone } })
                    .catch(() => {});
            } else {
                await db.companySettings.delete({ where: { id: "singleton" } }).catch(() => {});
            }
            if (priorIntegration) {
                await db.integration
                    .update({ where: { id: "system_settings" }, data: { settings: priorIntegration.settings } })
                    .catch(() => {});
            } else {
                await db.integration.delete({ where: { id: "system_settings" } }).catch(() => {});
            }
        },
    };
}

const EXPORT_OPTIONS = { startKey: START_KEY, endKey: END_KEY, timeZone: TZ } as const;

for (const subject of [
    {
        label: "a project rename",
        table: "Project",
        column: "name",
        original: "ORIGINAL PROJECT",
        renamed: "RENAMED PROJECT",
        idOf: (seeded: { projectId: string; costCodeId: string }) => seeded.projectId,
    },
    {
        label: "a cost-code rename",
        table: "CostCode",
        column: "code",
        original: "01-ORIG",
        renamed: "99-RENAMED",
        idOf: (seeded: { projectId: string; costCodeId: string }) => seeded.costCodeId,
    },
] as const) {
    test(`${subject.label} BLOCKS while a pay period is being read`, { skip }, async () => {
        const { loadGustoExport } = await import("../src/lib/gusto-export-db");
        const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
        const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
        const suffix = subject.table.toLowerCase();
        const seeded = await seed(reader, suffix);

        try {
            let release: () => void = () => {};
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            let frozenDetail = "";

            // Connection A: the export, inside a transaction, HOLDING after its
            // read — exactly the window lockPayrollPeriod occupies between
            // hashing the CSVs and committing.
            const exporting = reader.$transaction(
                async (tx) => {
                    const result = await loadGustoExport(PERIOD_START, PERIOD_END, { ...EXPORT_OPTIONS, client: tx });
                    frozenDetail = result.detailCsv;
                    await held;
                },
                { timeout: 30_000 }
            );

            await new Promise((resolve) => setTimeout(resolve, 500));
            assert.ok(
                frozenDetail.includes(subject.original),
                `the export hashed the ${subject.column} it is about to freeze`
            );

            // Connection B: the rename. It must WAIT.
            const rename = writer.$executeRawUnsafe(
                `UPDATE "${subject.table}" SET "${subject.column}" = $1 WHERE "id" = $2`,
                subject.renamed,
                subject.idOf(seeded)
            );
            assert.equal(
                await stillPending(rename, 1_000),
                true,
                `${subject.label} must not land between the export read and its COMMIT — it is a column of the file`
            );

            release();
            await exporting;
            await rename;

            // The frozen bytes describe what was held, not what committed after.
            assert.ok(frozenDetail.includes(subject.original));
            assert.ok(!frozenDetail.includes(subject.renamed));

            // THE CONTROL: the rename really does change the file, so the
            // assertions above are about the lock rather than about a column
            // the CSV never prints.
            const after = await loadGustoExport(PERIOD_START, PERIOD_END, EXPORT_OPTIONS);
            assert.ok(after.detailCsv.includes(subject.renamed), "a fresh export sees the new value");
            assert.notEqual(after.exportHash, "", "and it hashes differently");
            assert.ok(!after.detailCsv.includes(subject.original));
        } finally {
            await seeded.restore();
            await reader.$disconnect().catch(() => {});
            await writer.$disconnect().catch(() => {});
        }
    });
}

test("outside a transaction the labels are NOT locked — a released lock would promise nothing", { skip }, async () => {
    // The same rule the settings rows and the roster follow: on the base client
    // every statement is its own transaction, so a FOR SHARE would be gone
    // before the next line. The page render and the download are ordinary reads.
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(reader, "nolock");

    try {
        await loadGustoExport(PERIOD_START, PERIOD_END, EXPORT_OPTIONS);
        const rename = writer.$executeRawUnsafe(
            `UPDATE "Project" SET "name" = 'RENAMED PROJECT' WHERE "id" = $1`,
            seeded.projectId
        );
        assert.equal(
            await stillPending(rename, 700),
            false,
            "an ordinary read must not hold a project name hostage"
        );
        await rename;
    } finally {
        await seeded.restore();
        await reader.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

// ── A label row that is DELETED mid-lock refuses (round 11, finding 2) ───────
//
// Round 10 pinned the labels with FOR SHARE, which stops a RENAME. It did not
// stop a DELETE. `TimeEntry_costCodeId_fkey` is ON DELETE SET NULL, so a cost
// code deleted between the entry query and the moment the locks are taken
// commits happily: the FOR SHARE then finds no row, and the `??` fallback
// quietly reused the code the first query had joined — freezing a CSV that no
// longer matched committed data.
//
// The interleave is staged for real, at the exact instant it matters: the
// export runs against a PROXY of the transaction client whose
// `timeEntry.findMany` commits the delete on a SECOND connection before it
// returns. So the loader has read the entries, has not yet taken its label
// locks, and the delete is already committed — which is the race, not a
// simulation of it.

/**
 * The caller's transaction client, with ONE seam: the first `timeEntry.findMany`
 * runs `between()` after the query and before handing the rows back.
 *
 * Everything else passes through bound to the real client — the loader issues
 * raw SQL, settings reads and roster reads through it and all of them have to
 * be the genuine article for this to be a test of the loader.
 */
function clientWithInterleave(tx: unknown, between: () => Promise<void>) {
    let fired = false;
    const target = tx as Record<string, unknown>;
    return new Proxy(target, {
        get(_t, prop, receiver) {
            if (prop === "timeEntry") {
                const real = target.timeEntry as { findMany: (args: unknown) => Promise<unknown> };
                return new Proxy(real, {
                    get(_r, method) {
                        if (method !== "findMany") {
                            const value = (real as Record<string, unknown>)[method as string];
                            return typeof value === "function" ? value.bind(real) : value;
                        }
                        return async (args: unknown) => {
                            const rows = await real.findMany(args);
                            if (!fired) {
                                fired = true;
                                await between();
                            }
                            return rows;
                        };
                    },
                });
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

test("a cost code DELETED between the entry read and the lock REFUSES", { skip }, async () => {
    const { loadGustoExport, isLabelRowMissingError } = await import("../src/lib/gusto-export-db");
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const deleter = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(reader, "ccdelete");

    try {
        // The control FIRST: this export is perfectly good, and it prints the
        // cost code. Without it a later refusal proves nothing about deletion.
        const before = await loadGustoExport(PERIOD_START, PERIOD_END, EXPORT_OPTIONS);
        assert.ok(before.detailCsv.includes("01-ORIG"), "the cost code really is a column of this file");

        await assert.rejects(
            () =>
                reader.$transaction(
                    async (tx) => {
                        const client = clientWithInterleave(tx, async () => {
                            // Committed on ANOTHER connection, after the entries
                            // were read and before the labels are locked. The FK
                            // is ON DELETE SET NULL, so this succeeds and the
                            // entry stops pointing at the code.
                            await deleter.$executeRawUnsafe(
                                `DELETE FROM "CostCode" WHERE "id" = $1`,
                                seeded.costCodeId
                            );
                        });
                        return loadGustoExport(PERIOD_START, PERIOD_END, {
                            ...EXPORT_OPTIONS,
                            client: client as never,
                        });
                    },
                    { timeout: 30_000 }
                ),
            (error: Error) => isLabelRowMissingError(error) && /project or cost code/.test(error.message),
            "a deleted label must refuse the lock, not freeze the stale code"
        );

        // THE PRE-FIX SHAPE, stated as a fact about the data: the code the old
        // fallback would have frozen is not what the database says any more.
        const after = await loadGustoExport(PERIOD_START, PERIOD_END, EXPORT_OPTIONS);
        assert.ok(
            !after.detailCsv.includes("01-ORIG"),
            "committed state no longer has that code — freezing it would have been a lie"
        );
    } finally {
        await seeded.restore();
        await reader.$disconnect().catch(() => {});
        await deleter.$disconnect().catch(() => {});
    }
});

test("an entry RE-CODED between the two reads refuses too — it is not only deletion", { skip }, async () => {
    // The guard compares the foreign keys, not just the existence of the rows,
    // so a re-code lands in the same refusal. Same seam, a different write.
    const { loadGustoExport, isLabelRowMissingError } = await import("../src/lib/gusto-export-db");
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(reader, "recode");
    const otherId = "label-costcode-recode-other";

    try {
        await reader.$executeRawUnsafe(
            `INSERT INTO "CostCode" ("id","code","name","updatedAt") VALUES ($1,'02-OTHER','Other',now())`,
            otherId
        );

        await assert.rejects(
            () =>
                reader.$transaction(
                    async (tx) => {
                        const client = clientWithInterleave(tx, async () => {
                            await writer.$executeRawUnsafe(
                                `UPDATE "TimeEntry" SET "costCodeId" = $1 WHERE "id" = $2`,
                                otherId,
                                `label-entry-recode`
                            );
                        });
                        return loadGustoExport(PERIOD_START, PERIOD_END, {
                            ...EXPORT_OPTIONS,
                            client: client as never,
                        });
                    },
                    { timeout: 30_000 }
                ),
            (error: Error) => isLabelRowMissingError(error)
        );
    } finally {
        await reader.$executeRawUnsafe(`DELETE FROM "CostCode" WHERE "id" = $1`, otherId).catch(() => {});
        await seeded.restore();
        await reader.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("an UNDISTURBED export still succeeds — the guard is not a blanket refusal", { skip }, async () => {
    // THE CONTROL for both refusals above: the same transaction shape, the same
    // seam, no concurrent write.
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(reader, "undisturbed");

    try {
        const result = await reader.$transaction(async (tx) => {
            const client = clientWithInterleave(tx, async () => {});
            return loadGustoExport(PERIOD_START, PERIOD_END, { ...EXPORT_OPTIONS, client: client as never });
        });
        assert.ok(result.detailCsv.includes("01-ORIG"));
        assert.ok(result.detailCsv.includes("ORIGINAL PROJECT"));
    } finally {
        await seeded.restore();
        await reader.$disconnect().catch(() => {});
    }
});

test("the FK actions this reasoning rests on are what the database actually has", { skip }, async () => {
    // The refusal above is needed because costCodeId is ON DELETE SET NULL. The
    // project side is claimed safe because projectId is RESTRICT — a claim about
    // a constraint three files away, which is exactly the kind that stops being
    // true quietly. Asserted against the live catalog instead.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        const rows = (await db.$queryRawUnsafe(
            `SELECT conname, confdeltype::text AS action FROM pg_constraint
              WHERE conname IN ('TimeEntry_costCodeId_fkey','TimeEntry_projectId_fkey') ORDER BY conname`
        )) as Array<{ conname: string; action: string }>;
        assert.deepEqual(rows, [
            // 'n' = SET NULL: a deleted cost code detaches the punch, which is
            // the whole reason the verify step exists.
            { conname: "TimeEntry_costCodeId_fkey", action: "n" },
            // 'r' = RESTRICT: a project with hours cannot be deleted at all.
            { conname: "TimeEntry_projectId_fkey", action: "r" },
        ]);
    } finally {
        await db.$disconnect().catch(() => {});
    }
});

test("a project with hours CANNOT be deleted — the RESTRICT this relies on is real", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db, "projrestrict");
    try {
        await assert.rejects(
            () => db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, seeded.projectId),
            /foreign key|violates/i,
            "so the project half of the label check can never be tripped by a delete"
        );
    } finally {
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});
