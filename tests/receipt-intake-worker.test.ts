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
    toDateStr,
    type ReadPatch,
    type WorkerDependencies,
    type WorkerRow,
} from "../src/lib/receipt-intake/worker";
import type { ReadOutcome } from "../src/lib/receipt-intake/read";
import type { BookResult } from "../src/lib/receipt-intake/book";

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
    deferred: string[];
}

function harness(rows: WorkerRow[], overrides: Partial<WorkerDependencies> = {}): Harness {
    const h: Harness = {
        reads: 0, books: 0, applied: [], states: [], promoted: [], deferred: [],
        deps: null as unknown as WorkerDependencies,
    };
    h.deps = {
        claim: async () => rows,
        loadPhases: async () => [{ id: "cc-plumb", code: "03-PLUMB", name: "Plumbing" }],
        downloadBytes: async () => Buffer.from("bytes"),
        read: async () => { h.reads++; return goodRead; },
        applyRead: async (_id, patch) => { h.applied.push(patch); return { strongOwner: null }; },
        findWeakHit: async () => null,
        applyState: async (id, state, reason) => { h.states.push({ id, state, reason }); },
        promoteToBooking: async id => { h.promoted.push(id); },
        book: async () => { h.books++; return { outcome: "booked", qbPurchaseId: "QB-1", expenseId: "e1", alreadyExisted: false } as BookResult; },
        applyBookResult: async () => {},
        deferRead: async id => { h.deferred.push(id); },
        now: () => NOW,
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
    const h = harness([workerRow()], {
        applyRead: async () => ({ strongOwner: { id: "row-owner", totalCents: 36498 } }),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { DUPLICATE: 1 });
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].state, "DUPLICATE");
});

test("a strong-key loss at a DIFFERENT total goes to a human, not to DUPLICATE", async () => {
    const h = harness([workerRow()], {
        applyRead: async () => ({ strongOwner: { id: "row-owner", totalCents: 999 } }),
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

test("a service outage costs no attempt: the row is deferred, not reviewed", async () => {
    const h = harness([workerRow()], { read: async () => ({ ok: false, decisive: false }) });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(h.deferred, ["row-1"]);
    assert.deepEqual(h.states, []);
    assert.deepEqual(summary.byState, { RECEIVED: 1 });
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

test("one poison row is parked and the rest of the batch still runs", async () => {
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
    assert.equal(summary.byState.NEEDS_REVIEW, 1);
    assert.equal(summary.byState.READ, 1);
});

test("dateOnly keeps a calendar day at UTC midnight, the way @db.Date round-trips", () => {
    assert.equal(dateOnly("2026-08-03")!.toISOString(), "2026-08-03T00:00:00.000Z");
    assert.equal(dateOnly("2026-13-03"), null);
    assert.equal(dateOnly("nope"), null);
    assert.equal(toDateStr(new Date("2026-08-03T23:59:00.000Z")), "2026-08-03");
});
