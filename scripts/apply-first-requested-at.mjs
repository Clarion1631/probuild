// PaymentSchedule.firstRequestedAt: the FIRST time a payment request was
// emailed for a milestone, set once and never moved by a resend.
// qbInvoiceSentAt keeps meaning the LAST send; a resend moving it forward was
// making a resent milestone look freshly billed to AR aging and pushing a
// paid milestone past the bank-deposit chronology bound.
//
// ADD COLUMN IF NOT EXISTS + a NULL-only backfill. Idempotent, safe to re-run,
// safe while the previous build is live (a column the old build does not
// select is not an error). Run BEFORE the build that selects it deploys, per
// docs/DB-MIGRATE-WORKFLOW.md.
//
//   APPLY_EXPECT_PROJECT_REF=<prod ref> node scripts/apply-first-requested-at.mjs --target prod --yes --expect-db <db> --expect-host <host>
//
// The identical DDL is checked in at
// prisma/migrations/20260923120000_first_requested_at/migration.sql, which is
// what CI's throwaway database is built from. After CI is green, record it in
// prod's history: `prisma migrate resolve --applied 20260923120000_first_requested_at`
// (over the session pooler — see the probuild-schema-migration skill).
import { resolveTargetOrRefuse, verifyTargetIdentity } from './lib/apply-target.mjs';
import { pathToFileURL } from 'node:url';

export const statements = [
  'ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "firstRequestedAt" TIMESTAMP(3)',
  'UPDATE "PaymentSchedule" SET "firstRequestedAt" = "qbInvoiceSentAt" WHERE "firstRequestedAt" IS NULL AND "qbInvoiceSentAt" IS NOT NULL',
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

async function verifyColumn(tx) {
  const rows = await tx.$queryRaw`
    SELECT data_type, is_nullable, datetime_precision
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'PaymentSchedule'
      AND column_name = 'firstRequestedAt'
  `;
  if (rows.length !== 1) throw new Error('column missing');
  const col = rows[0];
  if (col.data_type !== 'timestamp without time zone') throw new Error('column type mismatch');
  if (col.is_nullable !== 'YES') throw new Error('column nullability mismatch');
  if (Number(col.datetime_precision) !== 3) throw new Error('column precision mismatch');
}

async function verifyBackfill(tx) {
  const rows = await tx.$queryRaw`
    SELECT count(*)::int AS n
    FROM "PaymentSchedule"
    WHERE "firstRequestedAt" IS NULL AND "qbInvoiceSentAt" IS NOT NULL
  `;
  const n = rows[0] ? rows[0].n : null;
  if (n !== 0) throw new Error('backfill incomplete');
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
        await verifyColumn(tx);
        await verifyBackfill(tx);
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
