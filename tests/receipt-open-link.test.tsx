/**
 * "Open receipt" on /automation?tab=receipts: that it works, what it costs,
 * and what it can never do to the page around it.
 *
 * It must open. Every row carries a RAW object path into the intake feature's
 * own PRIVATE bucket. Handed to resolveDocUrl that is not a reference it can
 * read, so it falls through to the legacy branch and comes back as a PUBLIC
 * project-files URL: the wrong bucket, and a 404 on every group of the tab
 * (#443).
 *
 * It must not cost a round trip per row. This page draws up to five groups of
 * RECEIPT_GROUP_TAKE rows and is force-dynamic, so signing row by row is five
 * hundred requests and five hundred Supabase clients on every load.
 *
 * And it must not be able to hang the queue. Batches go out together under one
 * render budget, because a bookkeeper opening this page wants to see what is
 * waiting, not wait on storage to mint links they may never click.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
    ReceiptsTab,
    RECEIPT_LINK_SIGN_BUDGET_MS,
    type ReceiptBatchSigner,
} from "../src/app/automation/components/receipts/receipts-tab";
import type { ReceiptFilters } from "../src/app/automation/receipts-filters";
import type { IntakeRow, ReceiptQueue } from "../src/app/automation/receipts-data";
import { RECEIPT_URL_TTL_SECONDS } from "../src/lib/receipt-intake/receipt-url";
import {
    RECEIPT_BUCKET,
    RECEIPT_SIGN_CHUNK_SIZE,
    SIGN_FAULT_TAGS,
    signReceiptDownloadUrls,
    type BucketBatchSigner,
} from "../src/lib/receipt-intake/bucket";
import { remainingBudgetMs, type RouteDeadline } from "../src/lib/quickbooks";
import { createStorageMockClient } from "../src/lib/supabase-storage-mock";

// The hermetic storage stub, through the same gate e2e uses: the tests that
// exercise the REAL signer make no network call and need no credentials.
process.env.E2E_STORAGE_MOCK = "1";
process.env.PLAYWRIGHT_TEST_SECRET = "receipt-open-link-test";
delete process.env.VERCEL;

const ALL_GROUPS: ReceiptFilters = { group: null, projectId: null, owner: null };
const PATH_A = "receipts/intake/8f1c2d3e-aaaa-4c7d-8e9f-0a1b2c3d4e5f.pdf";
const PATH_B = "receipts/intake/8f1c2d3e-bbbb-4c7d-8e9f-0a1b2c3d4e5f.jpg";
const PATH_C = "receipts/intake/8f1c2d3e-cccc-4c7d-8e9f-0a1b2c3d4e5f.png";
const PATH_D = "receipts/intake/8f1c2d3e-dddd-4c7d-8e9f-0a1b2c3d4e5f.pdf";
const PATH_E = "receipts/intake/8f1c2d3e-eeee-4c7d-8e9f-0a1b2c3d4e5f.heic";

const signedUrlFor = (path: string) =>
    `https://storage.test/storage/v1/object/sign/${RECEIPT_BUCKET}/${path}?token=fake-token`;

function row(id: string, storagePath: string): IntakeRow {
    return {
        id, state: "NEEDS_JOB", stateReason: null, source: "email",
        projectId: null, projectName: null, costCodeId: null,
        vendor: `Vendor ${id}`, txnDate: "2026-09-01", totalCents: 4_200,
        fileName: `${id}.pdf`, storagePath, duplicateOfId: null,
        qbPurchaseId: null, postVoidQbPurchaseId: null,
        attempts: 0, lastError: null, nextRetryAt: null, bookedAt: null,
        createdAt: "2026-09-01T12:00:00.000Z", updatedAt: "2026-09-01T12:00:00.000Z",
    };
}

function queueOf(groups: Partial<Pick<ReceiptQueue, "needsJob" | "needsReview" | "booking" | "bookedToday" | "duplicates">>): ReceiptQueue {
    const filled = { needsJob: [], needsReview: [], booking: [], bookedToday: [], duplicates: [], ...groups };
    return {
        ...filled,
        exceptions: [], uncertainCards: [], missingReceipts: [],
        counts: {
            needsJob: filled.needsJob.length, needsReview: filled.needsReview.length,
            booking: filled.booking.length, bookedToday: filled.bookedToday.length,
            duplicates: filled.duplicates.length,
            exceptions: 0, uncertainCards: 0, missingReceipts: 0, missingReceiptsShown: 0,
        },
    };
}

/** Records every batch the tab asks for, so the ASK itself can be asserted. */
function recordingSigner(urlFor: (path: string) => string | null = signedUrlFor) {
    const calls: Array<{ paths: string[]; ttl: number; deadline: RouteDeadline | undefined }> = [];
    const sign: ReceiptBatchSigner = async (paths, ttl, deadline) => {
        calls.push({ paths: [...paths], ttl, deadline });
        const signed = new Map<string, string>();
        for (const path of paths) {
            const url = urlFor(path);
            if (url) signed.set(path, url);
        }
        return signed;
    };
    return { calls, sign };
}

const renderTab = async (queue: ReceiptQueue, filters: ReceiptFilters, sign?: ReceiptBatchSigner) =>
    renderToStaticMarkup(await ReceiptsTab({
        queue, filters, jobs: [], filterHref: () => "/automation?tab=receipts", nativeActive: false, sign,
    }));

/** The anchor text, arrow and all. "Open receipt requests" is a StatCard subtitle, not a link. */
const linkCount = (html: string) => (html.match(/Open receipt ↗/g) ?? []).length;

async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
    try {
        return { result: await run(), warnings };
    } finally {
        console.warn = original;
    }
}

// ── The page render: ONE ask, for the rows it will actually draw ───────────

test("a whole page of rows is signed in ONE call, on the raw paths, deduped", async () => {
    const { calls, sign } = recordingSigner();
    // Every group that carries an object, including the duplicate parked
    // against a row it shares an object with. Asking twice for the same path is
    // a wasted slot in the chunk.
    const queue = queueOf({
        needsJob: [row("a", PATH_A), row("b", PATH_B)],
        needsReview: [row("r", PATH_D)],
        booking: [row("c", PATH_C)],
        bookedToday: [row("t", PATH_E)],
        duplicates: [row("d", PATH_A)],
    });

    const html = await renderTab(queue, ALL_GROUPS, sign);

    assert.equal(calls.length, 1, "one render is one round trip, not one per row");
    assert.deepEqual(calls[0].paths, [PATH_A, PATH_B, PATH_D, PATH_C, PATH_E], "the raw paths, deduped, in render order");
    assert.equal(calls[0].ttl, RECEIPT_URL_TTL_SECONDS, "the short TTL every other reader uses");
    assert.equal(linkCount(html), 6, "all six rows link, including the two sharing an object");
});

test("the render hands the signer ONE budget for the whole page", async () => {
    let seen: RouteDeadline | undefined;
    let asked = false;
    const sign: ReceiptBatchSigner = async (_paths, _ttl, deadline) => {
        asked = true;
        seen = deadline;
        return new Map();
    };

    await renderTab(queueOf({ needsJob: [row("a", PATH_A)] }), ALL_GROUPS, sign);

    assert.ok(asked, "the signer ran");
    assert.ok(seen, "an unbudgeted signing step is a page that can hang on storage");
    assert.equal(seen?.budgetMs, RECEIPT_LINK_SIGN_BUDGET_MS);
    const left = remainingBudgetMs(seen);
    assert.ok(left > 0 && left <= RECEIPT_LINK_SIGN_BUDGET_MS, `saw ${left}ms of budget`);
});

test("a filtered view never pays to sign the groups it is hiding", async () => {
    const { calls, sign } = recordingSigner();
    const queue = queueOf({
        needsJob: [row("a", PATH_A)],
        booking: [row("c", PATH_C)],
    });

    const html = await renderTab(queue, { ...ALL_GROUPS, group: "booking" }, sign);

    assert.deepEqual(calls[0].paths, [PATH_C], "only the group on screen");
    assert.equal(linkCount(html), 1);
    assert.ok(!html.includes(PATH_A), "the hidden group's object is not even named");
});

test("nothing to draw asks storage nothing at all", async () => {
    const { calls, sign } = recordingSigner();
    const html = await renderTab(queueOf({}), ALL_GROUPS, sign);
    assert.deepEqual(calls, [], "an empty queue is not a storage question");
    assert.equal(linkCount(html), 0);
});

test("the rendered hrefs are the signed URLs, and never the public bucket", async () => {
    const { sign } = recordingSigner();
    const queue = queueOf({ needsJob: [row("a", PATH_A)], bookedToday: [row("b", PATH_B)] });

    const html = await renderTab(queue, ALL_GROUPS, sign);

    for (const path of [PATH_A, PATH_B]) {
        assert.ok(html.includes(`href="${signedUrlFor(path)}"`), `${path} is linked by its signed URL`);
    }
    assert.match(html, /rel="noopener noreferrer"/);
    // The bug, stated as the browser would see it.
    assert.doesNotMatch(html, /project-files/, "a public project-files URL is the wrong bucket and a 404");
    assert.doesNotMatch(html, /\/object\/public\//);
});

test("a row whose object did not sign shows no link, and its siblings still do", async () => {
    const { sign } = recordingSigner(path => (path === PATH_B ? null : signedUrlFor(path)));
    const queue = queueOf({ needsJob: [row("a", PATH_A), row("b", PATH_B), row("c", PATH_C)] });

    const html = await renderTab(queue, ALL_GROUPS, sign);

    assert.equal(linkCount(html), 2, "one row loses its link, not the tab");
    assert.ok(html.includes("Vendor b"), "and the row itself is still on screen, actionable");
    assert.ok(!html.includes(signedUrlFor(PATH_B)));
});

test("no answer from storage renders a linkless queue rather than an error", async () => {
    const queue = queueOf({ needsJob: [row("a", PATH_A)], booking: [row("c", PATH_C)] });

    const empty = await renderTab(queue, ALL_GROUPS, async () => new Map<string, string>());
    assert.equal(linkCount(empty), 0);
    assert.ok(empty.includes("Vendor a") && empty.includes("Vendor c"), "every row still renders");

    const thrown = await renderTab(queue, ALL_GROUPS, async () => { throw new Error("storage is down"); });
    assert.equal(linkCount(thrown), 0, "a signing outage is not a page outage");
    assert.ok(thrown.includes("Vendor a"));
});

// ── The batch signer itself, against the storage boundary ──────────────────

type BatchResponse = Awaited<ReturnType<BucketBatchSigner["createSignedUrls"]>>;

/** A stand-in for the bucket's plural call that records what it was asked. */
function recordingBucket(answer: (paths: string[]) => BatchResponse) {
    const calls: Array<{ paths: string[]; ttl: number }> = [];
    return {
        calls,
        signer: {
            createSignedUrls: async (paths: string[], ttl: number) => {
                calls.push({ paths: [...paths], ttl });
                return answer(paths);
            },
        } satisfies BucketBatchSigner,
    };
}

const allSigned = (paths: string[]): BatchResponse => ({
    data: paths.map(path => ({ path, signedUrl: signedUrlFor(path), error: null })),
    error: null,
});

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Drain the microtask queue without inventing a duration to wait for. */
const settle = () => new Promise<void>(resolve => { setImmediate(resolve); });

test("the batch signer chunks, and asks for the RAW paths at the given TTL", async () => {
    assert.equal(RECEIPT_SIGN_CHUNK_SIZE, 100);
    const paths = Array.from({ length: 250 }, (_unused, index) => `receipts/intake/p-${index}.pdf`);
    const { calls, signer } = recordingBucket(allSigned);

    const signed = await signReceiptDownloadUrls(paths, RECEIPT_URL_TTL_SECONDS, undefined, signer);

    assert.deepEqual(calls.map(call => call.paths.length), [100, 100, 50], "250 paths is three requests, not 250");
    assert.deepEqual(calls.flatMap(call => call.paths), paths, "every path, unchanged, in order");
    assert.deepEqual(new Set(calls.map(call => call.ttl)), new Set([RECEIPT_URL_TTL_SECONDS]));
    assert.equal(signed.size, 250);
    assert.equal(signed.get(paths[0]), signedUrlFor(paths[0]));
});

test("the chunks go out TOGETHER, and answers may come back in any order", async () => {
    const paths = Array.from({ length: 250 }, (_unused, index) => `receipts/intake/c-${index}.pdf`);
    const gates: Array<{ paths: string[]; gate: Deferred<BatchResponse> }> = [];
    const signer: BucketBatchSigner = {
        createSignedUrls: async chunk => {
            const gate = deferred<BatchResponse>();
            gates.push({ paths: [...chunk], gate });
            return gate.promise;
        },
    };

    const pending = signReceiptDownloadUrls(paths, RECEIPT_URL_TTL_SECONDS, undefined, signer);
    await settle();

    // In series this would be stuck on the first request, and a degraded
    // storage day would cost the render the SUM of the chunks' timeouts.
    assert.equal(gates.length, 3, "all three requests are in flight before any has answered");

    for (const index of [2, 0, 1]) gates[index].gate.resolve(allSigned(gates[index].paths));
    const signed = await pending;

    assert.equal(signed.size, 250);
    assert.deepEqual([...signed.keys()], paths, "the map follows the request order, not the answers");
});

test("a failing FIRST chunk never costs a later one", async () => {
    const paths = Array.from({ length: 150 }, (_unused, index) => `receipts/intake/f-${index}.pdf`);
    const firstChunk = new Set(paths.slice(0, RECEIPT_SIGN_CHUNK_SIZE));

    const threw = await captureWarnings(() => signReceiptDownloadUrls(
        paths, RECEIPT_URL_TTL_SECONDS, undefined,
        { createSignedUrls: async chunk => {
            if (firstChunk.has(chunk[0])) throw new Error("socket hang up");
            return allSigned(chunk);
        } },
    ));
    assert.deepEqual([...threw.result.keys()], paths.slice(RECEIPT_SIGN_CHUNK_SIZE), "the surviving chunk is all there");

    const errored = await captureWarnings(() => signReceiptDownloadUrls(
        paths, RECEIPT_URL_TTL_SECONDS, undefined,
        { createSignedUrls: async chunk => (firstChunk.has(chunk[0])
            ? { data: null, error: { message: "gateway", status: 502 } }
            : allSigned(chunk)) },
    ));
    assert.deepEqual([...errored.result.keys()], paths.slice(RECEIPT_SIGN_CHUNK_SIZE));
});

test("duplicates and unsafe paths never reach storage", async () => {
    const { calls, signer } = recordingBucket(allSigned);
    const signed = await signReceiptDownloadUrls(
        [PATH_A, PATH_A, "", null, undefined, "/etc/passwd", "../secure-docs/contract.pdf", PATH_B],
        RECEIPT_URL_TTL_SECONDS,
        undefined,
        signer,
    );

    assert.deepEqual(calls[0].paths, [PATH_A, PATH_B], "asked once each, and only for paths inside the bucket");
    assert.deepEqual([...signed.keys()], [PATH_A, PATH_B]);
});

test("a non-string element in the list is skipped, never thrown over", async () => {
    const { calls, signer } = recordingBucket(allSigned);
    const hostile = [PATH_A, 42, {}, [], true, Symbol("nope"), PATH_B] as unknown as string[];

    const signed = await signReceiptDownloadUrls(hostile, RECEIPT_URL_TTL_SECONDS, undefined, signer);

    assert.deepEqual(calls[0].paths, [PATH_A, PATH_B]);
    assert.deepEqual([...signed.keys()], [PATH_A, PATH_B]);
});

test("a malformed response item is skipped ON ITS OWN", async () => {
    // Reading a bad item inside the chunk's own loop would take every valid
    // sibling after it down too, and those are rows whose links then vanish.
    const { result: signed } = await captureWarnings(() => signReceiptDownloadUrls(
        [PATH_A, PATH_B, PATH_C], RECEIPT_URL_TTL_SECONDS, undefined,
        { createSignedUrls: async chunk => ({
            data: [
                null,
                undefined,
                42,
                {},
                { get path(): string { throw new Error("hostile getter"); } },
                { path: chunk[0], signedUrl: null, error: "Object not found" },
                { path: chunk[1], signedUrl: signedUrlFor(chunk[1]), error: null },
                { path: chunk[2], signedUrl: signedUrlFor(chunk[2]), error: null },
            ] as unknown as BatchResponse["data"],
            error: null,
        }) },
    ));

    assert.deepEqual([...signed.keys()], [PATH_B, PATH_C], "the junk went past and the good siblings landed");
});

test("a response that is not a list yields nothing for that chunk", async () => {
    for (const data of ["nope", {}, 7, null, undefined]) {
        const { result } = await captureWarnings(() => signReceiptDownloadUrls(
            [PATH_A], RECEIPT_URL_TTL_SECONDS, undefined,
            { createSignedUrls: async () => ({ data, error: null } as unknown as BatchResponse) },
        ));
        assert.equal(result.size, 0, JSON.stringify(data ?? null));
    }
});

test("a response can never put a path in the map that nobody asked for", async () => {
    const { signer } = recordingBucket(paths => ({
        data: [
            ...paths.map(path => ({ path, signedUrl: signedUrlFor(path), error: null })),
            { path: "../secure-docs/contract.pdf", signedUrl: "https://evil.test/x", error: null },
        ],
        error: null,
    }));

    const signed = await signReceiptDownloadUrls([PATH_A], RECEIPT_URL_TTL_SECONDS, undefined, signer);
    assert.deepEqual([...signed.keys()], [PATH_A]);
});

test("a whole-call failure, and a thrown call, contribute nothing and never throw", async () => {
    const failed = await captureWarnings(() => signReceiptDownloadUrls(
        [PATH_A, PATH_B],
        RECEIPT_URL_TTL_SECONDS,
        undefined,
        recordingBucket(() => ({ data: null, error: { message: "boom", name: "StorageApiError", status: 500 } })).signer,
    ));
    assert.equal(failed.result.size, 0);

    const threw = await captureWarnings(() => signReceiptDownloadUrls(
        [PATH_A, PATH_B],
        RECEIPT_URL_TTL_SECONDS,
        undefined,
        { createSignedUrls: async () => { throw new Error("socket hang up"); } },
    ));
    assert.equal(threw.result.size, 0, "a dead call is an empty map, not a rejection");

    for (const { warnings } of [failed, threw]) {
        assert.equal(warnings.length, 1, "one line per call, however many chunks failed");
        assert.match(warnings[0], /requested/);
        assert.match(warnings[0], /signed/);
    }
});

// ── What a failure is allowed to SAY ───────────────────────────────────────

const faultTagIn = (line: string) => /"fault":"([^"]*)"/.exec(line)?.[1] ?? "";

test("the warning can only say one of a fixed set of words", async () => {
    // Every field an error carries is text off the wire, and a log line is read
    // by people and shipped to a log sink.
    const leaky = {
        message: `https://storage.test/object/sign/receipt-intake/${PATH_A}?token=super-secret`,
        name: "leaked-by-name",
        status: "https://evil.test/exfiltrate?token=super-secret",
        statusCode: "leaked-by-status",
    };

    const { warnings } = await captureWarnings(() => signReceiptDownloadUrls(
        [PATH_A], RECEIPT_URL_TTL_SECONDS, undefined,
        // Cast deliberately: the declared error type promises a numeric
        // status, and the whole point here is that the runtime value is not
        // the declared one and must not be trusted as text.
        { createSignedUrls: async () => ({ data: null, error: leaky } as unknown as BatchResponse) },
    ));

    assert.equal(warnings.length, 1);
    const line = warnings[0];
    for (const secret of [PATH_A, "http", "token", "super-secret", "leaked-by-name", "leaked-by-status", "evil.test", "boom"]) {
        assert.ok(!line.includes(secret), `the warning leaks ${secret}: ${line}`);
    }
    assert.ok(
        (SIGN_FAULT_TAGS as readonly string[]).includes(faultTagIn(line)),
        `${faultTagIn(line)} is not one of ${SIGN_FAULT_TAGS.join(", ")}`,
    );
});

test("an integer HTTP status is the ONE thing ever borrowed from an error", async () => {
    const { warnings } = await captureWarnings(() => signReceiptDownloadUrls(
        [PATH_A], RECEIPT_URL_TTL_SECONDS, undefined,
        { createSignedUrls: async () => ({ data: null, error: { name: "whatever", status: 503 } }) },
    ));
    assert.equal(faultTagIn(warnings[0]), "storage-error/503");
    assert.ok(!warnings[0].includes("whatever"), "the name is still this code's to choose");

    // Out of range, not an integer, or a numeric-looking STRING: a string off
    // the wire is a string off the wire.
    for (const status of [99, 600, 200.5, "503", Number.NaN]) {
        const { warnings: other } = await captureWarnings(() => signReceiptDownloadUrls(
            [PATH_A], RECEIPT_URL_TTL_SECONDS, undefined,
            { createSignedUrls: async () => ({ data: null, error: { status } as { status?: number } }) },
        ));
        assert.equal(faultTagIn(other[0]), "storage-error", String(status));
    }
});

test("an error object that explodes when read is still just a fault", async () => {
    const hostile = {
        get name(): string { throw new Error("gotcha"); },
        get status(): number { throw new Error("gotcha"); },
        get statusCode(): string { throw new Error("gotcha"); },
    };

    const { result, warnings } = await captureWarnings(() => signReceiptDownloadUrls(
        [PATH_A], RECEIPT_URL_TTL_SECONDS, undefined,
        { createSignedUrls: async () => ({ data: null, error: hostile }) },
    ));

    assert.equal(result.size, 0);
    assert.equal(warnings.length, 1);
    assert.ok((SIGN_FAULT_TAGS as readonly string[]).includes(faultTagIn(warnings[0])), faultTagIn(warnings[0]));
});

// ── The real thing, through the hermetic storage stub ──────────────────────

test("the REAL signer signs against the private receipt-intake bucket", async () => {
    // No injection and no network: the e2e storage stub, reached through the
    // same getSupabaseWithSignal path production uses.
    const stored = "receipts/intake/real-signer.pdf";
    const missing = "receipts/intake/never-uploaded.pdf";
    await createStorageMockClient().storage.from(RECEIPT_BUCKET)
        .upload(stored, Buffer.from("%PDF-1.4"), { contentType: "application/pdf" });

    const { result: signed } = await captureWarnings(() =>
        signReceiptDownloadUrls([stored, missing], RECEIPT_URL_TTL_SECONDS, undefined));

    assert.match(signed.get(stored) ?? "", new RegExp(`/object/sign/${RECEIPT_BUCKET}/`), "the PRIVATE bucket");
    assert.doesNotMatch(signed.get(stored) ?? "", /\/object\/public\//);
    assert.equal(signed.has(missing), false, "an absent object is absent from the map");
});

test("a render with NO injected signer reaches that same real signer", async () => {
    // The seam the other render tests use proves the wiring only if the
    // DEFAULT is the real thing. This one passes no signer at all.
    const path = "receipts/intake/default-wiring.pdf";
    await createStorageMockClient().storage.from(RECEIPT_BUCKET)
        .upload(path, Buffer.from("%PDF-1.4"), { contentType: "application/pdf" });

    const html = await renderTab(queueOf({ needsJob: [row("a", path)] }), ALL_GROUPS);

    assert.equal(linkCount(html), 1);
    assert.match(html, new RegExp(`href="[^"]*/object/sign/${RECEIPT_BUCKET}/`));
    assert.doesNotMatch(html, /project-files/);
});
