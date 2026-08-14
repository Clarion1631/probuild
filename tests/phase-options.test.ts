import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPhaseOptions, type PhaseCandidateItem } from "../src/lib/phase-options";

function item(overrides: Partial<PhaseCandidateItem> = {}): PhaseCandidateItem {
    return {
        estimateItemId: "item1",
        order: 0,
        costCodeId: "cc1",
        costCodeActive: true,
        costCodeCode: "01-DEMO",
        costCodeName: "Demolition",
        estimateStatus: "Approved",
        estimateArchived: false,
        estimateId: "est1",
        estimateRecencyKey: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

test("empty input -> empty output", () => {
    assert.deepEqual(buildPhaseOptions([]), []);
});

test("only items on Approved estimates are included", () => {
    const items = [
        item({ estimateItemId: "a", costCodeId: "cc1", estimateStatus: "Approved" }),
        item({ estimateItemId: "b", costCodeId: "cc2", costCodeCode: "02-FRAME", estimateStatus: "Sent" }),
        item({ estimateItemId: "c", costCodeId: "cc3", costCodeCode: "03-ROOF", estimateStatus: "Invoiced" }),
    ];
    const result = buildPhaseOptions(items);
    assert.deepEqual(result.map((p) => p.costCodeId), ["cc1"]);
});

test("archived estimates are excluded even if status is Approved", () => {
    const items = [item({ estimateArchived: true })];
    assert.deepEqual(buildPhaseOptions(items), []);
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

// ── canonical estimate selection (multiple Approved estimates) ───────────

test("when multiple estimates are Approved, only items from the most recently approved estimate are used", () => {
    const items = [
        item({
            estimateItemId: "old-item",
            costCodeId: "cc1",
            estimateId: "est-old",
            estimateRecencyKey: "2026-01-01T00:00:00.000Z",
        }),
        item({
            estimateItemId: "new-item",
            costCodeId: "cc2",
            costCodeCode: "02-FRAME",
            estimateId: "est-new",
            estimateRecencyKey: "2026-06-01T00:00:00.000Z",
        }),
    ];
    const result = buildPhaseOptions(items);
    assert.deepEqual(result.map((p) => p.estimateItemId), ["new-item"]);
});

test("a non-eligible estimate (Sent, or archived) never becomes the canonical estimate even if more recent", () => {
    const items = [
        item({
            estimateItemId: "approved-item",
            costCodeId: "cc1",
            estimateId: "est-approved",
            estimateStatus: "Approved",
            estimateRecencyKey: "2026-01-01T00:00:00.000Z",
        }),
        item({
            estimateItemId: "sent-item",
            costCodeId: "cc2",
            costCodeCode: "02-FRAME",
            estimateId: "est-sent",
            estimateStatus: "Sent",
            estimateRecencyKey: "2026-06-01T00:00:00.000Z",
        }),
    ];
    const result = buildPhaseOptions(items);
    assert.deepEqual(result.map((p) => p.estimateItemId), ["approved-item"]);
});

test("ties on estimate recency break deterministically on the lower estimateId", () => {
    const items = [
        item({ estimateItemId: "from-b", costCodeId: "cc1", estimateId: "est-b", estimateRecencyKey: "2026-01-01T00:00:00.000Z" }),
        item({ estimateItemId: "from-a", costCodeId: "cc1", estimateId: "est-a", estimateRecencyKey: "2026-01-01T00:00:00.000Z" }),
    ];
    const result = buildPhaseOptions(items);
    assert.equal(result.length, 1);
    assert.equal(result[0].estimateItemId, "from-a");
});
