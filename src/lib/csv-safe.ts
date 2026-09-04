// CSV cells that are safe to open in a spreadsheet.
//
// RFC 4180 quoting is only half the problem. Excel, LibreOffice, and Google
// Sheets all treat a cell whose text begins with `=`, `+`, `-`, `@`, TAB, or CR
// as a FORMULA, so a vendor named `=cmd|'/c calc'!A1` — or, far more likely
// around here, a description a person typed starting with a minus sign —
// executes or errors when Marge opens the export. The data came from receipts
// and free-text fields, so this is not hypothetical input.
//
// The fix is the standard one: prefix a single quote, which spreadsheets read
// as "the rest of this cell is literal text" and strip from the display.
//
// NOTE: src/lib/sales-tax-report.ts has its own `escapeCsv` that quotes but
// does NOT neutralize formulas. Same gap, pre-existing, and out of scope for
// the change that added this file — flagged rather than silently rewritten.

/**
 * A leading character a spreadsheet will read as the start of a formula.
 * `-` is included deliberately even though `-12.50` is a harmless negative
 * number: `-1+1` is not, and a text cell has no business starting with either.
 * Numbers are emitted by `csvNumber` instead, which is exempt for that reason.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Leading whitespace (including a newline or a BOM) is INVISIBLE to a reviewer
 * and is stripped by the spreadsheet before it decides whether the cell is a
 * formula — so `" =1+1"` is every bit as live as `"=1+1"`, while sailing past a
 * naive first-character check. The lead test runs on the trimmed value; the
 * value itself is emitted UNCHANGED apart from the prefix, because the
 * whitespace is data and silently trimming it would edit the export.
 */
function startsFormula(value: string): boolean {
    // BOTH forms. The trimmed check alone would stop treating a bare leading
    // TAB as dangerous — TAB is itself a trigger, and it is also whitespace, so
    // trimming makes it disappear before the test can see it.
    return FORMULA_TRIGGER.test(value) || FORMULA_TRIGGER.test(value.replace(/^[\s﻿]+/, ""));
}

/**
 * Quote and neutralize one TEXT cell. Always quoted, so an embedded comma,
 * quote, or newline is safe too.
 */
export function csvCell(value: unknown): string {
    if (value === null || value === undefined) return '""';
    const raw = String(value);
    const neutralized = startsFormula(raw) ? `'${raw}` : raw;
    return `"${neutralized.replace(/"/g, '""')}"`;
}

const fixedFormatters = new Map<number, Intl.NumberFormat>();

/**
 * Fixed-point, never exponent notation.
 *
 * `Number.prototype.toFixed` switches to exponent form at 1e21 — `"1e+21"` in a
 * CSV is read as text by some spreadsheets and as a broken number by others,
 * and either way it stops being a figure anyone can sum. `Intl.NumberFormat`
 * with grouping off always writes the digits out.
 */
function fixedPoint(value: number, digits: number): string {
    let formatter = fixedFormatters.get(digits);
    if (!formatter) {
        formatter = new Intl.NumberFormat("en-US", {
            useGrouping: false,
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        });
        fixedFormatters.set(digits, formatter);
    }
    return formatter.format(value);
}

/**
 * A NUMERIC cell, emitted unquoted so the spreadsheet reads it as a number.
 *
 * Accepts anything numeric-shaped — a plain number, a boxed Number, or a Prisma
 * Decimal — because a caller handing this a Decimal is the likeliest mistake
 * and `Decimal.toFixed` is NOT `Number.prototype.toFixed`. Everything is
 * normalized through `Number(String(value))` first.
 *
 * Safe without neutralizing because the output shape is produced here, not
 * echoed from input: fixed-point formatting of a finite number can only ever
 * yield `-?\d+\.\d*`, which no spreadsheet parses as a formula. A non-finite or
 * unparseable value becomes an empty cell rather than "NaN", which would
 * silently poison a SUM.
 */
export function csvNumber(value: unknown, digits = 2): string {
    if (typeof value !== "number") {
        // `Number("")` is 0, so a null/blank source would print "0.00" — a
        // fabricated figure in a tax export, and one that sums as if it were
        // measured. Absent stays absent.
        const text = String(value ?? "").trim();
        if (!text) return "";
        const parsed = Number(text);
        return Number.isFinite(parsed) ? fixedPoint(parsed, digits) : "";
    }
    return Number.isFinite(value) ? fixedPoint(value, digits) : "";
}

/** Join rows with CRLF and a trailing terminator, per RFC 4180. */
export function csvDocument(rows: string[][]): string {
    return rows.map(cells => cells.join(",")).join("\r\n") + "\r\n";
}
