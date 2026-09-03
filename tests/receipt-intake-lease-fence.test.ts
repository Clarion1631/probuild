/**
 * THE TRIPWIRE: one builder for every lease-bearing CAS.
 *
 * A ReceiptIntake row that carries an upload lease can be moved by several
 * different writers, and each of them has to fence on the SAME identity —
 * state, reason, claim, `uploadLeaseVersion`, `uploadLeaseNonce` and
 * `uploadUrlExpiresAt`. The nonce and the expiry are the load-bearing half:
 * `reuseLiveLease` reissues a working signed URL over the same path at the same
 * version, moving ONLY those two columns, so a fence built from state + version
 * still matches a row somebody has just re-leased.
 *
 * That has now been found three rounds running, in a different writer each
 * time — the /finalize publish, the /finalize reject, the /start resume, and
 * three separate writes in the stale-STAGING sweeper. Every one of them was a
 * hand-rolled `where` listing part of the identity. Fixing them one at a time
 * does not stop the next one, because nothing makes the omission visible.
 *
 * So this test reads the source of every such file, finds EVERY `update` /
 * `updateMany` / `delete` / `deleteMany` call in them, and fails when a call's
 * arguments mention `uploadLeaseVersion` without going through `leaseFence(`.
 * Its value is entirely in failing for the NEXT writer somebody adds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/**
 * Every file that may move a lease-bearing row. Listed explicitly rather than
 * globbed: a new file that writes these rows should have to be added here on
 * purpose, and that addition is the moment somebody reads this rule.
 */
const LEASE_WRITERS = [
    "src/app/api/receipts/intake/start/route.ts",
    "src/app/api/receipts/intake/[id]/finalize/route.ts",
    "src/app/api/receipts/intake/route.ts",
    "src/lib/receipt-intake/stored-object.ts",
    "src/lib/receipt-intake/storage-cleanup.ts",
    "src/lib/receipt-intake/upload-lease.ts",
    "src/app/api/cron/receipt-intake-worker/route.ts",
];

const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * The balanced argument text of every mutating Prisma call in one file.
 *
 * Balanced, not regex-to-the-next-brace: these arguments nest objects several
 * levels deep, and a naive match stops inside the first `data: { ... }` — which
 * is exactly where a missed `where` would hide.
 */
function mutatingCalls(src: string): { name: string; args: string; at: number }[] {
    const calls: { name: string; args: string; at: number }[] = [];
    const opener = /\.(update|updateMany|delete|deleteMany)\(/g;
    let m: RegExpExecArray | null;
    while ((m = opener.exec(src))) {
        const from = m.index + m[0].length;
        let depth = 1;
        let i = from;
        for (; i < src.length && depth > 0; i++) {
            const c = src[i];
            if (c === "(") depth++;
            else if (c === ")") depth--;
        }
        calls.push({ name: m[1], args: src.slice(from, i - 1), at: m.index });
    }
    return calls;
}

test("the extractor really is balanced — the control", () => {
    // Without this the tripwire could quietly stop reading at the first nested
    // brace and pass every file by seeing nothing at all.
    const sample = [
        "await tx.receiptIntake.updateMany({",
        "    where: { id, ...leaseFence(row) },",
        "    data: { nested: { deeper: (1 + 2) }, uploadLeaseVersion: 3 },",
        "});",
        "after();",
    ].join("\n");
    const [call] = mutatingCalls(sample);
    assert.equal(call.name, "updateMany");
    assert.match(call.args, /leaseFence\(row\)/);
    assert.match(call.args, /deeper/, "it did not stop at the first nested object");
    assert.ok(!call.args.includes("after()"), "and it did not run past the call either");
    // Two calls in one file are found separately.
    assert.equal(mutatingCalls("a.update({x:1}); b.deleteMany({y:2});").length, 2);
});

test("EVERY lease-bearing write builds its fence with leaseFence()", () => {
    const offenders: string[] = [];
    let audited = 0;

    for (const rel of LEASE_WRITERS) {
        const src = source(rel);
        for (const call of mutatingCalls(src)) {
            // Only the calls that fence on a lease at all. A write with no
            // `uploadLeaseVersion` in its arguments is making no claim about
            // which lease it observed, so it is out of scope here.
            if (!call.args.includes("uploadLeaseVersion")) continue;
            audited++;
            if (call.args.includes("leaseFence(")) continue;
            const line = src.slice(0, call.at).split("\n").length;
            offenders.push(`${rel}:${line} .${call.name}()`);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `these lease-bearing writes do not go through leaseFence():\n  ${offenders.join("\n  ")}`,
    );
    // The tripwire has to be LOOKING at something. A rename of the column, or a
    // file list gone stale, would otherwise leave it green while auditing
    // nothing at all.
    assert.ok(audited >= 1, `expected at least one lease-fenced write, audited ${audited}`);
});

test("the tripwire FAILS on a half fence — the pre-fix control", () => {
    // The exact shape all of the last rounds' findings had: a where pinning the
    // state and the version and nothing else. Run through the same extractor,
    // so this proves the check would have caught them.
    const halfFenced = [
        "await prisma.receiptIntake.updateMany({",
        '    where: { id: row.id, state: "STAGING", uploadLeaseVersion: row.uploadLeaseVersion },',
        '    data: { state: "NEEDS_REVIEW" },',
        "});",
    ].join("\n");
    const [call] = mutatingCalls(halfFenced);
    assert.ok(call.args.includes("uploadLeaseVersion"), "it is in scope");
    assert.ok(!call.args.includes("leaseFence("), "and it would be reported");

    // ...and it is accepted once the fence goes through the builder.
    const [fixed] = mutatingCalls([
        "await prisma.receiptIntake.updateMany({",
        "    where: { id: row.id, ...leaseFence(row) },",
        '    data: { state: "NEEDS_REVIEW" },',
        "});",
    ].join("\n"));
    assert.ok(fixed.args.includes("leaseFence("));
});

test("publishFence has NO caller left: every lease writer takes the full fence", () => {
    // It used to have exactly one exception -- reuseLiveLease -- on the
    // reasoning that pinning the nonce there would turn an honest second retry
    // into a 409. That reasoning was the round-19 bug: leaving the nonce out
    // let BOTH retries write, each stamping its own generation, so the earlier
    // caller's 200 carried a lease /finalize refuses. The rule now pins the
    // whole fence and CONVERGES the loser on the winner's lease instead, so
    // the exception is gone and the weaker builder has no user outside the
    // module that defines it.
    const users = LEASE_WRITERS.filter(rel => /\bpublishFence\(/.test(source(rel)));
    assert.deepEqual(
        users,
        ["src/lib/receipt-intake/stored-object.ts"],
        "publishFence is referenced only where it is defined",
    );
    const lease = source("src/lib/receipt-intake/upload-lease.ts");
    const reuse = lease.slice(lease.indexOf("export async function reuseLiveLease"));
    const body = reuse.slice(0, reuse.search(/\n\}\n/));
    assert.match(body, /\.\.\.leaseFence\(observed\)/, "the adoption CAS carries the generation");
    assert.ok(!/publishFence\(/.test(body), "and nothing weaker");
});

test("leaseFence is a SUPERSET of publishFence, and names the lease generation", () => {
    // If the builder ever stopped carrying the nonce or the expiry, every call
    // site would keep compiling and every fence would silently weaken.
    const stored = source("src/lib/receipt-intake/stored-object.ts");
    const fn = stored.slice(stored.indexOf("export function leaseFence"));
    const body = fn.slice(0, fn.search(/\n\}\n/));
    assert.match(body, /\.\.\.publishFence\(row\)/);
    assert.match(body, /uploadLeaseNonce: row\.uploadLeaseNonce/);
    assert.match(body, /uploadUrlExpiresAt: row\.uploadUrlExpiresAt/);
});

// ── /finalize IS BOUND TO THE LEASE THAT ISSUED ITS URL (round-15 item 1) ──
//
// /start rotates `uploadLeaseNonce` on every issue and every adoption, and it
// now RETURNS that value. /finalize used to read the row's CURRENT nonce, so a
// delayed finalizer silently ADOPTED whichever lease had been issued since —
// and both /start calls hand out URLs for the SAME path. Client A starts an
// upload; B's retry refreshes the lease and gets a working URL; A's finalize
// finally arrives, inspects B's half-written object, judges it unacceptable
// and DELETES the row while B is still uploading to a URL that works.

test("every /start response echoes the generation its URL was issued under", () => {
    // Five ways out of /start, five leases. A branch that forgot to echo one
    // would hand a client a URL it could never finalize.
    const start = readFileSync(
        path.join(ROOT, "src/app/api/receipts/intake/start/route.ts"),
        "utf8",
    );
    // Each of the three appears TWICE now: once in the re-read that confirms
    // it is still the persisted generation, and once in the response.
    for (const name of ['leaseNonce', 'rearmedLease', 'resumedLease'] as const) {
        const uses = (start.match(new RegExp(`uploadLease: ${name}\\b`, 'g')) ?? []).length;
        assert.equal(uses, 2, `${name} is confirmed and then echoed`);
    }
    // The other two come through the shared reuse rule, which returns it.
    const lease = readFileSync(path.join(ROOT, "src/lib/receipt-intake/upload-lease.ts"), "utf8");
    // AN EXTENSION KEEPS THE GENERATION IT ADOPTED. Minting a fresh one per
    // adoption is what stranded the first of two concurrent 200s: only the
    // last write survives, and /finalize refuses every earlier nonce.
    assert.match(lease, /const uploadLease = observed\.uploadLeaseNonce \?\? \(deps\.nonce \?\? newLeaseNonce\)\(\);/);
    assert.match(lease, /signed: \{ \.\.\.signed, uploadLease \}/);
    // ...and it is the SAME value written to the row, not a second draw.
    assert.match(lease, /uploadLeaseNonce: uploadLease,/);

    // AND NO BRANCH RETURNS A LEASE IT HAS NOT RE-READ. The three that mint
    // a genuinely new one write, then sign, then answer -- and a concurrent
    // /start can move the row inside that gap.
    const confirms = (start.match(/await issuedLeaseIsCurrent\(/g) ?? []).length;
    assert.equal(confirms, 3, "create, re-arm and resume each re-read before answering");
    // The reuse rule confirms its own, by looping rather than by conflicting.
    assert.match(lease, /const confirmed = await deps\.reload\(observed\.id\);/);
});

test("/finalize REQUIRES the lease, and refuses a stale one before touching storage", () => {
    const finalize = readFileSync(
        path.join(ROOT, "src/app/api/receipts/intake/[id]/finalize/route.ts"),
        "utf8",
    );
    // The gate exists, and says which lease it compares against.
    assert.match(finalize, /if \(!declaredLease \|\| declaredLease !== row\.uploadLeaseNonce\)/);
    assert.match(finalize, /error: "lease-stale"/);
    assert.match(finalize, /retryable: false/, "a stale lease is not fixed by retrying");

    // ORDER IS THE PROPERTY. After authorization (so a caller who may not see
    // the row cannot learn its lease is stale), and before the declared-hash
    // check, the disposition split, and every storage call.
    const gateAt = finalize.indexOf('error: "lease-stale"');
    const authAt = finalize.indexOf("const maySee");
    const shaAt = finalize.indexOf("declaredShaConflict(row.fileSha256");
    const inspectAt = finalize.indexOf("await inspectStoredObject(");
    const rejectAt = finalize.indexOf("rejectRowAndQueueCleanup(");
    const publishAt = finalize.indexOf("await sealAndPublish(");
    assert.ok(authAt > 0 && authAt < gateAt, "authorization first");
    for (const [name, at] of [["sha", shaAt], ["inspect", inspectAt], ["reject", rejectAt], ["publish", publishAt]] as const) {
        assert.ok(at > gateAt, `the gate runs before ${name}`);
    }
});

test("the fences pin the ECHOED lease, not the freshly read one", () => {
    // Equal by the gate — and written this way so a future edit that moved or
    // weakened the gate leaves these CASes pinning a generation nobody proved.
    const finalize = readFileSync(
        path.join(ROOT, "src/app/api/receipts/intake/[id]/finalize/route.ts"),
        "utf8",
    );
    assert.match(finalize, /const leased = \{ \.\.\.row, uploadLeaseNonce: declaredLease \};/);
    assert.match(finalize, /\.\.\.leaseFence\(leased\)/);
    assert.match(finalize, /uploadLeaseNonce: leased\.uploadLeaseNonce,/, "the reject fence too");
    // PRE-FIX CONTROL: no fence still reads the row's own nonce directly.
    assert.ok(
        !/\.\.\.leaseFence\(row\)/.test(finalize),
        "nothing fences on the freshly-read row any more",
    );
});

test("LEASE-STALE: the ordering, as a decision table", () => {
    // The gate is a pure comparison, so its truth table is a unit test rather
    // than a race. `stale` is what the route computes.
    const stale = (declared: string | null, current: string | null) =>
        !declared || declared !== current;

    assert.equal(stale("nonce-a", "nonce-a"), false, "the lease it was issued under");
    assert.equal(stale("nonce-a", "nonce-b"), true, "a lease that has since been refreshed");
    assert.equal(stale(null, "nonce-a"), true, "omitting it is not a way round the gate");
    assert.equal(stale("nonce-a", null), true, "a row that never had a signed URL");
    assert.equal(stale(null, null), true, "and neither is the null/null case");
});

// ── NO EXTERNAL I/O INSIDE A DATABASE TRANSACTION (round-17 item 3) ───────
//
// The advisory-lock scheme held an interactive transaction — a pooled
// connection — across Supabase calls the round-16 deadline caps at fifteen
// seconds. Four concurrent finalizations exhausted the five-connection pool.
// The lock is gone; this is the tripwire that stops it coming back under
// another name.

test("the object-lock helpers are GONE, and nothing reaches for them", () => {
    for (const rel of LEASE_WRITERS) {
        const src = source(rel);
        for (const banned of ["withReceiptObjectLock(", "withReceiptPublishLock("]) {
            assert.ok(
                !src.includes(banned),
                `${rel} still calls ${banned}: external I/O must not run inside a transaction`,
            );
        }
    }
});

test("the ONE surviving advisory lock holds no external I/O", () => {
    // `pg_advisory_xact_lock` is not banned outright — it is the right tool
    // for a critical section that is PURELY database work. Exactly one such
    // section survives: the weak-key check inside promoteToBooking, which
    // serializes two rows sharing a dedup key across a SELECT and an UPDATE
    // and calls nothing external. The object locks were different in kind:
    // they wrapped Supabase round trips.
    const users = LEASE_WRITERS.filter(rel => source(rel).includes("pg_advisory_xact_lock"));
    assert.deepEqual(
        users,
        ["src/app/api/cron/receipt-intake-worker/route.ts"],
        "only the weak-key promotion still takes an advisory lock",
    );
    const cron = source("src/app/api/cron/receipt-intake-worker/route.ts");
    const promote = cron.slice(cron.indexOf("promoteToBooking: async"));
    const body = promote.slice(0, promote.indexOf("book: row =>"));
    assert.match(body, /pg_advisory_xact_lock/, "it lives where the comment says");
    for (const external of ["storage", "downloadReceiptObject", "removeReceiptObject", "uploadReceiptObject", "fetch("]) {
        assert.ok(!body.includes(external), `the weak-key section calls nothing external (${external})`);
    }
});

test("every transaction helper the intake uses is a SHORT one", () => {
    // `inShortTx` is the only transaction wrapper in this feature, and its
    // timeout says so: a body that needs longer than five seconds without
    // external I/O is doing something its own doc comment forbids.
    const cleanup = source("src/lib/receipt-intake/storage-cleanup.ts");
    const fn = cleanup.slice(cleanup.indexOf("export async function inShortTx"));
    const body = fn.slice(0, fn.search(/\n\}\n/));
    assert.match(body, /prisma\.\$transaction\(body, \{ maxWait: 5_000, timeout: 5_000 \}\)/);
    // The 30-second window the lock needed is gone with it.
    assert.ok(!cleanup.includes("timeout: 30_000"), "no transaction is sized for a storage round trip");
});

test("the SEAL happens outside every transaction — asserted on the shipped order", () => {
    // The publish protocol, read off the source: claim, then seal, THEN open a
    // transaction. A future edit that moved the seal back inside would have to
    // move it past the `inShortTx(` call to pass this.
    const stored = source("src/lib/receipt-intake/stored-object.ts");
    const fn = stored.slice(stored.indexOf("export async function sealAndPublish"));
    const claimAt = fn.indexOf("deps.claimCanonicalPath(");
    const sealAt = fn.indexOf("await deps.seal(");
    const txAt = fn.indexOf("await deps.inShortTx(");
    assert.ok(claimAt > 0 && sealAt > 0 && txAt > 0, "all three phases are present");
    assert.ok(claimAt < sealAt, "the path is claimed before it is written");
    assert.ok(sealAt < txAt, "and the seal precedes any open transaction");
});

test("the cleanup sweep does its DELETE outside a transaction too", () => {
    // Same shape on the other side: claim in a short tx, delete with none
    // open, settle in a second short tx.
    const cleanup = source("src/lib/receipt-intake/storage-cleanup.ts");
    const fn = cleanup.slice(cleanup.indexOf("export async function retryPendingCleanups"));
    const claimAt = fn.indexOf("const claim = await deps.inShortTx(");
    const removeAt = fn.indexOf("await deps.remove(storagePath)");
    const settleAt = fn.indexOf("const settled = await deps.inShortTx(");
    assert.ok(claimAt > 0 && removeAt > 0 && settleAt > 0);
    assert.ok(claimAt < removeAt, "the claim comes first");
    assert.ok(removeAt < settleAt, "the delete runs between the two transactions, not inside either");
});

// ── Why the DB-gated proof may not use the app's prisma singleton ──────────
//
// CI's "Migrations reproduce production" job failed on the connection-hold
// tests with `not ok 11` and `not ok 13`. The cause was not the concurrency
// protocol they measure. Those tests called the shipped `inShortTx`, which
// runs on the app's prisma singleton — and that singleton REFUSES a
// DATABASE_URL without `pgbouncer=true`. The rule is correct (Supabase's
// transaction pooler needs it, and without it prod falls over with 42P05), and
// CI's migrations job points at a plain Postgres container, so the singleton
// could never be built there. `sealAndPublish` caught the throw, returned its
// retryable null, and the assertion saw `undefined` — a connection-string
// failure wearing a concurrency failure's clothes.
//
// The tests now build their transaction helper over their own client. These
// two guards keep that true and record why.

test("the app's prisma singleton REFUSES a plain Postgres URL — the root cause", async () => {
    const before = process.env.DATABASE_URL;
    // CI's migrations job, verbatim from .github/workflows/ci.yml.
    process.env.DATABASE_URL = "postgresql://probuild:probuild@localhost:5432/probuild_migrations";
    try {
        const { prisma } = await import("../src/lib/prisma");
        assert.throws(
            () => { void (prisma as unknown as Record<string, unknown>).receiptIntake; },
            /pgbouncer=true/,
            "any test touching the singleton dies on CI's plain Postgres, whatever it meant to measure",
        );
    } finally {
        if (before === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = before;
    }
});

test("the migrations job's URL really is the plain one, and e2e's is not", () => {
    const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const urls = ci.match(/postgresql:\/\/probuild:probuild@localhost:5432\/\S+/g) ?? [];
    assert.ok(urls.length >= 2, "both jobs name their database");
    assert.ok(
        urls.some(u => u.includes("probuild_migrations") && !u.includes("pgbouncer")),
        "the migrations job is plain Postgres — the singleton cannot be built there",
    );
    assert.ok(
        urls.some(u => u.includes("probuild_e2e") && u.includes("pgbouncer=true")),
        "the e2e job carries the flag, which is why it never hit this",
    );
});

test("the DB-gated proof builds its OWN client, never the singleton", () => {
    const db = readFileSync(path.join(ROOT, "tests/receipt-intake-claim-db.test.ts"), "utf8");
    assert.ok(
        !/inShortTx.*from "\.\.\/src\/lib\/receipt-intake\/storage-cleanup"/.test(db),
        "it must not import the singleton-backed transaction helper",
    );
    assert.ok(!/from "\.\.\/src\/lib\/prisma"/.test(db), "nor the singleton itself");
    assert.match(db, /const shortTx = /, "it builds the short transaction over its own client");
    assert.match(db, /db!\.\$transaction\(tx => body\(tx\), \{ maxWait: 5_000, timeout: 5_000 \}\)/,
        "with the SAME options as the shipped helper, so the protocol is what is measured");
});

// -- A MESSAGE PASSED TO A NO-ARGUMENT MATCHER IS NOT AN ASSERTION ---------
//
// `expect(x).toBeUndefined("why")` does not check anything: Playwright
// refuses it with `Matcher error: this matcher must not have an expected
// argument`, so the test fails on the CALL rather than on the value -- and
// while it is failing it is telling you nothing about the value at all. It
// cost a red CI run on the round-19 /start union specs, where three
// assertions about the response shape had never once been evaluated. The
// message belongs on expect(): `expect(x, "why").toBeUndefined()`.
//
// tsc does not catch it (Playwright types these matchers as `(...args: any)`),
// so a source check is the only thing that can.

test("no e2e spec passes a message to a matcher that takes no argument", () => {
    const dir = path.join(ROOT, "e2e");
    const specs = readdirSync(dir).filter(name => name.endsWith(".spec.ts"));
    assert.ok(specs.length > 10, "the spec folder was found");

    const noArgMatchers = /\.(toBeTruthy|toBeFalsy|toBeUndefined|toBeDefined|toBeNull|toBeNaN)\(\s*[^)\s]/g;
    const offenders: string[] = [];
    for (const name of specs) {
        const body = readFileSync(path.join(dir, name), "utf8");
        body.split(/\r?\n/).forEach((line, i) => {
            noArgMatchers.lastIndex = 0;
            if (noArgMatchers.test(line)) offenders.push(`${name}:${i + 1} ${line.trim()}`);
        });
    }
    assert.deepEqual(offenders, [], `pass the message to expect() instead:\n${offenders.join("\n")}`);
});
