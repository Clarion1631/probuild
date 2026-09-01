/**
 * Pipeline health verdict + digest formatting.
 *
 * The verdict is split out of the DB reads precisely so the freshness windows
 * are testable: the 48h/7d split is the part that is easy to get backwards,
 * and getting it backwards means either a daily false alarm or a silent dead
 * pipeline.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePipelineOk, formatPipelineDigest, type PipelineHealth } from "../src/lib/pipeline-health";

const NOW = Date.parse("2026-09-01T14:00:00.000Z");
const HOUR = 3_600_000;

const healthy = { intuit: { indicator: "none" }, stuck: 0, now: NOW };

test("fresh traffic with a clean Intuit status is OK, with no note", () => {
    const v = evaluatePipelineOk({ ...healthy, lastReceiptPushAt: new Date(NOW - 3 * HOUR) });
    assert.deepEqual(v, { ok: true });
});

test("a gap between 48h and 7d is NOT ok — traffic was flowing and stopped", () => {
    const v = evaluatePipelineOk({ ...healthy, lastReceiptPushAt: new Date(NOW - 72 * HOUR) });
    assert.equal(v.ok, false);
});

test("no pushes in 7d is ok WITH the note — a quiet week is quiet, not broken", () => {
    const v = evaluatePipelineOk({ ...healthy, lastReceiptPushAt: new Date(NOW - 8 * 24 * HOUR) });
    assert.deepEqual(v, { ok: true, note: "no receipts in 7d" });
});

test("no pushes ever is treated the same as a quiet week", () => {
    const v = evaluatePipelineOk({ ...healthy, lastReceiptPushAt: null });
    assert.deepEqual(v, { ok: true, note: "no receipts in 7d" });
});

test("an unreachable Intuit status page (unknown) does not by itself fail the check", () => {
    const v = evaluatePipelineOk({
        intuit: { indicator: "unknown" },
        stuck: 0,
        now: NOW,
        lastReceiptPushAt: new Date(NOW - HOUR),
    });
    assert.equal(v.ok, true);
});

test("a degraded Intuit indicator fails the check", () => {
    for (const indicator of ["minor", "major", "critical"]) {
        const v = evaluatePipelineOk({
            intuit: { indicator },
            stuck: 0,
            now: NOW,
            lastReceiptPushAt: new Date(NOW - HOUR),
        });
        assert.equal(v.ok, false, `${indicator} should fail`);
    }
});

test("any error in the last 24h fails the check, even on an otherwise quiet week", () => {
    const v = evaluatePipelineOk({
        intuit: { indicator: "none" },
        stuck: 1,
        now: NOW,
        lastReceiptPushAt: null,
    });
    // No note either: the note only ever accompanies an OK verdict.
    assert.deepEqual(v, { ok: false });
});

// ─── Digest formatting ─────────────────────────────────────────────────────

function sampleHealth(overrides: Partial<PipelineHealth> = {}): PipelineHealth {
    return {
        ok: true,
        checkedAt: "2026-09-01T14:00:00.000Z",
        intuit: { indicator: "none", description: "All Systems Operational" },
        qbo: {
            lastPurchaseSyncAt: "2026-09-01T10:00:00.000Z",
            lastReceiptPushAt: "2026-09-01T12:00:00.000Z",
        },
        receipts24h: { created: 4, fallback: 1 },
        bank: { lastPostedDate: "2026-08-29T00:00:00.000Z" },
        stuck: 0,
        ...overrides,
    };
}

test("digest subject says OK or NEEDS ATTENTION and leads the body", () => {
    const good = formatPipelineDigest(sampleHealth());
    assert.equal(good.subject, "Pipeline OK");
    assert.equal(good.text.split("\n")[0], "Pipeline OK");

    const bad = formatPipelineDigest(sampleHealth({ ok: false, stuck: 3 }));
    assert.equal(bad.subject, "Pipeline NEEDS ATTENTION");
    assert.equal(bad.text.split("\n")[0], "Pipeline NEEDS ATTENTION");
});

test("digest is plain text: one line per item, no markdown tables, no emoji", () => {
    const { text } = formatPipelineDigest(sampleHealth());
    assert.doesNotMatch(text, /\|/);
    assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    assert.match(text, /Intuit status: none \(All Systems Operational\)/);
    assert.match(text, /Receipts \(24h\): created 4, fallback 1/);
    assert.match(text, /Bank ledger through: 2026-08-29/);
    assert.match(text, /Automation errors \(24h, all kinds\): 0/);
});

test("digest renders missing timestamps as 'never' rather than a bogus date", () => {
    const { text } = formatPipelineDigest(
        sampleHealth({ qbo: { lastPurchaseSyncAt: null, lastReceiptPushAt: null } }),
    );
    assert.match(text, /Last QBO purchase sync: never/);
    assert.match(text, /Last receipt booked: never/);
});

test("digest reports zero receipt traffic as 'none', not an empty list", () => {
    const { text } = formatPipelineDigest(sampleHealth({ receipts24h: {} }));
    assert.match(text, /Receipts \(24h\): none/);
});

test("the quiet-week note is carried into the body", () => {
    const { text } = formatPipelineDigest(sampleHealth({ note: "no receipts in 7d" }));
    assert.match(text, /Note: no receipts in 7d/);
});
