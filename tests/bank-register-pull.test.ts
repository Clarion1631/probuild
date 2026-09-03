import assert from "node:assert/strict";
import test from "node:test";
import {
    convertRegisterRows,
    registerRowToIngestLine as registerRowToLine,
    runBankRegisterPull,
    ymdDaysAgo,
    type BankRegisterIngestLine,
    type BankRegisterRowLike,
} from "../src/lib/bank-register-pull";

// Fixture note: synthetic QBO General Ledger rows shaped like the ones
// fetchBankRegister() returns for the WTB bank account. No real GTR data.
// (These conversion cases moved here verbatim from tests/post-qbo-register.test.ts
// when the fetch+convert body moved out of the script and into the lib the
// nightly cron shares with it.)
//
// These cases guard the QBO→ledger pipe found missing on 2026-08-19: prod had
// 51 STATEMENT observations and 0 QBO ones, so reconcile could never link
// anything and receipt-matching was starved.

const row = (over: Partial<BankRegisterRowLike> = {}): BankRegisterRowLike => ({
    date: "2026-08-12",
    qbType: "Expense",
    qbTxnId: "txn-1",
    docNum: null,
    name: "LOWES",
    // The GL memo cell — the bank feed's own text. Absent on this base fixture,
    // so the descriptor falls back to `name`.
    memo: null,
    amountCents: -1234,
    ...over,
});

/**
 * registerRowToLine returns `line | null` (null = a row with no transaction
 * identity). Most cases here expect a real line, so this narrows once and
 * fails the test loudly if the mapper unexpectedly skipped the row.
 */
function mapped(over: Partial<BankRegisterRowLike> = {}): BankRegisterIngestLine {
    const line = registerRowToLine(row(over));
    assert.ok(line, "expected registerRowToLine to produce a line, got null");
    return line;
}

test("maps a normal expense row to an ingest line", () => {
    const line = mapped();
    // The transaction type is NOT part of the descriptor: no statement carries
    // " Expense" on the end, so appending it gave one transaction two
    // identities and nothing ever reconciled (Codex round-5 item 1).
    assert.deepEqual(line, {
        postedDate: "2026-08-12",
        amountCents: -1234,
        rawDescriptor: "LOWES",
        checkNumber: null,
        qbTxnId: "txn-1",
        // A row nobody asked QuickBooks about carries "Unknown" — never a
        // guess, and never a value that would let it mint.
        clearedStatus: "Unknown",
    });
});

test("clearance passes through, and an absent one is Unknown rather than a guess", () => {
    assert.equal(mapped({ clearedStatus: "Reconciled" }).clearedStatus, "Reconciled");
    assert.equal(mapped({ clearedStatus: "Cleared" }).clearedStatus, "Cleared");
    assert.equal(mapped({ clearedStatus: "Uncleared" }).clearedStatus, "Uncleared");
    // Absent and explicitly null both mean "we did not ask", which is the one
    // answer that can never be mistaken for evidence the money moved.
    assert.equal(mapped().clearedStatus, "Unknown");
    assert.equal(mapped({ clearedStatus: null }).clearedStatus, "Unknown");
});

test("rows without a transaction identity are skipped", async t => {
    await t.test("null qbTxnId (balance/summary row)", () => {
        assert.equal(registerRowToLine(row({ qbTxnId: null })), null);
    });
    await t.test("nothing to build a descriptor from", () => {
        assert.equal(registerRowToLine(row({ name: null, qbType: "", docNum: null })), null);
    });
    await t.test("whitespace-only name and type", () => {
        assert.equal(registerRowToLine(row({ name: "   ", qbType: "  ", docNum: "  " })), null);
    });
});

test("descriptor carries the payee name — reconcile normalizes it into a payee", () => {
    // An empty normalizedPayee is the EXCEPTION case in bank-ledger and never
    // matches anything, so the name must survive into the descriptor.
    const line = mapped({ name: "HOME DEPOT #4718", qbType: "Expense" });
    assert.equal(line.rawDescriptor, "HOME DEPOT #4718");
});

test("internal whitespace is collapsed for hash stability", () => {
    // The daily CSV parser learned this the hard way: an unnormalized
    // descriptor turns a cosmetic spacing change into a false 409.
    const line = mapped({ name: "LOWES    #1632", qbType: "Expense" });
    assert.equal(line.rawDescriptor, "LOWES #1632");
    assert.ok(!/ {2}/.test(line.rawDescriptor));
});

test("doc number is NOT appended (see the Drive-file-id suite below)", () => {
    const line = mapped({ docNum: "1027" });
    assert.equal(line.rawDescriptor, "LOWES");
});

test("doc_num NEVER enters the descriptor — it holds a Drive file id here", async t => {
    // Verified against live QBO 2026-08-19: on this realm doc_num carries a
    // Google Drive FILE ID stamped by the receipt pipeline (e.g.
    // "1sEISJBJaGRYpivooQJBR"), not a human doc number — the real txn id is a
    // short integer ("6625"). Splicing it into rawDescriptor would put an
    // opaque per-file identifier into the payee text, so the same vendor
    // re-filed under a new Drive id would look like a different payee and
    // never reconcile.
    await t.test("drive-file-id doc_num is absent from the descriptor", () => {
        const line = mapped({ docNum: "1sEISJBJaGRYpivooQJBR" });
        assert.equal(line.rawDescriptor, "LOWES");
        assert.ok(!line.rawDescriptor.includes("1sEISJBJaGRYpivooQJBR"));
    });
    await t.test("and it is not mistaken for a check number", () => {
        const line = mapped({ docNum: "1sEISJBJaGRYpivooQJBR" });
        assert.equal(line.checkNumber, null);
    });
    await t.test("even a numeric doc_num stays out of the descriptor", () => {
        const line = mapped({ docNum: "1027" });
        assert.equal(line.rawDescriptor, "LOWES");
    });
    await t.test("same vendor, different Drive ids → identical descriptor", () => {
        const a = mapped({ docNum: "1AAAAAAAAAAAAAAAAAAAA", qbTxnId: "6625" });
        const b = mapped({ docNum: "1BBBBBBBBBBBBBBBBBBBB", qbTxnId: "6626" });
        assert.equal(a.rawDescriptor, b.rawDescriptor);
    });
});

test("check numbers: one identity across all three parsers", async t => {
    await t.test("check-type row takes its number from docNum", () => {
        const line = mapped({ qbType: "Check", docNum: "1027" });
        assert.equal(line.checkNumber, "1027");
    });
    await t.test("leading zeros stripped (matches daily CSV + monthly PDF)", () => {
        const line = mapped({ qbType: "Check", docNum: "01027" });
        assert.equal(line.checkNumber, "1027");
    });
    await t.test("case-insensitive type match", () => {
        const line = mapped({ qbType: "check", docNum: "1027" });
        assert.equal(line.checkNumber, "1027");
    });
    await t.test("non-check row never claims a check number", () => {
        const line = mapped({ qbType: "Expense", docNum: "1027" });
        assert.equal(line.checkNumber, null);
    });
    await t.test("non-numeric docNum on a check is not a check number", () => {
        const line = mapped({ qbType: "Check", docNum: "EFT-99" });
        assert.equal(line.checkNumber, null);
    });
});

test("amounts pass through as signed integer cents, untouched", async t => {
    await t.test("money out stays negative", () => {
        assert.equal(mapped({ amountCents: -1234 }).amountCents, -1234);
    });
    await t.test("money in stays positive", () => {
        assert.equal(mapped({ amountCents: 565760, qbType: "Deposit" }).amountCents, 565760);
    });
    await t.test("zero is preserved", () => {
        assert.equal(mapped({ amountCents: 0 }).amountCents, 0);
    });
});

test("the posted date is passed through verbatim — no Date object, no tz shift", () => {
    const line = mapped({ date: "2026-01-01" });
    assert.equal(line.postedDate, "2026-01-01");
    assert.equal(typeof line.postedDate, "string");
});

// ── convertRegisterRows: a whole fetch → the ingest payload ──────────────────

/**
 * Five rows in the shape fetchBankRegister() returns, covering every branch
 * the converter has: a plain card purchase, a check, a deposit, a
 * balance/summary row with no txn identity, and a split that QBO emits twice
 * under the SAME qbTxnId.
 */
const FIVE_ROW_FIXTURE: BankRegisterRowLike[] = [
    { date: "2026-08-12", qbType: "Expense", qbTxnId: "6625", docNum: "1sEISJBJaGRYpivooQJBR", name: "Lowes", memo: "LOWES #02516 POS DEB C#8516", amountCents: -12_345, clearedStatus: "Reconciled" },
    { date: "2026-08-11", qbType: "Check", qbTxnId: "6610", docNum: "01027", name: "PACIFIC PLUMBING", memo: null, amountCents: -250_000, clearedStatus: "Uncleared" },
    { date: "2026-08-10", qbType: "Deposit", qbTxnId: "6598", docNum: null, name: "MUELLER REMODEL", memo: null, amountCents: 565_760, clearedStatus: "Cleared" },
    { date: "2026-08-01", qbType: "", qbTxnId: null, docNum: null, name: null, memo: null, amountCents: 0 },
    { date: "2026-08-12", qbType: "Expense", qbTxnId: "6625", docNum: "1sEISJBJaGRYpivooQJBR", name: "Lowes", memo: "LOWES #02516 POS DEB C#8516", amountCents: -12_345, clearedStatus: "Reconciled" },
];

test("convertRegisterRows maps the fixture, skips identity-less rows, collapses split repeats", () => {
    const result = convertRegisterRows(FIVE_ROW_FIXTURE);
    assert.equal(result.skipped, 1, "the balance/summary row carries no txn identity");
    assert.equal(result.collapsed, 1, "the repeated 6625 split is ONE observation");
    assert.deepEqual(result.lines, [
        // The memo wins over the name, and the type is never appended.
        { postedDate: "2026-08-12", amountCents: -12_345, rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null, qbTxnId: "6625", clearedStatus: "Reconciled" },
        // The UNCLEARED check survives conversion unchanged. It is not dropped
        // here — it becomes an observation like any other; what it may not do
        // is mint a canonical line (see planQboMint).
        { postedDate: "2026-08-11", amountCents: -250_000, rawDescriptor: "PACIFIC PLUMBING", checkNumber: "1027", qbTxnId: "6610", clearedStatus: "Uncleared" },
        { postedDate: "2026-08-10", amountCents: 565_760, rawDescriptor: "MUELLER REMODEL", checkNumber: null, qbTxnId: "6598", clearedStatus: "Cleared" },
    ]);
});

test("convertRegisterRows never emits a qbTxnId twice — the ingest route 400s a batch that does", () => {
    const { lines } = convertRegisterRows(FIVE_ROW_FIXTURE);
    const ids = lines.map(l => l.qbTxnId);
    assert.equal(new Set(ids).size, ids.length);
});

test("ymdDaysAgo is UTC-only — no local timezone can shift a posting date", () => {
    const nowMs = Date.parse("2026-08-12T03:00:00Z");
    assert.equal(ymdDaysAgo(0, nowMs), "2026-08-12");
    assert.equal(ymdDaysAgo(6, nowMs), "2026-08-06");
});

// ── runBankRegisterPull: idempotency against an injected fake ────────────────

/**
 * A fake standing in for the ingest route + its table. It models the ONE thing
 * idempotency depends on: observation identity is the qbTxnId, and a row whose
 * id is already stored counts as `existing`, never a new insert. Content that
 * differs under a stored id is a 409, exactly like the real route.
 */
function fakeIngestStore() {
    const stored = new Map<string, string>();
    const calls: number[] = [];
    return {
        stored,
        calls,
        async ingest(_account: string, lines: BankRegisterIngestLine[]) {
            calls.push(lines.length);
            let inserted = 0;
            let existing = 0;
            for (const line of lines) {
                const content = JSON.stringify([line.postedDate, line.amountCents, line.rawDescriptor, line.checkNumber]);
                const prior = stored.get(line.qbTxnId);
                if (prior === undefined) { stored.set(line.qbTxnId, content); inserted++; continue; }
                if (prior !== content) {
                    return { status: 409, body: { ok: false, reason: "qbo-txn-conflict", qbTxnId: line.qbTxnId } };
                }
                existing++;
            }
            return { status: 200, body: { ok: true, inserted, existing } };
        },
    };
}

function pullDeps(store: ReturnType<typeof fakeIngestStore>, rows: BankRegisterRowLike[], reconcileCalls: string[]) {
    return {
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        fetchRows: async () => ({ rows, stale: false }),
        ingest: store.ingest,
        reconcile: async (account: string) => { reconcileCalls.push(account); return { linked: 0, proposed: 0 }; },
    };
}

test("runBankRegisterPull: a second run over the same window inserts ZERO new rows", async () => {
    const store = fakeIngestStore();
    const reconcileCalls: string[] = [];

    const first = await runBankRegisterPull(pullDeps(store, FIVE_ROW_FIXTURE, reconcileCalls));
    assert.equal(first.ok, true);
    assert.equal(first.observations, 3);
    assert.equal(first.inserted, 3);
    assert.equal(first.existing, 0);

    const second = await runBankRegisterPull(pullDeps(store, FIVE_ROW_FIXTURE, reconcileCalls));
    assert.equal(second.ok, true);
    assert.equal(second.inserted, 0, "re-running an overlapping window must create nothing");
    assert.equal(second.existing, 3);
    assert.equal(store.stored.size, 3);
    assert.deepEqual(reconcileCalls, ["WTB-0723", "WTB-0723"], "reconcile runs after every pull");
});

test("runBankRegisterPull: the window is the last 7 dates, inclusive of today", async () => {
    const store = fakeIngestStore();
    const summary = await runBankRegisterPull(pullDeps(store, [], []));
    assert.equal(summary.endDate, "2026-08-12");
    assert.equal(summary.startDate, "2026-08-06");
    assert.equal(summary.observations, 0);
    assert.deepEqual(store.calls, [], "an empty register posts nothing at all");
});

test("runBankRegisterPull: a QBO restatement stops the run and is reported, never retried", async () => {
    const store = fakeIngestStore();
    await runBankRegisterPull(pullDeps(store, FIVE_ROW_FIXTURE, []));

    // QuickBooks edited 6625's amount after we recorded it.
    const restated = FIVE_ROW_FIXTURE.map(r => (r.qbTxnId === "6625" ? { ...r, amountCents: -99_999 } : r));
    const summary = await runBankRegisterPull(pullDeps(store, restated, []));
    assert.equal(summary.ok, false);
    assert.equal(summary.error, "qbo-txn-conflict");
    assert.deepEqual(summary.conflictQbTxnIds, ["6625"]);
    assert.equal(store.stored.get("6625"), JSON.stringify(["2026-08-12", -12_345, "LOWES #02516 POS DEB C#8516", null]),
        "the stored observation is never silently overwritten");
});

test("runBankRegisterPull: a reconcile failure FAILS the pull — unlinked observations starve the matcher", async () => {
    const store = fakeIngestStore();
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        fetchRows: async () => ({ rows: FIVE_ROW_FIXTURE, stale: false }),
        ingest: store.ingest,
        reconcile: async () => { throw new Error("pool exhausted"); },
    });
    // Round 4 item 5a: this used to return ok:true and a 200, so nobody was
    // ever paged for a reconcile outage — while the matcher quietly ran on
    // incomplete truth. The observations DID land; the run still failed.
    assert.equal(summary.ok, false);
    assert.equal(summary.error, "reconcile-failed");
    assert.equal(summary.inserted, 3, "whatever committed stays committed");
    assert.equal(summary.reconciled, null);
});

test("divergent repeats under one qbTxnId are a CONFLICT, never first-wins", async t => {
    const divergent: BankRegisterRowLike[] = [
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "6625", docNum: null, name: "LOWES", memo: null, amountCents: -12_345 },
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "6625", docNum: null, name: "LOWES", memo: null, amountCents: -99_999 },
        { date: "2026-08-11", qbType: "Expense", qbTxnId: "6610", docNum: null, name: "NAPA", memo: null, amountCents: -500 },
    ];

    await t.test("neither sighting is posted — half a contradiction is still a guess", () => {
        const result = convertRegisterRows(divergent);
        assert.deepEqual(result.conflicts, ["6625"]);
        assert.deepEqual(result.lines.map(l => l.qbTxnId), ["6610"]);
        assert.equal(result.collapsed, 0, "a divergent repeat is not a collapse");
    });

    await t.test("identical repeats still collapse and are NOT conflicts", () => {
        const result = convertRegisterRows(FIVE_ROW_FIXTURE);
        assert.deepEqual(result.conflicts, []);
        assert.equal(result.collapsed, 1);
    });

    await t.test("the good rows still post, and the run fails with the ids", async () => {
        const store = fakeIngestStore();
        const summary = await runBankRegisterPull(pullDeps(store, divergent, []));
        assert.equal(summary.ok, false);
        assert.equal(summary.error, "qbo-duplicate-conflict");
        assert.deepEqual(summary.conflictQbTxnIds, ["6625"]);
        assert.equal(summary.inserted, 1, "the non-conflicting row is good evidence and still lands");
        assert.equal(store.stored.has("6625"), false, "the contradicted id is stored by nobody");
    });
});

test("the mint step runs only when the caller supplies it, and after reconcile", async () => {
    const store = fakeIngestStore();
    const order: string[] = [];

    const withoutMint = await runBankRegisterPull(pullDeps(store, FIVE_ROW_FIXTURE, []));
    assert.equal(withoutMint.minted, undefined, "absent dependency = feature off, no branch to get wrong");

    const store2 = fakeIngestStore();
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        fetchRows: async () => ({ rows: FIVE_ROW_FIXTURE, stale: false }),
        ingest: store2.ingest,
        reconcile: async () => { order.push("reconcile"); return { linked: 1, proposed: 1 }; },
        mintFromQbo: async () => { order.push("mint"); return { minted: 2, skipped: { tooRecent: 1 } }; },
    });
    assert.deepEqual(order, ["reconcile", "mint"], "an observation the statement covers must be linked BEFORE it is a mint candidate");
    assert.deepEqual(summary.minted, { minted: 2, skipped: { tooRecent: 1 } });
});

test("a mint failure FAILS the pull too, though the observations are already stored", async () => {
    const store = fakeIngestStore();
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        fetchRows: async () => ({ rows: FIVE_ROW_FIXTURE, stale: false }),
        ingest: store.ingest,
        reconcile: async () => ({ linked: 0, proposed: 0 }),
        mintFromQbo: async () => { throw new Error("pool exhausted"); },
    });
    assert.equal(summary.ok, false);
    assert.equal(summary.error, "mint-failed");
    assert.equal(summary.inserted, 3, "whatever committed stays committed");
    assert.equal(summary.minted, null);
});
