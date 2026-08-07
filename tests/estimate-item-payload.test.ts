import { test } from "node:test";
import assert from "node:assert/strict";

import {
    computeEstimateItemTotals,
    computeEstimateSubtotal,
    isEstimateSectionRow,
    normalizeSectionTypes,
    rm,
    serializeEstimateItemsForSave,
} from "../src/lib/estimate-item-payload";

type Row = {
    id: string;
    parentId?: string | null;
    type?: string | null;
    quantity?: unknown;
    unitCost?: unknown;
};

const leaf = (id: string, parentId: string | null, quantity: unknown, unitCost: unknown, type = "Material"): Row =>
    ({ id, parentId, type, quantity, unitCost });

const section = (id: string, parentId: string | null = null, unitCost: unknown = 0): Row =>
    ({ id, parentId, type: "Section", quantity: 1, unitCost });

// --- baseline: the behaviour that already worked ---------------------------------

test("leaf rows bill quantity * unitCost, rounded to cents", () => {
    const items = [leaf("a", null, "3", "19.999"), leaf("b", null, 2, 10)];
    const totals = computeEstimateItemTotals(items);

    assert.deepEqual(totals, [
        { isSection: false, total: 60 },
        { isSection: false, total: 20 },
    ]);
    assert.equal(computeEstimateSubtotal(items), 80);
});

test("a section rolls up its children and is excluded from the subtotal", () => {
    const items = [section("s"), leaf("c1", "s", 2, 100), leaf("c2", "s", 1, 50)];

    assert.deepEqual(computeEstimateItemTotals(items), [
        { isSection: true, total: 250 },
        { isSection: false, total: 200 },
        { isSection: false, total: 50 },
    ]);
    // 250 counted once via its children, not twice
    assert.equal(computeEstimateSubtotal(items), 250);
});

test("an untyped legacy section is still detected via its children", () => {
    const items = [leaf("s", null, 1, 999, "Material"), leaf("c", "s", 2, 25)];
    const totals = computeEstimateItemTotals(items);

    assert.equal(totals[0].isSection, true);
    assert.equal(totals[0].total, 50, "the stale 999 unitCost must not survive the roll-up");
    assert.equal(computeEstimateSubtotal(items), 50);
});

// --- defect 1: nested sections ---------------------------------------------------

test("defect 1: a nested section aggregates its own children into its parent", () => {
    const items = [
        section("outer"),
        section("inner", "outer", 999), // stale mirrored unitCost from a previous save
        leaf("g1", "inner", 2, 100),
        leaf("g2", "inner", 1, 50),
        leaf("direct", "outer", 1, 25),
    ];
    const totals = computeEstimateItemTotals(items);

    assert.equal(totals[1].isSection, true, "a section with a parentId is still a section");
    assert.equal(totals[1].total, 250, "grandchildren aggregate into the nested section");
    assert.equal(totals[0].total, 275, "the nested section's roll-up flows up to the outer section");
    // Only the three leaves are billed: 200 + 50 + 25
    assert.equal(computeEstimateSubtotal(items), 275);
});

test("defect 1: three levels of nesting still roll up", () => {
    const items = [
        section("l1"),
        section("l2", "l1"),
        section("l3", "l2"),
        leaf("deep", "l3", 4, 12.5),
    ];
    const totals = computeEstimateItemTotals(items);

    assert.deepEqual(totals.map(t => t.total), [50, 50, 50, 50]);
    assert.equal(computeEstimateSubtotal(items), 50, "the leaf is billed once, not once per ancestor");
});

// --- defect 2: a section that lost its last child --------------------------------

test("defect 2: an emptied section stops charging the deleted children's total", () => {
    // The section previously held $250 of children, so unitCost was mirrored to 250.
    const items = [section("s", null, 250), leaf("survivor", null, 1, 40)];
    const totals = computeEstimateItemTotals(items);

    assert.equal(totals[0].isSection, true, "type === 'Section' keeps it a section with no children");
    assert.equal(totals[0].total, 0);
    assert.equal(computeEstimateSubtotal(items), 40, "the deleted $250 is not billed");
});

test("defect 2: serializing an emptied section zeroes its mirrored unitCost", () => {
    const items = [section("s", null, 250)];
    const [serialized] = serializeEstimateItemsForSave(items);

    assert.equal(serialized.total, 0);
    assert.equal(serialized.unitCost, 0, "stale mirror must be cleared, not carried forward");
});

// --- defect 3: rounding the accumulated sum --------------------------------------

test("defect 3: accumulated child totals are cent-rounded", () => {
    const items = [section("s"), leaf("c1", "s", 1, 0.1), leaf("c2", "s", 1, 0.2)];
    const totals = computeEstimateItemTotals(items);

    assert.equal(totals[0].total, 0.3, "0.10 + 0.20 must not be 0.30000000000000004");
    assert.equal(computeEstimateSubtotal(items), 0.3);
});

test("defect 3: rounding holds across many children and through nesting", () => {
    const children = Array.from({ length: 10 }, (_v, i) => leaf(`c${i}`, "inner", 1, 0.1));
    const items = [section("outer"), section("inner", "outer"), ...children];
    const totals = computeEstimateItemTotals(items);

    assert.equal(totals[1].total, 1);
    assert.equal(totals[0].total, 1);
    assert.equal(computeEstimateSubtotal(items), 1);
});

// --- serialization contract ------------------------------------------------------

test("serializeEstimateItemsForSave assigns order and preserves unknown fields", () => {
    const items = [
        { ...section("s"), name: "Framing", costCodeId: "cc1" },
        { ...leaf("c", "s", 2, 30), name: "Studs", costCodeId: "cc2" },
    ];
    const serialized = serializeEstimateItemsForSave(items);

    assert.deepEqual(serialized.map(i => i.order), [0, 1]);
    assert.equal(serialized[0].name, "Framing");
    assert.equal(serialized[0].costCodeId, "cc1");
    assert.equal(serialized[0].total, 60);
    assert.equal(serialized[0].unitCost, 60, "section unitCost mirrors the rolled-up total");
    assert.equal(serialized[1].total, 60);
    assert.equal(serialized[1].unitCost, 30, "leaf unitCost is left untouched");
});

test("serializeEstimateItemsForSave does not mutate its input", () => {
    const items = [section("s", null, 250)];
    serializeEstimateItemsForSave(items);

    assert.equal(items[0].unitCost, 250);
});

// --- defensive: bad data ---------------------------------------------------------

test("non-numeric quantities and unit costs degrade to zero", () => {
    const items = [leaf("a", null, "", ""), leaf("b", null, "abc", "12"), leaf("c", null, null, undefined)];

    assert.deepEqual(computeEstimateItemTotals(items).map(t => t.total), [0, 0, 0]);
    assert.equal(computeEstimateSubtotal(items), 0);
});

test("a parentId cycle terminates instead of recursing forever", () => {
    const items = [
        { id: "a", parentId: "b", type: "Section", quantity: 1, unitCost: 5 },
        { id: "b", parentId: "a", type: "Section", quantity: 1, unitCost: 5 },
    ];

    const totals = computeEstimateItemTotals(items);
    assert.deepEqual(totals.map(t => t.total), [0, 0]);
    assert.equal(computeEstimateSubtotal(items), 0);
});

test("cycle handling does not depend on row order", () => {
    // A leaf hangs off a two-node cycle. Whichever end of the cycle we walk from, the whole
    // unrooted component must total 0 — an order-dependent result would mean the same saved
    // estimate could total differently after a drag-reorder.
    const build = (order: string[]) => {
        const byId: Record<string, Row> = {
            a: { id: "a", parentId: "b", type: "Section", quantity: 1, unitCost: 5 },
            b: { id: "b", parentId: "a", type: "Section", quantity: 1, unitCost: 5 },
            leaf: leaf("leaf", "a", 1, 10),
        };
        return order.map(id => byId[id]);
    };

    const forward = computeEstimateItemTotals(build(["a", "b", "leaf"]));
    const swapped = computeEstimateItemTotals(build(["b", "a", "leaf"]));

    assert.deepEqual(forward.map(t => t.total), [0, 0, 0]);
    assert.deepEqual(swapped.map(t => t.total), [0, 0, 0]);
    assert.equal(computeEstimateSubtotal(build(["a", "b", "leaf"])), 0);
    assert.equal(computeEstimateSubtotal(build(["b", "a", "leaf"])), 0);
});

// --- legacy rows: the has-children-only transition -------------------------------

test("serializing normalizes a detected legacy section to type 'Section'", () => {
    const items = [leaf("s", null, 1, 999, "Material"), leaf("c", "s", 2, 25)];
    const serialized = serializeEstimateItemsForSave(items);

    assert.equal(serialized[0].type, "Section", "the tag must persist so the row survives losing its children");
    assert.equal(serialized[0].total, 50);
    assert.equal(serialized[0].unitCost, 50);
    assert.equal(serialized[1].type, "Material", "leaves keep their own type");
});

test("a normalized legacy section stops charging once its last child is deleted", () => {
    // Round 1: legacy row detected via children, normalized and mirrored to 50.
    const withChild = [leaf("s", null, 1, 999, "Material"), leaf("c", "s", 2, 25)];
    const saved = serializeEstimateItemsForSave(withChild);
    assert.equal(computeEstimateSubtotal(withChild), 50);

    // Round 2: the child is deleted. The row reloads carrying the tag round 1 persisted.
    const afterDelete = [saved[0]];
    assert.equal(isEstimateSectionRow(afterDelete[0], afterDelete), true);
    assert.equal(computeEstimateSubtotal(afterDelete), 0, "the deleted child's $50 is not billed");
    assert.equal(serializeEstimateItemsForSave(afterDelete)[0].unitCost, 0);
});

// --- the standalone predicate (used by the PDF against stored rows) --------------

test("isEstimateSectionRow agrees with computeEstimateItemTotals", () => {
    const items = [
        section("outer"),
        section("inner", "outer"),
        leaf("g", "inner", 1, 10),
        leaf("plain", null, 1, 10),
        leaf("legacy", null, 1, 0, "Material"),
        leaf("legacyChild", "legacy", 1, 10),
        section("emptied", null, 250),
    ];
    const totals = computeEstimateItemTotals(items);

    items.forEach((item, index) => {
        assert.equal(
            isEstimateSectionRow(item, items),
            totals[index].isSection,
            `predicate disagreed for ${item.id}`,
        );
    });
});

test("normalizeSectionTypes keeps a legacy section billable-safe within one session", () => {
    // Reproduces the same-session sequence without a reload: load legacy rows, save, then
    // delete the last child. Before normalization the in-memory row fell back to a leaf and
    // billed its mirrored unitCost again.
    const loaded = [leaf("s", null, 1, 999, "Material"), leaf("c", "s", 2, 25)];

    // Save mirrors the persisted tags back into editor state.
    const afterSave = normalizeSectionTypes(loaded);
    assert.equal(afterSave[0].type, "Section");
    assert.equal(afterSave[1].type, "Material");

    // The user now deletes the last child; state is NOT reloaded from the server.
    const afterDelete = afterSave.filter(row => row.id !== "c");
    assert.equal(computeEstimateSubtotal(afterDelete), 0, "the emptied legacy section must not bill 999");
    assert.equal(serializeEstimateItemsForSave(afterDelete)[0].unitCost, 0);
});

test("normalizeSectionTypes is idempotent and leaves non-sections alone", () => {
    const items = [leaf("s", null, 1, 999, "Material"), leaf("c", "s", 2, 25), leaf("plain", null, 1, 5)];
    const once = normalizeSectionTypes(items);
    const twice = normalizeSectionTypes(once);

    assert.deepEqual(twice, once);
    assert.equal(once[2].type, "Material");
    assert.equal(once[1], items[1], "untouched rows keep their identity");
});

test("the PDF's stored-total sum needs the same rounding pass as the subtotal", () => {
    // 375 leaves of $0.01: the raw float sum lands just under $3.75, which drags tax and the
    // grand total a cent below what the editor displayed.
    const items = Array.from({ length: 375 }, (_v, i) => leaf(`c${i}`, null, 1, 0.01));
    const stored = serializeEstimateItemsForSave(items);

    const rawSum = stored.reduce((acc, item) => acc + item.total, 0);
    assert.notEqual(rawSum, 3.75, "guard: this case is only interesting while the raw sum drifts");

    assert.equal(rm(rawSum), 3.75);
    assert.equal(computeEstimateSubtotal(items), 3.75, "editor and PDF must land on the same figure");
});

test("summing stored totals over non-section rows matches the subtotal (PDF path)", () => {
    // The PDF sums the persisted `total` column rather than recomputing from qty * unitCost.
    const items = [
        section("outer"),
        section("inner", "outer", 999),
        leaf("g1", "inner", 2, 100),
        leaf("g2", "inner", 1, 50),
        leaf("direct", "outer", 1, 25),
    ];
    const stored = serializeEstimateItemsForSave(items);

    const pdfSubtotal = stored.reduce(
        (acc, item) => (isEstimateSectionRow(item, stored) ? acc : acc + item.total),
        0,
    );

    assert.equal(pdfSubtotal, 275);
    assert.equal(pdfSubtotal, computeEstimateSubtotal(items), "PDF and editor must agree");
});

test("an orphaned child (parent row deleted) is still billed as a leaf", () => {
    const items = [leaf("orphan", "gone", 2, 15)];

    assert.deepEqual(computeEstimateItemTotals(items), [{ isSection: false, total: 30 }]);
    assert.equal(computeEstimateSubtotal(items), 30);
});

test("an empty estimate has a zero subtotal", () => {
    assert.deepEqual(computeEstimateItemTotals([]), []);
    assert.equal(computeEstimateSubtotal([]), 0);
});
