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
    // Fail CLOSED for a mail-sending endpoint: require a non-empty CRON_SECRET and an exact
    // header match on every deployed environment (production AND preview), so a public preview
    // URL or an empty secret ("Bearer undefined") can't drive the drainer. Only an explicit
    // local dev run (not on Vercel, NODE_ENV !== production) is allowed through unauthenticated.
    const isLocalDev = process.env.NODE_ENV !== "production" && !process.env.VERCEL;
    if (!isLocalDev) {
        const secret = process.env.CRON_SECRET;
        const authHeader = request.headers.get("authorization");
        if (!secret || authHeader !== `Bearer ${secret}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
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
