#!/usr/bin/env node
// Speed-to-Lead v1 (PB-leads-001) — prebuild fingerprint (spec Release
// "Fingerprint"): "A prebuild step writes SPEED_TO_LEAD_FINGERPRINT, the
// sha256 of src/lib/speed-to-lead/**, the ingest, cron and outreach routes
// and pages, and the related Prisma models."
//
// WHY A GENERATED .env.production.local FILE, NOT process.env DIRECTLY.
// This script runs in its own `node` process (wired as npm's "prebuild"
// lifecycle hook, before `next build`). Setting process.env here would only
// affect THIS process — it cannot reach the later `next build` process, and
// it certainly cannot reach the deployed serverless function's runtime.
// Next.js's own env loader (`@next/env`) reads `.env.production.local` at
// BOTH build time and server-start time, on Vercel same as anywhere else, so
// writing that file here is what actually gets the value read by
// src/lib/speed-to-lead/fingerprint.ts's `process.env.SPEED_TO_LEAD_FINGERPRINT`
// in production. The file is gitignored and regenerated fresh on every
// build — its content describes THIS deploy's code, never a stale commit.
//
// WHY migration.sql STANDS IN FOR "the related Prisma models". Hashing the
// whole of schema.prisma would make an UNRELATED feature's schema change
// lapse Speed-to-Lead's LIVE activation too — spec Release explicitly says
// "Unrelated deploys don't [lapse LIVE]." migration.sql fully and only
// describes this feature's DB shape.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FINGERPRINT_INPUTS = [
    "src/lib/speed-to-lead",
    "src/app/api/speed-to-lead",
    "src/app/api/cron/speed-to-lead",
    "src/app/leads/outreach",
    "src/app/settings/speed-to-lead",
    "prisma/migrations/20260925120000_speed_to_lead/migration.sql",
];

function collectFiles(relPath) {
    const abs = path.join(ROOT, relPath);
    let stat;
    try {
        stat = statSync(abs);
    } catch {
        return [];
    }
    if (stat.isFile()) return [relPath];
    const out = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const childRel = path.join(relPath, entry.name);
        if (entry.isDirectory()) out.push(...collectFiles(childRel));
        else out.push(childRel);
    }
    return out;
}

export function computeFingerprint() {
    const files = FINGERPRINT_INPUTS.flatMap(collectFiles)
        .map(p => p.split(path.sep).join("/"))
        .sort();
    const hash = createHash("sha256");
    for (const file of files) {
        hash.update(file);
        hash.update("\u0000");
        hash.update(readFileSync(path.join(ROOT, file)));
        hash.update("\u0000");
    }
    return hash.digest("hex");
}

function main() {
    const fingerprint = computeFingerprint();
    const envFile = path.join(ROOT, ".env.production.local");
    let existing = "";
    try {
        existing = readFileSync(envFile, "utf8");
    } catch {
        existing = "";
    }
    const withoutOldLine = existing.split("\n").filter(line => !line.startsWith("SPEED_TO_LEAD_FINGERPRINT=")).join("\n");
    const next = `${withoutOldLine.trimEnd()}\nSPEED_TO_LEAD_FINGERPRINT=${fingerprint}\n`.replace(/^\n+/, "");
    writeFileSync(envFile, next);
    console.log(`[speed-to-lead-fingerprint] ${fingerprint}`);
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main();
}
