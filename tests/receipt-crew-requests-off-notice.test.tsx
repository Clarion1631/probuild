/**
 * Nothing may sit un-asked without a visible reason and an owner on the page.
 * While the weekday crew messages are switched off, the Receipts tab says so.
 */
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptsTab, type ReceiptBatchSigner } from "../src/app/automation/components/receipts/receipts-tab";
import { parseReceiptFilters, type ReceiptFilters } from "../src/app/automation/receipts-filters";
import { CREW_REQUESTS_OFF_NOTICE } from "../src/app/automation/receipts-todo";
import type { IntakeRow, MissingReceiptRow, ReceiptQueue } from "../src/app/automation/receipts-data";

const HERE = dirname(fileURLToPath(import.meta.url));

const NOTICE_TEXT =
    "Crew messages are switched off. Nobody is being messaged about these charges. Justin decides when they go back on. Until then, ask for a receipt by hand.";

function intake(id: string): IntakeRow {
    return {
        id, state: "NEEDS_JOB", stateReason: null, source: "chat",
        projectId: null, projectName: null, costCodeId: null,
        vendor: `Vendor ${id}`, txnDate: "2026-09-18", totalCents: -4_000,
        fileName: `${id}.pdf`, storagePath: `receipts/intake/${id}.pdf`,
        duplicateOfId: null, qbPurchaseId: null, postVoidQbPurchaseId: null,
        attempts: 0, lastError: null, nextRetryAt: null, bookedAt: null,
        createdAt: "2026-09-18T12:00:00.000Z", updatedAt: "2026-09-18T12:00:00.000Z",
    };
}

function request(id: string, over: Partial<MissingReceiptRow> = {}): MissingReceiptRow {
    return {
        id, version: 1, reasonHash: `hash-${id}`, acknowledged: false,
        targetKey: `bank-${id}`, owner: "CJ", ownerAssigned: false,
        cardTail: "8516", postedDate: "2026-09-02", amountCents: -4_000,
        payee: "THE ROCKERY NW", rawDescriptor: "THE ROCKERY NW POS DEB",
        fingerprint: `fp-${id}`, threadName: null, outreachHold: null,
        resolution: null, pdfUrl: null,
        ...over,
    };
}

function queueOf(over: Partial<ReceiptQueue> = {}): ReceiptQueue {
    const filled = {
        needsJob: [], needsReview: [], booking: [], bookedToday: [], duplicates: [],
        exceptions: [], uncertainCards: [], missingReceipts: [],
        ...over,
    };
    return {
        ...filled,
        counts: {
            needsJob: filled.needsJob.length, needsReview: filled.needsReview.length,
            booking: filled.booking.length, bookedToday: filled.bookedToday.length,
            duplicates: filled.duplicates.length, exceptions: filled.exceptions.length,
            uncertainCards: filled.uncertainCards.length,
            missingReceipts: filled.missingReceipts.length,
            missingReceiptsShown: filled.missingReceipts.length,
        },
    };
}

const sign: ReceiptBatchSigner = async paths =>
    new Map(paths.map(path => [path, `https://storage.test/sign/${path}`]));

const render = async (queue: ReceiptQueue, filters: ReceiptFilters, crewRequestsEnabled?: boolean) =>
    renderToStaticMarkup(await ReceiptsTab({
        queue, filters, jobs: [], filterHref: () => "/automation?tab=receipts", nativeActive: false, sign,
        ...(crewRequestsEnabled === undefined ? {} : { crewRequestsEnabled }),
    }));

const count = (html: string) => html.split(NOTICE_TEXT).length - 1;
const TODO = parseReceiptFilters({ tab: "receipts" });
const MISSING = parseReceiptFilters({ tab: "receipts", group: "missing-receipts" });
const ALL = parseReceiptFilters({ tab: "receipts", view: "all" });
const withRow = () => queueOf({ missingReceipts: [request("a")] });

test("the shared constant is the exact approved sentence", () => {
    assert.equal(CREW_REQUESTS_OFF_NOTICE, NOTICE_TEXT);
});

test("To-do view: notice shows once when crew messages are off", async () => {
    assert.equal(count(await render(withRow(), TODO, false)), 1);
});

test("missing-receipts group: notice shows once when crew messages are off", async () => {
    assert.equal(count(await render(withRow(), MISSING, false)), 1);
});

test("all-groups view: notice shows once, in the missing receipts group", async () => {
    assert.equal(count(await render(withRow(), ALL, false)), 1);
});

test("no notice when crew messages are on", async () => {
    for (const f of [TODO, MISSING, ALL]) assert.equal(count(await render(withRow(), f, true)), 0);
});

test("no notice when the prop is omitted", async () => {
    for (const f of [TODO, MISSING, ALL]) assert.equal(count(await render(withRow(), f)), 0);
});

test("no notice in groups that have nothing to do with missing receipts", async () => {
    const q = queueOf({ needsJob: [intake("n")], missingReceipts: [request("a")] });
    assert.equal(count(await render(q, parseReceiptFilters({ tab: "receipts", group: "needs-job" }), false)), 0);
    assert.equal(count(await render(queueOf({ needsJob: [intake("n")] }), TODO, false)), 0,
        "no missing-receipt rows, nothing is waiting to be asked");
});

test("the held existing-evidence row names who checks it", async () => {
    const html = await render(
        queueOf({ missingReceipts: [request("k", { outreachHold: "existing-evidence-review", payee: "KNOWN ONE" })] }),
        MISSING, true);
    assert.ok(html.includes("Existing document needs reconciliation. Crew request held. Justin checks this one."));
});

test("page.tsx passes crewRequestsEnabled from the existing delivery projection", () => {
    const src = readFileSync(join(HERE, "..", "src", "app", "automation", "page.tsx"), "utf8");
    assert.match(src, /crewRequestsEnabled=\{/);
    assert.match(src, /projectCardDeliveryConfig\(\)\.reminderEnabled/);
    assert.match(src, /from "@\/lib\/receipt-chaser-completion"/);
});
