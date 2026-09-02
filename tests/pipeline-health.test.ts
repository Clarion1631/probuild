/**
 * Pipeline health verdict + digest formatting.
 *
 * The verdict is split out of the DB reads precisely so the rules are
 * testable. Two failure modes this file exists to prevent:
 *  - false green from a FAILED probe (an unreachable DB reading as "nothing
 *    wrong"), and
 *  - false green from a permanently dead pipeline (the old "no receipts in 7d
 *    is fine" auto-pass, which never expired).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    evaluatePipelineHealth,
    formatPipelineDigest,
    runProbe,
    BOOKED_PUSH_STATUSES,
    type PipelineHealth,
} from "../src/lib/pipeline-health";

const NOW = Date.parse("2026-09-01T14:00:00.000Z");
const HOUR = 3_600_000;

function iso(msAgo: number): string {
    return new Date(NOW - msAgo).toISOString();
}

function snapshot(overrides: Partial<Parameters<typeof evaluatePipelineHealth>[0]> = {}) {
    return {
        intuit: { status: "ok" as const, indicator: "none" },
        lastPurchaseSync: { status: "ok" as const, at: iso(2 * HOUR) },
        lastReceiptPush: { status: "ok" as const, at: iso(3 * HOUR) },
        lastPaymentsSync: { status: "ok" as const, at: iso(1 * HOUR) },
        receipts24h: { status: "ok" as const, counts: { created: 4 } },
        bank: { status: "ok" as const, at: iso(48 * HOUR) },
        stuck: { status: "ok" as const, count: 0 },
        now: NOW,
        ...overrides,
    };
}

test("a healthy snapshot is ok with no reasons", () => {
    assert.deepEqual(evaluatePipelineHealth(snapshot()), { ok: true, reasons: [] });
});

// ─── False green from a failed probe ────────────────────────────────────────

test("ANY failed probe forces ok:false with probe-failed:<name>", () => {
    const names = ["lastPurchaseSync", "lastReceiptPush", "lastPaymentsSync", "receipts24h", "bank", "stuck"] as const;
    for (const name of names) {
        const base = snapshot();
        const broken = {
            ...base,
            [name]: { ...(base[name] as object), status: "error" as const },
        } as Parameters<typeof evaluatePipelineHealth>[0];
        const v = evaluatePipelineHealth(broken);
        assert.equal(v.ok, false, `${name} failure must not read as healthy`);
        assert.ok(v.reasons.includes(`probe-failed:${name}`), `${name}: ${v.reasons.join(",")}`);
    }
});

test("a failed probe's fallback value never produces a SECOND, misleading reason", () => {
    // The stuck probe falls back to 0 and the push probe to null. Neither
    // fallback may be read as evidence — only the probe failure is reported.
    const v = evaluatePipelineHealth(
        snapshot({
            stuck: { status: "error", count: 0 },
            lastReceiptPush: { status: "error", at: null },
        }),
    );
    assert.deepEqual(v.reasons.sort(), ["probe-failed:lastReceiptPush", "probe-failed:stuck"]);
});

test("a total database outage reports every probe, still never ok", () => {
    const v = evaluatePipelineHealth(
        snapshot({
            lastPurchaseSync: { status: "error", at: null },
            lastReceiptPush: { status: "error", at: null },
            lastPaymentsSync: { status: "error", at: null },
            receipts24h: { status: "error", counts: {} },
            bank: { status: "error", at: null },
            stuck: { status: "error", count: 0 },
        }),
    );
    assert.equal(v.ok, false);
    assert.equal(v.reasons.length, 6);
});

// ─── Receipt staleness ──────────────────────────────────────────────────────

test("a push inside 72h is fresh", () => {
    const v = evaluatePipelineHealth(snapshot({ lastReceiptPush: { status: "ok", at: iso(71 * HOUR) } }));
    assert.deepEqual(v, { ok: true, reasons: [] });
});

test("nothing booked in over 72h is NOT ok — a silent pipeline no longer auto-greens", () => {
    const v = evaluatePipelineHealth(snapshot({ lastReceiptPush: { status: "ok", at: iso(73 * HOUR) } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["no-receipts-72h"]);
});

test("a very old push does not decay back into ok (the removed 7d auto-pass)", () => {
    for (const days of [8, 30, 400]) {
        const v = evaluatePipelineHealth(snapshot({ lastReceiptPush: { status: "ok", at: iso(days * 24 * HOUR) } }));
        assert.equal(v.ok, false, `${days}d of silence must not read as healthy`);
        assert.deepEqual(v.reasons, ["no-receipts-72h"]);
    }
});

test("no push ever recorded is stale, not healthy", () => {
    const v = evaluatePipelineHealth(snapshot({ lastReceiptPush: { status: "ok", at: null } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["no-receipts-72h"]);
});

// ─── Intuit + errors ────────────────────────────────────────────────────────

test("an unreachable Intuit status page does not by itself fail the check", () => {
    const v = evaluatePipelineHealth(snapshot({ intuit: { status: "error", indicator: "unknown" } }));
    assert.deepEqual(v, { ok: true, reasons: [] });
});

test("a degraded Intuit indicator fails the check and names the level", () => {
    for (const indicator of ["minor", "major", "critical"]) {
        const v = evaluatePipelineHealth(snapshot({ intuit: { status: "ok", indicator } }));
        assert.equal(v.ok, false);
        assert.deepEqual(v.reasons, [`intuit-${indicator}`]);
    }
});

test("any error in the last 24h fails the check and reports the count", () => {
    const v = evaluatePipelineHealth(snapshot({ stuck: { status: "ok", count: 3 } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["errors-24h:3"]);
});

test("multiple independent failures all appear", () => {
    const v = evaluatePipelineHealth(
        snapshot({
            intuit: { status: "ok", indicator: "major" },
            stuck: { status: "ok", count: 2 },
            lastReceiptPush: { status: "ok", at: iso(100 * HOUR) },
            bank: { status: "error", at: null },
        }),
    );
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons.sort(), [
        "errors-24h:2",
        "intuit-major",
        "no-receipts-72h",
        "probe-failed:bank",
    ]);
});

// ─── Digest formatting ─────────────────────────────────────────────────────

function sampleHealth(overrides: Partial<PipelineHealth> = {}): PipelineHealth {
    return {
        ok: true,
        reasons: [],
        checkedAt: "2026-09-01T14:00:00.000Z",
        intuit: { status: "ok", indicator: "none", description: "All Systems Operational" },
        qbo: {
            lastPurchaseSync: { status: "ok", at: "2026-09-01T10:00:00.000Z" },
            lastReceiptPush: { status: "ok", at: "2026-09-01T12:00:00.000Z" },
            lastPaymentsSync: { status: "ok", at: "2026-09-01T13:00:00.000Z" },
        },
        receipts24h: { status: "ok", counts: { created: 4, fallback: 1 } },
        bank: { status: "ok", at: "2026-08-29T00:00:00.000Z" },
        stuck: { status: "ok", count: 0 },
        ...overrides,
    };
}

test("digest subject says OK or NEEDS ATTENTION and leads the body", () => {
    const good = formatPipelineDigest(sampleHealth());
    assert.equal(good.subject, "Pipeline OK");
    assert.equal(good.text.split("\n")[0], "Pipeline OK");

    const bad = formatPipelineDigest(sampleHealth({ ok: false, reasons: ["errors-24h:3"] }));
    assert.equal(bad.subject, "Pipeline NEEDS ATTENTION");
    assert.equal(bad.text.split("\n")[0], "Pipeline NEEDS ATTENTION");
    assert.match(bad.text, /Needs attention: errors-24h:3/);
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

test("digest says how long the silence has been, so a human can judge it", () => {
    const { text } = formatPipelineDigest(
        sampleHealth({
            ok: false,
            reasons: ["no-receipts-72h"],
            qbo: {
                lastPurchaseSync: { status: "ok", at: "2026-08-20T14:00:00.000Z" },
                lastReceiptPush: { status: "ok", at: "2026-08-20T14:00:00.000Z" },
                lastPaymentsSync: { status: "ok", at: "2026-09-01T13:00:00.000Z" },
            },
        }),
    );
    assert.match(text, /Last receipt booked: .* \(12d ago\)/);
});

test("a failed probe reads as unavailable in the digest, never as a real value", () => {
    const { text } = formatPipelineDigest(
        sampleHealth({
            ok: false,
            reasons: ["probe-failed:stuck", "probe-failed:bank", "probe-failed:receipts24h"],
            receipts24h: { status: "error", counts: {} },
            bank: { status: "error", at: null },
            stuck: { status: "error", count: 0 },
        }),
    );
    assert.match(text, /Receipts \(24h\): unavailable \(probe failed\)/);
    assert.match(text, /Bank ledger through: unavailable \(probe failed\)/);
    // The 0 fallback must NOT be printed as a real "0 errors" all-clear.
    assert.match(text, /Automation errors \(24h, all kinds\): unavailable \(probe failed\)/);
    assert.doesNotMatch(text, /Automation errors \(24h, all kinds\): 0/);
});

test("an unreachable Intuit status page is flagged in the body", () => {
    const { text } = formatPipelineDigest(
        sampleHealth({ intuit: { status: "error", indicator: "unknown" } }),
    );
    assert.match(text, /Intuit status: unknown \[status page unreachable\]/);
});

test("digest renders missing timestamps as 'never' rather than a bogus date", () => {
    const { text } = formatPipelineDigest(
        sampleHealth({
            qbo: {
                lastPurchaseSync: { status: "ok", at: null },
                lastReceiptPush: { status: "ok", at: null },
                lastPaymentsSync: { status: "ok", at: null },
            },
        }),
    );
    assert.match(text, /Last QBO purchase sync: never/);
    assert.match(text, /Last receipt booked: never/);
});

test("digest reports zero receipt traffic as 'none', not an empty list", () => {
    const { text } = formatPipelineDigest(sampleHealth({ receipts24h: { status: "ok", counts: {} } }));
    assert.match(text, /Receipts \(24h\): none/);
});


// ─── Probe deadlines ────────────────────────────────────────────────────────

test("a probe that never settles is reported as a timeout, not left hanging", async () => {
    // Prisma has no statement timeout here, so a wedged database used to hang
    // the whole health check until the platform killed it — for a cron that
    // means a silent morning with no digest at all.
    const started = Date.now();
    const result = await runProbe("wedged", () => new Promise<number>(() => {}), -1, 50);
    assert.deepEqual(result, { status: "error", reason: "timeout", value: -1 });
    assert.ok(Date.now() - started < 2_000, "must return on its own deadline");
});

test("a probe that resolves in time reports ok with its value", async () => {
    const result = await runProbe("fast", async () => 42, -1, 1_000);
    assert.deepEqual(result, { status: "ok", value: 42 });
});

test("a throwing probe is an error with reason 'error', distinct from a timeout", async () => {
    const result = await runProbe("boom", async () => { throw new Error("db down"); }, -1, 1_000);
    assert.deepEqual(result, { status: "error", reason: "error", value: -1 });
});

test("a timed-out probe still forces ok:false through the verdict", async () => {
    const timedOut = await runProbe("stuck", () => new Promise<number>(() => {}), 0, 20);
    const v = evaluatePipelineHealth(snapshot({ stuck: { status: timedOut.status, reason: timedOut.reason, count: timedOut.value } }));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("probe-failed:stuck"));
});


// ─── What counts as "booked" ────────────────────────────────────────────────

test("only a CREATE refreshes the last-booked clock — a re-push does not", () => {
    // "already-exists" is an idempotent re-push of a receipt created earlier,
    // so counting it kept the freshness clock alive with no new receipt in the
    // books: a bot stuck retrying one old file looked like a healthy pipeline.
    assert.deepEqual(BOOKED_PUSH_STATUSES, ["created"]);
    assert.equal(BOOKED_PUSH_STATUSES.includes("already-exists"), false);
    assert.equal(BOOKED_PUSH_STATUSES.includes("fallback"), false);
    assert.equal(BOOKED_PUSH_STATUSES.includes("error"), false);
});


// ─── The payments rail is part of the pulse ─────────────────────────────────

test("a payments-sync outage turns the verdict RED", async () => {
    const { PAYMENTS_SYNC_EVENT_KIND } = await import("../src/lib/pipeline-health");
    const { QBO_PAYMENTS_SYNC_EVENT_KIND } = await import("../src/lib/quickbooks-payments");
    // The health check and the cron must agree on the event kind, or the
    // outage is written to a row nothing reads.
    assert.equal(PAYMENTS_SYNC_EVENT_KIND, QBO_PAYMENTS_SYNC_EVENT_KIND);

    // The cron writes status "error" on an aborted run; `stuck` counts errors
    // of ANY kind in 24h, so the digest goes red on the money rail too.
    const v = evaluatePipelineHealth(snapshot({ stuck: { status: "ok", count: 1 } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["errors-24h:1"]);
});

test("a payments-sync probe failure is its own reason", () => {
    const v = evaluatePipelineHealth(snapshot({ lastPaymentsSync: { status: "error", reason: "timeout", at: null } }));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("probe-failed:lastPaymentsSync"));
});

test("the digest reports the payments rail alongside the receipt rail", () => {
    const { text } = formatPipelineDigest(sampleHealth());
    assert.match(text, /Last payments sync: /);
});
