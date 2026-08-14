// Resumable historical backfill for QboPurchaseClassification (Unified Money
// Register plan §5 step 3, docs/UNIFIED-REGISTER-PLAN.md).
//
// WHY THIS DRIVES THE SYNC ENDPOINT INSTEAD OF CALLING QBO DIRECTLY:
// classifying a Purchase needs its customer/account/equity detail, which
// only exists in QBO — never in the bank-register GL row this dashboard
// otherwise reads (qbo-bank-register.ts). src/lib/qbo-expense-sync.ts now
// writes a QboPurchaseClassification row for EVERY Purchase it processes
// (imported, skipped, removed, deactivated) as a side effect of its normal
// job — see syncQboExpenses's classifyPurchaseOutcome() + persistClassification.
// That is the one authoritative implementation of "what does this Purchase's
// money mean" in the whole codebase. Reimplementing that logic here in plain
// JS (or duplicating QBO's encrypted-at-rest OAuth token refresh, which lives
// in src/lib/integration-store.ts + quickbooks-payments.ts) would create a
// second, drift-prone copy of money-classification logic — exactly what
// CLAUDE.md's money-path review protocol exists to catch. Instead this script
// re-runs the ALREADY-SANCTIONED backfill sync (scripts/run-qbo-backfill.mjs
// uses the identical HTTP contract, proven idempotent there via its own
// pass-1/pass-2 check) over the register's supported window, so every
// Purchase QBO knows about in that window gets classified using the real
// sync logic — no per-Purchase QBO calls, no second implementation.
//
// Side effects: identical to running scripts/run-qbo-backfill.mjs over the
// same window (Expense import/update/removal — already a sanctioned,
// idempotent operation) PLUS a QboPurchaseClassification upsert per Purchase
// processed. Running this against an unchanged window twice is a no-op on
// the Expense side (see run-qbo-backfill.mjs's own idempotency check) and
// last-write-wins on the classification side.
//
// Resumable: each date-window chunk is checkpointed to disk immediately
// after it succeeds. Ctrl-C / crash / timeout just means re-run the same
// command — completed chunks are skipped. On a clean completion the
// checkpoint is deleted (mirrors scripts/backfill-review-evidence.mjs).
//
//   node scripts/backfill-qbo-purchase-classification.mjs [since] [until]
//     default since: 92 days ago (UTC) — MAX_RANGE_DAYS in
//                    src/lib/qbo-bank-register.ts, the register's supported window
//     default until: today (UTC)
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const CHECKPOINT_PATH = path.join(__dirname, ".backfill-qbo-purchase-classification.checkpoint.json");
const SYNC_URL = "https://probuild.goldentouchremodeling.com/api/integrations/qbo-expenses/sync";
const CHUNK_DAYS = 30; // stays well inside the sync route's 300s maxDuration
const MAX_RANGE_DAYS = 92; // mirrors qbo-bank-register.ts's MAX_RANGE_DAYS

function resolveIngestSecret() {
  if (process.env.RECEIPT_INGEST_SECRET) return process.env.RECEIPT_INGEST_SECRET;
  for (const file of [".env.production.local", ".env.local", ".env"]) {
    const p = path.join(repoRoot, file);
    if (!fs.existsSync(p)) continue;
    const match = fs.readFileSync(p, "utf8").match(/^RECEIPT_INGEST_SECRET\s*=\s*"?([^"\r\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("RECEIPT_INGEST_SECRET not found in env or .env files (run: vercel env pull .env.production.local --environment=production)");
}

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    const p = path.join(repoRoot, file);
    if (!fs.existsSync(p)) continue;
    const match = fs.readFileSync(p, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

// Inclusive day-sized windows: [since..since+CHUNK_DAYS-1], ... up to until.
function dayChunks(sinceIso, untilIso, chunkDays) {
  const chunks = [];
  let cursor = new Date(`${sinceIso}T00:00:00.000Z`);
  const end = new Date(`${untilIso}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    const chunkEnd = new Date(cursor.getTime() + (chunkDays - 1) * 86_400_000);
    const boundedEnd = chunkEnd.getTime() < end.getTime() ? chunkEnd : end;
    chunks.push({ since: isoDay(cursor), until: isoDay(boundedEnd) });
    cursor = new Date(boundedEnd.getTime() + 86_400_000);
  }
  return chunks;
}

function loadCheckpoint(since, until) {
  if (!fs.existsSync(CHECKPOINT_PATH)) return null;
  let checkpoint;
  try {
    checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8"));
  } catch {
    console.warn("checkpoint file unreadable, starting fresh scan");
    return null;
  }
  if (checkpoint.since !== since || checkpoint.until !== until) {
    console.warn(
      `checkpoint was for a different window (${checkpoint.since}..${checkpoint.until}), ` +
        `this run is ${since}..${until} — starting fresh`,
    );
    return null;
  }
  return checkpoint;
}

function saveCheckpoint(since, until, completedChunks, totals) {
  fs.writeFileSync(
    CHECKPOINT_PATH,
    JSON.stringify({ since, until, completedChunks, totals }, null, 2),
  );
}

function clearCheckpoint() {
  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
}

async function runChunk(chunk, attempt = 1) {
  const started = Date.now();
  const res = await fetch(SYNC_URL, {
    method: "POST",
    headers: { "x-ingest-key": resolveIngestSecret(), "content-type": "application/json" },
    body: JSON.stringify({ mode: "backfill", since: chunk.since, until: chunk.until }),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    if (attempt < 2) {
      console.log(`  ${chunk.since}..${chunk.until}: HTTP ${res.status} after ${seconds}s — retrying once`);
      return runChunk(chunk, attempt + 1);
    }
    throw new Error(`Chunk ${chunk.since}..${chunk.until} failed twice: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  console.log(
    `  ${chunk.since}..${chunk.until}: imported ${json.imported}, updated ${json.updated}, ` +
      `removed ${json.removed}, skipped ${json.skipped?.length ?? 0} (${seconds}s)`,
  );
  return json;
}

function addTotals(totals, result) {
  totals.imported += result.imported ?? 0;
  totals.updated += result.updated ?? 0;
  totals.removed += result.removed ?? 0;
  totals.skipped += result.skipped?.length ?? 0;
}

const now = new Date();
const defaultSince = isoDay(new Date(now.getTime() - MAX_RANGE_DAYS * 86_400_000));
const defaultUntil = isoDay(now);
const since = process.argv[2] || defaultSince;
const until = process.argv[3] || defaultUntil;

const chunks = dayChunks(since, until, CHUNK_DAYS);
console.log(`Classification backfill ${since}..${until} in ${chunks.length} chunk(s) of up to ${CHUNK_DAYS} days against ${SYNC_URL}`);

const checkpoint = loadCheckpoint(since, until);
const completedChunks = checkpoint?.completedChunks ?? [];
const totals = checkpoint?.totals ?? { imported: 0, updated: 0, removed: 0, skipped: 0 };
if (completedChunks.length) {
  console.log(`resuming: ${completedChunks.length}/${chunks.length} chunk(s) already completed`);
}
const completedKeys = new Set(completedChunks.map(c => `${c.since}..${c.until}`));

for (const chunk of chunks) {
  const key = `${chunk.since}..${chunk.until}`;
  if (completedKeys.has(key)) {
    console.log(`  ${key}: already completed, skipping`);
    continue;
  }
  const result = await runChunk(chunk);
  addTotals(totals, result);
  completedChunks.push(chunk);
  saveCheckpoint(since, until, completedChunks, totals);
}

clearCheckpoint();
console.log(
  `\nBackfill complete: imported ${totals.imported}, updated ${totals.updated}, ` +
    `removed ${totals.removed}, skipped ${totals.skipped}`,
);

// Read-only summary of the classification side effect — direct DB read, no
// QBO call. Not scoped to this run's window (QboPurchaseClassification
// carries no transaction date), but a useful sanity check that rows landed.
const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });
try {
  const groups = await prisma.qboPurchaseClassification.groupBy({
    by: ["classification"],
    _count: { _all: true },
  });
  console.log("\nQboPurchaseClassification totals (all-time, not window-scoped):");
  for (const group of groups) {
    console.log(`  ${group.classification}: ${group._count._all}`);
  }
} finally {
  await prisma.$disconnect();
}
