/**
 * The orphaned-object cleanup queue.
 *
 * This exists for one failure: a row is deleted while its object may still be
 * in the bucket. After that nothing in the database references those bytes, so
 * the queue record IS the last pointer to them — which makes "best effort" the
 * wrong posture for writing it, and makes deleting the wrong path unrecoverable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const cleanup = readFileSync(path.join(ROOT, "src/lib/receipt-intake/storage-cleanup.ts"), "utf8");
const intake = readFileSync(path.join(ROOT, "src/app/api/receipts/intake/route.ts"), "utf8");
const bucket = readFileSync(path.join(ROOT, "src/lib/receipt-intake/bucket.ts"), "utf8");
const start = readFileSync(path.join(ROOT, "src/app/api/receipts/intake/start/route.ts"), "utf8");

/**
 * The body of one top-level function, EOL-agnostic.
 *
 * `indexOf("\n}\n")` returns -1 on a CRLF checkout (the bytes there are
 * "\r\n}\r\n"), and `slice(0, -1)` then quietly hands back the REST OF THE
 * FILE — so an assertion scoped to one function silently starts reading every
 * function after it, and these tests pass or fail for the wrong reason. Git's
 * autocrlf makes that a property of who cloned the repo, not of the code.
 */
function bodyOf(source: string, declaration: string): string {
    const from = source.indexOf(declaration);
    assert.notEqual(from, -1, `not found: ${declaration}`);
    const rest = source.slice(from);
    const end = rest.search(/\r?\n\}\r?\n/);
    assert.notEqual(end, -1, `no closing brace found for ${declaration}`);
    return rest.slice(0, end);
}

test("bodyOf stops at the function it was given, on either line ending", () => {
    // The control. Without it the helper could go back to returning the whole
    // file and every assertion below would still pass.
    const lf = "function a() {\n    inA();\n}\n\nfunction b() {\n    inB();\n}\n";
    for (const text of [lf, lf.replace(/\n/g, "\r\n")]) {
        const body = bodyOf(text, "function a()");
        assert.match(body, /inA\(\)/);
        assert.ok(!body.includes("inB()"), "it did not run on into the next function");
    }
});

test("recording a cleanup is durable, not fire-and-forget", () => {
    // logAutomationEvent never throws by contract, so "it did not throw" is not
    // proof it wrote. The record is read back, and the function throws if it is
    // not there — the caller has to know.
    // It no longer goes through logAutomationEvent at all. That helper swallows
    // its insert failure by contract, and the read-back that compensated
    // searched for ANY event whose detail CONTAINED this path — so on a retry,
    // with an older provisional event for the same canonical path already
    // there, a FAILED insert returned that old id and its stale deadline as if
    // the write had just landed.
    const body = bodyOf(cleanup, "export async function recordPendingCleanup");
    assert.ok(!/\.catch\(\(\)\s*=>\s*\{/.test(body), "the write is not swallowed");
    // A CALL, not a mention: the doc comment names the helper it stopped using.
    assert.ok(!/await logAutomationEvent\(/.test(body), "no fire-and-forget writer");
    assert.ok(!/await prisma\.automationEvent\.findFirst\(/.test(body), "nothing is searched for after");
    assert.match(body, /queueObjectCleanup\(client,/, "a throwing create returns the id it wrote");
    // ...and `client` DEFAULTS to prisma, so the injection is a test seam
    // and not a way for a caller to write somewhere else.
    assert.match(cleanup, /client: CleanupQueueTx = prisma,/);
});

test("an unrecordable cleanup KEEPS the row as the last pointer", () => {
    // If the queue record cannot be written, deleting the row would orphan the
    // bytes with nothing anywhere referencing them. The STAGING row is then the
    // only way to find them, so it stays and the sweeper resolves it.
    assert.match(intake, /cleanup unrecordable; keeping the row as the pointer/);
    assert.match(intake, /retained: true/);
});

test("a failed row deletion is surfaced, not swallowed", () => {
    // Otherwise the caller retries, hits a sourceRef conflict against a row it
    // was just told does not exist, and has no way to interpret that.
    assert.match(intake, /row delete failed after an ambiguous upload/);
});

test("the cleanup worker refuses to delete a path a LIVE row still points at", () => {
    // Reachable through the recovery sequence: an ambiguous upload records a
    // cleanup, the row goes, the caller retries, and the retry's row can point
    // at the same path — or a seal publishes a canonical path an older pending
    // event names. Deleting then destroys a receipt in active use.
    const fn = bodyOf(cleanup, "export async function retryPendingCleanups");
    assert.match(fn, /receiptIntake\.findFirst\(\{\s*\n?\s*where: \{ storagePath \}/, "it checks for a referencing row");
    assert.match(fn, /still referenced by/, "and resolves rather than retrying forever");
    // THE CLAIM COMES FIRST NOW, and it is what takes the per-path lock.
    //
    // The order inverted deliberately in round 21. Reading 'is this path
    // free' and writing 'it is mine' have to be one atomic step against every
    // other claimant, and acquireObjectClaim takes the advisory lock as its
    // first statement -- so it has to BE the first statement. Everything
    // below it, including the reference check, is then decided under the
    // lock. A `referenced` verdict hands the path straight back.
    const claimAt = fn.indexOf('acquireObjectClaim(tx, storagePath, "deleting"');
    const refAt = fn.indexOf("still referenced by");
    const recheckAt = fn.indexOf("const stillOurs = await deps.inShortTx(");
    const removeAt = fn.indexOf("await deps.remove(storagePath)");
    assert.ok(claimAt > 0, "the sweep takes a claim");
    assert.ok(claimAt < refAt, "under the lock the claim takes, so the read is serialized too");
    assert.ok(refAt < recheckAt, "the reference check still precedes the delete");
    assert.ok(claimAt < recheckAt, "the claim is written, then re-read");
    // ...and a verdict that deletes nothing releases the path rather than
    // holding it for the lease's length.
    assert.match(fn, /await releaseObjectClaim\(tx, storagePath, taken\.token\);/);
    assert.ok(recheckAt < removeAt, "and only then is anything deleted");
});

test("an event is resolved only AFTER a confirmed deletion", () => {
    const fn = bodyOf(cleanup, "export async function retryPendingCleanups");
    // The delete's catch continues to the next event rather than falling
    // through to the resolve.
    assert.match(fn, /\} catch \{[\s\S]*?continue;/, "a failed delete leaves the event pending");
    assert.ok(
        fn.lastIndexOf("removeReceiptObject") < fn.lastIndexOf('status: "resolved" }'),
        "resolve happens after the delete",
    );
});

test("a missing storage client is an ERROR for the cleanup path", () => {
    // A deleter that returns quietly with no client is right for best-effort
    // callers and catastrophic here: it would mark orphans resolved on a
    // misconfigured deployment and lose them permanently.
    assert.match(bucket, /export async function removeReceiptObject/);
    const strict = bodyOf(bucket, "export async function removeReceiptObject");
    // The throw moved into the shared deadline guard when every storage call
    // was put under one — the property is unchanged and now applies to ALL of
    // them, so it is asserted where it lives plus at this caller's own use.
    assert.match(strict, /await withStorageDeadline\("remove"/);
    assert.ok(!/return;/.test(strict), "and this one never returns quietly");
    const guard = bodyOf(bucket, "async function withStorageDeadline");
    assert.match(guard, /throw new Error\("receipt storage is not configured"\)/);
    // ...and cleanup never reaches for a best-effort variant, or for any bucket
    // but the receipts one.
    assert.ok(!/removeSecureDoc/.test(cleanup), "cleanup never uses the quiet variant");
    assert.ok(!/SECURE_BUCKET/.test(cleanup), "and never touches the shared document bucket");
});

// -- A repath that cannot sign must not leave its old object behind ----------

/**
 * Both /start branches that take a NEW lease re-point the row BEFORE signing —
 * deliberately, so a sweep cannot reject the row for the OLD upload while a URL
 * for the new one is already in the client's hands.
 *
 * The consequence nobody had followed through: the moment that CAS lands, the
 * previous path is unreferenced whatever happens next. The cleanup used to sit
 * AFTER the signer, so every `storage-unavailable` return leaked an object that
 * nothing pointed at (the row moved), nothing swept (the stale-STAGING sweep
 * looks at rows), and nothing remembered (no cleanup event had been recorded).
 *
 * The fix is ordering, not a new mechanism: the same guarded
 * `deleteObjectOrRecord` the happy path already used, moved above the signer.
 */
const startBranches = {
    "the recoverable re-arm": start.slice(
        start.indexOf("const retryPath ="),
        start.indexOf("// IDENTITY MUST BE PROVEN"),
    ),
    "the expired-lease resume": start.slice(start.indexOf("const resumePath =")),
};

test("the OLD object is cleaned up before the signer can fail, in BOTH branches", () => {
    for (const [name, branch] of Object.entries(startBranches)) {
        assert.notEqual(branch.length, 0, name);
        const cleanupAt = branch.search(/repathWithCleanup\(/);
        const signAt = branch.indexOf("await signUpload(");
        assert.notEqual(cleanupAt, -1, `${name}: the previous lease's object must still be cleaned up`);
        assert.notEqual(signAt, -1, `${name}: the branch must still sign a URL`);
        assert.ok(
            cleanupAt < signAt,
            `${name}: the cleanup must run BEFORE the signer, or a 503 orphans the old object`,
        );
        // ONE CALL, so the repath and the cleanup entry cannot be separated:
        // they are one transaction (see repathWithCleanup). Writing them as two
        // statements meant one transient database failure moved the pointer and
        // lost the only record of the object it abandoned.
        assert.match(
            branch,
            /repathWithCleanup\(\s*\n?\s*existing,/,
            `${name}: the repath and its cleanup go through the shared transaction`,
        );
        assert.match(
            branch,
            /"start-(rearmed|resumed)-repath",/,
            `${name}: and it names its own reason`,
        );
        // A transaction that could not do BOTH is a 503, never a silent success
        // on a row that did not move.
        assert.match(branch, /=== "unavailable"/, `${name}: an unrecordable cleanup is retryable`);
        assert.match(branch, /=== "conflict"/, `${name}: a lost fence is still a 409`);
    }
    // The guarded-and-scheduled properties now live in ONE place rather than
    // being restated per branch — pin them there.
    const helper = bodyOf(start, "async function repathWithCleanup");
    assert.match(helper, /prisma\.\$transaction\(/, "one transaction");
    assert.match(helper, /queueObjectCleanup\(/, "the cleanup is enqueued with the caller's tx");
    assert.match(helper, /cleanupNotBefore\(existing\)/, "and it is SCHEDULED, not immediate");
    // ...and still only when the path actually moved. Queueing the path the
    // row was just re-pointed AT would mark the live upload target for deletion.
    assert.match(helper, /if \(nextPath !== existing\.storagePath\)/);
});

test("a signer failure still answers 503, and the row keeps the NEW lease", () => {
    // The row is not rolled back: it holds the new path and a live expiry, so
    // the caller's retry lands in reuseLiveLease and is handed a URL over that
    // same path. Rolling back instead would re-open the window this ordering
    // exists to close.
    for (const [name, branch] of Object.entries(startBranches)) {
        assert.match(branch, /reason: "storage-unavailable" \}, \{ status: 503 \}/, name);
    }
});

// ── A live signed upload URL outlives the row that asked for it ─────────────
//
// The failure this section exists for, start to finish:
//
//   1. /start hands a client a signed upload URL, good for two hours.
//   2. The client PUTs its bytes and calls /finalize.
//   3. /finalize seals the bytes at the canonical path, moves the row's pointer
//      there, and deletes the UPLOAD object — correct bookkeeping, and
//      completely undone by step 4.
//   4. The client (a retrying forwarder, a queued background upload, a phone
//      that came back on Wi-Fi) PUTs to the SAME url again, minutes later. The
//      URL still works. The object is back.
//   5. Nothing references it: the row points at the canonical path. Nothing
//      remembers it: the cleanup already ran and resolved. No sweep looks for
//      it: the STAGING sweep reads ROWS, not objects.
//
// The fix is not to delete harder — it is to delete AFTER the capability dies.
// The queue entry is the tombstone that carries the path and the schedule.

import {
    cleanupDue,
    cleanupDueAt,
    deleteObjectOrRecord,
    retryPendingCleanups,
    settleQueuedCleanup,
    CLEANUP_SCAN_FACTOR,
    CLEANUP_SWEEPABLE_STATUSES,
    claimsConflict,
    acquireObjectClaim,
    renewObjectClaim,
    DELETE_CLAIM_LEASE_MS,
    claimObjectPath,
    recordPendingCleanup,
    objectClaimDueAt,
    OBJECT_CLAIM_LEASE_MS,
    type CleanupIo,
    type CleanupSweepDeps,
} from "../src/lib/receipt-intake/storage-cleanup";
import type { Prisma } from "@prisma/client";
import { CLEANUP_GRACE_MS, cleanupNotBefore } from "../src/lib/receipt-intake/worker";
import {
    STORAGE_CALL_MAX_MS,
    isStorageTimeout,
    removeReceiptObject,
    storageBudgetMs,
} from "../src/lib/receipt-intake/bucket";
import { createRouteDeadline, type RouteDeadline } from "../src/lib/quickbooks";
import { sealAndPublish, verifyStoredCopy } from "../src/lib/receipt-intake/stored-object";

/** The verified bytes a publish carries. Only the shape matters here. */
const CHECK = {
    mimeType: "image/png",
    fileSize: 4,
    fileSha256: "b".repeat(64),
    bytes: Buffer.from("abcd"),
};

const T0 = new Date("2026-09-02T12:00:00.000Z");
const UPLOAD = "receipts/intake/row-1.v1.bin";
const CANONICAL = "receipts/row-1/abc.png";

/**
 * A world with real objects, a real queue and a clock we can move. The whole
 * property is about WHEN a delete happens, so a test that cannot advance time
 * or watch the bucket cannot assert it.
 */
/** One row of the claim table the fake stands in for. */
interface ClaimRow { storagePath: string; token: string; kind: string; expiresAt: Date }

function world(now: Date = T0) {
    const objects = new Set<string>();
    const events: { id: string; status: string; detail: string }[] = [];
    /** The claim table: one row per path, exactly as the primary key enforces. */
    const claims = new Map<string, ClaimRow>();
    let locksTaken = 0;
    let rows: { id: string; storagePath: string }[] = [];
    let afterClaim: (() => void) | null = null;
    let txOpen = 0;
    let txOpenMs = 0;
    let maxConcurrentTx = 0;
    let clock = now.getTime();

    const record = async (storagePath: string, _reason: string, notBefore: Date | null) => {
        events.push({
            id: `ev-${events.length + 1}`,
            status: "pending",
            detail: JSON.stringify(
                notBefore ? { storagePath, notBefore: notBefore.toISOString() } : { storagePath },
            ),
        });
    };
    const remove = async (storagePath: string) => {
        // The real removeReceiptObject throws on anything short of a confirmed
        // removal, and the sweep's resolve depends on exactly that.
        if (!objects.delete(storagePath)) throw new Error("NotFound");
    };
    const io: CleanupIo = {
        remove,
        record,
        resolve: async eventId => {
            const event = events.find(e => e.id === eventId);
            if (event) event.status = "resolved";
        },
        now: () => new Date(clock),
    };
    const sweep: CleanupSweepDeps = {
        // BOTH sweepable statuses, exactly as the live wiring queries: a
        // provisional intent the sweep could not see would make the whole
        // account-before-you-write design a note nobody reads.
        findPending: async take =>
            events.filter(e => (CLEANUP_SWEEPABLE_STATUSES as string[]).includes(e.status)).slice(0, take),
        abandon: async eventId => {
            const event = events.find(e => e.id === eventId);
            if (event) event.status = "abandoned";
        },
        // A SHORT transaction, and the fake RECORDS how long it stays open so
        // "no storage call happens inside one" is a measured property rather
        // than a claim — see the connection-hold test.
        inShortTx: async body => {
            const openedAt = Date.now();
            txOpen++;
            maxConcurrentTx = Math.max(maxConcurrentTx, txOpen);
            try {
                return await body({
            // THE CLAIM TABLE, with the primary key's uniqueness modelled: one
            // row per path, upserted. Two live claims cannot coexist here any
            // more than they can in Postgres, which is the invariant the
            // advisory lock exists to make reachable in the first place.
            receiptObjectClaim: {
                findUnique: async ({ where }: { where: { storagePath: string } }) =>
                    claims.get(where.storagePath) ?? null,
                upsert: async (
                    { where, create, update }: {
                        where: { storagePath: string };
                        create: Record<string, unknown>;
                        update: Record<string, unknown>;
                    },
                ) => {
                    const held = claims.get(where.storagePath);
                    const next = held
                        ? { ...held, ...update }
                        : { ...(create as { storagePath: string; token: string; kind: string; expiresAt: Date }) };
                    claims.set(where.storagePath, next as ClaimRow);
                    return next;
                },
                update: async (
                    { where, data }: { where: { storagePath: string }; data: Partial<ClaimRow> },
                ) => {
                    const held = claims.get(where.storagePath);
                    if (!held) throw new Error(`no claim for ${where.storagePath}`);
                    const next = { ...held, ...data };
                    claims.set(where.storagePath, next);
                    return next;
                },
                deleteMany: async ({ where }: { where: { storagePath: string; token: string } }) => {
                    const held = claims.get(where.storagePath);
                    if (held && held.token === where.token) {
                        claims.delete(where.storagePath);
                        return { count: 1 };
                    }
                    return { count: 0 };
                },
            },
            // The per-path advisory lock. A single-threaded fake cannot
            // interleave two transactions anyway; that it is really TAKEN, and
            // taken FIRST, is asserted on the source and proven against real
            // Postgres in receipt-intake-claim-db.test.ts.
            $executeRaw: async () => {
                locksTaken++;
                return 1;
            },
            receiptIntake: {
                findFirst: async ({ where }: { where: { storagePath: string } }) =>
                    rows.find(r => r.storagePath === where.storagePath) ?? null,
            },
            automationEvent: {
                // Every PENDING event naming this path — the sweep folds their
                // schedules together and takes the latest, so an older event
                // can never authorise a delete a newer one is still deferring.
                findMany: async ({ where }: { where: { detail: { contains: string } } }) =>
                    events.filter(e => e.status === "pending" && e.detail.includes(where.detail.contains)),
                findUnique: async ({ where }: { where: { id: string } }) =>
                    events.find(e => e.id === where.id) ?? null,
                update: async (
                    { where, data }: { where: { id: string }; data: { status?: string; detail?: string } },
                ) => {
                    const event = events.find(e => e.id === where.id);
                    if (event) {
                        if (data.status !== undefined) event.status = data.status;
                        // The delete CLAIM is written into `detail`, so the
                        // fake has to carry it or the pre-delete re-read can
                        // never confirm the claim it just took.
                        if (data.detail !== undefined) event.detail = data.detail;
                    }
                    return event;
                },
                create: async ({ data }: { data: Record<string, string> }) => {
                    const created = {
                        id: `ev-${events.length + 1}`,
                        status: data.status,
                        detail: data.detail,
                    };
                    events.push(created);
                    return created;
                },
                updateMany: async () => ({ count: 0 }),
            },
                } as never);
            } finally {
                txOpen--;
                txOpenMs += Date.now() - openedAt;
                if (afterClaim) { const fn = afterClaim; afterClaim = null; fn(); }
            }
        },
        remove,
        now: () => new Date(clock),
    };
    return {
        objects, events, io, sweep, claims,
        /** How many times the per-path advisory lock was taken. */
        locksTaken: () => locksTaken,
        setRows: (next: typeof rows) => { rows = next; },
        /** Runs once, after the sweep's claim tx and before its re-read. */
        onAfterClaim: (fn: () => void) => { afterClaim = fn; },
        advance: (ms: number) => { clock += ms; },
        pending: () => events.filter(e => (CLEANUP_SWEEPABLE_STATUSES as string[]).includes(e.status)),
        /** Total time any transaction was open, across the whole sweep. */
        txOpenMs: () => txOpenMs,
        maxConcurrentTx: () => maxConcurrentTx,
    };
}

/** The row as /finalize reads it: a two-hour signed URL issued a moment ago. */
const leased = { uploadUrlExpiresAt: new Date(T0.getTime() + 2 * 60 * 60_000), createdAt: T0 };

test("BOTH destructive /finalize paths carry the schedule, and the sweeper states it too", () => {
    // The wiring, pinned: a fix that only reached one of the two paths would
    // leave the other issuing exactly the orphan this section is about, and
    // every behavioural test above would still pass.
    const fin = readFileSync(
        path.join(ROOT, "src/app/api/receipts/intake/[id]/finalize/route.ts"),
        "utf8",
    );
    // ONE schedule, computed once from the row, so the reject path and the
    // seal path cannot disagree about the same object.
    assert.match(fin, /const cleanupAfter = cleanupNotBefore\(row\);/);
    assert.match(fin, /uploadUrlExpiresAt: true, createdAt: true,/, "and the row is read for it");
    assert.match(fin, /cleanupNotBefore: cleanupAfter,/, "the reject tombstone carries it");
    assert.match(fin, /settleQueuedCleanup\(rejected\.eventId, row\.storagePath, cleanupAfter\)/);
    // ENQUEUED IN THE COMMIT TRANSACTION, not deleted after it: the queue entry
    // is the only thing that remembers the upload object once the pointer moves.
    assert.match(fin, /queueUploadCleanup: \(tx, uploadPath\) =>\s*\n?\s*queueObjectCleanup\(tx, uploadPath, "sealed", cleanupAfter\)/);
    assert.match(fin, /settleUploadCleanup: \(eventId, uploadPath\) =>/);

    // The sweeper publishes while a lease can still be live, so its dropUpload
    // needs the same treatment; its reject branch is already gated on a dead
    // lease and passes null, which the shared helper computes for itself.
    const cron = readFileSync(
        path.join(ROOT, "src/app/api/cron/receipt-intake-worker/route.ts"),
        "utf8",
    );
    assert.match(cron, /queueObjectCleanup\(tx, uploadPath, "sealed", cleanupNotBefore\(row\)\)/);
    assert.match(cron, /cleanupNotBefore: cleanupNotBefore\(row\),/);
});

test("an upsert-capable upload URL is issued ONLY by the live-lease reuse", () => {
    // The other half of the capability containment: a token that can overwrite
    // whatever is at the path outlives the row it was issued for, so only the
    // one caller that genuinely needs it gets it. Every other issuer signs a
    // path a version bump has just made new.
    assert.match(bucket, /createSignedUploadUrl\(path, \{ upsert: opts\.upsert \?\? false \}\)/);
    const lease = readFileSync(path.join(ROOT, "src/lib/receipt-intake/upload-lease.ts"), "utf8");
    assert.equal((lease.match(/upsert: true/g) ?? []).length, 1, "exactly one asker");
    assert.equal(
        (start.match(/signUpload\([^)]*upsert/g) ?? []).length,
        0,
        "/start never asks for it directly",
    );
});

test("a live upload lease schedules the cleanup; a dead one does not", () => {
    const at = cleanupNotBefore(leased, T0);
    assert.ok(at, "a live lease has a schedule");
    assert.equal(at.getTime(), leased.uploadUrlExpiresAt.getTime() + CLEANUP_GRACE_MS);
    // A dead lease has none: an immediate delete is correct, and this must not
    // quietly defer every cleanup in the system by two hours.
    assert.equal(cleanupNotBefore(leased, new Date(leased.uploadUrlExpiresAt.getTime() + 1)), null);
    // The SAME rule the STAGING sweep applies — an inline row (no signed URL
    // was ever issued) is measured from its own age, not given a URL's grace.
    assert.equal(
        cleanupNotBefore({ uploadUrlExpiresAt: null, createdAt: new Date(T0.getTime() - 60 * 60_000) }, T0),
        null,
    );
});

test("SEAL: the upload object is NOT deleted while its URL still works", async () => {
    const w = world();
    w.objects.add(UPLOAD);
    // The publish committed: the row points at the canonical path now.
    w.objects.add(CANONICAL);
    w.setRows([{ id: "row-1", storagePath: CANONICAL }]);

    const deleted = await deleteObjectOrRecord(UPLOAD, "sealed", cleanupNotBefore(leased, T0), w.io);

    assert.equal(deleted, false, "nothing was deleted");
    assert.ok(w.objects.has(UPLOAD), "the bytes are still there");
    assert.equal(w.pending().length, 1, "and the queue remembers them");
    assert.equal(
        cleanupDueAt(w.pending()[0].detail)?.getTime(),
        leased.uploadUrlExpiresAt.getTime() + CLEANUP_GRACE_MS,
    );
});

test("the scheduled cleanup runs only AFTER the url can no longer land", async () => {
    const w = world();
    w.objects.add(UPLOAD);
    w.objects.add(CANONICAL);
    w.setRows([{ id: "row-1", storagePath: CANONICAL }]);
    await deleteObjectOrRecord(UPLOAD, "sealed", cleanupNotBefore(leased, T0), w.io);

    // BEFORE EXPIRY: the sweep sees the event, refuses to act, and leaves it
    // PENDING rather than resolving it away.
    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 0);
    assert.ok(w.objects.has(UPLOAD), "still not deleted");
    assert.equal(w.pending().length, 1, "still queued, not resolved");

    // THE LATE PUT. The holder's URL is still valid, so this write succeeds —
    // and it lands on an object that was never removed, which is the point.
    w.advance(60 * 60_000);
    w.objects.add(UPLOAD);
    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 0, "still inside the lease");

    // AFTER EXPIRY + GRACE: the URL cannot write any more, so the delete sticks.
    w.advance(2 * 60 * 60_000);
    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 1);
    assert.equal(w.objects.has(UPLOAD), false, "the orphan is gone");
    assert.equal(w.pending().length, 0, "and the queue drained");
    assert.ok(w.objects.has(CANONICAL), "the published receipt was never touched");
});

test("CONTROL: deleting immediately is exactly what loses the object", async () => {
    // The old behaviour, run through the same fakes. The delete succeeds, the
    // queue is left with nothing pending, the still-valid URL puts the bytes
    // back — and no later sweep can find them, because nothing recorded them.
    const w = world();
    w.objects.add(UPLOAD);
    w.objects.add(CANONICAL);
    w.setRows([{ id: "row-1", storagePath: CANONICAL }]);

    assert.equal(await deleteObjectOrRecord(UPLOAD, "sealed", null, w.io), true);
    assert.equal(w.objects.has(UPLOAD), false);
    assert.equal(w.pending().length, 0, "nothing remembers the path");

    w.objects.add(UPLOAD); // the late PUT
    w.advance(24 * 60 * 60_000);
    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 0);
    assert.ok(w.objects.has(UPLOAD), "an unreferenced object nothing will ever collect");
});

test("REJECT: the opportunistic settle is a no-op while the url is live", async () => {
    // /finalize rejects a row minutes after /start, so this is the path most
    // likely to be holding a live capability — unlike the sweeper, which
    // refuses to reject at all until the lease is dead.
    const w = world();
    w.objects.add(UPLOAD);
    await w.io.record(UPLOAD, "unsupported-file-type", cleanupNotBefore(leased, T0));

    const settled = await settleQueuedCleanup("ev-1", UPLOAD, cleanupNotBefore(leased, T0), w.io);
    assert.equal(settled, false);
    assert.ok(w.objects.has(UPLOAD), "nothing deleted");
    assert.equal(w.pending().length, 1, "left for the sweep");

    // With no schedule (the sweeper's case: it already waited the lease out)
    // the settle deletes at once, exactly as it always did.
    assert.equal(await settleQueuedCleanup("ev-1", UPLOAD, null, w.io), true);
    assert.equal(w.objects.has(UPLOAD), false);
    assert.equal(w.pending().length, 0);
});

test("an unreadable or absent notBefore means NOW, never never", () => {
    // A queue entry nothing can ever act on is worse than one that acts early:
    // it sits pending forever and its object is never collected.
    assert.equal(cleanupDueAt(null), null);
    assert.equal(cleanupDueAt('{"storagePath":"p"}'), null);
    assert.equal(cleanupDueAt("not json"), null);
    assert.equal(cleanupDueAt('{"notBefore":"never"}'), null);
    assert.equal(cleanupDue('{"notBefore":"never"}', T0), true);
    assert.equal(cleanupDue('{"storagePath":"p"}', T0), true);
    // A real schedule is respected in both directions, and the boundary is
    // inclusive: at the instant itself the cleanup is due.
    const detail = JSON.stringify({ storagePath: "p", notBefore: T0.toISOString() });
    assert.equal(cleanupDue(detail, new Date(T0.getTime() - 1)), false);
    assert.equal(cleanupDue(detail, T0), true);
});

test("not-yet-due entries do not crowd out the ones that are", async () => {
    // `limit` bounds the storage round trips, not the SELECT. With a scan
    // window of exactly `limit` these four scheduled entries would fill every
    // slot and the due one behind them would never be reached — for as long as
    // a client kept re-arming leases ahead of it.
    const w = world();
    const future = new Date(T0.getTime() + 60 * 60_000);
    for (let i = 0; i < CLEANUP_SCAN_FACTOR - 1; i++) {
        const path = `receipts/intake/later-${i}.bin`;
        w.objects.add(path);
        await w.io.record(path, "sealed", future);
    }
    const dueNow = "receipts/intake/due.bin";
    w.objects.add(dueNow);
    await w.io.record(dueNow, "sealed", null);

    assert.equal(await retryPendingCleanups(1, () => false, w.sweep), 1, "the due one was reached");
    assert.equal(w.objects.has(dueNow), false);
    assert.equal(
        w.pending().length,
        CLEANUP_SCAN_FACTOR - 1,
        "the scheduled ones are untouched, and left pending rather than resolved",
    );
});

// ── "Durable" cleanup must not degrade to best-effort (Codex round-12 item 3) ──
//
// The cleanup record is the ONLY thing that remembers an object once the row
// stops pointing at it. `deleteObjectOrRecord` used to catch the failure to
// write that record and return `false`, and every caller discarded the `false`
// AFTER it had already moved the pointer — so one transient database error
// left bytes in a private bucket that no row referenced, no event remembered
// and no sweep would ever look at. Silently, and permanently.
//
// Two halves to the fix, and one test each:
//   - the swallow is gone, so a caller with no transaction sees the failure;
//   - callers that MOVE a pointer enqueue inside that pointer's transaction,
//     so either both land or neither does.

test("an unrecordable cleanup THROWS instead of reporting a quiet false", async () => {
    const w = world();
    w.objects.add(UPLOAD);
    const io: CleanupIo = { ...w.io, record: async () => { throw new Error("db is down"); } };

    // The scheduled branch: nothing is deleted, and the caller is told.
    await assert.rejects(
        () => deleteObjectOrRecord(UPLOAD, "sealed", cleanupNotBefore(leased, T0), io),
        /db is down/,
    );
    assert.ok(w.objects.has(UPLOAD), "nothing deleted");

    // ...and the delete-failed branch, which is the one that actually loses an
    // object: storage refused AND the queue refused.
    const gone: CleanupIo = {
        ...io,
        remove: async () => { throw new Error("storage refused"); },
    };
    await assert.rejects(() => deleteObjectOrRecord(UPLOAD, "sealed", null, gone), /db is down/);
    assert.ok(w.objects.has(UPLOAD), "still there, and now remembered by the throw");
});

test("CONTROL: a recordable cleanup still returns rather than throwing", async () => {
    // Without this, a function that simply always threw would pass the test
    // above while breaking every ordinary cleanup.
    const w = world();
    w.objects.add(UPLOAD);
    assert.equal(await deleteObjectOrRecord(UPLOAD, "sealed", cleanupNotBefore(leased, T0), w.io), false);
    assert.equal(w.pending().length, 1, "queued, not thrown");
    assert.equal(await deleteObjectOrRecord(UPLOAD, "sealed", null, w.io), true, "and a due one deletes");
    assert.equal(w.objects.has(UPLOAD), false);
});

test("a cleanup-record failure ROLLS BACK the pointer transition it belongs to", async () => {
    // The seal path, end to end: the row's pointer moves to the canonical path
    // and the upload object becomes an orphan in the same instant, so the
    // record of that orphan has to commit with the move.
    const store = { storagePath: UPLOAD, state: "STAGING" };
    let committed = false;
    // Everything the body writes goes here first; only a body that returns
    // without throwing is copied onto `store`. That is what makes this a real
    // rollback rather than a mutation the assertions cannot see.
    let staged = { ...store };
    const attempt = (queueThrows: boolean) => sealAndPublish(UPLOAD, "row-1", 1, CHECK, {
        inShortTx: async (body: (tx: never) => Promise<unknown>) => {
            staged = { ...store };
            const out = await body({
                receiptIntake: { findUnique: async () => ({ storagePath: staged.storagePath }) },
            } as never);
            Object.assign(store, staged);
            committed = true;
            return out;
        },
        seal: async (_u: string, canonical: string) => canonical,
        commit: async (_tx: never, canonical: string) => {
            staged.storagePath = canonical;
            staged.state = "RECEIVED";
            return 1;
        },
        claimCanonicalPath: async () => "intent-1",
        resolveCanonicalIntent: async () => {},
        queueUploadCleanup: async () => {
            if (queueThrows) throw new Error("cleanup insert failed");
            return "ev-1";
        },
        settleUploadCleanup: async () => {},
    } as never, undefined);

    const failed = await attempt(true);
    assert.equal(failed, null, "the publish reports the retryable answer");
    assert.equal(committed, false, "the transaction never committed");
    assert.equal(store.storagePath, UPLOAD, "the row still points at its object");
    assert.equal(store.state, "STAGING", "so nothing is orphaned, and the retry can recover");

    // CONTROL: the identical run with a queue that works publishes normally —
    // otherwise the assertions above would pass for a seal that never commits.
    const ok = await attempt(false);
    assert.equal(ok?.published, true);
    assert.equal(committed, true);
    assert.notEqual(store.storagePath, UPLOAD, "the pointer moved");
});

test("the repath helper puts the CAS and the cleanup in one transaction", () => {
    // /start has no sealAndPublish to hang the enqueue off, so the two writes
    // are wrapped explicitly. Pinned because the failure it prevents — a
    // repath that commits without its cleanup entry — leaves no trace anywhere
    // to test against after the fact.
    const helper = bodyOf(start, "async function repathWithCleanup");
    const txAt = helper.indexOf("prisma.$transaction(");
    const casAt = helper.indexOf("updateMany(");
    const queueAt = helper.indexOf("queueObjectCleanup(");
    assert.ok(txAt >= 0 && txAt < casAt, "the transaction opens first");
    assert.ok(casAt < queueAt, "the CAS runs, then the cleanup is enqueued with the same tx");
    assert.match(helper, /queueObjectCleanup\(\s*\n?\s*tx,/, "with the TRANSACTION's client");
    // A throw out of either one is the caller's 503, never a silent success.
    assert.match(helper, /return "unavailable"/);
});

test("the NEWEST schedule for a path wins, never the event's own", async () => {
    // An event records the expiry its author OBSERVED, and that author can be
    // overtaken: a /start refresh extends the lease, and a second cleanup for
    // the same path is queued with a LATER deadline. Acting on the older event
    // would delete the object while the refreshed URL still works — the exact
    // orphan the schedule exists to prevent, arriving through the queue rather
    // than through the fence.
    const w = world();
    w.objects.add(UPLOAD);
    // The first author saw a lease that has since expired...
    await w.io.record(UPLOAD, "sealed", new Date(T0.getTime() - 60_000));
    // ...and a second, later author saw the refreshed one.
    const refreshedUntil = new Date(T0.getTime() + 60 * 60_000);
    await w.io.record(UPLOAD, "sealed", refreshedUntil);

    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 0, "deferred to the newer one");
    assert.ok(w.objects.has(UPLOAD), "the object the live URL can still write survives");
    assert.equal(w.pending().length, 2, "and BOTH events are left pending, not resolved");

    // Once the newest schedule passes, the object goes and the queue drains.
    w.advance(2 * 60 * 60_000);
    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 1);
    assert.equal(w.objects.has(UPLOAD), false);
    assert.equal(w.pending().length, 0, "the sibling was cleared with it");
});

test("CONTROL: with no newer sibling, the due event deletes at once", async () => {
    // Without this the assertions above would pass for a sweep that had simply
    // stopped deleting anything.
    const w = world();
    w.objects.add(UPLOAD);
    await w.io.record(UPLOAD, "sealed", new Date(T0.getTime() - 60_000));

    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 1);
    assert.equal(w.objects.has(UPLOAD), false);
});

test("a newer schedule on a DIFFERENT path does not defer this one", async () => {
    // The lookup is matched on the JSON-quoted path, so a prefix cannot widen
    // it — otherwise one deferred cleanup would hold up every path it prefixes.
    const w = world();
    const due = "receipts/intake/row-1.v1.bin";
    const other = "receipts/intake/row-1.v1.bin.other";
    w.objects.add(due);
    w.objects.add(other);
    await w.io.record(due, "sealed", new Date(T0.getTime() - 60_000));
    await w.io.record(other, "sealed", new Date(T0.getTime() + 60 * 60_000));

    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 1, "the due path is not held up");
    assert.equal(w.objects.has(due), false);
    assert.ok(w.objects.has(other), "and the deferred one is untouched");
});

// ── The canonical copy is accounted for BEFORE it is written (round-15 #2) ──
//
// `sealAndPublish` writes the canonical object to Supabase and only then runs
// the database CAS that points a row at it. Everything after that write can
// fail — the commit, the winner lookup, the transaction — and the object was
// then in the bucket with nothing referencing it, nothing remembering it and
// no sweep looking for it, because the stale-STAGING sweep reads ROWS. A later
// re-arm moves the row elsewhere and the sealed copy is undiscoverable.

test("a provisional intent is swept like any other cleanup, and resolves with it", async () => {
    const w = world();
    const CANON = "receipts/row-1/v1/abc.png";
    w.objects.add(CANON);
    // What queueCanonicalIntent writes: same queue, same schedule, its own
    // status so the publish lock's reclaim cannot cancel it.
    w.events.push({
        id: "intent-1",
        status: "provisional",
        detail: JSON.stringify({ storagePath: CANON }),
    });

    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 1, "the sweep sees it");
    assert.equal(w.objects.has(CANON), false, "and the unreferenced copy is collected");
    assert.equal(w.pending().length, 0);
});

test("a provisional intent NEVER deletes an object a row is using", async () => {
    // The safety property the whole design rests on: an intent that outlived a
    // publish which actually worked must resolve harmlessly. The sweeper's
    // live-reference recheck runs inside the path lock, so a committed pointer
    // always wins.
    const w = world();
    const CANON = "receipts/row-1/v1/abc.png";
    w.objects.add(CANON);
    w.setRows([{ id: "row-1", storagePath: CANON }]);
    w.events.push({
        id: "intent-1",
        status: "provisional",
        detail: JSON.stringify({ storagePath: CANON }),
    });

    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 0);
    assert.ok(w.objects.has(CANON), "the published receipt is untouched");
    assert.equal(w.pending().length, 0, "and the intent is resolved, not retried forever");
});

test("the publish lock's reclaim must NOT cancel a provisional intent", () => {
    // The ordering trap: the intent is taken out before the lock, and
    // `withReceiptPublishLock` reclaims pending cleanups for the path as its
    // first act. If reclaim covered provisional too, every publish would
    // cancel the intent it had just taken out to survive its own failure.
    const cleanup = readFileSync(path.join(ROOT, "src/lib/receipt-intake/storage-cleanup.ts"), "utf8");
    const reclaim = bodyOf(cleanup, "async function reclaimQueuedCleanups");
    assert.match(reclaim, /status: "pending",/, "pending only");
    assert.ok(!reclaim.includes("CLEANUP_SWEEPABLE_STATUSES"), "provisional is deliberately excluded");
    // The sweep, by contrast, must cover both — or the intent is a note
    // nobody ever reads.
    // Scoped to the QUERY, not to a `bodyOf` slice: `const liveSweepDeps` ends
    // in `};` rather than `}`, so the helper ran past it and the sibling
    // lookup further down satisfied this assertion on its own — the pin passed
    // while the sweep query itself had been mutated away.
    const findPending = cleanup.slice(
        cleanup.indexOf("findPending: take => prisma.automationEvent.findMany("),
        cleanup.indexOf("orderBy: { createdAt: \"asc\" }"),
    );
    assert.ok(findPending.length > 0 && findPending.length < 600, "the slice is the query, not the file");
    assert.match(findPending, /status: \{ in: CLEANUP_SWEEPABLE_STATUSES \}/);
    // The sibling lookup inside the delete needs it too, for its own reason:
    // an intent naming the same object carries a schedule the delete must
    // respect, and must be resolved with it.
    const siblingsAt = cleanup.indexOf("const siblings = await tx.automationEvent.findMany(");
    assert.ok(siblingsAt > 0, "the sibling lookup exists");
    // Searched FROM the sibling lookup: `select: { id: true, detail: true }`
    // also closes findPending above, so a plain indexOf ran backwards and
    // produced an empty slice that matched nothing and failed loudly.
    const siblings = cleanup.slice(
        siblingsAt,
        cleanup.indexOf("select: { id: true, detail: true }", siblingsAt),
    );
    assert.match(siblings, /status: \{ in: CLEANUP_SWEEPABLE_STATUSES \}/);
    assert.deepEqual(CLEANUP_SWEEPABLE_STATUSES, ["pending", "provisional"]);
});

// ── An ambiguous healing upload is accounted for (round-17 item 1) ─────────
//
// `uploadReceiptObject` returns false for a REFUSAL and for an AMBIGUOUS
// outcome alike — a write storage may well have accepted before the response
// was lost. The heal branch answered 503 and recorded nothing, so those bytes
// sat in a private bucket with no row pointing at them (the row still points
// at its OLD path), no event remembering them, and no sweep looking: the
// stale-STAGING sweep reads ROWS, and this row is not STAGING.

test("the heal CLAIMS its path before uploading, and settles the claim with the repoint", () => {
    const intake = readFileSync(path.join(ROOT, "src/app/api/receipts/intake/route.ts"), "utf8");
    const heal = intake.slice(intake.indexOf("const healable = finalizeDisposition(existing)"));
    const body = heal.slice(0, heal.indexOf("// A booked/archived row with no object"));

    const claimAt = body.indexOf("claimObjectPath(");
    const uploadAt = body.indexOf("await storeObject(");
    const repointAt = body.indexOf("await inShortTx(");
    assert.ok(claimAt > 0, "the path is claimed");
    assert.ok(claimAt < uploadAt, "BEFORE the upload — an object we cannot promise to clean up is not written");
    assert.ok(uploadAt < repointAt, "and the upload is outside the transaction that repoints the row");

    // A claim that cannot be recorded uploads NOTHING.
    const claimFail = body.slice(claimAt, repointAt);
    assert.match(claimFail, /reason: "storage-unavailable", retryable: true/);

    // The ambiguous outcome leaves the intent standing rather than resolving it.
    assert.match(body, /AMBIGUOUS: storage may hold the bytes/);
    assert.match(body, /if \(moved\.count > 0\) await resolveCanonicalIntent\(tx, healIntentId\);/);
});

test("an ambiguous heal leaves an intent the sweeper can act on", async () => {
    // End to end through the queue: the intent is recorded with a lease, the
    // sweeper defers while that lease is live, and collects the orphan once it
    // lapses — rechecking live references first.
    const w = world();
    const HEAL = "receipts/intake/heal-1.png";
    // Phase A wrote this and then the upload came back ambiguous.
    w.objects.add(HEAL); // storage DID accept the bytes
    w.events.push({
        id: "intent-heal",
        status: "provisional",
        detail: JSON.stringify({ storagePath: HEAL, notBefore: new Date(T0.getTime() + 60_000).toISOString() }),
    });

    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 0, "deferred while the lease is live");
    assert.ok(w.objects.has(HEAL));

    w.advance(2 * 60_000);
    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 1, "collected once it lapsed");
    assert.equal(w.objects.has(HEAL), false);

    // PRE-FIX CONTROL: with no intent recorded there is nothing for the sweep
    // to find, and the bytes stay in the bucket forever.
    const leaked = world();
    leaked.objects.add(HEAL);
    leaked.advance(24 * 60 * 60_000);
    assert.equal(await retryPendingCleanups(10, () => false, leaked.sweep), 0);
    assert.ok(leaked.objects.has(HEAL), "unrecorded bytes are unreachable, which was the bug");
});

test("a heal that WINS its CAS cancels the intent — the control", async () => {
    // Otherwise every successful heal would leave a live intent that the
    // sweeper later resolves against a referenced row: harmless, but it would
    // mean the cancellation was never actually wired.
    const w = world();
    const HEAL = "receipts/intake/heal-2.png";
    w.objects.add(HEAL);
    w.setRows([{ id: "row-1", storagePath: HEAL }]);
    w.events.push({
        id: "intent-heal-2",
        status: "provisional",
        detail: JSON.stringify({ storagePath: HEAL }),
    });
    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 0);
    assert.ok(w.objects.has(HEAL), "the healed row's bytes are never collected");
    assert.equal(w.pending().length, 0, "and the intent is resolved by the reference check");
});

test("the CLAIM lease covers the seal window, and yields to a longer one", () => {
    // The lease is what replaced the advisory lock: while it is live the
    // sweeper skips the path, so the object cannot be collected between the
    // seal and the pointer commit.
    const now = new Date("2026-09-03T12:00:00.000Z");

    // No caller schedule at all — the sweeper's own publish path, where the
    // upload URL has long since lapsed. Taking the caller's null here would
    // leave the seal window completely unguarded.
    const bare = objectClaimDueAt(null, now);
    assert.equal(bare.getTime(), now.getTime() + OBJECT_CLAIM_LEASE_MS);
    assert.ok(OBJECT_CLAIM_LEASE_MS > STORAGE_CALL_MAX_MS, "longer than a storage call may take");

    // A caller schedule that has ALREADY passed must not shorten the lease.
    const stale = objectClaimDueAt(new Date(now.getTime() - 60_000), now);
    assert.equal(stale.getTime(), now.getTime() + OBJECT_CLAIM_LEASE_MS, "the publish window still holds");

    // A LIVE upload URL outlives this publish, so its schedule wins.
    const liveUrl = new Date(now.getTime() + 2 * 60 * 60_000);
    assert.equal(objectClaimDueAt(liveUrl, now).getTime(), liveUrl.getTime());
});

test("a claimed path is NOT swept while its lease is live — the whole point", async () => {
    // End to end through the queue, which is where the lock's job now lives.
    const w = world();
    const CANON = "receipts/row-1/v1/sealed.png";
    w.objects.add(CANON);
    w.events.push({
        id: "intent-live",
        status: "provisional",
        detail: JSON.stringify({ storagePath: CANON, notBefore: objectClaimDueAt(null, T0).toISOString() }),
    });

    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 0, "the lease holds the path");
    assert.ok(w.objects.has(CANON), "the bytes a publish is about to point at survive");

    // ...and once it lapses without being resolved, the publish is presumed
    // dead and the orphan is collected.
    w.advance(OBJECT_CLAIM_LEASE_MS + 1_000);
    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 1);
    assert.equal(w.objects.has(CANON), false);
});

// ── A cleanup may not delete an object a publish is writing (round-18 #1) ──
//
// The sweep's verdict is reached in one transaction and acted on after it
// commits. When that transaction persisted NOTHING, the two operations could
// interleave fatally:
//
//   1. sweep reads: unreferenced, due  -> decides "delete"      (tx commits)
//   2. publisher claims the path and seals a NEW object into it
//   3. sweep removes -> the object the publisher is about to point at is gone
//
// Neither party is wrong; nothing recorded that the other had started. The fix
// is a durable, mutually exclusive per-path claim.

const claimDetail = (kind: string, until: number, token = "t") => JSON.stringify({
    storagePath: "p",
    claimToken: token,
    claimKind: kind,
    claimUntil: new Date(until).toISOString(),
});

test("CLAIMS ARE EXCLUSIVE: publishing and deleting cannot both hold a path", () => {
    const now = new Date("2026-09-03T12:00:00.000Z");
    const live = (kind: string) => ({ detail: claimDetail(kind, now.getTime() + 60_000) });

    // A publisher is refused while a delete holds the path, and vice versa.
    assert.equal(claimsConflict([live("deleting")], "publishing", now), "deleting");
    assert.equal(claimsConflict([live("publishing")], "deleting", now), "publishing");
    // Two deleters may not share it either.
    assert.equal(claimsConflict([live("deleting")], "deleting", now), "deleting");
    // TWO PUBLISHERS MAY. The canonical path is content-addressed, so they are
    // writing identical bytes and the seal is an upsert; only the pointer needs
    // serializing, and the phase-C CAS does that.
    assert.equal(claimsConflict([live("publishing")], "publishing", now), null);
    // A LAPSED claim holds nothing — that is what makes a dead process
    // recoverable rather than a permanent block.
    const lapsed = { detail: claimDetail("deleting", now.getTime() - 1) };
    assert.equal(claimsConflict([lapsed], "publishing", now), null);
    // And an entry carrying no claim at all blocks nobody.
    assert.equal(claimsConflict([{ detail: JSON.stringify({ storagePath: "p" }) }], "deleting", now), null);
});

test("ORDERING: sweep decides, publisher claims, sweep is REFUSED", async () => {
    // The exact interleaving, driven through the shipped sweep. The publisher
    // lands in the gap between the sweep's claim transaction and its re-read.
    const w = world();
    const CANON = "receipts/row-1/v1/contested.png";
    w.objects.add(CANON);
    w.events.push({ id: "ev-old", status: "pending", detail: JSON.stringify({ storagePath: CANON }) });

    w.onAfterClaim(() => {
        // A publisher takes the path -- in the CLAIM TABLE, the one place a
        // claim lives -- and seals a NEW object into it. In production the
        // advisory lock makes this impossible while the sweep's own claim
        // transaction is open; here it is forced into the gap AFTER that
        // transaction commits, which is exactly the window the pre-delete
        // re-read exists to close.
        w.claims.set(CANON, {
            storagePath: CANON,
            token: "publisher-token",
            kind: "publishing",
            expiresAt: new Date(Date.now() + 60_000),
        });
        w.objects.add(CANON);
    });

    const cleared = await retryPendingCleanups(10, () => false, w.sweep);

    assert.equal(cleared, 0, "the sweep deleted nothing");
    assert.ok(w.objects.has(CANON), "the object the publisher sealed survives");
});

test("CONTROL: with no claim recorded, the same interleaving DELETES it", async () => {
    // The pre-fix world: the sweep's verdict persists nothing, so nothing
    // stands between the decision and the delete.
    const w = world();
    const CANON = "receipts/row-1/v1/contested.png";
    w.objects.add(CANON);
    w.events.push({ id: "ev-old", status: "pending", detail: JSON.stringify({ storagePath: CANON }) });

    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 1);
    assert.equal(w.objects.has(CANON), false, "an unclaimed path IS deleted — that was the bug");
});

test("a publisher REFUSES a path a delete is holding", async () => {
    // The other direction of the same exclusion, decided in one place now:
    // acquireObjectClaim, under the per-path lock, against a table whose
    // primary key is the path.
    const src = readFileSync(path.join(ROOT, "src/lib/receipt-intake/storage-cleanup.ts"), "utf8");
    const claim = bodyOf(src, "export async function claimObjectPath");
    assert.match(claim, /acquireObjectClaim\(tx, canonicalPath, "publishing", until, now\)/);
    assert.match(claim, /throw new ObjectPathBusyError/);
    // One transaction: the read, the reclaim and the claim write cannot be
    // split, or a deleter takes the path between them.
    assert.match(claim, /return run\(async tx => \{/);
    // ...and `run` DEFAULTS to inShortTx, so the seam that makes the write
    // observable cannot become a way to run it outside a transaction.
    assert.match(claim, /=> Promise<T> = inShortTx,/);
});

// ── ONE deadline per invocation, shared by every storage call (round-18 #3) ──
//
// `deadline` used to be optional on every helper in bucket.ts, and the callers
// under /finalize never passed one. So a single publish made three storage
// calls — the size probe, the download and the seal upload — and each one
// computed its own budget from `undefined`, taking a fresh fifteen seconds.
// Forty-five seconds of allowance inside a handler the platform kills at
// thirty: the invocation dies mid-seal, having spent its life on calls whose
// answers it could no longer use. Making the parameter NON-OPTIONAL is the
// fix, because it makes the compiler enumerate every caller rather than
// leaving the omission invisible.

/** A deadline that started `elapsed` ms ago. Real clock, no fake timers. */
const started = (elapsed: number, budgetMs = ROUTE_BUDGET_FOR_TEST) =>
    createRouteDeadline(budgetMs, Date.now() - elapsed);
const ROUTE_BUDGET_FOR_TEST = 20_000;

test("SEQUENTIAL calls draw down ONE budget, and it shrinks", () => {
    // At the top of the request the cap still applies: a single call may never
    // take more than STORAGE_CALL_MAX_MS even when the route has more left.
    assert.equal(storageBudgetMs(started(0)), STORAGE_CALL_MAX_MS);

    // Eight seconds in — say the size probe was slow — the NEXT call gets what
    // is actually left, not another full allowance.
    const afterFirst = storageBudgetMs(started(8_000));
    assert.ok(afterFirst <= 12_000 && afterFirst > 11_000, `saw ${afterFirst}`);
    assert.ok(afterFirst < STORAGE_CALL_MAX_MS, "strictly less than a fresh allowance");

    // Eighteen seconds in, the third call gets two seconds. It still runs —
    // a short call may well finish — but it cannot straddle the ceiling.
    const afterSecond = storageBudgetMs(started(18_000));
    assert.ok(afterSecond <= 2_000 && afterSecond > 1_000, `saw ${afterSecond}`);
    assert.ok(afterSecond < afterFirst, "monotonically shrinking");

    // Past the end there is nothing, and a negative remainder is clamped.
    assert.equal(storageBudgetMs(started(25_000)), 0);
});

test("the LAST call REFUSES to start when there is no runway", async () => {
    // Through the real exported helper, so this is the shipped gate and not a
    // restatement of it. The budget check precedes the client, so this needs no
    // Supabase configuration and makes no network call.
    await assert.rejects(
        () => removeReceiptObject("receipts/intake/row-1/x.png", started(19_900)),
        (error: unknown) => {
            assert.ok(isStorageTimeout(error), `saw ${(error as Error)?.name}`);
            assert.match((error as Error).message, /storage-timeout:remove/);
            return true;
        },
        "starting a call it cannot finish is how a pass spends its last milliseconds",
    );

    // ...and with runway it gets past the gate. It fails later, for a different
    // reason, which is the point: the refusal above was the DEADLINE, not the
    // environment.
    await assert.rejects(
        () => removeReceiptObject("receipts/intake/row-1/x.png", started(0)),
        (error: unknown) => {
            assert.equal(isStorageTimeout(error), false, "not a budget refusal");
            return true;
        },
    );
});

test("PRE-FIX CONTROL: an omitted deadline hands every call a fresh 15s", () => {
    // This is exactly what the callers did before this round: pass nothing.
    assert.equal(storageBudgetMs(undefined), STORAGE_CALL_MAX_MS);
    // Three calls, three full allowances, no draw-down between them.
    const independent = [undefined, undefined, undefined].map(d => storageBudgetMs(d));
    assert.deepEqual(independent, [STORAGE_CALL_MAX_MS, STORAGE_CALL_MAX_MS, STORAGE_CALL_MAX_MS]);
    assert.ok(
        independent.reduce((a, b) => a + b, 0) > 30_000,
        "45s of allowance inside a 30s invocation — the bug, stated arithmetically",
    );
    // And the gate would have let the third one start with the route already
    // over. Compare with the shared-budget case above, which refuses.
    assert.ok(storageBudgetMs(undefined) >= 500, "no runway check is possible without a deadline");
});

test("every storage helper REQUIRES the deadline, so the compiler finds the callers", () => {
    // The structural half of the fix. An optional parameter is silently
    // omittable at every call site; a required one is a compile error, which is
    // how the missing callers were found in the first place.
    const src = readFileSync(path.join(ROOT, "src/lib/receipt-intake/bucket.ts"), "utf8");
    for (const fn of [
        "receiptObjectSize",
        "downloadReceiptObject",
        "uploadReceiptObject",
        "removeReceiptObject",
        "createReceiptUploadUrl",
        "signReceiptDownloadUrl",
    ]) {
        const at = src.indexOf(`export async function ${fn}(`);
        assert.ok(at > 0, `${fn} is exported`);
        const sig = src.slice(at, src.indexOf("): Promise", at));
        assert.match(sig, /deadline: RouteDeadline \| undefined/, `${fn} takes the deadline`);
        assert.ok(!/deadline\?: /.test(sig), `${fn}'s deadline is NOT optional`);
    }

    // And each intake route creates exactly ONE, at the top.
    for (const route of [
        "src/app/api/receipts/intake/route.ts",
        "src/app/api/receipts/intake/start/route.ts",
    ]) {
        const body = readFileSync(path.join(ROOT, route), "utf8");
        const made = body.match(/createRouteDeadline\(/g) ?? [];
        assert.equal(made.length, 1, `${route} creates one deadline, not one per call`);
        assert.match(body, /const ROUTE_BUDGET_MS = 2[0-9]_000;/, `${route} budgets under the platform ceiling`);
    }
});

// ── The claim a publisher takes is WRITTEN, not merely decided ─────────────
//
// B1-c survived the first mutation battery: setting `claimObjectPath`'s claim
// argument to null — so the verdict persisted nothing — broke no test. Every
// exclusion test above drove `claimsConflict` or the sweep directly, and the
// publisher's own write was covered by a source pin, which a null argument
// walks straight past. These drive the shipped function.

/** A tx fake that honours `contains` for real, because path identity is the point. */
function claimWorld(
    seed: { id: string; status: string; detail: string }[] = [],
    heldClaims: ClaimRow[] = [],
) {
    const events = seed.map(e => ({ ...e }));
    const claims = new Map<string, ClaimRow>(heldClaims.map(c => [c.storagePath, { ...c }]));
    let locksTaken = 0;
    const tx = {
        // The per-path advisory lock. Its ORDER is asserted on the source and
        // its EFFECT against real Postgres; here it is only counted, because a
        // single-threaded fake has nothing to serialize.
        $executeRaw: async () => {
            locksTaken += 1;
            return 1;
        },
        receiptObjectClaim: {
            findUnique: async ({ where }: { where: { storagePath: string } }) =>
                claims.get(where.storagePath) ?? null,
            upsert: async (
                { where, create, update }: {
                    where: { storagePath: string };
                    create: ClaimRow;
                    update: Partial<ClaimRow>;
                },
            ) => {
                const held = claims.get(where.storagePath);
                const next = held ? { ...held, ...update } : { ...create };
                claims.set(where.storagePath, next as ClaimRow);
                return next;
            },
            deleteMany: async ({ where }: { where: { storagePath: string; token: string } }) => {
                const held = claims.get(where.storagePath);
                if (held && held.token === where.token) {
                    claims.delete(where.storagePath);
                    return { count: 1 };
                }
                return { count: 0 };
            },
        },
        automationEvent: {
            findMany: async ({ where }: { where: { status: { in: string[] }; detail: { contains: string } } }) =>
                events.filter(e => where.status.in.includes(e.status) && e.detail.includes(where.detail.contains)),
            updateMany: async (
                { where, data }: { where: { detail: { contains: string } }; data: { status: string } },
            ) => {
                let count = 0;
                for (const e of events) {
                    if (!e.detail.includes(where.detail.contains)) continue;
                    e.status = data.status;
                    count += 1;
                }
                return { count };
            },
            create: async ({ data }: { data: { status: string; detail: string } }) => {
                const created = { id: `ev-${events.length + 1}`, status: data.status, detail: data.detail };
                events.push(created);
                return created;
            },
        },
    } as unknown as Prisma.TransactionClient;
    return {
        events,
        claims,
        locksTaken: () => locksTaken,
        run: async <T>(body: (t: Prisma.TransactionClient) => Promise<T>) => body(tx),
    };
}

test("claimObjectPath WRITES the publishing claim, and a deleter is then refused", async () => {
    const w = claimWorld();
    const CANON = "receipts/intake/row-9/v2/abc.png";
    const now = new Date("2026-09-03T12:00:00.000Z");

    const id = await claimObjectPath(CANON, null, now, w.run);

    const written = w.events.find(e => e.id === id);
    assert.ok(written, "the id names a row that exists — not one it went looking for");
    assert.equal(written.status, "provisional", "invisible to reclaim, visible to the sweeper");
    const detail = JSON.parse(written.detail) as Record<string, string>;
    assert.equal(detail.storagePath, CANON);
    assert.equal(detail.claimKind, "publishing");
    assert.ok(detail.claimToken && detail.claimToken.length > 8, "a real token, not a placeholder");
    assert.equal(detail.claimUntil, objectClaimDueAt(null, now).toISOString(), "the lease covers the seal");

    // THE POINT: feed the row that was actually persisted back through the
    // exclusion rule. A sweeper reading the queue now finds the path held.
    assert.equal(claimsConflict(w.events, "deleting", now), "publishing");
    // ...and a second publisher is not blocked, because the path is content
    // addressed and the seal is an upsert.
    assert.equal(claimsConflict(w.events, "publishing", now), null);
});

/** A live claim over `path`, as the claim table holds one. */
const heldClaim = (path: string, kind: string, until: number, token = "t"): ClaimRow => ({
    storagePath: path,
    token,
    kind,
    expiresAt: new Date(until),
});

test("a publisher is REFUSED, and writes nothing, when a delete holds the path", async () => {
    const CANON = "receipts/intake/row-9/v2/abc.png";
    const now = new Date("2026-09-03T12:00:00.000Z");
    // The delete's claim lives in the CLAIM TABLE now -- one row per path,
    // primary-keyed -- rather than inside an event's JSON where nothing could
    // enforce it and two transactions could each read the path as free.
    const w = claimWorld(
        [{ id: "sweep-intent", status: "pending", detail: JSON.stringify({ storagePath: CANON }) }],
        [heldClaim(CANON, "deleting", now.getTime() + 30_000, "sweep-token")],
    );

    await assert.rejects(
        () => claimObjectPath(CANON, null, now, w.run),
        (error: unknown) => (error as Error).name === "ObjectPathBusyError",
    );
    assert.equal(w.claims.get(CANON)?.token, "sweep-token", "the deleter still holds it");
    assert.equal(w.events.length, 1, "and nothing was written");
    assert.equal(w.events[0].status, "pending", "not reclaimed out from under it");
    // AND THE LOCK WAS TAKEN, before any of that was decided.
    assert.ok(w.locksTaken() >= 1, "the per-path lock is taken");
});

test("path identity is EXACT: a longer path that starts with this one is untouched", async () => {
    // `contains` on the bare path matches any path this one prefixes. The
    // detail is `{"storagePath":"<path>",...}`, so the match is made on the
    // JSON-QUOTED path and the closing quote bounds it.
    const CANON = "receipts/intake/row-9/v2/abc.png";
    const SIBLING = `${CANON}.orig.png`;
    const now = new Date("2026-09-03T12:00:00.000Z");
    const w = claimWorld([
        { id: "other", status: "pending", detail: JSON.stringify({ storagePath: SIBLING }) },
    ]);

    await claimObjectPath(CANON, null, now, w.run);

    const other = w.events.find(e => e.id === "other");
    assert.equal(other?.status, "pending", "a DIFFERENT object's cleanup was not cancelled");
    assert.equal(w.events.length, 2, "and exactly one claim was added");
});

test("CONTROL: the sibling's OWN claim does reach it", async () => {
    // Without this, a matcher that matched nothing at all would pass the test
    // above while making every reclaim a no-op.
    const SIBLING = "receipts/intake/row-9/v2/abc.png.orig.png";
    const now = new Date("2026-09-03T12:00:00.000Z");
    const w = claimWorld([
        { id: "other", status: "pending", detail: JSON.stringify({ storagePath: SIBLING }) },
    ]);

    await claimObjectPath(SIBLING, null, now, w.run);

    assert.equal(w.events.find(e => e.id === "other")?.status, "resolved", "its own path DOES match");
});

// ── A cleanup intent is DURABLY recorded, or the caller hears about it ─────
//
// B2-a survived too: making `recordPendingCleanup` swallow its failure and
// return a fabricated id broke nothing, because every throw test drove
// `deleteObjectOrRecord`'s injected `record`. This drives the real one.

test("recordPendingCleanup PROPAGATES a failed insert instead of inventing an id", async () => {
    const exploding = {
        automationEvent: { create: async () => { throw new Error("db is down"); } },
    } as unknown as Prisma.TransactionClient;

    await assert.rejects(
        () => recordPendingCleanup("receipts/intake/row-9/v2/abc.png", "orphan", null, "pending", exploding),
        /db is down/,
        "a swallowed insert returns SOME id — an older event's, with its stale deadline",
    );
});

test("CONTROL: recordPendingCleanup returns the id of the row it actually wrote", async () => {
    const writes: { status: string; detail: string }[] = [];
    const ok = {
        automationEvent: {
            create: async ({ data }: { data: { status: string; detail: string } }) => {
                writes.push(data);
                return { id: "the-row-it-wrote" };
            },
        },
    } as unknown as Prisma.TransactionClient;

    const id = await recordPendingCleanup("receipts/intake/row-9/v2/abc.png", "orphan", null, "pending", ok);

    assert.equal(id, "the-row-it-wrote", "the create's own id, never a search result");
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].detail).storagePath, "receipts/intake/row-9/v2/abc.png");
});

test("a DIFFERENT object's live claim does not block this path either", async () => {
    // The conflict read is bounded the same way the reclaim is. Matched on the
    // bare path, a delete holding `<path>.orig.png` would refuse every publish
    // of `<path>` for the length of its lease — a live object held hostage by
    // an unrelated one whose name happens to start the same way.
    const CANON = "receipts/intake/row-9/v2/abc.png";
    const SIBLING = `${CANON}.orig.png`;
    const now = new Date("2026-09-03T12:00:00.000Z");
    // The claim table is keyed BY PATH, so a claim over a different object is
    // a different row and cannot reach this one. That used to be a matching
    // question -- `contains` on the bare path would have matched any path this
    // one prefixes -- and it is now a structural one.
    const w = claimWorld(
        [{ id: "other-delete", status: "pending", detail: JSON.stringify({ storagePath: SIBLING }) }],
        [heldClaim(SIBLING, "deleting", now.getTime() + 30_000, "sweep-token")],
    );

    const id = await claimObjectPath(CANON, null, now, w.run);
    assert.ok(w.events.find(e => e.id === id), "the publish claimed its own path");
    assert.equal(w.claims.get(CANON)?.kind, "publishing");
    assert.equal(w.claims.get(SIBLING)?.token, "sweep-token", "the sibling's is untouched");

    // CONTROL: the same claim DOES block a publish of the path it names.
    const same = claimWorld(
        [],
        [heldClaim(SIBLING, "deleting", now.getTime() + 30_000, "sweep-token")],
    );
    await assert.rejects(
        () => claimObjectPath(SIBLING, null, now, same.run),
        (error: unknown) => (error as Error).name === "ObjectPathBusyError",
    );
});

// -- THE LIVE CALL CHAIN DRAWS ON ONE SHRINKING BUDGET (round-21 #2) -------
//
// The round-18 fix made the deadline required on bucket.ts's six helpers, and
// the callers one level up then passed `undefined` through their own optional
// parameters -- so `verifyStoredCopy` issued a size probe AND a download with
// no deadline at all, `inspectStoredObject` did the same, and /finalize never
// created one. Required all the way down is what makes the compiler name every
// caller; this drives the chain and watches the budget actually shrink.

/** A storage stub that records the budget each call was handed. */
function budgetSpy(deadline: RouteDeadline, stepMs: number) {
    const seen: number[] = [];
    let elapsed = 0;
    const at = () => {
        // Each call takes `stepMs`, so the NEXT one starts later.
        const shifted = createRouteDeadline(deadline.budgetMs, deadline.startedAt - elapsed);
        elapsed += stepMs;
        return shifted;
    };
    return {
        seen,
        /** What bucket.ts would compute for a call made at this point. */
        observe: (given: RouteDeadline | undefined) => {
            seen.push(storageBudgetMs(given));
        },
        at,
    };
}

test("verifyStoredCopy hands BOTH its storage calls the same shrinking budget", async () => {
    // A budget SMALLER than STORAGE_CALL_MAX_MS, deliberately: with a real
    // deadline every call is capped by what the ROUTE has left, and with
    // none it gets the full fifteen seconds. A 20s route at t=0 would
    // produce 15_000 either way, and the assertion would prove nothing.
    const route = createRouteDeadline(9_000);
    const spy = budgetSpy(route, 2_000);

    // The size probe, then the download: the two calls this function makes.
    await verifyStoredCopy(
        "receipts/intake/row-1.v1.png",
        "a".repeat(64),
        spy.at(),
        async (_path, _lister, deadline) => {
            spy.observe(deadline);
            // A slow probe, so the download that follows it demonstrably has
            // LESS of the route's budget left -- which is the whole property.
            await new Promise(resolve => setTimeout(resolve, 60));
            return { ok: true, size: 10 };
        },
        async (_path, deadline) => {
            spy.observe(deadline);
            return { ok: true, bytes: Buffer.from("abcd") };
        },
    );

    assert.equal(spy.seen.length, 2, "both calls were made");
    for (const budget of spy.seen) {
        assert.ok(budget > 0, `a real budget, not an absent one (${budget})`);
        assert.ok(
            budget <= 9_000,
            `capped by what the ROUTE has left, never a fresh ${STORAGE_CALL_MAX_MS}ms (${budget})`,
        );
    }
    assert.ok(spy.seen[1] < spy.seen[0], "and the second call gets strictly less than the first");
});

test("PRE-FIX CONTROL: with no deadline, every call in the chain gets a fresh 15s", async () => {
    // What the callers were doing: passing nothing, one level at a time.
    const seen: number[] = [];
    await verifyStoredCopy(
        "receipts/intake/row-1.v1.png",
        "a".repeat(64),
        undefined,
        async (_path, _lister, deadline) => {
            seen.push(storageBudgetMs(deadline));
            return { ok: true, size: 10 };
        },
        async (_path, deadline) => {
            seen.push(storageBudgetMs(deadline));
            return { ok: true, bytes: Buffer.from("abcd") };
        },
    );
    assert.deepEqual(
        seen,
        [STORAGE_CALL_MAX_MS, STORAGE_CALL_MAX_MS],
        "two full allowances from one function -- the bug, measured",
    );
});

test("EVERY route and cron creates exactly ONE deadline, and threads it", () => {
    // The structural half. A handler that creates none hands `undefined` to
    // everything below it; one that creates several has no single budget at all.
    for (const [rel, budget] of [
        ["src/app/api/receipts/intake/route.ts", /const ROUTE_BUDGET_MS = 2[0-9]_000;/],
        ["src/app/api/receipts/intake/start/route.ts", /const ROUTE_BUDGET_MS = 2[0-9]_000;/],
        ["src/app/api/receipts/intake/[id]/finalize/route.ts", /const ROUTE_BUDGET_MS = 2[0-9]_000;/],
    ] as const) {
        const body = readFileSync(path.join(ROOT, rel), "utf8");
        const made = (body.match(/createRouteDeadline\(/g) ?? []).length;
        assert.equal(made, 1, `${rel} creates one deadline`);
        assert.match(body, budget, `${rel} budgets under the platform ceiling`);
    }

    // And the storage entry points REQUIRE it, so no caller can quietly omit it.
    const stored = readFileSync(path.join(ROOT, "src/lib/receipt-intake/stored-object.ts"), "utf8");
    for (const fn of ["verifyStoredCopy", "inspectStoredObject", "downloadVerified", "sealAndPublish"]) {
        const at = stored.indexOf(`export async function ${fn}(`);
        assert.ok(at > 0, `${fn} is exported`);
        const sig = stored.slice(at, stored.indexOf("): Promise", at));
        assert.match(sig, /deadline: RouteDeadline \| undefined/, `${fn} takes the deadline`);
        assert.ok(!/deadline\?: /.test(sig), `${fn}'s deadline is NOT optional`);
    }
});
// -- The exclusion matrix, against the claim TABLE (round-21 finding 1) ----
//
// One row per path is the invariant; these are the rules the acquisition
// applies on top of it. Driven through the shipped function rather than
// restated, so a rule that stops being applied fails here.

/** A tx fake carrying just the claim table and the lock. */
function claimTx(seed: ClaimRow[] = []) {
    const claims = new Map<string, ClaimRow>(seed.map(c => [c.storagePath, { ...c }]));
    let locks = 0;
    const tx = {
        $executeRaw: async () => { locks += 1; return 1; },
        receiptObjectClaim: {
            findUnique: async ({ where }: { where: { storagePath: string } }) =>
                claims.get(where.storagePath) ?? null,
            upsert: async (
                { where, create, update }: {
                    where: { storagePath: string };
                    create: ClaimRow;
                    update: Partial<ClaimRow>;
                },
            ) => {
                const held = claims.get(where.storagePath);
                const next = held ? { ...held, ...update } : { ...create };
                claims.set(where.storagePath, next as ClaimRow);
                return next;
            },
            update: async (
                { where, data }: { where: { storagePath: string }; data: Partial<ClaimRow> },
            ) => {
                const held = claims.get(where.storagePath);
                if (!held) throw new Error(`no claim for ${where.storagePath}`);
                const next = { ...held, ...data };
                claims.set(where.storagePath, next);
                return next;
            },
            deleteMany: async () => ({ count: 0 }),
        },
    } as unknown as Prisma.TransactionClient;
    return { tx, claims, locks: () => locks };
}

test("EXCLUSION: publishing and deleting cannot both hold a live claim", async () => {
    const PATH = "receipts/intake/row-1.v1.png";
    const now = new Date("2026-09-03T12:00:00.000Z");
    const live = now.getTime() + 60_000;
    const until = new Date(live);

    for (const [held, want, refused] of [
        ["publishing", "deleting", true],
        ["deleting", "publishing", true],
        // TWO DELETERS MAY NOT SHARE. Both would proceed to remove the same
        // object, and the second would delete bytes the first had already
        // accounted for -- or, worse, an object a publisher put back between
        // them.
        ["deleting", "deleting", true],
        // TWO PUBLISHERS MAY: the path is content-addressed, so they are
        // writing identical bytes and the seal is an upsert.
        ["publishing", "publishing", false],
    ] as const) {
        const w = claimTx([{ storagePath: PATH, token: "held", kind: held, expiresAt: until }]);
        const got = await acquireObjectClaim(w.tx, PATH, want, until, now);
        assert.equal(got.ok, !refused, `${held} vs ${want}`);
        if (refused) assert.equal((got as { heldBy: string }).heldBy, held);
        assert.ok(w.locks() >= 1, "and the lock was taken first, either way");
    }
});

test("A LAPSED claim is taken over, so a dead holder cannot wedge a path", async () => {
    const PATH = "receipts/intake/row-1.v1.png";
    const now = new Date("2026-09-03T12:00:00.000Z");
    const w = claimTx([{
        storagePath: PATH,
        token: "dead-holder",
        kind: "deleting",
        expiresAt: new Date(now.getTime() - 1),
    }]);

    const got = await acquireObjectClaim(w.tx, PATH, "publishing", new Date(now.getTime() + 60_000), now);

    assert.equal(got.ok, true, "an expired claim holds nothing");
    assert.equal(w.claims.get(PATH)?.kind, "publishing");
    assert.notEqual(
        w.claims.get(PATH)?.token,
        "dead-holder",
        "and the token changes, so the old holder's own re-read tells it it lost",
    );
    assert.equal(w.claims.size, 1, "still one row: the path is the primary key");
});
// -- A DELETE MAY NOT OUTLIVE THE CLAIM IT RUNS UNDER (round-22) -----------
//
// Every expiry in the sweep derived from a `now` captured when the pass
// started. A late item could reach the delete ten seconds later -- two short
// transactions on a loaded pool -- and then spend up to STORAGE_CALL_MAX_MS
// inside the removal itself. A claim measured from the opening instant lapses
// in that window; a publisher takes the path, seals the canonical object, and
// the delete still in flight removes the bytes it just published. The row is
// RECEIVED and points at nothing.

test("the claim is RENEWED from CURRENT time immediately before the delete", async () => {
    const w = world();
    const CANON = "receipts/row-1/v1/late.png";
    w.objects.add(CANON);
    w.events.push({ id: "ev-late", status: "pending", detail: JSON.stringify({ storagePath: CANON }) });

    // The pass opens, and then a long time passes before this item is reached --
    // exactly what a batch of earlier items does to the last one in it.
    w.onAfterClaim(() => w.advance(40_000));

    assert.equal(await retryPendingCleanups(10, () => false, w.sweep), 1, "it still deletes");
    assert.equal(w.objects.has(CANON), false);

    // THE PROPERTY: the claim it ran under expires AFTER the renewal, not after
    // the pass's opening instant -- and by more than a storage call can take.
    const held = w.claims.get(CANON);
    assert.ok(held, "the claim row survives the delete for the sweeper to settle");
    const renewedFor = held.expiresAt.getTime() - w.sweep.now().getTime();
    assert.ok(
        renewedFor >= STORAGE_CALL_MAX_MS,
        `the claim outlives a full-length delete (${renewedFor}ms vs ${STORAGE_CALL_MAX_MS}ms)`,
    );
    assert.equal(DELETE_CLAIM_LEASE_MS, STORAGE_CALL_MAX_MS + 15_000, "cap plus margin");
    assert.ok(
        DELETE_CLAIM_LEASE_MS > STORAGE_CALL_MAX_MS,
        "the delete's own bound is STRICTLY shorter than the claim it runs under",
    );
});

test("PRE-FIX CONTROL: a claim measured from the pass's opening instant has lapsed", () => {
    // The arithmetic the old code did, with the finding's own numbers: an item
    // that starts just before the 40s soft stop and then spends up to ten
    // seconds in its two short transactions on a loaded pool reaches the delete
    // fifty seconds after the pass opened. OBJECT_CLAIM_LEASE_MS measured from
    // THAT opening instant has ten seconds left -- and the delete it is about
    // to start may take fifteen.
    const openedAt = new Date("2026-09-03T12:00:00.000Z");
    const reachedAt = new Date(openedAt.getTime() + 50_000);
    const staleExpiry = new Date(openedAt.getTime() + OBJECT_CLAIM_LEASE_MS);
    const leftForTheDelete = staleExpiry.getTime() - reachedAt.getTime();
    assert.ok(
        leftForTheDelete < STORAGE_CALL_MAX_MS,
        `a delete could outlive it (${leftForTheDelete}ms left, ${STORAGE_CALL_MAX_MS}ms needed)`,
    );

    // Renewed from CURRENT time, the same moment has the full lease ahead of it.
    const renewed = new Date(reachedAt.getTime() + DELETE_CLAIM_LEASE_MS);
    assert.ok(renewed.getTime() - reachedAt.getTime() > STORAGE_CALL_MAX_MS);
});

test("a renewal is REFUSED once somebody else holds the path", async () => {
    // The renewal is a claim check as well as an extension: a sweeper whose
    // claim lapsed and was taken over must not extend the new holder's row.
    const PATH = "receipts/intake/row-1.v1.png";
    const now = new Date("2026-09-03T12:00:00.000Z");
    const w = claimTx([{
        storagePath: PATH,
        token: "somebody-else",
        kind: "publishing",
        expiresAt: new Date(now.getTime() + 60_000),
    }]);

    const ours = await renewObjectClaim(
        w.tx, PATH, "deleting", "our-old-token", new Date(now.getTime() + 60_000), now,
    );
    assert.equal(ours, false, "not our token, not our kind");
    assert.equal(w.claims.get(PATH)?.token, "somebody-else", "and we did not touch it");

    // ...nor may an expired claim of our own be renewed: it is gone, and the
    // path may already have been taken and released again.
    const lapsed = claimTx([{
        storagePath: PATH,
        token: "ours",
        kind: "deleting",
        expiresAt: new Date(now.getTime() - 1),
    }]);
    assert.equal(
        await renewObjectClaim(lapsed.tx, PATH, "deleting", "ours", new Date(now.getTime() + 60_000), now),
        false,
        "an expired claim cannot be resurrected in place",
    );

    // CONTROL: a live claim of ours renews, and the expiry really moves.
    const mine = claimTx([{
        storagePath: PATH,
        token: "ours",
        kind: "deleting",
        expiresAt: new Date(now.getTime() + 1_000),
    }]);
    const until = new Date(now.getTime() + DELETE_CLAIM_LEASE_MS);
    assert.equal(await renewObjectClaim(mine.tx, PATH, "deleting", "ours", until, now), true);
    assert.equal(mine.claims.get(PATH)?.expiresAt.getTime(), until.getTime());
    assert.ok(mine.locks() >= 1, "and it took the lock to do it");
});

test("the worker binds the sweep's delete to the INVOCATION's deadline", () => {
    // The default dependency passes none, so every delete took a fresh
    // STORAGE_CALL_MAX_MS however late in the pass it started -- which is what
    // let one outlive its claim in the first place.
    const cleanup = readFileSync(path.join(ROOT, "src/lib/receipt-intake/storage-cleanup.ts"), "utf8");
    assert.match(cleanup, /export function liveSweepDepsFor\(deadline: RouteDeadline \| undefined\)/);
    assert.match(cleanup, /remove: \(storagePath: string\) => removeReceiptObject\(storagePath, deadline\)/);

    const cron = readFileSync(path.join(ROOT, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8");
    assert.match(cron, /liveSweepDepsFor\(invocationDeadline\)/, "and the worker passes its own");
});
