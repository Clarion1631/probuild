import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
    PAID_DELETION_UNRESOLVABLE,
    PAYLINK_PENDING_MARKER,
    PENDING_DELETION_MARKER,
    PENDING_DELETION_SETTLED_MARKER,
    SETTLED_WITHOUT_QB_PAYMENT,
    pendingCreateMarkerWhere,
} from "@/lib/qbo-create-markers";

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
export type ProbeFailure = "timeout" | "error" | "skipped";

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
        /**
         * Newest Expense row QBO has synced into ProBuild job costs.
         *
         * A DATA timestamp, not a heartbeat: it only moves when there is a new
         * purchase to import, so a quiet week legitimately leaves it old. It is
         * reported for information and cannot decide whether the sync is alive
         * — that is `purchaseSyncRun` below.
         */
        lastPurchaseSync: TimestampProbe;
        /**
         * Newest SUCCESSFUL purchase-sync run triggered by the scheduled CRON —
         * the job-cost rail's own pulse, and the thing this file was missing.
         * Nothing here used to go red when that cron stopped: `lastPurchaseSync`
         * counted only as a failed PROBE, so a null or month-old timestamp added
         * no reason at all and the digest read "Pipeline OK" while no purchase
         * had been imported since. Manual/backfill runs are excluded on purpose,
         * exactly as they are for the payments heartbeat: they must not be able
         * to disguise a dead cron.
         */
        purchaseSyncRun: TimestampProbe;
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
     * Events in the last 24h where QuickBooks refused the CREDENTIAL (401/403,
     * or a refresh that stranded). Optional so an older snapshot still fits.
     */
    qboAuth?: CountProbe;
    /**
     * Rows on either money rail that are LINKED to a QuickBooks invoice but
     * still carry the `paylink-pending` marker — a bill the client has no way
     * to pay yet.
     *
     * The pay-link sweep is supposed to clear these, and it reports its own
     * `unresolved` count; but a maintenance run that never happened reports
     * nothing at all, and that silence used to read as health. This is the
     * standing measurement, taken here, that does not depend on any sweep
     * having run.
     */
    payLinksPending: CountProbe;
    /**
     * Standing money-path queues only a human can clear.
     *
     * Optional so a caller that predates them (an older cached snapshot, a
     * fixture) still typechecks; the verdict treats an absent probe as
     * unmeasured rather than as zero, which is the honest reading.
     */
    parkedCreates?: CountProbe;
    parkedDocumentSyncs?: CountProbe;
    pendingDeletions?: CountProbe;
    unreconciledMoney?: CountProbe;
    /** Last successful maintenance cron; stale means nothing is working those queues. */
    maintenanceRun?: { status: ProbeStatus; reason?: ProbeFailure; at: string | null };
}

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
 * The reason a route records when QuickBooks rejects the CREDENTIAL rather than
 * the document (401/403, or a refresh that stranded). It needs its own line in
 * the digest: "automation errors: 3" does not tell anyone to go and reconnect
 * QuickBooks, and nothing else in this pipeline fixes itself less on its own.
 */
export const QBO_AUTH_EVENT_REASON = "qbo-auth";
/**
 * EVERY reason string that means "a human has to reconnect QuickBooks".
 *
 * The probe used to count the exact string `qbo-auth` and nothing else, so the
 * reconnect alert only fired for a failure the PREFLIGHT classified. Everything
 * the token path reports (`classifyPreflightFailure` in quickbooks-payments.ts)
 * — not connected at all, a refresh whose replacement token could not be
 * stored, a rotation we cannot resolve, a settings read that failed — is
 * equally un-self-healing and was silently filed as an ordinary error.
 *
 * `qbo-unavailable` is deliberately NOT in this list. It is a real outage
 * (429/5xx/network) that clears itself, and folding it in would tell Justin to
 * reconnect QuickBooks every time Intuit had a bad five minutes. The 401/403
 * leak that used to hide in that bucket is fixed at the source instead — see
 * `isQboReconnectRequired` in quickbooks.ts.
 */
export const QBO_RECONNECT_EVENT_REASONS: readonly string[] = [
    QBO_AUTH_EVENT_REASON,
    "quickbooks-not-connected",
    "token-not-persisted",
    "token-rotation-ambiguous",
    "token-fetch-failed",
];
/**
 * Only a run tagged "cron" counts as the heartbeat. On-view and manual
 * refreshes write their own source precisely so they cannot stand in for an
 * hourly job that has stopped running.
 */
export const PAYMENTS_SYNC_CRON_SOURCE = "cron";

/** The `source` the QBO maintenance cron stamps on its own run events. */
export const QBO_MAINTENANCE_SOURCE = "qbo-maintenance-cron";

/**
 * Twice the cron cadence (hourly at :45, see vercel.json). One missed run is
 * a blip; two in a row means the thing that works the repair queues is not
 * running, and an empty queue because nothing sweeps it looks exactly like an
 * empty queue because the work is done.
 */
export const MAINTENANCE_STALE_MS = 2 * 60 * 60_000;
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
 * The scheduled QBO purchase sync's own audit row.
 *
 * `qbo-sync` / source `cron` is what /api/integrations/qbo-expenses/sync logs
 * on its cron entry point (the manual POST logs `manual`/`backfill`, which are
 * excluded for the same reason the payments heartbeat excludes on-view runs).
 */
export const PURCHASE_SYNC_EVENT_KIND = "qbo-sync";
export const PURCHASE_SYNC_CRON_SOURCE = "cron";
/** A "partial" run did execute, so it counts for freshness — then is flagged. */
export const PURCHASE_SYNC_HEARTBEAT_STATUSES = ["ok", "partial"];
/**
 * The cron is scheduled every 4 hours (`30 * /4 * * *` in vercel.json), so 9h
 * covers two consecutive misses plus a DST shift before it reads as stopped.
 */
export const DEFAULT_PURCHASE_SYNC_STALE_HOURS = 9;

/**
 * The configured staleness window, `QBO_PURCHASE_SYNC_STALE_HOURS`.
 *
 * Validated rather than trusted: a blank, zero, negative or non-numeric value
 * falls back to the default. An env var that silently parsed to `NaN` would
 * make every comparison below false, which is the fail-OPEN direction — a dead
 * cron reading green is exactly the defect this heartbeat exists to fix.
 */
export function purchaseSyncStaleHours(): number {
    const raw = Number(process.env.QBO_PURCHASE_SYNC_STALE_HOURS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PURCHASE_SYNC_STALE_HOURS;
}

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
    /**
     * REQUIRED, unlike `qboAuth` below. An optional heartbeat is a heartbeat a
     * caller can forget to take, and "absent" would then read as "fine" — the
     * precise shape of the bug this field exists to fix.
     */
    purchaseSyncRun: TimestampProbe;
    lastReceiptPush: TimestampProbe;
    lastPaymentsSync: TimestampProbe;
    receipts24h: CountsProbe;
    bank: TimestampProbe;
    stuck: CountProbe;
    /** Optional so existing snapshots stay valid; absent means "not measured". */
    qboAuth?: CountProbe;
    /**
     * REQUIRED, for the same reason `purchaseSyncRun` is: an optional count is
     * one a caller can forget to take, and "absent" would then read as "no
     * unpaid-link rows" — the false green this probe exists to remove.
     */
    payLinksPending: CountProbe;
    /**
     * Standing money-path queues only a human can clear.
     *
     * Optional so a caller that predates them (an older cached snapshot, a
     * fixture) still typechecks; the verdict treats an absent probe as
     * unmeasured rather than as zero, which is the honest reading.
     */
    parkedCreates?: CountProbe;
    parkedDocumentSyncs?: CountProbe;
    pendingDeletions?: CountProbe;
    unreconciledMoney?: CountProbe;
    /** Last successful maintenance cron; stale means nothing is working those queues. */
    maintenanceRun?: { status: ProbeStatus; reason?: ProbeFailure; at: string | null };
    now: number;
}): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];

    const namedProbes: Array<[string, { status: ProbeStatus }]> = [
        ["lastPurchaseSync", input.lastPurchaseSync],
        ["purchaseSyncRun", input.purchaseSyncRun],
        ["lastReceiptPush", input.lastReceiptPush],
        ["lastPaymentsSync", input.lastPaymentsSync],
        ["receipts24h", input.receipts24h],
        ["bank", input.bank],
        ["stuck", input.stuck],
        ["payLinksPending", input.payLinksPending],
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

    if (input.qboAuth && input.qboAuth.status === "error") {
        reasons.push("probe-failed:qboAuth");
    } else if (input.qboAuth && input.qboAuth.count > 0) {
        // Nothing will book until a human reconnects QuickBooks, so say that
        // rather than folding it into a generic error count.
        reasons.push("quickbooks-reconnect-needed");
    }

    if (input.payLinksPending.status === "ok" && input.payLinksPending.count > 0) {
        // Linked in QuickBooks, no pay link written. The invoice exists and the
        // client cannot pay it, and the maintenance sweep reporting ok:true
        // while one of these sat in front of its cursor is exactly why this is
        // measured here rather than taken on that sweep's word.
        reasons.push(`pay-links-pending:${input.payLinksPending.count}`);
    }

    // Each standing queue, named and counted separately. Folding them into
    // one number would tell an operator that something is parked without
    // saying which thing, and they need different actions.
    const queues: Array<[string, CountProbe | undefined]> = [
        ["parked-creates", input.parkedCreates],
        ["parked-document-syncs", input.parkedDocumentSyncs],
        ["pending-deletions", input.pendingDeletions],
        ["unreconciled-money", input.unreconciledMoney],
    ];
    for (const [name, q] of queues) {
        if (!q) continue;
        if (q.status === "error") reasons.push(`probe-failed:${name}`);
        else if (q.count > 0) reasons.push(`${name}:${q.count}`);
    }

    // The heartbeat for the thing that WORKS those queues. An empty queue
    // because the sweep is dead looks exactly like an empty queue because
    // the work is done, and only this tells them apart.
    if (input.maintenanceRun) {
        if (input.maintenanceRun.status === "error") reasons.push("probe-failed:maintenanceRun");
        else {
            const at = input.maintenanceRun.at ? Date.parse(input.maintenanceRun.at) : null;
            if (at === null || Number.isNaN(at) || input.now - at > MAINTENANCE_STALE_MS) {
                reasons.push("qbo-maintenance-stale");
            }
        }
    }

    if (input.stuck.status === "ok" && input.stuck.count > 0) {
        // Includes attachment-failed: a receipt that never reached QuickBooks
        // is a failure someone has to act on, not a footnote.
        reasons.push(`errors-24h:${input.stuck.count}`);
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

    if (input.purchaseSyncRun.status === "ok") {
        // The job-cost rail's heartbeat, read exactly like the payments one —
        // except that "never" gets its own reason. A pipeline whose purchase
        // sync has NEVER completed a cron run is a different conversation from
        // one that stopped, and both used to produce nothing at all here.
        const at = input.purchaseSyncRun.at ? Date.parse(input.purchaseSyncRun.at) : null;
        if (at === null || Number.isNaN(at)) {
            reasons.push("purchase-sync-never-ran");
        } else if (input.now - at > purchaseSyncStaleHours() * HOUR_MS) {
            reasons.push("purchase-sync-stale");
        }
        // Reported alongside the freshness verdict rather than instead of it:
        // "the last run failed" and "nothing has run in days" are separately
        // actionable, and a run that failed still says nothing about freshness.
        if (input.purchaseSyncRun.runStatus === "error") {
            reasons.push("purchase-sync-error");
        } else if (input.purchaseSyncRun.runStatus === "partial") {
            // Ran, but left work undone (attachments it gave up on). It counts
            // for freshness and is flagged the same day rather than hiding
            // inside the staleness window.
            reasons.push("purchase-sync-partial");
        }
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
 * How many probes may hold a database connection at once.
 *
 * The pool this shares with the rest of the app is small (a connection limit of 5 in
 * the Prisma client). Firing every probe at once meant the health check
 * could take the whole pool for itself — so a slow database turned "report on
 * the app" into "stall the app". Four at a time still finishes a nine-probe
 * sweep in three waves.
 */
export const PROBE_CONCURRENCY = 4;

/** The database handle a probe is given: a transaction client, not the pool. */
export type ProbeDb = Prisma.TransactionClient;

/** How a probe gets that handle. Injectable so a test needs no database. */
export type ProbeRunner = <T>(timeoutMs: number, fn: (db: ProbeDb) => Promise<T>) => Promise<T>;

/** A slot-limited gate. Exported so a test can drive one it can observe. */
export interface Limiter {
    /** `null` when the wait timed out: the caller did NOT get a slot. */
    acquire(timeoutMs?: number): Promise<(() => void) | null>;
}

/**
 * How long a probe will wait for a slot before giving up on running at all.
 *
 * A wedged database is the case this exists for: the probes ahead now hold
 * their slots until their queries actually settle, so without a bound the ones
 * behind would queue until the platform killed the whole request. Reporting a
 * skipped probe is strictly better than reporting nothing at all.
 */
export const PROBE_ACQUIRE_TIMEOUT_MS = 2_000;

export function createLimiter(limit: number): Limiter {
    let inFlight = 0;
    const waiting: Array<() => void> = [];
    const release = () => {
        // TRANSFER, do not decrement-then-wake.
        //
        // Decrementing first opened a window: the woken waiter increments in a
        // later microtask, so a concurrent acquire() running in between saw
        // inFlight below the limit, took the slot synchronously, and then BOTH
        // incremented — the gate ran over its cap. Handing the slot straight to
        // the next waiter keeps inFlight unchanged, so there is no window at all.
        const next = waiting.shift();
        if (next) {
            next();
            return;
        }
        inFlight--;
    };
    return {
        async acquire(timeoutMs?: number) {
            if (inFlight >= limit) {
                // EVERY promise this creates is settled before returning, and the
                // timer is cleared rather than unref'd.
                //
                // The first cut left both halves of the race dangling: the queue
                // ticket was spliced out but never resolved, and the timeout promise
                // stayed pending whenever the slot arrived first. Node 20 fails a
                // test that exits with a promise still pending — and an unref'd
                // timer means it may simply never fire, so the promise it would have
                // resolved is unreachable rather than merely late.
                let settleQueued: (granted: boolean) => void = () => {};
                const queued = new Promise<boolean>((resolve) => { settleQueued = resolve; });
                // `handed` records that release() actually TRANSFERRED a slot to us.
                // The race below can pick the timeout even when the handoff already
                // happened in the same tick; without this we would walk away from a
                // slot we own and the gate would leak it permanently.
                let handed = false;
                const ticket = () => { handed = true; settleQueued(true); };
                waiting.push(ticket);

                let timer: ReturnType<typeof setTimeout> | undefined;
                let settleTimeout: (granted: boolean) => void = () => {};
                const expiry = new Promise<boolean>((resolve) => {
                    settleTimeout = resolve;
                    if (timeoutMs !== undefined) timer = setTimeout(() => resolve(false), timeoutMs);
                });

                const got = timeoutMs === undefined ? await queued : await Promise.race([queued, expiry]);

                clearTimeout(timer);
                settleTimeout(got);
                if (!got && !handed) {
                    // Drop the ticket, or the next release hands a slot to a waiter
                    // that has already given up and the gate leaks one permanently.
                    const at = waiting.indexOf(ticket);
                    if (at > -1) waiting.splice(at, 1);
                    settleQueued(false);
                    return null;
                }
                // Reaching here means a slot was TRANSFERRED to us: `inFlight`
                // already counts it, so incrementing again would double-count.
            } else {
                inFlight++;
            }
            let released = false;
            // Idempotent: a double release would let the gate drift open.
            return () => {
                if (released) return;
                released = true;
                release();
            };
        },
    };
}

const probeLimiter = createLimiter(PROBE_CONCURRENCY);

/**
 * The production runner: one short transaction per probe, carrying a
 * SERVER-SIDE statement timeout.
 *
 * `SET LOCAL` scopes the timeout to this transaction, and Postgres itself
 * cancels the statement when it expires — which is the part the JS race below
 * cannot do. Losing a `Promise.race` abandons the promise, not the query: the
 * connection stayed busy until the database finished whatever it was doing, so
 * every timed-out probe leaked a pool slot for exactly as long as the wedge
 * lasted. The race is still there as the backstop for a connection that never
 * even reaches Postgres.
 */
export function statementTimeoutRunner(client: typeof prisma = prisma): ProbeRunner {
    return <T>(timeoutMs: number, fn: (db: ProbeDb) => Promise<T>): Promise<T> => {
        const ms = Math.max(1, Math.floor(timeoutMs));
        return client.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
                return await fn(tx);
            },
            // A hair beyond the statement timeout, so the SERVER is what
            // cancels and the error the probe reports is the real one.
            { timeout: ms + 1_000, maxWait: ms + 1_000 },
        );
    };
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
 * The deadline is enforced in TWO places on purpose. Postgres cancels the
 * statement (statementTimeoutRunner), which is what actually frees the
 * connection; the race here still answers the caller when the database never
 * responds at all. And the slot is taken BEFORE the timer starts, so a probe
 * queued behind three others is not marked timed-out for having waited.
 *
 * Exported for tests: a never-settling fake is the only way to prove this.
 */
export async function runProbe<T>(
    name: string,
    run: (db: ProbeDb) => Promise<T>,
    onError: T,
    timeoutMs: number = PROBE_TIMEOUT_MS,
    deps?: { withDb?: ProbeRunner; limiter?: Limiter; acquireTimeoutMs?: number },
): Promise<ProbeResult<T>> {
    const withDb = deps?.withDb ?? statementTimeoutRunner();
    const limiter = deps?.limiter ?? probeLimiter;
    const acquireTimeoutMs = deps?.acquireTimeoutMs ?? PROBE_ACQUIRE_TIMEOUT_MS;
    const TIMED_OUT = Symbol("probe-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const releaseSlot = await limiter.acquire(acquireTimeoutMs);
    if (!releaseSlot) {
        // Every slot is held by a probe whose query has not come back. Starting
        // anyway is what the cap exists to prevent, and waiting forever turns a
        // slow database into no answer at all.
        console.error(`[pipeline-health] probe skipped, limiter saturated: ${name}`);
        return { status: "error", reason: "skipped", value: onError };
    }
    // THE SLOT FOLLOWS THE QUERY, NOT THE RACE.
    //
    // Releasing it in a `finally` on the race handed it back the moment the JS
    // timeout won — while the Prisma operation was still running and still
    // holding a pool connection. A queued probe then started against a pool that
    // was already full, so nine probes could pile onto five connections: the cap
    // was counting callers, not work. The release is attached to the underlying
    // promise instead, so a timed-out probe answers its caller immediately and
    // still occupies its slot until the database actually lets go.
    const work = withDb(timeoutMs, run);
    void work.then(() => releaseSlot(), () => releaseSlot());
    // Held so the timer promise can be SETTLED on the way out. Clearing the
    // timeout alone left it pending forever on every successful probe, which is
    // exactly the shape Node flags as an unresolved promise at exit.
    let settleDeadline: (v: typeof TIMED_OUT) => void = () => {};
    try {
        const deadline = new Promise<typeof TIMED_OUT>(resolve => {
            settleDeadline = resolve;
            timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        });
        const result = await Promise.race([work, deadline]);
        if (result === TIMED_OUT) {
            console.error(`[pipeline-health] probe timed out after ${timeoutMs}ms: ${name}`);
            return { status: "error", reason: "timeout", value: onError };
        }
        return { status: "ok", value: result as T };
    } catch (error) {
        console.error(`[pipeline-health] probe failed: ${name}`, error instanceof Error ? error.name : "UnknownError");
        return { status: "error", reason: "error", value: onError };
    } finally {
        // Never leave a pending timer holding the event loop open, nor a promise
        // that can never settle. The SLOT is deliberately not released here:
        // `work` owns it now.
        clearTimeout(timer);
        settleDeadline(TIMED_OUT);
    }
}

export async function getPipelineHealth(): Promise<PipelineHealth> {
    const now = Date.now();
    const since24h = new Date(now - DAY_MS);

    /** Any probe failure is reported as such — never silently downgraded to "nothing found". */
    const probe = runProbe;

    const [
        intuit, lastPurchase, purchaseSyncRun, lastPush, lastPaymentsSync, receiptRows,
        lastBankLine, stuck, qboAuth, payLinksPending,
        parkedCreates, parkedDocumentSyncs, pendingDeletions, unreconciledMoney, maintenanceRun,
    ] = await Promise.all([
        fetchIntuitStatus(),
        // Expense carries no updatedAt column — qbSyncedAt IS the "when did the
        // QBO purchase sync land" timestamp this is asking for.
        probe<Date | null>(
            "lastPurchaseSync",
            async (db) =>
                (await db.expense.aggregate({ where: { qbPurchaseId: { not: null } }, _max: { qbSyncedAt: true } }))
                    ._max.qbSyncedAt ?? null,
            null,
        ),
        // The purchase-sync CRON's own pulse. Same two-read shape as the
        // payments heartbeat below: freshness may only come from a run that
        // actually ran (ok/partial), while the reported run status is the
        // LATEST cron event whatever it was — otherwise a failure right after a
        // success is invisible.
        probe<{ createdAt: Date | null; latestStatus: string | null }>(
            "purchaseSyncRun",
            async (db) => {
                const [fresh, latest] = await Promise.all([
                    db.automationEvent.findFirst({
                        where: {
                            kind: PURCHASE_SYNC_EVENT_KIND,
                            status: { in: PURCHASE_SYNC_HEARTBEAT_STATUSES },
                            source: PURCHASE_SYNC_CRON_SOURCE,
                        },
                        orderBy: { createdAt: "desc" },
                        select: { createdAt: true },
                    }),
                    db.automationEvent.findFirst({
                        where: { kind: PURCHASE_SYNC_EVENT_KIND, source: PURCHASE_SYNC_CRON_SOURCE },
                        orderBy: { createdAt: "desc" },
                        select: { status: true },
                    }),
                ]);
                return { createdAt: fresh?.createdAt ?? null, latestStatus: latest?.status ?? null };
            },
            { createdAt: null, latestStatus: null },
        ),
        probe<Date | null>(
            "lastReceiptPush",
            async (db) =>
                (
                    await db.automationEvent.findFirst({
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
            async (db) => {
                // TWO reads, deliberately. Freshness may only come from a run
                // that actually ran (ok/partial), but the reason must reflect
                // the LATEST event whatever it was — otherwise an error right
                // after a success is invisible.
                const [fresh, latest] = await Promise.all([
                    db.automationEvent.findFirst({
                        where: {
                            kind: PAYMENTS_SYNC_EVENT_KIND,
                            status: { in: PAYMENTS_SYNC_HEARTBEAT_STATUSES },
                            source: PAYMENTS_SYNC_CRON_SOURCE,
                        },
                        orderBy: { createdAt: "desc" },
                        select: { createdAt: true },
                    }),
                    db.automationEvent.findFirst({
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
            async (db) => {
                const rows = await db.automationEvent.groupBy({
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
            async (db) => (await db.bankLine.aggregate({ _max: { postedDate: true } }))._max.postedDate ?? null,
            null,
        ),
        // ANY kind: a qbo-sync failure is exactly the thing this digest exists
        // to surface, even on a day with no receipt traffic at all.
        probe<number>(
            "stuck",
            (db) => db.automationEvent.count({
                where: {
                    createdAt: { gte: since24h },
                    OR: [
                        // attachment-failed is a TERMINAL failure that leaves a
                        // booked Purchase with no receipt. It is not literally
                        // "error", so it used to sail past this count and the
                        // digest could still read "Pipeline OK" on the strength
                        // of one other good receipt in the window.
                        { status: { in: ["error", ATTACHMENT_FAILED_STATUS] } },
                        // A "partial" run left work undone, which is a problem
                        // even though it is not a hard failure. The payments
                        // sweep and the purchase sync are excluded because each
                        // reports its own *-sync-partial reason from its latest
                        // run — counting them here too would say the same thing
                        // twice.
                        {
                            status: "partial",
                            kind: { notIn: [PAYMENTS_SYNC_EVENT_KIND, PURCHASE_SYNC_EVENT_KIND] },
                        },
                    ],
                },
            }),
            0,
        ),
        // Separate from `stuck` on purpose: this one names the fix.
        probe<number>(
            "qboAuth",
            (db) => db.automationEvent.count({
                where: { createdAt: { gte: since24h }, reason: { in: [...QBO_RECONNECT_EVENT_REASONS] } },
            }),
            0,
        ),
        // Both money rails, one number: a milestone and a progress billing in
        // this state are the same problem for the client, and splitting them
        // here would only invite a caller to check one.
        probe<number>(
            "payLinksPending",
            async (db) => {
                const where = { qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceId: { not: null } };
                const [milestones, billings] = await Promise.all([
                    db.paymentSchedule.count({ where }),
                    db.progressBilling.count({ where }),
                ]);
                return milestones + billings;
            },
            0,
        ),
        // THE STANDING QUEUES. Everything above measures whether something
        // RAN; none of it measures what is sitting parked. Health could report
        // green with a client mid-billed on both rails: an unknown-outcome
        // create, a deletion queued and never confirmed, a milestone paid
        // outside QuickBooks with its invoice still open. Each is money-path
        // work that only a human can finish, so each is its own count and each
        // one alone turns the check non-green.
        probe<number>(
            "parkedCreates",
            async (db) => {
                const where = { OR: pendingCreateMarkerWhere() };
                const [milestones, billings] = await Promise.all([
                    db.paymentSchedule.count({ where }),
                    db.progressBilling.count({ where }),
                ]);
                return milestones + billings;
            },
            0,
        ),
        probe<number>(
            "parkedDocumentSyncs",
            async (db) => {
                // EVERY non-null marker, readable or not: an unreadable value is
                // outstanding work too, and counting only the recognised ones is
                // exactly the blind spot the maintenance sweep just lost.
                const [estimates, invoices] = await Promise.all([
                    db.estimate.count({ where: { qbSyncMarker: { not: null }, qbEstimateId: null } }),
                    db.invoice.count({ where: { qbSyncMarker: { not: null }, qbInvoiceId: null } }),
                ]);
                return estimates + invoices;
            },
            0,
        ),
        probe<number>(
            "pendingDeletions",
            async (db) => db.paymentSchedule.count({
                where: {
                    qbSyncError: { in: [PENDING_DELETION_MARKER, PENDING_DELETION_SETTLED_MARKER] },
                    qbInvoiceId: { not: null },
                },
            }),
            0,
        ),
        probe<number>(
            "unreconciledMoney",
            async (db) => db.paymentSchedule.count({
                where: { qbSyncError: { in: [PAID_DELETION_UNRESOLVABLE, SETTLED_WITHOUT_QB_PAYMENT] } },
            }),
            0,
        ),
        // ...and whether the thing that WORKS those queues is still running.
        // A queue that is empty because nothing is sweeping it looks identical
        // to one that is empty because the work is done.
        probe<Date | null>(
            "maintenanceRun",
            async (db) =>
                (
                    await db.automationEvent.findFirst({
                        where: { kind: PAYMENTS_SYNC_EVENT_KIND, source: QBO_MAINTENANCE_SOURCE, status: "ok" },
                        orderBy: { createdAt: "desc" },
                        select: { createdAt: true },
                    })
                )?.createdAt ?? null,
            null,
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
        purchaseSyncRun: {
            status: purchaseSyncRun.status,
            reason: purchaseSyncRun.reason,
            at: purchaseSyncRun.value.createdAt?.toISOString() ?? null,
            runStatus: purchaseSyncRun.value.latestStatus,
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
        qboAuth: { status: qboAuth.status, reason: qboAuth.reason, count: qboAuth.value },
        payLinksPending: { status: payLinksPending.status, reason: payLinksPending.reason, count: payLinksPending.value },
        parkedCreates: { status: parkedCreates.status, reason: parkedCreates.reason, count: parkedCreates.value },
        parkedDocumentSyncs: { status: parkedDocumentSyncs.status, reason: parkedDocumentSyncs.reason, count: parkedDocumentSyncs.value },
        pendingDeletions: { status: pendingDeletions.status, reason: pendingDeletions.reason, count: pendingDeletions.value },
        unreconciledMoney: { status: unreconciledMoney.status, reason: unreconciledMoney.reason, count: unreconciledMoney.value },
        maintenanceRun: { status: maintenanceRun.status, reason: maintenanceRun.reason, at: maintenanceRun.value?.toISOString() ?? null },
    };

    const verdict = evaluatePipelineHealth({ ...snapshot, now });

    return {
        ...verdict,
        checkedAt: new Date(now).toISOString(),
        intuit: snapshot.intuit,
        qbo: {
            lastPurchaseSync: snapshot.lastPurchaseSync,
            purchaseSyncRun: snapshot.purchaseSyncRun,
            lastReceiptPush: snapshot.lastReceiptPush,
            lastPaymentsSync: snapshot.lastPaymentsSync,
        },
        receipts24h: snapshot.receipts24h,
        bank: snapshot.bank,
        stuck: snapshot.stuck,
        qboAuth: snapshot.qboAuth,
        payLinksPending: snapshot.payLinksPending,
        parkedCreates: snapshot.parkedCreates,
        parkedDocumentSyncs: snapshot.parkedDocumentSyncs,
        pendingDeletions: snapshot.pendingDeletions,
        unreconciledMoney: snapshot.unreconciledMoney,
        maintenanceRun: snapshot.maintenanceRun,
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
        `Last QBO purchase booked: ${ago(health.qbo.lastPurchaseSync, now)}`,
        // Surfaced exactly like the payments heartbeat below, and separately
        // from the data timestamp above: "nothing new to import" and "the job
        // that imports it has stopped" look identical on that line alone.
        `Last purchase sync run: ${ago(health.qbo.purchaseSyncRun, now)}${
            health.qbo.purchaseSyncRun.runStatus === "partial"
                ? " [incomplete run]"
                : health.qbo.purchaseSyncRun.runStatus === "error"
                    ? " [last run FAILED]"
                    : ""
        }`,
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
    ];
    if (health.payLinksPending?.status === "ok" && health.payLinksPending.count > 0) {
        lines.push(`${health.payLinksPending.count} QuickBooks invoice(s) are linked but still have no pay link — run QBO maintenance (sync-payment-options).`);
    }
    if (health.qboAuth && health.qboAuth.status === "ok" && health.qboAuth.count > 0) {
        lines.push(`QuickBooks could not be used with the stored credential ${health.qboAuth.count} time(s) in 24h — reconnect it in Settings → Integrations.`);
    }
    if (health.reasons.length > 0) lines.push(`Needs attention: ${health.reasons.join(", ")}`);

    return { subject, text: lines.join("\n") };
}
