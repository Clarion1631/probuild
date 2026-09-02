import assert from "node:assert/strict";
import test from "node:test";
import {
    QBO_MINT_MIN_AGE_DAYS,
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

test("two observations sharing one identity mint ONCE, not a twin", () => {
    const plan = planQboMint([obs({ id: "a" }), obs({ id: "b" })], [], NOW);
    assert.equal(plan.mint.length, 1);
    assert.equal(plan.mint[0].id, "a");
    assert.equal(plan.skipped.statementLineExists, 1);
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

test("ambiguity mints and is reported — never an arbitrary pairing", async t => {
    await t.test("two statement lines, one adoptable", () => {
        const plan = planStatementAdoption(
            [stmt({ sequence: 0 }), stmt({ sequence: 1 })],
            [existing({ id: "bl-qbo", sourceOfRecord: "QBO" })],
            ACCOUNT,
        );
        assert.equal(plan.adopt.size, 0);
        assert.deepEqual(plan.mint, [0, 1]);
        assert.equal(plan.ambiguous.length, 1);
    });
    await t.test("one statement line, two adoptable", () => {
        const plan = planStatementAdoption(
            [stmt()],
            [existing({ id: "a", sourceOfRecord: "QBO" }), existing({ id: "b", sourceOfRecord: "QBO" })],
            ACCOUNT,
        );
        assert.equal(plan.adopt.size, 0);
        assert.deepEqual(plan.mint, [0]);
        assert.equal(plan.ambiguous.length, 1);
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
