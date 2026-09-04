import { prisma } from "@/lib/prisma";
import { percentCompleteNeedsReview } from "@/lib/percent-complete";
import { expenseForProjectWhere } from "@/lib/expense-attribution";

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

    // ── Earned margin (Phase 4) ─────────────────────────────────────────────
    // ADDITIVE ONLY. Everything above keeps its exact prior meaning and value —
    // `currentMargin` is still cash margin with no % complete and no labor in it.
    // These fields answer the different question "are we profitable so far on
    // the work we have actually done", and they are allowed to disagree with it.
    //
    // All plain `number | null`, never a Prisma Decimal: these cross a server →
    // client boundary and a Decimal does not survive serialization.

    /** Effective stored percent complete (auto or manual). Null until the nightly cron can compute one. */
    percentComplete: number | null;
    percentCompleteSource: "AUTO" | "MANUAL" | null;
    /** Derived: a manual override whose auto baseline has since moved > 5 points. */
    percentCompleteNeedsReview: boolean;

    /**
     * What the client has committed to: accepted estimates plus approved change
     * orders.
     *
     * CAVEAT, accepted deliberately: `Estimate.totalAmount` is tax-INCLUSIVE
     * once a rate has been set, while `ChangeOrder.totalAmount` is pre-tax
     * (CLAUDE.md money invariants). On a job with approved COs this therefore
     * understates contract value by the CO tax. Fixing it properly means
     * recomputing CO tax per the co-totalamount-pretax rule; until then this is
     * a management figure, not an invoiceable one.
     */
    contractValue: number;
    /** contractValue × percentComplete. Null when either input is missing. */
    earnedRevenue: number | null;
    /** earnedRevenue − (expenses + labor). UNLIKE `currentMargin`, this DOES include labor. */
    earnedMargin: number | null;
    /** 0..1 — share of expense DOLLARS carrying a receipt. Null when the job has no expenses. */
    receiptCompleteness: number | null;
    /**
     * The two sides of `receiptCompleteness`, in absolute dollars.
     *
     * Exposed so a company-wide roll-up can divide summed dollars instead of
     * averaging per-job ratios — a $50 job with a receipt and a $50,000 job
     * without one is not "50% complete". Note this is ABS expense dollars, so
     * it deliberately differs from the signed `totalExpenses` above.
     */
    expenseDollarsAbs: number;
    receiptedExpenseDollarsAbs: number;
    /** 0..1 — share of actual DOLLARS (expenses + labor) carrying a cost code. Null when there are none. */
    phaseCoverage: number | null;
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

    const [invoices, estimates, retainers, expenses, pos, timeEntries, project, approvedChangeOrders] = await Promise.all([
        prisma.invoice.findMany({
            where: { projectId, status: { in: validInvoiceStatuses } },
            include: { payments: true },
        }),
        prisma.estimate.findMany({
            where: { projectId, status: { in: validEstimateStatuses } },
            // `archivedAt` is SELECTED but not filtered on: adding it to the
            // `where` would change every existing field's value on a job with an
            // archived estimate, and this phase is additive only. It is applied
            // in the contractValue loop below and nowhere else.
            select: { id: true, status: true, totalAmount: true, balanceDue: true, archivedAt: true },
        }),
        prisma.retainer.findMany({ where: { projectId, status: { in: validRetainerStatuses } } }),
        prisma.expense.findMany({ where: expenseForProjectWhere(projectId) }),
        prisma.purchaseOrder.findMany({ where: { projectId } }),
        prisma.timeEntry.findMany({ where: { projectId } }),
        // Percent complete is READ here, never computed. The nightly recalc cron
        // (/api/cron/percent-complete-recalc) is the only writer — page renders
        // must not run the per-project variance load that the formula needs.
        prisma.project.findUnique({
            where: { id: projectId },
            select: {
                percentComplete: true,
                percentCompleteSource: true,
                percentCompleteAuto: true,
                percentCompleteAutoAtOverride: true,
            },
        }),
        // Only "Approved" COs are contract value. Draft/Sent are proposals —
        // same rule the variance loader applies to CO budget.
        prisma.changeOrder.findMany({
            where: { projectId, status: "Approved" },
            select: { totalAmount: true },
        }),
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

    // ── Earned margin (Phase 4, additive) ───────────────────────────────────
    // Nothing below reads into anything above; every existing field is already
    // final at this point.

    // Number() rather than the raw Prisma Decimal — these are serialized to a
    // client component and a Decimal does not survive that trip.
    const percentComplete = project?.percentComplete == null ? null : Number(project.percentComplete);
    const percentCompleteAuto = project?.percentCompleteAuto == null ? null : Number(project.percentCompleteAuto);
    const percentCompleteAutoAtOverride =
        project?.percentCompleteAutoAtOverride == null ? null : Number(project.percentCompleteAutoAtOverride);
    const percentCompleteSource = (project?.percentCompleteSource ?? null) as "AUTO" | "MANUAL" | null;

    // Committed contract value. Accepted estimate statuses only — "Sent"/"Viewed"
    // are proposals, and `validEstimateStatuses` above is a superset of what
    // counts here, so the filter is explicit rather than reusing that list.
    //
    // ARCHIVED estimates are excluded, matching `PHASE_ELIGIBLE_ESTIMATE_WHERE`
    // in project-phases.ts. A superseded estimate keeps its accepted status
    // after being archived, so counting it would double the contract on any job
    // that was re-estimated.
    const acceptedEstimateStatuses = ["Approved", "Invoiced", "Partially Paid", "Paid"];
    let contractValue = 0;
    for (const est of estimates) {
        if (est.archivedAt) continue;
        if (acceptedEstimateStatuses.includes(est.status)) contractValue += Number(est.totalAmount);
    }
    for (const co of approvedChangeOrders) {
        contractValue += Number(co.totalAmount);
    }

    // A contract value of exactly $0 makes earned revenue meaningless rather
    // than zero — there is no contract to earn against yet.
    const earnedRevenue =
        percentComplete === null || contractValue === 0
            ? null
            : (contractValue * percentComplete) / 100;
    const earnedMargin = earnedRevenue === null ? null : earnedRevenue - (totalExpenses + totalTimeCost);

    // Coverage figures are measured on ABSOLUTE dollars: Expense.amount is
    // signed (refunds and credit memos are normal), so netting could drive a
    // denominator toward zero and report a confident "100%" on data that is
    // barely covered at all. Same reasoning as VarianceCoverage.unattributedGross.
    let expenseAbsTotal = 0;
    let expenseAbsWithReceipt = 0;
    let expenseAbsCoded = 0;
    for (const exp of expenses) {
        const abs = Math.abs(Number(exp.amount) || 0);
        expenseAbsTotal += abs;
        if (exp.receiptUrl && exp.receiptUrl.trim() !== "") expenseAbsWithReceipt += abs;
        if (exp.costCodeId) expenseAbsCoded += abs;
    }
    let laborAbsTotal = 0;
    let laborAbsCoded = 0;
    for (const te of timeEntries) {
        const abs = Math.abs((Number(te.laborCost) || 0) + (Number(te.burdenCost) || 0));
        laborAbsTotal += abs;
        if (te.costCodeId) laborAbsCoded += abs;
    }

    // BankLine carries no job FK (only a free-text projectName), so "did every
    // bank charge on this job get a receipt" is not answerable here. This is the
    // narrower, honest question: of the expense dollars we DO have on the job,
    // how many carry a receipt.
    const receiptCompleteness = expenseAbsTotal > 0 ? expenseAbsWithReceipt / expenseAbsTotal : null;

    // Deliberately simpler than the variance report's `attributedShare`: no
    // item-link reconciliation, just "does this row carry a cost code". The two
    // can therefore differ by a hair on a job with item-linked postings.
    const actualAbsTotal = expenseAbsTotal + laborAbsTotal;
    const phaseCoverage = actualAbsTotal > 0 ? (expenseAbsCoded + laborAbsCoded) / actualAbsTotal : null;

    return {
        currentIncoming, scheduledIncoming, overdueIncoming, forecastedIncomingFromEstimates,
        totalForecastedIncoming, clientOwes, invoicedTotal,
        totalExpenses, plannedExpenses, currentOutgoing, forecastedOutgoing,
        currentMargin, forecastedMargin,
        totalTimeHours, totalTimeCost,
        hasExpenses: expenses.length > 0 || pos.length > 0,
        hasTimeEntries: timeEntries.length > 0,
        estimateStatus,
        percentComplete,
        percentCompleteSource,
        percentCompleteNeedsReview: percentCompleteNeedsReview({
            source: percentCompleteSource,
            auto: percentCompleteAuto,
            autoAtOverride: percentCompleteAutoAtOverride,
        }),
        contractValue,
        earnedRevenue,
        earnedMargin,
        receiptCompleteness,
        expenseDollarsAbs: expenseAbsTotal,
        receiptedExpenseDollarsAbs: expenseAbsWithReceipt,
        phaseCoverage,
    };
}
