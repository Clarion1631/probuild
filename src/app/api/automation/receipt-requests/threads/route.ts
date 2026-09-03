import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateBridge } from "@/lib/receipt-intake/intake-auth";
import { decodeReasonCodes } from "@/lib/review-alert-reasons";
import { CARD_HISTORY_DAYS, RECEIPT_REQUEST_TARGET_TYPE } from "@/lib/receipt-requests";
import {
    parseOwnerChatUsers,
    requestIdFor,
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
 * THE WHOLE RETENTION WINDOW, ANSWERED OR NOT (Codex PR #443 gate, finding 2).
 * Cleared issues used to be dropped from the join, so an item that had been
 * answered vanished from its own thread — and with it the numbering a reply
 * resolves against. A crew member replying "sign 2" to a card whose item 1 had
 * closed in the meantime was answering a list that no longer existed, and a
 * card whose items had ALL closed disappeared entirely, taking its thread
 * routing with it. `itemsJson` is the immutable record of what was posted, so
 * every posted item is exported for the full window and the answered ones are
 * marked `cleared: true` for the bridge to render as resolved. Suppressing a
 * re-ask is the bridge's job; renumbering the message it is reading is not
 * something this endpoint gets to do.
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
    // RECEIPT_BRIDGE_SECRET, not the intake key: this endpoint belongs to
    // Beverly's Apps Script project, and that project must not be able to book
    // anything. Presenting the intake or archive key here is a 403.
    const auth = authenticateBridge(request);
    if (!auth.ok) return auth.response;

    const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

    // POSTED cards only. A claimed-but-unposted row describes a message that
    // never reached Chat, and exporting its thread would invite the sweep to
    // look for replies in a thread that does not exist.
    const cards = await prisma.receiptRequestCard.findMany({
        where: { pacificDate: { gte: cutoff }, postedAt: { not: null }, threadName: { not: null } },
        orderBy: { pacificDate: "desc" },
        take: 200,
        select: { owner: true, pacificDate: true, itemsJson: true, threadName: true, messageName: true },
    });
    if (cards.length === 0) {
        return NextResponse.json(serializeThreads([], parseOwnerChatUsers(process.env.RECEIPT_OWNER_CHAT_USERS)));
    }

    // Join the issues in for display fields only — INCLUDING cleared ones, which
    // ship marked `cleared: true` rather than being dropped (see the note
    // above). The only rows excluded are ones that are not ours.
    const issueIds = [...new Set(cards.flatMap(card => parseItems(card.itemsJson).map(item => item.issueId)))];
    const issues = await prisma.reviewIssue.findMany({
        where: { id: { in: issueIds }, targetType: RECEIPT_REQUEST_TARGET_TYPE },
        select: { id: true, targetKey: true, reasonCodes: true, displayDetails: true, clearedAt: true },
    });
    const detailsById = new Map(
        issues
            // An OPEN issue with no reason codes is not a live chase, so it is
            // still filtered out. A CLEARED one legitimately has none — clearing
            // IS the empty-codes lifecycle step — and dropping it here would
            // reintroduce the very gap this change closes.
            .filter(issue => issue.clearedAt !== null || decodeReasonCodes(issue.reasonCodes).length > 0)
            .map(issue => [issue.id, {
                targetKey: issue.targetKey,
                details: parseMissingReceiptDetails(issue.displayDetails),
                cleared: issue.clearedAt !== null,
            }]),
    );

    const posted: PostedCardRecord[] = [];
    for (const card of cards) {
        const items: ThreadRecordItem[] = [];
        for (const item of parseItems(card.itemsJson)) {
            const joined = detailsById.get(item.issueId);
            if (!joined) continue; // never ours, or the issue row is gone
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
                cleared: joined.cleared,
            });
        }
        // Only when NOTHING on the card resolves to an issue at all — the thread
        // has no items to route a reply to. A card whose items are merely all
        // answered still ships: its thread is still where a late reply lands.
        if (items.length === 0) continue;
        posted.push({
            threadName: card.threadName as string,
            messageName: card.messageName ?? "",
            owner: card.owner,
            // DERIVED, not stored: the id is deterministic per owner and Pacific
            // date, and it is the same one the card record on each issue carries
            // — which is what the answers route matches against.
            requestId: requestIdFor(card.owner, card.pacificDate),
            items: items.sort((a, b) => a.n - b.n),
        });
    }

    return NextResponse.json(serializeThreads(posted, parseOwnerChatUsers(process.env.RECEIPT_OWNER_CHAT_USERS)));
}
