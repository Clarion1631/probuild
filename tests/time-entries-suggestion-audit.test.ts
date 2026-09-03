/**
 * Unit tests for resolveSuggestionAudit (src/app/api/time-entries/route.ts),
 * the pure server-side provenance check for the client-supplied suggestion
 * audit fields (gate P2). Pure — no I/O, no Next.js request/response needed.
 *
 * Covers accepted (server-confirmed) and forged (client-claimed-only) cases
 * for both `suggestionSource: "dispatch"` and `suggestedCostCodeId`.
 *
 * time-entries/route.ts imports mobile-auth.ts STATICALLY, and mobile-auth.ts
 * throws at module load if NEXTAUTH_SECRET is unset — so it must be set
 * before the module is imported. Same pattern (and same reason) as
 * tests/time-entries-clockout-route.test.ts: set the env var at module-load
 * time, then import() lazily (no top-level await — tsx transforms this file
 * to CJS) and await the promise inside each test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-time-entries-route-tests";
const routeModulePromise = import("../src/app/api/time-entries/route");

test("accepted: dispatch source is kept when the server confirms the assignment", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "dispatch",
        suggestedCostCodeIdRaw: "cc-1",
        dispatchConfirmed: true,
        suggestedTaskResolvedCostCodeId: "cc-1",
    });
    assert.deepEqual(result, { suggestionSource: "dispatch", suggestedCostCodeId: "cc-1" });
});

test("forged: dispatch source is downgraded to null when the server cannot confirm the assignment", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "dispatch",
        suggestedCostCodeIdRaw: "cc-1",
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: "cc-1",
    });
    assert.equal(result.suggestionSource, null);
    // Cost code claim is independent of the source claim — still checked on its own.
    assert.equal(result.suggestedCostCodeId, "cc-1");
});

test("non-dispatch sources never require confirmation", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    for (const source of ["daily_log", "today_schedule", "user_history"]) {
        const result = resolveSuggestionAudit({
            suggestionSourceRaw: source,
            suggestedCostCodeIdRaw: null,
            dispatchConfirmed: false,
            suggestedTaskResolvedCostCodeId: undefined,
        });
        assert.equal(result.suggestionSource, source);
    }
});

test("an unrecognized suggestionSource string is dropped to null regardless of confirmation", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "made_up_source",
        suggestedCostCodeIdRaw: null,
        dispatchConfirmed: true,
        suggestedTaskResolvedCostCodeId: undefined,
    });
    assert.equal(result.suggestionSource, null);
});

test("a non-string suggestionSource is dropped to null", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: 42,
        suggestedCostCodeIdRaw: null,
        dispatchConfirmed: true,
        suggestedTaskResolvedCostCodeId: undefined,
    });
    assert.equal(result.suggestionSource, null);
});

test("accepted: suggestedCostCodeId is kept when it matches the resolved chargeable cost code", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "today_schedule",
        suggestedCostCodeIdRaw: "cc-1",
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: "cc-1",
    });
    assert.equal(result.suggestedCostCodeId, "cc-1");
});

test("forged: suggestedCostCodeId is downgraded to null when it disagrees with the resolved chargeable cost code", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "today_schedule",
        suggestedCostCodeIdRaw: "cc-attacker-supplied",
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: "cc-real",
    });
    assert.equal(result.suggestedCostCodeId, null);
});

test("suggestedCostCodeId is left as-is when there's no ground truth to check against (undefined)", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "today_schedule",
        suggestedCostCodeIdRaw: "cc-whatever",
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: undefined,
    });
    assert.equal(result.suggestedCostCodeId, "cc-whatever");
});

test("suggestedCostCodeId is left as-is when the suggested task resolves but has no chargeable cost code (null) and client sent none", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "today_schedule",
        suggestedCostCodeIdRaw: null,
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: null,
    });
    assert.equal(result.suggestedCostCodeId, null);
});

test("a non-string suggestedCostCodeId is dropped to null", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: null,
        suggestedCostCodeIdRaw: 123,
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: undefined,
    });
    assert.equal(result.suggestedCostCodeId, null);
});

test("gate P3: an uncosted resolved task (null ground truth) downgrades a forged non-null suggestedCostCodeId", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "today_schedule",
        suggestedCostCodeIdRaw: "cc-forged-nonnull",
        dispatchConfirmed: false,
        // The suggested task resolved fine, but it has no chargeable cost
        // code at all — null IS ground truth here, not "nothing to check".
        suggestedTaskResolvedCostCodeId: null,
    });
    assert.equal(result.suggestedCostCodeId, null);
});

test("combined forged case: forged dispatch source AND forged cost code both get downgraded independently", async () => {
    const { resolveSuggestionAudit } = await routeModulePromise;
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "dispatch",
        suggestedCostCodeIdRaw: "cc-attacker-supplied",
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: "cc-real",
    });
    assert.deepEqual(result, { suggestionSource: null, suggestedCostCodeId: null });
});

// ── Gate P1: resolvePunchBindingHint — when a binding hint reaches the punch binder ──

test("gate P1: confirmed dispatch winner, not overridden, source survived -> hint is passed", async () => {
    const { resolvePunchBindingHint } = await routeModulePromise;
    const hint = resolvePunchBindingHint({
        dispatchConfirmed: true,
        suggestionOverridden: false,
        finalSuggestionSource: "dispatch",
        suggestedScheduleTaskId: "task-winner",
    });
    assert.equal(hint, "task-winner");
});

test("gate P1: overridden suggestion ('Keep my choice' rejected it) -> no hint, even if otherwise confirmed", async () => {
    const { resolvePunchBindingHint } = await routeModulePromise;
    const hint = resolvePunchBindingHint({
        dispatchConfirmed: true,
        suggestionOverridden: true,
        finalSuggestionSource: "dispatch",
        suggestedScheduleTaskId: "task-winner",
    });
    assert.equal(hint, null);
});

test("gate P1: forged/lower-tier suggestion (dispatchConfirmed false) -> no hint", async () => {
    const { resolvePunchBindingHint } = await routeModulePromise;
    const hint = resolvePunchBindingHint({
        dispatchConfirmed: false,
        suggestionOverridden: false,
        finalSuggestionSource: "dispatch",
        suggestedScheduleTaskId: "task-not-the-winner",
    });
    assert.equal(hint, null);
});

test("gate P1: source downgraded away from 'dispatch' by provenance checking -> no hint even if dispatchConfirmed", async () => {
    const { resolvePunchBindingHint } = await routeModulePromise;
    // Can't actually happen together in practice (dispatchConfirmed=true
    // implies resolveSuggestionAudit keeps "dispatch"), but the gate must
    // stand on finalSuggestionSource on its own merits, not assume that.
    const hint = resolvePunchBindingHint({
        dispatchConfirmed: true,
        suggestionOverridden: false,
        finalSuggestionSource: "today_schedule",
        suggestedScheduleTaskId: "task-winner",
    });
    assert.equal(hint, null);
});

// ── Gate P2 continued: resolveSuggestedTaskGroundTruthCostCodeId + the full
// pipeline through resolveSuggestionAudit for a free-text/uncoded suggested
// task. Before this fix, a resolved task with no `estimateItemId` left
// ground truth `undefined` ("nothing to check against"), so a forged
// suggestedCostCodeId rode through unchecked. It must be `null` (definitive
// ground truth: no cost code) like any other uncosted resolution. ──

test("ground truth: a resolved task with no estimateItemId at all (free-text) is definitive null, not unknown", async () => {
    const { resolveSuggestedTaskGroundTruthCostCodeId } = await routeModulePromise;
    const groundTruth = resolveSuggestedTaskGroundTruthCostCodeId({ estimateItemId: null }, undefined);
    assert.equal(groundTruth, null);
});

test("ground truth: a task linked to an estimate item with no chargeable target is null", async () => {
    const { resolveSuggestedTaskGroundTruthCostCodeId } = await routeModulePromise;
    // estimateItemId is set, but the caller's resolver found no chargeable
    // target for it (resolvedTargetCostCodeId undefined) — still definitive null.
    const groundTruth = resolveSuggestedTaskGroundTruthCostCodeId({ estimateItemId: "item-1" }, undefined);
    assert.equal(groundTruth, null);
});

test("ground truth: a task linked to a resolving chargeable item returns its cost code id", async () => {
    const { resolveSuggestedTaskGroundTruthCostCodeId } = await routeModulePromise;
    const groundTruth = resolveSuggestedTaskGroundTruthCostCodeId({ estimateItemId: "item-1" }, "cc-real");
    assert.equal(groundTruth, "cc-real");
});

test("ground truth: no valid/on-project suggested task at all stays undefined (nothing to check)", async () => {
    const { resolveSuggestedTaskGroundTruthCostCodeId } = await routeModulePromise;
    const groundTruth = resolveSuggestedTaskGroundTruthCostCodeId(null, undefined);
    assert.equal(groundTruth, undefined);
});

test("gate P2: free-text suggested task (no estimateItemId) + forged non-null suggestedCostCodeId -> downgraded to null", async () => {
    const { resolveSuggestedTaskGroundTruthCostCodeId, resolveSuggestionAudit } = await routeModulePromise;
    const groundTruth = resolveSuggestedTaskGroundTruthCostCodeId({ estimateItemId: null }, undefined);
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "today_schedule",
        suggestedCostCodeIdRaw: "cc-forged",
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: groundTruth,
    });
    assert.equal(result.suggestedCostCodeId, null);
});

test("gate P2: linked-but-uncoded suggested task + forged non-null suggestedCostCodeId -> downgraded to null", async () => {
    const { resolveSuggestedTaskGroundTruthCostCodeId, resolveSuggestionAudit } = await routeModulePromise;
    const groundTruth = resolveSuggestedTaskGroundTruthCostCodeId({ estimateItemId: "item-1" }, undefined);
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "today_schedule",
        suggestedCostCodeIdRaw: "cc-forged",
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: groundTruth,
    });
    assert.equal(result.suggestedCostCodeId, null);
});

test("gate P2: linked+coded suggested task with a matching suggestedCostCodeId is kept", async () => {
    const { resolveSuggestedTaskGroundTruthCostCodeId, resolveSuggestionAudit } = await routeModulePromise;
    const groundTruth = resolveSuggestedTaskGroundTruthCostCodeId({ estimateItemId: "item-1" }, "cc-real");
    const result = resolveSuggestionAudit({
        suggestionSourceRaw: "today_schedule",
        suggestedCostCodeIdRaw: "cc-real",
        dispatchConfirmed: false,
        suggestedTaskResolvedCostCodeId: groundTruth,
    });
    assert.equal(result.suggestedCostCodeId, "cc-real");
});

test("gate P1: no suggestion sent at all -> no hint", async () => {
    const { resolvePunchBindingHint } = await routeModulePromise;
    const hint = resolvePunchBindingHint({
        dispatchConfirmed: false,
        suggestionOverridden: false,
        finalSuggestionSource: null,
        suggestedScheduleTaskId: undefined,
    });
    assert.equal(hint, null);
});
