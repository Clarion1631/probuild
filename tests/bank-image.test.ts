import assert from "node:assert/strict";
import test from "node:test";
import {
    proposeImageMatches,
    linesNeedingImages,
    DEPOSIT_DAY_WINDOW,
    type BankImageCandidate,
    type BankImageLine,
} from "@/lib/bank-image";

// Fixture note: the check and deposit below are the REAL unexplained lines
// sitting in the GTR ledger on 2026-08-19 — a $6,037.15 check #1027 with no
// payee, and a $15,723.38 deposit that matches no milestone. They are the
// reason this module exists.

const checkLine: BankImageLine = {
    id: "line-check",
    postedDate: "2026-08-13",
    amountCents: -603715,
    rawDescriptor: "CHECK PAID CHECK",
    checkNumber: "1027",
};

const depositLine: BankImageLine = {
    id: "line-deposit",
    postedDate: "2026-08-17",
    amountCents: 1572338,
    rawDescriptor: "OTHER DEPOSITS DEPOSIT - DDA/MMKT",
    checkNumber: null,
};

const cardLine: BankImageLine = {
    id: "line-card",
    postedDate: "2026-08-17",
    amountCents: -47464,
    rawDescriptor: "MISCELLANEOUS DEBIT LOWE S #1632 POS DEB 1016 C#6098",
    checkNumber: null,
};

const checkImage = (over: Partial<BankImageCandidate> = {}): BankImageCandidate => ({
    id: "img-1",
    kind: "CHECK_FRONT",
    documentDate: "2026-08-12",
    amountCents: 603715,
    normalizedCheckNumber: "1027",
    ...over,
});

const depositImage = (over: Partial<BankImageCandidate> = {}): BankImageCandidate => ({
    id: "img-dep",
    kind: "DEPOSIT_SLIP",
    documentDate: "2026-08-17",
    amountCents: 1572338,
    normalizedCheckNumber: null,
    ...over,
});

test("a check image is matched by number AND amount", () => {
    const { proposals, unmatched } = proposeImageMatches([checkImage()], [checkLine, depositLine, cardLine]);
    assert.equal(unmatched.length, 0);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].bankLineId, "line-check");
    assert.equal(proposals[0].confidence, "check_number_and_amount");
    assert.equal(proposals[0].checkNumber, "1027");
});

test("a number match with the WRONG amount is flagged, not silently accepted", () => {
    // This is the shape of a bank restatement or a misread digit — exactly
    // what the images exist to catch.
    const { proposals } = proposeImageMatches([checkImage({ amountCents: 500000 })], [checkLine]);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].confidence, "check_number_amount_mismatch");
    assert.match(proposals[0].reason, /CHECK THIS/);
});

test("magnitude is compared, not sign — the line is negative, the image positive", () => {
    const { proposals } = proposeImageMatches([checkImage()], [checkLine]);
    assert.equal(proposals[0].lineAmountCents, -603715);
    assert.equal(proposals[0].imageAmountCents, 603715);
    assert.equal(proposals[0].confidence, "check_number_and_amount");
});

test("check numbers with leading zeros are one identity", () => {
    // The daily CSV, monthly PDF and QBO parsers all strip leading zeros;
    // an image that says "01027" must land on the same line.
    const { proposals } = proposeImageMatches(
        [checkImage({ normalizedCheckNumber: "1027" })],
        [{ ...checkLine, checkNumber: "1027" }],
    );
    assert.equal(proposals.length, 1);
});

test("two lines with the same check number are ambiguous, never guessed", () => {
    const dupe: BankImageLine = { ...checkLine, id: "line-check-2" };
    const { proposals, unmatched } = proposeImageMatches([checkImage()], [checkLine, dupe]);
    assert.equal(proposals.length, 0);
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].reason, "ambiguous");
    assert.deepEqual(unmatched[0].candidateLineIds, ["line-check", "line-check-2"]);
});

test("a check image with no matching line is reported, not dropped", () => {
    const { proposals, unmatched } = proposeImageMatches([checkImage({ normalizedCheckNumber: "9999" })], [checkLine]);
    assert.equal(proposals.length, 0);
    assert.equal(unmatched[0].reason, "no_candidate");
    assert.match(unmatched[0].detail, /9999/);
});

test("deposits match on amount within a tight date window", async t => {
    await t.test("exact amount, same day", () => {
        const { proposals } = proposeImageMatches([depositImage()], [depositLine, cardLine]);
        assert.equal(proposals.length, 1);
        assert.equal(proposals[0].bankLineId, "line-deposit");
        assert.equal(proposals[0].confidence, "amount_and_date_unique");
        assert.equal(proposals[0].dayDelta, 0);
    });

    await t.test("a deposit two days later still matches", () => {
        const { proposals } = proposeImageMatches(
            [depositImage({ documentDate: "2026-08-15" })],
            [depositLine],
        );
        assert.equal(proposals.length, 1);
        assert.equal(proposals[0].dayDelta, 2);
    });

    await t.test("outside the window it does NOT match", () => {
        const { proposals, unmatched } = proposeImageMatches(
            [depositImage({ documentDate: "2026-08-01" })],
            [depositLine],
        );
        assert.equal(proposals.length, 0);
        assert.equal(unmatched[0].reason, "no_candidate");
    });

    await t.test("one cent off does NOT match", () => {
        const { proposals } = proposeImageMatches([depositImage({ amountCents: 1572339 })], [depositLine]);
        assert.equal(proposals.length, 0);
    });

    await t.test("two same-amount deposits in the window are ambiguous", () => {
        const twin: BankImageLine = { ...depositLine, id: "line-deposit-2", postedDate: "2026-08-16" };
        const { proposals, unmatched } = proposeImageMatches([depositImage()], [depositLine, twin]);
        assert.equal(proposals.length, 0);
        assert.equal(unmatched[0].reason, "ambiguous");
        assert.equal(unmatched[0].candidateLineIds.length, 2);
    });
});

test("a deposit image with no amount or date cannot be matched", async t => {
    await t.test("no amount", () => {
        const { unmatched } = proposeImageMatches([depositImage({ amountCents: null })], [depositLine]);
        assert.equal(unmatched[0].reason, "insufficient_data");
    });
    await t.test("no date", () => {
        const { unmatched } = proposeImageMatches([depositImage({ documentDate: null })], [depositLine]);
        assert.equal(unmatched[0].reason, "insufficient_data");
    });
});

test("an already-confirmed image is never re-proposed", () => {
    const { proposals, unmatched } = proposeImageMatches(
        [checkImage()],
        [checkLine],
        { alreadyMatchedImageIds: ["img-1"] },
    );
    assert.equal(proposals.length, 0);
    assert.equal(unmatched.length, 0, "a human's decision is not re-litigated, not even as an unmatched row");
});

test("output is deterministic regardless of input order", () => {
    const images = [checkImage(), depositImage()];
    const lines = [checkLine, depositLine, cardLine];
    const a = JSON.stringify(proposeImageMatches(images, lines));
    const b = JSON.stringify(proposeImageMatches([...images].reverse(), [...lines].reverse()));
    assert.equal(a, b);
});

test("linesNeedingImages finds exactly the lines the CSV cannot explain", () => {
    const need = linesNeedingImages([checkLine, depositLine, cardLine]);
    const ids = need.map(l => l.id).sort();
    assert.deepEqual(ids, ["line-check", "line-deposit"]);
    // A card purchase names its merchant — it needs a RECEIPT, not an image.
    assert.ok(!ids.includes("line-card"));
});

test("the default deposit window is tight enough to be meaningful", () => {
    assert.ok(DEPOSIT_DAY_WINDOW <= 5, "a wide window makes amount collisions likely");
});

test("empty inputs are handled", () => {
    assert.deepEqual(proposeImageMatches([], []), { proposals: [], unmatched: [] });
    assert.deepEqual(linesNeedingImages([]), []);
});
