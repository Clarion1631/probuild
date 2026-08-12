import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Internal-but-stable context Next's own useRouter() reads from — needed
// because MarkReviewedButton calls useRouter(), which throws outside a
// mounted App Router. JourneyRow only renders AuditTimeline once a row is
// expanded, which a static server render can't simulate either way, so this
// exercises AuditTimeline directly (exported for exactly this reason).
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AuditTimeline, type SerializedJourney } from "../src/app/automation/components/journey-list";

const fakeRouter = {
    push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: async () => {},
} as unknown as import("next/dist/shared/lib/app-router-context.shared-runtime").AppRouterInstance;

function renderTimeline(journey: SerializedJourney): string {
    return renderToStaticMarkup(
        createElement(
            AppRouterContext.Provider,
            { value: fakeRouter },
            createElement(AuditTimeline, { journey }),
        ),
    );
}

const BASE_JOURNEY: SerializedJourney = {
    docNumber: "doc1",
    fileName: "receipt.pdf",
    vendor: "Contractor Supply",
    projectName: "Berg ADU",
    amountCents: 245232,
    taxCents: 1200,
    firstSeen: "2026-08-11T10:00:00.000Z",
    lastSeen: "2026-08-11T10:00:00.000Z",
    steps: [
        { at: "2026-08-11T09:00:00.000Z", stage: "intake", status: "ok", reason: null, detail: null, vendor: null, amountCents: null, projectName: null },
        {
            at: "2026-08-11T09:05:00.000Z", stage: "read", status: "ok", reason: null, detail: null,
            // Deliberately DIFFERENT from journey-wide vendor/project — a later
            // event (e.g. the push) would overwrite the journey-wide fields,
            // but the read step must show what IT read.
            vendor: "Read-Time Vendor", amountCents: 999, projectName: "Read-Time Project",
        },
    ],
    finalState: "booked-api",
    finalReason: null,
    syncedExpenseId: "exp1",
    syncedProjectName: "Berg ADU",
    backfilled: false,
    driveFileId: "file1",
    qbPurchaseId: "purchase-1",
    synced: {
        expenseId: "exp1",
        projectId: "proj1",
        projectName: "Berg ADU",
        amountCents: 245232,
        vendor: "Contractor Supply",
        receiptUrl: null,
        syncedAt: "2026-08-11T10:00:00.000Z",
        qbSyncToken: "5",
        qboCreateTime: "2026-08-11T09:30:00.000Z",
    },
    review: null,
};

test("AuditTimeline's Bot read step shows the READ event's own fields, not the journey-wide (later-overwritten) ones", () => {
    const markup = renderTimeline(BASE_JOURNEY);
    assert.match(markup, /Read-Time Vendor/);
    assert.match(markup, /Read-Time Project/);
    // The journey-wide vendor (as of the LAST event) must not appear at all —
    // AuditTimeline never renders journey.vendor/journey.projectName directly.
    assert.doesNotMatch(markup, /Contractor Supply/);
});

test("AuditTimeline shows 'not captured' for Bot read when there's no read-stage event", () => {
    const markup = renderTimeline({ ...BASE_JOURNEY, steps: [] });
    assert.match(markup, /not captured/);
});

test("AuditTimeline offers Mark reviewed when a purchase is reviewable and has no review yet", () => {
    const markup = renderTimeline({ ...BASE_JOURNEY, review: null });
    assert.match(markup, />Mark reviewed</);
    assert.doesNotMatch(markup, /changed after review/);
    assert.doesNotMatch(markup, />Re-review</);
});

test("AuditTimeline shows the reviewer's name and NO button for a current (non-stale) review", () => {
    const markup = renderTimeline({
        ...BASE_JOURNEY,
        review: { reviewerName: "Vanessa", reviewedAt: "2026-08-11T11:00:00.000Z", staleSyncToken: false },
    });
    assert.match(markup, /Vanessa/);
    assert.doesNotMatch(markup, /changed after review/);
    assert.doesNotMatch(markup, />Mark reviewed</);
    assert.doesNotMatch(markup, />Re-review</);
});

test("AuditTimeline shows the stale stamp AND a Re-review button when the purchase changed after review", () => {
    const markup = renderTimeline({
        ...BASE_JOURNEY,
        review: { reviewerName: "Marge", reviewedAt: "2026-08-10T10:00:00.000Z", staleSyncToken: true },
    });
    assert.match(markup, /Marge/);
    assert.match(markup, /changed after review/);
    assert.match(markup, />Re-review</);
});

test("AuditTimeline shows the stale stamp but no re-review button when the current SyncToken is unknown (sync hasn't caught up)", () => {
    const markup = renderTimeline({
        ...BASE_JOURNEY,
        synced: null, // no known current SyncToken to re-review against
        review: { reviewerName: "Marge", reviewedAt: "2026-08-10T10:00:00.000Z", staleSyncToken: true },
    });
    assert.match(markup, /Marge/);
    assert.match(markup, /changed after review/);
    assert.doesNotMatch(markup, />Re-review</);
});

test("AuditTimeline's QBO Purchase step always links the purchase, with create time or 'not captured'", () => {
    const withCreateTime = renderTimeline(BASE_JOURNEY);
    assert.match(withCreateTime, /purchase-1/);

    const withoutCreateTime = renderTimeline({
        ...BASE_JOURNEY,
        synced: { ...BASE_JOURNEY.synced!, qboCreateTime: null },
    });
    assert.match(withoutCreateTime, /not captured/);
    assert.match(withoutCreateTime, /purchase-1/); // the deep link is ALWAYS present per the plan
});
