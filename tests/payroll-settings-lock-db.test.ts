/**
 * TWO REAL CONNECTIONS, contending over the payroll export's NON-entry inputs.
 *
 * tests/gusto-export-consistency.test.ts pins the SHAPE from a recording fake:
 * which client each read goes out on, and in what order. It cannot show that
 * PostgreSQL actually holds a concurrent writer off the way the code assumes.
 * This does, on a disposable database.
 *
 * What it pins:
 *
 *  1. `loadGustoExport`, running inside a transaction, takes FOR SHARE on the
 *     CompanySettings and Integration rows — so a company-time-zone change or a
 *     Gusto employee-mapping save committed while the export is mid-read BLOCKS
 *     until it finishes, rather than landing between the export's first read and
 *     its entry read. That window is not cosmetic: the zone decides which
 *     company-local day (and therefore which workweek, and therefore how much of
 *     the period is overtime) each punch falls in, and lockPayrollPeriod freezes
 *     a hash over the result.
 *
 *  1b. THE Integration ROW MAY NOT EXIST YET, and `FOR SHARE` cannot lock a
 *     row's absence. On a database that has never saved an integration the
 *     export's row lock is a silent no-op, so `saveGustoSettings` could insert
 *     the FIRST employee mapping between the export's read and the lock's
 *     COMMIT — and lockPayrollPeriod would freeze a hash built without a
 *     mapping that was already committed. The export therefore takes the
 *     SAME advisory key the saver takes, which covers absence as well as
 *     presence.
 * *  2. `saveGustoSettings` / `saveQBSettings` serialise against each other on one
 *     advisory-lock key, so two savers of DIFFERENT keys cannot each merge into
 *     the same stale blob and have the second overwrite the first. The two share
 *     one encrypted row, so a lost write there disconnects an integration.
 *
 * Opt-in by URL, like every other DB test here: a normal unit run must never be
 * able to touch a developer database. The migrations CI job supplies the URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-payroll-settings-lock";
// The app's prisma singleton (reached by saveGustoSettings below) refuses a URL
// without pgbouncer=true — that guard is production safety, so it is satisfied
// rather than weakened.
if (databaseUrl && !process.env.DATABASE_URL?.includes("pgbouncer=true")) {
    const url = new URL(databaseUrl);
    url.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = url.toString();
}

const TZ = "America/Los_Angeles";
const OTHER_TZ = "America/New_York";
const PERIOD_START = new Date("2026-08-17T07:00:00.000Z");
const PERIOD_END = new Date("2026-08-31T07:00:00.000Z");

/** Resolves true once `promise` has not settled for `ms` — i.e. it is genuinely blocked. */
function stillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const marker = Symbol("pending");
    return Promise.race([
        promise.then(() => false),
        new Promise((resolve) => setTimeout(() => resolve(marker), ms)).then((v) => v === marker),
    ]) as Promise<boolean>;
}

/**
 * Put the two singleton rows in a known state and hand back a restorer.
 *
 * RESTORED, not deleted: both rows are shared with every other test in this CI
 * job, and removing CompanySettings would change what they see.
 */
async function seedSettings(db: PrismaClient, mappings: Record<string, string>) {
    const { encryptObject } = await import("../src/lib/crypto");
    const priorCompany = await db.companySettings.findUnique({ where: { id: "singleton" } });
    const priorIntegration = await db.integration.findUnique({ where: { id: "system_settings" } });

    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", timeZone: TZ },
        update: { timeZone: TZ },
    });
    const settings = encryptObject({ gusto: { connected: true, employeeMappings: mappings } });
    await db.integration.upsert({
        where: { id: "system_settings" },
        create: { id: "system_settings", settings },
        update: { settings },
    });

    return async () => {
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
    };
}

test("the export's FOR SHARE blocks a concurrent company time-zone change", { skip }, async () => {
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const restore = await seedSettings(reader, {});

    try {
        // Connection A: the export, inside a transaction, HOLDING after its read
        // — exactly the window lockPayrollPeriod occupies between recomputing
        // the CSVs and committing the frozen hash.
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let sawZone: string | null = null;

        const exporting = reader.$transaction(
            async (tx) => {
                const result = await loadGustoExport(PERIOD_START, PERIOD_END, {
                    client: tx,
                    startKey: "2026-08-17",
                    endKey: "2026-08-31",
                });
                sawZone = result.timeZone;
                await held;
            },
            { timeout: 30_000 }
        );

        // Let A actually reach and pass its locks.
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(sawZone, TZ, "the export read the zone it is about to hash a period in");

        // Connection B: somebody changes the company time zone. It must WAIT.
        const zoneChange = writer.$executeRawUnsafe(
            `UPDATE "CompanySettings" SET "timeZone" = $1 WHERE "id" = 'singleton'`,
            OTHER_TZ
        );
        assert.equal(
            await stillPending(zoneChange, 1_000),
            true,
            "a zone change must block while an export is mid-read — otherwise the CSV mixes two zones"
        );

        release();
        await exporting;
        await zoneChange;

        const after = await reader.companySettings.findUnique({ where: { id: "singleton" } });
        assert.equal(after?.timeZone, OTHER_TZ, "and it lands once the export is done");
    } finally {
        await restore();
        await reader.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("the export's FOR SHARE blocks a concurrent Gusto mapping save", { skip }, async () => {
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    const { saveGustoSettings, getGustoSettings } = await import("../src/lib/integration-store");
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const restore = await seedSettings(reader, { "u-before": "GUSTO-BEFORE" });

    try {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let sawMapping: string | undefined;

        const exporting = reader.$transaction(
            async (tx) => {
                const result = await loadGustoExport(PERIOD_START, PERIOD_END, {
                    client: tx,
                    startKey: "2026-08-17",
                    endKey: "2026-08-31",
                });
                // The mappings this export hashed, read back through the same
                // transaction so it is the value the lock is holding.
                sawMapping = (await getGustoSettings(tx)).employeeMappings?.["u-before"];
                assert.equal(typeof result.exportHash, "string");
                await held;
            },
            { timeout: 30_000 }
        );

        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(sawMapping, "GUSTO-BEFORE");

        // The real saver, on the app's own client (a different connection).
        const save = saveGustoSettings({ employeeMappings: { "u-after": "GUSTO-AFTER" } });
        assert.equal(
            await stillPending(save, 1_000),
            true,
            "remapping whose hours go to which Gusto employee must not land mid-export"
        );

        release();
        await exporting;
        await save;

        assert.equal(
            (await getGustoSettings()).employeeMappings?.["u-after"],
            "GUSTO-AFTER",
            "and it lands once the export is done"
        );
    } finally {
        await restore();
        await reader.$disconnect().catch(() => {});
    }
});

test("the export fences a FIRST-EVER mapping save, with NO Integration row to lock", { skip }, async () => {
    // The round-34 finding, exactly. Before the fix the only fence on this row
    // was `SELECT ... FOR SHARE`, and there is no row to lock here: the
    // statement matched nothing, held nothing, and reported nothing wrong. The
    // saver serialises on its own advisory key rather than on this
    // transaction, so it was free to INSERT the first mapping after the export
    // had read "no mappings" and before lockPayrollPeriod committed the hash.
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    const { saveGustoSettings, getGustoSettings } = await import("../src/lib/integration-store");
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const restore = await seedSettings(reader, {});

    try {
        // THE SETUP THAT MATTERS: no Integration row at all, committed before
        // the export starts. This is a fresh install, or any company that has
        // not connected an integration yet.
        await reader.integration.delete({ where: { id: "system_settings" } }).catch(() => {});
        assert.equal(
            await reader.integration.findUnique({ where: { id: "system_settings" } }),
            null,
            "the row really is absent — without this the FOR SHARE would be doing the work and this test would prove nothing"
        );

        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let sawMappings: Record<string, string> | undefined;

        const exporting = reader.$transaction(
            async (tx) => {
                const result = await loadGustoExport(PERIOD_START, PERIOD_END, {
                    client: tx,
                    startKey: "2026-08-17",
                    endKey: "2026-08-31",
                });
                assert.equal(typeof result.exportHash, "string");
                sawMappings = (await getGustoSettings(tx)).employeeMappings;
                await held;
            },
            { timeout: 30_000 }
        );

        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(sawMappings, undefined, "the export hashed a period with no mappings at all");

        // The first save this database has ever seen. It must WAIT, even though
        // there is nothing for a row lock to hold.
        const save = saveGustoSettings({ connected: true, employeeMappings: { "u-first": "GUSTO-FIRST" } });
        assert.equal(
            await stillPending(save, 1_000),
            true,
            "the FIRST mapping save must block on the export's advisory lock — FOR SHARE cannot lock an absent row"
        );

        release();
        await exporting;
        await save;

        // And it lands afterwards, so the fence delays rather than loses it.
        assert.equal((await getGustoSettings()).employeeMappings?.["u-first"], "GUSTO-FIRST");
    } finally {
        await restore();
        await reader.$disconnect().catch(() => {});
    }
});

test("the export takes the SAME key the saver takes — not merely 'an' advisory lock", { skip }, async () => {
    // The mirror of "a save WAITS for the integration advisory lock" below: hold
    // integration-store's exact key on one connection and prove the EXPORT
    // blocks on it. A fix that invented its own key would pass the test above
    // (the saver and the export would still serialise with each other) and
    // would silently stop serialising with every other writer of that row.
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    const { INTEGRATION_LOCK_KEY } = await import("../src/lib/integration-store");
    const holder = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const restore = await seedSettings(holder, {});

    try {
        assert.equal(INTEGRATION_LOCK_KEY, "integration:system_settings", "the key the saver takes");
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const holding = holder.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, INTEGRATION_LOCK_KEY);
                await held;
            },
            { timeout: 30_000 }
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        const exporting = reader.$transaction(
            async (tx) =>
                loadGustoExport(PERIOD_START, PERIOD_END, {
                    client: tx,
                    startKey: "2026-08-17",
                    endKey: "2026-08-31",
                }),
            { timeout: 30_000 }
        );
        assert.equal(
            await stillPending(exporting, 1_000),
            true,
            "the export must serialise on integration-store's own key"
        );

        release();
        await holding;
        assert.equal(typeof (await exporting).exportHash, "string", "and it completes once the key is free");
    } finally {
        await restore();
        await holder.$disconnect().catch(() => {});
        await reader.$disconnect().catch(() => {});
    }
});

test("a save WAITS for the integration advisory lock", { skip }, async () => {
    const { saveGustoSettings } = await import("../src/lib/integration-store");
    const holder = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const restore = await seedSettings(holder, {});

    try {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Hold the EXACT key the store uses. If the saver ever stopped taking it
        // — or took a different one — this would not block, and two savers would
        // be back to merging into the same stale blob.
        const holding = holder.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(
                    `SELECT pg_advisory_xact_lock(hashtext($1))`,
                    "integration:system_settings"
                );
                await held;
            },
            { timeout: 30_000 }
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        const save = saveGustoSettings({ companyId: "co-waited" });
        assert.equal(await stillPending(save, 1_000), true, "the saver must serialise on that key");

        release();
        await holding;
        await save;
    } finally {
        await restore();
        await holder.$disconnect().catch(() => {});
    }
});

test("concurrent Gusto and QuickBooks saves BOTH persist — neither clobbers the other", { skip }, async () => {
    const { saveGustoSettings, saveQBSettings, getIntegrationSettings } = await import(
        "../src/lib/integration-store"
    );
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const restore = await seedSettings(db, {});

    try {
        // Round 0 starts with NO ROW AT ALL — the fresh-install case, and the
        // one FOR UPDATE cannot cover on its own: it can lock a row, never a
        // row's absence, so two concurrent first-time connects both read null,
        // both build a document from nothing, and the second wins outright. The
        // advisory lock is what makes this round survivable.
        await db.integration.delete({ where: { id: "system_settings" } }).catch(() => {});

        // Then repeated with the row present, interleaved in both directions:
        // the two integrations share ONE encrypted document, so an unserialised
        // read-modify-write loses whichever save read first. Every round writes a
        // distinct value to a DIFFERENT key, so a survivor check is unambiguous.
        //
        // This is an end-to-end SURVIVOR check, not the serialisation proof —
        // two racers may simply fail to interleave on a given run. The
        // deterministic proof that a saver waits is the advisory-lock test
        // above; removing that lock fails it every time, while this one can
        // still pass. Both are here on purpose.
        for (let round = 0; round < 10; round += 1) {
            const gusto = `co-${round}`;
            const realm = `realm-${round}`;
            await Promise.all(
                round % 2 === 0
                    ? [saveGustoSettings({ companyId: gusto }), saveQBSettings({ realmId: realm })]
                    : [saveQBSettings({ realmId: realm }), saveGustoSettings({ companyId: gusto })]
            );

            const settings = await getIntegrationSettings();
            assert.equal(settings.gusto?.companyId, gusto, `round ${round}: the Gusto save survived`);
            assert.equal(settings.quickbooks?.realmId, realm, `round ${round}: the QuickBooks save survived`);
        }
    } finally {
        await restore();
        await db.$disconnect().catch(() => {});
    }
});
