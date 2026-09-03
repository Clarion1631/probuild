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
    const body = bodyOf(cleanup, "export async function recordPendingCleanup");
    assert.ok(!/\.catch\(\(\)\s*=>\s*\{/.test(body), "the write is not swallowed");
    assert.match(body, /findFirst/, "it is read back");
    assert.match(body, /throw new Error/, "and a missing record throws");
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
    // The reference check must come BEFORE the delete.
    assert.ok(
        fn.indexOf("still referenced by") < fn.indexOf("removeReceiptObject"),
        "the check precedes the deletion",
    );
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
    assert.match(strict, /throw new Error\("receipt storage is not configured"\)/);
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
        const cleanupAt = branch.search(/deleteObjectOrRecord\(\s*\n?\s*existing\.storagePath/);
        const signAt = branch.indexOf("await signUpload(");
        assert.notEqual(cleanupAt, -1, `${name}: the previous lease's object must still be cleaned up`);
        assert.notEqual(signAt, -1, `${name}: the branch must still sign a URL`);
        assert.ok(
            cleanupAt < signAt,
            `${name}: the cleanup must run BEFORE the signer, or a 503 orphans the old object`,
        );
        // Guarded, not a bare delete: a delete that fails records a pending
        // cleanup, which is the only thing that will remember those bytes.
        // And SCHEDULED: this branch can be reached with the old path's signed
        // URL still live (a caller that changed its declared extension), and
        // deleting under a live write capability only lets the holder's late
        // PUT put the object back with nothing referencing it.
        assert.match(
            branch,
            /deleteObjectOrRecord\(\s*\n?\s*existing\.storagePath,\s*\n?\s*"start-(rearmed|resumed)-repath",\s*\n?\s*cleanupNotBefore\(existing\),/,
        );
        // ...and still only when the path actually moved. Deleting the path the
        // row was just re-pointed AT would destroy the live upload target.
        assert.match(branch, /if \((retryPath|resumePath) !== existing\.storagePath\) \{/);
    }
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
    type CleanupIo,
    type CleanupSweepDeps,
} from "../src/lib/receipt-intake/storage-cleanup";
import { CLEANUP_GRACE_MS, cleanupNotBefore } from "../src/lib/receipt-intake/worker";

const T0 = new Date("2026-09-02T12:00:00.000Z");
const UPLOAD = "receipts/intake/row-1.v1.bin";
const CANONICAL = "receipts/row-1/abc.png";

/**
 * A world with real objects, a real queue and a clock we can move. The whole
 * property is about WHEN a delete happens, so a test that cannot advance time
 * or watch the bucket cannot assert it.
 */
function world(now: Date = T0) {
    const objects = new Set<string>();
    const events: { id: string; status: string; detail: string }[] = [];
    let rows: { id: string; storagePath: string }[] = [];
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
        findPending: async take => events.filter(e => e.status === "pending").slice(0, take),
        abandon: async eventId => {
            const event = events.find(e => e.id === eventId);
            if (event) event.status = "abandoned";
        },
        // The advisory lock is a database fact; what matters here is that the
        // reference check and the delete happen inside one body, which they do.
        withObjectLock: async (_path, body) => body({
            receiptIntake: {
                findFirst: async ({ where }: { where: { storagePath: string } }) =>
                    rows.find(r => r.storagePath === where.storagePath) ?? null,
            },
            automationEvent: {
                update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
                    const event = events.find(e => e.id === where.id);
                    if (event) event.status = data.status;
                    return event;
                },
            },
        } as never),
        remove,
        now: () => new Date(clock),
    };
    return {
        objects, events, io, sweep,
        setRows: (next: typeof rows) => { rows = next; },
        advance: (ms: number) => { clock += ms; },
        pending: () => events.filter(e => e.status === "pending"),
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
    assert.match(fin, /deleteObjectOrRecord\(uploadPath, "sealed", cleanupAfter\)/);

    // The sweeper publishes while a lease can still be live, so its dropUpload
    // needs the same treatment; its reject branch is already gated on a dead
    // lease and passes null, which the shared helper computes for itself.
    const cron = readFileSync(
        path.join(ROOT, "src/app/api/cron/receipt-intake-worker/route.ts"),
        "utf8",
    );
    assert.match(cron, /deleteObjectOrRecord\(uploadPath, "sealed", cleanupNotBefore\(row\)\)/);
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
