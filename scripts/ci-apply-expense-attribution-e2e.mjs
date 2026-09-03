/**
 * Drive scripts/apply-expense-attribution.mjs end to end against a throwaway
 * database, the way production will run it (round 46, item 0).
 *
 * CI-only. It builds a PRE-PHASE-3 database (the phase-3 migration directory is
 * moved aside for the `migrate deploy`), then runs the real script: pre-deploy,
 * the mandatory post-deploy pass, and a second pre-deploy run to prove
 * idempotency. `main()` is the one part of that script no other test executes,
 * and it is where the Postgres-16 CHECK-rendering blocker lived.
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

// A genuine from-scratch apply: build the schema WITHOUT the phase-3 migration,
// so the script has to create the whole shape itself.
const phase3 = path.join("prisma", "migrations", "20260901120000_expense_attribution");
const parked = path.join(mkdtempSync(path.join(tmpdir(), "p3mig-")), "20260901120000_expense_attribution");
renameSync(phase3, parked);
try {
    run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: targetUrl, DIRECT_URL: targetUrl });
} finally {
    renameSync(parked, phase3);
}

const client = new PrismaClient({ datasources: { db: { url: targetUrl } } });
let host;
try {
    const [row] = await client.$queryRawUnsafe(
        `SELECT COALESCE(host(inet_server_addr()), '') AS host`,
    );
    host = row.host;
} finally {
    await client.$disconnect();
}
console.log(`resolved server host: ${host || "(local socket)"}`);

const script = path.join("scripts", "apply-expense-attribution.mjs");
// `--target ci`: ambient DATABASE_URL, no production baseline row, and the
// script refuses outright if that URL looks like Supabase. The prod guard
// therefore cannot be satisfied by this path even by accident.
const guard = ["--target", "ci", "--yes", "--expect-db", DB, "--expect-host", host];
const env = { DATABASE_URL: targetUrl };

console.log("\n=== pre-deploy ===");
run("node", [script, ...guard], env);
console.log("\n=== post-deploy ===");
run("node", [script, "--post-deploy", ...guard], env);
// Idempotency is the property the two-transaction split rests on: a crash
// between the phases has to be safe to re-run from the top.
console.log("\n=== pre-deploy, again (idempotency) ===");
run("node", [script, ...guard], env);
console.log("\napply script end-to-end: OK");
