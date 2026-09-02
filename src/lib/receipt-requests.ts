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
 * Tokens worth comparing: 3+ characters and not a pure number. Store numbers,
 * ZIPs and terminal ids are noise; "LLC"/"INC" survive but are harmless
 * because a shared token still needs the amount and date to agree.
 */
export const GENERIC_PAYEE_TOKENS: ReadonlySet<string> = new Set([
    "LLC", "INC", "CO", "CORP", "THE", "AND",
]);

export function payeeTokens(value: string): string[] {
    return (value ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .split(/\s+/)
        .filter(token =>
            token.length >= 3
            && !/^\d+$/.test(token)
            // A legal suffix names no merchant. "ACME LLC" and "ZENITH LLC"
            // share a token and would otherwise "agree" on identity, which is
            // exactly the amount+date-alone match the Chevron/Cash App lesson
            // forbids. ("CO" is already below the length floor; it is listed so
            // the rule reads as one intent rather than two accidents.)
            && !GENERIC_PAYEE_TOKENS.has(token));
}

/**
 * True when two payee strings plausibly name the same merchant.
 *
 * Either they share a token, or one's FIRST token is a prefix (4+ chars) of
 * the other's first token — which is what carries "LOWES #02516" vs "Lowe's
 * Home Improvement" and "HOMEDEPOT.COM" vs "Home Depot". An empty side never
 * matches: bank-ledger's rule is that "" is not an identity.
 */
export function payeeMatches(a: string, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    const left = payeeTokens(a);
    const right = payeeTokens(b);
    if (left.length === 0 || right.length === 0) return false;
    const rightSet = new Set(right);
    if (left.some(token => rightSet.has(token))) return true;
    const [firstLeft] = left;
    const [firstRight] = right;
    if (firstLeft.length >= 4 && firstRight.startsWith(firstLeft)) return true;
    if (firstRight.length >= 4 && firstLeft.startsWith(firstRight)) return true;
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
            .filter(intake => !DEAD_INTAKE_STATES.has(intake.state) && intake.totalCents !== null)
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
