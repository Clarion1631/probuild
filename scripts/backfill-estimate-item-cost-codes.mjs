// Backfill cost codes onto the 15 TRUE uncoded estimate items on In Progress
// jobs. Approved by Justin 2026-08-19 (all 15 as proposed).
//
// SAFETY SHAPE (see the gtr-probuild-deploy skill, references/probuild-prod-data-queries.md):
//   1. Dry-run by DEFAULT. `--apply` is required to write.
//   2. Targeted by item ID, then the fetched name is ASSERTED against the
//      expected name — a stale copy-pasted id aborts the whole run.
//   3. Precondition: the item must still have NO cost code. An item somebody
//      coded by hand in the meantime is skipped, never overwritten.
//   4. Re-run after applying: it must report 0 changes. That is the proof.
//
// Section headers are deliberately NOT in this list. They roll up their
// children's totals, so coding one double-counts its whole phase in every
// variance number (see isEstimateSectionRow in src/lib/estimate-item-payload.ts).
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const APPLY = process.argv.includes("--apply");

/** name → cost code. Names are asserted against the DB before any write. */
const MAPPING = [
    { project: "Mesplay Kitchen",       name: "Foundation Concrete & Forming",        code: "17-CONCRETE" },
    { project: "Hoppe Bathroom Remodel", name: "Electrical panel swap",               code: "04-ELEC" },
    { project: "Hoppe Bathroom Remodel", name: "Cabinet Allowance",                   code: "11-CABINET" },
    { project: "Hoppe Bathroom Remodel", name: "Rework Hot Water Heater / Plumbing",  code: "03-PLUMB" },
    { project: "Hoppe Bathroom Remodel", name: "Cabinet Installation Allowance",      code: "11-CABINET" },
    { project: "Hoppe Bathroom Remodel", name: "Paint Allowance",                     code: "08-PAINT" },
    { project: "Hoppe Bathroom Remodel", name: "Drywall Allowance",                   code: "07-DRYWALL" },
    { project: "Hoppe Bathroom Remodel", name: "Flooring Installation Allowance",     code: "09-FLOOR" },
    { project: "Hoppe Bathroom Remodel", name: "Dust control and Floor protection package", code: "23-SITEWORK" },
    { project: "Hoppe Bathroom Remodel", name: "Millwork Allowance",                  code: "13-TRIM" },
    { project: "Hoppe Bathroom Remodel", name: "Flooring Allowance",                  code: "09-FLOOR" },
    { project: "Hoppe Bathroom Remodel", name: "Replace Light Fixture",               code: "19-FIXTURE" },
    { project: "Hoppe Bathroom Remodel", name: "Cabinet Handle Allowance",            code: "19-FIXTURE" },
    { project: "Hoppe Bathroom Remodel", name: "Portable toilet",                     code: "23-SITEWORK" },
    { project: "Hoppe Bathroom Remodel", name: "Custom Hardware Options",             code: "19-FIXTURE" },
];

const ELIGIBLE = ["Approved", "Invoiced", "Partially Paid", "Paid"];

function isSection(item, all) {
    if (item.type === "Section") return true;
    return !!item.id && all.some((o) => o.parentId && String(o.parentId) === String(item.id));
}

async function main() {
    console.log(APPLY ? "*** APPLY MODE — WILL WRITE TO PROD ***" : "DRY RUN (pass --apply to write)");

    const codes = await prisma.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true } });
    const codeByCode = new Map(codes.map((c) => [c.code, c]));
    for (const m of MAPPING) {
        if (!codeByCode.has(m.code)) throw new Error(`ABORT: cost code ${m.code} does not exist or is inactive.`);
    }

    // Load every eligible item on In Progress jobs once, so the section check
    // has the full sibling set it needs.
    const projects = await prisma.project.findMany({
        where: { status: "In Progress" },
        select: { id: true, name: true,
            estimates: { where: { status: { in: ELIGIBLE }, archivedAt: null },
                select: { id: true, items: { select: { id: true, name: true, type: true, parentId: true, total: true, costCodeId: true } } } } },
    });

    const found = new Map();
    for (const p of projects) {
        for (const est of p.estimates) {
            for (const item of est.items) {
                found.set(`${p.name}::${item.name}`, { ...item, project: p.name, siblings: est.items });
            }
        }
    }

    let toChange = [], skipped = [], errors = [];

    for (const m of MAPPING) {
        const key = `${m.project}::${m.name}`;
        const item = found.get(key);
        if (!item) { errors.push(`NOT FOUND: ${key}`); continue; }
        // Guard: never code a section header — it would double-count its phase.
        if (isSection(item, item.siblings)) { errors.push(`REFUSING (is a Section header): ${key}`); continue; }
        if (item.costCodeId) {
            const existing = codes.find((c) => c.id === item.costCodeId);
            skipped.push(`already coded ${existing ? existing.code : item.costCodeId}: ${key}`);
            continue;
        }
        toChange.push({ id: item.id, key, total: Number(item.total || 0), target: codeByCode.get(m.code) });
    }

    if (errors.length) {
        console.error("\n*** ABORTING — unresolved targets (nothing written): ***");
        for (const e of errors) console.error("  " + e);
        await prisma.$disconnect();
        process.exit(1);
    }

    console.log(`\nSKIPPED (already coded, left untouched): ${skipped.length}`);
    for (const s of skipped) console.log("  " + s);

    console.log(`\nCHANGES: ${toChange.length}`);
    let dollars = 0;
    for (const c of toChange) {
        dollars += c.total;
        console.log(`  $${String(c.total.toFixed(2)).padStart(10)}  NULL -> ${c.target.code.padEnd(12)} ${c.key}`);
    }
    console.log(`  total dollars newly coded: $${dollars.toLocaleString()}`);

    if (!APPLY) { console.log("\nDry run only. Re-run with --apply to write."); await prisma.$disconnect(); return; }

    let written = 0;
    for (const c of toChange) {
        // Re-assert the precondition inside the write: only update while the
        // item still has no cost code, so a concurrent hand-edit can't be lost.
        const result = await prisma.estimateItem.updateMany({
            where: { id: c.id, costCodeId: null },
            data: { costCodeId: c.target.id },
        });
        written += result.count;
        if (result.count !== 1) console.warn(`  WARN: ${c.key} matched ${result.count} rows (raced?)`);
    }
    console.log(`\nWROTE ${written} of ${toChange.length}. Re-run WITHOUT --apply; it must report 0 changes.`);
    await prisma.$disconnect();
}

main().catch(async (e) => { console.error("FAILED — treat all output as void:", e); await prisma.$disconnect(); process.exit(1); });
