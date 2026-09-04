import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withReceiptEvidenceLock } from "@/lib/receipt-evidence-lock";
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
        // EVIDENCE (round-45 gate, finding 3). Any Expense write can change what
        // the missing-receipt sweep reads, so it goes through the shared fence:
        // the advisory lock, and the epoch bump that stops a cycle certifying
        // over it. Uniform on purpose — a per-field rule would need every
        // future edit to re-derive which columns the matcher happens to read.
        await withReceiptEvidenceLock(fn => prisma.$transaction(fn), tx => tx.expense.update({
            where: { id },
            data: { status: "Reviewed" },
        }));
        return NextResponse.json({ success: true });
    } catch (err) {
        if (err instanceof QboManagedExpenseError) {
            return NextResponse.json({ error: err.message }, { status: 409 });
        }
        const msg = err instanceof Error ? err.message : "Failed to approve";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
