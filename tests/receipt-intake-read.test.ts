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
import { buildReadPrompt, parseReadJson, readReceipt } from "../src/lib/receipt-intake/read";

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
