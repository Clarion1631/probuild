/**
 * The To-do view's planner: what on the Receipts tab is actually a human's to
 * do, and what the system is already handling.
 *
 * PURE. No Prisma, no fetch, no clock except the `now` that is handed in. It
 * reads only what `fetchReceiptQueue` already returns, which is the whole point
 * of the design: this view costs no extra query and no extra column.
 *
 * TWO INVARIANTS, both covered by tests/receipt-todo-view.test.ts:
 *
 * 1. CONSERVATION. Every row the queue hands this module lands in exactly one
 *    pile or exactly one folded line. Never both, never neither. A row that
 *    falls through every rule is a row that silently vanishes off the only page
 *    that lists it, which is the worst thing this view could do.
 * 2. AN UNKNOWN REASON IS A HUMAN'S. A `stateReason` this module does not
 *    recognise goes INTO the "Needs a better photo" pile rather than being
 *    folded away. Folding an unknown reason is how a brand new failure mode
 *    goes quiet for a month. The row still draws `describeStateReason`'s
 *    fallback, which is the raw code, so it can be read out to a developer.
 *
 * COUNTING. `needsYouCount` counts ROWS, not rolled-up items: a run of ten
 * identical charges is one line on screen but ten charges with no receipt, and
 * the stat card it feeds says "Rows waiting on you". Conservation is a
 * statement about rows too, so the two agree by construction.
 *
 * ENTRIES, NOT IDS. `fetchReceiptQueue`'s `exceptions` group is deliberately
 * not state-scoped (receipts-data.ts), so one intake row can appear in both
 * `exceptions` and another group. This module counts what it is given, group by
 * group, exactly as the chip badges do. The reasons that actually put a row in
 * `exceptions` (`native-qbo-reconciliation-required`, `qbo-purchase-mismatch:`)
 * are folded here anyway, so an overlapping row is never drawn as Marge's.
 *
 * HOUSE STYLE for every string below: small words, short sentences, no em dash,
 * no en dash, and no " - " used as punctuation. tests/receipt-todo-view.test.ts
 * asserts it over every exported copy constant rather than trusting review.
 */
import { normalizePayee } from "@/lib/bank-ledger";
import { looksLikeCheckOrSubBill } from "@/lib/receipt-policy";
import type { IntakeRow, MissingReceiptRow, ReceiptQueue } from "./receipts-data";
import { ownerRank, type ReceiptGroup } from "./receipts-filters";

export type TodoPileKey =
    | "whose-card" | "pick-the-job" | "better-photo" | "ask-for-these" | "checks-and-sub-bills";

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

export interface FoldedLine { key: string; text: string; count: number; href: string | null; }

export interface TodoPlan {
    piles: TodoPile[];
    folded: FoldedLine[];
    /** Sum of every folded line. The number in "The system is handling N of these." */
    handledCount: number;
    /** Sum of every pile's ROW count. The number the digest calls "things need you". */
    needsYouCount: number;
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
        note: "No card number on these, so nobody can be asked yet. Pick whose charge it was and it joins their list.",
    },
    "pick-the-job": {
        title: "Pick the job",
        note: "These are read and ready. Each one books itself as soon as it has a job.",
    },
    "better-photo": {
        title: "Needs a better photo",
        note: "I could not read these. Ask for a clearer picture and the new one books itself.",
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
    statHandled: "The system is handling",
    statHandledSub: "Nothing to do on these",
    statBooked: "Booked today",
    statBookedSub: "Receipts that reached job costing today",
    chipTodo: "To-do",
    chipEverything: "Everything",
    stripHeader: "The system is handling {n} of these.",
    doneTitle: "You're done for today.",
    doneSub: "Nothing needs you. The system is handling {n}.",
    doneNothing: "Nothing is waiting anywhere right now.",
    pileAge: "Oldest here is {n} days old.",
    capLine: "Showing the {shown} newest of {total}.",
    capLineOwner: "Showing the {shown} newest of {total}, filtered to {owner}.",
    exceptionsNative: "Nothing new lands here while receipts book into ProBuild.",
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
    | "booking" | "booked-today" | "retrying" | "held" | "office-invoice"
    | "acknowledged" | "memo-signed" | "office-owner" | "bookkeeping"
    | "duplicates" | "exceptions" | "uncertain-cards";

interface FoldedCopy {
    /** Exactly one. Written out rather than pluralised by string surgery. */
    one: string;
    /** Two or more. `{n}` is the count. */
    many: string;
    group: ReceiptGroup;
    owner?: string;
}

/**
 * Every folded line, in render order: what the system is doing first, then what
 * belongs to a named person.
 *
 * `retrying` and `bookkeeping` are not in the design's own table. They have to
 * exist: a parked receipt that is not Marge's (a weak duplicate, a refund, an
 * unreadable date, a reader outage) is still a row in the queue, and without a
 * line of its own it would be counted nowhere and conservation would fail. One
 * line says the system will try again; the other says a person will look.
 */
export const FOLDED_COPY: Record<FoldedKey, FoldedCopy> = {
    booking: {
        one: "1 is booking right now.",
        many: "{n} are booking right now.",
        group: "booking",
    },
    "booked-today": {
        one: "1 was booked today.",
        many: "{n} were booked today.",
        group: "booked-today",
    },
    retrying: {
        one: "1 is waiting on another try. Nothing to do on that one.",
        many: "{n} are waiting on another try. Nothing to do on those.",
        group: "needs-review",
    },
    held: {
        one: "1 has a document already. Justin checks that one.",
        many: "{n} have a document already. Justin checks those.",
        group: "missing-receipts",
    },
    "office-invoice": {
        one: "1 is an office bill. The office collects that one from the billing email.",
        many: "{n} are office bills. The office collects those from the billing email.",
        group: "missing-receipts",
    },
    acknowledged: {
        one: "1 you already marked reviewed.",
        many: "{n} you already marked reviewed.",
        group: "missing-receipts",
    },
    "memo-signed": {
        one: "1 was answered with a signed memo.",
        many: "{n} were answered with a signed memo.",
        group: "missing-receipts",
    },
    "office-owner": {
        // Checks are their own pile now, so this line covers only the rest of
        // the office rail: ACH, wires, transfers. "for now" is deliberate. It
        // is a gap with a countable size, waiting on new NO_RECEIPT_RULES
        // entries, not a permanent assignment to a person.
        one: "1 is another office charge. Justin checks that one for now.",
        many: "{n} are other office charges. Justin checks those for now.",
        group: "missing-receipts",
        owner: "office",
    },
    bookkeeping: {
        one: "1 is parked for a bookkeeping call. Justin checks that one.",
        many: "{n} are parked for a bookkeeping call. Justin checks those.",
        group: "needs-review",
    },
    duplicates: {
        one: "1 is a duplicate. Justin checks that one.",
        many: "{n} are duplicates. Justin checks those.",
        group: "duplicates",
    },
    exceptions: {
        one: "1 needs a QuickBooks fix. Justin or Vanessa handles that one.",
        many: "{n} need a QuickBooks fix. Justin or Vanessa handles those.",
        group: "exceptions",
    },
    "uncertain-cards": {
        one: "1 is a Chat card we are not sure landed. Justin checks that one.",
        many: "{n} are Chat cards we are not sure landed. Justin checks those.",
        group: "uncertain-cards",
    },
};

const FOLDED_ORDER: FoldedKey[] = [
    "booking", "booked-today", "retrying",
    "held", "office-invoice", "acknowledged", "memo-signed", "office-owner",
    "bookkeeping", "duplicates", "exceptions", "uncertain-cards",
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

type IntakeBucket = "pick-the-job" | "better-photo" | "retrying" | "bookkeeping";

/** Codes the system itself will have another go at. Nothing for a person to do. */
const RETRY_REASONS = new Set(["ai-unavailable", "max-retries", "push-paused", "push-disabled"]);

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
    if (code === "unreadable" || code === "file-missing" || code === "multi-doc" || code === "multi-doc:one-page") {
        return "better-photo";
    }
    if (RETRY_REASONS.has(code)) return "retrying";
    if (BOOKKEEPING_REASONS.has(code)) return "bookkeeping";
    if (BOOKKEEPING_PREFIXES.some(prefix => code.startsWith(prefix))) return "bookkeeping";
    // Unknown, or no reason at all. Hers on purpose: see the header.
    return "better-photo";
}

/** True when a park reason is one a non bookkeeper can act on. Unknown reasons are TRUE on purpose. */
export function isOfficeManagerReason(stateReason: string | null): boolean {
    const bucket = intakeBucket(stateReason);
    return bucket === "pick-the-job" || bucket === "better-photo";
}

/**
 * Is this charge a check or a subcontractor bill, and therefore Marge's own
 * work rather than something to ask the crew for?
 *
 * The check test itself lives in receipt-policy.ts, next to the engine whose
 * verdict it approximates. A second regex here would be a second answer to
 * "what is a check", which is the failure this repo keeps writing comments
 * about.
 *
 * `owner === "office"` is implied and deliberately NOT tested: OFFICE_RAIL
 * already contains CHECK, so a no-card check always resolves to office.
 * Repeating it here would be a second copy of that rule too.
 */
function isCheckPileRow(row: MissingReceiptRow): boolean {
    // `outreachHold` is optional on the row type, so this asks "no hold"
    // rather than "exactly null": an undefined field is not a hold either.
    return !row.outreachHold
        && !row.acknowledged
        && row.resolution === null
        // A carded charge is never a check, and a hand set owner beats a
        // descriptor every time: somebody already answered this question.
        && row.cardTail === null
        && !row.ownerAssigned
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
 * Same owner, same normalised payee, same cents, span within `windowDays`.
 * Groups of one pass through as an item holding a single row.
 *
 * Never rolls up across people: the action is "ask this person", and a merged
 * line has nobody to ask. Never rolls up a row whose payee normalises to
 * nothing or whose date will not parse either, because then the only thing
 * left matching is the amount, and a coincidence of amount is not a repeat.
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
        const key = `${row.owner} ${payee} ${row.amountCents}`;
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

function foldedHref(copy: FoldedCopy): string {
    const params = new URLSearchParams();
    params.set("tab", "receipts");
    params.set("group", copy.group);
    if (copy.owner) params.set("owner", copy.owner);
    return `/automation?${params.toString()}`;
}

/** The whole view, from data fetchReceiptQueue already returns. Pure: no clock except `now`. */
export function planTodo(queue: ReceiptQueue, now: Date = new Date()): TodoPlan {
    const counts: Record<FoldedKey, number> = {
        booking: queue.booking.length,
        "booked-today": queue.bookedToday.length,
        retrying: 0,
        held: 0,
        "office-invoice": 0,
        acknowledged: 0,
        "memo-signed": 0,
        "office-owner": 0,
        bookkeeping: 0,
        duplicates: queue.duplicates.length,
        exceptions: queue.exceptions.length,
        "uncertain-cards": queue.uncertainCards.length,
    };

    // ── Intake rows. NEEDS_JOB is hers whatever the reason says; a parked row
    //    is routed by its reason, and an unrecognised one stays hers.
    const pickJob: IntakeRow[] = [...queue.needsJob];
    const betterPhoto: IntakeRow[] = [];
    for (const row of queue.needsReview) {
        const bucket = intakeBucket(row.stateReason);
        if (bucket === "pick-the-job") pickJob.push(row);
        else if (bucket === "better-photo") betterPhoto.push(row);
        else counts[bucket] += 1;
    }

    // ── Open receipt requests. First match wins, and the order is the point:
    //    anything she has already dealt with, or that is on hold for somebody
    //    else, leaves her list before whose-card and ask-for-these see it.
    //
    //    A `resolution` that is not "memo-signed" deliberately falls through to
    //    the owner rules instead of folding. An unrecognised resolution is a new
    //    shape, and a new shape must stay visible.
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
        if (row.acknowledged) counts.acknowledged += 1;
        else if (row.resolution === "memo-signed") counts["memo-signed"] += 1;
        else if (row.outreachHold === "existing-evidence-review") counts.held += 1;
        else if (row.outreachHold === "office-invoice") counts["office-invoice"] += 1;
        else if (isCheckPileRow(row)) checks.push(row);
        else if (row.owner === "unattributed" || row.owner === "unassigned") whoseCard.push(row);
        else if (row.owner === "office") counts["office-owner"] += 1;
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

    const requestDays = (items: TodoRequestItem[]) =>
        items.flatMap(item => item.rows.map(row => utcDay(row.postedDate)));

    const piles: TodoPile[] = [
        pileOf("whose-card", whoseCardItems.map(item => ({ kind: "request" as const, item })), requestDays(whoseCardItems), now),
        pileOf("pick-the-job", pickJobRows.map(row => ({ kind: "intake" as const, row })), pickJobRows.map(intakeDay), now),
        pileOf("better-photo", betterPhotoRows.map(row => ({ kind: "intake" as const, row })), betterPhotoRows.map(intakeDay), now),
        pileOf("ask-for-these", askItems.map(item => ({ kind: "request" as const, item })), requestDays(askItems), now),
        // LAST, despite holding the biggest amounts. Every other pile finishes
        // inside the five minutes this page is for; a check waits on a third
        // party to send a bill. Sorting it by dollars to the top would bury the
        // routine work under the same $3,500 line every morning for a month.
        pileOf("checks-and-sub-bills", checkItems.map(item => ({ kind: "request" as const, item })), requestDays(checkItems), now),
    ];

    const folded: FoldedLine[] = FOLDED_ORDER
        .filter(key => counts[key] > 0)
        .map(key => {
            const copy = FOLDED_COPY[key];
            const count = counts[key];
            return {
                key,
                text: count === 1 ? copy.one : fillCopy(copy.many, { n: count }),
                count,
                href: foldedHref(copy),
            };
        });

    return {
        piles,
        folded,
        handledCount: folded.reduce((sum, line) => sum + line.count, 0),
        needsYouCount: piles.reduce((sum, pile) => sum + pile.rowCount, 0),
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
