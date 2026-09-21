import assert from "node:assert/strict";
import test from "node:test";
import {
    convertRegisterRows,
    registerRowToIngestLine as registerRowToLine,
    runBankRegisterPull,
    ymdDaysAgo,
    type BankRegisterIngestLine,
    type BankRegisterRowLike,
    type QboRestatementConflict,
    BANK_REGISTER_CHUNK_SIZE,
    MAX_CONFLICTS_PER_RUN,
    MAX_SPLITS_PER_TXN,
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

test("convertRegisterRows maps the fixture, skips identity-less rows, splits repeats by ordinal", () => {
    const result = convertRegisterRows(FIVE_ROW_FIXTURE);
    assert.equal(result.skipped, 1, "the balance/summary row carries no txn identity");
    /**
     * TWO IDENTICAL ROWS ARE TWO SPLITS, NOT ONE (round-46 gate, finding 1).
     *
     * They used to collapse by content, which quietly threw away a real
     * posting: a transaction with two equal splits to the same account is
     * exactly the shape that collapse destroyed. Ordinal identity keeps both,
     * and keeps them distinguishable.
     */
    assert.equal(result.collapsed, 0, "nothing collapses by content any more");
    assert.equal(result.split, 2, "the repeated 6625 is two splits");
    assert.deepEqual(result.lines, [
        // The memo wins over the name, and the type is never appended.
        { postedDate: "2026-08-12", amountCents: -12_345, rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null, qbTxnId: "6625#0", clearedStatus: "Reconciled" },
        { postedDate: "2026-08-12", amountCents: -12_345, rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null, qbTxnId: "6625#1", clearedStatus: "Reconciled" },
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
    // 4 since round 46 (finding 1): the repeated 6625 is two splits at two
    // ordinals, not one row collapsed by content.
    assert.equal(first.observations, 4);
    assert.equal(first.inserted, 4);
    assert.equal(first.existing, 0);

    const second = await runBankRegisterPull(pullDeps(store, FIVE_ROW_FIXTURE, reconcileCalls));
    assert.equal(second.ok, true);
    // THE ORDINAL IDENTITY IS WHAT MAKES THIS ZERO. A content-derived id would
    // have produced the same ids here too — but only because nothing changed;
    // the restatement test above is where the two differ.
    assert.equal(second.inserted, 0, "re-running an overlapping window must create nothing");
    assert.equal(second.existing, 4);
    assert.equal(store.stored.size, 4);
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
    // The identity is now ordinal-based (round-46 gate, finding 1), so the
    // restated split keeps the id it already had — which is the whole point:
    // the ingest updates the row it has rather than minting a second one, and
    // the route's own 409 is what surfaces a restatement of a stored identity.
    assert.deepEqual(summary.conflictQbTxnIds, ["6625#0"]);
    assert.equal(store.stored.get("6625#0"), JSON.stringify(["2026-08-12", -12_345, "LOWES #02516 POS DEB C#8516", null]),
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
    assert.equal(summary.inserted, 4, "whatever committed stays committed");
    assert.equal(summary.reconciled, null);
});

test("divergent repeats under one qbTxnId are SPLITS, and they post", async t => {
    /**
     * Codex PR #443 gate round 45, finding 6. These used to be a fatal
     * conflict: both rows dropped, `ok: false`, `complete: false` — and because
     * the same transaction comes back on every pull, the high-water mark and
     * the freshness stamp could never advance again. One legitimate two-split
     * purchase stopped every owner's chase cards indefinitely.
     */
    const divergent: BankRegisterRowLike[] = [
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "6625", docNum: null, name: "LOWES", memo: null, amountCents: -12_345 },
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "6625", docNum: null, name: "LOWES", memo: null, amountCents: -99_999 },
        { date: "2026-08-11", qbType: "Expense", qbTxnId: "6610", docNum: null, name: "NAPA", memo: null, amountCents: -500 },
    ];

    await t.test("each split gets its own durable identity, and nothing is dropped", () => {
        const result = convertRegisterRows(divergent);
        assert.deepEqual(result.quarantined, [], "a two-split purchase is not a quarantine");
        assert.equal(result.split, 2, "both splits are observations");
        assert.equal(result.lines.length, 3, "two splits plus the unrelated row");
        assert.equal(result.lines.filter(l => l.qbTxnId.startsWith("6625#")).length, 2);
        assert.deepEqual(result.lines.filter(l => l.qbTxnId === "6610").length, 1,
            "a single-row transaction keeps its bare id — nothing already stored is orphaned");
        assert.equal(result.collapsed, 0, "a divergent repeat is not a collapse");
        // Both amounts survive; neither is a guess between them.
        assert.deepEqual(
            result.lines.filter(l => l.qbTxnId.startsWith("6625#")).map(l => l.amountCents).sort((a, b) => a - b),
            [-99_999, -12_345],
        );
    });

    await t.test("the identity is STABLE across runs, so re-ingesting is a no-op", () => {
        const first = convertRegisterRows(divergent).lines.map(l => l.qbTxnId).sort();
        // Same rows, different order from QBO.
        const shuffled = [divergent[1], divergent[2], divergent[0]];
        const second = convertRegisterRows(shuffled).lines.map(l => l.qbTxnId).sort();
        assert.deepEqual(second, first, "the suffix comes from the content, not the arrival order");

        /**
         * AND SO IS THE EMITTED ORDER, which is a separate guarantee the
         * content sort provides: the batches this fetch is chunked into are the
         * same on a re-run, so a partial ingest resumes at the same boundary.
         *
         * (Measured: dropping the sort left the identity assertion above green,
         * because identity never depended on it. This is the assertion that
         * fails.)
         */
        assert.deepEqual(
            convertRegisterRows(shuffled).lines.map(l => l.qbTxnId),
            convertRegisterRows(divergent).lines.map(l => l.qbTxnId),
            "the same rows produce the same sequence, whatever order they arrive in",
        );
    });

    await t.test("identical repeats are DISTINCT splits, not one collapsed row", () => {
        /**
         * Round 45 collapsed these by content, which threw away a real posting:
         * a transaction with two equal splits to the same account is exactly
         * the shape that destroyed. Ordinal identity keeps both.
         */
        const result = convertRegisterRows(FIVE_ROW_FIXTURE);
        assert.deepEqual(result.quarantined, []);
        assert.equal(result.split, 2);
        assert.equal(result.collapsed, 0);
        assert.deepEqual(result.lines.filter(l => l.qbTxnId.startsWith("6625")).map(l => l.qbTxnId),
            ["6625#0", "6625#1"]);
    });

    await t.test("the run SUCCEEDS and every row lands", async () => {
        const store = fakeIngestStore();
        const summary = await runBankRegisterPull(pullDeps(store, divergent, []));
        assert.equal(summary.ok, true, "a multi-split purchase is not a failed run");
        assert.equal(summary.error, undefined);
        assert.equal(summary.quarantinedQbTxnIds, undefined);
        assert.equal(summary.splitObservations, 2);
        assert.equal(summary.inserted, 3, "both splits and the unrelated row");
    });

    await t.test("PRE-FIX CONTROL: treating divergence as a conflict blocks everything", async () => {
        /**
         * The old rule, applied to the same rows: drop every divergent id, fail
         * the run. The pre-fix outcome is not just "two rows missing" — it is
         * `complete: false` on every subsequent pull, which is what froze the
         * freshness stamp and the cards.
         */
        const conflicted = new Set<string>();
        const seen = new Map<string, number>();
        for (const row of divergent) {
            const id = row.qbTxnId ?? "";
            const prior = seen.get(id);
            if (prior !== undefined && prior !== row.amountCents) conflicted.add(id);
            else seen.set(id, row.amountCents);
        }
        assert.deepEqual([...conflicted], ["6625"], "the old rule called this a contradiction");
        assert.equal(convertRegisterRows(divergent).quarantined.length, 0, "the new rule calls it a purchase");
    });

    await t.test("a transaction claiming implausible splits IS quarantined, alone", () => {
        const runaway: BankRegisterRowLike[] = [];
        for (let i = 0; i <= MAX_SPLITS_PER_TXN; i++) {
            runaway.push({ date: "2026-08-12", qbType: "Expense", qbTxnId: "9999", docNum: null, name: "X", memo: null, amountCents: -(i + 1) });
        }
        runaway.push({ date: "2026-08-11", qbType: "Expense", qbTxnId: "6610", docNum: null, name: "NAPA", memo: null, amountCents: -500 });

        const result = convertRegisterRows(runaway);
        assert.deepEqual(result.quarantined, [
            { qbTxnId: "9999", reason: "implausible-split-count", count: MAX_SPLITS_PER_TXN + 1 },
        ]);
        assert.deepEqual(result.lines.map(l => l.qbTxnId), ["6610"],
            "the unrelated row still posts — that is the difference between one bad transaction and a stopped pipeline");
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
    assert.equal(summary.inserted, 4, "whatever committed stays committed");
    assert.equal(summary.minted, null);
});

// ── restatement quarantine: the run continues, the mint does not ─────────────

/**
 * QuickBooks transaction 6696 was edited after ProBuild stored it. In abort
 * mode that 409'd, rolled the batch back, and the nightly cron failed 89 times
 * over eleven days while the freshness stamp — and every owner's chase cards —
 * waited on it. These are the tests that would have caught that.
 */
const conflictOf = (qbTxnId: string, linked = false): QboRestatementConflict => ({
    qbTxnId,
    fields: ["amountCents"],
    stored: { postedDate: "2026-08-12", amountCents: -12_345, checkNumber: null },
    fresh: { postedDate: "2026-08-12", amountCents: -99_999, checkNumber: null },
    linked,
});

/** Enough rows to fill `count` batches of BANK_REGISTER_CHUNK_SIZE. */
function manyRows(count: number): BankRegisterRowLike[] {
    const rows: BankRegisterRowLike[] = [];
    for (let i = 0; i < count * BANK_REGISTER_CHUNK_SIZE; i++) {
        rows.push({ date: "2026-08-12", qbType: "Expense", qbTxnId: `t${i}`, docNum: null, name: `V${i}`, memo: null, amountCents: -(i + 1) });
    }
    return rows;
}

/**
 * A committed batch's answer, arithmetically possible: the conflicts it reports
 * are lines that were actually IN the batch, and the counts tie out
 * (`inserted + existing + conflictedLines === lines.length`). A fake that
 * reports a conflict on an id the batch never carried, or counts every line
 * inserted while also reporting one excluded, cannot happen in production and
 * tests nothing.
 */
function committed(lines: readonly BankRegisterIngestLine[], conflictIndexes: readonly number[], linked = false) {
    const conflicts = conflictIndexes
        .filter(i => i < lines.length)
        .map(i => conflictOf(lines[i].qbTxnId, linked));
    return {
        status: 200,
        body: {
            ok: true,
            inserted: lines.length - conflicts.length,
            existing: 0,
            conflicted: conflicts.length,
            conflictedLines: conflicts.length,
            conflicts,
        },
    };
}

test("AC8: the pull continues past a conflicted batch, and reports it without failing", async () => {
    const batchSizes: number[] = [];
    let restated: string | undefined;
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        fetchRows: async () => ({ rows: manyRows(3), stale: false }),
        ingest: async (_account, lines, options) => {
            batchSizes.push(lines.length);
            assert.equal(options?.onConflict, "quarantine", "the mode travels with every batch");
            // Batch 1 carries the restatement; batches 2 and 3 are clean.
            if (batchSizes.length !== 1) return committed(lines, []);
            restated = lines[0].qbTxnId;
            return committed(lines, [0]);
        },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
    });

    assert.equal(batchSizes.length, 3, "every batch is attempted — this is the assertion the 89 failed runs lacked");
    assert.equal(summary.ok, true, "a QuickBooks edit is not a failed run");
    assert.equal(summary.complete, true, "and it does not withhold the freshness stamp");
    assert.equal(summary.error, undefined);
    assert.deepEqual(summary.restatementConflicts?.map(c => c.qbTxnId), [restated]);
    assert.equal(summary.conflictQbTxnIds, undefined, "`conflictQbTxnIds` still means THIS RUN FAILED on these");
});

test("AC8b: a committed batch verifies exactly the ids it did NOT report back", async () => {
    let restated: string | undefined;
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        fetchRows: async () => ({ rows: manyRows(2), stale: false }),
        ingest: async (_account, lines) => {
            if (restated !== undefined) return committed(lines, []);
            restated = lines[0].qbTxnId;
            return committed(lines, [0]);
        },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
    });
    assert.equal(summary.restatementConflicts?.length, 1);
    /**
     * The conflicting id is NOT verified — verification is the evidence that
     * lets the durable record delete an entry, and "we re-read it and it still
     * disagrees" is the opposite of that.
     */
    assert.equal(summary.verifiedQbTxnIds?.length, 2 * BANK_REGISTER_CHUNK_SIZE - 1);
    assert.equal(summary.verifiedQbTxnIds?.includes(restated!), false);
    assert.equal(new Set(summary.verifiedQbTxnIds).size, summary.verifiedQbTxnIds?.length);
});

test("F1: a FAILED batch verifies nothing — its ids are not evidence QuickBooks agrees", async () => {
    let attempt = 0;
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        fetchRows: async () => ({ rows: manyRows(2), stale: false }),
        ingest: async (_account, lines) => {
            attempt++;
            if (attempt === 1) return committed(lines, []);
            // The bare post-insert-race 409: the whole batch rolled back, so
            // nothing in it was re-read against stored content.
            return { status: 409, body: { ok: false, reason: "qbo-txn-conflict", qbTxnId: lines[0].qbTxnId } };
        },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
    });
    assert.equal(summary.ok, false, "a 409 is still a failed run");
    assert.equal(summary.verifiedQbTxnIds?.length, BANK_REGISTER_CHUNK_SIZE,
        "exactly the FIRST batch's ids — the rolled-back batch contributes none");
});

test("F1: a run truncated by its own budget verifies only what it actually posted", async () => {
    let elapsed = 0;
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        budgetMs: 1_000,
        elapsedMs: () => elapsed,
        fetchRows: async () => ({ rows: manyRows(3), stale: false }),
        ingest: async (_account, lines) => {
            // One batch lands, then the budget is gone.
            elapsed = 2_000;
            return committed(lines, []);
        },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
    });
    assert.equal(summary.continues, true);
    assert.equal(summary.verifiedQbTxnIds?.length, BANK_REGISTER_CHUNK_SIZE,
        "a narrow run must not claim to have re-read the window it never reached");
});

test("AC9: the mint never sees a conflicted id", async () => {
    let excluded: readonly string[] | undefined;
    let restated: string | undefined;
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        fetchRows: async () => ({ rows: FIVE_ROW_FIXTURE, stale: false, clearedProbeOk: true }),
        ingest: async (_account, lines) => {
            restated = lines[0].qbTxnId;
            return committed(lines, [0], true);
        },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
        mintFromQbo: async (_account, _deadlineAt, excludeQbTxnIds) => {
            excluded = excludeQbTxnIds;
            return { minted: 0, skipped: {}, complete: true, remainingCursor: null };
        },
    });
    /**
     * A restatement deliberately does NOT make `mintIsSafe` false — blocking the
     * whole register over one edited transaction is the freeze being fixed — so
     * the exclusion travelling with the call is the ONLY thing standing between
     * a stale observation and a permanent canonical line whose `amountCents` is
     * immutable by trigger.
     */
    assert.equal(summary.minted?.complete, true, "the mint still runs for every other observation");
    assert.ok(excluded?.includes(restated!), "the conflicted id must be excluded from the mint");
});

test("F2: the DURABLE set is what the mint excludes, and it is written before the mint runs", async () => {
    const order: string[] = [];
    let excluded: readonly string[] | undefined;
    let restated: string | undefined;
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        windowState: { highWater: null, lastFullSweep: null, continueAfter: null },
        saveWindowState: async () => { order.push("saveState"); },
        fetchRows: async () => ({ rows: FIVE_ROW_FIXTURE, stale: false, clearedProbeOk: true }),
        ingest: async (_account, lines) => {
            order.push("ingest");
            restated = lines[0].qbTxnId;
            return committed(lines, [0]);
        },
        persistConflicts: async (found, verified) => {
            order.push("persistConflicts");
            assert.deepEqual(found.map(c => c.qbTxnId), [restated]);
            assert.equal(verified.includes(restated!), false);
            // The merged record: this run's find, plus one from a wider window
            // this run never re-read.
            return { ok: true, entries: [{ qbTxnId: restated! }, { qbTxnId: "6600" }] };
        },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
        mintFromQbo: async (_account, _deadlineAt, excludeQbTxnIds) => {
            order.push("mint");
            excluded = excludeQbTxnIds;
            return { minted: 0, skipped: {}, complete: true, remainingCursor: null };
        },
    });
    assert.deepEqual(order, ["ingest", "persistConflicts", "mint", "saveState"],
        "the record has to survive a crash between the ingest and the permanent write it gates");
    assert.deepEqual([...(excluded ?? [])].sort(), [restated, "6600"].sort());
    assert.equal(summary.ok, true);
});

test("F2: a record this run could NOT write stops the mint and the checkpoint", async () => {
    const order: string[] = [];
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        windowState: { highWater: null, lastFullSweep: null, continueAfter: null },
        saveWindowState: async () => { order.push("saveState"); },
        fetchRows: async () => ({ rows: FIVE_ROW_FIXTURE, stale: false, clearedProbeOk: true }),
        ingest: async (_account, lines) => { order.push("ingest"); return committed(lines, [0]); },
        persistConflicts: async () => {
            order.push("persistConflicts");
            return { ok: false, reason: "bank-conflict-unwritable", entries: [] };
        },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
        mintFromQbo: async () => { order.push("mint"); return { minted: 1, skipped: {} }; },
    });
    assert.deepEqual(order, ["ingest", "persistConflicts"], "no mint, and no checkpoint to step the window past this one");
    assert.equal(summary.ok, false);
    assert.equal(summary.complete, false, "and nothing may certify a run whose exclusion set was never recorded");
    assert.equal(summary.error, "conflict-store-unwritable");
    assert.equal(summary.conflictStore, "unwritable");
    assert.equal(summary.minted, null);
    assert.equal(summary.mintSkipped, "conflict-store-unwritable");
    assert.equal(summary.highWater, undefined, "the window is retried, not advanced over");
});

test("F5: a record this run could not READ stops them at the same point — the checkpoint never moves", async () => {
    /**
     * THE BLOCKER ROUND 2 FOUND. The caller reads the durable record before the
     * pull (the mint's exclusion set comes from it), so an unreadable one used
     * to be acted on AFTER this function returned — by which time the window
     * state had already been saved with an advanced high-water mark, because
     * that save is gated on `summary.ok` and nothing had made it false yet. The
     * restatements found that night were persisted nowhere, and the pull's
     * 3-day re-fetch overlap is far shorter than the 60-day mint lookback, so
     * once they aged out the register would never offer them again while the
     * mint still would have taken them.
     */
    const order: string[] = [];
    const saved: unknown[] = [];
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        conflictStoreUnreadable: true,
        windowState: { highWater: null, lastFullSweep: null, continueAfter: null },
        saveWindowState: async next => { order.push("saveState"); saved.push(next); },
        fetchRows: async () => ({ rows: FIVE_ROW_FIXTURE, stale: false, clearedProbeOk: true }),
        ingest: async (_account, lines) => { order.push("ingest"); return committed(lines, [0]); },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
        mintFromQbo: async () => { order.push("mint"); return { minted: 1, skipped: {} }; },
    });
    /**
     * THE CLEAN LINES STILL LAND. That is the quarantine mode working as
     * intended and it is safe — the ingest is idempotent, and because the window
     * is not advanced the next run re-offers this same span and re-detects the
     * restatement.
     */
    assert.deepEqual(order, ["ingest"], "the ingest runs; nothing irreversible follows it");
    assert.equal(saved.length, 0);
    assert.equal(summary.inserted, 3, "and whatever was not restated is stored");
    assert.equal(summary.highWater, undefined, "the high-water mark is untouched");
    assert.equal(summary.ok, false);
    assert.equal(summary.complete, false);
    assert.equal(summary.error, "conflict-store-unreadable");
    assert.equal(summary.conflictStore, "unreadable");
    assert.equal(summary.minted, null);
    assert.equal(summary.mintSkipped, "conflict-store-unreadable");
    assert.equal(summary.restatementConflicts?.length, 1,
        "the conflict is still FOUND and reported — it is the checkpoint that must not move past it");
});

test("F2: with SEVERAL batches, every ingest still precedes the record, the mint and the checkpoint", async () => {
    /**
     * The one-batch case cannot tell "after the last ingest" from "after the
     * first". A record written between batches would exclude only what had been
     * seen so far, and the mint that follows would run over the rest.
     */
    const order: string[] = [];
    await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        windowState: { highWater: null, lastFullSweep: null, continueAfter: null },
        saveWindowState: async () => { order.push("saveState"); },
        fetchRows: async () => ({ rows: manyRows(3), stale: false, clearedProbeOk: true }),
        ingest: async (_account, lines) => { order.push("ingest"); return committed(lines, [0]); },
        persistConflicts: async () => { order.push("persistConflicts"); return { ok: true, entries: [] }; },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
        mintFromQbo: async () => {
            order.push("mint");
            return { minted: 0, skipped: {}, complete: true, remainingCursor: null };
        },
    });
    assert.deepEqual(order, ["ingest", "ingest", "ingest", "persistConflicts", "mint", "saveState"]);
    assert.ok(
        order.lastIndexOf("ingest") < order.indexOf("persistConflicts"),
        "the LAST batch, not merely the first, is covered by the record the mint reads",
    );
});

test("AC10d: the flood boundary is exactly MAX_CONFLICTS_PER_RUN, and it is counted across batches", async t => {
    const runWith = async (perBatch: readonly number[]) => {
        let batch = 0;
        let minted = false;
        const summary = await runBankRegisterPull({
            now: () => Date.parse("2026-08-12T02:00:00Z"),
            conflictMode: "quarantine",
            fetchRows: async () => ({ rows: manyRows(perBatch.length), stale: false, clearedProbeOk: true }),
            ingest: async (_account, lines) =>
                committed(lines, Array.from({ length: perBatch[batch++] ?? 0 }, (_unused, i) => i)),
            reconcile: async () => ({ linked: 0, proposed: 0 }),
            mintFromQbo: async () => {
                minted = true;
                return { minted: 0, skipped: {}, complete: true, remainingCursor: null };
            },
        });
        return { summary, minted };
    };

    await t.test("exactly the limit is a busy human, not a flood — and the mint still runs", async () => {
        const { summary, minted } = await runWith([MAX_CONFLICTS_PER_RUN]);
        assert.equal(summary.conflictFlood, undefined);
        assert.equal(summary.restatementConflicts?.length, MAX_CONFLICTS_PER_RUN);
        assert.equal(minted, true, "narrowed by the fifty, but it runs — blocking it is the freeze being fixed");
    });

    await t.test("one more is a flood", async () => {
        const { summary, minted } = await runWith([MAX_CONFLICTS_PER_RUN + 1]);
        assert.equal(summary.conflictFlood, true);
        assert.equal(minted, false);
        assert.equal(summary.mintSkipped, "conflict-flood");
    });

    await t.test("and the threshold may be crossed BETWEEN batches — the count is the run's, not the batch's", async () => {
        const { summary, minted } = await runWith([30, 25]);
        assert.equal(summary.conflictFlood, true);
        assert.equal(summary.restatementConflicts?.length, 55);
        assert.equal(minted, false);
    });
});

test("G3: a STALE fetch verifies NOTHING — a cache agreeing with our own store is not QuickBooks agreeing", async () => {
    /**
     * Verification is the one claim that DELETES a durable conflict, and a
     * deleted conflict is one the mint stops excluding — permanent, because
     * `BankLine.amountCents` is immutable by trigger. A stale fetch asked
     * QuickBooks nothing, so it can never be that evidence. What it FINDS is
     * still recorded: forgetting needs evidence, remembering does not.
     */
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        fetchRows: async () => ({ rows: FIVE_ROW_FIXTURE, stale: true, clearedProbeOk: true }),
        ingest: async (_account, lines) => committed(lines, [0]),
        reconcile: async () => ({ linked: 0, proposed: 0 }),
    });
    assert.equal(summary.stale, true);
    assert.deepEqual(summary.verifiedQbTxnIds, []);
    assert.equal(summary.restatementConflicts?.length, 1, "but a conflict it saw is still reported");
});

test("AC10a: a flood holds the mint and the stamp — and does NOT stop the run", async () => {
    const attempted: number[] = [];
    let flooded: string[] = [];
    const summary = await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        fetchRows: async () => ({ rows: manyRows(3), stale: false }),
        ingest: async (_account, lines) => {
            attempted.push(lines.length);
            // One batch, more restatements than any human could have made.
            if (attempted.length !== 1) return committed(lines, []);
            const indexes = Array.from({ length: MAX_CONFLICTS_PER_RUN + 1 }, (_, i) => i);
            flooded = indexes.map(i => lines[i].qbTxnId);
            return committed(lines, indexes);
        },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
        mintFromQbo: async () => { throw new Error("the mint must not run"); },
    });
    /**
     * BREAKING HERE WEDGED THE PIPELINE. `ok: false` parked a continuation, the
     * continuation re-fetched the same window, flooded again, and the register
     * never moved. Everything clean still has to land; what a flood stops is
     * acting on the picture.
     */
    assert.equal(attempted.length, 3, "every remaining batch is still ingested and quarantined");
    assert.equal(summary.ok, true);
    assert.equal(summary.complete, true);
    assert.equal(summary.error, undefined);
    assert.equal(summary.conflictFlood, true);
    assert.equal(summary.restatementConflicts?.length, MAX_CONFLICTS_PER_RUN + 1, "the finding is still recorded");
    assert.equal(summary.minted, null, "and nothing mints against a picture we know is wrong");
    assert.equal(summary.mintSkipped, "conflict-flood");
    // Every non-conflicting line in the flooded batch still posted.
    assert.equal(summary.inserted, 3 * BANK_REGISTER_CHUNK_SIZE - flooded.length);
});

test("AC10c: a flood leaves NO continuation pending — the 15-minute pass must not re-run it", async () => {
    type SavedState = { continuationPending?: boolean; continueAfter?: unknown };
    const saved: SavedState[] = [];
    await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        conflictMode: "quarantine",
        windowState: { highWater: null, lastFullSweep: null, continueAfter: null },
        saveWindowState: async next => { saved.push(next as SavedState); },
        fetchRows: async () => ({ rows: manyRows(1), stale: false, clearedProbeOk: true }),
        ingest: async (_account, lines) => committed(lines, Array.from({ length: MAX_CONFLICTS_PER_RUN + 1 }, (_, i) => i)),
        reconcile: async () => ({ linked: 0, proposed: 0 }),
    });
    assert.equal(saved.length, 1, "a flood is not a failure, so the checkpoint is still written");
    assert.equal(saved[0].continuationPending, false, "nothing-in-progress — re-running the flood is the wedge");
    assert.equal(saved[0].continueAfter, null);
});

test("the default is `abort`, so the pure tests keep the semantics they were written against", async () => {
    const modes: Array<string | undefined> = [];
    const store = fakeIngestStore();
    await runBankRegisterPull({
        now: () => Date.parse("2026-08-12T02:00:00Z"),
        fetchRows: async () => ({ rows: FIVE_ROW_FIXTURE, stale: false }),
        ingest: async (account, lines, options) => { modes.push(options?.onConflict); return store.ingest(account, lines); },
        reconcile: async () => ({ linked: 0, proposed: 0 }),
    });
    assert.deepEqual(modes, ["abort"]);
});
