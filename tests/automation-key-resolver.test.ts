import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationEvent } from "@prisma/client";
import {
    pickPushEvent,
    resolvePushEventByDocNumberPrefix,
    readIdentifier,
    resolveReceiptPushEvent,
    trustedQbPurchaseId,
    type ReceiptPushEventStore,
} from "../src/lib/automation-key-resolver";
import { resolveEventFileId, resolveEventQbPurchaseId } from "../src/lib/automation-events";

// ── resolveEventFileId / resolveEventQbPurchaseId ──────────────────────────
// These power every tier of the resolution below — a regression here would
// silently make every other test pass for the wrong reason.

test("resolveEventFileId prefers the typed column over detail JSON", () => {
    assert.equal(resolveEventFileId({ driveFileId: "typed-id", detail: JSON.stringify({ fileId: "json-id" }) }), "typed-id");
});

test("resolveEventFileId falls back to legacy detail JSON", () => {
    assert.equal(resolveEventFileId({ driveFileId: null, detail: JSON.stringify({ fileId: "json-id" }) }), "json-id");
});

test("resolveEventFileId returns null when neither source has it", () => {
    assert.equal(resolveEventFileId({ driveFileId: null, detail: null }), null);
    assert.equal(resolveEventFileId({ driveFileId: null, detail: "not json" }), null);
    assert.equal(resolveEventFileId({ driveFileId: "", detail: JSON.stringify({ fileId: 123 }) }), null);
});

test("resolveEventQbPurchaseId prefers typed column, falls back to detail JSON", () => {
    assert.equal(resolveEventQbPurchaseId({ qbPurchaseId: "typed-qb", detail: JSON.stringify({ qbPurchaseId: "json-qb" }) }), "typed-qb");
    assert.equal(resolveEventQbPurchaseId({ qbPurchaseId: null, detail: JSON.stringify({ qbPurchaseId: "json-qb" }) }), "json-qb");
    assert.equal(resolveEventQbPurchaseId({ qbPurchaseId: null, detail: null }), null);
});

// ── pickPushEvent ────────────────────────────────────────────────────────

test("pickPushEvent prefers the earliest 'created' event over any 'already-exists' retry", () => {
    const later = { status: "created", createdAt: new Date("2026-01-02") };
    const earlier = { status: "created", createdAt: new Date("2026-01-01") };
    const retry = { status: "already-exists", createdAt: new Date("2026-01-05") };
    assert.equal(pickPushEvent([later, earlier, retry]), earlier);
});

test("pickPushEvent falls back to the latest 'already-exists' when there is no 'created' row", () => {
    const older = { status: "already-exists", createdAt: new Date("2026-01-01") };
    const newer = { status: "already-exists", createdAt: new Date("2026-01-05") };
    assert.equal(pickPushEvent([older, newer]), newer);
});

test("pickPushEvent returns null for an empty or irrelevant-status candidate list", () => {
    assert.equal(pickPushEvent([]), null);
    assert.equal(pickPushEvent([{ status: "error", createdAt: new Date() }]), null);
});

// ── resolvePushEventByDocNumberPrefix — the actual collision defect ────────

test("resolvePushEventByDocNumberPrefix: 'none' for an empty candidate set", () => {
    assert.deepEqual(resolvePushEventByDocNumberPrefix([]), { outcome: "none" });
});

test("resolvePushEventByDocNumberPrefix: resolves cleanly when every candidate agrees on one full fileId", () => {
    const a = { driveFileId: "fileA", detail: null, status: "created", createdAt: new Date("2026-01-01") };
    const b = { driveFileId: "fileA", detail: null, status: "already-exists", createdAt: new Date("2026-01-02") };
    const result = resolvePushEventByDocNumberPrefix([a, b]);
    assert.equal(result.outcome, "resolved");
    if (result.outcome === "resolved") {
        assert.equal(result.fullFileId, "fileA");
        assert.equal(result.event, a); // earliest "created" wins
    }
});

test("resolvePushEventByDocNumberPrefix: NEVER silently picks one when two distinct fileIds share the prefix", () => {
    // The exact scenario qbo-receipt-push.ts:477-481 warns about: two
    // different Drive fileIds truncate to the same 21-char docNumber.
    const receiptOne = { driveFileId: "1AbCdEfGhIjKlMnOpQrStUvWxYzONE", detail: null, status: "created", createdAt: new Date("2026-01-01") };
    const receiptTwo = { driveFileId: "1AbCdEfGhIjKlMnOpQrStUvWxYzTWO", detail: null, status: "created", createdAt: new Date("2026-01-02") };
    const result = resolvePushEventByDocNumberPrefix([receiptOne, receiptTwo]);
    assert.equal(result.outcome, "ambiguous");
    if (result.outcome === "ambiguous") {
        assert.equal(result.candidateCount, 2);
        assert.deepEqual(new Set(result.distinctFileIds), new Set([receiptOne.driveFileId, receiptTwo.driveFileId]));
    }
});

test("resolvePushEventByDocNumberPrefix: resolves (unconfirmed by the caller's contract) when no candidate has a resolvable full fileId", () => {
    // Pre-dual-write rows: no typed column, no fileId in detail JSON either.
    // Still a single best-effort pick — but the caller must mark it
    // unconfirmed, never "ambiguous" (we have no evidence of a collision,
    // just no evidence against one either).
    const a = { driveFileId: null, detail: null, status: "created", createdAt: new Date("2026-01-01") };
    const result = resolvePushEventByDocNumberPrefix([a]);
    assert.equal(result.outcome, "resolved");
    if (result.outcome === "resolved") {
        assert.equal(result.fullFileId, null);
        assert.equal(result.event, a);
    }
});

test("resolvePushEventByDocNumberPrefix: a legacy detail-JSON-only fileId still counts toward ambiguity", () => {
    const a = { driveFileId: null, detail: JSON.stringify({ fileId: "fileA" }), status: "created", createdAt: new Date("2026-01-01") };
    const b = { driveFileId: "fileB", detail: null, status: "created", createdAt: new Date("2026-01-02") };
    const result = resolvePushEventByDocNumberPrefix([a, b]);
    assert.equal(result.outcome, "ambiguous");
});

// ── readIdentifier ──────────────────────────────────────────────────────

test("readIdentifier trims, rejects blank/oversized/non-string values", () => {
    assert.equal(readIdentifier("  abc123  ", 10), "abc123");
    assert.equal(readIdentifier("   ", 10), null);
    assert.equal(readIdentifier("this-is-way-too-long", 5), null);
    assert.equal(readIdentifier(42, 10), null);
    assert.equal(readIdentifier(undefined, 10), null);
    assert.equal(readIdentifier(null, 10), null);
});

// ── resolveReceiptPushEvent — the DB-backed resolver path (A1/A2/A3/A6/A7) ──
// Exercised against a fake `ReceiptPushEventStore` instead of a live
// database — same tiers/equality/ambiguity logic that runs against Prisma in
// production, since `resolveReceiptPushEvent(ids, store)` takes the store as
// a parameter and only defaults to the real one.

function fakeEvent(overrides: Partial<AutomationEvent>): AutomationEvent {
    return {
        id: "evt-1",
        kind: "receipt-push",
        stage: null,
        status: "created",
        reason: null,
        source: null,
        vendor: null,
        projectName: null,
        docNumber: null,
        fileName: null,
        amountCents: null,
        taxCents: null,
        qbPurchaseId: null,
        driveFileId: null,
        detail: null,
        createdAt: new Date("2026-01-01"),
        ...overrides,
    } as AutomationEvent;
}

function emptyStore(overrides: Partial<ReceiptPushEventStore> = {}): ReceiptPushEventStore {
    return {
        findByDriveFileId: async () => [],
        findByQbPurchaseId: async () => [],
        countByDocNumber: async () => 0,
        findByDocNumber: async () => [],
        ...overrides,
    };
}

test("A1: driveFileId tier re-filters the `contains` prefilter to an exact match — a substring hit never confirms", async () => {
    // "file-ABC" is a substring of "file-ABCDEF"'s detail blob, so a naive
    // `detail: { contains }` query would return this row too — the exact bug
    // this fix closes.
    const decoy = fakeEvent({ id: "decoy", driveFileId: "file-ABCDEF", status: "created" });
    const store = emptyStore({ findByDriveFileId: async () => [decoy] });
    const result = await resolveReceiptPushEvent({ docNumber: null, driveFileId: "file-ABC", qbPurchaseId: null }, store);
    assert.equal(result.outcome, "not-found");
});

test("A1: driveFileId tier confirms only the row whose resolved fileId is an EXACT match", async () => {
    const decoy = fakeEvent({ id: "decoy", driveFileId: "file-ABCDEF", status: "created" });
    const real = fakeEvent({ id: "real", driveFileId: "file-ABC", status: "created", createdAt: new Date("2026-01-02") });
    const store = emptyStore({ findByDriveFileId: async () => [decoy, real] });
    const result = await resolveReceiptPushEvent({ docNumber: null, driveFileId: "file-ABC", qbPurchaseId: null }, store);
    assert.equal(result.outcome, "resolved");
    if (result.outcome === "resolved") {
        assert.equal(result.event.id, "real");
        assert.equal(result.confirmed, true);
        assert.equal(result.fullFileId, "file-ABC");
    }
});

test("A1: qbPurchaseId tier applies the same exact-match re-filter", async () => {
    const decoy = fakeEvent({ id: "decoy", qbPurchaseId: "PID-999", status: "created" });
    const store = emptyStore({ findByQbPurchaseId: async () => [decoy] });
    const result = await resolveReceiptPushEvent({ docNumber: null, driveFileId: null, qbPurchaseId: "PID-99" }, store);
    assert.equal(result.outcome, "not-found");
});

test("confidence propagation: driveFileId and qbPurchaseId tiers resolve confirmed:true", async () => {
    const byFile = fakeEvent({ id: "by-file", driveFileId: "file-1", status: "created" });
    const storeA = emptyStore({ findByDriveFileId: async () => [byFile] });
    const resultA = await resolveReceiptPushEvent({ docNumber: null, driveFileId: "file-1", qbPurchaseId: null }, storeA);
    assert.equal(resultA.outcome, "resolved");
    if (resultA.outcome === "resolved") assert.equal(resultA.confirmed, true);

    const byPurchase = fakeEvent({ id: "by-purchase", qbPurchaseId: "PID-1", status: "created" });
    const storeB = emptyStore({ findByQbPurchaseId: async () => [byPurchase] });
    const resultB = await resolveReceiptPushEvent({ docNumber: null, driveFileId: null, qbPurchaseId: "PID-1" }, storeB);
    assert.equal(resultB.outcome, "resolved");
    if (resultB.outcome === "resolved") assert.equal(resultB.confirmed, true);
});

test("confidence propagation: the bare docNumber-prefix tier always resolves confirmed:false", async () => {
    const legacy = fakeEvent({ id: "legacy", docNumber: "ABC123", status: "created" });
    const store = emptyStore({
        countByDocNumber: async () => 1,
        findByDocNumber: async () => [legacy],
    });
    const result = await resolveReceiptPushEvent({ docNumber: "ABC123", driveFileId: null, qbPurchaseId: null }, store);
    assert.equal(result.outcome, "resolved");
    if (result.outcome === "resolved") assert.equal(result.confirmed, false);
});

test("A6: docNumber tier counts first — over the cap fails closed as ambiguous (this is what the route turns into a 409) without ever fetching an arbitrary sample", async () => {
    let findByDocNumberCalled = false;
    const store = emptyStore({
        countByDocNumber: async () => 51,
        findByDocNumber: async () => {
            findByDocNumberCalled = true;
            return [fakeEvent({ docNumber: "ABC123" })];
        },
    });
    const result = await resolveReceiptPushEvent({ docNumber: "ABC123", driveFileId: null, qbPurchaseId: null }, store);
    assert.equal(result.outcome, "ambiguous");
    if (result.outcome === "ambiguous") assert.equal(result.candidateCount, 51);
    // Never sampled an arbitrary subset when we already know we can't safely
    // scan the whole set — that's the actual A6 defect (an unordered `take`
    // could omit one side of a real collision and never detect it).
    assert.equal(findByDocNumberCalled, false);
});

test("A6: docNumber tier detects a genuine collision when under the cap, using the COMPLETE candidate set", async () => {
    const one = fakeEvent({ id: "one", docNumber: "ABC123", driveFileId: "1AbCdEfGhIjKlMnOpQrStONE", status: "created" });
    const two = fakeEvent({ id: "two", docNumber: "ABC123", driveFileId: "1AbCdEfGhIjKlMnOpQrStTWO", status: "created" });
    const store = emptyStore({
        countByDocNumber: async () => 2,
        findByDocNumber: async () => [one, two],
    });
    const result = await resolveReceiptPushEvent({ docNumber: "ABC123", driveFileId: null, qbPurchaseId: null }, store);
    assert.equal(result.outcome, "ambiguous");
});

test("route 409 equivalence: any resolveReceiptPushEvent 'ambiguous' outcome is exactly what both API routes turn into a 409", async () => {
    // Documents the contract both /api/automation/ai-review and
    // /api/automation/verify rely on: they return 409 { reason:
    // 'ambiguous-match' } precisely when this resolver's outcome is
    // 'ambiguous' — never when it's 'resolved', confirmed or not.
    const decoyA = fakeEvent({ id: "a", docNumber: "XYZ", driveFileId: "1FileA-XYZ-Collision-One", status: "created" });
    const decoyB = fakeEvent({ id: "b", docNumber: "XYZ", driveFileId: "1FileB-XYZ-Collision-Two", status: "created" });
    const store = emptyStore({ countByDocNumber: async () => 2, findByDocNumber: async () => [decoyA, decoyB] });
    const result = await resolveReceiptPushEvent({ docNumber: "XYZ", driveFileId: null, qbPurchaseId: null }, store);
    assert.equal(result.outcome, "ambiguous");
});

// ── trustedQbPurchaseId — the A2/A3 fix's single choke point ────────────────
// Both /api/automation/ai-review (A2's Expense lookup) and
// /api/automation/verify (A3's live QBO query) must derive the qbPurchaseId
// they use ONLY from the resolved event — never from a second,
// independently client-supplied identifier that might name a different
// receipt. Structurally, this function can't be swayed by client input: it
// doesn't take any.

test("trustedQbPurchaseId reads only the resolved event's own qbPurchaseId (typed column)", () => {
    assert.equal(trustedQbPurchaseId({ qbPurchaseId: "PID-real", detail: null }), "PID-real");
});

test("trustedQbPurchaseId falls back to the resolved event's own detail JSON, never a second identifier", () => {
    assert.equal(trustedQbPurchaseId({ qbPurchaseId: null, detail: JSON.stringify({ qbPurchaseId: "PID-from-detail" }) }), "PID-from-detail");
});

test("A2/A3: a conflicting client-supplied qbPurchaseId cannot influence the resolved event's trusted id", () => {
    // Simulates the exact scenario: a client sends driveFileId (resolves
    // event A, whose own qbPurchaseId is "PID-A") and a conflicting
    // qbPurchaseId "PID-B" naming a different receipt. The route must derive
    // its QBO/Expense lookup id from event A alone.
    const resolvedEventA = { qbPurchaseId: "PID-A", detail: null };
    const clientSuppliedConflictingId = "PID-B";
    const idUsedForLookup = trustedQbPurchaseId(resolvedEventA);
    assert.equal(idUsedForLookup, "PID-A");
    assert.notEqual(idUsedForLookup, clientSuppliedConflictingId);
});

test("trustedQbPurchaseId returns null when the resolved event carries no qbPurchaseId anywhere", () => {
    assert.equal(trustedQbPurchaseId({ qbPurchaseId: null, detail: null }), null);
});
