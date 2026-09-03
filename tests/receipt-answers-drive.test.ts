import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

/**
 * The answers route's three Drive outcomes, through the ROUTE.
 *
 * A signed memo closes a chase, so "the artifact exists" has to be answered by
 * Drive rather than by the shape of the string the forwarder sent. The three
 * answers are deliberately different: found records and clears, missing is
 * terminal (422 — re-sending will not conjure the file), unreachable is
 * retryable (503) because "we could not check" must never be recorded as "it
 * checked out".
 *
 * `@/lib/google-drive` and `@/lib/prisma` are replaced through the same scoped
 * CJS require() patch the rest of this repo uses — `mock.module` corrupts the
 * require chain on the Node 20 CI pins.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.RECEIPT_INTAKE_SECRET = "intake-secret";
process.env.RECEIPT_ARCHIVE_SECRET = "archive-secret";
process.env.RECEIPT_BRIDGE_SECRET = "bridge-secret";

const FILE_ID = "1sEISJBJaGRYpivooQJBR";

type Probe =
    | { kind: "found"; id: string; name: string | null; trashed: boolean; webViewLink: string | null; mimeType: string | null }
    | { kind: "missing"; reason: string }
    | { kind: "unreachable"; reason: string };

let probeResult: Probe;
let probedIds: string[];
/** Issue rows the fake Prisma serves, keyed by targetKey. */
let issues: Map<string, { id: string; version: number; displayDetails: string | null; clearedAt: Date | null }>;
let writes: Array<Record<string, unknown>>;
let cleared: string[];

const fakePrisma = {
    reviewIssue: {
        findUnique: async ({ where }: { where: { targetType_targetKey?: { targetKey: string }; id?: string } }) => {
            const key = where.targetType_targetKey?.targetKey ?? where.id ?? "";
            return issues.get(key) ?? null;
        },
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
            writes.push(data);
            return { count: 1 };
        },
    },
};

let POST: (request: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    let drivePatched = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/google-drive") {
            drivePatched = true;
            return {
                isDriveFileId: (value: unknown) =>
                    typeof value === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(value.trim()),
                probeDriveFile: async (fileId: string) => {
                    probedIds.push(fileId);
                    return probeResult;
                },
            };
        }
        if (id === "@/lib/prisma") return { prisma: fakePrisma };
        if (id === "@/lib/review-alert-lifecycle") {
            return { evaluateReviewIssue: async (_type: string, key: string) => { cleared.push(key); } };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { POST?: unknown };
    try {
        mod = await import("../src/app/api/automation/receipt-requests/answers/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.POST !== "function") {
        throw new Error(
            `answers route did not load; the require patch ${drivePatched ? "WAS" : "was NOT"} hit`,
        );
    }
    POST = mod.POST as typeof POST;
});

function reset() {
    probedIds = [];
    writes = [];
    cleared = [];
    issues = new Map([["bl-1", { id: "ri-1", version: 3, displayDetails: "{}", clearedAt: null }]]);
}

const post = (body: Record<string, unknown>) => POST(new Request(
    "https://probuild.test/api/automation/receipt-requests/answers",
    {
        method: "POST",
        headers: { "content-type": "application/json", "x-receipt-intake-secret": "bridge-secret" },
        body: JSON.stringify(body),
    },
));

test("a VALID artifact records the memo and clears the chase", async () => {
    reset();
    probeResult = {
        kind: "found",
        id: FILE_ID,
        name: "Missing receipt memo.pdf",
        trashed: false,
        webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
        mimeType: "application/pdf",
    };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cleared: true, memoRecorded: true, targetKey: "bl-1" });

    assert.deepEqual(probedIds, [FILE_ID], "the id was actually checked");
    assert.equal(writes.length, 1);
    const details = JSON.parse(writes[0].displayDetails as string);
    assert.equal(details.resolution, "memo-signed");
    assert.equal(details.pdfId, FILE_ID, "the durable identity is persisted");
    assert.equal(details.pdfUrl, `https://drive.google.com/file/d/${FILE_ID}/view`, "and Drive's own link");
    assert.deepEqual(cleared, ["bl-1"]);
});

test("a caller's own durable URL is kept, but the ID is still what was verified", async () => {
    reset();
    probeResult = { kind: "found", id: FILE_ID, name: null, trashed: false, webViewLink: null, mimeType: "application/pdf" };
    const pdfUrl = `https://drive.google.com/file/d/${FILE_ID}/view?usp=sharing`;
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID, pdf_url: pdfUrl });
    assert.equal(res.status, 200);
    const details = JSON.parse(writes[0].displayDetails as string);
    assert.equal(details.pdfUrl, pdfUrl);
    assert.equal(details.pdfId, FILE_ID);
});

test("a MISSING file is 422 — terminal, and nothing is written", async () => {
    reset();
    probeResult = { kind: "missing", reason: "http-404" };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 422, "re-sending the same body would fail the same way");
    const payload = await res.json() as { ok: boolean; reason: string; detail: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "artifact-missing");
    assert.equal(payload.detail, "http-404");
    assert.deepEqual(writes, [], "no resolution");
    assert.deepEqual(cleared, [], "and the chase stays open");
});

test("a TRASHED file is missing too — it disappears on its own", async () => {
    reset();
    probeResult = { kind: "missing", reason: "trashed" };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 422);
    assert.deepEqual(writes, []);
});

test("a Drive object that is NOT a PDF is refused — found is not enough", async () => {
    // Drive answering `found` only proves an object exists at that id, not
    // that it is the signed memo it claims to be. A folder, an image, or a
    // Doc all passed `found` before this check and got recorded as
    // `memo-signed` regardless.
    reset();
    probeResult = {
        kind: "found",
        id: FILE_ID,
        name: "not-a-memo.jpg",
        trashed: false,
        webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
        mimeType: "image/jpeg",
    };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 422);
    const payload = await res.json() as { ok: boolean; reason: string; detail: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "not-a-pdf");
    assert.equal(payload.detail, "image/jpeg");
    assert.deepEqual(writes, [], "no resolution recorded for a non-PDF artifact");
    assert.deepEqual(cleared, [], "and the chase stays open");
});

test("an UNREACHABLE Drive is 503 with retry — never a recorded resolution", async () => {
    reset();
    // A bad minute at Google.
    probeResult = { kind: "unreachable", reason: "backend error" };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 503);
    const payload = await res.json() as { ok: boolean; reason: string; retry: boolean };
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "artifact-unverifiable");
    assert.equal(payload.retry, true, "the forwarder must come back");
    assert.deepEqual(writes, [], "we could not check, so nothing is claimed");
    assert.deepEqual(cleared, []);
});

test("NO CREDENTIAL is named as such — it will not fix itself", async () => {
    // Distinct from a transient outage on purpose: it means this deployment
    // cannot verify ANY memo until somebody connects Drive, and the retries
    // would otherwise read as a bad minute at Google forever.
    reset();
    probeResult = { kind: "unreachable", reason: "no-drive-token" };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 503);
    const payload = await res.json() as { ok: boolean; reason: string; retry: boolean };
    assert.equal(payload.reason, "drive-not-configured");
    assert.equal(payload.retry, true);
    assert.deepEqual(writes, []);
    assert.deepEqual(cleared, []);
});

test("Drive is never asked about a body that cannot carry an artifact", async () => {
    reset();
    probeResult = { kind: "found", id: FILE_ID, name: null, trashed: false, webViewLink: null, mimeType: "application/pdf" };
    // Not a signature, an unknown fingerprint, and a malformed id: all decided
    // before any network call.
    assert.equal((await post({ fingerprint: "pb-bl-1", signed: false, pdf_id: FILE_ID })).status, 200);
    assert.equal((await post({ fingerprint: "bev-9", signed: true, pdf_id: FILE_ID })).status, 200);
    assert.equal((await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: "x" })).status, 422);
    assert.deepEqual(probedIds, [], "no Drive call on any of those paths");
});

test("a caller URL naming a DIFFERENT file is refused — the link must be the id we verified", async () => {
    // `pdf_id` is proved against Drive; `pdf_url` is not proved against
    // anything. Storing a durable-looking link that points somewhere else means
    // the row's identity and the link a human clicks a year later describe two
    // different documents — and only one of them was ever checked.
    reset();
    const probedLink = `https://drive.google.com/file/d/${FILE_ID}/view`;
    probeResult = { kind: "found", id: FILE_ID, name: null, trashed: false, webViewLink: probedLink, mimeType: "application/pdf" };
    const someoneElse = "1AAAAAAAAAAAAAAAAAAAA";
    const res = await post({
        fingerprint: "pb-bl-1",
        signed: true,
        pdf_id: FILE_ID,
        pdf_url: `https://drive.google.com/file/d/${someoneElse}/view`,
    });
    assert.equal(res.status, 200);
    const details = JSON.parse(writes[0].displayDetails as string);
    assert.equal(details.pdfId, FILE_ID);
    assert.equal(details.pdfUrl, probedLink, "the probed link, not the caller's");
});

test("a durable URL that names no file at all is refused too", async () => {
    // Supabase Storage and googleusercontent pass isDurableArtifactUrl, and
    // neither can prove anything about a Drive id. Durability is not identity.
    reset();
    const probedLink = `https://drive.google.com/file/d/${FILE_ID}/view`;
    probeResult = { kind: "found", id: FILE_ID, name: null, trashed: false, webViewLink: probedLink, mimeType: "application/pdf" };
    const res = await post({
        fingerprint: "pb-bl-1",
        signed: true,
        pdf_id: FILE_ID,
        pdf_url: "https://ghzdbzdnwjxazvmcefbh.supabase.co/storage/v1/object/public/memos/whatever.pdf",
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(writes[0].displayDetails as string).pdfUrl, probedLink);
});

test("an alternate Drive shape for the SAME id is still accepted", async () => {
    // The rule is identity, not string equality: /open?id=, /uc?id= and
    // /file/d/<id>/ all name the file, and refusing them would throw away a
    // perfectly good link the forwarder had.
    reset();
    probeResult = { kind: "found", id: FILE_ID, name: null, trashed: false, webViewLink: null, mimeType: "application/pdf" };
    for (const url of [
        `https://drive.google.com/open?id=${FILE_ID}`,
        `https://drive.google.com/uc?id=${FILE_ID}&export=download`,
        `https://docs.google.com/document/d/${FILE_ID}/edit`,
    ]) {
        writes = [];
        const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID, pdf_url: url });
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(writes[0].displayDetails as string).pdfUrl, url, url);
    }
});
