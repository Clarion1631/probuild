/**
 * Expense.receiptUrl holds a REFERENCE, not a link.
 *
 * A signed URL written into the column is dead ten minutes later — the receipt
 * link in the books stops working and nothing says why. A bare storage path
 * says nothing about which bucket it is in, which is the ambiguity that had
 * receipts and signed contracts sharing one. So the column holds
 * `receipt-intake://<bucket>/<path>` and every reader mints its own short-lived
 * URL from it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    RECEIPT_URL_SCHEME,
    isReceiptUrlRef,
    parseReceiptUrl,
    receiptUrlRef,
    resolveReceiptUrl,
} from "../src/lib/receipt-intake/receipt-url";
import { RECEIPT_BUCKET } from "../src/lib/receipt-intake/bucket";

const PATH = "receipts/intake/row-1.png";
const REF = `${RECEIPT_URL_SCHEME}${RECEIPT_BUCKET}/${PATH}`;

test("the reference names the bucket AND the path, and round-trips", () => {
    assert.equal(receiptUrlRef(PATH), REF);
    assert.deepEqual(parseReceiptUrl(REF), { bucket: RECEIPT_BUCKET, path: PATH });
    assert.ok(isReceiptUrlRef(REF));
});

test("anything that is not our reference is not ours to resolve", async () => {
    for (const value of [
        null, undefined, "",
        "https://evil.test/receipt.png",
        "data:image/png;base64,AAAA",
        "receipts/intake/row-1.png",
        "secure:receipts/intake/row-1.png",
        // Another bucket is refused even under our scheme: this string comes
        // out of a database column and ends up in a storage API call.
        `${RECEIPT_URL_SCHEME}secure-docs/${PATH}`,
        `${RECEIPT_URL_SCHEME}${RECEIPT_BUCKET}/../secure-docs/contract.pdf`,
        `${RECEIPT_URL_SCHEME}${RECEIPT_BUCKET}//etc/passwd`,
        `${RECEIPT_URL_SCHEME}${RECEIPT_BUCKET}/`,
    ]) {
        assert.equal(parseReceiptUrl(value as string), null, String(value));
        let signed = 0;
        const out = await resolveReceiptUrl(value as string, 600, {
            sign: async () => { signed++; return "https://signed.test/x"; },
            currentPath: async () => null,
        });
        assert.equal(out, null, String(value));
        assert.equal(signed, 0, `${value}: storage was never asked`);
    }
});

test("a live object is signed for a SHORT window", async () => {
    const asked: Array<[string, number]> = [];
    const url = await resolveReceiptUrl(REF, 600, {
        sign: async (p, ttl) => { asked.push([p, ttl]); return `https://signed.test/${p}`; },
        currentPath: async () => null,
    });
    assert.equal(url, `https://signed.test/${PATH}`);
    assert.deepEqual(asked, [[PATH, 600]]);
});

test("a MOVED object is followed to where the intake row points now", async () => {
    // The object moves after the Expense is written: published at the upload
    // path, sealed to a content-addressed one, later archived. A reference that
    // no longer resolves is re-asked of the row that tracks the bytes.
    const sealed = "receipts/row-1/abc123.png";
    const asked: string[] = [];
    const url = await resolveReceiptUrl(REF, 600, {
        sign: async p => { asked.push(p); return p === sealed ? `https://signed.test/${p}` : null; },
        currentPath: async () => sealed,
    });
    assert.deepEqual(asked, [PATH, sealed], "the stored path first, then where it moved to");
    assert.equal(url, `https://signed.test/${sealed}`);
});

test("an object that is really gone resolves to null, not to a broken link", async () => {
    const gone = await resolveReceiptUrl(REF, 600, {
        sign: async () => null,
        currentPath: async () => null,
    });
    assert.equal(gone, null);

    // And a lookup that points back at the same dead path is not retried.
    let signs = 0;
    await resolveReceiptUrl(REF, 600, {
        sign: async () => { signs++; return null; },
        currentPath: async () => PATH,
    });
    assert.equal(signs, 1);
});

test("neither leg can take a page down", async () => {
    const out = await resolveReceiptUrl(REF, 600, {
        sign: async () => { throw new Error("storage is down"); },
        currentPath: async () => { throw new Error("db is down"); },
    });
    assert.equal(out, null);
});

test("every reader resolves the reference: the booker writes it, resolveDocUrl reads it", () => {
    const root = path.resolve(__dirname, "..");
    const book = readFileSync(path.join(root, "src/lib/receipt-intake/book.ts"), "utf8");
    assert.ok(/\s{20}receiptUrl,/.test(book), "the Expense is written with it");
    assert.match(book, /receiptUrlRef\(row\.storagePath\)/);
    assert.ok(!/createSignedUrl/.test(book), "the booker never mints a link into the column");

    // resolveDocUrl is the shared reader, so everything already going through
    // it resolves the new scheme without learning about it.
    const storage = readFileSync(path.join(root, "src/lib/secure-storage.ts"), "utf8");
    assert.match(storage, /if \(isReceiptUrlRef\(stored\)\) return await resolveReceiptUrl\(stored, ttlSeconds\)/);

    // The two readers that do NOT go through it.
    const tab = readFileSync(path.join(root, "src/lib/time-expense-actions.ts"), "utf8");
    assert.match(tab, /isReceiptUrlRef\(expense\.receiptUrl\)/);
    assert.match(tab, /await resolveReceiptUrl\(expense\.receiptUrl\)/);

    const aiReview = readFileSync(path.join(root, "src/app/api/automation/ai-review/route.ts"), "utf8");
    assert.match(aiReview, /const receiptUrl = isReceiptUrlRef\(expense\.receiptUrl\)/);
    // The SSRF check still stands, on the RESOLVED url, and now names the
    // signed-object prefix too.
    assert.match(aiReview, /storageRoot\}sign\//);
    assert.match(aiReview, /allowed\.some\(prefix => receiptUrl\.startsWith\(prefix\)\)/);
    assert.match(aiReview, /fetch\(receiptUrl, \{ redirect: "error"/);
});
