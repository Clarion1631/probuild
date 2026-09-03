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
    /** True once ANY card has listed this item (its cards[] history is non-empty). */
    everCarded: boolean;
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
    /** Items not on this card. They are tomorrow's FIRST candidates. */
    overflow: number;
    /** False when the scan stopped early, so `overflow` is a floor, not a total. */
    overflowExact: boolean;
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

/**
 * "3" or "3 of 14". A NUMBER is only printed when the scan reached the end of
 * the queue and therefore knows the total; when it stopped at its page cap the
 * total would be a guess, and a wrong number on a chase card is exactly the
 * kind of small lie that stops people trusting the list.
 */
function countLabel(shown: number, overflow: number, overflowExact: boolean): string {
    if (overflow <= 0) return String(shown);
    return overflowExact ? `${shown} of ${shown + overflow}` : `${shown} of more`;
}

export function cardText(
    owner: string,
    date: string,
    items: readonly CardItem[],
    overflow: number,
    overflowExact = true,
): string {
    // The examples name an item the card ACTUALLY HAS. A one-item card that
    // says 'reply "sign 2"' is instructions for a message that does not exist,
    // and the first thing a reader does is look for item 2 and lose confidence
    // in the whole card. Item 1 always exists (a card with no items is never
    // built); beyond that the placeholder N is honest about being a placeholder.
    const example = items.length > 1 ? "2" : "1";
    const lines = [
        `📸 *Receipts needed — ${owner}* (${countLabel(items.length, overflow, overflowExact)})`,
        "",
        "Reply *in this thread*:",
        "• send a *photo* of the receipt",
        `• reply *"${example} Mueller Remodel"* to name the job for item ${example}`,
        `• reply *"sign ${example}"* to sign a memo instead`,
        "",
    ];
    for (const item of items) {
        const tail = item.cardTail ? ` · card …${item.cardTail}` : "";
        lines.push(`${item.n}. ${item.date} · ${item.vendor || "unnamed charge"} · $${item.amount}${tail}`);
    }
    if (overflow > 0) {
        lines.push("", overflowExact
            ? `…and ${overflow} more — the rest come tomorrow.`
            : "…and more — the rest come tomorrow.");
    }
    lines.push("", `_${date}_`);
    return lines.join("\n");
}

function toCardItem(issue: CardCandidateIssue, index: number): CardItem {
    return {
        n: index + 1,
        fingerprint: issue.fingerprint,
        date: issue.postedDate,
        vendor: issue.payee,
        cents: Math.abs(issue.amountCents),
        amount: centsToAmount(issue.amountCents),
        cardTail: issue.cardTail,
        issueId: issue.id,
        targetKey: issue.targetKey,
    };
}

/**
 * The selection order for ONE owner. PURE.
 *
 * NEVER-CARDED ITEMS COME FIRST. Ordering by age alone meant that once the ten
 * oldest charges were on a card, the same ten went out every morning and an
 * eleventh, newer charge was never asked about at all — the queue looked busy
 * and nothing new ever moved. So an item that has never appeared on a card
 * outranks every item that has, and within each group the oldest charge wins
 * (the lowest targetKey breaks a tie, so the order is stable across runs).
 * Yesterday's overflow is by construction tomorrow's first candidate.
 */
export function selectOwnerItems(
    candidates: readonly CardCandidateIssue[],
    owner: string,
): { items: CardItem[]; overflow: number } {
    const mine = candidates
        .filter(issue => issue.owner === owner && !issue.acknowledged)
        .sort((a, b) => {
            if (a.everCarded !== b.everCarded) return a.everCarded ? 1 : -1;
            if (a.postedDate !== b.postedDate) return a.postedDate < b.postedDate ? -1 : 1;
            return a.targetKey < b.targetKey ? -1 : a.targetKey > b.targetKey ? 1 : 0;
        });
    const listed = mine.slice(0, MAX_ITEMS_PER_CARD);
    return { items: listed.map(toCardItem), overflow: mine.length - listed.length };
}

/** Rebuild a card's text and request id from an already-claimed selection. */
export function buildCardFromItems(
    owner: string,
    date: string,
    items: CardItem[],
    overflow: number,
    overflowExact = true,
): OwnerCard {
    return {
        owner,
        requestId: requestIdFor(owner, date),
        date,
        items,
        overflow,
        overflowExact,
        text: cardText(owner, date, items, overflow, overflowExact),
    };
}

/**
 * PURE. One card per asked owner, from tonight's candidates.
 *
 * There is deliberately NO "already asked today" rule in here any more. That
 * check used to live in this function, reading a stamp written AFTER the post —
 * selection and the record of selection were two writes with a network call
 * between them, so two concurrent runs could both select and both post. The
 * claim is now a unique (owner, pacificDate) row created in the same
 * transaction as selection; see the cron.
 */
export function buildOwnerCards(
    candidates: readonly CardCandidateIssue[],
    now: Date = new Date(),
    overflowExact = true,
): OwnerCard[] {
    const date = pacificDate(now);
    const cards: OwnerCard[] = [];
    for (const owner of CARD_OWNERS_ASKED) {
        const { items, overflow } = selectOwnerItems(candidates, owner);
        if (items.length === 0) continue;
        cards.push(buildCardFromItems(owner, date, items, overflow, overflowExact));
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

/**
 * What we know about a send, and the difference matters enormously.
 *
 *  - `delivered` — Chat accepted it AND gave us both bridge identities. Only
 *    this writes POSTED.
 *  - `rejected` — Chat provably did NOT take the message (a refused URL, a 4xx,
 *    a rate-limit). Nothing is in the space, so the row goes back to PENDING and
 *    the retry pass may send it.
 *  - `unknown` — a timeout, a network error, a 5xx, or a 2xx with no message
 *    name. The card may well be sitting in the crew's space right now. This is
 *    NEVER auto-retried: a second identical card is worse than a missing one,
 *    because it teaches people the list is noise.
 *
 * Collapsing the last two into "failed" is what made a timeout look retryable.
 */
export type PostOutcome =
    | { kind: "delivered"; owner: string; threadName: string; messageName: string }
    | { kind: "rejected"; owner: string; reason: string }
    | { kind: "unknown"; owner: string; reason: string };

/**
 * Post one owner card to the Receipts Need Review space via an incoming
 * webhook. `threadKey` is the deterministic request id, so a retried cron
 * replies into the same thread instead of starting a new one.
 *
 * Never throws — every failure mode is one of the three outcomes above.
 */
export async function postOwnerCard(webhookUrl: string, card: OwnerCard): Promise<PostOutcome> {
    // Never sent: not a Chat webhook at all.
    if (!isValidChatWebhookUrl(webhookUrl)) {
        return { kind: "rejected", owner: card.owner, reason: "invalid-webhook-url" };
    }
    let res: Response;
    try {
        const url = new URL(webhookUrl.trim());
        url.searchParams.set("threadKey", card.requestId);
        url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=UTF-8" },
            body: JSON.stringify({ text: card.text }),
            signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
    } catch (error) {
        // A timeout or a socket error says nothing about whether Chat processed
        // the request. UNKNOWN, and therefore never resent.
        console.error("[receipt-request-cards] post did not complete", { owner: card.owner, error });
        return { kind: "unknown", owner: card.owner, reason: "network-or-timeout" };
    }

    if (!res.ok) {
        // 4xx (and an explicit rate-limit) mean Chat DECLINED: nothing is in the
        // space. 5xx means it may have been processed before it fell over.
        const definitivelyRejected = res.status >= 400 && res.status < 500;
        console.error("[receipt-request-cards] post failed", { owner: card.owner, status: res.status });
        return definitivelyRejected
            ? { kind: "rejected", owner: card.owner, reason: `http-${res.status}` }
            : { kind: "unknown", owner: card.owner, reason: `http-${res.status}` };
    }

    const body = (await res.json().catch(() => null)) as { name?: unknown; thread?: { name?: unknown } } | null;
    const threadName = typeof body?.thread?.name === "string" && body.thread.name ? body.thread.name : null;
    const messageName = typeof body?.name === "string" && body.name ? body.name : null;
    if (!threadName || !messageName) {
        // Chat ACCEPTED it — the message is very probably in the space — but we
        // cannot bridge it, so the sweep can never find replies to it. Unknown,
        // not rejected: reposting would double up on a card that did land.
        console.error("[receipt-request-cards] post lacked a bridge identity", {
            owner: card.owner,
            hasThread: threadName !== null,
            hasMessage: messageName !== null,
        });
        return { kind: "unknown", owner: card.owner, reason: "no-bridge-identity" };
    }
    return { kind: "delivered", owner: card.owner, threadName, messageName };
}

// ── Re-verifying a claimed snapshot before it goes out ──────────────────────

/** One item's CURRENT truth, read fresh from its ReviewIssue. */
export interface CardItemTruth {
    /** Non-null once the issue was answered or the charge got its receipt. */
    clearedAt: Date | null;
    /** Every current reason code has been acknowledged by a human. */
    acknowledged: boolean;
    /** A signed memo (or another recorded answer) is on the row. */
    resolved: boolean;
    /**
     * Receipt evidence exists RIGHT NOW for this bank line, recomputed from
     * current Expense/ReceiptIntake data — NOT merely inferred from the issue
     * being cleared. The nightly sweep is what normally clears an issue when a
     * receipt lands, but that sweep runs once a night: a receipt photographed
     * after it ran, and booked by the 5-minute intake worker, satisfies the
     * charge hours before `clearedAt` moves. Without this, a card built in
     * that gap chased a receipt that had already arrived (Codex PR #443 gate,
     * finding 1).
     */
    evidenceSatisfied: boolean;
    /** Who owns it NOW — a human may have reassigned it since selection. */
    owner: string;
    /**
     * Re-verification did not run for this item because the run's
     * revalidation budget was already spent (Codex PR #443 gate, finding 3).
     * Err toward not sending: an unverified item is dropped rather than risk
     * asking for a receipt that already landed.
     */
    revalidationSkipped?: boolean;
}

export type CardItemDropReason =
    | "missing"
    | "cleared"
    | "acknowledged"
    | "resolved"
    | "evidence-found"
    | "owner-changed"
    | "revalidation-deadline";

export interface RebuiltCard {
    items: CardItem[];
    /** What was dropped and why, for the run summary. */
    dropped: Array<{ issueId: string; reason: CardItemDropReason }>;
}

/**
 * Re-verify a claimed snapshot against current truth, immediately before the
 * card is posted.
 *
 * THE SNAPSHOT IS TAKEN EARLY AND POSTED LATE. Selection happens at the top of
 * the run; the post happens after every other owner's row has been claimed, and
 * a retry pass can post a snapshot claimed HOURS earlier. Everything that
 * answers an item — the nightly sweep closing it, a human acknowledging it on
 * the Receipts tab, a signed memo arriving through the bridge, Marge assigning
 * it to somebody else — happens in that window, and the card went out anyway.
 * Asking a person for a receipt they already sent is exactly how a chase list
 * becomes noise people stop reading.
 *
 * `n` is renumbered over the survivors, because the numbers are what people
 * reply with ("2 is on the truck"). A gap in them would make a reply ambiguous
 * against the thread the bridge resolves it in.
 *
 * PURE: the caller does the reading. An item with no truth entry was deleted
 * outright and is dropped as `missing`.
 */
export function rebuildCardItems(
    items: readonly CardItem[],
    truth: ReadonlyMap<string, CardItemTruth>,
    owner: string,
): RebuiltCard {
    const kept: CardItem[] = [];
    const dropped: RebuiltCard["dropped"] = [];
    for (const item of items) {
        const current = truth.get(item.issueId);
        const reason: CardItemDropReason | null = !current
            ? "missing"
            : current.revalidationSkipped
                ? "revalidation-deadline"
                : current.clearedAt !== null
                    ? "cleared"
                    : current.resolved
                        ? "resolved"
                        : current.evidenceSatisfied
                            ? "evidence-found"
                            : current.acknowledged
                                ? "acknowledged"
                                : current.owner !== owner
                                    ? "owner-changed"
                                    : null;
        if (reason) {
            dropped.push({ issueId: item.issueId, reason });
            continue;
        }
        kept.push({ ...item, n: kept.length + 1 });
    }
    return { items: kept, dropped };
}

// ── Chat resource names, as an operator types them ─────────────────────────

/**
 * `spaces/<space>/threads/<thread>` and `spaces/<space>/messages/<message>` —
 * the two identities the bridge resolves a reply against.
 *
 * They are VALIDATED, not trusted, because on the "mark delivered" path a human
 * is pasting them out of the Chat UI. A row marked POSTED with a mistyped
 * thread name is the worst of both worlds: the card is closed, the crew may
 * never have seen it, and the reply that would have answered it has nothing to
 * resolve against. Refusing a malformed paste leaves the row UNCERTAIN, which
 * is exactly where it should stay until somebody supplies the real thing.
 */
const CHAT_SPACE = "[A-Za-z0-9_-]+";
const CHAT_ID = "[A-Za-z0-9_.-]+";
const THREAD_NAME = new RegExp(`^spaces/${CHAT_SPACE}/threads/${CHAT_ID}$`);
const MESSAGE_NAME = new RegExp(`^spaces/${CHAT_SPACE}/messages/${CHAT_ID}$`);

export function isChatThreadName(value: unknown): value is string {
    return typeof value === "string" && THREAD_NAME.test(value.trim());
}

export function isChatMessageName(value: unknown): value is string {
    return typeof value === "string" && MESSAGE_NAME.test(value.trim());
}

/** `spaces/<id>` out of either resource name, for the same-space check. */
export function chatSpaceOf(name: string): string | null {
    const match = /^spaces\/([A-Za-z0-9_-]+)\//.exec(name.trim());
    return match ? match[1] : null;
}

export interface ChatDelivery {
    threadName: string;
    messageName: string;
}

/**
 * THE space these cards live in, from configuration.
 *
 * `RECEIPTS_CHAT_SPACE` if set; otherwise derived from the webhook URL, whose
 * path is `/v1/spaces/<id>/messages`. One source of truth: the space we post
 * to is by definition the space a reply can be in.
 */
export function configuredReceiptsSpace(
    env: Record<string, string | undefined> = process.env,
): string | null {
    const explicit = env.RECEIPTS_CHAT_SPACE?.trim();
    if (explicit) return explicit.replace(/^spaces\//, "");
    const webhook = env.RECEIPTS_CHAT_WEBHOOK?.trim();
    if (!webhook) return null;
    try {
        const match = /\/v1\/spaces\/([A-Za-z0-9_-]+)\//.exec(new URL(webhook).pathname);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * The pair an operator must supply to close an uncertain card by hand, or null
 * when what they pasted cannot be that pair.
 *
 * BOTH names are required, both must name the same space, and that space must
 * be OUR space. A well-formed pair from somewhere else is the dangerous shape:
 * it satisfies every syntactic check, marks the card delivered, and points the
 * bridge at a thread in a room the crew cannot see — so the card reads as
 * answered and the replies that would answer it can never arrive. A pair copied
 * from two different cards is the same class of mistake, and plausible when
 * somebody is working through a list of them.
 */
export function parseChatDelivery(
    threadName: unknown,
    messageName: unknown,
    env: Record<string, string | undefined> = process.env,
): ChatDelivery | null {
    if (!isChatThreadName(threadName) || !isChatMessageName(messageName)) return null;
    const thread = threadName.trim();
    const message = messageName.trim();
    const space = chatSpaceOf(thread);
    if (space === null || space !== chatSpaceOf(message)) return null;
    // Unconfigured is REFUSED, not waved through: with no known space there is
    // nothing to check against, and "we could not check" must never read as
    // "it checked out".
    const ours = configuredReceiptsSpace(env);
    if (ours === null || ours !== space) return null;
    return { threadName: thread, messageName: message };
}
