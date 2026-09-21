/**
 * The corrected weak-net invariant: a weak twin blocks promotion ONLY when the
 * two rows are not already distinguished by their own reference numbers.
 *
 * Pure functions throughout, so every case here is the real decision and not a
 * model of it. No `mock.module` (CI is Node 20); nothing to mock anyway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    confusionNormalizeRef,
    hasRealRef,
    judgeWeakGroup,
    MAX_WEAK_GROUP,
    refsAreConfusable,
    twinIsDistinct,
    type WeakGroupRow,
} from "../src/lib/receipt-intake/weak-net";

function row(id: string, refNumber: string | null): WeakGroupRow {
    return { id, refNumber, resolution: null };
}

test("normalization folds letters onto digits, and nothing else", () => {
    // The counter-case: one purchase photographed twice, the "8" read as a "B"
    // on one of them. Both collapse to the same string.
    assert.equal(confusionNormalizeRef("INV-95B70"), "1NV95870");
    assert.equal(confusionNormalizeRef("INV-95870"), "1NV95870");

    // The Tapani case. NOTE the "B" here folds to 8 as well: the rule is
    // letter-to-digit across the board, so "TEBO" becomes "TE80". (The design
    // spec's worked table prints "TEB0" for this row, which is that table
    // applying O->0 and forgetting B->8. The verdict is the same either way,
    // which is what the next test pins.)
    assert.equal(confusionNormalizeRef("tebo-4261862"), "TE804261862");

    assert.equal(confusionNormalizeRef(""), "");
    assert.equal(confusionNormalizeRef(null), "");
    assert.equal(confusionNormalizeRef(undefined), "");

    // Every mapped letter, in one string, and nothing else moved.
    assert.equal(confusionNormalizeRef("OQILSBZG"), "00115826");
    assert.equal(confusionNormalizeRef("ACDEFHJKMNPRTUVWXY"), "ACDEFHJKMNPRTUVWXY");

    // DIGITS ARE NEVER FOLDED ONTO EACH OTHER. Sequential ticket numbers differ
    // only in their digits, so a 6<->8 rule would re-break the case this
    // module exists to fix.
    assert.equal(confusionNormalizeRef("4261862"), "4261862");
    assert.notEqual(confusionNormalizeRef("4261862"), confusionNormalizeRef("4261886"));
});

test("confusable is every way one ref could be a misread of the other", () => {
    // The five worked rows from the design spec, in order.
    assert.equal(refsAreConfusable("tebo-4261862", "tebo-4261886"), false, "the Tapani case: two tickets");
    assert.equal(refsAreConfusable("INV-95870", "INV-95B70"), true, "the counter-case: one purchase, two reads");
    assert.equal(refsAreConfusable("95870", "9587"), true, "a truncated read");
    assert.equal(refsAreConfusable("Check1041", "Check1042"), false, "two cheques");
    // "NoInv" is not a confusion question at all — it is a missing ref, caught
    // one level up by hasRealRef. The pair itself reads as different.
    assert.equal(refsAreConfusable("NoInv", "4261862"), false);

    // Empty on either side means we cannot tell, which parks.
    assert.equal(refsAreConfusable("", "4261862"), true);
    assert.equal(refsAreConfusable("4261862", ""), true);
    assert.equal(refsAreConfusable(null, null), true);
    assert.equal(refsAreConfusable("---", "4261862"), true, "punctuation only normalizes to nothing");

    // Containment at EITHER end, since a read can lose a prefix as easily as a
    // suffix.
    assert.equal(refsAreConfusable("9587", "95870"), true, "suffix-truncated, argument order reversed");
    assert.equal(refsAreConfusable("95870", "5870"), true, "a dropped leading digit");

    // Symmetric by construction; asserted rather than assumed.
    for (const [a, b] of [
        ["tebo-4261862", "tebo-4261886"],
        ["INV-95870", "INV-95B70"],
        ["95870", "9587"],
        ["Check1041", "Check1042"],
        ["", "4261862"],
    ] as const) {
        assert.equal(refsAreConfusable(a, b), refsAreConfusable(b, a), `${a} / ${b}`);
    }
});

test("a real ref is the same test that decides whether a strong key may be minted", () => {
    for (const bad of ["NoInv", "CheckNoNum", "0000", "ab", "", null]) {
        assert.equal(hasRealRef(row("r", bad)), false, String(bad));
    }
    for (const good of ["4261862", "INV-95870", "Check1041"]) {
        assert.equal(hasRealRef(row("r", good)), true, good);
    }
});

test("twinIsDistinct needs a real ref on BOTH sides, and is symmetric", () => {
    const table: Array<[string | null, string | null, boolean]> = [
        ["4261862", "4261886", true],
        ["INV-95870", "INV-95B70", false],
        ["NoInv", "4261862", false],
        ["4261862", "NoInv", false],
        ["NoInv", "NoInv", false],
        [null, "4261862", false],
        ["Check1041", "Check1042", true],
        ["95870", "9587", false],
    ];
    for (const [a, b, expected] of table) {
        assert.equal(twinIsDistinct(row("a", a), row("b", b)), expected, `${a} / ${b}`);
        assert.equal(
            twinIsDistinct(row("b", b), row("a", a)),
            expected,
            `${a} / ${b} reversed — the predicate must not depend on which row is "self"`,
        );
    }
});

test("no twins is distinct, and names nobody", () => {
    assert.deepEqual(
        judgeWeakGroup(row("self", "4261862"), []),
        { kind: "distinct", twinIds: [] },
    );
});

test("one twin: distinct refs clear it, confusable refs park on it", () => {
    assert.deepEqual(
        judgeWeakGroup(row("self", "tebo-4261862"), [row("twin", "tebo-4261886")]),
        { kind: "distinct", twinIds: ["twin"] },
    );
    assert.deepEqual(
        judgeWeakGroup(row("self", "INV-95870"), [row("twin", "INV-95B70")]),
        { kind: "park", twinId: "twin" },
    );
    // No readable ref on the twin: the weak key is the only evidence either
    // way, which is exactly the case the weak net exists for.
    assert.deepEqual(
        judgeWeakGroup(row("self", "4261862"), [row("twin", "NoInv")]),
        { kind: "park", twinId: "twin" },
    );
});

test("EVERY twin must be distinct, and the park names the one that is not", () => {
    // THE QUANTIFIER TEST. Two of these three are provably different purchases
    // and one is not. A findFirst-shaped rule — "take a twin, decide on it" —
    // answers "distinct" whenever the query happens to return b or c first,
    // and books a document that may already be booked.
    const verdict = judgeWeakGroup(row("self", "4261862"), [
        row("b", "4261886"),
        row("c", "4261901"),
        row("d", "4261B62"),
    ]);
    assert.deepEqual(verdict, { kind: "park", twinId: "d" }, "and it points at d, the one that stopped it");

    // The same group without d clears in full, so the park above is d's doing
    // and not an artefact of the group's size.
    assert.deepEqual(
        judgeWeakGroup(row("self", "4261862"), [row("b", "4261886"), row("c", "4261901")]),
        { kind: "distinct", twinIds: ["b", "c"] },
    );
});

test("an over-large weak group goes to a person whatever the refs say", () => {
    assert.equal(MAX_WEAK_GROUP, 10);
    const distinctTwins = Array.from({ length: MAX_WEAK_GROUP + 1 }, (_, i) => row(`t${i}`, `426180${i}`));

    const parked = judgeWeakGroup(row("self", "4261862"), distinctTwins);
    assert.deepEqual(parked, { kind: "park", twinId: "t0" }, "the oldest twin, which is the order both call sites fetch in");

    // One fewer, and the identical refs clear: the cap is the only thing that
    // stopped it.
    assert.equal(judgeWeakGroup(row("self", "4261862"), distinctTwins.slice(0, MAX_WEAK_GROUP)).kind, "distinct");
});
