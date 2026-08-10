import { test } from "node:test";
import assert from "node:assert/strict";

import {
    EstimateStaleSaveError,
    assertEstimateItemParentsInScope,
    upsertEstimateItems,
    type EstimateItemTxClient,
    type ExistingEstimateItem,
} from "../src/lib/estimate-item-upsert";
import { ESTIMATE_ITEM_SAVE_FIELDS } from "../src/lib/estimate-item-payload";

/**
 * A hand-written fake `tx` that records every call, without standing up a database. The
 * optimistic-concurrency guard itself is exercised separately (against a real Postgres) in
 * e2e/estimate-items-revision.spec.ts — this file only covers the create-vs-update routing and
 * field-shaping this module still owns.
 */
function makeFakeTx() {
    const calls: { method: string; args: any }[] = [];
    let nextCreateId = 0;

    const tx: EstimateItemTxClient = {
        estimateItem: {
            update: async (args: any) => {
                calls.push({ method: "update", args });
                return { id: args.where.id, ...args.data };
            },
            create: async (args: any) => {
                calls.push({ method: "create", args });
                const id = args.data.id ?? `generated-${nextCreateId++}`;
                return { id, ...args.data };
            },
        },
    };

    return { tx, calls };
}

const existing = (over: Partial<ExistingEstimateItem> & { id: string }): ExistingEstimateItem => ({
    name: "Item",
    ...over,
});

test("existing row (id present in existingItemsMap) routes to update, without the id in data", async () => {
    const { tx, calls } = makeFakeTx();
    const existingItemsMap = new Map([["a", existing({ id: "a", name: "Tile" })]]);

    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [{ id: "a", name: "Tile", quantity: 2, unitCost: 10 }],
        existingItemsMap,
    });

    const updateCalls = calls.filter(c => c.method === "update");
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].args.where.id, "a");
    // update's data must not carry the primary key.
    assert.equal("id" in updateCalls[0].args.data, false);
    assert.equal(calls.some(c => c.method === "create"), false);
});

test("new row (no id, or an id not in existingItemsMap) routes to create, id-specifying", async () => {
    const { tx, calls } = makeFakeTx();
    const existingItemsMap = new Map<string, ExistingEstimateItem>();

    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [{ id: "new-1", name: "New Item", quantity: 1, unitCost: 5 }],
        existingItemsMap,
    });

    const createCalls = calls.filter(c => c.method === "create");
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].args.data.id, "new-1", "create stays id-specifying (undo-of-delete depends on it)");
    assert.equal(calls.some(c => c.method === "update"), false);
});

test("an id present in the payload but absent from existingItemsMap is treated as a create", async () => {
    const { tx, calls } = makeFakeTx();
    // "a" is not in existingItemsMap, even though the payload supplies an id for it — e.g. a
    // row created client-side this session, never yet persisted.
    const existingItemsMap = new Map<string, ExistingEstimateItem>();

    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [{ id: "a", name: "Tile", quantity: 1, unitCost: 1 }],
        existingItemsMap,
    });

    assert.equal(calls.filter(c => c.method === "create").length, 1);
    assert.equal(calls.filter(c => c.method === "update").length, 0);
});

test("parents are upserted before children (order matters for the parentId FK)", async () => {
    const { tx, calls } = makeFakeTx();
    const existingItemsMap = new Map([
        ["parent", existing({ id: "parent", name: "Section" })],
        ["child", existing({ id: "child", name: "Sub-item" })],
    ]);

    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [
            { id: "child", parentId: "parent", name: "Sub-item", quantity: 1, unitCost: 1 },
            { id: "parent", name: "Section", quantity: 1, unitCost: 1, type: "Section" },
        ],
        existingItemsMap,
    });

    const updateOrder = calls.filter(c => c.method === "update").map(c => c.args.where.id);
    assert.deepEqual(updateOrder, ["parent", "child"]);
});

test("three new levels are written ancestors-first even when the payload is deepest-first", async () => {
    // The old roots-then-everything-else split only guaranteed ONE level: with this payload it
    // created the grandparent, then tried to create the grandchild before its parent existed and
    // the parentId FK rejected it. Depth grouping holds at any nesting level.
    const { tx, calls } = makeFakeTx();

    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [
            { id: "grandchild", parentId: "child", name: "Leaf", quantity: 1, unitCost: 1 },
            { id: "child", parentId: "root", name: "Sub-section", quantity: 1, unitCost: 1, type: "Section" },
            { id: "root", name: "Section", quantity: 1, unitCost: 1, type: "Section" },
        ],
        existingItemsMap: new Map<string, ExistingEstimateItem>(),
    });

    assert.deepEqual(calls.map(c => c.args.data.id), ["root", "child", "grandchild"]);
});

test("upsertEstimateItems refuses a cyclic payload rather than writing part of it", async () => {
    const { tx, calls } = makeFakeTx();

    await assert.rejects(
        () => upsertEstimateItems(tx, {
            estimateId: "est1",
            items: [
                { id: "a", parentId: "b", name: "A", quantity: 1, unitCost: 1 },
                { id: "b", parentId: "a", name: "B", quantity: 1, unitCost: 1 },
            ],
            existingItemsMap: new Map<string, ExistingEstimateItem>(),
        }),
        /cyclic/,
    );
    assert.equal(calls.length, 0, "nothing is written before the graph is known to be sound");
});

test("a row whose parent is persisted but absent from the payload writes in the first group", async () => {
    const { tx, calls } = makeFakeTx();
    // The parent already exists in the database, so its FK resolves without being rewritten here.
    const existingItemsMap = new Map([["kid", existing({ id: "kid", name: "Sub-item" })]]);

    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [{ id: "kid", parentId: "already-persisted-section", name: "Sub-item", quantity: 1, unitCost: 1 }],
        existingItemsMap,
    });

    assert.deepEqual(calls.map(c => c.method), ["update"]);
});

test("the `order` fallback is per-group (parents and children each restart from 0)", async () => {
    const { tx, calls } = makeFakeTx();
    const existingItemsMap = new Map<string, ExistingEstimateItem>();

    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [
            { id: "p0", name: "Parent 0", quantity: 1, unitCost: 1 },
            { id: "p1", name: "Parent 1", quantity: 1, unitCost: 1 },
            { id: "c0", parentId: "p0", name: "Child 0", quantity: 1, unitCost: 1 },
            { id: "c1", parentId: "p0", name: "Child 1", quantity: 1, unitCost: 1 },
        ],
        existingItemsMap,
    });

    const createCalls = calls.filter(c => c.method === "create");
    const orderById = Object.fromEntries(createCalls.map(c => [c.args.data.id, c.args.data.order]));
    assert.deepEqual(orderById, { p0: 0, p1: 1, c0: 0, c1: 1 });
});

test("an explicit `order` on the item overrides the per-group fallback", async () => {
    const { tx, calls } = makeFakeTx();
    const existingItemsMap = new Map<string, ExistingEstimateItem>();

    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [{ id: "a", name: "Item", quantity: 1, unitCost: 1, order: 42 }],
        existingItemsMap,
    });

    assert.equal(calls[0].args.data.order, 42);
});

test("persisted field set matches ESTIMATE_ITEM_SAVE_FIELDS (the shared normalizeEstimateItemForSave projection), plus estimateId", async () => {
    const { tx, calls } = makeFakeTx();
    // Routed through the update path (existing row) so `id` is excluded from `data` — the
    // invariant `updateMany`/`update` requires (the primary key can't be set via `data`).
    const existingItemsMap = new Map([["a", existing({ id: "a", name: "Tile" })]]);

    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [{
            id: "a",
            name: "Tile",
            description: "Porcelain",
            type: "Material",
            quantity: 3,
            baseCost: 10,
            markupPercent: 20,
            unitCost: 12,
            total: 36,
            order: 5,
            parentId: "sect1",
            costCodeId: "cc1",
            costTypeId: "ct1",
            budgetQuantity: 4,
            budgetUnit: "sqft",
            budgetRate: 8.5,
            // Fields the editor must never be able to write directly through this path.
            purchaseOrderId: "po-should-not-write",
            approvalStatus: "approved",
            approvalNote: "looks good",
        }],
        existingItemsMap,
    });

    const data = calls[0].args.data;

    // The point of this test: the field set this module persists must match
    // normalizeEstimateItemForSave's field list exactly (minus `id`, which the update path
    // excludes, plus `estimateId`, which upsertEstimateItems adds). A hand-copied list here
    // could silently drift from what the editor's change-detection snapshot uses, which is
    // exactly the bug ESTIMATE_ITEM_SAVE_FIELDS was introduced to prevent.
    const expectedKeys = new Set<string>(ESTIMATE_ITEM_SAVE_FIELDS.filter(f => f !== "id"));
    expectedKeys.add("estimateId");
    assert.deepEqual(new Set(Object.keys(data)), expectedKeys);

    assert.equal(data.estimateId, "est1");
    assert.equal(data.name, "Tile");
    assert.equal(data.description, "Porcelain");
    assert.equal(data.type, "Material");
    assert.equal(data.quantity, 3);
    assert.equal(data.baseCost, 10);
    assert.equal(data.markupPercent, 20);
    assert.equal(data.unitCost, 12);
    assert.equal(data.total, 36);
    assert.equal(data.order, 5);
    assert.equal(data.parentId, "sect1");
    assert.equal(data.costCodeId, "cc1");
    assert.equal(data.costTypeId, "ct1");
    assert.equal(data.budgetQuantity, 4);
    assert.equal(data.budgetUnit, "sqft");
    assert.equal(data.budgetRate, 8.5);

    assert.equal("purchaseOrderId" in data, false, "links are owned solely by the PO link/unlink actions");
    assert.equal("approvalStatus" in data, false, "approval columns are owned solely by updateItemApproval");
    assert.equal("approvalNote" in data, false);
    assert.equal("id" in data, false, "create keeps id at the top level, not inside data twice");
});

/**
 * parentId scope. EstimateItem's self-referencing FK does not require parent and child to share
 * an estimateId, so without this guard a save can hang one estimate's rows off another
 * estimate's tree — and the section roll-up that drives totalAmount -> tax -> milestones would
 * then be computed across both.
 */
test("a parentId naming a row of THIS estimate is accepted (persisted parent)", () => {
    assertEstimateItemParentsInScope(
        [{ id: "child", parentId: "parent" }],
        ["parent", "child"],
    );
});

test("a parentId naming a brand-new section in the same payload is accepted", () => {
    // Add Category then drag items under it, all before the first save: neither row is
    // persisted yet, so the persisted-id set is empty and only the payload vouches for them.
    assertEstimateItemParentsInScope(
        [{ id: "new-section", parentId: null }, { id: "new-child", parentId: "new-section" }],
        [],
    );
});

test("a parentId belonging to a DIFFERENT estimate is rejected", () => {
    assert.throws(
        () => assertEstimateItemParentsInScope(
            [{ id: "child", parentId: "other-estimates-section" }],
            ["child"],
        ),
        /parent does not belong to this estimate/,
    );
});

test("the foreign parentId is rejected even when the rest of the payload is in scope", () => {
    assert.throws(
        () => assertEstimateItemParentsInScope(
            [
                { id: "a", parentId: null },
                { id: "b", parentId: "a" },
                { id: "c", parentId: "foreign" },
            ],
            ["a", "b", "c"],
        ),
        /parent does not belong to this estimate/,
    );
});

test("a row that is its own parent is rejected", () => {
    assert.throws(
        () => assertEstimateItemParentsInScope([{ id: "a", parentId: "a" }], ["a"]),
        /cannot be its own parent/,
    );
});

test("a multi-row parentId cycle is rejected, even though every id is in scope", () => {
    // A -> B -> C -> A. Every parent names a real row of this estimate, so the scope check alone
    // passes it. computeEstimateItemTotals then values every row in the cycle at 0, which would
    // quietly zero the subtotal that drives totalAmount -> tax -> milestones.
    assert.throws(
        () => assertEstimateItemParentsInScope(
            [
                { id: "a", parentId: "c" },
                { id: "b", parentId: "a" },
                { id: "c", parentId: "b" },
            ],
            ["a", "b", "c"],
        ),
        /cyclic/,
    );
});

test("a deep, acyclic chain is accepted", () => {
    assertEstimateItemParentsInScope(
        [
            { id: "d", parentId: "c" },
            { id: "c", parentId: "b" },
            { id: "b", parentId: "a" },
            { id: "a", parentId: null },
        ],
        [],
    );
});

test("absent, null and empty-string parentId are all treated as root rows", () => {
    assertEstimateItemParentsInScope(
        [{ id: "a" }, { id: "b", parentId: null }, { id: "c", parentId: "" }],
        [],
    );
});

test("a payload id vouches for a parent only for parentId — it still routes to create", async () => {
    // The in-scope set includes payload ids so a same-payload parent works. That cannot be used
    // to smuggle another estimate's row in: an id absent from existingItemsMap routes to create,
    // and a create under an id that already exists elsewhere fails the primary-key constraint.
    const { tx, calls } = makeFakeTx();
    assertEstimateItemParentsInScope(
        [{ id: "sect", parentId: null }, { id: "kid", parentId: "sect" }],
        [],
    );
    await upsertEstimateItems(tx, {
        estimateId: "est1",
        items: [
            { id: "sect", name: "Section", quantity: 1, unitCost: 1, type: "Section" },
            { id: "kid", parentId: "sect", name: "Sub-item", quantity: 1, unitCost: 1 },
        ],
        existingItemsMap: new Map<string, ExistingEstimateItem>(),
    });
    assert.deepEqual(calls.map(c => c.method), ["create", "create"]);
});

test("EstimateStaleSaveError is a plain, message-only sentinel", () => {
    const err = new EstimateStaleSaveError();
    assert.ok(err instanceof Error);
    assert.equal(err.name, "EstimateStaleSaveError");
});
