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
    downloadVerified,
    finalizeDisposition,
    inspectStoredObject,
    publishFence,
    RECOVERABLE_PARK_REASONS,
    sealAndPublish,
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
    assert.equal(canonicalStoragePath("row-1", sha, "image/png"), `receipts/row-1/${sha}.png`);
    assert.equal(canonicalStoragePath("row-1", sha, "application/pdf"), `receipts/row-1/${sha}.pdf`);
    // Two rows with identical bytes still get separate objects — deleting one
    // receipt must never remove another's evidence.
    assert.notEqual(canonicalStoragePath("row-1", sha, "image/png"), canonicalStoragePath("row-2", sha, "image/png"));
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

/** `sealOk`/`committed` drive the outcome; the call log is always recorded. */
function publishHarness(opts: { sealOk?: boolean; committed?: number } = {}) {
    const calls: string[] = [];
    const deps = {
        seal: async (_u: string, canonical: string) => {
            calls.push("seal");
            return opts.sealOk === false ? null : canonical;
        },
        commit: async () => { calls.push("commit"); return opts.committed ?? 1; },
        dropUpload: async () => { calls.push("drop"); },
    } as never;
    return { calls, deps };
}

const CHECK = {
    mimeType: "image/png",
    fileSize: PNG.length,
    fileSha256: createHash("sha256").update(PNG).digest("hex"),
    bytes: PNG,
};

test("the upload object is deleted only AFTER the row pointer is committed", async () => {
    // Deleting first is unrecoverable: if the UPDATE then fails, the row still
    // points at a path whose object we just removed, and the receipt is gone
    // with nothing left to retry from.
    const h = publishHarness();
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", CHECK, h.deps);
    assert.deepEqual(h.calls, ["seal", "commit", "drop"]);
    assert.equal(outcome?.published, true);
    assert.equal(outcome?.canonicalPath, `receipts/row-1/${CHECK.fileSha256}.png`);
});

test("a FAILED commit leaves the upload object alone, so the retry can recover", async () => {
    const h = publishHarness({ committed: 0 });
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", CHECK, h.deps);
    assert.deepEqual(h.calls, ["seal", "commit"], "nothing was deleted");
    assert.equal(outcome?.published, false);
});

test("a failed SEAL never touches the row or the upload object", async () => {
    const h = publishHarness({ sealOk: false });
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", CHECK, h.deps);
    assert.equal(outcome, null);
    assert.deepEqual(h.calls, ["seal"]);
});

test("a retry that finds the canonical object already there still commits", async () => {
    // The crash-between-copy-and-commit case: the copy is an upsert to a
    // content-addressed path, so re-sealing the same bytes is a no-op and the
    // retry simply commits.
    const h = publishHarness();
    const first = await sealAndPublish("receipts/intake/a.png", "row-1", CHECK, h.deps);
    const second = await sealAndPublish("receipts/intake/a.png", "row-1", CHECK, h.deps);
    assert.equal(first?.canonicalPath, second?.canonicalPath, "same content, same path");
    assert.equal(second?.published, true);
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
    assert.equal(finalizeDisposition({ state: "STAGING", stateReason: null, uploadLeaseVersion: 1 }), "publish");
    for (const reason of RECOVERABLE_PARK_REASONS) {
        assert.equal(finalizeDisposition({ state: "NEEDS_REVIEW", stateReason: reason, uploadLeaseVersion: 1 }), "publish", reason);
    }
    // Everything else parked for review is somebody's decision. Republishing it
    // drags the row back to RECEIVED and re-reads it, discarding that decision.
    for (const reason of ["vendor-mismatch", "weak-dup:row-9", "qbo-fault:6210", "amount-mismatch", null]) {
        assert.equal(
            finalizeDisposition({ state: "NEEDS_REVIEW", stateReason: reason, uploadLeaseVersion: 1 }),
            "not-recoverable",
            String(reason),
        );
    }
    // And a row that already moved on is simply settled — not an error.
    for (const state of ["RECEIVED", "READ", "BOOKING", "BOOKED", "ARCHIVED", "DUPLICATE"]) {
        assert.equal(finalizeDisposition({ state, stateReason: null, uploadLeaseVersion: 1 }), "settled", state);
    }
});

test("the publish fence pins the exact state, the exact reason and an unclaimed row", () => {
    assert.deepEqual(publishFence({ state: "NEEDS_REVIEW", stateReason: "file-missing", uploadLeaseVersion: 1 }), {
        state: "NEEDS_REVIEW",
        stateReason: "file-missing",
        claimToken: null, uploadLeaseVersion: 1,
    });
    assert.deepEqual(publishFence({ state: "STAGING", stateReason: null, uploadLeaseVersion: 1 }), {
        state: "STAGING",
        stateReason: null,
        claimToken: null, uploadLeaseVersion: 1,
    });
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
        id: "row-1", state: "NEEDS_REVIEW", stateReason: "file-missing", claimToken: null, uploadLeaseVersion: 1,
    });
    const observed = {
        state: store.get().state as string,
        stateReason: store.get().stateReason as string,
        uploadLeaseVersion: store.get().uploadLeaseVersion as number,
    };
    assert.equal(finalizeDisposition(observed), "publish", "it was recoverable when we read it");
    const fence = publishFence(observed);

    let dropped = false;
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", CHECK, {
        seal: async (_u: string, canonical: string) => {
            // THE RACE, in the exact window it happens: the worker re-parks the
            // row while we are copying the bytes.
            store.set({ stateReason: "vendor-mismatch" });
            return canonical;
        },
        commit: async (canonicalPath: string) =>
            store.updateMany(
                { id: "row-1", ...fence },
                { state: "RECEIVED", stateReason: null, storagePath: canonicalPath },
            ),
        dropUpload: async () => { dropped = true; },
    } as never);

    assert.equal(outcome?.published, false, "zero rows updated");
    assert.equal(store.get().state, "NEEDS_REVIEW", "the row is untouched");
    assert.equal(store.get().stateReason, "vendor-mismatch", "the newer decision survives");
    assert.equal(dropped, false, "and the upload object is kept for the retry");
});

test("RACE: a worker claim taken during sealing also loses the publish", async () => {
    const store = rowStore({
        id: "row-1", state: "STAGING", stateReason: null, claimToken: null, uploadLeaseVersion: 1,
    });
    const fence = publishFence({ state: "STAGING", stateReason: null, uploadLeaseVersion: 1 });
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", CHECK, {
        seal: async (_u: string, canonical: string) => {
            store.set({ claimToken: "sweeper-1" });
            return canonical;
        },
        commit: async () => store.updateMany({ id: "row-1", ...fence }, { state: "RECEIVED" }),
        dropUpload: async () => {},
    } as never);
    assert.equal(outcome?.published, false);
    assert.equal(store.get().state, "STAGING", "the sweeper's row is left alone");
});

test("an unchanged row still publishes — the control", async () => {
    const store = rowStore({
        id: "row-1", state: "NEEDS_REVIEW", stateReason: "sha-mismatch", claimToken: null, uploadLeaseVersion: 1,
    });
    const fence = publishFence({ state: "NEEDS_REVIEW", stateReason: "sha-mismatch", uploadLeaseVersion: 1 });
    const outcome = await sealAndPublish("receipts/intake/a.png", "row-1", CHECK, {
        seal: async (_u: string, canonical: string) => canonical,
        commit: async () => store.updateMany({ id: "row-1", ...fence }, { state: "RECEIVED", stateReason: null, uploadLeaseVersion: 1 }),
        dropUpload: async () => {},
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
    assert.match(finalize, /where: \{ id, \.\.\.publishFence\(row\), \.\.\.merged\.guard \}/);
    assert.match(intake, /where: \{ id: existing\.id, \.\.\.publishFence\(existing\) \}/);
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
    const branch = intake.slice(intake.indexOf("const present = await receiptObjectSize("));
    const head = branch.slice(0, branch.indexOf("const healable"));
    assert.match(head, /present\.kind === "transient"/);
    assert.match(head, /status: 503/);
    // The transient answer is handled BEFORE the not-ok branch that heals, so a
    // storage fault can never reach storeObject.
    assert.ok(
        head.indexOf('present.kind === "transient"') < head.indexOf("if (!present.ok) {"),
        "the fault check comes first",
    );
    assert.ok(!/storeObject/.test(head), "nothing is written on the fault path");
    // And the collapsing helper is gone, so nothing can reintroduce it.
    const storage = readFileSync(path.join(__dirname, "..", "src/lib/secure-storage.ts"), "utf8");
    assert.ok(!/secureObjectExists/.test(storage), "no boolean exists-check to reach for");
});
