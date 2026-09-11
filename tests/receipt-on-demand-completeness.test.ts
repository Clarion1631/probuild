import {test} from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {ComponentTooLargeError} from '../src/lib/receipt-requests';
process.env.DATABASE_URL='postgresql://fiction:fiction@127.0.0.1:9/test?pgbouncer=true';
process.env.NEXTAUTH_SECRET='fictional-test-only';
globalThis.fetch=async()=>{throw Error('NETWORK DENIED');};

test('strict recompute rejects actual component overflow; ordinary issue remains open', async () => {
 const line={id:'fictional-target',postedDate:new Date('2026-01-12T00:00:00Z'),amountCents:-12345,rawDescriptor:'FICTIONAL STORE',checkNumber:null,updatedAt:new Date('2026-01-12T00:00:00Z'),account:'WTB-0723',sourceOfRecord:'STATEMENT'};
 const fake={bankLine:{findUnique:async()=>line,findMany:async()=>Array.from({length:201},(_,i)=>({...line,id:`fictional-${i}`}))},reviewIssue:{findUnique:async()=>null},receiptMemoArtifact:{findUnique:async()=>null}};
 const original=Module.prototype.require; let intercepted=false;
 Module.prototype.require=function(this:NodeModule,id:string){
  if(id==='@/lib/prisma'){intercepted=true;return {prisma:fake};}
  return original.apply(this,arguments as unknown as [string]);
 };
 let route:typeof import('../src/app/api/cron/receipt-requests/route');
 try {route=await import('../src/app/api/cron/receipt-requests/route');} finally{Module.prototype.require=original;}
 assert.equal(intercepted,true);
 assert.deepEqual(await route.recomputeCodesFor(line.id),['MISSING_RECEIPT']);
 await assert.rejects(route.recomputeCodesFor(line.id,undefined,undefined,true),ComponentTooLargeError);
});
