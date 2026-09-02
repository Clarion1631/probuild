import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RECEIPT_INTAKE_SECRET_HEADER, secretMatches } from "@/lib/receipt-intake/intake-auth";
import { decodeReasonCodes } from "@/lib/review-alert-reasons";
import { CARD_HISTORY_DAYS, RECEIPT_REQUEST_TARGET_TYPE } from "@/lib/receipt-requests";
import {
    parseOwnerChatUsers,
    serializeThreads,
    type CardItem,
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
 * THE OUTBOX IS THE SOURCE OF TRUTH. Earlier this reconstructed threads by
 * scanning every open issue's `displayDetails.cards[]` and grouping by thread
 * name, which made the export a derived guess: an issue whose details write
 * failed vanished from its own thread, and the ITEM NUMBERING — the thing a
 * "sign 2" reply resolves against — was re-derived rather than read from the
 * message that was actually sent. `ReceiptRequestCard.itemsJson` is the
 * immutable snapshot that WAS posted, so it is what gets exported; the issues
 * are joined in only for the display fields (payee, amount, date).
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

/** Cards posted in the last two weeks; matches the issues' own cards[] retention. */
const WINDOW_DAYS = CARD_HISTORY_DAYS;

function parseItems(itemsJson: string): CardItem[] {
    try {
        const parsed: unknown = JSON.parse(itemsJson);
        return Array.isArray(parsed) ? (parsed as CardItem[]) : [];
    } catch {
        return [];
    }
}

export async function GET(request: Request) {
    const provided = request.headers.get(RECEIPT_INTAKE_SECRET_HEADER);
    if (!secretMatches(provided, process.env.RECEIPT_INTAKE_SECRET)) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

    // POSTED cards only. A claimed-but-unposted row describes a message that
    // never reached Chat, and exporting its thread would invite the sweep to
    // look for replies in a thread that does not exist.
    const cards = await prisma.receiptRequestCard.findMany({
        where: { pacificDate: { gte: cutoff }, postedAt: { not: null }, threadName: { not: null } },
        orderBy: { pacificDate: "desc" },
        take: 200,
        select: { owner: true, itemsJson: true, threadName: true, messageName: true },
    });
    if (cards.length === 0) {
        return NextResponse.json(serializeThreads([], parseOwnerChatUsers(process.env.RECEIPT_OWNER_CHAT_USERS)));
    }

    // Join the issues in for display fields only. A CLEARED issue is dropped:
    // it has been answered, and the sweep must never chase it again — but the
    // thread itself stays, carrying whatever items are still open.
    const issueIds = [...new Set(cards.flatMap(card => parseItems(card.itemsJson).map(item => item.issueId)))];
    const issues = await prisma.reviewIssue.findMany({
        where: { id: { in: issueIds }, targetType: RECEIPT_REQUEST_TARGET_TYPE, clearedAt: null },
        select: { id: true, targetKey: true, reasonCodes: true, displayDetails: true },
    });
    const detailsById = new Map(
        issues
            .filter(issue => decodeReasonCodes(issue.reasonCodes).length > 0)
            .map(issue => [issue.id, { targetKey: issue.targetKey, details: parseMissingReceiptDetails(issue.displayDetails) }]),
    );

    const posted: PostedCardRecord[] = [];
    for (const card of cards) {
        const items: ThreadRecordItem[] = [];
        for (const item of parseItems(card.itemsJson)) {
            const joined = detailsById.get(item.issueId);
            if (!joined) continue; // answered since, or never ours
            const details = joined.details;
            const amountCents = typeof details.amountCents === "number" ? details.amountCents : item.cents;
            items.push({
                // `n` comes from the SNAPSHOT, never recomputed: it is what the
                // message said, and what "sign 2" means.
                n: item.n,
                fingerprint: typeof details.fingerprint === "string" ? details.fingerprint : item.fingerprint,
                date: typeof details.postedDate === "string" ? details.postedDate : item.date,
                vendor: typeof details.payee === "string" ? details.payee : item.vendor,
                cents: Math.abs(amountCents),
                amount: (Math.abs(amountCents) / 100).toFixed(2),
            });
        }
        if (items.length === 0) continue; // every item answered — nothing left to chase
        posted.push({
            threadName: card.threadName as string,
            messageName: card.messageName ?? "",
            owner: card.owner,
            items: items.sort((a, b) => a.n - b.n),
        });
    }

    return NextResponse.json(serializeThreads(posted, parseOwnerChatUsers(process.env.RECEIPT_OWNER_CHAT_USERS)));
}
