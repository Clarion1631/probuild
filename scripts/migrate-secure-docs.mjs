// One-time migration: move sensitive documents out of the PUBLIC `project-files` bucket
// into the PRIVATE `secure-docs` bucket, and rewrite the owning DB column to the
// `secure:<storage-path>` scheme defined in src/lib/secure-storage.ts.
//
// This script COPIES — it never deletes the public original. Run
// scripts/purge-migrated-public-docs.mjs separately (and only after verifying the
// migration in production) to remove the now-redundant public copies.
//
// In scope:
//   Contract.signatureUrl / contractorSignatureUrl / companySignatureUrl   (URLs)
//   Contract.signedPdfPath / originalPdfPath                              (bare paths)
//   ContractSigningRecord.signatureUrl                                    (URL)
//   ChangeOrder.clientSignatureUrl / companySignatureUrl                  (URLs)
//   Client.taxExemptCertUrl                                               (URL)
//   ProjectFile.url — ROW-SELECTED: only rows whose storage path looks like an
//     executed contract or a signed estimate PDF (see isInScopeProjectFilePath below).
//     ProjectFile mixes sensitive and ordinary project files, so most rows are left alone.
//
// SAFE TO RE-RUN:
//   - Values already `secure:`-prefixed are left untouched (counted as skipped-already).
//   - Inline `data:` values are left untouched (they're not in Storage at all).
//   - Before trusting a destination object as already-migrated (and before the CAS
//     update), its size is fetched via the storage info() API and compared against the
//     source object's size. A destination that's missing, zero-byte, or size-mismatched
//     is re-copied (overwrite) and re-verified — it is never assumed intact just because
//     it exists. If it's still not intact after a re-copy, the row is left alone and
//     counted as corrupt-destination, not silently treated as migrated.
//   - The DB write is a compare-and-swap (only fires if the column still holds the exact
//     value we read), so a concurrent re-sign is never clobbered.
//   - Missing source objects are logged and the DB row is left alone — never point a
//     column at a secure ref that doesn't exist.
//
// Usage:
//   node scripts/migrate-secure-docs.mjs            # dry run — read-only preview, no writes
//   node scripts/migrate-secure-docs.mjs --apply     # copy objects + rewrite columns
//
// Requires (read from env or .env / .env.local):
//   DATABASE_URL          Supabase transaction pooler URL (must include ?pgbouncer=true)
//   SUPABASE_URL          Supabase project URL
//   SUPABASE_SERVICE_KEY  Supabase service role key
//
// Both storage credentials are required even for a dry run: the preview checks whether
// each source object actually exists in `project-files` (a read-only metadata request) so
// the missing-object count in the summary is real, not guessed.
//
// This script does NOT create the `secure-docs` bucket — it must already exist.
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs";

const PUBLIC_BUCKET = "project-files";
const SECURE_BUCKET = "secure-docs";
const SECURE_SCHEME = "secure:";

const APPLY = process.argv.includes("--apply");

/**
 * Read a key from the environment, then from the dotenv files in the order the Next.js
 * toolchain resolves them: `.env.local` OVERRIDES `.env`. Checking `.env` first would let a
 * committed default silently win over the local override and point this script's writes at the
 * WRONG DATABASE or the WRONG STORAGE BUCKET.
 *
 * Parsing is delegated to `dotenv` rather than hand-rolled: a regex over the line mishandles
 * quoted values containing `#`, `export` prefixes, inline comments, CRLF and multiline values,
 * and every one of those is a silent wrong-target read. `in` rather than a truthiness check at
 * BOTH levels so a source that assigns an EMPTY value — an exported `DATABASE_URL=""` included —
 * still wins over every lower-precedence source and the missing-value check below fails loudly.
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

const SUPABASE_URL = envFromFiles("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = envFromFiles("SUPABASE_SERVICE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required (dry run still needs read access to check object existence)");
}

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// { table, column, kind: "url" | "path" }
const TARGETS = [
  { table: "Contract", column: "signatureUrl", kind: "url" },
  { table: "Contract", column: "contractorSignatureUrl", kind: "url" },
  { table: "Contract", column: "companySignatureUrl", kind: "url" },
  { table: "Contract", column: "signedPdfPath", kind: "path" },
  { table: "Contract", column: "originalPdfPath", kind: "path" },
  { table: "ContractSigningRecord", column: "signatureUrl", kind: "url" },
  { table: "ChangeOrder", column: "clientSignatureUrl", kind: "url" },
  { table: "ChangeOrder", column: "companySignatureUrl", kind: "url" },
  { table: "Client", column: "taxExemptCertUrl", kind: "url" },
];

function firstLine(e) {
  return (e?.message || e || "").toString().split("\n")[0];
}

function truncate(v, n = 120) {
  const s = (v ?? "").toString();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isSecureRef(value) {
  return typeof value === "string" && value.startsWith(SECURE_SCHEME);
}

function isDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:");
}

function toSecureRef(path) {
  return `${SECURE_SCHEME}${path}`;
}

/**
 * Parse one of our own public `project-files` object URLs into a storage path.
 * Mirrors parseOwnStorageUrl() in src/lib/secure-storage.ts (duplicated here because this
 * is a plain Node script, not a TS import) — refuses anything that isn't our own project's
 * public object URL, and anything containing "..".
 */
function parsePublicUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    if (!parsed.hostname.endsWith(".supabase.co") && !parsed.hostname.endsWith(".supabase.in")) return null;
    const ourRef = new URL(SUPABASE_URL).hostname.split(".")[0];
    if (ourRef && !parsed.hostname.startsWith(`${ourRef}.`)) return null;
    const prefix = `/storage/v1/object/public/${PUBLIC_BUCKET}/`;
    if (!parsed.pathname.startsWith(prefix)) return null;
    const rest = parsed.pathname.slice(prefix.length);
    if (!rest) return null;
    const path = decodeURIComponent(rest);
    if (path.includes("..")) return null;
    return path;
  } catch {
    return null;
  }
}

function deriveBarePath(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("/") || value.includes("..")) return null;
  return value;
}

function deriveUrlPath(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^https?:\/\//i.test(value)) return parsePublicUrl(value);
  // Defensive fallback — these columns are documented as storing absolute URLs, but treat
  // a bare-path value the same way signedPdfPath/originalPdfPath are handled if one ever
  // shows up.
  return deriveBarePath(value);
}

// ProjectFile row-selection: only executed-contract / signed-estimate / intermediate
// signed-contract PDFs are in scope. Everything else in this table (photos, letterhead,
// takeoffs, general uploads) is left alone.
function isInScopeProjectFilePath(path) {
  if (path.includes("_Executed_Contract_")) return true;
  if (/^(projects|leads)\/[^/]+\/signed\//.test(path)) return true;
  if (path.includes("/intermediate/") && path.toLowerCase().endsWith(".pdf")) return true;
  return false;
}

/**
 * Fetch an object's size (in bytes) via the storage info() API — verified available on the
 * installed @supabase/storage-js@2.99.0 (node_modules/@supabase/storage-js/src/packages/
 * StorageFileApi.ts, also present in the compiled dist/index.cjs actually loaded at
 * runtime): `.info(path)` returns `{ data: { size, ... } }` on success or
 * `{ data: null, error }` for a missing object or any other failure. Used instead of
 * exists() so a pre-existing destination's integrity (non-zero, matches source size) can
 * actually be verified rather than just its presence.
 *
 * Returns null when the object doesn't exist or the metadata can't be fetched for any
 * reason — callers must treat null as "can't verify", never as a size of 0.
 */
async function getObjectSize(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).info(path);
  if (error) {
    console.warn(`    info() check failed for ${bucket}/${path}: ${firstLine(error)}`);
    return null;
  }
  return typeof data?.size === "number" ? data.size : null;
}

/**
 * Copy `path` from the public bucket into secure-docs at the same path, overwriting any
 * existing (e.g. corrupt) destination object.
 * Tries the storage API's cross-bucket copy() first (supported by the installed
 * @supabase/supabase-js — storage-js's copy() accepts { destinationBucket }, verified
 * against node_modules/@supabase/storage-js @2.99.0). Falls back to download+upload if
 * copy() is unavailable on the client or the call fails for any reason (e.g. a
 * self-hosted Storage API that doesn't support cross-bucket copy). The fallback uses
 * upsert:true because this is also called to replace a zero-byte/size-mismatched
 * destination left behind by a crashed prior run.
 */
async function copyToSecureBucket(path) {
  const publicApi = supabase.storage.from(PUBLIC_BUCKET);
  if (typeof publicApi.copy === "function") {
    const { error } = await publicApi.copy(path, path, { destinationBucket: SECURE_BUCKET });
    if (!error) return { ok: true, method: "copy" };
    console.warn(`    copy() failed (${firstLine(error)}) — falling back to download+upload`);
  }
  const { data: blob, error: downloadError } = await publicApi.download(path);
  if (downloadError) return { ok: false, error: downloadError };
  const arrayBuffer = await blob.arrayBuffer();
  const { error: uploadError } = await supabase.storage
    .from(SECURE_BUCKET)
    .upload(path, Buffer.from(arrayBuffer), {
      contentType: blob.type || "application/octet-stream",
      upsert: true,
    });
  if (uploadError) return { ok: false, error: uploadError, method: "download-upload" };
  return { ok: true, method: "download-upload" };
}

function emptyStats(label) {
  return {
    label,
    scanned: 0,
    migrated: 0,
    skippedAlready: 0,
    skippedDataUrl: 0,
    missingObject: 0,
    skippedChanged: 0,
    corruptDestination: 0,
    failed: 0,
  };
}

/** Shared per-row migration: existence/integrity checks, copy, CAS update. Mutates `stats`. */
async function migrateOneRow({ table, column, id, originalValue, path, stats, label }) {
  const sourceSize = await getObjectSize(PUBLIC_BUCKET, path);
  if (sourceSize === null) {
    stats.missingObject++;
    console.warn(`  ⚠ ${label} id=${id}: object missing from ${PUBLIC_BUCKET} at "${path}" — DB left unchanged`);
    return;
  }

  if (!APPLY) {
    stats.migrated++; // "would migrate" in dry run
    return;
  }

  // A pre-existing destination only counts as already-migrated if it's genuinely intact —
  // non-zero size AND matching the source's size. A zero-byte or truncated destination from
  // a crashed prior run must never be trusted on the strength of exists() alone.
  let destSize = await getObjectSize(SECURE_BUCKET, path);
  let intact = destSize !== null && destSize > 0 && destSize === sourceSize;

  if (!intact) {
    if (destSize !== null) {
      console.warn(
        `  ⚠ ${label} id=${id}: destination ${SECURE_BUCKET}/${path} exists but is not intact ` +
          `(size=${destSize}, expected=${sourceSize}) — re-copying`
      );
    }
    const copyResult = await copyToSecureBucket(path);
    if (!copyResult.ok) {
      stats.failed++;
      console.error(`  ✗ ${label} id=${id}: copy to ${SECURE_BUCKET} failed — ${firstLine(copyResult.error)}`);
      return;
    }
    destSize = await getObjectSize(SECURE_BUCKET, path);
    intact = destSize !== null && destSize > 0 && destSize === sourceSize;
  }

  if (!intact) {
    stats.corruptDestination++;
    console.error(
      `  ✗ ${label} id=${id}: destination ${SECURE_BUCKET}/${path} still not intact after copy ` +
        `(size=${destSize}, expected=${sourceSize}) — DB left unchanged`
    );
    return;
  }

  const secureValue = toSecureRef(path);
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2 AND "${column}" = $3`,
    secureValue,
    id,
    originalValue
  );
  if (affected === 0) {
    stats.skippedChanged++;
    console.warn(`  ↷ ${label} id=${id}: row changed since read — DB left unchanged (object is already copied, safe to re-run)`);
  } else {
    stats.migrated++;
    console.log(`  ✓ ${label} id=${id}: migrated → secure:${path}`);
  }
}

async function processColumnTarget(t) {
  const label = `${t.table}.${t.column}`;
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(`SELECT "id", "${t.column}" AS val FROM "${t.table}" WHERE "${t.column}" IS NOT NULL`);
  } catch (e) {
    console.log(`• ${label}: skipped (${firstLine(e)})`);
    return { ...emptyStats(label), skippedColumn: true };
  }

  const stats = emptyStats(label);
  for (const row of rows) {
    stats.scanned++;
    const value = row.val;
    if (isSecureRef(value)) {
      stats.skippedAlready++;
      continue;
    }
    if (isDataUrl(value)) {
      stats.skippedDataUrl++;
      continue;
    }
    const path = t.kind === "path" ? deriveBarePath(value) : deriveUrlPath(value);
    if (!path) {
      stats.failed++;
      console.error(`  ✗ ${label} id=${row.id}: not a recognized own-storage reference — "${truncate(value)}"`);
      continue;
    }
    await migrateOneRow({ table: t.table, column: t.column, id: row.id, originalValue: value, path, stats, label });
  }

  logColumnSummary(stats);
  return stats;
}

async function processProjectFile() {
  const label = "ProjectFile.url";
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT "id", "url" AS val FROM "ProjectFile" WHERE "url" IS NOT NULL AND ("url" LIKE '%_Executed_Contract_%' OR "url" LIKE '%/signed/%' OR "url" LIKE '%/intermediate/%')`
    );
  } catch (e) {
    console.log(`• ${label}: skipped (${firstLine(e)})`);
    return { ...emptyStats(label), skippedColumn: true };
  }

  const stats = emptyStats(label);
  for (const row of rows) {
    const value = row.val;
    // The SQL LIKE filter above is a superset of the real selection rule (it's just a
    // substring match) — already-secure/data rows can still match on substring, and are
    // worth counting so re-runs show accurate skipped-already numbers.
    if (isSecureRef(value)) {
      stats.scanned++;
      stats.skippedAlready++;
      continue;
    }
    if (isDataUrl(value)) {
      stats.scanned++;
      stats.skippedDataUrl++;
      continue;
    }
    const path = deriveUrlPath(value);
    if (!path) {
      stats.scanned++;
      stats.failed++;
      console.error(`  ✗ ${label} id=${row.id}: not a recognized own-storage reference — "${truncate(value)}"`);
      continue;
    }
    // Enforce the real selection rule precisely before doing anything else — the LIKE
    // filter above is intentionally loose, this regex is the actual scope boundary.
    if (!isInScopeProjectFilePath(path)) continue;

    stats.scanned++;
    console.log(`  • matched ProjectFile id=${row.id} path="${path}"`);
    await migrateOneRow({ table: "ProjectFile", column: "url", id: row.id, originalValue: value, path, stats, label });
  }

  logColumnSummary(stats);
  return stats;
}

function logColumnSummary(s) {
  console.log(
    `• ${s.label}: scanned=${s.scanned} migrated=${s.migrated} skipped-already=${s.skippedAlready} ` +
      `skipped-data-url=${s.skippedDataUrl} missing-object=${s.missingObject} skipped-changed=${s.skippedChanged} ` +
      `corrupt-destination=${s.corruptDestination} failed=${s.failed}` +
      (APPLY ? "" : " (dry run — no writes)")
  );
}

(async () => {
  console.log(APPLY ? "Migration mode: APPLY (copying objects + rewriting columns)\n" : "Migration mode: DRY RUN (pass --apply to write)\n");

  const publicApi = supabase.storage.from(PUBLIC_BUCKET);
  console.log(
    typeof publicApi.copy === "function"
      ? "Cross-bucket copy: storage.copy() with { destinationBucket } is supported by the installed @supabase/supabase-js — using it as the primary mechanism, with download+upload as fallback.\n"
      : "Cross-bucket copy: storage.copy() is NOT available on the installed client — using download+upload for every object.\n"
  );

  const summaries = [];
  for (const t of TARGETS) {
    summaries.push(await processColumnTarget(t));
  }
  summaries.push(await processProjectFile());

  const totals = summaries.reduce(
    (a, s) => ({
      scanned: a.scanned + (s.scanned || 0),
      migrated: a.migrated + (s.migrated || 0),
      skippedAlready: a.skippedAlready + (s.skippedAlready || 0),
      skippedDataUrl: a.skippedDataUrl + (s.skippedDataUrl || 0),
      missingObject: a.missingObject + (s.missingObject || 0),
      skippedChanged: a.skippedChanged + (s.skippedChanged || 0),
      corruptDestination: a.corruptDestination + (s.corruptDestination || 0),
      failed: a.failed + (s.failed || 0),
    }),
    {
      scanned: 0,
      migrated: 0,
      skippedAlready: 0,
      skippedDataUrl: 0,
      missingObject: 0,
      skippedChanged: 0,
      corruptDestination: 0,
      failed: 0,
    }
  );
  console.log(
    `\nTotals: scanned=${totals.scanned} migrated=${totals.migrated} skipped-already=${totals.skippedAlready} ` +
      `skipped-data-url=${totals.skippedDataUrl} missing-object=${totals.missingObject} skipped-changed=${totals.skippedChanged} ` +
      `corrupt-destination=${totals.corruptDestination} failed=${totals.failed}` +
      (APPLY ? "" : " (dry run)")
  );
  if (totals.failed > 0 || totals.corruptDestination > 0) process.exitCode = 1;
})()
  .catch((e) => {
    console.error("Migration failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
