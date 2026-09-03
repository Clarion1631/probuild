// One-off additive migration for Phase 2 (docs/plans/PHASE-2-QUEUE-AND-MEMOS-SPEC.md):
//
//   1. BankLine."sourceOfRecord" — which source MINTED the canonical line.
//      Defaults to 'STATEMENT', which is true for every row that exists today,
//      so the backfill is the default and no UPDATE is needed. 'QBO' marks a
//      line minted by the nightly register pull because QuickBooks had a
//      posted, cleared row and no statement had arrived yet (Justin, decision
//      3: the QBO bank feed is bank truth). It flips back to 'STATEMENT' when
//      the statement observation lands and is adopted.
//
//   2. "ReceiptRequestCard" — the durable outbox for the per-owner Chat digest.
//      UNIQUE (owner, pacificDate) is the whole point: the row is created in
//      the same transaction as selection, so two concurrent cron runs cannot
//      both claim a day and both post.
//
// The SQL here is byte-equivalent to
// prisma/migrations/20260901120000_phase2_receipt_queue/migration.sql — that
// file is what a fresh CI/dev database gets; this script is what production
// gets, BEFORE the build that selects these columns deploys (CLAUDE.md
// pre-deploy rule #2 — otherwise every page touching them throws P2022).
//
// The CHECK on "sourceOfRecord" is invisible to Prisma (it has no
// check-constraint concept) and must be created here, not by the generator.
// It is not decoration: 'QBO' vs 'STATEMENT' decides whether a line is
// adoptable, and a typo'd third value would make a line permanently
// un-adoptable while looking fine.
//
// Additive and idempotent: ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT
// EXISTS plus a guarded constraint add. Safe to re-run; a second run reports
// every statement "ok" and changes nothing. No existing row is modified.
//
//   node scripts/apply-phase2-receipt-queue.mjs --yes --expect-db <name> --expect-host <host>
//
// --expect-db and --expect-host are BOTH required alongside --yes, matching
// scripts/apply-receipt-intake.mjs: "--yes" alone only proves you meant to run
// something, and a database NAME alone doesn't prove which SERVER it's on.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, from: "process.env.DATABASE_URL" };
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return { url: match[1], from: file };
    }
    throw new Error("DATABASE_URL not found in process.env, .env.local, or .env");
}

export function maskUrl(url) {
    return url.replace(/:[^:@]*@/, ":****@");
}

function readFlagValue(flag) {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/** Pure comparison, exported for unit testing without a live DB. Both values EXACT. */
export function targetMatches(actual, expectDb, expectHost) {
    if (!actual || typeof actual !== "object") return false;
    if (String(actual.db ?? "") !== String(expectDb ?? "")) return false;
    return String(actual.host ?? "") === String(expectHost ?? "");
}

/** The closed set the CHECK allows. Exported for tests. */
export const BANK_LINE_SOURCES_OF_RECORD = ["STATEMENT", "QBO"];

export const statements = [
    // 1. BankLine.sourceOfRecord. NOT NULL with a DEFAULT, so existing rows are
    // backfilled by the DDL itself — every line that exists today WAS minted
    // from a statement, so the default is a true statement about them.
    `ALTER TABLE "BankLine" ADD COLUMN IF NOT EXISTS "sourceOfRecord" TEXT NOT NULL DEFAULT 'STATEMENT'`,

    // CONVERGES ON THE DEFINITION, not just the name.
    //
    // `IF NOT EXISTS`-by-name is not idempotent for a constraint, it is merely
    // silent: a row created by an earlier revision of this script keeps ITS
    // definition forever, and every re-run reports "ok" while the database
    // enforces the old rule. That is the failure mode this whole file exists to
    // avoid — a check that looks applied and is not. So the definition is
    // compared with pg_get_constraintdef on the owning table and REPLACED when
    // it differs.
    `DO $$
     DECLARE current_def text;
     BEGIN
       SELECT pg_get_constraintdef(oid) INTO current_def
         FROM pg_constraint
        WHERE conname = 'BankLine_sourceOfRecord_check'
          AND conrelid = '"BankLine"'::regclass;
       IF current_def IS NULL THEN
         ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_sourceOfRecord_check" CHECK ("sourceOfRecord" IN ('STATEMENT', 'QBO'));
       -- COMPARED WITH THE QUOTES AND SPACES REMOVED FROM BOTH SIDES.
       -- pg_get_constraintdef QUOTES a camelCase identifier ("sourceOfRecord"), so a
       -- literal comparison against an unquoted expected string never matched: the
       -- ELSIF fired on EVERY application and dropped and re-added a constraint that
       -- was already correct — a table lock plus a full validation scan on each run,
       -- and a "converges on the definition" claim that in fact converged on nothing.
       ELSIF translate(current_def, '" ', '') <> translate('CHECK (("sourceOfRecord" = ANY (ARRAY[''STATEMENT''::text, ''QBO''::text])))', '" ', '') THEN
         ALTER TABLE "BankLine" DROP CONSTRAINT "BankLine_sourceOfRecord_check";
         ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_sourceOfRecord_check" CHECK ("sourceOfRecord" IN ('STATEMENT', 'QBO'));
       END IF;
     END $$`,

    // 1b. BankLineObservation.clearedStatus — what QuickBooks says about the
    // row's BANK CLEARANCE ('Reconciled' | 'Cleared' | 'Uncleared' | 'Unknown').
    //
    // NULLABLE WITH NO DEFAULT, deliberately. Every observation that exists
    // today was stored before anybody asked QuickBooks the question, so there
    // is no truthful backfill: NULL means "never asked", and the mint gate
    // (isClearedForMint) treats it exactly like "not cleared". Defaulting it to
    // 'Uncleared' would be a claim QuickBooks never made.
    //
    // No CHECK constraint: the closed set is enforced at the one boundary that
    // writes it (isClearedStatusValue, in the ingest route), and a CHECK here
    // would turn a future fifth QuickBooks value into a nightly-pull outage
    // rather than a row that simply does not mint.
    `ALTER TABLE "BankLineObservation" ADD COLUMN IF NOT EXISTS "clearedStatus" TEXT`,

    // Adoption looks lines up by (account, postedDate, amountCents,
    // normalizedPayee) and then filters on sourceOfRecord — index the lookup,
    // not the flag.
    `CREATE INDEX IF NOT EXISTS "BankLine_account_postedDate_amountCents_idx"
       ON "BankLine"("account", "postedDate", "amountCents")`,

    // 2. The Chat digest outbox.
    `CREATE TABLE IF NOT EXISTS "ReceiptRequestCard" (
       "id"          TEXT NOT NULL,
       "owner"       TEXT NOT NULL,
       "pacificDate" TEXT NOT NULL,
       "itemsJson"   TEXT NOT NULL,
       "overflow"    INTEGER NOT NULL DEFAULT 0,
       "postedAt"    TIMESTAMP(3),
       "threadName"  TEXT,
       "messageName" TEXT,
       "attempts"    INTEGER NOT NULL DEFAULT 0,
       "lastError"   TEXT,
       "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"   TIMESTAMP(3) NOT NULL,
       CONSTRAINT "ReceiptRequestCard_pkey" PRIMARY KEY ("id")
     )`,

    // THE CLAIM. One card per owner per Pacific day; the insert IS the lock, so
    // a second concurrent run loses it and posts nothing.
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptRequestCard_owner_pacificDate_key"
       ON "ReceiptRequestCard"("owner", "pacificDate")`,

    // The 14-day retention scan and the threads endpoint both read by date.
    `CREATE INDEX IF NOT EXISTS "ReceiptRequestCard_pacificDate_idx"
       ON "ReceiptRequestCard"("pacificDate")`,

    // 3. The POST-claim, distinct from the row itself. Only the run holding
    // `claimToken` may mark the row posted, so an overlapping run can never
    // complete a post it did not make. Added as ALTERs rather than folded into
    // the CREATE TABLE above, because CREATE TABLE IF NOT EXISTS is a no-op
    // against a table an earlier run of this script already made — that is the
    // whole reason the script is re-runnable.
    `ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3)`,
    `ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "claimToken" TEXT`,

    // `overflow` is a COUNT; this says whether that count is exact. The
    // selection scan can stop early (SCAN_MAX_PAGES), and a retry pass does not
    // scan at all — so without persisting this, a resumed card printed
    // "and 4 more" as though it were authoritative when the number came from a
    // scan that never ran. Defaults true: every card written before this column
    // existed came from a completed scan.
    `ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "overflowExact" BOOLEAN NOT NULL DEFAULT true`,

    // The delivery state machine. POSTING is written BEFORE the webhook call so
    // a crash mid-send is distinguishable from a crash before it — otherwise
    // the next run must either double-post or silently drop the day's card.
    `ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING'`,

    // CONVERGES ON THE DEFINITION, not just the name.
    //
    // `IF NOT EXISTS`-by-name is not idempotent for a constraint, it is merely
    // silent: a row created by an earlier revision of this script keeps ITS
    // definition forever, and every re-run reports "ok" while the database
    // enforces the old rule. That is the failure mode this whole file exists to
    // avoid — a check that looks applied and is not. So the definition is
    // compared with pg_get_constraintdef on the owning table and REPLACED when
    // it differs.
    `DO $$
     DECLARE current_def text;
     BEGIN
       SELECT pg_get_constraintdef(oid) INTO current_def
         FROM pg_constraint
        WHERE conname = 'ReceiptRequestCard_status_check'
          AND conrelid = '"ReceiptRequestCard"'::regclass;
       IF current_def IS NULL THEN
         ALTER TABLE "ReceiptRequestCard" ADD CONSTRAINT "ReceiptRequestCard_status_check" CHECK ("status" IN ('PENDING', 'POSTING', 'POSTED', 'UNCERTAIN'));
       -- Quote- and space-insensitive, exactly as above. The status column needs no quoting
       -- today, so this one already matched — but the two comparisons must not read
       -- differently, or the next lowercase-to-camelCase column reintroduces the bug.
       ELSIF translate(current_def, '" ', '') <> translate('CHECK (("status" = ANY (ARRAY[''PENDING''::text, ''POSTING''::text, ''POSTED''::text, ''UNCERTAIN''::text])))', '" ', '') THEN
         ALTER TABLE "ReceiptRequestCard" DROP CONSTRAINT "ReceiptRequestCard_status_check";
         ALTER TABLE "ReceiptRequestCard" ADD CONSTRAINT "ReceiptRequestCard_status_check" CHECK ("status" IN ('PENDING', 'POSTING', 'POSTED', 'UNCERTAIN'));
       END IF;
     END $$`,

    // 4. A Purchase QuickBooks created for a receipt somebody voided while the
    // send was in flight. NOT qbPurchaseId — that column means "this row is
    // booked", and this row is not; the money exists in QBO and a human has to
    // void it there.
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "postVoidQbPurchaseId" TEXT`,


    // RLS, matching ReceiptIntake and every other sensitive table here. ENABLE
    // with no policies and WITHOUT FORCE: the app connects as the owner/service
    // role, which bypasses RLS, so reads and writes are unaffected — while anon
    // and authenticated roles get nothing. FORCE would deny the owner too and
    // take the cron down. This table holds owner names and the item snapshot
    // for real charges, so it is in the same class.
    `ALTER TABLE "ReceiptRequestCard" ENABLE ROW LEVEL SECURITY`,
];

/**
 * Verified on TYPE, NULLABILITY and DEFAULT, not just presence.
 *
 * A name-only check passes against a column of the wrong type, and — the case
 * that actually bites — against a NOT NULL column added to a populated table
 * with NO default, where the DDL succeeds and every later INSERT fails at
 * runtime instead. `default: null` means "no default expected".
 */
export const expectedColumns = {
    BankLine: [
        { name: "sourceOfRecord", type: "text", nullable: false, default: "'STATEMENT'::text" },
    ],
    BankLineObservation: [
        // NULLABLE and DEFAULTLESS is the load-bearing part: NULL means nobody
        // has asked QuickBooks about this row's clearance yet, which is a
        // different fact from "QuickBooks says it is uncleared". Both keep the
        // row out of the canonical ledger; only one of them is a claim.
        { name: "clearedStatus", type: "text", nullable: true, default: null },
    ],
    ReceiptRequestCard: [
        { name: "id", type: "text", nullable: false, default: null },
        { name: "owner", type: "text", nullable: false, default: null },
        { name: "pacificDate", type: "text", nullable: false, default: null },
        { name: "itemsJson", type: "text", nullable: false, default: null },
        { name: "overflow", type: "integer", nullable: false, default: "0" },
        // The DEFAULT is the load-bearing part: every card written before this
        // column existed came from a completed scan, so `true` is the truthful
        // backfill and there is no UPDATE pass. A nullable one would give the
        // reader a third state ("unknown") that nothing knows how to render.
        { name: "overflowExact", type: "boolean", nullable: false, default: "true" },
        { name: "claimedAt", type: "timestamp without time zone", nullable: true, default: null },
        { name: "claimToken", type: "text", nullable: true, default: null },
        { name: "status", type: "text", nullable: false, default: "'PENDING'::text" },
        { name: "postedAt", type: "timestamp without time zone", nullable: true, default: null },
        { name: "threadName", type: "text", nullable: true, default: null },
        { name: "messageName", type: "text", nullable: true, default: null },
        { name: "attempts", type: "integer", nullable: false, default: "0" },
        { name: "lastError", type: "text", nullable: true, default: null },
        { name: "createdAt", type: "timestamp without time zone", nullable: false, default: "CURRENT_TIMESTAMP" },
        { name: "updatedAt", type: "timestamp without time zone", nullable: false, default: null },
    ],
    ReceiptIntake: [
        { name: "postVoidQbPurchaseId", type: "text", nullable: true, default: null },
    ],
};

const expectedRlsTables = ["ReceiptRequestCard"];

const expectedConstraints = [
    { name: "BankLine_sourceOfRecord_check", table: "BankLine" },
    { name: "ReceiptRequestCard_status_check", table: "ReceiptRequestCard" },
];

// The unique index is the one object a "table exists" check cannot vouch for,
// and it is not an optimisation: it IS the per-day claim. Verified on both
// properties that matter — it must EXIST and be UNIQUE (a non-unique index
// claims nothing, so every concurrent run would sail through and double-post).
const expectedUniqueIndexes = [{
    name: "ReceiptRequestCard_owner_pacificDate_key",
    mustMatch: [/CREATE UNIQUE INDEX/, /\("owner", "pacificDate"\)/],
}];

async function main() {
    if (!process.argv.includes("--yes")) {
        console.error("Refusing to run without --yes (and --expect-db / --expect-host).");
        process.exit(1);
    }
    const expectDb = readFlagValue("--expect-db") ?? process.env.PHASE2_EXPECT_DB;
    const expectHost = readFlagValue("--expect-host") ?? process.env.PHASE2_EXPECT_HOST;
    if (!expectDb || !expectHost) {
        console.error("Both --expect-db and --expect-host are required (or PHASE2_EXPECT_DB / PHASE2_EXPECT_HOST).");
        process.exit(1);
    }

    const { url, from } = resolveDatabaseUrl();
    console.log(`DATABASE_URL from ${from}: ${maskUrl(url)}`);
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        const [actual] = await prisma.$queryRawUnsafe(
            `SELECT current_database() AS db, COALESCE(host(inet_server_addr()), '') AS host`,
        );
        console.log(`connected to db="${actual.db}" host="${actual.host}"`);
        if (!targetMatches(actual, expectDb, expectHost)) {
            console.error(`REFUSING: expected db="${expectDb}" host="${expectHost}" but connected to db="${actual.db}" host="${actual.host}".`);
            process.exit(1);
        }

        for (const sql of statements) {
            const label = sql.replace(/\s+/g, " ").slice(0, 84);
            process.stdout.write(`  ${label} ... `);
            await prisma.$executeRawUnsafe(sql);
            console.log("ok");
        }

        for (const [table, columns] of Object.entries(expectedColumns)) {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT column_name, data_type, is_nullable, column_default
                   FROM information_schema.columns
                  WHERE table_schema='public' AND table_name=$1`,
                table,
            );
            const found = new Map(rows.map(r => [r.column_name, r]));
            for (const column of columns) {
                const actual = found.get(column.name);
                if (!actual) {
                    console.error(`VERIFY FAILED: ${table}.${column.name} is missing`);
                    process.exit(1);
                }
                if (actual.data_type !== column.type) {
                    console.error(`VERIFY FAILED: ${table}.${column.name} is ${actual.data_type}, expected ${column.type}`);
                    process.exit(1);
                }
                const nullable = actual.is_nullable === "YES";
                if (nullable !== column.nullable) {
                    console.error(`VERIFY FAILED: ${table}.${column.name} is ${nullable ? "NULL" : "NOT NULL"}, expected ${column.nullable ? "NULL" : "NOT NULL"}`);
                    process.exit(1);
                }
                if (column.default !== null && String(actual.column_default ?? "") !== column.default) {
                    console.error(`VERIFY FAILED: ${table}.${column.name} default is ${actual.column_default}, expected ${column.default}`);
                    process.exit(1);
                }
            }
            console.log(`verified ${table}: ${columns.length} column(s) by name, type, nullability and default`);
        }

        for (const table of expectedRlsTables) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
                   FROM pg_class WHERE oid = $1::regclass`,
                `"${table}"`,
            );
            if (!row?.enabled) {
                console.error(`VERIFY FAILED: RLS is not enabled on ${table}`);
                process.exit(1);
            }
            if (row.forced) {
                // FORCE denies the owner too, which is the app — a silent
                // empty-result failure rather than a loud one.
                console.error(`VERIFY FAILED: RLS is FORCED on ${table}; it must be ENABLE without FORCE`);
                process.exit(1);
            }
            console.log(`verified RLS enabled (not forced) on ${table}`);
        }

        for (const { name, table } of expectedConstraints) {
            const [row] = await prisma.$queryRawUnsafe(`SELECT 1 AS ok FROM pg_constraint WHERE conname = $1`, name);
            if (!row) {
                console.error(`VERIFY FAILED: constraint ${name} missing on ${table}`);
                process.exit(1);
            }
            console.log(`verified constraint ${name}`);
        }

        for (const { name, mustMatch } of expectedUniqueIndexes) {
            const [row] = await prisma.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, name);
            if (!row) {
                console.error(`VERIFY FAILED: index ${name} missing`);
                process.exit(1);
            }
            for (const pattern of mustMatch) {
                if (!pattern.test(row.indexdef)) {
                    console.error(`VERIFY FAILED: index ${name} does not match ${pattern}\n  got: ${row.indexdef}`);
                    process.exit(1);
                }
            }
            console.log(`verified unique index ${name}`);
        }

        console.log("done.");
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
