import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
const url=process.env.RECEIPT_MEMO_TEST_DATABASE_URL;
if(url){const parsed=new URL(url);if(!['localhost','127.0.0.1'].includes(parsed.hostname)||parsed.pathname!=='/probuild_migrations')throw Error('Receipt memo DB tests require the isolated CI database');}
const options={skip:!url};
test('real Postgres enforces cross-file content uniqueness with full transaction rollback',options,async()=>{
 const db=new PrismaClient({datasources:{db:{url}}});const prefix='isolated-memo-content-'+Date.now();
 try{await assert.rejects(db.$transaction(async tx=>{await tx.receiptMemoArtifact.create({data:{pdfId:prefix+'-a',pdfSha256:'d'.repeat(64),targetType:'test-only',targetKey:prefix+'-1',issueId:prefix}});await tx.receiptMemoArtifact.create({data:{pdfId:prefix+'-b',pdfSha256:'d'.repeat(64),targetType:'test-only',targetKey:prefix+'-2',issueId:prefix}});}), (error:unknown)=>(error as {code?:string}).code==='P2002');assert.equal(await db.receiptMemoArtifact.count({where:{pdfId:{startsWith:prefix}}}),0);}finally{await db.$disconnect();}
});
test('real Postgres accepts nullable legacy hashes without inventing content verification',options,async()=>{
 const db=new PrismaClient({datasources:{db:{url}}});const prefix='isolated-memo-null-'+Date.now();const rollback=new Error('isolated rollback');
 try{await assert.rejects(db.$transaction(async tx=>{for(const n of [1,2])await tx.receiptMemoArtifact.create({data:{pdfId:prefix+n,targetType:'test-only',targetKey:prefix+n,issueId:prefix}});assert.equal(await tx.receiptMemoArtifact.count({where:{pdfId:{startsWith:prefix},pdfSha256:null}}),2);throw rollback;}),error=>error===rollback);assert.equal(await db.receiptMemoArtifact.count({where:{pdfId:{startsWith:prefix}}}),0);}finally{await db.$disconnect();}
});
