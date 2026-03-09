import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        await prisma.expense.delete({ where: { id } });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error deleting expense:", error);
        return NextResponse.json({ error: "Failed to delete expense" }, { status: 500 });
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const body = await req.json();

        if (body.itemId) {
            const itemExists = await prisma.estimateItem.findUnique({ where: { id: body.itemId }, select: { id: true } });
            if (!itemExists) {
                return NextResponse.json({ error: "This cost code is unsaved. Please click 'Save' on the Estimate first before moving an expense to it." }, { status: 400 });
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
            },
        });

        return NextResponse.json(updatedExpense);
    } catch (error) {
        console.error("Error updating expense:", error);
        return NextResponse.json({ error: "Failed to update expense" }, { status: 500 });
    }
}
