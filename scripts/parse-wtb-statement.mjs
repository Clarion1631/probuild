// Local parser for Washington Trust Bank statement PDFs (Receipt Automation
// Phase 1, docs/RECEIPT-AUTOMATION-PHASES.md "Persistence decision"). Runs on
// Justin's machine — reads a WTB statement PDF, extracts one transaction per
// bank activity line (date, description, signed amount) plus the "Checks
// Posted" section, and either prints NDJSON or POSTs to the bank-ledger
// ingest endpoint. This script deliberately does NOT normalize payees or
// compute lineHash — the ingest endpoint (src/lib/bank-ledger.ts) is the
// single writer responsible for that, so retries and re-parses stay
// idempotent through one code path.
//
// Usage:
//   node scripts/parse-wtb-statement.mjs <statement.pdf> [--dry-run]
//   node scripts/parse-wtb-statement.mjs <statement.pdf> --post <url> --key <ingestKey>
//   node scripts/parse-wtb-statement.mjs <statement.pdf> --account WTB-0723
//
// --dry-run prints a summary (line count, date range, total debits/credits,
// and a balance check: beginning balance + signed sum == ending balance,
// taken directly from the statement's own "CHECKING ACCOUNTS" totals — this
// PDF format has no per-transaction running balance, only a daily balance
// table and the statement-level opening/closing balance) and does not emit
// NDJSON or POST anything.
//
// The balance check runs in every mode, not just --dry-run: if it fails, the
// script refuses to emit NDJSON or POST (exits 1) rather than shipping data
// it can't vouch for.
//
// Debit/credit sign: the "Activity in Date Order" table's plain-text
// extraction has no reliable way to tell an Additions-column amount from a
// Subtractions-column one — an early version of this script guessed from
// vendor keywords (DEPOSIT, POS CRE, ...), but real statements disproved
// that approach: "TRANSFER STRIPE" is a credit in one month's statement and
// a debit in another's, so no keyword list can be correct in general. This
// version instead reads each amount's actual x-coordinate on the page (via
// pdfjs-dist, the engine pdf-parse itself wraps) and compares it against the
// Additions/Subtractions column header positions — the same signal a human
// reading the PDF uses.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_LINES_PER_POST = 5000;

function parseArgs(argv) {
    const args = { pdfPath: null, dryRun: false, post: null, key: null, account: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") args.dryRun = true;
        else if (arg === "--post") args.post = argv[++i];
        else if (arg === "--key") args.key = argv[++i];
        else if (arg === "--account") args.account = argv[++i];
        else if (!arg.startsWith("--") && !args.pdfPath) args.pdfPath = arg;
    }
    return args;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

const MONTH_NAMES = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseMonthYear(str) {
    // "July 1,2026" -> { month: 7, year: 2026 }
    const match = str.match(/^([A-Za-z]+)\s+(\d{1,2}),(\d{4})$/);
    if (!match) throw new Error(`Could not parse statement date "${str}"`);
    const month = MONTH_NAMES[match[1].toLowerCase()];
    if (!month) throw new Error(`Unknown month name in "${str}"`);
    return { month, year: Number(match[3]) };
}

function dollarsToCents(str) {
    return Math.round(Number(str.replace(/,/g, "")) * 100);
}

/**
 * Extracts statement-level metadata (account number, opening/closing
 * balance, deposit/debit totals, and the statement's start/end month+year —
 * needed to resolve the bare M/D dates in the activity table to a full
 * calendar date) from the "SUMMARY OF ACCOUNTS" / "CHECKING ACCOUNTS" /
 * "Statement of Account" header text.
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
    const debitsMatch = text.match(/-\s*Checks\/Debits\s*\((\d+)\)\s*\$([\d,]+\.\d{2})/);
    const statementDeposits = depositsMatch
        ? { count: Number(depositsMatch[1]), totalCents: dollarsToCents(depositsMatch[2]) }
        : null;
    const statementDebits = debitsMatch
        ? { count: Number(debitsMatch[1]), totalCents: dollarsToCents(debitsMatch[2]) }
        : null;

    const periodMatch = text.match(
        /Statement of Account\s*\n([A-Za-z]+ \d{1,2},\d{4})\s*\n([A-Za-z]+ \d{1,2},\d{4})/,
    );
    if (!periodMatch) throw new Error("Could not find statement period (\"Statement of Account\" block)");
    const start = parseMonthYear(periodMatch[1]);
    const end = parseMonthYear(periodMatch[2]);

    const monthYear = new Map([[start.month, start.year], [end.month, end.year]]);

    return {
        accountNumber,
        beginningBalanceCents,
        endingBalanceCents,
        statementDeposits,
        statementDebits,
        monthYear,
        periodStart: start,
        periodEnd: end,
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
                postedDate: `${year}-${pad2(Number(month))}-${pad2(Number(day))}`,
                amountCents: -dollarsToCents(amount),
                rawDescriptor: `Check #${checkNumber}`,
                checkNumber,
            });
        }
    }
    return records;
}

/**
 * Finds the x-coordinate midpoint between the "Additions" and "Subtractions"
 * column headers — the dividing line used to classify every amount in the
 * table below as a credit or a debit.
 */
export function findColumnThreshold(rows) {
    for (const row of rows) {
        const additions = row.items.find(i => i.str === "Additions");
        const subtractions = row.items.find(i => i.str === "Subtractions");
        if (additions && subtractions) return (additions.x + subtractions.x) / 2;
    }
    throw new Error("Could not find Additions/Subtractions column headers to calibrate credit/debit detection");
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
 * Splits a reconstructed row into its date (if the row opens a new
 * transaction), its money amount + column (if the row closes one), and the
 * remaining description text.
 */
function classifyRow(row, columnThreshold) {
    const items = [...row.items];
    let dateInfo = null;
    if (items.length && /^\d{1,2}\/\d{1,2}$/.test(items[0].str)) {
        const [month, day] = items[0].str.split("/").map(Number);
        dateInfo = { month, day };
        items.shift();
    }
    let money = null;
    const moneyIdx = items.findIndex(i => /^-?[\d,]*\.\d{2}$/.test(i.str));
    if (moneyIdx !== -1) {
        const item = items[moneyIdx];
        money = {
            amountCents: Math.round(Math.abs(Number(item.str.replace(/,/g, ""))) * 100),
            isCredit: item.x < columnThreshold,
        };
        items.splice(moneyIdx, 1);
    }
    return { dateInfo, money, text: items.map(i => i.str).join(" ").trim() };
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
 * page 1) are silently ignored.
 */
export function parseActivityRows(rows, monthYear, columnThreshold) {
    const records = [];
    let current = null;

    const finalize = () => {
        if (!current) return;
        const rawDescriptor = current.descParts.join(" ").replace(/\s+/g, " ").trim();
        const year = resolveYear(monthYear, current.month);
        records.push({
            postedDate: `${year}-${pad2(current.month)}-${pad2(current.day)}`,
            amountCents: current.money.isCredit ? current.money.amountCents : -current.money.amountCents,
            rawDescriptor,
            checkNumber: null,
        });
        current = null;
    };

    for (const row of rows) {
        const { dateInfo, money, text } = classifyRow(row, columnThreshold);

        if (dateInfo) {
            finalize();
            // The opening row always carries the amount alongside the date
            // in this template; if it's ever missing, drop the record
            // rather than silently mis-attribute a later row's amount to it.
            if (money) current = { month: dateInfo.month, day: dateInfo.day, money, descParts: text ? [text] : [] };
        } else if (current && text) {
            current.descParts.push(text);
        }
        // else: no open record — boilerplate/header noise, ignored.
    }
    finalize();

    return records;
}

/**
 * Reads every page's text items via pdfjs-dist directly (bypassing
 * pdf-parse's line-flattened text) and reconstructs rows by grouping items
 * that share a baseline y-coordinate, sorted left-to-right within the row
 * and top-to-bottom across the document. Each row keeps its items' x
 * positions so callers can tell which table column an amount printed in.
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
                if (!byY.has(y)) byY.set(y, []);
                byY.get(y).push({ str, x });
            }
            const ys = [...byY.keys()].sort((a, b) => b - a); // top to bottom
            for (const y of ys) {
                const items = byY.get(y).sort((a, b) => a.x - b.x);
                rows.push({ items, text: items.map(i => i.str).join(" ") });
            }
        }
    } finally {
        if (typeof doc.destroy === "function") await doc.destroy();
    }
    return rows;
}

function summarize(meta, lines) {
    const dates = lines.map(l => l.postedDate).sort();
    const totalDebitCents = lines.filter(l => l.amountCents < 0).reduce((sum, l) => sum + l.amountCents, 0);
    const totalCreditCents = lines.filter(l => l.amountCents > 0).reduce((sum, l) => sum + l.amountCents, 0);
    const netCents = totalDebitCents + totalCreditCents;
    const expectedEndingCents = meta.beginningBalanceCents + netCents;
    const balanceOk = expectedEndingCents === meta.endingBalanceCents;

    return {
        lineCount: lines.length,
        dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : [null, null],
        totalDebitCents,
        totalCreditCents,
        balanceOk,
        beginningBalanceCents: meta.beginningBalanceCents,
        endingBalanceCents: meta.endingBalanceCents,
        expectedEndingCents,
        deltaCents: meta.endingBalanceCents - expectedEndingCents,
    };
}

function fmt(cents) {
    return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function postBatch(url, key, source, account, lines) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": key },
        body: JSON.stringify({ source, account, lines }),
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

    const columnThreshold = findColumnThreshold(rows);
    // "Checks Posted" (and its preceding "AccountNumber=" marker) is omitted
    // entirely on a statement with zero checks that period (e.g. 2026-02-01)
    // — fall back to "Daily Balance Information", which always prints, so
    // the Daily Balance table never gets misread as more activity rows.
    const boundaryIdx = rows.findIndex(r =>
        r.text === "Checks Posted" || r.text.startsWith("AccountNumber=") || r.text === "Daily Balance Information",
    );
    const activityRows = stripPageBoilerplate(boundaryIdx >= 0 ? rows.slice(0, boundaryIdx) : rows);
    const activityLines = parseActivityRows(activityRows, meta.monthYear, columnThreshold);

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
        console.error("Usage: node scripts/parse-wtb-statement.mjs <statement.pdf> [--dry-run] [--post <url> --key <key>] [--account <name>]");
        process.exitCode = 1;
        return;
    }

    const { meta, lines } = await parseStatement(args.pdfPath);
    const account = args.account || `WTB-${meta.accountNumber.slice(-4)}`;
    const summary = summarize(meta, lines);

    if (args.dryRun) {
        console.log(`Account:      ${account} (${meta.accountNumber})`);
        console.log(`Lines parsed: ${summary.lineCount}`);
        console.log(`Date range:   ${summary.dateRange[0]} .. ${summary.dateRange[1]}`);
        console.log(`Debits:       ${fmt(summary.totalDebitCents)}`);
        console.log(`Credits:      ${fmt(summary.totalCreditCents)}`);
        console.log(`Beginning:    ${fmt(summary.beginningBalanceCents)}`);
        console.log(`Ending:       ${fmt(summary.endingBalanceCents)}`);
        console.log(`Expected end: ${fmt(summary.expectedEndingCents)}`);
        if (meta.statementDeposits) {
            console.log(`Statement says ${meta.statementDeposits.count} deposits/credits totaling ${fmt(meta.statementDeposits.totalCents)}`);
        }
        if (meta.statementDebits) {
            console.log(`Statement says ${meta.statementDebits.count} checks/debits totaling ${fmt(meta.statementDebits.totalCents)}`);
        }
        console.log(
            summary.balanceOk
                ? "Balance check: PASS (beginning + net == ending)"
                : `Balance check: FAIL — off by ${fmt(summary.deltaCents)}`,
        );
    }

    if (!summary.balanceOk) {
        console.error(
            `parse-wtb-statement: balance check failed for ${args.pdfPath} ` +
            `(beginning ${fmt(summary.beginningBalanceCents)} + net ${fmt(summary.totalDebitCents + summary.totalCreditCents)} ` +
            `= ${fmt(summary.expectedEndingCents)}, statement says ending ${fmt(summary.endingBalanceCents)}). ` +
            `Refusing to emit NDJSON or POST.`,
        );
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
        if (!args.key) {
            console.error("--post requires --key <ingestKey> (or set INGEST_KEY / BANK_LEDGER_INGEST_KEY)");
            process.exitCode = 1;
            return;
        }
        let totalInserted = 0;
        let totalExisting = 0;
        for (let i = 0; i < payloadLines.length; i += MAX_LINES_PER_POST) {
            const chunk = payloadLines.slice(i, i + MAX_LINES_PER_POST);
            const result = await postBatch(args.post, args.key, "STATEMENT", account, chunk);
            totalInserted += result.inserted ?? 0;
            totalExisting += result.existing ?? 0;
        }
        console.log(JSON.stringify({ ok: true, inserted: totalInserted, existing: totalExisting }));
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
