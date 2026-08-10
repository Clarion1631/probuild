// EMERGENCY UNDO for the secure-docs migration. Restores documents that
// migrate-secure-docs.mjs moved into the PRIVATE `secure-docs` bucket (and that
// purge-migrated-public-docs.mjs then deleted from the PUBLIC `project-files` bucket) back
// into the public bucket, from the on-disk backup that backup-migrated-public-docs.mjs
// produced before those deletions.
//
// Run this ONLY if the private-bucket approach for sensitive documents has to be abandoned.
// It re-publishes signatures, executed contract PDFs, signed estimate PDFs, and tax-exempt
// certs to a PUBLIC bucket — that is the whole point, but it is a real security regression,
// not a no-op, so --apply prints a loud banner saying so.
//
// By default this restores ONLY still-referenced migrated documents (MANIFEST.json — rows a
// live DB column still points at via a `secure:<path>` ref). MANIFEST-orphans.json and
// MANIFEST-orphans-signatures.json entries are objects sweep-orphaned-signature-objects.mjs
// found UNREFERENCED by any DB row (~202 of them: client signatures, executed contracts).
// They are retained on disk but deliberately NOT re-published — re-uploading them to a public
// bucket would recreate exactly the exposure this whole project closed, for files nothing
// needs. Pass --include-orphans to opt into restoring them anyway (rare; prints a loud
// warning when used).
//
// BACKUP LAYOUT (input):
//   MANIFEST.json (from backup-migrated-public-docs.mjs) is FLAT: the file for each entry
//     lives at <source>/<path>, no bucket field — it only ever backed up project-files.
//   MANIFEST-orphans.json / MANIFEST-orphans-signatures.json (from
//     sweep-orphaned-signature-objects.mjs) are BUCKET-QUALIFIED: each entry carries a
//     `bucket` field (`project-files` or `secure-docs`), and the file lives at
//     <source>/<bucket>/<path> — because that sweep covers both buckets, and secure-docs
//     objects can share the same path a project-files object once had. An entry's local file
//     is resolved as <source>/<bucket>/<path> when it carries a `bucket`, else <source>/<path>.
//   A file missing at its resolved local location is logged clearly and counted — it never
//   fails the whole run.
//   All three manifest files are optional on disk (a given backup run may not have produced
//   every one) but at least one must be present, and be non-empty, or there is nothing to
//   restore. Missing manifest files are logged and skipped, not treated as an error.
//
// Phase 1 — re-upload (needs SUPABASE_URL + SUPABASE_SERVICE_KEY):
//   For every MANIFEST.json entry, read the local backup file, verify its sha256 against the
//   manifest (refuse and count sha-mismatch if it doesn't match — corrupt data is never
//   uploaded), then upload it to `project-files` at the manifest `path`. An existing object at
//   that path with the same non-zero size as the manifest is treated as already-restored
//   (idempotent — counted as already-present, not re-uploaded).
//   Orphan-manifest entries are skipped here by default (counted as skipped-orphan-archive,
//   with a one-line reason) unless --include-orphans is passed, in which case they are
//   uploaded back to the bucket recorded in their `bucket` field — never blindly to
//   `project-files`, since a secure-docs orphan belongs back in secure-docs, not public.
//
// Phase 2 — revert DB refs (needs DATABASE_URL; only applies to MANIFEST.json entries):
//   For each MANIFEST.json entry, build the legacy public URL
//   `<SUPABASE_URL>/storage/v1/object/public/project-files/<path>` and, via a compare-and-swap
//   UPDATE, set `table.column` for row `id` back to that URL — but ONLY if the column
//   currently still holds `secure:<path>` exactly. A row that has since been re-signed, or
//   whose column value has otherwise changed, is left untouched and counted as
//   skipped-changed, so a restore can never clobber newer data. Orphan-manifest entries have
//   no DB row by definition and are always skipped in this phase (skipped-orphan) — they were
//   unreferenced when swept and still are.
//
// Never deletes anything, and never touches the `secure-docs` bucket at all — the private
// copies are left in place after a restore, so the restore itself stays reversible.
//
// Table/column pairs eligible for phase 2 are restricted to the exact TARGETS scope from
// migrate-secure-docs.mjs (plus ProjectFile.url, which that script migrates via a separate
// row-selected path) — a hardcoded allowlist, not whatever a manifest file happens to say, so
// a tampered or corrupted manifest can never smuggle arbitrary SQL identifiers into a raw
// query.
//
// Usage:
//   node scripts/restore-secure-docs-from-backup.mjs --source <dir>                        # dry run
//   node scripts/restore-secure-docs-from-backup.mjs --source <dir> --apply                # write
//   node scripts/restore-secure-docs-from-backup.mjs --source <dir> --phase upload         # re-upload only
//   node scripts/restore-secure-docs-from-backup.mjs --source <dir> --phase db --apply     # DB revert only
//   node scripts/restore-secure-docs-from-backup.mjs --source <dir> --apply --include-orphans
//     # ALSO re-publishes unreferenced orphan-manifest entries. Rare — only for when someone
//     # truly wants an unreferenced document back. Prints a loud warning when used.
//
// Requires (read from env or .env / .env.local):
//   DATABASE_URL          Supabase transaction pooler URL (must include ?pgbouncer=true) — phase db/both
//   SUPABASE_URL          Supabase project URL — phase upload/db/both (db needs it to build the public URL string)
//   SUPABASE_SERVICE_KEY  Supabase service role key — phase upload/both
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PUBLIC_BUCKET = "project-files";
const SECURE_SCHEME = "secure:";

// Exact column scope migrate-secure-docs.mjs migrates. Any MANIFEST.json entry naming a
// (table, column) pair outside this list is refused rather than interpolated into SQL.
const ALLOWED_COLUMNS = new Set([
  "Contract.signatureUrl",
  "Contract.contractorSignatureUrl",
  "Contract.companySignatureUrl",
  "Contract.signedPdfPath",
  "Contract.originalPdfPath",
  "ContractSigningRecord.signatureUrl",
  "ChangeOrder.clientSignatureUrl",
  "ChangeOrder.companySignatureUrl",
  "Client.taxExemptCertUrl",
  "ProjectFile.url",
]);

function parseArgs(argv) {
  const out = { source: undefined, apply: false, phase: "both", includeOrphans: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a === "--apply") out.apply = true;
    else if (a === "--phase") out.phase = argv[++i];
    else if (a.startsWith("--phase=")) out.phase = a.slice("--phase=".length);
    else if (a === "--include-orphans") out.includeOrphans = true;
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

if (!ARGS.source) {
  console.error(
    "Usage: node scripts/restore-secure-docs-from-backup.mjs --source <dir> [--apply] [--phase upload|db|both] [--include-orphans]"
  );
  console.error("Refusing to run without a required --source <dir> argument.");
  process.exit(1);
}
if (!["upload", "db", "both"].includes(ARGS.phase)) {
  console.error(`Invalid --phase "${ARGS.phase}" — must be one of: upload, db, both.`);
  process.exit(1);
}

const SOURCE = path.resolve(ARGS.source);
const APPLY = ARGS.apply;
const RUN_UPLOAD = ARGS.phase === "upload" || ARGS.phase === "both";
const RUN_DB = ARGS.phase === "db" || ARGS.phase === "both";
const INCLUDE_ORPHANS = ARGS.includeOrphans;

if (!fs.existsSync(SOURCE) || !fs.statSync(SOURCE).isDirectory()) {
  console.error(`--source "${SOURCE}" does not exist or is not a directory.`);
  process.exit(1);
}

/**
 * Read a key from the environment, then from the dotenv files in the order the Next.js
 * toolchain resolves them: `.env.local` OVERRIDES `.env`. Checking `.env` first would let a
 * committed default silently win over the local override and point this script's restore writes
 * at the WRONG DATABASE or the WRONG STORAGE BUCKET.
 *
 * Parsing is delegated to `dotenv` rather than hand-rolled: a regex over the line mishandles
 * quoted values containing `#`, `export` prefixes, inline comments, CRLF and multiline values,
 * and every one of those is a silent wrong-target read. `key in parsed` rather than a truthiness
 * check so a file that assigns an EMPTY value still wins over the lower-precedence file and the
 * missing-value check below fails loudly.
 */
function envFromFiles(key) {
  if (process.env[key]) return process.env[key];
  for (const f of [".env.local", ".env"]) {
    if (!fs.existsSync(f)) continue;
    const parsed = dotenv.parse(fs.readFileSync(f));
    if (key in parsed) return parsed[key];
  }
  return undefined;
}

const SUPABASE_URL = envFromFiles("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = envFromFiles("SUPABASE_SERVICE_KEY");
const DATABASE_URL = envFromFiles("DATABASE_URL");

if (RUN_UPLOAD && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required for the upload phase.");
}
if (RUN_DB && !SUPABASE_URL) {
  throw new Error("SUPABASE_URL is required for the db phase (used to build the restored public URL).");
}
if (RUN_DB && !DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the db phase.");
}
if (RUN_DB && DATABASE_URL && !DATABASE_URL.includes("pgbouncer=true")) {
  console.warn("⚠ DATABASE_URL has no pgbouncer=true — expected the Supabase transaction pooler. Continuing.");
}

// Only the upload phase makes storage API calls — the db phase only needs SUPABASE_URL as a
// plain string to build the restored public URL, not a storage client.
const supabase = RUN_UPLOAD ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;
const prisma = RUN_DB ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } }) : null;

function firstLine(e) {
  return (e?.message || e || "").toString().split("\n")[0];
}

function isSafeStoragePath(p) {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.includes("..");
}

/** A manifest `bucket` field is only ever used to pick which Supabase bucket to upload to and
 *  which local backup subdirectory to read from — never interpolated into SQL — but it still
 *  must not be usable to escape the backup directory or target an unexpected bucket. */
// A manifest is untrusted input, and this value decides which bucket we upload INTO — so
// allowlist it rather than merely rejecting traversal, mirroring ALLOWED_COLUMNS below.
const ALLOWED_BUCKETS = new Set(["project-files", "secure-docs"]);

function isSafeBucketName(b) {
  return typeof b === "string" && ALLOWED_BUCKETS.has(b);
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function guessContentType(objectPath) {
  const ext = path.extname(objectPath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

/** Load one manifest file if present. Returns [] (with a log line) if it doesn't exist or
 *  fails to parse — a missing manifest is not an error, since not every backup run produces
 *  every manifest. */
function loadManifest(filename) {
  const manifestPath = path.join(SOURCE, filename);
  if (!fs.existsSync(manifestPath)) {
    console.log(`  (${filename} not found — skipping)`);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`  ✗ ${filename}: failed to parse — ${firstLine(e)}`);
    return [];
  }
  const files = Array.isArray(parsed?.files) ? parsed.files : [];
  console.log(`  ${filename}: ${files.length} entries`);
  return files.map((f) => ({ ...f, sourceManifest: filename }));
}

function getObjectSize(bucket, objectPath) {
  return supabase.storage
    .from(bucket)
    .info(objectPath)
    .then(({ data, error }) => {
      if (error) return null;
      return typeof data?.size === "number" ? data.size : null;
    });
}

function emptyStats() {
  return {
    scanned: 0,
    uploaded: 0,
    alreadyPresent: 0,
    shaMismatch: 0,
    dbReverted: 0,
    skippedChanged: 0,
    skippedOrphan: 0,
    skippedOrphanArchive: 0,
    failed: 0,
    totalBytesUploaded: 0,
  };
}

/** Phase 1: verify the local backup file against its manifest sha256, then upload it back to
 *  its target bucket (project-files for MANIFEST.json entries; whatever `entry.bucket` says
 *  for orphan-manifest entries) at the manifest path. Idempotent — an existing object of the
 *  same non-zero size is treated as already-restored and left alone. */
async function restoreOneFile(entry, stats) {
  const label = entry.table ? `${entry.table}.${entry.column} id=${entry.id}` : "(orphan)";
  const objectPath = entry.path;

  if (!isSafeStoragePath(objectPath)) {
    stats.failed++;
    console.error(`  ✗ ${label}: unsafe manifest path "${objectPath}" — refusing to touch`);
    return;
  }

  // MANIFEST.json (from backup-migrated-public-docs.mjs) is flat, no `bucket` field, and only
  // ever backed up project-files. MANIFEST-orphans*.json (from
  // sweep-orphaned-signature-objects.mjs) is bucket-qualified: <source>/<bucket>/<path>, and
  // the entry's `bucket` says which Supabase bucket to restore it to.
  let targetBucket = PUBLIC_BUCKET;
  let localPath = path.join(SOURCE, objectPath);
  if (entry.bucket !== undefined) {
    if (!isSafeBucketName(entry.bucket)) {
      stats.failed++;
      console.error(`  ✗ ${label}: unsafe manifest bucket "${entry.bucket}" — refusing to touch`);
      return;
    }
    targetBucket = entry.bucket;
    localPath = path.join(SOURCE, entry.bucket, objectPath);
  }

  let buffer;
  try {
    buffer = fs.readFileSync(localPath);
  } catch (e) {
    stats.failed++;
    console.error(`  ✗ ${label}: local backup file missing at "${localPath}" — ${firstLine(e)}`);
    return;
  }

  const actualSha = sha256Buffer(buffer);
  if (entry.sha256 && actualSha !== entry.sha256) {
    stats.shaMismatch++;
    console.error(
      `  ✗ ${label}: sha256 mismatch for "${objectPath}" (backup=${actualSha}, manifest=${entry.sha256}) — refusing to upload corrupt data`
    );
    return;
  }

  const existingSize = await getObjectSize(targetBucket, objectPath);
  if (existingSize !== null && existingSize > 0 && existingSize === buffer.length) {
    stats.alreadyPresent++;
    console.log(`  · ${label}: "${objectPath}" already present in ${targetBucket} (${existingSize}b) — skipping`);
    return;
  }

  if (!APPLY) {
    stats.uploaded++; // "would upload" in dry run
    console.log(`  (dry run) would upload "${objectPath}" (${buffer.length}b) to ${targetBucket}`);
    return;
  }

  const { error } = await supabase.storage
    .from(targetBucket)
    .upload(objectPath, buffer, { contentType: guessContentType(objectPath), upsert: true });
  if (error) {
    stats.failed++;
    console.error(`  ✗ ${label}: upload of "${objectPath}" to ${targetBucket} failed — ${firstLine(error)}`);
    return;
  }
  stats.uploaded++;
  stats.totalBytesUploaded += buffer.length;
  console.log(`  ✓ ${label}: uploaded "${objectPath}" (${buffer.length}b) to ${targetBucket}`);
}

/** Phase 2: CAS-revert one MANIFEST.json entry's DB column back to the legacy public URL,
 *  only if it still holds exactly `secure:<path>`. Orphan entries (no table/column/id) are
 *  always skipped here. */
async function revertOneDbRef(entry, stats) {
  if (!entry.table || !entry.column || entry.id === undefined || entry.id === null) {
    stats.skippedOrphan++;
    console.log(`  ↷ orphan entry "${entry.path}": no DB row — skipped`);
    return;
  }

  const label = `${entry.table}.${entry.column} id=${entry.id}`;
  const key = `${entry.table}.${entry.column}`;
  if (!ALLOWED_COLUMNS.has(key)) {
    stats.failed++;
    console.error(`  ✗ ${label}: "${key}" is outside the known secure-docs column scope — refusing to touch DB`);
    return;
  }

  if (!isSafeStoragePath(entry.path)) {
    stats.failed++;
    console.error(`  ✗ ${label}: unsafe manifest path "${entry.path}" — refusing to touch DB`);
    return;
  }

  const secureValue = `${SECURE_SCHEME}${entry.path}`;
  const publicUrl = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${PUBLIC_BUCKET}/${entry.path}`;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT "${entry.column}" AS val FROM "${entry.table}" WHERE "id" = $1`,
    entry.id
  );
  const current = rows[0]?.val;
  if (current !== secureValue) {
    stats.skippedChanged++;
    console.log(
      `  ↷ ${label}: column is "${current === undefined ? "(row not found)" : truncate(current)}", not "${secureValue}" — left unchanged`
    );
    return;
  }

  if (!APPLY) {
    stats.dbReverted++; // "would revert" in dry run
    console.log(`  (dry run) would set ${label} → ${publicUrl}`);
    return;
  }

  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "${entry.table}" SET "${entry.column}" = $1 WHERE "id" = $2 AND "${entry.column}" = $3`,
    publicUrl,
    entry.id,
    secureValue
  );
  if (affected === 0) {
    stats.skippedChanged++;
    console.warn(`  ↷ ${label}: row changed since read — left unchanged (public object is already restored, safe to re-run)`);
  } else {
    stats.dbReverted++;
    console.log(`  ✓ ${label}: reverted → ${publicUrl}`);
  }
}

function truncate(v, n = 120) {
  const s = (v ?? "").toString();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

(async () => {
  console.log(`Restore source: ${SOURCE}`);
  console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (pass --apply to write)"} — phase: ${ARGS.phase}\n`);

  if (APPLY && RUN_UPLOAD) {
    console.log(
      "########################################################################\n" +
        "# WARNING: --apply is re-publishing sensitive documents (e-signatures, #\n" +
        "# executed contracts, signed estimate PDFs, tax-exempt certs) to the   #\n" +
        "# PUBLIC bucket 'project-files'. This is the emergency undo path — the #\n" +
        "# documents will be world-readable again once uploaded.               #\n" +
        "########################################################################\n"
    );
  }

  if (INCLUDE_ORPHANS && RUN_UPLOAD) {
    console.log(
      "########################################################################\n" +
        "# WARNING: --include-orphans is ALSO restoring orphan-manifest entries #\n" +
        "# — documents that were UNREFERENCED by any DB row when swept. This    #\n" +
        "# re-publishes unreferenced sensitive documents (client signatures,    #\n" +
        "# executed contracts) to their original bucket, which may be the      #\n" +
        "# PUBLIC bucket 'project-files'. This recreates the exact exposure the #\n" +
        "# orphan sweep closed, for files nothing currently references.        #\n" +
        "########################################################################\n"
    );
  }

  console.log("Loading manifests:");
  const manifestEntries = loadManifest("MANIFEST.json");
  const orphanEntries = loadManifest("MANIFEST-orphans.json");
  const orphanSignatureEntries = loadManifest("MANIFEST-orphans-signatures.json");
  const allEntries = [...manifestEntries, ...orphanEntries, ...orphanSignatureEntries];

  if (allEntries.length === 0) {
    console.error("\nNo manifest entries found under --source — nothing to restore.");
    process.exitCode = 1;
    return;
  }
  console.log(`\nTotal entries loaded: ${allEntries.length}\n`);

  const stats = emptyStats();
  stats.scanned = allEntries.length;

  if (RUN_UPLOAD) {
    console.log("Phase 1 — re-upload migrated (still-referenced) documents:");
    for (const entry of manifestEntries) {
      await restoreOneFile(entry, stats);
    }
    console.log("");

    const orphanUploadEntries = [...orphanEntries, ...orphanSignatureEntries];
    if (orphanUploadEntries.length > 0) {
      if (INCLUDE_ORPHANS) {
        console.log("Phase 1b — re-upload orphan-manifest entries (--include-orphans):");
        for (const entry of orphanUploadEntries) {
          await restoreOneFile(entry, stats);
        }
      } else {
        stats.skippedOrphanArchive += orphanUploadEntries.length;
        console.log(
          `Phase 1b — skipping ${orphanUploadEntries.length} orphan-manifest entr${orphanUploadEntries.length === 1 ? "y" : "ies"}: ` +
            `unreferenced by any DB row, so re-publishing them is not this restore's job — pass --include-orphans to restore them anyway.`
        );
      }
      console.log("");
    }
  }

  if (RUN_DB) {
    console.log("Phase 2 — revert DB refs (MANIFEST.json entries only):");
    for (const entry of manifestEntries) {
      await revertOneDbRef(entry, stats);
    }
    // Orphans never had a DB row to begin with — always skipped in this phase.
    stats.skippedOrphan += orphanEntries.length + orphanSignatureEntries.length;
    console.log("");
  }

  console.log(
    `Totals: scanned=${stats.scanned} uploaded=${stats.uploaded} already-present=${stats.alreadyPresent} ` +
      `sha-mismatch=${stats.shaMismatch} db-reverted=${stats.dbReverted} skipped-changed=${stats.skippedChanged} ` +
      `skipped-orphan=${stats.skippedOrphan} skipped-orphan-archive=${stats.skippedOrphanArchive} failed=${stats.failed} ` +
      `total-bytes-uploaded=${stats.totalBytesUploaded}` +
      (APPLY ? "" : " (dry run)")
  );

  if (stats.failed > 0 || stats.shaMismatch > 0) process.exitCode = 1;
})()
  .catch((e) => {
    console.error("Restore failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (prisma) await prisma.$disconnect();
  });
