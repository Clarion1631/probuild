import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { continuationNeedsWork, parseSweepCursor, cursorUsableAt } from "../src/app/api/cron/receipt-requests/route";
import { chaserCompletedFor, cycleStillValid, cycleMatchesPlannerDay, type SweepMarker } from "../src/lib/receipt-sweep-marker";

const now = new Date("2026-09-10T14:20:00Z");
const complete = {
  marker: { phase: "done", chaserCompletedAt: "2026-09-10T14:06:00Z", completedCycleId: "cycle", blockedReason: null } as SweepMarker,
  // plannerDay matches `now`'s own UTC day, so continuationNeedsWork's
  // plannerDay check (Codex round 1, real issue) does not itself reopen
  // this "unchanged" fixture — the legacy/stale-day case gets its own test
  // below instead of silently changing what every other case here means.
  cycle: { id: "cycle", epoch: "7", evidenceEpoch: "9", plannerDay: "2026-09-10" },
  bankEpoch: "7", evidenceEpoch: "9", fullRunOwed: false,
  lineCursor: null, openCursor: null, now,
};

test("a :20 continuation leaves a completed unchanged cycle eligible for :30 cards", () => {
  assert.equal(continuationNeedsWork(complete), false);
  assert.equal(chaserCompletedFor(complete.marker, "2026-09-10", "America/Los_Angeles", complete.cycle.id), true);
});

test("owed full run wins over an unchanged completion", () => {
  assert.equal(continuationNeedsWork({ ...complete, fullRunOwed: true }), true);
});

test("either changed epoch resumes instead of trusting an old completion", () => {
  assert.equal(continuationNeedsWork({ ...complete, bankEpoch: "8" }), true);
  assert.equal(continuationNeedsWork({ ...complete, evidenceEpoch: "10" }), true);
});

test("recognition policy changes resume even a completed cycle with no cursors", () => {
  assert.equal(continuationNeedsWork({ ...complete, recognitionPolicy: "receipt-source-v1:off" }), false);
  assert.equal(continuationNeedsWork({ ...complete, recognitionPolicy: "receipt-source-v1:on" }), true);
  const enabled = { ...complete, cycle: { ...complete.cycle, recognitionPolicy: "receipt-source-v1:on" } };
  assert.equal(continuationNeedsWork({ ...enabled, recognitionPolicy: "receipt-source-v1:on" }), false);
  assert.equal(continuationNeedsWork({ ...enabled, recognitionPolicy: "receipt-source-v1:off" }), true);
});

test("unfinished or malformed persisted cycles never disappear without a cursor", () => {
  for (const marker of [
    { ...complete.marker, phase: "open-issues" as const },
    { ...complete.marker, phase: "lines" as const },
    { ...complete.marker, chaserCompletedAt: null },
    { ...complete.marker, chaserCompletedAt: "malformed" },
    { ...complete.marker, chaserCompletedAt: "2026-09-11T14:00:00Z" },
    { ...complete.marker, completedCycleId: "old-cycle" },
    { ...complete.marker, blockedReason: "bank-pull-stale" },
  ]) assert.equal(continuationNeedsWork({ ...complete, marker }), true);
});

test("terminal cursor cleanup crash does not invalidate a durably certified unchanged cycle", () => {
  assert.equal(continuationNeedsWork({ ...complete, lineCursor: "terminal-checkpoint" }), false);
});

test("older completed cycle stays idle until full intent or changed evidence exists", () => {
  assert.equal(continuationNeedsWork({ ...complete, marker: { ...complete.marker, chaserCompletedAt: "2026-09-09T14:06:00Z" } }), false);
});

test("a certified cycle whose plannerDay is not today still resumes (Codex round 1, real issue: legacy cycles need not restart after deployment)", () => {
  // A legacy cycle (stored before plannerDay existed) carries none at all —
  // "it restarts once after deploy" per that field's own doc comment. Before
  // this fix, continuationNeedsWork never checked it, so a legacy cycle that
  // otherwise still certified (unchanged epochs, same id) went idle forever
  // instead: cardSelectionCertified already refuses to build a card from it
  // (cycleMatchesPlannerDay), but nothing ever created the fresh cycle that
  // would fix that, short of an unrelated epoch bump or a full-run request.
  const legacy = { ...complete, cycle: { id: "cycle", epoch: "7", evidenceEpoch: "9" } };
  assert.equal(cycleMatchesPlannerDay(legacy.cycle, legacy.now), false, "control: no plannerDay never matches");
  assert.equal(continuationNeedsWork(legacy), true);

  // Same story for a cycle that planned against a day that is no longer
  // today (a UTC-midnight rollover with no epoch change since).
  const staleDay = { ...complete, cycle: { ...complete.cycle, plannerDay: "2026-09-09" } };
  assert.equal(continuationNeedsWork(staleDay), true);
});

test("empty initial state is idle but phase, cursor, or full intent remains resumable", () => {
  const empty = { ...complete, cycle: null, marker: { phase: "done" as const, chaserCompletedAt: null } };
  assert.equal(continuationNeedsWork(empty), false);
  assert.equal(continuationNeedsWork({ ...empty, openCursor: "unfinished" }), true);
  assert.equal(continuationNeedsWork({ ...empty, lineCursor: "unfinished" }), true);
  assert.equal(continuationNeedsWork({ ...empty, fullRunOwed: true }), true);
});

test("interruption after replacing the policy cycle cannot skip the open-issue restart", async () => {
  const source = readFileSync(new URL('../src/app/api/cron/receipt-requests/route.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('    let effectiveStartPhase = startPhase;');
  const end = source.indexOf('    // Every bank-line issue, open OR cleared.', begin);
  assert.ok(begin > 0 && end > begin);
  const initSource = source.slice(begin, end);
  // Execute the real initialization sequence with only its persistence dependencies replaced.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const initialize = new AsyncFunction('state', 'deps', `
    const { budget, readCycle, readCursor, readOpenCursor, parseSweepCursor, cycleStillValid,
      cycleMatchesPlannerDay, cursorUsableAt, writeCursor, writeOpenCursor, writeCycle, writePhase, writeFullRunRequested } = deps;
    const snapshotEpoch = '7', snapshotEvidenceEpoch = '9', RECOGNITION_POLICY = 'receipt-source-v1:on';
    const randomUUID = () => 'new-policy-cycle';
    const clearFullRunRequestOnStart = false, prisma = {}, console = {log(){}};
    const now = new Date('2026-09-10T14:20:00Z'), plannerDay = '2026-09-10', progress = undefined;
    let startPhase = state.phase;
    ${initSource}
    return startPhase;
  `);
  const state: any = { phase: 'lines', cycle: { id: 'old', epoch: '7', evidenceEpoch: '9', recognitionPolicy: 'receipt-source-v1:off' } };
  let interrupt = true;
  const deps = {
    budget: { check() {} }, readCycle: async () => ({ ...state.cycle }),
    readCursor: async () => null, readOpenCursor: async () => null,
    parseSweepCursor, cycleStillValid, cycleMatchesPlannerDay, cursorUsableAt,
    writeCursor: async () => {}, writeOpenCursor: async () => {}, writeFullRunRequested: async () => {},
    writeCycle: async (cycle: unknown) => { state.cycle = cycle; if (interrupt) throw new Error('interruption after persisted cycle'); },
    writePhase: async (phase: string) => { state.phase = phase; },
  };
  await assert.rejects(initialize(state, deps), /interruption/);
  interrupt = false;
  assert.equal(await initialize(state, deps), 'open-issues', 'restart survives a crash after the new cycle is durable');
});
