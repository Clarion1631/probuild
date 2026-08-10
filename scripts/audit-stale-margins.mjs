// READ-ONLY audit of EstimateItem rows whose persisted `markupPercent` no longer
// describes the budget rate / sell price pair stored beside it.
//
// Background: PR #331 added a row-level warning for that shape (editing a sell
// price before that path re-derived the margin left price 200 next to rate 75 and
// a stored 25% while the line really ran 62.5%). The editor can no longer CREATE
// such a row and any edit self-heals one, but nothing repairs history — so this
// exists to answer "how much history is there?".
//
// THIS SCRIPT NEVER WRITES. There is no UPDATE, INSERT or DELETE in this file and
// no --apply flag. When it was first run against prod (2026-08-09) it found ZERO
// stale rows out of 938 candidates — the largest discrepancy in the table was
// 0.0046 percentage points, pure 2dp rounding — because the earlier margin
// backfill (scripts/backfill-estimate-item-margin.mjs, PR #329) had already
// converged markupPercent against baseCost/unitCost across the whole population.
// A repair pass was therefore deliberately NOT shipped. If a future run reports a
// non-zero count, the repair is to recompute markupPercent from the stored
// rate/price via `marginPatchForRate` — markupPercent is DERIVED, baseCost and
// unitCost are authoritative, and NO SELL PRICE OR BUDGET RATE MAY MOVE.
//
// WHAT "STALE" MEANS IS NOT REDEFINED HERE. The predicate is `marginIsStale()`
// from src/lib/budget-math.ts, called with exactly the values BudgetStrip.tsx
// derives from a row (rate = budgetRate ?? baseCost, price = unitCost,
// stored = markupPercent), so this script and the red warning in the editor can
// never disagree. The tolerance (0.005 + rate-rounding drift) lives inside that
// helper and is deliberately NOT re-derived here — see budget-math.ts for why a
// flat epsilon put a red warning on ordinary saves.
//
// Rows where `marginIsUnrepresentable` is true are counted separately and never
// reported as stale: those are the intentional cost-exceeds-sell / margin-over-99
// / no-sell-price warnings, not stale data.
//
// Usage (must run under tsx — this file imports the TypeScript helper directly so
// there is no second copy of the math to drift):
//   npx tsx scripts/audit-stale-margins.mjs             # full report
//   npx tsx scripts/audit-stale-margins.mjs --limit 50  # cap the samples printed
//
// Requires (read from env or .env / .env.local):
//   DATABASE_URL   Supabase transaction pooler URL (must include ?pgbouncer=true)
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import fs from "node:fs";
import * as budgetMathModule from "../src/lib/budget-math.ts";

// tsx transpiles the .ts helper to CJS while this .mjs stays native ESM, so the
// named exports land on `default` rather than on the namespace. Take whichever
// shape we got — the point is that there is exactly ONE copy of this math, the
// one the UI imports.
const { marginIsStale, marginIsUnrepresentable, rawMarginPct } =
  budgetMathModule.default ?? budgetMathModule;
for (const [name, fn] of Object.entries({ marginIsStale, marginIsUnrepresentable, rawMarginPct })) {
  if (typeof fn !== "function") {
    throw new Error(`Could not load budget-math helper \`${name}\` — run this script with \`npx tsx\`, not bare \`node\`.`);
  }
}

const limitArg = process.argv.indexOf("--limit");
let SAMPLE_LIMIT = 20;
if (limitArg >= 0) {
  // Strict: a typo must not silently become 0 samples (`parseInt` alone turns "1e3" into 1 and
  // a missing value into NaN). An audit that prints nothing looks the same as a clean table.
  const raw = process.argv[limitArg + 1];
  // isSafeInteger as well as the digit test: a long enough run of digits passes /^\d+$/ but
  // converts to Infinity, and `slice(0, Infinity)` would dump every row instead of a sample.
  const parsed = raw === undefined ? NaN : Number(raw);
  if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    throw new Error(`--limit needs a non-negative integer, got ${raw === undefined ? "nothing" : `"${raw}"`}`);
  }
  SAMPLE_LIMIT = parsed;
}

/**
 * Read a key from the environment, then from the dotenv files in the order the Next.js
 * toolchain resolves them: `.env.local` OVERRIDES `.env`. Checking `.env` first would let a
 * committed default silently win over the local override and point a production audit at the
 * WRONG DATABASE. (Every `envFromFiles` helper under scripts/ now shares this exact order — if
 * you add another, copy this one, not an older reversed variant. Note that many other scripts
 * under scripts/ still resolve env under different helper names and STILL have the reversed
 * order; those are tracked separately.)
 *
 * Parsing is delegated to `dotenv` rather than hand-rolled. A regex over the line looks fine
 * until it meets the cases that actually occur — quoted values containing `#`, `export`
 * prefixes, inline comments, CRLF, multiline values — and each one it gets wrong is a silent
 * wrong-database read, which is the one failure this script must not have.
 *
 * `in` rather than a truthiness check on purpose, at BOTH levels: a source that assigns the key
 * an EMPTY value has still spoken, and must win over every lower-precedence source instead of
 * falling through to it. The missing-URL check below then fails loudly, which is the correct
 * outcome. An exported `DATABASE_URL=""` falling through to a file is the same wrong-database
 * read as the reversed file order, just one level up.
 */
function envFromFiles(key) {
  if (key in process.env) return process.env[key];
  for (const f of [".env.local", ".env"]) {
    if (!fs.existsSync(f)) continue;
    const parsed = dotenv.parse(fs.readFileSync(f));
    if (key in parsed) return parsed[key];
  }
  return undefined;
}

const DATABASE_URL = envFromFiles("DATABASE_URL");
if (!DATABASE_URL) throw new Error("DATABASE_URL not found in env or .env files");
if (!DATABASE_URL.includes("pgbouncer=true")) {
  console.warn("⚠ DATABASE_URL has no pgbouncer=true — expected the Supabase transaction pooler. Continuing.");
}

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

// Candidate rows only. Everything is fetched as text and parsed with parseFloat so
// the numbers fed to the helpers are bit-for-bit what BudgetStrip.tsx works with
// (Prisma serializes Decimal to a string and the component parseFloats it).
//
// The WHERE clause is a cheap pre-filter, NOT the definition of stale — every row
// it returns is still put through marginIsStale() below. COALESCE mirrors the
// component's `budgetRate ?? baseCost`, so an explicitly-stored rate of 0 reads as
// "no budget" here exactly as it does there.
const CANDIDATE_SQL = `
  SELECT
    i."id"                                        AS "id",
    i."estimateId"                                AS "estimateId",
    e."code"                                      AS "estimateCode",
    e."projectId"                                 AS "projectId",
    e."leadId"                                    AS "leadId",
    COALESCE(i."budgetRate", i."baseCost")::text  AS "rateText",
    i."unitCost"::text                            AS "priceText",
    i."markupPercent"::text                       AS "marginText"
  FROM "EstimateItem" i
  JOIN "Estimate" e ON e."id" = i."estimateId"
  WHERE COALESCE(i."budgetRate", i."baseCost") IS NOT NULL
    AND i."unitCost" IS NOT NULL
  ORDER BY i."id" ASC
`;

/**
 * Linear-interpolated percentile over an ascending array. Interpolation rather than a rounded
 * index because rounding reports a real data point that can sit well off the true quantile —
 * with deltas [1, 9] a rounded index calls the median 9 instead of 5, which would overstate a
 * small prod population by a lot.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

(async () => {
  console.log("Mode: AUDIT (read-only — this script has no write path)\n");

  const candidates = await prisma.$queryRawUnsafe(CANDIDATE_SQL);

  const stale = [];
  const unrepresentable = [];

  for (const row of candidates) {
    // Same parse the component does: blank is genuinely "no budget"; anything else
    // keeps whatever it parses to, NaN included, so a bad rate is not hidden.
    const rateText = row.rateText == null ? "" : String(row.rateText).trim();
    const rate = rateText === "" ? 0 : parseFloat(rateText);
    const price = parseFloat(row.priceText) || 0;
    const stored = row.marginText == null ? null : parseFloat(row.marginText);

    if (marginIsUnrepresentable(rate, price)) {
      unrepresentable.push({ ...row, rate, price, stored });
      continue;
    }
    if (!marginIsStale(stored, rate, price)) continue;

    const trueMargin = rawMarginPct(rate, price);
    stale.push({ ...row, rate, price, stored, trueMargin, delta: Math.abs(trueMargin - stored) });
  }

  const estimates = new Set(stale.map((r) => r.estimateId));
  const owners = new Set(stale.map((r) => r.projectId ?? `lead:${r.leadId}`));
  const deltas = stale.map((r) => r.delta).sort((a, b) => a - b);

  console.log(`${candidates.length} candidate row(s) scanned (a rate and a unit cost both present).`);
  console.log(`${stale.length} row(s) STALE — stored margin disagrees with the rate/price beside it.`);
  console.log(`  across ${estimates.size} estimate(s) and ${owners.size} project(s)/lead(s).`);
  console.log(
    `${unrepresentable.length} row(s) unrepresentable (cost exceeds sell / margin over 99 / no sell price) — intentional warnings, not stale data.\n`
  );

  if (stale.length > 0) {
    console.log("Discrepancy spread (percentage points of margin):");
    console.log(`  min    ${deltas[0].toFixed(4)}`);
    console.log(`  p25    ${percentile(deltas, 25).toFixed(4)}`);
    console.log(`  median ${percentile(deltas, 50).toFixed(4)}`);
    console.log(`  p75    ${percentile(deltas, 75).toFixed(4)}`);
    console.log(`  p95    ${percentile(deltas, 95).toFixed(4)}`);
    console.log(`  max    ${deltas[deltas.length - 1].toFixed(4)}\n`);

    console.log(`Sample (up to ${SAMPLE_LIMIT}):`);
    for (const r of stale.slice(0, SAMPLE_LIMIT)) {
      console.log(
        `  id=${r.id} est=${r.estimateCode} rate=${r.rateText} price=${r.priceText} stored=${r.stored}% -> true=${r.trueMargin.toFixed(4)}%`
      );
    }
    if (stale.length > SAMPLE_LIMIT) console.log(`  ...and ${stale.length - SAMPLE_LIMIT} more.`);
    console.log("");
  }

  if (unrepresentable.length > 0) {
    console.log(`Unrepresentable rows (review by hand), up to ${SAMPLE_LIMIT}:`);
    for (const r of unrepresentable.slice(0, SAMPLE_LIMIT)) {
      console.log(`  id=${r.id} est=${r.estimateCode} rate=${r.rateText} price=${r.priceText} stored=${r.stored}%`);
    }
    if (unrepresentable.length > SAMPLE_LIMIT) console.log(`  ...and ${unrepresentable.length - SAMPLE_LIMIT} more.`);
    console.log("");
  }

  console.log("Audit complete — no writes made (none possible).");
})()
  .catch((e) => {
    console.error("Audit failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
