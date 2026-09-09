import test from "node:test";
import assert from "node:assert/strict";
import { createQBReceiptPurchase, type CreateQBReceiptPurchaseInput, type QboReceiptPushDependencies } from "../src/lib/qbo-receipt-push";
import { createQboReceiptCreateHandlers } from "../src/app/api/integrations/qbo-receipts/create/route";
import { qboErrorFromStatus } from "../src/lib/quickbooks";
import { memoryCreateIntents } from "./fixtures/receipt-create-intents";
const tokens = {accessToken:"test",refreshToken:"test",realmId:"test-realm"};
const input = (over: Partial<CreateQBReceiptPurchaseInput> = {}): CreateQBReceiptPurchaseInput => ({
 projectName:"Christensen", vendor:"Bigfoot Construction",date:"2026-09-08",totalAmount:575,
 fileId:"different-drive-capture",groups:[{category:"Concrete",amount:575}],fileName:"receipt.png",fileContentType:"image/png",fileBase64:Buffer.from("image").toString("base64"),...over
});
function setup(rows: any[] = [], attachments: any[] = []) {
 const effects = { creates:0, uploads:0, ensures:0, reviews:[] as any[], queries:[] as string[], locks:[] as string[] };
 const deps: Partial<QboReceiptPushDependencies> = {
    createIntents: memoryCreateIntents(),
    now: () => new Date("2026-09-09T12:00:00Z"),
    withFileLock: async (key,run) => { effects.locks.push(key); return run(); },
    listProjects: async () => [{id:"p",name:"Christensen"}],
    qbQueryFn: async <T,>(_t: typeof tokens, q: string): Promise<T[]> => {
      effects.queries.push(q);
      if(q.includes("DocNumber =")) return [];
      if(/FROM attachable/i.test(q)) return attachments as T[];
      if(q.includes("FROM Account")) {
        const id = q.match(/Id = '([^']+)'/)?.[1];
        return [{Id:id, Active:true, AccountType:id==="154"?"Bank":"Cost of Goods Sold",
            AccountSubType:id==="154"?"Checking":"SuppliesMaterialsCogs",Name:id==="154"?"Washington Trust Bank":id==="98"?"Supplies & materials":"Reimbursable Sales Tax Paid"}] as T[];
      }
      const from=q.match(/TxnDate >= '([^']+)'/)?.[1], to=q.match(/TxnDate <= '([^']+)'/)?.[1];
      return rows.filter(r=> r.TxnDate >= from! && r.TxnDate <= to!) as T[];
    },
    ensureVendorFn:async()=>{effects.ensures++;return "v"},
    ensureCustomerFn:async()=>{effects.ensures++;return "c"},
    qbCreateFn:async()=>{effects.creates++;return{id:"9000"}},
    uploadAttachment:async()=>{effects.uploads++;return "attached"},
    recordDuplicateReview:async record=>{effects.reviews.push(record)},
 };
 return {deps,effects};
}
const candidate = (id="6761",date="2024-09-08") => ({Id:id,TxnDate:date,TotalAmt:575,EntityRef:{name:"Bigfoot Concrete Pumping"}});
test("different file/vendor/year is held before create, recorded, and missing image attached",async()=>{
 const {deps,effects}=setup([candidate()]);
 const r=await createQBReceiptPurchase(tokens,input(),deps);
 assert.equal(r.ok,false); if(r.ok) return;
 assert.equal(r.reason,"duplicate-purchase-review");
 assert.deepEqual((r as any).candidates.map((c:any)=>c.id),["6761"]);
 assert.equal(effects.creates,0); assert.equal(effects.ensures,0); assert.equal(effects.uploads,1);
 assert.equal(effects.reviews.length,1);
});
test("any existing attachment is retained; candidate filename need not match",async()=>{
 const {deps,effects}=setup([candidate()], [{FileName:"original.jpg",AttachableRef:[{EntityRef:{type:"Purchase",value:"6761"}}]}]);
 await createQBReceiptPurchase(tokens,input(),deps);
 assert.equal(effects.uploads,0);assert.equal(effects.creates,0);
});
test("multiple candidates never choose an attachment destination",async()=>{
 const {deps,effects}=setup([candidate(),candidate("6728","2026-09-03")]);
 await createQBReceiptPurchase(tokens,input(),deps);
 assert.equal(effects.uploads,0);assert.equal(effects.creates,0);
 assert.equal(effects.reviews[0].candidates.length,2);
});
test("dry run checks candidates but never writes, attaches, leases, or ensures",async()=>{
 for(const rows of [[candidate()],[]]) {
  const {deps,effects}=setup(rows);
  const r=await createQBReceiptPurchase(tokens,input({dryRun:true}),deps);
  assert.equal(r.ok,false);if(r.ok)continue;
  assert.equal(r.reason,"dry-run");
  assert.equal((r as any).action,rows.length?"needs-review":"would-create");
  assert.equal(effects.creates+effects.uploads+effects.ensures+effects.reviews.length+effects.locks.length,0);
 }
});
test("failed review persistence blocks the purchase and attachment",async()=>{
 const {deps,effects}=setup([candidate()]);
 deps.recordDuplicateReview=async()=>{throw new Error("review unavailable")};
 await assert.rejects(createQBReceiptPurchase(tokens,input(),deps),/review unavailable/);
 assert.equal(effects.creates+effects.uploads,0);
});
test("legacy endpoint sends 409 for duplicate review so old bot cannot fall back to email",async()=>{
 const events:any[]=[];
 const handlers=createQboReceiptCreateHandlers({
   getIngestSecret:()=>"secret",isPushEnabled:()=>true,isPushPaused:async()=>false,getFreshTokens:async()=>tokens,
   createPurchase:async()=>({ok:false,reason:"duplicate-purchase-review",candidates:[{id:"6761",date:"2024-09-08",amount:575,vendor:"Bigfoot",match:"same-month-day-other-year"}],attachment:"skipped"}),
   logEvent:async e=>{events.push(e)}
 });
 const response=await handlers.POST(new Request("http://test", {method:"POST",headers:{"x-ingest-key":"secret","content-type":"application/json"},body:JSON.stringify(input())}));
 assert.equal(response.status,409);const body=await response.json();
 assert.equal(body.reviewRequired,true); assert.equal(body.retry,false);
 assert.equal(events[0].status,"needs-review");
 assert.equal(events[0].detail.candidates[0].id,"6761");
});

test("dry-run fixtures: all four incidents are held without any business writes", async () => {
 const fixtures = [
   {name:"Bigfoot vendor drift",date:"2026-09-03",amount:575,rows:[candidate("6728","2026-09-03")],ids:["6728"]},
   {name:"Bigfoot wrong year",date:"2026-09-08",amount:575,rows:[candidate()],ids:["6761"]},
   {name:"Les Schwab manual bridge",date:"2026-08-19",amount:1974.76,rows:[
     {Id:"6555",TxnDate:"2026-07-30",TotalAmt:1974.76},
     {Id:"6608",TxnDate:"2026-08-13",TotalAmt:1974.76}],ids:["6608"]},
   {name:"BIA vendor drift",date:"2026-08-19",amount:585,rows:[{Id:"6718",TxnDate:"2026-08-19",TotalAmt:585}],ids:["6718"]},
 ];
 for (const f of fixtures) {
   const {deps,effects} = setup(f.rows);
   const result = await createQBReceiptPurchase(tokens, input({dryRun:true,date:f.date,totalAmount:f.amount,
     groups:[{category:"Receipt",amount:f.amount}]}), deps);
   assert.ok(!result.ok && result.reason === "dry-run");
   assert.equal(result.action,"needs-review",f.name);
   assert.deepEqual(result.candidates.map(c=>c.id),f.ids,f.name);
   assert.equal(effects.creates+effects.uploads+effects.ensures+effects.reviews.length+effects.locks.length,0);
   console.log(`DRY RUN ${f.name}: hold; candidates ${f.ids.join(", ")}; writes 0`);
 }
});

test("simultaneous different captures share the amount lease and only one creates", async () => {
 const rows:any[]=[];
 const {deps,effects}=setup(rows);
 const tails=new Map<string,Promise<unknown>>();
 deps.withFileLock=async(key,run)=>{
   const previous=tails.get(key)??Promise.resolve();
   const next=previous.then(run);
   tails.set(key,next.catch(()=>{}));
   return next;
 };
 deps.qbCreateFn=async(_tokens,payload)=>{
   effects.creates++;
   await new Promise(resolve=>setTimeout(resolve,15));
   rows.push({Id:"9000",TxnDate:payload.TxnDate,TotalAmt:575,PrivateNote:payload.PrivateNote});
   return{id:"9000"};
 };
 const results=await Promise.all([
   createQBReceiptPurchase(tokens,input({fileId:"capture-one"}),deps),
   createQBReceiptPurchase(tokens,input({fileId:"capture-two",vendor:"Different OCR name"}),deps),
 ]);
 assert.equal(effects.creates,1);
 assert.equal(results.filter(r=>r.ok).length,1);
 assert.equal(results.filter(r=>!r.ok&&r.reason==="duplicate-purchase-review").length,1);
});

test("dry run of an existing Drive id does not repair its attachment or mark it sent", async () => {
 const {deps,effects}=setup();
 deps.qbQueryFn=async<T,>()=>[{Id:"9000",PrivateNote:"[gtr-file:different-drive-capture]"}] as T[];
 deps.onExistingPurchase=async()=>{throw new Error("must not mark sent")};
 const result=await createQBReceiptPurchase(tokens,input({dryRun:true}),deps);
 assert.ok(!result.ok&&result.reason==="dry-run");
 assert.equal(result.action,"already-exists");
 assert.equal(effects.creates+effects.uploads+effects.ensures+effects.reviews.length+effects.locks.length,0);
});

test("failed duplicate query cannot create or attach", async () => {
 const {deps,effects}=setup();
 const query=deps.qbQueryFn!;
 deps.qbQueryFn=async(t,q)=>{if(q.includes("TxnDate >="))throw new Error("scan failed");return query(t,q)};
 await assert.rejects(createQBReceiptPurchase(tokens,input(),deps),/scan failed/);
 assert.equal(effects.creates+effects.uploads+effects.ensures,0);
});

test("legacy dry run suppresses audit writes; invalid dryRun never reaches the writer", async () => {
 for(const dryRun of [true,"true"]) {
   let logs=0,creates=0;
   const handlers=createQboReceiptCreateHandlers({getIngestSecret:()=>"secret",isPushEnabled:()=>true,
     isPushPaused:async()=>false,getFreshTokens:async()=>tokens,
     createPurchase:async(_t,value)=>{creates++;assert.equal(value.dryRun,true);return{ok:false,reason:"dry-run",action:"would-create",candidates:[]}},
     logEvent:async()=>{logs++}});
   const res=await handlers.POST(new Request("http://test",{method:"POST",headers:{"x-ingest-key":"secret"},body:JSON.stringify({...input(),dryRun})}));
   assert.equal(res.status,dryRun===true?409:400);
   assert.equal(creates,dryRun===true?1:0);assert.equal(logs,0);
 }
});

test("real legacy handler never falls back to email on duplicate-query HTTP 400", async () => {
 for (const failedQuery of ["TxnDate >=", "DocNumber ="]) {
 const {deps,effects}=setup();
 const query=deps.qbQueryFn!;
 deps.qbQueryFn=async(t,q)=>{if(q.includes(failedQuery))throw qboErrorFromStatus(400,"query refused","QB query");return query(t,q)};
 const h=createQboReceiptCreateHandlers({getIngestSecret:()=>"secret",isPushEnabled:()=>true,
   isPushPaused:async()=>false,getFreshTokens:async()=>tokens,logEvent:async()=>{},
   createPurchase:async(t,i,d)=>createQBReceiptPurchase(t,i,deps,d)});
 const res=await h.POST(new Request("http://test",{method:"POST",headers:{"x-ingest-key":"secret"},body:JSON.stringify(input())}));
 assert.equal(res.status,503);assert.equal(effects.creates+effects.uploads+effects.ensures,0);
 }
});

test("real QBO response parser cannot turn an unreadable Purchase collection into an empty scan", async () => {
 for (const body of [{}, {QueryResponse:{Purchase:{Id:"6761"}}}, {QueryResponse:{maxResults:1}}, {QueryResponse:{Bill:[]}},
   {QueryResponse:{Purchase:[],maxResults:1}}, {QueryResponse:{Purchase:[],totalCount:1}},
   {QueryResponse:{Purchase:[{Id:"1",TotalAmt:1,TxnDate:"2026-09-08"}],maxResults:1,startPosition:1,totalCount:2}}]) {
   const {deps,effects}=setup();
   delete deps.qbQueryFn; // Exercise production qbQuery and its actual HTTP parser.
   const previous=globalThis.fetch;
   globalThis.fetch=async(url)=>new Response(JSON.stringify(decodeURIComponent(String(url)).includes("DocNumber =")?{QueryResponse:{}}:body),{status:200});
   try { await assert.rejects(createQBReceiptPurchase(tokens,input(),deps)); }
   finally { globalThis.fetch=previous; }
   assert.equal(effects.creates+effects.uploads+effects.ensures,0);
 }
});

test("lost create response leaves a durable hold for other captures, but same-file retries recover", async () => {
 const {deps,effects}=setup();
 let sends=0;
 const ids:string[]=[];
 deps.qbCreateFn=async(_t,_p,requestId)=>{
   sends++;ids.push(requestId);
   if(sends===1)throw new Error("response lost after possible commit");
   return{id:"9000"};
 };
 await assert.rejects(createQBReceiptPurchase(tokens,input({fileId:"capture-A"}),deps),/response lost/);
 const held=await createQBReceiptPurchase(tokens,input({fileId:"capture-B",vendor:"Other OCR"}),deps);
 assert.ok(!held.ok&&held.reason==="duplicate-create-pending");
 assert.deepEqual(held.pendingFileIds,["capture-A"]);
 assert.equal(sends,1);assert.equal(effects.uploads,0);
 assert.equal((await deps.createIntents!.list(tokens.realmId)).length,1);
 const dry=await createQBReceiptPurchase(tokens,input({fileId:"capture-C",dryRun:true}),deps);
 assert.ok(!dry.ok&&dry.reason==="dry-run"&&dry.action==="needs-review");
 assert.deepEqual(dry.pendingFileIds,["capture-A"]);
 const recovered=await createQBReceiptPurchase(tokens,input({fileId:"capture-A"}),deps);
 assert.equal(recovered.ok,true);assert.equal(sends,2);
 assert.equal(ids[0],ids[1],"same-file replay retains QBO request id");
 assert.deepEqual(await deps.createIntents!.list(tokens.realmId),[]);
});

test("unrelated dates remain usable and cannot overwrite an unresolved earlier intent", async () => {
 const {deps}=setup();
 await deps.createIntents!.put(tokens.realmId,{fileId:"old-capture",date:"2026-06-01",amountCents:57500});
 assert.equal((await createQBReceiptPurchase(tokens,input(),deps)).ok,true);
 assert.deepEqual((await deps.createIntents!.list(tokens.realmId)).map(p=>p.fileId),["old-capture"]);
 const held=await createQBReceiptPurchase(tokens,input({fileId:"another-capture",date:"2024-06-01"}),deps);
 assert.ok(!held.ok&&held.reason==="duplicate-create-pending");
});

test("known create refusal and failed ownership fence clear intent; unknown failures retain it", async () => {
 for (const failure of ["refused","fence","timeout"] as const) {
   const {deps}=setup();
   let sends=0;
   deps.qbCreateFn=async()=>{sends++;throw failure==="refused"?qboErrorFromStatus(400,"refused","QB create"):new Error("timeout")};
   if(failure==="fence")deps.onBeforeCreate=async()=>{throw new Error("lost ownership")};
   await assert.rejects(createQBReceiptPurchase(tokens,input(),deps));
   assert.equal((await deps.createIntents!.list(tokens.realmId)).length,failure==="timeout"?1:0);
   assert.equal(sends,failure==="fence"?0:1);
 }
});

test("pending-create legacy response is a review hold, never an email fallback", async () => {
 const {deps,effects}=setup();
 await deps.createIntents!.put(tokens.realmId,{fileId:"capture-A",date:"2024-09-08",amountCents:57500});
 const h=createQboReceiptCreateHandlers({getIngestSecret:()=>"secret",isPushEnabled:()=>true,isPushPaused:async()=>false,
   getFreshTokens:async()=>tokens,logEvent:async()=>{},createPurchase:async(t,i,d)=>createQBReceiptPurchase(t,i,deps,d)});
 const res=await h.POST(new Request("http://test",{method:"POST",headers:{"x-ingest-key":"secret"},body:JSON.stringify(input())}));
 assert.equal(res.status,409);const body=await res.json();
 assert.equal(body.reviewRequired,true);assert.deepEqual(body.pendingFileIds,["capture-A"]);
 assert.equal(effects.creates+effects.uploads+effects.ensures,0);
});

test("a retry fence failure or refusal cannot erase an earlier unknown create", async () => {
 for(const failure of ["fence","refused"]) {
   const {deps}=setup();
   await deps.createIntents!.put(tokens.realmId,{fileId:input().fileId,date:"2026-09-08",amountCents:57500});
   if(failure==="fence")deps.onBeforeCreate=async()=>{throw new Error("stale retry")};
   deps.qbCreateFn=async()=>{throw qboErrorFromStatus(400,"retry refused","QB create")};
   await assert.rejects(createQBReceiptPurchase(tokens,input(),deps));
   const held=await createQBReceiptPurchase(tokens,input({fileId:"another-capture"}),deps);
   assert.ok(!held.ok&&held.reason==="duplicate-create-pending");
   assert.equal((await deps.createIntents!.list(tokens.realmId)).length,1);
 }
});

test("changed OCR on the original source cannot overwrite an unresolved amount/date", async () => {
 const {deps,effects}=setup();
 const original={fileId:input().fileId,date:"2024-09-08",amountCents:57500};
 await deps.createIntents!.put(tokens.realmId,original);
 const result=await createQBReceiptPurchase(tokens,input(),deps);
 assert.ok(!result.ok&&result.reason==="duplicate-create-pending");
 assert.deepEqual(await deps.createIntents!.list(tokens.realmId),[original]);
 assert.equal(effects.creates+effects.uploads+effects.ensures,0);
});

test("unreadable attachment response parks with an unconfirmed image, without uploading", async () => {
 const {deps,effects}=setup();delete deps.qbQueryFn;
 const previous=globalThis.fetch;
 globalThis.fetch=async url=>{
   const sql=decodeURIComponent(String(url));
   if(/FROM attachable/i.test(sql))return new Response(JSON.stringify({QueryResponse:{Attachable:{Id:"1"}}}));
   const from=sql.match(/TxnDate >= '([^']+)'/)?.[1],to=sql.match(/TxnDate <= '([^']+)'/)?.[1];
   const rows=from&&to&&candidate().TxnDate>=from&&candidate().TxnDate<=to?[candidate()]:[];
   return new Response(JSON.stringify({QueryResponse:{Purchase:rows}}));
 };
 try {
   const result=await createQBReceiptPurchase(tokens,input(),deps);
   assert.ok(!result.ok&&result.reason==="duplicate-purchase-review");
   assert.equal(result.attachment,"failed:attachment-unconfirmed");
 } finally {globalThis.fetch=previous}
 assert.equal(effects.uploads,0);assert.equal(effects.reviews.length,1);
});

test("a full attachment page without a Purchase link is incomplete, not proof of no image", async () => {
 const {deps,effects}=setup([candidate()],Array.from({length:100},()=>({AttachableRef:[{EntityRef:{type:"Bill",value:"6761"}}]})));
 const result=await createQBReceiptPurchase(tokens,input(),deps);
 assert.ok(!result.ok&&result.reason==="duplicate-purchase-review");
 assert.equal(result.attachment,"failed:attachment-lookup-incomplete");assert.equal(effects.uploads,0);
});

test("a same-source retry refusal returns a non-email response while its original create is unknown", async () => {
 const {deps}=setup();
 await deps.createIntents!.put(tokens.realmId,{fileId:input().fileId,date:"2026-09-08",amountCents:57500});
 deps.qbCreateFn=async()=>{throw qboErrorFromStatus(400,"retry refused","QB create")};
 const h=createQboReceiptCreateHandlers({getIngestSecret:()=>"secret",isPushEnabled:()=>true,isPushPaused:async()=>false,
   getFreshTokens:async()=>tokens,logEvent:async()=>{},createPurchase:async(t,i,d)=>createQBReceiptPurchase(t,i,deps,d)});
 const res=await h.POST(new Request("http://test",{method:"POST",headers:{"x-ingest-key":"secret"},body:JSON.stringify(input())}));
 assert.equal(res.status,503);
 assert.equal((await deps.createIntents!.list(tokens.realmId)).length,1);
});

test("unreadable attachment rows cannot prove a candidate has no image", async () => {
 for (const row of [null, {}, {AttachableRef:[]}, {AttachableRef:[null]},
   {AttachableRef:[{EntityRef:{value:"6761"}}]}, {AttachableRef:[{EntityRef:{type:"Purchase"}}]}]) {
   const {deps,effects}=setup([candidate()],[row] as any);
   const result=await createQBReceiptPurchase(tokens,input(),deps);
   assert.ok(!result.ok&&result.reason==="duplicate-purchase-review");
   assert.equal(result.attachment,"failed:attachment-unconfirmed");
   assert.equal(effects.uploads,0);
 }
});

test("visible candidates never receive an attachment while a matching create is unresolved", async () => {
 for (const fileId of ["capture-A", input().fileId]) {
   const {deps,effects}=setup([candidate()]);
   const pending={fileId,date:"2026-09-08",amountCents:57500};
   await deps.createIntents!.put(tokens.realmId,pending);
   const result=await createQBReceiptPurchase(tokens,input(),deps);
   assert.equal(effects.uploads,0,"an unresolved create makes the visible candidate an unsafe attachment destination");
   assert.ok(!result.ok&&result.reason==="duplicate-create-pending");
   assert.deepEqual(result.pendingFileIds,[fileId]);
   assert.deepEqual((result as any).candidates.map((c:any)=>c.id),["6761"]);
   assert.deepEqual(effects.reviews[0].pendingFileIds,[fileId]);
   assert.deepEqual(effects.reviews[0].candidates.map((c:any)=>c.id),["6761"]);
   assert.deepEqual(await deps.createIntents!.list(tokens.realmId),[pending]);
   assert.equal(effects.creates+effects.ensures,0);
   assert.equal(effects.queries.some(q=>/FROM attachable/i.test(q)),false);
 }
});

test("mixed duplicate dry run preserves visible and pending evidence without writes", async () => {
 for (const fileId of ["capture-A",input().fileId]) {
   const {deps,effects}=setup([candidate()]);
   await deps.createIntents!.put(tokens.realmId,{fileId,date:"2026-09-08",amountCents:57500});
   const result=await createQBReceiptPurchase(tokens,input({dryRun:true}),deps);
   assert.ok(!result.ok&&result.reason==="dry-run"&&result.action==="needs-review");
   assert.deepEqual(result.pendingFileIds,[fileId]);
   assert.deepEqual(result.candidates.map(c=>c.id),["6761"]);
   assert.equal(effects.creates+effects.uploads+effects.ensures+effects.reviews.length+effects.locks.length,0);
   assert.equal((await deps.createIntents!.list(tokens.realmId)).length,1);
 }
});

test("legacy mixed duplicate hold and audit retain both QBO and unresolved source ids", async () => {
 const {deps,effects}=setup([candidate()]);
 await deps.createIntents!.put(tokens.realmId,{fileId:"capture-A",date:"2026-09-08",amountCents:57500});
 const events:any[]=[];
 const h=createQboReceiptCreateHandlers({getIngestSecret:()=>"secret",isPushEnabled:()=>true,isPushPaused:async()=>false,
   getFreshTokens:async()=>tokens,logEvent:async e=>{events.push(e)},createPurchase:async(t,i,d)=>createQBReceiptPurchase(t,i,deps,d)});
 const res=await h.POST(new Request("http://test",{method:"POST",headers:{"x-ingest-key":"secret"},body:JSON.stringify(input())}));
 assert.equal(res.status,409);const body=await res.json();
 assert.equal(body.reviewRequired,true);assert.equal(body.retry,false);
 assert.deepEqual(body.pendingFileIds,["capture-A"]);
 assert.deepEqual(body.candidates.map((c:any)=>c.id),["6761"]);
 assert.deepEqual(events[0].detail.pendingFileIds,["capture-A"]);
 assert.deepEqual(events[0].detail.candidates.map((c:any)=>c.id),["6761"]);
 assert.equal(effects.creates+effects.uploads+effects.ensures,0);
});

test("an unreadable intent store cannot be skipped merely because a candidate is visible", async () => {
 const {deps,effects}=setup([candidate()]);
 deps.createIntents!.list=async()=>{throw new Error("intent evidence unavailable")};
 await assert.rejects(createQBReceiptPurchase(tokens,input(),deps),/intent evidence unavailable/);
 assert.equal(effects.creates+effects.uploads+effects.ensures+effects.reviews.length,0);
});

test("an unrelated pending create does not prevent attaching to a sole visible candidate", async () => {
 const {deps,effects}=setup([candidate()]);
 const pending={fileId:"unrelated-source",date:"2026-06-01",amountCents:57500};
 await deps.createIntents!.put(tokens.realmId,pending);
 const result=await createQBReceiptPurchase(tokens,input(),deps);
 assert.ok(!result.ok&&result.reason==="duplicate-purchase-review");
 assert.equal(result.attachment,"attached");assert.equal(effects.uploads,1);assert.equal(effects.creates,0);
 assert.deepEqual(await deps.createIntents!.list(tokens.realmId),[pending]);
});

test("mixed review audit keeps every candidate and pending id through the real serializer", async () => {
 for (const [candidateCount,pendingCount] of [[40,1],[100,80]]) {
   const rows=Array.from({length:candidateCount},(_,i)=>candidate(String(800000000+i)));
   const {deps,effects}=setup(rows);
   const pendingIds=Array.from({length:pendingCount},(_,i)=>`pending-source-${i.toString().padStart(3,"0")}-${"x".repeat(30)}`);
   for (const fileId of pendingIds) await deps.createIntents!.put(tokens.realmId,{fileId,date:"2026-09-08",amountCents:57500});
   delete deps.recordDuplicateReview;
   const saved:any[]=[];
   const original=(globalThis as any).prisma;
   (globalThis as any).prisma={automationEvent:{create:async(args:any)=>{saved.push(args.data);return args.data}}};
   try { await createQBReceiptPurchase(tokens,input(),deps); }
   finally { (globalThis as any).prisma=original; }
   const details=saved.map(event=>JSON.parse(event.detail));
   const persistedCandidates=details.flatMap(d=>d.candidateIds??(Array.isArray(d.candidates)?d.candidates.map((c:any)=>c.id):[]));
   const persistedPending=details.flatMap(d=>Array.isArray(d.pendingFileIds)?d.pendingFileIds:[]);
   assert.deepEqual(persistedCandidates,rows.map(r=>r.Id),"every candidate id must remain structured and recoverable");
   assert.deepEqual(persistedPending,pendingIds,"every pending source id must remain recoverable");
   assert.equal(new Set(details.map(d=>d.reviewId)).size,1);
   assert.ok(details[0].reviewId);
   assert.deepEqual(details.map(d=>d.chunkIndex),details.map((_d:any,i:number)=>i+1));
   assert.ok(details.every(d=>d.chunkCount===details.length&&d.candidateCount===candidateCount&&d.pendingCount===pendingCount));
   assert.ok(saved.every(event=>event.detail.length<=4000));
   assert.equal(effects.creates+effects.uploads+effects.ensures,0);
 }
});

test("failure to persist a later evidence chunk prevents the review response", async () => {
 const {deps,effects}=setup([candidate()]);
 for(let i=0;i<100;i++)await deps.createIntents!.put(tokens.realmId,{fileId:`source-${i}-${"x".repeat(40)}`,date:"2026-09-08",amountCents:57500});
 delete deps.recordDuplicateReview;
 let writes=0;
 const original=(globalThis as any).prisma;
 (globalThis as any).prisma={automationEvent:{create:async(args:any)=>{
   if(++writes===2)throw new Error("second chunk unavailable");
   return args.data;
 }}};
 try { await assert.rejects(createQBReceiptPurchase(tokens,input(),deps),/second chunk unavailable/); }
 finally { (globalThis as any).prisma=original; }
 assert.equal(writes,2);
 assert.equal(effects.creates+effects.uploads+effects.ensures,0);
});
