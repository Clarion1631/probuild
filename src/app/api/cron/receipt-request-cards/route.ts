import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { evaluateReviewIssue } from "@/lib/review-alert-lifecycle";
import { decodeReasonCodes } from "@/lib/review-alert-reasons";
import { RECEIPT_REQUEST_TARGET_TYPE } from "@/lib/receipt-requests";
import {
    buildOwnerCards,
    isPacificWeekday,
    pacificDate,
    postOwnerCard,
    type CardCandidateIssue,
    type OwnerCard,
} from "@/lib/receipt-request-cards";
import { parseMissingReceiptDetails } from "@/app/automation/receipts-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Per-owner missing-receipt Chat digest (Phase 2 §4). Weekday mornings, 14:30
 * UTC (7:30 AM PDT; drifts to 6:30 in PST — accepted, same as every other cron
 * here).
 *
 * Ships DISABLED. `RECEIPT_REQUEST_CARDS_ENABLED` must be exactly "true", so
 * the matcher and the Receipts tab run silently for a shakedown week before
 * anyone's phone buzzes. Justin turns Beverly's own missing-receipt asks off in
 * the same step he flips this on — two chase surfaces at once is worse than
 * none (spec risk 5).
 *
 * NEVER emails anything. The whole point is a reply-in-thread chase.
 */

const CLAIM_LOCK_KEY = "receipt-request-cards";
const CANDIDATE_TAKE = 200;

async function claim(): Promise<boolean> {
    return prisma.$transaction(async tx => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${CLAIM_LOCK_KEY}, 0)) AS locked`,
        );
        return lock?.locked === true;
    });
}

function str(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Stamp every listed item's issue with the thread it was asked in. This is
 * BOTH the day's idempotency record and the data the threads bridge endpoint
 * serves, and it rides `displayDetails` — which is deliberately not part of the
 * reason hash, so writing it opens no new generation and sends no second card.
 */
async function recordCardOnIssues(card: OwnerCard, threadName: string | null, messageName: string | null) {
    for (const item of card.items) {
        const issue = await prisma.reviewIssue.findUnique({
            where: { id: item.issueId },
            select: { displayDetails: true, reasonCodes: true, clearedAt: true },
        });
        if (!issue || issue.clearedAt !== null) continue;
        const details = parseMissingReceiptDetails(issue.displayDetails);
        details.card = {
            threadName,
            messageName,
            n: item.n,
            date: card.date,
            requestId: card.requestId,
        };
        await evaluateReviewIssue(
            RECEIPT_REQUEST_TARGET_TYPE,
            item.targetKey,
            decodeReasonCodes(issue.reasonCodes),
            details,
            { episodeStatus: "SUPPRESSED" },
        );
    }
}

export async function GET(request: Request) {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (process.env.RECEIPT_REQUEST_CARDS_ENABLED !== "true") {
        return NextResponse.json({ ok: true, skipped: "disabled" });
    }
    const now = new Date();
    if (!isPacificWeekday(now)) {
        return NextResponse.json({ ok: true, skipped: "weekend" });
    }
    const webhookUrl = process.env.RECEIPTS_CHAT_WEBHOOK;
    if (!webhookUrl) {
        // Fail soft: the queue page still shows every one of these.
        return NextResponse.json({ ok: true, skipped: "no-webhook" });
    }
    if (!(await claim())) {
        return NextResponse.json({ ok: true, skipped: "locked" });
    }

    const issues = await prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, clearedAt: null },
        orderBy: { firstObservedAt: "asc" },
        take: CANDIDATE_TAKE,
        select: {
            id: true, targetKey: true, reasonCodes: true, acknowledgedCodes: true, displayDetails: true,
        },
    });

    const candidates: CardCandidateIssue[] = issues.map(issue => {
        const details = parseMissingReceiptDetails(issue.displayDetails);
        const card = details.card && typeof details.card === "object" ? (details.card as Record<string, unknown>) : {};
        const currentCodes = decodeReasonCodes(issue.reasonCodes);
        const acked = new Set(decodeReasonCodes(issue.acknowledgedCodes));
        return {
            id: issue.id,
            targetKey: issue.targetKey,
            owner: str(details.owner) ?? "unassigned",
            acknowledged: currentCodes.length > 0 && currentCodes.every(code => acked.has(code)),
            cardTail: str(details.cardTail),
            postedDate: str(details.postedDate) ?? "",
            amountCents: typeof details.amountCents === "number" ? details.amountCents : 0,
            payee: str(details.payee) ?? "",
            fingerprint: str(details.fingerprint) ?? `pb-${issue.targetKey}`,
            lastCardDate: str(card.date),
        };
    });

    const cards = buildOwnerCards(candidates, now);
    const posted: Array<{ owner: string; items: number; threadName: string | null }> = [];
    for (const card of cards) {
        const result = await postOwnerCard(webhookUrl, card);
        if (!result) continue;
        await recordCardOnIssues(card, result.threadName, result.messageName);
        posted.push({ owner: card.owner, items: card.items.length, threadName: result.threadName });
    }

    const summary = { ok: true, date: pacificDate(now), built: cards.length, posted };
    if (cards.length > 0) console.log("[cron/receipt-request-cards]", JSON.stringify(summary));
    return NextResponse.json(summary);
}
