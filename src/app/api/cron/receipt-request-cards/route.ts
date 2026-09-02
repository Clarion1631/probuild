import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { decodeReasonCodes } from "@/lib/review-alert-reasons";
import { RECEIPT_REQUEST_TARGET_TYPE, appendCardRecord, effectiveOwner } from "@/lib/receipt-requests";
import {
    CARD_OWNERS_ASKED,
    CARD_RATE_CEILING,
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
        // Same helper the page and the matcher use, so an assignment made on
        // the tab actually reaches tomorrow's card.
        owner: effectiveOwner(details),
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
        }
        if (page.length < SCAN_PAGE_SIZE) { exhausted = true; break; }
        // RUNS TO EXHAUSTION. It used to stop as soon as each owner had a full
        // card, which was enough to CHOOSE the items but not to COUNT the rest
        // — so "and 4 more" was whatever the scan happened to have seen, which
        // is a number that looks authoritative and isn't. The queue is small
        // (page size 500) and this is one cheap indexed read per page; when the
        // page cap does bite, `exhausted` stays false and the card drops the
        // number rather than printing a guess.
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
async function recordCardOnIssues(card: OwnerCard, threadName: string, messageName: string, now: Date) {
    for (const item of card.items) {
        // FRESH READ INSIDE THE CAS. Replaying the codes and details captured
        // at selection time could reopen an issue that was cleared while the
        // card was in flight — and worse, write the stale details back over its
        // resolution, un-answering a memo somebody had just signed.
        const issue = await prisma.reviewIssue.findUnique({
            where: { id: item.issueId },
            select: { id: true, version: true, displayDetails: true, clearedAt: true },
        });
        // Answered while the card was posting. The card mentions it; that is
        // cosmetic and self-correcting. Touching the issue is not.
        if (!issue || issue.clearedAt !== null) continue;

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
        const written = await prisma.reviewIssue.updateMany({
            where: { id: issue.id, version: issue.version, clearedAt: null },
            data: { displayDetails: JSON.stringify(details), version: { increment: 1 } },
        });
        if (written.count === 0) {
            console.warn("[cron/receipt-request-cards] card history lost a race", item.issueId);
        }
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
    // RETRY PASS (?retry=1, the 2-hours-later cron). It never SELECTS: it only
    // re-posts rows an earlier run claimed and failed to deliver, so a webhook
    // outage at 7:30 does not cost the crew their whole day.
    const retryOnly = new URL(request.url).searchParams.get("retry") === "1";
    const yesterday = new Date(now.getTime() - 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    // The retry pass posts from the claimed snapshot, so it needs no scan.
    const scan = retryOnly
        ? { candidates: [] as CardCandidateIssue[], pages: 0, exhausted: true }
        : await scanCandidates();
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
            toPost.push({ card: buildCardFromItems(owner, date, items, existing.overflow, scan.exhausted), rowId: existing.id, token, resumed: true });
            continue;
        }

        // Yesterday's unposted card is not lost work: its items are still open
        // (a cleared issue would have dropped out of the scan), so they are
        // simply re-planned into today's selection — which is what
        // never-carded-first ordering already does. Nothing to carry over
        // explicitly; the stale row is left as the record that the day failed.
        void yesterday;

        if (retryOnly) continue; // nothing claimed today; the retry pass does not select
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
            toPost.push({ card: buildCardFromItems(owner, date, items, overflow, scan.exhausted), rowId: row.id, token, resumed: false });
        } catch (error) {
            if (isUniqueConstraintError(error)) continue; // the other run won the day
            throw error;
        }
    }

    const posted: Array<{ owner: string; items: number; threadName: string | null; resumed: boolean }> = [];
    // A webhook IS configured and a delivery still failed. That is an outage,
    // not a quiet day: a 200 here meant nobody was ever told the crew's card
    // did not go out.
    const failures: string[] = [];
    for (const { card, rowId, token, resumed } of toPost.slice(0, CARD_RATE_CEILING)) {
        // HISTORY IS WRITTEN AFTER A VALIDATED POST, and only then.
        //
        // Writing it first (the previous shape) marked items `everCarded` for
        // attempts that never reached Chat, so the never-carded-first ordering
        // DEPRIORITISED work nobody had actually been asked about — the exact
        // starvation the ordering exists to prevent. The post is now only a
        // success when it returns both bridge identities, so "carded" means
        // "there is a real thread to reply in".
        const result = await postOwnerCard(webhookUrl, card);
        if (!result) {
            // Left UNPOSTED on purpose, and the claim is RELEASED so the 2-hour
            // retry pass can take it immediately rather than waiting out a lease.
            await prisma.receiptRequestCard.updateMany({
                where: { id: rowId, claimToken: token },
                data: { attempts: { increment: 1 }, lastError: "post-failed", claimedAt: null, claimToken: null },
            });
            failures.push(card.owner);
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
        ok: failures.length === 0,
        failedOwners: failures,
        date,
        retryOnly,
        scanned: scan.candidates.length,
        scanPages: scan.pages,
        scanExhausted: scan.exhausted,
        claimed: toPost.length,
        posted,
    };
    if (failures.length > 0) {
        console.error("[cron/receipt-request-cards] delivery failed", JSON.stringify(summary));
    } else if (toPost.length > 0) {
        console.log("[cron/receipt-request-cards]", JSON.stringify(summary));
    }
    return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
