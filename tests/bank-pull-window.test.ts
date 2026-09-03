import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    PULL_FULL_SWEEP_DAYS,
    PULL_MAX_WINDOW_DAYS,
    PULL_OVERLAP_DAYS,
    REGISTER_WINDOW_DAYS,
    registerWindowStart,
    registerWindowStartYmd,
    CHECKPOINT_RESERVE_MS,
    advanceScanBoundary,
    highWaterOf,
    resumeAfter,
    splitAtCursor,
    type PullWindowState,
    planPullWindow,
    runBankRegisterPull,
    type BankRegisterIngestLine,
    type BankRegisterRowLike,
} from "../src/lib/bank-register-pull";

/**
 * The pull window (round-8 item 6) and the outer budget (item 7).
 *
 * A fixed "last 7 days" was wrong in both directions: it re-derived the same
 * week nightly so a backlog behind it was never reached, and it could not see
 * an entry QuickBooks records with an OLDER TxnDate after the fact.
 */

const NOW = new Date("2026-09-02T02:00:00Z");
const TODAY = "2026-09-02";

test("with a high-water mark, the window starts 3 days behind it", () => {
    // The overlap re-pulls the boundary: an entry edited on the day we last
    // stopped would otherwise fall in the seam between two runs.
    assert.equal(PULL_OVERLAP_DAYS, 3);
    const w = planPullWindow({ highWater: "2026-08-30", lastFullSweep: "2026-09-01" }, NOW);
    assert.equal(w.startDate, "2026-08-27");
    assert.equal(w.endDate, TODAY);
    assert.equal(w.fullSweep, false);
    assert.equal(w.continues, false);
});

test("with NO high-water mark it asks for the full allowed window", () => {
    const w = planPullWindow({ highWater: null, lastFullSweep: "2026-09-01" }, NOW);
    assert.equal(w.endDate, TODAY);
    assert.equal(w.startDate, "2026-07-05", `${PULL_MAX_WINDOW_DAYS} days inclusive`);
});

test("a window wider than the cap takes the OLDEST slice and CONTINUES", () => {
    // Oldest-first, so the backlog drains forward and the mark advances each run
    // instead of the same recent week being re-derived forever.
    const w = planPullWindow({ highWater: "2026-01-01", lastFullSweep: "2026-09-01" }, NOW);
    assert.equal(w.startDate, "2025-12-29");
    assert.equal(w.continues, true);
    const span = (Date.parse(`${w.endDate}T00:00:00Z`) - Date.parse(`${w.startDate}T00:00:00Z`)) / 86_400_000 + 1;
    assert.equal(span, PULL_MAX_WINDOW_DAYS);
});

test("the weekly deep sweep overrides the mark — it is the only thing that finds a BACKDATED entry", () => {
    // A backdated entry sits BEHIND a mark that has already moved past it, so
    // no incremental window can ever reach it.
    const due = planPullWindow({ highWater: "2026-09-01", lastFullSweep: "2026-08-26" }, NOW);
    assert.equal(due.fullSweep, true);
    assert.equal(due.startDate, "2026-07-05");
    assert.equal(due.endDate, TODAY);

    const notDue = planPullWindow({ highWater: "2026-09-01", lastFullSweep: "2026-08-28" }, NOW);
    assert.equal(notDue.fullSweep, false);
});

test("a first-ever run is a full sweep", () => {
    const w = planPullWindow({ highWater: "2026-09-01", lastFullSweep: null }, NOW);
    assert.equal(w.fullSweep, true);
    assert.equal(PULL_FULL_SWEEP_DAYS, 60);
});

test("highWaterOf takes the newest TxnDate and never moves backwards", () => {
    const line = (postedDate: string): BankRegisterIngestLine =>
        ({ postedDate, amountCents: -1, rawDescriptor: "X", checkNumber: null, qbTxnId: postedDate, clearedStatus: "Reconciled" });
    assert.equal(highWaterOf([line("2026-08-30"), line("2026-09-01")], "2026-08-20"), "2026-09-01");
    assert.equal(highWaterOf([line("2026-08-01")], "2026-08-20"), "2026-08-20", "an older batch cannot rewind it");
    assert.equal(highWaterOf([], "2026-08-20"), "2026-08-20");
    assert.equal(highWaterOf([], null), null);
});

// ── The outer budget (item 7) ──────────────────────────────────────────────

const ROWS: BankRegisterRowLike[] = Array.from({ length: 1_200 }, (_, i) => ({
    date: "2026-08-30",
    qbType: "Expense",
    qbTxnId: `txn-${i}`,
    docNum: null,
    name: `VENDOR ${i}`,
    memo: null,
    amountCents: -100 - i,
}));

function deps(over: Record<string, unknown> = {}) {
    return {
        now: () => Date.parse("2026-09-02T02:00:00Z"),
        fetchRows: async () => ({ rows: ROWS, stale: false }),
        ingest: async () => ({ status: 200, body: { ok: true, inserted: 1, existing: 0 } }),
        reconcile: async () => ({ linked: 0, proposed: 0 }),
        ...over,
    };
}

test("the run stops on its OWN budget and records how far it got", () => {
    // Being killed by the platform mid-ingest wrote nothing, so the next run
    // re-fetched the same window and died at the same point.
    let clock = 0;
    return runBankRegisterPull(deps({
        // 1,200 rows = 3 batches; each check reports 20s more elapsed, so the
        // third one is over budget and never runs.
        elapsedMs: () => (clock += 20_000) - 20_000,
        budgetMs: 25_000,
    })).then(summary => {
        assert.equal(summary.continues, true);
        assert.ok((summary.remainingBatches ?? 0) > 0, "the continuation point is recorded");
        assert.ok(summary.inserted > 0, "and whatever fitted still committed");
    });
});

test("inside budget, nothing is left behind", async () => {
    const summary = await runBankRegisterPull(deps({ elapsedMs: () => 0, budgetMs: 45_000 }));
    assert.notEqual(summary.continues, true);
    assert.equal(summary.remainingBatches, undefined);
});

test("the high-water mark advances only on a clean, COMPLETE run", async () => {
    const saved: PullWindowState[] = [];
    const base = {
        windowState: { highWater: "2026-08-30", lastFullSweep: "2026-09-01" },
        saveWindowState: async (next: PullWindowState) => { saved.push(next); },
        elapsedMs: () => 0,
        budgetMs: 45_000,
    };

    await runBankRegisterPull(deps(base));
    assert.equal(saved.length, 1);
    // THE BOUNDARY IS WHAT WE SCANNED, not the newest row that came back — a
    // complete fetch is proof about the whole window, including its empty parts.
    assert.equal(saved[0].highWater, TODAY, "the window's end date");

    // A failed ingest must NOT step the window past rows it never stored.
    saved.length = 0;
    await runBankRegisterPull(deps({
        ...base,
        ingest: async () => ({ status: 500, body: { ok: false, reason: "boom" } }),
    }));
    assert.equal(saved.length, 0, "a failed ingest must not step the window");

    // A run that ran out of budget DOES write — it has to persist where it
    // stopped — but the MARK must not move, or the next window would step past
    // rows this run never stored.
    saved.length = 0;
    let clock = 0;
    await runBankRegisterPull(deps({
        ...base,
        elapsedMs: () => (clock += 20_000) - 20_000,
        budgetMs: 25_000,
    }));
    assert.equal(saved.length, 1, "the continuation point is persisted");
    assert.equal(saved[0].highWater, "2026-08-30", "but the mark is unchanged");
});

test("a window-state write failure fails the run", async () => {
    const summary = await runBankRegisterPull(deps({
        windowState: { highWater: "2026-08-30", lastFullSweep: "2026-09-01" },
        saveWindowState: async () => { throw new Error("pool exhausted"); },
        elapsedMs: () => 0,
        budgetMs: 45_000,
    }));
    assert.equal(summary.ok, false);
    assert.equal(summary.error, "window-state-write-failed");
});

test("the deep sweep stamps its own date so the next one is a week away", async () => {
    const saved: PullWindowState[] = [];
    await runBankRegisterPull(deps({
        windowState: { highWater: "2026-09-01", lastFullSweep: null },
        saveWindowState: async (next: PullWindowState) => { saved.push(next); },
        elapsedMs: () => 0,
        budgetMs: 45_000,
    }));
    assert.equal(saved[0].lastFullSweep, TODAY);
});

// ── The intra-window continuation cursor (round-10 item 3) ─────────────────

test("resumeAfter drops the prefix already posted, in (date, qbTxnId) order", () => {
    const l = (postedDate: string, qbTxnId: string): BankRegisterIngestLine =>
        ({ postedDate, amountCents: -1, rawDescriptor: "X", checkNumber: null, qbTxnId, clearedStatus: "Reconciled" });
    const lines = [l("2026-08-02", "b"), l("2026-08-01", "z"), l("2026-08-02", "a")];

    // No resume point: everything, but ORDERED — the order is what makes
    // "after" mean the same thing on the next run.
    assert.deepEqual(resumeAfter(lines, null).map(x => `${x.postedDate}/${x.qbTxnId}`),
        ["2026-08-01/z", "2026-08-02/a", "2026-08-02/b"]);

    // Same date, different id: the tie-break must be total or a dozen
    // transactions on one day would replay forever.
    assert.deepEqual(resumeAfter(lines, { postedDate: "2026-08-02", qbTxnId: "a" }).map(x => x.qbTxnId), ["b"]);
    assert.deepEqual(resumeAfter(lines, { postedDate: "2026-08-02", qbTxnId: "b" }), []);
});

/** An idempotent ingest fake, keyed like the real upsert (qbTxnId → content). */
function idempotentStore() {
    const stored = new Map<string, string>();
    const posted: string[][] = [];
    return {
        stored,
        posted,
        ingest: async (_account: string, batch: BankRegisterIngestLine[]) => {
            posted.push(batch.map(l => l.qbTxnId));
            let inserted = 0;
            let existing = 0;
            for (const line of batch) {
                const content = JSON.stringify([line.postedDate, line.amountCents, line.rawDescriptor, line.checkNumber]);
                const prior = stored.get(line.qbTxnId);
                if (prior === undefined) { stored.set(line.qbTxnId, content); inserted++; continue; }
                if (prior !== content) {
                    return { status: 409, body: { ok: false, reason: "qbo-txn-conflict", qbTxnId: line.qbTxnId } };
                }
                existing++;
            }
            return { status: 200, body: { ok: true, inserted, existing } };
        },
    };
}

test("two budget-limited runs make PROGRESS, and the finishing run rescans the prefix it skipped", async () => {
    // The high-water mark only moves on a COMPLETE run, which is right — but it
    // meant a half-finished run recorded nothing, so the next one re-fetched
    // the same window and died at the same place. A big backlog never drained.
    //
    // The FINISHING run also re-verifies the PREFIX it resumed past — see
    // splitAtCursor and the rescan block in runBankRegisterPull — through the
    // same idempotent ingest, so a row genuinely never posted in run 1 is not
    // lost forever behind a cursor that can only move forward. Re-posting the
    // already-stored prefix costs nothing: the store is keyed by qbTxnId,
    // exactly like the real upsert.
    const store = idempotentStore();
    const state: { highWater: string | null; lastFullSweep: string | null; continueAfter?: { postedDate: string; qbTxnId: string } | null } = {
        highWater: "2026-08-30", lastFullSweep: "2026-09-01", continueAfter: null,
    };
    const run = (budgetMs: number) => {
        let clock = 0;
        return runBankRegisterPull({
            now: () => Date.parse("2026-09-02T02:00:00Z"),
            fetchRows: async () => ({ rows: ROWS, stale: false }),
            ingest: store.ingest,
            reconcile: async () => ({ linked: 0, proposed: 0 }),
            windowState: { ...state },
            saveWindowState: async next => { Object.assign(state, next); },
            elapsedMs: () => (clock += 20_000) - 20_000,
            budgetMs,
        });
    };

    const first = await run(25_000);
    assert.equal(first.continues, true);
    assert.ok(first.continueAfter, "it must record where it stopped");
    assert.deepEqual(state.continueAfter, first.continueAfter, "and persist it");
    assert.equal(state.highWater, "2026-08-30", "the mark does NOT move on a partial run");
    assert.ok(store.stored.size > 0 && store.stored.size < ROWS.length, "run 1 posted only part of the window");

    store.posted.length = 0;
    // Generous budget: this run both finishes the resumed pending rows AND
    // rescans the prefix run 1 never got to.
    const second = await run(1_000_000);
    assert.deepEqual(second.resumedAfter, first.continueAfter, "the second run picks up where the first stopped");
    assert.equal(store.stored.size, ROWS.length, "every row lands once the window finishes");
    assert.equal(state.continueAfter, null, "a genuinely finished window clears the cursor");
    assert.equal(state.highWater, "2026-09-02", "and the mark advances to the window's end");
    // The rescanned prefix was re-SENT (idempotently) for verification, not
    // merely trusted because it sorted before the old cursor: run 2 sends
    // every row in the window, not just the ones `pending` would have named.
    const secondSentCount = store.posted.reduce((n, batch) => n + batch.length, 0);
    assert.equal(secondSentCount, ROWS.length, "the prefix rescan re-sent the rows already stored, not just the new ones");
});

test("a row QuickBooks backdates BEHIND the cursor is caught by the finishing run's rescan", async () => {
    // The classic gap: run 1 posts the first slice and stops on budget with a
    // cursor part way through the window. Before run 2, QuickBooks records a
    // genuinely NEW transaction whose postedDate/qbTxnId sort BEFORE that
    // cursor — a real backdate, not a re-fetch of something already seen.
    // Without the prefix rescan, `resumeAfter` discards it on every run from
    // here on: the cursor never moves backwards to let it back in.
    const store = idempotentStore();
    const state: { highWater: string | null; lastFullSweep: string | null; continueAfter?: { postedDate: string; qbTxnId: string } | null } = {
        highWater: "2026-08-30", lastFullSweep: "2026-09-01", continueAfter: null,
    };
    let rows = ROWS;
    const run = (budgetMs: number) => {
        let clock = 0;
        return runBankRegisterPull({
            now: () => Date.parse("2026-09-02T02:00:00Z"),
            fetchRows: async () => ({ rows, stale: false }),
            ingest: store.ingest,
            reconcile: async () => ({ linked: 0, proposed: 0 }),
            windowState: { ...state },
            saveWindowState: async next => { Object.assign(state, next); },
            elapsedMs: () => (clock += 20_000) - 20_000,
            budgetMs,
        });
    };

    const first = await run(25_000);
    assert.ok(first.continueAfter, "run 1 stopped part way through");
    // Sorts before the recorded cursor: same date as the fixture, qbTxnId
    // "txn-0000" precedes every "txn-<n>" lexicographically.
    const backdated: BankRegisterRowLike = {
        date: "2026-08-30", qbType: "Expense", qbTxnId: "txn-0000",
        docNum: null, name: "BACKDATED VENDOR", memo: null, amountCents: -4_242,
    };
    assert.ok(backdated.qbTxnId! < first.continueAfter!.qbTxnId, "the fixture must actually sort before the cursor");
    rows = [...ROWS, backdated];

    const second = await run(1_000_000);
    assert.equal(second.ok, true);
    assert.ok(store.stored.has("txn-0000"), "the backdated row is ingested by the finishing run's prefix rescan");
    assert.equal(state.continueAfter, null, "and the window still finishes clean");
});

test("a row restated BEHIND the cursor (same qbTxnId, different content) is flagged, not silently skipped", async () => {
    const store = idempotentStore();
    const state: { highWater: string | null; lastFullSweep: string | null; continueAfter?: { postedDate: string; qbTxnId: string } | null } = {
        highWater: "2026-08-30", lastFullSweep: "2026-09-01", continueAfter: null,
    };
    let rows = ROWS;
    const run = (budgetMs: number) => {
        let clock = 0;
        return runBankRegisterPull({
            now: () => Date.parse("2026-09-02T02:00:00Z"),
            fetchRows: async () => ({ rows, stale: false }),
            ingest: store.ingest,
            reconcile: async () => ({ linked: 0, proposed: 0 }),
            windowState: { ...state },
            saveWindowState: async next => { Object.assign(state, next); },
            elapsedMs: () => (clock += 20_000) - 20_000,
            budgetMs,
        });
    };

    const first = await run(25_000);
    assert.ok(first.continueAfter, "run 1 stopped part way through");
    // Pick a qbTxnId that was actually posted in run 1's prefix (sorts before
    // the cursor) and restate its amount — QuickBooks editing a transaction
    // we already recorded, behind the point we resumed from.
    const restatedId = "txn-0";
    assert.ok(restatedId < first.continueAfter!.qbTxnId, "must fall in the prefix run 1 already posted");
    assert.ok(store.stored.has(restatedId), "sanity: run 1 really did post it");
    rows = ROWS.map(r => (r.qbTxnId === restatedId ? { ...r, amountCents: -999_999 } : r));

    const second = await run(1_000_000);
    assert.equal(second.ok, false, "a restatement in the prefix fails the run, exactly like one in `pending`");
    assert.equal(second.error, "qbo-txn-conflict");
    assert.deepEqual(second.conflictQbTxnIds, [restatedId]);
    assert.notEqual(state.continueAfter, null, "an unresolved restatement must not let the window look finished");
    const storedContent = JSON.parse(store.stored.get(restatedId) as string) as [string, number, string, string | null];
    assert.notEqual(storedContent[1], -999_999, "the stored observation is never silently overwritten");
});

test("splitAtCursor: the prefix is everything resumeAfter would have discarded", () => {
    const l = (postedDate: string, qbTxnId: string): BankRegisterIngestLine =>
        ({ postedDate, amountCents: -1, rawDescriptor: "X", checkNumber: null, qbTxnId, clearedStatus: "Reconciled" });
    const lines = [l("2026-08-02", "b"), l("2026-08-01", "z"), l("2026-08-02", "a")];

    const noCursor = splitAtCursor(lines, null);
    assert.deepEqual(noCursor.prefix, []);
    assert.deepEqual(noCursor.pending.map(x => x.qbTxnId), resumeAfter(lines, null).map(x => x.qbTxnId));

    const cursor = { postedDate: "2026-08-02", qbTxnId: "a" };
    const split = splitAtCursor(lines, cursor);
    assert.deepEqual(split.pending.map(x => x.qbTxnId), resumeAfter(lines, cursor).map(x => x.qbTxnId));
    assert.deepEqual(split.prefix.map(x => x.qbTxnId), ["z", "a"], "everything at/before the cursor, in order");
});

test("a COMPLETE run clears the continuation point", async () => {
    const state: PullWindowState = {
        highWater: "2026-08-30", lastFullSweep: "2026-09-01",
        continueAfter: { postedDate: "2026-08-30", qbTxnId: "txn-5" },
    };
    await runBankRegisterPull(deps({
        windowState: { ...state },
        saveWindowState: async (next: PullWindowState) => { Object.assign(state, next); },
        elapsedMs: () => 0,
        budgetMs: 45_000,
    }));
    assert.equal(state.continueAfter, null, "finished means there is nothing to resume");
});

// ── The scan boundary is what we SCANNED, not what came back (item 5) ───────

test("advanceScanBoundary moves to the window end, and never backwards", () => {
    const line = (postedDate: string): BankRegisterIngestLine =>
        ({ postedDate, amountCents: -1, rawDescriptor: "X", checkNumber: null, qbTxnId: postedDate, clearedStatus: "Reconciled" });
    // An EMPTY window still advances the mark: we looked, and there was nothing.
    assert.equal(advanceScanBoundary("2026-01-01", "2026-03-01", []), "2026-03-01");
    assert.equal(advanceScanBoundary(null, "2026-03-01", []), "2026-03-01");
    // A row newer than the window end (QBO can post ahead of it) still wins.
    assert.equal(advanceScanBoundary("2026-01-01", "2026-03-01", [line("2026-03-05")]), "2026-03-05");
    // And it never rewinds.
    assert.equal(advanceScanBoundary("2026-05-01", "2026-03-01", [line("2026-02-01")]), "2026-05-01");
});

test("an OLD mark plus an EMPTY capped window still advances the boundary", async () => {
    // THE DEADLOCK: with the mark derived only from returned transactions, a
    // January mark asked for Jan–Feb, that stretch held nothing, the mark did
    // not move, and the NEXT run planned exactly the same window. The pull never
    // reached the present while every run reported success.
    const saved: PullWindowState[] = [];
    const state: PullWindowState = { highWater: "2026-01-01", lastFullSweep: "2026-09-01" };
    const planned = planPullWindow(state, NOW);
    assert.equal(planned.continues, true, "a 60-day cap with more history behind it");

    const summary = await runBankRegisterPull(deps({
        windowState: state,
        saveWindowState: async (next: PullWindowState) => { saved.push(next); },
        fetchRows: async () => ({ rows: [] as BankRegisterRowLike[], stale: false }),
        elapsedMs: () => 0,
        budgetMs: 45_000,
    }));

    assert.equal(summary.ok, true);
    assert.equal(summary.observations, 0);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].highWater, planned.endDate, "the mark moves to the end of what we scanned");
    assert.ok(saved[0].highWater! > "2026-01-01");

    // And the NEXT run therefore asks for a different, later window.
    const next = planPullWindow(saved[0], NOW);
    assert.ok(next.startDate > planned.startDate, `${next.startDate} must be past ${planned.startDate}`);
});

// ── `complete` is not `ok` (round-12 item 3) ───────────────────────────────

test("a budget-truncated window is ok:true, complete:false — and mints nothing", async () => {
    // Folding the two together forced a choice between two wrong answers: page
    // a human for a backlog that is draining normally, or let a run that read
    // half its window MINT canonical ledger rows and stamp the freshness clock.
    const saved: PullWindowState[] = [];
    const mintCalls: Array<number | undefined> = [];
    let clock = 0;
    const summary = await runBankRegisterPull(deps({
        windowState: { highWater: "2026-08-30", lastFullSweep: "2026-09-01" },
        saveWindowState: async (next: PullWindowState) => { saved.push(next); },
        mintFromQbo: async (_account: string, deadlineAt?: number) => {
            mintCalls.push(deadlineAt);
            return { minted: 1, skipped: {} };
        },
        // 1,200 rows = 3 batches; the third check is over budget.
        elapsedMs: () => (clock += 20_000) - 20_000,
        budgetMs: 25_000,
    }));

    assert.equal(summary.ok, true, "truncation is not a failure");
    assert.equal(summary.complete, false, "but the picture is partial");
    assert.equal(summary.continues, true);
    assert.deepEqual(mintCalls, [], "and NOTHING is minted from a half-read window");
    assert.equal(summary.mintSkipped, "incomplete-window");
    assert.equal(saved.length, 1, "the checkpoint is still persisted");
    assert.ok(saved[0].continueAfter, "with the resume point on it");
});

test("a capped window and un-attempted links are incomplete, not failures", async () => {
    // A capped window has history behind it; `remaining` links are the linker
    // hitting its own cap. Both leave the picture partial, neither is a fault.
    const capped = await runBankRegisterPull(deps({
        windowState: { highWater: "2026-01-01", lastFullSweep: "2026-09-01" },
        saveWindowState: async () => {},
        elapsedMs: () => 0,
        budgetMs: 45_000,
    }));
    assert.equal(capped.ok, true);
    assert.equal(capped.complete, false, "60-day cap: more history behind it");

    const incomplete = await runBankRegisterPull(deps({
        reconcile: async () => ({ linked: 1, proposed: 5, chunkErrors: 0, remaining: 4 }),
        elapsedMs: () => 0,
        budgetMs: 45_000,
    }));
    assert.equal(incomplete.ok, true, "links not attempted are not an error");
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.error, "reconcile-incomplete");

    // A ROLLED-BACK chunk still is a failure — that one is something going wrong.
    const rolledBack = await runBankRegisterPull(deps({
        reconcile: async () => ({ linked: 0, proposed: 5, chunkErrors: 1, remaining: 0 }),
        elapsedMs: () => 0,
        budgetMs: 45_000,
    }));
    assert.equal(rolledBack.ok, false);
    assert.equal(rolledBack.complete, false);
});

// ── The absolute deadline reaches reconcile and mint (item 4) ──────────────

test("reconcile and mint are handed an absolute deadline, minus the reserve", async () => {
    const seen: Array<number | undefined> = [];
    const at = 1_800_000_000_000;
    await runBankRegisterPull(deps({
        clock: () => at,
        elapsedMs: () => 10_000,
        budgetMs: 50_000,
        reconcile: async (_account: string, deadlineAt?: number) => {
            seen.push(deadlineAt);
            return { linked: 0, proposed: 0 };
        },
        mintFromQbo: async (_account: string, deadlineAt?: number) => {
            seen.push(deadlineAt);
            return { minted: 0, skipped: {} };
        },
    }));
    // 50s budget, 10s already spent, 5s held back for the checkpoint write.
    assert.deepEqual(seen, [at + 35_000, at + 35_000]);
    assert.equal(CHECKPOINT_RESERVE_MS, 5_000);
});

test("no budget means no deadline — every other caller runs unbounded", async () => {
    const seen: Array<number | undefined> = [];
    await runBankRegisterPull(deps({
        reconcile: async (_a: string, deadlineAt?: number) => { seen.push(deadlineAt); return { linked: 0, proposed: 0 }; },
    }));
    assert.deepEqual(seen, [undefined]);
});

test("exhaustion during the FETCH: nothing is ingested, the checkpoint still lands", async () => {
    // The fetch has already happened by the time the budget is checked, so a
    // slow QuickBooks can eat the whole invocation. Not one batch may post
    // after that — a partial post with no checkpoint is what made the next run
    // replay the same prefix.
    const ingestCalls: number[] = [];
    const saved: PullWindowState[] = [];
    const summary = await runBankRegisterPull(deps({
        windowState: { highWater: "2026-08-30", lastFullSweep: "2026-09-01" },
        saveWindowState: async (next: PullWindowState) => { saved.push(next); },
        ingest: async (_account: string, lines: BankRegisterIngestLine[]) => {
            ingestCalls.push(lines.length);
            return { status: 200, body: { ok: true, inserted: lines.length, existing: 0 } };
        },
        // The fetch alone spent the budget.
        elapsedMs: () => 60_000,
        budgetMs: 50_000,
    }));
    assert.deepEqual(ingestCalls, [], "not a single batch is posted");
    assert.equal(summary.ok, true);
    assert.equal(summary.complete, false);
    assert.equal(summary.remainingBatches, 3, "all three batches are still owed");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].highWater, "2026-08-30", "the mark cannot move past rows nobody stored");
});

test("exhaustion at the LAST ingest batch checkpoints the batch before it", async () => {
    const saved: PullWindowState[] = [];
    let checks = 0;
    // Batches 1 and 2 are inside the budget; the check before batch 3 is not.
    const summary = await runBankRegisterPull(deps({
        windowState: { highWater: "2026-08-30", lastFullSweep: "2026-09-01" },
        saveWindowState: async (next: PullWindowState) => { saved.push(next); },
        elapsedMs: () => (checks++ < 2 ? 0 : 60_000),
        budgetMs: 50_000,
    }));
    assert.equal(summary.continues, true);
    assert.equal(summary.remainingBatches, 1, "exactly the last batch");
    assert.equal(summary.complete, false);
    assert.equal(summary.ok, true);
    // The resume point is the last line of batch 2 in (date, qbTxnId) order —
    // the 1000th of 1200 — so batch 3 is exactly what the next run starts
    // with: no replay, no gap.
    const ordered = resumeAfter(
        ROWS.map(r => ({
            postedDate: r.date, amountCents: r.amountCents,
            rawDescriptor: r.name ?? "", checkNumber: null, qbTxnId: r.qbTxnId as string, clearedStatus: "Reconciled" as const,
        })),
        null,
    );
    assert.equal(summary.continueAfter?.qbTxnId, ordered[999].qbTxnId);
    assert.deepEqual(saved[0].continueAfter, summary.continueAfter);
});

// ── ONE 60-calendar-day boundary (round-13 item 4) ─────────────────────────

test("the oldest supported day is IN the window; the day before it is not", () => {
    // Day-based, not instant-based. `Date.now() - 60 * 86_400_000` is a time of
    // day, and postedDate is a `@db.Date` at UTC midnight — so an instant
    // boundary silently dropped the whole of its own oldest day, and moved
    // every time the cron fired.
    assert.equal(REGISTER_WINDOW_DAYS, 60);
    const now = new Date("2026-09-02T18:45:00Z");
    const oldest = registerWindowStartYmd(now);
    assert.equal(oldest, "2026-07-05", "60 calendar days, inclusive of both ends");

    // Inclusive of both ends: exactly 60 days are covered.
    const span = (Date.parse("2026-09-02T00:00:00Z") - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000 + 1;
    assert.equal(span, 60);

    // A DATE column value on the oldest day is at UTC midnight, and a `gte` on
    // the boundary must include it — that is the case an instant boundary lost.
    const boundary = registerWindowStart(now);
    assert.equal(boundary.toISOString(), "2026-07-05T00:00:00.000Z");
    assert.ok(new Date("2026-07-05T00:00:00Z") >= boundary, "the oldest supported day is IN");
    assert.ok(new Date("2026-07-04T00:00:00Z") < boundary, "the day before it is OUT");
    // And it does not drift with the time of day the cron happens to run.
    assert.equal(registerWindowStartYmd(new Date("2026-09-02T00:00:01Z")), oldest);
    assert.equal(registerWindowStartYmd(new Date("2026-09-02T23:59:59Z")), oldest);
});

test("the deep sweep, the chaser and minting all use that ONE boundary", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    // The sweep plans exactly the shared window.
    const sweep = planPullWindow({ highWater: "2026-09-01", lastFullSweep: null }, NOW);
    assert.equal(sweep.fullSweep, true);
    assert.equal(sweep.startDate, registerWindowStartYmd(NOW));

    // The chaser and the mint pass read the same constant rather than their own.
    const chaser = readFileSync(join(root, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(chaser, /export const LOOKBACK_DAYS = REGISTER_WINDOW_DAYS;/);
    assert.match(chaser, /registerWindowStartYmd\(now, LOOKBACK_DAYS\)/);
    const mint = readFileSync(join(root, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(mint, /const MINT_LOOKBACK_DAYS = REGISTER_WINDOW_DAYS;/);
    assert.match(mint, /registerWindowStart\(new Date\(\), MINT_LOOKBACK_DAYS\)/);
    // 45 was the old, SHORTER mint window — the dangerous direction.
    assert.doesNotMatch(mint, /MINT_LOOKBACK_DAYS = 45/);
});
