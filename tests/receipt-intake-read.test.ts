/**
 * The reader, driven through an INJECTED fetch — no network, no module mocks
 * (CI is Node 20, where `mock.module` corrupts the require chain).
 *
 * Two things are pinned here:
 *  1. the load-bearing sentences of the v3.6 prompt. Each one was added after a
 *     specific misread (subtotal booked instead of the total; an invented tax
 *     line; a scanned stack of receipts booked as one purchase), so a tidy-up
 *     edit that drops one is a money bug, not a style change.
 *  2. the outage discipline: "the service was busy" and "this document defeated
 *     the AI" must stay DIFFERENT answers. Collapsing them parked five legible
 *     receipts during the 2026-08-10..19 outage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    buildReadPrompt,
    carryForwardDocTypeOverride,
    normalizeConfidence,
    nonReceiptSetJobOverride,
    parseReadJson,
    readReceipt,
    totalWasRead,
    amountNotRead,
    stripDocTypeOverride,
    type ReadResult,
} from "../src/lib/receipt-intake/read";
import { cleanMoney } from "../src/lib/receipt-intake/keys";

const PHASES = [
    { code: "01-DEMO", name: "Demolition" },
    { code: "03-PLUMB", name: "Plumbing" },
];

const BYTES = Buffer.from("fake-jpeg-bytes");

function geminiJson(payload: unknown): Response {
    return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

const noSleep = async () => {};

test("source screening distinguishes merchant evidence from reconstructions and error images", () => {
    const prompt = buildReadPrompt([]);
    for (const source of ["Check Query Error", "bank transaction history", "reconstructed", "Missing Receipt Affidavit"]) {
        assert.ok(prompt.includes(source), `${source} must be screened before extracting money`);
    }
    assert.ok(prompt.includes("verbatim merchant email"), "original email conversion remains valid evidence");
});

test("the prompt carries the v3.6 rules that decide money", () => {
    const prompt = buildReadPrompt(PHASES);

    // The final-amount rule: the number that matches the bank charge.
    assert.ok(prompt.includes(
        "total_amount is the FINAL amount paid — after all discounts, coupons, and credits, and " +
        "including tax and fees."
    ), "final-amount rule");
    assert.ok(prompt.includes("NEVER the subtotal, and never the pre-discount price."), "subtotal rule");

    // The never-estimate-tax rule: an ABSENT tax is not a ZERO tax, and a
    // computed one would corrupt the reseller-permit filing.
    assert.ok(prompt.includes(
        'return "" if no tax line is shown or it cannot be read confidently — never estimate or ' +
        "compute it yourself."
    ), "never-estimate-tax rule");

    // The multi rule: a stack of receipts scanned into one PDF is not one purchase.
    assert.ok(prompt.includes(
        'STEP 1 - if the file contains MORE THAN ONE separate receipt, invoice, or check'
    ), "multi rule");
    assert.ok(prompt.includes('return exactly {"doc_type":"multi"} and nothing else.'), "multi output");
    assert.ok(prompt.includes('return exactly {"doc_type":"non_receipt"} and nothing else.'), "non_receipt output");

    // Unreadable fields come back empty rather than guessed.
    assert.ok(prompt.includes('If a field cannot be read, return "" for it. For the date, return "" rather than guessing.'));
});

test("the appended phase section lists the job's codes and nothing else", () => {
    const prompt = buildReadPrompt(PHASES);
    assert.ok(prompt.includes("01-DEMO — Demolition"));
    assert.ok(prompt.includes("03-PLUMB — Plumbing"));
    assert.ok(prompt.includes('"suggested_phase"'));
    // The v1 extraction half stays BYTE-IDENTICAL: the phase section can only
    // ever be appended, never woven into the rules above it.
    const v1Only = buildReadPrompt([]);
    assert.ok(prompt.startsWith(v1Only), "the phase section is strictly appended");
    assert.ok(!v1Only.includes("suggested_phase"), "a job with no cost codes gets the v1 prompt");
});

test("a well-formed response parses into ReadResult", async () => {
    let capturedBody: string | undefined;
    const outcome = await readReceipt(BYTES, "image/jpeg", PHASES, {
        apiKey: () => "test-key",
        sleep: noSleep,
        fetchFn: (async (_url: string, init: RequestInit) => {
            capturedBody = init.body as string;
            return geminiJson({
                doc_type: "receipt",
                vendor: "Lowes",
                date: "2026-08-03",
                invoice: "82766",
                check_number: "",
                memo: "",
                total_amount: "364.98",
                tax_amount: "29.20",
                suggested_phase: "03-PLUMB",
            });
        }) as unknown as typeof fetch,
    });

    assert.ok(outcome.ok);
    assert.equal(outcome.read.vendor, "Lowes");
    assert.equal(outcome.read.date, "2026-08-03");
    assert.equal(outcome.read.totalAmount, "364.98");
    assert.equal(outcome.read.taxAmount, "29.20");
    assert.equal(outcome.read.suggestedPhaseCode, "03-PLUMB");
    assert.ok(outcome.read.raw.includes("364.98"), "raw JSON is kept for audit");

    const sent = JSON.parse(capturedBody!);
    assert.equal(sent.generationConfig.responseMimeType, "application/json");
    assert.equal(sent.contents[0].parts[1].inline_data.mime_type, "image/jpeg");
});

test("text/plain goes in as a text part, not inline_data", async () => {
    let capturedBody: string | undefined;
    await readReceipt(Buffer.from("VENDOR: Lowes\nTOTAL: 10.00"), "text/plain; charset=utf-8", [], {
        apiKey: () => "test-key",
        sleep: noSleep,
        fetchFn: (async (_url: string, init: RequestInit) => {
            capturedBody = init.body as string;
            return geminiJson({ doc_type: "receipt", total_amount: "10.00" });
        }) as unknown as typeof fetch,
    });
    const sent = JSON.parse(capturedBody!);
    assert.ok(sent.contents[0].parts[1].text.startsWith("This is a text file containing receipt data:"));
});

test("an off-list phase suggestion is discarded, not trusted", () => {
    const parsed = parseReadJson(JSON.stringify({ doc_type: "receipt", suggested_phase: "99-INVENTED" }), PHASES);
    assert.equal(parsed?.suggestedPhaseCode, "");
});

test("503 retries twice on 1s/3s, then falls through to the next model", async () => {
    // The Apps Script could afford 5 retries at 2s..32s; this worker has 60s for
    // a batch of ten, so one busy document must not eat the invocation.
    const calls: string[] = [];
    const sleeps: number[] = [];
    const outcome = await readReceipt(BYTES, "image/jpeg", [], {
        apiKey: () => "test-key",
        sleep: async (ms) => { sleeps.push(ms); },
        fetchFn: (async (url: string) => {
            calls.push(url);
            if (calls.length <= 3) return new Response("busy", { status: 503 });
            return geminiJson({ doc_type: "receipt", total_amount: "1.00" });
        }) as unknown as typeof fetch,
    });
    assert.ok(outcome.ok, "the second model answered");
    assert.equal(calls.length, 4, "3 attempts on model 1, then model 2");
    assert.ok(calls[0].includes("gemini-3.5-flash"));
    assert.ok(calls[3].includes("gemini-flash-latest"), "fell through to the next model");
    assert.deepEqual(sleeps, [1000, 3000], "2 retries per model");
});

test("the 25s budget is a hard ceiling across models and backoffs", async () => {
    // A row that cannot be read inside its budget comes back next pass at no
    // cost to itself. What it must NOT do is keep the worker's 60s function
    // open while nine other receipts wait behind it.
    let clock = 0;
    const calls: string[] = [];
    const outcome = await readReceipt(BYTES, "image/jpeg", [], {
        apiKey: () => "test-key",
        monotonicMs: () => clock,
        sleep: async (ms) => { clock += ms; },
        fetchFn: (async (url: string) => {
            calls.push(url);
            clock += 9_000; // each call burns 9s
            return new Response("busy", { status: 503 });
        }) as unknown as typeof fetch,
    });
    // AI_UNAVAILABLE, never decisive: the document was never read, so the
    // caller must not spend one of its attempts.
    assert.deepEqual(outcome, { ok: false, decisive: false });
    assert.ok(clock <= 25_000 + 9_000, `budget overrun: ${clock}ms`);
    assert.ok(calls.length <= 3, `budget should have stopped the retries, got ${calls.length} calls`);
});

test("a per-request timeout never outlives the remaining budget", async () => {
    let clock = 0;
    const timeouts: number[] = [];
    await readReceipt(BYTES, "image/jpeg", [], {
        apiKey: () => "test-key",
        monotonicMs: () => clock,
        sleep: async (ms) => { clock += ms; },
        fetchFn: (async (_url: string, init: RequestInit) => {
            // AbortSignal.timeout is opaque; assert on the budget arithmetic by
            // advancing the clock and checking the signal was created at all.
            assert.ok(init.signal, "every request carries an abort signal");
            timeouts.push(clock);
            clock += 5_000;
            return new Response("busy", { status: 503 });
        }) as unknown as typeof fetch,
    });
    // First call at 0ms, then 1s backoff -> 6s, then 3s backoff -> 14s...
    assert.equal(timeouts[0], 0);
    assert.ok(timeouts.every(t => t < 25_000), "no request starts after the budget is gone");
});

test("every model unavailable is NOT decisive — the row must not spend an attempt", async () => {
    const outcome = await readReceipt(BYTES, "image/jpeg", [], {
        apiKey: () => "test-key",
        sleep: noSleep,
        fetchFn: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    assert.deepEqual(outcome, { ok: false, decisive: false });
});

test("a model that answers with unusable JSON IS decisive", async () => {
    // The model responded; retrying will not make this document readable.
    const outcome = await readReceipt(BYTES, "image/jpeg", [], {
        apiKey: () => "test-key",
        sleep: noSleep,
        fetchFn: (async () => new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json at all" }] } }] }),
            { status: 200 },
        )) as unknown as typeof fetch,
    });
    assert.deepEqual(outcome, { ok: false, decisive: true });
});

test("HTTP 400 (payload rejected) is decisive and stops immediately", async () => {
    let calls = 0;
    const outcome = await readReceipt(BYTES, "image/jpeg", [], {
        apiKey: () => "test-key",
        sleep: noSleep,
        fetchFn: (async () => { calls++; return new Response("too big", { status: 400 }); }) as unknown as typeof fetch,
    });
    assert.deepEqual(outcome, { ok: false, decisive: true });
    assert.equal(calls, 1, "a rejected payload is not retried against a second model");
});

test("a missing API key is a SERVICE fact, never charged to the document", async () => {
    let calls = 0;
    const outcome = await readReceipt(BYTES, "image/jpeg", [], {
        apiKey: () => undefined,
        sleep: noSleep,
        fetchFn: (async () => { calls++; return geminiJson({}); }) as unknown as typeof fetch,
    });
    assert.deepEqual(outcome, { ok: false, decisive: false });
    assert.equal(calls, 0);
});

test("EVERY 5xx is the service failing, never the document (busy pass, not a strike)", async () => {
    // 500/502/504 used to fall into the "decisive" branch and charge the row a
    // strike for a Google-side fault it had nothing to do with — exactly what
    // the outage rationale exists to prevent. A gateway error says nothing
    // about whether the receipt is readable.
    for (const status of [500, 502, 503, 504, 529]) {
        const outcome = await readReceipt(BYTES, "image/jpeg", [], {
            apiKey: () => "test-key",
            sleep: noSleep,
            fetchFn: (async () => new Response("server fault", { status })) as unknown as typeof fetch,
        });
        assert.deepEqual(outcome, { ok: false, decisive: false }, `HTTP ${status}`);
    }
});

test("a 5xx on the first model still falls through to the second", async () => {
    const calls: string[] = [];
    const outcome = await readReceipt(BYTES, "image/jpeg", [], {
        apiKey: () => "test-key",
        sleep: noSleep,
        fetchFn: (async (url: string) => {
            calls.push(url);
            if (calls.length <= 3) return new Response("bad gateway", { status: 502 });
            return geminiJson({ doc_type: "receipt", total_amount: "1.00" });
        }) as unknown as typeof fetch,
    });
    assert.ok(outcome.ok, "the second model answered");
    assert.ok(calls[3].includes("gemini-flash-latest"));
});

test("a 4xx that is not 401/403/404/429 is still DECISIVE", async () => {
    // A rejected payload is about this document, and retrying cannot help.
    for (const status of [400, 413, 422]) {
        const outcome = await readReceipt(BYTES, "image/jpeg", [], {
            apiKey: () => "test-key",
            sleep: noSleep,
            fetchFn: (async () => new Response("rejected", { status })) as unknown as typeof fetch,
        });
        assert.deepEqual(outcome, { ok: false, decisive: true }, `HTTP ${status}`);
    }
});

test("an absent confidence is NULL, never 0", () => {
    // `Number("")` and `Number("   ")` are both 0 — a real, maximally-
    // unconfident reading. Coercing first turned "the model said nothing" into
    // "the model is certain this phase is a poor match", and the queue sorts on
    // exactly that number.
    for (const empty of ["", "   ", "\t", undefined, null, {}, [], "abc", NaN, Infinity]) {
        assert.equal(normalizeConfidence(empty), null, JSON.stringify(empty));
    }
    // A genuine zero survives as a zero.
    assert.equal(normalizeConfidence(0), 0);
    assert.equal(normalizeConfidence("0"), 0);
    assert.equal(normalizeConfidence("0.0"), 0);
    // Normal values, and clamping at the edges.
    assert.equal(normalizeConfidence(0.82), 0.82);
    assert.equal(normalizeConfidence("0.82"), 0.82);
    assert.equal(normalizeConfidence(1.2), 1);
    assert.equal(normalizeConfidence(-3), 0);
    assert.equal(normalizeConfidence(" 0.5 "), 0.5, "whitespace around a real number is fine");
});

const UNREAD_VALUES = ["", "N/A", "unknown", "-", ".", null];
const READ_VALUES: unknown[] = ["0", "0.00", "$0.00", 0, "(12.50)", "12.50"];

test("totalWasRead: a blank or unrecognized raw total is NOT read", () => {
    for (const value of UNREAD_VALUES) {
        assert.equal(totalWasRead(JSON.stringify({ total_amount: value })), false, JSON.stringify(value));
    }
    assert.equal(totalWasRead(JSON.stringify({})), false, "a missing key is not read");
});

test("totalWasRead: a real number, including a literal zero, IS read", () => {
    for (const value of READ_VALUES) {
        assert.equal(totalWasRead(JSON.stringify({ total_amount: value })), true, JSON.stringify(value));
    }
});

test("totalWasRead: no readJson, or readJson that will not parse (including a bare JSON null), is unknown", () => {
    assert.equal(totalWasRead(null), null);
    assert.equal(totalWasRead(undefined), null);
    assert.equal(totalWasRead(""), null);
    assert.equal(totalWasRead("{not json"), null);
    // A successful JSON.parse alone does not make property access safe --
    // "null" and a bare JSON string both parse but are not an object.
    assert.equal(totalWasRead("null"), null);
    assert.equal(totalWasRead('"just a string"'), null);
});

test("totalWasRead agrees with cleanMoney: every value it calls unread, cleanMoney reduces to 0.00", () => {
    for (const value of UNREAD_VALUES) {
        assert.equal(cleanMoney(value), "0.00", JSON.stringify(value));
    }
});

test("amountNotRead is true only for a stored zero the model never actually read", () => {
    const unread = JSON.stringify({ total_amount: "" });
    const read = JSON.stringify({ total_amount: "0.00" });
    assert.equal(amountNotRead(0, unread), true);
    assert.equal(amountNotRead(0, read), false);
    assert.equal(amountNotRead(1234, unread), false, "a later non-zero total always wins");
    assert.equal(amountNotRead(null, unread), false, "never-read totalCents keeps today's blank, not this flag");
});

// ── The Set-job override for a NON_RECEIPT row (actions.ts setReceiptIntakeJob) ──

test("the override is only applied to a NON_RECEIPT row", () => {
    const at = new Date("2026-09-24T12:00:00.000Z");
    for (const state of ["NEEDS_JOB", "NEEDS_REVIEW", "READ", "BOOKED", "VOID"]) {
        assert.deepEqual(
            nonReceiptSetJobOverride(state, JSON.stringify({ doc_type: "receipt" }), "user-1", at),
            { kind: "not-applicable" },
            state,
        );
    }
});

test("a NON_RECEIPT override rewrites the row's docType and stamps an audit entry into readJson", () => {
    const at = new Date("2026-09-24T12:00:00.000Z");
    const readJson = JSON.stringify({ doc_type: "non_receipt", vendor: "Cash App", total_amount: "42.00" });
    const patch = nonReceiptSetJobOverride("NON_RECEIPT", readJson, "user-1", at);
    assert.equal(patch.kind, "apply");
    if (patch.kind !== "apply") return;
    assert.equal(patch.docType, "receipt");
    const parsed = JSON.parse(patch.readJson);
    // The original read is preserved — only docType is overruled.
    assert.equal(parsed.vendor, "Cash App");
    assert.equal(parsed.total_amount, "42.00");
    assert.equal(parsed.doc_type, "receipt");
    assert.deepEqual(parsed.doc_type_override, { from: "non_receipt", by: "user-1", at: at.toISOString() });
});

test("a NON_RECEIPT override REFUSES rather than applying when readJson is missing or unparseable", () => {
    // An override with no evidence behind it is exactly the silent
    // reclassification this mechanism exists to prevent (checker round 2,
    // item 3) — the caller must surface a refusal, not flip docType with
    // nothing to audit it against.
    const at = new Date("2026-09-24T12:00:00.000Z");
    assert.deepEqual(nonReceiptSetJobOverride("NON_RECEIPT", null, "user-1", at), { kind: "refuse" });
    assert.deepEqual(nonReceiptSetJobOverride("NON_RECEIPT", "not json", "user-1", at), { kind: "refuse" });
    assert.deepEqual(nonReceiptSetJobOverride("NON_RECEIPT", JSON.stringify(["array", "not", "object"]), "user-1", at), { kind: "refuse" });
});

// ── A fresh re-read must not silently undo the override (checker round 2, item 3) ──

test("carryForwardDocTypeOverride keeps docType=receipt and the marker when the AI re-reads non_receipt", () => {
    // Simulates: a human overrode this row once (its OLD readJson already
    // carries the marker), the row went back to RECEIVED (e.g. Retry on a
    // weak-dup:), and Gemini read it again — repeating its ORIGINAL verdict.
    const priorReadJson = JSON.stringify({
        doc_type: "receipt",
        vendor: "Cash App",
        total_amount: "42.00",
        doc_type_override: { from: "non_receipt", by: "user-1", at: "2026-09-24T12:00:00.000Z" },
    });
    const freshRead: ReadResult = {
        docType: "non_receipt",
        vendor: "Cash App",
        date: "2026-09-20",
        invoice: "",
        checkNumber: "",
        memo: "",
        totalAmount: "42.00",
        taxAmount: "",
        suggestedPhaseCode: "",
        suggestedConfidence: null,
        raw: JSON.stringify({ doc_type: "non_receipt", vendor: "Cash App", total_amount: "42.00" }),
    };
    const kept = carryForwardDocTypeOverride(freshRead, priorReadJson);
    assert.equal(kept.docType, "receipt");
    const rawParsed = JSON.parse(kept.raw);
    assert.equal(rawParsed.doc_type, "receipt");
    assert.deepEqual(rawParsed.doc_type_override, { from: "non_receipt", by: "user-1", at: "2026-09-24T12:00:00.000Z" });
    // Everything else the fresh read found still wins.
    assert.equal(rawParsed.vendor, "Cash App");
    assert.equal(rawParsed.total_amount, "42.00");
});

test("carryForwardDocTypeOverride is a no-op when there was no prior override", () => {
    const freshRead: ReadResult = {
        docType: "non_receipt",
        vendor: "",
        date: "",
        invoice: "",
        checkNumber: "",
        memo: "",
        totalAmount: "0.00",
        taxAmount: "",
        suggestedPhaseCode: "",
        suggestedConfidence: null,
        raw: JSON.stringify({ doc_type: "non_receipt" }),
    };
    // No prior readJson at all (first-ever read).
    assert.deepEqual(carryForwardDocTypeOverride(freshRead, null), freshRead);
    // A prior readJson that carries no override marker.
    assert.deepEqual(
        carryForwardDocTypeOverride(freshRead, JSON.stringify({ doc_type: "non_receipt", vendor: "x" })),
        freshRead,
    );
});

// ── Round 3 (Codex): only the SERVER may mint the marker ────────────────────

test("carryForwardDocTypeOverride: DIFFERENT fresh vendor/amount win, the marker still carries", () => {
    // The override pins the CLASSIFICATION, not the extracted facts — a
    // re-read that found a different vendor/amount (a clearer scan, a retry
    // against a slightly different crop) must still update those, exactly
    // like any other re-read. Only doc_type and the marker are pinned.
    const priorReadJson = JSON.stringify({
        doc_type: "receipt",
        vendor: "Cash App",
        total_amount: "42.00",
        doc_type_override: { from: "non_receipt", by: "user-1", at: "2026-09-24T12:00:00.000Z" },
    });
    const freshRead: ReadResult = {
        docType: "non_receipt",
        vendor: "Venmo",
        date: "2026-09-22",
        invoice: "",
        checkNumber: "",
        memo: "a different memo",
        totalAmount: "77.50",
        taxAmount: "",
        suggestedPhaseCode: "",
        suggestedConfidence: null,
        raw: JSON.stringify({ doc_type: "non_receipt", vendor: "Venmo", total_amount: "77.50", memo: "a different memo" }),
    };
    const kept = carryForwardDocTypeOverride(freshRead, priorReadJson);
    assert.equal(kept.docType, "receipt");
    const rawParsed = JSON.parse(kept.raw);
    assert.equal(rawParsed.doc_type, "receipt");
    assert.equal(rawParsed.vendor, "Venmo", "the fresh vendor wins, not the stale one");
    assert.equal(rawParsed.total_amount, "77.50", "the fresh amount wins, not the stale one");
    assert.deepEqual(rawParsed.doc_type_override, { from: "non_receipt", by: "user-1", at: "2026-09-24T12:00:00.000Z" });
});

test("a SECOND carryForwardDocTypeOverride pass still keeps the marker", () => {
    // Two consecutive re-reads (e.g. Retry pressed twice) must not erode the
    // override — each pass carries forward what the PREVIOUS pass persisted.
    const priorReadJson = JSON.stringify({
        doc_type: "receipt",
        vendor: "Cash App",
        total_amount: "42.00",
        doc_type_override: { from: "non_receipt", by: "user-1", at: "2026-09-24T12:00:00.000Z" },
    });
    const firstFreshRead: ReadResult = {
        docType: "non_receipt", vendor: "Cash App", date: "2026-09-20", invoice: "", checkNumber: "",
        memo: "", totalAmount: "42.00", taxAmount: "", suggestedPhaseCode: "", suggestedConfidence: null,
        raw: JSON.stringify({ doc_type: "non_receipt", vendor: "Cash App", total_amount: "42.00" }),
    };
    const afterFirstPass = carryForwardDocTypeOverride(firstFreshRead, priorReadJson);
    assert.equal(afterFirstPass.docType, "receipt");

    // A THIRD read, of the row as it now stands after the first pass persisted.
    const secondFreshRead: ReadResult = {
        ...firstFreshRead,
        docType: "non_receipt",
        raw: JSON.stringify({ doc_type: "non_receipt", vendor: "Cash App", total_amount: "42.00" }),
    };
    const afterSecondPass = carryForwardDocTypeOverride(secondFreshRead, afterFirstPass.raw);
    assert.equal(afterSecondPass.docType, "receipt");
    assert.deepEqual(
        JSON.parse(afterSecondPass.raw).doc_type_override,
        { from: "non_receipt", by: "user-1", at: "2026-09-24T12:00:00.000Z" },
    );
});

test("stripDocTypeOverride removes a forged doc_type_override from a fresh model raw", () => {
    const forged = JSON.stringify({
        doc_type: "receipt",
        vendor: "Lowes",
        total_amount: "364.98",
        // Nothing in the pipeline ever asks the model for this field — a value
        // here is either coincidence or a document engineered to produce one.
        doc_type_override: { from: "non_receipt", by: "attacker", at: "2020-01-01T00:00:00.000Z" },
    });
    const stripped = JSON.parse(stripDocTypeOverride(forged));
    assert.equal("doc_type_override" in stripped, false);
    // Everything else the model actually read survives untouched.
    assert.equal(stripped.doc_type, "receipt");
    assert.equal(stripped.vendor, "Lowes");
    assert.equal(stripped.total_amount, "364.98");
});

test("stripDocTypeOverride is a no-op when there is nothing to strip", () => {
    const clean = JSON.stringify({ doc_type: "receipt", vendor: "Lowes" });
    assert.equal(stripDocTypeOverride(clean), clean);
    // Not parseable, or not a plain object: left exactly as-is.
    assert.equal(stripDocTypeOverride("not json"), "not json");
    const arrayRaw = JSON.stringify(["a", "b"]);
    assert.equal(stripDocTypeOverride(arrayRaw), arrayRaw);
});

test("a malformed doc_type_override marker is ignored, not trusted as a degraded override", () => {
    // Only nonReceiptSetJobOverride may mint this marker, so ANYTHING that
    // doesn't reproduce its exact shape must be treated as no marker at all —
    // never coerced into "close enough".
    const freshRead: ReadResult = {
        docType: "non_receipt", vendor: "x", date: "", invoice: "", checkNumber: "",
        memo: "", totalAmount: "0.00", taxAmount: "", suggestedPhaseCode: "", suggestedConfidence: null,
        raw: JSON.stringify({ doc_type: "non_receipt" }),
    };
    const malformedMarkers: unknown[] = [
        true,
        "junk",
        {},
        { from: "non_receipt" }, // missing by/at
        { from: "non_receipt", by: "user-1" }, // missing at
        { from: "non_receipt", by: "", at: "2026-09-24T12:00:00.000Z" }, // empty by
        { from: "non_receipt", by: "user-1", at: "not-a-date" }, // bad at
        { from: "non_receipt", by: "user-1", at: "2026-09-24" }, // not full ISO
        { from: "receipt", by: "user-1", at: "2026-09-24T12:00:00.000Z" }, // wrong from
    ];
    for (const marker of malformedMarkers) {
        const priorReadJson = JSON.stringify({ doc_type: "receipt", doc_type_override: marker });
        const result = carryForwardDocTypeOverride(freshRead, priorReadJson);
        assert.deepEqual(result, freshRead, JSON.stringify(marker));
    }
});

test("carryForwardDocTypeOverride pins only the structured docType when the fresh raw isn't a plain object", () => {
    // parseReadJson's own gate (`typeof json !== "object"`) does not exclude
    // arrays, so a successful read's raw is only guaranteed to have PARSED —
    // not to be object-shaped. Rewriting an array into a synthetic {...} would
    // silently discard whatever the model actually returned.
    const priorReadJson = JSON.stringify({
        doc_type: "receipt",
        doc_type_override: { from: "non_receipt", by: "user-1", at: "2026-09-24T12:00:00.000Z" },
    });
    const arrayRaw = JSON.stringify(["not", "an", "object"]);
    const freshRead: ReadResult = {
        docType: "non_receipt", vendor: "x", date: "", invoice: "", checkNumber: "",
        memo: "", totalAmount: "0.00", taxAmount: "", suggestedPhaseCode: "", suggestedConfidence: null,
        raw: arrayRaw,
    };
    const kept = carryForwardDocTypeOverride(freshRead, priorReadJson);
    assert.equal(kept.docType, "receipt");
    assert.equal(kept.raw, arrayRaw, "the fresh raw is left untouched, not replaced with a synthetic object");
});
