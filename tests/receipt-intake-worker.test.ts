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
    storageTimeoutRun,
    uploadLeaseExpiry,
    SIGNED_UPLOAD_TTL_MS,
    readBudgetFor,
    READ_MIN_BUDGET_MS,
    READ_SAFETY_MARGIN_MS,
    claimableStates,
    eligibleClaimWhere,
    BATCH_SIZE,
    DRYRUN_PARK_RETRY_MS,
    QBO_WRITING_STATES,
} from "../src/lib/receipt-intake/worker";
import { preservedTaxWarning } from "../src/lib/receipt-intake/route-state";
import { normalizeDocType, READ_BUDGET_MS, type ReadOutcome } from "../src/lib/receipt-intake/read";
import type { BookResult } from "../src/lib/receipt-intake/book";
import type { CutoverRequest } from "../src/lib/receipt-intake/worker";
import { QBTimeoutError } from "../src/lib/quickbooks";
import {
    downloadReceiptObject,
    storageBudgetMs,
    STORAGE_CALL_MAX_MS,
} from "../src/lib/receipt-intake/bucket";
import { QboAccountConfigError, QboPurchaseFaultError } from "../src/lib/qbo-receipt-push";

import { Prisma } from "@prisma/client";

const PrismaKnownError = Prisma.PrismaClientKnownRequestError;
const NOW = new Date("2026-09-01T12:00:00.000Z");
/** The token this pass claims with. A row carrying anything else is a successor's. */
const LIVE_TOKEN = "claim-1";

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
        claimToken: LIVE_TOKEN,
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
    finished: {
        id: string;
        claimToken: string | null;
        stateReason: string | null;
        /** The DURABLE marker routing wrote, distinct from the display copy. */
        taxWarning: string | null;
    }[];
    deferred: { id: string; busyPasses: number }[];
    retried: { id: string; attempts: number; reason: string }[];
    releasedClaims: { id: string; nextRetryAt: Date }[];
    releasedUnprocessed: { id: string; claimToken: string | null }[];
    leaseAcquires: number;
    leaseReleases: number;
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
        retried: [], releasedClaims: [], releasedUnprocessed: [], leaseAcquires: 0, leaseReleases: 0,
        claimOpts: [], sweepCalls: 0, cleanupCalls: 0, bookBudgets: [], clock: 0,
        sendReads: [],
        boundary: new Date("2026-08-25T00:00:00.000Z"),
        deps: null as unknown as WorkerDependencies,
    };
    h.deps = {
        // The default harness always gets the lease. The tests that care about
        // overlap override it.
        acquireLease: async () => {
            h.leaseAcquires++;
            return { release: async () => { h.leaseReleases++; } };
        },
        claim: async opts => {
            h.claimOpts.push(opts);
            return { rows, shadowRetired: 0, requeued: 0, shadowQuarantined: 0, shadowSkippedMoved: 0 };
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
        finishRouting: async (id, claimToken, stateReason, taxWarning) => {
            h.finished.push({ id, claimToken, stateReason, taxWarning });
        },
        companyTimeZone: async () => "America/Los_Angeles",
        promoteToBooking: async id => { h.promoted.push(id); return { promoted: true }; },
        book: async () => {
            h.books++;
            return { outcome: "booked", qbPurchaseId: "QB-1", expenseId: "e1", alreadyExisted: false } as BookResult;
        },
        applyBookResult: async () => {},
        deferRead: async (id, busyPasses) => { h.deferred.push({ id, busyPasses }); return true; },
        releaseClaim: async (id, nextRetryAt) => { h.releasedClaims.push({ id, nextRetryAt }); return true; },
        // Token-fenced in the real implementation; here it just records what
        // was handed back, and reports the rows whose token still matches.
        releaseUnprocessed: async released => {
            h.releasedUnprocessed.push(...released);
            return released.filter(r => r.claimToken === LIVE_TOKEN).length;
        },
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
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null, taxWarning: null }]);
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
    const h = harness([workerRow({ state: "READ", dryRun: false })], { isDryRunEnabled: () => false });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(h.promoted, ["row-1"]);
    assert.equal(h.books, 1);
    assert.deepEqual(summary.byState, { BOOKED: 1 });
});

test("the global kill switch parks a dryRun=false row at READ, not just BOOKING", async () => {
    // The row's persisted flag is snapshotted once at intake, so it is not
    // itself a kill switch: reverting RECEIPT_INTAKE_DRYRUN to stop live QBO
    // writes must still stop rows claimed dryRun=false before the switch was
    // reverted — the row flag alone must never be trusted over the current
    // global switch.
    const h = harness([workerRow({ state: "READ", dryRun: false })], { isDryRunEnabled: () => true });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(h.promoted, [], "never even promoted to BOOKING");
    assert.equal(h.books, 0, "the QBO purchase path is never called");
    assert.deepEqual(summary.byState, { READ: 1 });
});

test("the global kill switch parks a dryRun=false row already at BOOKING", async () => {
    const h = harness([workerRow({ state: "BOOKING", dryRun: false })], { isDryRunEnabled: () => true });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.books, 0, "the QBO purchase path is never called");
    assert.deepEqual(summary.byState, { BOOKING: 1 });
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
    assert.equal(h.claimOpts[0].dryRunGlobal, true);
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
            return { rows: [], shadowRetired: 7, requeued: 2, shadowQuarantined: 0, shadowSkippedMoved: 0 };
        },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.claimOpts[0].dryRunGlobal, false);
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
            return { rows: [], shadowRetired: 0, requeued: 0, shadowQuarantined: 0, shadowSkippedMoved: 0 };
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

    // ...AND THE TWO IT NEVER REACHED ARE HANDED BACK.
    //
    // The claim stamps all ten rows with a ten-minute lease. A row the loop
    // never touched that keeps that lease AND its claim token is invisible to
    // the next cron five minutes later — `eligibleClaimWhere` skips a future
    // `nextRetryAt`, and every fenced write misses a token no live pass holds.
    // A batch that spent its budget on row 3 sat on seven untouched receipts
    // for the rest of the ten minutes.
    assert.deepEqual(
        h.releasedUnprocessed.map(r => r.id),
        ["row-4", "row-5"],
        "exactly the rows nothing was attempted against — the processed ones release themselves",
    );
    assert.equal(summary.releasedUnprocessed, 2);
});

test("the release is FENCED: a row whose token changed is handed to the release and refused by it", async () => {
    // The fence lives in the UPDATE's where clause, so what this proves at the
    // worker level is that the token the pass claimed with travels with the
    // row — a release keyed on the id alone would clear a claim a successor
    // now holds.
    const rows = [
        workerRow({ id: "row-1" }),
        workerRow({ id: "row-2" }),
        // Taken over between the claim and the deadline.
        workerRow({ id: "row-3", claimToken: "claim-2" }),
    ];
    const h = harness(rows, {
        read: async () => { h.clock += 45_000; h.reads++; return goodRead; },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.processed, 1);
    assert.deepEqual(
        h.releasedUnprocessed,
        [{ id: "row-2", claimToken: LIVE_TOKEN }, { id: "row-3", claimToken: "claim-2" }],
        "the release is told each row's own token, not just its id",
    );
    assert.equal(summary.releasedUnprocessed, 1, "only the row this pass still owns was released");
});

test("no deadline, no release call: a batch that finishes hands nothing back", async () => {
    const h = harness([workerRow(), workerRow({ id: "row-2" })]);
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.processed, 2);
    assert.equal(summary.deferredToNextRun, undefined);
    assert.deepEqual(h.releasedUnprocessed, [], "every row completed under its own transition");
    assert.equal(summary.releasedUnprocessed, undefined);
});

test("a failing release never takes the pass down with it", async () => {
    const rows = [1, 2, 3].map(n => workerRow({ id: `row-${n}` }));
    const h = harness(rows, {
        read: async () => { h.clock += 45_000; h.reads++; return goodRead; },
        releaseUnprocessed: async () => { throw new Error("db blip"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.deferredToNextRun, 2, "the rows are still reported as deferred");
    assert.equal(summary.releasedUnprocessed, undefined, "and honestly reported as NOT released");
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
            isDryRunEnabled: () => false,
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
    ], { isDryRunEnabled: () => false });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(h.books, 2);
    assert.deepEqual(summary.byState, { BOOKED: 2 });
});

test("a weak-key twin already BOOKING blocks the transition and asks a human", async () => {
    const h = harness([workerRow({ state: "READ", dryRun: false, dedupWeakKey: "lowes|2026-08-03|364.98|amt" })], {
        isDryRunEnabled: () => false,
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

// ── A failure AFTER the READ -> BOOKING promotion (Codex round-36 item 1) ────
//
// The promotion COMMITS a state change mid-row. Every recovery write is CAS'd
// on the row's {state, claimToken}, so handing the error path the row as it was
// CLAIMED pinned "READ" against a database that now said "BOOKING": zero rows
// matched, `attempts` never moved, and the row came back next pass to fail the
// same way forever without ever reaching max-retries.

/**
 * A harness whose recovery writes really evaluate the CAS, against a database
 * state the promotion actually moves. Without that the fakes accept any
 * ownership and the bug is invisible — which is how it survived 35 rounds.
 */
type Ownership = { state: string; claimToken: string | null };

function promotedHarness(row: WorkerRow, thrown: unknown) {
    const db: Ownership = { state: row.state, claimToken: row.claimToken };
    const seen: Ownership[] = [];
    /** What `updateMany({ where: { id, state, claimToken } })` would match. */
    const wouldMatch = (o: Ownership) => o.state === db.state && o.claimToken === db.claimToken;
    const cas = (ownership: Ownership) => {
        seen.push(ownership);
        return wouldMatch(ownership);
    };
    const h = harness([row], {
        isDryRunEnabled: () => false,
        promoteToBooking: async id => {
            h.promoted.push(id);
            db.state = "BOOKING";
            return { promoted: true };
        },
        book: async () => { throw thrown; },
        retryRow: async (id, attempts, _next, reason, ownership) => {
            if (!cas(ownership)) return false;
            h.retried.push({ id, attempts, reason });
            return true;
        },
        applyState: async (id, state, reason, patch, ownership) => {
            if (!cas(ownership!)) return false;
            h.states.push({ id, state, reason, patch, ownership });
            return true;
        },
    });
    return { h, db, seen, wouldMatch };
}

test("a throw right after the promotion spends an attempt against the BOOKING row", async () => {
    const row = workerRow({ state: "READ", dryRun: false, attempts: 2 });
    const { h, db, seen, wouldMatch } = promotedHarness(row, new Error("connection reset"));

    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { RETRY: 1 }, "retried, not silently stale");
    assert.equal(h.retried.length, 1);
    assert.equal(h.retried[0].attempts, 3, "the attempt actually landed");
    assert.equal(db.state, "BOOKING", "the promotion committed");
    assert.deepEqual(seen[0], { state: "BOOKING", claimToken: LIVE_TOKEN }, "the CAS pinned the CURRENT state");

    // THE CONTROL. The old code passed the row as CLAIMED, so its CAS pinned
    // "READ" — assert directly that such a write would have matched zero rows.
    // Without this the assertion above would also pass for a harness that
    // ignored the CAS entirely, which is what let the bug live for 35 rounds.
    assert.equal(
        wouldMatch({ state: row.state, claimToken: row.claimToken }),
        false,
        "the pre-promotion ownership matches nothing once the promotion has committed",
    );
});

test("at the ceiling, a post-promotion failure PARKS instead of cycling forever", async () => {
    // The consequence of the bug, not just its mechanism: with attempts frozen
    // the row could never reach MAX_BOOK_ATTEMPTS, so the terminal park that
    // puts it in front of a person was unreachable.
    const row = workerRow({ state: "READ", dryRun: false, attempts: 19 });
    const { h, seen } = promotedHarness(row, new Error("connection reset"));

    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].reason, "max-retries");
    assert.deepEqual(seen.at(-1), { state: "BOOKING", claimToken: LIVE_TOKEN });
});

test("a CLASSIFIED QBO fault after the promotion parks under the BOOKING state too", async () => {
    // The terminal branch takes the same row, so it needs the same fix — and a
    // qbo-fault park is the one that must NOT be lost: it means a send happened.
    const row = workerRow({ state: "READ", dryRun: false });
    const { h } = promotedHarness(row, new QboAccountConfigError("bad account"));

    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { NEEDS_REVIEW: 1 });
    assert.match(h.states[0].reason!, /^qbo-fault:/);
    assert.deepEqual(h.states[0].ownership, { state: "BOOKING", claimToken: LIVE_TOKEN });
});

test("a row claimed AT BOOKING is unaffected — its state never moves mid-pass", async () => {
    // The control for the change itself: only the READ branch promotes, so the
    // BOOKING branch must still CAS on the state it was claimed with.
    const row = workerRow({ state: "BOOKING", dryRun: false, attempts: 0 });
    const { h, seen } = promotedHarness(row, new Error("connection reset"));

    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { RETRY: 1 });
    assert.deepEqual(h.promoted, [], "no promotion happens on this branch");
    assert.deepEqual(seen[0], { state: "BOOKING", claimToken: LIVE_TOKEN });
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
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null, taxWarning: null }]);
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
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null, taxWarning: null }]);
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
    assert.deepEqual(h.finished, [{
        id: "row-1",
        claimToken: "claim-1",
        stateReason: "tax-implausible",
        // AND IN ITS OWN COLUMN. `stateReason` is a display copy that every
        // deferred booking and every park overwrites; this one is durable.
        taxWarning: "tax-implausible",
    }]);
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
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: "tax-implausible", taxWarning: "tax-implausible" }]);
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
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null, taxWarning: null }]);
});

test("a tax equal to the total is refused end to end", async () => {
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, taxAmount: "364.98" } } as ReadOutcome),
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.applied[0].taxCents, null);
    assert.equal(h.applied[0].totalCents, 36498, "the total is untouched");
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: "tax-implausible", taxWarning: "tax-implausible" }]);
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
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "claim-1", stateReason: null, taxWarning: null }]);
});

test("a row with no job at claim time AND none at routing time still parks", async () => {
    // The control for the test above: the re-read is a re-read, not a way to
    // pretend every row has a job.
    const h = harness([workerRow({ projectId: null })], { refreshProjectId: async () => null });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_JOB: 1 });
});

test("a failing re-read falls back to the claimed value instead of losing the row", async () => {
    // The snapshot ALREADY names a job, so the fallback asserts something the
    // row itself recorded and a late assignment can only have refined. The
    // routing gate asks whether a job exists at all, so the stale answer and the
    // fresh one agree — this one may stand.
    const h = harness([workerRow({ projectId: "proj-1" })], {
        refreshProjectId: async () => { throw new Error("pool exhausted"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { READ: 1 });
});

test("RACE: a DB blip during the read must not park an assigned receipt NEEDS_JOB", async () => {
    // The interleaving: the pass claims a row with no project and spends ~25s
    // in the reader. A person assigns the job in that window, and the re-read
    // that would have SEEN it throws (a pool timeout, a dropped connection).
    //
    // Swallowing the throw turned a transient fault into a routing decision:
    // the fallback is the CLAIMED snapshot, which by definition predates the
    // assignment, so it asserted "still unassigned" — exactly the fact the
    // failed call was supposed to establish — and parked the receipt NEEDS_JOB
    // for a job it already had. The person sees their own assignment ignored,
    // and the row waits for a human nothing will summon.
    const h = harness([workerRow({ projectId: null })], {
        refreshProjectId: async () => { throw new Error("pool exhausted"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { RETRY: 1 }, "the normal retry path, not a verdict");
    assert.deepEqual(h.states, [], "nothing was parked");
    assert.equal(h.retried.length, 1, "with a backoff and an attempt spent");
    assert.equal(h.retried[0].attempts, 1);
    assert.match(h.retried[0].reason, /project-refresh-unavailable/);
});

test("the control: a re-read that ANSWERS 'no job' still parks NEEDS_JOB", async () => {
    // The fix must not turn every unassigned receipt into an infinite retry.
    // An answered null is a decision; only a FAILED call is a transient.
    const h = harness([workerRow({ projectId: null })], { refreshProjectId: async () => null });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_JOB: 1 });
    assert.deepEqual(h.retried, []);
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
    assert.equal(summary.deferredToNextRun, 2, "neither row was reached");
    // A deadline BEFORE the first row releases the whole batch: not one of
    // them was looked at, so all ten minutes of their lease would otherwise be
    // spent on rows nothing ever considered.
    assert.deepEqual(h.releasedUnprocessed.map(r => r.id), ["row-1", "row-2"]);
    assert.equal(summary.releasedUnprocessed, 2);
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
            return { rows: [], shadowRetired: 4, requeued: 2, shadowQuarantined: 3, shadowSkippedMoved: 0 };
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
    assert.deepEqual(h.finished, [{ id: "row-1", claimToken: "token-abc", stateReason: null, taxWarning: null }]);
});

// ── A successor reclaiming mid-flight (Phase 2 gate) ───────────────────────

test("a predecessor superseded before promotion writes nothing and books nothing", async () => {
    const h = harness([workerRow({ state: "READ", dryRun: false, claimToken: "old-token" })], {
        isDryRunEnabled: () => false,
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
        isDryRunEnabled: () => false,
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
        isDryRunEnabled: () => false,
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

test("/start stamps a lease on every url it issues, including a live-lease retry", () => {
    const start = readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/start/route.ts"),
        "utf8",
    );
    // Four branches, four lease stamps: the new row, the re-armed park, the
    // resumed STAGING upload, AND a retry against a still-live lease. A URL
    // handed out without a lease extension is one the sweeper cannot see coming
    // — a resigned URL for an unexpired lease is good for a fresh ~2h window,
    // so leaving the row's recorded expiry at its OLD value let the sweeper
    // judge the lease dead while the client still held a perfectly live URL.
    //
    // Three of them are here; the fourth is the shared live-lease rule, which
    // now serves BOTH resumable states from one place (upload-lease.ts) and
    // takes the same clock as an injected dependency.
    // The create branch holds its stamp in a const, because the signer-failure
    // discard CASes on that EXACT value and a second uploadLeaseExpiry() call
    // would compare a fresh instant against the stored one; the other two stamp
    // inline.
    assert.match(start, /const leaseExpiresAt = uploadLeaseExpiry\(\);/);
    assert.match(start, /uploadUrlExpiresAt: leaseExpiresAt,/, "the new row still gets a lease");
    assert.equal(
        (start.match(/uploadUrlExpiresAt: uploadLeaseExpiry\(\)/g) ?? []).length,
        2,
        "re-arm and resume stamp the lease inline",
    );
    assert.match(start, /expiresAt: uploadLeaseExpiry,/, "and the shared rule is given the same clock");
    const lease = readFileSync(
        path.join(__dirname, "..", "src/lib/receipt-intake/upload-lease.ts"),
        "utf8",
    );
    assert.match(
        lease,
        // Through extendedExpiry, which forces the written instant PAST the
        // one it found: an extension moves nothing else, so the expiry is
        // the only witness the signer-failure discard has.
        /uploadUrlExpiresAt: extendedExpiry\(observed\.uploadUrlExpiresAt, deps\.expiresAt\(\)\),/,
        "the shared rule stamps it too",
    );
    // And the ADOPTION GENERATION alongside it, on every one of the four. The
    // expiry alone cannot identify a lease -- a reuse writes the same "now + 2h"
    // the original issue did, so the discard CAS pins this instead.
    // Hoisted now, because /finalize requires the generation its URL was
    // issued under and the caller has to hand it back — so the value written
    // to the row and the value returned to the client must be the SAME draw,
    // not two calls to the generator.
    // AN EXTENSION KEEPS the generation it adopted -- see the round-19 note
    // in upload-lease.ts. Only a row that never had one (a legacy row, null)
    // draws a fresh value, and the CAS pins the null so exactly one writer
    // mints it.
    assert.match(lease, /const uploadLease = observed\.uploadLeaseNonce \?\? \(deps\.nonce \?\? newLeaseNonce\)\(\);/);
    assert.match(lease, /uploadLeaseNonce: uploadLease,/);
    assert.match(lease, /signed: \{ \.\.\.signed, uploadLease \}/);
    // Both destructive branches still stamp a FRESH generation — hoisted into
    // a const now, for the same reason as the reuse path: /finalize requires
    // the generation, so the response has to echo the value that was written.
    assert.match(start, /const rearmedLease = newLeaseNonce\(\);/);
    assert.match(start, /const resumedLease = newLeaseNonce\(\);/);
    assert.equal(
        (start.match(/uploadLeaseNonce: (rearmedLease|resumedLease),/g) ?? []).length,
        2,
        "the re-arm and the resume each write the generation they minted",
    );
    assert.equal(
        (start.match(/uploadLease: (rearmedLease|resumedLease),/g) ?? []).length,
        2,
        "...and each hands that same value back",
    );
    assert.equal(
        (start.match(/uploadLeaseNonce: leaseNonce/g) ?? []).length,
        2,
        "and the create holds ITS generation in a const, because the discard CAS pins that exact value",
    );
    const signed = (start.match(/await signUpload\(/g) ?? []).length;
    assert.equal(signed, 3, "one signUpload call per inline branch");
    // ...and it is the ONE issuer that asks for an upsert-capable token, because
    // it re-signs an EXISTING path so a client can replace its own partial
    // upload. Every other issuer signs a path a version bump has just made new.
    assert.match(
        lease,
        /await deps\.sign\(path, \{ upsert: true \}\)/,
        "the shared rule signs the path it kept, with the overwrite capability it needs",
    );
    // The liveness test is its OWN predicate now, because two different
    // answers used to collapse into liveLeasePath's null: "nothing live here,
    // take a new lease" and "there IS a live lease, but for a different file
    // type". The second is a refusal -- repathing it orphans an object whose
    // URL is still in somebody's hands.
    assert.match(
        lease,
        /export function hasLiveLease\(row: LeaseRow, now: number = Date\.now\(\)\): boolean \{/,
        "the live-lease retry is gated on the lease still being live",
    );
    assert.match(
        lease,
        /return !!row\.uploadUrlExpiresAt && row\.uploadUrlExpiresAt\.getTime\(\) > now;/,
        "and the gate is an expiry comparison, not a proxy for one",
    );
    assert.match(
        lease,
        /if \(hasLiveLease\(observed, at\)\) \{[\s\S]{0,300}?kind: \"identity-conflict\"/,
        "a live lease this request disagrees with is refused, never repathed",
    );
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
        isDryRunEnabled: () => false,
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
        isDryRunEnabled: () => false,
        book: async () => { throw new Error("connection reset"); },
    });
    h.persistedSendAttempted = false;
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].patch?.dedupStrongKey, null);
});

test("an unreadable send flag RETAINS the key", async () => {
    // Retaining costs a review item; releasing wrongly costs a second Purchase.
    const h = harness([workerRow({ state: "READ", dryRun: false, sendAttempted: false, attempts: 19 })], {
        isDryRunEnabled: () => false,
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

// ── Dry-run ROLLBACK starvation (Codex a2998e8a, finding 1) ──────────────────
//
// The hole the last round left: booking learned to honour the CURRENT global
// switch, but claim ELIGIBILITY still only excluded rows whose PERSISTED
// dryRun was true. Flip RECEIPT_INTAKE_DRYRUN back on after a live window and
// every row claimed during that window is still `dryRun:false`, still sitting
// in READ/BOOKING, and still claimable — so each pass filled its ten-row batch
// with rows it then refused to advance (without even releasing the claim), and
// the newer RECEIVED receipts behind them were never read.

test("claimable states are a function of the CURRENT switch, not the row flag", () => {
    assert.deepEqual(
        claimableStates(true),
        ["RECEIVED"],
        "under dry-run nothing whose next step is a QBO write may be claimed",
    );
    assert.deepEqual(claimableStates(false), ["RECEIVED", "READ", "BOOKING"]);
    // The two lists differ by exactly the QBO-writing states — spelled out so a
    // future state added to one list cannot silently skip the other.
    assert.deepEqual([...QBO_WRITING_STATES], ["READ", "BOOKING"]);
});

test("the claim predicate drops the QBO-writing states while dry-run is on", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");

    const dry = eligibleClaimWhere(now, true) as Record<string, unknown>;
    assert.deepEqual(dry.state, { in: ["RECEIVED"] });

    const live = eligibleClaimWhere(now, false) as Record<string, unknown>;
    assert.deepEqual(live.state, { in: ["RECEIVED", "READ", "BOOKING"] });
    // The shadow-week park exclusion survives the change: a dryRun=true row at
    // READ/BOOKING is still off the list on a LIVE pass until the cutover
    // requeues it.
    assert.deepEqual(live.NOT, { AND: [{ dryRun: true }, { state: { in: ["READ", "BOOKING"] } }] });
    // And the retry clause is untouched by any of it.
    assert.deepEqual(live.OR, [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }]);
});

/**
 * A queue with more than two full batches of OLD rows left live by a previous
 * window, plus newer RECEIVED receipts behind them.
 *
 * The fake claim is deliberately built on the SHIPPED `claimableStates` rather
 * than a hand-written state list, so this test measures the real predicate. The
 * `states` override is what lets the same fixture reproduce the BUG (the old
 * predicate, which ignored the switch) as a control.
 */
function starvationQueue(opts: { states?: (dryRunGlobal: boolean) => string[] } = {}) {
    const pickStates = opts.states ?? claimableStates;
    const rows: WorkerRow[] = [];
    // 25 old rows — two and a half batches — left at READ with dryRun=false by
    // a live window that has since been rolled back.
    for (let i = 0; i < 25; i++) {
        rows.push(workerRow({
            id: "old-" + i,
            sourceRef: "drive:OLD" + i,
            state: "READ",
            dryRun: false,
            createdAt: new Date(Date.parse("2026-08-20T00:00:00.000Z") + i * 60_000),
        }));
    }
    // Three receipts that arrived AFTER the rollback. These are the ones the
    // shadow week is supposed to keep reading.
    for (let i = 0; i < 3; i++) {
        rows.push(workerRow({
            id: "new-" + i,
            sourceRef: "drive:NEW" + i,
            state: "RECEIVED",
            dryRun: true,
            createdAt: new Date(Date.parse("2026-08-30T00:00:00.000Z") + i * 60_000),
        }));
    }

    const nextRetryAt = new Map<string, number>();
    let clock = Date.parse("2026-09-01T12:00:00.000Z");

    return {
        rows,
        advanceMinutes(mins: number) { clock += mins * 60_000; },
        /** The route's claim, in memory: same predicate, same oldest-first order, same lease. */
        claim: async (o: CutoverRequest) => {
            const eligible = new Set(pickStates(o.dryRunGlobal));
            const due = rows
                .filter(r => eligible.has(r.state))
                .filter(r => (nextRetryAt.get(r.id) ?? 0) <= clock)
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                .slice(0, BATCH_SIZE);
            // The claim bumps every taken row's nextRetryAt by the lease.
            for (const r of due) nextRetryAt.set(r.id, clock + 10 * 60_000);
            return { rows: due, shadowRetired: 0, requeued: 0, shadowQuarantined: 0, shadowSkippedMoved: 0 };
        },
        /** What the worker's own release writes back. */
        release: async (id: string, when: Date) => { nextRetryAt.set(id, when.getTime()); return true; },
    };
}

test("ROLLBACK: newer receipts are read on the FIRST pass, not starved behind the old backlog", async () => {
    const q = starvationQueue();
    const readIds: string[] = [];
    const h = harness(q.rows, {
        isDryRunEnabled: () => true,
        claim: q.claim,
        releaseClaim: q.release,
    });
    // Record which rows actually reach the reader.
    h.deps.applyRead = async (id, patch) => {
        readIds.push(id);
        h.applied.push(patch as ReadPatch);
        return { owned: true, strongOwner: null };
    };

    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(
        readIds.slice().sort(),
        ["new-0", "new-1", "new-2"],
        "all three post-rollback receipts are read in the first invocation",
    );
    assert.equal(summary.processed, 3, "the old live rows never even occupy a batch slot");
    assert.equal(h.books, 0, "and nothing books while the switch says dry-run");
});

test("ROLLBACK control: the OLD predicate really did starve them (two full batches deep)", async () => {
    // Without this control the test above would pass against a queue that
    // simply had no old rows in it. Here the ONLY difference is the predicate:
    // the pre-fix one, which looked at the persisted flag and ignored the
    // switch. Two invocations is already enough to prove the starvation.
    const q = starvationQueue({ states: () => ["RECEIVED", "READ", "BOOKING"] });
    const readIds: string[] = [];
    const h = harness(q.rows, {
        isDryRunEnabled: () => true,
        claim: q.claim,
        // The pre-fix loop skipped without releasing, so the rows kept the
        // full ten-minute lease.
        releaseClaim: async () => true,
    });
    h.deps.applyRead = async (id, patch) => {
        readIds.push(id);
        h.applied.push(patch as ReadPatch);
        return { owned: true, strongOwner: null };
    };

    await runIntakeWorker(h.deps);
    q.advanceMinutes(5);
    await runIntakeWorker(h.deps);

    assert.deepEqual(readIds, [], "twenty old rows fill both batches and no new receipt is reached");
});

test("ROLLBACK is not a black hole: going live again makes the old rows claimable", async () => {
    // Excluding a row from the claim must not strand it. The predicate is
    // evaluated per invocation from the current switch, so the same rows come
    // straight back the moment the switch flips.
    const q = starvationQueue();
    const h = harness(q.rows, { isDryRunEnabled: () => false, claim: q.claim, releaseClaim: q.release });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.processed, BATCH_SIZE, "a live pass claims the old backlog oldest-first again");
    assert.equal(h.books, BATCH_SIZE, "and books it");
});

test("a row the switch refuses RELEASES its claim instead of sitting on it", async () => {
    // Belt-and-braces for the eligibility fix: if the switch is ever read as
    // live at claim time and dry-run inside the loop, the skip must still hand
    // the row back. A skip that kept the claim left the row owned by a pass
    // that had finished — invisible to every fenced write until the lease
    // lapsed, and back in the next batch to be skipped again.
    for (const state of ["READ", "BOOKING"] as const) {
        const h = harness([workerRow({ state, dryRun: false })], { isDryRunEnabled: () => true });
        const summary = await runIntakeWorker(h.deps);
        assert.equal(h.books, 0);
        assert.deepEqual(summary.byState, { [state]: 1 }, state + " is unchanged — nothing is decided");
        assert.equal(h.releasedClaims.length, 1, state + " hands the claim back");
        assert.equal(
            h.releasedClaims[0].nextRetryAt.getTime(),
            NOW.getTime() + DRYRUN_PARK_RETRY_MS,
            "deferred by an hour, so it stops competing for batch slots with new receipts",
        );
    }
});

test("a release that loses its fence reports STALE rather than claiming to have parked", async () => {
    const h = harness([workerRow({ state: "READ", dryRun: false })], {
        isDryRunEnabled: () => true,
        releaseClaim: async () => false,
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { STALE: 1 });
});

// ── Whole-pass overlap lease (Codex a2998e8a, finding 4) ─────────────────────

test("a second invocation that cannot take the lease does NOTHING", async () => {
    const h = harness([workerRow()], { acquireLease: async () => null });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary, { processed: 0, byState: {}, skipped: "lease-held" });
    assert.equal(h.claimOpts.length, 0, "no claim");
    assert.equal(h.sweepCalls, 0, "no sweep");
    assert.equal(h.reads, 0, "no Gemini call");
    assert.equal(h.books, 0, "no QuickBooks call");
});

test("the lease is released on a normal pass", async () => {
    const h = harness([workerRow()]);
    await runIntakeWorker(h.deps);
    assert.equal(h.leaseAcquires, 1);
    assert.equal(h.leaseReleases, 1);
});

test("the lease is released even when the pass throws", async () => {
    // Row errors are caught per row, but a claim/sweep failure propagates. A
    // lease leaked there would wedge the queue for a whole TTL.
    const h = harness([], { claim: async () => { throw new Error("prisma exploded"); } });
    await assert.rejects(() => runIntakeWorker(h.deps), /prisma exploded/);
    assert.equal(h.leaseReleases, 1);
});

// ── No storage call outlives its invocation (Codex round-16 item 1) ────────
//
// Every bucket.ts function used to `await` Supabase with no timeout and no
// abort signal, and the worker's `shouldStop` only runs BETWEEN operations. So
// one hung request ate the whole 60-second lifetime: the platform killed the
// function mid-pass, the rows it had claimed never reached the release path,
// and they sat leased for ten minutes — and because the claim is oldest-first,
// the same object hung the next run too.

test("the budget comes from the caller's deadline, and never exceeds the cap", () => {
    // A call late in a pass gets what is actually LEFT, not a fresh fixed
    // timeout that could straddle the platform ceiling.
    const started = Date.now();
    assert.equal(storageBudgetMs(undefined), STORAGE_CALL_MAX_MS, "no deadline: the cap");
    assert.equal(
        storageBudgetMs({ startedAt: started, budgetMs: 60_000 }),
        STORAGE_CALL_MAX_MS,
        "plenty left: still capped",
    );
    const nearlyOut = storageBudgetMs({ startedAt: started - 57_000, budgetMs: 60_000 });
    assert.ok(nearlyOut > 0 && nearlyOut <= 3_100, `only what is left: ${nearlyOut}`);
    assert.equal(storageBudgetMs({ startedAt: started - 61_000, budgetMs: 60_000 }), 0, "past it: none");
});

/**
 * A Supabase that never answers. `getSupabaseWithSignal` builds its client over
 * the global fetch, so replacing that is what makes a genuinely hung request
 * reachable from a unit test — no network, no timers but ours.
 */
async function withHungStorage<T>(run: () => Promise<T>): Promise<{ out: T; aborted: boolean; fetches: number }> {
    const realFetch = globalThis.fetch;
    const realUrl = process.env.SUPABASE_URL;
    const realKey = process.env.SUPABASE_SERVICE_KEY;
    let aborted = false;
    let fetches = 0;
    process.env.SUPABASE_URL = "https://storage.invalid";
    process.env.SUPABASE_SERVICE_KEY = "test-key";
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => {
        fetches++;
        return new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
            });
        });
    }) as typeof fetch;
    try {
        return { out: await run(), aborted, fetches };
    } finally {
        globalThis.fetch = realFetch;
        if (realUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = realUrl;
        if (realKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = realKey;
    }
}

test("a NEVER-SETTLING storage request returns before the deadline, and is aborted", async () => {
    // The failure, exactly: a request that never answers. Without the guard
    // this await would still be pending when the platform killed the function,
    // so the pass never reached the code that releases its claimed rows.
    const started = Date.now();
    const { out, aborted } = await withHungStorage(() =>
        downloadReceiptObject("receipts/intake/hung.png", { startedAt: started, budgetMs: 1_200 }));
    const elapsed = Date.now() - started;

    assert.equal(out.ok, false);
    assert.equal((out as { kind: string }).kind, "transient", "retryable, never a verdict");
    assert.match(String((out as { message?: string }).message), /storage-timeout/);
    assert.ok(elapsed < 5_000, `returned in ${elapsed}ms rather than hanging`);
    // The socket goes with the promise: a timer that only settled the await
    // would leave the request running against the next invocation's budget.
    assert.equal(aborted, true, "the request was actually aborted");
});

test("a call with no runway left never starts at all", async () => {
    // Spending the pass's last milliseconds on a request whose answer it can
    // never use is how the release path gets skipped.
    const { out, fetches } = await withHungStorage(() =>
        downloadReceiptObject("receipts/intake/a.png", {
            startedAt: Date.now() - 60_000,
            budgetMs: 60_000,
        }));
    assert.equal(out.ok, false);
    assert.match(String((out as { message?: string }).message), /storage-timeout/);
    // THE DISTINGUISHING PROPERTY: no request was made at all. Without the
    // runway check the call is issued with a zero-millisecond timer, which
    // rejects with the same tag — so only the absence of the request tells the
    // two apart, and the point is not to spend the last of the budget on an
    // answer the pass can never use.
    assert.equal(fetches, 0, "no storage request was issued");
});

test("EVERY bucket export takes a deadline and runs under the guard", () => {
    // The audit the finding asked for, as an assertion: a new storage call
    // added without the guard is the same bug back.
    const src = readFileSync(path.join(__dirname, "..", "src/lib/receipt-intake/bucket.ts"), "utf8");
    for (const op of ["list", "download", "upload", "remove", "sign-upload", "sign-download"]) {
        assert.ok(src.includes(`withStorageDeadline("${op}"`), `${op} is guarded`);
    }
    // The unsignalled singleton is unreachable from this file, so nothing here
    // CAN make an unbounded call.
    assert.ok(!/getSupabase\(\)/.test(src), "the unsignalled client is not reachable");
    assert.match(src, /import \{ getSupabaseWithSignal \}/);
    // ...and the guard aborts before it rejects, so the socket goes with it.
    const guard = src.slice(src.indexOf("async function withStorageDeadline"));
    const abortAt = guard.indexOf("controller.abort()");
    const rejectAt = guard.indexOf("reject(new StorageTimeoutError");
    assert.ok(abortAt > 0 && abortAt < rejectAt, "abort precedes the rejection");
});

test("consecutive timeouts are counted, and the run resets on any other failure", () => {
    // The counter lives in `lastError`, so "consecutive" is a property of where
    // it is stored: any other failure writes a different reason there.
    assert.equal(storageTimeoutRun(null), 0);
    assert.equal(storageTimeoutRun("worker-error: connection reset"), 0, "a different fault resets it");
    assert.equal(storageTimeoutRun("storage-timeout:1"), 1);
    assert.equal(storageTimeoutRun("storage-timeout:2"), 2);
    assert.equal(storageTimeoutRun("storage:some other blip"), 0, "a non-timeout storage fault too");
});

test("a row that keeps timing out is PARKED so it stops heading the queue", async () => {
    const hung = { ok: false as const, kind: "transient" as const, message: "storage-timeout:download" };

    // First timeout: retried, and the run is recorded.
    const first = harness([workerRow({ lastError: null })], { downloadBytes: async () => hung });
    assert.deepEqual((await runIntakeWorker(first.deps)).byState, { RETRY: 1 });
    assert.equal(first.retried[0].reason, "storage-timeout:1");

    // Second: still retried, run of two.
    const second = harness([workerRow({ lastError: "storage-timeout:1" })], { downloadBytes: async () => hung });
    assert.deepEqual((await runIntakeWorker(second.deps)).byState, { RETRY: 1 });
    assert.equal(second.retried[0].reason, "storage-timeout:2");

    // Third: parked, with its OWN reason rather than a generic max-retries
    // twenty passes later.
    const third = harness([workerRow({ lastError: "storage-timeout:2" })], { downloadBytes: async () => hung });
    assert.deepEqual((await runIntakeWorker(third.deps)).byState, { NEEDS_REVIEW: 1 });
    assert.equal(third.states[0].reason, "storage-timeout");
});

test("CONTROL: an ordinary transient storage fault still gets all 20 attempts", async () => {
    // Without this, the new ceiling could quietly apply to every storage blip
    // and park good receipts after three.
    const blip = { ok: false as const, kind: "transient" as const, message: "connection reset" };
    const h = harness([workerRow({ attempts: 5, lastError: "storage:connection reset" })], {
        downloadBytes: async () => blip,
    });
    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { RETRY: 1 });
    assert.equal(h.retried[0].attempts, 6);
    assert.match(h.retried[0].reason, /^storage:/);
});

test("the deadline reaches EVERY storage call, not just QuickBooks", () => {
    // The wiring: buildDeps threads the INVOCATION's deadline into every
    // storage call the pass makes, exactly as it does into the QBO client.
    // They are the same deadline, so a pass that has spent fifty of its sixty
    // seconds cannot hand the next call a fresh fifteen.
    const cron = readFileSync(
        path.join(__dirname, "..", "src/app/api/cron/receipt-intake-worker/route.ts"),
        "utf8",
    );
    assert.equal(
        (cron.match(/downloadVerified\(storagePath, expectedSha256, invocationDeadline\)/g) ?? []).length,
        2,
        "both the worker's read and the booking's read",
    );
    // The stale-STAGING sweep's inspection and the publish's seal, too. Both
    // used to be issued with no deadline at all.
    assert.match(cron, /inspectStoredObject\(\s*\n\s*row\.storagePath,\s*\n\s*row\.mimeType,\s*\n\s*invocationDeadline,\s*\n\s*\)/);
    assert.match(cron, /\}, invocationDeadline\);/, "and sealAndPublish takes it as well");
    // ONE deadline per invocation, created once.
    assert.equal(
        (cron.match(/createRouteDeadline\(/g) ?? []).length,
        1,
        "one deadline for the pass, not one per row",
    );
});

// -- The tax warning survives every route to BOOKED (round-20 finding 2) ----
//
// Routing recorded the marker in `stateReason`, and applyBookResult then
// replaced that column with its own reason on the deferred path -- which is
// EVERY row during the disabled-push cutover, because a disabled push is
// exactly a defer. The BOOKED transition read the marker out of whatever the
// column held by then, so an automatically booked receipt with a bad tax read
// became indistinguishable from one with a clean read. The evidence has its
// own column now.

test("tax-implausible -> DEFERRED -> BOOKED keeps the marker", async () => {
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, taxAmount: "292.00" } } as ReadOutcome),
    });
    await runIntakeWorker(h.deps);

    // What routing durably wrote.
    const routed = h.finished[0];
    assert.equal(routed.taxWarning, "tax-implausible");

    // The deferred booking, exactly as applyBookResult performs it: the
    // stateReason column is replaced with the defer reason. Nothing writes
    // taxWarning.
    const afterDefer = {
        taxWarning: routed.taxWarning,
        stateReason: "push-disabled",
    };

    // ...and the BOOKED transition still finds it.
    assert.equal(preservedTaxWarning(afterDefer), "tax-implausible");

    // PRE-FIX CONTROL: reading the display copy alone, which is what shipped.
    assert.equal(
        preservedTaxWarning({ stateReason: afterDefer.stateReason }),
        null,
        "the old source of truth reports a clean tax read on a receipt that had none",
    );
});

test("tax-implausible -> QBO REVIEW park keeps the marker too", async () => {
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, taxAmount: "292.00" } } as ReadOutcome),
    });
    await runIntakeWorker(h.deps);
    const routed = h.finished[0];

    // A park writes its own reason into stateReason, the same way.
    const parked = {
        taxWarning: routed.taxWarning,
        stateReason: "qbo-fault:6240",
    };
    assert.equal(preservedTaxWarning(parked), "tax-implausible");
    assert.equal(preservedTaxWarning({ stateReason: parked.stateReason }), null, "the control");

    // And a receipt whose tax read was CLEAN never acquires one.
    const clean = harness([workerRow()]);
    await runIntakeWorker(clean.deps);
    assert.equal(clean.finished[0].taxWarning, null);
    assert.equal(
        preservedTaxWarning({ taxWarning: clean.finished[0].taxWarning, stateReason: "push-disabled" }),
        null,
    );
});

test("every routing exit carries the durable marker, not just the READ one", async () => {
    // The gated and dedup exits go through applyState with the read patch, so
    // the marker rides in `base` rather than being added per branch -- one
    // place, and a new exit gets it for free.
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, taxAmount: "292.00" } } as ReadOutcome),
        findWeakHit: async () => ({ id: "row-twin" }),
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "weak-dup:row-twin;tax-implausible", "the display copy");
    assert.equal(
        (h.states[0].patch as { taxWarning?: string | null }).taxWarning,
        "tax-implausible",
        "and the durable one, in the same write",
    );
});
