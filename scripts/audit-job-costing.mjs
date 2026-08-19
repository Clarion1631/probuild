// READ-ONLY prod audit for the crew clock-in + job-costing path.
// No writes. Run: node scripts/audit-job-costing.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const ELIGIBLE = ["Approved", "Invoiced", "Partially Paid", "Paid"];
const SAFETY = "32-SAFETY";

function line(t) { console.log("\n" + "=".repeat(72) + "\n" + t + "\n" + "=".repeat(72)); }

async function main() {
    line("1. CREW-VISIBLE PROJECTS (what the clock-in picker lists)");
    const projects = await prisma.project.findMany({
        where: { OR: [{ status: "In Progress" }, { isLogistics: true, status: { notIn: ["Closed Complete", "Closed Lost"] } }] },
        select: { id: true, name: true, status: true, isLogistics: true },
        orderBy: { name: "asc" },
    });
    for (const p of projects) console.log(`  ${p.status.padEnd(24)} ${p.isLogistics ? "[LOGISTICS] " : "            "}${p.name}`);
    console.log(`  TOTAL: ${projects.length}`);

    line("2. SAFETY PHASE SEEDED?");
    const safety = await prisma.costCode.findUnique({ where: { code: SAFETY } });
    console.log(safety ? `  ${safety.code} "${safety.name}" isActive=${safety.isActive}` : "  *** MISSING ***");

    line("3. PER-PROJECT PHASE LIST (exactly what the picker computes)");
    const report = [];
    for (const p of projects) {
        const items = await prisma.estimateItem.findMany({
            where: { estimate: { projectId: p.id, status: { in: ELIGIBLE }, archivedAt: null } },
            select: { id: true, name: true, costCodeId: true, total: true, type: true,
                      costCode: { select: { code: true, name: true, isActive: true } },
                      costType: { select: { name: true } } },
        });
        const coded = items.filter((i) => i.costCodeId);
        const uncoded = items.filter((i) => !i.costCodeId);
        const inactive = coded.filter((i) => i.costCode && !i.costCode.isActive);
        const phaseSet = new Map();
        for (const i of coded) if (i.costCode) {
            if (!phaseSet.has(i.costCode.code)) phaseSet.set(i.costCode.code, []);
            phaseSet.get(i.costCode.code).push(i);
        }
        const showsSafety = p.status === "In Progress" && !!safety && safety.isActive;
        const phaseCount = phaseSet.size + (showsSafety && !phaseSet.has(SAFETY) ? 1 : 0);
        const multi = [...phaseSet.entries()].filter(([, v]) => v.length > 1);
        report.push({ p, items, coded, uncoded, inactive, phaseSet, phaseCount, showsSafety, multi });
        console.log(`\n  ${p.name}  [${p.status}]${p.isLogistics ? " LOGISTICS" : ""}`);
        console.log(`    items=${items.length}  coded=${coded.length}  UNCODED=${uncoded.length}  inactiveCode=${inactive.length}`);
        console.log(`    phases shown to crew = ${phaseCount}${showsSafety ? " (incl. Safety)" : " (NO safety)"}`);
        if (phaseCount === 0 && !p.isLogistics) console.log(`    *** BLOCKER: crew CANNOT clock in on this job ***`);
        console.log(`    phases w/ >1 item = ${multi.length} ; max items in one phase = ${Math.max(0, ...[...phaseSet.values()].map((v) => v.length))}`);
        for (const i of uncoded) console.log(`      UNCODED ITEM: "${String(i.name).slice(0, 60)}" $${Number(i.total || 0).toFixed(2)} type=${i.costType?.name || i.type || "?"}`);
    }

    line("4. ITEMS-PER-PHASE DISTRIBUTION (drives the optional 2nd tap)");
    const dist = {};
    let totalPhases = 0;
    for (const r of report) for (const [, v] of r.phaseSet) { dist[v.length] = (dist[v.length] || 0) + 1; totalPhases++; }
    for (const k of Object.keys(dist).sort((a, b) => a - b)) {
        const pct = ((dist[k] / totalPhases) * 100).toFixed(1);
        console.log(`  ${k} item(s) in phase: ${String(dist[k]).padStart(3)} phases  (${pct}%)`);
    }
    const single = dist[1] || 0;
    console.log(`  => ${((single / totalPhases) * 100).toFixed(1)}% of phases need ZERO extra taps (exactly 1 item)`);

    line("5. LINKAGE STATE (can we compute variance yet?)");
    const [teTotal, teCode, teItem, exTotal, exCode, exItem] = await Promise.all([
        prisma.timeEntry.count(),
        prisma.timeEntry.count({ where: { costCodeId: { not: null } } }),
        prisma.timeEntry.count({ where: { estimateItemId: { not: null } } }),
        prisma.expense.count(),
        prisma.expense.count({ where: { costCodeId: { not: null } } }),
        prisma.expense.count({ where: { itemId: { not: null } } }),
    ]);
    console.log(`  timeEntry: ${teTotal} total | costCodeId ${teCode} | estimateItemId ${teItem}`);
    console.log(`  expense:   ${exTotal} total | costCodeId ${exCode} | itemId ${exItem}`);

    line("6. TIME ENTRIES WITH NO COST CODE AND NO ITEM (invisible to variance)");
    const orphan = await prisma.timeEntry.findMany({
        where: { costCodeId: null, estimateItemId: null },
        select: { id: true, startTime: true, project: { select: { name: true, isLogistics: true } }, user: { select: { name: true } } },
        orderBy: { startTime: "desc" },
    });
    const orphanReal = orphan.filter((o) => !o.project?.isLogistics);
    console.log(`  ${orphan.length} total uncoded punches; ${orphanReal.length} on NON-logistics jobs (these are the problem)`);
    for (const o of orphanReal.slice(0, 15)) console.log(`    ${o.startTime.toISOString().slice(0, 10)}  ${o.project?.name}  ${o.user?.name}`);

    line("7. OPEN PUNCHES RIGHT NOW");
    const open = await prisma.timeEntry.findMany({
        where: { endTime: null },
        select: { startTime: true, user: { select: { name: true } }, project: { select: { name: true } }, costCode: { select: { code: true } } },
    });
    for (const o of open) console.log(`  ${o.user?.name} on ${o.project?.name} phase=${o.costCode?.code || "NONE"} since ${o.startTime.toISOString()}`);
    console.log(`  TOTAL OPEN: ${open.length}`);

    await prisma.$disconnect();
}

main().catch(async (e) => { console.error("QUERY FAILED — treat ALL output above as void:", e); await prisma.$disconnect(); process.exit(1); });
