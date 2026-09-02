/**
 * The WA excise deduction. Getting this wrong overstates a tax deduction, so
 * the exclusions matter more than the sums: a row counts only on POSITIVE
 * evidence, never on the absence of a contradiction.
 *
 * Three properties are asserted hard, because each has a failure mode that is
 * invisible in the output:
 *   * INTEGER CENTS — a float sum drifts and the grand total stops agreeing
 *     with the rows it is made of;
 *   * COMPANY TIME ZONE — a 6pm-Pacific receipt on 30 September is 1 October
 *     UTC, and bucketed in UTC it lands on the wrong excise return;
 *   * CSV FORMULA NEUTRALIZATION — vendor and description are free text off a
 *     receipt, so a leading `=` reaches Marge's spreadsheet as a formula.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    currentQuarterKeys,
    extractReference,
    groupTaxAtSource,
    monthLabelFromKey,
    parseTaxAtSourceFilters,
    rowsToCsv,
    stringifyTaxAtSourceFilters,
    toCents,
    type TaxAtSourceRow,
} from "../src/lib/tax-at-source-report";
import { csvCell, csvNumber } from "../src/lib/csv-safe";
import { expenseNotOnProjectWhere } from "../src/lib/expense-attribution";

const PACIFIC = "America/Los_Angeles";

function row(overrides: Partial<TaxAtSourceRow> = {}): TaxAtSourceRow {
    const receiptTotalCents = overrides.receiptTotalCents ?? 20774;
    const taxCents = overrides.taxCents ?? 1655;
    return {
        id: "e1",
        date: new Date("2026-06-26T19:00:00.000Z"),
        dayKey: "2026-06-26",
        vendor: "Harbor Freight",
        projectId: "job-mesplay",
        projectName: "Mesplay Kitchen",
        reference: "001916749100246",
        receiptTotalCents,
        deductionBaseCents: receiptTotalCents - taxCents,
        baseIsAllocated: false,
        taxCents,
        ...overrides,
    };
}

// ── integer cents ───────────────────────────────────────────────────────────

test("toCents reads a Decimal's digits, never a float", () => {
    assert.equal(toCents("16.55"), 1655);
    assert.equal(toCents("16.550000000000000000000000000000"), 1655, "Prisma's Decimal string form");
    assert.equal(toCents("0.1"), 10);
    assert.equal(toCents("207"), 20700);
    assert.equal(toCents("-4.79"), -479);
    assert.equal(toCents("1.005"), 101, "half-up on the third decimal");
    assert.equal(toCents("1.004"), 100);
    assert.equal(toCents(null), 0);
    assert.equal(toCents(""), 0);
});

test("a hundred float-hostile receipts still sum exactly", () => {
    // The canonical drift: 0.1 + 0.2 !== 0.3. Summing dollars as numbers, 100
    // rows of $0.10 tax lands at 10.000000000000002 and the grand total stops
    // matching the sum of the rows a bookkeeper can see.
    const rows = Array.from({ length: 100 }, (_, i) =>
        row({ id: `e${i}`, receiptTotalCents: 30, taxCents: 10 }),
    );
    const { summary, months } = groupTaxAtSource(rows);
    assert.equal(summary.taxCents, 1000, "exactly $10.00");
    assert.equal(summary.deductionBaseCents, 2000);
    assert.equal(months[0].taxCents, 1000);
    assert.equal(
        summary.taxCents,
        months.reduce((total, month) => total + month.taxCents, 0),
        "the grand total is the month totals, not a second computation",
    );
    // Proof the guard is load-bearing: the same thing in floats does drift.
    const floatSum = rows.reduce(total => total + 0.1, 0);
    assert.notEqual(floatSum, 10);
});

// ── grouping ────────────────────────────────────────────────────────────────

test("sums per month and per job, and the totals tie out", () => {
    const { months, summary } = groupTaxAtSource([
        row({ id: "a", taxCents: 1000, receiptTotalCents: 11000, deductionBaseCents: 10000 }),
        row({ id: "b", taxCents: 500, receiptTotalCents: 5500, deductionBaseCents: 5000 }),
        row({
            id: "c",
            projectId: "job-mueller",
            projectName: "Mueller Bath",
            taxCents: 2000,
            receiptTotalCents: 22000,
            deductionBaseCents: 20000,
        }),
        row({ id: "d", dayKey: "2026-07-02", taxCents: 100, receiptTotalCents: 1100, deductionBaseCents: 1000 }),
    ]);

    assert.deepEqual(months.map(m => m.key), ["2026-06", "2026-07"], "months are chronological");
    const june = months[0];
    assert.equal(june.count, 3);
    assert.equal(june.taxCents, 3500);
    assert.equal(june.deductionBaseCents, 35000);
    assert.equal(june.label, "June 2026");
    // Jobs sort by tax, largest first — that is the row a bookkeeper checks.
    assert.deepEqual(june.jobs.map(j => j.projectId), ["job-mueller", "job-mesplay"]);
    assert.equal(june.jobs.find(j => j.projectId === "job-mesplay")!.count, 2);
    assert.equal(june.jobs.find(j => j.projectId === "job-mesplay")!.taxCents, 1500);

    assert.equal(summary.count, 4);
    assert.equal(summary.taxCents, 3600);
    assert.equal(summary.deductionBaseCents, 36000);
});

test("month buckets follow the COMPANY day key, not the UTC instant", () => {
    // 30 Sep 2026, 6pm Pacific = 1 Oct 01:00 UTC. Bucketed on the instant this
    // row lands in October — a different QUARTER, so the deduction would be
    // claimed on the wrong excise return.
    const { months } = groupTaxAtSource([
        row({ id: "late", date: new Date("2026-10-01T01:00:00.000Z"), dayKey: "2026-09-30" }),
    ]);
    assert.deepEqual(months.map(m => m.key), ["2026-09"]);
});

test("two jobs sharing a name stay separate", () => {
    const { months } = groupTaxAtSource([
        row({ id: "a", projectId: "job-1", projectName: "Bathroom Remodel", taxCents: 1000 }),
        row({ id: "b", projectId: "job-2", projectName: "Bathroom Remodel", taxCents: 2000 }),
    ]);
    assert.equal(months[0].jobs.length, 2);
    assert.deepEqual(months[0].jobs.map(j => j.projectId), ["job-2", "job-1"]);
});

test("an unattributed receipt is shown, not dropped", () => {
    // Money that was spent is real even when nobody said whose job it was.
    const { months, summary } = groupTaxAtSource([
        row({ projectId: null, projectName: "(unassigned)", taxCents: 700 }),
    ]);
    assert.equal(months[0].jobs[0].projectId, null);
    assert.equal(summary.taxCents, 700);
});

test("an empty period is zeros, not NaN", () => {
    const { months, summary } = groupTaxAtSource([]);
    assert.deepEqual(months, []);
    assert.deepEqual(summary, { count: 0, deductionBaseCents: 0, receiptTotalCents: 0, taxCents: 0 });
});

test("a mixed receipt contributes only its ALLOCATED base", () => {
    // $207.74 gross, $16.55 tax, but only $50 of it was material resold to the
    // customer — the rest was shop consumables. Claiming the whole pre-tax
    // $191.19 would overstate the deduction by $141.19 on one receipt.
    const { summary } = groupTaxAtSource([
        row({ receiptTotalCents: 20774, taxCents: 1655, deductionBaseCents: 5000, baseIsAllocated: true }),
    ]);
    assert.equal(summary.deductionBaseCents, 5000);
    assert.equal(summary.receiptTotalCents, 20774, "the gross is still reported honestly");
    assert.equal(summary.taxCents, 1655);
});

// ── period boundaries, in the company zone ──────────────────────────────────

test("the quarter is the company's calendar quarter, not the server's", () => {
    // 1 Jan 2027, 04:00 UTC is still 31 Dec 2026, 8pm Pacific. A server in UTC
    // would offer Q1 2027; the company is still filing Q4 2026.
    const newYearInstant = new Date("2027-01-01T04:00:00.000Z");
    assert.deepEqual(currentQuarterKeys(newYearInstant, PACIFIC), {
        fromKey: "2026-10-01",
        toKey: "2026-12-31",
    });
    assert.deepEqual(currentQuarterKeys(newYearInstant, "UTC"), {
        fromKey: "2027-01-01",
        toKey: "2027-03-31",
    });
});

test("quarter ends land on the right last day, February included", () => {
    assert.deepEqual(currentQuarterKeys(new Date("2028-02-10T20:00:00.000Z"), PACIFIC), {
        fromKey: "2028-01-01",
        toKey: "2028-03-31",
    });
    assert.deepEqual(currentQuarterKeys(new Date("2026-05-10T20:00:00.000Z"), PACIFIC), {
        fromKey: "2026-04-01",
        toKey: "2026-06-30",
    });
});

test("the query bounds are company midnights, and `to` is exclusive-next-day", () => {
    const filters = parseTaxAtSourceFilters({ from: "2026-06-01", to: "2026-06-30" }, PACIFIC);
    assert.equal(filters.fromKey, "2026-06-01");
    assert.equal(filters.toKey, "2026-06-30");
    // June is PDT (UTC-7): midnight local is 07:00Z.
    assert.equal(filters.from.toISOString(), "2026-06-01T07:00:00.000Z");
    // A receipt bought on the LAST day of the range must be inside it, so the
    // exclusive bound is the start of 1 July, not of 30 June.
    assert.equal(filters.to.toISOString(), "2026-07-01T07:00:00.000Z");
    assert.equal(stringifyTaxAtSourceFilters(filters), "from=2026-06-01&to=2026-06-30");
});

test("a winter range uses the winter offset — the bound is not a fixed number of hours", () => {
    const filters = parseTaxAtSourceFilters({ from: "2026-01-01", to: "2026-03-31" }, PACIFIC);
    assert.equal(filters.from.toISOString(), "2026-01-01T08:00:00.000Z", "PST is UTC-8");
    assert.equal(filters.to.toISOString(), "2026-04-01T07:00:00.000Z", "PDT by 1 April");
});

test("an inverted or unparseable range falls back to the quarter, not to empty", () => {
    // An empty table reads as "no tax was paid", which is a very different
    // claim from "your dates are backwards".
    const now = new Date("2026-08-15T20:00:00.000Z");
    const quarter = currentQuarterKeys(now, PACIFIC);
    for (const params of [
        { from: "2026-06-30", to: "2026-06-01" },
        { from: "not-a-date", to: "also-not" },
        {},
    ]) {
        const filters = parseTaxAtSourceFilters(params, PACIFIC, now);
        assert.equal(filters.fromKey, quarter.fromKey, JSON.stringify(params));
        assert.equal(filters.toKey, quarter.toKey, JSON.stringify(params));
    }
});

test("monthLabelFromKey formats from the key, with no Date in the way", () => {
    assert.equal(monthLabelFromKey("2026-06"), "June 2026");
    assert.equal(monthLabelFromKey("2026-12"), "December 2026");
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
    const csv = rowsToCsv([row({ receiptTotalCents: 20774, taxCents: 1655, deductionBaseCents: 19119 })]);
    const [header, line] = csv.trimEnd().split("\r\n");
    assert.equal(
        header,
        "Date,Vendor,Job,Invoice,Receipt Total,Material Amount (deduction base),Tax Paid at Source",
    );
    assert.equal(
        line,
        '"2026-06-26","Harbor Freight","Mesplay Kitchen","001916749100246",207.74,191.19,16.55',
    );
});

test("a vendor name that starts a formula is neutralized, not executed", () => {
    // Vendor and description are free text lifted off a receipt by a model.
    const csv = rowsToCsv([row({ vendor: "=cmd|'/c calc'!A1", reference: "+1-555", projectName: "@job" })]);
    const line = csv.trimEnd().split("\r\n")[1];
    assert.match(line, /"'=cmd\|'\/c calc'!A1"/);
    assert.match(line, /"'\+1-555"/);
    assert.match(line, /"'@job"/);
});

test("CSV quoting survives a comma, a quote, and a newline", () => {
    const csv = rowsToCsv([row({ vendor: 'Lowe"s, Vancouver\nStore 42' })]);
    assert.match(csv, /"Lowe""s, Vancouver\nStore 42"/);
});

test("csv-safe: numbers stay numbers, text gets neutralized", () => {
    // A negative amount must NOT be quote-prefixed — that would turn a number
    // into text and break every SUM in the sheet.
    assert.equal(csvNumber(-12.5), "-12.50");
    assert.equal(csvNumber(Number.NaN), "", "never the string NaN, which poisons a SUM");
    assert.equal(csvCell("-12.50"), '"\'-12.50"', "the same digits as TEXT are neutralized");
    assert.equal(csvCell("plain"), '"plain"');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell("\tlead-tab"), '"\'\tlead-tab"');
});

test("INVISIBLE leading whitespace does not smuggle a formula past the check", () => {
    // A spreadsheet trims before deciding, so " =1+1" is every bit as live as
    // "=1+1" while sailing past a naive first-character test.
    assert.equal(csvCell(" =1+1"), `"' =1+1"`);
    assert.equal(csvCell("\n=1+1"), `"'\n=1+1"`);
    assert.equal(csvCell("  @SUM(A1)"), `"'  @SUM(A1)"`);
    // The whitespace itself is DATA and is preserved — neutralizing must not
    // quietly edit the export.
    assert.match(csvCell(" =1+1"), / =1\+1/);
    // A leading space in front of harmless text stays untouched.
    assert.equal(csvCell(" Harbor Freight"), `" Harbor Freight"`);
    // ...and a bare leading TAB is still caught, even though trimming would
    // make it vanish before the test could see it.
    assert.equal(csvCell("\tlead-tab"), `"'\tlead-tab"`);
});

test("csvNumber accepts a Decimal-like or boxed value, and never emits exponent form", () => {
    // Prisma Decimal has its OWN toFixed, so a caller handing one straight in
    // is the likeliest mistake; everything is normalized through String/Number.
    const decimalLike = { toString: () => "207.74" };
    assert.equal(csvNumber(decimalLike), "207.74");
    // eslint-disable-next-line no-new-wrappers
    assert.equal(csvNumber(new Number(16.5)), "16.50");
    assert.equal(csvNumber("16.555", 2), "16.56");
    // toFixed flips to "1e+21" here; a CSV cell reading "1e+21" is not a number
    // anyone can sum.
    const huge = csvNumber(1e21);
    assert.ok(!/[eE]/.test(huge), `exponent notation leaked: ${huge}`);
    assert.match(huge, /^\d+\.\d{2}$/);
    assert.equal(csvNumber(undefined), "");
    assert.equal(csvNumber("not a number"), "");
});

// ── the overhead bucket is excluded (Codex round 6, item 5) ────────────────

test("the exclusion is written POSITIVELY so unattributed rows survive it", () => {
    // `NOT (projectId = X OR (projectId IS NULL AND est = X))` is SQL-NULL for
    // a row with neither set — which EXCLUDES it. That is exactly the
    // "(unassigned)" receipt a bookkeeper most needs to see, so the exclusion
    // is three positive branches instead.
    const where = expenseNotOnProjectWhere("overhead-1");
    const branches = where.OR as Record<string, unknown>[];
    assert.equal(branches.length, 3);
    assert.deepEqual(branches[0], {
        AND: [{ projectId: { not: null } }, { NOT: { projectId: "overhead-1" } }],
    });
    assert.deepEqual(branches[1], {
        AND: [{ projectId: null }, { estimate: { projectId: null } }],
    });
    assert.deepEqual(branches[2], {
        AND: [
            { projectId: null },
            { estimate: { projectId: { not: null } } },
            { NOT: { estimate: { projectId: "overhead-1" } } },
        ],
    });
});

// ── a credit SUBTRACTS from the filing (Codex round 17, item 1) ──

test("a return nets against the purchases in the same month", () => {
    // The excise deduction is the cost of articles actually resold. Material
    // that went back to the store was not resold, and the credit carries the
    // tax back with it, so it belongs in the total as a subtraction rather than
    // being excluded and leaving the deduction overstated.
    const purchase = row({
        id: "buy", dayKey: "2026-09-04",
        receiptTotalCents: 20774, deductionBaseCents: 19119, taxCents: 1655,
    });
    const credit = row({
        id: "return", dayKey: "2026-09-11",
        receiptTotalCents: -5000, deductionBaseCents: -4600, taxCents: -400,
    });
    const { summary, months } = groupTaxAtSource([purchase, credit]);
    assert.equal(summary.count, 2);
    assert.equal(summary.taxCents, 1255, "1655 - 400");
    assert.equal(summary.deductionBaseCents, 14519, "19119 - 4600");
    assert.equal(summary.receiptTotalCents, 15774);
    assert.equal(months.length, 1, "same month, one group");
    assert.equal(months[0].taxCents, 1255);
});
