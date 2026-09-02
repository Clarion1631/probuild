import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerRowToIngestLine } from "../src/lib/bank-register-pull";
import {
    BANK_LINE_IDENTITY_LOCK,
    QBO_MINT_MIN_AGE_DAYS,
    bankLineIdentityPayee,
    bankLineIdentityKey,
    planQboMint,
    planStatementAdoption,
    type ExistingBankLine,
    type MintCandidateObservation,
    type StatementLineForAdoption,
} from "../src/lib/bank-line-mint";

/**
 * The property that matters is CONVERGENCE: whichever source arrives first, the
 * two must end on ONE canonical line, and re-running either must change
 * nothing. Both orders are tested, plus the re-runs.
 */

const NOW = new Date("2026-08-20T09:00:00Z");
const ACCOUNT = "WTB-0723";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const obs = (over: Partial<MintCandidateObservation> = {}): MintCandidateObservation => ({
    id: "obs-1",
    account: ACCOUNT,
    postedDate: "2026-08-16",
    amountCents: -12_345,
    rawDescriptor: "LOWES #02516 POS DEB C#8516",
    normalizedPayee: "LOWES #02516",
    checkNumber: null,
    bankLineId: null,
    ...over,
});

const existing = (over: Partial<ExistingBankLine> = {}): ExistingBankLine => ({
    id: "bl-1",
    account: ACCOUNT,
    postedDate: "2026-08-16",
    amountCents: -12_345,
    normalizedPayee: "LOWES #02516",
    checkNumber: null,
    sourceOfRecord: "STATEMENT",
    ...over,
});

const stmt = (over: Partial<StatementLineForAdoption> = {}): StatementLineForAdoption => ({
    sequence: 0,
    postedDate: "2026-08-16",
    amountCents: -12_345,
    normalizedPayee: "LOWES #02516",
    checkNumber: null,
    ...over,
});

// ── planQboMint ──────────────────────────────────────────────────────────────

test("an unlinked, settled QBO observation with no existing line mints one", () => {
    const plan = planQboMint([obs()], [], NOW);
    assert.equal(plan.mint.length, 1);
    assert.equal(plan.mint[0].id, "obs-1");
});

test("the 2-day settle window is respected — QBO can still edit a fresh row", () => {
    assert.equal(QBO_MINT_MIN_AGE_DAYS, 2);
    assert.equal(planQboMint([obs({ postedDate: "2026-08-19" })], [], NOW).mint.length, 0, "1 day old");
    assert.equal(planQboMint([obs({ postedDate: "2026-08-18" })], [], NOW).mint.length, 1, "exactly 2 days old");
    assert.equal(planQboMint([obs({ postedDate: "2026-08-20" })], [], NOW).mint.length, 0, "today");
});

test("an already-linked observation never mints", () => {
    const plan = planQboMint([obs({ bankLineId: "bl-9" })], [], NOW);
    assert.equal(plan.mint.length, 0);
    assert.equal(plan.skipped.alreadyLinked, 1);
});

test("an empty normalized payee is not an identity — it never mints", () => {
    const plan = planQboMint([obs({ normalizedPayee: "" })], [], NOW);
    assert.equal(plan.mint.length, 0);
    assert.equal(plan.skipped.emptyPayee, 1);
});

test("an exact-match STATEMENT line already exists → no mint (statement first)", () => {
    const plan = planQboMint([obs()], [existing()], NOW);
    assert.equal(plan.mint.length, 0);
    assert.equal(plan.skipped.statementLineExists, 1);
});

test("a near-miss existing line does NOT suppress the mint", async t => {
    await t.test("different amount", () => {
        assert.equal(planQboMint([obs()], [existing({ amountCents: -12_346 })], NOW).mint.length, 1);
    });
    await t.test("different date", () => {
        assert.equal(planQboMint([obs()], [existing({ postedDate: "2026-08-15" })], NOW).mint.length, 1);
    });
    await t.test("different payee", () => {
        assert.equal(planQboMint([obs()], [existing({ normalizedPayee: "HOME DEPOT" })], NOW).mint.length, 1);
    });
    await t.test("different check number", () => {
        assert.equal(planQboMint([obs({ checkNumber: "1027" })], [existing({ checkNumber: "1028" })], NOW).mint.length, 1);
    });
    await t.test("different account", () => {
        assert.equal(planQboMint([obs()], [existing({ account: "OTHER" })], NOW).mint.length, 1);
    });
});

test("re-running mints nothing: the QBO line it made last night is itself a match", () => {
    const first = planQboMint([obs()], [], NOW);
    assert.equal(first.mint.length, 1);
    // Second run, with last night's line now present.
    const second = planQboMint([obs({ bankLineId: null })], [existing({ id: "bl-minted", sourceOfRecord: "QBO" })], NOW);
    assert.equal(second.mint.length, 0, "a re-run must create nothing");
});

test("CARDINALITY: two same-identity QBO transactions mint TWO lines", () => {
    // This business genuinely buys the same thing from the same merchant twice
    // on the same day. Testing "does a line with this key exist" made the
    // second charge disappear from the ledger entirely.
    const plan = planQboMint([obs({ id: "a" }), obs({ id: "b" })], [], NOW);
    assert.equal(plan.mint.length, 2);
    assert.deepEqual(plan.mint.map(o => o.id), ["a", "b"]);
    assert.equal(plan.skipped.statementLineExists, 0);
});

test("CARDINALITY: one existing line covers one observation, not both", () => {
    const plan = planQboMint([obs({ id: "a" }), obs({ id: "b" })], [existing()], NOW);
    assert.equal(plan.mint.length, 1, "the second has nothing to link to and mints");
    assert.equal(plan.skipped.statementLineExists, 1);
});

test("CARDINALITY: a line already claimed by a linked observation does not cover a new one", () => {
    // The statement minted one line; an earlier observation already linked to
    // it. A second QBO observation for the same identity is a SECOND charge.
    const plan = planQboMint(
        [obs({ id: "linked", bankLineId: "bl-1" }), obs({ id: "new" })],
        [existing({ id: "bl-1" })],
        NOW,
    );
    assert.equal(plan.mint.length, 1);
    assert.equal(plan.mint[0].id, "new");
    assert.equal(plan.skipped.alreadyLinked, 1);
});

test("duplicateWithinBatch actually increments — telemetry that never fires is worse than none", () => {
    const none = planQboMint([obs({ id: "a" }), obs({ id: "b", amountCents: -1 })], [], NOW);
    assert.equal(none.skipped.duplicateWithinBatch, 0, "different identities are not duplicates");

    const two = planQboMint([obs({ id: "a" }), obs({ id: "b" })], [], NOW);
    assert.equal(two.skipped.duplicateWithinBatch, 1);

    const three = planQboMint([obs({ id: "a" }), obs({ id: "b" }), obs({ id: "c" })], [], NOW);
    assert.equal(three.skipped.duplicateWithinBatch, 2);
    assert.equal(three.mint.length, 3, "counting them does not stop them minting");
});

test("the identity key is JSON-encoded, so a payee containing a delimiter can't collide", () => {
    const a = bankLineIdentityKey({ account: "A|B", postedDate: "2026-08-16", amountCents: -1, normalizedPayee: "X", checkNumber: null });
    const b = bankLineIdentityKey({ account: "A", postedDate: "2026-08-16", amountCents: -1, normalizedPayee: "B|X", checkNumber: null });
    assert.notEqual(a, b);
});

// ── planStatementAdoption ────────────────────────────────────────────────────

test("a statement line adopts the QBO-minted line instead of minting a twin (QBO first)", () => {
    const plan = planStatementAdoption([stmt()], [existing({ id: "bl-qbo", sourceOfRecord: "QBO" })], ACCOUNT);
    assert.deepEqual([...plan.adopt.entries()], [[0, "bl-qbo"]]);
    assert.deepEqual(plan.mint, []);
});

test("a STATEMENT-sourced line is never adopted — the statement says how many there were", () => {
    const plan = planStatementAdoption([stmt()], [existing({ id: "bl-stmt", sourceOfRecord: "STATEMENT" })], ACCOUNT);
    assert.equal(plan.adopt.size, 0);
    assert.deepEqual(plan.mint, [0]);
});

test("no adoptable line → mint, exactly as before this feature existed", () => {
    const plan = planStatementAdoption([stmt(), stmt({ sequence: 1, amountCents: -900 })], [], ACCOUNT);
    assert.equal(plan.adopt.size, 0);
    assert.deepEqual(plan.mint, [0, 1]);
});

test("adoption needs an EXACT match on every field of the identity", async t => {
    const cases: Array<[string, Partial<ExistingBankLine>]> = [
        ["amount", { amountCents: -12_346 }],
        ["date", { postedDate: "2026-08-15" }],
        ["payee", { normalizedPayee: "HOME DEPOT" }],
        ["check number", { checkNumber: "1027" }],
        ["account", { account: "OTHER" }],
    ];
    for (const [label, over] of cases) {
        await t.test(label, () => {
            const plan = planStatementAdoption([stmt()], [existing({ id: "bl-qbo", sourceOfRecord: "QBO", ...over })], ACCOUNT);
            assert.equal(plan.adopt.size, 0, `${label} must not adopt`);
            assert.deepEqual(plan.mint, [0]);
        });
    }
});

test("N:N adopts deterministically instead of minting a third line", async t => {
    await t.test("two statement lines, two adoptable — both adopt, nothing mints", () => {
        const plan = planStatementAdoption(
            [stmt({ sequence: 0 }), stmt({ sequence: 1 })],
            [
                existing({ id: "bl-y", qbTxnId: "2000", sourceOfRecord: "QBO" }),
                existing({ id: "bl-x", qbTxnId: "1000", sourceOfRecord: "QBO" }),
            ],
            ACCOUNT,
        );
        assert.deepEqual(plan.mint, [], "minting a third line was the duplicate this feature prevents");
        // Sorted by qbTxnId, paired against sorted statement sequence.
        assert.deepEqual([...plan.adopt.entries()], [[0, "bl-x"], [1, "bl-y"]]);
        assert.deepEqual(plan.ambiguous, []);
    });

    await t.test("the pairing is the SAME on a replay, whatever order the rows arrive in", () => {
        const lines = [stmt({ sequence: 0 }), stmt({ sequence: 1 })];
        const a = existing({ id: "bl-y", qbTxnId: "2000", sourceOfRecord: "QBO" });
        const b = existing({ id: "bl-x", qbTxnId: "1000", sourceOfRecord: "QBO" });
        const first = planStatementAdoption(lines, [a, b], ACCOUNT);
        const second = planStatementAdoption([...lines].reverse(), [b, a], ACCOUNT);
        assert.deepEqual([...first.adopt.entries()], [...second.adopt.entries()]);
    });

    await t.test("two statement lines, ONE adoptable — one adopts, one mints, reported", () => {
        const plan = planStatementAdoption(
            [stmt({ sequence: 0 }), stmt({ sequence: 1 })],
            [existing({ id: "bl-qbo", qbTxnId: "1000", sourceOfRecord: "QBO" })],
            ACCOUNT,
        );
        assert.deepEqual([...plan.adopt.entries()], [[0, "bl-qbo"]]);
        assert.deepEqual(plan.mint, [1], "the statement says there were two");
        assert.equal(plan.ambiguous.length, 1, "QBO under-reported — surfaced for a human");
    });

    await t.test("one statement line, two adoptable — one adopts, the stale QBO line stays visible", () => {
        const plan = planStatementAdoption(
            [stmt()],
            [
                existing({ id: "bl-b", qbTxnId: "2000", sourceOfRecord: "QBO" }),
                existing({ id: "bl-a", qbTxnId: "1000", sourceOfRecord: "QBO" }),
            ],
            ACCOUNT,
        );
        assert.deepEqual([...plan.adopt.entries()], [[0, "bl-a"]]);
        assert.deepEqual(plan.mint, []);
    });

    await t.test("a candidate with no qbTxnId still orders stably, by line id", () => {
        const plan = planStatementAdoption(
            [stmt({ sequence: 0 }), stmt({ sequence: 1 })],
            [
                existing({ id: "bl-b", qbTxnId: null, sourceOfRecord: "QBO" }),
                existing({ id: "bl-a", qbTxnId: null, sourceOfRecord: "QBO" }),
            ],
            ACCOUNT,
        );
        assert.deepEqual([...plan.adopt.entries()], [[0, "bl-a"], [1, "bl-b"]]);
    });
});

test("an empty-payee statement line always mints — '' is not an identity", () => {
    const plan = planStatementAdoption(
        [stmt({ normalizedPayee: "" })],
        [existing({ id: "bl-qbo", sourceOfRecord: "QBO", normalizedPayee: "" })],
        ACCOUNT,
    );
    assert.equal(plan.adopt.size, 0);
    assert.deepEqual(plan.mint, [0]);
});

test("CONVERGENCE: both arrival orders end on exactly one canonical line", () => {
    // Order A — QBO first, statement second.
    const mintPlan = planQboMint([obs()], [], NOW);
    assert.equal(mintPlan.mint.length, 1);
    const qboLine = existing({ id: "bl-qbo", sourceOfRecord: "QBO" });
    const adoptA = planStatementAdoption([stmt()], [qboLine], ACCOUNT);
    const linesAfterA = 1 /* the QBO mint */ + adoptA.mint.length;
    assert.equal(linesAfterA, 1, "adoption reused the line rather than minting a twin");
    assert.deepEqual([...adoptA.adopt.values()], ["bl-qbo"]);

    // Order B — statement first, QBO pull second.
    const adoptB = planStatementAdoption([stmt()], [], ACCOUNT);
    assert.deepEqual(adoptB.mint, [0]);
    const stmtLine = existing({ id: "bl-stmt", sourceOfRecord: "STATEMENT" });
    const mintAfterB = planQboMint([obs()], [stmtLine], NOW);
    const linesAfterB = 1 /* the statement mint */ + mintAfterB.mint.length;
    assert.equal(linesAfterB, 1, "the QBO pull found the statement line and minted nothing");
});

test("RE-RUN after convergence still changes nothing, in either order", () => {
    const adopted = existing({ id: "bl-qbo", sourceOfRecord: "STATEMENT" }); // flipped by adoption
    assert.equal(planQboMint([obs()], [adopted], NOW).mint.length, 0);
    // A replayed statement is caught upstream by the content hash, but even if
    // it reached here the adopted line is now STATEMENT-sourced and unadoptable,
    // so it would mint rather than silently re-attach.
    const replay = planStatementAdoption([stmt()], [adopted], ACCOUNT);
    assert.equal(replay.adopt.size, 0);
});

// ── Concurrency (Codex round-2 blocker 2b) ──────────────────────────────────

/**
 * A ledger whose write path is serialized by the identity lock, so the two
 * interleavings can be driven explicitly. Planning happens INSIDE the critical
 * section, which is the whole point — planning outside it is the bug.
 */
function lockedLedger() {
    const lines: ExistingBankLine[] = [];
    const linked = new Map<string, string>();
    let queue: Promise<unknown> = Promise.resolve();
    let seq = 0;

    /** Serializes like pg_advisory_xact_lock on one key would. */
    function withIdentityLock<T>(work: () => Promise<T>): Promise<T> {
        const run = queue.then(work);
        queue = run.then(() => undefined, () => undefined);
        return run;
    }

    return {
        lines,
        linked,
        mint(observations: MintCandidateObservation[], now: Date) {
            return withIdentityLock(async () => {
                // Read → plan → write, all inside the lock.
                const withLinks = observations.map(o => ({ ...o, bankLineId: linked.get(o.id) ?? null }));
                const plan = planQboMint(withLinks, lines, now);
                for (const o of plan.mint) {
                    const id = `bl-minted-${++seq}`;
                    lines.push({
                        id,
                        account: o.account,
                        postedDate: o.postedDate,
                        amountCents: o.amountCents,
                        normalizedPayee: o.normalizedPayee,
                        checkNumber: o.checkNumber,
                        sourceOfRecord: "QBO",
                    });
                    linked.set(o.id, id);
                }
                return plan.mint.length;
            });
        },
    };
}

test("two concurrent mint runs over the same observation create ONE line", async () => {
    const ledger = lockedLedger();
    const observations = [obs()];
    const [a, b] = await Promise.all([
        ledger.mint(observations, NOW),
        ledger.mint(observations, NOW),
    ]);
    assert.equal(a + b, 1, "planning inside the lock is what makes the loser see the winner's line");
    assert.equal(ledger.lines.length, 1);
});

test("two concurrent runs over TWO same-identity observations still create exactly two", async () => {
    const ledger = lockedLedger();
    const observations = [obs({ id: "a" }), obs({ id: "b" })];
    const [x, y] = await Promise.all([
        ledger.mint(observations, NOW),
        ledger.mint(observations, NOW),
    ]);
    assert.equal(x + y, 2, "cardinality survives concurrency — two charges, two lines, no third");
    assert.equal(ledger.lines.length, 2);
});

test("a third run after both mints is a no-op", async () => {
    const ledger = lockedLedger();
    const observations = [obs({ id: "a" }), obs({ id: "b" })];
    await Promise.all([ledger.mint(observations, NOW), ledger.mint(observations, NOW)]);
    assert.equal(await ledger.mint(observations, NOW), 0);
    assert.equal(ledger.lines.length, 2);
});

test("both write paths take the SAME lock key, and plan inside it", () => {
    // Two paths locking on two spellings of one intent is the same as not
    // locking at all, and a lock taken AFTER the planning read protects nothing.
    assert.equal(BANK_LINE_IDENTITY_LOCK, "bank-line-identity");
    const cron = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    const ingest = readFileSync(join(repoRoot, "src/app/api/integrations/bank-ledger/ingest/route.ts"), "utf8");
    for (const [label, source, planner] of [
        ["cron mint", cron, "planQboMint("],
        ["statement ingest", ingest, "planStatementAdoption("],
    ] as const) {
        const lockAt = source.indexOf("pg_advisory_xact_lock(hashtext(${BANK_LINE_IDENTITY_LOCK}))");
        assert.ok(lockAt > 0, `${label} must take the shared identity lock`);
        const planAt = source.indexOf(planner);
        assert.ok(planAt > lockAt, `${label} must PLAN inside the lock, not before it`);
    }
});

// ── One canonical identity across raw descriptors (Codex round-3 P0 3) ──────

/**
 * REAL-SHAPED descriptors, not matching ones. The earlier convergence tests
 * passed only because their fixtures already agreed on the payee — the actual
 * pull appends the QBO transaction type, so the two sides never matched in
 * production and every adoption missed.
 */
const QBO_MEMO = "LOWES #02516 POS DEB C#8516 07/01/26";
const STATEMENT_RAW = "LOWES #02516 POS DEB C#8516 07/01/26";

test("the identity payee comes from the BANK FEED memo, not QuickBooks' name", () => {
    // QBO's `name` is Intuit-normalized ("Lowes"); the statement's descriptor is
    // not. Keying off the name produced two identities for one transaction.
    assert.equal(bankLineIdentityPayee({ memo: STATEMENT_RAW, name: "Lowes" }), "LOWES #02516");
    assert.equal(bankLineIdentityPayee({ memo: QBO_MEMO, name: "Lowes" }), "LOWES #02516");
    assert.equal(
        bankLineIdentityPayee({ memo: QBO_MEMO, name: "Lowes" }),
        bankLineIdentityPayee({ memo: STATEMENT_RAW, name: "Lowes" }),
        "the two sources must land on ONE key",
    );
});

test("the name is a FALLBACK, used only when the feed sent no memo", () => {
    assert.equal(bankLineIdentityPayee({ memo: null, name: "Lowes" }), "LOWES");
    assert.equal(bankLineIdentityPayee({ memo: "   ", name: "Lowes" }), "LOWES");
    assert.equal(bankLineIdentityPayee({ memo: null, name: null }), "");
});

test("the transaction type is NEVER part of identity", () => {
    // Appending it is what made every comparison miss.
    const line = registerRowToIngestLine({
        date: "2026-08-16", qbType: "Expense", qbTxnId: "6625",
        docNum: null, name: "Lowes", memo: QBO_MEMO, amountCents: -12_345,
    });
    assert.ok(line);
    assert.equal(line.rawDescriptor, QBO_MEMO, "the memo verbatim, with no type appended");
    assert.doesNotMatch(line.rawDescriptor, /Expense/);
});

test("with no memo the descriptor is the bare name, still no type", () => {
    const line = registerRowToIngestLine({
        date: "2026-08-16", qbType: "Expense", qbTxnId: "6625",
        docNum: null, name: "Lowes", memo: null, amountCents: -12_345,
    });
    assert.ok(line);
    assert.equal(line.rawDescriptor, "Lowes");
});

test("CONVERGENCE with MISMATCHED raw descriptors: QBO first, statement second", () => {
    // 1. The pull mints from the QBO row.
    const observation = obs({ rawDescriptor: QBO_MEMO, normalizedPayee: bankLineIdentityPayee({ memo: QBO_MEMO }) });
    const mintPlan = planQboMint([observation], [], NOW);
    assert.equal(mintPlan.mint.length, 1);
    const minted = existing({ id: "bl-qbo", qbTxnId: "6625", sourceOfRecord: "QBO", normalizedPayee: bankLineIdentityPayee({ memo: QBO_MEMO }) });

    // 2. The statement arrives with its OWN descriptor and must adopt it.
    const adoption = planStatementAdoption(
        [stmt({ normalizedPayee: bankLineIdentityPayee({ memo: STATEMENT_RAW }) })],
        [minted],
        ACCOUNT,
    );
    assert.deepEqual([...adoption.adopt.entries()], [[0, "bl-qbo"]], "the twin this used to create is the bug");
    assert.deepEqual(adoption.mint, []);
});

test("CONVERGENCE with MISMATCHED raw descriptors: statement first, QBO second", () => {
    const statementLine = existing({ id: "bl-stmt", sourceOfRecord: "STATEMENT", normalizedPayee: bankLineIdentityPayee({ memo: STATEMENT_RAW }) });
    const observation = obs({ rawDescriptor: QBO_MEMO, normalizedPayee: bankLineIdentityPayee({ memo: QBO_MEMO }) });
    const plan = planQboMint([observation], [statementLine], NOW);
    assert.equal(plan.mint.length, 0, "the pull must SEE the statement's line, not mint beside it");
    assert.equal(plan.skipped.statementLineExists, 1);
});

test("adoption copies the statement's descriptor, so the card owner is not lost", () => {
    // The QBO descriptor has no C#tail; the statement's is the only evidence of
    // whose card it was. Leaving the QBO text behind left every adopted line
    // owned by "office" and nobody was ever asked for the receipt.
    const source = readFileSync(join(repoRoot, "src/app/api/integrations/bank-ledger/ingest/route.ts"), "utf8");
    assert.match(source, /rawDescriptor: line\.rawDescriptor/);
    assert.match(source, /normalizedPayee: line\.normalizedPayee/);
    assert.match(source, /checkNumber: line\.checkNumber/);
    // And it stays scoped to lines the statement actually adopted.
    assert.match(source, /where: \{ id: bankLineId, sourceOfRecord: "QBO" \}/);
});

test("both write paths derive identity from the RAW descriptor, not a stored column", () => {
    for (const file of [
        "src/app/api/cron/bank-register-pull/route.ts",
        "src/app/api/integrations/bank-ledger/ingest/route.ts",
    ]) {
        const source = readFileSync(join(repoRoot, file), "utf8");
        assert.match(source, /bankLineIdentityPayee\(/, `${file} must use the shared identity function`);
    }
});
