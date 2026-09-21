/**
 * "Open receipt" on /automation?tab=receipts must open the receipt.
 *
 * Every row carries a RAW object path (`receipts/intake/<uuid>.pdf`) into the
 * intake feature's own PRIVATE bucket. Handed to resolveDocUrl that is not a
 * reference it understands, so it falls through to the legacy branch and comes
 * back as a PUBLIC project-files URL: the wrong bucket, and a 404 on every
 * group of the tab. #443 shipped exactly that. The link is minted by
 * receipt-intake's own signer, or it is not rendered at all.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptLink, receiptLinkHref } from "../src/app/automation/components/receipts/receipts-tab";
import { RECEIPT_URL_TTL_SECONDS } from "../src/lib/receipt-intake/receipt-url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAB = "src/app/automation/components/receipts/receipts-tab.tsx";

const PATH = "receipts/intake/8f1c2d3e-4b5a-6c7d-8e9f-0a1b2c3d4e5f.pdf";
/** The shape storage really returns: the PRIVATE bucket, under /object/sign/. */
const SIGNED = `https://storage.test/storage/v1/object/sign/receipt-intake/${PATH}?token=fake-token`;

/** Records what the tab asks storage for, so the ask itself can be asserted. */
function recordingSigner(result: string | null = SIGNED) {
    const asked: Array<[string, number]> = [];
    return {
        asked,
        sign: async (storagePath: string, ttlSeconds: number) => {
            asked.push([storagePath, ttlSeconds]);
            return result;
        },
    };
}

test("the href is signed by the receipt-intake bucket, from the RAW storage path", async () => {
    const { asked, sign } = recordingSigner();

    const url = await receiptLinkHref(PATH, sign);

    // The raw path and the short TTL: the same two arguments resolveReceiptUrl
    // and withArchiveDownloadUrls hand the same signer.
    assert.deepEqual(asked, [[PATH, RECEIPT_URL_TTL_SECONDS]]);
    assert.equal(url, SIGNED);
});

test("the rendered link opens the signed URL, and never the public bucket", async () => {
    const { asked, sign } = recordingSigner();

    const html = renderToStaticMarkup(await ReceiptLink({ storagePath: PATH, sign }));

    assert.deepEqual(asked, [[PATH, RECEIPT_URL_TTL_SECONDS]], "the row's own path went to the signer");
    assert.ok(html.includes(`href="${SIGNED}"`), html);
    assert.match(html, /\/object\/sign\/receipt-intake\//, "a signed object in the PRIVATE bucket");
    assert.match(html, /Open receipt/);
    // The bug, stated as the browser would see it.
    assert.doesNotMatch(html, /project-files/, "a public project-files URL is the wrong bucket and a 404");
    assert.doesNotMatch(html, /\/object\/public\//);
});

test("a receipt that cannot be signed renders the no-link state instead of throwing", async () => {
    // Storage said no.
    const quiet = await ReceiptLink({ storagePath: PATH, sign: recordingSigner(null).sign });
    assert.equal(quiet, null);
    assert.equal(renderToStaticMarkup(quiet), "", "nothing at all, never a dead link");

    // Storage threw. This queue is the bookkeeper's whole morning, so one
    // unsignable object must not take it down.
    const thrower = async () => { throw new Error("storage is down"); };
    const thrown = await ReceiptLink({ storagePath: PATH, sign: thrower });
    assert.equal(thrown, null);
    assert.equal(renderToStaticMarkup(thrown), "");
    assert.equal(await receiptLinkHref(PATH, thrower), null);
});

test("a row with no stored object keeps today's behaviour: no link, and storage is never asked", async () => {
    for (const value of ["", null, undefined]) {
        const { asked, sign } = recordingSigner();
        const el = await ReceiptLink({ storagePath: value as string, sign });
        assert.equal(el, null, String(value));
        assert.deepEqual(asked, [], "an empty path is not a storage question");
    }
});

test("the tab signs through the intake bucket, and names no public one", () => {
    const source = readFileSync(join(repoRoot, TAB), "utf8");

    assert.match(source, /import \{ signReceiptDownloadUrl \} from "@\/lib\/receipt-intake\/bucket";/);
    assert.match(source, /import \{ RECEIPT_URL_TTL_SECONDS \} from "@\/lib\/receipt-intake\/receipt-url";/);
    assert.match(source, /await sign\(storagePath, RECEIPT_URL_TTL_SECONDS\)/);
    // The CALL and the IMPORT, not the word: the doc comment above
    // receiptLinkHref explains why resolveDocUrl is the wrong reader here, and
    // that explanation is the thing this gate exists to keep true.
    assert.ok(!/resolveDocUrl\(/.test(source), "its legacy branch hands back a PUBLIC project-files URL");
    assert.ok(
        !/getPublicUrl\(|STORAGE_BUCKET|from "@\/lib\/secure-storage"/.test(source),
        "nothing on this tab can mint a public-bucket URL",
    );

    // Every group passes the row's own path, and nothing else.
    const links = source.match(/<ReceiptLink[^/]*\/>/g) ?? [];
    assert.ok(links.length >= 5, `every group offers the link, saw ${links.length}`);
    for (const link of links) {
        assert.equal(link, "<ReceiptLink storagePath={row.storagePath} />", link);
    }
});

test("no other automation surface hands a raw intake path to resolveDocUrl", () => {
    // The same mistake anywhere else on this page: a bare storage path is not
    // a reference resolveDocUrl can read.
    const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
            entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

    const callers = walk(join(repoRoot, "src/app/automation"))
        .filter(file => /\.tsx?$/.test(file))
        .filter(file => /resolveDocUrl\(/.test(readFileSync(file, "utf8")));

    for (const file of callers) {
        const source = readFileSync(file, "utf8");
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
