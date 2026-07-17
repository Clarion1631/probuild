import { NextResponse } from "next/server";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { getRecentQBPurchases, getRecentQBPaymentsList } from "@/lib/quickbooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Read-only QuickBooks snapshot for reconciliation tooling (the Claude weekly
 * radar): posted money-out (Purchases) and money-in (Payments) straight from
 * the books, using ProBuild's stored QBO tokens. Auth mirrors receipt-ingest:
 * x-ingest-key = RECEIPT_INGEST_SECRET. Never mutates anything.
 */
export async function GET(req: Request) {
    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "21", 10) || 21));

    try {
        const tokens = await getFreshQBTokens();
        const [purchases, payments] = await Promise.all([
            getRecentQBPurchases(tokens, days),
            getRecentQBPaymentsList(tokens, days),
        ]);
        return NextResponse.json({ ok: true, days, purchases, payments });
    } catch (e) {
        if (e instanceof QBNotConnectedError) {
            return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
        }
        return NextResponse.json(
            { ok: false, reason: e instanceof Error ? e.message.slice(0, 300) : "snapshot failed" },
            { status: 500 }
        );
    }
}
