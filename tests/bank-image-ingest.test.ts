import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ingestPreparedBankImage, type BankImageRepository, type PrivateImageStorage, type StoredBankImage } from "@/lib/bank-image-ingest";
import type { PreparedPrivateBankImage } from "@/lib/bank-image-private";

const bytes = Buffer.from("verified-front");
const prepared: PreparedPrivateBankImage = {
    ok: true,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storageMetadata: { redaction_status: "passed", redacted_front_sha256: createHash("sha256").update(bytes).digest("hex") },
    storagePath: "bank-images/wtb-online/reference/front-redacted-a.jpg",
    secureRef: "secure:bank-images/wtb-online/reference/front-redacted-a.jpg",
    row: { kind: "CHECK_FRONT", source: "WTB_ONLINE", sourceExternalId: "reference:front", account: "WTB-0723", capturedAt: new Date("2026-08-13T18:40:00Z"), documentDate: new Date("2026-08-13T00:00:00Z"), fileName: "front.jpg", mime: "image/jpeg", byteSize: bytes.length, normalizedCheckNumber: "1027", amountCents: 603715 },
};

function row(overrides: Partial<StoredBankImage> = {}): StoredBankImage {
    return { id: "image", ...prepared.row, driveFileId: null, ...overrides };
}

function harness(initial: StoredBankImage | null, options: { createError?: Error; concurrent?: StoredBankImage | null; backfillWinner?: StoredBankImage | null; storedBytes?: Buffer | null } = {}) {
    let current = initial;
    const repository: BankImageRepository = {
        find: async () => current,
        backfill: async (_id, ref) => {
            if (options.backfillWinner) { current = options.backfillWinner; return false; }
            if (current?.driveFileId) return false;
            if (current) current.driveFileId = ref;
            return true;
        },
        create: async (created, ref) => {
            if (options.createError) {
                current = options.concurrent ?? current;
                throw options.createError;
            }
            current = row({ ...created, driveFileId: ref });
        },
    };
    const storage: PrivateImageStorage = { upload: async () => ({ error: false }), download: async () => options.storedBytes === undefined ? bytes : options.storedBytes };
    return { repository, storage, current: () => current };
}

test("creates once and replays an identical secure front", async () => {
    const first = harness(null);
    assert.equal((await ingestPreparedBankImage(prepared, bytes, first.repository, first.storage)).status, "created");
    const replay = harness(first.current());
    assert.equal((await ingestPreparedBankImage(prepared, bytes, replay.repository, replay.storage)).status, "existing");
});

test("refuses changed immutable metadata before storage upload", async () => {
    let uploaded = false;
    const repository = harness(row({ amountCents: 1 })).repository;
    const storage: PrivateImageStorage = { upload: async () => { uploaded = true; return { error: false }; }, download: async () => null };
    const result = await ingestPreparedBankImage(prepared, bytes, repository, storage);
    assert.equal(result.status, "rejected");
    assert.match(result.reason ?? "", /metadata conflicts/);
    assert.equal(uploaded, false);
});

test("concurrent create re-reads the winning identical secure row", async () => {
    const conflict = Object.assign(new Error("unique"), { code: "P2002" });
    const concurrent = row({ driveFileId: prepared.secureRef });
    const testHarness = harness(null, { createError: conflict, concurrent });
    assert.equal((await ingestPreparedBankImage(prepared, bytes, testHarness.repository, testHarness.storage)).status, "existing");
});

test("concurrent-create replay rejects a missing or corrupt private object", async () => {
    const conflict = Object.assign(new Error("unique"), { code: "P2002" });
    const concurrent = row({ driveFileId: prepared.secureRef });
    for (const storedBytes of [null, Buffer.from("corrupt")]) {
        const testHarness = harness(null, { createError: conflict, concurrent, storedBytes });
        assert.equal((await ingestPreparedBankImage(prepared, bytes, testHarness.repository, testHarness.storage)).status, "rejected");
    }
});

test("concurrent mismatch and ordinary DB failure retain only retry-safe storage", async () => {
    const conflict = Object.assign(new Error("unique"), { code: "P2002" });
    const mismatch = harness(null, { createError: conflict, concurrent: row({ driveFileId: "secure:other" }) });
    assert.equal((await ingestPreparedBankImage(prepared, bytes, mismatch.repository, mismatch.storage)).status, "rejected");
    const failed = harness(null, { createError: new Error("database unavailable") });
    const result = await ingestPreparedBankImage(prepared, bytes, failed.repository, failed.storage);
    assert.equal(result.status, "rejected");
    assert.match(result.reason ?? "", /retained for retry/);
});

test("backfill uses compare-and-set and rejects a different concurrent secure front", async () => {
    const winner = row({ driveFileId: "secure:other" });
    const testHarness = harness(row(), { backfillWinner: winner });
    const result = await ingestPreparedBankImage(prepared, bytes, testHarness.repository, testHarness.storage);
    assert.equal(result.status, "rejected");
});

test("existing secure metadata is rejected when private storage is missing or corrupt", async () => {
    for (const storedBytes of [null, Buffer.from("corrupt")]) {
        const testHarness = harness(row({ driveFileId: prepared.secureRef }), { storedBytes });
        assert.equal((await ingestPreparedBankImage(prepared, bytes, testHarness.repository, testHarness.storage)).status, "rejected");
    }
});
