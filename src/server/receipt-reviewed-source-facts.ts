// src/server/receipt-reviewed-source-facts.ts
// Pure resolver for reviewed receipt facts. No IO, no network. All real facts live in a
// private deployment packet supplied through environment variables; this file contains
// only station relationship constants and schema logic.
import { createHash } from 'node:crypto';

export const REVIEWED_RECEIPT_PACKET_VERSION = 1;
export const REVIEWED_RECEIPT_ACCOUNT = 'WTB-0723';
export const REVIEWED_RECEIPT_MAX_BYTES = 64 * 1024;
export const REVIEWED_RECEIPT_MAX_FACTS = 4;
export const REVIEWED_RECEIPT_INVALID_FINGERPRINT = 'invalid';
export const REVIEWED_RECEIPT_ABSENT_FINGERPRINT = 'absent';
const MARKER = 'gtr-file:';

export interface ReviewedReceiptExpected {
  readonly id: string;
  readonly qbPurchaseId: string;
  readonly qbSyncToken: string;
  readonly status: 'Reviewed';
  readonly description: string;
  readonly receiptUrl: string;
  readonly amountCents: number;
  readonly date: string;
  readonly vendor: string;
}
export interface ReviewedReceiptProvenance {
  readonly driveFileId: string;
  readonly sourceSha256: string; // review-time provenance only; never re-verified at runtime
  readonly driveVersion: string; // review-time provenance only
  readonly invoice: string;
  readonly printedStore: string;
}
export interface ReviewedReceiptFact {
  readonly expected: ReviewedReceiptExpected;
  readonly provenance: ReviewedReceiptProvenance;
  readonly bankPayee: string;
  readonly cardTail: string;
}
export interface ReviewedReceiptFactsConfig {
  readonly status: 'absent' | 'invalid' | 'valid';
  readonly fingerprint: string;
  readonly facts: readonly ReviewedReceiptFact[];
}
export interface ReviewedReceiptExpenseInput {
  readonly id: string;
  readonly qbPurchaseId: string;
  readonly qbSyncToken: string;
  readonly status: string;
  readonly description: string;
  readonly receiptUrl: string;
  readonly amountCents: number;
  readonly date: string;
  readonly vendor: string;
}
export interface ReviewedReceiptResolution {
  readonly bankPayee: string;
  readonly cardTail: string;
  readonly purchaseDate: string;
  readonly amountCents: number;
  readonly sourceFactDigest: string;
}

// Only known store relationships. Exact-case, no broad aliases.
const STATIONS: Readonly<Record<string, { readonly printedStore: string; readonly vendors: readonly string[] }>> = Object.freeze({
  'CHEVRON 0093121 VANCOUVER WA': Object.freeze({ printedStore: '00093121', vendors: Object.freeze(['Main Street Chevron']) }),
  'CHEVRON 0208580 KALAMA WA': Object.freeze({ printedStore: '00208580', vendors: Object.freeze(['Kalama Chevron']) }),
  'ARCO#82887KT KANSO LLC VANCOUVER WA': Object.freeze({ printedStore: '82887', vendors: Object.freeze(['AMPM #82887', 'ampm']) }),
});

const EXPECTED_KEYS = ['id', 'qbPurchaseId', 'qbSyncToken', 'status', 'description', 'receiptUrl', 'amountCents', 'date', 'vendor'] as const;
const PROVENANCE_KEYS = ['driveFileId', 'sourceSha256', 'driveVersion', 'invoice', 'printedStore'] as const;
const FACT_KEYS = ['expected', 'provenance', 'bankPayee', 'cardTail'] as const;
const PACKET_KEYS = ['version', 'account', 'facts'] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const POS_DIGITS = /^[1-9][0-9]*$/;
const NONNEG_DIGITS = /^[0-9]+$/;
const CARD_TAIL = /^[0-9]{4}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;
const YMD = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

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

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const ABSENT: ReviewedReceiptFactsConfig = deepFreeze({ status: 'absent', fingerprint: REVIEWED_RECEIPT_ABSENT_FINGERPRINT, facts: [] });
const INVALID: ReviewedReceiptFactsConfig = deepFreeze({ status: 'invalid', fingerprint: REVIEWED_RECEIPT_INVALID_FINGERPRINT, facts: [] });

function parseFact(v: unknown): ReviewedReceiptFact | null {
  if (!isObj(v) || !keysExactly(v, FACT_KEYS)) return null;
  const e = v.expected;
  const p = v.provenance;
  if (!isObj(e) || !keysExactly(e, EXPECTED_KEYS) || !isObj(p) || !keysExactly(p, PROVENANCE_KEYS)) return null;
  if (
    !str(e.id) || !re(e.qbPurchaseId, POS_DIGITS, 32) || !re(e.qbSyncToken, NONNEG_DIGITS, 32) || e.status !== 'Reviewed' ||
    !str(e.description, 1024) || !isHttpsUrl(e.receiptUrl) || !isPosSafeInt(e.amountCents) || !isDate(e.date) || !str(e.vendor)
  ) return null;
  if (
    !re(p.driveFileId, DRIVE_ID, 100) || !re(p.sourceSha256, HEX64, 64) || !re(p.driveVersion, NONNEG_DIGITS, 32) ||
    !str(p.invoice) || !str(p.printedStore, 32)
  ) return null;
  if (!str(v.bankPayee) || !Object.prototype.hasOwnProperty.call(STATIONS, v.bankPayee) || !re(v.cardTail, CARD_TAIL, 4)) return null;
  const station = STATIONS[v.bankPayee];
  if (p.printedStore !== station.printedStore || !station.vendors.includes(e.vendor)) return null;
  // Exactly one gtr-file marker, and it must name this fact's Drive file.
  if (e.description.split(MARKER).length !== 2 || !e.description.includes('[' + MARKER + p.driveFileId + ']')) return null;
  // Rebuild in fixed key order so JSON.stringify digests are deterministic.
  return {
    expected: {
      id: e.id, qbPurchaseId: e.qbPurchaseId, qbSyncToken: e.qbSyncToken, status: 'Reviewed', description: e.description,
      receiptUrl: e.receiptUrl, amountCents: e.amountCents, date: e.date, vendor: e.vendor,
    },
    provenance: {
      driveFileId: p.driveFileId, sourceSha256: p.sourceSha256, driveVersion: p.driveVersion, invoice: p.invoice, printedStore: p.printedStore,
    },
    bankPayee: v.bankPayee,
    cardTail: v.cardTail,
  };
}

/**
 * Parse and validate a reviewed-receipt packet. Fail-closed: any defect yields status 'invalid'
 * with zero facts and a constant non-private fingerprint. 'absent' only when both inputs are empty.
 * The pin is checked as SHA-256 over the exact UTF-8 bytes of rawJson.
 */
export function parseReviewedReceiptFacts(rawJson: unknown, expectedSha: unknown): ReviewedReceiptFactsConfig {
  if (rawJson !== undefined && typeof rawJson !== 'string') return INVALID;
  if (expectedSha !== undefined && typeof expectedSha !== 'string') return INVALID;
  const raw = rawJson ?? '';
  const pin = expectedSha ?? '';
  if (raw === '' && pin === '') return ABSENT;
  if (raw === '' || pin === '' || !HEX64.test(pin) || Buffer.byteLength(raw, 'utf8') > REVIEWED_RECEIPT_MAX_BYTES) return INVALID;
  const actual = sha256Hex(raw);
  if (actual !== pin) return INVALID;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return INVALID;
  }
  if (!isObj(parsed) || !keysExactly(parsed, PACKET_KEYS)) return INVALID;
  if (parsed.version !== REVIEWED_RECEIPT_PACKET_VERSION || parsed.account !== REVIEWED_RECEIPT_ACCOUNT) return INVALID;
  const list = parsed.facts;
  if (!Array.isArray(list) || list.length < 1 || list.length > REVIEWED_RECEIPT_MAX_FACTS) return INVALID;
  const seen = { id: new Set<string>(), qbPurchaseId: new Set<string>(), receiptUrl: new Set<string>(), driveFileId: new Set<string>(), sourceSha256: new Set<string>() };
  const facts: ReviewedReceiptFact[] = [];
  for (const item of list) {
    const f = parseFact(item);
    if (!f) return INVALID;
    const identities: Array<[Set<string>, string]> = [
      [seen.id, f.expected.id], [seen.qbPurchaseId, f.expected.qbPurchaseId], [seen.receiptUrl, f.expected.receiptUrl],
      [seen.driveFileId, f.provenance.driveFileId], [seen.sourceSha256, f.provenance.sourceSha256],
    ];
    // One physical source is one unit: any shared identity invalidates the whole packet.
    for (const [set, key] of identities) {
      if (set.has(key)) return INVALID;
      set.add(key);
    }
    facts.push(f);
  }
  return deepFreeze({ status: 'valid', fingerprint: actual, facts });
}

/**
 * Resolve a reviewed fact for an expense. Every expected field must match the input exactly.
 * Returns a minimal, frozen projection with no source identities, or null (no edge).
 */
export function resolveReviewedReceiptFact(input: unknown, config: ReviewedReceiptFactsConfig): ReviewedReceiptResolution | null {
  if (config.status !== 'valid' || !isObj(input)) return null;
  const fact = config.facts.find((f) => f.expected.id === input.id);
  if (!fact) return null;
  const inputRecord = input as unknown as Record<string, unknown>;
  for (const k of EXPECTED_KEYS) {
    if (fact.expected[k] !== inputRecord[k]) return null;
  }
  return deepFreeze({
    bankPayee: fact.bankPayee,
    cardTail: fact.cardTail,
    purchaseDate: fact.expected.date,
    amountCents: fact.expected.amountCents,
    sourceFactDigest: sha256Hex(JSON.stringify(fact)),
  });
}

// Stable module configuration from the private deployment environment.
export const reviewedReceiptFactsConfig: ReviewedReceiptFactsConfig = parseReviewedReceiptFacts(
  process.env.RECEIPT_REVIEWED_SOURCE_FACTS_JSON,
  process.env.RECEIPT_REVIEWED_SOURCE_FACTS_SHA256,
);

/** Fingerprint for policy: 'absent', 'invalid', or the exact pinned SHA-256 of the valid packet. */
export const reviewedReceiptFactsFingerprint: string = reviewedReceiptFactsConfig.fingerprint;

/** Adapter entry used by Astra matcher/OCC wiring. */
export function reviewedReceiptFactForExpense(input: unknown): ReviewedReceiptResolution | null {
  return resolveReviewedReceiptFact(input, reviewedReceiptFactsConfig);
}
