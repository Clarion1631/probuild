import { NextResponse } from "next/server";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { createRouteDeadline, isQBBudgetExhaustedError } from "@/lib/quickbooks";
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

    // Under the 60s ceiling: the token refresh plus two list reads are all
    // QBO round trips, and without a shared budget they could add up past it.
    const deadline = createRouteDeadline(50_000);
    try {
        const tokens = await getFreshQBTokens(deadline);
        const [purchases, payments] = await Promise.all([
            getRecentQBPurchases(tokens, days, deadline),
            getRecentQBPaymentsList(tokens, days, deadline),
        ]);
        return NextResponse.json({ ok: true, days, purchases, payments });
    } catch (e) {
        if (e instanceof QBNotConnectedError) {
            return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
        }
        if (isQBBudgetExhaustedError(e)) {
            return NextResponse.json({ ok: false, reason: "qbo-budget-exhausted", retry: true }, { status: 503 });
        }
        return NextResponse.json(
            { ok: false, reason: e instanceof Error ? e.message.slice(0, 300) : "snapshot failed" },
            { status: 500 }
        );
    }
}
