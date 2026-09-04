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
    createLimiter,
    statementTimeoutRunner,
    PROBE_CONCURRENCY,
    BOOKED_PUSH_STATUSES,
    type PipelineHealth,
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
