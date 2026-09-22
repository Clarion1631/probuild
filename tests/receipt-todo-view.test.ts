/**
 * The To-do planner: what is a person's work, what the system is handling, and
 * the one thing this view is never allowed to do.
 *
 * THE LEAD ASSERTION IS CONSERVATION, over RECEIPTS. Every distinct row the
 * queue hands `planTodo` lands in exactly one pile or exactly one folded line.
 * Never both, never neither. A row that falls through every rule disappears off
 * the only page that lists it, and nobody finds out until a bank reconciliation
 * does. The fixture deliberately puts the SAME row object in two groups,
 * because `fetchReceiptQueue` really does that: `exceptions` is selected on
 * `postVoidQbPurchaseId` or the orphan suffix and is not state-scoped.
 *
 * Amounts here are NEGATIVE, because a bank charge is. Sorting "biggest first"
 * therefore has to be by magnitude, and a fixture full of positive numbers
 * would never catch it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    CHECK_GUIDE_HREF,
    DYNAMIC_FOLDED_COPY,
    FOLDED_COPY,
    PILE_AGE_MIN_DAYS,
    ROLLUP_WINDOW_DAYS,
    TODO_COPY,
    TODO_PILE_COPY,
    fillCopy,
    isOfficeManagerReason,
    planTodo,
    rollUpDates,
    rollUpRepeats,
    rollUpSummary,
    todoStoragePaths,
    type TodoPileKey,
    type TodoPlan,
} from "../src/app/automation/receipts-todo";
import { RECEIPT_GROUP_TAKE, parseReceiptFilters, showsTodoView } from "../src/app/automation/receipts-filters";
import { looksLikeCheckOrSubBill } from "../src/lib/receipt-policy";
import type { IntakeRow, MissingReceiptRow, ReceiptQueue, UncertainCardRow } from "../src/app/automation/receipts-data";

const NOW = new Date("2026-09-21T18:00:00.000Z");

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

function card(id: string): UncertainCardRow {
    return { id, owner: "CJ", pacificDate: "2026-09-19", items: 2, attempts: 1, lastError: null, updatedAt: "2026-09-19T12:00:00.000Z" };
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

/** Distinct rows, which is what conservation is about. Not list entries. */
function distinctRowIds(queue: ReceiptQueue): Set<string> {
    const ids = new Set<string>();
    for (const rows of [queue.exceptions, queue.booking, queue.bookedToday, queue.duplicates, queue.needsJob, queue.needsReview]) {
        for (const row of rows) ids.add(row.id);
    }
    for (const entry of queue.uncertainCards) ids.add(entry.id);
    for (const row of queue.missingReceipts) ids.add(row.id);
    return ids;
}

const pile = (plan: TodoPlan, key: TodoPileKey) => {
    const found = plan.piles.find(entry => entry.key === key);
    assert.ok(found, `no ${key} pile`);
    return found;
};

const rowIdsIn = (plan: TodoPlan, key: TodoPileKey): string[] =>
    pile(plan, key).items.flatMap(item => item.kind === "intake" ? [item.row.id] : item.item.rows.map(row => row.id));

const allPileRowIds = (plan: TodoPlan): string[] => plan.piles.flatMap(entry =>
    entry.items.flatMap(item => item.kind === "intake" ? [item.row.id] : item.item.rows.map(row => row.id)));

const allFoldedRowIds = (plan: TodoPlan): string[] => plan.folded.flatMap(line => line.ids);

const foldedCount = (plan: TodoPlan, key: string) => plan.folded.find(line => line.key === key)?.count ?? 0;

// ── 1. Conservation, first ────────────────────────────────────────────────

test("every row in the queue lands in exactly one pile or exactly one folded line", () => {
    // ONE row object in TWO groups, which is the real shape: exceptionsWhere
    // keys on postVoidQbPurchaseId or the orphan suffix and is not
    // state-scoped, so a row re-routed to NEEDS_JOB after "Not a duplicate"
    // comes back in both arrays with `booked-after-void` still on it.
    const overlapping = intake("overlap", { state: "NEEDS_JOB", postVoidQbPurchaseId: "qb-7", stateReason: "booked-after-void" });
    // And the same trap on the DUPLICATE group, which is where handledCount
    // used to double count.
    const overlappingDuplicate = intake("overlap-dup", { state: "DUPLICATE", stateReason: "x:possible-orphan-purchase", postVoidQbPurchaseId: "qb-8" });

    const queue = queueOf({
        needsJob: [intake("nj", { state: "NEEDS_JOB", stateReason: null }), overlapping],
        needsReview: [
            intake("r-noest", { stateReason: "no-estimate" }),
            intake("r-unread", { stateReason: "unreadable" }),
            intake("r-multi", { stateReason: "multi-doc" }),
            intake("r-multi1", { stateReason: "multi-doc:one-page" }),
            intake("r-unknown", { stateReason: "brand-new-failure-mode" }),
            intake("r-invalid", { stateReason: "invalid-date" }),
            intake("r-implausible", { stateReason: "date-implausible" }),
            intake("r-weak", { stateReason: "weak-dup:abc123" }),
            intake("r-strong", { stateReason: "strong-dup-amount-mismatch:abc123" }),
            intake("r-vendor", { stateReason: "vendor-mismatch:abc123" }),
            intake("r-refund", { stateReason: "refund-or-zero" }),
            intake("r-native", { stateReason: "native-qbo-reconciliation-required" }),
            intake("r-qbo", { stateReason: "qbo-purchase-mismatch:abc123" }),
            intake("r-ai", { stateReason: "ai-unavailable" }),
            intake("r-missing", { stateReason: "file-missing" }),
            intake("r-max", { stateReason: "max-retries" }),
            intake("r-paused", { stateReason: "push-paused" }),
            intake("r-disabled", { stateReason: "push-disabled" }),
        ],
        booking: [intake("bk", { state: "BOOKING" })],
        bookedToday: [intake("bt", { state: "BOOKED" })],
        duplicates: [intake("dup", { state: "DUPLICATE" }), overlappingDuplicate],
        exceptions: [intake("exc", { postVoidQbPurchaseId: "qb-1" }), overlapping, overlappingDuplicate],
        uncertainCards: [card("uc")],
        missingReceipts: [
            request("m-cj", { owner: "CJ" }),
            request("m-rich", { owner: "Richard", cardTail: "6098" }),
            request("m-unattr", { owner: "unattributed", cardTail: null }),
            request("m-unassigned", { owner: "unassigned", cardTail: "9999" }),
            request("m-acked", { acknowledged: true }),
            request("m-memo", { resolution: "memo-signed" }),
            request("m-held", { outreachHold: "existing-evidence-review" }),
            request("m-office-inv", { outreachHold: "office-invoice" }),
            request("m-office", { owner: "office", cardTail: null, rawDescriptor: "ACH DEBIT SOMETHING" }),
            request("m-check", { owner: "office", cardTail: null, payee: "RED POINT ELECTRIC", rawDescriptor: "CHECK PAID 1042", amountCents: -350_000 }),
        ],
    });

    const plan = planTodo(queue, NOW);
    const expected = distinctRowIds(queue);

    const inPiles = allPileRowIds(plan);
    const inFolded = allFoldedRowIds(plan);
    const everywhere = [...inPiles, ...inFolded];

    assert.equal(new Set(everywhere).size, everywhere.length, "no row is counted twice, in any combination");
    assert.deepEqual(new Set(everywhere), expected, "and every row the queue holds is somewhere");
    assert.equal(
        plan.needsYouCount + plan.handledCount,
        expected.size,
        "a row is counted once, somewhere. Neither is a rounding error",
    );
    assert.equal(inPiles.length, plan.needsYouCount, "needsYouCount counts rows, not rolled-up lines");
    assert.equal(inFolded.length, plan.handledCount);

    // The overlapping rows in particular: exceptions wins, once each.
    assert.equal(everywhere.filter(id => id === "overlap").length, 1);
    assert.equal(everywhere.filter(id => id === "overlap-dup").length, 1);
    assert.ok(!inPiles.includes("overlap"), "a row with an orphaned QuickBooks purchase is never drawn as routine work");
    assert.deepEqual(plan.folded.find(line => line.key === "exceptions")?.ids, ["exc", "overlap", "overlap-dup"]);
    assert.equal(foldedCount(plan, "duplicates"), 1, "the overlapping DUPLICATE is not counted again here");

    // And the split itself, named.
    assert.deepEqual(rowIdsIn(plan, "whose-card").sort(), ["m-unassigned", "m-unattr"]);
    assert.deepEqual(rowIdsIn(plan, "pick-the-job").sort(), ["nj", "r-noest"]);
    assert.deepEqual(
        rowIdsIn(plan, "better-photo").sort(),
        ["r-multi", "r-multi1", "r-unread"],
        "only the reasons a photograph can actually answer",
    );
    assert.deepEqual(
        rowIdsIn(plan, "tell-justin"),
        ["r-unknown"],
        "an unrecognised reason is a HUMAN'S, and gets its own pile rather than a guess at the cause",
    );
    assert.deepEqual(rowIdsIn(plan, "ask-for-these").sort(), ["m-cj", "m-rich"]);
    assert.deepEqual(rowIdsIn(plan, "checks-and-sub-bills"), ["m-check"]);
});

test("the folded strip is always drawn, even with nothing in it", () => {
    const plan = planTodo(queueOf(), NOW);
    assert.deepEqual(plan.folded, [], "no line claims a count it does not have");
    assert.equal(plan.handledCount, 0);
    assert.equal(plan.needsYouCount, 0);
    assert.equal(plan.notLoadedCount, 0);
    assert.equal(fillCopy(TODO_COPY.stripHeader, { n: 0 }), "Outside your list: 0 of these.");
});

// ── 2. Which reasons are a person's ───────────────────────────────────────

test("isOfficeManagerReason: the office manager's reasons, and an unknown one", () => {
    for (const reason of ["no-estimate", "unreadable", "multi-doc", "multi-doc:one-page"]) {
        assert.equal(isOfficeManagerReason(reason), true, reason);
    }
    for (const reason of [
        "invalid-date", "date-implausible", "weak-dup:x", "strong-dup-amount-mismatch:x",
        "vendor-mismatch:x", "refund-or-zero", "native-qbo-reconciliation-required",
        "qbo-purchase-mismatch:x", "ai-unavailable", "max-retries", "push-paused", "push-disabled",
        // A Retry row, not a photo row: retryTargetFor sends file-missing back
        // to RECEIVED, so the action is Justin pressing the button.
        "file-missing",
    ]) {
        assert.equal(isOfficeManagerReason(reason), false, reason);
    }
    // The rule that keeps a new failure mode from going quiet.
    assert.equal(isOfficeManagerReason("something-nobody-has-written-yet"), true);
    assert.equal(isOfficeManagerReason(null), true, "no reason at all is still unexplained, so still hers");
    // worker.ts appends `;tax-implausible` to whatever routing decided.
    assert.equal(isOfficeManagerReason("weak-dup:x;tax-implausible"), false);
    assert.equal(isOfficeManagerReason("unreadable;tax-implausible"), true);
});

test("a parked row that is nobody's to fix lands on exactly one folded line, and the line says who acts", () => {
    const plan = planTodo(queueOf({
        needsReview: [
            intake("a", { stateReason: "ai-unavailable" }),
            intake("b", { stateReason: "max-retries" }),
            intake("e", { stateReason: "file-missing" }),
            intake("c", { stateReason: "push-paused" }),
            intake("d", { stateReason: "refund-or-zero" }),
        ],
    }), NOW);

    // NOT one "waiting on another try" line. `retryTargetFor` is explicitly
    // about a MANUAL retry, so nothing here is retried on a timer, and the two
    // cases have different answers to "who does something".
    assert.equal(foldedCount(plan, "retryable"), 3);
    assert.equal(foldedCount(plan, "switched-off"), 1);
    assert.equal(foldedCount(plan, "bookkeeping"), 1);
    assert.equal(plan.needsYouCount, 0);
    assert.equal(plan.handledCount, 5);
});

test("a reason nobody has words for is its own pile, in front of the crew chases", () => {
    const plan = planTodo(queueOf({
        needsReview: [
            intake("mystery", { stateReason: "brand-new-failure-mode" }),
            intake("silent", { stateReason: null }),
            intake("blank", { stateReason: "   " }),
        ],
    }), NOW);

    assert.deepEqual(rowIdsIn(plan, "tell-justin").sort(), ["blank", "mystery", "silent"],
        "a parked row with NO reason at all is unexplained too");
    assert.equal(plan.handledCount, 0, "nothing here is folded away");
    assert.deepEqual(
        plan.piles.map(entry => entry.key),
        ["whose-card", "pick-the-job", "better-photo", "tell-justin", "ask-for-these", "checks-and-sub-bills"],
        "it sits in front of the crew chases, and checks stay last",
    );
});

// ── 3. Roll-up ────────────────────────────────────────────────────────────

const repeat = (id: string, postedDate: string, over: Partial<MissingReceiptRow> = {}) =>
    request(id, { postedDate, ...over });

test("a run of the same errand rolls up; a stretched one splits rather than losing a row", () => {
    const within = rollUpRepeats([
        repeat("a", "2026-08-19"),
        repeat("b", "2026-09-02"), // exactly 14 days
    ]);
    assert.equal(within.length, 1, `${ROLLUP_WINDOW_DAYS} days is one run`);
    assert.equal(within[0].rows.length, 2);
    assert.equal(within[0].totalCents, -8_000);
    assert.equal(within[0].amountCentsEach, -4_000);
    assert.equal(within[0].firstDate, "2026-08-19");
    assert.equal(within[0].lastDate, "2026-09-02");

    const stretched = rollUpRepeats([
        repeat("a", "2026-08-18"),
        repeat("b", "2026-09-02"), // 15 days
    ]);
    assert.equal(stretched.length, 2, "15 days is two");
    assert.deepEqual(stretched.flatMap(item => item.rows.map(row => row.id)).sort(), ["a", "b"], "and nothing was dropped");
});

test("a cent, a person, a CARD, or an unreadable payee all break the repeat", () => {
    assert.equal(rollUpRepeats([repeat("a", "2026-09-01"), repeat("b", "2026-09-02", { amountCents: -4_001 })]).length, 2);
    assert.equal(rollUpRepeats([repeat("a", "2026-09-01"), repeat("b", "2026-09-02", { owner: "Richard" })]).length, 2,
        "a merged line across two people has nobody to ask");
    // The summary prints ONE card tail. Merging two cards would print a tail
    // that is wrong for half the rows underneath it.
    const twoCards = rollUpRepeats([
        repeat("a", "2026-09-01", { cardTail: "8516" }),
        repeat("b", "2026-09-02", { cardTail: "6098" }),
    ]);
    assert.equal(twoCards.length, 2, "two cards are two runs");
    assert.equal(rollUpRepeats([repeat("a", "2026-09-01", { payee: "" }), repeat("b", "2026-09-02", { payee: "" })]).length, 2,
        "with no payee the only thing left matching is the amount, and that is a coincidence");
    assert.equal(rollUpRepeats([repeat("a", ""), repeat("b", "")]).length, 2, "and with no date there is no window");
});

test("one charge is an item holding one row", () => {
    const items = rollUpRepeats([request("only")]);
    assert.equal(items.length, 1);
    assert.equal(items[0].rows.length, 1);
    assert.equal(items[0].totalCents, items[0].amountCentsEach);
});

// ── 4. Sort ───────────────────────────────────────────────────────────────

test("biggest dollars first, and a roll-up sorts by its TOTAL", () => {
    // The middle charge is the point. $250 sits ABOVE each dump ticket ($40)
    // and BELOW the run's total ($400), so sorting by the per-charge amount
    // would put it in the wrong place and this test would fail.
    const plan = planTodo(queueOf({
        missingReceipts: [
            request("rent", { payee: "SUNBELT RENTALS", amountCents: -58_000, postedDate: "2026-09-10" }),
            request("middle", { payee: "LOWES", amountCents: -25_000, postedDate: "2026-09-11" }),
            ...Array.from({ length: 10 }, (_unused, index) =>
                request(`dump-${index}`, { payee: "THE ROCKERY NW", amountCents: -4_000, postedDate: `2026-08-2${index}`.slice(0, 10) })),
        ],
    }), NOW);

    const ask = pile(plan, "ask-for-these").items;
    assert.equal(ask.length, 3, "ten dump tickets are one line");
    const totals = ask.map(item => (item.kind === "request" ? item.item.totalCents : 0));
    assert.deepEqual(totals, [-58_000, -40_000, -25_000], "$400 of dump tickets outranks a single $250 charge");
    assert.equal(ask[1].kind === "request" ? ask[1].item.rows.length : 0, 10);
    assert.equal(ask[1].kind === "request" ? ask[1].item.amountCentsEach : 0, -4_000,
        "and each ticket is smaller than the charge it outranks");
});

test("intake piles are ordered by size too", () => {
    const plan = planTodo(queueOf({
        needsJob: [
            intake("small", { state: "NEEDS_JOB", totalCents: -1_000 }),
            intake("big", { state: "NEEDS_JOB", totalCents: -58_000 }),
            intake("mid", { state: "NEEDS_JOB", totalCents: -9_900 }),
        ],
    }), NOW);
    assert.deepEqual(rowIdsIn(plan, "pick-the-job"), ["big", "mid", "small"]);
});

test("the ask pile is ordered by person first, then by size inside each person", () => {
    const plan = planTodo(queueOf({
        missingReceipts: [
            request("r-big", { owner: "Richard", cardTail: "6098", amountCents: -90_000, payee: "A" }),
            request("cj-small", { owner: "CJ", amountCents: -100, payee: "B" }),
            request("cj-big", { owner: "CJ", amountCents: -50_000, payee: "C" }),
        ],
    }), NOW);
    assert.deepEqual(rowIdsIn(plan, "ask-for-these"), ["cj-big", "cj-small", "r-big"],
        "CJ outranks Richard in OWNER_ORDER, and inside CJ the big one leads");
});

test("the pile age line only appears once it is embarrassing", () => {
    const fresh = planTodo(queueOf({ missingReceipts: [request("new", { postedDate: "2026-09-20" })] }), NOW);
    assert.equal(pile(fresh, "ask-for-these").oldestDays, 1);
    assert.ok(pile(fresh, "ask-for-these").oldestDays! < PILE_AGE_MIN_DAYS);

    const stale = planTodo(queueOf({ missingReceipts: [request("old", { postedDate: "2026-08-01" })] }), NOW);
    assert.equal(pile(stale, "ask-for-these").oldestDays, 51);
    assert.equal(fillCopy(TODO_COPY.pileAge, { n: 51 }), "Oldest here is 51 days old.");

    assert.equal(pile(fresh, "pick-the-job").oldestDays, null, "an empty pile has no age");
});

// ── 5. What leaves her list, and where it is counted ──────────────────────

test("acknowledged, held and answered rows leave the piles and are each counted once", () => {
    const cases: Array<[string, Partial<MissingReceiptRow>, string]> = [
        ["acknowledged", { acknowledged: true }, "acknowledged"],
        ["memo signed", { resolution: "memo-signed" }, "memo-signed"],
        ["held on evidence", { outreachHold: "existing-evidence-review" }, "held"],
        ["office invoice", { outreachHold: "office-invoice" }, "office-invoice"],
        ["office rail", { owner: "office", cardTail: null, rawDescriptor: "ACH DEBIT" }, "office-owner"],
    ];
    for (const [name, over, line] of cases) {
        const plan = planTodo(queueOf({ missingReceipts: [request("x", over)] }), NOW);
        assert.equal(plan.needsYouCount, 0, name);
        assert.equal(plan.handledCount, 1, name);
        assert.equal(plan.folded.length, 1, `${name}: exactly one line, never two`);
        assert.equal(plan.folded[0].key, line, name);
        assert.deepEqual(plan.folded[0].ids, ["x"], name);
        assert.ok(plan.folded[0].target.group, `${name}: the line points at a real group`);
    }
});

test("an acknowledged row folds however it got there", () => {
    // The owner's ruling: "Mark reviewed" means "I asked, hide it until
    // something changes". It beats every other reason a row might still show.
    const plan = planTodo(queueOf({
        missingReceipts: [
            request("a", { acknowledged: true, owner: "unattributed", cardTail: null }),
            request("b", { acknowledged: true, rawDescriptor: "CHECK PAID 99", cardTail: null, owner: "office" }),
        ],
    }), NOW);
    assert.equal(plan.needsYouCount, 0);
    assert.equal(foldedCount(plan, "acknowledged"), 2);
});

test("a hold or a resolution nobody has words for is NAMED, and quotes itself", () => {
    // Neither silently folded nor leaked into "Ask for these receipts": a new
    // code would otherwise either hide a charge or chase one somebody has
    // already answered.
    const hold = planTodo(queueOf({
        missingReceipts: [
            request("h1", { outreachHold: "awaiting-vendor-portal" }),
            request("h2", { outreachHold: "awaiting-vendor-portal" }),
            request("h3", { outreachHold: "some-other-new-thing", rawDescriptor: "CHECK PAID 9" , cardTail: null, owner: "office" }),
        ],
    }), NOW);
    assert.equal(hold.needsYouCount, 0, "including the check, which must not be drawn as work");
    assert.equal(hold.handledCount, 3);
    assert.deepEqual(
        hold.folded.map(line => line.text),
        [
            "2 are held for a reason I do not know: awaiting-vendor-portal. Justin checks those.",
            "1 is held for a reason I do not know: some-other-new-thing. Justin checks that one.",
        ],
        "one line per distinct code, so the sentence stays true",
    );

    const resolved = planTodo(queueOf({
        missingReceipts: [request("r1", { resolution: "closed-by-vanessa" })],
    }), NOW);
    assert.equal(resolved.needsYouCount, 0);
    assert.equal(resolved.folded[0].text, "1 was answered in a way I do not know: closed-by-vanessa. Justin checks that one.");
    assert.deepEqual(resolved.folded[0].ids, ["r1"]);
});

// ── 6. Only the paths the view actually draws ─────────────────────────────

test("todoStoragePaths returns the piles' paths, deduped, and nothing else", () => {
    const shared = "receipts/intake/shared.pdf";
    const plan = planTodo(queueOf({
        needsJob: [intake("a", { state: "NEEDS_JOB", storagePath: shared })],
        needsReview: [
            intake("b", { stateReason: "unreadable", storagePath: shared }),
            intake("c", { stateReason: "unreadable", storagePath: "" }),
            // Folded: not drawn, so not signed.
            intake("d", { stateReason: "weak-dup:x", storagePath: "receipts/intake/folded.pdf" }),
        ],
        booking: [intake("e", { state: "BOOKING", storagePath: "receipts/intake/booking.pdf" })],
        missingReceipts: [request("m")],
    }), NOW);

    assert.deepEqual(todoStoragePaths(plan), [shared], "one path, once, and only from a pile");
});

// ── 7. What every string is allowed to say ────────────────────────────────

/** Every user-visible string this module can print, composed forms included. */
function everyString(): string[] {
    const strings: string[] = [];
    const walk = (value: unknown) => {
        if (typeof value === "string") strings.push(value);
        else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(TODO_COPY);
    walk(TODO_PILE_COPY);
    walk(FOLDED_COPY);
    walk(DYNAMIC_FOLDED_COPY);
    strings.push(rollUpSummary("$40.00", 10, "$400.00"));
    strings.push(rollUpDates("2026-08-14", "2026-09-02", "6098"));
    strings.push(rollUpDates("2026-08-14", "2026-09-02", null));
    for (const key of Object.keys(FOLDED_COPY) as Array<keyof typeof FOLDED_COPY>) {
        strings.push(fillCopy(FOLDED_COPY[key].many, { n: 7 }));
    }
    for (const key of Object.keys(DYNAMIC_FOLDED_COPY) as Array<keyof typeof DYNAMIC_FOLDED_COPY>) {
        strings.push(fillCopy(DYNAMIC_FOLDED_COPY[key].many, { n: 7, raw: "some-new-code" }));
    }
    strings.push(fillCopy(TODO_COPY.stripHeader, { n: 81 }));
    strings.push(fillCopy(TODO_COPY.doneSub, { n: 81 }));
    strings.push(fillCopy(TODO_COPY.pileAge, { n: 9 }));
    strings.push(fillCopy(TODO_COPY.capLine, { shown: 97, total: 109 }));
    strings.push(fillCopy(TODO_COPY.capLineOwner, { shown: 12, total: 109, owner: "Richard" }));
    strings.push(fillCopy(TODO_COPY.notLoaded, { n: 12 }));
    return strings;
}

test("no em dash, no en dash, no spaced hyphen, anywhere in the new copy", () => {
    const strings = everyString();
    assert.ok(strings.length > 50, `only ${strings.length} strings were scanned`);
    for (const line of strings) {
        assert.ok(!line.includes("—"), `em dash: ${line}`);
        assert.ok(!line.includes("–"), `en dash: ${line}`);
        assert.ok(!line.includes(" - "), `spaced hyphen: ${line}`);
    }
});

test("no string promises an outcome the pipeline is not in a position to deliver", () => {
    // The same rule reason-text.ts states for its own sentences. Say what is
    // true about the row and what action exists; never predict what happens
    // next. A promise that does not come true is how a bookkeeper learns to
    // stop reading the page.
    const BANNED: Array<[RegExp, string]> = [
        [/books? itself/i, "it may park again on the very next step"],
        [/will book/i, "same promise, different words"],
        [/\bclears\b/i, "nothing here can promise a row clears"],
        [/would fix|fixes it|fix it\b/i, "a fix is a prediction, not a fact about the row"],
        [/as soon as it has/i, "the job is one of several gates, not the last one"],
        [/tomorrow morning/i, "the crew chase lists are switched off, so nothing goes out tomorrow"],
        [/automatically/i, "say who or what acts, not that it is automatic"],
    ];
    for (const line of everyString()) {
        for (const [pattern, why] of BANNED) {
            assert.ok(!pattern.test(line), `"${line}" promises an outcome (${why})`);
        }
    }
});

test("every folded line has a singular and a plural, and the count is substituted", () => {
    const all = { ...FOLDED_COPY, ...DYNAMIC_FOLDED_COPY };
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
        const copy = all[key];
        assert.ok(copy.one.startsWith("1 "), `${key}: the singular says one`);
        assert.ok(copy.many.includes("{n}"), `${key}: the plural has somewhere to put the count`);
        assert.ok(!copy.one.includes("{n}"), `${key}: the singular never prints a placeholder`);
        assert.equal(fillCopy(copy.many, { n: 12, raw: "x" }).includes("12"), true, key);
    }
});

test("a line with one row uses the singular, and two use the plural", () => {
    const one = planTodo(queueOf({ booking: [intake("a", { state: "BOOKING" })] }), NOW);
    assert.equal(one.folded[0].text, "1 is in the booking queue.");
    const two = planTodo(queueOf({ booking: [intake("a", { state: "BOOKING" }), intake("b", { state: "BOOKING" })] }), NOW);
    assert.equal(two.folded[0].text, "2 are in the booking queue.");
});

// ── 8. The URL that picks this view ───────────────────────────────────────

test("a bare ?tab=receipts is the To-do view, and every other shape is what it was", () => {
    assert.equal(showsTodoView(parseReceiptFilters({})), true, "the default, and the only default that changes");
    assert.equal(showsTodoView(parseReceiptFilters({ view: "all" })), false);
    assert.equal(showsTodoView(parseReceiptFilters({ group: "needs-job" })), false);
    assert.equal(showsTodoView(parseReceiptFilters({ group: "missing-receipts", owner: "CJ" })), false);
    assert.equal(showsTodoView(parseReceiptFilters({ owner: "CJ" })), false, "an owner filter asks for something To-do cannot do");
    assert.equal(showsTodoView(parseReceiptFilters({ projectId: "p1" })), true, "a project filter still narrows the queue underneath");

    assert.equal(parseReceiptFilters({ view: "nonsense" }).view, "todo", "junk in `view` lands on the default");
    assert.equal(parseReceiptFilters({ view: ["all", "todo"] }).view, "all", "a repeated param takes the first value");
    assert.equal(parseReceiptFilters({ view: "todo" }).view, "todo");

    // A filter built by hand with no view is the pre-To-do shape and draws what
    // it always drew. That is what keeps the older render tests honest pins.
    assert.equal(showsTodoView({ group: null, projectId: null, owner: null }), false);
});

test("a group or owner this page does not know still means 'show me the groups'", () => {
    // It resolved to the all-groups view before the To-do view existed.
    // Bouncing a typo somewhere new is a behaviour change hiding in a typo.
    for (const sp of [
        { group: "" },
        { group: "../../etc/passwd" },
        { group: ["nonsense"] },
        { owner: "" },
        { owner: "Mallory" },
        { group: "", owner: "" },
    ] as Array<Record<string, string | string[]>>) {
        const filters = parseReceiptFilters(sp);
        assert.equal(filters.view, "all", JSON.stringify(sp));
        assert.equal(showsTodoView(filters), false, JSON.stringify(sp));
    }
    // An explicit `view` still wins: it is the one thing that named a view.
    assert.equal(parseReceiptFilters({ group: "", view: "todo" }).view, "todo");
});

// ── 9. Checks and sub bills ───────────────────────────────────────────────

test("looksLikeCheckOrSubBill: anchored, bounded at both ends, beaten by a real check number", () => {
    for (const descriptor of [
        "CHECK PAID 1042", "CHECK #1042", "  check paid", "CHECK NO 88", "CHECK 1042", "CHECK1042",
        "CHK 1031", "CHK#1031", "CHK NO 1031", "chk 1031", "CHECK-1031", "CHECK:1031", "CHK - 1031",
    ]) {
        assert.equal(looksLikeCheckOrSubBill(descriptor), true, descriptor);
    }
    // The cases the anchor and the two boundaries exist for. A debit card rail
    // is not a check, and neither is a payroll deposit or a background check
    // vendor.
    for (const descriptor of [
        "CHECK CARD PURCHASE", "CHK CARD PURCHASE", "CHECK PAIDOFF LOANS",
        "PAYCHECK DEPOSIT", "CHECKR INC", "CHECKING ACCOUNT FEE",
    ]) {
        assert.equal(looksLikeCheckOrSubBill(descriptor), false, descriptor);
    }
    for (const empty of [null, undefined, "", "   "]) {
        assert.equal(looksLikeCheckOrSubBill(empty), false, JSON.stringify(empty));
    }
    // The engine's own field wins when a caller has it.
    assert.equal(looksLikeCheckOrSubBill("AMAZON MKTPL", "1042"), true);
    assert.equal(looksLikeCheckOrSubBill("AMAZON MKTPL", "   "), false);
    assert.equal(looksLikeCheckOrSubBill("AMAZON MKTPL", null), false);
});

test("a check is its own pile, last, and never in Ask for these receipts", () => {
    const plan = planTodo(queueOf({
        missingReceipts: [
            request("check", { owner: "office", cardTail: null, payee: "RED POINT ELECTRIC", rawDescriptor: "CHECK PAID 1042", amountCents: -350_000 }),
            request("crew", { owner: "CJ" }),
        ],
    }), NOW);

    assert.deepEqual(rowIdsIn(plan, "checks-and-sub-bills"), ["check"]);
    assert.deepEqual(rowIdsIn(plan, "ask-for-these"), ["crew"]);
    assert.equal(plan.piles[plan.piles.length - 1].key, "checks-and-sub-bills",
        "last, despite holding the biggest numbers: it is the only pile that waits on a third party");
    assert.equal(plan.needsYouCount, 2);
    assert.equal(plan.handledCount, 0, "a check is nobody else's now");
});

test("a check that is held, answered or already reviewed stays folded", () => {
    const base = { owner: "office", cardTail: null, rawDescriptor: "CHECK PAID 1042" } as const;
    for (const [over, line] of [
        [{ outreachHold: "existing-evidence-review" }, "held"],
        [{ acknowledged: true }, "acknowledged"],
        [{ resolution: "memo-signed" }, "memo-signed"],
    ] as Array<[Partial<MissingReceiptRow>, string]>) {
        const plan = planTodo(queueOf({ missingReceipts: [request("c", { ...base, ...over })] }), NOW);
        assert.equal(rowIdsIn(plan, "checks-and-sub-bills").length, 0, line);
        assert.equal(plan.needsYouCount, 0, line);
        assert.equal(foldedCount(plan, line), 1, line);
    }
});

test("assigning a check to a PERSON routes it to them; assigning it to the office does not delete the pile", () => {
    const toPerson = planTodo(queueOf({
        missingReceipts: [request("c", { owner: "Richard", cardTail: null, ownerAssigned: true, rawDescriptor: "CHECK PAID 1042" })],
    }), NOW);
    assert.deepEqual(rowIdsIn(toPerson, "ask-for-these"), ["c"], "somebody already answered whose this is");
    assert.equal(rowIdsIn(toPerson, "checks-and-sub-bills").length, 0);

    // Assigning a check to "office" is AGREEMENT with the descriptor, not an
    // override of it. Treating it as one would let attributing a check quietly
    // delete the pile that tells somebody to post it.
    const toOffice = planTodo(queueOf({
        missingReceipts: [request("c", { owner: "office", cardTail: null, ownerAssigned: true, rawDescriptor: "CHECK PAID 1042" })],
    }), NOW);
    assert.deepEqual(rowIdsIn(toOffice, "checks-and-sub-bills"), ["c"]);
    assert.equal(toOffice.handledCount, 0);

    const carded = planTodo(queueOf({
        missingReceipts: [request("c", { owner: "CJ", cardTail: "8516", rawDescriptor: "CHECK PAID 1042" })],
    }), NOW);
    assert.deepEqual(rowIdsIn(carded, "ask-for-these"), ["c"], "a carded charge is never a check");
    assert.equal(rowIdsIn(carded, "checks-and-sub-bills").length, 0);
});

test("the check pile's procedure is a link into the guide, not a copy of it", () => {
    assert.equal(CHECK_GUIDE_HREF, "/automation/guide#checks-what-to-post");
    assert.equal(TODO_PILE_COPY["checks-and-sub-bills"].title, "Checks and sub bills");
    assert.equal(TODO_COPY.checkFacts, "check paid");
    assert.notEqual(TODO_COPY.checkFacts, TODO_COPY.noCard, "office rail is internal jargon and the wrong fact on a check");
});

// ── 10. What this view could not load ─────────────────────────────────────

test("notLoadedCount is the gap the display cap leaves, and never negative", () => {
    const capped = queueOf({ missingReceipts: [request("a", { acknowledged: true })] });
    capped.counts.missingReceipts = 109;
    capped.counts.missingReceiptsShown = 1;

    const plan = planTodo(capped, NOW);
    assert.equal(plan.notLoadedCount, 108);
    assert.equal(plan.needsYouCount, 0, "the loaded page is all acknowledged");
    // Which is exactly the shape that must NOT say "you're done": 108 older
    // requests are still open and none of them was even read.
    assert.ok(plan.notLoadedCount > 0);

    const whole = queueOf({ missingReceipts: [request("a")] });
    assert.equal(planTodo(whole, NOW).notLoadedCount, 0);

    const odd = queueOf({ missingReceipts: [request("a"), request("b")] });
    odd.counts.missingReceipts = 1;
    assert.equal(planTodo(odd, NOW).notLoadedCount, 0, "a count that is somehow smaller is zero, never negative");
});

test("a group that came back FULL is a window, and the plan says so", () => {
    const full = queueOf({
        booking: Array.from({ length: RECEIPT_GROUP_TAKE }, (_unused, index) => intake(`bk-${index}`, { state: "BOOKING" })),
    });
    const plan = planTodo(full, NOW);
    assert.deepEqual(plan.cappedGroups, ["booking"],
        "every list is read with take: RECEIPT_GROUP_TAKE and none of them pages");
    assert.equal(plan.needsYouCount, 0);
    // Which is the shape that must NOT say done: the piles are empty because
    // the page stopped reading, not because the queue did.
    assert.ok(plan.cappedGroups.length > 0);

    const short = queueOf({
        booking: Array.from({ length: RECEIPT_GROUP_TAKE - 1 }, (_unused, index) => intake(`bk-${index}`, { state: "BOOKING" })),
    });
    assert.deepEqual(planTodo(short, NOW).cappedGroups, [], "one short of the cap is the whole group");

    // Counts GROUPS, so it is deliberately outside the counted lines.
    assert.equal(planTodo(full, NOW).handledCount, RECEIPT_GROUP_TAKE, "conservation is untouched by it");
});

// ── 11. Where a folded line points ────────────────────────────────────────

test("a folded line carries a TARGET, so the render can keep the rest of the URL", () => {
    const plan = planTodo(queueOf({
        booking: [intake("bk", { state: "BOOKING" })],
        missingReceipts: [request("o", { owner: "office", cardTail: null, rawDescriptor: "ACH DEBIT" })],
    }), NOW);

    const booking = plan.folded.find(line => line.key === "booking");
    assert.deepEqual(booking?.target, { group: "booking" });
    const office = plan.folded.find(line => line.key === "office-owner");
    assert.deepEqual(office?.target, { group: "missing-receipts", owner: "office" });
    // An href built in here could not know about a project filter, so there is
    // none to be found.
    assert.ok(!("href" in (booking ?? {})), "the planner does not build URLs");
});
