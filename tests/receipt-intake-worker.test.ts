/**
 * The worker pass, and the one property the whole shadow week rests on:
 *
 *   with RECEIPT_INTAKE_DRYRUN unset (the default), a row is read, deduped and
 *   routed, and NOTHING is booked — zero createPurchase calls, zero Expense
 *   rows.
 *
 * That is asserted by counting the injected fakes' calls, not by reading the
 * code. Dependency injection throughout; no `mock.module` (CI is Node 20).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    runIntakeWorker,
    dateOnly,
    isTerminalQboFault,
    isUniqueViolation,
    toDateStr,
    MAX_BUSY_PASSES,
    RUN_SOFT_DEADLINE_MS,
    type ReadPatch,
    type WorkerDependencies,
    type WorkerRow,
} from "../src/lib/receipt-intake/worker";
import type { ReadOutcome } from "../src/lib/receipt-intake/read";
import type { BookResult } from "../src/lib/receipt-intake/book";
import { QBTimeoutError } from "../src/lib/quickbooks";
import { QboAccountConfigError, QboPurchaseFaultError } from "../src/lib/qbo-receipt-push";

import { Prisma } from "@prisma/client";

const PrismaKnownError = Prisma.PrismaClientKnownRequestError;
const NOW = new Date("2026-09-01T12:00:00.000Z");

function workerRow(overrides: Partial<WorkerRow> = {}): WorkerRow {
    return {
        id: "row-1",
        source: "drive",
        sourceRef: "drive:FILE1",
        state: "RECEIVED",
        dryRun: true,
        projectId: "proj-1",
        costCodeId: null,
        suggestedCostCodeId: null,
        storagePath: "receipts/intake/row-1.jpg",
        fileName: "r.jpg",
        mimeType: "image/jpeg",
        fileSize: 100,
        vendor: null,
        txnDate: null,
        totalCents: null,
        taxCents: null,
        docType: null,
        refNumber: null,
        memo: null,
        attempts: 0,
        readAt: null,
        createdAt: new Date("2026-08-20T09:00:00.000Z"),
        dedupWeakKey: null,
        busyPasses: 0,
        ...overrides,
    };
}

const goodRead: ReadOutcome = {
    ok: true,
    read: {
        docType: "receipt",
        vendor: "Lowes",
        date: "2026-08-03",
        invoice: "82766",
        checkNumber: "",
        memo: "",
        totalAmount: "364.98",
        taxAmount: "29.20",
        suggestedPhaseCode: "03-PLUMB",
        raw: '{"vendor":"Lowes"}',
    },
};

interface Harness {
    deps: WorkerDependencies;
    reads: number;
    books: number;
    applied: ReadPatch[];
    states: { id: string; state: string; reason: string | null }[];
    promoted: string[];
    deferred: { id: string; busyPasses: number }[];
    retried: { id: string; attempts: number; reason: string }[];
    claimOpts: { requeueDryRunParked: boolean }[];
    sweepCalls: number;
    clock: number;
}

function harness(rows: WorkerRow[], overrides: Partial<WorkerDependencies> = {}): Harness {
    const h: Harness = {
        reads: 0, books: 0, applied: [], states: [], promoted: [], deferred: [],
        retried: [], claimOpts: [], sweepCalls: 0, clock: 0,
        deps: null as unknown as WorkerDependencies,
    };
    h.deps = {
        claim: async opts => { h.claimOpts.push(opts); return { rows, requeued: 0 }; },
        isDryRunEnabled: () => true,
        sweepStaleStaging: async () => { h.sweepCalls++; return 0; },
        loadPhases: async () => [{ id: "cc-plumb", code: "03-PLUMB", name: "Plumbing" }],
        downloadBytes: async () => Buffer.from("bytes"),
        read: async () => { h.reads++; return goodRead; },
        applyRead: async (_id, patch) => { h.applied.push(patch); return { strongOwner: null }; },
        findWeakHit: async () => null,
        applyState: async (id, state, reason) => { h.states.push({ id, state, reason }); },
        promoteToBooking: async id => { h.promoted.push(id); return { promoted: true }; },
        book: async () => { h.books++; return { outcome: "booked", qbPurchaseId: "QB-1", expenseId: "e1", alreadyExisted: false } as BookResult; },
        applyBookResult: async () => {},
        deferRead: async (id, busyPasses) => { h.deferred.push({ id, busyPasses }); },
        retryRow: async (id, attempts, _next, reason) => { h.retried.push({ id, attempts, reason }); },
        now: () => NOW,
        monotonicMs: () => h.clock,
        ...overrides,
    };
    return h;
}

test("DRY RUN: a received row is read, deduped and routed — and never booked", async () => {
    const h = harness([workerRow({ dryRun: true })]);
    const summary = await runIntakeWorker(h.deps);

    assert.equal(h.reads, 1, "the reader DOES run in shadow mode — that is the point");
    assert.equal(h.books, 0, "zero booking calls");
    assert.equal(h.applied.length, 1);
    assert.equal(h.applied[0].state, "READ");
    assert.equal(h.applied[0].vendor, "Lowes");
    assert.equal(h.applied[0].totalCents, 36498);
    assert.equal(h.applied[0].taxCents, 2920);
    assert.equal(h.applied[0].dedupStrongKey, "2026-08-03|82766");
    assert.equal(h.applied[0].dedupWeakKey, "lowes|2026-08-03|364.98|amt");
    assert.equal(h.applied[0].suggestedCostCodeId, "cc-plumb");
    assert.deepEqual(summary, { processed: 1, byState: { READ: 1 } });
});

test("DRY RUN: a row already at READ parks there instead of moving to BOOKING", async () => {
    const h = harness([workerRow({ state: "READ", dryRun: true })]);
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.books, 0);
    assert.deepEqual(h.promoted, []);
    assert.deepEqual(summary.byState, { READ: 1 });
});

test("DRY RUN: a row stuck at BOOKING is not booked either", async () => {
    const h = harness([workerRow({ state: "BOOKING", dryRun: true })]);
    await runIntakeWorker(h.deps);
    assert.equal(h.books, 0);
});

test("LIVE: a READ row with dryRun=false is promoted and booked", async () => {
    const h = harness([workerRow({ state: "READ", dryRun: false })]);
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(h.promoted, ["row-1"]);
    assert.equal(h.books, 1);
    assert.deepEqual(summary.byState, { BOOKED: 1 });
});

test("a strong-key claim that loses re-routes against the owner and keeps no key", async () => {
    // Same total AND same canonical vendor: a confirmed duplicate.
    const h = harness([workerRow()], {
        applyRead: async () => ({ strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" } }),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { DUPLICATE: 1 });
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].state, "DUPLICATE");
});

test("a strong-key loss at a DIFFERENT total goes to a human, not to DUPLICATE", async () => {
    const h = harness([workerRow()], {
        applyRead: async () => ({ strongOwner: { id: "row-owner", totalCents: 999, canonicalVendor: "lowes" } }),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "strong-dup-amount-mismatch:row-owner");
});

test("a document that does not reach READ never claims the strong key", async () => {
    // A multi-doc or a $0 misread holding "2026-08-03|82766" would quarantine
    // the real receipt that arrives next.
    const h = harness([workerRow()], {
        read: async () => ({ ...goodRead, read: { ...goodRead.read, docType: "multi" } }) as ReadOutcome,
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.applied[0].state, "NEEDS_REVIEW");
    assert.equal(h.applied[0].stateReason, "multi-doc");
    assert.equal(h.applied[0].dedupStrongKey, null);
});

test("a service outage costs no attempt: the row is deferred and counts ONE busy pass", async () => {
    const h = harness([workerRow({ busyPasses: 3 })], { read: async () => ({ ok: false, decisive: false }) });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(h.deferred, [{ id: "row-1", busyPasses: 4 }]);
    assert.deepEqual(h.states, [], "no state change — the document was never read");
    assert.deepEqual(summary.byState, { RECEIVED: 1 });
});

test("an outage that never ends still ends: 20 busy passes parks the row", async () => {
    // v3.4. Without a ceiling a row cycles silently forever and nobody is ever
    // told the pipeline stopped producing.
    const h = harness([workerRow({ busyPasses: MAX_BUSY_PASSES - 1 })], {
        read: async () => ({ ok: false, decisive: false }),
    });
    await runIntakeWorker(h.deps);
    assert.deepEqual(h.deferred, [], "no further deferral");
    assert.equal(h.states[0].state, "NEEDS_REVIEW");
    assert.equal(h.states[0].reason, "ai-unavailable");
});

test("a document the model answered on but could not read goes to a human", async () => {
    const h = harness([workerRow()], { read: async () => ({ ok: false, decisive: true }) });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].state, "NEEDS_REVIEW");
    assert.equal(h.states[0].reason, "unreadable");
});

test("a missing storage object is terminal, not an infinite read loop", async () => {
    const h = harness([workerRow()], { downloadBytes: async () => null });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "file-missing");
    assert.equal(h.reads, 0);
});

test("another run holding the lock yields skipped, not an empty pass", async () => {
    const h = harness([], { claim: async () => null });
    assert.deepEqual(await runIntakeWorker(h.deps), {
        processed: 0, byState: {}, skipped: "already-running",
    });
});

test("one blowing-up row does not stall the batch", async () => {
    // The failing row is RETRIED (a throw here is almost always transport, not
    // the document) and, either way, row 2 still gets processed.
    let call = 0;
    const h = harness([workerRow({ id: "row-1" }), workerRow({ id: "row-2" })], {
        read: async () => {
            call++;
            if (call === 1) throw new Error("boom");
            return goodRead;
        },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.processed, 2);
    assert.equal(summary.byState.RETRY, 1);
    assert.equal(summary.byState.READ, 1);
    assert.equal(h.retried[0].id, "row-1");
});

test("a strong-key loss to a DIFFERENT vendor is a collision, not a duplicate", async () => {
    const h = harness([workerRow()], {
        applyRead: async () => ({ strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "homedepot" } }),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "vendor-mismatch:row-owner");
});

// ── Dry-run starvation (Codex blocker 1) ─────────────────────────────────────

test("the shadow week does NOT ask the claim to requeue", async () => {
    const h = harness([workerRow({ state: "READ", dryRun: true })], { isDryRunEnabled: () => true });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(h.claimOpts, [{ requeueDryRunParked: false }]);
    assert.equal(summary.requeued, undefined);
});

test("the FIRST live pass asks the claim to un-park the backlog, INSIDE the lock", async () => {
    // Parked rows are excluded from the claim (see the cron route's
    // NOT_DRY_RUN_PARKED) precisely so they cannot starve the ten-row batch —
    // which also means nothing else would ever wake them. The requeue rides in
    // the claim transaction so two overlapping invocations cannot both un-park
    // the same backlog and race each other's claim.
    const h = harness([], {
        isDryRunEnabled: () => false,
        claim: async opts => { h.claimOpts.push(opts); return { rows: [], requeued: 7 }; },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(h.claimOpts, [{ requeueDryRunParked: true }]);
    assert.equal(summary.requeued, 7);

    // Idempotent by construction: nothing is left matching the predicate.
    const second = harness([], { isDryRunEnabled: () => false });
    assert.equal((await runIntakeWorker(second.deps)).requeued, undefined, "a no-op requeue is not reported");
});

test("a run that loses the lock does nothing at all — including the requeue", async () => {
    // The requeue is now part of the claim transaction, so losing the lock
    // means losing it too. That is correct: the run that HOLDS the lock does it.
    const h = harness([], { isDryRunEnabled: () => false, claim: async () => null });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary, { processed: 0, byState: {}, skipped: "already-running" });
    assert.equal(h.sweepCalls, 0, "no work of any kind happens without the lock");
});

// ── STAGING sweep (Codex round 2, blocker 1) ─────────────────────────────────

test("every pass sweeps STAGING rows whose upload never landed", async () => {
    // A STAGING row is invisible to the claim by design (its object is not in
    // the bucket), so without this sweep nothing would ever notice one.
    const h = harness([], { sweepStaleStaging: async () => { h.sweepCalls++; return 2; } });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.sweepCalls, 1);
    assert.equal(summary.staleStagingSwept, 2);
});

test("a failing sweep never takes the pass down with it", async () => {
    const h = harness([workerRow()], {
        sweepStaleStaging: async () => { throw new Error("db blip"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.staleStagingSwept, undefined);
    assert.deepEqual(summary.byState, { READ: 1 }, "the batch still ran");
});

// ── Soft deadline (Codex blocker 2) ──────────────────────────────────────────

test("the worker stops TAKING rows at 40s and leaves the rest for the next run", async () => {
    // A row started at 41s can still be reading at 66s, past the 60s function
    // ceiling — the invocation dies mid-book and the row is left in whatever
    // state it happened to reach.
    const rows = [1, 2, 3, 4, 5].map(n => workerRow({ id: `row-${n}` }));
    const h = harness(rows, {
        read: async () => { h.clock += 15_000; h.reads++; return goodRead; },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.ok(h.clock >= RUN_SOFT_DEADLINE_MS);
    assert.equal(summary.processed, 3, "three rows fit inside the soft deadline");
    assert.equal(summary.deferredToNextRun, 2);
    assert.equal(h.reads, 3, "the deferred rows are never read");
});

// ── Weak-dedup race at the READ -> BOOKING transition (Codex blocker 5) ───────

test("two rows sharing a weak key SERIALIZE: the second is blocked, not booked", async () => {
    // Write skew. Both rows pass the read-time weak check (neither is BOOKING
    // yet), so without the per-weak-key advisory lock inside promoteToBooking
    // both SELECTs run before either UPDATE commits, READ COMMITTED sees no
    // conflict (neither row writes what the other read), and the SAME purchase
    // books twice. The lock is what makes the second one observe the first.
    const WEAK = "lowes|2026-08-03|364.98|amt";
    const booking = new Set<string>();
    const h = harness(
        [
            workerRow({ id: "row-a", state: "READ", dryRun: false, dedupWeakKey: WEAK }),
            workerRow({ id: "row-b", state: "READ", dryRun: false, dedupWeakKey: WEAK }),
        ],
        {
            // Stands in for the serialized transaction: the lock means this
            // body runs to completion for row-a before row-b enters it.
            promoteToBooking: async (id, weakKey) => {
                h.promoted.push(id);
                const twin = [...booking].find(other => other !== id);
                if (weakKey && twin) return { promoted: false, conflictId: twin };
                booking.add(id);
                return { promoted: true };
            },
        },
    );
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(h.promoted, ["row-a", "row-b"], "both rows attempted the transition");
    assert.equal(h.books, 1, "exactly ONE of them books");
    assert.equal(summary.byState.BOOKED, 1);
    assert.equal(summary.byState.NEEDS_REVIEW, 1);
});

test("rows with DIFFERENT weak keys never block each other", async () => {
    const h = harness([
        workerRow({ id: "row-a", state: "READ", dryRun: false, dedupWeakKey: "lowes|2026-08-03|364.98|amt" }),
        workerRow({ id: "row-b", state: "READ", dryRun: false, dedupWeakKey: "amazon|2026-08-03|12.00|amt" }),
    ]);
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.books, 2);
    assert.deepEqual(summary.byState, { BOOKED: 2 });
});

test("a weak-key twin already BOOKING blocks the transition and asks a human", async () => {
    const h = harness([workerRow({ state: "READ", dryRun: false, dedupWeakKey: "lowes|2026-08-03|364.98|amt" })], {
        promoteToBooking: async (id, weakKey) => {
            h.promoted.push(id);
            assert.equal(weakKey, "lowes|2026-08-03|364.98|amt", "the weak key is passed INTO the transition");
            return { promoted: false, conflictId: "row-twin" };
        },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.books, 0, "money never moves on a blocked transition");
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
});

// ── Transient vs terminal (Codex issue 11) ───────────────────────────────────

test("a storage/Prisma/network throw is RETRIED, not parked for a human", async () => {
    // Parking every transient fault turns one bad minute into a queue full of
    // manual work — and leaves those rows holding their strong keys.
    for (const error of [new Error("connection reset"), new TypeError("fetch failed"), new QBTimeoutError("t")]) {
        const h = harness([workerRow({ attempts: 2 })], {
            downloadBytes: async () => { throw error; },
        });
        const summary = await runIntakeWorker(h.deps);
        assert.deepEqual(summary.byState, { RETRY: 1 }, String(error));
        assert.equal(h.retried[0].attempts, 3);
        assert.deepEqual(h.states, [], "not parked");
    }
});

test("a CLASSIFIED QBO business fault thrown mid-row IS terminal", () => {
    assert.equal(isTerminalQboFault(new QboPurchaseFaultError(400, "closed period", "6210")), true);
    assert.equal(isTerminalQboFault(new QboAccountConfigError("bad account")), true);
    // A timeout is transport, not a verdict.
    assert.equal(isTerminalQboFault(new QBTimeoutError("timed out")), false);
    assert.equal(isTerminalQboFault(new Error("connection reset")), false);
});

test("a QBO fault thrown mid-row parks; a transient one past the ceiling also parks", async () => {
    const terminal = harness([workerRow()], {
        downloadBytes: async () => { throw new QboAccountConfigError("bad account"); },
    });
    assert.deepEqual((await runIntakeWorker(terminal.deps)).byState, { NEEDS_REVIEW: 1 });
    assert.match(terminal.states[0].reason!, /^qbo-fault:/);

    const exhausted = harness([workerRow({ attempts: 19 })], {
        downloadBytes: async () => { throw new Error("connection reset"); },
    });
    assert.deepEqual((await runIntakeWorker(exhausted.deps)).byState, { NEEDS_REVIEW: 1 });
    assert.equal(exhausted.states[0].reason, "max-retries");
});

test("isUniqueViolation is about the ERROR CODE, not Prisma's meta text", () => {
    // The previous version string-matched "dedupStrongKey" inside error.meta,
    // which is version-dependent and EMPTY for a partial index on some engine
    // builds — i.e. exactly the index this mechanism depends on.
    const p2002 = Object.assign(new Error("unique"), { code: "P2002", meta: {}, clientVersion: "5", name: "PrismaClientKnownRequestError" });
    Object.setPrototypeOf(p2002, PrismaKnownError.prototype);
    assert.equal(isUniqueViolation(p2002), true, "an empty meta must still be recognised");
    const p2003 = Object.assign(new Error("fk"), { code: "P2003", meta: {}, clientVersion: "5" });
    Object.setPrototypeOf(p2003, PrismaKnownError.prototype);
    assert.equal(isUniqueViolation(p2003), false);
    assert.equal(isUniqueViolation(new Error("plain")), false);
});

test("dateOnly keeps a calendar day at UTC midnight, the way @db.Date round-trips", () => {
    assert.equal(dateOnly("2026-08-03")!.toISOString(), "2026-08-03T00:00:00.000Z");
    assert.equal(dateOnly("2026-13-03"), null);
    assert.equal(dateOnly("nope"), null);
    assert.equal(toDateStr(new Date("2026-08-03T23:59:00.000Z")), "2026-08-03");
});
