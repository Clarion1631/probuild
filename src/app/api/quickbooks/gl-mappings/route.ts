import { NextRequest, NextResponse } from "next/server";
import { saveQBSettings } from "@/lib/integration-store";

export async function POST(req: NextRequest) {
    try {
        const { glMappings } = await req.json();
        if (typeof glMappings !== "object") {
            return NextResponse.json({ error: "glMappings must be an object" }, { status: 400 });
        }
        // saveQBSettings THROWS if it could not persist — same reasoning as the
        // Gusto mapping endpoint: a suppressed database error used to be
        // reported to the caller as a successful save.
        await saveQBSettings({ glMappings });
        return NextResponse.json({ success: true });
    } catch (err) {
        console.error("POST /api/quickbooks/gl-mappings failed:", err);
        return NextResponse.json(
            { error: "Could not save the QuickBooks GL mappings. Nothing was changed - try again." },
            { status: 500 }
        );
    }
}
