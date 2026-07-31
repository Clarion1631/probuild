import { prisma } from "@/lib/prisma";

// Single source of truth for "how much has this project billed, collected,
// and cost" — used by the per-project Financial Overview API route
// (src/app/api/projects/[id]/financial-overview/route.ts) and the company-wide
// Financials rollup (src/app/reports/company-financials). Extracted so the two
// screens can never disagree: both call this function instead of running their
// own copies of the same invoice/estimate/retainer/expense/PO/time-entry
// queries. Only the per-project route's cash-flow-timeline chart (which needs
// its own month-bucketed queries) stays out of here.
export interface ProjectFinancials {
    // Incoming (invoices + retainers)
    currentIncoming: number; // paid to date
    scheduledIncoming: number;
    overdueIncoming: number;
    forecastedIncomingFromEstimates: number;
    totalForecastedIncoming: number; // current + scheduled + overdue + approved-estimate forecast
    clientOwes: number; // outstanding balance = scheduled + overdue
    invoicedTotal: number; // sum of invoice.totalAmount across counted invoices

    // Outgoing (expenses + POs)
    totalExpenses: number; // includes QBO-imported expenses (Expense rows are the same regardless of source)
    plannedExpenses: number;
    currentOutgoing: number; // === totalExpenses
    forecastedOutgoing: number; // totalExpenses + forecasted PO amounts

    // Margin (matches the Financial Overview "Cash Flow" card exactly — expenses only, no labor)
    currentMargin: number;
    forecastedMargin: number;

    // Labor (Time Logged card) — tracked separately; NOT folded into currentOutgoing/currentMargin above
    totalTimeHours: number;
    totalTimeCost: number;

    hasExpenses: boolean;
    hasTimeEntries: boolean;

    estimateStatus: {
        pendingApproval: { count: number; totalAmount: number };
        uninvoiced: { count: number; totalAmount: number };
    };
}

export async function computeProjectFinancials(
    projectId: string,
    opts: { includeUnissued?: boolean } = {}
): Promise<ProjectFinancials> {
    const includeUnissued = !!opts.includeUnissued;
    const now = new Date();

    const validInvoiceStatuses = ["Issued", "Paid", "Overdue", "Partially Paid", "Sent"];
    if (includeUnissued) validInvoiceStatuses.push("Draft");

    const validEstimateStatuses = ["Sent", "Viewed", "Approved", "Invoiced", "Partially Paid", "Paid"];
    if (includeUnissued) validEstimateStatuses.push("Draft");

    const validRetainerStatuses = ["Sent", "Paid", "Partially Paid"];
    if (includeUnissued) validRetainerStatuses.push("Draft");

    const [invoices, estimates, retainers, expenses, pos, timeEntries] = await Promise.all([
        prisma.invoice.findMany({
            where: { projectId, status: { in: validInvoiceStatuses } },
            include: { payments: true },
        }),
        prisma.estimate.findMany({
            where: { projectId, status: { in: validEstimateStatuses } },
            select: { id: true, status: true, totalAmount: true, balanceDue: true },
        }),
        prisma.retainer.findMany({ where: { projectId, status: { in: validRetainerStatuses } } }),
        prisma.expense.findMany({ where: { estimate: { projectId } } }),
        prisma.purchaseOrder.findMany({ where: { projectId } }),
        prisma.timeEntry.findMany({ where: { projectId } }),
    ]);

    let currentIncoming = 0;
    let scheduledIncoming = 0;
    let overdueIncoming = 0;
    let forecastedIncomingFromEstimates = 0;
    let invoicedTotal = 0;

    for (const inv of invoices) {
        invoicedTotal += Number(inv.totalAmount);
        for (const payment of inv.payments) {
            // Canceled milestones are not receivables — counting them inflated
            // outstanding/forecasted incoming (pre-existing bug, fixed here for
            // both the rollup and the per-project Financial Overview).
            if (payment.status === "Canceled") continue;
            if (payment.status === "Paid") {
                currentIncoming += Number(payment.amount);
            } else {
                if (payment.dueDate && payment.dueDate < now) {
                    overdueIncoming += Number(payment.amount);
                } else {
                    scheduledIncoming += Number(payment.amount);
                }
            }
        }
    }

    for (const ret of retainers) {
        currentIncoming += Number(ret.amountPaid);
        const balance = Number(ret.balanceDue);
        if (balance > 0) {
            if (ret.dueDate && ret.dueDate < now) {
                overdueIncoming += balance;
            } else {
                scheduledIncoming += balance;
            }
        }
    }

    // Only count Approved estimates — Sent/Viewed are not accepted, and
    // Invoiced/Partially Paid/Paid are already tracked via invoice payments above.
    for (const est of estimates) {
        if (est.status === "Approved") {
            forecastedIncomingFromEstimates += Number(est.totalAmount);
        }
    }

    const totalForecastedIncoming = currentIncoming + scheduledIncoming + overdueIncoming + forecastedIncomingFromEstimates;
    const clientOwes = scheduledIncoming + overdueIncoming;

    let totalExpenses = 0;
    for (const exp of expenses) {
        totalExpenses += Number(exp.amount);
    }

    let plannedExpenses = 0;
    let forecastedPoAmount = 0;
    for (const po of pos) {
        if (!includeUnissued && po.status === "Draft") continue;
        forecastedPoAmount += Number(po.totalAmount);
        plannedExpenses += Number(po.totalAmount);
    }

    const currentOutgoing = totalExpenses;
    const forecastedOutgoing = totalExpenses + forecastedPoAmount;

    const currentMargin = currentIncoming > 0 ? ((currentIncoming - currentOutgoing) / currentIncoming) * 100 : 0;
    const forecastedMargin = totalForecastedIncoming > 0 ? ((totalForecastedIncoming - forecastedOutgoing) / totalForecastedIncoming) * 100 : 0;

    let totalTimeHours = 0;
    let totalTimeCost = 0;
    for (const te of timeEntries) {
        if (te.durationHours) totalTimeHours += Number(te.durationHours);
        totalTimeCost += (Number(te.laborCost) || 0) + (Number(te.burdenCost) || 0);
    }

    const estimateStatus = {
        pendingApproval: { count: 0, totalAmount: 0 },
        uninvoiced: { count: 0, totalAmount: 0 },
    };
    for (const est of estimates) {
        if (est.status === "Sent" || est.status === "Viewed") {
            estimateStatus.pendingApproval.count++;
            estimateStatus.pendingApproval.totalAmount += Number(est.totalAmount);
        } else if (est.status === "Approved") {
            estimateStatus.uninvoiced.count++;
            estimateStatus.uninvoiced.totalAmount += Number(est.totalAmount);
        }
    }

    return {
        currentIncoming, scheduledIncoming, overdueIncoming, forecastedIncomingFromEstimates,
        totalForecastedIncoming, clientOwes, invoicedTotal,
        totalExpenses, plannedExpenses, currentOutgoing, forecastedOutgoing,
        currentMargin, forecastedMargin,
        totalTimeHours, totalTimeCost,
        hasExpenses: expenses.length > 0 || pos.length > 0,
        hasTimeEntries: timeEntries.length > 0,
        estimateStatus,
    };
}
