import { NextResponse } from "next/server";
import { drainInvoiceLifecycleEvents } from "@/lib/invoice-event-workers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authed = !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
    const isLocalDev = !process.env.VERCEL && process.env.NODE_ENV !== "production" && !secret;
    if (!authed && !isLocalDev) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const result = await drainInvoiceLifecycleEvents({ limit: 50 });
    if (result.email.processed || result.qbo.processed || result.strandedSends || result.email.dead || result.qbo.dead) {
        console.log("[cron/qbo-webhook-drain]", JSON.stringify(result));
    }
    return NextResponse.json(result);
}
