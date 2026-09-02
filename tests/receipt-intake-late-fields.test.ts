/**
 * Late job/phase assignment, and the races around it.
 *
 * A late field is a write to a row somebody else may be holding. The read that
 * decides whether the write is allowed and the write itself are two round trips
 * to Postgres, and every interesting bug lives in the gap: the worker claims,
 * the state moves, a second caller writes a DIFFERENT project. A CAS that
 * simply reports "busy" on a lost race is not enough — the same lost CAS also
 * means "somebody already wrote exactly this", and answering 409 there makes a
 * correct retry loop forever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    authorizePhase,
    reconcileLateFields,
    type Denial,
    type LateFieldRow,
    type LateFieldsDeps,
} from "../src/lib/receipt-intake/late-fields";

function row(over: Partial<LateFieldRow> = {}): LateFieldRow {
    return { costCodeId: null, projectId: null, state: "RECEIVED", claimToken: null, ...over };
}

interface Trace {
    deps: LateFieldsDeps;
    applied: Record<string, string>[];
    authorized: (string | null)[];
}

/** `reads` is consumed one per call, so a race can be scripted precisely. */
function deps(reads: LateFieldRow[], count: number, denial: Denial | null = null): Trace {
    const t: Trace = { applied: [], authorized: [], deps: null as unknown as LateFieldsDeps };
    let i = 0;
    t.deps = {
        read: async () => reads[Math.min(i++, reads.length - 1)] ?? null,
        applyIfNull: async (_id, _state, toApply) => { t.applied.push(toApply); return count; },
        authorize: async projectId => { t.authorized.push(projectId); return denial; },
    };
    return t;
}

test("an un-routed row with empty fields takes the values", async () => {
    const t = deps([row()], 1);
    assert.equal(await reconcileLateFields("r1", { projectId: "p1", costCodeId: "c1" }, t.deps), null);
    assert.deepEqual(t.applied, [{ projectId: "p1", costCodeId: "c1" }]);
});

test("a routed row refuses a DIFFERENT project and never writes", async () => {
    // Past RECEIVED the dedup keys, the phase suggestion and possibly a Purchase
    // were all derived from the project the row had. Changing it now does not
    // re-derive any of that.
    const t = deps([row({ state: "READ", projectId: "p1" })], 1);
    const denial = await reconcileLateFields("r1", { projectId: "p2" }, t.deps);
    assert.equal(denial?.status, 409);
    assert.equal(denial?.body.error, "late-fields-too-late");
    assert.deepEqual(t.applied, [], "no write was attempted");
});

test("a routed row accepts a repeat of what it already holds", async () => {
    // The client's retry after a lost response carries the same fields. That is
    // not a conflict, and answering 409 would make a correct client give up.
    const t = deps([row({ state: "BOOKED", projectId: "p1" })], 1);
    assert.equal(await reconcileLateFields("r1", { projectId: "p1" }, t.deps), null);
});

// ── the races ───────────────────────────────────────────────────────────────

test("STATE-TRANSITION RACE: the row moves between the read and the write", async () => {
    // Read says RECEIVED/unclaimed, so the write is allowed. By the time it
    // runs a worker has claimed and read the row, and the CAS matches nothing.
    // The persisted project is NOT what was supplied, so this is a real 409 —
    // and a retryable one, because a claim is transient.
    const t = deps(
        [row(), row({ state: "READ", projectId: null, claimToken: "tok-9" })],
        0,
    );
    const denial = await reconcileLateFields("r1", { projectId: "p1" }, t.deps);
    assert.equal(denial?.status, 409);
    assert.equal(denial?.body.error, "late-fields-busy");
    assert.equal(denial?.body.state, "READ");
    assert.equal(denial?.body.retryable, true, "a claim clears on its own; the client should retry");
    assert.deepEqual(t.authorized, [], "a row that does not hold our values is not re-authorized");
});

test("a lost CAS whose row holds EXACTLY what was supplied is a success", async () => {
    // Two callers finalized the same row with the same fields. One won. The
    // loser must not be told 409 — nothing is wrong and nothing is left to do.
    const t = deps([row(), row({ projectId: "p1" })], 0);
    assert.equal(await reconcileLateFields("r1", { projectId: "p1" }, t.deps), null);
    assert.deepEqual(t.authorized, ["p1"], "still re-authorized against the persisted project");
});

test("CONCURRENT PROJECT CHANGE: the phase is re-authorized against the NEW project", async () => {
    // The phase was authorized against the project the row had at read time. A
    // concurrent write moved the row to a different job, and our cost code is
    // not one of ITS phases. Accepting it here would file the receipt against a
    // phase of another job — the exact thing the first check exists to stop.
    const denied: Denial = { status: 400, body: { ok: false, error: "cost-code-not-a-phase" } };
    const t = deps([row({ projectId: "p1" }), row({ projectId: "p2", costCodeId: "c1" })], 0, denied);
    const result = await reconcileLateFields("r1", { costCodeId: "c1" }, t.deps);
    assert.deepEqual(t.authorized, ["p2"], "against the project the row carries NOW, not p1");
    assert.equal(result?.status, 400);
    assert.equal(result?.body.error, "cost-code-not-a-phase");
});

test("a row that vanished under the write is a non-retryable conflict", async () => {
    const t = deps([row(), null as unknown as LateFieldRow], 0);
    const denial = await reconcileLateFields("r1", { projectId: "p1" }, t.deps);
    assert.equal(denial?.body.state, "gone");
    assert.equal(denial?.body.retryable, false);
});

test("a conflicting stored value is refused before any write", async () => {
    const t = deps([row({ projectId: "p1" })], 1);
    const denial = await reconcileLateFields("r1", { projectId: "p2" }, t.deps);
    assert.equal(denial?.body.error, "late-fields-conflict");
    assert.deepEqual(t.applied, []);
});

test("no late fields means no reads and no writes at all", async () => {
    const t = deps([row()], 1);
    assert.equal(await reconcileLateFields("r1", {}, t.deps), null);
    assert.deepEqual(t.applied, []);
});

// ── The phase gate: /start is the only place a start-time phase is checked ──

/** A job with exactly one phase of its own. Anything else belongs elsewhere. */
const phasesOf: Record<string, string[]> = { "proj-a": ["cc-a"], "proj-b": ["cc-b"] };
const isCostCodeAllowed = async (projectId: string, costCodeId: string) =>
    (phasesOf[projectId] ?? []).includes(costCodeId);

test("a phase from ANOTHER job is refused at /start, before a row exists", async () => {
    const denial = await authorizePhase("proj-a", "cc-b", isCostCodeAllowed);
    assert.equal(denial?.status, 400);
    assert.equal(denial?.body.error, "cost-code-not-a-phase");
    assert.equal(denial?.body.projectId, "proj-a");
});

test("a phase with no job at all is refused: it is not meaningful", async () => {
    const denial = await authorizePhase(null, "cc-a", isCostCodeAllowed);
    assert.equal(denial?.status, 400);
    assert.equal(denial?.body.error, "cost-code-without-project");
});

test("the job's own phase passes, and no phase at all is not a lookup", async () => {
    assert.equal(await authorizePhase("proj-a", "cc-a", isCostCodeAllowed), null);
    let looked = 0;
    assert.equal(
        await authorizePhase("proj-a", null, async () => { looked++; return true; }),
        null,
    );
    assert.equal(looked, 0);
});

test("REGRESSION: a cross-project phase cannot survive by being OMITTED at finalize", async () => {
    // The hole this closes. /start stored a caller-supplied costCodeId
    // unchecked, and /finalize only authorizes the fields the FINALIZE call
    // carries — so a client that sent the phase at /start and then finalized
    // with an empty body got a published row holding a phase from another job,
    // having passed no check anywhere. The Expense inherits it and the other
    // job's variance report reads overspend on a line nobody budgeted.
    //
    // Step 1: finalize with no late fields runs NO authorization. That is
    // correct — there is nothing to authorize — and it is exactly why /start
    // has to be the gate.
    let authorizations = 0;
    const finalize = deps([row({ projectId: "proj-a", costCodeId: "cc-b" })], 1);
    const counted: LateFieldsDeps = {
        ...finalize.deps,
        authorize: async projectId => { authorizations++; return finalize.deps.authorize(projectId); },
    };
    assert.equal(await reconcileLateFields("r1", {}, counted), null);
    assert.equal(authorizations, 0, "finalize never re-checks a phase it was not sent");
    assert.deepEqual(finalize.applied, [], "and writes nothing");

    // Step 2: so the same payload must be refused at /start, where the row
    // would otherwise be created holding it.
    const atStart = await authorizePhase("proj-a", "cc-b", isCostCodeAllowed);
    assert.equal(atStart?.status, 400, "the row is never created");
    assert.equal(atStart?.body.error, "cost-code-not-a-phase");
});

test("both intake entry points call the SAME phase gate", () => {
    // Two copies of this rule is how they drift, and a route that skips it is
    // this whole regression again.
    const routes = [
        "src/app/api/receipts/intake/start/route.ts",
        "src/app/api/receipts/intake/route.ts",
        "src/app/api/receipts/intake/[id]/finalize/route.ts",
    ];
    for (const rel of routes) {
        const source = readFileSync(path.join(__dirname, "..", rel), "utf8");
        assert.match(source, /authorizePhase\(/, `${rel} does not use the shared gate`);
        // CALLING it is not the same as OBEYING it: the denial has to end the
        // request, or the row is created with the phase anyway.
        assert.match(
            source,
            /if \(badPhase\) return NextResponse\.json\(badPhase\.body, \{ status: badPhase\.status \}\);|return await authorizePhase\(/,
            `${rel} does not return the denial`,
        );
        assert.ok(
            !/error: "cost-code-not-a-phase"/.test(source),
            `${rel} carries its own copy of the rule`,
        );
    }
});
