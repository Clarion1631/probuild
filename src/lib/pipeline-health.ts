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
        /** Newest SUCCESSFUL payments-sync run — the money rail's own pulse. */
        lastPaymentsSync: TimestampProbe;
    };
    /** receipt-push events in the last 24h, by status ("created", "fallback", ...). */
    receipts24h: CountsProbe;
    /** Newest posted date in the bank ledger — how current the statement feed is. */
    bank: TimestampProbe;
    /** Automation events (ANY kind) that errored in the last 24h. */
    stuck: CountProbe;
}

/**
 * Intuit's own status page.
 *
 * Deliberately the ONE probe whose failure does not by itself fail the check:
 * it is a third party with its own downtime, so an unreachable status page is
 * not evidence of an outage in our pipeline, and treating it as one would cry
 * wolf every time statuspage.io hiccups. The failure is still reported
 * (`status: "error"`, indicator "unknown") and still printed in the digest —
 * it just doesn't flip the verdict on its own. Our real signal for an Intuit
 * outage is the QBTimeoutError count, which lands in `stuck`.
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
 * "Last receipt booked" counts CREATES only.
 *
 * "already-exists" is an idempotent re-push of a receipt that was created
 * earlier — often much earlier — so counting it here refreshed the freshness
 * clock without any new receipt entering the books, and a bot stuck retrying
 * one old file would have kept the pipeline looking alive indefinitely.
 * "fallback"/"error" are attempts, not bookings.
 */
export const BOOKED_PUSH_STATUSES = ["created"];

/** The payments cron's per-run audit row (see quickbooks-payments.ts). */
export const PAYMENTS_SYNC_EVENT_KIND = "qbo-payments-sync";

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
    ];
    for (const [name, probe] of namedProbes) {
        if (probe.status === "error") reasons.push(`probe-failed:${name}`);
    }

    if (input.intuit.status === "ok" && input.intuit.indicator !== "none") {
        reasons.push(`intuit-${input.intuit.indicator}`);
    }

    if (input.stuck.status === "ok" && input.stuck.count > 0) {
        reasons.push(`errors-24h:${input.stuck.count}`);
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

    const [intuit, lastPurchase, lastPush, lastPaymentsSync, receiptRows, lastBankLine, stuck] = await Promise.all([
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
                        where: { kind: "receipt-push", status: { in: BOOKED_PUSH_STATUSES } },
                        orderBy: { createdAt: "desc" },
                        select: { createdAt: true },
                    })
                )?.createdAt ?? null,
            null,
        ),
        probe<Date | null>(
            "lastPaymentsSync",
            async () =>
                (
                    await prisma.automationEvent.findFirst({
                        where: { kind: PAYMENTS_SYNC_EVENT_KIND, status: "ok" },
                        orderBy: { createdAt: "desc" },
                        select: { createdAt: true },
                    })
                )?.createdAt ?? null,
            null,
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
            () => prisma.automationEvent.count({ where: { status: "error", createdAt: { gte: since24h } } }),
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
            at: lastPaymentsSync.value?.toISOString() ?? null,
        },
        receipts24h: { status: receiptRows.status, reason: receiptRows.reason, counts },
        bank: {
            status: lastBankLine.status,
            reason: lastBankLine.reason,
            at: lastBankLine.value?.toISOString() ?? null,
        },
        stuck: { status: stuck.status, reason: stuck.reason, count: stuck.value },
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
        `Last payments sync: ${ago(health.qbo.lastPaymentsSync, now)}`,
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
    if (health.reasons.length > 0) lines.push(`Needs attention: ${health.reasons.join(", ")}`);

    return { subject, text: lines.join("\n") };
}
