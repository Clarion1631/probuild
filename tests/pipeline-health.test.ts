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
    INTAKE_STUCK_HOURS,
    INTAKE_STAGING_STUCK_MINUTES,
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
        intakeStuck: { status: "ok" as const, count: 0 },
        intakeNeedsReview: { status: "ok" as const, count: 0 },
        intakeUnassigned: { status: "ok" as const, count: 0 },
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
        intake: {
            stuck: { status: "ok", count: 0 },
            needsReview: { status: "ok", count: 0 },
            unassigned: { status: "ok", count: 0 },
        },
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

test("an intake probe that FAILED is not an intake probe that found nothing", () => {
    for (const name of ["intakeStuck", "intakeNeedsReview", "intakeUnassigned"] as const) {
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

test("the digest prints all three intake numbers", () => {
    const { text } = formatPipelineDigest(sampleHealth({
        intake: {
            stuck: { status: "ok", count: 3 },
            needsReview: { status: "ok", count: 7 },
            unassigned: { status: "ok", count: 2 },
        },
    }));
    assert.match(text, /Receipt intake stuck >6h: 3/);
    assert.match(text, /Receipt intake awaiting review: 7/);
    assert.match(text, /Receipt intake awaiting a job \(>6h\): 2/);
});

test("the digest says a failed intake probe is unavailable, never zero", () => {
    const { text } = formatPipelineDigest(sampleHealth({
        intake: {
            stuck: { status: "error", reason: "timeout", count: 0 },
            needsReview: { status: "error", reason: "timeout", count: 0 },
            unassigned: { status: "error", reason: "timeout", count: 0 },
        },
    }));
    assert.match(text, /Receipt intake stuck >6h: unavailable \(probe failed\)/);
    assert.match(text, /Receipt intake awaiting review: unavailable \(probe failed\)/);
});
