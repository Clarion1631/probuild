import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSweepBudget,
  runCheckpointedUnits,
  SweepDeferredError,
} from "../src/lib/receipt-sweep-budget";

const LIMIT_MS = 45_000;
const TX_TIMEOUT_MS = 15_000;
const TX_MAX_WAIT_MS = 2_000;

function fakeClock(initialMs = 0) {
  let nowMs = initialMs;
  return {
    now: () => nowMs,
    set: (ms: number) => {
      nowMs = ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function recorder<T>() {
  const processed: T[] = [];
  const checkpointed: T[] = [];
  return {
    processed,
    checkpointed,
    process: async (unit: T) => {
      processed.push(unit);
    },
    checkpoint: async (unit: T) => {
      checkpointed.push(unit);
    },
  };
}

test("normal finish processes and checkpoints every unit in order", async () => {
  const clock = fakeClock(0);
  const budget = createSweepBudget(0, clock.now, LIMIT_MS);
  const rec = recorder<string>();
  const result = await runCheckpointedUnits(["a", "b", "c"], budget, rec.process, rec.checkpoint);
  assert.deepEqual(result, { completed: 3, deferred: false, exhausted: true });
  assert.deepEqual(rec.processed, ["a", "b", "c"]);
  assert.deepEqual(rec.checkpointed, ["a", "b", "c"]);
  assert.equal(budget.expired(), false);
});

test("setup consumes original deadline so check throws before any work", () => {
  const clock = fakeClock(LIMIT_MS + 1);
  const budget = createSweepBudget(0, clock.now, LIMIT_MS);
  assert.equal(budget.expired(), true);
  assert.throws(() => budget.check(), (err: unknown) => {
    assert.ok(err instanceof SweepDeferredError);
    assert.equal((err as { retryable?: boolean }).retryable, false);
    return true;
  });
});

test("expired budget defers the first unit without calling process", async () => {
  const clock = fakeClock(LIMIT_MS);
  const budget = createSweepBudget(0, clock.now, LIMIT_MS);
  const rec = recorder<string>();
  const result = await runCheckpointedUnits(["a", "b"], budget, rec.process, rec.checkpoint);
  assert.equal(result.completed, 0);
  assert.equal(result.deferred, true);
  assert.deepEqual(rec.processed, []);
  assert.deepEqual(rec.checkpointed, []);
});

test("first committed unit is checkpointed before the second unit defers", async () => {
  const clock = fakeClock(0);
  const budget = createSweepBudget(0, clock.now, LIMIT_MS);
  const rec = recorder<string>();
  const process = async (unit: string) => {
    await rec.process(unit);
    clock.set(LIMIT_MS + 5);
  };
  const result = await runCheckpointedUnits(["a", "b", "c"], budget, process, rec.checkpoint);
  assert.equal(result.completed, 1);
  assert.equal(result.deferred, true);
  assert.deepEqual(rec.processed, ["a"]);
  assert.deepEqual(rec.checkpointed, ["a"]);
});

test("resume picks up the unfinished second unit without skipping the third", async () => {
  const units = ["a", "b", "c"];
  const clock = fakeClock(0);
  const first = createSweepBudget(0, clock.now, LIMIT_MS);
  const firstRec = recorder<string>();
  const firstRun = await runCheckpointedUnits(units, first, async (u) => {
    await firstRec.process(u);
    clock.set(LIMIT_MS);
  }, firstRec.checkpoint);
  assert.equal(firstRun.completed, 1);
  const cursor = firstRec.checkpointed[firstRec.checkpointed.length - 1];
  const remaining = units.slice(units.indexOf(cursor) + 1);
  assert.deepEqual(remaining, ["b", "c"]);
  const resumeStart = clock.now();
  const second = createSweepBudget(resumeStart, clock.now, LIMIT_MS);
  const secondRec = recorder<string>();
  const secondRun = await runCheckpointedUnits(remaining, second, secondRec.process, secondRec.checkpoint);
  assert.deepEqual(secondRun, { completed: 2, deferred: false, exhausted: true });
  assert.deepEqual(secondRec.processed, ["b", "c"]);
  assert.deepEqual(secondRec.checkpointed, ["b", "c"]);
});

test("commit that finishes after the deadline is still checkpointed", async () => {
  const clock = fakeClock(0);
  const budget = createSweepBudget(0, clock.now, LIMIT_MS);
  const rec = recorder<string>();
  const result = await runCheckpointedUnits(["only"], budget, async (u) => {
    await rec.process(u);
    clock.set(LIMIT_MS + 1000);
  }, rec.checkpoint);
  assert.deepEqual(rec.checkpointed, ["only"]);
  assert.equal(result.completed, 1);
  assert.equal(result.deferred, false);
  assert.equal(result.exhausted, true);
});

test("multi-verdict process that defers mid-way leaves no partial state", async () => {
  const clock = fakeClock(0);
  const budget = createSweepBudget(0, clock.now, LIMIT_MS);
  const committed: string[] = [];
  const checkpointed: string[] = [];
  const process = async (unit: string) => {
    const staged: string[] = [];
    for (const verdict of ["v1", "v2", "v3"]) {
      staged.push(`${unit}:${verdict}`);
      if (verdict === "v2") clock.set(LIMIT_MS + 1);
      budget.check();
    }
    committed.push(...staged);
  };
  const result = await runCheckpointedUnits(["r1", "r2"], budget, process, async (u) => {
    checkpointed.push(u);
  });
  assert.deepEqual(result, { completed: 0, deferred: true, exhausted: false });
  assert.deepEqual(committed, []);
  assert.deepEqual(checkpointed, []);
});

test("non-deferral errors propagate and the failed unit is not checkpointed", async () => {
  const clock = fakeClock(0);
  const budget = createSweepBudget(0, clock.now, LIMIT_MS);
  const rec = recorder<string>();
  const boom = new Error("integrity violation");
  await assert.rejects(
    runCheckpointedUnits(["a", "b"], budget, async (u) => {
      if (u === "b") throw boom;
      await rec.process(u);
    }, rec.checkpoint),
    (err: unknown) => err === boom,
  );
  assert.deepEqual(rec.checkpointed, ["a"]);
});

test("second transaction attempt is refused once the first consumed the budget", () => {
  const clock = fakeClock(0);
  const budget = createSweepBudget(0, clock.now, LIMIT_MS);
  assert.deepEqual(budget.transactionOptions(), { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS });
  clock.advance(LIMIT_MS - TX_TIMEOUT_MS);
  assert.throws(() => budget.transactionOptions(), SweepDeferredError);
  assert.equal(budget.expired(), false);
});

test("transaction options are admitted only when timeout plus maxWait fit exactly", () => {
  const clock = fakeClock(LIMIT_MS - (TX_TIMEOUT_MS + TX_MAX_WAIT_MS));
  const budget = createSweepBudget(0, clock.now, LIMIT_MS);
  const opts = budget.transactionOptions();
  assert.equal(opts.timeout + opts.maxWait, TX_TIMEOUT_MS + TX_MAX_WAIT_MS);
  clock.advance(1);
  assert.throws(() => budget.transactionOptions(), SweepDeferredError);
});


test("the final checkpoint survives a deferred completion fence", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/app/api/cron/receipt-requests/route.ts", "utf8");
  const sweep = source.slice(source.indexOf("async function runSweep("));
  assert.ok(sweep.includes("clearCertifiedSweepCheckpoint(decision.complete, () => writeCursor(null))"));
  assert.ok(!sweep.includes("if (exhausted && totals.errors === 0) await writeCursor(null)"));
  const clock = fakeClock(0);
  let cursor: string | null = null;
  const first = createSweepBudget(0, clock.now);
  await runCheckpointedUnits(["last-component"], first, async () => { clock.set(35_000); }, async unit => { cursor = unit; });
  assert.throws(() => first.transactionOptions(), SweepDeferredError);
  assert.equal(cursor, "last-component");
  const remaining = ["last-component"].filter(unit => unit !== cursor);
  const second = createSweepBudget(clock.now(), clock.now);
  let reruns = 0;
  const result = await runCheckpointedUnits(remaining, second, async () => { reruns++; }, async () => {});
  assert.equal(result.exhausted, true);
  assert.equal(reruns, 0);
  assert.doesNotThrow(() => second.transactionOptions());
});


test("route adapter retains terminal cursor until a fresh continuation certifies", async () => {
  const { clearCertifiedSweepCheckpoint, fenceAndWritePhase } = await import("../src/app/api/cron/receipt-requests/route");
  let cursor: string | null = "last-component";
  await clearCertifiedSweepCheckpoint(false, async () => { cursor = null; });
  assert.equal(cursor, "last-component");
  let processed = 0;
  const next = createSweepBudget(0, () => 0);
  const units = ["last-component"].filter(key => key !== cursor);
  await runCheckpointedUnits(units, next, async () => { processed++; }, async () => {});
  const decision = await fenceAndWritePhase({ snapshotEpoch: "1", snapshotEvidenceEpoch: "1", computedPhase: "done", bankPullStale: false, now: new Date() }, async fn => fn({ lockEpoch: async () => "1", lockEvidenceEpoch: async () => "1", countNewLines: async () => 0, writePhase: async () => {} }));
  await clearCertifiedSweepCheckpoint(decision.complete, async () => { cursor = null; });
  assert.equal(processed, 0);
  assert.equal(cursor, null);
});

test("route transaction adapter counts only a resolved commit, not callback success followed by rollback", async () => {
  const { runBudgetedComponent } = await import("../src/app/api/cron/receipt-requests/route");
  const clock = fakeClock(0); let attempts = 0; let committed = 0;
  await runBudgetedComponent(createSweepBudget(0, clock.now), async () => {
    attempts++;
    const callbackResult = { closed: 2 };
    if (attempts === 1) throw Object.assign(new Error("commit rejected"), { code: "P2034" });
    return callbackResult;
  }, result => { committed += result.closed; });
  assert.equal(attempts, 2); assert.equal(committed, 2);
  attempts = 0; committed = 0;
  await assert.rejects(runBudgetedComponent(createSweepBudget(0, clock.now), async () => {
    attempts++; clock.set(30_000);
    throw Object.assign(new Error("transaction timed out after callback"), { code: "P2028" });
  }, () => { committed++; }), SweepDeferredError);
  assert.equal(attempts, 1); assert.equal(committed, 0);
});

test("route setup deferral preserves lines phase and honors a persisted epoch restart", async () => {
  const { preserveDeferredSweepPhase } = await import("../src/app/api/cron/receipt-requests/route");
  const written: string[] = [];
  assert.equal(await preserveDeferredSweepPhase(async () => "lines", async phase => { written.push(phase); }), "lines");
  assert.equal(await preserveDeferredSweepPhase(async () => "open-issues", async phase => { written.push(phase); }), "open-issues");
  assert.deepEqual(written, ["lines", "open-issues"]);
});


test("budgeted closure refuses a partial competing set after a slow read", async () => {
  const { loadComponentToClosure, ComponentDeadlineExceededError } = await import("../src/lib/receipt-requests");
  const clock = fakeClock(0); const budget = createSweepBudget(0, clock.now); let reads = 0;
  await assert.rejects(loadComponentToClosure("2026-09-01", async () => { reads++; clock.set(45_000); return [{ id: "first", postedDate: "2026-09-01" }]; }, { maxNodes: 200, deadlineExceeded: budget.expired }), ComponentDeadlineExceededError);
  assert.equal(reads, 1);
});

test("lineage loader stops between reads without returning truncated evidence", async () => {
  const { loadRetiredReceiptLineage } = await import("../src/lib/retired-receipt-lineage");
  const clock = fakeClock(0); const budget = createSweepBudget(0, clock.now); let laterReads = 0;
  await assert.rejects(loadRetiredReceiptLineage({ bankLine: { findMany: async () => { clock.set(45_000); return []; } }, bankLineObservation: { findMany: async () => { laterReads++; return []; } }, expense: { findMany: async () => { laterReads++; return []; } } }, ["line"], { checkBudget: budget.check }), SweepDeferredError);
  assert.equal(laterReads, 0);
});

test("a single work page never fragments a competition component", async () => {
  const { groupCompetingLines, pageComponents } = await import("../src/lib/receipt-requests");
  const components = groupCompetingLines([{ id: "a", postedDate: "2026-09-01", amountCents: -100 }, { id: "b", postedDate: "2026-09-02", amountCents: -100 }, { id: "c", postedDate: "2026-09-02", amountCents: -200 }]);
  const pages = pageComponents(components, 1);
  assert.equal(pages.length, 2);
  assert.ok(pages.some(page => page.length === 1 && page[0].lineIds.includes("a") && page[0].lineIds.includes("b")));
});

test("a checkpoint failure propagates even if it resembles budget deferral", async () => {
  const error = new SweepDeferredError("checkpoint failed");
  await assert.rejects(runCheckpointedUnits(["a"], createSweepBudget(0, () => 0), async () => {}, async () => { throw error; }), e => e === error);
});

test("production wiring keeps one entry clock, full closure, and bounded orphan attempts", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/app/api/cron/receipt-requests/route.ts", "utf8");
  const get = source.slice(source.indexOf("export async function GET"));
  assert.ok(get.indexOf("createSweepBudget(Date.now(), Date.now, RUN_BUDGET_MS)") < get.indexOf("isCronAuthorized(request)"));
  assert.equal(source.split("runCheckpointedUnits([page], budget").length - 1, 2);
  assert.ok(source.includes("loadCompetingComponent(row, budget.expired)"));
  assert.ok(source.includes("checkBudget: budget.check"));
  assert.ok(source.includes("prisma.$transaction(tx => fn(tx as unknown as ReviewIssueLifecycleClient), options)"));
  assert.ok(source.includes("transaction(budget.transactionOptions())"));
});
