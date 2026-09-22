/**
 * The To-do view's planner: what on the Receipts tab is actually a human's to
 * do, and who owns the rest.
 *
 * PURE. No Prisma, no fetch, no clock except the `now` that is handed in. It
 * reads only what `fetchReceiptQueue` already returns, which is the whole point
 * of the design: this view costs no extra query and no extra column.
 *
 * THREE INVARIANTS, all covered by tests/receipt-todo-view.test.ts:
 *
 * 1. CONSERVATION, over RECEIPTS rather than list entries. Every distinct row
 *    the queue hands this module lands in exactly one pile or exactly one
 *    folded line. Never both, never neither.
 *
 *    This is not theoretical. `exceptionsWhere` (receipts-data.ts) selects on
 *    `postVoidQbPurchaseId != null` OR a `stateReason` ending in
 *    `:possible-orphan-purchase`, and is deliberately NOT state-scoped, so a
 *    row can come back in `exceptions` and in a state group at the same time.
 *    The live path: a BOOKING row is marked DUPLICATE mid-send, book.ts writes
 *    `postVoidQbPurchaseId` with `stateReason: "booked-after-void"`, then "Not
 *    a duplicate" sets it READ and clears the reason WITHOUT clearing
 *    `postVoidQbPurchaseId`, and the worker re-routes it to NEEDS_REVIEW or
 *    NEEDS_JOB. Counting entries would report that row twice, and `needsJob`
 *    is copied with no reason check at all, so it would also be DRAWN as
 *    routine work while the strip called it handled.
 *
 *    Intake rows are therefore deduplicated by id, exceptions first.
 * 2. AN UNKNOWN REASON IS A HUMAN'S, AND SAYS SO. A `stateReason` this module
 *    does not recognise gets its OWN pile, "Tell Justin about these". Folding
 *    it is how a brand new failure mode goes quiet for a month; filing it
 *    under "Needs a better photo" is a guess about a cause nobody knows, and
 *    would send somebody chasing a photograph for a bug. The row draws
 *    `describeStateReason`'s fallback, which is the raw code, and the only
 *    thing asked of a reader is to pass that code on.
 * 3. AN UNKNOWN HOLD OR RESOLUTION IS NAMED, NOT GUESSED. A request carrying an
 *    `outreachHold` or `resolution` value this module has never heard of gets
 *    its own folded line QUOTING the raw value, rather than falling through
 *    into "Ask for these receipts" (which would chase a charge somebody has
 *    already answered) or into a generic fold (which would hide the new code).
 *
 * COUNTING. `needsYouCount` counts ROWS, not rolled-up items: a run of ten
 * identical charges is one line on screen but ten charges with no receipt, and
 * the stat card it feeds says "Rows waiting on you". Conservation is a
 * statement about rows too, so the two agree by construction.
 *
 * COPY RULE, the same one reason-text.ts states: say what is TRUE about the row
 * and what action exists. Never predict an outcome. "Each one books itself as
 * soon as it has a job" is a promise this module is in no position to make, and
 * a promise that does not come true is how a bookkeeper learns to stop reading
 * the page. House style on top of that: small words, short sentences, no em
 * dash, no en dash, no " - " as punctuation. The test file asserts both over
 * every exported copy constant rather than trusting review.
 */
import { normalizePayee } from "@/lib/bank-ledger";
import { looksLikeCheckOrSubBill } from "@/lib/receipt-policy";
import type { IntakeRow, MissingReceiptRow, ReceiptQueue } from "./receipts-data";
import { RECEIPT_GROUP_TAKE, ownerRank, type ReceiptGroup } from "./receipts-filters";

export type TodoPileKey =
    | "whose-card" | "pick-the-job" | "better-photo" | "tell-justin"
    | "ask-for-these" | "checks-and-sub-bills";

/** A rolled-up run of identical charges, or a single one (rows.length === 1). */
export interface TodoRequestItem {
    key: string;
    rows: MissingReceiptRow[];
    amountCentsEach: number;
    totalCents: number;
    payee: string;
    owner: string;
    firstDate: string;
    lastDate: string;
}

export type TodoItem =
    | { kind: "intake"; row: IntakeRow }
    | { kind: "request"; item: TodoRequestItem };

export interface TodoPile {
    key: TodoPileKey;
    title: string;
    note: string;
    items: TodoItem[];
    /** Charges in this pile. A rolled-up item counts every row inside it. */
    rowCount: number;
    /** Whole days since the oldest item here. Null when the pile is empty. */
    oldestDays: number | null;
}

/**
 * Where a folded line points.
 *
 * A TARGET, not an href: the planner has no idea what else is in the URL, and
 * an href built here would drop an active `projectId`. The render turns this
 * into a link through the tab's own filter-preserving builder.
 */
export interface FoldedTarget { group: ReceiptGroup; owner?: string }

export interface FoldedLine {
    key: string;
    text: string;
    count: number;
    /** The row ids on this line. `count === ids.length`, and conservation is checked against these. */
    ids: string[];
    target: FoldedTarget;
}

export interface TodoPlan {
    piles: TodoPile[];
    folded: FoldedLine[];
    /** Sum of every folded line. */
    handledCount: number;
    /** Sum of every pile's ROW count. The number the digest calls "things need you". */
    needsYouCount: number;
    /**
     * Open receipt requests the loader did not load, because it takes the
     * newest 100 (receipts-data.ts). Never negative.
     *
     * This is why the "done" state is CONDITIONAL. With a full page of
     * acknowledged or held rows the piles come out empty while older, genuinely
     * actionable requests sit past the cap, and "You're done for today" would
     * be a lie told by a display limit.
     */
    notLoadedCount: number;
    /**
     * Intake groups whose loaded list came back FULL, which is the only signal
     * this page gets that there are more behind it.
     *
     * Every group is read with `take: RECEIPT_GROUP_TAKE`, so a group of
     * exactly the cap is indistinguishable from a group of five hundred. The
     * badge counts are real count queries and stay honest either way; the
     * LISTS are a window, and the done state must not be claimed over one.
     * Deliberately not a folded line: it counts groups, not rows, and adding
     * it to `handledCount` would break conservation.
     */
    cappedGroups: ReceiptGroup[];
}

/** Two weeks. Not 7: a fortnight of dump tickets is one errand repeated, and a
 * 7-day window splits that run in two, which reads worse than not rolling up at
 * all. Not 30: past two weeks a repeat stops being "the same errand again". */
export const ROLLUP_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;
const PACIFIC = "America/Los_Angeles";

// ── Copy ──────────────────────────────────────────────────────────────────

export const TODO_PILE_COPY: Record<TodoPileKey, { title: string; note: string }> = {
    "whose-card": {
        title: "Whose card was this?",
        note: "Nobody can be asked for these yet: no card number on them, or one I do not recognise. Pick whose charge it was and it moves to their name.",
    },
    "pick-the-job": {
        title: "Pick the job",
        note: "These are read and ready. Pick the job and it goes back through the normal steps.",
    },
    "better-photo": {
        title: "Needs a better photo",
        note: "I could not read these. The reason is under each one. A clearer photo of the same receipt goes back through the normal steps.",
    },
    "tell-justin": {
        title: "Tell Justin about these",
        note: "Something I do not know stopped these. Send Justin the code shown under each one.",
    },
    "ask-for-these": {
        title: "Ask for these receipts",
        note: "A charge with no receipt behind it. Ask the person, then mark it reviewed so it drops off this list.",
    },
    "checks-and-sub-bills": {
        title: "Checks and sub bills",
        note: "A check needs two things: a photo of the front, and the bill it paid. Post both the way the guide says, then mark it reviewed. These are yours, not the crew's.",
    },
};

export const TODO_COPY = {
    statNeedsYou: "Needs you today",
    statNeedsYouSub: "Rows waiting on you",
    statHandled: "Outside your list",
    statHandledSub: "Rows outside your list",
    statBooked: "Booked today",
    statBookedSub: "Receipts that reached job costing today",
    chipTodo: "To-do",
    chipEverything: "Everything",
    stripHeader: "Outside your list: {n} of these.",
    doneTitle: "You're done for today.",
    doneSub: "Nothing needs you. The other {n} are somebody else's.",
    doneSubOne: "Nothing needs you. The other one is somebody else's.",
    doneNothing: "Nothing is waiting in this queue right now.",
    pileAge: "Oldest here is {n} days old.",
    capLine: "Showing the {shown} newest of {total}.",
    capLineOwner: "Showing the {shown} newest of {total}, filtered to {owner}.",
    // NO LINK, and no promise of one. Every view of this queue is capped at
    // the same hundred rows and nothing anywhere pages past it, so "open the
    // full list" would be a button that cannot do what it says.
    notLoaded: "{n} older requests are not loaded here yet. They come up as newer ones clear.",
    notLoadedOne: "1 older request is not loaded here yet. It comes up as newer ones clear.",
    cappedGroups: "Some receipt groups have more rows than this page loads. Justin checks those.",
    noCard: "no card (office rail)",
    checkFacts: "check paid",
    checkSentence: "Needs the check photo and the bill it paid.",
    checkLink: "What to post ↗",
} as const;

/**
 * Where a check row sends a person for the procedure.
 *
 * A link, not a restatement: the guide is the canonical description of what to
 * post, so the row points at it and the two can never drift apart.
 */
export const CHECK_GUIDE_HREF = "/automation/guide#checks-what-to-post";

/** The pile age line is worth saying only once it is embarrassing. */
export const PILE_AGE_MIN_DAYS = 7;

type FoldedKey =
    | "booking" | "booked-today" | "switched-off" | "retryable" | "held" | "office-invoice"
    | "acknowledged" | "memo-signed" | "office-owner" | "bookkeeping"
    | "duplicates" | "exceptions" | "uncertain-cards";

interface FoldedCopy {
    /** Exactly one. Written out rather than pluralised by string surgery. */
    one: string;
    /** Two or more. `{n}` is the count. */
    many: string;
    target: FoldedTarget;
}

/**
 * Every fixed folded line, in render order: what the pipeline is doing first,
 * then what belongs to a named person.
 *
 * `switched-off`, `retryable` and `bookkeeping` are not in the original
 * design's table. They have to exist: a parked receipt that is not
 * the office manager's is still a row in the queue, and without a line of its
 * own it would be counted nowhere and conservation would fail.
 *
 * `switched-off` and `retryable` are two lines rather than one because they are
 * two different truths. Nothing in `RETRYABLE_REASONS` (route-state.ts) is
 * retried on a timer; `retryTargetFor` is explicitly about a MANUAL retry. So
 * "waiting on another try" would be a promise nobody is keeping, and these say
 * who presses the button instead.
 */
export const FOLDED_COPY: Record<FoldedKey, FoldedCopy> = {
    booking: {
        one: "1 is in the booking queue.",
        many: "{n} are in the booking queue.",
        target: { group: "booking" },
    },
    "booked-today": {
        one: "1 was booked today.",
        many: "{n} were booked today.",
        target: { group: "booked-today" },
    },
    "switched-off": {
        one: "1 is waiting on the booking switch. Booking is paused.",
        many: "{n} are waiting on the booking switch. Booking is paused.",
        target: { group: "needs-review" },
    },
    retryable: {
        one: "1 can be sent back through with Retry. Justin does that.",
        many: "{n} can be sent back through with Retry. Justin does that.",
        target: { group: "needs-review" },
    },
    held: {
        one: "1 has a possible document already. Justin checks that one.",
        many: "{n} have a possible document already. Justin checks those.",
        target: { group: "missing-receipts" },
    },
    "office-invoice": {
        one: "1 is an office bill. The office collects that one from the billing email.",
        many: "{n} are office bills. The office collects those from the billing email.",
        target: { group: "missing-receipts" },
    },
    acknowledged: {
        one: "1 you already marked reviewed.",
        many: "{n} you already marked reviewed.",
        target: { group: "missing-receipts" },
    },
    "memo-signed": {
        one: "1 was answered with a signed memo.",
        many: "{n} were answered with a signed memo.",
        target: { group: "missing-receipts" },
    },
    "office-owner": {
        // Checks are their own pile now, so this line covers only the rest of
        // the office rail: ACH, wires, transfers. "for now" is deliberate. It
        // is a gap with a countable size, waiting on new NO_RECEIPT_RULES
        // entries, not a permanent assignment to a person.
        one: "1 is another office charge. Justin checks that one for now.",
        many: "{n} are other office charges. Justin checks those for now.",
        target: { group: "missing-receipts", owner: "office" },
    },
    bookkeeping: {
        one: "1 is parked for a bookkeeping call. Justin checks that one.",
        many: "{n} are parked for a bookkeeping call. Justin checks those.",
        target: { group: "needs-review" },
    },
    duplicates: {
        one: "1 is a duplicate. Justin checks that one.",
        many: "{n} are duplicates. Justin checks those.",
        target: { group: "duplicates" },
    },
    exceptions: {
        one: "1 needs a QuickBooks fix. Justin or Vanessa handles that one.",
        many: "{n} need a QuickBooks fix. Justin or Vanessa handles those.",
        target: { group: "exceptions" },
    },
    "uncertain-cards": {
        one: "1 is a Chat card we are not sure landed. Justin checks that one.",
        many: "{n} are Chat cards we are not sure landed. Justin checks those.",
        target: { group: "uncertain-cards" },
    },
};

/**
 * Lines whose text quotes a value this module has never seen.
 *
 * One line PER distinct raw value, so the sentence stays true: two different
 * unknown holds are two different problems and merging them would print one
 * code beside a count that covers both.
 */
export const DYNAMIC_FOLDED_COPY = {
    "unknown-hold": {
        one: "1 is held for a reason I do not know: {raw}. Justin checks that one.",
        many: "{n} are held for a reason I do not know: {raw}. Justin checks those.",
        target: { group: "missing-receipts" } as FoldedTarget,
    },
    "unknown-resolution": {
        one: "1 was answered in a way I do not know: {raw}. Justin checks that one.",
        many: "{n} were answered in a way I do not know: {raw}. Justin checks those.",
        target: { group: "missing-receipts" } as FoldedTarget,
    },
} as const;

const FOLDED_ORDER: FoldedKey[] = [
    "booking", "booked-today", "switched-off", "retryable",
    "held", "office-invoice", "acknowledged", "memo-signed",
    "office-owner", "bookkeeping",
    "duplicates", "exceptions", "uncertain-cards",
];

/** `{n}` and friends, filled in. Kept here so no caller hand-rolls a second one. */
export function fillCopy(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        (name in values ? String(values[name]) : whole));
}

/** "{each} each · {n} charges · {total} total". Money arrives already formatted. */
export function rollUpSummary(each: string, count: number, total: string): string {
    return `${each} each · ${count} charges · ${total} total`;
}

/** "{first} to {last} · card …{tail}", or the office rail when there is no card. */
export function rollUpDates(firstDate: string, lastDate: string, cardTail: string | null): string {
    return `${firstDate} to ${lastDate} · ${cardTail ? `card …${cardTail}` : TODO_COPY.noCard}`;
}

// ── Which reasons are a human's, and whose ────────────────────────────────

type IntakeBucket = "pick-the-job" | "better-photo" | "tell-justin" | "switched-off" | "retryable" | "bookkeeping";

/** The booking switch is off. Nothing is wrong with the row and nobody presses anything. */
const SWITCHED_OFF_REASONS = new Set(["push-paused", "push-disabled"]);

/**
 * Codes a MANUAL Retry can send back through, and therefore Justin's.
 *
 * `file-missing` belongs here and not in a photo pile: `retryTargetFor` sends
 * it back to RECEIVED, so the action is the Retry button, not a new picture.
 * Kept as a literal list rather than imported from route-state.ts, which
 * carries the worker with it; the folded line only says who presses the
 * button, and the truth it depends on (that nothing here retries on a timer)
 * is stated in FOLDED_COPY.
 */
const RETRYABLE_REASONS = new Set(["ai-unavailable", "file-missing", "max-retries"]);

/** Codes that need a bookkeeping call: a duplicate judgement, a refund, a date, QuickBooks. */
const BOOKKEEPING_REASONS = new Set([
    "invalid-date", "date-implausible", "refund-or-zero", "native-qbo-reconciliation-required",
]);
const BOOKKEEPING_PREFIXES = ["weak-dup:", "strong-dup-amount-mismatch:", "vendor-mismatch:", "qbo-purchase-mismatch:"];

/**
 * Which pile (or which folded line) a parked intake row belongs to.
 *
 * `note()` in worker.ts appends `;tax-implausible` to whatever routing decided,
 * so the code being classified is the FIRST segment, exactly as
 * `describeStateReason` reads it.
 */
function intakeBucket(stateReason: string | null): IntakeBucket {
    const code = (stateReason ?? "").trim().split(";")[0].trim();
    if (code === "no-estimate") return "pick-the-job";
    if (code === "unreadable" || code === "multi-doc" || code === "multi-doc:one-page") {
        return "better-photo";
    }
    if (SWITCHED_OFF_REASONS.has(code)) return "switched-off";
    if (RETRYABLE_REASONS.has(code)) return "retryable";
    if (BOOKKEEPING_REASONS.has(code)) return "bookkeeping";
    if (BOOKKEEPING_PREFIXES.some(prefix => code.startsWith(prefix))) return "bookkeeping";
    // Unknown, or no reason at all. A human's on purpose, and its own pile: see
    // the header. Guessing "needs a better photo" would send somebody chasing a
    // photograph for something that may be a bug.
    return "tell-justin";
}

/** True when a park reason is one a non bookkeeper can act on. Unknown reasons are TRUE on purpose. */
export function isOfficeManagerReason(stateReason: string | null): boolean {
    const bucket = intakeBucket(stateReason);
    return bucket === "pick-the-job" || bucket === "better-photo" || bucket === "tell-justin";
}

/** Holds this module has words for. Anything else is quoted back, never guessed at. */
const KNOWN_HOLDS = new Set(["existing-evidence-review", "office-invoice"]);
/** Resolutions this module has words for. */
const KNOWN_RESOLUTIONS = new Set(["memo-signed"]);

/**
 * Is this charge a check or a subcontractor bill, and therefore the office
 * manager's own work rather than something to ask the crew for?
 *
 * The check test itself lives in receipt-policy.ts, next to the engine whose
 * verdict it approximates. A second regex here would be a second answer to
 * "what is a check", which is the failure this repo keeps writing comments
 * about.
 *
 * A hand set owner beats the descriptor, EXCEPT when a human set it to
 * "office": that is agreement, not an override, and treating it as one would
 * let the act of attributing a check to the office quietly delete the pile that
 * tells somebody to post it.
 *
 * `owner === "office"` is otherwise implied and deliberately not tested twice:
 * OFFICE_RAIL already contains CHECK, so a no-card check always resolves there.
 */
function isCheckPileRow(row: MissingReceiptRow): boolean {
    // `outreachHold` is optional on the row type, so this asks "no hold" rather
    // than "exactly null": an undefined field is not a hold either.
    return !row.outreachHold
        && !row.acknowledged
        && row.resolution === null
        // A carded charge is never a check.
        && row.cardTail === null
        && (!row.ownerAssigned || row.owner === "office")
        && looksLikeCheckOrSubBill(row.rawDescriptor);
}

// ── Dates ─────────────────────────────────────────────────────────────────

/** A YYYY-MM-DD day as UTC midnight, for display arithmetic only. Null when unreadable. */
function utcDay(day: string | null | undefined): number | null {
    const value = typeof day === "string" ? day.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const at = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(at) ? at : null;
}

/** Today in Pacific, as the same kind of number. "Days old" has to mean the crew's days. */
function pacificToday(now: Date): number | null {
    try {
        return utcDay(now.toLocaleDateString("en-CA", { timeZone: PACIFIC }));
    } catch {
        return null;
    }
}

/** The day an intake row is "about": what it reads as, or failing that when it landed. */
function intakeDay(row: IntakeRow): number | null {
    return utcDay(row.txnDate) ?? utcDay(row.createdAt);
}

function oldestDaysOf(days: Array<number | null>, now: Date): number | null {
    const today = pacificToday(now);
    const known = days.filter((day): day is number => day !== null);
    if (today === null || known.length === 0) return null;
    const oldest = Math.min(...known);
    return Math.max(0, Math.floor((today - oldest) / DAY_MS));
}

// ── Roll-up ───────────────────────────────────────────────────────────────

/** Charges sort by size, and a bank charge is a negative number. */
const byAmountDesc = (a: TodoRequestItem, b: TodoRequestItem) =>
    Math.abs(b.totalCents) - Math.abs(a.totalCents);

function itemOf(rows: MissingReceiptRow[]): TodoRequestItem {
    const first = rows[0];
    const dates = rows.map(row => row.postedDate).filter(date => date !== "").sort();
    return {
        key: `${first.owner}:${first.amountCents}:${first.id}`,
        rows,
        amountCentsEach: first.amountCents,
        totalCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
        payee: first.payee,
        owner: first.owner,
        firstDate: dates[0] ?? first.postedDate,
        lastDate: dates[dates.length - 1] ?? first.postedDate,
    };
}

/**
 * Same owner, same card, same normalised payee, same cents, span within
 * `windowDays`. Groups of one pass through as an item holding a single row.
 *
 * The CARD is part of the identity, not decoration: the summary line prints one
 * card tail, so merging two cards would print a tail that is wrong for half the
 * rows underneath it.
 *
 * Never rolls up across people: the action is "ask this person", and a merged
 * line has nobody to ask. Never rolls up a row whose payee normalises to
 * nothing or whose date will not parse either, because then the only thing left
 * matching is the amount, and a coincidence of amount is not a repeat.
 */
export function rollUpRepeats(
    rows: readonly MissingReceiptRow[],
    windowDays: number = ROLLUP_WINDOW_DAYS,
): TodoRequestItem[] {
    const groups = new Map<string, MissingReceiptRow[]>();
    const singles: MissingReceiptRow[] = [];

    for (const row of rows) {
        const payee = normalizePayee(row.payee ?? "");
        if (payee === "" || utcDay(row.postedDate) === null) {
            singles.push(row);
            continue;
        }
        // JSON, not a delimiter: a separator character that can appear inside a
        // payee is a collision, and a literal NUL makes this file binary to
        // git, grep and every diff tool.
        const key = JSON.stringify([row.owner, row.cardTail, payee, row.amountCents]);
        const bucket = groups.get(key);
        if (bucket) bucket.push(row);
        else groups.set(key, [row]);
    }

    const items: TodoRequestItem[] = singles.map(row => itemOf([row]));
    for (const bucket of groups.values()) {
        // Oldest first, then greedy runs: a candidate joins the open run while
        // the run still spans no more than the window, and otherwise starts a
        // new one. Nothing is ever dropped by the split.
        const sorted = [...bucket].sort((a, b) => (a.postedDate < b.postedDate ? -1 : a.postedDate > b.postedDate ? 1 : 0));
        let run: MissingReceiptRow[] = [];
        for (const row of sorted) {
            const start = run.length > 0 ? utcDay(run[0].postedDate) : null;
            const here = utcDay(row.postedDate);
            if (start !== null && here !== null && here - start <= windowDays * DAY_MS) {
                run.push(row);
            } else {
                if (run.length > 0) items.push(itemOf(run));
                run = [row];
            }
        }
        if (run.length > 0) items.push(itemOf(run));
    }
    return items;
}

// ── The plan ──────────────────────────────────────────────────────────────

function pileOf(
    key: TodoPileKey,
    items: TodoItem[],
    days: Array<number | null>,
    now: Date,
): TodoPile {
    return {
        key,
        title: TODO_PILE_COPY[key].title,
        note: TODO_PILE_COPY[key].note,
        items,
        rowCount: items.reduce((sum, item) => sum + (item.kind === "intake" ? 1 : item.item.rows.length), 0),
        oldestDays: items.length === 0 ? null : oldestDaysOf(days, now),
    };
}

/**
 * Intake rows, each seen ONCE, in a fixed precedence.
 *
 * `exceptions` wins because it is the only group selected by evidence of a real
 * QuickBooks Purchase rather than by state: a row that is both an exception and
 * something else is an exception first, and must never be drawn as routine work
 * in a pile.
 */
function dedupedIntakeGroups(queue: ReceiptQueue): Array<[FoldedKey | "needs-job" | "needs-review", IntakeRow[]]> {
    const seen = new Set<string>();
    const take = (rows: IntakeRow[]) => rows.filter(row => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
    });
    return [
        ["exceptions", take(queue.exceptions)],
        ["booking", take(queue.booking)],
        ["booked-today", take(queue.bookedToday)],
        ["duplicates", take(queue.duplicates)],
        ["needs-job", take(queue.needsJob)],
        ["needs-review", take(queue.needsReview)],
    ];
}

/**
 * Groups whose loaded list came back exactly full.
 *
 * That is the only evidence available here that more rows exist: every list is
 * read with `take: RECEIPT_GROUP_TAKE` and none of them pages. A group at the
 * cap might hold exactly a hundred rows, in which case this over-reports by
 * one line of hedging, which is the right way round to be wrong.
 */
function cappedIntakeGroups(queue: ReceiptQueue): ReceiptGroup[] {
    const groups: Array<[ReceiptGroup, { length: number }]> = [
        ["needs-job", queue.needsJob],
        ["needs-review", queue.needsReview],
        ["booking", queue.booking],
        ["booked-today", queue.bookedToday],
        ["duplicates", queue.duplicates],
        ["exceptions", queue.exceptions],
        ["uncertain-cards", queue.uncertainCards],
    ];
    return groups.filter(([, rows]) => rows.length >= RECEIPT_GROUP_TAKE).map(([group]) => group);
}

/** The whole view, from data fetchReceiptQueue already returns. Pure: no clock except `now`. */
export function planTodo(queue: ReceiptQueue, now: Date = new Date()): TodoPlan {
    /** Folded row ids, per line key. Counts are derived, never tracked separately. */
    const folds = new Map<string, string[]>();
    const fold = (key: string, id: string) => {
        const ids = folds.get(key);
        if (ids) ids.push(id);
        else folds.set(key, [id]);
    };

    // ── Intake rows, deduplicated. NEEDS_JOB is hers whatever the reason says;
    //    a parked row is routed by its reason, and an unrecognised one stays
    //    hers.
    const pickJob: IntakeRow[] = [];
    const betterPhoto: IntakeRow[] = [];
    const tellJustin: IntakeRow[] = [];
    for (const [group, rows] of dedupedIntakeGroups(queue)) {
        for (const row of rows) {
            if (group === "needs-job") { pickJob.push(row); continue; }
            if (group !== "needs-review") { fold(group, row.id); continue; }
            const bucket = intakeBucket(row.stateReason);
            if (bucket === "pick-the-job") pickJob.push(row);
            else if (bucket === "better-photo") betterPhoto.push(row);
            else if (bucket === "tell-justin") tellJustin.push(row);
            else fold(bucket, row.id);
        }
    }
    for (const card of queue.uncertainCards) fold("uncertain-cards", card.id);

    // ── Open receipt requests. First match wins, and the order is the point:
    //    anything already dealt with, or on hold for somebody else, leaves the
    //    list before whose-card, checks and ask-for-these see it.
    //
    //    A HELD check stays folded on purpose. A hold means a document of the
    //    same amount exists within a month that the matcher could not tie, and
    //    on a $3,500 check that is quite likely the sub's own bill. Nothing
    //    here can reconcile two documents yet, and the only button on the row
    //    would be "Mark reviewed", so surfacing it would teach a person to
    //    acknowledge away a genuine unmatched charge.
    const whoseCard: MissingReceiptRow[] = [];
    const askForThese: MissingReceiptRow[] = [];
    const checks: MissingReceiptRow[] = [];
    for (const row of queue.missingReceipts) {
        const hold = row.outreachHold ?? null;
        const resolution = row.resolution ?? null;
        if (row.acknowledged) fold("acknowledged", row.id);
        else if (resolution === "memo-signed") fold("memo-signed", row.id);
        else if (resolution !== null && !KNOWN_RESOLUTIONS.has(resolution)) fold(`unknown-resolution:${resolution}`, row.id);
        else if (hold === "existing-evidence-review") fold("held", row.id);
        else if (hold === "office-invoice") fold("office-invoice", row.id);
        else if (hold !== null && hold !== "" && !KNOWN_HOLDS.has(hold)) fold(`unknown-hold:${hold}`, row.id);
        else if (isCheckPileRow(row)) checks.push(row);
        else if (row.owner === "unattributed" || row.owner === "unassigned") whoseCard.push(row);
        else if (row.owner === "office") fold("office-owner", row.id);
        else askForThese.push(row);
    }

    const byOwnerThenAmount = (a: TodoRequestItem, b: TodoRequestItem) =>
        ownerRank(a.owner) - ownerRank(b.owner) || byAmountDesc(a, b);
    const intakeByAmount = (a: IntakeRow, b: IntakeRow) =>
        Math.abs(b.totalCents ?? 0) - Math.abs(a.totalCents ?? 0);

    const whoseCardItems = rollUpRepeats(whoseCard).sort(byOwnerThenAmount);
    const askItems = rollUpRepeats(askForThese).sort(byOwnerThenAmount);
    const checkItems = rollUpRepeats(checks).sort(byAmountDesc);
    const pickJobRows = [...pickJob].sort(intakeByAmount);
    const betterPhotoRows = [...betterPhoto].sort(intakeByAmount);
    const tellJustinRows = [...tellJustin].sort(intakeByAmount);

    const requestDays = (items: TodoRequestItem[]) =>
        items.flatMap(item => item.rows.map(row => utcDay(row.postedDate)));

    const piles: TodoPile[] = [
        pileOf("whose-card", whoseCardItems.map(item => ({ kind: "request" as const, item })), requestDays(whoseCardItems), now),
        pileOf("pick-the-job", pickJobRows.map(row => ({ kind: "intake" as const, row })), pickJobRows.map(intakeDay), now),
        pileOf("better-photo", betterPhotoRows.map(row => ({ kind: "intake" as const, row })), betterPhotoRows.map(intakeDay), now),
        pileOf("tell-justin", tellJustinRows.map(row => ({ kind: "intake" as const, row })), tellJustinRows.map(intakeDay), now),
        pileOf("ask-for-these", askItems.map(item => ({ kind: "request" as const, item })), requestDays(askItems), now),
        // LAST, despite holding the biggest amounts. Every other pile finishes
        // inside the five minutes this page is for; a check waits on a third
        // party to send a bill. Sorting it by dollars to the top would bury the
        // routine work under the same $3,500 line every morning for a month.
        pileOf("checks-and-sub-bills", checkItems.map(item => ({ kind: "request" as const, item })), requestDays(checkItems), now),
    ];

    const line = (key: string, copy: FoldedCopy | (typeof DYNAMIC_FOLDED_COPY)[keyof typeof DYNAMIC_FOLDED_COPY], raw: string): FoldedLine => {
        const ids = folds.get(key) ?? [];
        return {
            key,
            text: fillCopy(ids.length === 1 ? copy.one : copy.many, { n: ids.length, raw }),
            count: ids.length,
            ids,
            target: copy.target,
        };
    };

    const dynamic = [...folds.keys()]
        .filter(key => key.startsWith("unknown-hold:") || key.startsWith("unknown-resolution:"))
        .sort()
        .map(key => {
            const kind = key.startsWith("unknown-hold:") ? "unknown-hold" : "unknown-resolution";
            return line(key, DYNAMIC_FOLDED_COPY[kind], key.slice(kind.length + 1));
        });

    const folded: FoldedLine[] = [
        ...FOLDED_ORDER.filter(key => (folds.get(key)?.length ?? 0) > 0).map(key => line(key, FOLDED_COPY[key], "")),
        ...dynamic,
    ];

    return {
        piles,
        folded,
        handledCount: folded.reduce((sum, entry) => sum + entry.count, 0),
        needsYouCount: piles.reduce((sum, pile) => sum + pile.rowCount, 0),
        notLoadedCount: Math.max(0, queue.counts.missingReceipts - queue.counts.missingReceiptsShown),
        cappedGroups: cappedIntakeGroups(queue),
    };
}

/**
 * Exactly the storagePaths the To-do view will draw, for the batched signer.
 *
 * Derived from the plan rather than from the queue, so "what we draw" and "what
 * we sign" cannot answer differently. Request rows carry no object of their own.
 */
export function todoStoragePaths(plan: TodoPlan): string[] {
    const paths = new Set<string>();
    for (const pile of plan.piles) {
        for (const item of pile.items) {
            if (item.kind === "intake" && item.row.storagePath) paths.add(item.row.storagePath);
        }
    }
    return [...paths];
}
