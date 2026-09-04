// Refuses a prisma-blind-spots snapshot whose definitions carry carriage returns.
//
// Definitions come back from pg_get_functiondef() and friends verbatim. A
// database built from a CRLF checkout of prisma/migrations/**/*.sql keeps the
// \r bytes inside dollar-quoted plpgsql bodies; JSON.stringify writes each one
// as the escape "\r", which Git's line-ending conversion never touches, and
// JSON.parse restores it. scripts/check-migrations-match.mjs compares raw text,
// so a poisoned snapshot would then demand \r in every future database. See
// PR #471 (which pinned LF on the migration SQL) for the original incident.
const CHECKED = ['partialIndexes', 'checkConstraints', 'functions', 'triggers']

/** @returns {string[]} human-readable labels of offending objects (empty when clean) */
export function findCarriageReturns(snapshot) {
  const bad = []
  for (const key of CHECKED) {
    for (const row of snapshot[key] ?? []) {
      if (typeof row.def === 'string' && row.def.includes('\r')) {
        bad.push(`${key} ${row.table ? row.table + '.' : ''}${row.name}`)
      }
    }
  }
  return bad
}
