import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { EXPENSE_REVIEWER_ROLES, resolveCostCode } from "@/lib/cost-coding";

/**
 * Editing/deleting an expense is a reviewer action (Expense has no submitter field, so it
 * can't be owner-scoped). Returns the actor on success, or a NextResponse to return as-is.
 */
async function requireReviewer(): Promise<
    { ok: true; actorId: string } | { ok: false; res: NextResponse }
> {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    const actor = await prisma.user.findUnique({
        where: { email: session.user.email.toLowerCase() },
        select: { id: true, role: true },
    });
    if (!actor || !EXPENSE_REVIEWER_ROLES.includes(actor.role as never)) {
        return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { ok: true, actorId: actor.id };
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireReviewer();
        if (!auth.ok) return auth.res;

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
        const auth = await requireReviewer();
        if (!auth.ok) return auth.res;

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const body = await req.json();

        // Validate amount if it's being changed (avoid NaN → 500).
        let amountUpdate: number | undefined;
        if (body.amount !== undefined) {
            const n = typeof body.amount === "number" ? body.amount : parseFloat(body.amount);
            if (!Number.isFinite(n) || n < 0) {
                return NextResponse.json({ error: "amount must be a finite number ≥ 0" }, { status: 400 });
            }
            amountUpdate = n;
        }

        // If the caller is changing the coding (itemId or costCodeId), re-resolve it and
        // require it still lands on an active cost code — an edit must not un-code or mis-code.
        let codingUpdate: { itemId?: string | null; costCodeId: string; costTypeId: string | null } | undefined;
        if ("itemId" in body || "costCodeId" in body) {
            const coded = await resolveCostCode({ costCodeId: body.costCodeId, lineItemId: body.itemId });
            if (!coded.ok) return NextResponse.json({ error: coded.error }, { status: coded.status });
            codingUpdate = {
                costCodeId: coded.costCodeId,
                costTypeId: coded.costTypeId,
                ...("itemId" in body ? { itemId: body.itemId || null } : {}),
            };
        }

        // Only touch fields the caller actually sent (undefined = leave as-is).
        const updatedExpense = await prisma.expense.update({
            where: { id },
            data: {
                amount: amountUpdate,
                vendor: body.vendor !== undefined ? body.vendor || null : undefined,
                date: body.date !== undefined ? (body.date ? new Date(body.date) : null) : undefined,
                description: body.description !== undefined ? body.description || null : undefined,
                ...(codingUpdate ?? {}),
            },
        });

        return NextResponse.json(updatedExpense);
    } catch (error) {
        console.error("Error updating expense:", error);
        return NextResponse.json({ error: "Failed to update expense" }, { status: 500 });
    }
}
