import test from "node:test";
import assert from "node:assert/strict";
import { continuationNeedsWork } from "../src/app/api/cron/receipt-requests/route";
import { chaserCompletedFor, type SweepMarker } from "../src/lib/receipt-sweep-marker";

const now = new Date("2026-09-10T14:20:00Z");
const complete = {
  marker: { phase: "done", chaserCompletedAt: "2026-09-10T14:06:00Z", completedCycleId: "cycle", blockedReason: null } as SweepMarker,
  cycle: { id: "cycle", epoch: "7", evidenceEpoch: "9" },
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

test("empty initial state is idle but phase, cursor, or full intent remains resumable", () => {
  const empty = { ...complete, cycle: null, marker: { phase: "done" as const, chaserCompletedAt: null } };
  assert.equal(continuationNeedsWork(empty), false);
  assert.equal(continuationNeedsWork({ ...empty, openCursor: "unfinished" }), true);
  assert.equal(continuationNeedsWork({ ...empty, lineCursor: "unfinished" }), true);
  assert.equal(continuationNeedsWork({ ...empty, fullRunOwed: true }), true);
});
