import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
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
