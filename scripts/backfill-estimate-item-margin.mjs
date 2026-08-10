// One-time backfill: correct EstimateItem.markupPercent for rows written by the
// old markup-on-cost writers, so the column agrees with the canonical semantic
// (gross margin % on sell price — see src/lib/budget-math.ts).
//
// Only markupPercent is ever written by this script. It NEVER touches unitCost,
// total, baseCost, or any estimate/invoice total — those are the customer-facing
// prices and must not move. (Assertion: the only UPDATE statement in this file
// sets exactly one column, "markupPercent".)
//
// Target rows: baseCost and unitCost are both known and positive, and the stored
// markupPercent disagrees (by more than a rounding tolerance) with the margin
// implied by baseCost/unitCost — i.e. rows priced under the old
// markup-on-cost formula (unitCost = baseCost * (1 + markupPercent/100)) instead
// of the canonical margin formula (unitCost = baseCost / (1 - markupPercent/100)).
//
// Derived value: markupPercent = (1 - baseCost/unitCost) * 100, rounded to 2
// decimals, clamped to [0, 99] to match derivedMarginPct() in budget-math.ts.
//
// STRICTLY LOSS-MAKING ROWS ARE NOT WRITTEN. Where baseCost > unitCost (cost
// exceeds sell) the true margin is negative, and the [0, 99] clamp would stamp
// "0%" over the stored value — making a line item that loses money look like it
// merely breaks even. Those rows are reported for human review instead, and left
// exactly as they are. Where baseCost == unitCost (break-even / pass-through),
// the true margin is exactly 0 and IS corrected — that is not a loss.
//
// SAFE TO RE-RUN: idempotent — once a row's stored markupPercent matches the
// derived value it drops out of the target set. The predicate compares against
// the CLAMPED, ROUNDED value, which is what actually gets written; comparing
// against the raw margin instead meant a row whose true margin exceeds 99 was
// written as 99, still differed from its raw value, and was rewritten on every
// run — reported as "differing" forever despite already being correct.
//
// Usage:
//   node scripts/backfill-estimate-item-margin.mjs            # dry run — report only, no writes
//   node scripts/backfill-estimate-item-margin.mjs --apply    # write corrected markupPercent
//
// Requires (read from env or .env / .env.local):
//   DATABASE_URL   Supabase transaction pooler URL (must include ?pgbouncer=true)
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");

/**
 * Read a key from the environment, then from the dotenv files in the order the Next.js
 * toolchain resolves them: `.env.local` OVERRIDES `.env`. Checking `.env` first would let a
 * committed default silently win over the local override and point this script at the WRONG
 * DATABASE — and unlike the sibling audit, this one has a real `--apply` write path that
 * UPDATEs EstimateItem.markupPercent.
 *
 * Parsing is delegated to `dotenv` rather than hand-rolled. A regex over the line looks fine
 * until it meets the cases that actually occur — quoted values containing `#`, `export`
 * prefixes, inline comments, CRLF, multiline values — and each one it gets wrong is a silent
 * wrong-database write, which is the one failure this script must not have.
 *
 * `in` rather than a truthiness check on purpose, at BOTH levels: a source that assigns the key
 * an EMPTY value has still spoken, and must win over every lower-precedence source instead of
 * falling through to it. The missing-URL check below then fails loudly, which is the correct
 * outcome. An exported `DATABASE_URL=""` falling through to a file is the same wrong-database
 * write as the reversed file order, just one level up.
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

// Rows where the stored markupPercent disagrees with the margin implied by
// baseCost/unitCost by more than 0.01 percentage points.
const TARGET_SQL = `
  SELECT
    "id",
    "baseCost"::float8 AS "baseCost",
    "unitCost"::float8 AS "unitCost",
    "markupPercent" AS "storedMarkupPercent",
    LEAST(99, GREATEST(0, ROUND(((1 - "baseCost"::float8 / "unitCost"::float8) * 100)::numeric, 2)))::float8 AS "derivedMarginPct"
  FROM "EstimateItem"
  WHERE "baseCost" IS NOT NULL
    AND "baseCost" > 0
    AND "unitCost" > 0
    AND "baseCost" <= "unitCost"
    AND ABS("markupPercent" - LEAST(99, GREATEST(0, ROUND(((1 - "baseCost"::float8 / "unitCost"::float8) * 100)::numeric, 2)))::float8) > 0.01
  ORDER BY "id" ASC
`;

// Cost strictly exceeds sell price: true margin is negative. Reported, never written.
const LOSS_SQL = `
  SELECT
    "id",
    "baseCost"::float8 AS "baseCost",
    "unitCost"::float8 AS "unitCost",
    "markupPercent" AS "storedMarkupPercent",
    ROUND(((1 - "baseCost"::float8 / "unitCost"::float8) * 100)::numeric, 2)::float8 AS "trueMarginPct"
  FROM "EstimateItem"
  WHERE "baseCost" IS NOT NULL
    AND "baseCost" > 0
    AND "unitCost" > 0
    AND "baseCost" > "unitCost"
    -- Compared against the UNCLAMPED true margin on purpose. These rows are never
    -- written, so this is a report, not a convergence check: a loss row already
    -- storing 0 still misrepresents a negative margin and must stay visible.
    AND ABS("markupPercent" - (1 - "baseCost"::float8 / "unitCost"::float8) * 100) > 0.01
  ORDER BY "id" ASC
`;

(async () => {
  console.log(APPLY ? "Backfill mode: APPLY (writing corrected markupPercent)\n" : "Backfill mode: DRY RUN (pass --apply to write)\n");

  const [{ count: scanned }] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS count FROM "EstimateItem" WHERE "baseCost" IS NOT NULL AND "baseCost" > 0 AND "unitCost" > 0`
  );
  const [{ count: zeroBaseCost }] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS count FROM "EstimateItem" WHERE "baseCost" = 0 AND "unitCost" > 0`
  );
  const rows = await prisma.$queryRawUnsafe(TARGET_SQL);
  const lossRows = await prisma.$queryRawUnsafe(LOSS_SQL);

  console.log(`${scanned} row(s) scanned (baseCost and unitCost both known and positive).`);
  console.log(`${rows.length} row(s) differ from the derived margin by more than 0.01.`);
  console.log(`${zeroBaseCost} row(s) have baseCost = 0 with a positive unitCost — not touched by this script (not in scanned set).\n`);

  const sample = rows.slice(0, 20);
  if (sample.length > 0) {
    console.log("Sample (up to 20):");
    for (const r of sample) {
      console.log(
        `  id=${r.id} baseCost=${r.baseCost} unitCost=${r.unitCost} stored=${r.storedMarkupPercent}% -> derived=${r.derivedMarginPct}%`
      );
    }
    console.log("");
  }

  if (lossRows.length > 0) {
    console.log(
      `⚠ ${lossRows.length} row(s) are strictly loss-making (cost exceeds sell): baseCost > unitCost.`
    );
    console.log("  NOT written — a clamp to 0% would disguise a loss. Review these by hand:");
    for (const r of lossRows.slice(0, 20)) {
      console.log(
        `  id=${r.id} baseCost=${r.baseCost} unitCost=${r.unitCost} stored=${r.storedMarkupPercent}% -> true margin=${r.trueMarginPct}%`
      );
    }
    if (lossRows.length > 20) console.log(`  ...and ${lossRows.length - 20} more.`);
    console.log("");
  }

  if (!APPLY) {
    console.log("Dry run complete — no writes made. Pass --apply to update markupPercent.");
    return;
  }

  // Single set-based UPDATE, same WHERE predicate as TARGET_SQL, deriving the
  // value in SQL rather than SELECTing rows and writing back a preloaded value —
  // avoids N round-trips and avoids clobbering a concurrent edit with stale data.
  // markupPercent is the only column this statement may write.
  const updated = await prisma.$executeRawUnsafe(`
    UPDATE "EstimateItem"
    SET "markupPercent" = LEAST(99, GREATEST(0, ROUND(((1 - "baseCost"::float8 / "unitCost"::float8) * 100)::numeric, 2)))::float8
    WHERE "baseCost" IS NOT NULL
      AND "baseCost" > 0
      AND "unitCost" > 0
      AND "baseCost" <= "unitCost"
      AND ABS("markupPercent" - LEAST(99, GREATEST(0, ROUND(((1 - "baseCost"::float8 / "unitCost"::float8) * 100)::numeric, 2)))::float8) > 0.01
  `);
  console.log(`Updated ${updated} row(s).`);
})()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
