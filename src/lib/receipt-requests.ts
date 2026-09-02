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
    /** POSITIVE cents (an Expense's amount is a magnitude, not a signed posting). */
    amountCents: number;
    /** YYYY-MM-DD, or null when the expense has no date. */
    date: string | null;
    vendor: string | null;
}

export interface ReceiptEvidenceIntake {
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
}

export interface ReceiptRequestInput {
    bankLines: readonly ReceiptRequestBankLine[];
    expenses: readonly ReceiptEvidenceExpense[];
    intakes: readonly ReceiptEvidenceIntake[];
    /** targetKeys of bank-line issues that are currently OPEN (clearedAt null). */
    openIssueKeys: readonly string[];
    now: Date;
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
export function payeeTokens(value: string): string[] {
    return (value ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .split(/\s+/)
        .filter(token => token.length >= 3 && !/^\d+$/.test(token));
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
    amountCents: number;
    date: string | null;
    vendor: string | null;
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
 */
export function planReceiptRequests(input: ReceiptRequestInput): ReceiptRequestPlan {
    const open: ReceiptRequestPlan["open"] = [];
    const close: string[] = [];
    const openKeys = new Set(input.openIssueKeys);
    const todayDay = dayNumber(toYmd(input.now));

    const liveIntakes: EvidenceRow[] = [];
    for (const intake of input.intakes) {
        if (DEAD_INTAKE_STATES.has(intake.state)) continue;
        if (intake.totalCents === null) continue;
        liveIntakes.push({ amountCents: intake.totalCents, date: intake.txnDate, vendor: intake.vendor });
    }
    const evidence: EvidenceRow[] = [
        ...input.expenses.map(e => ({ amountCents: e.amountCents, date: e.date, vendor: e.vendor })),
        ...liveIntakes,
    ];

    for (const line of input.bankLines) {
        const closeIfOpen = () => { if (openKeys.has(line.id)) close.push(line.id); };

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
        const lineDay = dayNumber(line.postedDate);
        if (lineDay === null || todayDay === null || todayDay - lineDay < RECEIPT_REQUEST_GRACE_DAYS) {
            continue;
        }

        const payee = normalizePayee(line.rawDescriptor);
        if (evidence.some(row => satisfies(line, payee, row))) {
            closeIfOpen();
            continue;
        }

        const ownerVerdict = resolveReceiptOwner(line.rawDescriptor);
        open.push({
            targetKey: line.id,
            displayDetails: {
                owner: ownerVerdict.owner,
                cardTail: ownerVerdict.cardTail,
                postedDate: line.postedDate,
                amountCents: line.amountCents,
                payee,
                rawDescriptor: line.rawDescriptor,
                fingerprint: receiptRequestFingerprint(line.id),
            },
        });
    }

    return { open, close };
}
