import assert from "node:assert/strict";
import test from "node:test";
import {
    matchCheckEvidence,
    type ConfirmedCheckImage,
    type PaymentForEvidence,
} from "@/lib/check-evidence";

// The real prod row this feature was built for: check #1027,
// "GOLDEN TOUCH RMEODELING LLC", HOPPE VANITY memo, $6,037.15.
const hoppeImage = (over: Partial<ConfirmedCheckImage> = {}): ConfirmedCheckImage => ({
    normalizedCheckNumber: "1027",
    amountCents: 603715,
    lineAmountCents: -603715,
    payerName: "GOLDEN TOUCH RMEODELING LLC",
    driveFileId: "drive-abc",
    fileName: "26225018006376-front.jpg",
    confirmedBy: "justin@goldentouchremodeling.com",
    confirmedAt: "2026-08-22T05:00:00.000Z",
    ...over,
});

const paidByCheck = (over: Partial<PaymentForEvidence> = {}): PaymentForEvidence => ({
    id: "pay-1",
    referenceNumber: "1027",
    amountCents: 603715,
    ...over,
});

test("check number + amount both agreeing yields evidence", () => {
    const map = matchCheckEvidence([paidByCheck()], [hoppeImage()]);
    const ev = map.get("pay-1");
    assert.ok(ev);
    assert.equal(ev.payerName, "GOLDEN TOUCH RMEODELING LLC");
    assert.equal(ev.checkNumber, "1027");
    assert.equal(ev.driveFileId, "drive-abc");
});

test("referenceNumber is normalized before matching (leading zeros, decorations)", () => {
    const map = matchCheckEvidence(
        [paidByCheck({ referenceNumber: "chk #01027" })],
        [hoppeImage()],
    );
    assert.ok(map.get("pay-1"));
});

test("same check number but a DIFFERENT amount is NOT evidence — check numbers collide across payers", () => {
    const map = matchCheckEvidence(
        [paidByCheck({ amountCents: 500000 })],
        [hoppeImage()],
    );
    assert.equal(map.get("pay-1"), undefined);
});

test("image amount unreadable: the confirmed bank line's magnitude corroborates instead", () => {
    const map = matchCheckEvidence(
        [paidByCheck()],
        [hoppeImage({ amountCents: null, lineAmountCents: -603715 })],
    );
    assert.ok(map.get("pay-1"));
});

test("no readable image amount AND no line amount: no evidence, never a guess", () => {
    const map = matchCheckEvidence(
        [paidByCheck()],
        [hoppeImage({ amountCents: null, lineAmountCents: null })],
    );
    assert.equal(map.get("pay-1"), undefined);
});

test("two confirmed images with the same number and amount is ambiguous — nothing shown", () => {
    const map = matchCheckEvidence(
        [paidByCheck()],
        [hoppeImage(), hoppeImage({ payerName: "Someone Else", driveFileId: "drive-xyz" })],
    );
    assert.equal(map.get("pay-1"), undefined);
});

test("null referenceNumber / zero-digit reference / non-check payments are skipped", () => {
    const map = matchCheckEvidence(
        [
            paidByCheck({ id: "p-null", referenceNumber: null }),
            paidByCheck({ id: "p-empty", referenceNumber: "0000" }),
            paidByCheck({ id: "p-alpha", referenceNumber: "no digits" }),
        ],
        [hoppeImage()],
    );
    assert.equal(map.size, 0);
});

test("null / non-integer / non-positive payment amounts are skipped, not matched loosely", () => {
    const map = matchCheckEvidence(
        [
            paidByCheck({ id: "p-null-amt", amountCents: null }),
            paidByCheck({ id: "p-float", amountCents: 6037.15 as unknown as number }),
            paidByCheck({ id: "p-neg", amountCents: -603715 }),
        ],
        [hoppeImage()],
    );
    assert.equal(map.size, 0);
});

test("null payerName still surfaces evidence (chk# + confirmation without a name)", () => {
    const map = matchCheckEvidence([paidByCheck()], [hoppeImage({ payerName: null })]);
    const ev = map.get("pay-1");
    assert.ok(ev);
    assert.equal(ev.payerName, null);
    assert.equal(ev.checkNumber, "1027");
});
