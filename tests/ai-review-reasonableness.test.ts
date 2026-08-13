import assert from "node:assert/strict";
import test from "node:test";
import { parseReasonablenessJson } from "../src/app/api/automation/ai-review/route";

// ── parseReasonablenessJson — the "reasonable purchase" verdict's fail-closed
// parsing path. This is the ONLY part of the feature that's unit-testable
// without a live model call (the route wraps everything else — the Gemini
// call itself, and the DB reads that build its input — in their own
// try/catch and always resolve to the same "unknown" verdict on failure; see
// `judgeReasonableness`/`computeReasonableness` in route.ts). A regression
// here is exactly the kind of bug that would let a garbage model response
// pass through as a real verdict instead of failing closed.

test("parses a clean, well-formed verdict", () => {
    const result = parseReasonablenessJson('{"verdict": "reasonable", "rationale": "normal vendor for this job"}');
    assert.deepEqual(result, { verdict: "reasonable", rationale: "normal vendor for this job" });
});

test("parses each of the three model-facing verdicts", () => {
    for (const verdict of ["reasonable", "question", "flag"]) {
        const result = parseReasonablenessJson(`{"verdict": "${verdict}", "rationale": "some reason"}`);
        assert.equal(result?.verdict, verdict);
    }
});

test("extracts JSON embedded in surrounding prose, same as parseModelJson's contract", () => {
    const text = 'Here is my answer:\n{"verdict": "flag", "rationale": "10x this vendor\'s typical amount"}\nHope that helps.';
    const result = parseReasonablenessJson(text);
    assert.deepEqual(result, { verdict: "flag", rationale: "10x this vendor's typical amount" });
});

test("returns null for text with no JSON object at all", () => {
    assert.equal(parseReasonablenessJson("I cannot evaluate this."), null);
    assert.equal(parseReasonablenessJson(""), null);
});

test("returns null for malformed JSON", () => {
    assert.equal(parseReasonablenessJson('{"verdict": "flag", "rationale": '), null);
});

test("returns null when verdict is missing or not one of the three recognized values — never coerces 'unknown' or a typo through", () => {
    assert.equal(parseReasonablenessJson('{"rationale": "no verdict field"}'), null);
    assert.equal(parseReasonablenessJson('{"verdict": "unknown", "rationale": "x"}'), null);
    assert.equal(parseReasonablenessJson('{"verdict": "Reasonable", "rationale": "x"}'), null); // case-sensitive
    assert.equal(parseReasonablenessJson('{"verdict": "maybe", "rationale": "x"}'), null);
    assert.equal(parseReasonablenessJson('{"verdict": 1, "rationale": "x"}'), null);
});

test("returns null when rationale is missing, blank, or not a string — a verdict with no explanation is not a usable read", () => {
    assert.equal(parseReasonablenessJson('{"verdict": "flag"}'), null);
    assert.equal(parseReasonablenessJson('{"verdict": "flag", "rationale": ""}'), null);
    assert.equal(parseReasonablenessJson('{"verdict": "flag", "rationale": "   "}'), null);
    assert.equal(parseReasonablenessJson('{"verdict": "flag", "rationale": 42}'), null);
});

test("returns null for a JSON array or a bare scalar, not just non-object garbage", () => {
    assert.equal(parseReasonablenessJson('["reasonable", "why"]'), null);
    assert.equal(parseReasonablenessJson("42"), null);
});

test("trims whitespace and caps an oversized rationale at 300 characters", () => {
    const long = "a".repeat(500);
    const result = parseReasonablenessJson(`{"verdict": "question", "rationale": "  ${long}  "}`);
    assert.equal(result?.rationale.length, 300);
    assert.equal(result?.rationale, long.slice(0, 300));
});
