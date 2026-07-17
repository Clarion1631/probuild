// E2E check for the template-first flow: templateToPhases -> createEstimateFromPhases
// against a real lead, verify structure, then delete (cascade).
import { prisma } from "../src/lib/prisma";
import { templateToPhases, createEstimateFromPhases } from "../src/lib/gpt-estimate";

async function main() {
    const tpl = await templateToPhases("Kitchen Remodel");
    if (!tpl.ok) throw new Error(tpl.error);
    console.log(`template: ${tpl.name} — ${tpl.phases.length} phases, ${tpl.phases.reduce((s, p) => s + p.items.length, 0)} items`);

    const badName = await templateToPhases("Not A Real Template");
    if (badName.ok) throw new Error("expected miss on unknown template name");

    const legacy = await templateToPhases("Mobilization"); // flat template, no Section rows
    if (!legacy.ok) throw new Error(legacy.error);

    const lead = await prisma.lead.findFirst({ select: { id: true } });
    if (!lead) throw new Error("no lead to test against");

    const created = await createEstimateFromPhases({
        title: "TEMPLATE ROUNDTRIP — DELETE ME",
        leadId: lead.id,
        phases: tpl.phases,
        paymentMilestones: [{ name: "Deposit", percentage: 30 }, { name: "Rough-in Complete", percentage: 40 }, { name: "Completion", percentage: 30 }],
    });
    if (!created.ok) throw new Error(created.error);

    const est = await prisma.estimate.findUnique({
        where: { id: created.estimateId },
        include: { items: { include: { costCode: true } }, paymentSchedules: true },
    });
    if (!est) throw new Error("estimate missing after create");

    const sections = est.items.filter(i => i.type === "Section");
    const children = est.items.filter(i => i.parentId);
    const uncoded = children.filter(i => !i.costCodeId);
    const checks: [string, boolean][] = [
        ["phase count survives round-trip", sections.length === tpl.phases.length],
        ["all children parented", children.length === est.items.length - sections.length],
        ["every line item cost-coded", uncoded.length === 0],
        ["no warnings from template codes", created.warnings.length === 0],
        ["cabinet allowance labeled Allowance", est.items.find(i => i.name === "Cabinet Allowance")?.type === "Allowance"],
        ["cabinetry coded 11-CABINET", est.items.find(i => i.name === "Cabinet Allowance")?.costCode?.code === "11-CABINET"],
        ["milestones sum to total", Math.abs(est.paymentSchedules.reduce((s, m) => s + Number(m.amount), 0) - Number(est.totalAmount)) < 0.005],
    ];

    let failed = 0;
    for (const [label, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }

    await prisma.estimate.delete({ where: { id: created.estimateId } });
    console.log("cleanup: deleted", created.estimateId);
    if (failed) throw new Error(`${failed} checks failed`);
    console.log("ALL CHECKS PASSED");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
