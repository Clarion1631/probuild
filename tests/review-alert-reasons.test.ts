import assert from "node:assert/strict";
import test from "node:test";
import {
    canonicalizeReasonCodes,
    decodeReasonCodes,
    deriveReasonCodes,
    encodeReasonCodes,
    hashReasonCodes,
    type ReasonCode,
} from "../src/lib/review-alert-reasons";
import type { MergedRegisterRow, RegisterEdges } from "../src/lib/register-merge";

// Unified Money Register plan §4 (punch 9): reason codes are stable enum-like
// strings, canonical-JSON encoded (sorted + deduped) and hashed with an
// UNTRUNCATED SHA-256 — never a comma-joined string (collides) and never
// hashing display text (churns a new generation on every evaluation).

test("canonicalizeReasonCodes sorts and dedupes", () => {
    const codes: ReasonCode[] = ["UNCLASSIFIED", "NO_RECEIPT", "NO_RECEIPT", "AMOUNT_MISMATCH"];
    assert.deepEqual(canonicalizeReasonCodes(codes), ["AMOUNT_MISMATCH", "NO_RECEIPT", "UNCLASSIFIED"]);
});

test("encodeReasonCodes / decodeReasonCodes round-trip through canonical JSON", () => {
    const codes: ReasonCode[] = ["NO_JOB_COST", "NO_RECEIPT"];
    const json = encodeReasonCodes(codes);
    assert.equal(json, JSON.stringify(["NO_JOB_COST", "NO_RECEIPT"]));
    assert.deepEqual(decodeReasonCodes(json), ["NO_JOB_COST", "NO_RECEIPT"]);
});

test("decodeReasonCodes fails closed to [] on malformed JSON, never throws", () => {
    assert.deepEqual(decodeReasonCodes("not json"), []);
    assert.deepEqual(decodeReasonCodes("{}"), []);
    assert.deepEqual(decodeReasonCodes('["NO_RECEIPT", "bogus-code", 42]'), ["NO_RECEIPT"]);
});

test("hashReasonCodes is order-independent and untruncated (64 hex chars)", () => {
    const a = hashReasonCodes(["NO_RECEIPT", "NO_JOB_COST"]);
    const b = hashReasonCodes(["NO_JOB_COST", "NO_RECEIPT"]);
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.match(a, /^[0-9a-f]{64}$/);
});

test("hashReasonCodes never collides across a comma-join-style ambiguity", () => {
    // The exact case punch 9 calls out: ["a,b","c"] vs ["a","b,c"] collide
    // under naive comma-joining. Reason codes are a closed enum so literal
    // commas can't appear, but the canonical-JSON encoding is what actually
    // prevents this class of bug — assert the encoding is unambiguous JSON,
    // not a delimiter-joined string.
    const json = encodeReasonCodes(["NO_RECEIPT", "NO_JOB_COST"]);
    assert.ok(json.startsWith("[") && json.endsWith("]"));
    assert.deepEqual(JSON.parse(json), ["NO_JOB_COST", "NO_RECEIPT"]);
});

// ── deriveReasonCodes ─────────────────────────────────────────────────────────

type RowInput = Pick<MergedRegisterRow, "status" | "classification" | "edges">;

const PASS_EDGES: RegisterEdges = { receipt: "pass", receiptUnconfirmed: false, jobCost: "pass", amount: "pass" };

test("deriveReasonCodes returns [] for every non-needs-review status", () => {
    const statuses: MergedRegisterRow["status"][] = [
        "documented",
        "job-cost-matched",
        "not-applicable",
        "unclassifiable",
    ];
    for (const status of statuses) {
        const row: RowInput = { status, classification: "job-cost", edges: PASS_EDGES };
        assert.deepEqual(deriveReasonCodes(row), [], `status ${status} must never alert`);
    }
});

test("deriveReasonCodes: classification conflict (overhead/owner-draw matched to a job cost)", () => {
    for (const classification of ["overhead", "owner-draw"] as const) {
        const row: RowInput = { status: "needs-review", classification, edges: PASS_EDGES };
        assert.deepEqual(deriveReasonCodes(row), ["CLASSIFICATION_CONFLICT"]);
    }
});

test("deriveReasonCodes: never classified", () => {
    const row: RowInput = { status: "needs-review", classification: "unknown", edges: null };
    assert.deepEqual(deriveReasonCodes(row), ["UNCLASSIFIED"]);
});

test("deriveReasonCodes: job-cost classified, no job-cost match at all", () => {
    const row: RowInput = {
        status: "needs-review",
        classification: "job-cost",
        edges: { receipt: "unknown", receiptUnconfirmed: false, jobCost: "fail", amount: "n/a" },
    };
    assert.deepEqual(deriveReasonCodes(row), ["NO_RECEIPT", "NO_JOB_COST"]);
});

test("deriveReasonCodes: job-cost classified, matched but amount mismatch, receipt confirmed", () => {
    const row: RowInput = {
        status: "needs-review",
        classification: "job-cost",
        edges: { receipt: "pass", receiptUnconfirmed: false, jobCost: "pass", amount: "fail" },
    };
    assert.deepEqual(deriveReasonCodes(row), ["AMOUNT_MISMATCH"]);
});

test("deriveReasonCodes: job-cost classified, matched, amount indeterminate — never mismatch, never silent pass", () => {
    const row: RowInput = {
        status: "needs-review",
        classification: "job-cost",
        edges: { receipt: "pass", receiptUnconfirmed: false, jobCost: "pass", amount: "indeterminate" },
    };
    assert.deepEqual(deriveReasonCodes(row), ["AMOUNT_INDETERMINATE"]);
});

test("deriveReasonCodes: job-cost classified, matched + amount pass, receipt unresolved but job-cost/amount fine — only NO_RECEIPT", () => {
    // register-merge.ts's "job-cost-matched" status (receipt unknown, jobCost+
    // amount pass) is excluded before status ever reaches "needs-review", so
    // this exact combination is never actually seen here — this asserts the
    // fallback shape stays correct if it somehow were.
    const row: RowInput = {
        status: "needs-review",
        classification: "job-cost",
        edges: { receipt: "unknown", receiptUnconfirmed: true, jobCost: "pass", amount: "pass" },
    };
    assert.deepEqual(deriveReasonCodes(row), ["NO_RECEIPT"]);
});

test("deriveReasonCodes: reversal / sign-type conflict / unrecognized outflow — no classification record", () => {
    const row: RowInput = { status: "needs-review", classification: null, edges: PASS_EDGES };
    assert.deepEqual(deriveReasonCodes(row), ["UNRECOGNIZED_OUTFLOW"]);
});

test("deriveReasonCodes: needs-review with no edges at all (null qbTxnId path) still returns a non-empty code", () => {
    const row: RowInput = { status: "needs-review", classification: null, edges: null };
    assert.deepEqual(deriveReasonCodes(row), ["UNRECOGNIZED_OUTFLOW"]);
});
