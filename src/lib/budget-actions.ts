"use server";

import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";

export async function getBudgetData(projectId: string) {
    const estimates = await prisma.estimate.findMany({
        where: { projectId },
        select: {
            id: true,
            number: true,
            title: true,
            code: true,
            status: true,
            totalAmount: true,
            balanceDue: true,
            createdAt: true,
            projectId: true,
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
        where: { estimate: { is: { projectId } } },
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

    return {
        estimates: estimates.map((estimate) => ({
            ...estimate,
            totalAmount: toNum(estimate.totalAmount),
            balanceDue: toNum(estimate.balanceDue),
            items: estimate.items.map((item) => ({
                ...item,
                isSection: "isSection" in item ? Boolean((item as { isSection?: boolean }).isSection) : false,
                quantity: toNum(item.quantity),
                baseCost: item.baseCost === null ? null : toNum(item.baseCost),
                markupPercent: toNum(item.markupPercent),
                unitCost: toNum(item.unitCost),
                total: toNum(item.total),
            })),
        })),
        changeOrders: changeOrders.map((changeOrder) => ({
            ...changeOrder,
            totalAmount: toNum(changeOrder.totalAmount),
            items: changeOrder.items.map((item) => ({
                ...item,
                quantity: toNum(item.quantity),
                baseCost: item.baseCost === null ? null : toNum(item.baseCost),
                markupPercent: toNum(item.markupPercent),
                unitCost: toNum(item.unitCost),
                total: toNum(item.total),
            })),
        })),
        expenses: expenses.map((expense) => ({
            ...expense,
            amount: toNum(expense.amount),
            date: expense.date ? expense.date.toISOString() : null,
        })),
        timeEntries: timeEntries.map((entry) => ({
            ...entry,
            laborCost: entry.laborCost === null ? null : toNum(entry.laborCost),
            burdenCost: entry.burdenCost === null ? null : toNum(entry.burdenCost),
        })),
        purchaseOrders: purchaseOrders.map((purchaseOrder) => ({
            ...purchaseOrder,
            totalAmount: toNum(purchaseOrder.totalAmount),
            items: purchaseOrder.items.map((item) => ({
                ...item,
                total: toNum(item.total),
            })),
        })),
        invoices: invoices.map((invoice) => ({
            ...invoice,
            totalAmount: toNum(invoice.totalAmount),
            balanceDue: toNum(invoice.balanceDue),
            payments: invoice.payments.map((payment) => ({
                ...payment,
                amount: toNum(payment.amount),
                paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
            })),
        })),
    };
}
