import assert from "node:assert/strict";
import test from "node:test";
import {
    scrubField,
    scrubExtraction,
    parseModelJson,
    nameSimilarity,
    suggestMatches,
    loadCandidatesFromManifest,
    PAYER_NAME_MAX,
    MEMO_TEXT_MAX,
    DEFAULT_KINDS,
} from "../scripts/extract-check-payers.mjs";

// ── the MICR / routing / account ban ────────────────────────────────────
// This is the guard the whole pipeline leans on: NOTHING with a long digit
// run may survive scrubbing, no matter what the model returned.

test("scrubField passes ordinary payer names through", () => {
    assert.deepEqual(scrubField("Smith Family Trust"), { value: "Smith Family Trust", dropped: null, truncated: false });
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

// ── Kimi review gap 1: 8-digit accounts split by separators ─────────────

test("scrubField drops an 8-digit account split by a space", () => {
    const { value, dropped } = scrubField("acct 1234 5678");
    assert.equal(value, null);
    assert.match(dropped ?? "", /banned digit run/);
});

test("scrubField drops an 8-digit account split by dashes", () => {
    assert.equal(scrubField("12-34-56-78").value, null);
});

// ── Kimi review gap 2: dot / slash separators ───────────────────────────

test("scrubField drops a dot-separated routing number", () => {
    const { value, dropped } = scrubField("123.456.789");
    assert.equal(value, null);
    assert.match(dropped ?? "", /banned digit run/);
});

test("scrubField drops a slash-separated account number", () => {
    assert.equal(scrubField("123/456/789").value, null);
    assert.equal(scrubField("1234/5678").value, null);
});

test("scrubField drops comma- and paren-separated digit groups", () => {
    assert.equal(scrubField("1234,5678").value, null);
    assert.equal(scrubField("(1234) 5678-90").value, null);
});

// ── Kimi review gap 3: letter-mixed digit runs ──────────────────────────

test("scrubField drops letter-mixed runs hiding 8+ digits", () => {
    const { value, dropped } = scrubField("A1B2C3D4E5F6G7H8");
    assert.equal(value, null);
    assert.match(dropped ?? "", /banned digit run/);
});

test("scrubField drops an account with a letter prefix", () => {
    assert.equal(scrubField("acct no. 12345678").value, null);
});

// ── dates must survive the total-digit rule ─────────────────────────────

test("scrubField passes ISO and US calendar dates (8 digits, but a date)", () => {
    assert.equal(scrubField("2026-08-13").value, "2026-08-13");
    assert.equal(scrubField("8/13/2026").value, "8/13/2026");
    assert.equal(scrubField("12/31/2026").value, "12/31/2026");
});

test("scrubField does NOT exempt an account disguised as an invalid date", () => {
    assert.equal(scrubField("12/34/5678").value, null);
});

test("scrubField allow-list matches the separator-stripped digit string", () => {
    // Allowed "123456789" also covers its spaced form.
    assert.equal(scrubField("ref 1234 56789", ["123456789"]).value, "ref 1234 56789");
});

test("scrubField keeps short digit content (check numbers, amounts, addresses)", () => {
    assert.equal(scrubField("chk 1027").value, "chk 1027");
    assert.equal(scrubField("6037.15").value, "6037.15");
    assert.equal(scrubField("1234 W 5th Ave").value, "1234 W 5th Ave");
});

// ── length caps ─────────────────────────────────────────────────────────

test("scrubField truncates past maxLen and flags it", () => {
    const long = "X".repeat(150);
    const { value, dropped, truncated } = scrubField(long, [], 120);
    assert.equal(value, "X".repeat(120));
    assert.equal(dropped, null);
    assert.equal(truncated, true);
});

test("scrubField leaves values within maxLen untouched", () => {
    const { value, truncated } = scrubField("Smith Family Trust", [], 120);
    assert.equal(value, "Smith Family Trust");
    assert.equal(truncated, false);
});

test("scrubExtraction caps payerName at 120 and memoText at 200, sets needsReview", () => {
    const out = scrubExtraction({
        payerName: "P".repeat(PAYER_NAME_MAX + 40),
        memoText: "m".repeat(MEMO_TEXT_MAX + 1),
        documentDate: null,
        amount: null,
        checkNumber: null,
    });
    assert.equal(out.payerName, "P".repeat(120));
    assert.equal(out.memoText, "m".repeat(200));
    assert.equal(out.needsReview, true);
    assert.equal(out.warnings.length, 2);
    assert.match(out.warnings[0], /payerName TRUNCATED to 120/);
    assert.match(out.warnings[1], /memoText TRUNCATED to 200/);
});

// ── needsReview signal ──────────────────────────────────────────────────

test("scrubExtraction reports needsReview=false on a clean extraction", () => {
    const out = scrubExtraction(
        {
            payerName: "Henderson Kitchen LLC",
            memoText: "master bath",
            documentDate: "2026-08-13",
            amount: "6037.15",
            checkNumber: "1027",
        },
        { checkNumber: "1027", amountCents: 603715 },
    );
    assert.equal(out.needsReview, false);
    assert.equal(out.warnings.length, 0);
});

test("scrubExtraction flags needsReview when any field is dropped", () => {
    const out = scrubExtraction({
        payerName: "Fine Name",
        memoText: "acct 1234 5678", // spaced 8-digit leak
        documentDate: null,
        amount: null,
        checkNumber: null,
    });
    assert.equal(out.memoText, null);
    assert.equal(out.needsReview, true);
});

// ── JSON fence tolerance ────────────────────────────────────────────────

test("parseModelJson parses bare JSON", () => {
    assert.deepEqual(parseModelJson('{"payerName": "Smith"}'), { payerName: "Smith" });
});

test("parseModelJson tolerates ```json fences", () => {
    const fenced = '```json\n{"payerName": "Smith", "memoText": null}\n```';
    assert.deepEqual(parseModelJson(fenced), { payerName: "Smith", memoText: null });
});

test("parseModelJson tolerates bare ``` fences and surrounding whitespace", () => {
    const fenced = '  ```\n{"amount": "6037.15"}\n```  ';
    assert.deepEqual(parseModelJson(fenced), { amount: "6037.15" });
});

test("parseModelJson still throws on genuinely invalid JSON", () => {
    assert.throws(() => parseModelJson("```json\nnot json at all\n```"));
});

// ── trailing/leading prose around the object (prod bug: bank ref
// 26236015002403's $25k cashier's check response had trailing text after
// the JSON object and threw "Unexpected non-whitespace character after
// JSON at position 132") ────────────────────────────────────────────────

test("parseModelJson recovers a JSON object with trailing prose after it", () => {
    const raw = '{"payerName": "Christensen", "memoText": null} Note: amount verified against courtesy box.';
    assert.deepEqual(parseModelJson(raw), { payerName: "Christensen", memoText: null });
});

test("parseModelJson recovers a JSON object with leading prose before it", () => {
    const raw = 'Here is the extraction: {"payerName": "Christensen", "memoText": null}';
    assert.deepEqual(parseModelJson(raw), { payerName: "Christensen", memoText: null });
});

test("parseModelJson recovers a fenced JSON object that also has trailing text", () => {
    const raw = '```json\n{"payerName": "Christensen"}\n``` (end of response)';
    assert.deepEqual(parseModelJson(raw), { payerName: "Christensen" });
});

test("parseModelJson does not get confused by braces nested inside string values", () => {
    const raw = '{"payerName": "Smith {Trust}", "memoText": "job #{4412}"} trailing junk';
    assert.deepEqual(parseModelJson(raw), { payerName: "Smith {Trust}", memoText: "job #{4412}" });
});

test("parseModelJson still throws when there is no JSON object at all", () => {
    assert.throws(() => parseModelJson("Sorry, I cannot read this image."));
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

// ── default kinds must cover DEPOSIT_SLIP (prod bug: a default run found
// only 1 of 18 filed images because DEFAULT_KINDS omitted DEPOSIT_SLIP) ──

test("DEFAULT_KINDS includes DEPOSIT_SLIP", () => {
    // scripts/post-bank-images.mjs assigns the FRONT image of every branch
    // deposit (one with no check number) the kind DEPOSIT_SLIP, not
    // DEPOSIT_PHOTO — for those deposits the "front" image IS the
    // substitute-check page carrying the payer's name, so a default
    // extraction run that skips DEPOSIT_SLIP silently skips the payer for
    // every branch deposit.
    assert.ok(DEFAULT_KINDS.includes("DEPOSIT_SLIP"));
    assert.deepEqual(DEFAULT_KINDS, ["CHECK_FRONT", "DEPOSIT_SLIP", "DEPOSIT_PHOTO"]);
});
