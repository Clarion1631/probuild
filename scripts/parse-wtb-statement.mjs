// Local parser for Washington Trust Bank statement PDFs (Receipt Automation
// Phase 1, docs/RECEIPT-AUTOMATION-PHASES.md "Persistence decision" + Codex
// peer-review round-1 amendments). Runs on Justin's machine — reads a WTB
// statement PDF, extracts one transaction per bank activity line (date,
// description, signed amount) plus the "Checks Posted" section, and either
// prints NDJSON or POSTs the WHOLE statement as one request to the
// bank-ledger ingest endpoint. This script deliberately does NOT normalize
// payees — the ingest endpoint (src/lib/bank-ledger.ts) is the single writer
// responsible for that, so retries and re-parses stay on one code path.
//
// Usage:
//   node scripts/parse-wtb-statement.mjs <statement.pdf> [--dry-run]
//   node scripts/parse-wtb-statement.mjs <statement.pdf> --post <url>
//   node scripts/parse-wtb-statement.mjs <statement.pdf> --account WTB-0723
//
// --post reads the ingest key from BANK_LEDGER_INGEST_SECRET or INGEST_KEY
// in the environment — never a CLI flag, which would land the secret in
// shell history and process listings.
//
// --dry-run prints a summary and every control-total gate's pass/fail and
// does not emit NDJSON or POST anything.
//
// Every gate runs in every mode, not just --dry-run: if any fails, the
// script refuses to emit NDJSON or POST (exits 1) rather than shipping data
// it can't vouch for. A balanced net total alone does NOT prove correctness
// — a swapped sign on one $50 debit and an omitted $50 credit elsewhere
// still nets to zero — so every printed statement control total is checked
// independently:
//   - beginning balance + net(all parsed lines) == ending balance
//   - parsed credit-line count/total == the statement's own
//     "+ Deposits/Credits (N) $X" figure
//   - parsed debit-line count/total (activity-table subtractions AND
//     checks, matching how WTB rolls them into one figure) == the
//     statement's own "- Checks/Debits (N) $X" figure
//   - parsed check-line total == the statement's own "Total Checks = $X"
//     footer, when the statement has one (a zero-check period, e.g.
//     2026-02, omits the "Checks Posted" section and this footer entirely)
//
// Debit/credit sign: the "Activity in Date Order" table's plain-text
// extraction has no reliable way to tell an Additions-column amount from a
// Subtractions-column one — an early version of this script guessed from
// vendor keywords (DEPOSIT, POS CRE, ...), but real statements disproved
// that approach: "TRANSFER STRIPE" is a credit in one month's statement and
// a debit in another's, so no keyword list can be correct in general. This
// version instead reads each amount's actual position on the page (via
// pdfjs-dist, the engine pdf-parse itself wraps) and compares its RIGHT edge
// (x + item width) against the Additions/Subtractions column headers' right
// edges — the amount columns are right-aligned, so the right edge stays
// essentially constant (observed variance <0.2pt across all 7 real
// statements and every page) while the left edge shifts with the number of
// digits ("300.00" vs "10,880.00"). Column bands are calibrated PER PAGE
// (not once from the first page and reused) since a header repeats on every
// page of the activity table and layout drift, if it ever happens, would
// only affect the pages it touches.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

function parseArgs(argv) {
    const args = { pdfPath: null, dryRun: false, post: null, account: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") args.dryRun = true;
        else if (arg === "--post") args.post = argv[++i];
        else if (arg === "--account") args.account = argv[++i];
        else if (!arg.startsWith("--") && !args.pdfPath) args.pdfPath = arg;
    }
    return args;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

/** True Gregorian-calendar validation (duplicated from src/lib/bank-ledger.ts — this script runs under plain `node`, not the TS toolchain, so a shared import isn't available). */
function isValidCalendarDate(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toIsoDate(year, month, day) {
    if (!isValidCalendarDate(year, month, day)) {
        throw new Error(`Structural surprise: "${year}-${pad2(month)}-${pad2(day)}" is not a real calendar date`);
    }
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

const MONTH_NAMES = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** "July 1,2026" -> { year: 2026, month: 7, day: 1 }, validated as a real calendar date. */
function parseCalendarDate(str) {
    const match = str.match(/^([A-Za-z]+)\s+(\d{1,2}),(\d{4})$/);
    if (!match) throw new Error(`Could not parse statement date "${str}"`);
    const month = MONTH_NAMES[match[1].toLowerCase()];
    if (!month) throw new Error(`Unknown month name in "${str}"`);
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (!isValidCalendarDate(year, month, day)) throw new Error(`"${str}" is not a real calendar date`);
    return { year, month, day };
}

function dollarsToCents(str) {
    return Math.round(Number(str.replace(/,/g, "")) * 100);
}

/**
 * Extracts statement-level metadata (account number, opening/closing
 * balance, deposit/debit/check control totals, and the statement's
 * start/end date — needed to resolve the bare M/D dates in the activity
 * table to a full calendar date) from the "SUMMARY OF ACCOUNTS" /
 * "CHECKING ACCOUNTS" / "Statement of Account" / "Checks Posted" header text.
 *
 * Every control total WTB actually prints is MANDATORY here — if the
 * format ever stops matching (a template change, an OCR artifact, ...) this
 * throws rather than silently downgrading that gate to "not checked" in
 * evaluateGates(). Verified against all 7 real WTB statements in
 * I:\My Drive\Claude\Bookeeping\WTB\ (2026-02 through 2026-08):
 *   - "+ Deposits/Credits (N) $X" and "- Checks/Debits (N) $X" print on
 *     EVERY one of the 7 — mandatory, unconditional.
 *   - "Total Checks = $X" prints on every statement that has a "Checks
 *     Posted" section — i.e. every period with at least one check. Exactly
 *     one of the 7 (2026-02) has zero checks that period and omits BOTH the
 *     "Checks Posted" section and "Total Checks =" footer entirely, so that
 *     control is only mandatory when "Checks Posted" is present in the text
 *     — a genuinely proven absence, not an assumed one.
 *   - WTB never prints a check COUNT anywhere (only the dollar total) in
 *     any of the 7 statements — confirmed by inspecting the raw "Checks
 *     Posted" section text on every one, including the 238-line 2026-08
 *     statement's two-page checks table. There is no count to gate on.
 */
export function parseStatementMeta(text) {
    const accountMatch = text.match(/Account #(\d+)/);
    if (!accountMatch) throw new Error("Could not find account number (\"Account #...\")");
    const accountNumber = accountMatch[1];

    const beginningMatch = text.match(/Beginning Balance\s*\$([\d,]+\.\d{2})/);
    const endingMatch = text.match(/Ending Balance\s*\$([\d,]+\.\d{2})/);
    if (!beginningMatch || !endingMatch) throw new Error("Could not find Beginning/Ending Balance");
    const beginningBalanceCents = dollarsToCents(beginningMatch[1]);
    const endingBalanceCents = dollarsToCents(endingMatch[1]);

    const depositsMatch = text.match(/\+\s*Deposits\/Credits\s*\((\d+)\)\s*\$([\d,]+\.\d{2})/);
    if (!depositsMatch) throw new Error("Could not find \"+ Deposits/Credits (N) $X\" control total — mandatory on every real WTB statement");
    const statementDeposits = { count: Number(depositsMatch[1]), totalCents: dollarsToCents(depositsMatch[2]) };

    const debitsMatch = text.match(/-\s*Checks\/Debits\s*\((\d+)\)\s*\$([\d,]+\.\d{2})/);
    if (!debitsMatch) throw new Error("Could not find \"- Checks/Debits (N) $X\" control total — mandatory on every real WTB statement");
    const statementDebits = { count: Number(debitsMatch[1]), totalCents: dollarsToCents(debitsMatch[2]) };

    // "Total Checks = $X" is mandatory ONLY when the statement has a "Checks
    // Posted" section at all — a period with zero checks omits both
    // entirely (proven against the real 2026-02 statement), so its absence
    // there is a verified structural fact, not a silently-skipped gate.
    const hasChecksSection = /Checks Posted/.test(text);
    const totalChecksMatch = text.match(/Total Checks\s*=\s*\$([\d,]+\.\d{2})/);
    if (hasChecksSection && !totalChecksMatch) {
        throw new Error("Found a \"Checks Posted\" section but no \"Total Checks = $X\" footer — mandatory control total is missing");
    }
    const checksTotalCents = totalChecksMatch ? dollarsToCents(totalChecksMatch[1]) : null;

    const periodMatch = text.match(
        /Statement of Account\s*\n([A-Za-z]+ \d{1,2},\d{4})\s*\n([A-Za-z]+ \d{1,2},\d{4})/,
    );
    if (!periodMatch) throw new Error("Could not find statement period (\"Statement of Account\" block)");
    const start = parseCalendarDate(periodMatch[1]);
    const end = parseCalendarDate(periodMatch[2]);

    const monthYear = new Map([[start.month, start.year], [end.month, end.year]]);

    return {
        accountNumber,
        beginningBalanceCents,
        endingBalanceCents,
        statementDeposits,
        statementDebits,
        checksTotalCents,
        monthYear,
        periodStart: toIsoDate(start.year, start.month, start.day),
        periodEnd: toIsoDate(end.year, end.month, end.day),
    };
}

export function resolveYear(monthYear, month) {
    const year = monthYear.get(month);
    if (year === undefined) {
        throw new Error(
            `Transaction month ${month} falls outside the statement period ` +
            `(spans months ${[...monthYear.keys()].join(", ")}) — statement period detection is wrong`,
        );
    }
    return year;
}

// "Checks Posted" prints two side-by-side columns of "<checkNo> <M>/<D>
// <amount>" — most statements wrap to one check per line, but older ones
// (e.g. the 2026-02 statement) fit two checks on one line when there are
// only a handful. Match every occurrence on the line rather than anchoring
// the whole line, so both layouts parse the same way. A trailing "*" on the
// check number means "gap in check sequence" (see the table's footnote), not
// part of the number. Checks are always debits — no column ambiguity here.
const CHECK_ROW_PATTERN = /(\d{3,6})\*?\s+(\d{1,2})\/(\d{1,2})\s+([\d,]*\.\d{2})/g;

/** Parses the "Checks Posted" table. */
export function parseChecksPosted(blob, monthYear) {
    const lines = blob.split("\n").map(l => l.trim()).filter(Boolean);
    const records = [];
    for (const line of lines) {
        for (const match of line.matchAll(CHECK_ROW_PATTERN)) {
            const [, checkNumber, month, day, amount] = match;
            const year = resolveYear(monthYear, Number(month));
            records.push({
                postedDate: toIsoDate(year, Number(month), Number(day)),
                amountCents: -dollarsToCents(amount),
                rawDescriptor: `Check #${checkNumber}`,
                checkNumber,
            });
        }
    }
    return records;
}

// Real amounts' right edge (x + pdfjs item width) sits within a fraction of
// a point of the column header's own right edge on every page of every real
// statement observed (Additions right≈472.66, Subtractions right≈579.58,
// >100pt apart) — this tolerance is a generous margin, not a loose one. A
// left-edge threshold (the earlier approach) shifts with the number of
// digits in the amount and was the actual source of fragility.
const COLUMN_TOLERANCE = 3;

/**
 * Calibrates the Additions/Subtractions column right-edges PER PAGE by
 * scanning every page's own header row, rather than reading one page's
 * header once and reusing it for the whole document — a layout shift on any
 * single page (a WTB template change mid-document, a scanned/rotated page,
 * ...) is caught on that page instead of silently misclassifying it against
 * a stale threshold from page 1.
 */
export function findColumnBandsByPage(rows) {
    const bands = new Map();
    for (const row of rows) {
        const additions = row.items.find(i => i.str === "Additions");
        const subtractions = row.items.find(i => i.str === "Subtractions");
        if (additions && subtractions) {
            bands.set(row.page, { additionsRight: additions.right, subtractionsRight: subtractions.right });
        }
    }
    if (bands.size === 0) {
        throw new Error("Could not find Additions/Subtractions column headers on any page to calibrate credit/debit detection");
    }
    return bands;
}

/**
 * Every real statement observed repeats the Additions/Subtractions header on
 * every page of the activity table, so a page reaching classifyRow() with no
 * calibration of its own is a structural surprise — a WTB template change, a
 * scanned/rotated page, or some other layout drift that a stale threshold
 * borrowed from a different page would silently misclassify rather than
 * catch. This never falls back to another page's bands; it aborts.
 */
function bandsForPage(bandsByPage, page) {
    const bands = bandsByPage.get(page);
    if (!bands) {
        throw new Error(`Structural surprise: no column-band calibration found for page ${page} — refusing to reuse another page's bands`);
    }
    return bands;
}

/**
 * Classifies one item as the row's amount IF its right edge falls inside a
 * calibrated column band — an amount-shaped token OUTSIDE both bands (e.g. a
 * numeric descriptor token that happens to look like an amount) is ignored,
 * never mistaken for the transaction amount.
 */
function classifyMoneyItem(item, bands) {
    const distanceToAdditions = Math.abs(item.right - bands.additionsRight);
    const distanceToSubtractions = Math.abs(item.right - bands.subtractionsRight);
    const inAdditions = distanceToAdditions <= COLUMN_TOLERANCE;
    const inSubtractions = distanceToSubtractions <= COLUMN_TOLERANCE;
    if (inAdditions && !inSubtractions) return "credit";
    if (inSubtractions && !inAdditions) return "debit";
    return null;
}

/**
 * Splits a reconstructed row into its date (if the row opens a new
 * transaction), its money amount + column (if the row closes one, and only
 * if that amount falls inside a calibrated column band), and the remaining
 * description text. More than one in-band amount candidate on the same row
 * is a structural surprise and aborts loudly rather than guessing.
 */
function classifyRow(row, bands) {
    const items = [...row.items];
    let dateInfo = null;
    if (items.length && /^\d{1,2}\/\d{1,2}$/.test(items[0].str)) {
        const [month, day] = items[0].str.split("/").map(Number);
        dateInfo = { month, day };
        items.shift();
    }

    const candidates = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!/^-?[\d,]*\.\d{2}$/.test(item.str)) continue;
        const column = classifyMoneyItem(item, bands);
        if (column) candidates.push({ index: i, item, column });
    }

    if (candidates.length > 1) {
        throw new Error(
            `Structural surprise: ${candidates.length} amounts fall inside a calibrated column band on the same row ("${row.text}")`,
        );
    }

    let money = null;
    if (candidates.length === 1) {
        const { index, item, column } = candidates[0];
        money = { amountCents: Math.round(Math.abs(Number(item.str.replace(/,/g, ""))) * 100), isCredit: column === "credit" };
        items.splice(index, 1);
    }

    return { dateInfo, money, text: items.map(i => i.str).join(" ").trim() };
}

/**
 * Drops the recurring per-page footer/header block ("Statement of
 * Account" / period dates / account number / day count / page number /
 * "Activity in Date Order" / the column-header row) that WTB prints between
 * every page of the activity table. Without this, a transaction whose last
 * continuation row falls at the bottom of a page would swallow the next
 * page's boilerplate as if it were more of its own description — a
 * transaction only finalizes when the FOLLOWING date-opening row is seen
 * (see parseActivityRows), so anything sitting between page breaks has to be
 * removed up front rather than filtered token-by-token during the scan.
 */
export function stripPageBoilerplate(rows) {
    const out = [];
    let skipping = false;
    for (const row of rows) {
        if (row.text === "Statement of Account") {
            skipping = true;
            continue;
        }
        if (skipping) {
            if (row.text === "Date Description Additions Subtractions") skipping = false;
            continue;
        }
        out.push(row);
    }
    return out;
}

/**
 * Parses the "Activity in Date Order" table from row/column-reconstructed
 * items (see extractPositionedRows). Every transaction's amount is printed
 * on the SAME row/baseline as its date and the first line of its
 * description — even when the description wraps to further rows below
 * (WTB right-aligns the amount to the top of the row block, not the
 * bottom) — so a row is: "M/D <description-part-1> <amount>", optionally
 * followed by continuation rows carrying more description text (no date, no
 * amount) that belong to that same transaction. A transaction only
 * finalizes once the NEXT date-opening row (or the end of the table) is
 * reached, since trailing continuation rows must still be appended to it.
 * Rows encountered while no record is open (page footers, the repeated
 * "Activity in Date Order" / column-header rows, the mailing letterhead on
 * page 1) are silently ignored — but a date row with no in-band amount, or
 * an in-band amount with no open date, is a structural surprise and aborts
 * loudly rather than silently dropping or mis-attributing data.
 */
export function parseActivityRows(rows, monthYear, bandsByPage) {
    const records = [];
    let current = null;

    const finalize = () => {
        if (!current) return;
        const rawDescriptor = current.descParts.join(" ").replace(/\s+/g, " ").trim();
        const year = resolveYear(monthYear, current.month);
        records.push({
            postedDate: toIsoDate(year, current.month, current.day),
            amountCents: current.money.isCredit ? current.money.amountCents : -current.money.amountCents,
            rawDescriptor,
            checkNumber: null,
        });
        current = null;
    };

    for (const row of rows) {
        const bands = bandsForPage(bandsByPage, row.page);
        const { dateInfo, money, text } = classifyRow(row, bands);

        if (dateInfo) {
            finalize();
            if (!money) {
                throw new Error(
                    `Structural surprise: date row "${row.text}" opens a transaction with no amount inside a calibrated column band`,
                );
            }
            current = { month: dateInfo.month, day: dateInfo.day, money, descParts: text ? [text] : [] };
        } else if (money) {
            throw new Error(
                `Structural surprise: row "${row.text}" carries an amount inside a calibrated column band but no opening date`,
            );
        } else if (current && text) {
            current.descParts.push(text);
        }
        // else: no open record and no money — boilerplate/header noise, ignored.
    }
    finalize();

    return records;
}

/**
 * Reads every page's text items via pdfjs-dist directly (bypassing
 * pdf-parse's line-flattened text) and reconstructs rows by grouping items
 * that share a baseline y-coordinate, sorted left-to-right within the row
 * and top-to-bottom across the document. Each row keeps its items' x
 * position AND right edge (x + pdfjs item width) plus its page number, so
 * callers can calibrate column bands per page and classify amounts by
 * right-edge alignment.
 */
export async function extractPositionedRows(pdfPath) {
    const buffer = await readFile(pdfPath);
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
    const rows = [];
    try {
        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
            const page = await doc.getPage(pageNum);
            const content = await page.getTextContent();
            const byY = new Map();
            for (const item of content.items) {
                const str = item.str.trim();
                if (!str) continue;
                const x = item.transform[4];
                const y = Math.round(item.transform[5] * 10) / 10;
                const right = x + item.width;
                if (!byY.has(y)) byY.set(y, []);
                byY.get(y).push({ str, x, right });
            }
            const ys = [...byY.keys()].sort((a, b) => b - a); // top to bottom
            for (const y of ys) {
                const items = byY.get(y).sort((a, b) => a.x - b.x);
                rows.push({ items, text: items.map(i => i.str).join(" "), page: pageNum });
            }
        }
    } finally {
        if (typeof doc.destroy === "function") await doc.destroy();
    }
    return rows;
}

function fmt(cents) {
    return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * Checks every printed statement control total independently — a balanced
 * net total alone does not prove the ledger is right (see the module
 * comment for the offsetting-error case). Returns every failure, not just
 * the first, so a --dry-run report is actionable in one pass.
 */
export function evaluateGates(meta, lines) {
    const failures = [];

    const totalDebitCents = lines.filter(l => l.amountCents < 0).reduce((sum, l) => sum + l.amountCents, 0);
    const totalCreditCents = lines.filter(l => l.amountCents > 0).reduce((sum, l) => sum + l.amountCents, 0);
    const netCents = totalDebitCents + totalCreditCents;
    const expectedEndingCents = meta.beginningBalanceCents + netCents;

    if (expectedEndingCents !== meta.endingBalanceCents) {
        failures.push({
            gate: "balance",
            detail: `beginning ${fmt(meta.beginningBalanceCents)} + net ${fmt(netCents)} = ${fmt(expectedEndingCents)}, ` +
                `statement says ending ${fmt(meta.endingBalanceCents)} (off by ${fmt(meta.endingBalanceCents - expectedEndingCents)})`,
        });
    }

    // statementDeposits/statementDebits are mandatory fields on `meta` as of
    // parseStatementMeta (it throws rather than let either come back null) —
    // these two gates always run, never conditionally skipped.
    const creditLines = lines.filter(l => l.amountCents > 0);
    if (creditLines.length !== meta.statementDeposits.count) {
        failures.push({
            gate: "deposits-count",
            detail: `parsed ${creditLines.length} credit line(s), statement says ${meta.statementDeposits.count}`,
        });
    }
    if (totalCreditCents !== meta.statementDeposits.totalCents) {
        failures.push({
            gate: "deposits-total",
            detail: `parsed credits total ${fmt(totalCreditCents)}, statement says ${fmt(meta.statementDeposits.totalCents)}`,
        });
    }

    const debitLines = lines.filter(l => l.amountCents < 0);
    if (debitLines.length !== meta.statementDebits.count) {
        failures.push({
            gate: "debits-count",
            detail: `parsed ${debitLines.length} debit line(s), statement says ${meta.statementDebits.count}`,
        });
    }
    if (-totalDebitCents !== meta.statementDebits.totalCents) {
        failures.push({
            gate: "debits-total",
            detail: `parsed debits total ${fmt(-totalDebitCents)}, statement says ${fmt(meta.statementDebits.totalCents)}`,
        });
    }

    // checksTotalCents is legitimately null for a verified zero-check period
    // (see parseStatementMeta) — that is the ONLY reason it's ever null, so
    // skipping the gate here is not "skip on parse failure", it's "skip
    // because there is provably nothing to check".
    if (meta.checksTotalCents !== null) {
        const checkLines = lines.filter(l => l.checkNumber !== null);
        const checksTotalCents = -checkLines.reduce((sum, l) => sum + l.amountCents, 0);
        if (checksTotalCents !== meta.checksTotalCents) {
            failures.push({
                gate: "checks-total",
                detail: `parsed checks total ${fmt(checksTotalCents)}, statement says Total Checks = ${fmt(meta.checksTotalCents)}`,
            });
        }
    }

    return { ok: failures.length === 0, failures, totals: { totalDebitCents, totalCreditCents, expectedEndingCents } };
}

async function postStatement(url, key, account, meta, lines) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": key },
        body: JSON.stringify({
            source: "STATEMENT",
            account,
            periodStart: meta.periodStart,
            periodEnd: meta.periodEnd,
            openingCents: meta.beginningBalanceCents,
            closingCents: meta.endingBalanceCents,
            lines,
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Ingest POST failed (${res.status}): ${JSON.stringify(body)}`);
    return body;
}

/** Full parse of a statement PDF: metadata + activity table + checks, all from the same positional row extraction. */
export async function parseStatement(pdfPath) {
    const rows = await extractPositionedRows(pdfPath);
    // parseStatementMeta and parseChecksPosted work off a newline-joined text
    // blob (line-oriented regexes) rather than row objects — reconstructing
    // that from the same row extraction keeps everything on one PDF engine
    // instead of mixing in a second library just for the header block.
    const text = rows.map(r => r.text).join("\n");
    const meta = parseStatementMeta(text);

    const bandsByPage = findColumnBandsByPage(rows);
    // "Checks Posted" (and its preceding "AccountNumber=" marker) is omitted
    // entirely on a statement with zero checks that period (e.g. 2026-02-01)
    // — fall back to "Daily Balance Information", which always prints, so
    // the Daily Balance table never gets misread as more activity rows.
    const boundaryIdx = rows.findIndex(r =>
        r.text === "Checks Posted" || r.text.startsWith("AccountNumber=") || r.text === "Daily Balance Information",
    );
    const activityRows = stripPageBoilerplate(boundaryIdx >= 0 ? rows.slice(0, boundaryIdx) : rows);
    const activityLines = parseActivityRows(activityRows, meta.monthYear, bandsByPage);

    const checksStart = text.indexOf("Checks Posted");
    const dailyBalanceStart = text.indexOf("Daily Balance Information");
    let checkLines = [];
    if (checksStart >= 0) {
        const checksEnd = dailyBalanceStart >= 0 ? dailyBalanceStart : text.length;
        checkLines = parseChecksPosted(text.slice(checksStart, checksEnd), meta.monthYear);
    }

    const lines = [...activityLines, ...checkLines].sort((a, b) => a.postedDate.localeCompare(b.postedDate));
    return { meta, lines };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.pdfPath) {
        console.error("Usage: node scripts/parse-wtb-statement.mjs <statement.pdf> [--dry-run] [--post <url>] [--account <name>]");
        console.error("  --post reads the ingest key from BANK_LEDGER_INGEST_SECRET or INGEST_KEY in the environment.");
        process.exitCode = 1;
        return;
    }

    const { meta, lines } = await parseStatement(args.pdfPath);
    const account = args.account || `WTB-${meta.accountNumber.slice(-4)}`;
    const gates = evaluateGates(meta, lines);

    if (args.dryRun) {
        console.log(`Account:      ${account} (${meta.accountNumber})`);
        console.log(`Period:       ${meta.periodStart} .. ${meta.periodEnd}`);
        console.log(`Lines parsed: ${lines.length}`);
        console.log(`Beginning:    ${fmt(meta.beginningBalanceCents)}`);
        console.log(`Ending:       ${fmt(meta.endingBalanceCents)}`);
        console.log(`Net parsed:   ${fmt(gates.totals.totalDebitCents + gates.totals.totalCreditCents)}`);
        console.log(`Expected end: ${fmt(gates.totals.expectedEndingCents)}`);
        if (meta.statementDeposits) {
            console.log(`Statement says ${meta.statementDeposits.count} deposits/credits totaling ${fmt(meta.statementDeposits.totalCents)}`);
        }
        if (meta.statementDebits) {
            console.log(`Statement says ${meta.statementDebits.count} checks/debits totaling ${fmt(meta.statementDebits.totalCents)}`);
        }
        if (meta.checksTotalCents !== null) {
            console.log(`Statement says Total Checks = ${fmt(meta.checksTotalCents)}`);
        }
        if (gates.ok) {
            console.log("Gates: PASS (balance, deposits count+total, debits count+total, checks total)");
        } else {
            console.log("Gates: FAIL");
            for (const f of gates.failures) console.log(`  - [${f.gate}] ${f.detail}`);
        }
    }

    if (!gates.ok) {
        console.error(`parse-wtb-statement: control-total gate(s) failed for ${args.pdfPath}:`);
        for (const f of gates.failures) console.error(`  - [${f.gate}] ${f.detail}`);
        console.error("Refusing to emit NDJSON or POST.");
        process.exitCode = 1;
        return;
    }

    if (args.dryRun) return;

    const payloadLines = lines.map(({ postedDate, amountCents, rawDescriptor, checkNumber }) => ({
        postedDate,
        amountCents,
        rawDescriptor,
        ...(checkNumber ? { checkNumber } : {}),
    }));

    if (args.post) {
        const key = process.env.BANK_LEDGER_INGEST_SECRET || process.env.INGEST_KEY;
        if (!key) {
            console.error("--post requires BANK_LEDGER_INGEST_SECRET or INGEST_KEY set in the environment (not a CLI flag).");
            process.exitCode = 1;
            return;
        }
        const result = await postStatement(args.post, key, account, meta, payloadLines);
        console.log(JSON.stringify(result));
        return;
    }

    for (const line of payloadLines) {
        process.stdout.write(JSON.stringify(line) + "\n");
    }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
