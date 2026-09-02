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
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    runIntakeWorker,
    dateOnly,
    isTerminalQboFault,
    isUniqueViolation,
    toDateStr,
    MAX_BUSY_PASSES,
    MAX_PLAUSIBLE_TAX_RATE,
    validateTaxCents,
    RUN_SOFT_DEADLINE_MS,
    type ReadPatch,
    type WorkerDependencies,
    type WorkerRow,
    uploadLeaseActive,
    uploadLeaseExpiry,
    SIGNED_UPLOAD_TTL_MS,
    readBudgetFor,
    READ_MIN_BUDGET_MS,
    READ_SAFETY_MARGIN_MS,
} from "../src/lib/receipt-intake/worker";
import { normalizeDocType, READ_BUDGET_MS, type ReadOutcome } from "../src/lib/receipt-intake/read";
import type { BookResult } from "../src/lib/receipt-intake/book";
import type { CutoverRequest } from "../src/lib/receipt-intake/worker";
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
        lastError: null,
        suggestedConfidence: null,
        sendAttempted: false,
        claimToken: "claim-1",
        fileSha256: "s".repeat(64),
        stateReason: null,
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
        suggestedConfidence: 0.82,
        raw: '{"vendor":"Lowes"}',
    },
};

interface Harness {
    deps: WorkerDependencies;
    reads: number;
    books: number;
    applied: ReadPatch[];
    states: {
        id: string; state: string; reason: string | null;
        patch?: Partial<ReadPatch>; ownership?: { state: string; claimToken: string | null };
    }[];
    promoted: string[];
    finished: { id: string; claimToken: string | null; stateReason: string | null }[];
    deferred: { id: string; busyPasses: number }[];
    retried: { id: string; attempts: number; reason: string }[];
    claimOpts: CutoverRequest[];
    boundary: Date | null;
    sweepCalls: number;
    cleanupCalls: number;
    bookBudgets: number[];
    clock: number;
    sendReads: string[];
    persistedSendAttempted?: boolean;
}

function harness(rows: WorkerRow[], overrides: Partial<WorkerDependencies> = {}): Harness {
    const h: Harness = {
        reads: 0, books: 0, applied: [], states: [], promoted: [], finished: [], deferred: [],
        retried: [], claimOpts: [], sweepCalls: 0, cleanupCalls: 0, bookBudgets: [], clock: 0,
        sendReads: [],
        boundary: new Date("2026-08-25T00:00:00.000Z"),
        deps: null as unknown as WorkerDependencies,
    };
    h.deps = {
        claim: async opts => {
            h.claimOpts.push(opts);
            return { rows, shadowRetired: 0, requeued: 0, shadowQuarantined: 0 };
        },
        cutoverBoundary: async () => h.boundary,
        isDryRunEnabled: () => true,
        sweepStaleStaging: async () => { h.sweepCalls++; return 0; },
        retryStorageCleanups: async () => { h.cleanupCalls++; return 0; },
        loadPhases: async () => [{ id: "cc-plumb", code: "03-PLUMB", name: "Plumbing" }],
        // Defaults to what the row already carries: the interesting case is the
        // one that overrides it, where a late assignment landed mid-pass.
        refreshProjectId: async rowId => rows.find(r => r.id === rowId)?.projectId ?? null,
        // The PERSISTED flag. Defaults to what the row carries, so only the
        // tests about the reload have to think about it.
        sendAttemptedNow: async rowId => {
            h.sendReads.push(rowId);
            return h.persistedSendAttempted ?? rows.find(r => r.id === rowId)?.sendAttempted ?? false;
        },
        downloadBytes: async () => ({ ok: true as const, bytes: Buffer.from("bytes") }),
        read: async () => { h.reads++; return goodRead; },
        applyRead: async (_id, patch) => { h.applied.push(patch); return { owned: true, strongOwner: null }; },
        findWeakHit: async () => null,
        applyState: async (id, state, reason, patch, ownership) => {
            h.states.push({ id, state, reason, patch, ownership });
            return true;
        },
        finishRouting: async (id, claimToken, stateReason) => {
            h.finished.push({ id, claimToken, stateReason });
        },
        companyTimeZone: async () => "America/Los_Angeles",
        promoteToBooking: async id => { h.promoted.push(id); return { promoted: true }; },
        book: async () => {
            h.books++;
            return { outcome: "booked", qbPurchaseId: "QB-1", expenseId: "e1", alreadyExisted: false } as BookResult;
        },
        applyBookResult: async () => {},
        deferRead: async (id, busyPasses) => { h.deferred.push({ id, busyPasses }); return true; },
        retryRow: async (id, attempts, _next, reason) => { h.retried.push({ id, attempts, reason }); return true; },
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
    // The claim leaves the row RECEIVED and holding its lease; finishRouting is
    // the only thing that publishes READ, after every dedup net has answered.
    assert.equal(h.applied[0].state, "RECEIVED");
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null }]);
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
        applyRead: async () => ({ owned: true, strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" } }),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { DUPLICATE: 1 });
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].state, "DUPLICATE");
});

test("a strong-key loss at a DIFFERENT total goes to a human, not to DUPLICATE", async () => {
    const h = harness([workerRow()], {
        applyRead: async () => ({ owned: true, strongOwner: { id: "row-owner", totalCents: 999, canonicalVendor: "lowes" } }),
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
    // Through applyState, which RELEASES the claim in the same write — not
    // applyRead, which keeps the lease because routing continues under it.
    assert.deepEqual(h.applied, [], "no lease-keeping write for a finished row");
    assert.equal(h.states[0].state, "NEEDS_REVIEW");
    assert.equal(h.states[0].reason, "multi-doc");
    assert.equal(h.states[0].patch?.dedupStrongKey, null);
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
    const h = harness([workerRow()], {
        downloadBytes: async () => ({ ok: false as const, kind: "missing" as const }),
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "file-missing");
    assert.equal(h.reads, 0);
});

test("a TRANSIENT storage fault retries — it is not evidence the file is gone", async () => {
    // Collapsing both to null meant a Supabase blip parked good receipts as
    // file-missing, permanently, for a human to untangle.
    const h = harness([workerRow({ attempts: 1 })], {
        downloadBytes: async () => ({ ok: false as const, kind: "transient" as const, message: "ECONNRESET" }),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { RETRY: 1 });
    assert.deepEqual(h.states, [], "not parked");
    assert.equal(h.retried[0].attempts, 2);
    assert.match(h.retried[0].reason, /^storage:/);
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
        applyRead: async () => ({ owned: true, strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "homedepot" } }),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "vendor-mismatch:row-owner");
});

// ── Dry-run starvation (Codex blocker 1) ─────────────────────────────────────

test("the shadow week does NOT run the cutover", async () => {
    const h = harness([workerRow({ state: "READ", dryRun: true })], { isDryRunEnabled: () => true });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.claimOpts[0].run, false);
    assert.equal(h.claimOpts[0].boundary, null, "the boundary is not even read while dry-run is on");
    assert.equal(summary.shadowRetired, undefined);
});

test("CUTOVER: the boundary is passed to the claim so the backlog can be split", async () => {
    // The double-booking hazard this closes: v2's QBO identity for an
    // email/chat/mobile/web row is the intake UUID, which v1 never saw, so
    // QuickBooks' DocNumber idempotency could not recognise the Purchase v1
    // already made — and requeuing would have booked the entire shadow backlog
    // a second time, on real books, in one pass.
    const boundary = new Date("2026-08-25T00:00:00.000Z");
    const h = harness([], {
        isDryRunEnabled: () => false,
        cutoverBoundary: async () => boundary,
        claim: async opts => {
            h.claimOpts.push(opts);
            // Rows BEFORE the boundary were booked by v1; rows after it by nobody.
            return { rows: [], shadowRetired: 7, requeued: 2, shadowQuarantined: 0 };
        },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.claimOpts[0].run, true);
    assert.equal(h.claimOpts[0].boundary?.toISOString(), boundary.toISOString());
    assert.equal(summary.shadowRetired, 7, "v1 already booked these");
    assert.equal(summary.requeued, 2, "nobody booked these — v2 must");
    assert.equal(summary.cutoverBlocked, undefined);
});

test("CUTOVER refuses entirely when no boundary is recorded", async () => {
    // Nothing in the database can infer when v1 stopped booking. Retiring on a
    // guess destroys evidence of real expenses; requeuing on a guess
    // double-books them. A logged no-op is the only honest third option.
    const h = harness([], {
        isDryRunEnabled: () => false,
        cutoverBoundary: async () => null,
        claim: async opts => {
            h.claimOpts.push(opts);
            assert.equal(opts.boundary, null);
            return { rows: [], shadowRetired: 0, requeued: 0, shadowQuarantined: 0 };
        },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.cutoverBlocked, "cutover-boundary-missing");
    assert.equal(summary.shadowRetired, undefined);
    assert.equal(summary.requeued, undefined);
});

test("a run that loses the lock does nothing at all — including the cutover", async () => {
    // The cutover is part of the claim transaction, so losing the lock means
    // losing it too. That is correct: the run that HOLDS the lock does it.
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

test("dateOnly anchors the calendar day in the COMPANY time zone, not UTC", () => {
    // The bug: 2026-08-03 was stored as 2026-08-03T00:00:00Z, which in
    // America/Los_Angeles is 5pm on August 2nd. Every report that bounds by
    // LOCAL midnight — job cost by month, the WA tax period, variance by week —
    // put roughly a third of receipts one day early, invisibly.
    const pacific = dateOnly("2026-08-03", "America/Los_Angeles")!;
    assert.equal(pacific.toISOString(), "2026-08-03T07:00:00.000Z", "local midnight PDT");

    // The proof that matters: read back IN the company zone it is still the 3rd.
    const asLocalDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(pacific);
    assert.equal(asLocalDay, "2026-08-03");

    // The old UTC-midnight value would have read as the 2nd — the regression.
    const utcMidnight = new Date("2026-08-03T00:00:00.000Z");
    assert.equal(
        new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(utcMidnight),
        "2026-08-02",
        "control: this is exactly what was wrong",
    );

    // Winter, so the offset differs (PST, -08:00) — a hardcoded offset would fail here.
    assert.equal(dateOnly("2026-01-15", "America/Los_Angeles")!.toISOString(), "2026-01-15T08:00:00.000Z");
    // A zone east of UTC moves the other way.
    assert.equal(dateOnly("2026-08-03", "Europe/Berlin")!.toISOString(), "2026-08-02T22:00:00.000Z");

    assert.equal(dateOnly("2026-13-03", "America/Los_Angeles"), null);
    assert.equal(dateOnly("nope", "America/Los_Angeles"), null);
    assert.equal(toDateStr(new Date("2026-08-03T23:59:00.000Z")), "2026-08-03");
});

test("a receipt read just before midnight Pacific keeps its own calendar day", async () => {
    // The end-to-end version of the above, through the worker.
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "2026-08-03" } } as ReadOutcome),
        companyTimeZone: async () => "America/Los_Angeles",
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.applied[0].txnDate!.toISOString(), "2026-08-03T07:00:00.000Z");
});

// ── Dedup ORDER: strong before weak (Codex round 3, item 1) ─────────────────

test("an EXACT duplicate becomes DUPLICATE, not NEEDS_REVIEW", async () => {
    // The regression this pins: an exact re-send matches BOTH nets. The weak
    // lookup used to run first, so it routed on the weak hit and the strong
    // claim — the only net that can answer DUPLICATE on its own — was never
    // attempted. The one case the strong key exists to resolve automatically
    // was the one case it never saw, and every re-sent receipt hit a human.
    const order: string[] = [];
    const h = harness([workerRow()], {
        applyRead: async (_id, patch) => {
            order.push("strong-claim");
            h.applied.push(patch);
            return { owned: true, strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" } };
        },
        findWeakHit: async () => { order.push("weak-lookup"); return { id: "row-owner" }; },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { DUPLICATE: 1 });
    assert.equal(h.states[0].state, "DUPLICATE");
    assert.deepEqual(order, ["strong-claim"], "the weak net is never consulted once the strong one answers");
});

test("the strong claim is attempted with the key, before any weak lookup", async () => {
    const order: string[] = [];
    const h = harness([workerRow()], {
        applyRead: async (_id, patch) => { order.push("strong-claim"); h.applied.push(patch); return { owned: true, strongOwner: null }; },
        findWeakHit: async () => { order.push("weak-lookup"); return null; },
    });
    await runIntakeWorker(h.deps);
    assert.deepEqual(order, ["strong-claim", "weak-lookup"]);
    assert.equal(h.applied[0].dedupStrongKey, "2026-08-03|82766", "the claim carries the key");
    // The claim writes the KEYS but leaves the row RECEIVED and holding its
    // lease. READ is reached only by finishRouting, once every net has spoken.
    assert.equal(h.applied[0].state, "RECEIVED");
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null }]);
});

test("the lease is held through routing and released only at the end", async () => {
    // Clearing it at claim time let an overlapping invocation reclaim a
    // half-routed row and BOOK it, after which this invocation would regress it.
    const h = harness([workerRow()]);
    await runIntakeWorker(h.deps);
    assert.equal(h.applied.length, 1);
    assert.ok(!("nextRetryAt" in h.applied[0]), "applyRead must not touch the lease");
    assert.equal(h.finished.length, 1, "exactly one release, at the end");
});

test("a weak lookup that THROWS leaves the row RECEIVED, retryable, never READ", async () => {
    // READ is terminal for a dry-run row, so a row parked there without a weak
    // check would sit for the whole shadow week while the daily comparison
    // counted it as fully deduped — a silent false negative in the one report
    // the cutover decision rests on.
    const h = harness([workerRow({ attempts: 0 })], {
        findWeakHit: async () => { throw new Error("connection reset"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { RETRY: 1 });
    assert.deepEqual(h.finished, [], "never published to READ");
    assert.equal(h.applied[0].state, "RECEIVED");
    assert.equal(h.retried[0].attempts, 1);
});

test("a weak-only hit still asks a human, and KEEPS the strong key", async () => {
    // This row is the live owner of that date|ref. Releasing the key would let
    // a third copy claim it and book while the pair is still unresolved.
    const h = harness([workerRow()], { findWeakHit: async () => ({ id: "row-twin" }) });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "weak-dup:row-twin");
    assert.equal(h.states[0].state, "NEEDS_REVIEW");
    // ...and it RELEASES the strong key: nothing was sent to QuickBooks, so the
    // documented pre-send rule applies here like anywhere else. Holding it made
    // a CORRECTED resend collide with a row that was never booked, leaving two
    // rows in review and neither able to proceed.
    assert.equal(h.states[0].patch?.dedupStrongKey, null);
});

test("a document-level gate short-circuits BOTH nets and claims no key", async () => {
    for (const [read, reason] of [
        [{ ...goodRead.read, docType: "multi" }, "multi-doc"],
        [{ ...goodRead.read, totalAmount: "0.00" }, "refund-or-zero"],
        [{ ...goodRead.read, totalAmount: "-22.57" }, "refund-or-zero"],
    ] as const) {
        let weakCalls = 0;
        const h = harness([workerRow()], {
            read: async () => ({ ok: true, read } as ReadOutcome),
            findWeakHit: async () => { weakCalls++; return { id: "row-twin" }; },
        });
        await runIntakeWorker(h.deps);
        // The tax note rides along with whatever state routing picked — a
        // document can be both a bad tax read and a refund.
        assert.ok(h.states[0].reason?.startsWith(reason), `${reason}: ${h.states[0].reason}`);
        assert.equal(h.states[0].patch?.dedupStrongKey, null, reason);
        assert.equal(weakCalls, 0, `${reason}: dedup is not consulted at all`);
    }
});

// ── OCR'd tax is a reading, not a fact (Phase 3 gate, item b) ───────────────

test("an implausible tax is DROPPED and noted, and the receipt still books", () => {
    // A misread decimal ("$2.92" as "$292") or a grabbed subtotal posts real
    // money to the reimbursable-sales-tax account and inflates a state filing.
    // WA's highest combined rate is ~10.6%, so 12% is the sanity bound.
    const r = (tax: number | null, total: number | null, docType = "receipt") =>
        validateTaxCents(tax, total, docType);

    assert.deepEqual(r(29_20, 36_498), { taxCents: 2920, implausible: false });
    // Exactly at the ceiling, rounded UP to the cent so a legitimate rounding
    // artefact at the boundary is not rejected.
    assert.deepEqual(r(1200, 10_000), { taxCents: 1200, implausible: false });
    assert.deepEqual(r(1201, 10_000), { taxCents: null, implausible: true });
    // The decimal-point misread.
    assert.deepEqual(r(29_200, 36_498), { taxCents: null, implausible: true });
    // Tax at or above the total is a grabbed subtotal, not a tax figure.
    assert.deepEqual(r(36_498, 36_498), { taxCents: null, implausible: true });
    assert.deepEqual(r(40_000, 36_498), { taxCents: null, implausible: true });
    // Absent or zero tax is normal, not implausible — most receipts here.
    assert.deepEqual(r(null, 36_498), { taxCents: null, implausible: false });
    assert.deepEqual(r(0, 36_498), { taxCents: null, implausible: false });
    // A tax with no usable total cannot be judged, so it is not trusted.
    assert.deepEqual(r(500, null), { taxCents: null, implausible: true });

    // A handwritten check to a sub has no sales tax, full stop. Any figure the
    // model produced is the wrong number off the cheque, and booking it would
    // move real money into the reimbursable-sales-tax account for a payment
    // that was never taxed. Even a "plausible" 8% is refused.
    assert.deepEqual(r(2920, 36_498, "check"), { taxCents: null, implausible: true });
    assert.deepEqual(r(100, 120_000, "check"), { taxCents: null, implausible: true });
    // ...but a check with NO tax reading is perfectly normal.
    assert.deepEqual(r(null, 120_000, "check"), { taxCents: null, implausible: false });

    assert.equal(MAX_PLAUSIBLE_TAX_RATE, 0.12);
});

test("a plausible tax is stored and the row carries no note", async () => {
    const h = harness([workerRow()]);
    await runIntakeWorker(h.deps);
    assert.equal(h.applied[0].taxCents, 2920, "29.20 of 364.98 is ~8%");
    assert.equal(h.applied[0].stateReason, null);
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null }]);
});

test("an implausible tax nulls taxCents, notes the row, and does NOT park it", async () => {
    // The receipt is fine and its TOTAL is what the bank charge matches, so it
    // must still book — as a single un-split line, exactly like a receipt whose
    // tax line was never readable.
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, taxAmount: "292.00" } } as ReadOutcome),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.applied[0].taxCents, null, "the bad reading is dropped, not booked");
    assert.equal(h.applied[0].totalCents, 36498, "the total is untouched");
    assert.deepEqual(summary.byState, { READ: 1 }, "READ, not NEEDS_REVIEW");
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: "tax-implausible" }]);
});

test("the tax note survives alongside a dedup reason", async () => {
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, taxAmount: "292.00" } } as ReadOutcome),
        findWeakHit: async () => ({ id: "row-twin" }),
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "weak-dup:row-twin;tax-implausible");
});

test("the row stores only the tax BOOKING accepted, never a rejected reading", async () => {
    // taxCents feeds the sales-tax reports, so it must never show a figure that
    // no Purchase ever carried. The stored value is read back out of the SAME
    // buildGroups the booking step calls.
    const h = harness([workerRow()], {
        read: async () => ({
            ok: true,
            read: { ...goodRead.read, docType: "check", checkNumber: "4178", taxAmount: "29.20" },
        } as ReadOutcome),
    });
    await runIntakeWorker(h.deps);
    // buildGroups refuses to split tax on a check, so nothing was accepted.
    assert.equal(h.applied[0].taxCents, null);
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: "tax-implausible" }]);
});

test("a check with no tax reading books clean, with no note", async () => {
    const h = harness([workerRow()], {
        read: async () => ({
            ok: true,
            read: { ...goodRead.read, docType: "check", checkNumber: "4178", taxAmount: "" },
        } as ReadOutcome),
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.applied[0].taxCents, null);
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null }]);
});

test("a tax equal to the total is refused end to end", async () => {
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, taxAmount: "364.98" } } as ReadOutcome),
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.applied[0].taxCents, null);
    assert.equal(h.applied[0].totalCents, 36498, "the total is untouched");
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: "tax-implausible" }]);
});

// ── Fail-closed classifier (round-5 item 4) ────────────────────────────────

test("a missing or unknown doc_type is NEVER treated as a receipt", async () => {
    // The old default was "receipt", and any unrecognised string also slipped
    // past the exact multi/non_receipt checks. A truncated response, a schema
    // change, or a prompt-injected document that suppressed the field while
    // supplying plausible amounts went straight at QuickBooks.
    for (const docType of ["", "unknown", "invoice", "RECEIPT_PLEASE_BOOK", "non-receipt"]) {
        const h = harness([workerRow()], {
            read: async () => ({
                ok: true,
                read: { ...goodRead.read, docType: normalizeDocType(docType) },
            } as ReadOutcome),
        });
        const summary = await runIntakeWorker(h.deps);
        assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 }, JSON.stringify(docType));
        assert.equal(h.states[0].reason, "unknown-doc-type", JSON.stringify(docType));
        assert.equal(h.states[0].patch?.dedupStrongKey, null, "and it claims no key");
    }
});

test("normalizeDocType accepts exactly the four the prompt may return", () => {
    for (const ok of ["receipt", "check", "multi", "non_receipt"]) {
        assert.equal(normalizeDocType(ok), ok);
        assert.equal(normalizeDocType(ok.toUpperCase()), ok, "case is normalised");
    }
    for (const bad of [undefined, null, "", "  ", "invoice", "reciept", 42, {}, ["receipt"]]) {
        assert.equal(normalizeDocType(bad), "unknown", JSON.stringify(bad));
    }
    // Surrounding whitespace is a formatting artefact, not a different answer.
    assert.equal(normalizeDocType("  receipt  "), "receipt");
});

// ── Fallback date in the company zone (round-5 item 5) ─────────────────────

test("an unreadable date falls back to the COMPANY's calendar day, not UTC's", async () => {
    // 2026-08-04T02:00Z is still the EVENING OF THE 3RD in Pacific. The old
    // toISOString().slice(0,10) gave "2026-08-04", which changed the receipt's
    // date, its dedup key, and its reporting period.
    const h = harness([workerRow({ createdAt: new Date("2026-08-04T02:00:00.000Z") })], {
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "" } } as ReadOutcome),
        companyTimeZone: async () => "America/Los_Angeles",
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.applied[0].dedupWeakKey, "lowes|2026-08-03|364.98|amt", "the KEY uses the local day");
    assert.equal(h.applied[0].txnDate!.toISOString(), "2026-08-03T07:00:00.000Z");
    // Still no strong key: a fallback date is our guess, not the document's.
    assert.equal(h.applied[0].dedupStrongKey, null);
});

// ── The sweep lives inside the run's budget (round-5 item 7) ───────────────

test("INTERLEAVING: a job assigned after the claim is honoured, not parked NEEDS_JOB", async () => {
    // The pass claims a row with no project, spends ~25s in the reader, and a
    // finalize writes the project in the meantime. Routing on the value read at
    // claim time would publish NEEDS_JOB for a receipt that HAS a job — and
    // NEEDS_JOB is exactly where a human goes looking for that problem, so the
    // row would sit in the one queue that means the opposite of its state.
    const h = harness([workerRow({ projectId: null })], {
        refreshProjectId: async () => "proj-late",
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { READ: 1 }, "routed, not parked");
    assert.deepEqual(h.states, [], "no NEEDS_JOB park was written");
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null }]);
});

test("a row with no job at claim time AND none at routing time still parks", async () => {
    // The control for the test above: the re-read is a re-read, not a way to
    // pretend every row has a job.
    const h = harness([workerRow({ projectId: null })], { refreshProjectId: async () => null });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_JOB: 1 });
});

test("a failing re-read falls back to the claimed value instead of losing the row", async () => {
    const h = harness([workerRow({ projectId: "proj-1" })], {
        refreshProjectId: async () => { throw new Error("pool exhausted"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { READ: 1 });
});

test("the deadline starts at invocation entry, so a slow sweep cannot overrun it", async () => {
    // The sweep downloads objects. Timing it OUT of the budget meant it could
    // eat the platform timeout and the worker would still go on to start a 25s
    // Gemini read and a QBO round trip.
    const h = harness([workerRow(), workerRow({ id: "row-2" })], {
        sweepStaleStaging: async shouldStop => {
            h.sweepCalls++;
            assert.equal(typeof shouldStop, "function", "the sweep is given the deadline");
            assert.equal(shouldStop(), false, "not yet out of time");
            h.clock += RUN_SOFT_DEADLINE_MS + 1_000; // a slow sweep
            assert.equal(shouldStop(), true, "the sweep can see it is out of time");
            return 1;
        },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.reads, 0, "no Gemini call after the budget is gone");
    assert.equal(summary.processed, 0);
    assert.equal(summary.deferredToNextRun, 2, "both rows keep their lease for the next run");
});

// ── A missing boundary halts the WHOLE pass (round-7 item 3) ───────────────

test("live mode with no recorded boundary claims nothing at all", async () => {
    // Refusing only the retire/requeue was not enough: the pass went on to
    // claim and BOOK rows while the shadow backlog sat undecided. Live mode
    // without a boundary means we cannot tell which rows v1 already booked,
    // and booking anything under that uncertainty is the double-booking this
    // whole mechanism exists to prevent.
    const h = harness([workerRow(), workerRow({ id: "row-2" })], {
        isDryRunEnabled: () => false,
        cutoverBoundary: async () => null,
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary, { processed: 0, byState: {}, cutoverBlocked: "cutover-boundary-missing" });
    assert.deepEqual(h.claimOpts, [], "claim() is never even called");
    assert.equal(h.sweepCalls, 0, "and no housekeeping runs either");
    assert.equal(h.books, 0);
    assert.equal(h.reads, 0);
});

test("dry-run mode does not need a boundary", async () => {
    // Nothing books in shadow mode, so there is nothing to be uncertain about.
    const h = harness([workerRow()], { isDryRunEnabled: () => true, cutoverBoundary: async () => null });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.cutoverBlocked, undefined);
    assert.equal(summary.processed, 1);
});

// ── Orphaned objects are chased (round-7 item 5) ───────────────────────────

test("every pass retries storage deletes that failed earlier", async () => {
    // A rejected row is deleted, so after that nothing in the database
    // references its bytes — without this they sit in a private bucket forever.
    const h = harness([], { retryStorageCleanups: async () => { h.cleanupCalls++; return 3; } });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.cleanupCalls, 1);
    assert.equal(summary.orphansCleaned, 3);
});

test("a failing cleanup pass never takes the run down", async () => {
    const h = harness([workerRow()], {
        retryStorageCleanups: async () => { throw new Error("storage down"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.orphansCleaned, undefined);
    assert.deepEqual(summary.byState, { READ: 1 }, "the batch still ran");
});

// ── A row that never sent releases its key, whatever killed it (item 7) ────

test("a weak-lookup failure at the retry limit RELEASES the strong key", async () => {
    // This row exhausted its attempts entirely on a database fault and never
    // touched QuickBooks. Holding its key quarantines the corrected resend
    // against a row that never became a purchase.
    const h = harness([workerRow({ attempts: 19, sendAttempted: false })], {
        findWeakHit: async () => { throw new Error("connection reset"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "max-retries");
    assert.equal(h.states[0].patch?.dedupStrongKey, null, "the key goes back");
});

test("a finishRouting failure at the retry limit also releases the key", async () => {
    const h = harness([workerRow({ attempts: 19, sendAttempted: false })], {
        finishRouting: async () => { throw new Error("connection reset"); },
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "max-retries");
    assert.equal(h.states[0].patch?.dedupStrongKey, null);
});

test("a row that DID send keeps its key at the retry limit", async () => {
    // QuickBooks may hold a Purchase whose response we lost.
    const h = harness([workerRow({ attempts: 19, sendAttempted: true })], {
        findWeakHit: async () => { throw new Error("connection reset"); },
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "max-retries");
    // parkTerminal always sends a patch; what matters is that it does NOT carry
    // a key release for a row that reached QuickBooks.
    assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})), "the key is untouched");
});

// ── Content changed under us (round-8 item 2) ──────────────────────────────

test("a read whose bytes no longer match the recorded sha is TERMINAL", async () => {
    // Sealing makes this nearly impossible; the check exists because "nearly"
    // is not a guarantee, and reading whatever happens to be at a path is how a
    // receipt for one job ends up booked against another.
    const h = harness([workerRow()], {
        downloadBytes: async () => ({ ok: false as const, kind: "sha-mismatch" as const, message: "x" }),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "content-changed");
    assert.equal(h.reads, 0, "the model never sees bytes we cannot vouch for");
});

test("the recorded sha is what the download is checked against", async () => {
    const asked: Array<[string, string]> = [];
    const h = harness([workerRow({ fileSha256: "abc".padEnd(64, "0") })], {
        downloadBytes: async (p, sha) => {
            asked.push([p, sha]);
            return { ok: true as const, bytes: Buffer.from("bytes") };
        },
    });
    await runIntakeWorker(h.deps);
    assert.deepEqual(asked, [["receipts/intake/row-1.jpg", "abc".padEnd(64, "0")]]);
});

// ── SHADOW_QUARANTINE (round-8 item 1) ─────────────────────────────────────

test("the cutover reports quarantined rows separately from retired and requeued", async () => {
    // Three outcomes, because "we cannot tell" is a real answer and collapsing
    // it into either of the other two either double-books or loses an expense.
    const h = harness([], {
        isDryRunEnabled: () => false,
        claim: async opts => {
            h.claimOpts.push(opts);
            return { rows: [], shadowRetired: 4, requeued: 2, shadowQuarantined: 3 };
        },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.shadowRetired, 4);
    assert.equal(summary.requeued, 2);
    assert.equal(summary.shadowQuarantined, 3);
});

// ── The claim token fences the completing write (Phase 2 gate, a) ──────────

test("finishRouting is handed the token the pass claimed with", async () => {
    // A zombie worker resuming after its row was re-claimed must write nothing.
    // The adapter matches on this token; the worker's job is to pass the one it
    // actually holds.
    const h = harness([workerRow({ claimToken: "token-abc" })]);
    await runIntakeWorker(h.deps);
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "token-abc", stateReason: null }]);
});

// ── A successor reclaiming mid-flight (Phase 2 gate) ───────────────────────

test("a predecessor superseded before promotion writes nothing and books nothing", async () => {
    const h = harness([workerRow({ state: "READ", dryRun: false, claimToken: "old-token" })], {
        // The CAS finds no row at {id, state: READ, claimToken: old-token}
        // because the successor re-claimed and re-stamped it.
        promoteToBooking: async (id, _weak, token) => {
            h.promoted.push(id);
            assert.equal(token, "old-token", "the predecessor offers its OWN token");
            return { promoted: false, stale: true };
        },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { STALE: 1 });
    assert.equal(h.books, 0, "no QBO call");
    assert.deepEqual(h.states, [], "no state write");
});

test("a stale booking result is never written back", async () => {
    const applied: unknown[] = [];
    const h = harness([workerRow({ state: "BOOKING", dryRun: false })], {
        book: async () => { h.books++; return { outcome: "stale" } as BookResult; },
        applyBookResult: async (_id, result) => { applied.push(result); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { STALE: 1 });
    // applyBookResult is still CALLED — the adapter is what refuses to write —
    // and the production adapter returns early on a stale outcome.
    assert.deepEqual(applied, [{ outcome: "stale" }]);
});

test("every book result carries the row's claim token to the writer", async () => {
    const tokens: Array<string | null> = [];
    const h = harness([workerRow({ state: "BOOKING", dryRun: false, claimToken: "tok-9" })], {
        applyBookResult: async (_id, _result, token) => { tokens.push(token); },
    });
    await runIntakeWorker(h.deps);
    assert.deepEqual(tokens, ["tok-9"]);
});

// ── Ownership is CAS'd on EVERY mutation (round-10 item 3) ─────────────────

test("losing the row aborts each mutation path instead of clobbering a successor", async () => {
    // A zombie worker holds a view its successor has already moved past. Every
    // write it attempts must affect zero rows and stop the pass for that row —
    // a time-based lease cannot express this, because both hold the same id.
    const lost = { owned: false as const };

    // applyState at the document-level gate (a terminal outcome, so it is the
    // releasing write that carries it, not applyRead).
    const gate = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, docType: "multi" } }) as ReadOutcome,
        applyState: async () => false,
    });
    assert.deepEqual((await runIntakeWorker(gate.deps)).byState, { STALE: 1 });

    // applyRead at the strong claim.
    const claim = harness([workerRow()], { applyRead: async () => ({ ...lost, strongOwner: null }) });
    assert.deepEqual((await runIntakeWorker(claim.deps)).byState, { STALE: 1 });
    assert.deepEqual(claim.finished, [], "never published");

    // applyState, via a terminal park.
    const park = harness([workerRow()], {
        downloadBytes: async () => ({ ok: false as const, kind: "missing" as const }),
        applyState: async () => false,
    });
    assert.deepEqual((await runIntakeWorker(park.deps)).byState, { STALE: 1 });

    // deferRead, via an AI outage.
    const defer = harness([workerRow()], {
        read: async () => ({ ok: false, decisive: false }),
        deferRead: async () => false,
    });
    assert.deepEqual((await runIntakeWorker(defer.deps)).byState, { STALE: 1 });

    // retryRow, via a transient storage fault.
    const retry = harness([workerRow()], {
        downloadBytes: async () => ({ ok: false as const, kind: "transient" as const, message: "x" }),
        retryRow: async () => false,
    });
    assert.deepEqual((await runIntakeWorker(retry.deps)).byState, { STALE: 1 });
});

test("every mutation is offered the row's OWN state and token", async () => {
    const seen: unknown[] = [];
    const h = harness([workerRow({ claimToken: "tok-7" })], {
        applyRead: async (_id, patch, ownership) => {
            seen.push(ownership);
            h.applied.push(patch);
            return { owned: true, strongOwner: null };
        },
    });
    await runIntakeWorker(h.deps);
    assert.deepEqual(seen, [{ state: "RECEIVED", claimToken: "tok-7" }]);
});

// ── One parkTerminal decides the key release (round-10 item 4) ─────────────

test("EVERY pre-send terminal park releases the strong key", async () => {
    // Each of these used to decide independently, and the ones that forgot held
    // a dedup key against a Purchase that never existed — so the corrected
    // resubmission collided with nothing.
    const cases: Array<[string, Partial<WorkerDependencies>]> = [
        ["file-missing", { downloadBytes: async () => ({ ok: false as const, kind: "missing" as const }) }],
        ["content-changed", { downloadBytes: async () => ({ ok: false as const, kind: "sha-mismatch" as const, message: "x" }) }],
        ["unreadable", { read: async () => ({ ok: false, decisive: true }) }],
    ];
    for (const [reason, over] of cases) {
        const h = harness([workerRow({ sendAttempted: false })], over);
        await runIntakeWorker(h.deps);
        assert.equal(h.states[0].reason, reason);
        assert.equal(h.states[0].patch?.dedupStrongKey, null, `${reason} must release the key`);
    }

    // ...and the AI-unavailable ceiling, which is a different code path again.
    const busy = harness([workerRow({ sendAttempted: false, busyPasses: MAX_BUSY_PASSES - 1 })], {
        read: async () => ({ ok: false, decisive: false }),
    });
    await runIntakeWorker(busy.deps);
    assert.equal(busy.states[0].reason, "ai-unavailable");
    assert.equal(busy.states[0].patch?.dedupStrongKey, null);
});

test("a park AFTER a send keeps the key, on every one of those paths", async () => {
    for (const over of [
        { downloadBytes: async () => ({ ok: false as const, kind: "missing" as const }) },
        { read: async () => ({ ok: false as const, decisive: true }) },
    ]) {
        const h = harness([workerRow({ sendAttempted: true })], over);
        await runIntakeWorker(h.deps);
        assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})), "the Purchase may exist");
    }
});

// ── The upload lease, not the row's age (round-13 item 2) ──────────────────

test("a re-issued upload URL keeps the row safe from the sweeper", () => {
    // The row is old; its LEASE is not. Judging it on createdAt declared a
    // receipt missing — or destroyed one it called unacceptable — while the
    // client's own upload link was live and about to land.
    const old = new Date(NOW.getTime() - 6 * 60 * 60_000);
    assert.equal(
        uploadLeaseActive({ createdAt: old, uploadUrlExpiresAt: new Date(NOW.getTime() + 60_000) }, NOW),
        true,
        "a fresh lease on an old row",
    );
    assert.equal(
        uploadLeaseActive({ createdAt: old, uploadUrlExpiresAt: new Date(NOW.getTime() - 60_000) }, NOW),
        false,
        "an expired lease is expired, however recently the row was touched",
    );
    // A row with no lease at all (the single-shot path writes its bytes through
    // the server) falls back to its own age.
    assert.equal(uploadLeaseActive({ createdAt: old, uploadUrlExpiresAt: null }, NOW), false);
    assert.equal(
        uploadLeaseActive({ createdAt: new Date(NOW.getTime() - 60_000), uploadUrlExpiresAt: null }, NOW),
        true,
    );
});

test("the lease a URL is issued under is exactly the signed-URL TTL", () => {
    assert.equal(uploadLeaseExpiry(NOW).getTime() - NOW.getTime(), SIGNED_UPLOAD_TTL_MS);
    assert.equal(SIGNED_UPLOAD_TTL_MS, 2 * 60 * 60_000);
});

// ── A late read gets what's left, not a fresh 25s (Codex round-17 item 2) ──

test("a read starting early in the run gets its full budget", () => {
    // Plenty of runway left: capped at READ_BUDGET_MS, never handed more.
    assert.equal(readBudgetFor(50_000), READ_BUDGET_MS);
});

test("a read starting late in the run gets only what's left, minus the safety margin", () => {
    // 10s left in the whole invocation must not become a fresh 25s read that
    // can straddle the platform's own ceiling — it gets 10s minus the margin
    // reserved for writing the result back.
    assert.equal(readBudgetFor(10_000), 10_000 - READ_SAFETY_MARGIN_MS);
});

test("too little runway skips the read entirely rather than starting a doomed one", () => {
    // Exactly at the floor once the margin is reserved: still worth trying.
    assert.equal(readBudgetFor(READ_MIN_BUDGET_MS + READ_SAFETY_MARGIN_MS), READ_MIN_BUDGET_MS);
    // Under the floor: 0, meaning "don't even try" — the same AI_UNAVAILABLE
    // answer as an exhausted budget, so the row costs no `attempts` and comes
    // back next pass with a full budget again.
    assert.equal(readBudgetFor(READ_MIN_BUDGET_MS + READ_SAFETY_MARGIN_MS - 1), 0);
    assert.equal(readBudgetFor(1_000), 0);
    assert.equal(readBudgetFor(0), 0);
    assert.equal(readBudgetFor(-5_000), 0);
});

test("/start stamps a lease on EVERY url it issues", () => {
    const start = readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/start/route.ts"),
        "utf8",
    );
    // Three: the new row, the re-armed park, and the resumed STAGING upload.
    // A URL handed out without a lease is one the sweeper cannot see coming.
    assert.equal(
        (start.match(/uploadUrlExpiresAt: uploadLeaseExpiry\(\)/g) ?? []).length,
        3,
        "create, re-arm and resume all stamp the lease",
    );
    const signed = (start.match(/await signUpload\(/g) ?? []).length;
    assert.equal(signed, 3, "and those are all the places a URL is issued");
});

// ── A finished row hands the claim back, whatever finished it ─────────────

test("EVERY early terminal outcome releases the claim in the same write", async () => {
    // The hole: these four were written by applyRead, which deliberately KEEPS
    // the lease because routing normally continues under it. For an outcome
    // that ends the row there is no "afterwards" — so the row sat finished and
    // still owned, which the health probe reads as claimed and every fenced
    // write misses.
    const outcomes: Array<[string, Partial<WorkerDependencies>, string]> = [
        ["multi-document", {
            read: async () => ({ ...goodRead, read: { ...goodRead.read, docType: "multi" } }) as ReadOutcome,
        }, "NEEDS_REVIEW"],
        ["non-receipt", {
            read: async () => ({ ...goodRead, read: { ...goodRead.read, docType: "non_receipt" } }) as ReadOutcome,
        }, "NON_RECEIPT"],
        ["zero or refund", {
            read: async () => ({ ...goodRead, read: { ...goodRead.read, totalAmount: "0.00" } }) as ReadOutcome,
        }, "NEEDS_REVIEW"],
    ];
    for (const [label, overrides, expected] of outcomes) {
        const h = harness([workerRow()], overrides);
        const summary = await runIntakeWorker(h.deps);
        assert.deepEqual(summary.byState, { [expected]: 1 }, label);
        assert.deepEqual(h.applied, [], `${label}: nothing kept the lease`);
        assert.equal(h.states.length, 1, label);
        // Fenced on the row's OWN state and token — which is what makes the
        // release atomic with the transition rather than a second write.
        assert.deepEqual(h.states[0].ownership, { state: "RECEIVED", claimToken: "claim-1" }, label);
        assert.deepEqual(h.finished, [], `${label}: finishRouting is for READ only`);
    }

    // The no-job park takes the same road.
    const noJob = harness([workerRow({ projectId: null })], { refreshProjectId: async () => null });
    assert.deepEqual((await runIntakeWorker(noJob.deps)).byState, { NEEDS_JOB: 1 });
    assert.deepEqual(noJob.applied, [], "no-project is terminal too");
    assert.deepEqual(noJob.states[0].ownership, { state: "RECEIVED", claimToken: "claim-1" });
});

test("a terminal write that LOSES its fence reports STALE and nothing else", async () => {
    const h = harness([workerRow()], {
        read: async () => ({ ...goodRead, read: { ...goodRead.read, docType: "multi" } }) as ReadOutcome,
        applyState: async () => false,
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { STALE: 1 });
    assert.deepEqual(h.finished, []);
});

test("the ONE write that keeps the lease can only ever say RECEIVED", () => {
    // Enforced by the type (`patch: ReadPatch & { state: "RECEIVED" }`), so a
    // terminal state cannot be routed back through applyRead by accident. This
    // asserts the contract is still written down where the compiler reads it.
    const worker = readFileSync(
        path.join(__dirname, "..", "src/lib/receipt-intake/worker.ts"),
        "utf8",
    );
    assert.match(worker, /patch: ReadPatch & \{ state: "RECEIVED" \}/);
    assert.match(worker, /THE ONE WRITE THAT KEEPS THE CLAIM/);
});

// ── A park after a send must never hand the key back (round-14 A) ──────────

test("a park decided AFTER a send reads the PERSISTED flag, not the claim snapshot", async () => {
    // The hole: everything after the QBO create — the post-create phase check,
    // the Expense commit, a pool timeout — could throw out to the worker's
    // generic handler, which parked the row from the snapshot it claimed with.
    // That snapshot says "nothing sent", so the dedup key went back for a row
    // with a Purchase in the real books, and the next submission of the same
    // receipt booked it a second time.
    const h = harness([workerRow({ state: "READ", dryRun: false, sendAttempted: false, attempts: 19 })], {
        book: async () => { throw new Error("connection reset after the create"); },
    });
    h.persistedSendAttempted = true; // markSendAttempted got there first
    await runIntakeWorker(h.deps);

    assert.deepEqual(h.sendReads, ["row-1"], "the flag was re-read");
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].state, "NEEDS_REVIEW");
    assert.ok(
        !("dedupStrongKey" in (h.states[0].patch ?? {})),
        "the key is RETAINED: a Purchase may exist",
    );
});

test("a park with nothing ever sent still releases the key", async () => {
    // The control. Holding a key against a booking that never happened sends
    // the corrected resubmission to a human for no reason.
    const h = harness([workerRow({ state: "READ", dryRun: false, sendAttempted: false, attempts: 19 })], {
        book: async () => { throw new Error("connection reset"); },
    });
    h.persistedSendAttempted = false;
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].patch?.dedupStrongKey, null);
});

test("an unreadable send flag RETAINS the key", async () => {
    // Retaining costs a review item; releasing wrongly costs a second Purchase.
    const h = harness([workerRow({ state: "READ", dryRun: false, sendAttempted: false, attempts: 19 })], {
        book: async () => { throw new Error("boom"); },
        sendAttemptedNow: async () => { throw new Error("db is down"); },
    });
    await runIntakeWorker(h.deps);
    assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})));
});

// ── An inline STAGING orphan is not waiting for a URL (round-15 item 3) ────

test("a row that never had a signed URL gets the SWEEP threshold, not the URL TTL", () => {
    // The single-shot path writes its bytes through the server inside one
    // request: such a row is either published or it failed mid-request. Giving
    // it the two-hour signed-URL grace made every inline orphan invisible to the
    // sweep for two hours, waiting on a URL that does not exist.
    const inlineAge = (minutes: number) => ({
        uploadUrlExpiresAt: null,
        createdAt: new Date(NOW.getTime() - minutes * 60_000),
    });
    assert.equal(uploadLeaseActive(inlineAge(5), NOW), true, "still inside the sweep threshold");
    assert.equal(uploadLeaseActive(inlineAge(20), NOW), false, "past it — an orphan now, not in 2 hours");
    assert.equal(uploadLeaseActive(inlineAge(90), NOW), false);

    // A two-step row is still judged by the promise /start actually made.
    assert.equal(
        uploadLeaseActive({
            uploadUrlExpiresAt: new Date(NOW.getTime() + 60_000),
            createdAt: new Date(NOW.getTime() - 90 * 60_000),
        }, NOW),
        true,
        "an old row with a live lease is still uploading",
    );
});

test("the sweep query excludes live leases and orders null-lease rows first", () => {
    const sweeper = readFileSync(
        path.join(__dirname, "..", "src/app/api/cron/receipt-intake-worker/route.ts"),
        "utf8",
    );
    const fn = sweeper.slice(sweeper.indexOf("sweepStaleStaging: async"));
    const query = fn.slice(0, fn.indexOf("let published"));
    // Filtered in SQL, not skipped in the loop: a handful of clients still
    // uploading could otherwise fill all ten slots every pass, so the orphans
    // behind them were never reached.
    assert.match(query, /uploadUrlExpiresAt: null/);
    assert.match(query, /uploadUrlExpiresAt: \{ lte: sweptAt \}/);
    assert.match(query, /orderBy: \[/);
    assert.match(query, /\{ uploadUrlExpiresAt: \{ sort: "asc", nulls: "first" \} \}/);
    assert.match(query, /\{ createdAt: "asc" \}/);
    assert.match(query, /take: STAGING_SWEEP_BATCH/);
});
