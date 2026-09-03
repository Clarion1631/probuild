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

/**
 * The affidavit generator's naming contract (MissingReceiptAffidavit_<date>_
 * <vendor>_<amount>_<name>.pdf) applied to the default fixture's own amount
 * (-12345 cents = "123.45"), so the happy-path tests carry a name the answers
 * route's binding checks actually accept.
 */
const MATCHING_NAME = "MissingReceiptAffidavit_2026-08-16_LOWES_123.45_CJ.pdf";

/** A `displayDetails` blob that has been CARDED (see hasRecordedMemoRequest). */
const CARDED_DETAILS = JSON.stringify({
    amountCents: -12_345,
    cards: [{ n: 1, date: "2026-08-16", threadName: "spaces/x/threads/y", messageName: "spaces/x/messages/z", requestId: "receipt-req-CJ-2026-08-16" }],
});

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
        // The reuse check's coarse pre-filter (Codex PR #443 gate, finding 3):
        // every OTHER issue, so it can be searched for the same pdf_id.
        findMany: async ({ where }: { where: { targetKey?: { not?: string } } }) => {
            const excluded = where.targetKey?.not;
            return [...issues.entries()]
                .filter(([key]) => key !== excluded)
                .map(([, row]) => ({ displayDetails: row.displayDetails }));
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
    issues = new Map([["bl-1", { id: "ri-1", version: 3, displayDetails: CARDED_DETAILS, clearedAt: null }]]);
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
        name: MATCHING_NAME,
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
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: null, mimeType: "application/pdf" };
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

test("a KNOWN target with no verifiable artifact is still 422 missing-artifact", async () => {
    // These cases lived in tests/receipt-requests-bridge.test.ts, asserting the
    // route "never reaches Prisma on this path" — true before the unknown-
    // target check moved earlier (Codex PR #443 gate). Now ANY signed "pb-"
    // fingerprint touches Prisma once to learn whether the target exists; a
    // KNOWN target (bl-1, seeded by reset()) still gets exactly this 422 for
    // every one of these malformed artifacts, re-sending would fail the same
    // way each time.
    reset();
    for (const [label, body] of [
        ["no artifact at all", { fingerprint: "pb-bl-1", signed: true }],
        ["the gate's own example", { fingerprint: "pb-bl-1", signed: true, pdf_id: "x" }],
        ["a URL where the id goes", { fingerprint: "pb-bl-1", signed: true, pdf_id: "https://drive.google.com/file/d/1abc/view" }],
        ["a URL and no id", { fingerprint: "pb-bl-1", signed: true, pdf_url: "https://drive.google.com/file/d/1abc/view" }],
        ["a signature id, which is no longer accepted", { fingerprint: "pb-bl-1", signed: true, signature_id: "sig-123" }],
    ] as const) {
        writes = [];
        const res = await post(body);
        assert.equal(res.status, 422, label);
        const payload = await res.json() as { ok: boolean; reason: string; targetKey: string };
        assert.equal(payload.ok, false, label);
        assert.equal(payload.reason, "missing-artifact", label);
        assert.equal(payload.targetKey, "bl-1", label);
        assert.deepEqual(writes, [], label);
    }
    assert.deepEqual(probedIds, [], "none of these pdf_id shapes ever reach Drive");
});

test("an unknown target is ignored BEFORE pdf_id is even required — CI e2e round", async () => {
    // A fingerprint shaped like ours but naming a line with no ReviewIssue at
    // all (deleted, or never opened) used to hit the pdf_id/Drive checks
    // first and come back 422 "missing-artifact" for a body that was never
    // going to resolve anything — teaching the forwarder to retry with a
    // "more complete" body that cannot exist. e2e/receipt-requests.spec.ts
    // posts exactly this shape (no pdf_id at all) and expects a soft ignore.
    reset();
    const res = await post({ fingerprint: "pb-no-such-bank-line", signed: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: true, reason: "unknown-target" });
    assert.deepEqual(probedIds, [], "Drive is never asked about a target that does not exist");
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
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: probedLink, mimeType: "application/pdf" };
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
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: probedLink, mimeType: "application/pdf" };
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
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: null, mimeType: "application/pdf" };
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

// ── The artifact must be BOUND to the issue it resolves (Codex PR #443 gate, finding 3) ──

test("a PDF whose name doesn't carry this charge's amount is refused — 422 artifact-mismatch", async () => {
    reset();
    probeResult = {
        kind: "found",
        id: FILE_ID,
        // Real prefix, real .pdf, but a DIFFERENT amount than bl-1's $123.45.
        name: "MissingReceiptAffidavit_2026-08-01_SOMEONE_999.99_CJ.pdf",
        trashed: false,
        webViewLink: null,
        mimeType: "application/pdf",
    };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 422);
    const payload = await res.json() as { ok: boolean; reason: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "artifact-mismatch");
    assert.deepEqual(writes, [], "no resolution for an unbound PDF");
    assert.deepEqual(cleared, []);
});

test("an unrelated PDF that never went through the sign flow at all is refused the same way", async () => {
    reset();
    probeResult = { kind: "found", id: FILE_ID, name: "quarterly-report.pdf", trashed: false, webViewLink: null, mimeType: "application/pdf" };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as { reason: string }).reason, "artifact-mismatch");
});

test("a charge that was never carded cannot be closed by a signature — 422 not-requested", async () => {
    // No card ever offered "sign N" for this item, so a signature could not
    // have come from anything WE sent.
    reset();
    issues.set("bl-2", { id: "ri-2", version: 1, displayDetails: JSON.stringify({ amountCents: -12_345 }), clearedAt: null });
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: null, mimeType: "application/pdf" };
    const res = await post({ fingerprint: "pb-bl-2", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 422);
    const payload = await res.json() as { ok: boolean; reason: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "not-requested");
    assert.deepEqual(writes, []);
    assert.deepEqual(cleared, []);
});

test("the same Drive file already recorded on a DIFFERENT charge is refused — 409 artifact-reused", async () => {
    reset();
    // bl-9 already carries this exact pdf_id as its recorded memo-signed evidence.
    issues.set("bl-9", {
        id: "ri-9",
        version: 1,
        displayDetails: JSON.stringify({ amountCents: -5_000, resolution: "memo-signed", pdfId: FILE_ID }),
        clearedAt: null,
    });
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: null, mimeType: "application/pdf" };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 409);
    const payload = await res.json() as { ok: boolean; reason: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "artifact-reused");
    assert.deepEqual(writes, [], "the second charge gets no resolution from a spent memo");
    assert.deepEqual(cleared, []);
});

test("re-answering the SAME issue with the SAME pdf_id is not a reuse conflict", async () => {
    // The forwarder retries; this is idempotency, not two charges sharing one memo.
    reset();
    issues.set("bl-1", {
        id: "ri-1",
        version: 3,
        displayDetails: JSON.stringify({
            amountCents: -12_345,
            resolution: "memo-signed",
            pdfId: FILE_ID,
            cards: [{ n: 1, date: "2026-08-16" }],
        }),
        clearedAt: null,
    });
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: null, mimeType: "application/pdf" };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 200);
});

test("matching name, carded, and not reused → memo-signed, exactly the happy path", async () => {
    reset();
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: null, mimeType: "application/pdf" };
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cleared: true, memoRecorded: true, targetKey: "bl-1" });
    assert.equal(JSON.parse(writes[0].displayDetails as string).resolution, "memo-signed");
});
