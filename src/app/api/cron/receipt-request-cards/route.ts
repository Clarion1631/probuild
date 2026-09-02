import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { decodeReasonCodes } from "@/lib/review-alert-reasons";
import { RECEIPT_REQUEST_TARGET_TYPE, effectiveOwner, hasResolution } from "@/lib/receipt-requests";
import {
    CARD_OWNERS_ASKED,
    CARD_RATE_CEILING,
    buildCardFromItems,
    isPacificWeekday,
    pacificDate,
    postOwnerCard,
    requestIdFor,
    rebuildCardItems,
    selectOwnerItems,
    type CardCandidateIssue,
    type CardItem,
    type CardItemTruth,
    type OwnerCard,
} from "@/lib/receipt-request-cards";
import { SWEEP_MARKER_KEY, chaserCompletedFor, parseSweepMarker } from "@/lib/receipt-sweep-marker";
import { parseMissingReceiptDetails } from "@/app/automation/receipts-data";
import { itemsMissingCardRecord, recordCardOnIssues } from "@/lib/receipt-card-history";

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
/**
 * How far back the history repair looks, and how many cards it fixes per run.
 * Small on purpose: it is catch-up work riding a cron that has a card to send.
 */
const HISTORY_REPAIR_DAYS = 3;
const HISTORY_REPAIR_MAX_CARDS = 20;

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

/**
 * Current truth for the issues in a claimed snapshot, read in ONE query right
 * before the send. The shape is exactly what `rebuildCardItems` needs, so the
 * decision itself stays pure and testable.
 */
async function loadCardItemTruth(issueIds: string[]): Promise<Map<string, CardItemTruth>> {
    if (issueIds.length === 0) return new Map();
    const rows = await prisma.reviewIssue.findMany({
        where: { id: { in: issueIds } },
        select: { id: true, clearedAt: true, reasonCodes: true, acknowledgedCodes: true, displayDetails: true },
    });
    const truth = new Map<string, CardItemTruth>();
    for (const row of rows) {
        const details = parseMissingReceiptDetails(row.displayDetails);
        const currentCodes = decodeReasonCodes(row.reasonCodes);
        const acked = new Set(decodeReasonCodes(row.acknowledgedCodes));
        truth.set(row.id, {
            clearedAt: row.clearedAt,
            acknowledged: currentCodes.length > 0 && currentCodes.every(code => acked.has(code)),
            resolved: hasResolution(details),
            owner: effectiveOwner(details),
        });
    }
    // Ids with no row are simply absent — rebuildCardItems drops them as
    // `missing`, which is the right answer for an issue that was deleted.
    return truth;
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

    /**
     * NO SELECTION UNTIL TONIGHT'S CHASE HAS FINISHED.
     *
     * The card is built from open ReviewIssues, and those are whatever the
     * nightly sweep last left behind. Mid-cycle — budget-truncated, or stopped
     * on an error — that open set is a half-reconciled world: items already
     * answered are not closed yet, and items that should have opened have not.
     * A card built from it asks people for receipts they already sent AND
     * misses the ones they did not, on the same morning.
     *
     * And getting it wrong costs the whole day: selection claims the owner's
     * (owner, pacificDate) slot, so the bad card is the only card that owner
     * gets. So this refuses to select, says so, and consumes NOTHING — the
     * later `?retry=1` pass (or tomorrow) will find the slot free.
     *
     * The retry pass is exempt: it never selects, it only re-posts a snapshot
     * an earlier run already claimed while the chase WAS complete.
     */
    if (!retryOnly) {
        const marker = parseSweepMarker(
            (await prisma.automationSetting.findUnique({ where: { key: SWEEP_MARKER_KEY } }))?.value,
        );
        if (!chaserCompletedFor(marker, date)) {
            const summary = {
                ok: false,
                skipped: "chaser-incomplete",
                date,
                phase: marker.phase,
                chaserCompletedAt: marker.chaserCompletedAt,
            };
            console.error("[cron/receipt-request-cards] refusing to select — tonight's chase has not completed", JSON.stringify(summary));
            // 200: nothing failed here, and a retry of THIS invocation would
            // not help. The ok:false is what makes it visible.
            return NextResponse.json(summary, { status: 200 });
        }
    }
    const yesterday = new Date(now.getTime() - 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    // The retry pass posts from the claimed snapshot, so it needs no scan.
    const scan = retryOnly
        ? { candidates: [] as CardCandidateIssue[], pages: 0, exhausted: true }
        : await scanCandidates();
    const toPost: Array<{ card: OwnerCard; rowId: string; token: string; resumed: boolean }> = [];
    // Sent, but we never confirmed it. Reported, never reposted.
    const uncertain: string[] = [];
    // The subset THIS RUN moved into UNCERTAIN. Distinct from `uncertain`,
    // which also lists rows an earlier run left that way: re-reporting an old
    // one must not make every subsequent run look partial, and a NEW one must
    // not be lost in the noise of the old ones.
    const uncertainTransitions: string[] = [];
    // A healthy run is mid-send on this owner's card. Left strictly alone.
    const inFlight: string[] = [];

    for (const owner of CARD_OWNERS_ASKED) {
        const existing = await prisma.receiptRequestCard.findUnique({
            where: { owner_pacificDate: { owner, pacificDate: date } },
            select: { id: true, itemsJson: true, overflow: true, overflowExact: true, postedAt: true, status: true, claimedAt: true },
        });

        if (existing) {
            // Already asked today — nothing to do, whoever posted it.
            if (existing.postedAt !== null) continue;
            // POSTING means SOMEONE called the webhook. Whether that someone is
            // still going is the whole question, and the claim lease answers it.
            if (existing.status === "POSTING") {
                const claimLive = existing.claimedAt !== null
                    && existing.claimedAt.getTime() > now.getTime() - CLAIM_LEASE_MS;
                if (claimLive) {
                    // A run is IN FLIGHT right now, between its POSTING write
                    // and its response. Converting it to UNCERTAIN here would
                    // pull the row out from under a healthy run and lose the
                    // thread ids it is about to write. Leave it alone.
                    inFlight.push(owner);
                    continue;
                }
                // The lease expired: that run died mid-send and nobody will
                // ever tell us whether Chat took the message. Uncertain, and
                // never resent.
                const converted = await prisma.receiptRequestCard.updateMany({
                    where: { id: existing.id, status: "POSTING" },
                    data: { status: "UNCERTAIN", lastError: "uncertain-delivery", claimedAt: null, claimToken: null },
                });
                if (converted.count > 0) uncertainTransitions.push(owner);
                uncertain.push(owner);
                continue;
            }
            if (existing.status === "UNCERTAIN") { uncertain.push(owner); continue; }

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
            // THE ROW'S OWN overflowExact, not this run's scan flag. A retry
            // pass does not scan at all, so `scan.exhausted` is trivially true
            // there — and a card claimed by a run whose scan stopped early
            // would come back claiming its "and N more" was a total.
            toPost.push({ card: buildCardFromItems(owner, date, items, existing.overflow, existing.overflowExact), rowId: existing.id, token, resumed: true });
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
                    // Persisted WITH the selection, because only this run knows
                    // whether its scan finished.
                    overflowExact: scan.exhausted,
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
    // Rows whose every item was answered between selection and the send. The
    // row is REMOVED rather than marked, so the owner's day is not consumed:
    // the unique key is (owner, pacificDate), and a row left behind would block
    // a card for genuinely new items later the same day.
    const cancelled: string[] = [];
    const dropped: Array<{ owner: string; issueId: string; reason: string }> = [];
    // A webhook IS configured and a delivery still failed. That is an outage,
    // not a quiet day: a 200 here meant nobody was ever told the crew's card
    // did not go out.
    const failures: string[] = [];
    for (const { card: claimedCard, rowId, token, resumed } of toPost.slice(0, CARD_RATE_CEILING)) {
        // RE-VERIFY UNDER THE CLAIM, IMMEDIATELY BEFORE THE SEND.
        //
        // The snapshot was chosen at the top of the run — or, on a retry pass,
        // hours ago. The sweep closing an item, a human acknowledging it, a
        // signed memo arriving, or Marge reassigning it all happen in that
        // window, and the card went out regardless. Asking somebody for a
        // receipt they already sent is how the list becomes noise.
        const truth = await loadCardItemTruth(claimedCard.items.map(item => item.issueId));
        const rebuilt = rebuildCardItems(claimedCard.items, truth, claimedCard.owner);
        for (const drop of rebuilt.dropped) dropped.push({ owner: claimedCard.owner, ...drop });

        if (rebuilt.items.length === 0) {
            // Nothing left to ask about. Delete the row rather than posting an
            // empty card or parking a status: a row that survives holds this
            // owner's (owner, pacificDate) slot, so a genuinely new item found
            // later today would have no card to go on.
            await prisma.receiptRequestCard.deleteMany({
                where: { id: rowId, claimToken: token, postedAt: null },
            });
            cancelled.push(claimedCard.owner);
            continue;
        }

        const card = rebuilt.dropped.length === 0
            ? claimedCard
            : buildCardFromItems(claimedCard.owner, date, rebuilt.items, claimedCard.overflow, claimedCard.overflowExact);

        // HISTORY IS WRITTEN AFTER A VALIDATED POST, and only then.
        //
        // Writing it first (the previous shape) marked items `everCarded` for
        // attempts that never reached Chat, so the never-carded-first ordering
        // DEPRIORITISED work nobody had actually been asked about — the exact
        // starvation the ordering exists to prevent. The post is now only a
        // success when it returns both bridge identities, so "carded" means
        // "there is a real thread to reply in".
        // POSTING, BEFORE the call. This is the whole point of the state: a
        // crash after this write and before the response is distinguishable
        // from a crash before it, so the next run knows not to repost.
        const marked = await prisma.receiptRequestCard.updateMany({
            where: { id: rowId, claimToken: token, status: { in: ["PENDING", "POSTED"] } },
            // The snapshot is rewritten to WHAT IS ABOUT TO GO OUT. The row is
            // the record of the card that was posted; leaving the pre-rebuild
            // list on it would make a resumed run re-post items this one
            // deliberately dropped.
            data: { status: "POSTING", itemsJson: JSON.stringify(card.items) },
        });
        if (marked.count === 0) {
            // Someone else owns it now; do not send.
            continue;
        }

        const result = await postOwnerCard(webhookUrl, card);

        if (result.kind === "rejected") {
            // Chat provably did NOT take it: nothing is in the space. Back to
            // PENDING with the claim released, so the retry pass can send it.
            await prisma.receiptRequestCard.updateMany({
                where: { id: rowId, claimToken: token },
                data: {
                    status: "PENDING",
                    attempts: { increment: 1 },
                    lastError: `rejected:${result.reason}`,
                    claimedAt: null,
                    claimToken: null,
                },
            });
            failures.push(card.owner);
            continue;
        }

        if (result.kind === "unknown") {
            // A timeout, a 5xx, or a 2xx with no message name. The card may be
            // sitting in the crew's space right now, so it is NEVER auto-retried
            // — a duplicate chase card teaches people the list is noise. It is
            // recorded as uncertain for a human to glance at.
            await prisma.receiptRequestCard.updateMany({
                where: { id: rowId, claimToken: token },
                data: {
                    status: "UNCERTAIN",
                    attempts: { increment: 1 },
                    lastError: `uncertain:${result.reason}`,
                    claimedAt: null,
                    claimToken: null,
                },
            });
            uncertain.push(card.owner);
            uncertainTransitions.push(card.owner);
            continue;
        }

        // DELIVERED. Completion is token-fenced AND status-fenced, so a
        // superseded run cannot mark a row posted that it did not post. If this
        // write does not land the card IS out and we have no record of it, so a
        // zero count is uncertain — never a silent success, never a repost.
        //
        // THE HISTORY RIDES WITH IT. A row marked POSTED whose items carry no
        // thread record is a card nobody can answer: a reply in that thread has
        // nothing to resolve against, and the items still read as never-carded
        // so tomorrow asks again. Committing one without the other is the
        // failure, so they commit together or not at all — a lost CAS throws
        // (`CardHistoryRaceError`) and takes the POSTED write back with it,
        // leaving the row in POSTING for the next run to reconcile.
        const completed = await prisma.$transaction(async tx => {
            const written = await tx.receiptRequestCard.updateMany({
                where: { id: rowId, claimToken: token, status: "POSTING" },
                data: {
                    status: "POSTED",
                    postedAt: new Date(),
                    threadName: result.threadName,
                    messageName: result.messageName,
                    attempts: { increment: 1 },
                    lastError: null,
                },
            });
            if (written.count === 1) {
                await recordCardOnIssues(card, result.threadName, result.messageName, now, tx);
            }
            return written;
        });
        if (completed.count === 0) {
            await prisma.receiptRequestCard.updateMany({
                where: { id: rowId },
                data: { status: "UNCERTAIN", lastError: "uncertain-delivery" },
            }).catch(() => { /* the row is already beyond us */ });
            uncertain.push(card.owner);
            uncertainTransitions.push(card.owner);
            continue;
        }
        posted.push({ owner: card.owner, items: card.items.length, threadName: result.threadName, resumed });
    }

    /**
     * THE REPAIR PASS. Cards that went out but whose items never got their
     * thread record.
     *
     * Everything above makes that pair atomic from here on, but rows written
     * before it — or by a run that died between the two writes — are already on
     * the books, and nothing else would ever fix them: the card is POSTED, so
     * no run will repost it, and the items read as never-carded forever, so
     * every following morning asks about them again.
     *
     * Bounded and cheap: the last few days only, a handful of cards, and it
     * writes NOTHING when the record is already there.
     */
    const repaired: Array<{ owner: string; date: string; items: number }> = [];
    const repairSince = new Date(now.getTime() - HISTORY_REPAIR_DAYS * 86_400_000)
        .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    try {
        const postedRows = await prisma.receiptRequestCard.findMany({
            where: {
                status: "POSTED",
                pacificDate: { gte: repairSince },
                threadName: { not: null },
                messageName: { not: null },
            },
            orderBy: [{ pacificDate: "desc" }, { owner: "asc" }],
            take: HISTORY_REPAIR_MAX_CARDS,
            select: { owner: true, pacificDate: true, itemsJson: true, threadName: true, messageName: true },
        });
        for (const row of postedRows) {
            const items = parseItems(row.itemsJson);
            if (items.length === 0) continue;
            const requestId = requestIdFor(row.owner, row.pacificDate);
            const missing = await itemsMissingCardRecord(items.map(item => item.issueId), requestId);
            if (missing.length === 0) continue;
            const gaps = items.filter(item => missing.includes(item.issueId));
            // "report", not "throw": there is no delivery to roll back here, and
            // one contended issue must not abandon the rest of the repair.
            await recordCardOnIssues(
                { items: gaps, date: row.pacificDate, requestId },
                row.threadName as string,
                row.messageName as string,
                now,
                prisma,
                "report",
            );
            repaired.push({ owner: row.owner, date: row.pacificDate, items: gaps.length });
        }
    } catch (error) {
        // Never fails the run: the repair is catch-up work, and the cards this
        // invocation actually sent are already committed.
        console.error("[cron/receipt-request-cards] history repair failed", error instanceof Error ? error.message : "UnknownError");
    }

    const summary = {
        // A card whose delivery we could not confirm is NOT a success. It is
        // also not a failure we can retry — resending risks a duplicate chase
        // card, which teaches people the list is noise. So the run is PARTIAL:
        // ok:false so it is visible, HTTP 200 so the platform does not treat it
        // as a crashed invocation and re-run it.
        ok: failures.length === 0 && uncertainTransitions.length === 0,
        partial: failures.length === 0 && uncertainTransitions.length > 0,
        failedOwners: failures,
        uncertainOwners: uncertain,
        // Only what THIS run moved. An old uncertain row is somebody's to
        // resolve on the Receipts tab, not a reason to fail every later run.
        uncertainTransitions,
        inFlightOwners: inFlight,
        date,
        retryOnly,
        scanned: scan.candidates.length,
        scanPages: scan.pages,
        scanExhausted: scan.exhausted,
        claimed: toPost.length,
        // Rows whose whole snapshot was answered between selection and the
        // send. Not a failure — the opposite — but worth seeing.
        cancelledOwners: cancelled,
        droppedItems: dropped,
        repairedHistory: repaired,
        posted,
    };
    if (failures.length > 0) {
        console.error("[cron/receipt-request-cards] delivery failed", JSON.stringify(summary));
    } else if (uncertainTransitions.length > 0) {
        console.error("[cron/receipt-request-cards] delivery unconfirmed", JSON.stringify(summary));
    } else if (toPost.length > 0) {
        console.log("[cron/receipt-request-cards]", JSON.stringify(summary));
    }
    // 500 ONLY for a refused delivery, which is worth retrying. An unconfirmed
    // one is 200: it needs a human, not another attempt.
    return NextResponse.json(summary, { status: failures.length > 0 ? 500 : 200 });
}
