import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createBankImage1027RepairHandler, verifyRepairStorage, LEGACY_1027, REPLACEMENT_1027, type RepairSnapshot, type RepairTransaction } from "../src/lib/bank-image-1027-repair";

const key = "local-test-dedicated-key";
const bytes = Buffer.from("test-front");
function snapshot(): RepairSnapshot {
    return { row: { id: "image", ...LEGACY_1027, capturedAt: "2026-08-19T10:12:41.451+00:00", createdAt: "2026-08-19T10:12:42.123456+00:00", updatedAt: "2026-08-28T20:45:46.494+00:00", payerName: "GOLDEN TOUCH RMEODELING LLC", memoText: "HOPPE VANITY CONTRACT 4152", extractedAt: "2026-08-22T08:13:57.755670+00:00", extractionModel: "gemini-3-flash-preview" }, capturedAtExact: "2026-08-19T10:12:41.451000Z", updatedAtExact: "2026-08-28T20:45:46.494000Z", extractedAtExact: "2026-08-22T08:13:57.755670Z", matchCount: 0 };
}
function prepared() {
    return { ok: true as const, row: { ...REPLACEMENT_1027, kind: "CHECK_FRONT" as const, capturedAt: new Date(REPLACEMENT_1027.capturedAt), documentDate: new Date(REPLACEMENT_1027.documentDate) }, sha256: "c6c6b519a214b8d82a2619ca694465fd9813e0fe521751e87feedf6fe2695432", storagePath: "bank-images/wtb-online/26225018006376/front-redacted-c6c6b519a214b8d82a2619ca694465fd9813e0fe521751e87feedf6fe2695432.jpg", secureRef: "secure:bank-images/wtb-online/26225018006376/front-redacted-c6c6b519a214b8d82a2619ca694465fd9813e0fe521751e87feedf6fe2695432.jpg", storageMetadata: { redaction_source_sha256: "591feb1fcbed8ac9d0611935b18d5a7e9538a42029a2e94dad3e06e6a560553b", redaction_status: "passed" } };
}
function harness(candidate = prepared(), storageFailure = false) {
    let current = snapshot(); let writes = 0; let uploads = 0; let audits: unknown[] = []; let failAudit = false;
    const handler = createBankImage1027RepairHandler({
        secret: () => key, prepare: async () => candidate,
        transaction: async (run) => {
            let staged = structuredClone(current); const pending: unknown[] = [];
            const tx: RepairTransaction = {
                lock: async () => structuredClone(staged),
                replace: async (_before, next) => { writes++; staged.row = { ...staged.row, ...next, capturedAt: next.capturedAt.toISOString(), documentDate: next.documentDate?.toISOString().slice(0,10) ?? null, driveFileId: prepared().secureRef }; return structuredClone(staged.row); },
                audit: async (value) => { if (failAudit) throw Error("audit failed"); pending.push(value); },
            };
            const result = await run(tx); current = staged; audits.push(...pending); return result;
        },
        verifyStorage: async () => { uploads++; if (storageFailure) throw Error("storage unavailable"); },
    });
    const request = (mode: string, token?: string, suppliedKey = key) => handler(new Request("https://example.test/api/integrations/bank-images/repair-1027", { method: "POST", headers: { "x-ingest-key": suppliedKey }, body: JSON.stringify({ mode, preflightToken: token, item: { imageBase64: bytes.toString("base64") } }) }));
    return { request, current: () => current, mutate: (fn: (s: RepairSnapshot) => void) => fn(current), counts: () => ({ writes, uploads, audits: audits.length }), audits: () => audits, failAudit: () => { failAudit = true; } };
}

test("dedicated auth and explicit dry-run/commit mode fail closed", async () => {
    const h = harness();
    assert.equal((await h.request("commit", undefined, "wrong")).status, 401);
    assert.equal((await h.request("unknown")).status, 400);
    assert.deepEqual(h.counts(), { writes: 0, uploads: 0, audits: 0 });
});
test("dry-run emits before comparison and token with zero writes or uploads", async () => {
    const h = harness(); const res = await h.request("dry-run"); const body = await res.json();
    assert.equal(res.status, 200); assert.equal(body.status, "ready");
    assert.match(body.preflightToken, /^[a-f0-9]{64}$/);
    assert.equal(body.before.capturedAtExact, "2026-08-19T10:12:41.451000Z");
    assert.equal(body.before.extractedAtExact, "2026-08-22T08:13:57.755670Z");
    assert.equal(body.before.payerName, "GOLDEN TOUCH RMEODELING LLC");
    assert.deepEqual(h.counts(), { writes: 0, uploads: 0, audits: 0 });
});
test("commit requires the unchanged preflight snapshot including microseconds", async () => {
    const h = harness(); const token = (await (await h.request("dry-run")).json()).preflightToken;
    assert.equal((await h.request("commit")).status, 409);
    h.mutate(s => { s.row.updatedAt = "2026-08-19T10:12:42.123457+00:00"; });
    assert.equal((await h.request("commit", token)).status, 409);
    assert.deepEqual(h.counts(), { writes: 0, uploads: 0, audits: 0 });
});
test("refuses any legacy fingerprint, match, link or extraction change", async () => {
    const mutations: ((s: RepairSnapshot) => void)[] = [
        s => { s.row.amountCents = 603715; }, s => { s.row.fileName = "other.jpg"; },
        s => { s.capturedAtExact = "2026-08-19T10:12:41.451124Z"; },
        s => { s.extractedAtExact = "2026-08-22T08:13:57.755671Z"; },
        s => { s.updatedAtExact = "2026-08-28T20:45:46.494001Z"; },
        s => { s.extractedAtExact = null; }, s => { s.matchCount = 1; }, s => { s.row.driveFileId = "legacy-link"; },
        ...["payerName", "memoText", "extractionModel"].map(field => (s: RepairSnapshot) => { s.row[field] = "present"; }),
    ];
    for (const mutate of mutations) { const h = harness(); h.mutate(mutate); assert.equal((await h.request("dry-run")).status, 409); assert.deepEqual(h.counts(), { writes: 0, uploads: 0, audits: 0 }); }
});
test("commit audits complete before/after with machine identity and preserves unrelated fields", async () => {
    const h = harness(); const before = structuredClone(h.current().row);
    const token = (await (await h.request("dry-run")).json()).preflightToken;
    assert.equal((await h.request("commit", token)).status, 200);
    assert.deepEqual(h.counts(), { writes: 1, uploads: 1, audits: 1 });
    const audit = h.audits()[0] as any;
    assert.deepEqual(audit.before, before); assert.deepEqual(audit.after, h.current().row);
    assert.equal(audit.credentialLabel, "BANK_IMAGE_INGEST_SECRET");
    assert.equal(h.current().row.createdAt, before.createdAt);
    for (const field of ["payerName", "memoText", "extractedAt", "extractionModel"]) assert.equal(h.current().row[field], before[field]);
    assert.equal((await h.request("commit", token)).status, 409);
});
test("audit failure rolls back metadata and leaves only the verified retry-safe object", async () => {
    const h = harness(); const before = structuredClone(h.current());
    const token = (await (await h.request("dry-run")).json()).preflightToken; h.failAudit();
    assert.equal((await h.request("commit", token)).status, 503);
    assert.deepEqual(h.current(), before); assert.equal(h.audits().length, 0);
});
test("private storage must read back the exact hash even after successful upload", async () => {
    const p = { ...prepared(), sha256: createHash("sha256").update(bytes).digest("hex") };
    for (const stored of [null, Buffer.from("wrong")]) {
        await assert.rejects(verifyRepairStorage(p, bytes, { upload: async () => ({ error: false }), download: async () => stored }));
    }
    await verifyRepairStorage(p, bytes, { upload: async () => ({ error: true }), download: async () => bytes });
});
test("another reference or redacted hash cannot use the incident repair", async () => {
    for (const p of [{ ...prepared(), sha256: "b".repeat(64) }, { ...prepared(), row: { ...prepared().row, sourceExternalId: "other:front" } }]) {
        const h = harness(p); assert.equal((await h.request("dry-run")).status, 400);
        assert.deepEqual(h.counts(), { writes: 0, uploads: 0, audits: 0 });
    }
});
test("failed storage verification never writes metadata or audit", async () => {
    const h = harness(prepared(), true); const token = (await (await h.request("dry-run")).json()).preflightToken;
    assert.equal((await h.request("commit", token)).status, 503);
    assert.deepEqual(h.counts(), { writes: 0, uploads: 1, audits: 0 });
});
test("transaction adapter holds FOR UPDATE, compares raw JSON, and does not touch ledger or matches", () => {
    const src = readFileSync("src/lib/bank-image-1027-repair-db.ts", "utf8");
    assert.match(src, /FOR UPDATE/); assert.match(src, /to_jsonb/);
    assert.match(src, /auditLog\.create/); assert.match(src, /actorId: null/);
    assert.doesNotMatch(src, /bankImageMatch\.(create|update|delete)|bankLine\.|quickbooks|\$executeRawUnsafe/);
});
