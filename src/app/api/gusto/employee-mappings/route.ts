import { NextRequest, NextResponse } from "next/server";
import { saveGustoSettings } from "@/lib/integration-store";

export async function POST(req: NextRequest) {
    try {
        const { employeeMappings } = await req.json();
        if (typeof employeeMappings !== "object") {
            return NextResponse.json({ error: "employeeMappings must be an object" }, { status: 400 });
        }
        await saveGustoSettings({ employeeMappings });
        return NextResponse.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
