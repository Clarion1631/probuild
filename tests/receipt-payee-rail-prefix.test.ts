import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePayee } from '../src/lib/bank-ledger';
import { groupCompetingLines, payeeMatches, payeeTokens, planReceiptRequests } from '../src/lib/receipt-requests';

const cases = [
  ['MISCELLANEOUS DEBIT SPACE AGE #202 RETAIL SPACE AGE 202 RET', 'Space Age'],
  ['MISCELLANEOUS DEBIT COSTCO WHSE #0772 COSTCO WHSE 0772', 'COSTCO WHOLESALE'],
  ['MISCELLANEOUS DEBIT LOWE S #1632 LOWE S 1632', "Lowe's Home Improvement"],
];

test('full vendor names from the ledger match the observed store-form descriptors', () => {
  assert.equal(payeeMatches(normalizePayee(cases[1][0]), 'COSTCO WHOLESALE'), true);
  assert.equal(payeeMatches(normalizePayee(cases[2][0]), "Lowe's Home Improvement"), true);
  assert.equal(payeeMatches('COSTCO WHSE #0772', 'Costco Wholesale'), true);
});

test('store-form normalization is exact: different Lowes store pair is not canonicalized', () => {
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT LOWE S #1632 LOWE S 1633', "Lowe's Home Improvement"), false);
  assert.equal(payeeMatches('LOWE S #1632 LOWE S 1633', "Lowe's Home Improvement"), false);
});

test('unsupported Costco abbreviation is not expanded', () => {
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT COSTCO WHLS #0772 COSTCO WHLS 0772', 'COSTCO WHOLESALE'), false);
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT COSTCO WHOLESL #0772', 'COSTCO WHOLESALE'), false);
  // Mid-string WHSE is not respelled.
  assert.equal(payeeMatches('SPACE AGE COSTCO WHSE', 'Costco Wholesale'), false);
});

test('rail-phrase-only descriptor yields no merchant tokens and matches nothing', () => {
  assert.deepEqual(payeeTokens('MISCELLANEOUS DEBIT'), []);
  assert.deepEqual(payeeTokens('  miscellaneous   debit  '), []);
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT', 'COSTCO WHOLESALE'), false);
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT', "Lowe's Home Improvement"), false);
});
for (const [raw, vendor] of cases) test(`observed receipt merchant: ${vendor}`, () => {
  assert.equal(payeeMatches(normalizePayee(raw), vendor), true);
});
test('observed Space Age receipt is used by the production planner, not only standalone comparison', () => {
  const bankLines = [{ id:'case-line', postedDate:'2026-08-13', amountCents:-11150, rawDescriptor:cases[0][0]+' C#8516' }];
  const plan = planReceiptRequests({ bankLines, expenses:[{id:'case-expense',qbPurchaseId:'6548',hasReceipt:true,amountCents:11150,date:'2026-08-13',vendor:'Space Age'}],intakes:[],openIssueKeys:['case-line'],now:new Date('2026-09-10T12:00:00Z') });
  assert.deepEqual(plan.close,['case-line']); assert.deepEqual(plan.open,[]);
});

// ── Narrowness of the rail-prefix rule ──────────────────────────────────────

test('rail phrase is stripped only when it LEADS the descriptor', () => {
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT COSTCO WHSE #0772', 'Costco'), true);
  // Mid-string it is left alone: the bigram is still SPACE AGE, not a stripped remainder.
  assert.equal(payeeMatches('SPACE AGE MISCELLANEOUS DEBIT', 'Space Age'), true);
  // A descriptor that is ONLY the rail phrase has no merchant and never matches.
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT', 'Miscellaneous'), false);
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT', 'Debit'), false);
});

test('wrong merchant behind the rail phrase stays false', () => {
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT COSTCO WHSE #0772', 'Space Age'), false);
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT SPACE AGE #202 RETAIL', 'Costco'), false);
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT LOWE S #1632', 'Home Depot'), false);
  // Strict merchant distinctions survive: shared leading token is not identity.
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT HOME DEPOT #4718', 'Home Goods'), false);
  assert.equal(payeeMatches('MISCELLANEOUS DEBIT PACIFIC PLUMBING', 'Pacific Supply'), false);
});

test('no generic rail-prefix stripping: only the observed phrase is removed', () => {
  assert.equal(payeeMatches('MISCELLANEOUS CREDIT COSTCO WHSE #0772', 'Costco'), false);
  assert.equal(payeeMatches('DEBIT CARD PURCHASE COSTCO WHSE #0772', 'Costco'), false);
  assert.equal(payeeMatches('POS DEBIT COSTCO WHSE #0772', 'Costco'), false);
  assert.equal(payeeMatches('MISCELLANEOUS COSTCO WHSE #0772', 'Costco'), false);
});

test('LOWE S respelling is leading-position only, not a fuzzy brand rule', () => {
  assert.equal(payeeMatches('LOWE S #1632 LOWE S 1632', "Lowe's"), true);
  assert.equal(payeeMatches('LOWE S #1632', 'Lowes'), true);
  // Mid-string dangling S is not respelled: HOME DEPOT leads, and LOWE never becomes LOWES.
  assert.equal(payeeMatches('HOME DEPOT LOWE S', "Lowe's"), false);
  // The rule is spelled exactly: LOWE followed by a lone S. Other stems are untouched.
  assert.equal(payeeMatches('LOWE STREET MARKET', "Lowe's"), false);
  assert.equal(payeeMatches('ROWE S #1632', "Lowe's"), false);
});

test('case and whitespace insensitive', () => {
  assert.equal(payeeMatches('  miscellaneous   debit   costco whse #0772', 'COSTCO'), true);
  assert.equal(payeeMatches('\tMiscellaneous Debit Space Age #202', 'space age'), true);
  assert.equal(payeeMatches('miscellaneous debit lowe   s #1632', "LOWE'S"), true);
  assert.equal(payeeMatches('miscellaneous debit lowe s #1632 lowe s 1632', "lowe's home improvement"), true);
  assert.equal(payeeMatches('miscellaneous debit costco whse #0772 costco whse 0772', 'costco wholesale'), true);
});

// ── Production planner over the three observed cases ────────────────────────

const NOW = new Date('2026-09-10T12:00:00Z');
const planFor = (raw: string, vendor: string, over: { amountCents?: number; date?: string } = {}) => planReceiptRequests({
  bankLines: [{ id: 'obs-line', postedDate: '2026-08-13', amountCents: -11150, rawDescriptor: raw + ' C#8516' }],
  expenses: [{ id: 'obs-expense', qbPurchaseId: '6548', hasReceipt: true, amountCents: over.amountCents ?? 11150, date: over.date ?? '2026-08-13', vendor }],
  intakes: [],
  openIssueKeys: ['obs-line'],
  now: NOW,
});

for (const [raw, vendor] of cases) test(`planner closes the observed ${vendor} chase`, () => {
  const plan = planFor(raw, vendor);
  assert.deepEqual(plan.close, ['obs-line']);
  assert.deepEqual(plan.open, []);
});

test('planner keeps the chase open for the wrong merchant behind the rail phrase', () => {
  const plan = planFor(cases[1][0], 'Space Age');
  assert.deepEqual(plan.close, []);
});

test('amount mismatch is not rescued by the rail-prefix rule', () => {
  const plan = planFor(cases[0][0], 'Space Age', { amountCents: 11151 });
  assert.deepEqual(plan.close, []);
});

test('date outside the slop window is not rescued by the rail-prefix rule', () => {
  const plan = planFor(cases[0][0], 'Space Age', { date: '2026-08-20' });
  assert.deepEqual(plan.close, []);
});

test('duplicate charges: one receipt closes ONE of two identical observed lines', () => {
  const plan = planReceiptRequests({
    bankLines: [
      { id: 'dup-a', postedDate: '2026-08-13', amountCents: -11150, rawDescriptor: cases[0][0] + ' C#8516' },
      { id: 'dup-b', postedDate: '2026-08-13', amountCents: -11150, rawDescriptor: cases[0][0] + ' C#8516' },
    ],
    expenses: [{ id: 'dup-expense', qbPurchaseId: '6548', hasReceipt: true, amountCents: 11150, date: '2026-08-13', vendor: 'Space Age' }],
    intakes: [],
    openIssueKeys: [],
    now: NOW,
  });
  assert.deepEqual(plan.close, []);
  assert.equal(plan.open.length, 1, 'one evidence unit satisfies exactly one charge');
  assert.ok(['dup-a', 'dup-b'].includes(plan.open[0].targetKey));
});

test('graph cohesion: rail-prefixed lines still form one competition component', () => {
  const components = groupCompetingLines([
    { id: 'g-a', postedDate: '2026-08-13', amountCents: -11150, rawDescriptor: cases[0][0] + ' C#8516' },
    { id: 'g-b', postedDate: '2026-08-15', amountCents: -11150, rawDescriptor: cases[1][0] + ' C#8516' },
    { id: 'g-c', postedDate: '2026-08-13', amountCents: -99999, rawDescriptor: cases[2][0] + ' C#8516' },
  ] as never);
  const keyed = new Map(components.map(c => [c.key, c.lineIds]));
  assert.deepEqual(keyed.get('2026-08-13|g-a'), ['g-a', 'g-b']);
  assert.deepEqual(keyed.get('2026-08-13|g-c'), ['g-c']);
  assert.equal(components.length, 2);
});

for (const [left, right] of [['HOME DEPOT', 'HOME GOODS'], ['PACIFIC PLUMBING', 'PACIFIC SUPPLY'], ['SPACE AGE', 'COSTCO WHSE']]) {
  test(`shared bank rail prefix does not make ${left} match ${right}`, () => {
    const a = 'MISCELLANEOUS DEBIT '+left, b = 'MISCELLANEOUS DEBIT '+right;
    assert.equal(payeeMatches(normalizePayee(a), normalizePayee(b)), false);
    assert.equal(payeeMatches(normalizePayee(b), normalizePayee(a)), false);
  });
}


test('exact curly-apostrophe ledger vendor keeps Unicode behavior in comparison and planner', () => {
  const vendor = "Lowe\u2019s Home Improvement";
  assert.equal(payeeMatches(normalizePayee(cases[2][0]), vendor), true);
  assert.deepEqual(payeeTokens(vendor), payeeTokens("Lowe's Home Improvement"));
  const plan = planFor(cases[2][0], vendor);
  assert.deepEqual(plan.close, ['obs-line']);
  assert.deepEqual(plan.open, []);
});
