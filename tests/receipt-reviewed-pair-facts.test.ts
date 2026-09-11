// tests/receipt-reviewed-pair-facts.test.ts
// Entirely synthetic fixtures. Every id, URL, descriptor, date, amount and hash below is fabricated;
// no private receipt identity or source content appears here.
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewedReceiptPairs,
  resolveReviewedReceiptPair,
  REVIEWED_PAIR_MAX_PAIRS,
  type ReviewedReceiptPairExpenseInput,
} from '../src/server/receipt-reviewed-pair-facts';
import { parseReviewedReceiptFacts } from '../src/server/receipt-reviewed-source-facts';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// Settlement 06/16, bank authorization 06/14 (in the trace), reviewed Expense accounting date
// 06/13: the pair exists precisely because the ordinary ±2-day and exact-authorization-date
// rules both fail. Only the email fixture also states a payment date (06/13).
const RAW = 'MISCELLANEOUS DEBIT PAYWEB *SYNTHMART 555-0100  NY C#1111 DBT CRD 0900 06/14/25 11111111';

// Variant 1: an authenticated payment-processor confirmation email. It states the
// payment day and a PROCESSOR transaction id (never the bank trace).
const pairA = (): any => ({
  target: {
    bankLineId: 'synthetic-pair-line-0', account: 'WTB-0723', sourceOfRecord: 'STATEMENT', postedDate: '2025-06-16',
    amountCents: -55555, rawDescriptor: RAW, checkNumber: null, bankAuthDate: '2025-06-14',
  },
  expected: {
    id: 'synthetic-pair-expense-0', qbPurchaseId: '2000', qbSyncToken: '0', status: 'Reviewed',
    description: 'Synthetic remaining balance SYN-ORDER-1', receiptUrl: 'https://example.invalid/pair/0.pdf',
    amountCents: 55555, date: '2025-06-13', vendor: 'SYNTHMART', sourceFileId: null, sourceGroupIndex: null,
  },
  provenance: {
    kind: 'email_payment_confirmation',
    sourceMessageId: 'synthetic-message-0', sourceSha256: 'a'.repeat(64), paymentTransactionId: 'SYNTHTXN0000000001',
    invoice: 'SYN-ORDER-1-001', paymentDate: '2025-06-13',
  },
  bankPayee: 'PAYWEB *SYNTHMART 555-0100 NY',
  cardTail: '1111',
});
// Variant 2: an independently observed merchant order receipt page. It shows an order
// id, the card and the amount, and NO capture time or processor transaction id.
const RAW_B = 'MISCELLANEOUS DEBIT SYNTHPLUMB HOME 800-555-0199  CA C#1111 DBT CRD 1101 06/14/25 22222222';
const pairB = (): any => ({
  target: {
    bankLineId: 'synthetic-pair-line-1', account: 'WTB-0723', sourceOfRecord: 'STATEMENT', postedDate: '2025-06-16',
    amountCents: -77777, rawDescriptor: RAW_B, checkNumber: null, bankAuthDate: '2025-06-14',
  },
  expected: {
    id: 'synthetic-pair-expense-1', qbPurchaseId: '2001', qbSyncToken: '0', status: 'Reviewed',
    description: 'Synthetic fixtures order SYN-ORDER-2', receiptUrl: 'https://example.invalid/pair/1.pdf',
    amountCents: 77777, date: '2025-06-13', vendor: 'Synthplumb', sourceFileId: null, sourceGroupIndex: null,
  },
  provenance: {
    kind: 'merchant_order_receipt',
    sourceUrl: 'https://example.invalid/order/receipt/SYN-ORDER-2', sourceSha256: 'b'.repeat(64), orderId: 'SYN-ORDER-2',
    displayedCardTail: '1111', displayedAmountCents: 77777, placedDate: '2025-06-13',
  },
  bankPayee: 'SYNTHPLUMB HOME 800-555-0199 CA',
  cardTail: '1111',
});

const packet = (pairs: unknown[] = [pairA()], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, account: 'WTB-0723', pairs, ...extra });
const parse = (raw: string, pin: string = sha(raw)) => parseReviewedReceiptPairs(raw, pin);
const patched = (path: string, value: unknown, base: any = pairA()): string => {
  const keys = path.split('.');
  const last = keys.pop() as string;
  const target = keys.reduce((o, k) => o[k], base);
  if (value === undefined) delete target[last]; else target[last] = value;
  return packet([base]);
};
const expectInvalid = (raw: string, pin?: string, why?: string) => {
  const cfg = parse(raw, pin);
  assert.equal(cfg.status, 'invalid', why);
  assert.equal(cfg.fingerprint, 'invalid', why);
  assert.equal(cfg.pairs.length, 0, why);
};
const inputA = (): ReviewedReceiptPairExpenseInput => ({ ...pairA().expected });

describe('parseReviewedReceiptPairs', () => {
  it('is absent only when both env values are empty', () => {
    for (const [raw, pin] of [[undefined, undefined], ['', ''], ['', undefined]] as const) {
      assert.deepEqual(parseReviewedReceiptPairs(raw, pin), { status: 'absent', fingerprint: 'absent', pairs: [] });
    }
  });

  it('accepts a valid packet, pins the exact sha as fingerprint and freezes it', () => {
    const raw = packet([pairA(), pairB()]);
    const cfg = parse(raw);
    assert.equal(cfg.status, 'valid');
    assert.equal(cfg.fingerprint, sha(raw));
    assert.equal(cfg.pairs.length, 2);
    assert.equal(Object.isFrozen(cfg.pairs), true);
    assert.equal(Object.isFrozen(cfg.pairs[0].target), true);
    assert.equal(Object.isFrozen(cfg.pairs[0].expected), true);
    assert.equal(Object.isFrozen(cfg.pairs[0].provenance), true);
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
    assert.equal(parseReviewedReceiptPairs(42 as unknown as string, sha(raw)).status, 'invalid');
    assert.equal(parseReviewedReceiptPairs(raw, 42 as unknown as string).status, 'invalid');
  });

  it('rejects oversize packets', () => {
    expectInvalid(patched('expected.description', 'x' + 'y'.repeat(70000)));
  });

  it('rejects packet-level schema defects', () => {
    expectInvalid(packet([]));
    expectInvalid(packet([pairA()], { extra: 1 }));
    expectInvalid(JSON.stringify({ version: 2, account: 'WTB-0723', pairs: [pairA()] }));
    expectInvalid(JSON.stringify({ version: 1, account: 'OTHER', pairs: [pairA()] }));
    expectInvalid(JSON.stringify({ version: 1, account: 'WTB-0723', facts: [pairA()] }));
    expectInvalid(packet([null]));
    expectInvalid(packet(['pair']));
    assert.equal(REVIEWED_PAIR_MAX_PAIRS, 2, 'capacity two: each pair is a separately reviewed association');
    const tooMany = Array.from({ length: REVIEWED_PAIR_MAX_PAIRS + 1 }, (_, i) => {
      const p = pairA();
      p.target.bankLineId = `line-${i}`; p.target.rawDescriptor = RAW.replace('11111111', String(10000000 + i));
      p.expected.id = `exp-${i}`; p.expected.qbPurchaseId = `30${i}`; p.expected.receiptUrl = `https://example.invalid/r/${i}`;
      p.provenance.sourceMessageId = `msg-${i}`; p.provenance.sourceSha256 = String(i).repeat(64); p.provenance.paymentTransactionId = `TXN${i}`;
      return p;
    });
    expectInvalid(packet(tooMany));
    assert.equal(parse(packet(tooMany.slice(0, REVIEWED_PAIR_MAX_PAIRS))).status, 'valid');
  });

  it('admits exactly two provenance kinds, each with only its own fields', () => {
    assert.equal(parse(packet([pairA(), pairB()])).status, 'valid');
    expectInvalid(patched('provenance.kind', 'bank_statement'));
    expectInvalid(patched('provenance.kind', 'merchant_order_receipt'));
    expectInvalid(patched('provenance.kind', undefined));
    // Email kind: every field required, none extra.
    for (const p of ['provenance.sourceMessageId', 'provenance.sourceSha256', 'provenance.paymentTransactionId', 'provenance.invoice', 'provenance.paymentDate']) {
      expectInvalid(patched(p, undefined), undefined, p);
    }
    expectInvalid(patched('provenance.orderId', 'SYN-ORDER-1'));
    expectInvalid(patched('provenance.placedDate', '2025-06-13'));
    // Merchant kind: every field required, none extra — and NO payment date or processor id is admitted.
    for (const p of ['provenance.sourceUrl', 'provenance.sourceSha256', 'provenance.orderId', 'provenance.displayedCardTail', 'provenance.displayedAmountCents', 'provenance.placedDate']) {
      expectInvalid(patched(p, undefined, pairB()), undefined, p);
      expectInvalid(patched(p, null, pairB()), undefined, p);
    }
    for (const [p, v] of [['provenance.paymentDate', '2025-06-13'], ['provenance.paymentTransactionId', 'SYNTHTXN0000000009'], ['provenance.captureDate', '2025-06-14'], ['provenance.sourceMessageId', 'msg'], ['provenance.invoice', 'x']] as const) {
      expectInvalid(patched(p, v, pairB()), undefined, `${p} is not a merchant-receipt fact`);
    }
    // Merchant kind value rules.
    for (const [p, v] of [
      ['provenance.sourceUrl', 'http://example.invalid/order/1'], ['provenance.sourceUrl', 'not a url'], ['provenance.orderId', 'has space'],
      ['provenance.displayedCardTail', '2222'], ['provenance.displayedCardTail', '111'], ['provenance.displayedAmountCents', 77776], ['provenance.displayedAmountCents', '77777'],
      ['provenance.placedDate', '2025-6-13'], ['provenance.placedDate', '2025-06-15'], ['provenance.sourceSha256', 'B'.repeat(64)],
    ] as const) {
      expectInvalid(patched(p, v, pairB()), undefined, `${p}=${String(v)}`);
    }
    // Placement on the authorization day is fine; it is still not a capture date.
    { const p = pairB(); p.provenance.placedDate = '2025-06-14'; assert.equal(parse(packet([p])).status, 'valid'); }
    // The merchant page's placement date is independent of the Expense date: an earlier order is admissible.
    { const p = pairB(); p.provenance.placedDate = '2025-06-10'; assert.equal(parse(packet([p])).status, 'valid'); }
  });

  it('pins the Expense source-document identity, null or exact', () => {
    expectInvalid(patched('expected.sourceFileId', undefined));
    expectInvalid(patched('expected.sourceGroupIndex', undefined));
    expectInvalid(patched('expected.sourceFileId', ''));
    expectInvalid(patched('expected.sourceFileId', 'has space'));
    expectInvalid(patched('expected.sourceGroupIndex', -1));
    expectInvalid(patched('expected.sourceGroupIndex', 1.5));
    expectInvalid(patched('expected.sourceGroupIndex', '0'));
    { const p = pairA(); p.expected.sourceFileId = 'synthetic-drive-file-0001'; p.expected.sourceGroupIndex = 0; assert.equal(parse(packet([p])).status, 'valid'); }
    { const p = pairA(); p.expected.sourceFileId = 'synthetic-drive-file-0001'; assert.equal(parse(packet([p])).status, 'valid', 'file without a group is a pre-column backfill'); }
  });

  it('rejects unknown keys at every level', () => {
    expectInvalid(patched('target.note', 'x'));
    expectInvalid(patched('expected.note', 'x'));
    expectInvalid(patched('provenance.note', 'x'));
    expectInvalid(patched('note', 'x'));
  });

  it('rejects missing, null, empty and wrong-typed required fields', () => {
    const paths = [
      'target.bankLineId', 'target.account', 'target.sourceOfRecord', 'target.postedDate', 'target.amountCents', 'target.rawDescriptor', 'target.bankAuthDate',
      'expected.id', 'expected.qbPurchaseId', 'expected.qbSyncToken', 'expected.status', 'expected.description', 'expected.receiptUrl',
      'expected.amountCents', 'expected.date', 'expected.vendor',
      'provenance.kind', 'provenance.sourceMessageId', 'provenance.sourceSha256', 'provenance.paymentTransactionId', 'provenance.invoice', 'provenance.paymentDate',
      'bankPayee', 'cardTail',
    ];
    for (const p of paths) {
      expectInvalid(patched(p, undefined), undefined, `${p} missing`);
      expectInvalid(patched(p, null), undefined, `${p} null`);
      expectInvalid(patched(p, ''), undefined, `${p} empty`);
      expectInvalid(patched(p, { nested: true }), undefined, `${p} object`);
      expectInvalid(patched(p, p.endsWith('amountCents') ? '55555' : 12), undefined, `${p} wrong type`);
    }
    // checkNumber is required to be PRESENT and literally null: a check is never a card pair.
    expectInvalid(patched('target.checkNumber', undefined));
    expectInvalid(patched('target.checkNumber', '42'));
    expectInvalid(patched('target.checkNumber', ''));
  });

  it('enforces per-field value rules', () => {
    const cases: Array<[string, unknown]> = [
      ['target.account', 'WTB-9999'], ['target.sourceOfRecord', 'QBO_REGISTER'], ['target.sourceOfRecord', 'statement'],
      ['target.amountCents', 55555], ['target.amountCents', 0], ['target.amountCents', -1.5],
      ['target.postedDate', '2025-6-16'], ['target.postedDate', '2025-02-30'], ['target.bankAuthDate', '2025-13-01'],
      ['target.bankLineId', 'has space'], ['target.bankLineId', 'x'.repeat(129)],
      ['expected.status', 'reviewed'], ['expected.status', 'Pending'],
      ['expected.qbPurchaseId', '0'], ['expected.qbPurchaseId', '01'], ['expected.qbPurchaseId', '-1'],
      ['expected.qbSyncToken', '-1'], ['expected.qbSyncToken', '1a'],
      ['expected.amountCents', 0], ['expected.amountCents', -55555], ['expected.amountCents', 55555.5],
      ['expected.date', '2025-6-13'], ['expected.date', '2025-02-29'],
      ['expected.receiptUrl', 'http://example.invalid/r/1'], ['expected.receiptUrl', 'https://user:pw@example.invalid/r/1'], ['expected.receiptUrl', 'not a url'],
      ['provenance.sourceSha256', 'A'.repeat(64)], ['provenance.sourceSha256', 'a'.repeat(63)], ['provenance.sourceSha256', 'g'.repeat(64)],
      ['provenance.paymentDate', '2025-6-13'], ['provenance.paymentTransactionId', 'has space'],
      ['cardTail', '111'], ['cardTail', '11111'], ['cardTail', 'abcd'],
    ];
    for (const [p, v] of cases) expectInvalid(patched(p, v), undefined, `${p}=${String(v)}`);
  });

  it('requires the pinned descriptor to carry exactly the pinned authorization date, card and bank payee', () => {
    // The trace in the descriptor must parse to bankAuthDate through the same pure helper the matcher uses.
    expectInvalid(patched('target.bankAuthDate', '2025-06-13'));
    expectInvalid(patched('target.bankAuthDate', '2025-06-15'));
    expectInvalid(patched('target.rawDescriptor', RAW.replace('06/14/25', '06/15/25')));
    expectInvalid(patched('target.rawDescriptor', RAW.replace(' DBT CRD 0900 06/14/25 11111111', '')));
    expectInvalid(patched('target.rawDescriptor', RAW + ' C#1111'));
    expectInvalid(patched('target.rawDescriptor', RAW + ' 06/14/25'));
    // Eight days between authorization and settlement is past the bounded settlement allowance.
    expectInvalid(patched('target.postedDate', '2025-06-22'));
    // Card tail must be the descriptor's card.
    expectInvalid(patched('cardTail', '2222'));
    expectInvalid(patched('target.rawDescriptor', RAW.replace('C#1111', 'C#2222')));
    // Bank payee must be the complete normalized merchant prefix, exactly.
    expectInvalid(patched('bankPayee', 'PAYWEB *SYNTHMART'));
    expectInvalid(patched('bankPayee', 'paypal *synthmart 555-0100 ny'));
    expectInvalid(patched('bankPayee', 'MISCELLANEOUS DEBIT PAYWEB *SYNTHMART 555-0100 NY'));
    expectInvalid(patched('target.rawDescriptor', RAW.replace('SYNTHMART', 'OTHERMART')));
    // Whitespace collapse is the only normalization: the double space in the raw descriptor is fine.
    assert.equal(parse(packet()).status, 'valid');
  });

  it('pins the three dates explicitly and refuses any pair whose Expense accounting date is not bounded before authorization', () => {
    // Expense cents must be the exact magnitude of the debit.
    expectInvalid(patched('expected.amountCents', 55554));
    expectInvalid(patched('target.amountCents', -55554));
    // Email kind only: the stated payment date must equal the Expense accounting date.
    expectInvalid(patched('provenance.paymentDate', '2025-06-14'));
    expectInvalid(patched('expected.date', '2025-06-14'));
    // An accounting date on the authorization day is admissible (the ordinary rule would also see it); the pair stays exact.
    {
      const p = pairA(); p.expected.date = '2025-06-14'; p.provenance.paymentDate = '2025-06-14';
      assert.equal(parse(packet([p])).status, 'valid');
    }
    // Payment AFTER the bank authorization is not a settlement lag; it is a different fact.
    {
      const p = pairA(); p.expected.date = '2025-06-15'; p.provenance.paymentDate = '2025-06-15';
      expectInvalid(packet([p]));
    }
    // Payment more than the bounded settlement allowance before posting is outside the evidence window.
    {
      const p = pairA(); p.expected.date = '2025-06-08'; p.provenance.paymentDate = '2025-06-08';
      expectInvalid(packet([p]));
    }
    {
      const p = pairA(); p.expected.date = '2025-06-09'; p.provenance.paymentDate = '2025-06-09';
      assert.equal(parse(packet([p])).status, 'valid');
    }
  });

  it('invalidates the whole packet on any shared identity between pairs, across provenance kinds', () => {
    // Second email pair sharing one identity with the first.
    const twinEmail = (): any => {
      const p = pairA();
      p.target.bankLineId = 'synthetic-pair-line-2'; p.target.rawDescriptor = RAW.replace('11111111', '33333333');
      p.expected.id = 'synthetic-pair-expense-2'; p.expected.qbPurchaseId = '2002'; p.expected.receiptUrl = 'https://example.invalid/pair/2.pdf';
      p.provenance.sourceMessageId = 'synthetic-message-2'; p.provenance.sourceSha256 = 'c'.repeat(64); p.provenance.paymentTransactionId = 'SYNTHTXN0000000003';
      return p;
    };
    assert.equal(parse(packet([pairA(), twinEmail()])).status, 'valid');
    const dupes: Array<[string, string]> = [
      ['target.bankLineId', 'synthetic-pair-line-0'], ['target.rawDescriptor', RAW],
      ['expected.id', 'synthetic-pair-expense-0'], ['expected.qbPurchaseId', '2000'], ['expected.receiptUrl', 'https://example.invalid/pair/0.pdf'],
      ['provenance.sourceSha256', 'a'.repeat(64)], ['provenance.sourceMessageId', 'synthetic-message-0'], ['provenance.paymentTransactionId', 'SYNTHTXN0000000001'],
    ];
    for (const [p, v] of dupes) {
      const b = twinEmail();
      const keys = p.split('.');
      const last = keys.pop() as string;
      keys.reduce((o: any, k) => o[k], b)[last] = v;
      expectInvalid(packet([pairA(), b]), undefined, p);
    }
    // A merchant pair sharing the email pair's source hash, or two merchant pairs sharing a URL or order id.
    { const b = pairB(); b.provenance.sourceSha256 = 'a'.repeat(64); expectInvalid(packet([pairA(), b])); }
    const twinMerchant = (): any => {
      const p = pairB();
      p.target.bankLineId = 'synthetic-pair-line-3'; p.target.rawDescriptor = RAW_B.replace('22222222', '44444444');
      p.expected.id = 'synthetic-pair-expense-3'; p.expected.qbPurchaseId = '2003'; p.expected.receiptUrl = 'https://example.invalid/pair/3.pdf';
      p.provenance.sourceUrl = 'https://example.invalid/order/receipt/SYN-ORDER-3'; p.provenance.sourceSha256 = 'd'.repeat(64); p.provenance.orderId = 'SYN-ORDER-3';
      return p;
    };
    assert.equal(parse(packet([pairB(), twinMerchant()])).status, 'valid');
    { const m = twinMerchant(); m.provenance.sourceUrl = 'https://example.invalid/order/receipt/SYN-ORDER-2'; expectInvalid(packet([pairB(), m])); }
    { const m = twinMerchant(); m.provenance.orderId = 'SYN-ORDER-2'; expectInvalid(packet([pairB(), m])); }
  });

  it('refuses a pair whose Expense identity is already claimed by the reviewed gas packet', () => {
    const gasFact = {
      expected: {
        id: 'synthetic-pair-expense-0', qbPurchaseId: '9000', qbSyncToken: '0', status: 'Reviewed',
        description: 'Fuel [gtr-file:synthetic-drive-id-0001]', receiptUrl: 'https://example.invalid/gas/1',
        amountCents: 4321, date: '2020-01-15', vendor: 'Main Street Chevron',
      } as Record<string, unknown>,
      provenance: { driveFileId: 'synthetic-drive-id-0001', sourceSha256: 'c'.repeat(64), driveVersion: '1', invoice: 'INV-1', printedStore: '00093121' },
      bankPayee: 'CHEVRON 0093121 VANCOUVER WA', cardTail: '0000',
    };
    const gasRaw = JSON.stringify({ version: 1, account: 'WTB-0723', facts: [gasFact] });
    const gas = parseReviewedReceiptFacts(gasRaw, sha(gasRaw));
    assert.equal(gas.status, 'valid');
    const raw = packet();
    assert.equal(parseReviewedReceiptPairs(raw, sha(raw), gas).status, 'invalid');
    for (const [key, value] of [['id', 'other-expense'], ['qbPurchaseId', '2000'], ['receiptUrl', 'https://example.invalid/pair/0.pdf']] as const) {
      const f = JSON.parse(JSON.stringify(gasFact));
      f.expected.id = 'other-expense';
      f.expected[key] = value;
      const r = JSON.stringify({ version: 1, account: 'WTB-0723', facts: [f] });
      assert.equal(parseReviewedReceiptPairs(raw, sha(raw), parseReviewedReceiptFacts(r, sha(r))).status, key === 'id' ? 'valid' : 'invalid', key);
    }
    // An absent or invalid gas packet reserves nothing.
    assert.equal(parseReviewedReceiptPairs(raw, sha(raw), parseReviewedReceiptFacts(undefined, undefined)).status, 'valid');
    assert.equal(parseReviewedReceiptPairs(raw, sha(raw), parseReviewedReceiptFacts(gasRaw, 'f'.repeat(64))).status, 'valid');
  });

  it('changes fingerprint on any packet revision and is byte-exact', () => {
    const raw1 = packet();
    const raw2 = patched('provenance.invoice', 'SYN-ORDER-1-002');
    const raw3 = raw1 + ' ';
    assert.notEqual(parse(raw1).fingerprint, parse(raw2).fingerprint);
    assert.equal(parse(raw3).status, 'valid');
    assert.notEqual(parse(raw3).fingerprint, parse(raw1).fingerprint);
    expectInvalid(raw3, sha(raw1));
  });
});

describe('resolveReviewedReceiptPair', () => {
  const cfg = parse(packet([pairA(), pairB()]));

  it('returns a minimal frozen projection on exact match, naming only the pinned target', () => {
    const out = resolveReviewedReceiptPair(inputA(), cfg);
    assert.ok(out);
    assert.equal(Object.isFrozen(out), true);
    assert.equal(Object.isFrozen(out.target), true);
    assert.deepEqual(Object.keys(out).sort(), ['amountCents', 'bankPayee', 'cardTail', 'expenseId', 'purchaseDate', 'qbPurchaseId', 'receiptUrl', 'sourceFactDigest', 'sourceFileId', 'sourceGroupIndex', 'target', 'targetBankLineId']);
    assert.equal(out.receiptUrl, 'https://example.invalid/pair/0.pdf');
    assert.equal(out.sourceFileId, null);
    assert.equal(out.sourceGroupIndex, null);
    // The merchant-receipt variant projects the same runtime shape: the Expense date is the
    // reviewed purchase date, and nothing from the merchant page rides along.
    const merchant = resolveReviewedReceiptPair({ ...pairB().expected }, cfg);
    assert.ok(merchant);
    assert.equal(merchant.purchaseDate, '2025-06-13');
    assert.equal(merchant.targetBankLineId, 'synthetic-pair-line-1');
    assert.deepEqual(Object.keys(merchant).sort(), Object.keys(out).sort());
    assert.equal(out.targetBankLineId, 'synthetic-pair-line-0');
    assert.deepEqual(out.target, {
      account: 'WTB-0723', sourceOfRecord: 'STATEMENT', postedDate: '2025-06-16', amountCents: -55555,
      rawDescriptor: RAW, checkNumber: null, bankAuthDate: '2025-06-14',
    });
    assert.equal(out.purchaseDate, '2025-06-13');
    assert.equal(out.amountCents, 55555);
    assert.equal(out.cardTail, '1111');
    assert.equal(out.bankPayee, 'PAYWEB *SYNTHMART 555-0100 NY');
    assert.equal(out.expenseId, 'synthetic-pair-expense-0');
    assert.equal(out.qbPurchaseId, '2000');
    assert.equal(out.sourceFactDigest, sha(JSON.stringify(cfg.pairs[0])));
  });

  it('digest is deterministic across independent parses and differs across pairs', () => {
    const again = parse(packet([pairA(), pairB()]));
    assert.equal(resolveReviewedReceiptPair(inputA(), again)?.sourceFactDigest, resolveReviewedReceiptPair(inputA(), cfg)?.sourceFactDigest);
    assert.notEqual(resolveReviewedReceiptPair({ ...pairB().expected }, cfg)?.sourceFactDigest, resolveReviewedReceiptPair(inputA(), cfg)?.sourceFactDigest);
  });

  it('returns null when any expected Expense field drifts, including the sync token version and source identity', () => {
    const drift: Record<string, unknown> = {
      id: 'synthetic-pair-expense-9', qbPurchaseId: '2009', qbSyncToken: '1', status: 'Pending', description: 'Synthetic remaining balance SYN-ORDER-1 edited',
      receiptUrl: 'https://example.invalid/pair/9.pdf', amountCents: 55554, date: '2025-06-14', vendor: 'OTHERMART',
      sourceFileId: 'synthetic-drive-file-0001', sourceGroupIndex: 0,
    };
    for (const [k, v] of Object.entries(drift)) {
      assert.equal(resolveReviewedReceiptPair({ ...inputA(), [k]: v } as ReviewedReceiptPairExpenseInput, cfg), null, k);
    }
    assert.equal(resolveReviewedReceiptPair({ ...inputA(), amountCents: '55555' } as unknown as ReviewedReceiptPairExpenseInput, cfg), null);
    assert.equal(resolveReviewedReceiptPair({ ...inputA(), date: null } as unknown as ReviewedReceiptPairExpenseInput, cfg), null);
    // An adapter that did not load the source identity columns supplies undefined, which is not the pinned null.
    const { sourceFileId: _f, sourceGroupIndex: _g, ...withoutSource } = inputA();
    assert.equal(resolveReviewedReceiptPair(withoutSource as unknown as ReviewedReceiptPairExpenseInput, cfg), null);
  });

  it('yields no edges for absent, invalid or revoked configs', () => {
    assert.equal(resolveReviewedReceiptPair(inputA(), parseReviewedReceiptPairs(undefined, undefined)), null);
    assert.equal(resolveReviewedReceiptPair(inputA(), parse(packet(), 'f'.repeat(64))), null);
    assert.equal(resolveReviewedReceiptPair(inputA(), parse(packet([pairB()]))), null);
    assert.equal(resolveReviewedReceiptPair(null as unknown as ReviewedReceiptPairExpenseInput, cfg), null);
  });

  it('never leaks review provenance into the runtime projection', () => {
    const email = JSON.stringify(resolveReviewedReceiptPair(inputA(), cfg));
    for (const secret of ['synthetic-message-0', 'a'.repeat(64), 'SYNTHTXN0000000001', 'SYN-ORDER-1-001', 'email_payment_confirmation']) {
      assert.equal(email.includes(secret), false, secret);
    }
    const merchant = JSON.stringify(resolveReviewedReceiptPair({ ...pairB().expected }, cfg));
    for (const secret of ['/order/receipt/', 'b'.repeat(64), 'SYN-ORDER-2', 'merchant_order_receipt', 'placedDate', 'displayed']) {
      assert.equal(merchant.includes(secret), false, secret);
    }
  });
});
