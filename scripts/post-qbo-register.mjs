// QBO bank register → bank-ledger ingest (source=QBO_REGISTER).
//
// THIN WRAPPER. The fetch + convert logic this script used to own now lives in
// `src/lib/bank-register-pull.ts` so the nightly server-side cron
// (/api/cron/bank-register-pull, 02:00 UTC) and this manual runner share ONE
// implementation. Keep this script for ad-hoc/backfill windows — for the
// day-to-day pull, the cron is the thing that runs.
//
// THE MISSING PIPE (found 2026-08-19 while surveying the live error state):
// the ingest route has full QBO_REGISTER support — createQboObservations(),
// race handling, content-conflict detection, all built and peer-reviewed —
// and the reconcile route is ready to link those observations to canonical
// BankLines. But NOTHING ever called it. Prod had 51 STATEMENT observations
// and 0 QBO ones, so reconcile had nothing to match, every BankLine sat at
// POSTED forever, and receipt-matching was starved of its only input.
//
// WHAT THIS IS NOT: it does not create, edit, or void anything in
// QuickBooks. QBO stays read-only (money-map rule 2). Observations are
// CORROBORATING EVIDENCE — the bank statement remains true north. Linking an
// observation to a canonical line is a separate, explicit step (the
// reconcile route), never an ingest-time side effect.
//
// Idempotency: the observation identity is (source, account,
// sourceDocumentId="QBO_REGISTER", sourceLineId=qbTxnId). Re-running over an
// overlapping window is a no-op. If a qbTxnId already exists with DIFFERENT
// content (QBO edited an amount/date after we recorded it), the route
// answers 409 — a real restatement that a human must look at, never
// silently overwritten.
//
// Usage:
//   node scripts/post-qbo-register.mjs --days 30 [--dry-run]
//   node scripts/post-qbo-register.mjs --start 2026-07-01 --end 2026-07-31 --post <baseUrl>
//
// Env: BANK_LEDGER_INGEST_SECRET (or INGEST_KEY). Never passed via argv.

import { pathToFileURL } from "node:url";

const INGEST_PATH = "/api/integrations/bank-ledger/ingest";
const DEFAULT_ACCOUNT = "WTB-0723";
const POST_TIMEOUT_MS = 30_000;
// QBO's report endpoint caps a single fetch; fetchBankRegister enforces 92.
const MAX_RANGE_DAYS = 92;
// The ingest route's own per-request line cap (see MAX_LINES there).
const CHUNK_SIZE = 500;

function parseArgs(argv) {
    const args = { days: 30, start: null, end: null, dryRun: false, post: null, account: DEFAULT_ACCOUNT };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") args.dryRun = true;
        else if (arg === "--days") {
            const v = Number(argv[++i]);
            if (!Number.isInteger(v) || v < 1 || v > MAX_RANGE_DAYS) throw new Error(`--days must be 1..${MAX_RANGE_DAYS}`);
            args.days = v;
        } else if (arg === "--start") {
            const v = argv[++i];
            if (!isYmd(v)) throw new Error("--start must be YYYY-MM-DD");
            args.start = v;
        } else if (arg === "--end") {
            const v = argv[++i];
            if (!isYmd(v)) throw new Error("--end must be YYYY-MM-DD");
            args.end = v;
        } else if (arg === "--post") {
            const v = argv[++i];
            if (v === undefined || v.startsWith("--")) throw new Error("--post requires a base URL argument");
            args.post = v;
        } else if (arg === "--account") {
            const v = argv[++i];
            if (v === undefined || v.startsWith("--")) throw new Error("--account requires a value");
            if (v !== DEFAULT_ACCOUNT) throw new Error(`--account ${v} does not match this register's account (${DEFAULT_ACCOUNT})`);
            args.account = v;
        }
    }
    if ((args.start === null) !== (args.end === null)) throw new Error("--start and --end must be given together");
    return args;
}

/** Strict YYYY-MM-DD with a true calendar round-trip ("2026-02-30" must fail). */
function isYmd(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** UTC-only date math — no local timezone can shift a posting date. */
function ymdDaysAgo(days) {
    return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function postLines(baseUrl, secret, account, lines) {
    const res = await fetch(new URL(INGEST_PATH, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": secret },
        body: JSON.stringify({ source: "QBO_REGISTER", account, lines }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    return { status: res.status, body };
}

function fail(msg) {
    console.error(`GATE FAILED: ${msg}`);
    process.exitCode = 1;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const endDate = args.end ?? new Date().toISOString().slice(0, 10);
    const startDate = args.start ?? ymdDaysAgo(args.days);
    if (startDate > endDate) return fail("start date is after end date");

    // Imported lazily so --help-ish misuse fails before touching QBO creds.
    // Paths verified against the repo: fetchBankRegister lives in
    // qbo-bank-register, and the OAuth helper the /automation pages pass to it
    // is getFreshQBTokens from quickbooks-payments (there is no qbo-tokens.ts).
    const { fetchBankRegister } = await import("../src/lib/qbo-bank-register.ts");
    const { getFreshQBTokens } = await import("../src/lib/quickbooks-payments.ts");
    // ONE convert implementation, shared with /api/cron/bank-register-pull.
    const { convertRegisterRows } = await import("../src/lib/bank-register-pull.ts");

    const result = await fetchBankRegister(getFreshQBTokens, startDate, endDate);
    const rows = result.rows ?? [];
    const { lines: unique, skipped, collapsed } = convertRegisterRows(rows);

    console.log(`QBO register ${startDate} → ${endDate}${result.stale ? "  [STALE CACHE]" : ""}`);
    console.log(`  ${rows.length} GL row(s) → ${unique.length} observation(s)  (${skipped} non-txn skipped, ${collapsed} duplicate txn id collapsed)`);
    for (const line of unique.slice(0, 10)) {
        console.log(`   ${line.postedDate}  ${(line.amountCents / 100).toFixed(2).padStart(11)}  ${line.rawDescriptor.slice(0, 58)}${line.checkNumber ? `  chk#${line.checkNumber}` : ""}`);
    }
    if (unique.length > 10) console.log(`   … ${unique.length - 10} more`);

    if (args.dryRun || !args.post) {
        if (!args.post) console.log("(no --post; dry run only)");
        return;
    }
    if (unique.length === 0) { console.log("nothing to post"); return; }

    const secret = process.env.BANK_LEDGER_INGEST_SECRET || process.env.INGEST_KEY;
    if (!secret) return fail("--post requires BANK_LEDGER_INGEST_SECRET or INGEST_KEY in the environment");

    const batches = chunk(unique, CHUNK_SIZE);
    let inserted = 0, hadError = false;
    for (let i = 0; i < batches.length; i++) {
        const { status, body } = await postLines(args.post, secret, args.account, batches[i]);
        const label = `batch ${i + 1}/${batches.length} (${batches[i].length} line(s))`;
        if (status === 200 && body?.ok) {
            inserted += body.inserted ?? 0;
            console.log(`  POST ${label}: OK — inserted ${body.inserted ?? 0}, existing ${body.existing ?? 0}`);
        } else if (status === 409) {
            hadError = true;
            console.error(`  POST ${label}: 409 CONFLICT — QuickBooks changed a transaction we already recorded. A HUMAN SHOULD LOOK. ${JSON.stringify(body)}`);
            console.error(`  Stopping: later batches are not attempted while a restatement is unresolved.`);
            break;
        } else {
            hadError = true;
            console.error(`  POST ${label}: HTTP ${status} ${JSON.stringify(body)}`);
            console.error(`  Stopping — resolve this failure first.`);
            break;
        }
    }
    console.log(`total inserted: ${inserted}`);
    if (hadError) process.exitCode = 1;
}

// Entry check must survive being imported by tests: process.argv[1] can be
// undefined under `node -e`, and pathToFileURL(undefined) throws.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error); process.exit(1); });
}
