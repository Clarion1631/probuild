#!/usr/bin/env node
// Proves that a database built from prisma/migrations/ reproduces PRODUCTION.
//
// Run against a THROWAWAY Postgres that has just had `prisma migrate deploy`
// applied to it. Never point this at production (it only reads, but there is no
// reason to).
//
// Two assertions, because one alone is not enough:
//
//  1. The migrated database differs from prisma/schema.prisma by EXACTLY the set
//     of statements in prisma/EXPECTED_SCHEMA_GAP.sql — which was captured from
//     production. Same diff-to-schema => same shape as production, as far as
//     Prisma can see.
//
//  2. Prisma CANNOT see partial indexes; its diff engine has no representation
//     for them and silently omits them. So assertion 1 is blind to exactly the
//     objects most likely to be lost when the baseline is regenerated. We
//     therefore query pg_indexes directly and require all seven to be present,
//     with their WHERE clauses intact. Three of them are UNIQUE and enforce real
//     invariants (Twilio webhook dedup, deposit-reservation uniqueness, one
//     client thread per project).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GAP_FILE = path.join(ROOT, 'prisma', 'EXPECTED_SCHEMA_GAP.sql')
const url = process.env.DIRECT_URL || process.env.DATABASE_URL
if (!url) {
  console.error('check-migrations-match: set DIRECT_URL (or DATABASE_URL) to the throwaway database')
  process.exit(2)
}
if (/supabase\.(co|com)/i.test(url) && process.env.ALLOW_PROD_MIGRATION_CHECK !== '1') {
  console.error('check-migrations-match: refusing to run against what looks like Supabase/production')
  process.exit(2)
}

// Split a SQL script into normalised, comparable statements: drop comment lines
// and blank lines, collapse whitespace, then sort (statement ORDER is not
// meaningful for a diff-set comparison, only membership).
function statements(sql) {
  return sql
    .split(/\r?\n/)
    .filter((l) => !/^\s*--/.test(l) && l.trim() !== '')
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .sort()
}

const actualRaw = execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'prisma',
    'migrate',
    'diff',
    '--from-url',
    url,
    '--to-schema-datamodel',
    path.join(ROOT, 'prisma', 'schema.prisma'),
    '--script',
  ],
  { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' }
)

const expected = statements(existsSync(GAP_FILE) ? readFileSync(GAP_FILE, 'utf8') : '')
const actual = statements(actualRaw)

const missing = expected.filter((s) => !actual.includes(s))
const unexpected = actual.filter((s) => !expected.includes(s))

let failed = false
if (unexpected.length) {
  failed = true
  console.error(
    `\n✖ ${unexpected.length} statement(s) differ between the migrated database and schema.prisma\n` +
      `  that are NOT part of the accepted production gap. The migrations no longer\n` +
      `  reproduce production — either a migration is missing, or schema.prisma moved\n` +
      `  without one.\n`
  )
  for (const s of unexpected) console.error('    + ' + s)
}
if (missing.length) {
  failed = true
  console.error(
    `\n✖ ${missing.length} statement(s) in prisma/EXPECTED_SCHEMA_GAP.sql no longer appear in the diff.\n` +
      `  If production was brought up to date, apply that gap as a real migration and\n` +
      `  delete the file — do not leave it stale.\n`
  )
  for (const s of missing) console.error('    - ' + s)
}

// ---- assertion 2: the partial indexes Prisma's diff cannot see -------------
const REQUIRED_PARTIAL = {
  ClientMessage_twilioMessageSid_key: '"twilioMessageSid" IS NOT NULL',
  DepositIngest_paymentScheduleId_reservation_key: '"paymentScheduleId" IS NOT NULL',
  MessageThread_projectId_client_unique: '"subcontractorId" IS NULL',
  ReviewAlertBatch_claimed_lease_idx: "'CLAIMED'",
  ReviewAlertBatch_pending_retry_idx: "'PENDING'",
  ReviewAlertEpisode_claimed_lease_idx: "'CLAIMED'",
  ReviewAlertEpisode_pending_retry_idx: "'PENDING'",
}

const { PrismaClient } = await import('@prisma/client')
const client = new PrismaClient({ datasources: { db: { url } } })
const rows = await client.$queryRawUnsafe(
  `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE '%WHERE%'`
)
await client.$disconnect()

const found = new Map(rows.map((r) => [r.indexname, r.indexdef]))
for (const [name, mustContain] of Object.entries(REQUIRED_PARTIAL)) {
  const def = found.get(name)
  if (!def) {
    failed = true
    console.error(
      `\n✖ partial index "${name}" is missing from the migrated database.\n` +
        `  Prisma's diff engine omits partial indexes, so this is almost certainly a\n` +
        `  baseline that was regenerated without re-appending the hand-written block\n` +
        `  at the end of prisma/migrations/20260814000000_baseline_production/migration.sql.`
    )
  } else if (!def.includes(mustContain)) {
    failed = true
    console.error(
      `\n✖ partial index "${name}" exists but its predicate changed.\n` +
        `  expected to contain: ${mustContain}\n  actual: ${def}`
    )
  }
}
const extraPartial = [...found.keys()].filter((n) => !(n in REQUIRED_PARTIAL))
if (extraPartial.length) {
  console.error(
    `\n! note: ${extraPartial.length} partial index(es) present that this check does not know about: ` +
      extraPartial.join(', ') +
      `\n  If you added them deliberately, add them to REQUIRED_PARTIAL here and to the baseline.`
  )
}

if (failed) process.exit(1)
console.log(
  `✓ migrations reproduce production: ${actual.length} diff statement(s), all accounted for by ` +
    `prisma/EXPECTED_SCHEMA_GAP.sql, and all ${Object.keys(REQUIRED_PARTIAL).length} partial indexes present.`
)
