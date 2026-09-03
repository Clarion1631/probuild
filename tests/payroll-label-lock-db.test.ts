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
