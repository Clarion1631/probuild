/**
 * The cutover boundary and the storage-failure classification.
 *
 * Both are places where getting the answer WRONG loses money rather than
 * merely erroring: a mis-parsed boundary retires receipts nobody booked, and a
 * mis-classified storage fault declares a present file missing and releases its
 * dedup key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    parseCutoverBoundary,
    CUTOVER_SETTING_KEY,
    driveFileIdOf,
    triageCutoverRows,
    applyCutoverVerdict,
    type CutoverCandidate,
    type CutoverRow,
    type CutoverWriteClient,
} from "../src/lib/receipt-intake/cutover";

test("a missing or malformed boundary is null — never epoch", () => {
    // The dangerous failure: `new Date(undefined)` style coercion yielding a
    // date in 1970 would put the ENTIRE backlog "before the boundary" and
    // retire every row, including the ones v1 never booked.
    for (const bad of [undefined, null, "", "   ", "not-a-date", "yesterday", "2026-13-45"]) {
        assert.equal(parseCutoverBoundary(bad as string | null | undefined), null, JSON.stringify(bad));
    }
});

test("a real ISO timestamp parses to that instant", () => {
    const at = parseCutoverBoundary("2026-08-25T17:30:00.000Z");
    assert.ok(at);
    assert.equal(at.toISOString(), "2026-08-25T17:30:00.000Z");
    // Surrounding whitespace is a copy-paste artefact, not a different answer.
    assert.equal(parseCutoverBoundary("  2026-08-25T17:30:00.000Z  ")!.toISOString(), "2026-08-25T17:30:00.000Z");
});

test("the setting key is stable — an operator writes this row at the flip", () => {
    // Renaming it silently would make every future cutover refuse.
    assert.equal(CUTOVER_SETTING_KEY, "cutoverV1StoppedAt");
});

test("ambiguous or naive timestamps are rejected, not silently shifted", () => {
    // Each of these parses fine under plain `new Date()`/`Date.parse()`, but
    // none of them names one unambiguous instant: a date-only value reads as
    // UTC midnight, a naive local value reads in the SERVER's zone, and a
    // slash-separated value is locale-ambiguous (US vs. day-first). Any of
    // those can shift the boundary by hours, which either retires rows v1
    // never booked or lets a v1-booked row slip through to be double-booked.
    for (const ambiguous of [
        "2026-09-01",              // date-only — UTC midnight
        "2026-09-01T10:00:00",     // naive local time, no offset
        "2026-09-01T10:00:00.123", // naive local time with fractional seconds
        "9/1/2026",                // locale-ambiguous
        "2026-09-01 10:00:00Z",    // space instead of T
        "2026-09-01T10:00",        // missing seconds
    ]) {
        assert.equal(parseCutoverBoundary(ambiguous), null, ambiguous);
    }
});

test("an explicit ±HH:MM offset is accepted and converted to the right instant", () => {
    const at = parseCutoverBoundary("2026-08-25T10:30:00-07:00");
    assert.ok(at);
    assert.equal(at.toISOString(), "2026-08-25T17:30:00.000Z");
});

// ── The three-way split: evidence outranks the timestamp ───────────────────

const BOUNDARY = new Date("2026-08-25T00:00:00.000Z");
const before = new Date("2026-08-24T12:00:00.000Z");
const after = new Date("2026-08-26T12:00:00.000Z");

function candidate(over: Partial<CutoverCandidate> = {}): CutoverCandidate {
    return {
        id: "row-1",
        source: "drive",
        sourceRef: "drive:FILE1",
        archivedByV1: false,
        createdAt: before,
        ...over,
    };
}

test("an AFTER-boundary row the forwarder says v1 archived is RETIRED, never booked", async () => {
    // The hole: the candidate query filtered on createdAt first, so a file v1
    // had ALREADY booked but handed over after the flip (a queued send, a
    // retry, a slow archive step) never reached the evidence check — it went
    // into the requeue and v2 booked a SECOND Purchase. For an email or chat
    // row there is no shared identity to collapse that: v2 books under the
    // intake UUID, which v1 never saw.
    for (const source of ["email", "chat"]) {
        const triage = triageCutoverRows(
            [candidate({ source, sourceRef: `${source}:msg-1`, archivedByV1: true, createdAt: after })],
            BOUNDARY,
            new Set(),
        );
        assert.deepEqual(triage.evidenced, ["row-1"], source);
        assert.deepEqual(triage.unevidenced, [], `${source}: never handed to v2`);
        assert.deepEqual(triage.quarantined, [], source);
    }
});

test("a v1 booked marker also retires an after-boundary row", async () => {
    const triage = triageCutoverRows(
        [candidate({ createdAt: after })],
        BOUNDARY,
        new Set(["FILE1"]),
    );
    assert.deepEqual(triage.evidenced, ["row-1"]);
});

test("only EVIDENCE-FREE rows are judged by the boundary", async () => {
    const rows = [
        candidate({ id: "after-nothing", source: "email", sourceRef: "email:m2", createdAt: after }),
        candidate({ id: "before-drive", sourceRef: "drive:F2", createdAt: before }),
        candidate({ id: "before-email", source: "email", sourceRef: "email:m3", createdAt: before }),
    ];
    const triage = triageCutoverRows(rows, BOUNDARY, new Set());
    // After the flip nothing but v2 could have booked it.
    assert.deepEqual(triage.unevidenced, ["after-nothing", "before-drive"]);
    // Shadow-window, no evidence, no shared identity: a human decides.
    assert.deepEqual(triage.quarantined, ["before-email"]);
    assert.deepEqual(triage.evidenced, []);
});

test("the boundary instant itself counts as AFTER, and every row lands in exactly one bucket", async () => {
    const rows = [
        candidate({ id: "at-boundary", source: "chat", sourceRef: "chat:m1", createdAt: BOUNDARY }),
        candidate({ id: "evidenced", archivedByV1: true }),
        candidate({ id: "quarantine", source: "web", sourceRef: "web:u1" }),
    ];
    const triage = triageCutoverRows(rows, BOUNDARY, new Set());
    assert.deepEqual(triage.unevidenced, ["at-boundary"]);
    assert.deepEqual(triage.evidenced, ["evidenced"]);
    assert.deepEqual(triage.quarantined, ["quarantine"]);
    const all = [...triage.evidenced, ...triage.unevidenced, ...triage.quarantined];
    assert.equal(all.length, rows.length, "no row is dropped or counted twice");
});

test("driveFileIdOf only claims a shared identity for a real drive ref", () => {
    assert.equal(driveFileIdOf({ source: "drive", sourceRef: "drive:ABC" }), "ABC");
    assert.equal(driveFileIdOf({ source: "email", sourceRef: "drive:ABC" }), null);
    assert.equal(driveFileIdOf({ source: "drive", sourceRef: "web:ABC" }), null);
});

// ── The cutover WRITES, fenced on the rows they were decided about ─────────

function row(over: Partial<CutoverRow> = {}): CutoverRow {
    return {
        ...candidate(),
        state: "READ",
        stateReason: null,
        dryRun: true,
        claimToken: null,
        ...over,
    };
}

/**
 * A store whose `updateMany` really evaluates the where clause — the fence IS
 * the subject, so a fake that matched on the id alone would report success for
 * a row somebody else had already moved, which is precisely the bug.
 */
function store(rows: (CutoverRow | Record<string, unknown>)[]) {
    const state = {
        rows: rows.map(r => ({ ...r } as Record<string, unknown>)),
        wheres: [] as Record<string, unknown>[],
    };
    const db: CutoverWriteClient = {
        updateMany: async ({ where, data }) => {
            state.wheres.push(where);
            const { id, ...rest } = where as { id: { in: string[] } } & Record<string, unknown>;
            const hits = state.rows.filter(r =>
                id.in.includes(r.id as string)
                && Object.entries(rest).every(([k, v]) => r[k] === v || (r[k] == null && v == null)));
            for (const hit of hits) Object.assign(hit, data);
            return { count: hits.length };
        },
    };
    return { state, db };
}

const RETIRE = { state: "SHADOW_DONE", stateReason: "booked-by-v1", nextRetryAt: null };

test("A ROW REVIEWED BETWEEN THE SELECT AND THE WRITE KEEPS ITS REVIEWED STATE", async () => {
    // The finding: the three cutover updates constrained nothing but `id`. The
    // candidates are read in the claim transaction, but READ COMMITTED lets a
    // writer that never touches the advisory lock — an admin review, a future
    // queue UI, a late completion — move a row in the gap. The verdict then
    // landed on a row it was never computed for, and SHADOW_DONE /
    // SHADOW_QUARANTINE are terminal.
    const observed = row({ id: "reviewed" });
    const { state, db } = store([observed]);

    // The concurrent review, AFTER the triage saw the row and BEFORE the write.
    state.rows[0].state = "NEEDS_REVIEW";
    state.rows[0].stateReason = "human-hold";

    const moved = await applyCutoverVerdict([observed], RETIRE, db);
    assert.deepEqual(moved, { moved: 0, skippedMoved: 1 }, "the verdict is dropped, and counted");
    assert.equal(state.rows[0].state, "NEEDS_REVIEW", "the human's decision survives");
    assert.equal(state.rows[0].stateReason, "human-hold");
});

test("an UNTOUCHED row still gets its verdict", async () => {
    // The control: without it, a CAS that never matches anything would pass the
    // test above while breaking the entire cutover.
    const observed = row({ id: "quiet" });
    const { state, db } = store([observed]);
    const moved = await applyCutoverVerdict([observed], RETIRE, db);
    assert.deepEqual(moved, { moved: 1, skippedMoved: 0 });
    assert.equal(state.rows[0].state, "SHADOW_DONE");
    assert.equal(state.rows[0].stateReason, "booked-by-v1");
});

test("a row CLAIMED between the select and the write is skipped, not overwritten", async () => {
    // A worker that owns the row is mid-flight on it. Retiring it under the
    // claim would strand a pass writing results into a terminal state.
    const observed = row({ id: "claimed" });
    const { state, db } = store([observed]);
    state.rows[0].claimToken = "tok-9";
    const moved = await applyCutoverVerdict([observed], RETIRE, db);
    assert.deepEqual(moved, { moved: 0, skippedMoved: 1 });
    assert.equal(state.rows[0].state, "READ");
});

test("a row taken off the shadow switch mid-pass is not handed to v2 twice", async () => {
    // `dryRun` is pinned too: the requeue writes `dryRun: false`, and a row
    // something else already flipped is no longer the row that was triaged.
    const observed = row({ id: "live-now" });
    const { state, db } = store([observed]);
    state.rows[0].dryRun = false;
    const moved = await applyCutoverVerdict([observed], { dryRun: false, nextRetryAt: null }, db);
    assert.deepEqual(moved, { moved: 0, skippedMoved: 1 });
});

test("the CAS carries the WHOLE parked predicate plus the observed evidence", async () => {
    const observed = row({ id: "r1", state: "BOOKING", stateReason: "qbo-fault:6240" });
    const { state, db } = store([observed]);
    await applyCutoverVerdict([observed], RETIRE, db);
    assert.deepEqual(state.wheres, [{
        id: { in: ["r1"] },
        dryRun: true,
        state: "BOOKING",
        stateReason: "qbo-fault:6240",
        claimToken: null,
    }]);
});

test("a STALE claim is pinned, not demanded away — the row still reaches its verdict", async () => {
    // A shadow-parked row is excluded from the claim entirely, so a token on it
    // on the live pass is a leftover from a pass that died during the shadow
    // week. Requiring `claimToken: null` would hide the row from the cutover
    // FOREVER: nothing can re-claim it to release the token, so it would never
    // be retired, requeued or quarantined, and nobody would be told.
    const observed = row({ id: "stale", claimToken: "dead-tok" });
    const { state, db } = store([observed]);
    const moved = await applyCutoverVerdict([observed], RETIRE, db);
    assert.deepEqual(moved, { moved: 1, skippedMoved: 0 });
    assert.equal(state.rows[0].state, "SHADOW_DONE");
    assert.equal(state.wheres[0].claimToken, "dead-tok", "pinned at what was observed");
});

test("rows are grouped by their OBSERVED state, so one verdict cannot smear another's", async () => {
    // Grouping is a round-trip optimisation, not a loosening: two rows parked
    // for different reasons must not be written under one another's fence.
    const a = row({ id: "a", state: "READ", stateReason: null });
    const b = row({ id: "b", state: "READ", stateReason: null });
    const c = row({ id: "c", state: "BOOKING", stateReason: "qbo-fault:6240" });
    const { state, db } = store([a, b, c]);
    // `c` moves; `a` and `b` do not.
    state.rows[2].stateReason = "max-retries";

    const moved = await applyCutoverVerdict([a, b, c], RETIRE, db);
    assert.deepEqual(moved, { moved: 2, skippedMoved: 1 });
    assert.equal(state.wheres.length, 2, "one statement per distinct observed state");
    assert.equal(state.rows[0].state, "SHADOW_DONE");
    assert.equal(state.rows[1].state, "SHADOW_DONE");
    assert.equal(state.rows[2].state, "BOOKING", "the row that moved is untouched");
});

test("no rows is no statements", async () => {
    const { state, db } = store([]);
    assert.deepEqual(await applyCutoverVerdict([], RETIRE, db), { moved: 0, skippedMoved: 0 });
    assert.deepEqual(state.wheres, []);
});
