import { createHash } from 'node:crypto';

export interface PacketApprovingAdmin {
  email: string;
  instructionReference: string;
}

export interface PacketTarget {
  bankLineId: string;
  account: string;
  amountCents: number;
  postedDate: string;
  purchaseDate: string;
  cardLast4: string;
  bankReference: string;
  legacyFingerprint: string;
}

export interface PacketPdf {
  id: string;
  sha256: string;
}

export interface PacketOwner {
  label: string;
  chatUser: string;
}

export interface PacketOriginalRequest {
  name: string;
  thread: string;
  sender: string;
  senderType: 'BOT';
  text: string;
  createTime: string;
  item: number;
}

export interface PacketOriginalHuman {
  name: string;
  thread: string;
  sender: string;
  senderType: 'HUMAN';
  text: string;
  createTime: string;
  quotedMessageName: string;
  quoteType: 'REPLY';
}

export interface PacketLegacy {
  signedAtVerbatim: string;
  signedBy: string;
  job: string;
  items: string;
  fingerprint: string;
}

export interface Packet {
  contractVersion: 1;
  provenanceKind: 'admin-attested-provider-packet';
  approvingAdmin: PacketApprovingAdmin;
  target: PacketTarget;
  pdf: PacketPdf;
  owner: PacketOwner;
  originalRequest: PacketOriginalRequest;
  originalHuman: PacketOriginalHuman;
  legacy: PacketLegacy;
}

export interface CanonicalStatementImport {
  id: string;
  account: string;
  status: 'FINALIZED';
  periodStart: string;
  periodEnd: string;
  contentHash: string;
}

export interface CanonicalObservation {
  id: string;
  account: string;
  source: 'STATEMENT';
  sourceDocumentId: string;
  sourceLineId: string;
  postedDate: string;
  amountCents: number;
  rawDescriptor: string;
  statementImport: CanonicalStatementImport;
}

export interface Canonical {
  id: string;
  account: string;
  sourceOfRecord: 'STATEMENT';
  state: 'POSTED';
  amountCents: number;
  postedDate: string;
  rawDescriptor: string;
  qbTxnId: null;
  probuildExpenseId: null;
  observationsTruncated: false;
  observations: CanonicalObservation[];
}

export interface RecoveryProof {
  bankLineId: string;
  pdfId: string;
  pdfSha256: string;
  originalReply: string;
  originalMessageAt: string;
  legacySignedAtVerbatim: string;
  packetDigest: string;
}

export type ValidationResult =
  | { ok: true; proof: RecoveryProof }
  | { ok: false; reason: string };

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 8192;
const MAX_FIELD_LENGTH = 512;
const CONTRACT_VERSION = 1;
const PROVENANCE_KIND = 'admin-attested-provider-packet';
const AUTH_MARKER_RE = /(?:POS (?:DEB|CRE)|DBT CRD) (\d{4}) (\d{2})\/(\d{2})\/(\d{2}) (\d{6,10})(?!\d)/g;
const CARD_MARKER_RE = /C#(\d{4})(?!\d)/g;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX12_RE = /^[0-9a-f]{12}$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const LEGACY_SIGNED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})?$/;
const SPACE_RE = /^spaces\/([^/]+)\//;
const USER_RE = /^users\/[^/\s]+$/;
const MAX_PURCHASE_LEAD_DAYS = 10;

class Rejection extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Rejection';
  }
}

function fail(reason: string): never {
  throw new Rejection(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be a plain object`);
  return value;
}

function requireString(value: unknown, path: string, max = MAX_FIELD_LENGTH): string {
  if (typeof value !== 'string') fail(`${path} must be a string`);
  if (value.length === 0) fail(`${path} must be non-empty`);
  if (value.length > max) fail(`${path} exceeds maximum length`);
  return value;
}

function requireSafeInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    fail(`${path} must be a finite safe integer`);
  }
  return value;
}

function requireLiteral<T extends string | number | boolean | null>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(`${path} must be ${JSON.stringify(expected)}`);
  return expected;
}

function calendarValid(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return false;
  const t = Date.UTC(y, m - 1, d, hh, mm, ss);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function requireDateOnly(value: unknown, path: string): string {
  const s = requireString(value, path, 32);
  const m = DATE_ONLY_RE.exec(s);
  if (!m) fail(`${path} must be a calendar date YYYY-MM-DD`);
  if (!calendarValid(Number(m[1]), Number(m[2]), Number(m[3]))) fail(`${path} is not a valid calendar date`);
  return s;
}

function requireIsoUtc(value: unknown, path: string): string {
  const s = requireString(value, path, 64);
  const m = ISO_UTC_RE.exec(s);
  if (!m) fail(`${path} must be a strict ISO-8601 UTC timestamp with Z timezone`);
  if (!calendarValid(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))) {
    fail(`${path} is not a valid calendar timestamp`);
  }
  return s;
}

function requireLegacySignedAt(value: unknown, path: string): string {
  const s = requireString(value, path, 64);
  const m = LEGACY_SIGNED_RE.exec(s);
  if (!m) fail(`${path} must be a calendar timestamp`);
  if (!calendarValid(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))) {
    fail(`${path} is not a valid calendar timestamp`);
  }
  return s;
}

function dateOnlyOfIso(iso: string): string {
  return iso.slice(0, 10);
}

function dayNumber(dateOnly: string): number {
  const m = DATE_ONLY_RE.exec(dateOnly);
  if (!m) fail(`invalid date ${dateOnly}`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]), Number(m[3])) / 86_400_000);
}

function spaceOf(name: string, path: string): string {
  const m = SPACE_RE.exec(name);
  if (!m) fail(`${path} must be a space-scoped resource name`);
  return m[1];
}

function requireUser(value: unknown, path: string): string {
  const s = requireString(value, path, 128);
  if (!USER_RE.test(s)) fail(`${path} must be a chat user resource name`);
  return s;
}

function measureJsonBytes(value: unknown, path: string): void {
  let text: string;
  try {
    text = JSON.stringify(value) ?? '';
  } catch {
    fail(`${path} is not JSON-serializable`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) fail(`${path} exceeds 64KiB`);
}

function parsePacket(input: unknown): Packet {
  const p = requireRecord(input, 'packet');
  measureJsonBytes(p, 'packet');
  requireLiteral(p.contractVersion, CONTRACT_VERSION, 'packet.contractVersion (contract version)');
  requireLiteral(p.provenanceKind, PROVENANCE_KIND, 'packet.provenanceKind (provenance kind)');

  const admin = requireRecord(p.approvingAdmin, 'packet.approvingAdmin');
  const approvingAdmin: PacketApprovingAdmin = {
    email: requireString(admin.email, 'packet.approvingAdmin.email'),
    instructionReference: requireString(admin.instructionReference, 'packet.approvingAdmin.instructionReference'),
  };

  const t = requireRecord(p.target, 'packet.target');
  const cardLast4 = requireString(t.cardLast4, 'packet.target.cardLast4', 4);
  if (!/^\d{4}$/.test(cardLast4)) fail('packet.target.cardLast4 must be four digits');
  const bankReference = requireString(t.bankReference, 'packet.target.bankReference', 10);
  if (!/^\d{6,10}$/.test(bankReference)) fail('packet.target.bankReference must be 6 to 10 digits');
  const legacyFingerprint = requireString(t.legacyFingerprint, 'packet.target.legacyFingerprint', 12);
  if (!HEX12_RE.test(legacyFingerprint)) fail('packet.target.legacyFingerprint must be 12 lowercase hex chars');
  const amountCents = requireSafeInt(t.amountCents, 'packet.target.amountCents');
  if (amountCents >= 0) fail('packet.target.amountCents must be negative');
  const target: PacketTarget = {
    bankLineId: requireString(t.bankLineId, 'packet.target.bankLineId'),
    account: requireString(t.account, 'packet.target.account'),
    amountCents,
    postedDate: requireDateOnly(t.postedDate, 'packet.target.postedDate'),
    purchaseDate: requireDateOnly(t.purchaseDate, 'packet.target.purchaseDate'),
    cardLast4,
    bankReference,
    legacyFingerprint,
  };

  const pdfRec = requireRecord(p.pdf, 'packet.pdf');
  const pdfSha = requireString(pdfRec.sha256, 'packet.pdf.sha256', 64);
  if (!HEX64_RE.test(pdfSha)) fail('packet.pdf.sha256 must be 64 lowercase hex chars');
  const pdf: PacketPdf = { id: requireString(pdfRec.id, 'packet.pdf.id'), sha256: pdfSha };

  const o = requireRecord(p.owner, 'packet.owner');
  const owner: PacketOwner = {
    label: requireString(o.label, 'packet.owner.label'),
    chatUser: requireUser(o.chatUser, 'packet.owner.chatUser'),
  };

  const r = requireRecord(p.originalRequest, 'packet.originalRequest');
  const item = requireSafeInt(r.item, 'packet.originalRequest.item');
  if (item < 1) fail('packet.originalRequest.item must be a positive integer');
  const originalRequest: PacketOriginalRequest = {
    name: requireString(r.name, 'packet.originalRequest.name'),
    thread: requireString(r.thread, 'packet.originalRequest.thread'),
    sender: requireUser(r.sender, 'packet.originalRequest.sender'),
    senderType: requireLiteral(r.senderType, 'BOT', 'packet.originalRequest.senderType'),
    text: requireString(r.text, 'packet.originalRequest.text', MAX_TEXT_LENGTH),
    createTime: requireIsoUtc(r.createTime, 'packet.originalRequest.createTime'),
    item,
  };

  const h = requireRecord(p.originalHuman, 'packet.originalHuman');
  const originalHuman: PacketOriginalHuman = {
    name: requireString(h.name, 'packet.originalHuman.name'),
    thread: requireString(h.thread, 'packet.originalHuman.thread'),
    sender: requireUser(h.sender, 'packet.originalHuman.sender'),
    senderType: requireLiteral(h.senderType, 'HUMAN', 'packet.originalHuman.senderType'),
    text: requireString(h.text, 'packet.originalHuman.text', MAX_TEXT_LENGTH),
    createTime: requireIsoUtc(h.createTime, 'packet.originalHuman.createTime'),
    quotedMessageName: requireString(h.quotedMessageName, 'packet.originalHuman.quotedMessageName'),
    quoteType: requireLiteral(h.quoteType, 'REPLY', 'packet.originalHuman.quoteType'),
  };

  const l = requireRecord(p.legacy, 'packet.legacy');
  const legacyFp = requireString(l.fingerprint, 'packet.legacy.fingerprint', 12);
  if (!HEX12_RE.test(legacyFp)) fail('packet.legacy.fingerprint must be 12 lowercase hex chars');
  const legacy: PacketLegacy = {
    signedAtVerbatim: requireLegacySignedAt(l.signedAtVerbatim, 'packet.legacy.signedAtVerbatim'),
    signedBy: requireString(l.signedBy, 'packet.legacy.signedBy'),
    job: requireString(l.job, 'packet.legacy.job'),
    items: requireString(l.items, 'packet.legacy.items', MAX_TEXT_LENGTH),
    fingerprint: legacyFp,
  };

  return {
    contractVersion: CONTRACT_VERSION,
    provenanceKind: PROVENANCE_KIND,
    approvingAdmin,
    target,
    pdf,
    owner,
    originalRequest,
    originalHuman,
    legacy,
  };
}

function parseCanonical(input: unknown): Canonical {
  const c = requireRecord(input, 'canonical');
  measureJsonBytes(c, 'canonical');
  const id = requireString(c.id, 'canonical.id');
  const account = requireString(c.account, 'canonical.account');
  requireLiteral(c.sourceOfRecord, 'STATEMENT', 'canonical.sourceOfRecord');
  requireLiteral(c.state, 'POSTED', 'canonical.state');
  const amountCents = requireSafeInt(c.amountCents, 'canonical.amountCents');
  const postedDate = requireIsoUtc(c.postedDate, 'canonical.postedDate');
  const rawDescriptor = requireString(c.rawDescriptor, 'canonical.rawDescriptor', MAX_TEXT_LENGTH);
  if (c.qbTxnId !== null) fail('canonical.qbTxnId must be null (line already linked to a QB transaction)');
  if (c.probuildExpenseId !== null) fail('canonical.probuildExpenseId must be null (line already linked to an expense)');
  if (c.observationsTruncated !== false) fail('canonical.observationsTruncated must be false (observations truncated)');
  if (!Array.isArray(c.observations)) fail('canonical.observations must be an array');
  if (c.observations.length !== 1) {
    fail(`canonical.observations must contain exactly one observation (found ${c.observations.length}, ambiguous)`);
  }

  const ob = requireRecord(c.observations[0], 'canonical.observations[0]');
  const si = requireRecord(ob.statementImport, 'canonical.observations[0].statementImport');
  const contentHash = requireString(si.contentHash, 'canonical.observations[0].statementImport.contentHash', 64);
  if (!HEX64_RE.test(contentHash)) fail('canonical.observations[0].statementImport.contentHash must be 64 lowercase hex chars');
  const statementImport: CanonicalStatementImport = {
    id: requireString(si.id, 'canonical.observations[0].statementImport.id'),
    account: requireString(si.account, 'canonical.observations[0].statementImport.account'),
    status: requireLiteral(si.status, 'FINALIZED', 'canonical.observations[0].statementImport.status'),
    periodStart: requireIsoUtc(si.periodStart, 'canonical.observations[0].statementImport.periodStart'),
    periodEnd: requireIsoUtc(si.periodEnd, 'canonical.observations[0].statementImport.periodEnd'),
    contentHash,
  };
  const observation: CanonicalObservation = {
    id: requireString(ob.id, 'canonical.observations[0].id'),
    account: requireString(ob.account, 'canonical.observations[0].account'),
    source: requireLiteral(ob.source, 'STATEMENT', 'canonical.observations[0].source'),
    sourceDocumentId: requireString(ob.sourceDocumentId, 'canonical.observations[0].sourceDocumentId'),
    sourceLineId: requireString(ob.sourceLineId, 'canonical.observations[0].sourceLineId (source line id)'),
    postedDate: requireIsoUtc(ob.postedDate, 'canonical.observations[0].postedDate'),
    amountCents: requireSafeInt(ob.amountCents, 'canonical.observations[0].amountCents'),
    rawDescriptor: requireString(ob.rawDescriptor, 'canonical.observations[0].rawDescriptor', MAX_TEXT_LENGTH),
    statementImport,
  };

  if (observation.account !== account) fail('observation account does not match canonical account');
  if (statementImport.account !== account) fail('statement import account does not match canonical account');
  if (observation.amountCents !== amountCents) fail('observation amount does not match canonical amount');
  if (observation.postedDate !== postedDate) fail('observation posted date does not match canonical posted date');
  if (observation.rawDescriptor !== rawDescriptor) fail('observation descriptor does not match canonical descriptor');
  if (observation.sourceDocumentId !== statementImport.id) fail('observation sourceDocumentId does not equal statement import id');
  const day = dayNumber(dateOnlyOfIso(postedDate));
  if (dayNumber(dateOnlyOfIso(statementImport.periodStart)) > day || dayNumber(dateOnlyOfIso(statementImport.periodEnd)) < day) {
    fail('statement import period does not cover the posted date');
  }

  return {
    id,
    account,
    sourceOfRecord: 'STATEMENT',
    state: 'POSTED',
    amountCents,
    postedDate,
    rawDescriptor,
    qbTxnId: null,
    probuildExpenseId: null,
    observationsTruncated: false,
    observations: [observation],
  };
}

interface DescriptorAuth {
  cardLast4: string;
  purchaseIso: string;
  reference: string;
}

function parseDescriptor(descriptor: string): DescriptorAuth {
  const auths = [...descriptor.matchAll(AUTH_MARKER_RE)];
  if (auths.length !== 1) fail(`descriptor must contain exactly one authorization marker (found ${auths.length})`);
  const cards = [...descriptor.matchAll(CARD_MARKER_RE)];
  if (cards.length !== 1) fail(`descriptor must contain exactly one card marker (found ${cards.length})`);
  const a = auths[0];
  const mm = Number(a[2]);
  const dd = Number(a[3]);
  const yy = 2000 + Number(a[4]);
  if (!calendarValid(yy, mm, dd)) fail('descriptor authorization date is not a valid calendar date');
  const purchaseIso = `${yy}-${a[2]}-${a[3]}`;
  return { cardLast4: cards[0][1], purchaseIso, reference: a[5] };
}

function computeFingerprint(card: string, absCents: number, purchaseIso: string, ref: string): string {
  return createHash('sha1').update(`${card}|${absCents}|${purchaseIso}|${ref}`, 'utf8').digest('hex').slice(0, 12);
}

function crossCheck(packet: Packet, canonical: Canonical): void {
  const t = packet.target;
  if (t.bankLineId !== canonical.id) fail('packet target bankLineId does not match canonical id');
  if (t.account !== canonical.account) fail('packet target account does not match canonical account');
  if (t.amountCents !== canonical.amountCents) fail('packet target amount does not match canonical amount');
  if (t.postedDate !== dateOnlyOfIso(canonical.postedDate)) fail('packet target posted date does not match canonical posted date');

  const auth = parseDescriptor(canonical.rawDescriptor);
  if (auth.cardLast4 !== t.cardLast4) fail('packet target card last4 does not match card in canonical descriptor');
  if (auth.reference !== t.bankReference) fail('packet target bank reference not present in canonical descriptor');
  if (auth.purchaseIso !== t.purchaseDate) fail('packet target purchase date does not match descriptor authorization date');
  const lead = dayNumber(t.postedDate) - dayNumber(auth.purchaseIso);
  if (lead < 0 || lead > MAX_PURCHASE_LEAD_DAYS) fail('descriptor purchase date must be 0 to 10 days before posted date');

  const fp = computeFingerprint(t.cardLast4, Math.abs(t.amountCents), auth.purchaseIso, auth.reference);
  if (fp !== t.legacyFingerprint) fail('computed fingerprint does not match packet target legacyFingerprint');
  if (packet.legacy.fingerprint !== t.legacyFingerprint) fail('legacy fingerprint disagrees with target fingerprint');

  const req = packet.originalRequest;
  const hum = packet.originalHuman;
  if (hum.sender !== packet.owner.chatUser) fail('human reply sender does not equal the card owner chat user');
  if (req.sender === hum.sender) fail('request sender must differ from the human reply sender');
  if (hum.quotedMessageName !== req.name) fail('human reply quotedMessageName does not quote the original request');
  if (spaceOf(req.name, 'packet.originalRequest.name') !== spaceOf(hum.name, 'packet.originalHuman.name')) {
    fail('original request and human reply are not in the same space');
  }
  if (spaceOf(req.thread, 'packet.originalRequest.thread') !== spaceOf(hum.thread, 'packet.originalHuman.thread')) {
    fail('original request and human reply threads are not in the same space');
  }
  if (Date.parse(hum.createTime) < Date.parse(req.createTime)) fail('human reply precedes the original request');
  if (!req.text.includes(t.cardLast4)) fail('original request text does not mention the target card last4');
}

export function validateLegacyRecoveryProof(packetInput: unknown, canonicalInput: unknown): ValidationResult {
  try {
    const packet = parsePacket(packetInput);
    const canonical = parseCanonical(canonicalInput);
    crossCheck(packet, canonical);
    const proof: RecoveryProof = {
      bankLineId: packet.target.bankLineId,
      pdfId: packet.pdf.id,
      pdfSha256: packet.pdf.sha256,
      originalReply: packet.originalHuman.text,
      originalMessageAt: packet.originalHuman.createTime,
      legacySignedAtVerbatim: packet.legacy.signedAtVerbatim,
      packetDigest: stableRecoveryDigest(packetInput),
    };
    return { ok: true, proof };
  } catch (err) {
    if (err instanceof Rejection) return { ok: false, reason: err.message };
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, reason: `validation failed: ${message}` };
  }
}

function canonicalize(value: unknown, depth: number): string {
  if (depth > 64) throw new Error('digest input nesting too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('digest input contains a non-finite number');
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v, depth + 1)).join(',')}]`;
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new Error('digest input contains a non-plain object');
      }
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k], depth + 1)}`)
        .join(',')}}`;
    default:
      throw new Error(`digest input contains non-JSON type ${typeof value}`);
  }
}

export function stableRecoveryDigest(value: unknown): string {
  const text = canonicalize(value, 0);
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error('digest input exceeds 64KiB');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** Same strict legacy parser for canonical uniqueness checks; no fallback identity. */
export function legacyDescriptorIdentity(raw: string): {cardLast4:string;purchaseIso:string;reference:string}|null {
  try { return parseDescriptor(raw); } catch { return null; }
}
