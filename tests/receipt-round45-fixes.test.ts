import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cycleStillValid, parseSweepCycle } from "../src/lib/receipt-sweep-marker";
import { MAX_SPLITS_PER_TXN, convertRegisterRows, splitSuffix } from "../src/lib/bank-register-pull";

/**
 * Codex PR #443, adversarial gate round 45.
 *
 * The recurring shape across five of the seven findings: a guarantee was
 * attached to something with a SHORTER LIFETIME than the guarantee itself.
 * Epochs on cursors that get cleared; a reservation on the row being reserved;
 * an obligation in a second write; a lock marker on a file rather than a call.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// ═══ 1. The cycle record outlives every cursor ═════════════════════════════

test("the cycle's epochs live in a record of their own, not on the cursors", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    // The bug, stated from the source: cursors are cleared the moment their
    // pass completes, so a continuation could find nothing to validate and take
    // a fresh snapshot of a world that had already moved.
    assert.match(sweep, /if \(openExhausted && openPass\.errors === 0\) await writeOpenCursor\(null\);/,
        "the open cursor really is cleared on completion — that is what made cursor-only validation unsound");
    assert.match(sweep, /if \(exhausted && totals\.errors === 0\) await writeCursor\(null\);/);

    // The fix: a record written once per cycle and read on every continuation.
    // The record lives in the shared marker module, not the sweep route: the
    // cards cron needs it too, and a route importing another route pulls the
    // whole sweep into its bundle.
    assert.match(read("src/lib/receipt-sweep-marker.ts"), /export const CYCLE_KEY = "receiptRequestsCycle";/);
    assert.match(sweep, /cycle = \{ id: randomUUID\(\), epoch: snapshotEpoch, evidenceEpoch: snapshotEvidenceEpoch \};/);
    assert.match(sweep, /await writeCycle\(cycle\);/);
    // A fresh full run clears it with the cursors, so the next cycle cannot
    // inherit the last one's snapshot.
    assert.match(sweep, /writeCursor\(null\), writeOpenCursor\(null\), writeCycle\(null\)/);
});

test("a cycle record that disagrees with the world is not usable", () => {
    const cycle = { id: "c1", epoch: "5", evidenceEpoch: "11" };
    assert.equal(cycleStillValid(cycle, "5", "11"), true);
    assert.equal(cycleStillValid(cycle, "6", "11"), false, "a line landed");
    assert.equal(cycleStillValid(cycle, "5", "12"), false, "a receipt landed — round 45's case");

    // PRE-FIX CONTROL: no record at all is NOT permission to proceed. Round 44
    // validated only non-null cursors, so "nothing stored" read as "nothing
    // wrong" — which is exactly the state a completed pass leaves behind.
    assert.equal(cycleStillValid(null, "5", "11"), false,
        "an absent guarantee is not a satisfied one");
});

test("a malformed or partial cycle record reads as no cycle", () => {
    const rejected = [
        null,
        "",
        "not json",
        "{}",
        JSON.stringify({ id: "c1" }),
        JSON.stringify({ id: "c1", epoch: "5" }),
        JSON.stringify({ epoch: "5", evidenceEpoch: "11" }),
    ];
    for (const value of rejected) {
        assert.equal(parseSweepCycle(value), null, `${JSON.stringify(value)} must not resume anything`);
    }
    assert.deepEqual(
        parseSweepCycle(JSON.stringify({ id: "c1", epoch: "5", evidenceEpoch: "11" })),
        { id: "c1", epoch: "5", evidenceEpoch: "11" },
    );
});

// ═══ 2. The full run cannot be starved by its own continuation ═════════════

test("the full run records its intent BEFORE reaching for the lease", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    const flagAt = sweep.indexOf("if (!continueOnly) await writeFullRunRequested(now.toISOString());");
    const leaseAt = sweep.indexOf("if (!(await takeLease(");
    assert.ok(flagAt > 0 && leaseAt > flagAt,
        "losing the lease must cost a continuation slot, not the day's cycle");

    // And whoever runs next honours it.
    assert.match(sweep, /const fullRunOwed = continueOnly && await readFullRunRequested\(\);/);
    assert.match(sweep, /await writeFullRunRequested\(null\);/);
    assert.match(sweep, /if \(!fullRunOwed && !cycleOpen && !shouldResumeSweep\(phase, lineCursor, openCursor\)\)/,
        "an owed full run is work in progress even with no cursor parked");
});

test("the continuation schedule never collides with a full run", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string; schedule: string }> };
    const at = (path: string) => vercel.crons.find(c => c.path === path)!.schedule;

    /** The minutes a cron field actually fires on. */
    const minutesOf = (schedule: string) => {
        const field = schedule.split(" ")[0];
        const stepped = /^(\*|\d+)(?:-59)?\/(\d+)$/.exec(field);
        if (stepped) {
            const start = stepped[1] === "*" ? 0 : Number(stepped[1]);
            const step = Number(stepped[2]);
            const out: number[] = [];
            for (let m = start; m <= 59; m += step) out.push(m);
            return out;
        }
        return [Number(field)];
    };

    const pairs = [
        ["/api/cron/receipt-requests", "/api/cron/receipt-requests?continue=1"],
        ["/api/cron/bank-register-pull", "/api/cron/bank-register-pull?continue=1"],
    ] as const;

    for (const [full, cont] of pairs) {
        const fullMinutes = minutesOf(at(full));
        const contMinutes = minutesOf(at(cont));
        const overlap = fullMinutes.filter(m => contMinutes.includes(m));
        assert.deepEqual(overlap, [], `${cont} must never fire in the same minute as ${full}`);
        assert.equal(contMinutes.length, 4, "still four continuation slots an hour");
    }

    // PRE-FIX CONTROL: the old field fired on the hour, which is exactly when
    // the full run goes.
    assert.deepEqual(minutesOf("*/15 * * * *").includes(0), true,
        "the schedule this replaced collided by construction");
});

// ═══ 4. The ambiguity obligation commits with the state it describes ═══════

test("the ambiguity obligation is part of the state save, not a second write", () => {
    const lib = read("src/lib/bank-register-pull.ts");
    const route = read("src/app/api/cron/bank-register-pull/route.ts");

    const decideAt = lib.indexOf("const windowAmbiguous = (summary.reconciled?.ambiguous?.length ?? 0) > 0;");
    const saveAt = lib.indexOf("await dependencies.saveWindowState({", decideAt);
    assert.ok(decideAt > 0 && saveAt > decideAt, "decided where the reconcile result is, then saved once");
    assert.match(lib, /continuationPending: \(!summary\.complete && clearedProbeOk\) \|\| windowAmbiguous,/);
    assert.match(lib, /continuationReason: windowAmbiguous/);

    // PRE-FIX CONTROL: the round-43 second write is gone. A crash between the
    // save and that write left the stamp withheld with nothing scheduled to
    // come back for it — freshness frozen, every later slot idle.
    assert.doesNotMatch(route, /statePatch\.continuationReason = "ambiguity"/);
    assert.doesNotMatch(route, /if \(summary\.ok && ambiguousCount > 0\)/);
    // The route still records the one case the save never runs at all.
    assert.match(route, /if \(!summary\.ok\) \{/);
});

// ═══ 5. The delivery table is backfilled ═══════════════════════════════════

test("existing delivery claims are backfilled, idempotently, in both places", () => {
    const migration = read("prisma/migrations/20260901120000_phase2_receipt_queue/migration.sql");
    const apply = read("scripts/apply-phase2-receipt-queue.mjs");

    for (const [name, source] of [["migration", migration], ["apply script", apply]] as const) {
        assert.match(source, /INSERT INTO "ReceiptRequestCardDelivery"/, name);
        assert.match(source, /FROM "ReceiptRequestCard"/, name);
        assert.match(source, /WHERE "deliveredOn" IS NOT NULL/, name);
        assert.match(source, /ON CONFLICT \("owner", "deliveryDay"\) DO NOTHING/, name);
        // Idempotent BY DERIVED KEY: a fresh uuid would insert a duplicate on
        // every run while reporting "ok".
        assert.match(source, /md5\('rrcd:'/, name);
        assert.doesNotMatch(source, /gen_random_uuid\(\)/, `${name} must not key the backfill on a fresh id`);
    }

    // And the verifier proves it LANDED. "ok" says a statement ran, not that it
    // copied anything, and a missing reservation is invisible until the day
    // somebody gets asked twice.
    assert.match(apply, /existing delivery claims have no ReceiptRequestCardDelivery row/);
    assert.match(apply, /verified delivery backfill/);
});

// ═══ 6. A multi-split transaction is a purchase, not a contradiction ═══════

test("the split suffix is derived from content, so it is stable across runs", () => {
    const content = JSON.stringify(["2026-08-12", -12345, "LOWES", null]);
    const other = JSON.stringify(["2026-08-12", -99999, "LOWES", null]);
    assert.equal(splitSuffix(content), splitSuffix(content), "same content, same suffix");
    assert.notEqual(splitSuffix(content), splitSuffix(other));
    assert.match(splitSuffix(content), /^[0-9a-f]{8}$/);
});

test("a split transaction ingests as N observations, not zero", () => {
    const rows = [
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T1", docNum: null, name: "LOWES", memo: null, amountCents: -100 },
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T1", docNum: null, name: "LOWES", memo: null, amountCents: -200 },
    ];
    const result = convertRegisterRows(rows);
    assert.equal(result.lines.length, 2, "PRE-FIX this was 0, and the run was marked failed for ever");
    assert.deepEqual(result.quarantined, []);
    assert.equal(result.split, 2);
    assert.equal(new Set(result.lines.map(line => line.qbTxnId)).size, 2, "two distinct durable identities");
});

test("a quarantine is reported, and does not fail the run", () => {
    const lib = read("src/lib/bank-register-pull.ts");
    // The bug: any conflict set ok:false AND complete:false, so the high-water
    // mark and the freshness stamp could never advance — every owner's cards
    // stopped for one transaction, on every retry, indefinitely.
    assert.doesNotMatch(lib, /summary\.error = "qbo-duplicate-conflict";/);
    assert.match(lib, /summary\.quarantinedQbTxnIds = quarantined\.map\(entry => entry\.qbTxnId\);/);
    // Minting stays blocked while rows are missing, which is a narrow and real
    // reason — blocking the MINT is not blocking the run.
    assert.match(lib, /clearedProbeOk && quarantined\.length === 0;/);
    assert.equal(MAX_SPLITS_PER_TXN > 1, true);
});

test("the ingest route's own 409 still fails the run", () => {
    // Narrowing what counts as a conflict must not silently drop the case that
    // really is one: QBO restating an identity already stored.
    const lib = read("src/lib/bank-register-pull.ts");
    assert.match(lib, /summary\.conflictQbTxnIds = \[\.\.\.new Set\(/);
    assert.match(lib, /conflictQbTxnIds\?: string\[\];/);
});

// ═══ 3. Every evidence writer is inside the fence ══════════════════════════

test("the Expense writes round 45 found are all fenced now", () => {
    /**
     * Five writes ran on the `prisma` CLIENT with no lock and no epoch bump —
     * including the cascade from deleting an estimate, and the expense edit
     * that changes `amount`, `vendor` and `date`: three of the exact fields the
     * matcher pairs a charge on. Their files all carried lock markers
     * elsewhere, so the per-file tripwire counted them as covered.
     *
     * The structural rule that catches the whole class lives in
     * tests/receipt-evidence-lock.test.ts ("no evidence write is issued on the
     * prisma CLIENT"). This pins the five specific sites, so a future edit that
     * reverts one is named rather than merely counted.
     */
    const sites: Array<[string, RegExp]> = [
        ["src/lib/actions.ts", /withReceiptEvidenceLock\(fn => prisma\.\$transaction\(fn\),\s*\n\s*tx => tx\.expense\.deleteMany\(\{ where: \{ estimateId \} \}\)\)/],
        ["src/app/api/expenses/[id]/route.ts", /tx => tx\.expense\.deleteMany\(\{ where: \{ id, qbPurchaseId: null \} \}\)\)/],
        ["src/app/api/expenses/[id]/route.ts", /withReceiptEvidenceLock\(fn => prisma\.\$transaction\(fn\), tx => tx\.expense\.update\(\{/],
        ["src/app/api/expenses/[id]/approve/route.ts", /withReceiptEvidenceLock\(fn => prisma\.\$transaction\(fn\), tx => tx\.expense\.update\(\{/],
        ["src/lib/time-expense-core.ts", /withReceiptEvidenceLock<\{ count: number \}>\(fn => prisma\.\$transaction\(fn\), tx => tx\.expense\.updateMany\(\{/],
    ];
    for (const [file, pattern] of sites) {
        assert.match(read(file), pattern, `${file} still writes Expense evidence outside the fence`);
    }
});

test("the estimate cascade is the sharpest case, and it is fenced", () => {
    // Deleting an estimate deletes its Expenses. Every one of those is a row
    // the sweep may have read as "this charge has its receipt", and unfenced it
    // could close a chase on evidence being destroyed underneath it — and
    // certify, because nothing moved the epoch.
    const actions = read("src/lib/actions.ts");
    const cascadeAt = actions.indexOf('tx => tx.expense.deleteMany({ where: { estimateId } })');
    const estimateDeleteAt = actions.indexOf("await prisma.estimate.delete({ where: { id: estimateId } });", cascadeAt);
    assert.ok(cascadeAt > 0 && estimateDeleteAt > cascadeAt,
        "the expenses go under the fence before the estimate row is removed");
});
