/**
 * "Open receipt" on /automation?tab=receipts: that it works, and what it costs.
 *
 * Two things have to hold at once.
 *
 * It must open. Every row carries a RAW object path into the intake feature's
 * own PRIVATE bucket. Handed to resolveDocUrl that is not a reference it can
 * read, so it falls through to the legacy branch and comes back as a PUBLIC
 * project-files URL: the wrong bucket, and a 404 on every group of the tab
 * (#443).
 *
 * And it must not cost a round trip per row. This page draws up to five groups
 * of RECEIPT_GROUP_TAKE rows and is force-dynamic, so signing row by row is
 * five hundred requests and five hundred Supabase clients on every load. One
 * batched call per chunk is the contract, and the tests below are renders of
 * the real component rather than assertions about its source.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptsTab } from "../src/app/automation/components/receipts/receipts-tab";
import type { ReceiptFilters } from "../src/app/automation/receipts-filters";
import type { IntakeRow, ReceiptQueue } from "../src/app/automation/receipts-data";
import { RECEIPT_URL_TTL_SECONDS } from "../src/lib/receipt-intake/receipt-url";
import {
    RECEIPT_BUCKET,
    RECEIPT_SIGN_CHUNK_SIZE,
    signReceiptDownloadUrls,
    type BucketBatchSigner,
} from "../src/lib/receipt-intake/bucket";
import { createStorageMockClient } from "../src/lib/supabase-storage-mock";

// The hermetic storage stub, through the same gate e2e uses: the tests that
// exercise the REAL signer make no network call and need no credentials.
process.env.E2E_STORAGE_MOCK = "1";
process.env.PLAYWRIGHT_TEST_SECRET = "receipt-open-link-test";
delete process.env.VERCEL;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALL_GROUPS: ReceiptFilters = { group: null, projectId: null, owner: null };
const PATH_A = "receipts/intake/8f1c2d3e-aaaa-4c7d-8e9f-0a1b2c3d4e5f.pdf";
const PATH_B = "receipts/intake/8f1c2d3e-bbbb-4c7d-8e9f-0a1b2c3d4e5f.jpg";
const PATH_C = "receipts/intake/8f1c2d3e-cccc-4c7d-8e9f-0a1b2c3d4e5f.png";

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
    const calls: Array<{ paths: string[]; ttl: number }> = [];
    return {
        calls,
        sign: async (paths: readonly string[], ttl: number) => {
            calls.push({ paths: [...paths], ttl });
            const signed = new Map<string, string>();
            for (const path of paths) {
                const url = urlFor(path);
                if (url) signed.set(path, url);
            }
            return signed;
        },
    };
}

const renderTab = async (
    queue: ReceiptQueue,
    filters: ReceiptFilters,
    sign?: Parameters<typeof ReceiptsTab>[0]["sign"],
) => renderToStaticMarkup(await ReceiptsTab({
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
    // The same object heads two groups: a row and the duplicate parked against
    // it. Asking twice is a wasted slot in the chunk.
    const queue = queueOf({
        needsJob: [row("a", PATH_A), row("b", PATH_B)],
        booking: [row("c", PATH_C)],
        duplicates: [row("d", PATH_A)],
    });

    const html = await renderTab(queue, ALL_GROUPS, sign);

    assert.equal(calls.length, 1, "one render is one round trip, not one per row");
    assert.deepEqual(calls[0].paths, [PATH_A, PATH_B, PATH_C], "the raw paths, deduped, in render order");
    assert.equal(calls[0].ttl, RECEIPT_URL_TTL_SECONDS, "the short TTL every other reader uses");
    assert.equal(linkCount(html), 4, "all four rows link, including the two sharing an object");
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

/** A stand-in for the bucket's plural call that records what it was asked. */
function recordingBucket(
    answer: (paths: string[]) => Awaited<ReturnType<BucketBatchSigner["createSignedUrls"]>>,
) {
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

const allSigned = (paths: string[]) => ({
    data: paths.map(path => ({ path, signedUrl: signedUrlFor(path), error: null })),
    error: null,
});

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

test("a per-item failure costs that one path, not the batch", async () => {
    // storage-js types signedUrl as string but writes null for an item that
    // did not sign, so both shapes have to be handled.
    const { signer } = recordingBucket(paths => ({
        data: paths.map(path => (path === PATH_B
            ? { path, signedUrl: null, error: "Object not found" }
            : { path, signedUrl: signedUrlFor(path), error: null })),
        error: null,
    }));

    const { result: signed, warnings } = await captureWarnings(() =>
        signReceiptDownloadUrls([PATH_A, PATH_B, PATH_C], RECEIPT_URL_TTL_SECONDS, undefined, signer));

    assert.deepEqual([...signed.keys()], [PATH_A, PATH_C]);
    assert.equal(warnings.length, 1, "exactly one line, however many items failed");
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

    // One line each, counts only. A path or a signed URL in a log is a
    // capability in a log, and these name private documents.
    for (const { warnings } of [failed, threw]) {
        assert.equal(warnings.length, 1);
        const line = warnings[0];
        assert.match(line, /requested/);
        assert.match(line, /signed/);
        for (const secret of [PATH_A, PATH_B, "http", "token", "boom", "socket hang up"]) {
            assert.ok(!line.includes(secret), `the warning leaks ${secret}: ${line}`);
        }
    }
});

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

// ── The mistake, kept out of the rest of the page ──────────────────────────

test("no automation surface hands a raw intake path to resolveDocUrl", async () => {
    const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
            entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

    const files = walk(join(repoRoot, "src/app/automation")).filter(file => /\.tsx?$/.test(file));
    // A guard that scans nothing passes for the wrong reason.
    assert.ok(files.length > 10, `the scan found only ${files.length} files`);

    for (const file of files) {
        const source = readFileSync(file, "utf8");
        if (!/resolveDocUrl\(/.test(source)) continue;
        assert.ok(
            !/resolveDocUrl\(\s*(?:\w+\.)?storagePath\s*[,)]/.test(source),
            `${file}: an intake storagePath must be signed by the receipt-intake bucket`,
        );
        // Whatever still calls it resolves a REFERENCE, and says so at the call.
        assert.match(
            source,
            /isSecureRef\(|isReceiptUrlRef\(/,
            `${file}: resolves a doc URL without establishing what kind of reference it holds`,
        );
    }
});
