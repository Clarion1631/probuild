import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { GUIDE_HTML } from "./guide-html";

export const dynamic = "force-dynamic";

export async function GET() {
    const user = await getCurrentUserWithPermissions();
    if (!user) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    if (!hasPermission(user, "financialReports")) {
        return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }
    return new NextResponse(GUIDE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
