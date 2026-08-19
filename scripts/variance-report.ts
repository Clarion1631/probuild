// READ-ONLY. Runs the real variance engine (src/lib/job-variance.ts) against
// live prod data, so the numbers can be sanity-checked before any UI ships.
// Run: npx tsx scripts/variance-report.mts
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { computeProjectVariance, type VarianceEstimateItem } from "../src/lib/job-variance.js";
import { isEstimateSectionRow } from "../src/lib/estimate-item-payload.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const ELIGIBLE = ["Approved", "Invoiced", "Partially Paid", "Paid"];
const money = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

async function main() {
    const projects = await prisma.project.findMany({
        where: { status: "In Progress" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
    });

    for (const project of projects) {
        const estimates = await prisma.estimate.findMany({
            where: { projectId: project.id, status: { in: ELIGIBLE }, archivedAt: null },
            select: { id: true, items: { select: {
                id: true, name: true, type: true, parentId: true, total: true,
                costCodeId: true, costCode: { select: { code: true, name: true } },
                costType: { select: { name: true } },
            } } },
        });

        // Section headers roll up their children — including one doubles its phase.
        const items: VarianceEstimateItem[] = [];
        for (const est of estimates) {
            for (const it of est.items) {
                if (isEstimateSectionRow(it as any, est.items as any)) continue;
                items.push({
                    id: it.id, name: it.name ?? "(unnamed)",
                    costCodeId: it.costCodeId,
                    costCode: it.costCode ? { code: it.costCode.code, name: it.costCode.name } : null,
                    costTypeName: it.costType?.name ?? null,
                    type: it.type ?? null,
                    total: Number(it.total ?? 0),
                });
            }
        }

        const timeEntries = (await prisma.timeEntry.findMany({
            where: { projectId: project.id },
            select: { costCodeId: true, estimateItemId: true, laborCost: true, burdenCost: true },
        })).map((t) => ({
            costCodeId: t.costCodeId, estimateItemId: t.estimateItemId,
            laborCost: Number(t.laborCost ?? 0), burdenCost: Number(t.burdenCost ?? 0),
        }));

        // NOTE: Expense has NO projectId — it reaches a project via its estimate.
        const expenses = (await prisma.expense.findMany({
            where: { estimate: { projectId: project.id } },
            select: { costCodeId: true, itemId: true, amount: true },
        })).map((e) => ({ costCodeId: e.costCodeId, itemId: e.itemId, amount: Number(e.amount ?? 0) }));

        const v = computeProjectVariance({ items, timeEntries, expenses });

        console.log("\n" + "=".repeat(78));
        console.log(project.name.toUpperCase());
        console.log("=".repeat(78));
        console.log(`  budget ${money(v.totalBudget)}   actual ${money(v.totalActual)}   variance ${money(v.variance)}` +
                    `${v.percentUsed !== null ? `   (${(v.percentUsed * 100).toFixed(1)}% used)` : ""}`);
        console.log(`  labor: budget ${money(v.laborBudget)} / actual ${money(v.actualLabor)}` +
                    `   materials: budget ${money(v.materialBudget)} / actual ${money(v.actualMaterial)}`);
        console.log(`  TRUST: ${(v.coverage.attributedShare * 100).toFixed(1)}% of actual dollars are attributed to a phase` +
                    ` | unplaced ${money(v.coverage.unattributedTotal)} | phase-only (not item) ${money(v.coverage.phaseOnlyActuals)}`);
        if (v.uncodedBudget > 0) console.log(`  estimate cleanup: ${money(v.uncodedBudget)} of budget sits on uncoded items`);

        const interesting = v.phases.filter((p) => p.totalActual > 0 || p.variance < 0).slice(0, 8);
        if (interesting.length === 0) { console.log("  (no actuals recorded against any phase yet)"); continue; }
        console.log("\n  worst phases:");
        for (const p of interesting) {
            console.log(`    ${p.code.padEnd(16)} budget ${money(p.totalBudget).padStart(10)}  actual ${money(p.totalActual).padStart(10)}  var ${money(p.variance).padStart(10)}`);
            for (const it of p.items.filter((i) => i.actual > 0 || i.variance < 0).slice(0, 3)) {
                const flag = it.phaseHasUnassignedActuals ? "  [floor: phase has unassigned actuals]" : "";
                console.log(`        · ${String(it.name).slice(0, 46).padEnd(46)} budget ${money(it.budget).padStart(9)} actual ${money(it.actual).padStart(9)}${flag}`);
            }
        }
    }
    await prisma.$disconnect();
}
main().catch(async (e) => { console.error("FAILED — all output void:", e); await prisma.$disconnect(); process.exit(1); });
