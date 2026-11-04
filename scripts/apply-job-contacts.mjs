import { resolveTargetOrRefuse, verifyTargetIdentity, targetBanner } from './lib/apply-target.mjs';
import { pathToFileURL } from 'node:url';

export const statements = [
  `CREATE TABLE IF NOT EXISTS "JobContact" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "phoneE164" TEXT,
    "isOwner" BOOLEAN NOT NULL DEFAULT false,
    "isPrimaryContact" BOOLEAN NOT NULL DEFAULT false,
    "roleNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobContact_pkey" PRIMARY KEY ("id")
  )`,
  'CREATE INDEX IF NOT EXISTS "JobContact_leadId_idx" ON "JobContact"("leadId")',
  'CREATE INDEX IF NOT EXISTS "JobContact_projectId_idx" ON "JobContact"("projectId")',
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JobContact_leadId_fkey') THEN
      ALTER TABLE "JobContact" ADD CONSTRAINT "JobContact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JobContact_projectId_fkey') THEN
      ALTER TABLE "JobContact" ADD CONSTRAINT "JobContact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  'ALTER TABLE "JobContact" ENABLE ROW LEVEL SECURITY',
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

const EXPECTED_COLUMNS = {
  id: ['text', 'NO'],
  leadId: ['text', 'YES'],
  projectId: ['text', 'YES'],
  name: ['text', 'NO'],
  email: ['text', 'YES'],
  phone: ['text', 'YES'],
  phoneE164: ['text', 'YES'],
  isOwner: ['boolean', 'NO'],
  isPrimaryContact: ['boolean', 'NO'],
  roleNote: ['text', 'YES'],
  createdAt: ['timestamp without time zone', 'NO'],
  updatedAt: ['timestamp without time zone', 'NO'],
};

async function verifyColumns(tx) {
  const rows = await tx.$queryRaw`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'JobContact'
  `;
  for (const [name, [type, nullable]] of Object.entries(EXPECTED_COLUMNS)) {
    const col = rows.find((row) => row.column_name === name);
    if (!col) throw new Error('column missing');
    if (col.data_type !== type) throw new Error('column type mismatch');
    if (col.is_nullable !== nullable) throw new Error('column nullability mismatch');
  }
  const fks = await tx.$queryRaw`
    SELECT conname FROM pg_constraint
    WHERE conrelid = '"JobContact"'::regclass AND contype = 'f'
  `;
  for (const name of ['JobContact_leadId_fkey', 'JobContact_projectId_fkey']) {
    if (!fks.some((row) => row.conname === name)) throw new Error('foreign key missing');
  }
}

async function main() {
  const targeted = resolveTargetOrRefuse(process.argv);
  if (targeted.error) throw new Error('migration target refused');
  const { database, host } = validateMigrationTarget(targeted.url, process.argv.slice(2));
  console.log(targetBanner(targeted.target, { url: targeted.url, from: targeted.from, db: database, host }));
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
