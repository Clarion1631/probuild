// Reviewed additive DDL only. Run before application deployment; no automatic
// repair of existing punches. Importing this module never reads env or writes.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
async function main() {
    const db = new PrismaClient();
    try { await applyClockInIntegrity(db); console.log("Clock-in integrity schema applied."); }
    catch { console.error("Clock-in integrity migration failed; no automatic data repair. Inspect existing open-punch counts and migration compatibility."); process.exitCode = 1; }
    finally { await db.$disconnect(); }
}
export async function applyClockInIntegrity(db) {
    const migrationPath = new URL("../prisma/migrations/20260906220000_clock_in_integrity/migration.sql", import.meta.url);
    // pg executes the reviewed SQL as one transaction; Prisma's prepared raw
    // execution cannot accept multiple commands. Split only outside the DO block.
    const sql = readFileSync(migrationPath, "utf8");
    const chunks = sql.split(/(?<=;)\s*\n(?=\s*(?:CREATE|ALTER))/);
    await db.$transaction(async tx => {
        for (const statement of chunks) await tx.$executeRawUnsafe(statement);
        const indexes = await tx.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'TimeEntry_one_open_per_user'`);
        const expected = 'CREATE UNIQUE INDEX "TimeEntry_one_open_per_user" ON public."TimeEntry" USING btree ("userId") WHERE (("endTime" IS NULL) AND ("durationHours" IS NULL))';
        if (indexes.length !== 1 || indexes[0].indexdef !== expected) throw new Error("Clock-in index shape does not match reviewed migration");
    });
}
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) { await main(); }
