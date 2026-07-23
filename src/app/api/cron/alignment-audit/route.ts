import { NextResponse } from "next/server";
import { runInvoiceAlignmentAudit } from "@/lib/invoice-alignment";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authed = !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
    const isLocalDev = !process.env.VERCEL && process.env.NODE_ENV !== "production" && !secret;
    if (!authed && !isLocalDev) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const result = await runInvoiceAlignmentAudit();
    console.log("[cron/alignment-audit]", JSON.stringify(result));
    return NextResponse.json(result);
}
