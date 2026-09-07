// Explicit pre-deploy DDL. No data correction or void is performed here.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
async function main() {
    const db = new PrismaClient();
    try { await applyTimeEntryVoid(db); console.log("Time-entry void schema applied."); }
    catch { console.error("Time-entry void migration failed; no source entries were corrected."); process.exitCode = 1; }
    finally { await db.$disconnect(); }
}
export async function applyTimeEntryVoid(db) {
    const sql = readFileSync(new URL("../prisma/migrations/20260907000000_time_entry_void/migration.sql", import.meta.url), "utf8");
    await db.$transaction(async tx => {
        for (const statement of sql.split("-- statement-break")) if (statement.trim()) await tx.$executeRawUnsafe(statement);
        const indexes = await tx.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'TimeEntry_one_open_per_user'`);
        const expected = 'CREATE UNIQUE INDEX "TimeEntry_one_open_per_user" ON public."TimeEntry" USING btree ("userId") WHERE (("endTime" IS NULL) AND ("durationHours" IS NULL) AND ("voidedAt" IS NULL))';
        if (indexes.length !== 1 || indexes[0].indexdef !== expected) throw new Error("Open-punch index differs from reviewed void predicate");
    });
}
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) { await main(); }
