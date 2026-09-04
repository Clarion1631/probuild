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
//   node scripts/apply-receipt-intake.mjs --target prod --yes \
//        --expect-db <name> --expect-host <host>
//
// --target prod is REQUIRED and it is what decides which database this
// talks to. Without it the script read an AMBIENT DATABASE_URL first, so a
// developer with a local one exported in their shell could run this, watch
// every statement report ok against their own Postgres, and merge believing
// production had been migrated. `--target prod` reads
// .env.production.local and nothing else -- an ambient DATABASE_URL is
// ignored, not preferred.
//
// APPLY_EXPECT_PROJECT_REF must also be exported, and it is what actually
// pins the DATABASE. Supabase's pooler hostnames are shared regionally and
// every Supabase database is called `postgres`, so host + name + migration
// history cannot tell production from a staging clone migrated off the same
// baseline. The project ref lives in the connection URL's USERNAME
// (`postgres.<project-ref>`); this script parses it, compares it, prints it,
// and refuses when the variable is unset.
//
// --expect-db and --expect-host are BOTH required alongside --yes, matching
// scripts/apply-bank-image.mjs: "--yes" alone only proves you meant to run
// something, and a database NAME alone doesn't prove which SERVER it's on.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The only file --target prod will read a URL out of. */
export const PROD_ENV_FILE = ".env.production.local";

/**
 * The baseline migration production is known to carry
 * (prisma/migrations/20260814000000_baseline_production, marked applied in
 * prod's _prisma_migrations by a deliberate one-off step). A database
 * WITHOUT this row is not production, whatever its name is.
 */
export const PROD_BASELINE_MIGRATION = "20260814000000_baseline_production";

/** Production reaches Postgres through Supabase's pooler, never directly. */
export const PROD_POOLER_HOST_SUFFIX = ".pooler.supabase.com";

/**
 * THE ENV VAR THAT NAMES THE PROJECT. Shared by every apply-*.mjs, so one
 * export covers them all and none of them can drift to its own spelling.
 */
export const PROJECT_REF_ENV = "APPLY_EXPECT_PROJECT_REF";

/**
 * WHICH SUPABASE PROJECT IS THIS URL FOR?
 *
 * Host, database name and migration history are NOT enough to tell
 * production from a staging clone that was migrated from the same
 * baseline: pooler hosts are shared regionally, so two projects in
 * us-west-2 present the SAME hostname, and every Supabase database is
 * called `postgres`. The only thing in the connection string that names the
 * project is the USERNAME, which the pooler requires in the form
 * `postgres.<project-ref>`.
 */
export function projectRefOf(url) {
    let username;
    try {
        username = decodeURIComponent(new URL(url).username);
    } catch {
        return "";
    }
    const dot = username.indexOf(".");
    return dot > 0 ? username.slice(dot + 1) : "";
}

/**
 * WHICH DATABASE IS THIS RUN FOR? Decided from argv alone, never from the
 * environment.
 *
 * The old resolver preferred `process.env.DATABASE_URL`, which meant the
 * answer depended on whatever the operator happened to have exported. A
 * developer with a local URL in their shell got a clean, green run against
 * their own database and no signal at all that production was untouched.
 * There is exactly one target and it has to be asked for by name.
 *
 * @param {string[]} argv
 * @returns {{ ok: true, target: "prod" } | { ok: false, reason: string }}
 */
export function chooseTarget(argv) {
    const at = argv.indexOf("--target");
    const value = at >= 0 ? argv[at + 1] : undefined;
    if (!value) {
        return {
            ok: false,
            reason: "Refusing to run without --target prod. An ambient DATABASE_URL is NOT a target.",
        };
    }
    if (value !== "prod" && value !== "ci") {
        return { ok: false, reason: `Unknown --target ${value}. Targets are prod and ci.` };
    }
    return { ok: true, target: value };
}

/**
 * The URL for a chosen target. `.env.production.local` ONLY -- an ambient
 * DATABASE_URL is deliberately not consulted, and does not override it.
 *
 * @param {string} target
 * @param {(file: string, encoding: string) => string} [readFile]
 * @param {(file: string) => boolean} [exists]
 * @returns {{ url: string, from: string }}
 */
export function resolveTargetUrl(target, readFile = fs.readFileSync, exists = fs.existsSync) {
    if (target === "ci") {
        // THE ONE PLACE THE AMBIENT URL IS READ, and it is fenced two ways:
        // the caller had to ask for `--target ci` by name, and a URL that
        // looks like Supabase is refused outright. The prod guard cannot be
        // satisfied through this path even by accident -- `ci` never checks
        // the baseline row or the project ref, so it could not stand in for
        // it, and this refusal means it cannot reach a Supabase database at
        // all.
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("DATABASE_URL is required for --target ci");
        if (looksLikeSupabase(url)) {
            throw new Error(`REFUSING: --target ci was given a Supabase URL (${hostOf(url)})`);
        }
        return { url, from: "the ambient environment (--target ci)" };
    }
    if (target !== "prod") throw new Error(`no URL source for target ${target}`);
    if (!exists(PROD_ENV_FILE)) {
        throw new Error(`${PROD_ENV_FILE} not found. Run \`vercel env pull ${PROD_ENV_FILE} --environment=production\` first.`);
    }
    const match = String(readFile(PROD_ENV_FILE, "utf8")).match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (!match) throw new Error(`DATABASE_URL not found in ${PROD_ENV_FILE}`);
    return { url: match[1], from: PROD_ENV_FILE };
}

/**
 * Does this URL point at Supabase? Used only to REFUSE -- `--target ci` is
 * for a throwaway container and must never be able to reach a real project,
 * pooler or direct.
 */
export function looksLikeSupabase(url) {
    return /supabase\.(co|com)/i.test(String(url));
}

/** The URL's hostname, or an empty string if it will not parse. */
export function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

/**
 * THE TARGET LINE, printed before the first statement and in --dry-run.
 *
 * Host, database and whether the production baseline migration is there --
 * and nothing else. No credentials pass through here: the caller hands it
 * the hostname it parsed and the name the SERVER reported, never the URL.
 */
export function targetLine({ host, database, projectRef, baseline }) {
    return [
        `TARGET host=${host}`,
        `project=${projectRef || "(none)"}`,
        `database=${database}`,
        `baseline=${baseline ? "present" : "MISSING"}`,
    ].join(" ");
}

/**
 * Is the thing we just connected to actually production?
 *
 * Three independent facts, because each alone is forgeable by accident: the
 * URL goes through the pooler, the server names a database, and that
 * database carries the baseline migration row. A local Postgres can be
 * called anything; it cannot have prod's migration history.
 */
/**
 * @param {(sql: string, ...args: unknown[]) => Promise<unknown>} query
 * @param {string} urlHost
 * @param {string} projectRef  parsed from the URL username
 * @param {string | undefined} expectRef  APPLY_EXPECT_PROJECT_REF
 */
export async function verifyProdIdentity(query, urlHost, projectRef, expectRef, target = "prod") {
    const problems = [];
    const [row0] = target === "ci"
        ? await query("SELECT current_database() AS db, COALESCE(host(inet_server_addr()), '') AS host")
        : [null];
    if (target === "ci") {
        // The mirror image of the prod checks: this one proves the target is
        // NOT production. No baseline row is required (the point is to build
        // the schema from nothing) and no project ref exists.
        if (looksLikeSupabase(urlHost)) {
            problems.push(`REFUSING: --target ci was pointed at ${urlHost}`);
        }
        const db = String(row0?.db ?? "");
        if (!db) problems.push("the server did not report a database name");
        return {
            problems,
            actual: row0,
            line: targetLine({
                host: urlHost,
                database: db,
                projectRef: "(ci)",
                baseline: false,
            }),
        };
    }
    if (!urlHost.endsWith(PROD_POOLER_HOST_SUFFIX)) {
        problems.push(`host ${urlHost || "(unparseable)"} is not a ${PROD_POOLER_HOST_SUFFIX} pooler host`);
    }
    // THE PROJECT REF IS THE ONLY THING THAT SEPARATES PRODUCTION FROM A
    // MIGRATED CLONE. Unset is a refusal, never a skip: a check that turns
    // itself off when a variable is missing is the check not existing.
    if (!expectRef) {
        problems.push(`${PROJECT_REF_ENV} is not set: nothing identifies WHICH Supabase project this is`);
    } else if (!projectRef) {
        problems.push("the URL username carries no project ref (expected postgres.<project-ref>)");
    } else if (projectRef !== expectRef) {
        problems.push(`project ${projectRef} is not ${expectRef}: same pooler host, different project`);
    }
    const [row] = await query("SELECT current_database() AS db, COALESCE(host(inet_server_addr()), '') AS host");
    const database = String(row?.db ?? "");
    if (!database) problems.push("the server did not report a database name");
    const found = await query(
        "SELECT migration_name FROM _prisma_migrations WHERE migration_name = $1",
        PROD_BASELINE_MIGRATION,
    ).catch(() => []);
    const baseline = Array.isArray(found) && found.length > 0;
    if (!baseline) {
        problems.push(`_prisma_migrations has no ${PROD_BASELINE_MIGRATION} row: this is not production`);
    }
    return {
        problems,
        actual: row,
        line: targetLine({ host: urlHost, database, projectRef, baseline }),
    };
}

/**
 * REDACT THE CREDENTIALS, WITHOUT PARSING THE URL BY HAND.
 *
 * The regex this replaces was `/:[^:@]*@/` -> `:****@`, and it leaked whenever
 * the password contained a literal colon. For
 * `postgresql://user:pa:ss@host/db` it matched only the LAST `:ss@` segment,
 * printing `postgresql://user:pa:****@host/db` — the first half of the
 * password, in a log line the operator is told to paste into tickets.
 * Passwords with `:` are ordinary (Supabase generates them), so this was not a
 * corner case.
 *
 * `new URL()` knows where the userinfo ends; a regex cannot, because `@` is
 * legal inside a percent-encoded password and `:` is legal inside it verbatim.
 * Both halves of the userinfo go, since a username is an account name too.
 *
 * A URL that will not parse is NOT echoed in any form. There is nothing useful
 * to show — the string is malformed, so any substring of it could be anything
 * — and printing "the part I could not parse" is how a redactor leaks the
 * thing it exists to hide.
 */
export function maskUrl(url) {
    try {
        const parsed = new URL(url);
        // NO HOST MEANS WE COULD NOT LOCATE THE USERINFO. `postgres:/x@y`
        // parses as an opaque path with empty username and password, so the
        // redaction would be a no-op and the whole string echoed verbatim. A
        // real DATABASE_URL always has a host; anything without one is
        // malformed, and a malformed string is exactly what must not be
        // printed on the guess that its `@` is not a credential boundary.
        if (!parsed.host) return "<unparseable DATABASE_URL, redacted>";
        if (parsed.password) parsed.password = "***";
        if (parsed.username) parsed.username = "***";
        return parsed.toString();
    } catch {
        return "<unparseable DATABASE_URL, redacted>";
    }
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

const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV4_MAPPED = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)((?:\d{1,3}\.){3}\d{1,3})$/;

/**
 * ONE SPELLING PER ADDRESS.
 *
 * inet_server_addr() reports an address, and the same server has more than one
 * way to write itself: a dual-stack listener answers an IPv4 client as
 * ::ffff:10.0.0.5, and IPv6 text is case-insensitive. Normalising first keeps
 * the comparison about WHICH SERVER, not about how it spelled itself.
 */
export function normalizeServerAddress(value) {
    const text = String(value ?? "").trim().toLowerCase();
    const mapped = text.match(IPV4_MAPPED);
    return mapped ? mapped[1] : text;
}

/**
 * Is this already an address, or a name DNS has to answer for?
 *
 * Deliberately not a full validator: a wrong guess here only decides whether we
 * ASK DNS about the string, and DNS refuses a name that is not one.
 */
export function isAddressLiteral(host) {
    const text = normalizeServerAddress(host);
    if (!text) return false;
    if (IPV4_LITERAL.test(text)) return true;
    return text.includes(":") && /^[0-9a-f:.]+$/.test(text);
}

/**
 * The addresses --expect-host can legitimately turn out to be.
 *
 * A literal is itself. localhost is the loopback pair, answered here rather
 * than through the resolver because a machine may have no record for it.
 * Anything else is a NAME, and only DNS knows what it stands for.
 */
export async function resolveExpectedAddresses(expectHost, lookup) {
    const host = String(expectHost ?? "").trim();
    if (!host) return [];
    if (isAddressLiteral(host)) return [normalizeServerAddress(host)];
    if (host.toLowerCase() === "localhost") return ["127.0.0.1", "::1"];
    const records = await lookup(host, { all: true });
    const list = Array.isArray(records) ? records : [records];
    return list
        .map((record) => normalizeServerAddress(record && typeof record === "object" ? record.address : record))
        .filter(Boolean);
}

/**
 * THE HOST HALF OF THE GUARD, RESOLVED RATHER THAN STRING-COMPARED.
 *
 * The exact compare above asks whether the operator typed the same characters
 * the SERVER reports, and the server reports host(inet_server_addr()) -- an IP.
 * An operator naming the pooler (aws-0-us-west-2.pooler.supabase.com) could
 * therefore never satisfy it: the guard refused production for BEING
 * production, and a guard that cannot be satisfied correctly is one people
 * learn to weaken. Resolving the expected NAME and asking whether the address
 * we reached is one of its addresses is the same question, asked so it can
 * actually be answered.
 *
 * Still exact at the bottom: the connected address must be IN the resolved set.
 * No substring, no prefix, no "close enough".
 */
export async function hostMatchesResolved(actualHost, expectHost, lookup) {
    const actual = normalizeServerAddress(actualHost);
    const expected = String(expectHost ?? "").trim();
    if (!expected) return { ok: false, reason: "no --expect-host was given" };
    // A Unix-socket connection has no server address to report. The URL host
    // check (and, on prod, the project ref and the baseline row) has already
    // run, so there is nothing further this comparison can add: say so rather
    // than refuse a target the other guards already accepted.
    if (!actual) {
        return { ok: true, note: "inet_server_addr() is NULL (a Unix-socket connection): the URL host checked above is the only host evidence." };
    }
    if (normalizeServerAddress(expected) === actual) return { ok: true, note: null };
    let addresses;
    try {
        addresses = await resolveExpectedAddresses(expected, lookup);
    } catch (error) {
        return { ok: false, reason: `host "${expected}" could not be resolved: ${error?.message ?? error}` };
    }
    if (addresses.length === 0) return { ok: false, reason: `host "${expected}" resolved to no addresses` };
    if (addresses.includes(actual)) {
        return { ok: true, note: `host "${expected}" resolves to ${addresses.join(", ")}, which includes ${actual}` };
    }
    return { ok: false, reason: `host "${expected}" resolves to ${addresses.join(", ")}, not ${actual}` };
}

/**
 * The database name EXACTLY, then the host resolved. Carries the reason as
 * well as the verdict so a refusal can say which half of the target failed.
 */
export async function targetMatchesResolved(actual, expectDb, expectHost, lookup) {
    if (!actual || typeof actual !== "object") return { ok: false, reason: "the server reported no identity row" };
    if (String(actual.db ?? "") !== String(expectDb ?? "")) {
        return { ok: false, reason: `database "${String(actual.db ?? "")}" is not "${String(expectDb ?? "")}"` };
    }
    // Unchanged fast path: the operator passed the exact address the server
    // reports, which is what scripts/ci-apply-receipt-intake-e2e.mjs does. No DNS.
    if (targetMatches(actual, expectDb, expectHost)) return { ok: true, note: null };
    return hostMatchesResolved(actual.host, expectHost, lookup);
}

/** The real resolver, imported lazily so this module stays inert on import. */
async function lookupHostAddresses(host, options) {
    const dns = await import("node:dns/promises");
    return dns.lookup(host, options);
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
       "taxWarning"          TEXT,
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
       "uploadLeaseVersion"  INTEGER NOT NULL DEFAULT 0,
       "uploadLeaseNonce"    TEXT,
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
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "uploadLeaseVersion" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "uploadLeaseNonce" TEXT`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "sendAttempted" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "archivedByV1" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "claimToken" TEXT`,
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3)`,

    // The dropped-tax-reading marker's DURABLE home. It used to live in
    // `stateReason`, which every deferred booking and every park overwrites,
    // so a receipt that booked through the deferred path -- which is every
    // receipt during the disabled-push cutover -- reached BOOKED with the
    // warning already erased.
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "taxWarning" TEXT`,

    // THE STATE DEFAULT IS REPAIRED, not just declared on a fresh table.
    //
    // `CREATE TABLE IF NOT EXISTS` above carries DEFAULT 'STAGING', and a table
    // this script created in an EARLIER Phase-1 revision carries the old
    // DEFAULT 'RECEIVED'. Adding columns cannot fix that, so an upgraded
    // deployment kept minting rows that skip STAGING entirely: they are
    // claimable by the worker the instant they are inserted, before their
    // object exists, which is the state the two-step upload exists to prevent.
    // Idempotent — setting a default that already matches is a no-op.
    `ALTER TABLE "ReceiptIntake" ALTER COLUMN "state" SET DEFAULT 'STAGING'`,

    // ONE LIVE CLAIM PER OBJECT PATH. The primary key IS the invariant.
    //
    // Publishing and deleting the same object are mutually exclusive, and
    // that exclusion used to live entirely in an AutomationEvent's JSON
    // `detail` -- which no constraint enforced and which two concurrent
    // transactions could each read as 'free', because they touched different
    // rows. Both claim transactions now take a per-path advisory lock AND
    // write here, so a second live claim is impossible even if the lock were
    // somehow missed.
    `CREATE TABLE IF NOT EXISTS "ReceiptObjectClaim" (
       "storagePath" TEXT NOT NULL,
       "token"       TEXT NOT NULL,
       "kind"        TEXT NOT NULL,
       "expiresAt"   TIMESTAMP(3) NOT NULL,
       "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"   TIMESTAMP(3) NOT NULL,
       CONSTRAINT "ReceiptObjectClaim_pkey" PRIMARY KEY ("storagePath")
     )`,

    `CREATE INDEX IF NOT EXISTS "ReceiptObjectClaim_expiresAt_idx"
       ON "ReceiptObjectClaim"("expiresAt")`,

    `ALTER TABLE "ReceiptObjectClaim" ENABLE ROW LEVEL SECURITY`,

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

export const expectedColumns = {
    ReceiptObjectClaim: [
        "storagePath", "token", "kind", "expiresAt", "createdAt", "updatedAt",
    ],
    ReceiptIntake: [
        "id", "source", "sourceRef", "state", "dryRun", "stateReason", "taxWarning",
        "projectId", "costCodeId", "suggestedCostCodeId", "suggestedConfidence",
        "createdById", "storagePath", "fileName", "mimeType", "fileSize",
        "fileSha256", "expectedSha256", "uploadUrlExpiresAt", "uploadLeaseVersion",
        "uploadLeaseNonce",
        "sendAttempted", "archivedByV1",
        "vendor", "txnDate", "totalCents", "taxCents", "docType",
        "refNumber", "memo", "readJson", "readAt", "dedupStrongKey",
        "dedupWeakKey", "duplicateOfId", "qbPurchaseId", "expenseId",
        "archiveDriveFileId", "claimToken", "claimedAt",
        "attempts", "busyPasses", "lastError", "nextRetryAt",
        "bookedAt", "createdAt", "updatedAt",
    ],
};

/**
 * A NAME IS NOT A CONSTRAINT.
 *
 * The verification used to look each of these up by `conname` ALONE and, apart
 * from the state CHECK, assert nothing about what came back. Two ways that
 * passed while the table was wrong:
 *
 *   - `pg_constraint` is database-wide, not per-table. A constraint of the same
 *     name on ANY other relation satisfied the lookup, so a run against a
 *     database where `ReceiptIntake` never got its foreign keys could still
 *     report "verified 5 constraints". Every lookup is scoped to
 *     `ReceiptIntake` now, exactly like the DDL guards above already are.
 *   - Even on the right table, existence says nothing about the TARGET or the
 *     ACTIONS. An FK left over from an earlier shape (pointing at the wrong
 *     parent, or ON DELETE CASCADE instead of SET NULL) is the difference
 *     between "losing a project nulls a column" and "losing a project DELETES
 *     the audit trail of a booked receipt" — which is the one thing the comment
 *     above the DDL says must never happen. So each FK's full definition is
 *     compared: referencing column, referenced table and column, and both
 *     referential actions.
 *
 * These fields mirror the ALTER TABLE statements above one for one, and
 * tests/apply-receipt-intake.test.ts asserts that parity against both the
 * script's own SQL and the committed migration, so the expectation cannot drift
 * away from what is actually applied.
 */
export const expectedConstraints = [
    { name: "ReceiptIntake_state_check", table: "ReceiptIntake", kind: "check" },
    {
        name: "ReceiptIntake_projectId_fkey", table: "ReceiptIntake", kind: "fk",
        column: "projectId", references: "Project", referencedColumn: "id",
        onDelete: "SET NULL", onUpdate: "CASCADE",
    },
    {
        name: "ReceiptIntake_costCodeId_fkey", table: "ReceiptIntake", kind: "fk",
        column: "costCodeId", references: "CostCode", referencedColumn: "id",
        onDelete: "SET NULL", onUpdate: "CASCADE",
    },
    {
        name: "ReceiptIntake_createdById_fkey", table: "ReceiptIntake", kind: "fk",
        column: "createdById", references: "User", referencedColumn: "id",
        onDelete: "SET NULL", onUpdate: "CASCADE",
    },
    {
        name: "ReceiptIntake_expenseId_fkey", table: "ReceiptIntake", kind: "fk",
        column: "expenseId", references: "Expense", referencedColumn: "id",
        onDelete: "SET NULL", onUpdate: "CASCADE",
    },
];

/**
 * SCOPED TO THE TABLE. `$1` is the constraint name; the relation is pinned in
 * the SQL itself, the same `'"ReceiptIntake"'::regclass` the DDL guards use.
 */
export const CONSTRAINT_LOOKUP_SQL =
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = $1
        AND conrelid = '"ReceiptIntake"'::regclass`;

/** Every referential action Postgres can render, longest first so the match is greedy enough. */
const FK_ACTIONS = "NO ACTION|SET DEFAULT|SET NULL|RESTRICT|CASCADE";

/** `"a", "b"` / `a` -> ["a", "b"] / ["a"]. pg quotes an identifier only when it must. */
function identList(raw) {
    return raw
        .split(",")
        .map(part => part.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
}

/**
 * Compare a live `pg_get_constraintdef` rendering against what the migration
 * says the foreign key is. Returns a human description of every difference, or
 * null when they agree.
 *
 * Parsed rather than string-compared on purpose: pg's rendering is not ours to
 * predict (identifier quoting depends on the identifier, the clause order is
 * pg's own, and a schema qualification appears only when the relation is not on
 * the search path). An exact-string expectation would fail on rendering rather
 * than on drift, which teaches everyone to ignore it.
 *
 * An ABSENT action clause means the SQL default, NO ACTION — not "unspecified".
 * That distinction is the whole point here: an FK created without ON DELETE
 * behaves as NO ACTION, and NO ACTION is exactly the value that would block a
 * project delete instead of nulling the column.
 */
export function foreignKeyDrift(expected, def) {
    if (typeof def !== "string") return "no definition returned";
    const shape = /^FOREIGN KEY\s*\((.+?)\)\s*REFERENCES\s+(.+?)\s*\((.+?)\)\s*(.*)$/.exec(def.trim());
    if (!shape) return `not a FOREIGN KEY definition: ${def}`;
    const [, columns, referenced, referencedColumns, tail] = shape;

    const actionFor = keyword => {
        const found = new RegExp(`ON ${keyword}\\s+(${FK_ACTIONS})`, "i").exec(tail);
        return (found ? found[1] : "NO ACTION").toUpperCase();
    };

    const problems = [];
    const check = (label, actual, want) => {
        if (actual !== want) problems.push(`${label} is ${actual}, want ${want}`);
    };
    check("column", identList(columns).join(", "), expected.column);
    check("referenced table", identList(referenced.replace(/^public\./, "")).join(", "), expected.references);
    check("referenced column", identList(referencedColumns).join(", "), expected.referencedColumn);
    check("ON DELETE", actionFor("DELETE"), expected.onDelete);
    check("ON UPDATE", actionFor("UPDATE"), expected.onUpdate);
    return problems.length ? problems.join("; ") : null;
}

/**
 * The whole constraint verification, over an injected query so it is testable
 * without a database. `query(sql, name)` must resolve to the rows the lookup
 * returns — zero rows meaning "not on THIS table", which is a failure, never a
 * pass.
 */
/**
 * The column defaults the shape depends on, and which the upgrade path can
 * silently leave wrong.
 *
 * A verify that reads column NAMES cannot see this: the column is present
 * either way. `ReceiptIntake.state` created by an earlier Phase-1 revision
 * defaults to 'RECEIVED', so every row inserted without an explicit state
 * skipped STAGING and became claimable by the worker before its object
 * existed. Pure, so the comparison is a unit test rather than a live DB.
 */
export const expectedColumnDefaults = {
    ReceiptIntake: { state: "'STAGING'::text" },
};

/** Does a `column_default` read from Postgres match what we require? */
export function columnDefaultMatches(actual, expected) {
    if (typeof actual !== "string") return false;
    // Postgres renders a text literal default as `'STAGING'::text`; accept the
    // bare literal too so the check does not depend on how it echoes casts.
    const normalise = (v) => v.replace(/::[a-z ]+$/i, "").trim();
    return normalise(actual) === normalise(expected);
}

export async function verifyColumnDefaults(query) {
    const problems = [];
    const notes = [];
    for (const [table, columns] of Object.entries(expectedColumnDefaults)) {
        for (const [column, expected] of Object.entries(columns)) {
            const rows = await query(
                `SELECT column_default FROM information_schema.columns
                  WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
                table,
                column,
            );
            const actual = rows?.[0]?.column_default ?? null;
            if (!columnDefaultMatches(actual, expected)) {
                problems.push(
                    `${table}.${column} default is ${actual === null ? "(none)" : actual}, expected ${expected}`,
                );
            } else {
                notes.push(`verified default ${table}.${column} = ${expected}`);
            }
        }
    }
    return { problems, notes };
}

export async function verifyConstraints(query) {
    const problems = [];
    const notes = [];
    for (const expected of expectedConstraints) {
        const [row] = await query(CONSTRAINT_LOOKUP_SQL, expected.name);
        if (!row) {
            problems.push(`constraint ${expected.name} missing on ${expected.table}`);
            continue;
        }
        if (expected.kind === "check") {
            // Existence is not enough for the state CHECK: an OLD definition
            // still exists, and it is the thing that breaks the cutover.
            const missing = RECEIPT_INTAKE_STATES.filter(state => !row.def.includes(`'${state}'`));
            if (missing.length) {
                problems.push(`${expected.name} does not allow: ${missing.join(", ")}\n  actual: ${row.def}`);
                continue;
            }
            notes.push(`verified ${expected.name}: all ${RECEIPT_INTAKE_STATES.length} states allowed`);
            continue;
        }
        const drift = foreignKeyDrift(expected, row.def);
        if (drift) {
            problems.push(`${expected.name} has drifted: ${drift}\n  actual: ${row.def}`);
            continue;
        }
        notes.push(`verified ${expected.name}: ${row.def}`);
    }
    return { problems, notes };
}

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
// The SAME ceiling QuickBooks will attach at (MAX_STORED_BYTES /
// QBO_ATTACHMENT_MAX_BYTES in src/lib/receipt-intake/intake-core.ts, asserted
// equal by tests/apply-receipt-intake.test.ts). A bucket that accepts more than
// QBO can attach stores receipts that are guaranteed to strand.
export const RECEIPT_BUCKET_FILE_SIZE_LIMIT = 8 * 1024 * 1024;
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
        console.error("  The bucket carries the 8 MiB and MIME limits that the signed-upload path cannot enforce anywhere else.");
        process.exit(1);
    }
    const outcome = await ensureReceiptBucket(baseUrl, key);
    console.log(`bucket ${RECEIPT_BUCKET}: ${outcome} (private, ${RECEIPT_BUCKET_FILE_SIZE_LIMIT} bytes, ${RECEIPT_BUCKET_MIME_TYPES.length} mime types)`);
}

async function main() {
    // EVERY flag is read here, inside main(), so the module stays inert on
    // import -- see tests/apply-scripts-inert-on-import.test.ts.
    const chosen = chooseTarget(process.argv);
    if (!chosen.ok) {
        console.error(chosen.reason);
        process.exit(1);
    }
    const dryRun = process.argv.includes("--dry-run");
    if (!dryRun && !process.argv.includes("--yes")) {
        console.error("Refusing to run without --yes (and --expect-db / --expect-host).");
        process.exit(1);
    }
    const expectDb = readFlagValue("--expect-db") ?? process.env.RECEIPT_INTAKE_EXPECT_DB;
    const expectHost = readFlagValue("--expect-host") ?? process.env.RECEIPT_INTAKE_EXPECT_HOST;
    if (!expectDb || !expectHost) {
        console.error("Both --expect-db and --expect-host are required (or RECEIPT_INTAKE_EXPECT_DB / RECEIPT_INTAKE_EXPECT_HOST).");
        process.exit(1);
    }

    const { url, from } = resolveTargetUrl(chosen.target);
    console.log(`DATABASE_URL from ${from}: ${maskUrl(url)}`);
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        // WHO ARE WE TALKING TO -- asserted, then PRINTED, before any DDL.
        const identity = await verifyProdIdentity(
            (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args),
            hostOf(url),
            projectRefOf(url),
            process.env[PROJECT_REF_ENV],
            chosen.target,
        );
        console.log(identity.line);
        if (identity.problems.length) {
            for (const problem of identity.problems) console.error(`REFUSING: ${problem}`);
            process.exit(1);
        }
        const actual = identity.actual;
        console.log(`connected to db="${actual.db}" host="${actual.host}"`);
        const match = await targetMatchesResolved(actual, expectDb, expectHost, lookupHostAddresses);
        if (!match.ok) {
            console.error(`REFUSING: expected db="${expectDb}" host="${expectHost}" but connected to db="${actual.db}" host="${actual.host}" (${match.reason}).`);
            process.exit(1);
        }
        if (match.note) console.log(match.note);

        if (dryRun) {
            console.log(`--dry-run: ${statements.length} statements would run against the target above.`);
            for (const sql of statements) {
                console.log(`  ${sql.replace(/\s+/g, " ").slice(0, 84)}`);
            }
            return;
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
        // DEFAULTS, not just names: an upgraded table has every column and the
        // wrong `state` default, which a name check reports as clean.
        const defaults = await verifyColumnDefaults(
            (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args),
        );
        for (const note of defaults.notes) console.log(note);
        if (defaults.problems.length) {
            for (const problem of defaults.problems) console.error(`VERIFY FAILED: ${problem}`);
            process.exit(1);
        }

        const constraints = await verifyConstraints(
            (sql, name) => prisma.$queryRawUnsafe(sql, name),
        );
        for (const note of constraints.notes) console.log(note);
        if (constraints.problems.length) {
            for (const problem of constraints.problems) console.error(`VERIFY FAILED: ${problem}`);
            process.exit(1);
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
        // THE BUCKET IS PART OF THE PROD TARGET, not of the schema. It lives
        // in Supabase, and `--target ci` runs against a throwaway Postgres
        // container with no Supabase project behind it -- demanding a service
        // key there would mean either failing every CI run or putting a real
        // key in the workflow, and the whole point of that target is that it
        // cannot reach a real project. The bucket's own policy is asserted
        // separately by tests/apply-receipt-intake.test.ts, against the
        // constants the code writes through.
        if (chosen.target === "prod") {
            await applyBucket();
        } else {
            console.log(`bucket ${RECEIPT_BUCKET}: skipped (--target ${chosen.target} has no Supabase project)`);
        }

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
