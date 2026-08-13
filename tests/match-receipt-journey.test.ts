import assert from "node:assert/strict";
import test from "node:test";
import { matchReceiptJourney, type ReceiptJourneyIndex } from "../src/app/automation/components/register/match-receipt-journey";
import { indexJourneysByKeys } from "../src/lib/automation-events";
import type { ReceiptJourney } from "../src/lib/automation-events";

// ── B2/N2 — the row drill-down lookup is now O(1) against a targeted index,
// not an R × J `.find()` scan over a bulk, count-capped journey list ────────
// The old version of this test proved a *display* cap (`.slice(0, 200)`)
// couldn't hide a genuinely-matching journey from `matchReceiptJourney` —
// but that test would still have passed if `page.tsx` had gone back to
// building that cap, because `matchReceiptJourney` took a plain array and
// had no opinion about how it was fetched. The actual N2/B2 fix moved the
// fetch itself: `receiptJourneysForKeys` (automation-events.ts) now queries
// ONLY the events for the identifiers the register's own rows carry — no
// count cap exists on that path at all — and pre-indexes the result into
// the two Maps `matchReceiptJourney` reads here. `matchReceiptJourney` no
// longer even TYPE-CHECKS against a raw array, so a regression back to
// "cap the list, then scan it" would fail to compile, not just fail a test
// someone could route around. What's left to verify here is the matcher's
// own tier/confirmation logic against that index shape.

function fakeJourney(overrides: Partial<ReceiptJourney>): ReceiptJourney {
    return {
        docNumber: "doc",
        fileName: null,
        vendor: null,
        projectName: null,
        amountCents: null,
        taxCents: null,
        firstSeen: new Date("2026-01-01"),
        lastSeen: new Date("2026-01-01"),
        steps: [],
        finalState: "booked-api",
        finalReason: null,
        syncedExpenseId: null,
        syncedProjectName: null,
        backfilled: false,
        driveFileId: null,
        qbPurchaseId: null,
        keyConfirmed: true,
        synced: null,
        ...overrides,
    };
}

function indexOf(journeys: ReceiptJourney[]): ReceiptJourneyIndex {
    return { ...indexJourneysByKeys(journeys), truncated: false };
}

test("a journey present ONLY because receiptJourneysForKeys fetched it for this exact qbPurchaseId is found via the index, confirmed", () => {
    const targetPurchaseId = "purchase-old-but-real";
    const journey = fakeJourney({ docNumber: "old-receipt", qbPurchaseId: targetPurchaseId });
    const index = indexOf([journey]);

    const row = { qbTxnId: targetPurchaseId, docNum: null };
    const match = matchReceiptJourney(row, index);
    assert.notEqual(match, null);
    assert.equal(match?.journey.qbPurchaseId, targetPurchaseId);
    assert.equal(match?.unconfirmed, false);
});

test("a row whose identifiers were never fetched into the index (no matching journey exists) gets no match — never a false positive", () => {
    const index = indexOf([fakeJourney({ qbPurchaseId: "purchase-unrelated" })]);
    const row = { qbTxnId: "purchase-not-in-index", docNum: null };
    assert.equal(matchReceiptJourney(row, index), null);
});

test("matchReceiptJourney: qbPurchaseId match on a keyConfirmed:false journey is still reported unconfirmed", () => {
    const index = indexOf([fakeJourney({ qbPurchaseId: "purchase-1", keyConfirmed: false })]);
    const match = matchReceiptJourney({ qbTxnId: "purchase-1", docNum: null }, index);
    assert.equal(match?.unconfirmed, true);
});

test("matchReceiptJourney: a docNumber-prefix-only match is always unconfirmed, regardless of that journey's own keyConfirmed", () => {
    const index = indexOf([fakeJourney({ docNumber: "ABC123", qbPurchaseId: null, keyConfirmed: true })]);
    const match = matchReceiptJourney({ qbTxnId: null, docNum: "ABC123" }, index);
    assert.equal(match?.unconfirmed, true);
});

test("matchReceiptJourney: the qbPurchaseId tier is tried before the docNumber tier — a row with both finds the confirmed match, not the prefix fallback", () => {
    const confirmed = fakeJourney({ docNumber: "SHARED", qbPurchaseId: "purchase-confirmed", keyConfirmed: true });
    const unconfirmedDecoy = fakeJourney({ docNumber: "SHARED", qbPurchaseId: null, keyConfirmed: false, lastSeen: new Date("2026-06-01") });
    // Both share docNumber "SHARED" — indexJourneysByKeys keeps the most
    // recent one (`unconfirmedDecoy`) in byDocNumber, which is exactly why
    // the qbPurchaseId tier must be tried FIRST when the row has a qbTxnId.
    const index = indexOf([confirmed, unconfirmedDecoy]);
    const match = matchReceiptJourney({ qbTxnId: "purchase-confirmed", docNum: "SHARED" }, index);
    assert.equal(match?.journey, confirmed);
    assert.equal(match?.unconfirmed, false);
});

test("matchReceiptJourney: neither tier matches when the row carries no identifiers", () => {
    const index = indexOf([fakeJourney({ qbPurchaseId: "purchase-1", docNumber: "DOC-1" })]);
    assert.equal(matchReceiptJourney({ qbTxnId: null, docNum: null }, index), null);
});
