#!/usr/bin/env node
// Proves that a database built from prisma/migrations/ reproduces PRODUCTION.
//
// Run against a THROWAWAY Postgres that has just had `prisma migrate deploy`
// applied. Never point it at production.
//
//   node scripts/check-migrations-match.mjs            # after migrate deploy
//   node scripts/check-migrations-match.mjs --gap-applied
//       # after additionally applying prisma/EXPECTED_SCHEMA_GAP.sql, which
//       # proves that file is executable and really does close the gap
//
// Two independent assertions, because neither alone is sufficient:
//
//  1. DIFF SET. The database's `migrate diff` to schema.prisma must equal
//     EXPECTED_SCHEMA_GAP.sql + PRISMA_PHANTOM_DIFF.sql, statement for
//     statement. Production's diff to schema.prisma is the same set, so
//     matching it means matching production's shape as far as Prisma can see.
//
//  2. BLIND SPOTS. Prisma's diff engine cannot represent partial indexes, check
//     constraints, row-level security, stored functions, or triggers, and omits
//     them from its output without comment. Assertion 1 is therefore
//     structurally blind to exactly the objects most likely to be lost. We
//     compare those directly against prisma/prisma-blind-spots.json, which was
//     snapshotted from production.
//
// What this does NOT prove: object classes absent from both checks. Production
// currently has no views and no RLS policies (see the snapshot's `policies`
// array), so the two assertions together do cover it today — but that is a
// fact about production right now, not a guarantee. Add a class here if one
// ever appears.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GAP_FILE = path.join(ROOT, 'prisma', 'EXPECTED_SCHEMA_GAP.sql')
const PHANTOM_FILE = path.join(ROOT, 'prisma', 'PRISMA_PHANTOM_DIFF.sql')
const SNAPSHOT = path.join(ROOT, 'prisma', 'prisma-blind-spots.json')
const gapApplied = process.argv.includes('--gap-applied')

const url = process.env.DIRECT_URL || process.env.DATABASE_URL
if (!url) {
  console.error('check-migrations-match: set DIRECT_URL (or DATABASE_URL) to the throwaway database')
  process.exit(2)
}
if (/supabase\.(co|com)/i.test(url) && process.env.ALLOW_PROD_MIGRATION_CHECK !== '1') {
  console.error('check-migrations-match: refusing to run against what looks like Supabase/production')
  process.exit(2)
}

let failed = false
const fail = (msg) => {
  failed = true
  console.error('\n✖ ' + msg)
}

// ---------------------------------------------------------------------------
// 1. diff set
// ---------------------------------------------------------------------------

// Normalise a SQL script into comparable statements. Splitting on ';' is safe
// for THIS input specifically: every statement is machine-generated DDL from
// Prisma or from pg_get_*def, none of which emit a semicolon inside a string
// literal or a dollar-quoted body. It would not be safe for arbitrary SQL, so
// if this ever has to handle hand-written migrations, replace it with a real
// lexer rather than extending the heuristic.
function statements(sql) {
  return sql
    .split(/\r?\n/)
    .filter((l) => !/^\s*--/.test(l) && l.trim() !== '')
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

// Multiset difference: a statement appearing twice must appear twice on both
// sides. Plain set membership would let a duplicated statement pass unnoticed.
function multisetDiff(a, b) {
  const counts = new Map()
  for (const s of b) counts.set(s, (counts.get(s) ?? 0) + 1)
  const extra = []
  for (const s of a) {
    const n = counts.get(s) ?? 0
    if (n === 0) extra.push(s)
    else counts.set(s, n - 1)
  }
  return extra
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const expected = [
  ...(gapApplied ? [] : statements(read(GAP_FILE))),
  ...statements(read(PHANTOM_FILE)),
]

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
const actual = statements(actualRaw)

const unexpected = multisetDiff(actual, expected)
const missing = multisetDiff(expected, actual)

if (unexpected.length) {
  fail(
    `${unexpected.length} statement(s) differ between this database and schema.prisma that are\n` +
      `  NOT accounted for. Either a migration is missing, or schema.prisma moved without one:`
  )
  for (const s of unexpected) console.error('    + ' + s)
}
if (missing.length) {
  fail(
    `${missing.length} expected statement(s) no longer appear in the diff. If the gap was closed,\n` +
      `  apply it as a real migration and delete prisma/EXPECTED_SCHEMA_GAP.sql rather than\n` +
      `  leaving it stale:`
  )
  for (const s of missing) console.error('    - ' + s)
}
if (unexpected.length || missing.length) {
  console.error('\n--- full diff actually produced (for reference) ---')
  console.error(actualRaw.trim() || '(empty)')
  console.error('--- end ---')
}

// ---------------------------------------------------------------------------
// 2. blind spots
// ---------------------------------------------------------------------------
const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
const { PrismaClient } = await import('@prisma/client')
const db = new PrismaClient({ datasources: { db: { url } } })
const q = (sql) => db.$queryRawUnsafe(sql)

// Definitions are compared RAW. Both sides come from the same server-side
// pg_get_*def functions, which emit a canonical form, so any normalisation here
// would only be able to hide a real difference — collapsing whitespace or
// stripping a schema qualifier also rewrites the inside of string literals and
// quoted identifiers, which is exactly where a meaningful change could hide.
//
// Keys include the table, because PostgreSQL allows the same constraint name on
// different tables; keying by name alone would let a constraint that moved to
// the wrong table pass, and would silently collapse duplicates.
function compareDefs(label, expectedRows, actualRows, hint) {
  const key = (r) => (r.table ? `${r.table}.${r.name}` : r.name)
  const exp = new Map(expectedRows.map((r) => [key(r), r.def]))
  const act = new Map(actualRows.map((r) => [key(r), r.def]))
  for (const [name, def] of exp) {
    if (!act.has(name)) fail(`${label} "${name}" is MISSING from the database.\n  ${hint}`)
    else if (act.get(name) !== def)
      fail(
        `${label} "${name}" has a DIFFERENT definition than production.\n` +
          `  expected: ${def}\n  actual:   ${act.get(name)}`
      )
  }
  for (const name of act.keys()) {
    if (!exp.has(name))
      fail(
        `${label} "${name}" exists in the database but not in prisma/prisma-blind-spots.json.\n` +
          `  If you added it deliberately, re-run scripts/snapshot-prisma-blind-spots.mjs against\n` +
          `  production and commit the result.`
      )
  }
}

compareDefs(
  'partial index',
  snap.partialIndexes,
  await q(`SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relnamespace = 'public'::regnamespace AND i.indpred IS NOT NULL`),
  "Prisma's diff omits partial indexes — the baseline's generated tail block is the only thing that creates them."
)

compareDefs(
  'check constraint',
  snap.checkConstraints,
  await q(`SELECT conname AS name, conrelid::regclass::text AS "table",
                  pg_get_constraintdef(oid) AS def
             FROM pg_constraint
            WHERE connamespace = 'public'::regnamespace AND contype IN ('c','x')`),
  'Prisma has no check-constraint concept; the baseline tail block creates these.'
)

// FORCE matters, not just ENABLE: these 31 tables have zero policies, so the
// application only reads them because owners bypass RLS. FORCE removes that
// bypass and would deny the owner too — a silent empty-result failure. Assert
// the flag, not merely the table name.
const actualRls = new Map(
  (
    await q(`SELECT relname AS name, relforcerowsecurity AS forced FROM pg_class
              WHERE relnamespace = 'public'::regnamespace AND relrowsecurity`)
  ).map((r) => [r.name, r.forced])
)
const expectedRls = new Map(snap.rlsTables.map((r) => [r.name, r.forced]))
for (const [t, forced] of expectedRls) {
  if (!actualRls.has(t)) fail(`RLS is not enabled on "${t}" but is in production.`)
  else if (actualRls.get(t) !== forced)
    fail(
      `RLS FORCE differs on "${t}": production has forced=${forced}, this database has ` +
        `forced=${actualRls.get(t)}. With no policies attached, FORCE denies even the owner.`
    )
}
for (const t of actualRls.keys())
  if (!expectedRls.has(t)) fail(`RLS is enabled on "${t}" but not in production's snapshot.`)

const actualPolicies = await q(
  `SELECT tablename AS "table", policyname AS name FROM pg_policies WHERE schemaname = 'public'`
)
if (actualPolicies.length !== snap.policies.length)
  fail(
    `${actualPolicies.length} RLS policies present, snapshot records ${snap.policies.length}. ` +
      `Re-snapshot if production changed.`
  )

compareDefs(
  'function',
  snap.functions,
  await q(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
                    pg_get_functiondef(p.oid) AS def
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
              ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`),
  'Prisma cannot represent stored functions; the migration must create the exact production definition.'
)

compareDefs(
  'trigger',
  snap.triggers,
  await q(`SELECT c.relname AS "table", t.tgname AS name, pg_get_triggerdef(t.oid) AS def
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgconstraint = 0
              ORDER BY c.relname, t.tgname`),
  'Prisma cannot represent triggers; the migration must create the exact production definition.'
)

await db.$disconnect()

if (failed) process.exit(1)
console.log(
  `✓ migrations reproduce production` +
    (gapApplied ? ' with EXPECTED_SCHEMA_GAP.sql applied' : '') +
    `: ${actual.length} diff statement(s) all accounted for; ` +
    `${snap.partialIndexes.length} partial indexes, ${snap.checkConstraints.length} check constraints, ` +
    `${snap.rlsTables.length} RLS tables, ${snap.functions.length} functions, and ` +
    `${snap.triggers.length} triggers all match.`
)
