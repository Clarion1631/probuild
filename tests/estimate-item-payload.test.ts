import { test } from "node:test";
import assert from "node:assert/strict";

import {
    computeEstimateItemTotals,
    computeEstimateSubtotal,
    isEstimateSectionRow,
    normalizeSectionTypes,
    rm,
    serializeEstimateItemsForSave,
    ESTIMATE_ITEM_SAVE_FIELDS,
    normalizeEstimateItemForSave,
    selectedBillableRows,
} from "../src/lib/estimate-item-payload";
import { buildQBEstimateLines } from "../src/lib/quickbooks";
import { billableCoItems, classifyCoTotal, coItemsSubtotal, coSectionRowNames } from "../src/lib/co-tax";

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

// --- QuickBooks estimate sync ----------------------------------------------------
// These exercise the real `buildQBEstimateLines` used by syncEstimateToQB, not a
// re-implementation of it — deleting the filter must turn these red.

const qbRows = (items: readonly Row[]) =>
    serializeEstimateItemsForSave(items).map(item => ({
        ...item,
        name: String(item.id),
        parentId: item.parentId ?? null,
        quantity: Number(item.quantity ?? 0),
        unitCost: Number(item.unitCost ?? 0),
        type: String(item.type ?? ""),
    }));

test("QB estimate lines exclude section rows and sum to the pre-tax subtotal", () => {
    const items = [
        section("outer"),
        section("inner", "outer", 999),
        leaf("g1", "inner", 2, 100),
        leaf("g2", "inner", 1, 50),
        leaf("direct", "outer", 1, 25),
    ];
    const stored = qbRows(items);

    // What the pre-fix payload shipped: every row, including both section levels.
    assert.equal(stored.reduce((acc, item) => acc + item.total, 0), 800);

    const lines = buildQBEstimateLines(stored, "svc-1");

    assert.deepEqual(lines.map(l => l.Description), ["g1", "g2", "direct"]);
    assert.equal(
        rm(lines.reduce((acc, l) => acc + l.Amount, 0)),
        computeEstimateSubtotal(items),
        "QB line amounts must sum to the estimate subtotal",
    );
    assert.equal(rm(lines.reduce((acc, l) => acc + l.Amount, 0)), 275);
});

test("QB line numbers stay contiguous after sections are filtered out", () => {
    const stored = qbRows([
        section("s"),
        leaf("a", "s", 1, 10),
        leaf("b", "s", 1, 20),
        leaf("c", null, 1, 30),
    ]);

    assert.deepEqual(buildQBEstimateLines(stored, "svc-1").map(l => l.LineNum), [1, 2, 3]);
});

test("QB lines keep Qty/UnitPrice from the leaf row", () => {
    const stored = qbRows([leaf("a", null, 3, 19.999)]);
    const [line] = buildQBEstimateLines(stored, "svc-1");

    assert.equal(line.Amount, 60);
    assert.equal(line.SalesItemLineDetail.Qty, 3);
    assert.equal(line.SalesItemLineDetail.ItemRef.value, "svc-1");
});

test("an estimate of nothing but sections produces zero QB lines", () => {
    // syncEstimateToQB turns this into a legible error rather than a QBO 2020.
    const stored = qbRows([section("outer"), section("inner", "outer")]);

    assert.equal(buildQBEstimateLines(stored, "svc-1").length, 0);
    assert.equal(buildQBEstimateLines([], "svc-1").length, 0);
});

test("orphaned and legacy rows still bill as QB lines", () => {
    // An orphan (parent deleted) is a leaf; an untyped row WITH children is a section.
    const stored = qbRows([leaf("orphan", "gone", 2, 15), leaf("legacy", null, 1, 999, "Material"), leaf("kid", "legacy", 2, 25)]);
    const lines = buildQBEstimateLines(stored, "svc-1");

    assert.deepEqual(lines.map(l => l.Description), ["orphan", "kid"]);
    assert.equal(rm(lines.reduce((acc, l) => acc + l.Amount, 0)), 80);
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


// --- the persisted-field projection ----------------------------------------------
// Regression cover for the change-detection drift: the editor's snapshot used to
// hand-roll a shorter field list than saveEstimate writes, so an edit touching only
// the omitted fields produced an identical snapshot and the save silently no-opped.

import { readFileSync } from "node:fs";
import path from "node:path";

const persistable = {
    id: "item-1", name: "Cabinets", description: "Uppers", type: "Material",
    quantity: 2, baseCost: 100, markupPercent: 25, unitCost: 125, total: 250,
    parentId: null, costCodeId: null, costTypeId: null,
    budgetQuantity: null, budgetUnit: null, budgetRate: null,
};

test("the projection emits exactly the fields saveEstimate persists", () => {
    assert.deepEqual(
        Object.keys(normalizeEstimateItemForSave(persistable, 0)).sort(),
        [...ESTIMATE_ITEM_SAVE_FIELDS].sort(),
    );
});

test("every budget field is visible to the change check", () => {
    const before = JSON.stringify(serializeEstimateItemsForSave([persistable]).map((i, n) => normalizeEstimateItemForSave(i, n)));
    for (const edit of [
        { budgetQuantity: 3 }, { budgetUnit: "sf" }, { budgetRate: 42 },
        { baseCost: 90 }, { markupPercent: 40 },
    ]) {
        const after = JSON.stringify(serializeEstimateItemsForSave([{ ...persistable, ...edit }]).map((i, n) => normalizeEstimateItemForSave(i, n)));
        assert.notEqual(after, before, `editing ${Object.keys(edit)[0]} must be visible to the change check`);
    }
});

test("an explicit zero survives; only an unset value falls back", () => {
    // A zero margin is real (derivedMarginPct clamps to 0) and a zero budget is real.
    // For budgetQuantity, null does not mean zero - it means "use the sell quantity".
    for (const zero of [0, "0", "0.00"]) {
        const row = normalizeEstimateItemForSave({ ...persistable, markupPercent: zero, budgetQuantity: zero, budgetRate: zero }, 0);
        assert.equal(row.markupPercent, 0, `markupPercent ${JSON.stringify(zero)}`);
        assert.equal(row.budgetQuantity, 0, `budgetQuantity ${JSON.stringify(zero)}`);
        assert.equal(row.budgetRate, 0, `budgetRate ${JSON.stringify(zero)}`);
    }
    for (const unset of [null, undefined, "", "  ", "abc", NaN, Infinity]) {
        const row = normalizeEstimateItemForSave({ ...persistable, markupPercent: unset, budgetQuantity: unset, budgetRate: unset }, 0);
        assert.equal(row.markupPercent, 25, `markupPercent ${String(unset)}`);
        assert.equal(row.budgetQuantity, null, `budgetQuantity ${String(unset)}`);
        assert.equal(row.budgetRate, null, `budgetRate ${String(unset)}`);
    }
});

test("string and numeric spellings of the same value compare equal", () => {
    assert.equal(
        JSON.stringify(normalizeEstimateItemForSave({ ...persistable, quantity: "2", unitCost: "125", baseCost: "100" }, 0)),
        JSON.stringify(normalizeEstimateItemForSave(persistable, 0)),
    );
});

test("PO links are not part of the save projection", () => {
    // They live in EstimateItemPurchaseOrder, maintained solely by syncLegacyPoLink;
    // writing the legacy scalar from here would fight that.
    assert.ok(!("purchaseOrderId" in normalizeEstimateItemForSave({ ...persistable, purchaseOrderId: "po-1" }, 0)));
});

test("saveEstimate and the editor both go through the shared projection", () => {
    // Guards the drift this module exists to prevent. saveEstimate's item-upsert loop lives in
    // src/lib/estimate-item-upsert.ts (upsertEstimateItems), not inline in actions.ts — but it
    // must still call the shared projection rather than carrying its own copy of the field list.
    const root = path.join(__dirname, "..");
    const upsert = readFileSync(path.join(root, "src/lib/estimate-item-upsert.ts"), "utf8");
    assert.match(upsert, /normalizeEstimateItemForSave\(item, idx\)/);
    const editor = readFileSync(path.join(root, "src/app/projects/[id]/estimates/[estimateId]/EstimateEditor.tsx"), "utf8");
    assert.match(editor, /normalizeEstimateItemForSave\(item, index\)/);
    // and updateItem must stay on the functional setState form
    const body = editor.slice(editor.indexOf("function updateItem(itemId: string"));
    const fn = body.slice(0, body.indexOf("\n    }") + 6);
    assert.match(fn, /setItems\(prev =>/);
    assert.doesNotMatch(fn, /\[\.\.\.items\]/);
});

// ─── Change-order section double-count (Codex review, 2026-08-07) ─────────────
// ChangeOrderItem is flat — no parentId — so a section header copied into a CO keeps
// type "Section" and its children's rolled-up unitCost. Billing both double-counts it.

test("selectedBillableRows expands a selected section to its leaves", () => {
    const rows: Row[] = [
        { id: "sec", type: "Section", quantity: 1, unitCost: 1000 },
        { id: "a", parentId: "sec", quantity: 1, unitCost: 300 },
        { id: "b", parentId: "sec", quantity: 1, unitCost: 700 },
    ];
    const picked = selectedBillableRows(rows, ["sec", "a", "b"]);
    assert.deepEqual(picked.map(r => r.id), ["a", "b"]);
    // The header's mirrored 1000 is gone; the CO bills 300 + 700 once.
    assert.equal(picked.reduce((s, r) => s + Number(r.unitCost), 0), 1000);
});

test("selectedBillableRows takes the whole phase when only the header is ticked", () => {
    const rows: Row[] = [
        { id: "sec", type: "Section", quantity: 1, unitCost: 1000 },
        { id: "a", parentId: "sec", quantity: 1, unitCost: 300 },
        { id: "b", parentId: "sec", quantity: 1, unitCost: 700 },
        { id: "loose", quantity: 1, unitCost: 50 },
    ];
    assert.deepEqual(selectedBillableRows(rows, ["sec"]).map(r => r.id), ["a", "b"]);
});

test("selectedBillableRows recurses through nested sections and dedupes", () => {
    const rows: Row[] = [
        { id: "outer", type: "Section", quantity: 1, unitCost: 900 },
        { id: "inner", parentId: "outer", type: "Section", quantity: 1, unitCost: 900 },
        { id: "leaf", parentId: "inner", quantity: 3, unitCost: 300 },
    ];
    assert.deepEqual(selectedBillableRows(rows, ["outer", "inner", "leaf"]).map(r => r.id), ["leaf"]);
});

test("selectedBillableRows drops a legacy section detected only by its children", () => {
    const rows: Row[] = [
        { id: "sec", quantity: 1, unitCost: 400 },
        { id: "a", parentId: "sec", quantity: 1, unitCost: 400 },
    ];
    assert.deepEqual(selectedBillableRows(rows, ["sec", "a"]).map(r => r.id), ["a"]);
});

test("selectedBillableRows drops an emptied section and preserves document order", () => {
    const rows: Row[] = [
        { id: "first", quantity: 1, unitCost: 10 },
        { id: "empty", type: "Section", quantity: 1, unitCost: 999 },
        { id: "last", quantity: 1, unitCost: 20 },
    ];
    assert.deepEqual(selectedBillableRows(rows, ["last", "empty", "first"]).map(r => r.id), ["first", "last"]);
});

test("selectedBillableRows skips a cyclic component instead of billing it", () => {
    const rows: Row[] = [
        { id: "x", parentId: "y", type: "Section", quantity: 1, unitCost: 10 },
        { id: "y", parentId: "x", type: "Section", quantity: 1, unitCost: 10 },
        { id: "leaf", parentId: "x", quantity: 1, unitCost: 25 },
    ];
    // computeEstimateItemTotals values every row in an unrooted component at 0, so billing
    // the leaf would charge $25 for work the estimate it came from prices at nothing.
    assert.deepEqual(computeEstimateItemTotals(rows).map(t => t.total), [0, 0, 0]);
    assert.deepEqual(selectedBillableRows(rows, ["x"]).map(r => r.id), []);
    assert.deepEqual(selectedBillableRows(rows, ["leaf"]).map(r => r.id), []);
});

test("billableCoItems drops section rows without guessing at their meaning", () => {
    const mixed = [
        { type: "Section", quantity: 1, unitCost: 1000 },
        { type: "Material", quantity: 1, unitCost: 300 },
        { type: "Labor", quantity: 1, unitCost: 700 },
    ];
    assert.equal(coItemsSubtotal(mixed), 1000);

    // No fallback for an all-headers CO. Flat rows cannot tell a header that duplicates the
    // lines beside it from a standalone charge, and neither reading can be assumed: two
    // nested headers would double-count, a standalone one would vanish. Nothing can create
    // such a row (editor and MCP both reject type "Section"), so the money paths refuse the
    // change order outright rather than render a number from it.
    const headersOnly = [
        { type: "Section", name: "Phase 1", quantity: 1, unitCost: 1000 },
        { type: "Section", name: "Phase 2", quantity: 1, unitCost: 2000 },
    ];
    assert.equal(billableCoItems(headersOnly).length, 0);
    assert.deepEqual(coSectionRowNames(headersOnly), ["Phase 1", "Phase 2"]);
    assert.deepEqual(coSectionRowNames(mixed), ["(unnamed)"]);
    assert.deepEqual(coSectionRowNames([{ type: "Material", name: "Tile" }]), []);
});

test("every money path refuses a change order carrying section headers", () => {
    const root = path.join(__dirname, "..");
    const guarded = {
        "src/lib/change-order-core.ts": 2,   // write + approve
        "src/lib/billing-core.ts": 2,        // send + bill
    };
    for (const [file, expected] of Object.entries(guarded)) {
        const source = readFileSync(path.join(root, file), "utf8");
        assert.equal(
            source.split("coSectionRowNames(").length - 1, expected,
            `${file} should guard ${expected} money paths against section rows`,
        );
    }
});

test("a blank type falls back to the stored one rather than erasing it", () => {
    // `type: ""` against a stored Section must not resolve to "no type": that would hide the
    // header from the write guard AND leave Section in the database, so the stored total
    // would count a row the send/approve guards then exclude — permanently out of sync.
    const core = readFileSync(path.join(__dirname, "..", "src/lib/change-order-core.ts"), "utf8");
    assert.match(core, /const requestedType = typeof item\.type === "string" \? item\.type\.trim\(\) : undefined;/);
    assert.match(core, /const effectiveType = requestedType \|\| prior\?\.type \|\| undefined;/);
});

test("the connector refuses a Section cost type instead of coercing it to Material", () => {
    // Coercion would smuggle a rolled-up header past every `type === "Section"` guard,
    // disguised as a billable line nothing downstream could identify.
    const billing = readFileSync(path.join(__dirname, "..", "src/lib/billing-core.ts"), "utf8");
    assert.match(billing, /costType\?\.trim\(\)\.toLowerCase\(\) === "section"/);
    assert.match(billing, /Cost type "Section" is not a change-order line/);
});

test("the audit reports section rows and refuses to recompute past them", () => {
    // Recomputing would write back a subtotal excluding the headers while leaving the rows
    // in place, so a later GET reads "ok" while send and approve stay correctly blocked.
    const audit = readFileSync(path.join(__dirname, "..", "src/app/api/integrations/co-audit/route.ts"), "utf8");
    assert.match(audit, /if \(verdict === "has-sections"\)[\s\S]{0,120}?coSectionRowError\(co\.code, sectionNames\)/);
    // The section verdict must be decided before the empty and equality branches.
    assert.equal(classifyCoTotal(100, 100, 108.8, 3, 1), "has-sections");
    assert.equal(classifyCoTotal(100, 100, 108.8, 0, 1), "has-sections");
});

test("the audit's ok verdict is cents-exact, matching the send and approve guards", () => {
    // Both guards compare `storedSubtotalCents !== renderedSubtotalCents` with no tolerance.
    // While the audit tolerated a cent, a one-cent row was reported "ok", refused by the
    // repair POST as already-correct, and hard-blocked from send and approve forever.
    assert.equal(classifyCoTotal(1000, 1000, 1088, 4, 0), "ok");
    assert.equal(classifyCoTotal(1000.01, 1000, 1088, 4, 0), "drift");
    assert.equal(classifyCoTotal(999.99, 1000, 1088, 4, 0), "drift");
    // Float dust must not decide the verdict: 0.1 + 0.2 stored against a 0.30 subtotal.
    assert.equal(classifyCoTotal(0.1 + 0.2, 0.3, 0.33, 2, 0), "ok");
});

test("the audit still diagnoses the tax-inclusive totals it exists to repair", () => {
    // The legacy editor wrote subtotal * (1 + rate) in one multiply, which lands at most one
    // cent above the guards' round(subtotal) + round(subtotal * rate). One cent of slack, and
    // only upward — the single multiply is never the smaller of the two.
    assert.equal(classifyCoTotal(1088, 1000, 1088, 4, 0), "tax-inflated");
    assert.equal(classifyCoTotal(1088.01, 1000, 1088, 4, 0), "tax-inflated");
    assert.equal(classifyCoTotal(1088.02, 1000, 1088, 4, 0), "drift");
});

test("the tax-inflated slack cannot swallow a value below the subtotal", () => {
    // A near-zero rate puts expectedBilled a cent above the subtotal, so a symmetric window
    // would have let $999.99 — which no tax-inclusive formula can produce — auto-repair
    // without the confirmation a drift row requires.
    assert.equal(classifyCoTotal(999.99, 1000, 1000.01, 4, 0), "drift");
    assert.equal(classifyCoTotal(1000.01, 1000, 1000.01, 4, 0), "tax-inflated");
    // Nor a cent BELOW expectedBilled: the single multiply is never the smaller of the two,
    // so $1087.99 against a $1088.00 expectation is not the legacy bug and needs force.
    assert.equal(classifyCoTotal(1087.99, 1000, 1088, 4, 0), "drift");
});

test("a stray cent on a tax-exempt CO is drift, not a mislabelled tax inflation", () => {
    // With no tax, expectedBilled *is* the subtotal, so the tax-inflated slack would otherwise
    // swallow every rounding drift and auto-repair it without the human confirmation drift needs.
    assert.equal(classifyCoTotal(1000.01, 1000, 1000, 4, 0), "drift");
    assert.equal(classifyCoTotal(1000, 1000, 1000, 4, 0), "ok");
});

test("an item-less CO is never classified from an empty subtotal", () => {
    assert.equal(classifyCoTotal(1000, 0, 0, 0, 0), "no-items");
});

test("a cost-plus CO is reported, never scored against its item subtotal", () => {
    // Both guards skip the subtotal comparison for COST_PLUS, so its total legitimately
    // differs from the items. Resetting it to the subtotal would destroy a real number.
    assert.equal(classifyCoTotal(5000, 1000, 1088, 4, 0, "COST_PLUS"), "cost-plus");
    assert.equal(classifyCoTotal(5000, 0, 0, 0, 0, "COST_PLUS"), "cost-plus");
    assert.equal(classifyCoTotal(5000, 1000, 1088, 4, 0, "FIXED"), "drift");
    // Corrupt section rows still outrank it — every money path refuses those first.
    assert.equal(classifyCoTotal(5000, 1000, 1088, 4, 1, "COST_PLUS"), "has-sections");
});

test("a nonpositive total is unpriced, not ok — the guards reject it either way", () => {
    // storedCents <= 0 || renderedCents <= 0 is its own rejection in both guards, so equality
    // at zero is an "ok" that still cannot send, and writing the subtotal back fixes nothing.
    assert.equal(classifyCoTotal(0, 0, 0, 3, 0), "unpriced");
    assert.equal(classifyCoTotal(-50, -50, -50, 3, 0), "unpriced");
    assert.equal(classifyCoTotal(1000, 0, 0, 3, 0), "unpriced");
});

test("an omitted type keeps the stored one, so the persisted total stays reproducible", () => {
    // The MCP omits `type` whenever costType is omitted. updateChangeOrderCore must read the
    // prior type before totalling, or the stored subtotal disagrees forever with the one the
    // send and approval guards recompute after reload.
    const core = readFileSync(path.join(__dirname, "..", "src/lib/change-order-core.ts"), "utf8");
    assert.match(core, /const effectiveType = requestedType \|\| prior\?\.type \|\| undefined;/);
    assert.match(core, /\.\.\.\(effectiveType \? \{ type: effectiveType \} : \{\}\)/);
});

test("createChangeOrder normalizes its selection through the shared helper", () => {
    const actions = readFileSync(path.join(__dirname, "..", "src/lib/actions.ts"), "utf8");
    const body = actions.slice(actions.indexOf("export async function createChangeOrder("));
    assert.match(body.slice(0, body.indexOf("\n}")), /selectedBillableRows\(estimate\.items, itemIds\)/);
});
