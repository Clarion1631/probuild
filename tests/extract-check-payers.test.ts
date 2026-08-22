import assert from "node:assert/strict";
import test from "node:test";
import {
    scrubField,
    scrubExtraction,
    nameSimilarity,
    suggestMatches,
    loadCandidatesFromManifest,
} from "../scripts/extract-check-payers.mjs";

// ── the MICR / routing / account ban ────────────────────────────────────
// This is the guard the whole pipeline leans on: NOTHING with a long digit
// run may survive scrubbing, no matter what the model returned.

test("scrubField passes ordinary payer names through", () => {
    assert.deepEqual(scrubField("Smith Family Trust"), { value: "Smith Family Trust", dropped: null });
});

test("scrubField drops a 9-digit routing number", () => {
    const { value, dropped } = scrubField("routing 125108272");
    assert.equal(value, null);
    assert.match(dropped ?? "", /banned digit run/);
});

test("scrubField drops account numbers split by spaces or dashes", () => {
    assert.equal(scrubField("1234 5678 9012").value, null);
    assert.equal(scrubField("1234-5678-90").value, null);
});

test("scrubField drops MICR transit symbols outright", () => {
    const { value, dropped } = scrubField("\u2446125108272\u2446");
    assert.equal(value, null);
    assert.match(dropped ?? "", /MICR/);
});

test("scrubField allows an explicitly allowed long digit string", () => {
    assert.equal(scrubField("ref 123456789", ["123456789"]).value, "ref 123456789");
});

test("scrubExtraction keeps payer/memo, drops fields carrying account-like runs", () => {
    const out = scrubExtraction(
        {
            payerName: "Henderson Kitchen LLC",
            memoText: "acct 26225018006376", // model leaked something — must die
            documentDate: "2026-08-13",
            amount: "6037.15",
            checkNumber: "1027",
        },
        { checkNumber: "1027", amountCents: 603715 },
    );
    assert.equal(out.payerName, "Henderson Kitchen LLC");
    assert.equal(out.memoText, null);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /memoText DROPPED/);
    assert.equal(out.documentDate, "2026-08-13");
    assert.equal(out.checkNumber, "1027");
});

test("scrubExtraction never lets a routing number through any field", () => {
    const out = scrubExtraction({
        payerName: "125108272", // routing number where a name should be
        memoText: null,
        documentDate: null,
        amount: null,
        checkNumber: null,
    });
    assert.equal(out.payerName, null);
    assert.equal(out.warnings.length, 1);
});

// ── fuzzy matching (review report is suggestion-only) ───────────────────

test("nameSimilarity: exact and noise-word-insensitive matches score high", () => {
    assert.equal(nameSimilarity("Henderson", "Henderson"), 1);
    assert.ok(nameSimilarity("Henderson Kitchen LLC", "The Henderson Kitchen Co") > 0.6);
});

test("nameSimilarity: unrelated names score low", () => {
    assert.ok(nameSimilarity("Smith Family Trust", "Jones Roofing") < 0.4);
});

test("suggestMatches ranks clients by payer and projects by memo, threshold 0.4", () => {
    const clients = [
        { id: "c1", name: "Sarah Henderson" },
        { id: "c2", name: "Bob Jones" },
    ];
    const projects = [
        { id: "p1", name: "Henderson Master Bath" },
        { id: "p2", name: "Shop" },
    ];
    const { payerMatches, memoMatches } = suggestMatches(
        { payerName: "Henderson, Sarah", memoText: "master bath" },
        clients,
        projects,
    );
    assert.equal(payerMatches[0]?.id, "c1");
    assert.equal(memoMatches[0]?.id, "p1");
    assert.ok(!payerMatches.some((m: { id: string }) => m.id === "c2"));
});

// ── manifest candidate derivation (pre-DDL dry-run path) ────────────────

test("loadCandidatesFromManifest derives kinds like post-bank-images and respects the kind filter", () => {
    const manifest = {
        images: {
            "26225018006376": {
                bankReference: "26225018006376",
                checkNumber: "1027",
                files: [
                    { fileName: "front.jpg", side: "front" },
                    { fileName: "back.jpg", side: "back" },
                ],
            },
        },
    };
    const rows = loadCandidatesFromManifest(manifest, ["CHECK_FRONT"], 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "CHECK_FRONT");
    assert.equal(rows[0].normalizedCheckNumber, "1027");
    assert.equal(rows[0].sourceExternalId, "26225018006376:front");
});

test("loadCandidatesFromManifest honors the limit", () => {
    const manifest = {
        images: {
            a: { bankReference: "a", checkNumber: "1", files: [{ fileName: "1.jpg", side: "front" }] },
            b: { bankReference: "b", checkNumber: "2", files: [{ fileName: "2.jpg", side: "front" }] },
        },
    };
    assert.equal(loadCandidatesFromManifest(manifest, ["CHECK_FRONT"], 1).length, 1);
});
