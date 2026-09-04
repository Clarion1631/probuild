/**
 * The $0-rate guard on manual time-entry creation, against a REAL database.
 *
 * tests/time-expense-core-guards.test.ts proves the PREDICATE (zeroLaborBlocks
 * agrees with zeroRateBlocks) and the WIRING (the owner read is not behind a
 * branch, the block is escapable only by an explicit acknowledgement). Neither
 * shows what actually lands in the table, and the regression this replaced was
 * exactly that: a completed, unflagged, $0 TimeEntry ROW for an hourly crew
 * member with no rate. So this drives the real
 * `createTimeEntryFromStoredRatesCore` against Postgres and then reads the row
 * back.
 *
 * Opt-in by URL, like the other DB tests here: a normal unit run must never be
 * able to touch a developer database. The migrations CI job supplies the URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { ZERO_RATE_REVIEW_NOTE, zeroRateManagerMessage } from "../src/lib/pay-rate-guard";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

const DAY = "2026-08-25";
const HOURS = 4;

type Fixture = { clientId: string; projectId: string; userIds: string[] };

type Owner = { key: string; payType: string; hourlyRate: number; role?: string };

async function seed(db: PrismaClient, tag: string, owners: Owner[]): Promise<Fixture> {
    const client = await db.client.create({ data: { name: `Zero Rate ${tag}`, initials: "ZR" } });
    const project = await db.project.create({ data: { name: `Zero Rate Job ${tag}`, clientId: client.id } });
    const userIds: string[] = [];
    for (const owner of owners) {
        const id = `zero-rate-${owner.key}-${tag}`;
        await db.user.create({
            data: {
                id,
                // NOT a @goldentouchremodeling.com address: isSalariedOwner()
                // falls back to the PAYROLL_SALARIED_EMAILS list when payType is
                // null, and a real staff address would exempt the hourly cases
                // by the back door.
                email: `${id}@example.test`,
                name: `Zero Rate ${owner.key}`,
                role: owner.role ?? "FIELD_CREW",
                status: "ACTIVATED",
                payType: owner.payType,
                hourlyRate: owner.hourlyRate,
                burdenRate: 5,
            },
        });
        userIds.push(id);
    }
    return { clientId: client.id, projectId: project.id, userIds };
}

async function cleanup(db: PrismaClient, fixture: Fixture) {
    const drop = (run: () => Promise<unknown>) => run().catch(() => {});
    await drop(() => db.timeEntry.deleteMany({ where: { userId: { in: fixture.userIds } } }));
    await drop(() => db.project.deleteMany({ where: { id: fixture.projectId } }));
    await drop(() => db.client.deleteMany({ where: { id: fixture.clientId } }));
    await drop(() => db.user.deleteMany({ where: { id: { in: fixture.userIds } } }));
}

test("an HOURLY crew member with no rate cannot be given a manual entry at all", { skip }, async () => {
    const { createTimeEntryFromStoredRatesCore } = await import("../src/lib/time-expense-core");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const fixture = await seed(db, `refused-${Date.now()}`, [{ key: "hourly", payType: "HOURLY", hourlyRate: 0 }]);
    const [userId] = fixture.userIds;
    try {
        await assert.rejects(
            () =>
                createTimeEntryFromStoredRatesCore(
                    { projectId: fixture.projectId, userId, date: DAY, durationHours: HOURS },
                    "zero-rate-db"
                ),
            (error: unknown) => {
                // The MANAGER-facing wording: a manual create is always an
                // office action, so it names where to go and fix the rate.
                assert.equal((error as Error).message, zeroRateManagerMessage("Zero Rate hourly"));
                return true;
            }
        );

        // The part a predicate test cannot reach: the transaction rolled back
        // and there is no $0 row.
        assert.equal(await db.timeEntry.count({ where: { userId } }), 0, "no $0 shift was booked");
    } finally {
        await cleanup(db, fixture);
        await db.$disconnect();
    }
});

test("acknowledgeZeroRate books the $0 entry and FLAGS it for payroll", { skip }, async () => {
    // The office's deliberate way out. It is not a bypass: needsReview is what
    // stops the export running past a shift nobody was paid for.
    const { createTimeEntryFromStoredRatesCore } = await import("../src/lib/time-expense-core");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const fixture = await seed(db, `ack-${Date.now()}`, [{ key: "hourly", payType: "HOURLY", hourlyRate: 0 }]);
    const [userId] = fixture.userIds;
    try {
        const created = await createTimeEntryFromStoredRatesCore(
            {
                projectId: fixture.projectId,
                userId,
                date: DAY,
                durationHours: HOURS,
                acknowledgeZeroRate: true,
            },
            "zero-rate-db"
        );

        const row = await db.timeEntry.findUniqueOrThrow({
            where: { id: created.id },
            select: { laborCost: true, burdenCost: true, durationHours: true, needsReview: true, reviewReason: true },
        });
        assert.equal(Number(row.laborCost), 0, "priced from the stored $0 rate, not from anything the caller said");
        assert.equal(Number(row.burdenCost), HOURS * 5);
        assert.equal(row.durationHours, HOURS);
        assert.equal(row.needsReview, true, "an acknowledged $0 shift is never silent");
        assert.equal(row.reviewReason, ZERO_RATE_REVIEW_NOTE);
    } finally {
        await cleanup(db, fixture);
        await db.$disconnect();
    }
});

test("a SALARIED owner's $0 labor is correct, so it is neither blocked nor flagged", { skip }, async () => {
    // CJ and Richard are MANAGERs in ProBuild and salaried in Gusto: their $0
    // hourly rate is the right answer, and blocking them would leave punches
    // nobody can close.
    const { createTimeEntryFromStoredRatesCore } = await import("../src/lib/time-expense-core");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const fixture = await seed(db, `salary-${Date.now()}`, [
        { key: "salaried", payType: "SALARY", hourlyRate: 0, role: "MANAGER" },
    ]);
    const [userId] = fixture.userIds;
    try {
        const created = await createTimeEntryFromStoredRatesCore(
            { projectId: fixture.projectId, userId, date: DAY, durationHours: HOURS },
            "zero-rate-db"
        );
        const row = await db.timeEntry.findUniqueOrThrow({
            where: { id: created.id },
            select: { laborCost: true, needsReview: true, reviewReason: true },
        });
        assert.equal(Number(row.laborCost), 0);
        assert.equal(row.needsReview, false, "a salaried $0 is not a payroll exception");
        assert.equal(row.reviewReason, null);
    } finally {
        await cleanup(db, fixture);
        await db.$disconnect();
    }
});

test("the guard is not a blanket refusal — a real rate still prices and stores", { skip }, async () => {
    // The control. Without it every assertion above is satisfied by a core that
    // refuses, or flags, everything.
    const { createTimeEntryFromStoredRatesCore } = await import("../src/lib/time-expense-core");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const fixture = await seed(db, `paid-${Date.now()}`, [{ key: "paid", payType: "HOURLY", hourlyRate: 25 }]);
    const [userId] = fixture.userIds;
    try {
        const created = await createTimeEntryFromStoredRatesCore(
            { projectId: fixture.projectId, userId, date: DAY, durationHours: HOURS },
            "zero-rate-db"
        );
        const row = await db.timeEntry.findUniqueOrThrow({
            where: { id: created.id },
            select: { laborCost: true, burdenCost: true, needsReview: true },
        });
        assert.equal(Number(row.laborCost), HOURS * 25);
        assert.equal(Number(row.burdenCost), HOURS * 5);
        assert.equal(row.needsReview, false);
    } finally {
        await cleanup(db, fixture);
        await db.$disconnect();
    }
});

test("a caller that computes its OWN $0 labor cost is refused too", { skip }, async () => {
    // The actual PR #441 regression, end to end. The guard used to run only for
    // callers that asked to be priced from stored rates, so the MCP `log_time`
    // tool — which did its own arithmetic from an unlocked read of the crew
    // list — could book a completed $0 entry for an hourly member with a REAL
    // rate on file, and neither the block nor the review flag fired.
    const { createTimeEntryCore } = await import("../src/lib/time-expense-core");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const fixture = await seed(db, `caller-cost-${Date.now()}`, [{ key: "paid", payType: "HOURLY", hourlyRate: 30 }]);
    const [userId] = fixture.userIds;
    try {
        await assert.rejects(
            () =>
                createTimeEntryCore(
                    {
                        projectId: fixture.projectId,
                        userId,
                        date: DAY,
                        durationHours: HOURS,
                        laborCost: 0,
                        burdenCost: 0,
                    },
                    "zero-rate-db"
                ),
            (error: unknown) => {
                assert.equal((error as Error).message, zeroRateManagerMessage("Zero Rate paid"));
                return true;
            },
            "the rate is $30/h — only the RESULT is $0, which is what zeroLaborBlocks asks about"
        );
        assert.equal(await db.timeEntry.count({ where: { userId } }), 0);
    } finally {
        await cleanup(db, fixture);
        await db.$disconnect();
    }
});
