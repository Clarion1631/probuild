// One-off additive migration for Phase 2 (docs/plans/PHASE-2-QUEUE-AND-MEMOS-SPEC.md):
//
//   1. BankLine."sourceOfRecord" — which source MINTED the canonical line.
//      Defaults to 'STATEMENT', which is true for every row that exists today,
//      so the backfill is the default and no UPDATE is needed. 'QBO' marks a
//      line minted by the nightly register pull because the QuickBooks GENERAL
//      LEDGER had a posted row QuickBooks said had cleared the bank, and no
//      statement had arrived yet (Justin, decision 3: a posted, cleared register
//      row is good enough to chase against). It flips back to 'STATEMENT' when
//      the statement observation lands and is adopted. Statement import stays
//      the only source for a cleared charge QuickBooks never posted.
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
//   node scripts/apply-phase2-receipt-queue.mjs --target prod --yes --expect-db <name> --expect-host <host>
//
// --target prod is MANDATORY and is the only accepted value: the URL then
// comes from .env.production.local and an ambient DATABASE_URL is ignored.
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

/**
 * WHICH DATABASE IS THIS? PROVE IT (Codex cross-PR finding, found on P5).
 *
 * The old resolution read `process.env.DATABASE_URL` first. A developer with a
 * local database exported in their shell — or a `.env` loaded by something
 * else — could run this script, watch every statement report "ok", and merge
 * believing production had been migrated. It had not. The failure is silent by
 * construction: the script's own output looked identical either way.
 *
 * So the target is not inferred at all. `--target prod` is mandatory, the URL
 * comes from `.env.production.local` and NOWHERE else, and an ambient
 * `DATABASE_URL` is deliberately ignored rather than preferred.
 */
export const PROD_ENV_FILE = ".env.production.local";

/** The migration every production database carries, and no other database does. */
export const PROD_BASELINE_MIGRATION = "20260814000000_baseline_production";

/**
 * The production URL, from the production env file only.
 *
 * Exported for tests. Takes the filesystem as an argument so a test can prove
 * the ambient environment is ignored without writing to disk.
 */
export function resolveProdDatabaseUrl(readFile = path => fs.readFileSync(path, "utf8"),
                                       exists = path => fs.existsSync(path)) {
    if (!exists(PROD_ENV_FILE)) {
        throw new Error(
            `${PROD_ENV_FILE} not found. Run \`vercel env pull ${PROD_ENV_FILE} --environment=production\` first. `
            + "The production URL is never taken from the environment: an ambient DATABASE_URL is exactly how "
            + "a local database gets migrated instead of production.",
        );
    }
    const match = readFile(PROD_ENV_FILE).match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (!match) throw new Error(`DATABASE_URL not found in ${PROD_ENV_FILE}`);
    return { url: match[1], from: PROD_ENV_FILE };
}

/**
 * A target line with NO credentials in it at all.
 *
 * `maskUrl` only replaces the password, which still prints the username and
 * leaves the whole query string — including any credential-bearing parameter —
 * in the terminal and in whatever transcript is recording it. This prints the
 * three things a human needs to confirm the target and nothing else.
 */
export function redactTarget(url) {
    try {
        const parsed = new URL(url);
        const db = parsed.pathname.replace(/^\//, "") || "(none)";
        return `host=${parsed.hostname} port=${parsed.port || "(default)"} db=${db}`;
    } catch {
        return "host=(unparseable) port=(unparseable) db=(unparseable)";
    }
}

/** Does this host look like the Supabase pooler production runs on? */
export function isProductionPoolerHost(host) {
    return /(^|\.)pooler\.supabase\.com$/i.test(String(host ?? ""));
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
    // THE DURABLE QUEUE STATE FOR A RESEND (Codex PR #443 gate round 41, finding 3).
    //
    // An operator answering "resend" on an uncertain card puts it back to PENDING.
    // That decision used to live in `lastError` as the text `resend-requested` —
    // and `lastError` is DIAGNOSTIC: the next failure overwrites it. A queued card
    // that Chat then rejected became `rejected:*`, so the cards cron stopped
    // draining it and the health probe stopped counting it. The operator's decision
    // disappeared with no trace, and the crew was never asked.
    //
    // Its own nullable column, so no write that records an ERROR can erase a
    // DECISION. Set by the resend action, cleared only by a successful post (or by
    // the row being deleted because every item was answered).
    `ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "resendQueuedAt" TIMESTAMP(3)`,

    `CREATE INDEX IF NOT EXISTS "ReceiptRequestCard_resendQueuedAt_idx"
  ON "ReceiptRequestCard"("resendQueuedAt")`,

    // THE DAY A CARD WAS ACTUALLY DELIVERED (Codex PR #443 gate round 42, finding 4).
    //
    // `pacificDate` is the day a card was SELECTED for, and a resend deliberately
    // keeps its original one (its request id, and therefore its Chat thread, are
    // derived from it). That leaves nothing recording the day it was SENT — so the
    // one-message-per-owner-per-day rule, which is the whole point of the (owner,
    // pacificDate) key, could be broken from two directions: several queued
    // resends for one owner drained in the same run, and a resend drained on a day
    // the owner had already had their ordinary card.
    //
    // This column is the delivery-day claim, taken BEFORE the post and unique per
    // owner and day, so the second attempt loses on the constraint rather than on
    // a check somebody has to remember to write.
    `ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "deliveredOn" TEXT`,

    // NULLS ARE ALREADY DISTINCT, so this needs no WHERE clause. Postgres treats
    // two NULLs as unequal in a unique index (the default, not NULLS NOT
    // DISTINCT), so every never-delivered card coexists freely under one owner
    // and only real delivery days collide. A partial index would say exactly the
    // same thing while being invisible to Prisma's diff engine, which reports it
    // as missing forever and needs a blind-spot entry to stay quiet — a permanent
    // phantom bought for no semantics at all.
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptRequestCard_owner_deliveredOn_key"
  ON "ReceiptRequestCard"("owner", "deliveredOn")`,

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

    // 5. The DURABLE identity of a signed missing-receipt memo (Codex PR #443
    // gate round 34, finding 1). Two invariants, two unique indexes:
    //   * "pdfId" UNIQUE          — one signed memo answers ONE charge.
    //   * (targetType, targetKey) — one charge is bound to ONE memo, immutably.
    // The answers route checked reuse by scanning every OTHER issue's
    // displayDetails and then REPLACED its own issue's pdfId in place, so a memo
    // could be unbound by a later one and replayed against a second charge with
    // nothing on record to catch it. A check is a statement about the moment it
    // ran; these are statements about the row.
    // ONE DELIVERY PER OWNER PER DAY, as an immutable row (round-44 gate,
    // finding 2). `ReceiptRequestCard.deliveredOn` could not enforce it: it is
    // a column on a MUTABLE row, and re-writing it onto the same row never
    // violates that row's own unique key, so a resumed uncertain card posted
    // twice in one day.
    `CREATE TABLE IF NOT EXISTS "ReceiptRequestCardDelivery" (
        "id" TEXT NOT NULL,
        "owner" TEXT NOT NULL,
        "deliveryDay" TEXT NOT NULL,
        "cardId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ReceiptRequestCardDelivery_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptRequestCardDelivery_owner_deliveryDay_key"
       ON "ReceiptRequestCardDelivery"("owner", "deliveryDay")`,
    `CREATE INDEX IF NOT EXISTS "ReceiptRequestCardDelivery_cardId_idx"
       ON "ReceiptRequestCardDelivery"("cardId")`,
    // BACKFILL THE EXISTING CLAIMS (round-45 gate, finding 5). Rows already
    // carrying `deliveredOn` were delivered before this table existed; without
    // them a legacy same-day UNCERTAIN -> PENDING resend finds the table empty
    // and posts a second message. Idempotent BY DERIVED KEY: the id is computed
    // from (owner, deliveredOn), so a re-run computes the same ids and writes
    // nothing. A fresh uuid would duplicate on every run while reporting "ok".
    `INSERT INTO "ReceiptRequestCardDelivery" ("id", "owner", "deliveryDay", "cardId", "createdAt")
     SELECT md5('rrcd:' || "owner" || ':' || "deliveredOn"), "owner", "deliveredOn", "id", COALESCE("postedAt", CURRENT_TIMESTAMP)
       FROM "ReceiptRequestCard"
      WHERE "deliveredOn" IS NOT NULL
     ON CONFLICT ("owner", "deliveryDay") DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS "ReceiptMemoArtifact" (
       "id"         TEXT NOT NULL,
       "pdfId"      TEXT NOT NULL,
       "targetType" TEXT NOT NULL,
       "targetKey"  TEXT NOT NULL,
       "issueId"    TEXT NOT NULL,
       "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "ReceiptMemoArtifact_pkey" PRIMARY KEY ("id")
     )`,

    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptMemoArtifact_pdfId_key"
       ON "ReceiptMemoArtifact"("pdfId")`,

    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptMemoArtifact_targetType_targetKey_key"
       ON "ReceiptMemoArtifact"("targetType", "targetKey")`,

    `CREATE INDEX IF NOT EXISTS "ReceiptMemoArtifact_issueId_idx"
       ON "ReceiptMemoArtifact"("issueId")`,

    // BACKFILL FROM THE EVIDENCE THAT ALREADY EXISTS. Every issue already
    // carrying a `memo-signed` resolution with a pdfId is a binding made before
    // this table existed; without this, the first replay of one of those memos
    // would find an empty table and read as unbound.
    //
    // Read with `substring(... from ...)`, NOT a jsonb cast: displayDetails is
    // TEXT and one malformed row would abort the whole script. A regex that does
    // not match yields NULL, which the WHERE drops.
    //
    // IDEMPOTENT BY DERIVED ID: the primary key is md5 of the pdfId, so a re-run
    // computes the same row and ON CONFLICT DO NOTHING makes it a no-op rather
    // than a duplicate under a fresh cuid. It writes no existing row.
    //
    // ORDER BY makes the residue deterministic: where the pre-fix bug already
    // let two issues record the SAME pdfId, the oldest binding wins and the
    // other issue keeps its recorded resolution but gains no artifact row —
    // which is right, it is the one whose memo was spent elsewhere.
    `INSERT INTO "ReceiptMemoArtifact" ("id", "pdfId", "targetType", "targetKey", "issueId", "createdAt")
     SELECT 'rma_' || md5(parsed."pdfId"), parsed."pdfId", i."targetType", i."targetKey", i."id",
            COALESCE(i."updatedAt", CURRENT_TIMESTAMP)
       FROM "ReviewIssue" i
       CROSS JOIN LATERAL (
           SELECT substring(i."displayDetails" from '"pdfId"[[:space:]]*:[[:space:]]*"([^"]+)"') AS "pdfId",
                  substring(i."displayDetails" from '"resolution"[[:space:]]*:[[:space:]]*"([^"]+)"') AS "resolution"
       ) parsed
      WHERE i."displayDetails" LIKE '%memo-signed%'
        AND parsed."resolution" = 'memo-signed'
        AND parsed."pdfId" IS NOT NULL
      ORDER BY i."firstObservedAt", i."id"
      ON CONFLICT DO NOTHING`,

    // AND REOPEN THE ONES THAT LOST (Codex PR #443 gate round 36, finding 3).
    //
    // `ON CONFLICT DO NOTHING` above binds the OLDEST claimant of a duplicated
    // pdfId and walks away from the others — leaving them with a `memo-signed`
    // resolution and no artifact. That is an answer nothing can vouch for: the
    // memo was spent on a different charge, and `hasResolution` alone kept the
    // chase closed forever. The same shape covers a `memo-signed` blob that never
    // carried a pdfId at all — a claim with no evidence to check.
    //
    // QUARANTINED, NOT DELETED: the resolution becomes `memo-conflict`, which
    // `hasResolution` deliberately does not treat as an answer (see
    // src/lib/receipt-requests.ts), and `clearedAt` is cleared — so the charge is
    // chased again while the blob still records what happened. `version` is
    // incremented so an in-flight optimistic write loses rather than clobbering
    // the repair.
    //
    // IDEMPOTENT: a re-run finds no `memo-signed` without a binding, because this
    // one rewrote every such row.
    `UPDATE "ReviewIssue" i
   SET "displayDetails" = regexp_replace(
           i."displayDetails",
           '"resolution"[[:space:]]*:[[:space:]]*"memo-signed"',
           '"resolution":"memo-conflict"'),
       "clearedAt" = NULL,
       "updatedAt" = CURRENT_TIMESTAMP,
       "version" = i."version" + 1
 WHERE i."displayDetails" LIKE '%memo-signed%'
   AND substring(i."displayDetails" from '"resolution"[[:space:]]*:[[:space:]]*"([^"]+)"') = 'memo-signed'
   AND NOT EXISTS (
       SELECT 1
         FROM "ReceiptMemoArtifact" a
        WHERE a."issueId" = i."id"
          AND a."pdfId" IS NOT DISTINCT FROM
              substring(i."displayDetails" from '"pdfId"[[:space:]]*:[[:space:]]*"([^"]+)"')
   )`,

    // Same RLS class as ReceiptRequestCard: this row names a real charge and the
    // Drive file that answers it.
    `ALTER TABLE "ReceiptRequestCardDelivery" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "ReceiptMemoArtifact" ENABLE ROW LEVEL SECURITY`,
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
        // NULLABLE and DEFAULTLESS: "no resend was asked for" is the absence of
        // a decision, not a decision with a date (round-41 gate, finding 3).
        { name: "resendQueuedAt", type: "timestamp without time zone", nullable: true, default: null },
        // NULLABLE: "never delivered" is the absence of a claim, and the unique
        // index is partial for exactly that reason (round-42 gate, finding 4).
        { name: "deliveredOn", type: "text", nullable: true, default: null },
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
    // Every column NOT NULL: a memo binding with a missing half is not a
    // weaker binding, it is a row the unique indexes cannot enforce anything
    // about. `createdAt` carries the DEFAULT so the backfill's COALESCE and a
    // live insert agree.
    ReceiptRequestCardDelivery: [
        { name: "id", type: "text", nullable: false, default: null },
        { name: "owner", type: "text", nullable: false, default: null },
        { name: "deliveryDay", type: "text", nullable: false, default: null },
        { name: "cardId", type: "text", nullable: true, default: null },
        { name: "createdAt", type: "timestamp without time zone", nullable: false, default: "CURRENT_TIMESTAMP" },
    ],
    ReceiptMemoArtifact: [
        { name: "id", type: "text", nullable: false, default: null },
        { name: "pdfId", type: "text", nullable: false, default: null },
        { name: "targetType", type: "text", nullable: false, default: null },
        { name: "targetKey", type: "text", nullable: false, default: null },
        { name: "issueId", type: "text", nullable: false, default: null },
        { name: "createdAt", type: "timestamp without time zone", nullable: false, default: "CURRENT_TIMESTAMP" },
    ],
};

const expectedRlsTables = ["ReceiptRequestCard", "ReceiptRequestCardDelivery", "ReceiptMemoArtifact"];

const expectedConstraints = [
    { name: "BankLine_sourceOfRecord_check", table: "BankLine" },
    { name: "ReceiptRequestCard_status_check", table: "ReceiptRequestCard" },
];

// The unique index is the one object a "table exists" check cannot vouch for,
// and it is not an optimisation: it IS the per-day claim. Verified on both
// properties that matter — it must EXIST and be UNIQUE (a non-unique index
// claims nothing, so every concurrent run would sail through and double-post).
//
// The memo-artifact pair is the same kind of object and the same kind of claim:
// each one IS an invariant (one memo answers one charge; one charge is bound to
// one memo), so a non-unique index would leave the route's own checks as the
// only thing standing between a replayed affidavit and a second closed chase.
const expectedUniqueIndexes = [{
    name: "ReceiptRequestCard_owner_pacificDate_key",
    mustMatch: [/CREATE UNIQUE INDEX/, /\("owner", "pacificDate"\)/],
}, {
    // THE DELIVERY-DAY CLAIM (Codex PR #443 gate round 43, finding 6). The
    // sibling above claims the day a card was SELECTED for; this one claims the
    // day it was SENT, which is the only thing that can stop a resend — which
    // keeps its original pacificDate on purpose — becoming a second message to
    // the same person on the same day.
    //
    // `mustNotMatch` is as load bearing as `mustMatch` here: a PARTIAL index
    // would enforce the same rule and be invisible to Prisma's diff engine, so
    // CI's migrations job would report it missing forever. It needs no WHERE
    // clause anyway — Postgres treats two NULLs as unequal in a unique index,
    // so undelivered cards never collide.
    name: "ReceiptRequestCard_owner_deliveredOn_key",
    mustMatch: [/CREATE UNIQUE INDEX/, /\("owner", "deliveredOn"\)/],
    mustNotMatch: [/ WHERE /],
}, {
    // The reservation itself (round-44 gate, finding 2). A non-unique index
    // here would let two invocations both insert a delivery row for the same
    // owner and day, which is the whole thing this table exists to stop.
    name: "ReceiptRequestCardDelivery_owner_deliveryDay_key",
    mustMatch: [/CREATE UNIQUE INDEX/, /\("owner", "deliveryDay"\)/],
    mustNotMatch: [/ WHERE /],
}, {
    name: "ReceiptMemoArtifact_pdfId_key",
    mustMatch: [/CREATE UNIQUE INDEX/, /\("pdfId"\)/],
}, {
    name: "ReceiptMemoArtifact_targetType_targetKey_key",
    mustMatch: [/CREATE UNIQUE INDEX/, /\("targetType", "targetKey"\)/],
}];

async function main() {
    /**
     * FLAGS ARE READ HERE, INSIDE main(), so the module stays inert on import
     * (CLAUDE.md: importing an apply script once executed it against prod).
     */
    const target = readFlagValue("--target");
    if (target !== "prod") {
        console.error(
            "Refusing to run without `--target prod`. This script has exactly one legitimate target, "
            + "and naming it is how you prove you meant it — an ambient DATABASE_URL pointing at a local "
            + "database used to be accepted silently, so every statement reported ok while production was untouched.",
        );
        process.exit(1);
    }
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

    // The production file, never the environment.
    const { url, from } = resolveProdDatabaseUrl();
    console.log(`TARGET (${from}): ${redactTarget(url)}`);
    if (process.env.DATABASE_URL) {
        console.log("note: an ambient DATABASE_URL is set and is being IGNORED — the target above is the one that will be written.");
    }
    if (!isProductionPoolerHost(new URL(url).hostname)) {
        console.error(`REFUSING: ${from} points at ${redactTarget(url)}, which is not the production pooler host.`);
        process.exit(1);
    }
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

        /**
         * AND THE DATABASE ITSELF HAS TO AGREE IT IS PRODUCTION.
         *
         * `current_database()` is "postgres" on a local Postgres too, and the
         * expect-host check compares whatever the operator typed. The baseline
         * migration row is the one thing only production carries: it was marked
         * applied there by a deliberate one-off step (#382) and no other
         * database has it. A throwaway CI database built from
         * prisma/migrations has the row too — which is correct, since that is
         * the database CI is entitled to write.
         */
        const baseline = await prisma.$queryRawUnsafe(
            `SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = $1 LIMIT 1`,
            PROD_BASELINE_MIGRATION,
        );
        if (baseline.length === 0) {
            console.error(
                `REFUSING: this database has no "${PROD_BASELINE_MIGRATION}" row in _prisma_migrations, `
                + "so it is not production and not a database built from this repo's migrations.",
            );
            process.exit(1);
        }
        console.log(`verified baseline migration "${PROD_BASELINE_MIGRATION}" is present`);

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

        for (const { name, mustMatch, mustNotMatch = [] } of expectedUniqueIndexes) {
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
            for (const pattern of mustNotMatch) {
                if (pattern.test(row.indexdef)) {
                    console.error(`VERIFY FAILED: index ${name} must NOT match ${pattern}
  got: ${row.indexdef}`);
                    process.exit(1);
                }
            }
            console.log(`verified unique index ${name}`);
        }

        /**
         * THE BACKFILL ACTUALLY LANDED (round-45 gate, finding 5). A statement
         * reporting "ok" says it ran, not that it copied anything — and a
         * missing reservation is invisible until the day somebody gets asked
         * twice. Every card carrying a `deliveredOn` must have a matching
         * delivery row; more rows than that is fine and expected, because the
         * cron writes new ones.
         */
        const [claims] = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "ReceiptRequestCard" WHERE "deliveredOn" IS NOT NULL`,
        );
        const [missing] = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n
               FROM "ReceiptRequestCard" c
              WHERE c."deliveredOn" IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM "ReceiptRequestCardDelivery" d
                     WHERE d."owner" = c."owner" AND d."deliveryDay" = c."deliveredOn")`,
        );
        if (missing.n > 0) {
            console.error(`VERIFY FAILED: ${missing.n} of ${claims.n} existing delivery claims have no ReceiptRequestCardDelivery row`);
            process.exit(1);
        }
        console.log(`verified delivery backfill: ${claims.n} existing claim(s), 0 missing`);

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
