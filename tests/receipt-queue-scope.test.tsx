import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptsTab } from "../src/app/automation/components/receipts/receipts-tab";
import type { ReceiptQueue } from "../src/app/automation/receipts-data";

const queue: ReceiptQueue = {
    needsJob: [], needsReview: [], booking: [], bookedToday: [], duplicates: [],
    exceptions: [], uncertainCards: [], missingReceipts: [],
    counts: { needsJob: 0, needsReview: 0, booking: 0, bookedToday: 0, duplicates: 0,
        exceptions: 0, uncertainCards: 0, missingReceipts: 0, missingReceiptsShown: 0 },
};

test("empty receipt queue explains its scope without asserting company-wide completion", () => {
    const html = renderToStaticMarkup(createElement(ReceiptsTab, {
        queue, filters: {group: null, projectId: null, owner: null}, jobs: [],
        filterHref: () => "/automation?tab=receipts",
    }));
    assert.match(html, /href="\/automation\?tab=register"[^>]*>View register<\/a>/);
    assert.match(html, /Booked today[\s\S]*queue|queue[\s\S]*Booked today/);
    assert.match(html, /email[\s\S]*photo|photo[\s\S]*email/);
    assert.doesNotMatch(html, /every receipt has a job|nothing is waiting on a decision|every bank charge has a receipt/i);
    assert.doesNotMatch(html, /writer is legacy|V2 is disabled/);
});

test("scope and register navigation remain visible for a filtered empty group", () => {
    const html = renderToStaticMarkup(createElement(ReceiptsTab, {
        queue, filters: {group: "booked-today", projectId: "project-filter", owner: "Richard"}, jobs: [],
        filterHref: () => "/automation?tab=receipts",
    }));
    assert.match(html, /href="\/automation\?tab=register"[^>]*>View register<\/a>/);
    assert.match(html, /queue/);
    assert.doesNotMatch(html, /every receipt|every bank charge/);
});
