// Load WTB deposit/check images from the Drive manifest into BankImage.
//
// Companion to parse-wtb-daily-csv.mjs. That posts what MOVED; this records
// the EVIDENCE of who paid. A WTB row for money coming in says only
// "OTHER DEPOSITS DEPOSIT - DDA/MMKT" — the image is the only thing that
// names the payer, and for checks written, the memo line carries the job.
//
// Source of truth is the manifest that wtb_deposit_images.py writes:
//   I:\My Drive\2025 Reconciliation\Washington Trust Bank\Check Images\_manifest.json
//
// IDEMPOTENT: identity is (source, sourceExternalId) = ("WTB_ONLINE",
// bankReference). Re-running after a partial pull inserts only what is new,
// exactly like the statement ingest's content hash. Never updates amounts on
// an existing row — evidence is not edited, it is re-filed.
//
//   node scripts/post-bank-images.mjs --dry-run
//   node scripts/post-bank-images.mjs --commit
//
// DATABASE_URL comes from the environment (vercel env pull), never argv.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH =
    "I:/My Drive/2025 Reconciliation/Washington Trust Bank/Check Images/_manifest.json";

export const ACCOUNT = "WTB-0723";
export const SOURCE = "WTB_ONLINE";

/** Digits only, leading zeros stripped — the identity every parser produces. */
export function normalizeCheckNumber(raw) {
    if (raw === null || raw === undefined) return null;
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return null;
    const stripped = digits.replace(/^0+/, "");
    return stripped || null;
}

/** "15,723.38" | "$15,723.38" | 1572338 -> 1572338 (integer cents, >= 0). */
export function toCents(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && Number.isInteger(value)) return Math.abs(value);
    const cleaned = String(value).replace(/[$,\s]/g, "");
    if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    const neg = cleaned.startsWith("-");
    const [whole, frac = ""] = cleaned.replace(/^-/, "").split(".");
    const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents)) return null;
    return neg ? cents : cents; // magnitude only: an image is not a movement
}

/** "08/17/2026" -> "2026-08-17", with real calendar validation. */
export function toIsoDate(raw) {
    if (!raw) return null;
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(raw).trim());
    if (!m) {
        const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
        return iso ? String(raw).trim() : null;
    }
    const [, mm, dd, yyyy] = m;
    const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
    if (
        d.getUTCFullYear() !== Number(yyyy) ||
        d.getUTCMonth() !== Number(mm) - 1 ||
        d.getUTCDate() !== Number(dd)
    ) return null;
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * A manifest entry -> the BankImage rows it implies (one per side).
 * Returns { rows, problems } — a bad entry is REPORTED, never guessed at.
 */
export function entryToRows(entry) {
    const problems = [];
    const ref = String(entry?.bankReference ?? "").trim();
    if (!ref) {
        problems.push("entry has no bankReference");
        return { rows: [], problems };
    }

    const documentDate = toIsoDate(entry.date);
    if (entry.date && !documentDate) problems.push(`${ref}: unreadable date "${entry.date}"`);

    const amountCents = toCents(entry.amountCents ?? entry.amount);
    if (amountCents === null && (entry.amountCents ?? entry.amount) != null) {
        problems.push(`${ref}: unreadable amount "${entry.amountCents ?? entry.amount}"`);
    }

    const checkNumber = normalizeCheckNumber(entry.checkNumber);
    const files = Array.isArray(entry.files) ? entry.files : [];
    if (files.length === 0) problems.push(`${ref}: no files`);

    const rows = files.map((f, i) => {
        // The schema CHECK constraint forces check kinds to carry a number
        // and deposit kinds not to — so derive kind from the DATA, not a flag.
        const isCheck = checkNumber !== null;
        const kind = isCheck
            ? (i === 0 ? "CHECK_FRONT" : "CHECK_BACK")
            : (i === 0 ? "DEPOSIT_SLIP" : "DEPOSIT_PHOTO");
        return {
            source: SOURCE,
            // One row per side, so the side must be part of the identity.
            sourceExternalId: `${ref}:${f.side ?? `img${i + 1}`}`,
            kind,
            account: ACCOUNT,
            capturedAt: entry.capturedAt ? new Date(entry.capturedAt) : new Date(),
            documentDate: documentDate ? new Date(`${documentDate}T00:00:00Z`) : null,
            driveFileId: null,
            fileName: f.fileName,
            mime: "image/jpeg",
            byteSize: Number.isInteger(f.byteSize) ? f.byteSize : null,
            normalizedCheckNumber: isCheck ? checkNumber : null,
            amountCents,
        };
    });

    return { rows, problems };
}

async function main() {
    const commit = process.argv.includes("--commit");
    const dryRun = process.argv.includes("--dry-run") || !commit;

    if (!fs.existsSync(MANIFEST_PATH)) {
        console.error(`No manifest at ${MANIFEST_PATH}`);
        console.error("Nothing has been pulled yet — run the browser step first.");
        process.exitCode = 1;
        return;
    }

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const entries = Object.values(manifest.images ?? {});
    console.log(`manifest: ${entries.length} transaction(s) with images`);

    const allRows = [];
    const allProblems = [];
    for (const e of entries) {
        const { rows, problems } = entryToRows(e);
        allRows.push(...rows);
        allProblems.push(...problems);
    }

    if (allProblems.length) {
        console.error(`\nPROBLEMS (${allProblems.length}) — these entries are NOT loaded:`);
        for (const p of allProblems) console.error(`  ${p}`);
    }
    console.log(`${allRows.length} image row(s) derived`);

    if (dryRun) {
        for (const r of allRows.slice(0, 10)) {
            console.log(
                `  ${r.sourceExternalId.padEnd(22)} ${r.kind.padEnd(13)} ` +
                `${r.documentDate ? r.documentDate.toISOString().slice(0, 10) : "?".padEnd(10)} ` +
                `${r.amountCents === null ? "?" : (r.amountCents / 100).toFixed(2).padStart(11)} ` +
                `${r.normalizedCheckNumber ? "chk#" + r.normalizedCheckNumber : ""}`
            );
        }
        if (allRows.length > 10) console.log(`  ... and ${allRows.length - 10} more`);
        console.log("\nDRY RUN — nothing written. Re-run with --commit.");
        return;
    }

    const prisma = new PrismaClient();
    let inserted = 0, existing = 0;
    try {
        for (const row of allRows) {
            const found = await prisma.bankImage.findUnique({
                where: { source_sourceExternalId: { source: row.source, sourceExternalId: row.sourceExternalId } },
                select: { id: true },
            });
            if (found) { existing++; continue; }
            await prisma.bankImage.create({ data: row });
            inserted++;
        }
        console.log(`\ninserted ${inserted}, existing ${existing} (replay is a no-op)`);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
