import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { acquireCronLease } from "@/lib/cron-lease";
import { ensureLeadInboxAuth, gmailClientFor } from "./gmail-inbox-client";
import { authenticateMessage, trustedSenderPatterns, type RawHeader } from "./authentication";
import { parseFallbackEmail } from "./fallback-email";
import { recordPendingFallback, intakeVoiceEvent } from "./intake";
import { sendPlainNtfy } from "./alerts";
import { GMAIL_REQUEST_TIMEOUT_MS } from "./constants";
import { safeErrorCategory } from "./error-category";

/**
 * Read-only lead-inbox scan (v1a: gmail.readonly only, no send scope). The
 * cron calls it every minute outside OFF mode.
 *
 * Each poll is ONE windowed query, not a cursor:
 *
 *   messages.list  q = "{from:<trusted sender> ...} after:<epoch>"
 *                  includeSpamTrash = true, every page
 *   epoch = max(leadInboxCutoffAt, leadInboxScanWatermarkAt - SCAN_OVERLAP_MS)
 *
 * Every listed message the ledger (`LeadInboxMessage`) does not already hold
 * goes through the unchanged authentication and intake paths and then gets a
 * ledger row. The watermark moves to THIS scan's start time only when every
 * page was listed and every listed message got its ledger row. Any error, or
 * running out of budget, leaves the watermark where it was, so the next poll
 * reads the same window again. Reading it again is harmless: the ledger is
 * checked before any Gmail `get`, and intake is idempotent on its own unique
 * keys, so a message is never processed twice.
 *
 * Loss-freedom (docs/plans/SPEED-TO-LEAD-V1A.md, "Inbox scan"): a lead-sender
 * message M can only fail to become an intake row in one of three visible
 * ways. (1) M is listed and turned away by authentication or deleted before it
 * can be read: it gets a REJECTED/GONE ledger row and is pushed to Justin
 * (`reportUnacceptedMessages`). (2) M is listed but not finished (an error or
 * budget stop): that scan is incomplete, the watermark stays at or before
 * M's arrival, and every later scan lists M again until it is finished. (3) M
 * was not visible to the scan that moved the watermark past it: that scan
 * started at S, so the next scan reads from S - SCAN_OVERLAP_MS and still
 * lists M unless Gmail's search showed M more than SCAN_OVERLAP_MS late. If
 * scans keep failing, the watermark stays put and `alertIfScanStale` pushes
 * once it is STALE_SCAN_ALERT_MS old; the next complete scan then catches up
 * on everything since, with no reset and no unscanned gap.
 */

const POLL_LEASE_MS = 55_000;
const POLL_LEASE_KEY = "speedToLeadPollLease";
const SETTINGS_ID = "singleton";

/**
 * How far before the last complete scan's start each scan reads again. This
 * is the only guard against Gmail search showing a message after its
 * `internalDate` (index lag, Group relay holds, clock skew), and it costs one
 * indexed ledger lookup per re-listed id: at 0 to 20 lead-sender messages a
 * day, one list page. So it is set generously rather than tightly — Google
 * documents no hard bound on indexing delay (round-6 finding 3), so 72h
 * rather than the original 24h, to leave real headroom above any delay this
 * mailbox's tiny volume has ever needed to survive.
 */
export const SCAN_OVERLAP_MS = 72 * 60 * 60 * 1000;
/** A watermark this old means polls have kept failing: push a health alert (never capped). */
export const STALE_SCAN_ALERT_MS = 6 * 60 * 60 * 1000;
/**
 * KNOWN RISK, not fixed here (round-6 finding 3's clock-skew case, already
 * documented as such): a wall-clock anomaly that briefly makes `now` read
 * hours ahead would commit a future watermark the instant one scan
 * completes, silently excluding mail once the clock corrects. A correct fix
 * needs a time source independent of the app clock (e.g. the DB server's own
 * `now()`) to tell that apart from a legitimate long outage, where the
 * watermark must jump forward by exactly as much, in one poll, on purpose
 * (see the "72-hour-gap" test below) — bounding the advance instead would
 * silently break that catch-up. Left as a documented risk pending that
 * design decision rather than guessed at here.
 */
/** Gmail's own maximum per list page. */
const LIST_PAGE_SIZE = 500;
/** A runaway-loop guard, not a working limit: 20 pages x 500 is ~10,000 lead-sender messages in one window. Hitting it leaves the scan incomplete, so it can delay (with the stale alert) but never drop. */
const MAX_LIST_PAGES = 20;
const MAX_MESSAGE_GETS = 50;
const WALL_TIME_BUDGET_MS = 40_000;
const BACKOFF_MINUTES = [1, 2, 4, 8, 15] as const;

const POLL_ALERT_SENT_KEY = "speedToLeadPollAlertSentAt";
const POLL_DISCONNECTED_ALERT_KEY = "speedToLeadInboxDisconnectedAlertSent";
const SCAN_STALE_ALERT_KEY = "speedToLeadScanStaleAlertSentAt";
const UNACCEPTED_NOTICE_SENT_KEY = "speedToLeadUnacceptedNoticeSentAt";
/** Unaccepted-message notices are batched to at most one push per this interval (see reportUnacceptedMessages). Health alerts never wait on it. */
export const UNACCEPTED_NOTICE_MIN_INTERVAL_MS = 15 * 60 * 1000;

export interface PollResult {
    ran: boolean;
    reason?: string;
    /** Messages this run finished with (got a ledger row). */
    processed?: number;
    /** True when this run's scan finished every page and every message, so the watermark moved. */
    complete?: boolean;
}

function headerList(payload: { headers?: { name?: string | null; value?: string | null }[] | null } | undefined): RawHeader[] {
    return (payload?.headers ?? []).map(h => ({ name: h.name ?? "", value: h.value ?? "" }));
}

function extractPlainText(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const part = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
    if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
    }
    for (const child of part.parts ?? []) {
        const found = extractPlainText(child);
        if (found) return found;
    }
    if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ");
    }
    return "";
}

function isGoogleApiError(error: unknown, status: number): boolean {
    const code = (error as { code?: number })?.code ?? (error as { response?: { status?: number } })?.response?.status;
    return code === status;
}

function isInvalidGrant(error: unknown): boolean {
    const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
    return data?.error === "invalid_grant" || (error instanceof Error && error.message.includes("invalid_grant"));
}

function submissionIdFromHeaders(headers: RawHeader[]): string | null {
    return headers.find(h => h.name.toLowerCase() === "x-gtr-submission-id")?.value?.trim() || null;
}

/** Gmail search clause for exactly the trusted senders, taken from authentication.ts's own list so a config change moves both together. `{a b}` is Gmail's OR group. */
export function trustedSenderQuery(): string {
    const froms = trustedSenderPatterns().map(p => `from:${p.fromAddress}`);
    return froms.length === 1 ? froms[0] : `{${froms.join(" ")}}`;
}

/** One poll run's budget for message `get` calls and wall time (real clock, independent of the logical `now`). */
class RunBudget {
    private gets = 0;
    private readonly deadline = Date.now() + WALL_TIME_BUDGET_MS;
    get timeLeft(): boolean {
        return Date.now() < this.deadline;
    }
    /** A message costs at most two gets (metadata, then full), so only start one that can finish. */
    get canStartMessage(): boolean {
        return this.gets + 2 <= MAX_MESSAGE_GETS && this.timeLeft;
    }
    spendGet(): void {
        this.gets += 1;
    }
}

type MessageResult = { outcome: "INTAKE" } | { outcome: "REJECTED"; detail: string } | { outcome: "GONE" };

/**
 * Metadata first: a message authentication turns away costs one `get`; the
 * `full` body is fetched only once the sender is trusted. Throws on any
 * error other than a 404, and the caller then leaves the message unfinished.
 */
async function processMessage(db: PrismaClient, gmail: ReturnType<typeof gmailClientFor>, id: string, budget: RunBudget): Promise<MessageResult> {
    budget.spendGet();
    let metaRes;
    try {
        metaRes = await gmail.users.messages.get(
            { userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Authentication-Results", "ARC-Seal", "ARC-Authentication-Results", "X-Google-Group-Id", "List-ID", "X-GTR-Submission-Id"] },
            { timeout: GMAIL_REQUEST_TIMEOUT_MS },
        );
    } catch (error) {
        if (isGoogleApiError(error, 404)) return { outcome: "GONE" };
        throw error;
    }
    const headers = headerList(metaRes.data.payload);
    const from = /<([^>]+)>/.exec(headers.find(h => h.name.toLowerCase() === "from")?.value ?? "")?.[1]
        ?? headers.find(h => h.name.toLowerCase() === "from")?.value ?? "";
    const fromEmail = from.trim().toLowerCase();

    const auth = authenticateMessage(headers, fromEmail);
    if (!auth.trusted || !auth.rule) return { outcome: "REJECTED", detail: auth.reason ?? "not trusted" };

    budget.spendGet();
    let fullRes;
    try {
        fullRes = await gmail.users.messages.get({ userId: "me", id, format: "full" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
    } catch (error) {
        if (isGoogleApiError(error, 404)) return { outcome: "GONE" };
        throw error;
    }
    const bodyText = extractPlainText(fullRes.data.payload);
    const receivedAt = new Date(fullRes.data.internalDate ? Number(fullRes.data.internalDate) : Date.now());

    if (auth.rule === "website-group-relay") {
        const submissionId = submissionIdFromHeaders(headers);
        const payload = parseFallbackEmail({ headers, bodyText, submissionId });
        await db.$transaction(tx => recordPendingFallback(tx, { gmailMessageId: id, receivedAt, payload }));
    } else {
        await intakeVoiceEvent({ gmailMessageId: id, receivedAt, callerPhoneRaw: bodyText, summary: bodyText.slice(0, 2000) }, db);
    }
    return { outcome: "INTAKE" };
}

interface ScanResult {
    /** Every page listed and every listed message finished: the ONLY condition under which the watermark may move. */
    complete: boolean;
    processed: number;
    erroredCount: number;
    firstError: unknown;
}

/**
 * Lists the whole window page by page and finishes every message the ledger
 * does not already hold. A message that throws is left unfinished (so the
 * scan is incomplete) and the loop moves on, so one bad message never holds
 * back the leads listed after it. An expired grant is rethrown: it is not
 * about one message.
 */
async function scanWindow(db: PrismaClient, gmail: ReturnType<typeof gmailClientFor>, afterMs: number, budget: RunBudget): Promise<ScanResult> {
    // One second earlier than the window start, so a message stamped in that
    // exact second is inside the window whether Gmail's `after:` is strict or not.
    const q = `${trustedSenderQuery()} after:${Math.floor(afterMs / 1000) - 1}`;
    let processed = 0;
    let erroredCount = 0;
    let firstError: unknown = null;
    let pages = 0;
    let pageToken: string | undefined;
    const stopped = (): ScanResult => ({ complete: false, processed, erroredCount, firstError });

    do {
        if (pages >= MAX_LIST_PAGES || !budget.timeLeft) return stopped();
        pages += 1;
        const page = await gmail.users.messages.list(
            { userId: "me", q, includeSpamTrash: true, maxResults: LIST_PAGE_SIZE, pageToken },
            { timeout: GMAIL_REQUEST_TIMEOUT_MS },
        );
        const ids = [...new Set((page.data.messages ?? []).map(m => m.id).filter((id): id is string => !!id))];
        const finished = ids.length === 0
            ? new Set<string>()
            : new Set((await db.leadInboxMessage.findMany({ where: { gmailMessageId: { in: ids } }, select: { gmailMessageId: true } })).map(r => r.gmailMessageId));

        for (const id of ids) {
            if (finished.has(id)) continue;
            if (!budget.canStartMessage) return stopped();
            try {
                const result = await processMessage(db, gmail, id, budget);
                await db.leadInboxMessage.createMany({
                    data: [{ gmailMessageId: id, outcome: result.outcome, detail: result.outcome === "REJECTED" ? result.detail : null }],
                    skipDuplicates: true,
                });
                processed += 1;
            } catch (error) {
                if (isInvalidGrant(error)) throw error;
                if (erroredCount === 0) firstError = error;
                erroredCount += 1;
                console.error("[speed-to-lead] inbox message not finished; the scan window stays open for it", safeErrorCategory(error));
            }
        }
        pageToken = page.data.nextPageToken ?? undefined;
    } while (pageToken);

    return { complete: erroredCount === 0, processed, erroredCount, firstError };
}

/**
 * Health alerts go straight to ntfy with no flood cap. Each kind is sent once
 * per outage (its marker row, cleared on recovery), and the marker is written
 * only after a delivered push, so a failed push is retried on the next poll
 * instead of going quiet. Never throws.
 */
async function sendHealthAlertOnce(db: PrismaClient, key: string, title: string, body: string, now: Date): Promise<void> {
    try {
        if (await db.automationSetting.findUnique({ where: { key } })) return;
        if (!(await sendPlainNtfy(title, body))) return;
        await db.automationSetting.upsert({ where: { key }, create: { key, value: now.toISOString() }, update: { value: now.toISOString() } });
    } catch (error) {
        console.error("[speed-to-lead] health alert failed", safeErrorCategory(error));
    }
}

async function recordPollHealth(db: PrismaClient, startedAt: Date, finishedAt: Date | null, ok: boolean) {
    await db.companySettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID, leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: finishedAt, leadInboxLastPollOk: ok },
        update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: finishedAt, leadInboxLastPollOk: ok },
    });
}

/**
 * A failed run. `backoff: false` is for a run that did scan but left some
 * messages unfinished: it still counts toward the repeated-failure alert, but
 * does not delay the next poll, so new leads keep flowing while one message
 * is stuck.
 */
async function recordFailure(db: PrismaClient, startedAt: Date, now: Date, error: unknown, opts: { backoff: boolean }): Promise<void> {
    if (isInvalidGrant(error)) {
        await db.companySettings.upsert({
            where: { id: SETTINGS_ID },
            create: { id: SETTINGS_ID, leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxRefreshTokenEnc: null },
            update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxRefreshTokenEnc: null },
        });
        await sendHealthAlertOnce(db, POLL_DISCONNECTED_ALERT_KEY, "Speed-to-Lead: lead inbox disconnected", "gtrsupport@ revoked or expired its Gmail connection. Reconnect it in Settings > Speed-to-Lead. The scan picks up everything since its last complete run once reconnected.", now);
        return;
    }

    const current = await db.companySettings.findUnique({ where: { id: SETTINGS_ID }, select: { leadInboxFailureCount: true } });
    const failureCount = (current?.leadInboxFailureCount ?? 0) + 1;
    const minutes = BACKOFF_MINUTES[Math.min(failureCount - 1, BACKOFF_MINUTES.length - 1)];
    const nextPollAt = opts.backoff ? new Date(now.getTime() + minutes * 60 * 1000) : null;
    await db.companySettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID, leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxFailureCount: failureCount, leadInboxNextPollAt: nextPollAt },
        update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxFailureCount: failureCount, leadInboxNextPollAt: nextPollAt },
    });

    if (failureCount >= BACKOFF_MINUTES.length) {
        await sendHealthAlertOnce(db, POLL_ALERT_SENT_KEY, "Speed-to-Lead: inbox poll failing", `The lead-inbox poll has failed ${failureCount} times in a row. Nothing is dropped: the scan window stays open until a run finishes it.`, now);
    }
}

async function recordSuccessAndClearBackoff(db: PrismaClient): Promise<void> {
    await db.companySettings.update({ where: { id: SETTINGS_ID }, data: { leadInboxFailureCount: 0, leadInboxNextPollAt: null } }).catch(() => undefined);
    await db.automationSetting.delete({ where: { key: POLL_ALERT_SENT_KEY } }).catch(() => undefined);
    await db.automationSetting.delete({ where: { key: POLL_DISCONNECTED_ALERT_KEY } }).catch(() => undefined);
}

/** Moves the watermark to a complete scan's start time. Monotonic: a late or reordered run can never rewind it. */
async function advanceWatermark(db: PrismaClient, scanStartedAt: Date): Promise<void> {
    await db.companySettings.updateMany({
        where: { id: SETTINGS_ID, OR: [{ leadInboxScanWatermarkAt: null }, { leadInboxScanWatermarkAt: { lt: scanStartedAt } }] },
        data: { leadInboxScanWatermarkAt: scanStartedAt },
    });
    const staleMarker = await db.automationSetting.deleteMany({ where: { key: SCAN_STALE_ALERT_KEY } });
    if (staleMarker.count > 0) {
        await sendPlainNtfy("Speed-to-Lead: lead inbox scan caught up", "The lead-inbox scan finished a full run again and has caught up on everything since it fell behind.");
    }
}

/** Pushes a health alert once the watermark is STALE_SCAN_ALERT_MS old. Runs on every leased invocation (error, backoff and not-connected runs included). Never throws. */
async function alertIfScanStale(db: PrismaClient, now: Date): Promise<void> {
    try {
        const settings = await db.companySettings.findUnique({ where: { id: SETTINGS_ID }, select: { leadInboxScanWatermarkAt: true } });
        const watermark = settings?.leadInboxScanWatermarkAt;
        if (!watermark) return;
        const ageMs = now.getTime() - watermark.getTime();
        if (ageMs < STALE_SCAN_ALERT_MS) return;
        await sendHealthAlertOnce(
            db,
            SCAN_STALE_ALERT_KEY,
            "Speed-to-Lead: lead inbox scan behind",
            `The lead inbox has not finished a full scan since ${watermark.toISOString()} (${Math.floor(ageMs / 3_600_000)} h ago), so leads since then may not be in ProBuild yet. Nothing is dropped: every poll retries from that point and catches up on its own once polling works. See Settings > Speed-to-Lead.`,
            now,
        );
    } catch (error) {
        console.error("[speed-to-lead] stale-scan check failed", safeErrorCategory(error));
    }
}

/**
 * Every lead-sender message that did NOT become an intake row (REJECTED or
 * GONE) is pushed to Justin, so a real lead the authentication rules turn
 * away is never dropped silently. Batched to at most one push per
 * UNACCEPTED_NOTICE_MIN_INTERVAL_MS, each covering every unreported row: a
 * burst of forged mail cannot become a wall of pushes, and nothing is lost
 * while a push waits, because rows stay unreported until a push covering
 * them is delivered. Health alerts never go through this limit. Never throws.
 */
async function reportUnacceptedMessages(db: PrismaClient, now: Date): Promise<void> {
    try {
        const last = await db.automationSetting.findUnique({ where: { key: UNACCEPTED_NOTICE_SENT_KEY } });
        const lastMs = last ? Date.parse(last.value) : Number.NaN;
        if (Number.isFinite(lastMs) && now.getTime() - lastMs < UNACCEPTED_NOTICE_MIN_INTERVAL_MS) return;

        const pending = await db.leadInboxMessage.findMany({
            where: { outcome: { not: "INTAKE" }, notifiedAt: null },
            orderBy: { createdAt: "asc" },
            take: 500,
            select: { gmailMessageId: true, outcome: true, detail: true },
        });
        if (pending.length === 0) return;

        const lines = pending.slice(0, 5).map(m => `- Gmail id ${m.gmailMessageId}: ${m.outcome === "GONE" ? "deleted before it could be read" : m.detail ?? "not accepted"}`);
        if (pending.length > 5) lines.push(`- and ${pending.length - 5} more`);
        const body = [
            `${pending.length} message(s) from a lead sender (website form or Google Voice) did not become a lead. If one is a real lead, add it by hand. They are still in gtrsupport@ (check Spam and Trash too).`,
            ...lines,
        ].join("\n");
        if (!(await sendPlainNtfy("Speed-to-Lead: message(s) not taken in as leads", body))) return;

        await db.leadInboxMessage.updateMany({ where: { gmailMessageId: { in: pending.map(m => m.gmailMessageId) } }, data: { notifiedAt: now } });
        await db.automationSetting.upsert({
            where: { key: UNACCEPTED_NOTICE_SENT_KEY },
            create: { key: UNACCEPTED_NOTICE_SENT_KEY, value: now.toISOString() },
            update: { value: now.toISOString() },
        });
    } catch (error) {
        console.error("[speed-to-lead] unaccepted-message notice failed", safeErrorCategory(error));
    }
}

async function runPoll(db: PrismaClient, now: Date): Promise<PollResult> {
    const startedAt = now;
    try {
        const settings = await db.companySettings.findUnique({
            where: { id: SETTINGS_ID },
            select: { leadInboxCutoffAt: true, leadInboxScanWatermarkAt: true, leadInboxNextPollAt: true },
        });

        if (settings?.leadInboxNextPollAt && now.getTime() < settings.leadInboxNextPollAt.getTime()) {
            return { ran: false, reason: "backing off after repeated failures" };
        }

        const auth = await ensureLeadInboxAuth(db);
        if (!auth.ok || !auth.client) {
            await recordPollHealth(db, startedAt, null, false);
            // A credential that WAS stored but can't be used (round-6 finding
            // 1) must feed the same failure/alert accounting a scan error
            // does, or it fails silently forever: with no watermark yet,
            // alertIfScanStale has nothing to check, so this is the ONLY path
            // that can ever raise "disconnected" or "poll failing" before the
            // first scan completes. "Never connected yet" (auth.error unset)
            // stays quiet, same as before.
            if (auth.error) {
                await recordFailure(db, startedAt, now, auth.error, { backoff: true });
            }
            return { ran: false, reason: "lead inbox not connected" };
        }
        const gmail = gmailClientFor(auth.client);

        // Normally already set by the OAuth callback at connection time (see
        // src/app/api/gmail/callback/route.ts — round-6 finding 2: waiting
        // for the first successful poll to set this left the gap between
        // connecting and that poll permanently unscanned, with no alert).
        // This is now just a fallback for a credential connected some other
        // way: the floor is this poll's own time, so mail older than THIS
        // poll's first run is still never imported.
        const cutoffAt = settings?.leadInboxCutoffAt ?? now;
        const watermarkAt = settings?.leadInboxScanWatermarkAt ?? cutoffAt;
        if (!settings?.leadInboxCutoffAt || !settings?.leadInboxScanWatermarkAt) {
            await db.companySettings.upsert({
                where: { id: SETTINGS_ID },
                create: { id: SETTINGS_ID, leadInboxCutoffAt: cutoffAt, leadInboxScanWatermarkAt: watermarkAt },
                update: { leadInboxCutoffAt: cutoffAt, leadInboxScanWatermarkAt: watermarkAt },
            });
        }

        const afterMs = Math.max(cutoffAt.getTime(), watermarkAt.getTime() - SCAN_OVERLAP_MS);
        const scan = await scanWindow(db, gmail, afterMs, new RunBudget());

        if (scan.complete) await advanceWatermark(db, startedAt);
        if (scan.erroredCount > 0) {
            await recordFailure(db, startedAt, now, scan.firstError, { backoff: false });
        } else {
            await recordPollHealth(db, startedAt, new Date(), true);
            await recordSuccessAndClearBackoff(db);
        }
        return { ran: true, processed: scan.processed, complete: scan.complete };
    } catch (error) {
        console.error("[speed-to-lead] inbox poll failed", safeErrorCategory(error));
        await recordFailure(db, startedAt, now, error, { backoff: true });
        return { ran: false, reason: "error" };
    }
}

/**
 * Holds a lease so overlapping cron invocations never scan at the same time.
 * The unaccepted-message report and the stale-watermark check run on every
 * leased invocation, whatever the scan itself did.
 */
export async function pollLeadInbox(db: PrismaClient = prisma, now: Date = new Date()): Promise<PollResult> {
    const lease = await acquireCronLease(POLL_LEASE_KEY, POLL_LEASE_MS);
    if (!lease) return { ran: false, reason: "lease held by another run" };
    try {
        return await runPoll(db, now);
    } finally {
        await reportUnacceptedMessages(db, now);
        await alertIfScanStale(db, now);
        await lease.release();
    }
}
