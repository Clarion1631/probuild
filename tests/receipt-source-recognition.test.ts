import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planReceiptRequests, groupCompetingLines, loadComponentToClosure, componentVersionOf, componentVersionsMatch } from '../src/lib/receipt-requests';
import { bankAuthPurchaseDate, observedReceiptMerchantMatches } from '../src/lib/receipt-source-recognition';
import { cycleStillValid, parseSweepCycle } from '../src/lib/receipt-sweep-marker';

/**
 * Source-recognition regression tests (test-first).
 *
 * Six observed bank lines were chased for a receipt that already existed in
 * QuickBooks. Two things kept the existing matcher from seeing the evidence:
 *   - merchant alias: the bank label (PARKROSE HAZEL DELL ..., ARCO#82887KT ...)
 *     does not token-match the QBO vendor (Parkrose Hardware, AMPM #82887);
 *   - authorization date: the bank descriptor carries the purchase date
 *     (POS DEB HHMM MM/DD/YY trace / DBT CRD HHMM MM/DD/YY trace) and the
 *     receipt is dated on that purchase date, 3 days before the posting.
 *
 * The repair is gated: `sourceRecognitionEnabled` (default false) AND the
 * line must come from the canonical STATEMENT source of record for account
 * WTB-0723. Everything else about the planner is unchanged.
 *
 * Fixture metadata (preserved from the handoff record): every fixture has
 * canonicalRawDescriptorVerified=false, canonicalSourceOfRecordVerified=false,
 * financialBindingAsserted=false. These rows are OBSERVED inputs; nothing here
 * asserts a financial binding. The tests only say what the chase planner
 * should do with them once the source gate is satisfied.
 */

// Fixed clock so the grace window never depends on the day the suite runs.
const NOW = new Date('2026-10-10T12:00:00Z');

const STATEMENT = { sourceOfRecord: 'STATEMENT', account: 'WTB-0723' };
const WRONG_SOURCE = { sourceOfRecord: 'QBO', account: 'WTB-0723' };
const WRONG_ACCOUNT = { sourceOfRecord: 'STATEMENT', account: 'WTB-0724' };
const NO_SOURCE = {};

// Cast to any: the new bank-line properties and the planner flag do not exist
// until the implementation lands. Baseline must execute, and fail on the six.
function line(id: string, postedDate: string, amountCents: number, rawDescriptor: string, source: object = STATEMENT): any {
  return { id, postedDate, amountCents, rawDescriptor, ...source };
}

function receipt(id: string, date: string | null, vendor: string | null, amountCents: number, extra: object = {}): any {
  return { id, qbPurchaseId: null, hasReceipt: true, amountCents, date, vendor, ...extra };
}

interface RunOpts {
  flag?: boolean;
  intakes?: any[];
  openIssueKeys?: string[];
}

function run(bankLines: any[], expenses: any[], opts: RunOpts = {}): any {
  const { flag = true, intakes = [], openIssueKeys = bankLines.map((l) => l.id) } = opts;
  const input: any = { bankLines, expenses, intakes, openIssueKeys, now: NOW };
  if (flag) input.sourceRecognitionEnabled = true;
  const result = planReceiptRequests(input);
  return { ...result, open: result.open.map(row => row.targetKey) };
}

/** Ids the planner closes when every line is already open. */
function satisfied(bankLines: any[], expenses: any[], opts: RunOpts = {}): string[] {
  return run(bankLines, expenses, opts).close;
}

// ── Observed fixtures ───────────────────────────────────────────────────────

const FIXTURES = [
  {
    card: 3,
    id: 'd3925347-0222-4cb1-af9f-4892cd976d08',
    posted: '2026-08-13',
    cents: 10585,
    raw: 'ARCO#82887KT KANSO LLC 2 3817 MAIN ST POS DEB 1305 08/12/26 60884400 VANCOUVER     WA C#6098',
    qb: '6546',
    date: '2026-08-12',
    vendor: 'AMPM #82887',
    needs: 'alias',
  },
  {
    card: 4,
    id: '9f731b03-ac30-4f51-82e9-e0b37d9b9908',
    posted: '2026-08-14',
    cents: 7419,
    raw: 'PARKROSE HAZEL DELL - PARKROSE HAZEL DEL POS DEB 1113 08/14/26 00873866 HAZEL DELL    WA C#6098',
    qb: '6613',
    date: '2026-08-14',
    vendor: 'Parkrose Hardware',
    needs: 'alias',
  },
  {
    card: 5,
    id: '1ec357c1-0d51-4078-9fbe-4fd44d855d4f',
    posted: '2026-08-17',
    cents: 30423,
    raw: 'LOWES #01632* 360-260-2120  WA C#6098 DBT CRD 0958 08/14/26 39216356',
    qb: '6609',
    date: '2026-08-14',
    vendor: "LOWE'S HOME CENTERS, LLC",
    needs: 'date',
  },
  {
    card: 6,
    id: '21d48224-08e6-41f4-81ec-432d4f8d4bae',
    posted: '2026-08-17',
    cents: 23949,
    raw: 'LOWES #00907* 866-483-7521  NC C#6098 DBT CRD 0443 08/14/26 50050131',
    qb: '6606',
    date: '2026-08-14',
    vendor: "Lowe's Home Improvement",
    needs: 'date',
  },
  {
    card: 8,
    id: '92044dd3-995c-4e5e-9eea-61a646d2f4aa',
    posted: '2026-08-17',
    cents: 8733,
    raw: 'PARKROSE HAZEL DELL - PARKROSE HAZEL DEL POS DEB 1211 08/14/26 00528425 HAZEL DELL    WA C#6098',
    qb: '6614',
    date: '2026-08-14',
    vendor: 'Parkrose Hardware',
    needs: 'alias+date',
  },
  {
    card: 10,
    id: 'c9ae6e10-7cf2-47cc-bf19-372711b8a15c',
    posted: '2026-08-17',
    cents: 3599,
    raw: 'PARKROSE HAZEL DELL - HAZEL DELL    WA C#6098 DBT CRD 1631 08/15/26 74723625',
    qb: '6734',
    date: '2026-08-15',
    vendor: 'Parkrose Hardware',
    needs: 'alias',
  },
];

function fixtureLines(source: object = STATEMENT): any[] {
  return FIXTURES.map((f) => line(f.id, f.posted, -f.cents, f.raw, source));
}

function fixtureReceipts(): any[] {
  return FIXTURES.map((f) => receipt('exp-' + f.card, f.date, f.vendor, f.cents, { qbPurchaseId: f.qb }));
}

const ALL_IDS = FIXTURES.map((f) => f.id);

// ── The six false asks ──────────────────────────────────────────────────────

test('with recognition enabled on the canonical statement source, all six observed lines are satisfied', () => {
  const closed = satisfied(fixtureLines(), fixtureReceipts());
  assert.deepEqual([...closed].sort(), [...ALL_IDS].sort());
  // And when nothing is open yet, none of the six are asked for.
  const fresh = run(fixtureLines(), fixtureReceipts(), { openIssueKeys: [] });
  assert.deepEqual(fresh.open.filter((id: string) => ALL_IDS.includes(id)), []);
});

for (const f of FIXTURES) {
  test(`card ${f.card} (${f.needs}) is satisfied on its own`, () => {
    const closed = satisfied([line(f.id, f.posted, -f.cents, f.raw)], [receipt('e', f.date, f.vendor, f.cents, { qbPurchaseId: f.qb })]);
    assert.deepEqual(closed, [f.id]);
  });
}

test('flag off: the six stay open even on the canonical source (existing behavior unchanged)', () => {
  assert.deepEqual(satisfied(fixtureLines(), fixtureReceipts(), { flag: false }), []);
  const fresh = run(fixtureLines(), fixtureReceipts(), { flag: false, openIssueKeys: [] });
  assert.deepEqual([...fresh.open].sort(), [...ALL_IDS].sort());
});

test('flag on but wrong source of record gains nothing', () => {
  assert.deepEqual(satisfied(fixtureLines(WRONG_SOURCE), fixtureReceipts()), []);
});

test('flag on but wrong account gains nothing', () => {
  assert.deepEqual(satisfied(fixtureLines(WRONG_ACCOUNT), fixtureReceipts()), []);
});

test('flag on but no source/account on the line gains nothing', () => {
  assert.deepEqual(satisfied(fixtureLines(NO_SOURCE), fixtureReceipts()), []);
});

test('the gate is per line: only canonical lines in a mixed batch gain edges', () => {
  const good = FIXTURES[1];
  const bad = FIXTURES[4];
  const lines = [
    line(good.id, good.posted, -good.cents, good.raw, STATEMENT),
    line(bad.id, bad.posted, -bad.cents, bad.raw, WRONG_SOURCE),
  ];
  const receipts = [
    receipt('g', good.date, good.vendor, good.cents),
    receipt('b', bad.date, bad.vendor, bad.cents),
  ];
  assert.deepEqual(satisfied(lines, receipts), [good.id]);
});

// ── Existing rules are untouched ────────────────────────────────────────────

const LOWES_RAW = 'LOWES #01632* 360-260-2120  WA C#6098 DBT CRD 0958 08/14/26 39216356';

test('ordinary exact-cents + payee + ±2 day match still closes with the flag off and no source', () => {
  const lines = [line('ordinary', '2026-08-15', -30423, LOWES_RAW, NO_SOURCE)];
  const receipts = [receipt('e', '2026-08-14', "Lowe's Home Improvement", 30423)];
  assert.deepEqual(satisfied(lines, receipts, { flag: false }), ['ordinary']);
  assert.deepEqual(satisfied(lines, receipts, { flag: true }), ['ordinary']);
});

test('recognition does not widen the ordinary ±2 window for lines outside the gate', () => {
  // 3 calendar days, no purchase-date edge available because the line is not canonical.
  const lines = [line('l3', '2026-08-17', -30423, LOWES_RAW, NO_SOURCE)];
  const receipts = [receipt('e', '2026-08-14', "Lowe's Home Improvement", 30423)];
  assert.deepEqual(satisfied(lines, receipts), []);
});

test('an expense without a receipt is never evidence, gate or no gate', () => {
  const f = FIXTURES[1];
  const receipts = [receipt('e', f.date, f.vendor, f.cents, { hasReceipt: false })];
  assert.deepEqual(satisfied([line(f.id, f.posted, -f.cents, f.raw)], receipts), []);
});

test('one cent off is not a match, gate or no gate', () => {
  const f = FIXTURES[0];
  const receipts = [receipt('e', f.date, f.vendor, f.cents + 1)];
  assert.deepEqual(satisfied([line(f.id, f.posted, -f.cents, f.raw)], receipts), []);
});

test('a credit is exempt under the existing policy, independent of recognition', () => {
  const f = FIXTURES[1];
  const plan = run([line('credit', f.posted, f.cents, f.raw)], [receipt('e', f.date, f.vendor, f.cents)]);
  assert.deepEqual(plan.close, ['credit']); // Existing policy clears a credit issue.
  const fresh = run([line('credit', f.posted, f.cents, f.raw)], [], { openIssueKeys: [] });
  assert.deepEqual(fresh.open, []);
});

// ── Alias narrowness ────────────────────────────────────────────────────────

test('ARCO store 82888 does not alias to AMPM #82887', () => {
  const f = FIXTURES[0];
  const raw = f.raw.replace('ARCO#82887KT', 'ARCO#82888KT');
  assert.deepEqual(satisfied([line('x', f.posted, -f.cents, raw)], [receipt('e', f.date, f.vendor, f.cents)]), []);
});

test('AMPM without a store number does not alias to the ARCO label', () => {
  const f = FIXTURES[0];
  assert.deepEqual(satisfied([line(f.id, f.posted, -f.cents, f.raw)], [receipt('e', f.date, 'AMPM', f.cents)]), []);
  assert.deepEqual(satisfied([line(f.id, f.posted, -f.cents, f.raw)], [receipt('e', f.date, 'ampm', f.cents)]), []);
});

test('a generic ARCO label does not alias to AMPM #82887 (no store-number stripping, no brand rule)', () => {
  const f = FIXTURES[0];
  const raw = 'ARCO #82887 VANCOUVER WA POS DEB 1305 08/12/26 60884400 C#6098';
  assert.deepEqual(satisfied([line('x', f.posted, -f.cents, raw)], [receipt('e', f.date, f.vendor, f.cents)]), []);
  // Existing same-brand matching is unchanged; this test constrains cross-brand additions.
});

test('Parkrose bank labels alias only to Parkrose Hardware, not to other Parkrose names', () => {
  const f = FIXTURES[1];
  for (const vendor of ['Parkrose Bakery', 'Parkrose Plumbing', 'Hazel Dell Hardware']) {
    assert.deepEqual(satisfied([line(f.id, f.posted, -f.cents, f.raw)], [receipt('e', f.date, vendor, f.cents)]), [], vendor);
  }
});

test('only the two observed Parkrose bank labels alias; a third Parkrose label does not', () => {
  const f = FIXTURES[1];
  const raw = 'PARKROSE HAZEL DELL - PARKROSE PLUMBING POS DEB 1113 08/14/26 00873866 HAZEL DELL    WA C#6098';
  assert.deepEqual(satisfied([line('x', f.posted, -f.cents, raw)], [receipt('e', f.date, 'Parkrose Hardware', f.cents)]), []);
  const rawTwo = 'PARKROSE SANDY BLVD - PARKROSE SANDY POS DEB 1113 08/14/26 00873866 PORTLAND      OR C#6098';
  assert.deepEqual(satisfied([line('y', f.posted, -f.cents, rawTwo)], [receipt('e', f.date, 'Parkrose Hardware', f.cents)]), []);
});

// ── Authorization-date narrowness (merchant already matches: LOWES) ─────────

function lowes(purchase: string, opts: { marker?: string; time?: string; card?: string; trace?: string; tail?: string } = {}): string {
  const { marker = 'DBT CRD', time = '0958', card = ' C#6098', trace = '39216356', tail = '' } = opts;
  return `LOWES #01632* 360-260-2120  WA${card} ${marker} ${time} ${purchase} ${trace}${tail}`;
}

const LOWES_VENDOR = "Lowe's Home Improvement";

function dateCase(id: string, posted: string, raw: string, evidenceDate: string, cents = 30423): string[] {
  return satisfied([line(id, posted, -cents, raw)], [receipt('e', evidenceDate, LOWES_VENDOR, cents)]);
}

test('exact 7-day gap (holiday weekend) succeeds when purchase date equals evidence date', () => {
  // Labor Day 2026 is Mon 09/07; a Tue 09/01 swipe posts Tue 09/08.
  assert.deepEqual(dateCase('h7', '2026-09-08', lowes('09/01/26'), '2026-09-01'), ['h7']);
});

test('POS DEB form of the marker works the same as DBT CRD', () => {
  assert.deepEqual(dateCase('pos', '2026-09-08', lowes('09/01/26', { marker: 'POS DEB' }), '2026-09-01'), ['pos']);
});

test('8-day gap fails', () => {
  assert.deepEqual(dateCase('h8', '2026-09-09', lowes('09/01/26'), '2026-09-01'), []);
});

test('purchase date after the posted date fails', () => {
  assert.deepEqual(dateCase('future', '2026-08-31', lowes('09/04/26'), '2026-09-04'), []);
});

test('purchase date must equal the evidence date exactly; nearby evidence is not ±7 fuzzy', () => {
  assert.deepEqual(dateCase('near1', '2026-09-08', lowes('09/01/26'), '2026-09-02'), []);
  assert.deepEqual(dateCase('near2', '2026-09-08', lowes('09/01/26'), '2026-08-31'), []);
  assert.deepEqual(dateCase('near3', '2026-09-08', lowes('09/01/26'), '2026-09-05'), []);
});

test('no purchase-date marker means no date edge, even within 7 days', () => {
  const raw = 'LOWES #01632* 360-260-2120  WA C#6098';
  assert.deepEqual(dateCase('nomarker', '2026-09-08', raw, '2026-09-01'), []);
  assert.deepEqual(dateCase('bareDate', '2026-09-08', 'LOWES #01632* 09/01/26 WA C#6098', '2026-09-01'), []);
});

test('invalid calendar date in the descriptor fails', () => {
  assert.deepEqual(dateCase('feb30', '2026-03-05', lowes('02/30/26'), '2026-03-02'), []);
  assert.deepEqual(dateCase('m13', '2026-09-08', lowes('13/01/26'), '2026-09-01'), []);
});

test('wrong year form fails', () => {
  assert.deepEqual(dateCase('yyyy', '2026-09-08', lowes('09/01/2026'), '2026-09-01'), []);
  assert.deepEqual(dateCase('y99', '2026-09-08', lowes('09/01/99'), '2026-09-01'), []);
});

test('invalid time fails', () => {
  assert.deepEqual(dateCase('t2460', '2026-09-08', lowes('09/01/26', { time: '2460' }), '2026-09-01'), []);
  assert.deepEqual(dateCase('t999', '2026-09-08', lowes('09/01/26', { time: '999' }), '2026-09-01'), []);
});

test('non-eight-digit trace fails', () => {
  assert.deepEqual(dateCase('trace7', '2026-09-08', lowes('09/01/26', { trace: '3921635' }), '2026-09-01'), []);
  assert.deepEqual(dateCase('trace9', '2026-09-08', lowes('09/01/26', { trace: '392163561' }), '2026-09-01'), []);
});

test('multiple markers fail', () => {
  const raw = lowes('09/01/26', { tail: ' POS DEB 1000 09/01/26 39216357' });
  assert.deepEqual(dateCase('two-markers', '2026-09-08', raw, '2026-09-01'), []);
});

test('multiple dates fail', () => {
  assert.deepEqual(dateCase('two-dates', '2026-09-08', lowes('09/01/26', { tail: ' 09/02/26' }), '2026-09-01'), []);
  assert.deepEqual(dateCase('same-date-twice', '2026-09-08', lowes('09/01/26', { tail: ' 09/01/26' }), '2026-09-01'), []);
});

test('card marker missing or malformed fails', () => {
  assert.deepEqual(dateCase('nocard', '2026-09-08', lowes('09/01/26', { card: '' }), '2026-09-01'), []);
  assert.deepEqual(dateCase('shortcard', '2026-09-08', lowes('09/01/26', { card: ' C#60' }), '2026-09-01'), []);
});

test('two card markers fail', () => {
  assert.deepEqual(dateCase('twocards', '2026-09-08', lowes('09/01/26', { tail: ' C#6098' }), '2026-09-01'), []);
  assert.deepEqual(dateCase('twocards2', '2026-09-08', lowes('09/01/26', { tail: ' C#1234' }), '2026-09-01'), []);
});

test('date edge needs the merchant too: a valid purchase date on a different merchant is not evidence', () => {
  const lines = [line('other', '2026-09-08', -30423, lowes('09/01/26'))];
  assert.deepEqual(satisfied(lines, [receipt('e', '2026-09-01', 'Home Depot', 30423)]), []);
});

test('date edge requires the gate: same descriptor off the canonical source fails', () => {
  const lines = [line('gated', '2026-09-08', -30423, lowes('09/01/26'), WRONG_SOURCE)];
  assert.deepEqual(satisfied(lines, [receipt('e', '2026-09-01', LOWES_VENDOR, 30423)]), []);
  assert.deepEqual(satisfied([line('gated2', '2026-09-08', -30423, lowes('09/01/26'))], [receipt('e', '2026-09-01', LOWES_VENDOR, 30423)], { flag: false }), []);
});

// ── Capacity and folding ────────────────────────────────────────────────────

test('duplicate bank charges with one shared receipt: only one line closes', () => {
  const raw = lowes('09/01/26');
  const lines = [line('dupA', '2026-09-08', -30423, raw), line('dupB', '2026-09-08', -30423, raw)];
  const closed = satisfied(lines, [receipt('e', '2026-09-01', LOWES_VENDOR, 30423)]);
  assert.equal(closed.length, 1);
  assert.ok(closed[0] === 'dupA' || closed[0] === 'dupB');
  // Deterministic across runs.
  assert.deepEqual(satisfied(lines, [receipt('e', '2026-09-01', LOWES_VENDOR, 30423)]), closed);
});

test('an Expense and the ReceiptIntake that booked it share one qbPurchaseId and do not double capacity', () => {
  const raw = lowes('09/01/26');
  const lines = [line('dupA', '2026-09-08', -30423, raw), line('dupB', '2026-09-08', -30423, raw)];
  const expenses = [receipt('exp-1', '2026-09-01', LOWES_VENDOR, 30423, { qbPurchaseId: '6609' })];
  const intakes = [{
    id: 'intake-1',
    stateReason: null,
    expenseId: 'exp-1',
    qbPurchaseId: '6609',
    totalCents: 30423,
    txnDate: '2026-09-01',
    vendor: LOWES_VENDOR,
    state: 'BOOKED',
  }];
  assert.equal(satisfied(lines, expenses, { intakes }).length, 1);
});

test('two distinct receipts close two duplicate charges', () => {
  const raw = lowes('09/01/26');
  const lines = [line('dupA', '2026-09-08', -30423, raw), line('dupB', '2026-09-08', -30423, raw)];
  const expenses = [
    receipt('exp-1', '2026-09-01', LOWES_VENDOR, 30423, { qbPurchaseId: '7001' }),
    receipt('exp-2', '2026-09-01', LOWES_VENDOR, 30423, { qbPurchaseId: '7002' }),
  ];
  assert.deepEqual([...satisfied(lines, expenses)].sort(), ['dupA', 'dupB']);
});

test('out-of-window receipt from the same merchant and an in-window receipt from another merchant leave the line missing', () => {
  const lines = [line('miss', '2026-09-08', -30423, lowes('09/01/26'))];
  const expenses = [
    receipt('far', '2026-08-10', LOWES_VENDOR, 30423),
    receipt('otherMerchant', '2026-09-01', 'Home Depot', 30423),
    receipt('otherAmount', '2026-09-01', LOWES_VENDOR, 30424),
  ];
  assert.deepEqual(satisfied(lines, expenses), []);
  const fresh = run(lines, expenses, { openIssueKeys: [] });
  assert.deepEqual(fresh.open, ['miss']);
});

test('recognition never infers a match from amount and date alone', () => {
  const f = FIXTURES[1];
  const lines = [line(f.id, f.posted, -f.cents, f.raw)];
  assert.deepEqual(satisfied(lines, [receipt('e', f.date, null, f.cents)]), []);
  assert.deepEqual(satisfied(lines, [receipt('e', f.date, '', f.cents)]), []);
  assert.deepEqual(satisfied(lines, [receipt('e', f.date, 'Chevron', f.cents)]), []);
});

test('source extension does not create evidence from a check or malformed posted date', () => {
  const l = line('check', '2026-09-08', -30423, lowes('09/01/26'));
  assert.equal(bankAuthPurchaseDate({ ...l, checkNumber: '123' }), null);
  assert.deepEqual(satisfied([{ ...l, checkNumber: '123' }], [receipt('e', '2026-09-01', LOWES_VENDOR, 30423)]), []);
  assert.equal(bankAuthPurchaseDate({ ...l, postedDate: '2026-09-32' }), null);
});

test('invalid auth metadata never removes a valid ordinary two-day edge', () => {
  const l = line('ordinary-invalid', '2026-09-08', -30423, lowes('09/01/26', { tail: ' POS DEB 9999 09/02/26 11111111' }));
  assert.equal(bankAuthPurchaseDate(l), null);
  assert.deepEqual(satisfied([l], [receipt('e', '2026-09-07', LOWES_VENDOR, 30423)]), ['ordinary-invalid']);
});

test('incomplete auth-date evidence coverage stays undecided, never missing or satisfied', () => {
  const l = line('bounded', '2026-09-08', -30423, lowes('09/01/26'));
  const result = planReceiptRequests({ sourceRecognitionEnabled: true, bankLines: [l], expenses: [], intakes: [], openIssueKeys: ['bounded'], now: NOW, evidenceLoadedFrom: '2026-09-06', evidenceLoadedTo: '2026-09-10' });
  assert.deepEqual(result.undecided, ['bounded']);
  assert.deepEqual(result.open, []);
  assert.deepEqual(result.close, []);
});

test('nine-day competing gap keeps one receipt shared by ordinary and auth-date edges', () => {
  const lines = [
    line('ordinary-earlier', '2026-09-01', -30423, 'LOWES C#6098'),
    line('auth-later', '2026-09-10', -30423, lowes('09/03/26')),
  ];
  assert.equal(groupCompetingLines(lines).length, 2, 'default policy unchanged');
  assert.equal(groupCompetingLines(lines, 9).length, 1, 'enabled query component is complete');
  const result = satisfied(lines, [receipt('shared', '2026-09-03', LOWES_VENDOR, 30423)]);
  assert.equal(result.length, 1, 'one receipt is never assigned twice across the expanded interval');
});

test('enabled nine-day closure walks transitive chains and remains bounded', async () => {
  const base = Date.parse('2026-08-01T00:00:00Z');
  const date = (day: number) => new Date(base + day * 86400000).toISOString().slice(0, 10);
  const rows = [0, 9, 18, 27].map(day => ({ id: `line-${day}`, postedDate: date(day) }));
  const load = async (from: string, to: string) => rows.filter(row => row.postedDate >= from && row.postedDate <= to);
  assert.equal((await loadComponentToClosure(date(0), load, { maxNodes: 10, linkDays: 9 })).length, 4);
  await assert.rejects(loadComponentToClosure(date(0), load, { maxNodes: 3, linkDays: 9 }));
});

test('source/account corrections invalidate component recognition fingerprint without a timestamp hint', () => {
  const source = { id: 'line', rawDescriptor: LOWES_RAW, account: 'WTB-0723', sourceOfRecord: 'STATEMENT' };
  const stamp = (line: typeof source) => componentVersionOf({ issues: [], intakes: [], lines: [line] });
  assert.equal(componentVersionsMatch(stamp(source), stamp({ ...source, sourceOfRecord: 'QBO' })), false);
  assert.equal(componentVersionsMatch(stamp(source), stamp({ ...source, account: 'WTB-0724' })), false);
});

test('bulk route adapter preserves canonical source fields for alias and auth-date cases', () => {
  const source = readFileSync(new URL('../src/app/api/cron/receipt-requests/route.ts', import.meta.url), 'utf8');
  const expression = source.match(/bankLines: (lines\.map\(row => \(\{[\s\S]*?\}\)\)),/);
  assert.ok(expression, 'test the actual production bulk adapter');
  const adapt = new Function('lines', `return ${expression[1]};`) as (lines: unknown[]) => any[];
  for (const f of [FIXTURES[0], FIXTURES[2]]) {
    const mapped = adapt([{ ...line(f.id, f.posted, -f.cents, f.raw), postedDate: new Date(`${f.posted}T00:00:00Z`), checkNumber: null }]);
    assert.equal(mapped[0].sourceOfRecord, 'STATEMENT');
    assert.equal(mapped[0].account, 'WTB-0723');
    assert.deepEqual(satisfied(mapped, [receipt('e', f.date, f.vendor, f.cents)]), [f.id]);
  }
  assert.match(source, /const SOURCE_RECOGNITION_ENABLED = process\.env\.RECEIPT_SOURCE_RECOGNITION_ENABLED === "true"/);
  assert.equal((source.match(/sourceRecognitionEnabled: SOURCE_RECOGNITION_ENABLED/g) ?? []).length, 2, 'bulk and recompute use the same explicit gate');
});

test('completed sweep certification cannot cross recognition policy changes', () => {
  const base = { id: 'cycle', epoch: '1', evidenceEpoch: '2' };
  const valid = cycleStillValid as (...args: any[]) => boolean;
  const legacy = parseSweepCycle(JSON.stringify(base));
  assert.equal(valid(legacy, '1', '2', 'receipt-source-v1:off'), true);
  assert.equal(valid(legacy, '1', '2', 'receipt-source-v1:on'), false);
  const enabled = parseSweepCycle(JSON.stringify({ ...base, recognitionPolicy: 'receipt-source-v1:on' }));
  assert.equal(valid(enabled, '1', '2', 'receipt-source-v1:on'), true);
  assert.equal(valid(enabled, '1', '2', 'receipt-source-v1:off'), false);
  assert.equal(valid(enabled, '1', '3', 'receipt-source-v1:on'), false);
});

test('native CRC statement trace carries the exact four-day purchase date', () => {
  // Native validation CSV row343, SHA256 d13c341774eef8471235e94f660e630c595be4a298fd9f2e27e64e8185783f29.
  // This tests source parsing, not an assertion that a live BankLine/Expense is linked.
  const raw = 'COLUMBIA RESOURCE COMP VANCOUVER     WA C#8516 DBT CRD 1447 08/27/26 12679143';
  assert.equal(bankAuthPurchaseDate(line('crc-native', '2026-08-31', -18125, raw)), '2026-08-27');
  assert.equal(bankAuthPurchaseDate(line('crc-wrong-source', '2026-08-31', -18125, raw, WRONG_SOURCE)), null);
});


test('observed alias: COLUMBIA RESOURCE COMP VANCOUVER WA recognizes exact vendor CRC-WEST VAN', () => {
  assert.equal(observedReceiptMerchantMatches('COLUMBIA RESOURCE COMP VANCOUVER WA', 'CRC-WEST VAN'), true);
});

test('observed alias: normalizes whitespace and case for COLUMBIA RESOURCE COMP VANCOUVER WA', () => {
  assert.equal(observedReceiptMerchantMatches('  columbia   resource comp vancouver wa  ', 'CRC-WEST VAN'), true);
});

test('observed alias: optional leading MISCELLANEOUS DEBIT prefix is removed for COLUMBIA RESOURCE COMP VANCOUVER WA', () => {
  assert.equal(observedReceiptMerchantMatches('MISCELLANEOUS DEBIT COLUMBIA RESOURCE COMP VANCOUVER WA', 'CRC-WEST VAN'), true);
});

test('observed alias: COLUMBIA RESOURCE COMP VANCOUVER WA does not match other CRC vendors', () => {
  assert.equal(observedReceiptMerchantMatches('COLUMBIA RESOURCE COMP VANCOUVER WA', 'CRC-EAST VAN'), false);
  assert.equal(observedReceiptMerchantMatches('COLUMBIA RESOURCE COMP VANCOUVER WA', 'CRC'), false);
  assert.equal(observedReceiptMerchantMatches('COLUMBIA RESOURCE COMP VANCOUVER WA', 'Columbia Resource Company Other'), false);
});

test('observed alias: other bank location COLUMBIA RESOURCE COMP PORTLAND OR does not match CRC-WEST VAN', () => {
  assert.equal(observedReceiptMerchantMatches('COLUMBIA RESOURCE COMP PORTLAND OR', 'CRC-WEST VAN'), false);
});

test('observed alias: appended text on the bank label is not recognized as CRC-WEST VAN', () => {
  assert.equal(observedReceiptMerchantMatches('COLUMBIA RESOURCE COMP VANCOUVER WA OTHER', 'CRC-WEST VAN'), false);
  assert.equal(observedReceiptMerchantMatches('MISCELLANEOUS DEBIT COLUMBIA RESOURCE COMP VANCOUVER WA OTHER', 'CRC-WEST VAN'), false);
});
