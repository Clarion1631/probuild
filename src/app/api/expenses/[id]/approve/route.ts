import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
    QboManagedExpenseError,
    assertExpenseMutableOutsideQbo,
} from "@/lib/qbo-expense-guard";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { id } = await params;
        const expense = await prisma.expense.findUnique({
            where: { id },
            select: { qbPurchaseId: true },
        });
        assertExpenseMutableOutsideQbo(expense);
        await prisma.expense.update({
            where: { id },
            data: { status: "Reviewed" },
        });
        return NextResponse.json({ success: true });
    } catch (err) {
        if (err instanceof QboManagedExpenseError) {
            return NextResponse.json({ error: err.message }, { status: 409 });
        }
        const msg = err instanceof Error ? err.message : "Failed to approve";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
