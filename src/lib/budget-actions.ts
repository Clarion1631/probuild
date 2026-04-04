"use server";

import { prisma } from "@/lib/prisma";

export async function getBudgetData(projectId: string) {
    const estimates = await prisma.estimate.findMany({
        where: { projectId },
        include: {
            items: {
                include: { costCode: true, costType: true },
                orderBy: { order: "asc" },
            },
        },
    });

    const changeOrders = await prisma.changeOrder.findMany({
        where: { projectId },
        include: {
            items: { include: { costCode: true, costType: true } },
        },
    });

    const expenses = await prisma.expense.findMany({
        where: { estimate: { projectId } },
        include: { costCode: true, costType: true, item: true },
    });

    const timeEntries = await prisma.timeEntry.findMany({
        where: { projectId },
        include: { costCode: true, costType: true, estimateItem: true, user: { select: { name: true } } },
    });

    const purchaseOrders = await prisma.purchaseOrder.findMany({
        where: { projectId, status: { not: "Cancelled" } },
        include: { items: { include: { costCode: true, costType: true } }, vendor: { select: { name: true } } },
    });

    const invoices = await prisma.invoice.findMany({
        where: { projectId },
        include: { payments: true },
    });

    return { estimates, changeOrders, expenses, timeEntries, purchaseOrders, invoices };
}
