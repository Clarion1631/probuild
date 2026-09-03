/**
 * The payment sweep's RESUME CURSOR.
 *
 * The bug: `forEachPendingPage` reset its cursor to null on every invocation.
 * Ordering by id had already made each run deterministic — which is exactly
 * what turned a soft problem into a permanent one. With more than
 * PAYMENTS_SYNC_MAX_ROWS unpaid rows, every hourly cron re-probed the SAME
 * lowest 500 ids, and rows past that cap were never verified. Not "eventually";
 * never, for as long as the leading rows stayed unpaid.
 *
 * These tests drive the REAL pagination function against an in-memory
 * collection, so what is measured is the shipped traversal rather than a
 * restatement of it. Each one carries the control that makes it mean
 * something: the same fixture with no cursor, which must starve.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    forEachPendingPage,
    countUnvisited,
    PAYMENTS_CURSOR_KEYS,
    type PaymentsSyncCursorStore,
    type QBPaymentSyncResult,
} from "../src/lib/quickbooks-payments";
import { createRouteDeadline } from "../src/lib/quickbooks";
import { readFileSync } from "node:fs";
import path from "node:path";

const TOTAL = 600; // deliberately > the 500-row cap
const KEY = PAYMENTS_CURSOR_KEYS.milestones;

function emptyResult(): QBPaymentSyncResult {
    return {
        checked: 0, settled: 0, partiallyPaid: 0, errors: [], progressBillingsSettled: 0,
        skipped: 0, abortedOnQboOutage: false, runFailed: false,
    };
}

/** Zero-padded so lexical id order is the same order a human would expect. */
const idAt = (n: number) => `id-${String(n).padStart(3, "0")}`;

function memoryCursorStore(): PaymentsSyncCursorStore & { peek(): string | null; gets: number; sets: string[] } {
    let value: string | null = null;
    return {
        gets: 0,
        sets: [],
        peek: () => value,
        async get() { this.gets++; return value; },
        async set(_key, next) { this.sets.push(next); value = next; },
    };
}

/**
 * One run over a collection that never changes — the "unchanged pending rows"
 * case, which is the one that starved. Returns the ids this run visited.
 */
async function runOnce(
    store: PaymentsSyncCursorStore | undefined,
    total = TOTAL,
    opts: { stopAfter?: number } = {},
): Promise<{ visited: string[]; result: QBPaymentSyncResult }> {
    const all = Array.from({ length: total }, (_, i) => ({ id: idAt(i) }));
    const visited: string[] = [];
    const result = emptyResult();

    await forEachPendingPage(
        result,
        createRouteDeadline(100_000),
        async (cursorId, take, stopAfterId) =>
            all
                .filter(r => (cursorId ? r.id > cursorId : true))
                .filter(r => (stopAfterId ? r.id <= stopAfterId : true))
                .slice(0, take),
        (state) => countUnvisited(
            (where) => {
                const w = (where.id ?? {}) as { gt?: string; lte?: string };
                return Promise.resolve(all.filter(r =>
                    (w.gt ? r.id > w.gt : true) && (w.lte ? r.id <= w.lte : true),
                ).length);
            },
            state,
        ),
        async (page) => {
            let lastCompletedId: string | null = null;
            for (const row of page) {
                // A simulated mid-run stop: an outage or the budget wall lands
                // partway through a page, and the cursor must not step over the
                // rows it never reached.
                if (opts.stopAfter !== undefined && visited.length >= opts.stopAfter) {
                    result.abortedOnQboOutage = true;
                    break;
                }
                visited.push(row.id);
                result.checked++;
                lastCompletedId = row.id;
            }
            return { lastCompletedId };
        },
        store ? { store, key: KEY } : undefined,
    );

    return { visited, result };
}

test("CONTROL: with no persisted cursor every run re-probes the SAME lowest 500 ids", async () => {
    // This is the reported behaviour, reproduced. Without it the test below
    // would pass against a collection that simply fitted under the cap.
    const runs = [await runOnce(undefined), await runOnce(undefined), await runOnce(undefined)];
    for (const run of runs) {
        assert.equal(run.visited.length, 500, "each run stops at the cap");
        assert.equal(run.visited[0], idAt(0));
        assert.equal(run.visited[499], idAt(499));
    }
    const everSeen = new Set(runs.flatMap(r => r.visited));
    assert.equal(everSeen.has(idAt(500)), false, "row 500 is never reached, run after run");
    assert.equal(everSeen.has(idAt(599)), false, "nor is the last row");
});

test("the cursor persists between invocations, so later ids ARE probed", async () => {
    const store = memoryCursorStore();

    const first = await runOnce(store);
    assert.equal(first.visited.length, 500);
    assert.equal(first.visited[0], idAt(0));
    assert.equal(store.peek(), idAt(499), "the run records where it stopped");

    const second = await runOnce(store);
    assert.equal(
        second.visited[0],
        idAt(500),
        "the next invocation RESUMES after the last processed id rather than restarting",
    );
    assert.ok(
        second.visited.includes(idAt(599)),
        "the rows past the cap — never reachable before — are verified on the very next run",
    );
});

test("it wraps to the top only AFTER the tail is drained, and covers everything", async () => {
    const store = memoryCursorStore();
    const seen = new Set<string>();
    // Two runs is enough to cover 600 rows at 500 a run; a third proves the
    // cycle keeps rolling rather than stalling at the end of the collection.
    for (let i = 0; i < 3; i++) {
        const run = await runOnce(store);
        for (const id of run.visited) seen.add(id);
    }
    assert.equal(seen.size, TOTAL, "every row in the collection has been verified");
});

test("a wrapped pass never re-walks the rows it already did this run", async () => {
    const store = memoryCursorStore();
    await runOnce(store); // leaves the cursor at id-499

    const second = await runOnce(store);
    const counts = new Map<string, number>();
    for (const id of second.visited) counts.set(id, (counts.get(id) ?? 0) + 1);
    const repeated = [...counts.entries()].filter(([, n]) => n > 1);
    assert.deepEqual(repeated, [], "stopAfterId bounds the wrapped pass");
    // It walked the tail (500-599) first, then wrapped to the head and stopped
    // at the old cursor — never past it.
    assert.deepEqual(
        second.visited.slice(0, 100),
        Array.from({ length: 100 }, (_, i) => idAt(500 + i)),
        "the tail, in order",
    );
    assert.equal(second.visited[100], idAt(0), "then back to the top");
    assert.ok(
        second.visited.slice(100).every(id => id <= idAt(499)),
        "and the wrapped pass never crosses the point this run started from",
    );
});

test("a run cut short mid-page resumes at the first UNVERIFIED row, not past it", async () => {
    // The cursor may only advance to the last row actually completed. Jumping
    // to the page tail after an outage would step over every row the outage
    // cut short, and they would wait a whole cycle to be looked at again.
    const store = memoryCursorStore();
    const first = await runOnce(store, TOTAL, { stopAfter: 37 });
    assert.equal(first.visited.length, 37);
    assert.equal(store.peek(), idAt(36), "the cursor sits on the last COMPLETED row");

    const second = await runOnce(store);
    assert.equal(second.visited[0], idAt(37), "the next run picks up exactly where it stopped");
});

test("a fully drained collection resets to the top rather than resuming from the end", async () => {
    const store = memoryCursorStore();
    const run = await runOnce(store, 40); // well under the cap
    assert.equal(run.visited.length, 40);
    assert.equal(store.peek(), "", "empty string is how 'start from the top' is stored");
    assert.equal(run.result.skipped, 0, "nothing was missed, so nothing is reported skipped");
});

test("a capped run reports what it did NOT reach, including the head it resumed past", async () => {
    // A run that resumed at C and stopped at D has left both (> D) and (<= C)
    // unverified. Counting only "after the cursor" called such a run clean.
    const store = memoryCursorStore();
    const first = await runOnce(store);
    assert.equal(first.result.skipped, 100, "600 rows, 500 checked");

    const second = await runOnce(store);
    assert.equal(
        second.result.checked + second.result.skipped,
        TOTAL,
        "every row is accounted for as either checked or skipped",
    );
});

test("a run with NO cursor never reads or writes the store", async () => {
    // The scoped on-view refresh passes no cursor: it looks at the handful of
    // rows a user is staring at, so reading the shared cursor would make it
    // skip the very row it was asked about, and writing one would move the
    // cron's resume point to wherever that user happened to be looking.
    const store = memoryCursorStore();
    await runOnce(undefined);
    assert.equal(store.gets, 0);
    assert.deepEqual(store.sets, []);
});

// ── Wiring ──────────────────────────────────────────────────────────────────
//
// Every test above drives forEachPendingPage directly, so all of them still
// pass if the sync simply stops handing it a cursor — and tsc would not object
// either, since the argument is optional. Reading the source is the only check
// available without standing up Postgres, and it is the same technique the
// worker suite uses for its sweep query.

const paymentsSource = readFileSync(
    path.join(__dirname, "..", "src/lib/quickbooks-payments.ts"),
    "utf8",
);

test("both rails are given their resume cursor", () => {
    assert.match(paymentsSource, /^\s*milestoneCursor,$/m, "the milestone pass must resume");
    assert.match(paymentsSource, /^\s*billingCursor,$/m, "so must the progress-billing pass");
});

test("only the UNSCOPED sweep carries a cursor", () => {
    // A scoped on-view refresh looks at a handful of rows a user is staring at.
    // Reading the shared cursor would make it skip the very row it was asked
    // about; writing one would drag the cron's resume point to wherever that
    // user happened to be looking, starving everything after it.
    assert.match(paymentsSource, /const isSweep = !scope\?\.invoiceId && !scope\?\.projectId;/);
    assert.match(paymentsSource, /const milestoneCursor = isSweep\s*\r?\n\s*\?\s*\{ store: cursorStore, key: PAYMENTS_CURSOR_KEYS\.milestones \}\s*\r?\n\s*: undefined;/);
    assert.match(paymentsSource, /const billingCursor = isSweep\s*\r?\n\s*\?\s*\{ store: cursorStore, key: PAYMENTS_CURSOR_KEYS\.billings \}\s*\r?\n\s*: undefined;/);
});
