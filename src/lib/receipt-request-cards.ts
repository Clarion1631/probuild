/**
 * Per-owner missing-receipt Chat digest (Phase 2 §4).
 *
 * ONE message per owner per weekday morning, listing that owner's open,
 * unacknowledged bank-line issues numbered 1..n, with three reply options.
 * NEVER an emailed PDF — nothing in this module imports a mail helper, and
 * nothing may.
 *
 * DELIBERATE DIVERGENCE from `drainReviewAlerts`, stated so nobody "unifies"
 * it later: that drainer sends ONE CARD PER ISSUE and is hard-blocked by the
 * qbo-purchase `RolloutGate`. One Chat card per unmatched bank line is exactly
 * the noise this feature exists to prevent, and that gate must not quietly
 * acquire a second meaning. So these issues open SUPPRESSED (see
 * /api/cron/receipt-requests) and are delivered here instead.
 *
 * IDEMPOTENCY, twice over:
 *   1. A deterministic request id / thread key — `receipt-req-<owner>-<Pacific
 *      date>` — so a retried cron lands in the same Chat thread rather than
 *      starting a second one.
 *   2. The authoritative check: every issue a card listed records
 *      `displayDetails.card.date`. A re-run on the same Pacific day sees that
 *      stamp and builds no card at all. This is the one that actually holds,
 *      because an incoming webhook gives no message-level idempotency of its
 *      own — it must not be trusted for it.
 *
 * Only CJ and Richard are asked. `office`, `Justin` and `unassigned` items are
 * page-only by policy (receipt-policy.ts) — Justin's spend is overwhelmingly
 * overhead, and nobody sends the owner an affidavit request.
 */
import type { ReceiptOwner } from "./receipt-policy";

/** The owners a card is ever addressed to. */
export const CARD_OWNERS_ASKED: ReceiptOwner[] = ["CJ", "Richard"];

/**
 * Max CARDS per run. Same constant/value as the review-alert outbox's
 * `EPISODE_RATE_CEILING` — deliberately restated rather than imported, because
 * this digest explicitly does NOT ride that outbox, and importing its rate
 * limiter would imply a coupling that isn't there.
 */
export const CARD_RATE_CEILING = 10;

/** Max ITEMS listed on one card. A list nobody can finish gets muted. */
export const MAX_ITEMS_PER_CARD = 10;

export interface CardCandidateIssue {
    /** ReviewIssue id. */
    id: string;
    /** BankLine id. */
    targetKey: string;
    owner: string;
    acknowledged: boolean;
    cardTail: string | null;
    postedDate: string;
    /** Signed cents from the bank line (negative = money out). */
    amountCents: number;
    payee: string;
    fingerprint: string;
    /** The Pacific date a card last listed this item, when one has. */
    lastCardDate: string | null;
}

export interface CardItem {
    n: number;
    fingerprint: string;
    /** YYYY-MM-DD posted date. */
    date: string;
    vendor: string;
    /** POSITIVE cents — a memo states what was spent, not a signed posting. */
    cents: number;
    /** Display form of `cents`, e.g. "123.45". */
    amount: string;
    cardTail: string | null;
    issueId: string;
    targetKey: string;
}

export interface OwnerCard {
    owner: string;
    /** `receipt-req-<owner>-<YYYY-MM-DD Pacific>` — request id AND thread key. */
    requestId: string;
    /** Pacific date the card is for. */
    date: string;
    items: CardItem[];
    /** Items beyond MAX_ITEMS_PER_CARD that this card does not list. */
    overflow: number;
    text: string;
}

export function centsToAmount(cents: number): string {
    return (Math.abs(cents) / 100).toFixed(2);
}

/** Today's date in Pacific — the crew's day, not UTC's. */
export function pacificDate(now: Date = new Date()): string {
    return now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Mon–Fri in Pacific. Nobody gets a receipt chase on a Saturday. */
export function isPacificWeekday(now: Date = new Date()): boolean {
    const weekday = now.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short" });
    return !["Sat", "Sun"].includes(weekday);
}

export function requestIdFor(owner: string, date: string): string {
    return `receipt-req-${owner}-${date}`;
}

function cardText(owner: string, date: string, items: CardItem[], overflow: number): string {
    const lines = [
        `📸 *Receipts needed — ${owner}* (${items.length}${overflow > 0 ? ` of ${items.length + overflow}` : ""})`,
        "",
        "Reply *in this thread*:",
        "• send a *photo* of the receipt",
        `• reply *"2 Mueller Remodel"* to name the job for item 2`,
        `• reply *"sign 2"* to sign a memo instead`,
        "",
    ];
    for (const item of items) {
        const tail = item.cardTail ? ` · card …${item.cardTail}` : "";
        lines.push(`${item.n}. ${item.date} · ${item.vendor || "unnamed charge"} · $${item.amount}${tail}`);
    }
    if (overflow > 0) lines.push("", `…and ${overflow} more — the rest come tomorrow.`);
    lines.push("", `_${date}_`);
    return lines.join("\n");
}

/**
 * PURE. Group the night's open issues into at most one card per asked owner.
 *
 * Skipped: acknowledged issues (lifecycle step 4 semantics — someone already
 * said "I looked"), owners nobody asks, and any owner whose items were ALL
 * already listed by today's card. Oldest charge first, so the thing most at
 * risk of being forgotten is item 1.
 */
export function buildOwnerCards(issues: readonly CardCandidateIssue[], now: Date = new Date()): OwnerCard[] {
    const date = pacificDate(now);
    const cards: OwnerCard[] = [];

    for (const owner of CARD_OWNERS_ASKED) {
        const mine = issues
            .filter(issue => issue.owner === owner && !issue.acknowledged)
            .sort((a, b) => (a.postedDate < b.postedDate ? -1 : a.postedDate > b.postedDate ? 1 : a.targetKey < b.targetKey ? -1 : 1));
        if (mine.length === 0) continue;
        // Already asked today. Re-posting the same list is how a useful card
        // becomes noise, and a retried cron must be a no-op.
        if (mine.every(issue => issue.lastCardDate === date)) continue;

        const listed = mine.slice(0, MAX_ITEMS_PER_CARD);
        const items: CardItem[] = listed.map((issue, index) => ({
            n: index + 1,
            fingerprint: issue.fingerprint,
            date: issue.postedDate,
            vendor: issue.payee,
            cents: Math.abs(issue.amountCents),
            amount: centsToAmount(issue.amountCents),
            cardTail: issue.cardTail,
            issueId: issue.id,
            targetKey: issue.targetKey,
        }));
        const overflow = mine.length - listed.length;
        cards.push({
            owner,
            requestId: requestIdFor(owner, date),
            date,
            items,
            overflow,
            text: cardText(owner, date, items, overflow),
        });
    }

    // Owners are two, so this can't bind today. Asserted anyway: a config
    // change that adds owners must not be able to turn one run into a flood.
    return cards.slice(0, CARD_RATE_CEILING);
}

// ── Chat user map (config, not code) ─────────────────────────────────────────

/**
 * `RECEIPT_OWNER_CHAT_USERS` — `{"CJ":"users/…","Richard":"users/…"}`.
 * `owner_user` gates who may sign in chatAffidavitApp.js, so a wrong or
 * missing id locks an owner out of signing their own memo. A malformed value
 * degrades to an empty map rather than throwing: no owner_user is honest,
 * a crash is not.
 */
export function parseOwnerChatUsers(raw: string | undefined): Record<string, string> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Record<string, string> = {};
        for (const [owner, id] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof id === "string" && id.startsWith("users/")) out[owner] = id;
        }
        return out;
    } catch {
        return {};
    }
}

// ── affidavit-threads.json bridge shape ──────────────────────────────────────

export interface ThreadRecordItem {
    n: number;
    fingerprint: string;
    date: string;
    vendor: string;
    cents: number;
    amount: string;
}

export interface ThreadRecord {
    owner: string;
    owner_user: string;
    message_name: string;
    items: ThreadRecordItem[];
}

export interface PostedCardRecord {
    threadName: string;
    messageName: string;
    owner: string;
    items: ThreadRecordItem[];
}

/**
 * Serialize posted cards into EXACTLY the `affidavit-threads.json` map shape
 * `sweepChatReceipts.js` reads. It is not our shape to improve: the sweep
 * indexes by `thread.name` and reads these five keys, so an extra field is
 * harmless but a renamed one is a silent break.
 */
export function serializeThreads(
    posted: readonly PostedCardRecord[],
    ownerChatUsers: Record<string, string>,
): { threads: Record<string, ThreadRecord> } {
    const threads: Record<string, ThreadRecord> = {};
    for (const card of posted) {
        if (!card.threadName) continue;
        threads[card.threadName] = {
            owner: card.owner,
            owner_user: ownerChatUsers[card.owner] ?? "",
            message_name: card.messageName,
            items: card.items.map(item => ({
                n: item.n,
                fingerprint: item.fingerprint,
                date: item.date,
                vendor: item.vendor,
                cents: item.cents,
                amount: item.amount,
            })),
        };
    }
    return { threads };
}

// ── Posting ──────────────────────────────────────────────────────────────────

const WEBHOOK_HOST = "chat.googleapis.com";
const POST_TIMEOUT_MS = 10_000;

/**
 * The server POSTs to this URL, so restrict it to Google Chat's webhook
 * surface — anything else is an SSRF vector, not a configuration choice.
 * Same allowlist as `chat-webhook.ts`.
 */
export function isValidChatWebhookUrl(value: string): boolean {
    try {
        const url = new URL(value.trim());
        return url.protocol === "https:" && url.hostname === WEBHOOK_HOST && url.pathname.startsWith("/v1/spaces/");
    } catch {
        return false;
    }
}

export interface PostedCard {
    owner: string;
    /** Chat's `thread.name`, when the response carried one. */
    threadName: string | null;
    /** Chat's `message.name`, when the response carried one. */
    messageName: string | null;
}

/**
 * Post one owner card to the Receipts Need Review space via an incoming
 * webhook. `threadKey` is the deterministic request id, so a retried cron
 * replies into the same thread instead of starting a new one.
 *
 * Fails SOFT and never throws: an unset or invalid `RECEIPTS_CHAT_WEBHOOK`
 * returns null, and the cron reports `{skipped:"no-webhook"}` rather than
 * failing. A chase card is not worth taking a cron down for.
 */
export async function postOwnerCard(webhookUrl: string, card: OwnerCard): Promise<PostedCard | null> {
    if (!isValidChatWebhookUrl(webhookUrl)) return null;
    try {
        const url = new URL(webhookUrl.trim());
        url.searchParams.set("threadKey", card.requestId);
        url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=UTF-8" },
            body: JSON.stringify({ text: card.text }),
            signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        if (!res.ok) {
            console.error("[receipt-request-cards] post failed", { owner: card.owner, status: res.status });
            return null;
        }
        const body = (await res.json().catch(() => null)) as { name?: unknown; thread?: { name?: unknown } } | null;
        return {
            owner: card.owner,
            threadName: typeof body?.thread?.name === "string" ? body.thread.name : null,
            messageName: typeof body?.name === "string" ? body.name : null,
        };
    } catch (error) {
        console.error("[receipt-request-cards] post failed", { owner: card.owner, error });
        return null;
    }
}
