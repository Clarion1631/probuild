// Shared CLI boundary only. Imported DDL helpers remain inert and injectable
// for disposable PostgreSQL tests; real CLI invocations must name their target.
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseTarget, resolveTargetDatabaseUrl, targetHostVerdict, projectRefVerdict, PRODUCTION_BASELINE_MIGRATION } from "./apply-target.mjs";

export async function runTimeEntryApply(apply, options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const env = options.env ?? process.env;
    const parsed = parseTarget(argv);
    if (parsed.error) throw new Error(parsed.error);
    const { name } = parsed;
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const resolved = (options.resolveUrl ?? (target => resolveTargetDatabaseUrl(target, {
        env, exists: file => existsSync(resolve(root, file)), read: file => readFileSync(resolve(root, file), "utf8"),
    })))(name);
    if (resolved.error) throw new Error(resolved.error);
    const { url } = resolved;
    const refusal = targetHostVerdict(name, url) || projectRefVerdict(name, url, env);
    if (refusal) throw new Error(refusal);
    const target = new URL(url);
    if (target.searchParams.get("pgbouncer") !== "true") throw new Error("Database URL must include pgbouncer=true.");
    if (name === "ci" && !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) throw new Error("--target ci requires a disposable localhost database.");
    const log = options.log ?? console.log;
    // Deliberately no complete URL, password or query parameters in logs.
    log(`target: ${name}, host ${target.host}, database ${target.pathname.slice(1)}`);
    const db = (options.createClient ?? (value => new PrismaClient({ datasources: { db: { url: value } } })))(url);
    try {
        if (name === "prod") {
            const rows = await db.$queryRawUnsafe("SELECT current_database() AS database");
            if (rows.length !== 1 || rows[0].database !== "postgres") throw new Error("Production database name must be postgres.");
            const baseline = await db.$queryRawUnsafe(`SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, PRODUCTION_BASELINE_MIGRATION);
            if (baseline.length !== 1) throw new Error("Production baseline migration is missing or incomplete.");
        }
        await apply(db);
    } finally { await db.$disconnect(); }
}
