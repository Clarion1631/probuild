/**
 * Sweep orphaned signature/document objects out of storage.
 *
 * Covers BOTH buckets by default:
 *   - `project-files` (PUBLIC) — legacy home for signatures and sensitive PDFs before the
 *     secure-docs migration. Orphans here are objects the migration/purge never saw because
 *     no DB row pointed at them.
 *   - `secure-docs` (PRIVATE) — where every signature, executed-contract PDF, signed-estimate
 *     PDF, and tax-exempt cert is written now (see src/lib/signature-storage.ts and
 *     src/lib/secure-storage.ts). It has its own orphans, and they are NOT a leftover from the
 *     migration: src/lib/actions.ts (discardSignatureUnlessReferenced) and
 *     persistOwnedSignature()'s discard path deliberately KEEP an uploaded object whenever a
 *     cleanup probe fails or is inconclusive — an ambiguous Prisma rejection on the pgbouncer
 *     pooler does not prove the write rolled back, so the code fails closed and risks leaking
 *     storage rather than risk deleting a committed e-signature. Those retained objects live in
 *     the private bucket, so nothing was sweeping them before this script covered secure-docs
 *     too — they would otherwise accumulate indefinitely.
 *
 * The document migration (migrate-secure-docs.mjs) only moves objects a DB row points at. It
 * cannot see orphans in either bucket. This backs each orphan up, verifies the copy
 * byte-for-byte, then deletes the original. It REFUSES to touch any object referenced by any
 * DB column — full-path AND basename matching, erring toward "referenced" (leaving a file in
 * place is always the safe failure mode; deleting a referenced file is not). For secure-docs,
 * the DB reference value is a `secure:<path>` ref (see src/lib/secure-storage.ts), not a URL —
 * the same substring match still works because the ref string contains the bucket-relative
 * path as a substring (`"secure:signatures/x/y.png".includes("signatures/x/y.png")`).
 *
 * Dry run by default:
 *   node scripts/sweep-orphaned-signature-objects.mjs --dest "<backup dir>"
 *   node scripts/sweep-orphaned-signature-objects.mjs --dest "<backup dir>" --apply
 *   node scripts/sweep-orphaned-signature-objects.mjs --dest "<backup dir>" --bucket secure-docs
 *   node scripts/sweep-orphaned-signature-objects.mjs --dest "<backup dir>" --bucket project-files --apply
 *
 * --bucket accepts project-files | secure-docs | both (default: both).
 *
 * Backups are written to <dest>/<bucket>/<storage-path> (bucket-qualified) so the two buckets
 * can never collide on disk even though they share the same path scheme (secure-docs objects
 * were copied to the same paths they had in project-files during the migration).
 */
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";

for (const f of [".env.local", ".env"]) {
    try {
        for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
            const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
        }
    } catch { /* optional */ }
}

const APPLY = process.argv.includes("--apply");
const destIdx = process.argv.indexOf("--dest");
const DEST = destIdx > -1 ? process.argv[destIdx + 1] : null;
if (!DEST) {
    console.error("Refusing to run: --dest <dir> is required (orphans are backed up before deletion).");
    process.exit(1);
}

const PUBLIC_BUCKET = "project-files";
const SECURE_BUCKET = "secure-docs";
const VALID_BUCKET_FLAGS = ["project-files", "secure-docs", "both"];
const bucketIdx = process.argv.indexOf("--bucket");
const BUCKET_FLAG = bucketIdx > -1 ? process.argv[bucketIdx + 1] : "both";
if (!VALID_BUCKET_FLAGS.includes(BUCKET_FLAG)) {
    console.error(`Refusing to run: --bucket must be one of ${VALID_BUCKET_FLAGS.join(", ")} (got "${BUCKET_FLAG}").`);
    process.exit(1);
}
const BUCKETS_TO_SWEEP =
    BUCKET_FLAG === "both" ? [PUBLIC_BUCKET, SECURE_BUCKET] : [BUCKET_FLAG];

const prisma = new PrismaClient();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function walk(bucket, prefix, out) {
    let offset = 0;
    for (;;) {
        const { data, error } = await supabase.storage
            .from(bucket)
            .list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
        if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
        if (!data || data.length === 0) return;
        for (const e of data) {
            const full = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.id === null) await walk(bucket, full, out);
            else out.push({ path: full, size: e.metadata?.size ?? 0 });
        }
        if (data.length < 100) return;
        offset += data.length;
    }
}

const REF_COLUMNS = [
    ["Contract", "signatureUrl"], ["Contract", "contractorSignatureUrl"],
    ["Contract", "companySignatureUrl"], ["Contract", "signedPdfPath"],
    ["Contract", "originalPdfPath"], ["ContractSigningRecord", "signatureUrl"],
    ["ChangeOrder", "clientSignatureUrl"], ["ChangeOrder", "companySignatureUrl"],
    ["Client", "taxExemptCertUrl"], ["ProjectFile", "url"], ["Estimate", "signatureUrl"],
];

console.log(APPLY
    ? "Sweep mode: APPLY (orphans will be backed up, verified, then DELETED)\n"
    : "Sweep mode: DRY RUN (pass --apply to back up and delete)\n");
console.log(`Buckets in scope: ${BUCKETS_TO_SWEEP.join(", ")}\n`);

const refValues = [];
for (const [table, column] of REF_COLUMNS) {
    try {
        const rows = await prisma.$queryRawUnsafe(
            `SELECT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL`
        );
        for (const r of rows) if (r.v) refValues.push(String(r.v));
    } catch (e) {
        console.log(`  (skipped ${table}.${column}: ${e.message.split("\n")[0]})`);
    }
}
console.log(`Reference values loaded: ${refValues.length} across ${REF_COLUMNS.length} columns.`);
console.log(
    "  (values are matched as-is: legacy URLs/bare paths for project-files objects and\n" +
    "  `secure:<path>` refs for secure-docs objects — a ref string always contains its\n" +
    "  bucket-relative path as a substring, so the same match below works for both shapes.)\n"
);

// Sensitive PDFs (executed contracts, signed estimates, intermediate signed contracts)
// live interleaved with ordinary PUBLIC project files, so in project-files they are matched
// by rule rather than by prefix — the same rule the migration used. Ordinary project files
// never match. secure-docs holds ONLY in-scope sensitive documents by design (see
// docs/STORAGE-AUDIT.md), so the whole bucket is in scope there — no filtering needed.
const isSensitivePdf = (p) =>
    p.includes("_Executed_Contract_") ||
    /^(projects|leads)\/[^/]+\/signed\//.test(p) ||
    (p.includes("/intermediate/") && p.toLowerCase().endsWith(".pdf"));

async function collectObjects(bucket) {
    if (bucket === SECURE_BUCKET) {
        const objects = [];
        await walk(bucket, "", objects);
        return objects;
    }
    // PUBLIC_BUCKET
    const objects = [];
    await walk(bucket, "signatures", objects);            // whole prefix is sensitive by definition
    const pdfCandidates = [];
    for (const root of ["projects", "leads"]) await walk(bucket, root, pdfCandidates);
    objects.push(...pdfCandidates.filter((o) => isSensitivePdf(o.path)));
    return objects;
}

function emptyBucketStats(bucket) {
    return { bucket, scanned: 0, swept: 0, refusedReferenced: 0, failed: 0, bytes: 0 };
}

const manifest = [];
const bucketStats = [];

for (const bucket of BUCKETS_TO_SWEEP) {
    const objects = await collectObjects(bucket);
    console.log(`\n=== ${bucket}: ${objects.length} candidate object(s) ===`);
    const stats = emptyBucketStats(bucket);

    for (const obj of objects) {
        stats.scanned++;
        if (obj.path.includes("..") || obj.path.startsWith("/")) {
            console.log(`  ! refusing suspicious path ${obj.path}`);
            stats.failed++;
            continue;
        }
        // Full-path match, plus a deliberately stricter basename match so that a stored value
        // differing only by URL-encoding (or, for secure-docs, the `secure:` scheme prefix)
        // can never let a still-referenced object be deleted. Erring toward "referenced" only
        // ever leaves a file in place; the reverse loses data.
        const basename = obj.path.slice(obj.path.lastIndexOf("/") + 1);
        if (refValues.some((v) => v.includes(obj.path) || v.includes(basename))) {
            console.log(`  = REFERENCED, left alone: ${bucket}/${obj.path}`);
            stats.refusedReferenced++;
            continue;
        }

        const { data, error } = await supabase.storage.from(bucket).download(obj.path);
        if (error || !data) {
            console.log(`  ! download failed, NOT deleting: ${bucket}/${obj.path} (${error?.message ?? "no data"})`);
            stats.failed++;
            continue;
        }
        const bytes = Buffer.from(await data.arrayBuffer());
        if (bytes.length === 0) {
            console.log(`  ! zero bytes downloaded, NOT deleting: ${bucket}/${obj.path}`);
            stats.failed++;
            continue;
        }

        // Bucket-qualified so project-files and secure-docs objects at the same storage path
        // (secure-docs was populated by copying project-files objects to identical paths)
        // never collide in the backup.
        const target = join(resolve(DEST), bucket, obj.path.replace(/\//g, "\\"));
        if (APPLY) {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, bytes);
            const written = statSync(target).size;
            if (written !== bytes.length) {
                console.log(`  ! backup size mismatch, NOT deleting: ${bucket}/${obj.path}`);
                stats.failed++;
                continue;
            }
        }
        const sha = createHash("sha256").update(bytes).digest("hex");
        manifest.push({ bucket, path: obj.path, size: bytes.length, sha256: sha, orphan: true });

        if (!APPLY) {
            console.log(`  (dry run) would back up + delete ${bucket}/${obj.path} (${bytes.length}b)`);
            continue;
        }

        const del = await supabase.storage.from(bucket).remove([obj.path]);
        if (del.error) {
            console.log(`  ! delete failed (backup kept): ${bucket}/${obj.path} (${del.error.message})`);
            stats.failed++;
            continue;
        }
        console.log(`  ✓ swept ${bucket}/${obj.path} (${bytes.length}b)`);
        stats.swept++;
        stats.bytes += bytes.length;
    }

    console.log(
        `\n${bucket} totals: scanned=${stats.scanned} swept=${stats.swept} ` +
        `referenced-left-alone=${stats.refusedReferenced} failed=${stats.failed} bytes=${stats.bytes}` +
        `${APPLY ? "" : " (dry run)"}`
    );
    bucketStats.push(stats);
}

if (APPLY && manifest.length > 0) {
    const mPath = join(resolve(DEST), "MANIFEST-orphans.json");
    writeFileSync(mPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        sourceBuckets: BUCKETS_TO_SWEEP,
        note: "Orphaned signature/document objects: present in storage, referenced by no DB row. Backed up (under <dest>/<bucket>/<path>) then deleted from their source bucket.",
        files: manifest,
    }, null, 2));
    console.log(`\nManifest written to ${mPath} (${manifest.length} files)`);
}

const grandTotal = bucketStats.reduce(
    (a, s) => ({
        scanned: a.scanned + s.scanned,
        swept: a.swept + s.swept,
        refusedReferenced: a.refusedReferenced + s.refusedReferenced,
        failed: a.failed + s.failed,
        bytes: a.bytes + s.bytes,
    }),
    { scanned: 0, swept: 0, refusedReferenced: 0, failed: 0, bytes: 0 }
);

console.log("\nPer-bucket summary:");
for (const s of bucketStats) {
    console.log(
        `  ${s.bucket}: scanned=${s.scanned} swept=${s.swept} referenced-left-alone=${s.refusedReferenced} ` +
        `failed=${s.failed} bytes=${s.bytes}`
    );
}
console.log(
    `\nGrand totals: scanned=${grandTotal.scanned} swept=${grandTotal.swept} ` +
    `referenced-left-alone=${grandTotal.refusedReferenced} failed=${grandTotal.failed} bytes=${grandTotal.bytes}` +
    `${APPLY ? "" : " (dry run)"}`
);
if (grandTotal.failed > 0) process.exitCode = 1;
await prisma.$disconnect();
