import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { decodeReasonCodes, type ReasonCode } from "@/lib/review-alert-reasons";
import { RECEIPT_REQUEST_TARGET_TYPE, effectiveOwner, hasBackedResolution, isComponentDeadlineExceeded } from "@/lib/receipt-requests";
import {
    CARD_OWNERS_ASKED,
    CARD_POST_TIMEOUT_MS,
    CARD_RATE_CEILING,
    CARD_RESEND_QUEUED_REASON,
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
// Reused rather than re-implemented (Codex PR #443 gate, finding 1) — see its
// doc comment for why the safe-direction bias that governs an OCC retry is
// exactly the bias this re-verification wants too.
import { recomputeCodesFor } from "@/app/api/cron/receipt-requests/route";

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

/**
 * Where the candidate scan's resume point lives (AutomationSetting is a KV
 * table, same store the sweep's own cursors use).
 *
 * WHY IT HAS TO BE DURABLE (Codex PR #443 gate round 35, finding 2). The scan
 * reads oldest-first and cannot filter by owner in SQL — `owner` lives inside
 * `displayDetails`, a TEXT column holding JSON. The page cap and the wall clock
 * both stop it part way, and starting from scratch every invocation means a
 * long prefix of `office`/`unassigned` issues (which nobody is ever asked
 * about, and which are also the oldest) is re-read on every run and the tail is
 * never reached. An owner whose only open items live behind that prefix would
 * never appear on a card at all — the exact starvation the paging scan was
 * introduced to fix, reintroduced by the time-based safety valve.
 */
const SCAN_CURSOR_KEY = "receiptRequestCardsScanCursor";

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
/**
 * How many queued resends one run drains (round-40 gate, finding 2). Small on
 * purpose: today's cards and the send budget come first, and a backlog this
 * size means somebody should be looking at it anyway — pipeline-health says so.
 */
const QUEUED_RESEND_DRAIN_LIMIT = 3;

const CLAIM_LEASE_MS = 10 * 60_000;

/**
 * The pre-send REVALIDATION budget (Codex PR #443 gate, finding 3), measured
 * from the top of this invocation. `loadCardItemTruth` calls `recomputeCodesFor`
 * per item, and each miss walks a whole competing component (up to
 * `MAX_COMPONENT_LINES` expansions) plus its own evidence queries — a backlog
 * of several owners' cards, each spanning a few components, can chain past the
 * cron's `maxDuration = 60` ceiling.
 *
 * Once this much of the run is spent, remaining items are treated as NOT
 * sendable this run rather than risking a mid-write kill: the same
 * safe-direction bias `recomputeCodesFor`'s own doc comment describes — erring
 * toward not sending a chase that might already be answered beats a card that
 * never finishes going out at all. Left with headroom under 60s for the scan,
 * selection, and the webhook posts themselves, which this budget does not cover.
 */
const REVALIDATION_DEADLINE_MS = 45_000;

/** How much of the revalidation budget is left, measured from `startedAt`. */
function remainingRevalidationBudgetMs(startedAt: number): number {
    return REVALIDATION_DEADLINE_MS - (Date.now() - startedAt);
}

/**
 * THE INVOCATION'S HARD WALL. `maxDuration` is 60s; stopping at 55 leaves room
 * to serialise a summary instead of being killed with the answer unwritten.
 *
 * Wider than `REVALIDATION_DEADLINE_MS` on purpose: that budget bounds the
 * re-verification QUERIES, which are optional work that degrades safely (an
 * unverified item is simply not sent). This one bounds the SEND, which does not
 * degrade safely at all.
 */
const RUN_DEADLINE_MS = 55_000;

/**
 * What still has to happen after the webhook answers: the POSTED write, the
 * thread/message ids, and `recordCardOnIssues` for every item — one interactive
 * transaction, all of it after the network call returns.
 */
const SEND_COMPLETION_MARGIN_MS = 4_000;

/**
 * WHAT ENTERING `POSTING` COSTS, WORST CASE (Codex PR #443 gate round 35,
 * finding 3).
 *
 * The 45-second budget bounded the revalidation and nothing else. The send
 * phase then flipped a row to POSTING and called Chat, which starts a FRESH
 * 10-second timeout of its own, and the completion writes followed that. A run
 * that reached the send phase near its wall clock was killed between the
 * POSTING write and the response — and a row stranded in POSTING is converted
 * to UNCERTAIN by the next run, which is the one state that is never resent.
 * So a card nobody had ever sent became a card nobody would ever send.
 *
 * A run refuses to enter POSTING without this much budget left. The cost of
 * refusing is a card that goes out on the 16:30 retry pass instead of at 07:30;
 * the cost of not refusing is a chase that silently disappears.
 */
const SEND_HEADROOM_MS = CARD_POST_TIMEOUT_MS + SEND_COMPLETION_MARGIN_MS;

/** How much of the invocation's wall clock is left, measured from `startedAt`. */
function remainingRunBudgetMs(startedAt: number): number {
    return RUN_DEADLINE_MS - (Date.now() - startedAt);
}

/** The resume point for the candidate scan. Absent or empty means "from the top". */
async function readScanCursor(): Promise<string | null> {
    try {
        const row = await prisma.automationSetting.findUnique({ where: { key: SCAN_CURSOR_KEY } });
        return row?.value ? row.value : null;
    } catch {
        // A cursor we cannot read is "start from the top" — the pre-existing
        // behaviour, which is correct but slow, never a guess at a position.
        return null;
    }
}

/**
 * Persist where the scan stopped. Reports failure rather than throwing: a
 * cron that has a card ready must still send it, and the cost of a lost
 * checkpoint is one repeated prefix, not a wrong card. The summary says so, so
 * a cursor that never advances is visible instead of looking like a quiet queue.
 */
async function writeScanCursor(value: string | null): Promise<boolean> {
    try {
        await prisma.automationSetting.upsert({
            where: { key: SCAN_CURSOR_KEY },
            update: { value: value ?? "" },
            create: { key: SCAN_CURSOR_KEY, value: value ?? "" },
        });
        return true;
    } catch (error) {
        console.error("[cron/receipt-request-cards] scan cursor write failed", error instanceof Error ? error.message : "UnknownError");
        return false;
    }
}

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
 *
 * BOUNDED IN TIME AS WELL AS IN PAGES (Codex PR #443 gate round 34, finding 3).
 * `SCAN_MAX_PAGES` caps how many queries the scan may run; it says nothing about
 * how long they take, and this runs before the revalidation and the webhook
 * posts that still have to fit inside `maxDuration`. Stopping on the clock is
 * the same answer stopping on the page cap already gives — `exhausted: false`,
 * so `overflowExact` is false and the card prints no "and N more" it cannot
 * stand behind — rather than a killed invocation that claims nothing at all.
 *
 * AND IT RESUMES WHERE THE LAST RUN STOPPED (Codex PR #443 gate round 35,
 * finding 2). Both stops above — the page cap and the clock — used to leave
 * nothing behind, so every invocation re-read the same oldest prefix. That
 * prefix is mostly `office` and `unassigned` items, which are never asked
 * about, so an owner whose open items sit past it could be starved forever
 * while every run reported a healthy scan. Filtering by owner in SQL is still
 * unavailable for the reason above, so instead the scan carries a durable
 * position: it resumes after `startCursor`, and once it reaches the end of the
 * queue it WRAPS to the top and keeps going until it meets its own start again.
 * `exhausted` stays true only for a genuinely complete pass, so the card's "and
 * N more" is still only printed when it is a real total.
 *
 * EXPORTED for the same reason `loadCardItemTruth` is: the run's own clock is a
 * 45-second budget with no injection seam at the route boundary, so the only way
 * to prove the scan STOPS on it — rather than to assert that the source contains
 * a check — is to call it with a deadline of the test's own.
 */
export async function scanCandidates(
    deadlineExceeded: () => boolean = () => false,
    startCursor: string | null = null,
): Promise<{
    candidates: CardCandidateIssue[];
    pages: number;
    exhausted: boolean;
    deadlineHit: boolean;
    /** Where the NEXT run should resume, or null to start from the top. */
    nextCursor: string | null;
    /** Whether this pass ran off the end of the queue and restarted at the top. */
    wrapped: boolean;
}> {
    const candidates: CardCandidateIssue[] = [];
    // Wrapping re-reads rows this pass already saw. Deduped by id, because the
    // overflow count the card prints is a count of DISTINCT open items.
    const seen = new Set<string>();
    let cursor: string | undefined = startCursor ?? undefined;
    let pages = 0;
    let exhausted = false;
    let deadlineHit = false;
    let wrapped = false;
    // Carried forward when this pass stops early. Starts at the inherited
    // position so a run that reads nothing at all does not rewind the queue.
    let nextCursor: string | null = startCursor;

    while (pages < SCAN_MAX_PAGES) {
        if (deadlineExceeded()) { deadlineHit = true; break; }
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
        if (page.length > 0) nextCursor = page[page.length - 1].id;

        for (const row of page) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            const candidate = toCandidate(row);
            if (!CARD_OWNERS_ASKED.includes(candidate.owner as never)) continue;
            if (candidate.acknowledged) continue;
            candidates.push(candidate);
        }

        // BACK AT OUR OWN STARTING POINT: the wrap has covered the prefix this
        // pass originally skipped, so the queue has been read end to end.
        if (wrapped && startCursor !== null && page.some(row => row.id === startCursor)) {
            exhausted = true;
            nextCursor = null;
            break;
        }
        if (page.length < SCAN_PAGE_SIZE) {
            if (startCursor === null || wrapped) {
                // Read from the top through to the end: a genuinely complete
                // pass, so the next run may start fresh.
                exhausted = true;
                nextCursor = null;
                break;
            }
            // The tail is done but the prefix we resumed past has not been read
            // this pass. Restart at the top rather than declaring a total we
            // never counted.
            wrapped = true;
            cursor = undefined;
            continue;
        }
        cursor = page[page.length - 1].id;
        // RUNS TO EXHAUSTION. It used to stop as soon as each owner had a full
        // card, which was enough to CHOOSE the items but not to COUNT the rest
        // — so "and 4 more" was whatever the scan happened to have seen, which
        // is a number that looks authoritative and isn't. The queue is small
        // (page size 500) and this is one cheap indexed read per page; when the
        // page cap does bite, `exhausted` stays false and the card drops the
        // number rather than printing a guess.
    }

    return { candidates, pages, exhausted, deadlineHit, nextCursor, wrapped };
}

/**
 * Current truth for the issues in a claimed snapshot, read right before the
 * send. The shape is exactly what `rebuildCardItems` needs, so the decision
 * itself stays pure and testable.
 *
 * `deps.cache` and `deps.recompute` are DI seams (Codex PR #443 gate, finding
 * 3): a component walk populates every member of the competing set at once, so
 * the cache turns the rest of ONE card's items into map reads, and tests can
 * substitute a counting fake for `recomputeCodesFor` without a database.
 *
 * SCOPED TO A SINGLE CARD'S PRE-SEND VALIDATION, not to the run (round-37 gate,
 * finding 4). A cache spanning owners hands owner B a verdict computed before
 * owner A's card was posted, and evidence that arrives in between — a receipt
 * booked, a memo signed — then reaches nobody: B is chased for a charge that is
 * already answered. `deps.deadlineExceeded` is checked before each real recompute —
 * once the run's revalidation budget is gone, remaining items are marked
 * `revalidationSkipped` rather than spending a query that might not finish.
 */
export async function loadCardItemTruth(
    issueIds: string[],
    deps: {
        cache?: Map<string, ReasonCode[]>;
        recompute?: (
            targetKey: string,
            cache?: Map<string, ReasonCode[]>,
            deadlineExceeded?: () => boolean,
        ) => Promise<ReasonCode[]>;
        deadlineExceeded?: () => boolean;
    } = {},
): Promise<Map<string, CardItemTruth>> {
    if (issueIds.length === 0) return new Map();
    const cache = deps.cache ?? new Map<string, ReasonCode[]>();
    const recompute = deps.recompute ?? recomputeCodesFor;
    const deadlineExceeded = deps.deadlineExceeded ?? (() => false);
    const rows = await prisma.reviewIssue.findMany({
        where: { id: { in: issueIds } },
        select: { id: true, targetKey: true, clearedAt: true, reasonCodes: true, acknowledgedCodes: true, displayDetails: true },
    });
    /**
     * THE MEMO BINDINGS FOR THESE ITEMS, IN ONE READ (Codex PR #443 gate round
     * 40, finding 3).
     *
     * The check below used to be `hasResolution`, which is true for a
     * `memo-signed` blob with no `ReceiptMemoArtifact` of its own — the losing
     * side of a duplicated pdfId, or a row an older build wrote. That skipped
     * the artifact-backed recompute entirely, so the item was dropped from the
     * card and the charge was never chased again: the same fail-open the
     * matcher closed in round 36, one layer further out. One query per card,
     * bounded by the items on it.
     */
    const boundPdfIds = new Map(
        (await prisma.receiptMemoArtifact.findMany({
            where: {
                targetType: RECEIPT_REQUEST_TARGET_TYPE,
                targetKey: { in: rows.map(row => row.targetKey) },
            },
            select: { targetKey: true, pdfId: true },
        })).map(row => [row.targetKey, row.pdfId]),
    );
    const truth = new Map<string, CardItemTruth>();
    for (const row of rows) {
        const details = parseMissingReceiptDetails(row.displayDetails);
        const currentCodes = decodeReasonCodes(row.reasonCodes);
        const acked = new Set(decodeReasonCodes(row.acknowledgedCodes));
        const clearedAt = row.clearedAt;
        // ARTIFACT-BACKED, like the matcher (round-40 gate, finding 3). The
        // cheap check was NOT enough: it suppressed the recompute below for a
        // `memo-signed` blob nothing could vouch for, so the item silently left
        // the card instead of being re-verified — the comment that used to sit
        // here claimed the recompute would catch it, and the recompute is
        // exactly what it skipped.
        const resolved = hasBackedResolution(details, boundPdfIds.get(row.targetKey) ?? null);
        const acknowledged = currentCodes.length > 0 && currentCodes.every(code => acked.has(code));
        /**
         * RE-VERIFY AGAINST RECEIPT EVIDENCE, not just this issue's own
         * clearedAt — the ReviewIssue-only checks above answer "did the
         * NIGHTLY sweep already close this", which is a stale question for a
         * receipt that landed since. `recomputeCodesFor` does the same real
         * evidence match the sweep itself uses (Expense.hasReceipt, a booked
         * ReceiptIntake, or a signed memo), scoped to this one line.
         *
         * Only spent on an item that would otherwise be SENT: it does real
         * queries (component load + evidence), and one already dead for a
         * cheaper reason (cleared/resolved/acknowledged) skips it for free.
         */
        const needsRecompute = clearedAt === null && !resolved && !acknowledged;
        let evidenceSatisfied = false;
        let revalidationSkipped = false;
        if (needsRecompute) {
            if (deadlineExceeded()) {
                // ERR TOWARD NOT SENDING. The budget for real re-verification
                // is gone; sending this item unverified risks nagging someone
                // for a receipt that already landed, which is the one failure
                // mode this whole re-check exists to prevent.
                revalidationSkipped = true;
            } else {
                /**
                 * THE DEADLINE GOES IN, NOT JUST ROUND THE OUTSIDE (Codex PR
                 * #443 gate round 34, finding 3).
                 *
                 * The check above only decides whether to START a recompute.
                 * One recompute is a multi-pass component walk plus a 60-day
                 * evidence load, each a real round trip — so a single slow
                 * component begun with a second of budget left could run the
                 * whole invocation past `maxDuration` and be KILLED, losing
                 * the claim bookkeeping along with the answer. Handing the
                 * same clock down lets it stop between queries instead, and
                 * the abort lands in exactly the state the pre-call check
                 * produces: not verified, therefore not sent this run.
                 */
                try {
                    evidenceSatisfied = (await recompute(row.targetKey, cache, deadlineExceeded)).length === 0;
                } catch (error) {
                    if (!isComponentDeadlineExceeded(error)) throw error;
                    revalidationSkipped = true;
                }
            }
        }
        truth.set(row.id, {
            clearedAt,
            acknowledged,
            resolved,
            evidenceSatisfied,
            owner: effectiveOwner(details),
            ...(revalidationSkipped ? { revalidationSkipped: true } : {}),
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
    // The revalidation budget's own clock — see REVALIDATION_DEADLINE_MS.
    const runStartedAt = Date.now();
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
    const marker = parseSweepMarker(
        (await prisma.automationSetting.findUnique({ where: { key: SWEEP_MARKER_KEY } }))?.value,
    );
    /**
     * SELECTION needs tonight's chase to have finished. POSTING an
     * already-claimed card does not — that snapshot was chosen when the chase
     * WAS complete, and re-posting it is the retry pass's whole job.
     */
    const selectionAllowed = chaserCompletedFor(marker, date);
    if (!retryOnly) {
        if (!selectionAllowed) {
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
    // SCANNED WHENEVER SELECTION IS ALLOWED, in either mode. A retry pass that
    // may now select (the chase finished after the morning run bailed) needs
    // candidates to select FROM — without this it would take the new branch
    // below and find an empty list, which is the same lost day wearing a
    // different hat. A retry that may not select still needs no scan: it only
    // re-posts what an earlier run claimed.
    const scanResumedFrom = selectionAllowed ? await readScanCursor() : null;
    const scan = selectionAllowed
        ? await scanCandidates(() => remainingRevalidationBudgetMs(runStartedAt) <= 0, scanResumedFrom)
        : { candidates: [] as CardCandidateIssue[], pages: 0, exhausted: true, deadlineHit: false, nextCursor: null, wrapped: false };
    // CHECKPOINTED IMMEDIATELY, before selection or any send. The whole value of
    // the cursor is that a run which spends its budget scanning still leaves the
    // next one further along; writing it after the send phase would lose it on
    // exactly the runs that needed it most.
    const scanCursorPersisted = selectionAllowed ? await writeScanCursor(scan.nextCursor) : true;
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
    // A claimed row whose itemsJson parsed to nothing (bad JSON, or an empty
    // array). Left in place it would sit forever: the unique (owner,
    // pacificDate) key blocks any replacement, so every later run today
    // would re-claim the same dead row and fail the same way.
    const invalidRows: string[] = [];

    /**
     * QUEUED RESENDS FIRST, WHATEVER DATE THEY ARE FOR (Codex PR #443 gate
     * round 40, finding 2).
     *
     * An operator who answers "resend" puts an UNCERTAIN row back to PENDING.
     * Every claim below is keyed on TODAY'S (owner, pacificDate), so a resend
     * requested after the day's last retry slot was never claimed again — the
     * row sat PENDING for ever, and tomorrow's card, built for a different
     * date, re-asked the same items from scratch as if nobody had decided
     * anything.
     *
     * So a queued row is drained on its own terms: oldest first, its OWN date
     * and items (the thread key is derived from owner + that date, so the card
     * lands in the thread the operator was looking at), and bounded per run so
     * a backlog cannot crowd out today's cards or the send budget.
     */
    const queuedDrained: string[] = [];
    /**
     * A DRAINED RESEND CONSUMES THAT OWNER'S SEND FOR THE DAY (Codex PR #443
     * gate round 41, finding 1).
     *
     * The queued row and today's selection are drawn from the SAME open issues
     * — a chase does not leave `scan.candidates` because a card for it is
     * waiting to go out — so posting both asks the same person for the same
     * receipts twice in one morning, which is exactly the noise the whole
     * per-owner-per-day claim exists to prevent.
     *
     * Skipping the owner (rather than subtracting the resend's items from the
     * scan) is the choice, because the resend IS that owner's card: it carries
     * the operator's decision, its items are the ones they were looking at, and
     * anything genuinely new is on tomorrow's card — one day late, in exchange
     * for never double-asking. Recorded so the run says which owners were
     * consumed this way.
     */
    const drainedOwners = new Set<string>();
    const queued = await prisma.receiptRequestCard.findMany({
        where: {
            status: "PENDING",
            postedAt: null,
            // THE COLUMN, not the diagnostic text (round-41 gate, finding 3):
            // a rejection overwrites `lastError` and used to make the row
            // invisible to this query for ever.
            resendQueuedAt: { not: null },
            pacificDate: { lt: date },
        },
        orderBy: [{ resendQueuedAt: "asc" }, { pacificDate: "asc" }, { owner: "asc" }],
        take: QUEUED_RESEND_DRAIN_LIMIT,
        select: { id: true, owner: true, pacificDate: true, itemsJson: true, overflow: true, overflowExact: true },
    });
    for (const row of queued) {
        const token = randomUUID();
        const taken = await prisma.receiptRequestCard.updateMany({
            where: {
                id: row.id,
                postedAt: null,
                status: "PENDING",
                OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }],
            },
            data: { claimedAt: now, claimToken: token },
        });
        if (taken.count === 0) continue;
        const items = parseItems(row.itemsJson);
        if (items.length === 0) {
            // Same reasoning as today's unusable row: delete it rather than
            // leave a dead claim that every future run re-takes.
            await prisma.receiptRequestCard.deleteMany({ where: { id: row.id, claimToken: token, postedAt: null } });
            invalidRows.push(row.owner);
            continue;
        }
        // ITS OWN DATE, not today's: the request id — and therefore the Chat
        // thread — belongs to the day the card was selected for.
        toPost.push({
            card: buildCardFromItems(row.owner, row.pacificDate, items, row.overflow, row.overflowExact),
            rowId: row.id,
            token,
            resumed: true,
        });
        queuedDrained.push(`${row.owner}:${row.pacificDate}`);
        drainedOwners.add(row.owner);
    }

    for (const owner of CARD_OWNERS_ASKED) {
        // Their card is already going out today — the queued one. Selecting a
        // second from the same open issues would ask twice (round-41 gate,
        // finding 1).
        if (drainedOwners.has(owner)) continue;
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
            if (items.length === 0) {
                // The stored row is unusable and this run just claimed it.
                // Deleting it (rather than leaving it claimed, or merely
                // `continue`-ing) frees the owner/date slot so a fresh
                // selection can run for this owner today instead of
                // repeating this same no-op claim on every future pass.
                await prisma.receiptRequestCard.deleteMany({
                    where: { id: existing.id, claimToken: token, postedAt: null },
                });
                invalidRows.push(owner);
                continue;
            }
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

        /**
         * THE RETRY PASS SELECTS TOO, when nothing was claimed for this owner.
         *
         * It used to skip, which lost a whole day on the most ordinary
         * sequence there is: the 14:30 run finds the chase unfinished and
         * claims nothing, the chase completes at 15:00, and the 16:30 retry
         * pass — the only run left today — refused to select because there was
         * no row to re-post. Nobody got a card, and nothing said so.
         */
        if (!selectionAllowed) continue;
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
    // Rows this run held back because it did not have the wall clock left to
    // send them safely. NOT a failure and NOT uncertain: nothing was sent, the
    // claim is released, and the next invocation picks the row up unchanged.
    const sendDeferred: string[] = [];
    for (const { card: claimedCard, rowId, token, resumed } of toPost.slice(0, CARD_RATE_CEILING)) {
        /**
         * ONE CACHE PER CARD, NOT PER RUN (Codex PR #443 gate round 37,
         * finding 4).
         *
         * It used to span the whole run, so a competing component that straddles
         * two owners' cards was walked once and the verdict reused. That saved a
         * traversal and broke the guarantee the revalidation exists for: the
         * verdict was computed BEFORE owner A's card was posted, and the posting
         * takes seconds — a receipt booked, a memo signed, or the sweep closing
         * the sibling in that window left owner B chased for a charge that was
         * already answered. "Immediately before the send" has to mean this send.
         *
         * The cost is bounded and known: at most one extra component walk per
         * owner who shares a component, inside a loop already capped by
         * CARD_RATE_CEILING and guarded by the revalidation budget below. A
         * repeated query is cheap; asking a human for a receipt they already
         * sent is what makes the list noise.
         */
        const revalidationCache = new Map<string, ReasonCode[]>();
        /**
         * ENOUGH WALL CLOCK TO FINISH WHAT WE START (round-35 gate, finding 3).
         *
         * Everything below this point is unsafe to be killed part way: the
         * POSTING write, a webhook call that opens its own fresh timeout, and
         * the completion transaction that records the thread ids. A kill
         * between the first and the last leaves the row in POSTING, which the
         * NEXT run reads as `uncertain-delivery` and never resends — so a card
         * that was never sent becomes a card nobody will ever send.
         *
         * Checked BEFORE the revalidation, not just before the POSTING write:
         * revalidation is itself several real queries, and spending them only
         * to refuse the send afterwards wastes the budget of the run that
         * WOULD have sent it.
         *
         * Releasing the claim is what makes this recoverable rather than a
         * lost day — the row keeps its selection and the 16:30 retry pass
         * takes it as an ordinary resumed card.
         */
        if (remainingRunBudgetMs(runStartedAt) <= SEND_HEADROOM_MS) {
            await prisma.receiptRequestCard.updateMany({
                where: { id: rowId, claimToken: token, postedAt: null, status: { in: ["PENDING", "POSTED"] } },
                data: { claimedAt: null, claimToken: null },
            });
            sendDeferred.push(claimedCard.owner);
            continue;
        }
        // RE-VERIFY UNDER THE CLAIM, IMMEDIATELY BEFORE THE SEND.
        //
        // The snapshot was chosen at the top of the run — or, on a retry pass,
        // hours ago. The sweep closing an item, a human acknowledging it, a
        // signed memo arriving, or Marge reassigning it all happen in that
        // window, and the card went out regardless. Asking somebody for a
        // receipt they already sent is how the list becomes noise.
        const truth = await loadCardItemTruth(claimedCard.items.map(item => item.issueId), {
            cache: revalidationCache,
            deadlineExceeded: () => remainingRevalidationBudgetMs(runStartedAt) <= 0,
        });
        const rebuilt = rebuildCardItems(claimedCard.items, truth, claimedCard.owner);
        for (const drop of rebuilt.dropped) dropped.push({ owner: claimedCard.owner, ...drop });

        if (rebuilt.items.length === 0) {
            // Nothing left to ask about. Delete the row rather than posting an
            // empty card or parking a status: a row that survives holds this
            // owner's (owner, pacificDate) slot, so a genuinely new item found
            // later today would have no card to go on.
            // Deleting the row takes its queue marker with it — the resend
            // was answered by the items closing, which is the outcome the
            // operator wanted (round-41 gate, finding 3).
            await prisma.receiptRequestCard.deleteMany({
                where: { id: rowId, claimToken: token, postedAt: null },
            });
            cancelled.push(claimedCard.owner);
            continue;
        }

        /**
         * REBUILT UNDER ITS OWN DATE (Codex PR #443 gate round 41, finding 2).
         *
         * `date` is this INVOCATION's Pacific day. For a drained resend the
         * card belongs to an earlier one, and every identity downstream is
         * derived from the date on the card: the request id, therefore the
         * thread key the webhook posts into, therefore the `request_id` the
         * threads endpoint exports and the association a signed memo has to
         * echo back. Rebuilding with today's date sent the card into a thread
         * whose id nothing else agreed with — the row kept its old
         * `pacificDate`, the bridge echoed an association
         * `matchCardAssociation` rejects, and it could collide with today's
         * own thread for that owner.
         */
        const card = rebuilt.dropped.length === 0
            ? claimedCard
            : buildCardFromItems(claimedCard.owner, claimedCard.date, rebuilt.items, claimedCard.overflow, claimedCard.overflowExact);

        // HISTORY IS WRITTEN AFTER A VALIDATED POST, and only then.
        //
        // Writing it first (the previous shape) marked items `everCarded` for
        // attempts that never reached Chat, so the never-carded-first ordering
        // DEPRIORITISED work nobody had actually been asked about — the exact
        // starvation the ordering exists to prevent. The post is now only a
        // success when it returns both bridge identities, so "carded" means
        // "there is a real thread to reply in".
        /**
         * THE SAME DEADLINE, HANDED IN. The gate above proves there was room
         * for a full-length call when this item started; the revalidation
         * between then and here has spent some of it, so the call gets what is
         * ACTUALLY left minus the completion writes, never the flat ten
         * seconds it would otherwise assume. `postOwnerCard` clamps to its own
         * ceiling, so this can only ever shorten the call.
         */
        const sendTimeoutMs = Math.min(
            CARD_POST_TIMEOUT_MS,
            remainingRunBudgetMs(runStartedAt) - SEND_COMPLETION_MARGIN_MS,
        );
        if (sendTimeoutMs <= 0) {
            // The revalidation ate the headroom the gate had measured. Same
            // answer as the gate: release, defer, send nothing.
            await prisma.receiptRequestCard.updateMany({
                where: { id: rowId, claimToken: token, postedAt: null, status: { in: ["PENDING", "POSTED"] } },
                data: { claimedAt: null, claimToken: null },
            });
            sendDeferred.push(card.owner);
            continue;
        }
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

        const result = await postOwnerCard(webhookUrl, card, { timeoutMs: sendTimeoutMs });

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
                    // THE QUEUE OBLIGATION, DISCHARGED (round-41 gate, finding
                    // 3). Cleared here and nowhere else: a rejection or an
                    // uncertain delivery leaves it set, which is what keeps the
                    // row in the drain and in `cards-queued-rejected` instead of
                    // vanishing when `lastError` is overwritten.
                    resendQueuedAt: null,
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
        // Held back for want of wall clock, claim released, nothing sent. The
        // reason rides along so a run that keeps deferring is distinguishable
        // from a quiet morning.
        sendDeferredOwners: sendDeferred,
        ...(sendDeferred.length > 0 ? { deferredReason: "send-deferred" as const } : {}),
        // Rows deleted this run because their stored itemsJson parsed to
        // nothing. Worth seeing, not worth failing the run over.
        invalidRows,
        // Queued resends this run picked up, as "<owner>:<their date>" — the
        // only place an operator can see that a decision made after the day's
        // last slot was honoured (round-40 gate, finding 2).
        queuedDrained,
        // Owners whose today-selection was skipped because their queued resend
        // is the card going out instead (round-41 gate, finding 1).
        queuedConsumedOwners: [...drainedOwners],
        date,
        retryOnly,
        scanned: scan.candidates.length,
        scanPages: scan.pages,
        scanExhausted: scan.exhausted,
        // The scan's durable position. A `scanResumedFrom` that never changes
        // across runs is a stuck cursor, which looks exactly like a quiet queue
        // without this; `scanWrapped` says the pass really did cover the prefix
        // it had skipped, which is what makes `scanExhausted` trustworthy.
        scanResumedFrom,
        scanNextCursor: scan.nextCursor,
        scanWrapped: scan.wrapped,
        scanCursorPersisted,
        // WHY the scan was not exhausted, when it was the clock rather than the
        // page cap. Both produce the same honest `overflowExact: false`, and
        // they need different fixes — one is a backlog, the other is a slow run.
        scanDeadlineHit: scan.deadlineHit,
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
