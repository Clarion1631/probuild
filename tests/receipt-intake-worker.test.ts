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
    recoverStrongKey,
    toDateStr,
    type StrongOwner,
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
// THE REAL weak net, run by the promotion fake below: the strong net's human
// override is only an exit if this function honours it too.
import { judgeWeakGroup, type WeakVerdict } from "../src/lib/receipt-intake/weak-net";
// The call-site contract the date gate reads: see the fallback test below.
import { dedupKeys } from "../src/lib/receipt-intake/keys";
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
        costCodeSource: null,
        suggestedCostCodeId: null,
        suggestedConfidence: null,
        taxAtSource: false,
        installedAtCustomer: null,
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
        sendAttempted: false,
        claimToken: LIVE_TOKEN,
        fileSha256: "s".repeat(64),
        stateReason: null,
        // The three columns the strong-key heal reads. Null is the shape that
        // MATTERS: it is how a row revived by a human reaches booking.
        dedupStrongKey: null,
        readJson: null,
        duplicateOfId: null,
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
    /** Every strong-key claim the heal attempted, with the ownership it CAS'd on. */
    strongClaims: { id: string; key: string; ownership: { state: string; claimToken: string | null } }[];
    /** The row as `book` was actually handed it — the heal's result has to reach here. */
    bookedRows: WorkerRow[];
}

function harness(rows: WorkerRow[], overrides: Partial<WorkerDependencies> = {}): Harness {
    const h: Harness = {
        reads: 0, books: 0, applied: [], states: [], promoted: [], finished: [], deferred: [],
        retried: [], releasedClaims: [], releasedUnprocessed: [], leaseAcquires: 0, leaseReleases: 0,
        claimOpts: [], sweepCalls: 0, cleanupCalls: 0, bookBudgets: [], clock: 0,
        sendReads: [], strongClaims: [], bookedRows: [],
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
        // The default is the common case: the key was free and the claim took it.
        claimStrongKey: async (id, key, ownership) => {
            h.strongClaims.push({ id, key, ownership });
            return { owned: true, strongOwner: null };
        },
        findWeakGroup: async () => [],
        applyState: async (id, state, reason, patch, ownership) => {
            h.states.push({ id, state, reason, patch, ownership });
            return true;
        },
        finishRouting: async (id, claimToken, stateReason, taxWarning) => {
            h.finished.push({ id, claimToken, stateReason, taxWarning });
        },
        companyTimeZone: async () => "America/Los_Angeles",
        promoteToBooking: async id => { h.promoted.push(id); return { promoted: true }; },
        book: async row => {
            h.books++;
            h.bookedRows.push(row as WorkerRow);
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

test("a row OTHER rows are filed behind is never reclassified DUPLICATE", async () => {
    /**
     * Codex PR #443 gate round 39, finding 2. The strong-key owner was claimed
     * while this row was still routing, so routing reaches DUPLICATE — but
     * another row is already filed as a duplicate OF this one, and parking it
     * here leaves that row pointing at a copy. The manual path refuses to build
     * that chain; the worker must not build it either.
     */
    const h = harness([workerRow()], {
        applyRead: async () => ({ owned: true, strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" } }),
        // The cron's own shape (round-40 gate, finding 1): ONE call that takes
        // the lock, decides, and writes — never a fact the worker acts on later.
        applyDuplicateTransition: async (rowId, decision, patch) => {
            const inbound = rowId === "row-1" ? ["row-9"] : [];
            const state = inbound.length === 0 ? decision.state : "NEEDS_REVIEW";
            h.states.push({
                id: rowId,
                state,
                reason: inbound.length === 0 ? decision.stateReason : `duplicate-chain:${inbound.join(",")}`,
                patch,
                ownership: { state: "RECEIVED", claimToken: "claim-1" },
            });
            return { owned: true, state };
        },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 }, "a human decides which receipt is the original");
    assert.equal(h.states[0].state, "NEEDS_REVIEW");
    assert.match(String(h.states[0].reason), /duplicate-chain:row-9/, "and the reason names what to unmark");
    assert.equal(
        h.states[0].patch?.duplicateOfId, "row-owner",
        "the match it found is kept as the evidence for that decision",
    );
});

test("PRE-FIX CONTROL: with nothing filed behind it, the same row still routes to DUPLICATE", async () => {
    // The guard narrows nothing else: this is the identical setup with no
    // inbound reference, and it is the behaviour the test above changed.
    const h = harness([workerRow()], {
        applyRead: async () => ({ owned: true, strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" } }),
        applyDuplicateTransition: async (_rowId, decision) => ({ owned: true, state: decision.state }),
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { DUPLICATE: 1 });

    // And a caller that does not wire the dependency at all keeps the old
    // behaviour rather than crashing — the cron wires it.
    const legacy = harness([workerRow()], {
        applyRead: async () => ({ owned: true, strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" } }),
    });
    assert.deepEqual((await runIntakeWorker(legacy.deps)).byState, { DUPLICATE: 1 });
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
        findWeakGroup: async () => { order.push("weak-lookup"); return [{ id: "row-owner", refNumber: null }]; },
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
        findWeakGroup: async () => { order.push("weak-lookup"); return []; },
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
        findWeakGroup: async () => { throw new Error("connection reset"); },
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
    const h = harness([workerRow()], { findWeakGroup: async () => [{ id: "row-twin", refNumber: null }] });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "weak-dup:row-twin");
    assert.equal(h.states[0].state, "NEEDS_REVIEW");
    // ...and the key STAYS. This branch used to null it, which was harmless
    // only while a weak-parked row could never book. It can now (Retry, and the
    // pre-existing Set job), so a released key let the same document, re-sent
    // with a differently read total, miss both nets and book a second time.
    //
    // The patch must not MENTION the column, rather than mentioning it with the
    // old value: applyRead already committed the claim, so the correct patch is
    // silent about it.
    assert.ok(
        !("dedupStrongKey" in (h.states[0].patch ?? {})),
        "the weak park does not touch the strong key at all",
    );
});

// ── The corrected weak-net invariant ───────────────────────────────────────
//
// The weak key is a coarse hash of vendor + day + amount; a reference number is
// the vendor's own transaction id. Letting the hash overrule the identifier is
// backwards, and it is why three Tapani dump tickets bought on one day for $40
// each could never book.

test("weak twins with real, different refs are DISTINCT purchases and all book", async () => {
    // The Tapani shape: three tickets, one vendor, one day, one amount, three
    // real ticket numbers. Every one of these used to park.
    const refs: Record<string, string> = {
        "row-1": "tebo-4261862",
        "row-2": "tebo-4261886",
        "row-3": "tebo-4261901",
    };
    const rows = Object.keys(refs).map(id => workerRow({ id, storagePath: `receipts/intake/${id}.jpg` }));
    let reads = 0;
    const weakLookups: string[] = [];
    const h = harness(rows, {
        // Rows are processed in claim order, so call N is row N.
        read: async () => ({
            ok: true,
            read: { ...goodRead.read, invoice: refs[`row-${++reads}`] },
        } as ReadOutcome),
        // What the real query returns: every OTHER live row on this weak key,
        // each carrying its own refNumber.
        findWeakGroup: async rowId => {
            weakLookups.push(rowId);
            return Object.entries(refs)
                .filter(([id]) => id !== rowId)
                .map(([id, refNumber]) => ({ id, refNumber }));
        },
    });

    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { READ: 3 }, "all three route through, none parked");
    assert.deepEqual(h.states, [], "and nothing was parked at all");
    assert.deepEqual(weakLookups, ["row-1", "row-2", "row-3"], "the group is still consulted once per row");
    assert.deepEqual(h.finished.map(f => f.id), ["row-1", "row-2", "row-3"]);
});

test("a twin with NO readable ref still parks the row — and the row KEEPS its strong key", async () => {
    // The weak net's real job: neither document can be identified on its own,
    // so the coarse hash is the only evidence and a person decides.
    //
    // This row's OWN ref is real ("82766") and its date was read off the
    // document, so it holds a strong key and must go on holding it while it
    // waits. That identity is not in doubt just because a twin's is.
    const h = harness([workerRow()], {
        findWeakGroup: async () => [{ id: "row-first", refNumber: "NoInv" }],
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "weak-dup:row-first");
    assert.equal(h.applied[0].dedupStrongKey, "2026-08-03|82766", "claimed on the way in");
    assert.ok(
        !("dedupStrongKey" in (h.states[0].patch ?? {})),
        "and the park leaves that claim alone",
    );
});

test("a ref that is plausibly a MISREAD of the twin's still parks", async () => {
    // One purchase arriving twice, as an email receipt and a paper photo, with
    // the 8 read as a B on one of them. This must not be split.
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, invoice: "INV-95870" } } as ReadOutcome),
        findWeakGroup: async () => [{ id: "row-first", refNumber: "INV-95B70" }],
    });
    assert.deepEqual(await runIntakeWorker(h.deps), { processed: 1, byState: { NEEDS_REVIEW: 1 } });
    assert.equal(h.states[0].reason, "weak-dup:row-first");
});

test("ONE twin it cannot tell apart parks the row, and the reason names THAT twin", async () => {
    // The quantifier, at the call site. A findFirst-shaped rule would have
    // answered on `row-b` — provably a different purchase — and booked.
    const h = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, invoice: "4261862" } } as ReadOutcome),
        findWeakGroup: async () => [
            { id: "row-b", refNumber: "4261886" },
            { id: "row-c", refNumber: "4261901" },
            { id: "row-d", refNumber: "4261B62" },
        ],
    });
    assert.deepEqual(await runIntakeWorker(h.deps), { processed: 1, byState: { NEEDS_REVIEW: 1 } });
    assert.equal(h.states[0].reason, "weak-dup:row-d", "the twin that actually stopped it");
    assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})), "and it keeps its own key while it waits");
});

test("THE INVARIANT: a document whose own identity is readable never parks weak without its key", async () => {
    // Stated once, over every weak-park shape, because this is the property the
    // round-2 blocker was about. After this change a row can only reach a park
    // (or a promotion) with a null strong key when it could NEVER have had one:
    // no date read off the document, or a ref that refLooksReal rejects.
    const cases: Array<[string, Partial<WorkerDependencies>, Record<string, unknown>]> = [
        ["a twin with no readable ref", { findWeakGroup: async () => [{ id: "t", refNumber: "NoInv" }] }, {}],
        // "8Z766" folds to "82766", which IS this row's ref: one document read
        // twice with the 2 misread as a Z.
        ["a confusable twin", { findWeakGroup: async () => [{ id: "t", refNumber: "8Z766" }] }, {}],
        ["an over-large group", {
            findWeakGroup: async () => Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, refNumber: `9000${i}` })),
        }, {}],
    ];
    for (const [label, overrides] of cases) {
        const h = harness([workerRow()], overrides);
        await runIntakeWorker(h.deps);
        assert.ok(h.states[0].reason?.startsWith("weak-dup:"), label);
        // The claim went in...
        assert.equal(h.applied[0].dedupStrongKey, "2026-08-03|82766", `${label}: claimed`);
        // ...and nothing on the way out took it away.
        assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})), `${label}: still held`);
    }

    // THE CONTROL, and the other half of the invariant: a row that could never
    // have held a key still parks with none, and that is not a release.
    const placeholderRef = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, invoice: "N/A" } } as ReadOutcome),
        findWeakGroup: async () => [{ id: "t", refNumber: "4261862" }],
    });
    await runIntakeWorker(placeholderRef.deps);
    assert.ok(placeholderRef.states[0].reason?.startsWith("weak-dup:"));
    assert.equal(placeholderRef.applied[0].dedupStrongKey, null, "there was never a key to hold");
});

// ── A SECOND read may not erase an identity it failed to re-derive ─────────
//
// Rows are read more than once now: Retry sends a `weak-dup:` row back to
// RECEIVED, and setReceiptIntakeJob sends any NEEDS_REVIEW row to READ. The
// strong key is withheld whenever the date was not read off the document, even
// with a perfectly real ref — so a second read that happens to miss the date
// used to write that null straight over a key the row had already claimed.

test("a re-read that derives NO key keeps the one the row already holds", async () => {
    const h = harness([workerRow({ dedupStrongKey: "2026-08-03|82766" })], {
        // Same real invoice, no readable date this time.
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "" } } as ReadOutcome),
    });
    await runIntakeWorker(h.deps);
    assert.equal(
        h.applied[0].dedupStrongKey,
        "2026-08-03|82766",
        "the established identity survives a read that could not re-derive it",
    );
});

test("a re-read that derives a DIFFERENT key replaces the old one", async () => {
    // The read is authoritative when it actually produced an answer: a
    // corrected date or invoice must move the claim, not be ignored.
    const h = harness([workerRow({ dedupStrongKey: "2026-08-03|82766" })], {
        read: async () => ({ ok: true, read: { ...goodRead.read, invoice: "82999" } } as ReadOutcome),
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.applied[0].dedupStrongKey, "2026-08-03|82999");
});

test("a FIRST read is unchanged: no prior key, so whatever it derives stands", async () => {
    const derived = harness([workerRow()]);
    await runIntakeWorker(derived.deps);
    assert.equal(derived.applied[0].dedupStrongKey, "2026-08-03|82766");

    // ...and a first read that derives nothing still writes null, rather than
    // `undefined`, so the column is explicitly cleared as it always was.
    const none = harness([workerRow()], {
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "" } } as ReadOutcome),
    });
    await runIntakeWorker(none.deps);
    assert.equal(none.applied[0].dedupStrongKey, null);
    assert.ok("dedupStrongKey" in none.applied[0], "written explicitly, not omitted");
});

test("the GATE branch still nulls the key, even on a row that holds one", async () => {
    // A multi-doc / non-receipt / $0 / implausible-date row must claim no key
    // at all — including giving back one an earlier read had claimed, because
    // this read says the document is not a bookable purchase.
    for (const [read, reason] of [
        [{ ...goodRead.read, docType: "multi" }, "multi-doc"],
        [{ ...goodRead.read, totalAmount: "0.00" }, "refund-or-zero"],
    ] as const) {
        const h = harness([workerRow({ dedupStrongKey: "2026-08-03|82766" })], {
            read: async () => ({ ok: true, read } as ReadOutcome),
        });
        await runIntakeWorker(h.deps);
        assert.ok(h.states[0].reason?.startsWith(reason), reason);
        assert.equal(h.states[0].patch?.dedupStrongKey, null, `${reason}: the gate releases it`);
    }
});

test("the STRONG-OWNER branch still nulls the key — the index just refused this row", async () => {
    // The claim was REJECTED, so this row never held that key; the null is
    // correcting the patch, not surrendering an identity.
    const h = harness([workerRow({ dedupStrongKey: "2026-08-03|82766" })], {
        applyRead: async (_id, patch) => {
            h.applied.push(patch);
            return { owned: true, strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" } };
        },
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].state, "DUPLICATE");
    assert.equal(h.states[0].patch?.dedupStrongKey, null);
});

test("a re-routed row re-claims the key it ALREADY owns, and that is not a conflict", async () => {
    // The Retry path for `weak-dup:` sends the row back to RECEIVED, so routing
    // runs again and issues the IDENTICAL strong claim against a row that (from
    // this deploy on) still holds that key. `applyRead`'s conflict branch
    // resolves the owner with `id: { not: rowId }` and RE-THROWS when there is
    // no other owner, so a row can never be reported as a duplicate of itself;
    // and re-writing a column to the value it already has is not a unique
    // violation in Postgres, which is what worker.ts's own comment has always
    // relied on ("updating a row to the strong key it already holds is a no-op,
    // not a conflict") for the throw-and-retry path.
    //
    // What is pinned here is the call shape: the re-routed row issues the same
    // claim, gets no strongOwner back, and routes on normally.
    const h = harness([workerRow({
        // As Retry leaves it: back to RECEIVED, reason cleared, key still held.
        state: "RECEIVED",
        stateReason: null,
    })], {
        // A real twin, same width and shape as this row's own "82766": two
        // sequential tickets, so the weak net clears them and routing runs to
        // the end rather than stopping at a park.
        findWeakGroup: async () => [{ id: "row-twin", refNumber: "82767" }],
    });
    assert.deepEqual(await runIntakeWorker(h.deps), { processed: 1, byState: { READ: 1 } });
    assert.equal(h.applied.length, 1, "one claim, not a read-then-compare");
    assert.equal(h.applied[0].dedupStrongKey, "2026-08-03|82766", "the same key it already owns");
    assert.deepEqual(h.states, [], "no park, no duplicate verdict against itself");
});

test("a promotion that cleared weak twins reports them, and books exactly as before", async () => {
    // The verdict's audit row is written by the cron's promoteToBooking once
    // its transaction commits; the worker has nothing to decide from the field
    // and must carry on booking. Asserted so a future reader cannot mistake it
    // for a signal.
    const h = harness([workerRow({ state: "READ", dryRun: false })], {
        isDryRunEnabled: () => false,
        promoteToBooking: async id => {
            h.promoted.push(id);
            return { promoted: true, autoDistinctFrom: ["row-twin"] };
        },
    });
    assert.deepEqual(await runIntakeWorker(h.deps), { processed: 1, byState: { BOOKED: 1 } });
    assert.deepEqual(h.promoted, ["row-1"]);
    assert.equal(h.books, 1);
    assert.deepEqual(h.states, [], "nothing parked");
});

test("a promotion that found a real conflict still parks NEEDS_REVIEW", async () => {
    // Unchanged behaviour, pinned beside the case above so the two cannot drift.
    const h = harness([workerRow({ state: "READ", dryRun: false })], {
        isDryRunEnabled: () => false,
        promoteToBooking: async id => { h.promoted.push(id); return { promoted: false, conflictId: "row-twin" }; },
    });
    assert.deepEqual(await runIntakeWorker(h.deps), { processed: 1, byState: { NEEDS_REVIEW: 1 } });
    assert.equal(h.books, 0, "and it never reaches the money path");
});

test("the REAL weak-net queries read the whole group, and log the verdict outside the transaction", () => {
    // `buildDeps` is module-private and every one of its dependencies talks to
    // Prisma, so the cron's own implementations have no runtime seam — the
    // file's existing convention for them is to assert on the source, as the
    // sweep-query test below does. These are the four properties the injected
    // fakes above cannot prove.
    const cron = readFileSync(
        path.join(__dirname, "..", "src/app/api/cron/receipt-intake-worker/route.ts"),
        "utf8",
    );

    // 1. ROUTING'S lookup: the whole live group, bounded, with the refs.
    const lookup = cron.slice(cron.indexOf("findWeakGroup: async"), cron.indexOf("applyDuplicateTransition:"));
    assert.match(lookup, /prisma\.receiptIntake\.findMany\(/, "findMany, not findFirst");
    assert.match(lookup, /select: \{ id: true, refNumber: true \}/);
    assert.match(lookup, /id: \{ not: rowId \}/);
    assert.match(lookup, /state: \{ notIn: \["DUPLICATE", "VOID", "NON_RECEIPT"\] \}/, "the same live filter as before");
    assert.match(lookup, /orderBy: \{ createdAt: "asc" \}/);
    assert.match(lookup, /take: MAX_WEAK_GROUP \+ 1/, "one past the cap, so an over-large group is recognisable");

    // 2. THE LAST GATE: the same group read, including self, under the lock.
    const promote = cron.slice(cron.indexOf("promoteToBooking: async"), cron.indexOf("book: row =>"));
    assert.ok(
        promote.indexOf("pg_advisory_xact_lock") < promote.indexOf("findMany"),
        "the lock is taken before the group is read — a read taken first is one the other claimant can invalidate",
    );
    assert.match(promote, /take: MAX_WEAK_GROUP \+ 2/, "the cap plus self");
    // AND THE CAP MUST COUNT WHAT THAT `take` RETURNED. The two numbers are one
    // rule split across two files: a full result is the overflow sentinel for
    // this query, so the cap has to measure the FETCHED group. Counting a
    // post-exemption remainder let one human-ruled twin drop eleven twins to ten
    // and decide a group whose later rows were never read. Pinned here, beside
    // the `take` it belongs to, so the two cannot drift apart again.
    const weakNet = readFileSync(
        path.join(__dirname, "..", "src/lib/receipt-intake/weak-net.ts"),
        "utf8",
    );
    assert.match(weakNet, /if \(twins\.length > MAX_WEAK_GROUP\)/, "the cap reads the fetched count, not the judged one");
    assert.ok(
        !promote.includes("id: { not: rowId }"),
        "self is INCLUDED: its refNumber under the lock is the only version that can still be true at commit",
    );
    // AND `duplicateOfId` COMES WITH THE GROUP. Without it `self` reaches
    // judgeWeakGroup carrying no record of the collision a human already ruled
    // on, and the `strong-dup:` exit the heal honours is undone one step later:
    // the row parks `weak-dup:` on the very twin the review named.
    assert.match(promote, /select: \{ id: true, refNumber: true, duplicateOfId: true \}/);
    assert.match(promote, /const self = group\.find\(row => row\.id === rowId\)/);
    assert.match(promote, /const twins = group\.filter\(row => row\.id !== rowId\)/);
    assert.match(promote, /judgeWeakGroup\(self, twins\)/, "the SAME pure rule routing runs");
    assert.match(promote, /: \{ kind: "park", twinId: twins\[0\]\?\.id \?\? rowId \}/, "self absent fails closed");

    // 3. The park write releases the CLAIM and keeps the KEY. Those are two
    //    different things and only one of them belongs to a parked row: the
    //    lease is this pass's, the identity is the document's.
    assert.match(promote, /stateReason: `weak-dup:\$\{verdict\.twinId\}`/);
    assert.match(promote, /\.\.\.RELEASE_CLAIM/);
    // Scoped to the park write's `data` object, not the whole function, and
    // matching an ASSIGNMENT rather than the bare word: the ban is on writing
    // the column, so a comment that explains why it is left alone stays legal.
    const parkBranch = promote.slice(promote.indexOf('if (verdict.kind === "park")'));
    const parkData = parkBranch.slice(parkBranch.indexOf("data: {"), parkBranch.indexOf("});"));
    assert.ok(parkData.includes("stateReason: `weak-dup:"), "sliced the right object");
    assert.doesNotMatch(
        parkData,
        /dedupStrongKey\s*:/,
        "the weak park assigns no strong key — the row keeps the one it claimed",
    );

    // 4. The audit row is BOUNDED as well as awaited, and it says PROMOTED.
    assert.match(promote, /Promise\.race\(\[/, "awaited, but not unbounded");
    assert.match(promote, /setTimeout\(resolve, AUTO_DISTINCT_EVENT_BUDGET_MS\)/, "and the timer RESOLVES");
    assert.match(cron, /const AUTO_DISTINCT_EVENT_BUDGET_MS = 1500;/);
    assert.match(promote, /reason: `promoted past /, "READ -> BOOKING is all that happened; booking can still fail");
    assert.ok(!promote.includes("booked past"), "no event may claim a booking this code has not seen");

    // 5. The audit row is written AFTER the commit, never inside the
    //    transaction holding the advisory lock, and never at the cost of the
    //    booking.
    const commit = "return { promoted: true, autoDistinctFrom, autoDistinctRefs, humanDistinctFrom };";
    const txBody = promote.slice(promote.indexOf("prisma.$transaction("), promote.indexOf(commit));
    assert.ok(!txBody.includes("logAutomationEvent"), "nothing inside the transaction logs");
    assert.ok(
        promote.indexOf("logAutomationEvent") > promote.indexOf(commit),
        "the event is logged once the transaction has resolved",
    );
    assert.match(promote, /kind: "receipt-stage"/);
    assert.match(promote, /stage: "weak-net"/);
    // TWO statuses, because they are two different decisions: the rail ruled a
    // twin distinct on its reference number, or a PERSON did and the net merely
    // honoured it. One label for both would credit the rail with a human's call.
    assert.match(
        promote,
        /status: result\.humanDistinctFrom \? "human-distinct" : "auto-distinct"/,
    );
    // And a human exemption is logged even when no twin was auto-judged — that
    // is the whole event in the case this fix exists for.
    assert.match(promote, /if \(autoCount > 0 \|\| result\.humanDistinctFrom\)/);
    assert.match(promote, /humanDistinctFrom: result\.humanDistinctFrom \?\? null/, "and the detail names it");
    assert.match(
        promote.slice(promote.indexOf("logAutomationEvent")),
        /\}\)\.catch\(error => console\.warn\(/,
        "an event-log failure warns; it never fails a promotion that already committed",
    );
});

test("the evidence-close summary log stays counts only — `cleared` is destructured out and counted, never spread as an id array (Codex round 4, #2)", () => {
    // Same rationale as the weak-net test above: `closeRequestsSatisfiedBy`
    // lives inside module-private `buildDeps`, with no runtime seam (every
    // path inside it talks to real Prisma), so this asserts on the source.
    const cron = readFileSync(
        path.join(__dirname, "..", "src/app/api/cron/receipt-intake-worker/route.ts"),
        "utf8",
    );
    const closeBlock = cron.slice(
        cron.indexOf("closeRequestsSatisfiedBy: async (expenseId, deadlineExceeded)"),
        cron.indexOf("applyBookResult: async (rowId, result, claimToken)"),
    );
    assert.ok(closeBlock.length > 200, "sliced the right property");

    // `cleared` really is a target-key array on the result this destructures
    // — the property this test protects only matters because of that type.
    const storeSrc = readFileSync(
        path.join(__dirname, "..", "src/lib/receipt-intake/evidence-close-store.ts"),
        "utf8",
    );
    assert.match(storeSrc, /cleared: string\[\];/, "EvidenceCloseResult.cleared is an id array, not a count");

    // `cleared` must be pulled out of the destructure ALONGSIDE `judged`, not
    // left inside `...counts` — an earlier version destructured only
    // `judged` out, so `counts.cleared` was still the whole id array.
    assert.match(closeBlock, /const \{ judged, cleared, \.\.\.counts \} = closed;/);
    // And the logged object must carry that array's LENGTH, never the array
    // itself — this is the exact literal logged, so a regression back to
    // `...counts` (with `cleared` still inside it) or to spreading `cleared`
    // bare would both fail this match.
    assert.match(
        closeBlock,
        /JSON\.stringify\(\{ expenseId, \.\.\.counts, clearedCount: cleared\.length, judgedCount: judged\.length \}\)/,
        "the logged payload is counts-only: clearedCount, not cleared",
    );
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
            findWeakGroup: async () => { weakCalls++; return [{ id: "row-twin", refNumber: null }]; },
        });
        await runIntakeWorker(h.deps);
        // The tax note rides along with whatever state routing picked — a
        // document can be both a bad tax read and a refund.
        assert.ok(h.states[0].reason?.startsWith(reason), `${reason}: ${h.states[0].reason}`);
        assert.equal(h.states[0].patch?.dedupStrongKey, null, reason);
        assert.equal(weakCalls, 0, `${reason}: dedup is not consulted at all`);
    }
});

// ── A read date that cannot belong to the row ──────────────────────────────

/** The live row: Sunbelt Rentals, $1,597.03, arriving on 2026-09-21 Pacific. */
const SUNBELT_ARRIVAL = new Date("2026-09-21T16:00:00.000Z");

test("an implausible read date parks the row BEFORE it claims a dedup key", async () => {
    // Read as 2023-09-17 on a row created 2026-09-21; the real date is almost
    // certainly 2026-09-17. Nothing in the rail checked, so the row advanced to
    // BOOKING and would have become an Expense dated 2023.
    let weakCalls = 0;
    const h = harness([workerRow({ createdAt: SUNBELT_ARRIVAL })], {
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "2023-09-17" } } as ReadOutcome),
        findWeakGroup: async () => { weakCalls++; return [{ id: "row-twin", refNumber: null }]; },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "date-implausible");
    // The key is the point: "2023-09-17|82766" is one nothing real will ever
    // collide with, so holding it would quarantine the corrected resend.
    assert.equal(h.states[0].patch?.dedupStrongKey, null);
    assert.equal(weakCalls, 0, "dedup is not consulted at all");
    assert.equal(h.applied.length, 0, "and applyRead — the claim itself — never ran");
});

test("the same row read as the date it should have carried routes normally", async () => {
    // The control for the test above.
    const h = harness([workerRow({ createdAt: SUNBELT_ARRIVAL })], {
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "2026-09-17" } } as ReadOutcome),
    });
    assert.deepEqual(await runIntakeWorker(h.deps), { processed: 1, byState: { READ: 1 } });
    assert.equal(h.applied[0].dedupStrongKey, "2026-09-17|82766");
});

test("a FALLBACK date never trips the guard — it is OUR value, not the document's", async () => {
    // With no readable date the keys substitute the row's own arrival day, so
    // judging it would be measuring that day against itself. Routing has to be
    // exactly what it was before this guard existed.
    const h = harness([workerRow({ createdAt: SUNBELT_ARRIVAL })], {
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "" } } as ReadOutcome),
    });
    assert.deepEqual(await runIntakeWorker(h.deps), { processed: 1, byState: { READ: 1 } });
    assert.equal(h.applied[0].dedupWeakKey, "lowes|2026-09-21|364.98|amt");
    assert.equal(h.applied[0].dedupStrongKey, null, "and still no strong key: a fallback is a guess");
    // ...and the SUBSTITUTE IS PERSISTED, non-null. This is why book.ts's
    // `invalid-date` check never sees an unreadable read: the row books on its
    // arrival day, which is deliberate, long-standing behaviour.
    assert.equal(h.applied[0].txnDate!.toISOString(), "2026-09-21T07:00:00.000Z");

    // THE CONTRACT THE CALL SITE DEPENDS ON, asserted directly.
    //
    // The routing outcome above cannot distinguish `dateStr: keys.dateStr` from
    // `dateStr: keys.dateReadOffDocument ? keys.dateStr : null`, because the
    // substitute IS the reference day and zero days apart is always plausible.
    // So the branch is pinned where it is observable: on the flag itself. Its
    // true-direction counterpart — a document date forwarded even when no
    // strong key exists — is the placeholder-ref test below.
    const keys = dedupKeys({
        docType: "receipt", vendor: "Lowes", date: "", invoice: "82766",
        checkNumber: "", totalAmount: "364.98", fallbackDateStr: "2026-09-21",
    });
    assert.equal(keys.dateReadOffDocument, false, "so the call site forwards null, not the substitute");
    assert.equal(keys.dateStr, "2026-09-21", "even though dateStr itself is populated");
});

test("an implausible date with a PLACEHOLDER ref still parks, with no strong key at all", async () => {
    // The branch under test is `keys.dateReadOffDocument`, NOT `keys.strong`.
    // Those are different questions: the strong key is also withheld when the
    // invoice number is a placeholder, so a call site keyed on `strong !== null`
    // would let exactly this row — a real misread date with an unusable ref —
    // sail past the gate and claim the weak net instead.
    let weakCalls = 0;
    const h = harness([workerRow({ createdAt: SUNBELT_ARRIVAL })], {
        read: async () => ({
            ok: true,
            read: { ...goodRead.read, date: "2023-09-17", invoice: "N/A" },
        } as ReadOutcome),
        findWeakGroup: async () => { weakCalls++; return [{ id: "row-twin", refNumber: null }]; },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "date-implausible");
    assert.equal(h.states[0].patch?.dedupStrongKey, null, "there was never a strong key to claim");
    assert.equal(weakCalls, 0, "and the weak net is not consulted either");
    assert.equal(h.applied.length, 0);
});

test("a year the reader cannot have read off a document never reaches the guard", async () => {
    // "0026-09-17" is a real calendar day, and passed to the predicate directly
    // it is (correctly) implausible. But `dedupKeys` refuses it as a document
    // date, so the worker substitutes the arrival day and the row routes
    // normally. The predicate's stricter-than-isValidDate acceptance therefore
    // cannot change anything the pipeline does.
    const h = harness([workerRow({ createdAt: SUNBELT_ARRIVAL })], {
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "0026-09-17" } } as ReadOutcome),
    });
    assert.deepEqual(await runIntakeWorker(h.deps), { processed: 1, byState: { READ: 1 } });
    assert.equal(h.applied[0].txnDate!.toISOString(), "2026-09-21T07:00:00.000Z", "the arrival day");
    assert.equal(h.applied[0].dedupStrongKey, null);
});

test("the reference day is the COMPANY's, not UTC's, right at the midnight edge", async () => {
    // 2026-09-22T06:30Z is 23:30 on the 21st in Pacific. The dates are chosen
    // so the two readings disagree: 2026-05-24 is exactly 120 days before the
    // 21st (plausible, the bound is inclusive) and 121 before the 22nd. If this
    // used `toISOString().slice(0,10)` the row would park.
    const h = harness([workerRow({ createdAt: new Date("2026-09-22T06:30:00.000Z") })], {
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "2026-05-24" } } as ReadOutcome),
        companyTimeZone: async () => "America/Los_Angeles",
    });
    assert.deepEqual(await runIntakeWorker(h.deps), { processed: 1, byState: { READ: 1 } });
    assert.equal(h.applied[0].dedupStrongKey, "2026-05-24|82766");

    // THE CONTROL: one day further back is 121 from the Pacific day too.
    const older = harness([workerRow({ createdAt: new Date("2026-09-22T06:30:00.000Z") })], {
        read: async () => ({ ok: true, read: { ...goodRead.read, date: "2026-05-23" } } as ReadOutcome),
        companyTimeZone: async () => "America/Los_Angeles",
    });
    assert.deepEqual((await runIntakeWorker(older.deps)).byState, { NEEDS_REVIEW: 1 });
    assert.equal(older.states[0].reason, "date-implausible");
});

test("a READ row carries its bad date INTO booking — routing is not re-run", async () => {
    // The "Set job" bypass. `setReceiptIntakeJob` leaves a row at READ, past the
    // routing gate, so a row parked NEEDS_JOB before this shipped — or one whose
    // job a human assigns later — reaches BOOKING without routing ever judging
    // its date again. That is exactly why book.ts carries its own gate; this
    // asserts the handoff the gate has to catch (booking's refusal is asserted
    // in tests/receipt-intake-book.test.ts).
    const handed: { txnDate: Date | null; createdAt: Date }[] = [];
    const h = harness([workerRow({
        state: "READ",
        dryRun: false,
        txnDate: new Date("2023-09-17T00:00:00.000Z"),
        createdAt: SUNBELT_ARRIVAL,
    })], {
        isDryRunEnabled: () => false,
        book: async row => {
            handed.push({ txnDate: row.txnDate, createdAt: row.createdAt });
            return { outcome: "needs-review", reason: "date-implausible", releaseStrongKey: true } as BookResult;
        },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(h.promoted, ["row-1"], "READ is not a safe harbour: it IS promoted");
    assert.equal(handed.length, 1, "and handed to booking");
    assert.equal(handed[0].txnDate!.toISOString(), "2023-09-17T00:00:00.000Z", "still carrying the misread");
    assert.equal(handed[0].createdAt.toISOString(), SUNBELT_ARRIVAL.toISOString(), "and its arrival day");
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
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
        findWeakGroup: async () => [{ id: "row-twin", refNumber: null }],
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

// ── A jobless row claims its key BEFORE it parks ───────────────────────────
//
// The job gate used to run before the strong claim, so EVERY jobless receipt
// parked keyless, was given a job, went to READ — which never routes again — and
// booked owning no identity. The second copy of the same document then missed
// both nets and booked too. Two Expenses, one document.

test("a jobless row claims its strong key, then parks NEEDS_JOB HOLDING it", async () => {
    let weakCalls = 0;
    const h = harness([workerRow({ projectId: null })], {
        refreshProjectId: async () => null,
        findWeakGroup: async () => { weakCalls++; return []; },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { NEEDS_JOB: 1 });
    assert.equal(h.applied.length, 1, "the claim ran");
    assert.equal(h.applied[0].dedupStrongKey, "2026-08-03|82766");
    assert.equal(h.applied[0].state, "RECEIVED", "and it kept the lease, like every other claim");
    assert.equal(h.states[0].state, "NEEDS_JOB");
    assert.equal(h.states[0].reason, null);
    // THE PATCH SAYS NOTHING ABOUT THE KEY, which is how it keeps it: applyRead
    // already committed the claim, so the correct park is silent about the column.
    assert.ok(
        !("dedupStrongKey" in (h.states[0].patch ?? {})),
        "the park does not touch the claim it just made",
    );
    assert.equal(weakCalls, 0, "the weak net is not consulted for a row nobody can book yet");
    assert.deepEqual(h.finished, [], "and NEEDS_JOB is not READ");
});

test("a jobless row whose claim LOSES to a twin at the same total is still a DUPLICATE", async () => {
    // The point of claiming before the gate: the copy that arrives second now
    // collides, instead of becoming a second NEEDS_JOB row for one document.
    const h = harness([workerRow({ projectId: null })], {
        refreshProjectId: async () => null,
        applyRead: async (_id, patch) => {
            h.applied.push(patch);
            return { owned: true, strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" } };
        },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { DUPLICATE: 1 });
    assert.equal(h.states[0].state, "DUPLICATE");
    assert.equal(h.states[0].patch?.duplicateOfId, "row-owner");
    // A DUPLICATE is retired, and the partial unique index stops covering it, so
    // this one really does hand the key back.
    assert.equal(h.states[0].patch?.dedupStrongKey, null);
});

test("a jobless row against a DIFFERENT total goes to a human, not to the job queue", async () => {
    const h = harness([workerRow({ projectId: null })], {
        refreshProjectId: async () => null,
        applyRead: async (_id, patch) => {
            h.applied.push(patch);
            return { owned: true, strongOwner: { id: "row-owner", totalCents: 20000, canonicalVendor: "lowes" } };
        },
    });
    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "strong-dup-amount-mismatch:row-owner");
});

test("a jobless row that loses its fence mid-claim reports STALE and parks nothing", async () => {
    const h = harness([workerRow({ projectId: null })], {
        refreshProjectId: async () => null,
        applyRead: async () => ({ owned: false, strongOwner: null }),
    });
    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { STALE: 1 });
    assert.deepEqual(h.states, [], "the successor owns this row now");
});

test("a jobless row that loses its fence at the PARK reports STALE", async () => {
    const h = harness([workerRow({ projectId: null })], {
        refreshProjectId: async () => null,
        applyState: async () => false,
    });
    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { STALE: 1 });
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

// ── A park releases the key only for the reason, not just the send (item 7) ─

test("a weak-lookup failure at the retry limit KEEPS the strong key", async () => {
    // This row exhausted its attempts entirely on a database fault and never
    // touched QuickBooks — and it still keeps its key. `max-retries` is not a
    // no-artifact reason: the object is in the bucket, the row still IS that
    // document, and "Retry now" resumes it at BOOKING, which does not route it
    // and so could never re-claim a key given back here.
    const h = harness([workerRow({ attempts: 19, sendAttempted: false })], {
        findWeakGroup: async () => { throw new Error("connection reset"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.equal(h.states[0].reason, "max-retries");
    assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})), "the patch does not touch the key");
    // AND THE ROUND TRIP IS NOT SPENT. A release is not on the table for this
    // reason, so there is nothing for the persisted send flag to decide.
    assert.deepEqual(h.sendReads, [], "the flag is not even re-read");
});

test("a finishRouting failure at the retry limit also keeps the key", async () => {
    const h = harness([workerRow({ attempts: 19, sendAttempted: false })], {
        finishRouting: async () => { throw new Error("connection reset"); },
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "max-retries");
    assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})));
});

test("a row that DID send keeps its key at the retry limit", async () => {
    // QuickBooks may hold a Purchase whose response we lost. Now true twice over.
    const h = harness([workerRow({ attempts: 19, sendAttempted: true })], {
        findWeakGroup: async () => { throw new Error("connection reset"); },
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
    // This row OUTLIVED ITS DOCUMENT, which is one of exactly two reasons that
    // hand the strong key back: the bytes behind that identity are not there any
    // more, so a corrected re-upload must be able to claim it.
    assert.equal(h.states[0].patch?.dedupStrongKey, null, "and its identity is genuinely unclaimed");

    // ...unless a send may have created a Purchase, in which case the key stays
    // even though the document is gone.
    const sent = harness([workerRow({ sendAttempted: true })], {
        downloadBytes: async () => ({ ok: false as const, kind: "sha-mismatch" as const, message: "x" }),
    });
    await runIntakeWorker(sent.deps);
    assert.equal(sent.states[0].reason, "content-changed");
    assert.ok(!("dedupStrongKey" in (sent.states[0].patch ?? {})), "a Purchase may exist");
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

test("only the park reasons that mean the DOCUMENT is gone release the strong key", async () => {
    // The release is a property of the REASON as well as of the row. Exactly one
    // of these three parks means the row outlived its document; the other two
    // leave a row a human can revive, and a key released for those is never
    // re-claimed because a revival does not route the row again.
    const cases: Array<[string, Partial<WorkerDependencies>, boolean]> = [
        // An affirmative 404 at the read step is `file-missing`, NOT one of the
        // two no-artifact reasons — and that asymmetry is deliberate: "Retry now"
        // is offered for exactly this reason, and it resumes the row at RECEIVED
        // after a person re-uploads the object to the same path.
        ["file-missing", { downloadBytes: async () => ({ ok: false as const, kind: "missing" as const }) }, false],
        ["content-changed", { downloadBytes: async () => ({ ok: false as const, kind: "sha-mismatch" as const, message: "x" }) }, true],
        ["unreadable", { read: async () => ({ ok: false, decisive: true }) }, false],
    ];
    for (const [reason, over, releases] of cases) {
        const h = harness([workerRow({ sendAttempted: false })], over);
        await runIntakeWorker(h.deps);
        assert.equal(h.states[0].reason, reason);
        if (releases) {
            assert.equal(h.states[0].patch?.dedupStrongKey, null, `${reason} releases the key`);
            assert.deepEqual(h.sendReads, ["row-1"], `${reason}: the send flag decides, so it is read`);
        } else {
            assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})), `${reason} keeps the key`);
            assert.deepEqual(h.sendReads, [], `${reason}: no release is on the table, so no round trip`);
        }
    }

    // ...and the AI-unavailable ceiling, which is a different code path again.
    const busy = harness([workerRow({ sendAttempted: false, busyPasses: MAX_BUSY_PASSES - 1 })], {
        read: async () => ({ ok: false, decisive: false }),
    });
    await runIntakeWorker(busy.deps);
    assert.equal(busy.states[0].reason, "ai-unavailable");
    assert.ok(!("dedupStrongKey" in (busy.states[0].patch ?? {})), "the row is alive; Retry re-reads it");
});

test("a park AFTER a send keeps the key, on every one of those paths", async () => {
    for (const over of [
        { downloadBytes: async () => ({ ok: false as const, kind: "missing" as const }) },
        { downloadBytes: async () => ({ ok: false as const, kind: "sha-mismatch" as const, message: "x" }) },
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

    // The no-job park takes the same road OUT — one applyState, fenced on the
    // row's own ownership, releasing the claim with the transition. What it does
    // NOT skip any more is the claim itself: it goes through applyRead first, so
    // the row parks holding its strong key.
    const noJob = harness([workerRow({ projectId: null })], { refreshProjectId: async () => null });
    assert.deepEqual((await runIntakeWorker(noJob.deps)).byState, { NEEDS_JOB: 1 });
    assert.equal(noJob.applied.length, 1, "no-project claims its key on the way past");
    assert.equal(noJob.applied[0].dedupStrongKey, "2026-08-03|82766");
    assert.equal(noJob.states.length, 1, "and exactly one write ends the row");
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
    //
    // A `content-changed` park is the shape that still asks the question at all:
    // the release rule now also requires a reason that means the row outlived its
    // document, and `max-retries` never does (asserted above). This row's bytes
    // are gone AND a send may have happened, so the flag is what decides.
    const h = harness([workerRow({ sendAttempted: false })], {
        downloadBytes: async () => ({ ok: false as const, kind: "sha-mismatch" as const, message: "x" }),
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

test("a park with nothing ever sent releases the key — when the reason allows it", async () => {
    // The control for the test above. The document is gone and nothing was sent,
    // so the identity really is unclaimed.
    const h = harness([workerRow({ sendAttempted: false })], {
        downloadBytes: async () => ({ ok: false as const, kind: "sha-mismatch" as const, message: "x" }),
    });
    h.persistedSendAttempted = false;
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].patch?.dedupStrongKey, null);
});

test("an unreadable send flag RETAINS the key", async () => {
    // Retaining costs a review item; releasing wrongly costs a second Purchase.
    const h = harness([workerRow({ sendAttempted: false })], {
        downloadBytes: async () => ({ ok: false as const, kind: "sha-mismatch" as const, message: "x" }),
        sendAttemptedNow: async () => { throw new Error("db is down"); },
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "content-changed");
    assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})));
});

test("a generic post-send failure at the retry limit keeps the key on BOTH grounds", async () => {
    // What the three tests above used to cover through `max-retries`, kept as its
    // own case: a throw after the create parks the row, and the key stays because
    // the reason is not a no-artifact one — the send flag never even gets asked.
    const h = harness([workerRow({ state: "READ", dryRun: false, sendAttempted: false, attempts: 19 })], {
        isDryRunEnabled: () => false,
        book: async () => { throw new Error("connection reset after the create"); },
    });
    h.persistedSendAttempted = true;
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "max-retries");
    assert.ok(!("dedupStrongKey" in (h.states[0].patch ?? {})));
    assert.deepEqual(h.sendReads, [], "no release is possible, so no round trip is spent");
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
        findWeakGroup: async () => [{ id: "row-twin", refNumber: null }],
    });
    await runIntakeWorker(h.deps);
    assert.equal(h.states[0].reason, "weak-dup:row-twin;tax-implausible", "the display copy");
    assert.equal(
        (h.states[0].patch as { taxWarning?: string | null }).taxWarning,
        "tax-implausible",
        "and the durable one, in the same write",
    );
});

// ── A row must not book without the identity it should own ─────────────────
//
// READ and BOOKING are reached WITHOUT routing: `setReceiptIntakeJob` and
// `unmarkReceiptIntakeDuplicate` write READ straight onto a parked row, and
// "Retry now" resumes a row at BOOKING. None of them claims a strong key. So a
// row whose key was released at park time, or never claimed because the row was
// jobless, would book owning nothing — and the same document re-sent, read with
// a different total, would miss both nets and book a second time.

/** The Lowes row as a human revival leaves it: at READ, live, and keyless. */
function keylessRead(over: Partial<WorkerRow> = {}): WorkerRow {
    return workerRow({
        state: "READ",
        dryRun: false,
        dedupStrongKey: null,
        docType: "receipt",
        refNumber: "82766",
        txnDate: new Date("2026-08-03T00:00:00.000Z"),
        totalCents: 36498,
        vendor: "Lowes",
        readJson: '{"doc_type":"receipt","vendor":"Lowes","date":"2026-08-03","invoice":"82766","total_amount":"364.98"}',
        ...over,
    });
}

const LIVE: Partial<WorkerDependencies> = { isDryRunEnabled: () => false };

test("INVARIANT: a row with a real ref and a document date never reaches booking with a null dedupStrongKey unless its key is legitimately unobtainable", async () => {
    const order: string[] = [];
    const h = harness([keylessRead()], {
        ...LIVE,
        claimStrongKey: async (id, key, ownership) => {
            order.push("claim");
            h.strongClaims.push({ id, key, ownership });
            return { owned: true, strongOwner: null };
        },
        promoteToBooking: async id => { order.push("promote"); h.promoted.push(id); return { promoted: true }; },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { BOOKED: 1 });
    assert.deepEqual(order, ["claim", "promote"], "the claim happens BEFORE the promotion");
    assert.deepEqual(h.strongClaims, [{
        id: "row-1",
        key: "2026-08-03|82766",
        // CAS'd on the row's own ownership, like every other write here.
        ownership: { state: "READ", claimToken: LIVE_TOKEN },
    }]);
    // AND THE CLAIM REACHES THE BOOKING. A claim the in-memory row does not carry
    // forward is a claim book.ts cannot see.
    assert.equal(h.bookedRows.length, 1);
    assert.equal(h.bookedRows[0].dedupStrongKey, "2026-08-03|82766");
});

test("a BOOKING row claims its key before the send, on the same rule", async () => {
    // "Retry now" on a parked row resumes it here, past routing entirely.
    const order: string[] = [];
    const h = harness([keylessRead({ state: "BOOKING" })], {
        ...LIVE,
        claimStrongKey: async (id, key, ownership) => {
            order.push("claim");
            h.strongClaims.push({ id, key, ownership });
            return { owned: true, strongOwner: null };
        },
        book: async row => {
            order.push("book");
            h.books++;
            h.bookedRows.push(row as WorkerRow);
            return { outcome: "booked", qbPurchaseId: "QB-1", expenseId: "e1", alreadyExisted: false } as BookResult;
        },
    });
    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { BOOKED: 1 });
    assert.deepEqual(order, ["claim", "book"]);
    assert.deepEqual(h.strongClaims[0].ownership, { state: "BOOKING", claimToken: LIVE_TOKEN });
    assert.equal(h.bookedRows[0].dedupStrongKey, "2026-08-03|82766");
    assert.deepEqual(h.promoted, [], "a BOOKING row is not promoted again");
});

test("a key that is legitimately unobtainable is not invented, and the row still books", async () => {
    // The other half of the invariant. Each of these rows could NEVER have held a
    // strong key, so booking keyless is the honest outcome rather than a hole —
    // exactly what routing itself does with the same document.
    const cases: Array<[string, Partial<WorkerRow>]> = [
        ["a placeholder ref", {
            refNumber: "NoInv",
            readJson: '{"doc_type":"receipt","vendor":"Lowes","date":"2026-08-03","invoice":"NoInv","total_amount":"364.98"}',
        }],
        ["no date the reader could find", {
            // The keys substitute the row's arrival day, which is OUR value: it
            // says nothing about the document, so it cannot be half an identity.
            txnDate: new Date("2026-08-20T07:00:00.000Z"),
            readJson: '{"doc_type":"receipt","vendor":"Lowes","date":"","invoice":"82766","total_amount":"364.98"}',
        }],
        ["a read that no longer parses", { readJson: "{not json" }],
        ["no read at all", { readJson: null }],
        ["a refNumber edited away from the read", { refNumber: "99999" }],
        ["a txnDate edited away from the read", { txnDate: new Date("2026-08-04T00:00:00.000Z") }],
        ["a totalCents edited away from the read", { totalCents: 36497 }],
        ["a docType the row and the read disagree about", { docType: "check" }],
    ];
    for (const [label, over] of cases) {
        const h = harness([keylessRead(over)], LIVE);
        assert.deepEqual((await runIntakeWorker(h.deps)).byState, { BOOKED: 1 }, label);
        assert.deepEqual(h.strongClaims, [], `${label}: nothing was claimed`);
        assert.deepEqual(h.promoted, ["row-1"], `${label}: and it still promoted`);
        assert.equal(h.bookedRows[0].dedupStrongKey, null, `${label}: keyless, as it always was`);
    }
});

test("a collision sends the row to a human, and NEVER auto-quarantines it", async () => {
    // Routing would answer DUPLICATE here. The heal must not: a row is keyless at
    // this point largely because a PERSON revived it, and retiring their row
    // without asking is not this path's call.
    const h = harness([keylessRead()], {
        ...LIVE,
        claimStrongKey: async (id, key, ownership) => {
            h.strongClaims.push({ id, key, ownership });
            return { owned: true, strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" } };
        },
    });
    const summary = await runIntakeWorker(h.deps);

    assert.deepEqual(summary.byState, { NEEDS_REVIEW: 1 });
    assert.deepEqual(h.promoted, [], "not promoted");
    assert.equal(h.books, 0, "and never booked");
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].state, "NEEDS_REVIEW");
    assert.equal(h.states[0].reason, "strong-dup:row-owner", "the reason NAMES the row that holds the key");
    assert.deepEqual(h.states[0].patch, { duplicateOfId: "row-owner" }, "and records the evidence for the decision");
    assert.deepEqual(h.states[0].ownership, { state: "READ", claimToken: LIVE_TOKEN });
});

test("a collision that DISAGREES gets the reason routing would have written", async () => {
    // The verdict still comes from routeState, so the heal and routing cannot
    // describe the same collision two different ways.
    const owners: Array<[Partial<StrongOwner>, string]> = [
        [{ totalCents: 20000 }, "strong-dup-amount-mismatch:row-owner"],
        [{ totalCents: null }, "strong-dup-amount-mismatch:row-owner"],
        [{ canonicalVendor: "homedepot" }, "vendor-mismatch:row-owner"],
        [{ canonicalVendor: null }, "vendor-mismatch:row-owner"],
    ];
    for (const [over, reason] of owners) {
        const h = harness([keylessRead()], {
            ...LIVE,
            claimStrongKey: async () => ({
                owned: true,
                strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes", ...over },
            }),
        });
        assert.deepEqual((await runIntakeWorker(h.deps)).byState, { NEEDS_REVIEW: 1 }, reason);
        assert.equal(h.states[0].reason, reason);
        assert.equal(h.books, 0, reason);
    }
});

/** The live row holding the key — same day, same vendor, same amount, same ref. */
const OWNER: StrongOwner = { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" };

/**
 * The cron's promotion with the REAL weak net inside it, rather than a stub that
 * always says yes.
 *
 * That stub is what hid the loop: `row-owner` is a live twin on the same weak key
 * carrying the SAME reference number, so the weak net parks this row
 * `weak-dup:row-owner` the instant the heal lets it past — and Set job, Retry,
 * Set job all come back to the same stop. The exemption has to hold in BOTH
 * places or the exit the strong net advertises is not an exit.
 *
 * `self` is looked up from the rows array by id, exactly as the real promotion
 * re-reads it under the advisory lock.
 */
function weakNetPromotion(
    rows: WorkerRow[],
    seen: WeakVerdict[],
): WorkerDependencies["promoteToBooking"] {
    return async rowId => {
        const row = rows.find(r => r.id === rowId)!;
        const verdict = judgeWeakGroup(
            { id: row.id, refNumber: row.refNumber, duplicateOfId: row.duplicateOfId },
            [{ id: "row-owner", refNumber: "82766" }],
        );
        seen.push(verdict);
        return verdict.kind === "park"
            ? { promoted: false, conflictId: verdict.twinId }
            : {
                promoted: true,
                autoDistinctFrom: verdict.twinIds,
                humanDistinctFrom: verdict.humanDistinctFrom,
            };
    };
}

test("a human who already saw THIS collision is not overruled: the row books keyless", async () => {
    // `duplicateOfId` is the row the review named, and Set job keeps it. Pressing
    // it means "book this one anyway", so re-parking it against the same row
    // would answer their decision with the very fact they were shown.
    //
    // END TO END, through the real weak net: the heal proceeding keyless is only
    // half an exit, and the half that was missing is the one the loop ran through.
    const rows = [keylessRead({ duplicateOfId: "row-owner" })];
    const seen: WeakVerdict[] = [];
    const h = harness(rows, {
        ...LIVE,
        claimStrongKey: async () => ({ owned: true, strongOwner: OWNER }),
        promoteToBooking: weakNetPromotion(rows, seen),
    });
    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { BOOKED: 1 });
    assert.deepEqual(h.states, [], "nothing parked");
    assert.deepEqual(
        seen,
        [{ kind: "distinct", twinIds: [], humanDistinctFrom: "row-owner" }],
        "the weak net SKIPPED the twin the human ruled on, and says so",
    );
    assert.equal(h.books, 1);
    assert.equal(h.bookedRows[0].dedupStrongKey, null, "keyless, which is honest: the other row owns it");

    // THE CONTROL: a DIFFERENT owner is not the collision anybody signed off, and
    // neither is no owner at all. Both are stopped by the heal and never promoted.
    for (const duplicateOfId of [null, "row-other"]) {
        const controlRows = [keylessRead({ duplicateOfId })];
        const controlSeen: WeakVerdict[] = [];
        const control = harness(controlRows, {
            ...LIVE,
            claimStrongKey: async () => ({ owned: true, strongOwner: OWNER }),
            promoteToBooking: weakNetPromotion(controlRows, controlSeen),
        });
        assert.deepEqual((await runIntakeWorker(control.deps)).byState, { NEEDS_REVIEW: 1 }, String(duplicateOfId));
        assert.equal(control.states[0].reason, "strong-dup:row-owner", String(duplicateOfId));
        assert.deepEqual(controlSeen, [], `${duplicateOfId}: parked by the heal, never promoted`);
        assert.equal(control.books, 0, String(duplicateOfId));
    }
});

test("the exemption does not depend on the heal: a row that KEEPS its key is cleared too", async () => {
    // The key is free here, so the heal claims it and never reaches its override
    // branch at all. The human's decision still has to survive the weak net —
    // `row-owner` is a live twin with the same ref either way, and the row would
    // otherwise park `weak-dup:row-owner` holding the very key it just claimed.
    const rows = [keylessRead({ duplicateOfId: "row-owner" })];
    const seen: WeakVerdict[] = [];
    const h = harness(rows, { ...LIVE, promoteToBooking: weakNetPromotion(rows, seen) });

    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { BOOKED: 1 });
    assert.deepEqual(h.strongClaims.map(c => c.key), ["2026-08-03|82766"], "the key was free and it took it");
    assert.deepEqual(seen, [{ kind: "distinct", twinIds: [], humanDistinctFrom: "row-owner" }]);
    assert.deepEqual(h.states, [], "nothing parked");
    assert.equal(h.bookedRows[0].dedupStrongKey, "2026-08-03|82766");
});

test("a heal that loses its fence books nothing and reports STALE", async () => {
    const h = harness([keylessRead()], {
        ...LIVE,
        claimStrongKey: async () => ({ owned: false, strongOwner: null }),
    });
    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { STALE: 1 });
    assert.deepEqual(h.promoted, [], "the successor owns this row");
    assert.equal(h.books, 0);
    assert.deepEqual(h.states, [], "and nothing was written");
});

test("a heal whose PARK loses its fence reports STALE too", async () => {
    const h = harness([keylessRead()], {
        ...LIVE,
        claimStrongKey: async () => ({
            owned: true,
            strongOwner: { id: "row-owner", totalCents: 36498, canonicalVendor: "lowes" },
        }),
        applyState: async () => false,
    });
    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { STALE: 1 });
    assert.equal(h.books, 0);
});

test("a row that already HOLDS its key spends no round trip on the heal", async () => {
    const h = harness([keylessRead({ dedupStrongKey: "2026-08-03|82766" })], LIVE);
    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { BOOKED: 1 });
    assert.deepEqual(h.strongClaims, [], "the overwhelming majority of rows are this one");
    assert.equal(h.bookedRows[0].dedupStrongKey, "2026-08-03|82766");
});

test("a revived row does not claim the key its routing gates WITHHELD", async () => {
    // The row parked `date-implausible` at routing and claimed nothing, on
    // purpose: the read date is half the strong key, so a misread year must not
    // be allowed to mint one. Set job sends it to READ, where the heal re-derives
    // that very key — and must refuse it for that very reason. Otherwise the row
    // parks `date-implausible` all over again, now HOLDING a key routing
    // deliberately kept from it.
    const h = harness([keylessRead({
        txnDate: new Date("2026-02-01T00:00:00.000Z"),
        readJson: '{"doc_type":"receipt","vendor":"Lowes","date":"2026-02-01","invoice":"82766","total_amount":"364.98"}',
    })], LIVE);

    assert.deepEqual((await runIntakeWorker(h.deps)).byState, { BOOKED: 1 });
    assert.deepEqual(h.strongClaims, [], "no claim was even attempted");
    assert.equal(h.books, 1, "and the row still reaches book.ts, which owns the date verdict");
    assert.equal(h.bookedRows[0].dedupStrongKey, null);
});

test("a dry-run row is not healed: it is not about to book", async () => {
    for (const [label, row, over] of [
        ["the row's own flag", keylessRead({ dryRun: true }), LIVE],
        ["the global switch", keylessRead(), { isDryRunEnabled: () => true }],
    ] as const) {
        const h = harness([row], over);
        assert.deepEqual((await runIntakeWorker(h.deps)).byState, { READ: 1 }, label);
        assert.deepEqual(h.strongClaims, [], `${label}: no claim`);
        assert.equal(h.books, 0, label);
        assert.equal(h.releasedClaims.length, 1, `${label}: parked for dry run, claim handed back`);
    }
});

// ── recoverStrongKey, on its own ───────────────────────────────────────────

test("recoverStrongKey re-derives the key with the SAME rule routing used", () => {
    const base = {
        docType: "receipt",
        refNumber: "82766",
        txnDate: new Date("2026-08-03T00:00:00.000Z") as Date | null,
        totalCents: 36498 as number | null,
        createdAt: new Date("2026-08-20T09:00:00.000Z"),
        readJson: '{"doc_type":"receipt","vendor":"Lowes","date":"2026-08-03","invoice":"82766","total_amount":"364.98"}' as string | null,
    };
    const recovered = recoverStrongKey(base, "America/Los_Angeles");
    assert.equal(recovered?.key, "2026-08-03|82766");
    // The RouteInput a collision is judged with: the row's own total, the read's
    // canonical vendor, and the document's date (never the arrival fallback).
    assert.deepEqual(recovered?.routeInput, {
        docType: "receipt",
        amount: "364.98",
        totalCents: 36498,
        canonicalVendor: "lowes",
        dateStr: "2026-08-03",
        referenceDay: "2026-08-20",
    });

    // A CHECK keys off its check number, exactly as dedupKeys does. `totalCents`
    // moves WITH the read: it is written from these keys at read time, so the
    // recovery refuses a row whose money disagrees with its own JSON.
    const check = recoverStrongKey({
        ...base,
        docType: "check",
        refNumber: "Check4178",
        totalCents: 120000,
        readJson: '{"doc_type":"check","vendor":"Bob the Sub","date":"2026-08-03","check_number":"4178","total_amount":"1200.00"}',
    }, "America/Los_Angeles");
    assert.equal(check?.key, "2026-08-03|check4178");
    assert.equal(check?.routeInput.docType, "check");

    // A row RE-CLASSIFIED after the read is not the document this JSON describes.
    assert.equal(recoverStrongKey({ ...base, docType: "check" }, "America/Los_Angeles"), null);
    assert.equal(
        recoverStrongKey({
            ...base,
            readJson: '{"doc_type":"multi","vendor":"Lowes","date":"2026-08-03","invoice":"82766","total_amount":"364.98"}',
        }, "America/Los_Angeles"),
        null,
        "and a docType routing would never have keyed answers null",
    );

    // A txnDate that disagrees with the read means a column was edited.
    assert.equal(
        recoverStrongKey({ ...base, txnDate: new Date("2026-08-04T00:00:00.000Z") }, "America/Los_Angeles"),
        null,
    );
    assert.equal(recoverStrongKey({ ...base, txnDate: null }, "America/Los_Angeles"), null);

    // AND SO DOES A TOTAL THAT DISAGREES. `totalCents` was written from these
    // same keys at read time, so a row whose money no longer matches its read is
    // a row somebody edited, and this key is no longer its identity — the same
    // test refNumber and txnDate get, on the third column routing wrote.
    assert.equal(
        recoverStrongKey({ ...base, totalCents: 36497 }, "America/Los_Angeles"),
        null,
        "one cent out is still a column that was edited",
    );
    assert.equal(recoverStrongKey({ ...base, totalCents: null }, "America/Los_Angeles"), null);
    // THE CONTROL, so the two nulls above are the new check and not the
    // re-derivation quietly breaking.
    assert.equal(recoverStrongKey({ ...base, totalCents: 36498 }, "America/Los_Angeles")?.key, "2026-08-03|82766");
    assert.equal(recoverStrongKey({ ...base, readJson: null }, "America/Los_Angeles"), null);
    assert.equal(recoverStrongKey({ ...base, readJson: "{" }, "America/Los_Angeles"), null);
});

test("recoverStrongKey runs routing's DOCUMENT GATES, so a heal cannot claim what routing refused", () => {
    // The row arrived on 2026-08-20 Pacific. Each case below is a document
    // routing would have parked BEFORE the strong claim, so the heal — which
    // runs after a human revived the row, with routing long gone — must reach
    // the same answer rather than handing it an identity on the way to booking.
    const base = {
        docType: "receipt",
        refNumber: "82766",
        txnDate: new Date("2026-08-03T00:00:00.000Z") as Date | null,
        totalCents: 36498 as number | null,
        createdAt: new Date("2026-08-20T09:00:00.000Z"),
        readJson: '{"doc_type":"receipt","vendor":"Lowes","date":"2026-08-03","invoice":"82766","total_amount":"364.98"}' as string | null,
    };
    const read = (over: Record<string, string>) => JSON.stringify({
        doc_type: "receipt", vendor: "Lowes", date: "2026-08-03",
        invoice: "82766", total_amount: "364.98", ...over,
    });

    // THE CONTROL: the plausible row still gets its key, so every null below is
    // the gate speaking and not the re-derivation failing.
    assert.equal(recoverStrongKey(base, "America/Los_Angeles")?.key, "2026-08-03|82766");

    // 200 days back: a misread year or month, not a late upload (the Sunbelt
    // 2023 read). txnDate agrees with the read, so only the gate can refuse it.
    assert.equal(
        recoverStrongKey({
            ...base,
            txnDate: new Date("2026-02-01T00:00:00.000Z"),
            readJson: read({ date: "2026-02-01" }),
        }, "America/Los_Angeles"),
        null,
        "a date 200 days before arrival",
    );
    // Ten days ahead of arrival is past the three days clock skew allows for.
    assert.equal(
        recoverStrongKey({
            ...base,
            txnDate: new Date("2026-08-30T00:00:00.000Z"),
            readJson: read({ date: "2026-08-30" }),
        }, "America/Los_Angeles"),
        null,
        "a date 10 days after arrival",
    );
    // A $0.00 read never books automatically, and never keys.
    assert.equal(
        recoverStrongKey({
            ...base,
            totalCents: 0,
            readJson: read({ total_amount: "0.00" }),
        }, "America/Los_Angeles"),
        null,
        "a zero total",
    );
    // A negative total is a refund: a real document, but one a human has to
    // place against the original purchase.
    assert.equal(
        recoverStrongKey({
            ...base,
            totalCents: -2257,
            readJson: read({ total_amount: "-22.57" }),
        }, "America/Los_Angeles"),
        null,
        "a negative total",
    );
});
