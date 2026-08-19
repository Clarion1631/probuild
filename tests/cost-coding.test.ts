/**
 * The job-costing gate (src/lib/cost-coding.ts) — salvaged from PR #117 and
 * rewritten DI-style so it runs with no database.
 *
 * What these tests protect: an uncoded time entry or expense must never reach
 * the job ledger. If it does, the variance report lies — the job looks cheaper
 * than it is and the estimate item it belonged to looks on-budget.
 *
 * Pure/DI style, matching tests/project-phases.test.ts and tests/phase-options.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    resolveCostCode,
    type CostCodingCostCode,
    type CostCodingDataSource,
    type CostCodingLineItem,
} from "../src/lib/cost-coding";

function createDataSource(options: {
    costCodes?: Record<string, CostCodingCostCode>;
    lineItems?: Record<string, CostCodingLineItem>;
}): CostCodingDataSource {
    return {
        async getCostCode(costCodeId) {
            return options.costCodes?.[costCodeId] ?? null;
        },
        async getLineItem(lineItemId) {
            return options.lineItems?.[lineItemId] ?? null;
        },
    };
}

const ACTIVE_CODE: CostCodingCostCode = { id: "cc-demo", isActive: true };
const INACTIVE_CODE: CostCodingCostCode = { id: "cc-old", isActive: false };

const CODED_ITEM: CostCodingLineItem = {
    costCodeId: "cc-demo",
    costTypeId: "ct-labor",
    costCodeIsActive: true,
};
const UNCODED_ITEM: CostCodingLineItem = {
    costCodeId: null,
    costTypeId: "ct-labor",
    costCodeIsActive: null,
};
const ITEM_WITH_INACTIVE_CODE: CostCodingLineItem = {
    costCodeId: "cc-old",
    costTypeId: "ct-labor",
    costCodeIsActive: false,
};

// ── precedence: an explicit cost code wins ──────────────────────────────────

test("an explicit active cost code resolves, and reports no cost type", async () => {
    const dataSource = createDataSource({ costCodes: { "cc-demo": ACTIVE_CODE } });
    const result = await resolveCostCode(dataSource, { costCodeId: "cc-demo" });
    assert.deepEqual(result, {
        ok: true,
        costCodeId: "cc-demo",
        // Only an estimate item knows Labor vs Material. Guessing here would
        // put invented numbers in a variance report.
        costTypeId: null,
        source: "explicit",
    });
});

test("an explicit cost code outranks the line item when both are supplied", async () => {
    const dataSource = createDataSource({
        costCodes: { "cc-demo": ACTIVE_CODE },
        lineItems: { "item-1": { costCodeId: "cc-other", costTypeId: "ct-material", costCodeIsActive: true } },
    });
    const result = await resolveCostCode(dataSource, { costCodeId: "cc-demo", lineItemId: "item-1" });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.costCodeId, "cc-demo");
    assert.equal(result.ok && result.source, "explicit");
});

// ── explicit cost code: rejections ──────────────────────────────────────────

test("a cost code that does not exist is rejected", async () => {
    const result = await resolveCostCode(createDataSource({}), { costCodeId: "ghost" });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "COST_CODE_NOT_FOUND");
    assert.equal(!result.ok && result.status, 400);
});

test("an INACTIVE cost code is rejected — retiring a code must stop new postings", async () => {
    const dataSource = createDataSource({ costCodes: { "cc-old": INACTIVE_CODE } });
    const result = await resolveCostCode(dataSource, { costCodeId: "cc-old" });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "COST_CODE_INACTIVE");
});

// ── derive from the line item (the 1–2 items/phase design) ──────────────────

test("a coded line item yields BOTH its cost code and its cost type", async () => {
    // This is the whole point: capture the finer grain once, get the phase free.
    const dataSource = createDataSource({ lineItems: { "item-1": CODED_ITEM } });
    const result = await resolveCostCode(dataSource, { lineItemId: "item-1" });
    assert.deepEqual(result, {
        ok: true,
        costCodeId: "cc-demo",
        costTypeId: "ct-labor",
        source: "line-item",
    });
});

test("a null costCodeId falls through to the line item rather than short-circuiting", async () => {
    const dataSource = createDataSource({ lineItems: { "item-1": CODED_ITEM } });
    const result = await resolveCostCode(dataSource, { costCodeId: null, lineItemId: "item-1" });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.source, "line-item");
});

test("an empty-string costCodeId is treated as absent, not as a lookup of ''", async () => {
    const dataSource = createDataSource({ lineItems: { "item-1": CODED_ITEM } });
    const result = await resolveCostCode(dataSource, { costCodeId: "", lineItemId: "item-1" });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.costCodeId, "cc-demo");
});

test("a line item with no cost code is rejected with an office-fixable message", async () => {
    // 34 of 163 eligible prod items were in this state (Hoppe 14, Mesplay 15).
    // The crew cannot fix this from a phone — the error has to say so.
    const dataSource = createDataSource({ lineItems: { "item-1": UNCODED_ITEM } });
    const result = await resolveCostCode(dataSource, { lineItemId: "item-1" });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "LINE_ITEM_NOT_CODED");
    assert.match(!result.ok ? result.error : "", /cost code on the estimate/i);
});

test("a line item whose cost code is inactive is rejected distinctly from an uncoded one", async () => {
    const dataSource = createDataSource({ lineItems: { "item-1": ITEM_WITH_INACTIVE_CODE } });
    const result = await resolveCostCode(dataSource, { lineItemId: "item-1" });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "LINE_ITEM_COST_CODE_INACTIVE");
});

test("a line item that does not exist is rejected", async () => {
    const result = await resolveCostCode(createDataSource({}), { lineItemId: "ghost" });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "LINE_ITEM_NOT_FOUND");
});

// ── the gate itself ─────────────────────────────────────────────────────────

test("supplying neither is rejected — this IS the gate", async () => {
    const result = await resolveCostCode(createDataSource({}), {});
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "COST_CODE_REQUIRED");
    assert.equal(!result.ok && result.status, 400);
});

test("nulls and undefined on both inputs are rejected, never silently coded", async () => {
    for (const input of [
        { costCodeId: null, lineItemId: null },
        { costCodeId: undefined, lineItemId: undefined },
        { costCodeId: "", lineItemId: "" },
    ]) {
        const result = await resolveCostCode(createDataSource({}), input);
        assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
        assert.equal(!result.ok && result.code, "COST_CODE_REQUIRED");
    }
});

test("EVERY rejection path returns status 400 and a non-empty message", async () => {
    // A gate that rejects with a blank reason is a dead end for whoever hits it.
    const dataSource = createDataSource({
        costCodes: { "cc-old": INACTIVE_CODE },
        lineItems: { uncoded: UNCODED_ITEM, inactive: ITEM_WITH_INACTIVE_CODE },
    });
    const inputs = [
        {},
        { costCodeId: "ghost" },
        { costCodeId: "cc-old" },
        { lineItemId: "ghost" },
        { lineItemId: "uncoded" },
        { lineItemId: "inactive" },
    ];
    for (const input of inputs) {
        const result = await resolveCostCode(dataSource, input);
        assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
        if (!result.ok) {
            assert.equal(result.status, 400);
            assert.ok(result.error.length > 0, `blank error for ${JSON.stringify(input)}`);
            assert.ok(result.code.length > 0, `blank code for ${JSON.stringify(input)}`);
        }
    }
});

test("resolution never invents a cost code that the data source did not return", async () => {
    const dataSource = createDataSource({
        costCodes: { "cc-demo": ACTIVE_CODE },
        lineItems: { "item-1": CODED_ITEM },
    });
    for (const input of [{ costCodeId: "cc-demo" }, { lineItemId: "item-1" }]) {
        const result = await resolveCostCode(dataSource, input);
        assert.equal(result.ok && result.costCodeId, "cc-demo");
    }
});
