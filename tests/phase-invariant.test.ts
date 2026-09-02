/**
 * "Is this cost code a phase of this job?" as a TRANSACTIONAL invariant
 * (Codex round 17, item 5).
 *
 * Five writers asked that question through the global Prisma client and then
 * wrote on the answer in a transaction that never held it. The facts live on
 * four other tables — Project, Estimate, EstimateItem, CostCode — and every one
 * of them can move in that window: an estimate archived or reassigned, a line
 * item deleted, a cost code retired company-wide.
 *
 * These tests drive the helper against a scripted database so each of those
 * interleavings is deterministic, and pin the LOCK ORDER, which is the only
 * thing standing between two callers and a deadlock.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assertPhaseOfProjectTx, lockPhaseRowsForShare } from "../src/lib/phase-invariant";

interface World {
    project: { id: string; status: string } | null;
    costCode: { id: string; code: string; isActive: boolean } | null;
    /** One row per estimate item, with the estimate facts it hangs off. */
    items: {
        costCodeId: string;
        projectId: string;
        estimateStatus: string;
        archivedAt: Date | null;
    }[];
}

function db(world: World) {
    const queries: string[] = [];
    const tx = {
        async $queryRawUnsafe(query: string, ...args: unknown[]) {
            queries.push(query.replace(/\s+/g, " ").trim());
            if (/FOR SHARE/.test(query)) return [];
            if (/FROM "Project" WHERE id/.test(query)) {
                return world.project ? [world.project] : [];
            }
            if (/FROM "CostCode" WHERE id/.test(query)) {
                return world.costCode ? [world.costCode] : [];
            }
            if (/FROM "EstimateItem"/.test(query)) {
                // The predicate, modelled: project, code, un-archived, and an
                // ELIGIBLE status (the statuses arrive as parameters).
                const [projectId, costCodeId, ...statuses] = args as string[];
                const hit = world.items.some(
                    item =>
                        item.projectId === projectId &&
                        item.costCodeId === costCodeId &&
                        item.archivedAt === null &&
                        statuses.includes(item.estimateStatus),
                );
                return hit ? [{ ok: 1 }] : [];
            }
            return [];
        },
    };
    return { tx, queries };
}

const LIVE: World = {
    project: { id: "job-1", status: "In Progress" },
    costCode: { id: "cc-plumb", code: "03-PLUMB", isActive: true },
    items: [
        { costCodeId: "cc-plumb", projectId: "job-1", estimateStatus: "Approved", archivedAt: null },
    ],
};

const clone = (world: World): World => ({
    project: world.project ? { ...world.project } : null,
    costCode: world.costCode ? { ...world.costCode } : null,
    items: world.items.map(item => ({ ...item })),
});

// ── the happy answer ───────────────────────────────────────────────────────

test("a real phase of the job passes", async () => {
    const { tx } = db(clone(LIVE));
    assert.deepEqual(await assertPhaseOfProjectTx(tx, "job-1", "cc-plumb"), { ok: true });
});

test("no cost code is nothing to check, and takes no locks", async () => {
    const { tx, queries } = db(clone(LIVE));
    assert.deepEqual(await assertPhaseOfProjectTx(tx, "job-1", null), { ok: true });
    assert.deepEqual(queries, [], "a vacuous question locks nothing");
});

test("a phase with no job to check it against is refused", async () => {
    const { tx, queries } = db(clone(LIVE));
    assert.deepEqual(
        await assertPhaseOfProjectTx(tx, null, "cc-plumb"),
        { ok: false, reason: "no-project" },
    );
    assert.deepEqual(queries, []);
});

// ── the lock order IS the deadlock protection ──────────────────────────────

test("four tables are share-locked, in one fixed order, BEFORE anything is read", async () => {
    const { tx, queries } = db(clone(LIVE));
    await assertPhaseOfProjectTx(tx, "job-1", "cc-plumb");

    const locks = queries.filter(query => /FOR SHARE/.test(query));
    assert.equal(locks.length, 4);
    assert.match(locks[0], /FROM "Project"/);
    assert.match(locks[1], /FROM "Estimate"/);
    assert.match(locks[2], /FROM "EstimateItem"/);
    assert.match(locks[3], /FROM "CostCode"/);
    // Every read happens after every lock — a read taken first describes a
    // moment the lock then fails to preserve.
    const lastLock = queries.map(q => /FOR SHARE/.test(q)).lastIndexOf(true);
    const firstRead = queries.findIndex(q => !/FOR SHARE/.test(q));
    assert.ok(firstRead > lastLock, "locks, then reads");
    // Ordered id scans, so two holders acquire the same rows the same way.
    assert.match(locks[1], /ORDER BY id/);
    assert.match(locks[2], /ORDER BY ei\.id/);
});

test("the same lock order is available to a caller that needs the whole list", async () => {
    // The backfill re-reads a job's phases under the lock; it must not invent a
    // second ordering to deadlock against the booking.
    const { tx, queries } = db(clone(LIVE));
    await lockPhaseRowsForShare(tx, "job-1");
    const tables = queries.map(query => query.match(/FROM "(\w+)"/)?.[1]);
    assert.deepEqual(tables, ["Project", "Estimate", "EstimateItem"]);
    assert.ok(queries.every(query => /FOR SHARE/.test(query)));
});

// ── the interleavings ──────────────────────────────────────────────────────

test("an ESTIMATE REASSIGNED to another job stops being this job's phase", async () => {
    // The item still carries the code; the estimate it hangs off now belongs to
    // somebody else's job. Writing the code here would post money onto a line
    // this job does not have.
    const world = clone(LIVE);
    world.items[0].projectId = "job-2";
    const { tx } = db(world);
    assert.deepEqual(
        await assertPhaseOfProjectTx(tx, "job-1", "cc-plumb"),
        { ok: false, reason: "not-a-phase" },
    );
});

test("an ARCHIVED estimate stops being committed work", async () => {
    const world = clone(LIVE);
    world.items[0].archivedAt = new Date("2026-09-02T00:00:00.000Z");
    const { tx } = db(world);
    assert.deepEqual(
        await assertPhaseOfProjectTx(tx, "job-1", "cc-plumb"),
        { ok: false, reason: "not-a-phase" },
    );
});

test("an estimate that fell out of the eligible statuses stops counting", async () => {
    // A "Rejected" revision is not committed work — the same predicate the
    // clock-in route applies.
    const world = clone(LIVE);
    world.items[0].estimateStatus = "Rejected";
    const { tx } = db(world);
    assert.deepEqual(
        await assertPhaseOfProjectTx(tx, "job-1", "cc-plumb"),
        { ok: false, reason: "not-a-phase" },
    );
});

test("a DEACTIVATED cost code is refused, and named as such", async () => {
    // Company-wide retirement has nothing to do with this job, so it is a
    // different answer from "not a phase of yours".
    const world = clone(LIVE);
    world.costCode!.isActive = false;
    const { tx } = db(world);
    assert.deepEqual(
        await assertPhaseOfProjectTx(tx, "job-1", "cc-plumb"),
        { ok: false, reason: "code-inactive" },
    );
});

test("a cost code that does not exist is the same answer as a retired one", async () => {
    const world = clone(LIVE);
    world.costCode = null;
    const { tx } = db(world);
    assert.deepEqual(
        await assertPhaseOfProjectTx(tx, "job-1", "cc-plumb"),
        { ok: false, reason: "code-inactive" },
    );
});

test("a DELETED job accepts nothing", async () => {
    const world = clone(LIVE);
    world.project = null;
    const { tx } = db(world);
    assert.deepEqual(
        await assertPhaseOfProjectTx(tx, "job-1", "cc-plumb"),
        { ok: false, reason: "project-missing" },
    );
});

// ── the Safety phase is company-wide, not an estimate line ─────────────────

test("the Safety phase passes on an In Progress job with no estimate item", async () => {
    const world = clone(LIVE);
    world.costCode = { id: "cc-safety", code: "32-SAFETY", isActive: true };
    world.items = [];
    const { tx } = db(world);
    assert.deepEqual(await assertPhaseOfProjectTx(tx, "job-1", "cc-safety"), { ok: true });
});

test("...but not on a job that is not In Progress, and not while retired", async () => {
    const notRunning = clone(LIVE);
    notRunning.project = { id: "job-1", status: "Completed" };
    notRunning.costCode = { id: "cc-safety", code: "32-SAFETY", isActive: true };
    notRunning.items = [];
    assert.deepEqual(
        await assertPhaseOfProjectTx(db(notRunning).tx, "job-1", "cc-safety"),
        { ok: false, reason: "not-a-phase" },
    );

    const retired = clone(LIVE);
    retired.costCode = { id: "cc-safety", code: "32-SAFETY", isActive: false };
    assert.deepEqual(
        await assertPhaseOfProjectTx(db(retired).tx, "job-1", "cc-safety"),
        { ok: false, reason: "code-inactive" },
    );
});
