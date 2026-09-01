import { prisma } from "@/lib/prisma";

/**
 * One summary of the receipt/QBO pipeline's health, shared by the on-demand
 * health endpoint (GET /api/health/pipeline) and the morning digest cron
 * (GET /api/cron/pipeline-digest) so the two can never disagree about whether
 * the pipeline is OK.
 *
 * Everything here is a READ. It must never throw: a health check that 500s
 * during an outage tells you nothing you didn't already fear, so each probe
 * degrades to a null/unknown of its own and the surrounding verdict still
 * renders.
 */

const INTUIT_STATUS_URL = "https://status.developer.intuit.com/api/v2/status.json";
const INTUIT_TIMEOUT_MS = 5_000;
const DAY_MS = 86_400_000;

/** Statuspage indicators: "none" | "minor" | "major" | "critical"; "unknown" is ours. */
export interface IntuitStatus {
    indicator: string;
    description?: string;
}

export interface PipelineHealth {
    ok: boolean;
    /** Set only when `ok` is true DESPITE there being no recent receipt traffic. */
    note?: string;
    checkedAt: string;
    intuit: IntuitStatus;
    qbo: {
        /** Newest Expense row QBO has synced into ProBuild job costs. */
        lastPurchaseSyncAt: string | null;
        /** Newest receipt the bot actually booked (created or already-exists). */
        lastReceiptPushAt: string | null;
    };
    /** receipt-push events in the last 24h, by status ("created", "fallback", ...). */
    receipts24h: Record<string, number>;
    bank: {
        /** Newest posted date in the bank ledger — how current the statement feed is. */
        lastPostedDate: string | null;
    };
    /** Automation events (ANY kind) that errored in the last 24h. */
    stuck: number;
}

/**
 * Intuit's own status page. Deliberately soft: an unreachable status page is
 * NOT evidence of an outage (it is a third party with its own downtime), so a
 * failure reads "unknown" and does not by itself flip the verdict.
 */
export async function fetchIntuitStatus(): Promise<IntuitStatus> {
    try {
        const res = await fetch(INTUIT_STATUS_URL, {
            signal: AbortSignal.timeout(INTUIT_TIMEOUT_MS),
            headers: { Accept: "application/json" },
        });
        if (!res.ok) return { indicator: "unknown" };
        const data = (await res.json()) as { status?: { indicator?: unknown; description?: unknown } };
        const indicator = typeof data?.status?.indicator === "string" ? data.status.indicator : null;
        if (!indicator) return { indicator: "unknown" };
        return {
            indicator,
            description: typeof data.status?.description === "string" ? data.status.description : undefined,
        };
    } catch {
        return { indicator: "unknown" };
    }
}

/** A push that BOOKED something. "fallback"/"error" are attempts, not bookings. */
const BOOKED_PUSH_STATUSES = ["created", "already-exists"];

/**
 * The verdict, split out from the database reads so the freshness windows are
 * testable without a DB.
 *
 * A quiet week is quiet, not broken — GTR does not book receipts every day.
 * "No pushes in 7d" (including none ever) is therefore OK-with-a-note, while a
 * gap between 48h and 7d means traffic was flowing and then stopped, which is
 * the actual failure this exists to catch.
 *
 * An "unknown" Intuit indicator does NOT fail the check: an unreachable
 * third-party status page is not evidence of an outage, and treating it as one
 * would cry wolf every time statuspage.io hiccups.
 */
export function evaluatePipelineOk(input: {
    intuit: IntuitStatus;
    stuck: number;
    lastReceiptPushAt: Date | null;
    now: number;
}): { ok: boolean; note?: string } {
    const pushAgeMs = input.lastReceiptPushAt ? input.now - input.lastReceiptPushAt.getTime() : null;
    const quiet = pushAgeMs === null || pushAgeMs > 7 * DAY_MS;
    const pushFresh = pushAgeMs !== null && pushAgeMs <= 2 * DAY_MS;
    const intuitOk = input.intuit.indicator === "none" || input.intuit.indicator === "unknown";
    const ok = intuitOk && input.stuck === 0 && (pushFresh || quiet);
    return ok && quiet ? { ok, note: "no receipts in 7d" } : { ok };
}

export async function getPipelineHealth(): Promise<PipelineHealth> {
    const now = Date.now();
    const since24h = new Date(now - DAY_MS);

    const [intuit, lastPurchase, lastPush, receiptRows, lastBankLine, stuck] = await Promise.all([
        fetchIntuitStatus(),
        // Expense carries no updatedAt column — qbSyncedAt IS the "when did the
        // QBO purchase sync land" timestamp this is asking for.
        prisma.expense
            .aggregate({ where: { qbPurchaseId: { not: null } }, _max: { qbSyncedAt: true } })
            .catch(() => null),
        prisma.automationEvent
            .findFirst({
                where: { kind: "receipt-push", status: { in: BOOKED_PUSH_STATUSES } },
                orderBy: { createdAt: "desc" },
                select: { createdAt: true },
            })
            .catch(() => null),
        prisma.automationEvent
            .groupBy({
                by: ["status"],
                where: { kind: "receipt-push", createdAt: { gte: since24h } },
                _count: { _all: true },
            })
            .catch(() => [] as Array<{ status: string; _count: { _all: number } }>),
        prisma.bankLine
            .aggregate({ _max: { postedDate: true } })
            .catch(() => null),
        // ANY kind: a qbo-sync failure is exactly the thing this digest exists
        // to surface, even on a day with no receipt traffic at all.
        prisma.automationEvent
            .count({ where: { status: "error", createdAt: { gte: since24h } } })
            .catch(() => 0),
    ]);

    const receipts24h: Record<string, number> = {};
    for (const row of receiptRows) receipts24h[row.status] = row._count._all;

    const lastReceiptPushAt = lastPush?.createdAt ?? null;
    const verdict = evaluatePipelineOk({
        intuit,
        stuck,
        lastReceiptPushAt,
        now,
    });

    return {
        ...verdict,
        checkedAt: new Date(now).toISOString(),
        intuit,
        qbo: {
            lastPurchaseSyncAt: lastPurchase?._max.qbSyncedAt?.toISOString() ?? null,
            lastReceiptPushAt: lastReceiptPushAt?.toISOString() ?? null,
        },
        receipts24h,
        bank: { lastPostedDate: lastBankLine?._max.postedDate?.toISOString() ?? null },
        stuck,
    };
}

function ago(iso: string | null, now: number): string {
    if (!iso) return "never";
    const hours = (now - new Date(iso).getTime()) / 3_600_000;
    if (hours < 1) return `${iso} (${Math.max(0, Math.round(hours * 60))}m ago)`;
    if (hours < 48) return `${iso} (${Math.round(hours)}h ago)`;
    return `${iso} (${Math.round(hours / 24)}d ago)`;
}

/**
 * Plain-text digest body. No markdown tables and no emoji — it has to read the
 * same in an email client, in Google Chat, and in a log line.
 */
export function formatPipelineDigest(health: PipelineHealth): { subject: string; text: string } {
    const now = new Date(health.checkedAt).getTime();
    const subject = health.ok ? "Pipeline OK" : "Pipeline NEEDS ATTENTION";

    const receiptCounts = Object.entries(health.receipts24h).sort(([a], [b]) => a.localeCompare(b));
    const lines = [
        subject,
        `Checked: ${health.checkedAt}`,
        `Intuit status: ${health.intuit.indicator}${health.intuit.description ? ` (${health.intuit.description})` : ""}`,
        `Last QBO purchase sync: ${ago(health.qbo.lastPurchaseSyncAt, now)}`,
        `Last receipt booked: ${ago(health.qbo.lastReceiptPushAt, now)}`,
        `Receipts (24h): ${receiptCounts.length ? receiptCounts.map(([s, n]) => `${s} ${n}`).join(", ") : "none"}`,
        `Bank ledger through: ${health.bank.lastPostedDate ? health.bank.lastPostedDate.slice(0, 10) : "no lines"}`,
        `Automation errors (24h, all kinds): ${health.stuck}`,
    ];
    if (health.note) lines.push(`Note: ${health.note}`);

    return { subject, text: lines.join("\n") };
}
