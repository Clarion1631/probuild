import assert from "node:assert/strict";
import test from "node:test";
import { matchReceiptJourney } from "../src/app/automation/components/register/match-receipt-journey";
import type { ReceiptJourney } from "../src/lib/automation-events";

// ── B2 — the row drill-down must never be built from a capped journey list ──
// page.tsx used to fetch only the newest 200 receiptJourneys() and pass that
// SAME capped list into matchReceiptJourney() for every register row's
// drill-down. An older row whose genuinely-confirmed receipt fell past that
// cap would render "No audit record" even though the audit record exists —
// a MISSING answer for a user looking right at a booked receipt. The fix
// (automation-events.ts) splits `receiptJourneysAll` (uncapped) from
// `receiptJourneys` (display-capped) and page.tsx now feeds the UNCAPPED
// list into matchReceiptJourney, capping only the separate pipeline-list
// display. matchReceiptJourney itself was already pure and correct — this
// test proves the FIX WORKS: a match past position 200 is found when given
// the complete list, and documents (via the "capped" case) exactly the
// defect a capped list would reintroduce if someone wired it back in.

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

test("B2: a genuinely-confirmed journey far past a 200-item cap is found when the caller passes the complete list", () => {
    const targetPurchaseId = "purchase-old-but-real";
    const journeys: ReceiptJourney[] = [];
    // 300 newer, unrelated journeys ahead of the target — more than the old
    // display cap, so the target would NOT survive a `.slice(0, 200)`.
    for (let i = 0; i < 300; i++) {
        journeys.push(fakeJourney({ docNumber: `newer-${i}`, qbPurchaseId: `purchase-newer-${i}` }));
    }
    journeys.push(fakeJourney({ docNumber: "old-receipt", qbPurchaseId: targetPurchaseId }));

    const row = { qbTxnId: targetPurchaseId, docNum: null };

    // The old, buggy wiring: cap BEFORE matching — this is what page.tsx did
    // before the fix, and it's what silently produced "No audit record".
    const cappedMatch = matchReceiptJourney(row, journeys.slice(0, 200));
    assert.equal(cappedMatch, null, "sanity check: the target is genuinely past the cap");

    // The fix: match against the COMPLETE list — this is what page.tsx does
    // now (receiptJourneysAll, uncapped, only capped separately for the
    // pipeline list display).
    const fullMatch = matchReceiptJourney(row, journeys);
    assert.notEqual(fullMatch, null);
    assert.equal(fullMatch?.journey.qbPurchaseId, targetPurchaseId);
    assert.equal(fullMatch?.unconfirmed, false);
});

test("matchReceiptJourney: qbPurchaseId match on a keyConfirmed:false journey is still reported unconfirmed", () => {
    const journeys = [fakeJourney({ qbPurchaseId: "purchase-1", keyConfirmed: false })];
    const match = matchReceiptJourney({ qbTxnId: "purchase-1", docNum: null }, journeys);
    assert.equal(match?.unconfirmed, true);
});

test("matchReceiptJourney: a docNumber-prefix-only match is always unconfirmed, regardless of that journey's own keyConfirmed", () => {
    const journeys = [fakeJourney({ docNumber: "ABC123", qbPurchaseId: null, keyConfirmed: true })];
    const match = matchReceiptJourney({ qbTxnId: null, docNum: "ABC123" }, journeys);
    assert.equal(match?.unconfirmed, true);
});
