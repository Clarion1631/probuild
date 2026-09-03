import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withReceiptEvidenceLock } from "@/lib/receipt-evidence-lock";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
    QboManagedExpenseError,
    assertExpenseMutableOutsideQbo,
} from "@/lib/qbo-expense-guard";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({
            where: { id },
            select: { qbPurchaseId: true },
        });
        assertExpenseMutableOutsideQbo(expense);
        // EVIDENCE (round-45 gate, finding 3). Any Expense write can change what
        // the missing-receipt sweep reads, so it goes through the shared fence:
        // the advisory lock, and the epoch bump that stops a cycle certifying
        // over it. Uniform on purpose — a per-field rule would need every
        // future edit to re-derive which columns the matcher happens to read.
        // A DELETE is the sharpest case of it: the sweep read this row as
        // "the receipt exists" and it is about to stop existing.
        await withReceiptEvidenceLock(fn => prisma.$transaction(fn),
            tx => tx.expense.deleteMany({ where: { id, qbPurchaseId: null } }));

        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof QboManagedExpenseError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        console.error("Error deleting expense:", error);
        return NextResponse.json({ error: "Failed to delete expense" }, { status: 500 });
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({
            where: { id },
            select: { qbPurchaseId: true },
        });
        assertExpenseMutableOutsideQbo(expense);
        const body = await req.json();

        if (body.itemId) {
            const itemExists = await prisma.estimateItem.findUnique({ where: { id: body.itemId }, select: { id: true } });
            if (!itemExists) {
                return NextResponse.json({ error: "This cost code is unsaved. Please click 'Save' on the Estimate first before moving an expense to it." }, { status: 400 });
            }
        }

        // EVIDENCE (round-45 gate, finding 3). Any Expense write can change what
        // the missing-receipt sweep reads, so it goes through the shared fence:
        // the advisory lock, and the epoch bump that stops a cycle certifying
        // over it. Uniform on purpose — a per-field rule would need every
        // future edit to re-derive which columns the matcher happens to read.
        // `amount`, `vendor` and `date` are literally three of the fields the
        // matcher pairs a charge on.
        const updatedExpense = await withReceiptEvidenceLock(fn => prisma.$transaction(fn), tx => tx.expense.update({
            where: { id },
            data: {
                amount: body.amount ? parseFloat(body.amount) : undefined,
                vendor: body.vendor || null,
                date: body.date ? new Date(body.date) : null,
                description: body.description || null,
                itemId: body.itemId || null,
            },
        }));

        return NextResponse.json(updatedExpense);
    } catch (error) {
        if (error instanceof QboManagedExpenseError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        console.error("Error updating expense:", error);
        return NextResponse.json({ error: "Failed to update expense" }, { status: 500 });
    }
}
