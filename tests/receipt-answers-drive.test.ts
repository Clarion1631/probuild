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

/**
 * The Chat thread the fixture's card went out in. An answer must name it: the
 * thread is the ONLY thing binding a memo to the card that asked for it (Codex
 * PR #443 gate round 33, finding 3).
 */
const CARD_THREAD = "spaces/x/threads/y";

/** A `displayDetails` blob that has been CARDED (see matchCardAssociation). */
const CARDED_DETAILS = JSON.stringify({
    amountCents: -12_345,
    cards: [{ n: 1, date: "2026-08-16", threadName: CARD_THREAD, messageName: "spaces/x/messages/z", requestId: "receipt-req-CJ-2026-08-16" }],
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

/** Advisory-lock calls recorded by pdfId, so a test can assert lock-before-check. */
let lockCalls: string[];
/** Every lock/read call, in order, so a test can assert lock-BEFORE-check per attempt. */
let callOrder: string[];
/**
 * Forced `updateMany` results, consumed in order. Empty means "use real CAS
 * semantics against `issues`" (see below) — set this to simulate a lost race
 * on a specific attempt regardless of what real CAS would have returned.
 */
let updateManyCounts: number[];

interface FakeIssueRow {
    id: string;
    version: number;
    displayDetails: string | null;
    clearedAt: Date | null;
}

/** The one shape the answers route needs from `prisma` — and from `tx`, since it's the same object. */
interface FakePrisma {
    reviewIssue: {
        findUnique: (args: { where: { targetType_targetKey?: { targetKey: string }; id?: string } }) => Promise<FakeIssueRow | null>;
        findMany: (args: { where: { targetKey?: { not?: string } } }) => Promise<Array<{ displayDetails: string | null }>>;
        updateMany: (args: { where: { id: string; version: number }; data: Record<string, unknown> }) => Promise<{ count: number }>;
    };
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<undefined>;
    $transaction: <T>(fn: (tx: FakePrisma) => Promise<T>) => Promise<T>;
}

const fakePrisma: FakePrisma = {
    reviewIssue: {
        findUnique: async ({ where }) => {
            const key = where.targetType_targetKey?.targetKey ?? where.id ?? "";
            return issues.get(key) ?? null;
        },
        // The reuse check's coarse pre-filter (Codex PR #443 gate, finding 3):
        // every OTHER issue, so it can be searched for the same pdf_id.
        findMany: async ({ where }) => {
            callOrder.push("findMany");
            const excluded = where.targetKey?.not;
            return [...issues.entries()]
                .filter(([key]) => key !== excluded)
                .map(([, row]) => ({ displayDetails: row.displayDetails }));
        },
        // REAL CAS against `issues`, not just a recorder — a `count: 0` on a
        // version mismatch (or a forced entry in `updateManyCounts`) and a
        // GENUINE mutation on success, so a later `findUnique`/`findMany` in
        // the SAME test — including from a second POST — actually observes
        // what an earlier attempt or an earlier request committed.
        updateMany: async ({ where, data }) => {
            writes.push(data);
            if (updateManyCounts.length > 0) return { count: updateManyCounts.shift()! };
            const row = [...issues.values()].find(r => r.id === where.id);
            if (!row || row.version !== where.version) return { count: 0 };
            if (typeof data.displayDetails === "string") row.displayDetails = data.displayDetails;
            row.version += 1;
            return { count: 1 };
        },
    },
    // The pdfId advisory lock (Codex round-2 gate, finding 1): a tagged
    // template call, same shape `tx.$executeRaw` gets in the real route.
    // Recorded so a test can assert it runs BEFORE the reuse check, on every
    // attempt — the fake takes no real lock, but the call itself is the point.
    $executeRaw: async (strings, ...values) => {
        lockCalls.push(String(values[0]));
        callOrder.push(`lock:${String(values[0])}`);
        return undefined;
    },
    // The route runs everything for one attempt inside ONE transaction; the
    // fake just hands the same object back as `tx` — the reviewIssue and
    // $executeRaw methods above already do the recording tests need.
    $transaction: async fn => fn(fakePrisma),
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
    lockCalls = [];
    callOrder = [];
    updateManyCounts = [];
    issues = new Map([["bl-1", { id: "ri-1", version: 3, displayDetails: CARDED_DETAILS, clearedAt: null }]]);
}

/**
 * `thread` defaults to the fixture's own card thread, because that is what a
 * real bridge answer carries — every one of these cases is otherwise about
 * something else, and spelling it out in twenty bodies would only obscure the
 * tests that ARE about the association. A case that cares passes its own
 * `thread` (or `thread: undefined` to send none at all).
 */
const post = (body: Record<string, unknown>) => POST(new Request(
    "https://probuild.test/api/automation/receipt-requests/answers",
    {
        method: "POST",
        headers: { "content-type": "application/json", "x-receipt-intake-secret": "bridge-secret" },
        body: JSON.stringify({ thread: CARD_THREAD, ...body }),
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
            cards: [{ n: 1, date: "2026-08-16", threadName: CARD_THREAD }],
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

// ── The reuse check is inside the pdfId lock, on EVERY attempt (Codex round-2 gate, finding 1) ──

test("the pdfId lock is taken BEFORE the reuse check, on BOTH attempts of a lost-race retry", async () => {
    reset();
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: null, mimeType: "application/pdf" };
    // Force attempt 0 to lose the optimistic-concurrency race so a real SECOND
    // attempt runs. The bug this closes: the reuse check used to be gated on
    // `attempt === 0`, so a losing first attempt's retry skipped it entirely.
    updateManyCounts = [0, 1];

    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 200);

    assert.deepEqual(lockCalls, [`memo-pdf:${FILE_ID}`, `memo-pdf:${FILE_ID}`], "the lock is taken on BOTH attempts, not just the first");

    const lockIndexes = callOrder.flatMap((tag, i) => (tag.startsWith("lock:") ? [i] : []));
    const checkIndexes = callOrder.flatMap((tag, i) => (tag === "findMany" ? [i] : []));
    assert.equal(lockIndexes.length, 2, "one lock per attempt");
    assert.equal(checkIndexes.length, 2, "one reuse check per attempt");
    assert.ok(lockIndexes[0] < checkIndexes[0], "attempt 0: lock precedes the reuse check");
    assert.ok(lockIndexes[1] < checkIndexes[1], "attempt 1: lock precedes the reuse check");
    // And the write only ever committed once — the first attempt's forced 0
    // never wrote anything real; only the second attempt's write survives.
    assert.equal(writes.length, 2, "both attempts reached the write step");
});

test("two requests signing the SAME pdf_id for DIFFERENT charges: the second observes the first's committed write", async () => {
    // Real interleaving (two overlapping requests) is what the pdfId lock
    // defends against; this drives it through two SEQUENTIAL POSTs against the
    // SAME fake-Prisma state, so the second request's reuse check reads
    // whatever the first request actually committed — not a pre-seeded
    // fixture standing in for it.
    reset();
    issues.set("bl-9", { id: "ri-9", version: 1, displayDetails: CARDED_DETAILS, clearedAt: null });
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: null, mimeType: "application/pdf" };

    const first = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, cleared: true, memoRecorded: true, targetKey: "bl-1" });
    assert.equal(issues.get("bl-1")!.displayDetails!.includes('"pdfId":"1sEISJBJaGRYpivooQJBR"'), true, "the fake actually persisted the first write");

    const second = await post({ fingerprint: "pb-bl-9", signed: true, pdf_id: FILE_ID });
    assert.equal(second.status, 409, "the second request's reuse check sees the first request's own write");
    const payload = await second.json() as { ok: boolean; reason: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "artifact-reused");
    // Only the FIRST request's resolution was ever written.
    assert.equal(writes.length, 1);
});

// ── The amount is matched EXACTLY, not by substring (Codex round-2 gate, finding 2) ──

test("a PDF named for a SUPERSET amount ($112.34) does not satisfy a $12.34 charge", async () => {
    // `name.includes("12.34")` used to let "...112.34..." through: the target
    // digits are a substring of a completely different dollar amount.
    reset();
    issues.set("bl-small", { id: "ri-small", version: 1, displayDetails: JSON.stringify({ amountCents: -1_234, cards: [{ n: 1, threadName: CARD_THREAD }] }), clearedAt: null });
    probeResult = {
        kind: "found",
        id: FILE_ID,
        name: "MissingReceiptAffidavit_2026-08-16_LOWES_112.34_CJ.pdf",
        trashed: false,
        webViewLink: null,
        mimeType: "application/pdf",
    };
    const res = await post({ fingerprint: "pb-bl-small", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as { reason: string }).reason, "artifact-mismatch");
    assert.deepEqual(writes, []);
});

test("a PDF named with an extra trailing digit ($12.345) does not satisfy a $12.34 charge", async () => {
    // The amount field's own shape is always two decimal places; a third
    // digit is not "close enough", it is a different, unparseable field.
    reset();
    issues.set("bl-small", { id: "ri-small", version: 1, displayDetails: JSON.stringify({ amountCents: -1_234, cards: [{ n: 1, threadName: CARD_THREAD }] }), clearedAt: null });
    probeResult = {
        kind: "found",
        id: FILE_ID,
        name: "MissingReceiptAffidavit_2026-08-16_LOWES_12.345_CJ.pdf",
        trashed: false,
        webViewLink: null,
        mimeType: "application/pdf",
    };
    const res = await post({ fingerprint: "pb-bl-small", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as { reason: string }).reason, "artifact-mismatch");
    assert.deepEqual(writes, []);
});

test("the EXACT amount field, and nothing else, satisfies the charge", async () => {
    reset();
    issues.set("bl-small", { id: "ri-small", version: 1, displayDetails: JSON.stringify({ amountCents: -1_234, cards: [{ n: 1, threadName: CARD_THREAD }] }), clearedAt: null });
    probeResult = {
        kind: "found",
        id: FILE_ID,
        name: "MissingReceiptAffidavit_2026-08-16_LOWES_12.34_CJ.pdf",
        trashed: false,
        webViewLink: null,
        mimeType: "application/pdf",
    };
    const res = await post({ fingerprint: "pb-bl-small", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(writes[0].displayDetails as string).resolution, "memo-signed");
});

// ── The memo must come from the card that ASKED (Codex PR #443 gate round 33, finding 3) ──

/** The probe answer for a real, well-named memo for bl-1's $123.45 charge. */
function foundMatchingMemo(): void {
    probeResult = { kind: "found", id: FILE_ID, name: MATCHING_NAME, trashed: false, webViewLink: null, mimeType: "application/pdf" };
}

test("a same-amount memo submitted from ANOTHER issue's thread is refused — 422 wrong-thread", async () => {
    // THE HOLE THIS CLOSES. Two charges for the same amount mint affidavits
    // with interchangeable filenames, so the amount check passes for both, and
    // "some card once listed this item" passes for any carded charge. A memo
    // minted for one charge, replayed against the other's fingerprint, closed a
    // chase nobody had answered. The thread was stored and never compared.
    reset();
    foundMatchingMemo();
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID, thread: "spaces/x/threads/SOMEONE-ELSE" });
    assert.equal(res.status, 422);
    const payload = await res.json() as { ok: boolean; reason: string; detail: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "wrong-thread");
    assert.match(payload.detail, /no card for this charge was posted in that thread/);
    assert.deepEqual(writes, [], "nothing is recorded for an unbound memo");
    assert.deepEqual(cleared, [], "and the chase stays open");
});

test("an answer carrying NO thread at all is refused too — fail-closed, never assumed", async () => {
    reset();
    foundMatchingMemo();
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID, thread: undefined });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as { reason: string }).reason, "wrong-thread");
    assert.deepEqual(writes, []);
});

test("the right thread but the wrong item number is refused — one card lists several charges", async () => {
    // The thread alone can be satisfied by a SIBLING item on the same card, so
    // when the bridge says which item it was, that has to agree as well.
    reset();
    foundMatchingMemo();
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID, n: 4 });
    assert.equal(res.status, 422);
    const payload = await res.json() as { reason: string; detail: string };
    assert.equal(payload.reason, "wrong-thread");
    assert.match(payload.detail, /under that number/);
    assert.deepEqual(writes, []);
});

test("an answer naming a DIFFERENT card request is refused", async () => {
    reset();
    foundMatchingMemo();
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID, request_id: "receipt-req-CJ-2026-07-01" });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as { reason: string }).reason, "wrong-thread");
});

test("the thread, n and request_id all agreeing is the happy path", async () => {
    reset();
    foundMatchingMemo();
    const res = await post({
        fingerprint: "pb-bl-1",
        signed: true,
        pdf_id: FILE_ID,
        thread: CARD_THREAD,
        n: 1,
        request_id: "receipt-req-CJ-2026-08-16",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cleared: true, memoRecorded: true, targetKey: "bl-1" });
    assert.equal(JSON.parse(writes[0].displayDetails as string).resolution, "memo-signed");
});

test("a CLEARED issue that never had a card is 422 not-requested — round 32's exemption is gone", async () => {
    // Round 32 read "already answered, no card record" as the card-history
    // race and let it through with a 200. The race was real and is fixed at
    // its source (recordCardOnIssues writes on cleared issues too), so the
    // exemption only meant that any already-closed charge accepted a memo
    // nobody had asked for.
    reset();
    issues.set("bl-closed", {
        id: "ri-closed",
        version: 1,
        displayDetails: JSON.stringify({ amountCents: -12_345 }),
        clearedAt: new Date("2026-08-20T00:00:00Z"),
    });
    foundMatchingMemo();
    const res = await post({ fingerprint: "pb-bl-closed", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as { reason: string }).reason, "not-requested");
    assert.deepEqual(writes, [], "a closed issue is not a free pass");
    assert.deepEqual(cleared, []);
});

test("a CLEARED issue WITH a matching card record still records the memo — 200, nothing re-cleared", async () => {
    // The invariant round 32 was protecting, kept: a memo signed after the
    // matcher auto-closed the line is still evidence, and `resolution` is what
    // suppresses a later reopen.
    reset();
    issues.set("bl-closed", {
        id: "ri-closed",
        version: 1,
        displayDetails: CARDED_DETAILS,
        clearedAt: new Date("2026-08-20T00:00:00Z"),
    });
    foundMatchingMemo();
    const res = await post({ fingerprint: "pb-bl-closed", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, alreadyCleared: true, memoRecorded: true, targetKey: "bl-closed" });
    assert.equal(JSON.parse(writes[0].displayDetails as string).resolution, "memo-signed");
    assert.deepEqual(cleared, [], "an already-closed issue is not cleared again");
});

test("re-submitting the same memo on the same issue answers 200 alreadyResolved", async () => {
    // The idempotency `alreadyResolved` now actually describes: the row
    // ALREADY carried a resolution before this write.
    reset();
    issues.set("bl-1", {
        id: "ri-1",
        version: 3,
        displayDetails: JSON.stringify({
            amountCents: -12_345,
            resolution: "memo-signed",
            pdfId: FILE_ID,
            cards: [{ n: 1, date: "2026-08-16", threadName: CARD_THREAD }],
        }),
        clearedAt: new Date("2026-08-20T00:00:00Z"),
    });
    foundMatchingMemo();
    const res = await post({ fingerprint: "pb-bl-1", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
        ok: true,
        alreadyCleared: true,
        alreadyResolved: true,
        memoRecorded: true,
        targetKey: "bl-1",
    });
});

test("the LEGACY single `card` slot is still a valid association", async () => {
    // Rows written before `cards[]` existed carry only `card`. Reading just the
    // array would refuse a reply in the one thread those rows know about.
    reset();
    issues.set("bl-legacy", {
        id: "ri-legacy",
        version: 1,
        displayDetails: JSON.stringify({
            amountCents: -12_345,
            card: { n: 1, date: "2026-08-16", threadName: CARD_THREAD, requestId: "receipt-req-CJ-2026-08-16" },
        }),
        clearedAt: null,
    });
    foundMatchingMemo();
    const res = await post({ fingerprint: "pb-bl-legacy", signed: true, pdf_id: FILE_ID });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(writes[0].displayDetails as string).resolution, "memo-signed");
});
