// src/server/receipt-reviewed-source-facts.test.ts
// Entirely synthetic fixtures. Station labels are public relationship constants; every ID, URL,
// date, amount and hash below is fabricated.
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewedReceiptFacts,
  resolveReviewedReceiptFact,
  type ReviewedReceiptExpenseInput,
} from '../src/server/receipt-reviewed-source-facts';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const DRIVE_A = 'synthetic-drive-id-0001';
const DRIVE_B = 'synthetic-drive-id-0002';

const factA = (): any => ({
  expected: {
    id: 'exp-0001', qbPurchaseId: '1001', qbSyncToken: '0', status: 'Reviewed',
    description: `Fuel [gtr-file:${DRIVE_A}]`, receiptUrl: 'https://example.invalid/receipts/0001',
    amountCents: 4321, date: '2020-01-15', vendor: 'Main Street Chevron',
  },
  provenance: { driveFileId: DRIVE_A, sourceSha256: 'a'.repeat(64), driveVersion: '1', invoice: 'INV-0001', printedStore: '00093121' },
  bankPayee: 'CHEVRON 0093121 VANCOUVER WA',
  cardTail: '0000',
});
const factB = (): any => ({
  expected: {
    id: 'exp-0002', qbPurchaseId: '1002', qbSyncToken: '3', status: 'Reviewed',
    description: `Fuel [gtr-file:${DRIVE_B}]`, receiptUrl: 'https://example.invalid/receipts/0002',
    amountCents: 999, date: '2020-02-29', vendor: 'AMPM #82887',
  },
  provenance: { driveFileId: DRIVE_B, sourceSha256: 'b'.repeat(64), driveVersion: '7', invoice: 'INV-0002', printedStore: '82887' },
  bankPayee: 'ARCO#82887KT KANSO LLC VANCOUVER WA',
  cardTail: '1111',
});

const packet = (facts: unknown[] = [factA()], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, account: 'WTB-0723', facts, ...extra });
const parse = (raw: string, pin: string = sha(raw)) => parseReviewedReceiptFacts(raw, pin);
const patched = (path: string, value: unknown, base: any = factA()): string => {
  const keys = path.split('.');
  const last = keys.pop() as string;
  const target = keys.reduce((o, k) => o[k], base);
  if (value === undefined) delete target[last]; else target[last] = value;
  return packet([base]);
};
const expectInvalid = (raw: string, pin?: string) => {
  const cfg = parse(raw, pin);
  assert.equal(cfg.status, 'invalid');
  assert.equal(cfg.fingerprint, 'invalid');
  assert.equal((cfg.facts).length, 0);
};
const inputA = (): ReviewedReceiptExpenseInput => ({ ...factA().expected });

describe('parseReviewedReceiptFacts', () => {
  it('is absent only when both env values are empty', () => {
    for (const [raw, pin] of [[undefined, undefined], ['', ''], ['', undefined]] as const) {
      assert.deepEqual(parseReviewedReceiptFacts(raw, pin), {status:'absent',fingerprint:'absent',facts:[]});
    }
  });

  it('accepts a valid packet and pins the exact sha as fingerprint', () => {
    const raw = packet([factA(), factB()]);
    const cfg = parse(raw);
    assert.equal(cfg.status, 'valid');
    assert.equal(cfg.fingerprint, sha(raw));
    assert.equal((cfg.facts).length, 2);
    assert.equal(Object.isFrozen(cfg.facts), true);
    assert.equal(Object.isFrozen(cfg.facts[0].expected), true);
  });

  it('fails closed on pin mismatch, missing halves and malformed json', () => {
    const raw = packet();
    expectInvalid(raw, sha(raw + ' '));
    expectInvalid(raw, sha(raw).toUpperCase());
    expectInvalid(raw, '');
    expectInvalid('', sha(raw));
    expectInvalid('{not json', sha('{not json'));
    expectInvalid('null');
    expectInvalid('[]');
  });

  it('rejects oversize packets', () => {
    const raw = patched('expected.description', `x [gtr-file:${DRIVE_A}] ` + 'y'.repeat(70000));
    expectInvalid(raw);
  });

  it('rejects packet-level schema defects', () => {
    expectInvalid(packet([]));
    expectInvalid(packet([factA(), factA(), factA(), factA(), factA()].map((f, i) => {
      f.expected.id = `exp-${i}`; f.expected.qbPurchaseId = `20${i}`; f.expected.receiptUrl = `https://example.invalid/r/${i}`;
      f.provenance.driveFileId = `synthetic-drive-id-00${i}`; f.provenance.sourceSha256 = String(i).repeat(64); return f;
    })));
    expectInvalid(packet([factA()], { extra: 1 }));
    expectInvalid(JSON.stringify({ version: 2, account: 'WTB-0723', facts: [factA()] }));
    expectInvalid(JSON.stringify({ version: 1, account: 'OTHER', facts: [factA()] }));
    expectInvalid(packet([null]));
    expectInvalid(packet(['fact']));
  });

  it('rejects unknown keys at every level', () => {
    expectInvalid(patched('expected.note', 'x'));
    expectInvalid(patched('provenance.note', 'x'));
    expectInvalid(patched('note', 'x'));
  });

  it('rejects missing, null, empty and wrong-typed required fields', () => {
    const paths = [
      'expected.id', 'expected.qbPurchaseId', 'expected.qbSyncToken', 'expected.status', 'expected.description', 'expected.receiptUrl',
      'expected.amountCents', 'expected.date', 'expected.vendor', 'provenance.driveFileId', 'provenance.sourceSha256',
      'provenance.driveVersion', 'provenance.invoice', 'provenance.printedStore', 'bankPayee', 'cardTail',
    ];
    for (const p of paths) {
      expectInvalid(patched(p, undefined));
      expectInvalid(patched(p, null));
      expectInvalid(patched(p, ''));
      expectInvalid(patched(p, { nested: true }));
      expectInvalid(patched(p, p === 'expected.amountCents' ? '4321' : 12));
    }
  });

  it('enforces per-field value rules', () => {
    const cases: Array<[string, unknown]> = [
      ['expected.status', 'reviewed'], ['expected.status', 'Pending'],
      ['expected.qbPurchaseId', '0'], ['expected.qbPurchaseId', '01'], ['expected.qbPurchaseId', '-1'],
      ['expected.qbSyncToken', '-1'], ['expected.qbSyncToken', '1a'], ['provenance.driveVersion', 'v1'],
      ['expected.amountCents', 0], ['expected.amountCents', -5], ['expected.amountCents', 1.5], ['expected.amountCents', Number.MAX_SAFE_INTEGER + 2],
      ['expected.date', '2020-1-15'], ['expected.date', '2021-02-29'], ['expected.date', '2020-13-01'], ['expected.date', '2020-04-31'],
      ['expected.receiptUrl', 'http://example.invalid/r/1'], ['expected.receiptUrl', 'https://user:pw@example.invalid/r/1'], ['expected.receiptUrl', 'ftp://x'], ['expected.receiptUrl', 'not a url'],
      ['provenance.sourceSha256', 'A'.repeat(64)], ['provenance.sourceSha256', 'a'.repeat(63)], ['provenance.sourceSha256', 'g'.repeat(64)],
      ['cardTail', '123'], ['cardTail', '12345'], ['cardTail', 'abcd'],
      ['provenance.driveFileId', 'short'], ['provenance.driveFileId', 'x'.repeat(101)], ['provenance.driveFileId', 'has space in id'],
      ['bankPayee', 'chevron 0093121 vancouver wa'], ['bankPayee', 'CHEVRON 0093121 VANCOUVER'], ['bankPayee', 'SHELL 0001 PORTLAND OR'],
      ['provenance.printedStore', '00208580'], ['expected.vendor', 'Kalama Chevron'], ['expected.vendor', 'main street chevron'],
    ];
    for (const [p, v] of cases) expectInvalid(patched(p, v));
  });

  it('requires exactly one gtr-file marker that names the provenance drive id', () => {
    expectInvalid(patched('expected.description', 'Fuel no marker'));
    expectInvalid(patched('expected.description', `Fuel [gtr-file:${DRIVE_B}]`));
    expectInvalid(patched('expected.description', `Fuel [gtr-file:${DRIVE_A}] [gtr-file:${DRIVE_A}]`));
    expectInvalid(patched('expected.description', `Fuel [gtr-file:${DRIVE_A}] [gtr-file:${DRIVE_B}]`));
    assert.equal(parse(patched('expected.description', `[gtr-file:${DRIVE_A}] trailing text`)).status, 'valid');
  });

  it('accepts every known station tuple exactly', () => {
    const kalama = factB();
    kalama.bankPayee = 'CHEVRON 0208580 KALAMA WA'; kalama.provenance.printedStore = '00208580'; kalama.expected.vendor = 'Kalama Chevron';
    assert.equal(parse(packet([factA(), factB(), kalama])).status, 'invalid'); // duplicate identities with factB
    kalama.expected.id = 'exp-0003'; kalama.expected.qbPurchaseId = '1003'; kalama.expected.receiptUrl = 'https://example.invalid/receipts/0003';
    kalama.provenance.driveFileId = 'synthetic-drive-id-0003'; kalama.provenance.sourceSha256 = 'c'.repeat(64);
    kalama.expected.description = 'Fuel [gtr-file:synthetic-drive-id-0003]';
    assert.equal(parse(packet([factA(), factB(), kalama])).status, 'valid');
  });

  it('invalidates the whole packet on any shared identity', () => {
    const dupes: Array<[string, string]> = [
      ['expected.id', 'exp-0001'], ['expected.qbPurchaseId', '1001'], ['expected.receiptUrl', 'https://example.invalid/receipts/0001'],
      ['provenance.sourceSha256', 'a'.repeat(64)],
    ];
    for (const [p, v] of dupes) {
      const b = factB();
      const keys = p.split('.');
      const last = keys.pop() as string;
      keys.reduce((o: any, k) => o[k], b)[last] = v;
      expectInvalid(packet([factA(), b]));
    }
    const b = factB();
    b.provenance.driveFileId = DRIVE_A; b.expected.description = `Fuel [gtr-file:${DRIVE_A}]`;
    expectInvalid(packet([factA(), b]));
  });

  it('changes fingerprint on any packet revision and is byte-exact', () => {
    const raw1 = packet();
    const raw2 = patched('expected.amountCents', 4322);
    const raw3 = raw1 + ' ';
    assert.notEqual(parse(raw1).fingerprint, parse(raw2).fingerprint);
    assert.equal(parse(raw3).status, 'valid');
    assert.notEqual(parse(raw3).fingerprint, parse(raw1).fingerprint);
    expectInvalid(raw3, sha(raw1));
  });
});

describe('resolveReviewedReceiptFact', () => {
  const cfg = parse(packet([factA(), factB()]));

  it('returns a minimal frozen projection on exact match', () => {
    const out = resolveReviewedReceiptFact(inputA(), cfg);
    assert.deepEqual(out, {
      bankPayee: 'CHEVRON 0093121 VANCOUVER WA', cardTail: '0000', purchaseDate: '2020-01-15', amountCents: 4321,
      sourceFactDigest: sha(JSON.stringify(cfg.facts[0])),
    });
    assert.equal(Object.isFrozen(out), true);
    assert.deepEqual(Object.keys(out as object).sort(), ['amountCents', 'bankPayee', 'cardTail', 'purchaseDate', 'sourceFactDigest']);
  });

  it('digest is deterministic across independent parses and differs across facts', () => {
    const again = parse(packet([factA(), factB()]));
    assert.equal(resolveReviewedReceiptFact(inputA(), again)?.sourceFactDigest, resolveReviewedReceiptFact(inputA(), cfg)?.sourceFactDigest);
    assert.notEqual(resolveReviewedReceiptFact({ ...factB().expected }, cfg)?.sourceFactDigest, resolveReviewedReceiptFact(inputA(), cfg)?.sourceFactDigest);
  });

  it('returns null when any expected field drifts', () => {
    const drift: Record<string, unknown> = {
      id: 'exp-0009', qbPurchaseId: '1009', qbSyncToken: '1', status: 'Pending', description: 'Fuel [gtr-file:other]',
      receiptUrl: 'https://example.invalid/receipts/0009', amountCents: 4322, date: '2020-01-16', vendor: 'Kalama Chevron',
    };
    for (const [k, v] of Object.entries(drift)) {
      assert.equal(resolveReviewedReceiptFact({ ...inputA(), [k]: v } as ReviewedReceiptExpenseInput, cfg), null);
    }
    assert.equal(resolveReviewedReceiptFact({ ...inputA(), amountCents: '4321' } as unknown as ReviewedReceiptExpenseInput, cfg), null);
  });

  it('yields no edges for absent or invalid configs', () => {
    assert.equal(resolveReviewedReceiptFact(inputA(), parseReviewedReceiptFacts(undefined, undefined)), null);
    assert.equal(resolveReviewedReceiptFact(inputA(), parse(packet(), 'f'.repeat(64))), null);
    assert.equal(resolveReviewedReceiptFact(null as unknown as ReviewedReceiptExpenseInput, cfg), null);
  });

  it('treats source sha and drive version as review provenance only, never runtime claims', () => {
    const raw = patched('provenance.sourceSha256', sha('unrelated synthetic bytes'));
    const c = parse(raw);
    assert.equal(c.status, 'valid');
    const out = resolveReviewedReceiptFact(inputA(), c);
    assert.notEqual(out, null);
    const text = JSON.stringify(out);
    assert.equal((text).includes(DRIVE_A), false);
    assert.equal((text).includes(sha('unrelated synthetic bytes')), false);
    assert.equal((text).includes('example.invalid'), false);
    assert.equal((text).includes('INV-0001'), false);
  });
});
