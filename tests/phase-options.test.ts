import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPhaseOptions, selectCanonicalEstimateId, type PhaseCandidateItem } from "../src/lib/phase-options";

function item(overrides: Partial<PhaseCandidateItem> = {}): PhaseCandidateItem {
    return {
        estimateItemId: "item1",
        order: 0,
        costCodeId: "cc1",
        costCodeActive: true,
        costCodeCode: "01-DEMO",
        costCodeName: "Demolition",
        ...overrides,
    };
}

// ── buildPhaseOptions (operates on items already scoped to ONE estimate) ──

test("empty input -> empty output", () => {
    assert.deepEqual(buildPhaseOptions([]), []);
});

test("inactive cost codes are excluded", () => {
    const items = [item({ costCodeActive: false })];
    assert.deepEqual(buildPhaseOptions(items), []);
});

test("items with no cost code are excluded", () => {
    const items = [item({ costCodeId: null })];
    assert.deepEqual(buildPhaseOptions(items), []);
});

test("deduplicates by cost code, picking the lowest order as representative", () => {
    const items = [
        item({ estimateItemId: "later", costCodeId: "cc1", order: 5 }),
        item({ estimateItemId: "earliest", costCodeId: "cc1", order: 1 }),
        item({ estimateItemId: "middle", costCodeId: "cc1", order: 3 }),
    ];
    const result = buildPhaseOptions(items);
    assert.equal(result.length, 1);
    assert.equal(result[0].estimateItemId, "earliest");
});

test("ties on order break deterministically on estimateItemId", () => {
    const items = [
        item({ estimateItemId: "b-item", costCodeId: "cc1", order: 1 }),
        item({ estimateItemId: "a-item", costCodeId: "cc1", order: 1 }),
    ];
    const result = buildPhaseOptions(items);
    assert.equal(result[0].estimateItemId, "a-item");
});

test("result is sorted by cost code, not input order", () => {
    const items = [
        item({ estimateItemId: "x", costCodeId: "cc2", costCodeCode: "02-FRAME" }),
        item({ estimateItemId: "y", costCodeId: "cc1", costCodeCode: "01-DEMO" }),
    ];
    const result = buildPhaseOptions(items);
    assert.deepEqual(result.map((p) => p.code), ["01-DEMO", "02-FRAME"]);
});

// ── selectCanonicalEstimateId ──────────────────────────────────────────────

test("selectCanonicalEstimateId: no candidates -> null", () => {
    assert.equal(selectCanonicalEstimateId([]), null);
});

test("selectCanonicalEstimateId: a single candidate is canonical", () => {
    assert.equal(
        selectCanonicalEstimateId([{ estimateId: "est1", recencyKey: "2026-01-01T00:00:00.000Z" }]),
        "est1"
    );
});

test("selectCanonicalEstimateId: the most recently approved/created candidate wins", () => {
    const result = selectCanonicalEstimateId([
        { estimateId: "est-old", recencyKey: "2026-01-01T00:00:00.000Z" },
        { estimateId: "est-new", recencyKey: "2026-06-01T00:00:00.000Z" },
    ]);
    assert.equal(result, "est-new");
});

test("selectCanonicalEstimateId: ties on recencyKey break deterministically on the lower estimateId", () => {
    const result = selectCanonicalEstimateId([
        { estimateId: "est-b", recencyKey: "2026-01-01T00:00:00.000Z" },
        { estimateId: "est-a", recencyKey: "2026-01-01T00:00:00.000Z" },
    ]);
    assert.equal(result, "est-a");
});

// ── canonical-then-filter interaction (the fix) ────────────────────────────

test("BLOCKER regression: a newer approved estimate whose items have no active cost codes still becomes canonical, yielding an EMPTY phase list — not the older estimate's items", () => {
    // Selection runs over every Approved estimate for the project, regardless
    // of whether its items currently have an active cost code.
    const canonicalEstimateId = selectCanonicalEstimateId([
        { estimateId: "est-old", recencyKey: "2026-01-01T00:00:00.000Z" },
        { estimateId: "est-new", recencyKey: "2026-06-01T00:00:00.000Z" },
    ]);
    assert.equal(canonicalEstimateId, "est-new");

    // The route scopes the items query to just the canonical estimate (a DB
    // WHERE estimateId = canonicalEstimateId), so est-old's items — even
    // though they'd have qualified — are never even fetched. est-new's own
    // items exist but none have an active cost code (e.g. every code on it
    // was deactivated).
    const itemsOnCanonicalEstimate = [item({ estimateItemId: "new-item", costCodeId: "cc1", costCodeActive: false })];

    assert.deepEqual(buildPhaseOptions(itemsOnCanonicalEstimate), []);
});

test("a non-eligible estimate (Sent, or archived) never enters selectCanonicalEstimateId's candidate set even if more recent", () => {
    // The route only queries Estimate rows with status "Approved" and
    // archivedAt: null in the first place, so a Sent/archived estimate never
    // becomes a candidate at all — simulated here by simply not including it.
    const canonicalEstimateId = selectCanonicalEstimateId([
        { estimateId: "est-approved", recencyKey: "2026-01-01T00:00:00.000Z" },
    ]);
    assert.equal(canonicalEstimateId, "est-approved");
});
