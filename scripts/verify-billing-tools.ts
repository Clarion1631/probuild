// E2E checks for the MCP billing tools' SAFE surfaces: the billing read, the
// change-order draft round-trip (create -> verify -> delete), and error paths of
// the send cores. Deliberately never triggers a customer email or QB send.
import { prisma } from "../src/lib/prisma";
import { getProjectBilling, createChangeOrderDraft, sendMilestoneInvoicesCore, resendInvoiceCore, billChangeOrderCore, sendChangeOrderToClientCore, handleChangeOrderApproved, listReceivables, createInvoiceFromEstimateGuarded } from "../src/lib/billing-core";
import { createLead } from "../src/lib/actions";

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

    // 3. Bill-change-order round-trip on a project that HAS an invoice
    const invProject = await prisma.invoice.findFirst({ select: { id: true, projectId: true, estimateId: true, status: true, totalAmount: true, balanceDue: true } });
    if (!invProject) throw new Error("no invoice for bill-CO test");
    const estForCo = invProject.estimateId
        ? { id: invProject.estimateId }
        : await prisma.estimate.findFirst({ where: { projectId: invProject.projectId }, select: { id: true } });
    if (!estForCo) throw new Error("no estimate on invoice project for bill-CO test");
    const coBill = await createChangeOrderDraft({
        projectId: invProject.projectId,
        estimateId: estForCo.id,
        title: "BILL CO VERIFY — DELETE ME",
        items: [{ name: "Extra outlet", costCode: "04-ELEC", costType: "Subcontractor", quantity: 2, unitCost: 105 }],
    });
    if (!coBill.ok) throw new Error(`bill-CO create failed: ${coBill.error}`);

    // Cleanup in finally so a mid-test failure can't leave a CO/milestone/bumped
    // totals behind. Statuses of ALL the project's invoices are snapshotted so
    // whichever invoice billing targets gets its status restored (billing a Paid
    // invoice flips it to Partially Paid).
    const statusSnapshot = new Map(
        (await prisma.invoice.findMany({ where: { projectId: invProject.projectId }, select: { id: true, status: true } }))
            .map(i => [i.id, i.status]),
    );
    let billedMilestoneId: string | null = null;
    let billedInvoiceId: string | null = null;
    let billedAmount = 0;
    try {
        const notApproved = await billChangeOrderCore(coBill.changeOrderId);
        checks.push(["billing a Draft CO refuses", !notApproved.ok]);

        await prisma.changeOrder.update({ where: { id: coBill.changeOrderId }, data: { status: "Approved", approvedAt: new Date(), approvedBy: "verify-script" } });
        const billed = await billChangeOrderCore(coBill.changeOrderId);
        if (!billed.ok) throw new Error(`bill failed: ${billed.error}`);
        billedMilestoneId = billed.milestoneId;
        billedInvoiceId = billed.invoiceId;
        billedAmount = billed.amount;
        checks.push(["billed CO creates Pending milestone", billed.alreadyBilled === false && billed.milestoneStatus === "Pending"]);
        // Customer signs subtotal + 8.8% tax: 210 -> 210 + 18.48 = 228.48
        checks.push(["milestone amount = signed revised amount", Math.abs(billed.amount - 228.48) < 0.005]);
        checks.push(["bill returns tax breakdown", !billed.alreadyBilled && Math.abs((billed as any).subtotal - 210) < 0.005 && Math.abs((billed as any).taxAmount - 18.48) < 0.005]);

        const again = await billChangeOrderCore(coBill.changeOrderId);
        checks.push(["second bill is idempotent", again.ok && again.alreadyBilled === true && again.milestoneId === billed.milestoneId]);
    } finally {
        // Belt & braces: if the bill result was lost mid-test, find the milestone
        // by its CO-code prefix so cleanup still removes it.
        if (!billedMilestoneId) {
            const coRow = await prisma.changeOrder.findUnique({ where: { id: coBill.changeOrderId }, select: { code: true } });
            if (coRow) {
                const stray = await prisma.paymentSchedule.findFirst({
                    where: { name: { startsWith: `${coRow.code} — ` }, invoice: { projectId: invProject.projectId } },
                    select: { id: true, amount: true, invoiceId: true },
                });
                if (stray) { billedMilestoneId = stray.id; billedInvoiceId = stray.invoiceId; billedAmount = Number(stray.amount); }
            }
        }
        const originalStatus = billedInvoiceId ? statusSnapshot.get(billedInvoiceId) : undefined;
        await prisma.$transaction([
            ...(billedMilestoneId ? [prisma.paymentSchedule.delete({ where: { id: billedMilestoneId } })] : []),
            ...(billedInvoiceId ? [prisma.invoice.update({
                where: { id: billedInvoiceId },
                data: {
                    totalAmount: { decrement: billedAmount },
                    balanceDue: { decrement: billedAmount },
                    ...(originalStatus ? { status: originalStatus } : {}),
                },
            })] : []),
            prisma.changeOrder.delete({ where: { id: coBill.changeOrderId } }),
        ]);
        console.log("bill-CO cleanup done (finally)");
    }

    // 3b. Change-order send: error path only (never emails)
    const badCoSend = await sendChangeOrderToClientCore("not-a-real-co");
    checks.push(["CO send: bad id errors cleanly", badCoSend.success === false]);

    // 3c. Approval automation: failure paths only, notifications suppressed
    const badApprove = await handleChangeOrderApproved("not-a-real-co", { notify: false });
    checks.push(["approval hook: bad id doesn't throw", badApprove.billed === false && badApprove.sent === false && badApprove.issues.length > 0]);

    // 4. Send cores: error paths only (never send for real)
    const badSend = await sendMilestoneInvoicesCore("not-a-real-invoice", ["x"], undefined, undefined, "test");
    checks.push(["milestone send: bad invoice errors cleanly", badSend.success === false && badSend.error === "Invoice not found"]);
    const badResend = await resendInvoiceCore("not-a-real-invoice");
    checks.push(["resend: bad invoice errors cleanly", badResend.success === false]);

    // 5. Accounts receivable (read-only)
    const ar = await listReceivables();
    checks.push(["AR returns summary", typeof ar.totalOutstanding === "number" && Array.isArray(ar.invoices)]);
    checks.push(["AR totals = sum of balances", Math.abs(ar.totalOutstanding - ar.invoices.reduce((s, r) => s + r.balanceDue, 0)) < 0.01]);
    checks.push(["AR overdue ⊆ total", ar.overdueOutstanding <= ar.totalOutstanding + 0.01]);
    checks.push(["AR excludes drafts/zero-balance", ar.invoices.every(r => r.status !== "Draft" && r.balanceDue > 0)]);

    // 6. Invoice-from-estimate guard: an estimate that ALREADY has an invoice must
    // return it, not create a duplicate.
    const invoiced = await prisma.invoice.findFirst({ where: { estimateId: { not: null } }, select: { id: true, estimateId: true } });
    if (invoiced?.estimateId) {
        const before = await prisma.invoice.count({ where: { estimateId: invoiced.estimateId } });
        const guard = await createInvoiceFromEstimateGuarded(invoiced.estimateId);
        const after = await prisma.invoice.count({ where: { estimateId: invoiced.estimateId } });
        checks.push(["invoice guard returns existing", guard.ok && guard.alreadyExisted === true && guard.invoiceId === invoiced.id]);
        checks.push(["invoice guard creates nothing", before === after]);
    }
    const badInv = await createInvoiceFromEstimateGuarded("not-a-real-estimate");
    checks.push(["invoice guard: bad id errors cleanly", !badInv.ok]);

    // 7. Lead round-trip (create → verify dedup → delete; client cleanup if created).
    // createLead ends with revalidatePath, which throws outside a request context
    // (fine in the MCP route) — swallow it here and verify via lookup.
    const clientBefore = await prisma.client.findFirst({ where: { name: "LEAD VERIFY DELETE ME" }, select: { id: true } });
    const tolerantCreateLead = async (data: Parameters<typeof createLead>[0]) => {
        try { return await createLead(data); } catch (e: any) {
            if (!String(e?.message).includes("static generation store")) throw e;
            const found = await prisma.lead.findFirst({ where: { name: data.name, client: { name: data.clientName } }, orderBy: { createdAt: "desc" }, select: { id: true } });
            if (!found) throw e;
            return { id: found.id };
        }
    };
    const lead1 = await tolerantCreateLead({ name: "Verify lead — delete me", clientName: "LEAD VERIFY DELETE ME", clientEmail: "lead-verify@example.invalid", projectType: "Kitchen Remodeling" });
    const lead2 = await tolerantCreateLead({ name: "Verify lead — delete me", clientName: "LEAD VERIFY DELETE ME" });
    checks.push(["lead created", !!lead1.id]);
    checks.push(["24h dedup returns same lead", lead2.id === lead1.id]);
    const leadRow = await prisma.lead.findUnique({ where: { id: lead1.id }, select: { clientId: true, projectType: true } });
    checks.push(["lead carries projectType", leadRow?.projectType === "Kitchen Remodeling"]);
    await prisma.lead.delete({ where: { id: lead1.id } });
    if (!clientBefore && leadRow?.clientId) await prisma.client.delete({ where: { id: leadRow.clientId } });
    console.log("lead cleanup done");

    let failed = 0;
    for (const [label, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
    if (failed) throw new Error(`${failed} checks failed`);
    console.log("ALL CHECKS PASSED");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
