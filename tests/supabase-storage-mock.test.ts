/**
 * The e2e storage stub has to answer the questions production code actually
 * asks — including the ones it does not implement.
 *
 * THE REGRESSION. `receiptObjectSize` (bucket.ts) and `secureObjectSize`
 * (secure-storage.ts) both establish "is this object there, and how big is it"
 * from `list` metadata, because downloading an 8 MiB receipt to learn its size
 * is the exact thing they exist to avoid. The stub had no `list`, so
 * `from.list` was `undefined` and the call THREW — and `receiptObjectSize`
 * classifies a throw as TRANSIENT, i.e. "storage is having a moment", not "the
 * object is gone".
 *
 * That is not a missing feature, it is a WRONG ANSWER. Every intake replay that
 * reached the existence check got 503 instead of the 200-or-heal it had earned,
 * so the idempotency contract the whole forwarder design rests on could not be
 * exercised at all under the stub. A stub that omits a method does not omit a
 * behaviour; it invents one, and the invented one looked like flaky
 * infrastructure rather than a bug.
 *
 * So this file pins two things: the METHOD SURFACE (so the next omission fails
 * here, loudly, instead of in a spec that reads as a storage hiccup) and the
 * missing/present classification the callers actually branch on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStorageMockClient } from "../src/lib/supabase-storage-mock";
import { receiptObjectSize, RECEIPT_BUCKET, type BucketLister } from "../src/lib/receipt-intake/bucket";

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

function freshBucket() {
    // The stub caches objects on globalThis so state survives Next.js
    // instantiating the module once per route bundle; tests must not inherit
    // each other's writes.
    (globalThis as { __e2eStorageMockObjects?: unknown }).__e2eStorageMockObjects = undefined;
    return createStorageMockClient().storage.from(RECEIPT_BUCKET);
}

test("the stub implements every storage method production code calls", () => {
    // The list is not decorative: each of these is reached by a real code path
    // under E2E_STORAGE_MOCK=1, and a missing one fails as a THROW that the
    // callers translate into a transient storage fault.
    const api = freshBucket() as unknown as Record<string, unknown>;
    for (const method of [
        "upload",
        "download",
        "remove",
        "list",
        "getPublicUrl",
        "createSignedUrl",
        "createSignedUploadUrl",
    ]) {
        assert.equal(typeof api[method], "function", `storage mock is missing ${method}()`);
    }
});

test("an object that IS there reports its real size, not an unknown", async () => {
    const bucket = freshBucket();
    const path = "receipts/intake/abc-123.png";
    const { error } = await bucket.upload(path, PNG, { contentType: "image/png" });
    assert.equal(error, null);

    const size = await receiptObjectSize(path, bucket as unknown as BucketLister);
    assert.deepEqual(size, { ok: true, size: PNG.length });
});

test("an object that is NOT there is MISSING, never transient", async () => {
    // This is the assertion that would have caught it. Before `list` existed
    // the answer here was {ok:false, kind:"transient"} — and transient is what
    // the intake replay path answers 503 to, so a row whose object had never
    // landed could not be healed and a replay of one that HAD landed could not
    // be confirmed. "Gone" and "storage hiccuped" are different receipts.
    const bucket = freshBucket();
    await bucket.upload("receipts/intake/present.png", PNG, { contentType: "image/png" });

    const absent = await receiptObjectSize(
        "receipts/intake/never-uploaded.png",
        bucket as unknown as BucketLister,
    );
    assert.deepEqual(absent, { ok: false, kind: "missing" });
});

test("an EMPTY prefix is an answer, not an error", async () => {
    const bucket = freshBucket();
    const empty = await receiptObjectSize(
        "receipts/intake/anything.png",
        bucket as unknown as BucketLister,
    );
    assert.deepEqual(empty, { ok: false, kind: "missing" });
});

test("`search` is a PREFIX filter on the name, and names are relative to the dir", async () => {
    // storage-api's SQL is `name ilike prefix || search || '%'`, so a substring
    // match would be wrong — and `name` comes back relative to the listed
    // directory, which is what both callers compare with `entry.name === name`.
    const bucket = freshBucket();
    await bucket.upload("receipts/intake/aaa.png", PNG, { contentType: "image/png" });
    await bucket.upload("receipts/intake/aab.png", PNG, { contentType: "image/png" });
    await bucket.upload("receipts/intake/zzz-aaa.png", PNG, { contentType: "image/png" });

    const { data } = await bucket.list("receipts/intake", { search: "aa", limit: 100 });
    assert.deepEqual(data?.map(e => e.name), ["aaa.png", "aab.png"]);

    const exact = await bucket.list("receipts/intake", { search: "aaa.png", limit: 100 });
    assert.deepEqual(exact.data?.map(e => e.name), ["aaa.png"]);
});

test("a sub-folder appears ONCE and carries no metadata", async () => {
    // How the real API distinguishes a folder from an object, and what stops a
    // directory with 200 objects under it from filling a caller's page.
    const bucket = freshBucket();
    await bucket.upload("receipts/intake/one.png", PNG, { contentType: "image/png" });
    await bucket.upload("receipts/nested/a.png", PNG, { contentType: "image/png" });
    await bucket.upload("receipts/nested/b.png", PNG, { contentType: "image/png" });

    const { data } = await bucket.list("receipts", { search: "", limit: 100 });
    assert.deepEqual(data?.map(e => e.name), ["intake", "nested"]);
    assert.deepEqual(data?.map(e => e.metadata), [null, null]);
});

test("limit and offset page the listing", async () => {
    const bucket = freshBucket();
    for (const name of ["a.png", "b.png", "c.png"]) {
        await bucket.upload(`receipts/intake/${name}`, PNG, { contentType: "image/png" });
    }
    const first = await bucket.list("receipts/intake", { search: "", limit: 2 });
    assert.deepEqual(first.data?.map(e => e.name), ["a.png", "b.png"]);

    const second = await bucket.list("receipts/intake", { search: "", limit: 2, offset: 2 });
    assert.deepEqual(second.data?.map(e => e.name), ["c.png"]);
});

test("a removed object goes back to MISSING", async () => {
    const bucket = freshBucket();
    const path = "receipts/intake/gone.png";
    await bucket.upload(path, PNG, { contentType: "image/png" });
    assert.deepEqual(
        await receiptObjectSize(path, bucket as unknown as BucketLister),
        { ok: true, size: PNG.length },
    );

    await bucket.remove([path]);
    assert.deepEqual(
        await receiptObjectSize(path, bucket as unknown as BucketLister),
        { ok: false, kind: "missing" },
    );
});
