import { NextResponse } from "next/server";
import { getPurchaseOrders, createPurchaseOrder } from "@/lib/actions";

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const projectId = searchParams.get("projectId");
        if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
        
        const pos = await getPurchaseOrders(projectId);
        return NextResponse.json(pos);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const data = await req.json();
        const { projectId, ...poData } = data;
        if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
        
        const po = await createPurchaseOrder(projectId, poData);
        return NextResponse.json(po);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
