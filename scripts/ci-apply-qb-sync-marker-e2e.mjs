/**
 * Drive scripts/apply-qb-sync-marker.mjs end to end against a throwaway
 * database, the way production will run it.
 *
 * CI-only. The migration replay proves the committed SQL; it never runs the
 * SCRIPT, and `main()` is the one part of that file no test executes. A
 * verify-pass bug — the information_schema read that is supposed to prove the
 * columns landed — would sail through every other check we have.
 *
 * It builds a PRE-MARKER database (the qbSyncMarker migration directory is
 * moved aside for `migrate deploy`), runs the real script so it has to create
 * the columns itself, runs it AGAIN to prove idempotency, and then asserts the
 * resulting shape matches what the committed migration would have produced.
 */
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { renameSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER = process.env.APPLY_E2E_SERVER_URL;
const DB = process.env.APPLY_E2E_DB ?? "probuild_apply";
if (!SERVER) {
    console.error("APPLY_E2E_SERVER_URL is required (a URL on the throwaway server).");
    process.exit(1);
}
if (/supabase\.(co|com)/i.test(SERVER)) {
    console.error("REFUSING: APPLY_E2E_SERVER_URL looks like production.");
    process.exit(1);
}

const target = new URL(SERVER);
target.pathname = `/${DB}`;
const targetUrl = target.toString();

const admin = new URL(SERVER);
admin.pathname = "/postgres";

const run = (cmd, args, env) =>
    execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });

const adminClient = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
try {
    await adminClient.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}"`);
    await adminClient.$executeRawUnsafe(`CREATE DATABASE "${DB}"`);
} finally {
    await adminClient.$disconnect();
}

// A genuine from-scratch apply: build the schema WITHOUT the marker migration,
// so the script has to add both columns itself rather than finding them there.
const migration = path.join("prisma", "migrations", "20260903120000_qb_sync_marker");
const parked = path.join(mkdtempSync(path.join(tmpdir(), "qbmig-")), "20260903120000_qb_sync_marker");
renameSync(migration, parked);
try {
    run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: targetUrl, DIRECT_URL: targetUrl });
} finally {
    renameSync(parked, migration);
}

const script = path.join("scripts", "apply-qb-sync-marker.mjs");
// `--target ci`: the ambient DATABASE_URL, no production baseline row and no
// project ref, and the script refuses outright if that URL looks like Supabase.
// The prod guard therefore cannot be satisfied through this path.
const env = { DATABASE_URL: targetUrl };

console.log("\n=== apply ===");
run("node", [script, "--target", "ci"], env);
// Idempotency is the property that makes this safe to run before a deploy and
// safe to re-run after a half-finished one.
console.log("\n=== apply, again (idempotency) ===");
run("node", [script, "--target", "ci"], env);

// And the shape it produced is the shape the committed migration describes.
const client = new PrismaClient({ datasources: { db: { url: targetUrl } } });
try {
    const rows = await client.$queryRawUnsafe(`
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name IN ('Estimate', 'Invoice') AND column_name = 'qbSyncMarker'
        ORDER BY table_name
    `);
    const shape = rows.map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`);
    const expected = [
        "Estimate.qbSyncMarker text YES",
        "Invoice.qbSyncMarker text YES",
    ];
    if (JSON.stringify(shape) !== JSON.stringify(expected)) {
        console.error("Applied shape does not match the committed migration:");
        console.error("  expected:", expected);
        console.error("  actual:  ", shape);
        process.exit(1);
    }
    console.log("\nshape matches the committed migration:", shape.join("; "));
} finally {
    await client.$disconnect();
}

console.log("\napply script end-to-end: OK");
