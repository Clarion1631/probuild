import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: projectId } = await params;
    const { searchParams } = new URL(req.url);
    const includeUnissued = searchParams.get("includeUnissued") === "true";

    // Verify caller has access to this project (admins/managers bypass; others must have ProjectAccess)
    const callerUser = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, role: true, projectAccess: { where: { projectId }, select: { projectId: true } } }
    });
    const isAdmin = callerUser && ["ADMIN", "MANAGER"].includes(callerUser.role);
    if (!callerUser || (!isAdmin && callerUser.projectAccess.length === 0)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const now = new Date();

    // ------------------------------------
    // 1. INCOMING PAYMENTS (Invoices + Retainers)
    // ------------------------------------
    let validInvoiceStatuses = ["Issued", "Paid", "Overdue", "Partially Paid", "Sent"];
    if (includeUnissued) validInvoiceStatuses.push("Draft");

    // Include Sent/Viewed for the pendingApproval display bucket; Paid for completeness
    let validEstimateStatuses = ["Sent", "Viewed", "Approved", "Invoiced", "Partially Paid", "Paid"];
    if (includeUnissued) validEstimateStatuses.push("Draft");

    let validRetainerStatuses = ["Sent", "Paid", "Partially Paid"];
    if (includeUnissued) validRetainerStatuses.push("Draft");

    const invoices = await prisma.invoice.findMany({
        where: { projectId, status: { in: validInvoiceStatuses } },
        include: { payments: true }
    });

    const estimates = await prisma.estimate.findMany({
        where: { projectId, status: { in: validEstimateStatuses } },
        select: { id: true, status: true, totalAmount: true, balanceDue: true },
    });

    const retainers = await prisma.retainer.findMany({
        where: { projectId, status: { in: validRetainerStatuses } },
    });

    let currentIncoming = 0;
    let scheduledIncoming = 0;
    let overdueIncoming = 0;
    let forecastedIncomingFromEstimates = 0;

    // Payments from Invoices
    for (const inv of invoices) {
        for (const payment of inv.payments) {
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

    // Retainers
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

    // Estimates (Forecasted without invoices)
    // Only count Approved estimates — Sent/Viewed are not accepted, Invoiced/Partially Paid/Paid
    // are already tracked via invoice payment schedules above.
    for (const est of estimates) {
        if (est.status === "Approved") {
            forecastedIncomingFromEstimates += Number(est.totalAmount);
        }
    }

    const totalForecastedIncoming = currentIncoming + scheduledIncoming + overdueIncoming + forecastedIncomingFromEstimates;
    const clientOwes = scheduledIncoming + overdueIncoming;

    // ------------------------------------
    // 2. OUTGOING PAYMENTS (Expenses + POs)
    // ------------------------------------
    const expenses = await prisma.expense.findMany({
        where: { estimate: { projectId } }
    });

    let validPoStatuses = ["Sent", "Received", "Draft"]; // Include draft always in query, filter below
    const pos = await prisma.purchaseOrder.findMany({
        where: { projectId }
    });

    let totalExpenses = 0;
    for (const exp of expenses) {
        totalExpenses += Number(exp.amount);
    }

    let plannedExpenses = 0;
    let overdueExpenses = 0;
    let forecastedPoAmount = 0;

    for (const po of pos) {
        if (!includeUnissued && po.status === "Draft") continue;
        // Mock logic for PO due dates since they don't have a due date in schema (using sentAt if needed)
        // We'll treat all PO totalAmounts as forecasted
        forecastedPoAmount += Number(po.totalAmount);
        plannedExpenses += Number(po.totalAmount);
    }

    const currentOutgoing = totalExpenses;
    const forecastedOutgoing = totalExpenses + forecastedPoAmount;

    // ------------------------------------
    // 3. CASH FLOW & MARGIN
    // ------------------------------------
    const currentMargin = currentIncoming > 0 ? ((currentIncoming - currentOutgoing) / currentIncoming) * 100 : 0;
    const forecastedMargin = totalForecastedIncoming > 0 ? ((totalForecastedIncoming - forecastedOutgoing) / totalForecastedIncoming) * 100 : 0;

    // ------------------------------------
    // 4. FINANCIAL ITEMS
    // ------------------------------------
    const timeEntries = await prisma.timeEntry.findMany({
        where: { projectId }
    });
    
    let totalTimeHours = 0;
    let totalTimeCost = 0;
    for (const te of timeEntries) {
        if (te.durationHours) totalTimeHours += Number(te.durationHours);
        totalTimeCost += (Number(te.laborCost) || 0) + (Number(te.burdenCost) || 0);
    }

    const estimateStatus = {
        pendingApproval: { count: 0, totalAmount: 0 },
        uninvoiced: { count: 0, totalAmount: 0 }
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

    // ------------------------------------
    // 5. TIMELINE (Cash Flow Tracker)
    // ------------------------------------
    // Build cash flow timeline from actual invoice payments bucketed by month
    const allPayments = await prisma.paymentSchedule.findMany({
        where: { invoice: { projectId } },
        select: { amount: true, paidAt: true, createdAt: true }
    });
    const allExpenseRecords = await prisma.expense.findMany({
        where: { estimate: { projectId } },
        select: { amount: true, date: true, createdAt: true }
    });

    const monthlyData: Record<string, { incomingPayments: number; outgoingPayments: number }> = {};
    for (let i = 4; i >= 0; i--) {
        const d = new Date(now);
        d.setMonth(now.getMonth() - i);
        const key = d.toLocaleString('default', { month: 'short', year: '2-digit' });
        monthlyData[key] = { incomingPayments: 0, outgoingPayments: 0 };
    }

    for (const p of allPayments) {
        const d = p.paidAt || p.createdAt;
        const key = d.toLocaleString('default', { month: 'short', year: '2-digit' });
        if (monthlyData[key]) monthlyData[key].incomingPayments += Number(p.amount) || 0;
    }
    for (const e of allExpenseRecords) {
        const d = e.date || e.createdAt;
        const key = d.toLocaleString('default', { month: 'short', year: '2-digit' });
        if (monthlyData[key]) monthlyData[key].outgoingPayments += Number(e.amount) || 0;
    }

    const cashFlowTimeline = Object.entries(monthlyData).map(([date, vals]) => ({
        date,
        incomingPayments: vals.incomingPayments,
        forecastedIncoming: totalForecastedIncoming / 5,
        outgoingPayments: vals.outgoingPayments,
        forecastedOutgoing: forecastedOutgoing / 5,
        overdue: overdueIncoming / 5,
    }));

    return NextResponse.json({
        cashFlow: {
            currentIncoming,
            currentOutgoing,
            forecastedIncoming: totalForecastedIncoming,
            forecastedOutgoing,
            currentMargin,
            forecastedMargin
        },
        incomingPayments: {
            current: currentIncoming,
            scheduled: scheduledIncoming,
            overdue: overdueIncoming,
            totalForecasted: totalForecastedIncoming,
            clientOwes
        },
        outgoingPayments: {
            totalExpenses,
            plannedExpenses,
            overdueExpenses,
            hasExpenses: expenses.length > 0 || pos.length > 0
        },
        cashFlowTimeline,
        timeLogged: {
            totalHours: totalTimeHours,
            totalCost: totalTimeCost,
            hasEntries: timeEntries.length > 0
        },
        uninvoicedItems: {
            count: estimateStatus.uninvoiced.count, // Simplified mapping
            totalAmount: estimateStatus.uninvoiced.totalAmount,
            hasItems: estimateStatus.uninvoiced.count > 0
        },
        estimateStatus
    });
}
