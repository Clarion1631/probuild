// src/server/receipt-reviewed-pair-facts.ts
// Pure resolver for reviewed EXACT-PAIR facts: one pinned canonical bank line associated
// with one pinned existing positive receipted Expense. No IO, no network. All real facts
// live in a private deployment packet supplied through environment variables; this file
// holds only schema and consistency logic. Separate from the reviewed gas packet on
// purpose: that packet describes receipts whose Expense date IS the bank authorization
// date; this one describes a reviewed Expense accounting date that precedes it. Only the
// email provenance kind additionally states a payment date; the merchant kind states none.
import { createHash } from 'node:crypto';
import {
  bankAuthPurchaseDate,
  isCanonicalReceiptSource,
  normalizeBankPayee,
  RECEIPT_AUTH_SETTLEMENT_MAX_DAYS,
  type ReviewedReceiptPairEvidence,
} from '@/lib/receipt-source-recognition';
import { reviewedReceiptFactsConfig, type ReviewedReceiptFactsConfig } from './receipt-reviewed-source-facts';

export const REVIEWED_PAIR_PACKET_VERSION = 1;
export const REVIEWED_PAIR_ACCOUNT = 'WTB-0723';
export const REVIEWED_PAIR_SOURCE_OF_RECORD = 'STATEMENT';
export const REVIEWED_PAIR_MAX_BYTES = 64 * 1024;
/** Capacity TWO: each pair is a separately reviewed, fully pinned association. Not a general allowance. */
export const REVIEWED_PAIR_MAX_PAIRS = 2;
export const REVIEWED_PAIR_INVALID_FINGERPRINT = 'invalid';
export const REVIEWED_PAIR_ABSENT_FINGERPRINT = 'absent';

/**
 * The DECISION-RELEVANT reviewed fields of the canonical line — the ones the pair
 * predicate compares at match time. This is not a pin of every database column:
 * row-version races (`updatedAt`, a link landing, a competitor arriving) are fenced
 * separately at runtime by the sweep's component fingerprint, the locked re-read and
 * the global pair census, not by this packet.
 */
export interface ReviewedPairTargetPin {
  readonly bankLineId: string;
  readonly account: typeof REVIEWED_PAIR_ACCOUNT;
  readonly sourceOfRecord: typeof REVIEWED_PAIR_SOURCE_OF_RECORD;
  /** Settlement (posting) date. */
  readonly postedDate: string;
  readonly amountCents: number;
  readonly rawDescriptor: string;
  readonly checkNumber: null;
  /** The authorization date the descriptor trace carries; re-derived from the live row at match time. */
  readonly bankAuthDate: string;
}
/**
 * The DECISION-RELEVANT reviewed fields of the Expense, including its QBO sync token
 * (the Purchase version) and its source-document identity. Other columns are not
 * pinned; the runtime OCC fingerprint covers the row's remaining movement.
 */
export interface ReviewedPairExpected {
  readonly id: string;
  readonly qbPurchaseId: string;
  readonly qbSyncToken: string;
  readonly status: 'Reviewed';
  readonly description: string;
  readonly receiptUrl: string;
  readonly amountCents: number;
  /** The Expense's own accounting date (company-local day). */
  readonly date: string;
  readonly vendor: string;
  readonly sourceFileId: string | null;
  readonly sourceGroupIndex: number | null;
}
/**
 * Review-time provenance only; never re-verified at runtime and never projected.
 *
 * Exactly two source kinds are admitted, because the two reviewed sources differ:
 *   email_payment_confirmation — an authenticated payment-processor confirmation
 *     message. `paymentTransactionId` is the PROCESSOR's identifier; it is not the bank
 *     trace in the descriptor and the two are never compared or equated. `paymentDate`
 *     is the explicitly stated payment day and must equal the Expense date.
 *   merchant_order_receipt — an independently observed merchant order receipt page.
 *     It shows an order id, the card and the amount; it does NOT show a payment
 *     capture time or a processor transaction id, so neither is required, and
 *     `placedDate` is the ORDER PLACEMENT date under that meaning only. It is never
 *     read as a capture or payment date, and `orderId` is never read as a transaction id.
 */
export interface ReviewedPairEmailProvenance {
  readonly kind: 'email_payment_confirmation';
  readonly sourceMessageId: string;
  readonly sourceSha256: string;
  readonly paymentTransactionId: string;
  readonly invoice: string;
  readonly paymentDate: string;
}
export interface ReviewedPairMerchantProvenance {
  readonly kind: 'merchant_order_receipt';
  readonly sourceUrl: string;
  readonly sourceSha256: string;
  readonly orderId: string;
  readonly displayedCardTail: string;
  readonly displayedAmountCents: number;
  readonly placedDate: string;
}
export type ReviewedPairProvenance = ReviewedPairEmailProvenance | ReviewedPairMerchantProvenance;
export interface ReviewedReceiptPair {
  readonly target: ReviewedPairTargetPin;
  readonly expected: ReviewedPairExpected;
  readonly provenance: ReviewedPairProvenance;
  readonly bankPayee: string;
  readonly cardTail: string;
}
export interface ReviewedReceiptPairsConfig {
  readonly status: 'absent' | 'invalid' | 'valid';
  readonly fingerprint: string;
  readonly pairs: readonly ReviewedReceiptPair[];
}
export interface ReviewedReceiptPairExpenseInput {
  readonly id: string;
  readonly qbPurchaseId: string;
  readonly qbSyncToken: string;
  readonly status: string;
  readonly description: string;
  readonly receiptUrl: string;
  readonly amountCents: number;
  readonly date: string;
  readonly vendor: string;
  readonly sourceFileId: string | null;
  readonly sourceGroupIndex: number | null;
}

const TARGET_KEYS = ['bankLineId', 'account', 'sourceOfRecord', 'postedDate', 'amountCents', 'rawDescriptor', 'checkNumber', 'bankAuthDate'] as const;
const EXPECTED_KEYS = ['id', 'qbPurchaseId', 'qbSyncToken', 'status', 'description', 'receiptUrl', 'amountCents', 'date', 'vendor', 'sourceFileId', 'sourceGroupIndex'] as const;
const EMAIL_PROVENANCE_KEYS = ['kind', 'sourceMessageId', 'sourceSha256', 'paymentTransactionId', 'invoice', 'paymentDate'] as const;
const MERCHANT_PROVENANCE_KEYS = ['kind', 'sourceUrl', 'sourceSha256', 'orderId', 'displayedCardTail', 'displayedAmountCents', 'placedDate'] as const;
const PAIR_KEYS = ['target', 'expected', 'provenance', 'bankPayee', 'cardTail'] as const;
const PACKET_KEYS = ['version', 'account', 'pairs'] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const POS_DIGITS = /^[1-9][0-9]*$/;
const NONNEG_DIGITS = /^[0-9]+$/;
const CARD_TAIL = /^[0-9]{4}$/;
const OPAQUE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const YMD = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const CARD_TOKEN = /\bC#(\d{4})\b/;
const MS_PER_DAY = 86_400_000;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysExactly = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const str = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const re = (v: unknown, r: RegExp, max = 512): v is string => str(v, max) && r.test(v);
const isDate = (v: unknown): v is string => {
  if (!re(v, YMD, 10)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const dayOf = (ymd: string): number => Math.round(Date.parse(ymd + 'T00:00:00Z') / MS_PER_DAY);
const isHttpsUrl = (v: unknown): v is string => {
  if (!str(v, 2048)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
};
const isPosSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isNegSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v < 0;
const isNullOrStr = (v: unknown, max = 200): v is string | null => v === null || re(v, OPAQUE_ID, max);
const isNullOrNonNegInt = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const ABSENT: ReviewedReceiptPairsConfig = deepFreeze({ status: 'absent', fingerprint: REVIEWED_PAIR_ABSENT_FINGERPRINT, pairs: [] });
const INVALID: ReviewedReceiptPairsConfig = deepFreeze({ status: 'invalid', fingerprint: REVIEWED_PAIR_INVALID_FINGERPRINT, pairs: [] });

/**
 * One of exactly two provenance shapes. Returns the rebuilt provenance (fixed key
 * order) or null. `expected` and `cardTail` are the already-validated pair fields the
 * variant must agree with.
 */
function parseProvenance(p: Record<string, unknown>, expected: { date: string; amountCents: number }, cardTail: string, bankAuthDate: string): ReviewedPairProvenance | null {
  if (p.kind === 'email_payment_confirmation') {
    if (!keysExactly(p, EMAIL_PROVENANCE_KEYS)) return null;
    if (!re(p.sourceMessageId, OPAQUE_ID, 128) || !re(p.sourceSha256, HEX64, 64) || !re(p.paymentTransactionId, OPAQUE_ID, 128) || !str(p.invoice, 128) || !isDate(p.paymentDate)) return null;
    // The confirmation names the same payment day the Expense carries.
    if (p.paymentDate !== expected.date) return null;
    return { kind: 'email_payment_confirmation', sourceMessageId: p.sourceMessageId, sourceSha256: p.sourceSha256, paymentTransactionId: p.paymentTransactionId, invoice: p.invoice, paymentDate: p.paymentDate };
  }
  if (p.kind === 'merchant_order_receipt') {
    if (!keysExactly(p, MERCHANT_PROVENANCE_KEYS)) return null;
    if (!isHttpsUrl(p.sourceUrl) || !re(p.sourceSha256, HEX64, 64) || !re(p.orderId, OPAQUE_ID, 128) || !re(p.displayedCardTail, CARD_TAIL, 4) || !isPosSafeInt(p.displayedAmountCents) || !isDate(p.placedDate)) return null;
    // What the merchant page displays must be the pair's card and the Expense's cents.
    if (p.displayedCardTail !== cardTail || p.displayedAmountCents !== expected.amountCents) return null;
    // An order cannot be placed after the bank authorized its charge. No capture date
    // exists on this source and none is inferred from placement.
    if (dayOf(p.placedDate) > dayOf(bankAuthDate)) return null;
    return { kind: 'merchant_order_receipt', sourceUrl: p.sourceUrl, sourceSha256: p.sourceSha256, orderId: p.orderId, displayedCardTail: p.displayedCardTail, displayedAmountCents: p.displayedAmountCents, placedDate: p.placedDate };
  }
  return null;
}

function parsePair(v: unknown): ReviewedReceiptPair | null {
  if (!isObj(v) || !keysExactly(v, PAIR_KEYS)) return null;
  const t = v.target;
  const e = v.expected;
  const p = v.provenance;
  if (!isObj(t) || !keysExactly(t, TARGET_KEYS) || !isObj(e) || !keysExactly(e, EXPECTED_KEYS) || !isObj(p)) return null;
  if (
    !re(t.bankLineId, OPAQUE_ID, 128) || t.account !== REVIEWED_PAIR_ACCOUNT || t.sourceOfRecord !== REVIEWED_PAIR_SOURCE_OF_RECORD ||
    !isDate(t.postedDate) || !isNegSafeInt(t.amountCents) || !str(t.rawDescriptor, 512) || t.checkNumber !== null || !isDate(t.bankAuthDate)
  ) return null;
  if (
    !str(e.id) || !re(e.qbPurchaseId, POS_DIGITS, 32) || !re(e.qbSyncToken, NONNEG_DIGITS, 32) || e.status !== 'Reviewed' ||
    !str(e.description, 1024) || !isHttpsUrl(e.receiptUrl) || !isPosSafeInt(e.amountCents) || !isDate(e.date) || !str(e.vendor) ||
    !isNullOrStr(e.sourceFileId) || !isNullOrNonNegInt(e.sourceGroupIndex)
  ) return null;
  if (!str(v.bankPayee, 256) || !re(v.cardTail, CARD_TAIL, 4)) return null;
  const provenance = parseProvenance(p, { date: e.date, amountCents: e.amountCents }, v.cardTail, t.bankAuthDate);
  if (!provenance) return null;

  // The pinned line must be canonical and its descriptor must carry the pinned
  // authorization date, card and complete merchant label — through the SAME
  // pure helpers the matcher applies to the live row.
  const lineShape = { postedDate: t.postedDate, rawDescriptor: t.rawDescriptor, sourceOfRecord: t.sourceOfRecord, account: t.account, amountCents: t.amountCents, checkNumber: null };
  if (!isCanonicalReceiptSource(lineShape) || bankAuthPurchaseDate(lineShape) !== t.bankAuthDate) return null;
  const card = CARD_TOKEN.exec(t.rawDescriptor);
  if (!card || card[1] !== v.cardTail || normalizeBankPayee(t.rawDescriptor.slice(0, card.index)) !== v.bankPayee) return null;
  // Exact cents, both sides.
  if (e.amountCents !== -t.amountCents) return null;
  // A bounded BACKDATED Expense: on or before the authorization, and never further
  // before settlement than the settlement allowance the evidence window already
  // loads. This is an admissibility bound on a pinned exact pair, not a tolerance.
  const expenseDay = dayOf(e.date);
  if (expenseDay > dayOf(t.bankAuthDate) || dayOf(t.postedDate) - expenseDay > RECEIPT_AUTH_SETTLEMENT_MAX_DAYS) return null;

  // Rebuild in fixed key order so JSON.stringify digests are deterministic.
  return {
    target: {
      bankLineId: t.bankLineId, account: REVIEWED_PAIR_ACCOUNT, sourceOfRecord: REVIEWED_PAIR_SOURCE_OF_RECORD, postedDate: t.postedDate,
      amountCents: t.amountCents, rawDescriptor: t.rawDescriptor, checkNumber: null, bankAuthDate: t.bankAuthDate,
    },
    expected: {
      id: e.id, qbPurchaseId: e.qbPurchaseId, qbSyncToken: e.qbSyncToken, status: 'Reviewed', description: e.description,
      receiptUrl: e.receiptUrl, amountCents: e.amountCents, date: e.date, vendor: e.vendor,
      sourceFileId: e.sourceFileId, sourceGroupIndex: e.sourceGroupIndex,
    },
    provenance,
    bankPayee: v.bankPayee,
    cardTail: v.cardTail,
  };
}

/** The identities a provenance record claims, for the one-source-one-unit check. */
function provenanceIdentities(p: ReviewedPairProvenance): Array<[string, string]> {
  return p.kind === 'email_payment_confirmation'
    ? [['sourceSha256', p.sourceSha256], ['sourceMessageId', p.sourceMessageId], ['paymentTransactionId', p.paymentTransactionId]]
    : [['sourceSha256', p.sourceSha256], ['sourceUrl', p.sourceUrl], ['orderId', p.orderId]];
}

/**
 * Parse and validate a reviewed exact-pair packet. Fail-closed: any defect yields status
 * 'invalid' with zero pairs and a constant non-private fingerprint. 'absent' only when both
 * inputs are empty. The pin is checked as SHA-256 over the exact UTF-8 bytes of rawJson.
 *
 * `reserved` is the reviewed gas packet: an Expense, purchase, receipt URL or source hash
 * it already claims cannot also be a pair. One physical source is one unit, across packets.
 */
export function parseReviewedReceiptPairs(rawJson: unknown, expectedSha: unknown, reserved?: ReviewedReceiptFactsConfig): ReviewedReceiptPairsConfig {
  if (rawJson !== undefined && typeof rawJson !== 'string') return INVALID;
  if (expectedSha !== undefined && typeof expectedSha !== 'string') return INVALID;
  const raw = rawJson ?? '';
  const pin = expectedSha ?? '';
  if (raw === '' && pin === '') return ABSENT;
  if (raw === '' || pin === '' || !HEX64.test(pin) || Buffer.byteLength(raw, 'utf8') > REVIEWED_PAIR_MAX_BYTES) return INVALID;
  const actual = sha256Hex(raw);
  if (actual !== pin) return INVALID;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return INVALID;
  }
  if (!isObj(parsed) || !keysExactly(parsed, PACKET_KEYS)) return INVALID;
  if (parsed.version !== REVIEWED_PAIR_PACKET_VERSION || parsed.account !== REVIEWED_PAIR_ACCOUNT) return INVALID;
  const list = parsed.pairs;
  if (!Array.isArray(list) || list.length < 1 || list.length > REVIEWED_PAIR_MAX_PAIRS) return INVALID;
  const seen = new Map<string, Set<string>>();
  const claim = (field: string, value: string): boolean => {
    const set = seen.get(field) ?? new Set<string>();
    if (set.has(value)) return false;
    set.add(value);
    seen.set(field, set);
    return true;
  };
  if (reserved?.status === 'valid') {
    for (const fact of reserved.facts) {
      claim('id', fact.expected.id);
      claim('qbPurchaseId', fact.expected.qbPurchaseId);
      claim('receiptUrl', fact.expected.receiptUrl);
      claim('sourceSha256', fact.provenance.sourceSha256);
    }
  }
  const pairs: ReviewedReceiptPair[] = [];
  for (const item of list) {
    const pair = parsePair(item);
    if (!pair) return INVALID;
    const identities: Array<[string, string]> = [
      ['bankLineId', pair.target.bankLineId], ['rawDescriptor', pair.target.rawDescriptor],
      ['id', pair.expected.id], ['qbPurchaseId', pair.expected.qbPurchaseId], ['receiptUrl', pair.expected.receiptUrl],
      ...provenanceIdentities(pair.provenance),
    ];
    // One physical source is one unit: any shared identity invalidates the whole packet.
    for (const [field, value] of identities) {
      if (!claim(field, value)) return INVALID;
    }
    pairs.push(pair);
  }
  return deepFreeze({ status: 'valid', fingerprint: actual, pairs });
}

/**
 * Resolve the reviewed pair for an Expense. Every expected field must match the input
 * exactly. Returns a minimal, frozen projection carrying the named target, the pinned
 * line snapshot the matcher compares and the census keys — and no review provenance —
 * or null (no edge).
 */
export function resolveReviewedReceiptPair(input: unknown, config: ReviewedReceiptPairsConfig): ReviewedReceiptPairEvidence | null {
  if (config.status !== 'valid' || !isObj(input)) return null;
  const pair = config.pairs.find((p) => p.expected.id === input.id);
  if (!pair) return null;
  const inputRecord = input as unknown as Record<string, unknown>;
  for (const k of EXPECTED_KEYS) {
    if (pair.expected[k] !== inputRecord[k]) return null;
  }
  const t = pair.target;
  return deepFreeze({
    targetBankLineId: t.bankLineId,
    target: {
      account: t.account, sourceOfRecord: t.sourceOfRecord, postedDate: t.postedDate, amountCents: t.amountCents,
      rawDescriptor: t.rawDescriptor, checkNumber: null, bankAuthDate: t.bankAuthDate,
    },
    bankPayee: pair.bankPayee,
    cardTail: pair.cardTail,
    purchaseDate: pair.expected.date,
    amountCents: pair.expected.amountCents,
    expenseId: pair.expected.id,
    qbPurchaseId: pair.expected.qbPurchaseId,
    receiptUrl: pair.expected.receiptUrl,
    sourceFileId: pair.expected.sourceFileId,
    sourceGroupIndex: pair.expected.sourceGroupIndex,
    sourceFactDigest: sha256Hex(JSON.stringify(pair)),
  });
}

// Stable module configuration from the private deployment environment. The gas packet is
// passed as the reserved set so the two private packets can never claim one source twice.
export const reviewedReceiptPairsConfig: ReviewedReceiptPairsConfig = parseReviewedReceiptPairs(
  process.env.RECEIPT_REVIEWED_PAIR_FACTS_JSON,
  process.env.RECEIPT_REVIEWED_PAIR_FACTS_SHA256,
  reviewedReceiptFactsConfig,
);

/** Fingerprint for policy: 'absent', 'invalid', or the exact pinned SHA-256 of the valid packet. */
export const reviewedReceiptPairsFingerprint: string = reviewedReceiptPairsConfig.fingerprint;

/** Adapter entry used by the sweep's evidence adapters and recompute wiring. */
export function reviewedReceiptPairForExpense(input: unknown): ReviewedReceiptPairEvidence | null {
  return resolveReviewedReceiptPair(input, reviewedReceiptPairsConfig);
}
