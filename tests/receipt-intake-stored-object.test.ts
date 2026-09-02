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
import { inspectStoredObject } from "../src/lib/receipt-intake/stored-object";
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

test("text/plain is the ONE type taken on its declared word", async () => {
    // It has no magic bytes. Same concession the single-shot path makes.
    const txt = Buffer.from("VENDOR: Lowes\nTOTAL: 10.00");
    const ok = await inspectStoredObject("p.txt", "text/plain", give({ ok: true, bytes: txt }));
    assert.ok(ok.ok);
    assert.equal(ok.mimeType, "text/plain");

    // ...and without that declaration the same bytes are unidentifiable.
    const bad = await inspectStoredObject("p.bin", "", give({ ok: true, bytes: txt }));
    assert.equal(bad.ok, false);
    assert.equal((bad as { reason: string }).reason, "unsupported-file-type");
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
