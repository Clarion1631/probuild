import { NextResponse } from "next/server";
import { getVendors, createVendor } from "@/lib/actions";

export async function GET() {
    try {
        const vendors = await getVendors();
        return NextResponse.json(vendors);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const data = await req.json();
        const vendor = await createVendor(data);
        return NextResponse.json(vendor);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
