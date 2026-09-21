/**
 * `stateReason` in plain words. Pure, so every case here is the real string the
 * Receipts tab draws. No `mock.module` (CI is Node 20).
 *
 * Two properties matter as much as the wording: an unknown code is never
 * hidden, and no sentence uses a dash as punctuation (message-voice rules).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { describeStateReason, type ReasonTextRow } from "../src/lib/receipt-intake/reason-text";

const ROW: ReasonTextRow = {
    vendor: "Sunbelt Rentals",
    txnDate: "2026-09-17",
    totalCents: 159703,
    createdAt: "2026-09-21T16:00:00.000Z",
};

/** Every reason this renderer claims to know, with the phrase that identifies it. */
const KNOWN: Array<[string, string]> = [
    ["weak-dup:cmg8x2q0000abcd", "Might be the same purchase as another receipt."],
    ["strong-dup-amount-mismatch:cmg8x2q0000abcd", "Same invoice number as another receipt but a different total."],
    ["vendor-mismatch:cmg8x2q0000abcd", "but a different vendor name."],
    ["date-implausible", "which is 4 days before it arrived."],
    ["invalid-date", "I could not read a date on this one."],
    ["multi-doc", "This file has more than one receipt in it."],
    ["multi-doc:one-page", "Several receipts are on one page, so I cannot split them."],
    ["refund-or-zero", "The total reads as $1,597.03."],
    ["no-estimate", "No job on this one yet."],
    ["unreadable", "I could not read this file."],
    ["ai-unavailable", "The reader was down when this one came through."],
    ["file-missing", "The file never landed in storage."],
    ["max-retries", "tried to book too many times and gave up."],
    ["push-paused", "Booking is paused right now."],
    ["push-disabled", "Booking is switched off right now."],
    ["native-qbo-reconciliation-required", "Check QuickBooks before it books here."],
    ["qbo-purchase-mismatch:vendor,total", "QuickBooks already has this purchase"],
];

test("every known reason gets its own sentence, and keeps its raw code", () => {
    for (const [reason, phrase] of KNOWN) {
        const described = describeStateReason(reason, ROW);
        assert.ok(described, reason);
        assert.ok(
            described.headline.includes(phrase),
            `${reason}: expected the sentence to contain "${phrase}", got "${described.headline}"`,
        );
        assert.equal(described.raw, reason, "the exact column value travels with it");
        assert.notEqual(described.headline, described.raw, `${reason} should not fall through`);
    }
});

test("no sentence uses a dash as punctuation", () => {
    // The house rule, enforced rather than reviewed. Hyphens INSIDE a token
    // (a date, a reason code) are fine; a dash standing in for a comma is not.
    for (const [reason] of KNOWN) {
        const { headline } = describeStateReason(reason, ROW)!;
        assert.ok(!headline.includes("—"), `${reason}: em dash`);
        assert.ok(!headline.includes("–"), `${reason}: en dash`);
        assert.ok(!headline.includes(" - "), `${reason}: spaced hyphen`);
    }
});

test("a reason we have no words for is shown exactly as it is", () => {
    // NEVER hidden behind a vague summary: a code nobody wrote a sentence for
    // is still the only thing that says what happened.
    const described = describeStateReason("qbo-fault:503", ROW);
    assert.deepEqual(described, { headline: "qbo-fault:503", raw: "qbo-fault:503" });
    assert.deepEqual(
        describeStateReason("something-nobody-has-seen", ROW),
        { headline: "something-nobody-has-seen", raw: "something-nobody-has-seen" },
    );
});

test("no reason at all is nothing to say", () => {
    assert.equal(describeStateReason(null, ROW), null);
    assert.equal(describeStateReason("", ROW), null);
    assert.equal(describeStateReason("   ", ROW), null);
});

test("the tax note riding along does not hide the reason underneath it", () => {
    // worker.ts's note() appends ";tax-implausible" to whatever routing decided,
    // so the code being described is the first segment. The raw value is still
    // rendered in full beside the sentence, so nothing is lost.
    const described = describeStateReason("weak-dup:cmg8x2q0000abcd;tax-implausible", ROW);
    assert.ok(described?.headline.startsWith("Might be the same purchase"));
    assert.equal(described?.raw, "weak-dup:cmg8x2q0000abcd;tax-implausible");
});

test("the date sentence counts real days, and never counts backwards", () => {
    assert.match(
        describeStateReason("date-implausible", { ...ROW, txnDate: "2026-09-20" })!.headline,
        /reads as 2026-09-20, which is 1 day before it arrived/,
        "singular at one day",
    );
    assert.match(
        describeStateReason("date-implausible", { ...ROW, txnDate: "2023-09-17" })!.headline,
        /reads as 2023-09-17, which is 1100 days before it arrived/,
        "the Sunbelt row",
    );
    // A future misread is still a misread, and the sentence must not say
    // "-3 days before it arrived".
    assert.match(
        describeStateReason("date-implausible", { ...ROW, txnDate: "2027-09-17" })!.headline,
        /reads as 2027-09-17, which is after it arrived/,
    );
    // No usable date on the row: say so rather than printing a NaN.
    assert.match(
        describeStateReason("date-implausible", { ...ROW, txnDate: null })!.headline,
        /does not fit when it arrived/,
    );
});

test("the refund sentence quotes the amount the row actually carries", () => {
    assert.match(
        describeStateReason("refund-or-zero", { ...ROW, totalCents: -2257 })!.headline,
        /The total reads as -\$22\.57\./,
    );
    assert.match(
        describeStateReason("refund-or-zero", { ...ROW, totalCents: 0 })!.headline,
        /The total reads as \$0\.00\./,
    );
    assert.match(
        describeStateReason("refund-or-zero", { ...ROW, totalCents: null })!.headline,
        /The total reads as nothing\./,
    );
});
