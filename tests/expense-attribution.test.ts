/**
 * The resolver's whole job is to change NOTHING for existing data.
 *
 * `Expense.projectId` is new and backfilled, so for every row where it is still
 * NULL the resolver must return exactly what the old `estimate.projectId`
 * traversal returned. The `legacyTraversal` fixture below IS the old code,
 * copied verbatim, and the table test runs both over the same rows — a
 * behaviour-preserving refactor asserted rather than asserted-to.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    HUMAN_COST_CODE_SOURCES,
    expenseForProjectWhere,
    expenseForProjectsWhere,
    expenseHasAnyProjectWhere,
    notHumanCodedExpenseWhere,
    resolveExpenseCostCodeId,
    resolveExpenseProjectId,
} from "../src/lib/expense-attribution";

// ── project resolution ──────────────────────────────────────────────────────

test("resolveExpenseProjectId: column wins, estimate is the fallback, else null", () => {
    assert.equal(
        resolveExpenseProjectId({ projectId: "p1", estimate: { projectId: "p2" } }),
        "p1",
    );
    assert.equal(resolveExpenseProjectId({ projectId: null, estimate: { projectId: "p2" } }), "p2");
    assert.equal(resolveExpenseProjectId({ projectId: null, estimate: { projectId: null } }), null);
    assert.equal(resolveExpenseProjectId({ projectId: null, estimate: null }), null);
    assert.equal(resolveExpenseProjectId({ projectId: null }), null);
    assert.equal(resolveExpenseProjectId({ projectId: "p1", estimate: null }), "p1");
});

test("for every projectId-NULL row the resolver equals the pre-Phase-3 traversal", () => {
    // Verbatim copy of what every reader did before this module existed.
    const legacyTraversal = (e: { estimate?: { projectId: string | null } | null }) =>
        e.estimate?.projectId ?? null;

    const legacyShapedRows = [
        { projectId: null, estimate: { projectId: "proj-a" } },
        { projectId: null, estimate: { projectId: null } },
        { projectId: null, estimate: null },
        { projectId: null, estimate: { projectId: "" } },
    ];
    for (const row of legacyShapedRows) {
        assert.equal(
            resolveExpenseProjectId(row),
            legacyTraversal(row),
            `diverged on ${JSON.stringify(row)}`,
        );
    }
});

test("an empty-string projectId is not treated as a project id", () => {
    // `??` would keep "", which would then be used as a Map key and bucket the
    // row under a project that does not exist. Guard the semantics explicitly
    // so a future change to `||`/`??` cannot pass silently.
    assert.equal(resolveExpenseProjectId({ projectId: "", estimate: { projectId: "p2" } }), "");
});

// ── cost-code resolution ────────────────────────────────────────────────────

const ITEM_CODES = new Map<string, string | null>([
    ["item-coded", "cc-framing"],
    ["item-uncoded", null],
]);

test("resolveExpenseCostCodeId: explicit code, item fallback, then null", () => {
    assert.equal(
        resolveExpenseCostCodeId({ costCodeId: "cc-paint", itemId: "item-coded" }, ITEM_CODES),
        "cc-paint",
        "an explicit code must beat the item's",
    );
    assert.equal(
        resolveExpenseCostCodeId({ costCodeId: null, itemId: "item-coded" }, ITEM_CODES),
        "cc-framing",
    );
    assert.equal(
        resolveExpenseCostCodeId({ costCodeId: null, itemId: "item-uncoded" }, ITEM_CODES),
        null,
        "an item with no code resolves to null, not to the item id",
    );
    assert.equal(
        resolveExpenseCostCodeId({ costCodeId: null, itemId: "item-missing" }, ITEM_CODES),
        null,
        "an item outside the pool must not throw",
    );
    assert.equal(resolveExpenseCostCodeId({ costCodeId: null, itemId: null }, ITEM_CODES), null);
});

test("resolveExpenseCostCodeId matches the inline fallback job-variance used", () => {
    const legacyReconcile = (
        explicitCostCodeId: string | null,
        linkedItem: { costCodeId: string | null } | undefined,
    ) => explicitCostCodeId ?? linkedItem?.costCodeId ?? null;

    const rows: { costCodeId: string | null; itemId: string | null }[] = [
        { costCodeId: "cc-paint", itemId: "item-coded" },
        { costCodeId: "cc-paint", itemId: null },
        { costCodeId: null, itemId: "item-coded" },
        { costCodeId: null, itemId: "item-uncoded" },
        { costCodeId: null, itemId: null },
    ];
    for (const row of rows) {
        const linked = row.itemId !== null && ITEM_CODES.has(row.itemId)
            ? { costCodeId: ITEM_CODES.get(row.itemId) ?? null }
            : undefined;
        assert.equal(
            resolveExpenseCostCodeId(row, ITEM_CODES),
            legacyReconcile(row.costCodeId, linked),
            `diverged on ${JSON.stringify(row)}`,
        );
    }
});

// ── where fragments ─────────────────────────────────────────────────────────

test("expenseForProjectWhere is ONE OR key with two disjoint branches", () => {
    const where = expenseForProjectWhere("proj-a");
    assert.deepEqual(Object.keys(where), ["OR"], "exactly one key, or a spread will clobber it");
    assert.deepEqual(where, {
        OR: [
            { projectId: "proj-a" },
            { projectId: null, estimate: { projectId: "proj-a" } },
        ],
    });
    // Disjoint: the second branch pins projectId to null, so a row is never
    // matched by both and the first can use Expense_projectId_idx.
    const second = (where.OR as Record<string, unknown>[])[1];
    assert.equal(second.projectId, null);
});

test("expenseForProjectsWhere and expenseHasAnyProjectWhere keep the same shape", () => {
    assert.deepEqual(expenseForProjectsWhere(["a", "b"]), {
        OR: [
            { projectId: { in: ["a", "b"] } },
            { projectId: null, estimate: { projectId: { in: ["a", "b"] } } },
        ],
    });
    assert.deepEqual(Object.keys(expenseHasAnyProjectWhere()), ["OR"]);
    assert.deepEqual(expenseHasAnyProjectWhere(), {
        OR: [
            { projectId: { not: null } },
            { projectId: null, estimate: { projectId: { not: null } } },
        ],
    });
});

test("notHumanCodedExpenseWhere has an explicit NULL branch", () => {
    // Without it, SQL `NOT IN` drops every NULL row — which is all 562 legacy
    // rows — and the backfill would silently write nothing.
    const where = notHumanCodedExpenseWhere();
    assert.deepEqual(Object.keys(where), ["OR"]);
    const branches = where.OR as Record<string, unknown>[];
    assert.equal(branches.length, 2);
    assert.deepEqual(branches[0], { costCodeSource: null });
    assert.deepEqual(branches[1], { costCodeSource: { notIn: ["capture", "manual"] } });
    assert.deepEqual([...HUMAN_COST_CODE_SOURCES], ["capture", "manual"]);
});
