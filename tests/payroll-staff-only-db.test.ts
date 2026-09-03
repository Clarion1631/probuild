/**
 * A CUSTOMER IS NOT AN EMPLOYEE.
 *
 * The hole (round 8, finding 2). /api/clients/[id]/invite creates portal
 * accounts with role CLIENT so a customer can sign in and watch their own
 * project, and the NextAuth signIn callback activates one on first Google
 * sign-in exactly like a crew member. Nothing between that invite and the Gusto
 * file then asked what ROLE an account held:
 *
 *  - the rates panel listed every ACTIVATED user, so the customer appeared
 *    there with a pay type and a rate waiting to be set;
 *  - the CSV importer loaded every user, and matches on EMAIL first and an
 *    exact full name second, so an import could set one HOURLY;
 *  - the export roster took every ACTIVATED user whose payType was HOURLY, so
 *    from then on they were a zero-hour row in EVERY pay period's file.
 *
 * One predicate now gates all of it — payrollEligibleUserWhere(), an ALLOWLIST
 * of the four staff roles. Each test below runs the real code against a real
 * database with an ACTIVATED CLIENT present, and carries the pre-fix control:
 * the same question asked the way it used to be asked, which still finds them.
 *
 * Opt-in by URL, like every other DB test here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-payroll-staff-only";
if (databaseUrl && !process.env.DATABASE_URL?.includes("pgbouncer=true")) {
    const url = new URL(databaseUrl);
    url.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = url.toString();
}

const TZ = "America/Los_Angeles";
const PERIOD_START = new Date("2026-08-17T07:00:00.000Z");
const PERIOD_END = new Date("2026-08-31T07:00:00.000Z");

/**
 * One ACTIVATED CLIENT and one ACTIVATED FIELD_CREW, both HOURLY.
 *
 * The customer is given payType HOURLY deliberately: that is the state the old
 * rates panel let somebody reach, and it is what put them on the export. Seeding
 * them with a null pay type would assert against a shape the bug never produced.
 */
async function seed(db: PrismaClient, suffix: string) {
    const clientEmail = `staff-only-customer-${suffix}@example.test`;
    const crewEmail = `staff-only-crew-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email: { in: [clientEmail, crewEmail] } } });

    const customer = await db.user.create({
        data: {
            name: "Dana Customer",
            email: clientEmail,
            role: "CLIENT",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 0,
        },
        select: { id: true, email: true },
    });
    const crew = await db.user.create({
        data: {
            name: "Alex Crew",
            email: crewEmail,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 30,
        },
        select: { id: true, email: true },
    });

    return {
        customer,
        crew,
        restore: async () => {
            await db.user.deleteMany({ where: { email: { in: [clientEmail, crewEmail] } } }).catch(() => {});
        },
    };
}

test("the rates panel roster excludes an activated CLIENT", { skip }, async () => {
    const { payrollEligibleUserWhere } = await import("../src/lib/payroll-config");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db, "roster");

    try {
        // EXACTLY the shape the roster route composes.
        const listed = await db.user.findMany({
            where: { AND: [payrollEligibleUserWhere(), { status: "ACTIVATED" }] },
            select: { id: true },
        });
        const ids = listed.map((row) => row.id);
        assert.ok(ids.includes(seeded.crew.id), "the crew member is on the payroll roster");
        assert.ok(!ids.includes(seeded.customer.id), "the customer is not");

        // THE PRE-FIX CONTROL: activation alone, which is what the route asked.
        const preFix = await db.user.findMany({ where: { status: "ACTIVATED" }, select: { id: true } });
        assert.ok(
            preFix.map((row) => row.id).includes(seeded.customer.id),
            "activation alone finds the customer — which is why the predicate exists"
        );
    } finally {
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});

test("the CSV importer cannot load an activated CLIENT to write a rate onto", { skip }, async () => {
    const { payrollEligibleUserWhere } = await import("../src/lib/payroll-config");
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db, "import");

    try {
        const importable = await db.user.findMany({ where: payrollEligibleUserWhere(), select: { id: true } });
        const ids = importable.map((row) => row.id);
        assert.ok(ids.includes(seeded.crew.id));
        assert.ok(!ids.includes(seeded.customer.id), "a customer is never a row the import may write to");

        // The pre-fix control: no predicate at all, which is what it did.
        const preFix = await db.user.findMany({ select: { id: true } });
        assert.ok(preFix.map((row) => row.id).includes(seeded.customer.id));

        // ...and the importer really composes it, so this is not a query only
        // the test knows about.
        const actions = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
        const fn = actions.slice(actions.indexOf("async function importableUsers()"));
        const body = fn.slice(0, fn.indexOf("\n}"));
        assert.match(body, /where: payrollEligibleUserWhere\(\)/);
    } finally {
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});

test("a rate write on an activated CLIENT is REFUSED", { skip }, async () => {
    const { applyRateChange } = await import("../src/lib/pay-rate-write");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db, "rate");

    try {
        const refused = await applyRateChange(
            { role: "ADMIN" },
            seeded.customer.id,
            { hourlyRate: "31.00", payType: "HOURLY" },
            db as never
        );
        assert.equal(refused.ok, false, "a customer cannot be given a pay rate");
        assert.equal((refused as { status: number }).status, 400);
        assert.match((refused as { error: string }).error, /not an employee/);

        // Nothing was written — the refusal is not a partial write.
        const after = await db.user.findUniqueOrThrow({
            where: { id: seeded.customer.id },
            select: { hourlyRate: true, payrollRevision: true },
        });
        assert.equal(Number(after.hourlyRate), 0);
        assert.equal(after.payrollRevision, 0);

        // THE CONTROL: the identical call against a crew member succeeds, so the
        // refusal above is about the role and not about the call.
        const allowed = await applyRateChange({ role: "ADMIN" }, seeded.crew.id, { hourlyRate: "31.00" }, db as never);
        assert.equal(allowed.ok, true);
        const crewAfter = await db.user.findUniqueOrThrow({
            where: { id: seeded.crew.id },
            select: { hourlyRate: true },
        });
        assert.equal(Number(crewAfter.hourlyRate).toFixed(2), "31.00");
    } finally {
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});

test("an activated HOURLY CLIENT never reaches the Gusto export roster", { skip }, async () => {
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    const { encryptObject } = await import("../src/lib/crypto");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

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

    const seeded = await seed(db, "export");
    try {
        const result = await loadGustoExport(PERIOD_START, PERIOD_END, {
            startKey: "2026-08-17",
            endKey: "2026-08-31",
            timeZone: TZ,
            client: db,
        });
        const rosterIds = result.employees.map((employee) => employee.user.id);
        assert.ok(rosterIds.includes(seeded.crew.id), "the zero-hour crew member is still on the file");
        assert.ok(!rosterIds.includes(seeded.customer.id), "the customer is not");
        // ...and not in the bytes either.
        assert.ok(!result.summaryCsv.includes(seeded.customer.email), "no customer row in the Gusto summary");
        assert.ok(result.summaryCsv.includes(seeded.crew.email), "the control: a real employee IS in it");

        // THE PRE-FIX CONTROL: the roster predicate the export used to run.
        const preFix = await db.user.findMany({
            where: { status: "ACTIVATED", payType: "HOURLY" },
            select: { id: true },
        });
        assert.ok(
            preFix.map((row) => row.id).includes(seeded.customer.id),
            "ACTIVATED + HOURLY alone puts the customer on every pay period's file"
        );
    } finally {
        await seeded.restore();
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
        await db.$disconnect().catch(() => {});
    }
});

test("a CLIENT with hours REFUSES the export rather than being paid or silently dropped", { skip }, async () => {
    // The other half of the roster, which is deliberately NOT filtered: the
    // detail CSV is built by walking the roster, so excluding a punched account
    // would delete real hours from the job-costing file instead of reporting a
    // problem. A portal account with time entries is a genuine fault — a mis-set
    // role, or a portal login that reached the crew API — so the export refuses
    // and names it.
    const { loadGustoExport, isNonStaffOnPayrollError } = await import("../src/lib/gusto-export-db");
    const { encryptObject } = await import("../src/lib/crypto");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

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

    const seeded = await seed(db, "punched");
    const clientId = "staff-only-client-punched";
    const projectId = "staff-only-project-punched";
    const entryId = "staff-only-entry-punched";
    try {
        await db.$executeRawUnsafe(
            `INSERT INTO "Client" ("id","name","initials") VALUES ($1,'Staff Only','SO')`,
            clientId
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "Project" ("id","name","clientId","updatedAt") VALUES ($1,'Staff Only Job',$2,now())`,
            projectId,
            clientId
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "TimeEntry" ("id","userId","projectId","startTime","endTime","durationHours","updatedAt")
             VALUES ($1,$2,$3,'2026-08-24T15:00:00Z'::timestamptz,'2026-08-24T23:00:00Z'::timestamptz,8,now())`,
            entryId,
            seeded.customer.id,
            projectId
        );

        await assert.rejects(
            () =>
                loadGustoExport(PERIOD_START, PERIOD_END, {
                    startKey: "2026-08-17",
                    endKey: "2026-08-31",
                    timeZone: TZ,
                    client: db,
                }),
            (error: Error) => isNonStaffOnPayrollError(error) && /not an employee/.test(error.message)
        );

        // THE CONTROL: with the same punch owned by the crew member instead, the
        // export builds — so the refusal is about the ROLE, not about the punch.
        await db.$executeRawUnsafe(`UPDATE "TimeEntry" SET "userId" = $1 WHERE "id" = $2`, seeded.crew.id, entryId);
        const built = await loadGustoExport(PERIOD_START, PERIOD_END, {
            startKey: "2026-08-17",
            endKey: "2026-08-31",
            timeZone: TZ,
            client: db,
        });
        assert.ok(built.summaryCsv.includes(seeded.crew.email));
    } finally {
        await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = $1`, entryId).catch(() => {});
        await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, projectId).catch(() => {});
        await db.$executeRawUnsafe(`DELETE FROM "Client" WHERE "id" = $1`, clientId).catch(() => {});
        await seeded.restore();
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
        await db.$disconnect().catch(() => {});
    }
});
