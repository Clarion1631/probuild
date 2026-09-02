import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { expenseForProjectWhere } from "@/lib/expense-attribution";
import {
    canAccessProject,
    canUseDevAuthFallback,
    getCurrentUserWithPermissions,
    hasPermission,
} from "@/lib/permissions";
import { computeProjectFinancials } from "@/lib/project-financials";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id: projectId } = await params;
    const { searchParams } = new URL(req.url);
    const includeUnissued = searchParams.get("includeUnissued") === "true";

    // Financial data policy (same as assertFinancialProjectAccess in
    // lib/actions.ts): the financialReports permission is required, and
    // FINANCE sees all projects while everyone else needs project access.
    const user = await getCurrentUserWithPermissions();
    if (!user) {
        if (!(await canUseDevAuthFallback())) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
    } else {
        if (!hasPermission(user, "financialReports")) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        if (user.role !== "FINANCE" && !canAccessProject(user, projectId)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const now = new Date();

    // ------------------------------------
    // 1-4. INCOMING / OUTGOING / MARGIN / TIME LOGGED
    // Shared with the company-wide Financials rollup (src/lib/project-financials.ts)
    // so the two screens can never disagree about a project's numbers.
    // ------------------------------------
    const fin = await computeProjectFinancials(projectId, { includeUnissued });
    const {
        currentIncoming, scheduledIncoming, overdueIncoming, clientOwes,
        totalForecastedIncoming, totalExpenses, plannedExpenses,
        currentOutgoing, forecastedOutgoing, currentMargin, forecastedMargin,
        totalTimeHours, totalTimeCost, hasExpenses, hasTimeEntries, estimateStatus,
    } = fin;
    const overdueExpenses = 0;

    // ------------------------------------
    // 5. TIMELINE (Cash Flow Tracker)
    // ------------------------------------
    // Build cash flow timeline from actual invoice payments bucketed by month
    const allPayments = await prisma.paymentSchedule.findMany({
        where: { invoice: { projectId } },
        select: { amount: true, paidAt: true, createdAt: true }
    });
    const allExpenseRecords = await prisma.expense.findMany({
        where: expenseForProjectWhere(projectId),
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
            hasExpenses
        },
        cashFlowTimeline,
        timeLogged: {
            totalHours: totalTimeHours,
            totalCost: totalTimeCost,
            hasEntries: hasTimeEntries
        },
        uninvoicedItems: {
            count: estimateStatus.uninvoiced.count, // Simplified mapping
            totalAmount: estimateStatus.uninvoiced.totalAmount,
            hasItems: estimateStatus.uninvoiced.count > 0
        },
        estimateStatus
    });
}
