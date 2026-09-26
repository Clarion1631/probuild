import test from "node:test";
import assert from "node:assert/strict";
import { anyDispatchFreshness, templateAFreshness, type PollHealth } from "../src/lib/speed-to-lead/freshness";

const NOW = new Date("2026-01-01T00:20:00.000Z");
const INTAKE_RECEIVED_AT = new Date("2026-01-01T00:00:00.000Z");

test("no successful poll ever recorded is never fresh", () => {
    const health: PollHealth = { lastPollStartedAt: null, lastPollFinishedAt: null, lastPollOk: null };
    assert.equal(anyDispatchFreshness(health, NOW).fresh, false);
});

test("a poll marked NOT ok is never fresh even if recent", () => {
    const health: PollHealth = { lastPollStartedAt: NOW, lastPollFinishedAt: NOW, lastPollOk: false };
    assert.equal(anyDispatchFreshness(health, NOW).fresh, false);
});

test("anyDispatchFreshness: fresh within 10 minutes, stale just past it", () => {
    const finishedAt = new Date(NOW.getTime() - 10 * 60 * 1000);
    const health: PollHealth = { lastPollStartedAt: finishedAt, lastPollFinishedAt: finishedAt, lastPollOk: true };
    assert.equal(anyDispatchFreshness(health, NOW).fresh, true);

    const staleFinishedAt = new Date(NOW.getTime() - 10 * 60 * 1000 - 1);
    const staleHealth: PollHealth = { lastPollStartedAt: staleFinishedAt, lastPollFinishedAt: staleFinishedAt, lastPollOk: true };
    assert.equal(anyDispatchFreshness(staleHealth, NOW).fresh, false);
});

test("templateAFreshness requires the poll to have STARTED after the intake's receive time", () => {
    const health: PollHealth = {
        lastPollStartedAt: new Date(INTAKE_RECEIVED_AT.getTime() - 1_000), // started BEFORE intake
        lastPollFinishedAt: NOW,
        lastPollOk: true,
    };
    const result = templateAFreshness(health, INTAKE_RECEIVED_AT, NOW);
    assert.equal(result.fresh, false);
    assert.match(result.reason ?? "", /since this lead's intake/);
});

test("templateAFreshness passes when the poll started after intake and finished within 5 minutes", () => {
    const health: PollHealth = {
        lastPollStartedAt: new Date(INTAKE_RECEIVED_AT.getTime() + 1_000),
        lastPollFinishedAt: new Date(NOW.getTime() - 4 * 60 * 1000),
        lastPollOk: true,
    };
    assert.equal(templateAFreshness(health, INTAKE_RECEIVED_AT, NOW).fresh, true);
});

test("templateAFreshness fails when the poll finished more than 5 minutes ago, even if it started after intake", () => {
    const health: PollHealth = {
        lastPollStartedAt: new Date(INTAKE_RECEIVED_AT.getTime() + 1_000),
        lastPollFinishedAt: new Date(NOW.getTime() - 6 * 60 * 1000),
        lastPollOk: true,
    };
    assert.equal(templateAFreshness(health, INTAKE_RECEIVED_AT, NOW).fresh, false);
});

test("templateAFreshness inherits the looser 10-minute failure from anyDispatchFreshness", () => {
    const health: PollHealth = { lastPollStartedAt: null, lastPollFinishedAt: null, lastPollOk: null };
    assert.equal(templateAFreshness(health, INTAKE_RECEIVED_AT, NOW).fresh, false);
});
