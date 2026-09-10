import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyMemoPreflightHandler } from '../src/lib/legacy-memo-preflight';
const req=()=>new Request('https://example.test/api/integrations/bank-ledger/legacy-affidavit-preflight');
function harness(n=0){let reads=0;const calls:unknown[]=[];const handler=createLegacyMemoPreflightHandler({authorized:()=>true,now:()=>new Date('2026-09-10T00:00:00Z'),db:{receiptMemoArtifact:{count:async()=>{reads++;return n;},findMany:async(args:unknown)=>{calls.push(args);reads++;return Array.from({length:Math.min(n,20)},(_,i)=>({pdfId:`fictional_pdf_${i}`,targetType:'bank-line',targetKey:`fictional-target-${i}`,issueId:`issue-${i}`}));}}}});return{handler,calls,get reads(){return reads;}};}
test('empty inventory is observed metadata only, not content verification',async()=>{const h=harness();const r=await h.handler(req());const b=await r.json();assert.equal(r.status,200);assert.equal(b.artifactCount,0);assert.equal(b.contentVerifiedCount,null);assert.equal(b.hashFieldsQueried,false);assert.equal(b.businessWrites,false);assert.equal(b.truncated,false);});
test('global count exceeds bounded listing, and only old fields queried',async()=>{const h=harness(25);const b=await(await h.handler(req())).json();assert.equal(b.artifactCount,25);assert.equal(b.artifacts.length,20);assert.equal(b.truncated,true);assert.deepEqual(h.calls,[{orderBy:{pdfId:'asc'},take:20,select:{pdfId:true,targetType:true,targetKey:true,issueId:true}}]);});
test('unauthorized never reads DB',async()=>{const h=createLegacyMemoPreflightHandler({authorized:()=>false,now:()=>new Date(),db:{receiptMemoArtifact:{count:async()=>{throw Error('read');},findMany:async()=>{throw Error('read');}}}});assert.equal((await h(req())).status,401);});
test('query parameters refused to prevent enumeration options',async()=>{const h=harness();assert.equal((await h.handler(new Request(req().url+'?limit=999'))).status,400);assert.equal(h.reads,0);});
test('database failure returns unavailable, no healthy zero or raw error',async()=>{const h=createLegacyMemoPreflightHandler({authorized:()=>true,now:()=>new Date(),db:{receiptMemoArtifact:{count:async()=>{throw Error('SECRET_VALUE');},findMany:async()=>[]}}});const r=await h(req());assert.equal(r.status,503);const b=await r.text();assert.ok(!b.includes('SECRET_VALUE'));assert.ok(!b.includes('artifactCount'));});

test('authorization receives the actual request', async () => {
 const request=req(); let observed:Request|undefined;
 const h=createLegacyMemoPreflightHandler({authorized:r=>{observed=r;return false;},now:()=>new Date(),db:{receiptMemoArtifact:{count:async()=>0,findMany:async()=>[]}}});
 assert.equal((await h(request)).status,401);assert.equal(observed,request);
});
test('count drift or inconsistent listing cannot report healthy inventory',async()=>{
 for(const mode of ['drift','short','invalid']){let n=0;const h=createLegacyMemoPreflightHandler({authorized:()=>true,now:()=>new Date(),db:{receiptMemoArtifact:{count:async()=>mode==='drift'?n++:1,findMany:async()=>mode==='invalid'?[{pdfId:undefined as unknown as string,targetType:'bank-line',targetKey:'target',issueId:'issue'}]:[]}}});assert.equal((await h(req())).status,503);}
});
