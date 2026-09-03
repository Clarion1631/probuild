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
 *
 * A CLEARED ISSUE STILL GETS ITS RECORD (Codex PR #443 gate, finding 2). This
 * used to skip them, on the reasoning that touching an answered issue could
 * overwrite its resolution. The reasoning was right; the remedy was too broad.
 * An issue that clears between the webhook confirming the post and this
 * transaction running is a RACE, not a decision — and skipping it left the item
 * with no thread record at all, so `hasRecordedMemoRequest` was false and a
 * memo signed in that thread came back 422 `not-requested`. The record is
 * therefore written on cleared issues too, and the write is narrowly scoped to
 * make the original fear impossible: the details are merged from the row read
 * INSIDE the CAS, `appendCardRecord` only appends to `cards[]`, and the update
 * touches `displayDetails` and `version` alone. `clearedAt`, `resolution` and
 * every other lifecycle field are never named in the write, so a resolution
 * cannot be un-answered by it.
 */
import { prisma } from "@/lib/prisma";
import { appendCardRecord, type CardRecord } from "@/lib/receipt-requests";
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

/**
 * Thrown when a history write lost its CAS. The caller decides, and inside a
 * transaction the only honest decision is to roll the whole thing back: a card
 * marked POSTED whose items carry no thread record is one nobody can answer.
 */
export class CardHistoryRaceError extends Error {
    constructor(readonly issueIds: string[]) {
        super(`card history lost a CAS for ${issueIds.length} item(s)`);
        this.name = "CardHistoryRaceError";
    }
}

export async function recordCardOnIssues(
    card: RecordableCard,
    threadName: string,
    messageName: string,
    now: Date,
    client: CardHistoryClient = prisma,
    /**
     * `"throw"` — a lost CAS raises `CardHistoryRaceError`, so a caller writing
     * inside a transaction rolls the delivery back with it. A card marked
     * POSTED whose items carry no thread record is one nobody can answer, and
     * committing half of that pair is worse than committing neither.
     * `"report"` — count it and carry on. For callers with nothing to roll back.
     */
    onLostRace: "throw" | "report" = "throw",
): Promise<{ recorded: number; skipped: number; lostRaces: number }> {
    let recorded = 0;
    let skipped = 0;
    let lostRaces = 0;
    const lost: string[] = [];

    for (const item of card.items) {
        // FRESH READ INSIDE THE CAS. Replaying the codes and details captured
        // at selection time could reopen an issue that was cleared while the
        // card was in flight — and worse, write the stale details back over its
        // resolution, un-answering a memo somebody had just signed.
        const issue = await client.reviewIssue.findUnique({
            where: { id: item.issueId },
            select: { id: true, version: true, displayDetails: true, clearedAt: true },
        });
        // Only a MISSING issue is skipped. A cleared one still gets its record
        // — see the note at the top of this file: the card really was posted
        // about it, and the thread record is how a reply in that thread is
        // resolved. Losing it because the answer landed a few hundred
        // milliseconds early is the race this closes.
        if (!issue) { skipped++; continue; }

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
        //
        // THE VERSION IS THE WHOLE GUARD; `clearedAt: null` is deliberately NOT
        // in it any more. It made the write a no-op the instant an issue
        // cleared, which is the race above. The version CAS already refuses any
        // row that moved since the read, and the `data` names only
        // `displayDetails` and `version` — so a clear that commits between the
        // read and this line loses the CAS and is retried by the next card,
        // while a clear that already committed is preserved untouched.
        const written = await client.reviewIssue.updateMany({
            where: { id: issue.id, version: issue.version },
            data: { displayDetails: JSON.stringify(details), version: { increment: 1 } },
        });
        if (written.count === 0) {
            lostRaces++;
            lost.push(item.issueId);
            console.warn("[receipt-card-history] card history lost a race", item.issueId);
            continue;
        }
        recorded++;
    }
    if (lostRaces > 0 && onLostRace === "throw") throw new CardHistoryRaceError(lost);
    return { recorded, skipped, lostRaces };
}

/**
 * Every card record an issue carries, `cards[]` plus the legacy single `card`
 * slot, as objects. Reading BOTH matters: rows written before `cards[]` existed
 * carry only `card`, and a reply in that card's thread has to resolve against it.
 */
export function cardRecordsOf(details: Record<string, unknown> | null | undefined): CardRecord[] {
    const raw = Array.isArray(details?.cards)
        ? (details!.cards as unknown[])
        : details?.card && typeof details.card === "object"
            ? [details.card]
            : [];
    return raw.filter((entry): entry is CardRecord => !!entry && typeof entry === "object");
}

/** What a bridge answer claims about where it was signed. Absent fields are `null`, never guessed. */
export interface AnswerAssociation {
    /** The Chat thread the answer came from — `spaces/<s>/threads/<t>`. */
    thread: string | null;
    /** The "sign N" number of the item on that card. REQUIRED. */
    n: number | null;
    /** The card's request id. REQUIRED. */
    requestId: string | null;
}

export type CardAssociationVerdict =
    | { kind: "never-carded" }
    | { kind: "matched"; record: CardRecord }
    /** The answer named fewer than all three parts of the association. */
    | { kind: "incomplete"; detail: string }
    | { kind: "wrong-thread"; detail: string };

/** The three fields an answer must carry to name ONE asked-about item. */
export const REQUIRED_ASSOCIATION_FIELDS = ["thread", "n", "request_id"] as const;

/**
 * Which of them this answer is missing, in the bridge's own spelling.
 *
 * Exported so the route can refuse an answer BEFORE it spends a Drive round
 * trip on it, and so the operator is told exactly what the bridge failed to
 * send rather than "wrong thread".
 */
export function missingAssociationFields(answer: AnswerAssociation): string[] {
    const missing: string[] = [];
    if (!answer.thread?.trim()) missing.push("thread");
    if (answer.n === null) missing.push("n");
    if (!answer.requestId?.trim()) missing.push("request_id");
    return missing;
}

/**
 * Does this answer come from a card WE posted about THIS issue?
 *
 * THE BINDING THE ARTIFACT CHECKS COULD NOT PROVIDE (Codex PR #443 gate round
 * 33, finding 3). A signed affidavit was accepted on the strength of its
 * filename's dollar amount plus the fact that SOME card had once listed the
 * item. Neither is a link to the ask: two charges for the same amount produce
 * interchangeable memo filenames, so a memo minted for one charge, replayed
 * against another charge's fingerprint, satisfied both checks and closed a
 * chase nobody had answered. The `thread` the bridge already sends was stored
 * and never compared with the thread the card actually went out in.
 *
 * So the answer must name a card record ON THIS ISSUE — and name it EXACTLY
 * (Codex PR #443 gate round 38, finding 1). Thread, `n` and `requestId` are all
 * three required, because a card lists several charges in ONE thread and the
 * memo filenames of two same-amount charges are interchangeable: with `n`
 * optional, an answer that simply omitted it was matched by the thread alone
 * and could close either of them. There is no amount-only and no thread-only
 * path left; an answer that cannot say which item it answers is refused rather
 * than assumed — fail-closed, because "we cannot tell" must never be recorded
 * as "it checked out".
 */
export function matchCardAssociation(
    details: Record<string, unknown> | null | undefined,
    answer: AnswerAssociation,
): CardAssociationVerdict {
    const records = cardRecordsOf(details);
    // NEVER CARDED is a different answer from WRONG THREAD, and the caller
    // reports them differently: one means nobody ever asked about this charge,
    // the other means somebody asked but not where this reply came from.
    if (records.length === 0) return { kind: "never-carded" };

    const missing = missingAssociationFields(answer);
    if (missing.length > 0) {
        return {
            kind: "incomplete",
            detail: `the answer must name the card item it answers: missing ${missing.join(", ")}`,
        };
    }

    const thread = (answer.thread as string).trim();
    let candidates = records.filter(record => typeof record.threadName === "string" && record.threadName.trim() === thread);
    if (candidates.length === 0) {
        return { kind: "wrong-thread", detail: "no card for this charge was posted in that thread" };
    }
    // ALL THREE, ALWAYS. Each one narrows; none of them is optional, so no
    // answer can be satisfied by a sibling item that merely shares the thread.
    candidates = candidates.filter(record => record.n === answer.n);
    if (candidates.length === 0) {
        return { kind: "wrong-thread", detail: "that thread's card did not ask about this charge under that number" };
    }
    candidates = candidates.filter(record => record.requestId === answer.requestId);
    if (candidates.length === 0) {
        return { kind: "wrong-thread", detail: "the answer names a different card request" };
    }
    return { kind: "matched", record: candidates[0] };
}

/** True when this issue already carries the record for a given card. */
export function issueHasCardRecord(details: Record<string, unknown> | null | undefined, requestId: string): boolean {
    const cards = details?.cards;
    if (Array.isArray(cards)) {
        if (cards.some(entry => (entry as { requestId?: unknown })?.requestId === requestId)) return true;
    }
    const latest = details?.card as { requestId?: unknown } | undefined;
    return latest?.requestId === requestId;
}

/**
 * Which of a card's items are MISSING their thread record.
 *
 * The repair path's question. History is written after a confirmed post, and
 * anything that interrupts that write — a lost CAS, a crash between the two —
 * leaves a card that went out with items that do not know where they were
 * asked. A reply in that thread then has nothing to resolve against, and the
 * items still read as never-carded, so tomorrow's card asks again.
 */
export async function itemsMissingCardRecord(
    itemIds: readonly string[],
    requestId: string,
    client: CardHistoryClient = prisma,
): Promise<string[]> {
    if (itemIds.length === 0) return [];
    const issues = await client.reviewIssue.findMany({
        where: { id: { in: [...itemIds] } },
        select: { id: true, displayDetails: true },
    });
    const missing: string[] = [];
    for (const issue of issues) {
        // CLEARED ISSUES ARE REPAIRED TOO. This used to skip them, which meant
        // the repair path could never fix the one case that most needs fixing:
        // an item whose issue cleared before its thread record was written has
        // no record AND no way to get one, so a memo signed in that thread has
        // nothing to resolve against. Recording is safe on a cleared issue (see
        // recordCardOnIssues above) — it appends history and never touches the
        // resolution.
        if (!issueHasCardRecord(parseMissingReceiptDetails(issue.displayDetails), requestId)) {
            missing.push(issue.id);
        }
    }
    return missing;
}
