/**
 * Missing-receipt request matcher (Phase 2 §3).
 *
 * ONE question: for each bank debit that policy says owes a receipt, does any
 * receipt evidence exist yet? If not, a human chase request opens. If evidence
 * appears, it closes. If the evidence disappears again, it reopens.
 *
 * PURE: no Prisma, no fetch, no clock of its own — the caller supplies rows
 * and `now`. The cron (`/api/cron/receipt-requests`) does the I/O and applies
 * the verdicts through `evaluateReviewIssue`.
 *
 * THE HOUSE RULE THIS DOES NOT BREAK. `receipt-match.ts` matches BankLine →
 * Expense on EXACT ids only, and that rule guards `BankLine.state` advancement
 * and link writes. The match below is deliberately fuzzier (exact cents,
 * ±2 days, token-overlap payee) because its ONLY power is to open or close a
 * request for a human. It never advances `BankLine.state`, never writes a
 * link, and never touches money. A false close silences one chase; the
 * register and variance surfaces still show the unmatched purchase.
 *
 * WHY AMOUNT+DATE ALONE IS NEVER ENOUGH: the Chevron/Cash App lesson
 * (prisma/schema.prisma:2698). Two unrelated $46.00 charges on the same day is
 * an ordinary Tuesday for this business. Payee agreement is required, and an
 * EMPTY normalized payee is not an identity (bank-ledger.ts) — it matches
 * nothing, ever.
 */
import { classifyReceiptRequirement, resolveReceiptOwner, type ReceiptOwner } from "./receipt-policy";
import { normalizePayee } from "./bank-ledger";
import { intakeArtifactIsVerified } from "./receipt-intake/route-state";

/** The one targetType these issues use. targetKey is the BankLine id. */
export const RECEIPT_REQUEST_TARGET_TYPE = "bank-line";

/**
 * A line younger than this is not chased. It is the grace window: a receipt
 * photographed on site still has to travel the intake pipeline, and QBO's own
 * register lags the swipe.
 */
export const RECEIPT_REQUEST_GRACE_DAYS = 3;

/** Date agreement window, in calendar days either side of the posted date. */
export const RECEIPT_MATCH_DATE_SLOP_DAYS = 2;

/** ReceiptIntake states that can never satisfy a bank line. */
export const DEAD_INTAKE_STATES: ReadonlySet<string> = new Set(["DUPLICATE", "VOID", "NON_RECEIPT"]);

export interface ReceiptRequestBankLine {
    id: string;
    /** YYYY-MM-DD. */
    postedDate: string;
    /** Signed: negative = money out. */
    amountCents: number;
    rawDescriptor: string;
    checkNumber?: string | null;
}

/** An Expense, already reduced to integer cents by the caller. */
export interface ReceiptEvidenceExpense {
    /** Stable row id. Evidence is assigned to at most ONE bank line, and the
     * tie-break has to be deterministic across runs — see assignEvidence. */
    id: string;
    /** The QuickBooks Purchase this expense came from, when it has one. Used to
     * fold it together with the ReceiptIntake that created it — see
     * evidenceUnitKey. */
    qbPurchaseId?: string | null;
    /**
     * Does this Expense actually PROVE a receipt exists?
     *
     * The 4-hourly QBO sync creates an Expense for every finalized purchase,
     * receipt or no receipt. Counting those as evidence closed exactly the
     * cases this chaser exists to find: a card charge that reached QuickBooks
     * and never got its receipt would silently satisfy its own bank line. Only
     * an Expense carrying a `receiptUrl`, or one linked to a ReceiptIntake
     * (which is a receipt by construction), is evidence.
     */
    hasReceipt: boolean;
    /** POSITIVE cents (an Expense's amount is a magnitude, not a signed posting). */
    amountCents: number;
    /** YYYY-MM-DD, or null when the expense has no date. */
    date: string | null;
    vendor: string | null;
}

export interface ReceiptEvidenceIntake {
    id: string;
    /**
     * Why the row is parked, when it is.
     *
     * A ROW IS NOT A RECEIPT. Two park reasons mean the document itself could
     * not be verified — its bytes are gone from storage, or they no longer hash
     * to what was checked at intake — and an intake in either state proves
     * nothing about whether a receipt exists. Counting one as evidence closes
     * the chase for a charge whose receipt is exactly what is missing, and
     * nobody is ever asked for it again. `intakeArtifactIsVerified` is the same
     * predicate book.ts writes those reasons with, so the two cannot drift.
     */
    stateReason?: string | null;
    /** Set once the intake booked. Folds this row together with the Expense it
     * produced — see evidenceUnitKey. */
    expenseId?: string | null;
    qbPurchaseId?: string | null;
    totalCents: number | null;
    /** YYYY-MM-DD, or null. */
    txnDate: string | null;
    vendor: string | null;
    state: string;
}

export interface MissingReceiptDisplayDetails {
    owner: ReceiptOwner;
    cardTail: string | null;
    postedDate: string;
    amountCents: number;
    payee: string;
    rawDescriptor: string;
    /** Stable across generations; safe inside a Chat cardId and a PDF filename. */
    fingerprint: string;
    [key: string]: unknown;
}

export interface ReceiptRequestPlan {
    open: Array<{ targetKey: string; displayDetails: MissingReceiptDisplayDetails }>;
    close: string[];
    /**
     * Lines deliberately left undecided because their evidence window was not
     * fully loaded. Reported, not hidden: a caller that sees these knows its
     * window was too narrow, and the cursor must not advance past them.
     */
    undecided: string[];
}

export interface ReceiptRequestInput {
    bankLines: readonly ReceiptRequestBankLine[];
    /**
     * The date range, inclusive, over which `expenses` and `intakes` are
     * COMPLETE — normally the cohort's full span widened by the match window.
     *
     * A line whose ±2-day evidence window falls outside this range emits NO
     * decision at all. Judging it would be judging it against evidence the
     * caller never loaded: "no receipt found" would mean "we did not look",
     * and that opens a chase for a charge that is perfectly well documented.
     * Omit it only when the caller genuinely loaded every row.
     */
    evidenceLoadedFrom?: string | null;
    evidenceLoadedTo?: string | null;
    expenses: readonly ReceiptEvidenceExpense[];
    intakes: readonly ReceiptEvidenceIntake[];
    /** targetKeys of bank-line issues that are currently OPEN (clearedAt null). */
    openIssueKeys: readonly string[];
    /**
     * targetKeys whose issue carries a RESOLUTION (a signed memo, most often).
     * Open or cleared — either way the question has been answered, and the
     * matcher must not re-ask it. Includes cleared issues on purpose: those are
     * exactly the ones a re-open would resurrect.
     */
    resolvedIssueKeys?: readonly string[];
    now: Date;
}

/**
 * Rails the OFFICE genuinely owns: an ACH, a wire, a check, a transfer. These
 * legitimately have no card tail, so "office" is a real answer for them rather
 * than a shrug. Everything else without a tail is `unattributed`.
 */
const OFFICE_RAIL = /\b(?:ACH|WIRE|CHECK|TRANSFER|DEPOSIT|ONLINE PMT|BILL PAY|EFT|DIRECT DEP|PAYROLL)\b/i;

/**
 * THE owner of a missing-receipt item: a human's assignment when there is one,
 * otherwise the one derived from the descriptor.
 *
 * Three surfaces read this — the Receipts tab's filter, the nightly matcher and
 * the cards cron — and each used to spell it its own way. When they disagreed,
 * Marge could assign an owner, see the item move under that owner on the page,
 * and it would still never reach their card: the cron was reading the derived
 * value. One function, or it will drift again.
 */
export function effectiveOwner(details: { owner?: unknown; ownerOverride?: unknown } | null | undefined): string {
    const override = typeof details?.ownerOverride === "string" ? details.ownerOverride.trim() : "";
    if (override) return override;
    const derived = typeof details?.owner === "string" ? details.owner.trim() : "";
    return derived || "unassigned";
}

/** Owners a human may assign an unattributed charge to. */
export const RECEIPT_OWNER_CHOICES: string[] = ["CJ", "Richard", "Justin", "office"];

export function isOfficeRail(rawDescriptor: string): boolean {
    return OFFICE_RAIL.test(rawDescriptor ?? "");
}

/**
 * Every bank line that could plausibly claim the SAME evidence as `line`.
 *
 * NOTE: this is the QUERY filter — deliberately wide, because a query has to be
 * expressible in SQL. The true competition set is a CONNECTED COMPONENT (see
 * `evidenceComponents`), which this filter is only guaranteed to contain, not
 * to equal. Being too wide costs a few extra rows in a recompute; being too
 * narrow reintroduces the bug.
 */
export function competingLineFilter(line: { amountCents: number; postedDate: string }) {
    const day = dayNumber(line.postedDate);
    // Wide enough to contain a whole chain: A and C never touch directly but
    // both touch B, so a ±2-day filter around A would miss C entirely.
    const span = RECEIPT_MATCH_DATE_SLOP_DAYS * 4;
    return {
        amountCents: line.amountCents,
        from: day === null ? line.postedDate : ymdOf(day - span),
        to: day === null ? line.postedDate : ymdOf(day + span),
    };
}

function ymdOf(dayNumberValue: number): string {
    return new Date(dayNumberValue * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The widest date gap at which two lines can still want the SAME receipt.
 *
 * Evidence has to land within ±2 days of a line to be a candidate for it, so
 * two lines can only share a candidate when their own dates are at most 4 days
 * apart. Wider than that and no single receipt can reach both.
 */
export const COMPETING_LINE_ADJACENCY_DAYS = RECEIPT_MATCH_DATE_SLOP_DAYS * 2;

export interface CompetingLine {
    id: string;
    /** YYYY-MM-DD. */
    postedDate: string;
    amountCents: number;
}

export interface LineComponent {
    /**
     * `"<earliest posted date>|<lowest line id>"`. Sorts chronologically as a
     * plain string, is unique (the lowest id belongs to exactly one component),
     * and survives a line being deleted — which is what makes it usable as a
     * durable resume cursor.
     */
    key: string;
    lineIds: string[];
}

/**
 * Group every line in the window into COMPETITION COMPONENTS, before any paging.
 *
 * Paging by line id and then widening each page to its neighbours is not the
 * same thing, and the difference is a real bug: a group of lines competing for
 * one receipt could straddle a page boundary, so each half was matched against
 * the same evidence WITHOUT knowing about the other half, and one receipt closed
 * two charges. Components are computed over the whole window first and pages are
 * cut BETWEEN them (`pageComponents`), so a competition set is never split.
 *
 * Adjacency is same-amount and within `COMPETING_LINE_ADJACENCY_DAYS`. It is
 * TRANSITIVE by construction: A↔B and B↔C put A and C in one component even
 * when A and C are six days apart and share no candidate directly, because
 * re-housing A can free the only receipt C can reach.
 */
export function groupCompetingLines(lines: readonly CompetingLine[]): LineComponent[] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
        let root = x;
        while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
        let cursor = x;
        while (parent.get(cursor) !== undefined && parent.get(cursor) !== cursor) {
            const next = parent.get(cursor) as string;
            parent.set(cursor, root);
            cursor = next;
        }
        return root;
    };
    const union = (a: string, b: string) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(rb, ra);
    };

    for (const line of lines) parent.set(line.id, line.id);

    // Bucket by amount, then walk each bucket in date order joining NEIGHBOURS.
    // Consecutive unions are enough — transitivity does the rest, and it keeps
    // this O(n log n) instead of O(n²) on a busy amount.
    const buckets = new Map<number, CompetingLine[]>();
    for (const line of lines) {
        const bucket = buckets.get(line.amountCents);
        if (bucket) bucket.push(line);
        else buckets.set(line.amountCents, [line]);
    }
    for (const bucket of buckets.values()) {
        const dated = bucket
            .map(line => ({ line, day: dayNumber(line.postedDate) }))
            .filter((entry): entry is { line: CompetingLine; day: number } => entry.day !== null)
            .sort((a, b) => a.day - b.day || (a.line.id < b.line.id ? -1 : a.line.id > b.line.id ? 1 : 0));
        for (let i = 1; i < dated.length; i++) {
            if (dated[i].day - dated[i - 1].day <= COMPETING_LINE_ADJACENCY_DAYS) {
                union(dated[i - 1].line.id, dated[i].line.id);
            }
        }
    }

    const groups = new Map<string, CompetingLine[]>();
    for (const line of lines) {
        const root = find(line.id);
        const group = groups.get(root);
        if (group) group.push(line);
        else groups.set(root, [line]);
    }

    const components: LineComponent[] = [];
    for (const group of groups.values()) {
        let minDate = group[0].postedDate;
        let minId = group[0].id;
        for (const line of group) {
            if (line.postedDate < minDate) minDate = line.postedDate;
            if (line.id < minId) minId = line.id;
        }
        components.push({ key: `${minDate}|${minId}`, lineIds: group.map(line => line.id).sort() });
    }
    return components.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** True when a stored cursor is one of `groupCompetingLines`' component keys. */
export function isComponentKey(value: string | null | undefined): value is string {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}\|.+$/.test(value);
}

/**
 * Cut components into pages of at most `maxLines` lines, NEVER splitting one.
 *
 * A component bigger than the page size gets a page to itself rather than being
 * chopped: an over-large page costs memory, a split component costs correctness.
 */
export function pageComponents(
    components: readonly LineComponent[],
    maxLines: number,
): LineComponent[][] {
    const pages: LineComponent[][] = [];
    let current: LineComponent[] = [];
    let count = 0;
    for (const component of components) {
        if (current.length > 0 && count + component.lineIds.length > maxLines) {
            pages.push(current);
            current = [];
            count = 0;
        }
        current.push(component);
        count += component.lineIds.length;
    }
    if (current.length > 0) pages.push(current);
    return pages;
}

/**
 * Hosts a signed-memo PDF may live on: the affidavit app writes to Google Drive,
 * and anything we store ourselves is in Supabase Storage. Anywhere else is not
 * an artifact we can go back and read, which is the whole point of requiring one.
 */
const ARTIFACT_HOSTS = new Set(["drive.google.com", "docs.google.com"]);

/**
 * True when a URL points at a DURABLE copy of the signed memo.
 *
 * `signed:true` with no artifact used to be enough to close a chase, so a
 * malformed or truncated forwarder row silenced a real missing receipt and left
 * nothing behind to audit. A resolution has to be backed by something a human
 * can open a year later.
 */
export function isDurableArtifactUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return false;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (ARTIFACT_HOSTS.has(host) || host.endsWith(".googleusercontent.com")) return true;
    // Our own Supabase Storage, object paths only — a bare project URL is not a file.
    if (host.endsWith(".supabase.co") || host.endsWith(".supabase.in")) {
        return parsed.pathname.startsWith("/storage/v1/object/");
    }
    return false;
}

/**
 * The Drive file id a Drive URL points at, or null if it does not name one.
 *
 * A durable-looking URL is NOT evidence about a particular file. The bridge
 * verifies a `pdf_id` with Drive and then stores a caller-supplied `pdf_url`
 * beside it; without this check the two need not describe the same object, so a
 * caller could pass a real id it owns and a link to somebody else's document —
 * and the link is what a human clicks a year later. The stored URL must
 * therefore either BE the probed one or resolve to the id that was verified.
 *
 * Covers the shapes Drive and Docs actually mint:
 *   /file/d/<id>/view, /document/d/<id>/edit, /drive/folders/<id>,
 *   /open?id=<id>, /uc?id=<id>&export=download.
 */
export function driveFileIdFromUrl(value: unknown): string | null {
    if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return null;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== "drive.google.com" && host !== "docs.google.com") return null;
    const fromQuery = parsed.searchParams.get("id");
    if (fromQuery && DRIVE_FILE_ID.test(fromQuery)) return fromQuery;
    const path = parsed.pathname.match(/\/d\/([^/]+)/) ?? parsed.pathname.match(/\/folders\/([^/]+)/);
    if (path && DRIVE_FILE_ID.test(path[1])) return path[1];
    return null;
}

/** The id shape Drive uses. Mirrors isDriveFileId in google-drive.ts, which cannot be imported here (googleapis). */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** `"pb-<bankLineId>"` — the identity the Chat card, the sweep, and Beverly's affidavit PDF all carry. */
export function receiptRequestFingerprint(bankLineId: string): string {
    return `pb-${bankLineId}`;
}

/** The BankLine id back out of a fingerprint, or null when it isn't one of ours (Beverly mints her own). */
export function bankLineIdFromFingerprint(fingerprint: string): string | null {
    if (typeof fingerprint !== "string" || !fingerprint.startsWith("pb-")) return null;
    const id = fingerprint.slice(3);
    return id === "" ? null : id;
}

/**
 * Decimal → integer cents from the STRING form (UNIFIED-REGISTER-PLAN §2
 * cent-exactness rule). `Number(d) * 100` reintroduces binary float error on
 * exactly the values money cares about ("1234.56" * 100 → 123455.99999999999).
 * Returns null for anything that isn't a plain decimal number.
 */
export function decimalStringToCents(value: string): number | null {
    const trimmed = value.trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (!match) return null;
    const [, sign, whole, fraction = ""] = match;
    const cents = `${fraction}00`.slice(0, 2);
    const magnitude = Number(whole) * 100 + Number(cents);
    if (!Number.isSafeInteger(magnitude)) return null;
    return sign === "-" ? -magnitude : magnitude;
}

// ── Date helpers (UTC-only; a posting date is a calendar day, not an instant) ──

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(ymd: string): number | null {
    if (!YMD.test(ymd)) return null;
    const t = Date.parse(`${ymd}T00:00:00Z`);
    if (!Number.isFinite(t)) return null;
    if (new Date(t).toISOString().slice(0, 10) !== ymd) return null; // "2026-02-30"
    return Math.round(t / 86_400_000);
}

function toYmd(date: Date): string {
    return date.toISOString().slice(0, 10);
}

// ── Payee agreement ──────────────────────────────────────────────────────────

/**
 * Legal/structural noise that names no merchant. Dropped outright.
 *
 * "ACME LLC" and "ZENITH LLC" share a token; before this they "agreed" on
 * identity, which is the amount+date-alone match the Chevron/Cash App lesson
 * forbids. Store numbers go the same way — "#02516" is a branch, not a payee.
 */
export const PAYEE_STOP_WORDS: ReadonlySet<string> = new Set([
    "LLC", "INC", "CO", "CORP", "LTD", "LP", "LLP", "THE", "AND", "OF", "STORE", "STORES",
    // A web address names the same merchant as the shopfront: "HOMEDEPOT.COM"
    // and "Home Depot" are one payee, and the TLD is not part of the identity.
    "COM", "NET", "ORG", "WWW", "ONLINE",
]);

/**
 * INDUSTRY words. Real parts of a name, but they identify a TRADE rather than a
 * merchant, so one of them alone may never carry a match.
 *
 * They are still tokens: "HOME DEPOT" is a perfectly good identity as a
 * BIGRAM, and dropping DEPOT from the bigram would be as wrong as matching on
 * it alone. So generics are excluded from the exact-name comparison and kept
 * for the bigram — which is what separates HOME DEPOT from HOME GOODS, and
 * PACIFIC PLUMBING from PACIFIC SUPPLY.
 */
export const GENERIC_PAYEE_TOKENS: ReadonlySet<string> = new Set([
    "HOME", "SUPPLY", "SUPPLIES", "HARDWARE", "PLUMBING", "ELECTRIC", "ELECTRICAL",
    "MARKET", "DEPOT", "LUMBER", "BUILDING", "BUILDERS", "CENTER", "CENTRE",
    "SERVICE", "SERVICES", "COMPANY", "GENERAL", "TRUE",
]);

/**
 * Comparable tokens, generics INCLUDED: 3+ characters, not a pure number, not a
 * stop word. Store numbers, ZIPs and terminal ids are noise.
 */
export function payeeTokens(value: string): string[] {
    return (value ?? "")
        .toUpperCase()
        // Possessives BIND, they do not separate: "LOWE'S" is one word, and
        // splitting on the apostrophe produced "LOWE" — which is not the
        // "LOWES" every bank descriptor carries, so the two never agreed.
        .replace(/['’]/g, "")
        .replace(/[^A-Z0-9 ]/g, " ")
        .split(/\s+/)
        .filter(token =>
            token.length >= 3
            && !/^\d+$/.test(token)
            && !PAYEE_STOP_WORDS.has(token));
}

/** The tokens that actually NAME a merchant: `payeeTokens` minus the generics. */
export function payeeSignificantTokens(value: string): string[] {
    return payeeTokens(value).filter(token => !GENERIC_PAYEE_TOKENS.has(token));
}

/**
 * True when two payee strings name the same merchant.
 *
 * THREE ways to agree, and no others:
 *
 *   1. The names are IDENTICAL once stop words and store numbers are gone
 *      ("HOME DEPOT #4718" vs "HOME DEPOT").
 *   2. The FIRST TWO tokens agree — the leading bigram, generics included,
 *      which is why "DEPOT" is perfectly good as the second half of one.
 *   3. One side is a LONE BRAND token and it leads the other ("LOWES #02516"
 *      vs "Lowe's Home Improvement"). Guarded on the token not being an
 *      industry word, so "HOME" cannot claim "HOME DEPOT" — and it compares
 *      the other side's FIRST token only, so "ACME" cannot claim
 *      "ZENITH HARDWARE".
 *
 * A SHARED TOKEN IS NOT AN IDENTITY, and that is the change here. The old rule
 * matched on any shared token plus a 4-character prefix, so HOME DEPOT agreed
 * with HOME GOODS, PACIFIC PLUMBING with PACIFIC SUPPLY, and every
 * "… HARDWARE" with every other. Each of those closes a chase for a receipt
 * that does not exist, which is the one failure this matcher must not have — a
 * missed match only asks a human a question they can answer.
 *
 * An empty side never matches: bank-ledger's rule is that "" is not an identity.
 */
export function payeeMatches(a: string, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    const left = payeeTokens(a);
    const right = payeeTokens(b);
    if (left.length === 0 || right.length === 0) return false;

    // 1. The same name, SPACING-INSENSITIVE. Squashed, because a bank
    //    descriptor writes the merchant as one word about as often as two
    //    ("HOMEDEPOT.COM" vs "Home Depot") — and squashing is strictly tighter
    //    than token overlap: HOMEDEPOT still differs from HOMEGOODS, and
    //    PACIFICPLUMBING from PACIFICSUPPLY.
    if (left.join("") === right.join("")) return true;

    // 2. The leading bigram. Two tokens is enough identity; one is not.
    if (left.length >= 2 && right.length >= 2 && left[0] === right[0] && left[1] === right[1]) {
        return true;
    }

    // 3. A lone brand token leading the other side. The generic guard is what
    //    stops this collapsing into "shares a token" all over again.
    const lone = (tokens: string[]) => tokens.length === 1 && !GENERIC_PAYEE_TOKENS.has(tokens[0]);
    if (lone(left) && right[0] === left[0]) return true;
    if (lone(right) && left[0] === right[0]) return true;

    return false;
}

// ── Satisfaction ─────────────────────────────────────────────────────────────

interface EvidenceRow {
    id: string;
    /** Rows sharing a unit key are ONE receipt and count once. */
    unit: string;
    amountCents: number;
    date: string | null;
    vendor: string | null;
}

/**
 * The identity two rows share when they are the same physical receipt. An
 * Expense links back to its intake by `expenseId`, and both carry the QBO
 * Purchase id once booked; either is enough to fold them.
 */
export function evidenceUnitKey(row: { expenseId?: string | null; qbPurchaseId?: string | null }): string | null {
    // qbPurchaseId FIRST, and the order matters. Both rows carry it once the
    // receipt has booked, so it is the identity they reliably agree on. Keying
    // the Expense by its own id and the intake by `expenseId` only agrees when
    // the intake happens to carry the link — the email-fallback path books an
    // Expense with no intake link at all, and the two would not fold.
    if (row.qbPurchaseId) return `purchase:${row.qbPurchaseId}`;
    if (row.expenseId) return `expense:${row.expenseId}`;
    return null;
}

/**
 * Collapse rows that are the same receipt, keeping the FIRST (expenses are
 * listed first, and the Expense is the booked, authoritative form). Preserves
 * order, so the caller's determinism is unaffected.
 */
function dedupeEvidenceUnits(rows: EvidenceRow[]): EvidenceRow[] {
    const seen = new Set<string>();
    const out: EvidenceRow[] = [];
    for (const row of rows) {
        if (seen.has(row.unit)) continue;
        seen.add(row.unit);
        out.push(row);
    }
    return out;
}

function satisfies(line: ReceiptRequestBankLine, payee: string, evidence: EvidenceRow): boolean {
    // 1. Amount, exact. The line is a signed posting; the evidence is a magnitude.
    if (evidence.amountCents !== -line.amountCents) return false;
    // 2. Date within ±2 calendar days. A null date can never agree with one.
    if (!evidence.date) return false;
    const lineDay = dayNumber(line.postedDate);
    const evidenceDay = dayNumber(evidence.date);
    if (lineDay === null || evidenceDay === null) return false;
    if (Math.abs(evidenceDay - lineDay) > RECEIPT_MATCH_DATE_SLOP_DAYS) return false;
    // 3. Payee agreement. Amount + date alone is ZERO confidence.
    return payeeMatches(payee, evidence.vendor);
}

/**
 * Plan the night's opens and closes.
 *
 * A candidate is a debit, at least `RECEIPT_REQUEST_GRACE_DAYS` calendar days
 * old, that receipt policy says owes a receipt. Everything else — money in,
 * loan payments, insurance, tax payments, owner transfers, anything inside the
 * grace window — is not a candidate, and if one of those somehow carries an
 * open issue (policy changed, a credit posted late) it gets a CLOSE rather
 * than being left to nag forever.
 *
 * `open` is emitted every run for every still-unsatisfied candidate, not just
 * newly-discovered ones: the lifecycle's same-hash "touch" step is what makes
 * that idempotent, and re-emitting is what keeps `displayDetails` (the amount,
 * the payee, the owner) current on the dashboard.
 *
 * EVIDENCE IS ASSIGNED ONE-TO-ONE. A single $46.00 Lowe's receipt cannot answer
 * for two separate $46.00 Lowe's charges — before this, it silently closed
 * both, and the second charge's missing receipt was never chased. Lines are
 * processed oldest-first, and each takes the closest-dated unconsumed evidence
 * row (lowest id breaks a tie), so the assignment is the same on every run.
 *
 * OUT OF SCOPE, deliberately, and stated so nobody reads a gap as a bug:
 *   - SPLIT TENDERS. One receipt paid across two cards posts as two bank lines
 *     for partial amounts. Exact-cents matching will not close either, so both
 *     get chased. A human resolves them; guessing at sums is how you close a
 *     charge nothing actually covers.
 *   - REFUNDS/REVERSALS. A credit is not spend and drops out at the policy
 *     step; matching a refund back to the charge it reverses is the refund
 *     pipeline's job (validateRefundEventSigns), not this one.
 */
export function planReceiptRequests(input: ReceiptRequestInput): ReceiptRequestPlan {
    const open: ReceiptRequestPlan["open"] = [];
    const close: string[] = [];
    const undecided: string[] = [];
    const openKeys = new Set(input.openIssueKeys);
    const resolvedKeys = new Set(input.resolvedIssueKeys ?? []);
    const todayDay = dayNumber(toYmd(input.now));

    // ONE EVIDENCE UNIT per real receipt. A booked ReceiptIntake and the
    // Expense it created are the SAME piece of paper; counting them separately
    // meant one receipt could satisfy two different charges, which is exactly
    // the one-to-one rule this was supposed to enforce. They are folded by
    // whichever identity they share (expenseId, then qbPurchaseId).
    const evidence: EvidenceRow[] = dedupeEvidenceUnits([
        // An Expense with no receipt behind it is not evidence — it is the
        // thing being looked for. See ReceiptEvidenceExpense.hasReceipt.
        ...input.expenses.filter(e => e.hasReceipt).map(e => ({
            id: `expense:${e.id}`,
            // An Expense's own id IS the expense link the intake points at.
            unit: evidenceUnitKey({ expenseId: e.id, qbPurchaseId: e.qbPurchaseId }) ?? `expense:${e.id}`,
            amountCents: e.amountCents,
            date: e.date,
            vendor: e.vendor,
        })),
        ...input.intakes
            .filter(intake =>
                !DEAD_INTAKE_STATES.has(intake.state)
                && intake.totalCents !== null
                // See ReceiptEvidenceIntake.stateReason.
                && intakeArtifactIsVerified(intake.stateReason))
            .map(intake => ({
                id: `intake:${intake.id}`,
                unit: evidenceUnitKey(intake) ?? `intake:${intake.id}`,
                amountCents: intake.totalCents as number,
                date: intake.txnDate,
                vendor: intake.vendor,
            })),
    ]);


    // Oldest charge first, id breaking the tie: the assignment below depends on
    // the order lines are visited, so it must not depend on query order.
    const loadedFrom = input.evidenceLoadedFrom ? dayNumber(input.evidenceLoadedFrom) : null;
    const loadedTo = input.evidenceLoadedTo ? dayNumber(input.evidenceLoadedTo) : null;

    /**
     * True when this line's whole ±2-day evidence window sits inside what the
     * caller actually loaded. Absent bounds mean "everything was loaded".
     */
    const evidenceIsComplete = (postedDay: number): boolean => {
        if (loadedFrom === null && loadedTo === null) return true;
        if (loadedFrom !== null && postedDay - RECEIPT_MATCH_DATE_SLOP_DAYS < loadedFrom) return false;
        if (loadedTo !== null && postedDay + RECEIPT_MATCH_DATE_SLOP_DAYS > loadedTo) return false;
        return true;
    };

    const orderedLines = [...input.bankLines].sort((a, b) =>
        (a.postedDate < b.postedDate ? -1 : a.postedDate > b.postedDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // ONE matching over the whole cohort, computed before any verdict. A
    // per-line greedy pass cannot see that re-housing an earlier line frees the
    // only receipt a later one can reach.
    const matchable = orderedLines
        .filter(line => {
            if (resolvedKeys.has(line.id)) return false;
            if (line.amountCents >= 0) return false;
            const verdict = classifyReceiptRequirement({
                amountCents: line.amountCents,
                rawDescriptor: line.rawDescriptor,
                checkNumber: line.checkNumber ?? null,
            });
            if (verdict.requirement !== "receipt_expected") return false;
            const day = dayNumber(line.postedDate);
            if (day === null || todayDay === null) return false;
            if (todayDay - day < RECEIPT_REQUEST_GRACE_DAYS) return false;
            return evidenceIsComplete(day);
        })
        .map(line => ({
            id: line.id,
            postedDate: line.postedDate,
            amountCents: line.amountCents,
            payee: normalizePayee(line.rawDescriptor),
        }));
    const matched = matchEvidenceToLines(matchable, evidence);

    for (const line of orderedLines) {
        const closeIfOpen = () => { if (openKeys.has(line.id)) close.push(line.id); };

        // A RESOLVED issue is answered evidence, not an open question. A signed
        // memo is the receipt when no merchant receipt exists, so the line stays
        // unmatched forever — without this it would re-open every night, which
        // is precisely the nag the memo was signed to stop.
        //
        // It CLOSES rather than being skipped. The answers route records the
        // resolution and then clears the issue in two steps; a crash between
        // them (or a 409 on the clear) leaves a resolved-but-open issue that
        // nothing else would ever finish. Skipping it left that row nagging
        // forever with a signed memo attached to it. The sweep completes the
        // job it finds half-done, which is the only place that recovery can
        // live. It reopens only when a human clears the resolution.
        if (resolvedKeys.has(line.id)) {
            closeIfOpen();
            continue;
        }

        // Money in and policy-exempt rails drop out here — including a credit
        // that later reversed a charge we were already chasing.
        const verdict = classifyReceiptRequirement({
            amountCents: line.amountCents,
            rawDescriptor: line.rawDescriptor,
            checkNumber: line.checkNumber ?? null,
        });
        if (line.amountCents >= 0 || verdict.requirement !== "receipt_expected") {
            closeIfOpen();
            continue;
        }

        // Grace window. A line we can't date is not chased either — an
        // unparseable posted date is a data problem, not a missing receipt.
        // An OPEN issue overrides the window at the query level (the caller
        // always loads those lines), but never the grace rule itself: a line
        // this young cannot have an issue in the first place.
        const lineDay = dayNumber(line.postedDate);
        if (lineDay === null || todayDay === null || todayDay - lineDay < RECEIPT_REQUEST_GRACE_DAYS) {
            continue;
        }

        // NO DECISION on a line we could not fully look for evidence for. It is
        // neither opened nor closed: the next run, with the right window
        // loaded, decides. Silence beats a confident wrong answer here — the
        // wrong answer is a chase for a receipt that already exists.
        if (!evidenceIsComplete(lineDay)) {
            undecided.push(line.id);
            continue;
        }

        if (matched.has(line.id)) {
            closeIfOpen();
            continue;
        }
        const payee = normalizePayee(line.rawDescriptor);

        const ownerVerdict = resolveReceiptOwner(line.rawDescriptor);
        // No card tail anywhere in the descriptor means we genuinely do not
        // know whose charge it was. Calling that "office" is a guess that reads
        // as an answer, and it hid these rows from the crew's card entirely —
        // so it gets its own visible bucket and a human assigns it.
        const owner = ownerVerdict.cardTail === null && !isOfficeRail(line.rawDescriptor)
            ? "unattributed"
            : ownerVerdict.owner;
        open.push({
            targetKey: line.id,
            displayDetails: {
                owner,
                cardTail: ownerVerdict.cardTail,
                postedDate: line.postedDate,
                amountCents: line.amountCents,
                payee,
                rawDescriptor: line.rawDescriptor,
                fingerprint: receiptRequestFingerprint(line.id),
            },
        });
    }

    return { open, close, undecided };
}

/**
 * Assign evidence to lines so that the MOST lines get answered.
 *
 * Greedy nearest-first loses matches, and it loses them silently. Two charges
 * on the 14th and the 16th, two receipts on the 12th and the 15th: the 14th
 * grabs the 15th (distance 1, its nearest), which leaves the 16th with only the
 * 12th — four days away, outside the window — so it opens a chase for a receipt
 * that is sitting right there. Pairing 14↔12 and 16↔15 answers both.
 *
 * So this is a real bipartite maximum-cardinality matching (Kuhn's augmenting
 * path). Cohorts are tiny — lines sharing one amount within a few days — so the
 * O(V·E) simplicity is worth far more than asymptotics here.
 *
 * DETERMINISM is a requirement, not a nicety: the sweep re-runs nightly and on
 * every OCC retry, and a matching that flips between runs would open and close
 * the same chase forever. Lines are visited in their caller-given order (itself
 * sorted), and each line's candidates are ordered by date distance, then by
 * evidence id — so the same inputs always produce the same pairing.
 */
export function matchEvidenceToLines(
    lines: readonly { id: string; postedDate: string; payee: string; amountCents: number }[],
    evidence: readonly EvidenceRow[],
): Map<string, EvidenceRow> {
    // Candidate lists, deterministically ordered.
    const candidates = new Map<string, EvidenceRow[]>();
    for (const line of lines) {
        const lineDay = dayNumber(line.postedDate);
        const eligible = evidence
            .filter(row => satisfies(
                { id: line.id, postedDate: line.postedDate, amountCents: line.amountCents, rawDescriptor: "" },
                line.payee,
                row,
            ))
            .map(row => ({
                row,
                distance: lineDay === null ? 0 : Math.abs((dayNumber(row.date as string) as number) - lineDay),
            }))
            .sort((a, b) => a.distance - b.distance || (a.row.unit < b.row.unit ? -1 : a.row.unit > b.row.unit ? 1 : 0))
            .map(entry => entry.row);
        candidates.set(line.id, eligible);
    }

    /** unit key -> line id currently holding it. */
    const takenBy = new Map<string, string>();
    const assigned = new Map<string, EvidenceRow>();

    const augment = (lineId: string, seen: Set<string>): boolean => {
        for (const row of candidates.get(lineId) ?? []) {
            if (seen.has(row.unit)) continue;
            seen.add(row.unit);
            const holder = takenBy.get(row.unit);
            // Free, or its current holder can be re-housed elsewhere.
            if (holder === undefined || augment(holder, seen)) {
                takenBy.set(row.unit, lineId);
                assigned.set(lineId, row);
                return true;
            }
        }
        return false;
    };

    // COMPONENT BY COMPONENT. Lines and evidence form a graph: an edge is
    // "this receipt could answer this charge". Competition is transitive along
    // that graph — charge A and charge C may share no candidate at all, yet
    // both compete with B, so re-housing A can free the only receipt C can
    // reach. Matching each connected component AS A WHOLE is what makes the
    // 1/5/9 vs 3/7 case come out right; matching a same-amount bucket in date
    // order does not, because the bucket is not the component.
    //
    // The augmenting search below is already global over `candidates`, so
    // visiting lines in component order changes no result — it makes the
    // grouping explicit, and gives `evidenceComponents` one place to be tested.
    for (const component of evidenceComponents(lines, candidates)) {
        for (const lineId of component) augment(lineId, new Set<string>());
    }
    return assigned;
}

/**
 * Union-find over the line×evidence adjacency, returning line ids grouped into
 * connected components in a deterministic order.
 *
 * Two lines are in the same component when they can reach each other through a
 * chain of shared candidate evidence, however long. A same-amount, same-window
 * BUCKET is a coarser thing: it can split one real component across two
 * buckets, and it can lump unrelated lines together.
 */
export function evidenceComponents(
    lines: readonly { id: string }[],
    candidates: ReadonlyMap<string, readonly EvidenceRow[]>,
): string[][] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
        let root = x;
        while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
        // Path compression, so a long chain does not cost more each lookup.
        let cursor = x;
        while (parent.get(cursor) !== undefined && parent.get(cursor) !== cursor) {
            const next = parent.get(cursor) as string;
            parent.set(cursor, root);
            cursor = next;
        }
        return root;
    };
    const union = (a: string, b: string) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(rb, ra);
    };

    for (const line of lines) parent.set(`L:${line.id}`, `L:${line.id}`);
    for (const line of lines) {
        for (const row of candidates.get(line.id) ?? []) {
            const key = `E:${row.unit}`;
            if (parent.get(key) === undefined) parent.set(key, key);
            union(`L:${line.id}`, key);
        }
    }

    // Grouped in the caller's line order, so the output is stable run to run.
    const groups = new Map<string, string[]>();
    for (const line of lines) {
        const root = find(`L:${line.id}`);
        const group = groups.get(root);
        if (group) group.push(line.id);
        else groups.set(root, [line.id]);
    }
    return [...groups.values()];
}

// ── displayDetails merging ───────────────────────────────────────────────────

/**
 * Keys the nightly matcher must never clobber. The matcher owns the FACTS about
 * the charge (owner, amount, payee) and recomputes them every run; these are
 * the ANSWERS and the history, written by other paths, and a plain overwrite
 * would silently delete a signed memo's PDF link and the Chat thread the sweep
 * needs to find its replies.
 */
export const PRESERVED_DETAIL_KEYS = [
    "resolution", "pdfUrl", "signedAt", "signedThread", "cards", "card",
    // A human's owner assignment outlives every nightly recompute. Without it
    // the sweep would overwrite Marge's decision within 24 hours and the card
    // would never go out.
    "ownerOverride",
] as const;

/**
 * Merge freshly-computed facts over an existing details blob, preserving the
 * answer/history keys. Never mutates either input.
 */
export function mergeReceiptRequestDetails(
    existing: Record<string, unknown> | null | undefined,
    fresh: Record<string, unknown>,
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...fresh };
    if (!existing) return merged;
    for (const key of PRESERVED_DETAIL_KEYS) {
        if (existing[key] !== undefined) merged[key] = existing[key];
    }
    return merged;
}

/** True when a details blob records an answer that closes the chase. */
export function hasResolution(details: Record<string, unknown> | null | undefined): boolean {
    return typeof details?.resolution === "string" && details.resolution !== "";
}

export interface CardRecord {
    threadName: string | null;
    messageName: string | null;
    n: number;
    /** YYYY-MM-DD Pacific. */
    date: string;
    requestId: string;
}

/** How much card/thread history each issue keeps. The sweep only looks back this far. */
export const CARD_HISTORY_DAYS = 14;

/**
 * Append one card record to an issue's history, dropping entries older than
 * `CARD_HISTORY_DAYS` and replacing same-day re-posts rather than stacking
 * them. An ARRAY, not a single `card`: the threads endpoint has to export every
 * live thread an item was asked in, and the old single-slot field silently
 * forgot yesterday's thread the moment today's card went out — so a reply in
 * yesterday's thread had nothing to resolve against.
 */
export function appendCardRecord(
    details: Record<string, unknown> | null | undefined,
    record: CardRecord,
    now: Date,
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...(details ?? {}) };
    // SEED FROM THE LEGACY SLOT. Rows written before `cards[]` existed carry a
    // single `card`. Starting from an empty array on their first write silently
    // discarded the thread they were last asked in, which is exactly the reply
    // the sweep would then have had nothing to resolve against.
    const priorRaw = Array.isArray(merged.cards)
        ? (merged.cards as unknown[])
        : merged.card && typeof merged.card === "object"
            ? [merged.card]
            : [];
    const cutoffDay = (dayNumber(toYmd(now)) ?? 0) - CARD_HISTORY_DAYS;
    const kept = priorRaw.filter((entry): entry is CardRecord => {
        if (!entry || typeof entry !== "object") return false;
        const date = (entry as { date?: unknown }).date;
        if (typeof date !== "string") return false;
        const day = dayNumber(date);
        return day !== null && day >= cutoffDay && date !== record.date;
    });
    merged.cards = [...kept, record];
    // The single-slot field stays in step for readers that only want "latest".
    merged.card = record;
    return merged;
}

// ── Loading a competition component to closure ─────────────────────────────

/** Raised when a component is too large to load honestly. Never swallowed. */
export class ComponentTooLargeError extends Error {
    constructor(readonly count: number, readonly cap: number) {
        super(`competing component exceeded ${cap} lines (${count})`);
        this.name = "ComponentTooLargeError";
    }
}

/**
 * Raised when the caller's absolute deadline ran out mid-walk (Codex PR #443
 * gate round 34, finding 3).
 *
 * A DIFFERENT ANSWER FROM "too large", deliberately. Too-large is a property of
 * the DATA and is the same on every run — the chase stays open and a human is
 * the escalation. This one is a property of THIS INVOCATION: nothing is wrong
 * with the component, we simply stopped asking. The caller must therefore treat
 * it as "not decided this run" rather than as a verdict, which is exactly the
 * card cron's existing `revalidation-deadline` drop reason.
 */
export class ComponentDeadlineExceededError extends Error {
    constructor(readonly passes: number) {
        super(`competing component walk hit the run deadline after ${passes} pass(es)`);
        this.name = "ComponentDeadlineExceededError";
    }
}

/**
 * Name-based, so a second copy of this module (tsx's require chain, a test
 * double) cannot make the guard silently fail open the way `instanceof` would.
 */
export function isComponentDeadlineExceeded(error: unknown): boolean {
    return typeof error === "object" && error !== null
        && (error as { name?: unknown }).name === "ComponentDeadlineExceededError";
}

/**
 * Widen a same-amount window by the link rule until nothing new joins.
 *
 * A FIXED WINDOW IS THE WRONG SHAPE, in both directions at once. `±8 days`
 * around the seed is too wide (it drags in lines that compete with nothing) and
 * too narrow (a chain of same-amount charges four days apart reaches further
 * than any fixed span). Matching a FRAGMENT of a component gives a different
 * answer from the batch, which is exactly the disagreement a recompute exists
 * to avoid.
 *
 * Termination is a property of the data: a gap wider than the link rule stops
 * the walk. `maxNodes` is the guard for data that has no such gap — a card on a
 * daily subscription chains arbitrarily far — and it ABORTS rather than
 * truncating, because a truncated component is a wrong answer wearing a right
 * one's clothes.
 *
 * PURE: the caller supplies `load`, so the walk is testable without a database.
 *
 * `deadlineExceeded` is the run's absolute clock, checked BETWEEN passes. The
 * node cap bounds how MANY queries a pathological component can cost; it says
 * nothing about how LONG they take, and each pass is a real database round trip
 * — so a slow multi-pass component could chain past a cron's `maxDuration` and
 * be killed mid-run, which loses the checkpoint as well as the answer (Codex PR
 * #443 gate round 34, finding 3). Aborting is honest where truncating would not
 * be: a partial component allocates evidence differently from the whole, so
 * there is no useful answer to return, only a decision not to decide.
 */
export async function loadComponentToClosure<T extends { id: string; postedDate: string }>(
    seedDate: string,
    load: (fromYmd: string, toYmd: string) => Promise<T[]>,
    options: { maxNodes: number; linkDays?: number; deadlineExceeded?: () => boolean } = { maxNodes: 200 },
): Promise<T[]> {
    const linkDays = options.linkDays ?? COMPETING_LINE_ADJACENCY_DAYS;
    const deadlineExceeded = options.deadlineExceeded ?? (() => false);
    const seed = dayNumber(seedDate);
    if (seed === null) return [];

    let from = seed;
    let to = seed;
    let loaded: T[] = [];

    // Each pass either grows the extent or stops, and `maxNodes` bounds it a
    // second way, so this cannot spin.
    for (let pass = 0; pass <= options.maxNodes; pass++) {
        // CHECKED BEFORE EACH QUERY, including the first: a caller that is
        // already out of budget must not spend one more round trip, and the
        // walk is only ever entered by an item that would otherwise be SENT.
        if (deadlineExceeded()) throw new ComponentDeadlineExceededError(pass);
        const rows = await load(ymdOf(from - linkDays), ymdOf(to + linkDays));
        if (rows.length > options.maxNodes) throw new ComponentTooLargeError(rows.length, options.maxNodes);
        if (rows.length === loaded.length) return rows;
        loaded = rows;
        const days = rows
            .map(row => dayNumber(row.postedDate))
            .filter((value): value is number => value !== null);
        if (days.length === 0) return rows;
        from = Math.min(from, ...days);
        to = Math.max(to, ...days);
    }
    throw new ComponentTooLargeError(loaded.length, options.maxNodes);
}

/**
 * Does this component sit close enough to the loaded window's edge that its
 * chain might continue OUTSIDE it?
 *
 * The line pass groups components over the 60-day window, which makes them
 * whole WITHIN that window and says nothing about what lies just past either
 * end. A charge on day 61 that links to one on day 59 is a real competitor the
 * window never loaded, so the component the pass thinks it has is a fragment —
 * and a fragment allocates evidence differently from the whole. Anything within
 * one link of an edge therefore gets the full closure walk; everything in the
 * interior is provably complete already and keeps the cheap query.
 */
export function componentTouchesBoundary(
    dates: readonly string[],
    windowStart: string,
    windowEnd: string,
    linkDays: number = COMPETING_LINE_ADJACENCY_DAYS,
): boolean {
    const days = dates
        .map(date => dayNumber(date))
        .filter((value): value is number => value !== null);
    if (days.length === 0) return true; // undateable: assume the worst
    const start = dayNumber(windowStart);
    const end = dayNumber(windowEnd);
    if (start === null || end === null) return true;
    return Math.min(...days) - start <= linkDays || end - Math.max(...days) <= linkDays;
}

// ── Component versions ─────────────────────────────────────────────────────

/**
 * A stamp for "nothing about this component has changed since I planned it".
 *
 * WHY A WHOLE-COMPONENT STAMP AND NOT A PER-ROW CHECK. Evidence assignment is a
 * property of the SET: one receipt answering two identical charges is decided
 * by looking at both. So a sibling changing mid-sweep — a memo signed on the
 * charge next to this one, an intake booked, an issue cleared by a human — can
 * change THIS line's verdict without touching this line at all. A per-row
 * freshness check cannot see that; it only stops the row itself being
 * overwritten, which is the smaller half of the problem.
 *
 * The stamp is the newest `updatedAt` across the component's issues and the
 * intakes that could answer them, plus their counts (an updatedAt alone cannot
 * see a row being DELETED, and a deleted intake un-answers a charge).
 */
export interface ComponentVersion {
    /** Newest updatedAt across the issues, intakes and bank lines. */
    newest: string;
    issues: number;
    intakes: number;
    /** The component's own lines: a count and a hash of their identities. */
    lines: number;
    lineHash: string;
    /**
     * The expenses in the window: a count, and a hash of EVERY FIELD THE
     * PLANNER READS — id, receipt presence, amount, date, vendor, and the QBO
     * purchase it was folded together with (see evidenceUnitKey).
     *
     * `Expense` HAS NO `updatedAt` COLUMN — only `createdAt` and `qbSyncedAt` —
     * so a timestamp cannot see the races that matter here: a bookkeeper
     * attaching a receipt to an EXISTING expense flips `hasReceipt` false→true,
     * a corrected amount, date or vendor changes which line it can answer, and
     * a `qbPurchaseId` arriving or changing re-decides which intake it unit-folds
     * with — evidenceUnitKey prefers it over `expenseId`, so a stale
     * `qbPurchaseId` here could let the planned and re-read verdicts agree while
     * disagreeing about which rows are actually one receipt. Every one of those
     * changes the verdict for the whole component while leaving every timestamp
     * on the row exactly where it was, so the fields themselves are the only
     * usable fingerprint. Hashing identity alone was the same mistake one level
     * down.
     */
    expenses: number;
    expenseHash: string;
    /**
     * The intakes in the window, hashed the same way and for the same reason:
     * `updatedAt` moves for edits we care about, but a hash of the fields the
     * matcher actually reads (state, reason, total, date, vendor, and the
     * `expenseId`/`qbPurchaseId` pair evidenceUnitKey folds on) is what proves
     * the evidence set is unchanged rather than merely unbumped.
     */
    intakeHash: string;
}

/** A short, order-independent digest. Not cryptographic — a change detector. */
function fingerprint(parts: readonly string[]): string {
    let hash = 0x811c9dc5;
    for (const part of [...parts].sort()) {
        for (let i = 0; i < part.length; i++) {
            hash ^= part.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        hash ^= 0x2c; // a separator, so ["ab","c"] and ["a","bc"] differ
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * Stamp EVERY input the planner read, not just the ones that are easy to watch.
 *
 * A verdict is a function of four things: the issues, the intakes, the bank
 * lines in the component, and the receipt-bearing expenses in the window.
 * Versioning only the first two left two real races open — a bookkeeper
 * attaching a receipt to an existing Expense, and a bank line arriving mid-plan
 * — and BOTH change the allocation for every line in the component without
 * touching anything the stamp watched. A fingerprint that covers only part of
 * its input is an assurance about nothing.
 */
export function componentVersionOf(input: {
    /** `targetKey` is carried so a caller can filter to one component. */
    issues: ReadonlyArray<{ targetKey?: string; updatedAt: Date | string | null }>;
    intakes: ReadonlyArray<{
        id?: string;
        updatedAt: Date | string | null;
        state?: string | null;
        stateReason?: string | null;
        totalCents?: number | null;
        txnDate?: Date | string | null;
        vendor?: string | null;
        expenseId?: string | null;
        qbPurchaseId?: string | null;
    }>;
    lines?: ReadonlyArray<{ id: string; updatedAt?: Date | string | null; rawDescriptor?: string | null }>;
    expenses?: ReadonlyArray<{
        id: string;
        hasReceipt: boolean;
        amountCents?: number | null;
        date?: Date | string | null;
        vendor?: string | null;
        qbPurchaseId?: string | null;
    }>;
}): ComponentVersion {
    const iso = (value: Date | string | null | undefined): string =>
        value instanceof Date ? value.toISOString() : (value ?? "");
    let newest = "";
    for (const row of [...input.issues, ...input.intakes, ...(input.lines ?? [])]) {
        const at = iso((row as { updatedAt?: Date | string | null }).updatedAt);
        if (at > newest) newest = at;
    }
    const lines = input.lines ?? [];
    const expenses = input.expenses ?? [];
    return {
        newest,
        issues: input.issues.length,
        intakes: input.intakes.length,
        lines: lines.length,
        // The DESCRIPTOR is hashed, not just the id: a refreshed descriptor
        // changes the payee, which changes what matches.
        lineHash: fingerprint(lines.map(line => `${line.id}:${line.rawDescriptor ?? ""}`)),
        expenses: expenses.length,
        // AMOUNT, DATE, VENDOR AND qbPurchaseId too — they decide which line an
        // expense can answer and which intake it unit-folds with (see
        // evidenceUnitKey), so a correction to any of them changes the verdict.
        expenseHash: fingerprint(expenses.map(expense => [
            expense.id,
            expense.hasReceipt ? 1 : 0,
            expense.amountCents ?? "",
            iso(expense.date),
            expense.vendor ?? "",
            expense.qbPurchaseId ?? "",
        ].join(":"))),
        intakeHash: fingerprint(input.intakes.map(intake => [
            intake.id ?? "",
            intake.state ?? "",
            intake.stateReason ?? "",
            intake.totalCents ?? "",
            iso(intake.txnDate),
            intake.vendor ?? "",
            intake.expenseId ?? "",
            intake.qbPurchaseId ?? "",
        ].join(":"))),
    };
}

export function componentVersionsMatch(a: ComponentVersion, b: ComponentVersion): boolean {
    return a.newest === b.newest
        && a.issues === b.issues
        && a.intakes === b.intakes
        && a.lines === b.lines
        && a.lineHash === b.lineHash
        && a.expenses === b.expenses
        && a.expenseHash === b.expenseHash
        && a.intakeHash === b.intakeHash;
}
