import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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
        await prisma.expense.deleteMany({ where: { id, qbPurchaseId: null } });

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

        // Phase 3 (spec §3.7): an edit here is a HUMAN re-coding the expense,
        // so it takes the highest precedence and no automated pass may touch it
        // again. `costCodeSource` is never read off the body — a client cannot
        // assert its own provenance — it is derived from the fact that a person
        // used this endpoint. The key is only acted on when it is present, so
        // existing callers that send {amount, vendor, date, ...} are unchanged.
        const editsCostCode = Object.prototype.hasOwnProperty.call(body, "costCodeId");
        const nextCostCodeId: string | null =
            typeof body.costCodeId === "string" && body.costCodeId.trim() ? body.costCodeId.trim() : null;
        if (editsCostCode && nextCostCodeId) {
            const costCode = await prisma.costCode.findUnique({
                where: { id: nextCostCodeId },
                select: { id: true, isActive: true },
            });
            if (!costCode) {
                return NextResponse.json({ error: "Cost code not found." }, { status: 400 });
            }
            if (!costCode.isActive) {
                return NextResponse.json({ error: "That cost code is inactive." }, { status: 400 });
            }
        }

        const updatedExpense = await prisma.expense.update({
            where: { id },
            data: {
                amount: body.amount ? parseFloat(body.amount) : undefined,
                vendor: body.vendor || null,
                date: body.date ? new Date(body.date) : null,
                description: body.description || null,
                itemId: body.itemId || null,
                ...(editsCostCode
                    ? {
                        costCodeId: nextCostCodeId,
                        // Clearing the code clears the provenance with it —
                        // leaving "manual" on a null code would guard a row
                        // that has nothing to guard.
                        costCodeSource: nextCostCodeId ? "manual" : null,
                        costCodeConfidence: null,
                    }
                    : {}),
            },
        });

        return NextResponse.json(updatedExpense);
    } catch (error) {
        if (error instanceof QboManagedExpenseError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        console.error("Error updating expense:", error);
        return NextResponse.json({ error: "Failed to update expense" }, { status: 500 });
    }
}
