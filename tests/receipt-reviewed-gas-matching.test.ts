import test from 'node:test';
import assert from 'node:assert/strict';
import { planReceiptRequests } from '../src/lib/receipt-requests';
import { componentVersionOf, componentVersionsMatch } from '../src/lib/receipt-requests';
import { receiptRecognitionPolicy } from '../src/lib/receipt-source-recognition';
import { parseReviewedReceiptFacts, resolveReviewedReceiptFact } from '../src/server/receipt-reviewed-source-facts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const syntheticPacket = {
  "version": 1,
  "account": "WTB-0723",
  "facts": [
    {
      "expected": {
        "id": "synthetic-expense-0",
        "qbPurchaseId": "1000",
        "qbSyncToken": "1",
        "status": "Reviewed",
        "description": "Synthetic receipt [gtr-file:synthetic-source-0]",
        "receiptUrl": "https://example.test/receipt-0.pdf",
        "amountCents": 10101,
        "date": "2025-05-12",
        "vendor": "Main Street Chevron"
      },
      "provenance": {
        "driveFileId": "synthetic-source-0",
        "sourceSha256": "1111111111111111111111111111111111111111111111111111111111111111",
        "driveVersion": "1",
        "invoice": "SYNTHETIC-0",
        "printedStore": "00093121"
      },
      "bankPayee": "CHEVRON 0093121 VANCOUVER WA",
      "cardTail": "1111"
    },
    {
      "expected": {
        "id": "synthetic-expense-1",
        "qbPurchaseId": "1001",
        "qbSyncToken": "1",
        "status": "Reviewed",
        "description": "Synthetic receipt [gtr-file:synthetic-source-1]",
        "receiptUrl": "https://example.test/receipt-1.pdf",
        "amountCents": 20202,
        "date": "2025-05-12",
        "vendor": "Kalama Chevron"
      },
      "provenance": {
        "driveFileId": "synthetic-source-1",
        "sourceSha256": "2222222222222222222222222222222222222222222222222222222222222222",
        "driveVersion": "1",
        "invoice": "SYNTHETIC-1",
        "printedStore": "00208580"
      },
      "bankPayee": "CHEVRON 0208580 KALAMA WA",
      "cardTail": "1111"
    },
    {
      "expected": {
        "id": "synthetic-expense-2",
        "qbPurchaseId": "1002",
        "qbSyncToken": "1",
        "status": "Reviewed",
        "description": "Synthetic receipt [gtr-file:synthetic-source-2]",
        "receiptUrl": "https://example.test/receipt-2.pdf",
        "amountCents": 30303,
        "date": "2025-05-12",
        "vendor": "AMPM #82887"
      },
      "provenance": {
        "driveFileId": "synthetic-source-2",
        "sourceSha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "driveVersion": "1",
        "invoice": "SYNTHETIC-2",
        "printedStore": "82887"
      },
      "bankPayee": "ARCO#82887KT KANSO LLC VANCOUVER WA",
      "cardTail": "1111"
    },
    {
      "expected": {
        "id": "synthetic-expense-3",
        "qbPurchaseId": "1003",
        "qbSyncToken": "1",
        "status": "Reviewed",
        "description": "Synthetic receipt [gtr-file:synthetic-source-3]",
        "receiptUrl": "https://example.test/receipt-3.pdf",
        "amountCents": 40404,
        "date": "2025-05-12",
        "vendor": "ampm"
      },
      "provenance": {
        "driveFileId": "synthetic-source-3",
        "sourceSha256": "4444444444444444444444444444444444444444444444444444444444444444",
        "driveVersion": "1",
        "invoice": "SYNTHETIC-3",
        "printedStore": "82887"
      },
      "bankPayee": "ARCO#82887KT KANSO LLC VANCOUVER WA",
      "cardTail": "1111"
    }
  ]
};
const rawPacket = JSON.stringify(syntheticPacket);
const config = parseReviewedReceiptFacts(rawPacket, createHash("sha256").update(rawPacket).digest("hex"));
const REVIEWED_RECEIPT_FACTS = syntheticPacket.facts;
const reviewedReceiptFactForExpense = (input: unknown) => resolveReviewedReceiptFact(input, config);
const fixtures = [
  {
    "line": {
      "id": "synthetic-bank-0",
      "account": "WTB-0723",
      "sourceOfRecord": "STATEMENT",
      "postedDate": "2025-05-13",
      "rawDescriptor": "MISCELLANEOUS DEBIT CHEVRON 0093121 VANCOUVER WA C#1111 DBT CRD 1200 05/12/25 12345678",
      "amountCents": -10101,
      "checkNumber": null
    },
    "expense": {
      "id": "synthetic-expense-0",
      "qbPurchaseId": "1000",
      "date": "2025-05-12",
      "vendor": "Main Street Chevron",
      "amountCents": 10101,
      "hasReceipt": true,
      "reviewedSourceFact": {
        "bankPayee": "CHEVRON 0093121 VANCOUVER WA",
        "cardTail": "1111",
        "purchaseDate": "2025-05-12",
        "amountCents": 10101,
        "sourceFactDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  },
  {
    "line": {
      "id": "synthetic-bank-1",
      "account": "WTB-0723",
      "sourceOfRecord": "STATEMENT",
      "postedDate": "2025-05-13",
      "rawDescriptor": "MISCELLANEOUS DEBIT CHEVRON 0208580 KALAMA WA C#1111 DBT CRD 1200 05/12/25 12345678",
      "amountCents": -20202,
      "checkNumber": null
    },
    "expense": {
      "id": "synthetic-expense-1",
      "qbPurchaseId": "1001",
      "date": "2025-05-12",
      "vendor": "Kalama Chevron",
      "amountCents": 20202,
      "hasReceipt": true,
      "reviewedSourceFact": {
        "bankPayee": "CHEVRON 0208580 KALAMA WA",
        "cardTail": "1111",
        "purchaseDate": "2025-05-12",
        "amountCents": 20202,
        "sourceFactDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  },
  {
    "line": {
      "id": "synthetic-bank-2",
      "account": "WTB-0723",
      "sourceOfRecord": "STATEMENT",
      "postedDate": "2025-05-13",
      "rawDescriptor": "MISCELLANEOUS DEBIT ARCO#82887KT KANSO LLC VANCOUVER WA C#1111 DBT CRD 1200 05/12/25 12345678",
      "amountCents": -30303,
      "checkNumber": null
    },
    "expense": {
      "id": "synthetic-expense-2",
      "qbPurchaseId": "1002",
      "date": "2025-05-12",
      "vendor": "AMPM #82887",
      "amountCents": 30303,
      "hasReceipt": true,
      "reviewedSourceFact": {
        "bankPayee": "ARCO#82887KT KANSO LLC VANCOUVER WA",
        "cardTail": "1111",
        "purchaseDate": "2025-05-12",
        "amountCents": 30303,
        "sourceFactDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  },
  {
    "line": {
      "id": "synthetic-bank-3",
      "account": "WTB-0723",
      "sourceOfRecord": "STATEMENT",
      "postedDate": "2025-05-13",
      "rawDescriptor": "MISCELLANEOUS DEBIT ARCO#82887KT KANSO LLC VANCOUVER WA C#1111 DBT CRD 1200 05/12/25 12345678",
      "amountCents": -40404,
      "checkNumber": null
    },
    "expense": {
      "id": "synthetic-expense-3",
      "qbPurchaseId": "1003",
      "date": "2025-05-12",
      "vendor": "ampm",
      "amountCents": 40404,
      "hasReceipt": true,
      "reviewedSourceFact": {
        "bankPayee": "ARCO#82887KT KANSO LLC VANCOUVER WA",
        "cardTail": "1111",
        "purchaseDate": "2025-05-12",
        "amountCents": 40404,
        "sourceFactDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  }
];
for (const fixture of fixtures) test(`reviewed source admits synthetic ${fixture.expense.qbPurchaseId} without changing money`, () => {
 const result=planReceiptRequests({sourceRecognitionEnabled:true,bankLines:[fixture.line],expenses:[fixture.expense],intakes:[],openIssueKeys:[fixture.line.id],now:new Date('2026-09-10T12:00:00Z')});
 assert.deepEqual(result.close,[fixture.line.id]);
});

function run(fixture: typeof fixtures[number], patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
 const fact = REVIEWED_RECEIPT_FACTS.find(f => f.expected.qbPurchaseId === fixture.expense.qbPurchaseId)!;
 const expense = {...fixture.expense, reviewedSourceFact:reviewedReceiptFactForExpense(fact.expected)};
 const line = {...fixture.line,...patch};
 return planReceiptRequests({sourceRecognitionEnabled:true,bankLines:[line],expenses:[expense],intakes:[],openIssueKeys:[line.id],now:new Date('2026-09-10T12:00:00Z'),...extra});
}
for(const f of fixtures) {
 test(`synthetic server fact ${f.expense.qbPurchaseId} reaches matcher`,()=>assert.deepEqual(run(f).close,[f.line.id]));
 test(`source gates and contradictory cards reject ${f.expense.qbPurchaseId}`,()=>{
  for(const raw of [f.line.rawDescriptor.replace('C#1111','C#2222'),f.line.rawDescriptor+' C#2222',f.line.rawDescriptor+' C#1111',f.line.rawDescriptor.replace('C#1111','C#111'),f.line.rawDescriptor.replace(/05\/\d{2}\/25/,'05/01/25'),f.line.rawDescriptor.replace('VANCOUVER','PORTLAND').replace('KALAMA','PORTLAND'),f.line.rawDescriptor.replace(/0093121|0208580|82887/,'9999999')]) {
   assert.deepEqual(run(f,{rawDescriptor:raw}).close,[],raw);
  }
  for(const patch of [{sourceOfRecord:'QBO_REGISTER'},{account:'WTB-9999'},{checkNumber:'42'},{amountCents:f.line.amountCents-1}]) assert.deepEqual(run(f,patch).close,[]);
  assert.deepEqual(run(f,{}, {sourceRecognitionEnabled:false}).close,[]);
 });
 test(`one reviewed receipt ${f.expense.qbPurchaseId} has one unit across duplicate charge and intake`,()=>{
  const twin={...f.line,id:f.line.id+'-twin'};
  const intake={id:'intake',expenseId:f.expense.id,qbPurchaseId:f.expense.qbPurchaseId,state:'BOOKED',txnDate:f.expense.date,totalCents:f.expense.amountCents,vendor:f.expense.vendor};
  const plan=run(f,{}, {bankLines:[f.line,twin],intakes:[intake],openIssueKeys:[f.line.id,twin.id]});
  assert.equal(plan.close.length,1);
  assert.equal(plan.open.length,1);
 });
 test(`reserved lineage still prevents ${f.expense.qbPurchaseId} reuse`,()=>{
  assert.deepEqual(run(f,{}, {boundLineage:{bound:[],reservedUnits:[`purchase:${f.expense.qbPurchaseId}`]}}).close,[]);
 });
 test(`incomplete evidence is not a verdict ${f.expense.qbPurchaseId}`,()=>{
  const plan=run(f,{}, {evidenceLoadedFrom:f.line.postedDate,evidenceLoadedTo:f.line.postedDate});
  assert.deepEqual(plan.close,[]); assert.deepEqual(plan.open,[]); assert.deepEqual(plan.undecided,[f.line.id]);
 });
}
test('receipt removal, refund magnitude and distinct existing ordinary receipt keep their semantics',()=>{
 const f=fixtures[0];
 for(const patch of [{hasReceipt:false},{amountCents:-10101},{amountCents:0}]) {
  assert.deepEqual(run(f,{}, {expenses:[{...f.expense,...patch}]}).close,[]);
 }
 // A distinct fully receipted ordinary candidate remains usable; source facts do not consume an extra unit.
 const twin={...f.line,id:'twin'};
 const known={...f.expense,id:'other',qbPurchaseId:'different',vendor:'CHEVRON 0093121 VANCOUVER WA',reviewedSourceFact:null};
 const source={...f.expense,reviewedSourceFact:reviewedReceiptFactForExpense(REVIEWED_RECEIPT_FACTS[0].expected)};
 assert.equal(run(f,{}, {bankLines:[f.line,twin],expenses:[source,known],openIssueKeys:[f.line.id,twin.id]}).close.length,2);
});
test('new receipt identity/version inputs invalidate component OCC',()=>{
 const expected=REVIEWED_RECEIPT_FACTS[0].expected;
 const row={...expected,hasReceipt:true};
 const version=(expense:typeof row)=>componentVersionOf({issues:[],intakes:[],expenses:[expense]});
 for(const key of ['receiptUrl','qbSyncToken','status','description'] as const) {
  assert.equal(componentVersionsMatch(version(row),version({...row,[key]:row[key]+'-moved'})),false,key);
 }
});
test('all production evidence reads and both OCC projections carry reviewed fact inputs',()=>{
 const route=readFileSync(new URL('../src/app/api/cron/receipt-requests/route.ts',import.meta.url),'utf8');
 assert.equal((route.match(/receiptUrl: true, qbSyncToken: true, status: true, description: true/g)??[]).length,3);
 assert.equal((route.match(/reviewedSourceFact: reviewedReceiptFactForExpense/g)??[]).length,2);
 assert.equal((route.match(/receiptUrl: row.receiptUrl, qbSyncToken: row.qbSyncToken, status: row.status, description: row.description/g)??[]).length,2);
 const shared=readFileSync(new URL('../src/lib/receipt-requests.ts',import.meta.url),'utf8');
 assert.doesNotMatch(shared,/server\/receipt-reviewed-source-facts/);
 assert.match(route,/@\/server\/receipt-reviewed-source-facts/);
});
test('new facts invalidate previous enabled cycle while disabled semantics stay stable',()=>{
 assert.equal(receiptRecognitionPolicy(true,'absent','absent'),'receipt-source-v3:on:absent:pair:absent');
 assert.equal(receiptRecognitionPolicy(false,'absent','absent'),'receipt-source-v1:off');
});

test('global linked intake outside the loaded window or dead-excluded cannot grant a reviewed edge',()=>{
 const f=fixtures[0];
 const e={...f.expense,linkedIntakeId:'not-loaded'};
 assert.deepEqual(run(f,{}, {expenses:[e]}).close,[]);
});
test('missing/conflicting intake Purchase identity refuses new edge without double capacity',()=>{
 const f=fixtures[0]; const twin={...f.line,id:'synthetic-twin'};
 for(const qbPurchaseId of [null,'different']) {
  const intake={id:'linked',expenseId:f.expense.id,qbPurchaseId,state:'BOOKED',txnDate:f.expense.date,totalCents:f.expense.amountCents,vendor:'CHEVRON VANCOUVER WA'};
  const plan=run(f,{}, {bankLines:[f.line,twin],expenses:[{...f.expense,linkedIntakeId:'linked'}],intakes:[intake],openIssueKeys:[f.line.id,twin.id]});
  assert.equal(plan.close.length,1); assert.equal(plan.open.length,1);
 }
});
test('matching globally linked intake loaded in the component folds once',()=>{
 const f=fixtures[0]; const twin={...f.line,id:'synthetic-twin'};
 const intake={id:'linked',expenseId:f.expense.id,qbPurchaseId:f.expense.qbPurchaseId,state:'BOOKED',txnDate:f.expense.date,totalCents:f.expense.amountCents,vendor:f.expense.vendor};
 const plan=run(f,{}, {bankLines:[f.line,twin],expenses:[{...f.expense,linkedIntakeId:'linked'}],intakes:[intake],openIssueKeys:[f.line.id,twin.id]});
 assert.equal(plan.close.length,1); assert.equal(plan.open.length,1);
});
test('linked intake insertion deletion and replacement invalidate OCC even when receiptURL remains',()=>{
 const e={id:'synthetic',hasReceipt:true,receiptUrl:'https://example.test/receipt.pdf'};
 const v=(linkedIntakeId:string|null)=>componentVersionOf({issues:[],intakes:[],expenses:[{...e,linkedIntakeId}]});
 assert.equal(componentVersionsMatch(v(null),v('created')),false);
 assert.equal(componentVersionsMatch(v('created'),v(null)),false);
 assert.equal(componentVersionsMatch(v('created'),v('replaced')),false);
});
test('config change removal and invalid pin invalidate sweep and card certification policy',()=>{
 const p=receiptRecognitionPolicy(true,config.fingerprint,'absent');
 assert.notEqual(p,receiptRecognitionPolicy(true,'absent','absent'));
 assert.notEqual(p,receiptRecognitionPolicy(true,'invalid','absent'));
 assert.notEqual(p,receiptRecognitionPolicy(true,'b'.repeat(64),'absent'));
 const sweep=readFileSync(new URL('../src/app/api/cron/receipt-requests/route.ts',import.meta.url),'utf8');
 const cards=readFileSync(new URL('../src/app/api/cron/receipt-request-cards/route.ts',import.meta.url),'utf8');
 assert.match(sweep,/receiptRecognitionPolicy\(SOURCE_RECOGNITION_ENABLED, reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint\)/);
 assert.match(cards,/receiptRecognitionPolicy\(process\.env\.RECEIPT_SOURCE_RECOGNITION_ENABLED === "true", reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint\)/);
});
