import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadPinnedRecoveryPacket,createLegacyRecoveryHandler} from '../src/lib/legacy-affidavit-recovery-handler';
import {fixture} from './fixtures/legacy-recovery-fixture';
const request=(body:unknown)=>new Request('https://example.test/api/integrations/bank-ledger/legacy-affidavit-recovery',{method:'POST',body:JSON.stringify(body)});
test('packet requires independently pinned raw bytes and preserves verbatim reply',()=>{const {packet}=fixture();const raw=JSON.stringify(packet);const result=loadPinnedRecoveryPacket({LEGACY_AFFIDAVIT_RECOVERY_PACKET_BASE64:Buffer.from(raw).toString('base64'),LEGACY_AFFIDAVIT_RECOVERY_PACKET_SHA256:createHash('sha256').update(raw).digest('hex')});assert.deepEqual(result.packet,packet);assert.throws(()=>loadPinnedRecoveryPacket({LEGACY_AFFIDAVIT_RECOVERY_PACKET_BASE64:Buffer.from(raw).toString('base64'),LEGACY_AFFIDAVIT_RECOVERY_PACKET_SHA256:'b'.repeat(64)}));});
test('missing config does not infer authority from caller JSON',()=>{assert.throws(()=>loadPinnedRecoveryPacket({}));});
test('auth blocks before body/handler, flag blocks apply only, extra packet body rejected',async()=>{let calls=0;const base={authorized:()=>true,enabled:()=>false,handle:async()=>{calls++;return{ok:true,status:'ready' as const};}};const pkt=fixture().packet;
 assert.equal((await createLegacyRecoveryHandler({...base,authorized:()=>false})(request({mode:'prepare',bankLineId:pkt.target.bankLineId}))).status,401);
 assert.equal((await createLegacyRecoveryHandler(base)(request({mode:'apply',bankLineId:pkt.target.bankLineId,planDigest:'a'.repeat(64)}))).status,409);
 assert.equal((await createLegacyRecoveryHandler(base)(request({mode:'prepare',bankLineId:pkt.target.bankLineId,packet:pkt}))).status,400);
 assert.equal(calls,0);assert.equal((await createLegacyRecoveryHandler(base)(request({mode:'prepare',bankLineId:pkt.target.bankLineId}))).status,200);assert.equal(calls,1);
});
test('errors remain unavailable without raw private messages',async()=>{const h=createLegacyRecoveryHandler({authorized:()=>true,enabled:()=>true,handle:async()=>{throw Error('SECRET_VALUE');}});const r=await h(request({mode:'prepare',bankLineId:fixture().packet.target.bankLineId}));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('SECRET_VALUE'));});

test('prepare retains the exact reviewable plan digest and bounded diagnostics',async()=>{
 const h=createLegacyRecoveryHandler({authorized:()=>true,enabled:()=>false,handle:async()=>({ok:true,status:'ready',planDigest:'a'.repeat(64),capturedAt:'2026-09-10T00:00:00Z'})});const b=await(await h(request({mode:'prepare',bankLineId:fixture().packet.target.bankLineId}))).json();assert.equal(b.planDigest,'a'.repeat(64));assert.equal(b.capturedAt,'2026-09-10T00:00:00Z');
});
