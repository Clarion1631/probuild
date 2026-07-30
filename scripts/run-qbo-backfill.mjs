// Runs the QBO expense sync backfill per docs/qbo-expense-sync-runbook.md,
// then immediately reruns it to prove idempotency (run 2 should report
// imported: 0, updated: 0, removed: 0 when QBO hasn't changed in between).
//
// Usage: node scripts/run-qbo-backfill.mjs [since]   (default since: 2026-01-01)
// Results are saved next to this script as qbo-backfill-run1.json / run2.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYNC_URL = "https://probuild.goldentouchremodeling.com/api/integrations/qbo-expenses/sync";
const since = process.argv[2] || "2026-01-01";

function resolveIngestSecret() {
    if (process.env.RECEIPT_INGEST_SECRET) return process.env.RECEIPT_INGEST_SECRET;
    for (const file of [".env.production.local", ".env.local", ".env"]) {
        const p = path.join(repoRoot, file);
        if (!fs.existsSync(p)) continue;
        const match = fs.readFileSync(p, "utf8").match(/^RECEIPT_INGEST_SECRET\s*=\s*"?([^"\r\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("RECEIPT_INGEST_SECRET not found in env or .env files (run: vercel env pull .env.production.local --environment=production)");
}

async function runSync(label, outFile) {
    const res = await fetch(SYNC_URL, {
        method: "POST",
        headers: { "x-ingest-key": resolveIngestSecret(), "content-type": "application/json" },
        body: JSON.stringify({ mode: "backfill", since }),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    fs.writeFileSync(path.join(repoRoot, "scripts", outFile), JSON.stringify(json, null, 2));
    console.log(`\n=== ${label} (HTTP ${res.status}) ===`);
    console.log(`imported: ${json.imported}  updated: ${json.updated}  removed: ${json.removed}  skipped: ${json.skipped?.length ?? "?"}`);
    if (json.skipped?.length) {
        const byReason = {};
        for (const s of json.skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
        console.log("skipped by reason:", byReason);
    }
    if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return json;
}

console.log(`Backfill since ${since} against ${SYNC_URL}`);
const run1 = await runSync("Run 1 (backfill)", "qbo-backfill-run1.json");
const run2 = await runSync("Run 2 (idempotency check)", "qbo-backfill-run2.json");

const idempotent = run2.imported === 0 && run2.updated === 0 && run2.removed === 0;
console.log(`\nIdempotency: ${idempotent ? "PASS (0/0/0 on rerun)" : "ATTENTION — rerun was not a no-op (QBO may have changed between runs)"}`);
console.log("Full results: scripts/qbo-backfill-run1.json / run2.json");
