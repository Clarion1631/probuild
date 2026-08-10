// READ-ONLY audit of EstimateItem.parentId integrity: cross-estimate parent links,
// dangling parents, and parentId cycles.
//
// Background: `EstimateItem.parentId` is a self-referencing FK with NO estimate-scope
// constraint, so the database will happily accept a child whose parent lives in a
// different estimate. `saveEstimate` passed submitted parentIds straight through, so a
// crafted save could create exactly that. It matters because the section roll-up
// (`computeEstimateItemTotals`) walks parent/child to price section headers, and that
// subtotal drives totalAmount -> tax -> payment milestones: a cross-estimate link lets
// one estimate's money be computed over another estimate's tree.
//
// The guard now lives in `assertEstimateItemParentsInScope`
// (src/lib/estimate-item-upsert.ts). It fails CLOSED: once it ships, any estimate that
// ALREADY contains one of these rows can no longer be saved at all. That is why this
// script exists — to find out, before deploying, whether such history is present.
//
// THIS SCRIPT NEVER WRITES. There is no UPDATE, INSERT or DELETE in this file and no
// --apply flag. If it reports a non-zero count, do NOT auto-repair: reparenting a line
// item moves money between estimates. Bring the rows to the owner first.
//
// Usage:
//   node scripts/audit-estimate-item-parents.mjs
//   node scripts/audit-estimate-item-parents.mjs --limit 50   # cap the samples printed
//
// Requires (read from env or .env / .env.local):
//   DATABASE_URL   Supabase transaction pooler URL (must include ?pgbouncer=true)
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import fs from "node:fs";

const limitArg = process.argv.indexOf("--limit");
let SAMPLE_LIMIT = 20;
if (limitArg >= 0) {
  const raw = process.argv[limitArg + 1];
  const parsed = raw === undefined ? NaN : Number(raw);
  if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    throw new Error(`--limit needs a non-negative integer, got ${raw === undefined ? "nothing" : `"${raw}"`}`);
  }
  SAMPLE_LIMIT = parsed;
}

/**
 * Read a key from env, then from the dotenv files in the order the Next.js toolchain
 * resolves them: `.env.local` OVERRIDES `.env`. Checking `.env` first would let a
 * committed default win over the local override and point a production audit at the
 * WRONG DATABASE. Same helper as the sibling ops scripts standardized in #338.
 *
 * `key in` rather than a truthiness check, in both the env and the file lookup: a source that
 * assigns the key an EMPTY value has still spoken, and must win over the lower-precedence one
 * instead of falling through to it. The missing-URL check below then fails loudly, which is the
 * correct outcome.
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

// A LEFT JOIN, not an inner one: a parentId pointing at a row that no longer exists is
// its own defect and must not be silently dropped from the report by an inner join.
const LINK_SQL = `
  SELECT
    c."id"          AS "childId",
    c."name"        AS "childName",
    c."estimateId"  AS "childEstimateId",
    ce."code"       AS "childEstimateCode",
    c."parentId"    AS "parentId",
    p."estimateId"  AS "parentEstimateId",
    pe."code"       AS "parentEstimateCode"
  FROM "EstimateItem" c
  LEFT JOIN "EstimateItem" p ON p."id" = c."parentId"
  LEFT JOIN "Estimate" ce ON ce."id" = c."estimateId"
  LEFT JOIN "Estimate" pe ON pe."id" = p."estimateId"
  WHERE c."parentId" IS NOT NULL
    AND (p."id" IS NULL OR p."estimateId" <> c."estimateId")
`;

// Postgres' CYCLE clause does the detection; the recursion is seeded from every row that
// has a parent, so a cycle is found whichever member we happen to start from.
const CYCLE_SQL = `
  WITH RECURSIVE walk("startId", "id", "parentId") AS (
    SELECT i."id", i."id", i."parentId"
    FROM "EstimateItem" i
    WHERE i."parentId" IS NOT NULL
    UNION ALL
    SELECT w."startId", p."id", p."parentId"
    FROM walk w
    JOIN "EstimateItem" p ON p."id" = w."parentId"
  ) CYCLE "id" SET "isCycle" USING "path"
  SELECT DISTINCT w."startId" AS "itemId", i."estimateId" AS "estimateId", e."code" AS "estimateCode"
  FROM walk w
  JOIN "EstimateItem" i ON i."id" = w."startId"
  LEFT JOIN "Estimate" e ON e."id" = i."estimateId"
  WHERE w."isCycle"
`;

const TOTAL_SQL = `SELECT COUNT(*)::int AS "n" FROM "EstimateItem" WHERE "parentId" IS NOT NULL`;

try {
  const [totals, badLinks, cycles] = await Promise.all([
    prisma.$queryRawUnsafe(TOTAL_SQL),
    prisma.$queryRawUnsafe(LINK_SQL),
    prisma.$queryRawUnsafe(CYCLE_SQL),
  ]);

  const parented = totals[0]?.n ?? 0;
  const dangling = badLinks.filter(r => r.parentEstimateId === null);
  const crossEstimate = badLinks.filter(r => r.parentEstimateId !== null);

  console.log(`\nEstimateItem rows with a parentId: ${parented}`);
  console.log(`  cross-estimate parent links: ${crossEstimate.length}`);
  console.log(`  dangling parentId (parent row missing): ${dangling.length}`);
  console.log(`  rows in a parentId cycle: ${cycles.length}`);

  const sample = (label, rows, fmt) => {
    if (rows.length === 0) return;
    console.log(`\n${label} (showing ${Math.min(rows.length, SAMPLE_LIMIT)} of ${rows.length}):`);
    for (const row of rows.slice(0, SAMPLE_LIMIT)) console.log(`  ${fmt(row)}`);
  };

  sample("CROSS-ESTIMATE", crossEstimate, r =>
    `item ${r.childId} "${r.childName}" in ${r.childEstimateCode ?? r.childEstimateId} -> parent ${r.parentId} in ${r.parentEstimateCode ?? r.parentEstimateId}`);
  sample("DANGLING", dangling, r =>
    `item ${r.childId} "${r.childName}" in ${r.childEstimateCode ?? r.childEstimateId} -> missing parent ${r.parentId}`);
  sample("CYCLIC", cycles, r =>
    `item ${r.itemId} in ${r.estimateCode ?? r.estimateId}`);

  const clean = crossEstimate.length === 0 && dangling.length === 0 && cycles.length === 0;
  console.log(clean
    ? "\n✓ Clean — no estimate is made unsavable by the new parentId guard.\n"
    : "\n✗ Rows above would be REJECTED by assertEstimateItemParentsInScope. Those estimates cannot be saved until the data is corrected. Do not auto-repair: reparenting moves money between estimates.\n");
} finally {
  await prisma.$disconnect();
}
