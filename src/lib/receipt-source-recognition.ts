/**
 * Source-grounded receipt recognition helpers (pure, no IO).
 *
 * Two narrow facts supported by native WTB-0723 statement descriptors:
 *   - the descriptor carries the authorization (purchase) date in a fixed
 *     `POS DEB|DBT CRD HHMM MM/DD/YY trace8` trace, up to seven calendar days
 *     before the posting (weekend/holiday settlement), and
 *   - specific complete bank labels map to verified receipt vendor labels.
 *
 * Nothing here widens the ordinary matcher. The integrator gates both helpers
 * behind `sourceRecognitionEnabled === true` AND `isCanonicalReceiptSource`.
 */

/** Bounded settlement allowance (calendar days), not a fuzzy date window. */
export const RECEIPT_AUTH_SETTLEMENT_MAX_DAYS = 7;

/**
 * Persisted with sweep certification so a flag change requires a new cycle.
 *
 * BOTH private packet fingerprints ride in the string, and both are required
 * arguments so a call site cannot quietly certify against half the config: a
 * reviewed packet added, revised, revoked or corrupted changes the policy, the
 * saved cycle no longer matches, and no card can be sent until a fresh complete
 * sweep certifies under the new one. `v3` retires every `v2` certificate.
 */
export function receiptRecognitionPolicy(enabled: boolean, reviewedFactsFingerprint: string, reviewedPairsFingerprint: string): string {
    return enabled ? `receipt-source-v3:on:${reviewedFactsFingerprint}:pair:${reviewedPairsFingerprint}` : 'receipt-source-v1:off';
}

/** Server-reviewed document facts. No extra evidence unit or target binding. */
export interface ReviewedReceiptMerchantEvidence {
    bankPayee: string;
    cardTail: string;
    purchaseDate: string;
    amountCents: number;
    sourceFactDigest: string;
}

// ── Reviewed exact pair (one pinned line, one pinned positive Expense) ────

/** The decision-relevant reviewed fields of the canonical line. `checkNumber` is pinned null: a check is never a card pair. */
export interface ReviewedReceiptPairTarget {
    account: string;
    sourceOfRecord: string;
    /** Settlement (posting) date, YYYY-MM-DD. */
    postedDate: string;
    /** Signed canonical cents (negative). */
    amountCents: number;
    rawDescriptor: string;
    checkNumber: null;
    /** The authorization date the descriptor trace carries, YYYY-MM-DD. Re-derived at match time. */
    bankAuthDate: string;
}

/**
 * A server-reviewed association between ONE canonical bank line and ONE existing
 * positive receipted Expense, admitted only for that named pair.
 *
 * WHY IT EXISTS. A reviewed source can place an existing Expense's accounting
 * date one day before the bank's own authorization trace and three days before
 * settlement — an authenticated confirmation that states payment on that day, or
 * a merchant order receipt whose order was placed then (which states no capture
 * time at all). Neither the ordinary ±2-day rule nor the exact authorization-date
 * rule can see that receipt, and widening either would be a fuzzy window for
 * every receipt. So the reviewer pins the DECISION-RELEVANT fields of both sides
 * — the line's account, source, posting date, cents, descriptor (which carries
 * the card and trace), and the Expense's id, purchase id, sync token, status,
 * description, receipt URL, cents, date, vendor and source-document identity —
 * and the match holds only while every pinned field still holds. That is not a
 * pin of every database column: races on the rows themselves (`updatedAt`, a
 * link landing, a competitor arriving) are fenced at runtime by the component
 * fingerprint, the locked re-read and the global pair census, separately.
 *
 * The bank trace in the descriptor and any processor transaction id or merchant
 * order id in the review provenance are DIFFERENT identifiers. Nothing here
 * treats them as the same, and the runtime projection carries no provenance.
 *
 * It supplies one edge inside the ordinary complete matching: the Expense keeps
 * its usual unit key, so it still folds with its intake, is still excluded when
 * lineage binds or reserves it, and can still be taken by an ordinary competitor.
 */
export interface ReviewedReceiptPairEvidence {
    targetBankLineId: string;
    target: ReviewedReceiptPairTarget;
    /** Complete normalized merchant prefix of the descriptor (before `C#`). */
    bankPayee: string;
    cardTail: string;
    /**
     * The reviewed Expense accounting date (company-local day); may precede
     * `target.bankAuthDate`. A stated payment date exists only in the email
     * provenance kind and is review-time only; it is never carried here.
     */
    purchaseDate: string;
    /** POSITIVE magnitude, equal to `-target.amountCents`. */
    amountCents: number;
    expenseId: string;
    qbPurchaseId: string;
    /** The pinned Expense's current receipt and source-document identity — census keys, not review provenance. */
    receiptUrl: string;
    sourceFileId: string | null;
    sourceGroupIndex: number | null;
    sourceFactDigest: string;
}

/** A planner line with the link state the pair predicate requires to be LOADED. */
export interface ReviewedReceiptPairLine extends ReceiptSourceLine {
    id: string;
    qbTxnId?: string | null;
    probuildExpenseId?: string | null;
}

/**
 * True only for the pair's named line, with every pinned line field exact, the
 * descriptor still parsing to the pinned authorization date, card and payee, the
 * line's link state loaded and either empty or the pair's OWN identities, and the
 * evidence being the pinned magnitude on the pinned reviewed Expense accounting date.
 *
 * Unloaded link state (`undefined`) fails closed: an adapter that did not select
 * `qbTxnId`/`probuildExpenseId` cannot vouch that no competing link exists.
 */
export function reviewedReceiptPairMatches(
    line: ReviewedReceiptPairLine,
    evidence: { amountCents: number; date: string | null },
    fact: ReviewedReceiptPairEvidence | null | undefined,
): boolean {
    if (!fact || !/^[a-f0-9]{64}$/.test(fact.sourceFactDigest)) return false;
    if (!line || typeof line.id !== 'string' || line.id !== fact.targetBankLineId) return false;
    if (!isCanonicalReceiptSource(line)) return false;
    const t = fact.target;
    if (line.account !== t.account || line.sourceOfRecord !== t.sourceOfRecord || line.postedDate !== t.postedDate
        || line.amountCents !== t.amountCents || line.rawDescriptor !== t.rawDescriptor || (line.checkNumber ?? null) !== null) return false;
    if (line.qbTxnId === undefined || line.probuildExpenseId === undefined) return false;
    if (line.qbTxnId !== null && line.qbTxnId !== fact.qbPurchaseId) return false;
    if (line.probuildExpenseId !== null && line.probuildExpenseId !== fact.expenseId) return false;
    if (bankAuthPurchaseDate(line) !== t.bankAuthDate) return false;
    const card = /\bC#(\d{4})\b/.exec(line.rawDescriptor);
    if (!card || card[1] !== fact.cardTail || normalizeBankPayee(line.rawDescriptor.slice(0, card.index)) !== fact.bankPayee) return false;
    if (!Number.isSafeInteger(fact.amountCents) || fact.amountCents <= 0 || -line.amountCents !== fact.amountCents) return false;
    return evidence.amountCents === fact.amountCents && evidence.date === fact.purchaseDate;
}

/** A reviewed fact supplies only an edge inside the normal complete matching component. */
export function reviewedReceiptMerchantMatches(
    line: ReceiptSourceLine,
    fact: ReviewedReceiptMerchantEvidence | null | undefined,
): boolean {
    if (!fact || !/^[a-f0-9]{64}$/.test(fact.sourceFactDigest)) return false;
    if (!isCanonicalReceiptSource(line) || !Number.isSafeInteger(fact.amountCents) || fact.amountCents <= 0) return false;
    if (-line.amountCents !== fact.amountCents || bankAuthPurchaseDate(line) !== fact.purchaseDate) return false;
    const card = /\bC#(\d{4})\b/.exec(line.rawDescriptor);
    // Ordinary payee normalization removes standalone station numbers. Use
    // the canonical raw merchant prefix so the reviewed store stays required.
    const merchant = card ? line.rawDescriptor.slice(0, card.index) : '';
    return card?.[1] === fact.cardTail && normalizeBankPayee(merchant) === fact.bankPayee;
}

export interface ReceiptSourceLine {
    /** YYYY-MM-DD */
    postedDate: string;
    rawDescriptor: string;
    sourceOfRecord?: string;
    account?: string;
    amountCents: number;
    checkNumber?: string | null;
}

const CANONICAL_ACCOUNT = 'WTB-0723';
const CANONICAL_SOURCE = 'STATEMENT';
const MS_PER_DAY = 86_400_000;

/** Only a negative (debit) safe-integer amount on the canonical statement source, with no check number. */
export function isCanonicalReceiptSource(line: ReceiptSourceLine): boolean {
    if (!line || line.account !== CANONICAL_ACCOUNT || line.sourceOfRecord !== CANONICAL_SOURCE) return false;
    if (!Number.isSafeInteger(line.amountCents) || line.amountCents >= 0) return false;
    if (typeof line.checkNumber === 'string' && line.checkNumber.trim() !== '') return false;
    return true;
}

// ── Authorization date ───────────────────────────────────────────────────

const MARKER_RE = /\b(?:POS DEB|DBT CRD)\b/g;
const AUTH_RE = /\b(?:POS DEB|DBT CRD) (\d{4}) (\d{2})\/(\d{2})\/(\d{2}) \d{8}\b/g;
const DATE_LIKE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const CARD_ANY_RE = /C#/g;
const CARD_EXACT_RE = /\bC#\d{4}\b/g;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function count(s: string, re: RegExp): number {
    return (s.match(re) ?? []).length;
}

/** UTC epoch ms for a calendar date, or null if the y/m/d does not round-trip (no JS Date rollover). */
function utcDay(y: number, m: number, d: number): number | null {
    const t = Date.UTC(y, m - 1, d);
    const dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return t;
}

function isoDay(iso: string): number | null {
    const m = ISO_DATE_RE.exec(iso ?? '');
    if (!m) return null;
    return utcDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

function pad2(n: number): string {
    return n < 10 ? '0' + n : String(n);
}

/**
 * Purchase date (YYYY-MM-DD) carried by the descriptor's authorization trace,
 * or null. Requires the canonical source gate, exactly one marker, exactly one
 * date-like token, exactly one well-formed card token, a valid 24h time and
 * calendar date, and a purchase date 0..7 calendar days before postedDate.
 */
export function bankAuthPurchaseDate(line: ReceiptSourceLine): string | null {
    if (!isCanonicalReceiptSource(line)) return null;
    const raw = line.rawDescriptor;
    if (typeof raw !== 'string') return null;

    if (count(raw, MARKER_RE) !== 1) return null;
    if (count(raw, DATE_LIKE_RE) !== 1) return null;
    if (count(raw, CARD_ANY_RE) !== 1 || count(raw, CARD_EXACT_RE) !== 1) return null;

    const matches = [...raw.matchAll(AUTH_RE)];
    if (matches.length !== 1) return null;
    const [, hhmm, mm, dd, yy] = matches[0];

    const hours = Number(hhmm.slice(0, 2));
    const minutes = Number(hhmm.slice(2));
    if (hours > 23 || minutes > 59) return null;

    const year = 2000 + Number(yy);
    const month = Number(mm);
    const day = Number(dd);
    const purchase = utcDay(year, month, day);
    const posted = isoDay(line.postedDate);
    if (purchase === null || posted === null) return null;

    const deltaDays = (posted - purchase) / MS_PER_DAY;
    if (!Number.isInteger(deltaDays) || deltaDays < 0 || deltaDays > RECEIPT_AUTH_SETTLEMENT_MAX_DAYS) return null;

    return `${year}-${pad2(month)}-${pad2(day)}`;
}

// ── Observed merchant aliases ────────────────────────────────────────────

/** Complete normalized bank payee (post-normalizePayee) → complete normalized vendor. */
const OBSERVED_ALIASES: ReadonlyMap<string, string> = new Map([
  ['COLUMBIA RESOURCE COMP VANCOUVER WA', 'CRC-WEST VAN'],
    ['PARKROSE HAZEL DELL - PARKROSE HAZEL DEL', 'PARKROSE HARDWARE'],
    ['PARKROSE HAZEL DELL - HAZEL DELL WA', 'PARKROSE HARDWARE'],
    ['ARCO#82887KT KANSO LLC 2 3817 MAIN ST', 'AMPM #82887'],
]);

function collapse(s: string): string {
    return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Complete bank merchant label: whitespace collapsed, upper-cased, leading rail phrase removed. No other normalization. */
export function normalizeBankPayee(payee: string): string {
    return collapse(collapse(payee).replace(/^MISCELLANEOUS DEBIT /, ''));
}

/**
 * True only when the complete normalized bank payee is one of the observed
 * labels and the complete normalized vendor is its exact mapped vendor.
 * No brand rules, no store-number stripping, no partial matches.
 */
export function observedReceiptMerchantMatches(bankPayee: string, vendor: string | null | undefined): boolean {
    if (typeof bankPayee !== 'string' || typeof vendor !== 'string') return false;
    const mapped = OBSERVED_ALIASES.get(normalizeBankPayee(bankPayee));
    const normalizedVendor = collapse(vendor);
    return mapped !== undefined && (mapped === normalizedVendor
        || (mapped === 'CRC-WEST VAN' && normalizedVendor === 'CRC - WEST VAN'));
}
