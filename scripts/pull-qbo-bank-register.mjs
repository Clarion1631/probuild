// QBO bank REGISTER REPORT for the WTB checking account (…0723).
//
// WHY THIS EXISTS (2026-08-21): Justin rotated the Washington Trust password,
// so the browser-based daily CSV export (skill wtb-daily-bank-export) has no
// valid credentials and is dead as the primary bank-register source. The
// QuickBooks bank feed carries the same transactions over OAuth — no login
// page, no 2FA, no session to lose. This script is the human-readable
// per-day register view of that feed.
//
// WHAT IT SHOWS: per calendar day — transaction count, money in, money out,
// net, and (when QBO's running-balance column reconciles exactly) the derived
// per-day opening/closing balance. Every figure is integer cents from QBO's
// decimal strings; no float math on the way in.
//
// HONESTY CONTRACT (same as src/lib/qbo-bank-register.ts): this is the BOOKS
// view — what QuickBooks has POSTED to the account. It cannot see WTB
// transactions that are pending, excluded from the feed, or absent from
// QuickBooks, and it does not prove bank clearance. The derived balances are
// QBO's book balances, NOT the bank's statement OPENING/CLOSING LEDGER.
//
// WHY --post IS BLOCKED (deliberate, not unfinished):
//   1. The ingest route's STATEMENT source is reserved for the bank's own
//      statement — true north. QBO book balances routinely differ from the
//      bank's ledger balances (feed lag ~1 day, uncleared checks, excluded
//      feed rows), so a QBO-derived "statement" would assert control totals
//      the bank never published. That is exactly the faked-balance failure
//      docs/BANK-REGISTER-PLAN.md forbids.
//   2. STATEMENT days for WTB-0723 are already minted by
//      scripts/parse-wtb-daily-csv.mjs under the route's uniqueness key
//      (account, periodStart, periodEnd). QBO-derived one-day statements for
//      the same account would either 409 against every existing day (books
//      vs bank content differs) or, on uncovered days, mint canonical
//      BankLines from non-bank evidence — the cross-source double-minting
//      the Codex B1 review exists to prevent.
//   3. The sanctioned QBO→ledger path already exists and is live:
//      scripts/post-qbo-register.mjs posts source=QBO_REGISTER observation
//      rows (idempotent by qbTxnId, 409 on content change), and the
//      reconcile route links them to canonical statement lines.
//   If the bank-statement balance source is ever restored (CSV re-enabled,
//   or an OFX pull lands), STATEMENT posting belongs there — not here.
//
// Usage (tsx required — the imported src/lib modules are TypeScript with
// "@/*" path aliases that bare node cannot resolve):
//   npx tsx scripts/pull-qbo-bank-register.mjs               # last 14 days
//   npx tsx scripts/pull-qbo-bank-register.mjs --days 30
//   npx tsx scripts/pull-qbo-bank-register.mjs --start 2026-08-01 --end 2026-08-20
//   npx tsx scripts/pull-qbo-bank-register.mjs --txns        # per-transaction detail
//
// Env: loads .env.production.local, then .env.local, then .env itself
// (first file that defines a key wins; a value already in process.env always
// wins). .env.production.local is preferred because the QBO OAuth client
// creds (QB_CLIENT_ID/QB_CLIENT_SECRET) and the NEXTAUTH_SECRET that
// decrypts the stored token row exist only in the prod env pull.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DAYS = 14;
// fetchBankRegister enforces 92; mirror it so the error is ours, not a stack trace.
const MAX_RANGE_DAYS = 92;
// The account this report is for. Refuse to render anything else so a future
// second bank account can't silently masquerade as WTB checking.
const EXPECTED_LAST4 = "0723";

// ── env ─────────────────────────────────────────────────────────────────────

/**
 * Minimal .env parser (KEY=value, optional double quotes, # comments).
 * Precedence: existing process.env > .env.production.local > .env.local > .env
 * — prod values first because this script only makes sense against prod QBO,
 * and the prod NEXTAUTH_SECRET is the one that decrypts the Integration row.
 */
function loadEnvFiles() {
    const loaded = [];
    for (const file of [".env.production.local", ".env.local", ".env"]) {
        const full = path.join(REPO_ROOT, file);
        if (!fs.existsSync(full)) continue;
        const text = fs.readFileSync(full, "utf8").replace(/^\uFEFF/, "");
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (!m) continue;
            let [, key, value] = m;
            if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
                value = value.slice(1, -1);
            }
            if (!(key in process.env)) process.env[key] = value;
        }
        loaded.push(file);
    }
    return loaded;
}

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = { days: DEFAULT_DAYS, start: null, end: null, txns: false, post: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--txns") args.txns = true;
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
            // Consume the value if present so the refusal message is accurate,
            // but never act on it — see the header comment.
            const v = argv[i + 1];
            if (v !== undefined && !v.startsWith("--")) i++;
            args.post = v ?? "(no url)";
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if ((args.start === null) !== (args.end === null)) throw new Error("--start and --end must be given together");
    return args;
}

/** Strict YYYY-MM-DD with calendar round-trip ("2026-02-30" must fail). */
function isYmd(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** UTC-only date math — local timezone must never shift a posting date. */
function ymdDaysAgo(days) {
    return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// ── money ───────────────────────────────────────────────────────────────────

/**
 * Exact decimal-string → integer cents. Refuses anything that isn't a plain
 * signed decimal with ≤2 fraction digits (financial-data-pipelines rule 1).
 * QBO report cells arrive as decimal strings; never parseFloat them.
 */
export function toCents(raw) {
    const s = String(raw ?? "").trim();
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) return null;
    const [, sign, whole, frac = ""] = m;
    const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents)) return null;
    return sign === "-" ? -cents : cents;
}

const money = c => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── balance derivation (GL report with running-balance column) ──────────────

/**
 * Fetch the GL report AGAIN, this time asking for the running-balance column
 * (rbal_nat_amount) so per-day book balances can be DERIVED rather than
 * guessed. Returns { openingCents, rows: [{date, amountCents, runbalCents}] }
 * or null when the report doesn't carry a usable balance chain.
 *
 * The derivation is only trusted when it proves itself: every row must
 * satisfy previous_balance + amount == running_balance in exact integer
 * cents, chaining from the report's Beginning Balance row. One break → the
 * whole chain is discarded and the report prints "n/a" for balances.
 * (financial-data-pipelines rule 2: control totals refuse to ship.)
 */
async function fetchBalanceChain(qbFetch, tokens, accountId, startDate, endDate) {
    const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
        account: accountId,
        columns: "tx_date,txn_type,subt_nat_amount,rbal_nat_amount",
    });
    const res = await qbFetch(`/reports/GeneralLedger?${params}`, tokens);
    if (!res.ok) return { ok: false, reason: `GL balance report HTTP ${res.status}` };
    const report = await res.json();

    // Column order comes from the report's own Columns block, never assumed.
    const idx = new Map();
    (report.Columns?.Column ?? []).forEach((col, i) => {
        for (const meta of col.MetaData ?? []) {
            if (meta.Name === "ColKey" && meta.Value) idx.set(meta.Value, i);
        }
    });
    if (!idx.has("tx_date") || !idx.has("subt_nat_amount") || !idx.has("rbal_nat_amount")) {
        return { ok: false, reason: "GL report did not return the running-balance column" };
    }

    const flat = [];
    (function walk(rows) {
        for (const row of rows ?? []) {
            if (row.ColData) flat.push(row.ColData);
            if (row.Rows?.Row) walk(row.Rows.Row);
        }
    })(report.Rows?.Row ?? []);

    let openingCents = null;
    const rows = [];
    for (const cols of flat) {
        const cell = key => cols[idx.get(key)]?.value;
        const label = String(cell("tx_date") ?? "").trim();
        const txnType = String(cols[idx.get("txn_type")]?.value ?? "").trim();
        const runbal = toCents(cell("rbal_nat_amount"));
        // The section's Beginning Balance line: no txn type, carries the
        // starting running balance. QBO renders its label in the first column.
        if (!txnType && /beginning balance/i.test(label) && runbal !== null) {
            if (openingCents !== null && openingCents !== runbal) {
                return { ok: false, reason: "conflicting Beginning Balance rows" };
            }
            openingCents = runbal;
            continue;
        }
        if (!txnType) continue; // other summary/total lines
        const date = isYmd(label) ? label : null;
        const amount = toCents(cell("subt_nat_amount"));
        if (!date || amount === null || runbal === null) {
            return { ok: false, reason: `unparseable GL balance row (date "${label}")` };
        }
        rows.push({ date, amountCents: amount, runbalCents: runbal });
    }
    if (openingCents === null) return { ok: false, reason: "no Beginning Balance row in GL report" };

    // The chain must PROVE itself: opening + each amount → each running balance.
    let bal = openingCents;
    for (const row of rows) {
        bal += row.amountCents;
        if (bal !== row.runbalCents) {
            return { ok: false, reason: `balance chain breaks at ${row.date}: expected ${bal} got ${row.runbalCents}` };
        }
    }
    return { ok: true, openingCents, rows };
}

// ── report ──────────────────────────────────────────────────────────────────

function buildDaySummaries(rows) {
    // rows arrive newest-first from fetchBankRegister; group by date ascending.
    const byDay = new Map();
    for (const row of rows) {
        if (!byDay.has(row.date)) byDay.set(row.date, { count: 0, inCents: 0, outCents: 0 });
        const d = byDay.get(row.date);
        d.count++;
        if (row.amountCents >= 0) d.inCents += row.amountCents;
        else d.outCents += row.amountCents;
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([date, d]) => ({ date, ...d, netCents: d.inCents + d.outCents }));
}

function fail(msg) {
    console.error(`GATE FAILED: ${msg}`);
    process.exitCode = 1;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.post !== null) {
        console.error("--post is BLOCKED for this script, deliberately:");
        console.error("  • QBO is the BOOKS view. Its balances are not the bank's OPENING/CLOSING");
        console.error("    LEDGER, so a QBO-derived STATEMENT would assert control totals the bank");
        console.error("    never published (feed lag, uncleared checks, excluded rows).");
        console.error("  • STATEMENT days for WTB-0723 are owned by scripts/parse-wtb-daily-csv.mjs");
        console.error("    under the (account, periodStart, periodEnd) uniqueness key — QBO-derived");
        console.error("    days would 409 against them or double-mint canonical BankLines.");
        console.error("  • The sanctioned QBO→ledger path already exists:");
        console.error("      npx tsx scripts/post-qbo-register.mjs --days 30 --post <baseUrl>");
        console.error("    (source=QBO_REGISTER observations, idempotent by qbTxnId).");
        console.error("  Restore a real bank-statement source (CSV/OFX) for STATEMENT posting.");
        process.exit(1);
    }

    const loaded = loadEnvFiles();
    if (loaded.length === 0) fail("no .env file found next to the repo root");
    for (const key of ["DATABASE_URL", "NEXTAUTH_SECRET", "QB_CLIENT_ID", "QB_CLIENT_SECRET"]) {
        if (!process.env[key]) return fail(`${key} missing — run 'vercel env pull .env.production.local' first (loaded: ${loaded.join(", ")})`);
    }
    if (!/pgbouncer=true/.test(process.env.DATABASE_URL)) {
        console.error("WARNING: DATABASE_URL lacks ?pgbouncer=true — Supabase pooler + Prisma needs it.");
    }

    const endDate = args.end ?? new Date().toISOString().slice(0, 10);
    const startDate = args.start ?? ymdDaysAgo(args.days);
    if (startDate > endDate) return fail("start date is after end date");

    // Imported AFTER env is loaded — src/lib/prisma reads DATABASE_URL at
    // import time, and integration-store decrypts with NEXTAUTH_SECRET.
    // These are TypeScript with "@/*" aliases: run this script under tsx.
    const { fetchBankRegister, bankAccountId } = await import("../src/lib/qbo-bank-register.ts");
    const { getFreshQBTokens } = await import("../src/lib/quickbooks-payments.ts");
    const { qbFetch, qbQuery } = await import("../src/lib/quickbooks.ts");

    const tokens = await getFreshQBTokens();

    // 1) Account verification: the register must provably be the WTB …0723
    //    checking account, not whatever account id happens to be configured.
    const accountId = bankAccountId();
    const bankAccounts = await qbQuery(tokens, "SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 100");
    const target = bankAccounts.find(a => String(a.Id) === String(accountId));
    if (!target) return fail(`configured bank account id ${accountId} not found among ${bankAccounts.length} QBO bank account(s)`);
    const acctNum = String(target.AcctNum ?? "");
    const acctLabel = `${target.Name}${acctNum ? ` (#…${acctNum.slice(-4)})` : ""}`;
    const looks0723 = acctNum.endsWith(EXPECTED_LAST4) || new RegExp(EXPECTED_LAST4).test(target.Name ?? "");
    if (!looks0723) {
        const other = bankAccounts.find(a => String(a.AcctNum ?? "").endsWith(EXPECTED_LAST4) || new RegExp(EXPECTED_LAST4).test(a.Name ?? ""));
        if (other) return fail(`configured account ${accountId} (${acctLabel}) is NOT the …${EXPECTED_LAST4} account — QBO account ${other.Id} (${other.Name}) is. Set QBO_RECEIPT_BANK_ACCOUNT_ID.`);
        console.error(`WARNING: cannot confirm account ${accountId} (${acctLabel}) is …${EXPECTED_LAST4} — no QBO bank account carries that number. Proceeding; verify in QBO.`);
    }

    // 2) The register rows (same proven path the /automation/bank page uses).
    const result = await fetchBankRegister(() => Promise.resolve(tokens), startDate, endDate);
    const rows = result.rows ?? [];

    // 3) Balance chain (books view) — display-only, and only if it proves itself.
    let chain = { ok: false, reason: "not attempted" };
    try {
        chain = await fetchBalanceChain(qbFetch, tokens, accountId, startDate, endDate);
    } catch (error) {
        chain = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    // 4) Print.
    const days = buildDaySummaries(rows);
    console.log(`REGISTER REPORT — QBO books view of ${acctLabel}`);
    console.log(`  realm ${tokens.realmId}, QBO account id ${accountId}`);
    console.log(`  window ${startDate} → ${endDate}${result.stale ? "  [STALE CACHE — QBO errored, showing last good fetch]" : ""}`);
    console.log(`  ${rows.length} posted row(s) across ${days.length} day(s). Books balance chain: ${chain.ok ? "VERIFIED (exact cents)" : `n/a — ${chain.reason}`}`);
    if (typeof target.CurrentBalance !== "undefined") {
        console.log(`  QBO CurrentBalance (books, as of now): ${money(toCents(String(target.CurrentBalance)) ?? NaN)}`);
    }
    console.log("  NOTE: books view only — pending/unfed bank activity is invisible; balances are NOT the bank's ledger.");
    console.log("");
    console.log("  date         txns      money in     money out           net" + (chain.ok ? "     open(books)    close(books)" : ""));
    console.log("  ----------  -----  ------------  ------------  ------------" + (chain.ok ? "  --------------  --------------" : ""));

    // Per-day close from the verified chain: opening + cumulative net of every
    // chain row dated ≤ that day (chain rows are the same GL rows, so the two
    // fetches agree; if they ever disagree the sums below expose it).
    let closeByDay = new Map();
    if (chain.ok) {
        let bal = chain.openingCents;
        const sortedChain = [...chain.rows].sort((a, b) => a.date.localeCompare(b.date));
        for (const row of sortedChain) {
            bal += row.amountCents;
            closeByDay.set(row.date, bal);
        }
    }
    let prevClose = chain.ok ? chain.openingCents : null;
    for (const d of days) {
        let balCols = "";
        if (chain.ok) {
            const close = closeByDay.get(d.date);
            if (close !== undefined && prevClose !== null && prevClose + d.netCents === close) {
                balCols = `  ${money(prevClose).padStart(14)}  ${money(close).padStart(14)}`;
                prevClose = close;
            } else {
                // The two GL fetches disagreed for this day — say so, never guess.
                balCols = "  " + "chain mismatch".padStart(30);
                prevClose = close ?? prevClose;
            }
        }
        console.log(`  ${d.date}  ${String(d.count).padStart(5)}  ${money(d.inCents).padStart(12)}  ${money(d.outCents).padStart(12)}  ${money(d.netCents).padStart(12)}${balCols}`);
    }
    const totalIn = days.reduce((a, d) => a + d.inCents, 0);
    const totalOut = days.reduce((a, d) => a + d.outCents, 0);
    console.log("  ----------  -----  ------------  ------------  ------------");
    console.log(`  TOTAL       ${String(rows.length).padStart(5)}  ${money(totalIn).padStart(12)}  ${money(totalOut).padStart(12)}  ${money(totalIn + totalOut).padStart(12)}`);

    if (args.txns) {
        console.log("");
        console.log("  TRANSACTIONS (newest first)");
        for (const row of rows) {
            console.log(`   ${row.date}  ${money(row.amountCents).padStart(12)}  ${(row.qbType ?? "").padEnd(18)}  ${(row.name ?? "").slice(0, 40)}${row.qbTxnId ? `  [${row.qbTxnId}]` : ""}`);
        }
    }

    console.log("");
    console.log("  Ledger posting: use scripts/post-qbo-register.mjs (source=QBO_REGISTER observations).");
    console.log("  STATEMENT posting stays with the bank's own statement source (see header).");
}

// Entry check must survive being imported by tests: process.argv[1] can be
// undefined under `node -e`, and pathToFileURL(undefined) throws.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error); process.exit(1); });
}
