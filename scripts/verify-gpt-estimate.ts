// One-off E2E check for createEstimateFromPhases: creates a draft estimate against
// a real lead, verifies items/groups/codes/milestones, then deletes it (cascade).
import { prisma } from "../src/lib/prisma";
import { createEstimateFromPhases } from "../src/lib/gpt-estimate";

async function main() {
    const lead = await prisma.lead.findFirst({ select: { id: true, name: true } });
    if (!lead) throw new Error("No lead found to test against");
    console.log(`Testing against lead: ${lead.name} (${lead.id})`);

    const result = await createEstimateFromPhases({
        title: "MCP VERIFY — DELETE ME",
        leadId: lead.id,
        phases: [
            {
                phaseName: "Demolition",
                phaseCode: "01-DEMO",
                items: [
                    { name: "Demo cabinets", costType: "Labor", quantity: 8, unit: "hours", unitCost: 85 },
                    { name: "Dumpster", costCode: "20-CLEAN", costType: "Equipment", quantity: 1, unit: "each", unitCost: 450 },
                ],
            },
            {
                phaseName: "Cabinetry",
                phaseCode: "11-CABINET",
                items: [
                    { name: "Base cabinets", costCode: "11-CABINET", costType: "Material", quantity: 12, unit: "lf", unitCost: 210 },
                    { name: "Bad code item", costCode: "99-NOPE", costType: "Material", quantity: 1, unitCost: 100 },
                    { name: "Fractional item", costType: "Material", quantity: 3, unitCost: 33.333 },
                ],
            },
        ],
        paymentMilestones: [
            { name: "Deposit", percentage: 30 },
            { name: "Completion", percentage: 70 },
        ],
    });

    if (!result.ok) throw new Error(`create failed: ${result.error}`);
    console.log("Created:", result.estimateId, result.code, "total:", result.totalAmount);
    console.log("Warnings:", result.warnings);

    const est = await prisma.estimate.findUnique({
        where: { id: result.estimateId },
        include: {
            items: { orderBy: { order: "asc" }, include: { costCode: true, costType: true } },
            paymentSchedules: { orderBy: { order: "asc" } },
        },
    });
    if (!est) throw new Error("estimate not found after create");

    const sections = est.items.filter(i => i.type === "Section");
    const milestoneSum = est.paymentSchedules.reduce((s, m) => s + Number(m.amount), 0);
    const checks: [string, boolean][] = [
        ["status Draft", est.status === "Draft"],
        ["privacy Private", est.privacy === "Private"],
        ["code is EST-<number>", /^EST-\d{5}$/.test(est.code)],
        ["7 items (2 sections + 5 lines)", est.items.length === 7],
        ["2 section rows", sections.length === 2],
        ["children linked to parents", est.items.filter(i => i.parentId).length === 5],
        ["demo item inherits phase code 01-DEMO", est.items.find(i => i.name === "Demo cabinets")?.costCode?.code === "01-DEMO"],
        ["dumpster overrides to 20-CLEAN", est.items.find(i => i.name === "Dumpster")?.costCode?.code === "20-CLEAN"],
        ["labor cost type mapped", est.items.find(i => i.name === "Demo cabinets")?.costType?.name === "Labor"],
        ["bad explicit code stays uncoded", est.items.find(i => i.name === "Bad code item")?.costCodeId === null],
        ["bad code warned", result.warnings.some(w => w.includes("99-NOPE"))],
        ["fractional line rounded to cents", Number(est.items.find(i => i.name === "Fractional item")?.total) === 99.99],
        ["section totals = sum of children", sections.every(s => Math.abs(Number(s.total) - est.items.filter(i => i.parentId === s.id).reduce((sum, c) => sum + Number(c.total), 0)) < 0.005)],
        ["2 milestones", est.paymentSchedules.length === 2],
        ["milestones sum exactly to total", Math.abs(milestoneSum - Number(est.totalAmount)) < 0.005],
        ["totalAmount matches", Math.abs(Number(est.totalAmount) - result.totalAmount) < 0.01],
    ];

    let failed = 0;
    for (const [label, ok] of checks) {
        console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
        if (!ok) failed++;
    }

    await prisma.estimate.delete({ where: { id: result.estimateId } });
    const gone = await prisma.estimateItem.count({ where: { estimateId: result.estimateId } });
    console.log(`Cleanup: estimate deleted, remaining items: ${gone}`);

    if (failed > 0) throw new Error(`${failed} checks failed`);
    console.log("ALL CHECKS PASSED");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
