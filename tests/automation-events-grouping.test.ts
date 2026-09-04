import assert from "node:assert/strict";
import test from "node:test";
import {
    groupEventsIntoJourneys,
    indexJourneysByKeys,
    journeyKey,
    type JourneyEventInput,
    type ReceiptJourney,
} from "../src/lib/automation-events";

// ── N1 — one receipt must never split into two contradictory journeys ──────
// The regression: each event used to independently pick ONE grouping key
// (fileId, else qbPurchaseId, else the bare docNumber prefix) as it was
// folded into the map. A QBO-only event (carries qbPurchaseId but no fileId
// yet) landed under `qb:<id>` while an earlier prefix-only stage beacon for
// the SAME receipt stayed under `prefix:<doc>` — one journey could read
// "booked/synced" while the other read "stuck" and got a fix suggestion.
// The fix (`groupEventsIntoJourneys`) reconciles aliases with a union-find
// pass BEFORE any journey is built, so this must hold regardless of what
// order the events happen to arrive in.

function fakeEvent(overrides: Partial<JourneyEventInput> & { id: string; createdAt: Date }): JourneyEventInput {
    return {
        kind: "receipt-push",
        stage: null,
        status: "created",
        reason: null,
        source: null,
        vendor: null,
        projectName: null,
        docNumber: "DOC000000000000000000",
        fileName: null,
        amountCents: null,
        taxCents: null,
        qbPurchaseId: null,
        driveFileId: null,
        detail: null,
        ...overrides,
    };
}

function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    const result: T[][] = [];
    for (let i = 0; i < items.length; i++) {
        const rest = [...items.slice(0, i), ...items.slice(i + 1)];
        for (const p of permutations(rest)) {
            result.push([items[i], ...p]);
        }
    }
    return result;
}

test("N1: order-permutation — a prefix-only stage beacon, a qbPurchaseId-only push event, and a bridge event carrying BOTH ids all land in ONE journey, regardless of input order", () => {
    const doc = "1AbCdEfGhIjKlMnOpQrSt";
    // Prefix-only: no fileId, no qbPurchaseId — the earliest stage beacon,
    // before the bot had booked anything.
    const stageBeacon = fakeEvent({
        id: "stage-1", kind: "receipt-stage", stage: "intake", status: "ok",
        docNumber: doc, createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    // qbPurchaseId-only: the push succeeded and got a QBO id, but this event
    // itself never recorded the typed driveFileId column.
    const qboOnlyPush = fakeEvent({
        id: "push-1", kind: "receipt-push", stage: "push", status: "created",
        qbPurchaseId: "PID-1", docNumber: doc, createdAt: new Date("2026-01-01T00:05:00Z"),
    });
    // The bridge: a later retry (or a dual-write backfill) that recorded
    // BOTH ids on the same event — this is what reconciles the two clusters.
    const bridge = fakeEvent({
        id: "push-2", kind: "receipt-push", stage: "push", status: "already-exists",
        qbPurchaseId: "PID-1", driveFileId: `${doc}extra-chars-to-be-full-id`,
        docNumber: doc, createdAt: new Date("2026-01-01T00:10:00Z"),
    });

    for (const events of permutations([stageBeacon, qboOnlyPush, bridge])) {
        const journeys = [...groupEventsIntoJourneys(events).values()];
        assert.equal(journeys.length, 1, `expected exactly one journey regardless of order, got ${journeys.length}`);
        const j = journeys[0];
        assert.equal(j.steps.length, 3, "all three events must be folded into the one journey's timeline");
        assert.equal(j.qbPurchaseId, "PID-1");
        assert.equal(j.driveFileId, `${doc}extra-chars-to-be-full-id`);
        // Codex round 1 finding 5: `stageBeacon` is id-less and only joined
        // this cluster via the doc-prefix bridge heuristic (it shares no
        // fileId/qbPurchaseId with anything) — even though qboOnlyPush and
        // bridge together prove real id-confirmed evidence for THIS journey,
        // the bridge itself is still a guess (see "N1: an id-less event
        // bridged..." below for the case where that guess is wrong), so the
        // merged journey must not report confirmed.
        assert.equal(j.keyConfirmed, false);
        // The reconciled journey must read as booked (the push succeeded),
        // never "stuck" — this is the actual defect N1 fixes: before the
        // fix, the prefix-only stage beacon's OWN journey (missing the push
        // step) would have read in-flight/stuck instead.
        assert.equal(j.finalState, "booked-api");
    }
});

test("A4/N1: an id-less event bridged into an id-confirmed cluster via the doc-prefix heuristic downgrades the WHOLE journey to unconfirmed — the bridge is a guess, not proof, even though the cluster also has real driveFileId evidence", () => {
    const doc = "COLLIDING-PREFIX-00000";
    // Receipt A: a real, id-confirmed cluster (has its own driveFileId).
    const receiptA = fakeEvent({
        id: "a", driveFileId: "FILE-A-full-id", docNumber: doc, createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    // Receipt B's id-less intake event, sharing A's doc prefix — gets
    // bridged into A's cluster because A is the SOLE id-confirmed cluster
    // sharing that prefix, but that's a guess: B could be a genuinely
    // different receipt that just collides on the same 21-char prefix,
    // and nothing here can tell the two cases apart.
    const receiptBIntake = fakeEvent({
        id: "b", docNumber: doc, createdAt: new Date("2026-07-01T00:01:00Z"),
    });
    const journeys = [...groupEventsIntoJourneys([receiptA, receiptBIntake]).values()];
    assert.equal(journeys.length, 1, "still one merged journey — the bridge itself is unchanged by this fix");
    assert.equal(journeys[0].keyConfirmed, false, "but the merge must never be presented as confirmed");
});

test("N1: mixed-evidence — an event with only a qbPurchaseId reconciles with an event that only has a fileId, when a THIRD event links the two", () => {
    // Same idea as above but with the fileId-only and qbPurchaseId-only
    // events arriving with no order relationship implied by their ids.
    const fileOnly = fakeEvent({
        id: "z-file", driveFileId: "FILE-XYZ", docNumber: "DOC-XYZ-PREFIX-000000",
        createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    const qbOnly = fakeEvent({
        id: "a-qb", qbPurchaseId: "PID-XYZ", docNumber: "DOC-XYZ-PREFIX-000000",
        createdAt: new Date("2026-02-01T00:02:00Z"),
    });
    const linkEvent = fakeEvent({
        id: "m-link", driveFileId: "FILE-XYZ", qbPurchaseId: "PID-XYZ",
        docNumber: "DOC-XYZ-PREFIX-000000", createdAt: new Date("2026-02-01T00:01:00Z"),
    });

    for (const events of permutations([fileOnly, qbOnly, linkEvent])) {
        const journeys = [...groupEventsIntoJourneys(events).values()];
        assert.equal(journeys.length, 1);
        assert.equal(journeys[0].driveFileId, "FILE-XYZ");
        assert.equal(journeys[0].qbPurchaseId, "PID-XYZ");
    }
});

test("N1: two receipts with genuinely DISTINCT fileIds sharing a docNumber prefix never merge, even though one of them also carries a qbPurchaseId", () => {
    const doc = "COLLIDING-PREFIX-00000";
    const receiptOne = fakeEvent({
        id: "one", driveFileId: "FILE-ONE-full-id", qbPurchaseId: "PID-ONE",
        docNumber: doc, createdAt: new Date("2026-03-01T00:00:00Z"),
    });
    const receiptTwo = fakeEvent({
        id: "two", driveFileId: "FILE-TWO-full-id",
        docNumber: doc, createdAt: new Date("2026-03-01T00:01:00Z"),
    });
    const journeys = [...groupEventsIntoJourneys([receiptOne, receiptTwo]).values()];
    assert.equal(journeys.length, 2, "distinct fileIds must never be merged just because they share a docNumber prefix");
});

test("N1: distinct receipts that BOTH lack any id and share a docNumber prefix still fall into one prefix bucket (disclosed limitation, unconfirmed) — unchanged by this fix", () => {
    const doc = "NO-ID-EVIDENCE-0000000";
    const a = fakeEvent({ id: "a", docNumber: doc, createdAt: new Date("2026-04-01T00:00:00Z") });
    const b = fakeEvent({ id: "b", docNumber: doc, createdAt: new Date("2026-04-01T00:01:00Z") });
    const journeys = [...groupEventsIntoJourneys([a, b]).values()];
    assert.equal(journeys.length, 1);
    assert.equal(journeys[0].keyConfirmed, false);
});

test("N1: deterministic tie-breaker — two events with the identical createdAt millisecond still produce the same step order regardless of input order", () => {
    const at = new Date("2026-05-01T00:00:00.000Z");
    const eventA = fakeEvent({ id: "aaa", status: "created", createdAt: at });
    const eventB = fakeEvent({ id: "bbb", status: "already-exists", createdAt: at });

    const forward = [...groupEventsIntoJourneys([eventA, eventB]).values()][0];
    const reversed = [...groupEventsIntoJourneys([eventB, eventA]).values()][0];
    assert.deepEqual(
        forward.steps.map((s) => s.status),
        reversed.steps.map((s) => s.status),
        "step order for equal-timestamp events must not depend on array order",
    );
});

// ── indexJourneysByKeys — the N2 Map-building step ─────────────────────────

function fakeJourney(overrides: Partial<ReceiptJourney>): ReceiptJourney {
    return {
        docNumber: "doc", fileName: null, vendor: null, projectName: null,
        amountCents: null, taxCents: null,
        firstSeen: new Date("2026-01-01"), lastSeen: new Date("2026-01-01"),
        steps: [], finalState: "booked-api", finalReason: null,
        syncedExpenseId: null, syncedProjectName: null, backfilled: false,
        driveFileId: null, qbPurchaseId: null, keyConfirmed: true, synced: null,
        ...overrides,
    };
}

test("indexJourneysByKeys: qbPurchaseId and docNumber tiers are both populated for a confirmed journey", () => {
    const j = fakeJourney({ qbPurchaseId: "PID-1", docNumber: "DOC-1" });
    const { byQbPurchaseId, byDocNumber } = indexJourneysByKeys([j]);
    assert.equal(byQbPurchaseId.get("PID-1"), j);
    assert.equal(byDocNumber.get("DOC-1"), j);
});

test("indexJourneysByKeys: when two journeys share a docNumber (a real prefix collision), the most recently active one wins the map slot", () => {
    const older = fakeJourney({ docNumber: "DOC-SHARED", lastSeen: new Date("2026-01-01") });
    const newer = fakeJourney({ docNumber: "DOC-SHARED", lastSeen: new Date("2026-06-01") });
    const { byDocNumber } = indexJourneysByKeys([older, newer]);
    assert.equal(byDocNumber.get("DOC-SHARED"), newer);
    // Order-independent — same result no matter which came first in the array.
    const { byDocNumber: reversed } = indexJourneysByKeys([newer, older]);
    assert.equal(reversed.get("DOC-SHARED"), newer);
});

test("indexJourneysByKeys: a journey with no qbPurchaseId is absent from that tier but still present by docNumber", () => {
    const j = fakeJourney({ qbPurchaseId: null, docNumber: "DOC-2", keyConfirmed: false });
    const { byQbPurchaseId, byDocNumber } = indexJourneysByKeys([j]);
    assert.equal(byQbPurchaseId.size, 0);
    assert.equal(byDocNumber.get("DOC-2"), j);
});

// ── journeyKey (N4) — the fix-suggestion / React-list key ──────────────────

test("N4: journeyKey uses the qbPurchaseId tier before falling back to docNumber+firstSeen — two QBO-only journeys sharing a prefix and firstSeen no longer collide", () => {
    const firstSeen = new Date("2026-01-01T00:00:00Z");
    const a = { driveFileId: null, qbPurchaseId: "PID-A", docNumber: "SAME-PREFIX", firstSeen };
    const b = { driveFileId: null, qbPurchaseId: "PID-B", docNumber: "SAME-PREFIX", firstSeen };
    assert.notEqual(journeyKey(a), journeyKey(b));
    assert.equal(journeyKey(a), "qb:PID-A");
});

test("journeyKey: falls back to docNumber+firstSeen only when neither driveFileId nor qbPurchaseId is known", () => {
    const firstSeen = new Date("2026-01-01T00:00:00Z");
    const j = { driveFileId: null, qbPurchaseId: null, docNumber: "DOC-3", firstSeen };
    assert.equal(journeyKey(j), `DOC-3:${firstSeen.toISOString()}`);
});

// ── A v2 receipt with no Drive file behind it still groups (round-14 C) ────

test("intakeId is a first-class identity, and never masquerades as a Drive id", async () => {
    const { resolveEventFileId, resolveEventIntakeId } =
        await import("../src/lib/automation-events");

    const INTAKE_ID = "cmpd6xca1009x1iizdf4suln3";
    const doc = "cmpd6xca1009x1iizd";
    // A v2 receipt with no Drive file behind it: an intake beacon and the push
    // event that booked it. Before the fix the worker put the intake cuid in
    // `fileId`, which is dual-written into the `driveFileId` COLUMN — filling
    // it with ids no Drive query can ever match.
    const intake = fakeEvent({
        id: "e1", stage: "intake", status: "staged", docNumber: doc,
        detail: JSON.stringify({ intakeId: INTAKE_ID }),
        createdAt: new Date("2026-09-01T10:00:00Z"),
    });
    const push = fakeEvent({
        id: "e2", status: "created", docNumber: doc, qbPurchaseId: "QB-1",
        detail: JSON.stringify({ intakeId: INTAKE_ID, qbPurchaseId: "QB-1" }),
        createdAt: new Date("2026-09-01T10:05:00Z"),
    });

    // Neither event claims a Drive id, because neither has one.
    assert.equal(resolveEventFileId(intake), null);
    assert.equal(resolveEventFileId(push), null);
    assert.equal(resolveEventIntakeId(intake), INTAKE_ID);

    // They are still ONE receipt, joined on the intake id — proof, not the
    // docNumber-prefix heuristic, which is explicitly a guess.
    const journeys = [...groupEventsIntoJourneys([intake, push]).values()];
    assert.equal(journeys.length, 1);
    assert.equal(journeys[0].steps.length, 2);
    assert.equal(journeys[0].keyConfirmed, true, "an id match is proof, not a guess");
});

test("two DIFFERENT v2 receipts sharing a docNumber prefix stay apart", () => {
    // The control: the intake id is what keeps them separate. Without it both
    // would fall into the prefix bucket and be presented as one receipt.
    const doc = "COLLIDING-PREFIX-00000";
    const a = fakeEvent({
        id: "a", docNumber: doc, detail: JSON.stringify({ intakeId: "intake-a" }),
        createdAt: new Date("2026-09-01T10:00:00Z"),
    });
    const b = fakeEvent({
        id: "b", docNumber: doc, detail: JSON.stringify({ intakeId: "intake-b" }),
        createdAt: new Date("2026-09-01T10:01:00Z"),
    });
    const journeys = [...groupEventsIntoJourneys([a, b]).values()];
    assert.equal(journeys.length, 2, "two ids, two receipts");
});
