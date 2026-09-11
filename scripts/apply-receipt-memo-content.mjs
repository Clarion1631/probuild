import { resolveTargetOrRefuse, verifyTargetIdentity } from './lib/apply-target.mjs';
import { pathToFileURL } from 'node:url';

export const statements = [
  'ALTER TABLE "ReceiptMemoArtifact" ADD COLUMN IF NOT EXISTS "pdfSha256" TEXT',
  'ALTER TABLE "ReceiptMemoArtifact" ADD COLUMN IF NOT EXISTS "provenanceJson" TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptMemoArtifact_pdfSha256_key" ON "ReceiptMemoArtifact" ("pdfSha256")',
  `DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ReceiptMemoArtifact_pdfSha256_hex_check' AND conrelid='"ReceiptMemoArtifact"'::regclass) THEN
 ALTER TABLE "ReceiptMemoArtifact" ADD CONSTRAINT "ReceiptMemoArtifact_pdfSha256_hex_check" CHECK ("pdfSha256" IS NULL OR "pdfSha256" ~ '^[0-9a-f]{64}$');
 END IF;
END $$`,
];

const REQUIRED_FLAGS = ['--target', '--yes', '--expect-db', '--expect-host'];
const VALUE_FLAGS = ['--target', '--expect-db', '--expect-host'];

function parseArgs(args) {
  if (!Array.isArray(args)) throw new Error('invalid arguments');
  const seen = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (!REQUIRED_FLAGS.includes(flag)) throw new Error('unexpected argument');
    if (seen.has(flag)) throw new Error('duplicate argument');
    if (VALUE_FLAGS.includes(flag)) {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error('missing argument value');
      }
      seen.set(flag, value);
      i += 1;
    } else {
      seen.set(flag, true);
    }
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!seen.has(flag)) throw new Error('missing required argument');
  }
  if (!['prod','ci'].includes(seen.get('--target'))) throw new Error('invalid target');
  return {
    expectedDb: seen.get('--expect-db'),
    expectedHost: seen.get('--expect-host'),
  };
}

export function validateMigrationTarget(databaseUrl, args) {
  const { expectedDb, expectedHost } = parseArgs(args);
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    throw new Error('database url not set');
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('database url invalid');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('database url protocol mismatch');
  }
  if (parsed.hostname !== expectedHost) throw new Error('database host mismatch');
  const rawDb = parsed.pathname.replace(/^\//, '');
  let database;
  try {
    database = decodeURIComponent(rawDb);
  } catch {
    throw new Error('database name invalid');
  }
  if (database.length === 0 || database !== expectedDb) throw new Error('database name mismatch');
  if (parsed.searchParams.get('pgbouncer') !== 'true') throw new Error('pgbouncer required');
  return { database, host: parsed.hostname };
}

const SET_LOCAL_LOCK_TIMEOUT = 'SET LOCAL lock_timeout = 5000';
const SET_LOCAL_STATEMENT_TIMEOUT = 'SET LOCAL statement_timeout = 15000';
const TRANSACTION_TIMEOUT_MS = 30000;

async function verifyColumns(tx) {
  const rows = await tx.$queryRaw`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ReceiptMemoArtifact'
      AND column_name IN ('pdfSha256', 'provenanceJson')
  `;
  const byName = new Map(rows.map((r) => [r.column_name, r]));
  for (const name of ['pdfSha256', 'provenanceJson']) {
    const col = byName.get(name);
    if (!col) throw new Error('column missing');
    if (col.data_type !== 'text') throw new Error('column type mismatch');
    if (col.is_nullable !== 'YES') throw new Error('column nullability mismatch');
  }
}

async function verifyUniqueIndex(tx) {
  const rows = await tx.$queryRaw`
    SELECT i.indisunique, i.indisvalid, i.indisready,
           i.indpred IS NULL AS unfiltered, i.indexprs IS NULL AS plain,
           i.indnkeyatts, i.indnatts, a.attname
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_namespace n ON n.oid=tab.relnamespace
    JOIN pg_attribute a ON a.attrelid=tab.oid AND a.attnum=i.indkey[0]
    WHERE n.nspname=current_schema() AND tab.relname='ReceiptMemoArtifact'
      AND idx.relname='ReceiptMemoArtifact_pdfSha256_key'`;
  const row=rows[0];
  if(rows.length!==1 || !row.indisunique || !row.indisvalid || !row.indisready
    || !row.unfiltered || !row.plain || row.indnkeyatts!==1 || row.indnatts!==1
    || row.attname!=='pdfSha256') throw new Error('content unique index verification failed');
}

async function main() {
  const targeted = resolveTargetOrRefuse(process.argv);
  if (targeted.error) throw new Error('migration target refused');
  const { database } = validateMigrationTarget(targeted.url, process.argv.slice(2));
  const expected = parseArgs(process.argv.slice(2));
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: targeted.url } } });
  try {
    await prisma.$connect();
    const identity = await verifyTargetIdentity(prisma, { ...targeted, expectDb: expected.expectedDb, expectHost: expected.expectedHost });
    if (!identity.ok) throw new Error("migration target identity refused");
    await prisma.$transaction(
      async (tx) => {
        const current = await tx.$queryRaw`SELECT current_database() AS db`;
        if (!current[0] || current[0].db !== database) throw new Error('current database mismatch');
        await tx.$executeRawUnsafe(SET_LOCAL_LOCK_TIMEOUT);
        await tx.$executeRawUnsafe(SET_LOCAL_STATEMENT_TIMEOUT);
        for (const sql of statements) {
          await tx.$executeRawUnsafe(sql);
        }
        await verifyUniqueIndex(tx);
        await verifyColumns(tx);
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
    );
    console.log('migration applied');
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch(() => {
    console.error('migration failed');
    process.exitCode = 1;
  });
}