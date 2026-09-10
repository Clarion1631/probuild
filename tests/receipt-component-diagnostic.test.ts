import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createReceiptComponentDiagnosticHandler,
    loadReceiptComponentDiagnostic,
    parseReceiptComponentDiagnosticQuery,
    evidenceFingerprint,
    COMPONENT_CAP,
    EVIDENCE_CAP,
    type DiagnosticDb,
    type DiagnosticDeps,
} from '../src/lib/receipt-component-diagnostic';

// Synthetic fixtures only. Amounts are 10101 cents, dates are in 2025.
const LINE_ID = '11111111-1111-4111-8111-111111111111';
const QB_ID = '123';
const LINE = {
    id: LINE_ID, account: 'WTB-0723', sourceOfRecord: 'STATEMENT', state: 'NEW', postedDate: new Date('2025-03-10T00:00:00Z'),
    amountCents: -10101, rawDescriptor: 'POS DEB 1200 03/09/25 12345678 STORE C#0000', checkNumber: null,
    qbTxnId: null, probuildExpenseId: null, updatedAt: new Date('2025-03-11T00:00:00Z'),
};
const OBS = { id: 'obs-1', account: 'WTB-0723', source: 'QBO_REGISTER', sourceLineId: QB_ID, bankLineId: null, postedDate: new Date('2025-03-10T00:00:00Z'), amountCents: -10101, createdAt: new Date('2025-03-11T00:00:00Z') };
const EXPENSE = {
    id: 'exp-1', date: new Date('2025-03-10T00:00:00Z'), amount: '101.01', vendor: 'Synthetic Vendor', receiptUrl: 'https://example.invalid/r/1',
    sourceFileId: 'file-1', sourceGroupIndex: 0, qbPurchaseId: QB_ID, qbSyncToken: '0', status: 'ok', description: null,
    receiptIntake: null, updatedAt: new Date('2025-03-11T00:00:00Z'),
};
const EPOCHS = [
    { key: 'bankLedgerEpoch', value: '1' },
    { key: 'bankRegisterPullLastSuccess', value: '2025-03-12T00:00:00.000Z' },
    { key: 'receiptEvidenceEpoch', value: '1' },
];

type Call = { model: string; args: Record<string, unknown> };

function fakeDb(responses: Partial<Record<string, (args: Record<string, unknown>, nth: number) => unknown[]>> = {}, calls: Call[] = []) {
    const models = ['bankLine', 'bankLineObservation', 'expense', 'receiptIntake', 'reviewIssue', 'receiptMemoArtifact', 'automationSetting'];
    const seen: Record<string, number> = {};
    const db: Record<string, unknown> = {};
    for (const model of models) {
        db[model] = new Proxy({}, {
            get(_target, prop) {
                if (prop !== 'findMany') throw new Error(`write or non-read access attempted: ${model}.${String(prop)}`);
                return async (args: Record<string, unknown>) => {
                    calls.push({ model, args });
                    const nth = seen[model] = (seen[model] ?? 0) + 1;
                    return responses[model]?.(args, nth) ?? [];
                };
            },
        });
    }
    return { db: db as unknown as DiagnosticDb, calls };
}

function deps(overrides: Partial<DiagnosticDeps> = {}): DiagnosticDeps {
    return {
        now: () => new Date('2025-03-12T01:00:00Z'), zone: 'UTC', recognitionEnabled: true, policy: 'receipt-source-v2:on:abc',
        decimalStringToCents: value => Math.round(Number(value) * 100), bankPullWindowHours: 48, ...overrides,
    };
}

const happy = (overrides: Parameters<typeof fakeDb>[0] = {}) => fakeDb({
    automationSetting: () => EPOCHS.map(row => ({ ...row })),
    bankLine: args => {
        const where = args.where as Record<string, unknown>;
        if (where.id === LINE_ID) return [LINE];
        if (where.amountCents === -10101) return [LINE, { ...LINE, id: '22222222-2222-4222-8222-222222222222', account: 'OTHER', postedDate: new Date('2025-03-12T00:00:00Z') }];
        return [];
    },
    bankLineObservation: args => ((args.where as Record<string, unknown>).account === 'WTB-0723' ? [OBS] : [OBS, { ...OBS, id: 'obs-2', account: 'OTHER' }]),
    expense: args => {
        const where = args.where as Record<string, unknown>;
        if (where.qbPurchaseId === QB_ID) return [EXPENSE];
        if (where.OR) return [EXPENSE, { ...EXPENSE, id: 'exp-2', qbPurchaseId: '124', sourceGroupIndex: 1 }];
        return [EXPENSE];
    },
    receiptIntake: args => ((args.where as Record<string, unknown>).OR ? [{ id: 'in-1', state: 'VOID', stateReason: null, txnDate: null, vendor: null, totalCents: 10101, expenseId: null, qbPurchaseId: null, postVoidQbPurchaseId: QB_ID, sourceRef: 'web:x' }] : []),
    ...overrides,
});

test('parse accepts exactly one bankLineId and one qbTxnId', () => {
    const q = parseReceiptComponentDiagnosticQuery(new URLSearchParams({ bankLineId: LINE_ID.toUpperCase(), qbTxnId: QB_ID }));
    assert.deepEqual(q, { bankLineId: LINE_ID, qbTxnId: QB_ID });
});

test('parse rejects extra, repeated, comma and list parameters', () => {
    const bad = [
        `bankLineId=${LINE_ID}`,
        `qbTxnId=${QB_ID}`,
        `bankLineId=${LINE_ID}&qbTxnId=${QB_ID}&x=1`,
        `bankLineId=${LINE_ID}&bankLineId=${LINE_ID}&qbTxnId=${QB_ID}`,
        `bankLineId=${LINE_ID}&qbTxnId=1,2`,
        `bankLineId=${LINE_ID}&qbTxnId=${'9'.repeat(21)}`,
        `bankLineId=${LINE_ID}&qbTxnId=`,
        `bankLineId=not-a-uuid&qbTxnId=1`,
        `bankLineIds=${LINE_ID}&qbTxnId=1`,
    ];
    for (const qs of bad) assert.equal(parseReceiptComponentDiagnosticQuery(new URLSearchParams(qs)), null, qs);
});

test('handler: 401 without auth, 400 on bad query, no-store, sanitized 503', async () => {
    const url = `https://example.invalid/d?bankLineId=${LINE_ID}&qbTxnId=${QB_ID}`;
    const denied = createReceiptComponentDiagnosticHandler({ authorized: () => false, load: async () => ({}) });
    const r401 = await denied(new Request(url));
    assert.equal(r401.status, 401);
    assert.equal(r401.headers.get('cache-control'), 'no-store');
    let loads = 0;
    const h = createReceiptComponentDiagnosticHandler({ authorized: () => true, load: async () => { loads++; throw new Error('secret db detail'); } });
    const r400 = await h(new Request('https://example.invalid/d?bankLineId=x'));
    assert.equal(r400.status, 400);
    assert.equal(loads, 0);
    const r503 = await h(new Request(url));
    assert.equal(r503.status, 503);
    assert.equal(r503.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r503.json(), { error: 'Receipt component diagnostic unavailable' });
});

test('happy path: bounded reads, global claims, closure over all accounts, complete:true', async () => {
    const { db, calls } = happy();
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps());
    assert.equal(result.status, 'complete');
    assert.equal(result.complete, true);
    assert.equal(result.matchingVerdict, 'not-evaluated');
    assert.equal(result.bindingCertified, false);
    assert.equal(result.businessActionsPerformed, false);
    assert.equal(result.linkDays, 9);
    if (result.status !== 'complete') return;
    assert.equal(result.candidateCents, 10101);
    assert.equal(result.candidateDateMismatch, false);
    assert.deepEqual(result.sourceGroups, ['file-1#0', 'file-1#1']);
    assert.equal(result.counts.claimIntakes, 1);
    assert.equal(result.evidenceRange.minYmd, '2025-03-03');
    assert.equal(result.evidenceRange.maxYmd, '2025-03-14');
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
    // First and last reads are the epoch keys.
    assert.equal(calls[0].model, 'automationSetting');
    assert.equal(calls[calls.length - 1].model, 'automationSetting');
    assert.equal(calls[0].args.take, 4);
    // Closure: same cents, no account/state/source filter, capped.
    const closure = calls.filter(c => c.model === 'bankLine' && (c.args.where as Record<string, unknown>).amountCents === -10101);
    assert.ok(closure.length >= 1);
    for (const c of closure) {
        const where = c.args.where as Record<string, unknown>;
        assert.equal(where.account, undefined);
        assert.equal(where.state, undefined);
        assert.equal(c.args.take, COMPONENT_CAP + 1);
    }
    // Target QBO observation is account-scoped; global claim observation is not.
    const obs = calls.filter(c => c.model === 'bankLineObservation').map(c => c.args.where as Record<string, unknown>);
    assert.deepEqual(obs[0], { account: 'WTB-0723', source: 'QBO_REGISTER', sourceLineId: QB_ID });
    assert.deepEqual(obs[1], { source: 'QBO_REGISTER', sourceLineId: QB_ID });
    // Global claims carry no date/state filters and use exact source keys.
    const claimIntake = calls.find(c => c.model === 'receiptIntake' && (c.args.where as Record<string, unknown>).OR);
    assert.deepEqual((claimIntake?.args.where as Record<string, unknown>).OR, [{ qbPurchaseId: QB_ID }, { postVoidQbPurchaseId: QB_ID }, { expenseId: 'exp-1' }]);
    const claimExpense = calls.find(c => c.model === 'expense' && (c.args.where as Record<string, unknown>).OR);
    assert.deepEqual((claimExpense?.args.where as Record<string, unknown>).OR, [{ receiptUrl: EXPENSE.receiptUrl }, { sourceFileId: 'file-1' }]);
    const claimLine = calls.find(c => c.model === 'bankLine' && (c.args.where as Record<string, unknown>).OR);
    assert.deepEqual((claimLine?.args.where as Record<string, unknown>).OR, [{ qbTxnId: QB_ID }, { probuildExpenseId: 'exp-1' }]);
    // Range reads exclude dead intakes and are capped.
    const rangeIntake = calls.find(c => c.model === 'receiptIntake' && !(c.args.where as Record<string, unknown>).OR);
    assert.deepEqual((rangeIntake?.args.where as Record<string, unknown>).state, { notIn: ['DUPLICATE', 'VOID', 'NON_RECEIPT'] });
    assert.equal(rangeIntake?.args.take, EVIDENCE_CAP + 1);
    // Never selects every field.
    for (const c of calls) assert.ok(c.args.select, `${c.model} must use select`);
});

test('stops before candidate/global reads when target is not canonical', async () => {
    const { db, calls } = fakeDb({ automationSetting: () => EPOCHS, bankLine: () => [{ ...LINE, account: 'OTHER' }] });
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps());
    assert.equal(result.status, 'target-not-canonical');
    assert.equal(result.complete, false);
    assert.ok(!calls.some(c => c.model === 'expense'));
});

test('stops when the account-scoped QBO observation is missing', async () => {
    const { db, calls } = fakeDb({ automationSetting: () => EPOCHS, bankLine: () => [LINE], bankLineObservation: () => [{ ...OBS, account: 'OTHER' }] });
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps());
    assert.equal(result.status, 'qbo-observation-missing');
    assert.ok(!calls.some(c => c.model === 'expense'));
});

test('candidate amount mismatch is reported without a verdict', async () => {
    const { db } = fakeDb({ automationSetting: () => EPOCHS, bankLine: () => [LINE], bankLineObservation: () => [OBS], expense: () => [{ ...EXPENSE, amount: '101.02' }] });
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps());
    assert.equal(result.status, 'candidate-amount-mismatch');
    assert.equal(result.matchingVerdict, 'not-evaluated');
});

test('epoch moved during read returns complete:false unstable', async () => {
    const { db } = fakeDb({
        automationSetting: (_args, nth) => (nth === 1 ? EPOCHS : EPOCHS.map(r => (r.key === 'bankLedgerEpoch' ? { ...r, value: '2' } : r))),
        bankLine: args => ((args.where as Record<string, unknown>).id ? [LINE] : [LINE]),
        bankLineObservation: () => [OBS], expense: () => [EXPENSE],
    });
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps());
    assert.equal(result.status, 'unstable');
    assert.equal(result.complete, false);
    assert.equal('fingerprint' in result, false);
});

test('absent epoch key returns unstable before any other read', async () => {
    const { db, calls } = fakeDb({ automationSetting: () => EPOCHS.filter(r => r.key !== 'receiptEvidenceEpoch') });
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps());
    assert.equal(result.status, 'unstable');
    assert.equal(calls.length, 1);
});

test('range overflow fails closed', async () => {
    const many = Array.from({ length: EVIDENCE_CAP + 1 }, (_v, i) => ({ ...EXPENSE, id: `exp-${i}`, qbPurchaseId: null }));
    const { db } = fakeDb({
        automationSetting: () => EPOCHS, bankLine: () => [LINE], bankLineObservation: () => [OBS],
        expense: args => ((args.where as Record<string, unknown>).qbPurchaseId ? [EXPENSE] : many),
    });
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps());
    assert.equal(result.status, 'overflow');
    assert.equal(result.complete, false);
});

test('closure component over cap fails closed', async () => {
    const many = Array.from({ length: COMPONENT_CAP + 1 }, (_v, i) => ({ ...LINE, id: `${i}`.padStart(8, '0') + LINE_ID.slice(8) }));
    const { db } = fakeDb({
        automationSetting: () => EPOCHS, bankLineObservation: () => [OBS], expense: () => [EXPENSE],
        bankLine: args => ((args.where as Record<string, unknown>).id ? [LINE] : many),
    });
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps());
    assert.equal(result.status, 'overflow');
});

test('cooperative deadline stops the walk', async () => {
    let tick = 0;
    const { db } = happy();
    const clock = () => new Date(Date.UTC(2025, 2, 12, 1, 0, 0, tick++ * 20_000));
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps({ now: clock, budgetMs: 45_000 }));
    assert.equal(result.status, 'deadline');
    assert.equal(result.complete, false);
});

test('unknown errors propagate (handler turns them into 503)', async () => {
    const { db } = fakeDb({ automationSetting: () => { throw new Error('boom'); } });
    await assert.rejects(loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps()), /boom/);
});

test('missing sourceFileId is a stated limitation, no substring search', async () => {
    const { db, calls } = fakeDb({
        automationSetting: () => EPOCHS, bankLine: () => [LINE], bankLineObservation: () => [OBS],
        expense: () => [{ ...EXPENSE, sourceFileId: null }],
    });
    const result = await loadReceiptComponentDiagnostic(db, { bankLineId: LINE_ID, qbTxnId: QB_ID }, deps({ recognitionEnabled: false }));
    assert.equal(result.status, 'complete');
    assert.equal(result.linkDays, 4);
    assert.ok(result.limitations.some(l => /no sourceFileId/.test(l)));
    const claim = calls.find(c => c.model === 'expense' && (c.args.where as Record<string, unknown>).OR);
    assert.deepEqual((claim?.args.where as Record<string, unknown>).OR, [{ receiptUrl: EXPENSE.receiptUrl }]);
});

test('fingerprint is deterministic and order-insensitive to key order', () => {
    const a = evidenceFingerprint({ b: [{ id: '1', x: 1 }], a: new Date('2025-01-01T00:00:00Z') });
    const b = evidenceFingerprint({ a: new Date('2025-01-01T00:00:00Z'), b: [{ x: 1, id: '1' }] });
    assert.equal(a, b);
    assert.notEqual(a, evidenceFingerprint({ a: new Date('2025-01-01T00:00:00Z'), b: [{ x: 2, id: '1' }] }));
});


test('actual Prisma dates and transitive closed competitors extend beyond a fixed window', async () => {
    const rows = [0,9,18].map((days,index) => ({ ...LINE, id: index ? `sibling-${index}` : LINE_ID, state: 'MATCHED', postedDate: new Date(Date.UTC(2025,2,10+days)) }));
    const {db,calls} = happy({bankLine: args => {
        const w=args.where as {id?: unknown; amountCents?:number; postedDate?: {gte:Date;lte:Date}};
        if(w.id===LINE_ID) return [rows[0]];
        if(w.amountCents) return rows.filter(r=>r.postedDate>=w.postedDate!.gte && r.postedDate<=w.postedDate!.lte);
        if(w.id) return rows;
        return [];
    }});
    const result=await loadReceiptComponentDiagnostic(db,{bankLineId:LINE_ID,qbTxnId:QB_ID},deps());
    assert.equal(result.status,'complete');
    if(result.status!=='complete') return;
    assert.equal(result.component.length,3);
    assert.equal(result.evidenceRange.maxYmd,'2025-03-30');
    assert.ok(calls.filter(c=>c.model==='bankLine' && 'amountCents' in (c.args.where as object)).length>=3);
});

test('non-numeric epoch is not a stable complete projection', async()=>{
    const {db}=happy({automationSetting:()=>EPOCHS.map(r=>r.key==='receiptEvidenceEpoch'?{...r,value:'garbage'}:r)});
    const r=await loadReceiptComponentDiagnostic(db,{bankLineId:LINE_ID,qbTxnId:QB_ID},deps());
    assert.equal(r.status,'unstable');assert.equal(r.complete,false);
});

test('stale, future and missing bank success never report fresh complete proof',async()=>{
    for(const value of ['2025-01-01T00:00:00Z','2025-04-01T00:00:00Z',null]){
        const {db}=happy({automationSetting:()=>EPOCHS.map(r=>r.key==='bankRegisterPullLastSuccess'?{...r,value}:r)});
        const r=await loadReceiptComponentDiagnostic(db,{bankLineId:LINE_ID,qbTxnId:QB_ID},deps());
        assert.equal(r.status,'stale');assert.equal(r.complete,false);
    }
});

test('request setup consumed budget prevents the first database read',async()=>{
    const {db,calls}=happy();
    const r=await loadReceiptComponentDiagnostic(db,{bankLineId:LINE_ID,qbTxnId:QB_ID},deps({startedAt:new Date('2025-03-12T00:59:00Z')}));
    assert.equal(r.status,'deadline');assert.equal(calls.length,0);
});

test('global Expense-only, conflicting Purchase and void claims survive date/state exclusions',async()=>{
    const claims=[{id:'old-claim',expenseId:EXPENSE.id,qbPurchaseId:null,postVoidQbPurchaseId:null,state:'VOID',txnDate:new Date('2020-01-01')},{id:'conflict',expenseId:EXPENSE.id,qbPurchaseId:'999',postVoidQbPurchaseId:null,state:'BOOKED',txnDate:new Date('2020-01-01')}];
    const {db,calls}=happy({receiptIntake:args=>(args.where as Record<string,unknown>).OR?claims:[]});
    const r=await loadReceiptComponentDiagnostic(db,{bankLineId:LINE_ID,qbTxnId:QB_ID},deps());
    assert.equal(r.status,'complete');if(r.status!=='complete')return;
    assert.equal(r.claimIntakes.length,2);
    const q=calls.find(c=>c.model==='receiptIntake' && 'OR' in (c.args.where as object))!;
    assert.deepEqual(q.args.where,{OR:[{qbPurchaseId:QB_ID},{postVoidQbPurchaseId:QB_ID},{expenseId:EXPENSE.id}]});
    assert.equal(r.bindingCertified,false);
});

test('global claim cap fails closed rather than returning a partial census',async()=>{
    const {db}=happy({receiptIntake:args=>(args.where as Record<string,unknown>).OR?Array.from({length:501},(_,i)=>({id:`claim-${i}`})):[]});
    const r=await loadReceiptComponentDiagnostic(db,{bankLineId:LINE_ID,qbTxnId:QB_ID},deps());
    assert.equal(r.status,'overflow');assert.equal(r.complete,false);
});

test('existing lineage census includes global source claims and exact aliases',async()=>{
    const {db,calls}=happy();const r=await loadReceiptComponentDiagnostic(db,{bankLineId:LINE_ID,qbTxnId:QB_ID},deps());
    assert.equal(r.status,'complete');if(r.status!=='complete')return;
    assert.ok(r.lineage.units?.some(unit=>unit.unit===`purchase:${QB_ID}`));
    assert.ok(calls.some(c=>c.model==='bankLineObservation' && typeof (c.args.where as Record<string,unknown>).sourceLineId==='object'));
});
