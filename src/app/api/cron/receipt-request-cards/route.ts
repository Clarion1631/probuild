import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { evaluateReviewIssue } from "@/lib/review-alert-lifecycle";
import { decodeReasonCodes } from "@/lib/review-alert-reasons";
import { RECEIPT_REQUEST_TARGET_TYPE, appendCardRecord } from "@/lib/receipt-requests";
import {
    CARD_OWNERS_ASKED,
    CARD_RATE_CEILING,
    MAX_ITEMS_PER_CARD,
    buildCardFromItems,
    isPacificWeekday,
    pacificDate,
    postOwnerCard,
    selectOwnerItems,
    type CardCandidateIssue,
    type CardItem,
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
 * IDEMPOTENCY IS A DATABASE CLAIM, NOT A CHAT FEATURE. An incoming webhook
 * offers no message-level idempotency; `threadKey` only guarantees a retry
 * lands in the same thread, never that it doesn't post twice into it. So
 * selection and the RECORD of selection happen in one transaction: a
 * `ReceiptRequestCard` row unique on (owner, pacificDate), holding the chosen
 * ReviewIssue ids immutably. A second concurrent run loses that insert and
 * posts nothing.
 *
 * THE ONE FAILURE WINDOW, documented rather than engineered away: the post
 * happens AFTER the claim commits, and `postedAt` is written after the webhook
 * answers. A crash in between leaves a claimed-but-unposted row, and the next
 * run re-posts that exact row (same ids, same order). Worst case is ONE
 * duplicate card; the alternative — marking sent before posting — silently
 * drops the day's chase, which is worse.
 *
 * NEVER emails anything. The whole point is a reply-in-thread chase.
 */

const CLAIM_LOCK_KEY = "receipt-request-cards";

/** Page size for the candidate scan. See scanCandidates for why it pages. */
const SCAN_PAGE_SIZE = 500;
/**
 * Absolute stop, so a pathological backlog cannot run the request out of time.
 * It is a SAFETY VALVE, not the scan's exit condition — see scanCandidates.
 */
const SCAN_MAX_PAGES = 200;

/**
 * How long a POST-CLAIM is honoured before another run may take it.
 *
 * The advisory lock is transaction-scoped and released the moment the claim
 * transaction commits — before any card is posted (the same caveat the intake
 * worker documents) — so two overlapping invocations can both get past it. The
 * `claimedAt`/`claimToken` CAS is what actually decides who posts: one run wins
 * it, and only that run may mark the row posted. A claim older than this lease
 * belongs to a run that died, and is up for grabs again.
 */
const CLAIM_LEASE_MS = 10 * 60_000;

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

function toCandidate(issue: {
    id: string; targetKey: string; reasonCodes: string; acknowledgedCodes: string; displayDetails: string | null;
}): CardCandidateIssue {
    const details = parseMissingReceiptDetails(issue.displayDetails);
    const currentCodes = decodeReasonCodes(issue.reasonCodes);
    const acked = new Set(decodeReasonCodes(issue.acknowledgedCodes));
    const cards = Array.isArray(details.cards) ? (details.cards as unknown[]) : [];
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
        everCarded: cards.length > 0 || (details.card !== undefined && details.card !== null),
    };
}

/**
 * Collect enough candidates for every asked owner.
 *
 * WHY THIS PAGES INSTEAD OF `take: 200`. A flat cap ordered by age is a
 * starvation bug: `office` and `unassigned` items (which nobody is ever asked
 * about) are the majority of the queue and are also the oldest, so they filled
 * the window and CJ's and Richard's items never appeared on a card at all.
 *
 * The obvious fix — filter owner in SQL — is not available: `owner` lives
 * inside `displayDetails`, a TEXT column holding JSON, and casting it to jsonb
 * raises on a single malformed row, which would take the whole cron down. (The
 * page loader guards against exactly that.) `acknowledgedCodes` IS a real
 * column, so the acknowledged filter does run in the query; for this target
 * type the code set is always exactly ["MISSING_RECEIPT"], so "contains it" and
 * "acknowledged" are the same statement.
 *
 * So the scan pages oldest-first and stops as soon as every asked owner has a
 * full card's worth (or the queue is exhausted). Bounded either way.
 */
async function scanCandidates(): Promise<{ candidates: CardCandidateIssue[]; pages: number; exhausted: boolean }> {
    const candidates: CardCandidateIssue[] = [];
    const perOwner = new Map<string, number>(CARD_OWNERS_ASKED.map(owner => [owner, 0]));
    const neverCardedPerOwner = new Map<string, number>(CARD_OWNERS_ASKED.map(owner => [owner, 0]));
    let cursor: string | undefined;
    let pages = 0;
    let exhausted = false;

    while (pages < SCAN_MAX_PAGES) {
        const page = await prisma.reviewIssue.findMany({
            where: {
                targetType: RECEIPT_REQUEST_TARGET_TYPE,
                clearedAt: null,
                // A real column, so this one genuinely narrows the query.
                NOT: { acknowledgedCodes: { contains: "MISSING_RECEIPT" } },
            },
            orderBy: [{ firstObservedAt: "asc" }, { id: "asc" }],
            take: SCAN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: { id: true, targetKey: true, reasonCodes: true, acknowledgedCodes: true, displayDetails: true },
        });
        pages++;
        if (page.length === 0) { exhausted = true; break; }
        cursor = page[page.length - 1].id;

        for (const row of page) {
            const candidate = toCandidate(row);
            if (!CARD_OWNERS_ASKED.includes(candidate.owner as never)) continue;
            if (candidate.acknowledged) continue;
            candidates.push(candidate);
            perOwner.set(candidate.owner, (perOwner.get(candidate.owner) ?? 0) + 1);
            if (!candidate.everCarded) {
                neverCardedPerOwner.set(candidate.owner, (neverCardedPerOwner.get(candidate.owner) ?? 0) + 1);
            }
        }
        if (page.length < SCAN_PAGE_SIZE) { exhausted = true; break; }
        // STOP CONDITION: every asked owner either has a NEVER-CARDED item in
        // hand, or has nothing left to find. A fixed page budget was the wrong
        // shape — with a long backlog of already-carded rows the scan could
        // stop before reaching the one new charge that should lead the card,
        // and the same frozen list would go out again. Selection prefers
        // never-carded items, so the scan has to keep going until it has found
        // one (or run out) for each owner.
        const satisfied = CARD_OWNERS_ASKED.every(owner =>
            (neverCardedPerOwner.get(owner) ?? 0) > 0
            && (perOwner.get(owner) ?? 0) >= MAX_ITEMS_PER_CARD);
        if (satisfied) break;
    }

    return { candidates, pages, exhausted };
}

/** Parse a claimed row's immutable item snapshot back into card items. */
function parseItems(itemsJson: string): CardItem[] {
    try {
        const parsed: unknown = JSON.parse(itemsJson);
        return Array.isArray(parsed) ? (parsed as CardItem[]) : [];
    } catch {
        return [];
    }
}

/**
 * Record the thread each listed item was asked in, on the item's own issue.
 * This is history the sweep reads, not a claim — the claim is the outbox row —
 * and it rides `displayDetails`, which is deliberately not part of the reason
 * hash, so writing it opens no new generation and sends no second alert.
 */
async function recordCardOnIssues(card: OwnerCard, threadName: string | null, messageName: string | null, now: Date) {
    // Called TWICE per card: once before the post (thread unknown) and once
    // after (thread filled in). appendCardRecord replaces the same-day entry
    // rather than stacking, so the second call updates the first's record.
    for (const item of card.items) {
        const issue = await prisma.reviewIssue.findUnique({
            where: { id: item.issueId },
            select: { displayDetails: true, reasonCodes: true, clearedAt: true },
        });
        if (!issue || issue.clearedAt !== null) continue;
        const details = appendCardRecord(
            parseMissingReceiptDetails(issue.displayDetails),
            { threadName, messageName, n: item.n, date: card.date, requestId: card.requestId },
            now,
        );
        await evaluateReviewIssue(
            RECEIPT_REQUEST_TARGET_TYPE,
            item.targetKey,
            decodeReasonCodes(issue.reasonCodes),
            details,
            { episodeStatus: "SUPPRESSED" },
        );
    }
}

function isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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

    const date = pacificDate(now);
    const yesterday = new Date(now.getTime() - 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const scan = await scanCandidates();
    const toPost: Array<{ card: OwnerCard; rowId: string; token: string; resumed: boolean }> = [];

    for (const owner of CARD_OWNERS_ASKED) {
        const existing = await prisma.receiptRequestCard.findUnique({
            where: { owner_pacificDate: { owner, pacificDate: date } },
            select: { id: true, itemsJson: true, overflow: true, postedAt: true },
        });

        if (existing) {
            // Already asked today — nothing to do, whoever posted it.
            if (existing.postedAt !== null) continue;

            // A claimed-but-unposted row: last run crashed, or its post failed.
            // TAKE THE POST-CLAIM BY TOKEN. `claimedAt` older than the lease (or
            // never set) is up for grabs; the CAS means exactly one concurrent
            // run wins it, and only the winner may later mark it posted. A
            // count of 0 means another run holds it right now — leave it be.
            const token = randomUUID();
            const taken = await prisma.receiptRequestCard.updateMany({
                where: {
                    id: existing.id,
                    postedAt: null,
                    OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }],
                },
                data: { claimedAt: now, claimToken: token },
            });
            if (taken.count === 0) continue;

            const items = parseItems(existing.itemsJson);
            if (items.length === 0) continue;
            toPost.push({ card: buildCardFromItems(owner, date, items, existing.overflow), rowId: existing.id, token, resumed: true });
            continue;
        }

        // Yesterday's unposted card is not lost work: its items are still open
        // (a cleared issue would have dropped out of the scan), so they are
        // simply re-planned into today's selection — which is what
        // never-carded-first ordering already does. Nothing to carry over
        // explicitly; the stale row is left as the record that the day failed.
        void yesterday;

        const { items, overflow } = selectOwnerItems(scan.candidates, owner);
        if (items.length === 0) continue;
        const token = randomUUID();
        try {
            // THE DAY-CLAIM and the POST-CLAIM in one insert: selection, its
            // immutable record, and this run's ownership of the post.
            const row = await prisma.receiptRequestCard.create({
                data: {
                    owner,
                    pacificDate: date,
                    itemsJson: JSON.stringify(items),
                    overflow,
                    claimedAt: now,
                    claimToken: token,
                },
                select: { id: true },
            });
            toPost.push({ card: buildCardFromItems(owner, date, items, overflow), rowId: row.id, token, resumed: false });
        } catch (error) {
            if (isUniqueConstraintError(error)) continue; // the other run won the day
            throw error;
        }
    }

    const posted: Array<{ owner: string; items: number; threadName: string | null; resumed: boolean }> = [];
    for (const { card, rowId, token, resumed } of toPost.slice(0, CARD_RATE_CEILING)) {
        // cards[] IS WRITTEN BEFORE THE POST, not after. The threads endpoint
        // and the sweep need the thread record to exist for any message that
        // reaches Chat; writing it afterwards meant a crash in between produced
        // a card in the space that ProBuild had no record of, so every reply to
        // it was orphaned. Written first, the worst case is a recorded thread
        // for a message that never went out — visible, and harmless.
        await recordCardOnIssues(card, null, null, now);

        const result = await postOwnerCard(webhookUrl, card);
        if (!result) {
            // Left UNPOSTED on purpose: a same-day retry can take the claim
            // again once the lease expires.
            await prisma.receiptRequestCard.updateMany({
                where: { id: rowId, claimToken: token },
                data: { attempts: { increment: 1 }, lastError: "post-failed", claimedAt: null, claimToken: null },
            });
            continue;
        }
        // COMPLETION IS TOKEN-FENCED: only the run that holds the claim may
        // record the post, so a late completion from a superseded run cannot
        // mark a row posted that it did not post.
        await prisma.receiptRequestCard.updateMany({
            where: { id: rowId, claimToken: token },
            data: {
                postedAt: new Date(),
                threadName: result.threadName,
                messageName: result.messageName,
                attempts: { increment: 1 },
                lastError: null,
            },
        });
        await recordCardOnIssues(card, result.threadName, result.messageName, now);
        posted.push({ owner: card.owner, items: card.items.length, threadName: result.threadName, resumed });
    }

    const summary = {
        ok: true,
        date,
        scanned: scan.candidates.length,
        scanPages: scan.pages,
        scanExhausted: scan.exhausted,
        claimed: toPost.length,
        posted,
    };
    if (toPost.length > 0) console.log("[cron/receipt-request-cards]", JSON.stringify(summary));
    return NextResponse.json(summary);
}
