// Runs the QBO expense sync backfill per docs/qbo-expense-sync-runbook.md,
// chunked into month-sized windows so each request finishes well inside the
// serverless maxDuration (the full-range run hit FUNCTION_INVOCATION_TIMEOUT
// twice in production). After the first pass it reruns every chunk to prove
// idempotency (the rerun should report imported/updated/removed all 0 when
// QBO hasn't changed in between).
//
// Usage: node scripts/run-qbo-backfill.mjs [since] [until]
//   default since: 2026-01-01, default until: today (UTC)
// Full per-chunk results are saved as scripts/qbo-backfill-results.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYNC_URL = "https://probuild.goldentouchremodeling.com/api/integrations/qbo-expenses/sync";
const since = process.argv[2] || "2026-01-01";
const until = process.argv[3] || new Date().toISOString().slice(0, 10);

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

// Inclusive month windows: [2026-01-01..2026-01-31], [2026-02-01..2026-02-29], ...
function monthChunks(fromIso, toIso) {
    const chunks = [];
    let cursor = new Date(`${fromIso}T00:00:00.000Z`);
    const end = new Date(`${toIso}T00:00:00.000Z`);
    while (cursor.getTime() <= end.getTime()) {
        const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
        const chunkEnd = monthEnd.getTime() < end.getTime() ? monthEnd : end;
        chunks.push({
            since: cursor.toISOString().slice(0, 10),
            until: chunkEnd.toISOString().slice(0, 10),
        });
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
    return chunks;
}

async function runChunk(chunk, attempt = 1) {
    const started = Date.now();
    const res = await fetch(SYNC_URL, {
        method: "POST",
        headers: { "x-ingest-key": resolveIngestSecret(), "content-type": "application/json" },
        body: JSON.stringify({ mode: "backfill", since: chunk.since, until: chunk.until }),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
        if (attempt < 2) {
            console.log(`  ${chunk.since}..${chunk.until}: HTTP ${res.status} after ${seconds}s — retrying once`);
            return runChunk(chunk, attempt + 1);
        }
        throw new Error(`Chunk ${chunk.since}..${chunk.until} failed twice: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    console.log(`  ${chunk.since}..${chunk.until}: imported ${json.imported}, updated ${json.updated}, removed ${json.removed}, attributionRaceSkipped ${json.attributionRaceSkipped ?? 0}, skipped ${json.skipped?.length ?? 0} (${seconds}s)`);
    return json;
}

function aggregate(results) {
    const total = { imported: 0, updated: 0, removed: 0, attributionRaceSkipped: 0, skipped: [] };
    for (const r of results) {
        total.imported += r.imported;
        total.updated += r.updated;
        total.removed += r.removed;
        // Rows whose create never happened because the estimate moved
        // mid-sync (round 31, item 2) — NOT rolled into imported/updated/
        // removed, and NOT the same as "unchanged". A nonzero count here
        // means real rows are still missing, however clean the other three
        // counters look.
        total.attributionRaceSkipped += r.attributionRaceSkipped ?? 0;
        total.skipped.push(...(r.skipped ?? []));
    }
    return total;
}

function summarizeSkips(skipped) {
    const byReason = {};
    for (const s of skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    return byReason;
}

const chunks = monthChunks(since, until);
console.log(`Backfill ${since}..${until} in ${chunks.length} month chunk(s) against ${SYNC_URL}`);

console.log("\n=== Pass 1 (backfill) ===");
const pass1 = [];
for (const chunk of chunks) pass1.push(await runChunk(chunk));
const total1 = aggregate(pass1);

console.log("\n=== Pass 2 (idempotency check) ===");
const pass2 = [];
for (const chunk of chunks) pass2.push(await runChunk(chunk));
const total2 = aggregate(pass2);

fs.writeFileSync(
    path.join(repoRoot, "scripts", "qbo-backfill-results.json"),
    JSON.stringify({ since, until, chunks, pass1, pass2 }, null, 2),
);

console.log(`\nPass 1 totals: imported ${total1.imported}, updated ${total1.updated}, removed ${total1.removed}, attributionRaceSkipped ${total1.attributionRaceSkipped}, skipped ${total1.skipped.length}`);
if (total1.skipped.length) console.log("Pass 1 skips by reason:", summarizeSkips(total1.skipped));
console.log(`Pass 2 totals: imported ${total2.imported}, updated ${total2.updated}, removed ${total2.removed}, attributionRaceSkipped ${total2.attributionRaceSkipped}, skipped ${total2.skipped.length}`);

// A clean rerun is 0/0/0 on imported/updated/removed AND 0 on
// attributionRaceSkipped. That fourth count is not folded into the others —
// it means a row's CREATE never happened at all because an estimate moved
// mid-sync (round 31, item 2), which the old 0/0/0 check could not see: a
// persistent race skips the same purchases on every pass, so pass 2 reports
// 0/0/0 on the counters that WOULD have caught it while real rows stay
// permanently unimported. This window is not done while either pass hit one.
const idempotent =
    total2.imported === 0 && total2.updated === 0 && total2.removed === 0 &&
    total2.attributionRaceSkipped === 0;
if (idempotent) {
    console.log("Idempotency: PASS (0/0/0 on rerun)");
} else {
    console.log("Idempotency: ATTENTION — rerun was not a no-op (QBO may have changed between passes)");
}
if (total1.attributionRaceSkipped > 0 || total2.attributionRaceSkipped > 0) {
    console.log(
        `INCOMPLETE — this window is NOT done: pass 1 hit ${total1.attributionRaceSkipped} attribution race(s), ` +
        `pass 2 hit ${total2.attributionRaceSkipped}. Those rows were never created. Rerun this backfill for ` +
        `${since}..${until} once the estimate moves have settled — do not treat this window as complete yet.`,
    );
}
console.log("Full results: scripts/qbo-backfill-results.json");
