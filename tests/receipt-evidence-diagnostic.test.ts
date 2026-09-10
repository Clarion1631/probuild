import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiptEvidenceQuery } from '../src/lib/receipt-evidence-diagnostic-query';

const id = '6ff94e26-c8da-4684-a76e-9baaa7ca4361';
test('accepts bounded explicit identities and normalizes UUID case', () => {
    assert.deepEqual(parseReceiptEvidenceQuery(new URLSearchParams({ bankLineIds: id.toUpperCase(), qbTxnIds: '6546,6613' })), { bankLineIds: [id], qbTxnIds: ['6546', '6613'] });
});
for (const query of ['', 'bankLineIds=', `bankLineIds=${id},${id.toUpperCase()}`, `bankLineIds=${id}&bankLineIds=${id}`, `bankLineIds=${id}&account=other`, `bankLineIds=${id}&qbTxnIds=1,1`, `bankLineIds=${id}&qbTxnIds=`, `bankLineIds=${id}&qbTxnIds=1&qbTxnIds=2`, `bankLineIds=${id}&qbTxnIds=123456789012345678901`, `bankLineIds=${id} `, 'bankLineIds=not-a-uuid', `bankLineIds=${id}&qbTxnIds=${Array.from({length:11},(_,i)=>i+1).join(',')}`, `bankLineIds=${Array.from({length:11},(_,i)=>`${i.toString().padStart(8,'0')}-c8da-4684-a76e-9baaa7ca4361`).join(',')}`]) {
    test(`rejects invalid query ${query}`, () => assert.equal(parseReceiptEvidenceQuery(new URLSearchParams(query)), null));
}
