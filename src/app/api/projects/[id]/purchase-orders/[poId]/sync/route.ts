import { NextRequest, NextResponse } from "next/server";
import { syncPurchaseOrderEmails } from "@/lib/gmail-sync";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string; poId: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { poId } = await context.params;

    try {
        const po = await prisma.purchaseOrder.findUnique({
            where: { id: poId },
            select: { id: true, code: true }
        });

        if (!po) {
            return NextResponse.json({ error: "PO not found" }, { status: 404 });
        }

        const result = await syncPurchaseOrderEmails(po.code, po.id);
        
        return NextResponse.json(result);
    } catch (error: any) {
        console.error("Sync Route Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
