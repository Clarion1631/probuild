/**
 * Sweep orphaned signature objects out of the PUBLIC bucket.
 *
 * The document migration (migrate-secure-docs.mjs) moves objects that a DB row points at.
 * It cannot see ORPHANS: signature objects left in storage that no row references. These
 * arise when a signing action uploads before its guarded DB write and then loses an
 * idempotency race or hits the already-signed retry, and when a re-sign supersedes an
 * earlier object. Orphans are still real client signatures, and in a public bucket they
 * stay world-readable forever.
 *
 * This backs each orphan up, verifies the copy byte-for-byte, then deletes the public
 * original. It REFUSES to touch any object referenced by any DB column.
 *
 * Dry run by default:
 *   node scripts/sweep-orphaned-public-signatures.mjs --dest "<backup dir>"
 *   node scripts/sweep-orphaned-public-signatures.mjs --dest "<backup dir>" --apply
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
const prisma = new PrismaClient();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function walk(prefix, out) {
    let offset = 0;
    for (;;) {
        const { data, error } = await supabase.storage
            .from(PUBLIC_BUCKET)
            .list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
        if (error) throw new Error(`list ${prefix}: ${error.message}`);
        if (!data || data.length === 0) return;
        for (const e of data) {
            const full = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.id === null) await walk(full, out);
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
    ? "Sweep mode: APPLY (orphans will be backed up, verified, then DELETED from the public bucket)\n"
    : "Sweep mode: DRY RUN (pass --apply to back up and delete)\n");

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

// Sensitive PDFs (executed contracts, signed estimates, intermediate signed contracts)
// live interleaved with ordinary PUBLIC project files, so they are matched by rule rather
// than by prefix — the same rule the migration used. Ordinary project files never match.
const isSensitivePdf = (p) =>
    p.includes("_Executed_Contract_") ||
    /^(projects|leads)\/[^/]+\/signed\//.test(p) ||
    (p.includes("/intermediate/") && p.toLowerCase().endsWith(".pdf"));

const objects = [];
await walk("signatures", objects);            // whole prefix is sensitive by definition
const pdfCandidates = [];
for (const root of ["projects", "leads"]) await walk(root, pdfCandidates);
objects.push(...pdfCandidates.filter((o) => isSensitivePdf(o.path)));
console.log(`Sensitive objects in the PUBLIC bucket: ${objects.length}\n`);

const stats = { scanned: 0, swept: 0, refusedReferenced: 0, failed: 0, bytes: 0 };
const manifest = [];

for (const obj of objects) {
    stats.scanned++;
    if (obj.path.includes("..") || obj.path.startsWith("/")) {
        console.log(`  ! refusing suspicious path ${obj.path}`);
        stats.failed++;
        continue;
    }
    // Full-path match, plus a deliberately stricter basename match so that a stored value
    // differing only by URL-encoding can never let a still-referenced object be deleted.
    // Erring toward "referenced" only ever leaves a file in place; the reverse loses data.
    const basename = obj.path.slice(obj.path.lastIndexOf("/") + 1);
    if (refValues.some((v) => v.includes(obj.path) || v.includes(basename))) {
        console.log(`  = REFERENCED, left alone: ${obj.path}`);
        stats.refusedReferenced++;
        continue;
    }

    const { data, error } = await supabase.storage.from(PUBLIC_BUCKET).download(obj.path);
    if (error || !data) {
        console.log(`  ! download failed, NOT deleting: ${obj.path} (${error?.message ?? "no data"})`);
        stats.failed++;
        continue;
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.length === 0) {
        console.log(`  ! zero bytes downloaded, NOT deleting: ${obj.path}`);
        stats.failed++;
        continue;
    }

    const target = join(resolve(DEST), obj.path.replace(/\//g, "\\"));
    if (APPLY) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
        const written = statSync(target).size;
        if (written !== bytes.length) {
            console.log(`  ! backup size mismatch, NOT deleting: ${obj.path}`);
            stats.failed++;
            continue;
        }
    }
    const sha = createHash("sha256").update(bytes).digest("hex");
    manifest.push({ path: obj.path, size: bytes.length, sha256: sha, orphan: true });

    if (!APPLY) {
        console.log(`  (dry run) would back up + delete ${obj.path} (${bytes.length}b)`);
        continue;
    }

    const del = await supabase.storage.from(PUBLIC_BUCKET).remove([obj.path]);
    if (del.error) {
        console.log(`  ! delete failed (backup kept): ${obj.path} (${del.error.message})`);
        stats.failed++;
        continue;
    }
    console.log(`  ✓ swept ${obj.path} (${bytes.length}b)`);
    stats.swept++;
    stats.bytes += bytes.length;
}

if (APPLY && manifest.length > 0) {
    const mPath = join(resolve(DEST), "MANIFEST-orphans.json");
    writeFileSync(mPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        sourceBucket: PUBLIC_BUCKET,
        note: "Orphaned signature objects: present in storage, referenced by no DB row. Backed up then deleted from the public bucket.",
        files: manifest,
    }, null, 2));
    console.log(`\nManifest written to ${mPath} (${manifest.length} files)`);
}

console.log(`\nTotals: scanned=${stats.scanned} swept=${stats.swept} referenced-left-alone=${stats.refusedReferenced} failed=${stats.failed} bytes=${stats.bytes}${APPLY ? "" : " (dry run)"}`);
if (stats.failed > 0) process.exitCode = 1;
await prisma.$disconnect();
