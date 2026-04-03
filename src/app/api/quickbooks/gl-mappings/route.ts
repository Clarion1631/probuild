import { NextRequest, NextResponse } from "next/server";
import { saveQBSettings } from "@/lib/integration-store";

export async function POST(req: NextRequest) {
    try {
        const { glMappings } = await req.json();
        if (typeof glMappings !== "object") {
            return NextResponse.json({ error: "glMappings must be an object" }, { status: 400 });
        }
        await saveQBSettings({ glMappings });
        return NextResponse.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
