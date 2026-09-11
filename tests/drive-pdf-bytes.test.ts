import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyBoundedPdf } from '../src/lib/drive-pdf-bytes';
const bytes=Buffer.from('%PDF-1.7\nfictional isolated byte fixture\n%%EOF');
function deps(overrides: Record<string,unknown>={}) { return {
 metadata: async () => ({id:'fictional_pdf_12345',mimeType:'application/pdf',trashed:false,version:'1',size:String(bytes.length)}),
 chunks: async function*(){yield bytes.subarray(0,9);yield bytes.subarray(9);}, ...overrides,
}; }
test('hashes exact bytes across chunks',async()=>{const r=await verifyBoundedPdf('fictional_pdf_12345',deps());assert.equal(r.kind,'verified');if(r.kind==='verified'){assert.equal(r.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(r.byteLength,bytes.length);}});
test('does not download missing, trashed, wrong MIME or oversized metadata',async()=>{for(const patch of [{trashed:true},{mimeType:'text/plain'},{size:'9000000'},{id:'different'}]) {let reads=0;const d=deps();const r=await verifyBoundedPdf('fictional_pdf_12345',{...d,metadata:async()=>({...await d.metadata(),...patch}),chunks:async function*(){reads++;yield bytes;}});assert.equal(r.kind,'unavailable');assert.equal(reads,0);}});
test('rejects truncated bytes',async()=>{assert.equal((await verifyBoundedPdf('fictional_pdf_12345',deps({chunks:async function*(){yield bytes.subarray(0,10);}}))).kind,'unavailable');});
test('rejects a non-PDF even with PDF metadata',async()=>{assert.equal((await verifyBoundedPdf('fictional_pdf_12345',deps({chunks:async function*(){yield Buffer.alloc(bytes.length,65);}}))).kind,'unavailable');});
test('rejects version change across download',async()=>{let n=0;const d=deps();assert.equal((await verifyBoundedPdf('fictional_pdf_12345',{...d,metadata:async()=>({...await d.metadata(),version:String(++n)})})).kind,'unavailable');});
test('bounds streamed bytes even when declared length lies',async()=>{let ended=false;const d=deps({chunks:async function*(){try{yield Buffer.alloc(8*1024*1024+1);}finally{ended=true;}}});assert.equal((await verifyBoundedPdf('fictional_pdf_12345',d)).kind,'unavailable');assert.equal(ended,true);});
test('provider failure is unavailable and does not expose secrets',async()=>{const r=await verifyBoundedPdf('fictional_pdf_12345',deps({metadata:async()=>{throw Error('token SECRET_VALUE');}}));assert.equal(r.kind,'unavailable');assert.ok(!JSON.stringify(r).includes('SECRET_VALUE'));});
