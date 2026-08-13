// DESTRUCTIVE final step of the secure-docs migration. Run ONLY after
// scripts/migrate-secure-docs.mjs has been run --apply in production and the migration has
// been verified (documents still open correctly, no unexpected missing-object/failed rows).
//
// For every in-scope DB column whose value is now a `secure:<path>` ref, this deletes the
// ORIGINAL object at the same path from the PUBLIC `project-files` bucket. It never touches
// a row whose DB value isn't a `secure:` ref, and it never deletes from `secure-docs`.
//
// Same column scope as scripts/migrate-secure-docs.mjs:
//   Contract.signatureUrl / contractorSignatureUrl / companySignatureUrl / signedPdfPath / originalPdfPath
//   ContractSigningRecord.signatureUrl
//   ChangeOrder.clientSignatureUrl / companySignatureUrl
//   Client.taxExemptCertUrl
//   ProjectFile.url (any row already holding a `secure:` ref — no extra path-pattern
//     filtering needed here, since only rows migrate-secure-docs.mjs touched, or new
//     executed-contract PDFs uploaded straight to secure-docs via uploadSecureDoc(), can
//     ever hold one)
//
// Safety:
//   - Dry run by default. Actually deleting requires BOTH --apply AND
//     --i-understand-this-deletes-public-originals. Passing only one refuses to run at all.
//   - Before deleting a public original, the corresponding secure-docs object's SIZE is
//     fetched via the storage info() API and required to be non-zero AND to match the size
//     of the public original still on disk. A missing, zero-byte, or size-mismatched
//     secure-docs copy is never trusted just because exists() says "yes" — the deletion is
//     refused and logged loudly, never delete a public original that would leave the
//     document unreachable or leave only a corrupt copy behind.
//   - If the public original is already gone (e.g. never existed there — new executed
//     contracts upload straight to secure-docs), that's logged as "already gone", not a
//     failure, and nothing is deleted.
//
// Usage:
//   node scripts/purge-migrated-public-docs.mjs                                                # dry run
//   node scripts/purge-migrated-public-docs.mjs --apply --i-understand-this-deletes-public-originals   # delete
//
// Requires (read from env or .env / .env.local):
//   DATABASE_URL          Supabase transaction pooler URL (must include ?pgbouncer=true)
//   SUPABASE_URL          Supabase project URL
//   SUPABASE_SERVICE_KEY  Supabase service role key
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs";

const PUBLIC_BUCKET = "project-files";
const SECURE_BUCKET = "secure-docs";
const SECURE_SCHEME = "secure:";

const HAS_APPLY = process.argv.includes("--apply");
const HAS_CONFIRM = process.argv.includes("--i-understand-this-deletes-public-originals");
if (HAS_APPLY !== HAS_CONFIRM) {
  console.error(
    "Refusing to run: pass BOTH --apply and --i-understand-this-deletes-public-originals to delete public originals, " +
      "or neither for a dry run."
  );
  process.exit(1);
}
const WILL_DELETE = HAS_APPLY && HAS_CONFIRM;

/**
 * Read a key from the environment, then from the dotenv files in the order the Next.js
 * toolchain resolves them: `.env.local` OVERRIDES `.env`. Checking `.env` first would let a
 * committed default silently win over the local override and point this script's DELETES at the
 * WRONG DATABASE or the WRONG STORAGE BUCKET.
 *
 * Parsing is delegated to `dotenv` rather than hand-rolled: a regex over the line mishandles
 * quoted values containing `#`, `export` prefixes, inline comments, CRLF and multiline values,
 * and every one of those is a silent wrong-target read. `in` rather than a truthiness check at
 * BOTH levels so a source that assigns an EMPTY value — an exported `DATABASE_URL=""` included —
 * still wins over every lower-precedence source and the missing-value check below fails loudly.
 * Resolving one key from the shell and another from a file is how this script ends up enumerating
 * paths out of one project and deleting them out of another.
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

/** Storage path inside SECURE_BUCKET, or null when `value` isn't a secure ref (mirrors
 *  secureRefPath() in src/lib/secure-storage.ts). */
function secureRefPath(value) {
  if (typeof value !== "string" || !value.startsWith(SECURE_SCHEME)) return null;
  const path = value.slice(SECURE_SCHEME.length);
  if (!path || path.startsWith("/") || path.includes("..")) return null;
  return path;
}

/**
 * Fetch an object's size (in bytes) via the storage info() API — verified available on the
 * installed @supabase/storage-js@2.99.0 (node_modules/@supabase/storage-js/src/packages/
 * StorageFileApi.ts, also present in the compiled dist/index.cjs actually loaded at
 * runtime): `.info(path)` returns `{ data: { size, ... } }` on success or
 * `{ data: null, error }` for a missing object or any other failure. Used instead of
 * exists() so the secure-docs copy's integrity can actually be verified before its public
 * original is destroyed.
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

function emptyStats(label) {
  return {
    label,
    scanned: 0,
    deleted: 0,
    wouldDelete: 0,
    alreadyGone: 0,
    refusedMissingSecureCopy: 0,
    refusedCorruptSecureCopy: 0,
    refusedSizeMismatch: 0,
    failed: 0,
  };
}

async function processTarget(t) {
  const label = `${t.table}.${t.column}`;
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT "id", "${t.column}" AS val FROM "${t.table}" WHERE "${t.column}" LIKE '${SECURE_SCHEME}%'`
    );
  } catch (e) {
    console.log(`• ${label}: skipped (${firstLine(e)})`);
    return { ...emptyStats(label), skippedColumn: true };
  }

  const stats = emptyStats(label);
  for (const row of rows) {
    stats.scanned++;
    const path = secureRefPath(row.val);
    if (!path) {
      // Malformed secure ref (leading slash, "..", empty) — refuse to touch anything for it.
      stats.failed++;
      console.error(`  ✗ ${label} id=${row.id}: malformed secure ref "${row.val}" — skipped`);
      continue;
    }

    const secureSize = await getObjectSize(SECURE_BUCKET, path);
    if (secureSize === null) {
      stats.refusedMissingSecureCopy++;
      console.error(
        `  ⚠ REFUSING to delete ${label} id=${row.id}: no object at ${SECURE_BUCKET}/${path} — ` +
          `deleting the public original would make this document unreachable. Re-run migrate-secure-docs.mjs first.`
      );
      continue;
    }
    if (secureSize === 0) {
      stats.refusedCorruptSecureCopy++;
      console.error(
        `  ⚠ REFUSING to delete ${label} id=${row.id}: ${SECURE_BUCKET}/${path} is zero-byte — ` +
          `deleting the public original would leave only a corrupt copy behind. Re-run migrate-secure-docs.mjs first.`
      );
      continue;
    }

    const publicSize = await getObjectSize(PUBLIC_BUCKET, path);
    if (publicSize === null) {
      stats.alreadyGone++;
      console.log(`  · ${label} id=${row.id}: ${PUBLIC_BUCKET}/${path} already gone — nothing to delete`);
      continue;
    }

    if (publicSize !== secureSize) {
      stats.refusedSizeMismatch++;
      console.error(
        `  ⚠ REFUSING to delete ${label} id=${row.id}: size mismatch between ${PUBLIC_BUCKET}/${path} ` +
          `(${publicSize}b) and ${SECURE_BUCKET}/${path} (${secureSize}b) — the secure copy may be corrupt. ` +
          `Re-run migrate-secure-docs.mjs first.`
      );
      continue;
    }

    if (!WILL_DELETE) {
      stats.wouldDelete++;
      console.log(`  (dry run) would delete ${PUBLIC_BUCKET}/${path} (${label} id=${row.id})`);
      continue;
    }

    const { error } = await supabase.storage.from(PUBLIC_BUCKET).remove([path]);
    if (error) {
      stats.failed++;
      console.error(`  ✗ ${label} id=${row.id}: delete of ${PUBLIC_BUCKET}/${path} failed — ${firstLine(error)}`);
      continue;
    }
    stats.deleted++;
    console.log(`  ✓ ${label} id=${row.id}: deleted ${PUBLIC_BUCKET}/${path}`);
  }

  console.log(
    `• ${label}: scanned=${stats.scanned} deleted=${stats.deleted} would-delete=${stats.wouldDelete} ` +
      `already-gone=${stats.alreadyGone} refused-missing-secure-copy=${stats.refusedMissingSecureCopy} ` +
      `refused-corrupt-secure-copy=${stats.refusedCorruptSecureCopy} refused-size-mismatch=${stats.refusedSizeMismatch} ` +
      `failed=${stats.failed}`
  );
  return stats;
}

(async () => {
  console.log(
    WILL_DELETE
      ? "Purge mode: APPLY (deleting public originals — this is IRREVERSIBLE)\n"
      : "Purge mode: DRY RUN (pass --apply --i-understand-this-deletes-public-originals to delete)\n"
  );

  const summaries = [];
  for (const t of TARGETS) {
    summaries.push(await processTarget(t));
  }

  const totals = summaries.reduce(
    (a, s) => ({
      scanned: a.scanned + (s.scanned || 0),
      deleted: a.deleted + (s.deleted || 0),
      wouldDelete: a.wouldDelete + (s.wouldDelete || 0),
      alreadyGone: a.alreadyGone + (s.alreadyGone || 0),
      refusedMissingSecureCopy: a.refusedMissingSecureCopy + (s.refusedMissingSecureCopy || 0),
      refusedCorruptSecureCopy: a.refusedCorruptSecureCopy + (s.refusedCorruptSecureCopy || 0),
      refusedSizeMismatch: a.refusedSizeMismatch + (s.refusedSizeMismatch || 0),
      failed: a.failed + (s.failed || 0),
    }),
    {
      scanned: 0,
      deleted: 0,
      wouldDelete: 0,
      alreadyGone: 0,
      refusedMissingSecureCopy: 0,
      refusedCorruptSecureCopy: 0,
      refusedSizeMismatch: 0,
      failed: 0,
    }
  );
  console.log(
    `\nTotals: scanned=${totals.scanned} deleted=${totals.deleted} would-delete=${totals.wouldDelete} ` +
      `already-gone=${totals.alreadyGone} refused-missing-secure-copy=${totals.refusedMissingSecureCopy} ` +
      `refused-corrupt-secure-copy=${totals.refusedCorruptSecureCopy} refused-size-mismatch=${totals.refusedSizeMismatch} ` +
      `failed=${totals.failed}`
  );
  console.log(`\n${WILL_DELETE ? "Objects deleted from the public bucket:" : "Objects that WOULD be deleted (dry run):"} ${WILL_DELETE ? totals.deleted : totals.wouldDelete}`);
  if (
    totals.failed > 0 ||
    totals.refusedMissingSecureCopy > 0 ||
    totals.refusedCorruptSecureCopy > 0 ||
    totals.refusedSizeMismatch > 0
  ) {
    process.exitCode = 1;
  }
})()
  .catch((e) => {
    console.error("Purge failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
