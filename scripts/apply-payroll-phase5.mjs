// Additive schema for Phase 5 payroll
// (docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md sections 2 and 3):
//
//   User.lastRateSyncAt   Last time this member's pay rate was CONFIRMED (via
//                         the Gusto CSV rate import or a manual edit on
//                         Company -> Team Members). Null = never confirmed.
//   User.payrollRevision  Monotonic counter, bumped on every payroll-affecting
//                         write (rate OR pay-type-only) — replay protection
//                         for the rate-import signature. lastRateSyncAt alone
//                         cannot do this, since a pay-type-only write must
//                         not move it (round-32 gate).
//   PayrollPeriod         A reviewed/exported pay period, half-open
//                         [periodStart, periodEnd). lockedAt freezes every
//                         time entry whose startTime falls inside it.
//
// ADD COLUMN / CREATE TABLE IF NOT EXISTS only — idempotent, no drops, safe
// while the previous build is live (the old build ignores both). Run BEFORE
// deploying the build that reads them, per CLAUDE.md "Schema migrations" (no
// `prisma db push` / `migrate dev` here — DIRECT_URL is IPv6-only). Then
// regenerate the client from PowerShell.
//   node scripts/apply-payroll-phase5.mjs
//
// Kept statement-for-statement in sync with
// prisma/migrations/20260901000000_payroll_phase5/migration.sql.
import { PrismaClient } from "@prisma/client";

/**
 * Which addresses this run is allowed to mark SALARY.
 *
 * NO DEFAULT, deliberately. An unset env var means nobody — the previous
 * revision defaulted to two hardcoded people, which is a migration script
 * guessing a pay type on nobody's authority. Exported so the rule can be tested
 * without a database.
 */
export function classifySalariedEmails(raw) {
    if (typeof raw !== "string") return [];
    return [
        ...new Set(
            raw
                .split(",")
                .map((email) => email.trim().toLowerCase())
                .filter(Boolean)
        ),
    ].sort();
}

/** `--dry-run` prints what the seed WOULD do and writes nothing. */
export const isDryRun = (argv = process.argv) => argv.includes("--dry-run");

import { config } from "dotenv";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The schema every object below is expected to live in. Same-named objects elsewhere are NOT this object. */
export const EXPECTED_SCHEMA = "public";

/**
 * Every object this script is responsible for, WITH ITS DEFINITION.
 *
 * Presence is not correctness. An index can exist on the wrong columns, a CHECK
 * can be altered to something weaker, a column can come back nullable, a DEFAULT
 * can be dropped, RLS can be switched off, and an object with the right name can
 * be sitting in another schema entirely — every one of those passes a bare
 * "does it exist" test while the guarantee it was written for is gone.
 *
 * COMPLETENESS is the other half, and it is the half that failed. The list used
 * to hold only the columns added by an `ALTER TABLE ... ADD COLUMN`, so
 * everything a `CREATE TABLE` brought with it was unverified — including
 * `PayrollPeriod.exportHash`, which src/lib/gusto-export-db.ts selects on every
 * export, and every primary key and DEFAULT in this migration. A verification
 * pass that does not name an object cannot report it missing, so the script
 * would have printed "verified N/N" against a database with no exportHash
 * column at all.
 *
 * The list is therefore the COMPLETE managed schema of
 * prisma/migrations/20260901000000_payroll_phase5/migration.sql: every table,
 * every column that migration creates (with type, nullability and default),
 * every primary key, every index (with its columns and uniqueness), every
 * CHECK/FK constraint, and every table it puts under RLS.
 * tests/payroll-apply-script-parity.test.ts parses that migration and fails the
 * build if anything it declares is absent here — so the list cannot drift
 * behind the SQL it describes.
 *
 * Used two ways: `--dry-run` reports what is missing or drifted (and prints
 * "nothing to do" when nothing is), and the normal run verifies the same list
 * after writing. One list, so the dry run and the real run cannot disagree
 * about what "applied" means.
 */
export const EXPECTED_OBJECTS = [
    { kind: "column", table: "User", name: "lastRateSyncAt", type: "timestamp with time zone", nullable: true },
    { kind: "column", table: "User", name: "payType", type: "text", nullable: true },
    // NOT NULL DEFAULT 0: the rate-import signature is keyed on this counter, so
    // a lost default would make every new row's revision NULL and the signature
    // unbuildable.
    { kind: "column", table: "User", name: "payrollRevision", type: "integer", nullable: false, default: "0" },

    { kind: "table", name: "PayrollPeriod" },
    // The CREATE TABLE columns, not just the ALTER-added ones. exportHash is the
    // case in point — selected by src/lib/gusto-export-db.ts and, until this
    // list was completed, verified by nothing.
    { kind: "column", table: "PayrollPeriod", name: "id", type: "text", nullable: false },
    { kind: "column", table: "PayrollPeriod", name: "periodStart", type: "timestamp with time zone", nullable: false },
    { kind: "column", table: "PayrollPeriod", name: "periodEnd", type: "timestamp with time zone", nullable: false },
    { kind: "column", table: "PayrollPeriod", name: "lockedAt", type: "timestamp with time zone", nullable: true },
    { kind: "column", table: "PayrollPeriod", name: "lockedById", type: "text", nullable: true },
    { kind: "column", table: "PayrollPeriod", name: "exportHash", type: "text", nullable: true },
    {
        kind: "column",
        table: "PayrollPeriod",
        name: "createdAt",
        type: "timestamp with time zone",
        nullable: false,
        default: "CURRENT_TIMESTAMP",
    },
    { kind: "constraint", table: "PayrollPeriod", name: "PayrollPeriod_pkey", contype: "p" },
    { kind: "column", table: "PayrollPeriod", name: "timeZone", type: "text", nullable: true },
    { kind: "column", table: "PayrollPeriod", name: "summaryCsvSnapshot", type: "text", nullable: true },
    { kind: "column", table: "PayrollPeriod", name: "detailCsvSnapshot", type: "text", nullable: true },
    { kind: "column", table: "PayrollPeriod", name: "periodStartKey", type: "text", nullable: true },
    { kind: "column", table: "PayrollPeriod", name: "periodEndKey", type: "text", nullable: true },
    { kind: "column", table: "PayrollPeriod", name: "discardedAt", type: "timestamp with time zone", nullable: true },
    { kind: "column", table: "PayrollPeriod", name: "discardedById", type: "text", nullable: true },
    { kind: "column", table: "PayrollPeriod", name: "discardedReason", type: "text", nullable: true },

    // Index COLUMNS, in order — a unique index on the wrong columns enforces the
    // wrong invariant while looking perfectly healthy.
    { kind: "index", table: "PayrollPeriod", name: "PayrollPeriod_periodStart_periodEnd_key", unique: true, columns: ["periodStart", "periodEnd"] },
    { kind: "index", table: "PayrollPeriod", name: "PayrollPeriod_periodStartKey_periodEndKey_key", unique: true, columns: ["periodStartKey", "periodEndKey"] },
    { kind: "index", table: "PayrollPeriod", name: "PayrollPeriod_lockedAt_idx", unique: false, columns: ["lockedAt"] },
    { kind: "index", table: "PayrollPeriod", name: "PayrollPeriod_lockedById_idx", unique: false, columns: ["lockedById"] },
    { kind: "index", table: "PayrollPeriod", name: "PayrollPeriod_discardedAt_idx", unique: false, columns: ["discardedAt"] },
    { kind: "index", table: "TimeEntry", name: "TimeEntry_startTime_idx", unique: false, columns: ["startTime"] },

    // CHECK expressions, normalised. "exists and is validated" is not enough:
    // a constraint rewritten to `CHECK (true)` is still present and still valid.
    // EVERY PART OF IT PINNED, not just "a foreign key of this name exists".
    // That was the whole check, and a same-named ON DELETE CASCADE passes it:
    // deleting the admin who locked a period would then delete the PayrollPeriod
    // row itself, taking the frozen exportHash and both CSV snapshots with it —
    // the immutable record of what payroll was actually paid. 'n' is SET NULL,
    // which keeps the period and forgets only who locked it. The referenced
    // table and both column lists are pinned too, because an FK of the right
    // name pointing at the wrong table (or the wrong column) enforces a
    // relationship nobody asked for while reading as healthy.
    {
        kind: "constraint",
        table: "PayrollPeriod",
        name: "PayrollPeriod_lockedById_fkey",
        contype: "f",
        onDelete: "n",
        references: "User",
        columns: ["lockedById"],
        refColumns: ["id"],
    },
    // Each `def` below is the constraint's WHOLE body, compared for exact
    // equality after normalizeCheckDef — not a bag of fragments that merely
    // have to appear somewhere in the actual text (round 12, finding 3).
    { kind: "constraint", table: "PayrollPeriod", name: "PayrollPeriod_range_check", contype: "c", def: '"periodEnd" > "periodStart"' },
    { kind: "constraint", table: "PayrollPeriod", name: "PayrollPeriod_keys_present", contype: "c", def: '"periodStartKey" IS NOT NULL AND "periodEndKey" IS NOT NULL' },
    { kind: "constraint", table: "PayrollPeriod", name: "PayrollPeriod_discard_unlocked", contype: "c", def: '"discardedAt" IS NULL OR "lockedAt" IS NULL' },
    // A LOCKED period carries its WHOLE frozen export, or it does not exist.
    // The export used to fall through to live data for a locked row with a null
    // snapshot; the loader now refuses, and this makes the row unrepresentable.
    // All four column names are pinned, so a constraint weakened to check only
    // one of them reads as drift.
    {
        kind: "constraint",
        table: "PayrollPeriod",
        name: "PayrollPeriod_locked_snapshot_complete",
        contype: "c",
        def: '"lockedAt" IS NULL OR ("summaryCsvSnapshot" IS NOT NULL AND "detailCsvSnapshot" IS NOT NULL AND "exportHash" IS NOT NULL)',
    },
    {
        kind: "constraint",
        table: "User",
        name: "User_payType_check",
        contype: "c",
        def: `"payType" IS NULL OR "payType" IN ('HOURLY', 'SALARY')`,
    },

    { kind: "column", table: "HelpRequest", name: "submissionId", type: "text", nullable: true },
    { kind: "column", table: "HelpRequest", name: "providerIssueRef", type: "text", nullable: true },
    // DEFAULT 'pending' is load-bearing: reserveHelpRequest's INSERT does not
    // name providerState, and a row that came out NULL reads as "never tried"
    // to some paths and "unknown" to others.
    { kind: "column", table: "HelpRequest", name: "providerState", type: "text", nullable: true, default: "'pending'" },
    { kind: "column", table: "HelpRequest", name: "providerLeaseToken", type: "text", nullable: true },
    { kind: "column", table: "HelpRequest", name: "providerLeaseExpiresAt", type: "timestamp with time zone", nullable: true },
    { kind: "index", table: "HelpRequest", name: "HelpRequest_userId_submissionId_key", unique: true, columns: ["userId", "submissionId"] },
    { kind: "index", table: "HelpRequest", name: "HelpRequest_userId_createdAt_idx", unique: false, columns: ["userId", "createdAt"] },

    { kind: "table", name: "HelpSubmissionQuota" },
    { kind: "column", table: "HelpSubmissionQuota", name: "id", type: "text", nullable: false },
    { kind: "column", table: "HelpSubmissionQuota", name: "userId", type: "text", nullable: false },
    { kind: "column", table: "HelpSubmissionQuota", name: "hourBucket", type: "timestamp with time zone", nullable: false },
    { kind: "column", table: "HelpSubmissionQuota", name: "count", type: "integer", nullable: false, default: "0" },
    {
        kind: "column",
        table: "HelpSubmissionQuota",
        name: "createdAt",
        type: "timestamp with time zone",
        nullable: false,
        default: "CURRENT_TIMESTAMP",
    },
    { kind: "constraint", table: "HelpSubmissionQuota", name: "HelpSubmissionQuota_pkey", contype: "p" },
    { kind: "index", table: "HelpSubmissionQuota", name: "HelpSubmissionQuota_userId_hourBucket_key", unique: true, columns: ["userId", "hourBucket"] },

    // Not created by a statement — CONVERTED. 'r' is RESTRICT; 'c' is the old
    // CASCADE that silently destroyed payroll history.
    {
        kind: "fk",
        table: "TimeEntry",
        name: "TimeEntry_userId_fkey",
        contype: "f",
        onDelete: "r",
        references: "User",
        columns: ["userId"],
        refColumns: ["id"],
    },
    {
        kind: "fk",
        table: "TimeEntry",
        name: "TimeEntry_projectId_fkey",
        contype: "f",
        onDelete: "r",
        references: "Project",
        columns: ["projectId"],
        refColumns: ["id"],
    },

    // RLS with ZERO policies is the intended state: it denies everything to any
    // role that does not bypass RLS. Prisma connects as the table owner (owners
    // bypass), so the app is unaffected — this only closes the door on a leaked
    // anon/authenticated key. A policy appearing here would REOPEN it, which is
    // why the expected count is asserted rather than "at least none".
    { kind: "rls", table: "PayrollPeriod", policies: 0 },
    { kind: "rls", table: "User", policies: 0 },
    { kind: "rls", table: "HelpSubmissionQuota", policies: 0 },
    // Adversarial review: these two were missing RLS/REVOKE entirely, so a
    // leaked anon/authenticated Supabase key could read raw payroll hours and
    // crew help reports straight through PostgREST.
    { kind: "rls", table: "TimeEntry", policies: 0 },
    { kind: "rls", table: "HelpRequest", policies: 0 },
];

/** Collapse whitespace so a catalog definition can be compared to a written one. */
function squash(text) {
    return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Compare a DEFAULT the way Postgres means it, not the way it happens to print.
 *
 * `DEFAULT 'pending'` on a text column comes back as `'pending'::text`, and
 * `DEFAULT CURRENT_TIMESTAMP` may come back as either `CURRENT_TIMESTAMP` or
 * `now()` depending on the server. None of those differences change what the
 * column does, and pinning the exact spelling would make this check fail on a
 * healthy database — which is worse than not checking, because the next person
 * deletes the assertion. What it still catches is the thing that matters: a
 * DEFAULT that was dropped, or changed to a different value.
 *
 * Exported so the parity test compares the migration's written defaults with
 * EXPECTED_OBJECTS using this exact rule rather than a second, divergent one.
 */
export function normalizeDefault(text) {
    let value = squash(text).toLowerCase();
    if (!value) return "";
    // Strip the type casts Postgres appends when it renders a default.
    value = value.replace(/::[a-z0-9_ "]+(\[\])?/g, "");
    // And the parentheses it sometimes wraps an expression in.
    while (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1).trim();
    if (value === "now()") return "current_timestamp";
    return value;
}

/**
 * Compare a CHECK constraint's definition the way Postgres MEANS it, not by
 * whether every expected FRAGMENT happens to appear somewhere in the actual
 * text (round 12, finding 3).
 *
 * A substring check — "is every expected piece IN the actual definition" —
 * passes an AND->OR flip, an IN->NOT IN flip, and a dropped clause, because
 * every original word can still be found inside a different, WEAKER
 * expression built from a superset of the same tokens: `A AND B AND C`
 * contains the substrings "A", "B" and "C" just as much as `A OR B OR C`
 * does. This compares the WHOLE normalized expression for exact equality
 * instead, so any of those three mutations changes the compared string.
 *
 * Postgres's own printer (`pg_get_constraintdef`) does not print back what a
 * human wrote:
 *   - it wraps every operand of AND/OR in its own redundant parentheses.
 *     Harmless to strip here — every constraint this script owns only mixes
 *     AND/OR/comparisons, and AND already binds tighter than OR in standard
 *     SQL precedence, so removing ALL parentheses changes no constraint's
 *     actual meaning; it only removes the noise;
 *   - it rewrites `x IN (a, b)` as `x = ANY (ARRAY[a, b])` and
 *     `x NOT IN (a, b)` as `x <> ALL (ARRAY[a, b])`;
 *   - it appends a `::text` cast to every string literal in that array.
 *
 * This function undoes all three, so EXPECTED_OBJECTS can keep reading like
 * the migration SQL that created the constraint (`... IN ('HOURLY', 'SALARY')`)
 * while still comparing, post-normalization, against what Postgres actually
 * has stored — verified against a real PostgreSQL 16 instance, not guessed.
 *
 * Order matters: the IN/NOT IN rewrite has to run BEFORE parentheses are
 * stripped — it needs them to find the list's boundary.
 *
 * Exported so tests/payroll-schema-drift-db.test.ts can assert the mutation
 * cases directly, without a database.
 */
export function normalizeCheckDef(text) {
    let value = String(text ?? "").trim();
    // The leading keyword every pg_get_constraintdef() result starts with. A
    // hand-written EXPECTED_OBJECTS entry never has it, so this is a no-op on
    // that side — both inputs converge on the same normalized shape either way.
    value = value.replace(/^check\s*/i, "");
    value = value.replace(/("(?:[^"]+)")\s+NOT\s+IN\s*\(([^)]*)\)/gi, "$1 <> ALL (ARRAY[$2])");
    value = value.replace(/("(?:[^"]+)")\s+IN\s*\(([^)]*)\)/gi, "$1 = ANY (ARRAY[$2])");
    // The cast Postgres appends to every element of an ARRAY[...] literal.
    value = value.replace(/::"?[A-Za-z_][A-Za-z0-9_]*"?/g, "");
    // ALL parentheses — see the header comment for why this is safe here.
    value = value.replace(/[()]/g, "");
    value = value.toLowerCase();
    return value.replace(/\s+/g, " ").trim();
}

/**
 * Read-only. Returns everything that is missing OR whose definition has drifted,
 * as `{ object, reason, actual }`.
 *
 * Every lookup is SCHEMA-QUALIFIED. `to_regclass('"User"')` resolves through the
 * search_path, so a table of the same name in another schema would answer for
 * the real one — which is exactly how a drift check reports healthy while the
 * object it is describing is not the one the application uses.
 */
export async function findSchemaDrift(db, expected = EXPECTED_OBJECTS, schema = EXPECTED_SCHEMA) {
    const drift = [];
    const miss = (object, reason, actual) => drift.push({ object, reason, actual });

    for (const object of expected) {
        if (object.kind === "table") {
            const rows = await db.$queryRawUnsafe(
                `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
                schema,
                object.name
            );
            if (rows.length === 0) miss(object, "missing");
            continue;
        }

        if (object.kind === "column") {
            const rows = await db.$queryRawUnsafe(
                `SELECT data_type, is_nullable, column_default
                   FROM information_schema.columns
                  WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
                schema,
                object.table,
                object.name
            );
            if (rows.length === 0) {
                miss(object, "missing");
                continue;
            }
            const [row] = rows;
            if (object.type && row.data_type !== object.type) {
                miss(object, `type is ${row.data_type}, expected ${object.type}`, row.data_type);
                continue;
            }
            if (object.nullable !== undefined) {
                const nullable = row.is_nullable === "YES";
                if (nullable !== object.nullable) {
                    miss(object, `nullability is ${nullable}, expected ${object.nullable}`, row.is_nullable);
                    continue;
                }
            }
            if (
                object.default !== undefined &&
                normalizeDefault(row.column_default) !== normalizeDefault(object.default)
            ) {
                miss(object, `default is ${row.column_default}, expected ${object.default}`, row.column_default);
            }
            continue;
        }

        if (object.kind === "index") {
            const rows = await db.$queryRawUnsafe(
                `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
                schema,
                object.name
            );
            if (rows.length === 0) {
                miss(object, "missing");
                continue;
            }
            const indexdef = squash(rows[0].indexdef);
            // The table it is actually ON — an index of the right name on the
            // wrong table indexes nothing this script cares about.
            if (object.table && !new RegExp(`ON ${schema}\\."${object.table}"`).test(indexdef)) {
                miss(object, `not on ${object.table}`, indexdef);
                continue;
            }
            if (object.unique !== undefined) {
                const isUnique = /CREATE UNIQUE INDEX/.test(indexdef);
                if (isUnique !== object.unique) {
                    miss(object, `unique is ${isUnique}, expected ${object.unique}`, indexdef);
                    continue;
                }
            }
            if (object.columns) {
                const inside = indexdef.slice(indexdef.indexOf("("), indexdef.lastIndexOf(")") + 1);
                const actual = inside
                    .replace(/^\(|\)$/g, "")
                    .split(",")
                    .map((part) => part.trim().replace(/^"|"$/g, "").split(" ")[0].replace(/^"|"$/g, ""));
                const same =
                    actual.length === object.columns.length &&
                    actual.every((column, i) => column === object.columns[i]);
                if (!same) {
                    miss(object, `columns are [${actual.join(", ")}], expected [${object.columns.join(", ")}]`, indexdef);
                }
            }
            continue;
        }

        if (object.kind === "constraint" || object.kind === "fk") {
            // conkey/confkey are attnum arrays, resolved to NAMES here and kept in
            // KEY ORDER (`WITH ORDINALITY`, not attnum order) — a two-column FK
            // declared the other way round is a different constraint. confrelid
            // is 0 for a non-FK, so the referenced class is LEFT JOINed and its
            // SCHEMA is read alongside the name: a decoy "User" in another
            // schema would otherwise answer for the real one.
            const rows = await db.$queryRawUnsafe(
                `SELECT c.convalidated, c.confdeltype, c.contype, pg_get_constraintdef(c.oid) AS def,
                        rt.relname AS reftable, rn.nspname AS refschema,
                        (SELECT array_agg(a.attname ORDER BY k.ord)
                           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
                        (SELECT array_agg(a.attname ORDER BY k.ord)
                           FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols
                   FROM pg_constraint c
                   JOIN pg_class t ON t.oid = c.conrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                   LEFT JOIN pg_class rt ON rt.oid = c.confrelid
                   LEFT JOIN pg_namespace rn ON rn.oid = rt.relnamespace
                  WHERE n.nspname = $1 AND t.relname = $2 AND c.conname = $3`,
                schema,
                object.table,
                object.name
            );
            if (rows.length === 0) {
                miss(object, "missing");
                continue;
            }
            const [row] = rows;
            // 'p' PRIMARY KEY, 'c' CHECK, 'f' FOREIGN KEY, 'u' UNIQUE. A primary
            // key replaced by a same-named CHECK exists, validates, and enforces
            // nothing about row identity.
            if (object.contype && row.contype !== object.contype) {
                miss(object, `is a '${row.contype}' constraint, expected '${object.contype}'`, row.def);
                continue;
            }
            // NOT VALID is not enforcement: existing rows are exempt, so prod
            // would silently disagree with a replay of the same migration.
            if (!row.convalidated) {
                miss(object, "NOT VALID — not enforced for existing rows", row.def);
                continue;
            }
            if (object.onDelete && row.confdeltype !== object.onDelete) {
                miss(object, `ON DELETE is '${row.confdeltype}', expected '${object.onDelete}'`, row.def);
                continue;
            }
            // WHAT it points at. Schema-qualified for the same reason every
            // other lookup here is: a same-named table in another schema is not
            // this table.
            if (object.references) {
                if (row.reftable !== object.references || row.refschema !== schema) {
                    miss(
                        object,
                        `references ${row.refschema ?? "?"}.${row.reftable ?? "nothing"}, expected ${schema}.${object.references}`,
                        row.def
                    );
                    continue;
                }
            }
            // ...and WHICH columns, on both sides, in order.
            const listMismatch = (actual, expected) => {
                const list = Array.isArray(actual) ? actual : [];
                return list.length !== expected.length || list.some((name, i) => name !== expected[i]);
            };
            if (object.columns && listMismatch(row.cols, object.columns)) {
                miss(
                    object,
                    `columns are [${(row.cols ?? []).join(", ")}], expected [${object.columns.join(", ")}]`,
                    row.def
                );
                continue;
            }
            if (object.refColumns && listMismatch(row.refcols, object.refColumns)) {
                miss(
                    object,
                    `referenced columns are [${(row.refcols ?? []).join(", ")}], expected [${object.refColumns.join(", ")}]`,
                    row.def
                );
                continue;
            }
            if (object.def) {
                // EXACT equality on the whole normalized expression — not "does
                // every expected fragment appear somewhere in the actual text".
                // A substring check passes an AND->OR flip, an IN->NOT IN flip,
                // and a dropped clause; see normalizeCheckDef's header for why.
                const actualNorm = normalizeCheckDef(row.def);
                const expectedNorm = normalizeCheckDef(object.def);
                if (actualNorm !== expectedNorm) {
                    miss(
                        object,
                        `definition drifted: actual "${actualNorm}" != expected "${expectedNorm}"`,
                        row.def
                    );
                }
            }
            continue;
        }

        if (object.kind === "rls") {
            const rows = await db.$queryRawUnsafe(
                `SELECT c.relrowsecurity, c.relforcerowsecurity,
                        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
                   FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = $1 AND c.relname = $2`,
                schema,
                object.table
            );
            if (rows.length === 0) {
                miss(object, "table missing");
                continue;
            }
            const [row] = rows;
            if (!row.relrowsecurity) {
                miss(object, "ROW LEVEL SECURITY is DISABLED", row.relrowsecurity);
                continue;
            }
            if (object.policies !== undefined && row.policies !== object.policies) {
                // Zero policies IS the deny-all. A policy appearing here reopens
                // the door a leaked anon key would come through.
                miss(object, `${row.policies} polic(ies), expected ${object.policies}`, row.policies);
            }
            continue;
        }

        miss(object, `unknown kind ${object.kind}`);
    }

    return drift;
}

/** Back-compat name: the dry run and the verifier both want the drift list. */
export async function findMissingObjects(db, expected = EXPECTED_OBJECTS) {
    return findSchemaDrift(db, expected);
}

/**
 * The verdict a drift list implies — the one line to print, and the exit code.
 *
 * Both modes go through here so they cannot disagree. `--dry-run` used to
 * print its drift and then exit 0, which made it useless as the thing it is
 * documented to be: the verification step of a deploy. A CI job or a deploy
 * script reads the exit code, so "production matches this branch" and
 * "production is missing four objects" looked identical to every caller that
 * was not a human reading stdout.
 *
 * Pure, and exported, so the exit-code contract can be tested without a
 * database (tests/payroll-apply-script-parity.test.ts).
 */
export function driftVerdict(drift, total = EXPECTED_OBJECTS.length) {
    if (drift.length === 0) {
        return {
            exitCode: 0,
            line: `verified ${total}/${total} objects present and matching their expected definitions (columns, index columns, CHECK expressions, FK ON DELETE, RLS).`,
        };
    }
    return {
        exitCode: 1,
        line: `FAILED: ${drift.length} drift item(s) — ${drift.length} of ${total} object(s) are missing or drifted.`,
    };
}

const STATEMENTS = [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastRateSyncAt" TIMESTAMPTZ(6)`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "payType" TEXT`,
    `CREATE TABLE IF NOT EXISTS "PayrollPeriod" (
        "id" TEXT NOT NULL,
        "periodStart" TIMESTAMPTZ(6) NOT NULL,
        "periodEnd" TIMESTAMPTZ(6) NOT NULL,
        "lockedAt" TIMESTAMPTZ(6),
        "lockedById" TEXT,
        "exportHash" TEXT,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_periodStart_periodEnd_key" ON "PayrollPeriod"("periodStart", "periodEnd")`,
    `CREATE INDEX IF NOT EXISTS "PayrollPeriod_lockedAt_idx" ON "PayrollPeriod"("lockedAt")`,
    `CREATE INDEX IF NOT EXISTS "PayrollPeriod_lockedById_idx" ON "PayrollPeriod"("lockedById")`,
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "timeZone" TEXT`,
    // The exported CSVs, frozen at lock time. A locked period is served from
    // these verbatim rather than recomputed — the CSVs are built from mutable
    // inputs (name, email, payType, Gusto id mapping, a punch's project and
    // cost code after logistics recoding) and would not reproduce.
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "summaryCsvSnapshot" TEXT`,
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "detailCsvSnapshot" TEXT`,
    // Stable identity — see the matching migration.
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "periodStartKey" TEXT`,
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "periodEndKey" TEXT`,
    `UPDATE "PayrollPeriod"
     SET "periodStartKey" = to_char("periodStart" AT TIME ZONE COALESCE("timeZone", 'America/Los_Angeles'), 'YYYY-MM-DD'),
         "periodEndKey"   = to_char("periodEnd"   AT TIME ZONE COALESCE("timeZone", 'America/Los_Angeles'), 'YYYY-MM-DD')
     WHERE "periodStartKey" IS NULL OR "periodEndKey" IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_periodStartKey_periodEndKey_key" ON "PayrollPeriod"("periodStartKey", "periodEndKey")`,
    // Every payroll read is a startTime RANGE scan; no FK index serves that.
    `CREATE INDEX IF NOT EXISTS "TimeEntry_startTime_idx" ON "TimeEntry"("startTime")`,
    // ADD CONSTRAINT has no IF NOT EXISTS — guard it so a replay is a no-op.
    `DO $$
     BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_lockedById_fkey') THEN
            ALTER TABLE "PayrollPeriod"
                ADD CONSTRAINT "PayrollPeriod_lockedById_fkey"
                FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
     END $$`,
    // ---- Integrity + RLS (review round 5, items 7 and 9) ----------------
    // CHECKs because payType and the period bounds are money-critical and
    // reachable from several code paths; Prisma cannot see them, so they are
    // also recorded in prisma/prisma-blind-spots.json.
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_payType_check' AND conrelid = '"User"'::regclass) THEN
            ALTER TABLE "User" ADD CONSTRAINT "User_payType_check" CHECK ("payType" IS NULL OR "payType" IN ('HOURLY', 'SALARY'));
        END IF;
     END $$`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_range_check' AND conrelid = '"PayrollPeriod"'::regclass) THEN
            ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_range_check" CHECK ("periodEnd" > "periodStart");
        END IF;
     END $$`,
    // NOT VALID: new rows must carry the stable keys, legacy rows are backfilled
    // above and never fail the migration.
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_keys_present' AND conrelid = '"PayrollPeriod"'::regclass) THEN
            ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_keys_present" CHECK ("periodStartKey" IS NOT NULL AND "periodEndKey" IS NOT NULL) NOT VALID;
        END IF;
     END $$`,
    // The key backfill above filled every legacy row, so validate it: a
    // permanently NOT VALID constraint has never checked anything, and it is a
    // real difference from production. VALIDATE takes only SHARE UPDATE
    // EXCLUSIVE, so it blocks neither reads nor writes.
    `ALTER TABLE "PayrollPeriod" VALIDATE CONSTRAINT "PayrollPeriod_keys_present"`,
    // A leaked anon/authenticated Supabase key must not read payroll periods,
    // their frozen CSVs, or the pay columns on User. Prisma connects as the
    // table OWNER and owners bypass RLS, so the app is unaffected; the Supabase
    // client here is storage-only (CLAUDE.md), so nothing reads these through
    // the Data API.
    `ALTER TABLE "PayrollPeriod" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "User" ENABLE ROW LEVEL SECURITY`,
    // The Supabase roles do not exist on a vanilla Postgres and REVOKE on a
    // missing role is a hard error — guarded so CI's throwaway DB runs the same
    // statements.
    `DO $$
     BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON TABLE "PayrollPeriod" FROM anon;
            REVOKE ALL ON TABLE "User" FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON TABLE "PayrollPeriod" FROM authenticated;
            REVOKE ALL ON TABLE "User" FROM authenticated;
        END IF;
     END $$`,
    // ---- Help-widget throttle + idempotency (round 6, item 6) -----------
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "submissionId" TEXT`,
    // Whether the GitHub issue exists yet — `status` could not tell "never
    // tried" from "tried and finished".
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerIssueRef" TEXT`,
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerState" TEXT DEFAULT 'pending'`,
    // CAS lease over the provider call — see the matching migration.
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerLeaseToken" TEXT`,
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerLeaseExpiresAt" TIMESTAMPTZ(6)`,
    // Unique PER USER — a global key would collide across users and hand back
    // somebody else's report.
    `CREATE UNIQUE INDEX IF NOT EXISTS "HelpRequest_userId_submissionId_key" ON "HelpRequest"("userId", "submissionId")`,
    `CREATE INDEX IF NOT EXISTS "HelpRequest_userId_createdAt_idx" ON "HelpRequest"("userId", "createdAt")`,
    `CREATE TABLE IF NOT EXISTS "HelpSubmissionQuota" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "hourBucket" TIMESTAMPTZ(6) NOT NULL,
        "count" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "HelpSubmissionQuota_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "HelpSubmissionQuota_userId_hourBucket_key" ON "HelpSubmissionQuota"("userId", "hourBucket")`,
    `ALTER TABLE "HelpSubmissionQuota" ENABLE ROW LEVEL SECURITY`,
    `DO $$
     BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON TABLE "HelpSubmissionQuota" FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON TABLE "HelpSubmissionQuota" FROM authenticated;
        END IF;
     END $$`,
    // Adversarial review: RLS/REVOKE were applied above to PayrollPeriod, User
    // and HelpSubmissionQuota but NOT to TimeEntry or HelpRequest — a leaked
    // anon/authenticated Supabase key could read raw payroll hours and crew
    // help reports straight through PostgREST. Prisma connects as the table
    // owner, so the app is unaffected.
    `ALTER TABLE "TimeEntry" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "HelpRequest" ENABLE ROW LEVEL SECURITY`,
    `DO $$
     BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON TABLE "TimeEntry" FROM anon;
            REVOKE ALL ON TABLE "HelpRequest" FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON TABLE "TimeEntry" FROM authenticated;
            REVOKE ALL ON TABLE "HelpRequest" FROM authenticated;
        END IF;
     END $$`,
];

/**
 * DO NOT run any of this at import time.
 *
 * The env loading below reads .env.production.local, so merely importing this
 * file used to load PRODUCTION credentials and then execute every statement
 * against them. That is not hypothetical: it happened on 2026-09-02 when a test
 * imported the module to reach classifySalariedEmails, and the whole Phase 5
 * migration ran against production as a side effect of the import.
 *
 * Everything with a side effect now lives in main(), which only runs when this
 * file is the entrypoint. The exported helpers above are pure and safe to
 * import.
 */
async function main() {
    config({ path: join(__dirname, "..", ".env.production.local") });
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL is not set (.env.production.local missing?).");
        process.exit(1);
    }

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const dryRun = isDryRun();

    try {
        // --dry-run is READ-ONLY, for the whole script — not just the seed.
        //
        // It is the verification step for a deploy, so it has to be safe to point
        // at production. An earlier revision gated only the payType seed on this
        // flag and executed every DDL statement regardless, which made "--dry-run"
        // a lie in the one place it mattered most.
        if (dryRun) {
            const drift = await findSchemaDrift(prisma);
            if (drift.length === 0) {
                console.log(
                    `[dry-run] nothing to do — all ${EXPECTED_OBJECTS.length} objects this script manages are present AND match their expected definitions.`
                );
            } else {
                console.log(`[dry-run] ${drift.length} of ${EXPECTED_OBJECTS.length} object(s) are missing or drifted:`);
                for (const { object, reason, actual } of drift) {
                    const label = `${object.kind} ${object.table ? object.table + "." : ""}${object.name ?? object.table}`;
                    console.log(`[dry-run]   ${label}: ${reason}`);
                    if (actual !== undefined && reason !== "missing") console.log(`[dry-run]     actual: ${actual}`);
                }
            }

            const salariedPreview = classifySalariedEmails(process.env.PAYROLL_SALARIED_EMAILS);
            if (!salariedPreview.length) {
                console.log("[dry-run] PAYROLL_SALARIED_EMAILS is not set — no payType would be seeded.");
            } else {
                const would = await prisma.$queryRawUnsafe(
                    `SELECT "email" FROM "User" WHERE "payType" IS NULL AND lower("email") = ANY($1::text[]) ORDER BY "email"`,
                    salariedPreview
                );
                console.log(`[dry-run] would set payType = SALARY for ${would.length} user(s):`);
                for (const row of would) console.log(`[dry-run]   ${row.email}`);
                const unmatched = salariedPreview.filter(
                    (email) => !would.some((row) => String(row.email).toLowerCase() === email)
                );
                if (unmatched.length) {
                    console.log(`[dry-run] ${unmatched.length} listed address(es) matched no NULL-payType user: ${unmatched.join(", ")}`);
                }
            }
            console.log("[dry-run] no statement was executed.");
            // Drift is a FAILURE here, not a report. Read-only is about what the
            // database ends up holding, not about the exit code — a verification
            // step that always succeeds verifies nothing.
            //
            // process.exitCode rather than process.exit() so the `finally` below
            // still runs and the Prisma connection closes; the process then exits
            // 1 on its own once main() returns.
            const verdict = driftVerdict(drift);
            if (verdict.exitCode !== 0) {
                console.error(verdict.line);
                process.exitCode = verdict.exitCode;
            }
            return;
        }

        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
            console.log("ok:", sql.split("\n")[0].trim().slice(0, 90));
        }
        // NO endTime backfill — see the note in the matching migration. Synthesising
        // a span for a manual entry makes WA meal settlement treat PAID hours as a
        // RAW span, deduct a meal it never owed, and reprice it at the member's
        // current rate. The readers were fixed instead.

        // User.payType is left NULL for anyone nobody has confirmed.
        //
        // An earlier revision also stamped every ACTIVATED crew member and manager
        // as HOURLY. That defeated the whole point of the column: stored values beat
        // the env fallback, so a salaried manager omitted from
        // PAYROLL_SALARIED_EMAILS would have been permanently marked hourly, and
        // later fixing the env var would have changed nothing — Gusto would pay them
        // a salary AND the exported hours. NULL blocks the export until a human
        // answers on Company -> Team Members, which is the fail-closed behaviour the
        // column exists for.
        //
        // The SALARY seed only ever moves a row in the SAFE direction (excluded from
        // the summary = cannot be double-paid), only for emails an operator
        // EXPLICITLY listed, and never over an existing answer.
        //
        // It used to default that list to two named people when the env var was
        // unset. That is the same guess the NULL column exists to prevent, just
        // aimed the other way: a migration script deciding, on nobody's authority,
        // that two specific humans are salaried. If either had actually been hourly
        // the export would have silently dropped their hours. No env var, no seed.
        const salaried = classifySalariedEmails(process.env.PAYROLL_SALARIED_EMAILS);
        if (!salaried.length) {
            console.log(
                "PAYROLL_SALARIED_EMAILS is not set — no payType is being seeded. Everyone stays NULL until a human answers on Company -> Team Members."
            );
        } else {
            const seededSalary = await prisma.$executeRawUnsafe(
                `UPDATE "User" SET "payType" = 'SALARY' WHERE "payType" IS NULL AND lower("email") = ANY($1::text[])`,
                salaried
            );
            console.log(`seeded ${seededSalary} user(s) to payType = SALARY from PAYROLL_SALARIED_EMAILS`);
        }
        const unconfirmed = await prisma.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "User" WHERE "payType" IS NULL AND "status" = 'ACTIVATED'`
        );
        console.log(
            `${unconfirmed[0].n} activated user(s) still have no payType — the payroll export will refuse to run for anyone with hours until they are set on Company -> Team Members. This is intentional.`
        );

        // ----------------------------------------------------------------------
        // TimeEntry no longer cascades from User or Project (review round 16).
        // Idempotent on confdeltype: 'c' is CASCADE, 'r' is RESTRICT, so a second
        // run finds 'r' and does nothing.
        // ----------------------------------------------------------------------
        await prisma.$executeRawUnsafe(`
            DO $$
            DECLARE
                fk RECORD;
            BEGIN
                FOR fk IN
                    SELECT unnest(ARRAY['TimeEntry_userId_fkey', 'TimeEntry_projectId_fkey']) AS name,
                           unnest(ARRAY['userId', 'projectId'])                               AS col,
                           unnest(ARRAY['User', 'Project'])                                   AS parent
                LOOP
                    IF EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = fk.name
                          AND conrelid = '"TimeEntry"'::regclass
                          AND confdeltype = 'c'
                    ) THEN
                        EXECUTE format('ALTER TABLE "TimeEntry" DROP CONSTRAINT %I', fk.name);
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = fk.name AND conrelid = '"TimeEntry"'::regclass
                    ) THEN
                        EXECUTE format(
                            'ALTER TABLE "TimeEntry" ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I("id") ON DELETE RESTRICT ON UPDATE CASCADE',
                            fk.name, fk.col, fk.parent
                        );
                    END IF;
                END LOOP;
            END $$;
        `);
        const cascading = await prisma.$queryRawUnsafe(
            `SELECT conname FROM pg_constraint
              WHERE conrelid = '"TimeEntry"'::regclass AND confdeltype = 'c'
                AND conname IN ('TimeEntry_userId_fkey', 'TimeEntry_projectId_fkey')`
        );
        console.log(`TimeEntry parent FKs still cascading: ${cascading.length} (expected 0)`);
        if (cascading.length !== 0) process.exit(1);

        // ----------------------------------------------------------------------
        // A wrong-range period is DISCARDED, not deleted (review round 16, item 6).
        // Unlocking leaves the row behind and every overlap check then refuses the
        // corrected range forever, so there was no way back from a typo.
        //
        // These three columns, the index and the CHECK shipped in the migration but
        // NOT here for one commit — a prod run of this script would have left the
        // discard action writing to columns that did not exist. tests/
        // payroll-apply-script-parity.test.ts now fails the build if the two files
        // ever diverge again.
        // ----------------------------------------------------------------------
        await prisma.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "discardedAt" TIMESTAMPTZ(6)`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "discardedById" TEXT`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "discardedReason" TEXT`);
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "PayrollPeriod_discardedAt_idx" ON "PayrollPeriod"("discardedAt")`
        );
        // A LOCKED period is never discarded: that would retire hours already
        // exported and paid, and every reader would stop seeing the freeze that
        // protects them. VALIDATE, not NOT VALID — an unvalidated constraint is not
        // enforced for existing rows, so prod would disagree with CI's replay.
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_discard_unlocked"`
        );
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_discard_unlocked"
                CHECK ("discardedAt" IS NULL OR "lockedAt" IS NULL) NOT VALID`
        );
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" VALIDATE CONSTRAINT "PayrollPeriod_discard_unlocked"`
        );

        // ----------------------------------------------------------------------
        // Round-6 gate, finding 4: a LOCKED period carries its WHOLE frozen
        // export, or it does not exist.
        //
        // The download endpoint served a locked period from its snapshot only
        // when both csv columns were non-null. A row with lockedAt set and a
        // null snapshot produced "no snapshot" while still counting as the exact
        // locked period, so the overlap refusal did not fire either and the
        // endpoint fell through to a freshly recomputed LIVE csv — the one case
        // where live data is definitely the wrong answer. The loader now refuses
        // such a row; this makes it unrepresentable.
        //
        // VALIDATE, not NOT VALID, for the same reason as every other CHECK
        // here: an unvalidated constraint exempts existing rows, so prod would
        // disagree with CI's replay. If this VALIDATE ever fails, a malformed
        // locked period really is in the table and has to be looked at before
        // the fix can ship — which is the correct outcome, not an obstacle.
        // ----------------------------------------------------------------------
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_locked_snapshot_complete"`
        );
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_locked_snapshot_complete"
                CHECK (
                    "lockedAt" IS NULL
                    OR ("summaryCsvSnapshot" IS NOT NULL AND "detailCsvSnapshot" IS NOT NULL AND "exportHash" IS NOT NULL)
                ) NOT VALID`
        );
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" VALIDATE CONSTRAINT "PayrollPeriod_locked_snapshot_complete"`
        );

        // ----------------------------------------------------------------------
        // Round-32 gate: lastRateSyncAt reverts to meaning "a rate was actually
        // CONFIRMED" (a pay-type-only write must not move it), which reopens the
        // replay hole it used to close for a concurrent pay-type-only change.
        // payrollRevision is a plain monotonic counter, bumped on EVERY
        // payroll-affecting write regardless of which fields it touches, and the
        // rate-import signature is keyed on it instead.
        // ----------------------------------------------------------------------
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "payrollRevision" INTEGER NOT NULL DEFAULT 0`
        );

        // ONE verification, against the SAME list the dry run reports on.
        //
        // The ad-hoc count checks that used to live here ("5/5 discard bits",
        // "9/9 columns") only asked whether things EXISTED. An index on the
        // wrong columns, a CHECK rewritten to something weaker, RLS switched
        // off, or an object of the right name in another schema all passed
        // them — which is the same class of miss as the apply-script/migration
        // divergence this file already carries a test for.
        const drift = await findSchemaDrift(prisma);
        const verdict = driftVerdict(drift);
        if (verdict.exitCode !== 0) {
            console.error(verdict.line);
            for (const { object, reason, actual } of drift) {
                const label = `${object.kind} ${object.table ? object.table + "." : ""}${object.name ?? object.table}`;
                console.error(`  ${label}: ${reason}`);
                if (actual !== undefined && reason !== "missing") console.error(`    actual: ${actual}`);
            }
            process.exit(1);
        }
        console.log(verdict.line);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    await main();
}

