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
    HUMAN_TAX_SOURCES,
    TAX_CLASSIFICATION_COLUMNS,
    TAX_CLASSIFICATION_FIGURE_COLUMNS,
    TAX_CLASSIFICATION_SOURCE_COLUMNS,
    hasTaxClassification,
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

test("a person's CLEARED phase suppresses the item fallback", () => {
    // ROUND 42, ITEM 2. Clearing the phase writes `costCodeId: null` with
    // `costCodeSource: "manual-none"` and deliberately KEEPS the item link —
    // it is real history and billing reads it. The fallback then read the
    // code off that item, so the variance report, the margin digest and the
    // backfill's coverage table all went on charging the phase the bookkeeper
    // had just removed. The clear held in the column and did nothing anywhere
    // it mattered.
    assert.equal(
        resolveExpenseCostCodeId(
            { costCodeId: null, itemId: "item-coded", costCodeSource: "manual-none" },
            ITEM_CODES,
        ),
        null,
        "a person said there is no phase here",
    );
    // ...and ONLY for that value. A null source is "nobody has spoken", which
    // is the legacy majority and the whole reason the fallback exists.
    for (const source of [null, undefined, "ai", "backfill", "capture", "manual"]) {
        assert.equal(
            resolveExpenseCostCodeId(
                { costCodeId: null, itemId: "item-coded", costCodeSource: source },
                ITEM_CODES,
            ),
            "cc-framing",
            `source ${String(source)} must keep the fallback`,
        );
    }
    // An EXPLICIT code always wins, whatever the source says.
    assert.equal(
        resolveExpenseCostCodeId(
            { costCodeId: "cc-paint", itemId: "item-coded", costCodeSource: "manual-none" },
            ITEM_CODES,
        ),
        "cc-paint",
    );
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

test("hasTaxClassification counts EVERY column a person can answer", () => {
    // ROUND 38, ITEM 3. Three writers each carried their own version of this
    // test and the narrowest one — the expense PUT handler's, which omitted
    // `installedAtCustomer` — decided which stale deductions reached a state
    // filing. One definition, and every column in it.
    assert.deepEqual(
        [...TAX_CLASSIFICATION_COLUMNS],
        ["taxAmount", "taxDeductibleBase", "installedAtCustomer", "taxSource", "taxDeductibleBaseSource"],
    );
    // Nothing said at all.
    assert.equal(hasTaxClassification({}), false);
    assert.equal(
        hasTaxClassification({
            taxAmount: null, taxDeductibleBase: null, installedAtCustomer: null,
            taxSource: null, taxDeductibleBaseSource: null,
        }),
        false,
    );
    // Any one of them, on its own, is an answer...
    for (const column of TAX_CLASSIFICATION_FIGURE_COLUMNS) {
        assert.equal(hasTaxClassification({ [column]: 1 }), true, `${column} alone must count`);
    }
    for (const column of TAX_CLASSIFICATION_SOURCE_COLUMNS) {
        for (const value of HUMAN_TAX_SOURCES) {
            assert.equal(
                hasTaxClassification({ [column]: value }),
                true,
                `${column} = ${value} alone must count`,
            );
        }
        // ...but a MACHINE provenance is not one. An "ocr" source whose figure
        // has since been cleared is a guess with nothing left to invalidate,
        // and flagging those would bury the rows a person must actually look
        // at (the QBO sync's own control asserts this).
        assert.equal(
            hasTaxClassification({ [column]: "ocr" }),
            false,
            `${column} = ocr must NOT count on its own`,
        );
    }
    // A tri-state, not a truthiness test: an explicit FALSE is a person saying
    // "no, this was not resold", which is as much a decision as a true.
    assert.equal(hasTaxClassification({ installedAtCustomer: false }), true);
    // ...and so is a ZERO tax figure.
    assert.equal(hasTaxClassification({ taxAmount: 0 }), true);
    assert.equal(hasTaxClassification({ taxDeductibleBase: 0 }), true);
    // An absent key is "not selected", which is not an answer.
    assert.equal(hasTaxClassification({ taxAmount: undefined }), false);
});

test("notHumanCodedExpenseWhere has an explicit NULL branch", () => {
    // Without it, SQL `NOT IN` drops every NULL row — which is all 562 legacy
    // rows — and the backfill would silently write nothing.
    const where = notHumanCodedExpenseWhere();
    assert.deepEqual(Object.keys(where), ["OR"]);
    const branches = where.OR as Record<string, unknown>[];
    assert.equal(branches.length, 2);
    assert.deepEqual(branches[0], { costCodeSource: null });
    // "manual-none" joined the list in round 36, item 3: clearing a phase is a
    // person's decision, and a NULL provenance is exactly what the QBO suggester
    // and the backfill both read as "a machine may write here" — so the clear
    // used to be undone by the next sync.
    assert.deepEqual(branches[1], { costCodeSource: { notIn: ["capture", "manual", "manual-none"] } });
    assert.deepEqual([...HUMAN_COST_CODE_SOURCES], ["capture", "manual", "manual-none"]);
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

test("the tax & phase modal does not send taxAtSource at all", () => {
    // Round 20, item 1 settled this the other way: the modal used to compute
    // the flag (badly — `(parsedTax ?? 0) > 0` dropped every refund), then
    // computed it correctly through the shared rule, and now does not compute
    // it at all. The server derives it from the figure and REFUSES the field,
    // because two writers for one truth is how they came to disagree.
    const modal = readFileSync(
        path.join(__dirname, "..", "src/app/projects/[id]/time-expenses/TaxPhaseModal.tsx"),
        "utf8",
    );
    assert.ok(
        !/body\.taxAtSource\s*=/.test(modal),
        "the client must not set a derived column",
    );
    assert.ok(!/taxAtSource[^;]*>\s*0/.test(modal), "and no positive-only copy survives");
});


// ── every READER goes through the shared resolver (Codex round 35, item 4) ──

/**
 * These are SOURCE-level guards on purpose. The bug they pin is not a wrong
 * output from a function under test — it is a reader that never called the
 * function at all, having written the rule out by hand a few lines away from an
 * unused import of the real one. No behavioural test of the resolver can catch
 * that, because the code under test never runs it.
 *
 * Each guard asserts BOTH halves, and both halves matter: calling the resolver
 * while keeping the inline copy is how two answers survive side by side, and
 * dropping the inline copy without calling the resolver is how a display loses
 * its job entirely.
 *
 * They judge SOURCE TEXT, which is a weaker instrument than an AST and is used
 * knowing that — so the comments in those files deliberately describe the
 * banned shape rather than quoting it, and each guard is paired with a positive
 * assertion that cannot be satisfied by deleting code.
 */
function expenseReaderSource(relative: string): string {
    return readFileSync(path.join(__dirname, "..", relative), "utf8");
}

test("the AI review reader resolves the job through the shared resolver", () => {
    // It named the wrong job for every re-attributed expense: the rule was
    // right, but it was written out inline — and an inline copy is the one that
    // drifts. This reader's verdict is READ BY A PERSON and acted on, so a
    // confident wrong job costs more here than almost anywhere else.
    const src = expenseReaderSource("src/app/api/automation/ai-review/route.ts");
    assert.match(
        src,
        /resolveExpenseProjectLabel\(expense\)/,
        "the AI review must ASK the resolver, not merely import it",
    );
    assert.ok(
        !/expense\.projectId\s*\?(?!\.)/.test(src),
        "and no inline ternary on the denormalized id may survive alongside it",
    );
    assert.ok(
        !/expense\.projectId\s*\?\?/.test(src),
        "nor the nullish-coalescing spelling of the same rule",
    );
});

test("the register drill-down resolves the job through the shared resolver", () => {
    // Found by sweeping for the same shape, and worse than the AI review's: it
    // read the estimate FIRST and never consulted the denormalized column at
    // all, so a re-attributed expense was shown — and LINKED — under the job it
    // left, in the panel a bookkeeper opens precisely to check where a charge
    // landed.
    const src = expenseReaderSource("src/app/automation/components/register/row-drilldown.tsx");
    assert.match(
        src,
        /resolveExpenseProjectLabel\(expense\)/,
        "the drill-down must ask the resolver",
    );
    assert.ok(
        !/expense\.estimate\?\.project\?\.id\s*\?\?/.test(src),
        "and the estimate-first reading must not come back",
    );
    // The projection has to carry what the resolver answers FROM, or the
    // resolver is being asked a question whose evidence was never selected —
    // which reads as "this expense has no job" rather than as an error.
    const data = expenseReaderSource("src/app/automation/register-data.ts");
    const select = data.slice(
        data.indexOf("const DRILLDOWN_EXPENSE_SELECT"),
        data.indexOf("export type RawExpense"),
    );
    assert.match(select, /projectId: true/, "the denormalized column is selected");
    assert.match(select, /project: \{ select: \{ id: true, name: true \} \}/);
});

test("every reader of the phase fallback actually SELECTS the provenance", () => {
    // A rule that depends on a column nobody selected is a rule that does not
    // exist (round 42, item 2). These three are the readers that resolve a
    // phase through the item fallback; each must ask the database for
    // `costCodeSource` and hand it to the resolver.
    const ROOT = path.resolve(__dirname, "..");
    for (const [rel, needle] of [
        ["src/lib/job-variance-db.ts", /select: \{ costCodeId: true, costCodeSource: true, itemId: true, amount: true \}/],
        ["src/lib/margin-digest.ts", /resolveActualCostCodeId\(row\.costCodeId, row\.item\?\.costCodeId, row\.costCodeSource\)/],
        ["scripts/backfill-expense-attribution.ts", /costCodeSource: row\.costCodeSource \?\? null/],
    ] as [string, RegExp][]) {
        const source = readFileSync(path.join(ROOT, rel), "utf8");
        assert.match(source, needle, `${rel} does not pass costCodeSource to the resolver`);
    }
});
