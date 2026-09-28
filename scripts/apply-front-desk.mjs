import { resolveTargetOrRefuse, verifyTargetIdentity } from './lib/apply-target.mjs';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

// Front Desk v1 (PB-frontdesk-001). Additive DDL only — see
// prisma/migrations/20260928120000_front_desk_v1/migration.sql, which this
// script executes verbatim. Run manually against a target before deploying;
// see the probuild-schema-migration and deploy-probuild skills.
//
//   node scripts/apply-front-desk.mjs --target ci   --yes --expect-db <db> --expect-host <host>
//   node scripts/apply-front-desk.mjs --target prod --yes --expect-db postgres --expect-host <pooler host>
//
// Deliberately NOT run against production by this PR (hard rule: never apply
// migrations to prod) — this file exists so Justin can run it later (J3), per
// the deploy-probuild skill. Same guard shape as scripts/apply-speed-to-lead.mjs:
// target/identity checks, a single transaction, lock/statement timeouts, and a
// verifyShape that inspects information_schema rather than trusting the run.

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
  if (!['prod', 'ci'].includes(seen.get('--target'))) throw new Error('invalid target');
  return {
    expectedDb: seen.get('--expect-db'),
    expectedHost: seen.get('--expect-host'),
  };
}

function validateMigrationTarget(databaseUrl, args) {
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
const SET_LOCAL_STATEMENT_TIMEOUT = 'SET LOCAL statement_timeout = 30000';
const TRANSACTION_TIMEOUT_MS = 60000;

const NEW_TABLES = ['FrontDeskCall', 'FrontDeskBooking', 'FrontDeskTransfer'];
const NEW_COMPANY_SETTINGS_COLUMNS = [
  'frontDeskTakingTransfers', 'frontDeskTakingTransfersBy', 'frontDeskTakingTransfersAt',
  'frontDeskCalendlyTokenEnc', 'frontDeskCalendlyTokenSetBy', 'frontDeskCalendlyTokenSetAt',
  'frontDeskCalendlyUserUri', 'frontDeskCalendlyPlan', 'frontDeskCalendlyEventTypeUri',
  'frontDeskCalendlyTestEventTypeUri', 'frontDeskCalendlyAuthFailedAt',
];
const NEW_PARTIAL_INDEXES = [
  'FrontDeskBooking_one_active_per_call_key',
  'FrontDeskBooking_one_active_per_slot_key',
  'FrontDeskTransfer_one_active_key',
];

async function verifyShape(tx) {
  const tables = await tx.$queryRaw`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ANY(${NEW_TABLES})`;
  if (tables.length !== NEW_TABLES.length) throw new Error('one or more Front Desk tables are missing');

  const settingsCols = await tx.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'CompanySettings' AND column_name = ANY(${NEW_COMPANY_SETTINGS_COLUMNS})`;
  if (settingsCols.length !== NEW_COMPANY_SETTINGS_COLUMNS.length) throw new Error('CompanySettings front-desk columns are missing');

  const indexes = await tx.$queryRaw`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = ANY(${NEW_PARTIAL_INDEXES})`;
  if (indexes.length !== NEW_PARTIAL_INDEXES.length) throw new Error('one or more partial unique indexes are missing');

  const enumValues = await tx.$queryRaw`
    SELECT e.enumlabel FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'LeadIntakeSource' AND e.enumlabel = 'FRONT_DESK_CALL'`;
  if (enumValues.length !== 1) throw new Error('LeadIntakeSource is missing FRONT_DESK_CALL');

  const alertEnumValues = await tx.$queryRaw`
    SELECT e.enumlabel FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'LeadAlertChannel' AND e.enumlabel = 'NTFY_URGENT'`;
  if (alertEnumValues.length !== 1) throw new Error('LeadAlertChannel is missing NTFY_URGENT');
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
    if (!identity.ok) throw new Error('migration target identity refused');
    // Split on the "-- statement-break" marker only — never on a bare ";",
    // which would cut a dollar-quoted DO block (containing its own internal
    // semicolons) into invalid fragments. Same convention as
    // scripts/apply-speed-to-lead.mjs.
    const sql = readFileSync(new URL('../prisma/migrations/20260928120000_front_desk_v1/migration.sql', import.meta.url), 'utf8');
    const statements = sql.split(/^-- statement-break[ \t]*$/m).map(s => s.trim()).filter(Boolean);
    await prisma.$transaction(
      async (tx) => {
        const current = await tx.$queryRaw`SELECT current_database() AS db`;
        if (!current[0] || current[0].db !== database) throw new Error('current database mismatch');
        await tx.$executeRawUnsafe(SET_LOCAL_LOCK_TIMEOUT);
        await tx.$executeRawUnsafe(SET_LOCAL_STATEMENT_TIMEOUT);
        for (const statement of statements) {
          await tx.$executeRawUnsafe(statement);
        }
        await verifyShape(tx);
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
    );
    console.log('Front Desk v1 schema applied.');
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    console.error('Front Desk v1 migration refused or failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
