/**
 * The To-do view as a browser would receive it.
 *
 * Two things are protected here. The first is that a bare `?tab=receipts` now
 * draws the office manager's list. The second, and the one worth more, is that
 * nothing else moved: every `?group=` and `?owner=` URL is pinned against
 * `tests/fixtures/receipts-tab-legacy.json`, which was captured by rendering
 * the tab as it stood on `origin/claude/weak-net-distinct-refs`. Three
 * differences from that capture are deliberate and approved by the owner; they
 * are listed in APPROVED_DIFFERENCES below and applied to the fixture before
 * the comparison, so any FOURTH difference fails this file.
 *
 * THE PROCESS RUNS IN UTC, as Vercel does. Two of those three differences are
 * timezone bugs, and on a Pacific developer machine the buggy code and the
 * fixed code print the same string, so a test that did not force the zone
 * would pass either way.
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
import { TODO_COPY } from "../src/app/automation/receipts-todo";
import type { IntakeRow, MissingReceiptRow, ReceiptQueue } from "../src/app/automation/receipts-data";
import { LEGACY_URLS, legacyQueue, groupSections } from "./legacy-fixture-shared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

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

/**
 * Every render here goes through a recorded signer by DEFAULT. The real one
 * reaches storage, and a test that quietly does that is a test that is slower,
 * flakier and occasionally noisier than the thing it is checking.
 */
const render = async (queue: ReceiptQueue, filters: ReceiptFilters, sign: ReceiptBatchSigner = recordingSigner().sign) =>
    renderToStaticMarkup(await ReceiptsTab({
        queue, filters, jobs: [{ id: "p1", name: "Mueller Remodel" }],
        filterHref: () => "/automation?tab=receipts", nativeActive: false, sign,
    }));

/** The real builder from page.tsx, so href tests exercise what ships. */
const realFilterHref = (filters: ReceiptFilters) => (overrides: { group?: string; owner?: string; view?: string }) => {
    const params = new URLSearchParams();
    params.set("tab", "receipts");
    const nextGroup = overrides.group ?? filters.group ?? "";
    const nextOwner = overrides.owner ?? filters.owner ?? "";
    const nextView = overrides.view ?? filters.view ?? "";
    if (nextGroup) params.set("group", nextGroup);
    if (nextOwner) params.set("owner", nextOwner);
    if (filters.projectId) params.set("projectId", filters.projectId);
    if (nextView && nextView !== "todo") params.set("view", nextView);
    return `/automation?${params.toString()}`;
};

const renderWithHrefs = async (queue: ReceiptQueue, filters: ReceiptFilters) =>
    renderToStaticMarkup(await ReceiptsTab({
        queue, filters, jobs: [], filterHref: realFilterHref(filters),
        nativeActive: false, sign: recordingSigner().sign,
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
    assert.ok(html.includes(escaped(TODO_COPY.doneNothing)), "and it says THIS QUEUE, not the company");
    assert.doesNotMatch(html, /waiting anywhere/, "the old wording claimed more than this page can see");
    // The scope test's own assertions, which must keep passing in BOTH views.
    assert.match(html, /href="\/automation\?tab=register"[^>]*>View register<\/a>/);
    assert.match(html, /email[\s\S]*photo|photo[\s\S]*email/);
    assert.doesNotMatch(html, /every receipt has a job|nothing is waiting on a decision|every bank charge has a receipt/i);
});

test("the grey strip is drawn even when it is empty", async () => {
    const html = await render(queueOf(), parseReceiptFilters({}));
    assert.ok(html.includes("Not yours: 0 of these."),
        "a strip that only appears with bad news is indistinguishable from a strip that broke");
});

// ── Nothing else moved ────────────────────────────────────────────────────

/**
 * Differences from the captured base render, each one a deliberate decision.
 * Applied to the FIXTURE before comparing, so a fourth difference is a failure.
 */
const APPROVED_DIFFERENCES: Array<{ why: string; apply: (base: string) => string }> = [
    {
        why: "the cap line said '(oldest are shown first)'. Both the selection and the in-memory sort are newest first.",
        apply: base => base.replace(/Showing (\d+) of (\d+) \(oldest are shown first\)\./g, "Showing the $1 newest of $2."),
    },
    {
        why: "the same line, with an owner filter on.",
        apply: base => base.replace(/Showing (\d+) of (\d+) \(filtered to ([^)]+)\)\./g, "Showing the $1 newest of $2, filtered to $3."),
    },
    {
        why: "a retry time rendered in the server's zone, so on Vercel 8:30pm Pacific read as tomorrow morning.",
        apply: base => base.replace("next try 9/21/26, 3:30 AM", "next try 9/20/26, 8:30 PM"),
    },
    {
        why: "a row with no read date fell back to the UTC calendar day, so an evening receipt read as tomorrow.",
        apply: base => base.replace(">2026-09-19 · chat<", ">2026-09-18 · chat<"),
    },
];

test("the process is in UTC, or these pins prove nothing", () => {
    assert.equal(
        new Date("2026-09-21T03:30:00.000Z").toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }),
        "9/21/26, 3:30 AM",
        "set TZ=UTC: on a Pacific machine the timezone bug and its fix print the same string",
    );
});

test("every legacy URL still draws what the base branch drew, bar the approved differences", async () => {
    const fixture: Record<string, string> = JSON.parse(
        readFileSync(join(HERE, "fixtures", "receipts-tab-legacy.json"), "utf8"));
    const sign: ReceiptBatchSigner = async paths =>
        new Map(paths.map(path => [path, `https://storage.test/sign/${path}`]));

    for (const [name, filters] of LEGACY_URLS) {
        const html = renderToStaticMarkup(await ReceiptsTab({
            queue: legacyQueue() as ReceiptQueue, filters: filters as ReceiptFilters,
            jobs: [{ id: "p1", name: "Mueller Remodel" }],
            filterHref: () => "/automation?tab=receipts", nativeActive: false, sign,
        }));
        const expected = APPROVED_DIFFERENCES.reduce((text, diff) => diff.apply(text), fixture[name as string]);
        assert.equal(groupSections(html), expected, `${name as string}: an unapproved change to a legacy view`);
    }
});

test("the fixture is a real pin: without the approved rewrites it does NOT match", async () => {
    // Guards the guard. If the fixture ever drifted into a copy of current
    // output, the test above would pass while proving nothing.
    const fixture: Record<string, string> = JSON.parse(
        readFileSync(join(HERE, "fixtures", "receipts-tab-legacy.json"), "utf8"));
    const html = await render(legacyQueue() as ReceiptQueue, { group: "missing-receipts", projectId: null, owner: null });
    assert.notEqual(groupSections(html), fixture["group=missing-receipts"]);
    assert.match(fixture["group=missing-receipts"], /oldest are shown first/, "the fixture holds the OLD wording");
    assert.match(fixture["group=booking"], /next try 9\/21\/26, 3:30 AM/, "and the OLD, UTC retry time");
});

/** The fourth approved difference, outside the group panels: the chip row. */
test("the chip row is the one approved change above the groups", async () => {
    // From the To-do list, a group chip is the plain legacy URL.
    const todo = await renderWithHrefs(legacyQueue() as ReceiptQueue, parseReceiptFilters({}));
    assert.match(todo, /href="\/automation\?tab=receipts"[^>]*>To-do<\/a>/);
    assert.match(todo, /href="\/automation\?tab=receipts&amp;view=all"[^>]*>Everything<\/a>/);
    assert.doesNotMatch(todo, />All<\/a>/, "the unnamed 'All' chip became 'Everything', which is a URL");
    for (const group of ["needs-job", "needs-review", "booking", "booked-today", "missing-receipts", "duplicates", "exceptions", "uncertain-cards"]) {
        assert.ok(todo.includes(`href="/automation?tab=receipts&amp;group=${group}"`), group);
    }

    // From Everything, the same chips carry the view along, so a click keeps
    // the reader where they are instead of bouncing them to the To-do list.
    const all = await renderWithHrefs(legacyQueue() as ReceiptQueue, parseReceiptFilters({ view: "all" }));
    assert.match(all, /href="\/automation\?tab=receipts&amp;group=needs-job&amp;view=all"/);
    assert.match(all, /href="\/automation\?tab=receipts&amp;view=all"[^>]*bg-hui-primary[^>]*>Everything<\/a>/);
});

const busyQueue = () => queueOf({
    needsJob: [intake("nj", { state: "NEEDS_JOB" })],
    needsReview: [intake("nr", { stateReason: "weak-dup:x" })],
    booking: [intake("bk", { state: "BOOKING", nextRetryAt: "2026-09-21T03:30:00.000Z" })],
    bookedToday: [intake("bt", { state: "BOOKED" })],
    duplicates: [intake("dp", { state: "DUPLICATE" })],
    missingReceipts: [request("m1"), request("m2", { owner: "Richard", cardTail: "6098" })],
});

test("?view=all renders exactly what a pre-view filter object renders", async () => {
    const queue = busyQueue();
    const before = await render(queue, PRE_VIEW);
    const after = await render(queue, parseReceiptFilters({ view: "all" }));
    assert.equal(after, before, "the `view` field itself changes nothing about the old default");
});

// ── What is hers, and what is not ─────────────────────────────────────────

test("a held row is in no pile, and the strip names who owns it", async () => {
    const html = await render(queueOf({
        missingReceipts: [
            request("held", { outreachHold: "existing-evidence-review", payee: "SUNBELT RENTALS" }),
        ],
    }), parseReceiptFilters({}));

    assert.doesNotMatch(html, /SUNBELT RENTALS/, "it is not drawn as work");
    assert.ok(html.includes("1 has a possible document already. Justin checks that one."));
    assert.doesNotMatch(html, /has a document already/, "the hold is same-amount within a month, with no payee test at all");
    assert.ok(html.includes("Not yours: 1 of these."));
    assert.ok(html.includes(escaped(TODO_COPY.doneTitle)), "and with nothing else waiting, she is done");
});

test("a reason nobody has words for is HERS, with the raw code beside it", async () => {
    const html = await render(queueOf({
        needsReview: [intake("x", { stateReason: "brand-new-failure-mode", vendor: "Tapani Materials" })],
    }), parseReceiptFilters({}));

    assert.match(html, /Needs a better photo/);
    assert.match(html, /Tapani Materials/);
    assert.match(html, /brand-new-failure-mode/, "the code she can read out to a developer");
    assert.ok(html.includes("I could not finish these. The reason is under each one."),
        "the note cannot claim every row here is unreadable: this one is not");
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

test("both kinds of unknown card get the control that can answer them", async () => {
    const html = await render(queueOf({
        missingReceipts: [
            request("no-card", { owner: "unattributed", cardTail: null, payee: "SUNBELT" }),
            request("odd-card", { owner: "unassigned", cardTail: "9999", payee: "TAPANI" }),
        ],
    }), parseReceiptFilters({}));

    // setMissingReceiptOwner gates on target type, clearedAt and the rendered
    // version, never on the current owner, so it takes an unrecognised tail
    // exactly as it takes a missing one. A row in this pile with no control
    // would be a dead end.
    assert.equal((html.match(/Whose charge\?/g) ?? []).length, 2);
    assert.equal((html.match(/>Assign</g) ?? []).length, 2);
    assert.ok(html.includes("no card number on them, or one I do not recognise"),
        "and the note covers both, because an unassigned row does have a tail");
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

// ── What this view could not load ─────────────────────────────────────────

test("a page of already-handled rows never claims she is done while older ones are unloaded", async () => {
    const queue = queueOf({ missingReceipts: [request("a", { acknowledged: true })] });
    queue.counts.missingReceipts = 109;
    queue.counts.missingReceiptsShown = 1;

    const html = await renderWithHrefs(queue, parseReceiptFilters({}));

    assert.ok(!html.includes(escaped(TODO_COPY.doneTitle)),
        "108 open requests were never even loaded: 'done' would be a display limit talking");
    assert.ok(html.includes("Showing the 1 newest of 109."));
    assert.ok(html.includes("108 older requests are not loaded here yet."));
    assert.match(html, /href="\/automation\?tab=receipts&amp;group=missing-receipts&amp;view=all"[^>]*>Open the full list\.<\/a>/);
});

test("one unloaded request says so in the singular, and a whole queue says nothing at all", async () => {
    const one = queueOf({ missingReceipts: [request("a")] });
    one.counts.missingReceipts = 2;
    one.counts.missingReceiptsShown = 1;
    const html = await renderWithHrefs(one, parseReceiptFilters({}));
    assert.ok(html.includes("1 older request is not loaded here yet."));

    const whole = await renderWithHrefs(queueOf({ missingReceipts: [request("a")] }), parseReceiptFilters({}));
    assert.ok(!whole.includes("not loaded here yet"), "nothing missing, nothing to say");
});

// ── Where the strip's links go ────────────────────────────────────────────

test("a folded line keeps the project filter it was clicked from", async () => {
    const queue = queueOf({
        booking: [intake("bk", { state: "BOOKING" })],
        missingReceipts: [request("o", { owner: "office", cardTail: null, rawDescriptor: "ACH DEBIT" })],
    });
    const html = await renderWithHrefs(queue, parseReceiptFilters({ projectId: "p1" }));

    assert.match(html, /href="\/automation\?tab=receipts&amp;group=booking&amp;projectId=p1"/,
        "a link built inside the pure planner could not have known about the project");
    assert.match(html, /href="\/automation\?tab=receipts&amp;group=missing-receipts&amp;owner=office&amp;projectId=p1"/);
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
    // 03:30 UTC on the 21st is 20:30 Pacific on the 20th. Rendered in the
    // server's own zone this row claims a retry tomorrow morning.
    const html = await render(queueOf({
        booking: [intake("bk", { state: "BOOKING", nextRetryAt: "2026-09-21T03:30:00.000Z" })],
    }), { ...PRE_VIEW, group: "booking" });

    assert.match(html, /next try 9\/20\/26, 8:30\s?PM/);
    assert.doesNotMatch(html, /9\/21\/26, 3:30\s?AM/);
});

test("a receipt with no read date shows the day it landed in Pacific", async () => {
    const html = await render(queueOf({
        needsJob: [intake("a", { state: "NEEDS_JOB", txnDate: null, createdAt: "2026-09-19T03:30:00.000Z" })],
    }), parseReceiptFilters({}));

    assert.match(html, /2026-09-18/, "an evening receipt must not read as tomorrow");
    assert.doesNotMatch(html, /2026-09-19/);
});

test("the exceptions banner makes no claim about which rail is live", async () => {
    // "Nothing new lands here while receipts book into ProBuild" was appended
    // unconditionally, including with the QuickBooks push on, where it is
    // simply false.
    const html = await render(queueOf({
        exceptions: [intake("e", { postVoidQbPurchaseId: "qb-1" })],
    }), { ...PRE_VIEW, group: "exceptions" });

    assert.match(html, /voided or re-classified after the send to QuickBooks had already started/);
    assert.doesNotMatch(html, /while receipts book into ProBuild/);
});
