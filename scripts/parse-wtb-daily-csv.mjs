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
// LINE ORDER (Codex review N4, then round-2 B-2 — RESOLVED): the route's
// statement content hash includes line ORDER, and WTB's export demonstrably
// does NOT preserve row order between pulls (the per-day summary block alone
// appears in three different orders inside one sample file). Because the
// 7-day window re-posts each completed day several times, that would turn a
// cosmetic bank-side re-order into a 409 that halts every later day. Lines
// are therefore sorted into a total order (sortLines) before the payload is
// built, so the hash is addressed by CONTENT, not by transport order.
//
// DEPOSIT SWEEP (--sweep): this script is also the production TRIGGER for the
// daily bank-credit auto-apply (docs/plans/DEPOSIT-SWEEP-PLAN.md). After a
// day's STATEMENT post succeeds (a replay no-op counts), --sweep POSTs that
// same day's CREDIT rows to /api/payments/deposit-ingest as ONE batch:
// source "bank", the postDate, the credits, and the control totals — where
// creditSum is the bank's OWN per-day TOTAL CREDITS figure (BAI 100). The
// endpoint refuses the whole batch if it does not tie to the rows posted.
// Rules that matter for an unattended cron:
//   - only COMPLETE days are swept, and a day skipped for any reason
//     (REPOST_FLOOR, a missing ledger row, a quiet day) is never swept
//     either — a partial day is exactly the state that makes an amount look
//     unique when it is not;
//   - a failed sweep POST is a non-zero exit, so the Hermes watchdog fires;
//   - the bearer secret is read from DEPOSIT_INGEST_SECRET in the
//     environment, never from argv, and its absence fails BEFORE any network
//     call rather than half way through the day;
//   - --sweep-dry-run posts the same batch with dryRun true (the Phase A
//     shadow week): the endpoint runs the whole match and stops before any
//     money boundary.
//
// Usage:
//   node scripts/parse-wtb-daily-csv.mjs <daily.csv> [--dry-run]
//   node scripts/parse-wtb-daily-csv.mjs <daily.csv> --post <base-url>
//   node scripts/parse-wtb-daily-csv.mjs <daily.csv> --post <base-url> --sweep
//   node scripts/parse-wtb-daily-csv.mjs <daily.csv> --post <base-url> --sweep-dry-run
//   node scripts/parse-wtb-daily-csv.mjs <daily.csv> --account WTB-0723
//
// --post takes the SITE BASE URL (e.g. https://probuild.goldentouchremodeling.com);
// the ingest path is appended. The ingest key is read from
// BANK_LEDGER_INGEST_SECRET or INGEST_KEY in the environment — never argv.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const INGEST_PATH = "/api/integrations/bank-ledger/ingest";
const DEPOSIT_SWEEP_PATH = "/api/payments/deposit-ingest";
const DEFAULT_ACCOUNT = "WTB-0723";
// First calendar date the daily-CSV path owns (the first day ingested from a
// daily export in prod, 2026-08-18). The monthly PDF parser must only cover
// periods strictly BEFORE this date; this parser refuses days before it, so
// the two sources can never both mint canonical BankLines for one date.
export const DAILY_CANONICAL_FROM = "2026-08-12";
// HASH-FORMAT EPOCH (Codex daily review round 2). The round-2 fixes changed
// how a day is REPRESENTED — lines are now sorted into a total order (B-2)
// and descriptors have their internal whitespace collapsed (S-1) — so the
// statement content hash for a given day differs from what the pre-round-2
// parser produced. The days below were already posted to prod under the old
// representation (verified: same 14/7/10/20 line counts, same balances, only
// the encoding differs — no data is wrong). Re-posting them would hash
// differently, return 409 "restatement", and under the fail-fast rule stall
// every later day, forever.
//
// Rather than delete-and-re-post immutable prod money rows to fix what is a
// purely cosmetic difference, this floor simply declines to re-post days that
// predate the format change. They stay exactly as they are, and the parser
// resumes at the first day posted under the new format.
//
// This is deliberately SEPARATE from DAILY_CANONICAL_FROM: that constant marks
// where the monthly PDF path hands off to the daily path, and moving it would
// wrongly tell the monthly parser it owns 08-12..08-17 (which the daily ledger
// already holds) — inviting the exact double-minting B1 exists to prevent.
export const REPOST_FLOOR = "2026-08-18";
// The daily export shows this account; refuse anything else so a future
// second-account export can't silently pollute WTB-0723's ledger.
const EXPECTED_ACCOUNT_NUMBER = "1001780723";

// BAI codes seen on this export's non-transaction summary rows (blank Status).
// B-1: this list is a WHITELIST — a blank-Status row on any other code is
// refused, not skipped, because it may be a real money-bearing row.
//   010 opening ledger   015 closing ledger   030 current ledger
//   040 opening avail    045 closing avail    060 current avail
//   072 1-day float      074 2+-day float     100 total credits
//   400 total debits
const SUMMARY_BAI_CODES = new Set(["010", "015", "030", "040", "045", "060", "072", "074", "100", "400"]);
const BAI_TOTAL_CREDITS = "100";
const BAI_TOTAL_DEBITS = "400";
const BAI_CHECK_PAID = "475";
const POST_TIMEOUT_MS = 30_000;
// The sweep endpoint processes a whole day sequentially, each credit worth up
// to two QuickBooks round trips, inside a 60-second function. Abandoning that
// request early would leave a batch mid-money-write with nobody reading the
// answer, so the client waits LONGER than the server can possibly take.
const SWEEP_POST_TIMEOUT_MS = 90_000;

/** Collapse internal whitespace runs to one space and trim. Hash stability. */
function collapseWs(value) { return value.trim().replace(/\s+/g, " "); }

/**
 * Total order over a day's lines so the statement content hash is addressed by
 * CONTENT, not by transport order (Codex daily review round 2, B-2). WTB's
 * export demonstrably re-orders rows between pulls — the per-day summary block
 * alone appears in three different orders inside one sample file — and because
 * the 7-day window re-posts each completed day up to ~5 times, an unsorted
 * payload turns a cosmetic re-order into a 409 that stalls every later day.
 */
/** Deterministic order for the sweep batch. No hash depends on it; a stable
 *  order just makes the log and any diff readable. */
function sortCredits(credits) {
    return [...credits].sort((a, b) =>
        a.bankReference.localeCompare(b.bankReference)
        || a.amountCents - b.amountCents);
}

function sortLines(lines) {
    return [...lines].sort((a, b) =>
        a.postedDate.localeCompare(b.postedDate)
        || a.amountCents - b.amountCents
        || a.rawDescriptor.localeCompare(b.rawDescriptor)
        || String(a.checkNumber ?? "").localeCompare(String(b.checkNumber ?? "")));
}

function parseArgs(argv) {
    const args = { csvPath: null, dryRun: false, post: null, account: DEFAULT_ACCOUNT, sweep: false, sweepDryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") args.dryRun = true;
        // --sweep-dry-run implies --sweep: it is the SAME batch, posted with
        // dryRun true so the endpoint stops before any money boundary.
        else if (arg === "--sweep") args.sweep = true;
        else if (arg === "--sweep-dry-run") { args.sweep = true; args.sweepDryRun = true; }
        else if (arg === "--post") {
            const value = argv[++i];
            if (value === undefined || value.startsWith("--")) throw new Error("--post requires a base URL argument");
            args.post = value;
        }
        else if (arg === "--account") {
            const value = argv[++i];
            // S-3: guard the missing-value case like --post does, and pin the
            // label to the account this export actually contains — otherwise
            // `--account WTB-9999` files 0723's transactions into a different
            // ledger account with no complaint from either side.
            if (value === undefined || value.startsWith("--")) throw new Error("--account requires a value");
            if (value !== DEFAULT_ACCOUNT) throw new Error(`--account ${value} does not match the account this export contains (${DEFAULT_ACCOUNT} / ${EXPECTED_ACCOUNT_NUMBER})`);
            args.account = value;
        }
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
    // Bank Reference is the stable per-deposit id the sweep keys on
    // (docs/WTB-CHECK-IMAGES.md). Looked up OPTIONALLY so a historical export
    // without the column still parses for the ledger: a credit then carries an
    // empty reference, and the sweep endpoint refuses that batch rather than
    // inventing an identity for it.
    const iBankRef = header.indexOf("Bank Reference");

    /** day → { openingCents, closingCents, lines: [], pending: n } */
    const days = new Map();
    const problems = [];

    for (let r = 1; r < rows.length; r++) {
        const rec = rows[r];
        if (rec.every(f => f.trim() === "")) continue;
        // S-2: a short/ragged row reads its missing trailing fields as "",
        // silently changing rawDescriptor (→ different hash → false 409).
        // Refuse the file instead of guessing at the bank's intent.
        if (rec.length !== header.length) {
            problems.push(`row ${r + 1}: has ${rec.length} column(s), expected ${header.length} — ragged/truncated CSV`);
            continue;
        }
        const isoDate = toIsoDate(rec[iDate]);
        if (!isoDate) { problems.push(`row ${r + 1}: bad Post Date "${rec[iDate]}"`); continue; }
        const acctNum = (rec[iAcct] ?? "").trim();
        if (acctNum !== EXPECTED_ACCOUNT_NUMBER) { problems.push(`row ${r + 1}: unexpected account "${acctNum}"`); continue; }

        if (!days.has(isoDate)) days.set(isoDate, { openingCents: null, closingCents: null, lines: [], credits: [], pending: 0, totalCreditsCents: null, totalDebitsCents: null });
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
        // B-1 (Codex daily review round 2): the two independent sub-totals the
        // bank already gives us. Captured here, enforced as a gate below.
        if (bai === BAI_TOTAL_CREDITS && status === "") {
            if (day.totalCreditsCents !== null && day.totalCreditsCents !== cents) { problems.push(`row ${r + 1}: conflicting TOTAL CREDITS for ${isoDate} (${day.totalCreditsCents} vs ${cents})`); continue; }
            day.totalCreditsCents = cents; continue;
        }
        if (bai === BAI_TOTAL_DEBITS && status === "") {
            if (day.totalDebitsCents !== null && day.totalDebitsCents !== cents) { problems.push(`row ${r + 1}: conflicting TOTAL DEBITS for ${isoDate} (${day.totalDebitsCents} vs ${cents})`); continue; }
            day.totalDebitsCents = cents; continue;
        }
        // B-1: a blank Status used to mean "some summary row, skip it". That
        // silently dropped any money-bearing row the bank emitted without a
        // status, and an offsetting PAIR of such rows (a reversal, a
        // deposit-return) nets to zero and sails straight through the
        // opening+sum==closing gate. Only KNOWN summary BAI codes may be
        // skipped; anything else blank is unvouchable and refuses the file.
        if (status === "") {
            if (!SUMMARY_BAI_CODES.has(bai)) {
                problems.push(`row ${r + 1}: blank Status on unrecognized BAI code "${bai}" (desc "${desc}", amount ${cents}) — refusing rather than silently dropping a possible money-bearing row`);
            }
            continue;
        }
        if (status === "Pending") { day.pending++; continue; }
        if (status !== "Cleared") { problems.push(`row ${r + 1}: unknown Status "${status}"`); continue; }

        const detail = (rec[iDetail] ?? "").trim();
        // S-1: collapse internal whitespace. computeStatementContentHash does
        // NOT normalize descriptors (unlike computeQboLineContentHash), so a
        // purely cosmetic spacing change from the bank on a re-delivered day
        // would otherwise be a false 409 — which halts the whole pipeline.
        const rawDescriptor = collapseWs(detail !== "" ? `${desc} ${detail}` : desc);
        // Check number: Customer Reference on a check-paid row. S-4: key off
        // BAI 475 rather than exact descriptor text (a variant such as
        // "CHECK PAID - RETURN" would otherwise silently yield null), and
        // strip leading zeros so "01027" and "1027" are one identity — the
        // monthly parser captures them unpadded.
        const custRef = (rec[iCustRef] ?? "").trim();
        const checkNumber = (bai === BAI_CHECK_PAID || desc.startsWith("CHECK PAID")) && /^\d+$/.test(custRef)
            ? String(Number(custRef))
            : null;

        day.lines.push({ postedDate: isoDate, amountCents: cents, rawDescriptor, checkNumber });
        // Money IN, for the deposit sweep. Kept in a SEPARATE list and never on
        // the ledger line, because the statement route content-addresses those
        // line objects: an extra field there would re-hash every stored day.
        if (cents > 0) {
            day.credits.push({
                bankReference: iBankRef === -1 ? "" : (rec[iBankRef] ?? "").trim(),
                amount: cents / 100,
                amountCents: cents,
                // The three fields the endpoint classifies on, kept SEPARATE and
                // unmerged: only an actual customer deposit may be booked as a
                // customer payment, and that decision reads the BAI code, the
                // description and the detail independently. (The ledger's
                // combined rawDescriptor is no use for it.)
                baiCode: bai || null,
                description: desc || null,
                transactionDetail: collapseWs(detail) || null,
                customerReference: custRef || null,
            });
        }
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
        // B-1: SECOND, INDEPENDENT control total. opening+sum==closing alone
        // cannot detect an offsetting pair of dropped rows (a reversal nets to
        // zero). The bank publishes its own per-day TOTAL CREDITS (BAI 100) and
        // TOTAL DEBITS (BAI 400); tying the cleared rows to BOTH closes that
        // hole, because a dropped row moves exactly one side of the pair.
        const creditSum = day.lines.reduce((a, l) => (l.amountCents > 0 ? a + l.amountCents : a), 0);
        const debitSum = day.lines.reduce((a, l) => (l.amountCents < 0 ? a + l.amountCents : a), 0);
        if (day.totalCreditsCents !== null && creditSum !== day.totalCreditsCents) {
            throw new Error(`day ${isoDate} FAILS credit sub-total: cleared credits ${creditSum} but bank reports TOTAL CREDITS ${day.totalCreditsCents} — a money-bearing row is missing or misparsed`);
        }
        // The bank reports TOTAL DEBITS as a negative figure on this export.
        if (day.totalDebitsCents !== null && debitSum !== day.totalDebitsCents) {
            throw new Error(`day ${isoDate} FAILS debit sub-total: cleared debits ${debitSum} but bank reports TOTAL DEBITS ${day.totalDebitsCents} — a money-bearing row is missing or misparsed`);
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
            lines: sortLines(day.lines), // B-2: content-addressed, not transport-order-addressed
            pending: day.pending,
            // Sweep-only, stripped before the ledger POST (see postStatement).
            credits: sortCredits(day.credits),
            totalCreditsCents: day.totalCreditsCents,
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
    const { account, periodStart, periodEnd, openingCents, closingCents, lines } = statement;
    // Built by WHITELIST, in this exact key order: the route content-addresses
    // a statement, so a stray field (pending, credits, totalCreditsCents) would
    // change the hash and 409 every day already stored.
    const payload = { source: "STATEMENT", account, periodStart, periodEnd, openingCents, closingCents, lines };
    // NIT (round 2): a hung fetch would stall the nightly cron indefinitely.
    const res = await fetch(new URL(INGEST_PATH, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": secret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    return { status: res.status, body };
}

/**
 * Can this day be swept at all?
 *
 * The control total is only evidence if it comes from somewhere OTHER than the
 * rows it checks. Deriving creditSum from the credits themselves made the
 * endpoint's check a tautology: a day whose export dropped a deposit row would
 * have posted a sum that matched the rows perfectly and sailed through, which
 * is precisely the "browser automation quietly saw half a day" failure the
 * control totals exist to catch. So a credit-bearing day with no independent
 * TOTAL CREDITS row (BAI 100) is NOT swept.
 *
 * A day with no credits at all is fine either way — there is nothing to sweep,
 * and no money can be missed by not sweeping it.
 */
export function canSweepDay(day) {
    if (day.credits.length === 0) return { ok: false, reason: "no credits", failure: false };
    if (day.totalCreditsCents === null || day.totalCreditsCents === undefined) {
        return {
            ok: false,
            reason: "no TOTAL CREDITS control row, sweep skipped",
            failure: true,
        };
    }
    return { ok: true };
}

/**
 * The deposit-sweep batch for ONE complete day. Pure, so the payload shape is
 * unit-testable without a network.
 *
 * creditSum is the BANK's own TOTAL CREDITS figure, and ONLY that — there is
 * deliberately no fallback to the summed rows (see canSweepDay).
 * buildDayStatements has already refused the whole file if the cleared credits
 * disagree with that figure, and the endpoint re-checks it against the rows
 * posted, so a day that cannot be vouched for is never written.
 */
export function buildSweepPayload(day, opts = {}) {
    const credits = day.credits.map(c => ({
        bankReference: c.bankReference,
        amount: c.amount,
        baiCode: c.baiCode,
        description: c.description,
        transactionDetail: c.transactionDetail,
        customerReference: c.customerReference,
    }));
    if (day.totalCreditsCents === null || day.totalCreditsCents === undefined) {
        // Unreachable via sweepDay (canSweepDay gates it); a hard error rather
        // than a quiet fallback so no future caller can reintroduce the
        // tautology.
        throw new Error(`day ${day.periodStart} has no TOTAL CREDITS control row — it must not be swept`);
    }
    const creditSumCents = day.totalCreditsCents;
    return {
        source: "bank",
        postDate: day.periodStart,
        credits,
        creditCount: credits.length,
        creditSum: creditSumCents / 100,
        ...(opts.dryRun ? { dryRun: true } : {}),
    };
}

/**
 * The sweep bearer secret. Resolved from the environment ONLY — a secret on
 * the command line lands in argv, shell history and any agent transcript — and
 * resolved BEFORE the first POST of the run, so an unconfigured cron fails
 * loudly and immediately instead of half way through a day.
 */
export function resolveSweepSecret(env = process.env) {
    const secret = env.DEPOSIT_INGEST_SECRET;
    if (!secret) {
        throw new Error("--sweep requires DEPOSIT_INGEST_SECRET in the environment (never on the command line)");
    }
    return secret;
}

export async function postSweep(baseUrl, secret, day, opts = {}) {
    const res = await fetch(new URL(DEPOSIT_SWEEP_PATH, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify(buildSweepPayload(day, opts)),
        signal: AbortSignal.timeout(SWEEP_POST_TIMEOUT_MS),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    return { status: res.status, body };
}

/** One log line for a credit a human has to look at: reference, money, why. */
export function sweepCreditLine(credit, amount) {
    const money = typeof amount === "number" ? `$${amount.toFixed(2)}` : "unknown amount";
    return `${credit?.bankReference} ${money}: ${credit?.status} — ${credit?.reason ?? ""}`;
}

/**
 * True when this credit needs to appear in the job log.
 *
 * Everything that is not finished with, PLUS the two CLEAN outcomes a human
 * still has to act on:
 *   - `unmatched` — the sweep could not place the money and asked for help;
 *   - `proposed`  — suggest-only mode (or the 2-day wait) matched it but did
 *     not book it. Until the /automation panel grows a confirm button, this log
 *     line IS the operator's worklist, so it must carry the candidate.
 * Neither is a job failure; both are things somebody must look at.
 */
export function sweepCreditNeedsAttention(credit) {
    return credit?.status === "unmatched"
        || credit?.status === "proposed"
        || !CLEAN_SWEEP_STATUSES.includes(credit?.status);
}

/** The statuses that mean a credit is finished with. Mirrors
 *  CLEAN_SWEEP_STATUSES in src/lib/deposit-sweep.ts — this runner is plain
 *  .mjs and cannot import the TypeScript module. */
const CLEAN_SWEEP_STATUSES = ["applied", "proposed", "unmatched"];
const SWEEP_BUCKETS = ["applied", "proposed", "unmatched", "reconcile", "failed", "qboUnknown", "unresolved"];

const bucket = (counts, key) => {
    const value = counts?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

/** The one line the Hermes job copies into its Bot Health report. Reports every
 *  bucket: a day whose credits all failed on a QuickBooks outage must not read
 *  the same as a quiet day. */
export function sweepSummaryLine(postDate, counts) {
    const needHuman = bucket(counts, "unmatched") + bucket(counts, "reconcile");
    const line = `sweep ${postDate}: ${counts.credits} credits, ${counts.applied} applied, ` +
        `${needHuman} need-human, ${counts.proposed} proposed, ${counts.replay} replay`;
    const failed = bucket(counts, "failed");
    const qboUnknown = bucket(counts, "qboUnknown");
    const unresolved = bucket(counts, "unresolved");
    if (failed + qboUnknown + unresolved === 0) return line;
    return `${line}, ${failed} failed, ${qboUnknown} qbo-unknown` +
        (unresolved > 0 ? `, ${unresolved} unresolved` : "");
}

/**
 * Did this day's sweep finish cleanly? The endpoint already answers that in
 * `ok`, and that is the authority; everything below is a second, independent
 * reading, because the whole point of this check is that the run must never
 * report success on a batch nobody fully accounted for. `unmatched` is NOT a
 * failure — asking a human is the sweep working as designed.
 *
 * Three ways to fail, in the order they can go wrong:
 *   1. the endpoint said so;
 *   2. the buckets do not add up to the credit count, so some outcome went
 *      uncounted (an older deployment, or a status added since);
 *   3. any per-credit status outside the clean set — the raw result, not a
 *      bucket, so a status nobody has a bucket for still fails the run;
 *   4. an answer that does not account for the credits that were submitted.
 *
 * @param {unknown} body
 * @param {Set<string>|null} [submittedReferences]
 * @returns {boolean}
 */
export function sweepBatchFailed(body, submittedReferences = null) {
    if (!body || typeof body !== "object") return true;
    // POSITIVE confirmation only. A missing `ok` is not a pass: it means the
    // response is not the one this runner knows how to read, and an unattended
    // job must never treat "I could not tell" as success.
    if (body.ok !== true) return true;

    const counts = body.counts;
    if (!counts || typeof counts !== "object") return true;
    const sum = SWEEP_BUCKETS.reduce((total, key) => total + bucket(counts, key), 0);
    if (sum !== bucket(counts, "credits")) return true;
    if (bucket(counts, "reconcile") + bucket(counts, "failed") + bucket(counts, "qboUnknown") + bucket(counts, "unresolved") > 0) return true;

    // The response must actually account for the credits, one by one. An empty
    // or short array with healthy-looking counts would otherwise pass: the
    // runner would report a clean day for credits nobody can prove were seen.
    if (!Array.isArray(body.credits)) return true;
    if (body.credits.length !== bucket(counts, "credits")) return true;
    for (const credit of body.credits) {
        if (!CLEAN_SWEEP_STATUSES.includes(credit?.status)) return true;
    }

    // …and they must be the SAME credits that were submitted, not some other
    // day's. Set equality, so a duplicate or a substitution both fail.
    if (submittedReferences) {
        const answered = new Set(body.credits.map(c => c?.bankReference));
        if (answered.size !== submittedReferences.size) return true;
        for (const ref of submittedReferences) if (!answered.has(ref)) return true;
    }
    return false;
}

/**
 * POST one complete day's credits and report the outcome. Returns false when
 * the caller must stop and exit non-zero — which, under the Hermes cron, is
 * what makes the daily-job watchdog fire.
 */
async function sweepDay(args, sweepSecret, statement, stalled) {
    const postDate = statement.periodStart;
    if (statement.credits.length === 0) {
        console.log(`  sweep ${postDate}: 0 credits — nothing to apply`);
        return true;
    }
    const sweepable = canSweepDay(statement);
    if (!sweepable.ok && sweepable.failure) {
        // The day HAS credits but the bank published no independent total for
        // them, so nothing about this batch can be vouched for.
        console.error(`  sweep ${postDate}: ${sweepable.reason}`);
        stalled();
        return false;
    }
    const missingRef = statement.credits.filter(c => !c.bankReference);
    if (missingRef.length > 0) {
        // Refused here rather than posted: without the bank reference there is
        // no idempotency key, and the endpoint would (correctly) 400 the batch.
        console.error(`  sweep ${postDate}: ${missingRef.length} credit(s) carry no Bank Reference — refusing to post a batch with no idempotency key`);
        stalled();
        return false;
    }
    const { status, body } = await postSweep(args.post, sweepSecret, statement, { dryRun: args.sweepDryRun });
    if (status !== 200 || !body?.counts) {
        console.error(`  sweep ${postDate}: HTTP ${status} ${JSON.stringify(body)}`);
        stalled();
        return false;
    }

    // Always report the whole day, whichever way it went.
    const submitted = new Set(statement.credits.map(c => c.bankReference));
    const summary = `  ${sweepSummaryLine(postDate, body.counts)}${args.sweepDryRun ? " (dry run)" : ""}`;
    const failed = sweepBatchFailed(body, submitted);
    (failed ? console.error : console.log)(summary);
    // Every credit a human has to look at gets its own line, with the money on
    // it. `unmatched` is a CLEAN batch outcome, so it would otherwise never be
    // printed — and then the only trace of "the sweep could not place $13,447"
    // would be a count in a summary nobody reads twice.
    const amountByReference = new Map(statement.credits.map(c => [c.bankReference, c.amount]));
    for (const credit of body.credits ?? []) {
        if (!sweepCreditNeedsAttention(credit)) continue;
        console.log(`    ${sweepCreditLine(credit, amountByReference.get(credit?.bankReference))}`);
    }
    if (!failed) return true;

    // A credit left failed / qbo_unknown / reconcile is unresolved money: exit
    // non-zero so the Hermes daily-job watchdog fires instead of the run
    // logging a healthy day through a QuickBooks outage.
    console.error(`  sweep ${postDate}: unresolved credits — a human (or the next run) must resolve them`);
    stalled();
    return false;
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
        // --sweep is an action taken against a live site; without --post there
        // is nowhere to take it, and silently ignoring the flag would let a
        // mis-wired cron look healthy while sweeping nothing.
        if (args.sweep) fail("--sweep requires --post <base-url>");
        return;
    }

    const secret = process.env.BANK_LEDGER_INGEST_SECRET || process.env.INGEST_KEY;
    if (!secret) {
        fail("--post requires BANK_LEDGER_INGEST_SECRET or INGEST_KEY in the environment");
        return;
    }
    // Resolved up front, before ANY network call: an unconfigured sweep must
    // not post half the day's statements and then discover it has no secret.
    let sweepSecret = null;
    if (args.sweep) {
        try {
            sweepSecret = resolveSweepSecret();
        } catch (error) {
            fail(error.message);
            return;
        }
    }

    let hadError = false;
    for (let i = 0; i < complete.length; i++) {
        const statement = complete[i];
        // REPOST_FLOOR: skip days that were posted under the pre-round-2 hash
        // format. Deliberately applied HERE and not during parsing, so those
        // days still take part in every control-total and continuity gate
        // above — they just aren't re-transmitted.
        if (statement.periodStart < REPOST_FLOOR) {
            console.log(`  POST ${statement.periodStart}: skipped — predates REPOST_FLOOR (${REPOST_FLOOR}); already stored under the pre-round-2 hash format`);
            continue;
        }
        // S-6: name the days that did NOT post. A bare exit code under an
        // unattended cron reads as "nothing happened"; every later run then
        // re-hits the same conflict and stalls again, indefinitely. Say so.
        const stalled = () => {
            const rest = complete.slice(i + 1).map(s => s.periodStart).filter(d => d >= REPOST_FLOOR);
            console.error(`  NOT POSTED (${rest.length + 1} day(s)): ${[statement.periodStart, ...rest].join(", ")}`);
            console.error(`  This will repeat every run until a human resolves ${statement.periodStart}. Escalate if you see it twice.`);
        };
        const { status, body } = await postStatement(args.post, secret, statement);
        if (status === 200 && body?.ok) {
            const tag = body.replay ? "replay (no-op)" : `inserted ${body.inserted}`;
            console.log(`  POST ${statement.periodStart}: OK — ${tag}`);
            // The sweep runs ONLY after this day's statement is safely stored
            // (a replay no-op counts): the ledger is the record, the sweep is
            // the action taken on it.
            if (args.sweep && !(await sweepDay(args, sweepSecret, statement, stalled))) {
                hadError = true;
                break;
            }
        } else if (status === 409) {
            hadError = true;
            console.error(`  POST ${statement.periodStart}: 409 CONFLICT — the stored day differs from this file. Bank-side restatement? A HUMAN SHOULD LOOK. ${JSON.stringify(body)}`);
            // S2: stop here — later days chain off this day's balances, and
            // posting them against a disputed base would bake the
            // discontinuity into the DB. Resolve this day first.
            stalled();
            break;
        } else {
            hadError = true;
            console.error(`  POST ${statement.periodStart}: HTTP ${status} ${JSON.stringify(body)}`);
            stalled();
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
