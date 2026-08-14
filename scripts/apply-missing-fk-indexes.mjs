// Applies prisma/migrations/20260814120000_missing_fk_indexes to PRODUCTION.
//
// The 2026-08-14 baseline was generated from production, so it records prod's
// real shape — including seven foreign keys and three indexes that
// prisma/schema.prisma declares but prod never had. That difference was checked
// in verbatim as prisma/EXPECTED_SCHEMA_GAP.sql. This script closes it.
//
// Run:  node scripts/apply-missing-fk-indexes.mjs
//       node scripts/apply-missing-fk-indexes.mjs --dry-run   # report only
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
// IDEMPOTENT. Every object is compared against pg_catalog before being touched,
// so a second run reports "already correct" and issues no DDL.
//
// LOCK BEHAVIOUR. Foreign keys are added NOT VALID (a metadata-only change that
// takes a brief ACCESS EXCLUSIVE lock and does not scan the table), then
// VALIDATE CONSTRAINT runs as a separate statement under SHARE UPDATE
// EXCLUSIVE, which does not block reads or writes. The drop and the re-add of a
// replaced constraint share one transaction, so enforcement is never absent.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env", ".env.local"]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const dryRun = process.argv.includes("--dry-run");
const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

// PostgreSQL's pg_constraint action codes. Comparing these is exact; comparing
// the rendered pg_get_constraintdef() text is not (it omits NO ACTION, reorders
// clauses, and drops quoting on lowercase identifiers).
const ACTION = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
const CODE = Object.fromEntries(Object.entries(ACTION).map(([k, v]) => [v, k]));

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
    // declared, so the Prisma client already assumes it.
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
    // reference a deleted User.
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

const q = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args);

// Reads the constraint's actual shape from the catalog: referenced table, the
// single column on each side, both referential actions, and whether it has been
// validated. Returns null when the constraint does not exist.
async function inspectForeignKey(fk) {
  const rows = await q(
    `SELECT c.conname                       AS name,
            c.confupdtype                   AS onupdate,
            c.confdeltype                   AS ondelete,
            c.convalidated                  AS validated,
            c.confrelid::regclass::text     AS reftable,
            (SELECT a.attname FROM pg_attribute a
              WHERE a.attrelid = c.conrelid  AND a.attnum = c.conkey[1])  AS col,
            (SELECT a.attname FROM pg_attribute a
              WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) AS refcol,
            array_length(c.conkey, 1)       AS ncols
       FROM pg_constraint c
      WHERE c.connamespace = 'public'::regnamespace
        AND c.contype = 'f'
        AND c.conrelid = $1::regclass
        AND c.conname = $2`,
    `"${fk.table}"`,
    fk.name
  );
  return rows[0] ?? null;
}

function foreignKeyMatches(fk, actual) {
  // regclass::text omits the schema when it is on search_path and includes it
  // when it is not, so strip an optional "public." rather than depending on the
  // connection's search_path. (Guessing wrong here is not dangerous — a false
  // mismatch just makes the script drop and re-add a constraint that was
  // already correct — but it would issue pointless DDL against production.)
  const refTable = actual.reftable.replace(/^public\./, '')
  return (
    actual.ncols === 1 &&
    actual.col === fk.column &&
    actual.refcol === fk.refColumn &&
    refTable === `"${fk.refTable}"` &&
    ACTION[actual.ondelete] === fk.onDelete &&
    ACTION[actual.onupdate] === fk.onUpdate &&
    actual.validated === true
  );
}

// A foreign key can only be validated if no row already violates it. The only
// constraint here that has never been enforced is Project_managerId_fkey, but
// checking all of them costs one indexed anti-join each and turns a mid-run
// VALIDATE failure into a clean refusal before any DDL is issued.
async function countOrphans(fk) {
  const rows = await q(
    `SELECT count(*)::int AS n
       FROM "${fk.table}" child
      WHERE child."${fk.column}" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "${fk.refTable}" parent
           WHERE parent."${fk.refColumn}" = child."${fk.column}")`
  );
  return rows[0].n;
}

async function main() {
  const plan = [];

  for (const fk of FOREIGN_KEYS) {
    const actual = await inspectForeignKey(fk);
    if (actual && foreignKeyMatches(fk, actual)) {
      console.log(`= ${fk.name}: already correct`);
      continue;
    }
    const action = actual ? "replace" : "create";
    const detail = actual
      ? `ON DELETE ${ACTION[actual.ondelete]} ON UPDATE ${ACTION[actual.onupdate]}` +
        `${actual.validated ? "" : " NOT VALID"} -> ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
      : `ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
    plan.push({ fk, action });
    console.log(`~ ${fk.name}: ${action} (${detail})`);
  }

  // Preflight every planned constraint before issuing any DDL.
  let blocked = false;
  for (const { fk } of plan) {
    const orphans = await countOrphans(fk);
    if (orphans > 0) {
      blocked = true;
      console.error(
        `✖ ${fk.name}: ${orphans} row(s) in "${fk.table}" have a "${fk.column}" with no matching ` +
          `"${fk.refTable}"."${fk.refColumn}". VALIDATE would fail. Clean these up first — this ` +
          `script will not guess whether to null them out or delete them.`
      );
    }
  }
  if (blocked) {
    console.error("\nAborted before any DDL was issued. Nothing was changed.");
    process.exitCode = 1;
    return;
  }

  const indexPlan = [];
  for (const ix of INDEXES) {
    const rows = await q(
      `SELECT 1 FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'i' AND c.relname = $1`,
      ix.name
    );
    if (rows.length) console.log(`= ${ix.name}: already present`);
    else {
      indexPlan.push(ix);
      console.log(`~ ${ix.name}: create on "${ix.table}"(${ix.columns.join(", ")})`);
    }
  }

  if (!plan.length && !indexPlan.length) {
    console.log("\nNothing to do — production already matches schema.prisma.");
    return;
  }
  if (dryRun) {
    console.log("\n--dry-run: no DDL issued.");
    return;
  }

  // Indexes first: ClientMessage_leadId_idx and the rest are pure additions and
  // cannot fail on data, so getting them in before the constraint work means a
  // constraint problem cannot leave them unapplied.
  for (const ix of indexPlan) {
    const cols = ix.columns.map((c) => `"${c}"`).join(", ");
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "${ix.name}" ON "${ix.table}" (${cols})`
    );
    console.log(`✔ created index ${ix.name}`);
  }

  for (const { fk, action } of plan) {
    const add =
      `ALTER TABLE "${fk.table}" ADD CONSTRAINT "${fk.name}" ` +
      `FOREIGN KEY ("${fk.column}") REFERENCES "${fk.refTable}"("${fk.refColumn}") ` +
      `ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate} NOT VALID`;

    // One transaction, so a replaced constraint is never absent: the old one is
    // dropped and the new one installed atomically. NOT VALID keeps the
    // ACCESS EXCLUSIVE lock to a catalog update rather than a full table scan.
    if (action === "replace") {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`ALTER TABLE "${fk.table}" DROP CONSTRAINT "${fk.name}"`),
        prisma.$executeRawUnsafe(add),
      ]);
    } else {
      await prisma.$executeRawUnsafe(add);
    }
    console.log(`✔ ${action}d ${fk.name} (NOT VALID)`);

    // Separate statement on purpose: VALIDATE takes only SHARE UPDATE EXCLUSIVE,
    // so the scan runs without blocking concurrent reads or writes.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${fk.table}" VALIDATE CONSTRAINT "${fk.name}"`
    );
    console.log(`✔ validated ${fk.name}`);
  }

  console.log(
    "\nDone. Now record the migration in production's history:\n" +
      '  DIRECT_URL="<session pooler URL>" npx prisma migrate resolve ' +
      "--applied 20260814120000_missing_fk_indexes"
  );
}

try {
  await main();
} catch (e) {
  console.error("Migration failed:", e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
