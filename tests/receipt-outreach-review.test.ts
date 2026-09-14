import test from 'node:test';
import assert from 'node:assert/strict';
import { planReceiptRequests, payeeMatches } from '../src/lib/receipt-requests';
import { selectOwnerItems, rebuildCardItems, type CardCandidateIssue } from '../src/lib/receipt-request-cards';

const candidate = (over: Partial<CardCandidateIssue> = {}): CardCandidateIssue => ({
  id: 'issue', targetKey: 'line', owner: 'Richard', acknowledged: false, cardTail: '6098',
  postedDate: '2026-08-20', amountCents: -2163, payee: 'OPENAI CHATGPT SUBSCR',
  fingerprint: 'pb-line', everCarded: false, ...over,
});

test('software invoices never enter crew cards, including OpenRouter and normalized OpenAI billing text', () => {
  for (const payee of ['OPENAI CHATGPT SUBSCR OPENAI.COM CA', 'OPENROUTER, INC OPENROUTER.AI NY']) {
    assert.deepEqual(selectOwnerItems([candidate({ payee })], 'Richard'), { items: [], overflow: 0 });
  }
  assert.equal(selectOwnerItems([candidate({ payee: 'LOCAL HARDWARE' })], 'Richard').items.length, 1);
});

test('uncertain existing documents stay open for internal review instead of a crew request', () => {
  for (const [bankVendor, documentVendor, bankDate, documentDate] of [
    ['WESTSIDE CONCRETE ACCE', 'Westside Accessories', '2026-08-18', '2026-08-17'],
    ['CHEVRON RIDGEFIELD', 'Cowlitz Crossing', '2026-08-19', '2026-08-18'],
    ['US MARKET US MARKET', 'VeriFone Gold Disk', '2026-08-20', '2026-08-20'],
    ['SHERWIN-WILLIAMS708008', 'Sherwin-Williams', '2026-08-24', '2026-08-21'],
    ['AMAZON MKTPL', 'Amazon', '2026-08-18', '2026-09-02'],
  ]) {
    const plan = planReceiptRequests({
      bankLines: [{ id: 'line', amountCents: -12345, postedDate: bankDate, rawDescriptor: `${bankVendor} C#6098` }],
      expenses: [{ id: 'existing-document', hasReceipt: true, amountCents: 12345, date: documentDate, vendor: documentVendor }],
      intakes: [], openIssueKeys: ['line'], now: new Date('2026-09-14T12:00:00Z'),
    });
    assert.deepEqual(plan.close, [], 'uncertainty must not certify or close a receipt');
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].displayDetails.outreachHold, 'existing-evidence-review', bankVendor);
  }
});

test('different amount or distant document does not indefinitely block a missing receipt', () => {
  for (const [amountCents, date] of [[12346, '2026-08-20'], [12345, '2026-01-20']] as const) {
    const plan = planReceiptRequests({ bankLines: [{ id: 'line', amountCents: -12345, postedDate: '2026-08-20', rawDescriptor: 'HARDWARE C#6098' }],
      expenses: [{ id: 'other', hasReceipt: true, amountCents, date, vendor: 'Other' }], intakes: [], openIssueKeys: [], now: new Date('2026-09-14') });
    assert.equal(plan.open[0].displayDetails.outreachHold, null);
  }
});

test('a queued card is dropped when internal evidence review or office policy now applies', () => {
  const item = selectOwnerItems([candidate({ payee: 'HARDWARE' })], 'Richard').items[0];
  for (const outreachHold of ['existing-evidence-review', 'office-invoice'] as const) {
    const result = rebuildCardItems([item], new Map([['issue', { clearedAt: null, acknowledged: false, resolved: false, evidenceSatisfied: false, owner: 'Richard', outreachHold }]]), 'Richard');
    assert.equal(result.items.length, 0);
    assert.equal(result.dropped[0].reason, outreachHold);
  }
});

test('an attached store number does not change Sherwin-Williams merchant identity', () => {
  assert.equal(payeeMatches('SHERWIN-WILLIAMS708008 VANCOUVER', 'Sherwin-Williams'), true);
  assert.equal(payeeMatches('OTHER-WILLIAMS708008', 'Sherwin-Williams'), false);
});
