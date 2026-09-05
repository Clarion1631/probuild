// Submit visually verified, MICR-redacted WTB check fronts to ProBuild's
// authenticated API. This script never connects to Prisma or Supabase.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH = process.env.BANK_IMAGE_MANIFEST_PATH
    ?? "I:/My Drive/2025 Reconciliation/Washington Trust Bank/Check Images/_manifest.json";
export const INGEST_PATH = "/api/integrations/bank-images/ingest";
const APPROVED_INGEST_ORIGINS = new Set([
    "https://probuild.goldentouchremodeling.com",
    "http://localhost:3000",
]);

export function approvedIngestUrl(value) {
    let base;
    try {
        base = new URL(value);
    } catch {
        return null;
    }
    if (!APPROVED_INGEST_ORIGINS.has(base.origin)) return null;
    return new URL(INGEST_PATH, base);
}

export function acceptedIngestResult(result, sourceExternalId) {
    if (!Array.isArray(result?.results) || result.results.length !== 1) return false;
    const [item] = result.results;
    return item?.sourceExternalId === sourceExternalId
        && ["created", "backfilled", "existing"].includes(item.status);
}

export function expectedSourceExternalId(entry) {
    if (typeof entry?.bankReference !== "string") return null;
    if (entry.kind !== "DEPOSIT_CHECK") return `${entry.bankReference}:front`;
    const sourceSha = entry?.redactionReview?.sourceSha256;
    return typeof sourceSha === "string" && /^[a-f0-9]{64}$/i.test(sourceSha)
        ? `${entry.bankReference}:image:${sourceSha.toLowerCase()}:front`
        : null;
}

export function privateCheckItems(manifest, rootDir) {
    const entries = Object.values(manifest?.images ?? {});
    const items = [];
    const problems = [];
    for (const entry of entries) {
        if (entry?.kind !== "CHECK" && entry?.kind !== "DEPOSIT_CHECK") continue;
        if (entry.kind === "DEPOSIT_CHECK" && entry.direction !== "incoming") {
            problems.push("incoming deposit check lacks incoming direction");
            continue;
        }
        if (entry.micrRedacted !== true) {
            problems.push("check lacks MICR-redaction attestation");
            continue;
        }
        if (typeof entry.capturedAt !== "string" || Number.isNaN(new Date(entry.capturedAt).getTime())) {
            problems.push("check lacks a valid capture timestamp");
            continue;
        }
        const review = entry.redactionReview;
        if (!review || review.status !== "passed" || typeof review.method !== "string" || !Array.isArray(review.cropBox)
            || !Array.isArray(review.sourceDimensions) || !/^[a-f0-9]{64}$/i.test(String(review.sourceSha256 ?? ""))
            || typeof review.reviewer !== "string" || typeof review.reviewedAt !== "string" || Number.isNaN(new Date(review.reviewedAt).getTime())) {
            problems.push("check lacks a verified redaction review");
            continue;
        }
        if (!Array.isArray(entry.files) || entry.files.length !== 1 || entry.files[0]?.side !== "front") {
            problems.push("check does not have exactly one front");
            continue;
        }
        const file = entry.files[0];
        const fileName = String(file.fileName ?? "");
        if (!fileName || path.basename(fileName) !== fileName) {
            problems.push("check has unsafe filename");
            continue;
        }
        const fullPath = path.join(rootDir, fileName);
        if (!fs.existsSync(fullPath)) {
            problems.push("check front is missing locally");
            continue;
        }
        const bytes = fs.readFileSync(fullPath);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (file.sha256 !== sha256 || file.byteSize !== bytes.length) {
            problems.push("check front does not match manifest audit data");
            continue;
        }
        items.push({ ...entry, files: [file], imageBase64: bytes.toString("base64") });
    }
    return { items, problems };
}

async function main() {
    const commit = process.argv.includes("--commit");
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const { items, problems } = privateCheckItems(manifest, path.dirname(MANIFEST_PATH));
    console.log(`eligible redacted check fronts: ${items.length}`);
    if (problems.length) {
        console.error(`rejected checks: ${problems.length}`);
        process.exitCode = 1;
        return;
    }
    if (!commit) {
        console.log("DRY RUN — no image bytes sent.");
        return;
    }
    const baseUrl = approvedIngestUrl(process.env.NEXT_PUBLIC_APP_URL);
    const secret = process.env.BANK_IMAGE_INGEST_SECRET;
    if (!baseUrl || !secret) throw new Error("ProBuild API configuration is unavailable or unapproved");
    const counts = { created: 0, backfilled: 0, existing: 0 };
    for (const item of items) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let response;
        try {
            response = await fetch(baseUrl, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ingest-key": secret },
                body: JSON.stringify({ items: [item] }),
                redirect: "error",
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(`ProBuild check-image ingestion failed (${response.status})`);
        const sourceExternalId = expectedSourceExternalId(item);
        if (!sourceExternalId || !acceptedIngestResult(result, sourceExternalId)) throw new Error("ProBuild returned an invalid check-front ingestion result");
        counts[result.results[0].status] += 1;
    }
    console.log(`ProBuild accepted ${items.length} redacted check front(s): created=${counts.created}, backfilled=${counts.backfilled}, existing=${counts.existing}.`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
