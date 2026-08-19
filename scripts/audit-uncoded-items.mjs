// READ-ONLY. Separates TRUE uncoded gaps from section headers (which must NOT
// be cost-coded — they roll up their children and would double-count).
// Run: node scripts/audit-uncoded-items.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const ELIGIBLE = ["Approved", "Invoiced", "Partially Paid", "Paid"];

function isSection(item, all) {
    if (item.type === "Section") return true;
    return !!item.id && all.some((o) => o.parentId && String(o.parentId) === String(item.id));
}

async function main() {
    const projects = await prisma.project.findMany({
        where: { status: "In Progress" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
    });

    let trueGaps = [], sectionRows = 0, zeroDollar = 0, blankName = 0, totalItems = 0;

    for (const p of projects) {
        const estimates = await prisma.estimate.findMany({
            where: { projectId: p.id, status: { in: ELIGIBLE }, archivedAt: null },
            select: { id: true, title: true, status: true,
                items: { select: { id: true, name: true, type: true, parentId: true, total: true,
                                   costCodeId: true, costTypeId: true,
                                   costType: { select: { name: true } } } } },
        });
        for (const est of estimates) {
            totalItems += est.items.length;
            for (const item of est.items) {
                if (item.costCodeId) continue;
                if (isSection(item, est.items)) { sectionRows++; continue; }
                if (!item.name || !String(item.name).trim()) { blankName++; continue; }
                if (Number(item.total || 0) === 0) { zeroDollar++; }
                trueGaps.push({
                    project: p.name, estimateId: est.id, estimateTitle: est.title,
                    itemId: item.id, name: item.name,
                    total: Number(item.total || 0),
                    type: item.costType?.name || item.type || "?",
                });
            }
        }
    }

    console.log("=".repeat(78));
    console.log("TRUE UNCODED GAPS (section headers and blanks excluded)");
    console.log("=".repeat(78));
    console.log(`  eligible items scanned : ${totalItems}`);
    console.log(`  section headers skipped: ${sectionRows}  <- correctly uncoded, do NOT backfill`);
    console.log(`  blank-name rows skipped: ${blankName}   <- junk rows, delete candidates`);
    console.log(`  TRUE GAPS              : ${trueGaps.length}  (of which $0.00: ${zeroDollar})`);
    console.log(`  dollars in true gaps   : $${trueGaps.reduce((a, g) => a + g.total, 0).toLocaleString()}`);

    const byProject = {};
    for (const g of trueGaps) (byProject[g.project] ||= []).push(g);
    for (const [proj, gaps] of Object.entries(byProject)) {
        console.log(`\n  ${proj}  (${gaps.length} gaps, $${gaps.reduce((a, g) => a + g.total, 0).toLocaleString()})`);
        for (const g of gaps.sort((a, b) => b.total - a.total)) {
            console.log(`    $${String(g.total.toFixed(2)).padStart(10)}  [${g.type.padEnd(14)}] ${g.name}`);
        }
    }

    console.log("\n" + "=".repeat(78));
    console.log("AVAILABLE COST CODES (the vocabulary any backfill must use)");
    console.log("=".repeat(78));
    const codes = await prisma.costCode.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { code: true, name: true } });
    for (const c of codes) console.log(`  ${c.code.padEnd(16)} ${c.name}`);

    await prisma.$disconnect();
}
main().catch(async (e) => { console.error("QUERY FAILED — all output void:", e); await prisma.$disconnect(); process.exit(1); });
