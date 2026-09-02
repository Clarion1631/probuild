/**
 * Recording which Chat thread each listed item was asked in.
 *
 * ONE writer, two callers: the cards cron after a confirmed post, and the
 * Receipts tab when an operator resolves an uncertain card by hand. Both are
 * "this card is out, and here is where it lives" — and both have to leave the
 * same trace, because the sweep and the bridge read that trace to resolve a
 * reply. A card marked delivered with no thread record is one nobody can answer.
 *
 * This is HISTORY, not a lifecycle event: it rides `displayDetails`, which is
 * deliberately not part of the reason hash, so writing it opens no generation
 * and sends no second alert.
 */
import { prisma } from "@/lib/prisma";
import { appendCardRecord } from "@/lib/receipt-requests";
import { parseMissingReceiptDetails } from "@/app/automation/receipts-data";
import type { CardItem } from "@/lib/receipt-request-cards";

/** Just enough of a card to record it. */
export interface RecordableCard {
    items: readonly CardItem[];
    /** YYYY-MM-DD Pacific. */
    date: string;
    requestId: string;
}

/** The two Prisma calls this needs — so a transaction client can be passed in. */
export type CardHistoryClient = Pick<typeof prisma, "reviewIssue">;

export async function recordCardOnIssues(
    card: RecordableCard,
    threadName: string,
    messageName: string,
    now: Date,
    client: CardHistoryClient = prisma,
): Promise<{ recorded: number; skipped: number; lostRaces: number }> {
    let recorded = 0;
    let skipped = 0;
    let lostRaces = 0;

    for (const item of card.items) {
        // FRESH READ INSIDE THE CAS. Replaying the codes and details captured
        // at selection time could reopen an issue that was cleared while the
        // card was in flight — and worse, write the stale details back over its
        // resolution, un-answering a memo somebody had just signed.
        const issue = await client.reviewIssue.findUnique({
            where: { id: item.issueId },
            select: { id: true, version: true, displayDetails: true, clearedAt: true },
        });
        // Answered while the card was posting. The card mentions it; that is
        // cosmetic and self-correcting. Touching the issue is not.
        if (!issue || issue.clearedAt !== null) { skipped++; continue; }

        const details = appendCardRecord(
            parseMissingReceiptDetails(issue.displayDetails),
            { threadName, messageName, n: item.n, date: card.date, requestId: card.requestId },
            now,
        );
        // A plain version-guarded write, NOT evaluateReviewIssue: this is card
        // history, not a lifecycle event. Routing it through the lifecycle
        // meant handing it a codes array, and any stale array is a reopen
        // waiting to happen. Losing the CAS costs one thread record — the next
        // card re-records it — and never costs a resolution.
        const written = await client.reviewIssue.updateMany({
            where: { id: issue.id, version: issue.version, clearedAt: null },
            data: { displayDetails: JSON.stringify(details), version: { increment: 1 } },
        });
        if (written.count === 0) {
            lostRaces++;
            console.warn("[receipt-card-history] card history lost a race", item.issueId);
            continue;
        }
        recorded++;
    }
    return { recorded, skipped, lostRaces };
}
