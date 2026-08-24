import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { resolveCostCode } from "@/lib/cost-code-resolver";
import { EXPENSE_REVIEWER_ROLES } from "@/lib/cost-coding";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Approving is a reviewer action — a field-crew submitter must not approve their own.
        const actor = await prisma.user.findUnique({
            where: { email: session.user.email.toLowerCase() },
            select: { role: true },
        });
        if (!actor || !EXPENSE_REVIEWER_ROLES.includes(actor.role as never)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const { id } = await params;

        // Don't let an uncoded (or inactive-coded) expense be marked Reviewed — that's how
        // uncoded spend would slip past the gate (e.g. AI-parsed receipts are created Pending
        // with no code yet). Re-resolve to confirm the code is present AND active.
        const expense = await prisma.expense.findUnique({
            where: { id },
            select: { id: true, status: true, costCodeId: true, itemId: true },
        });
        if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });
        if (expense.status === "Reviewed") {
            return NextResponse.json({ success: true, alreadyReviewed: true });
        }
        const coded = await resolveCostCode({
            costCodeId: expense.costCodeId,
            lineItemId: expense.itemId,
        });
        if (!coded.ok) {
            return NextResponse.json(
                { error: `Can't approve: ${coded.error}` },
                { status: 400 }
            );
        }

        await prisma.expense.update({
            where: { id },
            data: { status: "Reviewed" },
        });
        return NextResponse.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to approve";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
