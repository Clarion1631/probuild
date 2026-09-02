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
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    HUMAN_COST_CODE_SOURCES,
    expenseForProjectWhere,
    expenseForProjectsWhere,
    expenseHasAnyProjectWhere,
    isPlausibleReceiptTax,
    maxPlausibleTaxAmount,
    notHumanCodedExpenseWhere,
    taxIsAtSource,
    resolveExpenseCostCodeId,
    resolveExpenseProjectId,
    resolveExpenseProjectLabel,
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

// ── the display/routing label, for the readers converted last ──────────────

test("a re-attributed row is LABELLED by the job it is actually on", () => {
    // schedule-core, automation-events, the ai-review route and the manager
    // receipt queue all read the estimate. A label that disagrees with the
    // ledger is worse than none: it is a wrong answer that looks authoritative,
    // and in the review-alert case it also ROUTES the alert.
    assert.deepEqual(
        resolveExpenseProjectLabel({
            projectId: "job-b",
            project: { id: "job-b", name: "Mesplay Kitchen" },
            estimate: { projectId: "job-a", project: { id: "job-a", name: "Mueller Bath" } },
        }),
        { projectId: "job-b", projectName: "Mesplay Kitchen" },
    );
});

test("it falls back to the estimate for the id and the name TOGETHER", () => {
    // Taking the id from one row and the name from another would print a real
    // job's name against a different job's id.
    assert.deepEqual(
        resolveExpenseProjectLabel({
            projectId: null,
            estimate: { projectId: "job-a", project: { id: "job-a", name: "Mueller Bath" } },
        }),
        { projectId: "job-a", projectName: "Mueller Bath" },
    );
});

test("a re-attributed row whose direct relation was not selected gives no NAME, not the wrong one", () => {
    // The estimate's name belongs to the OLD job. Returning it beside the new
    // id would be the exact mislabel this helper exists to stop.
    assert.deepEqual(
        resolveExpenseProjectLabel({
            projectId: "job-b",
            estimate: { projectId: "job-a", project: { id: "job-a", name: "Mueller Bath" } },
        }),
        { projectId: "job-b", projectName: null },
    );
});

test("an unattributed row labels as nothing at all", () => {
    assert.deepEqual(
        resolveExpenseProjectLabel({ projectId: null, estimate: { projectId: null, project: null } }),
        { projectId: null, projectName: null },
    );
});

// ── the one tax plausibility bound (Codex round 15, item 1) ────────────────

test("the tax bound is 12% of the gross MAGNITUDE, rounded to cents", () => {
    assert.equal(maxPlausibleTaxAmount(100), 12);
    assert.equal(maxPlausibleTaxAmount(207.74), 24.93);
    assert.equal(maxPlausibleTaxAmount(0), 0, "no receipt, no allowance");
    // A refund is a negative expense; its allowance is the same size.
    assert.equal(maxPlausibleTaxAmount(-100), 12);
});

test("zero is plausible, a transposed read is not", () => {
    // "This receipt had no tax" is a real answer. $90 on a $100 receipt is a
    // decimal point in the wrong place, and it is the case that reaches an
    // excise return as a $90 deduction if nothing stops it.
    assert.equal(isPlausibleReceiptTax(0, 100), true);
    assert.equal(isPlausibleReceiptTax(9.5, 100), true);
    assert.equal(isPlausibleReceiptTax(12, 100), true, "the bound itself is allowed");
    assert.equal(isPlausibleReceiptTax(12.01, 100), false);
    assert.equal(isPlausibleReceiptTax(90, 100), false);
    assert.equal(isPlausibleReceiptTax(Number.NaN, 100), false);
});

test("a REFUND's tax is negative, and a positive one on it is refused", () => {
    // A return or vendor credit is a negative expense and the tax comes back
    // with it. Refusing that shape would push a bookkeeper into recording the
    // credit as a positive, which the excise report then ADDS to a deduction it
    // should be reducing.
    assert.equal(isPlausibleReceiptTax(-4, -50), true, "-$4 of tax on a -$50 return");
    assert.equal(isPlausibleReceiptTax(-6, -50), true, "12% of the magnitude");
    assert.equal(isPlausibleReceiptTax(-6.01, -50), false, "and no further");
    assert.equal(isPlausibleReceiptTax(4, -50), false, "a dropped minus sign");
    assert.equal(isPlausibleReceiptTax(-4, 50), false, "and the same the other way");
    assert.equal(isPlausibleReceiptTax(0, -50), true, "a credit can carry no tax");
});

// ── taxAtSource follows the figure, signed (Codex round 18, item 1) ────────

test("taxIsAtSource is true for any non-zero figure, either direction", () => {
    // The FACT is "tax was charged on this receipt". On a return it is just as
    // true — the tax was charged, and is now coming back. `> 0` read every
    // credit as "no tax here", which is how a refund's tax left the filing.
    assert.equal(taxIsAtSource(16.55), true);
    assert.equal(taxIsAtSource(-4), true, "a credit still carries the fact");
    assert.equal(taxIsAtSource(0), false, "zero is an answer: no tax");
    assert.equal(taxIsAtSource(null), false, "and silence is not a claim");
    assert.equal(taxIsAtSource(undefined), false);
    assert.equal(taxIsAtSource(Number.NaN), false);
});

test("the tax & phase modal derives the flag from the figure, not from its sign", () => {
    // The modal is the only writer a bookkeeper touches directly. It computed
    // `(parsedTax ?? 0) > 0`, so saving a refund's -$4 of tax silently stored
    // taxAtSource=false and dropped the row out of the excise report — on both
    // the ordinary save and the review acknowledgement.
    const modal = readFileSync(
        path.join(__dirname, "..", "src/app/projects/[id]/time-expenses/TaxPhaseModal.tsx"),
        "utf8",
    );
    const assignments = [...modal.matchAll(/body\.taxAtSource = ([^;]+);/g)].map(m => m[1].trim());
    assert.equal(assignments.length, 2, "the ordinary save and the ack both set it");
    for (const assignment of assignments) {
        assert.equal(assignment, "taxIsAtSource(parsedTax)", "both go through the shared rule");
    }
    assert.ok(!/taxAtSource[^;]*>\s*0/.test(modal), "no positive-only copy survives");
});
