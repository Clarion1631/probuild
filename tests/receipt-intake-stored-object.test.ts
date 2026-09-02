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
import {
    canonicalStoragePath,
    downloadVerified,
    inspectStoredObject,
    sealAndPublish,
} from "../src/lib/receipt-intake/stored-object";
import { MAX_STORED_BYTES } from "../src/lib/receipt-intake/intake-core";
import type { DocBytesResult } from "../src/lib/secure-storage";

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);
const give = (r: DocBytesResult) => async () => r;

test("a real image is accepted, and its metadata comes from the BYTES", async () => {
    const check = await inspectStoredObject("p.jpg", "application/pdf", give({ ok: true, bytes: PNG }));
    assert.ok(check.ok);
    // The declared type said PDF. The bytes say PNG, and the bytes win.
    assert.equal(check.mimeType, "image/png");
    assert.equal(check.fileSize, PNG.length);
    assert.equal(check.fileSha256, createHash("sha256").update(PNG).digest("hex"));
});

test("oversize, empty and unidentifiable objects are REJECTED, not published", async () => {
    // The signed upload URL bypassed every check the server could otherwise
    // make, so these are enforced on the object itself.
    const big = await inspectStoredObject("p.jpg", "image/jpeg", give({
        ok: true, bytes: Buffer.alloc(MAX_STORED_BYTES + 1, 1),
    }));
    assert.equal(big.ok, false);
    assert.match((big as { reason: string }).reason, /^file-too-large:/);

    const empty = await inspectStoredObject("p.jpg", "image/jpeg", give({ ok: true, bytes: Buffer.alloc(0) }));
    assert.equal((empty as { reason: string }).reason, "empty-file");

    const exe = await inspectStoredObject("p.exe", "image/jpeg", give({ ok: true, bytes: Buffer.from("MZ\x90\x00") }));
    assert.equal((exe as { reason: string }).reason, "unsupported-file-type");
});

test("an oversize object is rejected from METADATA, with no body read at all", async () => {
    // The signed upload URL bypasses this server, so the first time anything
    // here sees the object is now. Downloading it to discover it is 400 MB is
    // how one upload takes the whole invocation — and its memory — with it.
    let downloads = 0;
    const check = await inspectStoredObject(
        "p.bin",
        "image/jpeg",
        async () => { downloads++; throw new Error("the body must never be fetched"); },
        async () => MAX_STORED_BYTES + 1,
    );
    assert.equal(check.ok, false);
    assert.equal((check as { reason: string }).reason, `file-too-large:${MAX_STORED_BYTES + 1}`);
    assert.equal(downloads, 0, "not one byte was read");
});

test("an UNKNOWN metadata size still downloads, and the bytes decide", async () => {
    // A null size is "storage did not say", not "fine". The byte-length check
    // below it is what actually enforces the limit.
    const check = await inspectStoredObject(
        "p.png",
        "image/png",
        give({ ok: true, bytes: PNG }),
        async () => null,
    );
    assert.ok(check.ok);
});

test("a metadata size AT the ceiling is not rejected before the download", async () => {
    let downloads = 0;
    const check = await inspectStoredObject(
        "p.png",
        "image/png",
        async () => { downloads++; return { ok: true as const, bytes: PNG }; },
        async () => MAX_STORED_BYTES,
    );
    assert.ok(check.ok);
    assert.equal(downloads, 1);
});

test("exactly at the ceiling is allowed", async () => {
    const atLimit = Buffer.concat([PNG, Buffer.alloc(MAX_STORED_BYTES - PNG.length, 0)]);
    assert.equal(atLimit.length, MAX_STORED_BYTES);
    const check = await inspectStoredObject("p.png", "image/png", give({ ok: true, bytes: atLimit }));
    assert.ok(check.ok, "the boundary itself is not oversize");
});

test("missing and transient are DIFFERENT answers", async () => {
    // A confirmed 404 is terminal for the sweep; a storage blip must come back
    // next pass rather than park a good receipt as file-missing.
    const missing = await inspectStoredObject("p.jpg", "image/jpeg", give({ ok: false, kind: "not-found" }));
    assert.deepEqual(missing, { ok: false, kind: "missing" });

    const flaky = await inspectStoredObject("p.jpg", "image/jpeg", give({
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
    const check = await inspectStoredObject("p.png", "image/png", give({ ok: true, bytes: PNG }));
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
    const check = await inspectStoredObject("p.txt", "text/plain", give({ ok: true, bytes: txt }));
    assert.equal(check.ok, false);
    assert.equal((check as { reason: string }).reason, "unsupported-file-type");
});

// ── A sha-mismatch is recoverable while the URL can still land (item 5) ────

test("the sweeper's two parks are the ones /finalize recovers from", () => {
    // A partial upload sitting at the path while the signed URL is still valid
    // is a retry in progress, not an error state. Parking it would turn the
    // client's own next request into a review item — and the correct bytes
    // arriving a minute later would find the row already out of STAGING.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = path.resolve(__dirname, "..");

    const sweeper = readFileSync(
        path.join(root, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8",
    );
    // Both the missing-object and the sha-mismatch branches wait for expiry.
    const shaBranch = sweeper.slice(sweeper.indexOf('row.expectedSha256 !== check.fileSha256'));
    assert.match(
        shaBranch.slice(0, shaBranch.indexOf("parked++")),
        /SIGNED_UPLOAD_TTL_MS/,
        "a sha mismatch waits for the upload URL to expire",
    );

    const finalize = readFileSync(
        path.join(root, "src/app/api/receipts/intake/[id]/finalize/route.ts"), "utf8",
    );
    assert.match(finalize, /stateReason === "file-missing" \|\| row\.stateReason === "sha-mismatch"/);
});
