// One-time backfill: migrate inline signature data-URLs → Supabase Storage URLs.
//
// Moves existing PNG data-URLs out of the signature DB columns and into the
// `project-files` bucket, then rewrites each column to the public Storage URL — the
// same shape new signs now produce via src/lib/signature-storage.ts. This clears the
// large blobs that risk the Supabase PgBouncer pooler message-size error.
//
// SAFE TO RE-RUN: only rows whose column still holds a `data:image…` value are touched;
// already-migrated (http) rows are skipped by the WHERE filter. Each row is independent —
// a failure logs and continues. Columns that don't exist yet on the target DB (e.g. the
// in-flight contract/CO company-countersignature columns) are skipped, not fatal.
//
// Usage:
//   node scripts/backfill-signature-storage.mjs            # dry run — counts only, no writes
//   node scripts/backfill-signature-storage.mjs --apply    # upload + rewrite columns
//
// Requires (read from env or .env / .env.local):
//   DATABASE_URL          Supabase transaction pooler URL (must include ?pgbouncer=true)
//   SUPABASE_URL          Supabase project URL          (only needed with --apply)
//   SUPABASE_SERVICE_KEY  Supabase service role key      (only needed with --apply)
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

const STORAGE_BUCKET = "project-files";
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

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

let supabase = null;
if (APPLY) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("--apply requires SUPABASE_URL and SUPABASE_SERVICE_KEY to upload to Storage");
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// table, column, and the storage key prefix (the row id is appended per row).
const TARGETS = [
  { table: "Contract", column: "signatureUrl", prefix: "contracts" /* /<id>/client */, role: "client" },
  { table: "Contract", column: "contractorSignatureUrl", prefix: "contracts", role: "contractor" },
  { table: "Contract", column: "companySignatureUrl", prefix: "contracts", role: "company" },
  { table: "ChangeOrder", column: "clientSignatureUrl", prefix: "change-orders", role: "client" },
  { table: "ChangeOrder", column: "companySignatureUrl", prefix: "change-orders", role: "company" },
  { table: "ContractSigningRecord", column: "signatureUrl", prefix: "contract-signing-records", role: "" },
];

const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,(.+)$/i;

function keyPrefixFor(t, id) {
  // Mirror src/lib/signature-storage.ts conventions:
  //   contracts/<id>/client | contracts/<id>/contractor | contracts/<id>/company
  //   change-orders/<id>/client | change-orders/<id>/company
  //   contract-signing-records/<id>
  return t.role ? `${t.prefix}/${id}/${t.role}` : `${t.prefix}/${id}`;
}

async function uploadDataUrl(dataUrl, keyPrefix) {
  const m = dataUrl.match(DATA_URL_RE);
  if (!m) throw new Error("not a recognized image data-URL");
  const mime = m[1].toLowerCase();
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length === 0) throw new Error("empty image payload");
  const ext = mime === "jpeg" ? "jpg" : mime;
  const safePrefix = keyPrefix.replace(/[^a-zA-Z0-9/_-]/g, "_");
  const path = `signatures/${safePrefix}/${Date.now()}_${randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, { contentType: `image/${mime}`, upsert: false });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  // Never persist a bare object path — it's neither renderable nor re-migratable.
  if (!data?.publicUrl) throw new Error("getPublicUrl returned no URL");
  return { url: data.publicUrl, path };
}

async function removeObject(path) {
  try {
    await supabase.storage.from(STORAGE_BUCKET).remove([path]);
  } catch {
    /* best-effort cleanup */
  }
}

async function processTarget(t) {
  const label = `${t.table}.${t.column}`;
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT "id", "${t.column}" AS val FROM "${t.table}" WHERE "${t.column}" LIKE 'data:image%'`
    );
  } catch (e) {
    // Most likely the column doesn't exist on this DB yet (in-flight feature) — skip.
    console.log(`• ${label}: skipped (${(e?.message || e).toString().split("\n")[0]})`);
    return { label, found: 0, migrated: 0, failed: 0, skippedColumn: true };
  }

  let migrated = 0;
  let failed = 0;
  let skipped = 0; // row changed under us between SELECT and UPDATE
  for (const row of rows) {
    if (!APPLY) continue;
    let uploaded = null;
    try {
      uploaded = await uploadDataUrl(row.val, keyPrefixFor(t, row.id));
      // Compare-and-swap: only rewrite if the column STILL holds the exact data-URL we
      // read. If it changed (e.g. re-signed) since the SELECT, leave it and drop our orphan.
      const affected = await prisma.$executeRawUnsafe(
        `UPDATE "${t.table}" SET "${t.column}" = $1 WHERE "id" = $2 AND "${t.column}" = $3`,
        uploaded.url,
        row.id,
        row.val
      );
      if (affected === 0) {
        await removeObject(uploaded.path);
        skipped++;
        console.warn(`  ↷ ${label} id=${row.id}: row changed since read — skipped, orphan removed`);
      } else {
        migrated++;
      }
    } catch (e) {
      failed++;
      if (uploaded) await removeObject(uploaded.path); // don't leak on a post-upload failure
      console.error(`  ✗ ${label} id=${row.id}: ${(e?.message || e).toString().split("\n")[0]}`);
    }
  }
  console.log(
    APPLY
      ? `• ${label}: ${rows.length} found → ${migrated} migrated, ${skipped} skipped (changed), ${failed} failed`
      : `• ${label}: ${rows.length} found (dry run — no writes)`
  );
  return { label, found: rows.length, migrated, failed, skipped, skippedColumn: false };
}

(async () => {
  console.log(APPLY ? "Backfill mode: APPLY (uploading + rewriting columns)\n" : "Backfill mode: DRY RUN (pass --apply to write)\n");
  const summary = [];
  for (const t of TARGETS) {
    summary.push(await processTarget(t));
  }
  const totals = summary.reduce(
    (a, s) => ({
      found: a.found + (s.found || 0),
      migrated: a.migrated + (s.migrated || 0),
      skipped: a.skipped + (s.skipped || 0),
      failed: a.failed + (s.failed || 0),
    }),
    { found: 0, migrated: 0, skipped: 0, failed: 0 }
  );
  console.log(
    `\nTotals: ${totals.found} data-URL rows found` +
      (APPLY ? `, ${totals.migrated} migrated, ${totals.skipped} skipped (changed), ${totals.failed} failed` : ` (dry run)`)
  );
  if (totals.failed > 0) process.exitCode = 1;
})()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
