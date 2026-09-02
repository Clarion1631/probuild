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
    type CutoverCandidate,
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
