// Applies prisma/migrations/20260814120000_missing_fk_indexes to PRODUCTION.
//
// The 2026-08-14 baseline was generated from production, so it records prod's
// real shape — including seven foreign keys and three indexes that
// prisma/schema.prisma declares but prod never had. That difference was checked
// in verbatim as prisma/EXPECTED_SCHEMA_GAP.sql. This script closes it.
//
// Run:  node scripts/apply-missing-fk-indexes.mjs --prod
//       node scripts/apply-missing-fk-indexes.mjs --prod --dry-run   # report only
//       ... --lock-timeout=5000                                      # ms, default 5000
//
// Then record the migration in prod's history (this script deliberately does
// NOT write _prisma_migrations — Prisma owns that table's checksum format and
// hand-writing a row risks breaking `migrate status` permanently):
//
//   DIRECT_URL="<session pooler URL>" npx prisma migrate resolve \
//     --applied 20260814120000_missing_fk_indexes
//
// (DDL via $executeRawUnsafe over the Supabase transaction pooler — the working
//  path in this project; psql / prisma db push / migrate dev do not work here.
//  See CLAUDE.md "Schema migrations".)
//
// ---------------------------------------------------------------------------
// TARGET GUARD. --prod is mandatory and the resolved DATABASE_URL must be the
// known Supabase transaction pooler with pgbouncer=true. There is no --force:
// this script only knows how to talk to one database, and a mistyped env var
// pointing it at a dev copy would report a wildly different plan.
//
// IDEMPOTENT, AND VERIFIED SO. Every object is compared against pg_catalog
// before being touched. Constraints are compared by structured action code
// (pg_constraint.confupdtype / confdeltype), never by rendered
// pg_get_constraintdef() text. Indexes are compared on table, ordered key
// columns, access method, predicate, uniqueness AND indisvalid/indisready — a
// same-named index is never assumed to be the right index, and a leftover
// INVALID index from an interrupted CREATE INDEX CONCURRENTLY is dropped and
// rebuilt rather than skipped. A structural mismatch aborts; it is not repaired,
// because "wrong index of the right name" is a situation a human should look at.
//
// LOCK BEHAVIOUR. Every DDL statement runs under a bounded lock_timeout, so the
// worst case is a clean failure rather than a queue of blocked queries behind an
// ungranted ACCESS EXCLUSIVE request:
//
//   * Indexes are built with CREATE INDEX CONCURRENTLY (SHARE UPDATE EXCLUSIVE:
//     concurrent reads and writes continue). CONCURRENTLY cannot run inside a
//     transaction block, so SET LOCAL is unavailable for it; the bound comes
//     from `options=-c lock_timeout=...` in the connection string, which the
//     server applies at session start, and the script REFUSES to issue any
//     CONCURRENTLY statement until it has read the value back with
//     `SHOW lock_timeout` and confirmed the pooler honoured it. (Every backend
//     in a pooler pool is started with the same startup options, so reading it
//     back on one statement establishes it for the next.) Honest limit: a
//     CONCURRENTLY build also waits for pre-existing transactions on the table
//     to finish, and lock_timeout does NOT bound that wait — it bounds lock
//     acquisition only.
//   * Constraint work runs in a transaction per constraint with SET LOCAL
//     lock_timeout, taking the locks the DDL needs explicitly and up front:
//     ACCESS EXCLUSIVE on the child (DROP CONSTRAINT and ADD CONSTRAINT both
//     require it) and SHARE ROW EXCLUSIVE on the parent (what ADD FOREIGN KEY
//     takes there). Acquiring both before any DDL avoids a mid-statement lock
//     upgrade, which is the deadlock-prone shape.
//   * Foreign keys go in NOT VALID, so that transaction never scans the table.
//     VALIDATE CONSTRAINT runs afterwards in its own transaction under SHARE
//     UPDATE EXCLUSIVE, which does not block reads or writes.
//   * A replaced constraint's drop and re-add share one transaction, so
//     enforcement is never absent.
//
// ORPHAN PREFLIGHT — WHY THE COUNT IS INSIDE THE LOCK. Counting orphans and then
// adding the constraint as two separate steps is a TOCTOU: between the count and
// the ADD, an older process can insert a row referencing a nonexistent parent (or
// delete a parent out from under an existing child), and VALIDATE then fails
// after the DDL has already been committed. Of the two remedies available, this
// script takes the LOCKING one: the count runs inside the same transaction as the
// ADD, with the child and parent tables already locked against writes, so no row
// can appear between the two. Once the NOT VALID constraint is committed its
// triggers are live on both sides, so nothing can create a violation afterwards
// either — which makes the later VALIDATE genuinely guaranteed to succeed rather
// than merely likely.
//
// The alternative — add NOT VALID unconditionally and treat a failed VALIDATE as
// a reported partial state — was rejected because its failure mode is a
// production database left carrying an unvalidated constraint plus a human to-do,
// and because these tables are small enough that a sub-second write pause costs
// less than that. The count is skipped entirely for constraints that are merely
// being re-created with a different ON UPDATE action: an existing, validated
// constraint over the same column pair already proves the invariant, so there is
// nothing to check and no reason to hold the lock while scanning.
//
// This means the earlier claim that the script "aborts before any DDL is issued"
// is now scoped honestly: orphans block the constraint they belong to, from
// inside that constraint's own transaction, which rolls back leaving that
// constraint untouched. Constraints and indexes already completed before it stay
// completed — the script reports exactly what was done and what was not, and is
// safe to re-run once the orphans are cleaned up.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const isProd = argv.includes("--prod");
const lockTimeoutMs = (() => {
  const arg = argv.find((a) => a.startsWith("--lock-timeout="));
  if (!arg) return 5000;
  const n = Number(arg.slice("--lock-timeout=".length));
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--lock-timeout must be a positive whole number of milliseconds, got: ${arg}`);
    process.exit(1);
  }
  return n;
})();
// VALIDATE scans the table. It holds only SHARE UPDATE EXCLUSIVE, so a long scan
// is not a availability problem — but Prisma's interactive transactions have
// their own timeout and it must be generous enough not to cut the scan short.
const VALIDATE_TX_TIMEOUT_MS = 600_000;

if (!isProd) {
  console.error(
    "Refusing to run without --prod.\n" +
      "  This script writes DDL to the production database and has no other target.\n" +
      "  node scripts/apply-missing-fk-indexes.mjs --prod [--dry-run]"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Target guard (REAL 6): the resolved URL must be production's pooler.

const EXPECTED_HOST = "aws-0-us-west-2.pooler.supabase.com";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, from: "env DATABASE_URL" };
  for (const f of [".env", ".env.local"]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) return { url: m[1], from: f };
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

function assertProductionUrl(raw, from) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    console.error(`DATABASE_URL (${from}) is not a parseable URL. Refusing to run.`);
    process.exit(1);
  }
  const problems = [];
  if (u.hostname !== EXPECTED_HOST) {
    problems.push(`host is "${u.hostname}", expected "${EXPECTED_HOST}"`);
  }
  if (u.searchParams.get("pgbouncer") !== "true") {
    problems.push(
      `pgbouncer=true is missing (got ${JSON.stringify(u.searchParams.get("pgbouncer"))}) — ` +
        "without it Prisma's prepared statements collide on the transaction pooler (42P05)"
    );
  }
  if (problems.length) {
    console.error(
      `Refusing to run: DATABASE_URL (${from}) does not look like ProBuild production.\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n  Nothing was read and nothing was changed."
    );
    process.exit(1);
  }
  // Never print the credential portion.
  return `${u.hostname}:${u.port || "(default)"}${u.pathname}`;
}

// CREATE/DROP INDEX CONCURRENTLY cannot run in a transaction, so SET LOCAL is
// not available to bound its lock wait. Pass the bound as a server startup
// option instead; it is read back and asserted before any CONCURRENTLY DDL.
function withLockTimeoutOption(raw, ms) {
  const u = new URL(raw);
  const params = [];
  let existing = null;
  for (const [k, v] of u.searchParams) {
    if (k === "options") existing = v;
    else params.push([k, v]);
  }
  params.push(["options", existing ? `${existing} -c lock_timeout=${ms}` : `-c lock_timeout=${ms}`]);
  u.search = "";
  // Build the query string by hand: URLSearchParams encodes a space as "+",
  // which is not what a libpq-style `options` value wants.
  return `${u.toString()}?${params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")}`;
}

const { url: rawUrl, from: urlFrom } = resolveDatabaseUrl();
const target = assertProductionUrl(rawUrl, urlFrom);
const prisma = new PrismaClient({
  datasources: { db: { url: withLockTimeoutOption(rawUrl, lockTimeoutMs) } },
});

// ---------------------------------------------------------------------------
// Object definitions

// PostgreSQL's pg_constraint action codes. Comparing these is exact; comparing
// the rendered pg_get_constraintdef() text is not (it omits NO ACTION, reorders
// clauses, and drops quoting on lowercase identifiers).
const ACTION = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

// The seven foreign keys schema.prisma declares. Five already exist in prod with
// ON UPDATE NO ACTION and are replaced to pick up ON UPDATE CASCADE (inert —
// cuid ids are never rewritten). Two are real changes, flagged below.
const FOREIGN_KEYS = [
  {
    name: "ClientMessage_projectId_fkey",
    table: "ClientMessage",
    column: "projectId",
    refTable: "Project",
    refColumn: "id",
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  },
  {
    name: "OfficeTask_columnId_fkey",
    table: "OfficeTask",
    column: "columnId",
    refTable: "OfficeBoardColumn",
    refColumn: "id",
    onDelete: "SET NULL",
    onUpdate: "CASCADE",
  },
  {
    name: "OfficeTask_assigneeId_fkey",
    table: "OfficeTask",
    column: "assigneeId",
    refTable: "User",
    refColumn: "id",
    onDelete: "SET NULL",
    onUpdate: "CASCADE",
  },
  {
    name: "OfficeTask_createdById_fkey",
    table: "OfficeTask",
    column: "createdById",
    refTable: "User",
    refColumn: "id",
    onDelete: "SET NULL",
    onUpdate: "CASCADE",
  },
  {
    // BEHAVIOUR CHANGE: prod has ON DELETE SET NULL. Deleting a Lead that was
    // converted to a Project currently orphans the Project silently; after this
    // the delete fails instead. RESTRICT is what schema.prisma has always
    // declared, so the Prisma client already assumes it. deleteLead() in
    // src/lib/actions.ts was made transactional and P2003-aware in the same
    // change, so the app reports that refusal instead of half-deleting a lead.
    name: "Project_leadId_fkey",
    table: "Project",
    column: "leadId",
    refTable: "Lead",
    refColumn: "id",
    onDelete: "RESTRICT",
    onUpdate: "CASCADE",
  },
  {
    // NEW: no such constraint exists in prod. Project.managerId can currently
    // reference a deleted User. This is the one constraint whose orphan count
    // can actually find something.
    name: "Project_managerId_fkey",
    table: "Project",
    column: "managerId",
    refTable: "User",
    refColumn: "id",
    onDelete: "SET NULL",
    onUpdate: "CASCADE",
  },
  {
    name: "TaskCommentPhoto_commentId_fkey",
    table: "TaskCommentPhoto",
    column: "commentId",
    refTable: "TaskComment",
    refColumn: "id",
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  },
];

const INDEXES = [
  { name: "ClientMessage_leadId_idx", table: "ClientMessage", columns: ["leadId"] },
  { name: "ClientMessage_createdAt_idx", table: "ClientMessage", columns: ["createdAt"] },
  {
    name: "EstimatePaymentSchedule_estimateId_idx",
    table: "EstimatePaymentSchedule",
    columns: ["estimateId"],
  },
];

// Every identifier below is a literal from the two tables above, but they are
// interpolated into SQL, so assert the shape rather than trusting the reader.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
for (const o of [...FOREIGN_KEYS, ...INDEXES]) {
  const idents = [o.name, o.table, ...(o.columns ?? [o.column]), ...(o.refTable ? [o.refTable, o.refColumn] : [])];
  for (const id of idents) {
    if (!IDENT.test(id)) throw new Error(`Unsafe identifier in script definitions: ${id}`);
  }
}

const q = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args);
const rel = (t) => `public."${t}"`;

// ---------------------------------------------------------------------------
// Session preflight

async function assertLockTimeoutInEffect() {
  // current_setting() rather than SHOW: same value, but a plain SELECT, which is
  // what $queryRawUnsafe is contracted to carry.
  const rows = await q("SELECT current_setting('lock_timeout') AS lock_timeout");
  const shown = String(rows[0].lock_timeout);
  const m = shown.match(/^(\d+)\s*(us|ms|s|min|h|d)?$/);
  const unit = { us: 1 / 1000, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = m ? Number(m[1]) * (unit[m[2] ?? "ms"] ?? 1) : NaN;
  if (ms !== lockTimeoutMs) {
    throw new Error(
      `lock_timeout is "${shown}" (${ms}ms), expected ${lockTimeoutMs}ms.\n` +
        "  The connection pooler did not honour `options=-c lock_timeout=...` from the\n" +
        "  connection string. CREATE INDEX CONCURRENTLY cannot be wrapped in a transaction,\n" +
        "  so there is no other way to bound its lock wait from here — refusing to issue\n" +
        "  unbounded DDL against production. Build the three indexes by hand from a session\n" +
        "  where you can SET lock_timeout, or run this from a session-mode connection."
    );
  }
  return shown;
}

// ---------------------------------------------------------------------------
// Foreign keys

// Reads the constraint's actual shape from the catalog: referenced table, the
// single column on each side, both referential actions, and whether it has been
// validated. Returns null when the constraint does not exist.
async function inspectForeignKey(fk) {
  const rows = await q(
    `SELECT c.conname                        AS name,
            c.confupdtype                    AS onupdate,
            c.confdeltype                    AS ondelete,
            c.convalidated                   AS validated,
            c.confrelid::regclass::text      AS reftable,
            (c.confrelid = to_regclass($3))  AS refmatches,
            (SELECT a.attname FROM pg_attribute a
              WHERE a.attrelid = c.conrelid  AND a.attnum = c.conkey[1])  AS col,
            (SELECT a.attname FROM pg_attribute a
              WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) AS refcol,
            array_length(c.conkey, 1)        AS ncols
       FROM pg_constraint c
      WHERE c.connamespace = 'public'::regnamespace
        AND c.contype = 'f'
        AND c.conrelid = to_regclass($1)
        AND c.conname = $2`,
    rel(fk.table),
    fk.name,
    rel(fk.refTable)
  );
  return rows[0] ?? null;
}

// True when the constraint already points at the same single column pair. That
// is the invariant the orphan count would check, so an EXISTING VALIDATED
// constraint of this shape means there is nothing left to count.
function sameColumnPair(fk, actual) {
  return (
    actual.ncols === 1 &&
    actual.col === fk.column &&
    actual.refcol === fk.refColumn &&
    actual.refmatches === true
  );
}

function foreignKeyMatches(fk, actual) {
  return (
    sameColumnPair(fk, actual) &&
    ACTION[actual.ondelete] === fk.onDelete &&
    ACTION[actual.onupdate] === fk.onUpdate &&
    actual.validated === true
  );
}

// ---------------------------------------------------------------------------
// Indexes

// Full structural read (REAL 5). A same-named index is not the same index:
// compare the table, the ordered key columns, the access method, the predicate,
// uniqueness — and indisvalid/indisready, which is how a half-built index left
// behind by an interrupted CREATE INDEX CONCURRENTLY announces itself.
async function inspectIndex(ix) {
  const rows = await q(
    `SELECT c.relname                          AS name,
            t.relname                          AS tbl,
            am.amname                          AS method,
            i.indisvalid                       AS isvalid,
            i.indisready                       AS isready,
            i.indisunique                      AS isunique,
            i.indnatts                         AS natts,
            i.indnkeyatts                      AS nkeyatts,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            i.indoption::text                  AS indoption,
            pg_get_indexdef(i.indexrelid)      AS def,
            -- indkey is an int2vector, whose output form is space-separated, so
            -- string_to_array is the cast-free way to walk it in key order.
            (SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(string_to_array(i.indkey::text, ' ')::int2[])
                    WITH ORDINALITY AS k(attnum, ord)
               LEFT JOIN pg_attribute a
                 ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_am   am ON am.oid = c.relam
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind = 'i'
        AND c.relname = $1`,
    ix.name
  );
  return rows[0] ?? null;
}

// A relation of the right name that is not an index at all — a table, a view, a
// sequence. CREATE INDEX would fail on the name clash; say so up front.
async function inspectNonIndexRelation(name) {
  const rows = await q(
    `SELECT c.relkind::text AS relkind FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = $1 AND c.relkind <> 'i'`,
    name
  );
  return rows[0] ?? null;
}

// Structural comparison only — validity is judged separately, because an invalid
// index that is otherwise correct is rebuildable while a structural mismatch is
// not.
function indexMismatches(ix, actual) {
  const out = [];
  if (actual.tbl !== ix.table) out.push(`on table "${actual.tbl}", expected "${ix.table}"`);
  const cols = actual.cols ?? [];
  if (cols.length !== ix.columns.length || cols.some((c, n) => c !== ix.columns[n])) {
    out.push(`columns (${cols.map((c) => c ?? "<expression>").join(", ")}), expected (${ix.columns.join(", ")})`);
  }
  if (Number(actual.nkeyatts) !== ix.columns.length || Number(actual.natts) !== Number(actual.nkeyatts)) {
    out.push(`${actual.natts} attribute(s) / ${actual.nkeyatts} key attribute(s) — INCLUDE columns are not expected`);
  }
  if (actual.method !== "btree") out.push(`access method "${actual.method}", expected "btree"`);
  if (actual.predicate !== null) out.push(`partial: WHERE ${actual.predicate}, expected no predicate`);
  if (actual.isunique) out.push("UNIQUE, expected non-unique");
  // indoption carries per-column DESC / NULLS FIRST bits; all zero is the plain
  // ascending index Prisma declares.
  const opts = String(actual.indoption ?? "").trim();
  if (opts && opts.split(/\s+/).some((o) => o !== "0")) {
    out.push(`non-default column ordering (indoption ${opts}), expected plain ASC`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planning

async function buildPlan() {
  const fkPlan = [];
  let aborted = false;

  for (const fk of FOREIGN_KEYS) {
    const actual = await inspectForeignKey(fk);
    if (actual && foreignKeyMatches(fk, actual)) {
      console.log(`= ${fk.name}: already correct`);
      continue;
    }
    const action = actual ? "replace" : "create";
    // Skip the orphan count only when an existing VALIDATED constraint over the
    // same column pair already proves there are none.
    const needsOrphanCount = !(actual && actual.validated === true && sameColumnPair(fk, actual));
    const detail = actual
      ? `ON DELETE ${ACTION[actual.ondelete]} ON UPDATE ${ACTION[actual.onupdate]}` +
        `${actual.validated ? "" : " NOT VALID"} -> ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
      : `ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
    fkPlan.push({ fk, action, needsOrphanCount });
    console.log(
      `~ ${fk.name}: ${action} (${detail})${needsOrphanCount ? " [orphan count under lock]" : ""}`
    );
  }

  const indexPlan = [];
  for (const ix of INDEXES) {
    const clash = await inspectNonIndexRelation(ix.name);
    if (clash) {
      aborted = true;
      console.error(
        `✖ ${ix.name}: a relation of that name already exists in public and is not an index ` +
          `(relkind "${clash.relkind}"). Resolve the name clash by hand.`
      );
      continue;
    }
    const actual = await inspectIndex(ix);
    if (!actual) {
      indexPlan.push({ ix, action: "create" });
      console.log(`~ ${ix.name}: create on "${ix.table}"(${ix.columns.join(", ")})`);
      continue;
    }
    const mismatches = indexMismatches(ix, actual);
    if (mismatches.length) {
      aborted = true;
      console.error(
        `✖ ${ix.name}: an index of that name exists but is not the one this migration declares:\n` +
          mismatches.map((m) => `    - ${m}`).join("\n") +
          `\n    actual: ${actual.def}\n` +
          "    Refusing to drop it. Decide by hand whether it should be renamed or removed."
      );
      continue;
    }
    if (!actual.isvalid || !actual.isready) {
      // Structurally right, but unusable: the residue of a CREATE INDEX
      // CONCURRENTLY that failed or was interrupted. The planner ignores such an
      // index, so leaving it would mean the migration silently did nothing.
      indexPlan.push({ ix, action: "rebuild" });
      console.log(
        `~ ${ix.name}: INVALID leftover (indisvalid=${actual.isvalid}, indisready=${actual.isready}) ` +
          "— drop and rebuild concurrently"
      );
      continue;
    }
    console.log(`= ${ix.name}: already present and valid`);
  }

  return { fkPlan, indexPlan, aborted };
}

// ---------------------------------------------------------------------------
// Execution

async function applyIndex({ ix, action }) {
  const cols = ix.columns.map((c) => `"${c}"`).join(", ");
  if (action === "rebuild") {
    // Re-assert the session bound immediately before each non-transactional
    // statement rather than trusting a check made earlier in the run.
    await assertLockTimeoutInEffect();
    await prisma.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${rel(ix.name)}`);
    console.log(`✔ dropped invalid index ${ix.name}`);
  }
  await assertLockTimeoutInEffect();
  await prisma.$executeRawUnsafe(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${ix.name}" ON ${rel(ix.table)} (${cols})`
  );
  // CONCURRENTLY reports success even when the build failed and left the index
  // invalid, and IF NOT EXISTS reports success when it matched a same-named
  // index it did not create. Confirm both rather than assume either.
  const after = await inspectIndex(ix);
  if (!after || !after.isvalid || !after.isready) {
    throw new Error(
      `${ix.name}: CREATE INDEX CONCURRENTLY returned without error but the index is not valid ` +
        `(indisvalid=${after?.isvalid}, indisready=${after?.isready}). Re-run to drop and rebuild it.`
    );
  }
  const drift = indexMismatches(ix, after);
  if (drift.length) {
    throw new Error(
      `${ix.name}: after CREATE INDEX CONCURRENTLY the index in the catalog is not the declared one ` +
        `(${drift.join("; ")}). Something created it concurrently with this run — inspect by hand.`
    );
  }
  console.log(`✔ created index ${ix.name} (concurrently, valid)`);
}

async function applyForeignKey({ fk, action, needsOrphanCount }) {
  const add =
    `ALTER TABLE ${rel(fk.table)} ADD CONSTRAINT "${fk.name}" ` +
    `FOREIGN KEY ("${fk.column}") REFERENCES ${rel(fk.refTable)}("${fk.refColumn}") ` +
    `ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate} NOT VALID`;

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      // Take exactly the locks the DDL below needs, before any of it runs: no
      // mid-statement upgrade, and no window for a writer between the count and
      // the ADD.
      await tx.$executeRawUnsafe(`LOCK TABLE ${rel(fk.table)} IN ACCESS EXCLUSIVE MODE`);
      if (fk.refTable !== fk.table) {
        await tx.$executeRawUnsafe(`LOCK TABLE ${rel(fk.refTable)} IN SHARE ROW EXCLUSIVE MODE`);
      }

      if (needsOrphanCount) {
        const rows = await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS n
             FROM ${rel(fk.table)} child
            WHERE child."${fk.column}" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${rel(fk.refTable)} parent
                 WHERE parent."${fk.refColumn}" = child."${fk.column}")`
        );
        const orphans = rows[0].n;
        if (orphans > 0) {
          throw new Error(
            `${fk.name}: ${orphans} row(s) in "${fk.table}" have a "${fk.column}" with no matching ` +
              `"${fk.refTable}"."${fk.refColumn}". Rolled back — this constraint was not touched. ` +
              "Clean these up first; this script will not guess whether to null them out or delete them."
          );
        }
      }

      if (action === "replace") {
        await tx.$executeRawUnsafe(`ALTER TABLE ${rel(fk.table)} DROP CONSTRAINT "${fk.name}"`);
      }
      await tx.$executeRawUnsafe(add);
    },
    { timeout: 120_000, maxWait: Math.max(lockTimeoutMs * 2, 10_000) }
  );
  console.log(`✔ ${action}d ${fk.name} (NOT VALID)`);

  // Its own transaction on purpose: VALIDATE takes only SHARE UPDATE EXCLUSIVE,
  // so the scan runs without blocking concurrent reads or writes. The NOT VALID
  // constraint committed above is already enforcing against new rows, so this
  // cannot fail on data that appeared since the count.
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      await tx.$executeRawUnsafe(`ALTER TABLE ${rel(fk.table)} VALIDATE CONSTRAINT "${fk.name}"`);
    },
    { timeout: VALIDATE_TX_TIMEOUT_MS, maxWait: Math.max(lockTimeoutMs * 2, 10_000) }
  );
  console.log(`✔ validated ${fk.name}`);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Target: ${target}  (from ${urlFrom})`);
  const shown = await assertLockTimeoutInEffect();
  console.log(`Session lock_timeout: ${shown}\n`);

  const { fkPlan, indexPlan, aborted } = await buildPlan();

  if (aborted) {
    console.error("\nAborted before any DDL was issued. Nothing was changed.");
    process.exitCode = 1;
    return;
  }
  if (!fkPlan.length && !indexPlan.length) {
    console.log("\nNothing to do — production already matches schema.prisma.");
    return;
  }
  if (dryRun) {
    console.log("\n--dry-run: no DDL issued.");
    return;
  }

  // Indexes first: they are pure additions and cannot fail on data, so getting
  // them in before the constraint work means a constraint problem cannot leave
  // them unapplied.
  for (const entry of indexPlan) await applyIndex(entry);
  for (const entry of fkPlan) await applyForeignKey(entry);

  console.log(
    "\nDone. Now record the migration in production's history:\n" +
      '  DIRECT_URL="<session pooler URL>" npx prisma migrate resolve ' +
      "--applied 20260814120000_missing_fk_indexes"
  );
}

try {
  await main();
} catch (e) {
  console.error("Migration failed:", e?.message ?? e);
  if (e?.code) console.error(`  (error code ${e.code})`);
  console.error(
    dryRun
      ? "--dry-run: nothing was written."
      : "Anything reported with a ✔ above is committed; the step that failed rolled back. " +
          "The script is idempotent — fix the cause and re-run it."
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
