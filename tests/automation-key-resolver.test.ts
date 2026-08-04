import assert from "node:assert/strict";
import test from "node:test";
import {
    pickPushEvent,
    resolvePushEventByDocNumberPrefix,
    readIdentifier,
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
