// One-off additive migration for ReceiptIntake (Receipt Pipeline v2, Phase 1 —
// docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §2): the single intake row for one
// inbound receipt/check document, from every source (mobile capture, the Apps
// Script Drive/email/chat forwarders, the web uploader).
//
// The SQL here is byte-equivalent to
// prisma/migrations/20260901000000_receipt_intake/migration.sql — that file is
// what a fresh CI/dev database gets; this script is what production gets,
// BEFORE the build that selects these columns deploys (CLAUDE.md pre-deploy
// rule #2 — otherwise every page touching them throws P2022).
//
// Two objects are invisible to Prisma and must be created here, not by the
// generator:
//   * CHECK ("state" IN (...)) — Prisma has no check-constraint concept.
//   * the PARTIAL unique index on "dedupStrongKey" — Prisma's diff engine drops
//     partial indexes without comment. It is not an optimisation: it IS the
//     strong-dedup claim. The reader writes the keys and reads a unique
//     violation as "another live row already owns this purchase", which is what
//     replaces the Apps Script's Script-Properties lock.
//
// Additive and idempotent: CREATE TABLE / INDEX IF NOT EXISTS plus guarded
// constraint adds. Safe to re-run; a second run reports every statement "ok"
// and changes nothing. No existing table is touched.
//
//   node scripts/apply-receipt-intake.mjs --yes --expect-db <name> --expect-host <host>
//
// --expect-db and --expect-host are BOTH required alongside --yes, matching
// scripts/apply-bank-image.mjs: "--yes" alone only proves you meant to run
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

/**
 * Pure comparison, exported for unit testing without a live DB. Compares BOTH
 * database name and server host, and both EXACTLY.
 *
 * apply-bank-image.mjs accepts a substring match on the host "because a pooled
 * Supabase host resolves to an IP". That is a guard which gets LOOSER the
 * shorter the operator's input is: `--expect-host 1` satisfies `host.includes`
 * against 10.0.0.5, 172.16.1.1, and almost anything else. A guard whose whole
 * job is to stop DDL landing on the wrong server must not have a degenerate
 * case, so this one is exact. Print `host(inet_server_addr())` (the script logs
 * it before refusing) and pass that value.
 */
export function targetMatches(actual, expectDb, expectHost) {
    if (!actual || typeof actual !== "object") return false;
    if (String(actual.db ?? "") !== String(expectDb ?? "")) return false;
    return String(actual.host ?? "") === String(expectHost ?? "");
}

/** The closed set of states the CHECK constraint allows. Exported for tests. */
export const RECEIPT_INTAKE_STATES = [
    "STAGING", "RECEIVED", "READ", "NEEDS_JOB", "NEEDS_REVIEW", "BOOKING",
    "BOOKED", "ARCHIVED", "DUPLICATE", "VOID", "NON_RECEIPT",
    // Received during the shadow week, therefore booked by v1 and NEVER by v2.
    "SHADOW_DONE",
    // Pre-boundary, no v1 evidence, and no Drive identity to make a v2 booking
    // idempotent. A HUMAN decides.
    "SHADOW_QUARANTINE",
];

export const statements = [
    `CREATE TABLE IF NOT EXISTS "ReceiptIntake" (
       "id"                  TEXT NOT NULL,
       "source"              TEXT NOT NULL,
       "sourceRef"           TEXT NOT NULL,
       "state"               TEXT NOT NULL DEFAULT 'STAGING',
       "dryRun"              BOOLEAN NOT NULL DEFAULT true,
       "stateReason"         TEXT,
       "projectId"           TEXT,
       "costCodeId"          TEXT,
       "suggestedCostCodeId" TEXT,
       "suggestedConfidence" DOUBLE PRECISION,
       "createdById"         TEXT,
       "storagePath"         TEXT NOT NULL,
       "fileName"            TEXT,
       "mimeType"            TEXT NOT NULL,
       "fileSize"            INTEGER NOT NULL,
       "fileSha256"          TEXT NOT NULL,
       "expectedSha256"      TEXT,
       "uploadUrlExpiresAt"  TIMESTAMP(3),
       "vendor"              TEXT,
       "txnDate"             DATE,
       "totalCents"          INTEGER,
       "taxCents"            INTEGER,
       "docType"             TEXT,
       "refNumber"           TEXT,
       "memo"                TEXT,
       "readJson"            TEXT,
       "readAt"              TIMESTAMP(3),
       "dedupStrongKey"      TEXT,
       "dedupWeakKey"        TEXT,
       "duplicateOfId"       TEXT,
       "sendAttempted"       BOOLEAN NOT NULL DEFAULT false,
       "archivedByV1"        BOOLEAN NOT NULL DEFAULT false,
       "qbPurchaseId"        TEXT,
       "expenseId"           TEXT,
       "archiveDriveFileId"  TEXT,
       "claimToken"          TEXT,
       "claimedAt"           TIMESTAMP(3),
       "attempts"            INTEGER NOT NULL DEFAULT 0,
       "busyPasses"          INTEGER NOT NULL DEFAULT 0,
       "lastError"           TEXT,
       "nextRetryAt"         TIMESTAMP(3),
       "bookedAt"            TIMESTAMP(3),
       "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"           TIMESTAMP(3) NOT NULL,
       CONSTRAINT "ReceiptIntake_pkey" PRIMARY KEY ("id")
     )`,

    // Additive upgrade for a table created by an EARLIER run of this script,
    // before busyPasses existed: CREATE TABLE IF NOT EXISTS is a no-op on an
    // existing table, so a column added to the CREATE above would never reach
    // it. This is the whole reason the script is re-runnable.
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "busyPasses" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "expectedSha256" TEXT`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "uploadUrlExpiresAt" TIMESTAMP(3)`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "sendAttempted" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "archivedByV1" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "claimToken" TEXT`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3)`,

    // Intake idempotency: one row per caller-supplied sourceRef. A forwarder
    // replaying the same Drive file / Gmail message is a no-op.
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_sourceRef_key"
       ON "ReceiptIntake"("sourceRef")`,

    // One intake row per booked Expense.
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_expenseId_key"
       ON "ReceiptIntake"("expenseId")`,

    // THE STRONG-DEDUP CLAIM (partial — Prisma cannot express this). Quarantined
    // rows (DUPLICATE) and voided ones drop out of the index so the surviving
    // original keeps the key.
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_dedupStrongKey_active_key"
       ON "ReceiptIntake"("dedupStrongKey")
       WHERE "dedupStrongKey" IS NOT NULL AND "state" NOT IN ('DUPLICATE', 'VOID')`,

    // The worker's claim query: state + due time.
    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_state_nextRetryAt_idx"
       ON "ReceiptIntake"("state", "nextRetryAt")`,

    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_projectId_idx"
       ON "ReceiptIntake"("projectId")`,

    // The weak-dedup net is a plain lookup, never a claim.
    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_dedupWeakKey_idx"
       ON "ReceiptIntake"("dedupWeakKey")`,

    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_createdAt_idx"
       ON "ReceiptIntake"("createdAt")`,

    // Both are FK targets the queue filters and joins on.
    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_costCodeId_idx"
       ON "ReceiptIntake"("costCodeId")`,

    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_createdById_idx"
       ON "ReceiptIntake"("createdById")`,

    // state is a closed set — a typo must fail loudly rather than create a
    // silent eleventh state that no query ever selects.
    // The state set GROWS. `IF NOT EXISTS` alone is wrong for that: a database
    // that already has the constraint from an earlier run keeps the OLD set, so
    // the first write of a newly-added state (SHADOW_DONE, at cutover, inside
    // the claim transaction) fails and takes the whole cutover with it — and
    // the script that was supposed to prevent exactly this reported "ok".
    //
    // So compare the DEFINITION, and replace it when it differs. Postgres
    // validates the new CHECK against existing rows as part of the ADD, so a
    // set that would orphan live data fails loudly here rather than later.
    `DO $$
     DECLARE current_def TEXT;
             wanted_def  TEXT := 'CHECK ((state = ANY (ARRAY[''STAGING''::text, ''RECEIVED''::text, ''READ''::text, ''NEEDS_JOB''::text, ''NEEDS_REVIEW''::text, ''BOOKING''::text, ''BOOKED''::text, ''ARCHIVED''::text, ''DUPLICATE''::text, ''VOID''::text, ''NON_RECEIPT''::text, ''SHADOW_DONE''::text, ''SHADOW_QUARANTINE''::text])))';
     BEGIN
       SELECT pg_get_constraintdef(oid) INTO current_def
         FROM pg_constraint
        WHERE conname = 'ReceiptIntake_state_check'
          AND conrelid = '"ReceiptIntake"'::regclass;

       IF current_def IS NULL THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_state_check"
           CHECK ("state" IN ('STAGING', 'RECEIVED', 'READ', 'NEEDS_JOB', 'NEEDS_REVIEW', 'BOOKING',
                              'BOOKED', 'ARCHIVED', 'DUPLICATE', 'VOID', 'NON_RECEIPT',
                              'SHADOW_DONE', 'SHADOW_QUARANTINE'));
       ELSIF current_def IS DISTINCT FROM wanted_def THEN
         -- One statement each, in the SAME transaction as everything else this
         -- script runs, so the table is never briefly unconstrained.
         ALTER TABLE "ReceiptIntake" DROP CONSTRAINT "ReceiptIntake_state_check";
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_state_check"
           CHECK ("state" IN ('STAGING', 'RECEIVED', 'READ', 'NEEDS_JOB', 'NEEDS_REVIEW', 'BOOKING',
                              'BOOKED', 'ARCHIVED', 'DUPLICATE', 'VOID', 'NON_RECEIPT',
                              'SHADOW_DONE', 'SHADOW_QUARANTINE'));
       END IF;
     END $$`,

    // SET NULL on every parent: losing a project, cost code, user, or expense
    // must never delete the audit trail of a document that was already booked.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'ReceiptIntake_projectId_fkey'
                         AND conrelid = '"ReceiptIntake"'::regclass) THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_projectId_fkey"
           FOREIGN KEY ("projectId") REFERENCES "Project"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'ReceiptIntake_costCodeId_fkey'
                         AND conrelid = '"ReceiptIntake"'::regclass) THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_costCodeId_fkey"
           FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'ReceiptIntake_createdById_fkey'
                         AND conrelid = '"ReceiptIntake"'::regclass) THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_createdById_fkey"
           FOREIGN KEY ("createdById") REFERENCES "User"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,

    // RLS, matching every other sensitive table in this schema
    // (apply-bank-ledger.mjs, apply-automation-events.mjs,
    // apply-deposit-ingest-schema.mjs). ENABLE with no policies and WITHOUT
    // FORCE: the app connects as the owner/service role, which bypasses RLS, so
    // reads and writes are unaffected — while anon and authenticated roles
    // (a leaked anon key, a Supabase client someone wires up later) get nothing.
    // FORCE would deny the owner too and take the pipeline down.
    // ReceiptIntake holds vendor names, amounts and storage paths for real
    // purchases, so it belongs in the same class as BankLine.
    `ALTER TABLE "ReceiptIntake" ENABLE ROW LEVEL SECURITY`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'ReceiptIntake_expenseId_fkey'
                         AND conrelid = '"ReceiptIntake"'::regclass) THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_expenseId_fkey"
           FOREIGN KEY ("expenseId") REFERENCES "Expense"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,
];

const expectedColumns = {
    ReceiptIntake: [
        "id", "source", "sourceRef", "state", "dryRun", "stateReason",
        "projectId", "costCodeId", "suggestedCostCodeId", "suggestedConfidence",
        "createdById", "storagePath", "fileName", "mimeType", "fileSize",
        "fileSha256", "expectedSha256", "uploadUrlExpiresAt",
        "sendAttempted", "archivedByV1",
        "vendor", "txnDate", "totalCents", "taxCents", "docType",
        "refNumber", "memo", "readJson", "readAt", "dedupStrongKey",
        "dedupWeakKey", "duplicateOfId", "qbPurchaseId", "expenseId",
        "archiveDriveFileId", "claimToken", "claimedAt",
        "attempts", "busyPasses", "lastError", "nextRetryAt",
        "bookedAt", "createdAt", "updatedAt",
    ],
};

const expectedConstraints = [
    { name: "ReceiptIntake_state_check", table: "ReceiptIntake" },
    { name: "ReceiptIntake_projectId_fkey", table: "ReceiptIntake" },
    { name: "ReceiptIntake_costCodeId_fkey", table: "ReceiptIntake" },
    { name: "ReceiptIntake_createdById_fkey", table: "ReceiptIntake" },
    { name: "ReceiptIntake_expenseId_fkey", table: "ReceiptIntake" },
];

// The partial index is the one object a "table exists" check cannot vouch for
// (Prisma would have created the table on its own; it would never create this).
// Verified on three properties, because any one of them alone can pass while
// the index is useless: it must EXIST, be UNIQUE (a non-unique index claims
// nothing, so every duplicate would sail through), and carry the EXACT
// predicate (a wider one quarantines rows that were deliberately excluded; a
// narrower one stops quarantining real duplicates).
const expectedPartialIndexes = [{
    name: "ReceiptIntake_dedupStrongKey_active_key",
    mustMatch: [
        /CREATE UNIQUE INDEX/,
        /\("dedupStrongKey"\)/,
        /WHERE \(\("dedupStrongKey" IS NOT NULL\) AND \(state <> ALL \(ARRAY\['DUPLICATE'::text, 'VOID'::text\]\)\)\)/,
    ],
}];


// ── The receipts bucket ────────────────────────────────────────────────────
//
// Provisioned HERE rather than by hand in the dashboard, because two of its
// settings are load-bearing and invisible from the application:
//
//   * fileSizeLimit — the two-step upload goes straight to a signed URL that
//     never passes through the server, so the BUCKET is the only place a 400 MB
//     write can actually be refused. Application code can only reject the
//     object afterwards, once the bytes are already stored and paid for.
//   * allowedMimeTypes — same reason, for a format QuickBooks cannot attach.
//
// It is its own bucket, not `secure-docs`: those limits are per-bucket and
// cannot be imposed on contracts and invoice PDFs, and a signed upload URL is a
// write capability that must not point anywhere near the contract store.
//
// Idempotent: create if missing, otherwise VERIFY. A bucket that exists with
// the wrong limit is a hard failure — silently "fixing" a limit somebody set
// deliberately is how a 400 MB upload becomes possible again next quarter.
export const RECEIPT_BUCKET = "receipt-intake";
export const RECEIPT_BUCKET_FILE_SIZE_LIMIT = 15 * 1024 * 1024;
// EXACTLY the list src/lib/receipt-intake/file-type.ts accepts (asserted by
// tests/apply-receipt-intake.test.ts). A bucket that allows more than the code
// does lets an unreadable file be stored; one that allows less rejects uploads
// the code promised were fine, at a signed URL where the caller sees only a
// storage error.
export const RECEIPT_BUCKET_MIME_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/heif",
    "image/webp",
    "image/gif",
];

/** Normalizes Supabase's file_size_limit, which comes back as bytes or "15MB". */
export function parseSizeLimit(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;
    const text = String(value).trim();
    if (/^\d+$/.test(text)) return Number(text);
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i);
    if (!match) return null;
    const scale = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 }[match[2].toLowerCase()];
    return Math.round(Number(match[1]) * scale);
}

async function storageRequest(baseUrl, key, path, init = {}) {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/storage/v1${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${key}`,
            apikey: key,
            "content-type": "application/json",
            ...(init.headers ?? {}),
        },
    });
    const text = await res.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = { raw: text.slice(0, 200) };
    }
    return { status: res.status, ok: res.ok, body };
}

/**
 * Create or verify the bucket. Returns "created" | "verified"; THROWS when it
 * exists with a different policy, because that is a fact the operator has to
 * see rather than a state to overwrite.
 */
export async function ensureReceiptBucket(baseUrl, key, request = storageRequest) {
    const existing = await request(baseUrl, key, `/bucket/${RECEIPT_BUCKET}`, { method: "GET" });

    if (existing.status === 404) {
        const created = await request(baseUrl, key, "/bucket", {
            method: "POST",
            body: JSON.stringify({
                id: RECEIPT_BUCKET,
                name: RECEIPT_BUCKET,
                public: false,
                file_size_limit: RECEIPT_BUCKET_FILE_SIZE_LIMIT,
                allowed_mime_types: RECEIPT_BUCKET_MIME_TYPES,
            }),
        });
        if (!created.ok) {
            throw new Error(`could not create bucket ${RECEIPT_BUCKET}: ${created.status} ${JSON.stringify(created.body)}`);
        }
        return "created";
    }
    if (!existing.ok) {
        throw new Error(`could not read bucket ${RECEIPT_BUCKET}: ${existing.status} ${JSON.stringify(existing.body)}`);
    }

    const bucket = existing.body ?? {};
    const problems = [];
    if (bucket.public === true) problems.push("bucket is PUBLIC; receipts must be private");
    const limit = parseSizeLimit(bucket.file_size_limit);
    if (limit !== RECEIPT_BUCKET_FILE_SIZE_LIMIT) {
        problems.push(`file_size_limit is ${bucket.file_size_limit} (${limit} bytes), expected ${RECEIPT_BUCKET_FILE_SIZE_LIMIT}`);
    }
    const allowed = bucket.allowed_mime_types ?? null;
    if (!Array.isArray(allowed)) {
        problems.push("allowed_mime_types is unset; any file type could be uploaded");
    } else {
        const missing = RECEIPT_BUCKET_MIME_TYPES.filter(m => !allowed.includes(m));
        const extra = allowed.filter(m => !RECEIPT_BUCKET_MIME_TYPES.includes(m));
        if (missing.length) problems.push(`allowed_mime_types is missing ${missing.join(", ")}`);
        if (extra.length) problems.push(`allowed_mime_types carries unexpected ${extra.join(", ")}`);
    }
    if (problems.length) {
        throw new Error(`bucket ${RECEIPT_BUCKET} exists with the wrong policy:\n  - ${problems.join("\n  - ")}`);
    }
    return "verified";
}

async function applyBucket() {
    const baseUrl = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!baseUrl || !key) {
        console.error("REFUSING: SUPABASE_URL and SUPABASE_SERVICE_KEY are required to provision the receipts bucket.");
        console.error("  The bucket carries the 15 MiB and MIME limits that the signed-upload path cannot enforce anywhere else.");
        process.exit(1);
    }
    const outcome = await ensureReceiptBucket(baseUrl, key);
    console.log(`bucket ${RECEIPT_BUCKET}: ${outcome} (private, ${RECEIPT_BUCKET_FILE_SIZE_LIMIT} bytes, ${RECEIPT_BUCKET_MIME_TYPES.length} mime types)`);
}

async function main() {
    if (!process.argv.includes("--yes")) {
        console.error("Refusing to run without --yes (and --expect-db / --expect-host).");
        process.exit(1);
    }
    const expectDb = readFlagValue("--expect-db") ?? process.env.RECEIPT_INTAKE_EXPECT_DB;
    const expectHost = readFlagValue("--expect-host") ?? process.env.RECEIPT_INTAKE_EXPECT_HOST;
    if (!expectDb || !expectHost) {
        console.error("Both --expect-db and --expect-host are required (or RECEIPT_INTAKE_EXPECT_DB / RECEIPT_INTAKE_EXPECT_HOST).");
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

        // Verify shape rather than trusting the run.
        for (const [table, columns] of Object.entries(expectedColumns)) {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
                table,
            );
            const found = new Set(rows.map(r => r.column_name));
            const missing = columns.filter(c => !found.has(c));
            if (missing.length) {
                console.error(`VERIFY FAILED: ${table} missing columns: ${missing.join(", ")}`);
                process.exit(1);
            }
            console.log(`verified ${table}: ${columns.length} columns`);
        }
        for (const { name, table } of expectedConstraints) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, name,
            );
            if (!row) {
                console.error(`VERIFY FAILED: constraint ${name} missing on ${table}`);
                process.exit(1);
            }
            // Existence is not enough for the state CHECK: an OLD definition
            // still exists, and it is the thing that breaks the cutover.
            if (name === "ReceiptIntake_state_check") {
                const missing = RECEIPT_INTAKE_STATES.filter(state => !row.def.includes(`'${state}'`));
                if (missing.length) {
                    console.error(`VERIFY FAILED: ${name} does not allow: ${missing.join(", ")}
  actual: ${row.def}`);
                    process.exit(1);
                }
                console.log(`verified ${name}: all ${RECEIPT_INTAKE_STATES.length} states allowed`);
            }
        }
        console.log(`verified ${expectedConstraints.length} constraints`);

        // indpred IS NOT NULL is the whole point: a plain unique index of the
        // same name would silently quarantine nothing and reject legitimate
        // re-reads, so assert the DEFINITION, not just the name.
        for (const { name, mustMatch } of expectedPartialIndexes) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT pg_get_indexdef(i.indexrelid) AS def
                   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relnamespace = 'public'::regnamespace
                    AND i.indpred IS NOT NULL AND c.relname = $1`,
                name,
            );
            if (!row) {
                console.error(`VERIFY FAILED: PARTIAL index ${name} missing (a non-partial index of that name is NOT the same thing)`);
                process.exit(1);
            }
            for (const pattern of mustMatch) {
                if (!pattern.test(row.def)) {
                    console.error(`VERIFY FAILED: ${name} does not match ${pattern}\n  actual: ${row.def}`);
                    process.exit(1);
                }
            }
            console.log(`verified partial index ${name}: ${row.def}`);
        }

        // The bucket last: a failure here must not leave the table half-made,
        // and the schema is useless without somewhere to put the bytes anyway.
        await applyBucket();

        console.log("\nReceiptIntake migration applied and verified.");
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
