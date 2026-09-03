import { prisma } from "@/lib/prisma";
import { STAGING_SWEEP_MINUTES } from "./receipt-intake/worker";

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
    /**
     * THE REGISTER SECTION. The nightly QBO pull, and the honest residue of the
     * clearance gate: `unclearedCount` is how many QuickBooks postings are
     * sitting as observations because QuickBooks has not said they cleared the
     * bank. They are not lost and they are not failures — they simply are not
     * canonical lines yet, so nothing chases them. Reported so that number is
     * SEEN rather than inferred from an absence of chases.
     *
     * OPTIONAL because `evaluatePipelineHealth` is testable with a partial
     * snapshot and the digest only renders what it is given; `getPipelineHealth`
     * always fills both in.
     */
    bankPull?: {
        status: ProbeStatus;
        reason?: string;
        enabled: boolean;
        lastSuccessAt: string | null;
        ambiguousCount: number;
        unclearedCount?: number;
        /** Ambiguity from before the last pulled window: reported, never a stamp blocker. */
        staleAmbiguous?: { count: number; keys: string[] };
        /** Why the pull withheld its own freshness stamp, when it did. */
        blockedReason?: string | null;
        /** Days whose clearance was never answered, as `<from>..<to>`. */
        uncertifiedWindow?: string | null;
    };
    /** The missing-receipt sweep's marker, including why it is holding back. */
    chaser?: {
        status: ProbeStatus;
        reason?: string;
        phase: string;
        completedAt: string | null;
        blockedReason?: string | null;
    };
}

/** A row this old in a working state has not been picked up, it has jammed. */
export const INTAKE_STUCK_HOURS = 6;
/**
 * STAGING is meant to last one HTTP request. Half an hour of it means the
 * intake route died mid-upload or the sweeper is not running — and since
 * STAGING is invisible to the worker's claim by design, nothing else would
 * ever notice.
 *
 * ROW AGE ALONE IS THE WRONG QUESTION, same as it is for the sweeper's own
 * "is this row stuck" call (worker.ts's uploadLeaseActive). A signed upload
 * URL is valid for two hours (SIGNED_UPLOAD_TTL_MS), and a resumed /start
 * re-issues one on an EXISTING row without touching createdAt — so a client
 * on a slow connection, still inside its own upload window, used to get
 * flagged "stuck" here while its upload was about to land. The count below
 * only counts a STAGING row past this age AND past its own upload lease.
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
 *  - `bank-pull-stale` — the nightly QBO register pull has not succeeded in
 *    36h (or has never succeeded) WHILE it is enabled. The whole missing-receipt
 *    chaser reads BankLine, so a dead pull silently starves it: every check
 *    stays green while the queue quietly stops finding anything. Only reported
 *    when the feature is actually on — an unset flag is not a failure.
 *  - `bank-pull-blocked:<reason>` — the pull RAN and withheld its own freshness
 *    stamp on purpose. Today's one reason is `cleared-probe-failed`: QuickBooks
 *    served the register but not the clearance report, so every row is
 *    "Unknown", nothing clearance-gated could run, and the run is not evidence
 *    the register is current. Silent otherwise — the only other symptom is
 *    `bank-pull-stale` 36 hours later, which reads as a dead pull when the pull
 *    was fine and one report inside it was not.
 *  - `bank-pull-uncertified:<from>..<to>` — a span of days whose bank clearance
 *    was never answered and has not been re-read since. Outlives the retry
 *    schedule (which gives up on purpose after PROBE_RETRY_LIMIT attempts) and
 *    withholds the pull's freshness stamp until some run covers it, so without
 *    naming it the only symptom is a stamp that quietly stops moving.
 *  - `bank-ambiguous-stale:<n>:<keys>` — duplicate-identity groups reconcile
 *    could not pair, from BEFORE the window the pull last read. A backlog for a
 *    human, never a stamp blocker: gating on these meant one unresolvable pair
 *    anywhere in history switched every owner's chase cards off for good.
 *  - `chaser-stale:<hours>h` — the missing-receipt sweep has not COMPLETED a
 *    cycle in over a day (or has never completed one). Everything downstream
 *    reads its output: the Receipts tab's missing-receipt list is whatever it
 *    last left behind, and the morning cards cron refuses to select at all
 *    until it has finished today — answering `{skipped:"chaser-incomplete"}`
 *    with HTTP 200, which is invisible unless somebody reads cron logs. This is
 *    the check that makes a stalled chaser visible BEFORE the cards are due.
 *  - `drive-not-configured` — no Google Drive credential is loadable, so the
 *    signed-memo path cannot verify a single artifact. Every `signed:true` the
 *    bridge sends is refused with a 503 while this holds, which is correct
 *    (never record "verified" for something nobody could check) and completely
 *    silent from the crew's side: they sign memos and nothing closes. It is
 *    reported here because the failure has no other symptom.
 *  - `cards-uncertain:<n>` — the morning Chat digest asked Google Chat to post
 *    a card and never got a confirmed answer. Those rows are deliberately NEVER
 *    auto-retried (a duplicate chase card teaches people the list is noise), so
 *    nothing clears them but a human: the Receipts tab shows each one with
 *    "mark delivered" and "resend". Left alone they are silent — the crew
 *    simply never got asked, which is the failure mode this whole feature
 *    exists to prevent.
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
    /**
     * The nightly QBO register pull: whether it is switched on at all, and when
     * it last SUCCEEDED (not merely ran).
     *
     * Carries a probe status like every other read here. Without one, a
     * database that would not answer produced `{enabled:false}` — which reads
     * as "the pull is switched off", i.e. as HEALTH — and the one check that
     * watches the chaser's whole input went quiet exactly when it was needed.
     */
    bankPull: {
        status: ProbeStatus;
        reason?: string;
        enabled: boolean;
        lastSuccessAt: string | null;
        ambiguousCount: number;
        unclearedCount?: number;
        staleAmbiguous?: { count: number; keys: string[] };
        blockedReason?: string | null;
        uncertifiedWindow?: string | null;
    };
    /** Chat cards whose delivery was never confirmed and which nobody has resolved. */
    uncertainCards: CountProbe;
    /** Can we authenticate to Drive at all? Gates the signed-memo path. */
    driveCredentials: { status: ProbeStatus; reason?: string; configured: boolean; source: string };
    /**
     * The missing-receipt sweep's own marker: which half it is in, and when it
     * last finished a clean cycle.
     */
    chaser: {
        status: ProbeStatus;
        reason?: string;
        phase: string;
        completedAt: string | null;
        /**
         * Why the sweep is deliberately NOT stamping its completion, when that
         * is the case. Optional: a marker written by an older build carries no
         * such field, and absent must read as "not blocked", never as unknown.
         */
        blockedReason?: string | null;
    };
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
        ["uncertainCards", input.uncertainCards],
        ["bankPull", input.bankPull],
        ["driveCredentials", input.driveCredentials],
        ["chaser", input.chaser],
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

    // Only when we actually READ it — a failed probe is already reported as
    // probe-failed:bankPull, and inventing a staleness alarm on top of it would
    // fire for the wrong reason and teach people to ignore both.
    if (input.bankPull.status === "ok" && input.bankPull.enabled) {
        const at = input.bankPull.lastSuccessAt ? Date.parse(input.bankPull.lastSuccessAt) : null;
        // Never succeeded counts as stale. "We turned it on and it has never
        // worked" is the failure most worth catching, and a null that reads as
        // healthy is exactly the null-means-OK trap this file already fixed
        // elsewhere.
        const stale = at === null || Number.isNaN(at) || input.now - at > BANK_PULL_STALE_HOURS * HOUR_MS;
        if (stale) reasons.push("bank-pull-stale");
    }

    // Ambiguous reconcile groups are a human call, never auto-resolved (see
    // BANK_PULL_AMBIGUOUS_KEY) — reported whenever the probe actually READ a
    // count, independent of the staleness check above, so a backlog surfaces
    // even on a night the pull itself is otherwise current.
    if (input.bankPull.status === "ok" && input.bankPull.ambiguousCount > 0) {
        reasons.push(`bank-pull-ambiguous:${input.bankPull.ambiguousCount}`);
    }

    // AMBIGUITY OLDER THAN THE LAST PULLED WINDOW. Reported, and deliberately
    // separate from the line above: it is a real backlog somebody owes an
    // answer on, but it is NOT evidence that tonight's register is unsettled,
    // and it no longer withholds the pull's freshness stamp. Before this split,
    // one unresolvable duplicate pair anywhere in history suppressed every
    // owner's chase cards for good (Codex PR #443 gate round 33, finding 2).
    if (input.bankPull.status === "ok" && (input.bankPull.staleAmbiguous?.count ?? 0) > 0) {
        reasons.push(staleAmbiguousReason(input.bankPull.staleAmbiguous!.count, input.bankPull.staleAmbiguous!.keys));
    }

    // THE PULL WITHHOLDING ITS OWN STAMP, said out loud. Same job as
    // `chaser-blocked:<reason>` below: the withholding is correct, and on its
    // own completely silent — the only other symptom is `bank-pull-stale` 36
    // hours later, which reads as "the pull is dead" when the pull ran fine and
    // one report inside it did not answer (round-33 gate, finding 1).
    if (input.bankPull.status === "ok" && input.bankPull.blockedReason) {
        reasons.push(`bank-pull-blocked:${input.bankPull.blockedReason}`);
    }

    // DAYS NOBODY EVER GOT A CLEARANCE ANSWER FOR (round-35 gate, finding 1).
    //
    // `bank-pull-blocked` is about the run that just ended and clears the moment
    // one succeeds. This is about the HOLE, which outlives both the run and the
    // retry schedule: the retry marker is dropped after PROBE_RETRY_LIMIT
    // attempts by design, and the span it was chasing stays uncertified until
    // some run actually re-reads it. It also withholds the freshness stamp, so
    // without naming it the only symptom would be `bank-pull-stale` 36 hours
    // later — which reads as a dead pull when the pull is running fine every
    // night and refusing, correctly, to certify a week it never read.
    if (input.bankPull.status === "ok" && input.bankPull.uncertifiedWindow) {
        reasons.push(`bank-pull-uncertified:${input.bankPull.uncertifiedWindow}`);
    }

    // THE CHASER REFUSING TO FINISH ON PURPOSE.
    //
    // Distinct from `chaser-stale`, and it has to be: the sweep stops stamping
    // its completion when the nightly register pull is not fresh (see
    // BANK_PULL_CHASER_WINDOW_HOURS), which is correct — cards built on a stale
    // register ask for the wrong receipts — but on its own it is SILENT. The
    // chaser looks like it is merely slow, `bank-pull-stale` does not fire for
    // another eleven hours (36h vs 24h), and the 14:30 UTC cards simply never
    // go out. This says which of the two it is, immediately.
    if (input.chaser.status === "ok" && input.chaser.blockedReason) {
        reasons.push(`chaser-blocked:${input.chaser.blockedReason}`);
    }

    // A CHASER THAT HAS NOT FINISHED is the input every other receipt surface
    // depends on. Reported in HOURS so the digest says how long, rather than
    // just that something is wrong.
    if (input.chaser.status === "ok") {
        const at = input.chaser.completedAt ? Date.parse(input.chaser.completedAt) : null;
        const stale = at === null || Number.isNaN(at) || input.now - at > CHASER_STALE_HOURS * HOUR_MS;
        if (stale) {
            const hours = at === null || Number.isNaN(at)
                ? "never"
                : `${Math.floor((input.now - at) / HOUR_MS)}h`;
            reasons.push(`chaser-stale:${hours}`);
        }
    }

    // NO DRIVE CREDENTIAL = the signed-memo path is dead, silently. Only
    // reported when the probe actually ANSWERED: a failed probe is already
    // `probe-failed:driveCredentials`.
    if (input.driveCredentials.status === "ok" && !input.driveCredentials.configured) {
        reasons.push("drive-not-configured");
    }

    // An uncertain card is an ASK THAT MAY NEVER HAVE HAPPENED. It cannot be
    // auto-retried without risking a duplicate, so it needs a human, and until
    // one looks the crew has silently not been asked for those receipts.
    if (input.uncertainCards.status === "ok" && input.uncertainCards.count > 0) {
        reasons.push(`cards-uncertain:${input.uncertainCards.count}`);
    }

    return { ok: reasons.length === 0, reasons };
}

/**
 * The nightly pull runs every 24h, so 36h is one missed run plus room for a
 * late retry — long enough not to page on a single slow night, short enough
 * that a dead pull is caught before the chaser has drifted a whole week.
 */
export const BANK_PULL_STALE_HOURS = 36;

/**
 * How fresh the register pull's last SUCCESS must be for the missing-receipt
 * chaser to call its own cycle complete and release the morning cards.
 *
 * TIGHTER THAN THE ALARM ABOVE, and for a different job. `BANK_PULL_STALE_HOURS`
 * asks "is the pull dead?" and is deliberately slack so one slow night does not
 * page anybody. This asks "did the pull that feeds TODAY'S chase actually run?"
 * and must not be slack at all.
 *
 * From vercel.json: `/api/cron/bank-register-pull` runs at 02:00 UTC daily and
 * `/api/cron/receipt-requests` at 13:00 UTC, with `?continue=1` resumes every
 * 15 minutes and the cards going out at 14:30 UTC on weekdays. So at chaser
 * time a healthy pull is ~11h old, and last night's pull — the one that means
 * tonight's failed — is ~35h old. 24h separates those two cleanly while still
 * tolerating a pull that ran late.
 */
export const BANK_PULL_CHASER_WINDOW_HOURS = 24;

/**
 * The chaser runs a full sweep daily (plus 15-minute resume passes), so 26h is
 * one missed night with room for a slow morning — short enough that the alarm
 * lands BEFORE the next day's cards are due, which is the whole point of
 * watching it.
 */
export const CHASER_STALE_HOURS = 26;

/** Where the pull records its last SUCCESS (AutomationSetting is a KV table). */
export const BANK_PULL_LAST_SUCCESS_KEY = "bankRegisterPullLastSuccess";

/**
 * Where the pull records how many reconcile groups came back AMBIGUOUS on its
 * most recent completed reconcile (Codex round-31 gate, finding 2). A
 * same-identity 2×2 (or larger) statement-first group is a human call, never
 * auto-resolved — this is what makes that backlog visible instead of the pull
 * silently reporting "done" over it. Overwritten every run reconcile actually
 * completes (0 clears a resolved alarm); left untouched when reconcile itself
 * never ran, so a missing read can never read as "zero ambiguous".
 */
export const BANK_PULL_AMBIGUOUS_KEY = "bankRegisterPullAmbiguousCount";

/**
 * Where the pull records how many QBO_REGISTER observations QuickBooks has NOT
 * cleared, inside the mint lookback window and not yet linked to a canonical
 * line.
 *
 * NOT A FAILURE, and deliberately not a `reason`. These are real postings that
 * are honestly still in flight: an uncleared card charge, a check nobody has
 * cashed, a manually entered journal QuickBooks classifies as neither. They
 * stay observations — on the Bank page, out of the canonical ledger, never
 * chased — until QuickBooks says the money moved. It is reported so the number
 * is VISIBLE rather than inferred from the absence of chases.
 */
export const BANK_PULL_UNCLEARED_KEY = "bankRegisterPullUnclearedCount";

/**
 * Ambiguous reconcile groups from BEFORE the window the pull last read, as
 * `{"count":n,"keys":[...]}` (Codex PR #443 gate round 33, finding 2).
 *
 * DELIBERATELY NOT A STAMP BLOCKER. Two legitimate identical purchases that
 * reconcile cannot pair are a real backlog, but they are last month's backlog:
 * blocking the freshness stamp on them meant one such pair anywhere in history
 * suppressed every owner's chase cards, permanently. So the count is reported
 * here and the stamp is decided by ambiguity inside the current window alone.
 * The keys ride along because "three of these" without "which three" sends
 * somebody hunting through the table.
 */
export const BANK_PULL_AMBIGUOUS_STALE_KEY = "bankRegisterPullAmbiguousStale";

/**
 * Why the pull withheld its own freshness stamp on its most recent run, when it
 * did and the cause was not an outright failure. Empty means nothing is holding
 * it back.
 *
 * The one case today is `cleared-probe-failed`: QuickBooks answered the register
 * but not the clearance question, so every row is "Unknown", nothing
 * clearance-gated could run, and the run is not proof the register is current
 * (round-33 gate, finding 1). Without this the only symptom is `bank-pull-stale`
 * 36 hours later, which says the pull is dead when in fact it ran fine and one
 * report inside it did not.
 */
export const BANK_PULL_BLOCKED_REASON_KEY = "bankRegisterPullBlockedReason";

/**
 * The span of dates whose bank clearance was never answered, as `<from>..<to>`,
 * or empty when there is none (Codex PR #443 gate round 35, finding 1).
 *
 * DIFFERENT FROM `bank-pull-blocked:cleared-probe-failed`, which is about the
 * run that just ended. This one is about the DAYS: a probe failure whose
 * retries are exhausted stops being a per-run event, the retry marker is
 * dropped on purpose, and without this nothing would say the hole was still
 * there. It is also the thing that withholds the freshness stamp, so left
 * unreported it would look exactly like a pull that had quietly died.
 */
export const BANK_PULL_UNCERTIFIED_KEY = "bankRegisterPullUncertifiedWindow";

/** The stored form of an uncertified span: `<from>..<to>`, or "" for none. */
export function uncertifiedWindowValue(
    bounds: { startDate: string; endDate: string } | null | undefined,
): string {
    return bounds ? `${bounds.startDate}..${bounds.endDate}` : "";
}

/**
 * Is the nightly pull on, and when did it last SUCCEED?
 *
 * A read failure reports `enabled: false` rather than "enabled and stale":
 * inventing a failure out of a probe error would fire the alarm for the wrong
 * reason, and the probe-failure reasons above already cover "we could not read
 * it". The flag itself is env, so it cannot fail.
 */
/**
 * The pull's last-success stamp. THROWS on a read failure rather than returning
 * a cheerful default — it runs inside `runProbe` now, which is the thing that
 * knows how to say "we could not read this" (`probe-failed:bankPull`) and how
 * to give up on a hung database instead of holding the whole health check open.
 */
/** How many stale-ambiguity group keys a single health reason will name before it truncates. */
export const STALE_AMBIGUOUS_KEYS_IN_REASON = 3;

/**
 * The stale-ambiguity reason string: the count, then the group keys.
 *
 * Exported and pure so the truncation rule is testable. A reason nobody can act
 * on is noise, and "there are four duplicate groups somewhere" is exactly that —
 * so the keys are in the string, capped, with the overflow counted rather than
 * silently dropped.
 */
export function staleAmbiguousReason(count: number, keys: readonly string[]): string {
    const shown = keys.slice(0, STALE_AMBIGUOUS_KEYS_IN_REASON);
    const overflow = keys.length - shown.length;
    const suffix = shown.length > 0 ? `:${shown.join(",")}${overflow > 0 ? `,+${overflow}` : ""}` : "";
    return `bank-ambiguous-stale:${count}${suffix}`;
}

function parseStaleAmbiguous(raw: string | null | undefined): { count: number; keys: string[] } {
    if (!raw) return { count: 0, keys: [] };
    try {
        const parsed = JSON.parse(raw) as { count?: unknown; keys?: unknown };
        const count = typeof parsed.count === "number" && Number.isFinite(parsed.count) ? parsed.count : 0;
        const keys = Array.isArray(parsed.keys) ? parsed.keys.filter((k): k is string => typeof k === "string") : [];
        return { count, keys };
    } catch {
        // An unreadable value is NOT reported as zero — that is the
        // null-means-OK trap this file exists to avoid. The count comes from the
        // keys we could not read, so say one thing is wrong rather than nothing.
        return { count: 1, keys: ["unparseable"] };
    }
}

async function readBankPullState(): Promise<{
    enabled: boolean;
    lastSuccessAt: string | null;
    ambiguousCount: number;
    unclearedCount: number;
    staleAmbiguous: { count: number; keys: string[] };
    blockedReason: string | null;
    uncertifiedWindow: string | null;
}> {
    // ENABLED BECAUSE THE CRON EXISTS. The previous gate keyed off
    // BANK_LINE_MINT_FROM_QBO — an undocumented env var that controls MINTING,
    // not the pull — so with minting off (its shipped default) the pull could
    // be dead for weeks and health stayed green. The pull is scheduled in
    // vercel.json unconditionally, so it is expected to run unconditionally.
    const [successRow, ambiguousRow, unclearedRow, staleAmbiguousRow, blockedRow, uncertifiedRow] = await Promise.all([
        prisma.automationSetting.findUnique({ where: { key: BANK_PULL_LAST_SUCCESS_KEY } }),
        prisma.automationSetting.findUnique({ where: { key: BANK_PULL_AMBIGUOUS_KEY } }),
        prisma.automationSetting.findUnique({ where: { key: BANK_PULL_UNCLEARED_KEY } }),
        prisma.automationSetting.findUnique({ where: { key: BANK_PULL_AMBIGUOUS_STALE_KEY } }),
        prisma.automationSetting.findUnique({ where: { key: BANK_PULL_BLOCKED_REASON_KEY } }),
        prisma.automationSetting.findUnique({ where: { key: BANK_PULL_UNCERTIFIED_KEY } }),
    ]);
    const parsedAmbiguous = ambiguousRow?.value ? Number.parseInt(ambiguousRow.value, 10) : 0;
    const parsedUncleared = unclearedRow?.value ? Number.parseInt(unclearedRow.value, 10) : 0;
    return {
        enabled: true,
        lastSuccessAt: successRow?.value || null,
        ambiguousCount: Number.isFinite(parsedAmbiguous) ? parsedAmbiguous : 0,
        unclearedCount: Number.isFinite(parsedUncleared) ? parsedUncleared : 0,
        staleAmbiguous: parseStaleAmbiguous(staleAmbiguousRow?.value),
        blockedReason: blockedRow?.value || null,
        uncertifiedWindow: uncertifiedRow?.value || null,
    };
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
        intakeStuck, intakeNeedsReview, intakeUnassigned, uncertainCards, bankPull, chaser, driveCredentials,
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
                                // NOT uploadLeaseActive, expressed as a query
                                // rather than called as a predicate (this is
                                // an aggregate count, not a row scan): a live
                                // lease means either an explicit expiry that
                                // has not passed yet, or — for the inline,
                                // no-signed-URL path — a row young enough to
                                // still be inside the sweeper's own grace
                                // window. A STAGING row satisfying either is
                                // still on the clock, not stuck.
                                OR: [
                                    { uploadUrlExpiresAt: { lte: new Date(now) } },
                                    {
                                        uploadUrlExpiresAt: null,
                                        createdAt: { lt: new Date(now - STAGING_SWEEP_MINUTES * 60_000) },
                                    },
                                ],
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
        // Chat cards we asked for and never got a confirmed answer about. They
        // are never auto-retried, so this count only falls when a human acts.
        probe<number>(
            "uncertainCards",
            () => prisma.receiptRequestCard.count({ where: { status: "UNCERTAIN" } }),
            0,
        ),
        // IN the Promise.all, and probed: it used to be an unprobed `await`
        // after it, so a hung database held the whole health check open past
        // every other probe's deadline and then answered "switched off".
        probe<{
            enabled: boolean;
            lastSuccessAt: string | null;
            ambiguousCount: number;
            unclearedCount: number;
            staleAmbiguous: { count: number; keys: string[] };
            blockedReason: string | null;
            uncertifiedWindow: string | null;
        }>(
            "bankPull",
            readBankPullState,
            { enabled: false, lastSuccessAt: null, ambiguousCount: 0, unclearedCount: 0, staleAmbiguous: { count: 0, keys: [] }, blockedReason: null, uncertifiedWindow: null },
        ),
        // Can we authenticate to Drive? Asked here rather than at the moment a
        // memo arrives, because the answer "no" produces no symptom anywhere
        // else: memos are signed, the bridge is refused, and the queue simply
        // never empties.
        // The chaser's own marker. Everything on the Receipts tab and every
        // morning card is downstream of it, and a stalled one is otherwise
        // silent: the cards cron answers 200 with `skipped:"chaser-incomplete"`.
        probe<{ phase: string; completedAt: string | null; blockedReason: string | null }>(
            "chaser",
            async () => {
                const { SWEEP_MARKER_KEY, parseSweepMarker } = await import("./receipt-sweep-marker");
                const row = await prisma.automationSetting.findUnique({ where: { key: SWEEP_MARKER_KEY } });
                const marker = parseSweepMarker(row?.value);
                return { phase: marker.phase, completedAt: marker.chaserCompletedAt, blockedReason: marker.blockedReason ?? null };
            },
            { phase: "unknown", completedAt: null, blockedReason: null },
        ),
        probe<{ ok: boolean; source: string }>(
            "driveCredentials",
            async () => {
                const { ensureDriveAuth } = await import("./gmail-client");
                const verdict = await ensureDriveAuth();
                return { ok: verdict.ok, source: verdict.source };
            },
            { ok: false, source: "none" },
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
        uncertainCards: {
            status: uncertainCards.status,
            reason: uncertainCards.reason,
            count: uncertainCards.value,
        },
        chaser: {
            status: chaser.status,
            reason: chaser.reason,
            phase: chaser.value.phase,
            completedAt: chaser.value.completedAt,
            blockedReason: chaser.value.blockedReason,
        },
        driveCredentials: {
            status: driveCredentials.status,
            reason: driveCredentials.reason,
            configured: driveCredentials.value.ok,
            source: driveCredentials.value.source,
        },
        bankPull: {
            status: bankPull.status,
            reason: bankPull.reason,
            enabled: bankPull.value.enabled,
            lastSuccessAt: bankPull.value.lastSuccessAt,
            ambiguousCount: bankPull.value.ambiguousCount,
            unclearedCount: bankPull.value.unclearedCount,
            staleAmbiguous: bankPull.value.staleAmbiguous,
            blockedReason: bankPull.value.blockedReason,
            uncertifiedWindow: bankPull.value.uncertifiedWindow,
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
        // The register section. `unclearedCount` is the honest residue of the
        // clearance gate — postings QuickBooks has not cleared, which stay
        // observations rather than becoming canonical lines — and it belongs
        // where somebody can see it, not only in a cron log.
        bankPull: snapshot.bankPull,
        chaser: snapshot.chaser,
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
