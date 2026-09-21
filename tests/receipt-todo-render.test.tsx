/**
 * The To-do view as a browser would receive it.
 *
 * Two things are being protected here. The first is that a bare
 * `?tab=receipts` now draws Marge's list. The second, and the one worth more,
 * is that NOTHING ELSE MOVED: every `?group=` URL, every `?owner=` URL and the
 * new `?view=all` render byte for byte what the tab rendered before the view
 * existed. Those are asserted by rendering both filter shapes and comparing the
 * markup, not by eyeballing a snapshot.
 *
 * The seam is the same one tests/receipt-open-link.test.tsx uses: `ReceiptsTab`
 * is awaited as a function and its result rendered, with the batch signer
 * injected so a render makes no network call.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptsTab, type ReceiptBatchSigner } from "../src/app/automation/components/receipts/receipts-tab";
import { parseReceiptFilters, type ReceiptFilters } from "../src/app/automation/receipts-filters";
import { TODO_COPY } from "../src/app/automation/receipts-todo";
import type { IntakeRow, MissingReceiptRow, ReceiptQueue } from "../src/app/automation/receipts-data";

function intake(id: string, over: Partial<IntakeRow> = {}): IntakeRow {
    return {
        id, state: "NEEDS_REVIEW", stateReason: null, source: "chat",
        projectId: null, projectName: null, costCodeId: null,
        vendor: `Vendor ${id}`, txnDate: "2026-09-18", totalCents: -4_000,
        fileName: `${id}.pdf`, storagePath: `receipts/intake/${id}.pdf`,
        duplicateOfId: null, qbPurchaseId: null, postVoidQbPurchaseId: null,
        attempts: 0, lastError: null, nextRetryAt: null, bookedAt: null,
        createdAt: "2026-09-18T12:00:00.000Z", updatedAt: "2026-09-18T12:00:00.000Z",
        ...over,
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
            ...(over.counts ?? {}),
        },
    };
}

/** The shape a filter object had before `view` existed. */
const PRE_VIEW: ReceiptFilters = { group: null, projectId: null, owner: null };

/** renderToStaticMarkup escapes the apostrophe, so copy is matched as a browser gets it. */
const escaped = (text: string) => text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

function recordingSigner() {
    const calls: string[][] = [];
    const sign: ReceiptBatchSigner = async paths => {
        calls.push([...paths]);
        return new Map(paths.map(path => [path, `https://storage.test/sign/${path}`]));
    };
    return { calls, sign };
}

const render = async (queue: ReceiptQueue, filters: ReceiptFilters, sign?: ReceiptBatchSigner) =>
    renderToStaticMarkup(await ReceiptsTab({
        queue, filters, jobs: [{ id: "p1", name: "Mueller Remodel" }],
        filterHref: () => "/automation?tab=receipts", nativeActive: false, sign,
    }));

// ── The default, and the empty day ────────────────────────────────────────

test("a bare ?tab=receipts draws the To-do list", async () => {
    const html = await render(queueOf({
        needsJob: [intake("a", { state: "NEEDS_JOB" })],
    }), parseReceiptFilters({ tab: "receipts" }));

    assert.match(html, /Pick the job/);
    assert.match(html, /Needs you today/);
    assert.ok(html.includes(TODO_COPY.statHandled));
    // And the group cards it replaced are not also on the page.
    assert.doesNotMatch(html, /No receipts in this queue are waiting on a decision\./);
});

test("an empty queue says she is done, and still explains what this page covers", async () => {
    const html = await render(queueOf(), parseReceiptFilters({}));

    assert.ok(html.includes(escaped(TODO_COPY.doneTitle)), "You're done for today.");
    assert.ok(html.includes(TODO_COPY.doneNothing), "with nothing anywhere, it says so rather than inventing a number");
    // The scope test's own assertions, which must keep passing in BOTH views.
    assert.match(html, /href="\/automation\?tab=register"[^>]*>View register<\/a>/);
    assert.match(html, /email[\s\S]*photo|photo[\s\S]*email/);
    assert.doesNotMatch(html, /every receipt has a job|nothing is waiting on a decision|every bank charge has a receipt/i);
});

test("the grey strip is drawn even when it is empty", async () => {
    const html = await render(queueOf(), parseReceiptFilters({}));
    assert.ok(html.includes("The system is handling 0 of these."),
        "a strip that only appears with bad news is indistinguishable from a strip that broke");
});

// ── Nothing else moved ────────────────────────────────────────────────────

const busyQueue = () => queueOf({
    needsJob: [intake("nj", { state: "NEEDS_JOB" })],
    needsReview: [intake("nr", { stateReason: "weak-dup:x" })],
    booking: [intake("bk", { state: "BOOKING", nextRetryAt: "2026-09-21T03:30:00.000Z" })],
    bookedToday: [intake("bt", { state: "BOOKED" })],
    duplicates: [intake("dp", { state: "DUPLICATE" })],
    missingReceipts: [request("m1"), request("m2", { owner: "Richard", cardTail: "6098" })],
});

test("?view=all renders exactly what the tab rendered before the view existed", async () => {
    const queue = busyQueue();
    const before = await render(queue, PRE_VIEW);
    const after = await render(queue, parseReceiptFilters({ view: "all" }));
    assert.equal(after, before, "Justin's old default, under a name he can bookmark");
});

test("every legacy URL still renders exactly what it rendered before", async () => {
    const queue = busyQueue();
    for (const [name, sp, legacy] of [
        ["?group=needs-job", { group: "needs-job" }, { ...PRE_VIEW, group: "needs-job" as const }],
        ["?group=booking", { group: "booking" }, { ...PRE_VIEW, group: "booking" as const }],
        ["?group=missing-receipts&owner=CJ", { group: "missing-receipts", owner: "CJ" }, { ...PRE_VIEW, group: "missing-receipts" as const, owner: "CJ" }],
        ["?owner=CJ", { owner: "CJ" }, { ...PRE_VIEW, owner: "CJ" }],
        ["?group=duplicates&projectId=p1", { group: "duplicates", projectId: "p1" }, { ...PRE_VIEW, group: "duplicates" as const, projectId: "p1" }],
    ] as Array<[string, Record<string, string>, ReceiptFilters]>) {
        const parsed = await render(queue, parseReceiptFilters(sp));
        const before = await render(queue, legacy);
        assert.equal(parsed, before, name);
    }
});

test("the power-user chips are both real URLs, and the group chips keep their counts", async () => {
    const html = renderToStaticMarkup(await ReceiptsTab({
        queue: busyQueue(), filters: parseReceiptFilters({}), jobs: [],
        filterHref: overrides => {
            const params = new URLSearchParams({ tab: "receipts" });
            if (overrides.group) params.set("group", overrides.group);
            if (overrides.owner) params.set("owner", overrides.owner);
            if (overrides.view && overrides.view !== "todo") params.set("view", overrides.view);
            return `/automation?${params.toString()}`;
        },
        nativeActive: false, sign: recordingSigner().sign,
    }));

    assert.match(html, /href="\/automation\?tab=receipts"[^>]*>To-do<\/a>/);
    assert.match(html, /href="\/automation\?tab=receipts&amp;view=all"[^>]*>Everything<\/a>/);
    assert.match(html, /href="\/automation\?tab=receipts&amp;group=needs-job"/);
    assert.match(html, /href="\/automation\?tab=receipts&amp;group=uncertain-cards"/);
});

// ── What is hers, and what is not ─────────────────────────────────────────

test("a held row is in no pile, and the strip names who owns it", async () => {
    const html = await render(queueOf({
        missingReceipts: [
            request("held", { outreachHold: "existing-evidence-review", payee: "SUNBELT RENTALS" }),
        ],
    }), parseReceiptFilters({}));

    assert.doesNotMatch(html, /SUNBELT RENTALS/, "it is not drawn as work");
    assert.ok(html.includes("1 has a document already. Justin checks that one."));
    assert.ok(html.includes("The system is handling 1 of these."));
    assert.ok(html.includes(escaped(TODO_COPY.doneTitle)), "and with nothing else waiting, she is done");
});

test("a reason nobody has words for is HERS, with the raw code beside it", async () => {
    const html = await render(queueOf({
        needsReview: [intake("x", { stateReason: "brand-new-failure-mode", vendor: "Tapani Materials" })],
    }), parseReceiptFilters({}));

    assert.match(html, /Needs a better photo/);
    assert.match(html, /Tapani Materials/);
    assert.match(html, /brand-new-failure-mode/, "the code she can read out to a developer");
});

test("the To-do view offers no button that is not hers", async () => {
    const html = await render(queueOf({
        needsJob: [intake("a", { state: "NEEDS_JOB" })],
        needsReview: [intake("b", { stateReason: "unreadable" })],
    }), parseReceiptFilters({}));

    for (const gone of ["Void", "Mark duplicate", "Retry"]) {
        assert.ok(!html.includes(`>${gone}<`), `${gone} is not a bookkeeper's call`);
    }
    assert.match(html, /Set job/, "the one action that finishes a Pick the job row is there");
});

test("nothing in the To-do view hides behind a hover", async () => {
    const html = await render(busyQueue(), parseReceiptFilters({}));
    assert.doesNotMatch(html, /opacity-0/, "the hover-fallback rule cannot be broken by a pattern that is not used");
    assert.doesNotMatch(html, /group-hover:/);
});

// ── The roll-up ───────────────────────────────────────────────────────────

test("ten of the same errand are one line, expandable with no JavaScript", async () => {
    const html = await render(queueOf({
        missingReceipts: Array.from({ length: 10 }, (_unused, index) =>
            request(`dump-${index}`, { postedDate: `2026-08-2${index}`.slice(0, 10) })),
    }), parseReceiptFilters({}));

    assert.match(html, /<details/, "a native disclosure, so it works in a server component");
    assert.match(html, /<summary/);
    assert.ok(html.includes("$40.00 each · 10 charges · $400.00 total"));
    assert.ok(html.includes("2026-08-20 to 2026-08-29 · card …8516"));
    // Every child keeps its own CAS-gated ack: there is no bulk write.
    assert.equal((html.match(/Mark reviewed/g) ?? []).length, 10);
});

// ── Checks and sub bills ──────────────────────────────────────────────────

test("a check says what it is, and points at the guide for what to post", async () => {
    const html = await render(queueOf({
        missingReceipts: [request("c", {
            owner: "office", cardTail: null, ownerAssigned: false,
            payee: "RED POINT ELECTRIC", rawDescriptor: "CHECK PAID 1042",
            amountCents: -350_000, postedDate: "2026-09-08",
        })],
    }), parseReceiptFilters({}));

    assert.match(html, /Checks and sub bills/);
    assert.match(html, /RED POINT ELECTRIC/);
    assert.match(html, /href="\/automation\/guide#checks-what-to-post"/);
    assert.ok(html.includes("What to post ↗"));
    assert.ok(html.includes("2026-09-08 · check paid"));
    assert.ok(html.includes("Needs the check photo and the bill it paid."));
    assert.ok(!html.includes("no card (office rail)"), "office rail is jargon, and on a check it is also the wrong fact");
    assert.match(html, /Mark reviewed/, "the same ack writer, meaning \"I posted it\"");
});

test("the check pile is drawn last, under the crew's receipts", async () => {
    const html = await render(queueOf({
        missingReceipts: [
            request("crew", { payee: "HOME DEPOT" }),
            request("check", { owner: "office", cardTail: null, payee: "RED POINT ELECTRIC", rawDescriptor: "CHECK PAID 1042", amountCents: -350_000 }),
        ],
    }), parseReceiptFilters({}));

    assert.ok(html.indexOf("Ask for these receipts") < html.indexOf("Checks and sub bills"),
        "the biggest number on the page must not bury the five minutes of routine work");
});

// ── What a render costs ───────────────────────────────────────────────────

test("the To-do view signs ONE batch, and only the rows it will draw", async () => {
    const { calls, sign } = recordingSigner();
    const queue = queueOf({
        needsJob: [intake("a", { state: "NEEDS_JOB" })],
        needsReview: [
            intake("b", { stateReason: "unreadable" }),
            // Folded: Justin's, never drawn here, so never paid for.
            intake("folded", { stateReason: "weak-dup:x" }),
        ],
        booking: Array.from({ length: 40 }, (_unused, index) => intake(`bk-${index}`, { state: "BOOKING" })),
        bookedToday: Array.from({ length: 40 }, (_unused, index) => intake(`bt-${index}`, { state: "BOOKED" })),
        duplicates: Array.from({ length: 40 }, (_unused, index) => intake(`dp-${index}`, { state: "DUPLICATE" })),
    });

    const html = await render(queue, parseReceiptFilters({}), sign);

    assert.equal(calls.length, 1, "one render is one round trip");
    assert.deepEqual(calls[0], ["receipts/intake/a.pdf", "receipts/intake/b.pdf"],
        "120 folded rows cost nothing to sign");
    assert.equal((html.match(/Open receipt ↗/g) ?? []).length, 2);
});

test("an empty To-do view asks storage nothing at all", async () => {
    const { calls, sign } = recordingSigner();
    await render(queueOf({ booking: [intake("bk", { state: "BOOKING" })] }), parseReceiptFilters({}), sign);
    assert.deepEqual(calls, []);
});

test("the Everything view still signs every group it draws", async () => {
    const { calls, sign } = recordingSigner();
    await render(queueOf({
        needsJob: [intake("a", { state: "NEEDS_JOB" })],
        booking: [intake("bk", { state: "BOOKING" })],
    }), parseReceiptFilters({ view: "all" }), sign);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["receipts/intake/a.pdf", "receipts/intake/bk.pdf"]);
});

// ── The honesty fixes that ride along ─────────────────────────────────────

test("the missing-receipts cap line says newest, because newest is what it is", async () => {
    const queue = queueOf({ missingReceipts: [request("a")] });
    queue.counts.missingReceipts = 109;
    queue.counts.missingReceiptsShown = 97;

    const html = await render(queue, { ...PRE_VIEW, group: "missing-receipts" });
    assert.ok(html.includes("Showing the 97 newest of 109."));
    assert.doesNotMatch(html, /oldest are shown first/, "the selection and the sort are both newest first");

    const filtered = await render(queue, { ...PRE_VIEW, group: "missing-receipts", owner: "Richard" });
    assert.ok(filtered.includes("Showing the 97 newest of 109, filtered to Richard."));
});

test("a retry time is the crew's clock, not the server's", async () => {
    // 03:30 UTC on the 21st is 20:30 Pacific on the 20th. Rendered in UTC this
    // row claims a retry tomorrow morning.
    const html = await render(queueOf({
        booking: [intake("bk", { state: "BOOKING", nextRetryAt: "2026-09-21T03:30:00.000Z" })],
    }), { ...PRE_VIEW, group: "booking" });

    assert.match(html, /next try 9\/20\/26, 8:30\s?PM/);
});

test("a receipt with no read date shows the day it landed in Pacific", async () => {
    const html = await render(queueOf({
        needsJob: [intake("a", { state: "NEEDS_JOB", txnDate: null, createdAt: "2026-09-19T03:30:00.000Z" })],
    }), parseReceiptFilters({}));

    assert.match(html, /2026-09-18/, "an evening receipt must not read as tomorrow");
    assert.doesNotMatch(html, /2026-09-19/);
});

test("the exceptions banner says why nothing new can land there", async () => {
    const html = await render(queueOf({
        exceptions: [intake("e", { postVoidQbPurchaseId: "qb-1" })],
    }), { ...PRE_VIEW, group: "exceptions" });

    assert.ok(html.includes(TODO_COPY.exceptionsNative));
});
