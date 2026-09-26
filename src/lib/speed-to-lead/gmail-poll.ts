import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { acquireCronLease } from "@/lib/cron-lease";
import { ensureLeadInboxAuth, gmailClientFor } from "./gmail-inbox-client";
import { authenticateMessage, type RawHeader } from "./authentication";
import { parseFallbackEmail } from "./fallback-email";
import { recordPendingFallback, intakeVoiceEvent } from "./intake";
import { sendPlainNtfy } from "./alerts";
import { GMAIL_REQUEST_TIMEOUT_MS } from "./constants";
import { safeErrorCategory } from "./error-category";

/**
 * Read-only inbox poll (v1a: gmail.readonly only, no send scope). Runs every
 * minute, in every mode including OFF (there is no customer-facing safety
 * processing left to gate — v1a has no opt-out/reply/bounce handling at
 * all — but the poll still needs to run in OFF for the lead-inbox health
 * page to show a live status, and running it costs nothing customers can
 * see). Bounded per run (finding 6): at most 10 history pages, 50 message
 * `get` calls, and 40s of wall time.
 */

const POLL_LEASE_MS = 55_000;
const POLL_LEASE_KEY = "speedToLeadPollLease";
const MAX_HISTORY_PAGES = 10;
const MAX_MESSAGE_GETS = 50;
const WALL_TIME_BUDGET_MS = 40_000;
const RESYNC_WINDOW_MS = 72 * 60 * 60 * 1000;
const RESYNC_LOOKBACK_MS = 10 * 60 * 1000;
const BACKOFF_MINUTES = [1, 2, 4, 8, 15] as const;
const POLL_ALERT_SENT_KEY = "speedToLeadPollAlertSentAt";
const POLL_DISCONNECTED_ALERT_KEY = "speedToLeadInboxDisconnectedAlertSent";

// ── Fallback-path alert flood guard (round-5, defense in depth alongside the
// ARC topology fix) ─────────────────────────────────────────────────────────
const FALLBACK_ALERT_FLOOD_KEY = "speedToLeadFallbackAlertFlood";
/** At most this many of the fallback poller's OWN health alerts (disconnected / repeated-failure / resync-gap) reach ntfy in one rolling hour. */
const FALLBACK_ALERT_FLOOD_CAP = 5;
const FALLBACK_ALERT_FLOOD_WINDOW_MS = 60 * 60 * 1000;

interface FallbackAlertFloodState {
    windowStart: string;
    count: number;
    suppressed: number;
}

/**
 * A rolling-hour cap on the fallback poller's own health alerts, so a burst
 * of repeated failures — or a flood of forged/rejected messages probing the
 * ARC topology check — never turns into a wall of individual pushes to
 * Justin's phone. Every call still counts even while suppressed, so once the
 * cap is no longer exhausted the NEXT alert that actually goes out carries a
 * one-line summary of how many were batched in behind it.
 */
export async function sendFallbackPathAlert(db: PrismaClient, title: string, body: string, now: Date): Promise<boolean> {
    const row = await db.automationSetting.findUnique({ where: { key: FALLBACK_ALERT_FLOOD_KEY } });
    let state: FallbackAlertFloodState;
    try {
        state = row ? (JSON.parse(row.value) as FallbackAlertFloodState) : { windowStart: now.toISOString(), count: 0, suppressed: 0 };
    } catch {
        state = { windowStart: now.toISOString(), count: 0, suppressed: 0 };
    }
    if (!Number.isFinite(new Date(state.windowStart).getTime()) || now.getTime() - new Date(state.windowStart).getTime() >= FALLBACK_ALERT_FLOOD_WINDOW_MS) {
        state = { windowStart: now.toISOString(), count: 0, suppressed: 0 };
    }

    if (state.count >= FALLBACK_ALERT_FLOOD_CAP) {
        state.suppressed += 1;
        await db.automationSetting.upsert({ where: { key: FALLBACK_ALERT_FLOOD_KEY }, create: { key: FALLBACK_ALERT_FLOOD_KEY, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } });
        return false;
    }

    const suppressedBefore = state.suppressed;
    const sentBody = suppressedBefore > 0 ? `${body}\n\n(plus ${suppressedBefore} more alert(s) suppressed this hour)` : body;
    state.count += 1;
    state.suppressed = 0;
    await db.automationSetting.upsert({ where: { key: FALLBACK_ALERT_FLOOD_KEY }, create: { key: FALLBACK_ALERT_FLOOD_KEY, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } });
    return sendPlainNtfy(title, sentBody);
}

export interface PollResult {
    ran: boolean;
    reason?: string;
    processed?: number;
    resynced?: boolean;
}

interface ResyncState {
    /** The historyId captured via getProfile BEFORE the resync scan started — becomes the new cursor once the scan finishes, so anything newer is read from here next run (finding 4d). */
    h0: string;
    sinceSeconds: number;
    pageToken: string | null;
    /** Message IDs from the page `pageToken` itself already fetched, not yet handled when the last run's budget ran out — resumed before fetching any further page. A page-level `pageToken` alone is not sufficient: it names the NEXT page, so without this a single oversized page re-lists itself and restarts at message #1 every run (finding: page-token granularity alone cannot resume mid-page). */
    pendingMessageIds?: string[];
    /**
     * True once `messages.list` pagination itself has reached its terminal
     * page (an empty `nextPageToken`) for this resync scan. Explicit rather
     * than inferred from `pageToken: null`, which ALSO means "pagination
     * never started yet" — a resumed `pendingMessageIds` list whose owning
     * page was already the last page would otherwise be indistinguishable
     * from a fresh scan, so draining it fell through into the trailing
     * `do { ... } while (pageToken)` loop, which unconditionally runs its
     * body at least once and re-lists from page 1 (round-3 finding:
     * final-page resync nontermination).
     */
    paginationDone?: boolean;
}

interface IncrementalState {
    /**
     * historyId to commit once history.list pagination has reached its
     * true last page (`paginationDone`) AND every id in `pendingMessageIds`
     * has been handled. Stable across every page of one continuous
     * history.list series — Gmail returns the mailbox's current historyId
     * identically on every page of it — so it is captured as soon as ANY
     * page is fetched, well before pagination itself completes (finding:
     * never checkpoint the mailbox-wide historyId before pagination
     * completes — this field alone is not what gates that; `paginationDone`
     * plus an empty `pendingMessageIds` is).
     */
    newHistoryId: string;
    /** Resume point for history.list's OWN pagination — the next page to fetch. Only meaningful while `paginationDone` is false. */
    pageToken: string | null;
    pendingMessageIds: string[];
    /**
     * True once history.list pagination has reached its terminal page (an
     * empty `nextPageToken`). Explicit for the same reason as
     * `ResyncState.paginationDone`: a page-capped run must persist BOTH the
     * page it left off on AND the fact that more pages remain, so a later
     * run resumes fetching from `pageToken` instead of silently discarding
     * the partial enumeration and re-listing from page 1 next time
     * (finding: incremental starvation — "page 11+ unreachable").
     */
    paginationDone: boolean;
    /**
     * ISO timestamp captured when this NOT-yet-committed incremental scan
     * first began — i.e. `now` at the moment the prior scan's cursor was
     * last committed (or the very first scan after establishing the initial
     * cursor). Pinned across every run this scan remains open; never
     * advanced by partial progress within it. Round-5 finding: a message
     * can sit in `pendingMessageIds` for several runs (get-budget
     * exhaustion) before a LATER run's `history.list` call 404s — the
     * recovery resync's `since` window must reach back to THIS point (the
     * earliest unfinished point), not to "the last poll's start minus 10
     * minutes", which for a message pending far longer than one poll
     * interval is nowhere near far enough back and silently drops it.
     */
    since: string;
}

function headerList(payload: { headers?: { name?: string | null; value?: string | null }[] | null } | undefined): RawHeader[] {
    return (payload?.headers ?? []).map(h => ({ name: h.name ?? "", value: h.value ?? "" }));
}

function extractPlainText(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const part = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
    if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
    }
    for (const child of part.parts ?? []) {
        const found = extractPlainText(child);
        if (found) return found;
    }
    if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ");
    }
    return "";
}

function isGoogleApiError(error: unknown, status: number): boolean {
    const code = (error as { code?: number })?.code ?? (error as { response?: { status?: number } })?.response?.status;
    return code === status;
}

function isInvalidGrant(error: unknown): boolean {
    const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
    return data?.error === "invalid_grant" || (error instanceof Error && error.message.includes("invalid_grant"));
}

function submissionIdFromHeaders(headers: RawHeader[]): string | null {
    return headers.find(h => h.name.toLowerCase() === "x-gtr-submission-id")?.value?.trim() || null;
}

/** A budget shared across one poll run's message-get calls, history pages and wall clock. */
class RunBudget {
    private gets = 0;
    private pages = 0;
    private readonly deadline: number;
    constructor(nowMs: number) {
        this.deadline = nowMs + WALL_TIME_BUDGET_MS;
    }
    get exhausted(): boolean {
        return this.gets >= MAX_MESSAGE_GETS || Date.now() > this.deadline;
    }
    get pagesExhausted(): boolean {
        return this.pages >= MAX_HISTORY_PAGES || Date.now() > this.deadline;
    }
    spendGet(): void { this.gets += 1; }
    spendPage(): void { this.pages += 1; }
}

/**
 * Metadata-first: the ~200 other connect@ Group messages the Group also
 * relays cost exactly one `get` each. `full` (body) is fetched ONLY once
 * `authenticateMessage` has already trusted the sender from metadata alone.
 */
/**
 * Returns false only when the budget ran out mid-message, AFTER the metadata
 * fetch already found a TRUSTED sender but BEFORE the full fetch/record could
 * run — i.e. this specific message was never actually recorded and must not
 * be treated as handled (finding: "silent, permanent lead loss"). Every other
 * outcome (untrusted, deleted/404, or fully recorded) returns true.
 */
async function processMessage(db: PrismaClient, gmail: ReturnType<typeof gmailClientFor>, id: string, budget: RunBudget, now: Date): Promise<boolean> {
    if (budget.exhausted) return false;
    budget.spendGet();
    let metaRes;
    try {
        metaRes = await gmail.users.messages.get(
            { userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Authentication-Results", "ARC-Seal", "ARC-Authentication-Results", "X-Google-Group-Id", "List-ID", "X-GTR-Submission-Id"] },
            { timeout: GMAIL_REQUEST_TIMEOUT_MS },
        );
    } catch (error) {
        // A message the history feed listed can be deleted/expunged before we
        // fetch it — skip THIS message only; never abort the whole poll.
        if (isGoogleApiError(error, 404)) return true;
        throw error;
    }
    const headers = headerList(metaRes.data.payload);
    const from = /<([^>]+)>/.exec(headers.find(h => h.name.toLowerCase() === "from")?.value ?? "")?.[1]
        ?? headers.find(h => h.name.toLowerCase() === "from")?.value ?? "";
    const fromEmail = from.trim().toLowerCase();

    const auth = authenticateMessage(headers, fromEmail);
    if (!auth.trusted) return true;

    if (budget.exhausted) return false;
    budget.spendGet();
    let fullRes;
    try {
        fullRes = await gmail.users.messages.get({ userId: "me", id, format: "full" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
    } catch (error) {
        if (isGoogleApiError(error, 404)) return true;
        throw error;
    }
    const bodyText = extractPlainText(fullRes.data.payload);
    const internalDateMs = fullRes.data.internalDate ? Number(fullRes.data.internalDate) : now.getTime();

    if (auth.rule === "website-group-relay") {
        const submissionId = submissionIdFromHeaders(headers);
        const payload = parseFallbackEmail({ headers, bodyText, submissionId });
        await db.$transaction(tx => recordPendingFallback(tx, { gmailMessageId: id, receivedAt: new Date(internalDateMs), payload }));
        return true;
    }
    if (auth.rule === "voice-direct") {
        await intakeVoiceEvent({ gmailMessageId: id, receivedAt: new Date(internalDateMs), callerPhoneRaw: bodyText, summary: bodyText.slice(0, 2000) }, db);
        return true;
    }
    return true;
}

async function recordPollHealth(db: PrismaClient, startedAt: Date, finishedAt: Date | null, ok: boolean, extra: Record<string, unknown> = {}) {
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: finishedAt, leadInboxLastPollOk: ok, ...extra },
        update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: finishedAt, leadInboxLastPollOk: ok, ...extra },
    });
}

async function recordFailureAndBackoff(db: PrismaClient, startedAt: Date, now: Date, error: unknown): Promise<void> {
    if (isInvalidGrant(error)) {
        await db.companySettings.upsert({
            where: { id: "singleton" },
            create: { id: "singleton", leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxRefreshTokenEnc: null },
            update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxRefreshTokenEnc: null },
        });
        const already = await db.automationSetting.findUnique({ where: { key: POLL_DISCONNECTED_ALERT_KEY } });
        if (!already) {
            await sendFallbackPathAlert(db, "Speed-to-Lead: lead inbox disconnected", "gtrsupport@ revoked or expired its Gmail connection. Reconnect it in Settings > Speed-to-Lead.", now);
            await db.automationSetting.create({ data: { key: POLL_DISCONNECTED_ALERT_KEY, value: now.toISOString() } }).catch(() => undefined);
        }
        return;
    }

    const current = await db.companySettings.findUnique({ where: { id: "singleton" }, select: { leadInboxFailureCount: true } });
    const failureCount = (current?.leadInboxFailureCount ?? 0) + 1;
    const minutes = BACKOFF_MINUTES[Math.min(failureCount - 1, BACKOFF_MINUTES.length - 1)];
    const nextPollAt = new Date(now.getTime() + minutes * 60 * 1000);
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxFailureCount: failureCount, leadInboxNextPollAt: nextPollAt },
        update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxFailureCount: failureCount, leadInboxNextPollAt: nextPollAt },
    });

    if (failureCount >= BACKOFF_MINUTES.length) {
        const already = await db.automationSetting.findUnique({ where: { key: POLL_ALERT_SENT_KEY } });
        if (!already) {
            await sendFallbackPathAlert(db, "Speed-to-Lead: inbox poll failing", `The lead-inbox poll has failed ${failureCount} times in a row.`, now);
            await db.automationSetting.create({ data: { key: POLL_ALERT_SENT_KEY, value: now.toISOString() } }).catch(() => undefined);
        }
    }
}

async function recordSuccessAndClearBackoff(db: PrismaClient): Promise<void> {
    await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxFailureCount: 0, leadInboxNextPollAt: null } }).catch(() => undefined);
    await db.automationSetting.delete({ where: { key: POLL_ALERT_SENT_KEY } }).catch(() => undefined);
    await db.automationSetting.delete({ where: { key: POLL_DISCONNECTED_ALERT_KEY } }).catch(() => undefined);
}

/**
 * Runs a bounded slice of the paginated `messages.list` resync (finding 4:
 * Gmail's documented recovery from an expired `history.list` cursor).
 * Persists progress in `CompanySettings.leadInboxResyncState` and resumes
 * across runs rather than restarting — a resync that needs more than one
 * run's budget must not reprocess mail it already handled, and must not
 * silently drop mail it has not reached yet.
 */
async function runResyncSlice(db: PrismaClient, gmail: ReturnType<typeof gmailClientFor>, state: ResyncState, budget: RunBudget, now: Date): Promise<{ done: boolean; processed: number; nextState: ResyncState }> {
    let processed = 0;
    let pageToken = state.pageToken ?? undefined;

    // Resume the CURRENT page's own leftover messages, if any, before ever
    // fetching a further page — see ResyncState.pendingMessageIds.
    const pendingIds = state.pendingMessageIds ?? [];
    let pendingIdx = 0;
    while (pendingIdx < pendingIds.length) {
        if (budget.exhausted) {
            return { done: false, processed, nextState: { ...state, pageToken: pageToken ?? null, pendingMessageIds: pendingIds.slice(pendingIdx) } };
        }
        // A false return means THIS message's budget cutoff landed after it
        // was found trusted but before it could be recorded — must be
        // reported as incomplete immediately, not just relying on the
        // budget.exhausted check above catching it on the NEXT message
        // (there may be no next message in this page/batch).
        const completed = await processMessage(db, gmail, pendingIds[pendingIdx], budget, now);
        if (!completed) {
            return { done: false, processed, nextState: { ...state, pageToken: pageToken ?? null, pendingMessageIds: pendingIds.slice(pendingIdx) } };
        }
        pendingIdx++;
        processed++;
    }

    // Pagination for this resync scan already reached its terminal page on
    // an earlier run — only the block above (draining pendingMessageIds)
    // had anything left to do, and it just finished. Without this check the
    // do-while below would run its body at least once regardless (that is
    // what `do-while` means) and re-list from page 1 with `pageToken`
    // undefined, even though there is nothing left to list (round-3 finding:
    // final-page resync nontermination).
    if (state.paginationDone) {
        return { done: true, processed, nextState: state };
    }

    do {
        if (budget.pagesExhausted) {
            return { done: false, processed, nextState: { ...state, pageToken: pageToken ?? null, pendingMessageIds: undefined, paginationDone: false } };
        }
        budget.spendPage();
        const page = await gmail.users.messages.list({ userId: "me", q: `after:${state.sinceSeconds}`, pageToken }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
        // Captured immediately: this page's own nextPageToken never changes,
        // so persisting it alongside any of THIS page's own leftover
        // messages below is always correct, regardless of where in the page
        // the budget runs out. By this point `pageToken` already holds the
        // NEXT page's token (or is falsy if this WAS the last page), so
        // `!pageToken` correctly means "pagination is now done" even
        // though `pendingMessageIds` below may still be non-empty.
        pageToken = page.data.nextPageToken ?? undefined;
        const ids = (page.data.messages ?? []).map(m => m.id).filter((id): id is string => !!id);
        let idx = 0;
        while (idx < ids.length) {
            if (budget.exhausted) {
                return { done: false, processed, nextState: { ...state, pageToken: pageToken ?? null, pendingMessageIds: ids.slice(idx), paginationDone: !pageToken } };
            }
            const completed = await processMessage(db, gmail, ids[idx], budget, now);
            if (!completed) {
                return { done: false, processed, nextState: { ...state, pageToken: pageToken ?? null, pendingMessageIds: ids.slice(idx), paginationDone: !pageToken } };
            }
            idx++;
            processed++;
        }
    } while (pageToken);
    return { done: true, processed, nextState: state };
}

/**
 * Runs a bounded slice of the PRIMARY (non-resync) history.list
 * enumeration, resumable across runs exactly like `runResyncSlice`, whose
 * `paginationDone` fix this mirrors (round-4 finding: incremental
 * starvation — a page-capped run discarded its progress entirely instead of
 * persisting `pageToken` and its own leftover message ids, so with 11
 * history pages and 60 leading untrusted messages every run re-listed pages
 * 1-10 from scratch and page 11 was never reachable).
 *
 * Two independent budgets can cut this short: the page cap
 * (`MAX_HISTORY_PAGES`) while still paginating, and the message-get cap
 * (`MAX_MESSAGE_GETS`) while processing whatever has been found so far.
 * Either way, the mailbox-wide cursor (`newHistoryId`) is only ever
 * COMMITTED by the caller once this returns `done: true` — pagination has
 * reached its true last page AND every id it ever collected has been
 * durably processed.
 */
async function runIncrementalSlice(db: PrismaClient, gmail: ReturnType<typeof gmailClientFor>, startHistoryId: string, state: IncrementalState, budget: RunBudget, now: Date): Promise<{ done: boolean; processed: number; nextState: IncrementalState; historyExpired?: boolean }> {
    let processed = 0;

    // Drain every id ALREADY known pending from a prior run FIRST — before
    // ever calling `history.list`, which can itself throw on an expired
    // cursor. Round-5 regression: this used to run AFTER this run's own
    // enumeration below, so a pending id (possibly several runs old) sitting
    // in `state.pendingMessageIds` was silently abandoned whenever a LATER
    // `history.list` call hit an expired cursor — the caller's
    // `historyExpired` branch discards `leadInboxIncrementalState` entirely.
    // By the time pagination can even start below, every previously-known
    // pending id has either been durably processed, or this run has already
    // returned without ever touching `history.list`.
    const pendingIds = state.pendingMessageIds;
    let pendingIdx = 0;
    while (pendingIdx < pendingIds.length) {
        if (budget.exhausted) {
            return { done: false, processed, nextState: { ...state, pendingMessageIds: pendingIds.slice(pendingIdx) } };
        }
        // A false return means budget ran out mid-message, after this one
        // was already found trusted but before it could be recorded — it
        // must count as NOT durably processed (see processMessage's own doc
        // comment), so it stays pending (not yet advanced past).
        const completed = await processMessage(db, gmail, pendingIds[pendingIdx], budget, now);
        if (!completed) {
            return { done: false, processed, nextState: { ...state, pendingMessageIds: pendingIds.slice(pendingIdx) } };
        }
        pendingIdx++;
        processed++;
    }

    let pageToken = state.pageToken ?? undefined;
    let newHistoryId = state.newHistoryId;
    let paginationDone = state.paginationDone;
    // No need to seed this from state.pendingMessageIds any more — every id
    // that was ever in it is fully drained by this point (or this function
    // already returned above), so a newly fetched page can only ever see
    // ids this run has not already collected.
    const seen = new Set<string>();
    const collected: string[] = [];

    while (!paginationDone) {
        if (budget.pagesExhausted) break; // paginationDone stays false — more pages remain, just not reachable THIS run.
        budget.spendPage();
        let page;
        try {
            page = await gmail.users.history.list({ userId: "me", startHistoryId, historyTypes: ["messageAdded"], pageToken }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
        } catch (error) {
            // The startHistoryId this enumeration is anchored to has expired
            // mid-resume — abandon this partial state entirely; the caller
            // falls back to the H0 resync path exactly as a fresh run would.
            // Every previously-known pending id was already durably drained
            // above, so only THIS run's own newly-collected (still
            // unprocessed) ids are at risk here — `state.since`, pinned to
            // when this scan truly began, is what protects those via the
            // resync fallback's own `since` window (see caller).
            if (isGoogleApiError(error, 404)) return { done: false, processed, nextState: { ...state, pendingMessageIds: [] }, historyExpired: true };
            throw error;
        }
        // The mailbox's CURRENT historyId — the same value on every page of
        // this one series (Gmail's documented behavior) — so capturing it
        // here, before pagination is done, is always safe; only COMMITTING
        // it as the cursor is gated on paginationDone below.
        if (page.data.historyId) newHistoryId = String(page.data.historyId);
        for (const h of page.data.history ?? []) {
            for (const added of h.messagesAdded ?? []) {
                const id = added.message?.id;
                if (id && !seen.has(id)) { seen.add(id); collected.push(id); }
            }
        }
        pageToken = page.data.nextPageToken ?? undefined;
        if (!pageToken) paginationDone = true;
    }

    let idx = 0;
    while (idx < collected.length) {
        if (budget.exhausted) break;
        const completed = await processMessage(db, gmail, collected[idx], budget, now);
        if (!completed) break;
        idx++;
        processed++;
    }
    const remaining = collected.slice(idx);

    return {
        done: paginationDone && remaining.length === 0,
        processed,
        nextState: { ...state, newHistoryId, pageToken: pageToken ?? null, pendingMessageIds: remaining, paginationDone },
    };
}

/**
 * Runs every minute, in every mode including OFF. Holds a lease so
 * overlapping cron invocations never process the same batch twice.
 */
export async function pollLeadInbox(db: PrismaClient = prisma, now: Date = new Date()): Promise<PollResult> {
    const lease = await acquireCronLease(POLL_LEASE_KEY, POLL_LEASE_MS);
    if (!lease) return { ran: false, reason: "lease held by another run" };
    const startedAt = now;
    try {
        const settingsRow = await db.companySettings.findUnique({
            where: { id: "singleton" },
            select: {
                leadInboxHistoryId: true, leadInboxCutoffAt: true, leadInboxLastPollAt: true, leadInboxLastPollStartedAt: true,
                leadInboxNextPollAt: true, leadInboxResyncState: true, leadInboxIncrementalState: true,
            },
        });

        if (settingsRow?.leadInboxNextPollAt && now.getTime() < settingsRow.leadInboxNextPollAt.getTime()) {
            return { ran: false, reason: "backing off after repeated failures" };
        }

        const auth = await ensureLeadInboxAuth(db);
        if (!auth.ok || !auth.client) {
            await recordPollHealth(db, startedAt, null, false);
            return { ran: false, reason: "lead inbox not connected" };
        }
        const gmail = gmailClientFor(auth.client);
        const budget = new RunBudget(now.getTime());

        // A resync from a PRIOR run is still in progress — finish it (or make
        // another bounded pass) before considering anything else.
        const savedResync = settingsRow?.leadInboxResyncState as unknown as ResyncState | null;
        if (savedResync?.h0) {
            const result = await runResyncSlice(db, gmail, savedResync, budget, now);
            if (result.done) {
                await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: result.nextState.h0, leadInboxResyncState: Prisma.JsonNull } });
                await recordPollHealth(db, startedAt, new Date(), true);
                await recordSuccessAndClearBackoff(db);
                return { ran: true, processed: result.processed, resynced: true };
            }
            await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxResyncState: result.nextState as unknown as object } });
            await recordPollHealth(db, startedAt, new Date(), true);
            return { ran: true, processed: result.processed, resynced: true };
        }

        if (!settingsRow?.leadInboxHistoryId) {
            // First run: establish a cursor without processing any backlog.
            const profile = await gmail.users.getProfile({ userId: "me" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
            await db.companySettings.upsert({
                where: { id: "singleton" },
                create: { id: "singleton", leadInboxHistoryId: String(profile.data.historyId), leadInboxCutoffAt: now },
                update: { leadInboxHistoryId: String(profile.data.historyId), leadInboxCutoffAt: now },
            });
            await recordPollHealth(db, startedAt, new Date(), true);
            await recordSuccessAndClearBackoff(db);
            return { ran: true, processed: 0 };
        }

        // A fixed-budget incremental run from a PRIOR run may have left
        // history.list pagination itself unfinished (the page cap), its own
        // message processing unfinished (the get-budget cap), or both —
        // resume from EXACTLY where it left off (same reasoning as the
        // resync branch above; see runIncrementalSlice's own doc comment).
        // With no saved state, this is just a fresh slice starting at page 1.
        const savedIncremental = settingsRow.leadInboxIncrementalState as unknown as IncrementalState | null;
        const incrementalState: IncrementalState = savedIncremental ?? {
            newHistoryId: settingsRow.leadInboxHistoryId,
            pageToken: null,
            pendingMessageIds: [],
            paginationDone: false,
            since: now.toISOString(),
        };

        const result = await runIncrementalSlice(db, gmail, settingsRow.leadInboxHistoryId, incrementalState, budget, now);

        if (result.historyExpired) {
            // finding 4a: capture H0 via getProfile BEFORE scanning old mail,
            // so anything that arrives DURING the resync is still covered
            // next run (the cursor becomes H0, not "now").
            const profile = await gmail.users.getProfile({ userId: "me" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
            const h0 = String(profile.data.historyId);

            // Look back as far as EITHER candidate justifies, never less than
            // before this fix: the last poll's own start (as before), OR —
            // round-5 finding — this incremental scan's own watermark, which
            // can be much older than "the last poll start" when a pending
            // message has been sitting for several runs under the
            // get-budget cap before a LATER run's history.list call 404s.
            // Using the MINIMUM (earliest) of the two only ever widens the
            // resync window, never narrows it relative to the prior formula.
            const lastPollCandidateMs = (settingsRow.leadInboxLastPollStartedAt?.getTime() ?? 0) - RESYNC_LOOKBACK_MS;
            const watermarkCandidateMs = new Date(result.nextState.since).getTime() - RESYNC_LOOKBACK_MS;
            const rawSinceMs = Math.max(
                settingsRow.leadInboxCutoffAt?.getTime() ?? 0,
                Math.min(lastPollCandidateMs, watermarkCandidateMs),
            );
            const floorMs = now.getTime() - RESYNC_WINDOW_MS;
            if (rawSinceMs > 0 && rawSinceMs < floorMs) {
                // finding 4f: the real gap exceeds 72h — that window is
                // unrecoverable. Reset the cutoff to now and notify ONCE,
                // naming the window, rather than silently truncating it.
                await sendFallbackPathAlert(
                    db,
                    "Speed-to-Lead: inbox poll gap",
                    `The lead inbox could not be resynced past a 72-hour gap. Unscanned window: ${new Date(rawSinceMs).toISOString()} to ${new Date(floorMs).toISOString()}.`,
                    now,
                );
                await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: h0, leadInboxCutoffAt: now, leadInboxResyncState: Prisma.JsonNull, leadInboxIncrementalState: Prisma.JsonNull } });
                await recordPollHealth(db, startedAt, new Date(), true);
                await recordSuccessAndClearBackoff(db);
                return { ran: true, processed: 0, resynced: true };
            }

            const sinceSeconds = Math.max(0, Math.floor(Math.max(rawSinceMs, floorMs) / 1000));
            const resyncResult = await runResyncSlice(db, gmail, { h0, sinceSeconds, pageToken: null }, budget, now);
            if (resyncResult.done) {
                await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: h0, leadInboxResyncState: Prisma.JsonNull, leadInboxIncrementalState: Prisma.JsonNull } });
            } else {
                // Abandoning the stale incremental state in favor of the
                // resync now in progress — leaving it behind would let a
                // later run resume pagination against a pageToken tied to
                // this now-expired startHistoryId once the resync clears
                // its own state.
                await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxResyncState: resyncResult.nextState as unknown as object, leadInboxIncrementalState: Prisma.JsonNull } });
            }
            await recordPollHealth(db, startedAt, new Date(), true);
            await recordSuccessAndClearBackoff(db);
            return { ran: true, processed: resyncResult.processed, resynced: true };
        }

        // Cursor advances only once runIncrementalSlice reports every
        // history page fetched AND every message it found durably processed.
        if (result.done) {
            await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: result.nextState.newHistoryId, leadInboxIncrementalState: Prisma.JsonNull } });
        } else {
            // Persist exactly where pagination and/or message processing
            // left off so the NEXT run resumes past it — fetching the next
            // page via the saved pageToken instead of re-listing from page
            // 1, and re-fetching neither a message nor a page already
            // handled (finding: incremental starvation).
            await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxIncrementalState: result.nextState as unknown as object } });
        }
        await recordPollHealth(db, startedAt, new Date(), true);
        await recordSuccessAndClearBackoff(db);
        return { ran: true, processed: result.processed };
    } catch (error) {
        console.error("[speed-to-lead] inbox poll failed", safeErrorCategory(error));
        await recordFailureAndBackoff(db, startedAt, now, error);
        return { ran: false, reason: "error" };
    } finally {
        await lease.release();
    }
}
