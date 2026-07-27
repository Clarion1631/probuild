// Safety backup for the secure-docs migration. Run this BEFORE
// scripts/purge-migrated-public-docs.mjs deletes the public originals, so the purge becomes
// reversible.
//
// For every in-scope DB column whose value is a `secure:<path>` ref (i.e. every row
// scripts/purge-migrated-public-docs.mjs would act on), this downloads the ORIGINAL object at
// that same path from the PUBLIC `project-files` bucket and writes it to
// `<dest>/<storage-path>`, preserving the storage path structure exactly so a restore can map
// 1:1 back to bucket paths. A MANIFEST.json is written alongside recording table/column/row
// id/path/size/sha256 for every backed-up file, for an auditable restore.
//
// Same column scope as scripts/migrate-secure-docs.mjs and scripts/purge-migrated-public-docs.mjs:
//   Contract.signatureUrl / contractorSignatureUrl / companySignatureUrl / signedPdfPath / originalPdfPath
//   ContractSigningRecord.signatureUrl
//   ChangeOrder.clientSignatureUrl / companySignatureUrl
//   Client.taxExemptCertUrl
//   ProjectFile.url (any row already holding a `secure:` ref — no extra path-pattern
//     filtering needed, mirroring purge-migrated-public-docs.mjs's reasoning: only rows
//     migrate-secure-docs.mjs touched, or new executed-contract PDFs uploaded straight to
//     secure-docs via uploadSecureDoc(), can ever hold one)
//
// Values that are NOT `secure:` refs (inline `data:` URLs, un-migrated legacy values) are not
// purge targets and are skipped without being counted as an error.
//
// Safety:
//   - READ-ONLY with respect to Supabase and the database. Never writes to storage, never
//     deletes anything, never UPDATEs any DB row. The only writes are local filesystem writes
//     under --dest.
//   - Idempotent re-runs: if a file already exists at the destination with a non-zero size
//     matching the remote object's reported size, it's counted as already-backed-up and not
//     re-downloaded (its sha256 is still recomputed from the local copy so the manifest stays
//     complete).
//   - A public original missing from `project-files` is logged clearly and counted as
//     missing-original — this does not fail the run (two such rows are known to exist: a
//     contract whose original PDF was destroyed by an older bug).
//   - After every download the bytes written are verified non-zero and equal to the remote
//     object's reported size; a mismatch is counted and loudly reported as failed (the file is
//     left on disk as-is — a later re-run will detect the size mismatch and retry the
//     download).
//   - Any derived storage path containing ".." or starting with "/" is refused.
//
// Usage:
//   node scripts/backup-migrated-public-docs.mjs --dest <dir>
//
// Requires (read from env or .env / .env.local):
//   DATABASE_URL          Supabase transaction pooler URL (must include ?pgbouncer=true)
//   SUPABASE_URL          Supabase project URL
//   SUPABASE_SERVICE_KEY  Supabase service role key
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PUBLIC_BUCKET = "project-files";
const SECURE_SCHEME = "secure:";

function parseDestArg(argv) {
  const eq = argv.find((a) => a.startsWith("--dest="));
  if (eq) return eq.slice("--dest=".length);
  const idx = argv.indexOf("--dest");
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return undefined;
}

const DEST = parseDestArg(process.argv.slice(2));
if (!DEST) {
  console.error("Usage: node scripts/backup-migrated-public-docs.mjs --dest <dir>");
  console.error("Refusing to run without a required --dest <dir> argument.");
  process.exit(1);
}

function envFromFiles(key) {
  if (process.env[key]) return process.env[key];
  for (const f of [".env", ".env.local"]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(new RegExp(`^${key}\\s*=\\s*"?([^"\\n]+)"?`, "m"));
    if (m) return m[1];
  }
  return undefined;
}

const DATABASE_URL = envFromFiles("DATABASE_URL");
if (!DATABASE_URL) throw new Error("DATABASE_URL not found in env or .env files");
if (!DATABASE_URL.includes("pgbouncer=true")) {
  console.warn("⚠ DATABASE_URL has no pgbouncer=true — expected the Supabase transaction pooler. Continuing.");
}

const SUPABASE_URL = envFromFiles("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = envFromFiles("SUPABASE_SERVICE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required (read access to project-files)");
}

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Same (table, column) scope purge-migrated-public-docs.mjs deletes from.
const TARGETS = [
  { table: "Contract", column: "signatureUrl" },
  { table: "Contract", column: "contractorSignatureUrl" },
  { table: "Contract", column: "companySignatureUrl" },
  { table: "Contract", column: "signedPdfPath" },
  { table: "Contract", column: "originalPdfPath" },
  { table: "ContractSigningRecord", column: "signatureUrl" },
  { table: "ChangeOrder", column: "clientSignatureUrl" },
  { table: "ChangeOrder", column: "companySignatureUrl" },
  { table: "Client", column: "taxExemptCertUrl" },
  { table: "ProjectFile", column: "url" },
];

function firstLine(e) {
  return (e?.message || e || "").toString().split("\n")[0];
}

function isSecureRef(value) {
  return typeof value === "string" && value.startsWith(SECURE_SCHEME);
}

/** Storage path inside the bucket, or null when `value` isn't a secure ref or the derived
 *  path is unsafe (mirrors secureRefPath() in scripts/purge-migrated-public-docs.mjs). */
function secureRefPath(value) {
  if (!isSecureRef(value)) return null;
  const p = value.slice(SECURE_SCHEME.length);
  if (!p || p.startsWith("/") || p.includes("..")) return null;
  return p;
}

/**
 * Fetch an object's size (in bytes) via the storage info() API (same approach as
 * migrate-secure-docs.mjs / purge-migrated-public-docs.mjs). Returns null when the object
 * doesn't exist or the metadata can't be fetched for any reason — callers must treat null as
 * "can't verify", never as a size of 0.
 */
async function getObjectSize(bucket, objectPath) {
  const { data, error } = await supabase.storage.from(bucket).info(objectPath);
  if (error) {
    console.warn(`    info() check failed for ${bucket}/${objectPath}: ${firstLine(error)}`);
    return null;
  }
  return typeof data?.size === "number" ? data.size : null;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function localFileSize(localPath) {
  try {
    return fs.statSync(localPath).size;
  } catch {
    return null;
  }
}

function emptyStats() {
  return {
    scanned: 0,
    backedUp: 0,
    alreadyBackedUp: 0,
    missingOriginal: 0,
    failed: 0,
    totalBytesWritten: 0,
  };
}

/** Backs up one row's object. Mutates `stats` and pushes an entry to `manifestEntries` on
 *  success (newly downloaded or already-backed-up). */
async function backupOneRow({ table, column, id, objectPath, stats, manifestEntries }) {
  const localPath = path.join(DEST, objectPath);

  const sourceSize = await getObjectSize(PUBLIC_BUCKET, objectPath);
  if (sourceSize === null) {
    stats.missingOriginal++;
    console.error(
      `  ⚠ ${table}.${column} id=${id}: public original missing from ${PUBLIC_BUCKET} at "${objectPath}" — nothing to back up`
    );
    return;
  }

  const existingSize = localFileSize(localPath);
  if (existingSize !== null && existingSize > 0 && existingSize === sourceSize) {
    stats.alreadyBackedUp++;
    const bytes = fs.readFileSync(localPath);
    manifestEntries.push({ table, column, id, path: objectPath, size: bytes.length, sha256: sha256(bytes) });
    console.log(`  · ${table}.${column} id=${id}: already backed up at "${objectPath}" (${existingSize}b) — skipping`);
    return;
  }

  const { data: blob, error: downloadError } = await supabase.storage.from(PUBLIC_BUCKET).download(objectPath);
  if (downloadError) {
    stats.failed++;
    console.error(`  ✗ ${table}.${column} id=${id}: download of ${PUBLIC_BUCKET}/${objectPath} failed — ${firstLine(downloadError)}`);
    return;
  }

  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buffer);

  const writtenSize = localFileSize(localPath);
  if (!writtenSize || writtenSize === 0 || writtenSize !== sourceSize) {
    stats.failed++;
    console.error(
      `  ✗ ${table}.${column} id=${id}: MISMATCH after writing "${objectPath}" — wrote ${writtenSize ?? 0}b, ` +
        `expected ${sourceSize}b. Left on disk for inspection; a re-run will retry.`
    );
    return;
  }

  stats.backedUp++;
  stats.totalBytesWritten += writtenSize;
  manifestEntries.push({ table, column, id, path: objectPath, size: writtenSize, sha256: sha256(buffer) });
  console.log(`  ✓ ${table}.${column} id=${id}: backed up "${objectPath}" (${writtenSize}b)`);
}

async function processTarget(t, stats, manifestEntries) {
  const label = `${t.table}.${t.column}`;
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(`SELECT "id", "${t.column}" AS val FROM "${t.table}" WHERE "${t.column}" IS NOT NULL`);
  } catch (e) {
    console.log(`• ${label}: skipped (${firstLine(e)})`);
    return;
  }

  for (const row of rows) {
    const value = row.val;
    if (!isSecureRef(value)) continue; // not a purge target — data: URL or un-migrated legacy value

    stats.scanned++;
    const objectPath = secureRefPath(value);
    if (!objectPath) {
      stats.failed++;
      console.error(`  ✗ ${label} id=${row.id}: malformed secure ref "${value}" — refusing to touch`);
      continue;
    }

    await backupOneRow({ table: t.table, column: t.column, id: row.id, objectPath, stats, manifestEntries });
  }
}

(async () => {
  console.log(`Backup destination: ${path.resolve(DEST)}\n`);
  fs.mkdirSync(DEST, { recursive: true });

  const stats = emptyStats();
  const manifestEntries = [];

  for (const t of TARGETS) {
    await processTarget(t, stats, manifestEntries);
  }

  const manifestPath = path.join(DEST, "MANIFEST.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceBucket: PUBLIC_BUCKET,
        destDir: path.resolve(DEST),
        files: manifestEntries,
      },
      null,
      2
    )
  );

  console.log(
    `\nTotals: scanned=${stats.scanned} backed-up=${stats.backedUp} already-backed-up=${stats.alreadyBackedUp} ` +
      `missing-original=${stats.missingOriginal} failed=${stats.failed} total-bytes-written=${stats.totalBytesWritten}`
  );
  console.log(`Manifest written to ${manifestPath} (${manifestEntries.length} files recorded)`);

  if (stats.failed > 0) process.exitCode = 1;
})()
  .catch((e) => {
    console.error("Backup failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
