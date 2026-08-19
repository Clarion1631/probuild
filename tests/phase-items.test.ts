/**
 * The optional item step (src/lib/phase-items.ts).
 *
 * This is the ADOPTION rule in code: after a phase tap, the crew is asked for a
 * line item ONLY when the answer is genuinely ambiguous. Measured on prod,
 * 51.9% of phases hold exactly one item, so most clock-ins must cost zero extra
 * taps. If that guarantee breaks, the crew stops using the app and every
 * downstream number goes stale.
 *
 * Pure/DI style — no database, matching tests/project-phases.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    decidePhaseItemStep,
    resolvePhaseItems,
    sortPhaseItems,
    type PhaseItemOption,
    type PhaseItemsDataSource,
} from "../src/lib/phase-items";

const opt = (over: Partial<PhaseItemOption> & { estimateItemId: string }): PhaseItemOption => ({
    name: over.name ?? over.estimateItemId,
    order: over.order ?? 0,
    total: over.total ?? 0,
    ...over,
});

function createDataSource(itemsByCode: Record<string, PhaseItemOption[]>): PhaseItemsDataSource {
    return {
        async getItemsForPhase(_projectId, costCodeId) {
            return itemsByCode[costCodeId] ?? [];
        },
    };
}

// ── the zero-extra-taps guarantee ───────────────────────────────────────────

test("EXACTLY ONE item auto-attaches — the crew is never asked (51.9% of prod phases)", () => {
    const decision = decidePhaseItemStep([opt({ estimateItemId: "i1", name: "Demo bathroom" })]);
    assert.equal(decision.kind, "auto");
    assert.equal(decision.kind === "auto" && decision.item.estimateItemId, "i1");
});

test("TWO OR MORE items ask, and offer only those items", () => {
    const decision = decidePhaseItemStep([
        opt({ estimateItemId: "i1", name: "Vanity", order: 2 }),
        opt({ estimateItemId: "i2", name: "Cabinets", order: 1 }),
    ]);
    assert.equal(decision.kind, "choose");
    assert.deepEqual(
        decision.kind === "choose" ? decision.items.map((i) => i.estimateItemId) : [],
        ["i2", "i1"],
        "offered in estimate order, so the list reads like the bid"
    );
});

test("NO items is a valid answer and must never block a punch", () => {
    // The Safety phase is deliberately not an estimate line. A crew member must
    // still be able to clock into it.
    assert.deepEqual(decidePhaseItemStep([]), { kind: "none" });
});

// ── deterministic ordering ──────────────────────────────────────────────────

test("items sort by estimate order, then id — never reshuffling between renders", () => {
    const sorted = sortPhaseItems([
        opt({ estimateItemId: "zzz", order: 5 }),
        opt({ estimateItemId: "aaa", order: 5 }),
        opt({ estimateItemId: "mid", order: 1 }),
    ]);
    assert.deepEqual(sorted.map((i) => i.estimateItemId), ["mid", "aaa", "zzz"]);
});

test("sorting does not mutate the caller's array", () => {
    const input = [opt({ estimateItemId: "b", order: 2 }), opt({ estimateItemId: "a", order: 1 })];
    const before = input.map((i) => i.estimateItemId);
    sortPhaseItems(input);
    assert.deepEqual(input.map((i) => i.estimateItemId), before);
});

test("a single item is still returned through the auto path regardless of its order value", () => {
    const decision = decidePhaseItemStep([opt({ estimateItemId: "solo", order: 99 })]);
    assert.equal(decision.kind, "auto");
});

// ── resolution through the data source ──────────────────────────────────────

test("resolvePhaseItems returns only the requested phase's items, ordered", async () => {
    const dataSource = createDataSource({
        "cc-demo": [
            opt({ estimateItemId: "d2", name: "Haul away", order: 2 }),
            opt({ estimateItemId: "d1", name: "Strip tile", order: 1 }),
        ],
        "cc-frame": [opt({ estimateItemId: "f1", name: "Wall framing" })],
    });
    const items = await resolvePhaseItems(dataSource, "p1", "cc-demo");
    assert.deepEqual(items.map((i) => i.estimateItemId), ["d1", "d2"]);
});

test("an unknown phase resolves to an empty list, not an error", async () => {
    const items = await resolvePhaseItems(createDataSource({}), "p1", "cc-nope");
    assert.deepEqual(items, []);
    assert.deepEqual(decidePhaseItemStep(items), { kind: "none" });
});

test("the decision for a real 5-item phase (the prod worst case) is still a short choose", async () => {
    // Max observed on prod is 5 items in one phase. Even the worst case must be
    // a short list, never a scroll.
    const dataSource = createDataSource({
        "cc-big": Array.from({ length: 5 }, (_, index) =>
            opt({ estimateItemId: `i${index}`, name: `Item ${index}`, order: index })
        ),
    });
    const decision = decidePhaseItemStep(await resolvePhaseItems(dataSource, "p1", "cc-big"));
    assert.equal(decision.kind, "choose");
    assert.equal(decision.kind === "choose" && decision.items.length, 5);
});

test("item totals survive resolution so the crew sees the line's value as context", async () => {
    const dataSource = createDataSource({
        "cc-demo": [opt({ estimateItemId: "i1", name: "Strip tile", total: 1250.5 })],
    });
    const [item] = await resolvePhaseItems(dataSource, "p1", "cc-demo");
    assert.equal(item.total, 1250.5);
    assert.equal(item.name, "Strip tile");
});
