// READ-ONLY verification: confirm the section-header double-counting fix (3 sites patched
// against the canonical predicate in src/lib/estimate-item-payload.ts) reconciles against
// what's actually stored in prod. Never writes — findMany/$queryRaw SELECTs only.
//
// The two helpers below (`rm`, `computeEstimateItemTotals`, `computeEstimateSubtotal`) are a
// faithful line-for-line port of src/lib/estimate-item-payload.ts. This script is plain .mjs
// and cannot import the TS module directly, so the semantics — including the recursive
// nesting, the cycle guard, and the cent-rounding on the accumulated sum rather than each
// product — are reproduced here exactly. If that file changes, this port must be updated to
// match or the comparison is meaningless.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env.local", ".env"]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  throw new Error("DATABASE_URL not found");
}

const databaseUrl = resolveDatabaseUrl();
if (!databaseUrl.includes("pgbouncer=true")) {
  throw new Error("DATABASE_URL is missing ?pgbouncer=true — refusing to connect");
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

// ---- Ported verbatim from src/lib/estimate-item-payload.ts ----

const rm = (n) => Math.round(n * 100) / 100;

function num(value) {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeEstimateItemTotals(items) {
  const childIndexesByParent = new Map();
  const indexById = new Map();

  items.forEach((item, index) => {
    const id = item.id ? String(item.id) : null;
    if (id && !indexById.has(id)) indexById.set(id, index);
    const parentId = item.parentId ? String(item.parentId) : null;
    if (!parentId) return;
    const siblings = childIndexesByParent.get(parentId);
    if (siblings) siblings.push(index);
    else childIndexesByParent.set(parentId, [index]);
  });

  const isSectionAt = (index) => {
    const item = items[index];
    if (item.type === "Section") return true;
    const id = item.id ? String(item.id) : null;
    return !!id && childIndexesByParent.has(id);
  };

  const ROOTED = 1;
  const UNROOTED = 2;
  const rootedness = new Array(items.length).fill(0);
  for (let start = 0; start < items.length; start++) {
    if (rootedness[start] !== 0) continue;
    const path = [];
    const onPath = new Set();
    let cursor = start;
    let verdict = ROOTED;
    while (cursor !== undefined) {
      if (onPath.has(cursor)) { verdict = UNROOTED; break; }
      if (rootedness[cursor] !== 0) { verdict = rootedness[cursor]; break; }
      path.push(cursor);
      onPath.add(cursor);
      const parentId = items[cursor].parentId ? String(items[cursor].parentId) : null;
      cursor = parentId ? indexById.get(parentId) : undefined;
    }
    for (const index of path) rootedness[index] = verdict;
  }

  const resolved = new Array(items.length);

  const totalAt = (index) => {
    const cached = resolved[index];
    if (cached !== undefined) return cached;
    resolved[index] = 0;
    if (rootedness[index] === UNROOTED) return 0;

    const item = items[index];
    let total;
    if (isSectionAt(index)) {
      const id = item.id ? String(item.id) : null;
      const childIndexes = id ? childIndexesByParent.get(id) : undefined;
      total = rm((childIndexes ?? []).reduce((sum, childIndex) => sum + totalAt(childIndex), 0));
    } else {
      total = rm(num(item.quantity) * num(item.unitCost));
    }

    resolved[index] = total;
    return total;
  };

  return items.map((_item, index) => ({ isSection: isSectionAt(index), total: totalAt(index) }));
}

function computeEstimateSubtotal(items) {
  const totals = computeEstimateItemTotals(items);
  return rm(totals.reduce((sum, entry) => (entry.isSection ? sum : sum + entry.total), 0));
}

// ---- End port ----

function fmt(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function closeEnough(a, b) {
  return Math.abs(a - b) <= 0.01;
}

async function main() {
  const estimates = await prisma.estimate.findMany({
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      totalAmount: true,
      taxExempt: true,
      taxRatePercent: true,
      processingFeeMarkup: true,
      hideProcessingFee: true,
      items: {
        select: {
          id: true,
          parentId: true,
          type: true,
          quantity: true,
          unitCost: true,
          total: true,
          costCodeId: true,
          costType: { select: { name: true } },
        },
      },
    },
  });

  const totalEstimates = estimates.length;
  const sectioned = [];
  for (const est of estimates) {
    const items = est.items.map((it) => ({
      id: it.id,
      parentId: it.parentId,
      type: it.type,
      quantity: it.quantity,
      unitCost: it.unitCost == null ? 0 : Number(it.unitCost),
    }));
    const totals = computeEstimateItemTotals(items);
    const hasSection = totals.some((t) => t.isSection);
    if (hasSection) sectioned.push({ est, items, totals });
  }

  console.log("=".repeat(100));
  console.log("SECTION ROLL-UP VERIFICATION — production database (read-only)");
  console.log("=".repeat(100));
  console.log(`Total estimates: ${totalEstimates}`);
  console.log(`Sectioned estimates (>=1 section-header row): ${sectioned.length}`);
  console.log();

  // ---- Per-estimate table ----
  const rows = [];
  let phantomTotal = 0;
  const unexplained = [];

  for (const { est, items, totals } of sectioned) {
    const oldSum = rm(items.reduce((sum, it) => sum + num(it.quantity) * num(it.unitCost), 0));
    const newSum = computeEstimateSubtotal(items);
    const totalAmount = est.totalAmount == null ? 0 : Number(est.totalAmount);
    const taxRatePercent = est.taxRatePercent == null ? 0 : Number(est.taxRatePercent);
    const taxMultiplier = est.taxExempt ? 1 : 1 + taxRatePercent / 100;
    const expected = rm(newSum * taxMultiplier);
    const delta = rm(oldSum - newSum);

    const newSumMatches = closeEnough(newSum, totalAmount);
    const expectedMatches = closeEnough(expected, totalAmount);
    const oldSumMatches = closeEnough(oldSum, totalAmount);

    let matchLabel;
    if (newSumMatches && expectedMatches) matchLabel = "newSum & expected";
    else if (newSumMatches) matchLabel = "newSum";
    else if (expectedMatches) matchLabel = "expected";
    else matchLabel = "NEITHER";

    phantomTotal = rm(phantomTotal + delta);

    rows.push({
      code: est.code,
      status: est.status,
      itemCount: items.length,
      sectionCount: totals.filter((t) => t.isSection).length,
      oldSum,
      newSum,
      totalAmount,
      expected,
      delta,
      matchLabel,
      oldSumMatches,
    });

    if (matchLabel === "NEITHER") {
      unexplained.push({
        code: est.code,
        id: est.id,
        itemCount: items.length,
        sectionCount: totals.filter((t) => t.isSection).length,
        oldSum,
        newSum,
        totalAmount,
        expected,
        taxExempt: est.taxExempt,
        taxRatePercent,
        processingFeeMarkup: est.processingFeeMarkup == null ? null : Number(est.processingFeeMarkup),
        hideProcessingFee: est.hideProcessingFee,
        residualVsNewSum: rm(totalAmount - newSum),
        residualVsExpected: rm(totalAmount - expected),
      });
    }
  }

  console.log("-".repeat(100));
  console.log(
    "code".padEnd(14) +
      "status".padEnd(12) +
      "items".padEnd(7) +
      "sect".padEnd(6) +
      "oldSum".padStart(12) +
      "newSum".padStart(12) +
      "totalAmount".padStart(14) +
      "expected".padStart(12) +
      "delta".padStart(10) +
      "  match".padStart(24) +
      "  oldSum==stored",
  );
  console.log("-".repeat(100));
  for (const r of rows) {
    console.log(
      String(r.code).padEnd(14) +
        String(r.status).padEnd(12) +
        String(r.itemCount).padEnd(7) +
        String(r.sectionCount).padEnd(6) +
        fmt(r.oldSum).padStart(12) +
        fmt(r.newSum).padStart(12) +
        fmt(r.totalAmount).padStart(14) +
        fmt(r.expected).padStart(12) +
        fmt(r.delta).padStart(10) +
        `  ${r.matchLabel}`.padStart(24) +
        `  ${r.oldSumMatches ? "YES (unexpected)" : "no (expected)"}`,
    );
  }
  console.log("-".repeat(100));

  const matchedNewOrExpected = rows.filter((r) => r.matchLabel !== "NEITHER").length;
  const oldMatchedCount = rows.filter((r) => r.oldSumMatches).length;
  console.log(`\nReconciled to newSum or expected: ${matchedNewOrExpected}/${rows.length}`);
  console.log(`Reconciled to oldSum (double-counted figure) instead: ${oldMatchedCount}/${rows.length} — expected to be 0`);
  console.log(`\nTOTAL PHANTOM VALUE (sum of oldSum - newSum across all sectioned estimates): $${fmt(phantomTotal)}`);

  // ---- Site 3: historical pricing query-shape comparison ----
  console.log("\n" + "=".repeat(100));
  console.log("SITE 3 CHECK — historical pricing query shape (parentId: null) vs corrected (all non-section items)");
  console.log("=".repeat(100));

  let oldShapeCount = 0;
  let oldShapeSum = 0;
  let newShapeCount = 0;
  let newShapeSum = 0;

  for (const { items, totals } of sectioned) {
    items.forEach((it, index) => {
      // OLD shape: `where: { parentId: null }` — top-level rows only, regardless of type.
      if (!it.parentId) {
        oldShapeCount += 1;
        oldShapeSum = rm(oldShapeSum + num(it.quantity) * num(it.unitCost));
      }
      // NEW shape: every row in the estimate that is not itself a section header
      // (drops section headers per-estimate, keeps nested leaves at any depth).
      if (!totals[index].isSection) {
        newShapeCount += 1;
        newShapeSum = rm(newShapeSum + num(it.quantity) * num(it.unitCost));
      }
    });
  }

  console.log(`OLD shape (parentId: null)      — items: ${oldShapeCount}, summed total: $${fmt(oldShapeSum)}`);
  console.log(`NEW shape (drop section headers) — items: ${newShapeCount}, summed total: $${fmt(newShapeSum)}`);
  console.log(
    `Difference: ${newShapeCount - oldShapeCount} more billable items captured, ` +
      `$${fmt(rm(newShapeSum - oldShapeSum))} more in billable value surfaced by the fix.`,
  );

  // ---- Unexplained estimates ----
  console.log("\n" + "=".repeat(100));
  console.log(`UNEXPLAINED ESTIMATES (newSum reconciles to neither newSum-as-total nor tax-adjusted expected): ${unexplained.length}`);
  console.log("=".repeat(100));
  if (unexplained.length === 0) {
    console.log("None. Every sectioned estimate reconciles to its stored totalAmount.");
  } else {
    for (const u of unexplained) {
      console.log(`\n  ${u.code} (id=${u.id})`);
      console.log(`    items=${u.itemCount} sections=${u.sectionCount}`);
      console.log(`    oldSum=$${fmt(u.oldSum)}  newSum=$${fmt(u.newSum)}  totalAmount=$${fmt(u.totalAmount)}  expected=$${fmt(u.expected)}`);
      console.log(`    taxExempt=${u.taxExempt} taxRatePercent=${u.taxRatePercent} processingFeeMarkup=${u.processingFeeMarkup} hideProcessingFee=${u.hideProcessingFee}`);
      console.log(`    residual (totalAmount - newSum)=$${fmt(u.residualVsNewSum)}  residual (totalAmount - expected)=$${fmt(u.residualVsExpected)}`);
    }
  }

  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error("verify-section-rollup-sites failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
