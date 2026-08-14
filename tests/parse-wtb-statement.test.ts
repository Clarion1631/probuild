import assert from "node:assert/strict";
import test from "node:test";
import {
    parseStatementMeta,
    resolveYear,
    findColumnBandsByPage,
    parseActivityRows,
    stripPageBoilerplate,
    parseChecksPosted,
} from "../scripts/parse-wtb-statement.mjs";

// Fixture note: none of this is real Golden Touch financial data. It's a
// small synthetic statement built to the same row/column geometry pdfjs-dist
// reports for the real WTB PDFs (Additions right-edge≈472.66, Subtractions
// right-edge≈579.58; amount right-aligns to the FIRST row of a wrapped
// transaction, continuation rows have no date/money) — see
// scripts/parse-wtb-statement.mjs for how that geometry was derived from the
// real statements. Column bands are calibrated per page from each item's
// RIGHT edge (x + width), not its left x position, so fixture items only
// need `right` set on the header cells and on money-shaped tokens.

interface Item { str: string; right?: number }
function row(items: Item[], page = 1) {
    return { items, text: items.map(i => i.str).join(" "), page };
}

const HEADER_ROW = row([
    { str: "Date" },
    { str: "Description" },
    { str: "Additions", right: 472.66 },
    { str: "Subtractions", right: 579.58 },
]);
const BANDS_BY_PAGE = findColumnBandsByPage([HEADER_ROW]);

const MONTH_YEAR = new Map([[3, 2026], [4, 2026]]);

test("parseStatementMeta", async t => {
    const text = [
        "SUMMARY OF ACCOUNTS",
        "Product Name Account Number Ending Balance",
        "SMART BUSINESS CHECKING 9998887777 $1,234.56",
        "CHECKING ACCOUNTS",
        "SMART BUSINESS CHECKING Account #9998887777",
        "Beginning Balance $1,000.00",
        "+ Deposits/Credits (2) $500.00",
        "- Checks/Debits (3) $265.44",
        "- Service Charge $0.00",
        "+ Interest Paid $0.00",
        "Ending Balance $1,234.56",
        "Statement of Account",
        "March 2,2026",
        "April 1,2026",
        "9998887777",
        "30",
        "1 of 2",
    ].join("\n");

    await t.test("extracts account number and balances", () => {
        const meta = parseStatementMeta(text);
        assert.equal(meta.accountNumber, "9998887777");
        assert.equal(meta.beginningBalanceCents, 100000);
        assert.equal(meta.endingBalanceCents, 123456);
    });

    await t.test("extracts deposit/debit statement totals", () => {
        const meta = parseStatementMeta(text);
        assert.deepEqual(meta.statementDeposits, { count: 2, totalCents: 50000 });
        assert.deepEqual(meta.statementDebits, { count: 3, totalCents: 26544 });
    });

    await t.test("builds a month->year map from the statement period", () => {
        const meta = parseStatementMeta(text);
        assert.equal(meta.monthYear.get(3), 2026);
        assert.equal(meta.monthYear.get(4), 2026);
    });

    await t.test("throws when the account number is missing", () => {
        assert.throws(() => parseStatementMeta("nothing useful here"));
    });
});

test("resolveYear", async t => {
    await t.test("resolves a month within the statement period", () => {
        assert.equal(resolveYear(MONTH_YEAR, 3), 2026);
        assert.equal(resolveYear(MONTH_YEAR, 4), 2026);
    });

    await t.test("throws loudly for a month outside the statement period", () => {
        assert.throws(() => resolveYear(MONTH_YEAR, 7), /falls outside the statement period/);
    });
});

test("findColumnBandsByPage", async t => {
    await t.test("returns a page -> Additions/Subtractions right-edge Map", () => {
        const bands = findColumnBandsByPage([HEADER_ROW]);
        assert.deepEqual(bands.get(1), { additionsRight: 472.66, subtractionsRight: 579.58 });
    });

    await t.test("throws loudly when no page's header row can be found", () => {
        assert.throws(() => findColumnBandsByPage([row([{ str: "nothing" }])]));
    });
});

test("stripPageBoilerplate", async t => {
    await t.test("removes the recurring per-page footer/header block between two transactions", () => {
        const rows = [
            row([{ str: "3/02" }, { str: "FIRST VENDOR" }, { str: "10.00", right: 579.1 }]),
            row([{ str: "Statement of Account" }]),
            row([{ str: "March 2,2026" }]),
            row([{ str: "April 1,2026" }]),
            row([{ str: "9998887777" }]),
            row([{ str: "30" }]),
            row([{ str: "1 of 2" }]),
            row([{ str: "Activity in Date Order" }]),
            HEADER_ROW,
            row([{ str: "3/03" }, { str: "SECOND VENDOR" }, { str: "20.00", right: 579.1 }]),
        ];
        const stripped = stripPageBoilerplate(rows);
        assert.deepEqual(stripped.map(r => r.text), [
            "3/02 FIRST VENDOR 10.00",
            "3/03 SECOND VENDOR 20.00",
        ]);
    });

    await t.test("passes rows through unchanged when there is no boilerplate block", () => {
        const rows = [row([{ str: "3/02" }, { str: "X" }, { str: "1.00", right: 579.1 }])];
        assert.deepEqual(stripPageBoilerplate(rows), rows);
    });
});

test("parseActivityRows", async t => {
    await t.test("parses a single-row transaction (short description + amount on the same row)", () => {
        const rows = [row([{ str: "3/02" }, { str: "DEPOSIT" }, { str: "500.00", right: 472.3 }])];
        const lines = parseActivityRows(rows, MONTH_YEAR, BANDS_BY_PAGE);
        assert.equal(lines.length, 1);
        assert.deepEqual(lines[0], {
            postedDate: "2026-03-02",
            amountCents: 50000,
            rawDescriptor: "DEPOSIT",
            checkNumber: null,
        });
    });

    await t.test("credit column (right edge near Additions) is positive; debit column (right edge near Subtractions) is negative", () => {
        const rows = [
            row([{ str: "3/02" }, { str: "REFUND CO" }, { str: "12.34", right: 471.9 }]),
            row([{ str: "3/03" }, { str: "VENDOR CO" }, { str: "56.78", right: 579.9 }]),
        ];
        const lines = parseActivityRows(rows, MONTH_YEAR, BANDS_BY_PAGE);
        assert.equal(lines[0].amountCents, 1234);
        assert.equal(lines[1].amountCents, -5678);
    });

    await t.test("appends continuation rows (no date, no money) to the transaction that opened them", () => {
        // Mirrors the real WTB layout: the amount sits on the FIRST row of
        // the block, and further description lines wrap below it.
        const rows = [
            row([{ str: "3/05" }, { str: "ACME SUPPLY CO #123 MAIN ST POS" }, { str: "25.36", right: 579.2 }]),
            row([{ str: "DEB 1234 03/04/26 00012345 ANYTOWN" }]),
            row([{ str: "C#1234" }]),
        ];
        const lines = parseActivityRows(rows, MONTH_YEAR, BANDS_BY_PAGE);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].rawDescriptor, "ACME SUPPLY CO #123 MAIN ST POS DEB 1234 03/04/26 00012345 ANYTOWN C#1234");
        assert.equal(lines[0].amountCents, -2536);
    });

    await t.test("finalizes a still-open multi-row transaction once the NEXT date row starts", () => {
        const rows = [
            row([{ str: "3/05" }, { str: "FIRST" }, { str: "1.00", right: 472.5 }]),
            row([{ str: "MORE TEXT" }]),
            row([{ str: "3/06" }, { str: "SECOND" }, { str: "2.00", right: 472.5 }]),
        ];
        const lines = parseActivityRows(rows, MONTH_YEAR, BANDS_BY_PAGE);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].rawDescriptor, "FIRST MORE TEXT");
        assert.equal(lines[1].rawDescriptor, "SECOND");
    });

    await t.test("finalizes the last open transaction at the end of the row list", () => {
        const rows = [row([{ str: "3/05" }, { str: "LAST ONE" }, { str: "9.99", right: 472.5 }])];
        const lines = parseActivityRows(rows, MONTH_YEAR, BANDS_BY_PAGE);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].rawDescriptor, "LAST ONE");
    });

    await t.test("ignores rows encountered while no record is open", () => {
        const rows = [row([{ str: "stray boilerplate text" }])];
        assert.deepEqual(parseActivityRows(rows, MONTH_YEAR, BANDS_BY_PAGE), []);
    });

    await t.test("throws when a date-opening row never carries an amount, rather than mis-attributing a later amount to it", () => {
        // Design intent (see the module comment above parseActivityRows): a
        // date row with no in-band amount is a structural surprise and
        // aborts loudly rather than silently dropping the row.
        const rows = [
            row([{ str: "3/05" }, { str: "NO AMOUNT HERE" }]),
            row([{ str: "3/06" }, { str: "REAL ONE" }, { str: "3.00", right: 472.5 }]),
        ];
        assert.throws(
            () => parseActivityRows(rows, MONTH_YEAR, BANDS_BY_PAGE),
            /opens a transaction with no amount inside a calibrated column band/,
        );
    });

    await t.test("sub-dollar amounts with no leading zero (\".54\") parse correctly", () => {
        const rows = [row([{ str: "3/06" }, { str: "TINY FEE" }, { str: ".54", right: 579.5 }])];
        const lines = parseActivityRows(rows, MONTH_YEAR, BANDS_BY_PAGE);
        assert.equal(lines[0].amountCents, -54);
    });
});

test("parseChecksPosted", async t => {
    await t.test("parses one check per line", () => {
        const blob = "Checks Posted\nCheck No Date Amount\n1024 3/17 4,000.00\n";
        const lines = parseChecksPosted(blob, MONTH_YEAR);
        assert.deepEqual(lines, [{
            postedDate: "2026-03-17",
            amountCents: -400000,
            rawDescriptor: "Check #1024",
            checkNumber: "1024",
        }]);
    });

    await t.test("parses two side-by-side checks on the same line (older statement layout)", () => {
        const blob = "1003 3/17 2,400.00 1004 3/23 3,536.00";
        const lines = parseChecksPosted(blob, MONTH_YEAR);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].checkNumber, "1003");
        assert.equal(lines[0].amountCents, -240000);
        assert.equal(lines[1].checkNumber, "1004");
        assert.equal(lines[1].amountCents, -353600);
    });

    await t.test("strips the trailing '*' gap-in-sequence marker from the check number", () => {
        const blob = "1012* 4/13 2,088.27";
        const lines = parseChecksPosted(blob, MONTH_YEAR);
        assert.equal(lines[0].checkNumber, "1012");
        assert.equal(lines[0].amountCents, -208827);
    });

    await t.test("ignores the footer line without producing a spurious record", () => {
        const blob = "* Denotes gap in check sequence Total Checks = $5,936.00";
        assert.deepEqual(parseChecksPosted(blob, MONTH_YEAR), []);
    });
});
