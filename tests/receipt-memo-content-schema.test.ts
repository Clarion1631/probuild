import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMigrationTarget, statements } from '../scripts/apply-receipt-memo-content.mjs';
test('schema migration requires explicit expected URL host/db and yes',()=>{const url='postgresql://test:test@db.example.test:6543/example?pgbouncer=true';assert.throws(()=>validateMigrationTarget(url,[]));assert.throws(()=>validateMigrationTarget(url,['--target','ci','--yes','--expect-db','example','--expect-host','wrong.example.test']));assert.doesNotThrow(()=>validateMigrationTarget(url,['--target','ci','--yes','--expect-db','example','--expect-host','db.example.test']));});
test('DDL is additive and uniquely fences nullable content hash',()=>{const sql=statements.join('\n');assert.match(sql,/ADD COLUMN IF NOT EXISTS "pdfSha256" TEXT/);assert.match(sql,/ADD COLUMN IF NOT EXISTS "provenanceJson" TEXT/);assert.match(sql,/CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptMemoArtifact_pdfSha256_key"/);assert.doesNotMatch(sql,/DROP|DELETE FROM|UPDATE "Expense"|ALTER COLUMN/i);});

test('hash CHECK constraint is recorded in the migration blind-spot inventory', async () => {
 const { readFileSync } = await import('node:fs');
 const snapshot=JSON.parse(readFileSync(new URL('../prisma/prisma-blind-spots.json', import.meta.url),'utf8'));
 const entries=snapshot.checkConstraints.filter((r:{name:string})=>r.name==='ReceiptMemoArtifact_pdfSha256_hex_check');
 assert.equal(entries.length,1,'migration adds a CHECK Prisma cannot introspect; inventory must preserve it');
 assert.equal(entries[0].table,'"ReceiptMemoArtifact"');
 assert.equal(entries[0].def, `CHECK ((("pdfSha256" IS NULL) OR ("pdfSha256" ~ '^[0-9a-f]{64}$'::text)))`);
});
