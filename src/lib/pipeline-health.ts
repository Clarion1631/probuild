import { prisma } from "@/lib/prisma";

/**
 * One summary of the receipt/QBO pipeline's health, shared by the on-demand
 * health endpoint (GET /api/health/pipeline) and the morning digest cron
 * (GET /api/cron/pipeline-digest) so the two can never disagree about whether
 * the pipeline is OK.
 *
 * Everything here is a READ, and no probe may throw — a health check that 500s
 * during an outage tells you nothing. But a probe that FAILED must never read
 * as a probe that found nothing wrong: an unreachable database used to
 * degrade to null/0 and sail straight into `ok: true`, which is the most
 * dangerous output this file can produce. Every probe therefore reports its
 * own `status`, and any probe error forces `ok: false` with a
 * `probe-failed:<name>` reason.
 */

const INTUIT_STATUS_URL = "https://status.developer.intuit.com/api/v2/status.json";
const INTUIT_TIMEOUT_MS = 5_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** How long a silent receipt pipeline is tolerated before it is a problem. */
export const RECEIPT_STALE_HOURS = 72;

export type ProbeStatus = "ok" | "error";
/** Why a probe reports "error" — surfaced so a hang is distinguishable from a throw. */
export type ProbeFailure = "timeout" | "error";

/** Statuspage indicators: "none" | "minor" | "major" | "critical"; "unknown" is ours. */
export interface IntuitProbe {
    status: ProbeStatus;
    reason?: ProbeFailure;
    indicator: string;
    description?: string;
}

export interface TimestampProbe {
    status: ProbeStatus;
    reason?: ProbeFailure;
    at: string | null;
    /**
     * For the payments heartbeat: the recorded status of the run this
     * timestamp came from ("ok" or "partial"). A partial run counts for
     * FRESHNESS (the cron did run) but is reported as a problem in its own
     * right, so repeated partial runs cannot sit green behind a 26h window.
     */
    runStatus?: string | null;
}

export interface CountsProbe {
    status: ProbeStatus;
    reason?: ProbeFailure;
    counts: Record<string, number>;
}

export interface CountProbe {
    status: ProbeStatus;
    reason?: ProbeFailure;
    count: number;
}

export interface PipelineHealth {
    ok: boolean;
    /** Empty exactly when `ok` is true. Machine-readable, one per failed check. */
    reasons: string[];
    checkedAt: string;
    intuit: IntuitProbe;
    qbo: {
        /** Newest Expense row QBO has synced into ProBuild job costs. */
        lastPurchaseSync: TimestampProbe;
        /** Newest receipt the bot actually CREATED (re-pushes don't count). */
        lastReceiptPush: TimestampProbe;
        /**
         * Newest SUCCESSFUL payments-sync run triggered by the hourly CRON —
         * the money rail's own pulse. On-view/manual runs are excluded on
         * purpose: they must not be able to disguise a dead cron.
         */
        lastPaymentsSync: TimestampProbe;
    };
    /** receipt-push events in the last 24h, by status ("created", "fallback", ...). */
    receipts24h: CountsProbe;
    /** Newest posted date in the bank ledger — how current the statement feed is. */
    bank: TimestampProbe;
    /** Automation events (ANY kind) that errored in the last 24h. */
    stuck: CountProbe;
    /**
     * Receipt Pipeline v2 (ReceiptIntake). Every other probe here reads
     * AutomationEvent, which only ever records a BOOKING — so a v2 row that
     * never reaches QuickBooks is invisible to all of them. A jammed intake
     * queue reported a perfectly healthy pipeline right up until somebody
     * noticed the expenses were missing.
     */
    intake: {
        /**
         * Three shapes of "the worker stopped": RECEIVED/BOOKING overdue,
         * STAGING overdue (the route died mid-upload, or the sweeper is dead),
         * and live READ overdue (a worker that died right after routing).
         */
        stuck: CountProbe;
        /** NEEDS_REVIEW backlog. Reported always; a reason only when rows are STUCK. */
        needsReview: CountProbe;
        /**
         * NEEDS_JOB rows older than INTAKE_STUCK_HOURS — a receipt nobody has
         * matched to a job. Terminal for the worker, so it can pile up
         * indefinitely while every other probe reads green: the exact
         * silent-failure mode this whole check exists to eliminate. Only the
         * OVERDUE ones count, so a receipt uploaded ten minutes ago is not an
         * alert.
         */
        unassigned: CountProbe;
    };
}

/** A row this old in a working state has not been picked up, it has jammed. */
export const INTAKE_STUCK_HOURS = 6;
/**
 * STAGING is meant to last one HTTP request. Half an hour of it means the
 * intake route died mid-upload or the sweeper is not running — and since
 * STAGING is invisible to the worker's claim by design, nothing else would
 * ever notice.
 */
export const INTAKE_STAGING_STUCK_MINUTES = 30;

/**
 * Intuit's own status page.
 *
 * An unreachable status page now FAILS the check (reason
 * `intuit-status-unreachable`). It is a third party, so this will occasionally
 * produce a red digest for a statuspage.io hiccup rather than a real problem —
 * accepted deliberately: the alternative is a monitoring surface that quietly
 * knows less than it claims, and "we could not check" is not "everything is
 * fine". A cheap false red beats a confident false green.
 */
export async function fetchIntuitStatus(): Promise<IntuitProbe> {
    try {
        const res = await fetch(INTUIT_STATUS_URL, {
            signal: AbortSignal.timeout(INTUIT_TIMEOUT_MS),
            headers: { Accept: "application/json" },
        });
        if (!res.ok) return { status: "error", indicator: "unknown" };
        const data = (await res.json()) as { status?: { indicator?: unknown; description?: unknown } };
        const indicator = typeof data?.status?.indicator === "string" ? data.status.indicator : null;
        if (!indicator) return { status: "error", indicator: "unknown" };
        return {
            status: "ok",
            indicator,
            description: typeof data.status?.description === "string" ? data.status.description : undefined,
        };
    } catch {
        return { status: "error", indicator: "unknown" };
    }
}

/**
 * What counts as "a receipt got booked" for the freshness clock.
 *
 * A plain "already-exists" must NOT count: it is an idempotent re-push of a
 * receipt created earlier, often much earlier, so counting it would let a bot
 * stuck retrying one old file keep the pipeline looking alive indefinitely.
 *
 * But there is one real exception. When the FIRST attempt's response was lost
 * after QBO committed the Purchase, no "created" event exists at all — the
 * recovery pass is the only record of that booking, and it logs
 * "already-exists". Counting it only when it actually UPLOADED the attachment
 * (`attachment: "attached"`, which only happens once per receipt, on the pass
 * that repaired it) captures exactly those recoveries without letting ordinary
 * old retries — which report "already-attached" or "skipped" — reset the clock.
 */
export const BOOKED_PUSH_STATUSES = ["created"];
/** Marker for the recovery pass that genuinely stored the file. */
export const RECOVERED_BOOKING_DETAIL = '"attachment":"attached"';

/** The payments cron's per-run audit row (see quickbooks-payments.ts). */
export const PAYMENTS_SYNC_EVENT_KIND = "qbo-payments-sync";
/**
 * Only a run tagged "cron" counts as the heartbeat. On-view and manual
 * refreshes write their own source precisely so they cannot stand in for an
 * hourly job that has stopped running.
 */
export const PAYMENTS_SYNC_CRON_SOURCE = "cron";
/**
 * Run statuses that prove the cron is alive. A "partial" run did execute, so
 * it counts for freshness — and is then flagged separately, immediately.
 */
export const PAYMENTS_SYNC_HEARTBEAT_STATUSES = ["ok", "partial"];
/**
 * A receipt-push event that booked a Purchase but never stored its receipt.
 * Terminal by design (retrying a rejected file is a loop), so it must not count
 * as a healthy booking — otherwise a run of them reads as a perfectly fresh
 * receipt pipeline while every receipt is missing its image.
 */
export const ATTACHMENT_FAILED_STATUS = "attachment-failed";
/** The cron runs hourly; 26h leaves room for a couple of missed runs and DST. */
export const PAYMENTS_SYNC_STALE_HOURS = 26;

/**
 * The verdict, split out from the database reads so the rules are testable
 * without a DB.
 *
 * Every reason here is a real, actionable failure:
 *  - `probe-failed:<name>` — we could not READ the thing, so we cannot claim
 *    it is healthy. Unknown is not OK.
 *  - `intuit-<indicator>` — Intuit itself reports degradation.
 *  - `errors-24h:<n>` — automation errored (any kind: a qbo-sync failure
 *    matters even on a day with no receipt traffic).
 *  - `no-receipts-72h` — nothing has been booked in 72h. This used to
 *    auto-green as "a quiet week is quiet", which meant a permanently dead
 *    pipeline reported OK forever. It doesn't any more: the digest prints how
 *    long it has actually been and a human decides whether the silence is
 *    expected.
 */
export function evaluatePipelineHealth(input: {
    intuit: IntuitProbe;
    lastPurchaseSync: TimestampProbe;
    lastReceiptPush: TimestampProbe;
    lastPaymentsSync: TimestampProbe;
    receipts24h: CountsProbe;
    bank: TimestampProbe;
    stuck: CountProbe;
    intakeStuck: CountProbe;
    intakeNeedsReview: CountProbe;
    intakeUnassigned: CountProbe;
    now: number;
}): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];

    const namedProbes: Array<[string, { status: ProbeStatus }]> = [
        ["lastPurchaseSync", input.lastPurchaseSync],
        ["lastReceiptPush", input.lastReceiptPush],
        ["lastPaymentsSync", input.lastPaymentsSync],
        ["receipts24h", input.receipts24h],
        ["bank", input.bank],
        ["stuck", input.stuck],
        ["intakeStuck", input.intakeStuck],
        ["intakeNeedsReview", input.intakeNeedsReview],
        ["intakeUnassigned", input.intakeUnassigned],
    ];
    for (const [name, probe] of namedProbes) {
        if (probe.status === "error") reasons.push(`probe-failed:${name}`);
    }

    if (input.intuit.status === "error") {
        // We could not read Intuit's status at all. Not evidence of an outage,
        // but not evidence of health either — and this endpoint's whole job is
        // to say what it actually knows.
        reasons.push("intuit-status-unreachable");
    } else if (input.intuit.indicator !== "none") {
        reasons.push(`intuit-${input.intuit.indicator}`);
    }

    if (input.stuck.status === "ok" && input.stuck.count > 0) {
        // Includes attachment-failed: a receipt that never reached QuickBooks
        // is a failure someone has to act on, not a footnote.
        reasons.push(`errors-24h:${input.stuck.count}`);
    }

    // A row sitting in RECEIVED/BOOKING/STAGING or live READ past its fuse means
    // the worker is not draining the queue — a wedged cron, an exhausted retry
    // budget, a storage outage. The backlog number rides along so the digest can
    // say how big the hole is, but only the STUCK count is a failure:
    // NEEDS_REVIEW rows are working as designed (a human was asked a question)
    // and would otherwise hold the pipeline red until somebody cleared them.
    if (input.intakeStuck.status === "ok" && input.intakeStuck.count > 0) {
        const backlog =
            input.intakeNeedsReview.status === "ok" ? `,needs-review:${input.intakeNeedsReview.count}` : "";
        reasons.push(`intake-stuck:${input.intakeStuck.count}${backlog}`);
    }

    // A receipt waiting hours for someone to say which job it belongs to is not
    // "working as designed" — it is an expense that will never reach job cost.
    // Its own reason, because the fix is different: assign a project, not
    // restart a worker.
    if (input.intakeUnassigned.status === "ok" && input.intakeUnassigned.count > 0) {
        reasons.push(`intake-unassigned:${input.intakeUnassigned.count}`);
    }

    if (input.lastPaymentsSync.status === "ok") {
        // The money rail's heartbeat. Null means the hourly cron has never
        // completed a run we can see; stale means it stopped. Either way the
        // digest must go red — a heartbeat nobody checks is not a heartbeat.
        const at = input.lastPaymentsSync.at ? Date.parse(input.lastPaymentsSync.at) : null;
        const stale = at === null || Number.isNaN(at) || input.now - at > PAYMENTS_SYNC_STALE_HOURS * HOUR_MS;
        if (stale) reasons.push("payments-sync-stale");
        // `runStatus` is the status of the LATEST cron event, whatever it was —
        // deliberately not the status of the run that set the freshness
        // timestamp above. An error immediately after a good run used to be
        // invisible here, leaving health green on the strength of the older
        // success until the 24h error count and the 26h staleness window
        // disagreed (a two-hour green gap) or forever if the cron then stopped.
        else if (input.lastPaymentsSync.runStatus === "error") reasons.push("payments-sync-error");
        // A run that skipped rows or hit errors did NOT verify those payments.
        // It proves the cron is alive, so it counts for freshness — but it must
        // be reported the same day, not hidden inside the 26h staleness window.
        else if (input.lastPaymentsSync.runStatus === "partial") reasons.push("payments-sync-partial");
    }

    if (input.lastReceiptPush.status === "ok") {
        const at = input.lastReceiptPush.at ? Date.parse(input.lastReceiptPush.at) : null;
        const stale = at === null || Number.isNaN(at) || input.now - at > RECEIPT_STALE_HOURS * HOUR_MS;
        if (stale) reasons.push("no-receipts-72h");
    }

    return { ok: reasons.length === 0, reasons };
}

/** A probe that has not answered within this long is treated as failed. */
export const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeResult<T> {
    status: ProbeStatus;
    reason?: ProbeFailure;
    value: T;
}

/**
 * Run one probe under a deadline.
 *
 * A throwing query was already handled; a query that never SETTLES was not.
 * Prisma has no default statement timeout here, so an unreachable or wedged
 * database left the health check itself hanging until the platform killed it —
 * the caller got no answer at all, which for a cron means a silent morning
 * with no digest. Anything past the deadline is reported as a failed probe,
 * which forces ok:false the same way a thrown error does.
 *
 * Exported for tests: a never-settling fake is the only way to prove this.
 */
export async function runProbe<T>(
    name: string,
    run: () => Promise<T>,
    onError: T,
    timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult<T>> {
    const TIMED_OUT = Symbol("probe-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const deadline = new Promise<typeof TIMED_OUT>(resolve => {
            timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        });
        const result = await Promise.race([run(), deadline]);
        if (result === TIMED_OUT) {
            console.error(`[pipeline-health] probe timed out after ${timeoutMs}ms: ${name}`);
            return { status: "error", reason: "timeout", value: onError };
        }
        return { status: "ok", value: result as T };
    } catch (error) {
        console.error(`[pipeline-health] probe failed: ${name}`, error instanceof Error ? error.name : "UnknownError");
        return { status: "error", reason: "error", value: onError };
    } finally {
        // Never leave a pending timer holding the event loop open.
        clearTimeout(timer);
    }
}

export async function getPipelineHealth(): Promise<PipelineHealth> {
    const now = Date.now();
    const since24h = new Date(now - DAY_MS);

    /** Any probe failure is reported as such — never silently downgraded to "nothing found". */
    const probe = runProbe;

    const [
        intuit, lastPurchase, lastPush, lastPaymentsSync, receiptRows, lastBankLine, stuck,
        intakeStuck, intakeNeedsReview, intakeUnassigned,
    ] = await Promise.all([
        fetchIntuitStatus(),
        // Expense carries no updatedAt column — qbSyncedAt IS the "when did the
        // QBO purchase sync land" timestamp this is asking for.
        probe<Date | null>(
            "lastPurchaseSync",
            async () =>
                (await prisma.expense.aggregate({ where: { qbPurchaseId: { not: null } }, _max: { qbSyncedAt: true } }))
                    ._max.qbSyncedAt ?? null,
            null,
        ),
        probe<Date | null>(
            "lastReceiptPush",
            async () =>
                (
                    await prisma.automationEvent.findFirst({
                        where: {
                            kind: "receipt-push",
                            OR: [
                                { status: { in: BOOKED_PUSH_STATUSES } },
                                {
                                    status: "already-exists",
                                    detail: { contains: RECOVERED_BOOKING_DETAIL },
                                },
                            ],
                        },
                        orderBy: { createdAt: "desc" },
                        select: { createdAt: true },
                    })
                )?.createdAt ?? null,
            null,
        ),
        probe<{ createdAt: Date | null; latestStatus: string | null }>(
            "lastPaymentsSync",
            async () => {
                // TWO reads, deliberately. Freshness may only come from a run
                // that actually ran (ok/partial), but the reason must reflect
                // the LATEST event whatever it was — otherwise an error right
                // after a success is invisible.
                const [fresh, latest] = await Promise.all([
                    prisma.automationEvent.findFirst({
                        where: {
                            kind: PAYMENTS_SYNC_EVENT_KIND,
                            status: { in: PAYMENTS_SYNC_HEARTBEAT_STATUSES },
                            source: PAYMENTS_SYNC_CRON_SOURCE,
                        },
                        orderBy: { createdAt: "desc" },
                        select: { createdAt: true },
                    }),
                    prisma.automationEvent.findFirst({
                        where: { kind: PAYMENTS_SYNC_EVENT_KIND, source: PAYMENTS_SYNC_CRON_SOURCE },
                        orderBy: { createdAt: "desc" },
                        select: { status: true },
                    }),
                ]);
                return { createdAt: fresh?.createdAt ?? null, latestStatus: latest?.status ?? null };
            },
            { createdAt: null, latestStatus: null },
        ),
        probe<Array<{ status: string; _count: { _all: number } }>>(
            "receipts24h",
            async () => {
                const rows = await prisma.automationEvent.groupBy({
                    by: ["status"],
                    where: { kind: "receipt-push", createdAt: { gte: since24h } },
                    _count: { _all: true },
                });
                return rows;
            },
            [],
        ),
        probe<Date | null>(
            "bank",
            async () => (await prisma.bankLine.aggregate({ _max: { postedDate: true } }))._max.postedDate ?? null,
            null,
        ),
        // ANY kind: a qbo-sync failure is exactly the thing this digest exists
        // to surface, even on a day with no receipt traffic at all.
        probe<number>(
            "stuck",
            () => prisma.automationEvent.count({
                where: {
                    // attachment-failed is a TERMINAL failure that leaves a
                    // booked Purchase with no receipt. It is not literally
                    // "error", so it used to sail past this count and the digest
                    // could still read "Pipeline OK" on the strength of one
                    // other good receipt in the window.
                    status: { in: ["error", ATTACHMENT_FAILED_STATUS] },
                    createdAt: { gte: since24h },
                },
            }),
            0,
        ),
        // ReceiptIntake: the v2 queue. Three shapes of "the worker stopped",
        // all of which used to read green:
        //   RECEIVED/BOOKING overdue — the classic jam.
        //   STAGING overdue          — the route died mid-upload, or the sweeper
        //                              is dead. STAGING is invisible to the
        //                              claim by design, so nothing else notices.
        //   READ overdue, LIVE only  — a worker that died right after routing
        //                              leaves a bookable row parked forever.
        //                              dryRun rows legitimately REST in READ for
        //                              the whole shadow week, so they are
        //                              excluded or the check is red by design.
        probe<number>(
            "intakeStuck",
            () =>
                prisma.receiptIntake.count({
                    where: {
                        OR: [
                            {
                                state: { in: ["RECEIVED", "BOOKING"] },
                                createdAt: { lt: new Date(now - INTAKE_STUCK_HOURS * HOUR_MS) },
                            },
                            {
                                state: "STAGING",
                                createdAt: { lt: new Date(now - INTAKE_STAGING_STUCK_MINUTES * 60_000) },
                            },
                            {
                                state: "READ",
                                dryRun: false,
                                createdAt: { lt: new Date(now - INTAKE_STUCK_HOURS * HOUR_MS) },
                            },
                        ],
                    },
                }),
            0,
        ),
        probe<number>(
            "intakeNeedsReview",
            () => prisma.receiptIntake.count({ where: { state: "NEEDS_REVIEW" } }),
            0,
        ),
        probe<number>(
            "intakeUnassigned",
            () =>
                prisma.receiptIntake.count({
                    where: {
                        state: "NEEDS_JOB",
                        createdAt: { lt: new Date(now - INTAKE_STUCK_HOURS * HOUR_MS) },
                    },
                }),
            0,
        ),
    ]);

    const counts: Record<string, number> = {};
    for (const row of receiptRows.value) counts[row.status] = row._count._all;

    const snapshot = {
        intuit,
        lastPurchaseSync: {
            status: lastPurchase.status,
            reason: lastPurchase.reason,
            at: lastPurchase.value?.toISOString() ?? null,
        },
        lastReceiptPush: {
            status: lastPush.status,
            reason: lastPush.reason,
            at: lastPush.value?.toISOString() ?? null,
        },
        lastPaymentsSync: {
            status: lastPaymentsSync.status,
            reason: lastPaymentsSync.reason,
            at: lastPaymentsSync.value.createdAt?.toISOString() ?? null,
            runStatus: lastPaymentsSync.value.latestStatus,
        },
        receipts24h: { status: receiptRows.status, reason: receiptRows.reason, counts },
        bank: {
            status: lastBankLine.status,
            reason: lastBankLine.reason,
            at: lastBankLine.value?.toISOString() ?? null,
        },
        stuck: { status: stuck.status, reason: stuck.reason, count: stuck.value },
        intakeStuck: { status: intakeStuck.status, reason: intakeStuck.reason, count: intakeStuck.value },
        intakeNeedsReview: {
            status: intakeNeedsReview.status,
            reason: intakeNeedsReview.reason,
            count: intakeNeedsReview.value,
        },
        intakeUnassigned: {
            status: intakeUnassigned.status,
            reason: intakeUnassigned.reason,
            count: intakeUnassigned.value,
        },
    };

    const verdict = evaluatePipelineHealth({ ...snapshot, now });

    return {
        ...verdict,
        checkedAt: new Date(now).toISOString(),
        intuit: snapshot.intuit,
        qbo: {
            lastPurchaseSync: snapshot.lastPurchaseSync,
            lastReceiptPush: snapshot.lastReceiptPush,
            lastPaymentsSync: snapshot.lastPaymentsSync,
        },
        receipts24h: snapshot.receipts24h,
        bank: snapshot.bank,
        stuck: snapshot.stuck,
        intake: {
            stuck: snapshot.intakeStuck,
            needsReview: snapshot.intakeNeedsReview,
            unassigned: snapshot.intakeUnassigned,
        },
    };
}

function ago(probe: TimestampProbe, now: number): string {
    if (probe.status === "error") return "unavailable (probe failed)";
    if (!probe.at) return "never";
    const hours = (now - Date.parse(probe.at)) / HOUR_MS;
    if (hours < 1) return `${probe.at} (${Math.max(0, Math.round(hours * 60))}m ago)`;
    if (hours < 48) return `${probe.at} (${Math.round(hours)}h ago)`;
    return `${probe.at} (${Math.round(hours / 24)}d ago)`;
}

/**
 * Plain-text digest body. No markdown tables and no emoji — it has to read the
 * same in an email client, in Google Chat, and in a log line.
 */
export function formatPipelineDigest(health: PipelineHealth): { subject: string; text: string } {
    const now = Date.parse(health.checkedAt);
    const subject = health.ok ? "Pipeline OK" : "Pipeline NEEDS ATTENTION";

    const receiptCounts = Object.entries(health.receipts24h.counts).sort(([a], [b]) => a.localeCompare(b));
    const receiptsLine =
        health.receipts24h.status === "error"
            ? "unavailable (probe failed)"
            : receiptCounts.length
                ? receiptCounts.map(([s, n]) => `${s} ${n}`).join(", ")
                : "none";

    const lines = [
        subject,
        `Checked: ${health.checkedAt}`,
        `Intuit status: ${health.intuit.indicator}${health.intuit.description ? ` (${health.intuit.description})` : ""}${health.intuit.status === "error" ? " [status page unreachable]" : ""}`,
        `Last QBO purchase sync: ${ago(health.qbo.lastPurchaseSync, now)}`,
        `Last receipt booked: ${ago(health.qbo.lastReceiptPush, now)}`,
        `Last payments sync: ${ago(health.qbo.lastPaymentsSync, now)}${
            health.qbo.lastPaymentsSync.runStatus === "partial"
                ? " [incomplete run]"
                : health.qbo.lastPaymentsSync.runStatus === "error"
                    ? " [last run FAILED]"
                    : ""
        }`,
        `Receipts (24h): ${receiptsLine}`,
        `Bank ledger through: ${
            health.bank.status === "error"
                ? "unavailable (probe failed)"
                : health.bank.at
                    ? health.bank.at.slice(0, 10)
                    : "no lines"
        }`,
        `Automation errors (24h, all kinds): ${health.stuck.status === "error" ? "unavailable (probe failed)" : health.stuck.count}`,
        // Optional-chained on purpose: a digest that THROWS means no morning
        // email at all, which is strictly worse than a digest missing a line.
        // Same rule as "no probe may throw" above.
        `Receipt intake stuck >${INTAKE_STUCK_HOURS}h: ${
            health.intake?.stuck?.status === "error" ? "unavailable (probe failed)" : health.intake?.stuck?.count ?? "unavailable"
        }`,
        `Receipt intake awaiting review: ${
            health.intake?.needsReview?.status === "error" ? "unavailable (probe failed)" : health.intake?.needsReview?.count ?? "unavailable"
        }`,
        `Receipt intake awaiting a job (>${INTAKE_STUCK_HOURS}h): ${
            health.intake?.unassigned?.status === "error" ? "unavailable (probe failed)" : health.intake?.unassigned?.count ?? "unavailable"
        }`,
    ];
    if (health.reasons.length > 0) lines.push(`Needs attention: ${health.reasons.join(", ")}`);

    return { subject, text: lines.join("\n") };
}
