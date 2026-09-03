/**
 * The shared stored-object validator.
 *
 * TWO callers publish a STAGING row — /intake/{id}/finalize and the worker's
 * stale-STAGING sweep. They must agree, or whichever runs first decides whether
 * a 40 MB video becomes a receipt. This is that agreement, in one place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    canonicalStoragePath,
    declaredShaConflict,
    downloadVerified,
    finalizeDisposition,
    inspectStoredObject,
    leaseFence,
    publishFence,
    type ObservedRow,
    RECOVERABLE_PARK_REASONS,
    sealAndPublish,
    verifyStoredCopy,
} from "../src/lib/receipt-intake/stored-object";
import { MAX_STORED_BYTES } from "../src/lib/receipt-intake/intake-core";
import { receiptObjectSize } from "../src/lib/receipt-intake/bucket";
import type { DocBytesResult } from "../src/lib/secure-storage";

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);
const give = (r: DocBytesResult) => async () => r;
/** A metadata size that says "small, and definitely there". */
const sized = (size: number) => async () => ({ ok: true as const, size });
const SMALL = sized(1);
/**
 * inspectStoredObject reads the size from METADATA before it reads a body, and
 * its default lookup talks to Supabase. Every case here supplies both stubs, so
 * a test can never accidentally exercise the real bucket.
 */
const inspect = (
    path: string,
    mime: string,
    download: Parameters<typeof inspectStoredObject>[2],
    size: Parameters<typeof inspectStoredObject>[3] = SMALL,
) => inspectStoredObject(path, mime, download, size);

test("a real image is accepted, and its metadata comes from the BYTES", async () => {
    const check = await inspect("p.jpg", "application/pdf", give({ ok: true, bytes: PNG }));
    assert.ok(check.ok);
    // The declared type said PDF. The bytes say PNG, and the bytes win.
    assert.equal(check.mimeType, "image/png");
    assert.equal(check.fileSize, PNG.length);
    assert.equal(check.fileSha256, createHash("sha256").update(PNG).digest("hex"));
});

test("oversize, empty and unidentifiable objects are REJECTED, not published", async () => {
    // The signed upload URL bypassed every check the server could otherwise
    // make, so these are enforced on the object itself.
    const big = await inspect("p.jpg", "image/jpeg", give({
        ok: true, bytes: Buffer.alloc(MAX_STORED_BYTES + 1, 1),
    }));
    assert.equal(big.ok, false);
    assert.match((big as { reason: string }).reason, /^file-too-large:/);

    const empty = await inspect("p.jpg", "image/jpeg", give({ ok: true, bytes: Buffer.alloc(0) }));
    assert.equal((empty as { reason: string }).reason, "empty-file");

    const exe = await inspect("p.exe", "image/jpeg", give({ ok: true, bytes: Buffer.from("MZ\x90\x00") }));
    assert.equal((exe as { reason: string }).reason, "unsupported-file-type");
});

test("an oversize object is rejected from METADATA, with no body read at all", async () => {
    // The signed upload URL bypasses this server, so the first time anything
    // here sees the object is now. Downloading it to discover it is 400 MB is
    // how one upload takes the whole invocation — and its memory — with it.
    let downloads = 0;
    const check = await inspect(
        "p.bin",
        "image/jpeg",
        async () => { downloads++; throw new Error("the body must never be fetched"); },
        sized(MAX_STORED_BYTES + 1),
    );
    assert.equal(check.ok, false);
    assert.equal((check as { reason: string }).reason, `file-too-large:${MAX_STORED_BYTES + 1}`);
    assert.equal(downloads, 0, "not one byte was read");
});

test("an UNKNOWN metadata size is TRANSIENT, and still reads no body", async () => {
    // "Storage did not say" used to mean "carry on and let the byte-length
    // check catch it" — which is the download this call exists to avoid, taken
    // on exactly the objects we know least about. Both callers retry a
    // transient answer; neither is harmed by waiting, and both are harmed by a
    // 400 MB read.
    let downloads = 0;
    const check = await inspect(
        "p.png",
        "image/png",
        async () => { downloads++; throw new Error("the body must never be fetched"); },
        async () => ({ ok: false as const, kind: "transient" as const, message: "size-unavailable" }),
    );
    assert.equal(check.ok, false);
    assert.equal((check as { kind: string }).kind, "transient");
    assert.equal(downloads, 0, "not one byte was read");
});

test("a size lookup that says MISSING is missing, and reads no body either", async () => {
    // An empty listing is an answer. Downloading to rediscover a 404 is a
    // round trip that can only produce the same verdict.
    let downloads = 0;
    const check = await inspect(
        "p.png",
        "image/png",
        async () => { downloads++; throw new Error("the body must never be fetched"); },
        async () => ({ ok: false as const, kind: "missing" as const }),
    );
    assert.equal((check as { kind: string }).kind, "missing");
    assert.equal(downloads, 0);
});

test("a metadata size AT the ceiling is not rejected before the download", async () => {
    let downloads = 0;
    const check = await inspect(
        "p.png",
        "image/png",
        async () => { downloads++; return { ok: true as const, bytes: PNG }; },
        sized(MAX_STORED_BYTES),
    );
    assert.ok(check.ok);
    assert.equal(downloads, 1);
});

test("exactly at the ceiling is allowed", async () => {
    const atLimit = Buffer.concat([PNG, Buffer.alloc(MAX_STORED_BYTES - PNG.length, 0)]);
    assert.equal(atLimit.length, MAX_STORED_BYTES);
    const check = await inspect("p.png", "image/png", give({ ok: true, bytes: atLimit }));
    assert.ok(check.ok, "the boundary itself is not oversize");
});

test("missing and transient are DIFFERENT answers", async () => {
    // A confirmed 404 is terminal for the sweep; a storage blip must come back
    // next pass rather than park a good receipt as file-missing.
    const missing = await inspect("p.jpg", "image/jpeg", give({ ok: false, kind: "not-found" }));
    assert.deepEqual(missing, { ok: false, kind: "missing" });

    const flaky = await inspect("p.jpg", "image/jpeg", give({
        ok: false, kind: "transient", message: "ECONNRESET",
    }));
    assert.deepEqual(flaky, { ok: false, kind: "transient", message: "ECONNRESET" });
});

// ── Sealing and re-verification (round-8 item 2) ───────────────────────────

test("the canonical path is content-addressed and per-row", () => {
    // The client is never given a URL for this path, and its NAME asserts the
    // content — so a later comparison is against a value that cannot have been
    // rewritten in place.
    const sha = createHash("sha256").update(PNG).digest("hex");
    assert.equal(canonicalStoragePath("row-1", 1, sha, "image/png"), `receipts/row-1/v1/${sha}.png`);
    assert.equal(canonicalStoragePath("row-1", 1, sha, "application/pdf"), `receipts/row-1/v1/${sha}.pdf`);
    // Two rows with identical bytes still get separate objects — deleting one
    // receipt must never remove another's evidence.
    assert.notEqual(
        canonicalStoragePath("row-1", 1, sha, "image/png"),
        canonicalStoragePath("row-2", 1, sha, "image/png"),
    );
});

test("the canonical path carries the UPLOAD LEASE, so a re-seal never reuses a queued-for-deletion path", () => {
    // A path that is a function of the row and the bytes alone is reused by
    // every later attempt on the same row — including one that follows a
    // rejection, and a rejection is what QUEUES A DELETION of that exact path.
    // A re-armed /start bumps the lease, so the next publish targets a path no
    // outstanding cleanup event can be naming.
    const sha = createHash("sha256").update(PNG).digest("hex");
    assert.notEqual(
        canonicalStoragePath("row-1", 1, sha, "image/png"),
        canonicalStoragePath("row-1", 2, sha, "image/png"),
    );
});

test("a download whose bytes do not match the recorded sha is REFUSED", async () => {
    // THE OVERWRITE ATTACK. The upload path is writable by whoever holds the
    // signed URL (upsert, deliberately). If the row still pointed there, the
    // verified content could be swapped afterwards and the row would keep
    // asserting the old sha while storage served something else.
    const realSha = createHash("sha256").update(PNG).digest("hex");
    const swapped = Buffer.from("totally different bytes");

    const good = await downloadVerified("p.png", realSha, give({ ok: true, bytes: PNG }));
    assert.deepEqual(good, { ok: true, bytes: PNG });

    const attacked = await downloadVerified("p.png", realSha, give({ ok: true, bytes: swapped }));
    assert.equal(attacked.ok, false);
    assert.equal((attacked as { kind: string }).kind, "sha-mismatch");
});

test("missing and transient stay distinguishable through verification", async () => {
    assert.deepEqual(
        await downloadVerified("p.png", "x".repeat(64), give({ ok: false, kind: "not-found" })),
        { ok: false, kind: "missing" },
    );
    const flaky = await downloadVerified("p.png", "x".repeat(64), give({
        ok: false, kind: "transient", message: "ECONNRESET",
    }));
    assert.equal((flaky as { kind: string }).kind, "transient");
});

// ── "We already have it" means THIS DOCUMENT (round-33 item 3) ────────────

const replayRoutes = {
    "POST /api/receipts/intake": readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/route.ts"),
        "utf8",
    ),
    "POST /api/receipts/intake/{id}/finalize": readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/[id]/finalize/route.ts"),
        "utf8",
    ),
    // THREE, not two. /start answers a retrying forwarder about a SETTLED row,
    // and the forwarder deletes its only copy on that answer just as it does
    // for the other two — but this one used to decide it from a size probe
    // alone.
    "POST /api/receipts/intake/start": readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/start/route.ts"),
        "utf8",
    ),
};

test("MUTATED OBJECT: a replaced object is content-mismatch, never 'we have it'", async () => {
    // Both replay paths used to confirm PRESENCE and return success. The
    // forwarders delete their only copy on that answer — so an object replaced
    // or corrupted after publication (an upsert URL reused, a restore that put
    // back a different version, a storage-side fault) was laundered into "we
    // have your receipt" and the last good copy went with it.
    const realSha = createHash("sha256").update(PNG).digest("hex");
    const mutated = Buffer.from(PNG);
    mutated[mutated.length - 1] ^= 0xff; // one flipped bit is enough

    const held = await verifyStoredCopy("p.png", realSha, SMALL, give({ ok: true, bytes: mutated }));
    assert.deepEqual(
        { ok: held.ok, kind: (held as { kind?: string }).kind },
        { ok: false, kind: "content-mismatch" },
    );
});

test("the control: the ORIGINAL bytes still verify", async () => {
    const realSha = createHash("sha256").update(PNG).digest("hex");
    const held = await verifyStoredCopy("p.png", realSha, SMALL, give({ ok: true, bytes: PNG }));
    assert.deepEqual(held, { ok: true });
});

test("a mismatch is decided WITHOUT healing, and absence still reads as absence", async () => {
    const realSha = createHash("sha256").update(PNG).digest("hex");
    // The metadata probe runs first, so an orphan never pays for a download —
    // and never reaches the hash comparison at all.
    let downloads = 0;
    const counted = async () => { downloads++; return { ok: true as const, bytes: PNG }; };
    const gone = await verifyStoredCopy("p.png", realSha, async () => ({ ok: false, kind: "missing" }), counted);
    assert.equal((gone as { kind: string }).kind, "missing");
    assert.equal(downloads, 0, "no body was read for an object that is not there");

    const flaky = await verifyStoredCopy(
        "p.png", realSha,
        async () => ({ ok: false, kind: "transient", message: "ECONNRESET" }),
        counted,
    );
    assert.equal((flaky as { kind: string }).kind, "transient", "a fault is never a verdict");
    assert.equal(downloads, 0);
});

test("a race — present, then gone before the read — is transient-or-missing, never success", async () => {
    const realSha = createHash("sha256").update(PNG).digest("hex");
    const raced = await verifyStoredCopy("p.png", realSha, SMALL, give({ ok: false, kind: "not-found" }));
    assert.equal(raced.ok, false);
    assert.equal((raced as { kind: string }).kind, "missing");
});

test("ALL THREE replay paths ask this one rule, and answer a mismatch with 409", () => {
    // Two copies of "do we hold it" is how one path came to be stricter than
    // the other. The routes map the verdict to their own response shapes, but
    // the verdict itself is decided here.
    for (const [route, source] of Object.entries(replayRoutes)) {
        assert.match(source, /verifyStoredCopy\(/, `${route} uses the shared rule`);
        assert.match(source, /error: "content-mismatch"/, `${route} has a mismatch answer`);
        assert.match(source, /retryable: false/, `${route}: resending the same bytes changes nothing`);
        // The mismatch branch must be decided BEFORE any success is returned.
        assert.ok(
            source.indexOf('error: "content-mismatch"') < source.indexOf("alreadyReceived: true")
            || source.indexOf('error: "content-mismatch"') < source.indexOf("alreadyFinalized: true"),
            `${route}: the mismatch is answered before the success`,
        );
        // And never healed: a re-upload is exactly how bytes get replaced.
        const mismatch = source.slice(source.indexOf('error: "content-mismatch"'));
        assert.ok(
            !/storeObject|uploadReceiptObject/.test(mismatch.slice(0, 600)),
            `${route}: a mismatch must not overwrite the stored object`,
        );
    }
});

test("a legacy row with no recorded sha is passed through, not refused", async () => {
    // Rows written before sealing existed have nothing to compare against.
    // Refusing them would park real receipts for a reason that is our fault.
    const legacy = await downloadVerified("p.png", "", give({ ok: true, bytes: PNG }));
    assert.deepEqual(legacy, { ok: true, bytes: PNG });
});

test("the validator hands back the exact bytes it verified", async () => {
    // The sealer copies THESE bytes rather than re-downloading, so the sealed
    // object is provably the content that passed validation.
    const check = await inspect("p.png", "image/png", give({ ok: true, bytes: PNG }));
    assert.ok(check.ok);
    assert.ok(check.bytes.equals(PNG));
    assert.equal(createHash("sha256").update(check.bytes).digest("hex"), check.fileSha256);
});

// ── Seal order: copy, COMMIT, then delete (round-9 items 1 and 3) ──────────

const CHECK = {
    mimeType: "image/png",
    fileSize: PNG.length,
    fileSha256: createHash("sha256").update(PNG).digest("hex"),
    bytes: PNG,
};

/**
 * A pass-through object lock, for the tests whose subject is the fenced CAS
 * rather than the mutual exclusion. The real one is exercised above.
 */
const noLock = (_p: string, body: (tx: never) => Promise<unknown>) => body(null as never);

/** The path sealAndPublish("...", "row-1", 1, CHECK, ...) will compute. */
const CANONICAL_ROW1 = `receipts/row-1/v1/${CHECK.fileSha256}.png`;

/**
 * `sealOk`/`committed` drive the outcome; the call log is always recorded.
 * `currentPath` is only ever consulted when `committed` is 0 (a lost CAS):
 * defaulting it to the row's OWN canonical path is the safe default — "the
 * winner is using this exact object" — so a test that does not care about
 * the orphan-cleanup branch never accidentally exercises it.
 */
function publishHarness(
    opts: {
        sealOk?: boolean;
        committed?: number;
        currentPath?: string | null;
        currentPathThrows?: boolean;
        lockThrows?: boolean;
    } = {},
) {
    const calls: string[] = [];
    const deps = {
        // `lock`/`unlock` bracket the critical section in the call log, so
        // every ordering assertion below also states which steps are INSIDE
        // it. The seal, the commit, the winner lookup and the orphan drop must
        // be; the upload drop must not.
        withObjectLock: async (_p: string, body: (tx: never) => Promise<unknown>) => {
            calls.push("lock");
            if (opts.lockThrows) throw new Error("could not take the lock");
            try {
                return await body(null as never);
            } finally {
                calls.push("unlock");
            }
        },
        seal: async (_u: string, canonical: string) => {
            calls.push("seal");
            return opts.sealOk === false ? null : canonical;
        },
        commit: async () => { calls.push("commit"); return opts.committed ?? 1; },
        queueUploadCleanup: async () => { calls.push("queue-cleanup"); return "ev-1"; },
        settleUploadCleanup: async () => { calls.push("drop"); },
        currentStoragePath: async () => {
            calls.push("current-path");
            if (opts.currentPathThrows) throw new Error("db is down");
            return opts.currentPath === undefined ? CANONICAL_ROW1 : opts.currentPath;
        },
        dropOrphanedCanonical: async () => { calls.push("drop-orphan"); },
    } as never;
    return { calls, deps };
}

test("the upload object is deleted only AFTER the row pointer is committed", async () => {
    // Deleting first is unrecoverable: if the UPDATE then fails, the row still
    // points at a path whose object we just removed, and the receipt is gone
    // with nothing left to retry from.
    const h = publishHarness();
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, h.deps);
    // And the seal and the commit are INSIDE one critical section: the gap
    // between them is exactly where the cleanup sweep used to fit.
    //
    // THE QUEUE ENTRY IS INSIDE IT TOO, between the commit and the unlock. It
    // is the only thing that remembers the upload object once the pointer has
    // moved, so it commits with that pointer or not at all; the actual delete
    // stays outside, after the unlock, where a failure costs nothing because
    // the sweep will pick the entry up.
    assert.deepEqual(h.calls, ["lock", "seal", "commit", "queue-cleanup", "unlock", "drop"]);
    assert.equal(outcome?.published, true);
    assert.equal(outcome?.canonicalPath, `receipts/row-1/v1/${CHECK.fileSha256}.png`);
});

test("a FAILED commit leaves the upload object alone, so the retry can recover", async () => {
    // The winner is proven (by the default harness) to be pointing at this
    // EXACT canonical path — a double-publish racing on identical content —
    // so nothing is deleted, upload OR canonical.
    const h = publishHarness({ committed: 0 });
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, h.deps);
    assert.deepEqual(h.calls, ["lock", "seal", "commit", "current-path", "unlock"], "nothing was deleted");
    assert.equal(outcome?.published, false);
});

// ── A lost CAS orphans the sealed copy unless it's proven to be the winner's own (Codex round-17 item 4) ──

test("a lost CAS whose winner points elsewhere cleans up the orphaned canonical copy", async () => {
    // The winner published a DIFFERENT object (a re-armed upload landed new
    // bytes in the gap), so the copy THIS call sealed is not the row's
    // storagePath any more, and the STAGING sweep will never look at it
    // again — it must be cleaned up here or it sits in the bucket forever.
    const h = publishHarness({ committed: 0, currentPath: "receipts/row-1/some-other-sha.png" });
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, h.deps);
    // The winner lookup AND the drop it decides are inside the lock: asking
    // outside it and deleting afterwards is the same two-step race one level
    // down — the winner can commit this path in the gap.
    assert.deepEqual(h.calls, ["lock", "seal", "commit", "current-path", "drop-orphan", "unlock"]);
    assert.equal(outcome?.published, false);
    assert.equal(outcome?.canonicalPath, CANONICAL_ROW1);
});

test("a lost CAS never deletes the object the winner is actually using", async () => {
    // The winner's storagePath IS this exact canonical path: a double
    // /finalize (or /finalize racing the sweep) on the SAME content. That
    // object is the winner's now.
    const h = publishHarness({ committed: 0, currentPath: CANONICAL_ROW1 });
    await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, h.deps);
    assert.deepEqual(h.calls, ["lock", "seal", "commit", "current-path", "unlock"], "no drop-orphan call");
});

test("a failed currentStoragePath lookup never deletes on uncertainty", async () => {
    const h = publishHarness({ committed: 0, currentPathThrows: true });
    await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, h.deps);
    assert.deepEqual(
        h.calls,
        ["lock", "seal", "commit", "current-path", "unlock"],
        "the failure default is 'do not delete'",
    );
});

test("a failed SEAL never touches the row or the upload object", async () => {
    const h = publishHarness({ sealOk: false });
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, h.deps);
    assert.equal(outcome, null);
    assert.deepEqual(h.calls, ["lock", "seal", "unlock"]);
});

test("a lock that cannot be taken is a RETRYABLE null, never a verdict", async () => {
    // Nothing was sealed and nothing was committed, so the honest answer is
    // the same "come back" a failed seal gives — not a published row, and not
    // a park.
    const h = publishHarness({ lockThrows: true });
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, h.deps);
    assert.equal(outcome, null);
    assert.deepEqual(h.calls, ["lock"], "the seal never ran");
});

test("a retry that finds the canonical object already there still commits", async () => {
    // The crash-between-copy-and-commit case: the copy is an upsert to a
    // content-addressed path, so re-sealing the same bytes is a no-op and the
    // retry simply commits.
    const h = publishHarness();
    const first = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, h.deps);
    const second = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, h.deps);
    assert.equal(first?.canonicalPath, second?.canonicalPath, "same content, same path");
    assert.equal(second?.published, true);
});

// ── Cleanup vs publication: the seal/commit gap (round-35 P0) ───────────────

/**
 * A stand-in for `pg_advisory_xact_lock`: one holder per path, everybody else
 * queues. Deliberately not a mock of the transaction — the ONLY property under
 * test is mutual exclusion between two concurrent holders of the same path.
 */
function pathLocks() {
    const held = new Map<string, Promise<void>>();
    return async function withLock<T>(path: string, body: () => Promise<T>): Promise<T> {
        while (held.has(path)) await held.get(path);
        let release!: () => void;
        held.set(path, new Promise<void>(resolve => { release = resolve; }));
        try {
            return await body();
        } finally {
            held.delete(path);
            release();
        }
    };
}

/**
 * The whole failure, run: a publish that has sealed its bytes but not yet
 * committed its row pointer, and a cleanup sweep that starts in that window.
 *
 * `lockPaths: false` is the CONTROL, and it is the point of the pair — a
 * concurrency test whose "fixed" case passes proves nothing unless the
 * unlocked case actually reproduces the loss.
 */
async function raceSweepAgainstPublish(lockPaths: boolean) {
    const withLock = pathLocks();
    const UPLOAD = "receipts/intake/a.png";
    const objects = new Set<string>([UPLOAD]);
    let rowStoragePath = UPLOAD;
    let sealDone!: () => void;
    const sealed = new Promise<void>(resolve => { sealDone = resolve; });

    const publishing = sealAndPublish(UPLOAD, "row-1", 1, CHECK, {
        withObjectLock: (path: string, body: (tx: never) => Promise<unknown>) =>
            lockPaths ? withLock(path, () => body(null as never)) : body(null as never),
        seal: async (_u: string, canonical: string) => {
            objects.add(canonical);
            sealDone();
            return canonical;
        },
        commit: async (_tx: never, canonical: string) => {
            // THE GAP. Wide here so the sweep is guaranteed to arrive inside
            // it; in production it is a Supabase round trip.
            await new Promise(resolve => setTimeout(resolve, 20));
            rowStoragePath = canonical;
            return 1;
        },
        queueUploadCleanup: async () => "ev-1",
        settleUploadCleanup: async (_id: string, uploadPath: string) => { objects.delete(uploadPath); },
        currentStoragePath: async () => rowStoragePath,
        dropOrphanedCanonical: async () => {},
    } as never);

    // The sweep: exactly what retryPendingCleanups does for a pending event
    // naming this path — look for a live row pointing at it, then delete.
    await sealed;
    const sweep = async () => {
        if (rowStoragePath === CANONICAL_ROW1) return "referenced";
        objects.delete(CANONICAL_ROW1);
        return "deleted";
    };
    const swept = lockPaths ? await withLock(CANONICAL_ROW1, sweep) : await sweep();

    const outcome = await publishing;
    return { outcome, swept, objects, rowStoragePath };
}

test("a cleanup that starts between the seal and the commit WAITS, and the published bytes survive", async () => {
    const race = await raceSweepAgainstPublish(true);
    assert.equal(race.outcome?.published, true);
    assert.equal(race.swept, "referenced", "the sweep blocked on the lock, then saw the reference");
    assert.equal(race.rowStoragePath, CANONICAL_ROW1);
    assert.ok(race.objects.has(CANONICAL_ROW1), "the row the sweep let through still has its bytes");
});

test("CONTROL: without the lock the same interleaving publishes a row pointing at nothing", async () => {
    // If this ever stops failing the way it does, the test above has stopped
    // proving anything.
    const race = await raceSweepAgainstPublish(false);
    assert.equal(race.outcome?.published, true, "the intake reports success either way");
    assert.equal(race.swept, "deleted", "the sweep saw an unreferenced path, because the commit had not landed");
    assert.equal(race.rowStoragePath, CANONICAL_ROW1);
    assert.ok(!race.objects.has(CANONICAL_ROW1), "...and the successful intake now points at missing bytes");
});

test("text/plain is no longer accepted at all", async () => {
    // QuickBooks cannot attach a .txt, so accepting one meant reading it and
    // then stranding it unbookable — worse than refusing at the door.
    const txt = Buffer.from("VENDOR: Lowes\nTOTAL: 10.00");
    const check = await inspect("p.txt", "text/plain", give({ ok: true, bytes: txt }));
    assert.equal(check.ok, false);
    assert.equal((check as { reason: string }).reason, "unsupported-file-type");
});

// ── A sha-mismatch is recoverable while the URL can still land (item 5) ────

test("the sweeper's two parks are the ones /finalize recovers from", () => {
    // A partial upload sitting at the path while the signed URL is still valid
    // is a retry in progress, not an error state. Parking it would turn the
    // client's own next request into a review item — and the correct bytes
    // arriving a minute later would find the row already out of STAGING.
    // node:fs and node:path are imported at the top of this file now.
    const root = path.resolve(__dirname, "..");

    const sweeper = readFileSync(
        path.join(root, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8",
    );
    // Both the missing-object and the sha-mismatch branches wait for the
    // UPLOAD LEASE to expire — the promise /start actually made, not the row's
    // age, which is older than the lease on any re-issued URL.
    const shaBranch = sweeper.slice(sweeper.indexOf('row.expectedSha256 !== check.fileSha256'));
    assert.match(
        shaBranch.slice(0, shaBranch.indexOf("parked++")),
        /if \(leaseLive\) \{ leaseActive\+\+; continue; \}/,
        "a sha mismatch waits for the upload lease to expire",
    );
    assert.match(sweeper, /const leaseLive = uploadLeaseActive\(row\);/);

    const finalize = readFileSync(
        path.join(root, "src/app/api/receipts/intake/[id]/finalize/route.ts"), "utf8",
    );
    // Both sweeper parks are the ones /finalize may recover from, and it asks
    // the shared rule rather than carrying its own copy of the list.
    assert.match(finalize, /finalizeDisposition\(row\)/);
    assert.deepEqual(RECOVERABLE_PARK_REASONS, ["file-missing", "sha-mismatch"]);
});

// ── Which parks a re-upload may clear, and the fence it publishes under ─────

test("only the two SWEEPER parks are recoverable; a human's park is not", () => {
    assert.equal(finalizeDisposition({ state: "STAGING", stateReason: null }), "publish");
    for (const reason of RECOVERABLE_PARK_REASONS) {
        assert.equal(finalizeDisposition({ state: "NEEDS_REVIEW", stateReason: reason }), "publish", reason);
    }
    // Everything else parked for review is somebody's decision. Republishing it
    // drags the row back to RECEIVED and re-reads it, discarding that decision.
    for (const reason of ["vendor-mismatch", "weak-dup:row-9", "qbo-fault:6210", "amount-mismatch", null]) {
        assert.equal(
            finalizeDisposition({ state: "NEEDS_REVIEW", stateReason: reason }),
            "not-recoverable",
            String(reason),
        );
    }
    // And a row that already moved on is simply settled — not an error.
    for (const state of ["RECEIVED", "READ", "BOOKING", "BOOKED", "ARCHIVED", "DUPLICATE"]) {
        assert.equal(finalizeDisposition({ state, stateReason: null }), "settled", state);
    }
});

/** An observed row, with a lease generation the fences can pin. */
const NONCE = "nonce-a";
const EXPIRY = new Date("2026-09-03T12:00:00.000Z");
const observedRow = (over: Partial<ObservedRow> = {}): ObservedRow => ({
    state: "STAGING",
    stateReason: null,
    uploadLeaseVersion: 1,
    uploadLeaseNonce: NONCE,
    uploadUrlExpiresAt: EXPIRY,
    ...over,
});

test("the publish fence pins the exact state, the exact reason and an unclaimed row", () => {
    assert.deepEqual(publishFence(observedRow({ state: "NEEDS_REVIEW", stateReason: "file-missing" })), {
        state: "NEEDS_REVIEW",
        stateReason: "file-missing",
        claimToken: null, uploadLeaseVersion: 1,
    });
    assert.deepEqual(publishFence(observedRow()), {
        state: "STAGING",
        stateReason: null,
        claimToken: null, uploadLeaseVersion: 1,
    });
});

test("the LEASE fence adds the generation publishFence cannot see", () => {
    // The gap this closes: reuseLiveLease reissues a working signed URL over
    // the SAME path at the SAME version and moves nothing else, so a finalizer
    // that read the row before the refresh still satisfies publishFence.
    assert.deepEqual(leaseFence(observedRow()), {
        state: "STAGING",
        stateReason: null,
        claimToken: null,
        uploadLeaseVersion: 1,
        uploadLeaseNonce: NONCE,
        uploadUrlExpiresAt: EXPIRY,
    });
    // CONTROL: publishFence carries neither, which is exactly why a refresh
    // was invisible to it — the two fences must differ on precisely these two
    // keys and nothing else.
    const weak = publishFence(observedRow());
    const strong = leaseFence(observedRow());
    assert.deepEqual(
        Object.keys(strong).filter(k => !(k in weak)).sort(),
        ["uploadLeaseNonce", "uploadUrlExpiresAt"],
    );
});

/** Enough of Prisma's updateMany semantics to run a CAS against one row. */
function rowStore(row: Record<string, unknown>) {
    const store = { ...row };
    return {
        get: () => store,
        set: (patch: Record<string, unknown>) => Object.assign(store, patch),
        updateMany: (where: Record<string, unknown>, data: Record<string, unknown>) => {
            const matches = Object.entries(where).every(([k, v]) => store[k] === v);
            if (!matches) return 0;
            Object.assign(store, data);
            return 1;
        },
    };
}

test("RACE: a reason that changes during sealing loses the publish, and writes nothing", async () => {
    // The window is real: inspecting the object and sealing it takes seconds,
    // and the worker can re-park the row in that time. Fenced only on the state
    // SET (`state: { in: ["STAGING", "NEEDS_REVIEW"] }`) the stale finalizer
    // would reset a reason it never looked at back to RECEIVED — discarding the
    // newer decision and republishing a row somebody else now owns.
    const store = rowStore({
        id: "row-1", state: "NEEDS_REVIEW", stateReason: "file-missing", claimToken: null, uploadLeaseVersion: 1, uploadLeaseNonce: NONCE, uploadUrlExpiresAt: EXPIRY,
    });
    const observed = observedRow({
        state: store.get().state as string,
        stateReason: store.get().stateReason as string,
        uploadLeaseVersion: store.get().uploadLeaseVersion as number,
    });
    assert.equal(finalizeDisposition(observed), "publish", "it was recoverable when we read it");
    const fence = leaseFence(observed);

    let dropped = false;
    let droppedOrphan = false;
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, {
        withObjectLock: noLock,
        seal: async (_u: string, canonical: string) => {
            // THE RACE, in the exact window it happens: the worker re-parks the
            // row while we are copying the bytes.
            store.set({ stateReason: "vendor-mismatch" });
            return canonical;
        },
        commit: async (_tx: never, canonicalPath: string) =>
            store.updateMany(
                { id: "row-1", ...fence },
                { state: "RECEIVED", stateReason: null, storagePath: canonicalPath },
            ),
        queueUploadCleanup: async () => "ev-1",
        settleUploadCleanup: async () => { dropped = true; },
        currentStoragePath: async () => (store.get().storagePath as string | undefined) ?? null,
        dropOrphanedCanonical: async () => { droppedOrphan = true; },
    } as never);

    assert.equal(outcome?.published, false, "zero rows updated");
    assert.equal(store.get().state, "NEEDS_REVIEW", "the row is untouched");
    assert.equal(store.get().stateReason, "vendor-mismatch", "the newer decision survives");
    assert.equal(dropped, false, "and the upload object is kept for the retry");
    // Nobody's row points at the copy this call sealed — the row never
    // advanced past NEEDS_REVIEW — so it IS an orphan, and cleaning it up
    // here is correct, unlike the upload object.
    assert.equal(droppedOrphan, true, "but the newly-sealed canonical copy is nobody's, and is cleaned up");
});

test("RACE: a worker claim taken during sealing also loses the publish", async () => {
    const store = rowStore({
        id: "row-1", state: "STAGING", stateReason: null, claimToken: null, uploadLeaseVersion: 1, uploadLeaseNonce: NONCE, uploadUrlExpiresAt: EXPIRY,
    });
    const fence = leaseFence(observedRow());
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, {
        withObjectLock: noLock,
        seal: async (_u: string, canonical: string) => {
            store.set({ claimToken: "sweeper-1" });
            return canonical;
        },
        commit: async () => store.updateMany({ id: "row-1", ...fence }, { state: "RECEIVED" }),
        queueUploadCleanup: async () => "ev-1",
        settleUploadCleanup: async () => {},
        currentStoragePath: async () => (store.get().storagePath as string | undefined) ?? null,
        dropOrphanedCanonical: async () => {},
    } as never);
    assert.equal(outcome?.published, false);
    assert.equal(store.get().state, "STAGING", "the sweeper's row is left alone");
});

test("an unchanged row still publishes — the control", async () => {
    const store = rowStore({
        id: "row-1", state: "NEEDS_REVIEW", stateReason: "sha-mismatch", claimToken: null, uploadLeaseVersion: 1, uploadLeaseNonce: NONCE, uploadUrlExpiresAt: EXPIRY,
    });
    const fence = leaseFence(observedRow({ state: "NEEDS_REVIEW", stateReason: "sha-mismatch" }));
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", 1, CHECK, {
        withObjectLock: noLock,
        seal: async (_u: string, canonical: string) => canonical,
        commit: async () => store.updateMany({ id: "row-1", ...fence }, { state: "RECEIVED", stateReason: null, uploadLeaseVersion: 1 }),
        queueUploadCleanup: async () => "ev-1",
        settleUploadCleanup: async () => {},
    } as never);
    assert.equal(outcome?.published, true);
    assert.equal(store.get().state, "RECEIVED");
});

test("both publishers use the shared fence, and finalize refuses the other parks", () => {
    const finalize = readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/[id]/finalize/route.ts"),
        "utf8",
    );
    const intake = readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/route.ts"),
        "utf8",
    );
    // leaseFence, not publishFence: BOTH publishers pin the lease generation
    // too, so a /start that reissued the client's URL over the same path and
    // version invalidates an in-flight finalizer instead of being invisible.
    assert.match(finalize, /where: \{ id, \.\.\.leaseFence\(row\), \.\.\.merged\.guard \}/);
    assert.match(intake, /where: \{ id: existing\.id, \.\.\.leaseFence\(existing\) \}/);
    for (const [name, src] of [["finalize", finalize], ["intake", intake]] as const) {
        assert.ok(!/\bpublishFence\(/.test(src), `${name}: the weaker fence is gone entirely`);
    }
    assert.ok(
        !/state: \{ in: \["STAGING", "NEEDS_REVIEW"\] \}/.test(finalize),
        "the state-SET fence is gone",
    );
    assert.match(finalize, /error: "not-recoverable"/);
    assert.match(finalize, /disposition === "not-recoverable"/);
});

// ── Presence is TAGGED: 404 and "storage is unhappy" are different answers ──

test("the size lookup separates a real absence from a storage fault", async () => {
    // The bug this closes: a helper that collapsed both into `false`. The intake
    // replay path reads it, and on a false it RE-UPLOADS and re-points the row —
    // so a transient fault orphaned the object that was really there and left
    // the row pointing at a second copy.
    const lister = (result: unknown) => ({ list: async () => result as never });

    const missing = await receiptObjectSize("receipts/intake/a.png", lister({ data: [], error: null }));
    assert.deepEqual(missing, { ok: false, kind: "missing" }, "an empty listing IS an answer");

    const notFound = await receiptObjectSize(
        "receipts/intake/a.png",
        lister({ data: null, error: { status: 404, message: "Object not found" } }),
    );
    assert.equal((notFound as { kind: string }).kind, "missing");

    for (const error of [
        { status: 500, message: "boom" },
        { status: 401, message: "invalid jwt" },
        { status: 429, message: "slow down" },
        { message: "fetch failed" },
    ]) {
        const fault = await receiptObjectSize("receipts/intake/a.png", lister({ data: null, error }));
        assert.equal((fault as { kind: string }).kind, "transient", JSON.stringify(error));
    }

    const found = await receiptObjectSize(
        "receipts/intake/a.png",
        lister({ data: [{ name: "a.png", metadata: { size: 1234 } }], error: null }),
    );
    assert.deepEqual(found, { ok: true, size: 1234 });

    // Present but sizeless is the one genuinely unknown case, and it must not
    // become permission to download.
    const sizeless = await receiptObjectSize(
        "receipts/intake/a.png",
        lister({ data: [{ name: "a.png", metadata: {} }], error: null }),
    );
    assert.equal((sizeless as { kind: string }).kind, "transient");

    // A throwing client is a transport fault, never evidence of absence.
    const threw = await receiptObjectSize("receipts/intake/a.png", {
        list: async () => { throw new TypeError("fetch failed"); },
    });
    assert.equal((threw as { kind: string }).kind, "transient");
});

test("the replay path heals only on an AFFIRMATIVE absence, and 503s on a fault", () => {
    const intake = readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/route.ts"),
        "utf8",
    );
    const branch = intake.slice(intake.indexOf("const held = await verifyStoredCopy("));
    const head = branch.slice(0, branch.indexOf("const healable"));
    assert.match(head, /held\.kind === "transient"/);
    assert.match(head, /status: 503/);
    // The transient answer is handled BEFORE the not-ok branch that heals, so a
    // storage fault can never reach storeObject. A CONTENT mismatch is answered
    // ahead of it too: a re-upload is exactly how bytes get replaced, so healing
    // one would let a replay launder the swap.
    assert.ok(
        head.indexOf('held.kind === "transient"') < head.indexOf("if (!held.ok) {"),
        "the fault check comes first",
    );
    assert.ok(
        head.indexOf('held.kind === "content-mismatch"') < head.indexOf("if (!held.ok) {"),
        "and so does the content check",
    );
    assert.ok(!/storeObject/.test(head), "nothing is written on the fault or mismatch paths");
    // And the collapsing helper is gone, so nothing can reintroduce it.
    const storage = readFileSync(path.join(__dirname, "..", "src/lib/secure-storage.ts"), "utf8");
    assert.ok(!/secureObjectExists/.test(storage), "no boolean exists-check to reach for");
});

// ── /start's "we already have it" was PRESENCE, not verification ───────────

test("/start's settled branch verifies the BYTES, and no longer probes for a size", async () => {
    // The finding: this branch checked object size/presence and returned
    // `alreadyReceived`. The forwarder deletes its only copy on that answer, so
    // an object replaced or corrupted after publication (the upload URL is
    // `upsert: true`, a restore can put back a different version, storage can
    // fault) was laundered into "we hold your receipt" and the last good copy
    // went with it. Inline replay and /finalize already downloaded and
    // SHA-verified; this path did not.
    const start = replayRoutes["POST /api/receipts/intake/start"];
    const branch = start.slice(start.indexOf(`if (existing.state !== "STAGING") {`));
    const body = branch.slice(0, branch.indexOf("alreadyReceived: true"));

    assert.match(body, /verifyStoredCopy\(existing\.storagePath, existing\.fileSha256\)/);
    assert.ok(
        !/receiptObjectSize/.test(start),
        "the presence-only probe is gone from the route entirely, not merely bypassed",
    );

    // The three verdicts, each mapped to its own answer, all decided BEFORE any
    // success is returned.
    assert.ok(body.indexOf(`held.kind === "transient"`) < body.indexOf(`if (!held.ok) {`),
        "a storage fault is answered first — it is never evidence about the bytes");
    assert.match(body, /reason: "verify-unavailable", retryable: true \}/);
    assert.match(body, /status: 503/);
    assert.ok(body.indexOf(`held.kind === "content-mismatch"`) < body.indexOf(`if (!held.ok) {`),
        "and so is a content mismatch");
    assert.match(body, /error: "content-mismatch"/);
    assert.match(body, /retryable: false/);
    assert.match(body, /error: "file-missing"/, "an affirmative absence keeps its own 409");
    assert.ok(!/storeObject|uploadReceiptObject|updateMany/.test(body),
        "and none of the three heals or otherwise writes to the row");
});

test("the three verdicts /start maps: mutated -> mismatch, fault -> transient, match -> ok", async () => {
    // The behaviour behind the mapping above, driven through the same shared
    // rule the route calls, with storage injected.
    const realSha = createHash("sha256").update(PNG).digest("hex");
    const mutated = Buffer.concat([PNG, Buffer.from([0])]);

    // A replaced object: 409 content-mismatch, and the row is left alone.
    const swapped = await verifyStoredCopy("p.png", realSha, SMALL, give({ ok: true, bytes: mutated }));
    assert.equal(swapped.ok, false);
    assert.equal((swapped as { kind: string }).kind, "content-mismatch");

    // A download that FAILS (downloadReceiptObject turns a thrown transport
    // fault into exactly this): 503 verify-unavailable, retryable. Never a
    // verdict about the bytes, so never the file-missing answer.
    const faulted = await verifyStoredCopy(
        "p.png", realSha, SMALL, give({ ok: false, kind: "transient", message: "TypeError: fetch failed" }),
    );
    assert.equal((faulted as { kind: string }).kind, "transient");

    // Only verified bytes reach alreadyReceived.
    assert.deepEqual(await verifyStoredCopy("p.png", realSha, SMALL, give({ ok: true, bytes: PNG })), { ok: true });
});

// -- A DECLARED hash is answered on EVERY success path (round-34 item 3) -----

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

test("a declared hash that disagrees with the row's verified one is a conflict", () => {
    assert.equal(declaredShaConflict(SHA_A, SHA_B), true);
    // Case is not identity: /start lowercases what it stores, a forwarder may
    // not, and rejecting on case alone would break honest callers.
    assert.equal(declaredShaConflict(SHA_A.toUpperCase(), SHA_A), false);
    assert.equal(declaredShaConflict(SHA_A, SHA_A.toUpperCase()), false);
    assert.equal(declaredShaConflict(SHA_A, SHA_A), false);
});

test("silence is not a conflict: no declared hash, and no verified one", () => {
    // The caller asserted nothing.
    assert.equal(declaredShaConflict(SHA_A, null), false);
    assert.equal(declaredShaConflict(SHA_A, ""), false);
    // A STAGING row (fileSha256 is "") or a legacy row written before sealing
    // existed has no verified identity to compare against — the publish path
    // checks the declared hash against the BYTES instead, which is stronger.
    assert.equal(declaredShaConflict("", SHA_B), false);
    assert.equal(declaredShaConflict(null, SHA_B), false);
});

test("/finalize enforces it ABOVE the disposition split, so no success bypasses it", () => {
    // The hole: `declaredSha` was compared to the STORED BYTES on the publish
    // path only. A finalize against an already-settled row (RECEIVED, READ,
    // BOOKED) verified storage against the ROW's hash, never looked at the hash
    // the REQUEST carried, and returned 200 alreadyFinalized — so a forwarder
    // with a stale or wrong row id was told we held ITS receipt while we held a
    // different one, and it deletes its only copy on that answer.
    const finalize = replayRoutes["POST /api/receipts/intake/{id}/finalize"];
    const guardAt = finalize.indexOf("declaredShaConflict(row.fileSha256, declaredSha)");
    assert.notEqual(guardAt, -1, "the guard must be wired to the row's verified hash");
    assert.ok(guardAt < finalize.indexOf("const disposition = finalizeDisposition(row)"),
        "above the disposition split");
    assert.ok(guardAt < finalize.indexOf("alreadyFinalized: true"), "above every success response");
    assert.ok(guardAt < finalize.indexOf("await applyLateFields("), "and above every write");
    // A 409, never a 2xx and never a write.
    const guard = finalize.slice(guardAt, finalize.indexOf("// Authorize the late fields"));
    assert.match(guard, /error: "sha-mismatch"/);
    assert.match(guard, /status: 409/);
    assert.ok(!/prisma\.receiptIntake\.update/.test(guard), "nothing is written on the way out");
});

test("the OTHER two replay paths already refuse a mismatching hash", () => {
    // Same rule, and it has to hold in all three or a forwarder can pick the
    // endpoint that answers most generously.
    //
    // /start requires `sha256` and compares it to whatever the row has recorded
    // BEFORE it can reach the settled "alreadyReceived" answer; the inline POST
    // hashes the bytes in the request body and compares those. Neither needs the
    // helper above — they already fail closed — but if either check is ever
    // removed this says so.
    assert.match(
        replayRoutes["POST /api/receipts/intake/start"],
        /if \(!knownSha \|\| knownSha !== expectedSha256\) \{/,
    );
    assert.match(
        replayRoutes["POST /api/receipts/intake"],
        /if \(existing\.fileSha256 !== fileSha256\) \{/,
    );
});

// ── A /start REFRESH during an in-flight finalize (Codex round-12 item 1) ───
//
// `reuseLiveLease` hands a retrying client a brand-new signed URL over the
// SAME path at the SAME lease version. It writes exactly two columns —
// `uploadLeaseNonce` and `uploadUrlExpiresAt` — and moves nothing else. So a
// fence built from state/reason/claim/version matched just as well after that
// refresh as before it, and a finalizer that had already read the row could:
//
//   - PUBLISH bytes the client has just been invited to replace, and schedule
//     the upload object's cleanup against the expiry it read — which the
//     refreshed URL then outlives, so a later valid PUT recreates an object no
//     row references and no sweep is looking for; or
//   - REJECT the row, deleting it out from under a client whose upload link
//     works again, on that same stale schedule.
//
// The fix is `leaseFence`. Each test below runs the interleaving, and each
// carries the pre-fix control: the same interleaving judged by `publishFence`,
// which still matches and would still have written.

/** What reuseLiveLease writes: a fresh generation and a longer window. */
const REFRESHED_NONCE = "nonce-b";
const REFRESHED_EXPIRY = new Date(EXPIRY.getTime() + 2 * 60 * 60_000);

function leasedRow() {
    return rowStore({
        id: "row-1",
        state: "STAGING",
        stateReason: null,
        claimToken: null,
        storagePath: "receipts/intake/row-1.v1.png",
        uploadLeaseVersion: 1,
        uploadLeaseNonce: NONCE,
        uploadUrlExpiresAt: EXPIRY,
    });
}

/** The /start retry that adopts the live lease. Same path, same version. */
function refreshLease(store: ReturnType<typeof rowStore>) {
    store.set({ uploadLeaseNonce: REFRESHED_NONCE, uploadUrlExpiresAt: REFRESHED_EXPIRY });
}

test("PUBLISH vs REFRESH: a lease reissued mid-finalize invalidates the publish", async () => {
    const store = leasedRow();
    // The finalizer reads the row...
    const observed = observedRow({
        state: store.get().state as string,
        stateReason: store.get().stateReason as string | null,
        uploadLeaseVersion: store.get().uploadLeaseVersion as number,
        uploadLeaseNonce: store.get().uploadLeaseNonce as string,
        uploadUrlExpiresAt: store.get().uploadUrlExpiresAt as Date,
    });

    let queued = 0;
    const outcome = await sealAndPublish("receipts/intake/row-1.v1.png", "row-1", 1, CHECK, {
        withObjectLock: noLock,
        seal: async (_u: string, canonical: string) => {
            // ...and /start refreshes the lease while the bytes are being sealed.
            refreshLease(store);
            return canonical;
        },
        commit: async () => store.updateMany(
            { id: "row-1", ...leaseFence(observed) },
            { state: "RECEIVED", stateReason: null },
        ),
        queueUploadCleanup: async () => { queued++; return "ev-1"; },
        settleUploadCleanup: async () => {},
        currentStoragePath: async () => store.get().storagePath as string,
        dropOrphanedCanonical: async () => {},
    } as never);

    assert.equal(outcome?.published, false, "the publish lost");
    assert.equal(store.get().state, "STAGING", "the row is untouched, still awaiting its upload");
    assert.equal(queued, 0, "and nothing was queued against the stale expiry");

    // THE PRE-FIX CONTROL. The same interleaving, judged by publishFence: it
    // matches, so the old code published — over a lease somebody else now owns,
    // and scheduled the upload cleanup against an expiry two hours too early.
    const wouldHaveMatched = Object.entries(publishFence(observed))
        .every(([k, v]) => store.get()[k] === v);
    assert.equal(wouldHaveMatched, true, "publishFence cannot see a refresh — that was the bug");
});

test("PUBLISH vs REFRESH control: an UNrefreshed lease still publishes", async () => {
    // Without this, a leaseFence that simply never matched would pass the test
    // above while breaking every honest publish.
    const store = leasedRow();
    const observed = observedRow({
        state: "STAGING",
        stateReason: null,
        uploadLeaseVersion: 1,
        uploadLeaseNonce: NONCE,
        uploadUrlExpiresAt: EXPIRY,
    });
    let queued = 0;
    const outcome = await sealAndPublish("receipts/intake/row-1.v1.png", "row-1", 1, CHECK, {
        withObjectLock: noLock,
        seal: async (_u: string, canonical: string) => canonical,
        commit: async () => store.updateMany(
            { id: "row-1", ...leaseFence(observed) },
            { state: "RECEIVED", stateReason: null },
        ),
        queueUploadCleanup: async () => { queued++; return "ev-1"; },
        settleUploadCleanup: async () => {},
        currentStoragePath: async () => store.get().storagePath as string,
        dropOrphanedCanonical: async () => {},
    } as never);
    assert.equal(outcome?.published, true);
    assert.equal(store.get().state, "RECEIVED");
    assert.equal(queued, 1, "and the upload object's cleanup is queued in the commit");
});

// ── THE SWEEPER IS THE THIRD PUBLISHER (Codex round-14 item 2) ──────────────
//
// /finalize and the stale-STAGING sweep both move a STAGING row, and a /start
// retry can extend its lease between either one's inspection and its write.
// The sweep computes `leaseLive` from the SELECT at the top of the pass and
// then spends a storage round trip per row, so that window is seconds wide.
//
// Its sha-mismatch park, its publish commit and its file-missing park all
// fenced on {state, version} — which a refresh does not move — so the sweep
// parked or published over a URL a client was still uploading to, and
// scheduled the upload path's cleanup against an obsolete expiry. Only the
// reject branch carried the whole identity, which is what proved the intent.

/** What reuseLiveLease writes: same path, same version, new generation. */
function refreshedInto(store: ReturnType<typeof rowStore>) {
    store.set({
        uploadLeaseNonce: "nonce-refreshed",
        uploadUrlExpiresAt: new Date(EXPIRY.getTime() + 2 * 60 * 60_000),
    });
}

/** The row the sweeper SELECTed, and the fence it must therefore carry. */
function stagingRow() {
    return rowStore({
        id: "row-1",
        state: "STAGING",
        stateReason: null,
        claimToken: null,
        storagePath: "receipts/intake/row-1.v1.png",
        uploadLeaseVersion: 1,
        uploadLeaseNonce: NONCE,
        uploadUrlExpiresAt: EXPIRY,
    });
}

const observedStaging = (store: ReturnType<typeof rowStore>) => observedRow({
    state: store.get().state as string,
    stateReason: store.get().stateReason as string | null,
    uploadLeaseVersion: store.get().uploadLeaseVersion as number,
    uploadLeaseNonce: store.get().uploadLeaseNonce as string,
    uploadUrlExpiresAt: store.get().uploadUrlExpiresAt as Date,
});

test("SWEEP vs REFRESH: a park loses to a lease reissued mid-inspection", async () => {
    const store = stagingRow();
    const observed = observedStaging(store);

    // The storage round trip the sweep makes per row — and the /start retry
    // that lands inside it.
    refreshedInto(store);

    // The park the sweep would then write, fenced exactly as the code does.
    const parked = store.updateMany(
        { id: "row-1", ...leaseFence(observed) },
        { state: "NEEDS_REVIEW", stateReason: "file-missing" },
    );

    assert.equal(parked, 0, "the park matched nothing");
    assert.equal(store.get().state, "STAGING", "the client's row survives");
    assert.equal(store.get().uploadLeaseNonce, "nonce-refreshed", "and its new lease stands");

    // PRE-FIX CONTROL: the fence the sweep used to carry still matches, because
    // a refresh moves neither the state nor the version.
    const halfFence = { id: "row-1", state: "STAGING", uploadLeaseVersion: 1 };
    const wouldHaveMatched = Object.entries(halfFence)
        .every(([k, v]) => store.get()[k] === v);
    assert.equal(wouldHaveMatched, true, "state + version cannot see a refresh — that was the bug");
});

test("SWEEP vs REFRESH: the publish commit loses too", async () => {
    // Publishing is allowed while a lease is live, so this branch is reachable
    // with a working URL by design — which is exactly why its CAS has to see a
    // refresh. Sealing bytes the client is about to replace, and then
    // scheduling the upload path's cleanup against the OLD expiry, is the
    // orphan the schedule exists to prevent.
    const store = stagingRow();
    const observed = observedStaging(store);

    let queuedExpiry: Date | null = null;
    const outcome = await sealAndPublish("receipts/intake/row-1.v1.png", "row-1", 1, CHECK, {
        withObjectLock: noLock,
        seal: async (_u: string, canonical: string) => {
            refreshedInto(store);
            return canonical;
        },
        commit: async () => store.updateMany(
            { id: "row-1", ...leaseFence(observed) },
            { state: "RECEIVED", stateReason: null },
        ),
        queueUploadCleanup: async () => {
            queuedExpiry = observed.uploadUrlExpiresAt;
            return "ev-1";
        },
        settleUploadCleanup: async () => {},
        currentStoragePath: async () => store.get().storagePath as string,
        dropOrphanedCanonical: async () => {},
    } as never);

    assert.equal(outcome?.published, false, "the sweep did not publish over the refreshed lease");
    assert.equal(store.get().state, "STAGING");
    assert.equal(queuedExpiry, null, "and queued no cleanup on the obsolete expiry");
});

test("SWEEP CONTROL: an unrefreshed row still parks and still publishes", async () => {
    // Without this, a fence that simply never matched would pass both tests
    // above while stopping the sweep from doing anything at all.
    const parkStore = stagingRow();
    assert.equal(
        parkStore.updateMany(
            { id: "row-1", ...leaseFence(observedStaging(parkStore)) },
            { state: "NEEDS_REVIEW", stateReason: "file-missing" },
        ),
        1,
    );
    assert.equal(parkStore.get().state, "NEEDS_REVIEW");

    const pubStore = stagingRow();
    const observed = observedStaging(pubStore);
    const outcome = await sealAndPublish("receipts/intake/row-1.v1.png", "row-1", 1, CHECK, {
        withObjectLock: noLock,
        seal: async (_u: string, canonical: string) => canonical,
        commit: async () => pubStore.updateMany(
            { id: "row-1", ...leaseFence(observed) },
            { state: "RECEIVED", stateReason: null },
        ),
        queueUploadCleanup: async () => "ev-1",
        settleUploadCleanup: async () => {},
        currentStoragePath: async () => pubStore.get().storagePath as string,
        dropOrphanedCanonical: async () => {},
    } as never);
    assert.equal(outcome?.published, true);
    assert.equal(pubStore.get().state, "RECEIVED");
});

test("THREE PUBLISHERS, one fence: /finalize, the sweeper and a /start refresh", () => {
    // The interleaving as source: both publishers reach the same builder, and
    // the sweep's parks now do too. A reader should not have to diff three
    // where clauses to know they agree.
    const finalize = readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/[id]/finalize/route.ts"),
        "utf8",
    );
    const sweeper = readFileSync(
        path.join(__dirname, "..", "src/app/api/cron/receipt-intake-worker/route.ts"),
        "utf8",
    );
    const start = readFileSync(
        path.join(__dirname, "..", "src/app/api/receipts/intake/start/route.ts"),
        "utf8",
    );
    assert.match(finalize, /where: \{ id, \.\.\.leaseFence\(row\), \.\.\.merged\.guard \}/);
    // The sweep: sha-mismatch park, publish commit, file-missing park.
    const sweep = sweeper.slice(
        sweeper.indexOf("sweepStaleStaging: async"),
        sweeper.indexOf("loadPhases:"),
    );
    assert.equal((sweep.match(/\.\.\.leaseFence\(row\)/g) ?? []).length, 3);
    // ...and the counters only move when the CAS did.
    assert.match(sweep, /if \(mismatchParked > 0\) parked\+\+;/);
    assert.match(sweep, /if \(missingParked > 0\) parked\+\+;/);
    // /start builds its fence inside the shared repath helper, so neither of
    // its two branches can hand in half an identity.
    assert.match(start, /where: \{ id: existing\.id, \.\.\.leaseFence\(existing\) \},/);
    assert.equal((start.match(/await repathWithCleanup\(/g) ?? []).length, 2);
});
