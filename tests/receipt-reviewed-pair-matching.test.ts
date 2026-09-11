// tests/receipt-reviewed-pair-matching.test.ts
// Reviewed exact-pair recognition for an EXISTING positive receipted Expense: one pinned
// bank line, one pinned Expense, every source field exact, fed through the ordinary
// one-unit capacity matcher. Entirely synthetic fixtures; no private identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { planReceiptRequests, componentVersionOf, componentVersionsMatch } from '../src/lib/receipt-requests';
import { receiptRecognitionPolicy, reviewedReceiptPairMatches } from '../src/lib/receipt-source-recognition';
import { cycleStillValid, parseSweepCycle } from '../src/lib/receipt-sweep-marker';
import { parseReviewedReceiptPairs, resolveReviewedReceiptPair } from '../src/server/receipt-reviewed-pair-facts';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const NOW = new Date('2026-09-10T12:00:00Z');

// Settlement 06/16, bank authorization 06/14 (descriptor trace), reviewed Expense accounting
// date 06/13 (this fixture's email provenance also states payment on 06/13). Three days
// before posting and one day before authorization: outside the ordinary ±2-day rule AND
// not the exact authorization date, so no existing rule can close it.
const RAW = 'MISCELLANEOUS DEBIT PAYWEB *SYNTHMART 555-0100  NY C#1111 DBT CRD 0900 06/14/25 11111111';
const LINE_ID = 'synthetic-pair-line-0';
const EXPENSE_ID = 'synthetic-pair-expense-0';
const PURCHASE = '2000';

const pair = () => ({
  target: {
    bankLineId: LINE_ID, account: 'WTB-0723', sourceOfRecord: 'STATEMENT', postedDate: '2025-06-16',
    amountCents: -55555, rawDescriptor: RAW, checkNumber: null, bankAuthDate: '2025-06-14',
  },
  expected: {
    id: EXPENSE_ID, qbPurchaseId: PURCHASE, qbSyncToken: '0', status: 'Reviewed',
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
const rawPacket = JSON.stringify({ version: 1, account: 'WTB-0723', pairs: [pair()] });
const config = parseReviewedReceiptPairs(rawPacket, sha(rawPacket));
assert.equal(config.status, 'valid');
const pairFor = (input: unknown) => resolveReviewedReceiptPair(input, config);

const line = () => ({
  id: LINE_ID, account: 'WTB-0723', sourceOfRecord: 'STATEMENT', postedDate: '2025-06-16', amountCents: -55555,
  rawDescriptor: RAW, checkNumber: null as string | null, qbTxnId: null as string | null, probuildExpenseId: null as string | null,
});
const expense = (overrides: Record<string, unknown> = {}) => {
  const expected = { ...pair().expected, ...overrides };
  return {
    id: expected.id, qbPurchaseId: expected.qbPurchaseId, hasReceipt: true, amountCents: expected.amountCents,
    date: expected.date, vendor: expected.vendor, linkedIntakeId: null as string | null,
    reviewedSourceFact: null, reviewedPairFact: pairFor(expected), ...overrides,
  };
};

// A clean global census for the pinned Expense. The census itself is exercised against
// the real loader in tests/reviewed-pair-census.test.ts; here it is the planner input.
const CLEAN_CENSUS = { eligible: [EXPENSE_ID], reservedUnits: [] as string[] };

function run(patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const l = { ...line(), ...patch };
  return planReceiptRequests({
    sourceRecognitionEnabled: true, bankLines: [l], expenses: [expense()], intakes: [], openIssueKeys: [l.id], pairCensus: CLEAN_CENSUS, now: NOW, ...extra,
  } as any);
}

// ── The exact approved pair ──────────────────────────────────────────────────

test('exact reviewed pair closes its named line, and never opens it', () => {
  assert.deepEqual(run().close, [LINE_ID]);
  const fresh = run({}, { openIssueKeys: [] });
  assert.deepEqual(fresh.open, []);
  assert.deepEqual(fresh.close, []);
  assert.deepEqual(fresh.undecided, []);
});

test('the pair edge exists only under a loaded census that clears this exact Expense', () => {
  // No census: unknown, and unknown withholds the edge (ordinary evidence is untouched).
  assert.deepEqual(run({}, { pairCensus: undefined }).close, []);
  assert.deepEqual(run({}, { pairCensus: null }).close, []);
  // A census that cleared some other Expense clears nothing here.
  assert.deepEqual(run({}, { pairCensus: { eligible: ['synthetic-other-expense'], reservedUnits: [] } }).close, []);
  // A disputed pair reserves both aliases: not the pair edge, and not an ordinary twin either.
  const twin = { ...line(), id: 'synthetic-twin', postedDate: '2025-06-15', rawDescriptor: 'SYNTHMART ONLINE C#1111 DBT CRD 0900 06/14/25 22222222' };
  const disputed = { eligible: [] as string[], reservedUnits: [`expense:${EXPENSE_ID}`, `purchase:${PURCHASE}`] };
  const plan = run({}, { bankLines: [line(), twin], openIssueKeys: [LINE_ID, twin.id], pairCensus: disputed });
  assert.deepEqual(plan.close, []);
  assert.equal(plan.open.length, 2);
});

test('without the pair fact no existing rule reaches a payment one day before authorization', () => {
  const plan = run({}, { expenses: [expense({ reviewedPairFact: null })] });
  assert.deepEqual(plan.close, []);
  assert.equal(plan.open.length, 1);
  // Even with the pair fact present, the recognition flag must be on.
  assert.deepEqual(run({}, { sourceRecognitionEnabled: false }).close, []);
  assert.deepEqual(run({}, { sourceRecognitionEnabled: undefined }).close, []);
});

test('with recognition OFF the packet and census are inert: ordinary verdicts are identical with or without them', () => {
  // A receipt that an ORDINARY line satisfies (exact cents, +2 days, lone brand token),
  // while the same Expense is also pinned by a pair packet for a different named line.
  const ordinary = { ...line(), id: 'synthetic-ordinary', postedDate: '2025-06-15', rawDescriptor: 'SYNTHMART ONLINE C#1111 DBT CRD 0900 06/14/25 22222222' };
  const disputed = { eligible: [] as string[], reservedUnits: [`expense:${EXPENSE_ID}`, `purchase:${PURCHASE}`] };
  const eligible = { eligible: [EXPENSE_ID], reservedUnits: [] as string[] };
  const plan = (flag: boolean, e: ReturnType<typeof expense> | Record<string, unknown>, census: unknown) => planReceiptRequests({
    sourceRecognitionEnabled: flag, bankLines: [ordinary], expenses: [e], intakes: [], openIssueKeys: [ordinary.id], pairCensus: census, now: NOW,
  } as any);
  // Baseline: no packet at all (no pair fact, no census), flag off → the ordinary match closes.
  const noPacket = plan(false, expense({ reviewedPairFact: null }), undefined);
  assert.deepEqual(noPacket.close, [ordinary.id]);
  // Flag off with a packet installed, revised (eligible) or revoked (null/undefined census),
  // and even a DISPUTED census: every verdict equals the no-packet verdict.
  for (const census of [disputed, eligible, null, undefined]) {
    for (const e of [expense(), expense({ reviewedPairFact: null })]) {
      const plan0 = plan(false, e, census);
      assert.deepEqual(plan0.close, noPacket.close, JSON.stringify({ census, fact: !!e.reviewedPairFact }));
      assert.deepEqual(plan0.open, noPacket.open);
      assert.deepEqual(plan0.undecided, noPacket.undecided);
    }
  }
  // Flag off never yields the pair edge for the named line either, disputed or clean.
  assert.deepEqual(run({}, { sourceRecognitionEnabled: false, pairCensus: eligible }).close, []);
  assert.deepEqual(run({}, { sourceRecognitionEnabled: false, pairCensus: disputed }).close, []);
  // Flag ON keeps the protections: a disputed pair reserves the unit from the ordinary line too.
  assert.deepEqual(plan(true, expense(), disputed).close, []);
  assert.equal(plan(true, expense(), disputed).open.length, 1);
  assert.deepEqual(plan(true, expense(), eligible).close, [ordinary.id]);
});

test('the pair predicate is exact on every pinned line field', () => {
  const fact = pairFor(pair().expected)!;
  const evidence = { amountCents: 55555, date: '2025-06-13' };
  assert.equal(reviewedReceiptPairMatches(line(), evidence, fact), true);
  const bad: Array<Record<string, unknown>> = [
    { id: 'synthetic-other-line' },
    { account: 'WTB-9999' }, { sourceOfRecord: 'QBO_REGISTER' }, { postedDate: '2025-06-15' }, { postedDate: '2025-06-17' },
    { amountCents: -55554 }, { checkNumber: '42' }, { checkNumber: '' },
    { rawDescriptor: RAW.replace('C#1111', 'C#2222') }, { rawDescriptor: RAW.replace('06/14/25', '06/13/25') }, { rawDescriptor: RAW.replace('06/14/25', '06/15/25') },
    { rawDescriptor: RAW.replace('SYNTHMART', 'OTHERMART') }, { rawDescriptor: RAW.replace('11111111', '99999999') }, { rawDescriptor: RAW.replace('  NY', ' NY') },
    { rawDescriptor: RAW + ' ' }, { rawDescriptor: RAW.toLowerCase() },
    { qbTxnId: '2001' }, { probuildExpenseId: 'synthetic-other-expense' },
    // Link state not loaded by the adapter is not "no link"; it is unknown, and unknown fails closed.
    { qbTxnId: undefined }, { probuildExpenseId: undefined },
  ];
  for (const patch of bad) assert.equal(reviewedReceiptPairMatches({ ...line(), ...patch } as any, evidence, fact), false, JSON.stringify(patch));
  // A later exact link to the SAME purchase or Expense is confirmation, not drift.
  assert.equal(reviewedReceiptPairMatches({ ...line(), qbTxnId: PURCHASE }, evidence, fact), true);
  assert.equal(reviewedReceiptPairMatches({ ...line(), probuildExpenseId: EXPENSE_ID }, evidence, fact), true);
  // Evidence must be the pinned magnitude on the pinned Expense accounting date.
  assert.equal(reviewedReceiptPairMatches(line(), { amountCents: 55554, date: '2025-06-13' }, fact), false);
  assert.equal(reviewedReceiptPairMatches(line(), { amountCents: 55555, date: '2025-06-14' }, fact), false);
  assert.equal(reviewedReceiptPairMatches(line(), { amountCents: 55555, date: null }, fact), false);
  // A tampered digest is no fact.
  assert.equal(reviewedReceiptPairMatches(line(), evidence, { ...fact, sourceFactDigest: 'nope' }), false);
  assert.equal(reviewedReceiptPairMatches(line(), evidence, null), false);
});

test('wrong target, card, source, merchant, amount, date or link state on the line: no edge, chase stays open', () => {
  const patches: Array<Record<string, unknown>> = [
    { id: 'synthetic-other-line' }, { account: 'WTB-9999' }, { sourceOfRecord: 'QBO_REGISTER' }, { postedDate: '2025-06-17' },
    { amountCents: -55554 }, { checkNumber: '42' }, { rawDescriptor: RAW.replace('C#1111', 'C#2222') },
    { rawDescriptor: RAW.replace('06/14/25', '06/15/25') }, { rawDescriptor: RAW.replace('SYNTHMART', 'OTHERMART') },
    { qbTxnId: '2001' }, { probuildExpenseId: 'synthetic-other-expense' }, { qbTxnId: undefined }, { probuildExpenseId: undefined },
  ];
  for (const patch of patches) {
    const plan = run(patch, { openIssueKeys: [(patch.id as string) ?? LINE_ID] });
    assert.deepEqual(plan.close, [], JSON.stringify(patch));
  }
  assert.deepEqual(run({ qbTxnId: PURCHASE }).close, [LINE_ID]);
  assert.deepEqual(run({ probuildExpenseId: EXPENSE_ID }).close, [LINE_ID]);
});

test('Expense drift on any pinned field, including the QBO sync token version, removes the edge', () => {
  const drift: Record<string, unknown> = {
    id: 'synthetic-pair-expense-9', qbPurchaseId: '2009', qbSyncToken: '1', status: 'Pending', description: 'Synthetic remaining balance SYN-ORDER-1 edited',
    receiptUrl: 'https://example.invalid/pair/9.pdf', amountCents: 55554, date: '2025-06-14', vendor: 'OTHERMART',
    sourceFileId: 'synthetic-drive-file-0001', sourceGroupIndex: 0,
  };
  for (const [k, v] of Object.entries(drift)) {
    const e = expense({ [k]: v });
    assert.equal(e.reviewedPairFact, null, k);
    const plan = run({}, { expenses: [e] });
    assert.deepEqual(plan.close, [], k);
  }
  // A withdrawn receipt or a zeroed/retired Expense is not evidence, pair or no pair.
  for (const patch of [{ hasReceipt: false }, { amountCents: 0, reviewedPairFact: pairFor(pair().expected) }, { amountCents: -55555, reviewedPairFact: pairFor(pair().expected) }]) {
    assert.deepEqual(run({}, { expenses: [{ ...expense(), ...patch }] }).close, [], JSON.stringify(patch));
  }
});

test('absent, revoked, drifted or malformed config yields no edge', () => {
  const absent = parseReviewedReceiptPairs(undefined, undefined);
  const malformed = parseReviewedReceiptPairs(rawPacket, 'f'.repeat(64));
  const revised = (() => { const p = pair(); p.expected.qbSyncToken = '1'; const r = JSON.stringify({ version: 1, account: 'WTB-0723', pairs: [p] }); return parseReviewedReceiptPairs(r, sha(r)); })();
  for (const cfg of [absent, malformed, revised]) {
    const fact = resolveReviewedReceiptPair(pair().expected, cfg);
    assert.equal(fact, null);
    assert.deepEqual(run({}, { expenses: [expense({ reviewedPairFact: fact })] }).close, []);
  }
  // The revised packet admits only the revised Expense state.
  assert.notEqual(resolveReviewedReceiptPair({ ...pair().expected, qbSyncToken: '1' }, revised), null);
});

// ── Capacity: one unit, however many aliases ─────────────────────────────────

test('one pair-backed receipt is one unit across a duplicate charge and its booked intake', () => {
  const twin = { ...line(), id: 'synthetic-twin', postedDate: '2025-06-15', rawDescriptor: 'SYNTHMART ONLINE C#1111 DBT CRD 0900 06/14/25 22222222' };
  const intake = { id: 'intake-0', expenseId: EXPENSE_ID, qbPurchaseId: PURCHASE, state: 'BOOKED', stateReason: null, txnDate: '2025-06-13', totalCents: 55555, vendor: 'SYNTHMART' };
  const plan = run({}, { bankLines: [line(), twin], intakes: [intake], openIssueKeys: [LINE_ID, twin.id], expenses: [expense({ linkedIntakeId: 'intake-0' })] });
  assert.equal(plan.close.length, 1);
  assert.equal(plan.open.length, 1);
  // Alone, the same intake folds into the same unit and the named line still closes once.
  assert.deepEqual(run({}, { intakes: [intake], expenses: [expense({ linkedIntakeId: 'intake-0' })] }).close, [LINE_ID]);
});

test('a conflicting, dead, unverified or unloaded linked intake refuses the pair edge without adding capacity', () => {
  const base = { id: 'intake-0', expenseId: EXPENSE_ID, qbPurchaseId: PURCHASE, state: 'BOOKED', stateReason: null, txnDate: '2025-06-13', totalCents: 55555, vendor: 'SYNTHMART' };
  const refusals = [
    { ...base, qbPurchaseId: '2001' }, { ...base, qbPurchaseId: null }, { ...base, state: 'DUPLICATE' },
    { ...base, stateReason: 'receipt-bytes-missing' }, { ...base, stateReason: 'content-changed' },
  ];
  for (const intake of refusals) {
    const plan = run({}, { intakes: [intake], expenses: [expense({ linkedIntakeId: 'intake-0' })] });
    assert.deepEqual(plan.close, [], JSON.stringify(intake));
  }
  // The global one-to-one link names an intake this component never loaded: not proof, no edge.
  assert.deepEqual(run({}, { expenses: [expense({ linkedIntakeId: 'not-loaded' })] }).close, []);
});

test('a competing existing binding or reservation on the unit removes the pair edge', () => {
  assert.deepEqual(run({}, { boundLineage: { bound: [], reservedUnits: [`purchase:${PURCHASE}`] } }).close, []);
  assert.deepEqual(run({}, { boundLineage: { bound: [], reservedUnits: [`expense:${EXPENSE_ID}`] } }).close, []);
  const elsewhere = { unit: `purchase:${PURCHASE}`, bankLineId: 'synthetic-elsewhere', amountCents: 55555, expenseId: EXPENSE_ID, qbPurchaseId: PURCHASE, observationId: 'obs' };
  assert.deepEqual(run({}, { boundLineage: { bound: [elsewhere], reservedUnits: [] } }).close, []);
  // A binding to the named line itself is the same one unit, not two.
  const own = { ...elsewhere, bankLineId: LINE_ID };
  assert.deepEqual(run({}, { boundLineage: { bound: [own], reservedUnits: [] } }).close, [LINE_ID]);
});

test('closed competitors stay in the matching: an ordinary earlier claimant keeps the unit', () => {
  // The twin matches the same Expense by the ORDINARY rule (exact cents, +2 days, lone brand token).
  const twin = { ...line(), id: 'synthetic-twin', postedDate: '2025-06-15', rawDescriptor: 'SYNTHMART ONLINE C#1111 DBT CRD 0900 06/14/25 22222222' };
  // Twin's issue is closed (not open) but not resolved: it still competes for the one unit.
  const contested = run({}, { bankLines: [line(), twin], openIssueKeys: [LINE_ID] });
  assert.deepEqual(contested.close, []);
  assert.deepEqual(contested.open.map(o => o.targetKey), [LINE_ID]);
  // Once the twin is RESOLVED (a signed memo), it leaves the matching and the pair closes.
  const resolved = run({}, { bankLines: [line(), twin], openIssueKeys: [LINE_ID], resolvedIssueKeys: [twin.id] });
  assert.deepEqual(resolved.close, [LINE_ID]);
  // A second, distinct receipt for the twin lets both close.
  const other = { id: 'synthetic-other', qbPurchaseId: '2999', hasReceipt: true, amountCents: 55555, date: '2025-06-15', vendor: 'SYNTHMART', reviewedPairFact: null };
  const both = run({}, { bankLines: [line(), twin], openIssueKeys: [LINE_ID, twin.id], expenses: [expense(), other] });
  assert.deepEqual([...both.close].sort(), [LINE_ID, twin.id].sort());
  // The pair never lends the unit to a line it does not name, even when that line is alone.
  assert.deepEqual(run({}, { bankLines: [{ ...twin, postedDate: '2025-06-17' }], openIssueKeys: [twin.id] }).close, []);
});

test('incomplete evidence coverage of the reviewed Expense accounting date is not a verdict', () => {
  const plan = run({}, { evidenceLoadedFrom: '2025-06-14', evidenceLoadedTo: '2025-06-20' });
  assert.deepEqual(plan.close, []); assert.deepEqual(plan.open, []); assert.deepEqual(plan.undecided, [LINE_ID]);
  assert.deepEqual(run({}, { evidenceLoadedFrom: '2025-06-13', evidenceLoadedTo: '2025-06-18' }).close, [LINE_ID]);
});

// ── OCC: every field the pair reads is fenced ────────────────────────────────

test('bank-line fields the pair pins invalidate the component version without a timestamp hint', () => {
  const at = new Date('2026-09-02T09:00:00Z');
  const source = { id: LINE_ID, updatedAt: at, rawDescriptor: RAW, account: 'WTB-0723', sourceOfRecord: 'STATEMENT', postedDate: new Date('2025-06-16T00:00:00Z'), amountCents: -55555, checkNumber: null as string | null, qbTxnId: null as string | null, probuildExpenseId: null as string | null };
  const stamp = (l: typeof source) => componentVersionOf({ issues: [], intakes: [], lines: [l] });
  assert.equal(componentVersionsMatch(stamp(source), stamp({ ...source })), true);
  for (const patch of [{ postedDate: new Date('2025-06-17T00:00:00Z') }, { amountCents: -55554 }, { checkNumber: '42' }, { qbTxnId: PURCHASE }, { probuildExpenseId: EXPENSE_ID }]) {
    assert.equal(componentVersionsMatch(stamp(source), stamp({ ...source, ...patch })), false, JSON.stringify(patch));
  }
  // Older fixtures that never supplied these fields still agree with themselves.
  const legacy = { id: LINE_ID, updatedAt: at, rawDescriptor: RAW };
  assert.equal(componentVersionsMatch(componentVersionOf({ issues: [], intakes: [], lines: [legacy] }), componentVersionOf({ issues: [], intakes: [], lines: [legacy] })), true);
});

test('Expense fields the pair pins invalidate the component version', () => {
  const row = { ...pair().expected, hasReceipt: true, linkedIntakeId: null };
  const v = (e: typeof row) => componentVersionOf({ issues: [], intakes: [], expenses: [e] });
  for (const key of ['receiptUrl', 'qbSyncToken', 'status', 'description', 'vendor', 'qbPurchaseId', 'id'] as const) {
    assert.equal(componentVersionsMatch(v(row), v({ ...row, [key]: row[key] + '-moved' })), false, key);
  }
  assert.equal(componentVersionsMatch(v(row), v({ ...row, amountCents: 55554 })), false);
  assert.equal(componentVersionsMatch(v(row), v({ ...row, date: '2025-06-14' })), false);
  assert.equal(componentVersionsMatch(v(row), v({ ...row, hasReceipt: false })), false);
});

// ── Route wiring: every planning and transactional re-read path ──────────────

const route = () => readFileSync(new URL('../src/app/api/cron/receipt-requests/route.ts', import.meta.url), 'utf8');

test('both production evidence adapters attach the pair fact beside the gas fact, from the server module only', () => {
  const src = route();
  assert.match(src, /@\/server\/receipt-reviewed-pair-facts/);
  const resolver = /reviewedPairFact: reviewedReceiptPairForExpense\(\{ \.\.\.row, amountCents: cents, date: reviewedDate \}\)/g;
  // Three resolutions, all through the same server adapter with the same cents and
  // company-local day — one in each scope, named rather than merely counted:
  const scope = (from: RegExp, to: RegExp, label: string) => {
    const start = src.search(from);
    assert.ok(start >= 0, `${label}: start marker`);
    const rest = src.slice(start);
    const end = rest.search(to);
    assert.ok(end > 0, `${label}: end marker`);
    return rest.slice(0, end);
  };
  // 1. The recompute planner (card cron / on-demand truth), up to the next helper.
  const recompute = scope(/export async function recomputeCodesFor\(/, /\nasync function componentIssueRows\(/, 'recompute');
  // 2. The batch planner in processBatch, up to the point the component transactions begin.
  const batch = scope(/async function processBatch\(/, /await runBudgetedComponent\(budget/, 'batch planning');
  // 3. The locked in-transaction re-read, from the evidence lock to the fingerprint comparison.
  const locked = scope(/await lockReceiptEvidence\(tx\);/, /if \(!componentVersionsMatch\(planned, current\)\) throw new ComponentMovedError\(\);/, 'locked re-read');
  assert.equal((recompute.match(resolver) ?? []).length, 1, 'recompute resolves the pair fact once');
  assert.equal((batch.match(resolver) ?? []).length, 1, 'batch planning resolves the pair fact once (the locked scope lies past its end marker)');
  assert.equal((locked.match(resolver) ?? []).length, 1, 'the locked re-read resolves it again from the locked rows to key the census');
  assert.match(locked, /await loadReviewedPairCensus\(tx, reviewedPairCensusKeys\(currentExpenses\.flatMap\(/);
  assert.equal((src.match(resolver) ?? []).length, 3, 'and nowhere else');
  assert.equal((recompute.match(/reviewedSourceFact: reviewedReceiptFactForExpense/g) ?? []).length, 1);
  assert.equal((batch.match(/reviewedSourceFact: reviewedReceiptFactForExpense/g) ?? []).length, 1);
  assert.equal((src.match(/reviewedSourceFact: reviewedReceiptFactForExpense/g) ?? []).length, 2);
  const shared = readFileSync(new URL('../src/lib/receipt-requests.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(shared, /server\/receipt-reviewed-pair-facts/);
  assert.doesNotMatch(readFileSync(new URL('../src/lib/receipt-source-recognition.ts', import.meta.url), 'utf8'), /server\/receipt-reviewed/);
});

test('every bank-line read that feeds a plan loads the link state the pair predicate requires', () => {
  const src = route();
  const selects = src.match(/select: \{ id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true[^}]*\}/g) ?? [];
  assert.ok(selects.length >= 5, `expected the batch/cohort/recompute/open-issue selects, found ${selects.length}`);
  for (const select of selects) {
    assert.ok(select.includes('qbTxnId: true') && select.includes('probuildExpenseId: true'), `a BankLine select without link state:\n  ${select}`);
  }
  // The bulk adapter carries them into the planner; recompute passes the selected rows through.
  assert.match(src, /bankLines: lines\.map\(row => \(\{[\s\S]*?qbTxnId: row\.qbTxnId,\s*probuildExpenseId: row\.probuildExpenseId,[\s\S]*?\}\)\),/);
});

test('the bulk adapter reproduces the pair close from the selected columns alone', () => {
  const src = route();
  const expression = src.match(/bankLines: (lines\.map\(row => \(\{[\s\S]*?\}\)\)),/);
  assert.ok(expression);
  const adapt = new Function('lines', `return ${expression[1]};`) as (lines: unknown[]) => any[];
  const mapped = adapt([{ ...line(), postedDate: new Date('2025-06-16T00:00:00Z'), updatedAt: new Date() }]);
  assert.equal(mapped[0].qbTxnId, null);
  assert.equal(mapped[0].probuildExpenseId, null);
  assert.deepEqual(planReceiptRequests({ sourceRecognitionEnabled: true, bankLines: mapped, expenses: [expense()], intakes: [], openIssueKeys: [LINE_ID], pairCensus: CLEAN_CENSUS, now: NOW } as any).close, [LINE_ID]);
  // Rows without link state (a select that forgot the columns) cannot close through the pair.
  const bare = adapt([{ ...line(), qbTxnId: undefined, probuildExpenseId: undefined, postedDate: new Date('2025-06-16T00:00:00Z'), updatedAt: new Date() }]);
  assert.deepEqual(planReceiptRequests({ sourceRecognitionEnabled: true, bankLines: bare, expenses: [expense()], intakes: [], openIssueKeys: [LINE_ID], pairCensus: CLEAN_CENSUS, now: NOW } as any).close, []);
});

test('the planned stamp and the locked re-read fingerprint the same pinned bank-line fields', () => {
  const src = route();
  // Planned, from rows in hand.
  assert.match(src, /lines: componentLines\.map\(row => \(\{[\s\S]{0,800}?postedDate: row\.postedDate,[\s\S]{0,200}?amountCents: row\.amountCents,[\s\S]{0,200}?checkNumber: row\.checkNumber,[\s\S]{0,200}?qbTxnId: row\.qbTxnId,[\s\S]{0,200}?probuildExpenseId: row\.probuildExpenseId,\s*\}\)\),/);
  // Locked re-read, inside the transaction, selects every hashed field.
  const reread = src.match(/lines: await tx\.bankLine\.findMany\(\{[\s\S]*?select: \{([^}]*)\}/);
  assert.ok(reread, 'locked bank-line re-read');
  for (const field of ['id', 'updatedAt', 'rawDescriptor', 'account', 'sourceOfRecord', 'postedDate', 'amountCents', 'checkNumber', 'qbTxnId', 'probuildExpenseId']) {
    assert.ok(reread[1].includes(`${field}: true`), `re-read select lacks ${field}`);
  }
});

// ── Policy: config presence, drift and revocation all change the certificate ──

test('recognition policy carries both packet fingerprints, so any pair config change forces a fresh cycle', () => {
  assert.equal(receiptRecognitionPolicy(false, 'absent', 'absent'), 'receipt-source-v1:off');
  assert.equal(receiptRecognitionPolicy(false, config.fingerprint, config.fingerprint), 'receipt-source-v1:off');
  const base = receiptRecognitionPolicy(true, 'absent', 'absent');
  assert.equal(base, 'receipt-source-v3:on:absent:pair:absent');
  const withPair = receiptRecognitionPolicy(true, 'absent', config.fingerprint);
  assert.notEqual(withPair, base);
  assert.notEqual(withPair, receiptRecognitionPolicy(true, 'absent', 'invalid'));
  assert.notEqual(withPair, receiptRecognitionPolicy(true, 'absent', 'b'.repeat(64)));
  assert.notEqual(withPair, receiptRecognitionPolicy(true, config.fingerprint, config.fingerprint));
  // The gas-only certificate format is retired: a cycle certified under it cannot authorize sending now.
  const old = parseSweepCycle(JSON.stringify({ id: 'c', epoch: '1', evidenceEpoch: '2', recognitionPolicy: 'receipt-source-v2:on:absent' }));
  assert.equal(cycleStillValid(old, '1', '2', base), false);
  const current = parseSweepCycle(JSON.stringify({ id: 'c', epoch: '1', evidenceEpoch: '2', recognitionPolicy: withPair }));
  assert.equal(cycleStillValid(current, '1', '2', withPair), true);
  assert.equal(cycleStillValid(current, '1', '2', base), false);
  assert.equal(cycleStillValid(current, '1', '2', receiptRecognitionPolicy(true, 'absent', 'invalid')), false);
});

test('every policy call site passes the pair fingerprint from the server module', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const sweep = route();
  const cards = read('../src/app/api/cron/receipt-request-cards/route.ts');
  const store = read('../src/lib/receipt-on-demand-store.ts');
  const diagnostic = read('../src/app/api/integrations/bank-ledger/receipt-component-diagnostic/route.ts');
  assert.match(sweep, /receiptRecognitionPolicy\(SOURCE_RECOGNITION_ENABLED, reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint\)/);
  assert.match(cards, /receiptRecognitionPolicy\(process\.env\.RECEIPT_SOURCE_RECOGNITION_ENABLED === "true", reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint\)/);
  assert.match(store, /receiptRecognitionPolicy\(env\.RECEIPT_SOURCE_RECOGNITION_ENABLED === 'true', reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint\)/);
  assert.match(diagnostic, /receiptRecognitionPolicy\(recognitionEnabled, reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint\)/);
  for (const src of [sweep, cards, store, diagnostic]) assert.match(src, /reviewedReceiptPairsFingerprint \} from ['"]@\/server\/receipt-reviewed-pair-facts['"]/);
});
