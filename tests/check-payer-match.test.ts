import assert from "node:assert/strict";
import test from "node:test";
import {
    nameTokens,
    nameSimilarity,
    suggestMatches,
    normalizeCheckRef,
    SUGGESTION_THRESHOLD,
} from "@/lib/check-payer-match";
// The CLI script is the original implementation; the lib is its TS port for
// the Automation panel. This import keeps the two honest against each other.
import {
    nameTokens as mjsNameTokens,
    nameSimilarity as mjsNameSimilarity,
    suggestMatches as mjsSuggestMatches,
} from "../scripts/extract-check-payers.mjs";

// The REAL extracted row that motivated this feature (prod, 2026-08-21):
// payer "GOLDEN TOUCH RMEODELING LLC" (typo and all), memo
// "HOPPE VANITY CONTRACT 4152", check #1027.
const REAL_PAYER = "GOLDEN TOUCH RMEODELING LLC";
const REAL_MEMO = "HOPPE VANITY CONTRACT 4152";

const clients = [
    { id: "c1", name: "Golden Touch Remodeling" },
    { id: "c2", name: "Sandi Christensen" },
    { id: "c3", name: "Mesplay" },
];

const projects = [
    { id: "p1", name: "Hoppe Vanity" },
    { id: "p2", name: "Christensen Kitchen" },
    { id: "p3", name: "Shop" },
];

test("nameTokens drops entity noise and punctuation", () => {
    assert.deepEqual(nameTokens("GOLDEN TOUCH RMEODELING LLC"), ["golden", "touch", "rmeodeling"]);
    assert.deepEqual(nameTokens("The Smith & Jones Co."), ["smith", "jones"]);
    assert.deepEqual(nameTokens(null), []);
    assert.deepEqual(nameTokens(""), []);
});

test("nameSimilarity: identical token sets score 1, disjoint score 0", () => {
    assert.equal(nameSimilarity("Hoppe Vanity", "Vanity Hoppe"), 1);
    assert.equal(nameSimilarity("Mesplay", "Christensen"), 0);
    assert.equal(nameSimilarity(null, "anything"), 0);
    assert.equal(nameSimilarity("anything", ""), 0);
});

test("memo naming the job outranks unrelated projects", () => {
    const { memoMatches } = suggestMatches({ payerName: null, memoText: REAL_MEMO }, clients, projects);
    assert.ok(memoMatches.length >= 1);
    assert.equal(memoMatches[0].id, "p1");
    assert.ok(memoMatches[0].score >= SUGGESTION_THRESHOLD);
});

test("payer with a typo still finds the client via shared tokens", () => {
    const { payerMatches } = suggestMatches({ payerName: REAL_PAYER, memoText: null }, clients, projects);
    assert.ok(payerMatches.length >= 1);
    assert.equal(payerMatches[0].id, "c1");
});

test("null payer AND memo yield no suggestions — never a guess", () => {
    const { payerMatches, memoMatches } = suggestMatches({ payerName: null, memoText: null }, clients, projects);
    assert.deepEqual(payerMatches, []);
    assert.deepEqual(memoMatches, []);
});

test("scores below the threshold are dropped entirely", () => {
    const { payerMatches } = suggestMatches(
        { payerName: "Totally Unrelated Person", memoText: null },
        clients,
        projects,
    );
    assert.deepEqual(payerMatches, []);
});

test("normalizeCheckRef: digits only, leading zeros stripped, empty is null", () => {
    assert.equal(normalizeCheckRef("chk #01027"), "1027");
    assert.equal(normalizeCheckRef("1027"), "1027");
    assert.equal(normalizeCheckRef("0000"), null);
    assert.equal(normalizeCheckRef(""), null);
    assert.equal(normalizeCheckRef(null), null);
    assert.equal(normalizeCheckRef("no digits"), null);
});

// ── parity with the CLI script — the port must not drift ─────────────────
test("lib agrees with scripts/extract-check-payers.mjs on tokens and similarity", () => {
    const samples: Array<[string, string]> = [
        [REAL_PAYER, "Golden Touch Remodeling"],
        [REAL_MEMO, "Hoppe Vanity"],
        ["Sandi Christensen", "Christensen Kitchen"],
        ["The Smith & Jones Co.", "Smith Residence"],
        ["", "anything"],
    ];
    for (const [a, b] of samples) {
        assert.deepEqual(nameTokens(a), mjsNameTokens(a), `tokens drifted for "${a}"`);
        assert.equal(nameSimilarity(a, b), mjsNameSimilarity(a, b), `similarity drifted for "${a}" vs "${b}"`);
    }
    const libResult = suggestMatches({ payerName: REAL_PAYER, memoText: REAL_MEMO }, clients, projects);
    const mjsResult = mjsSuggestMatches({ payerName: REAL_PAYER, memoText: REAL_MEMO }, clients, projects);
    assert.deepEqual(
        libResult.payerMatches.map(m => [m.id, m.score]),
        mjsResult.payerMatches.map((m: { id: string; score: number }) => [m.id, m.score]),
    );
    assert.deepEqual(
        libResult.memoMatches.map(m => [m.id, m.score]),
        mjsResult.memoMatches.map((m: { id: string; score: number }) => [m.id, m.score]),
    );
});
