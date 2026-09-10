import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptEvidenceDiagnosticHandler, loadReceiptEvidenceDiagnostic, type DiagnosticDb } from '../src/lib/receipt-evidence-diagnostic';

const id = '6ff94e26-c8da-4684-a76e-9baaa7ca4361';
const url = `https://example.test/?bankLineIds=${id}&qbTxnIds=6546`;
test('unauthorized calls do not read, and responses are never cached', async () => {
    let reads = 0;
    const get = createReceiptEvidenceDiagnosticHandler({ authorized: () => false, load: async () => { reads++; return {}; } });
    const response = await get(new Request(url));
    assert.equal(response.status, 401); assert.equal(reads, 0);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('invalid authorized input does not read', async () => {
    const get = createReceiptEvidenceDiagnosticHandler({ authorized: () => true, load: async () => { throw new Error('must not read'); } });
    assert.equal((await get(new Request('https://example.test/'))).status, 400);
});
test('database error is sanitized', async () => {
    const get = createReceiptEvidenceDiagnosticHandler({ authorized: () => true, load: async () => { throw new Error('secret connection detail'); } });
    const response = await get(new Request(url));
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /secret/);
});
test('success explicitly reports no business actions or matching verdict', async () => {
    const get = createReceiptEvidenceDiagnosticHandler({ authorized: () => true, load: async () => ({ lines: [] }) });
    const response = await get(new Request(url)); const body = await response.json();
    assert.equal(body.businessActionsPerformed, false); assert.equal(body.matchingVerdict, 'not-evaluated');
});
test('all queries are bounded and account-scoped; expense candidates need observed QBO identity', async () => {
    const calls: Array<{ table: string; args: any }> = [];
    const read = (table: string, rows: any[]) => ({ findMany: async (args: any) => { calls.push({table,args}); return rows; } });
    const db = {
        bankLine: read('bankLine', [{ id, account:'WTB-0723', observations:[], probuildExpenseId:null }]),
        bankLineObservation: read('bankLineObservation', [{id:'obs',account:'WTB-0723',source:'QBO_REGISTER',sourceLineId:'6546'}]),
        expense: read('expense', []), receiptMemoArtifact: read('receiptMemoArtifact', []),
    } as unknown as DiagnosticDb;
    await loadReceiptEvidenceDiagnostic(db, {bankLineIds:[id],qbTxnIds:['6546','999']});
    assert.equal(calls[0].args.where.account, 'WTB-0723');
    assert.equal(calls[1].args.where.account, 'WTB-0723');
    assert.equal(calls[1].args.where.source, 'QBO_REGISTER');
    assert.ok(calls.every(c => c.args.take > 0 && c.args.take <= 31));
    assert.deepEqual(calls.find(c=>c.table==='expense')!.args.where.OR[0], {qbPurchaseId:{in:['6546']}});
    assert.equal(calls[0].args.select.observations.take, 11);
});
test('cross-account data is excluded and extra children are disclosed as truncated', async () => {
    const obs = Array.from({length:11},(_,i)=>({id:String(i),account:'WTB-0723',source:'STATEMENT',statementImport:{account:'WTB-0723'}}));
    const read = (rows:any[]) => ({findMany:async()=>rows});
    const db = {bankLine:read([{id,account:'WTB-0723',observations:obs,probuildExpenseId:null},{id:'wrong',account:'OTHER',observations:[],probuildExpenseId:null}]),bankLineObservation:read([{id:'bad',account:'OTHER',source:'QBO_REGISTER',sourceLineId:'6546'}]),expense:read([]),receiptMemoArtifact:read([])} as unknown as DiagnosticDb;
    const result = await loadReceiptEvidenceDiagnostic(db,{bankLineIds:[id],qbTxnIds:['6546']});
    assert.equal(result.lines.length, 1); assert.equal(result.lines[0].observations.length, 10);
    assert.equal(result.truncated, true); assert.equal(result.qboObservations.length, 0);
});
