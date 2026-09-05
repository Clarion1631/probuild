import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acceptedIngestResult, approvedIngestUrl, expectedSourceExternalId, privateCheckItems } from "../scripts/submit-bank-check-fronts.mjs";

test("only manifest-attested front JPEGs are prepared for API submission", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probuild-check-front-"));
    try {
        const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5_100)]);
        const name = "front.jpg";
        fs.writeFileSync(path.join(dir, name), bytes);
        const manifest = { images: {
            check: { bankReference: "26225018006376", kind: "CHECK", micrRedacted: true, capturedAt: "2026-08-13T18:40:00.000Z", redactionReview: { status: "passed", method: "verified crop", cropBox: [0, 0, 800, 600], sourceDimensions: [800, 700], sourceSha256: createHash("sha256").update(bytes).digest("hex"), reviewer: "authorized reviewer", reviewedAt: "2026-08-13T18:42:00.000Z" }, files: [{ fileName: name, side: "front", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] },
            deposit: { bankReference: "26225018006377", kind: "DEPOSIT", micrRedacted: true, files: [{ fileName: name, side: "front", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] },
        }};
        const result = privateCheckItems(manifest, dir);
        assert.equal(result.problems.length, 0);
        assert.equal(result.items.length, 1);
        assert.ok(result.items[0].imageBase64.length > 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("missing audit data blocks submission before any API call", () => {
    const result = privateCheckItems({ images: { check: { kind: "CHECK", micrRedacted: false, files: [] } } }, "C:/missing");
    assert.equal(result.items.length, 0);
    assert.equal(result.problems.length, 1);
});

test("only production and explicit localhost API origins are permitted", () => {
    assert.equal(approvedIngestUrl("https://probuild.goldentouchremodeling.com").pathname, "/api/integrations/bank-images/ingest");
    assert.equal(approvedIngestUrl("http://localhost:3000" ).origin, "http://localhost:3000");
    assert.equal(approvedIngestUrl("https://example.invalid"), null);
    assert.equal(approvedIngestUrl("not a URL"), null);
});

test("a submission requires one matching accepted response", () => {
    const id = "reference:front";
    for (const status of ["created", "backfilled", "existing"]) {
        assert.equal(acceptedIngestResult({ results: [{ sourceExternalId: id, status }] }, id), true);
    }
    assert.equal(acceptedIngestResult({ results: [] }, id), false);
    assert.equal(acceptedIngestResult({ results: [{ sourceExternalId: "other:front", status: "created" }] }, id), false);
    assert.equal(acceptedIngestResult({ results: [{ sourceExternalId: id, status: "rejected" }] }, id), false);
});

test("a reviewed incoming bank-reference front is staged with its explicit direction", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probuild-incoming-front-"));
    try {
        const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5_100)]);
        fs.writeFileSync(path.join(dir, "front.jpg"), bytes);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const incoming = { bankReference: "26225018006376", kind: "DEPOSIT_CHECK", direction: "incoming", micrRedacted: true, capturedAt: "2026-08-13T18:40:00.000Z", redactionReview: { status: "passed", method: "verified crop", cropBox: [0, 0, 800, 600], sourceDimensions: [800, 700], sourceSha256: hash, reviewer: "authorized reviewer", reviewedAt: "2026-08-13T18:42:00.000Z" }, files: [{ fileName: "front.jpg", side: "front", byteSize: bytes.length, sha256: hash }] };
        const result = privateCheckItems({ images: { incoming } }, dir);
        assert.equal(result.problems.length, 0);
        assert.equal(result.items[0].direction, "incoming");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("incoming fronts with one bank reference retain distinct original-image identities", () => {
    const bankReference = "26225018006376";
    const first = { bankReference, kind: "DEPOSIT_CHECK", redactionReview: { sourceSha256: "a".repeat(64) } };
    const second = { bankReference, kind: "DEPOSIT_CHECK", redactionReview: { sourceSha256: "b".repeat(64) } };
    assert.notEqual(expectedSourceExternalId(first), expectedSourceExternalId(second));
    assert.equal(expectedSourceExternalId(first), `${bankReference}:image:${"a".repeat(64)}:front`);
    assert.equal(expectedSourceExternalId({ bankReference, kind: "CHECK" }), `${bankReference}:front`);
});
