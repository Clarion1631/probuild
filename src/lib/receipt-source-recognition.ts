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

/** Persisted with sweep certification so a flag change requires a new cycle. */
export function receiptRecognitionPolicy(enabled: boolean): string {
    return enabled ? 'receipt-source-v1:on' : 'receipt-source-v1:off';
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

function normalizeBankPayee(payee: string): string {
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
    return mapped !== undefined && mapped === collapse(vendor);
}
