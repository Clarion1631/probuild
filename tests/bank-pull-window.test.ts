import assert from "node:assert/strict";
import test from "node:test";
import {
    PULL_FULL_SWEEP_DAYS,
    PULL_MAX_WINDOW_DAYS,
    PULL_OVERLAP_DAYS,
    advanceScanBoundary,
    highWaterOf,
    resumeAfter,
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
        ({ postedDate, amountCents: -1, rawDescriptor: "X", checkNumber: null, qbTxnId: postedDate });
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
        ({ postedDate, amountCents: -1, rawDescriptor: "X", checkNumber: null, qbTxnId });
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

test("two budget-limited runs make PROGRESS instead of replaying the same prefix", async () => {
    // The high-water mark only moves on a COMPLETE run, which is right — but it
    // meant a half-finished run recorded nothing, so the next one re-fetched
    // the same window and died at the same place. A big backlog never drained.
    const posted: string[][] = [];
    const state: { highWater: string | null; lastFullSweep: string | null; continueAfter?: { postedDate: string; qbTxnId: string } | null } = {
        highWater: "2026-08-30", lastFullSweep: "2026-09-01", continueAfter: null,
    };
    const run = async () => {
        let clock = 0;
        return runBankRegisterPull({
            now: () => Date.parse("2026-09-02T02:00:00Z"),
            fetchRows: async () => ({ rows: ROWS, stale: false }),
            ingest: async (_a, batch) => {
                posted.push(batch.map(l => l.qbTxnId));
                return { status: 200, body: { ok: true, inserted: batch.length, existing: 0 } };
            },
            reconcile: async () => ({ linked: 0, proposed: 0 }),
            windowState: { ...state },
            saveWindowState: async next => { Object.assign(state, next); },
            elapsedMs: () => (clock += 20_000) - 20_000,
            budgetMs: 25_000,
        });
    };

    const first = await run();
    assert.equal(first.continues, true);
    assert.ok(first.continueAfter, "it must record where it stopped");
    assert.deepEqual(state.continueAfter, first.continueAfter, "and persist it");
    assert.equal(state.highWater, "2026-08-30", "the mark does NOT move on a partial run");

    const firstIds = posted.flat();
    posted.length = 0;
    const second = await run();
    const secondIds = posted.flat();

    assert.deepEqual(second.resumedAfter, first.continueAfter, "the second run picks up where the first stopped");
    assert.equal(secondIds.length > 0, true, "and it does real work");
    assert.equal(firstIds.some(id => secondIds.includes(id)), false, "no batch is posted twice");
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
        ({ postedDate, amountCents: -1, rawDescriptor: "X", checkNumber: null, qbTxnId: postedDate });
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
