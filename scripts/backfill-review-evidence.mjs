// Resumable historical backfill for AutomationEvent.qbPurchaseId /
// driveFileId (docs/UNIFIED-REGISTER-PLAN.md §1, punch 12 rollout step 3/4).
//
// `detail` is a TEXT column holding JSON, not a jsonb column — Postgres JSON
// operators are not available on it, so every row is parsed in JS.
//
// Run scripts/apply-review-evidence-columns.mjs FIRST (adds the nullable
// columns) and deploy the dual-write build BEFORE running this — otherwise
// rows inserted while this backfill is scanning would need a second pass
// anyway. This script only ever fills a NULL column from `detail` JSON; it
// never overwrites an already-populated column, so it is safe to run
// concurrently with dual-write traffic and safe to re-run as the mandated
// "catch-up pass over remaining nulls".
//
// Resumable: progress is checkpointed to disk after every batch (createdAt +
// id cursor, since AutomationEvent.id is a cuid — roughly time-ordered but
// not a guaranteed total order, so the cursor pairs it with createdAt for a
// stable pagination key). Ctrl-C / crash / timeout just means re-run the
// same command; it picks up where it left off. On a clean completion the
// checkpoint is deleted, so the next invocation (the catch-up pass) does a
// fresh scan bounded by the "column IS NULL" filter rather than an empty range.
//
// Malformed `detail` JSON is logged and skipped (never throws) — a bad
// historical row must not stop the batch.
//
//   node scripts/backfill-review-evidence.mjs
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_PATH = path.join(__dirname, ".backfill-review-evidence.checkpoint.json");
const BATCH_SIZE = 500;

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [process.env.ENV_FILE, ".env", ".env.local"].filter(Boolean)) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8"));
  } catch {
    console.warn("checkpoint file unreadable, starting fresh scan");
    return null;
  }
}

function saveCheckpoint(cursor, totals) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({ cursor, totals }, null, 2));
}

function clearCheckpoint() {
  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

const checkpoint = loadCheckpoint();
let cursor = checkpoint?.cursor ?? null; // { createdAt: ISOString, id: string } | null
const totals = {
  scanned: checkpoint?.totals?.scanned ?? 0,
  updated: checkpoint?.totals?.updated ?? 0,
  noEvidence: checkpoint?.totals?.noEvidence ?? 0,
  malformed: checkpoint?.totals?.malformed ?? 0,
};
if (cursor) {
  console.log(`resuming from checkpoint: ${JSON.stringify(cursor)}`);
}

for (;;) {
  const where = {
    detail: { not: null },
    OR: [{ qbPurchaseId: null }, { driveFileId: null }],
    ...(cursor
      ? {
          AND: [
            {
              OR: [
                { createdAt: { gt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { gt: cursor.id } },
              ],
            },
          ],
        }
      : {}),
  };

  const batch = await prisma.automationEvent.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BATCH_SIZE,
    select: { id: true, createdAt: true, detail: true, qbPurchaseId: true, driveFileId: true },
  });

  if (batch.length === 0) break;

  for (const row of batch) {
    totals.scanned += 1;
    let parsed;
    try {
      parsed = JSON.parse(row.detail);
    } catch {
      totals.malformed += 1;
      console.warn(`malformed detail JSON, skipping id=${row.id}`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      totals.malformed += 1;
      continue;
    }
    const fileId = typeof parsed.fileId === "string" && parsed.fileId ? parsed.fileId : null;
    const qbPurchaseId =
      typeof parsed.qbPurchaseId === "string" && parsed.qbPurchaseId ? parsed.qbPurchaseId : null;

    const data = {};
    if (row.driveFileId == null && fileId) data.driveFileId = fileId;
    if (row.qbPurchaseId == null && qbPurchaseId) data.qbPurchaseId = qbPurchaseId;

    if (Object.keys(data).length === 0) {
      totals.noEvidence += 1;
      continue;
    }
    await prisma.automationEvent.update({ where: { id: row.id }, data });
    totals.updated += 1;
  }

  const last = batch[batch.length - 1];
  cursor = { createdAt: last.createdAt.toISOString(), id: last.id };
  saveCheckpoint(cursor, totals);
  console.log(
    `batch done: scanned=${totals.scanned} updated=${totals.updated} ` +
      `no-evidence=${totals.noEvidence} malformed=${totals.malformed} (cursor id=${cursor.id})`,
  );

  if (batch.length < BATCH_SIZE) break;
}

clearCheckpoint();
console.log(
  `backfill complete: scanned=${totals.scanned} updated=${totals.updated} ` +
    `no-evidence=${totals.noEvidence} malformed=${totals.malformed}`,
);
await prisma.$disconnect();
