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
 * Quote and neutralize one TEXT cell. Always quoted, so an embedded comma,
 * quote, or newline is safe too.
 */
export function csvCell(value: unknown): string {
    if (value === null || value === undefined) return '""';
    const raw = String(value);
    const neutralized = FORMULA_TRIGGER.test(raw) ? `'${raw}` : raw;
    return `"${neutralized.replace(/"/g, '""')}"`;
}

/**
 * A NUMERIC cell, emitted unquoted so the spreadsheet reads it as a number.
 *
 * Safe without neutralizing because the output shape is produced here, not
 * echoed from input: `toFixed` on a finite number can only ever yield
 * `-?\d+\.\d*`, which no spreadsheet parses as a formula. A non-finite value
 * becomes an empty cell rather than "NaN", which would silently poison a SUM.
 */
export function csvNumber(value: number, digits = 2): string {
    return Number.isFinite(value) ? value.toFixed(digits) : "";
}

/** Join rows with CRLF and a trailing terminator, per RFC 4180. */
export function csvDocument(rows: string[][]): string {
    return rows.map(cells => cells.join(",")).join("\r\n") + "\r\n";
}
