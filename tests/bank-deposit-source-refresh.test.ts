import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPOSIT_REFRESH_POLICY, createDepositSourceRefreshHandler, createQboSourceReaders, digestOf, planDepositRefresh,
  type DepositRefreshDeps,
} from '../src/lib/bank-deposit-source-refresh';

import { parseRefreshBody } from '../src/lib/bank-source-refresh';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SOURCE = {
  Deposit: {
    Id: '6531', TxnDate: '2026-08-11', SyncToken: '0',
    MetaData: { CreateTime: '2026-08-11T16:56:29-07:00', LastUpdatedTime: '2026-08-11T16:56:29-07:00' },
    CurrencyRef: { value: 'USD', name: 'United States Dollar' }, TotalAmt: 5657.6,
    DepositToAccountRef: { value: '154', name: 'Washington Trust Bank' },
    PrivateNote: 'System-recorded deposit for QuickBooks Payments',
    Line: [{ Description: 'Paid via QuickBooks Payments: Payment ID 10a-82w', Amount: 5657.6,
      LinkedTxn: [{ TxnId: '6517', TxnType: 'Payment', TxnLineId: '0' }], DepositLineDetail: { PaymentMethodRef: { value: '11' } } }],
    TxnTaxDetail: {},
  },
  Payment: {
    Id: '6517', TxnDate: '2026-08-11', SyncToken: '0',
    MetaData: { CreateTime: '2026-08-11T11:16:54-07:00', LastUpdatedTime: '2026-08-11T11:16:54-07:00' },
    CurrencyRef: { value: 'USD', name: 'United States Dollar' }, TotalAmt: 5657.6, UnappliedAmt: 0,
    CustomerRef: { value: '553', name: 'Sally and Timothy Muller' }, DepositToAccountRef: { value: '61' }, PaymentMethodRef: { value: '11' },
    LinkedTxn: [{ TxnId: '6531', TxnType: 'Deposit' }],
    Line: [{ Amount: 5657.6, LinkedTxn: [{ TxnId: '6515', TxnType: 'Invoice' }],
      LineEx: { any: [
        { name: '{http://schema.intuit.com/finance/v3}NameValue', declaredType: 'com.intuit.schema.finance.v3.NameValue', scope: 'javax.xml.bind.JAXBElement$GlobalScope', value: { Name: 'txnId', Value: '6515' }, nil: false, globalScope: true, typeSubstituted: false },
        { name: '{http://schema.intuit.com/finance/v3}NameValue', declaredType: 'com.intuit.schema.finance.v3.NameValue', scope: 'javax.xml.bind.JAXBElement$GlobalScope', value: { Name: 'txnOpenBalance', Value: '5657.60' }, nil: false, globalScope: true, typeSubstituted: false },
        { name: '{http://schema.intuit.com/finance/v3}NameValue', declaredType: 'com.intuit.schema.finance.v3.NameValue', scope: 'javax.xml.bind.JAXBElement$GlobalScope', value: { Name: 'txnReferenceNumber', Value: 'INV-00168-5' }, nil: false, globalScope: true, typeSubstituted: false },
      ] } }],
  },
};
const clone = <T>(v: T): T => structuredClone(v);
const GL = { date: '2026-08-11', qbType: 'Deposit', qbTxnId: '6531', docNum: '', name: 'Sally and Timothy Muller',
  memo: 'System-recorded deposit for QuickBooks Payments', amountCents: 565760, clearedStatus: 'Cleared' };
const register = (): any => ({ rows: [clone(GL)], accountId: '154', fetchedAt: '2026-09-10T00:00:00Z', startDate: '2026-06-01', endDate: '2026-09-10', stale: false, clearedProbeOk: true });
const OBS = { id: 'obs-1', postedDate: '2026-08-11', rawDescriptor: 'Sally  and Timothy Muller   Deposit', amountCents: 565760,
  checkNumber: null, createdAt: '2026-08-12T00:00:00Z', clearedStatus: 'Cleared', bankLineId: null };
const CANONICAL = 'Sally and Timothy Muller | System-recorded deposit for QuickBooks Payments';
const toIngestLine = (row: any) => ({ postedDate: row.date, rawDescriptor: `${row.name} | ${row.memo}`, amountCents: row.amountCents });
const evidence = (): any => ({ observations: [clone(OBS)], bankLines: [], expenses: [], intakes: [] });
type Fix = { dep: any; pay: any; reg: any; ev: any };
const fixture = (): Fix => ({ dep: clone(SOURCE.Deposit), pay: clone(SOURCE.Payment), reg: register(), ev: evidence() });
const planWith = (m: (f: Fix) => void = () => {}) => {
  const f = fixture(); m(f);
  return planDepositRefresh({ qbTxnId: '6531', register: f.reg, depositRaw: f.dep, paymentRaw: f.pay, evidence: f.ev, toIngestLine });
};

function harness(opts: { mutate?: (f: Fix) => void; casResult?: number; authorized?: boolean; now?: () => number; beforeTx?: () => void } = {}) {
  const f = fixture(); opts.mutate?.(f);
  const c = { readBody: 0, register: 0, deposit: 0, payment: 0, evidence: 0, txEvidence: 0, apply: 0, bump: 0, update: 0, audit: 0 };
  const audits: Record<string, unknown>[] = [];
  const auditIds: string[] = [];
  const deps: DepositRefreshDeps = {
    authorize: async () => opts.authorized ?? true,
    readBody: async (req) => { c.readBody++; return { ok: true, text: await req.text() }; },
    parseBody: parseRefreshBody,
    toIngestLine,
    readRegister: async () => { c.register++; return f.reg; },
    fetchDeposit: async () => { c.deposit++; return clone(f.dep); },
    fetchPayment: async () => { c.payment++; return clone(f.pay); },
    readEvidence: async () => { c.evidence++; return clone(f.ev); },
    apply: async (_id, body) => { c.apply++; opts.beforeTx?.(); return body({
      readEvidence: async () => { c.txEvidence++; return clone(f.ev); },
      bumpEpoch: async () => { c.bump++; },
      updateObservation: async (_old, next) => { c.update++; if (opts.casResult !== undefined) return opts.casResult; Object.assign(f.ev.observations[0], next); return 1; },
      appendAudit: async (_id, snap) => { c.audit++; auditIds.push(_id); audits.push(snap); },
    }); },
    now: opts.now,
  };
  const handler = createDepositSourceRefreshHandler(deps);
  const call = async (body: unknown) => {
    const res = await handler(new Request('http://test/refresh', { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  return { f, c, audits, auditIds, call };
}
const dryrun = { mode: 'dry-run', items: [{ qbTxnId: '6531' }] };
const applyBody = (expectedDigest: string) => ({ mode: 'apply', items: [{ qbTxnId: '6531', expectedDigest }] });

test('fixture: dryrun plans descriptor-only change with safe projections', async () => {
  const h = harness();
  const r = await h.call(dryrun);
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'planned');
  assert.equal(r.body.plan.version, DEPOSIT_REFRESH_POLICY);
  assert.deepEqual(r.body.plan.next, { postedDate: '2026-08-11', rawDescriptor: CANONICAL });
  assert.equal(r.body.plan.old.rawDescriptor, OBS.rawDescriptor);
  assert.equal(r.body.plan.payment.depositToAccountId, '61');
  assert.equal(r.body.plan.deposit.line.linkedTxnId, '6517');
  assert.equal(r.body.plan.payment.line.invoiceId, '6515');
  const text = JSON.stringify(r.body.plan);
  for (const leak of ['LineEx', 'txnReferenceNumber', 'Washington Trust Bank', 'CreditCardResponse', '10a-82w']) assert.ok(!text.includes(leak), leak);
  assert.deepEqual([h.c.register, h.c.deposit, h.c.payment, h.c.evidence, h.c.apply], [1, 1, 1, 1, 0]);
});

test('fixture: apply updates only the descriptor, bumps epoch, writes audit', async () => {
  const h = harness();
  const dry = await h.call(dryrun);
  const r = await h.call(applyBody(dry.body.digest));
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'applied');
  assert.equal(h.f.ev.observations[0].rawDescriptor, CANONICAL);
  assert.equal(h.f.ev.observations[0].postedDate, '2026-08-11');
  assert.equal(h.f.ev.observations[0].amountCents, 565760);
  assert.deepEqual([h.c.apply, h.c.txEvidence, h.c.bump, h.c.update, h.c.audit], [1, 1, 1, 1, 1]);
  const a = h.audits[0] as any;
  assert.equal(a.action, 'QBO_SOURCE_REFRESH');
  assert.equal(a.sourceEntityType, 'Deposit');
  assert.equal(a.policyVersion, DEPOSIT_REFRESH_POLICY);
  assert.equal(a.digest, dry.body.digest);
  assert.deepEqual(h.auditIds, ['obs-1']);
  assert.equal(a.registerCapturedAt, h.f.reg.fetchedAt);
  assert.deepEqual(a.warnings, ['HISTORICAL_FIELD_HISTORY_MISSING']);
  assert.ok(a.fetchedAt && a.deposit && a.payment && a.gl && a.local && a.old && a.next);
  assert.ok(!('purchase' in a) && !('vendor' in a));
});

test('noop: canonical descriptor already present writes nothing', async () => {
  const h = harness({ mutate: (f) => { f.ev.observations[0].rawDescriptor = CANONICAL; } });
  const dry = await h.call(dryrun);
  assert.equal(dry.body.result, 'noop');
  const r = await h.call(applyBody(dry.body.digest));
  assert.equal(r.body.result, 'noop');
  assert.deepEqual([h.c.bump, h.c.update, h.c.audit], [0, 0, 0]);
});

test('drift: source change between dryrun and apply blocks without writes', async () => {
  const h = harness();
  const dry = await h.call(dryrun);
  h.f.dep.MetaData.LastUpdatedTime = '2026-08-12T00:00:00-07:00';
  const r = await h.call(applyBody(dry.body.digest));
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'digest_mismatch');
  assert.deepEqual([h.c.bump, h.c.update, h.c.audit], [0, 0, 0]);
});

test('digest covers policy version', () => {
  const p = planWith();
  assert.ok(p.ok);
  if (!p.ok) return;
  const { digest, ...body } = p.value;
  assert.equal(digestOf(body), digest);
  assert.notEqual(digestOf({ ...body, version: 'qbo-linked-deposit-descriptor/2' }), digest);
});

const blockedCases: [string, (f: Fix) => void, string][] = [
  ['local amount change', (f) => { f.ev.observations[0].amountCents = 565761; }, 'amount_mismatch'],
  ['local date change', (f) => { f.ev.observations[0].postedDate = '2026-08-12'; }, 'local_date_mismatch'],
  ['local check number', (f) => { f.ev.observations[0].checkNumber = '1001'; }, 'local_check_unsupported'],
  ['wrong account', (f) => { f.reg.accountId = '999'; }, 'deposit_account_mismatch'],
  ['wrong currency', (f) => { f.dep.CurrencyRef.value = 'CAD'; }, 'deposit_currency_unsupported'],
  ['wrong entity type', (f) => { f.reg.rows[0].qbType = 'Payment'; }, 'gl_row_not_deposit'],
  ['wrong party', (f) => { f.pay.CustomerRef.name = 'Someone Else'; }, 'party_mismatch'],
  ['total mismatch', (f) => { f.dep.TotalAmt = 5657.61; }, 'amount_mismatch'],
  ['multiline deposit', (f) => { f.dep.Line.push(clone(f.dep.Line[0])); }, 'deposit_line_count_unsupported'],
  ['partially applied payment', (f) => { f.pay.UnappliedAmt = 10; }, 'payment_unapplied'],
  ['wrong link type', (f) => { f.dep.Line[0].LinkedTxn[0].TxnType = 'Invoice'; }, 'deposit_line_link_unsupported'],
  ['broken backlink', (f) => { f.pay.LinkedTxn[0].TxnId = '1'; }, 'payment_backlink_mismatch'],
  ['non-invoice application', (f) => { f.pay.Line[0].LinkedTxn[0].TxnType = 'CreditMemo'; }, 'payment_line_link_unsupported'],
  ['payment after deposit', (f) => { f.pay.TxnDate = '2026-08-12'; }, 'payment_date_after_deposit'],
  ['payment method mismatch', (f) => { f.pay.PaymentMethodRef.value = '12'; }, 'payment_method_mismatch'],
  ['cashback', (f) => { f.dep.CashBack = { Amount: 1 }; }, 'deposit_cashback_unsupported'],
  ['exchange rate', (f) => { f.dep.ExchangeRate = 1.2; }, 'deposit_exchange_rate_unsupported'],
  ['metadata out of order', (f) => { f.pay.MetaData.LastUpdatedTime = '2026-08-01T00:00:00-07:00'; }, 'payment_metadata_invalid'],
  ['memo mismatch', (f) => { f.reg.rows[0].memo = 'Other'; }, 'memo_mismatch'],
  ['old descriptor unsupported', (f) => { f.ev.observations[0].rawDescriptor = 'Muller deposit approx'; }, 'old_descriptor_unsupported'],
  ['missing local evidence', (f) => { f.ev.observations = []; }, 'local_observation_missing'],
  ['duplicate local evidence', (f) => { f.ev.observations.push(clone(OBS)); }, 'local_observation_ambiguous'],
  ['linked local evidence', (f) => { f.ev.observations[0].bankLineId = 'bl-1'; }, 'local_observation_linked'],
  ['existing bank line', (f) => { f.ev.bankLines = [{ id: 'bl-1' }]; }, 'local_evidence_conflict'],
  ['existing expense', (f) => { f.ev.expenses = [{ id: 'e-1' }]; }, 'local_evidence_conflict'],
  ['missing gl row', (f) => { f.reg.rows = []; }, 'gl_row_missing'],
  ['stale register', (f) => { f.reg.stale = true; }, 'register_stale'],
  ['clearance failed', (f) => { f.reg.clearedProbeOk = false; }, 'register_clearance_failed'],
  ['gl overflow', (f) => { f.reg.rows = Array.from({ length: 2001 }, () => clone(GL)); }, 'register_overflow'],
  ['malformed raw', (f) => { f.dep.Line[0].Amount = '5657.6'; }, 'deposit_line_link_unsupported'],
];
for (const [name, mutate, reason] of blockedCases) {
  test(`blocks ${name}`, () => {
    const r = planWith(mutate);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, reason);
  });
}

test('apply requires matching expectedDigest and rejects before transaction', async () => {
  const h = harness();
  const missing = await h.call({ mode: 'apply', items: [{ qbTxnId: '6531' }] });
  assert.equal(missing.status, 400);
  const wrong = await h.call(applyBody('0'.repeat(64)));
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.reason, 'digest_mismatch');
  assert.equal(h.c.apply, 0);
});

test('CAS conflict throws rollback error, no audit', async () => {
  const h = harness({ casResult: 0 });
  const dry = await h.call(dryrun);
  const r = await h.call(applyBody(dry.body.digest));
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'cas_conflict');
  assert.deepEqual([h.c.update, h.c.audit], [1, 0]);
});

test('single item and numeric id enforced', async () => {
  const h = harness();
  assert.equal((await h.call({ mode: 'dry-run', items: [] })).body.reason, 'invalid-items');
  assert.equal((await h.call({ mode: 'dry-run', items: [{ qbTxnId: '6531' }, { qbTxnId: '6532' }] })).body.reason, 'single_item_required');
  assert.equal((await h.call({ mode: 'dry-run', items: [{ qbTxnId: 'abc' }] })).body.reason, 'invalid-qb-txn-id');
  assert.equal(h.c.register, 0);
});

test('unauthorized: no body read, no IO, no queries', async () => {
  const h = harness({ authorized: false });
  const r = await h.call(dryrun);
  assert.equal(r.status, 401);
  assert.deepEqual(Object.values(h.c), Object.values(h.c).map(() => 0));
});

test('source readers use GET, typed hardcoded paths, numeric ids, 10s deadline', async () => {
  const calls: any[] = [];
  const deadlines: number[] = [];
  const readers = createQboSourceReaders({
    qbFetch: async (path, tokens, init) => { calls.push({ path, tokens, init });
      return new Response(JSON.stringify(path.startsWith('/deposit') ? { Deposit: SOURCE.Deposit } : { Payment: SOURCE.Payment }), { status: 200 }); },
    getTokens: async () => ({ t: 1 }),
    createDeadline: (ms) => { deadlines.push(ms); return { ms }; },
  });
  const dep = (await readers.fetchDeposit('6531')) as any;
  const pay = (await readers.fetchPayment('6517')) as any;
  assert.equal(dep.Id, '6531');
  assert.equal(pay.Id, '6517');
  assert.deepEqual(calls.map((c) => [c.path, c.init.method]), [['/deposit/6531', 'GET'], ['/payment/6517', 'GET']]);
  assert.deepEqual(deadlines, [10000, 10000]);
  await assert.rejects(readers.fetchDeposit('6531; drop'), /invalid_id/);
  assert.equal(calls.length, 2);
});

test('budget guard blocks before IO', async () => {
  let t = 0;
  const h = harness({ now: () => { const v = t; t += 91_000; return v; } });
  const r = await h.call(dryrun);
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'budget_exceeded');
  assert.equal(h.c.register, 0);
});

test('caught failures return static reason', async () => {
  const h = harness();
  (h as any).f.reg = null;
  const r = await h.call(dryrun);
  assert.equal(r.status, 500);
  assert.equal(r.body.reason, 'internal_failure');
});

const edgeCases: [string, (f: Fix) => void][] = [
  ['missing unapplied amount', f => { delete f.pay.UnappliedAmt; }],
  ['zero deposit', f => { f.dep.TotalAmt = 0; }],
  ['negative deposit', f => { f.dep.TotalAmt = -5657.6; }],
  ['unsafe cents', f => { f.dep.TotalAmt = Number.MAX_SAFE_INTEGER; }],
  ['impossible calendar date', f => { f.dep.TxnDate = '2026-02-31'; }],
  ['null GL party', f => { f.reg.rows[0].name = null; }],
  ['null GL memo', f => { f.reg.rows[0].memo = null; }],
  ['GL check', f => { f.reg.rows[0].docNum = '123'; }],
  ['missing payment method', f => { delete f.pay.PaymentMethodRef; }],
  ['different linked line', f => { f.dep.Line[0].LinkedTxn[0].TxnLineId = '1'; }],
  ['tax evidence', f => { f.dep.TxnTaxDetail = { TotalTax: 1 }; }],
  ['receipt intake', f => { f.ev.intakes = [{ id: 'intake' }]; }],
];
for (const [name, mutate] of edgeCases) test(`fails closed: ${name}`, () => assert.equal(planWith(mutate).ok, false));
test('policy supports independently proved IDs, not fixture magic IDs', () => {
  const f = fixture(); f.dep.Id = '999'; f.reg.rows[0].qbTxnId = '999';
  f.dep.Line[0].LinkedTxn[0].TxnId = '888'; f.pay.Id = '888'; f.pay.LinkedTxn[0].TxnId = '999';
  const r = planDepositRefresh({ qbTxnId: '999', register: f.reg, depositRaw: f.dep, paymentRaw: f.pay, evidence: f.ev, toIngestLine });
  assert.equal(r.ok, true);
});
test('unconvertible source cannot plan', () => {
  const f = fixture();
  assert.equal(planDepositRefresh({ qbTxnId: '6531', register: f.reg, depositRaw: f.dep, paymentRaw: f.pay, evidence: f.ev, toIngestLine: () => null }).ok, false);
});
test('stale source stops before direct source calls', async () => {
  const h = harness({ mutate: f => { f.reg.stale = true; } });
  assert.equal((await h.call(dryrun)).body.result, 'blocked');
  assert.equal(h.c.deposit + h.c.payment, 0);
});
test('strict canonical parser refuses mode typo and extra mutation fields', async () => {
  const h = harness();
  assert.equal((await h.call({ ...dryrun, mode: 'dryrun' })).status, 400);
  assert.equal((await h.call({ ...dryrun, force: true })).status, 400);
  assert.equal(h.c.register, 0);
});
test('tokens and GET share the same deadline', async () => {
  const deadline = { marker: true }; let tokenDeadline: unknown;
  const readers = createQboSourceReaders({ createDeadline: () => deadline,
    getTokens: async d => { tokenDeadline = d; return {}; },
    qbFetch: async (_p, _t, init) => { assert.equal(init.qbDeadline, tokenDeadline); return Response.json({ Deposit: SOURCE.Deposit }); },
  });
  await readers.fetchDeposit('6531'); assert.equal(tokenDeadline, deadline);
});

test('lock wait exhausting budget rolls back before epoch or CAS', async () => {
  let t = 0;
  const h = harness({ now: () => t, beforeTx: () => { t += 91_000; } });
  const dry = await h.call(dryrun);
  const r = await h.call(applyBody(dry.body.digest));
  assert.equal(r.body.reason, 'budget_exceeded');
  assert.deepEqual([h.c.bump, h.c.update, h.c.audit], [0, 0, 0]);
});
