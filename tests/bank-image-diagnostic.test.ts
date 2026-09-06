import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createBankImageDiagnosticHandler } from "../src/lib/bank-image-diagnostic";

const reference = "26225018006376";
const secret = "test-dedicated-key";
const base = {
    kind: "CHECK_FRONT", source: "WTB_ONLINE", sourceExternalId: `${reference}:front`,
    account: "WTB-0723", capturedAt: new Date("2026-08-19T10:12:41.451Z"),
    documentDate: new Date("2026-08-13T00:00:00Z"), fileName: "original.jpg",
    mime: "image/jpeg", byteSize: 174152, normalizedCheckNumber: "1027", amountCents: null,
    driveFileId: null as string | null,
};
const storagePath = `bank-images/wtb-online/${reference}/front-redacted-${"a".repeat(64)}.jpg`;
function request(query = `bankReference=${reference}`, headers: Record<string, string> = { "x-ingest-key": secret }, method = "GET") {
    return new Request(`https://example.test/api/integrations/bank-images/diagnostic?${query}`, { headers, method });
}
function harness(row: typeof base | null = base, configuredSecret: string | undefined = secret) {
    const reads: string[][] = [];
    const probes: string[] = [];
    const handler = createBankImageDiagnosticHandler({
        secret: () => configuredSecret,
        find: async (source, id) => { reads.push([source, id]); return row; },
        storagePresence: async (path) => { probes.push(path); return "present"; },
    });
    return { handler, reads, probes };
}

test("dedicated key is required before any metadata or storage read", async () => {
    const rejectedHeaders: Record<string, string>[] = [{}, { "x-ingest-key": "wrong" }, { authorization: `Bearer ${secret}` }];
    for (const headers of rejectedHeaders) {
        const h = harness();
        assert.equal((await h.handler(request(undefined, headers))).status, 401);
        assert.deepEqual(h.reads, []); assert.deepEqual(h.probes, []);
    }
    const h = harness(base, "");
    assert.equal((await h.handler(request())).status, 401);
    assert.deepEqual(h.reads, []);
});

test("only the incident's exact reference and one query parameter are allowed", async () => {
    for (const query of ["", "bankReference=26225018006377", "bankReference=../secret", `bankReference=${reference}&source=OTHER`, `bankReference=${reference}&bankReference=${reference}`, `bankReference=${reference}:front`]) {
        const h = harness();
        assert.equal((await h.handler(request(query))).status, 400, query);
        assert.deepEqual(h.reads, []); assert.deepEqual(h.probes, []);
    }
});

test("diagnostic rejects non-GET requests without reading", async () => {
    const h = harness();
    assert.equal((await h.handler(request(undefined, undefined, "POST"))).status, 405);
    assert.deepEqual(h.reads, []);
});

test("metadata comparison projection excludes links, extra fields and image bytes", async () => {
    const row = { ...base, driveFileId: "https://private.example/signed?token=secret", rawOcrText: "sensitive", id: "internal" };
    const h = harness(row);
    const res = await h.handler(request());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const body = await res.json();
    const { driveFileId: _omitted, ...expected } = base;
    assert.deepEqual(body.metadata, { ...expected, capturedAt: base.capturedAt.toISOString(), documentDate: base.documentDate.toISOString() });
    assert.deepEqual(body.storage, { referenceKind: "legacy", presence: "not_checked" });
    assert.deepEqual(h.reads, [["WTB_ONLINE", `${reference}:front`]]);
    assert.deepEqual(h.probes, []);
    assert.doesNotMatch(JSON.stringify(body), /token|private\.example|sensitive|internal|driveFileId/);
});

test("absent metadata is 404 and never probes storage", async () => {
    const h = harness(null);
    assert.equal((await h.handler(request())).status, 404);
    assert.deepEqual(h.probes, []);
});

test("only a private redacted path belonging to this reference may be probed", async () => {
    const h = harness({ ...base, driveFileId: `secure:${storagePath}` });
    const body = await (await h.handler(request())).json();
    assert.deepEqual(h.probes, [storagePath]);
    assert.deepEqual(body.storage, { referenceKind: "private", presence: "present" });
    assert.doesNotMatch(JSON.stringify(body), /secure:|front-redacted/);
    for (const ref of ["secure:signatures/contract.png", `secure:${storagePath}/../other`, `secure:${storagePath.replace(reference, "26225018006377")}`]) {
        const other = harness({ ...base, driveFileId: ref });
        assert.deepEqual((await (await other.handler(request())).json()).storage, { referenceKind: "invalid_private", presence: "not_checked" });
        assert.deepEqual(other.probes, []);
    }
});

test("metadata without a reference reports none; failures never leak backend errors", async () => {
    assert.deepEqual((await (await harness().handler(request())).json()).storage, { referenceKind: "none", presence: "not_checked" });
    const handler = createBankImageDiagnosticHandler({ secret: () => secret, find: async () => { throw Error("database secret"); }, storagePresence: async () => "present" });
    const res = await handler(request());
    assert.equal(res.status, 503);
    assert.doesNotMatch(await res.text(), /database secret/);
});

test("storage outages remain unknown instead of being labeled missing", async () => {
    for (const presence of ["present", "missing", "unavailable"] as const) {
        const handler = createBankImageDiagnosticHandler({
            secret: () => secret, find: async () => ({ ...base, driveFileId: `secure:${storagePath}` }),
            storagePresence: async () => presence,
        });
        assert.equal((await (await handler(request())).json()).storage.presence, presence);
    }
    const handler = createBankImageDiagnosticHandler({
        secret: () => secret, find: async () => ({ ...base, driveFileId: `secure:${storagePath}` }),
        storagePresence: async () => { throw Error("private service URL with secret"); },
    });
    const res = await handler(request());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.storage.presence, "unavailable");
    assert.doesNotMatch(JSON.stringify(body), /service URL|secret/);
});

test("production route exposes only GET and wires only a unique metadata read plus storage info", () => {
    const src = readFileSync("src/app/api/integrations/bank-images/diagnostic/route.ts", "utf8");
    assert.match(src, /export const GET = createBankImageDiagnosticHandler/);
    assert.match(src, /bankImage\.findUnique/);
    assert.match(src, /\.info\(path\)/);
    assert.doesNotMatch(src, /\.(create|update|delete|upsert|upload|download|getPublicUrl|createSignedUrl|findMany)\s*\(/);
    assert.doesNotMatch(src, /export (?:async function|const) (?:POST|PUT|PATCH|DELETE)/);
});
