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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path, { dirname, join } from "node:path";
import {
    evaluatePipelineHealth,
    formatPipelineDigest,
    runProbe,
    createLimiter,
    statementTimeoutRunner,
    PROBE_CONCURRENCY,
    BOOKED_PUSH_STATUSES,
    type PipelineHealth,
    INTAKE_STUCK_HOURS,
    CHASER_STALE_HOURS,
    INTAKE_STAGING_STUCK_MINUTES,
    type ProbeRunner,
} from "../src/lib/pipeline-health";

const NOW = Date.parse("2026-09-01T14:00:00.000Z");

/**
 * The probe runner, without a database.
 *
 * Production hands each probe a transaction client carrying a server-side
 * statement timeout; these tests are about the DEADLINE and the CONCURRENCY,
 * so they inject a pass-through rather than a Postgres.
 */
const passThrough: ProbeRunner = <T,>(_ms: number, fn: (db: any) => Promise<T>) => fn({} as any);
const HOUR = 3_600_000;

function iso(msAgo: number): string {
    return new Date(NOW - msAgo).toISOString();
}

function snapshot(overrides: Partial<Parameters<typeof evaluatePipelineHealth>[0]> = {}) {
    return {
        intuit: { status: "ok" as const, indicator: "none" },
        lastPurchaseSync: { status: "ok" as const, at: iso(2 * HOUR) },
        purchaseSyncRun: { status: "ok" as const, at: iso(2 * HOUR), runStatus: "ok" as string | null },
        lastReceiptPush: { status: "ok" as const, at: iso(3 * HOUR) },
        lastPaymentsSync: { status: "ok" as const, at: iso(1 * HOUR) },
        receipts24h: { status: "ok" as const, counts: { created: 4 } },
        bank: { status: "ok" as const, at: iso(48 * HOUR) },
        stuck: { status: "ok" as const, count: 0 },
        intakeStuck: { status: "ok" as const, count: 0 },
        intakeNeedsReview: { status: "ok" as const, count: 0 },
        intakeUnassigned: { status: "ok" as const, count: 0 },
        uncertainCards: { status: "ok" as const, count: 0 },
        // A connected Drive is the normal state; the memo path needs it.
        driveCredentials: { status: "ok" as const, configured: true, source: "company-settings" },
        // A chase that finished an hour ago is the normal state.
        chaser: { status: "ok" as const, phase: "done", completedAt: iso(1 * HOUR) },
        // The nightly QBO pull is OFF by default, so it contributes no reason.
        bankPull: { status: "ok" as const, enabled: false, lastSuccessAt: null, ambiguousCount: 0 },
        intakeQuarantined: { status: "ok" as const, count: 0 },
        payLinksPending: { status: "ok" as const, count: 0 },
        now: NOW,
        ...overrides,
    };
}

test("a healthy snapshot is ok with no reasons", () => {
    assert.deepEqual(evaluatePipelineHealth(snapshot()), { ok: true, reasons: [] });
});

// ─── False green from a failed probe ────────────────────────────────────────

test("ANY failed probe forces ok:false with probe-failed:<name>", () => {
    const names = ["lastPurchaseSync", "purchaseSyncRun", "lastReceiptPush", "lastPaymentsSync", "receipts24h", "bank", "stuck", "payLinksPending"] as const;
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

test("an unreachable Intuit status page FAILS the check", () => {
    // Reversed deliberately (accepted tradeoff): a statuspage.io hiccup will
    // occasionally produce a red digest. The alternative is a monitoring
    // surface that quietly knows less than it claims - "we could not check"
    // is not "everything is fine".
    const v = evaluatePipelineHealth(snapshot({ intuit: { status: "error", indicator: "unknown" } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["intuit-status-unreachable"]);
});

test("a reachable status page reporting 'none' is still clean", () => {
    const v = evaluatePipelineHealth(snapshot({ intuit: { status: "ok", indicator: "none" } }));
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

// ─── Pay links that were never written ─────────────────────────────────────

test("a milestone linked in QuickBooks with no pay link makes health red", () => {
    // The maintenance sweep can report `ok: true` and still leave one of these
    // behind — a bill the client cannot pay. Health measures it directly rather
    // than taking that sweep's word for it, so a maintenance run that never
    // happened cannot read as health either.
    const v = evaluatePipelineHealth(snapshot({ payLinksPending: { status: "ok", count: 2 } }));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("pay-links-pending:2"), v.reasons.join(","));
});

test("no pending pay links adds no reason", () => {
    const v = evaluatePipelineHealth(snapshot({ payLinksPending: { status: "ok", count: 0 } }));
    assert.deepEqual(v, { ok: true, reasons: [] });
});

test("a FAILED pay-link probe reports the probe, not a count of zero", () => {
    const v = evaluatePipelineHealth(snapshot({ payLinksPending: { status: "error", count: 0 } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["probe-failed:payLinksPending"], "the 0 fallback is not evidence");
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
            purchaseSyncRun: { status: "ok", at: "2026-09-01T10:00:00.000Z" },
            lastReceiptPush: { status: "ok", at: "2026-09-01T12:00:00.000Z" },
            lastPaymentsSync: { status: "ok", at: "2026-09-01T13:00:00.000Z" },
        },
        receipts24h: { status: "ok", counts: { created: 4, fallback: 1 } },
        bank: { status: "ok", at: "2026-08-29T00:00:00.000Z" },
        stuck: { status: "ok", count: 0 },
        intake: {
            stuck: { status: "ok", count: 0 },
            needsReview: { status: "ok", count: 0 },
            unassigned: { status: "ok", count: 0 },
            quarantined: { status: "ok", count: 0 },
        },
        payLinksPending: { status: "ok" as const, count: 0 },
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
    assert.match(text, /Statement ledger through: 2026-08-29/);
    assert.match(text, /Automation errors \(24h, all kinds\): 0/);
});

test("digest says how long the silence has been, so a human can judge it", () => {
    const { text } = formatPipelineDigest(
        sampleHealth({
            ok: false,
            reasons: ["no-receipts-72h"],
            qbo: {
                lastPurchaseSync: { status: "ok", at: "2026-08-20T14:00:00.000Z" },
                purchaseSyncRun: { status: "ok", at: "2026-09-01T13:00:00.000Z" },
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
    assert.match(text, /Statement ledger through: unavailable \(probe failed\)/);
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
                purchaseSyncRun: { status: "ok", at: null },
                lastReceiptPush: { status: "ok", at: null },
                lastPaymentsSync: { status: "ok", at: null },
            },
        }),
    );
    assert.match(text, /Last QBO purchase booked: never/);
    assert.match(text, /Last purchase sync run: never/);
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
    const result = await runProbe("wedged", () => new Promise<number>(() => {}), -1, 50, { withDb: passThrough });
    assert.deepEqual(result, { status: "error", reason: "timeout", value: -1 });
    assert.ok(Date.now() - started < 2_000, "must return on its own deadline");
});

test("a probe that resolves in time reports ok with its value", async () => {
    const result = await runProbe("fast", async () => 42, -1, 1_000, { withDb: passThrough });
    assert.deepEqual(result, { status: "ok", value: 42 });
});

test("a throwing probe is an error with reason 'error', distinct from a timeout", async () => {
    const result = await runProbe("boom", async () => { throw new Error("db down"); }, -1, 1_000, { withDb: passThrough });
    assert.deepEqual(result, { status: "error", reason: "error", value: -1 });
});

test("a timed-out probe still forces ok:false through the verdict", async () => {
    const timedOut = await runProbe("stuck", () => new Promise<number>(() => {}), 0, 20, { withDb: passThrough });
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


// --- The payments heartbeat must be able to go red ---

test("a null payments heartbeat is NOT ok - the hourly cron has never reported", () => {
    const v = evaluatePipelineHealth(snapshot({ lastPaymentsSync: { status: "ok", at: null } }));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("payments-sync-stale"));
});

test("a payments heartbeat older than 26h is stale", () => {
    const fresh = evaluatePipelineHealth(snapshot({ lastPaymentsSync: { status: "ok", at: iso(25 * HOUR) } }));
    assert.deepEqual(fresh, { ok: true, reasons: [] });

    const stale = evaluatePipelineHealth(snapshot({ lastPaymentsSync: { status: "ok", at: iso(27 * HOUR) } }));
    assert.equal(stale.ok, false);
    assert.deepEqual(stale.reasons, ["payments-sync-stale"]);
});

test("a weeks-old payments heartbeat never decays back into ok", () => {
    for (const days of [3, 30, 400]) {
        const v = evaluatePipelineHealth(snapshot({ lastPaymentsSync: { status: "ok", at: iso(days * 24 * HOUR) } }));
        assert.equal(v.ok, false, `${days}d`);
        assert.ok(v.reasons.includes("payments-sync-stale"));
    }
});

test("only a CRON-sourced run counts as the heartbeat", async () => {
    const { PAYMENTS_SYNC_CRON_SOURCE, PAYMENTS_SYNC_STALE_HOURS } = await import("../src/lib/pipeline-health");
    // On-view and manual refreshes write their own source precisely so they
    // cannot stand in for an hourly job that has stopped running.
    assert.equal(PAYMENTS_SYNC_CRON_SOURCE, "cron");
    assert.equal(PAYMENTS_SYNC_STALE_HOURS, 26);
});


// --- Lost-response recovery must be able to advance the clock ---

test("a recovery that actually uploaded the file counts as a booking", async () => {
    const { BOOKED_PUSH_STATUSES, RECOVERED_BOOKING_DETAIL } = await import("../src/lib/pipeline-health");

    // A plain re-push still must not reset the clock...
    assert.deepEqual(BOOKED_PUSH_STATUSES, ["created"]);

    // ...but when the FIRST attempt's response was lost after QBO committed
    // the Purchase, no "created" event exists at all and the recovery pass is
    // the only record of that booking. It is recognised by having genuinely
    // uploaded the attachment.
    assert.equal(RECOVERED_BOOKING_DETAIL, '"attachment":"attached"');

    const detailOf = (attachment: string) => JSON.stringify({ fileId: "f1", qbPurchaseId: "99", attachment });
    assert.ok(detailOf("attached").includes(RECOVERED_BOOKING_DETAIL));
    // The ordinary retries must NOT match: they attached nothing new.
    assert.equal(detailOf("already-attached").includes(RECOVERED_BOOKING_DETAIL), false);
    assert.equal(detailOf("skipped").includes(RECOVERED_BOOKING_DETAIL), false);
    assert.equal(detailOf("failed:400").includes(RECOVERED_BOOKING_DETAIL), false);
});


// --- A partial run must not hide behind the 26h window ---

test("the latest run being PARTIAL is reported immediately, not in 26h", async () => {
    const { PAYMENTS_SYNC_HEARTBEAT_STATUSES } = await import("../src/lib/pipeline-health");
    // Codex gate: health read only the last "ok" event and counted only
    // "error" ones, so repeated hourly partial runs could leave the digest
    // green for up to 26 hours - or until the next day's digest.
    assert.deepEqual(PAYMENTS_SYNC_HEARTBEAT_STATUSES, ["ok", "partial"]);

    const v = evaluatePipelineHealth(snapshot({
        lastPaymentsSync: { status: "ok", at: iso(1 * HOUR), runStatus: "partial" },
    }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["payments-sync-partial"]);
});

test("a partial run still counts as a heartbeat, so it is not ALSO stale", () => {
    const v = evaluatePipelineHealth(snapshot({
        lastPaymentsSync: { status: "ok", at: iso(1 * HOUR), runStatus: "partial" },
    }));
    assert.equal(v.reasons.includes("payments-sync-stale"), false);
});

test("a stale partial run reports staleness, not double-reasons", () => {
    const v = evaluatePipelineHealth(snapshot({
        lastPaymentsSync: { status: "ok", at: iso(40 * HOUR), runStatus: "partial" },
    }));
    assert.deepEqual(v.reasons, ["payments-sync-stale"]);
});

test("an ok run reports nothing", () => {
    const v = evaluatePipelineHealth(snapshot({
        lastPaymentsSync: { status: "ok", at: iso(1 * HOUR), runStatus: "ok" },
    }));
    assert.deepEqual(v, { ok: true, reasons: [] });
});

test("the digest flags an incomplete payments run in the body", () => {
    const { text } = formatPipelineDigest(sampleHealth({
        ok: false,
        reasons: ["payments-sync-partial"],
        qbo: {
            lastPurchaseSync: { status: "ok", at: "2026-09-01T10:00:00.000Z" },
            purchaseSyncRun: { status: "ok", at: "2026-09-01T10:00:00.000Z" },
            lastReceiptPush: { status: "ok", at: "2026-09-01T12:00:00.000Z" },
            lastPaymentsSync: { status: "ok", at: "2026-09-01T13:00:00.000Z", runStatus: "partial" },
        },
    }));
    assert.match(text, /Last payments sync: .*\[incomplete run\]/);
    assert.match(text, /Needs attention: payments-sync-partial/);
});


// --- The latest failed run is never hidden ---

test("payments-sync-error fires when the LATEST event is an error, at any age", () => {
    // Codex gate: the heartbeat query excluded "error", so an error right after
    // a good run was invisible; health then leaned on a 24h error count while
    // staleness used 26h, leaving a two-hour green window (or forever, if the
    // cron then stopped entirely).
    const justNow = evaluatePipelineHealth(snapshot({
        lastPaymentsSync: { status: "ok", at: iso(1 * HOUR), runStatus: "error" },
    }));
    assert.equal(justNow.ok, false);
    assert.deepEqual(justNow.reasons, ["payments-sync-error"]);

    // Older than the 24h `stuck` window, still red.
    const old = evaluatePipelineHealth(snapshot({
        lastPaymentsSync: { status: "ok", at: iso(25 * HOUR), runStatus: "error" },
    }));
    assert.equal(old.ok, false);
    assert.deepEqual(old.reasons, ["payments-sync-error"]);
});

test("staleness still outranks the latest-run status", () => {
    const v = evaluatePipelineHealth(snapshot({
        lastPaymentsSync: { status: "ok", at: iso(40 * HOUR), runStatus: "error" },
    }));
    assert.deepEqual(v.reasons, ["payments-sync-stale"]);
});

test("the digest marks a failed last payments run", () => {
    const { text } = formatPipelineDigest(sampleHealth({
        ok: false,
        reasons: ["payments-sync-error"],
        qbo: {
            lastPurchaseSync: { status: "ok", at: "2026-09-01T10:00:00.000Z" },
            purchaseSyncRun: { status: "ok", at: "2026-09-01T10:00:00.000Z" },
            lastReceiptPush: { status: "ok", at: "2026-09-01T12:00:00.000Z" },
            lastPaymentsSync: { status: "ok", at: "2026-09-01T13:00:00.000Z", runStatus: "error" },
        },
    }));
    assert.match(text, /Last payments sync: .*\[last run FAILED\]/);
});

// --- A booking with no receipt is not a fresh receipt ---

test("attachment-failed is not a booking for freshness purposes", async () => {
    const { ATTACHMENT_FAILED_STATUS, BOOKED_PUSH_STATUSES } = await import("../src/lib/pipeline-health");
    const route = await import("../src/app/api/integrations/qbo-receipts/create/route");

    // The route and the health check must agree on the marker, or the signal
    // is written somewhere nothing reads.
    assert.equal(route.ATTACHMENT_FAILED_STATUS, ATTACHMENT_FAILED_STATUS);
    assert.equal(ATTACHMENT_FAILED_STATUS, "attachment-failed");
    // Codex gate: a Purchase booked with no receipt used to log "created" and
    // count as a perfectly healthy, fresh booking.
    assert.equal(BOOKED_PUSH_STATUSES.includes(ATTACHMENT_FAILED_STATUS), false);
});

test("only a stored receipt counts as an attached booking", async () => {
    const { attachmentSucceeded } = await import("../src/app/api/integrations/qbo-receipts/create/route");
    assert.equal(attachmentSucceeded("attached"), true);
    assert.equal(attachmentSucceeded("already-attached"), true);
    for (const bad of ["skipped", "failed:400", "failed:fault", undefined]) {
        assert.equal(attachmentSucceeded(bad), false, String(bad));
    }
});


// --- attachment-failed must make health unhealthy, now ---

test("an attachment-failed receipt is counted as stuck and turns the digest red", async () => {
    const { ATTACHMENT_FAILED_STATUS } = await import("../src/lib/pipeline-health");
    // Codex gate: the route recorded attachment-failed but `stuck` only
    // matched literal "error", so another good receipt inside 72h left the
    // subject line reading "Pipeline OK" while a Purchase sat in QuickBooks
    // with no receipt attached.
    assert.equal(ATTACHMENT_FAILED_STATUS, "attachment-failed");

    // `stuck` is the count the health check receives; a non-zero value is red
    // regardless of how fresh the rest of the pipeline looks.
    const v = evaluatePipelineHealth(snapshot({ stuck: { status: "ok", count: 1 } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["errors-24h:1"]);

    const { subject } = formatPipelineDigest(sampleHealth({ ok: false, reasons: ["errors-24h:1"], stuck: { status: "ok", count: 1 } }));
    assert.equal(subject, "Pipeline NEEDS ATTENTION");
});

test("the journey mapper renders attachment-failed as failed, not in-flight", async () => {
    const { groupEventsIntoJourneys } = await import("../src/lib/automation-events");
    const journeys = groupEventsIntoJourneys([
        {
            id: "e1", kind: "receipt-push", stage: null, status: "attachment-failed",
            reason: "failed:fault", source: "apps-script", vendor: "Home Depot",
            projectName: "Mueller Remodel", docNumber: "1AbCdEfGhIjKlMnOpQrSt",
            fileName: "receipt.jpg", amountCents: 15000, taxCents: null,
            qbPurchaseId: "99", driveFileId: "1AbCdEfGhIjKlMnOpQrStUv",
            detail: null, createdAt: new Date("2026-09-01T12:00:00Z"),
        },
    ]);
    const journey = [...journeys.values()][0];
    // "in-flight" reads as "still working on it" for a receipt that is never
    // arriving - the bot has already stopped.
    assert.equal(journey.finalState, "error");
    assert.equal(journey.finalReason, "failed:fault");
});

// ── Receipt Pipeline v2 intake queue ───────────────────────────────────────
// Every other probe in this file reads AutomationEvent, which only records a
// BOOKING — so a v2 row that never reaches QuickBooks is invisible to all of
// them. A jammed intake queue reported a perfectly healthy pipeline.

test("rows stuck in the intake queue fail the check and name the backlog", () => {
    const v = evaluatePipelineHealth(snapshot({
        intakeStuck: { status: "ok", count: 4 },
        intakeNeedsReview: { status: "ok", count: 11 },
    }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["intake-stuck:4,needs-review:11"]);
});

test("a NEEDS_REVIEW backlog alone is NOT a failure", () => {
    // Those rows are working as designed — a human was asked a question.
    // Failing on them would hold the pipeline red until somebody cleared the
    // queue, which trains everyone to ignore the signal.
    const v = evaluatePipelineHealth(snapshot({ intakeNeedsReview: { status: "ok", count: 40 } }));
    assert.deepEqual(v, { ok: true, reasons: [] });
});

test("receipts nobody assigned a job to are an ALERT, not a green backlog", () => {
    // NEEDS_JOB is terminal for the worker, so it can pile up indefinitely
    // while every other probe reads green. Its own reason, because the fix is
    // different: assign a project, not restart a worker.
    const v = evaluatePipelineHealth(snapshot({ intakeUnassigned: { status: "ok", count: 5 } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["intake-unassigned:5"]);
});

test("stuck and unassigned are reported separately", () => {
    const v = evaluatePipelineHealth(snapshot({
        intakeStuck: { status: "ok", count: 2 },
        intakeUnassigned: { status: "ok", count: 3 },
    }));
    assert.ok(v.reasons.some(r => r.startsWith("intake-stuck:2")));
    assert.ok(v.reasons.includes("intake-unassigned:3"));
});

test("QUARANTINED cutover rows are counted, and get their own reason", () => {
    // SHADOW_QUARANTINE is terminal, never auto-requeued, and NOBODY has
    // booked it: v1 stopped, and v2 refused because there is no shared QBO
    // identity to make a second booking idempotent. It is neither NEEDS_REVIEW
    // nor NEEDS_JOB, so before this it was invisible to every probe here and a
    // pile of unbooked expenses read as a healthy pipeline.
    const v = evaluatePipelineHealth(snapshot({ intakeQuarantined: { status: "ok", count: 3 } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["receipt-quarantine:3"]);
});

test("the quarantine reason is separate from review and unassigned", () => {
    // Three different actions: check QuickBooks and decide, clear a review
    // item, assign a job. Folding them into one number hides two of them.
    const v = evaluatePipelineHealth(snapshot({
        intakeUnassigned: { status: "ok", count: 2 },
        intakeQuarantined: { status: "ok", count: 4 },
    }));
    assert.ok(v.reasons.includes("intake-unassigned:2"));
    assert.ok(v.reasons.includes("receipt-quarantine:4"));
});

test("CONTROL: a NEEDS_REVIEW backlog does not produce a quarantine reason", () => {
    // Without this, a count that accidentally selected every parked state
    // would still pass the test above.
    const v = evaluatePipelineHealth(snapshot({ intakeNeedsReview: { status: "ok", count: 40 } }));
    assert.deepEqual(v.reasons, []);
});

test("an intake probe that FAILED is not an intake probe that found nothing", () => {
    for (const name of ["intakeStuck", "intakeNeedsReview", "intakeUnassigned", "intakeQuarantined"] as const) {
        const v = evaluatePipelineHealth(snapshot({ [name]: { status: "error", reason: "timeout", count: 0 } }));
        assert.equal(v.ok, false, name);
        assert.ok(v.reasons.includes(`probe-failed:${name}`), name);
    }
});

test("the stuck reason survives a failed backlog probe rather than lying about it", () => {
    const v = evaluatePipelineHealth(snapshot({
        intakeStuck: { status: "ok", count: 2 },
        intakeNeedsReview: { status: "error", reason: "error", count: 0 },
    }));
    assert.ok(v.reasons.includes("intake-stuck:2"), "no invented needs-review count");
    assert.ok(v.reasons.includes("probe-failed:intakeNeedsReview"));
});

test("STAGING gets a much shorter fuse than the working states", () => {
    // STAGING is meant to last one HTTP request; RECEIVED/BOOKING/READ are
    // queue states measured in hours.
    assert.equal(INTAKE_STAGING_STUCK_MINUTES, 30);
    assert.equal(INTAKE_STUCK_HOURS, 6);
    assert.ok(INTAKE_STAGING_STUCK_MINUTES * 60_000 < INTAKE_STUCK_HOURS * 3_600_000);
});

// ── A STAGING row's own upload lease, not just its age (Codex round-17 item 5) ──

test("a STAGING row is not counted as stuck while its own upload lease is still live", () => {
    // The count() query talks to real Prisma, so this is a source-level pin
    // (same technique receipt-url.test.ts and receipt-intake-stored-object.
    // test.ts use for the properties a live DB is needed to exercise for
    // real): the STAGING branch of intakeStuck must gate on the lease, not
    // on createdAt alone, or a client mid-upload on a slow connection —
    // whose /start re-issued a signed URL without touching createdAt — reads
    // as "stuck" while its own link is still perfectly good.
    const root = path.resolve(__dirname, "..");
    const src = readFileSync(path.join(root, "src/lib/pipeline-health.ts"), "utf8");
    const stagingBranch = src.slice(
        src.indexOf('state: "STAGING"'),
        src.indexOf('state: "READ"'),
    );
    assert.match(
        stagingBranch,
        /uploadUrlExpiresAt/,
        "the STAGING stuck-count must consult the upload lease, not createdAt alone",
    );
});

test("the quarantine PROBE actually counts SHADOW_QUARANTINE, with no age gate", () => {
    // Same source-level pin as the STAGING test above, for the same reason:
    // count() talks to real Prisma. Two properties, and both matter — the
    // state it selects, and that it does NOT carry a createdAt threshold. A
    // quarantined row is terminal the instant the cutover writes it, so an
    // age gate copied from the NEEDS_JOB probe next door would hide every one
    // of them for six hours for no reason.
    const root = path.resolve(__dirname, "..");
    const src = readFileSync(path.join(root, "src/lib/pipeline-health.ts"), "utf8");
    // Anchored on the probe DECLARATION, not on the name — the name also
    // appears in namedProbes above, and slicing from there would read the
    // whole evaluator and pass on any mention of the state anywhere.
    const declared = /probe<number>\(\r?\n\s*"intakeQuarantined",([\s\S]*?)\r?\n\s*\),/.exec(src);
    assert.ok(declared, "the probe exists");
    const branch = declared[1];
    assert.match(branch, /state: "SHADOW_QUARANTINE"/);
    assert.ok(!branch.includes("createdAt"), "no age threshold on a terminal state");
    // And it is a REASON, not just a printed number.
    assert.match(src, /receipt-quarantine:\$\{input\.intakeQuarantined\.count\}/);
});

test("the digest prints all four intake numbers", () => {
    const { text } = formatPipelineDigest(sampleHealth({
        intake: {
            stuck: { status: "ok", count: 3 },
            needsReview: { status: "ok", count: 7 },
            unassigned: { status: "ok", count: 2 },
            quarantined: { status: "ok", count: 5 },
        },
    }));
    assert.match(text, /Receipt intake stuck >6h: 3/);
    assert.match(text, /Receipt intake awaiting review: 7/);
    assert.match(text, /Receipt intake awaiting a job \(>6h\): 2/);
    // SHADOW_QUARANTINE rows are terminal and unbooked, and no other line here
    // can see them: before this they were invisible to the whole digest.
    assert.match(text, /Receipt intake quarantined \(cutover, needs a decision\): 5/);
});

test("the digest says a failed intake probe is unavailable, never zero", () => {
    const { text } = formatPipelineDigest(sampleHealth({
        intake: {
            stuck: { status: "error", reason: "timeout", count: 0 },
            needsReview: { status: "error", reason: "timeout", count: 0 },
            unassigned: { status: "error", reason: "timeout", count: 0 },
            quarantined: { status: "error", reason: "timeout", count: 0 },
        },
    }));
    assert.match(text, /Receipt intake stuck >6h: unavailable \(probe failed\)/);
    assert.match(text, /Receipt intake awaiting review: unavailable \(probe failed\)/);
    assert.match(text, /Receipt intake quarantined \(cutover, needs a decision\): unavailable \(probe failed\)/);
});

// ─── A refused credential names its own fix ─────────────────────────────────

test("a QuickBooks auth refusal reads as reconnect-needed, not a generic error", () => {
    // "Automation errors (24h): 3" does not tell anyone to reconnect
    // QuickBooks, and nothing in this pipeline fixes itself less on its own.
    const verdict = evaluatePipelineHealth(snapshot({ qboAuth: { status: "ok", count: 2 } }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.includes("quickbooks-reconnect-needed"), verdict.reasons.join(","));

    // Zero is silent, and an absent probe (older snapshot) changes nothing.
    assert.deepEqual(evaluatePipelineHealth(snapshot({ qboAuth: { status: "ok", count: 0 } })), { ok: true, reasons: [] });
    assert.deepEqual(evaluatePipelineHealth(snapshot()), { ok: true, reasons: [] });

    // And a probe that could not run must not read as "no auth failures".
    const failed = evaluatePipelineHealth(snapshot({ qboAuth: { status: "error", reason: "error", count: 0 } }));
    assert.equal(failed.ok, false);
    assert.ok(failed.reasons.includes("probe-failed:qboAuth"), failed.reasons.join(","));
});

// ─── The purchase sync's own heartbeat ─────────────────────────────────────
//
// Round 36 gate: `lastPurchaseSync` is a DATA timestamp — the newest Expense
// row QBO imported — so it legitimately stands still on a quiet week and could
// never be read as "the job is alive". Nothing else watched the scheduled
// qbo-sync at all, so health went green while purchases had not been imported
// for weeks, or ever.

test("purchase sync that has NEVER completed a cron run is red, with its own reason", () => {
    const v = evaluatePipelineHealth(snapshot({
        purchaseSyncRun: { status: "ok", at: null, runStatus: null },
    }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["purchase-sync-never-ran"]);
});

test("purchase sync older than the staleness window is red", () => {
    const v = evaluatePipelineHealth(snapshot({
        purchaseSyncRun: { status: "ok", at: iso(20 * HOUR), runStatus: "ok" },
    }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["purchase-sync-stale"]);
});

test("a purchase sync inside the window with an ok run is green", () => {
    const v = evaluatePipelineHealth(snapshot({
        purchaseSyncRun: { status: "ok", at: iso(5 * HOUR), runStatus: "ok" },
    }));
    assert.deepEqual(v, { ok: true, reasons: [] });
});

test("the LATEST purchase-sync cron run failing is red at any age", () => {
    // Same rule as the payments heartbeat: freshness comes from the last run
    // that actually ran, but the reported status is the latest event whatever
    // it was — otherwise an error right after a success is invisible.
    const v = evaluatePipelineHealth(snapshot({
        purchaseSyncRun: { status: "ok", at: iso(1 * HOUR), runStatus: "error" },
    }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["purchase-sync-error"]);
});

test("a partial purchase-sync run counts for freshness and is still flagged", () => {
    const v = evaluatePipelineHealth(snapshot({
        purchaseSyncRun: { status: "ok", at: iso(1 * HOUR), runStatus: "partial" },
    }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["purchase-sync-partial"]);
});

test("staleness and a failed latest run are reported together, not one instead of the other", () => {
    // They are separately actionable: "nothing has run in days" and "the last
    // thing that did run failed" send a human to different places.
    const v = evaluatePipelineHealth(snapshot({
        purchaseSyncRun: { status: "ok", at: iso(40 * HOUR), runStatus: "error" },
    }));
    assert.deepEqual(v.reasons, ["purchase-sync-stale", "purchase-sync-error"]);
});

test("QBO_PURCHASE_SYNC_STALE_HOURS overrides the window, and a junk value falls back", async () => {
    const { DEFAULT_PURCHASE_SYNC_STALE_HOURS, purchaseSyncStaleHours } = await import("../src/lib/pipeline-health");
    const previous = process.env.QBO_PURCHASE_SYNC_STALE_HOURS;
    try {
        process.env.QBO_PURCHASE_SYNC_STALE_HOURS = "48";
        assert.equal(purchaseSyncStaleHours(), 48);
        // 20h ago is stale at the 9h default and fresh at 48h.
        assert.deepEqual(
            evaluatePipelineHealth(snapshot({
                purchaseSyncRun: { status: "ok", at: iso(20 * HOUR), runStatus: "ok" },
            })),
            { ok: true, reasons: [] },
        );
        // A value that parses to NaN must NOT make every comparison false —
        // that is the fail-OPEN direction this heartbeat exists to close.
        for (const junk of ["", "soon", "0", "-3"]) {
            process.env.QBO_PURCHASE_SYNC_STALE_HOURS = junk;
            assert.equal(purchaseSyncStaleHours(), DEFAULT_PURCHASE_SYNC_STALE_HOURS, `junk value ${JSON.stringify(junk)}`);
        }
        process.env.QBO_PURCHASE_SYNC_STALE_HOURS = "soon";
        const v = evaluatePipelineHealth(snapshot({
            purchaseSyncRun: { status: "ok", at: iso(20 * HOUR), runStatus: "ok" },
        }));
        assert.deepEqual(v.reasons, ["purchase-sync-stale"]);
    } finally {
        if (previous === undefined) delete process.env.QBO_PURCHASE_SYNC_STALE_HOURS;
        else process.env.QBO_PURCHASE_SYNC_STALE_HOURS = previous;
    }
});

test("the sync route logs the exact kind/source the heartbeat queries for", async () => {
    // A heartbeat that watches a kind nothing writes is worse than none: it is
    // permanently red, or (as here, before the fix) permanently absent.
    const { PURCHASE_SYNC_EVENT_KIND, PURCHASE_SYNC_CRON_SOURCE } = await import("../src/lib/pipeline-health");
    const logged: any[] = [];
    const { createQboExpenseSyncHandlers } = await import("../src/app/api/integrations/qbo-expenses/sync/route");
    const handlers = createQboExpenseSyncHandlers({
        getIngestSecret: () => "ingest",
        getCronSecret: () => "cron-secret",
        isCronEnabled: () => true,
        getFreshTokens: async () => ({ accessToken: "a", refreshToken: "r", realmId: "realm-1" }),
        syncExpenses: async () => ({ imported: 1, updated: 0, removed: 0, skipped: [] }) as any,
        now: () => new Date("2026-09-01T14:00:00.000Z"),
        isSyncPaused: async () => false,
        logEvent: (event) => { logged.push(event); },
        incrementalLookbackDays: 7,
    });
    await handlers.GET(new Request("https://example.test/api/integrations/qbo-expenses/sync", {
        headers: { authorization: "Bearer cron-secret" },
    }));

    assert.equal(logged.length, 1);
    assert.equal(logged[0].kind, PURCHASE_SYNC_EVENT_KIND);
    assert.equal(logged[0].source, PURCHASE_SYNC_CRON_SOURCE);
    assert.equal(logged[0].status, "ok");
});

test("the digest prints the purchase-sync heartbeat on its own line", () => {
    const { text } = formatPipelineDigest(sampleHealth({
        ok: false,
        reasons: ["purchase-sync-stale"],
        qbo: {
            lastPurchaseSync: { status: "ok", at: "2026-09-01T10:00:00.000Z" },
            purchaseSyncRun: { status: "ok", at: "2026-08-20T14:00:00.000Z", runStatus: "partial" },
            lastReceiptPush: { status: "ok", at: "2026-09-01T12:00:00.000Z" },
            lastPaymentsSync: { status: "ok", at: "2026-09-01T13:00:00.000Z" },
        },
    }));
    assert.match(text, /Last purchase sync run: .* \(12d ago\) \[incomplete run\]/);
    assert.match(text, /Needs attention: purchase-sync-stale/);
    // The data timestamp is still there, separately — the two answer different
    // questions and neither can stand in for the other.
    assert.match(text, /Last QBO purchase booked: /);
});

// ─── Round 38 gate: a timed-out probe must not keep a pool connection ─────

/**
 * The JS race answers the CALLER. It does not stop the QUERY: an abandoned
 * promise is still a statement Postgres is running, on a connection nobody can
 * use. With a pool of five and nine probes, a wedged database meant the health
 * check stalled the application it was meant to report on.
 *
 * So the timeout is now set SERVER-side, and this asserts the statement really
 * carries it — not merely that the probe returned in time, which the old race
 * already did while leaking.
 */
test("round 38: each probe runs in a transaction carrying a server-side statement timeout", async () => {
    const statements: string[] = [];
    const fakeClient = {
        async $transaction(fn: (tx: any) => Promise<unknown>) {
            return fn({
                async $executeRawUnsafe(sql: string) { statements.push(sql); return 0; },
            });
        },
    };
    const runner = statementTimeoutRunner(fakeClient as any);
    const res = await runProbe("timed", async () => 7, -1, 250, { withDb: runner });

    assert.deepEqual(res, { status: "ok", value: 7 });
    assert.deepEqual(statements, ["SET LOCAL statement_timeout = 250"],
        "the probe budget goes to Postgres, which is the only thing that can cancel the query");
});

test("round 38: a statement Postgres cancels is reported as a failed probe", async () => {
    // What a server-side cancellation actually looks like to Prisma: the query
    // REJECTS. That must read as a failed probe (forcing ok:false), not as a
    // silent zero.
    const runner = statementTimeoutRunner({
        async $transaction(fn: (tx: any) => Promise<unknown>) {
            return fn({ async $executeRawUnsafe() { return 0; } });
        },
    } as any);
    const res = await runProbe(
        "cancelled",
        async () => { throw new Error("canceling statement due to statement timeout"); },
        -1,
        250,
        { withDb: runner },
    );
    assert.deepEqual(res, { status: "error", reason: "error", value: -1 });
});

test("round 38: probes never exceed the concurrency cap, and none is failed for queueing", async () => {
    const limiter = createLimiter(PROBE_CONCURRENCY);
    let inFlight = 0;
    let peak = 0;
    const runner: ProbeRunner = async <T,>(_ms: number, fn: (db: any) => Promise<T>) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
            await new Promise((r) => setTimeout(r, 30));
            return await fn({} as any);
        } finally {
            inFlight--;
        }
    };

    // Nine probes, the real number getPipelineHealth fires, each slower than
    // the others can start. A short per-probe budget is deliberate: a probe
    // that WAITED for a slot must not be marked timed out for it, which is why
    // the slot is taken before the timer starts.
    const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
            runProbe(`p${i}`, async () => i, -1, 120, { withDb: runner, limiter })),
    );

    assert.ok(peak <= PROBE_CONCURRENCY, `at most ${PROBE_CONCURRENCY} at once, saw ${peak}`);
    assert.ok(peak > 1, "and it really did run them in parallel, or this proves nothing");
    assert.deepEqual(results.map((r) => r.status), Array(9).fill("ok"));
    assert.deepEqual(results.map((r) => r.value), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("round 43: a timed-out probe KEEPS its slot until the query settles", async () => {
    // The release used to sit in a `finally` on the race, so it fired the moment
    // the JS timeout won — while the Prisma operation was still running and
    // still holding a pool connection. A queued probe then started against a
    // pool that was already full: the cap was counting callers, not work.
    const limiter = createLimiter(1);
    let finishFirst: (v: unknown) => void = () => {};
    // Tracked so the test can settle it before returning. Node 20 fails a test
    // that leaves a promise pending at exit, and "still running after the caller
    // gave up" is precisely the state being asserted here.
    let wedgedWork: Promise<unknown> = Promise.resolve();
    const held: ProbeRunner = <T,>() => {
        const p = new Promise<T>((resolve) => { finishFirst = resolve as (v: unknown) => void; });
        wedgedWork = p;
        return p;
    };

    const wedged = await runProbe("wedged", async () => 1, -1, 20, { withDb: held, limiter });
    assert.equal(wedged.reason, "timeout", "the caller is answered immediately");

    // The slot is STILL held, so the next probe cannot start — that is the whole
    // point. It gives up rather than queueing forever.
    const blocked = await runProbe("blocked", async () => 2, -1, 500,
        { withDb: passThrough, limiter, acquireTimeoutMs: 30 });
    assert.equal(blocked.reason, "skipped", "reported as skipped, not silently piled on");
    assert.equal(blocked.status, "error", "and it still forces ok:false");

    // Once the database actually lets go, the gate reopens.
    finishFirst(1);
    await wedgedWork;
    await new Promise((r) => setTimeout(r, 10));
    const after = await runProbe("after", async () => 1, -1, 500,
        { withDb: passThrough, limiter, acquireTimeoutMs: 200 });
    assert.deepEqual(after, { status: "ok", value: 1 }, "the gate reopened");
});

test("round 43: concurrency never exceeds the cap, even when callers have timed out", async () => {
    // The control for the above: with the release on the race, all nine of these
    // would be in flight against a five-slot gate at once.
    const limiter = createLimiter(PROBE_CONCURRENCY);
    let inFlight = 0;
    let peak = 0;
    const finishers: Array<() => void> = [];
    // Every query this test starts, so it can be settled before returning.
    const started: Array<Promise<unknown>> = [];
    const held: ProbeRunner = <T,>() => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        const p = new Promise<T>((resolve) => {
            finishers.push(() => { inFlight--; resolve(undefined as T); });
        });
        started.push(p);
        return p;
    };

    // Nine probes, each timing out well before its query settles.
    const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
            runProbe(`p${i}`, async () => i, -1, 15, { withDb: held, limiter, acquireTimeoutMs: 40 })),
    );
    assert.ok(peak <= PROBE_CONCURRENCY, `at most ${PROBE_CONCURRENCY} queries at once, saw ${peak}`);
    assert.ok(
        results.some((r) => r.reason === "skipped"),
        "the ones behind are reported as skipped rather than started anyway",
    );
    // Let the abandoned queries finish. Node 20 fails a test that exits with a
    // promise still pending, and every one of these is deliberately still
    // running after its caller gave up.
    for (const f of finishers) f();
    await Promise.all(started);
    await new Promise((r) => setTimeout(r, 0));
});

// ─── Round 44: standing queues, the heartbeat, and the slot handoff ───

/**
 * Everything the health check measured was whether something RAN. None of it
 * measured what was sitting PARKED, so it could report green with a client
 * mid-billed: an unknown-outcome create, a deletion queued and never
 * confirmed, a milestone paid outside QuickBooks with its invoice still open.
 */
test("round 44: each parked money-path queue alone turns health non-green", () => {
    const green = snapshot();
    assert.equal(evaluatePipelineHealth(green).ok, true, "the control really is green");

    const queues: Array<[string, string]> = [
        ["payLinksMissing", "pay-links-missing:1"],
        ["parkedCreates", "parked-creates:1"],
        ["parkedDocumentSyncs", "parked-document-syncs:1"],
        ["pendingDeletions", "pending-deletions:1"],
        ["unreconciledMoney", "unreconciled-money:1"],
    ];
    for (const [field, reason] of queues) {
        const v = evaluatePipelineHealth(snapshot({ [field]: { status: "ok", count: 1 } } as any));
        assert.equal(v.ok, false, `${field} > 0 must not read as healthy`);
        assert.ok(v.reasons.includes(reason), `${field} must report ${reason}, got ${v.reasons.join(",")}`);
    }
});

test("round 44: a queue we could not READ is reported, never assumed empty", () => {
    const v = evaluatePipelineHealth(snapshot({ pendingDeletions: { status: "error", reason: "timeout", count: 0 } } as any));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("probe-failed:pending-deletions"));
});

test("round 44: a stale maintenance heartbeat turns health non-green", () => {
    // An empty queue because nothing sweeps it looks exactly like an empty
    // queue because the work is done. Only this tells them apart.
    const fresh = evaluatePipelineHealth(snapshot({
        maintenanceRun: { status: "ok", at: iso(30 * 60_000) },
    } as any));
    assert.equal(fresh.ok, true, "a recent run is fine");

    const stale = evaluatePipelineHealth(snapshot({
        maintenanceRun: { status: "ok", at: iso(3 * HOUR) },
    } as any));
    assert.equal(stale.ok, false);
    assert.ok(stale.reasons.includes("qbo-maintenance-stale"));

    const never = evaluatePipelineHealth(snapshot({
        maintenanceRun: { status: "ok", at: null },
    } as any));
    assert.equal(never.ok, false, "never having run is not healthy either");
});

test("round 44: the limiter never exceeds its cap when a slot is handed over", async () => {
    // release() used to decrement inFlight and THEN wake a waiter, which
    // increments in a LATER microtask. The window between those two is the bug:
    // a caller arriving in it sees a free slot and takes it, and then the woken
    // waiter increments too — two holders against a cap of one.
    //
    // So the intruder has to arrive in that exact window: synchronously after
    // the release, before any await lets the waiter resume. A test that only
    // used already-queued waiters passes against the racy version.
    const limiter = createLimiter(1);
    const held = await limiter.acquire();
    assert.ok(held, "the first caller holds the only slot");

    const queued = limiter.acquire(60);   // waiting behind it
    await new Promise((r) => setTimeout(r, 5));

    held!();                              // hands the slot over...
    const intruder = limiter.acquire(60); // ...and this arrives in the window

    const [a, b] = await Promise.all([queued, intruder]);
    const granted = [a, b].filter(Boolean);
    assert.equal(granted.length, 1, "exactly ONE holder at a cap of one, never two");
    assert.ok(a, "and it is the caller that was already waiting, not the one that jumped in");

    for (const release of granted) release!();
});

// --- Round 45: a missing pay link is its own standing queue ---

/**
 * `paylink-pending` clears itself, one way or another, once QuickBooks
 * answers. `paylink-missing` does not: the retries are spent and the invoice
 * still has no payable URL, so somebody has to open it in QuickBooks. Counting
 * it with the pending rows would hide it behind a number that drains on its
 * own; not counting it at all is what let the row vanish from health entirely.
 */
test("round 45: a missing pay link is counted and named separately from a pending one", () => {
    const missing = evaluatePipelineHealth(snapshot({ payLinksMissing: { status: "ok", count: 2 } } as any));
    assert.equal(missing.ok, false);
    assert.ok(missing.reasons.includes("pay-links-missing:2"), missing.reasons.join(","));
    assert.ok(
        !missing.reasons.some((r) => r.startsWith("pay-links-pending")),
        "the two queues are not the same queue",
    );
});

test("round 45: a pay-link-missing probe that FAILED is reported, not read as zero", () => {
    const v = evaluatePipelineHealth(snapshot({ payLinksMissing: { status: "error", reason: "timeout", count: 0 } } as any));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("probe-failed:pay-links-missing"), v.reasons.join(","));
});

test("round 45: the digest tells the operator what to DO about a missing pay link", () => {
    const digest = formatPipelineDigest(sampleHealth({
        ok: false,
        reasons: ["pay-links-missing:1"],
        payLinksMissing: { status: "ok", count: 1 },
    } as any));
    assert.match(digest.text, /NO payable link/);
    assert.match(digest.text, /QuickBooks/);
});


test("the intake stuck probe covers the three shapes of 'the worker stopped'", async () => {
    // Regression: it counted only RECEIVED/BOOKING, so a dead worker left stale
    // STAGING rows invisible, and a worker that died right after routing left
    // live READ rows invisible. Both reported green.
    const wheres: any[] = [];
    const db = {
        receiptIntake: {
            count: async (args: any) => { wheres.push(args.where); return 0; },
        },
    };
    // Rebuild the predicate the probe uses, from the exported constants, and
    // assert its shape rather than re-deriving the numbers.
    const now = Date.parse("2026-09-01T14:00:00.000Z");
    const where = {
        OR: [
            { state: { in: ["RECEIVED", "BOOKING"] }, createdAt: { lt: new Date(now - INTAKE_STUCK_HOURS * 3_600_000) } },
            { state: "STAGING", createdAt: { lt: new Date(now - INTAKE_STAGING_STUCK_MINUTES * 60_000) } },
            { state: "READ", dryRun: false, createdAt: { lt: new Date(now - INTAKE_STUCK_HOURS * 3_600_000) } },
        ],
    };
    await db.receiptIntake.count({ where });

    const branches = wheres[0].OR;
    assert.equal(branches.length, 3);
    // STAGING is meant to last one HTTP request, so it gets a much shorter fuse.
    assert.equal(INTAKE_STAGING_STUCK_MINUTES, 30);
    assert.ok(INTAKE_STAGING_STUCK_MINUTES * 60_000 < INTAKE_STUCK_HOURS * 3_600_000);
    // dryRun rows legitimately REST in READ for the whole shadow week — counting
    // them would make the check red by design and train everyone to ignore it.
    assert.equal(branches[2].dryRun, false);
});

test("receipts nobody assigned a job to are an ALERT, not a green backlog", () => {
    // NEEDS_JOB is terminal for the worker, so it can pile up indefinitely
    // while every other probe reads green — the exact silent failure this whole
    // check exists to eliminate. Its own reason, because the fix is different:
    // assign a project, not restart a worker.
    const v = evaluatePipelineHealth(snapshot({ intakeUnassigned: { status: "ok", count: 5 } }));
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ["intake-unassigned:5"]);
});

test("a freshly uploaded unassigned receipt is not an alert", () => {
    // Only rows OLDER than the stuck threshold are counted by the probe, so a
    // receipt uploaded ten minutes ago never reaches this reason.
    assert.deepEqual(evaluatePipelineHealth(snapshot()), { ok: true, reasons: [] });
});

test("unassigned and stuck are reported separately", () => {
    const v = evaluatePipelineHealth(snapshot({
        intakeStuck: { status: "ok", count: 2 },
        intakeUnassigned: { status: "ok", count: 3 },
    }));
    assert.ok(v.reasons.some(r => r.startsWith("intake-stuck:2")));
    assert.ok(v.reasons.includes("intake-unassigned:3"));
});


// ── bank-pull-stale (Codex round-5 item 8) ─────────────────────────────────

test("a disabled bank pull is never a reason — an unset flag is not a failure", () => {
    assert.deepEqual(evaluatePipelineHealth(snapshot({
        bankPull: { status: "ok" as const, enabled: false, lastSuccessAt: null, ambiguousCount: 0 },
    })), { ok: true, reasons: [] });
    // Even a long-dead one, while it is switched off.
    assert.deepEqual(evaluatePipelineHealth(snapshot({
        bankPull: { status: "ok" as const, enabled: false, lastSuccessAt: iso(1000 * HOUR), ambiguousCount: 0 },
    })), { ok: true, reasons: [] });
});

test("an ENABLED pull that has never succeeded is stale", () => {
    // "We turned it on and it has never worked" is the failure most worth
    // catching, and a null that reads as healthy is the null-means-OK trap.
    const result = evaluatePipelineHealth(snapshot({ bankPull: { status: "ok" as const, enabled: true, lastSuccessAt: null, ambiguousCount: 0 } }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.reasons, ["bank-pull-stale"]);
});

test("36h is the line: 35h is fine, 37h is stale", () => {
    assert.deepEqual(
        evaluatePipelineHealth(snapshot({ bankPull: { status: "ok" as const, enabled: true, lastSuccessAt: iso(35 * HOUR), ambiguousCount: 0 } })),
        { ok: true, reasons: [] },
    );
    const stale = evaluatePipelineHealth(snapshot({ bankPull: { status: "ok" as const, enabled: true, lastSuccessAt: iso(37 * HOUR), ambiguousCount: 0 } }));
    assert.deepEqual(stale.reasons, ["bank-pull-stale"]);
});

test("an unparseable last-success is stale, not healthy", () => {
    const result = evaluatePipelineHealth(snapshot({
        bankPull: { status: "ok" as const, enabled: true, lastSuccessAt: "not a date", ambiguousCount: 0 },
    }));
    assert.deepEqual(result.reasons, ["bank-pull-stale"]);
});

test("the stale reason rides alongside the others, it does not replace them", () => {
    const result = evaluatePipelineHealth(snapshot({
        bankPull: { status: "ok" as const, enabled: true, lastSuccessAt: null, ambiguousCount: 0 },
        stuck: { status: "ok" as const, count: 3 },
    }));
    assert.equal(result.ok, false);
    assert.deepEqual([...result.reasons].sort(), ["bank-pull-stale", "errors-24h:3"]);
});

test("days whose bank clearance was never answered are named, and outlive the retry schedule", () => {
    /**
     * Codex PR #443 gate round 35, finding 1. `bank-pull-blocked` is about the
     * RUN that just ended, so it clears the moment one succeeds. The hole in
     * the register does not: the retry marker is dropped after
     * PROBE_RETRY_LIMIT attempts on purpose, and the span it was chasing stays
     * uncertified until some run actually re-reads it. That span also withholds
     * the freshness stamp, so unreported the only symptom is a stamp that
     * quietly stopped moving — which reads as a dead pull.
     */
    const result = evaluatePipelineHealth(snapshot({
        bankPull: {
            status: "ok" as const,
            enabled: true,
            lastSuccessAt: iso(2 * HOUR),
            ambiguousCount: 0,
            uncertifiedWindow: "2026-08-09..2026-08-12",
        },
    }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.reasons, ["bank-pull-uncertified:2026-08-09..2026-08-12"]);

    // It stands ALONGSIDE a per-run block, never instead of it: one says a
    // retry is scheduled, the other says which days are still unread.
    const both = evaluatePipelineHealth(snapshot({
        bankPull: {
            status: "ok" as const,
            enabled: true,
            lastSuccessAt: iso(2 * HOUR),
            ambiguousCount: 0,
            blockedReason: "probe-retries-exhausted",
            uncertifiedWindow: "2026-08-09..2026-08-12",
        },
    }));
    assert.deepEqual(both.reasons, [
        "bank-pull-blocked:probe-retries-exhausted",
        "bank-pull-uncertified:2026-08-09..2026-08-12",
    ]);

    // Empty is the cleared state, and a FAILED probe must not invent a span.
    assert.deepEqual(
        evaluatePipelineHealth(snapshot({
            bankPull: { status: "ok" as const, enabled: true, lastSuccessAt: iso(2 * HOUR), ambiguousCount: 0, uncertifiedWindow: "" },
        })).reasons,
        [],
    );
    assert.equal(
        evaluatePipelineHealth(snapshot({
            bankPull: { status: "error", reason: "error", enabled: true, lastSuccessAt: iso(2 * HOUR), ambiguousCount: 0, uncertifiedWindow: "2026-08-09..2026-08-12" },
        })).reasons.includes("bank-pull-uncertified:2026-08-09..2026-08-12"),
        false,
    );
});

test("an uncertain Chat card is a real, actionable failure", () => {
    // Those rows are deliberately never auto-retried, so nothing but a human
    // clears them. Until one looks, the crew simply never got asked — which is
    // the exact failure the digest exists to prevent, reported as healthy.
    assert.deepEqual(
        evaluatePipelineHealth(snapshot({ uncertainCards: { status: "ok", count: 2 } })),
        { ok: false, reasons: ["cards-uncertain:2"] },
    );
    // Zero is silent, and a FAILED probe is already reported as probe-failed —
    // it must not also invent a count.
    assert.deepEqual(evaluatePipelineHealth(snapshot({ uncertainCards: { status: "ok", count: 0 } })).reasons, []);
    const broken = evaluatePipelineHealth(snapshot({ uncertainCards: { status: "error", reason: "error", count: 0 } }));
    assert.ok(broken.reasons.includes("probe-failed:uncertainCards"));
    assert.ok(!broken.reasons.some(r => r.startsWith("cards-uncertain")));
});

test("a bank-pull probe that cannot answer says so, instead of reading as 'switched off'", async () => {
    // It used to be an unprobed `await` after the Promise.all, with its own
    // try/catch returning `{enabled:false}` — which reads as "the pull is
    // turned off", i.e. as health. A hung database also held the whole check
    // open past every other probe's deadline.
    const hung = await runProbe<{ enabled: boolean; lastSuccessAt: string | null; ambiguousCount: number }>(
        "bankPull",
        () => new Promise(() => { /* never resolves */ }),
        { enabled: false, lastSuccessAt: null, ambiguousCount: 0 },
        20,
        // The pass-through runner main's probe tests use: runProbe now opens a
        // real transaction to set a statement timeout, which needs a database.
        { withDb: passThrough },
    );
    assert.equal(hung.status, "error", "the deadline fires");
    assert.equal(hung.reason, "timeout");
    assert.deepEqual(hung.value, { enabled: false, lastSuccessAt: null, ambiguousCount: 0 }, "and the fallback is the SAFE one");

    // And that status reaches the verdict as its own reason.
    const verdict = evaluatePipelineHealth(snapshot({
        bankPull: { status: hung.status, reason: hung.reason, ...hung.value },
    }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.includes("probe-failed:bankPull"), verdict.reasons.join(","));
    // ONE reason, not two: a staleness alarm on top of a failed read fires for
    // the wrong cause and teaches people to ignore both.
    assert.ok(!verdict.reasons.includes("bank-pull-stale"));
});

test("stale ambiguity and a blocked pull are reported without inventing staleness", () => {
    // Codex PR #443 gate round 33, findings 1 and 2, at the verdict.
    //
    // `bank-ambiguous-stale` is duplicate-identity groups reconcile could not
    // pair from BEFORE the last pulled window. They used to be counted as
    // current ambiguity, which withheld the pull's freshness stamp — so ONE
    // unresolvable pair anywhere in history suppressed every owner's chase
    // cards for good. Now they are a named backlog and nothing more.
    //
    // `bank-pull-blocked` is the pull withholding that stamp on purpose. On its
    // own that is silent: the only other symptom is `bank-pull-stale` 36 hours
    // later, which reads as a dead pull when the pull ran fine and one report
    // inside it did not answer.
    const verdict = evaluatePipelineHealth(snapshot({
        bankPull: {
            status: "ok",
            enabled: true,
            lastSuccessAt: iso(1 * HOUR),
            ambiguousCount: 0,
            staleAmbiguous: { count: 2, keys: ["WTB-0723|2026-06-01|-7400|US MARKET|-", "WTB-0723|2026-06-02|-500|CHEVRON|-"] },
            blockedReason: "cleared-probe-failed",
        },
    }));
    assert.ok(verdict.reasons.includes("bank-ambiguous-stale:2:WTB-0723|2026-06-01|-7400|US MARKET|-,WTB-0723|2026-06-02|-500|CHEVRON|-"),
        verdict.reasons.join(","));
    assert.ok(verdict.reasons.includes("bank-pull-blocked:cleared-probe-failed"));
    assert.ok(!verdict.reasons.includes("bank-pull-stale"), "the marker IS fresh — the alarm must not double up");
    assert.ok(!verdict.reasons.some(r => r.startsWith("bank-pull-ambiguous:")), "stale residue is not current ambiguity");
});

test("no stale ambiguity and no blocked reason is silent", () => {
    const verdict = evaluatePipelineHealth(snapshot({
        bankPull: {
            status: "ok",
            enabled: true,
            lastSuccessAt: iso(1 * HOUR),
            ambiguousCount: 0,
            staleAmbiguous: { count: 0, keys: [] },
            blockedReason: "",
        },
    }));
    assert.deepEqual(verdict, { ok: true, reasons: [] });
});

test("the bank-pull read runs inside the Promise.all, as a probe", () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/lib/pipeline-health.ts"),
        "utf8",
    );
    assert.match(source, /probe<\{[\s\S]{0,400}\}>\(\s*\n\s*"bankPull",\s*\n\s*readBankPullState,/);
    assert.doesNotMatch(source, /bankPull: await readBankPullState\(\)/, "the unprobed await is gone");
    // The read no longer swallows its own failure — the probe reports it.
    const fn = source.slice(source.indexOf("async function readBankPullState("));
    assert.doesNotMatch(fn.slice(0, fn.indexOf("\n}")), /catch/);
});

test("no Drive credential is a reported failure, not a silent one", () => {
    // The symptom is invisible otherwise: memos get signed, the bridge is
    // refused with a 503, and the queue simply never empties. Nobody watching
    // the queue can tell that from "nobody has signed anything".
    const missing = evaluatePipelineHealth(snapshot({
        driveCredentials: { status: "ok", configured: false, source: "none" },
    }));
    assert.equal(missing.ok, false);
    assert.ok(missing.reasons.includes("drive-not-configured"), missing.reasons.join(","));

    // Connected either way is silent.
    for (const source of ["token-file-or-env", "company-settings"]) {
        const ok = evaluatePipelineHealth(snapshot({
            driveCredentials: { status: "ok", configured: true, source },
        }));
        assert.deepEqual(ok.reasons, [], source);
    }

    // A probe that could not answer is probe-failed, and must NOT also claim
    // the credential is missing — one failure, one reason.
    const broken = evaluatePipelineHealth(snapshot({
        driveCredentials: { status: "error", reason: "timeout", configured: false, source: "none" },
    }));
    assert.ok(broken.reasons.includes("probe-failed:driveCredentials"));
    assert.ok(!broken.reasons.includes("drive-not-configured"));
});

test("the Drive credential is probed, and the stored one counts", () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/lib/pipeline-health.ts"),
        "utf8",
    );
    assert.match(source, /"driveCredentials",\s*\n\s*async \(\) => \{[\s\S]{0,200}ensureDriveAuth\(\)/);
    assert.match(source, /\{ ok: false, source: "none" \}/, "the fallback assumes NOT configured");
    // And the operator docs say exactly what prod needs.
    const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env.example"), "utf8");
    for (const name of ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]) {
        assert.match(env, new RegExp(`^${name}=`, "m"), name);
    }
    assert.match(env, /auth\/drive/, "the scope is named");
    const spec = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "docs/plans/PHASE-2-QUEUE-AND-MEMOS-SPEC.md"),
        "utf8",
    );
    assert.match(spec, /Connect Google Drive, or the signed-memo path is dead on arrival/);
    assert.match(spec, /CompanySettings\.googleDriveRefreshToken/);
});

test("a stalled chaser is visible BEFORE the next day's cards are due", () => {
    // Everything on the Receipts tab is downstream of this sweep, and the cards
    // cron refuses to select until it has finished today — answering 200 with
    // `skipped:"chaser-incomplete"`, which nobody sees unless they read cron
    // logs. So the staleness is reported here, in hours, before the cards.
    assert.equal(CHASER_STALE_HOURS, 26, "one missed night plus a slow morning");

    const fresh = evaluatePipelineHealth(snapshot({
        chaser: { status: "ok", phase: "done", completedAt: iso(2 * HOUR) },
    }));
    assert.deepEqual(fresh.reasons, []);

    // Mid-cycle is fine on its own — a resume pass is normal. What matters is
    // how long since one COMPLETED.
    const running = evaluatePipelineHealth(snapshot({
        chaser: { status: "ok", phase: "lines", completedAt: iso(3 * HOUR) },
    }));
    assert.deepEqual(running.reasons, []);

    const stale = evaluatePipelineHealth(snapshot({
        chaser: { status: "ok", phase: "lines", completedAt: iso(30 * HOUR) },
    }));
    assert.equal(stale.ok, false);
    assert.ok(stale.reasons.includes("chaser-stale:30h"), stale.reasons.join(","));

    // NEVER completed is the loudest case, not the quietest.
    const never = evaluatePipelineHealth(snapshot({
        chaser: { status: "ok", phase: "open-issues", completedAt: null },
    }));
    assert.ok(never.reasons.includes("chaser-stale:never"), never.reasons.join(","));

    // A failed probe is probe-failed, and must not also invent a staleness.
    const broken = evaluatePipelineHealth(snapshot({
        chaser: { status: "error", reason: "timeout", phase: "unknown", completedAt: null },
    }));
    assert.ok(broken.reasons.includes("probe-failed:chaser"));
    assert.ok(!broken.reasons.some(r => r.startsWith("chaser-stale")));
});

test("the chaser probe reads the sweep's own marker row", () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/lib/pipeline-health.ts"),
        "utf8",
    );
    assert.match(source, /"chaser",\s*\n\s*async \(\) => \{[\s\S]{0,400}parseSweepMarker\(row\?\.value\)/);
    assert.match(source, /\{ phase: "unknown", completedAt: null, blockedReason: null \}/, "an unreadable marker is not 'done'");
});
