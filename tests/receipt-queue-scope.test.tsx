import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptsTab } from "../src/app/automation/components/receipts/receipts-tab";
import type { ReceiptQueue } from "../src/app/automation/receipts-data";

const queue: ReceiptQueue = {
    needsJob: [], needsReview: [], booking: [], bookedToday: [], duplicates: [],
    exceptions: [], uncertainCards: [], missingReceipts: [],
    counts: { needsJob: 0, needsReview: 0, booking: 0, bookedToday: 0, duplicates: 0,
        exceptions: 0, uncertainCards: 0, missingReceipts: 0, missingReceiptsShown: 0 },
};

test("empty receipt queue explains its scope without asserting company-wide completion", async () => {
    const html = renderToStaticMarkup(await ReceiptsTab({
        queue, filters: {group: null, projectId: null, owner: null}, jobs: [],
        filterHref: () => "/automation?tab=receipts", nativeActive: false,
    }));
    assert.match(html, /href="\/automation\?tab=register"[^>]*>View register<\/a>/);
    assert.match(html, /Booked today[\s\S]*queue|queue[\s\S]*Booked today/);
    assert.match(html, /email[\s\S]*photo|photo[\s\S]*email/);
    assert.doesNotMatch(html, /every receipt has a job|nothing is waiting on a decision|every bank charge has a receipt/i);
    assert.doesNotMatch(html, /writer is legacy|V2 is disabled/);
});

test("scope and register navigation remain visible for a filtered empty group", async () => {
    const html = renderToStaticMarkup(await ReceiptsTab({
        queue, filters: {group: "booked-today", projectId: "project-filter", owner: "Richard"}, jobs: [],
        filterHref: () => "/automation?tab=receipts", nativeActive: false,
    }));
    assert.match(html, /href="\/automation\?tab=register"[^>]*>View register<\/a>/);
    assert.match(html, /queue/);
    assert.doesNotMatch(html, /every receipt|every bank charge/);
});

test("the in-flight tile names the rail these receipts are actually booking into", async () => {
    // With native booking live NOTHING in this queue is sent to QuickBooks, so
    // "booking into QuickBooks" is simply false — the same rail question the
    // pause control answers, and the same derivation (`!pushEnabled &&
    // nativeBookingEnabled`), threaded in rather than re-read here.
    const render = async (nativeActive: boolean) => renderToStaticMarkup(await ReceiptsTab({
        queue, filters: {group: null, projectId: null, owner: null}, jobs: [],
        filterHref: () => "/automation?tab=receipts", nativeActive,
    }));

    const native = await render(true);
    assert.match(native, /Queue receipts booking into ProBuild job costing/);
    assert.doesNotMatch(native, /booking into QuickBooks/);

    const qbo = await render(false);
    assert.match(qbo, /Queue receipts booking into QuickBooks/, "the QuickBooks rail is unchanged");
    assert.doesNotMatch(qbo, /booking into ProBuild job costing/);
});
