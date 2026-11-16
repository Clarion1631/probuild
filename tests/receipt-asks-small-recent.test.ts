/**
 * Crew receipt asks stay small and recent (spec receipt-asks-small-and-recent,
 * 2026-11-16, with the Codex design-check changes C1 to C6).
 *
 * Real descriptors and pairs come from the 2026-11-16 audit of Richard's card
 * (6098) and CJ's (8516). New exports are read through a namespace import so a
 * missing one fails the assertion rather than the whole file's import.
 */
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import * as cards from "../src/lib/receipt-request-cards";
import * as policyNs from "../src/lib/receipt-policy";
import {
    buildOwnerCards,
    cardText,
    rebuildCardItems,
    selectOwnerItems,
    type CardCandidateIssue,
    type CardItem,
    type CardItemTruth,
} from "../src/lib/receipt-request-cards";
import { planReceiptRequests, type ReceiptEvidenceExpense, type ReceiptEvidenceIntake, type ReceiptRequestBankLine } from "../src/lib/receipt-requests";
import { classifyReceiptRequirement, isCrewReceiptRequest } from "../src/lib/receipt-policy";
import { normalizePayee } from "../src/lib/bank-ledger";
import { planTodo, TODO_COPY, TODO_PILE_COPY } from "../src/app/automation/receipts-todo";
import { ReceiptsTab } from "../src/app/automation/components/receipts/receipts-tab";
import type { MissingReceiptRow, ReceiptQueue } from "../src/app/automation/receipts-data";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TODAY = "2026-11-17";
const TOO_OLD_SENTENCE = "Too old for the crew list. Office follows up.";

const dayBefore = (n: number, from = TODAY): string =>
    new Date(Date.parse(`${from}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const cand = (over: Partial<CardCandidateIssue> = {}): CardCandidateIssue => ({
    id: "ri-1", targetKey: "bl-1", owner: "Richard", acknowledged: false, cardTail: "6098",
    postedDate: dayBefore(5), amountCents: -12_345, payee: "PARR LUMBER VANCOUVER WA",
    fingerprint: "pb-bl-1", everCarded: false, ...over,
});

// ── G1 / C1: recent only, 0 to 14 days inclusive ─────────────────────────────

test("G1: the window is 0 to 14 days inclusive of the card date", () => {
    assert.equal((cards as Record<string, unknown>).CREW_ASK_WINDOW_DAYS, 14);
    const pick = (postedDate: string) => selectOwnerItems([cand({ postedDate })], "Richard", TODAY).items.length;
    assert.equal(pick(TODAY), 1, "today is in");
    assert.equal(pick(dayBefore(14)), 1, "14 days (2026-11-03) is in");
    assert.equal(pick(dayBefore(15)), 0, "15 days (2026-11-02) is out");
    assert.equal(pick("2026-11-18"), 0, "a future date is not asked");
    assert.equal(pick(""), 0, "an unreadable date is not asked");
});

test("G1: an old charge never goes on a card, asked before or not", () => {
    const old = [
        cand({ id: "a", targetKey: "bl-a", postedDate: "2026-09-08" }),
        cand({ id: "b", targetKey: "bl-b", postedDate: "2026-10-10", everCarded: true }),
    ];
    assert.deepEqual(selectOwnerItems(old, "Richard", TODAY), { items: [], overflow: 0 });
    assert.deepEqual(buildOwnerCards(old, new Date("2026-11-17T17:00:00Z")), []);
});

test("C2: today is required in the cards path; without it nothing is selected (fail closed)", () => {
    const recent = [cand()];
    assert.deepEqual(selectOwnerItems(recent, "Richard", undefined as unknown as string), { items: [], overflow: 0 });
    assert.deepEqual(selectOwnerItems(recent, "Richard", "not-a-date"), { items: [], overflow: 0 });
});

// ── G3 / C5: five items, no backlog reserve ──────────────────────────────────

test("G3: at most 5 items, and the old backlog reserve is gone", () => {
    assert.equal(cards.MAX_ITEMS_PER_CARD, 5);
    assert.equal((cards as Record<string, unknown>).BACKLOG_RESERVED_SLOTS, undefined);
    assert.equal((cards as Record<string, unknown>).RECENT_CHARGE_WINDOW_DAYS, undefined);
    const eight = Array.from({ length: 8 }, (_, i) => cand({ id: `r${i}`, targetKey: `bl-${i}`, postedDate: dayBefore(i) }));
    const withBacklog = [...eight, ...Array.from({ length: 20 }, (_, i) => cand({ id: `o${i}`, targetKey: `bl-old-${i}`, postedDate: dayBefore(30 + i) }))];
    const picked = selectOwnerItems(withBacklog, "Richard", TODAY);
    assert.equal(picked.items.length, 5);
    assert.equal(picked.overflow, 3, "overflow counts only askable charges, not the 20 old ones");
    assert.ok(picked.items.every(item => item.date >= dayBefore(14)), "no backlog item rides along");
});

test("G3: never-asked first, then already-asked, oldest first inside each group", () => {
    const picked = selectOwnerItems([
        cand({ id: "asked-old", targetKey: "bl-1", postedDate: dayBefore(12), everCarded: true }),
        cand({ id: "new-newer", targetKey: "bl-2", postedDate: dayBefore(2) }),
        cand({ id: "new-older", targetKey: "bl-3", postedDate: dayBefore(9) }),
        cand({ id: "asked-newer", targetKey: "bl-4", postedDate: dayBefore(4), everCarded: true }),
    ], "Richard", TODAY);
    assert.deepEqual(picked.items.map(item => item.issueId), ["new-older", "new-newer", "asked-old", "asked-newer"]);
});

test("C3: a pile of old rows cannot hide a recent one (the scan has no per-owner quota)", () => {
    const old = Array.from({ length: 50 }, (_, i) => cand({ id: `o${i}`, targetKey: `bl-o-${i}`, postedDate: dayBefore(20 + i) }));
    const recent = cand({ id: "fresh", targetKey: "bl-z-fresh", postedDate: dayBefore(1) });
    const picked = selectOwnerItems([...old, recent], "Richard", TODAY);
    assert.deepEqual(picked.items.map(item => item.issueId), ["fresh"]);
    assert.equal(picked.overflow, 0);
});

// ── G6 / C3 / C5: honest card text ───────────────────────────────────────────

test("G6: the header and the more-line count only askable charges, and nothing promises tomorrow", () => {
    const askable = Array.from({ length: 7 }, (_, i) => cand({ id: `r${i}`, targetKey: `bl-${i}`, postedDate: dayBefore(i) }));
    const noise = [
        ...Array.from({ length: 30 }, (_, i) => cand({ id: `o${i}`, targetKey: `bl-old-${i}`, postedDate: dayBefore(40 + i) })),
        cand({ id: "dropbox", targetKey: "bl-dbx", postedDate: dayBefore(1), payee: "MISCELLANEOUS DEBIT DROPBOX 88NDNQ4N5B3S DROPBOX.COM CA" }),
        cand({ id: "venmo", targetKey: "bl-ven", postedDate: dayBefore(1), payee: "MISCELLANEOUS DEBIT VENMO RICHARD LORD NEW YORK NY" }),
    ];
    const [card] = buildOwnerCards([...askable, ...noise], new Date("2026-11-17T17:00:00Z"));
    assert.equal(card.items.length, 5);
    assert.equal(card.overflow, 2);
    assert.match(card.text, /\(5 of 7\)/);
    assert.match(card.text, /and 2 more waiting\./);
    assert.doesNotMatch(card.text, /tomorrow/i);
});

test("G6: when the scan is not exact the text still makes no promise", () => {
    const items: CardItem[] = [{ n: 1, fingerprint: "f", date: "2026-11-10", vendor: "PARR", cents: 100, amount: "1.00", cardTail: "6098", issueId: "i", targetKey: "t" }];
    assert.doesNotMatch(cardText("Richard", TODAY, items, 4, false), /tomorrow/i);
    assert.doesNotMatch(cardText("Richard", TODAY, items, 4, true), /tomorrow/i);
    assert.match(cardText("Richard", TODAY, items, 4, false), /and more waiting\./);
});

// ── C2: the age rule at pre-send revalidation ────────────────────────────────

const truthOf = (id: string): Map<string, CardItemTruth> => new Map([[id, {
    clearedAt: null, acknowledged: false, resolved: false, evidenceSatisfied: false, owner: "Richard", outreachHold: null,
}]]);
const itemOf = (over: Partial<CardItem> = {}): CardItem => ({
    n: 1, fingerprint: "f", date: dayBefore(5), vendor: "PARR LUMBER VANCOUVER WA", cents: 12_345,
    amount: "123.45", cardTail: "6098", issueId: "ri-1", targetKey: "bl-1", ...over,
});

test("C2: an item that ages out between claim and send is dropped from the card", () => {
    const inside = rebuildCardItems([itemOf()], truthOf("ri-1"), "Richard", TODAY);
    assert.equal(inside.items.length, 1);
    const aged = rebuildCardItems([itemOf({ date: dayBefore(15) })], truthOf("ri-1"), "Richard", TODAY);
    assert.equal(aged.items.length, 0);
    assert.equal(aged.dropped[0].reason, "too-old");
});

test("C2: revalidation without a usable today drops everything (fail closed)", () => {
    for (const today of [undefined, "", "garbage"]) {
        const result = rebuildCardItems([itemOf()], truthOf("ri-1"), "Richard", today as unknown as string);
        assert.equal(result.items.length, 0, String(today));
    }
});

// ── G4b / C4: software, person to person and dues are office holds ───────────

const line = (rawDescriptor: string, over: Partial<ReceiptRequestBankLine> = {}): ReceiptRequestBankLine => ({
    id: "line", amountCents: -1294, postedDate: "2026-11-04", rawDescriptor: `${rawDescriptor} C#6098`, ...over,
});

test("G4b: DROPBOX, GROK and XAI are software, never asked of the crew", () => {
    for (const descriptor of [
        "MISCELLANEOUS DEBIT DROPBOX 88NDNQ4N5B3S DROPBOX.COM CA",
        "MISCELLANEOUS DEBIT GROK XAI WWW.GROK.COM CA",
    ]) {
        assert.equal(isCrewReceiptRequest({ amountCents: -1294, rawDescriptor: descriptor }), false, descriptor);
        assert.equal(classifyReceiptRequirement({ amountCents: -1294, rawDescriptor: descriptor }).requirement, "receipt_expected", "still collected, not dropped");
    }
});

test("G4b: person-to-person payments on a card are never asked of the crew", () => {
    for (const descriptor of [
        "MISCELLANEOUS DEBIT VENMO RICHARD LORD NEW YORK NY",
        "MISCELLANEOUS DEBIT VENMO JEREMIAH THOMAS NEW YORK NY",
        "MISCELLANEOUS DEBIT VENMO KANDI SNYDER VISA DIRECT NY",
        "MISCELLANEOUS DEBIT CASH APP*KANDI SNYDER Oakland CA",
        "MISCELLANEOUS DEBIT ZELLE PAYMENT TO SOMEONE",
    ]) {
        // Both inputs the policy is called with: the raw bank text and the
        // normalized payee the sweep stores on the issue (item.vendor).
        assert.equal(isCrewReceiptRequest({ amountCents: -100_000, rawDescriptor: `${descriptor} C#6098` }), false, `raw: ${descriptor}`);
        assert.equal(isCrewReceiptRequest({ amountCents: -100_000, rawDescriptor: normalizePayee(`${descriptor} C#6098`) }), false, `normalized: ${descriptor}`);
        assert.equal(classifyReceiptRequirement({ amountCents: -100_000, rawDescriptor: descriptor }).requirement, "receipt_expected", "held for the office, not closed");
    }
});

test("G4b: the VENMO JUSTIN ADKINS owner transfer keeps working", () => {
    const verdict = classifyReceiptRequirement({ amountCents: -500_000, rawDescriptor: "PAYMENT    VENMO JUSTIN ADKINS 1052320032752 WEB" });
    assert.equal(verdict.requirement, "no_receipt_expected");
    assert.equal(verdict.ruleKey, "owner-transfer");
});

test("G4b: the BIA OF CC dues invoice is an office item", () => {
    const descriptor = "MISCELLANEOUS DEBIT BIA OF CC INV-38021 BIAOFCLARKCOU WA";
    assert.equal(isCrewReceiptRequest({ amountCents: -80_000, rawDescriptor: descriptor }), false);
    assert.equal(isCrewReceiptRequest({ amountCents: -80_000, rawDescriptor: normalizePayee(`${descriptor} C#6098`) }), false);
    assert.equal(classifyReceiptRequirement({ amountCents: -80_000, rawDescriptor: descriptor }).requirement, "receipt_expected");
});

test("G4b: ordinary store purchases are still asked", () => {
    for (const descriptor of ["MISCELLANEOUS DEBIT PARR LUMBER VANCOUVER WA", "LOWES #02516 VANCOUVER WA", "AMAZON MKTPL*AB1CD2 AMZN.COM WA"]) {
        assert.equal(isCrewReceiptRequest({ amountCents: -2_560, rawDescriptor: descriptor }), true, descriptor);
    }
});

test("G4b: selection and revalidation both refuse those charges, on the normalized vendor too", () => {
    const vendor = "MISCELLANEOUS DEBIT VENMO RICHARD LORD NEW YORK NY";
    assert.equal(selectOwnerItems([cand({ payee: vendor })], "Richard", TODAY).items.length, 0);
    const dropped = rebuildCardItems([itemOf({ vendor })], truthOf("ri-1"), "Richard", TODAY);
    assert.equal(dropped.items.length, 0);
    assert.equal(dropped.dropped[0].reason, "office-invoice");
});

test("G4b: the sweep opens these as office-invoice holds, never closes or drops them", () => {
    for (const descriptor of [
        "MISCELLANEOUS DEBIT DROPBOX 88NDNQ4N5B3S DROPBOX.COM CA",
        "MISCELLANEOUS DEBIT VENMO RICHARD LORD NEW YORK NY",
        "MISCELLANEOUS DEBIT BIA OF CC INV-38021 BIAOFCLARKCOU WA",
        "MISCELLANEOUS DEBIT GROK XAI WWW.GROK.COM CA",
        "MISCELLANEOUS DEBIT VENMO KANDI SNYDER VISA DIRECT NY",
    ]) {
        const plan = planReceiptRequests({
            bankLines: [line(descriptor)], expenses: [], intakes: [], openIssueKeys: ["line"], now: new Date("2026-11-17T12:00:00Z"),
        });
        assert.deepEqual(plan.close, [], descriptor);
        assert.equal(plan.open.length, 1, descriptor);
        assert.equal(plan.open[0].displayDetails.outreachHold, "office-invoice", descriptor);
    }
});

// ── G4a / C4: a likely receipt on file holds the ask ─────────────────────────

const NOW_OCT = new Date("2026-10-22T12:00:00Z");
const intake = (over: Partial<ReceiptEvidenceIntake>): ReceiptEvidenceIntake => ({
    id: "in-1", state: "NEEDS_REVIEW", totalCents: null, txnDate: null, vendor: null, ...over,
});
const holdFor = (
    bank: Partial<ReceiptRequestBankLine> & { rawDescriptor: string; postedDate: string; amountCents: number },
    evidence: { intakes?: ReceiptEvidenceIntake[]; expenses?: ReceiptEvidenceExpense[] },
) => {
    const plan = planReceiptRequests({
        bankLines: [{ id: "line", ...bank }], expenses: evidence.expenses ?? [], intakes: evidence.intakes ?? [],
        openIssueKeys: [], now: NOW_OCT,
    });
    assert.equal(plan.open.length, 1);
    assert.deepEqual(plan.close, []);
    return plan.open[0].displayDetails.outreachHold;
};

test("G4a: Lowe's online $11.64 and $8.92 against one Lowe's receipt of $20.56 are both held", () => {
    for (const amountCents of [-1164, -892]) {
        assert.equal(holdFor(
            { rawDescriptor: "LOWES #02516 VANCOUVER WA C#6098", postedDate: "2026-10-09", amountCents },
            { intakes: [intake({ totalCents: 2056, txnDate: "2026-10-08", vendor: "Lowe's" })] },
        ), "existing-evidence-review", String(amountCents));
    }
});

test("G4a: Amazon $23.94 and $9.79 against an Amazon receipt with no total are both held", () => {
    for (const [amountCents, postedDate] of [[-2394, "2026-09-22"], [-979, "2026-09-23"]] as const) {
        assert.equal(holdFor(
            { rawDescriptor: "AMAZON MKTPL*AB1CD2 AMZN.COM WA C#6098", postedDate, amountCents },
            { intakes: [intake({ totalCents: null, txnDate: "2026-09-21", vendor: "Amazon" })] },
        ), "existing-evidence-review", postedDate);
    }
});

test("G4a: Parr Lumber $25.60 against a Parr slip read as -$25.60 is held", () => {
    assert.equal(holdFor(
        { rawDescriptor: "PARR LUMBER VANCOUVER WA C#8516", postedDate: "2026-10-19", amountCents: -2560 },
        { intakes: [intake({ totalCents: -2560, txnDate: "2026-10-17", vendor: "Parr Lumber" })] },
    ), "existing-evidence-review");
});

test("F3: an Expense with a receipt holds by the same cents only, never by vendor alone", () => {
    const bank = { rawDescriptor: "LOWES #02516 VANCOUVER WA C#6098", postedDate: "2026-10-09", amountCents: -1164 };
    assert.equal(holdFor(bank, { expenses: [{ id: "e1", hasReceipt: true, amountCents: 2056, date: "2026-10-08", vendor: "Lowe's" }] }), null,
        "a booked receipt for another Lowe's charge must not hold this one");
    assert.equal(holdFor(bank, { expenses: [{ id: "e2", hasReceipt: true, amountCents: 1164, date: "2026-10-04", vendor: "Lowe's" }] }),
        "existing-evidence-review", "the same cents still holds");
});

test("F3: a BOOKED Lowe's intake 2 days away does not hold a different-amount Lowe's charge", () => {
    const bank = { rawDescriptor: "LOWES #02516 VANCOUVER WA C#6098", postedDate: "2026-10-09", amountCents: -1164 };
    assert.equal(holdFor(bank, { intakes: [intake({ totalCents: 2056, txnDate: "2026-10-07", vendor: "Lowe's", state: "BOOKED", expenseId: "exp-1" })] }), null);
    assert.equal(holdFor(bank, { intakes: [intake({ totalCents: 2056, txnDate: "2026-10-07", vendor: "Lowe's", state: "NEEDS_REVIEW", expenseId: null })] }),
        "existing-evidence-review", "the same receipt still waiting on a person does hold");
});

test("G4a: a Lowe's receipt 20 days away does NOT hold the ask", () => {
    assert.equal(holdFor(
        { rawDescriptor: "LOWES #02516 VANCOUVER WA C#6098", postedDate: "2026-10-09", amountCents: -1164 },
        { intakes: [intake({ totalCents: 2056, txnDate: "2026-09-19", vendor: "Lowe's" })] },
    ), null);
});

test("G4a: the vendor window is 7 days, no more", () => {
    const at = (txnDate: string) => holdFor(
        { rawDescriptor: "LOWES #02516 VANCOUVER WA C#6098", postedDate: "2026-10-09", amountCents: -1164 },
        { intakes: [intake({ totalCents: 2056, txnDate, vendor: "Lowe's" })] },
    );
    assert.equal(at("2026-10-02"), "existing-evidence-review", "7 days before");
    assert.equal(at("2026-10-16"), "existing-evidence-review", "7 days after");
    assert.equal(at("2026-10-01"), null, "8 days before");
});

test("G4a: a different vendor, a dead intake or an undated one does not hold", () => {
    const bank = { rawDescriptor: "LOWES #02516 VANCOUVER WA C#6098", postedDate: "2026-10-09", amountCents: -1164 };
    assert.equal(holdFor(bank, { intakes: [intake({ txnDate: "2026-10-08", vendor: "Home Depot" })] }), null);
    assert.equal(holdFor(bank, { intakes: [intake({ txnDate: "2026-10-08", vendor: "Lowe's", state: "DUPLICATE" })] }), null);
    assert.equal(holdFor(bank, { intakes: [intake({ txnDate: null, vendor: "Lowe's" })] }), null);
    assert.equal(holdFor(bank, { intakes: [intake({ txnDate: "2026-10-08", vendor: null })] }), null);
    assert.equal(holdFor(bank, { expenses: [{ id: "e", hasReceipt: false, amountCents: 2056, date: "2026-10-08", vendor: "Lowe's" }] }), null,
        "an Expense without a receipt proves nothing");
});

test("G4a: the existing same-cents-within-30-days rule is unchanged", () => {
    assert.equal(holdFor(
        { rawDescriptor: "SOME HARDWARE C#6098", postedDate: "2026-10-09", amountCents: -12_345 },
        { expenses: [{ id: "e", hasReceipt: true, amountCents: 12_345, date: "2026-09-25", vendor: "Other" }] },
    ), "existing-evidence-review");
});

// ── G5: too old goes to the office, and stays open ───────────────────────────

const NOW = new Date("2026-11-17T17:00:00Z");
function request(id: string, over: Partial<MissingReceiptRow> = {}): MissingReceiptRow {
    return {
        id, version: 1, reasonHash: `hash-${id}`, acknowledged: false,
        targetKey: `bank-${id}`, owner: "Richard", ownerAssigned: false,
        cardTail: "6098", postedDate: dayBefore(5), amountCents: -4_000,
        payee: "PARR LUMBER", rawDescriptor: "PARR LUMBER VANCOUVER WA",
        fingerprint: `fp-${id}`, threadName: null, outreachHold: null,
        resolution: null, pdfUrl: null, ...over,
    };
}
function queueOf(missingReceipts: MissingReceiptRow[]): ReceiptQueue {
    return {
        needsJob: [], needsReview: [], booking: [], bookedToday: [], duplicates: [], exceptions: [], uncertainCards: [],
        missingReceipts,
        counts: {
            needsJob: 0, needsReview: 0, booking: 0, bookedToday: 0, duplicates: 0, exceptions: 0, uncertainCards: 0,
            missingReceipts: missingReceipts.length, missingReceiptsShown: missingReceipts.length,
        },
    };
}
const rowIds = (plan: ReturnType<typeof planTodo>, key: string): string[] =>
    (plan.piles.find(p => p.key === key as never)?.items ?? []).flatMap(item => item.kind === "intake" ? [item.row.id] : item.item.rows.map(r => r.id));

test("G5: a crew charge older than 14 days is counted in the office pile, not the crew pile", () => {
    const plan = planTodo(queueOf([
        request("fresh", { postedDate: dayBefore(14) }),
        request("stale", { postedDate: dayBefore(15) }),
        request("cj-stale", { owner: "CJ", cardTail: "8516", postedDate: "2026-09-22", amountCents: -2_500 }),
        request("justin-stale", { owner: "Justin", cardTail: "4297", postedDate: "2026-09-22", amountCents: -3_500 }),
    ]), NOW);
    assert.deepEqual(rowIds(plan, "ask-for-these").sort(), ["fresh", "justin-stale"]);
    assert.deepEqual(rowIds(plan, "too-old-for-crew").sort(), ["cj-stale", "stale"]);
    const all = plan.piles.flatMap(p => rowIds(plan, p.key));
    assert.equal(new Set(all).size, 4, "conservation: each row in exactly one pile");
    assert.equal(plan.needsYouCount, 4);
});

test("G5: held, reviewed and answered rows stay where they were, however old", () => {
    const plan = planTodo(queueOf([
        request("held", { postedDate: "2026-09-22", outreachHold: "existing-evidence-review" }),
        request("acked", { postedDate: "2026-09-22", acknowledged: true }),
        request("memo", { postedDate: "2026-09-22", resolution: "memo-signed" }),
    ]), NOW);
    assert.deepEqual(rowIds(plan, "too-old-for-crew"), []);
    assert.equal(plan.handledCount, 3);
});

test("G5: the office pile says it in plain words and sits before the checks pile", () => {
    const copy = (TODO_PILE_COPY as Record<string, { title: string; note: string }>)["too-old-for-crew"];
    assert.ok(copy, "pile copy exists");
    assert.match(copy.note, /Office follows up\./);
    assert.equal((TODO_COPY as Record<string, unknown>).tooOldRow, TOO_OLD_SENTENCE);
    const plan = planTodo(queueOf([request("x", { postedDate: "2026-09-22" })]), NOW);
    const keys = plan.piles.map(p => p.key as string);
    assert.equal(keys[keys.length - 1], "checks-and-sub-bills");
    assert.ok(keys.indexOf("too-old-for-crew") > keys.indexOf("ask-for-these"));
});

async function renderMissing(rows: MissingReceiptRow[], now: Date): Promise<string> {
    return renderToStaticMarkup(await ReceiptsTab({
        queue: queueOf(rows), filters: { group: "missing-receipts", projectId: null, owner: null },
        jobs: [], filterHref: () => "/automation?tab=receipts", nativeActive: false,
        sign: async (paths: readonly string[]) => new Map(paths.map((p: string) => [p, `https://storage.test/${p}`])),
        now,
    }));
}

test("G5: the Receipts tab says it on an old open charge and stays quiet on a recent one", async () => {
    const html = await renderMissing([
        request("stale", { postedDate: "2026-09-22" }),
        request("fresh", { postedDate: dayBefore(3) }),
    ], NOW);
    assert.equal(html.split(TOO_OLD_SENTENCE).length - 1, 1, "exactly the old row");
    const held = await renderMissing([request("held", { postedDate: "2026-09-22", outreachHold: "office-invoice" })], NOW);
    assert.doesNotMatch(held, new RegExp(TOO_OLD_SENTENCE), "a held row keeps its own sentence");
});

// ── G7: both guide files, identical text ─────────────────────────────────────

const GUIDE_SENTENCES = [
    "Each list holds up to 5 charges",
    "posted in the last 14 days",
    "ProBuild does not know when a month is closed",
    "Too old for the crew list. Office follows up.",
    "a likely receipt is already on file",
];

test("G7: the guide HTML and its hand-made copy carry the same new rules", () => {
    const html = readFileSync(join(ROOT, "docs", "qbo-expense-sync-flow.html"), "utf8").replace(/\r\n/g, "\n");
    const ts = readFileSync(join(ROOT, "src", "app", "automation", "guide", "guide-html.ts"), "utf8");
    const startAt = ts.indexOf("GUIDE_HTML: string = ");
    const literal = startAt < 0 ? null : ts.slice(startAt + "GUIDE_HTML: string = ".length, ts.lastIndexOf(";"));
    assert.ok(literal, "guide-html.ts holds one string literal");
    const copy = JSON.parse(literal) as string;
    for (const sentence of GUIDE_SENTENCES) {
        assert.ok(html.includes(sentence), `html: ${sentence}`);
        assert.ok(copy.includes(sentence), `ts: ${sentence}`);
    }
    assert.equal(copy, html, "the copy is the HTML, byte for byte once line endings are normalised");
    assert.doesNotMatch(html, /3 spots are kept for older ones/);
});

// ── Dry run on the REAL open list for Richard's card 6098 (fix round F6) ─────
//
// Posted date | amount | bank text exactly as the Receipts page showed it (some
// are cut short), supplied by the owner on 2026-11-16. "A" marks the 10 rows that
// were asked on 2026-11-16. The rows go through the REAL sweep planner (holds are
// computed, not typed in) and then the REAL selection. No receipt evidence is fed
// in: the notes do not carry the intake queue, so the same-vendor hold is not
// exercised here. The assertions are only what the rules guarantee.

const REAL_LIST = `2026-11-04|800.00|BIA OF CC INV-38021 BIAOFCLARKCOU WA
2026-11-03|146.77|PARR LUMBER #09 VANCOUVER WA
2026-11-02|32.00|FLOOR AND DECOR 386 FLOOR AND DECOR 38
2026-11-02|139.96|LOWES #02954 VANCOUVER WA
2026-11-02|12.94|DROPBOX 88NDNQ4N5B3S DROPBOX.COM CA
2026-10-30|2247.85|SUMMIT PLUMBING LLC WWW.SUMMITPLUMBING
2026-10-30|101.45|ARCO#82887KT KANSO LLC 2 3817 MAIN ST
2026-10-30|1136.92|PREMIUM EXTERIORS 7714 NE 39TH CT
2026-10-26|21.77|ACE HARDWARE MAIN STRE VANCOUVER WA
2026-10-23|1067.22|PREMIUM EXTERIORS 7714 NE 39TH CT
2026-10-23|741.12|PARR LUMBER #09 VANCOUVER WA
2026-10-22|1334.74|169 QXO VANCOUVER WA
2026-10-16|72.92|LOWES #01632 VANCOUVER WA
2026-10-16|240.54|LOWES #01632 VANCOUVER WA
2026-10-16|179.69|169 QXO VANCOUVER WA
2026-10-15|356.72|LOWES #01632 VANCOUVER WA
2026-10-14|74.83|PARR LUMBER #09 VANCOUVER WA
2026-10-14|48.24|LOWES #01632 VANCOUVER WA
2026-10-13|60.30|US MARKET US MARKET
2026-10-13|1486.61|VENMO RICHARD LORD NEW YORK NY
2026-10-13|50.00|24 HR FOOD MART 24 HR FOOD MART
2026-10-13|50.00|24 HR FOOD MART 24 HR FOOD MART
2026-10-13|50.00|24 HR FOOD MART 24 HR FOOD MART
2026-10-13|121.96|HARBOR FREIGHT TOOLS USA H
2026-10-13|65.99|FLOOR AND DECOR 386 FLOOR
2026-10-09|118.32|LOWES #01632 VANCOUVER WA
2026-10-09|414.04|MYKNOBS.COM GEORGE MYKNOB
2026-10-09|11.64|LOWES #00907 NC
2026-10-09|10.00|FLOOR AND DECOR 386 FLOOR
2026-10-09|63.61|FLOOR AND DECOR 386 FLOOR
2026-10-09|8.92|LOWES #00907 NC
2026-10-08|784.07|HARBOR FREIGHT TOOLS USA H
2026-10-08|30.00|GROK XAI WWW.GROK.COM CA
2026-10-07|29.38|TST LA BOTTEGA VANCOUVER W
2026-10-07|23.52|PANDA EXPRESS 1672 VANCOUV
2026-10-05|146.97|CHEVRON CAMAS WA
2026-10-05|1000.00|VENMO JEREMIAH THOMAS NEW
2026-10-05|12.94|DROPBOX ZX6MRKCCKW2D DROPB
2026-10-05|272.94|LOWES #01632 VANCOUVER WA
2026-10-05|621.08|LOWES #01632 VANCOUVER WA
2026-10-05|226.15|169 QXO VANCOUVER WA
2026-10-05|203.27|SOLARFLEXION WWW.SOLARFLEX
2026-09-28|145.99|CHEVRON CAMAS WA
2026-09-28|113.11|PARR LUMBER #09 VANCOUVER
2026-09-25|60.32|LOWES #01632 VANCOUVER WA
2026-09-24|200.00|IN HARD NOTCHED CUSTO 360-
2026-09-24|126.32|EASTSIDE STEEL INC VANCOUV
2026-09-24|370.00|HENDERSON + DAUGHTER WA
2026-09-23|9.79|AMAZON MKTPL 5R9KF8772 AMZ
2026-09-22|388.80|THE HOME DEPOT #4718 THE H|A
2026-09-22|50.00|ARCO#836814TH PLAIN ARCO 1
2026-09-22|108.80|SHERWIN-WILLIAMS708008 VAN
2026-09-22|23.94|AMAZON MKTPL 5R17M6IB0 AMZ
2026-09-22|301.51|AMERICAN STONE VANCOUVER A
2026-09-21|240.00|VENMO KANDI SNYDER VISA DI|A
2026-09-21|29.10|LOWES #01632 VANCOUVER WA|A
2026-09-17|14.35|SQ RICHLANDHUB COMPAN VANC|A
2026-09-16|1440.21|PREMIUM EXTERIORS 7714 NE|A
2026-09-14|10.00|SQ C$J BBQ HOUSE RIDGEFIEL|A
2026-09-11|143.29|34 MUTUAL MATERIALS NO WA|A
2026-09-11|1557.81|CALPORTLAND INC CA|A
2026-09-08|128.35|THE HOME DEPOT #4740 THE HOME DEPOT 47|A
2026-09-08|1050.00|IN HEDERA LLC DBA MUR 360- WA|A`;

function dryRunCard(today: string): { text: string; items: CardItem[]; overflow: number; summary: string } {
    const parsed = REAL_LIST.split("\n").map(row => {
        const [date, amount, text, asked] = row.split("|");
        return { date, cents: Math.round(Number(amount) * 100), text, asked: asked === "A" };
    });
    const bankLines: ReceiptRequestBankLine[] = parsed.map((row, i) => ({
        id: `bl-${String(i).padStart(2, "0")}`,
        amountCents: -row.cents,
        postedDate: row.date,
        rawDescriptor: `MISCELLANEOUS DEBIT ${row.text} C#6098`,
    }));
    const asked = new Set(bankLines.filter((_, i) => parsed[i].asked).map(l => l.id));
    const at = new Date(`${today}T17:00:00Z`);
    const plan = planReceiptRequests({ bankLines, expenses: [], intakes: [], openIssueKeys: bankLines.map(l => l.id), now: at });
    const candidates: CardCandidateIssue[] = plan.open.map(item => ({
        id: `ri-${item.targetKey}`, targetKey: item.targetKey, owner: item.displayDetails.owner, acknowledged: false,
        cardTail: item.displayDetails.cardTail, postedDate: item.displayDetails.postedDate,
        amountCents: item.displayDetails.amountCents, payee: item.displayDetails.payee,
        fingerprint: item.displayDetails.fingerprint, everCarded: asked.has(item.targetKey),
        outreachHold: item.displayDetails.outreachHold,
    }));
    const [card] = buildOwnerCards(candidates, at);
    const holds = plan.open.reduce<Record<string, number>>((acc, item) => {
        const key = item.displayDetails.outreachHold ?? "none";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
    }, {});
    const summary = `DRY RUN today=${today}: ${parsed.length} rows, ${plan.open.length} open, holds ${JSON.stringify(holds)}\n${
        card ? `CARD (${card.items.length} item(s), ${card.overflow} more waiting):\n${card.text}` : "NO CARD"}`;
    return { text: card?.text ?? "", items: card?.items ?? [], overflow: card?.overflow ?? 0, summary };
}

for (const today of ["2026-11-17", "2026-11-16", "2026-11-10"]) {
    test(`dry run on the real list, today ${today}: short, recent, crew-only`, () => {
        const result = dryRunCard(today);
        console.log(result.summary);
        const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
        assert.ok(result.items.length <= 5);
        assert.ok(result.items.every(item => item.date >= oldest && item.date <= today), `every item posted ${oldest} or later`);
        assert.ok(result.items.every(item => !/DROPBOX|GROK|VENMO|BIA OF CC/.test(item.vendor)), "no software, Venmo or dues line");
        assert.doesNotMatch(result.text, /tomorrow/i);
    });
}

// ── Fix round: F1 cap, F2 honest counts, F4 wording and piles, F5 note ───────

test("F1: a snapshot of 10 in-window crew items rebuilds to 5", () => {
    const items = Array.from({ length: 10 }, (_, i) => itemOf({ n: i + 1, issueId: `i${i}`, targetKey: `bl-${i}`, date: dayBefore(i) }));
    const truth = new Map(items.map(item => [item.issueId, truthOf(item.issueId).get(item.issueId)!]));
    const rebuilt = rebuildCardItems(items, truth, "Richard", TODAY);
    assert.equal(rebuilt.items.length, 5);
    assert.deepEqual(rebuilt.items.map(item => item.n), [1, 2, 3, 4, 5]);
    assert.deepEqual(rebuilt.items.map(item => item.issueId), ["i0", "i1", "i2", "i3", "i4"], "claimed order is kept");
    assert.equal((rebuilt as unknown as { cut?: number }).cut, 5, "the cut is reported so the card prints no total");
});

const claimedCardOf = (overflow: number) => cards.buildCardFromItems(
    "Richard", TODAY, Array.from({ length: 5 }, (_, i) => itemOf({ n: i + 1, issueId: `i${i}`, targetKey: `bl-${i}` })), overflow, true);

test("F2: a fresh card nothing was dropped from keeps its count and more-line", () => {
    const claimed = claimedCardOf(3);
    const out = (cards as Record<string, any>).cardAfterRebuild(claimed, { items: claimed.items, dropped: [], cut: 0 }, true) as cards.OwnerCard;
    assert.match(out.text, /\(5 of 8\)/);
    assert.match(out.text, /and 3 more waiting\./);
});

test("F2: a rebuild that dropped or cut something prints only its own count and no more-line", () => {
    const claimed = claimedCardOf(3);
    const after = (cards as Record<string, any>).cardAfterRebuild;
    for (const rebuilt of [
        { items: claimed.items.slice(0, 4), dropped: [{ issueId: "i4", reason: "cleared" }], cut: 0 },
        { items: claimed.items, dropped: [], cut: 2 },
    ]) {
        const out = after(claimed, rebuilt, true) as cards.OwnerCard;
        assert.match(out.text, /\(\d\)/);
        assert.doesNotMatch(out.text, / of \d/);
        assert.doesNotMatch(out.text, /more waiting/);
    }
});

test("F2: a resumed or queued card prints no total and no more-line, even when nothing changed", () => {
    const claimed = claimedCardOf(3);
    const out = (cards as Record<string, any>).cardAfterRebuild(claimed, { items: claimed.items, dropped: [], cut: 0 }, false) as cards.OwnerCard;
    assert.doesNotMatch(out.text, / of \d/);
    assert.doesNotMatch(out.text, /more waiting/);
    assert.equal(out.overflow, 0);
});

test("F2: the route no longer feeds a stored overflow into a resumed or queued card", () => {
    const source = readFileSync(join(ROOT, "src", "app", "api", "cron", "receipt-request-cards", "route.ts"), "utf8");
    assert.doesNotMatch(source, /buildCardFromItems\(row\.owner, row\.pacificDate, items, row\.overflow/);
    assert.doesNotMatch(source, /buildCardFromItems\(owner, date, items, existing\.overflow/);
    assert.match(source, /cardAfterRebuild\(/);
});

test("F4: the P2P helper recognizes the rail on raw and normalized text, and not a store", () => {
    const helper = (policyNs as Record<string, any>).isPersonToPersonPayment as ((d: string) => boolean) | undefined;
    assert.equal(typeof helper, "function");
    assert.equal(helper!("MISCELLANEOUS DEBIT VENMO KANDI SNYDER VISA DIRECT NY C#6098"), true);
    assert.equal(helper!(normalizePayee("MISCELLANEOUS DEBIT VENMO RICHARD LORD NEW YORK NY C#6098")), true);
    assert.equal(helper!("MISCELLANEOUS DEBIT DROPBOX 88NDNQ4N5B3S DROPBOX.COM CA"), false);
});

test("F4: the tab says a payment to a person is that, not an office invoice", async () => {
    const html = await renderMissing([
        request("p2p", { outreachHold: "office-invoice", payee: "VENMO KANDI SNYDER", rawDescriptor: "MISCELLANEOUS DEBIT VENMO KANDI SNYDER VISA DIRECT NY C#6098" }),
        request("dues", { outreachHold: "office-invoice", payee: "BIA OF CC INV-38021", rawDescriptor: "MISCELLANEOUS DEBIT BIA OF CC INV-38021 BIAOFCLARKCOU WA C#6098" }),
    ], NOW);
    const sentence = "Payment to a person. The office adds a note saying what it was for. Crew request held.";
    assert.equal(html.split(sentence).length - 1, 1, "only the P2P row");
    assert.equal(html.split("Office invoice").length - 1, 1, "the dues row keeps the invoice sentence");
});

test("F4: the To-do fold names payments to people on their own line", () => {
    const plan = planTodo(queueOf([
        request("p2p", { outreachHold: "office-invoice", rawDescriptor: "MISCELLANEOUS DEBIT VENMO KANDI SNYDER VISA DIRECT NY C#6098" }),
        request("dues", { outreachHold: "office-invoice", rawDescriptor: "MISCELLANEOUS DEBIT BIA OF CC INV-38021 BIAOFCLARKCOU WA C#6098" }),
    ]), NOW);
    const line = plan.folded.find(entry => entry.key === "person-payment");
    assert.ok(line, "its own folded line");
    assert.deepEqual(line.ids, ["p2p"]);
    assert.match(line.text, /payment to a person/);
    assert.deepEqual(plan.folded.find(entry => entry.key === "office-invoice")?.ids, ["dues"]);
});

test("F4: rows with no crew owner land where they did on origin/main (the whose-card pile), not in a fold", () => {
    const plan = planTodo(queueOf([
        request("zelle", { owner: "unattributed", cardTail: null, outreachHold: "office-invoice", rawDescriptor: "MISCELLANEOUS DEBIT ZELLE PAYMENT TO SOMEONE" }),
        request("dues", { owner: "unassigned", cardTail: "1234", outreachHold: "office-invoice", rawDescriptor: "MISCELLANEOUS DEBIT BIA OF CC INV-38021 BIAOFCLARKCOU WA" }),
        request("dropbox", { owner: "unattributed", cardTail: null, outreachHold: "office-invoice", rawDescriptor: "MISCELLANEOUS DEBIT DROPBOX 88NDNQ4N5B3S DROPBOX.COM CA" }),
    ]), NOW);
    assert.deepEqual(rowIds(plan, "whose-card").sort(), ["dues", "zelle"]);
    assert.deepEqual(plan.folded.find(entry => entry.key === "office-invoice")?.ids, ["dropbox"], "software was a hold on main and still is");
});

test("F5: the unattributed note no longer promises tomorrow's card", async () => {
    const html = await renderMissing([request("u", { owner: "unattributed", cardTail: null })], NOW);
    assert.doesNotMatch(html, /joins their card tomorrow morning/);
    assert.match(html, /posted in the last 14 days/);
    assert.match(html, /office follows up/i);
});
