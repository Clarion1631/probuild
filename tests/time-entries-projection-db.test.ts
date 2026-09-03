/**
 * GET /api/time-entries returns an ALLOWLIST, per audience.
 *
 * The hole (round 8, finding 1). The route serialized the whole Prisma
 * TimeEntry model with `user: true` — the entry's owner as a complete User row.
 * So a FIELD_CREW member, whose query is scoped to their own entries, received
 * their own `pinCode` BCRYPT HASH along with `hourlyRate`, `burdenRate` and
 * `payType`; and a MANAGER, whose query is not scoped at all, received that for
 * every person in the company, plus `laborCost` and `burdenCost` on every punch.
 *
 * A password-equivalent hash has no audience. Pay data has a narrow one.
 *
 * Driven as REAL requests against the REAL handler: the crew member and the
 * admin each get a genuine mobile Bearer token, so nothing about the auth path
 * is stubbed and the response is the one a phone would receive.
 *
 * ASSERTED AS AN ALLOWLIST, deliberately, not as a list of forbidden names. A
 * denylist passes for every column nobody has thought of yet — the next token,
 * hash or salary field ships by default and the test stays green.
 *
 * Opt-in by URL, like every other DB test here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-time-entry-projection";
if (databaseUrl && !process.env.DATABASE_URL?.includes("pgbouncer=true")) {
    const url = new URL(databaseUrl);
    url.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = url.toString();
}

const SUFFIX = "proj";
const CLIENT_ID = `te-proj-client-${SUFFIX}`;
const PROJECT_ID = `te-proj-project-${SUFFIX}`;
const ENTRY_ID = `te-proj-entry-${SUFFIX}`;
const CREW_EMAIL = `te-proj-crew-${SUFFIX}@example.test`;
const ADMIN_EMAIL = `te-proj-admin-${SUFFIX}@example.test`;

async function seed(db: PrismaClient) {
    await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = $1`, ENTRY_ID).catch(() => {});
    await db.user.deleteMany({ where: { email: { in: [CREW_EMAIL, ADMIN_EMAIL] } } });
    await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, PROJECT_ID).catch(() => {});
    await db.$executeRawUnsafe(`DELETE FROM "Client" WHERE "id" = $1`, CLIENT_ID).catch(() => {});

    const crew = await db.user.create({
        data: {
            name: "Alex Crew",
            email: CREW_EMAIL,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 30,
            burdenRate: 5,
            // A BCRYPT-SHAPED value. Not a real hash — the point is that
            // whatever is in this column must not come back out.
            pinCode: "$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV",
        },
        select: { id: true, role: true, email: true },
    });
    const admin = await db.user.create({
        data: { name: "Ada Admin", email: ADMIN_EMAIL, role: "ADMIN", status: "ACTIVATED" },
        select: { id: true, role: true, email: true },
    });

    await db.$executeRawUnsafe(`INSERT INTO "Client" ("id","name","initials") VALUES ($1,'Proj','P')`, CLIENT_ID);
    await db.$executeRawUnsafe(
        `INSERT INTO "Project" ("id","name","clientId","updatedAt") VALUES ($1,'Proj Job',$2,now())`,
        PROJECT_ID,
        CLIENT_ID
    );
    // laborCost / burdenCost are populated so "the crew response has no costs"
    // is a statement about the projection and not about an empty column.
    await db.$executeRawUnsafe(
        `INSERT INTO "TimeEntry"
           ("id","userId","projectId","startTime","endTime","durationHours","laborCost","burdenCost","updatedAt")
         VALUES ($1,$2,$3,'2026-08-24T15:00:00Z'::timestamptz,'2026-08-24T23:00:00Z'::timestamptz,8,240,40,now())`,
        ENTRY_ID,
        crew.id,
        PROJECT_ID
    );

    return {
        crew,
        admin,
        restore: async () => {
            await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = $1`, ENTRY_ID).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, PROJECT_ID).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Client" WHERE "id" = $1`, CLIENT_ID).catch(() => {});
            await db.user.deleteMany({ where: { email: { in: [CREW_EMAIL, ADMIN_EMAIL] } } }).catch(() => {});
        },
    };
}

/** A REAL mobile token, so the handler runs its own authentication. */
async function requestAs(viewer: { id: string; role: string; email: string }) {
    const { signMobileToken } = await import("../src/lib/mobile-auth");
    const token = await signMobileToken(viewer as never, "pin");
    return new Request(`https://example.test/api/time-entries?projectId=${PROJECT_ID}`, {
        headers: { authorization: `Bearer ${token}` },
    });
}

/** Every key anywhere in the payload, so a nested leak cannot hide behind a top-level allowlist. */
function deepKeys(value: unknown, into = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) deepKeys(item, into);
    } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            into.add(key);
            deepKeys(child, into);
        }
    }
    return into;
}

test("a FIELD_CREW response carries no costs, no rates and no credential hash", { skip }, async () => {
    const { GET } = await import("../src/app/api/time-entries/route");
    const { TIME_ENTRY_CREW_SELECT, TIME_ENTRY_OWNER_CREW_SELECT } = await import(
        "../src/lib/time-entry-projection"
    );
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db);

    try {
        const res = await GET(await requestAs(seeded.crew));
        assert.equal(res.status, 200);
        const body = (await res.json()) as Array<Record<string, unknown>>;
        assert.equal(body.length, 1, "the crew member sees their own punch");
        const [entry] = body;

        // THE ALLOWLIST. Every key on the entry has to be one the projection
        // names — anything else is a column that shipped because nobody
        // remembered to exclude it.
        const allowed = new Set([...Object.keys(TIME_ENTRY_CREW_SELECT), "user", "project", "costCode"]);
        const unexpected = Object.keys(entry).filter((key) => !allowed.has(key));
        assert.deepEqual(unexpected, [], "no key outside the crew projection");

        // The owner, likewise.
        assert.deepEqual(
            Object.keys(entry.user as Record<string, unknown>).sort(),
            Object.keys(TIME_ENTRY_OWNER_CREW_SELECT).sort(),
            "the owner is id + name, nothing else"
        );

        // And nothing anywhere in the payload, at any depth.
        const keys = deepKeys(body);
        for (const forbidden of ["pinCode", "hourlyRate", "burdenRate", "payType", "laborCost", "burdenCost"]) {
            assert.ok(!keys.has(forbidden), `${forbidden} must not appear anywhere in a crew response`);
        }

        // THE PRE-FIX CONTROL: the data really is there to leak. The old route
        // returned this row verbatim with `user: true`, so every one of the
        // names above was in the body.
        const raw = await db.timeEntry.findUniqueOrThrow({
            where: { id: ENTRY_ID },
            include: { user: true },
        });
        assert.equal(Number(raw.laborCost), 240, "the entry carries a real labor cost");
        assert.ok(raw.user.pinCode, "and the owner carries a real PIN hash");
        assert.equal(Number(raw.user.hourlyRate), 30);
    } finally {
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});

test("an ADMIN response carries the costs and rates — and still no credential hash", { skip }, async () => {
    const { GET } = await import("../src/app/api/time-entries/route");
    const { TIME_ENTRY_CREW_SELECT, TIME_ENTRY_PAY_SELECT, TIME_ENTRY_OWNER_PAY_SELECT } = await import(
        "../src/lib/time-entry-projection"
    );
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db);

    try {
        const res = await GET(await requestAs(seeded.admin));
        assert.equal(res.status, 200);
        const body = (await res.json()) as Array<Record<string, unknown>>;
        const entry = body.find((row) => row.id === ENTRY_ID);
        assert.ok(entry, "an admin sees everybody's punches, not just their own");

        // The financial audience gets the money.
        assert.equal(Number(entry.laborCost), 240);
        assert.equal(Number(entry.burdenCost), 40);
        const owner = entry.user as Record<string, unknown>;
        assert.equal(Number(owner.hourlyRate), 30, "and the rate it was derived from");
        assert.equal(owner.payType, "HOURLY");

        // Still an allowlist, just a wider one.
        const allowed = new Set([
            ...Object.keys(TIME_ENTRY_CREW_SELECT),
            ...Object.keys(TIME_ENTRY_PAY_SELECT),
            "user",
            "project",
            "costCode",
        ]);
        assert.deepEqual(Object.keys(entry).filter((key) => !allowed.has(key)), []);
        assert.deepEqual(
            Object.keys(owner).sort(),
            Object.keys(TIME_ENTRY_OWNER_PAY_SELECT).sort(),
            "the owner projection, exactly"
        );

        // THE ONE THING NOBODY GETS. "Only admins can see it" is not a reason to
        // serialize a password equivalent to a browser, a log or a proxy cache.
        assert.ok(!deepKeys(body).has("pinCode"), "a PIN hash has no audience at all");
    } finally {
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});

test("the two audiences really differ — the crew test is not just describing an empty row", { skip }, async () => {
    // Without this, "the crew response has no laborCost" would pass equally well
    // on a projection that returned nothing to anyone.
    const { timeEntryResponseKeys } = await import("../src/lib/time-entry-projection");
    const crew = new Set(timeEntryResponseKeys(false));
    const pay = timeEntryResponseKeys(true);
    const extra = pay.filter((key) => !crew.has(key));
    assert.deepEqual(extra.sort(), ["burdenCost", "invoiceId", "invoicedAt", "laborCost", "qbTimeActivityId"]);
    assert.ok(!crew.has("pinCode") && !pay.includes("pinCode"), "neither tier can name the hash");
});

test("a FIELD_CREW clock-IN response carries no money either", { skip }, async () => {
    // POST returned the created row verbatim (round 9, finding 2). A brand-new
    // punch has no laborCost yet, so the leak was smaller than the clock-out
    // one — but the SHAPE was the same whole-model serialization, and the next
    // column added to TimeEntry would have shipped through it. The allowlist
    // assertion is what makes that impossible rather than merely unlikely.
    const { POST } = await import("../src/app/api/time-entries/route");
    const { TIME_ENTRY_CREW_SELECT } = await import("../src/lib/time-entry-projection");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db);

    try {
        // A logistics job: the deliberate exception to the phase requirement,
        // so this test does not need a cost-code fixture to reach the response
        // it is actually about.
        await db.$executeRawUnsafe(`UPDATE "Project" SET "isLogistics" = true WHERE "id" = $1`, PROJECT_ID);

        // The crew member has to be able to reach the job.
        await db.$executeRawUnsafe(
            `INSERT INTO "ProjectAccess" ("id","userId","projectId") VALUES ($1,$2,$3)`,
            `te-proj-access-${SUFFIX}`,
            seeded.crew.id,
            PROJECT_ID
        );

        const { signMobileToken } = await import("../src/lib/mobile-auth");
        const token = await signMobileToken(seeded.crew as never, "pin");
        const res = await POST(
            new Request("https://example.test/api/time-entries", {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({
                    projectId: PROJECT_ID,
                    startTime: "2026-08-25T15:00:00.000Z",
                    rawNote: "Shop time, sorting stock",
                }),
            })
        );
        assert.equal(res.status, 200);
        const entry = (await res.json()) as Record<string, unknown>;
        assert.ok(entry.id, "a punch was created");

        const allowed = new Set(Object.keys(TIME_ENTRY_CREW_SELECT));
        assert.deepEqual(
            Object.keys(entry).filter((key) => !allowed.has(key)),
            [],
            "no key outside the crew projection"
        );
        for (const key of ["laborCost", "burdenCost", "invoiceId", "invoicedAt", "qbTimeActivityId"]) {
            assert.ok(!(key in entry), `${key} must not reach a crew clock-in response`);
        }

        // THE CONTROL: the stored row really does have those columns, so the
        // assertion above is about the projection and not about the model.
        const raw = await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id as string } });
        assert.ok("laborCost" in raw && "qbTimeActivityId" in raw);
        await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = $1`, entry.id as string);
    } finally {
        await db
            .$executeRawUnsafe(`DELETE FROM "ProjectAccess" WHERE "id" = $1`, `te-proj-access-${SUFFIX}`)
            .catch(() => {});
        await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "projectId" = $1`, PROJECT_ID).catch(() => {});
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});
