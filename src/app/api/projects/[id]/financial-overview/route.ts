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

    let validEstimateStatuses = ["Sent", "Approved", "Invoiced", "Partially Paid"];
    if (includeUnissued) validEstimateStatuses.push("Draft", "Viewed");

    let validRetainerStatuses = ["Sent", "Paid", "Partially Paid"];
    if (includeUnissued) validRetainerStatuses.push("Draft");

    const invoices = await prisma.invoice.findMany({
        where: { projectId, status: { in: validInvoiceStatuses } },
        include: { payments: true }
    });

    const estimates = await prisma.estimate.findMany({
        where: { projectId, status: { in: validEstimateStatuses } },
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
                currentIncoming += payment.amount;
            } else {
                if (payment.dueDate && payment.dueDate < now) {
                    overdueIncoming += payment.amount;
                } else {
                    scheduledIncoming += payment.amount;
                }
            }
        }
    }

    // Retainers
    for (const ret of retainers) {
        currentIncoming += ret.amountPaid;
        const balance = ret.balanceDue;
        if (balance > 0) {
            if (ret.dueDate && ret.dueDate < now) {
                overdueIncoming += balance;
            } else {
                scheduledIncoming += balance;
            }
        }
    }

    // Estimates (Forecasted without invoices)
    // Avoid double counting if estimate is already invoiced, we can roughly exclude status "Invoiced" and "Partially Paid"
    for (const est of estimates) {
        if (est.status !== "Invoiced" && est.status !== "Partially Paid") {
            forecastedIncomingFromEstimates += est.totalAmount;
        }
    }

    const totalForecastedIncoming = currentIncoming + scheduledIncoming + overdueIncoming + forecastedIncomingFromEstimates;
    const clientOwes = scheduledIncoming + overdueIncoming;

    // ------------------------------------
    // 2. OUTGOING PAYMENTS (Expenses + POs)
    // ------------------------------------
    const expenses: any[] = [];

    let validPoStatuses = ["Sent", "Received", "Draft"]; // Include draft always in query, filter below
    const pos = await prisma.purchaseOrder.findMany({
        where: { projectId }
    });

    let totalExpenses = 0;
    for (const exp of expenses) {
        totalExpenses += exp.amount;
    }

    let plannedExpenses = 0;
    let overdueExpenses = 0;
    let forecastedPoAmount = 0;

    for (const po of pos) {
        if (!includeUnissued && po.status === "Draft") continue;
        // Mock logic for PO due dates since they don't have a due date in schema (using sentAt if needed)
        // We'll treat all PO totalAmounts as forecasted
        forecastedPoAmount += po.totalAmount;
        plannedExpenses += po.totalAmount; // simplistic handling since no due dates on POs in schema
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
        if (te.durationHours) totalTimeHours += te.durationHours;
        const rateToUse = te.burdenCost || te.laborCost || 0;
        totalTimeCost += rateToUse; 
    }

    const estimateStatus = {
        pendingApproval: { count: 0, totalAmount: 0 },
        uninvoiced: { count: 0, totalAmount: 0 }
    };
    for (const est of estimates) {
        if (est.status === "Sent" || est.status === "Viewed") {
            estimateStatus.pendingApproval.count++;
            estimateStatus.pendingApproval.totalAmount += est.totalAmount;
        } else if (est.status === "Approved") {
            estimateStatus.uninvoiced.count++;
            estimateStatus.uninvoiced.totalAmount += est.totalAmount;
        }
    }

    // ------------------------------------
    // 5. TIMELINE (Cash Flow Tracker)
    // ------------------------------------
    // Generating dummy past 4 months for now to satisfy chart UI
    const cashFlowTimeline = [];
    for (let i = 4; i >= 0; i--) {
        const d = new Date();
        d.setMonth(now.getMonth() - i);
        cashFlowTimeline.push({
            date: d.toLocaleString('default', { month: 'short', year: '2-digit' }),
            incomingPayments: Math.max(0, currentIncoming / 5 + (Math.random() * 1000 - 500)),
            forecastedIncoming: totalForecastedIncoming / 5,
            outgoingPayments: Math.max(0, currentOutgoing / 5 + (Math.random() * 1000 - 500)),
            forecastedOutgoing: forecastedOutgoing / 5,
            overdue: overdueIncoming / 5,
        });
    }

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
