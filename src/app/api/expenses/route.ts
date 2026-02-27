export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export async function POST(req: NextRequest) {
    try {
        const { estimateId, itemId, amount, vendor, date, description, receiptUrl } = await req.json();

        if (!estimateId) {
            return NextResponse.json({ error: "estimateId is required" }, { status: 400 });
        }

        if (itemId) {
            const itemExists = await prisma.estimateItem.findUnique({ where: { id: itemId }, select: { id: true } });
            if (!itemExists) {
                return NextResponse.json({ error: "This cost code is unsaved. Please click 'Save' on the Estimate first before adding an expense to it." }, { status: 400 });
            }
        }

        const newExpense = await prisma.expense.create({
            data: {
                estimateId,
                itemId: itemId || null,
                amount: parseFloat(amount) || 0,
                vendor: vendor || null,
                date: date ? new Date(date) : null,
                description: description || null,
                receiptUrl: receiptUrl || null,
                status: "Pending",
            },
        });

        return NextResponse.json(newExpense);
    } catch (error: any) {
        console.error("Error creating expense:", error);
        return NextResponse.json({ error: "Failed to create expense", details: error?.message || String(error) }, { status: 500 });
    }
}
