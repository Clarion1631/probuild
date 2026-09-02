import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RECEIPT_INTAKE_SECRET_HEADER, secretMatches } from "@/lib/receipt-intake/intake-auth";
import { decodeReasonCodes } from "@/lib/review-alert-reasons";
import { RECEIPT_REQUEST_TARGET_TYPE } from "@/lib/receipt-requests";
import {
    parseOwnerChatUsers,
    serializeThreads,
    type PostedCardRecord,
    type ThreadRecordItem,
} from "@/lib/receipt-request-cards";
import { parseMissingReceiptDetails } from "@/app/automation/receipts-data";

export const dynamic = "force-dynamic";

/**
 * The `affidavit-threads.json` bridge (Phase 2 §4).
 *
 * `sweepChatReceipts.js` only understands threads present in that Drive file,
 * and ProBuild has no Drive writer — so a qbo-clasp mirror
 * (`mirrorReceiptRequestThreads()`, a separate Apps Script change) polls this
 * endpoint and MERGES the result into the file by thread key, never clobbering
 * Beverly's own entries.
 *
 * The response shape is EXACTLY sweepChatReceipts.js:108-110. It is not ours to
 * improve: the sweep indexes by `thread.name` and reads those five keys.
 *
 * AUTH: the Phase 1 machine secret (`x-receipt-intake-secret`), fail-closed —
 * an unset secret refuses everyone rather than opening the door. This path is
 * on the proxy's exact-match public bypass so a machine caller gets a clean 401
 * instead of a 307 to /login; that bypass hands auth to this handler, it does
 * not remove it. A browser session is NOT a way in: there is no session branch
 * here at all.
 */

/** Cards posted in the last two weeks. Older threads are closed business. */
const WINDOW_DAYS = 14;

export async function GET(request: Request) {
    const provided = request.headers.get(RECEIPT_INTAKE_SECRET_HEADER);
    if (!secretMatches(provided, process.env.RECEIPT_INTAKE_SECRET)) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const issues = await prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, clearedAt: null },
        orderBy: { firstObservedAt: "desc" },
        take: 500,
        select: { targetKey: true, reasonCodes: true, displayDetails: true },
    });

    // One record per thread, items in their card order. A cleared issue is
    // already excluded above — the sweep must never chase something answered.
    const byThread = new Map<string, PostedCardRecord & { seen: Map<number, ThreadRecordItem> }>();
    for (const issue of issues) {
        if (decodeReasonCodes(issue.reasonCodes).length === 0) continue;
        const details = parseMissingReceiptDetails(issue.displayDetails);
        const card = details.card && typeof details.card === "object" ? (details.card as Record<string, unknown>) : null;
        if (!card) continue;
        const threadName = typeof card.threadName === "string" ? card.threadName : "";
        const cardDate = typeof card.date === "string" ? card.date : "";
        if (!threadName || cardDate < cutoff) continue;

        const record = byThread.get(threadName) ?? {
            threadName,
            messageName: typeof card.messageName === "string" ? card.messageName : "",
            owner: typeof details.owner === "string" ? details.owner : "unassigned",
            items: [],
            seen: new Map<number, ThreadRecordItem>(),
        };
        const n = typeof card.n === "number" ? card.n : record.seen.size + 1;
        // Numbering is what a "sign 2" reply resolves against, so a duplicate
        // n would make that reply ambiguous. First writer wins, deterministically.
        if (!record.seen.has(n)) {
            const amountCents = typeof details.amountCents === "number" ? details.amountCents : 0;
            record.seen.set(n, {
                n,
                fingerprint: typeof details.fingerprint === "string" ? details.fingerprint : `pb-${issue.targetKey}`,
                date: typeof details.postedDate === "string" ? details.postedDate : "",
                vendor: typeof details.payee === "string" ? details.payee : "",
                cents: Math.abs(amountCents),
                amount: (Math.abs(amountCents) / 100).toFixed(2),
            });
        }
        byThread.set(threadName, record);
    }

    const posted: PostedCardRecord[] = [...byThread.values()].map(record => ({
        threadName: record.threadName,
        messageName: record.messageName,
        owner: record.owner,
        items: [...record.seen.values()].sort((a, b) => a.n - b.n),
    }));

    return NextResponse.json(serializeThreads(posted, parseOwnerChatUsers(process.env.RECEIPT_OWNER_CHAT_USERS)));
}
