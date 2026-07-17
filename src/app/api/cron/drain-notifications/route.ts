import { NextResponse } from "next/server";
import { drainPaymentNotifications } from "@/lib/payment-outbox";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Backstop drainer for the milestone-paid notification outbox. The settle paths deliver
 * inline right after commit; this cron redelivers anything left PENDING after a crash,
 * retries failed sends once their backoff has elapsed, and re-claims rows stuck in
 * PROCESSING (a worker that died mid-delivery). Loops a few batches so a backlog drains
 * in one run. Delivery is idempotent, so overlapping with an inline drain is safe.
 */
export async function GET(request: Request) {
    // Fail CLOSED for a mail-sending endpoint. Whenever a CRON_SECRET is configured it is
    // ALWAYS required (exact Bearer match) — on production, preview, and even a non-Vercel host
    // — so a public URL or an empty secret ("Bearer undefined") can't drive the drainer. The
    // only unauthenticated path is a genuinely local dev run: not on Vercel AND no secret set.
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization");
    const authed = !!secret && authHeader === `Bearer ${secret}`;
    const isLocalDev = !process.env.VERCEL && process.env.NODE_ENV !== "production" && !secret;
    if (!authed && !isLocalDev) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const total = { processed: 0, retried: 0, failed: 0 };
    for (let i = 0; i < 5; i++) {
        const r = await drainPaymentNotifications({ limit: 50 });
        total.processed += r.processed;
        total.retried += r.retried;
        total.failed += r.failed;
        if (r.processed + r.retried + r.failed === 0) break;
    }
    if (total.processed || total.retried || total.failed) {
        console.log("[cron/drain-notifications]", JSON.stringify(total));
    }
    return NextResponse.json(total);
}
