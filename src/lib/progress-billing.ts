/**
 * Progress billing core.
 *
 * Product model: estimate/invoice milestones (PaymentSchedule/EstimatePaymentSchedule)
 * are SUGGESTIONS. The billable artifact is a "progress billing" (ProgressBilling):
 * the user picks milestones and/or approved change orders and/or a custom amount,
 * writes one client-facing description, confirms tax, and stages exactly ONE
 * QuickBooks invoice. Milestones remain the record of truth for what has been
 * satisfied, so a billing that covers only PART of a milestone AUTO-SPLITS that
 * milestone — every billing line ends up mapped 1:1 to a whole milestone.
 *
 * Session-free cores (no auth checks) — actions.ts wrappers come in the UI pass,
 * same convention as billing-core.ts.
 *
 * HARD CONSTRAINTS carried through this whole file (owner-stated, non-negotiable):
 *   - No customer data loss: every write here is additive (new rows) or shrinks
 *     an existing PaymentSchedule/EstimatePaymentSchedule's `amount` — a split
 *     NEVER deletes or merges a milestone row.
 *   - No customer notifications: nothing in this file calls sendNotification /
 *     notifyMilestonePaid / drainPaymentNotifications / any send path. Staging
 *     to QuickBooks does not send a QuickBooks-hosted email either (QBO invoices
 *     are created without relying on Intuit's own invoice-email flow).
 */
import { prisma } from "@/lib/prisma";
import { withTxRetry, lockMoneyParents } from "./tx-retry";
import { toNum } from "./prisma-helpers";
import type { ProgressBilling, ProgressBillingLine } from "@prisma/client";

// Cent-round helper shared by every money computation below.
const r2 = (n: number) => Math.round(n * 100) / 100;

export type ProgressBillingLineInput = {
    scheduleId?: string;
    changeOrderId?: string;
    description: string;
    amount: number;
};

export type CreateProgressBillingInput = {
    description: string;
    lines: ProgressBillingLineInput[];
    taxExempt?: boolean;
    amountMode: "preTax" | "targetTotal";
    targetTotal?: number;
};

export type ProgressBillingWithLines = ProgressBilling & { lines: ProgressBillingLine[] };

/**
 * Build one progress billing.
 *
 * TWO AMOUNTS, DELIBERATELY DIFFERENT. Every line carries:
 *   • the PERSISTED amount (ProgressBillingLine.amount) — always PRE-TAX, since
 *     it feeds the QuickBooks invoice's taxable line; and
 *   • the SPLIT amount — what gets carved out of the milestone, expressed in
 *     that milestone's own units (see the "Split units" block below).
 * On a legacy tax-inclusive job these differ by exactly the tax and that is
 * correct: a $25,000 check against a $39,998.25 tax-inclusive milestone leaves
 * $14,998.25 behind while the QuickBooks line reads $22,977.94 + $2,022.06 tax.
 * On a pre-tax job they are identical. In "preTax" mode they are always
 * identical regardless of vintage.
 */
export async function createProgressBillingCore(
    invoiceId: string,
    input: CreateProgressBillingInput,
): Promise<ProgressBillingWithLines> {
    const description = (input.description || "").trim();
    if (!description) throw new Error("A description is required");
    if (!input.lines?.length) throw new Error("At least one line is required");
    if (input.amountMode !== "preTax" && input.amountMode !== "targetTotal") {
        throw new Error(`Unknown amountMode: ${input.amountMode}`);
    }

    const rawAmounts = input.lines.map((l) => r2(Number(l.amount)));
    rawAmounts.forEach((amt, i) => {
        if (!Number.isFinite(amt) || amt <= 0) {
            throw new Error(`Line ${i + 1} ("${input.lines[i].description || "untitled"}"): amount must be greater than zero`);
        }
    });

    let targetTotal = 0;
    if (input.amountMode === "targetTotal") {
        targetTotal = r2(Number(input.targetTotal));
        if (!Number.isFinite(targetTotal) || targetTotal <= 0) {
            throw new Error('targetTotal must be greater than zero for amountMode "targetTotal"');
        }
    }

    const seenScheduleIds = new Set<string>();
    for (const line of input.lines) {
        if (line.scheduleId && line.changeOrderId) {
            throw new Error("A line cannot reference both a milestone and a change order");
        }
        if (line.scheduleId) {
            if (seenScheduleIds.has(line.scheduleId)) {
                throw new Error("The same milestone was referenced by more than one line");
            }
            seenScheduleIds.add(line.scheduleId);
        }
        if (!line.description || !line.description.trim()) {
            throw new Error("Every line needs a description");
        }
    }

    return withTxRetry(() => prisma.$transaction(async (tx) => {
        // Canonical lock order: Estimate → Invoice → schedules (tx-retry.ts).
        const invLink = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
        await lockMoneyParents(tx, { estimateId: invLink?.estimateId, invoiceId });

        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
        if (!invoice) throw new Error("Invoice not found");

        // Resolve + validate every line under the lock (no writes yet).
        const scheduleCache = new Map<string, NonNullable<Awaited<ReturnType<typeof prisma.paymentSchedule.findUnique>>>>();

        for (let i = 0; i < input.lines.length; i++) {
            const line = input.lines[i];
            const rawAmount = rawAmounts[i];

            if (line.scheduleId) {
                const schedule = await tx.paymentSchedule.findUnique({ where: { id: line.scheduleId } });
                if (!schedule || schedule.invoiceId !== invoiceId) {
                    throw new Error(`Milestone not found on this invoice: ${line.scheduleId}`);
                }
                if (schedule.status !== "Pending") {
                    throw new Error(`"${schedule.name}" is not Pending — only pending milestones can be billed`);
                }
                if (schedule.qbInvoiceId) {
                    throw new Error(`"${schedule.name}" already has a QuickBooks invoice staged — break the QuickBooks link first, then bill it here.`);
                }
                if (schedule.stripeSessionId || schedule.stripePaymentIntentId) {
                    throw new Error(`A payment is in progress on "${schedule.name}" — wait for it to finish or void it before billing.`);
                }
                // Over-billing is checked AFTER the tax math, against the amount
                // expressed in the milestone's own units (see splitAmounts below).
                scheduleCache.set(line.scheduleId, schedule);
            } else if (line.changeOrderId) {
                const co = await tx.changeOrder.findUnique({ where: { id: line.changeOrderId } });
                if (!co || co.projectId !== invoice.projectId) {
                    throw new Error(`Change order not found on this invoice's project: ${line.changeOrderId}`);
                }
                if (co.status !== "Approved") {
                    throw new Error(`Change order ${co.code} is "${co.status}" — only Approved change orders can be billed`);
                }
            }
        }

        // ── Tax math ────────────────────────────────────────────────────────
        const taxExempt = !!input.taxExempt;
        const effectiveRate = taxExempt ? 0 : toNum(invoice.taxRate);

        let subtotal: number;
        let taxAmount: number;
        let total: number;
        let finalAmounts: number[];

        if (input.amountMode === "preTax") {
            subtotal = r2(rawAmounts.reduce((s, a) => s + a, 0));
            taxAmount = taxExempt ? 0 : r2(subtotal * effectiveRate / 100);
            total = r2(subtotal + taxAmount);
            finalAmounts = rawAmounts.slice();
        } else {
            total = targetTotal;
            subtotal = taxExempt ? total : r2(total / (1 + effectiveRate / 100));
            taxAmount = taxExempt ? 0 : r2(total - subtotal);

            const rawSum = rawAmounts.reduce((s, a) => s + a, 0);
            finalAmounts = rawAmounts.map((a) => r2((a * subtotal) / rawSum));
            const usedSum = r2(finalAmounts.slice(0, -1).reduce((s, a) => s + a, 0));
            finalAmounts[finalAmounts.length - 1] = r2(subtotal - usedSum);
            if (finalAmounts[finalAmounts.length - 1] <= 0) {
                throw new Error("Rescaling to the target total left the last line at $0 or less — adjust the line amounts.");
            }
        }

        if (Math.abs(r2(subtotal + taxAmount) - total) > 0.005) {
            throw new Error("Internal error: subtotal + tax does not equal total");
        }
        const finalSum = r2(finalAmounts.reduce((s, a) => s + a, 0));
        if (Math.abs(finalSum - subtotal) > 0.005) {
            throw new Error("Internal error: line amounts do not sum to the subtotal");
        }

        // ── Split units ─────────────────────────────────────────────────────
        // A milestone must be carved up in ITS OWN units, which differ by vintage:
        //   • legacy estimates (taxInclusiveMilestones = true, every job priced
        //     before progressive billing): milestone amounts INCLUDE tax, so the
        //     gross amount the client is paying is what comes out of the milestone
        //     — a $25,000 check against Mesplay's $39,998.25 leaves $14,998.25.
        //   • new estimates (false): milestone amounts are PRE-TAX, so the pre-tax
        //     line amount is what comes out; the tax rides on top of the billing.
        // In "preTax" mode finalAmounts === rawAmounts, so both branches agree and
        // this reduces to a no-op. Getting this wrong silently mis-splits live
        // milestones by exactly the tax, which is why over-billing is validated
        // here against the same units rather than against the caller's raw input.
        const estimateForUnits = invLink?.estimateId
            ? await tx.estimate.findUnique({ where: { id: invLink.estimateId }, select: { taxInclusiveMilestones: true } })
            : null;
        // No estimate (ad-hoc invoice) → treat as legacy tax-inclusive, matching
        // how every existing invoice in the system was priced.
        const milestonesAreTaxInclusive = estimateForUnits?.taxInclusiveMilestones ?? true;
        const splitAmounts = milestonesAreTaxInclusive ? rawAmounts : finalAmounts;

        for (let i = 0; i < input.lines.length; i++) {
            const scheduleId = input.lines[i].scheduleId;
            if (!scheduleId) continue;
            const schedule = scheduleCache.get(scheduleId)!;
            if (splitAmounts[i] > toNum(schedule.amount) + 0.005) {
                throw new Error(
                    `"${schedule.name}": billed amount $${splitAmounts[i].toFixed(2)} exceeds the milestone's amount $${toNum(schedule.amount).toFixed(2)}`
                );
            }
        }

        // ── AUTO-SPLIT ──────────────────────────────────────────────────────
        // Carves the billed portion out of the milestone using splitAmounts (the
        // milestone's own units — see above). Never deletes a PaymentSchedule /
        // EstimatePaymentSchedule row: the original is reduced in place and a NEW
        // row absorbs the remainder, so the two always sum to what was there
        // before and the invoice's totalAmount/balanceDue are untouched.
        const resolvedScheduleIds = new Map<number, string>(); // line index -> PaymentSchedule.id billed (whole, post-split)
        for (let i = 0; i < input.lines.length; i++) {
            const line = input.lines[i];
            if (!line.scheduleId) continue;
            const schedule = scheduleCache.get(line.scheduleId)!;
            const splitAmount = splitAmounts[i];
            const scheduleAmount = toNum(schedule.amount);
            resolvedScheduleIds.set(i, schedule.id);

            if (splitAmount >= scheduleAmount - 0.005) continue; // full bill — no split needed

            const remainder = r2(scheduleAmount - splitAmount);

            await tx.paymentSchedule.update({
                where: { id: schedule.id },
                data: { amount: splitAmount },
            });

            let newSourceScheduleId: string | null = null;
            if (schedule.sourceScheduleId) {
                const originalEst = await tx.estimatePaymentSchedule.findUnique({ where: { id: schedule.sourceScheduleId } });
                if (originalEst) {
                    await tx.estimatePaymentSchedule.update({
                        where: { id: originalEst.id },
                        data: { amount: splitAmount },
                    });
                    const newEst = await tx.estimatePaymentSchedule.create({
                        data: {
                            estimateId: originalEst.estimateId,
                            name: `${originalEst.name} (remaining)`,
                            amount: remainder,
                            dueDate: originalEst.dueDate || null,
                            status: "Pending",
                            order: originalEst.order,
                            percentage: null,
                        },
                    });
                    newSourceScheduleId = newEst.id;
                }
            }

            await tx.paymentSchedule.create({
                data: {
                    invoiceId,
                    name: `${schedule.name} (remaining)`,
                    amount: remainder,
                    status: "Pending",
                    dueDate: schedule.dueDate || null,
                    sourceScheduleId: newSourceScheduleId,
                },
            });
        }

        // ── Persist the billing ────────────────────────────────────────────
        const existingCount = await tx.progressBilling.count({ where: { invoiceId } });
        const code = `${invoice.code}-P${existingCount + 1}`;

        const billing = await tx.progressBilling.create({
            data: {
                invoiceId,
                code,
                description,
                status: "Draft",
                subtotal,
                taxExempt,
                taxRate: effectiveRate,
                taxAmount,
                total,
            },
        });

        await tx.progressBillingLine.createMany({
            data: input.lines.map((line, i) => ({
                billingId: billing.id,
                scheduleId: resolvedScheduleIds.get(i) || null,
                changeOrderId: line.changeOrderId || null,
                description: line.description.trim(),
                amount: finalAmounts[i],
                order: i,
            })),
        });

        const withLines = await tx.progressBilling.findUnique({
            where: { id: billing.id },
            include: { lines: { orderBy: { order: "asc" } } },
        });
        return withLines!;
    }));
}

export type UpdateProgressBillingInput = {
    description?: string;
    taxExempt?: boolean;
};

/**
 * Draft-only edit: description and/or tax-exempt status. Line composition
 * (which milestones/change orders/custom amounts make up the billing) is
 * intentionally NOT re-editable here — re-running AUTO-SPLIT against a changed
 * line set is exactly the kind of ambiguous, high-risk money logic this pass
 * avoids (see PROGRESS_BILLING_REPORT.md). To change the lines, delete this
 * Draft (safe — any split it already applied stays applied, see
 * deleteProgressBillingCore below) and create a fresh one.
 */
export async function updateProgressBillingCore(
    billingId: string,
    input: UpdateProgressBillingInput,
): Promise<ProgressBillingWithLines> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        const link = await tx.progressBilling.findUnique({ where: { id: billingId }, select: { invoiceId: true } });
        if (!link) throw new Error("Progress billing not found");
        await lockMoneyParents(tx, { invoiceId: link.invoiceId });

        const billing = await tx.progressBilling.findUnique({ where: { id: billingId } });
        if (!billing) throw new Error("Progress billing not found");
        if (billing.status !== "Draft" || billing.qbInvoiceId) {
            throw new Error(`This billing is "${billing.status}"${billing.qbInvoiceId ? " and has a QuickBooks invoice staged" : ""} — only Draft billings without a staged QuickBooks invoice can be edited`);
        }

        const description = input.description !== undefined ? input.description.trim() : billing.description;
        if (!description) throw new Error("A description is required");
        const taxExempt = input.taxExempt !== undefined ? !!input.taxExempt : billing.taxExempt;

        const subtotal = toNum(billing.subtotal);
        const rate = taxExempt ? 0 : toNum(billing.taxRate);
        const taxAmount = taxExempt ? 0 : r2(subtotal * rate / 100);
        const total = r2(subtotal + taxAmount);

        await tx.progressBilling.update({
            where: { id: billingId },
            data: { description, taxExempt, taxAmount, total },
        });

        const withLines = await tx.progressBilling.findUnique({
            where: { id: billingId },
            include: { lines: { orderBy: { order: "asc" } } },
        });
        return withLines!;
    }));
}

/**
 * Delete a Draft billing. Removes the billing + its lines only (lines cascade
 * via the DB FK — see prisma/schema.prisma's ProgressBillingLine.billing
 * relation). Any PaymentSchedule/EstimatePaymentSchedule split this billing
 * already applied (see createProgressBillingCore's AUTO-SPLIT) is NOT undone
 * or merged back — the two milestone pieces it created stay as independent
 * Pending rows. This matches the hard constraint that a split, once applied,
 * only ever creates rows; it never deletes or merges them.
 */
export async function deleteProgressBillingCore(
    billingId: string,
): Promise<{ success: true; invoiceId: string; projectId: string }> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        const link = await tx.progressBilling.findUnique({
            where: { id: billingId },
            select: { invoiceId: true, invoice: { select: { projectId: true } } },
        });
        if (!link) throw new Error("Progress billing not found");
        await lockMoneyParents(tx, { invoiceId: link.invoiceId });

        const billing = await tx.progressBilling.findUnique({ where: { id: billingId } });
        if (!billing) throw new Error("Progress billing not found");
        if (billing.status !== "Draft" || billing.qbInvoiceId) {
            throw new Error(`This billing is "${billing.status}"${billing.qbInvoiceId ? " and has a QuickBooks invoice staged" : ""} — only Draft billings without a staged QuickBooks invoice can be deleted`);
        }

        await tx.progressBilling.delete({ where: { id: billingId } }); // cascades to ProgressBillingLine only

        return { success: true as const, invoiceId: link.invoiceId, projectId: link.invoice.projectId };
    }));
}

/**
 * Stage a Draft billing's ONE QuickBooks invoice. Never sends any email —
 * deliberately: this pass ships no customer notifications (owner's hard
 * constraint; see PROGRESS_BILLING_REPORT.md). A later UI pass wires an
 * explicit "send" action on top of this, same split as the milestone rail
 * (pushMilestoneToQuickBooks stages; sendMilestoneInvoicesCore sends).
 */
export async function stageProgressBillingToQuickBooksCore(
    billingId: string,
): Promise<{ success: true; qbInvoiceId: string; qbInvoiceLink: string | null }> {
    const billing = await prisma.progressBilling.findUnique({
        where: { id: billingId },
        include: {
            invoice: {
                include: {
                    client: { select: { id: true, name: true, email: true, qbCustomerId: true } },
                },
            },
        },
    });
    if (!billing) throw new Error("Progress billing not found");
    if (billing.status !== "Draft") {
        throw new Error(`This billing is "${billing.status}" — only Draft billings can be staged to QuickBooks`);
    }
    if (billing.qbInvoiceId) {
        throw new Error("This billing already has a QuickBooks invoice staged");
    }

    const invoice = billing.invoice;
    const { getFreshQBTokens, resolveCustomerAndItem } = await import("./quickbooks-payments");
    const { createQBMilestoneInvoice, getQBInvoicePaymentLink, deleteQBInvoice } = await import("./quickbooks");

    const tokens = await getFreshQBTokens();
    const { customerId, itemId } = await resolveCustomerAndItem(tokens, invoice.clientId);

    const subtotal = toNum(billing.subtotal);
    const taxAmount = toNum(billing.taxAmount);
    const total = toNum(billing.total);

    const { qbId } = await createQBMilestoneInvoice(tokens, {
        docNumber: billing.code,
        customerId,
        itemId,
        description: billing.description,
        amount: total,
        tax: taxAmount > 0 ? { preTaxAmount: subtotal, taxAmount } : null,
        billEmail: invoice.client?.email || null,
        privateNote: `ProBuild ${invoice.code} · ${billing.code}`,
    });

    const payLink = await getQBInvoicePaymentLink(tokens, qbId);

    // Conditional claim mirroring pushMilestoneToQuickBooks: guards pin id,
    // Draft status, no existing qbInvoiceId, and the exact content snapshot
    // (subtotal/total/description) this QBO invoice was created from — a
    // mid-stage edit or concurrent stage can't silently attach to a row it no
    // longer describes. On a miss, compensate by deleting the just-created QBO
    // invoice instead of leaving it orphaned and unattached.
    const linked = await prisma.progressBilling.updateMany({
        where: {
            id: billing.id,
            status: "Draft",
            qbInvoiceId: null,
            subtotal: billing.subtotal,
            total: billing.total,
            description: billing.description,
        },
        data: { status: "Staged", qbInvoiceId: qbId, qbInvoiceLink: payLink, qbSyncedAt: new Date() },
    });
    if (linked.count !== 1) {
        const compensated = await deleteQBInvoice(tokens, qbId).catch(() => false);
        if (!compensated) {
            throw new Error(`This billing changed while staging its QuickBooks invoice, and the abandoned QuickBooks invoice ${billing.code} (id ${qbId}) could not be deleted — remove it in QuickBooks, then retry.`);
        }
        throw new Error("This billing changed while staging its QuickBooks invoice — refresh and try again.");
    }

    return { success: true as const, qbInvoiceId: qbId, qbInvoiceLink: payLink };
}
