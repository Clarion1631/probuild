import { NextResponse } from "next/server";
import { getVendors, createVendor } from "@/lib/actions";

// Don't report a rejected request as a server fault. Validation errors carry an
// explicit `status`; the shared auth helpers throw bare "Unauthorized"/"Forbidden"
// Errors, so those two still have to be matched by message.
function errorResponse(error: any) {
    const message = error?.message || "Request failed";
    if (typeof error?.status === "number") return NextResponse.json({ error: message }, { status: error.status });
    if (message === "Unauthorized") return NextResponse.json({ error: message }, { status: 401 });
    if (message === "Forbidden") return NextResponse.json({ error: message }, { status: 403 });
    return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET() {
    try {
        const vendors = await getVendors();
        return NextResponse.json(vendors);
    } catch (error: any) {
        return errorResponse(error);
    }
}

export async function POST(req: Request) {
    try {
        const data = await req.json();
        const vendor = await createVendor(data);
        return NextResponse.json(vendor);
    } catch (error: any) {
        return errorResponse(error);
    }
}
