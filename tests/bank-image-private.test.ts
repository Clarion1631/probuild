import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { preparePrivateBankImage } from "@/lib/bank-image-private";

async function jpegBuffer() {
    const width = 400;
    const height = 400;
    const raw = Buffer.alloc(width * height * 3);
    for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 17) % 251;
    return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

function entry(sha256: string, byteSize: number, overrides: Record<string, unknown> = {}) {
    return {
        bankReference: "26225018006376",
        kind: "CHECK",
        micrRedacted: true,
        checkNumber: "01027",
        date: "2026-08-13",
        capturedAt: "2026-08-13T18:40:00.000Z",
        amountCents: 603715,
        redactionReview: {
            status: "passed",
            method: "verified crop",
            cropBox: [0, 0, 400, 400],
            sourceDimensions: [400, 500],
            sourceSha256: sha256,
            reviewer: "authorized reviewer",
            reviewedAt: "2026-08-13T18:42:00.000Z",
        },
        files: [{ fileName: "check-front.jpg", side: "front", byteSize, sha256 }],
        ...overrides,
    };
}

test("a verified redacted check front receives a hash-preserving private reference", async () => {
    const jpeg = await jpegBuffer();
    const sha256 = createHash("sha256").update(jpeg).digest("hex");
    const result = await preparePrivateBankImage(entry(sha256, jpeg.length), jpeg);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.row.sourceExternalId, "26225018006376:front");
    assert.equal(result.row.normalizedCheckNumber, "1027");
    assert.match(result.storagePath, /^bank-images\/wtb-online\/26225018006376\/front-redacted-[a-f0-9]{64}\.jpg$/);
    assert.equal(result.secureRef, `secure:${result.storagePath}`);
    assert.equal(result.storageMetadata.redacted_front_sha256, sha256);
    assert.equal(result.storageMetadata.redaction_status, "passed");
});

test("backs, unredacted entries, manifest hash mismatches, and non-JPEG bytes are refused", async () => {
    const jpeg = await jpegBuffer();
    const sha256 = createHash("sha256").update(jpeg).digest("hex");
    for (const [manifest, bytes] of [
        [entry(sha256, jpeg.length, { micrRedacted: false }), jpeg],
        [entry(sha256, jpeg.length, { files: [{ fileName: "check-back.jpg", side: "back", byteSize: jpeg.length, sha256 }] }), jpeg],
        [entry(sha256, jpeg.length, { files: [{ fileName: "check-front.jpg", side: "front", byteSize: jpeg.length, sha256: "0".repeat(64) }] }), jpeg],
        [entry(sha256, jpeg.length, { capturedAt: undefined }), jpeg],
        [entry(sha256, jpeg.length, { redactionReview: { status: "passed" } }), jpeg],
        [entry(sha256, jpeg.length, { checkNumber: "not-a-number" }), jpeg],
        [entry(sha256, jpeg.length), Buffer.from("not a jpeg")],
        [entry(createHash("sha256").update(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5_100)])).digest("hex"), 5_103), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5_100)])],
    ] as const) {
        const result = await preparePrivateBankImage(manifest, bytes);
        assert.equal(result.ok, false);
    }
});

test("a reviewed incoming deposit check has a separate source and no check-number semantics", async () => {
    const jpeg = await jpegBuffer();
    const sha256 = createHash("sha256").update(jpeg).digest("hex");
    const result = await preparePrivateBankImage(entry(sha256, jpeg.length, {
        kind: "DEPOSIT_CHECK", direction: "incoming", checkNumber: null,
    }), jpeg);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.row.source, "WTB_ONLINE_INCOMING");
    assert.equal(result.row.kind, "DEPOSIT_PHOTO");
    assert.equal(result.row.normalizedCheckNumber, null);
    assert.equal(result.storageMetadata.evidence_direction, "incoming");
    assert.match(result.row.sourceExternalId, /:image:[a-f0-9]{64}:front$/);
    assert.match(result.storagePath, /wtb-online-incoming\/\d+\/[a-f0-9]{64}\//);
});
