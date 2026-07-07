// E2E checks for the MCP billing tools' SAFE surfaces: the billing read, the
// change-order draft round-trip (create -> verify -> delete), and error paths of
// the send cores. Deliberately never triggers a customer email or QB send.
import { prisma } from "../src/lib/prisma";
import { getProjectBilling, createChangeOrderDraft, sendMilestoneInvoicesCore, resendInvoiceCore } from "../src/lib/billing-core";

async function main() {
    const checks: [string, boolean][] = [];

    // 1. Billing read on a project that has an invoice
    const invoice = await prisma.invoice.findFirst({ select: { projectId: true } });
    if (!invoice) throw new Error("no invoice in DB to test against");
    const billing = await getProjectBilling(invoice.projectId);
    checks.push(["billing read returns project", !!billing?.project?.id]);
    checks.push(["billing includes invoices", (billing?.invoices.length ?? 0) > 0]);
    checks.push(["milestones have stale-link flag", billing!.invoices.every(i => i.milestones.every(m => typeof m.paymentLinkStale === "boolean"))]);
    checks.push(["billing includes estimates list", Array.isArray(billing?.estimates)]);

    const missing = await getProjectBilling("not-a-real-project-id");
    checks.push(["unknown project returns null", missing === null]);

    // 2. Change-order draft round-trip
    const est = await prisma.estimate.findFirst({ where: { projectId: { not: null } }, select: { id: true, projectId: true } });
    if (!est?.projectId) throw new Error("no project-linked estimate to test against");
    const co = await createChangeOrderDraft({
        projectId: est.projectId,
        estimateId: est.id,
        title: "CO VERIFY — DELETE ME",
        items: [
            { name: "Add recessed lights", costCode: "04-ELEC", costType: "Subcontractor", quantity: 6, unitCost: 105 },
            { name: "Fixture allowance", costCode: "19-FIXTURE", costType: "Allowance", quantity: 1, unitCost: 333.333 },
        ],
    });
    if (!co.ok) throw new Error(`CO create failed: ${co.error}`);
    const coRow = await prisma.changeOrder.findUnique({ where: { id: co.changeOrderId }, include: { items: { include: { costCode: true } } } });
    checks.push(["CO created as Draft", coRow?.status === "Draft"]);
    checks.push(["CO code numbered", /^CO-\d{5}$/.test(coRow?.code ?? "")]);
    checks.push(["CO items cost-coded", coRow?.items.find(i => i.name === "Add recessed lights")?.costCode?.code === "04-ELEC"]);
    checks.push(["CO cents rounding", Number(coRow?.items.find(i => i.name === "Fixture allowance")?.total) === 333.33]);
    checks.push(["CO total = items sum", Math.abs(Number(coRow?.totalAmount) - (6 * 105 + 333.33)) < 0.005]);
    checks.push(["CO not sent", coRow?.sentAt === null]);
    await prisma.changeOrder.delete({ where: { id: co.changeOrderId } });
    console.log("CO cleanup done");

    // 2b. CO with estimate from a different project must fail
    const otherEst = await prisma.estimate.findFirst({ where: { projectId: { not: est.projectId }, NOT: { projectId: null } }, select: { id: true } });
    if (otherEst) {
        const bad = await createChangeOrderDraft({ projectId: est.projectId, estimateId: otherEst.id, title: "x", items: [{ name: "x", quantity: 1, unitCost: 1 }] });
        checks.push(["CO rejects cross-project estimate", !bad.ok]);
    }

    // 3. Send cores: error paths only (never send for real)
    const badSend = await sendMilestoneInvoicesCore("not-a-real-invoice", ["x"], undefined, undefined, "test");
    checks.push(["milestone send: bad invoice errors cleanly", badSend.success === false && badSend.error === "Invoice not found"]);
    const badResend = await resendInvoiceCore("not-a-real-invoice");
    checks.push(["resend: bad invoice errors cleanly", badResend.success === false]);

    let failed = 0;
    for (const [label, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
    if (failed) throw new Error(`${failed} checks failed`);
    console.log("ALL CHECKS PASSED");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
