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
import { readFileSync } from "node:fs";
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

test("publishFence is the documented EXCEPTION, and only reuseLiveLease may use it", () => {
    // The weaker fence exists for exactly one caller: two honest /start retries
    // may both adopt the same live lease, and pinning the nonce there would
    // turn the second into a 409 and break the idempotency upload-lease.ts
    // exists to provide. Anywhere else it is the bug this tripwire is about.
    const users = LEASE_WRITERS.filter(rel => /\bpublishFence\(/.test(source(rel)));
    assert.deepEqual(
        users,
        ["src/lib/receipt-intake/stored-object.ts", "src/lib/receipt-intake/upload-lease.ts"],
        "publishFence is referenced only where it is defined and by reuseLiveLease",
    );
    const lease = source("src/lib/receipt-intake/upload-lease.ts");
    const reuse = lease.slice(lease.indexOf("export async function reuseLiveLease"));
    assert.match(reuse.slice(0, reuse.search(/\n\}\n/)), /publishFence\(row\)/);
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
    assert.equal(
        (start.match(/uploadLease: (leaseNonce|rearmedLease|resumedLease)/g) ?? []).length,
        3,
        "create, re-arm and resume each echo the nonce they wrote",
    );
    // The other two come through the shared reuse rule, which returns it.
    const lease = readFileSync(path.join(ROOT, "src/lib/receipt-intake/upload-lease.ts"), "utf8");
    assert.match(lease, /const uploadLease = \(deps\.nonce \?\? newLeaseNonce\)\(\);/);
    assert.match(lease, /signed: \{ \.\.\.signed, uploadLease \}/);
    // ...and it is the SAME value written to the row, not a second draw.
    assert.match(lease, /uploadLeaseNonce: uploadLease,/);
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
