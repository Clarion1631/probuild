/**
 * The change-order tag race, against a REAL database, on real connections.
 *
 * tests/time-expense-core-guards.test.ts pins the SHAPE of this fix — that the
 * re-read happens inside `withPayrollWrite`, that the update pins `projectId`,
 * that both movers refuse a tagged entry. A source assertion cannot show that
 * PostgreSQL actually serializes the two writers the way the code assumes, or
 * that a refused tag leaves nothing behind. This file makes them contend.
 *
 * The bug: `tagTimeEntriesToChangeOrderCore` authorized from a copy of the rows
 * read BEFORE its transaction opened, and its `updateMany` named only the ids
 * and the billing columns. A logistics reroute committing in that window moved
 * an entry to another job and the tag still landed — the entry came out on job
 * B carrying a cost-plus change order belonging to job A, which is one job's
 * hours invoiced against another job's change order.
 *
 * Opt-in by URL, like the other DB tests here: a normal unit run must never be
 * able to touch a developer database. The migrations CI job supplies the URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { isTimeEntryTagConflictError } from "../src/lib/time-expense-core";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

const DAY = "2026-08-24";

/** Resolves once `promise` has not settled for `ms` — i.e. it is genuinely blocked. */
function stillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const marker = Symbol("pending");
    return Promise.race([
        promise.then(() => false),
        new Promise((resolve) => setTimeout(() => resolve(marker), ms)).then((v) => v === marker),
    ]) as Promise<boolean>;
}

type Seeded = {
    userId: string;
    clientId: string;
    projectA: string;
    projectB: string;
    costCodeId: string;
    estimateId: string;
    changeOrderId: string;
    entryId: string;
};

/**
 * Seeded through the Prisma CLIENT rather than raw SQL. The sibling
 * tests/time-entry-reassign-db.test.ts carries a comment about writing an
 * INSERT from the shape of a neighbouring one and naming a column that does not
 * exist; there are seven tables here, so the generated client answers "what is
 * required" instead of me guessing it seven times.
 */
async function seed(db: PrismaClient, tag: string): Promise<Seeded> {
    const userId = `co-tag-user-${tag}`;
    await db.user.create({
        data: {
            id: userId,
            email: `${userId}@example.test`,
            name: "Tag Race Crew",
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 25,
            burdenRate: 5,
        },
    });
    const client = await db.client.create({ data: { name: `Tag Race ${tag}`, initials: "TR" } });
    // A is the change order's job. B is a routable job the reroute moves to —
    // the two being DIFFERENT is the whole point of the pinned projectId.
    const projectA = await db.project.create({ data: { name: `Tag Race A ${tag}`, clientId: client.id } });
    const projectB = await db.project.create({ data: { name: `Tag Race B ${tag}`, clientId: client.id } });
    // CostCode.code is globally unique, so this cannot be the real 31-LOGISTICS
    // row: two runs of this file would collide on it, and a test that creates a
    // production cost code is a test that changes the app. The reroute's
    // predicate is what is under test, not which code it stamps.
    const costCode = await db.costCode.create({ data: { code: `31-LOGISTICS-${tag}`, name: "Logistics (test)" } });
    const estimate = await db.estimate.create({
        data: { title: `Tag Race ${tag}`, code: `EST-${tag}`, projectId: projectA.id, totalAmount: 0, balanceDue: 0 },
    });
    // COST_PLUS + Sent: the only shape resolveChangeOrder() accepts, so a
    // refusal in these tests is about the race and never about eligibility.
    const changeOrder = await db.changeOrder.create({
        data: {
            projectId: projectA.id,
            estimateId: estimate.id,
            code: `CO-${tag}`,
            title: "Tag Race CO",
            status: "Sent",
            pricingType: "COST_PLUS",
            markupPercent: 15,
        },
    });
    const entry = await db.timeEntry.create({
        data: {
            userId,
            projectId: projectA.id,
            startTime: new Date(`${DAY}T15:00:00Z`),
            endTime: new Date(`${DAY}T23:00:00Z`),
            durationHours: 8,
            laborCost: 200,
            burdenCost: 40,
        },
    });
    return {
        userId,
        clientId: client.id,
        projectA: projectA.id,
        projectB: projectB.id,
        costCodeId: costCode.id,
        estimateId: estimate.id,
        changeOrderId: changeOrder.id,
        entryId: entry.id,
    };
}

async function cleanup(db: PrismaClient, ids: Seeded) {
    const drop = (run: () => Promise<unknown>) => run().catch(() => {});
    await drop(() => db.timeEntry.deleteMany({ where: { id: ids.entryId } }));
    await drop(() => db.changeOrder.deleteMany({ where: { id: ids.changeOrderId } }));
    await drop(() => db.estimate.deleteMany({ where: { id: ids.estimateId } }));
    await drop(() => db.project.deleteMany({ where: { id: { in: [ids.projectA, ids.projectB] } } }));
    await drop(() => db.costCode.deleteMany({ where: { id: ids.costCodeId } }));
    await drop(() => db.client.deleteMany({ where: { id: ids.clientId } }));
    await drop(() => db.user.deleteMany({ where: { id: ids.userId } }));
}

/**
 * THE MOVERS' WRITE, verbatim.
 *
 * Neither real mover is callable from a test: PATCH
 * /api/time-entries/[id]/logistics wants a session or a mobile token, and
 * rerouteLogisticsEntry() wants a NextAuth session. Module mocking is not an
 * option either — CI pins Node 20, where `mock.module` corrupts the require
 * chain. So the write is reproduced here, through the SAME `withPayrollWrite`
 * helper and with the SAME predicate, and the first test below pins that copy
 * against both sources so it cannot drift into testing something the app does
 * not do.
 *
 * `hold` is the only addition: a real reroute commits immediately, but a race
 * decided by scheduling luck is a flaky test, so the caller says when this
 * transaction lets go.
 */
async function rerouteEntry(ids: Seeded, options: { hold?: Promise<void> } = {}): Promise<{ count: number }> {
    const { withPayrollWrite } = await import("../src/lib/payroll-period");
    return withPayrollWrite({ entryIds: [ids.entryId] }, async (tx) => {
        const db = tx as unknown as PrismaClient;
        const claim = await db.timeEntry.updateMany({
            where: { id: ids.entryId, invoiceId: null, invoicedAt: null, changeOrderId: null },
            data: {
                projectId: ids.projectB,
                costCodeId: ids.costCodeId,
                estimateItemId: null,
                routedFromProjectId: ids.projectA,
                routedAt: new Date(),
                routedById: ids.userId,
            },
        });
        if (options.hold) await options.hold;
        return claim;
    });
}

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const LOGISTICS_ROUTE = "src/app/api/time-entries/[id]/logistics/route.ts";
const ACTIONS = "src/lib/actions.ts";
const PIN = "invoiceId: null, invoicedAt: null, changeOrderId: null";
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");

test("the reroute predicate reproduced here is the one BOTH movers actually use", () => {
    // Deliberately NOT DB-gated. If the copy above drifts, the two race tests
    // stop describing the application and would still pass, so this runs on
    // every unit run, with or without a database.
    const route = read(LOGISTICS_ROUTE);
    const actions = read(ACTIONS);
    const reroute = actions.slice(
        actions.indexOf("export async function rerouteLogisticsEntry"),
        actions.indexOf("// ============ Payroll (Phase 5")
    );
    assert.ok(reroute.length > 500, "the reroute body is empty — the parser is matching nothing");

    assert.equal((route.match(literal(PIN)) ?? []).length, 1, "the route pins the tag in its one routing write");
    assert.equal(
        (reroute.match(literal(PIN)) ?? []).length,
        2,
        "both reroute writes pin the tag — the copy above reproduces one of them"
    );
    // Both go through the same lock protocol, which is what makes the two
    // transactions below contend on the SAME row lock rather than merely
    // interleaving in time.
    assert.match(route, /withPayrollWrite\(\{ entryIds: \[id\] \}/);
    assert.match(reroute, /withPayrollWriteForRoute\(\{ entryIds: \[entryId\] \}/);

    // The control: a predicate that is in NEITHER file must not match, or the
    // counts above would pass for the wrong reason.
    assert.equal((route.match(literal('invoiceId: null, invoicedAt: null, changeOrderId: "any"')) ?? []).length, 0);
});

test("CASE A — the tag wins the row lock; the reroute then finds the tag and refuses", { skip }, async () => {
    // Interleaving: the reroute REQUESTS the row lock second, and by the time it
    // gets it the entry carries a change order. Its `changeOrderId: null` pin is
    // what turns that into a refusal instead of a silent move that would strand
    // a cost-plus tag on the wrong job.
    const { tagTimeEntriesToChangeOrderCore } = await import("../src/lib/time-expense-core");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const blocker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const ids = await seed(db, `case-a-${Date.now()}`);
    try {
        // A third connection pins the row so the two contenders enter the lock
        // queue in a KNOWN order. Without it the winner is decided by scheduling
        // luck and this test would be asserting a coin flip.
        let releaseBlocker: () => void = () => {};
        const blocked = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const blocking = blocker.$transaction(
            async (tx) => {
                await tx.$queryRawUnsafe(`SELECT "id" FROM "TimeEntry" WHERE "id" = $1 FOR UPDATE`, ids.entryId);
                await blocked;
            },
            { timeout: 20_000 }
        );
        await new Promise((r) => setTimeout(r, 300));

        // The tag enters the queue first.
        const tagging = tagTimeEntriesToChangeOrderCore(
            { ids: [ids.entryId], changeOrderId: ids.changeOrderId },
            "case-a"
        );
        assert.equal(
            await stillPending(tagging, 600),
            true,
            "the tag must WAIT for the row lock — acquirePayrollLocks takes FOR UPDATE before the re-read"
        );

        // The reroute second. It is now provably behind the tag, not racing it.
        const rerouting = rerouteEntry(ids);
        assert.equal(await stillPending(rerouting, 600), true, "and the reroute waits behind the tag");

        releaseBlocker();
        await blocking;

        const tagged = await tagging;
        assert.deepEqual(tagged, { updated: 1 }, "the tag commits — it saw the row still on its own job");

        const claim = await rerouting;
        assert.equal(claim.count, 0, "the reroute's changeOrderId pin refuses a row that is now tagged");

        const after = await db.timeEntry.findUniqueOrThrow({
            where: { id: ids.entryId },
            select: { projectId: true, changeOrderId: true, isBillable: true, routedFromProjectId: true },
        });
        assert.equal(after.projectId, ids.projectA, "the entry did NOT move");
        assert.equal(after.changeOrderId, ids.changeOrderId);
        assert.equal(after.isBillable, true);
        assert.equal(after.routedFromProjectId, null, "and nothing from the refused reroute leaked in");

        // What the ROUTE answers for this exact state. A count of 0 is a 200
        // "alreadyApplied" only when every requested field already holds the
        // requested value; the entry never moved, so it falls through to the
        // 409 ROUTING_CONFLICT branch.
        assert.equal(after.projectId === ids.projectB, false, "so PATCH .../logistics answers 409 ROUTING_CONFLICT");
    } finally {
        await cleanup(db, ids);
        await db.$disconnect();
        await blocker.$disconnect();
    }
});

test("CASE B — the reroute commits first; the tag's in-transaction re-read refuses it", { skip }, async () => {
    // The reverse order, and the one the fix is actually about: the tag's
    // PRE-transaction check already passed against the old projectId, so only a
    // re-read under the lock can catch it.
    const { tagTimeEntriesToChangeOrderCore } = await import("../src/lib/time-expense-core");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const ids = await seed(db, `case-b-${Date.now()}`);
    try {
        let releaseReroute: () => void = () => {};
        const held = new Promise<void>((resolve) => { releaseReroute = resolve; });
        const rerouting = rerouteEntry(ids, { hold: held });
        await new Promise((r) => setTimeout(r, 300));

        // The tag's preflight runs OUTSIDE any transaction and cannot see the
        // uncommitted move, so it passes — exactly as it did in production.
        const preflight = await db.timeEntry.findUniqueOrThrow({
            where: { id: ids.entryId },
            select: { projectId: true },
        });
        assert.equal(preflight.projectId, ids.projectA, "the tag is authorized against the OLD job");

        const tagging = tagTimeEntriesToChangeOrderCore(
            { ids: [ids.entryId], changeOrderId: ids.changeOrderId },
            "case-b"
        );
        assert.equal(
            await stillPending(tagging, 600),
            true,
            "the tag blocks on the row lock the uncommitted reroute is holding"
        );

        releaseReroute();
        const claim = await rerouting;
        assert.equal(claim.count, 1, "the reroute committed the move");

        await assert.rejects(
            () => tagging,
            (error: unknown) => {
                assert.equal(isTimeEntryTagConflictError(error), true, String(error));
                assert.equal((error as { status?: number }).status, 409);
                return true;
            },
            "the re-read under the lock sees the new job and refuses"
        );

        const after = await db.timeEntry.findUniqueOrThrow({
            where: { id: ids.entryId },
            select: { projectId: true, changeOrderId: true, isBillable: true },
        });
        assert.equal(after.projectId, ids.projectB, "the entry is on the new job");
        assert.equal(after.changeOrderId, null, "and ZERO rows were tagged — the transaction rolled back");
        assert.equal(after.isBillable, false, "isBillable rolled back with it");

        // ── THE CONTROL ──────────────────────────────────────────────────────
        // The pre-fix predicate: the ids plus the billing columns, no projectId.
        // Run against the very state the fix just refused, it MATCHES. That is
        // the whole bug, and it is why the assertions above are about something
        // that could really have gone wrong.
        const preFix = await db.timeEntry.updateMany({
            where: { id: ids.entryId, invoiceId: null, invoicedAt: null },
            data: { changeOrderId: ids.changeOrderId, isBillable: true },
        });
        assert.equal(preFix.count, 1, "the OLD id-only predicate would have tagged the moved row");

        const corrupted = await db.timeEntry.findUniqueOrThrow({
            where: { id: ids.entryId },
            select: { projectId: true, changeOrder: { select: { projectId: true } } },
        });
        assert.equal(corrupted.projectId, ids.projectB);
        assert.equal(corrupted.changeOrder?.projectId, ids.projectA);
        assert.notEqual(
            corrupted.projectId,
            corrupted.changeOrder?.projectId,
            "job B's hours carrying job A's cost-plus change order — the invoice this fix prevents"
        );

        // Undo the control so the fixture leaves no cross-job row behind.
        await db.timeEntry.update({
            where: { id: ids.entryId },
            data: { changeOrderId: null, isBillable: false },
        });
    } finally {
        await cleanup(db, ids);
        await db.$disconnect();
    }
});
