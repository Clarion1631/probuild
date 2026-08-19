// Daily WTB CSV → bank-ledger ingest (per-day STATEMENT posts).
//
// Companion to scripts/parse-wtb-statement.mjs (monthly PDF path). This one
// consumes the DAILY "Balances and Transactions" CSV export that the Hermes
// 6pm cron pulls from business.watrust.com (see wtb-daily-bank-export skill;
// files land in I:\My Drive\2025 Reconciliation\Washington Trust Bank\Daily CSV\
// as GTR_WATRUST_YYYY-MM-DD.csv).
//
// The CSV carries, per calendar day: BAI summary rows (OPENING LEDGER 010,
// CLOSING LEDGER 015, float/total rows) and transaction rows with Status
// Cleared or Pending. That per-day structure maps exactly onto the ingest
// route's STATEMENT contract, so each COMPLETE day is posted as its own
// one-day statement (periodStart == periodEnd == the day):
//
//   - openingCents/closingCents from the day's OPENING/CLOSING LEDGER rows
//   - lines = the day's Cleared transaction rows only
//
// Rules, mirroring the monthly parser's philosophy:
//   - Pending rows are NEVER ingested — they mutate (amount, descriptor) and
//     vanish/repost on clearing. Only Cleared lines enter the ledger.
//   - A day missing either ledger row (today, typically: no CLOSING LEDGER
//     until the day ends) is SKIPPED, not guessed at. It'll be complete in
//     tomorrow's file.
//   - Control-total gate per day: openingCents + sum(cleared lines) must
//     equal closingCents EXACTLY (integer cents). A day that fails is
//     refused (exit 1) and NOTHING is posted for it — a broken day means
//     the export can't be vouched for.
//   - Cross-day gate: each day's opening must equal the previous present
//     day's closing (weekends/holidays make gaps; gaps are fine, mismatched
//     overlaps are not).
//   - Re-posting the same completed day is a no-op (content-addressed by
//     the ingest route); a changed completed day surfaces as HTTP 409 and
//     this script reports it loudly — that's a bank-side restatement and a
//     human should look.
//
// SOURCE-OF-TRUTH BOUNDARY (Codex review B1 — read before running the
// monthly parser): daily one-day statements and the monthly PDF statement
// both post source=STATEMENT for account WTB-0723, and the route's
// uniqueness key is (account, periodStart, periodEnd) — so a monthly
// (2026-08-01..2026-08-31) import would coexist with, not replace, the
// dailies, double-minting a canonical BankLine for every overlapping
// transaction. THE DECISION (docs/BANK-REGISTER-PLAN.md "Daily vs monthly"):
// the DAILY CSV is canonical for all dates >= DAILY_CANONICAL_FROM below.
// parse-wtb-statement.mjs is for backfilling months BEFORE that date only.
//
// KNOWN LIMIT (Codex review S4): continuity is checked within one file
// only. The export window is 7 calendar days (~5 business days); if the
// cron is down longer than that, the missed days are simply absent — no
// error fires here or in the route. The cron skill documents the manual
// backfill (pull a Custom Range export covering the gap and run this
// parser on it).
//
// LINE-ORDER ASSUMPTION (Codex review N4): the route's statement content
// hash includes line ORDER, so replay-as-no-op relies on WTB emitting a
// day's rows in a stable order across daily exports (held across all
// observed files so far). If the bank ever re-sorts, a completed day will
// present as a 409 "restatement" — annoying but loud, never silent.
//
// Usage:
//   node scripts/parse-wtb-daily-csv.mjs <daily.csv> [--dry-run]
//   node scripts/parse-wtb-daily-csv.mjs <daily.csv> --post <base-url>
//   node scripts/parse-wtb-daily-csv.mjs <daily.csv> --account WTB-0723
//
// --post takes the SITE BASE URL (e.g. https://probuild.goldentouchremodeling.com);
// the ingest path is appended. The ingest key is read from
// BANK_LEDGER_INGEST_SECRET or INGEST_KEY in the environment — never argv.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const INGEST_PATH = "/api/integrations/bank-ledger/ingest";
const DEFAULT_ACCOUNT = "WTB-0723";
// First calendar date the daily-CSV path owns (the first day ingested from a
// daily export in prod, 2026-08-18). The monthly PDF parser must only cover
// periods strictly BEFORE this date; this parser refuses days before it, so
// the two sources can never both mint canonical BankLines for one date.
export const DAILY_CANONICAL_FROM = "2026-08-12";
// The daily export shows this account; refuse anything else so a future
// second-account export can't silently pollute WTB-0723's ledger.
const EXPECTED_ACCOUNT_NUMBER = "1001780723";

function parseArgs(argv) {
    const args = { csvPath: null, dryRun: false, post: null, account: DEFAULT_ACCOUNT };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") args.dryRun = true;
        else if (arg === "--post") {
            const value = argv[++i];
            if (value === undefined || value.startsWith("--")) throw new Error("--post requires a base URL argument");
            args.post = value;
        }
        else if (arg === "--account") args.account = argv[++i];
        else if (!arg.startsWith("--") && !args.csvPath) args.csvPath = arg;
    }
    return args;
}

/** RFC-4180-ish CSV: quoted fields, "" escapes, CRLF tolerant. */
function parseCsv(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ",") { row.push(field); field = ""; }
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            row.push(field); field = "";
            if (row.length > 1 || row[0] !== "") rows.push(row);
            row = [];
        } else field += ch;
    }
    if (field !== "" || row.length > 0) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
    return rows;
}

function pad2(n) { return String(n).padStart(2, "0"); }

/** "08/12/2026" → "2026-08-12", with true calendar validation. Returns null on failure. */
function toIsoDate(mdY) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((mdY ?? "").trim());
    if (!m) return null;
    const [, mm, dd, yyyy] = m;
    const year = Number(yyyy), month = Number(mm), day = Number(dd);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${yyyy}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Exact decimal-string → integer cents. Refuses anything that isn't a plain
 * signed decimal with ≤2 fraction digits — float round-tripping is how
 * penny drift sneaks into ledgers.
 */
function toCents(raw) {
    const s = (raw ?? "").trim();
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) return null;
    const [, sign, whole, frac = ""] = m;
    const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents)) return null;
    return sign === "-" ? -cents : cents;
}

function fail(msg) {
    console.error(`GATE FAILED: ${msg}`);
    process.exitCode = 1;
}

export function buildDayStatements(csvText, account) {
    const rows = parseCsv(csvText.replace(/^\uFEFF/, ""));
    if (rows.length < 2) throw new Error("CSV has no data rows");
    const header = rows[0].map(h => h.trim());
    const col = name => {
        const i = header.indexOf(name);
        if (i === -1) throw new Error(`CSV missing expected column: ${name}`);
        return i;
    };
    const iDate = col("Post Date"), iAcct = col("Account Number"), iDesc = col("Description"),
        iBai = col("BAI Code"), iAmt = col("Amount"), iStatus = col("Status"),
        iCustRef = col("Customer Reference"), iDetail = col("Transaction Detail");

    /** day → { openingCents, closingCents, lines: [], pending: n } */
    const days = new Map();
    const problems = [];

    for (let r = 1; r < rows.length; r++) {
        const rec = rows[r];
        if (rec.every(f => f.trim() === "")) continue;
        const isoDate = toIsoDate(rec[iDate]);
        if (!isoDate) { problems.push(`row ${r + 1}: bad Post Date "${rec[iDate]}"`); continue; }
        const acctNum = (rec[iAcct] ?? "").trim();
        if (acctNum !== EXPECTED_ACCOUNT_NUMBER) { problems.push(`row ${r + 1}: unexpected account "${acctNum}"`); continue; }

        if (!days.has(isoDate)) days.set(isoDate, { openingCents: null, closingCents: null, lines: [], pending: 0 });
        const day = days.get(isoDate);

        const desc = (rec[iDesc] ?? "").trim();
        const bai = (rec[iBai] ?? "").trim();
        const status = (rec[iStatus] ?? "").trim();
        const cents = toCents(rec[iAmt]);
        if (cents === null) { problems.push(`row ${r + 1}: unparseable Amount "${rec[iAmt]}"`); continue; }

        // BAI summary rows (status is empty on these). S3: a second summary
        // row for the same day with a DIFFERENT value is a malformed/merged
        // export — refuse rather than last-write-win (a tie is harmless).
        if (bai === "010" && desc === "OPENING LEDGER") {
            if (day.openingCents !== null && day.openingCents !== cents) { problems.push(`row ${r + 1}: conflicting OPENING LEDGER for ${isoDate} (${day.openingCents} vs ${cents})`); continue; }
            day.openingCents = cents; continue;
        }
        if (bai === "015" && desc === "CLOSING LEDGER") {
            if (day.closingCents !== null && day.closingCents !== cents) { problems.push(`row ${r + 1}: conflicting CLOSING LEDGER for ${isoDate} (${day.closingCents} vs ${cents})`); continue; }
            day.closingCents = cents; continue;
        }
        if (status === "") continue; // other summary rows: floats, totals, closing available
        if (status === "Pending") { day.pending++; continue; }
        if (status !== "Cleared") { problems.push(`row ${r + 1}: unknown Status "${status}"`); continue; }

        const detail = (rec[iDetail] ?? "").trim();
        const rawDescriptor = detail !== "" ? `${desc} ${detail}`.trim() : desc;
        // Check number: Customer Reference on CHECK PAID rows (e.g. "1027").
        const custRef = (rec[iCustRef] ?? "").trim();
        const checkNumber = desc === "CHECK PAID" && /^\d+$/.test(custRef) ? custRef : null;

        day.lines.push({ postedDate: isoDate, amountCents: cents, rawDescriptor, checkNumber });
    }

    if (problems.length > 0) throw new Error(`CSV problems:\n  ${problems.join("\n  ")}`);

    const sorted = [...days.keys()].sort();
    const complete = [];
    const skipped = [];
    for (const isoDate of sorted) {
        const day = days.get(isoDate);
        // B1: days before the daily-canonical boundary belong to the monthly
        // PDF path — never mint them from a daily export.
        if (isoDate < DAILY_CANONICAL_FROM) {
            skipped.push({ isoDate, reason: `before DAILY_CANONICAL_FROM (${DAILY_CANONICAL_FROM}) — monthly-statement territory`, pending: day.pending });
            continue;
        }
        if (day.openingCents === null || day.closingCents === null) {
            skipped.push({ isoDate, reason: day.openingCents === null ? "no OPENING LEDGER" : "no CLOSING LEDGER (day not finished)", pending: day.pending });
            continue;
        }
        const sum = day.lines.reduce((a, l) => a + l.amountCents, 0);
        if (day.openingCents + sum !== day.closingCents) {
            throw new Error(`day ${isoDate} FAILS control total: opening ${day.openingCents} + cleared sum ${sum} = ${day.openingCents + sum}, but closing is ${day.closingCents}`);
        }
        // S1: a zero-transaction complete day is legitimate (quiet business
        // day) but the ingest route rejects empty lines — skip it loudly.
        // Balance continuity is unaffected (opening == closing).
        if (day.lines.length === 0) {
            if (day.openingCents !== day.closingCents) {
                throw new Error(`day ${isoDate} has no cleared lines but opening ${day.openingCents} != closing ${day.closingCents}`);
            }
            skipped.push({ isoDate, reason: "no cleared transactions (quiet day; balances unchanged — nothing to ingest)", pending: day.pending });
            continue;
        }
        complete.push({
            account,
            periodStart: isoDate,
            periodEnd: isoDate,
            openingCents: day.openingCents,
            closingCents: day.closingCents,
            lines: day.lines,
            pending: day.pending,
        });
    }

    // Cross-day continuity: opening must equal previous complete day's closing.
    for (let i = 1; i < complete.length; i++) {
        if (complete[i].openingCents !== complete[i - 1].closingCents) {
            throw new Error(`continuity break: ${complete[i].periodStart} opens at ${complete[i].openingCents} but ${complete[i - 1].periodEnd} closed at ${complete[i - 1].closingCents}`);
        }
    }

    return { complete, skipped };
}

async function postStatement(baseUrl, secret, statement) {
    const { pending, ...payload } = statement;
    const res = await fetch(new URL(INGEST_PATH, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": secret },
        body: JSON.stringify({ source: "STATEMENT", ...payload }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    return { status: res.status, body };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.csvPath) {
        console.error("Usage: node scripts/parse-wtb-daily-csv.mjs <daily.csv> [--dry-run] [--post <base-url>] [--account WTB-0723]");
        process.exit(1);
    }

    const csvText = await readFile(args.csvPath, "utf8");
    let parsed;
    try {
        parsed = buildDayStatements(csvText, args.account);
    } catch (error) {
        fail(error.message);
        return;
    }

    const { complete, skipped } = parsed;
    console.log(`Parsed ${complete.length} complete day(s), ${skipped.length} skipped:`);
    for (const s of complete) {
        console.log(`  ${s.periodStart}: ${s.lines.length} cleared line(s), open ${(s.openingCents / 100).toFixed(2)} → close ${(s.closingCents / 100).toFixed(2)}${s.pending ? ` (${s.pending} pending excluded)` : ""} ✓`);
    }
    for (const s of skipped) {
        console.log(`  ${s.isoDate}: SKIPPED — ${s.reason}${s.pending ? ` (${s.pending} pending)` : ""}`);
    }

    if (args.dryRun || !args.post) {
        if (!args.post) console.log("(no --post; dry run only)");
        return;
    }

    const secret = process.env.BANK_LEDGER_INGEST_SECRET || process.env.INGEST_KEY;
    if (!secret) {
        fail("--post requires BANK_LEDGER_INGEST_SECRET or INGEST_KEY in the environment");
        return;
    }

    let hadError = false;
    for (const statement of complete) {
        const { status, body } = await postStatement(args.post, secret, statement);
        if (status === 200 && body?.ok) {
            const tag = body.replay ? "replay (no-op)" : `inserted ${body.inserted}`;
            console.log(`  POST ${statement.periodStart}: OK — ${tag}`);
        } else if (status === 409) {
            hadError = true;
            console.error(`  POST ${statement.periodStart}: 409 CONFLICT — the stored day differs from this file. Bank-side restatement? A HUMAN SHOULD LOOK. ${JSON.stringify(body)}`);
            // S2: stop here — later days chain off this day's balances, and
            // posting them against a disputed base would bake the
            // discontinuity into the DB. Resolve this day first.
            console.error(`  Remaining day(s) NOT posted (they depend on ${statement.periodStart}'s balances).`);
            break;
        } else {
            hadError = true;
            console.error(`  POST ${statement.periodStart}: HTTP ${status} ${JSON.stringify(body)}`);
            console.error(`  Remaining day(s) NOT posted — resolve this failure first.`);
            break;
        }
    }
    if (hadError) process.exitCode = 1;
}

// Entry check must survive being imported (e.g. by parse-wtb-statement.mjs
// for DAILY_CANONICAL_FROM, or by tests): process.argv[1] can be undefined
// under `node -e`, and pathToFileURL(undefined) throws.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error); process.exit(1); });
}
