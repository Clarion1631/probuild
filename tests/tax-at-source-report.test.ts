/**
 * The WA excise deduction. Getting this wrong overstates a tax deduction, so
 * the exclusions matter more than the sums: a row counts only on POSITIVE
 * evidence, never on the absence of a contradiction.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    currentQuarterRange,
    extractReference,
    groupTaxAtSource,
    parseTaxAtSourceFilters,
    rowsToCsv,
    stringifyTaxAtSourceFilters,
    type TaxAtSourceRow,
} from "../src/lib/tax-at-source-report";

function row(overrides: Partial<TaxAtSourceRow> = {}): TaxAtSourceRow {
    const receiptTotal = overrides.receiptTotal ?? 207.74;
    const tax = overrides.tax ?? 16.55;
    return {
        id: "e1",
        date: new Date("2026-06-26T00:00:00.000Z"),
        vendor: "Harbor Freight",
        projectId: "job-mesplay",
        projectName: "Mesplay Kitchen",
        reference: "001916749100246",
        receiptTotal,
        deductionBase: receiptTotal - tax,
        tax,
        ...overrides,
    };
}

// ── grouping ────────────────────────────────────────────────────────────────

test("sums per month and per job, and the totals tie out", () => {
    const { months, summary } = groupTaxAtSource([
        row({ id: "a", tax: 10, receiptTotal: 110, deductionBase: 100 }),
        row({ id: "b", tax: 5, receiptTotal: 55, deductionBase: 50 }),
        row({
            id: "c",
            projectId: "job-mueller",
            projectName: "Mueller Bath",
            tax: 20,
            receiptTotal: 220,
            deductionBase: 200,
        }),
        row({
            id: "d",
            date: new Date("2026-07-02T00:00:00.000Z"),
            tax: 1,
            receiptTotal: 11,
            deductionBase: 10,
        }),
    ]);

    assert.deepEqual(months.map(m => m.key), ["2026-06", "2026-07"], "months are chronological");
    const june = months[0];
    assert.equal(june.count, 3);
    assert.equal(june.tax, 35);
    assert.equal(june.deductionBase, 350);
    // Jobs sort by tax, largest first — that is the row a bookkeeper checks.
    assert.deepEqual(june.jobs.map(j => j.projectId), ["job-mueller", "job-mesplay"]);
    assert.equal(june.jobs.find(j => j.projectId === "job-mesplay")!.count, 2);
    assert.equal(june.jobs.find(j => j.projectId === "job-mesplay")!.tax, 15);

    assert.equal(summary.count, 4);
    assert.equal(summary.tax, 36);
    assert.equal(summary.deductionBase, 360);
    assert.equal(
        summary.tax,
        months.reduce((total, month) => total + month.tax, 0),
        "the grand total is the month totals, not a second computation",
    );
});

test("two jobs sharing a name stay separate", () => {
    // Bucketing by name would merge one client's deduction into another's.
    const { months } = groupTaxAtSource([
        row({ id: "a", projectId: "job-1", projectName: "Bathroom Remodel", tax: 10 }),
        row({ id: "b", projectId: "job-2", projectName: "Bathroom Remodel", tax: 20 }),
    ]);
    assert.equal(months[0].jobs.length, 2);
    assert.deepEqual(months[0].jobs.map(j => j.projectId), ["job-2", "job-1"]);
});

test("an unattributed receipt is shown, not dropped", () => {
    // Money that was spent is real even when nobody said whose job it was.
    // Hiding it would make the report quietly understate the deduction.
    const { months, summary } = groupTaxAtSource([
        row({ projectId: null, projectName: "(unassigned)", tax: 7 }),
    ]);
    assert.equal(months[0].jobs[0].projectId, null);
    assert.equal(summary.tax, 7);
});

test("an empty period is zeros, not NaN", () => {
    const { months, summary } = groupTaxAtSource([]);
    assert.deepEqual(months, []);
    assert.deepEqual(summary, { count: 0, deductionBase: 0, receiptTotal: 0, tax: 0 });
});

// ── the filter contract ─────────────────────────────────────────────────────

test("the default period is the current calendar quarter, [from, to)", () => {
    const filters = parseTaxAtSourceFilters({}, new Date(2026, 7, 15));
    assert.equal(filters.from.getMonth(), 6, "Q3 starts in July");
    assert.equal(filters.from.getDate(), 1);
    assert.equal(filters.to.getMonth(), 9, "and ends at the start of October, exclusive");
    assert.equal(filters.to.getDate(), 1);
    assert.deepEqual(filters, currentQuarterRange(new Date(2026, 7, 15)));
});

test("the picker's `to` is inclusive to a human and exclusive to the query", () => {
    // A receipt dated on the last day of the range must be IN it. An exclusive
    // bound taken literally from the picker would silently drop that day.
    const filters = parseTaxAtSourceFilters({ from: "2026-06-01", to: "2026-06-30" });
    assert.equal(filters.from.getDate(), 1);
    assert.equal(filters.to.getMonth(), 6);
    assert.equal(filters.to.getDate(), 1, "start of July");
    // ...and it round-trips back to the day the user typed.
    assert.equal(stringifyTaxAtSourceFilters(filters), "from=2026-06-01&to=2026-06-30");
});

test("an inverted or unparseable range falls back to the quarter, not to empty", () => {
    // An empty table reads as "no tax was paid", which is a very different
    // claim from "your dates are backwards".
    const now = new Date(2026, 7, 15);
    assert.deepEqual(
        parseTaxAtSourceFilters({ from: "2026-06-30", to: "2026-06-01" }, now),
        currentQuarterRange(now),
    );
    assert.deepEqual(
        parseTaxAtSourceFilters({ from: "not-a-date", to: "also-not" }, now),
        currentQuarterRange(now),
    );
});

// ── reference extraction ────────────────────────────────────────────────────

test("the invoice reference is recovered from the description, or left blank", () => {
    assert.equal(
        extractReference("[Receipt intake] Invoice 82766 · incl. $29.20 sales tax · pending bookkeeper review"),
        "82766",
    );
    assert.equal(extractReference('[Receipt intake] Check #1041 — "materials"'), "Check 1041");
    assert.equal(extractReference("[Drive import] Receipt · Materials"), "", "a miss is blank, never a guess");
    assert.equal(extractReference(null), "");
});

// ── CSV ─────────────────────────────────────────────────────────────────────

test("the CSV mirrors the workbook columns Vanessa already receives", () => {
    const csv = rowsToCsv([row({ receiptTotal: 207.74, tax: 16.55, deductionBase: 191.19 })]);
    const [header, line] = csv.trimEnd().split("\r\n");
    assert.equal(
        header,
        "Date,Vendor,Job,Invoice,Receipt Total,Material Amount (deduction base),Tax Paid at Source",
    );
    assert.equal(
        line,
        '2026-06-26,"Harbor Freight","Mesplay Kitchen","001916749100246",207.74,191.19,16.55',
    );
});

test("CSV quoting survives a vendor name with a comma or a quote", () => {
    const csv = rowsToCsv([row({ vendor: 'Lowe"s, Vancouver' })]);
    assert.match(csv, /"Lowe""s, Vancouver"/);
});
