/**
 * The To-do planner: what is a person's work, what the system is handling, and
 * the one thing this view is never allowed to do.
 *
 * THE LEAD ASSERTION IS CONSERVATION. Every row the queue hands `planTodo`
 * lands in exactly one pile or exactly one folded line. Never both, never
 * neither. A row that falls through every rule disappears off the only page
 * that lists it, and nobody finds out until a bank reconciliation does. That
 * test is written first on purpose.
 *
 * Amounts here are NEGATIVE, because a bank charge is. Sorting "biggest first"
 * therefore has to be by magnitude, and a fixture full of positive numbers
 * would never catch it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    CHECK_GUIDE_HREF,
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
import { parseReceiptFilters, showsTodoView } from "../src/app/automation/receipts-filters";
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

const totalRows = (queue: ReceiptQueue) =>
    queue.needsJob.length + queue.needsReview.length + queue.booking.length
    + queue.bookedToday.length + queue.duplicates.length + queue.exceptions.length
    + queue.uncertainCards.length + queue.missingReceipts.length;

const pile = (plan: TodoPlan, key: TodoPileKey) => {
    const found = plan.piles.find(entry => entry.key === key);
    assert.ok(found, `no ${key} pile`);
    return found;
};

const rowIdsIn = (plan: TodoPlan, key: TodoPileKey): string[] =>
    pile(plan, key).items.flatMap(item => item.kind === "intake" ? [item.row.id] : item.item.rows.map(row => row.id));

const allPileRowIds = (plan: TodoPlan): string[] => plan.piles.flatMap(entry =>
    entry.items.flatMap(item => item.kind === "intake" ? [item.row.id] : item.item.rows.map(row => row.id)));

const foldedCount = (plan: TodoPlan, key: string) => plan.folded.find(line => line.key === key)?.count ?? 0;

// ── 1. Conservation, first ────────────────────────────────────────────────

test("every row in the queue lands in exactly one pile or exactly one folded line", () => {
    // One row of every shape this page can hold.
    const queue = queueOf({
        needsJob: [intake("nj", { state: "NEEDS_JOB", stateReason: null })],
        needsReview: [
            intake("r-noest", { stateReason: "no-estimate" }),
            intake("r-unread", { stateReason: "unreadable" }),
            intake("r-missing", { stateReason: "file-missing" }),
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
            intake("r-max", { stateReason: "max-retries" }),
            intake("r-paused", { stateReason: "push-paused" }),
            intake("r-disabled", { stateReason: "push-disabled" }),
        ],
        booking: [intake("bk", { state: "BOOKING" })],
        bookedToday: [intake("bt", { state: "BOOKED" })],
        duplicates: [intake("dup", { state: "DUPLICATE" })],
        exceptions: [intake("exc", { postVoidQbPurchaseId: "qb-1" })],
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

    assert.equal(
        plan.needsYouCount + plan.handledCount,
        totalRows(queue),
        "a row is counted once, somewhere. Neither is a rounding error",
    );

    const inPiles = allPileRowIds(plan);
    assert.equal(new Set(inPiles).size, inPiles.length, "no row is drawn in two piles");
    assert.equal(inPiles.length, plan.needsYouCount, "needsYouCount counts rows, not rolled-up lines");
    assert.equal(
        plan.folded.reduce((sum, line) => sum + line.count, 0),
        plan.handledCount,
        "the strip's own lines add up to the number in its header",
    );

    // And the split itself, named.
    assert.deepEqual(rowIdsIn(plan, "whose-card").sort(), ["m-unassigned", "m-unattr"]);
    assert.deepEqual(rowIdsIn(plan, "pick-the-job").sort(), ["nj", "r-noest"]);
    assert.deepEqual(
        rowIdsIn(plan, "better-photo").sort(),
        ["r-missing", "r-multi", "r-multi1", "r-unknown", "r-unread"],
        "an unrecognised reason is HERS, not folded",
    );
    assert.deepEqual(rowIdsIn(plan, "ask-for-these").sort(), ["m-cj", "m-rich"]);
    assert.deepEqual(rowIdsIn(plan, "checks-and-sub-bills"), ["m-check"]);
});

test("the folded strip is always drawn, even with nothing in it", () => {
    const plan = planTodo(queueOf(), NOW);
    assert.deepEqual(plan.folded, [], "no line claims a count it does not have");
    assert.equal(plan.handledCount, 0);
    assert.equal(plan.needsYouCount, 0);
    assert.equal(fillCopy(TODO_COPY.stripHeader, { n: 0 }), "The system is handling 0 of these.");
});

// ── 2. Which reasons are a person's ───────────────────────────────────────

test("isOfficeManagerReason: the office manager's reasons, and an unknown one", () => {
    for (const reason of ["no-estimate", "unreadable", "file-missing", "multi-doc", "multi-doc:one-page"]) {
        assert.equal(isOfficeManagerReason(reason), true, reason);
    }
    for (const reason of [
        "invalid-date", "date-implausible", "weak-dup:x", "strong-dup-amount-mismatch:x",
        "vendor-mismatch:x", "refund-or-zero", "native-qbo-reconciliation-required",
        "qbo-purchase-mismatch:x", "ai-unavailable", "max-retries", "push-paused", "push-disabled",
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

test("a parked row that is nobody's to fix lands on exactly one folded line", () => {
    const plan = planTodo(queueOf({
        needsReview: [
            intake("a", { stateReason: "ai-unavailable" }),
            intake("b", { stateReason: "push-paused" }),
            intake("c", { stateReason: "refund-or-zero" }),
        ],
    }), NOW);

    assert.equal(foldedCount(plan, "retrying"), 2, "the system will try these again");
    assert.equal(foldedCount(plan, "bookkeeping"), 1, "this one needs a person who is not her");
    assert.equal(plan.needsYouCount, 0);
    assert.equal(plan.handledCount, 3);
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

test("a cent of difference, a different person, or an unreadable payee is not a repeat", () => {
    assert.equal(rollUpRepeats([repeat("a", "2026-09-01"), repeat("b", "2026-09-02", { amountCents: -4_001 })]).length, 2);
    assert.equal(rollUpRepeats([repeat("a", "2026-09-01"), repeat("b", "2026-09-02", { owner: "Richard" })]).length, 2,
        "a merged line across two people has nobody to ask");
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

test("biggest dollars first, and a roll-up sorts by its total", () => {
    const plan = planTodo(queueOf({
        needsJob: [
            intake("small", { state: "NEEDS_JOB", totalCents: -1_000 }),
            intake("big", { state: "NEEDS_JOB", totalCents: -58_000 }),
            intake("mid", { state: "NEEDS_JOB", totalCents: -9_900 }),
        ],
        missingReceipts: [
            request("rent", { payee: "SUNBELT RENTALS", amountCents: -58_000, postedDate: "2026-09-10" }),
            ...Array.from({ length: 10 }, (_unused, index) =>
                request(`dump-${index}`, { payee: "THE ROCKERY NW", amountCents: -4_000, postedDate: `2026-08-2${index}`.slice(0, 10) })),
        ],
    }), NOW);

    assert.deepEqual(rowIdsIn(plan, "pick-the-job"), ["big", "mid", "small"]);

    const ask = pile(plan, "ask-for-these").items;
    assert.equal(ask.length, 2, "ten dump tickets are one line");
    assert.ok(ask[0].kind === "request" && ask[1].kind === "request");
    // $400 of dump tickets beats a $580 rental only if the roll-up sorts by
    // the SUM. It does not, so the rental leads.
    assert.equal(ask[0].kind === "request" ? ask[0].item.totalCents : 0, -58_000);
    assert.equal(ask[1].kind === "request" ? ask[1].item.rows.length : 0, 10);
    assert.equal(ask[1].kind === "request" ? ask[1].item.totalCents : 0, -40_000);
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
        assert.equal(plan.folded[0].count, 1, name);
        assert.ok(plan.folded[0].href?.startsWith("/automation?tab=receipts&group="), `${name}: the line links to a real group view`);
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

test("an unrecognised resolution stays visible instead of folding", () => {
    const plan = planTodo(queueOf({ missingReceipts: [request("x", { resolution: "something-new" })] }), NOW);
    assert.deepEqual(rowIdsIn(plan, "ask-for-these"), ["x"], "a shape nobody has words for must not go quiet");
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

// ── 7. House style over every string this view can print ──────────────────

test("no em dash, no en dash, no spaced hyphen, anywhere in the new copy", () => {
    const strings: string[] = [];
    const walk = (value: unknown) => {
        if (typeof value === "string") strings.push(value);
        else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(TODO_COPY);
    walk(TODO_PILE_COPY);
    walk(FOLDED_COPY);
    // The composed sentences too, not just their parts.
    strings.push(rollUpSummary("$40.00", 10, "$400.00"));
    strings.push(rollUpDates("2026-08-14", "2026-09-02", "6098"));
    strings.push(rollUpDates("2026-08-14", "2026-09-02", null));
    for (const key of Object.keys(FOLDED_COPY) as Array<keyof typeof FOLDED_COPY>) {
        strings.push(fillCopy(FOLDED_COPY[key].many, { n: 7 }));
    }
    strings.push(fillCopy(TODO_COPY.stripHeader, { n: 81 }));
    strings.push(fillCopy(TODO_COPY.doneSub, { n: 81 }));
    strings.push(fillCopy(TODO_COPY.pileAge, { n: 9 }));
    strings.push(fillCopy(TODO_COPY.capLine, { shown: 97, total: 109 }));
    strings.push(fillCopy(TODO_COPY.capLineOwner, { shown: 12, total: 109, owner: "Richard" }));

    assert.ok(strings.length > 40, `only ${strings.length} strings were scanned`);
    for (const line of strings) {
        assert.ok(!line.includes("—"), `em dash: ${line}`);
        assert.ok(!line.includes("–"), `en dash: ${line}`);
        assert.ok(!line.includes(" - "), `spaced hyphen: ${line}`);
    }
});

test("every folded line has a singular and a plural, and the count is substituted", () => {
    for (const key of Object.keys(FOLDED_COPY) as Array<keyof typeof FOLDED_COPY>) {
        const copy = FOLDED_COPY[key];
        assert.ok(copy.one.startsWith("1 "), `${key}: the singular says one`);
        assert.ok(copy.many.includes("{n}"), `${key}: the plural has somewhere to put the count`);
        assert.ok(!copy.one.includes("{n}"), `${key}: the singular never prints a placeholder`);
        assert.equal(fillCopy(copy.many, { n: 12 }).includes("12"), true, key);
    }
});

test("a line with one row uses the singular, and two use the plural", () => {
    const one = planTodo(queueOf({ booking: [intake("a", { state: "BOOKING" })] }), NOW);
    assert.equal(one.folded[0].text, "1 is booking right now.");
    const two = planTodo(queueOf({ booking: [intake("a", { state: "BOOKING" }), intake("b", { state: "BOOKING" })] }), NOW);
    assert.equal(two.folded[0].text, "2 are booking right now.");
});

// ── 8. The URL that picks this view ───────────────────────────────────────

test("a bare ?tab=receipts is the To-do view, and every other shape is what it was", () => {
    assert.equal(showsTodoView(parseReceiptFilters({})), true, "the default, and the only default that changes");
    assert.equal(showsTodoView(parseReceiptFilters({ view: "all" })), false);
    assert.equal(showsTodoView(parseReceiptFilters({ group: "needs-job" })), false);
    assert.equal(showsTodoView(parseReceiptFilters({ group: "missing-receipts", owner: "CJ" })), false);
    assert.equal(showsTodoView(parseReceiptFilters({ owner: "CJ" })), false, "an owner filter asks for something To-do cannot do");
    assert.equal(showsTodoView(parseReceiptFilters({ projectId: "p1" })), true, "a project filter still narrows the queue underneath");

    assert.equal(parseReceiptFilters({ view: "nonsense" }).view, "todo", "junk never lands anywhere but the default");
    assert.equal(parseReceiptFilters({ view: ["all", "todo"] }).view, "all", "a repeated param takes the first value");
    assert.equal(parseReceiptFilters({ view: "todo" }).view, "todo");

    // A filter built by hand with no view is the pre-To-do shape and draws what
    // it always drew. That is what keeps the older render tests honest pins.
    assert.equal(showsTodoView({ group: null, projectId: null, owner: null }), false);
});

// ── 9. Checks and sub bills ───────────────────────────────────────────────

test("looksLikeCheckOrSubBill: anchored, bounded, and beaten by a real check number", () => {
    for (const descriptor of ["CHECK PAID 1042", "CHECK #1042", "  check paid", "CHECK NO 88", "CHECK 1042", "CHECK1042"]) {
        assert.equal(looksLikeCheckOrSubBill(descriptor), true, descriptor);
    }
    // The two the anchor and the boundary exist for.
    assert.equal(looksLikeCheckOrSubBill("PAYCHECK DEPOSIT"), false);
    assert.equal(looksLikeCheckOrSubBill("CHECKR INC"), false);
    assert.equal(looksLikeCheckOrSubBill("CHECKING ACCOUNT FEE"), false);
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

test("a hand set owner and a card tail both beat the descriptor", () => {
    const assigned = planTodo(queueOf({
        missingReceipts: [request("c", { owner: "Richard", cardTail: null, ownerAssigned: true, rawDescriptor: "CHECK PAID 1042" })],
    }), NOW);
    assert.deepEqual(rowIdsIn(assigned, "ask-for-these"), ["c"], "somebody already answered whose this is");
    assert.equal(rowIdsIn(assigned, "checks-and-sub-bills").length, 0);

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
