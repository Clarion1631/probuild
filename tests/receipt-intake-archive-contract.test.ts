/**
 * The contract the nightly Apps Script archive mirror codes against.
 *
 * The mirror holds a shared secret and NO service key, so it cannot read the
 * private bucket on its own. Everything it needs to do its one job — fetch each
 * BOOKED receipt and write it to `Processed Receipts/YYYY/MM/` under the v1
 * filename `<Project>_<date>_<vendor>_<ref>_$<total>.<ext>` — has to be in the
 * payload, and nothing else should be.
 *
 * These assertions are the contract; changing one is a breaking change to a
 * script in another repo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    ARCHIVE_READABLE_STATES,
    ARCHIVE_SIGNED_URL_TTL_SECONDS,
    RECEIPT_INTAKE_ARCHIVE_SELECT,
    RECEIPT_INTAKE_LIST_SELECT,
    withArchiveDownloadUrls,
} from "../src/lib/receipt-intake/queries";

test("the archive payload carries everything the v1 filename is built from", () => {
    for (const field of ["txnDate", "vendor", "totalCents", "refNumber", "fileName", "mimeType"]) {
        assert.ok(field in RECEIPT_INTAKE_ARCHIVE_SELECT, `missing ${field}`);
    }
    // The project NAME, not an id the script cannot resolve.
    assert.ok("project" in RECEIPT_INTAKE_ARCHIVE_SELECT);
    // And what it needs to report back and to skip already-archived rows.
    for (const field of ["id", "state", "archiveDriveFileId", "storagePath"]) {
        assert.ok(field in RECEIPT_INTAKE_ARCHIVE_SELECT, `missing ${field}`);
    }
});

test("the archive payload withholds everything the mirror has no business seeing", () => {
    // Least privilege applies to a script the same way it does to a user: a
    // leaked or over-shared secret should expose as little as still works.
    for (const field of ["lastError", "fileSha256", "createdById", "readJson", "dedupStrongKey", "dedupWeakKey", "attempts", "busyPasses"]) {
        assert.ok(!(field in RECEIPT_INTAKE_ARCHIVE_SELECT), `${field} must not be exposed`);
        // ...and it IS in the staff select, so this is a real narrowing rather
        // than a column that simply does not exist.
        if (field !== "readJson") {
            assert.ok(field in RECEIPT_INTAKE_LIST_SELECT, `${field} should exist on the staff select`);
        }
    }
});

test("the mirror may only ask for the two states it acts on", () => {
    assert.deepEqual([...ARCHIVE_READABLE_STATES].sort(), ["ARCHIVED", "BOOKED"]);
});

test("each row gets a short-lived signed URL and a flat project name", async () => {
    const signed: Array<{ ref: string; ttl: number }> = [];
    const rows = await withArchiveDownloadUrls(
        [
            { id: "a", storagePath: "receipts/intake/a.jpg", project: { name: "Berg ADU" } },
            { id: "b", storagePath: "receipts/intake/b.pdf", project: null },
        ],
        async (ref: string, ttl: number) => { signed.push({ ref, ttl }); return `https://signed.test/${ref}`; },
    );

    assert.equal(rows[0].projectName, "Berg ADU");
    assert.equal(rows[0].downloadUrl, "https://signed.test/secure:receipts/intake/a.jpg");
    assert.equal(rows[1].projectName, null, "a project-less row is still archivable");
    // The nested relation is flattened away — the script gets `projectName`.
    assert.ok(!("project" in rows[0]));

    // A private bucket plus a per-request grant: the script never holds a key,
    // and a URL captured from a log is useless by morning.
    assert.equal(ARCHIVE_SIGNED_URL_TTL_SECONDS, 600);
    assert.deepEqual(signed.map(s => s.ttl), [600, 600]);
    assert.deepEqual(signed.map(s => s.ref), ["secure:receipts/intake/a.jpg", "secure:receipts/intake/b.pdf"]);
});

test("a row whose URL cannot be signed is returned with null, never dropped", async () => {
    // A silently short archive is worse than a logged gap.
    const rows = await withArchiveDownloadUrls(
        [{ id: "a", storagePath: "receipts/intake/a.jpg", project: { name: "Berg ADU" } }],
        async () => null,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].downloadUrl, null);
    assert.equal(rows[0].projectName, "Berg ADU");
});
